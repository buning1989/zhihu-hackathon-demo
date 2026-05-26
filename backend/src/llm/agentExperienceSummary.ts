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
  type ExperienceSummaryOutput
} from "./schemas/taskSchemas.js";
import type {
  DemoExperienceSummaryDebug,
  DemoLlmStageMeta,
  DemoSearchResponse
} from "../types/demo.types.js";

export interface AgentExperienceSummaryCandidate {
  personId: string;
  articleId: string;
  sourceRefId: string;
  name: string;
  role: string;
  title: string;
  author: string;
  url: string;
  content: string;
  evidenceText: string;
  currentSummary: string;
  candidateQuality: {
    qualityScore: number;
    experienceSignalScore: number;
    relevanceScore: number;
  };
  sourceType: string;
}

export interface AgentExperienceSummaryResult {
  status: "succeeded" | "degraded" | "timed_out";
  output: ExperienceSummaryOutput;
  llmGenerated: boolean;
  provider: string;
  model: string;
  timeoutMs: number;
  durationMs: number;
  inputCandidateCount: number;
  promptCandidateCount: number;
  acceptedSummaryCount: number;
  fallbackReason?: string;
  errorCode?: string;
  errorMessage?: string;
  retryable: boolean;
}

interface RunAgentExperienceSummaryInput {
  query: string;
  result: DemoSearchResponse;
  maxCandidates?: number;
  maxContentChars?: number;
}

interface EvidenceSample {
  sourceRefId: string;
  evidenceText: string;
  label?: string;
  reason?: string;
}

const AGENT_EXPERIENCE_SUMMARY_SYSTEM_PROMPT = String.raw`
你是一个极简经历摘要器，只基于输入 items 生成短摘要。

规则：
1. 只基于 item.evidenceText 和 item.currentSummary，不得新增作者身份、地点、收入、动机、结局。
2. 如果证据不像亲历经历，summary 返回 null。
3. summary 控制在 60-110 个中文字符，以“这段经历...”或“这个样本...”开头。
4. 不要给用户建议，不要使用“你应该/建议你/可以考虑/最好先”。
5. sourceRefId 必须逐字来自输入。
6. 只输出严格 JSON。

输出：
{
  "items": [
    {
      "sourceRefId": "source_x",
      "summary": "这段经历...",
      "reason": "一句话说明依据"
    }
  ]
}
`.trim();

const EXPERIENCE_SUMMARY_MAX_CANDIDATES = 3;
const EXPERIENCE_SUMMARY_CONTENT_CHAR_BUDGET = 420;
const EXPERIENCE_SUMMARY_EVIDENCE_CHAR_BUDGET = 320;
const EXPERIENCE_SUMMARY_OUTPUT_TOKEN_BUDGET = 900;

