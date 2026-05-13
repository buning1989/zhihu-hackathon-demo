import { DEMO_COMPOSER_SYSTEM_PROMPT } from "../prompts/demoComposerPrompt.js";
import { llmClient } from "../providers/llm/openaiCompatible.client.js";
import {
  DEMO_PERSONA_BOUNDARY_NOTICE,
  type DemoDataMode,
  type DemoDebugLlmStageResult,
  type DemoPath,
  type DemoPerson,
  type DemoSearchResponse
} from "../types/demo.types.js";
import type { SearchItem } from "../types/api.types.js";

interface ComposeLlmDemoInput {
  query: string;
  count: number;
  dataMode: DemoDataMode;
  items: SearchItem[];
  startedAt: number;
  deterministicResponse: DemoSearchResponse;
}

interface RepairInput {
  stage: LlmStageName;
  invalidJson: string;
  parseError: string;
  allowedIds: Record<string, unknown>;
}

interface ParseResult {
  output: Record<string, unknown>;
  repairUsed: boolean;
  repairFailed: boolean;
}

type LlmStageName = "path_enhancer" | "people_enhancer" | "persona_enhancer";

interface StageCounters {
  attempted: number;
  succeeded: number;
  failed: number;
  repairUsed: number;
  repairFailed: number;
  fallbackReasons: string[];
}

export class DemoComposerLlmError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly guardWarnings: string[] = [],
    public readonly llmRepairUsed = false,
    public readonly llmRepairFailed = false,
    public readonly llmStageResults: DemoDebugLlmStageResult[] = []
  ) {
    super(message);
    this.name = "DemoComposerLlmError";
  }
}

export async function composeLlmDemoSearchResponse(
  input: ComposeLlmDemoInput
): Promise<DemoSearchResponse> {
  const response = cloneDemoSearchResponse(input.deterministicResponse);
  const stageResults: DemoDebugLlmStageResult[] = [];
  const guardWarnings: string[] = [];

  const pathResult = await enhancePaths(response.paths, input.query, guardWarnings);
  stageResults.push(pathResult.stageResult);

  const peopleResult = await enhancePeople(response.people, input.query, guardWarnings);
  stageResults.push(peopleResult.stageResult);

  const personaResult = await enhancePersonas(response.people, input.query, guardWarnings);
  stageResults.push(personaResult.stageResult);

  syncTopLevelPersonas(response);

  const enhancedPathCount = pathResult.stageResult.succeeded;
  const enhancedPeopleIds = new Set([...peopleResult.enhancedPersonIds, ...personaResult.enhancedPersonIds]);
  const enhancedPeopleCount = enhancedPeopleIds.size;
  const totalSucceeded = enhancedPathCount + peopleResult.stageResult.succeeded + personaResult.stageResult.succeeded;
  const totalFailed = stageResults.reduce((total, item) => total + item.failed, 0);
  const repairUsed = stageResults.some((item) => item.repairUsed > 0);
  const repairFailed = stageResults.some((item) => item.repairFailed > 0);

  response.meta.latencyMs = Date.now() - input.startedAt;
  response.meta.fallbackUsed = totalSucceeded === 0;
  response.debug = {
    ...response.debug,
    composer: totalSucceeded > 0 ? "real_llm_composer" : "real_rule_composer",
    requestedDataMode: input.dataMode,
    resolvedDataMode: input.dataMode,
    itemCount: response.people.length,
    sourceItemCount: input.items.length,
    pathCount: response.paths.length,
    peopleCount: response.people.length,
    personaCount: response.personas.length,
    llmUsed: true,
    llmComposerUsed: totalSucceeded > 0,
    llmRepairUsed: repairUsed,
    llmRepairFailed: repairFailed,
    fallbackUsed: totalSucceeded === 0,
    fallbackReason:
      totalSucceeded === 0
        ? summarizeStageFailures(stageResults) || "all LLM enhancer stages failed"
        : "",
    guardWarnings,
    llmStageResults: stageResults,
    enhancedPeopleCount,
    enhancedPathCount,
    partialFallbackUsed: totalFailed > 0 && totalSucceeded > 0,
    notes:
      totalSucceeded > 0
        ? ["deterministic real composer preserved; LLM enhanced selected fields only"]
        : ["all LLM enhancer stages failed; deterministic real composer preserved"]
  };

  return response;
}

