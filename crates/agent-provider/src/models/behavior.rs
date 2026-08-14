//! 厂商缓存行为矩阵（P3 §3.2 / 任务 T-19）
//!
//! - [VendorId]：缓存行为矩阵的厂商键。独立于 `request/vendor.rs` 的
//!   [ReasoningVendor]（A1-20：新增独立类型，不扩 ReasoningVendor），补充缓存
//!   维度厂商 MiniMax / Grok / Dashscope / Qwen。
//! - [CacheBehavior]：缓存行为开关集，是 models/ 层查询接口的返回类型。
//!   本模块矩阵是缓存能力判定的**唯一数据真源**（C2）：P2 注入框架经
//!   `build_cache_policy` 消费，本模块不直接进 engine。
//! - [infer_vendor]：base_url 关键字 → model 前缀 → Auto 的推断链，对齐
//!   `request/vendor.rs` 的 [infer_reasoning_vendor] 判定顺序，补充 minimax /
//!   grok / dashscope / z.ai / moonshot 等缓存维度关键字；vendor.rs 不改动。
//! - [cache_behavior_for]：vendor 级默认矩阵 + 模型系列覆盖（最长前缀）+
//!   catalog 模型级覆盖（优先级：catalog 条目 > 系列表 > vendor 默认）。
//!
//! R0.5 模型时代审计表 3 #1：kimi-k3 / glm-4.7 等现行旗舰的判定缺口在本模块的
//! 模型系列覆盖表中显式收录（缓存行为维度）；vendor.rs 思考能力表缺行属其
//! 文件域，补全需求经轮末汇总物移交主 Agent 协调。
//!
//! 数据事实：P3 §3.2.2 矩阵 + vendor-cache-mechanisms.md §10 汇总；GLM
//! Anthropic 端点 cache_control 行为未实测 → 保守关（矩阵标记 unverified）。

use serde::{Deserialize, Serialize};

use super::catalog::{ModelCatalog, ModelCatalogEntry};

/// 缓存行为矩阵的厂商键（P3 §3.2.1；A1-20：独立类型，不扩 ReasoningVendor）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum VendorId {
    Deepseek,
    Anthropic,
    MiniMax,
    Openai,
    Kimi,
    Grok,
    Gemini,
    Glm,
    /// 阿里云百炼通道（qwen 官方 API 即百炼基础设施；Responses Session 缓存专属）
    Qwen,
    /// 百炼通道（x-dashscope-session-cache / 显式 cache_control）
    Dashscope,
    /// 未识别 → 保守默认（不注入任何缓存字段）
    #[default]
    Auto,
}

impl VendorId {
    /// catalog 键的 vendor 段（对齐 catalog.json 条目 `vendor` 字段，供
    /// [ModelCatalog::lookup] 使用）
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Deepseek => "deepseek",
            Self::Anthropic => "anthropic",
            Self::MiniMax => "minimax",
            Self::Openai => "openai",
            Self::Kimi => "kimi",
            Self::Grok => "grok",
            Self::Gemini => "gemini",
            Self::Glm => "glm",
            Self::Qwen => "qwen",
            Self::Dashscope => "dashscope",
            Self::Auto => "auto",
        }
    }
}

/// 缓存 TTL 档（P3 §3.5 值域收敛裁决：serde 值对齐 00-catalog §12.1 的
/// "5m" / "1h" / "24h"；v2 Schema 扩第四档 "30m" 承载 gpt-5.6 系，
/// 03-catalog-v2-schema.md §0-4）。TTL 路由表（T-21 models/ttl.rs）如需本类型应
/// re-export 而非重定义，避免同 crate 两套同名枚举漂移。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CacheTtl {
    /// 5 分钟（自动缓存通例；命中刷新免费）
    #[serde(rename = "5m")]
    Short,
    /// 30 分钟（v2 新增档；gpt-5.6 系 TTL 仅 30m 语义）
    #[serde(rename = "30m")]
    HalfHour,
    /// 1 小时（Anthropic ttl:"1h" 显式；写入价 2x）
    #[serde(rename = "1h")]
    Hour,
    /// 24 小时（OpenAI 扩展保留模型）
    #[serde(rename = "24h")]
    Day,
}

impl CacheTtl {
    /// 秒数（300 / 1800 / 3600 / 86400）
    pub fn seconds(self) -> u64 {
        match self {
            Self::Short => 300,
            Self::HalfHour => 1800,
            Self::Hour => 3600,
            Self::Day => 86400,
        }
    }

    /// 从 catalog 条目 `cache_ttl` 字符串解析；未识别的值 → None（不覆盖默认档）
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "5m" => Some(Self::Short),
            "30m" => Some(Self::HalfHour),
            "1h" => Some(Self::Hour),
            "24h" => Some(Self::Day),
            _ => None,
        }
    }
}

