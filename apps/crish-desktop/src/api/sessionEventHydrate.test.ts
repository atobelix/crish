import { describe, expect, it } from 'vitest';
import {
  applyUsageDelta,
  parseRunSnapshotUsage,
  type UsageDeltaState,
} from './sessionEventHydrate';

const baseUsage: UsageDeltaState = {
  input: 100,
  output: 50,
  cost: 0.01,
  inputMax: 160000,
  outputMax: 40000,
};

describe('parseRunSnapshotUsage', () => {
  it('returns null without usage', () => {
    expect(parseRunSnapshotUsage(null)).toBeNull();
    expect(parseRunSnapshotUsage({})).toBeNull();
    expect(parseRunSnapshotUsage({ snapshot: {} })).toBeNull();
  });

  it('parses 2D usage without cache (2D fallback)', () => {
    const got = parseRunSnapshotUsage({
      type: 'run-snapshot',
      runId: 'r1',
      snapshot: {
        usage: {
          sampleCount: 2,
          promptTokens: 150,
          completionTokens: 40,
          totalTokens: 190,
        },
      },
    });
    expect(got).toEqual({
      promptTokens: 150,
      completionTokens: 40,
      totalTokens: 190,
      sampleCount: 2,
    });
    expect(got?.cacheReadTokens).toBeUndefined();
    expect(got?.cacheWriteTokens).toBeUndefined();
  });

  it('透传 snapshot.cache.readTokens / writeTokens → cacheRead/WriteTokens', () => {
    const got = parseRunSnapshotUsage({
      snapshot: {
        usage: {
          sampleCount: 2,
          promptTokens: 150,
          completionTokens: 40,
          totalTokens: 190,
        },
        cache: {
          sampleCount: 2,
          promptTokens: 150,
          readTokens: 52,
          writeTokens: 10,
          missTokens: 98,
          hitRatio: 52 / 150,
          writeRatio: 10 / 150,
        },
      },
    });
    expect(got).toMatchObject({
      promptTokens: 150,
      completionTokens: 40,
      totalTokens: 190,
      sampleCount: 2,
      cacheReadTokens: 52,
      cacheWriteTokens: 10,
    });
  });

  it('falls back to usage.cacheReadTokens when snapshot.cache missing', () => {
    const got = parseRunSnapshotUsage({
      usage: {
        sampleCount: 1,
        promptTokens: 20,
        completionTokens: 7,
        cacheReadTokens: 4,
        cacheWriteTokens: 3,
      },
    });
    expect(got?.cacheReadTokens).toBe(4);
    expect(got?.cacheWriteTokens).toBe(3);
  });

  it('ignores negative / non-number cache fields', () => {
    const got = parseRunSnapshotUsage({
      snapshot: {
        usage: { sampleCount: 1, promptTokens: 10, completionTokens: 1 },
        cache: { readTokens: -5, writeTokens: 'x' },
      },
    });
    expect(got?.cacheReadTokens).toBeUndefined();
    expect(got?.cacheWriteTokens).toBeUndefined();
  });
});

describe('applyUsageDelta', () => {
  it('no-ops when all deltas are zero', () => {
    const next = applyUsageDelta(baseUsage, {}, () => 1);
    expect(next).toBe(baseUsage);
  });

  it('accumulates 2D tokens + cost via estimateCost', () => {
    const next = applyUsageDelta(
      baseUsage,
      { promptTokens: 10, completionTokens: 5 },
      (i, o) => i * 0.001 + o * 0.002,
    );
    expect(next.input).toBe(110);
    expect(next.output).toBe(55);
    // base 0.01 + (10*0.001 + 5*0.002)=0.02 → 0.03
    expect(next.cost).toBeCloseTo(0.03, 8);
    expect(next.cacheRead).toBeUndefined();
    expect(next.savedCost).toBeUndefined();
  });

  it('accumulates 4D cache + savedCost when provided', () => {
    const next = applyUsageDelta(
      baseUsage,
      {
        promptTokens: 100,
        completionTokens: 20,
        cacheReadTokens: 40,
        cacheWriteTokens: 10,
      },
      (i, o, cr = 0, cw = 0) => i * 0.0001 + o * 0.0002 + cr * 0.00001 + cw * 0.00005,
      (i, o, cr = 0) => cr * 0.00009,
    );
    expect(next.input).toBe(200);
    expect(next.output).toBe(70);
    expect(next.cacheRead).toBe(40);
    expect(next.cacheWrite).toBe(10);
    expect(next.savedCost).toBeCloseTo(40 * 0.00009, 8);
    expect(next.cost).toBeGreaterThan(baseUsage.cost);
  });

  it('preserves existing cache counters across subsequent deltas', () => {
    const mid = applyUsageDelta(
      { ...baseUsage, cacheRead: 10, savedCost: 0.01 },
      { promptTokens: 5, completionTokens: 0, cacheReadTokens: 3 },
      () => 0.001,
      () => 0.002,
    );
    expect(mid.cacheRead).toBe(13);
    expect(mid.savedCost).toBeCloseTo(0.012, 8);
  });
});
