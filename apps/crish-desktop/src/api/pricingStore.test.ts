import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyCatalogCacheSnapshot,
  clearCatalogCacheSnapshot,
  DEFAULT_CACHE_READ_MULTIPLIER,
  DEFAULT_CACHE_TTL_MODE,
  DEFAULT_CACHE_WRITE_MULTIPLIER,
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
} from './pricingStore';
import { modelsCatalogStore } from './modelsCatalogStore';
import { catalogSnapshot } from '../test-utils/modelsCatalogSnapshot';
import type {
  ModelRef,
  PricingConfig,
  ProviderSpec,
} from './modelsCatalogTypes';
import type {
  CatalogCacheSnapshot,
  CatalogSnapshotPrice,
} from './pricingTypes';
import type { CatalogSnapshotEntryWire } from './pricingTypes';
import { toCatalogCacheSnapshot } from './modelCatalogIpc';

const CACHE_OPTS_KEY = 'crish_cache_price_opts_v1';
const CACHE_TTL_MODE_KEY = 'crish_cache_ttl_mode_v1';

/** 身份二元组夹具（本仓唯一身份键 = `(providerId, modelId)`） */
const ref = (providerId: string, modelId: string): ModelRef => ({
  providerId,
  modelId,
});

/**
 * 树用户声明价夹具（价格真源 = 统一树 `ModelSpec.pricing`）。
 *
 * 旧 localStorage 扁平价表 `crish_model_prices_v1` 已退役
 * （`loadPrices` / `savePrices` / `upsertPrice` 物理删除），故本文件所有
 * 「用户价」夹具一律注入统一树。
 */
function installPriceTree(
  fixtures: Array<{
    providerId: string;
    modelId: string;
    pricing?: PricingConfig;
  }>
): void {
  const providers: Record<string, ProviderSpec> = {};
  for (const fixture of fixtures) {
    const provider = (providers[fixture.providerId] ??= {
      protocol: 'openai/chat',
      stream: true,
      enabled: true,
      models: [],
    });
    provider.models.push({
      id: fixture.modelId,
      enabled: true,
      pricing: fixture.pricing,
    });
  }
  modelsCatalogStore.resetForTesting();
  modelsCatalogStore.acceptSnapshot(
    catalogSnapshot({
      tree: { version: 2, activeModel: null, providers },
      revision: 'revision-prices',
    })
  );
}

/**
 * 出厂字典真源（Rust 编译期打包，前端唯一价格来源）。
 * 前端静态定价表已物理删除 → 定价用例必须以**快照夹具**驱动。
 *
 * 路径锚定：一律以**本文件自身位置**为基准，禁止用 `process.cwd()`——cwd 随
 * 调用口径漂移（根 `vitest.config.ts` 下 = 仓库根，app 目录配置下 =
 * `apps/crish-desktop`），锚错即 ENOENT 假红。与 `noteMirrorIpc.test.ts` 同款约定。
 */
const API_DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : import.meta.url.startsWith('file:')
      ? dirname(fileURLToPath(import.meta.url))
      : resolve(process.cwd(), 'src/api');

const CATALOG_JSON = resolve(
  API_DIR,
  '../../../../crates/agent-provider/src/models/catalog.json'
);

function dictionarySnapshot(): CatalogCacheSnapshot {
  const raw = JSON.parse(readFileSync(CATALOG_JSON, 'utf8')) as {
    version?: number;
    entries?: Record<string, CatalogSnapshotEntryWire>;
  };
  return toCatalogCacheSnapshot({
    version: raw.version ?? 0,
    entries: Object.values(raw.entries ?? {}),
  });
}

/**
 * 手写快照夹具（版本号需大于出厂字典快照，见 `applyCatalogCacheSnapshot` 语义）。
 *
 * 索引键 = **模型 id**：出厂字典的查找键是 id（字典内 id 唯一，
 * 由 Rust `ssot_convergence_tests::dictionary_model_ids_are_unique_keys` 钉死）；
 * 配置树的 `providerId` 与字典厂商是两个命名空间，不参与字典索引。
 * 元组里的 `providerId` 仅用于让夹具读起来与配置树对齐，不进入索引。
 */
function applyFixture(
  version: number,
  entries: Array<[string, string, CatalogSnapshotPrice]>
): void {
  const prices: Record<string, CatalogSnapshotPrice> = {};
  for (const [, modelId, price] of entries) {
    prices[modelId] = price;
  }
  applyCatalogCacheSnapshot({ version, prices });
}

