use crate::browser::{BrowserSlot, StartPayload};
use conex_run::core_error::CoreError;
use std::sync::Arc;

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

/// 命令边界 String → `CoreError`：detail 逐字保留原文案（J1b 码前缀不丢失，
/// 前端按前缀匹配的行为不受影响）；kind 语义——J1b 前缀（会话未就绪 /
/// 入参非法均属调用时机与入参问题）→ InvalidInput，其余系统层文案 → Internal 兜底。
pub(crate) fn map_browser_err(err: String) -> CoreError {
    if err.starts_with(TOOL_BROWSER_NOT_READY) || err.starts_with(TOOL_INVALID_INPUT) {
        CoreError::InvalidInput(err)
    } else {
        CoreError::Internal(err)
    }
}

/// 取宿主持有的浏览器会话槽（命令面与工具面共享同一进程级单例；
/// main.rs manage `Arc<BrowserSlot>`，命令经 Tauri State 取用——
/// `&core`（State）经 Deref 收敛为 `&Arc<BrowserSlot>`）。
pub(crate) fn slot(core: &Arc<BrowserSlot>) -> Arc<BrowserSlot> {
    Arc::clone(core)
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
