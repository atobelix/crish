/**
 * CATALOG_CACHE_RATES 静态表 — Kimi + GLM 条目（聚合导出口）
 * （从 pricingStore.ts 拆出，T4-11 SR-06-R1；T4-11 R2 按厂商进一步细分）。
 *
 * 数据源：docs/cache-optimization/10-model-catalog-v2/04-master-model-list.md
 *
 * 实现明细按厂商拆分到子文件，本文件保留 Kimi + GLM 两个厂商的静态表，
 * 并聚合再导出 Qwen 子表，保持消费方 import 路径不变：
 * - pricingCatalogDataQwen.ts：CATALOG_RATES_QWEN（§5.1 表 A）
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

export { CATALOG_RATES_QWEN } from './pricingCatalogDataQwen';
