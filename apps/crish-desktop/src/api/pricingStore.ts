/**
 * Token pricing (per 1M tokens) for usage estimates.
 * Defaults approximate common public rates; user can override.
 *
 * v2 新增 4D 定价（input / output / cacheRead / cacheWrite），
 * 并保持与 v1 estimateCostUsd（2D）完全向下兼容。
 *
 * v3 新增缓存费率三级优先（P5 §3.5.1，T-48）：
 *   per-model 目录价（CATALOG_CACHE_RATES 静态表 + catalog_get 快照）
 *   → 用户编辑价表扩展字段 → 全局乘数兜底。
 * 数据源：00-vendor-model-pricing-catalog.md（2026-08-02）。
 */

export type ModelPrice = {
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
  /**
   * 三级费率第 2 级（可选扩展字段，用户编辑价表）：
   * 缓存命中单价（USD/1M tokens）；缺省时按费率解析回退。
   */
  cacheReadPerMTok?: number;
  /** 三级费率第 2 级：缓存写入单价（USD/1M tokens）；缺省时按费率解析回退 */
  cacheWritePerMTok?: number;
};

export interface CachePriceOpts {
  /** cacheRead 费率 = cacheReadMultiplier * inputPerMTok */
  cacheReadMultiplier: number;
  /** cacheWrite 费率 = cacheWriteMultiplier * inputPerMTok */
  cacheWriteMultiplier: number;
}

const PRICES_KEY = 'crish_model_prices_v1';
const CACHE_OPTS_KEY = 'crish_cache_price_opts_v1';

/** cacheRead token 费率相对 inputPerMTok 的默认系数 */
export const DEFAULT_CACHE_READ_MULTIPLIER = 0.1;
/** cacheWrite token 费率相对 inputPerMTok 的默认系数 */
export const DEFAULT_CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * per-model 缓存费率目录（三级费率第 1 级，静态兜底表）。
 *
 * 数据源：docs/cache-optimization/00-vendor-model-pricing-catalog.md
 * （2026-08-02）+ crates/agent-provider/src/models/catalog.json（28 条转录，
 * §12.4.1）。费率 = 缓存命中价 / 输入价（readMultiplier），写价系数
 * （writeMultiplier，0 = 写免费 cacheWriteFree）：
 * - DeepSeek：§3.1（flash 2%、pro ≈0.83%，官方无写价概念）
 * - Anthropic：§1.1（命中 10%；5m 写 1.25x）
 * - GPT-5.6：§2.2（命中 10%；写 1.25x）；GPT-5.5 旧轨写免费
 * - Kimi：§5.1（K3 命中 10%，无写费）
 * - Grok：§6.1（4.5 命中 15%、4.3 ≈16%，无写费）
 * - MiniMax：§7.1（M2.7/M3 20%、M2.5 10%；M3 无写入费）
 * - Gemini：§8.1（命中 10%，写无费——存储费另计不入本表）
 * - GLM：§4.1（z.ai 命中 15%~20%，无写费）
 * - Qwen：§11.1 A（百炼显式缓存命中 10%、创建 125%；绝对价未获取
 *   §11.3，按折扣比例折算）
 */
export const CATALOG_CACHE_RATES: Record<
  string,
  { readMultiplier: number; writeMultiplier: number }
