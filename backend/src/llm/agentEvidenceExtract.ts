import {
  LlmClientError,
  type LlmMessage
} from "./clients/openaiCompatible.js";
import { kimiClient } from "./clients/kimiClient.js";
import {
  getAgentLlmTaskTimeoutMs,
  isLlmTaskTimeoutError
} from "./llmTimeout.js";
import {
  LlmRouterError,
  llmRouter
} from "./llmRouter.js";
import {
  type EvidenceExtractOutput
} from "./schemas/taskSchemas.js";
import type {
  DemoEvidence,
  DemoEvidenceStatus,
  DemoSearchResponse
} from "../types/demo.types.js";

export interface AgentEvidenceExtractCandidate {
  candidateId: string;
  sourceRefId: string;
  title: string;
  author: string;
  url: string;
  text: string;
  evidenceText: string;
  sampleType?: string;
  relevanceScore?: number;
  qualityScore?: number;
  experienceSignalScore?: number;
  contentLength?: number;
  filterReason?: string;
}

export interface AgentEvidenceExtractResult {
  status: "succeeded" | "degraded" | "timed_out";
  output: EvidenceExtractOutput;
  llmExtracted: boolean;
  provider: string;
  model: string;
  timeoutMs: number;
  durationMs: number;
  inputCandidateCount: number;
  promptCandidateCount: number;
  fallbackReason?: string;
  errorCode?: string;
  errorMessage?: string;
  retryable: boolean;
}

interface RunAgentEvidenceExtractInput {
  query: string;
  intent: unknown;
  candidates: AgentEvidenceExtractCandidate[];
  maxCandidates?: number;
  maxTextChars?: number;
}

interface EvidenceSample {
  sourceRefId: string;
  label: string;
  evidenceText: string;
  relevanceScore: number;
  reason: string;
}

const AGENT_EVIDENCE_EXTRACT_SYSTEM_PROMPT = String.raw`
你是一个极简证据抽取器，只处理输入 candidates。

规则：
1. 只从 candidate.evidenceText 中复制或轻微截短原文证据，不得编造。
2. sourceRefId 必须逐字来自输入。
3. 每条 evidenceText 控制在 40-120 个中文字符。
4. 最多输出 3 条，优先选择真实经历、决策过程、结果反馈。
5. 不要生成人物、路径、persona 或长分析。
6. 只输出严格 JSON。

输出：
{
  "items": [
    {
      "sourceRefId": "source_x",
      "evidenceText": "来自原文的关键片段",
      "relevance": "strong",
      "reason": "一句话说明与问题的关系"
    }
  ]
}
`.trim();

const EVIDENCE_EXTRACT_MAX_CANDIDATES = 3;
const EVIDENCE_EXTRACT_TEXT_CHAR_BUDGET = 650;
const EVIDENCE_EXTRACT_EVIDENCE_CHAR_BUDGET = 220;
const EVIDENCE_EXTRACT_OUTPUT_TOKEN_BUDGET = 900;

