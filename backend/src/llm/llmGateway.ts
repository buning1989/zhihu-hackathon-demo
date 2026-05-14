import { config } from "../config/env.js";
import {
  createOpenAICompatibleJsonCompletion,
  LlmClientError,
  type JsonCompletionInput,
  type LlmMessage,
  type LlmModelProvider,
  type OpenAICompatibleClientConfig
} from "./clients/openaiCompatible.js";
import { parseLlmJson } from "./llmJson.js";
import type {
  LlmGatewayErrorType,
  LlmGatewayInput,
  LlmGatewayMockScenario,
  LlmGatewayOutput,
  LlmGatewayStatus
} from "./llmGatewayTypes.js";

class LlmGatewayInternalError extends Error {
  constructor(
    readonly errorType: LlmGatewayErrorType,
    message: string,
    readonly status: LlmGatewayStatus = "error",
    readonly rawText = ""
  ) {
    super(message);
    this.name = "LlmGatewayInternalError";
  }
}

export class LlmGateway {
  async runJson<TData>(input: LlmGatewayInput<TData>): Promise<LlmGatewayOutput<TData>> {
    const startedAt = Date.now();
    const provider = input.provider ?? config.agent.llm.provider;
    const model = resolveModel(provider, input.model);
    const timeoutMs = input.timeoutMs ?? config.agent.llm.timeoutMs;
    const retries = input.retries ?? config.agent.llm.retries;

    await emitGatewayEvent(input, "llm.call.started", {
      stageName: input.stageName,
      provider,
      model,
      timeoutMs,
      attempts: 0
    });

    if (!config.agent.llm.enabled) {
      return buildFallbackOutput(input, {
        provider,
        model,
        attempts: 0,
        startedAt,
        status: "fallback",
        errorType: "PROVIDER_UNAVAILABLE",
        fallbackReason: "AGENT_LLM_DISABLED: AGENT_LLM_ENABLED is false",
        rawText: ""
      });
    }

    if (config.agent.llm.testMode !== "mock") {
      const providerConfig = resolveProviderConfig(provider, model);
      if (!providerConfig.configured) {
        return buildFallbackOutput(input, {
          provider,
          model,
          attempts: 0,
          startedAt,
          status: "fallback",
          errorType: "PROVIDER_UNAVAILABLE",
          fallbackReason: providerConfig.reason,
          rawText: ""
        });
      }
    }

    const maxAttempts = Math.max(retries, 0) + 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const rawText = await callWithTimeout(callProvider(input, provider, model, timeoutMs), timeoutMs);
        const parsed = parseLlmJson(rawText);
        if (!parsed.ok) {
          throw new LlmGatewayInternalError(
            "JSON_PARSE_FAILED",
            `${input.schemaName} JSON parse failed: ${parsed.error}`,
            "fallback",
            rawText
          );
        }

        if (!input.validate(parsed.data)) {
          throw new LlmGatewayInternalError(
            "SCHEMA_VALIDATION_FAILED",
            `${input.schemaName} schema validation failed`,
            "fallback",
            rawText
          );
        }

        const durationMs = Date.now() - startedAt;
        await emitGatewayEvent(input, "llm.call.completed", {
          stageName: input.stageName,
          provider,
          model,
          timeoutMs,
          durationMs,
          status: "success",
          attempts: attempt
        });

        return {
          status: "success",
          data: parsed.data as TData,
          rawText,
          model,
          provider,
          attempts: attempt,
          durationMs,
          fallbackUsed: false,
          fallbackReason: ""
        };
      } catch (error) {
        lastError = error;
        const classified = classifyGatewayError(error);
        const canRetry = attempt < maxAttempts && isRetryableError(classified.errorType);

        if (canRetry) {
          await emitGatewayEvent(input, "llm.call.retrying", {
            stageName: input.stageName,
            provider,
            model,
            timeoutMs,
            durationMs: Date.now() - startedAt,
            status: classified.status,
            attempts: attempt,
            fallbackReason: classified.message,
            errorType: classified.errorType
          });
          continue;
        }

        return buildFallbackOutput(input, {
          provider,
          model,
          attempts: attempt,
          startedAt,
          status: classified.status,
          errorType: classified.errorType,
          fallbackReason: classified.message,
          rawText: readRawText(error)
        });
      }
    }

    const classified = classifyGatewayError(lastError);
    return buildFallbackOutput(input, {
      provider,
      model,
      attempts: maxAttempts,
      startedAt,
      status: classified.status,
      errorType: classified.errorType,
      fallbackReason: classified.message,
      rawText: readRawText(lastError)
    });
  }
}

