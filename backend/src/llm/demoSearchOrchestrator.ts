import { assertDemoSearchGrounding } from "../guards/demoEvidence.guard.js";
import { composeRealDemoSearchResponse } from "../services/demoRealComposer.service.js";
import { searchService } from "../services/search.service.js";
import {
  DEMO_PERSONA_BOUNDARY_NOTICE,
  type DemoDataMode,
  type DemoDebugLlmStageResult,
  type DemoPerson,
  type DemoPersona,
  type DemoSearchResponse,
  type DemoSourceRef
} from "../types/demo.types.js";
import type { SearchItem } from "../types/api.types.js";
import { HttpError } from "../utils/httpError.js";
import { llmRouter, type LlmTaskType } from "./llmRouter.js";
import { DEMO_RESPONSE_COMPOSE_SYSTEM_PROMPT } from "./prompts/demoResponseComposePrompt.js";
import { EVIDENCE_EXTRACT_SYSTEM_PROMPT } from "./prompts/evidenceExtractPrompt.js";
import { GROUNDING_GUARD_SYSTEM_PROMPT } from "./prompts/groundingGuardPrompt.js";
import { INTENT_EXPAND_SYSTEM_PROMPT } from "./prompts/intentExpandPrompt.js";
import {
  type DemoResponseComposeOutput,
  type EvidenceExtractOutput,
  type GroundingGuardOutput,
  type IntentExpandOutput,
  parseDemoResponseComposeOutput,
  parseEvidenceExtractOutput,
  parseGroundingGuardOutput,
  parseIntentExpandOutput
} from "./schemas/taskSchemas.js";

interface ComposeMultiLlmDemoSearchInput {
  query: string;
  count: number;
  dataMode: DemoDataMode;
  startedAt: number;
}

interface CleanedCandidate {
  candidateId: string;
  personId: string;
  articleId: string;
  sourceRefId: string;
  title: string;
  text: string;
  evidenceText: string;
  author: string;
  sourceUrl: string;
  sampleType: string;
}

interface StageRunResult<T> {
  output: T;
  stageResult: DemoDebugLlmStageResult;
}

interface ComposeApplyStats {
  pathCount: number;
  peopleCount: number;
  personaCount: number;
}

const MAX_SEARCH_QUERIES = 4;
const MAX_REAL_ITEMS = 12;
const MIN_CONTENT_LENGTH = 8;

export async function composeMultiLlmDemoSearchResponse(
  input: ComposeMultiLlmDemoSearchInput
): Promise<DemoSearchResponse> {
  const stageResults: DemoDebugLlmStageResult[] = [];
  const guardWarnings: string[] = [];

  const intentStage = await runIntentExpandStage(input.query);
  stageResults.push(intentStage.stageResult);

  const searchItems = await searchByExpandedQueries(intentStage.output.searchQueries, input.count);
  const cleanedSearchItems = cleanSearchItems(searchItems).slice(0, MAX_REAL_ITEMS);
  if (cleanedSearchItems.length === 0) {
    throw new HttpError(
      502,
      "REAL_SEARCH_EMPTY_AFTER_CLEANING",
      "real search returned no usable items after rule cleaning"
    );
  }

  const response = composeRealDemoSearchResponse({
    query: input.query,
    count: input.count,
    dataMode: input.dataMode,
    items: cleanedSearchItems,
    startedAt: input.startedAt
  });

  const candidates = buildCleanedCandidatesFromResponse(response);
  const evidenceStage = await runEvidenceExtractStage(input.query, intentStage.output, candidates);
  stageResults.push(evidenceStage.stageResult);

  const composeStage = await runDemoResponseComposeStage(
    input.query,
    intentStage.output,
    evidenceStage.output,
    response,
    candidates
  );
  stageResults.push(composeStage.stageResult);

  const applyStats = applyDemoResponseComposeOutput(response, composeStage.output, guardWarnings);
  syncTopLevelPersonas(response);

  const groundingStage = await runGroundingGuardStage(response);
  stageResults.push(groundingStage.stageResult);
  applyGroundingGuardOutput(response, groundingStage.output, guardWarnings);
  applyRuleGroundingGuard(response, guardWarnings);
  syncTopLevelPersonas(response);
  assertDemoSearchGrounding(response);

  const successfulStages = stageResults.reduce((total, item) => total + item.succeeded, 0);
  const failedStages = stageResults.reduce((total, item) => total + item.failed, 0);
  const attemptedStages = stageResults.reduce((total, item) => total + item.attempted, 0);

  response.meta.latencyMs = Date.now() - input.startedAt;
  response.meta.fallbackUsed = attemptedStages > 0 && successfulStages === 0;
  response.debug = {
    ...response.debug,
    composer: successfulStages > 0 ? "real_llm_composer" : "real_rule_composer",
    requestedDataMode: input.dataMode,
    resolvedDataMode: input.dataMode,
    itemCount: response.people.length,
    sourceItemCount: cleanedSearchItems.length,
    pathCount: response.paths.length,
    peopleCount: response.people.length,
    personaCount: response.personas.length,
    llmUsed: successfulStages > 0,
    llmComposerUsed: composeStage.stageResult.succeeded > 0,
    llmRepairUsed: false,
    llmRepairFailed: false,
    llmStageResults: stageResults,
    enhancedPeopleCount: applyStats.peopleCount + applyStats.personaCount,
    enhancedPathCount: applyStats.pathCount,
    partialFallbackUsed: failedStages > 0 && successfulStages > 0,
    fallbackUsed: attemptedStages > 0 && successfulStages === 0,
    fallbackReason:
      attemptedStages > 0 && successfulStages === 0
        ? summarizeStageFailures(stageResults) || "all LLM stages fell back to rules"
        : "",
    guardWarnings,
    notes:
      successfulStages > 0
        ? [
            "real Zhihu items cleaned by rules",
            "Kimi/DeepSeek LLM stages enhanced safe display fields where available"
          ]
        : [
            "real Zhihu items cleaned by rules",
            "deterministic rule composer used; no successful LLM stage"
          ]
  };

  return response;
}