export async function runAgentEvidenceExtract(
  input: RunAgentEvidenceExtractInput
): Promise<AgentEvidenceExtractResult> {
  const startedAt = Date.now();
  const provider = llmRouter.getProviderForTask("evidence_extract");
  const model = llmRouter.getModelForTask("evidence_extract");
  const timeoutMs = getAgentLlmTaskTimeoutMs("evidence_extract");
  const promptCandidates = preparePromptCandidates(input);
  const fallbackOutput = createFallbackEvidenceExtract(promptCandidates);
  const messages = buildEvidenceExtractMessages(input.query, promptCandidates, input.maxTextChars);

  if (promptCandidates.length === 0) {
    return {
      status: "degraded",
      output: fallbackOutput,
      llmExtracted: false,
      provider,
      model,
      timeoutMs,
      durationMs: Date.now() - startedAt,
      inputCandidateCount: input.candidates.length,
      promptCandidateCount: 0,
      fallbackReason: "no eligible source candidates for evidence_extract",
      errorCode: "AGENT_EVIDENCE_EMPTY_INPUT",
      errorMessage: "evidence_extract has no eligible source candidates",
      retryable: false
    };
  }

  if (!llmRouter.isTaskConfigured("evidence_extract")) {
    return {
      status: "degraded",
      output: fallbackOutput,
      llmExtracted: false,
      provider,
      model,
      timeoutMs,
      durationMs: Date.now() - startedAt,
      inputCandidateCount: input.candidates.length,
      promptCandidateCount: promptCandidates.length,
      fallbackReason: "LLM is not configured for evidence_extract; using source snippets",
      errorCode: "LLM_PROVIDER_UNAVAILABLE",
      errorMessage: "LLM provider is not configured for evidence_extract",
      retryable: true
    };
  }

  try {
    const completionInput = {
      temperature: 0.1,
      maxTokens: EVIDENCE_EXTRACT_OUTPUT_TOKEN_BUDGET,
      timeoutMs,
      maxRetry: 0,
      messages
    };
    const content = await llmRouter.runJsonTask("evidence_extract", completionInput);

    const output = parseAgentEvidenceExtractOutput(content, promptCandidates);

    if (output.evidenceRefs.length === 0) {
      return {
        status: "degraded",
        output: fallbackOutput,
        llmExtracted: false,
        provider,
        model,
        timeoutMs,
        durationMs: Date.now() - startedAt,
        inputCandidateCount: input.candidates.length,
        promptCandidateCount: promptCandidates.length,
        fallbackReason: "LLM returned no eligible evidence refs; using source snippets",
        errorCode: "AGENT_EVIDENCE_EMPTY_OUTPUT",
        errorMessage: "evidence_extract returned no eligible evidence refs",
        retryable: true
      };
    }

    return {
      status: "succeeded",
      output,
      llmExtracted: true,
      provider,
      model,
      timeoutMs,
      durationMs: Date.now() - startedAt,
      inputCandidateCount: input.candidates.length,
      promptCandidateCount: promptCandidates.length,
      retryable: false
    };
  } catch (error) {
    const kimiFallback = await tryRunKimiEvidenceFallback({
      error,
      query: input.query,
      messages,
      startedAt,
      timeoutMs,
      promptCandidates,
      inputCandidateCount: input.candidates.length
    });
    if (kimiFallback) {
      return kimiFallback;
    }

    const timedOut = isEvidenceTimeout(error);
    return {
      status: timedOut ? "timed_out" : "degraded",
      output: fallbackOutput,
      llmExtracted: false,
      provider,
      model,
      timeoutMs,
      durationMs: Date.now() - startedAt,
      inputCandidateCount: input.candidates.length,
      promptCandidateCount: promptCandidates.length,
      fallbackReason: toErrorMessage(error),
      errorCode: toErrorCode(error),
      errorMessage: toErrorMessage(error),
      retryable: true
    };
  }
}

export function buildEvidenceCandidatesFromDemoResult(
  result: unknown,
  maxCandidates = EVIDENCE_EXTRACT_MAX_CANDIDATES
): AgentEvidenceExtractCandidate[] {
  if (!isDemoSearchResponseLike(result)) {
    return [];
  }

  const sourceRefsById = new Map(result.meta.sourceRefs.map((sourceRef) => [sourceRef.id, sourceRef]));
  const seen = new Set<string>();
  const candidates: AgentEvidenceExtractCandidate[] = [];

  for (const person of result.people) {
    for (const article of person.articles) {
      const sourceRefId = firstNonEmpty(
        article.sourceRefs[0],
        person.sourceRefs[0],
        article.evidence[0]?.sourceRefId
      );
      if (!sourceRefId || seen.has(sourceRefId)) {
        continue;
      }

      const sourceRef = sourceRefsById.get(sourceRefId);
      const text = firstNonEmpty(
        article.evidenceText,
        article.evidence[0]?.text,
        article.summary,
        article.body.map((block) => block.text).join("\n"),
        article.text,
        sourceRef?.title
      );
      const evidenceText = firstNonEmpty(
        article.evidenceText,
        article.evidence[0]?.text,
        article.summary,
        article.body.find((block) => block.type === "evidence")?.text,
        sourceRef?.title
      );
      if (!text && !evidenceText) {
        continue;
      }

      seen.add(sourceRefId);
      candidates.push({
        candidateId: article.id || person.id || sourceRefId,
        sourceRefId,
        title: firstNonEmpty(article.title, sourceRef?.title, "知乎公开内容"),
        author: firstNonEmpty(article.author, sourceRef?.author, person.name, "知乎用户"),
        url: firstNonEmpty(article.url, article.sourceUrl, sourceRef?.url),
        text,
        evidenceText,
        sampleType: person.sampleType,
        relevanceScore: person.match.score,
        qualityScore: person.match.evidenceQuality,
        experienceSignalScore: person.match.experienceSimilarity,
        contentLength: text.length,
        filterReason: firstNonEmpty(person.fitReason, person.relevanceReason, person.match.reasons[0])
      });

      if (candidates.length >= maxCandidates) {
        return candidates;
      }
    }
  }

  if (candidates.length > 0) {
    return candidates;
  }

  for (const sourceRef of result.meta.sourceRefs.slice(0, maxCandidates)) {
    if (seen.has(sourceRef.id)) {
      continue;
    }

    seen.add(sourceRef.id);
    candidates.push({
      candidateId: sourceRef.id,
      sourceRefId: sourceRef.id,
      title: sourceRef.title || "知乎公开内容",
      author: sourceRef.author || "知乎用户",
      url: sourceRef.url,
      text: sourceRef.title,
      evidenceText: sourceRef.title,
      contentLength: sourceRef.title.length,
      filterReason: "fallback sourceRef candidate"
    });
  }

  return candidates;
}