async function enhancePaths(
  paths: DemoPath[],
  query: string,
  guardWarnings: string[]
): Promise<{
  stageResult: DemoDebugLlmStageResult;
}> {
  const counters = createStageCounters(paths.length);

  try {
    const parsed = await runJsonStage({
      stage: "path_enhancer",
      maxTokens: 1200,
      allowedIds: {
        pathIds: paths.map((path) => path.id),
        sourceRefs: unique(paths.flatMap((path) => path.sourceRefs)),
        evidenceIds: unique(paths.flatMap((path) => path.evidenceIds))
      },
      userContent: [
        "增强以下 paths。只允许改 title、summary、stance。",
        "不得删除、合并、重排 path；不得改 personRefs/evidenceIds/sourceRefs。",
        "",
        JSON.stringify({
          query,
          paths: paths.map((path) => ({
            id: path.id,
            title: path.title,
            summary: path.summary,
            stance: path.stance,
            personRefs: path.personRefs ?? [],
            evidenceIds: path.evidenceIds,
            sourceRefs: path.sourceRefs
          }))
        })
      ].join("\n")
    });
    counters.repairUsed += parsed.repairUsed ? 1 : 0;
    counters.repairFailed += parsed.repairFailed ? 1 : 0;

    const records = readArray(parsed.output.paths);
    const pathById = new Map(paths.map((path) => [path.id, path]));
    for (const record of records) {
      const id = readString(record.id);
      const path = pathById.get(id);
      if (!path) {
        counters.failed += 1;
        const reason = `path_enhancer referenced unknown path: ${id || "(missing)"}`;
        counters.fallbackReasons.push(reason);
        guardWarnings.push(reason);
        continue;
      }

      try {
        const title = readRequiredString(record.title, `paths[${id}].title`);
        const summary = readRequiredString(record.summary, `paths[${id}].summary`);
        const stance = readStance(record.stance, `paths[${id}].stance`);
        assertNoForbiddenClaims([title, summary], `paths[${id}]`);

        path.title = title;
        path.summary = summary;
        path.stance = stance;
        counters.succeeded += 1;
      } catch (error) {
        counters.failed += 1;
        counters.fallbackReasons.push(toErrorMessage(error));
        guardWarnings.push(toErrorMessage(error));
      }
    }
  } catch (error) {
    counters.failed = counters.attempted;
    counters.fallbackReasons.push(formatStageError(error));
    carryRepairFlags(error, counters);
  }

  return {
    stageResult: toStageResult("path_enhancer", counters)
  };
}

async function enhancePeople(
  people: DemoPerson[],
  query: string,
  guardWarnings: string[]
): Promise<{
  enhancedPersonIds: string[];
  stageResult: DemoDebugLlmStageResult;
}> {
  const counters = createStageCounters(people.length);
  const enhancedPersonIds: string[] = [];

  try {
    const parsed = await runJsonStage({
      stage: "people_enhancer",
      maxTokens: 3000,
      allowedIds: {
        personIds: people.map((person) => person.id),
        sourceRefs: unique(people.flatMap((person) => person.sourceRefs)),
        evidenceIds: unique(people.flatMap((person) => person.evidenceIds))
      },
      userContent: [
        "增强以下 people。只允许改 oneLine、overlaps、lesson、matchReasons。",
        "不得删除、合并、重排 person；不得改 sourceRefs/evidenceIds/pathId/articles。",
        "",
        JSON.stringify({
          query,
          people: people.map(toPeopleEnhancerContext)
        })
      ].join("\n")
    });
    counters.repairUsed += parsed.repairUsed ? 1 : 0;
    counters.repairFailed += parsed.repairFailed ? 1 : 0;

    const records = readArray(parsed.output.people);
    const personById = new Map(people.map((person) => [person.id, person]));
    for (const record of records) {
      const id = readString(record.id);
      const person = personById.get(id);
      if (!person) {
        counters.failed += 1;
        const reason = `people_enhancer referenced unknown person: ${id || "(missing)"}`;
        counters.fallbackReasons.push(reason);
        guardWarnings.push(reason);
        continue;
      }

      try {
        const oneLine = readRequiredString(record.oneLine, `people[${id}].oneLine`);
        const overlaps = readStringArray(record.overlaps).slice(0, 3);
        const lesson = readRequiredString(record.lesson, `people[${id}].lesson`);
        const matchReasons = readStringArray(record.matchReasons).slice(0, 3);

        if (overlaps.length === 0 || matchReasons.length === 0) {
          throw new DemoComposerLlmError(
            "LLM_SCHEMA_INVALID",
            `people[${id}] enhancer must include overlaps and matchReasons`
          );
        }

        assertNoForbiddenClaims([oneLine, lesson, ...overlaps, ...matchReasons], `people[${id}]`);

        person.oneLine = oneLine;
        person.overlaps = overlaps;
        person.lesson = lesson;
        person.match.reasons = matchReasons;
        counters.succeeded += 1;
        enhancedPersonIds.push(id);
      } catch (error) {
        counters.failed += 1;
        counters.fallbackReasons.push(toErrorMessage(error));
        guardWarnings.push(toErrorMessage(error));
      }
    }
  } catch (error) {
    counters.failed = counters.attempted;
    counters.fallbackReasons.push(formatStageError(error));
    carryRepairFlags(error, counters);
  }

  return {
    enhancedPersonIds,
    stageResult: toStageResult("people_enhancer", counters)
  };
}