export function hasPersonaChatLlm(): boolean {
  return llmRouter.isTaskConfigured("persona_chat");
}

async function runIntentExpandStage(query: string): Promise<StageRunResult<IntentExpandOutput>> {
  const fallback = createFallbackIntent(query);
  if (!llmRouter.isTaskConfigured("intent_expand")) {
    return {
      output: fallback,
      stageResult: createSkippedStage("intent_expand", "DeepSeek not configured; original query used")
    };
  }

  try {
    const content = await llmRouter.runJsonTask("intent_expand", {
      temperature: 0.1,
      maxTokens: 800,
      messages: [
        {
          role: "system",
          content: INTENT_EXPAND_SYSTEM_PROMPT
        },
        {
          role: "user",
          content: JSON.stringify({
            query: truncateText(query, 120)
          })
        }
      ]
    });

    return {
      output: parseIntentExpandOutput(content, query),
      stageResult: createSuccessStage("intent_expand")
    };
  } catch (error) {
    return {
      output: fallback,
      stageResult: createFallbackStage("intent_expand", error)
    };
  }
}

async function runEvidenceExtractStage(
  query: string,
  intent: IntentExpandOutput,
  candidates: CleanedCandidate[]
): Promise<StageRunResult<EvidenceExtractOutput>> {
  const fallback = createFallbackEvidenceExtract(candidates);
  if (candidates.length === 0) {
    return {
      output: fallback,
      stageResult: createSkippedStage("evidence_extract", "no cleaned candidates")
    };
  }

  if (!llmRouter.isTaskConfigured("evidence_extract")) {
    return {
      output: fallback,
      stageResult: createSkippedStage("evidence_extract", "Kimi not configured; rule evidence seeds used")
    };
  }

  try {
    const content = await llmRouter.runJsonTask("evidence_extract", {
      temperature: 0.1,
      maxTokens: 3000,
      messages: [
        {
          role: "system",
          content: EVIDENCE_EXTRACT_SYSTEM_PROMPT
        },
        {
          role: "user",
          content: JSON.stringify({
            query: truncateText(query, 120),
            intent,
            candidates
          })
        }
      ]
    });

    return {
      output: parseEvidenceExtractOutput(content, new Set(candidates.map((item) => item.sourceRefId))),
      stageResult: createSuccessStage("evidence_extract")
    };
  } catch (error) {
    return {
      output: fallback,
      stageResult: createFallbackStage("evidence_extract", error)
    };
  }
}

