import { config } from "../../config/env.js";
import {
  createOpenAICompatibleJsonCompletion,
  type JsonCompletionInput,
  type LlmModelProvider
} from "./openaiCompatible.js";

export class DeepSeekClient {
  readonly provider: LlmModelProvider = "deepseek";

  get model(): string {
    return config.llm.deepseek.defaultModel;
  }

  getModelForTask(taskType: string): string {
    return readDeepSeekTaskModel(taskType);
  }

  isConfigured(): boolean {
    return Boolean(config.llm.enabled && config.llm.deepseek.apiKey);
  }

  createJsonCompletion(input: JsonCompletionInput): Promise<string> {
    const model = this.getModelForTask(input.taskType);
    return createOpenAICompatibleJsonCompletion(this.provider, {
      apiKey: config.llm.deepseek.apiKey,
      baseUrl: config.llm.deepseek.baseUrl,
      model,
      timeoutMs: config.llm.timeoutMs,
      maxRetry: config.llm.maxRetry
    }, {
      ...input,
      responseFormat: config.llm.deepseek.jsonMode
        ? input.responseFormat ?? { type: "json_object" }
        : undefined
    });
  }
}

export const deepSeekClient = new DeepSeekClient();

function readDeepSeekTaskModel(taskType: string): string {
  const models = config.llm.deepseek.models as Record<string, string>;
  return models[taskType] || config.llm.deepseek.defaultModel;
}
