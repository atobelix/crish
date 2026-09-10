//! 跨端错误码与统一错误载荷（D3 §6.2 / M6 §6.2 全表）
//!
//! - [DeviceErrorCode]：字符串枚举 `<域>.<子类>`（协议级 + 业务级），
//!   wire 值经 serde rename 锁死；`Unknown` 新类型变体兜底未来新增码
//!   （旧端对未知码宽容，不崩溃）；
//! - [ErrorBody]：统一错误载荷（M6 §10.1 $defs.ErrorBody），成功/失败/部分
//!   三态响应与 `error` 消息、`stream.close` 错误共用；
//! - [DeviceErrorCode::from_core_error]：桌面 Command Adapter 的 CoreError
//!   映射（M6 §6.2.3）；77 码 CrishErrorPayload 不透传，仅 detail.kind 记录
//!   原 kind 供诊断（D3 §6.3）。

use serde::{Deserialize, Serialize};

/// 跨端错误码（D3 §6.2 / M6 §6.2 协议级 + 业务级全表，共 45 个注册码）
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum DeviceErrorCode {
    // ── 配对域（7）──
    /// 配对码格式非法（标准化失败）
    #[serde(rename = "pair.invalid_code")]
    PairInvalidCode,
    /// 码已过期（10min）
    #[serde(rename = "pair.expired")]
    PairExpired,
    /// 码已被使用（一次性；并发配对第二个失败）
    #[serde(rename = "pair.used")]
    PairUsed,
    /// 失败次数超限 / 限速（冷却 5min）
    #[serde(rename = "pair.too_many_attempts")]
    PairTooManyAttempts,
    /// pair.verify 签名不匹配
    #[serde(rename = "pair.challenge_mismatch")]
    PairChallengeMismatch,
    /// 无对应挑战（乱序/重放）
    #[serde(rename = "pair.no_challenge")]
    PairNoChallenge,
    /// 设备数超上限（PAIR_MAX_DEVICES=8）
    #[serde(rename = "pair.registry_full")]
    PairRegistryFull,

    // ── 认证域（7）──
    /// HMAC 校验失败
    #[serde(rename = "auth.bad_signature")]
    AuthBadSignature,
    /// 设备已撤销（重新配对）
    #[serde(rename = "auth.device_revoked")]
    AuthDeviceRevoked,
    /// deviceId 不在注册表（重新配对）
    #[serde(rename = "auth.unknown_device")]
    AuthUnknownDevice,
    /// desktopId 不匹配（重新配对；桌面重装后）
    #[serde(rename = "auth.unknown_desktop")]
    AuthUnknownDesktop,
    /// refresh 令牌过期/已用（重新 refresh）
    #[serde(rename = "auth.expired")]
    AuthExpired,
    /// ts 出窗 / nonce 重放（重发）
    #[serde(rename = "auth.stale")]
    AuthStale,
    /// 轮换 nonce 冲突（用新 nonce）
    #[serde(rename = "auth.rotate_conflict")]
    AuthRotateConflict,

    // ── 协议级（3）──
    /// 协议版本交集为空（升级）
    #[serde(rename = "version_mismatch")]
    VersionMismatch,
    /// 帧超 1 MiB（断链防内存放大）
    #[serde(rename = "frame_too_large")]
    FrameTooLarge,
    /// 连接被对方关闭（重连兜底）
    #[serde(rename = "transport.closed")]
    TransportClosed,

    // ── 命令域（12）──
    /// 参数非法（CoreError::InvalidInput）
    #[serde(rename = "cmd.invalid")]
    CmdInvalid,
    /// 目标不存在（run/session/任务/设备/审批）
    #[serde(rename = "cmd.not_found")]
    CmdNotFound,
    /// 命令未注册/不在 manifest
    #[serde(rename = "cmd.unknown")]
    CmdUnknown,
    /// 引擎未就绪（重试）
    #[serde(rename = "cmd.engine_not_ready")]
    CmdEngineNotReady,
    /// 恢复中拒绝 run（重试）
    #[serde(rename = "cmd.restore_in_progress")]
    CmdRestoreInProgress,
    /// 会话串行守卫命中（重试）
    #[serde(rename = "cmd.session_busy")]
    CmdSessionBusy,
    /// tool_call_id 不在待审批集合（I-02；冲突收敛信号）
    #[serde(rename = "cmd.approval_mismatch")]
    CmdApprovalMismatch,
    /// 命令被安全策略拒绝（白名单/门禁）
    #[serde(rename = "cmd.denied")]
    CmdDenied,
    /// 命令需先审批（gatekeeper）
    #[serde(rename = "cmd.requires_approval")]
    CmdRequiresApproval,
    /// 移动端本地超时（幂等重发）
    #[serde(rename = "cmd.timeout")]
    CmdTimeout,
    /// 请求被取消
    #[serde(rename = "cmd.cancelled")]
    CmdCancelled,
    /// 命令限流（退避重试）
    #[serde(rename = "cmd.too_many_requests")]
    CmdTooManyRequests,

    // ── 流/订阅域（5）──
    /// 未订阅会话即请求续传
    #[serde(rename = "stream.not_subscribed")]
    StreamNotSubscribed,
    /// 游标非法（负值/超限）
    #[serde(rename = "stream.cursor_invalid")]
    StreamCursorInvalid,
    /// 游标落后超窗口（走全量回放）
    #[serde(rename = "stream.cursor_stale")]
    StreamCursorStale,
    /// 订阅会话数超限（MAX_SUBSCRIPTIONS=32）
    #[serde(rename = "stream.too_many_subscriptions")]
    StreamTooManySubscriptions,
    /// 并发流超限（MAX_STREAMS=8；等流关闭重试）
    #[serde(rename = "stream.too_many_streams")]
    StreamTooManyStreams,

    // ── 文件域（6）──
    /// 文件/目录不存在
    #[serde(rename = "file.not_found")]
    FileNotFound,
    /// 路径越出授权工作区
    #[serde(rename = "file.not_granted")]
    FileNotGranted,
    /// 读取/写入超 1MB 上限
    #[serde(rename = "file.too_large")]
    FileTooLarge,
    /// 二进制文件无法预览
    #[serde(rename = "file.binary")]
    FileBinary,
    /// 编码不受支持
    #[serde(rename = "file.encoding")]
    FileEncoding,
    /// 文件已存在且 overwrite=false
    #[serde(rename = "file.exists")]
    FileExists,

    // ── 审批域（2）──
    /// 审批已过期（决策未生效）
    #[serde(rename = "approval.expired")]
    ApprovalExpired,
    /// 审批已被其他设备处理
    #[serde(rename = "approval.rejected")]
    ApprovalRejected,

    // ── 设置域（2）──
    /// 设置键不在白名单（手机端不可修改）
    #[serde(rename = "settings.key_denied")]
    SettingsKeyDenied,
    /// 桌面确认超时（60s；变更未生效）
    #[serde(rename = "settings.confirm_timeout")]
    SettingsConfirmTimeout,

    // ── 兜底（1）──
    /// 未分类内部错误（CoreError::Internal/Io）
    #[serde(rename = "internal")]
    Internal,

    /// 未来新增码兜底（旧端宽容：原样透传）
    Unknown(String),
}