async function runDemoResponseComposeStage(
  query: string,
  intent: IntentExpandOutput,
  evidence: EvidenceExtractOutput,
  response: DemoSearchResponse,
  candidates: CleanedCandidate[]
): Promise<StageRunResult<DemoResponseComposeOutput>> {
  const fallback = createEmptyDemoComposeOutput();
  if (!llmRouter.isTaskConfigured("demo_response_compose")) {
    return {
      output: fallback,
      stageResult: createSkippedStage(
        "demo_response_compose",
        "DeepSeek not configured; deterministic display fields preserved"
      )
    };
  }

  try {
    const content = await llmRouter.runJsonTask("demo_response_compose", {
      temperature: 0.2,
      maxTokens: 3600,
      messages: [
        {
          role: "system",
          content: DEMO_RESPONSE_COMPOSE_SYSTEM_PROMPT
        },
        {
          role: "user",
          content: JSON.stringify({
            query: truncateText(query, 120),
            intent,
            evidenceExtract: evidence,
            allowedIds: {
              pathIds: response.paths.map((path) => path.id),
              personIds: response.people.map((person) => person.id),
              sourceRefs: response.meta.sourceRefs.map((sourceRef) => sourceRef.id)
            },
            baseResponse: toDemoComposeContext(response),
            candidates
          })
        }
      ]
    });

    return {
      output: parseDemoResponseComposeOutput(content, {
        pathIds: new Set(response.paths.map((path) => path.id)),
        personIds: new Set(response.people.map((person) => person.id))
      }),
      stageResult: createSuccessStage("demo_response_compose")
    };
  } catch (error) {
    return {
      output: fallback,
      stageResult: createFallbackStage("demo_response_compose", error)
    };
  }
}

async function runGroundingGuardStage(
  response: DemoSearchResponse
): Promise<StageRunResult<GroundingGuardOutput>> {
  const fallback = createPassingGroundingGuard();
  if (!llmRouter.isTaskConfigured("grounding_guard")) {
    return {
      output: fallback,
      stageResult: createSkippedStage("grounding_guard", "DeepSeek not configured; rule guard used")
    };
  }

  try {
    const content = await llmRouter.runJsonTask("grounding_guard", {
      temperature: 0,
      maxTokens: 1400,
      messages: [
        {
          role: "system",
          content: GROUNDING_GUARD_SYSTEM_PROMPT
        },
        {
          role: "user",
          content: JSON.stringify({
            allowedSourceRefs: response.meta.sourceRefs.map((sourceRef) => sourceRef.id),
            response: toGroundingGuardContext(response)
          })
        }
      ]
    });

    return {
      output: parseGroundingGuardOutput(content, {
        personIds: new Set(response.people.map((person) => person.id)),
        personaIds: new Set(response.personas.map((persona) => persona.id))
      }),
      stageResult: createSuccessStage("grounding_guard")
    };
  } catch (error) {
    return {
      output: fallback,
      stageResult: createFallbackStage("grounding_guard", error)
    };
  }
}

async function searchByExpandedQueries(queries: string[], count: number): Promise<SearchItem[]> {
  const normalizedQueries = unique(queries.map((item) => item.trim()).filter(Boolean)).slice(
    0,
    MAX_SEARCH_QUERIES
  );
  const perQueryCount = Math.min(Math.max(count, 3), 10);
  const items: SearchItem[] = [];
  const errors: string[] = [];

  for (const query of normalizedQueries) {
    try {
      const result = await searchService.search(query, perQueryCount);
      items.push(...result.items);
    } catch (error) {
      errors.push(formatErrorSummary(error));
    }
  }

  const dedupedItems = dedupeSearchItems(items);
  if (dedupedItems.length === 0) {
    throw new HttpError(
      502,
      "REAL_SEARCH_EMPTY",
      errors.length > 0
        ? `real search returned no items: ${errors.slice(0, 2).join("; ")}`
        : "real search returned no items"
    );
  }

  return dedupedItems;
}

function cleanSearchItems(items: SearchItem[]): SearchItem[] {
  const dedupedItems = dedupeSearchItems(items);
  return dedupedItems.filter((item) => {
    const content = normalizeText(item.text || item.evidence.text || item.title);
    return content.length >= MIN_CONTENT_LENGTH && Boolean(item.url || item.id);
  });
}

function dedupeSearchItems(items: SearchItem[]): SearchItem[] {
  const seen = new Set<string>();
  const result: SearchItem[] = [];

  for (const item of items) {
    const key = item.url || item.id || `${item.title}:${item.author.name}`;
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(item);
  }

  return result;
}

