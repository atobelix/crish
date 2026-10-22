//! 只读查询面 handler（R1-03：info/hello + F1 监控域 C01-C10）

use crate::server::{now_ms, ServerError, ServerState};
use axum::extract::{Path, RawQuery, State};
use axum::Json;
use conex_types::device::commands::{TaskOutputParams, TaskOutputResult};
use conex_types::device::{
    EventPageParams, EventPageResult, FlowSnapshotParams, FlowSnapshotResult, ListCommandsResult,
    ListSessionsParams, ListSessionsResult, ListTasksParams, ListTasksResult, RunEventsParams,
    RunSnapshotParams, RunSnapshotResult, SearchIndexResult,
};

use super::extract::{QueryParams, ServerInfoWire};
use super::guard::{normalize_max_events, require_backend};
use super::HelloInfo;

/// GET /v1/info：服务自报（端口 / 绑定模式 / 配对开关 / 版本 / 能力位）
pub(super) async fn handle_info(State(state): State<ServerState>) -> Json<ServerInfoWire> {
    Json(state.server_info())
}

/// GET /v1/hello：服务时钟基准与握手信息（免鉴权暴露，供客户端计算时差并在重试中自愈）
pub(super) async fn handle_hello(State(state): State<ServerState>) -> Json<HelloInfo> {
    let info = state.server_info();
    Json(HelloInfo {
        server_version: info.version,
        protocol_version: info.protocol_version,
        server_time_ms: now_ms(),
    })
}

/// GET /v1/status：C01 核心状态卡（D2 §8.2「core_get_status 直透」——
/// 后端返回 M6 C01 裁剪口径的 JSON，REST 层原样透传；include 聚合项
/// 预留（F1 §6.4 / P-7 首页聚合端点决策，R1-03 不实现））
pub(super) async fn handle_status(
    State(state): State<ServerState>,
) -> Result<Json<serde_json::Value>, ServerError> {
    let backend = require_backend(&state)?;
    Ok(Json(backend.get_status().await?))
}

/// GET /v1/runs/{id}/snapshot：C02 run 快照（sessionId 可选供校验）
pub(super) async fn handle_run_snapshot(
    State(state): State<ServerState>,
    Path(run_id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Result<Json<RunSnapshotResult>, ServerError> {
    let query = QueryParams::parse(raw.as_deref())?;
    let backend = require_backend(&state)?;
    Ok(Json(
        backend
            .get_run_snapshot(RunSnapshotParams {
                run_id,
                session_id: query.get("sessionId").map(str::to_string),
            })
            .await?,
    ))
}

/// GET /v1/sessions/{id}/events：C03 会话事件分页（EventPage 契约；
/// afterSequence 开区间游标，maxEvents 缺省 200 夹紧 1000）
pub(super) async fn handle_session_events(
    State(state): State<ServerState>,
    Path(session_id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Result<Json<EventPageResult>, ServerError> {
    let query = QueryParams::parse(raw.as_deref())?;
    let backend = require_backend(&state)?;
    Ok(Json(
        backend
            .read_session_events(EventPageParams {
                session_id,
                after_sequence: query.get_u64("afterSequence")?,
                // 夹紧语义对齐 core_query_commands::normalize_max_events
                // （缺省 200、上限 1000，超出截断不报错——契约体优先于
                // M6 静态错误表，D2 §8.1 原则 1）
                max_events: query.get_u32("maxEvents")?.map(normalize_max_events),
                direction: query.get_enum("direction")?,
            })
            .await?,
    ))
}

/// GET /v1/runs/{id}/events：C04 run 事件分页（按信封 runId 过滤的会话
/// 事件子集；同 EventPage 游标语义）
pub(super) async fn handle_run_events(
    State(state): State<ServerState>,
    Path(run_id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Result<Json<EventPageResult>, ServerError> {
    let query = QueryParams::parse(raw.as_deref())?;
    let backend = require_backend(&state)?;
    Ok(Json(
        backend
            .read_run_events(RunEventsParams {
                run_id,
                session_id: query.get("sessionId").map(str::to_string),
                after_sequence: query.get_u64("afterSequence")?,
                max_events: query.get_u32("maxEvents")?.map(normalize_max_events),
            })
            .await?,
    ))
}

/// GET /v1/sessions：C05 会话列表（includeLastMessage 携带 ≤80 字符预览）
pub(super) async fn handle_list_sessions(
    State(state): State<ServerState>,
    RawQuery(raw): RawQuery,
) -> Result<Json<ListSessionsResult>, ServerError> {
    let query = QueryParams::parse(raw.as_deref())?;
    let backend = require_backend(&state)?;
    Ok(Json(
        backend
            .list_sessions(ListSessionsParams {
                include_last_message: query.get_bool("includeLastMessage")?,
            })
            .await?,
    ))
}

/// GET /v1/tasks：C06 后台任务列表（摘要，不携带输出内容）
pub(super) async fn handle_list_tasks(
    State(state): State<ServerState>,
) -> Result<Json<ListTasksResult>, ServerError> {
    let backend = require_backend(&state)?;
    Ok(Json(
        backend.list_background_tasks(ListTasksParams {}).await?,
    ))
}

/// GET /v1/tasks/{id}/output：C07 任务输出补取（afterLine 偏移分页）
pub(super) async fn handle_task_output(
    State(state): State<ServerState>,
    Path(task_id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Result<Json<TaskOutputResult>, ServerError> {
    let query = QueryParams::parse(raw.as_deref())?;
    let backend = require_backend(&state)?;
    Ok(Json(
        backend
            .get_task_output(TaskOutputParams {
                task_id,
                max_lines: query.get_u32("maxLines")?,
                after_line: query.get_u64("afterLine")?,
            })
            .await?,
    ))
}

/// GET /v1/sessions/{id}/flow：C08 子代理 DAG 概览（行投影，完整消息树
/// 不下发，D6 §3.3 N8）
pub(super) async fn handle_flow_snapshot(
    State(state): State<ServerState>,
    Path(session_id): Path<String>,
) -> Result<Json<FlowSnapshotResult>, ServerError> {
    let backend = require_backend(&state)?;
    Ok(Json(
        backend
            .get_flow_snapshot(FlowSnapshotParams { session_id })
            .await?,
    ))
}

/// GET /v1/commands：C09 命令清单（manifest 原样透传）
pub(super) async fn handle_list_commands(
    State(state): State<ServerState>,
) -> Result<Json<ListCommandsResult>, ServerError> {
    let backend = require_backend(&state)?;
    Ok(Json(backend.list_commands().await?))
}

/// GET /v1/search/index：C10 搜索索引就绪状态（ready/state 子集；
/// core_rebuild_search_index 等写面不在白名单，M6 §4.1.10）
pub(super) async fn handle_search_index(
    State(state): State<ServerState>,
) -> Result<Json<SearchIndexResult>, ServerError> {
    let backend = require_backend(&state)?;
    Ok(Json(backend.get_search_index().await?))
}

// ── R1-04 写面：F5 会话域 / F2 审批域 / F6 设置域 handler ──
