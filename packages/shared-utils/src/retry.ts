export interface RetryOptions {
  maxAttempts?: number;
  baseMs?: number;
  maxMs?: number;
  jitterFactor?: number;
  shouldRetry?: (error: unknown) => boolean;
}

export function calculateBackoff(
  attempt: number,
  baseMs: number = 1000,
  maxMs: number = 30000,
  jitterFactor: number = 0.2,
): number {
  const exponential = Math.min(maxMs, baseMs * Math.pow(2, attempt));
  const jitter = 1 + Math.random() * jitterFactor;
  // F8-16①：maxMs 为硬上限——jitter 在钳制内施加（修复前钳制后乘 jitter，
  // 实际最长 1.2×maxMs；极大 jitterFactor 时可达 maxMs×101）
  return Math.round(Math.min(maxMs, exponential * jitter));
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  // F8-16②：maxAttempts 入参钳制到 ≥1（0/负数/NaN/Infinity → 至少执行一次，
  // 修复前 maxAttempts=0 时循环不执行、throw undefined 破坏错误处理链）
  const rawMaxAttempts = options.maxAttempts ?? 3;
  const maxAttempts = Number.isFinite(rawMaxAttempts)
    ? Math.max(1, Math.floor(rawMaxAttempts))
    : 3;
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
