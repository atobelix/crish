//! 模型目录（Model Catalog）：内置静态表 + 多级兜底查询（P3 §3.1）
//!
//! - [ModelCatalogEntry]：一个 provider 通道下一个模型的完整元数据，字段集 = v2
//!   Schema 59 字段（docs/cache-optimization/10-model-catalog-v2/03-catalog-v2-schema.md）；
//!   全字段可缺省（struct 级 `#[serde(default)]`），缺字段条目可正常反序列化
//!   （对齐 A3 P2-10 裁决）；v1 旧 JSON（含 `maxInputTokens`/`longContext*` 遗留键）
//!   由 serde 忽略未知键兼容解析。
//! - [ModelCatalog]：内置表 + 版本号。[ModelCatalog::lookup] 按 litellm
//!   `_get_model_info_helper` 顺序多级兜底：精确 → 去版本后缀 → vendor 默认 → None；
//!   v2 四价查询（`input_price_for` / `cache_write_price_for` 等）按 schema 语义
//!   提供 None/0 显式语义。
//!
//! 本模块不依赖 request/parse 层；行为矩阵（T-19）、TTL 表（T-21）等上层只通过
//! [ModelCatalog] 查询接口消费，禁止散落硬编码判定。
//!
//! SR-06e · 拆分 · ≠ EL：门面文件。实现域拆分如下（测试旁挂 catalog_tests.rs）：
//! - [catalog_price]：长度分档/峰谷定价类型与纯函数（TieredPriceTier /
//!   PriceDerivation / PeakPricingSchedule + tier_for_tokens / peak_pricing_2x_at）
//! - [catalog_override]：扫描合并与覆盖变更面（ScannedCapabilities / ScannedModel /
//!   OVERRIDE_WHITELIST + upsert_from_scan / with_overrides）

use std::collections::{BTreeMap, BTreeSet};

use serde::de::Visitor;
use serde::{Deserialize, Deserializer, Serialize};
use thiserror::Error;

#[path = "catalog_override.rs"]
mod catalog_override;
#[path = "catalog_price.rs"]
mod catalog_price;

pub use catalog_override::{ScannedCapabilities, ScannedModel};
pub(crate) use catalog_price::{peak_pricing_2x_at, tier_for_tokens};
pub use catalog_price::{PeakPricingSchedule, PriceDerivation, TieredPriceTier};

/// 模型级档位 → Option<wire 拼写> 映射载体（G2 数据载体层契约）：
///
/// - **键** = 规范思考档位（如 "low"/"medium"/"high"/"max"）；
/// - **值** = `Some(wire 拼写)` 提供该档（值可与键相同，也可为 G6 wire 改名，
///   如 `{"medium":"high"}`）；`None` = 隐藏不支持档（参与「不支持」归一化/拒绝，不进白名单）。
///
/// 语义对齐 pi-ai `thinkingLevelMap`，由 [ModelCatalogEntry::wire_effort_for] /
/// [ModelCatalogEntry::offered_levels] 消费（R4 T4.2 模型级改名消费入口）。
pub type TierEffortMap = BTreeMap<String, Option<String>>;