export function applyAgentEvidenceExtractResult(
  result: DemoSearchResponse,
  extraction: AgentEvidenceExtractResult
): DemoSearchResponse {
  const enhanced = cloneJson(result) as DemoSearchResponse;
  const evidenceRefsBySource = new Map(
    extraction.output.evidenceRefs.map((evidenceRef) => [evidenceRef.sourceRefId, evidenceRef])
  );
  const evidenceStatus: DemoEvidenceStatus = extraction.llmExtracted ? "llm_extracted" : "raw_snippet_only";

  for (const person of enhanced.people) {
    let personHasEvidence = false;

    for (const article of person.articles) {
      const sourceRefId = firstNonEmpty(
        article.sourceRefs[0],
        person.sourceRefs[0],
        article.evidence[0]?.sourceRefId
      );
      const evidenceRef = sourceRefId ? evidenceRefsBySource.get(sourceRefId) : undefined;
      if (!evidenceRef) {
        continue;
      }

      personHasEvidence = true;
      article.evidenceStatus = evidenceStatus;
      article.evidenceText = evidenceRef.evidenceText;
      article.evidence = upsertPrimaryEvidence(article.evidence, {
        id: firstNonEmpty(article.evidence[0]?.id, `${sourceRefId}_evidence_1`),
        label: evidenceRef.label,
        text: evidenceRef.evidenceText,
        sourceRefId,
        sourceUrl: article.sourceUrl || article.url
      });
      article.body = article.body.map((block) =>
        block.type === "evidence" && block.sourceRefs.includes(sourceRefId)
          ? {
              ...block,
              text: evidenceRef.evidenceText,
              evidenceIds: article.evidence.map((item) => item.id)
            }
          : block
      );
    }

    if (personHasEvidence) {
      person.evidenceStatus = evidenceStatus;
      person.aiPersona.evidenceStatus = evidenceStatus;
    }
  }

  const evidenceSamples = toEvidenceSamples(extraction.output);
  const meta = enhanced.meta as DemoSearchResponse["meta"] & {
    evidenceSamples?: EvidenceSample[];
    evidenceExtract?: Record<string, unknown>;
  };
  meta.evidenceSamples = evidenceSamples;
  meta.evidenceCount = Math.max(meta.evidenceCount, evidenceSamples.length);
  meta.evidenceExtract = {
    status: extraction.status,
    llmExtracted: extraction.llmExtracted,
    provider: extraction.provider,
    model: extraction.model,
    inputCandidateCount: extraction.inputCandidateCount,
    promptCandidateCount: extraction.promptCandidateCount,
    evidenceRefCount: evidenceSamples.length,
    fallbackReason: extraction.fallbackReason
  };
  meta.llmStages = upsertLlmStageMeta(meta.llmStages ?? [], extraction);
  if (extraction.status !== "succeeded") {
    meta.fallbackUsed = true;
    meta.fallbackStages = unique([...(meta.fallbackStages ?? []), "evidence_extract"]);
  }
  if (extraction.status === "timed_out") {
    meta.timedOutStages = unique([...(meta.timedOutStages ?? []), "evidence_extract"]);
  }

  const debug = enhanced.debug as DemoSearchResponse["debug"] & {
    evidenceExtract?: Record<string, unknown>;
  };
  debug.llmUsed = Boolean(debug.llmUsed || extraction.llmExtracted);
  debug.fallbackUsed = Boolean(debug.fallbackUsed || extraction.status !== "succeeded");
  debug.evidenceExtract = {
    status: extraction.status,
    llmExtracted: extraction.llmExtracted,
    evidenceSamples,
    errorCode: extraction.errorCode,
    errorMessage: extraction.errorMessage,
    fallbackReason: extraction.fallbackReason
  };

  return enhanced;
}

