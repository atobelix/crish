//! 模型级 TTL 路由表（P3 §3.5 E / T-21）
//!
//! - [CacheTtl]：缓存 TTL 四档（5m / 30m / 1h / 24h；v2 Schema 扩 "30m" 档承载
//!   gpt-5.6 系）。**定义在 behavior.rs（T-19 交付）**，本模块按
//!   T-19 的模块内约定 re-export（"TTL 路由表（T-21 models/ttl.rs）如需本类型
//!   应 re-export 而非重定义，避免同 crate 两套同名枚举漂移"）；C3 裁决的
//!   实质目标（单一类型、serde 值域 "5m"/"1h"/"24h"、与 P2 wire 桶
//!   `TtlBucket` 无同名冲突）由此满足。任务书要求的 `as_str()` 由本模块的
//!   固有 impl 补全（同 crate 允许在其他模块内扩展固有方法）。
//! - [cache_ttl_for_provider_model]：vendor 默认档 + catalog 模型级覆盖的
//!   纯函数查询（参考 jcode `cache_ttl_for_provider_model`，
//!   jcode-cache-analysis.md:2774-2799；表只依赖供应商/模型能力，不依赖 UI 层）。
//!
//! 覆盖优先级：catalog 条目 `cache_ttl` > vendor 默认 > None（P3 §3.5）。
//! 消费方：冷缓存预警（P5 测量层）、摘要请求缓存隔离（P4 压缩层）。
//! 与行为矩阵的分工：behavior.rs 的 `CacheBehavior::default_ttl` 是注入框架的
//! 决策输入（C2 数据真源）；本表是独立的 TTL 路由查询（含 OpenAI 模型档位，
//! A1-11），两者值保持一致，供不同消费者使用。

pub use super::behavior::CacheTtl;
use super::behavior::VendorId;
use super::catalog::ModelCatalog;

impl CacheTtl {
    /// 档位的目录/wire 值域字符串（"5m" / "30m" / "1h" / "24h"，与 serde 值一致）。
    /// T-19 在 behavior.rs 定义了枚举本体与 [CacheTtl::seconds]/[CacheTtl::parse]，
    /// `as_str` 按任务书契约在本模块补全（轮末合并时可并入 behavior.rs 本体）。
    pub fn as_str(self) -> &'static str {
        match self {
            CacheTtl::Short => "5m",
            CacheTtl::HalfHour => "30m",
            CacheTtl::Hour => "1h",
            CacheTtl::Day => "24h",
        }
    }
}

/// 模型级 TTL 路由表（对齐 jcode `cache_ttl_for_provider_model`；纯函数，不依赖 UI）
///
/// 覆盖优先级：catalog 条目 `cache_ttl` > vendor 默认 > None。
/// - catalog 为 None、条目未命中、或条目 `cache_ttl` 为 None 时回退 vendor 默认档；
/// - catalog 条目 `cache_ttl` 值域为 "5m"/"30m"/"1h"/"24h"（v2 四档），
///   无法识别的值防御性忽略并回退 vendor 默认档（[CacheTtl::parse] → None）；
/// - Auto 与无缓存厂商 → None（永不预警，对齐 jcode copilot/cursor 返回 None
///   的"否则视为不支持"语义）。
pub fn cache_ttl_for_provider_model(
    catalog: Option<&ModelCatalog>,
    vendor: VendorId,
    model: &str,
) -> Option<CacheTtl> {
    if let Some(catalog) = catalog {
        if let Some(entry) = catalog.lookup(vendor.as_str(), model) {
            if let Some(parsed) = entry.cache_ttl.as_deref().and_then(CacheTtl::parse) {
                return Some(parsed);
            }
        }
    }
    vendor_default_ttl(vendor, model)
}

/// vendor 级默认档（P3 §3.5 表格；对齐 jcode 2774-2799 与 00-catalog 各节）
fn vendor_default_ttl(vendor: VendorId, model: &str) -> Option<CacheTtl> {
    match vendor {
        // Deepseek：自动磁盘前缀缓存，命中刷新免费；客户端按 300s 预警
        VendorId::Deepseek => Some(CacheTtl::Short),
        // Anthropic：默认 300s。1h 档（jcode `is_cache_ttl_1h` 开关，2776-2780）
        // 属 wire 层 TtlBucket::OneHour / retention=Long 语义（T-13 交付，
        // request/cache.rs），本路由表保守按 300s 预警
        VendorId::Anthropic => Some(CacheTtl::Short),
        // Openai：Short 为默认；gpt-5.5 及更早扩展保留模型 → Day（见下）
        VendorId::Openai => openai_default_ttl(model),
        // Kimi：全自动 Context Caching，无 TTL 管理，按 300s 预警
        VendorId::Kimi => Some(CacheTtl::Short),
        // Grok：服务端管理未公布值，按 300s
        VendorId::Grok => Some(CacheTtl::Short),
        // MiniMax：主动缓存 TTL 5 分钟（vendor-cache-mechanisms.md:150）
        VendorId::MiniMax => Some(CacheTtl::Short),
        // Gemini：隐式缓存无公开 TTL；显式 cachedContents 默认 1h 有存储费另行核算
        VendorId::Gemini => Some(CacheTtl::Short),
        // Glm：自动缓存"有合理时限"（vendor-cache-mechanisms.md:58），按 300s
        VendorId::Glm => Some(CacheTtl::Short),
        // Qwen：官方直连缓存行为未实测（T-19 矩阵 QWEN 行保守全关、default_ttl
        // None；P3 §3.5 表未单列）→ 保守 None；百炼通道经 catalog 条目
        // cache_ttl="5m" 覆盖生效（内置 qwen3 系条目）
        VendorId::Qwen => None,
        // Dashscope（百炼）：显式缓存 5 分钟、命中重置（vendor-cache-gaps.md:23）
        VendorId::Dashscope => Some(CacheTtl::Short),
        // Auto / 未识别网关：不支持前缀缓存 → 永不预警（jcode 2794-2796）
        VendorId::Auto => None,
    }
}