function buildCleanedCandidatesFromResponse(response: DemoSearchResponse): CleanedCandidate[] {
  const candidates: CleanedCandidate[] = [];
  const seen = new Set<string>();

  for (const person of response.people) {
    for (const article of person.articles) {
      const sourceRefId = article.sourceRefs[0] || person.sourceRefs[0];
      if (!sourceRefId || seen.has(sourceRefId)) {
        continue;
      }

      const sourceRef = response.meta.sourceRefs.find((item) => item.id === sourceRefId);
      const text = truncateText(article.text || article.summary || article.title, 1200);
      const evidenceText = truncateText(
        article.evidence.map((item) => item.text).join("\n") || text,
        420
      );

      if (normalizeText(text).length < MIN_CONTENT_LENGTH) {
        continue;
      }

      seen.add(sourceRefId);
      candidates.push({
        candidateId: person.id,
        personId: person.id,
        articleId: article.id,
        sourceRefId,
        title: truncateText(article.title || sourceRef?.title || "未命名知乎内容", 80),
        text,
        evidenceText,
        author: truncateText(article.author || sourceRef?.author || "知乎用户", 40),
        sourceUrl: article.sourceUrl || article.url || sourceRef?.url || "",
        sampleType: person.sampleType ?? "content_sample"
      });
    }
  }

  return candidates.slice(0, MAX_REAL_ITEMS);
}

function createFallbackIntent(query: string): IntentExpandOutput {
  return {
    searchQueries: [query],
    intentTags: inferIntentTags(query),
    userNeedSummary: `用户正在探索「${truncateText(query, 40)}」相关的公开经验与可行路径。`
  };
}

function createFallbackEvidenceExtract(candidates: CleanedCandidate[]): EvidenceExtractOutput {
  return {
    evidenceRefs: candidates.slice(0, MAX_REAL_ITEMS).map((candidate) => ({
      sourceRefId: candidate.sourceRefId,
      label: "公开内容片段",
      evidenceText: truncateText(candidate.evidenceText || candidate.text, 180),
      relevanceScore: 0.68,
      reason: "规则兜底：保留可追溯的公开内容片段"
    })),
    peopleSeeds: candidates.slice(0, MAX_REAL_ITEMS).map((candidate) => ({
      personSeedId: candidate.personId,
      name: candidate.author || "知乎用户",
      sampleType:
        candidate.sampleType === "experience_sample" ||
        candidate.sampleType === "viewpoint_author" ||
        candidate.sampleType === "content_sample"
          ? candidate.sampleType
          : "content_sample",
      sourceRefs: [candidate.sourceRefId],
      oneLine: truncateText(candidate.text, 70),
      overlaps: ["都与当前问题共享公开内容线索"],
      lesson: "规则兜底只保留原文能支撑的谨慎启发"
    })),
    pathSignals: [],
    personaSeeds: candidates.slice(0, MAX_REAL_ITEMS).map((candidate) => ({
      personSeedId: candidate.personId,
      enabled: Boolean(candidate.sourceRefId && candidate.articleId),
      openingLine: "你可以继续问这段公开内容里的选择、代价和边界。",
      suggestedQuestions: ["这段公开内容里，最确定的信息是什么？", "哪些判断还缺少更多证据？"],
      sourceRefs: [candidate.sourceRefId]
    }))
  };
}

function createEmptyDemoComposeOutput(): DemoResponseComposeOutput {
  return {
    paths: [],
    people: [],
    personas: []
  };
}

function createPassingGroundingGuard(): GroundingGuardOutput {
  return {
    valid: true,
    warnings: [],
    disablePersonaPersonIds: [],
    disablePersonaIds: []
  };
}

