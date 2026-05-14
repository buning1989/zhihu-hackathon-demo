import { config } from "../config/env.js";
import { assertDemoSearchGrounding } from "../guards/demoEvidence.guard.js";
import {
  composeMultiLlmDemoSearchResponse,
  hasPersonaChatLlm
} from "../llm/demoSearchOrchestrator.js";
import { createMockDemoSearchResponse } from "../mocks/demoSearch.mock.js";
import {
  createDemoSearchIdentity,
  type DemoSearchIdentity
} from "./demoQueryIdentity.service.js";
import { demoSessionCacheService } from "./demoSessionCache.service.js";
import { createDemoContextUsed } from "./userContext.service.js";
import type { UserContext } from "../auth/session.js";
import { type DemoDataMode, type DemoSearchResponse } from "../types/demo.types.js";
import { HttpError } from "../utils/httpError.js";
import {
  isRequestBudgetTimeoutError,
  withRequestBudget
} from "../utils/requestBudget.js";

export interface DemoSearchRequest {
  query: string;
  count: number;
  dataMode: DemoDataMode;
}

const DEFAULT_COUNT = 5;
const MAX_COUNT = 20;
const DATA_MODES = new Set<DemoDataMode>(["mock", "cache_first", "real"]);
const DEMO_SEARCH_CACHE_TTL_MS = 15 * 60 * 1000;
const DEMO_SEARCH_BUDGET_MS = 14000;

interface DemoSearchCacheEntry {
  expiresAt: number;
  response: DemoSearchResponse;
}

const demoSearchResponseCache = new Map<string, DemoSearchCacheEntry>();

export class DemoSearchService {
  async search(
    request: DemoSearchRequest,
    userContext?: UserContext
  ): Promise<DemoSearchResponse> {
    const startedAt = Date.now();
    const identity = createDemoSearchIdentity(request.query, {
      count: request.count,
      dataMode: request.dataMode
    });
    const cacheKey = buildDemoSearchCacheKey(request, identity, userContext);
    const cachedResponse = readCachedDemoResponse(cacheKey, identity, startedAt);

    if (cachedResponse) {
      return cacheDemoResponse(cachedResponse);
    }

    if (request.dataMode === "real") {
      try {
        const response = await withRequestBudget(
          composeMultiLlmDemoSearchResponse({
            query: request.query,
            count: request.count,
            dataMode: request.dataMode,
            startedAt,
            requestBudgetMs: DEMO_SEARCH_BUDGET_MS,
            userContext
          }),
          DEMO_SEARCH_BUDGET_MS,
          "DEMO_SEARCH_BUDGET_TIMEOUT",
          `/api/demo/search exceeded ${DEMO_SEARCH_BUDGET_MS}ms request budget`
        );
        assertDemoSearchGrounding(response);
        return cacheDemoResponse(writeCachedDemoResponse(cacheKey, finalizeDemoMeta(response, startedAt), false));
      } catch (error) {
        logRealSearchFallback(error, request, startedAt);

        const response = createMockDemoSearchResponse(request.query, request.count, "mock", {
          fallbackUsed: true,
          fallbackReason: formatErrorSummary(error),
          requestedDataMode: request.dataMode,
          resolvedDataMode: "mock",
          pathSource: "fallback",
          notes: [
            "real mode fallback to mock demo data",
            formatErrorSummary(error)
          ]
        });
        response.contextUsed = createDemoContextUsed(userContext, [
          "intent_expand",
          "search_query_expand",
          "fit_reason"
        ]);
        response.meta.latencyMs = Date.now() - startedAt;
        response.meta.totalDurationMs = response.meta.latencyMs;
        response.meta.fallbackStages = unique([
          ...(response.meta.fallbackStages ?? []),
          isRequestBudgetTimeoutError(error) ? "request_budget" : "real_demo_search"
        ]);
        response.meta.timedOutStages = unique([
          ...(response.meta.timedOutStages ?? []),
          ...(isRequestBudgetTimeoutError(error) ? ["request_budget"] : [])
        ]);
        response.meta.llmStages = response.meta.llmStages?.length
          ? response.meta.llmStages
          : [
              {
                taskType: isRequestBudgetTimeoutError(error) ? "request_budget" : "real_demo_search",
                status: isRequestBudgetTimeoutError(error) ? "timeout" : "fallback",
                durationMs: response.meta.latencyMs,
                fallbackReason: formatErrorSummary(error)
              }
            ];
        response.debug.timings = [];
        assertDemoSearchGrounding(response);
        return cacheDemoResponse(writeCachedDemoResponse(cacheKey, response, false));
      }
    }

    const response = createMockDemoSearchResponse(request.query, request.count, request.dataMode, {
      notes:
        request.dataMode === "cache_first"
          ? ["cache_first miss; query-aware deterministic mock fallback generated"]
          : ["mock demo data; query-aware deterministic paths generated without LLM or Zhihu API"],
      pathSource: "fallback"
    });
    response.contextUsed = createDemoContextUsed(userContext);
    finalizeDemoMeta(response, startedAt);
    assertDemoSearchGrounding(response);
    return cacheDemoResponse(writeCachedDemoResponse(cacheKey, response, false));
  }
}

export const demoSearchService = new DemoSearchService();

