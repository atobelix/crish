//! BrowserTargetGate —— `ActionTargetGate` 浏览器线实现（05 文档 §5.2，纯加法）
//!
//! 委托既有 `DomainGate`（action/gate.rs：R-7 唯一权威声明不动）：
//! - `ActionTarget::Url` → `gate.check(url)`，拒绝映射为
//!   `TargetDenialKind::Whitelist`（白名单外语义，05 文档 §5.2 行）；
//! - `ActionTarget::Window` → `TargetDenialKind::Other`「目标类型不适用」——
//!   窗口目标是电脑操作（桌面线）专用形态，浏览器侧无窗口概念。
//!
//! 不替换 `ActionExecutor::run_once` 既有检查点（action/mod.rs:393-399）：
//! 本门禁仅服务共享层消费者与对等测试（05 文档 §6.2 项 3，方案 A 裁决）。

use std::sync::Arc;

use conex_shared::gate::{ActionTarget, ActionTargetGate, TargetDenial, TargetDenialKind};

use crate::action::gate::DomainGate;

/// 动作前检查器（浏览器线）：委托既有 `DomainGate` 的共享层入口。
pub struct BrowserTargetGate {
    gate: Arc<dyn DomainGate>,
}

impl BrowserTargetGate {
    /// 新建（既有 `DomainGate` 实现注入——引擎侧唯一权威 MvpDomainGate）。
    pub fn new(gate: Arc<dyn DomainGate>) -> Self {
        BrowserTargetGate { gate }
    }

    /// 内部门禁引用（诊断/测试面）。
    pub fn gate(&self) -> &Arc<dyn DomainGate> {
        &self.gate
    }
}

impl ActionTargetGate for BrowserTargetGate {
    fn check(&self, target: &ActionTarget) -> Result<(), TargetDenial> {
        match target {
            ActionTarget::Url(url) => self.gate.check(url).map_err(|d| TargetDenial {
                kind: TargetDenialKind::Whitelist,
                target: d.url,
                reason: d.reason,
            }),
            // 电脑操作侧专用形态：浏览器线无窗口概念，目标类型不适用
            ActionTarget::Window { title, process } => Err(TargetDenial {
                kind: TargetDenialKind::Other,
                target: match process {
                    Some(p) => format!("{title} ({p})"),
                    None => title.clone(),
                },
                reason: "浏览器线无窗口概念（电脑操作侧专用）：目标类型不适用".to_string(),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::action::mocks::{AllowGate, DenyGate};
    use conex_shared::gate::{ActionTarget, ActionTargetGate, TargetDenialKind};

    /// Url 目标委托放行面：内部门禁 Ok → Ok。
    #[test]
    fn url_allowed_delegates_ok() {
        let gate = BrowserTargetGate::new(Arc::new(AllowGate));
        assert!(gate
            .check(&ActionTarget::Url("https://example.com".to_string()))
            .is_ok());
    }

    /// Url 目标拒绝映射：DomainGate 拒绝 → Whitelist 分类 + 目标串/原因保留。
    #[test]
    fn url_denied_maps_whitelist_kind() {
        let gate =
            BrowserTargetGate::new(Arc::new(DenyGate::new(vec!["evil.example".to_string()])));
        let err = gate
            .check(&ActionTarget::Url("https://evil.example.com".to_string()))
            .expect_err("应拒绝");
        assert_eq!(err.kind, TargetDenialKind::Whitelist);
        assert_eq!(err.target, "https://evil.example.com");
        assert!(
            err.reason.contains("黑名单命中"),
            "原因透传：{}",
            err.reason
        );
    }

    /// Window 形态：目标类型不适用（Other），展示串为「标题 (进程)」。
    #[test]
    fn window_target_unsupported() {
        let gate = BrowserTargetGate::new(Arc::new(AllowGate));
        let err = gate
            .check(&ActionTarget::Window {
                title: "记事本".to_string(),
                process: Some("notepad.exe".to_string()),
            })
            .expect_err("窗口形态应不适用");
        assert_eq!(err.kind, TargetDenialKind::Other);
        assert_eq!(err.target, "记事本 (notepad.exe)");
        assert!(err.reason.contains("无窗口概念"));

        // 进程名可空（仅标题）
        let err = gate
            .check(&ActionTarget::Window {
                title: "任务管理器".to_string(),
                process: None,
            })
            .expect_err("应不适用");
        assert_eq!(err.target, "任务管理器");
    }

    /// 对象安全 + Send + Sync（共享层消费面 trait 对象装箱）。
    #[test]
    fn object_safe_and_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<Box<dyn ActionTargetGate>>();

        let gate: Box<dyn ActionTargetGate> = Box::new(BrowserTargetGate::new(Arc::new(AllowGate)));
        assert!(gate
            .check(&ActionTarget::Url("https://a.example".to_string()))
            .is_ok());
        assert!(gate
            .check(&ActionTarget::Window {
                title: "x".to_string(),
                process: None,
            })
            .is_err());
    }
}