function applyDemoResponseComposeOutput(
  response: DemoSearchResponse,
  output: DemoResponseComposeOutput,
  guardWarnings: string[]
): ComposeApplyStats {
  const stats: ComposeApplyStats = {
    pathCount: 0,
    peopleCount: 0,
    personaCount: 0
  };

  if (output.analysis?.summary && isSafeText(output.analysis.summary)) {
    response.analysis.summary = output.analysis.summary;
  }

  if (output.analysis?.focusTags?.length) {
    response.analysis.focusTags = output.analysis.focusTags.filter(isSafeText).slice(0, 8);
  }

  const pathById = new Map(response.paths.map((path) => [path.id, path]));
  for (const item of output.paths) {
    const path = pathById.get(item.id);
    if (!path || !areSafeTexts([item.title, item.summary])) {
      guardWarnings.push(`demo_response_compose path skipped: ${item.id}`);
      continue;
    }

    path.title = item.title;
    path.summary = item.summary;
    path.stance = item.stance;
    stats.pathCount += 1;
  }

  const personById = new Map(response.people.map((person) => [person.id, person]));
  for (const item of output.people) {
    const person = personById.get(item.id);
    if (!person) {
      guardWarnings.push(`demo_response_compose person skipped: ${item.id}`);
      continue;
    }

    const textValues = [
      item.role,
      item.badge,
      item.oneLine,
      item.who,
      item.lesson,
      item.openingLine,
      ...(item.overlaps ?? []),
      ...(item.matchReasons ?? []),
      ...(item.matchedVariables ?? []),
      ...(item.suggestedQuestions ?? [])
    ].filter((value): value is string => Boolean(value));

    if (!areSafeTexts(textValues)) {
      guardWarnings.push(`demo_response_compose unsafe person text skipped: ${item.id}`);
      continue;
    }

    if (item.role) person.role = item.role;
    if (item.badge) person.badge = item.badge;
    if (item.oneLine) person.oneLine = item.oneLine;
    if (item.who) person.who = ensurePublicContentBoundary(item.who);
    if (item.overlaps?.length) person.overlaps = item.overlaps;
    if (item.lesson) person.lesson = item.lesson;
    if (item.matchReasons?.length) person.match.reasons = item.matchReasons;
    if (item.matchedVariables?.length) person.match.matchedVariables = item.matchedVariables;
    if (typeof item.personaEnabled === "boolean") person.aiPersona.enabled = item.personaEnabled;
    if (item.openingLine) person.aiPersona.openingLine = item.openingLine;
    if (item.suggestedQuestions?.length) {
      person.aiPersona.suggestedQuestions = item.suggestedQuestions;
    }
    person.aiPersona.boundary = DEMO_PERSONA_BOUNDARY_NOTICE;
    stats.peopleCount += 1;
  }

  for (const item of output.personas) {
    const person = personById.get(item.personId);
    if (!person) {
      guardWarnings.push(`demo_response_compose persona skipped: ${item.personId}`);
      continue;
    }

    const textValues = [item.openingLine, ...(item.suggestedQuestions ?? [])].filter(
      (value): value is string => Boolean(value)
    );
    if (!areSafeTexts(textValues)) {
      guardWarnings.push(`demo_response_compose unsafe persona text skipped: ${item.personId}`);
      continue;
    }

    if (typeof item.enabled === "boolean") person.aiPersona.enabled = item.enabled;
    if (item.openingLine) person.aiPersona.openingLine = item.openingLine;
    if (item.suggestedQuestions?.length) {
      person.aiPersona.suggestedQuestions = item.suggestedQuestions;
    }
    person.aiPersona.boundary = DEMO_PERSONA_BOUNDARY_NOTICE;
    stats.personaCount += 1;
  }

  return stats;
}

function applyGroundingGuardOutput(
  response: DemoSearchResponse,
  output: GroundingGuardOutput,
  guardWarnings: string[]
): void {
  guardWarnings.push(...output.warnings);

  const disabledPersonIds = new Set(output.disablePersonaPersonIds);
  const disabledPersonaIds = new Set(output.disablePersonaIds);
  for (const person of response.people) {
    if (disabledPersonIds.has(person.id) || disabledPersonaIds.has(person.aiPersona.personaId)) {
      disablePersona(person, "grounding guard disabled persona");
    }
  }
}

