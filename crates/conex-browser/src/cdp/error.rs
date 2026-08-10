//! 错误面：CDP 错误码映射 + 引擎错误分级（维度 11 §3.2 / §1 error.rs）
//!
//! - `CdpErrorCode`：CDP 线格式错误码表（-32700 ~ -32000）
//! - `CdpError`：命令级引擎错误（`BrowserSession::send` 等返回面，§8 契约）
//! - `BrowserError`：连接/会话级分级错误（握手/校验/恢复/内部，可透传 CdpError）
//!
//! 锁纪律（31-security-baseline B8，评审 21-L2）：本模块及全 crate 新增锁一律恢复式——
//! 不加 expect/unwrap，锁中毒转为 `CdpError::Internal` 错误返回，锁内不 panic。

use crate::cdp::types::WireCdpError;
use std::time::Duration;

/// CDP 协议错误码表（JSON-RPC 标准 + Chrome 扩展）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CdpErrorCode {
    /// 解析错误（-32700）：不应出现，记审计
    ParseError,
    /// 无效请求（-32600）
    InvalidRequest,
    /// 方法不存在（-32601）：→ 能力探测记 unsupported（降级）
    MethodNotFound,
    /// 参数无效（-32602）
    InvalidParams,
    /// 内部错误（-32603）
    InternalError,
    /// 服务器错误（-32000，Chrome 通用）
    ServerError,
    /// 未识别错误码（协议漂移，原样透传）
    Unknown(i64),
}

impl CdpErrorCode {
    /// 错误码 → 枚举（未知码透传 Unknown）。
    pub fn from_i64(code: i64) -> CdpErrorCode {
        match code {
            -32700 => CdpErrorCode::ParseError,
            -32600 => CdpErrorCode::InvalidRequest,
            -32601 => CdpErrorCode::MethodNotFound,
            -32602 => CdpErrorCode::InvalidParams,
            -32603 => CdpErrorCode::InternalError,
            -32000 => CdpErrorCode::ServerError,
            other => CdpErrorCode::Unknown(other),
        }
    }
}

/// 取消原因（§2.5 取消路径分类）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CancelReason {
    /// 用户接管/急停触发 abort_token（在途命令逐 id 取消）
    Aborted,
    /// 急停旗置位，新命令直接拒绝
    EmergencyStop,
}

/// 命令级引擎错误（§3.2 错误码映射表 + 超时/断连/取消三类本地错误）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CdpError {
    /// -32700 / -32600：协议层错误（不应出现，记审计）
    Protocol {
        method: Option<String>,
        message: String,
    },
    /// -32601：域/方法不支持 → 能力探测记 unsupported（§6 降级）
    DomainUnavailable {
        method: String,
    },
    /// -32602：参数无效
    BadParams {
        method: String,
        message: String,
    },
    /// -32603：内部错误（含锁中毒恢复路径，B8 纪律）
    Internal {
        method: Option<String>,
        message: String,
    },
    /// -32000 及其他未分类服务器错误
    Server {
        code: i64,
        message: String,
    },
    /// -32000 特判：Target closed / Cannot find context（维度 14 导航竞态分类）
    ContextGone {
        method: String,
        message: String,
    },
    /// 命令级超时（pending 项已移除）
    Timeout {
        method: String,
        elapsed: Duration,
    },
    /// 连接丢失（pending oneshot 通道关闭即刻返回，不等超时）
    ConnectionLost,
    /// 取消（abort 抢断 / 急停）
    Cancelled {
        reason: CancelReason,
    },
    /// 审批拒绝（§4.1 ③ 审批段；Deny → 审计 + 拒绝，不发送）
    ApprovalDenied {
        reason: String,
    },
    /// 会话只读能力集拦截（R-12，34 §5.2 E-3）：attach 会话下命令不在只读
    /// 白名单 → fail-closed 拒绝（维度 17 §2.3 默认拒绝面同级，不可审批豁免，
    /// 检查先于审批段）。工具层映射 `tool.browser.capability_disabled`
    /// （conex-types error.rs 已登记，双端口径一致）。
    CapabilityDenied {
        method: String,
    },
    /// 序列化失败（出站信封/参数编码）
    Serialize {
        method: String,
        message: String,
    },
    /// 恢复期门禁（R-9-4）：重连/崩溃重启完成前工具面不可用；
    /// 结构化 `browser.not_ready` 错误码由工具层（维度 17）登记，本层提供底层信号
    NotReady(String),
    /// 无活动标签会话（current_session 无可用会话）
    NoActiveTab,
    /// 按 tab_id（targetId）路由不到会话（P1 多标签：标签已关闭/未 attach）。
    /// 工具面映射 node_gone（目标过期语义，14 §5.1 TargetClosed 同源）。
    NoSuchTab { tab_id: String },
}

