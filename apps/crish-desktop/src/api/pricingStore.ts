/**
 * Token pricing (per 1M tokens) for usage estimates.
 * Defaults approximate common public rates; user can override.
 *
 * v2 新增 4D 定价（input / output / cacheRead / cacheWrite），
 * 并保持与 v1 estimateCostUsd（2D）完全向下兼容。
 *
 * v3 新增缓存费率三级优先（P5 §3.5.1，T-48）：
 *   per-model 目录价（CATALOG_CACHE_RATES 静态表 + catalog_get 快照）
 *   → 用户编辑价表扩展字段 → 全局乘数兜底。
 * 数据源：00-vendor-model-pricing-catalog.md（2026-08-02）。
 *
 * v4（R3 A3 专项「模型目录与定价 v2」）四指标数据驱动：
 *   CATALOG_CACHE_RATES 由「28 模型乘数表」升级为「御十家全量绝对四价表」
 *   （权威数据源：docs/cache-optimization/10-model-catalog-v2/04-master-model-list.md，
 *   2026-08-03；字段语义：docs/.../03-catalog-v2-schema.md §2 C 组）。
 *
 *   本层关键裁决（详见轮末汇总物）：
 *   1. 币种：**不做汇率折算**。每条目录价带 `currency`（USD/CNY），
 *      cost 一律按模型自身币种计算；展示层用 getModelCurrency() 标注币种。
 *      estimateCostUsd / estimateSavingsUsd 的返回值 = 模型自身币种金额
 *      （CNY 模型返回人民币金额，函数名中 Usd 为历史遗留，见 getModelCurrency）。
 *   2. 双币种厂商（GLM zai/bigmodel、MiniMax minimaxi/minimax-io）：
 *      前端按 v1 catalog.json 默认直连口径单条收录（GLM=USD 国际站、MiniMax=CNY
 *      国内站），CNY/USD 双条目并存归服务端 catalog 层；另见各条目注释。
 *   3. 写免费三态（schema §1.3）：写免费 = cacheWriteFree:true + write 0；
 *      有写价 = write>0 + free:false；未获取 = read 置 null（禁止 0 占位）。
 *   4. 1h 档（schema §2 C 组 cacheWritePrice1h）：仅 Anthropic 条目有独立 1h
 *      写价；用户配置 1h TTL（saveCacheTtlMode('1h')）时按 1h 档计写价，否则按
 *      5m 档。MiniMax「写入后 1h 窗口」语义**不落** cacheWritePrice1h
 *      （用 cacheWritePrice + cacheTtl 表达），故无 1h 档字段。
 *   5. 存储费（storagePricePer1mHour：Gemini 4.50/1.00、GLM 0 限时免费至
 *      2026-08-31、豆包 0.017 等）**不入前端成本**——服务端核算，前端不估。
 *   6. 回退链（四指标解析优先级）：
 *      运行时快照（catalog_get 下发绝对缓存价）
 *      → 目录静态表（本文件全量绝对四价）
 *      → 用户编辑价表扩展字段（cacheReadPerMTok/cacheWritePerMTok）
 *      → 全局乘数兜底（cacheReadMultiplier/cacheWriteMultiplier × 输入价）
 *      → 无价 → resolver 返回 null，估算函数返回 0（不估算）。
 *   7. 长度分档（tieredPricing）不入前端：估算统一按基础四价（首档），
 *      档位匹配归 P5/服务端 catalog 层。
 */

export type ModelPrice = {
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
  /**
   * 三级费率第 2 级（可选扩展字段，用户编辑价表）：
   * 缓存命中单价（USD/1M tokens）；缺省时按费率解析回退。
   */
  cacheReadPerMTok?: number;
  /** 三级费率第 2 级：缓存写入单价（USD/1M tokens）；缺省时按费率解析回退 */
  cacheWritePerMTok?: number;
  /**
   * 用户价表币种标注（v4 新增；缺省 = 目录币种，目录无条目 = USD）。
   * 仅用于展示层标注，不做汇率换算。
   */
  currency?: 'USD' | 'CNY';
};

