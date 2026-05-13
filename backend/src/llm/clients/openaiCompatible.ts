export type LlmModelProvider = "kimi" | "deepseek";

export type LlmMessageRole = "system" | "user" | "assistant";

export interface LlmMessage {
  role: LlmMessageRole;
  content: string;
}

export interface JsonCompletionInput {
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: JsonResponseFormat;
  taskType: string;
}

export interface JsonResponseFormat {
  type: "json_object";
}

export interface OpenAICompatibleClientConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxRetry: number;
}

export class LlmClientError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "LlmClientError";
  }
}

export async function createOpenAICompatibleJsonCompletion(
  provider: LlmModelProvider,
  config: OpenAICompatibleClientConfig,
  input: JsonCompletionInput
): Promise<string> {
  assertConfigured(provider, config);

  const attempts = Math.max(config.maxRetry, 0) + 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestJsonCompletion(provider, config, input);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableError(error)) {
        break;
      }
    }
  }

  if (lastError instanceof LlmClientError) {
    throw lastError;
  }

  throw new LlmClientError("LLM_REQUEST_FAILED", toErrorMessage(lastError));
}

async function requestJsonCompletion(
  provider: LlmModelProvider,
  config: OpenAICompatibleClientConfig,
  input: JsonCompletionInput
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(toChatCompletionsUrl(config.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        messages: input.messages,
        temperature: input.temperature ?? 0.2,
        max_tokens: input.maxTokens ?? 3000,
        stream: false,
        ...(input.responseFormat ? { response_format: input.responseFormat } : {})
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new LlmClientError(
        `LLM_HTTP_${response.status}`,
        `${provider} request failed with HTTP status ${response.status}`
      );
    }

    const payload: unknown = await response.json();
    const content = readAssistantContent(payload);
    if (!content) {
      throw new LlmClientError("LLM_EMPTY_RESPONSE", `${provider} response did not include content`);
    }

    return content;
  } catch (error) {
    if (isAbortError(error)) {
      throw new LlmClientError("LLM_TIMEOUT", `${provider} request timed out`);
    }

    if (error instanceof LlmClientError) {
      throw error;
    }

    throw new LlmClientError("LLM_REQUEST_FAILED", toErrorMessage(error));
  } finally {
    clearTimeout(timeout);
  }
}

function assertConfigured(provider: LlmModelProvider, config: OpenAICompatibleClientConfig): void {
  if (!config.apiKey) {
    throw new LlmClientError("LLM_API_KEY_MISSING", `${provider} API key is not configured`);
  }

  if (!config.baseUrl) {
    throw new LlmClientError("LLM_BASE_URL_MISSING", `${provider} base URL is not configured`);
  }

  if (!config.model) {
    throw new LlmClientError("LLM_MODEL_MISSING", `${provider} model is not configured`);
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

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof LlmClientError)) {
    return true;
  }

  return (
    error.code === "LLM_TIMEOUT" ||
    error.code === "LLM_REQUEST_FAILED" ||
    error.code === "LLM_HTTP_408" ||
    error.code === "LLM_HTTP_409" ||
    error.code === "LLM_HTTP_429" ||
    /^LLM_HTTP_5\d\d$/.test(error.code)
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Unknown LLM request error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