impl CdpError {
    /// 线格式错误 → 引擎错误映射（§3.2 全表）。
    /// `-32000` 的上下文消失特判为 ContextGone（关键字集见 `GONE_KEYWORDS`）。
    pub fn from_wire(method: &str, wire: &WireCdpError) -> CdpError {
        let code = wire.code.unwrap_or(-32000);
        match CdpErrorCode::from_i64(code) {
            CdpErrorCode::ParseError | CdpErrorCode::InvalidRequest => CdpError::Protocol {
                method: Some(method.to_string()),
                message: wire.message.clone(),
            },
            CdpErrorCode::MethodNotFound => CdpError::DomainUnavailable {
                method: method.to_string(),
            },
            CdpErrorCode::InvalidParams => CdpError::BadParams {
                method: method.to_string(),
                message: wire.message.clone(),
            },
            CdpErrorCode::InternalError => CdpError::Internal {
                method: Some(method.to_string()),
                message: wire.message.clone(),
            },
            CdpErrorCode::ServerError => {
                // 上下文消失特判：导航竞态 / 页面销毁语义（维度 14 消费）。
                // 评审 G2（32 评审 P2-1 补强）：关键字匹配扩展——真实 Chrome 的
                // "Target with specified id is closed" 形态不命中旧精确子串
                // "Target closed"（此前归 Server，误伤导航竞态重试面）；现统一
                // 小写归一后匹配关键字集（收集自 CDP 协议文档与 S0/e2e 实测）。
                if is_context_gone_message(&wire.message) {
                    CdpError::ContextGone {
                        method: method.to_string(),
                        message: wire.message.clone(),
                    }
                } else {
                    CdpError::Server {
                        code,
                        message: wire.message.clone(),
                    }
                }
            }
            CdpErrorCode::Unknown(other) => CdpError::Server {
                code: other,
                message: wire.message.clone(),
            },
        }
    }

    /// 是否可重试的连接级错误（重连/重试决策辅助）。
    pub fn is_connection_level(&self) -> bool {
        matches!(self, CdpError::ConnectionLost | CdpError::Timeout { .. })
    }
}

/// 上下文/目标消失消息关键字集（小写归一后匹配）：
/// - "target closed"：跨浏览器旧形态；
/// - "target with specified id is closed"：真实 Chrome 对已关闭目标调用方法的报错；
/// - "no target with given id found"：Target 域目标已不存在；
/// - "cannot find context"：Runtime 上下文不存在（含 "Cannot find context with
///   specified id" 等派生形态）；
/// - "inspected target navigated or closed"：导航竞态（Runtime.evaluate 等）；
/// - "execution context was destroyed"：执行上下文销毁。
const GONE_KEYWORDS: [&str; 6] = [
    "target closed",
    "target with specified id is closed",
    "no target with given id found",
    "cannot find context",
    "inspected target navigated or closed",
    "execution context was destroyed",
];

/// -32000 消息是否命中上下文消失语义（小写归一，避免大小写变体漏判）。
fn is_context_gone_message(message: &str) -> bool {
    let msg = message.to_ascii_lowercase();
    GONE_KEYWORDS.iter().any(|k| msg.contains(k))
}

impl std::fmt::Display for CdpError {
    /// 错误文本不嵌入敏感参数（§3.2 铁律）。
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CdpError::Protocol { method, message } => write!(
                f,
                "协议错误{}{}",
                method.as_deref().map(|m| format!("[{m}]")).unwrap_or_default(),
                message
            ),
            CdpError::DomainUnavailable { method } => write!(f, "域不支持[{method}]"),
            CdpError::BadParams { method, message } => write!(f, "参数无效[{method}]：{message}"),
            CdpError::Internal { method, message } => write!(
                f,
                "内部错误{}{}",
                method.as_deref().map(|m| format!("[{m}]")).unwrap_or_default(),
                message
            ),
            CdpError::Server { code, message } => write!(f, "服务器错误({code})：{message}"),
            CdpError::ContextGone { method, message } => {
                write!(f, "上下文已消失[{method}]：{message}")
            }
            CdpError::Timeout { method, elapsed } => {
                write!(f, "命令超时[{method}]：{}ms", elapsed.as_millis())
            }
            CdpError::ConnectionLost => write!(f, "CDP 连接已丢失"),
            CdpError::Cancelled { reason } => write!(f, "命令已取消：{reason:?}"),
            CdpError::ApprovalDenied { reason } => write!(f, "审批拒绝：{reason}"),
            CdpError::CapabilityDenied { method } => write!(
                f,
                "会话只读能力集拒绝[{method}]：attach 会话仅授予只读命令域"
            ),
            CdpError::Serialize { method, message } => write!(f, "序列化失败[{method}]：{message}"),
            CdpError::NotReady(detail) => write!(f, "浏览器恢复中，工具面不可用：{detail}"),
            CdpError::NoActiveTab => write!(f, "无活动标签会话"),
            CdpError::NoSuchTab { tab_id } => write!(f, "标签 {tab_id} 不存在或已关闭（无可用会话）"),
        }
    }
}

