//! 模型目录条目（Model Catalog Entry）及档位映射定义（v2 Schema 59 字段）

use std::collections::{BTreeMap, BTreeSet};

use serde::de::Visitor;
use serde::{Deserialize, Deserializer, Serialize};

use super::{PeakPricingSchedule, PriceDerivation, TieredPriceTier};
use crate::models::catalog_types::ModelRef;

/// 模型级档位 → Option<wire 拼写> 映射载体（G2 数据载体层契约）：
///
/// - **键** = 规范思考档位（如 "low"/"medium"/"high"/"max"）；
/// - **值** = `Some(wire 拼写)` 提供该档（值可与键相同，也可为 G6 wire 改名，
///   如 `{"medium":"high"}`）；`None` = 隐藏不支持档（参与「不支持」归一化/拒绝，不进白名单）。
///
/// 语义对齐 pi-ai `thinkingLevelMap`，由 [ModelCatalogEntry::wire_effort_for] /
/// [ModelCatalogEntry::offered_levels] 消费（R4 T4.2 模型级改名消费入口）。
pub type TierEffortMap = BTreeMap<String, Option<String>>;

/// `thinking_tiers`（v2 单一载体，取代旧 `reasoning_effort_tiers` / `thinking_level_map`
/// 双字段）的 serde 反序列化：
/// 兼容三形（向后兼容优先，缺省 None 经 `#[serde(default)]` 兜底不触发本函数）：
/// - `null` → None；
/// - 旧 `["low","medium"]` 数组 → 各档位 wire 拼写同键（旧版 `Vec<String>` 行为逐字段不变）；
/// - `{"low":null,"medium":"high"}` 对象 → 直译（Some=wire / None=隐藏）。
pub(crate) fn deserialize_tier_map<'de, D>(
    deserializer: D,
) -> Result<Option<TierEffortMap>, D::Error>
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
/// G2 扩展：档位载体统一为单一 [TierEffortMap]（`thinking_tiers`，v2 单源裁决——
/// 不允许向后兼容多轨，旧双字段废止）。
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
    /// 协议模式："chat" | "responses" | "both"（catalog.json 历史字段）。
    /// yaml 投影**不得**把 `openai/chat` 等协议字面量塞进本字段糊弄。
    pub mode: Option<String>,
    /// yaml 树投影保留的生效协议字面量（`openai/chat` / `google/generate-content` 等）。
    /// 热路径应优先 `LiveModels.find` → `ModelSpec.protocol`；本字段仅供既有 lookup 不丢字面量。
    pub protocol: Option<String>,
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
    /// 是否支持 reasoning（粗粒度门；= thinking_tiers 非空，v2 单源派生）
    pub supports_reasoning: bool,
    /// 是否接受 reasoning_effort 参数（OpenAI/DeepSeek/Qwen/GLM/Kimi 原生格式）
    pub supports_reasoning_effort: bool,
    /// 模型级思考档位白名单 + wire 拼写映射（**v2 单一载体**，取代旧
    /// `reasoning_effort_tiers` 与 `thinking_level_map` 双字段——单源裁决，
    /// 不允许向后兼容多轨）。键=规范档位；值=Some(wire 拼写) 提供该档 /
    /// None=隐藏不支持档。消费侧经 [ModelCatalogEntry::wire_effort_for] /
    /// [ModelCatalogEntry::offered_levels] 查询（R4 T4.2 模型级改名消费入口）。
    #[serde(default, deserialize_with = "deserialize_tier_map")]
    pub thinking_tiers: Option<TierEffortMap>,
    /// 思考参数形态（v2 单源；枚举串见 [crate::request::vendor::ReasoningFormat]：
    /// "reasoning_effort" / "thinking_budget" / "thinking_adaptive" / "thinking_level" /
    /// "qwen_enable_thinking" / "zai_thinking" / "openrouter_reasoning" / "none"）。
    /// 各协议 builder 按此字段映射思考 wire（不再按模型名前缀硬编码猜测）。
    pub thinking_format: Option<String>,
    /// 思考预算默认值（token；anthropic/gemini 系档位映射用）
    pub thinking_budget_default: Option<u32>,
    /// 思考预算上界（可选）
    pub thinking_budget_max: Option<u32>,
    /// 输入模态（text / image / video / audio / pdf；v2 单源）
    pub input_modalities: Option<Vec<String>>,
    /// 输出模态（text / image / video / audio；v2 单源）
    pub output_modalities: Option<Vec<String>>,
    /// 便捷位：是否支持图像输入（= input_modalities 含 image）
    pub supports_vision: bool,
    /// 便捷位：是否支持视频输入（= input_modalities 含 video；v2 新增）
    pub supports_video_input: bool,
    pub supports_function_calling: bool,
    pub supports_parallel_function_calling: bool,
    pub supports_system_messages: bool,
    pub supports_response_schema: bool,
    pub supports_tool_choice: bool,
    pub supports_web_search: bool,
    /// 便捷位：是否支持音频输入（= input_modalities 含 audio）
    pub supports_audio_input: bool,
    /// 便捷位：是否支持音频输出（= output_modalities 含 audio）
    pub supports_audio_output: bool,
    /// 便捷位：是否支持 PDF 输入（= input_modalities 含 pdf）
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
    pub fn key(vendor: &str, model: &str) -> String {
        ModelRef::new(vendor, model).key()
    }

    /// 模型级档位 → wire 拼写查询（v2 单一载体 [Self::thinking_tiers]；R4 T4.2 模型级改名消费）。
    ///
    /// 合并语义（v2 单源，废止旧双字段回落）：`thinking_tiers` 收录该档 → 返回其 wire
    /// 拼写（可为改名，如 `{"medium":"high"}` → "high"）；未收录 / 隐藏档（None 值）→ None。
    /// 仅返回**提供（Some）**档位的 wire 拼写；隐藏档与未收录档一律返回 None。
    pub fn wire_effort_for(&self, level: &str) -> Option<&str> {
        self.thinking_tiers
            .as_ref()
            .and_then(|map| map.get(level))
            .and_then(|wire| wire.as_deref())
    }

    /// 提供档位集合（wire 拼写为 Some=提供的档位）：`thinking_tiers` 中提供档位的并集，
    /// 字典序返回。隐藏档（None 值）不入集。
    /// 供「模型能力描述」只读接口（R2 T2.4）暴露稳定档位集（前端档位面板唯一数据源）。
    pub fn offered_levels(&self) -> Vec<String> {
        let mut levels = BTreeSet::new();
        if let Some(map) = &self.thinking_tiers {
            for (level, wire) in map {
                if wire.is_some() {
                    levels.insert(level.clone());
                }
            }
        }
        levels.into_iter().collect()
    }
}