impl<'de> Deserialize<'de> for DeviceErrorCode {
    /// 反序列化：45 个注册 wire 码 → 对应变体；其余 → [DeviceErrorCode::
    /// Unknown] 兜底（新码在旧端宽容透传，不崩溃）。
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let wire = String::deserialize(deserializer)?;
        Ok(match wire.as_str() {
            "pair.invalid_code" => DeviceErrorCode::PairInvalidCode,
            "pair.expired" => DeviceErrorCode::PairExpired,
            "pair.used" => DeviceErrorCode::PairUsed,
            "pair.too_many_attempts" => DeviceErrorCode::PairTooManyAttempts,
            "pair.challenge_mismatch" => DeviceErrorCode::PairChallengeMismatch,
            "pair.no_challenge" => DeviceErrorCode::PairNoChallenge,
            "pair.registry_full" => DeviceErrorCode::PairRegistryFull,
            "auth.bad_signature" => DeviceErrorCode::AuthBadSignature,
            "auth.device_revoked" => DeviceErrorCode::AuthDeviceRevoked,
            "auth.unknown_device" => DeviceErrorCode::AuthUnknownDevice,
            "auth.unknown_desktop" => DeviceErrorCode::AuthUnknownDesktop,
            "auth.expired" => DeviceErrorCode::AuthExpired,
            "auth.stale" => DeviceErrorCode::AuthStale,
            "auth.rotate_conflict" => DeviceErrorCode::AuthRotateConflict,
            "version_mismatch" => DeviceErrorCode::VersionMismatch,
            "frame_too_large" => DeviceErrorCode::FrameTooLarge,
            "transport.closed" => DeviceErrorCode::TransportClosed,
            "cmd.invalid" => DeviceErrorCode::CmdInvalid,
            "cmd.not_found" => DeviceErrorCode::CmdNotFound,
            "cmd.unknown" => DeviceErrorCode::CmdUnknown,
            "cmd.engine_not_ready" => DeviceErrorCode::CmdEngineNotReady,
            "cmd.restore_in_progress" => DeviceErrorCode::CmdRestoreInProgress,
            "cmd.session_busy" => DeviceErrorCode::CmdSessionBusy,
            "cmd.approval_mismatch" => DeviceErrorCode::CmdApprovalMismatch,
            "cmd.denied" => DeviceErrorCode::CmdDenied,
            "cmd.requires_approval" => DeviceErrorCode::CmdRequiresApproval,
            "cmd.timeout" => DeviceErrorCode::CmdTimeout,
            "cmd.cancelled" => DeviceErrorCode::CmdCancelled,
            "cmd.too_many_requests" => DeviceErrorCode::CmdTooManyRequests,
            "stream.not_subscribed" => DeviceErrorCode::StreamNotSubscribed,
            "stream.cursor_invalid" => DeviceErrorCode::StreamCursorInvalid,
            "stream.cursor_stale" => DeviceErrorCode::StreamCursorStale,
            "stream.too_many_subscriptions" => DeviceErrorCode::StreamTooManySubscriptions,
            "stream.too_many_streams" => DeviceErrorCode::StreamTooManyStreams,
            "file.not_found" => DeviceErrorCode::FileNotFound,
            "file.not_granted" => DeviceErrorCode::FileNotGranted,
            "file.too_large" => DeviceErrorCode::FileTooLarge,
            "file.binary" => DeviceErrorCode::FileBinary,
            "file.encoding" => DeviceErrorCode::FileEncoding,
            "file.exists" => DeviceErrorCode::FileExists,
            "approval.expired" => DeviceErrorCode::ApprovalExpired,
            "approval.rejected" => DeviceErrorCode::ApprovalRejected,
            "settings.key_denied" => DeviceErrorCode::SettingsKeyDenied,
            "settings.confirm_timeout" => DeviceErrorCode::SettingsConfirmTimeout,
            "internal" => DeviceErrorCode::Internal,
            _ => DeviceErrorCode::Unknown(wire),
        })
    }
}

