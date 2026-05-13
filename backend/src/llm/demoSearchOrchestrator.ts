import { assertDemoSearchGrounding } from "../guards/demoEvidence.guard.js";
import { composeRealDemoSearchResponse } from "../services/demoRealComposer.service.js";
import { searchService } from "../services/search.service.js";
import {
  buildPromptUserContext,
  createDemoContextUsed
} from "../services/userContext.service.js";
import {
  MAX_REFILL_ROUNDS,
  MAX_RERANK_CANDIDATES,
  MIN_EFFECTIVE_CANDIDATES,
  TARGET_EFFECTIVE_CANDIDATES,
  assessSearchCandidates,
  attachAssessmentMetadata,
  buildDynamicTopicSignals,
  buildRoughTierDistribution,
  selectRerankCandidateAssessments,
  selectRuleFallbackAssessments,
  toCandidateQualityDebug,
  type CandidateAssessment
} from "../services/demoCandidateQuality.service.js";
import {
  DEMO_PERSONA_BOUNDARY_NOTICE,
  type DemoDataMode,
  type DemoCandidateQuality,
  type DemoDebugFallbackKind,
  type DemoDebugIntentStage,
  type DemoDebugLlmStageResult,
  type DemoDebugTiming,
  type DemoExperienceSummaryDebug,
  type DemoPerson,
  type DemoPersona,
  type DemoSearchQueryPlan,
  type DemoSearchQueryResultDebug,
  type DemoSearchQueryType,
  type DemoSearchResponse,
  type DemoSourceRef
} from "../types/demo.types.js";
import type { UserContext } from "../auth/session.js";
import type { SearchItem } from "../types/api.types.js";
import { HttpError } from "../utils/httpError.js";
import { llmRouter, type LlmTaskType } from "./llmRouter.js";
import { DEMO_RESPONSE_COMPOSE_SYSTEM_PROMPT } from "./prompts/demoResponseComposePrompt.js";
import { EVIDENCE_EXTRACT_SYSTEM_PROMPT } from "./prompts/evidenceExtractPrompt.js";
import { EXPERIENCE_SUMMARY_SYSTEM_PROMPT } from "./prompts/experienceSummaryPrompt.js";
import { GROUNDING_GUARD_SYSTEM_PROMPT } from "./prompts/groundingGuardPrompt.js";
import { INTENT_EXPAND_SYSTEM_PROMPT } from "./prompts/intentExpandPrompt.js";
import { CANDIDATE_RERANK_SYSTEM_PROMPT } from "./prompts/candidateRerankPrompt.js";
import {
  type CandidateRerankOutput,
  type DemoResponseComposeOutput,
  type EvidenceExtractOutput,
  type ExperienceSummaryOutput,
  type GroundingGuardOutput,
  type IntentExpandOutput,
  parseCandidateRerankOutput,
  parseDemoResponseComposeOutput,
  parseEvidenceExtractOutput,
  parseExperienceSummaryOutput,
  parseGroundingGuardOutput,
  parseIntentExpandOutput
} from "./schemas/taskSchemas.js";
import { buildFallbackSearchQueryPlan, sortSearchQueryPlans } from "./searchQueryPlan.js";
import { enforceDemoPathDiversity } from "../services/demoPathDiversity.service.js";

interface ComposeMultiLlmDemoSearchInput {
  query: string;
  count: number;
  dataMode: DemoDataMode;
  startedAt: number;
  userContext?: UserContext;
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
  relevanceScore: number;
  qualityScore: number;
  experienceSignalScore: number;
  contentLength: number;
  filterReason: string;
  roughScore?: number;
  matchedQuery?: string;
  queryType?: string;
  queryPurpose?: string;
  contentRole?: string;
  relationToUserIntent?: string;
  summaryAngle?: string;
  diversityKey?: string;
  keepReason?: string;
}

interface ExperienceSummaryCandidate {
  personId: string;
  candidateId: string;
  articleId: string;
  sourceRefId: string;
  title: string;
  content: string;
  summary: string;
  evidence: Array<{
    id: string;
    label: string;
    text: string;
  }>;
  candidateQuality: {
    relevanceScore: number;
    qualityScore: number;
    experienceSignalScore: number;
    contentLength: number;
    filterReason: string;
  };
  contentHash: string;
  fallbackSummary: string;
  matchedQuery?: string;
  queryType?: string;
  queryPurpose?: string;
}

interface ExperienceSummaryStageOutput {
  summaries: ExperienceSummaryOutput;
  debug: DemoExperienceSummaryDebug[];
}

interface StageRunResult<T> {
  output: T;
  stageResult: DemoDebugLlmStageResult;
}

interface TimedStageRunResult<T> extends StageRunResult<T> {
  durationMs: number;
}

interface ComposeApplyStats {
  focusTagCount: number;
  pathCount: number;
  peopleCount: number;
  personaCount: number;
}

interface LlmFallbackSummary {
  used: boolean;
  kind: DemoDebugFallbackKind;
  reason: string;
}

interface SearchByExpandedQueriesResult {
  items: SearchItem[];
  searchQueries: DemoSearchQueryPlan[];
  searchQueryResults: DemoSearchQueryResultDebug[];
  rawCandidateCount: number;
  mergedCandidateCount: number;
  dedupedCandidateCount: number;
}

interface CandidatePipelineResult {
  items: SearchItem[];
  candidateQuality: DemoCandidateQuality[];
  stageResult: DemoDebugLlmStageResult;
  durationMs: number;
  rerankEnabled: boolean;
  rerankUsed: boolean;
  rerankFailedReason: string;
  rerankCandidatesCount: number;
  selectedCandidatesCount: number;
  droppedCandidatesCount: number;
  refillTriggered: boolean;
  refillReason: string;
  refillQueries: DemoSearchQueryPlan[];
  refillCandidateCount: number;
  finalCandidateCount: number;
  roughTierDistribution: ReturnType<typeof buildRoughTierDistribution>;
  finalCandidates: NonNullable<DemoSearchResponse["debug"]["finalCandidates"]>;
  droppedCandidates: NonNullable<DemoSearchResponse["debug"]["droppedCandidates"]>;
}

const MAX_SEARCH_QUERIES = 12;
const MAX_REAL_ITEMS = 12;
const MAX_EXPERIENCE_SUMMARY_PEOPLE = 3;
const MIN_CONTENT_LENGTH = 8;
const EXPERIENCE_SUMMARY_MIN_CONTENT_LENGTH = 60;
const EXPERIENCE_SUMMARY_MIN_QUALITY_SCORE = 0.38;
const EXPERIENCE_SUMMARY_MIN_EXPERIENCE_SIGNAL_SCORE = 0.26;
const EXPERIENCE_SUMMARY_CACHE_TTL_MS = 15 * 60 * 1000;
const DEMO_LLM_STAGE_TIMEOUT_MS: Partial<Record<LlmTaskType, number>> = {
  intent_expand: 3000,
  candidate_rerank: 10000,
  evidence_extract: 9000,
  demo_response_compose: 7000,
  experience_summary: 12000,
  grounding_guard: 3000
};

const experienceSummaryCache = new Map<
  string,
  {
    expiresAt: number;
    summary: NonNullable<ExperienceSummaryOutput["summaries"][number]["experienceSummary"]>;
    confidence: number;
    reason: string;
  }
>();

