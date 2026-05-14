export class RequestBudgetTimeoutError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly timeoutMs: number
  ) {
    super(message);
    this.name = "RequestBudgetTimeoutError";
  }
}

export async function withRequestBudget<T>(
  promise: Promise<T>,
  timeoutMs: number,
  code: string,
  message: string
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(
          () => reject(new RequestBudgetTimeoutError(code, message, timeoutMs)),
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

export function isRequestBudgetTimeoutError(
  error: unknown
): error is RequestBudgetTimeoutError {
  return error instanceof RequestBudgetTimeoutError;
}