/// 缓存行为开关集（P3 §3.2.1；P2 注入框架的决策输入，本模块为数据真源 C2）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CacheBehavior {
    /// 行为所属厂商（Auto = 保守默认）
    pub vendor: VendorId,
    /// 是否参与任何形式缓存（无 → 不注入任何缓存字段、TTL=None）
    pub supports_prompt_caching: bool,
    /// 自动缓存（无需请求侧字段，只需前缀稳定 + usage 解析）
    pub auto_cache: bool,
    /// 是否支持 Anthropic 式 cache_control 断点
    pub supports_cache_control: bool,
    /// DeepSeek 强制省略 cache_control（注入框架必须跳过）
    pub omit_cache_control: bool,
    /// 是否支持 prompt_cache_key 请求字段
    pub supports_prompt_cache_key: bool,
    /// 是否支持会话亲和 header
    pub supports_conv_header: bool,
    /// 会话亲和 header 名（None = 无；Grok 值 = 键推导结果，Dashscope 值 = 固定
    /// "enable"，取值由 T-20 cache_key.rs 的 session_affinity_headers 负责）
    pub conv_header_name: Option<&'static str>,
    /// 断点预算（Anthropic/MiniMax/百炼 = 4；OpenAI 写入上限 4，implicit 占 1
    /// → 显式最多 3，A1-19 措辞）
    pub breakpoint_max: Option<u8>,
    /// TTL 默认档（None = 无缓存 TTL，冷缓存预警不触发）
    pub default_ttl: Option<CacheTtl>,
}

/// 断点预算家族常量（Anthropic / MiniMax / 百炼一致的上限）
const SERIES_BREAKPOINT_MAX: u8 = 4;

// ── vendor 级默认行为矩阵（数据事实：P3 §3.2.2；GLM 断点格 unverified 保守关）──

const DEEPSEEK: CacheBehavior = CacheBehavior {
    vendor: VendorId::Deepseek,
    supports_prompt_caching: true,
    auto_cache: true,
    supports_cache_control: false,
    omit_cache_control: true,
    supports_prompt_cache_key: false,
    supports_conv_header: false,
    conv_header_name: None,
    breakpoint_max: None,
    default_ttl: Some(CacheTtl::Short),
};

const ANTHROPIC: CacheBehavior = CacheBehavior {
    vendor: VendorId::Anthropic,
    supports_prompt_caching: true,
    auto_cache: true,
    supports_cache_control: true,
    omit_cache_control: false,
    supports_prompt_cache_key: false,
    supports_conv_header: false,
    conv_header_name: None,
    breakpoint_max: Some(SERIES_BREAKPOINT_MAX),
    default_ttl: Some(CacheTtl::Short),
};

const MINIMAX: CacheBehavior = CacheBehavior {
    vendor: VendorId::MiniMax,
    supports_prompt_caching: true,
    auto_cache: true,
    supports_cache_control: true,
    omit_cache_control: false,
    supports_prompt_cache_key: false,
    supports_conv_header: false,
    conv_header_name: None,
    breakpoint_max: Some(SERIES_BREAKPOINT_MAX),
    default_ttl: Some(CacheTtl::Short),
};

const OPENAI: CacheBehavior = CacheBehavior {
    vendor: VendorId::Openai,
    supports_prompt_caching: true,
    auto_cache: true,
    supports_cache_control: false,
    omit_cache_control: false,
    supports_prompt_cache_key: true,
    supports_conv_header: false,
    conv_header_name: None,
    breakpoint_max: Some(SERIES_BREAKPOINT_MAX),
    default_ttl: Some(CacheTtl::Short),
};

const KIMI: CacheBehavior = CacheBehavior {
    vendor: VendorId::Kimi,
    supports_prompt_caching: true,
    auto_cache: true,
    supports_cache_control: false,
    omit_cache_control: false,
    supports_prompt_cache_key: true,
    supports_conv_header: false,
    conv_header_name: None,
    breakpoint_max: None,
    default_ttl: Some(CacheTtl::Short),
};

const GROK: CacheBehavior = CacheBehavior {
    vendor: VendorId::Grok,
    supports_prompt_caching: true,
    auto_cache: true,
    supports_cache_control: false,
    omit_cache_control: false,
    supports_prompt_cache_key: true,
    supports_conv_header: true,
    conv_header_name: Some("x-grok-conv-id"),
    breakpoint_max: None,
    default_ttl: Some(CacheTtl::Short),
};

const GEMINI: CacheBehavior = CacheBehavior {
    vendor: VendorId::Gemini,
    supports_prompt_caching: true,
    auto_cache: true,
    supports_cache_control: false,
    omit_cache_control: false,
    supports_prompt_cache_key: false,
    supports_conv_header: false,
    conv_header_name: None,
    breakpoint_max: None,
    default_ttl: Some(CacheTtl::Short),
};

const GLM: CacheBehavior = CacheBehavior {
    vendor: VendorId::Glm,
    supports_prompt_caching: true,
    auto_cache: true,
    supports_cache_control: false,
    omit_cache_control: false,
    supports_prompt_cache_key: false,
    supports_conv_header: false,
    conv_header_name: None,
    breakpoint_max: None,
    default_ttl: Some(CacheTtl::Short),
};

/// Qwen 官方直连：缓存行为未实测（调研时 docs.qwen.ai 不可达，仅百炼通道
/// 已确认，vendor-cache-mechanisms.md §9c）→ 保守默认，由 catalog 条目覆盖
const QWEN: CacheBehavior = CacheBehavior {
    vendor: VendorId::Qwen,
    supports_prompt_caching: false,
    auto_cache: false,
    supports_cache_control: false,
    omit_cache_control: false,
    supports_prompt_cache_key: false,
    supports_conv_header: false,
    conv_header_name: None,
    breakpoint_max: None,
    default_ttl: None,
};