/// OpenAI 默认档：Short；gpt-5.5 及更早扩展保留模型 → Day(24h)；
/// **gpt-5.6 除外**（TTL 仅 30m，不入 24h 档，A1-11 / 00-catalog §2.1）——
/// v2 Schema 扩档后 30m 有明确档位（CacheTtl::HalfHour），不再按 5m 保守预警
/// （03-catalog-v2-schema.md §5.2 要点，销账 ttl.rs:93-97 旧注释）。
fn openai_default_ttl(model: &str) -> Option<CacheTtl> {
    if model.starts_with("gpt-5.6") {
        return Some(CacheTtl::HalfHour);
    }
    if is_openai_extended_retention(model) {
        Some(CacheTtl::Day)
    } else {
        Some(CacheTtl::Short)
    }
}

/// OpenAI 24h extended 保留模型前缀（P3 §3.5 / A1-11 修正清单）：
/// gpt-5.5 / 5.4 / 5.2 / 5.1 系列与 gpt-5（00-catalog §2.1 另列 gpt-4.1，
/// 不在 P3 修正清单内，保守不入 24h 档，可由 catalog 条目显式开启）
fn is_openai_extended_retention(model: &str) -> bool {
    model == "gpt-5"
        || model.starts_with("gpt-5.5")
        || model.starts_with("gpt-5.4")
        || model.starts_with("gpt-5.2")
        || model.starts_with("gpt-5.1")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// CacheTtl 契约：秒数（300/1800/3600/86400）+ 值域字符串 + serde 往返
    /// （枚举本体与 parse 由 T-19 behavior.rs 的 cache_ttl_serde_values_and_seconds
    /// 测试钉死；本测试补 as_str 与反序列化往返，含 v2 新增 30m 档）
    #[test]
    fn cache_ttl_buckets_seconds_and_serde_values() {
        assert_eq!(CacheTtl::Short.seconds(), 300);
        assert_eq!(CacheTtl::HalfHour.seconds(), 1800);
        assert_eq!(CacheTtl::Hour.seconds(), 3600);
        assert_eq!(CacheTtl::Day.seconds(), 86400);
        assert_eq!(CacheTtl::Short.as_str(), "5m");
        assert_eq!(CacheTtl::HalfHour.as_str(), "30m");
        assert_eq!(CacheTtl::Hour.as_str(), "1h");
        assert_eq!(CacheTtl::Day.as_str(), "24h");
        for ttl in [
            CacheTtl::Short,
            CacheTtl::HalfHour,
            CacheTtl::Hour,
            CacheTtl::Day,
        ] {
            let json = serde_json::to_string(&ttl).expect("CacheTtl 必须可序列化");
            assert_eq!(json, format!("\"{}\"", ttl.as_str()));
            let roundtrip: CacheTtl = serde_json::from_str(&json).expect("必须可反序列化");
            assert_eq!(roundtrip, ttl);
        }
    }

    /// 每 vendor 默认档断言（无 catalog 时；Qwen/Auto → None）
    #[test]
    fn vendor_defaults_without_catalog() {
        let ttl = |vendor: VendorId, model: &str| cache_ttl_for_provider_model(None, vendor, model);
        assert_eq!(
            ttl(VendorId::Deepseek, "deepseek-v4-flash"),
            Some(CacheTtl::Short)
        );
        assert_eq!(
            ttl(VendorId::Anthropic, "claude-sonnet-5"),
            Some(CacheTtl::Short)
        );
        assert_eq!(ttl(VendorId::Kimi, "kimi-k3"), Some(CacheTtl::Short));
        assert_eq!(ttl(VendorId::Grok, "grok-4.5"), Some(CacheTtl::Short));
        assert_eq!(
            ttl(VendorId::MiniMax, "minimax-m2-7"),
            Some(CacheTtl::Short)
        );
        assert_eq!(
            ttl(VendorId::Gemini, "gemini-3-6-flash"),
            Some(CacheTtl::Short)
        );
        assert_eq!(ttl(VendorId::Glm, "glm-5"), Some(CacheTtl::Short));
        assert_eq!(ttl(VendorId::Dashscope, "qwen3-max"), Some(CacheTtl::Short));
        // Qwen 官方直连未实测 → 保守 None（与 T-19 矩阵 QWEN 行一致）
        assert_eq!(ttl(VendorId::Qwen, "qwen3-max"), None);
        // Auto → None
        assert_eq!(ttl(VendorId::Auto, "anything"), None);
    }

    /// OpenAI 分档（A1-11 / v2 Schema §5.2）：gpt-5.5 及更早扩展保留 → Day；
    /// **gpt-5.6 仅 30m TTL** → HalfHour（v2 扩档后不再按 5m 保守预警）；其余
    /// OpenAI 模型 → Short
    #[test]
    fn openai_ttl_tiers_gpt55_day_gpt56_half_hour() {
        let ttl = |model: &str| cache_ttl_for_provider_model(None, VendorId::Openai, model);
        // gpt-5.6 及同族 → HalfHour（30m 档）
        assert_eq!(ttl("gpt-5.6"), Some(CacheTtl::HalfHour));
        assert_eq!(ttl("gpt-5.6-mini"), Some(CacheTtl::HalfHour));
        // gpt-5.5 及更早扩展保留模型 → Day(24h)
        assert_eq!(ttl("gpt-5.5"), Some(CacheTtl::Day));
        assert_eq!(ttl("gpt-5.5-preview"), Some(CacheTtl::Day));
        assert_eq!(ttl("gpt-5.4"), Some(CacheTtl::Day));
        assert_eq!(ttl("gpt-5.2"), Some(CacheTtl::Day));
        assert_eq!(ttl("gpt-5.1"), Some(CacheTtl::Day));
        assert_eq!(ttl("gpt-5"), Some(CacheTtl::Day));
        // 其余 OpenAI 模型 → Short
        assert_eq!(ttl("gpt-4o"), Some(CacheTtl::Short));
        assert_eq!(ttl("o3"), Some(CacheTtl::Short));
    }

    /// None 语义：Auto 与未识别网关 → None（永不预警）
    #[test]
    fn auto_and_unknown_vendor_yield_none() {
        let ttl = |model: &str| cache_ttl_for_provider_model(None, VendorId::Auto, model);
        assert_eq!(ttl("anything"), None);
        assert_eq!(ttl("gpt-5.5"), None);
        assert_eq!(ttl(""), None);
    }

    /// catalog 覆盖生效：内置目录条目 cache_ttl 优先于 vendor 默认
    ///
    /// 内置数据（T-18 转录，00-catalog 口径）：openai::gpt-5.5 → "24h"、
    /// openai::gpt-5.6 无 cache_ttl、deepseek 全系 → "5m"、kimi-k3 / qwen3-max
    /// → "5m"。
    #[test]
    fn catalog_entry_overrides_vendor_default() {
        let catalog = ModelCatalog::bundled();
        // 目录条目值路径：gpt-5.5 cacheTtl="24h" → Day
        assert_eq!(
            cache_ttl_for_provider_model(Some(&catalog), VendorId::Openai, "gpt-5.5"),
            Some(CacheTtl::Day)
        );
        // 目录条目无 cache_ttl（gpt-5.6）→ 回退 vendor 默认 HalfHour（30m 档，
        // v2 扩档后不再按 5m 保守预警）
        assert_eq!(
            cache_ttl_for_provider_model(Some(&catalog), VendorId::Openai, "gpt-5.6"),
            Some(CacheTtl::HalfHour)
        );
        // deepseek 条目 cacheTtl="5m" → Short（路径仍经目录解析）
        assert_eq!(
            cache_ttl_for_provider_model(Some(&catalog), VendorId::Deepseek, "deepseek-v4-flash"),
            Some(CacheTtl::Short)
        );
        // kimi-k3 条目 cacheTtl="5m" → Short
        assert_eq!(
            cache_ttl_for_provider_model(Some(&catalog), VendorId::Kimi, "kimi-k3"),
            Some(CacheTtl::Short)
        );
        // qwen3-max：vendor 默认 None，目录条目 "5m" 覆盖 → Short（覆盖优先级钉死）
        assert_eq!(
            cache_ttl_for_provider_model(Some(&catalog), VendorId::Qwen, "qwen3-max"),
            Some(CacheTtl::Short)
        );
        // 目录未收录模型 → 回退 vendor 默认（OpenAI 扩展保留前缀仍命中 24h；
        // Qwen 未知模型保守 None，与 T-19 矩阵一致）
        assert_eq!(
            cache_ttl_for_provider_model(Some(&catalog), VendorId::Openai, "gpt-5.2-x"),
            Some(CacheTtl::Day)
        );
        assert_eq!(
            cache_ttl_for_provider_model(Some(&catalog), VendorId::Qwen, "qwen-future-model"),
            None
        );
        assert_eq!(
            cache_ttl_for_provider_model(Some(&catalog), VendorId::Grok, "grok-9"),
            Some(CacheTtl::Short)
        );
    }
}
