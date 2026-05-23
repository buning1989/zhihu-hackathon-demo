import { createHash } from "node:crypto";
import { config } from "../config/env.js";
import { AGENT_EVIDENCE_EXTRACTION_VERSION } from "./stages/evidenceExtractLlmStage.js";

export const AGENT_CACHE_SCHEMA_VERSION = "agent.production.cache.v1";
export const AGENT_SCORING_VERSION = "agent.scoring.v3.answer-article-rank-normalized";
export const AGENT_PROMPT_VERSION = "agent.prompts.v11.sample-navigation-schema";

export interface AgentCacheIdentity {
  normalizedQuery: string;
  metadataHash: string;
  dataMode: string;
  provider: string;
  schemaVersion: string;
  promptVersion: string;
  scoringVersion: string;
  evidenceExtractionVersion: string;
  llm: {
    enabled: boolean;
    testMode: string;
    provider: string;
    model: string;
  };
}

export interface AgentActorIdentity {
  actorKey: string;
  actorHash: string;
  actorType: "anonymous" | "user";
}

export function buildAgentCacheIdentity(input: {
  normalizedQuery: string;
  metadata: Record<string, unknown>;
  userId?: string | null;
}): AgentCacheIdentity {
  const provider = config.zhihu.accessSecret ? "zhihu" : "mock";
  const metadataHash = hashStableJson({
    userId: input.userId ?? null,
    metadata: sanitizeMetadataForCache(input.metadata)
  });

  return {
    normalizedQuery: input.normalizedQuery,
    metadataHash,
    dataMode: config.dataMode,
    provider,
    schemaVersion: AGENT_CACHE_SCHEMA_VERSION,
    promptVersion: AGENT_PROMPT_VERSION,
    scoringVersion: AGENT_SCORING_VERSION,
    evidenceExtractionVersion: AGENT_EVIDENCE_EXTRACTION_VERSION,
    llm: {
      enabled: config.agent.llm.enabled,
      testMode: config.agent.llm.testMode,
      provider: config.agent.llm.provider,
      model: resolveAgentLlmModel()
    }
  };
}

export function buildAgentCacheKey(identity: AgentCacheIdentity): string {
  return hashStableJson(identity);
}

export function buildActorIdentity(input: {
  userId?: string | null;
  anonymousId: string;
}): AgentActorIdentity {
  if (input.userId) {
    return {
      actorKey: `user:${input.userId}`,
      actorHash: hashString(`user:${input.userId}`),
      actorType: "user"
    };
  }

  return {
    actorKey: `anonymous:${input.anonymousId}`,
    actorHash: hashString(`anonymous:${input.anonymousId}`),
    actorType: "anonymous"
  };
}

export function sanitizeMetadataForStorage(
  metadata: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!isAllowedMetadataKey(key)) {
      continue;
    }

    const sanitizedValue = sanitizeAllowedMetadataValue(key, value);
    if (sanitizedValue !== undefined) {
      result[key] = sanitizedValue;
    }
  }

  return enforceMetadataSizeLimit(result);
}

export function getAgentCacheTtlHours(type: string): number | undefined {
  if (type === "raw_sources") {
    return config.agent.cache.searchTtlHours;
  }

  if (type === "candidates") {
    return config.agent.cache.candidatesTtlHours;
  }

  if (type === "evidence") {
    return config.agent.cache.evidenceTtlHours;
  }

  if (type === "production_final_result") {
    return config.agent.cache.finalResultTtlHours;
  }

  return undefined;
}

export function getAgentCostBudget(): Record<string, number> {
  return {
    searchQueryMax: config.agent.limits.searchQueryMax,
    sourceCandidateMax: config.agent.limits.sourceCandidateMax,
    selectedForEvidenceMax: config.agent.limits.selectedForEvidenceMax,
    llmCallMax: config.agent.limits.llmCallMax,
    evidenceSourceMax: config.agent.limits.evidenceSourceMax
  };
}

export function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function resolveAgentLlmModel(): string {
  if (config.agent.llm.model) {
    return config.agent.llm.model;
  }

  return config.agent.llm.provider === "kimi"
    ? config.llm.kimi.model
    : config.llm.deepseek.model;
}

function sanitizeMetadataForCache(metadata: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (
      isSensitiveMetadataKey(key) ||
      key === "createdAt" ||
      key === "queuedAt" ||
      key === "readTokenHash"
    ) {
      continue;
    }

    result[key] = sanitizeJsonValue(value, 0);
  }

  return result;
}