const DASHSCOPE: CacheBehavior = CacheBehavior {
    vendor: VendorId::Dashscope,
    supports_prompt_caching: true,
    auto_cache: true,
    supports_cache_control: true,
    omit_cache_control: false,
    supports_prompt_cache_key: false,
    supports_conv_header: true,
    conv_header_name: Some("x-dashscope-session-cache"),
    breakpoint_max: Some(SERIES_BREAKPOINT_MAX),
    default_ttl: Some(CacheTtl::Short),
};

/// Auto：未知网关保守默认（对齐 jcode"否则视为不支持"，jcode-cache-analysis.md:2744）
const AUTO: CacheBehavior = CacheBehavior {
    vendor: VendorId::Auto,
    supports_prompt_caching: false,
    auto_cache: false,
    supports_cache_control: false,
    omit_cache_control: false,
    supports_prompt_cache_key: false,
    supports_conv_header: false,
    conv_header_name: None,
    breakpoint_max: None,
    default_ttl: None,
};

/// vendor 级默认行为（静态矩阵表查询；未知 vendor 保守回退 Auto 行）
fn vendor_default(vendor: VendorId) -> CacheBehavior {
    match vendor {
        VendorId::Deepseek => DEEPSEEK,
        VendorId::Anthropic => ANTHROPIC,
        VendorId::MiniMax => MINIMAX,
        VendorId::Openai => OPENAI,
        VendorId::Kimi => KIMI,
        VendorId::Grok => GROK,
        VendorId::Gemini => GEMINI,
        VendorId::Glm => GLM,
        VendorId::Qwen => QWEN,
        VendorId::Dashscope => DASHSCOPE,
        VendorId::Auto => AUTO,
    }
}

/// 从 base_url / model 推断 [VendorId]（P3 §3.2.3；对齐
/// `request/vendor.rs` 的 [infer_reasoning_vendor] 优先级与顺序，补充
/// minimax / grok / dashscope 等缓存维度关键字；vendor.rs 不改，本函数为
/// 新增独立实现，A1-20）
///
/// 优先级：base_url 关键字 → model 前缀 → Auto（未识别网关保守默认）。
pub fn infer_vendor(base_url: &str, model: &str) -> VendorId {
    let url = base_url.to_ascii_lowercase();
    let model = model.to_ascii_lowercase();
    if url.contains("anthropic") || model.starts_with("claude") {
        return VendorId::Anthropic;
    }
    if url.contains("deepseek") || model.starts_with("deepseek") {
        return VendorId::Deepseek;
    }
    if url.contains("generativelanguage.googleapis.com")
        || url.contains("gemini")
        || model.starts_with("gemini")
    {
        return VendorId::Gemini;
    }
    if url.contains("openai")
        || model.starts_with("gpt")
        || model.starts_with("o1")
        || model.starts_with("o3")
        || model.starts_with("o4")
    {
        return VendorId::Openai;
    }
    if url.contains("minimax") || model.starts_with("minimax") || model.starts_with("abab") {
        return VendorId::MiniMax;
    }
    if url.contains("x.ai") || url.contains("grok") || model.starts_with("grok") {
        return VendorId::Grok;
    }
    if url.contains("kimi")
        || url.contains("moonshot")
        || model.starts_with("kimi")
        || model.starts_with("moonshot")
    {
        return VendorId::Kimi;
    }
    if url.contains("z.ai")
        || url.contains("bigmodel")
        || url.contains("glm")
        || model.starts_with("glm")
    {
        return VendorId::Glm;
    }
    if url.contains("dashscope") {
        return VendorId::Dashscope;
    }
    if url.contains("qwen") || model.starts_with("qwen") {
        return VendorId::Qwen;
    }
    VendorId::Auto
}

/// 模型系列行为覆盖（只携带部分字段；None 表示不覆盖，保持 vendor 级默认）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SeriesOverrides {
    /// 主动缓存（Anthropic 式断点）开关覆盖：true 开（断点预算 = 家族常量 4）、
    /// false 关（断点预算清空）；None 不覆盖
    active_cache: Option<bool>,
}

impl SeriesOverrides {
    /// 无覆盖（仅显式收录该系列，行为保持 vendor 级默认）
    const fn none() -> Self {
        Self { active_cache: None }
    }
}

