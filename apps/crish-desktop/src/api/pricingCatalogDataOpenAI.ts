/**
 * CATALOG_CACHE_RATES 静态表 — OpenAI 条目
 * （从 pricingCatalogDataA.ts 拆出，T4-11 SR-06-R1）。
 *
 * 数据源：docs/cache-optimization/10-model-catalog-v2/04-master-model-list.md
 * （R2 汇总 2026-08-03，唯一数据源；R3 不得越过本表）。数据日期 2026-08-03。
 * 转录范围：四指标完整且非「明确不转录」（§13.4：已下线/非对话/未获取）条目；
 * 双币种厂商每模型单条（v1 catalog.json 默认直连口径），CNY/USD 双条目归服务端。
 * 基础四价 = 首档；tieredPricing 档位 P1B 起随条目收录（估算按 input 长度落档，
 * 见 resolve4dPricesForTokens）。
 * 别名/旧键条目（v1 catalog.json 或旧费率表形态）与官方 ID 同价，注释标注。
 * 键名规则：官方 API ID 直抄；GLM/MiniMax/Qwen 等点号异形按 schema §1.4
 * 保留目录横线形态的旧键作为别名。
 */

import type { CatalogModelEntry4d } from './pricingTypes';

// ── 1. OpenAI（§1.1 表 A P0 + §1.3 表 C 旧轨；USD）────────────────────────
// 5.6 系新轨：写价 1.25x、TTL 30m；旧轨写免费（0 + free:true）。
// pro 档「无缓存折扣（未明确）」→ cacheReadPerMTok: null（不编造）。
export const CATALOG_RATES_OPENAI: Record<string, CatalogModelEntry4d> = {
  'gpt-5.6-sol': {
    inputPerMTok: 5,
    outputPerMTok: 30,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 6.25,
    cacheWriteFree: false,
    currency: 'USD',
  },
  'gpt-5.6-terra': {
    inputPerMTok: 2,
    outputPerMTok: 12,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 2.5,
    cacheWriteFree: false,
    currency: 'USD',
  },
  'gpt-5.6-luna': {
    inputPerMTok: 0.2,
    outputPerMTok: 1.2,
    cacheReadPerMTok: 0.02,
    cacheWritePerMTok: 0.25,
    cacheWriteFree: false,
    currency: 'USD',
  },
  // 别名：官方 alias `gpt-5.6` 路由到 sol（§1.1 备注①）
  'gpt-5.6': {
    inputPerMTok: 5,
    outputPerMTok: 30,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 6.25,
    cacheWriteFree: false,
    currency: 'USD',
  },
  'gpt-5.5': {
    inputPerMTok: 5,
    outputPerMTok: 30,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'gpt-5.5-pro': {
    inputPerMTok: 30,
    outputPerMTok: 180,
    cacheReadPerMTok: null,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
    // ≥272K 长上下文 2x 档（DEEPCHECK-05 §8：gpt-5.5-pro 输入 30→60）
    tiered: [
      { minTokens: 272_000, inputPerMTok: 60, outputPerMTok: 270 },
    ],
  },
  'gpt-5.4': {
    inputPerMTok: 2.5,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.25,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'gpt-5.4-mini': {
    inputPerMTok: 0.75,
    outputPerMTok: 4.5,
    cacheReadPerMTok: 0.075,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'gpt-5.4-nano': {
    inputPerMTok: 0.2,
    outputPerMTok: 1.25,
    cacheReadPerMTok: 0.02,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'gpt-5.4-pro': {
    inputPerMTok: 30,
    outputPerMTok: 180,
    cacheReadPerMTok: null,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'gpt-5.3-codex': {
    inputPerMTok: 1.75,
    outputPerMTok: 14,
    cacheReadPerMTok: 0.175,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'chat-latest': {
    inputPerMTok: 5,
    outputPerMTok: 30,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'codex-mini-latest': {
    inputPerMTok: 1.5,
    outputPerMTok: 6,
    cacheReadPerMTok: 0.375,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  // 特化（§1.1 P1 备查）
  'gpt-5.5-cyber': {
    inputPerMTok: 12.5,
    outputPerMTok: 75,
    cacheReadPerMTok: 1.25,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'gpt-5-search-api': {
    inputPerMTok: 1.25,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.125,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  // 旧轨（§1.3 表 C，P1 备查；仍按量计费的 API 模型）
  'gpt-5.2': {
    inputPerMTok: 1.75,
    outputPerMTok: 14,
    cacheReadPerMTok: 0.175,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'gpt-5.2-pro': {
    inputPerMTok: 21,
    outputPerMTok: 168,
    cacheReadPerMTok: null,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'gpt-5.2-chat-latest': {
    inputPerMTok: 1.75,
    outputPerMTok: 14,
    cacheReadPerMTok: 0.175,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'gpt-5.2-codex': {
    inputPerMTok: 1.75,
    outputPerMTok: 14,
    cacheReadPerMTok: 0.175,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'gpt-5.1': {
    inputPerMTok: 1.25,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.125,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'gpt-5': {
    inputPerMTok: 1.25,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.125,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'gpt-5-mini': {
    inputPerMTok: 0.25,
    outputPerMTok: 2,
    cacheReadPerMTok: 0.025,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'gpt-5-nano': {
    inputPerMTok: 0.05,
    outputPerMTok: 0.4,
    cacheReadPerMTok: 0.005,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'gpt-5-pro': {
    inputPerMTok: 15,
    outputPerMTok: 120,
    cacheReadPerMTok: null,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  o1: {
    inputPerMTok: 15,
    outputPerMTok: 60,
    cacheReadPerMTok: 7.5,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'o1-pro': {
    inputPerMTok: 150,
    outputPerMTok: 600,
    cacheReadPerMTok: null,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  o3: {
    inputPerMTok: 2,
    outputPerMTok: 8,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'o3-pro': {
    inputPerMTok: 20,
    outputPerMTok: 80,
    cacheReadPerMTok: null,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'o3-mini': {
    inputPerMTok: 1.1,
    outputPerMTok: 4.4,
    cacheReadPerMTok: 0.55,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'o4-mini': {
    inputPerMTok: 1.1,
    outputPerMTok: 4.4,
    cacheReadPerMTok: 0.275,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'gpt-4.1': {
    inputPerMTok: 2,
    outputPerMTok: 8,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'gpt-4.1-mini': {
    inputPerMTok: 0.4,
    outputPerMTok: 1.6,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'gpt-4.1-nano': {
    inputPerMTok: 0.1,
    outputPerMTok: 0.4,
    cacheReadPerMTok: 0.025,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'gpt-4o': {
    inputPerMTok: 2.5,
    outputPerMTok: 10,
    cacheReadPerMTok: 1.25,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'gpt-4o-mini': {
    inputPerMTok: 0.15,
    outputPerMTok: 0.6,
    cacheReadPerMTok: 0.075,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
};
