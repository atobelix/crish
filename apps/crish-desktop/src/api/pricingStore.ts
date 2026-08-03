/**
 * Token pricing (per 1M tokens) for usage estimates.
 * Defaults approximate common public rates; user can override.
 *
 * v2 新增 4D 定价（input / output / cacheRead / cacheWrite），
 * 并保持与 v1 estimateCostUsd（2D）完全向下兼容。
 */

export type ModelPrice = {
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
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
 *        + cacheWrite * (Pcw = cacheWriteMultiplier * Pin)
 *        + cacheRead  * (Pcr = cacheReadMultiplier  * Pin)
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
  const Pcr = inputPerMTok * opts.cacheReadMultiplier;
  const Pcw = inputPerMTok * opts.cacheWriteMultiplier;

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
