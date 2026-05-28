import { config } from "../config/env.js";
import type { LlmTaskType } from "./llmRouter.js";

export const LLM_TASK_TIMEOUT_MS: Record<LlmTaskType, number> = {
  similarity_clarification_plan: 24000,
  intent_expand: 45000,
  candidate_rerank: 12000,
  evidence_extract: 12000,
  demo_response_compose: 15000,
  experience_summary: 12000,
  grounding_guard: 8000,
  persona_chat: 8000
};

export class LlmTaskTimeoutError extends Error {
  readonly code = "LLM_TASK_TIMEOUT";

  constructor(
    public readonly taskType: LlmTaskType,
    public readonly timeoutMs: number
  ) {
    super(`${taskType} exceeded ${timeoutMs}ms hard timeout`);
    this.name = "LlmTaskTimeoutError";
  }
}

export function getLlmTaskTimeoutMs(taskType: LlmTaskType): number {
  if (taskType === "similarity_clarification_plan") {
    return config.llm.taskTimeouts.similarityClarificationPlanMs;
  }

  switch (taskType) {
    case "intent_expand":
      return config.llm.taskTimeouts.intentExpandMs;
    case "candidate_rerank":
      return config.llm.taskTimeouts.candidateRerankMs;
    case "evidence_extract":
      return config.llm.taskTimeouts.evidenceExtractMs;
    case "demo_response_compose":
      return config.llm.taskTimeouts.demoResponseComposeMs;
    case "experience_summary":
      return config.llm.taskTimeouts.experienceSummaryMs;
    case "grounding_guard":
      return config.llm.taskTimeouts.groundingGuardMs;
    case "persona_chat":
      return config.llm.taskTimeouts.personaChatMs;
    default:
      return LLM_TASK_TIMEOUT_MS[taskType];
  }
}

export function getAgentLlmTaskTimeoutMs(
  taskType: "evidence_extract" | "experience_summary"
): number {
  if (taskType === "evidence_extract") {
    return config.agentTask.timeouts.evidenceExtractMs;
  }

  return config.agentTask.timeouts.experienceSummaryMs;
}

export async function withLlmTaskTimeout<T>(
  taskType: LlmTaskType,
  promise: Promise<T>,
  timeoutMs = getLlmTaskTimeoutMs(taskType)
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(
          () => reject(new LlmTaskTimeoutError(taskType, timeoutMs)),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export function isLlmTaskTimeoutError(error: unknown): error is LlmTaskTimeoutError {
  return error instanceof LlmTaskTimeoutError;
}