/// 模型系列 → 行为覆盖表（对齐 `MODEL_SERIES_CAPABILITIES` 的最长前缀命中
/// 模式；P3 §3.2.3 示例：MiniMax 家族 minimax-m3 关主动缓存、minimax-m2 开；
/// R0.5 表 3 #1：kimi-k3 / glm-4.7 现行旗舰显式收录防判定缺口）
static MODEL_SERIES_CACHE_BEHAVIOR: &[(&str, SeriesOverrides)] = &[
    // ── MiniMax：M3 仅被动自动缓存（vendor-cache-gaps.md:186）；
    //    M2.x 有 Anthropic 式主动缓存（4 断点 / 20 块回溯）──
    (
        "minimax-m3",
        SeriesOverrides {
            active_cache: Some(false),
        },
    ),
    (
        "minimax-m2",
        SeriesOverrides {
            active_cache: Some(true),
        },
    ),
    // ── Kimi 现行推理旗舰（§5.1；防"仅 kimi 前缀"式判定缺口）──
    ("kimi-k3", SeriesOverrides::none()),
    ("kimi-k2.7", SeriesOverrides::none()),
    ("kimi-k2.6", SeriesOverrides::none()),
    ("kimi-k2.5", SeriesOverrides::none()),
    // ── GLM（R0.5 表 3 #1：glm-4.7 明确支持 Thinking Mode；缓存断点未实测
    //    保守关，实测后改本表即可）。点号形态为 API 真实模型名（z.ai），
    //    横线形态为 catalog.json 内部键（T-18 转录形态），两形态都收录 ──
    ("glm-4.7", SeriesOverrides::none()),
    ("glm-4.6", SeriesOverrides::none()),
    ("glm-4.5-air", SeriesOverrides::none()),
    ("glm-4.5", SeriesOverrides::none()),
    ("glm-4-7", SeriesOverrides::none()),
    ("glm-4-6", SeriesOverrides::none()),
    ("glm-4-5-air", SeriesOverrides::none()),
    ("glm-4-5", SeriesOverrides::none()),
    // glm-5 前缀覆盖 glm-5.x（点号与横线形态皆命中）
    ("glm-5", SeriesOverrides::none()),
];

/// 最长前缀命中系列覆盖（未命中 → None；对齐
/// `infer_thinking_capability` 的匹配算法，vendor.rs:260-271）
fn series_overrides(model: &str) -> Option<SeriesOverrides> {
    let lower = model.to_ascii_lowercase();
    let mut best: Option<&(&str, SeriesOverrides)> = None;
    for entry in MODEL_SERIES_CACHE_BEHAVIOR {
        if lower.starts_with(entry.0) && best.is_none_or(|current| entry.0.len() > current.0.len())
        {
            best = Some(entry);
        }
    }
    best.map(|entry| entry.1)
}

/// 应用系列覆盖（断点预算随主动缓存开关联动）
fn apply_series_overrides(behavior: &mut CacheBehavior, model: &str) {
    let Some(overrides) = series_overrides(model) else {
        return;
    };
    if let Some(active) = overrides.active_cache {
        behavior.supports_cache_control = active;
        behavior.breakpoint_max = if active {
            Some(SERIES_BREAKPOINT_MAX)
        } else {
            None
        };
    }
}

/// 应用 catalog 模型级覆盖（P3 §3.2.3：supports_cache_control /
/// supports_prompt_caching / breakpoint_max / cache_ttl 非默认时覆盖；
/// `false` / `None` 视为缺省不覆盖——目录中"显式关闭"的模型（如 minimax-m3、
/// glm 全系）已由系列表先行表达，不会与条目覆盖冲突）
///
/// v2 Schema §6.1 新增消费点：`supportsPromptCacheKey` → `supports_prompt_cache_key`
/// 模型级覆盖（真源为 vendor 矩阵时的目录覆盖来源）；`supportsImplicitCaching`
/// → `auto_cache` 模型级覆盖（OpenRouter 端点实测值）。
fn apply_catalog_overrides(behavior: &mut CacheBehavior, entry: &ModelCatalogEntry) {
    if entry.supports_prompt_caching {
        behavior.supports_prompt_caching = true;
    }
    // cache_type "automatic"（v1 值域）/ "auto"（v2 值域）/ "both" 表示存在自动
    // 缓存轨（数据：catalog.json；v2 值域更名 automatic → auto，双形态都匹配）
    if matches!(
        entry.cache_type.as_deref(),
        Some("automatic" | "auto" | "both")
    ) {
        behavior.auto_cache = true;
    }
    if entry.supports_implicit_caching {
        behavior.auto_cache = true;
    }
    if entry.supports_prompt_cache_key {
        behavior.supports_prompt_cache_key = true;
    }
    if entry.supports_cache_control {
        behavior.supports_cache_control = true;
    }
    if let Some(breakpoint) = entry.breakpoint_max {
        behavior.breakpoint_max = Some(breakpoint);
    }
    if let Some(ttl) = entry.cache_ttl.as_deref().and_then(CacheTtl::parse) {
        behavior.default_ttl = Some(ttl);
    }
}

