//! 模型目录（Model Catalog）：内置静态表 + 多级兜底查询（P3 §3.1）
//!
//! - [ModelCatalogEntry]：一个 provider 通道下一个模型的完整元数据。字段集按
//!   00-catalog §12.1 草案缩窄到实现层必须字段；全字段可缺省（struct 级
//!   `#[serde(default)]`），缺字段条目可正常反序列化（对齐 A3 P2-10 裁决）。
//! - [ModelCatalog]：内置表 + 版本号。[ModelCatalog::lookup] 按 litellm
//!   `_get_model_info_helper` 顺序多级兜底：精确 → 去版本后缀 → vendor 默认 → None。
//!
//! 本模块不依赖 request/parse 层；行为矩阵（T-19）、TTL 表（T-21）等上层只通过
//! [ModelCatalog] 查询接口消费，禁止散落硬编码判定。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// 模型目录条目（一个 provider 通道下一个模型的完整元数据）
///
/// 字段集按 00-catalog §12.1 草案缩窄；全部字段提供 Default（`#[serde(default)]`），
/// 缺字段条目可解析（A3 P2-10 由测试钉死）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelCatalogEntry {
    // ── 标识 ──
    /// API 模型标识（唯一键，如 deepseek-v4-flash）
    pub model: String,
    /// 通道/网关标识（dashscope / volcengine / qianfan；直连 = 官方厂商名）
    pub provider: String,
    /// 官方厂商（转售场景区分通道价与官方直连价；决定缓存行为矩阵取哪个 vendor）
    pub vendor: String,
    /// 协议模式："chat" | "responses" | "both"
    pub mode: Option<String>,
    /// 计价币种：USD / CNY（转售价多为 CNY，00-catalog §12.1）
    pub currency: Option<String>,
    /// 计价单位（per_1M）
    pub unit: Option<String>,

    // ── 窗口 ──
    /// 输入上下文窗口（token）
    pub context_window: Option<u64>,
    pub max_input_tokens: Option<u64>,
    pub max_output_tokens: Option<u64>,

    // ── 价格（P3 只建模不计算；P5 成本计算消费）──
    /// 未缓存输入价（per_1M）
    pub input_price: Option<f64>,
    pub output_price: Option<f64>,
    /// 缓存命中价（read/refresh，per_1M）
    pub cache_read_price: Option<f64>,
    /// 通用缓存写入价（OpenAI GPT-5.6+ 1.25x 口径）
    pub cache_write_price: Option<f64>,
    /// Anthropic 系 5m TTL 写入价
    pub cache_write_price_5m: Option<f64>,
    /// Anthropic 系 1h TTL 写入价（无则省略）
    pub cache_write_price_1h: Option<f64>,
    /// 缓存存储费（$/1M·h 或 ¥/1M·h，Gemini / 方舟有值）
    pub storage_price_per_1m_hour: Option<f64>,
    /// 长上下文价格阈值（Grok 200K / Gemini 3.1 Pro 200K）
    pub long_context_threshold: Option<u64>,
    pub long_context_input_price: Option<f64>,
    /// DeepSeek 峰谷定价标记（北京 9:00-12:00 / 14:00-18:00 2 倍，生效日期待官方公告）
    pub peak_pricing_2x: bool,

    // ── 缓存语义 ──
    /// 最低可缓存前缀（Anthropic 512~4096 / Kimi 256 / MiniMax 512 …；缺省由
    /// [ModelCatalog::prompt_cache_min_tokens_for] 回退 1024，对齐 litellm 默认值）
    pub prompt_cache_min_tokens: Option<u64>,
    /// 缓存类型："automatic" | "explicit" | "both" | "none"
    pub cache_type: Option<String>,
    /// 缓存机制："prefix" | "similarity" | "disk_unit" | "session"
    pub cache_mechanism: Option<String>,
    /// 是否支持 Anthropic 式 cache_control 断点
    pub supports_cache_control: bool,
    /// 是否参与任何形式缓存
    pub supports_prompt_caching: bool,
    /// 断点上限（Anthropic/MiniMax 4、百炼 4）
    pub breakpoint_max: Option<u8>,
    /// 回溯窗口（Anthropic/百炼 20）
    pub lookback_blocks: Option<u16>,
    /// 模型级 TTL（值域 "5m" / "1h" / "24h"，对齐 00-catalog §12.1；
    /// T-21 ttl.rs 消费时映射为其 CacheTtl 枚举）
    pub cache_ttl: Option<String>,
    /// 旧轨模型写免费（OpenAI 旧模型/Kimi/DeepSeek）
    pub cache_write_free: bool,

    // ── 协议/能力位 ──
    /// Responses API 支持（DeepSeek 仅 v4-flash；engine.rs provider_url 判定用）
    pub supports_responses: bool,
    pub supports_reasoning: bool,
    /// 是否接受 reasoning_effort 参数（OpenAI/DeepSeek/Qwen/GLM/Kimi 原生格式）
    pub supports_reasoning_effort: bool,
    pub supports_vision: bool,
    pub supports_function_calling: bool,
    pub supports_parallel_function_calling: bool,
    pub supports_system_messages: bool,
    pub supports_response_schema: bool,

    // ── 溯源 ──
    pub deprecation_date: Option<String>,
    /// 条目数据来源（00-catalog 各节 URL）
    pub source_url: Option<String>,
    /// 条目核实日期（00-catalog 数据获取日期 2026-08-02）
    pub data_verified_at: Option<String>,
}

