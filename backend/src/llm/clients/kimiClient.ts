import { config } from "../../config/env.js";
import {
  createOpenAICompatibleJsonCompletion,
  type JsonCompletionInput,
  type LlmModelProvider
} from "./openaiCompatible.js";

export class KimiClient {
  readonly provider: LlmModelProvider = "kimi";

  get model(): string {
    return config.llm.kimi.model;
  }

  isConfigured(): boolean {
    return Boolean(config.llm.enabled && config.llm.kimi.apiKey);
  }

  createJsonCompletion(input: JsonCompletionInput): Promise<string> {
    return createOpenAICompatibleJsonCompletion(this.provider, {
      apiKey: config.llm.kimi.apiKey,
      baseUrl: config.llm.kimi.baseUrl,
      model: config.llm.kimi.model,
      timeoutMs: config.llm.timeoutMs,
      maxRetry: config.llm.maxRetry
    }, input);
  }
}

export const kimiClient = new KimiClient();