/// `reasoning_effort_tiers` / `thinking_level_map` 的 serde 反序列化：
/// 兼容三形（向后兼容优先，缺省 None 经 `#[serde(default)]` 兜底不触发本函数）：
/// - `null` → None；
/// - 旧 `["low","medium"]` 数组 → 各档位 wire 拼写同键（旧版 `Vec<String>` 行为逐字段不变）；
/// - `{"low":null,"medium":"high"}` 对象 → 直译（Some=wire / None=隐藏）。
fn deserialize_tier_map<'de, D>(deserializer: D) -> Result<Option<TierEffortMap>, D::Error>
where
    D: Deserializer<'de>,
{
    struct TierMapVisitor;
    impl<'de> Visitor<'de> for TierMapVisitor {
        type Value = Option<TierEffortMap>;

        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("null / 档位字符串数组 / {档位: null 或 wire 字符串} 对象")
        }

        fn visit_unit<E>(self) -> Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_none<E>(self) -> Result<Self::Value, E> {
            Ok(None)
        }

        /// 旧 `Vec<String>` 形式：`["low","medium"]` → 各档位 wire 拼写同键。
        fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
        where
            A: serde::de::SeqAccess<'de>,
        {
            let mut map = BTreeMap::new();
            while let Some(tier) = seq.next_element::<String>()? {
                map.insert(tier.clone(), Some(tier));
            }
            Ok(if map.is_empty() { None } else { Some(map) })
        }

        /// 新映射形式：`{"low":null,"medium":"high"}`，直译。
        fn visit_map<A>(self, mut access: A) -> Result<Self::Value, A::Error>
        where
            A: serde::de::MapAccess<'de>,
        {
            let mut map = BTreeMap::new();
            while let Some((tier, wire)) = access.next_entry::<String, Option<String>>()? {
                map.insert(tier, wire);
            }
            Ok(if map.is_empty() { None } else { Some(map) })
        }
    }
    deserializer.deserialize_any(TierMapVisitor)
}