/// 全部已注册错误码（45 个，wire 字面量；注册表对拍基准）
pub const ALL_ERROR_CODES: [&str; 45] = [
    "pair.invalid_code",
    "pair.expired",
    "pair.used",
    "pair.too_many_attempts",
    "pair.challenge_mismatch",
    "pair.no_challenge",
    "pair.registry_full",
    "auth.bad_signature",
    "auth.device_revoked",
    "auth.unknown_device",
    "auth.unknown_desktop",
    "auth.expired",
    "auth.stale",
    "auth.rotate_conflict",
    "version_mismatch",
    "frame_too_large",
    "transport.closed",
    "cmd.invalid",
    "cmd.not_found",
    "cmd.unknown",
    "cmd.engine_not_ready",
    "cmd.restore_in_progress",
    "cmd.session_busy",
    "cmd.approval_mismatch",
    "cmd.denied",
    "cmd.requires_approval",
    "cmd.timeout",
    "cmd.cancelled",
    "cmd.too_many_requests",
    "stream.not_subscribed",
    "stream.cursor_invalid",
    "stream.cursor_stale",
    "stream.too_many_subscriptions",
    "stream.too_many_streams",
    "file.not_found",
    "file.not_granted",
    "file.too_large",
    "file.binary",
    "file.encoding",
    "file.exists",
    "approval.expired",
    "approval.rejected",
    "settings.key_denied",
    "settings.confirm_timeout",
    "internal",
];

