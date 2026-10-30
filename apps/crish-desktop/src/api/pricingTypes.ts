/**
 * Token pricing 类型契约与常量（从 pricingStore.ts 拆出，T4-11 SR-06-R1）。
 *
 * v2 新增 4D 定价（input / output / cacheRead / cacheWrite），
 * 并保持与 v1 estimateCostUsd（2D）完全向下兼容。
 *
 * v3 新增缓存费率三级优先（P5 §3.5.1，T-48）：
 *   per-model 目录价（出厂能力字典运行时快照）
 *   → 用户编辑价表扩展字段 → 全局乘数兜底。
 * 数据源：00-vendor-model-pricing-catalog.md（2026-08-02）。
 *
 * v4（R3 A3 专项「模型目录与定价 v2」）四指标数据驱动。
 *
 * v5（战役 docs/provider-single-track-convergence/ 阶段 3，裁决 ①③）：
 *   **前端零本地副本**——六份静态定价表（`pricingCatalogData*.ts`）与
 *   `DEFAULT_PRICES` 已物理删除；出厂数据唯一来源 = 出厂能力字典
 *   （Rust `crates/agent-provider/src/models/catalog.json`，编译期打包），
 *   经 `workbench_read_capability_dictionary` → `toCatalogCacheSnapshot` →
 *   `applyCatalogCacheSnapshot` 注入运行时快照。
 *   快照索引键 = **模型 id**（出厂字典内 id 唯一：156 id / 0 跨厂商重复，
 *   由 Rust `ssot_convergence_tests::dictionary_model_ids_are_unique_keys` 钉死）；
 *   配置树侧身份仍是 `(providerId, modelId)` 二元组（`modelRefKey`）。
 *   禁止 substring / 模糊回退参与价格决议。
 *   「未收录」（快照未注入或未命中）在**类型上**与「0 成本」区分：
 *   估算函数返回 `null`，禁止回退静态表、禁止以 0 冒充。
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
 *      运行时出厂字典快照（`workbench_read_capability_dictionary` 下发绝对价）
 *      → 用户编辑价表扩展字段（cacheReadPerMTok/cacheWritePerMTok）
 *      → 全局乘数兜底（cacheReadMultiplier/cacheWriteMultiplier × 输入价）
 *      → 无价 → resolver 返回 null，估算函数返回 **null（未收录）**
 *        ——不得返回 0（0 = 已知且确实为 0 成本，如写免费条目）。
 *   7. 长度分档（tieredPricing）消费（P1B 修复，DEEPCHECK-05 #8）：
 *      **不再"不入前端"**——Rust 快照条目携带 tiered 档，
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
 * per-model 出厂字典条目（四指标绝对价，per_1M tokens，模型自身币种）。
 *
 * 字段语义对齐 catalog v2 schema §2 C 组（Rust `ModelCatalogEntry`）：
 * - `cacheReadPerMTok`：缓存命中单价；null = 官方未获取/无缓存折扣语义
 *   （如 OpenAI pro 档「无缓存折扣（未明确）」，禁止 0 占位）。
 * - `cacheWritePerMTok`：通用写价；
 *   写免费 = 0 + cacheWriteFree:true 双字段齐出（schema §1.3 三态）。
 * - `cacheWritePerMTok1h`：Anthropic 1h 档写价（schema cacheWritePrice1h）。
 * - `currency`：必填（schema §1.2），目录内不换算。
 * - `tiered`：长度分档（估算按 input 长度落档）。
 *
 * v5：本类型描述的是**出厂字典条目**（Rust 真源），前端不再持有任何本地
 * 实例（静态表已物理删除）；运行时消费一律经 [CatalogSnapshotPrice] 快照。
 */

/** 运行时快照单模型价格（出厂字典只读投影；可选字段缺失 = 回退下级） */
export interface CatalogSnapshotPrice {
  /** 未缓存输入价（缺省 = 回退用户价表/下级） */
  inputPerMTok?: number;
  /** 输出价 */
  outputPerMTok?: number;
  /** 缓存命中单价（null 语义 = 出厂字典未收录 → 字段缺失） */
  readPerMTok?: number;
  /** 通用写价（出厂字典 cacheWritePrice；缺失 = 未收录） */
  writePerMTok?: number;
  /** Anthropic 5m TTL 写价（出厂字典 cacheWritePrice5m） */
  writePerMTok5m?: number;
  /** Anthropic 1h TTL 写价（出厂字典 cacheWritePrice1h；TTL=1h 档启用） */
  writePerMTok1h?: number;
  /** 写免费显式位（出厂字典 cacheWriteFree；true = 写入不计费） */
  writeFree?: boolean;
  /** 币种（出厂字典 currency；缺失 = 未知，展示层不得猜测） */
  currency?: Currency;
  /** 长度分档（P1B：估算按 input 长度落档） */
  tiered?: CatalogTier[];
}

/**
 * 运行时出厂字典快照（`workbench_read_capability_dictionary` 下发；版本号失效语义）。
 *
 * v5：索引键 = **模型 id**（出厂字典内唯一，按 id 查找不含猜测）。
 * 同键被不同价主张 → 整键作废（fail-closed「未收录」），**不得**任选一个。
 * **禁止** substring / 前缀后缀 / 模糊回退索引。
 */
export interface CatalogCacheSnapshot {
  version: number;
  /** 模型 id → 四价（出厂字典绝对值；同键不同价者已整键作废） */
  prices: Record<string, CatalogSnapshotPrice>;
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
  /** 币种（快照标注或用户价表覆盖；两者都缺省时回落 USD 字面量） */
  currency: Currency;
  /** 缓存价来源（调试/测试）：snapshot / user / multiplier */
  source: 'snapshot' | 'user' | 'multiplier';
  /** 快照条目是否带 1h 写价档（Anthropic；TTL=1h 时启用） */
  hasWrite1hTier: boolean;
}

/**
 * 出厂能力字典 wire 条目（Rust `ModelCatalogEntry` camelCase 子集：定价/身份面字段）。
 *
 * `provider` = 出厂字典的通道/厂商标识（Rust `pub provider: String`），
 * 与 `model`/`apiModel` 共同构成出厂字典侧身份键的 provider 侧
 * （与配置树的 `(providerId, modelId)` 不同命名空间，见 toCatalogCacheSnapshot）。
 */
export interface CatalogSnapshotEntryWire {
  provider?: string;
  model?: string;
  apiModel?: string;
  currency?: string | null;
  inputPrice?: number | null;
  outputPrice?: number | null;
  cacheReadPrice?: number | null;
  cacheWritePrice?: number | null;
  /** Anthropic 系 5m TTL 写入价（Rust cache_write_price_5m） */
  cacheWritePrice5m?: number | null;
  /** Anthropic 系 1h TTL 写入价（Rust cache_write_price_1h） */
  cacheWritePrice1h?: number | null;
  /** 写免费显式位（Rust cache_write_free） */
  cacheWriteFree?: boolean | null;
  tieredPricing?: Array<{
    minTokens?: number;
    maxTokens?: number | null;
    inputPrice?: number | null;
    outputPrice?: number | null;
    cacheReadPrice?: number | null;
    cacheWritePrice?: number | null;
  }> | null;
}

/** 出厂能力字典 wire 快照（Rust `BundledCatalogSnapshot` camelCase） */
export interface CatalogSnapshotWire {
  version?: number;
  entries?: CatalogSnapshotEntryWire[];
}
