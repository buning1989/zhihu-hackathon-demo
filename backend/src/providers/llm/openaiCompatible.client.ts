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
    assertConfigured();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.llm.timeoutMs);

    try {
      const response = await fetch(toChatCompletionsUrl(config.llm.baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.llm.apiKey}`
        },
        body: JSON.stringify({
          model: config.llm.model,
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

      return content;
    } catch (error) {
      if (isAbortError(error)) {
        throw new LlmProviderError("LLM_TIMEOUT", "LLM request timed out");
      }

      if (error instanceof LlmProviderError) {
        throw error;
      }

      throw new LlmProviderError("LLM_REQUEST_FAILED", toErrorMessage(error));
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const llmClient = new OpenAICompatibleClient();

function assertConfigured(): void {
  if (!config.llm.apiKey) {
    throw new LlmProviderError("LLM_API_KEY_MISSING", "LLM_API_KEY is not configured");
  }

  if (!config.llm.baseUrl) {
    throw new LlmProviderError("LLM_BASE_URL_MISSING", "LLM_BASE_URL is not configured");
  }

  if (!config.llm.model) {
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
    return error.message;
  }

  return "Unknown LLM request error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