describe('pricingStore 4D（树用户声明价 + 全局乘数；与 v3 向下兼容）', () => {
  /** 固定单价便于断言：Pin=10, Pout=20 → Pcr=1, Pcw=12.5 */
  const TEST = ref('custom', 'test-model');

  beforeEach(() => {
    localStorage.removeItem(CACHE_OPTS_KEY);
    localStorage.removeItem(CACHE_TTL_MODE_KEY);
    clearCatalogCacheSnapshot();
    installPriceTree([
      {
        providerId: 'custom',
        modelId: 'test-model',
        pricing: { currency: 'USD', input: 10, output: 20 },
      },
    ]);
  });

  afterEach(() => {
    localStorage.removeItem(CACHE_OPTS_KEY);
    localStorage.removeItem(CACHE_TTL_MODE_KEY);
    modelsCatalogStore.resetForTesting();
  });

  it('resolveModelPrice 读树用户声明且仅精确命中（substring 双向模糊匹配已废止）', () => {
    expect(resolveModelPrice(TEST)?.inputPerMTok).toBe(10);
    expect(resolveModelPrice(TEST)?.model).toBe('test-model');
    // 旧 fuzzy（model.includes(key) / key.includes(model)）已按裁决 ③ 废止
    expect(
      resolveModelPrice(ref('custom', 'prefix-test-model-suffix'))
    ).toBeNull();
    expect(resolveModelPrice(ref('custom', 'test'))).toBeNull();
    expect(resolveModelPrice(ref('custom', 'test-model-0731'))).toBeNull();
    expect(resolveModelPrice(ref('custom', 'no-such-model'))).toBeNull();
    // 身份 = (providerId, modelId) 二元组：换供应商不命中（旧 LS 扁平表无 provider 维度）
    expect(resolveModelPrice(ref('other', 'test-model'))).toBeNull();
  });

  it('estimateCostUsd is 2D full price (no cache)', () => {
    // 1e6 prompt + 1e6 completion → 10 + 20 = 30
    expect(estimateCostUsd(TEST, 1_000_000, 1_000_000)).toBeCloseTo(30, 8);
  });

  it('estimateCostUsd4d with zero cache equals 2D', () => {
    const a = estimateCostUsd(TEST, 1000, 500);
    const b = estimateCostUsd4d(TEST, 1000, 500, 0, 0);
    expect(b).toBeCloseTo(a!, 10);
  });

  it('4D formula: nonCached*Pin + out*Pout + write*Pcw + read*Pcr', () => {
    // prompt=1000, completion=200, read=400, write=100
    // nonCached=500；test-model 不入出厂字典 → 全局乘数 Pcr=1, Pcw=12.5
    const expected =
      (500 / 1e6) * 10 +
      (200 / 1e6) * 20 +
      (100 / 1e6) * 12.5 +
      (400 / 1e6) * 1;
    const got = estimateCostUsd4d(TEST, 1000, 200, 400, 100);
    expect(got).toBeCloseTo(expected, 12);
    expect(DEFAULT_CACHE_READ_MULTIPLIER).toBe(0.1);
    expect(DEFAULT_CACHE_WRITE_MULTIPLIER).toBe(1.25);
    expect(resolve4dPrices(TEST)?.source).toBe('multiplier');
  });

  it('estimateSavingsUsd = max(0, full2D - cost4d)', () => {
    const prompt = 1000;
    const completion = 200;
    const read = 400;
    const write = 0;
    const full = estimateCostUsd(TEST, prompt, completion);
    const actual = estimateCostUsd4d(TEST, prompt, completion, read, write);
    const save = estimateSavingsUsd(TEST, prompt, completion, read, write);
    expect(save).toBeCloseTo(Math.max(0, full! - actual!), 12);
    // read cheaper than full input → positive savings
    expect(save).toBeGreaterThan(0);
  });

  it('savings is 0 when no cache benefit', () => {
    expect(estimateSavingsUsd(TEST, 1000, 100, 0, 0)).toBe(0);
  });

  it('heavy cache write can zero out savings (cost may exceed full2D)', () => {
    // write-only: nonCached=prompt, plus write premium → cost > full2D
    const save = estimateSavingsUsd(TEST, 1000, 0, 0, 1000);
    expect(save).toBe(0);
  });

  it('未收录模型：估算返回 null（不得为 0 冒充免费）', () => {
    expect(estimateCostUsd(ref('custom', 'zzz-unknown'), 1e6, 1e6)).toBeNull();
    expect(
      estimateCostUsd4d(ref('custom', 'zzz-unknown'), 1e6, 1e6, 100, 100)
    ).toBeNull();
    expect(
      estimateSavingsUsd(ref('custom', 'zzz-unknown'), 1e6, 1e6, 100, 0)
    ).toBeNull();
    expect(resolve4dPrices(ref('custom', 'zzz-unknown'))).toBeNull();
    expect(getModelCurrency(ref('custom', 'zzz-unknown'))).toBeNull();
  });

  it('树无声明 → 无用户价（前端零出厂副本，不播种任何价格）', () => {
    modelsCatalogStore.resetForTesting();
    expect(resolveModelPrice(ref('any', 'gpt-5.6'))).toBeNull();
    // 未收录模型不因「空价表」而获得任何价格
    expect(getModelCurrency(ref('any', 'gpt-5.6'))).toBeNull();
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
    expect(estimateCostUsd4d(TEST, 1000, 0, 400, 0)).toBeCloseTo(expected, 12);
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

describe('v4 出厂字典快照（前端零本地副本；御十家）', () => {
  beforeEach(() => {
    localStorage.removeItem(CACHE_OPTS_KEY);
    localStorage.removeItem(CACHE_TTL_MODE_KEY);
    clearCatalogCacheSnapshot();
    // 无树声明（空树 = 未加载）：价格一律来自出厂字典快照
    modelsCatalogStore.resetForTesting();
    // 快照夹具 = 出厂字典真源投影（Rust catalog.json → **模型 id** 索引）
    applyCatalogCacheSnapshot(dictionarySnapshot());
  });

  afterEach(() => {
    localStorage.removeItem(CACHE_OPTS_KEY);
    localStorage.removeItem(CACHE_TTL_MODE_KEY);
    clearCatalogCacheSnapshot();
    modelsCatalogStore.resetForTesting();
  });

  it('御十家全量覆盖：条目数 ≥ 100（官方 ID + apiModel 别名）', () => {
    expect(
      Object.keys(dictionarySnapshot().prices).length
    ).toBeGreaterThanOrEqual(100);
  });

  it('各厂商代表条目四指标绝对价正确（数据源 = Rust 出厂字典）', () => {
    // DeepSeek：命中 2% / 0.83%，写免费
    const ds = resolve4dPrices(ref('deepseek', 'deepseek-v4-flash'))!;
    expect(ds.inputPerMTok).toBe(0.14);
    expect(ds.outputPerMTok).toBe(0.28);
    expect(ds.cacheReadPerMTok).toBeCloseTo(0.0028, 10);
    expect(ds.cacheWritePerMTok).toBe(0);
    expect(ds.cacheWriteFree).toBe(true);

    // OpenAI：5.6 系有写价 1.25x；旧轨写免费
    expect(
      resolve4dPrices(ref('openai', 'gpt-5.6-sol'))!.cacheWritePerMTok
    ).toBe(6.25);
    expect(resolve4dPrices(ref('openai', 'gpt-5.6-sol'))!.cacheWriteFree).toBe(
      false
    );
    expect(resolve4dPrices(ref('openai', 'gpt-5.5'))!.cacheWriteFree).toBe(
      true
    );
    expect(resolve4dPrices(ref('openai', 'gpt-5.5'))!.cacheWritePerMTok).toBe(
      0
    );
    expect(
      resolve4dPrices(ref('openai', 'gpt-5.4-mini'))!.cacheReadPerMTok
    ).toBeCloseTo(0.075, 10);
    // 旧轨：o1 命中 50%
    expect(resolve4dPrices(ref('openai', 'o1'))!.cacheReadPerMTok).toBe(7.5);
    expect(
      resolve4dPrices(ref('openai', 'gpt-4o-mini'))!.cacheReadPerMTok
    ).toBeCloseTo(0.075, 10);
    // pro 档「无缓存折扣（未明确）」→ 字典下发 null → 快照字段缺失（禁 0 占位）
    expect(
      resolveCatalogCachePrices(ref('openai', 'gpt-5.5-pro'))?.readPerMTok
    ).toBeUndefined();

    // Anthropic：双档写价 5m/1h
    const claude = resolve4dPrices(ref('anthropic', 'claude-sonnet-4-5'))!;
    expect(claude.cacheReadPerMTok).toBe(0.3);
    expect(claude.cacheWritePerMTok).toBe(3.75);
    expect(claude.hasWrite1hTier).toBe(true);
    expect(claude.cacheWriteFree).toBe(false);

    // Kimi：CNY + 写免费
    expect(getModelCurrency(ref('kimi', 'kimi-k3'))).toBe('CNY');
    expect(resolve4dPrices(ref('kimi', 'kimi-k3'))!.cacheReadPerMTok).toBe(2);
    expect(resolve4dPrices(ref('kimi', 'kimi-k2-6'))!.cacheReadPerMTok).toBe(
      1.1
    );

    // GLM（zai USD 站）
    expect(getModelCurrency(ref('zai', 'glm-5-2'))).toBe('USD');
    expect(
      resolve4dPrices(ref('zai', 'glm-5-2'))!.cacheReadPerMTok
    ).toBeCloseTo(0.26, 10);
    expect(
      resolve4dPrices(ref('zai', 'glm-4-5-air'))!.cacheReadPerMTok
    ).toBeCloseTo(0.03, 10);

    // Qwen（dashscope）：CNY + 推导写价（输入 × 125%）
    expect(getModelCurrency(ref('dashscope', 'qwen3-8-max'))).toBe('CNY');
    expect(
      resolve4dPrices(ref('dashscope', 'qwen3-8-max'))!.cacheWritePerMTok
    ).toBe(15);
    expect(
      resolve4dPrices(ref('dashscope', 'qwen3-8-max'))!.cacheWriteFree
    ).toBe(false);
    expect(
      resolve4dPrices(ref('dashscope', 'qwen3-7-max'))!.cacheReadPerMTok
    ).toBe(1.2);

    // Grok（xai）：写免费（推断）
    expect(resolve4dPrices(ref('xai', 'grok-4.5'))!.cacheReadPerMTok).toBe(0.3);
    expect(resolve4dPrices(ref('xai', 'grok-4.5'))!.cacheWriteFree).toBe(true);

    // MiniMax（minimaxi 国内站 CNY）：M3 写免费（仅被动）、M2.x 写价 1.25x
    expect(getModelCurrency(ref('minimaxi', 'minimax-m3'))).toBe('CNY');
    expect(resolve4dPrices(ref('minimaxi', 'minimax-m3'))!.cacheWriteFree).toBe(
      true
    );
    expect(
      resolve4dPrices(ref('minimaxi', 'minimax-m2-7'))!.cacheWritePerMTok
    ).toBe(2.625);
    expect(
      resolve4dPrices(ref('minimaxi', 'minimax-m2-7-highspeed'))!.inputPerMTok
    ).toBe(4.2);

    // Gemini（google）：命中 10%、写免费
    expect(
      resolve4dPrices(ref('google', 'gemini-3-6-flash'))!.cacheReadPerMTok
    ).toBe(0.075);
    expect(
      resolve4dPrices(ref('google', 'gemini-3-5-flash'))!.inputPerMTok
    ).toBe(1.5);
    expect(
      resolve4dPrices(ref('google', 'gemini-2-5-pro'))!.cacheReadPerMTok
    ).toBeCloseTo(0.13, 10);
  });

  it('apiModel 别名与官方 ID 同价（无歧义别名；歧义别名 fail-closed）', () => {
    const pairs: Array<[ModelRef, ModelRef]> = [
      [ref('dashscope', 'qwen3-7-max'), ref('dashscope', 'qwen3.7-max')],
      [ref('google', 'gemini-3-6-flash'), ref('google', 'gemini-3.6-flash')],
      [
        ref('google', 'gemini-3-1-pro-preview'),
        ref('google', 'gemini-3.1-pro-preview'),
      ],
      [ref('kimi', 'kimi-k2-6'), ref('kimi', 'kimi-k2.6')],
    ];
    for (const [official, alias] of pairs) {
      const a = resolveCatalogCachePrices(official);
      expect(a).not.toBeNull();
      expect(resolveCatalogCachePrices(alias)).toEqual(a);
    }

    // 2026-10-14 数据修复：glm-5.2 曾被 `-cny` 变体条目经 apiModel 误主张（claims=2）
    // → 歧义已从出厂字典清零，别名恢复收录且与官方 ID 同价。
    expect(resolveCatalogCachePrices(ref('zai', 'glm-5.2'))).toEqual(
      resolveCatalogCachePrices(ref('zai', 'glm-5-2'))
    );

    // 出厂字典按 **模型 id** 索引（字典内 id 唯一）：providerId 不属于字典命名空间，
    // 故同一 id 换 provider 仍命中同一条目 —— 这不是「跨 provider 串价」，
    // 而是「出厂字典与配置树是两个命名空间」这一事实的体现（见 pricingResolver 头注释）。
    // 配置树侧的身份仍是二元组（`modelRefKey`），由设置页 / 统一树守。
    expect(resolveCatalogCachePrices(ref('openai', 'qwen3.7-max'))).toEqual(
      resolveCatalogCachePrices(ref('dashscope', 'qwen3.7-max'))
    );
  });

  it('同键不同价 fail-closed（claim 冲突整键作废——机制由构造夹具钉死）', () => {
    const snap = toCatalogCacheSnapshot({
      version: 1,
      entries: [
        {
          model: 'dual-price-model',
          inputPrice: 1,
          outputPrice: 2,
          currency: 'USD',
        },
        {
          model: 'dual-price-model-cny',
          apiModel: 'dual-price-model',
          inputPrice: 8,
          outputPrice: 20,
          currency: 'CNY',
        },
      ],
    } as never) as { prices: Record<string, unknown> };
    // 同一别名被两条不同价主张 → 歧义别名键作废；变体条目自身主 id 正常收录
    expect(snap.prices['dual-price-model']).toBeUndefined();
    expect(snap.prices['dual-price-model-cny']).toMatchObject({
      currency: 'CNY',
      inputPerMTok: 8,
      outputPerMTok: 20,
    });
  });

  it('精确二元组：版本后缀 / 子串命中目录键的旧 fuzzy 行为已废止', () => {
    // 旧实现：model.includes(key) → deepseek-v4-flash-0731 命中 flash
    expect(
      resolveCatalogCachePrices(ref('deepseek', 'deepseek-v4-flash-0731'))
    ).toBeNull();
    // 旧实现：key.includes(model) → flash 命中 deepseek-v4-flash
    expect(resolveCatalogCachePrices(ref('deepseek', 'flash'))).toBeNull();
    // 精确命中仍在
    expect(
      resolveCatalogCachePrices(ref('deepseek', 'deepseek-v4-flash'))
        ?.readPerMTok
    ).toBeCloseTo(0.0028, 10);
  });
});

describe('v4 四指标估算（绝对价消费；写免费；币种）', () => {
  beforeEach(() => {
    localStorage.removeItem(CACHE_OPTS_KEY);
    localStorage.removeItem(CACHE_TTL_MODE_KEY);
    clearCatalogCacheSnapshot();
    // 无树声明（空树 = 未加载）：价格一律来自出厂字典快照
    modelsCatalogStore.resetForTesting();
    applyCatalogCacheSnapshot(dictionarySnapshot());
  });

  afterEach(() => {
    localStorage.removeItem(CACHE_OPTS_KEY);
    localStorage.removeItem(CACHE_TTL_MODE_KEY);
    clearCatalogCacheSnapshot();
    modelsCatalogStore.resetForTesting();
  });

  it('目录模型不依赖用户价表即可估算（deepseek-v4-flash 全命中 = 0.0028）', () => {
    const ds = ref('deepseek', 'deepseek-v4-flash');
    const prices = resolve4dPrices(ds);
    expect(prices?.source).toBe('snapshot');
    expect(prices?.cacheReadPerMTok).toBeCloseTo(0.0028, 10);
    const cost = estimateCostUsd4d(ds, 1_000_000, 0, 1_000_000, 0);
    expect(cost).toBeCloseTo(0.0028, 10);
  });

  it('cacheWriteFree：写入 token 计 0（deepseek-v4-flash write=1e6）', () => {
    const ds = ref('deepseek', 'deepseek-v4-flash');
    const cost = estimateCostUsd4d(ds, 1_000_000, 0, 0, 1_000_000);
    // nonCached = 0（write 全扣）；write 免费 → cost = 0
    expect(cost).toBe(0);
    expect(resolve4dPrices(ds)?.cacheWriteFree).toBe(true);
  });

  it('有写价模型写费计入（gpt-5.6-sol：基础档 write 1e6 = 6.25；≥272K 档 = 12.5）', () => {
    const sol = ref('openai', 'gpt-5.6-sol');
    // prompt 低于 272K 档 → 基础写价 6.25
    const base = estimateCostUsd4d(sol, 100_000, 0, 0, 1_000_000);
    expect(base).toBeCloseTo(6.25, 10);
    // prompt 落 ≥272K 档 → 档内写价 12.5（分档覆盖基础价）
    const tiered = estimateCostUsd4d(sol, 300_000, 0, 0, 1_000_000);
    expect(tiered).toBeCloseTo(12.5, 10);
  });

  it('写免费模型命中价 + 输出价（kimi-k3：read=1e6 全命中）', () => {
    const cost = estimateCostUsd4d(
      ref('kimi', 'kimi-k3'),
      1_000_000,
      1_000_000,
      1_000_000,
      0
    );
    // nonCached=0；read 2.00 + 输出 100.00（CNY）
    expect(cost).toBeCloseTo(102, 10);
  });

  it('币种标注：CNY 模型成本按 CNY 计，不折算（getModelCurrency）', () => {
    expect(getModelCurrency(ref('kimi', 'kimi-k3'))).toBe('CNY');
    expect(getModelCurrency(ref('dashscope', 'qwen3-8-max'))).toBe('CNY');
    expect(getModelCurrency(ref('minimaxi', 'minimax-m2-7'))).toBe('CNY');
    expect(getModelCurrency(ref('deepseek', 'deepseek-v4-flash'))).toBe('USD');
    expect(getModelCurrency(ref('anthropic', 'claude-sonnet-4-5'))).toBe('USD');
    expect(getModelCurrency(ref('openai', 'gpt-5.6-sol'))).toBe('USD');
    // resolve4dPrices 携带币种
    expect(resolve4dPrices(ref('kimi', 'kimi-k3'))?.currency).toBe('CNY');
    // 2D 也走出厂字典（CNY）
    expect(
      estimateCostUsd(ref('kimi', 'kimi-k3'), 1_000_000, 1_000_000)
    ).toBeCloseTo(120, 10);
  });

  it('2D 出厂字典价 + 树用户声明覆盖输入价（用户 0.2 > 字典 0.14）', () => {
    installPriceTree([
      {
        providerId: 'deepseek',
        modelId: 'deepseek-v4-flash',
        pricing: { currency: 'USD', input: 0.2, output: 0.28 },
      },
    ]);
    const ds = ref('deepseek', 'deepseek-v4-flash');
    const prices = resolve4dPrices(ds);
    expect(prices?.inputPerMTok).toBe(0.2);
    // 用户未声明缓存价 → 仍取出厂字典绝对价（逐字段回退，不被用户输入价影响）
    expect(prices?.cacheReadPerMTok).toBeCloseTo(0.0028, 10);
    expect(estimateCostUsd(ds, 1_000_000, 0)).toBeCloseTo(0.2, 10);
  });

  it('树用户声明 currency 可覆盖出厂字典币种标注', () => {
    installPriceTree([
      {
        providerId: 'kimi',
        modelId: 'kimi-k3',
        pricing: { currency: 'USD', input: 2, output: 10 },
      },
    ]);
    const kimi = ref('kimi', 'kimi-k3');
    expect(getModelCurrency(kimi)).toBe('USD');
    expect(resolve4dPrices(kimi)?.currency).toBe('USD');
  });

  it('用户声明价缓存字段覆盖字典；缺省字段回落字典/全局乘数', () => {
    // 用户声明含缓存读/写价（出厂字典未覆盖的模型）
    installPriceTree([
      {
        providerId: 'custom',
        modelId: 'my-model',
        pricing: {
          currency: 'USD',
          input: 10,
          output: 20,
          cacheRead: 0.4,
          cacheWrite: 3.3,
        },
      },
      {
        providerId: 'custom',
        modelId: 'my-model-2',
        pricing: { currency: 'USD', input: 10, output: 20, cacheRead: 0.4 },
      },
      {
        providerId: 'custom',
        modelId: 'test-model',
        pricing: { currency: 'USD', input: 10, output: 20 },
      },
    ]);
    const my = ref('custom', 'my-model');
    expect(resolveCatalogCachePrices(my)).toBeNull();
    expect(resolve4dPrices(my)?.source).toBe('user');
    const cost = estimateCostUsd4d(my, 1000, 0, 400, 100);
    const expected = (500 / 1e6) * 10 + (400 / 1e6) * 0.4 + (100 / 1e6) * 3.3;
    expect(cost).toBeCloseTo(expected, 12);

    // 部分字段：缺省侧回落全局乘数
    const my2 = ref('custom', 'my-model-2');
    const cost2 = estimateCostUsd4d(my2, 1000, 0, 400, 100);
    const expected2 =
      (500 / 1e6) * 10 +
      (400 / 1e6) * 0.4 +
      (100 / 1e6) * (10 * DEFAULT_CACHE_WRITE_MULTIPLIER);
    expect(cost2).toBeCloseTo(expected2, 12);

    // 无缓存字段 → 全局乘数兜底
    const test = ref('custom', 'test-model');
    expect(resolveCatalogCachePrices(test)).toBeNull();
    expect(resolve4dPrices(test)?.source).toBe('multiplier');
    const cost3 = estimateCostUsd4d(test, 1000, 0, 400, 0);
    const expected3 = (600 / 1e6) * 10 + (400 / 1e6) * 1;
    expect(cost3).toBeCloseTo(expected3, 12);

    // 未收录 → 不估算（null，不得为 0）
    const none = ref('custom', 'no-price-model');
    expect(estimateCostUsd4d(none, 1000, 0, 400, 0)).toBeNull();
    expect(resolve4dPrices(none)).toBeNull();
  });

  it('estimateSavingsUsd 消费出厂字典绝对价（deepseek-v4-flash 命中 50 万）', () => {
    const save = estimateSavingsUsd(
      ref('deepseek', 'deepseek-v4-flash'),
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
    localStorage.removeItem(CACHE_OPTS_KEY);
    localStorage.removeItem(CACHE_TTL_MODE_KEY);
    clearCatalogCacheSnapshot();
    // 无树声明（空树 = 未加载）：价格一律来自出厂字典快照
    modelsCatalogStore.resetForTesting();
    applyCatalogCacheSnapshot(dictionarySnapshot());
  });

  afterEach(() => {
    localStorage.removeItem(CACHE_OPTS_KEY);
    localStorage.removeItem(CACHE_TTL_MODE_KEY);
    clearCatalogCacheSnapshot();
    modelsCatalogStore.resetForTesting();
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
    const model = ref('anthropic', 'claude-sonnet-4-5');
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
    const sol = ref('openai', 'gpt-5.6-sol');
    expect(resolve4dPrices(sol)?.cacheWritePerMTok).toBe(6.25);
    expect(resolve4dPrices(sol)?.hasWrite1hTier).toBe(false);
    // MiniMax 1h 窗口不落 cacheWritePrice1h（schema §2 C 组）
    const mm = ref('minimaxi', 'minimax-m2-7');
    expect(resolve4dPrices(mm)?.cacheWritePerMTok).toBe(2.625);
    expect(resolve4dPrices(mm)?.hasWrite1hTier).toBe(false);
  });

  it('运行时快照优先于出厂字典快照；版本号失效；清空 → 未收录（不回退本地表）', () => {
    const ds = ref('deepseek', 'deepseek-v4-flash');
    applyFixture(2, [
      [
        'deepseek',
        'deepseek-v4-flash',
        {
          inputPerMTok: 0.5,
          outputPerMTok: 1,
          readPerMTok: 0.009,
          writePerMTok: 0.01,
        },
      ],
    ]);
    expect(resolve4dPrices(ds)?.source).toBe('snapshot');
    expect(resolveCatalogCachePrices(ds)?.readPerMTok).toBe(0.009);
    // 旧版本快照被忽略（版本号失效）
    applyFixture(1, [
      [
        'deepseek',
        'deepseek-v4-flash',
        {
          inputPerMTok: 0.5,
          outputPerMTok: 1,
          readPerMTok: 0.001,
          writePerMTok: 0,
        },
      ],
    ]);
    expect(resolveCatalogCachePrices(ds)?.readPerMTok).toBe(0.009);
    // 快照写价无免费位语义（绝对值直用）
    const cost = estimateCostUsd4d(ds, 1_000_000, 0, 0, 1_000_000);
    expect(cost).toBeCloseTo(0.01, 10);
    // 清空 → 未收录（前端零本地副本：不得回退任何静态表）
    clearCatalogCacheSnapshot();
    expect(resolveCatalogCachePrices(ds)).toBeNull();
    expect(resolve4dPrices(ds)).toBeNull();
    expect(estimateCostUsd4d(ds, 1_000_000, 0, 0, 1_000_000)).toBeNull();
  });

  describe('长度分档消费（P1B / DEEPCHECK-05 #8：tieredPricing 落档）', () => {
    it('出厂字典 tier：gemini-3-1-pro-preview ≥200K 档覆盖四价，半开区间边界正确', () => {
      const g = ref('google', 'gemini-3-1-pro-preview');
      // 首档（<200K）：基础价 2.0/12.0/0.2
      expect(resolve4dPricesForTokens(g, 199_999)).toMatchObject({
        inputPerMTok: 2,
        outputPerMTok: 12,
        cacheReadPerMTok: 0.2,
      });
      // ≥200K：档价 4.0/18.0/0.4（cacheWrite 未覆盖沿用 0）
      expect(resolve4dPricesForTokens(g, 200_000)).toMatchObject({
        inputPerMTok: 4,
        outputPerMTok: 18,
        cacheReadPerMTok: 0.4,
        cacheWritePerMTok: 0,
      });
      expect(resolveTierForTokens(g, 500_000)?.minTokens).toBe(200_000);
      // 估算函数按 input 长度落档（DEEPCHECK-05 §8 场景：500K in + 50K out
      // 基础档 $1.60 vs 长档 $2.90，低估 ≈45% 修复）
      const baseCost = estimateCostUsd4d(g, 500_000, 50_000, 0, 0);
      expect(baseCost).toBeCloseTo(
        (500_000 / 1e6) * 4 + (50_000 / 1e6) * 18,
        10
      );
      expect(baseCost).toBeGreaterThan(1.6);
      // 2D 估算同样落档
      expect(estimateCostUsd(g, 200_000, 0)).toBeCloseTo(0.8, 10);
      expect(estimateCostUsd(g, 199_999, 0)).toBeCloseTo(0.399998, 8);
    });

    it('grok-4.5 ≥200K 档；档内 cacheRead 覆盖', () => {
      const grok = ref('xai', 'grok-4.5');
      expect(resolve4dPricesForTokens(grok, 199_999)).toMatchObject({
        inputPerMTok: 2,
        cacheReadPerMTok: 0.3,
      });
      expect(resolve4dPricesForTokens(grok, 200_000)).toMatchObject({
        inputPerMTok: 4,
        outputPerMTok: 12,
        cacheReadPerMTok: 0.6,
      });
    });

    it('qwen3-6-plus ≥256K 档覆盖写价（档内 cacheWrite 10 vs 基础 2.5）', () => {
      const qwen = ref('dashscope', 'qwen3-6-plus');
      expect(resolve4dPricesForTokens(qwen, 255_999)?.cacheWritePerMTok).toBe(
        2.5
      );
      expect(resolve4dPricesForTokens(qwen, 256_000)?.cacheWritePerMTok).toBe(
        10
      );
      expect(resolve4dPricesForTokens(qwen, 256_000)?.inputPerMTok).toBe(8);
    });

    it('树声明价后：用户价优先，整条不落档（判据**按模型**）', () => {
      const g = ref('google', 'gemini-3-1-pro-preview');
      installPriceTree([
        {
          providerId: 'google',
          modelId: 'gemini-3-1-pro-preview',
          pricing: { currency: 'USD', input: 1, output: 5 },
        },
      ]);
      expect(resolve4dPricesForTokens(g, 500_000)).toMatchObject({
        inputPerMTok: 1,
        outputPerMTok: 5,
      });
      // 缓存价同样不落档：走基础回退链（用户无缓存字段 → 出厂字典基础档）
      expect(resolve4dPricesForTokens(g, 500_000)?.cacheReadPerMTok).toBe(0.2);
      // 判据按模型：未声明价的模型档位照常生效（旧全局 LS 键判据已退役）
      const grok = ref('xai', 'grok-4.5');
      expect(resolve4dPricesForTokens(grok, 200_000)).toMatchObject({
        inputPerMTok: 4,
        cacheReadPerMTok: 0.6,
      });
      expect(
        resolve4dPricesForTokens(
          ref('deepseek', 'deepseek-v4-flash'),
          1_000_000
        )?.inputPerMTok
      ).toBe(0.14);
    });

    it('无 tier 模型：任意长度恒基础价（deepseek-v4-flash / 未收录模型）', () => {
      const ds = ref('deepseek', 'deepseek-v4-flash');
      expect(resolve4dPricesForTokens(ds, 1_000_000)?.inputPerMTok).toBe(0.14);
      expect(resolveTierForTokens(ds, 1_000_000)).toBeNull();
      expect(
        resolve4dPricesForTokens(ref('any', 'zzz-unknown'), 10)
      ).toBeNull();
    });
  });

  describe('快照四价 + tiered（出厂字典真源全量传导）', () => {
    it('快照带 input/output/tiered：resolve4dPrices 全指标取快照，分档消费快照档', () => {
      const g = ref('google', 'gemini-3-1-pro-preview');
      applyFixture(3, [
        [
          'google',
          'gemini-3-1-pro-preview',
          {
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
        ],
      ]);
      try {
        // 基础四价取快照（出厂字典优先）
        expect(resolve4dPrices(g)).toMatchObject({
          inputPerMTok: 3,
          outputPerMTok: 13,
          cacheReadPerMTok: 0.3,
          source: 'snapshot',
        });
        // 分档消费快照档
        expect(resolve4dPricesForTokens(g, 250_000)).toMatchObject({
          inputPerMTok: 6,
          outputPerMTok: 26,
          cacheReadPerMTok: 0.6,
        });
        expect(estimateCostUsd4d(g, 250_000, 10_000, 0, 0)).toBeCloseTo(
          (250_000 / 1e6) * 6 + (10_000 / 1e6) * 26,
          10
        );
      } finally {
        clearCatalogCacheSnapshot();
      }
    });

    it('快照缺基础四价 → 未收录（不回退任何本地表）', () => {
      const g = ref('google', 'gemini-3-1-pro-preview');
      applyFixture(3, [
        [
          'google',
          'gemini-3-1-pro-preview',
          { readPerMTok: 0.5, writePerMTok: 0 },
        ],
      ]);
      try {
        // 只有缓存价、无 input/output → 2D/4D 均无法成立 → 未收录
        expect(resolve4dPrices(g)).toBeNull();
        expect(estimateCostUsd(g, 1_000_000, 0)).toBeNull();
        // 缓存价本身仍可查（三级费率第 1 级独立于四价）
        expect(resolveCatalogCachePrices(g)?.readPerMTok).toBe(0.5);
      } finally {
        clearCatalogCacheSnapshot();
      }
    });
  });
});
