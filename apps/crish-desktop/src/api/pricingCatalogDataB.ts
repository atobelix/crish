/**
 * CATALOG_CACHE_RATES 静态表 — Kimi + GLM + Qwen 条目
 * （从 pricingStore.ts 拆出，T4-11 SR-06-R1）。
 *
 * 数据源：docs/cache-optimization/10-model-catalog-v2/04-master-model-list.md
 */

import type { CatalogModelEntry4d } from './pricingTypes';

// ── 3. Kimi 月之暗面（§3.1 表 A P0 4 条；CNY）─────────────────────────────
// 全自动缓存、写免费（0 + true）；命中 10%~20%；V1 系已下线不转录。
export const CATALOG_RATES_KIMI: Record<string, CatalogModelEntry4d> = {
  'kimi-k3': {
    inputPerMTok: 20,
    outputPerMTok: 100,
    cacheReadPerMTok: 2,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'CNY',
  },
  'kimi-k2.7-code': {
    inputPerMTok: 6.5,
    outputPerMTok: 27,
    cacheReadPerMTok: 1.3,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'CNY',
  },
  'kimi-k2.7-code-highspeed': {
    inputPerMTok: 13,
    outputPerMTok: 54,
    cacheReadPerMTok: 2.6,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'CNY',
  },
  'kimi-k2.6': {
    inputPerMTok: 6.5,
    outputPerMTok: 27,
    cacheReadPerMTok: 1.1,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'CNY',
  },
};

// ── 4. GLM 智谱（§4.1 表 A1 USD 站 zai；USD）──────────────────────────────
// 命中价 + 存储费双字段，无写价概念 → 写免费三件套；存储费（0 限时免费至
// 2026-08-31）不入前端成本（服务端核算）。CNY bigmodel 双条目归服务端。
// 点号 API 名（glm-5.2）目录横线形态；保留 v1 旧键 glm-5-2 作别名。
export const CATALOG_RATES_GLM: Record<string, CatalogModelEntry4d> = {
  'glm-5-2': {
    inputPerMTok: 1.4,
    outputPerMTok: 4.4,
    cacheReadPerMTok: 0.26,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'glm-5.2': {
    inputPerMTok: 1.4,
    outputPerMTok: 4.4,
    cacheReadPerMTok: 0.26,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'glm-5-1': {
    inputPerMTok: 1.4,
    outputPerMTok: 4.4,
    cacheReadPerMTok: 0.26,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'glm-5': {
    inputPerMTok: 1,
    outputPerMTok: 3.2,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'glm-5-turbo': {
    inputPerMTok: 1.2,
    outputPerMTok: 4,
    cacheReadPerMTok: 0.24,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'glm-4-7': {
    inputPerMTok: 0.6,
    outputPerMTok: 2.2,
    cacheReadPerMTok: 0.11,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'glm-4-7-flashx': {
    inputPerMTok: 0.07,
    outputPerMTok: 0.4,
    cacheReadPerMTok: 0.01,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'glm-4-6': {
    inputPerMTok: 0.6,
    outputPerMTok: 2.2,
    cacheReadPerMTok: 0.11,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'glm-4-5': {
    inputPerMTok: 0.6,
    outputPerMTok: 2.2,
    cacheReadPerMTok: 0.11,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'glm-4-5-x': {
    inputPerMTok: 2.2,
    outputPerMTok: 8.9,
    cacheReadPerMTok: 0.45,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'glm-4-5-air': {
    inputPerMTok: 0.2,
    outputPerMTok: 1.1,
    cacheReadPerMTok: 0.03,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'glm-4-5-airx': {
    inputPerMTok: 1.1,
    outputPerMTok: 4.5,
    cacheReadPerMTok: 0.22,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  // 免费档（0 价占位合法：官方公布免费）
  'glm-4-7-flash': {
    inputPerMTok: 0,
    outputPerMTok: 0,
    cacheReadPerMTok: 0,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  // 视觉（§4.2，P1；多模态 Agent 场景必需）
  'glm-5v-turbo': {
    inputPerMTok: 1.2,
    outputPerMTok: 4,
    cacheReadPerMTok: 0.24,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'glm-4-6v': {
    inputPerMTok: 0.3,
    outputPerMTok: 0.9,
    cacheReadPerMTok: 0.05,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'glm-4-6v-flashx': {
    inputPerMTok: 0.04,
    outputPerMTok: 0.4,
    cacheReadPerMTok: 0.004,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'glm-4-6v-flash': {
    inputPerMTok: 0,
    outputPerMTok: 0,
    cacheReadPerMTok: 0,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'glm-4-5v': {
    inputPerMTok: 0.6,
    outputPerMTok: 1.8,
    cacheReadPerMTok: 0.11,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
};

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