/// 模型目录条目（一个 provider 通道下一个模型的完整元数据）
///
/// 字段集 = v2 Schema 59 字段（docs/cache-optimization/10-model-catalog-v2/
/// 03-catalog-v2-schema.md §2 权威定义：标识 8 / 窗口 2 / 四指标价格 7 /
/// 扩展价格 9 / 缓存语义 12 / 能力位 16 / 溯源与生命周期 7）。
/// v1 遗留字段 `maxInputTokens` / `longContextThreshold` / `longContextInputPrice`
/// 已从结构移除（03 §7.1 迁移表 #17/#18：长上下文档迁入 `tieredPricing`）；
/// v1 旧 JSON 中的这些键由 serde 忽略，仍可正常解析（兼容不炸）。
/// 全部字段提供 Default（`#[serde(default)]`），缺字段条目可解析（A3 P2-10 由测试钉死）。
/// G2 扩展：`reasoning_effort_tiers` 升级为 [TierEffortMap]（档位→wire 映射载体），
/// 新增并列字段 `thinking_level_map`（pi-ai 语义，与前者同构）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelCatalogEntry {
    // ── 标识（A 组）──
    /// 条目稳定唯一 ID（缺省派生 vendor::model；跨源合并锚点 / 前端费率表键）
    pub id: Option<String>,
    /// 目录内模型标识（顶层键 vendor::model 组成部分，如 deepseek-v4-flash）
    pub model: String,
    /// API 真实请求标识（点号异形，如 qwen3.7-max；缺省 = model）
    pub api_model: Option<String>,
    /// 通道/网关标识（dashscope / volcengine / qianfan / bigmodel / zai；直连 = 官方厂商名）
    pub provider: String,
    /// 官方厂商（转售场景区分通道价与官方直连价；决定缓存行为矩阵取哪个 vendor）
    pub vendor: String,
    /// 协议模式："chat" | "responses" | "both"
    pub mode: Option<String>,
    /// 计价币种：USD / CNY（必填语义由校验层钉死，禁止隐式）
    pub currency: Option<String>,
    /// 计价单位（v2 唯一值 "per_1M"）
    pub unit: Option<String>,

    // ── 窗口（B 组）──
    /// 输入上下文窗口（token）
    pub context_window: Option<u64>,
    /// 输出上限（token）
    pub max_output_tokens: Option<u64>,

    // ── 四指标价格（C 组；全部 per_1M）──
    /// 未缓存输入价
    pub input_price: Option<f64>,
    /// 输出价
    pub output_price: Option<f64>,
    /// 缓存命中价（read/refresh）
    pub cache_read_price: Option<f64>,
    /// 通用缓存写入价（写免费 = 0 + cache_write_free = true；null = 未收录）
    pub cache_write_price: Option<f64>,
    /// Anthropic 系 5m TTL 写入价
    pub cache_write_price_5m: Option<f64>,
    /// Anthropic 系 1h TTL 写入价（above_1hr；MiniMax 1h 窗口语义不落此字段）
    pub cache_write_price_1h: Option<f64>,
    /// 写免费显式位（true 时 cache_write_price 必须为 0 或 null；false = 有写价或未收录）
    pub cache_write_free: bool,

    // ── 扩展价格（D 组）──
    /// 缓存存储费（/1M·h，小时计时；免费档 = 0）
    pub storage_price_per_1m_hour: Option<f64>,
    /// 存储费限时免费到期日（YYYY-MM-DD）
    pub storage_price_free_until: Option<String>,
    /// 推理 token 计价（models.dev cost.reasoning；P5 成本域消费）
    pub reasoning_price: Option<f64>,
    /// 价格形态："official" | "derived" | "unavailable"（缺省 official）
    pub price_status: Option<String>,
    /// 推导标注（price_status = "derived" 时必填）
    pub derivation: Option<PriceDerivation>,
    /// DeepSeek 峰谷定价标记（北京 9:00-12:00 / 14:00-18:00 2 倍，生效日期待官方公告）
    pub peak_pricing_2x: bool,
    /// 峰谷时段与生效日期
    pub peak_pricing_schedule: Option<PeakPricingSchedule>,
    /// 长度分档（基础四价 + 增量档；长上下文 2x 档 = minTokens 单边档；
    /// v1 longContextThreshold/longContextInputPrice 迁移目标）
    pub tiered_pricing: Option<Vec<TieredPriceTier>>,

    // ── 缓存语义（E 组）──
    /// 最低可缓存前缀（Anthropic 512~4096 / Kimi 256 / MiniMax 512 …；缺省由
    /// [ModelCatalog::prompt_cache_min_tokens_for] 回退 1024，对齐 litellm 默认值）
    pub prompt_cache_min_tokens: Option<u64>,
    /// 缓存类型："auto" | "explicit" | "key" | "both" | "none"
    /// （v2 值域：v1 "automatic" 更名 "auto"；旧 JSON 的 "automatic" 仍可解析）
    pub cache_type: Option<String>,
    /// 缓存机制："prefix" | "similarity" | "disk_unit" | "session" | "key"
    pub cache_mechanism: Option<String>,
    /// 是否参与任何形式缓存（behavior.rs 与 TTL 路由的开关位）
    pub supports_prompt_caching: bool,
    /// 自动隐式缓存能力（OpenRouter endpoints 语义；缺省 = 与 cacheType ∈ {auto, both} 推断一致）
    pub supports_implicit_caching: bool,
    /// prompt_cache_key 请求字段支持（behavior.rs supports_prompt_cache_key 的模型级覆盖来源）
    pub supports_prompt_cache_key: bool,
    /// 是否支持 Anthropic 式 cache_control 断点
    pub supports_cache_control: bool,
    /// 断点上限（Anthropic/MiniMax 4、百炼 4）
    pub breakpoint_max: Option<u8>,
    /// 回溯窗口（Anthropic/百炼 20）
    pub lookback_blocks: Option<u16>,
    /// 模型级 TTL（值域 "5m" / "30m" / "1h" / "24h"；v2 扩 "30m" 档承载 gpt-5.6 系；
    /// T-21 ttl.rs 消费时映射为其 CacheTtl 枚举）
    pub cache_ttl: Option<String>,
    /// 可选 TTL 档位（Anthropic ["5m","1h"]；缺省 = [cacheTtl]）
    pub cache_ttl_options: Option<Vec<String>>,

    // ── 能力位（F 组，缺省 false = 保守关闭）──
    /// Responses API 支持（DeepSeek 仅 v4-flash；engine.rs provider_url 判定用）
    pub supports_responses: bool,
    pub supports_reasoning: bool,
    /// 是否接受 reasoning_effort 参数（OpenAI/DeepSeek/Qwen/GLM/Kimi 原生格式）
    pub supports_reasoning_effort: bool,
    /// 模型级档位白名单 + wire 拼写映射（键=规范档位；值=Some(wire 拼写) 提供该档 /
    /// None=隐藏不支持档）。G2 模型级档位载体：从旧 `Vec<String>` 白名单扩展为
    /// 「档位 → Option<wire 拼写>」映射，同时承载白名单与 G6 wire 改名。
    ///
    /// serde 兼容三形：`null`/缺省 → None；旧 `["low","medium","xhigh"]` 数组 →
    /// 各档位 wire 拼写同规范名（向后兼容）；`{"low":null,"medium":"high"}` 对象 →
    /// 直译（Some=wire 拼写改名 / None=隐藏）。消费侧经 [ModelCatalogEntry::wire_effort_for]
    /// / [ModelCatalogEntry::offered_levels] 查询（R4 T4.2 模型级改名消费入口）。
    #[serde(default, deserialize_with = "deserialize_tier_map")]
    pub reasoning_effort_tiers: Option<TierEffortMap>,
    /// pi-ai thinkingLevelMap 语义载体（键=规范档位；值=Some(wire 拼写)/None=隐藏不支持档），
    /// 与 [Self::reasoning_effort_tiers] 同构（数据源 pi-ai 每模型 `thinkingLevelMap`，
    /// 如 deepseek-v4-flash `{"minimal":null,...,"high":"high","max":"max"}`）。
    /// 消费查询与 reasoning_effort_tiers 合一：[ModelCatalogEntry::wire_effort_for]
    /// 优先查本字段，未命中回落 reasoning_effort_tiers；向后兼容优先（新增字段，缺省 None）。
    #[serde(default, deserialize_with = "deserialize_tier_map")]
    pub thinking_level_map: Option<TierEffortMap>,
    pub supports_vision: bool,
    pub supports_function_calling: bool,
    pub supports_parallel_function_calling: bool,
    pub supports_system_messages: bool,
    pub supports_response_schema: bool,
    pub supports_tool_choice: bool,
    pub supports_web_search: bool,
    pub supports_audio_input: bool,
    pub supports_audio_output: bool,
    pub supports_pdf_input: bool,
    pub supports_assistant_prefill: bool,
    pub supports_computer_use: bool,

    // ── 溯源与生命周期（G 组）──
    /// 条目数据来源 URL（远程源条目 = 远程源 URL）
    pub source_url: Option<String>,
    /// 条目核实日期（YYYY-MM-DD）
    pub data_verified_at: Option<String>,
    /// 数据口径标注："static" | "official" | "channel" | "remote:models.dev" |
    /// "remote:openrouter" | "derived" | "litellm-copy"
    pub data_source: Option<String>,
    /// 自由备注（口径差异、参考值来源、未实测项、待复核项）
    pub notes: Option<String>,
    /// 促销价到期日（YYYY-MM-DD）
    pub promo_expires_at: Option<String>,
    /// 促销到期后的替代价行日期
    pub promo_replaces_at: Option<String>,
    /// 退役标记
    pub retired: bool,
    pub deprecation_date: Option<String>,
}