impl DeviceErrorCode {
    /// wire 字面量（`<域>.<子类>`；Unknown 原样透传）
    pub fn as_str(&self) -> String {
        match self {
            DeviceErrorCode::PairInvalidCode => "pair.invalid_code".to_string(),
            DeviceErrorCode::PairExpired => "pair.expired".to_string(),
            DeviceErrorCode::PairUsed => "pair.used".to_string(),
            DeviceErrorCode::PairTooManyAttempts => "pair.too_many_attempts".to_string(),
            DeviceErrorCode::PairChallengeMismatch => "pair.challenge_mismatch".to_string(),
            DeviceErrorCode::PairNoChallenge => "pair.no_challenge".to_string(),
            DeviceErrorCode::PairRegistryFull => "pair.registry_full".to_string(),
            DeviceErrorCode::AuthBadSignature => "auth.bad_signature".to_string(),
            DeviceErrorCode::AuthDeviceRevoked => "auth.device_revoked".to_string(),
            DeviceErrorCode::AuthUnknownDevice => "auth.unknown_device".to_string(),
            DeviceErrorCode::AuthUnknownDesktop => "auth.unknown_desktop".to_string(),
            DeviceErrorCode::AuthExpired => "auth.expired".to_string(),
            DeviceErrorCode::AuthStale => "auth.stale".to_string(),
            DeviceErrorCode::AuthRotateConflict => "auth.rotate_conflict".to_string(),
            DeviceErrorCode::VersionMismatch => "version_mismatch".to_string(),
            DeviceErrorCode::FrameTooLarge => "frame_too_large".to_string(),
            DeviceErrorCode::TransportClosed => "transport.closed".to_string(),
            DeviceErrorCode::CmdInvalid => "cmd.invalid".to_string(),
            DeviceErrorCode::CmdNotFound => "cmd.not_found".to_string(),
            DeviceErrorCode::CmdUnknown => "cmd.unknown".to_string(),
            DeviceErrorCode::CmdEngineNotReady => "cmd.engine_not_ready".to_string(),
            DeviceErrorCode::CmdRestoreInProgress => "cmd.restore_in_progress".to_string(),
            DeviceErrorCode::CmdSessionBusy => "cmd.session_busy".to_string(),
            DeviceErrorCode::CmdApprovalMismatch => "cmd.approval_mismatch".to_string(),
            DeviceErrorCode::CmdDenied => "cmd.denied".to_string(),
            DeviceErrorCode::CmdRequiresApproval => "cmd.requires_approval".to_string(),
            DeviceErrorCode::CmdTimeout => "cmd.timeout".to_string(),
            DeviceErrorCode::CmdCancelled => "cmd.cancelled".to_string(),
            DeviceErrorCode::CmdTooManyRequests => "cmd.too_many_requests".to_string(),
            DeviceErrorCode::StreamNotSubscribed => "stream.not_subscribed".to_string(),
            DeviceErrorCode::StreamCursorInvalid => "stream.cursor_invalid".to_string(),
            DeviceErrorCode::StreamCursorStale => "stream.cursor_stale".to_string(),
            DeviceErrorCode::StreamTooManySubscriptions => {
                "stream.too_many_subscriptions".to_string()
            }
            DeviceErrorCode::StreamTooManyStreams => "stream.too_many_streams".to_string(),
            DeviceErrorCode::FileNotFound => "file.not_found".to_string(),
            DeviceErrorCode::FileNotGranted => "file.not_granted".to_string(),
            DeviceErrorCode::FileTooLarge => "file.too_large".to_string(),
            DeviceErrorCode::FileBinary => "file.binary".to_string(),
            DeviceErrorCode::FileEncoding => "file.encoding".to_string(),
            DeviceErrorCode::FileExists => "file.exists".to_string(),
            DeviceErrorCode::ApprovalExpired => "approval.expired".to_string(),
            DeviceErrorCode::ApprovalRejected => "approval.rejected".to_string(),
            DeviceErrorCode::SettingsKeyDenied => "settings.key_denied".to_string(),
            DeviceErrorCode::SettingsConfirmTimeout => "settings.confirm_timeout".to_string(),
            DeviceErrorCode::Internal => "internal".to_string(),
            DeviceErrorCode::Unknown(code) => code.clone(),
        }
    }

