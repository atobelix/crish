import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CATALOG_CACHE_RATES,
  applyCatalogCacheSnapshot,
  clearCatalogCacheSnapshot,
  DEFAULT_CACHE_READ_MULTIPLIER,
  DEFAULT_CACHE_TTL_MODE,
  DEFAULT_CACHE_WRITE_MULTIPLIER,
  DEFAULT_PRICES,
  estimateCostUsd,
  estimateCostUsd4d,
  estimateSavingsUsd,
  getModelCurrency,
  loadCachePriceOpts,
  loadCacheTtlMode,
  resolve4dPrices,
  resolve4dPricesForTokens,
  resolveCatalogCachePrices,
  resolveModelPrice,
  resolveTierForTokens,
  saveCachePriceOpts,
  saveCacheTtlMode,
  savePrices,
} from './pricingStore';

const PRICES_KEY = 'crish_model_prices_v1';
const CACHE_OPTS_KEY = 'crish_cache_price_opts_v1';
const CACHE_TTL_MODE_KEY = 'crish_cache_ttl_mode_v1';

describe('pricingStore 4D（用户价表 + 全局乘数；与 v3 向下兼容）', () => {
  beforeEach(() => {
    localStorage.removeItem(PRICES_KEY);
    localStorage.removeItem(CACHE_OPTS_KEY);
    localStorage.removeItem(CACHE_TTL_MODE_KEY);
    clearCatalogCacheSnapshot();
    // 固定单价便于断言：Pin=10, Pout=20 → Pcr=1, Pcw=12.5
    savePrices([{ model: 'test-model', inputPerMTok: 10, outputPerMTok: 20 }]);
  });

  afterEach(() => {
    localStorage.removeItem(PRICES_KEY);
    localStorage.removeItem(CACHE_OPTS_KEY);
    localStorage.removeItem(CACHE_TTL_MODE_KEY);
  });

  it('resolveModelPrice exact + fuzzy match', () => {
    expect(resolveModelPrice('test-model')?.inputPerMTok).toBe(10);
    expect(resolveModelPrice('prefix-test-model-suffix')?.model).toBe(
      'test-model'
    );
    expect(resolveModelPrice('no-such-model')).toBeNull();
  });

  it('estimateCostUsd is 2D full price (no cache)', () => {
    // 1e6 prompt + 1e6 completion → 10 + 20 = 30
    expect(estimateCostUsd('test-model', 1_000_000, 1_000_000)).toBeCloseTo(
      30,
      8
    );
  });

  it('estimateCostUsd4d with zero cache equals 2D', () => {
    const a = estimateCostUsd('test-model', 1000, 500);
    const b = estimateCostUsd4d('test-model', 1000, 500, 0, 0);
    expect(b).toBeCloseTo(a, 10);
  });

  it('4D formula: nonCached*Pin + out*Pout + write*Pcw + read*Pcr', () => {
    // prompt=1000, completion=200, read=400, write=100
    // nonCached=500；test-model 不入目录 → 全局乘数 Pcr=1, Pcw=12.5
    const expected =
      (500 / 1e6) * 10 +
      (200 / 1e6) * 20 +
      (100 / 1e6) * 12.5 +
      (400 / 1e6) * 1;
    const got = estimateCostUsd4d('test-model', 1000, 200, 400, 100);
    expect(got).toBeCloseTo(expected, 12);
    expect(DEFAULT_CACHE_READ_MULTIPLIER).toBe(0.1);
    expect(DEFAULT_CACHE_WRITE_MULTIPLIER).toBe(1.25);
    expect(resolve4dPrices('test-model')?.source).toBe('multiplier');
  });

  it('estimateSavingsUsd = max(0, full2D - cost4d)', () => {
    const prompt = 1000;
    const completion = 200;
    const read = 400;
    const write = 0;
    const full = estimateCostUsd('test-model', prompt, completion);
    const actual = estimateCostUsd4d(
      'test-model',
      prompt,
      completion,
      read,
      write
    );
    const save = estimateSavingsUsd(
      'test-model',
      prompt,
      completion,
      read,
      write
    );
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

  it('unknown model returns 0 for all estimators（无价 → 不估算）', () => {
    expect(estimateCostUsd('zzz-unknown', 1e6, 1e6)).toBe(0);
    expect(estimateCostUsd4d('zzz-unknown', 1e6, 1e6, 100, 100)).toBe(0);
    expect(estimateSavingsUsd('zzz-unknown', 1e6, 1e6, 100, 0)).toBe(0);
    expect(resolve4dPrices('zzz-unknown')).toBeNull();
    expect(getModelCurrency('zzz-unknown')).toBeNull();
  });

  it('DEFAULT_PRICES still loads when LS empty', () => {
    localStorage.removeItem(PRICES_KEY);
    const hit = resolveModelPrice('gpt-5.6');
    expect(hit?.inputPerMTok).toBe(
      DEFAULT_PRICES.find((p) => p.model === 'gpt-5.6')?.inputPerMTok
    );
  });

  it('loadCachePriceOpts defaults; saveCachePriceOpts persists and affects 4D', () => {
    expect(loadCachePriceOpts()).toEqual({
      cacheReadMultiplier: DEFAULT_CACHE_READ_MULTIPLIER,
      cacheWriteMultiplier: DEFAULT_CACHE_WRITE_MULTIPLIER,
    });
    saveCachePriceOpts({
      cacheReadMultiplier: 0.05,
      cacheWriteMultiplier: 1.5,
    });
    expect(loadCachePriceOpts()).toEqual({
      cacheReadMultiplier: 0.05,
      cacheWriteMultiplier: 1.5,
    });
    // prompt=1000, completion=0, read=400, write=0
    // nonCached=600; Pcr=10*0.05=0.5
    // cost = 600/1e6*10 + 400/1e6*0.5
    const expected = (600 / 1e6) * 10 + (400 / 1e6) * 0.5;
    expect(estimateCostUsd4d('test-model', 1000, 0, 400, 0)).toBeCloseTo(
      expected,
      12
    );
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

describe('v4 四指标目录全量表（CATALOG_CACHE_RATES，御十家）', () => {
  it('御十家全量覆盖：条目数 ≥ 100（含官方 ID + 别名/旧键）', () => {
    expect(Object.keys(CATALOG_CACHE_RATES).length).toBeGreaterThanOrEqual(100);
  });

  it('各厂商代表条目四指标绝对价正确（数据源 04-master-model-list.md）', () => {
    // DeepSeek（§9.1）：命中 2% / 0.83%
    const ds = CATALOG_CACHE_RATES['deepseek-v4-flash'];
    expect(ds.inputPerMTok).toBe(0.14);
    expect(ds.outputPerMTok).toBe(0.28);
    expect(ds.cacheReadPerMTok).toBeCloseTo(0.0028, 10);
    expect(ds.cacheWritePerMTok).toBe(0);
    expect(ds.cacheWriteFree).toBe(true);

    // OpenAI（§1.1）：5.6 系有写价 1.25x；旧轨写免费
    expect(CATALOG_CACHE_RATES['gpt-5.6-sol'].cacheWritePerMTok).toBe(6.25);
    expect(CATALOG_CACHE_RATES['gpt-5.6-sol'].cacheWriteFree).toBe(false);
    expect(CATALOG_CACHE_RATES['gpt-5.5'].cacheWriteFree).toBe(true);
    expect(CATALOG_CACHE_RATES['gpt-5.5'].cacheWritePerMTok).toBe(0);
    expect(CATALOG_CACHE_RATES['gpt-5.4-mini'].cacheReadPerMTok).toBeCloseTo(
      0.075,
      10
    );
    // 旧轨（§1.3）：o1 命中 50%
    expect(CATALOG_CACHE_RATES['o1'].cacheReadPerMTok).toBe(7.5);
    expect(CATALOG_CACHE_RATES['gpt-4o-mini'].cacheReadPerMTok).toBeCloseTo(
      0.075,
      10
    );
    // pro 档「无缓存折扣（未明确）」→ null（禁 0 占位）
    expect(CATALOG_CACHE_RATES['gpt-5.5-pro'].cacheReadPerMTok).toBeNull();

    // Anthropic（§2.1）：双档写价 5m/1h
    const claude = CATALOG_CACHE_RATES['claude-sonnet-4-5'];
    expect(claude.cacheReadPerMTok).toBe(0.3);
    expect(claude.cacheWritePerMTok).toBe(3.75);
    expect(claude.cacheWritePerMTok1h).toBe(6.0);
    expect(claude.cacheWriteFree).toBe(false);

    // Kimi（§3.1）：CNY + 写免费
    expect(CATALOG_CACHE_RATES['kimi-k3'].currency).toBe('CNY');
    expect(CATALOG_CACHE_RATES['kimi-k3'].cacheReadPerMTok).toBe(2);
    expect(CATALOG_CACHE_RATES['kimi-k2.6'].cacheReadPerMTok).toBe(1.1);

    // GLM（§4.1 zai USD 站）
    expect(CATALOG_CACHE_RATES['glm-5-2'].currency).toBe('USD');
    expect(CATALOG_CACHE_RATES['glm-5-2'].cacheReadPerMTok).toBeCloseTo(
      0.26,
      10
    );
    expect(CATALOG_CACHE_RATES['glm-4-5-air'].cacheReadPerMTok).toBeCloseTo(
      0.03,
      10
    );

    // Qwen（§5.1）：CNY + 推导写价（输入 × 125%）
    expect(CATALOG_CACHE_RATES['qwen3-8-max'].currency).toBe('CNY');
    expect(CATALOG_CACHE_RATES['qwen3-8-max'].cacheWritePerMTok).toBe(15);
    expect(CATALOG_CACHE_RATES['qwen3-8-max'].cacheWriteFree).toBe(false);
    expect(CATALOG_CACHE_RATES['qwen3-7-max'].cacheReadPerMTok).toBe(1.2);

    // Grok（§6.1）：写免费（推断）
    expect(CATALOG_CACHE_RATES['grok-4-5'].cacheReadPerMTok).toBe(0.3);
    expect(CATALOG_CACHE_RATES['grok-4-5'].cacheWriteFree).toBe(true);

    // MiniMax（§7.1 国内站 CNY）：M3 写免费（仅被动）、M2.x 写价 1.25x
    expect(CATALOG_CACHE_RATES['minimax-m3'].currency).toBe('CNY');
    expect(CATALOG_CACHE_RATES['minimax-m3'].cacheWriteFree).toBe(true);
    expect(CATALOG_CACHE_RATES['minimax-m2-7'].cacheWritePerMTok).toBe(2.625);
    expect(CATALOG_CACHE_RATES['minimax-m2-7-highspeed'].inputPerMTok).toBe(
      4.2
    );

    // Gemini（§8.1）：命中 10%、写免费
    expect(CATALOG_CACHE_RATES['gemini-3-6-flash'].cacheReadPerMTok).toBe(0.15);
    expect(CATALOG_CACHE_RATES['gemini-3-5-flash'].inputPerMTok).toBe(1.5);
    expect(CATALOG_CACHE_RATES['gemini-2.5-pro'].cacheReadPerMTok).toBeCloseTo(
      0.13,
      10
    );
  });

  it('别名/旧键与官方 ID 同价（v1 兼容）', () => {
    expect(CATALOG_CACHE_RATES['gpt-5.6'].cacheReadPerMTok).toBe(
      CATALOG_CACHE_RATES['gpt-5.6-sol'].cacheReadPerMTok
    );
    expect(CATALOG_CACHE_RATES['grok-4-5'].inputPerMTok).toBe(
      CATALOG_CACHE_RATES['grok-4.5'].inputPerMTok
    );
    expect(CATALOG_CACHE_RATES['gemini-3-6-flash'].inputPerMTok).toBe(
      CATALOG_CACHE_RATES['gemini-3.6-flash'].inputPerMTok
    );
    expect(CATALOG_CACHE_RATES['glm-5-2'].inputPerMTok).toBe(
      CATALOG_CACHE_RATES['glm-5.2'].inputPerMTok
    );
    expect(CATALOG_CACHE_RATES['qwen3-7-max'].inputPerMTok).toBe(
      CATALOG_CACHE_RATES['qwen3.7-max'].inputPerMTok
    );
  });

  it('模糊匹配：版本后缀命中目录键（deepseek-v4-flash-0731 → flash）', () => {
    const hit = resolveCatalogCachePrices('deepseek-v4-flash-0731');
    expect(hit?.readPerMTok).toBeCloseTo(0.0028, 10);
  });
});

describe('v4 四指标估算（绝对价消费；写免费；币种）', () => {
  beforeEach(() => {
    localStorage.removeItem(PRICES_KEY);
    localStorage.removeItem(CACHE_OPTS_KEY);
    localStorage.removeItem(CACHE_TTL_MODE_KEY);
    clearCatalogCacheSnapshot();
  });

  afterEach(() => {
    localStorage.removeItem(PRICES_KEY);
    localStorage.removeItem(CACHE_OPTS_KEY);
    localStorage.removeItem(CACHE_TTL_MODE_KEY);
  });

  it('目录模型不依赖用户价表即可估算（deepseek-v4-flash 全命中 = 0.0028）', () => {
    const prices = resolve4dPrices('deepseek-v4-flash');
    expect(prices?.source).toBe('catalog');
    expect(prices?.cacheReadPerMTok).toBeCloseTo(0.0028, 10);
    const cost = estimateCostUsd4d(
      'deepseek-v4-flash',
      1_000_000,
      0,
      1_000_000,
      0
    );
    expect(cost).toBeCloseTo(0.0028, 10);
  });

  it('cacheWriteFree：写入 token 计 0（deepseek-v4-flash write=1e6）', () => {
    const cost = estimateCostUsd4d(
      'deepseek-v4-flash',
      1_000_000,
      0,
      0,
      1_000_000
    );
    // nonCached = 0（write 全扣）；write 免费 → cost = 0
    expect(cost).toBe(0);
    expect(resolve4dPrices('deepseek-v4-flash')?.cacheWriteFree).toBe(true);
  });

  it('有写价模型写费计入（gpt-5.6-sol：write 1e6 = 6.25）', () => {
    const cost = estimateCostUsd4d('gpt-5.6-sol', 1_000_000, 0, 0, 1_000_000);
    expect(cost).toBeCloseTo(6.25, 10);
  });

  it('写免费模型命中价 + 输出价（kimi-k3：read=1e6 全命中）', () => {
    const cost = estimateCostUsd4d(
      'kimi-k3',
      1_000_000,
      1_000_000,
      1_000_000,
      0
    );
    // nonCached=0；read 2.00 + 输出 100.00（CNY）
    expect(cost).toBeCloseTo(102, 10);
  });

  it('币种标注：CNY 模型成本按 CNY 计，不折算（getModelCurrency）', () => {
    expect(getModelCurrency('kimi-k3')).toBe('CNY');
    expect(getModelCurrency('qwen3-8-max')).toBe('CNY');
    expect(getModelCurrency('minimax-m2-7')).toBe('CNY');
    expect(getModelCurrency('deepseek-v4-flash')).toBe('USD');
    expect(getModelCurrency('claude-sonnet-4-5')).toBe('USD');
    expect(getModelCurrency('gpt-5.6-sol')).toBe('USD');
    // resolve4dPrices 携带币种
    expect(resolve4dPrices('kimi-k3')?.currency).toBe('CNY');
    // 2D 也走目录兜底（CNY）
    expect(estimateCostUsd('kimi-k3', 1_000_000, 1_000_000)).toBeCloseTo(
      120,
      10
    );
  });

  it('2D 目录兜底 + 用户价表覆盖输入价（用户 0.2 > 目录 0.14）', () => {
    savePrices([
      { model: 'deepseek-v4-flash', inputPerMTok: 0.2, outputPerMTok: 0.28 },
    ]);
    const prices = resolve4dPrices('deepseek-v4-flash');
    expect(prices?.inputPerMTok).toBe(0.2);
    // 缓存价仍为目录绝对价（不受用户输入价影响）
    expect(prices?.cacheReadPerMTok).toBeCloseTo(0.0028, 10);
    expect(estimateCostUsd('deepseek-v4-flash', 1_000_000, 0)).toBeCloseTo(
      0.2,
      10
    );
  });

  it('用户价表 currency 可覆盖目录币种标注', () => {
    savePrices([
      { model: 'kimi-k3', inputPerMTok: 2, outputPerMTok: 10, currency: 'USD' },
    ]);
    expect(getModelCurrency('kimi-k3')).toBe('USD');
    expect(resolve4dPrices('kimi-k3')?.currency).toBe('USD');
  });

  it('未收录模型回退链：用户价表扩展字段 → 全局乘数 → 无价 0', () => {
    // 第 2 级：用户扩展字段（目录未覆盖）
    savePrices([
      {
        model: 'my-model',
        inputPerMTok: 10,
        outputPerMTok: 20,
        cacheReadPerMTok: 0.4,
        cacheWritePerMTok: 3.3,
      },
    ]);
    expect(resolveCatalogCachePrices('my-model')).toBeNull();
    expect(resolve4dPrices('my-model')?.source).toBe('user');
    const cost = estimateCostUsd4d('my-model', 1000, 0, 400, 100);
    const expected = (500 / 1e6) * 10 + (400 / 1e6) * 0.4 + (100 / 1e6) * 3.3;
    expect(cost).toBeCloseTo(expected, 12);

    // 第 2 级部分字段：缺省侧回退全局乘数
    savePrices([
      {
        model: 'my-model-2',
        inputPerMTok: 10,
        outputPerMTok: 20,
        cacheReadPerMTok: 0.4,
      },
    ]);
    const cost2 = estimateCostUsd4d('my-model-2', 1000, 0, 400, 100);
    const expected2 =
      (500 / 1e6) * 10 +
      (400 / 1e6) * 0.4 +
      (100 / 1e6) * (10 * DEFAULT_CACHE_WRITE_MULTIPLIER);
    expect(cost2).toBeCloseTo(expected2, 12);

    // 第 3 级：纯用户价表模型 → 全局乘数兜底
    savePrices([{ model: 'test-model', inputPerMTok: 10, outputPerMTok: 20 }]);
    expect(resolveCatalogCachePrices('test-model')).toBeNull();
    expect(resolve4dPrices('test-model')?.source).toBe('multiplier');
    const cost3 = estimateCostUsd4d('test-model', 1000, 0, 400, 0);
    const expected3 = (600 / 1e6) * 10 + (400 / 1e6) * 1;
    expect(cost3).toBeCloseTo(expected3, 12);

    // 无价 → 不估算（0）
    expect(estimateCostUsd4d('no-price-model', 1000, 0, 400, 0)).toBe(0);
    expect(resolve4dPrices('no-price-model')).toBeNull();
  });

  it('estimateSavingsUsd 消费目录绝对价（deepseek-v4-flash 命中 50 万）', () => {
    const save = estimateSavingsUsd(
      'deepseek-v4-flash',
      1_000_000,
      0,
      500_000,
      0
    );
    // 2D 全价 0.14 - 4D（0.5M×0.14 + 0.5M×0.0028）
    const expected = 0.14 - (0.07 + 0.0014);
    expect(save).toBeCloseTo(expected, 10);
    expect(save).toBeGreaterThan(0);
  });
});

describe('v4 1h 档（Anthropic 双档写价）与运行时快照', () => {
  beforeEach(() => {
    localStorage.removeItem(PRICES_KEY);
    localStorage.removeItem(CACHE_OPTS_KEY);
    localStorage.removeItem(CACHE_TTL_MODE_KEY);
    clearCatalogCacheSnapshot();
  });

  afterEach(() => {
    localStorage.removeItem(PRICES_KEY);
    localStorage.removeItem(CACHE_OPTS_KEY);
    localStorage.removeItem(CACHE_TTL_MODE_KEY);
  });

  it('loadCacheTtlMode 默认 5m；saveCacheTtlMode 持久化；非法值回落', () => {
    expect(loadCacheTtlMode()).toBe(DEFAULT_CACHE_TTL_MODE);
    expect(loadCacheTtlMode()).toBe('5m');
    expect(saveCacheTtlMode('1h')).toBe('1h');
    expect(loadCacheTtlMode()).toBe('1h');
    localStorage.setItem(CACHE_TTL_MODE_KEY, 'bogus');
    expect(loadCacheTtlMode()).toBe('5m');
  });

  it('TTL=5m（默认）：Anthropic 写价按 5m 档；TTL=1h：按 1h 档', () => {
    const model = 'claude-sonnet-4-5';
    // 默认 5m：写价 3.75
    expect(resolve4dPrices(model)?.cacheWritePerMTok).toBe(3.75);
    expect(resolve4dPrices(model)?.hasWrite1hTier).toBe(true);
    const cost5m = estimateCostUsd4d(model, 1_000_000, 0, 0, 1_000_000);
    expect(cost5m).toBeCloseTo(3.75, 10);
    // 切 1h：写价 6.00
    saveCacheTtlMode('1h');
    expect(resolve4dPrices(model)?.cacheWritePerMTok).toBe(6.0);
    const cost1h = estimateCostUsd4d(model, 1_000_000, 0, 0, 1_000_000);
    expect(cost1h).toBeCloseTo(6.0, 10);
  });

  it('TTL=1h 不影响无 1h 档模型（gpt-5.6-sol / minimax-m2-7 写价不变）', () => {
    saveCacheTtlMode('1h');
    expect(resolve4dPrices('gpt-5.6-sol')?.cacheWritePerMTok).toBe(6.25);
    expect(resolve4dPrices('gpt-5.6-sol')?.hasWrite1hTier).toBe(false);
    // MiniMax 1h 窗口不落 cacheWritePerMTok1h（schema §2 C 组）
    expect(resolve4dPrices('minimax-m2-7')?.cacheWritePerMTok).toBe(2.625);
    expect(resolve4dPrices('minimax-m2-7')?.hasWrite1hTier).toBe(false);
  });

  it('运行时快照（catalog_get 下发）优先于静态表；版本号失效；清空回退', () => {
    applyCatalogCacheSnapshot({
      version: 2,
      prices: {
        'deepseek-v4-flash': { readPerMTok: 0.009, writePerMTok: 0.01 },
      },
    });
    expect(resolve4dPrices('deepseek-v4-flash')?.source).toBe('snapshot');
    expect(resolveCatalogCachePrices('deepseek-v4-flash')?.readPerMTok).toBe(
      0.009
    );
    // 旧版本快照被忽略（版本号失效）
    applyCatalogCacheSnapshot({
      version: 1,
      prices: {
        'deepseek-v4-flash': { readPerMTok: 0.001, writePerMTok: 0 },
      },
    });
    expect(resolveCatalogCachePrices('deepseek-v4-flash')?.readPerMTok).toBe(
      0.009
    );
    // 快照写价无免费位语义（绝对值直用）
    const cost = estimateCostUsd4d(
      'deepseek-v4-flash',
      1_000_000,
      0,
      0,
      1_000_000
    );
    expect(cost).toBeCloseTo(0.01, 10);
    // 清空回退静态表
    clearCatalogCacheSnapshot();
    expect(
      resolveCatalogCachePrices('deepseek-v4-flash')?.readPerMTok
    ).toBeCloseTo(0.0028, 10);
    expect(resolve4dPrices('deepseek-v4-flash')?.source).toBe('catalog');
  });

  describe('长度分档消费（P1B / DEEPCHECK-05 #8：tieredPricing 落档）', () => {
    it('静态表 tier：gemini-3-1-pro ≥200K 档覆盖四价，半开区间边界正确', () => {
      // 首档（<200K）：基础价 2.0/12.0/0.2
      expect(resolve4dPricesForTokens('gemini-3-1-pro', 199_999)).toMatchObject({
        inputPerMTok: 2,
        outputPerMTok: 12,
        cacheReadPerMTok: 0.2,
      });
      // ≥200K：档价 4.0/18.0/0.4（cacheWrite 未覆盖沿用 0）
      const tiered = resolve4dPricesForTokens('gemini-3-1-pro', 200_000);
      expect(tiered).toMatchObject({
        inputPerMTok: 4,
        outputPerMTok: 18,
        cacheReadPerMTok: 0.4,
        cacheWritePerMTok: 0,
      });
      expect(resolveTierForTokens('gemini-3-1-pro', 500_000)?.minTokens).toBe(
        200_000
      );
      // 估算函数按 input 长度落档（DEEPCHECK-05 §8 场景：500K in + 50K out
      // 基础档 $1.60 vs 长档 $2.90，低估 ≈45% 修复）
      const baseCost = estimateCostUsd4d('gemini-3-1-pro', 500_000, 50_000, 0, 0);
      expect(baseCost).toBeCloseTo(500_000 / 1e6 * 4 + 50_000 / 1e6 * 18, 10);
      expect(baseCost).toBeGreaterThan(1.6);
      // 2D 估算同样落档
      expect(estimateCostUsd('gemini-3-1-pro', 200_000, 0)).toBeCloseTo(0.8, 10);
      expect(estimateCostUsd('gemini-3-1-pro', 199_999, 0)).toBeCloseTo(
        0.399998,
        8
      );
    });

    it('grok-4-5 ≥200K 档（点号/横线双键同源）；档内 cacheRead 覆盖', () => {
      for (const key of ['grok-4-5', 'grok-4.5']) {
        expect(resolve4dPricesForTokens(key, 199_999)).toMatchObject({
          inputPerMTok: 2,
          cacheReadPerMTok: 0.3,
        });
        expect(resolve4dPricesForTokens(key, 200_000)).toMatchObject({
          inputPerMTok: 4,
          outputPerMTok: 12,
          cacheReadPerMTok: 0.6,
        });
      }
    });

    it('qwen3-6-plus ≥256K 档覆盖写价（档内 cacheWrite 10 vs 基础 2.5）', () => {
      expect(
        resolve4dPricesForTokens('qwen3-6-plus', 255_999)?.cacheWritePerMTok
      ).toBe(2.5);
      expect(
        resolve4dPricesForTokens('qwen3-6-plus', 256_000)?.cacheWritePerMTok
      ).toBe(10);
      expect(
        resolve4dPricesForTokens('qwen3-6-plus', 256_000)?.inputPerMTok
      ).toBe(8);
    });

    it('用户显式保存价表后：用户价优先，整条不落档（用户接管目录语义）', () => {
      savePrices([
        { model: 'gemini-3-1-pro', inputPerMTok: 1, outputPerMTok: 5 },
      ]);
      expect(resolve4dPricesForTokens('gemini-3-1-pro', 500_000)).toMatchObject({
        inputPerMTok: 1,
        outputPerMTok: 5,
      });
      // 缓存价同样不落档：走基础回退链（用户无缓存字段 → 目录基础档）
      expect(
        resolve4dPricesForTokens('gemini-3-1-pro', 500_000)?.cacheReadPerMTok
      ).toBe(0.2);
    });

    it('无 tier 模型：任意长度恒基础价（deepseek-v4-flash / 未知模型）', () => {
      expect(
        resolve4dPricesForTokens('deepseek-v4-flash', 1_000_000)?.inputPerMTok
      ).toBe(0.14);
      expect(resolveTierForTokens('deepseek-v4-flash', 1_000_000)).toBeNull();
      expect(resolve4dPricesForTokens('zzz-unknown', 10)).toBeNull();
    });
  });

  describe('快照四价 + tiered（P1B：Rust 目录真源全量传导）', () => {
    it('快照带 input/output/tiered：resolve4dPrices 全指标取快照，分档消费快照档', () => {
      applyCatalogCacheSnapshot({
        version: 3,
        prices: {
          'gemini-3-1-pro': {
            inputPerMTok: 3,
            outputPerMTok: 13,
            readPerMTok: 0.3,
            writePerMTok: 0,
            tiered: [
              {
                minTokens: 200_000,
                inputPerMTok: 6,
                outputPerMTok: 26,
                cacheReadPerMTok: 0.6,
              },
            ],
          },
        },
      });
      try {
        // 基础四价取快照（Rust 真源优先于静态表）
        expect(resolve4dPrices('gemini-3-1-pro')).toMatchObject({
          inputPerMTok: 3,
          outputPerMTok: 13,
          cacheReadPerMTok: 0.3,
          source: 'snapshot',
        });
        // 分档消费快照档
        expect(
          resolve4dPricesForTokens('gemini-3-1-pro', 250_000)
        ).toMatchObject({
          inputPerMTok: 6,
          outputPerMTok: 26,
          cacheReadPerMTok: 0.6,
        });
        expect(estimateCostUsd4d('gemini-3-1-pro', 250_000, 10_000, 0, 0)).toBeCloseTo(
          250_000 / 1e6 * 6 + 10_000 / 1e6 * 26,
          10
        );
      } finally {
        clearCatalogCacheSnapshot();
      }
    });

    it('快照缺失指标逐项回退：只带缓存价时 input/output 回退静态表', () => {
      applyCatalogCacheSnapshot({
        version: 1,
        prices: {
          'gemini-3-1-pro': { readPerMTok: 0.5, writePerMTok: 0 },
        },
      });
      try {
        expect(resolve4dPrices('gemini-3-1-pro')).toMatchObject({
          inputPerMTok: 2, // 回退静态表基础价
          cacheReadPerMTok: 0.5, // 快照优先
          source: 'snapshot',
        });
      } finally {
        clearCatalogCacheSnapshot();
      }
    });
  });
});
