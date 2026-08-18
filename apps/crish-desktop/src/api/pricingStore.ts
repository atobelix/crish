/**
 * pricingStore hub — Token pricing 装配层（T4-11 SR-06-R1 拆分后）。
 *
 * 本文件为拆分后的 hub（re-export + 装配），保持所有消费方 import 路径不变。
 * 子模块职责：
 * - pricingTypes.ts：类型契约 + 常量 + DEFAULT_PRICES
 * - pricingCatalogDataA/B/C.ts：CATALOG_CACHE_RATES 静态表（按厂商分组）
 * - pricingResolver.ts：目录条目查找 + 运行时快照状态
 * - pricingStore.ts（本文件）：用户价表存储 + 4D 解析/估算 + 缓存选项/TTL
 *
 * 顶部注释（v2/v3/v4 裁决全文）见 pricingTypes.ts。
 */

// ── re-export：类型契约与常量 ──────────────────────────────────────────────
export type {
  ModelPrice,
  Currency,
  CacheTtlMode,
  CachePriceOpts,
  CatalogTier,
  CatalogModelEntry4d,
  CatalogSnapshotPrice,
  CatalogCacheSnapshot,
  Resolved4dPrices,
} from './pricingTypes';

export {
  PRICES_KEY,
  CACHE_OPTS_KEY,
  CACHE_TTL_MODE_KEY,
  DEFAULT_CACHE_READ_MULTIPLIER,
  DEFAULT_CACHE_WRITE_MULTIPLIER,
  DEFAULT_CACHE_TTL_MODE,
  DEFAULT_PRICES,
} from './pricingTypes';

// ── re-export：目录解析器与快照状态 ────────────────────────────────────────
export { CATALOG_CACHE_RATES } from './pricingResolver';
export { resolveCatalogEntry } from './pricingResolver';
export { resolveSnapshotPrice } from './pricingResolver';
export { applyCatalogCacheSnapshot } from './pricingResolver';
export { clearCatalogCacheSnapshot } from './pricingResolver';
export { resolveCatalogCachePrices } from './pricingResolver';

// ── 本 hub 实现：用户价表存储 + 估算 + 缓存选项 ────────────────────────────
import {
  PRICES_KEY,
  CACHE_OPTS_KEY,
  CACHE_TTL_MODE_KEY,
  DEFAULT_CACHE_READ_MULTIPLIER,
  DEFAULT_CACHE_WRITE_MULTIPLIER,
  DEFAULT_CACHE_TTL_MODE,
  DEFAULT_PRICES,
  type ModelPrice,
  type CachePriceOpts,
  type CacheTtlMode,
  type Currency,
  type CatalogTier,
  type Resolved4dPrices,
} from './pricingTypes';
import {
  resolveCatalogEntry,
  resolveSnapshotPrice,
} from './pricingResolver';

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
 * 查询模型币种（v4；供展示层标注，不做汇率换算）。
 * 优先级：用户编辑价表 currency（用户可覆盖）→ 目录条目 currency → null（未知）。
 */
export function getModelCurrency(model: string): Currency | null {
  const hit = resolveModelPrice(model);
  if (hit?.currency) return hit.currency;
  return resolveCatalogEntry(model)?.currency ?? null;
}

/**
 * 2D 估算：不考虑 cache（向下兼容）。
 * v4：目录模型未在用户价表时由目录绝对价兜底（如 kimi-k3/qwen3-8-max）；
 * P1B：按估算 input 长度落档（tieredPricing，超档用高档价）；
 * 返回值 = 模型自身币种金额（CNY 模型为人民币），展示层用 getModelCurrency 标注。
 */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const p = resolve4dPricesForTokens(model, inputTokens);
  if (!p) return 0;
  return (
    (inputTokens / 1e6) * p.inputPerMTok +
    (outputTokens / 1e6) * p.outputPerMTok
  );
}

/**
 * 四指标价格解析（v4 回退链，任务书裁决）：
 *   输入/输出价：用户编辑价表（覆盖）→ 运行时快照（Rust 目录真源）→
 *     目录绝对价 → null（不估算）。
 *   缓存读价：运行时快照 → 目录绝对价（null = 未获取）→ 用户扩展字段 → 全局乘数。
 *   缓存写价：运行时快照（无免费位语义，绝对值直用）→ 目录条目
 *     （cacheWriteFree → 0；TTL=1h 且有条目 1h 档 → 用 1h 写价）
 *     → 用户扩展字段 → 全局乘数。
 * 存储费不入前端（服务端核算）；tieredPricing 档位匹配见 [resolve4dPricesForTokens]。
 */
