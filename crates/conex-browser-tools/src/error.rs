//! 工具层错误构造与映射（维度 17 §1.3 码表消费面）
//!
//! 错误映射口径：
//! - `ActionError`（14 文档错误分类）→ `ToolError`（17 §1.3 码表 + 通用 tool.* 码），
//!   分类映射以 14 §5.1 表为权威（GateDenied → gate_blocked、ConnectionLost/
//!   TargetRestarting → not_ready、VersionInvalid → stale_snapshot、NodeStale →
//!   node_gone、Aborted → cancelled）；
//! - `CdpError` → `ToolError`（会话命令面，连接层错误归 not_ready/取消类）；
//! - `SnapshotError`（13 文档采集错误）→ `ToolError`（超时/版本竞态/采集失败）。

use crate::codes as browser_codes;
use agent_tools::definition::ToolError;
use conex_browser::action::{ActionError, ActionErrorKind};
use conex_browser::cdp::error::CdpError;
use conex_browser::snapshot::SnapshotError;
use conex_types::error::codes;

/// 恢复期/未注入会话的结构化错误（17 §1.3 `tool.browser.not_ready`）。
pub fn not_ready(reason: impl Into<String>) -> ToolError {
    ToolError::new(browser_codes::TOOL_BROWSER_NOT_READY, reason)
}

/// 域名门禁拦截（17 §1.3 `tool.browser.gate_blocked`；消息附 URL 与命中原因）。
pub fn gate_blocked(url: &str, reason: &str) -> ToolError {
    ToolError::new(
        browser_codes::TOOL_BROWSER_GATE_BLOCKED,
        format!("门禁拦截 {url}：{reason}"),
    )
}

/// 默认拒绝面未开启（17 §2.3 `tool.browser.capability_disabled`，红线语义）。
pub fn capability_disabled(capability: &str) -> ToolError {
    ToolError::new(
        browser_codes::TOOL_BROWSER_CAPABILITY_DISABLED,
        format!("{capability} 能力位未开启（默认拒绝，17 §2.3；需用户经会话设置显式授权）"),
    )
}

/// 急停/取消（17 §6.4 ① `tool.browser.cancelled`）。
pub fn cancelled() -> ToolError {
    ToolError::new(
        browser_codes::TOOL_BROWSER_CANCELLED,
        "已急停（AI 操作中止）",
    )
}

/// 快照版本失效（17 §1.3 `tool.browser.stale_snapshot`，模型应重快照）。
pub fn stale_snapshot(message: impl Into<String>) -> ToolError {
    ToolError::new(browser_codes::TOOL_BROWSER_STALE_SNAPSHOT, message)
}

/// 元素过期（17 §1.3 `tool.browser.node_gone`）。
pub fn node_gone(message: impl Into<String>) -> ToolError {
    ToolError::new(browser_codes::TOOL_BROWSER_NODE_GONE, message)
}

/// MVP 边界未接线（`tool.browser.unwired`，P1 落地后替换为真实路径）。
pub fn unwired(what: impl Into<String>) -> ToolError {
    ToolError::new(
        browser_codes::TOOL_BROWSER_UNWIRED,
        format!("{}未接线（MVP 边界，P1 落地）", what.into()),
    )
}

/// `ActionError` → `ToolError`（14 §5.1 错误分类 → 17 §1.3 码表）。
pub fn map_action_error(tool_name: &str, err: ActionError) -> ToolError {
    let mut message = err.message.clone();
    if err.escalate {
        // T-10：NodeStale 重试耗尽升级提示（用户可确认后继续或中止）
        message.push_str("（节点定位失败：可携最新快照重试或中止）");
    }
    let code = match err.kind {
        ActionErrorKind::VersionInvalid => browser_codes::TOOL_BROWSER_STALE_SNAPSHOT,
        ActionErrorKind::NodeStale => browser_codes::TOOL_BROWSER_NODE_GONE,
        ActionErrorKind::GateDenied => browser_codes::TOOL_BROWSER_GATE_BLOCKED,
        ActionErrorKind::Aborted => browser_codes::TOOL_BROWSER_CANCELLED,
        // R-9：断线/重启恢复期工具面 gating
        ActionErrorKind::ConnectionLost | ActionErrorKind::TargetRestarting => {
            browser_codes::TOOL_BROWSER_NOT_READY
        }
        ActionErrorKind::ApprovalDenied => codes::APPROVAL_REJECTED,
        ActionErrorKind::InvalidInput => codes::TOOL_INVALID_INPUT,
        ActionErrorKind::Timeout
        | ActionErrorKind::TargetClosed
        | ActionErrorKind::ContextGone
        | ActionErrorKind::NotInteractive
        | ActionErrorKind::Unsupported => codes::TOOL_EXECUTION_FAILED,
    };
    ToolError::new(code, format!("工具 {tool_name} 执行失败：{message}"))
}

/// `CdpError` → `ToolError`（会话命令面错误映射）。
pub fn map_cdp_error(method: &str, err: CdpError) -> ToolError {
    let raw = err.to_string();
    let code = match &err {
        CdpError::ConnectionLost => browser_codes::TOOL_BROWSER_NOT_READY,
        CdpError::NotReady(_) => browser_codes::TOOL_BROWSER_NOT_READY,
        CdpError::NoActiveTab => browser_codes::TOOL_BROWSER_NOT_READY,
        CdpError::Cancelled { .. } => browser_codes::TOOL_BROWSER_CANCELLED,
        CdpError::ApprovalDenied { .. } => codes::APPROVAL_REJECTED,
        CdpError::BadParams { .. } | CdpError::Protocol { .. } => codes::TOOL_INVALID_INPUT,
        CdpError::Timeout { .. }
        | CdpError::Server { .. }
        | CdpError::Internal { .. }
        | CdpError::Serialize { .. }
        | CdpError::ContextGone { .. }
        | CdpError::DomainUnavailable { .. } => codes::TOOL_EXECUTION_FAILED,
    };
    ToolError::new(code, format!("CDP 命令失败[{method}]：{raw}"))
}

