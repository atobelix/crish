/**
 * CATALOG_CACHE_RATES 静态表 — Grok + MiniMax + Gemini + DeepSeek 条目
 * （从 pricingStore.ts 拆出，T4-11 SR-06-R1）。
 *
 * 数据源：docs/cache-optimization/10-model-catalog-v2/04-master-model-list.md
 */

import type { CatalogModelEntry4d } from './pricingTypes';

// ── 6. Grok xAI（§6.1 表 A；USD）──────────────────────────────────────────
// 写免费（官方定价结构无写价列，推断）；长档 ≥200K 档已收录（估算落档消费）。
// 官方 ID 点号；保留 v1 旧键 grok-4-5 / grok-4-3 作别名。
export const CATALOG_RATES_GROK: Record<string, CatalogModelEntry4d> = {
  'grok-4-5': {
    inputPerMTok: 2,
    outputPerMTok: 6,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
    // ≥200K 整请求全量 2x 计费（含缓存命中部分；DEEPCHECK-05 §8）
    tiered: [
      { minTokens: 200_000, inputPerMTok: 4, outputPerMTok: 12, cacheReadPerMTok: 0.6 },
    ],
  },
  'grok-4.5': {
    inputPerMTok: 2,
    outputPerMTok: 6,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
    // ≥200K 档（与横线键条目同源转录）
    tiered: [
      { minTokens: 200_000, inputPerMTok: 4, outputPerMTok: 12, cacheReadPerMTok: 0.6 },
    ],
  },
  'grok-4-3': {
    inputPerMTok: 1.25,
    outputPerMTok: 2.5,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'grok-4.3': {
    inputPerMTok: 1.25,
    outputPerMTok: 2.5,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'grok-4-20-0309-reasoning': {
    inputPerMTok: 1.25,
    outputPerMTok: 2.5,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'grok-4-20-0309-non-reasoning': {
    inputPerMTok: 1.25,
    outputPerMTok: 2.5,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'grok-4-20-multi-agent-0309': {
    inputPerMTok: 1.25,
    outputPerMTok: 2.5,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'grok-build-0-1': {
    inputPerMTok: 1,
    outputPerMTok: 2,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
};

// ── 7. MiniMax（§7.1 表 A CNY 国内站 minimaxi；CNY）──────────────────────
// v1 catalog 默认国内站口径（CNY）；USD 国际站（minimax-io）双条目归服务端。
// M3 仅被动缓存 → 写免费；M2.x 主动轨写价 1.25x（free:false）。
// MiniMax 的「1h 窗口」不落 cacheWritePerMTok1h（schema §2 C 组），故无该字段。
export const CATALOG_RATES_MINIMAX: Record<string, CatalogModelEntry4d> = {
  'minimax-m3': {
    inputPerMTok: 2.1,
    outputPerMTok: 8.4,
    cacheReadPerMTok: 0.42,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'CNY',
    // >512K 长上下文 2x 且含缓存命中部分全量计费（DEEPCHECK-05 §8）
    tiered: [
      { minTokens: 512_000, inputPerMTok: 4.2, outputPerMTok: 16.8, cacheReadPerMTok: 0.84 },
    ],
  },
  'minimax-m2-7': {
    inputPerMTok: 2.1,
    outputPerMTok: 8.4,
    cacheReadPerMTok: 0.42,
    cacheWritePerMTok: 2.625,
    cacheWriteFree: false,
    currency: 'CNY',
  },
  // highspeed 变体 = 独立条目（输入/输出 2x，缓存读写价不变）
  'minimax-m2-7-highspeed': {
    inputPerMTok: 4.2,
    outputPerMTok: 16.8,
    cacheReadPerMTok: 0.42,
    cacheWritePerMTok: 2.625,
    cacheWriteFree: false,
    currency: 'CNY',
  },
  'minimax-m2-5': {
    inputPerMTok: 2.1,
    outputPerMTok: 8.4,
    cacheReadPerMTok: 0.21,
    cacheWritePerMTok: 2.625,
    cacheWriteFree: false,
    currency: 'CNY',
  },
  'minimax-m2-5-highspeed': {
    inputPerMTok: 4.2,
    outputPerMTok: 16.8,
    cacheReadPerMTok: 0.21,
    cacheWritePerMTok: 2.625,
    cacheWriteFree: false,
    currency: 'CNY',
  },
  'minimax-m2-1': {
    inputPerMTok: 2.1,
    outputPerMTok: 8.4,
    cacheReadPerMTok: 0.21,
    cacheWritePerMTok: 2.625,
    cacheWriteFree: false,
    currency: 'CNY',
  },
  'minimax-m2-1-highspeed': {
    inputPerMTok: 4.2,
    outputPerMTok: 16.8,
    cacheReadPerMTok: 0.21,
    cacheWritePerMTok: 2.625,
    cacheWriteFree: false,
    currency: 'CNY',
  },
  'minimax-m2': {
    inputPerMTok: 2.1,
    outputPerMTok: 8.4,
    cacheReadPerMTok: 0.21,
    cacheWritePerMTok: 2.625,
    cacheWriteFree: false,
    currency: 'CNY',
  },
};

// ── 8. Gemini Google（§8.1 表 A；USD）────────────────────────────────────
// 命中价恒 = 输入 10%；写免费三件套；显式缓存存储费（Pro 4.50 / flash 1.00，
// 3.5/3.6 flash 未获取）不入前端成本（服务端核算）。长档 2x 仅 Pro 系已收录。
// 官方 ID 点号；保留 v1 旧键（gemini-3-6-flash 等横线形态）作别名。
export const CATALOG_RATES_GEMINI: Record<string, CatalogModelEntry4d> = {
  'gemini-3-6-flash': {
    inputPerMTok: 1.5,
    outputPerMTok: 7.5,
    cacheReadPerMTok: 0.15,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'gemini-3.6-flash': {
    inputPerMTok: 1.5,
    outputPerMTok: 7.5,
    cacheReadPerMTok: 0.15,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'gemini-3-5-flash': {
    inputPerMTok: 1.5,
    outputPerMTok: 9,
    cacheReadPerMTok: 0.15,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'gemini-3.5-flash': {
    inputPerMTok: 1.5,
    outputPerMTok: 9,
    cacheReadPerMTok: 0.15,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'gemini-3-5-flash-lite': {
    inputPerMTok: 0.3,
    outputPerMTok: 2.5,
    cacheReadPerMTok: 0.03,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'gemini-3.5-flash-lite': {
    inputPerMTok: 0.3,
    outputPerMTok: 2.5,
    cacheReadPerMTok: 0.03,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'gemini-3-1-pro': {
    inputPerMTok: 2,
    outputPerMTok: 12,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
    // >200K 长上下文全 token 2x/1.5x 计费（DEEPCHECK-05 §8：输入 2→4、输出 12→18）
    tiered: [
      { minTokens: 200_000, inputPerMTok: 4, outputPerMTok: 18, cacheReadPerMTok: 0.4 },
    ],
  },
  'gemini-3.1-pro-preview': {
    inputPerMTok: 2,
    outputPerMTok: 12,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
    // ≥200K 档（与 gemini-3-1-pro 同源转录）
    tiered: [
      { minTokens: 200_000, inputPerMTok: 4, outputPerMTok: 18, cacheReadPerMTok: 0.4 },
    ],
  },
  'gemini-3.1-pro-preview-customtools': {
    inputPerMTok: 2,
    outputPerMTok: 12,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
    // ≥200K 档（自定义工具变体，价格同 3.1-pro-preview）
    tiered: [
      { minTokens: 200_000, inputPerMTok: 4, outputPerMTok: 18, cacheReadPerMTok: 0.4 },
    ],
  },
  'gemini-3-pro-preview': {
    inputPerMTok: 2,
    outputPerMTok: 12,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
    // ≥200K 档（3.x pro 系同价）
    tiered: [
      { minTokens: 200_000, inputPerMTok: 4, outputPerMTok: 18, cacheReadPerMTok: 0.4 },
    ],
  },
  'gemini-3-flash-preview': {
    inputPerMTok: 0.5,
    outputPerMTok: 3,
    cacheReadPerMTok: 0.05,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'gemini-3.1-flash-lite': {
    inputPerMTok: 0.25,
    outputPerMTok: 1.5,
    cacheReadPerMTok: 0.025,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'gemini-2.5-pro': {
    inputPerMTok: 1.25,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.13,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'gemini-2.5-flash': {
    inputPerMTok: 0.3,
    outputPerMTok: 2.5,
    cacheReadPerMTok: 0.03,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'gemini-2.5-flash-lite': {
    inputPerMTok: 0.1,
    outputPerMTok: 0.4,
    cacheReadPerMTok: 0.01,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  // 变体（§8.3 P1 备查，四指标完整）
  'deep-research-preview-04-2026': {
    inputPerMTok: 2,
    outputPerMTok: 12,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'deep-research-max-preview-04-2026': {
    inputPerMTok: 2,
    outputPerMTok: 12,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
};

// ── 9. DeepSeek（§9.1 表 A；USD）─────────────────────────────────────────
// 自动磁盘前缀缓存、写免费（0 + true）；命中价差全行业最大
// （flash 2% / pro ≈0.83%）。legacy（deepseek-chat/reasoner）已停用不转录。
export const CATALOG_RATES_DEEPSEEK: Record<string, CatalogModelEntry4d> = {
  'deepseek-v4-flash': {
    inputPerMTok: 0.14,
    outputPerMTok: 0.28,
    cacheReadPerMTok: 0.0028,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'deepseek-v4-pro': {
    inputPerMTok: 0.435,
    outputPerMTok: 0.87,
    cacheReadPerMTok: 0.003625,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
};