export async function runAgentExperienceSummary(
  input: RunAgentExperienceSummaryInput
): Promise<AgentExperienceSummaryResult> {
  const startedAt = Date.now();
  const provider = llmRouter.getProviderForTask("experience_summary");
  const model = llmRouter.getModelForTask("experience_summary");
  const timeoutMs = getAgentLlmTaskTimeoutMs("experience_summary");
  const candidates = buildExperienceSummaryCandidatesFromDemoResult(
    input.result,
    input.maxCandidates ?? EXPERIENCE_SUMMARY_MAX_CANDIDATES
  );
  const promptCandidates = preparePromptCandidates(
    candidates,
    input.maxContentChars ?? EXPERIENCE_SUMMARY_CONTENT_CHAR_BUDGET
  );
  const messages = buildExperienceSummaryMessages(input.query, promptCandidates, input.maxContentChars);

  if (promptCandidates.length === 0) {
    return {
      status: "degraded",
      output: { summaries: [] },
      llmGenerated: false,
      provider,
      model,
      timeoutMs,
      durationMs: Date.now() - startedAt,
      inputCandidateCount: candidates.length,
      promptCandidateCount: 0,
      acceptedSummaryCount: 0,
      fallbackReason: "no eligible grounded candidates for experience_summary",
      errorCode: "AGENT_EXPERIENCE_SUMMARY_EMPTY_INPUT",
      errorMessage: "experience_summary has no eligible grounded candidates",
      retryable: false
    };
  }

  if (!llmRouter.isTaskConfigured("experience_summary")) {
    return {
      status: "degraded",
      output: { summaries: [] },
      llmGenerated: false,
      provider,
      model,
      timeoutMs,
      durationMs: Date.now() - startedAt,
      inputCandidateCount: candidates.length,
      promptCandidateCount: promptCandidates.length,
      acceptedSummaryCount: 0,
      fallbackReason: "LLM is not configured for experience_summary; keeping existing grounded text",
      errorCode: "LLM_PROVIDER_UNAVAILABLE",
      errorMessage: "LLM provider is not configured for experience_summary",
      retryable: false
    };
  }

  try {
    const content = await llmRouter.runJsonTask("experience_summary", {
      temperature: 0.15,
      maxTokens: EXPERIENCE_SUMMARY_OUTPUT_TOKEN_BUDGET,
      timeoutMs,
      messages
    });

    const parsed = parseAgentExperienceSummaryOutput(content, promptCandidates);
    const output = filterExperienceSummaries(parsed, promptCandidates);

    if (output.summaries.length === 0) {
      return {
        status: "degraded",
        output,
        llmGenerated: false,
        provider,
        model,
        timeoutMs,
        durationMs: Date.now() - startedAt,
        inputCandidateCount: candidates.length,
        promptCandidateCount: promptCandidates.length,
        acceptedSummaryCount: 0,
        fallbackReason: "LLM returned no acceptable grounded experience summaries",
        errorCode: "AGENT_EXPERIENCE_SUMMARY_EMPTY_OUTPUT",
        errorMessage: "experience_summary returned no acceptable grounded summaries",
        retryable: false
      };
    }

    return {
      status: "succeeded",
      output,
      llmGenerated: true,
      provider,
      model,
      timeoutMs,
      durationMs: Date.now() - startedAt,
      inputCandidateCount: candidates.length,
      promptCandidateCount: promptCandidates.length,
      acceptedSummaryCount: output.summaries.length,
      retryable: false
    };
  } catch (error) {
    const kimiFallback = await tryRunKimiExperienceSummaryFallback({
      error,
      messages,
      startedAt,
      timeoutMs,
      promptCandidates,
      inputCandidateCount: candidates.length
    });
    if (kimiFallback) {
      return kimiFallback;
    }

    const timedOut = isExperienceSummaryTimeout(error);
    return {
      status: timedOut ? "timed_out" : "degraded",
      output: { summaries: [] },
      llmGenerated: false,
      provider,
      model,
      timeoutMs,
      durationMs: Date.now() - startedAt,
      inputCandidateCount: candidates.length,
      promptCandidateCount: promptCandidates.length,
      acceptedSummaryCount: 0,
      fallbackReason: toErrorMessage(error),
      errorCode: toErrorCode(error),
      errorMessage: toErrorMessage(error),
      retryable: false
    };
  }
}

export function applyAgentExperienceSummaryResult(
  result: DemoSearchResponse,
  summary: AgentExperienceSummaryResult
): DemoSearchResponse {
  const enhanced = cloneJson(result) as DemoSearchResponse;
  const summaryByPersonId = new Map(
    summary.output.summaries.map((item) => [item.personId, item])
  );

  for (const person of enhanced.people) {
    const item = summaryByPersonId.get(person.id);
    if (!item?.experienceSummary) {
      if (summary.status !== "succeeded") {
        person.experienceSummaryStatus = "failed";
        person.experienceSummarySource = "none";
        person.experienceSummary = person.experienceSummary ?? null;
        delete person.experienceSummaryConfidence;
      }
      continue;
    }

    person.experienceSummary = item.experienceSummary;
    person.experienceSummaryStatus = "ready";
    person.experienceSummarySource = "llm";
    person.experienceSummaryConfidence = item.confidence;

    const article = person.articles[0];
    if (article) {
      article.summary = item.experienceSummary;
    }

    const path = enhanced.paths.find((candidate) => candidate.id === person.pathId);
    if (path) {
      path.summary = item.experienceSummary;
    }
  }

  const meta = enhanced.meta as DemoSearchResponse["meta"] & {
    experienceSummary?: Record<string, unknown>;
  };
  meta.experienceSummary = {
    status: summary.status,
    llmGenerated: summary.llmGenerated,
    provider: summary.provider,
    model: summary.model,
    inputCandidateCount: summary.inputCandidateCount,
    promptCandidateCount: summary.promptCandidateCount,
    acceptedSummaryCount: summary.acceptedSummaryCount,
    fallbackReason: summary.fallbackReason
  };
  meta.llmStages = upsertLlmStageMeta(meta.llmStages ?? [], summary);
  if (summary.status !== "succeeded") {
    meta.fallbackUsed = true;
    meta.fallbackStages = unique([...(meta.fallbackStages ?? []), "experience_summary"]);
  }
  if (summary.status === "timed_out") {
    meta.timedOutStages = unique([...(meta.timedOutStages ?? []), "experience_summary"]);
  }

  const debug = enhanced.debug as DemoSearchResponse["debug"] & {
    experienceSummary?: Record<string, unknown>;
  };
  debug.llmUsed = Boolean(debug.llmUsed || summary.llmGenerated);
  debug.fallbackUsed = Boolean(debug.fallbackUsed || summary.status !== "succeeded");
  debug.experienceSummaryDebug = toExperienceSummaryDebug(enhanced, summary);
  debug.experienceSummary = {
    status: summary.status,
    llmGenerated: summary.llmGenerated,
    acceptedSummaryCount: summary.acceptedSummaryCount,
    errorCode: summary.errorCode,
    errorMessage: summary.errorMessage,
    fallbackReason: summary.fallbackReason
  };

  return enhanced;
}