impl ModelCatalogEntry {
    /// 目录条目键（"{vendor}::{model}"，与 [ModelCatalog] 内部键格式一致）
    fn key(vendor: &str, model: &str) -> String {
        format!("{vendor}::{model}")
    }

    /// 模型级档位 → wire 拼写查询（G2 载体消费；供 R4 T4.2 模型级 wire 改名消费）。
    ///
    /// 合并语义（向后兼容优先、pi-ai 更细者优先）：
    /// `thinking_level_map` 优先命中 → 回车；未命中回落 `reasoning_effort_tiers`；
    /// 两字段均未收录该档 → None。仅返回**提供（Some）**档位的 wire 拼写；
    /// 隐藏档（None 值）与未收录档一律返回 None（参与「不支持」归一化/拒绝）。
    ///
    /// 返回的 wire 拼写可与键同名（常规）或改名（G6，如 `{"medium":"high"}` → "high"）。
    pub fn wire_effort_for(&self, level: &str) -> Option<&str> {
        if let Some(map) = &self.thinking_level_map {
            if let Some(wire) = map.get(level) {
                return wire.as_deref();
            }
        }
        self.reasoning_effort_tiers
            .as_ref()
            .and_then(|map| map.get(level))
            .and_then(|wire| wire.as_deref())
    }

