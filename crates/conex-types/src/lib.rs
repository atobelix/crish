use serde::{Deserialize, Serialize};

// ===== 域模块（Round 5/6 拆分层；与 TS shared-types 对齐）=====
// 消费方同时使用模块路径（conex_types::events::AgentEvent）与根级重导出
// （conex_types::AgentEvent），两形并存；本处为唯一接线点。

pub mod checkpoint;
pub mod context;
pub mod cron;
pub mod denied_stats;
pub mod device;
pub mod error;
pub mod events;
pub mod history;
pub mod impact;
pub mod message;
pub mod response;
pub mod session;
pub mod timer;
pub mod tool;
pub mod transition;

// codes 常量集在 error.rs 内（`pub mod codes`），根级重导出供
// orchestrator / 壳命令面以 `conex_types::codes` 引用（R6 接线点）。
pub use checkpoint::{
    CHECKPOINT_CORRUPT_SIGNAL, CHECKPOINT_MARKER, CHECKPOINT_PAYLOAD_KEY,
    CHECKPOINT_PRESENT_SIGNAL, CONEX_CHECKPOINT_MARKER, CheckpointError, CheckpointPayload,
    LeafCheckpointState,
};
pub use context::{CONTEXT_SAFETY_TOKENS, ContextBudget, SessionContextMeta};
pub use cron::{CronError, CronField, CronSchedule};
pub use denied_stats::{DeniedStats, DeniedStatsSummary, global_denied_stats};
pub use error::codes;

pub use error::{
    CrishError, CrishErrorCategory, CrishErrorPayload, MigrateErrorContext, ProviderErrorKind,
    RunTerminal, RunTerminalError, migrate_error_code,
};
pub use events::{
    AgentEvent, AgentEventEnvelope, ApprovalDecision, BackpressureLevel, DropClass,
    EVENT_ENVELOPE_SCHEMA_VERSION, EventPolicy, MissAttribution, PermissionBehavior,
    PermissionDecision, PermissionRequest, PersistenceDecision, RunCacheStats, RunTerminalStatus,
    SecurityAuditDecision, SecurityAuditOperation, SubagentEndStatus, SubagentEventKind,
    SubagentEventPayload, ToolMetadata, TurnUsage,
};
pub use history::HistoryMessage;
pub use impact::{IMPACT_FLAG_FILE_THRESHOLD, ImpactAssessment};
pub use message::{AgentMessage, AgentMessageBlock, AgentMessageRole, ToolCallBlock};
pub use response::{ClassifiedStreamError, ProviderOutput};
pub use session::{AgentEndReason, AgentSessionContext, AgentSessionEvent, AgentSessionState};
pub use timer::{TimerCondition, TimerDeclaration, TimerHandle};
pub use tool::{
    ContextCompressionRecord, ContextCompressionReason, ContextCompressionTrigger,
    ProviderDiagnostic, ProviderDiagnosticPhase, RuntimeCheckpointKind, RuntimeCheckpointRecord,
    RuntimeCheckpointRestoreRecord, SystemPromptWireMode, ToolArtifact, ToolArtifactKind,
    ToolBatchCall, ToolBatchResult, ToolCategory, ToolConcurrency, ToolOutput, ToolProgressUpdate,
};
pub use transition::{AgentTransition, AgentTransitionEffect, TransitionError};

// ===== 多端互通设备域（R0-02；D3 §12.2 / M6 §12.1 落位）=====
// 消费方以 conex_types::device::* 模块路径引用为主；根级重导出核心信封与
// 错误类型（DeviceEnvelope/MessageKind/AuthHeader/DeviceErrorCode/ErrorBody/
// CommandRequest/CommandResult/PairCode），与 events 域两形并存惯例一致。
pub use device::commands::{CommandRequest, CommandResult};
pub use device::envelope::{AuthHeader, DeviceEnvelope, DeviceEndpoint, MessageKind};
pub use device::error::{DeviceErrorCode, ErrorBody};
pub use device::pair::PairCode;

