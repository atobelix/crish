//! CDP 错误映射与方法常量。

use std::time::Duration;

use crate::action::{ActionError, ActionErrorKind};
use crate::cdp::error::CdpError;

/// 命令级超时（对齐表 2-1 原语默认值：click/hover/drag/focus/key 15s，滚动 8s 等；
/// 统一 15s 为 MVP 默认，env 覆盖接线在 M7 工具层）。
pub(crate) const CMD_TIMEOUT: Duration = Duration::from_secs(15);

// CDP 方法名（本模块内部使用；与 cdp/domains.rs 的 names 常量互补）
pub(crate) const CDP_PAGE_GET_NAVIGATION_HISTORY: &str = "Page.getNavigationHistory";
pub(crate) const CDP_PAGE_GET_LAYOUT_METRICS: &str = "Page.getLayoutMetrics";
pub(crate) const CDP_PAGE_GO_BACK: &str = "Page.goBack";
pub(crate) const CDP_DOM_PUSH_NODES: &str = "DOM.pushNodesByBackendIdsToFrontend";
pub(crate) const CDP_DOM_GET_BOX_MODEL: &str = "DOM.getBoxModel";
pub(crate) const CDP_DOM_SCROLL_INTO_VIEW: &str = "DOM.scrollIntoViewIfNeeded";
pub(crate) const CDP_DOM_FOCUS: &str = "DOM.focus";
pub(crate) const CDP_DOM_RESOLVE_NODE: &str = "DOM.resolveNode";
pub(crate) const CDP_DOM_SET_FILE_INPUT_FILES: &str = "DOM.setFileInputFiles";
pub(crate) const CDP_RUNTIME_CALL_FUNCTION_ON: &str = "Runtime.callFunctionOn";
pub(crate) const CDP_RUNTIME_EVALUATE: &str = "Runtime.evaluate";
// Chrome 151 已移除 Runtime.createIsolatedWorld（-32601 not found，K7 e2e 实测）；
// 隔离世界创建改走 Page 域（缺陷 A 修复）：getFrameTree 取主 frameId → createIsolatedWorld
pub(crate) const CDP_PAGE_GET_FRAME_TREE: &str = "Page.getFrameTree";
pub(crate) const CDP_PAGE_CREATE_ISOLATED_WORLD: &str = "Page.createIsolatedWorld";
pub(crate) const CDP_INPUT_DISPATCH_MOUSE: &str = "Input.dispatchMouseEvent";
pub(crate) const CDP_INPUT_DISPATCH_KEY: &str = "Input.dispatchKeyEvent";
pub(crate) const CDP_INPUT_INSERT_TEXT: &str = "Input.insertText";

/// CdpError → ActionError 映射（14 §5.1 表；R-9 分类）。
pub(crate) fn map_cdp_error(err: CdpError, method: &str) -> ActionError {
    let raw = err.to_string();
    let kind = match &err {
        CdpError::ContextGone { message, .. } => {
            if message.contains("Target closed")
                || message.contains("Target page, context or browser has been closed")
            {
                ActionErrorKind::TargetClosed
            } else {
                ActionErrorKind::ContextGone
            }
        }
        CdpError::ConnectionLost => ActionErrorKind::ConnectionLost,
        CdpError::Timeout { .. } => ActionErrorKind::Timeout,
        CdpError::Cancelled {
            reason: crate::cdp::error::CancelReason::Aborted,
        }
        | CdpError::Cancelled {
            reason: crate::cdp::error::CancelReason::EmergencyStop,
        } => ActionErrorKind::Aborted,
        CdpError::ApprovalDenied { .. } => ActionErrorKind::ApprovalDenied,
        CdpError::NotReady(_) => ActionErrorKind::TargetRestarting,
        CdpError::NoActiveTab => ActionErrorKind::TargetClosed,
        CdpError::NoSuchTab { .. } => ActionErrorKind::TargetClosed,
        CdpError::Server { message, .. } => {
            if message.contains("No node with given id found")
                || message.contains("Could not compute box model")
            {
                ActionErrorKind::NodeStale
            } else {
                ActionErrorKind::ContextGone
            }
        }
        CdpError::BadParams { .. } | CdpError::Protocol { .. } => ActionErrorKind::InvalidInput,
        // M4：内部/序列化错误非导航竞态——重试不会自愈，归 Fatal 类（Unsupported
        // 策略不重试）；旧实现误归 ContextGone 白白延迟重试 3 次并掩盖真实错误
        CdpError::Internal { .. } | CdpError::Serialize { .. } => ActionErrorKind::Unsupported,
        CdpError::DomainUnavailable { .. } => ActionErrorKind::Unsupported,
        // R-12 会话只读能力集拦截（34 §5.2 E-3）：与域名门禁同为维度 17 安全
        // 拦截面（sender 审计同用 Blocked 相位）——归 GateDenied 类（不重试、
        // 不升级；工具层映射 tool.browser.capability_disabled）
        CdpError::CapabilityDenied { .. } => ActionErrorKind::GateDenied,
    };
    ActionError::new(kind, format!("CDP 命令失败[{method}]：{raw}")).with_cdp_raw(raw)
}
