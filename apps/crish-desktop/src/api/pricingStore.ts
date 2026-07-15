/**
 * Token pricing (per 1M tokens) for usage estimates.
 * Defaults approximate common public rates; user can override.
 */

export type ModelPrice = {
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
};

const PRICES_KEY = 'crish_model_prices_v1';

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

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const prices = loadPrices();
  const hit =
    prices.find((p) => p.model === model) ||
    prices.find((p) => model.includes(p.model) || p.model.includes(model));
  if (!hit) return 0;
  return (inputTokens / 1e6) * hit.inputPerMTok + (outputTokens / 1e6) * hit.outputPerMTok;
}