// ===== Diff Types (对齐 rustCore.ts DiffResult/DiffHunk/DiffLine) =====

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffResult {
    pub hunks: Vec<DiffHunk>,
    pub added_lines: usize,
    pub removed_lines: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub old_start: usize,
    pub old_lines: usize,
    pub new_start: usize,
    pub new_lines: usize,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub content: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiffLineKind {
    Context,
    Addition,
    Deletion,
}

// ===== Search Types (对齐 rustCore.ts FileHit) =====

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    pub path: String,
    pub score: i32,
    pub match_indices: Vec<usize>,
}

// ===== Message / Compaction Types (对齐 rustCore.ts Message/CompactionResult) =====

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompactionResult {
    pub messages: Vec<Message>,
    pub tokens_consumed: usize,
    pub cache_hit_rate_optimized: bool,
}

// ===== IPC Types (Round 2 使用) =====

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IpcEnvelope {
    pub id: String,
    pub method: String,
    pub payload: serde_json::Value,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IpcResponse {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ===== Stream Types (Round 2 使用) =====

#[derive(Debug, Clone, PartialEq)]
pub struct StreamChunk {
    pub data: Vec<u8>,
    pub is_final: bool,
}

// ===== Session Persistence Types (对齐 crish-desktop store/types.ts) =====

/// 会话内一条用户或助手消息（对齐 SessionMessage in store/types.ts L344-370）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionMessage {
    pub id: String,
    /// "user" | "assistant"
    pub sender: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    /// epoch ms
    pub timestamp: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_text_offset: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_time: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls_json: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocks_json: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_results_json: Option<String>,
    /// 消息级 usage 快照（v5 列 usage_json 的投影，P5 C8）。
    /// 内容为前端写入的 camelCase CacheUsage JSON 原样透传（如
    /// `{"promptTokens":12000,"cacheReadTokens":9000}`），Rust 侧不转换
    /// 不解析，解析/派生在回读面完成；无快照（含全零，C15）→ None 不落库。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<String>,
}

/// 协作子 agent（对齐 SessionAgent in store/types.ts L383-405）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionAgent {
    pub id: String,
    pub subagent_run_id: String,
    pub parent_session_id: String,
    pub parent_run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_tool_call_id: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub mode: String,
    /// running | completed | failed | stopped
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default)]
    pub messages: Vec<SessionMessage>,
    /// epoch ms
    pub started_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub depth: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_path_json: Option<String>,
    /// 任务类型（wire kebab-case 六枚举，T-D-07；v6 新列；驱动系统默认
    /// 权限集的落库快照，展示/审计用——权限判定在引擎侧按默认集装配）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_type: Option<String>,
    /// 角色展示标签（2-5 字自由文本，仅展示不影响调度，T-D-05；v6 新列）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_label: Option<String>,
    /// 显式写路径白名单（JSON 字符串数组，硬沙箱消费输入，T-D-07；v6 新列）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_write_paths_json: Option<String>,
    /// 子会话 id（D-02 LK-04 反向导航键：`sub-sess-{depth}-{n}` 命名，
    /// spawner 落库；子会话行经本列反查 session_agents 行——parent_run_id /
    /// parent_tool_call_id 回父会话；v9 新列，旧行空串/未接线 = None）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sub_session_id: Option<String>,
}

/// 会话索引条目（对齐 SessionIndexEntry in sessionPersistenceTypes.ts L20-36）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionIndexEntry {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default = "default_session_folder")]
    pub folder: String,
    #[serde(default)]
    pub is_pinned: bool,
    #[serde(default)]
    pub is_archived: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_parent_id: Option<String>,
    #[serde(default)]
    pub timestamp: String,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub message_count: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_message_ids: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_cursor: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_last_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hydrated_from_engine: Option<bool>,
}

fn default_session_folder() -> String {
    "常规会话".to_string()
}

/// 数据迁移统计
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportStats {
    #[serde(default)]
    pub sessions: u64,
    #[serde(default)]
    pub messages: u64,
    #[serde(default)]
    pub agents: u64,
}

