//! 域名门禁检查点（维度 14 §7，gate.rs）
//!
//! **唯一权威声明（R-7）**：本模块只定义 `DomainGate` trait 引用与「未接线」兜底实现；
//! 结构与匹配语义以维度 17 §4 为唯一权威
//! 实现（`conex-browser/src/gate.rs`，**正式实现已落地**：`FormalDomainGate`，
//! R-11 含 60s 重绑定窗口复查与传输层 `Network.setBlockedURLs`，M7 接线位）。
//! 本维度保证**动作面**无白名单外执行路径。
//!
//! 检查点（§7.1 三重）：① 动作前（execute 首步，本 trait 检查点）；② 导航预检
//! （href 预匹配，17 §4.4 语义）；③ 动作后复核（新 URL host 复核，白名单外回退 +
//! GateDenied，mod.rs run_once 第⑥步）。

/// 门禁拒绝载荷（审计与错误消息共用）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GateDenial {
    /// 被拒绝的 URL
    pub url: String,
    /// 拒绝原因（命中规则/IP 段族，17 §4.3）
    pub reason: String,
}

/// 域名门禁接口（维度 17 §4 唯一实现；动作检查点消费面）。
///
/// `check` 对当前 URL 执行全流程校验：scheme 门禁 → IP 字面量判定 → 解析后网段校验
/// → 60s 重绑定窗口内每动作重复解析（17 §4.3 判定流程，R-11）。
pub trait DomainGate: Send + Sync {
    fn check(&self, url: &str) -> Result<(), GateDenial>;
}

/// 未接线兜底：引擎侧未注入维度 17 §4 实现时返回「未接线」结构化错误。
pub struct UnwiredGate;

impl DomainGate for UnwiredGate {
    fn check(&self, url: &str) -> Result<(), GateDenial> {
        Err(GateDenial {
            url: url.to_string(),
            reason: "域名门禁未接线：唯一实现以维度 17 §4 为准（M7 引擎侧注入 DomainGate）"
                .to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 未接线兜底返回结构化错误（executor 默认门禁面）。
    #[test]
    fn unwired_gate_denies_with_reason() {
        let gate = UnwiredGate;
        let denial = gate.check("https://example.com").expect_err("未接线应拒绝");
        assert!(denial.reason.contains("未接线"));
        assert_eq!(denial.url, "https://example.com");
    }

    /// trait 引用面：自定义门禁可注入（mocks 的 AllowGate/DenyGate 走同一 trait）。
    #[test]
    fn gate_trait_reference_works() {
        let gate: Box<dyn DomainGate> = Box::new(crate::action::mocks::AllowGate);
        assert!(gate.check("https://example.com").is_ok());
    }
}