function preparePromptCandidates(
  input: RunAgentEvidenceExtractInput
): AgentEvidenceExtractCandidate[] {
  const maxCandidates = input.maxCandidates ?? EVIDENCE_EXTRACT_MAX_CANDIDATES;
  const maxTextChars = input.maxTextChars ?? EVIDENCE_EXTRACT_TEXT_CHAR_BUDGET;
  const seen = new Set<string>();
  const promptCandidates: AgentEvidenceExtractCandidate[] = [];

  for (const candidate of input.candidates) {
    if (!candidate.sourceRefId || seen.has(candidate.sourceRefId)) {
      continue;
    }

    seen.add(candidate.sourceRefId);
    promptCandidates.push({
      ...candidate,
      title: truncateText(candidate.title, 80),
      author: truncateText(candidate.author, 40),
      text: truncateText(candidate.text, maxTextChars),
      evidenceText: truncateText(candidate.evidenceText || candidate.text, EVIDENCE_EXTRACT_EVIDENCE_CHAR_BUDGET),
      filterReason: candidate.filterReason ? truncateText(candidate.filterReason, 120) : undefined,
      contentLength: candidate.contentLength ?? candidate.text.length
    });

    if (promptCandidates.length >= maxCandidates) {
      break;
    }
  }

  return promptCandidates;
}

function buildEvidenceExtractMessages(
  query: string,
  promptCandidates: AgentEvidenceExtractCandidate[],
  maxTextChars?: number
): LlmMessage[] {
  return [
    {
      role: "system",
      content: AGENT_EVIDENCE_EXTRACT_SYSTEM_PROMPT
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          query,
          promptBudget: {
            maxCandidates: promptCandidates.length,
            textCharsPerCandidate: maxTextChars ?? EVIDENCE_EXTRACT_TEXT_CHAR_BUDGET,
            evidenceCharsPerCandidate: EVIDENCE_EXTRACT_EVIDENCE_CHAR_BUDGET
          },
          candidates: promptCandidates.map(toPromptCandidate)
        },
        null,
        2
      )
    }
  ];
}

async function tryRunKimiEvidenceFallback(input: {
  error: unknown;
  query: string;
  messages: LlmMessage[];
  startedAt: number;
  timeoutMs: number;
  promptCandidates: AgentEvidenceExtractCandidate[];
  inputCandidateCount: number;
}): Promise<AgentEvidenceExtractResult | undefined> {
  if (!shouldUseKimiEvidenceFallback(input.error)) {
    return undefined;
  }

  const elapsedMs = Date.now() - input.startedAt;
  const remainingMs = input.timeoutMs - elapsedMs;
  if (remainingMs < 3000) {
    return undefined;
  }

  try {
    const content = await kimiClient.createJsonCompletion({
      taskType: "evidence_extract",
      temperature: 0.1,
      maxTokens: EVIDENCE_EXTRACT_OUTPUT_TOKEN_BUDGET,
      timeoutMs: Math.min(remainingMs, 8000),
      maxRetry: 0,
      messages: input.messages
    });
    const output = parseAgentEvidenceExtractOutput(content, input.promptCandidates);
    if (output.evidenceRefs.length === 0) {
      return undefined;
    }

    return {
      status: "succeeded",
      output,
      llmExtracted: true,
      provider: kimiClient.provider,
      model: kimiClient.model,
      timeoutMs: input.timeoutMs,
      durationMs: Date.now() - input.startedAt,
      inputCandidateCount: input.inputCandidateCount,
      promptCandidateCount: input.promptCandidates.length,
      retryable: false
    };
  } catch {
    return undefined;
  }
}