async function enhancePersonas(
  people: DemoPerson[],
  query: string,
  guardWarnings: string[]
): Promise<{
  enhancedPersonIds: string[];
  stageResult: DemoDebugLlmStageResult;
}> {
  const counters = createStageCounters(people.length);
  const enhancedPersonIds: string[] = [];

  try {
    const parsed = await runJsonStage({
      stage: "persona_enhancer",
      maxTokens: 2600,
      allowedIds: {
        personIds: people.map((person) => person.id),
        articleIds: unique(people.flatMap((person) => person.articles.map((article) => article.id))),
        sourceRefs: unique(people.flatMap((person) => person.sourceRefs))
      },
      userContent: [
        "增强以下 personas。只允许改 enabled、openingLine、suggestedQuestions。",
        "不得改 personaId、displayName、boundary、grounding、articleIds、sourceRefs。",
        "",
        JSON.stringify({
          query,
          boundaryNotice: DEMO_PERSONA_BOUNDARY_NOTICE,
          people: people.map(toPersonaEnhancerContext)
        })
      ].join("\n")
    });
    counters.repairUsed += parsed.repairUsed ? 1 : 0;
    counters.repairFailed += parsed.repairFailed ? 1 : 0;

    const records = readArray(parsed.output.personas);
    const personById = new Map(people.map((person) => [person.id, person]));
    for (const record of records) {
      const personId = readString(record.personId);
      const person = personById.get(personId);
      if (!person) {
        counters.failed += 1;
        const reason = `persona_enhancer referenced unknown person: ${personId || "(missing)"}`;
        counters.fallbackReasons.push(reason);
        guardWarnings.push(reason);
        continue;
      }

      try {
        const openingLine = readRequiredString(
          record.openingLine,
          `personas[${personId}].openingLine`
        );
        const suggestedQuestions = readStringArray(record.suggestedQuestions).slice(0, 3);
        if (suggestedQuestions.length === 0) {
          throw new DemoComposerLlmError(
            "LLM_SCHEMA_INVALID",
            `personas[${personId}] enhancer must include suggestedQuestions`
          );
        }

        assertNoForbiddenClaims([openingLine, ...suggestedQuestions], `personas[${personId}]`);

        person.aiPersona.enabled =
          typeof record.enabled === "boolean" ? record.enabled : person.aiPersona.enabled;
        person.aiPersona.openingLine = openingLine;
        person.aiPersona.suggestedQuestions = suggestedQuestions;
        counters.succeeded += 1;
        enhancedPersonIds.push(personId);
      } catch (error) {
        counters.failed += 1;
        counters.fallbackReasons.push(toErrorMessage(error));
        guardWarnings.push(toErrorMessage(error));
      }
    }
  } catch (error) {
    counters.failed = counters.attempted;
    counters.fallbackReasons.push(formatStageError(error));
    carryRepairFlags(error, counters);
  }

  return {
    enhancedPersonIds,
    stageResult: toStageResult("persona_enhancer", counters)
  };
}

interface RunJsonStageInput {
  stage: LlmStageName;
  maxTokens: number;
  allowedIds: Record<string, unknown>;
  userContent: string;
}

