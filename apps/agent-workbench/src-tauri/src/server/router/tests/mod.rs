//! router 测试：公共 fixture（测试状态 / 令牌 / 请求构造 / 内存后端 MockBackend）

use super::guard::{ensure_command_execution_allowed, error_response, secret_command_hit};
use super::*;
use crate::server::auth::{sha256_hex, TokenStore};
use crate::server::backend::{ApiBackend, SettingsUpdateParams};
use crate::server::ServerError;
use crate::server::{ServerConfig, ServerHandle};
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{StatusCode, Uri};
use conex_types::device::commands::{SettingsConfirmAction, SettingsConfirmStatus};
use conex_types::device::commands::{
    SettingsConfirmParams, SettingsConfirmResult, TaskOutputParams, TaskOutputResult,
};
use conex_types::device::version::PAGE_SIZE_DEFAULT;
use conex_types::device::{
    CommandSurface, FileSearchHit, ManifestEntry, RunTaskParams, RunTaskResult,
};
use conex_types::device::{
    DenyParams, DeviceErrorCode, ErrorBody, EventPageParams, EventPageResult, FlowSnapshotParams,
    FlowSnapshotResult, ListCommandsResult, ListSessionsParams, ListSessionsResult,
    ListTasksParams, ListTasksResult, PauseAutomationParams, PauseAutomationResult,
    RunControlParams, RunEventsParams, RunSnapshotParams, RunSnapshotResult, SearchFilesParams,
    SearchFilesResult, SearchIndexResult,
};
use conex_types::SessionIndexEntry;
use std::net::SocketAddr;
use std::sync::Arc;
use tower::ServiceExt;

mod auth;
mod mock_backend;
mod pair_preview;
mod r2_12;
mod read_endpoints;
mod secret_surface;
mod write_endpoints;

/// 每测试独立令牌文件序号（并发测试共享同一 pairing.json 会竞态
/// tmp rename——auth.rs save 的原子写先例在单进程多线程测试下需
/// 每测试唯一路径隔离）
static TOKEN_FILE_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 测试路由状态（临时目录独立令牌库 + 可选内存后端）
fn test_state_with(backend: Option<MockBackend>) -> ServerState {
    let backend = backend.map(|b| Arc::new(b) as Arc<dyn ApiBackend>);
    test_state_from_backend(backend)
}

/// 以注入后的后端引用构造状态（R1-04 写面测试：请求后可经共享
/// Arc 检查 mock 状态——路径 runId 覆盖 / reason 透传 / keys 透传断言）
fn test_state_from_backend(backend: Option<Arc<dyn ApiBackend>>) -> ServerState {
    let config = ServerConfig::new(std::env::temp_dir());
    let handle = ServerHandle::new(config, "127.0.0.1:0".parse().expect("固定测试地址"));
    let seq = TOKEN_FILE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tokens =
        TokenStore::new(std::env::temp_dir().join(format!("pairing-router-test-{seq}.json")));
    ServerState::new(&handle, tokens, backend)
}

/// 无后端路由状态（401 / 未接线 500 测试用）
fn test_state() -> ServerState {
    test_state_with(None)
}

/// 签发测试令牌（鉴权面测试用）
fn issue_token(state: &ServerState) -> String {
    state
        .tokens()
        .lock()
        .unwrap()
        .issue("test-device", now_ms())
        .expect("签发必须成功")
}