function applyRuleGroundingGuard(response: DemoSearchResponse, guardWarnings: string[]): void {
  const allowedSourceRefs = new Set(response.meta.sourceRefs.map((sourceRef) => sourceRef.id));

  for (const path of response.paths) {
    path.sourceRefs = filterAllowedRefs(path.sourceRefs, allowedSourceRefs);
    path.evidenceIds = filterEvidenceIds(path.evidenceIds, path.sourceRefs, response.meta.sourceRefs);
  }

  for (const person of response.people) {
    person.sourceRefs = filterAllowedRefs(person.sourceRefs, allowedSourceRefs);
    person.evidenceIds = filterEvidenceIds(person.evidenceIds, person.sourceRefs, response.meta.sourceRefs);
    person.aiPersona.boundary = DEMO_PERSONA_BOUNDARY_NOTICE;
    person.aiPersona.grounding.sourceRefs = filterAllowedRefs(
      person.aiPersona.grounding.sourceRefs,
      allowedSourceRefs
    );

    const articleIds = new Set(person.articles.map((article) => article.id));
    person.aiPersona.grounding.articleIds = person.aiPersona.grounding.articleIds.filter((articleId) =>
      articleIds.has(articleId)
    );

    for (const article of person.articles) {
      article.sourceRefs = filterAllowedRefs(article.sourceRefs, allowedSourceRefs);
      article.evidence = article.evidence.filter((evidence) => allowedSourceRefs.has(evidence.sourceRefId));
    }

    const personaHasEvidence =
      person.aiPersona.grounding.articleIds.length > 0 &&
      person.aiPersona.grounding.sourceRefs.length > 0 &&
      person.articles.some((article) => article.evidence.length > 0);
    if (!personaHasEvidence) {
      disablePersona(person, "rules disabled persona because evidence/sourceRefs are insufficient");
      guardWarnings.push(`persona disabled for insufficient evidence: ${person.id}`);
    }

    if (!areSafeTexts([
      person.role,
      person.badge,
      person.oneLine,
      person.who,
      person.lesson,
      person.aiPersona.openingLine,
      ...person.aiPersona.suggestedQuestions,
      ...person.match.reasons
    ])) {
      disablePersona(person, "rules disabled persona because text crossed safety boundary");
      guardWarnings.push(`persona disabled for unsafe text boundary: ${person.id}`);
    }
  }
}

function disablePersona(person: DemoPerson, reason: string): void {
  person.aiPersona.enabled = false;
  person.aiPersona.openingLine = "这段公开内容证据不足，暂时不能生成可追问的经验回声。";
  person.aiPersona.suggestedQuestions = ["这段公开内容里，哪些信息是确定的？"];
  person.match.riskNotes = unique([...person.match.riskNotes, reason]);
}

function syncTopLevelPersonas(response: DemoSearchResponse): void {
  response.personas = response.people.map(toPersona);

  const personaSection = response.sections.find((section) => section.type === "personas");
  if (personaSection) {
    personaSection.itemRefs = response.personas.map((persona) => persona.id);
  }
}

function toPersona(person: DemoPerson): DemoPersona {
  return {
    id: person.aiPersona.personaId,
    personId: person.id,
    displayName: person.aiPersona.displayName,
    avatar: person.avatar,
    personaType: "experience_echo",
    intro: person.aiPersona.openingLine,
    boundaryNotice: DEMO_PERSONA_BOUNDARY_NOTICE,
    sourceRefs: person.sourceRefs,
    suggestedQuestions: person.aiPersona.suggestedQuestions
  };
}

function toDemoComposeContext(response: DemoSearchResponse): Record<string, unknown> {
  return {
    analysis: response.analysis,
    paths: response.paths,
    people: response.people.map((person) => ({
      id: person.id,
      name: person.name,
      sampleType: person.sampleType,
      pathId: person.pathId,
      role: person.role,
      badge: person.badge,
      oneLine: person.oneLine,
      who: person.who,
      overlaps: person.overlaps,
      lesson: person.lesson,
      match: {
        reasons: person.match.reasons,
        matchedVariables: person.match.matchedVariables,
        riskNotes: person.match.riskNotes,
        sourceRefs: person.match.sourceRefs,
        evidenceIds: person.match.evidenceIds
      },
      aiPersona: {
        enabled: person.aiPersona.enabled,
        personaId: person.aiPersona.personaId,
        openingLine: person.aiPersona.openingLine,
        suggestedQuestions: person.aiPersona.suggestedQuestions,
        sourceRefs: person.aiPersona.grounding.sourceRefs
      },
      articles: person.articles.map((article) => ({
        id: article.id,
        title: article.title,
        summary: article.summary,
        text: truncateText(article.text, 500),
        sourceRefs: article.sourceRefs,
        evidence: article.evidence.map((evidence) => ({
          id: evidence.id,
          label: evidence.label,
          text: truncateText(evidence.text, 160),
          sourceRefId: evidence.sourceRefId
        }))
      })),
      sourceRefs: person.sourceRefs,
      evidenceIds: person.evidenceIds
    }))
  };
}