export function buildExperienceSummaryCandidatesFromDemoResult(
  result: unknown,
  maxCandidates = EXPERIENCE_SUMMARY_MAX_CANDIDATES
): AgentExperienceSummaryCandidate[] {
  if (!isDemoSearchResponseLike(result)) {
    return [];
  }

  const sourceRefsById = new Map(result.meta.sourceRefs.map((sourceRef) => [sourceRef.id, sourceRef]));
  const evidenceSamplesBySource = new Map(
    readEvidenceSamples(result).map((sample) => [sample.sourceRefId, sample])
  );
  const seen = new Set<string>();
  const candidates: AgentExperienceSummaryCandidate[] = [];

  for (const person of result.people) {
    const article = person.articles[0];
    const sourceRefId = firstNonEmpty(
      article?.sourceRefs[0],
      person.sourceRefs[0],
      article?.evidence[0]?.sourceRefId
    );
    if (!article || !sourceRefId || seen.has(sourceRefId)) {
      continue;
    }

    const sourceRef = sourceRefsById.get(sourceRefId);
    const evidenceSample = evidenceSamplesBySource.get(sourceRefId);
    const evidenceText = firstNonEmpty(
      evidenceSample?.evidenceText,
      article.evidenceText,
      article.evidence[0]?.text,
      article.summary,
      sourceRef?.title
    );
    const content = firstNonEmpty(
      evidenceSample?.evidenceText,
      article.evidenceText,
      article.evidence[0]?.text,
      article.summary,
      article.body.find((block) => block.type === "evidence")?.text,
      article.body.map((block) => block.text).join("\n"),
      article.text,
      sourceRef?.title
    );
    if (!content && !evidenceText) {
      continue;
    }

    seen.add(sourceRefId);
    candidates.push({
      personId: person.id,
      articleId: article.id,
      sourceRefId,
      name: person.name,
      role: person.role,
      title: firstNonEmpty(article.title, sourceRef?.title, "知乎公开内容"),
      author: firstNonEmpty(article.author, sourceRef?.author, person.name, "知乎用户"),
      url: firstNonEmpty(article.url, article.sourceUrl, sourceRef?.url),
      content,
      evidenceText,
      currentSummary: firstNonEmpty(person.experienceSummary, article.summary, person.oneLine),
      candidateQuality: {
        qualityScore: person.match.evidenceQuality,
        experienceSignalScore: person.match.experienceSimilarity,
        relevanceScore: person.match.score
      },
      sourceType: person.sampleType ?? "content_sample"
    });

    if (candidates.length >= maxCandidates) {
      return candidates;
    }
  }

  return candidates;
}

function preparePromptCandidates(
  candidates: AgentExperienceSummaryCandidate[],
  maxContentChars: number
): AgentExperienceSummaryCandidate[] {
  return candidates
    .filter((candidate) => Boolean(candidate.personId && candidate.sourceRefId))
    .map((candidate) => ({
      ...candidate,
      name: truncateText(candidate.name, 40),
      role: truncateText(candidate.role, 40),
      title: truncateText(candidate.title, 90),
      author: truncateText(candidate.author, 40),
      content: truncateText(candidate.content, maxContentChars),
      evidenceText: truncateText(
        candidate.evidenceText || candidate.content,
        EXPERIENCE_SUMMARY_EVIDENCE_CHAR_BUDGET
      ),
      currentSummary: truncateText(candidate.currentSummary, 180)
    }))
    .filter((candidate) =>
      (candidate.content.length >= 30 || candidate.evidenceText.length >= 30) &&
      (candidate.candidateQuality.qualityScore >= 0.25 ||
        candidate.candidateQuality.experienceSignalScore >= 0.2)
    )
    .slice(0, EXPERIENCE_SUMMARY_MAX_CANDIDATES);
}

