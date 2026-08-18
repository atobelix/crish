/**
 * CATALOG_CACHE_RATES 静态表 — Qwen 阿里百炼条目
 * （从 pricingCatalogDataB.ts 拆出，T4-11 SR-06-R1；T4-11 R2 按厂商进一步细分）。
 *
 * 数据源：docs/cache-optimization/10-model-catalog-v2/04-master-model-list.md
 */

import type { CatalogModelEntry4d } from './pricingTypes';

// ── 5. Qwen 阿里百炼（§5.1 表 A；CNY）─────────────────────────────────────
// 全系推导价（priceStatus: derived）：cacheRead = 输入 × 10%、
// cacheWrite = 输入 × 125%（官方只给比例）；有写价概念 → free:false。
// 阶梯档已收录（估算落档消费；如 qwen3-8-max ≥128K 档 15/90）；多档「/」分隔时
// 取 [0,32K)/[0,128K) 档为基础价。
// 点号官方名（qwen3.7-max）目录横线形态；保留 v1 旧键 qwen3-7-max 作别名。
export const CATALOG_RATES_QWEN: Record<string, CatalogModelEntry4d> = {
  'qwen3-8-max': {
    inputPerMTok: 12,
    outputPerMTok: 36,
    cacheReadPerMTok: 1.2,
    cacheWritePerMTok: 15,
    cacheWriteFree: false,
    currency: 'CNY',
  },
  'qwen3-7-max': {
    inputPerMTok: 12,
    outputPerMTok: 36,
    cacheReadPerMTok: 1.2,
    cacheWritePerMTok: 15,
    cacheWriteFree: false,
    currency: 'CNY',
  },
  'qwen3.7-max': {
    inputPerMTok: 12,
    outputPerMTok: 36,
    cacheReadPerMTok: 1.2,
    cacheWritePerMTok: 15,
    cacheWriteFree: false,
    currency: 'CNY',
  },
  'qwen3-6-max-preview': {
    inputPerMTok: 9,
    outputPerMTok: 54,
    cacheReadPerMTok: 0.9,
    cacheWritePerMTok: 11.25,
    cacheWriteFree: false,
    currency: 'CNY',
  },
  'qwen3-max': {
    inputPerMTok: 2.5,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.25,
    cacheWritePerMTok: 3.125,
    cacheWriteFree: false,
    currency: 'CNY',
  },
  'qwen3-7-plus': {
    inputPerMTok: 2,
    outputPerMTok: 8,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 2.5,
    cacheWriteFree: false,
    currency: 'CNY',
  },
  'qwen3-6-plus': {
    inputPerMTok: 2,
    outputPerMTok: 12,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 2.5,
    cacheWriteFree: false,
    currency: 'CNY',
    // ≥256K 档（DEEPCHECK-05 §8：qwen3-6-plus 输入 2→8，低估 75%）
    tiered: [
      { minTokens: 256_000, inputPerMTok: 8, outputPerMTok: 48, cacheReadPerMTok: 0.8, cacheWritePerMTok: 10 },
    ],
  },
  'qwen3-5-plus': {
    inputPerMTok: 0.8,
    outputPerMTok: 4.8,
    cacheReadPerMTok: 0.08,
    cacheWritePerMTok: 1,
    cacheWriteFree: false,
    currency: 'CNY',
  },
  'qwen3-7-flash': {
    inputPerMTok: 0.2,
    outputPerMTok: 0.8,
    cacheReadPerMTok: 0.02,
    cacheWritePerMTok: 0.25,
    cacheWriteFree: false,
    currency: 'CNY',
  },
  'qwen3-6-flash': {
    inputPerMTok: 1.2,
    outputPerMTok: 7.2,
    cacheReadPerMTok: 0.12,
    cacheWritePerMTok: 1.5,
    cacheWriteFree: false,
    currency: 'CNY',
  },
  'qwen3-5-flash': {
    inputPerMTok: 0.2,
    outputPerMTok: 2,
    cacheReadPerMTok: 0.02,
    cacheWritePerMTok: 0.25,
    cacheWriteFree: false,
    currency: 'CNY',
  },
  'qwen3-coder-plus': {
    inputPerMTok: 4,
    outputPerMTok: 16,
    cacheReadPerMTok: 0.4,
    cacheWritePerMTok: 5,
    cacheWriteFree: false,
    currency: 'CNY',
  },
  'qwen3-coder-flash': {
    inputPerMTok: 1,
    outputPerMTok: 4,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
    cacheWriteFree: false,
    currency: 'CNY',
  },
  'qwen3-coder-next': {
    inputPerMTok: 1,
    outputPerMTok: 4,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
    cacheWriteFree: false,
    currency: 'CNY',
  },
  // 旧商业版（思考/非思考不同价；取非思考输出价）
  'qwen-plus': {
    inputPerMTok: 0.8,
    outputPerMTok: 2,
    cacheReadPerMTok: 0.08,
    cacheWritePerMTok: 1,
    cacheWriteFree: false,
    currency: 'CNY',
  },
  'qwen-flash': {
    inputPerMTok: 0.15,
    outputPerMTok: 1.5,
    cacheReadPerMTok: 0.015,
    cacheWritePerMTok: 0.1875,
    cacheWriteFree: false,
    currency: 'CNY',
  },
  'qwen-turbo': {
    inputPerMTok: 0.3,
    outputPerMTok: 0.6,
    cacheReadPerMTok: 0.03,
    cacheWritePerMTok: 0.375,
    cacheWriteFree: false,
    currency: 'CNY',
  },
  'qwen-long': {
    inputPerMTok: 0.5,
    outputPerMTok: 2,
    cacheReadPerMTok: 0.05,
    cacheWritePerMTok: 0.625,
    cacheWriteFree: false,
    currency: 'CNY',
  },
  'qwq-plus': {
    inputPerMTok: 1.6,
    outputPerMTok: 4,
    cacheReadPerMTok: 0.16,
    cacheWritePerMTok: 2,
    cacheWriteFree: false,
    currency: 'CNY',
  },
  // 视觉（V✔）
  'qwen3-vl-plus': {
    inputPerMTok: 1,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
    cacheWriteFree: false,
    currency: 'CNY',
  },
  'qwen3-vl-flash': {
    inputPerMTok: 0.15,
    outputPerMTok: 1.5,
    cacheReadPerMTok: 0.015,
    cacheWritePerMTok: 0.1875,
    cacheWriteFree: false,
    currency: 'CNY',
  },
  'qwen2-5-omni-7b': {
    inputPerMTok: 0.6,
    outputPerMTok: 2.4,
    cacheReadPerMTok: 0.06,
    cacheWritePerMTok: 0.75,
    cacheWriteFree: false,
    currency: 'CNY',
  },
};
