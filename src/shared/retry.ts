export interface RetryOptions {
  /** How many tries in all, at least one. */
  attempts: number;
  /** The wait before the second try; it doubles for each one after. */
  delayMs?: number;
  /** Replaced in tests. */
  wait?: (ms: number) => Promise<void>;
  /** Told of each failure that is followed by another try. */
  onRetry?: (error: unknown, attempt: number) => void;
}

/**
 * Runs a task again when it fails, for work that depends on the network: a download that is cut off
 * on one try is usually whole on the next. The last error is the one thrown.
 */
export async function retry<T>(task: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { delayMs = 0, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = options;
  const attempts = Math.max(1, options.attempts);
  for (let attempt = 1; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= attempts) throw error;
      options.onRetry?.(error, attempt);
      await wait(delayMs * 2 ** (attempt - 1));
    }
  }
}
