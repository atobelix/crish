//! 厂商缓存行为矩阵（P3 §3.2 / 任务 T-19）
//!
//! - [VendorId]：缓存行为矩阵的厂商键。独立于 `request/vendor.rs` 的
//!   [ReasoningVendor]（A1-20：新增独立类型，不扩 ReasoningVendor），补充缓存
//!   维度厂商 MiniMax / Grok / Dashscope / Qwen。[VendorId::from_identity] 是
//!   yaml provider 身份（providerId / catalog 条目 `vendor` 字段）→ 矩阵键的
//!   唯一映射；未识别 → None（调用方 fail-closed，**禁止** URL/模型前缀猜测）。
//! - [CacheBehavior]：缓存行为开关集，是 models/ 层查询接口的返回类型。
//!   本模块矩阵是缓存能力判定的**唯一数据真源**（C2）：P2 注入框架经
//!   `build_cache_policy` 消费，本模块不直接进 engine。
//! - [cache_behavior_for]：vendor 级默认矩阵 + catalog 模型级覆盖
//!   （优先级：catalog 条目显式声明 > vendor 默认）。模型系列差异（如
//!   MiniMax M3 关主动缓存）**不再**由代码内模型 ID 表表达，改由 catalog 条目
//!   的 `cacheType` / `supportsCacheControl` 声明驱动（U4：能力由配置声明）。
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

    /// yaml provider 身份 → 矩阵键（`providerId` / catalog 条目 `vendor` 字段）。
    ///
    /// 身份**必须由配置声明**（U4/N4）：本函数只做「已声明的身份 → 矩阵键」的
    /// 枚举翻译，**不做**任何 URL 子串 / 模型名前缀推断。未识别 → `None`
    /// （调用方 fail-closed，禁止回落猜测）。
    pub fn from_identity(identity: &str) -> Option<Self> {
        match identity.trim().to_ascii_lowercase().as_str() {
            "deepseek" => Some(Self::Deepseek),
            "anthropic" | "claude" => Some(Self::Anthropic),
            "minimax" => Some(Self::MiniMax),
            "openai" => Some(Self::Openai),
            "kimi" | "moonshot" => Some(Self::Kimi),
            "grok" | "xai" => Some(Self::Grok),
            "gemini" | "google" => Some(Self::Gemini),
            "glm" | "zhipu" | "bigmodel" | "zai" => Some(Self::Glm),
            "qwen" => Some(Self::Qwen),
            "dashscope" => Some(Self::Dashscope),
            _ => None,
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

/// 应用 catalog 模型级覆盖（P3 §3.2.3；U4：模型差异由**配置声明**，不由代码内
/// 模型 ID 表猜测）。
///
/// 覆盖语义：
/// - 条目声明了缓存语义（`cacheType` 存在，如内置 catalog.json 条目）→
///   `supports_cache_control` / `breakpoint_max` 以条目为**权威**（可开可关，
///   如 minimax-m3 `cacheType: auto` + `supportsCacheControl: false` 关闭主动断点）；
/// - 未声明缓存语义（如 yaml 树投影条目，`cacheType` 缺省）→ 仅**单向开启**
///   （条目 true 时覆盖，false/None 视为缺省不覆盖，保持 vendor 级默认）。
///
/// v2 Schema §6.1 新增消费点：`supportsPromptCacheKey` → `supports_prompt_cache_key`
/// 模型级覆盖；`supportsImplicitCaching` → `auto_cache` 模型级覆盖。
fn apply_catalog_overrides(behavior: &mut CacheBehavior, entry: &ModelCatalogEntry) {
    // 条目是否显式声明缓存语义（catalog.json 条目带 cacheType；yaml 投影条目不带）
    let declares_cache = entry.cache_type.is_some();
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
    // 主动断点能力：显式声明条目权威（可开可关），否则仅单向开启
    if entry.supports_cache_control {
        behavior.supports_cache_control = true;
    } else if declares_cache {
        behavior.supports_cache_control = false;
    }
    if let Some(breakpoint) = entry.breakpoint_max {
        behavior.breakpoint_max = Some(breakpoint);
    } else if declares_cache {
        behavior.breakpoint_max = None;
    }
    if let Some(ttl) = entry.cache_ttl.as_deref().and_then(CacheTtl::parse) {
        behavior.default_ttl = Some(ttl);
    }
}

/// 缓存行为判定（P3 §3.2.3；models/ 层数据查询接口，唯一数据真源，C2）
///
/// 覆盖优先级：catalog 模型级条目（显式声明） > vendor 级默认矩阵。
/// vendor = [VendorId::Auto] 时恒为保守默认（未知网关不猜，catalog 覆盖不生效）。
/// 模型系列差异由 catalog 条目声明驱动，不再有代码内模型 ID 表。
pub fn cache_behavior_for(
    catalog: Option<&ModelCatalog>,
    vendor: VendorId,
    model: &str,
) -> CacheBehavior {
    let mut behavior = vendor_default(vendor);
    if vendor == VendorId::Auto {
        return behavior;
    }
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

    // ── VendorId::from_identity：yaml provider 身份 → 矩阵键（唯一映射）──

    #[test]
    fn vendor_id_from_declared_identity() {
        assert_eq!(
            VendorId::from_identity("deepseek"),
            Some(VendorId::Deepseek)
        );
        assert_eq!(
            VendorId::from_identity("Anthropic"),
            Some(VendorId::Anthropic)
        );
        assert_eq!(VendorId::from_identity("claude"), Some(VendorId::Anthropic));
        assert_eq!(VendorId::from_identity("minimax"), Some(VendorId::MiniMax));
        assert_eq!(VendorId::from_identity("openai"), Some(VendorId::Openai));
        assert_eq!(VendorId::from_identity("kimi"), Some(VendorId::Kimi));
        assert_eq!(VendorId::from_identity("moonshot"), Some(VendorId::Kimi));
        assert_eq!(VendorId::from_identity("grok"), Some(VendorId::Grok));
        assert_eq!(VendorId::from_identity("gemini"), Some(VendorId::Gemini));
        assert_eq!(VendorId::from_identity("glm"), Some(VendorId::Glm));
        assert_eq!(VendorId::from_identity("qwen"), Some(VendorId::Qwen));
        assert_eq!(
            VendorId::from_identity("dashscope"),
            Some(VendorId::Dashscope)
        );
        // 前后空白容忍；大小写不敏感（身份是声明值，非 URL/模型名猜测）
        assert_eq!(
            VendorId::from_identity("  DeepSeek  "),
            Some(VendorId::Deepseek)
        );
    }

    #[test]
    fn vendor_id_unknown_identity_is_none_fail_closed() {
        // 未声明的自定义 provider 身份 → None（调用方 fail-closed，禁止回落猜测）
        assert_eq!(VendorId::from_identity("my-gateway"), None);
        assert_eq!(VendorId::from_identity(""), None);
        assert_eq!(VendorId::from_identity("https://api.deepseek.com"), None);
        assert_eq!(VendorId::from_identity("deepseek-v4-flash"), None);
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
        // M3 关主动缓存 / M2.x 开：差异来自 catalog 条目的**显式声明**
        // （cacheType + supportsCacheControl），不再有代码内模型 ID 表（U4）。
        let catalog = ModelCatalog::bundled();
        // M3：条目 cacheType="auto" + supportsCacheControl=false → 无主动断点
        let m3 = cache_behavior_for(Some(&catalog), VendorId::MiniMax, "minimax-m3");
        assert!(m3.supports_prompt_caching && m3.auto_cache);
        assert!(!m3.supports_cache_control);
        assert_eq!(m3.breakpoint_max, None);
        // M2.x（横线目录形态）：条目 supportsCacheControl=true / breakpointMax=4
        let m2 = cache_behavior_for(Some(&catalog), VendorId::MiniMax, "minimax-m2-7");
        assert!(m2.supports_cache_control);
        assert_eq!(m2.breakpoint_max, Some(4));
        // 无 catalog（vendor 默认矩阵）：MiniMax 默认行开主动断点——
        // 条目缺失时不回落代码内模型 ID 表（U4：不猜）
        let m3_default = cache_behavior_for(None, VendorId::MiniMax, "minimax-m3");
        assert!(m3_default.supports_cache_control);
        assert_eq!(m3_default.breakpoint_max, Some(4));
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

    // ── Kimi 家族默认行（kimi-k3 等现行旗舰由 vendor 默认行 + catalog 条目声明）──

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

    // ── GLM 家族默认行（断点未实测 → 保守关；条目声明同向）──

    #[test]
    fn glm_4_7_resolves_to_conservative_glm_behavior() {
        // GLM vendor 默认行即保守关（无主动断点）
        let behavior = cache_behavior_for(None, VendorId::Glm, "glm-4.7");
        assert!(behavior.auto_cache && behavior.supports_prompt_caching);
        assert!(!behavior.supports_cache_control);
        assert_eq!(behavior.breakpoint_max, None);
        // 横线目录形态（catalog.json 存 glm-4-7）条目声明保守关
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

    // ── catalog 模型级覆盖：优先级 目录条目显式声明 > vendor 默认 ──

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

    // ── 系列差异由 catalog 条目显式声明驱动（无代码内模型 ID 表）──

    #[test]
    fn catalog_entry_declaration_drives_series_differences() {
        // 模型差异只取精确条目，版本型号不再回落基础型号。
        let catalog = ModelCatalog::bundled();
        assert!(catalog.lookup("minimax", "minimax-m3-2026").is_none());
        let m3 = cache_behavior_for(Some(&catalog), VendorId::MiniMax, "minimax-m3");
        assert!(!m3.supports_cache_control);
        assert_eq!(m3.breakpoint_max, None);
        // M2.x 条目声明开 → 断点 4
        let m2 = cache_behavior_for(Some(&catalog), VendorId::MiniMax, "minimax-m2-7");
        assert!(m2.supports_cache_control);
        assert_eq!(m2.breakpoint_max, Some(4));
        // GLM 条目声明保守关（无主动断点）
        let glm = cache_behavior_for(Some(&catalog), VendorId::Glm, "glm-4-7");
        assert!(glm.auto_cache && !glm.supports_cache_control);
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

    // ── W4 验收：协议决议取自 yaml 声明，不受 baseUrl 影响（无 URL 嗅探）──

    /// yaml 模型声明 `protocol: openai/chat`，同时 provider baseUrl 含
    /// `anthropic` 字样 —— 协议决议必须取自 yaml 声明（openai/chat），
    /// 绝不因 baseUrl 子串被嗅探成 anthropic/messages。
    #[test]
    fn yaml_declared_protocol_is_not_overridden_by_base_url() {
        let yaml = r#"
version: 2
providers:
  weird-gateway:
    baseUrl: "https://api.anthropic.com/v1"
    models:
      - id: weird-model
        protocol: "openai/chat"
"#;
        let catalog = ModelCatalog::from_yaml_str(yaml).expect("v2 yaml 必须解析成功");
        let entry = catalog
            .lookup("weird-gateway", "weird-model")
            .expect("yaml 声明的模型必须命中");
        assert_eq!(
            entry.protocol.as_deref(),
            Some("openai/chat"),
            "协议决议必须取自 yaml 声明，不得被 baseUrl 的 anthropic 子串覆盖"
        );
    }
}