function shouldUseKimiEvidenceFallback(error: unknown): boolean {
  return (
    kimiClient.isConfigured() &&
    error instanceof LlmClientError &&
    error.code === "LLM_EMPTY_RESPONSE"
  );
}

function toPromptCandidate(candidate: AgentEvidenceExtractCandidate): Record<string, unknown> {
  return {
    sourceRefId: candidate.sourceRefId,
    title: sanitizePromptText(candidate.title),
    author: sanitizePromptText(candidate.author),
    evidenceText: sanitizePromptText(candidate.evidenceText),
    quality: {
      relevanceScore: candidate.relevanceScore,
      qualityScore: candidate.qualityScore,
      experienceSignalScore: candidate.experienceSignalScore
    }
  };
}

function parseAgentEvidenceExtractOutput(
  content: string,
  candidates: AgentEvidenceExtractCandidate[]
): EvidenceExtractOutput {
  const allowedSourceRefs = new Set(candidates.map((candidate) => candidate.sourceRefId));
  let record: Record<string, unknown>;
  try {
    record = parseJsonObject(content);
  } catch {
    return createSalvagedEvidenceOutput(content, candidates);
  }

  const items = readRecordArray(record.items ?? record.evidenceRefs);
  const evidenceRefs = items
    .map((item) => readAgentEvidenceItem(item, allowedSourceRefs))
    .filter((item): item is EvidenceExtractOutput["evidenceRefs"][number] => Boolean(item))
    .slice(0, EVIDENCE_EXTRACT_MAX_CANDIDATES);

  return {
    evidenceRefs: evidenceRefs.length > 0
      ? evidenceRefs
      : createSalvagedEvidenceOutput(content, candidates).evidenceRefs,
    peopleSeeds: [],
    pathSignals: [],
    personaSeeds: []
  };
}

function createSalvagedEvidenceOutput(
  content: string,
  candidates: AgentEvidenceExtractCandidate[]
): EvidenceExtractOutput {
  const selected = candidates
    .filter((candidate) => content.includes(candidate.sourceRefId))
    .slice(0, EVIDENCE_EXTRACT_MAX_CANDIDATES);

  return {
    evidenceRefs: selected.map((candidate) => ({
      sourceRefId: candidate.sourceRefId,
      label: "关键证据",
      evidenceText: truncateText(candidate.evidenceText || candidate.text || candidate.title, 180),
      relevanceScore: clampScore(candidate.relevanceScore ?? candidate.qualityScore ?? 0.62),
      reason: "LLM 返回了可识别 sourceRefId，但 JSON 格式不完整；使用对应短证据片段保守落地。"
    })),
    peopleSeeds: [],
    pathSignals: [],
    personaSeeds: []
  };
}

function readAgentEvidenceItem(
  item: Record<string, unknown>,
  allowedSourceRefs: Set<string>
): EvidenceExtractOutput["evidenceRefs"][number] | undefined {
  const sourceRefId = readString(item.sourceRefId);
  if (!allowedSourceRefs.has(sourceRefId)) {
    return undefined;
  }

  const evidenceText = readString(item.evidenceText);
  if (!evidenceText) {
    return undefined;
  }

  return {
    sourceRefId,
    label: truncateText(readString(item.label) || "关键证据", 16),
    evidenceText: truncateText(evidenceText, 180),
    relevanceScore: readRelevanceScore(item.relevance ?? item.relevanceScore),
    reason: truncateText(readString(item.reason), 120)
  };
}

function createFallbackEvidenceExtract(
  candidates: AgentEvidenceExtractCandidate[]
): EvidenceExtractOutput {
  return {
    evidenceRefs: candidates.map((candidate) => ({
      sourceRefId: candidate.sourceRefId,
      label: "公开内容片段",
      evidenceText: truncateText(candidate.evidenceText || candidate.text || candidate.title, 180),
      relevanceScore: clampScore(candidate.relevanceScore ?? candidate.qualityScore ?? 0.62),
      reason: truncateText(
        candidate.filterReason || "LLM evidence_extract 不可用时，使用已召回内容的原始片段作为降级证据。",
        120
      )
    })),
    peopleSeeds: [],
    pathSignals: [],
    personaSeeds: []
  };
}

