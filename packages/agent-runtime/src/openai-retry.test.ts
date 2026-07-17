import { describe, expect, it, vi } from "vitest";
import {
  chooseRetryDelayMs,
  delay,
  MAX_RETRY_AFTER_MS,
  normalizeRetryOptions,
  parseRetryAfterMs,
  remainingRetryBudgetMs,
  retryDelayMs,
  withinRetryBudget,
} from "./openai-retry";

describe("openai-retry", () => {
  it("normalizeRetryOptions clamps and ensures maxDelay >= initial", () => {
    const a = normalizeRetryOptions(undefined);
    expect(a.maxAttempts).toBe(1);
    expect(a.initialDelayMs).toBe(750);
    expect(a.maxDelayMs).toBeGreaterThanOrEqual(a.initialDelayMs);

    const b = normalizeRetryOptions({
      maxAttempts: 0,
      initialDelayMs: 500,
      maxDelayMs: 100,
      jitterRatio: 2,
    });
    expect(b.maxAttempts).toBe(1);
    expect(b.initialDelayMs).toBe(500);
    expect(b.maxDelayMs).toBe(500);
    expect(b.jitterRatio).toBe(1);
  });

  it("normalizeRetryOptions ignores non-finite option values", () => {
    const opts = normalizeRetryOptions({
      maxAttempts: Number.NaN,
      initialDelayMs: Number.POSITIVE_INFINITY,
      maxDelayMs: Number.NaN,
      totalBudgetMs: -1,
      jitterRatio: Number.NaN,
    });
    expect(opts.maxAttempts).toBe(1);
    expect(opts.initialDelayMs).toBe(750);
    expect(opts.maxDelayMs).toBeGreaterThanOrEqual(opts.initialDelayMs);
    expect(opts.totalBudgetMs).toBe(1);
    expect(opts.jitterRatio).toBe(0);
  });

  it("parseRetryAfterMs supports seconds and HTTP-date", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs("  ")).toBeUndefined();
    expect(parseRetryAfterMs("1.5")).toBe(1500);
    const future = new Date(Date.now() + 5_000).toUTCString();
    const ms = parseRetryAfterMs(future);
    expect(ms).toBeDefined();
    expect(ms!).toBeGreaterThan(0);
    expect(ms!).toBeLessThanOrEqual(5_000);
  });

  it("parseRetryAfterMs clamps Infinity, negatives, and extreme values", () => {
    expect(parseRetryAfterMs("Infinity")).toBe(MAX_RETRY_AFTER_MS);
    expect(parseRetryAfterMs("-3")).toBe(0);
    expect(parseRetryAfterMs("not-a-date")).toBeUndefined();
    // 1 hour in seconds → clamped to MAX_RETRY_AFTER_MS
    expect(parseRetryAfterMs(String(60 * 60))).toBe(MAX_RETRY_AFTER_MS);
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfterMs(past)).toBe(0);
  });

  it("retryDelayMs is exponential and chooseRetryDelayMs prefers longer Retry-After", () => {
    const opts = normalizeRetryOptions({
      initialDelayMs: 100,
      maxDelayMs: 10_000,
      jitterRatio: 0,
    });
    expect(retryDelayMs(opts, 1)).toBe(100);
    expect(retryDelayMs(opts, 2)).toBe(200);
    expect(retryDelayMs(opts, 0)).toBe(100);
    expect(retryDelayMs(opts, Number.NaN)).toBe(100);
    expect(chooseRetryDelayMs(opts, 1, "3")).toBe(3_000);
    expect(chooseRetryDelayMs(opts, 1, null)).toBe(100);
  });

  it("chooseRetryDelayMs respects remaining budget and maxDelay", () => {
    const opts = normalizeRetryOptions({
      initialDelayMs: 1_000,
      maxDelayMs: 8_000,
      jitterRatio: 0,
    });
    expect(chooseRetryDelayMs(opts, 1, "30", 500)).toBe(500);
    expect(chooseRetryDelayMs(opts, 1, "30", 0)).toBe(0);
    // Header would be 30s but maxDelay clamps first then budget
    expect(chooseRetryDelayMs(opts, 1, "30")).toBe(8_000);
  });

  it("withinRetryBudget and remainingRetryBudgetMs handle invalid numbers", () => {
    expect(withinRetryBudget(Date.now(), 1_000)).toBe(true);
    expect(withinRetryBudget(Date.now() - 2_000, 1_000)).toBe(false);
    expect(withinRetryBudget(Number.NaN, 1_000)).toBe(false);
    expect(withinRetryBudget(Date.now(), 0)).toBe(false);
    expect(withinRetryBudget(Date.now(), -10)).toBe(false);
    expect(remainingRetryBudgetMs(Date.now(), 1_000)).toBeGreaterThan(0);
    expect(remainingRetryBudgetMs(Date.now() - 5_000, 1_000)).toBe(0);
    expect(remainingRetryBudgetMs(Number.NaN, 1_000)).toBe(0);
  });

  it("delay rejects immediately when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(delay(5_000, controller.signal)).rejects.toThrow(/abort/i);
  });

  it("delay rejects when aborted mid-wait (and cleans timer)", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const p = delay(10_000, controller.signal);
    controller.abort();
    await expect(p).rejects.toThrow(/abort/i);
    vi.useRealTimers();
  });

  it("delay resolves immediately for non-finite or zero ms", async () => {
    const controller = new AbortController();
    await expect(delay(0, controller.signal)).resolves.toBeUndefined();
    await expect(delay(Number.NaN, controller.signal)).resolves.toBeUndefined();
    await expect(delay(-5, controller.signal)).resolves.toBeUndefined();
  });
});