export async function composeMultiLlmDemoSearchResponse(
  input: ComposeMultiLlmDemoSearchInput
): Promise<DemoSearchResponse> {
  const stageResults: DemoDebugLlmStageResult[] = [];
  const timings: DemoDebugTiming[] = [];
  const guardWarnings: string[] = [];

  const intentStage = await runTimedStage(() => runIntentExpandStage(input.query, input.userContext));
  stageResults.push(intentStage.stageResult);
  timings.push(createStageTiming(intentStage));

  const recalledSearch = await searchByExpandedQueries(
    input.query,
    intentStage.output,
    input.count,
    input.userContext
  );
  const candidatePipeline = await runCandidatePipeline(
    input.query,
    intentStage.output,
    recalledSearch,
    input.count,
    input.userContext
  );
  stageResults.push(candidatePipeline.stageResult);
  timings.push({
    stageName: candidatePipeline.stageResult.stage,
    durationMs: candidatePipeline.durationMs,
    llmUsed: candidatePipeline.rerankUsed,
    fallbackUsed:
      candidatePipeline.stageResult.attempted === 0 || candidatePipeline.stageResult.failed > 0,
    fallbackReason: candidatePipeline.stageResult.fallbackReasons.join("; ")
  });

  const cleanedSearchItems = candidatePipeline.items;
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
    startedAt: input.startedAt,
    userContext: input.userContext,
    candidateQuality: candidatePipeline.candidateQuality
  });

  const candidates = buildCleanedCandidatesFromResponse(response);
  const evidenceStage = await runTimedStage(() =>
    runEvidenceExtractStage(input.query, intentStage.output, candidates)
  );
  stageResults.push(evidenceStage.stageResult);
  timings.push(createStageTiming(evidenceStage));

  const composeStage = await runTimedStage(() =>
    runDemoResponseComposeStage(
      input.query,
      intentStage.output,
      evidenceStage.output,
      response,
      candidates,
      input.userContext
    )
  );
  stageResults.push(composeStage.stageResult);
  timings.push(createStageTiming(composeStage));

  const applyStats = applyDemoResponseComposeOutput(response, composeStage.output, guardWarnings);
  response.debug.pathDiversityCheck = enforceDemoPathDiversity(response.paths, {
    mergeCount: response.debug.pathDiversityCheck?.mergeCount,
    notes: [
      ...(response.debug.pathDiversityCheck?.notes ?? []),
      composeStage.stageResult.succeeded > 0
        ? "LLM composer output rechecked for path title/summary diversity"
        : "LLM composer fallback preserved deterministic path diversity"
    ]
  });
  response.debug.pathDuplicateFound = response.debug.pathDiversityCheck.duplicateFound;
  syncTopLevelPersonas(response);

  const experienceSummaryStage = await runTimedStage(() =>
    runExperienceSummaryStage(input.query, response)
  );
  stageResults.push(experienceSummaryStage.stageResult);
  timings.push(createStageTiming(experienceSummaryStage));
  applyExperienceSummaryOutput(response, experienceSummaryStage.output);

  const groundingStage = await runTimedStage(() => runGroundingGuardStage(response));
  stageResults.push(groundingStage.stageResult);
  timings.push(createStageTiming(groundingStage));
  applyGroundingGuardOutput(response, groundingStage.output, guardWarnings);
  applyRuleGroundingGuard(response, guardWarnings);
  syncTopLevelPersonas(response);
  assertDemoSearchGrounding(response);

  const successfulStages = stageResults.reduce((total, item) => total + item.succeeded, 0);
  const fallbackSummary = summarizeLlmFallback(stageResults);

  response.meta.latencyMs = Date.now() - input.startedAt;
  response.meta.fallbackUsed = fallbackSummary.used;
  response.contextUsed = createDemoContextUsed(input.userContext, [
    "intent_expand",
    "search_query_expand",
    "fit_reason"
  ]);
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
    timings,
    enhancedPeopleCount: applyStats.peopleCount + applyStats.personaCount,
    enhancedPathCount: applyStats.pathCount,
    partialFallbackUsed: fallbackSummary.kind === "partial_llm_fallback",
    pathSource: applyStats.pathCount > 0 ? "llm" : response.debug.pathSource,
    composerFallbackTriggered: composeStage.stageResult.succeeded === 0,
    pathDuplicateFound: response.debug.pathDiversityCheck?.duplicateFound ?? false,
    pathDiversityCheck: response.debug.pathDiversityCheck,
    intentStage: buildIntentStageDebug(
      intentStage.stageResult,
      composeStage.stageResult,
      applyStats.focusTagCount > 0
    ),
    fallbackUsed: fallbackSummary.used,
    fallbackKind: fallbackSummary.kind,
    fallbackReason: fallbackSummary.reason,
    guardWarnings,
    userCoreQuestion: intentStage.output.userCoreQuestion,
    topicSignals: intentStage.output.topicSignals,
    searchQueries: recalledSearch.searchQueries,
    searchQueryResults: recalledSearch.searchQueryResults,
    rawCandidateCount: recalledSearch.rawCandidateCount,
    mergedCandidateCount: recalledSearch.mergedCandidateCount,
    dedupedCandidateCount: recalledSearch.dedupedCandidateCount,
    validCandidateCount: cleanedSearchItems.length,
    roughTierDistribution: candidatePipeline.roughTierDistribution,
    rerankEnabled: candidatePipeline.rerankEnabled,
    rerankUsed: candidatePipeline.rerankUsed,
    rerankDurationMs: candidatePipeline.durationMs,
    rerankFailedReason: candidatePipeline.rerankFailedReason,
    rerankCandidatesCount: candidatePipeline.rerankCandidatesCount,
    selectedCandidatesCount: candidatePipeline.selectedCandidatesCount,
    droppedCandidatesCount: candidatePipeline.droppedCandidatesCount,
    refillTriggered: candidatePipeline.refillTriggered,
    refillReason: candidatePipeline.refillReason,
    refillQueries: candidatePipeline.refillQueries,
    refillCandidateCount: candidatePipeline.refillCandidateCount,
    finalCandidateCount: candidatePipeline.finalCandidateCount,
    finalCandidates: attachFinalCandidateSourceRefs(
      candidatePipeline.finalCandidates,
      response.debug.candidateQuality
    ),
    droppedCandidates: candidatePipeline.droppedCandidates,
    candidateQuality: response.debug.candidateQuality,
    experienceSummaryDebug: experienceSummaryStage.output.debug,
    notes:
      successfulStages > 0
        ? [
            "real Zhihu items cleaned by rules",
            fallbackSummary.reason || "all configured LLM stages completed without fallback",
            "Kimi/DeepSeek LLM stages enhanced safe display fields where available"
          ]
        : [
            "real Zhihu items cleaned by rules",
            fallbackSummary.reason || "all LLM stages used deterministic rules",
            "deterministic rule composer used; no successful LLM stage"
          ]
  };

  return response;
}

export function hasPersonaChatLlm(): boolean {
  return llmRouter.isTaskConfigured("persona_chat");
}

async function runTimedStage<T>(
  task: () => Promise<StageRunResult<T>>
): Promise<TimedStageRunResult<T>> {
  const startedAt = Date.now();
  const result = await task();
  return {
    ...result,
    durationMs: Date.now() - startedAt
  };
}

function createStageTiming(result: TimedStageRunResult<unknown>): DemoDebugTiming {
  const fallbackUsed = result.stageResult.attempted === 0 || result.stageResult.failed > 0;
  return {
    stageName: result.stageResult.stage,
    durationMs: result.durationMs,
    llmUsed: result.stageResult.succeeded > 0,
    fallbackUsed,
    fallbackReason: fallbackUsed ? result.stageResult.fallbackReasons.join("; ") : ""
  };
}