> = {
  'deepseek-v4-flash': { readMultiplier: 0.02, writeMultiplier: 0 },
  'deepseek-v4-pro': { readMultiplier: 0.0083, writeMultiplier: 0 },
  'claude-fable-5': { readMultiplier: 0.1, writeMultiplier: 1.25 },
  'claude-mythos-5': { readMultiplier: 0.1, writeMultiplier: 1.25 },
  'claude-opus-5': { readMultiplier: 0.1, writeMultiplier: 1.25 },
  'claude-opus-4-5': { readMultiplier: 0.1, writeMultiplier: 1.25 },
  'claude-sonnet-5': { readMultiplier: 0.1, writeMultiplier: 1.25 },
  'claude-sonnet-4-5': { readMultiplier: 0.1, writeMultiplier: 1.25 },
  'claude-haiku-4-5': { readMultiplier: 0.1, writeMultiplier: 1.25 },
  'gpt-5.6': { readMultiplier: 0.1, writeMultiplier: 1.25 },
  'gpt-5.5': { readMultiplier: 0.1, writeMultiplier: 0 },
  'kimi-k3': { readMultiplier: 0.1, writeMultiplier: 0 },
  'grok-4-5': { readMultiplier: 0.15, writeMultiplier: 0 },
  'grok-4-3': { readMultiplier: 0.16, writeMultiplier: 0 },
  'minimax-m2-7': { readMultiplier: 0.2, writeMultiplier: 1.25 },
  'minimax-m2-5': { readMultiplier: 0.1, writeMultiplier: 1.25 },
  'minimax-m3': { readMultiplier: 0.2, writeMultiplier: 0 },
  'gemini-3-6-flash': { readMultiplier: 0.1, writeMultiplier: 0 },
  'gemini-3-5-flash': { readMultiplier: 0.1, writeMultiplier: 0 },
  'gemini-3-5-flash-lite': { readMultiplier: 0.1, writeMultiplier: 0 },
  'gemini-3-1-pro': { readMultiplier: 0.1, writeMultiplier: 0 },
  'glm-5-2': { readMultiplier: 0.1857, writeMultiplier: 0 },
  'glm-5': { readMultiplier: 0.2, writeMultiplier: 0 },
  'glm-4-7': { readMultiplier: 0.1833, writeMultiplier: 0 },
  'glm-4-5-air': { readMultiplier: 0.15, writeMultiplier: 0 },
  'qwen3-max': { readMultiplier: 0.1, writeMultiplier: 1.25 },
  'qwen3-7-max': { readMultiplier: 0.1, writeMultiplier: 1.25 },
  'qwen3-coder-plus': { readMultiplier: 0.1, writeMultiplier: 1.25 },
};

/** 目录费率查找：精确 + 模糊匹配（与 resolveModelPrice 同规则） */
function resolveCatalogRates(model: string): {
  readMultiplier: number;
  writeMultiplier: number;
} | null {
  const exact = CATALOG_CACHE_RATES[model];
  if (exact) return exact;
  for (const key of Object.keys(CATALOG_CACHE_RATES)) {
    if (model.includes(key) || key.includes(model)) {
      const rates = CATALOG_CACHE_RATES[key];
      if (rates) return rates;
    }
  }
  return null;
}

/** 运行时目录快照（P3 `catalog_get` 下发；版本号失效语义） */
export interface CatalogCacheSnapshot {
  version: number;
  /** model → 缓存单价（USD/1M tokens；绝对值优先于静态费率表） */
  prices: Record<string, { readPerMTok: number; writePerMTok: number }>;
}

let catalogSnapshot: CatalogCacheSnapshot | null = null;

/**
 * 注入运行时目录快照（数据源 = Rust catalog_get；前端只读快照缓存）。
 * 版本号不递增（旧于当前快照）时忽略——「版本号失效」语义：
 * 新版本覆盖旧版本，同版本幂等。
 */
export function applyCatalogCacheSnapshot(
  snapshot: CatalogCacheSnapshot | null
): void {
  if (!snapshot) {
    catalogSnapshot = null;
    return;
  }
  if (catalogSnapshot && snapshot.version <= catalogSnapshot.version) {
    return;
  }
  catalogSnapshot = snapshot;
}

/** 测试辅助：清空运行时快照（回退静态表） */
export function clearCatalogCacheSnapshot(): void {
  catalogSnapshot = null;
}

/**
 * 三级费率第 1 级：per-model 目录缓存价（USD/1M）。
 * 优先运行时快照（catalog_get 下发绝对值），否则静态费率表
 * （费率 × 用户价表 inputPerMTok）；两者都取不到 → null（回退下级）。
 */
export function resolveCatalogCachePrices(
  model: string
): { readPerMTok?: number; writePerMTok?: number } | null {
  const snap = catalogSnapshot?.prices[model];
  if (snap) {
    return {
      readPerMTok: snap.readPerMTok,
      writePerMTok: snap.writePerMTok,
    };
  }
  const rates = resolveCatalogRates(model);
  if (!rates) return null;
  const hit = resolveModelPrice(model);
  if (!hit) return null;
  return {
    readPerMTok: hit.inputPerMTok * rates.readMultiplier,
    writePerMTok: hit.inputPerMTok * rates.writeMultiplier,
  };
}