    /// 是否协议级错误码（M6 §6.2.1：配对/认证/版本/帧/传输域）
    pub fn is_protocol_level(&self) -> bool {
        matches!(
            self,
            DeviceErrorCode::PairInvalidCode
                | DeviceErrorCode::PairExpired
                | DeviceErrorCode::PairUsed
                | DeviceErrorCode::PairTooManyAttempts
                | DeviceErrorCode::PairChallengeMismatch
                | DeviceErrorCode::PairNoChallenge
                | DeviceErrorCode::PairRegistryFull
                | DeviceErrorCode::AuthBadSignature
                | DeviceErrorCode::AuthDeviceRevoked
                | DeviceErrorCode::AuthUnknownDevice
                | DeviceErrorCode::AuthUnknownDesktop
                | DeviceErrorCode::AuthExpired
                | DeviceErrorCode::AuthStale
                | DeviceErrorCode::AuthRotateConflict
                | DeviceErrorCode::VersionMismatch
                | DeviceErrorCode::FrameTooLarge
                | DeviceErrorCode::TransportClosed
        )
    }

    /// 是否允许自动重试（静态表；`retryable=true` 才允许，D3 §6.2 / M6 §6.2）
    pub fn retryable(&self) -> bool {
        matches!(
            self,
            DeviceErrorCode::AuthExpired
                | DeviceErrorCode::AuthStale
                | DeviceErrorCode::AuthRotateConflict
                | DeviceErrorCode::TransportClosed
                | DeviceErrorCode::CmdEngineNotReady
                | DeviceErrorCode::CmdRestoreInProgress
                | DeviceErrorCode::CmdSessionBusy
                | DeviceErrorCode::CmdTimeout
                | DeviceErrorCode::CmdTooManyRequests
                | DeviceErrorCode::StreamTooManyStreams
                | DeviceErrorCode::Internal
        )
    }

    /// 桌面 Command Adapter 的 CoreError 映射（M6 §6.2.3）
    ///
    /// - InvalidInput：detail 含 `workspace_not_granted` → file.not_granted；
    ///   `file_exists` / `binary_file` / `unsupported_encoding` → 对应 file.*
    ///   码；其余 → cmd.invalid；
    /// - NotFound：审批域语义升级为 cmd.approval_mismatch（携带冲突信号）；
    /// - Cancelled → cmd.cancelled；Encoding → file.encoding；
    /// - Io → internal；Internal：含 "engine not ready" → cmd.engine_not_ready。
    pub fn from_core_error(err: &crate::CoreError) -> Self {
        match err {
            crate::CoreError::InvalidInput(detail) => {
                if detail.contains("workspace_not_granted") {
                    DeviceErrorCode::FileNotGranted
                } else if detail.contains("file_exists") {
                    DeviceErrorCode::FileExists
                } else if detail.contains("binary_file") {
                    DeviceErrorCode::FileBinary
                } else if detail.contains("unsupported_encoding") {
                    DeviceErrorCode::FileEncoding
                } else {
                    DeviceErrorCode::CmdInvalid
                }
            }
            crate::CoreError::NotFound(detail) => {
                // 审批域 NotFound 升级为冲突信号（F2 §11.2）
                if detail.contains("approval") || detail.contains("pending") {
                    DeviceErrorCode::CmdApprovalMismatch
                } else {
                    DeviceErrorCode::CmdNotFound
                }
            }
            crate::CoreError::Cancelled => DeviceErrorCode::CmdCancelled,
            crate::CoreError::Encoding(_) => DeviceErrorCode::FileEncoding,
            crate::CoreError::Io(_) => DeviceErrorCode::Internal,
            crate::CoreError::Internal(msg) => {
                if msg.to_lowercase().contains("engine not ready") {
                    DeviceErrorCode::CmdEngineNotReady
                } else {
                    DeviceErrorCode::Internal
                }
            }
        }
    }
}

