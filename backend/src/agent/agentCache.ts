import { createHash } from "node:crypto";
import { config } from "../config/env.js";
import { AGENT_EVIDENCE_EXTRACTION_VERSION } from "./stages/evidenceExtractLlmStage.js";

export const AGENT_CACHE_SCHEMA_VERSION = "agent.production.cache.v1";
export const AGENT_SCORING_VERSION = "agent.scoring.v3.answer-article-rank-normalized";
export const AGENT_PROMPT_VERSION = "agent.prompts.v10.light-result-ref-repair";

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
    if (isSensitiveMetadataKey(key)) {
      continue;
    }

    result[key] = value;
  }

  return result;
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
    if (isSensitiveMetadataKey(key) || key === "createdAt" || key === "queuedAt") {
      continue;
    }

    result[key] = value;
  }

  return result;
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
