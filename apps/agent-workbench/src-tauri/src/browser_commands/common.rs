use std::sync::Arc;
use crate::browser::{BrowserSlot, StartPayload};
use crate::core_run_commands::CoreRunState;

/// 错误码前缀（J1b 结构化错误面）：未连接/恢复期。
pub(crate) const TOOL_BROWSER_NOT_READY: &str = "tool.browser.not_ready";
/// 错误码前缀（J1b 结构化错误面）：输入非法（解析失败/守卫拒绝）。
pub(crate) const TOOL_INVALID_INPUT: &str = "tool.invalid_input";

/// 会话不可用 → `tool.browser.not_ready` 前缀（storage 命令统一映射）。
pub(crate) fn not_ready(reason: impl Into<String>) -> String {
    format!("{TOOL_BROWSER_NOT_READY}: {}", reason.into())
}

/// 输入非法 → `tool.invalid_input` 前缀（parse 失败/domain/origin 守卫拒绝）。
pub(crate) fn invalid_input(reason: impl Into<String>) -> String {
    format!("{TOOL_INVALID_INPUT}: {}", reason.into())
}

/// 取引擎持有的浏览器会话槽（命令面与工具面共享同一进程级单例）。
pub(crate) fn slot(core: &Arc<CoreRunState>) -> Arc<BrowserSlot> {
    core.engine().browser_slot()
}

/// 启动结果 → 契约载荷（Ok = running/starting；Err = error + reason）。
pub(crate) fn start_payload(result: Result<&'static str, String>) -> StartPayload {
    match result {
        Ok(state) => StartPayload {
            state,
            reason: None,
        },
        Err(reason) => StartPayload {
            state: "error",
            reason: Some(reason),
        },
    }
}
