//! 模型级缓存 TTL 决议（单一纯函数；plans/03 §2.2 · 裁决 N7）
//!
//! - [CacheTtl]：缓存 TTL 四档（5m / 30m / 1h / 24h；v2 Schema 扩 "30m" 档承载
//!   gpt-5.6 系）。**定义在 behavior.rs（T-19 交付）**，本模块按 T-19 的模块内
//!   约定 re-export（"TTL 路由表（T-21 models/ttl.rs）如需本类型应 re-export
//!   而非重定义，避免同 crate 两套同名枚举漂移"）；任务书要求的 `as_str()` 由本
//!   模块的固有 impl 补全（同 crate 允许在其他模块内扩展固有方法）。
//! - [cache_ttl_for_declared_model]：**唯一** TTL 决议纯函数。
//!
//! ## 唯一来源（N7 / 00-总方案 §8 剧本 4）
//!
//! 缓存 TTL 只认**用户 yaml 的 `cacheTtl` 声明**（经 `ModelsStore` 已提交树
//! 投影进 `ModelCatalogEntry.cache_ttl`）：
//!
//! - 命中且值域合法 → `Some(档位)`；
//! - 未收录 / 无 `cacheTtl` / 值域非法 → `None` = **不追踪缓存**（fail-closed）。
//!
//! **禁止**回落内置 `catalog.json`（`bundled_catalog()`）或任何厂商 / 模型名前缀
//! 推断表——字典不得替用户决定 TTL。原 `vendor_default_ttl` /
//! `openai_default_ttl` / `is_openai_extended_retention` 硬编码表已物理删除。
//!
//! 消费方：冷缓存预警（P5 测量层，`engine_build::build_cache_tracking_config`）、
//! 摘要请求缓存隔离（P4 压缩层）。
//! 与行为矩阵的分工：behavior.rs 的 `CacheBehavior::default_ttl` 是注入框架的
//! 决策输入（C2 数据真源）；本函数是 yaml 声明面的唯一决议。

pub use super::behavior::CacheTtl;
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