function upsertPrimaryEvidence(
  evidence: DemoEvidence[],
  primary: DemoEvidence
): DemoEvidence[] {
  if (evidence.length === 0) {
    return [primary];
  }

  return [
    {
      ...evidence[0],
      label: primary.label,
      text: primary.text,
      sourceRefId: primary.sourceRefId,
      sourceUrl: primary.sourceUrl
    },
    ...evidence.slice(1)
  ];
}

function toEvidenceSamples(output: EvidenceExtractOutput): EvidenceSample[] {
  return output.evidenceRefs.map((evidenceRef) => ({
    sourceRefId: evidenceRef.sourceRefId,
    label: evidenceRef.label,
    evidenceText: evidenceRef.evidenceText,
    relevanceScore: evidenceRef.relevanceScore,
    reason: evidenceRef.reason
  }));
}

function upsertLlmStageMeta(
  stages: NonNullable<DemoSearchResponse["meta"]["llmStages"]>,
  extraction: AgentEvidenceExtractResult
): NonNullable<DemoSearchResponse["meta"]["llmStages"]> {
  const stageMeta = {
    taskType: "evidence_extract",
    provider: extraction.provider,
    model: extraction.model,
    status:
      extraction.status === "succeeded"
        ? "success"
        : extraction.status === "timed_out"
          ? "timeout"
          : "fallback",
    durationMs: extraction.durationMs,
    fallbackReason: extraction.fallbackReason ?? ""
  } as const;

  return [
    ...stages.filter((stage) => stage.taskType !== "evidence_extract"),
    stageMeta
  ];
}

function isDemoSearchResponseLike(value: unknown): value is DemoSearchResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as DemoSearchResponse).people) &&
    typeof (value as DemoSearchResponse).meta === "object" &&
    (value as DemoSearchResponse).meta !== null &&
    Array.isArray((value as DemoSearchResponse).meta.sourceRefs)
  );
}

function isEvidenceTimeout(error: unknown): boolean {
  return (
    isLlmTaskTimeoutError(error) ||
    (error instanceof LlmClientError && error.code === "LLM_TIMEOUT") ||
    (error instanceof Error && "code" in error && error.code === "LLM_TASK_TIMEOUT")
  );
}

function toErrorCode(error: unknown): string {
  if (isLlmTaskTimeoutError(error)) {
    return error.code;
  }

  if (error instanceof LlmRouterError || error instanceof LlmClientError) {
    return error.code;
  }

  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }

  return error instanceof Error ? error.name || "LLM_EVIDENCE_EXTRACT_ERROR" : "LLM_EVIDENCE_EXTRACT_ERROR";
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return truncateText(error.message || error.name, 180);
  }

  return truncateText(String(error), 180);
}

function parseJsonObject(content: string): Record<string, unknown> {
  const normalized = stripMarkdownFence(content.trim());
  const start = normalized.indexOf("{");
  const end = normalized.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("LLM response did not contain a JSON object");
  }

  return readRecord(JSON.parse(stripTrailingJsonCommas(normalized.slice(start, end + 1))));
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

function stripTrailingJsonCommas(value: string): string {
  return value.replace(/,\s*([}\]])/g, "$1");
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("LLM root must be an object");
  }

  return value;
}

function readRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function readString(value: unknown): string {
  if (typeof value === "string") {
    return value.replace(/\s+/g, " ").trim();
  }

  if (typeof value === "number") {
    return String(value);
  }

  return "";
}

function readRelevanceScore(value: unknown): number {
  if (typeof value === "number") {
    return clampScore(value);
  }

  const normalized = readString(value).toLowerCase();
  if (normalized === "strong") {
    return 0.9;
  }

  if (normalized === "medium") {
    return 0.68;
  }

  if (normalized === "weak") {
    return 0.45;
  }

  return 0.62;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizePromptText(value: string): string {
  return value
    .replace(/\\/g, "")
    .replace(/"/g, "“")
    .replace(/[\u0000-\u001F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstNonEmpty(...values: Array<string | undefined | null>): string {
  return values.find((value) => value?.trim())?.trim() ?? "";
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }

  return Math.min(1, Math.max(0, value));
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}