    /// 提供档位集合（wire 拼写为 Some=提供的档位）：跨 `thinking_level_map` 与
    /// `reasoning_effort_tiers` 并集，字典序返回。隐藏档（None 值）不入集。
    /// 供「模型能力描述」只读接口（R2 T2.4）暴露稳定档位集（前端档位面板唯一数据源）。
    pub fn offered_levels(&self) -> Vec<String> {
        let mut levels = BTreeSet::new();
        for map in [self.thinking_level_map.as_ref(), self.reasoning_effort_tiers.as_ref()]
            .into_iter()
            .flatten()
        {
            for (level, wire) in map {
                if wire.is_some() {
                    levels.insert(level.clone());
                }
            }
        }
        levels.into_iter().collect()
    }
}

/// v2 文件级包装（v2 Schema §3.4；`version` 与 [ModelCatalog::version] 同语义，
/// 远程合并 / 覆盖回写后 +1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalogFile {
    /// 文件版本号（内置静态表起始 0）
    pub version: u64,
    /// 字段集版本（"2.0"，防止旧消费方误解析新字段集）
    pub schema: String,
    /// 文件级更新时间（YYYY-MM-DD）
    pub updated_at: Option<String>,
    /// 条目映射（键 = vendor::model）
    pub entries: BTreeMap<String, ModelCatalogEntry>,
}

/// 目录变更错误（T-24：覆盖白名单拒绝；"失败不阻塞仅记录"语义下用于记录/计数）
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CatalogError {
    /// 覆盖项含白名单外字段，或试图改动禁覆盖键（model / provider / vendor）
    #[error("覆盖白名单外字段：{0}")]
    ForbiddenField(String),
    /// 覆盖项结构非法（非对象 / 缺身份键 / 字段类型错误）
    #[error("覆盖项无效：{0}")]
    InvalidOverride(String),
}

/// 运行时模型目录（内置表 + 覆盖 + 扫描合并的单一真源；T-24 扩展
/// `with_overrides` / `upsert_from_scan` 变更入口，任何变更版本号 +1）
#[derive(Debug, Clone)]
pub struct ModelCatalog {
    /// 键 = "{vendor}::{model}"（同模型多通道按 provider 区分）
    /// （pub(crate)：request/cache.rs 等消费方单测需构造独立目录验证档位语义）
    pub(crate) entries: BTreeMap<String, ModelCatalogEntry>,
    /// 单调递增版本号（对齐 litellm `_model_cost_mutation_generation`；下游 memoize 失效键）
    pub(crate) version: u64,
}

impl ModelCatalog {
    /// 内置表：catalog.json 编译期打包（include_str!，无运行时 IO、离线可用）。
    ///
    /// v2 文件级包装（schema §3.4：version / schema / updatedAt / entries），
    /// 解析失败即 panic——转录错误由"catalog.json serde 全量解析"单测钉死。
    pub fn bundled() -> Self {
        let file: ModelCatalogFile = serde_json::from_str(include_str!("catalog.json"))
            .expect("内置 catalog.json 必须可解析（serde 全量解析测试钉死转录错误）");
        Self {
            entries: file.entries,
            version: 0,
        }
    }

    /// 当前版本号（下游 memoize 失效键；内置表为 0，T-24 覆盖/合并时 bump）
    pub fn version(&self) -> u64 {
        self.version
    }