impl ModelCatalogEntry {
    /// 目录条目键（"{vendor}::{model}"，与 [ModelCatalog] 内部键格式一致）
    fn key(vendor: &str, model: &str) -> String {
        format!("{vendor}::{model}")
    }
}

/// 运行时模型目录（内置表 + 覆盖 + 扫描合并的单一真源；T-24 扩展
/// `with_overrides` / `upsert_from_scan` 变更入口，任何变更版本号 +1）
#[derive(Debug, Clone)]
pub struct ModelCatalog {
    /// 键 = "{vendor}::{model}"（同模型多通道按 provider 区分）
    entries: BTreeMap<String, ModelCatalogEntry>,
    /// 单调递增版本号（对齐 litellm `_model_cost_mutation_generation`；下游 memoize 失效键）
    version: u64,
}

impl ModelCatalog {
    /// 内置表：catalog.json 编译期打包（include_str!，无运行时 IO、离线可用）。
    ///
    /// 解析失败即 panic——转录错误由"catalog.json serde 全量解析"单测钉死。
    pub fn bundled() -> Self {
        let entries = serde_json::from_str(include_str!("catalog.json"))
            .expect("内置 catalog.json 必须可解析（serde 全量解析测试钉死转录错误）");
        Self { entries, version: 0 }
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
        self.lookup(vendor, model).and_then(|entry| entry.context_window)
    }