/// `SnapshotError` → `ToolError`（13 文档采集错误 → 17 §1.3 码表）。
pub fn map_snapshot_error(tool_name: &str, err: SnapshotError) -> ToolError {
    let code = match &err {
        // 采集窗口内版本推进/epoch 变化（M-5 事务化语义）→ 版本失效
        SnapshotError::Stale(_) | SnapshotError::CacheRollback { .. } => {
            browser_codes::TOOL_BROWSER_STALE_SNAPSHOT
        }
        SnapshotError::Timeout(_)
        | SnapshotError::Collect(_)
        | SnapshotError::Busy
        | SnapshotError::PayloadOverflow { .. } => codes::TOOL_EXECUTION_FAILED,
    };
    ToolError::new(code, format!("工具 {tool_name} 快照失败：{err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ActionErrorKind → 错误码全表映射（14 §5.1 + 17 §1.3 逐项回归）。
    #[test]
    fn action_error_kind_mapping_table() {
        let cases = [
            (
                ActionErrorKind::VersionInvalid,
                browser_codes::TOOL_BROWSER_STALE_SNAPSHOT,
            ),
            (
                ActionErrorKind::NodeStale,
                browser_codes::TOOL_BROWSER_NODE_GONE,
            ),
            (
                ActionErrorKind::GateDenied,
                browser_codes::TOOL_BROWSER_GATE_BLOCKED,
            ),
            (
                ActionErrorKind::Aborted,
                browser_codes::TOOL_BROWSER_CANCELLED,
            ),
            (
                ActionErrorKind::ConnectionLost,
                browser_codes::TOOL_BROWSER_NOT_READY,
            ),
            (
                ActionErrorKind::TargetRestarting,
                browser_codes::TOOL_BROWSER_NOT_READY,
            ),
            (ActionErrorKind::ApprovalDenied, codes::APPROVAL_REJECTED),
            (ActionErrorKind::InvalidInput, codes::TOOL_INVALID_INPUT),
            (ActionErrorKind::Timeout, codes::TOOL_EXECUTION_FAILED),
            (ActionErrorKind::TargetClosed, codes::TOOL_EXECUTION_FAILED),
            (ActionErrorKind::ContextGone, codes::TOOL_EXECUTION_FAILED),
            (
                ActionErrorKind::NotInteractive,
                codes::TOOL_EXECUTION_FAILED,
            ),
            (ActionErrorKind::Unsupported, codes::TOOL_EXECUTION_FAILED),
        ];
        for (kind, expected) in cases {
            let err = map_action_error("test", ActionError::new(kind, "样例"));
            assert_eq!(err.code(), expected, "映射不符：{kind:?} → {expected}");
        }
    }

    /// NodeStale 重试耗尽升级（T-10）附升级提示。
    #[test]
    fn escalation_hint_appended() {
        let mut err = ActionError::new(ActionErrorKind::NodeStale, "节点反复失效");
        err.escalate = true;
        let tool_err = map_action_error("browser_click", err);
        assert!(tool_err.to_string().contains("节点定位失败"));
        assert_eq!(tool_err.code(), browser_codes::TOOL_BROWSER_NODE_GONE);
    }

    /// 错误负载可序列化（IPC 出站面）。
    #[test]
    fn not_ready_payload_shape() {
        let err = not_ready("浏览器会话未注入");
        let payload = err.to_error_payload(0);
        assert_eq!(payload.code, "tool.browser.not_ready");
        // R-8 语义：恢复期可重试（注册表 Transient/retryable=true，R-9-2）
        assert!(payload.retryable);
        assert_eq!(err.code(), "tool.browser.not_ready");
    }

    /// CdpError 关键路径映射。
    #[test]
    fn cdp_error_mapping() {
        assert_eq!(
            map_cdp_error("m", CdpError::ConnectionLost).code(),
            browser_codes::TOOL_BROWSER_NOT_READY
        );
        assert_eq!(
            map_cdp_error("m", CdpError::NoActiveTab).code(),
            browser_codes::TOOL_BROWSER_NOT_READY
        );
        assert_eq!(
            map_cdp_error("m", CdpError::NotReady("重启中".to_string())).code(),
            browser_codes::TOOL_BROWSER_NOT_READY
        );
        assert_eq!(
            map_cdp_error(
                "m",
                CdpError::Cancelled {
                    reason: conex_browser::cdp::error::CancelReason::EmergencyStop
                }
            )
            .code(),
            browser_codes::TOOL_BROWSER_CANCELLED
        );
        assert_eq!(
            map_cdp_error(
                "m",
                CdpError::Timeout {
                    method: "m".into(),
                    elapsed: std::time::Duration::from_secs(1)
                }
            )
            .code(),
            codes::TOOL_EXECUTION_FAILED
        );
    }

    /// 快照错误映射。
    #[test]
    fn snapshot_error_mapping() {
        let stale = conex_browser::cdp::version::Stale {
            tab_id: "T1".to_string(),
            expected: 1,
            current: 2,
            epoch: 0,
        };
        assert_eq!(
            map_snapshot_error("browser_snapshot", SnapshotError::Stale(stale)).code(),
            browser_codes::TOOL_BROWSER_STALE_SNAPSHOT
        );
        assert_eq!(
            map_snapshot_error(
                "browser_snapshot",
                SnapshotError::Timeout(std::time::Duration::from_secs(12))
            )
            .code(),
            codes::TOOL_EXECUTION_FAILED
        );
    }
}