    /// 多级兜底查找（对齐 litellm `_get_model_info_helper` 顺序）：
    /// 精确 "vendor::model" → 逐级去版本后缀（-0731 / -20250826，如
    /// `deepseek-v4-flash-0731` → `deepseek-v4-flash`）→ vendor 级默认条目
    /// （model="*"）→ None。
    pub fn lookup(&self, vendor: &str, model: &str) -> Option<&ModelCatalogEntry> {
        let mut probe = ModelCatalogEntry::key(vendor, model);
        if self.entries.contains_key(&probe) {
            return self.entries.get(&probe);
        }
        // 逐级去版本后缀重试（v4-flash 官方版本号即 DeepSeek-V4-Flash-0731）
        while let Some(stripped) = strip_version_suffix(&probe) {
            probe = stripped;
            if let Some(entry) = self.entries.get(&probe) {
                return Some(entry);
            }
        }
        // vendor 级默认条目（model="*"；未配置 → None）
        self.entries.get(&ModelCatalogEntry::key(vendor, "*"))
    }

    /// 便捷：上下文窗口钳制（P4/压缩层消费；窗口缺失 → None）
    pub fn context_window_for(&self, vendor: &str, model: &str) -> Option<u64> {
        self.lookup(vendor, model)
            .and_then(|entry| entry.context_window)
    }

    /// 便捷：输出上限
    pub fn max_output_for(&self, vendor: &str, model: &str) -> Option<u64> {
        self.lookup(vendor, model)
            .and_then(|entry| entry.max_output_tokens)
    }

    /// 便捷：最低可缓存前缀（条目缺失或未收录 → 回退 1024，
    /// 对齐 litellm `DEFAULT_MINIMUM_PROMPT_CACHE_TOKEN_COUNT`）
    pub fn prompt_cache_min_tokens_for(&self, vendor: &str, model: &str) -> u64 {
        self.lookup(vendor, model)
            .and_then(|entry| entry.prompt_cache_min_tokens)
            .unwrap_or(1024)
    }

    /// 便捷：缓存资格判定（未知模型保守为不支持，对齐 jcode"否则视为不支持"）
    pub fn supports_prompt_caching_for(&self, vendor: &str, model: &str) -> bool {
        self.lookup(vendor, model)
            .is_some_and(|entry| entry.supports_prompt_caching)
    }

    /// 便捷：Responses API 支持（engine.rs `provider_url` 判定用；未知模型保守为不支持）
    pub fn supports_responses_for(&self, vendor: &str, model: &str) -> bool {
        self.lookup(vendor, model)
            .is_some_and(|entry| entry.supports_responses)
    }

    // ===== v2 四价查询（v2 Schema §2 C/D 组语义；全部 Option，缺失 = 未收录）=====

    /// 便捷：未缓存输入价（per_1M）
    pub fn input_price_for(&self, vendor: &str, model: &str) -> Option<f64> {
        self.lookup(vendor, model)
            .and_then(|entry| entry.input_price)
    }

    /// 便捷：输出价（per_1M）
    pub fn output_price_for(&self, vendor: &str, model: &str) -> Option<f64> {
        self.lookup(vendor, model)
            .and_then(|entry| entry.output_price)
    }

    /// 便捷：缓存命中价（per_1M）
    pub fn cache_read_price_for(&self, vendor: &str, model: &str) -> Option<f64> {
        self.lookup(vendor, model)
            .and_then(|entry| entry.cache_read_price)
    }

    /// 便捷：通用写价（per_1M）。语义 = 条目 `cacheWritePrice`；Anthropic 系无
    /// 通用写价只有 5m/1h 双档时兜底 `cacheWritePrice5m`（对齐前端费率表
    /// `writePerMTok` 规则：cacheWritePrice ?? cacheWritePrice5m ?? 0，03 §8.2）。
    pub fn cache_write_price_for(&self, vendor: &str, model: &str) -> Option<f64> {
        self.lookup(vendor, model)
            .and_then(|entry| entry.cache_write_price.or(entry.cache_write_price_5m))
    }

