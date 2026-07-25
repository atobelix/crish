import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearUsageHistory,
  loadUsageSnapshot,
  recordUsageDelta,
} from './usageStore';

const STORAGE_KEY = 'crish_usage_history_v1';

describe('usageStore 4D', () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  it('recordUsageDelta accumulates cache + savedCost', () => {
    const snap = recordUsageDelta({
      input: 100,
      output: 20,
      cost: 0.01,
      cacheRead: 40,
      cacheWrite: 5,
      savedCost: 0.003,
      model: 'test-model',
    });
    expect(snap.totalInput).toBe(100);
    expect(snap.totalOutput).toBe(20);
    expect(snap.totalCost).toBeCloseTo(0.01, 8);
    expect(snap.totalCacheRead).toBe(40);
    expect(snap.totalCacheWrite).toBe(5);
    expect(snap.totalSavedCost).toBeCloseTo(0.003, 8);
    expect(snap.models[0]?.cacheRead).toBe(40);
    expect(snap.days[0]?.savedCost).toBeCloseTo(0.003, 8);
  });

  it('loads legacy snapshot without 4D fields as zeros', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        days: [{ day: '2099-01-01', input: 1, output: 2, cost: 0.1 }],
        models: [{ model: 'm', input: 1, output: 2, cost: 0.1 }],
        totalInput: 1,
        totalOutput: 2,
        totalCost: 0.1,
        updatedAt: 1,
      }),
    );
    const snap = loadUsageSnapshot();
    expect(snap.totalCacheRead).toBe(0);
    expect(snap.totalSavedCost).toBe(0);
    expect(snap.days[0]?.cacheRead).toBe(0);
  });

  it('clearUsageHistory resets 4D totals', () => {
    recordUsageDelta({ input: 1, cacheRead: 9, savedCost: 0.1 });
    const empty = clearUsageHistory();
    expect(empty.totalCacheRead).toBe(0);
    expect(empty.totalSavedCost).toBe(0);
    expect(empty.days).toEqual([]);
  });
});
