/**
 * Token pricing 类型契约与常量（从 pricingStore.ts 拆出，T4-11 SR-06-R1）。
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
 *   7. 长度分档（tieredPricing）消费（P1B 修复，DEEPCHECK-05 #8）：
 *      **不再"不入前端"**——Rust catalog 快照与静态表条目均携带 tiered 档，
 *      `resolve4dPricesForTokens` / 估算函数按估算 input 长度（promptTokens）
 *      落档：命中档位时档内价覆盖（未覆盖字段沿用基础四价），档位边界
 *      半开区间 [minTokens, maxTokens)，无上界档即长上下文档 2x 档。
 *      用户价表命中时用户价优先、不受档位影响（用户显式覆盖目录语义）。
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
  /** 计费模式：按 Token 计费 vs 按张生成计费（生图模型专精） */
  billingUnit?: 'token' | 'per_image';
  /** 单张生成单价（仅当 billingUnit 为 per_image 时使用） */
  perImageCost?: number;
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

export const PRICES_KEY = 'crish_model_prices_v1';
export const CACHE_OPTS_KEY = 'crish_cache_price_opts_v1';
export const CACHE_TTL_MODE_KEY = 'crish_cache_ttl_mode_v1';

/** cacheRead token 费率相对 inputPerMTok 的默认系数 */
export const DEFAULT_CACHE_READ_MULTIPLIER = 0.1;
/** cacheWrite token 费率相对 inputPerMTok 的默认系数 */
export const DEFAULT_CACHE_WRITE_MULTIPLIER = 1.25;
/** 缓存 TTL 默认档（5m；Anthropic 写价按 5m 档计） */
export const DEFAULT_CACHE_TTL_MODE: CacheTtlMode = '5m';

/**
 * 长度分档（v4 目录条目扩展；对齐 litellm `tiered_pricing` 的
 * `range: [min, max)` 半开区间；只写 `minTokens` 的档 = 长上下文档 2x 档）。
 */
export interface CatalogTier {
  /** 输入长度下界（半开区间下界，含） */
  minTokens: number;
  /** 输入长度上界（半开区间上界，不含）；缺省 = 无上界（长上下文档档） */
  maxTokens?: number;
  /** 档内输入价（缺省 = 沿用基础四价） */
  inputPerMTok?: number;
  /** 档内输出价 */
  outputPerMTok?: number;
  /** 档内缓存命中价 */
  cacheReadPerMTok?: number;
  /** 档内通用写价 */
  cacheWritePerMTok?: number;
}

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
 * - `tiered`：长度分档（P1B 起随目录下发/静态表收录；估算按 input 长度落档）。
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
  /** 长度分档（DEEPCHECK-05 #8：估算落档消费；缺省 = 无档） */
  tiered?: CatalogTier[];
}

/** 运行时快照单模型价格（catalog_get 下发条目映射；可选字段缺失 = 回退下级） */
export interface CatalogSnapshotPrice {
  /** 未缓存输入价（缺省 = 回退静态表/用户价表） */
  inputPerMTok?: number;
  /** 输出价 */
  outputPerMTok?: number;
  /** 缓存命中单价（null = 未收录；缺失 = 回退下级） */
  readPerMTok?: number;
  /** 缓存写价（写免费条目 = 0；缺失 = 回退下级） */
  writePerMTok?: number;
  /** 长度分档（P1B：估算按 input 长度落档） */
  tiered?: CatalogTier[];
}

/** 运行时目录快照（P3 `catalog_get` 下发；版本号失效语义） */
export interface CatalogCacheSnapshot {
  version: number;
  /** model → 四价（绝对值优先于静态费率表） */
  prices: Record<string, CatalogSnapshotPrice>;
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