export const llmGateway = new LlmGateway();

async function callProvider<TData>(
  input: LlmGatewayInput<TData>,
  provider: LlmModelProvider,
  model: string,
  timeoutMs: number
): Promise<string> {
  if (config.agent.llm.testMode === "mock") {
    return createMockCompletion(input, timeoutMs);
  }

  const providerConfig = resolveProviderConfig(provider, model);
  if (!providerConfig.configured) {
    throw new LlmGatewayInternalError(
      "PROVIDER_UNAVAILABLE",
      providerConfig.reason,
      "fallback"
    );
  }

  const completionInput: JsonCompletionInput = {
    messages: buildMessages(input),
    temperature: input.temperature ?? 0.2,
    maxTokens: input.maxTokens ?? 1200,
    responseFormat: input.responseFormat ?? { type: "json_object" },
    timeoutMs,
    maxRetry: 0,
    taskType: input.stageName
  };

  return createOpenAICompatibleJsonCompletion(provider, providerConfig.config, completionInput);
}

async function createMockCompletion<TData>(
  input: LlmGatewayInput<TData>,
  timeoutMs: number
): Promise<string> {
  const scenario = readMockScenario(input.metadata);

  if (scenario === "timeout") {
    await delay(timeoutMs + 50);
  }

  if (scenario === "error") {
    throw new LlmGatewayInternalError("REQUEST_FAILED", "mock LLM request failed", "error");
  }

  if (scenario === "malformed_json") {
    return "{\"expandedQueries\":[";
  }

  if (scenario === "schema_invalid") {
    return JSON.stringify({
      originalQuery: 123,
      expandedQueries: "not-an-array",
      strategy: "bad"
    });
  }

  const originalQuery = readString(input.metadata?.originalQuery) || "不工作了能去哪儿";
  return JSON.stringify({
    originalQuery,
    expandedQueries: uniqueNonEmpty([
      originalQuery,
      `${originalQuery} 真实经历`,
      "裸辞后去小城市",
      "不上班后怎么生活",
      "自由职业真实经历"
    ]).slice(0, 5),
    searchAngles: [
      "离开职场后的生活路径",
      "裸辞后的风险和转折",
      "自由职业或小城市生活样本"
    ],
    negativeKeywords: [],
    targetPersonTypes: [
      "裸辞转自由职业的人",
      "离开一线城市的人",
      "gap 后重新工作的人"
    ],
    strategy: "llm_planned",
    llmUsed: true
  });
}

async function buildFallbackOutput<TData>(
  input: LlmGatewayInput<TData>,
  options: {
    provider: LlmModelProvider;
    model: string;
    attempts: number;
    startedAt: number;
    status: LlmGatewayStatus;
    errorType: LlmGatewayErrorType;
    fallbackReason: string;
    rawText: string;
  }
): Promise<LlmGatewayOutput<TData>> {
  const durationMs = Date.now() - options.startedAt;
  const data = input.fallback({
    status: options.status,
    fallbackReason: options.fallbackReason,
    errorType: options.errorType,
    attempts: options.attempts,
    durationMs
  });

  await emitGatewayEvent(input, "llm.call.fallback", {
    stageName: input.stageName,
    provider: options.provider,
    model: options.model,
    timeoutMs: input.timeoutMs ?? config.agent.llm.timeoutMs,
    durationMs,
    status: options.status,
    attempts: options.attempts,
    fallbackReason: options.fallbackReason,
    errorType: options.errorType
  });

  return {
    status: options.status,
    data,
    rawText: options.rawText,
    model: options.model,
    provider: options.provider,
    attempts: options.attempts,
    durationMs,
    fallbackUsed: true,
    fallbackReason: options.fallbackReason,
    errorType: options.errorType
  };
}