export function parseDemoSearchRequest(body: unknown): DemoSearchRequest {
  const record = isRecord(body) ? body : {};
  const query = readString(record.query).trim();
  const dataMode = readString(record.dataMode) || readString(record.mode);

  if (!query) {
    throw new HttpError(400, "QUERY_REQUIRED", "Missing required body field: query");
  }

  return {
    query,
    count: parseCount(record.count),
    dataMode: parseDataMode(dataMode)
  };
}

function parseDataMode(value: unknown): DemoDataMode {
  const mode = readString(value) || config.dataMode;
  if (DATA_MODES.has(mode as DemoDataMode)) {
    return mode as DemoDataMode;
  }

  throw new HttpError(400, "DATA_MODE_INVALID", "dataMode must be mock, cache_first, or real");
}

function parseCount(value: unknown): number {
  const raw = readString(value);
  if (!raw) {
    return DEFAULT_COUNT;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_COUNT;
  }

  return Math.min(Math.max(parsed, 1), MAX_COUNT);
}

function readString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    return String(value);
  }

  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function logRealSearchFallback(
  error: unknown,
  request: DemoSearchRequest,
  startedAt: number
): void {
  console.error("[DemoSearch] real Zhihu search failed; falling back to mock", {
    query: request.query,
    count: request.count,
    requestedDataMode: request.dataMode,
    elapsedMs: Date.now() - startedAt,
    ...toLoggableError(error)
  });
}

function toLoggableError(error: unknown): {
  code: string;
  statusCode: number | null;
  message: string;
} {
  if (error instanceof HttpError) {
    return {
      code: error.code,
      statusCode: error.statusCode,
      message: error.message
    };
  }

  if (error instanceof Error) {
    return {
      code: "code" in error && typeof error.code === "string"
        ? error.code
        : error.name || "ERROR",
      statusCode: null,
      message: error.message || "Unknown error"
    };
  }

  return {
    code: "UNKNOWN_ERROR",
    statusCode: null,
    message: "Unknown error"
  };
}

function finalizeDemoMeta(response: DemoSearchResponse, startedAt: number): DemoSearchResponse {
  response.meta.latencyMs = Date.now() - startedAt;
  response.meta.totalDurationMs = response.meta.latencyMs;
  response.meta.fallbackStages = response.meta.fallbackStages ?? [];
  response.meta.llmStages = response.meta.llmStages ?? [];
  response.meta.timedOutStages = response.meta.timedOutStages ?? [];
  return response;
}

function formatErrorSummary(error: unknown): string {
  const loggableError = toLoggableError(error);
  return `${loggableError.code}: ${loggableError.message}`;
}

function cacheDemoResponse(response: DemoSearchResponse): DemoSearchResponse {
  response.features.personaChat = hasPersonaChatLlm() ? "real" : "mock";
  demoSessionCacheService.set(response);
  return response;
}

function readCachedDemoResponse(
  cacheKey: string,
  identity: DemoSearchIdentity,
  startedAt: number
): DemoSearchResponse | undefined {
  const entry = demoSearchResponseCache.get(cacheKey);
  if (!entry) {
    return undefined;
  }

  if (entry.expiresAt <= Date.now()) {
    demoSearchResponseCache.delete(cacheKey);
    return undefined;
  }

  const response = cloneDemoSearchResponse(entry.response);
  response.meta.latencyMs = Date.now() - startedAt;
  response.meta.totalDurationMs = response.meta.latencyMs;
  response.meta.fallbackStages = response.meta.fallbackStages ?? [];
  response.meta.llmStages = response.meta.llmStages ?? [];
  response.meta.timedOutStages = response.meta.timedOutStages ?? [];
  response.debug.cacheHit = true;
  response.debug.originalQuery = identity.originalQuery;
  response.debug.normalizedQuery = identity.normalizedQuery;
  response.debug.cacheKeyPreview = identity.cacheKeyPreview;
  response.debug.notes = unique([
    ...response.debug.notes,
    "memory cache hit for normalizedQuery + dataMode"
  ]);
  return response;
}

function writeCachedDemoResponse(
  cacheKey: string,
  response: DemoSearchResponse,
  cacheHit: boolean
): DemoSearchResponse {
  pruneExpiredDemoSearchCache();
  response.debug.cacheHit = cacheHit;
  demoSearchResponseCache.set(cacheKey, {
    expiresAt: Date.now() + DEMO_SEARCH_CACHE_TTL_MS,
    response: cloneDemoSearchResponse(response)
  });
  return response;
}

function pruneExpiredDemoSearchCache(): void {
  const now = Date.now();
  for (const [cacheKey, entry] of demoSearchResponseCache) {
    if (entry.expiresAt <= now) {
      demoSearchResponseCache.delete(cacheKey);
    }
  }
}

function buildDemoSearchCacheKey(
  request: DemoSearchRequest,
  identity: DemoSearchIdentity,
  userContext?: UserContext
): string {
  return [
    "demo_search_v2",
    `dataMode=${request.dataMode}`,
    `normalizedQuery=${identity.normalizedQuery.toLowerCase()}`,
    `count=${request.count}`,
    `context=${hashString(toUserContextCacheSeed(userContext))}`
  ].join("|");
}

function toUserContextCacheSeed(userContext?: UserContext): string {
  if (!userContext?.isLoggedIn) {
    return "anonymous";
  }

  return [
    userContext.provider,
    userContext.displayName ?? "",
    userContext.headline ?? ""
  ].join("|");
}

function hashString(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function cloneDemoSearchResponse(response: DemoSearchResponse): DemoSearchResponse {
  return JSON.parse(JSON.stringify(response)) as DemoSearchResponse;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
