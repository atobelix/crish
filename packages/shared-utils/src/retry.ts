export interface RetryOptions {
  maxAttempts?: number;
  baseMs?: number;
  maxMs?: number;
  jitterFactor?: number;
  shouldRetry?: (error: any) => boolean;
}

export function calculateBackoff(
  attempt: number,
  baseMs: number = 1000,
  maxMs: number = 30000,
  jitterFactor: number = 0.2,
): number {
  const exponential = Math.min(maxMs, baseMs * Math.pow(2, attempt));
  const jitter = 1 + Math.random() * jitterFactor;
  return Math.round(exponential * jitter);
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseMs = options.baseMs ?? 200;
  const maxMs = options.maxMs ?? 1500;
  const jitterFactor = options.jitterFactor;
  const shouldRetry = options.shouldRetry ?? (() => true);

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error) || attempt >= maxAttempts) break;
      const delay = calculateBackoff(attempt - 1, baseMs, maxMs, jitterFactor);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
