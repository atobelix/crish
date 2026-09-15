/**
 * 战役 docs/provider-single-track-convergence/ 阶段 3 门禁：
 * 「前端零本地定价字典」/「生产代码零 substring 模型匹配」/「未收录 ≠ 0 成本」。
 *
 * 三条断言互不重叠，且都是**可红**断言（非恒绿）：
 * ① 源码形状：6 份 `pricingCatalogData*.ts` 物理消亡 + 全仓零引用 +
 *    `DEFAULT_PRICES` / `CATALOG_CACHE_RATES` 零残留；
 * ② 生产代码零 substring 模型匹配（裁决 ③：模型身份 = (providerId, modelId)）；
 * ③ 「未收录」在类型上与「0 成本」区分（估算函数返回 null，不得返回 0）。
 *
 * 另含「出厂字典真源驱动」describe：直接读 Rust 侧编译期字典
 * （`crates/agent-provider/src/models/catalog.json`）→ `toCatalogCacheSnapshot`
 * → `applyCatalogCacheSnapshot` → 估算面，钉死「前端可解析的价格 = 出厂字典价格」
 * （取代已删除的前端静态全量表断言）。
 *
 * 静态断言用 fs（`process.cwd()` 锚定 apps/crish-desktop，与
 * `src/api/__tests__/legacy-storage-negative.test.ts` 同款约定）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseModelRefKey, type ModelRef } from './modelsCatalogTypes';
import { normalizeModelIdText } from './modelCatalogPure';
import type {
  CatalogSnapshotEntryWire,
  CatalogSnapshotWire,
} from './modelCatalogTypes';
import { toCatalogCacheSnapshot } from './modelCatalogIpc';
import {
  applyCatalogCacheSnapshot,
  clearCatalogCacheSnapshot,
  estimateCostUsd,
  estimateCostUsd4d,
  estimateSavingsUsd,
  getModelCurrency,
  resolve4dPrices,
  resolveCatalogCachePrices,
  resolveModelPrice,
  resolveSnapshotPrice,
  resolveTierForTokens,
  saveCacheTtlMode,
} from './pricingStore';
import { modelsCatalogStore } from './modelsCatalogStore';
import { catalogSnapshot } from '../test-utils/modelsCatalogSnapshot';
import { resolveEffectivePrice } from './modelPricingSource';
import type { PricingConfig, ProviderSpec } from './modelsCatalogTypes';

/**
 * 树用户声明价夹具（价格真源 = 统一树 `ModelSpec.pricing`；旧 LS 扁平价表已退役）。
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

const APP_DIR = resolve(process.cwd());
const SRC_DIR = join(APP_DIR, 'src');
const API_DIR = join(SRC_DIR, 'api');

/**
 * 独立判据：从 wire 计算「被**不同价**主张」的键集合（主 id 与 apiModel 别名同命名空间）。
 *
 * 与生产守卫（`toCatalogCacheSnapshot` 的 `claim`）**互为独立实现**——这里只用 wire
 * 原始字段重算，避免「用被测实现的输出当判据」。语义：同键出现两条价格不同的条目
 * ⇒ 该键按 fail-closed「未收录」处理（不得按 entries 顺序任选一个）。
 */