/// 缓存行为判定（P3 §3.2.3；models/ 层数据查询接口，唯一数据真源，C2）
///
/// 覆盖优先级：catalog 模型级条目（非默认字段） > 模型系列表（最长前缀） >
/// vendor 级默认矩阵。vendor = [VendorId::Auto] 时恒为保守默认（未知网关
/// 不猜，系列表与 catalog 覆盖均不生效）。
pub fn cache_behavior_for(
    catalog: Option<&ModelCatalog>,
    vendor: VendorId,
    model: &str,
) -> CacheBehavior {
    let mut behavior = vendor_default(vendor);
    if vendor == VendorId::Auto {
        return behavior;
    }
    apply_series_overrides(&mut behavior, model);
    if let Some(catalog) = catalog {
        if let Some(entry) = catalog.lookup(vendor.as_str(), model) {
            apply_catalog_overrides(&mut behavior, entry);
        }
    }
    behavior
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── infer_vendor：baseUrl 关键字命中（每家至少一条）──

    #[test]
    fn infer_vendor_by_base_url_keyword() {
        assert_eq!(
            infer_vendor("https://api.anthropic.com", ""),
            VendorId::Anthropic
        );
        assert_eq!(
            infer_vendor("https://api.deepseek.com", ""),
            VendorId::Deepseek
        );
        assert_eq!(
            infer_vendor("https://api.minimaxi.com", ""),
            VendorId::MiniMax
        );
        assert_eq!(infer_vendor("https://api.openai.com", ""), VendorId::Openai);
        assert_eq!(infer_vendor("https://api.kimi.com", ""), VendorId::Kimi);
        // 月之暗面旧域名（platform.moonshot.cn）同样命中
        assert_eq!(
            infer_vendor("https://platform.moonshot.cn", ""),
            VendorId::Kimi
        );
        assert_eq!(infer_vendor("https://api.x.ai", ""), VendorId::Grok);
        assert_eq!(
            infer_vendor("https://generativelanguage.googleapis.com", ""),
            VendorId::Gemini
        );
        // z.ai（国际）与 open.bigmodel.cn（国内）双域名
        assert_eq!(infer_vendor("https://api.z.ai", ""), VendorId::Glm);
        assert_eq!(infer_vendor("https://open.bigmodel.cn", ""), VendorId::Glm);
        assert_eq!(
            infer_vendor("https://dashscope.aliyuncs.com/compatible-mode/v1", ""),
            VendorId::Dashscope
        );
        assert_eq!(infer_vendor("https://qwen.example.com", ""), VendorId::Qwen);
    }

    // ── infer_vendor：model 前缀命中（每家至少一条）──

    #[test]
    fn infer_vendor_by_model_prefix() {
        assert_eq!(infer_vendor("", "claude-sonnet-5"), VendorId::Anthropic);
        assert_eq!(infer_vendor("", "deepseek-v4-flash"), VendorId::Deepseek);
        assert_eq!(infer_vendor("", "minimax-m3"), VendorId::MiniMax);
        assert_eq!(infer_vendor("", "minimax-m2.7"), VendorId::MiniMax);
        assert_eq!(infer_vendor("", "gpt-5.6"), VendorId::Openai);
        assert_eq!(infer_vendor("", "o3-mini"), VendorId::Openai);
        assert_eq!(infer_vendor("", "kimi-k3"), VendorId::Kimi);
        assert_eq!(infer_vendor("", "grok-4.5"), VendorId::Grok);
        assert_eq!(infer_vendor("", "gemini-3.6-flash"), VendorId::Gemini);
        assert_eq!(infer_vendor("", "glm-4.7"), VendorId::Glm);
        assert_eq!(infer_vendor("", "qwen3.7-max"), VendorId::Qwen);
    }

    // ── infer_vendor：Auto 保守回退与优先级 ──

    #[test]
    fn infer_vendor_unrecognized_falls_back_to_auto() {
        assert_eq!(infer_vendor("https://unknown.example", ""), VendorId::Auto);
        assert_eq!(infer_vendor("", "unknown-model"), VendorId::Auto);
        assert_eq!(infer_vendor("", ""), VendorId::Auto);
    }

    #[test]
    fn infer_vendor_base_url_keyword_and_model_prefix_share_chain_order() {
        // 对齐 infer_reasoning_vendor：逐厂商检查（url 或 model 命中即返回），
        // 链序即优先级，base_url 命中与 model 前缀命中等价
        assert_eq!(
            infer_vendor("https://api.anthropic.com", "deepseek-v4-flash"),
            VendorId::Anthropic
        );
        assert_eq!(
            infer_vendor("https://dashscope.aliyuncs.com", "qwen3-max"),
            VendorId::Dashscope
        );
        // 链序：claude 检查先于 openai——base_url 与 model 分属两家时取更早厂商
        assert_eq!(
            infer_vendor("https://api.openai.com", "claude-sonnet-5"),
            VendorId::Anthropic
        );
    }

    // ── 矩阵行为：DeepSeek omit 恒 true（P3 验收 2）──

    #[test]
    fn deepseek_always_omits_cache_control() {
        let behavior = cache_behavior_for(None, VendorId::Deepseek, "deepseek-v4-flash");
        assert!(behavior.omit_cache_control);
        assert!(!behavior.supports_cache_control);
        assert!(!behavior.supports_prompt_cache_key);
        assert!(behavior.supports_prompt_caching && behavior.auto_cache);
        assert_eq!(behavior.default_ttl, Some(CacheTtl::Short));
        // catalog 路径（内置条目）同样成立
        let catalog = ModelCatalog::bundled();
        let behavior = cache_behavior_for(Some(&catalog), VendorId::Deepseek, "deepseek-v4-flash");
        assert!(behavior.omit_cache_control);
        assert!(!behavior.supports_prompt_cache_key);
        assert_eq!(behavior.default_ttl, Some(CacheTtl::Short));
    }

    // ── 矩阵行为：MiniMax M3 与 M2.x 断点差异（P3 验收 2）──

    #[test]
    fn minimax_m3_disables_active_caching_while_m2_keeps_breakpoints() {
        // M3：仅被动自动缓存，无主动断点
        let m3 = cache_behavior_for(None, VendorId::MiniMax, "minimax-m3");
        assert!(m3.supports_prompt_caching && m3.auto_cache);
        assert!(!m3.supports_cache_control);
        assert_eq!(m3.breakpoint_max, None);
        // M2.x（点号 API 形态与横线目录形态）：Anthropic 式断点 4 上限
        let m2 = cache_behavior_for(None, VendorId::MiniMax, "minimax-m2.7");
        assert!(m2.supports_cache_control);
        assert_eq!(m2.breakpoint_max, Some(4));
        let m2 = cache_behavior_for(None, VendorId::MiniMax, "minimax-m2-5");
        assert!(m2.supports_cache_control);
        assert_eq!(m2.breakpoint_max, Some(4));
        // catalog 路径：内置 minimax-m3 条目（supportsCacheControl=false）不复活断点
        let catalog = ModelCatalog::bundled();
        let m3 = cache_behavior_for(Some(&catalog), VendorId::MiniMax, "minimax-m3");
        assert!(!m3.supports_cache_control);
        assert_eq!(m3.breakpoint_max, None);
    }

    // ── 矩阵行为：Grok 会话亲和 header 与键（P3 验收 2）──

    #[test]
    fn grok_exposes_conv_header_and_prompt_cache_key() {
        let behavior = cache_behavior_for(None, VendorId::Grok, "grok-4.5");
        assert_eq!(behavior.conv_header_name, Some("x-grok-conv-id"));
        assert!(behavior.supports_conv_header);
        assert!(behavior.supports_prompt_cache_key);
        assert!(!behavior.supports_cache_control);
        assert_eq!(behavior.default_ttl, Some(CacheTtl::Short));
        // 目录条目（grok-4.5）不改变该行为
        let catalog = ModelCatalog::bundled();
        let behavior = cache_behavior_for(Some(&catalog), VendorId::Grok, "grok-4.5");
        assert_eq!(behavior.conv_header_name, Some("x-grok-conv-id"));
    }

    // ── 矩阵行为：百炼 Dashscope Session 缓存头与断点（P3 验收 2）──

    #[test]
    fn dashscope_exposes_session_cache_header_and_breakpoints() {
        let behavior = cache_behavior_for(None, VendorId::Dashscope, "qwen3.7-max");
        assert_eq!(behavior.conv_header_name, Some("x-dashscope-session-cache"));
        assert!(behavior.supports_conv_header);
        assert!(behavior.supports_cache_control);
        assert_eq!(behavior.breakpoint_max, Some(4));
        assert!(behavior.supports_prompt_caching && behavior.auto_cache);
    }

    // ── R0.5 表 3 #1：kimi-k3 判定缺口在行为矩阵补全 ──

    #[test]
    fn kimi_k3_resolves_to_kimi_family_behavior() {
        let behavior = cache_behavior_for(None, VendorId::Kimi, "kimi-k3");
        assert!(behavior.auto_cache && behavior.supports_prompt_caching);
        assert!(behavior.supports_prompt_cache_key);
        assert!(!behavior.supports_cache_control);
        assert_eq!(behavior.default_ttl, Some(CacheTtl::Short));
        // catalog 模型级覆盖路径（内置 kimi-k3 条目）不改变开关语义
        let catalog = ModelCatalog::bundled();
        let behavior = cache_behavior_for(Some(&catalog), VendorId::Kimi, "kimi-k3");
        assert!(behavior.auto_cache && behavior.supports_prompt_cache_key);
    }

    // ── R0.5 表 3 #1：glm-4.7 判定缺口补全（断点未实测 → 保守关）──

    #[test]
    fn glm_4_7_resolves_to_conservative_glm_behavior() {
        // 点号 API 形态
        let behavior = cache_behavior_for(None, VendorId::Glm, "glm-4.7");
        assert!(behavior.auto_cache && behavior.supports_prompt_caching);
        assert!(!behavior.supports_cache_control);
        assert_eq!(behavior.breakpoint_max, None);
        // 横线目录形态（catalog.json 存 glm-4-7）同样命中系列表
        let behavior = cache_behavior_for(None, VendorId::Glm, "glm-4-7");
        assert!(!behavior.supports_cache_control);
        // 最长前缀：glm-4.5-air 不落到 glm-4.5 之外的未知判定
        let behavior = cache_behavior_for(None, VendorId::Glm, "glm-4.5-air");
        assert!(behavior.auto_cache && !behavior.supports_cache_control);
        // catalog 路径（内置 glm-4-7 条目）保持保守
        let catalog = ModelCatalog::bundled();
        let behavior = cache_behavior_for(Some(&catalog), VendorId::Glm, "glm-4-7");
        assert!(!behavior.supports_cache_control);
        assert_eq!(behavior.breakpoint_max, None);
    }

    // ── Auto：保守默认全关（P3 验收 2/5）──

    #[test]
    fn auto_falls_back_to_conservative_all_off() {
        let behavior = cache_behavior_for(None, VendorId::Auto, "anything");
        assert!(!behavior.supports_prompt_caching && !behavior.auto_cache);
        assert!(!behavior.supports_cache_control && !behavior.omit_cache_control);
        assert!(!behavior.supports_prompt_cache_key && !behavior.supports_conv_header);
        assert_eq!(behavior.conv_header_name, None);
        assert_eq!(behavior.breakpoint_max, None);
        assert_eq!(behavior.default_ttl, None);
        // 即使带 catalog 且模型名可识别，Auto 仍保守（未知网关不猜）
        let catalog = ModelCatalog::bundled();
        let behavior = cache_behavior_for(Some(&catalog), VendorId::Auto, "minimax-m2.7");
        assert!(!behavior.supports_cache_control);
        assert_eq!(behavior.default_ttl, None);
    }

    // ── catalog 模型级覆盖：优先级 目录条目 > 系列表 > vendor 默认 ──

    #[test]
    fn catalog_entry_overrides_vendor_defaults() {
        // Qwen 官方直连未实测 → vendor 默认保守全关
        let qwen = cache_behavior_for(None, VendorId::Qwen, "qwen3-max");
        assert!(!qwen.supports_prompt_caching);
        assert_eq!(qwen.default_ttl, None);
        // 内置 qwen3-max 条目（百炼数据）覆盖生效：自动 + 显式断点 + TTL
        let catalog = ModelCatalog::bundled();
        let qwen = cache_behavior_for(Some(&catalog), VendorId::Qwen, "qwen3-max");
        assert!(qwen.supports_prompt_caching && qwen.auto_cache);
        assert!(qwen.supports_cache_control);
        assert_eq!(qwen.breakpoint_max, Some(4));
        assert_eq!(qwen.default_ttl, Some(CacheTtl::Short));
        // 未知模型不命中目录 → 保持 vendor 默认
        let qwen = cache_behavior_for(Some(&catalog), VendorId::Qwen, "qwen-future-model");
        assert!(!qwen.supports_prompt_caching);
        // TTL 模型级覆盖：gpt-5.5 目录条目 cache_ttl="24h" → Day；
        // gpt-5.6 条目无 cache_ttl → 保持 vendor 默认 Short
        let gpt55 = cache_behavior_for(Some(&catalog), VendorId::Openai, "gpt-5.5");
        assert_eq!(gpt55.default_ttl, Some(CacheTtl::Day));
        let gpt56 = cache_behavior_for(Some(&catalog), VendorId::Openai, "gpt-5.6");
        assert_eq!(gpt56.default_ttl, Some(CacheTtl::Short));
    }

    // ── 系列表最长前缀命中 ──

    #[test]
    fn series_table_uses_longest_prefix_match() {
        // 版本后缀形态仍落在 M3 判定（前缀 minimax-m3 长于 minimax-m2）
        let m3 = cache_behavior_for(None, VendorId::MiniMax, "minimax-m3-2026");
        assert!(!m3.supports_cache_control);
        // minimax-m2 不误伤 minimax-m3
        let m2 = cache_behavior_for(None, VendorId::MiniMax, "minimax-m2.7");
        assert!(m2.supports_cache_control);
        // glm-5 系列与 glm-4 系列互不干扰
        let glm5 = cache_behavior_for(None, VendorId::Glm, "glm-5.2");
        assert!(glm5.auto_cache && !glm5.supports_cache_control);
    }

    // ── 矩阵抽查：Anthropic / OpenAI / Gemini / Kimi 默认行 ──

    #[test]
    fn vendor_defaults_spot_check() {
        let anthropic = cache_behavior_for(None, VendorId::Anthropic, "claude-sonnet-5");
        assert!(anthropic.supports_cache_control);
        assert_eq!(anthropic.breakpoint_max, Some(4));
        assert!(!anthropic.supports_prompt_cache_key);

        let openai = cache_behavior_for(None, VendorId::Openai, "gpt-5.6");
        assert!(openai.supports_prompt_cache_key);
        assert!(!openai.supports_cache_control);
        assert_eq!(openai.breakpoint_max, Some(4));

        let gemini = cache_behavior_for(None, VendorId::Gemini, "gemini-3.6-flash");
        assert!(gemini.auto_cache && !gemini.supports_cache_control);
        assert!(!gemini.supports_prompt_cache_key);

        let kimi = cache_behavior_for(None, VendorId::Kimi, "kimi-k2.6");
        assert!(kimi.supports_prompt_cache_key && kimi.auto_cache);
        assert!(!kimi.supports_cache_control);
    }

    // ── CacheTtl：serde 值域与秒数 ──

    #[test]
    fn cache_ttl_serde_values_and_seconds() {
        assert_eq!(CacheTtl::Short.seconds(), 300);
        assert_eq!(CacheTtl::HalfHour.seconds(), 1800);
        assert_eq!(CacheTtl::Hour.seconds(), 3600);
        assert_eq!(CacheTtl::Day.seconds(), 86400);
        assert_eq!(serde_json::to_string(&CacheTtl::Short).unwrap(), "\"5m\"");
        assert_eq!(
            serde_json::to_string(&CacheTtl::HalfHour).unwrap(),
            "\"30m\""
        );
        assert_eq!(serde_json::to_string(&CacheTtl::Hour).unwrap(), "\"1h\"");
        assert_eq!(serde_json::to_string(&CacheTtl::Day).unwrap(), "\"24h\"");
        assert_eq!(CacheTtl::parse("5m"), Some(CacheTtl::Short));
        assert_eq!(CacheTtl::parse("30m"), Some(CacheTtl::HalfHour));
        assert_eq!(CacheTtl::parse("1h"), Some(CacheTtl::Hour));
        assert_eq!(CacheTtl::parse("24h"), Some(CacheTtl::Day));
        assert_eq!(CacheTtl::parse("10m"), None);
        // 30m 档 serde 往返
        let json = serde_json::to_string(&CacheTtl::HalfHour).unwrap();
        let roundtrip: CacheTtl = serde_json::from_str(&json).expect("必须可反序列化");
        assert_eq!(roundtrip, CacheTtl::HalfHour);
    }

    // ── v2 Schema（R3）：cacheType "auto" 值域与模型级新覆盖 ──

    /// v2 值域更名：cacheType "auto"（v1 "automatic"）同样命中自动缓存轨；
    /// v1 旧 JSON 的 "automatic" 兼容保留（catalog.json 现为 v1 数据）
    #[test]
    fn catalog_override_cache_type_auto_and_automatic_both_enable_auto_cache() {
        let make = |cache_type: &str| ModelCatalogEntry {
            model: "m".to_string(),
            provider: "p".to_string(),
            vendor: "v".to_string(),
            supports_prompt_caching: true,
            cache_type: Some(cache_type.to_string()),
            ..Default::default()
        };
        for value in ["auto", "automatic", "both"] {
            // Qwen 直连 vendor 默认 auto_cache=false（保守），由目录覆盖开启
            let mut behavior = cache_behavior_for(None, VendorId::Qwen, "qwen3-max");
            assert!(!behavior.auto_cache, "基座必须保守关闭");
            apply_catalog_overrides(&mut behavior, &make(value));
            assert!(behavior.auto_cache, "cacheType {value} 必须开启自动缓存轨");
        }
        // "explicit" / "none" / 缺失不开启
        for value in ["explicit", "none"] {
            let mut behavior = cache_behavior_for(None, VendorId::Qwen, "qwen3-max");
            apply_catalog_overrides(&mut behavior, &make(value));
            assert!(!behavior.auto_cache, "cacheType {value} 不得开启自动缓存轨");
        }
    }

    /// v2 新消费点：supportsPromptCacheKey / supportsImplicitCaching 模型级覆盖
    /// 生效（vendor 矩阵真源之上的目录覆盖）
    #[test]
    fn catalog_override_prompt_cache_key_and_implicit_caching_enable() {
        let entry = ModelCatalogEntry {
            model: "m".to_string(),
            provider: "p".to_string(),
            vendor: "v".to_string(),
            supports_prompt_caching: true,
            supports_prompt_cache_key: true,
            supports_implicit_caching: true,
            ..Default::default()
        };
        // 基座：DeepSeek 行 key 默认 false → 目录覆盖开启
        let mut behavior = cache_behavior_for(None, VendorId::Deepseek, "deepseek-v4-flash");
        assert!(!behavior.supports_prompt_cache_key);
        apply_catalog_overrides(&mut behavior, &entry);
        assert!(behavior.supports_prompt_cache_key);
        assert!(
            behavior.auto_cache,
            "supportsImplicitCaching=true 必须开启自动轨"
        );
        // 显式 false（缺省）不改变 vendor 真源（OpenAI 行 key 默认 true）
        let entry_off = ModelCatalogEntry {
            model: "m".to_string(),
            provider: "p".to_string(),
            vendor: "v".to_string(),
            supports_prompt_caching: true,
            ..Default::default()
        };
        let mut behavior = cache_behavior_for(None, VendorId::Openai, "gpt-5.6");
        assert!(behavior.supports_prompt_cache_key);
        apply_catalog_overrides(&mut behavior, &entry_off);
        assert!(behavior.supports_prompt_cache_key, "键缺失 = 不覆盖");
    }

    /// v2 目录条目 cacheTtl="30m" → default_ttl 第四档 HalfHour（gpt-5.6 系）
    #[test]
    fn catalog_override_ttl_30m_maps_to_half_hour() {
        let entry = ModelCatalogEntry {
            model: "gpt-5.6-x".to_string(),
            provider: "openai".to_string(),
            vendor: "openai".to_string(),
            cache_ttl: Some("30m".to_string()),
            ..Default::default()
        };
        let mut behavior = cache_behavior_for(None, VendorId::Openai, "gpt-5.6-x");
        assert_eq!(
            behavior.default_ttl,
            Some(CacheTtl::Short),
            "目录覆盖前 = vendor 默认"
        );
        apply_catalog_overrides(&mut behavior, &entry);
        assert_eq!(behavior.default_ttl, Some(CacheTtl::HalfHour));
        assert_eq!(behavior.default_ttl.unwrap().seconds(), 1800);
    }
}
