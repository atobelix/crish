/**
 * OpenAI 兼容 Provider 的重试 / 退避纯函数。
 * 迁移自 packages/agent-runtime/src/openai-retry.ts（Phase D 删除 TS 旧包后下沉至保留层）。
 */

export interface OpenAICompatibleRetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  totalBudgetMs?: number;
  jitterRatio?: number;
}

/** Absolute ceiling so a hostile Retry-After cannot stall the loop for hours. */
const MAX_RETRY_AFTER_MS = 5 * 60_000;

/** 将可选重试配置规范化为必填字段，并做边界钳制 */
export function normalizeRetryOptions(
  options: OpenAICompatibleRetryOptions | undefined
): Required<OpenAICompatibleRetryOptions> {
  const initialDelayMs = Math.max(1, Math.floor(finiteOr(options?.initialDelayMs, 750)));
  const maxDelayMs = Math.max(initialDelayMs, Math.floor(finiteOr(options?.maxDelayMs, 8_000)));
  return {
    maxAttempts: Math.max(1, Math.floor(finiteOr(options?.maxAttempts, 1))),
    initialDelayMs,
    maxDelayMs,
    totalBudgetMs: Math.max(1, Math.floor(finiteOr(options?.totalBudgetMs, 60_000))),
    jitterRatio: Math.min(1, Math.max(0, finiteOr(options?.jitterRatio, 0)))
  };
}

/**
 * 解析 Retry-After：支持秒数或 HTTP-date。
 * - 非法 / 非有限 → undefined
 * - 负值 / 过去时间 → 0
 * - 超过 MAX_RETRY_AFTER_MS → 钳到上限（避免无限阻塞）
 */
export function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return clampRetryAfterMs(Math.floor(seconds * 1000));
  }
  // Numeric Infinity tokens (not HTTP-date) — clamp instead of falling through to Date.parse
  if (seconds === Number.POSITIVE_INFINITY) return MAX_RETRY_AFTER_MS;
  if (seconds === Number.NEGATIVE_INFINITY) return 0;

  const dateMs = Date.parse(trimmed);
  if (!Number.isFinite(dateMs)) return undefined;
  return clampRetryAfterMs(dateMs - Date.now());
}

function clampRetryAfterMs(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.floor(ms)));
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 指数退避 + 可选 jitter（attempt 从 1 起；非法 attempt 钳到 1） */
export function retryDelayMs(options: Required<OpenAICompatibleRetryOptions>, attempt: number): number {
  const safeAttempt = Math.max(1, Math.floor(Number.isFinite(attempt) ? attempt : 1));
  const base = Math.min(options.maxDelayMs, options.initialDelayMs * 2 ** (safeAttempt - 1));
  if (options.jitterRatio <= 0) return base;
  const spread = base * options.jitterRatio;
  return Math.max(1, Math.floor(base - spread + Math.random() * spread * 2));
}

/**
 * 结合 Retry-After 与指数退避，取更长的等待（仍钳到 maxDelayMs）。
 * 可选 remainingBudgetMs：等待不得超过剩余总预算（至少 0）。
 */
export function chooseRetryDelayMs(
  options: Required<OpenAICompatibleRetryOptions>,
  attempt: number,
  retryAfterHeader: string | null | undefined,
  remainingBudgetMs?: number
): number {
  const backoff = retryDelayMs(options, attempt);
  const fromHeader = parseRetryAfterMs(retryAfterHeader ?? null);
  let wait = fromHeader === undefined ? backoff : Math.max(backoff, fromHeader);
  wait = Math.min(options.maxDelayMs, wait);
  if (remainingBudgetMs !== undefined && Number.isFinite(remainingBudgetMs)) {
    wait = Math.min(wait, Math.max(0, Math.floor(remainingBudgetMs)));
  }
  return wait;
}
