import { config } from "../../config/env.js";
import {
  createOpenAICompatibleJsonCompletion,
  type JsonCompletionInput,
  type LlmModelProvider
} from "./openaiCompatible.js";

export class DeepSeekClient {
  readonly provider: LlmModelProvider = "deepseek";

  get model(): string {
    return config.llm.deepseek.model;
  }

  isConfigured(): boolean {
    return Boolean(config.llm.enabled && config.llm.deepseek.apiKey);
  }

  createJsonCompletion(input: JsonCompletionInput): Promise<string> {
    return createOpenAICompatibleJsonCompletion(this.provider, {
      apiKey: config.llm.deepseek.apiKey,
      baseUrl: config.llm.deepseek.baseUrl,
      model: config.llm.deepseek.model,
      timeoutMs: config.llm.timeoutMs,
      maxRetry: config.llm.maxRetry
    }, {
      ...input,
      responseFormat: input.responseFormat ?? { type: "json_object" }
    });
  }
}

export const deepSeekClient = new DeepSeekClient();