function toGroundingGuardContext(response: DemoSearchResponse): Record<string, unknown> {
  return {
    paths: response.paths.map((path) => ({
      id: path.id,
      title: path.title,
      summary: path.summary,
      sourceRefs: path.sourceRefs,
      evidenceIds: path.evidenceIds
    })),
    people: response.people.map((person) => ({
      id: person.id,
      role: person.role,
      oneLine: person.oneLine,
      who: person.who,
      lesson: person.lesson,
      sourceRefs: person.sourceRefs,
      evidenceIds: person.evidenceIds,
      aiPersona: person.aiPersona
    })),
    personas: response.personas
  };
}

function filterAllowedRefs(sourceRefs: string[], allowedSourceRefs: Set<string>): string[] {
  return unique(sourceRefs.filter((sourceRef) => allowedSourceRefs.has(sourceRef)));
}

function filterEvidenceIds(
  evidenceIds: string[],
  sourceRefs: string[],
  allSourceRefs: DemoSourceRef[]
): string[] {
  const allowedEvidenceIds = new Set(
    allSourceRefs
      .filter((sourceRef) => sourceRefs.includes(sourceRef.id))
      .flatMap((sourceRef) => sourceRef.evidenceIds)
  );

  return unique(evidenceIds.filter((evidenceId) => allowedEvidenceIds.has(evidenceId)));
}

function createSuccessStage(stage: LlmTaskType): DemoDebugLlmStageResult {
  return {
    stage,
    attempted: 1,
    succeeded: 1,
    failed: 0,
    repairUsed: 0,
    repairFailed: 0,
    fallbackReasons: []
  };
}

function createFallbackStage(stage: LlmTaskType, error: unknown): DemoDebugLlmStageResult {
  return {
    stage,
    attempted: 1,
    succeeded: 0,
    failed: 1,
    repairUsed: 0,
    repairFailed: 0,
    fallbackReasons: [formatErrorSummary(error)]
  };
}

function createSkippedStage(stage: LlmTaskType, reason: string): DemoDebugLlmStageResult {
  return {
    stage,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    repairUsed: 0,
    repairFailed: 0,
    fallbackReasons: [reason]
  };
}

function summarizeStageFailures(stageResults: DemoDebugLlmStageResult[]): string {
  return stageResults
    .filter((result) => result.attempted > 0 && result.succeeded === 0)
    .flatMap((result) => result.fallbackReasons.map((reason) => `${result.stage}: ${reason}`))
    .slice(0, 3)
    .join("; ");
}

function inferIntentTags(query: string): string[] {
  const tags = [
    ["暂停工作", ["不工作", "不上班", "失业", "裸辞"]],
    ["地点选择", ["去哪", "哪里", "城市", "回老家", "新西兰"]],
    ["现金流", ["钱", "收入", "副业", "存款"]],
    ["风险兜底", ["怎么办", "风险", "保障", "焦虑"]]
  ]
    .filter(([, keywords]) => (keywords as string[]).some((keyword) => query.includes(keyword)))
    .map(([tag]) => tag as string);

  return tags.length > 0 ? tags : ["人生路径", "公开经验"];
}

function ensurePublicContentBoundary(value: string): string {
  if (value.includes("公开内容") || value.includes("公开回答")) {
    return value;
  }

  return `${value}（基于知乎公开内容整理，不等同于作者完整人生。）`;
}

function areSafeTexts(values: string[]): boolean {
  return values.every(isSafeText);
}

function isSafeText(value: string): boolean {
  const forbiddenFragments = [
    "作者本人正在回答",
    "本人正在回答",
    "作为作者本人",
    "作为这位作者",
    "我是作者",
    "我当时",
    "我经历过",
    "作者在线",
    "联系TA",
    "联系 TA",
    "联系作者",
    "私信",
    "加微信",
    "和作者聊",
    "和本人聊",
    "模拟作者本人"
  ];

  return !forbiddenFragments.some((fragment) => value.includes(fragment));
}

function formatErrorSummary(error: unknown): string {
  if (error instanceof HttpError) {
    return `${error.code}: ${error.message}`;
  }

  if (error instanceof Error && error.message) {
    const code = "code" in error && typeof error.code === "string" ? error.code : error.name;
    return `${code || "ERROR"}: ${truncateText(error.message, 160)}`;
  }

  return "UNKNOWN_ERROR: Unknown error";
}

function truncateText(value: string, maxLength: number): string {
  const normalized = normalizeText(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