/** 币种（schema §1.2：必填，值域 USD | CNY；目录内不换算） */
export type Currency = 'USD' | 'CNY';

/** 缓存 TTL 档（v4：决定 Anthropic 写价取 5m 还是 1h 档） */
export type CacheTtlMode = '5m' | '1h';

export interface CachePriceOpts {
  /** cacheRead 费率 = cacheReadMultiplier * inputPerMTok */
  cacheReadMultiplier: number;
  /** cacheWrite 费率 = cacheWriteMultiplier * inputPerMTok */
  cacheWriteMultiplier: number;
}

const PRICES_KEY = 'crish_model_prices_v1';
const CACHE_OPTS_KEY = 'crish_cache_price_opts_v1';
const CACHE_TTL_MODE_KEY = 'crish_cache_ttl_mode_v1';

/** cacheRead token 费率相对 inputPerMTok 的默认系数 */
export const DEFAULT_CACHE_READ_MULTIPLIER = 0.1;
/** cacheWrite token 费率相对 inputPerMTok 的默认系数 */
export const DEFAULT_CACHE_WRITE_MULTIPLIER = 1.25;
/** 缓存 TTL 默认档（5m；Anthropic 写价按 5m 档计） */
export const DEFAULT_CACHE_TTL_MODE: CacheTtlMode = '5m';

/**
 * per-model 目录条目（四指标绝对价，per_1M tokens，模型自身币种）。
 *
 * 字段语义对齐 catalog v2 schema §2 C 组：
 * - `cacheReadPerMTok`：缓存命中单价；null = 官方未获取/无缓存折扣语义
 *   （如 OpenAI pro 档「无缓存折扣（未明确）」，禁止 0 占位）。
 * - `cacheWritePerMTok`：通用写价（Anthropic 条目 = 5m 档写价）；
 *   写免费 = 0 + cacheWriteFree:true 双字段齐出（schema §1.3 三态）。
 * - `cacheWritePerMTok1h`：Anthropic 1h 档写价（schema cacheWritePrice1h）。
 * - `currency`：必填（schema §1.2），目录内不换算。
 */
export interface CatalogModelEntry4d {
  /** 未缓存输入价（USD/CNY per 1M tokens） */
  inputPerMTok: number;
  /** 输出价 */
  outputPerMTok: number;
  /** 缓存命中单价；null = 未获取（禁 0 占位） */
  cacheReadPerMTok: number | null;
  /** 缓存写价（写免费 = 0；Anthropic = 5m 档） */
  cacheWritePerMTok: number;
  /** 写免费显式位（true = 写免费） */
  cacheWriteFree: boolean;
  /** Anthropic 1h 档写价（TTL=1h 时启用；其余厂商无此字段） */
  cacheWritePerMTok1h?: number;
  /** 币种（USD / CNY） */
  currency: Currency;
}

/**
 * 御十家全量四指标目录（v4 取代 v3 的 28 模型乘数表）。
 *
 * 数据源：docs/cache-optimization/10-model-catalog-v2/04-master-model-list.md
 * （R2 汇总 2026-08-03，唯一数据源；R3 不得越过本表）。数据日期 2026-08-03。
 * 转录范围：四指标完整且非「明确不转录」（§13.4：已下线/非对话/未获取）条目；
 * 双币种厂商每模型单条（v1 catalog.json 默认直连口径），CNY/USD 双条目归服务端。
 * 长度分档统一取基础四价（首档）；tieredPricing 档位匹配不在前端做。
 * 别名/旧键条目（v1 catalog.json 或旧费率表形态）与官方 ID 同价，注释标注。
 * 键名规则：官方 API ID 直抄；GLM/MiniMax/Qwen 等点号异形按 schema §1.4
 * 保留目录横线形态的旧键作为别名。
 */