function buildExperienceSummaryMessages(
  query: string,
  promptCandidates: AgentExperienceSummaryCandidate[],
  maxContentChars?: number
): LlmMessage[] {
  return [
    {
      role: "system",
      content: AGENT_EXPERIENCE_SUMMARY_SYSTEM_PROMPT
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          query: truncateText(query, 120),
          promptBudget: {
            maxCandidates: promptCandidates.length,
            contentCharsPerCandidate: maxContentChars ?? EXPERIENCE_SUMMARY_CONTENT_CHAR_BUDGET,
            evidenceCharsPerCandidate: EXPERIENCE_SUMMARY_EVIDENCE_CHAR_BUDGET
          },
          items: promptCandidates.map(toPromptCandidate)
        },
        null,
        2
      )
    }
  ];
}

async function tryRunKimiExperienceSummaryFallback(input: {
  error: unknown;
  messages: LlmMessage[];
  startedAt: number;
  timeoutMs: number;
  promptCandidates: AgentExperienceSummaryCandidate[];
  inputCandidateCount: number;
}): Promise<AgentExperienceSummaryResult | undefined> {
  if (!shouldUseKimiExperienceSummaryFallback(input.error)) {
    return undefined;
  }

  const elapsedMs = Date.now() - input.startedAt;
  const remainingMs = input.timeoutMs - elapsedMs;
  if (remainingMs < 3000) {
    return undefined;
  }

  try {
    const content = await kimiClient.createJsonCompletion({
      taskType: "experience_summary",
      temperature: 0.15,
      maxTokens: EXPERIENCE_SUMMARY_OUTPUT_TOKEN_BUDGET,
      timeoutMs: Math.min(remainingMs, 8000),
      maxRetry: 0,
      messages: input.messages
    });
    const parsed = parseAgentExperienceSummaryOutput(content, input.promptCandidates);
    const output = filterExperienceSummaries(parsed, input.promptCandidates);
    if (output.summaries.length === 0) {
      return undefined;
    }

    return {
      status: "succeeded",
      output,
      llmGenerated: true,
      provider: kimiClient.provider,
      model: kimiClient.model,
      timeoutMs: input.timeoutMs,
      durationMs: Date.now() - input.startedAt,
      inputCandidateCount: input.inputCandidateCount,
      promptCandidateCount: input.promptCandidates.length,
      acceptedSummaryCount: output.summaries.length,
      retryable: false
    };
  } catch {
    return undefined;
  }
}

function shouldUseKimiExperienceSummaryFallback(error: unknown): boolean {
  return (
    kimiClient.isConfigured() &&
    error instanceof LlmClientError &&
    error.code === "LLM_EMPTY_RESPONSE"
  );
}

function toPromptCandidate(candidate: AgentExperienceSummaryCandidate): Record<string, unknown> {
  return {
    sourceRefId: candidate.sourceRefId,
    title: sanitizePromptText(candidate.title),
    author: sanitizePromptText(candidate.author),
    currentSummary: sanitizePromptText(candidate.currentSummary),
    evidenceText: sanitizePromptText(candidate.evidenceText || candidate.content),
    content: sanitizePromptText(candidate.content),
    quality: candidate.candidateQuality,
    sourceType: candidate.sourceType
  };
}

function parseAgentExperienceSummaryOutput(
  content: string,
  candidates: AgentExperienceSummaryCandidate[]
): ExperienceSummaryOutput {
  const record = parseJsonObject(content);
  const candidatesBySourceRefId = new Map(candidates.map((candidate) => [candidate.sourceRefId, candidate]));
  const candidatesByPersonId = new Map(candidates.map((candidate) => [candidate.personId, candidate]));
  const items = readRecordArray(record.items ?? record.summaries);
  const seenPersonIds = new Set<string>();
  const summaries = items
    .map((item) => {
      const sourceRefId = readString(item.sourceRefId);
      const personId = readString(item.personId);
      const candidate = sourceRefId
        ? candidatesBySourceRefId.get(sourceRefId)
        : candidatesByPersonId.get(personId);
      if (!candidate || seenPersonIds.has(candidate.personId)) {
        return undefined;
      }

      seenPersonIds.add(candidate.personId);
      const rawSummary = readString(item.summary ?? item.experienceSummary);
      return {
        personId: candidate.personId,
        experienceSummary: rawSummary ? truncateText(rawSummary, 180) : null,
        confidence: rawSummary ? 0.72 : 0,
        reason: truncateText(readString(item.reason) || "LLM generated a source-grounded summary", 120)
      };
    })
    .filter((item): item is ExperienceSummaryOutput["summaries"][number] => Boolean(item))
    .slice(0, candidates.length);

  return { summaries };
}