export function resolve4dPrices(model: string): Resolved4dPrices | null {
  const hit = resolveModelPrice(model);
  const entry = resolveCatalogEntry(model);
  const snap = resolveSnapshotPrice(model);
  const opts = loadCachePriceOpts();

  const inputPerMTok =
    hit?.inputPerMTok ?? snap?.inputPerMTok ?? entry?.inputPerMTok;
  const outputPerMTok =
    hit?.outputPerMTok ?? snap?.outputPerMTok ?? entry?.outputPerMTok;
  if (inputPerMTok == null || outputPerMTok == null) return null;

  const currency: Currency = hit?.currency ?? entry?.currency ?? 'USD';
  const ttlMode = loadCacheTtlMode();

  let source: Resolved4dPrices['source'] = 'multiplier';

  // 缓存读价回退链
  let cacheReadPerMTok: number;
  if (snap?.readPerMTok != null) {
    cacheReadPerMTok = snap.readPerMTok;
    source = 'snapshot';
  } else if (entry && entry.cacheReadPerMTok != null) {
    cacheReadPerMTok = entry.cacheReadPerMTok;
    source = 'catalog';
  } else if (hit?.cacheReadPerMTok !== undefined) {
    cacheReadPerMTok = hit.cacheReadPerMTok;
    source = 'user';
  } else {
    cacheReadPerMTok = inputPerMTok * opts.cacheReadMultiplier;
  }

  // 缓存写价回退链（source 以写价来源为准）
  let cacheWritePerMTok: number;
  let cacheWriteFree = false;
  let hasWrite1hTier = false;
  if (snap?.writePerMTok != null) {
    cacheWritePerMTok = snap.writePerMTok;
    source = 'snapshot';
  } else if (entry) {
    cacheWriteFree = entry.cacheWriteFree;
    cacheWritePerMTok = entry.cacheWriteFree ? 0 : entry.cacheWritePerMTok;
    if (entry.cacheWritePerMTok1h !== undefined) {
      hasWrite1hTier = true;
      if (ttlMode === '1h') {
        cacheWritePerMTok = entry.cacheWritePerMTok1h;
      }
    }
    source = 'catalog';
  } else if (hit?.cacheWritePerMTok !== undefined) {
    cacheWritePerMTok = hit.cacheWritePerMTok;
    source = 'user';
  } else {
    cacheWritePerMTok = inputPerMTok * opts.cacheWriteMultiplier;
  }

  return {
    inputPerMTok,
    outputPerMTok,
    cacheReadPerMTok,
    cacheWritePerMTok,
    cacheWriteFree,
    currency,
    source,
    hasWrite1hTier,
  };
}

/**
 * 输入长度分档命中（P1B / DEEPCHECK-05 #8 前端消费面）：
 * 快照 tiered 优先于静态表 tiered；半开区间 [minTokens, maxTokens)，
 * maxTokens 缺省 = 无上界。无档 / 不落档 → null（沿用基础四价）。
 */
export function resolveTierForTokens(
  model: string,
  inputTokens: number
): CatalogTier | null {
  const tiers =
    resolveSnapshotPrice(model)?.tiered ??
    resolveCatalogEntry(model)?.tiered;
  if (!tiers || tiers.length === 0) return null;
  return (
    tiers.find(
      (t) =>
        inputTokens >= t.minTokens &&
        (t.maxTokens === undefined || inputTokens < t.maxTokens)
    ) ?? null
  );
}

/**
 * 用户是否显式保存过价表（PRICES_KEY 有记录）。
 *
 * LS 为空时 `loadPrices` 返回 [DEFAULT_PRICES] 仅作展示兜底——默认价表是
 * 目录基础价的镜像（grok-4.5 2/6 等），**不构成用户覆盖**：目录分档语义
 * （tieredPricing）照常生效。用户显式保存（设置页编辑 / upsertPrice）后
 * 才视为接管：整表（含默认行）覆盖目录，含分档。
 */
