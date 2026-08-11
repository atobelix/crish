//! 动作前检查点抽象（05 文档 §5 定稿；两线各一实现）。
//!
//! - 浏览器线 `BrowserTargetGate`：`Url` 分支委托既有 `DomainGate`
//!   （错误映射 `TargetDenialKind::Whitelist`），`Window` 分支返回不适用；
//!   不替换 `ActionExecutor::run_once` 既有检查点（action/mod.rs:393-399）；
//! - 桌面线 `WindowTargetGate`：窗口白名单 + 提权探测
//!   （提权 → `TargetDenialKind::Elevated`，语义 `tool.computer.elevated_window`）。
//!
//! 检查点在审批之前（04 文档 §4.6 守卫次序）。

/// 动作目标（检查点输入）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionTarget {
    /// 浏览器线：目标页面 URL（既有 DomainGate 检查点输入）。
    Url(String),
    /// 桌面线：目标窗口（标题 + 进程名；进程名可空 = 仅标题匹配，
    /// 04 文档 §4 白名单窗口）。
    Window {
        title: String,
        process: Option<String>,
    },
}

/// 拒绝分类（工具层错误码映射面）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetDenialKind {
    /// 白名单外（浏览器线域名门禁 / 桌面线窗口白名单）。
    Whitelist,
    /// 提权窗口（桌面线 R3 → tool.computer.elevated_window）。
    Elevated,
    /// 其它（目标类型不适用 / 未接线等）。
    Other,
}

/// 动作目标拒绝（检查结果载荷，审计消费面）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TargetDenial {
    /// 拒绝分类
    pub kind: TargetDenialKind,
    /// 被拒绝目标的展示串（URL 或「标题 (进程)」，审计载荷用）
    pub target: String,
    /// 拒绝原因
    pub reason: String,
}

/// 动作前检查点（两线各一实现；检查点在审批**之前**，04 文档 §4.6 守卫次序）。
pub trait ActionTargetGate: Send + Sync {
    /// 检查动作目标；通过返回 Ok，拒绝返回 Err(TargetDenial)。
    fn check(&self, target: &ActionTarget) -> Result<(), TargetDenial>;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// mock 门禁：构造期指定拒绝载荷；未指定时放行（简化：不区分目标）
    struct MockGate {
        denial: Option<TargetDenial>,
    }

    impl ActionTargetGate for MockGate {
        fn check(&self, _target: &ActionTarget) -> Result<(), TargetDenial> {
            match &self.denial {
                Some(denial) => Err(denial.clone()),
                None => Ok(()),
            }
        }
    }

    #[test]
    fn action_target_serde_roundtrip() {
        let url = ActionTarget::Url("https://example.com".to_string());
        let json = serde_json::to_string(&url).expect("序列化失败");
        assert_eq!(json, r#"{"url":"https://example.com"}"#);
        assert_eq!(
            serde_json::from_str::<ActionTarget>(&json).expect("反序列化失败"),
            url
        );

        let win = ActionTarget::Window {
            title: "记事本".to_string(),
            process: Some("notepad.exe".to_string()),
        };
        let json = serde_json::to_string(&win).expect("序列化失败");
        assert_eq!(
            json,
            r#"{"window":{"title":"记事本","process":"notepad.exe"}}"#
        );
        assert_eq!(
            serde_json::from_str::<ActionTarget>(&json).expect("反序列化失败"),
            win
        );

        // 进程名可空（仅标题匹配）
        let win_no_proc = ActionTarget::Window {
            title: "任务管理器".to_string(),
            process: None,
        };
        assert_eq!(
            serde_json::from_str::<ActionTarget>(
                &serde_json::to_string(&win_no_proc).expect("序列化失败")
            )
            .expect("反序列化失败"),
            win_no_proc
        );
    }

    #[test]
    fn target_denial_kind_serde_roundtrip() {
        for (kind, name) in [
            (TargetDenialKind::Whitelist, "whitelist"),
            (TargetDenialKind::Elevated, "elevated"),
            (TargetDenialKind::Other, "other"),
        ] {
            assert_eq!(
                serde_json::to_string(&kind).expect("序列化失败"),
                format!("\"{name}\"")
            );
            assert_eq!(
                serde_json::from_str::<TargetDenialKind>(&format!("\"{name}\""))
                    .expect("反序列化失败"),
                kind
            );
        }
    }

    #[test]
    fn target_denial_serde_roundtrip() {
        let denial = TargetDenial {
            kind: TargetDenialKind::Elevated,
            target: "系统设置 (SystemSettings.exe)".to_string(),
            reason: "提权窗口拒绝（tool.computer.elevated_window）".to_string(),
        };
        let json = serde_json::to_string(&denial).expect("序列化失败");
        assert_eq!(
            serde_json::from_str::<TargetDenial>(&json).expect("反序列化失败"),
            denial
        );
    }

    #[test]
    fn action_target_gate_object_safe_and_smoke() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<Box<dyn ActionTargetGate>>();

        // 放行面
        let allow: Box<dyn ActionTargetGate> = Box::new(MockGate { denial: None });
        assert!(allow
            .check(&ActionTarget::Url("https://example.com".to_string()))
            .is_ok());

        // 白名单拒绝面（浏览器线 DomainGate 错误映射语义）
        let deny: Box<dyn ActionTargetGate> = Box::new(MockGate {
            denial: Some(TargetDenial {
                kind: TargetDenialKind::Whitelist,
                target: "https://evil.example.com".to_string(),
                reason: "域名不在白名单".to_string(),
            }),
        });
        let err = deny
            .check(&ActionTarget::Url("https://evil.example.com".to_string()))
            .expect_err("应拒绝");
        assert_eq!(err.kind, TargetDenialKind::Whitelist);
        assert_eq!(err.target, "https://evil.example.com");
        assert_eq!(err.reason, "域名不在白名单");
    }

    #[test]
    fn action_target_gate_elevated_window_denial() {
        // 提权拒绝面（桌面线 R3 → tool.computer.elevated_window 语义）
        let gate: Box<dyn ActionTargetGate> = Box::new(MockGate {
            denial: Some(TargetDenial {
                kind: TargetDenialKind::Elevated,
                target: "系统设置 (SystemSettings.exe)".to_string(),
                // reason 携带 tool.computer.elevated_window 语义（05 文档 §5.2 桌面线）
                reason: "目标窗口为提权进程，拒绝注入（tool.computer.elevated_window）".to_string(),
            }),
        });
        let err = gate
            .check(&ActionTarget::Window {
                title: "系统设置".to_string(),
                process: Some("SystemSettings.exe".to_string()),
            })
            .expect_err("应拒绝");
        assert_eq!(err.kind, TargetDenialKind::Elevated);
        assert!(err.reason.contains("tool.computer.elevated_window"));
    }
}