function filterExperienceSummaries(
  output: ExperienceSummaryOutput,
  candidates: AgentExperienceSummaryCandidate[]
): ExperienceSummaryOutput {
  const allowedPersonIds = new Set(candidates.map((candidate) => candidate.personId));
  return {
    summaries: output.summaries
      .filter((item) =>
        allowedPersonIds.has(item.personId) &&
        Boolean(item.experienceSummary) &&
        isSafeExperienceSummary(item.experienceSummary)
      )
      .slice(0, candidates.length)
  };
}

function toExperienceSummaryDebug(
  result: DemoSearchResponse,
  summary: AgentExperienceSummaryResult
): DemoExperienceSummaryDebug[] {
  const summaryByPersonId = new Map(
    summary.output.summaries.map((item) => [item.personId, item])
  );

  return result.people.slice(0, EXPERIENCE_SUMMARY_MAX_CANDIDATES).map((person) => {
    const item = summaryByPersonId.get(person.id);
    if (item?.experienceSummary) {
      return {
        personId: person.id,
        status: "ready",
        source: "llm",
        reason: item.reason || "LLM generated a grounded experience summary",
        cacheHit: false
      };
    }

    return {
      personId: person.id,
      status: summary.status === "succeeded" ? "pending" : "failed",
      source: "none",
      reason: summary.fallbackReason || "experience_summary did not generate a grounded summary",
      cacheHit: false,
      fallbackSummary: firstNonEmpty(person.experienceSummary, person.articles[0]?.summary)
    };
  });
}

function readEvidenceSamples(result: DemoSearchResponse): EvidenceSample[] {
  const meta = result.meta as DemoSearchResponse["meta"] & {
    evidenceSamples?: unknown;
  };
  if (!Array.isArray(meta.evidenceSamples)) {
    return [];
  }

  return meta.evidenceSamples
    .filter((item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null
    )
    .map((item) => ({
      sourceRefId: typeof item.sourceRefId === "string" ? item.sourceRefId : "",
      evidenceText: typeof item.evidenceText === "string" ? item.evidenceText : "",
      label: typeof item.label === "string" ? item.label : undefined,
      reason: typeof item.reason === "string" ? item.reason : undefined
    }))
    .filter((item) => Boolean(item.sourceRefId && item.evidenceText));
}

function upsertLlmStageMeta(
  stages: DemoLlmStageMeta[],
  summary: AgentExperienceSummaryResult
): DemoLlmStageMeta[] {
  const stageMeta: DemoLlmStageMeta = {
    taskType: "experience_summary",
    provider: summary.provider,
    model: summary.model,
    status:
      summary.status === "succeeded"
        ? "success"
        : summary.status === "timed_out"
          ? "timeout"
          : "fallback",
    durationMs: summary.durationMs,
    fallbackReason: summary.fallbackReason ?? ""
  };

  return [
    ...stages.filter((stage) => stage.taskType !== "experience_summary"),
    stageMeta
  ];
}

function isDemoSearchResponseLike(value: unknown): value is DemoSearchResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as DemoSearchResponse).paths) &&
    Array.isArray((value as DemoSearchResponse).people) &&
    typeof (value as DemoSearchResponse).meta === "object" &&
    (value as DemoSearchResponse).meta !== null &&
    Array.isArray((value as DemoSearchResponse).meta.sourceRefs)
  );
}

function isExperienceSummaryTimeout(error: unknown): boolean {
  return (
    isLlmTaskTimeoutError(error) ||
    (error instanceof LlmClientError && error.code === "LLM_TIMEOUT") ||
    (error instanceof Error && "code" in error && error.code === "LLM_TASK_TIMEOUT")
  );
}

function isSafeExperienceSummary(value: string | null): value is string {
  if (!value) {
    return false;
  }

  const forbiddenFragments = [
    "作者本人正在回答",
    "本人正在回答",
    "作为作者本人",
    "我是作者",
    "我当时",
    "我经历过",
    "作者在线",
    "联系TA",
    "联系 TA",
    "联系作者",
    "私信",
    "加微信",
    "模拟作者本人"
  ];
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
    experienceMarkers.some((marker) => value.includes(marker)) &&
    !forbiddenFragments.some((fragment) => value.includes(fragment)) &&
    !adviceFragments.some((fragment) => value.includes(fragment))
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

  return error instanceof Error ? error.name || "LLM_EXPERIENCE_SUMMARY_ERROR" : "LLM_EXPERIENCE_SUMMARY_ERROR";
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

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function cloneJson<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }

  return JSON.parse(JSON.stringify(value)) as T;
}