/// Tauri 命令统一错误协议（对齐 Stream B 契约 5.2）
///
/// 使用 `#[serde(tag = "kind", content = "detail")]` 让 JS 侧可按 `error.kind`
/// 分类处理，`error.detail` 携带具体信息。Cancelled 无 detail。
/// 同时实现 Deserialize 以支持测试 roundtrip 与未来 IPC 双向传输。
#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
#[serde(tag = "kind", content = "detail")]
pub enum CoreError {
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("encoding error: {0}")]
    Encoding(String),
    #[error("io error: {0}")]
    Io(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("cancelled")]
    Cancelled,
    #[error("internal: {0}")]
    Internal(String),
}

impl CoreError {
    pub fn invalid_input(msg: impl Into<String>) -> Self {
        Self::InvalidInput(msg.into())
    }

    pub fn internal(msg: impl Into<String>) -> Self {
        Self::Internal(msg.into())
    }
}

// ===== Tests =====

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_result_serializes_to_camel_case() {
        let result = DiffResult {
            hunks: vec![DiffHunk {
                old_start: 1,
                old_lines: 3,
                new_start: 1,
                new_lines: 4,
                lines: vec![
                    DiffLine { kind: DiffLineKind::Context, content: "hello".into() },
                    DiffLine { kind: DiffLineKind::Deletion, content: "old".into() },
                    DiffLine { kind: DiffLineKind::Addition, content: "new".into() },
                ],
            }],
            added_lines: 1,
            removed_lines: 1,
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["addedLines"], 1);
        assert_eq!(json["removedLines"], 1);
        assert_eq!(json["hunks"][0]["oldStart"], 1);
        assert_eq!(json["hunks"][0]["newLines"], 4);
        assert_eq!(json["hunks"][0]["lines"][0]["kind"], "Context");
        assert_eq!(json["hunks"][0]["lines"][1]["kind"], "Deletion");
    }

    #[test]
    fn diff_result_roundtrip() {
        let result = DiffResult {
            hunks: vec![],
            added_lines: 0,
            removed_lines: 0,
        };
        let json = serde_json::to_string(&result).unwrap();
        let back: DiffResult = serde_json::from_str(&json).unwrap();
        assert_eq!(result, back);
    }

    #[test]
    fn file_hit_serializes_to_camel_case() {
        let hit = FileHit {
            path: "src/main.rs".into(),
            score: 95,
            match_indices: vec![0, 4, 8],
        };
        let json = serde_json::to_value(&hit).unwrap();
        assert_eq!(json["path"], "src/main.rs");
        assert_eq!(json["score"], 95);
        assert_eq!(json["matchIndices"], serde_json::json!([0, 4, 8]));
    }

    #[test]
    fn file_hit_roundtrip() {
        let hit = FileHit {
            path: "test.ts".into(),
            score: 42,
            match_indices: vec![1, 3],
        };
        let json = serde_json::to_string(&hit).unwrap();
        let back: FileHit = serde_json::from_str(&json).unwrap();
        assert_eq!(hit, back);
    }

    #[test]
    fn message_serializes_with_optional_images() {
        let msg = Message {
            id: "m1".into(),
            role: "user".into(),
            content: "hello".into(),
            images: None,
        };
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["id"], "m1");
        assert_eq!(json["role"], "user");
        assert!(json.get("images").is_none());

        let msg_with_images = Message {
            id: "m2".into(),
            role: "assistant".into(),
            content: "see image".into(),
            images: Some(vec!["img.png".into()]),
        };
        let json2 = serde_json::to_value(&msg_with_images).unwrap();
        assert_eq!(json2["images"][0], "img.png");
    }

    #[test]
    fn compaction_result_serializes_to_camel_case() {
        let result = CompactionResult {
            messages: vec![],
            tokens_consumed: 150,
            cache_hit_rate_optimized: true,
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["tokensConsumed"], 150);
        assert_eq!(json["cacheHitRateOptimized"], true);
    }

    #[test]
    fn ipc_envelope_roundtrip() {
        let envelope = IpcEnvelope {
            id: "req-1".into(),
            method: "search".into(),
            payload: serde_json::json!({"query": "test"}),
            timestamp: 1700000000,
        };
        let json = serde_json::to_string(&envelope).unwrap();
        let back: IpcEnvelope = serde_json::from_str(&json).unwrap();
        assert_eq!(envelope, back);
    }

    #[test]
    fn ipc_response_skips_none_fields() {
        let resp = IpcResponse {
            id: "req-1".into(),
            result: Some(serde_json::json!({"ok": true})),
            error: None,
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert!(json.get("error").is_none());
        assert_eq!(json["result"]["ok"], true);
    }

    #[test]
    fn session_message_serializes_to_camel_case() {
        let msg = SessionMessage {
            id: "m1".into(),
            sender: "user".into(),
            text: Some("hello".into()),
            thinking: None,
            timestamp: 1700000000,
            status: Some("completed".into()),
            stream_text_offset: None,
            thinking_time: Some(120),
            tool_calls_json: None,
            blocks_json: None,
            tool_call_results_json: None,
            usage: None,
        };
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["id"], "m1");
        assert_eq!(json["sender"], "user");
        assert_eq!(json["text"], "hello");
        assert_eq!(json["timestamp"], 1700000000);
        assert_eq!(json["status"], "completed");
        assert_eq!(json["thinkingTime"], 120);
        // None 字段应被跳过
        assert!(json.get("thinking").is_none());
        assert!(json.get("streamTextOffset").is_none());
        assert!(json.get("toolCallsJson").is_none());
        assert!(json.get("usage").is_none());
    }

    #[test]
    fn session_message_roundtrip() {
        let msg = SessionMessage {
            id: "m1".into(),
            sender: "assistant".into(),
            text: Some("hi".into()),
            thinking: Some("reasoning".into()),
            timestamp: 1700000001,
            status: None,
            stream_text_offset: Some(10),
            thinking_time: None,
            tool_calls_json: Some(r#"[]"#.into()),
            blocks_json: None,
            tool_call_results_json: None,
            usage: Some(r#"{"promptTokens":12000,"cacheReadTokens":9000}"#.into()),
        };
        let json = serde_json::to_string(&msg).unwrap();
        let back: SessionMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
        // usage 线上键为 camelCase 原形（透传字符串，Rust 侧不解析）
        let value = serde_json::to_value(&msg).unwrap();
        assert_eq!(
            value["usage"],
            r#"{"promptTokens":12000,"cacheReadTokens":9000}"#
        );
    }

    #[test]
    fn session_message_accepts_legacy_field_names() {
        // 旧 JS 端写入的 JSON 应能被反序列化
        let raw = r#"{"id":"m1","sender":"user","text":"hi","timestamp":100,"thinkingTime":5}"#;
        let msg: SessionMessage = serde_json::from_str(raw).unwrap();
        assert_eq!(msg.id, "m1");
        assert_eq!(msg.thinking_time, Some(5));
    }

    #[test]
    fn session_message_usage_absent_deserializes_to_none() {
        // 旧数据（无 usage 键）反序列化 → None，不炸
        let raw = r#"{"id":"m1","sender":"user","text":"hi","timestamp":100}"#;
        let msg: SessionMessage = serde_json::from_str(raw).unwrap();
        assert_eq!(msg.usage, None);
        // 携带 usage 键（前端契约形状）→ 原样透传字符串
        let raw2 = r#"{"id":"m2","sender":"assistant","timestamp":101,
                       "usage":"{\"promptTokens\":12000,\"cacheReadTokens\":9000}"}"#;
        let msg2: SessionMessage = serde_json::from_str(raw2).unwrap();
        assert_eq!(
            msg2.usage.as_deref(),
            Some(r#"{"promptTokens":12000,"cacheReadTokens":9000}"#)
        );
    }

    #[test]
    fn session_agent_roundtrip_with_messages() {
        let agent = SessionAgent {
            id: "a1".into(),
            subagent_run_id: "run-1".into(),
            parent_session_id: "s1".into(),
            parent_run_id: "prun-1".into(),
            parent_tool_call_id: Some("tc-1".into()),
            description: "explore".into(),
            mode: "explore".into(),
            status: "completed".into(),
            summary: Some("done".into()),
            messages: vec![SessionMessage {
                id: "am1".into(),
                sender: "assistant".into(),
                text: Some("ok".into()),
                thinking: None,
                timestamp: 100,
                status: None,
                stream_text_offset: None,
                thinking_time: None,
                tool_calls_json: None,
                blocks_json: None,
                tool_call_results_json: None,
                usage: None,
            }],
            started_at: 50,
            ended_at: Some(150),
            depth: Some(0),
            subagent_path_json: Some(r#"["a1"]"#.into()),
            task_type: Some("analysis".into()),
            display_label: Some("Rust 内核分析师".into()),
            allowed_write_paths_json: Some(r#"["docs/notes"]"#.into()),
            sub_session_id: Some("sub-sess-0-1".into()),
        };
        let json = serde_json::to_string(&agent).unwrap();
        let back: SessionAgent = serde_json::from_str(&json).unwrap();
        assert_eq!(agent, back);
        assert_eq!(back.messages.len(), 1);
        // D-02 LK-04 S5 测钉：wire 键 camelCase 显式断言（subSessionId 键名
        // 契约锚——前端行级反查依赖该键，防 rename 漂移）
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(
            value["subSessionId"], "sub-sess-0-1",
            "SessionAgent wire 键必须为 camelCase subSessionId"
        );
        assert_eq!(value["parentToolCallId"], "tc-1", "既有 camelCase 键不回归");
        // 缺省兼容：旧载荷无新字段 → 反序列化为 None
        let legacy = r#"{"id":"a1","subagentRunId":"r1","parentSessionId":"s1",
                         "parentRunId":"p1","description":"","mode":"",
                         "status":"completed","messages":[],"startedAt":0}"#;
        let old: SessionAgent = serde_json::from_str(legacy).unwrap();
        assert_eq!(old.task_type, None);
        assert_eq!(old.display_label, None);
        assert_eq!(old.allowed_write_paths_json, None);
        assert_eq!(old.sub_session_id, None, "旧载荷无 subSessionId → None");
    }

    #[test]
    fn session_index_entry_uses_default_folder() {
        let raw = r#"{"id":"s1","title":"t","updatedAt":1,"messageCount":0}"#;
        let entry: SessionIndexEntry = serde_json::from_str(raw).unwrap();
        assert_eq!(entry.folder, "常规会话");
        assert!(!entry.is_pinned);
        assert_eq!(entry.timestamp, "");
    }

    #[test]
    fn session_index_entry_roundtrip() {
        let entry = SessionIndexEntry {
            id: "s1".into(),
            title: "hello".into(),
            folder: "work".into(),
            is_pinned: true,
            is_archived: false,
            branch_parent_id: None,
            timestamp: "2026-01-01T00:00:00Z".into(),
            updated_at: 1700000000,
            message_count: 42,
            pinned_message_ids: Some(r#"["m1"]"#.into()),
            engine_cursor: Some(10),
            engine_last_run_id: Some("run-1".into()),
            hydrated_from_engine: Some(true),
        };
        let json = serde_json::to_string(&entry).unwrap();
        let back: SessionIndexEntry = serde_json::from_str(&json).unwrap();
        assert_eq!(entry, back);
    }

    #[test]
    fn import_stats_default_zero() {
        let stats = ImportStats::default();
        assert_eq!(stats.sessions, 0);
        assert_eq!(stats.messages, 0);
        assert_eq!(stats.agents, 0);
    }

    #[test]
    fn core_error_serializes_as_tagged_enum() {
        let err = CoreError::InvalidInput("bad id".into());
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["kind"], "InvalidInput");
        assert_eq!(json["detail"], "bad id");

        let cancelled = CoreError::Cancelled;
        let json2 = serde_json::to_value(&cancelled).unwrap();
        assert_eq!(json2["kind"], "Cancelled");
        // detail 字段对 unit variant 为 null
        assert!(json2.get("detail").is_none() || json2["detail"].is_null());
    }

    #[test]
    fn core_error_roundtrip() {
        let err = CoreError::Internal("db locked".into());
        let json = serde_json::to_string(&err).unwrap();
        let back: CoreError = serde_json::from_str(&json).unwrap();
        match back {
            CoreError::Internal(msg) => assert_eq!(msg, "db locked"),
            other => panic!("expected Internal, got {other:?}"),
        }
    }
}