/**
 * Official-ish defaults (USD / 1M tokens) — user-editable.
 *
 * 数据来源：docs/cache-optimization/00-vendor-model-pricing-catalog.md（2026-08-02）：
 * - gpt-5.6：§2.2（litellm 副本口径，input 5e-06 / output 3e-05）
 * - deepseek-v4-flash / deepseek-v4-pro：§3.1
 * - claude-haiku-4-5 / claude-sonnet-4-5 / claude-opus-4-5：§1.1
 * - glm-5.2：§4.1（官方直连 USD 价）
 * - grok-4.5：§6.1
 * 注：Kimi（§5.1）、MiniMax（§7.1）、豆包（§9.1）官方价为 CNY，Qwen 命中价未获取（§11.3），均不纳入本 USD 表。
 */
export const DEFAULT_PRICES: ModelPrice[] = [
  { model: 'gpt-5.6', inputPerMTok: 5, outputPerMTok: 30 },
  { model: 'deepseek-v4-flash', inputPerMTok: 0.14, outputPerMTok: 0.28 },
  { model: 'deepseek-v4-pro', inputPerMTok: 0.435, outputPerMTok: 0.87 },
  { model: 'claude-haiku-4-5', inputPerMTok: 1, outputPerMTok: 5 },
  { model: 'claude-sonnet-4-5', inputPerMTok: 3, outputPerMTok: 15 },
  { model: 'claude-opus-4-5', inputPerMTok: 5, outputPerMTok: 25 },
  { model: 'glm-5.2', inputPerMTok: 1.4, outputPerMTok: 4.4 },
  { model: 'grok-4.5', inputPerMTok: 2, outputPerMTok: 6 },
];

export function loadPrices(): ModelPrice[] {
  try {
    const raw = localStorage.getItem(PRICES_KEY);
    if (!raw) return [...DEFAULT_PRICES];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) && arr.length ? arr : [...DEFAULT_PRICES];
  } catch {
    return [...DEFAULT_PRICES];
  }
}

export function savePrices(list: ModelPrice[]) {
  localStorage.setItem(PRICES_KEY, JSON.stringify(list));
}

export function upsertPrice(entry: ModelPrice) {
  const list = loadPrices().filter((p) => p.model !== entry.model);
  list.push(entry);
  savePrices(list);
  return list;
}

/**
 * 精确+模糊匹配模型价格，未找到返回 null。
 */
export function resolveModelPrice(model: string): ModelPrice | null {
  const prices = loadPrices();
  const exact = prices.find((p) => p.model === model);
  if (exact) return exact;
  const fuzzy = prices.find(
    (p) => model.includes(p.model) || p.model.includes(model)
  );
  return fuzzy ?? null;
}

/**
 * 2D 估算：不考虑 cache（向下兼容）。
 */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const hit = resolveModelPrice(model);
  if (!hit) return 0;
  return (
    (inputTokens / 1e6) * hit.inputPerMTok +
    (outputTokens / 1e6) * hit.outputPerMTok
  );
}

/**
 * 4D 估算：区分 cache hit/write 与普通 input 的不同费率。
 *
 * 公式：
 *   nonCached = prompt - cacheRead - cacheWrite   (≥0)
 *   cost = nonCached * Pin + completion * Pout
 *        + cacheWrite * (Pcw = cacheWritePerMTok)
 *        + cacheRead  * (Pcr = cacheReadPerMTok)
 *
 * Pcr/Pcw 费率解析三级优先（P5 §3.5.1，函数签名不变、消费面零破坏）：
 *   1. per-model 目录价（CATALOG_CACHE_RATES 静态表 / catalog_get 快照）；
 *   2. 用户编辑价表扩展字段（ModelPrice.cacheReadPerMTok / cacheWritePerMTok）；
 *   3. 全局乘数兜底（cacheReadMultiplier / cacheWriteMultiplier × Pin）。
 */