    /// 便捷：Anthropic 5m 档写价（per_1M）
    pub fn cache_write_price_5m_for(&self, vendor: &str, model: &str) -> Option<f64> {
        self.lookup(vendor, model)
            .and_then(|entry| entry.cache_write_price_5m)
    }

    /// 便捷：Anthropic 1h 档写价（per_1M）
    pub fn cache_write_price_1h_for(&self, vendor: &str, model: &str) -> Option<f64> {
        self.lookup(vendor, model)
            .and_then(|entry| entry.cache_write_price_1h)
    }

    /// 便捷：写免费显式位（v2 三态语义：true = 写免费；false = 有写价或未收录；
    /// 未知模型保守 false）
    pub fn cache_write_free_for(&self, vendor: &str, model: &str) -> bool {
        self.lookup(vendor, model)
            .is_some_and(|entry| entry.cache_write_free)
    }

    /// 便捷：计价币种（USD / CNY；未知模型 = None，禁止隐式 USD）
    pub fn currency_for(&self, vendor: &str, model: &str) -> Option<&str> {
        self.lookup(vendor, model)
            .and_then(|entry| entry.currency.as_deref())
    }

    /// 便捷：缓存存储费（/1M·h；免费档 = 0，未收录 = None）
    pub fn storage_price_per_1m_hour_for(&self, vendor: &str, model: &str) -> Option<f64> {
        self.lookup(vendor, model)
            .and_then(|entry| entry.storage_price_per_1m_hour)
    }

    /// 便捷：价格形态（"official" | "derived" | "unavailable"；缺省 = official）
    pub fn price_status_for(&self, vendor: &str, model: &str) -> Option<&str> {
        self.lookup(vendor, model)
            .and_then(|entry| entry.price_status.as_deref())
    }

    // ===== 长度分档与峰谷定价消费（DEEPCHECK-05 #8：tieredPricing/peakPricing 双端消费）=====
    //
    // 此前 tieredPricing / peakPricingSchedule 仅解析与测试消费，长上下文档
    // （≥32K/≥128K/≥200K/≥256K/≥272K/≥512K，catalog.json 43 条档位）无计价查询，
    // 长上下文成本系统性低估约 45%（DEEPCHECK-05 §8 量化）。本区提供：
    // - `tiered_tier_for`：输入长度分档命中（litellm `[min, max)` 半开区间）；
    // - `input_price_for_tokens` 等四价变体：档内覆盖价 ?? 基础四价；
    // - `is_long_context_for`：长上下文档判定（无上界档，即 v1 longContextThreshold
    //   迁移语义——Gemini/Grok/OpenAI ≥200K 全 token 2x 计费档）；
    // - `peak_pricing_2x_for`：DeepSeek 峰谷判定（北京时间 9-12 / 14-18 2x）。
    // 全部为纯查询，不改变既有 `*_for` 签名（基础价语义保持，调用方零迁移）。
    // 纯函数底（tier_for_tokens / peak_pricing_2x_at）随域拆至 catalog_price.rs。

    /// 输入长度分档命中（对齐 litellm `tiered_pricing` 的 `range: [min, max)`
    /// 半开区间：`minTokens` 含下界、`maxTokens` 不含上界、`maxTokens = None`
    /// 为无上界长上下文档档）。未收录 / 无档 / 长度不落任何档 → None
    /// （调用方沿用基础四价）。
    pub fn tiered_tier_for(
        &self,
        vendor: &str,
        model: &str,
        input_tokens: u64,
    ) -> Option<&TieredPriceTier> {
        let entry = self.lookup(vendor, model)?;
        tier_for_tokens(entry.tiered_pricing.as_deref(), input_tokens)
    }