async function runJsonStage(input: RunJsonStageInput): Promise<ParseResult> {
  const content = await llmClient.createJsonCompletion({
    temperature: 0.2,
    maxTokens: input.maxTokens,
    messages: [
      {
        role: "system",
        content: DEMO_COMPOSER_SYSTEM_PROMPT
      },
      {
        role: "user",
        content: [
          `stage=${input.stage}`,
          "只输出该 stage 要求的 JSON object。",
          "禁止尾随逗号、注释、Markdown、多余字段、未闭合字符串。",
          input.userContent
        ].join("\n")
      }
    ]
  });

  return parseJsonObjectWithRepair(content, {
    stage: input.stage,
    invalidJson: content,
    parseError: "",
    allowedIds: input.allowedIds
  });
}

async function parseJsonObjectWithRepair(
  content: string,
  repairInput: RepairInput
): Promise<ParseResult> {
  try {
    return {
      output: parseJsonObject(content),
      repairUsed: false,
      repairFailed: false
    };
  } catch (error) {
    if (!(error instanceof DemoComposerLlmError) || error.code !== "LLM_JSON_PARSE_FAILED") {
      throw error;
    }

    try {
      const repairedContent = await repairLlmJson({
        ...repairInput,
        invalidJson: content,
        parseError: error.message
      });
      return {
        output: parseJsonObject(repairedContent),
        repairUsed: true,
        repairFailed: false
      };
    } catch (repairError) {
      throw new DemoComposerLlmError(
        "LLM_JSON_REPAIR_FAILED",
        `LLM JSON repair failed after initial parse error: ${toErrorMessage(repairError)}`,
        error.guardWarnings,
        true,
        true
      );
    }
  }
}

async function repairLlmJson(input: RepairInput): Promise<string> {
  return llmClient.createJsonCompletion({
    temperature: 0,
    maxTokens: 2200,
    messages: [
      {
        role: "system",
        content: [
          "你是 JSON 语法修复器。只修复格式，不改事实。",
          "只输出一个合法 JSON object，不要 Markdown，不要解释。",
          "禁止尾随逗号、注释、多余字段、未闭合字符串。",
          "不得新增、删除或替换任何输入中已有的 id、sourceRefs、evidenceIds、articleIds。",
          "不得新增事实、作者经历、路径、人物或引用；只能修正引号、逗号、括号、转义和未闭合字符串。"
        ].join("\n")
      },
      {
        role: "user",
        content: [
          `stage=${input.stage}`,
          `解析错误：${input.parseError}`,
          "",
          "允许引用的 ID 只包括：",
          JSON.stringify(input.allowedIds, null, 2),
          "",
          "<invalid_json>",
          truncateText(input.invalidJson, 9000),
          "</invalid_json>"
        ].join("\n")
      }
    ]
  });
}

function toPeopleEnhancerContext(person: DemoPerson): Record<string, unknown> {
  return {
    id: person.id,
    pathId: person.pathId,
    sampleType: person.sampleType ?? "content_sample",
    role: person.role,
    badge: person.badge,
    oneLine: person.oneLine,
    overlaps: person.overlaps,
    lesson: person.lesson,
    matchReasons: person.match.reasons,
    sourceRefs: person.sourceRefs,
    evidenceIds: person.evidenceIds,
    article: toArticleContext(person)
  };
}

function toPersonaEnhancerContext(person: DemoPerson): Record<string, unknown> {
  return {
    personId: person.id,
    personaId: person.aiPersona.personaId,
    displayName: person.aiPersona.displayName,
    enabled: person.aiPersona.enabled,
    openingLine: person.aiPersona.openingLine,
    suggestedQuestions: person.aiPersona.suggestedQuestions,
    grounding: person.aiPersona.grounding,
    sourceRefs: person.sourceRefs,
    article: toArticleContext(person)
  };
}

function toArticleContext(person: DemoPerson): Record<string, unknown> {
  const article = person.articles[0];

  return {
    id: article?.id ?? "",
    title: article?.title ?? "",
    author: article?.author ?? person.name,
    text: truncateText(article?.text ?? "", 260),
    evidence:
      article?.evidence.map((evidence) => ({
        id: evidence.id,
        label: evidence.label,
        text: truncateText(evidence.text, 120),
        sourceRefId: evidence.sourceRefId
      })) ?? []
  };
}

function syncTopLevelPersonas(response: DemoSearchResponse): void {
  response.personas = response.people.map((person) => ({
    id: person.aiPersona.personaId,
    personId: person.id,
    displayName: person.aiPersona.displayName,
    avatar: person.avatar,
    personaType: "experience_echo",
    intro: person.aiPersona.openingLine,
    boundaryNotice: DEMO_PERSONA_BOUNDARY_NOTICE,
    sourceRefs: person.sourceRefs,
    suggestedQuestions: person.aiPersona.suggestedQuestions
  }));

  const personaSection = response.sections.find((section) => section.type === "personas");
  if (personaSection) {
    personaSection.itemRefs = response.personas.map((persona) => persona.id);
  }
}