/// 带 Bearer 令牌的 GET 请求（tower oneshot 驱动）
fn authed_get(uri: &str, token: &str) -> axum::http::Request<Body> {
    axum::http::Request::builder()
        .uri(uri)
        .header(axum::http::header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap()
}

/// 带 Bearer 令牌 + JSON body 的写请求（R1-04 写面测试）
fn authed_body(
    method: &str,
    uri: &str,
    token: &str,
    body: serde_json::Value,
) -> axum::http::Request<Body> {
    axum::http::Request::builder()
        .uri(uri)
        .method(method)
        .header(axum::http::header::AUTHORIZATION, format!("Bearer {token}"))
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

/// 读取响应 JSON 载荷
async fn json_body(response: axum::response::Response) -> serde_json::Value {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

/// 测试事件流（sequence 1..=count；sessionId/runId 固定）
fn events(count: u64) -> Vec<serde_json::Value> {
    (1..=count)
        .map(|seq| {
            serde_json::json!({
                "type": "agent-start",
                "sessionId": "s-1",
                "sequence": seq,
                "schemaVersion": 1,
                "runId": "r-1",
                "timestamp": "2026-01-01T00:00:00Z",
            })
        })
        .collect()
}

/// 内存后端（router 测试驱动：可编程事件流 + 可编程错误；语义对齐
/// core_query_commands 契约体——游标分页 / 未知 id 404 / 错误映射；
/// R1-04 扩展写面：审批幂等（已裁决集合）+ runTask clientMessageId
/// 幂等 + 路径 runId 覆盖观测）
struct MockBackend {
    /// 会话事件流（按 sequence 升序；分页契约体）
    events: Vec<serde_json::Value>,
    /// 任务输出行（afterLine 偏移分页）
    lines: Vec<String>,
    /// 可编程错误（Some → 全部命令方法返回该错误；错误映射测试用）
    failure: Option<ServerError>,
    /// 已裁决的 tool_call_id（approve/deny 幂等语义：首次成功、重复
    /// 决策 → cmd.approval_mismatch 冲突信号）
    resolved: std::sync::Mutex<std::collections::HashSet<String>>,
    /// client_message_id → run_id（runTask 幂等：重发回显首次结果）
    run_ids: std::sync::Mutex<std::collections::HashMap<String, String>>,
    /// 最近一次 run_control 收到的参数（路径 runId 覆盖断言）
    last_run_control: std::sync::Mutex<Option<RunControlParams>>,
    /// 最近一次 deny 收到的原因（reason 透传断言）
    last_deny_reason: std::sync::Mutex<Option<String>>,
    /// 最近一次 settings_get 收到的 keys（keys 透传断言）
    last_settings_keys: std::sync::Mutex<Option<Vec<String>>>,
    /// 最近一次 run_task 收到的权限模式申报（R1-10 T-08：远程申报
    /// 原样抵达后端装配面——降级由 apply_remote_mode 在装配面执行）
    last_run_permission_mode: std::sync::Mutex<Option<conex_types::device::PermissionMode>>,
    /// 最近一次 search_files 收到的参数（R2-12c C21 透传断言）
    last_search_files: std::sync::Mutex<Option<SearchFilesParams>>,
    /// 最近一次 settings_confirm 收到的参数（R2-12c C30 透传断言）
    last_settings_confirm: std::sync::Mutex<Option<SettingsConfirmParams>>,
    /// 最近一次 pause_automation 收到的 duration_sec（R2-12c C31
    /// 透传断言）
    last_pause_duration: std::sync::Mutex<Option<u32>>,
}

impl MockBackend {
    /// 默认后端：5 条事件 + 100 行任务输出
    fn new() -> Self {
        Self {
            events: events(5),
            lines: (0..100).map(|i| format!("line {i}")).collect(),
            failure: None,
            resolved: std::sync::Mutex::new(std::collections::HashSet::new()),
            run_ids: std::sync::Mutex::new(std::collections::HashMap::new()),
            last_run_control: std::sync::Mutex::new(None),
            last_deny_reason: std::sync::Mutex::new(None),
            last_settings_keys: std::sync::Mutex::new(None),
            last_run_permission_mode: std::sync::Mutex::new(None),
            last_search_files: std::sync::Mutex::new(None),
            last_settings_confirm: std::sync::Mutex::new(None),
            last_pause_duration: std::sync::Mutex::new(None),
        }
    }

    /// 指定事件数的后端（页大小 / 夹紧测试用）
    fn with_events(count: u64) -> Self {
        Self {
            events: events(count),
            lines: Vec::new(),
            failure: None,
            resolved: std::sync::Mutex::new(std::collections::HashSet::new()),
            run_ids: std::sync::Mutex::new(std::collections::HashMap::new()),
            last_run_control: std::sync::Mutex::new(None),
            last_deny_reason: std::sync::Mutex::new(None),
            last_settings_keys: std::sync::Mutex::new(None),
            last_run_permission_mode: std::sync::Mutex::new(None),
            last_search_files: std::sync::Mutex::new(None),
            last_settings_confirm: std::sync::Mutex::new(None),
            last_pause_duration: std::sync::Mutex::new(None),
        }
    }

    /// 可编程错误后端（失败路径测试用）
    fn failing(code: DeviceErrorCode) -> Self {
        Self {
            events: Vec::new(),
            lines: Vec::new(),
            failure: Some(ServerError::protocol(code, "mock 可编程错误")),
            resolved: std::sync::Mutex::new(std::collections::HashSet::new()),
            run_ids: std::sync::Mutex::new(std::collections::HashMap::new()),
            last_run_control: std::sync::Mutex::new(None),
            last_deny_reason: std::sync::Mutex::new(None),
            last_settings_keys: std::sync::Mutex::new(None),
            last_run_permission_mode: std::sync::Mutex::new(None),
            last_search_files: std::sync::Mutex::new(None),
            last_settings_confirm: std::sync::Mutex::new(None),
            last_pause_duration: std::sync::Mutex::new(None),
        }
    }

    /// 可编程错误短路
    fn fail(&self) -> Result<(), ServerError> {
        self.failure.clone().map_or(Ok(()), Err)
    }

    /// 未知会话 404（对齐 core_read_session_events 的 NotFound 语义）
    fn not_found(detail: &str) -> ServerError {
        ServerError::protocol(DeviceErrorCode::CmdNotFound, detail)
    }

    /// 游标分页（对齐 EventPage 契约：开区间过滤 → 截取 → nextAfter）
    fn paginate(&self, after: u64, max: usize) -> EventPageResult {
        let tail: Vec<_> = self
            .events
            .iter()
            .filter(|e| e["sequence"].as_u64().unwrap_or(0) > after)
            .cloned()
            .collect();
        let has_more = tail.len() > max;
        let page: Vec<_> = tail.into_iter().take(max).collect();
        let next = page
            .last()
            .and_then(|e| e["sequence"].as_u64())
            .unwrap_or(after);
        EventPageResult {
            events: page,
            next_after_sequence: next,
            has_more,
            latest_sequence: Some(
                self.events
                    .last()
                    .and_then(|e| e["sequence"].as_u64())
                    .unwrap_or(0),
            ),
        }
    }
}

impl MockBackend {
    /// 审批决策（幂等语义：首次成功并记入已裁决集合；重复决策 →
    /// cmd.approval_mismatch 冲突信号——M6 §1.3 / F2 §11.2；
    /// 从未出现的 tool_call_id → cmd.not_found）
    fn decide(
        &self,
        tool_call_id: &str,
        decision: &'static str,
    ) -> Result<conex_types::device::ApproveResult, ServerError> {
        if tool_call_id == "tc-missing" {
            return Err(Self::not_found("tool_call_id 从未出现（mock）"));
        }
        let mut resolved = self.resolved.lock().unwrap();
        if resolved.contains(tool_call_id) {
            return Err(ServerError::protocol(
                DeviceErrorCode::CmdApprovalMismatch,
                format!("该请求已被处理或已过期：{tool_call_id}"),
            ));
        }
        resolved.insert(tool_call_id.to_string());
        Ok(conex_types::device::ApproveResult {
            ok: true,
            tool_call_id: tool_call_id.to_string(),
            decision: serde_json::from_value(serde_json::Value::String(decision.to_string()))
                .expect("决策规范值"),
        })
    }

    /// 参数非法（cmd.invalid 400）
    fn invalid(detail: &str) -> ServerError {
        ServerError::protocol(DeviceErrorCode::CmdInvalid, detail)
    }
}