function hasUserSavedPrices(): boolean {
  try {
    return localStorage.getItem(PRICES_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * 分档四价解析：基础 [resolve4dPrices] 结果上按估算 input 长度落档，
 * 档内覆盖价替换（未覆盖字段沿用基础价）。
 *
 * 用户**显式保存**价表后，命中的模型整条不落档（用户显式定价覆盖目录
 * 全部语义，含分档）；纯默认价表（未编辑）下目录档位照常生效。
 */
export function resolve4dPricesForTokens(
  model: string,
  inputTokens: number
): Resolved4dPrices | null {
  const base = resolve4dPrices(model);
  if (!base) return null;
  // 用户显式保存的价表命中 → 用户覆盖，跳过档位匹配
  if (resolveModelPrice(model) && hasUserSavedPrices()) return base;
  const tier = resolveTierForTokens(model, inputTokens);
  if (!tier) return base;
  return {
    ...base,
    inputPerMTok: tier.inputPerMTok ?? base.inputPerMTok,
    outputPerMTok: tier.outputPerMTok ?? base.outputPerMTok,
    cacheReadPerMTok: tier.cacheReadPerMTok ?? base.cacheReadPerMTok,
    cacheWritePerMTok: tier.cacheWritePerMTok ?? base.cacheWritePerMTok,
  };
}

/**
 * 4D 估算：区分 cache hit/write 与普通 input 的不同费率。
 *
 * 公式（v4 四指标，任务书 §3）：
 *   nonCached = max(0, prompt - cacheRead - cacheWrite)
 *   cost = nonCached * Pin + completion * Pout
 *        + cacheWrite * Pcw + cacheRead * Pcr
 *
 * Pcr/Pcw 由 resolve4dPrices 按 v4 回退链解析：
 *   运行时快照 → 目录静态表绝对四价（写免费 → 0；TTL=1h 时用 Anthropic 1h 档）
 *   → 用户编辑价表扩展字段 → 全局乘数兜底（× Pin）→ 无价 → 返回 0（不估算）。
 * P1B：按估算 input 长度（promptTokens）落 tieredPricing 档，超档用高档价
 * （DEEPCHECK-05 #8：长上下文成本低估 ≈45% 修复）。
 * 返回值 = 模型自身币种金额（CNY 模型为人民币；函数名 Usd 为历史遗留，
 * 展示层用 getModelCurrency() 标注币种）。
 */
export function estimateCostUsd4d(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number
): number {
  const p = resolve4dPricesForTokens(model, promptTokens);
  if (!p) return 0;

  const nonCached = Math.max(
    0,
    promptTokens - cacheReadTokens - cacheWriteTokens
  );
  return (
    (nonCached / 1e6) * p.inputPerMTok +
    (completionTokens / 1e6) * p.outputPerMTok +
    (cacheWriteTokens / 1e6) * p.cacheWritePerMTok +
    (cacheReadTokens / 1e6) * p.cacheReadPerMTok
  );
}

/**
 * 估算缓存节省的费用：max(0, 全量 2D 成本 - 4D 实际成本)。
 * 2D/4D 同币种口径（模型自身币种），差值同币种。
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

/**
 * 加载缓存 TTL 档（v4；决定 Anthropic 写价取 5m 还是 1h 档）。
 * 默认 '5m'；非法值回落默认。MiniMax 等无 1h 档字段的模型不受影响。
 */
export function loadCacheTtlMode(): CacheTtlMode {
  try {
    const raw = localStorage.getItem(CACHE_TTL_MODE_KEY);
    if (raw === '5m' || raw === '1h') return raw;
  } catch {
    /* ignore */
  }
  return DEFAULT_CACHE_TTL_MODE;
}

/**
 * 保存缓存 TTL 档（'5m' | '1h'；其余值归一为默认）。
 * @returns 实际保存的档位（用于校验）
 */
export function saveCacheTtlMode(mode: CacheTtlMode): CacheTtlMode {
  const normalized: CacheTtlMode = mode === '1h' ? '1h' : '5m';
  try {
    localStorage.setItem(CACHE_TTL_MODE_KEY, normalized);
  } catch {
    /* ignore */
  }
  return normalized;
}
