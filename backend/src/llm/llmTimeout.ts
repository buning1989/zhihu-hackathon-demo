import type { LlmTaskType } from "./llmRouter.js";

export const LLM_TASK_TIMEOUT_MS: Record<LlmTaskType, number> = {
  intent_expand: 3000,
  clarification_planner: 3000,
  candidate_rerank: 5000,
  evidence_extract: 5000,
  demo_response_compose: 5000,
  experience_summary: 5000,
  grounding_guard: 3000,
  persona_chat: 5000
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
  return LLM_TASK_TIMEOUT_MS[taskType];
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