function conflictedKeysOf(
  entries: readonly {
    model?: string;
    apiModel?: string;
    inputPrice?: number | null;
    outputPrice?: number | null;
    cacheReadPrice?: number | null;
    cacheWritePrice?: number | null;
    cacheWritePrice5m?: number | null;
    cacheWritePrice1h?: number | null;
    cacheWriteFree?: boolean | null;
    currency?: string | null;
  }[]
): Set<string> {
  const signatures = new Map<string, Set<string>>();
  for (const e of entries) {
    const signature = JSON.stringify([
      e.inputPrice ?? null,
      e.outputPrice ?? null,
      e.cacheReadPrice ?? null,
      e.cacheWritePrice ?? null,
      e.cacheWritePrice5m ?? null,
      e.cacheWritePrice1h ?? null,
      e.cacheWriteFree ?? null,
      e.currency ?? null,
    ]);
    for (const key of [normalizeModelIdText(e.model), normalizeModelIdText(e.apiModel)]) {
      if (!key) continue;
      if (!signatures.has(key)) signatures.set(key, new Set());
      signatures.get(key)!.add(signature);
    }
  }
  const conflicted = new Set<string>();
  for (const [key, set] of signatures) {
    if (set.size > 1) conflicted.add(key);
  }
  return conflicted;
}
const APPS_DIR = resolve(APP_DIR, '..');
const CATALOG_JSON = resolve(
  APP_DIR,
  '../../crates/agent-provider/src/models/catalog.json'
);

const PRICES_KEY = 'crish_model_prices_v1';
const CACHE_TTL_MODE_KEY = 'crish_cache_ttl_mode_v1';

/** 阶段 3 删除对象：6 份前端静态定价表（物理消亡） */
const DELETED_CATALOG_FILES = [
  'pricingCatalogDataA.ts',
  'pricingCatalogDataB.ts',
  'pricingCatalogDataC.ts',
  'pricingCatalogDataAnthropic.ts',
  'pricingCatalogDataOpenAI.ts',
  'pricingCatalogDataQwen.ts',
];

/** 已物理消亡的前端本地字典符号（生产代码零引用） */
const DELETED_CATALOG_SYMBOLS = [
  'pricingCatalogData',
  'CATALOG_CACHE_RATES',
  'CATALOG_RATES_',
  'DEFAULT_PRICES',
];

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'target',
  'coverage',
  'test-results',
  '.git',
  '__snapshots__',
]);

const SOURCE_EXT = /\.(ts|tsx|js|mjs|rs|json)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      walk(p, out);
    } else if (SOURCE_EXT.test(name)) {
      out.push(p);
    }
  }
  return out;
}

function isTestFile(p: string): boolean {
  return /\.test\.(ts|tsx)$/.test(p) || p.includes(`${'__tests__'}`);
}

function readSource(p: string): string {
  return readFileSync(p, 'utf8');
}

/**
 * 剥注释后再扫描（同 `scripts/check-provider-single-track.mjs` 的 `stripComments`）：
 * 消亡符号的**说明性注释**不构成引用，避免「注释假阳性」导致门禁失真。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 文件路径 → 便于断言的相对路径（正斜杠） */
function rel(p: string): string {
  return p.slice(APPS_DIR.length + 1).replace(/\\/g, '/');
}

const ref = (providerId: string, modelId: string): ModelRef => ({
  providerId,
  modelId,
});

// ── ① 前端零本地定价字典（源码形状） ────────────────────────────────────────