    /// 便捷：输出上限
    pub fn max_output_for(&self, vendor: &str, model: &str) -> Option<u64> {
        self.lookup(vendor, model).and_then(|entry| entry.max_output_tokens)
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
mod tests {
    use super::*;

    /// 内置表 serde 全量解析 + 键与条目身份字段一致（防转录漂移）+ 各厂商条目数钉死
    #[test]
    fn catalog_json_parses_fully_and_keys_match_entries() {
        let catalog = ModelCatalog::bundled();
        // ≈27 条起步（DeepSeek 2 / Anthropic 7 / OpenAI 2 / Kimi 1 / Grok 2 /
        // MiniMax 3 / Gemini 4 / GLM 4 / Qwen 3）
        assert!(catalog.entries.len() >= 27, "内置条目数 = {}", catalog.entries.len());
        for (key, entry) in &catalog.entries {
            assert_eq!(
                *key,
                ModelCatalogEntry::key(&entry.vendor, &entry.model),
                "键必须与 vendor::model 一致",
            );
            assert!(!entry.model.is_empty(), "{key} 缺 model");
            assert!(!entry.provider.is_empty(), "{key} 缺 provider");
            assert!(!entry.vendor.is_empty(), "{key} 缺 vendor");
            assert!(entry.source_url.is_some(), "{key} 缺 source_url");
            assert_eq!(
                entry.data_verified_at.as_deref(),
                Some("2026-08-02"),
                "{key} 核实日期须为 2026-08-02",
            );
        }
        // 各厂商条目数（转录范围钉死）
        let count = |vendor: &str| {
            catalog
                .entries
                .keys()
                .filter(|key| key.starts_with(&format!("{vendor}::")))
                .count()
        };
        assert_eq!(count("deepseek"), 2);
        assert_eq!(count("anthropic"), 7);
        assert_eq!(count("openai"), 2);
        assert_eq!(count("kimi"), 1);
        assert_eq!(count("grok"), 2);
        assert_eq!(count("minimax"), 3);
        assert_eq!(count("gemini"), 4);
        assert_eq!(count("glm"), 4);
        assert_eq!(count("qwen"), 3);
    }

    /// 精确命中：deepseek-v4-flash 及其关键字段
    #[test]
    fn lookup_exact_match_hits_bundled_entry() {
        let catalog = ModelCatalog::bundled();
        let flash = catalog
            .lookup("deepseek", "deepseek-v4-flash")
            .expect("内置 deepseek-v4-flash 必须命中");
        assert_eq!(flash.model, "deepseek-v4-flash");
        assert_eq!(flash.vendor, "deepseek");
        assert_eq!(flash.context_window, Some(1_000_000));
        assert_eq!(flash.input_price, Some(0.14));
        assert_eq!(flash.cache_read_price, Some(0.0028));
        assert_eq!(flash.output_price, Some(0.28));
        assert!(flash.supports_prompt_caching);
        assert!(flash.supports_responses);
        assert!(!flash.supports_cache_control);

        // v4-pro：Responses 尚未支持（官方口径 2026 年 8 月初加入）
        let pro = catalog
            .lookup("deepseek", "deepseek-v4-pro")
            .expect("内置 deepseek-v4-pro 必须命中");
        assert_eq!(pro.cache_read_price, Some(0.003625));
        assert!(!pro.supports_responses);
    }

    /// 版本后缀兜底：deepseek-v4-flash-0731（官方版本号）命中内置 v4-flash 条目
    #[test]
    fn lookup_strips_version_suffix() {
        let catalog = ModelCatalog::bundled();
        let entry = catalog
            .lookup("deepseek", "deepseek-v4-flash-0731")
            .expect("版本后缀必须兜底命中");
        assert_eq!(entry.model, "deepseek-v4-flash");
        assert_eq!(entry.cache_read_price, Some(0.0028));
        // 长日期形态（-YYYYMMDD）同样逐级剥离
        assert!(catalog.lookup("deepseek", "deepseek-v4-flash-20250826").is_some());
    }

    /// 未知模型 / 未知 vendor → None
    #[test]
    fn lookup_unknown_model_and_vendor_yield_none() {
        let catalog = ModelCatalog::bundled();
        assert!(catalog.lookup("deepseek", "unknown-model").is_none());
        assert!(catalog.lookup("unknown-vendor", "deepseek-v4-flash").is_none());
        assert!(catalog.lookup("unknown-vendor", "whatever").is_none());
    }

    /// vendor 级默认条目（model="*"）兜底：精确与去版本后缀均未命中时生效
    #[test]
    fn lookup_falls_back_to_vendor_default_entry() {
        let mut entries = BTreeMap::new();
        entries.insert(
            "acme::*".to_owned(),
            ModelCatalogEntry {
                model: "*".to_owned(),
                provider: "acme".to_owned(),
                vendor: "acme".to_owned(),
                ..Default::default()
            },
        );
        let catalog = ModelCatalog { entries, version: 0 };
        assert!(catalog.lookup("acme", "anything-at-all").is_some());
        // 未配置 vendor 默认条目的厂商 → None
        assert!(catalog.lookup("other", "anything-at-all").is_none());
    }

    /// 精确条目优先于 vendor 默认条目
    #[test]
    fn lookup_prefers_exact_over_vendor_default() {
        let mut entries = BTreeMap::new();
        entries.insert(
            "acme::*".to_owned(),
            ModelCatalogEntry {
                model: "*".to_owned(),
                provider: "acme".to_owned(),
                vendor: "acme".to_owned(),
                ..Default::default()
            },
        );
        entries.insert(
            "acme::special".to_owned(),
            ModelCatalogEntry {
                model: "special".to_owned(),
                provider: "acme".to_owned(),
                vendor: "acme".to_owned(),
                ..Default::default()
            },
        );
        let catalog = ModelCatalog { entries, version: 0 };
        assert_eq!(catalog.lookup("acme", "special").unwrap().model, "special");
    }

    /// A3 P2-10：必填非 Option 字段全部有 Default，缺字段条目可解析
    #[test]
    fn entry_with_missing_fields_parses_with_defaults() {
        let minimal = r#"{"model":"x","provider":"p","vendor":"v"}"#;
        let entry: ModelCatalogEntry =
            serde_json::from_str(minimal).expect("缺字段条目必须可解析");
        assert_eq!(entry.model, "x");
        assert_eq!(entry.context_window, None);
        assert_eq!(entry.prompt_cache_min_tokens, None);
        assert_eq!(entry.source_url, None);
        assert_eq!(entry.mode, None);
        assert!(!entry.supports_prompt_caching);
        assert!(!entry.supports_cache_control);
        assert!(!entry.supports_responses);
        assert!(!entry.supports_reasoning_effort);
        // 空对象同样可解析（全部字段走 Default）
        let empty: ModelCatalogEntry = serde_json::from_str("{}").expect("空对象必须可解析");
        assert_eq!(empty.model, "");
        assert!(!empty.supports_prompt_caching);
    }

    /// 便捷查询：窗口/输出上限/最低可缓存前缀/缓存资格/Responses 支持/版本号
    #[test]
    fn convenience_queries_respect_catalog_and_defaults() {
        let catalog = ModelCatalog::bundled();
        // 窗口与输出上限
        assert_eq!(
            catalog.context_window_for("deepseek", "deepseek-v4-flash"),
            Some(1_000_000)
        );
        assert_eq!(
            catalog.max_output_for("anthropic", "claude-haiku-4-5"),
            Some(64_000)
        );
        // Gemini 3.x 窗口 00-catalog 未收录 → None（不沿用前端旧值 1M）
        assert_eq!(catalog.context_window_for("gemini", "gemini-3-6-flash"), None);
        // 最低可缓存前缀：收录值命中；未收录/未知模型回退 1024
        assert_eq!(catalog.prompt_cache_min_tokens_for("kimi", "kimi-k3"), 256);
        assert_eq!(
            catalog.prompt_cache_min_tokens_for("deepseek", "deepseek-v4-flash"),
            1024
        );
        assert_eq!(catalog.prompt_cache_min_tokens_for("nobody", "whatever"), 1024);
        // 缓存资格：内置开启；未知模型保守关闭
        assert!(catalog.supports_prompt_caching_for("anthropic", "claude-sonnet-4-5"));
        assert!(!catalog.supports_prompt_caching_for("nobody", "whatever"));
        // Responses：v4-flash 支持、v4-pro 不支持、未知不支持
        assert!(catalog.supports_responses_for("deepseek", "deepseek-v4-flash"));
        assert!(!catalog.supports_responses_for("deepseek", "deepseek-v4-pro"));
        assert!(!catalog.supports_responses_for("nobody", "whatever"));
        // 币种转录：Kimi 为 CNY、Anthropic 为 USD
        assert_eq!(
            catalog.lookup("kimi", "kimi-k3").unwrap().currency.as_deref(),
            Some("CNY")
        );
        assert_eq!(
            catalog.lookup("anthropic", "claude-sonnet-5").unwrap().currency.as_deref(),
            Some("USD")
        );
        // 内置表版本号从 0 起（T-24 覆盖/合并时 bump）
        assert_eq!(catalog.version(), 0);
    }

    /// Sonnet 5 促销价转录钉死（00-catalog §1.1：8/31 前 $2/$10；9/1 起涨价
    /// $3/$15 属 P5 定价模块日期区间切换，00-catalog §12.3 刷新清单）
    #[test]
    fn sonnet5_transcribes_promo_price() {
        let catalog = ModelCatalog::bundled();
        let sonnet5 = catalog
            .lookup("anthropic", "claude-sonnet-5")
            .expect("内置 claude-sonnet-5 必须命中");
        assert_eq!(sonnet5.input_price, Some(2.0));
        assert_eq!(sonnet5.cache_read_price, Some(0.2));
        assert_eq!(sonnet5.output_price, Some(10.0));
        assert_eq!(sonnet5.prompt_cache_min_tokens, Some(1024));
    }
}