function cloneDemoSearchResponse(response: DemoSearchResponse): DemoSearchResponse {
  return JSON.parse(JSON.stringify(response)) as DemoSearchResponse;
}

function parseJsonObject(content: string): Record<string, unknown> {
  const normalized = stripMarkdownFence(content.trim());
  const start = normalized.indexOf("{");
  const end = normalized.lastIndexOf("}");

  if (start < 0 || end < start) {
    throw new DemoComposerLlmError(
      "LLM_JSON_PARSE_FAILED",
      "LLM response did not contain a JSON object"
    );
  }

  try {
    const parsed: unknown = JSON.parse(normalized.slice(start, end + 1));
    return readRecord(parsed, "LLM root");
  } catch (error) {
    throw new DemoComposerLlmError(
      "LLM_JSON_PARSE_FAILED",
      error instanceof Error ? error.message : "Invalid LLM JSON"
    );
  }
}

function stripMarkdownFence(value: string): string {
  if (!value.startsWith("```")) {
    return value;
  }

  return value
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function readArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new DemoComposerLlmError("LLM_SCHEMA_INVALID", "value must be an array");
  }

  return value.map((item, index) => readRecord(item, `array[${index}]`));
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new DemoComposerLlmError("LLM_SCHEMA_INVALID", `${label} must be an object`);
  }

  return value;
}

function readRequiredString(value: unknown, label: string): string {
  const text = readString(value);
  if (!text) {
    throw new DemoComposerLlmError("LLM_SCHEMA_INVALID", `${label} is required`);
  }

  return text;
}

function readString(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "number") {
    return String(value);
  }

  return "";
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return unique(value.map(readString).filter(Boolean));
}

function readStance(value: unknown, label: string): DemoPath["stance"] {
  if (value === "experience" || value === "viewpoint" || value === "mixed") {
    return value;
  }

  throw new DemoComposerLlmError(
    "LLM_SCHEMA_INVALID",
    `${label} must be experience, viewpoint, or mixed`
  );
}

function assertNoForbiddenClaims(values: string[], label: string): void {
  const forbiddenFragments = [
    "作者本人正在回答",
    "本人正在回答",
    "作者在线",
    "真人",
    "联系TA",
    "联系 TA",
    "私信",
    "和本人聊",
    "模拟作者本人"
  ];

  for (const value of values) {
    for (const fragment of forbiddenFragments) {
      if (value.includes(fragment)) {
        throw new DemoComposerLlmError(
          "LLM_GROUNDING_INVALID",
          `${label} contains forbidden claim: ${fragment}`
        );
      }
    }
  }
}

function createStageCounters(attempted: number): StageCounters {
  return {
    attempted,
    succeeded: 0,
    failed: 0,
    repairUsed: 0,
    repairFailed: 0,
    fallbackReasons: []
  };
}

function toStageResult(stage: LlmStageName, counters: StageCounters): DemoDebugLlmStageResult {
  const failed = Math.min(counters.failed + Math.max(counters.attempted - counters.succeeded - counters.failed, 0), counters.attempted);

  return {
    stage,
    attempted: counters.attempted,
    succeeded: counters.succeeded,
    failed,
    repairUsed: counters.repairUsed,
    repairFailed: counters.repairFailed,
    fallbackReasons: counters.fallbackReasons.slice(0, 5)
  };
}

function carryRepairFlags(error: unknown, counters: StageCounters): void {
  if (error instanceof DemoComposerLlmError) {
    counters.repairUsed += error.llmRepairUsed ? 1 : 0;
    counters.repairFailed += error.llmRepairFailed ? 1 : 0;
  }
}

function summarizeStageFailures(stageResults: DemoDebugLlmStageResult[]): string {
  return stageResults
    .flatMap((result) => result.fallbackReasons.map((reason) => `${result.stage}: ${reason}`))
    .slice(0, 3)
    .join("; ");
}

function formatStageError(error: unknown): string {
  if (error instanceof DemoComposerLlmError) {
    return `${error.code}: ${error.message}`;
  }

  return toErrorMessage(error);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Unknown error";
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
