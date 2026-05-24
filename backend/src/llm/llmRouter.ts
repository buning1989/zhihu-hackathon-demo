import { config } from "../config/env.js";
import { deepSeekClient } from "./clients/deepseekClient.js";
import {
  LlmClientError,
  type JsonCompletionInput,
  type LlmMessage,
  type LlmModelProvider
} from "./clients/openaiCompatible.js";
import {
  getLlmTaskTimeoutMs,
  isLlmTaskTimeoutError,
  withLlmTaskTimeout
} from "./llmTimeout.js";

export type LlmTaskType =
  | "intent_expand"
  | "candidate_rerank"
  | "evidence_extract"
  | "demo_response_compose"
  | "experience_summary"
  | "grounding_guard"
  | "persona_chat";

interface RoutedClient {
  provider: LlmModelProvider;
  model: string;
  isConfigured(): boolean;
  createJsonCompletion(input: JsonCompletionInput): Promise<string>;
}

export class LlmRouterError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly taskType: LlmTaskType,
    public readonly provider: LlmModelProvider
  ) {
    super(message);
    this.name = "LlmRouterError";
  }
}

export class LlmRouter {
  isTaskConfigured(taskType: LlmTaskType): boolean {
    const client = getClientForTask(taskType);
    return Boolean(config.llm.enabled && client.isConfigured());
  }

  getProviderForTask(taskType: LlmTaskType): LlmModelProvider {
    return getClientForTask(taskType).provider;
  }

  getModelForTask(taskType: LlmTaskType): string {
    return getClientForTask(taskType).model;
  }

  async runJsonTask(
    taskType: LlmTaskType,
    input: Omit<JsonCompletionInput, "taskType">
  ): Promise<string> {
    const client = getClientForTask(taskType);
    const startedAt = Date.now();
    const timeoutMs = input.timeoutMs ?? getLlmTaskTimeoutMs(taskType);

    if (!config.llm.enabled) {
      const error = new LlmRouterError(
        "LLM_DISABLED",
        "LLM_ENABLED is false or no provider key is configured",
        taskType,
        client.provider
      );
      logLlmCall(taskType, client, "fallback", startedAt, error);
      throw error;
    }

    if (!client.isConfigured()) {
      const error = new LlmRouterError(
        "LLM_PROVIDER_UNAVAILABLE",
        `${client.provider} is not configured for ${taskType}`,
        taskType,
        client.provider
      );
      logLlmCall(taskType, client, "fallback", startedAt, error);
      throw error;
    }

    try {
      const content = await withLlmTaskTimeout(
        taskType,
        client.createJsonCompletion({
          ...input,
          timeoutMs,
          maxRetry: input.maxRetry ?? 0,
          taskType
        }),
        timeoutMs
      );
      logLlmCall(taskType, client, "success", startedAt, undefined, timeoutMs);
      return content;
    } catch (error) {
      logLlmCall(
        taskType,
        client,
        isTimeoutError(error) ? "timeout" : "fallback",
        startedAt,
        error,
        timeoutMs
      );
      throw error;
    }
  }
}

export const llmRouter = new LlmRouter();

function getClientForTask(taskType: LlmTaskType): RoutedClient {
  return {
    provider: deepSeekClient.provider,
    model: deepSeekClient.getModelForTask(taskType),
    isConfigured: () => deepSeekClient.isConfigured(),
    createJsonCompletion: (input) => deepSeekClient.createJsonCompletion(input)
  };
}

function logLlmCall(
  taskType: LlmTaskType,
  client: RoutedClient,
  status: "success" | "fallback" | "timeout",
  startedAt: number,
  error?: unknown,
  timeoutMs?: number
): void {
  const safeError = error ? toSafeError(error) : undefined;
  const payload = {
    taskType,
    provider: client.provider,
    model: client.model,
    status,
    durationMs: Date.now() - startedAt,
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(safeError ? { fallbackReason: safeError.message, error: safeError } : {})
  };

  if (status === "success") {
    console.info(formatLlmLogLine("[LLM]", payload));
  } else {
    console.warn(formatLlmLogLine("[LLM]", payload));
  }
}

function toSafeError(error: unknown): { code: string; message: string; responseBody?: string } {
  if (isLlmTaskTimeoutError(error)) {
    return {
      code: error.code,
      message: error.message
    };
  }

  if (error instanceof LlmRouterError) {
    return {
      code: error.code,
      message: error.message
    };
  }

  if (error instanceof LlmClientError) {
    return {
      code: error.code,
      message: truncateText(redactSensitiveText(error.message || "Unknown LLM error"), 260),
      ...(error.responseBody
        ? { responseBody: truncateText(redactSensitiveText(error.responseBody), 260) }
        : {})
    };
  }

  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : error.name;
    return {
      code: code || "LLM_ERROR",
      message: truncateText(redactSensitiveText(error.message || "Unknown LLM error"), 160)
    };
  }

  return {
    code: "LLM_ERROR",
    message: "Unknown LLM error"
  };
}

function isTimeoutError(error: unknown): boolean {
  return (
    isLlmTaskTimeoutError(error) ||
    (error instanceof LlmClientError && error.code === "LLM_TIMEOUT")
  );
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function formatLlmLogLine(
  prefix: string,
  payload: {
    provider: string;
    model: string;
    taskType: string;
    durationMs: number;
    status: string;
    timeoutMs?: number;
    fallbackReason?: string;
    error?: { code: string; message: string; responseBody?: string };
  }
): string {
  const fields: Array<[string, string | number | undefined]> = [
    ["provider", payload.provider],
    ["model", payload.model],
    ["taskType", payload.taskType],
    ["durationMs", payload.durationMs],
    ["status", payload.status],
    ["timeoutMs", payload.timeoutMs],
    ["fallbackReason", payload.fallbackReason],
    ["errorCode", payload.error?.code],
    ["errorMessage", payload.error?.message]
  ];

  return `${prefix} ${fields
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${formatLogValue(value)}`)
    .join(" ")}`;
}

function formatLogValue(value: string | number | undefined): string {
  if (typeof value === "number") {
    return String(value);
  }

  const safeValue = redactSensitiveText(String(value ?? ""));
  return /\s/.test(safeValue) ? JSON.stringify(safeValue) : safeValue;
}

function redactSensitiveText(value: string): string {
  const knownSecrets = [
    config.llm.apiKey,
    config.llm.deepseek.apiKey,
    config.llm.kimi.apiKey
  ].filter((secret) => secret.length >= 8);

  let redacted = value;
  for (const secret of knownSecrets) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }

  return redacted
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(api[_-]?key["'\s:=]+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/(authorization["'\s:=]+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]");
}

export type { LlmMessage };
