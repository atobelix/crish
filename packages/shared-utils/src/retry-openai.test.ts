import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chooseRetryDelayMs,
  normalizeRetryOptions,
  parseRetryAfterMs,
  retryDelayMs,
} from './retry-openai';

const MAX_RETRY_AFTER_MS = 5 * 60_000;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('normalizeRetryOptions', () => {
  it('undefined → 默认值', () => {
    expect(normalizeRetryOptions(undefined)).toEqual({
      maxAttempts: 1,
      initialDelayMs: 750,
      maxDelayMs: 8000,
      totalBudgetMs: 60000,
      jitterRatio: 0,
    });
  });

  it('非有限值回退默认，小数向下取整，下限钳到 1', () => {
    const o = normalizeRetryOptions({
      maxAttempts: Number.NaN,
      initialDelayMs: 0.4,
      maxDelayMs: Number.POSITIVE_INFINITY,
      totalBudgetMs: -5,
      jitterRatio: Number.NaN,
    });
    expect(o).toEqual({
      maxAttempts: 1,
      initialDelayMs: 1,
      maxDelayMs: 8000,
      totalBudgetMs: 1,
      jitterRatio: 0,
    });
    expect(normalizeRetryOptions({ maxAttempts: 3.9 }).maxAttempts).toBe(3);
  });

  it('maxDelayMs 不小于 initialDelayMs；jitterRatio 钳到 [0,1]', () => {
    expect(
      normalizeRetryOptions({ initialDelayMs: 5000, maxDelayMs: 100 })
        .maxDelayMs
    ).toBe(5000);
    expect(normalizeRetryOptions({ jitterRatio: 2 }).jitterRatio).toBe(1);
    expect(normalizeRetryOptions({ jitterRatio: -1 }).jitterRatio).toBe(0);
  });
});

describe('parseRetryAfterMs', () => {
  it('空值/空白/非法文本 → undefined', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();
    expect(parseRetryAfterMs('   ')).toBeUndefined();
    expect(parseRetryAfterMs('soon')).toBeUndefined();
  });

  it('秒数：转毫秒，负数钳 0，小数秒取整，超大钳到 5 分钟上限', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
    expect(parseRetryAfterMs(' 1.5 ')).toBe(1500);
    expect(parseRetryAfterMs('-3')).toBe(0);
    expect(parseRetryAfterMs('999999')).toBe(MAX_RETRY_AFTER_MS);
  });

  it('Infinity / -Infinity 文本被钳制而不是当日期解析', () => {
    expect(parseRetryAfterMs('Infinity')).toBe(MAX_RETRY_AFTER_MS);
    expect(parseRetryAfterMs('-Infinity')).toBe(0);
  });

  it('HTTP-date：未来时间取差值，过去时间 → 0', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    expect(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:30 GMT')).toBe(30_000);
    expect(parseRetryAfterMs('Wed, 31 Dec 2025 23:00:00 GMT')).toBe(0);
    expect(parseRetryAfterMs('Fri, 02 Jan 2026 00:00:00 GMT')).toBe(
      MAX_RETRY_AFTER_MS
    );
  });
});

describe('retryDelayMs', () => {
  const base = normalizeRetryOptions({ initialDelayMs: 100, maxDelayMs: 1000 });

  it('指数退避并钳到 maxDelayMs', () => {
    expect([1, 2, 3, 4, 5].map((a) => retryDelayMs(base, a))).toEqual([
      100, 200, 400, 800, 1000,
    ]);
  });

  it('非法 attempt（0/负/NaN/小数）钳到 1 或向下取整', () => {
    expect(retryDelayMs(base, 0)).toBe(100);
    expect(retryDelayMs(base, -4)).toBe(100);
    expect(retryDelayMs(base, Number.NaN)).toBe(100);
    expect(retryDelayMs(base, 2.9)).toBe(200);
  });

  it('jitter 在 [base-spread, base+spread] 范围内且至少 1', () => {
    const o = normalizeRetryOptions({
      initialDelayMs: 100,
      maxDelayMs: 1000,
      jitterRatio: 0.5,
    });
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(retryDelayMs(o, 1)).toBe(50);
    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    expect(retryDelayMs(o, 1)).toBe(149);
    const tiny = normalizeRetryOptions({ initialDelayMs: 1, jitterRatio: 1 });
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(retryDelayMs(tiny, 1)).toBe(1);
  });
});

describe('chooseRetryDelayMs', () => {
  const o = normalizeRetryOptions({ initialDelayMs: 100, maxDelayMs: 2000 });

  it('无 Retry-After 时用退避值', () => {
    expect(chooseRetryDelayMs(o, 2, undefined)).toBe(200);
    expect(chooseRetryDelayMs(o, 2, null)).toBe(200);
  });

  it('Retry-After 更长时取 Retry-After，但不超过 maxDelayMs', () => {
    expect(chooseRetryDelayMs(o, 1, '1')).toBe(1000);
    expect(chooseRetryDelayMs(o, 1, '60')).toBe(2000);
    expect(chooseRetryDelayMs(o, 3, '0')).toBe(400);
  });

  it('剩余预算限制等待时间（负预算 → 0，非有限预算忽略）', () => {
    expect(chooseRetryDelayMs(o, 3, null, 150.7)).toBe(150);
    expect(chooseRetryDelayMs(o, 3, null, -10)).toBe(0);
    expect(chooseRetryDelayMs(o, 3, null, Number.POSITIVE_INFINITY)).toBe(400);
  });
});