/// 缓存 TTL 唯一决议（**单一纯函数**：无 IO、无全局态、无兜底表）。
///
/// - `catalog` 必须是 **live 树投影**（`LiveModels.catalog`，由 `ModelsStore`
///   已提交树派生）——传 `ModelCatalog::bundled()` 即等于把字典当 TTL 真源，
///   属 N7 禁止项；
/// - 条目 `cache_ttl` 值域为 "5m"/"30m"/"1h"/"24h"（v2 四档），无法识别的值
///   防御性忽略（[CacheTtl::parse] → `None`）；
/// - 未收录 / 未声明 / 值域非法 → `None`：**不追踪缓存**（fail-closed），
///   调用方必须据此关闭缓存测量，禁止凭空推断 TTL。
pub fn cache_ttl_for_declared_model(
    catalog: &ModelCatalog,
    provider_id: &str,
    model: &str,
) -> Option<CacheTtl> {
    catalog
        .lookup(provider_id, model)?
        .cache_ttl
        .as_deref()
        .and_then(CacheTtl::parse)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::LiveModels;

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

    /// 旧 vendor 默认表的**同一供应商矩阵**反转断言：无 `cacheTtl` 声明时，
    /// 任何厂商（含旧表内 8 家 + 未识别网关）都**不得**推出 TTL（N7 fail-closed）。
    /// 该用例接替被废止的 `vendor_defaults_without_catalog`，覆盖面不减。
    #[test]
    fn every_vendor_fails_closed_without_declaration() {
        let yaml = r#"
version: 2
providers:
  deepseek:
    models: [{ id: deepseek-v4-flash }]
  anthropic:
    models: [{ id: claude-sonnet-5 }]
  openai:
    models: [{ id: gpt-5.6 }, { id: gpt-5.5 }, { id: gpt-5 }, { id: gpt-4o }, { id: o3 }]
  kimi:
    models: [{ id: kimi-k3 }]
  grok:
    models: [{ id: grok-4.5 }]
  minimax:
    models: [{ id: minimax-m2-7 }]
  gemini:
    models: [{ id: gemini-3-6-flash }]
  glm:
    models: [{ id: glm-5 }]
  qwen:
    models: [{ id: qwen3-max }]
  dashscope:
    models: [{ id: qwen3-max }]
  auto:
    models: [{ id: anything }]
"#;
        let live = LiveModels::from_yaml_str(yaml).expect("v2 yaml 必须解析成功");
        for (provider, model) in [
            ("deepseek", "deepseek-v4-flash"),
            ("anthropic", "claude-sonnet-5"),
            ("openai", "gpt-5.6"),
            ("openai", "gpt-5.5"),
            ("openai", "gpt-5"),
            ("openai", "gpt-4o"),
            ("openai", "o3"),
            ("kimi", "kimi-k3"),
            ("grok", "grok-4.5"),
            ("minimax", "minimax-m2-7"),
            ("gemini", "gemini-3-6-flash"),
            ("glm", "glm-5"),
            ("qwen", "qwen3-max"),
            ("dashscope", "qwen3-max"),
            ("auto", "anything"),
        ] {
            assert_eq!(
                cache_ttl_for_declared_model(&live.catalog, provider, model),
                None,
                "yaml 未声明 cacheTtl 时 {provider}::{model} 必须 fail-closed（不追踪缓存）"
            );
        }
        // 零命中同样 fail-closed
        assert_eq!(
            cache_ttl_for_declared_model(&live.catalog, "deepseek", "no-such-model"),
            None
        );
    }

    /// 用户声明是唯一来源：声明 "5m"/"30m"/"1h"/"24h" 四档逐一透传。
    #[test]
    fn declaration_is_the_only_ttl_source() {
        let yaml = r#"
version: 2
providers:
  acme:
    models:
      - id: m-short
        cacheTtl: "5m"
      - id: m-half-hour
        cacheTtl: "30m"
      - id: m-hour
        cacheTtl: "1h"
      - id: m-day
        cacheTtl: "24h"
      - id: m-undeclared
"#;
        let live = LiveModels::from_yaml_str(yaml).expect("v2 yaml 必须解析成功");
        let ttl = |model: &str| cache_ttl_for_declared_model(&live.catalog, "acme", model);
        assert_eq!(ttl("m-short"), Some(CacheTtl::Short));
        assert_eq!(ttl("m-half-hour"), Some(CacheTtl::HalfHour));
        assert_eq!(ttl("m-hour"), Some(CacheTtl::Hour));
        assert_eq!(ttl("m-day"), Some(CacheTtl::Day));
        assert_eq!(ttl("m-undeclared"), None, "未声明档位 → 不追踪缓存");
    }

    /// 值域非法 → **解析边界**显式拒绝（fail-closed 第一道闸），
    /// 非法值不得以「静默忽略」的形式进入已提交树。
    ///
    /// 说明：`cache_ttl_for_declared_model` 内部的「无法识别 → None」分支属
    /// 纵深防御（`from_unified` 的 `normalize_for_commit` 已先校验），因此
    /// 该分支在公开构造路径上不可达——本测试钉住**可达**的那道闸。
    #[test]
    fn invalid_declaration_fails_closed() {
        for illegal in ["banana", "", "7h", "1H", "60m"] {
            let yaml = format!(
                "version: 2\nproviders:\n  acme:\n    models:\n      - id: m-bad\n        cacheTtl: \"{illegal}\"\n"
            );
            let err = LiveModels::from_yaml_str(&yaml)
                .expect_err(&format!("cacheTtl=`{illegal}` 必须在解析期被拒绝"));
            assert!(
                err.contains("cacheTtl"),
                "拒绝信息必须指名 cacheTtl（实际：{err}）"
            );
        }
    }

    /// §8 剧本 4 的内核级断言：内置字典**确有**该模型 TTL，但 yaml 未声明时
    /// 决议必须是 `None`——即内置字典不构成 TTL 第二来源。
    #[test]
    fn undeclared_yaml_yields_none_even_though_bundled_catalog_has_a_value() {
        let bundled = ModelCatalog::bundled();
        // 从内置字典里取**第一条确有 cache_ttl 的条目**（不写死具体模型，
        // 避免字典更新后前置失效；若无任何条目带 TTL 则本断言失去鉴别力）。
        let (provider, model) = bundled
            .iter_entries()
            .find(|(_, entry)| entry.cache_ttl.is_some())
            .map(|(_, entry)| (entry.provider.clone(), entry.model.clone()))
            .expect("前置：内置字典应至少有一条带 cache_ttl 的条目");

        let live = LiveModels::from_yaml_str(&format!(
            "version: 2\nproviders:\n  {provider}:\n    models:\n      - id: {model}\n"
        ))
        .expect("v2 yaml 必须解析成功");
        assert_eq!(
            cache_ttl_for_declared_model(&live.catalog, &provider, &model),
            None,
            "yaml 未声明 cacheTtl → 不追踪缓存，禁止回落内置字典"
        );
    }
}