async function runJsonTaskWithStageTimeout(
  taskType: LlmTaskType,
  input: Parameters<typeof llmRouter.runJsonTask>[1]
): Promise<string> {
  const timeoutMs = DEMO_LLM_STAGE_TIMEOUT_MS[taskType] ?? 8000;
  return withTimeout(
    llmRouter.runJsonTask(taskType, {
      ...input,
      timeoutMs,
      maxRetry: 0
    }),
    taskType,
    timeoutMs
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  taskType: LlmTaskType,
  timeoutMs: number
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(
          () => reject(new LlmStageTimeoutError(taskType, timeoutMs)),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

class LlmStageTimeoutError extends Error {
  constructor(taskType: LlmTaskType, timeoutMs: number) {
    super(`${taskType} exceeded ${timeoutMs}ms stage timeout`);
    this.name = "LlmStageTimeoutError";
  }
}

async function runIntentExpandStage(
  query: string,
  userContext?: UserContext
): Promise<StageRunResult<IntentExpandOutput>> {
  const fallback = createFallbackIntent(query);
  if (!llmRouter.isTaskConfigured("intent_expand")) {
    return {
      output: fallback,
      stageResult: createSkippedStage("intent_expand", "DeepSeek not configured; original query used")
    };
  }

  try {
    const content = await runJsonTaskWithStageTimeout("intent_expand", {
      temperature: 0.1,
      maxTokens: 1600,
      messages: [
        {
          role: "system",
          content: INTENT_EXPAND_SYSTEM_PROMPT
        },
        {
          role: "user",
          content: JSON.stringify({
            query: truncateText(query, 120),
            userContext: buildPromptUserContext(userContext)
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
    const content = await runJsonTaskWithStageTimeout("evidence_extract", {
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
  candidates: CleanedCandidate[],
  userContext?: UserContext
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
    const content = await runJsonTaskWithStageTimeout("demo_response_compose", {
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
            originalQuery: truncateText(query, 120),
            query: truncateText(query, 120),
            userCoreQuestion: intent.userCoreQuestion,
            focusTags: intent.focusTags,
            topicSignals: intent.topicSignals,
            userContext: buildPromptUserContext(userContext),
            intent,
            evidenceExtract: evidence,
            allowedIds: {
              pathIds: response.paths.map((path) => path.id),
              personIds: response.people.map((person) => person.id),
              sourceRefs: response.meta.sourceRefs.map((sourceRef) => sourceRef.id)
            },
            baseResponse: toDemoComposeContext(response),
            finalCandidates: candidates.map(toDemoResponseComposeFinalCandidate),
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

async function runExperienceSummaryStage(
  query: string,
  response: DemoSearchResponse
): Promise<StageRunResult<ExperienceSummaryStageOutput>> {
  const candidates = buildExperienceSummaryCandidates(query, response);
  const debug = initializeExperienceSummaryDebug(response, candidates);

  if (candidates.length === 0) {
    return {
      output: {
        summaries: { summaries: [] },
        debug
      },
      stageResult: createSkippedStage(
        "experience_summary",
        "no high-quality top people candidates for experienceSummary"
      )
    };
  }

  const cachedSummaries: ExperienceSummaryOutput["summaries"] = [];
  const uncachedCandidates: ExperienceSummaryCandidate[] = [];

  pruneExpiredExperienceSummaryCache();
  for (const candidate of candidates) {
    const cacheKey = buildExperienceSummaryCacheKey(query, candidate);
    const cached = experienceSummaryCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      cachedSummaries.push({
        personId: candidate.personId,
        experienceSummary: cached.summary,
        confidence: cached.confidence,
        reason: cached.reason
      });
      markExperienceSummaryDebug(debug, candidate.personId, {
        status: "ready",
        source: "llm",
        reason: "experienceSummary cache hit",
        cacheHit: true
      });
      continue;
    }

    uncachedCandidates.push(candidate);
  }

  if (uncachedCandidates.length === 0) {
    return {
      output: {
        summaries: { summaries: cachedSummaries },
        debug
      },
      stageResult: {
        stage: "experience_summary",
        attempted: 1,
        succeeded: cachedSummaries.length,
        failed: 0,
        repairUsed: 0,
        repairFailed: 0,
        fallbackReasons: []
      }
    };
  }

  if (!llmRouter.isTaskConfigured("experience_summary")) {
    for (const candidate of uncachedCandidates) {
      markExperienceSummaryDebug(debug, candidate.personId, {
        status: "failed",
        source: "none",
        reason: "Kimi not configured; experienceSummary not generated",
        cacheHit: false
      });
    }

    return {
      output: {
        summaries: { summaries: cachedSummaries },
        debug
      },
      stageResult: createSkippedStage("experience_summary", "Kimi not configured; experienceSummary not generated")
    };
  }

  try {
    const content = await runJsonTaskWithStageTimeout("experience_summary", {
      temperature: 0.15,
      maxTokens: 1800,
      messages: [
        {
          role: "system",
          content: EXPERIENCE_SUMMARY_SYSTEM_PROMPT
        },
        {
          role: "user",
          content: JSON.stringify({
            query: truncateText(query, 120),
            people: uncachedCandidates.map(toExperienceSummaryPromptCandidate)
          })
        }
      ]
    });
    const parsed = parseExperienceSummaryOutput(
      content,
      new Set(uncachedCandidates.map((candidate) => candidate.personId))
    );
    const acceptedSummaries = filterAndCacheExperienceSummaries(
      query,
      parsed,
      uncachedCandidates,
      debug
    );
    const missingCount = uncachedCandidates.length - acceptedSummaries.length;

    return {
      output: {
        summaries: {
          summaries: [...cachedSummaries, ...acceptedSummaries]
        },
        debug
      },
      stageResult: {
        stage: "experience_summary",
        attempted: 1,
        succeeded: acceptedSummaries.length + cachedSummaries.length,
        failed: missingCount,
        repairUsed: 0,
        repairFailed: 0,
        fallbackReasons:
          missingCount > 0
            ? ["some experienceSummary items were missing, null, or advice-style"]
            : []
      }
    };
  } catch (error) {
    const reason = formatErrorSummary(error);
    for (const candidate of uncachedCandidates) {
      markExperienceSummaryDebug(debug, candidate.personId, {
        status: "failed",
        source: "none",
        reason,
        cacheHit: false
      });
    }

    return {
      output: {
        summaries: { summaries: cachedSummaries },
        debug
      },
      stageResult: createFallbackStage("experience_summary", error)
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
    const content = await runJsonTaskWithStageTimeout("grounding_guard", {
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

    const output = parseGroundingGuardOutput(content, {
      personIds: new Set(response.people.map((person) => person.id)),
      personaIds: new Set(response.personas.map((persona) => persona.id))
    });

    return {
      output,
      stageResult: output.valid
        ? createSuccessStage("grounding_guard")
        : createInvalidGroundingGuardStage(output)
    };
  } catch (error) {
    return {
      output: fallback,
      stageResult: createFallbackStage("grounding_guard", error)
    };
  }
}

async function searchByExpandedQueries(
  _originalQuery: string,
  intent: IntentExpandOutput,
  count: number,
  _userContext?: UserContext
): Promise<SearchByExpandedQueriesResult> {
  const normalizedQueries = sortSearchQueryPlans(intent.searchQueries).slice(0, MAX_SEARCH_QUERIES);
  const perQueryCount = Math.min(Math.max(count, 3), 3);
  const items: SearchItem[] = [];
  const errors: string[] = [];
  const searchQueryResults: DemoSearchQueryResultDebug[] = [];

  for (const queryPlan of normalizedQueries) {
    try {
      const result = await searchService.search(queryPlan.query, perQueryCount);
      const queryItems = result.items
        .slice(0, perQueryCount)
        .map((item) => attachMatchedQuery(item, queryPlan));
      items.push(...queryItems);
      searchQueryResults.push({
        ...queryPlan,
        returnedCount: queryItems.length
      });
    } catch (error) {
      const errorSummary = formatErrorSummary(error);
      errors.push(`${queryPlan.query}: ${errorSummary}`);
      searchQueryResults.push({
        ...queryPlan,
        returnedCount: 0,
        error: errorSummary
      });
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

  return {
    items: dedupedItems,
    searchQueries: normalizedQueries,
    searchQueryResults,
    rawCandidateCount: items.length,
    mergedCandidateCount: items.length,
    dedupedCandidateCount: dedupedItems.length
  };
}

async function runCandidatePipeline(
  query: string,
  intent: IntentExpandOutput,
  recalledSearch: SearchByExpandedQueriesResult,
  count: number,
  userContext?: UserContext
): Promise<CandidatePipelineResult> {
  const startedAt = Date.now();
  const context = {
    originalQuery: query,
    userCoreQuestion: intent.userCoreQuestion,
    focusTags: intent.focusTags,
    topicSignals: intent.topicSignals,
    searchQueries: recalledSearch.searchQueries
  };
  let allItems = recalledSearch.items;
  let assessments = assessSearchCandidates(context, allItems);
  let rerankCandidates = selectRerankCandidateAssessments(assessments);
  let rerankOutput: CandidateRerankOutput | undefined;
  let stageResult: DemoDebugLlmStageResult;
  let rerankFailedReason = "";
  let rerankDropReasonById = new Map<string, string>();
  const rerankEnabled = llmRouter.isTaskConfigured("candidate_rerank");

  if (rerankCandidates.length === 0) {
    stageResult = createSkippedStage("candidate_rerank", "no rough-filtered candidates for rerank");
  } else if (!rerankEnabled) {
    stageResult = createSkippedStage("candidate_rerank", "DeepSeek not configured; rule rerank fallback used");
  } else {
    try {
      const content = await runJsonTaskWithStageTimeout("candidate_rerank", {
        temperature: 0.1,
        maxTokens: 2200,
        messages: [
          {
            role: "system",
            content: CANDIDATE_RERANK_SYSTEM_PROMPT
          },
          {
            role: "user",
            content: JSON.stringify({
              originalQuery: truncateText(query, 120),
              userCoreQuestion: intent.userCoreQuestion,
              focusTags: intent.focusTags,
              topicSignals: intent.topicSignals,
              searchQueries: recalledSearch.searchQueries,
              candidates: rerankCandidates.slice(0, MAX_RERANK_CANDIDATES).map(toCandidateRerankPromptItem)
            })
          }
        ]
      });
      rerankOutput = parseCandidateRerankOutput(
        content,
        new Set(rerankCandidates.map((candidate) => candidate.candidateId))
      );
      stageResult = createSuccessStage("candidate_rerank");
    } catch (error) {
      rerankFailedReason = formatErrorSummary(error);
      stageResult = createFallbackStage("candidate_rerank", error);
    }
  }

  let selectedAssessments = rerankOutput
    ? applyCandidateRerankOutput(assessments, rerankOutput)
    : selectRuleFallbackAssessments(assessments, TARGET_EFFECTIVE_CANDIDATES);
  if (rerankOutput) {
    rerankDropReasonById = markRerankDroppedCandidates(rerankCandidates, rerankOutput);
  }
  let refillTriggered = false;
  let refillReason = "";
  let refillQueries: DemoSearchQueryPlan[] = [];
  let refillCandidateCount = 0;

  if (selectedAssessments.length < MIN_EFFECTIVE_CANDIDATES && MAX_REFILL_ROUNDS > 0) {
    refillTriggered = true;
    refillReason = `selectedCandidates=${selectedAssessments.length} below MIN_EFFECTIVE_CANDIDATES=${MIN_EFFECTIVE_CANDIDATES}`;
    refillQueries = buildRefillQueries(intent, selectedAssessments, recalledSearch.searchQueries);

    if (refillQueries.length > 0) {
      const refillSearch = await searchByQueryPlans(refillQueries, 5);
      refillCandidateCount = refillSearch.items.length;
      allItems = dedupeSearchItems([...allItems, ...refillSearch.items]);
      assessments = assessSearchCandidates(
        {
          ...context,
          searchQueries: [...recalledSearch.searchQueries, ...refillQueries]
        },
        allItems
      );
      restoreDropReasons(assessments, rerankDropReasonById);
      const selectedIds = new Set(selectedAssessments.map((assessment) => assessment.candidateId));
      const supplemental = selectRuleFallbackAssessments(
        assessments.filter((assessment) => !selectedIds.has(assessment.candidateId)),
        TARGET_EFFECTIVE_CANDIDATES - selectedAssessments.length
      );
      selectedAssessments = [
        ...selectedAssessments,
        ...supplemental
      ].slice(0, TARGET_EFFECTIVE_CANDIDATES);
      rerankCandidates = selectRerankCandidateAssessments(assessments);
    }
  }

  if (selectedAssessments.length < MIN_EFFECTIVE_CANDIDATES) {
    const selectedIds = new Set(selectedAssessments.map((assessment) => assessment.candidateId));
    const backup = selectRuleFallbackAssessments(
      assessments.filter((assessment) => !selectedIds.has(assessment.candidateId)),
      TARGET_EFFECTIVE_CANDIDATES - selectedAssessments.length
    );
    selectedAssessments = [...selectedAssessments, ...backup].slice(0, TARGET_EFFECTIVE_CANDIDATES);
  }

  selectedAssessments = enforceSelectedDiversity(selectedAssessments, assessments).slice(
    0,
    TARGET_EFFECTIVE_CANDIDATES
  );
  for (const assessment of selectedAssessments) {
    applyRuleKeepMetadata(assessment, intent);
  }

  const selectedIds = new Set(selectedAssessments.map((assessment) => assessment.candidateId));
  const droppedAssessments = assessments
    .filter((assessment) => !selectedIds.has(assessment.candidateId))
    .sort((left, right) => left.roughScore - right.roughScore);
  const droppedForDebug = sortDroppedCandidateExamples(droppedAssessments);
  const candidateQuality = assessments.map((assessment) =>
    toCandidateQualityDebug(assessment, selectedIds.has(assessment.candidateId))
  );
  const assessmentById = new Map(assessments.map((assessment) => [assessment.candidateId, assessment]));
  const selectedItems = selectedAssessments
    .map((assessment) =>
      attachAssessmentMetadata(assessment.item, assessmentById.get(assessment.candidateId) ?? assessment)
    )
    .slice(0, TARGET_EFFECTIVE_CANDIDATES);

  return {
    items: selectedItems,
    candidateQuality,
    stageResult,
    durationMs: Date.now() - startedAt,
    rerankEnabled,
    rerankUsed: stageResult.succeeded > 0,
    rerankFailedReason,
    rerankCandidatesCount: rerankCandidates.length,
    selectedCandidatesCount: selectedAssessments.length,
    droppedCandidatesCount: droppedAssessments.length,
    refillTriggered,
    refillReason,
    refillQueries,
    refillCandidateCount,
    finalCandidateCount: selectedItems.length,
    roughTierDistribution: buildRoughTierDistribution(assessments),
    finalCandidates: selectedAssessments.map(toFinalCandidateDebug),
    droppedCandidates: droppedForDebug.slice(0, 3).map(toDroppedCandidateDebug)
  };
}

async function searchByQueryPlans(
  queries: DemoSearchQueryPlan[],
  perQueryCount: number
): Promise<{ items: SearchItem[]; results: DemoSearchQueryResultDebug[] }> {
  const items: SearchItem[] = [];
  const results: DemoSearchQueryResultDebug[] = [];

  for (const queryPlan of queries) {
    try {
      const result = await searchService.search(queryPlan.query, perQueryCount);
      const queryItems = result.items
        .slice(0, perQueryCount)
        .map((item) => attachMatchedQuery(item, queryPlan));
      items.push(...queryItems);
      results.push({
        ...queryPlan,
        returnedCount: queryItems.length
      });
    } catch (error) {
      results.push({
        ...queryPlan,
        returnedCount: 0,
        error: formatErrorSummary(error)
      });
    }
  }

  return {
    items,
    results
  };
}

function dedupeSearchItems(items: SearchItem[]): SearchItem[] {
  const groups = new Map<string, SearchItem>();

  for (const item of items) {
    const key = buildDedupeKey(item);
    if (!key) {
      continue;
    }

    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, normalizeMatchedQueryList(item));
      continue;
    }

    groups.set(key, mergeDuplicateSearchItem(existing, item));
  }

  return Array.from(groups.values()).sort(compareDedupeItems);
}

function attachMatchedQuery(item: SearchItem, queryPlan: DemoSearchQueryPlan): SearchItem {
  const matchedQueries = [
    ...(item.matchedQueries ?? []),
    {
      query: queryPlan.query,
      type: queryPlan.type,
      purpose: queryPlan.purpose
    }
  ];

  return {
    ...item,
    matchedQuery: queryPlan.query,
    queryType: queryPlan.type,
    queryPurpose: queryPlan.purpose,
    matchedQueries: uniqueMatchedQueries(matchedQueries)
  };
}

function toCandidateRerankPromptItem(candidate: CandidateAssessment): Record<string, unknown> {
  return {
    candidateId: candidate.candidateId,
    title: truncateText(candidate.title, 90),
    author: truncateText(candidate.author, 40),
    summary: truncateText(candidate.summary, 160),
    contentSnippet: truncateText(candidate.item.text || candidate.item.evidence.text || candidate.title, 320),
    matchedQuery: candidate.matchedQuery,
    queryType: candidate.queryType,
    queryPurpose: candidate.queryPurpose,
    roughScore: candidate.roughScore,
    roughReason: candidate.roughReason
  };
}

function toDemoResponseComposeFinalCandidate(candidate: CleanedCandidate): Record<string, unknown> {
  return {
    candidateId: candidate.candidateId,
    personId: candidate.personId,
    articleId: candidate.articleId,
    title: candidate.title,
    author: candidate.author,
    summary: truncateText(candidate.text, 240),
    contentSnippet: truncateText(candidate.text, 520),
    contentRole: candidate.contentRole,
    relationToUserIntent: candidate.relationToUserIntent,
    summaryAngle: candidate.summaryAngle,
    diversityKey: candidate.diversityKey,
    matchedQuery: candidate.matchedQuery,
    queryType: candidate.queryType,
    keepReason: candidate.keepReason,
    sourceRefs: [candidate.sourceRefId],
    evidenceText: candidate.evidenceText
  };
}

function applyCandidateRerankOutput(
  assessments: CandidateAssessment[],
  output: CandidateRerankOutput
): CandidateAssessment[] {
  const assessmentById = new Map(assessments.map((assessment) => [assessment.candidateId, assessment]));
  const selected: CandidateAssessment[] = [];
  const seen = new Set<string>();

  for (const item of output.selected) {
    const assessment = assessmentById.get(item.candidateId);
    if (!assessment || seen.has(item.candidateId)) {
      continue;
    }

    assessment.relevanceScore = Number((item.relevanceScore / 100).toFixed(2));
    assessment.contentRole = item.contentRole;
    assessment.relationToUserIntent = item.relationToUserIntent;
    assessment.summaryAngle = item.summaryAngle;
    assessment.diversityKey = item.diversityKey;
    assessment.keepReason = item.keepReason;
    selected.push(assessment);
    seen.add(item.candidateId);
  }

  for (const item of output.dropped) {
    const assessment = assessmentById.get(item.candidateId);
    if (assessment) {
      assessment.dropReason = item.dropReason;
    }
  }

  return selected.slice(0, TARGET_EFFECTIVE_CANDIDATES);
}

function markRerankDroppedCandidates(
  rerankCandidates: CandidateAssessment[],
  output: CandidateRerankOutput
): Map<string, string> {
  const selectedIds = new Set(output.selected.map((item) => item.candidateId));
  const explicitDropReasonById = new Map(
    output.dropped.map((item) => [item.candidateId, item.dropReason])
  );
  const dropReasonById = new Map<string, string>();

  for (const candidate of rerankCandidates) {
    if (selectedIds.has(candidate.candidateId)) {
      continue;
    }

    candidate.dropReason =
      explicitDropReasonById.has(candidate.candidateId)
        ? `LLM dropped: ${explicitDropReasonById.get(candidate.candidateId)}`
        : "LLM batch rerank did not keep this candidate for the final diverse set";
    dropReasonById.set(candidate.candidateId, candidate.dropReason);
  }

  return dropReasonById;
}

function restoreDropReasons(
  assessments: CandidateAssessment[],
  dropReasonById: Map<string, string>
): void {
  for (const assessment of assessments) {
    const dropReason = dropReasonById.get(assessment.candidateId);
    if (dropReason) {
      assessment.dropReason = dropReason;
    }
  }
}

function sortDroppedCandidateExamples(candidates: CandidateAssessment[]): CandidateAssessment[] {
  return [...candidates].sort((left, right) => {
    const leftLlm = left.dropReason?.startsWith("LLM") ? 1 : 0;
    const rightLlm = right.dropReason?.startsWith("LLM") ? 1 : 0;
    return rightLlm - leftLlm || left.roughScore - right.roughScore;
  });
}

function buildRefillQueries(
  intent: IntentExpandOutput,
  selectedAssessments: CandidateAssessment[],
  searchQueries: DemoSearchQueryPlan[]
): DemoSearchQueryPlan[] {
  const selectedTypeCounts = selectedAssessments.reduce((counts, assessment) => {
    if (assessment.queryType) {
      counts.set(assessment.queryType, (counts.get(assessment.queryType) ?? 0) + 1);
    }
    return counts;
  }, new Map<DemoSearchQueryType, number>());
  const existingQueries = new Set(searchQueries.map((plan) => normalizeText(plan.query)));
  const lowCoverageExisting = searchQueries
    .filter((plan) => plan.type !== "original" && (selectedTypeCounts.get(plan.type) ?? 0) === 0)
    .slice(0, 3);
  const dynamicPlans = intent.topicSignals
    .slice(0, 4)
    .flatMap((signal, index) => [
      createRefillPlan(`${signal} 真实经历`, "real_experience", "基于 topicSignals 补召回真实经历", index + 2),
      createRefillPlan(`${signal} 失败复盘`, "failure_review", "基于 topicSignals 补召回失败与代价", index + 4),
      createRefillPlan(`${signal} 怎么选`, "decision_conflict", "基于 topicSignals 补召回决策冲突", index + 5)
    ])
    .filter((plan) => {
      const key = normalizeText(plan.query);
      if (existingQueries.has(key)) {
        return false;
      }

      existingQueries.add(key);
      return true;
    });

  return [...lowCoverageExisting, ...dynamicPlans].slice(0, 5);
}

function createRefillPlan(
  query: string,
  type: DemoSearchQueryType,
  purpose: string,
  priority: number
): DemoSearchQueryPlan {
  return {
    query: truncateText(query, 40),
    type,
    purpose,
    priority: Math.min(Math.max(priority, 1), 6)
  };
}

function enforceSelectedDiversity(
  selectedAssessments: CandidateAssessment[],
  assessments: CandidateAssessment[]
): CandidateAssessment[] {
  const selectedTypes = new Set(selectedAssessments.map((assessment) => assessment.queryType).filter(Boolean));
  if (selectedTypes.size !== 1 || selectedAssessments.length < 2) {
    return selectedAssessments;
  }

  const selectedIds = new Set(selectedAssessments.map((assessment) => assessment.candidateId));
  const alternative = assessments
    .filter((assessment) => !selectedIds.has(assessment.candidateId) && assessment.queryType && !selectedTypes.has(assessment.queryType))
    .sort((left, right) => right.roughScore - left.roughScore)[0];
  if (!alternative) {
    return selectedAssessments;
  }

  return [...selectedAssessments.slice(0, -1), alternative];
}

function applyRuleKeepMetadata(candidate: CandidateAssessment, intent: IntentExpandOutput): void {
  const topic = candidate.relevanceSignals?.[0] ?? intent.topicSignals[0] ?? candidate.matchedQuery ?? "当前问题";
  candidate.relationToUserIntent =
    candidate.relationToUserIntent ??
    `这条公开内容与用户问题共同涉及「${topic}」，可作为同类处境或决策变量的参照。`;
  candidate.summaryAngle =
    candidate.summaryAngle ??
    (candidate.narrativeSignals?.length
      ? `提炼这条内容中的${candidate.narrativeSignals.slice(0, 2).join("、")}线索`
      : `提炼围绕「${topic}」的具体信息和可验证边界`);
  candidate.diversityKey =
    candidate.diversityKey ?? candidate.queryType ?? candidate.relevanceSignals?.[0] ?? "public-content";
  candidate.keepReason =
    candidate.keepReason ??
    `规则兜底保留：${candidate.roughReason || candidate.filterReason}`;
}

function toFinalCandidateDebug(candidate: CandidateAssessment): NonNullable<DemoSearchResponse["debug"]["finalCandidates"]>[number] {
  return {
    candidateId: candidate.candidateId,
    title: truncateText(candidate.title, 80),
    author: truncateText(candidate.author, 40),
    matchedQuery: candidate.matchedQuery,
    queryType: candidate.queryType,
    roughScore: candidate.roughScore,
    relevanceScore: Math.round(candidate.relevanceScore * 100),
    contentRole: candidate.contentRole,
    relationToUserIntent: candidate.relationToUserIntent,
    summaryAngle: candidate.summaryAngle,
    diversityKey: candidate.diversityKey,
    keepReason: candidate.keepReason,
    sourceRefs: candidate.sourceRefId ? [candidate.sourceRefId] : []
  };
}

function attachFinalCandidateSourceRefs(
  finalCandidates: NonNullable<DemoSearchResponse["debug"]["finalCandidates"]>,
  candidateQuality: DemoCandidateQuality[] | undefined
): NonNullable<DemoSearchResponse["debug"]["finalCandidates"]> {
  const sourceRefByCandidateId = new Map(
    (candidateQuality ?? [])
      .filter((candidate): candidate is DemoCandidateQuality & { sourceRefId: string } =>
        Boolean(candidate.sourceRefId)
      )
      .map((candidate) => [candidate.candidateId, candidate.sourceRefId])
  );

  return finalCandidates.map((candidate) => ({
    ...candidate,
    sourceRefs:
      candidate.sourceRefs && candidate.sourceRefs.length > 0
        ? candidate.sourceRefs
        : sourceRefByCandidateId.has(candidate.candidateId)
          ? [sourceRefByCandidateId.get(candidate.candidateId)!]
          : []
  }));
}

function toDroppedCandidateDebug(candidate: CandidateAssessment): NonNullable<DemoSearchResponse["debug"]["droppedCandidates"]>[number] {
  return {
    candidateId: candidate.candidateId,
    title: truncateText(candidate.title, 80),
    roughScore: candidate.roughScore,
    dropReason: candidate.dropReason ?? candidate.filterReason
  };
}

function buildDedupeKey(item: SearchItem): string {
  const stableId = item.id && !item.id.startsWith("zhihu_item_") ? item.id : "";
  if (stableId) {
    return `id:${stableId}`;
  }

  if (item.url) {
    return `url:${item.url}`;
  }

  const normalizedTitle = normalizeTitle(item.title);
  if (normalizedTitle) {
    return `title:${normalizedTitle}`;
  }

  const author = normalizeText(item.author.name);
  return normalizedTitle || author ? `title_author:${normalizedTitle}:${author}` : "";
}

function normalizeMatchedQueryList(item: SearchItem): SearchItem {
  return {
    ...item,
    matchedQueries: uniqueMatchedQueries(item.matchedQueries ?? [])
  };
}

function mergeDuplicateSearchItem(existing: SearchItem, incoming: SearchItem): SearchItem {
  const preferred = compareDedupeItems(existing, incoming) <= 0 ? existing : incoming;
  const secondary = preferred === existing ? incoming : existing;
  const matchedQueries = uniqueMatchedQueries([
    ...(existing.matchedQueries ?? []),
    ...(incoming.matchedQueries ?? [])
  ]);

  return {
    ...preferred,
    text: preferred.text || secondary.text,
    evidence: preferred.evidence.text ? preferred.evidence : secondary.evidence,
    author: preferred.author.name ? preferred.author : secondary.author,
    matchedQuery: matchedQueries[0]?.query ?? preferred.matchedQuery,
    queryType: matchedQueries[0]?.type ?? preferred.queryType,
    queryPurpose: matchedQueries[0]?.purpose ?? preferred.queryPurpose,
    matchedQueries
  };
}

function compareDedupeItems(left: SearchItem, right: SearchItem): number {
  const leftScore = dedupePreferenceScore(left);
  const rightScore = dedupePreferenceScore(right);
  return rightScore - leftScore;
}

function dedupePreferenceScore(item: SearchItem): number {
  return (
    (item.matchedQueries?.length ?? (item.matchedQuery ? 1 : 0)) * 30 +
    normalizeText(item.text || item.evidence.text).length +
    (item.url ? 20 : 0) +
    (item.author.name ? 10 : 0) +
    Math.min(item.stats.voteUpCount, 100)
  );
}

function uniqueMatchedQueries(
  values: Array<{ query?: string; type?: string; purpose?: string }>
): NonNullable<SearchItem["matchedQueries"]> {
  const seen = new Set<string>();
  const result: NonNullable<SearchItem["matchedQueries"]> = [];

  for (const value of values) {
    const query = normalizeText(value.query ?? "");
    if (!query) {
      continue;
    }

    const key = query.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push({
      query,
      type: value.type,
      purpose: value.purpose
    });
  }

  return result;
}

function normalizeTitle(title: string): string {
  return normalizeText(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\u4e00-\u9fa5]+/gu, "");
}

function buildCleanedCandidatesFromResponse(response: DemoSearchResponse): CleanedCandidate[] {
  const candidates: CleanedCandidate[] = [];
  const seen = new Set<string>();
  const qualityBySourceRefId = new Map(
    (response.debug.candidateQuality ?? [])
      .filter((item): item is DemoCandidateQuality & { sourceRefId: string } =>
        Boolean(item.sourceRefId)
      )
      .map((item) => [item.sourceRefId, item])
  );

  for (const person of response.people) {
    for (const article of person.articles) {
      const sourceRefId = article.sourceRefs[0] || person.sourceRefs[0];
      if (!sourceRefId || seen.has(sourceRefId)) {
        continue;
      }

      const sourceRef = response.meta.sourceRefs.find((item) => item.id === sourceRefId);
      const quality = qualityBySourceRefId.get(sourceRefId);
      const text = truncateText(article.text || article.summary || article.title, 850);
      const evidenceText = truncateText(
        article.evidence.map((item) => item.text).join("\n") || text,
        260
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
        sampleType: person.sampleType ?? "content_sample",
        relevanceScore: quality?.relevanceScore ?? person.match.contentRelevance,
        qualityScore: quality?.qualityScore ?? person.match.evidenceQuality,
        experienceSignalScore: quality?.experienceSignalScore ?? person.match.experienceSimilarity,
        contentLength: quality?.contentLength ?? normalizeText(text).length,
        filterReason: quality?.filterReason ?? "used_as_core_evidence: selected by response composer",
        matchedQuery: quality?.matchedQuery,
        queryType: quality?.queryType,
        queryPurpose: quality?.queryPurpose,
        contentRole: quality?.contentRole,
        relationToUserIntent: quality?.relationToUserIntent,
        summaryAngle: quality?.summaryAngle,
        diversityKey: quality?.diversityKey,
        keepReason: quality?.keepReason
      });
    }
  }

  return candidates.slice(0, MAX_REAL_ITEMS);
}

function buildExperienceSummaryCandidates(
  query: string,
  response: DemoSearchResponse
): ExperienceSummaryCandidate[] {
  const qualityBySourceRefId = new Map(
    (response.debug.candidateQuality ?? [])
      .filter((item): item is DemoCandidateQuality & { sourceRefId: string } =>
        Boolean(item.sourceRefId)
      )
      .map((item) => [item.sourceRefId, item])
  );
  const result: ExperienceSummaryCandidate[] = [];

  for (const person of response.people.slice(0, MAX_EXPERIENCE_SUMMARY_PEOPLE)) {
    const article = person.articles[0];
    const sourceRefId = article?.sourceRefs[0] || person.sourceRefs[0] || "";
    const quality = qualityBySourceRefId.get(sourceRefId);
    const content = normalizeText(article?.text || article?.summary || article?.title || "");
    const contentLength = quality?.contentLength ?? content.length;
    const qualityScore = quality?.qualityScore ?? person.match.evidenceQuality;
    const experienceSignalScore = quality?.experienceSignalScore ?? person.match.experienceSimilarity;
    const fallbackSummary = buildExperienceFallbackSummary(person);

    if (
      !article ||
      !sourceRefId ||
      contentLength < EXPERIENCE_SUMMARY_MIN_CONTENT_LENGTH ||
      (qualityScore < EXPERIENCE_SUMMARY_MIN_QUALITY_SCORE &&
        experienceSignalScore < EXPERIENCE_SUMMARY_MIN_EXPERIENCE_SIGNAL_SCORE)
    ) {
      result.push({
        personId: person.id,
        candidateId: quality?.candidateId ?? article?.id ?? person.id,
        articleId: article?.id ?? "",
        sourceRefId,
        title: article?.title ?? "",
        content,
        summary: article?.summary ?? "",
        evidence:
          article?.evidence.map((evidence) => ({
            id: evidence.id,
            label: evidence.label,
            text: evidence.text
          })) ?? [],
        candidateQuality: {
          relevanceScore: quality?.relevanceScore ?? person.match.contentRelevance,
          qualityScore,
          experienceSignalScore,
          contentLength,
          filterReason:
            quality?.filterReason ?? "experienceSummary fallback quality derived from person.match"
        },
        contentHash: hashString(`${article?.title ?? ""}\n${content}\n${fallbackSummary}`),
        fallbackSummary,
        matchedQuery: quality?.matchedQuery,
        queryType: quality?.queryType,
        queryPurpose: quality?.queryPurpose
      });
      continue;
    }

    result.push({
      personId: person.id,
      candidateId: quality?.candidateId ?? article.id,
      articleId: article.id,
      sourceRefId,
      title: article.title,
      content,
      summary: article.summary,
      evidence: article.evidence.map((evidence) => ({
        id: evidence.id,
        label: evidence.label,
        text: evidence.text
      })),
      candidateQuality: {
        relevanceScore: quality?.relevanceScore ?? person.match.contentRelevance,
        qualityScore,
        experienceSignalScore,
        contentLength,
        filterReason: quality?.filterReason ?? "experienceSummary candidate selected from person.match"
      },
      contentHash: hashString(
        JSON.stringify({
          query: truncateText(query, 120),
          title: article.title,
          content,
          summary: article.summary,
          evidence: article.evidence.map((evidence) => evidence.text),
          qualityScore,
          experienceSignalScore
        })
      ),
      fallbackSummary,
      matchedQuery: quality?.matchedQuery,
      queryType: quality?.queryType,
      queryPurpose: quality?.queryPurpose
    });
  }

  return result.filter(isHighQualityExperienceSummaryCandidate);
}

function isHighQualityExperienceSummaryCandidate(candidate: ExperienceSummaryCandidate): boolean {
  return Boolean(
    candidate.articleId &&
      candidate.sourceRefId &&
      candidate.content.length >= EXPERIENCE_SUMMARY_MIN_CONTENT_LENGTH &&
      (candidate.candidateQuality.qualityScore >= EXPERIENCE_SUMMARY_MIN_QUALITY_SCORE ||
        candidate.candidateQuality.experienceSignalScore >=
          EXPERIENCE_SUMMARY_MIN_EXPERIENCE_SIGNAL_SCORE)
  );
}

function initializeExperienceSummaryDebug(
  response: DemoSearchResponse,
  candidates: ExperienceSummaryCandidate[]
): DemoExperienceSummaryDebug[] {
  const candidateIds = new Set(candidates.map((candidate) => candidate.personId));
  return response.people.slice(0, MAX_EXPERIENCE_SUMMARY_PEOPLE).map((person) => ({
    personId: person.id,
    status: candidateIds.has(person.id) ? "pending" : "failed",
    source: "none",
    reason: candidateIds.has(person.id)
      ? "waiting for LLM experienceSummary batch"
      : "content or candidate quality was insufficient for LLM experienceSummary",
    cacheHit: false,
    fallbackSummary: buildExperienceFallbackSummary(person)
  }));
}

function markExperienceSummaryDebug(
  debug: DemoExperienceSummaryDebug[],
  personId: string,
  updates: Omit<Partial<DemoExperienceSummaryDebug>, "personId" | "fallbackSummary">
): void {
  const entry = debug.find((item) => item.personId === personId);
  if (!entry) {
    return;
  }

  Object.assign(entry, updates);
}

function toExperienceSummaryPromptCandidate(
  candidate: ExperienceSummaryCandidate
): Record<string, unknown> {
  return {
    personId: candidate.personId,
    candidateId: candidate.candidateId,
    articleId: candidate.articleId,
    sourceRefId: candidate.sourceRefId,
    title: truncateText(candidate.title, 100),
    content: truncateText(candidate.content, 900),
    summary: truncateText(candidate.summary, 240),
    evidence: candidate.evidence.map((evidence) => ({
      id: evidence.id,
      label: evidence.label,
      text: truncateText(evidence.text, 180)
    })),
    candidateQuality: candidate.candidateQuality,
    matchedQuery: candidate.matchedQuery,
    queryType: candidate.queryType,
    queryPurpose: candidate.queryPurpose
  };
}

function filterAndCacheExperienceSummaries(
  query: string,
  output: ExperienceSummaryOutput,
  candidates: ExperienceSummaryCandidate[],
  debug: DemoExperienceSummaryDebug[]
): ExperienceSummaryOutput["summaries"] {
  const candidateByPersonId = new Map(candidates.map((candidate) => [candidate.personId, candidate]));
  const accepted: ExperienceSummaryOutput["summaries"] = [];

  for (const item of output.summaries) {
    const candidate = candidateByPersonId.get(item.personId);
    if (!candidate) {
      continue;
    }

    if (!item.experienceSummary || !isSafeExperienceSummary(item.experienceSummary)) {
      markExperienceSummaryDebug(debug, item.personId, {
        status: "failed",
        source: "none",
        reason: item.reason || "LLM experienceSummary was empty or advice-style",
        cacheHit: false
      });
      continue;
    }

    const cacheKey = buildExperienceSummaryCacheKey(query, candidate);
    experienceSummaryCache.set(cacheKey, {
      expiresAt: Date.now() + EXPERIENCE_SUMMARY_CACHE_TTL_MS,
      summary: item.experienceSummary,
      confidence: item.confidence,
      reason: item.reason
    });
    markExperienceSummaryDebug(debug, item.personId, {
      status: "ready",
      source: "llm",
      reason: item.reason || "LLM generated a grounded experienceSummary",
      cacheHit: false
    });
    accepted.push(item);
  }

  const acceptedIds = new Set(accepted.map((item) => item.personId));
  for (const candidate of candidates) {
    if (!acceptedIds.has(candidate.personId)) {
      markExperienceSummaryDebug(debug, candidate.personId, {
        status: "failed",
        source: "none",
        reason: "LLM did not return an acceptable experienceSummary for this person",
        cacheHit: false
      });
    }
  }

  return accepted;
}

function buildExperienceSummaryCacheKey(
  query: string,
  candidate: ExperienceSummaryCandidate
): string {
  return [
    "experience_summary_v1",
    `q=${normalizeText(query).toLowerCase()}`,
    `person=${candidate.personId}`,
    `candidate=${candidate.candidateId}`,
    `content=${candidate.contentHash}`
  ].join("|");
}

function pruneExpiredExperienceSummaryCache(): void {
  const now = Date.now();
  for (const [cacheKey, entry] of experienceSummaryCache) {
    if (entry.expiresAt <= now) {
      experienceSummaryCache.delete(cacheKey);
    }
  }
}

function buildExperienceFallbackSummary(person: DemoPerson): string {
  const article = person.articles[0];
  return truncateText(
    [person.oneLine, person.lesson, article?.summary, article?.evidence.map((item) => item.text).join(" ")]
      .filter(Boolean)
      .join(" "),
    220
  );
}

function createFallbackIntent(query: string): IntentExpandOutput {
  const intentTags = inferIntentTags(query);
  const userNeedSummary = `用户正在探索「${truncateText(query, 40)}」相关的公开经验与可行路径。`;
  const searchQueries = buildFallbackSearchQueryPlan(query);
  const dynamicTopicSignals = buildDynamicTopicSignals({
    originalQuery: query,
    userCoreQuestion: userNeedSummary,
    focusTags: intentTags,
    searchQueries
  });
  const topicSignals = unique([
    ...dynamicTopicSignals,
    ...intentTags,
    ...inferFallbackIntentTagSeeds(query),
    "公开经验",
    "可行路径",
    "代价边界",
    "下一步"
  ]).slice(0, 8);

  return {
    intent: "life_path_exploration",
    userCoreQuestion: userNeedSummary,
    focusTags: intentTags,
    topicSignals,
    searchQueries,
    intentTags,
    userNeedSummary
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

function applyExperienceSummaryOutput(
  response: DemoSearchResponse,
  output: ExperienceSummaryStageOutput
): void {
  const summaryByPersonId = new Map(output.summaries.summaries.map((item) => [item.personId, item]));

  for (const person of response.people) {
    const item = summaryByPersonId.get(person.id);
    if (!item?.experienceSummary) {
      const debug = output.debug.find((entry) => entry.personId === person.id);
      if (debug?.status === "failed") {
        person.experienceSummary = null;
        person.experienceSummarySource = "none";
        person.experienceSummaryStatus = "failed";
        delete person.experienceSummaryConfidence;
      }
      continue;
    }

    person.experienceSummary = item.experienceSummary;
    person.experienceSummarySource = "llm";
    person.experienceSummaryStatus = "ready";
    person.experienceSummaryConfidence = item.confidence;
  }
}

function applyDemoResponseComposeOutput(
  response: DemoSearchResponse,
  output: DemoResponseComposeOutput,
  guardWarnings: string[]
): ComposeApplyStats {
  const stats: ComposeApplyStats = {
    focusTagCount: 0,
    pathCount: 0,
    peopleCount: 0,
    personaCount: 0
  };

  if (output.analysis?.summary && isSafeText(output.analysis.summary)) {
    response.analysis.summary = output.analysis.summary;
  }

  if (output.analysis?.focusTags?.length) {
    response.analysis.focusTags = output.analysis.focusTags.filter(isSafeText).slice(0, 8);
    stats.focusTagCount = response.analysis.focusTags.length;
  }

  const pathById = new Map(response.paths.map((path) => [path.id, path]));
  for (const item of output.paths) {
    const path = pathById.get(item.id);
    if (
      !path ||
      !areSafeTexts([
        item.title,
        item.summary,
        item.whyRelevant ?? "",
        item.tradeoff ?? "",
        item.fitReason ?? "",
        item.diversityKey ?? ""
      ]) ||
      !isExperiencePathTitle(item.title)
    ) {
      guardWarnings.push(`demo_response_compose path skipped: ${item.id}`);
      continue;
    }

    path.title = item.title;
    path.summary = item.summary;
    if (item.whyRelevant && isSafeFitReason(item.whyRelevant)) path.whyRelevant = item.whyRelevant;
    if (item.tradeoff && isSafeText(item.tradeoff)) path.tradeoff = item.tradeoff;
    if (item.fitReason && isSafeFitReason(item.fitReason)) path.fitReason = item.fitReason;
    if (item.diversityKey && isSafeText(item.diversityKey)) path.diversityKey = item.diversityKey;
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
      item.fitReason,
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
    if (item.fitReason && isSafeFitReason(item.fitReason)) person.fitReason = item.fitReason;
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

    const textValues = [item.openingLine, item.fitReason, ...(item.suggestedQuestions ?? [])].filter(
      (value): value is string => Boolean(value)
    );
    if (!areSafeTexts(textValues)) {
      guardWarnings.push(`demo_response_compose unsafe persona text skipped: ${item.personId}`);
      continue;
    }

    if (typeof item.enabled === "boolean") person.aiPersona.enabled = item.enabled;
    const persona = response.personas.find((candidate) => candidate.personId === item.personId);
    if (persona && item.fitReason && isSafeFitReason(item.fitReason)) {
      persona.fitReason = item.fitReason;
      person.fitReason = person.fitReason ?? item.fitReason;
    }
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
  if (!output.valid) {
    const warning =
      output.warnings[0] ??
      "grounding_guard invalid: valid=false; all personas disabled by conservative rule fallback";
    guardWarnings.push(warning);
    for (const person of response.people) {
      disablePersona(person, "grounding guard returned valid=false");
    }
    return;
  }

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
    fitReason: person.fitReason,
    boundaryNotice: DEMO_PERSONA_BOUNDARY_NOTICE,
    sourceRefs: person.sourceRefs,
    suggestedQuestions: person.aiPersona.suggestedQuestions
  };
}

function toDemoComposeContext(response: DemoSearchResponse): Record<string, unknown> {
  return {
    analysis: response.analysis,
    paths: response.paths.map((path) => ({
      id: path.id,
      title: path.title,
      summary: path.summary,
      whyRelevant: path.whyRelevant,
      tradeoff: path.tradeoff,
      fitReason: path.fitReason,
      diversityKey: path.diversityKey,
      stance: path.stance,
      personRefs: path.personRefs,
      sourceRefs: path.sourceRefs,
      evidenceIds: path.evidenceIds
    })),
    people: response.people.map((person) => ({
      id: person.id,
      name: person.name,
      sampleType: person.sampleType,
      pathId: person.pathId,
      role: person.role,
      roleLabel: person.roleLabel,
      badge: person.badge,
      oneLine: person.oneLine,
      matchedPathTitle: person.matchedPathTitle,
      relevanceReason: person.relevanceReason,
      fitReason: person.fitReason,
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
      whyRelevant: path.whyRelevant,
      tradeoff: path.tradeoff,
      diversityKey: path.diversityKey,
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

function createInvalidGroundingGuardStage(output: GroundingGuardOutput): DemoDebugLlmStageResult {
  return {
    stage: "grounding_guard",
    attempted: 1,
    succeeded: 0,
    failed: 1,
    repairUsed: 0,
    repairFailed: 0,
    fallbackReasons: [
      output.warnings[0] ??
        "grounding_guard returned valid=false; conservative persona disable fallback applied"
    ]
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

function summarizeLlmFallback(stageResults: DemoDebugLlmStageResult[]): LlmFallbackSummary {
  const skippedStages = stageResults.filter((result) => result.attempted === 0);
  const failedStages = stageResults.filter((result) => result.failed > 0);
  const successfulStages = stageResults.filter((result) => result.succeeded > 0);

  if (skippedStages.length === 0 && failedStages.length === 0) {
    return {
      used: false,
      kind: "",
      reason: ""
    };
  }

  const details = summarizeFallbackDetails([...skippedStages, ...failedStages]);
  if (successfulStages.length === 0 && failedStages.length === 0) {
    return {
      used: true,
      kind: "no_llm_config",
      reason: `no_llm_config: rules used because no LLM stage was configured. ${details}`.trim()
    };
  }

  if (successfulStages.length === 0) {
    return {
      used: true,
      kind: "all_llm_failed",
      reason: `all_llm_failed: rules used because configured LLM stages failed. ${details}`.trim()
    };
  }

  return {
    used: true,
    kind: "partial_llm_fallback",
    reason: `partial_llm_fallback: rules used for skipped or failed LLM stages. ${details}`.trim()
  };
}

function summarizeFallbackDetails(stageResults: DemoDebugLlmStageResult[]): string {
  const details = stageResults
    .flatMap((result) =>
      (result.fallbackReasons.length > 0 ? result.fallbackReasons : ["fallback"]).map(
        (reason) => `${result.stage}: ${reason}`
      )
    )
    .slice(0, 4)
    .join("; ");

  return details ? `details=${details}` : "";
}

function buildIntentStageDebug(
  intentStageResult: DemoDebugLlmStageResult,
  composeStageResult: DemoDebugLlmStageResult,
  focusTagsUpdatedByLlm: boolean
): DemoDebugIntentStage {
  const intentExpandLlmUsed = intentStageResult.succeeded > 0;
  const focusTagsLlmUsed = focusTagsUpdatedByLlm && composeStageResult.succeeded > 0;
  const llmUsed = intentExpandLlmUsed || focusTagsLlmUsed;
  const mode: DemoDebugIntentStage["mode"] = llmUsed ? "hybrid" : "fallback";

  return {
    mode,
    llmUsed,
    provider: llmRouter.getProviderForTask("intent_expand"),
    model: llmRouter.getModelForTask("intent_expand"),
    fallbackReason: summarizeIntentStageReason(
      intentStageResult,
      composeStageResult,
      intentExpandLlmUsed,
      focusTagsLlmUsed
    ),
    intentSource: "rule",
    focusTagsSource: focusTagsLlmUsed ? "llm" : "rule"
  };
}

function summarizeIntentStageReason(
  intentStageResult: DemoDebugLlmStageResult,
  composeStageResult: DemoDebugLlmStageResult,
  intentExpandLlmUsed: boolean,
  focusTagsLlmUsed: boolean
): string {
  const fallbackStages = [intentStageResult, composeStageResult].filter(
    (result) => result.attempted === 0 || result.failed > 0
  );
  const fallbackDetails = summarizeFallbackDetails(fallbackStages);

  if (intentExpandLlmUsed && focusTagsLlmUsed) {
    return "intent_expand LLM planned search queries and demo_response_compose LLM updated focusTags; analysis.intent remains rule-generated";
  }

  if (intentExpandLlmUsed) {
    return [
      "intent_expand LLM planned search queries; analysis.intent and focusTags remain rule-generated",
      fallbackDetails
    ]
      .filter(Boolean)
      .join(". ");
  }

  if (focusTagsLlmUsed) {
    return [
      "demo_response_compose LLM updated focusTags; analysis.intent remains rule-generated",
      fallbackDetails
    ]
      .filter(Boolean)
      .join(". ");
  }

  return [
    "deterministic rule analysis used for analysis.intent and focusTags",
    fallbackDetails
  ]
    .filter(Boolean)
    .join(". ");
}

function inferIntentTags(query: string): string[] {
  const tags = unique([
    ...buildDynamicTopicSignals({
      originalQuery: query
    }),
    ...inferFallbackIntentTagSeeds(query)
  ]).slice(0, 6);

  return tags.length > 0 ? tags : ["公开经验", "可行路径", "代价边界", "下一步"];
}

function inferFallbackIntentTagSeeds(query: string): string[] {
  const normalized = normalizeText(query);
  const seeds: string[] = [];
  const rules: Array<[string[], string[]]> = [
    [["不工作", "不上班", "裸辞", "失业", "待业"], ["暂停工作", "现金流", "生活节奏", "回流接口"]],
    [["35岁", "三十五", "裸辞", "转行"], ["年龄压力", "职业回流", "收入波动", "履历解释"]],
    [["北京", "老家", "大城市", "回家"], ["城市去留", "生活成本", "机会密度", "家庭关系"]],
    [["读研", "研究生", "考研"], ["读研卡点", "导师课题", "就业接口", "退场成本"]],
    [["父母", "家人", "不同意", "反对"], ["家庭沟通", "经济独立", "边界成本", "后果承担"]],
    [["朋友", "断联", "消耗"], ["关系消耗", "边界表达", "情绪空间", "失去成本"]]
  ];

  for (const [keywords, values] of rules) {
    if (keywords.some((keyword) => normalized.includes(keyword))) {
      seeds.push(...values);
    }
  }

  return seeds;
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

function isSafeFitReason(value: string): boolean {
  const overclaimFragments = [
    "一定适合",
    "绝对适合",
    "最适合",
    "完美匹配",
    "唯一答案",
    "保证",
    "必然",
    "注定"
  ];

  return isSafeText(value) && !overclaimFragments.some((fragment) => value.includes(fragment));
}

function isSafeExperienceSummary(value: string): boolean {
  const adviceFragments = [
    "你应该",
    "建议先",
    "建议你",
    "可以考虑",
    "你可以先",
    "你可以",
    "应该先",
    "最好先",
    "需要先"
  ];
  const experienceMarkers = ["这个样本", "这段经历", "作者", "TA", "ta"];

  return (
    isSafeText(value) &&
    experienceMarkers.some((marker) => value.includes(marker)) &&
    !adviceFragments.some((fragment) => value.includes(fragment))
  );
}

function isExperiencePathTitle(value: string): boolean {
  const adviceTitleFragments = [
    "比较工作机会",
    "确认目标岗位",
    "评估生活",
    "先拆清",
    "给异地设",
    "保留回流",
    "留一个可回撤",
    "把现金流",
    "目标岗位缺口",
    "可回撤方案"
  ];

  return (
    (value.includes("有人") || value.includes("有些人")) &&
    !adviceTitleFragments.some((fragment) => value.includes(fragment))
  );
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

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16);
}
