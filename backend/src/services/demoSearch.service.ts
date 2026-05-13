import { config } from "../config/env.js";
import { assertDemoSearchGrounding } from "../guards/demoEvidence.guard.js";
import {
  composeMultiLlmDemoSearchResponse,
  hasPersonaChatLlm
} from "../llm/demoSearchOrchestrator.js";
import { createMockDemoSearchResponse } from "../mocks/demoSearch.mock.js";
import { demoSessionCacheService } from "./demoSessionCache.service.js";
import { createDemoContextUsed } from "./userContext.service.js";
import type { UserContext } from "../auth/session.js";
import { type DemoDataMode, type DemoSearchResponse } from "../types/demo.types.js";
import { HttpError } from "../utils/httpError.js";

export interface DemoSearchRequest {
  query: string;
  count: number;
  dataMode: DemoDataMode;
}

const DEFAULT_COUNT = 5;
const MAX_COUNT = 20;
const DATA_MODES = new Set<DemoDataMode>(["mock", "cache_first", "real"]);

export class DemoSearchService {
  async search(
    request: DemoSearchRequest,
    userContext?: UserContext
  ): Promise<DemoSearchResponse> {
    const startedAt = Date.now();

    if (request.dataMode === "real") {
      try {
        const response = await composeMultiLlmDemoSearchResponse({
          query: request.query,
          count: request.count,
          dataMode: request.dataMode,
          startedAt,
          userContext
        });
        assertDemoSearchGrounding(response);
        return cacheDemoResponse(response);
      } catch (error) {
        logRealSearchFallback(error, request, startedAt);

        const response = createMockDemoSearchResponse(request.query, request.count, "mock", {
          fallbackUsed: true,
          fallbackReason: formatErrorSummary(error),
          requestedDataMode: request.dataMode,
          resolvedDataMode: "mock",
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
        assertDemoSearchGrounding(response);
        return cacheDemoResponse(response);
      }
    }

    const response = createMockDemoSearchResponse(request.query, request.count, request.dataMode, {
      notes:
        request.dataMode === "cache_first"
          ? ["cache_first currently uses bundled mock seed for demo continuity"]
          : ["mock demo data; no LLM or Zhihu API required"]
    });
    response.contextUsed = createDemoContextUsed(userContext);
    response.meta.latencyMs = Date.now() - startedAt;
    assertDemoSearchGrounding(response);
    return cacheDemoResponse(response);
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
      code: error.name || "ERROR",
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

function formatErrorSummary(error: unknown): string {
  const loggableError = toLoggableError(error);
  return `${loggableError.code}: ${loggableError.message}`;
}

function cacheDemoResponse(response: DemoSearchResponse): DemoSearchResponse {
  response.features.personaChat = hasPersonaChatLlm() ? "real" : "mock";
  demoSessionCacheService.set(response);
  return response;
}
