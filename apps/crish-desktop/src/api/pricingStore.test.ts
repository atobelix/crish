import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CACHE_READ_MULTIPLIER,
  DEFAULT_CACHE_WRITE_MULTIPLIER,
  DEFAULT_PRICES,
  estimateCostUsd,
  estimateCostUsd4d,
  estimateSavingsUsd,
  loadCachePriceOpts,
  resolveModelPrice,
  saveCachePriceOpts,
  savePrices,
} from './pricingStore';

const PRICES_KEY = 'crish_model_prices_v1';
const CACHE_OPTS_KEY = 'crish_cache_price_opts_v1';

describe('pricingStore 4D', () => {
  beforeEach(() => {
    localStorage.removeItem(PRICES_KEY);
    localStorage.removeItem(CACHE_OPTS_KEY);
    // 固定单价便于断言：Pin=10, Pout=20 → Pcr=1, Pcw=12.5
    savePrices([{ model: 'test-model', inputPerMTok: 10, outputPerMTok: 20 }]);
  });

  afterEach(() => {
    localStorage.removeItem(PRICES_KEY);
    localStorage.removeItem(CACHE_OPTS_KEY);
  });

  it('resolveModelPrice exact + fuzzy match', () => {
    expect(resolveModelPrice('test-model')?.inputPerMTok).toBe(10);
    expect(resolveModelPrice('prefix-test-model-suffix')?.model).toBe('test-model');
    expect(resolveModelPrice('no-such-model')).toBeNull();
  });

  it('estimateCostUsd is 2D full price (no cache)', () => {
    // 1e6 prompt + 1e6 completion → 10 + 20 = 30
    expect(estimateCostUsd('test-model', 1_000_000, 1_000_000)).toBeCloseTo(30, 8);
  });

  it('estimateCostUsd4d with zero cache equals 2D', () => {
    const a = estimateCostUsd('test-model', 1000, 500);
    const b = estimateCostUsd4d('test-model', 1000, 500, 0, 0);
    expect(b).toBeCloseTo(a, 10);
  });

  it('4D formula: nonCached*Pin + out*Pout + write*Pcw + read*Pcr', () => {
    // prompt=1000, completion=200, read=400, write=100
    // nonCached=600
    // cost = 600/1e6*10 + 200/1e6*20 + 100/1e6*12.5 + 400/1e6*1
    const expected =
      (600 / 1e6) * 10 + (200 / 1e6) * 20 + (100 / 1e6) * 12.5 + (400 / 1e6) * 1;
    const got = estimateCostUsd4d('test-model', 1000, 200, 400, 100);
    expect(got).toBeCloseTo(expected, 12);
    expect(DEFAULT_CACHE_READ_MULTIPLIER).toBe(0.1);
    expect(DEFAULT_CACHE_WRITE_MULTIPLIER).toBe(1.25);
  });

  it('estimateSavingsUsd = max(0, full2D - cost4d)', () => {
    const prompt = 1000;
    const completion = 200;
    const read = 400;
    const write = 0;
    const full = estimateCostUsd('test-model', prompt, completion);
    const actual = estimateCostUsd4d('test-model', prompt, completion, read, write);
    const save = estimateSavingsUsd('test-model', prompt, completion, read, write);
    expect(save).toBeCloseTo(Math.max(0, full - actual), 12);
    // read cheaper than full input → positive savings
    expect(save).toBeGreaterThan(0);
  });

  it('savings is 0 when no cache benefit', () => {
    expect(estimateSavingsUsd('test-model', 1000, 100, 0, 0)).toBe(0);
  });

  it('heavy cache write can zero out savings (cost may exceed full2D)', () => {
    // write-only: nonCached=prompt, plus write premium → cost > full2D
    const save = estimateSavingsUsd('test-model', 1000, 0, 0, 1000);
    expect(save).toBe(0);
  });

  it('unknown model returns 0 for all estimators', () => {
    expect(estimateCostUsd('zzz-unknown', 1e6, 1e6)).toBe(0);
    expect(estimateCostUsd4d('zzz-unknown', 1e6, 1e6, 100, 100)).toBe(0);
    expect(estimateSavingsUsd('zzz-unknown', 1e6, 1e6, 100, 0)).toBe(0);
  });

  it('DEFAULT_PRICES still loads when LS empty', () => {
    localStorage.removeItem(PRICES_KEY);
    const hit = resolveModelPrice('gpt-4o');
    expect(hit?.inputPerMTok).toBe(
      DEFAULT_PRICES.find((p) => p.model === 'gpt-4o')?.inputPerMTok,
    );
  });

  it('loadCachePriceOpts defaults; saveCachePriceOpts persists and affects 4D', () => {
    expect(loadCachePriceOpts()).toEqual({
      cacheReadMultiplier: DEFAULT_CACHE_READ_MULTIPLIER,
      cacheWriteMultiplier: DEFAULT_CACHE_WRITE_MULTIPLIER,
    });
    saveCachePriceOpts({ cacheReadMultiplier: 0.05, cacheWriteMultiplier: 1.5 });
    expect(loadCachePriceOpts()).toEqual({
      cacheReadMultiplier: 0.05,
      cacheWriteMultiplier: 1.5,
    });
    // prompt=1000, completion=0, read=400, write=0
    // nonCached=600; Pcr=10*0.05=0.5
    // cost = 600/1e6*10 + 400/1e6*0.5
    const expected = (600 / 1e6) * 10 + (400 / 1e6) * 0.5;
    expect(estimateCostUsd4d('test-model', 1000, 0, 400, 0)).toBeCloseTo(expected, 12);
  });

  it('saveCachePriceOpts rejects negative / NaN with defaults', () => {
    const got = saveCachePriceOpts({
      cacheReadMultiplier: -1,
      cacheWriteMultiplier: Number.NaN,
    });
    expect(got.cacheReadMultiplier).toBe(DEFAULT_CACHE_READ_MULTIPLIER);
    expect(got.cacheWriteMultiplier).toBe(DEFAULT_CACHE_WRITE_MULTIPLIER);
  });
});