impl std::error::Error for CdpError {}

/// 连接/会话级分级错误（connect/握手/校验/恢复/内部兜底）。
/// 命令面错误统一走 `CdpError`；`BrowserError::Cdp` 提供透传。
#[derive(Debug, thiserror::Error)]
pub enum BrowserError {
    /// 握手失败（TCP/WS 层）
    #[error("CDP 握手失败：{0}")]
    Connect(String),
    /// 握手超时（10s 建连 / 5s getVersion 校验）
    #[error("CDP 握手超时")]
    HandshakeTimeout,
    /// 身份校验失败：getVersion 产品/版本与预期实例不一致（防错连遗留实例）
    #[error("CDP 实例校验失败：期望 {expected}，实际 {actual}")]
    VerifyMismatch { expected: String, actual: String },
    /// 恢复流程失败（enable 序列/会话重建）
    #[error("会话恢复失败：{0}")]
    Restore(String),
    /// 连接 I/O 错误（best-effort 之外的硬错误）
    #[error("连接错误：{0}")]
    Io(String),
    /// 内部错误（锁中毒等恢复式错误返回，B8 纪律）
    #[error("内部错误：{0}")]
    Internal(String),
    /// 命令错误透传（connect 之后的命令面统一返回 CdpError，本变体供嵌套场景）
    #[error(transparent)]
    Cdp(#[from] CdpError),
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 错误码表映射（§3.2 全表回归）。
    #[test]
    fn error_code_table() {
        assert_eq!(CdpErrorCode::from_i64(-32700), CdpErrorCode::ParseError);
        assert_eq!(CdpErrorCode::from_i64(-32600), CdpErrorCode::InvalidRequest);
        assert_eq!(CdpErrorCode::from_i64(-32601), CdpErrorCode::MethodNotFound);
        assert_eq!(CdpErrorCode::from_i64(-32602), CdpErrorCode::InvalidParams);
        assert_eq!(CdpErrorCode::from_i64(-32603), CdpErrorCode::InternalError);
        assert_eq!(CdpErrorCode::from_i64(-32000), CdpErrorCode::ServerError);
        assert_eq!(CdpErrorCode::from_i64(-99), CdpErrorCode::Unknown(-99));
    }

    /// Display 不嵌入敏感参数。
    #[test]
    fn error_display_no_sensitive() {
        let e = CdpError::Server {
            code: -32000,
            message: "Failed to read response 7f7f7f".to_string(),
        };
        let text = e.to_string();
        assert!(text.contains("服务器错误"));
        assert!(!text.contains("ws://"));
    }

    // ---------- from_wire 全表（§3.2 映射表逐变体回归，评审 P2 补强） ----------

    fn wire(code: Option<i64>, message: &str) -> WireCdpError {
        WireCdpError {
            code,
            message: message.to_string(),
            data: None,
        }
    }

    /// -32000 特判：上下文消失关键字集 → ContextGone（维度 14 消费面）。
    /// 评审 G2（32 评审 P2-1）：关键字匹配扩展——真实 Chrome 变体逐一锁定，
    /// 含旧实现漏判的 "Target with specified id is closed"（此前归 Server）。
    #[test]
    fn from_wire_context_gone_special_cases() {
        for msg in [
            "Target closed",
            "Target with specified id is closed",
            "No target with given id found",
            "Cannot find context with specified id",
            "Cannot find context: context not found",
            "Inspected target navigated or closed",
            "Execution context was destroyed",
            "Runtime execution context was destroyed：Target closed",
        ] {
            let got = CdpError::from_wire("Page.navigate", &wire(Some(-32000), msg));
            assert!(
                matches!(&got, CdpError::ContextGone { method, .. } if method == "Page.navigate"),
                "消息含关闭/上下文消失语义必须特判 ContextGone：{msg:?}（实际 {got:?}）"
            );
        }
    }

    /// -32000 特判的否定面：普通服务器消息不进 ContextGone。
    #[test]
    fn from_wire_32000_generic_is_server() {
        let got = CdpError::from_wire("Page.navigate", &wire(Some(-32000), "browser process crashed"));
        match &got {
            CdpError::Server { code, message } => {
                assert_eq!(*code, -32000);
                assert_eq!(message, "browser process crashed");
            }
            other => panic!("普通 -32000 消息应为 Server，实际：{other:?}"),
        }
        // 大小写变体：关键字小写归一后仍命中（真实 Chrome 消息大小写不固定）
        let variant = CdpError::from_wire(
            "Page.navigate",
            &wire(Some(-32000), "target WITH specified ID is closed"),
        );
        assert!(
            matches!(variant, CdpError::ContextGone { .. }),
            "关键字匹配必须大小写不敏感（实际 {variant:?}）"
        );
    }

    /// -32601 → 域/方法不可用（能力探测降级语义）。
    #[test]
    fn from_wire_32601_domain_unavailable() {
        let got = CdpError::from_wire("Page.captureScreenshot", &wire(Some(-32601), "Method not found"));
        assert!(
            matches!(got, CdpError::DomainUnavailable { ref method } if method == "Page.captureScreenshot"),
            "实际 {got:?}"
        );
    }

    /// 未知码原样透传 Server{code}（协议漂移面，码值必须保留）。
    #[test]
    fn from_wire_unknown_code_passthrough() {
        for code in [-1i64, -100, -31999, -40000, 0, 32000, i64::MAX] {
            let got = CdpError::from_wire("X.y", &wire(Some(code), "drift"));
            assert!(
                matches!(&got, CdpError::Server { code: c, message } if *c == code && message == "drift"),
                "未知码 {code} 必须原样透传（实际 {got:?}）"
            );
        }
    }

    /// 缺码默认 -32000：默认码同样走 ContextGone 特判与 Server 兜底。
    #[test]
    fn from_wire_missing_code_defaults_to_32000() {
        let gone = CdpError::from_wire("Page.navigate", &wire(None, "Cannot find context"));
        assert!(
            matches!(gone, CdpError::ContextGone { .. }),
            "缺码默认 -32000，消息命中特判仍需转 ContextGone"
        );
        let server = CdpError::from_wire("Page.navigate", &wire(None, "boom"));
        assert!(
            matches!(&server, CdpError::Server { code, .. } if *code == -32000),
            "缺码默认 -32000 → Server，实际 {server:?}"
        );
    }

    /// 错误码映射全表（§3.2）：每个码位 → 唯一变体 + method/message 字段透传。
    #[test]
    fn from_wire_full_mapping_table() {
        // -32700 / -32600 → Protocol（method 可空，message 透传）
        for code in [-32700i64, -32600] {
            let got = CdpError::from_wire("X.y", &wire(Some(code), "协议层"));
            assert!(
                matches!(&got, CdpError::Protocol { method, message } if method.as_deref() == Some("X.y") && message == "协议层"),
                "码 {code} 应映射 Protocol（实际 {got:?}）"
            );
        }
        // -32602 → BadParams
        let got = CdpError::from_wire("X.y", &wire(Some(-32602), "参数错误"));
        assert!(
            matches!(&got, CdpError::BadParams { method, message } if method == "X.y" && message == "参数错误"),
            "实际 {got:?}"
        );
        // -32603 → Internal
        let got = CdpError::from_wire("X.y", &wire(Some(-32603), "内部错误"));
        assert!(
            matches!(&got, CdpError::Internal { method, message } if method.as_deref() == Some("X.y") && message == "内部错误"),
            "实际 {got:?}"
        );
    }

    /// is_connection_level 判定（重连/重试决策辅助）。
    #[test]
    fn connection_level_classification() {
        assert!(CdpError::ConnectionLost.is_connection_level());
        assert!(CdpError::Timeout { method: "x".into(), elapsed: Duration::ZERO }.is_connection_level());
        assert!(!CdpError::Server { code: -32000, message: "m".into() }.is_connection_level());
        assert!(!CdpError::DomainUnavailable { method: "x".into() }.is_connection_level());
        assert!(!CdpError::ContextGone { method: "x".into(), message: "m".into() }.is_connection_level());
    }

    /// CdpErrorCode::from_i64 边界补强：0 与 i64 极值落 Unknown。
    #[test]
    fn error_code_unknown_boundaries() {
        assert_eq!(CdpErrorCode::from_i64(0), CdpErrorCode::Unknown(0));
        assert_eq!(CdpErrorCode::from_i64(i64::MIN), CdpErrorCode::Unknown(i64::MIN));
        assert_eq!(CdpErrorCode::from_i64(i64::MAX), CdpErrorCode::Unknown(i64::MAX));
    }
}