function isAllowedMetadataKey(key: string): boolean {
  return new Set([
    "source",
    "createdBy",
    "clientVersion",
    "clarifySource",
    "initialClarifySkipped",
    "hasShownInitialClarify",
    "skipNeedInput",
    "skippedNeedInputTaskId",
    "refinedFromTaskId",
    "clarifyRefined",
    "originalQueryHash",
    "refineAnswerHash",
    "refineAnswerSummary",
    "refineAnswers",
    "refineQueryHash"
  ]).has(key);
}

function sanitizeAllowedMetadataValue(key: string, value: unknown): unknown {
  if ([
    "initialClarifySkipped",
    "hasShownInitialClarify",
    "skipNeedInput",
    "clarifyRefined"
  ].includes(key)) {
    return typeof value === "boolean" ? value : undefined;
  }

  if (key === "refineAnswerSummary") {
    return Array.isArray(value)
      ? value.map((item) => sanitizeString(item, 120)).filter(Boolean).slice(0, 5)
      : undefined;
  }

  if (key === "refineAnswers") {
    return sanitizeRefineAnswersMetadata(value);
  }

  return sanitizeString(value, 160);
}

function sanitizeRefineAnswersMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const result: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value).slice(0, 10)) {
    const safeKey = sanitizeMetadataObjectKey(key);
    if (!safeKey) {
      continue;
    }

    if (isLikelyFreeTextKey(safeKey)) {
      const freeTextSummary = sanitizeFreeTextSummary(nestedValue);
      if (freeTextSummary) {
        result[safeKey] = freeTextSummary;
      }
      continue;
    }

    const safeValue = sanitizeStructuredAnswerValue(nestedValue);
    if (safeValue !== undefined) {
      result[safeKey] = safeValue;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function sanitizeStructuredAnswerValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const values = value.map((item) => sanitizeString(item, 80)).filter(Boolean).slice(0, 5);
    return values.length > 0 ? values : undefined;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return sanitizeString(value, 80);
  }

  return sanitizeFreeTextSummary(value);
}

function sanitizeFreeTextSummary(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const hash = sanitizeString(value.hash, 96);
  const length = typeof value.length === "number" && Number.isFinite(value.length)
    ? Math.max(0, Math.min(Math.trunc(value.length), 10000))
    : undefined;
  const provided = typeof value.provided === "boolean" ? value.provided : Boolean(hash || length);

  if (!hash && length === undefined) {
    return undefined;
  }

  return {
    provided,
    ...(length !== undefined ? { length } : {}),
    ...(hash ? { hash } : {})
  };
}

function sanitizeJsonValue(value: unknown, depth: number): unknown {
  if (depth >= 4) {
    return undefined;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return typeof value === "string" ? sanitizeString(value, 160) : value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 10).map((item) => sanitizeJsonValue(item, depth + 1));
  }

  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value).slice(0, 20)) {
      if (isSensitiveMetadataKey(key)) {
        continue;
      }

      const safeKey = sanitizeMetadataObjectKey(key);
      const safeValue = sanitizeJsonValue(nestedValue, depth + 1);
      if (safeKey && safeValue !== undefined) {
        result[safeKey] = safeValue;
      }
    }
    return result;
  }

  return undefined;
}

function enforceMetadataSizeLimit(metadata: Record<string, unknown>): Record<string, unknown> {
  if (JSON.stringify(metadata).length <= 4096) {
    return metadata;
  }

  const trimmed = { ...metadata };
  delete trimmed.refineAnswers;
  delete trimmed.refineAnswerSummary;
  if (JSON.stringify(trimmed).length <= 4096) {
    return trimmed;
  }

  return Object.fromEntries(
    Object.entries(trimmed).filter(([, value]) => typeof value !== "object" || value === null)
  );
}

function sanitizeString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return undefined;
  }

  const text = String(value).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, maxLength) : undefined;
}

function sanitizeMetadataObjectKey(key: string): string {
  return key.replace(/[^\w.-]/g, "").slice(0, 60);
}

function isLikelyFreeTextKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return [
    "freetext",
    "free_text",
    "additional",
    "context",
    "detail",
    "description",
    "supplement",
    "其他",
    "补充",
    "文本"
  ].some((part) => normalized.includes(part));
}

function isSensitiveMetadataKey(key: string): boolean {
  return ["anonymousId", "ip", "token", "cookie", "authorization", "secret"].some((part) =>
    key.toLowerCase().includes(part)
  );
}

function hashStableJson(value: unknown): string {
  return hashString(JSON.stringify(sortJson(value)));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, sortJson(nestedValue)])
    );
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
