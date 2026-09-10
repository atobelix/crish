//! 工具层错误构造与映射（06 文档 §5 码表消费面；对齐浏览器线 error.rs 先例）。
//!
//! 映射口径：
//! - `SessionError`（conex-computer 会话错误）→ `ToolError`：`Action` 细分
//!   `tool.computer.invalid_params` / `tool.computer.coords_out_of_bounds`；
//!   `Gate`（动作前检查器拒绝）→ `tool.computer.elevated_window`（06 §4.2
//!   守卫⑥：白名单 / 提权统一码）；设备面（Inject/Capture/Init）→
//!   `tool.execution_failed`；
//! - `PerceptionError`（UIA 感知错误）→ `ToolError`：统一 `tool.execution_failed`
//!   （消息携带语义；06 §5 无感知专属码）；
//! - 审批拒绝（守卫⑤）→ `approval.rejected`（conex-types 既有码，浏览器线
//!   ActionErrorKind::ApprovalDenied 同源先例）。

use crate::codes;
use agent_tools::definition::ToolError;
use conex_computer::perception::PerceptionError;
use conex_computer::SessionError;
use conex_types::error::codes as shared_codes;

/// 会话未注入 / 恢复期 gating（06 §5 `tool.computer.not_ready`，Transient 可重试）。
pub fn not_ready(reason: impl Into<String>) -> ToolError {
    ToolError::new(codes::TOOL_COMPUTER_NOT_READY, reason)
}

/// 会话未开启 / 已挂起（06 §5 `tool.computer.not_enabled`，运行期准入拒绝）。
pub fn not_enabled(reason: impl Into<String>) -> ToolError {
    ToolError::new(codes::TOOL_COMPUTER_NOT_ENABLED, reason)
}

/// 会话互斥（06 §5 跨线共享码 `tool.session.exclusive`，S3 守卫②，审批前）。
pub fn exclusive(reason: impl Into<String>) -> ToolError {
    ToolError::new(codes::TOOL_SESSION_EXCLUSIVE, reason)
}

/// 中止 / 取消（06 §5 `tool.computer.cancelled`；会话级中止令牌触发，不计重试额度）。
pub fn cancelled() -> ToolError {
    ToolError::new(codes::TOOL_COMPUTER_CANCELLED, "已停止（AI 操作中止）")
}

/// 参数非法（06 §5 `tool.computer.invalid_params`，Permanent 修参重试）。
pub fn invalid_params(message: impl Into<String>) -> ToolError {
    ToolError::new(codes::TOOL_COMPUTER_INVALID_PARAMS, message)
}

/// 坐标越界（06 §5 `tool.computer.coords_out_of_bounds`；含 zoom region 越界）。
pub fn coords_out_of_bounds(message: impl Into<String>) -> ToolError {
    ToolError::new(codes::TOOL_COMPUTER_COORDS_OUT_OF_BOUNDS, message)
}

/// 提权 / 白名单窗口拒绝（06 §5 `tool.computer.elevated_window`；守卫⑥
/// ActionTargetGate 拒绝统一映射，不静默失败）。
pub fn elevated_window(message: impl Into<String>) -> ToolError {
    ToolError::new(codes::TOOL_COMPUTER_ELEVATED_WINDOW, message)
}

/// 审批拒绝（`approval.rejected` 为 conex-types 既有码，
/// 浏览器线 ApprovalDenied 同源，零注入语义；维度 1 收敛后电脑操作审批门
/// 已删除，本函数保留供其他消费方复用）。
#[allow(dead_code)]
pub fn approval_rejected(reason: impl Into<String>) -> ToolError {
    ToolError::new(shared_codes::APPROVAL_REJECTED, reason)
}

/// `SessionError` → `ToolError`（06 文档 §5 码表 + 通用 tool.* 码）。
pub fn map_session_error(tool_name: &str, err: SessionError) -> ToolError {
    let raw = err.to_string();
    let code = match &err {
        SessionError::Action(conex_computer::action::ActionError::InvalidParams(msg)) => {
            return invalid_params(format!("工具 {tool_name} 参数校验失败：{msg}"))
        }
        SessionError::Action(conex_computer::action::ActionError::CoordsOutOfBounds) => {
            return coords_out_of_bounds(format!("工具 {tool_name}：{raw}"))
        }
        // 动作前检查器拒绝（06 §4.2 守卫⑥：白名单 / 提权统一 elevated_window）
        SessionError::Gate(_) => {
            return elevated_window(format!("工具 {tool_name} 目标窗口拒绝：{raw}"))
        }
        SessionError::Inject(_) | SessionError::Capture(_) | SessionError::Init(_) => {
            shared_codes::TOOL_EXECUTION_FAILED
        }
    };
    ToolError::new(code, format!("工具 {tool_name} 执行失败：{raw}"))
}