export function estimateCostUsd4d(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number
): number {
  const hit = resolveModelPrice(model);
  if (!hit) return 0;

  const opts = loadCachePriceOpts();
  const { inputPerMTok, outputPerMTok } = hit;

  let Pcr: number;
  let Pcw: number;
  const catalog = resolveCatalogCachePrices(model);
  if (catalog) {
    // 第 1 级：per-model 目录价（0 = 该厂商写免费，如 DeepSeek/Kimi）
    Pcr = catalog.readPerMTok ?? inputPerMTok * opts.cacheReadMultiplier;
    Pcw = catalog.writePerMTok ?? inputPerMTok * opts.cacheWriteMultiplier;
  } else if (
    hit.cacheReadPerMTok !== undefined ||
    hit.cacheWritePerMTok !== undefined
  ) {
    // 第 2 级：用户编辑价表扩展字段（缺省侧回退全局乘数）
    Pcr = hit.cacheReadPerMTok ?? inputPerMTok * opts.cacheReadMultiplier;
    Pcw = hit.cacheWritePerMTok ?? inputPerMTok * opts.cacheWriteMultiplier;
  } else {
    // 第 3 级：全局乘数兜底
    Pcr = inputPerMTok * opts.cacheReadMultiplier;
    Pcw = inputPerMTok * opts.cacheWriteMultiplier;
  }

  const nonCached = Math.max(
    0,
    promptTokens - cacheReadTokens - cacheWriteTokens
  );
  return (
    (nonCached / 1e6) * inputPerMTok +
    (completionTokens / 1e6) * outputPerMTok +
    (cacheWriteTokens / 1e6) * Pcw +
    (cacheReadTokens / 1e6) * Pcr
  );
}

/**
 * 估算缓存节省的费用：max(0, 全量 2D 成本 - 4D 实际成本)。
 */
export function estimateSavingsUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number
): number {
  const full = estimateCostUsd(model, promptTokens, completionTokens);
  const actual = estimateCostUsd4d(
    model,
    promptTokens,
    completionTokens,
    cacheReadTokens,
    cacheWriteTokens
  );
  return Math.max(0, full - actual);
}

/** 加载 cache 费率选项，缺失则返回默认值 */
export function loadCachePriceOpts(): CachePriceOpts {
  try {
    const raw = localStorage.getItem(CACHE_OPTS_KEY);
    if (!raw)
      return {
        cacheReadMultiplier: DEFAULT_CACHE_READ_MULTIPLIER,
        cacheWriteMultiplier: DEFAULT_CACHE_WRITE_MULTIPLIER,
      };
    const o = JSON.parse(raw) as Partial<CachePriceOpts>;
    const read =
      typeof o.cacheReadMultiplier === 'number' && o.cacheReadMultiplier > 0
        ? o.cacheReadMultiplier
        : DEFAULT_CACHE_READ_MULTIPLIER;
    const write =
      typeof o.cacheWriteMultiplier === 'number' && o.cacheWriteMultiplier > 0
        ? o.cacheWriteMultiplier
        : DEFAULT_CACHE_WRITE_MULTIPLIER;
    return { cacheReadMultiplier: read, cacheWriteMultiplier: write };
  } catch {
    return {
      cacheReadMultiplier: DEFAULT_CACHE_READ_MULTIPLIER,
      cacheWriteMultiplier: DEFAULT_CACHE_WRITE_MULTIPLIER,
    };
  }
}

/**
 * 保存 cache 费率选项。非正数/NaN 值回落到默认值。
 * @returns 实际保存的选项（用于校验）
 */
export function saveCachePriceOpts(
  opts: Partial<CachePriceOpts>
): CachePriceOpts {
  const read =
    typeof opts.cacheReadMultiplier === 'number' && opts.cacheReadMultiplier > 0
      ? opts.cacheReadMultiplier
      : DEFAULT_CACHE_READ_MULTIPLIER;
  const write =
    typeof opts.cacheWriteMultiplier === 'number' &&
    opts.cacheWriteMultiplier > 0
      ? opts.cacheWriteMultiplier
      : DEFAULT_CACHE_WRITE_MULTIPLIER;
  const normalized: CachePriceOpts = {
    cacheReadMultiplier: read,
    cacheWriteMultiplier: write,
  };
  try {
    localStorage.setItem(CACHE_OPTS_KEY, JSON.stringify(normalized));
  } catch {
    /* ignore */
  }
  return normalized;
}