export const CATALOG_CACHE_RATES: Record<string, CatalogModelEntry4d> = {
  // ── 1. OpenAI（§1.1 表 A P0 + §1.3 表 C 旧轨；USD）────────────────────────
  // 5.6 系新轨：写价 1.25x、TTL 30m；旧轨写免费（0 + free:true）。
  // pro 档「无缓存折扣（未明确）」→ cacheReadPerMTok: null（不编造）。
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

  // ── 2. Anthropic（§2.1 表 A P0 11 条；USD）────────────────────────────────
  // 写价双档：cacheWritePerMTok = 5m 档，cacheWritePerMTok1h = 1h 档（2x 输入价）；
  // 命中 0.1x；cacheWriteFree:false（有写价）。Sonnet 5 促销价 8/31 到期。
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

  // ── 3. Kimi 月之暗面（§3.1 表 A P0 4 条；CNY）─────────────────────────────
  // 全自动缓存、写免费（0 + true）；命中 10%~20%；V1 系已下线不转录。
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

  // ── 4. GLM 智谱（§4.1 表 A1 USD 站 zai；USD）──────────────────────────────
  // 命中价 + 存储费双字段，无写价概念 → 写免费三件套；存储费（0 限时免费至
  // 2026-08-31）不入前端成本（服务端核算）。CNY bigmodel 双条目归服务端。
  // 点号 API 名（glm-5.2）目录横线形态；保留 v1 旧键 glm-5-2 作别名。
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

  // ── 5. Qwen 阿里百炼（§5.1 表 A；CNY）─────────────────────────────────────
  // 全系推导价（priceStatus: derived）：cacheRead = 输入 × 10%、
  // cacheWrite = 输入 × 125%（官方只给比例）；有写价概念 → free:false。
  // 阶梯档取基础价（首档）；多档「/」分隔时取 [0,32K)/[0,128K) 档。
  // 点号官方名（qwen3.7-max）目录横线形态；保留 v1 旧键 qwen3-7-max 作别名。
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

  // ── 6. Grok xAI（§6.1 表 A；USD）──────────────────────────────────────────
  // 写免费（官方定价结构无写价列，推断）；长档 ≥200K 不入前端（取基础档）。
  // 官方 ID 点号；保留 v1 旧键 grok-4-5 / grok-4-3 作别名。
  'grok-4-5': {
    inputPerMTok: 2,
    outputPerMTok: 6,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'grok-4.5': {
    inputPerMTok: 2,
    outputPerMTok: 6,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
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

  // ── 7. MiniMax（§7.1 表 A CNY 国内站 minimaxi；CNY）──────────────────────
  // v1 catalog 默认国内站口径（CNY）；USD 国际站（minimax-io）双条目归服务端。
  // M3 仅被动缓存 → 写免费；M2.x 主动轨写价 1.25x（free:false）。
  // MiniMax 的「1h 窗口」不落 cacheWritePerMTok1h（schema §2 C 组），故无该字段。
  'minimax-m3': {
    inputPerMTok: 2.1,
    outputPerMTok: 8.4,
    cacheReadPerMTok: 0.42,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'CNY',
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

  // ── 8. Gemini Google（§8.1 表 A；USD）────────────────────────────────────
  // 命中价恒 = 输入 10%；写免费三件套；显式缓存存储费（Pro 4.50 / flash 1.00，
  // 3.5/3.6 flash 未获取）不入前端成本（服务端核算）。长档 2x 仅 Pro，不入前端。
  // 官方 ID 点号；保留 v1 旧键（gemini-3-6-flash 等横线形态）作别名。
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
  },
  'gemini-3.1-pro-preview': {
    inputPerMTok: 2,
    outputPerMTok: 12,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'gemini-3.1-pro-preview-customtools': {
    inputPerMTok: 2,
    outputPerMTok: 12,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
  },
  'gemini-3-pro-preview': {
    inputPerMTok: 2,
    outputPerMTok: 12,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 0,
    cacheWriteFree: true,
    currency: 'USD',
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

  // ── 9. DeepSeek（§9.1 表 A；USD）─────────────────────────────────────────
  // 自动磁盘前缀缓存、写免费（0 + true）；命中价差全行业最大
  // （flash 2% / pro ≈0.83%）。legacy（deepseek-chat/reasoner）已停用不转录。
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

/**
 * 目录条目查找：精确 + 模糊匹配（与 resolveModelPrice 同规则）。
 * 精确优先；模糊支持「带版本后缀」（deepseek-v4-flash-0731 含目录键）与
 * 「旧键/别名前缀」（gemini-3-1-pro 命中 gemini-3.1-pro-preview）。
 */
function resolveCatalogEntry(model: string): CatalogModelEntry4d | null {
  const exact = CATALOG_CACHE_RATES[model];
  if (exact) return exact;
  for (const key of Object.keys(CATALOG_CACHE_RATES)) {
    if (model.includes(key) || key.includes(model)) {
      const entry = CATALOG_CACHE_RATES[key];
      if (entry) return entry;
    }
  }
  return null;
}

/** 运行时目录快照（P3 `catalog_get` 下发；版本号失效语义） */
export interface CatalogCacheSnapshot {
  version: number;
  /** model → 缓存单价（USD/1M tokens；绝对值优先于静态费率表） */
  prices: Record<string, { readPerMTok: number; writePerMTok: number }>;
}

let catalogSnapshot: CatalogCacheSnapshot | null = null;

/**
 * 注入运行时目录快照（数据源 = Rust catalog_get；前端只读快照缓存）。
 * 版本号不递增（旧于当前快照）时忽略——「版本号失效」语义：
 * 新版本覆盖旧版本，同版本幂等。
 */
export function applyCatalogCacheSnapshot(
  snapshot: CatalogCacheSnapshot | null
): void {
  if (!snapshot) {
    catalogSnapshot = null;
    return;
  }
  if (catalogSnapshot && snapshot.version <= catalogSnapshot.version) {
    return;
  }
  catalogSnapshot = snapshot;
}

/** 测试辅助：清空运行时快照（回退静态表） */
export function clearCatalogCacheSnapshot(): void {
  catalogSnapshot = null;
}

/**
 * 三级费率第 1 级：per-model 目录缓存价（绝对价，模型自身币种）。
 * 优先运行时快照（catalog_get 下发绝对值），否则静态表绝对价；
 * 两者都取不到 → null（回退下级）。写免费条目 write = 0。
 */
export function resolveCatalogCachePrices(
  model: string
): { readPerMTok?: number; writePerMTok?: number } | null {
  const snap = catalogSnapshot?.prices[model];
  if (snap) {
    return {
      readPerMTok: snap.readPerMTok,
      writePerMTok: snap.writePerMTok,
    };
  }
  const entry = resolveCatalogEntry(model);
  if (!entry) return null;
  return {
    readPerMTok: entry.cacheReadPerMTok ?? undefined,
    writePerMTok: entry.cacheWriteFree ? 0 : entry.cacheWritePerMTok,
  };
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
 * Official-ish defaults (USD / 1M tokens) — user-editable.
 *
 * 数据来源：docs/cache-optimization/00-vendor-model-pricing-catalog.md（2026-08-02）：
 * - gpt-5.6：§2.2（litellm 副本口径，input 5e-06 / output 3e-05）
 * - deepseek-v4-flash / deepseek-v4-pro：§3.1
 * - claude-haiku-4-5 / claude-sonnet-4-5 / claude-opus-4-5：§1.1
 * - glm-5.2：§4.1（官方直连 USD 价）
 * - grok-4.5：§6.1
 * 注：v4 起目录表（CATALOG_CACHE_RATES）已含御十家全量绝对四价，本表仅作
 * 用户可编辑的 2D 兜底与覆盖层；Kimi（§5.1）、MiniMax（§7.1）、豆包（§9.1）
 * 官方价为 CNY，Qwen 命中价未获取（§11.3），均不纳入本 USD 表。
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
 * 2D 基础价解析（v4 升级：目录兜底）。
 * 优先级：用户编辑价表（可覆盖）→ 目录静态表绝对价 → null（无价）。
 */
function resolveBasePrices(
  model: string
): { inputPerMTok: number; outputPerMTok: number } | null {
  const hit = resolveModelPrice(model);
  if (hit) {
    return { inputPerMTok: hit.inputPerMTok, outputPerMTok: hit.outputPerMTok };
  }
  const entry = resolveCatalogEntry(model);
  if (entry) {
    return {
      inputPerMTok: entry.inputPerMTok,
      outputPerMTok: entry.outputPerMTok,
    };
  }
  return null;
}

/**
 * 2D 估算：不考虑 cache（向下兼容）。
 * v4：目录模型未在用户价表时由目录绝对价兜底（如 kimi-k3/qwen3-8-max）；
 * 返回值 = 模型自身币种金额（CNY 模型为人民币），展示层用 getModelCurrency 标注。
 */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const p = resolveBasePrices(model);
  if (!p) return 0;
  return (
    (inputTokens / 1e6) * p.inputPerMTok +
    (outputTokens / 1e6) * p.outputPerMTok
  );
}

/** 四指标解析结果（v4；估算消费的唯一入口形态） */
export interface Resolved4dPrices {
  /** 未缓存输入价（用户价表可覆盖目录） */
  inputPerMTok: number;
  /** 输出价 */
  outputPerMTok: number;
  /** 缓存命中单价（已按回退链解析为具体值） */
  cacheReadPerMTok: number;
  /** 缓存写价（已应用 cacheWriteFree 与 1h TTL 档） */
  cacheWritePerMTok: number;
  /** 目录写免费位（true = 写免费；快照/用户/乘数来源为 false） */
  cacheWriteFree: boolean;
  /** 币种（目录标注或用户价表覆盖；缺省 USD） */
  currency: Currency;
  /** 缓存价来源（调试/测试）：snapshot / catalog / user / multiplier */
  source: 'snapshot' | 'catalog' | 'user' | 'multiplier';
  /** 目录条目是否带 1h 写价档（Anthropic；TTL=1h 时启用） */
  hasWrite1hTier: boolean;
}

/**
 * 四指标价格解析（v4 回退链，任务书裁决）：
 *   输入/输出价：用户编辑价表（覆盖）→ 目录绝对价 → null（不估算）。
 *   缓存读价：运行时快照 → 目录绝对价（null = 未获取）→ 用户扩展字段 → 全局乘数。
 *   缓存写价：运行时快照（无免费位语义，绝对值直用）→ 目录条目
 *     （cacheWriteFree → 0；TTL=1h 且有条目 1h 档 → 用 1h 写价）
 *     → 用户扩展字段 → 全局乘数。
 * 存储费不入前端（服务端核算）；tieredPricing 档位匹配不在前端（基础价）。
 */
export function resolve4dPrices(model: string): Resolved4dPrices | null {
  const hit = resolveModelPrice(model);
  const entry = resolveCatalogEntry(model);
  const snap = catalogSnapshot?.prices[model];
  const opts = loadCachePriceOpts();

  const inputPerMTok = hit?.inputPerMTok ?? entry?.inputPerMTok;
  const outputPerMTok = hit?.outputPerMTok ?? entry?.outputPerMTok;
  if (inputPerMTok == null || outputPerMTok == null) return null;

  const currency: Currency = hit?.currency ?? entry?.currency ?? 'USD';
  const ttlMode = loadCacheTtlMode();

  let source: Resolved4dPrices['source'] = 'multiplier';

  // 缓存读价回退链
  let cacheReadPerMTok: number;
  if (snap) {
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
  if (snap) {
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
  const p = resolve4dPrices(model);
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
