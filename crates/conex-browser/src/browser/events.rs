//! 进程管理事件面（维度 10 §9 事件 / §7.3 前端零暴露）
//!
//! - `browser://state-changed` 只携带状态/restarts/后端摘要/错误文本——**不含端点**
//!   （端口/WS path/token 永不进事件，§7.3 硬要求）；
//! - `browser://crash-restarting` 携带 restarts/原因/导航栈标签数；
//! - `browser://nav-stack-changed` 携带标签 URL 序（供面板与维度 15 消费）。
//!
//! 事件经维度 11 事件总线同前缀广播（Tauri emit 桥 `browser://*` 命名空间合并）。
//!
//! 锁纪律（31-security-baseline B8）：本模块无锁；结构体字段不含敏感面。

use crate::browser::discover::BackendResolution;
use crate::browser::nav_stack::TabEntry;
use crate::browser::state::{BrowserState, CrashReason};

/// 进程生命周期事件（订阅面）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProcessEvent {
    /// `browser://state-changed`：状态迁移广播（不含端点）。
    StateChanged {
        state: BrowserState,
        restarts: u8,
        /// 后端摘要（provenance 供维度 17 差异策略；仅含来源与版本，无路径细节）。
        backend: Option<BackendResolution>,
        /// 终态错误文本（GiveUp/CrashAbort 时携带；诊断面，已脱敏）。
        error: Option<String>,
    },
    /// `browser://crash-restarting`：崩溃重启广播。
    CrashRestarting {
        restarts: u8,
        reason: CrashReason,
        /// 冻结时的导航栈标签数（恢复编排归维度 15，U-7）。
        nav_tabs: usize,
    },
    /// `browser://nav-stack-changed`：导航栈变更广播（维度 11 回写后触发）。
    NavStackChanged { tabs: Vec<TabEntry>, active: usize },
}

impl ProcessEvent {
    /// 后端摘要（doctor/面板展示：`CfT(151.0.7922.77)` / `SystemChrome` / `SystemEdge`）。
    pub fn backend_summary(&self) -> Option<String> {
        match self {
            ProcessEvent::StateChanged {
                backend: Some(b), ..
            } => Some(b.summary()),
            _ => None,
        }
    }
}

impl BackendResolution {
    /// 展示摘要（来源 + 版本；不暴露路径）。
    pub fn summary(&self) -> String {
        use crate::browser::discover::Backend;
        match &self.backend {
            Backend::ChromeForTesting { version, .. } => format!("CfT({version})"),
            Backend::SystemChrome { .. } => "SystemChrome".to_string(),
            Backend::SystemEdge { .. } => "SystemEdge".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::discover::Backend;
    use std::path::PathBuf;

    /// 事件面零敏感：StateChanged 不携带端点/路径细节。
    #[test]
    fn state_changed_no_endpoint() {
        let ev = ProcessEvent::StateChanged {
            state: BrowserState::Running,
            restarts: 0,
            backend: Some(BackendResolution {
                backend: Backend::SystemChrome {
                    path: PathBuf::from("C:\\secret\\chrome.exe"),
                },
                probes: vec![],
            }),
            error: None,
        };
        let debug = format!("{ev:?}");
        assert!(!debug.contains("secret"), "Debug 不得含二进制路径：{debug}");
        assert!(debug.contains("SystemChrome"));
        assert_eq!(ev.backend_summary().as_deref(), Some("SystemChrome"));
    }

    /// 后端摘要：CfT 版本 / Edge 来源。
    #[test]
    fn backend_summaries() {
        let cft = BackendResolution {
            backend: Backend::ChromeForTesting {
                version: "151.0.7922.77".to_string(),
                path: PathBuf::from("x"),
            },
            probes: vec![],
        };
        assert_eq!(cft.summary(), "CfT(151.0.7922.77)");
        let edge = BackendResolution {
            backend: Backend::SystemEdge {
                path: PathBuf::from("x"),
            },
            probes: vec![],
        };
        assert_eq!(edge.summary(), "SystemEdge");
    }

    /// 崩溃事件携带导航栈规模（恢复编排锚点）。
    #[test]
    fn crash_restarting_carries_nav_count() {
        let ev = ProcessEvent::CrashRestarting {
            restarts: 2,
            reason: CrashReason::ProcessExit(1),
            nav_tabs: 3,
        };
        assert!(matches!(
            ev,
            ProcessEvent::CrashRestarting {
                restarts: 2,
                nav_tabs: 3,
                ..
            }
        ));
    }
}