    /// 长上下文档判定：输入长度命中**无上界档**（只写 `minTokens` 的 2x 档，
    /// v1 `longContextThreshold`/`longContextInputPrice` 迁移语义；如 Gemini 3.1
    /// Pro / Grok 4.5 / GPT-5.5 pro ≥200K 全量 2x 计费）。无档模型恒 false。
    pub fn is_long_context_for(&self, vendor: &str, model: &str, input_tokens: u64) -> bool {
        self.tiered_tier_for(vendor, model, input_tokens)
            .is_some_and(|tier| tier.max_tokens.is_none())
    }

    /// 分档未缓存输入价（per_1M）：档内覆盖价 ?? 基础四价；未收录 → None
    pub fn input_price_for_tokens(
        &self,
        vendor: &str,
        model: &str,
        input_tokens: u64,
    ) -> Option<f64> {
        let entry = self.lookup(vendor, model)?;
        tier_for_tokens(entry.tiered_pricing.as_deref(), input_tokens)
            .and_then(|tier| tier.input_price)
            .or(entry.input_price)
    }

    /// 分档输出价（per_1M）：档内覆盖价 ?? 基础四价；未收录 → None
    pub fn output_price_for_tokens(
        &self,
        vendor: &str,
        model: &str,
        input_tokens: u64,
    ) -> Option<f64> {
        let entry = self.lookup(vendor, model)?;
        tier_for_tokens(entry.tiered_pricing.as_deref(), input_tokens)
            .and_then(|tier| tier.output_price)
            .or(entry.output_price)
    }

    /// 分档缓存命中价（per_1M）：档内覆盖价 ?? 基础四价；未收录 → None
    pub fn cache_read_price_for_tokens(
        &self,
        vendor: &str,
        model: &str,
        input_tokens: u64,
    ) -> Option<f64> {
        let entry = self.lookup(vendor, model)?;
        tier_for_tokens(entry.tiered_pricing.as_deref(), input_tokens)
            .and_then(|tier| tier.cache_read_price)
            .or(entry.cache_read_price)
    }

    /// 分档通用写价（per_1M）：档内覆盖价 ?? [Self::cache_write_price_for]
    /// （基础通用写价含 Anthropic `cacheWritePrice5m` 兜底语义）；未收录 → None
    pub fn cache_write_price_for_tokens(
        &self,
        vendor: &str,
        model: &str,
        input_tokens: u64,
    ) -> Option<f64> {
        self.tiered_tier_for(vendor, model, input_tokens)
            .and_then(|tier| tier.cache_write_price)
            .or_else(|| self.cache_write_price_for(vendor, model))
    }

    /// 峰谷定价判定（DeepSeek `peakPricing2x` 消费面）：当前 UTC 时刻
    /// （epoch 秒）是否落在 [PeakPricingSchedule] 的北京时间窗口内。
    ///
    /// 规则（保守不高估成本）：
    /// - `peak_pricing_2x = false` / 无 schedule / `tz` 非 `Asia/Shanghai`
    ///   （仅支持 UTC+8，其余时区无法换算 → false）；
    /// - `effectiveFrom`（YYYY-MM-DD）未到（北京当日 0 点起生效）→ false；
    /// - 窗口 `"HH:MM-HH:MM"` 左闭右开（09:00 入峰、12:00 出峰）；
    /// - 任何解析失败 → false。
    pub fn peak_pricing_2x_for(&self, vendor: &str, model: &str, now_utc_secs: u64) -> bool {
        let Some(entry) = self.lookup(vendor, model) else {
            return false;
        };
        peak_pricing_2x_at(entry, now_utc_secs)
    }
}

/// 剥离尾部数字版本后缀（-0731 / -20250826 形态）；后缀非纯数字时不剥离，
/// 避免误伤如 `deepseek-v3` 这类本身含数字的模型名。
fn strip_version_suffix(probe: &str) -> Option<String> {
    let (base, suffix) = probe.rsplit_once('-')?;
    if !suffix.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(base.to_owned())
}

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;