/// `PerceptionError` → `ToolError`（UIA 感知失败统一 `tool.execution_failed`；
/// 消息携带错误语义供模型侧区分无活动窗口 / UIA 故障）。
pub fn map_perception_error(tool_name: &str, err: PerceptionError) -> ToolError {
    ToolError::new(
        shared_codes::TOOL_EXECUTION_FAILED,
        format!("工具 {tool_name} 感知失败：{err}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_computer::action::ActionError;
    use conex_computer::perception::PerceptionError;
    use conex_computer::SessionError;
    use conex_shared::gate::{TargetDenial, TargetDenialKind};

    /// SessionError → 错误码映射全表（06 §5 码表逐项回归）。
    #[test]
    fn session_error_mapping_table() {
        assert_eq!(
            map_session_error(
                "computer_click",
                SessionError::Action(ActionError::InvalidParams("x".into()))
            )
            .code(),
            codes::TOOL_COMPUTER_INVALID_PARAMS
        );
        assert_eq!(
            map_session_error(
                "computer_move",
                SessionError::Action(ActionError::CoordsOutOfBounds)
            )
            .code(),
            codes::TOOL_COMPUTER_COORDS_OUT_OF_BOUNDS
        );
        for err in [
            SessionError::Inject("设备失败".into()),
            SessionError::Capture("截屏失败".into()),
            SessionError::Init("初始化失败".into()),
        ] {
            assert_eq!(
                map_session_error("computer_click", err).code(),
                shared_codes::TOOL_EXECUTION_FAILED
            );
        }
    }

    /// Gate 拒绝统一映射 elevated_window（06 §4.2 守卫⑥：白名单/提权统一码；
    /// 提权与白名单分类都落在同一码）。
    #[test]
    fn gate_denial_maps_to_elevated_window() {
        for kind in [TargetDenialKind::Elevated, TargetDenialKind::Whitelist] {
            let err = map_session_error(
                "computer_click",
                SessionError::Gate(TargetDenial {
                    kind,
                    target: "系统设置 (SystemSettings.exe)".into(),
                    reason: "拒绝注入".into(),
                }),
            );
            assert_eq!(err.code(), codes::TOOL_COMPUTER_ELEVATED_WINDOW);
            assert!(err.to_string().contains("系统设置"));
        }
    }

    /// 感知错误映射统一 execution_failed（消息携带语义）。
    #[test]
    fn perception_error_mapping() {
        let err = map_perception_error("computer_snapshot", PerceptionError::NoActiveWindow);
        assert_eq!(err.code(), shared_codes::TOOL_EXECUTION_FAILED);
        assert!(err.to_string().contains("无活动窗口"));

        let err = map_perception_error(
            "computer_snapshot",
            PerceptionError::Traverse("元素读取失败".into()),
        );
        assert_eq!(err.code(), shared_codes::TOOL_EXECUTION_FAILED);
    }

    /// 守卫错误码：not_ready / not_enabled / exclusive / cancelled 文案与码。
    #[test]
    fn guard_error_codes() {
        assert_eq!(not_ready("未注入").code(), codes::TOOL_COMPUTER_NOT_READY);
        assert_eq!(
            not_enabled("未开启").code(),
            codes::TOOL_COMPUTER_NOT_ENABLED
        );
        assert_eq!(
            exclusive("互斥").code(),
            codes::TOOL_SESSION_EXCLUSIVE,
            "跨线共享码 tool.session.exclusive"
        );
        assert_eq!(cancelled().code(), codes::TOOL_COMPUTER_CANCELLED);
        assert_eq!(
            elevated_window("提权").code(),
            codes::TOOL_COMPUTER_ELEVATED_WINDOW
        );
        assert_eq!(
            coords_out_of_bounds("越界").code(),
            codes::TOOL_COMPUTER_COORDS_OUT_OF_BOUNDS
        );
        assert_eq!(
            approval_rejected("拒绝").code(),
            shared_codes::APPROVAL_REJECTED,
            "审批拒绝走既有 approval.rejected（浏览器线同源）"
        );
    }
}