/// 统一错误载荷（M6 §10.1 $defs.ErrorBody；result.error / error 消息 /
/// stream.close 共用）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBody {
    /// 跨端错误码（`<域>.<子类>`）
    pub code: DeviceErrorCode,
    /// 人读错误信息（≤512 字符）
    pub message: String,
    /// 是否允许自动重试
    pub retryable: bool,
    /// 被拒绝请求的 msgId（响应类错误）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub req_msg_id: Option<String>,
    /// 附加诊断（detail.kind 记录原 CoreError kind 供诊断；不透传内部码）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<serde_json::Value>,
}

impl ErrorBody {
    /// 构造错误载荷（retryable 由错误码静态表推导）
    pub fn new(code: DeviceErrorCode, message: impl Into<String>) -> Self {
        let retryable = code.retryable();
        Self {
            code,
            message: message.into(),
            retryable,
            req_msg_id: None,
            detail: None,
        }
    }

    /// 关联请求 msgId（响应类错误）
    pub fn with_req_msg_id(mut self, req_msg_id: impl Into<String>) -> Self {
        self.req_msg_id = Some(req_msg_id.into());
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_code_wire_values() {
        assert_eq!(
            DeviceErrorCode::CmdApprovalMismatch.as_str(),
            "cmd.approval_mismatch"
        );
        assert_eq!(DeviceErrorCode::PairExpired.as_str(), "pair.expired");
        assert_eq!(
            DeviceErrorCode::VersionMismatch.as_str(),
            "version_mismatch"
        );
        assert_eq!(
            DeviceErrorCode::Unknown("future.code".into()).as_str(),
            "future.code"
        );
        // wire 序列化
        let json = serde_json::to_value(&DeviceErrorCode::StreamCursorStale).unwrap();
        assert_eq!(json, "stream.cursor_stale");
        // 反序列化还原 + Unknown 兜底
        let back: DeviceErrorCode = serde_json::from_str("\"cmd.denied\"").unwrap();
        assert_eq!(back, DeviceErrorCode::CmdDenied);
        let unknown: DeviceErrorCode = serde_json::from_str("\"future.code\"").unwrap();
        assert_eq!(unknown, DeviceErrorCode::Unknown("future.code".into()));
    }

    #[test]
    fn retryable_table() {
        assert!(DeviceErrorCode::CmdTimeout.retryable());
        assert!(DeviceErrorCode::CmdEngineNotReady.retryable());
        assert!(DeviceErrorCode::AuthStale.retryable());
        assert!(DeviceErrorCode::Internal.retryable());
        assert!(DeviceErrorCode::StreamTooManyStreams.retryable());
        assert!(!DeviceErrorCode::CmdApprovalMismatch.retryable());
        assert!(!DeviceErrorCode::PairExpired.retryable());
        assert!(!DeviceErrorCode::VersionMismatch.retryable());
        assert!(!DeviceErrorCode::CmdDenied.retryable());
        assert!(!DeviceErrorCode::FileNotGranted.retryable());
    }

    #[test]
    fn protocol_level_classification() {
        assert!(DeviceErrorCode::AuthBadSignature.is_protocol_level());
        assert!(DeviceErrorCode::FrameTooLarge.is_protocol_level());
        assert!(DeviceErrorCode::PairInvalidCode.is_protocol_level());
        assert!(!DeviceErrorCode::CmdInvalid.is_protocol_level());
        assert!(!DeviceErrorCode::Internal.is_protocol_level());
    }

    #[test]
    fn all_error_codes_count_and_unique() {
        assert_eq!(ALL_ERROR_CODES.len(), 45);
        let unique: std::collections::HashSet<&str> = ALL_ERROR_CODES.iter().copied().collect();
        assert_eq!(unique.len(), ALL_ERROR_CODES.len());
        // 枚举 as_str 与注册表全表一致
        for code in ALL_ERROR_CODES {
            let parsed: DeviceErrorCode = serde_json::from_str(&format!("\"{code}\"")).unwrap();
            assert_eq!(parsed.as_str(), code);
        }
    }

    #[test]
    fn error_body_roundtrip() {
        let body = ErrorBody::new(
            DeviceErrorCode::CmdApprovalMismatch,
            "该请求已被其他设备处理或已过期",
        )
        .with_req_msg_id("m-iph-001-12");
        let json = serde_json::to_value(&body).unwrap();
        assert_eq!(json["code"], "cmd.approval_mismatch");
        assert_eq!(json["message"], "该请求已被其他设备处理或已过期");
        assert_eq!(json["retryable"], false);
        assert_eq!(json["reqMsgId"], "m-iph-001-12");
        assert!(json.get("detail").is_none());

        let back: ErrorBody = serde_json::from_str(&serde_json::to_string(&body).unwrap()).unwrap();
        assert_eq!(body, back);
        assert!(!back.retryable);
    }

    #[test]
    fn error_body_retryable_from_code() {
        let body = ErrorBody::new(DeviceErrorCode::CmdTimeout, "超时");
        assert!(body.retryable);
    }

    #[test]
    fn from_core_error_mapping() {
        use crate::CoreError;

        assert_eq!(
            DeviceErrorCode::from_core_error(&CoreError::NotFound("run not found".into())),
            DeviceErrorCode::CmdNotFound
        );
        // 审批域 NotFound 升级为冲突信号
        assert_eq!(
            DeviceErrorCode::from_core_error(&CoreError::NotFound("approval pending set".into())),
            DeviceErrorCode::CmdApprovalMismatch
        );
        assert_eq!(
            DeviceErrorCode::from_core_error(&CoreError::InvalidInput("bad id".into())),
            DeviceErrorCode::CmdInvalid
        );
        assert_eq!(
            DeviceErrorCode::from_core_error(&CoreError::InvalidInput(
                "workspace_not_granted".into()
            )),
            DeviceErrorCode::FileNotGranted
        );
        assert_eq!(
            DeviceErrorCode::from_core_error(&CoreError::InvalidInput("file_exists".into())),
            DeviceErrorCode::FileExists
        );
        assert_eq!(
            DeviceErrorCode::from_core_error(&CoreError::InvalidInput("binary_file".into())),
            DeviceErrorCode::FileBinary
        );
        assert_eq!(
            DeviceErrorCode::from_core_error(&CoreError::Cancelled),
            DeviceErrorCode::CmdCancelled
        );
        assert_eq!(
            DeviceErrorCode::from_core_error(&CoreError::Encoding("gbk".into())),
            DeviceErrorCode::FileEncoding
        );
        assert_eq!(
            DeviceErrorCode::from_core_error(&CoreError::Io("io error".into())),
            DeviceErrorCode::Internal
        );
        assert_eq!(
            DeviceErrorCode::from_core_error(&CoreError::Internal("engine not ready yet".into())),
            DeviceErrorCode::CmdEngineNotReady
        );
        assert_eq!(
            DeviceErrorCode::from_core_error(&CoreError::Internal("db locked".into())),
            DeviceErrorCode::Internal
        );
    }
}