function resolveProviderConfig(
  provider: LlmModelProvider,
  model: string
): { configured: true; config: OpenAICompatibleClientConfig } | { configured: false; reason: string } {
  const providerConfig =
    provider === "kimi"
      ? {
          apiKey: config.llm.kimi.apiKey,
          baseUrl: config.llm.kimi.baseUrl,
          model
        }
      : {
          apiKey: config.llm.deepseek.apiKey,
          baseUrl: config.llm.deepseek.baseUrl,
          model
        };

  const missing = [
    [`${provider.toUpperCase()}_API_KEY`, providerConfig.apiKey],
    [`${provider.toUpperCase()}_BASE_URL`, providerConfig.baseUrl],
    ["AGENT_LLM_MODEL", providerConfig.model]
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    return {
      configured: false,
      reason: `AGENT_LLM_PROVIDER_UNAVAILABLE: missing ${missing.join(", ")}`
    };
  }

  return {
    configured: true,
    config: {
      ...providerConfig,
      timeoutMs: config.agent.llm.timeoutMs,
      maxRetry: 0
    }
  };
}

function resolveModel(provider: LlmModelProvider, inputModel: string | undefined): string {
  if (inputModel?.trim()) {
    return inputModel.trim();
  }

  if (config.agent.llm.model) {
    return config.agent.llm.model;
  }

  return provider === "kimi" ? config.llm.kimi.model : config.llm.deepseek.model;
}

function buildMessages<TData>(input: LlmGatewayInput<TData>): LlmMessage[] {
  if (input.messages && input.messages.length > 0) {
    return input.messages;
  }

  return [
    {
      role: "user",
      content: input.prompt ?? ""
    }
  ];
}

async function callWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new LlmGatewayInternalError("TIMEOUT", "LLM gateway call timed out", "timeout"));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function classifyGatewayError(error: unknown): {
  errorType: LlmGatewayErrorType;
  status: LlmGatewayStatus;
  message: string;
} {
  if (error instanceof LlmGatewayInternalError) {
    return {
      errorType: error.errorType,
      status: error.status,
      message: error.message
    };
  }

  if (error instanceof LlmClientError) {
    const errorType = error.code === "LLM_TIMEOUT" ? "TIMEOUT" : "REQUEST_FAILED";
    return {
      errorType,
      status: errorType === "TIMEOUT" ? "timeout" : "error",
      message: `${error.code}: ${truncateText(error.message, 220)}`
    };
  }

  if (error instanceof Error) {
    return {
      errorType: "UNKNOWN_ERROR",
      status: "error",
      message: truncateText(error.message, 220)
    };
  }

  return {
    errorType: "UNKNOWN_ERROR",
    status: "error",
    message: "Unknown LLM gateway error"
  };
}

function isRetryableError(errorType: LlmGatewayErrorType): boolean {
  return errorType === "TIMEOUT" || errorType === "REQUEST_FAILED" || errorType === "UNKNOWN_ERROR";
}

function readRawText(error: unknown): string {
  return error instanceof LlmGatewayInternalError ? error.rawText : "";
}

async function emitGatewayEvent<TData>(
  input: LlmGatewayInput<TData>,
  type: string,
  payload: Parameters<NonNullable<LlmGatewayInput<TData>["onEvent"]>>[1]
): Promise<void> {
  if (!input.onEvent) {
    return;
  }

  await input.onEvent(type, payload);
}

function readMockScenario(metadata: Record<string, unknown> | undefined): LlmGatewayMockScenario {
  const scenario = readString(metadata?.mockScenario);
  return ["success", "timeout", "schema_invalid", "malformed_json", "error"].includes(scenario)
    ? (scenario as LlmGatewayMockScenario)
    : "success";
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = value.trim();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }

  return result;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(maxLength - 3, 0))}...`;
}
