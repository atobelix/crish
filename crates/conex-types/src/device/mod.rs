//! 多端互通设备域类型族（R0-02；D3 §12.2 / M6 §12.1 落位）
//!
//! 跨端协议（D3/M6）的 Rust 类型唯一事实源，与 `contracts/device-protocol.
//! json` 注册表（并行 R0-02a 产出）同源演进，字段命名一致性由 R0-05 对拍
//! 统一——本模块类型形状以 M6 §10 JSON Schema 为准。
//!
//! 模块族：
//! - [envelope]：L3 外层信封 DeviceEnvelope + AuthHeader + 103 kind 注册；
//! - [pair]：配对消息（pair.*）+ 配对码标准化；
//! - [token]：四类令牌格式（T1 配对派生 / T2 账号 / T3 中继 / T4 推送）；
//! - [events]：事件会话面（events.* / session.*）+ 41 变体双面策略映射；
//! - [commands]：37 命令请求/响应类型 + 白名单规格常量表；
//! - [stream]：分块流帧（stream.*）；
//! - [error]：跨端错误码 + ErrorBody + CoreError 映射；
//! - [version]：协议版本协商 + 能力位 + 协议常量表。

pub mod commands;
pub mod envelope;
pub mod error;
pub mod events;
pub mod pair;
pub mod stream;
pub mod token;
pub mod version;

pub use commands::{
    ApproveParams, ApproveResult, ApprovalHistoryItem, ApprovalHistoryParams,
    ApprovalHistoryResult, ApprovalChannel, Arbiter, AssetKind, AssetUrlParams,
    AssetUrlResult, CancelRunParams, CancelRunResult, CheckCommandParams,
    CheckCommandResult, CheckDecision, CommandDomain, CommandRequest, CommandResult,
    CommandSpec, COMMANDS, DenyParams, DeviceChannel, DeviceEntry, DeviceRole,
    DeviceType, DirectoryItem, EventPageParams, EventPageResult, FileSearchHit,
    FileStatParams, FileStatResult, FlowSnapshotParams, FlowSnapshotResult,
    GetSettingsParams, GetSettingsResult, ListCommandsParams, ListCommandsResult,
    ListDevicesParams, ListDevicesResult, ListDirParams, ListDirResult,
    ListPendingApprovalsParams, ListPendingApprovalsResult, ListSessionsParams,
    ListSessionsResult, ListTasksParams, ListTasksResult, ListWorkspacesParams,
    ListWorkspacesResult, MessageDirection, OkResult, PageDirection,
    PairStateParams, PairStateResult, PauseAutomationParams, PauseAutomationResult,
    PendingApproval, PermissionMode, PresenceParams, PresenceResult, REMOTE_KINDS,
    RESULT_KINDS, ReadFileParams, ReadFileResult, RenameDeviceParams,
    RevokeDeviceParams, RunControlLevel, RunControlParams, RunControlResult,
    RunEventsParams, RunSnapshotParams, RunSnapshotResult, RunTaskParams,
    RunTaskResult, SearchFilesParams, SearchFilesResult, SearchIndexParams,
    SearchIndexResult, SearchSessionsParams, SearchSessionsResult,
};
pub use envelope::{
    AuthHeader, DeviceEndpoint, DeviceEnvelope, Heartbeat, HeartbeatOk, MessageKind,
    STATIC_KINDS,
};
pub use error::{ALL_ERROR_CODES, DeviceErrorCode, ErrorBody};
pub use events::{
    AckMode, EventAck, EventRedactStrategy, EventRedactedTuple, EventsPush,
    Granularity, Resume, ResumeDone, ResumePage, ResumeState, SessionCursor,
    SessionRemoved, SessionUpdated, SessionUpdatedAll, Subscribe, SubscribeAll,
    SubscribeOk, SYNC_ELIGIBLE_TYPES, event_cross_strategy, event_is_sync_eligible,
};
pub use pair::{
    DeviceReady, DeviceUnlink, PAIR_CODE_ALPHABET, PAIR_CODE_LENGTH,
    PAIR_CODE_PREFIX, PairAudit, PairAuditEvent, PairChallenge, PairCode,
    PairCodeError, PairHello, PairOk, PairVerify, Platform,
};
pub use stream::{StreamChunk, StreamClose, StreamKind, StreamOpen, StreamResume};
pub use token::{
    AccessTokenClaims, AccountToken, PairingTokenSet, PushRegistration,
    RelayCredential,
};
pub use version::{
    ALL_CAPABILITIES, Capability, CommandSurface, Hello, HelloOk, ManifestEntry,
    ManifestList, MIN_PROTOCOL_VERSION, ProtocolVersion, PROTOCOL_VERSION, Refresh,
    Rotate, negotiate_protocol, versions_compatible,
};

/// bool 缺省 false 时的序列化省略助手（`#[serde(default,
/// skip_serializing_if = "crate::device::skip_false")]`）
pub(crate) fn skip_false(b: &bool) -> bool {
    !*b
}

/// 103 种注册 kind 全量（M6 §1.1 账目：静态 29 + remote 37 + result 37）
///
/// 组装自 [STATIC_KINDS] + [REMOTE_KINDS] + [RESULT_KINDS]（三处各自锁定，
/// 本函数验证合计与唯一性；注册表对拍与 R0-05 校验以此为基准）。
pub fn all_kinds() -> Vec<&'static str> {
    let mut kinds = Vec::with_capacity(103);
    kinds.extend_from_slice(&STATIC_KINDS);
    kinds.extend_from_slice(&REMOTE_KINDS);
    kinds.extend_from_slice(&RESULT_KINDS);
    kinds
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_kinds_are_103_unique() {
        let kinds = all_kinds();
        assert_eq!(kinds.len(), 103, "kind 总数必须为 103（M6 §1.1）");
        let unique: std::collections::HashSet<&str> = kinds.iter().copied().collect();
        assert_eq!(unique.len(), kinds.len(), "kind 必须唯一");
        // 静态 29 + 命令 37 + 响应 37
        assert_eq!(STATIC_KINDS.len() + REMOTE_KINDS.len() + RESULT_KINDS.len(), 103);
        // 每个 kind 都能经 MessageKind 往返
        for kind in kinds {
            let parsed: MessageKind = serde_json::from_str(&format!("\"{kind}\"")).unwrap();
            assert_eq!(parsed.as_str(), kind);
        }
    }

    #[test]
    fn module_re_exports_resolve() {
        // 根级重导出抽查（lib.rs 接线点自检）
        let code = DeviceErrorCode::CmdDenied;
        assert_eq!(code.as_str(), "cmd.denied");
        let hello = Hello {
            protocol_versions: vec![PROTOCOL_VERSION],
            capabilities: None,
            app_version: "0.1.0".into(),
            platform: Platform::Ios,
            resume: None,
        };
        let json = serde_json::to_value(&hello).unwrap();
        assert_eq!(json["protocolVersions"][0], 1);
    }
}
