import { config } from "../config/env.js";
import { deepSeekClient } from "./clients/deepseekClient.js";
import { kimiClient } from "./clients/kimiClient.js";
import {
  LlmClientError,
  type JsonCompletionInput,
  type LlmMessage,
  type LlmModelProvider
} from "./clients/openaiCompatible.js";

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
    public readonly modelProvider: LlmModelProvider
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
      const content = await client.createJsonCompletion({
        ...input,
        taskType
      });
      logLlmCall(taskType, client, "success", startedAt);
      return content;
    } catch (error) {
      logLlmCall(taskType, client, "fallback", startedAt, error);
      throw error;
    }
  }
}

export const llmRouter = new LlmRouter();

function getClientForTask(taskType: LlmTaskType): RoutedClient {
  if (
    taskType === "evidence_extract" ||
    taskType === "experience_summary" ||
    taskType === "persona_chat"
  ) {
    return kimiClient;
  }

  return deepSeekClient;
}

function logLlmCall(
  taskType: LlmTaskType,
  client: RoutedClient,
  status: "success" | "fallback",
  startedAt: number,
  error?: unknown
): void {
  const payload = {
    taskType,
    modelProvider: client.provider,
    model: client.model,
    status,
    durationMs: Date.now() - startedAt,
    ...(error ? { error: toSafeError(error) } : {})
  };

  if (status === "success") {
    console.info("[LLM]", payload);
  } else {
    console.warn("[LLM]", payload);
  }
}

function toSafeError(error: unknown): { code: string; message: string; responseBody?: string } {
  if (error instanceof LlmRouterError) {
    return {
      code: error.code,
      message: error.message
    };
  }

  if (error instanceof LlmClientError) {
    return {
      code: error.code,
      message: truncateText(error.message || "Unknown LLM error", 260),
      ...(error.responseBody ? { responseBody: truncateText(error.responseBody, 260) } : {})
    };
  }

  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : error.name;
    return {
      code: code || "LLM_ERROR",
      message: truncateText(error.message || "Unknown LLM error", 160)
    };
  }

  return {
    code: "LLM_ERROR",
    message: "Unknown LLM error"
  };
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

export type { LlmMessage };