describe('① 前端零本地定价字典（源码形状；裁决 ①）', () => {
  it('6 份静态定价表已物理消亡（文件不存在且不可读）', () => {
    for (const name of DELETED_CATALOG_FILES) {
      const p = join(API_DIR, name);
      expect(existsSync(p)).toBe(false);
      expect(() => readSource(p)).toThrow();
    }
  });

  it('全仓（apps/**）生产代码零引用已消亡的前端字典符号', () => {
    const files = walk(APPS_DIR).filter((p) => !isTestFile(p));
    const hits: string[] = [];
    for (const p of files) {
      const src = stripComments(readSource(p));
      for (const symbol of DELETED_CATALOG_SYMBOLS) {
        if (src.includes(symbol)) hits.push(`${rel(p)} → ${symbol}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('定价路径源码零出厂价副本（无 DEFAULT_PRICES / CATALOG_CACHE_RATES）', () => {
    for (const name of [
      'pricingTypes.ts',
      'pricingResolver.ts',
      'modelPricingSource.ts',
    ]) {
      const src = stripComments(readSource(join(API_DIR, name)));
      expect(src).not.toContain('DEFAULT_PRICES');
      expect(src).not.toContain('CATALOG_CACHE_RATES');
      expect(src).not.toContain('CATALOG_RATES_');
    }
  });

  it('树无声明 + 空快照 → 价格面一律「未收录」（不发明出厂价）', () => {
    modelsCatalogStore.resetForTesting();
    clearCatalogCacheSnapshot();
    const unknown = ref('openai', 'gpt-5.6');
    expect(resolveModelPrice(unknown)).toBeNull();
    expect(resolve4dPrices(unknown)).toBeNull();
    expect(resolveEffectivePrice(unknown)).toBeNull();
    // 旧 LS 价表已退役：其内容不再影响任何价格决议
    localStorage.setItem(
      PRICES_KEY,
      JSON.stringify([{ model: 'gpt-5.6', inputPerMTok: 1, outputPerMTok: 2 }])
    );
    expect(resolveModelPrice(unknown)).toBeNull();
    expect(resolveEffectivePrice(unknown)).toBeNull();
    localStorage.removeItem(PRICES_KEY);
  });
});

// ── ② 生产代码零 substring 模型匹配 ─────────────────────────────────────────

describe('② 生产代码零 substring 模型匹配（裁决 ③）', () => {
  it('定价身份路径（pricingStore / pricingResolver / modelPricingSource）零 includes()', () => {
    for (const name of [
      'pricingStore.ts',
      'pricingResolver.ts',
      'modelPricingSource.ts',
    ]) {
      const src = readSource(join(API_DIR, name));
      expect(src).not.toContain('.includes(');
    }
  });

  it('全仓生产代码零双向 substring 模型匹配习语', () => {
    // 形态：`<model>.includes(...)` 或 `.includes(<model>)`（旧 `p.model` 亦然）
    const forbidden =
      /(model|p\.model)\s*\.\s*includes\s*\(|\.includes\s*\(\s*(model|p\.model)\s*\)/;
    const files = walk(SRC_DIR).filter((p) => !isTestFile(p));
    const hits: string[] = [];
    for (const p of files) {
      const src = stripComments(readSource(p));
      src.split('\n').forEach((line, i) => {
        if (forbidden.test(line)) hits.push(`${rel(p)}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });
});

// ── ③ 未收录 ≠ 0 成本 ───────────────────────────────────────────────────────

describe('③ 未收录 ≠ 0 成本（阶段 3 关键不变量）', () => {
  beforeEach(() => {
    localStorage.removeItem(CACHE_TTL_MODE_KEY);
    clearCatalogCacheSnapshot();
    // 无树声明（空树 = 未加载）：价格只可能来自出厂字典快照
    modelsCatalogStore.resetForTesting();
  });

  afterEach(() => {
    localStorage.removeItem(CACHE_TTL_MODE_KEY);
    clearCatalogCacheSnapshot();
    modelsCatalogStore.resetForTesting();
  });

  it('空快照 + 树无声明 → 估算返回 null（不得为 0）', () => {
    const unknown = ref('openai', 'no-such-model');
    const cost4d = estimateCostUsd4d(unknown, 1_000_000, 1_000_000, 100_000, 100_000);
    expect(cost4d).toBeNull();
    expect(cost4d).not.toBe(0);
    expect(estimateCostUsd(unknown, 1_000_000, 1_000_000)).toBeNull();
    expect(
      estimateSavingsUsd(unknown, 1_000_000, 1_000_000, 100_000, 0)
    ).toBeNull();
    expect(resolve4dPrices(unknown)).toBeNull();
    expect(getModelCurrency(unknown)).toBeNull();
    expect(resolveCatalogCachePrices(unknown)).toBeNull();
    expect(resolveTierForTokens(unknown, 1_000_000)).toBeNull();
  });

  it('注入空快照（entries 全丢弃）后仍为未收录，不得回退任何本地表', () => {
    applyCatalogCacheSnapshot({ version: 1, prices: {} });
    const unknown = ref('openai', 'gpt-5.6-sol');
    expect(resolve4dPrices(unknown)).toBeNull();
    expect(estimateCostUsd4d(unknown, 1_000_000, 0, 0, 0)).toBeNull();
  });

  it('正向对照：写免费条目 0 是合法值（number，不是 null）', () => {
    // 夹具键 = **模型 id**（字典索引口径；不再是 (providerId, modelId) 二元组）
    applyCatalogCacheSnapshot({
      version: 1,
      prices: {
        'deepseek-v4-flash': {
          inputPerMTok: 0.14,
          outputPerMTok: 0.28,
          readPerMTok: 0.0028,
          writeFree: true,
          currency: 'USD',
        },
      },
    });
    const cost = estimateCostUsd4d(
      ref('deepseek', 'deepseek-v4-flash'),
      1_000_000,
      0,
      0,
      1_000_000
    );
    // 全写 + 写免费 → 成本确实为 0（已知），类型仍是 number
    expect(cost).toBe(0);
    expect(typeof cost).toBe('number');
    // 写免费是**已知值**（不是未收录）：4D 解析必须命中且写价显式为 0
    const p = resolve4dPrices(ref('deepseek', 'deepseek-v4-flash'));
    expect(p).not.toBeNull();
    expect(p!.cacheWriteFree).toBe(true);
    expect(p!.cacheWritePerMTok).toBe(0);
    expect(getModelCurrency(ref('deepseek', 'deepseek-v4-flash'))).toBe('USD');
  });

  it('身份 = 精确模型 id（provider 不参与索引；版本后缀 / 子串 / 大小写均不得命中）', () => {
    applyCatalogCacheSnapshot({
      version: 2,
      prices: {
        'deepseek-v4-flash': {
          inputPerMTok: 0.14,
          outputPerMTok: 0.28,
          readPerMTok: 0.0028,
          writeFree: true,
          currency: 'USD',
        },
      },
    });
    // 精确 id 命中
    expect(
      resolveCatalogCachePrices(ref('deepseek', 'deepseek-v4-flash'))?.readPerMTok
    ).toBeCloseTo(0.0028, 10);
    // 设计变更：字典是厂商维度出厂目录，配置树 providerId 是用户侧键，
    // 两者不同命名空间且树无 vendor 字段 → 字典查找**与 provider 无关**：
    // 同 id 换 provider 必须命中**同一条目**（不得因 provider 不符而未收录）。
    const byDeepseek = resolveCatalogCachePrices(
      ref('deepseek', 'deepseek-v4-flash')
    );
    const byOpenai = resolveCatalogCachePrices(
      ref('openai', 'deepseek-v4-flash')
    );
    const byZai = resolveCatalogCachePrices(ref('zai', 'deepseek-v4-flash'));
    expect(byOpenai).not.toBeNull();
    expect(byZai).not.toBeNull();
    expect(byOpenai).toEqual(byDeepseek);
    expect(byZai).toEqual(byDeepseek);
    // 旧实现：model.includes(key)（后缀）→ 命中；现必须未收录
    expect(
      resolveCatalogCachePrices(ref('deepseek', 'deepseek-v4-flash-0731'))
    ).toBeNull();
    // 旧实现：key.includes(model)（子串）→ 命中；现必须未收录
    expect(
      resolveCatalogCachePrices(ref('deepseek', 'deepseek-v4-flash'))
    ).not.toBeNull();
    expect(resolveCatalogCachePrices(ref('deepseek', 'flash'))).toBeNull();
    expect(resolveCatalogCachePrices(ref('deepseek', 'deepseek'))).toBeNull();
    // 大小写不是同一 id（id 精确等值，不归一大小写）
    expect(
      resolveCatalogCachePrices(ref('deepseek', 'DEEPSEEK-V4-FLASH'))
    ).toBeNull();
  });

  it('未收录模型不猜价也不猜币种（零本地副本）', () => {
    const unknown = ref('custom', 'my-unknown-model');
    expect(resolveModelPrice(unknown)).toBeNull();
    expect(getModelCurrency(unknown)).toBeNull();
    expect(resolveCatalogCachePrices(unknown)).toBeNull();
    expect(resolveEffectivePrice(unknown)).toBeNull();
    // 用户声明价落**统一树**（唯一价源）：声明后价格与币种均以声明为准
    installPriceTree([
      {
        providerId: 'custom',
        modelId: 'my-unknown-model',
        pricing: { currency: 'CNY', input: 1, output: 2 },
      },
    ]);
    expect(resolveModelPrice(unknown)?.inputPerMTok).toBe(1);
    expect(resolveEffectivePrice(unknown)).toMatchObject({
      source: 'user',
      currency: 'CNY',
    });
    expect(getModelCurrency(unknown)).toBe('CNY');
    // 出厂字典仍无该条目（声明不写回字典）
    expect(resolveCatalogCachePrices(unknown)).toBeNull();
  });
});

// ── 出厂字典真源驱动（取代前端静态全量表断言） ──────────────────────────────

type RawCatalog = {
  version?: number;
  entries?: Record<string, CatalogSnapshotEntryWire>;
};

function loadDictionaryWire(): CatalogSnapshotWire {
  const raw = JSON.parse(readFileSync(CATALOG_JSON, 'utf8')) as RawCatalog;
  return {
    version: raw.version ?? 0,
    entries: Object.values(raw.entries ?? {}),
  };
}

/** 真源条目 → 字典索引键（**模型 id**；设计变更后 provider 不参与索引） */
function dictKey(entry: CatalogSnapshotEntryWire): string {
  return normalizeModelIdText(entry.model);
}

function dictEntry(model: string): CatalogSnapshotEntryWire {
  const hit = (loadDictionaryWire().entries ?? []).find(
    (e) => e.model === model
  );
  if (!hit) throw new Error(`出厂字典缺失条目：${model}`);
  return hit;
}

/** 字典可索引的 id 面：每条目的 `model` 或 `apiModel`（归一化后） */
function dictionaryIdSurface(): Set<string> {
  const ids = new Set<string>();
  for (const e of loadDictionaryWire().entries ?? []) {
    const m = normalizeModelIdText(e.model);
    if (m) ids.add(m);
    const a = normalizeModelIdText(e.apiModel);
    if (a) ids.add(a);
  }
  return ids;
}

describe('出厂字典真源驱动（catalog.json → 快照 → 估算）', () => {
  beforeEach(() => {
    localStorage.removeItem(CACHE_TTL_MODE_KEY);
    clearCatalogCacheSnapshot();
    // 无树声明（空树 = 未加载）：估算一律走字典快照
    modelsCatalogStore.resetForTesting();
    applyCatalogCacheSnapshot(toCatalogCacheSnapshot(loadDictionaryWire()));
  });

  afterEach(() => {
    localStorage.removeItem(CACHE_TTL_MODE_KEY);
    clearCatalogCacheSnapshot();
    modelsCatalogStore.resetForTesting();
  });

  it('快照索引键 = 模型 id（字典内唯一键；零 (providerId, modelId) 二元组键）', () => {
    const wire = loadDictionaryWire();
    const snap = toCatalogCacheSnapshot(wire);
    const keys = Object.keys(snap.prices);
    expect(keys.length).toBeGreaterThan(0);

    const idSurface = dictionaryIdSurface();
    const modelIds = new Set(
      (wire.entries ?? [])
        .map((e) => normalizeModelIdText(e.model))
        .filter((m) => m.length > 0)
    );

    for (const key of keys) {
      // ① 索引键是**裸 id**：`parseModelRefKey` 一律解不出（不是二元组 JSON）
      expect(parseModelRefKey(key)).toBeNull();
      // ② 且必等于字典中某个条目的 `model` 或 `apiModel`
      expect(idSurface.has(key)).toBe(true);
    }

    // ③ 结构断言（不写死数量）：键集合无重复 = 同 id 只有一个索引槽
    expect(new Set(keys).size).toBe(keys.length);
    // ④ 结构断言：字典 model id 全部可索引（**除被不同价主张的歧义键**——那类按
    //    fail-closed「未收录」整键作废），且无 id 面之外的键
    const conflicted = conflictedKeysOf(wire.entries ?? []);
    expect(keys.length).toBeLessThanOrEqual(idSurface.size);
    for (const id of modelIds) {
      if (conflicted.has(id)) {
        expect(
          snap.prices[id],
          `歧义键 ${id} 必须整键作废（不得任选一个）`
        ).toBeUndefined();
        continue;
      }
      expect(snap.prices[id]).toBeDefined();
      // 键命名空间 == 查找命名空间：写入的键必须能被 lookup 侧（按 id、与
      // provider 无关）查到——否则「快照键」与「查找键」两套口径会静默错位。
      expect(resolveSnapshotPrice(ref('__any-provider__', id))).not.toBeNull();
    }
  });

  it('provider 缺失但 model 存在 → 保留（provider 不参与索引）；model 缺失 → 丢弃', () => {
    const snap = toCatalogCacheSnapshot({
      version: 1,
      entries: [
        { model: 'orphan-model', inputPrice: 1, outputPrice: 2 },
        {
          provider: 'openai',
          model: 'ok-model',
          inputPrice: 1,
          outputPrice: 2,
        },
        // 无 model（无 id）→ 无法索引，必须丢弃
        { provider: 'zai', inputPrice: 1, outputPrice: 2 },
        { provider: 'zai', model: '   ', inputPrice: 1, outputPrice: 2 },
      ],
    });
    expect(Object.keys(snap.prices).sort()).toEqual([
      'ok-model',
      'orphan-model',
    ]);

    // provider 缺失**不构成**「未收录」：价格决议只认 id
    applyCatalogCacheSnapshot(snap);
    expect(resolveSnapshotPrice(ref('any-provider', 'orphan-model'))).not.toBeNull();
    expect(
      resolve4dPrices(ref('any-provider', 'orphan-model'))?.inputPerMTok
    ).toBe(1);
    expect(resolveSnapshotPrice(ref('zai', 'ok-model'))?.inputPerMTok).toBe(1);
    // 无 id 的两条从未进入快照 → 无 provider 能查到它们的价
    expect(Object.keys(snap.prices)).toHaveLength(2);
  });

  it('同 id 不同价 → 该 id 作废（fail-closed 未收录），其他 id 不受影响', () => {
    const conflictWire: CatalogSnapshotWire = {
      version: 1,
      entries: [
        {
          provider: 'openai',
          model: 'conflict-model',
          inputPrice: 1,
          outputPrice: 2,
        },
        {
          provider: 'zai',
          model: 'conflict-model',
          inputPrice: 3,
          outputPrice: 4,
        },
        {
          provider: 'openai',
          model: 'stable-model',
          inputPrice: 5,
          outputPrice: 6,
        },
      ],
    };
    const snap = toCatalogCacheSnapshot(conflictWire);
    // 冲突 id 整体作废：不得任选一个
    expect(Object.keys(snap.prices)).not.toContain('conflict-model');
    expect(snap.prices['conflict-model']).toBeUndefined();
    // 其他 id 不受影响
    expect(snap.prices['stable-model']?.inputPerMTok).toBe(5);
    expect(Object.keys(snap.prices)).toEqual(['stable-model']);

    // 顺序无关：冲突条目先出现时同样整条作废（不是「后者覆盖」）
    const reversed = toCatalogCacheSnapshot({
      version: 1,
      entries: [...(conflictWire.entries ?? [])].reverse(),
    });
    expect(reversed.prices['conflict-model']).toBeUndefined();
    expect(reversed.prices['stable-model']?.inputPerMTok).toBe(5);

    // 同 id 同价（重复投影）不算冲突：保留（守卫只对「不同价」生效）
    const duplicated = toCatalogCacheSnapshot({
      version: 1,
      entries: [
        { model: 'dup-model', inputPrice: 1, outputPrice: 2 },
        {
          provider: 'zai',
          model: 'dup-model',
          inputPrice: 1,
          outputPrice: 2,
        },
      ],
    });
    expect(duplicated.prices['dup-model']?.inputPerMTok).toBe(1);

    // 估算面同样按「未收录」呈现：不得回落冲突条目任一侧价格
    applyCatalogCacheSnapshot(snap);
    expect(resolveSnapshotPrice(ref('openai', 'conflict-model'))).toBeNull();
    expect(resolveCatalogCachePrices(ref('openai', 'conflict-model'))).toBeNull();
    expect(resolveCatalogCachePrices(ref('zai', 'conflict-model'))).toBeNull();
    expect(resolve4dPrices(ref('openai', 'conflict-model'))).toBeNull();
    expect(estimateCostUsd4d(ref('openai', 'conflict-model'), 1e6, 0, 0, 0)).toBeNull();
    expect(estimateCostUsd(ref('openai', 'conflict-model'), 1e6, 0)).toBeNull();
    expect(resolve4dPrices(ref('openai', 'stable-model'))?.inputPerMTok).toBe(5);
  });

  it('前端独有旧 id 已随静态表消亡 → 未收录（漂移清零，不得回落本地表）', () => {
    // 旧静态表独有键（Rust 出厂字典无此 id、无同名 apiModel 别名）
    for (const model of [
      'gpt-5.6',
      'grok-4-5',
      'gemini-3-1-pro',
      'grok-4-3',
    ]) {
      expect(resolveCatalogCachePrices(ref('openai', model))).toBeNull();
      expect(resolveCatalogCachePrices(ref('xai', model))).toBeNull();
      expect(resolveCatalogCachePrices(ref('google', model))).toBeNull();
    }
  });

  it('长度分档消费（出厂字典 tieredPricing 落档，半开区间）', () => {
    // gemini-3-1-pro-preview：≥200K 档覆盖四价
    const g = ref('google', 'gemini-3-1-pro-preview');
    expect(resolveTierForTokens(g, 199_999)).toBeNull();
    expect(resolveTierForTokens(g, 200_000)?.minTokens).toBe(200_000);
    expect(resolve4dPrices(g)!.inputPerMTok).toBe(2);
    expect(resolve4dPrices(g)!.cacheReadPerMTok).toBe(0.2);
    expect(estimateCostUsd(g, 200_000, 0)).toBeCloseTo(0.8, 10);

    // grok-4.5：≥200K 档
    const grok = ref('xai', 'grok-4.5');
    expect(resolve4dPrices(grok)!.inputPerMTok).toBe(2);
    expect(resolveTierForTokens(grok, 200_000)?.cacheReadPerMTok).toBe(0.6);

    // qwen3-6-plus：≥256K 档覆盖写价（档内 10 vs 基础 2.5）
    const qwen = ref('dashscope', 'qwen3-6-plus');
    expect(resolve4dPrices(qwen)!.cacheWritePerMTok).toBe(2.5);
    expect(resolveTierForTokens(qwen, 256_000)?.cacheWritePerMTok).toBe(10);

    // 无 tier 模型：任意长度恒基础价
    expect(resolveTierForTokens(ref('deepseek', 'deepseek-v4-flash'), 1e6)).toBeNull();
  });

  it('估算消费出厂字典（写免费 / 币种 / 2D 与 4D 同源）', () => {
    const ds = ref('deepseek', 'deepseek-v4-flash');
    // 全命中：read 1e6 → 0.0028
    expect(estimateCostUsd4d(ds, 1_000_000, 0, 1_000_000, 0)).toBeCloseTo(
      0.0028,
      10
    );
    // 2D 全价：0.14
    expect(estimateCostUsd(ds, 1_000_000, 0)).toBeCloseTo(0.14, 10);
    // 节省 = 2D - 4D
    const save = estimateSavingsUsd(ds, 1_000_000, 0, 500_000, 0);
    expect(save).toBeCloseTo(0.14 - (0.07 + 0.0014), 10);
    expect(save).toBeGreaterThan(0);
    // CNY 模型成本按 CNY 计（不折算）
    expect(
      estimateCostUsd(ref('kimi', 'kimi-k3'), 1_000_000, 1_000_000)
    ).toBeCloseTo(120, 10);
  });

  it('字典条目带厂商字段（元数据，不参与索引）+ 索引键 = 条目 model id', () => {
    for (const model of ['deepseek-v4-flash', 'claude-sonnet-4-5', 'kimi-k3']) {
      const entry = dictEntry(model);
      // provider/vendor 是出厂目录的**厂商维度元数据**；树侧 providerId 与它
      // 不同命名空间，故它不参与前端索引（索引只用 model id）。
      expect(typeof entry.provider).toBe('string');
      expect(String(entry.provider).length).toBeGreaterThan(0);
      expect(dictKey(entry)).toBe(model);
    }
  });

  it('字典 id 唯一键：每条目 id 在快照中只有一个索引槽（含 apiModel 别名不覆盖主 id）', () => {
    const wire = loadDictionaryWire();
    const snap = toCatalogCacheSnapshot(wire);
    const entries = wire.entries ?? [];
    const modelIds = entries.map((e) => normalizeModelIdText(e.model));
    const primaryIds = new Set(modelIds);
    // 每个键的「主张者」计数：主 id 各占一席 + 各 apiModel 别名各占一席
    const claimants = new Map<string, number>();
    const claim = (k: string) => claimants.set(k, (claimants.get(k) ?? 0) + 1);
    for (const id of primaryIds) claim(id);
    for (const e of entries) {
      const a = normalizeModelIdText(e.apiModel);
      if (a && a !== normalizeModelIdText(e.model)) claim(a);
    }

    const conflicted = conflictedKeysOf(entries);

    for (const e of entries) {
      const id = normalizeModelIdText(e.model);
      const got = snap.prices[id];
      if (conflicted.has(id)) {
        // 歧义键（被不同价主张）→ 整键作废，不得任选一个
        expect(got, `歧义键 ${id} 必须整键作废`).toBeUndefined();
        continue;
      }
      // 主 id 全部存在，且价格 = 自身条目
      expect(got).toBeDefined();
      if (typeof e.inputPrice === 'number') {
        expect(got?.inputPerMTok).toBe(e.inputPrice);
      }
      const apiModel = normalizeModelIdText(e.apiModel);
      if (apiModel && apiModel !== id) {
        if (conflicted.has(apiModel)) {
          expect(
            snap.prices[apiModel],
            `歧义别名 ${apiModel} 必须整键作废`
          ).toBeUndefined();
          continue;
        }
        // 无价格竞争时别名键必须存在且与主条目同价
        expect(snap.prices[apiModel]).toBeDefined();
        expect(snap.prices[apiModel]).toEqual(got);
      }
    }
    // 结构断言：字典内 id 无重复（「id 作唯一键」的前提）
    expect(new Set(modelIds).size).toBe(modelIds.length);
    // 结构断言：别名不新增 id 语义 —— 键数 ≤ 主张者集合大小
    expect(Object.keys(snap.prices).length).toBeLessThanOrEqual(
      claimants.size
    );
  });
});
