/**
 * CATALOG_CACHE_RATES 静态表 — Anthropic 条目
 * （从 pricingCatalogDataA.ts 拆出，T4-11 SR-06-R1）。
 *
 * 数据源：docs/cache-optimization/10-model-catalog-v2/04-master-model-list.md
 */

import type { CatalogModelEntry4d } from './pricingTypes';

// ── 2. Anthropic（§2.1 表 A P0 11 条；USD）────────────────────────────────
// 写价双档：cacheWritePerMTok = 5m 档，cacheWritePerMTok1h = 1h 档（2x 输入价）；
// 命中 0.1x；cacheWriteFree:false（有写价）。Sonnet 5 促销价 8/31 到期。
export const CATALOG_RATES_ANTHROPIC: Record<string, CatalogModelEntry4d> = {
  'claude-fable-5': {
    inputPerMTok: 10,
    outputPerMTok: 50,
    cacheReadPerMTok: 1,
    cacheWritePerMTok: 12.5,
    cacheWriteFree: false,
    cacheWritePerMTok1h: 20,
    currency: 'USD',
  },
  'claude-mythos-5': {
    inputPerMTok: 10,
    outputPerMTok: 50,
    cacheReadPerMTok: 1,
    cacheWritePerMTok: 12.5,
    cacheWriteFree: false,
    cacheWritePerMTok1h: 20,
    currency: 'USD',
  },
  'claude-opus-5': {
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 6.25,
    cacheWriteFree: false,
    cacheWritePerMTok1h: 10,
    currency: 'USD',
  },
  'claude-opus-4-8': {
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 6.25,
    cacheWriteFree: false,
    cacheWritePerMTok1h: 10,
    currency: 'USD',
  },
  'claude-opus-4-7': {
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 6.25,
    cacheWriteFree: false,
    cacheWritePerMTok1h: 10,
    currency: 'USD',
  },
  'claude-opus-4-6': {
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 6.25,
    cacheWriteFree: false,
    cacheWritePerMTok1h: 10,
    currency: 'USD',
  },
  'claude-opus-4-5': {
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 6.25,
    cacheWriteFree: false,
    cacheWritePerMTok1h: 10,
    currency: 'USD',
  },
  // 促销价（promoExpiresAt 2026-08-31；9/1 涨标准价 3/15，价行不收录）
  'claude-sonnet-5': {
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 2.5,
    cacheWriteFree: false,
    cacheWritePerMTok1h: 4,
    currency: 'USD',
  },
  'claude-sonnet-4-6': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
    cacheWriteFree: false,
    cacheWritePerMTok1h: 6,
    currency: 'USD',
  },
  'claude-sonnet-4-5': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
    cacheWriteFree: false,
    cacheWritePerMTok1h: 6,
    currency: 'USD',
  },
  'claude-haiku-4-5': {
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
    cacheWriteFree: false,
    cacheWritePerMTok1h: 2,
    currency: 'USD',
  },
};
