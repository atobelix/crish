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

/** Official-ish defaults (USD / 1M tokens) — user-editable */
export const DEFAULT_PRICES: ModelPrice[] = [
  { model: 'gpt-4o', inputPerMTok: 2.5, outputPerMTok: 10 },
  { model: 'gpt-4o-mini', inputPerMTok: 0.15, outputPerMTok: 0.6 },
  { model: 'deepseek-chat', inputPerMTok: 0.27, outputPerMTok: 1.1 },
  { model: 'deepseek-v4-flash', inputPerMTok: 0.14, outputPerMTok: 0.28 },
  { model: 'mimo-v2.5', inputPerMTok: 0.5, outputPerMTok: 1.5 },
  { model: 'claude-3-5-sonnet', inputPerMTok: 3, outputPerMTok: 15 },
  { model: 'gemini-1.5-pro', inputPerMTok: 1.25, outputPerMTok: 5 },
  { model: 'gemini-1.5-flash', inputPerMTok: 0.075, outputPerMTok: 0.3 },
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
    (p) => model.includes(p.model) || p.model.includes(model),
  );
  return fuzzy ?? null;
}

/**
 * 2D 估算：不考虑 cache（向下兼容）。
 */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const hit = resolveModelPrice(model);
  if (!hit) return 0;
  return (inputTokens / 1e6) * hit.inputPerMTok + (outputTokens / 1e6) * hit.outputPerMTok;
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
  cacheWriteTokens: number,
): number {
  const hit = resolveModelPrice(model);
  if (!hit) return 0;

  const opts = loadCachePriceOpts();
  const { inputPerMTok, outputPerMTok } = hit;
  const Pcr = inputPerMTok * opts.cacheReadMultiplier;
  const Pcw = inputPerMTok * opts.cacheWriteMultiplier;

  const nonCached = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
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
  cacheWriteTokens: number,
): number {
  const full = estimateCostUsd(model, promptTokens, completionTokens);
  const actual = estimateCostUsd4d(model, promptTokens, completionTokens, cacheReadTokens, cacheWriteTokens);
  return Math.max(0, full - actual);
}

/** 加载 cache 费率选项，缺失则返回默认值 */
export function loadCachePriceOpts(): CachePriceOpts {
  try {
    const raw = localStorage.getItem(CACHE_OPTS_KEY);
    if (!raw) return {
      cacheReadMultiplier: DEFAULT_CACHE_READ_MULTIPLIER,
      cacheWriteMultiplier: DEFAULT_CACHE_WRITE_MULTIPLIER,
    };
    const o = JSON.parse(raw) as Partial<CachePriceOpts>;
    const read = typeof o.cacheReadMultiplier === 'number' && o.cacheReadMultiplier > 0
      ? o.cacheReadMultiplier
      : DEFAULT_CACHE_READ_MULTIPLIER;
    const write = typeof o.cacheWriteMultiplier === 'number' && o.cacheWriteMultiplier > 0
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
export function saveCachePriceOpts(opts: Partial<CachePriceOpts>): CachePriceOpts {
  const read = typeof opts.cacheReadMultiplier === 'number' && opts.cacheReadMultiplier > 0
    ? opts.cacheReadMultiplier
    : DEFAULT_CACHE_READ_MULTIPLIER;
  const write = typeof opts.cacheWriteMultiplier === 'number' && opts.cacheWriteMultiplier > 0
    ? opts.cacheWriteMultiplier
    : DEFAULT_CACHE_WRITE_MULTIPLIER;
  const normalized: CachePriceOpts = { cacheReadMultiplier: read, cacheWriteMultiplier: write };
  try {
    localStorage.setItem(CACHE_OPTS_KEY, JSON.stringify(normalized));
  } catch { /* ignore */ }
  return normalized;
}
