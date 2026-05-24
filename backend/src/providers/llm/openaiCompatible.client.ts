import { config } from "../../config/env.js";

export type LlmMessageRole = "system" | "user" | "assistant";

export interface LlmMessage {
  role: LlmMessageRole;
  content: string;
}

export interface CreateJsonCompletionInput {
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  taskType?: string;
}

export class LlmProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "LlmProviderError";
  }
}

export class OpenAICompatibleClient {
  async createJsonCompletion(input: CreateJsonCompletionInput): Promise<string> {
    const taskType = input.taskType ?? "legacy_json_completion";
    const effectiveConfig = readEffectiveConfig(taskType);
    const startedAt = Date.now();

    try {
      assertConfigured(effectiveConfig);
    } catch (error) {
      if (error instanceof LlmProviderError) {
        logLegacyLlmCall(taskType, effectiveConfig, "fallback", startedAt, error);
      }
      throw error;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.llm.timeoutMs);

    try {
      const response = await fetch(toChatCompletionsUrl(effectiveConfig.baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${effectiveConfig.apiKey}`
        },
        body: JSON.stringify({
          model: effectiveConfig.model,
          messages: input.messages,
          temperature: input.temperature ?? 0.2,
          max_tokens: input.maxTokens ?? 3000,
          stream: false,
          response_format: { type: "json_object" }
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new LlmProviderError(
          `LLM_HTTP_${response.status}`,
          `LLM request failed with HTTP status ${response.status}`
        );
      }

      const payload: unknown = await response.json();
      const content = readAssistantContent(payload);
      if (!content) {
        throw new LlmProviderError("LLM_EMPTY_RESPONSE", "LLM response did not include content");
      }

      logLegacyLlmCall(taskType, effectiveConfig, "success", startedAt);
      return content;
    } catch (error) {
      if (isAbortError(error)) {
        const timeoutError = new LlmProviderError("LLM_TIMEOUT", "LLM request timed out");
        logLegacyLlmCall(taskType, effectiveConfig, "timeout", startedAt, timeoutError);
        throw timeoutError;
      }

      if (error instanceof LlmProviderError) {
        logLegacyLlmCall(taskType, effectiveConfig, "fallback", startedAt, error);
        throw error;
      }

      const requestError = new LlmProviderError("LLM_REQUEST_FAILED", toErrorMessage(error));
      logLegacyLlmCall(taskType, effectiveConfig, "fallback", startedAt, requestError);
      throw requestError;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const llmClient = new OpenAICompatibleClient();

interface EffectiveLlmConfig {
  provider: "deepseek" | "openai_compatible";
  apiKey: string;
  baseUrl: string;
  model: string;
}

function readEffectiveConfig(taskType: string): EffectiveLlmConfig {
  const usesDeepSeekConfig = Boolean(config.llm.deepseek.apiKey || !config.llm.apiKey);
  return {
    provider: usesDeepSeekConfig ? "deepseek" : "openai_compatible",
    apiKey: usesDeepSeekConfig ? config.llm.deepseek.apiKey : config.llm.apiKey,
    baseUrl: usesDeepSeekConfig ? config.llm.deepseek.baseUrl : config.llm.baseUrl,
    model: readDeepSeekModelForLegacyTask(taskType)
  };
}

function assertConfigured(effectiveConfig: EffectiveLlmConfig): void {
  if (!effectiveConfig.apiKey) {
    throw new LlmProviderError("LLM_API_KEY_MISSING", "LLM_API_KEY is not configured");
  }

  if (!effectiveConfig.baseUrl) {
    throw new LlmProviderError("LLM_BASE_URL_MISSING", "LLM_BASE_URL is not configured");
  }

  if (!effectiveConfig.model) {
    throw new LlmProviderError("LLM_MODEL_MISSING", "LLM_MODEL is not configured");
  }
}

function toChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) {
    return trimmed;
  }

  return `${trimmed}/chat/completions`;
}

function readAssistantContent(payload: unknown): string {
  const choices = isRecord(payload) && Array.isArray(payload.choices) ? payload.choices : [];
  const firstChoice = choices[0];
  const message = isRecord(firstChoice) && isRecord(firstChoice.message) ? firstChoice.message : {};
  const content = isRecord(message) ? message.content : undefined;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if (isRecord(part) && typeof part.text === "string") {
          return part.text;
        }

        return "";
      })
      .join("")
      .trim();
  }

  return "";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return redactSensitiveText(error.message);
  }

  return "Unknown LLM request error";
}

function logLegacyLlmCall(
  taskType: string,
  effectiveConfig: EffectiveLlmConfig,
  status: "success" | "fallback" | "timeout",
  startedAt: number,
  error?: LlmProviderError
): void {
  const fields: Array<[string, string | number | undefined]> = [
    ["provider", effectiveConfig.provider],
    ["model", effectiveConfig.model],
    ["taskType", taskType],
    ["durationMs", Date.now() - startedAt],
    ["status", status],
    ["errorCode", error?.code],
    ["errorMessage", error ? redactSensitiveText(error.message) : undefined]
  ];
  const line = `[LLM] ${fields
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${formatLogValue(value)}`)
    .join(" ")}`;

  if (status === "success") {
    console.info(line);
  } else {
    console.warn(line);
  }
}

function readDeepSeekModelForLegacyTask(taskType: string): string {
  if (taskType.endsWith("_json_repair") || taskType === "json_repair") {
    return config.llm.deepseek.models.json_repair;
  }

  if (
    taskType === "path_enhancer" ||
    taskType === "people_enhancer" ||
    taskType === "persona_enhancer" ||
    taskType === "legacy_json_completion"
  ) {
    return config.llm.deepseek.models.demo_response_compose;
  }

  const models = config.llm.deepseek.models as Record<string, string>;
  return models[taskType] || config.llm.deepseek.defaultModel;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
