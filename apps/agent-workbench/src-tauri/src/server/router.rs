//! axum 路由注册与 handler（D2 §8：REST /v1/**；WS /v1/events 留 R1-05）
//!
//! 服务面（R1-02）：`GET /v1/info`（免鉴权服务自报）、`GET /v1/hello`
//! （鉴权握手）+ 兜底 404（统一 ErrorBody JSON，防幽灵路由）。
//!
//! 只读查询面（R1-03 = M6 §4.1 F1 监控域 C01-C10 的 REST 形态）：
//!
//! | M6 命令 | REST 路由 | 查询参数 |
//! |---|---|---|
//! | getStatus | `GET /v1/status` | —（D2 §8.2 直透；include 聚合预留 P-7）|
//! | getRunSnapshot | `GET /v1/runs/{id}/snapshot` | sessionId |
//! | readSessionEvents | `GET /v1/sessions/{id}/events` | afterSequence / maxEvents / direction |
//! | readRunEvents | `GET /v1/runs/{id}/events` | sessionId / afterSequence / maxEvents |
//! | listSessions | `GET /v1/sessions` | includeLastMessage |
//! | listBackgroundTasks | `GET /v1/tasks` | — |
//! | getTaskOutput | `GET /v1/tasks/{id}/output` | maxLines / afterLine |
//! | getFlowSnapshot | `GET /v1/sessions/{id}/flow` | — |
//! | listCommands | `GET /v1/commands` | — |
//! | getSearchIndex | `GET /v1/search/index` | — |
//!
//! 约定：
//! - 全部只读端点挂 Bearer 鉴权中间件（无令牌 401，D2 §7.1 零信任）；
//! - 响应 = M6 §10.6.2 各命令 `*Result` 的 camelCase JSON（D2 §8.1
//!   「命令体直调」：handler 只做参数搬运，语义由契约体与后端保证）；
//! - 错误 = [ServerError] → HTTP 状态 + ErrorBody（error.rs 映射面）；
//! - 事件分页契约 = core_query_commands 的 EventPage 语义（afterSequence
//!   开区间 + maxEvents 夹紧 200/1000，M6 §4.1.3 / D3 §7.5）；
//! - 查询串手写解析：axum `query` feature 未启用（D2 §6.4 显式 feature
//!   面不含 query，R1-03 不扩依赖面），语义对齐 serde 宽松解析——未知键
//!   忽略、重复键取首个、`%XX`/`+` 解码；非法编码/非法值 → cmd.invalid 400。

use std::sync::Arc;

use axum::{
    extract::{FromRequest, Path, RawQuery, Request, State},
    http::{StatusCode, Uri},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use conex_types::device::commands::{
    SettingsConfirmParams, SettingsConfirmResult, TaskOutputParams, TaskOutputResult,
};
#[cfg(test)]
use conex_types::device::version::PAGE_SIZE_DEFAULT;
use conex_types::device::version::PAGE_SIZE_MAX;
use conex_types::device::{
    ApprovalHistoryParams, ApprovalHistoryResult, ApproveParams, ApproveResult, AssetKind,
    AssetUrlParams, AssetUrlResult, CancelRunParams, CancelRunResult, DenyParams, DeviceErrorCode,
    ErrorBody, EventPageParams, EventPageResult, FlowSnapshotParams, FlowSnapshotResult,
    GetSettingsParams, GetSettingsResult, ListCommandsResult, ListPendingApprovalsParams,
    ListPendingApprovalsResult, ListSessionsParams, ListSessionsResult, ListTasksParams,
    ListTasksResult, PauseAutomationParams, PauseAutomationResult, RunControlParams,
    RunControlResult, RunEventsParams, RunSnapshotParams, RunSnapshotResult, RunTaskParams,
    RunTaskResult, SearchFilesParams, SearchFilesResult, SearchIndexResult,
};
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::server::backend::{ApiBackend, SettingsUpdateParams};
use crate::server::{now_ms, ServerError, ServerState};

/// 服务自报路由（免鉴权）
pub const INFO_PATH: &str = "/v1/info";
/// 鉴权握手路由（Bearer 校验）
pub const HELLO_PATH: &str = "/v1/hello";
/// C01 状态查询（GET /v1/status）
pub const STATUS_PATH: &str = "/v1/status";
/// C02 run 快照（GET /v1/runs/{id}/snapshot）
pub const RUN_SNAPSHOT_PATH: &str = "/v1/runs/{id}/snapshot";
/// C03 会话事件分页（GET /v1/sessions/{id}/events；与 WS 续传重放同契约）
pub const SESSION_EVENTS_PATH: &str = "/v1/sessions/{id}/events";
/// C04 run 事件分页（GET /v1/runs/{id}/events）
pub const RUN_EVENTS_PATH: &str = "/v1/runs/{id}/events";
/// C05 会话列表（GET /v1/sessions）
pub const SESSIONS_PATH: &str = "/v1/sessions";
/// C06 后台任务列表（GET /v1/tasks）
pub const TASKS_PATH: &str = "/v1/tasks";
/// C07 任务输出补取（GET /v1/tasks/{id}/output）
pub const TASK_OUTPUT_PATH: &str = "/v1/tasks/{id}/output";
/// C08 子代理 DAG 概览（GET /v1/sessions/{id}/flow；D2 §8.2 表内标 POST 为
/// 早期笔误——M6 C08 为只读查询，REST 只读面统一 GET，与 R1-04 写面不冲突）
pub const SESSION_FLOW_PATH: &str = "/v1/sessions/{id}/flow";
/// C09 命令清单（GET /v1/commands；core_list_commands 直透）
pub const COMMANDS_PATH: &str = "/v1/commands";
/// C10 搜索索引就绪状态（GET /v1/search/index；D2 §8.2 未列，R1-03 新增
/// 路由，对齐 M6 C10 getSearchIndex 命令名）
pub const SEARCH_INDEX_PATH: &str = "/v1/search/index";
/// 移动端配对入口（POST /v1/pair；R1-11 G-2：body {code, label?} →
/// {token, label?}，令牌仅此一次明文返回；免鉴权——配对端点无令牌可入）
pub const PAIR_PATH: &str = "/v1/pair";
/// 应用预览透明代理入口（GET /v1/preview/proxy；免鉴权公共路由）
pub const PREVIEW_PROXY_PATH: &str = "/v1/preview/proxy";

/// 密钥/高危险命令面（R1-10 T-07 / D5 §4.5：显式不进远程白名单——矩阵外
/// 命令）。REST 路由表即远程白名单：本清单条目一律不注册路由，触达时经
/// [handle_not_found] 返回 403 Forbidden（cmd.denied）+ remote-source-attempt
/// 审计标记（纵深防御第三层：即使白名单被绕过仍有拒绝分支与可见性）。
pub const SECRET_COMMAND_SURFACE: &[&str] = &[
    "config_secret_reveal",
    "config_secret_get",
    "config_secret_set",
    "config_secret_clear",
    "config_secret_has",
    "workbench_git_run",
    "workbench_run_shell",
    "workbench_pty",
    "host_openers",
];

/// 命令执行面白名单守卫（R1-11 G-5 / D5 §4.5 M-REG 接线）：REST 命令
/// 执行端点（run 发起 / 控制 / 取消）在 handler 入口显式经过
/// [remote_whitelist] 判定——白名单是命令执行面的唯一真源（对偶
/// command_manifest 的 registered 机制，D-11 远程面独立注册表）；命令名
/// 不在白名单 → 403 cmd.denied + RemoteSourceAttempt 审计事件（复用
/// core_backend 发射器，敏感形态打码）。
///
/// 审批端点（approve / deny / pending / history）不挂此守卫——审批决策
/// 是移动端核心能力（D5 §4.2 能力分级 approve；§4.5 白名单表 C11-C14
/// 显式登记），裁决语义由审批门 I-02 pending 校验（TH-13 伪造防护）
/// 保障，白名单表本身仍完整声明其能力位（remote_whitelist 测试锁定）。
fn ensure_command_execution_allowed(
    state: &ServerState,
    command: &'static str,
) -> Result<(), ServerError> {
    if crate::server::remote_whitelist::is_remote_command_whitelisted(command) {
        return Ok(());
    }
    crate::server::remote_whitelist::emit_remote_source_attempt_audit(
        state.audit_bridge().as_ref(),
        command,
    );
    Err(ServerError::protocol(
        DeviceErrorCode::CmdDenied,
        format!("命令不在远程白名单：{command}"),
    ))
}

// ── R1-04 写面路径（M6 §4：F5 会话域 + F2 审批域 + F6 设置域 REST 形态）──

/// C24 发起 run（POST /v1/runs；body = RunTaskParams）
pub const RUNS_PATH: &str = "/v1/runs";
/// C25 run 控制（POST /v1/runs/{id}/control；body = RunControlParams，
/// 路径 runId 优先）
pub const RUN_CONTROL_PATH: &str = "/v1/runs/{id}/control";
/// C26 取消 run（POST /v1/runs/{id}/cancel；body = {reason?}）
pub const RUN_CANCEL_PATH: &str = "/v1/runs/{id}/cancel";
/// C11 审批批准（POST /v1/approval/{toolCallId}/approve；body = {runId?}；
/// toolCallId 为真键，I-02 pending 校验不变）
pub const APPROVAL_APPROVE_PATH: &str = "/v1/approval/{toolCallId}/approve";
/// C12 审批拒绝（POST /v1/approval/{toolCallId}/deny；body = {runId?, reason?}）
pub const APPROVAL_DENY_PATH: &str = "/v1/approval/{toolCallId}/deny";
/// C13 待审批对账（GET /v1/approvals/pending；afterSequence 增量对账扩展）
pub const APPROVALS_PENDING_PATH: &str = "/v1/approvals/pending";
/// C14 审批历史补拉（GET /v1/approvals/history；sessionId / afterSequence / limit）
pub const APPROVALS_HISTORY_PATH: &str = "/v1/approvals/history";
/// C28/C29 设置（GET /v1/settings 快照 / PUT /v1/settings 非敏感更新）
pub const SETTINGS_PATH: &str = "/v1/settings";
/// C21 递归文件名搜索（GET /v1/search/files；query / root / maxResults
/// 查询参数，对齐注册表 SearchFilesParams）
pub const SEARCH_FILES_PATH: &str = "/v1/search/files";
/// C22 资源 URL（GET /v1/assets/url；path / kind 查询参数——命令面占位：
/// F4 §5.4 HTTP 资源代理未实现 → 501 cmd.unknown 诚实降级）
pub const ASSET_URL_PATH: &str = "/v1/assets/url";
/// C30 桌面确认请求回执（POST /v1/settings/confirm；body =
/// SettingsConfirmParams）
pub const SETTINGS_CONFIRM_PATH: &str = "/v1/settings/confirm";
/// C31 暂停定时自动执行（POST /v1/settings/pause-automation；body =
/// PauseAutomationParams）
pub const PAUSE_AUTOMATION_PATH: &str = "/v1/settings/pause-automation";

/// 鉴权握手载荷（GET /v1/hello；D2 §8.2 形状）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloInfo {
    /// 桌面应用版本（semver）
    pub server_version: String,
    /// 协商后的协议版本
    pub protocol_version: u32,
    /// 桌面时钟（epoch ms；时钟校准）
    pub server_time_ms: u64,
}

/// 全局时钟响应头注入中间件（为所有 HTTP 响应注入 X-Server-Time-Ms，使客户端能自愈时钟偏差）
pub async fn inject_server_time_header(request: Request, next: Next) -> Response {
    let now = now_ms();
    let mut response = next.run(request).await;
    if let Ok(val) = axum::http::HeaderValue::from_str(&now.to_string()) {
        response
            .headers_mut()
            .insert(crate::server::auth::SERVER_TIME_HEADER, val);
    }
    response
}

/// 构建服务路由（R1-03：info/hello + F1 监控域 10 条只读端点；
/// R1-05：WS /v1/events 挂载）
pub fn build_router(state: ServerState) -> Router {
    // 免鉴权面（/v1/info 服务自报；/v1/hello 时钟基准与握手；/v1/pair 配对入口——
    // 配对与握手端点免鉴权进入，使时钟偏差客户端能获取基准自愈）
    let info = Router::new()
        .route(INFO_PATH, get(handle_info))
        .route(HELLO_PATH, get(handle_hello))
        .route(
            PAIR_PATH,
            post(crate::server::pair_endpoint::handle_rest_pair),
        )
        .route(
            PREVIEW_PROXY_PATH,
            get(crate::server::preview_proxy::handle_preview_proxy)
                .options(crate::server::preview_proxy::handle_preview_proxy_options),
        );
    // WS 事件端点（R1-05）：handler 内自鉴权（Bearer 头或 ?token= 双通道，
    // D2 §10.1）——不进 require_bearer_token 中间件组（浏览器 WS 无法携带
    // 自定义头，且 401 响应会破坏升级握手语义）
    let ws_router = Router::new().route(
        crate::server::ws::WS_EVENTS_PATH,
        get(crate::server::ws::handle_ws_upgrade),
    );
    // 鉴权面（Bearer 中间件；全部只读端点挂此组，D2 §7.1 零信任）
    let protected = Router::new()
        .route(STATUS_PATH, get(handle_status))
        .route(RUN_SNAPSHOT_PATH, get(handle_run_snapshot))
        .route(SESSION_EVENTS_PATH, get(handle_session_events))
        .route(RUN_EVENTS_PATH, get(handle_run_events))
        .route(SESSIONS_PATH, get(handle_list_sessions))
        .route(TASKS_PATH, get(handle_list_tasks))
        .route(TASK_OUTPUT_PATH, get(handle_task_output))
        .route(SESSION_FLOW_PATH, get(handle_flow_snapshot))
        .route(COMMANDS_PATH, get(handle_list_commands))
        .route(SEARCH_INDEX_PATH, get(handle_search_index))
        // ── R1-04 写面（8 端点；与只读面同一鉴权组，零信任）──
        .route(RUNS_PATH, post(handle_run_task))
        .route(RUN_CONTROL_PATH, post(handle_run_control))
        .route(RUN_CANCEL_PATH, post(handle_run_cancel))
        .route(APPROVAL_APPROVE_PATH, post(handle_approve))
        .route(APPROVAL_DENY_PATH, post(handle_deny))
        .route(APPROVALS_PENDING_PATH, get(handle_approvals_pending))
        .route(APPROVALS_HISTORY_PATH, get(handle_approvals_history))
        .route(
            SETTINGS_PATH,
            get(handle_settings_get).put(handle_settings_set),
        )
        // ── R2-12c 新增面（C21/C22 文件域 + C30/C31 设置域）──
        .route(SEARCH_FILES_PATH, get(handle_search_files))
        .route(ASSET_URL_PATH, get(handle_asset_url))
        .route(SETTINGS_CONFIRM_PATH, post(handle_settings_confirm))
        .route(PAUSE_AUTOMATION_PATH, post(handle_pause_automation))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            crate::server::auth::require_signed_request,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            crate::server::auth::require_bearer_token,
        ));
    Router::new()
        .merge(info)
        .merge(ws_router)
        .merge(protected)
        .fallback(handle_not_found)
        .layer(middleware::from_fn(inject_server_time_header))
        .with_state(state)
}

/// GET /v1/info：服务自报（端口 / 绑定模式 / 配对开关 / 版本 / 能力位）
async fn handle_info(State(state): State<ServerState>) -> Json<ServerInfoWire> {
    Json(state.server_info())
}

/// GET /v1/hello：服务时钟基准与握手信息（免鉴权暴露，供客户端计算时差并在重试中自愈）
async fn handle_hello(State(state): State<ServerState>) -> Json<HelloInfo> {
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
async fn handle_status(
    State(state): State<ServerState>,
) -> Result<Json<serde_json::Value>, ServerError> {
    let backend = require_backend(&state)?;
    Ok(Json(backend.get_status().await?))
}

/// GET /v1/runs/{id}/snapshot：C02 run 快照（sessionId 可选供校验）
async fn handle_run_snapshot(
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
async fn handle_session_events(
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
async fn handle_run_events(
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
async fn handle_list_sessions(
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
async fn handle_list_tasks(
    State(state): State<ServerState>,
) -> Result<Json<ListTasksResult>, ServerError> {
    let backend = require_backend(&state)?;
    Ok(Json(
        backend.list_background_tasks(ListTasksParams {}).await?,
    ))
}

/// GET /v1/tasks/{id}/output：C07 任务输出补取（afterLine 偏移分页）
async fn handle_task_output(
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
async fn handle_flow_snapshot(
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
async fn handle_list_commands(
    State(state): State<ServerState>,
) -> Result<Json<ListCommandsResult>, ServerError> {
    let backend = require_backend(&state)?;
    Ok(Json(backend.list_commands().await?))
}

/// GET /v1/search/index：C10 搜索索引就绪状态（ready/state 子集；
/// core_rebuild_search_index 等写面不在白名单，M6 §4.1.10）
async fn handle_search_index(
    State(state): State<ServerState>,
) -> Result<Json<SearchIndexResult>, ServerError> {
    let backend = require_backend(&state)?;
    Ok(Json(backend.get_search_index().await?))
}

// ── R1-04 写面：F5 会话域 / F2 审批域 / F6 设置域 handler ──

/// POST /v1/runs：C24 发起 run（body = RunTaskParams；runId 桌面生成，
/// sessionId 缺省 = 新建会话）。命令执行面白名单守卫：runTask 必须登记
/// 于远程白名单（R1-11 G-5 / D5 §4.5 M-REG）
async fn handle_run_task(
    State(state): State<ServerState>,
    JsonBody(params): JsonBody<RunTaskParams>,
) -> Result<Json<RunTaskResult>, ServerError> {
    ensure_command_execution_allowed(&state, "runTask")?;
    let backend = require_backend(&state)?;
    Ok(Json(backend.run_task(params).await?))
}

/// POST /v1/runs/{id}/control：C25 run 控制（body = RunControlParams；
/// 路径 runId 优先，覆盖 body 携带值——REST 资源地址即命令真键）。
/// 命令执行面白名单守卫：runControl 必须登记于远程白名单
async fn handle_run_control(
    State(state): State<ServerState>,
    Path(run_id): Path<String>,
    JsonBody(mut params): JsonBody<RunControlParams>,
) -> Result<Json<RunControlResult>, ServerError> {
    ensure_command_execution_allowed(&state, "runControl")?;
    params.run_id = run_id;
    let backend = require_backend(&state)?;
    Ok(Json(backend.run_control(params).await?))
}

/// POST /v1/runs/{id}/cancel：C26 取消 run（body = {reason?}；路径 runId
/// 为真键；重复取消无副作用）。命令执行面白名单守卫：cancelRun 必须
/// 登记于远程白名单
async fn handle_run_cancel(
    State(state): State<ServerState>,
    Path(run_id): Path<String>,
    JsonBody(body): JsonBody<serde_json::Value>,
) -> Result<Json<CancelRunResult>, ServerError> {
    ensure_command_execution_allowed(&state, "cancelRun")?;
    let reason = body
        .get("reason")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let backend = require_backend(&state)?;
    Ok(Json(
        backend
            .cancel_run(CancelRunParams { run_id, reason })
            .await?,
    ))
}

/// POST /v1/approval/{toolCallId}/approve：C11 审批批准（body = {runId?}；
/// toolCallId 以路径为真键，I-02 pending 校验不变；重复决策 →
/// cmd.approval_mismatch 409）
async fn handle_approve(
    State(state): State<ServerState>,
    Path(tool_call_id): Path<String>,
    JsonBody(body): JsonBody<serde_json::Value>,
) -> Result<Json<ApproveResult>, ServerError> {
    let run_id = body
        .get("runId")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let backend = require_backend(&state)?;
    Ok(Json(
        backend
            .approve(ApproveParams {
                tool_call_id,
                run_id,
            })
            .await?,
    ))
}

/// POST /v1/approval/{toolCallId}/deny：C12 审批拒绝（body = {runId?, reason?}；
/// reason ≤256 字符，缺省 "user denied"）
async fn handle_deny(
    State(state): State<ServerState>,
    Path(tool_call_id): Path<String>,
    JsonBody(body): JsonBody<serde_json::Value>,
) -> Result<Json<ApproveResult>, ServerError> {
    let run_id = body
        .get("runId")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let reason = body
        .get("reason")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let backend = require_backend(&state)?;
    Ok(Json(
        backend
            .deny(DenyParams {
                tool_call_id,
                run_id,
                reason,
            })
            .await?,
    ))
}

/// GET /v1/approvals/pending：C13 待审批对账（afterSequence 增量对账扩展）
async fn handle_approvals_pending(
    State(state): State<ServerState>,
    RawQuery(raw): RawQuery,
) -> Result<Json<ListPendingApprovalsResult>, ServerError> {
    let query = QueryParams::parse(raw.as_deref())?;
    let backend = require_backend(&state)?;
    Ok(Json(
        backend
            .list_pending_approvals(ListPendingApprovalsParams {
                after_sequence: query.get_u64("afterSequence")?,
            })
            .await?,
    ))
}

/// GET /v1/approvals/history：C14 审批历史补拉（sessionId / afterSequence /
/// limit 水位分页）
async fn handle_approvals_history(
    State(state): State<ServerState>,
    RawQuery(raw): RawQuery,
) -> Result<Json<ApprovalHistoryResult>, ServerError> {
    let query = QueryParams::parse(raw.as_deref())?;
    let backend = require_backend(&state)?;
    Ok(Json(
        backend
            .approval_history(ApprovalHistoryParams {
                session_id: query.get("sessionId").map(str::to_string),
                after_sequence: query.get_u64("afterSequence")?,
                limit: query.get_u32("limit")?,
            })
            .await?,
    ))
}

/// GET /v1/settings：C28 设置脱敏快照（keys 逗号分隔子集过滤；apiKey
/// 恒空串脱敏由 config 层保证）
async fn handle_settings_get(
    State(state): State<ServerState>,
    RawQuery(raw): RawQuery,
) -> Result<Json<GetSettingsResult>, ServerError> {
    let query = QueryParams::parse(raw.as_deref())?;
    let backend = require_backend(&state)?;
    let keys = query.get("keys").map(|raw_keys| {
        raw_keys
            .split(',')
            .map(|key| key.trim().to_string())
            .filter(|key| !key.is_empty())
            .collect::<Vec<_>>()
    });
    Ok(Json(
        backend.settings_get(GetSettingsParams { keys }).await?,
    ))
}

/// PUT /v1/settings：C29 非敏感配置更新（body = SettingsUpdateParams；
/// credentialMode / endpoint / stream 明确拒绝 cmd.invalid）
async fn handle_settings_set(
    State(state): State<ServerState>,
    JsonBody(params): JsonBody<SettingsUpdateParams>,
) -> Result<Json<GetSettingsResult>, ServerError> {
    let backend = require_backend(&state)?;
    Ok(Json(backend.settings_set(params).await?))
}

// ── R2-12c 新增面：C21 文件搜索 / C22 资源 URL / C30 设置确认 / C31 暂停 ──

/// GET /v1/search/files：C21 递归文件名搜索（query 必填 1-256——
/// 缺失/空串在边界即 400 cmd.invalid；root / maxResults 可选；响应
/// 对齐注册表 SearchFilesResult{results:[{relPath, kind?, size?}]}）
async fn handle_search_files(
    State(state): State<ServerState>,
    RawQuery(raw): RawQuery,
) -> Result<Json<SearchFilesResult>, ServerError> {
    let query = QueryParams::parse(raw.as_deref())?;
    let query_text = query
        .get("query")
        .map(str::trim)
        .filter(|q| !q.is_empty())
        .ok_or_else(|| invalid_param("query", ""))?
        .to_string();
    let backend = require_backend(&state)?;
    Ok(Json(
        backend
            .search_files(SearchFilesParams {
                query: query_text,
                root: query.get("root").map(str::to_string),
                max_results: query.get_u32("maxResults")?,
            })
            .await?,
    ))
}

/// GET /v1/assets/url：C22 资源 URL（命令面占位——F4 §5.4 HTTP 资源
/// 代理 + 10 分钟令牌未实现（开放问题 14.4-4），后端缺省实现恒返回
/// 501 cmd.unknown 诚实降级；端点先行登记路由与鉴权面，供后续接线）
async fn handle_asset_url(
    State(state): State<ServerState>,
    RawQuery(raw): RawQuery,
) -> Result<Json<AssetUrlResult>, ServerError> {
    let query = QueryParams::parse(raw.as_deref())?;
    let backend = require_backend(&state)?;
    let kind = query
        .get_enum::<AssetKind>("kind")?
        .ok_or_else(|| invalid_param("kind", ""))?;
    Ok(Json(
        backend
            .asset_url(AssetUrlParams {
                path: query.get("path").unwrap_or_default().to_string(),
                kind,
            })
            .await?,
    ))
}

/// POST /v1/settings/confirm：C30 桌面确认请求回执（body =
/// SettingsConfirmParams{confirmRequestId, action}；桌面直调面无确认
/// 通道（D-13）——回执语义：query → expired / withdraw → withdrawn）
async fn handle_settings_confirm(
    State(state): State<ServerState>,
    JsonBody(params): JsonBody<SettingsConfirmParams>,
) -> Result<Json<SettingsConfirmResult>, ServerError> {
    let backend = require_backend(&state)?;
    Ok(Json(backend.settings_confirm(params).await?))
}

/// POST /v1/settings/pause-automation：C31 暂停定时自动执行（body =
/// PauseAutomationParams{durationSec?}；缺省 3600、钳制 [60, 86400]
/// 由装配面执行；重复暂停刷新 pausedUntil；响应
/// {ok, pausedUntil(epoch ms)}）
async fn handle_pause_automation(
    State(state): State<ServerState>,
    JsonBody(params): JsonBody<PauseAutomationParams>,
) -> Result<Json<PauseAutomationResult>, ServerError> {
    let backend = require_backend(&state)?;
    Ok(Json(backend.pause_automation(params).await?))
}

/// JSON body 请求体上限（2 MiB，与 axum 默认 DefaultBodyLimit 一致；
/// 命令请求默认 ≤64 KiB，超限即拒绝）
const JSON_BODY_LIMIT: usize = 2 * 1024 * 1024;

/// JSON body extractor（反序列化失败 → cmd.invalid 400 + ErrorBody——axum
/// 默认 Json rejection 为文本 400，REST 面统一走 [ServerError] 错误协议
/// 出网，与查询参数非法同码）
struct JsonBody<T>(pub T);

impl<S, T> FromRequest<S> for JsonBody<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ServerError;

    async fn from_request(req: Request, _state: &S) -> Result<Self, Self::Rejection> {
        let bytes = axum::body::to_bytes(req.into_body(), JSON_BODY_LIMIT)
            .await
            .map_err(|e| {
                ServerError::protocol(DeviceErrorCode::CmdInvalid, format!("读取请求体失败：{e}"))
            })?;
        let value: T = serde_json::from_slice(&bytes).map_err(|e| {
            ServerError::protocol(
                DeviceErrorCode::CmdInvalid,
                format!("请求体 JSON 非法：{e}"),
            )
        })?;
        Ok(Self(value))
    }
}

/// 识别被禁命令面触达（R1-10 T-07 纯函数；URI 路径含清单命令名 → 命中，
/// 返回命中的命令名供审计携带）
fn secret_command_hit(uri: &Uri) -> Option<&'static str> {
    let path = uri.path();
    SECRET_COMMAND_SURFACE
        .iter()
        .find_map(|name| path.contains(*name).then_some(*name))
}

/// 兜底 404（统一 ErrorBody JSON；cmd.not_found）。R1-10 T-07：密钥命令面
/// 触达 → 403 Forbidden（cmd.denied 白名单拒绝）+ remote-source-attempt
/// 审计标记——REST 面即远程面（桌面本地操作走 Tauri IPC），入站请求一律
/// 视为远程来源（D5 §4.5 / §9.1 T-07：矩阵外命令 = 白名单拒绝 + Forbidden
/// 错误 + remote-source-attempt 审计）；R1-11 D-5 收口：审计双写升级为
/// SecurityAudit 事件发射（事件桥经 ServerState.audit_bridge 注入，命令名
/// 敏感形态打码；未接线时降级纯结构化日志）
async fn handle_not_found(State(state): State<ServerState>, uri: Uri) -> Response {
    if let Some(command) = secret_command_hit(&uri) {
        crate::server::remote_whitelist::emit_remote_source_attempt_audit(
            state.audit_bridge().as_ref(),
            command,
        );
        let body = ErrorBody::new(
            DeviceErrorCode::CmdDenied,
            format!("命令不在远程白名单：{command}"),
        );
        return (StatusCode::FORBIDDEN, Json(body)).into_response();
    }
    let body = ErrorBody::new(
        DeviceErrorCode::CmdNotFound,
        format!("路径不存在：{}", uri.path()),
    );
    (StatusCode::NOT_FOUND, Json(body)).into_response()
}

/// 错误响应（HTTP 状态 + ErrorBody 载荷；与 [ServerError] 的
/// IntoResponse 同一映射路径，供无需 `?` 传播的场景复用）
// R1-02 备注：测试与 fallback 消费——dead_code 静音（测试构建保持检查）
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn error_response(err: &ServerError) -> Response {
    err.clone().into_response()
}

/// 取命令后端（None = 服务未注入 CoreStateBackend → internal 500 诚实
/// 降级，不 panic；R1-04 在 main.rs 装配面注入）
fn require_backend(state: &ServerState) -> Result<Arc<dyn ApiBackend>, ServerError> {
    state.backend().ok_or_else(|| {
        ServerError::internal("服务命令后端未接线（CoreStateBackend 由 R1-04 注入）")
    })
}

/// 归一化 maxEvents：缺省 200，夹紧 [1, 1000]（对齐
/// core_query_commands::normalize_max_events 语义）
fn normalize_max_events(max_events: u32) -> u32 {
    max_events.clamp(1, PAGE_SIZE_MAX)
}

/// /v1/info 载荷类型别名（wire 形状见 ServerInfo）
type ServerInfoWire = crate::server::ServerInfo;

/// 轻量查询参数表
///
/// axum `query` feature 未启用（D2 §6.4 显式 feature 面），R1-03 不扩依赖
/// 面，手写解析等价语义：未知键忽略、重复键取首个、`%XX`/`+` 解码；
/// 非法编码或非法值 → cmd.invalid 400。
#[derive(Debug, Default)]
struct QueryParams {
    pairs: Vec<(String, String)>,
}

impl QueryParams {
    /// 解析查询串（`a=1&b=2` 形态；空串/无参 → 空表）
    fn parse(raw: Option<&str>) -> Result<Self, ServerError> {
        let mut pairs = Vec::new();
        if let Some(raw) = raw {
            for part in raw.split('&') {
                if part.is_empty() {
                    continue;
                }
                let mut it = part.splitn(2, '=');
                let key = percent_decode(it.next().unwrap_or_default())?;
                if key.is_empty() {
                    continue;
                }
                let value = percent_decode(it.next().unwrap_or_default())?;
                pairs.push((key, value));
            }
        }
        Ok(Self { pairs })
    }

    /// 取首个值（重复键取首个；未知键 → None）
    fn get(&self, key: &str) -> Option<&str> {
        self.pairs
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    /// u64 值（非法 → cmd.invalid 400；afterSequence 负值落入此路径）
    fn get_u64(&self, key: &str) -> Result<Option<u64>, ServerError> {
        match self.get(key) {
            None => Ok(None),
            Some(raw) => raw
                .parse::<u64>()
                .map(Some)
                .map_err(|_| invalid_param(key, raw)),
        }
    }

    /// u32 值（非法 → cmd.invalid 400）
    fn get_u32(&self, key: &str) -> Result<Option<u32>, ServerError> {
        match self.get(key) {
            None => Ok(None),
            Some(raw) => raw
                .parse::<u32>()
                .map(Some)
                .map_err(|_| invalid_param(key, raw)),
        }
    }

    /// bool 值（仅接受 true/false 字面量）
    fn get_bool(&self, key: &str) -> Result<Option<bool>, ServerError> {
        match self.get(key) {
            None => Ok(None),
            Some("true") => Ok(Some(true)),
            Some("false") => Ok(Some(false)),
            Some(raw) => Err(invalid_param(key, raw)),
        }
    }

    /// 枚举值（经 serde 反序列化，wire 形状由枚举 rename 规则决定——
    /// 如 direction=forward / include=coreStatus）
    fn get_enum<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>, ServerError> {
        match self.get(key) {
            None => Ok(None),
            Some(raw) => serde_json::from_value(serde_json::Value::String(raw.to_string()))
                .map(Some)
                .map_err(|_| invalid_param(key, raw)),
        }
    }
}

/// 查询参数非法（cmd.invalid 400）
fn invalid_param(key: &str, raw: &str) -> ServerError {
    ServerError::protocol(
        DeviceErrorCode::CmdInvalid,
        format!("查询参数 {key} 非法：{raw}"),
    )
}

/// 百分号解码（`+` → 空格；`%XX` → 字节；非法序列/非法 UTF-8 → 400）
fn percent_decode(input: &str) -> Result<String, ServerError> {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' => {
                let Some(hi) = bytes.get(i + 1).and_then(|b| hex_digit(*b)) else {
                    return Err(invalid_query_encoding(input));
                };
                let Some(lo) = bytes.get(i + 2).and_then(|b| hex_digit(*b)) else {
                    return Err(invalid_query_encoding(input));
                };
                out.push((hi << 4) | lo);
                i += 3;
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8(out).map_err(|_| invalid_query_encoding(input))
}

/// 十六进制字符值（0-9 / a-f / A-F）
fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// 查询串含非法百分号编码（cmd.invalid 400）
fn invalid_query_encoding(raw: &str) -> ServerError {
    ServerError::protocol(
        DeviceErrorCode::CmdInvalid,
        format!("查询串含非法百分号编码：{raw}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::auth::{sha256_hex, TokenStore};
    use crate::server::{ServerConfig, ServerHandle};
    use axum::body::Body;
    use axum::extract::ConnectInfo;
    use conex_types::device::commands::{SettingsConfirmAction, SettingsConfirmStatus};
    use conex_types::device::{
        CommandSurface, FileSearchHit, ManifestEntry, RunTaskParams, RunTaskResult,
    };
    use conex_types::SessionIndexEntry;
    use std::net::SocketAddr;
    use tower::ServiceExt;

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

    #[async_trait::async_trait]
    impl ApiBackend for MockBackend {
        async fn get_status(&self) -> Result<serde_json::Value, ServerError> {
            self.fail()?;
            Ok(serde_json::json!({
                "initialized": true,
                "version": "1.4.2-test",
                "engineReady": true,
                "dbReady": true,
                "searchIndexReady": true,
                "compactionReady": false,
                "providerStatus": {
                    "hasApiKey": true,
                    "model": "deepseek-v4",
                    "credentialMode": "direct",
                },
                "logLevel": "info",
                "restore": {
                    "state": "done",
                    "mode": "snapshot-incremental",
                    "interruptedCount": 0,
                },
                "backgroundTasks": {
                    "activeCount": 1,
                    "daemonCount": 1,
                },
                "activeRuns": [
                    { "runId": "r-1", "sessionId": "s-1", "status": "running" }
                ],
                "pendingApprovals": [
                    {
                        "toolCallId": "tc-9",
                        "toolName": "shell:write",
                        "runId": "r-1",
                        "summary": "npm test 需要执行权限",
                    }
                ],
            }))
        }

        async fn get_run_snapshot(
            &self,
            params: RunSnapshotParams,
        ) -> Result<RunSnapshotResult, ServerError> {
            self.fail()?;
            if params.run_id == "r-missing" {
                return Err(Self::not_found("run not found（mock）"));
            }
            Ok(RunSnapshotResult {
                snapshot: serde_json::json!({
                    "runId": params.run_id,
                    "sessionId": "s-1",
                    "status": "running",
                    "cursor": 127,
                    "createdAt": 1_754_700_000_000_i64,
                    "updatedAt": 1_754_700_030_000_i64,
                    "endReason": null,
                    "error": null,
                    "usage": {
                        "promptTokens": 2100,
                        "completionTokens": 1400,
                        "totalTokens": 3500,
                        "sampleCount": 3,
                    },
                }),
            })
        }

        async fn read_session_events(
            &self,
            params: EventPageParams,
        ) -> Result<EventPageResult, ServerError> {
            self.fail()?;
            if params.session_id == "s-missing" {
                return Err(Self::not_found("会话不存在（mock）"));
            }
            let after = params.after_sequence.unwrap_or(0);
            let max = params.max_events.unwrap_or(PAGE_SIZE_DEFAULT) as usize;
            Ok(self.paginate(after, max))
        }

        async fn read_run_events(
            &self,
            params: RunEventsParams,
        ) -> Result<EventPageResult, ServerError> {
            self.fail()?;
            if params.run_id == "r-missing" {
                return Err(Self::not_found("run not found（mock）"));
            }
            let after = params.after_sequence.unwrap_or(0);
            let max = params.max_events.unwrap_or(PAGE_SIZE_DEFAULT) as usize;
            Ok(self.paginate(after, max))
        }

        async fn list_sessions(
            &self,
            _params: ListSessionsParams,
        ) -> Result<ListSessionsResult, ServerError> {
            self.fail()?;
            Ok(ListSessionsResult {
                sessions: vec![SessionIndexEntry {
                    id: "s-1".to_string(),
                    title: "修复登录页 bug".to_string(),
                    folder: "常规会话".to_string(),
                    is_pinned: false,
                    is_archived: false,
                    branch_parent_id: None,
                    timestamp: "2026-08-09T08:00:00Z".to_string(),
                    updated_at: 1_754_700_000_000,
                    message_count: 42,
                    pinned_message_ids: None,
                    engine_cursor: Some(128),
                    engine_last_run_id: Some("r-1".to_string()),
                    hydrated_from_engine: Some(true),
                }],
            })
        }

        async fn list_background_tasks(
            &self,
            _params: ListTasksParams,
        ) -> Result<ListTasksResult, ServerError> {
            self.fail()?;
            Ok(ListTasksResult {
                tasks: vec![
                    serde_json::json!({
                        "taskId": "t-1",
                        "command": "npm run build",
                        "cwd": "C:\\Software\\conex",
                        "status": "running",
                        "isDaemon": false,
                        "startedAt": 1_754_700_000_000_i64,
                        "exitCode": null,
                        "lineCount": 42,
                    }),
                    serde_json::json!({
                        "taskId": "t-2",
                        "command": "npm test",
                        "cwd": "C:\\Software\\conex",
                        "status": "completed",
                        "isDaemon": false,
                        "startedAt": 1_754_600_000_000_i64,
                        "exitCode": 0,
                        "lineCount": 128,
                    }),
                ],
            })
        }

        async fn get_task_output(
            &self,
            params: TaskOutputParams,
        ) -> Result<TaskOutputResult, ServerError> {
            self.fail()?;
            if params.task_id == "t-missing" {
                return Err(Self::not_found("任务不存在（mock）"));
            }
            let after = params.after_line.unwrap_or(0) as usize;
            let max = params.max_lines.unwrap_or(PAGE_SIZE_DEFAULT) as usize;
            let page: Vec<String> = self.lines.iter().skip(after).take(max).cloned().collect();
            let next = (after + page.len()) as u64;
            let has_more = (after + page.len()) < self.lines.len();
            Ok(TaskOutputResult {
                lines: page,
                truncated: has_more,
                line_count: self.lines.len() as u64,
                next_after_line: Some(next),
                has_more: Some(has_more),
            })
        }

        async fn get_flow_snapshot(
            &self,
            params: FlowSnapshotParams,
        ) -> Result<FlowSnapshotResult, ServerError> {
            self.fail()?;
            if params.session_id == "s-missing" {
                return Err(Self::not_found("会话不存在（mock）"));
            }
            Ok(FlowSnapshotResult {
                flow: serde_json::json!({
                    "flowDeclaration": { "id": "f-1" },
                    "flowState": { "phase": "running" },
                    "agents": [
                        {
                            "agentId": "sub-3",
                            "status": "running",
                            "description": "调研",
                            "summary": null,
                            "depth": 1,
                        }
                    ],
                }),
            })
        }

        async fn list_commands(&self) -> Result<ListCommandsResult, ServerError> {
            self.fail()?;
            Ok(ListCommandsResult {
                contract_version: "1.0.0".to_string(),
                commands: vec![ManifestEntry {
                    name: "core_get_status".to_string(),
                    family: "core".to_string(),
                    surface: CommandSurface::Engine,
                    registered: true,
                }],
            })
        }

        async fn get_search_index(&self) -> Result<SearchIndexResult, ServerError> {
            self.fail()?;
            Ok(SearchIndexResult {
                ready: true,
                state: Some(serde_json::json!({
                    "totalFiles": 1200,
                    "lastBuiltAt": 1_754_600_000_000_i64,
                })),
            })
        }

        async fn run_task(&self, params: RunTaskParams) -> Result<RunTaskResult, ServerError> {
            self.fail()?;
            // R1-10 T-08：记录远程申报的权限模式（装配面降级断言用）
            *self.last_run_permission_mode.lock().unwrap() = params.permission_mode;
            if params.prompt.trim().is_empty() {
                return Err(Self::invalid("prompt 不能为空（mock）"));
            }
            // clientMessageId 幂等：同 id 重发回显首次 runId（M6 C24）
            if let Some(client_message_id) = params.client_message_id.as_deref() {
                let mut run_ids = self.run_ids.lock().unwrap();
                if let Some(existing) = run_ids.get(client_message_id) {
                    return Ok(RunTaskResult {
                        run_id: existing.clone(),
                        session_id: "s-1".to_string(),
                    });
                }
                let run_id = format!("r-{}", run_ids.len() + 1);
                run_ids.insert(client_message_id.to_string(), run_id.clone());
                return Ok(RunTaskResult {
                    run_id,
                    session_id: "s-1".to_string(),
                });
            }
            Ok(RunTaskResult {
                run_id: "r-remote".to_string(),
                session_id: "s-1".to_string(),
            })
        }
        async fn run_control(
            &self,
            params: conex_types::device::RunControlParams,
        ) -> Result<conex_types::device::RunControlResult, ServerError> {
            self.fail()?;
            // 记录收到的参数（路径 runId 覆盖断言）
            *self.last_run_control.lock().unwrap() = Some(params.clone());
            Ok(conex_types::device::RunControlResult { ok: true })
        }
        async fn cancel_run(
            &self,
            params: conex_types::device::CancelRunParams,
        ) -> Result<conex_types::device::CancelRunResult, ServerError> {
            self.fail()?;
            if params.run_id == "r-missing" {
                return Err(Self::not_found("run not found（mock）"));
            }
            Ok(conex_types::device::CancelRunResult {
                ok: true,
                run_id: params.run_id,
            })
        }
        async fn approve(
            &self,
            params: conex_types::device::ApproveParams,
        ) -> Result<conex_types::device::ApproveResult, ServerError> {
            self.fail()?;
            self.decide(&params.tool_call_id, "approved")
        }
        async fn deny(
            &self,
            params: DenyParams,
        ) -> Result<conex_types::device::ApproveResult, ServerError> {
            self.fail()?;
            *self.last_deny_reason.lock().unwrap() = params.reason.clone();
            self.decide(&params.tool_call_id, "denied")
        }

        async fn list_pending_approvals(
            &self,
            _params: conex_types::device::ListPendingApprovalsParams,
        ) -> Result<conex_types::device::ListPendingApprovalsResult, ServerError> {
            self.fail()?;
            Ok(conex_types::device::ListPendingApprovalsResult {
                approvals: vec![
                    conex_types::device::PendingApproval {
                        request_id: "approval-tc-9".to_string(),
                        tool_call_id: "tc-9".to_string(),
                        tool_name: "shell:write".to_string(),
                        summary: Some("call shell:write".to_string()),
                        cwd: Some("C:\\Software\\conex".to_string()),
                        session_id: Some("s-1".to_string()),
                        run_id: Some("r-1".to_string()),
                        requester_run_id: None,
                        reason: None,
                        arbiter: conex_types::device::Arbiter::User,
                        requested_at: 1_754_700_000_000,
                        expires_at: 1_754_700_120_000,
                        danger_level: 2,
                        param_keys: Some(vec!["script".to_string()]),
                    },
                    conex_types::device::PendingApproval {
                        request_id: "approval-tc-8".to_string(),
                        tool_call_id: "tc-8".to_string(),
                        tool_name: "read_file".to_string(),
                        summary: Some("call read_file".to_string()),
                        cwd: Some("C:\\Software\\conex".to_string()),
                        session_id: Some("s-1".to_string()),
                        run_id: Some("r-1".to_string()),
                        requester_run_id: None,
                        reason: None,
                        arbiter: conex_types::device::Arbiter::User,
                        requested_at: 1_754_700_000_000,
                        expires_at: 1_754_700_120_000,
                        danger_level: 1,
                        param_keys: None,
                    },
                ],
                latest_sequence: None,
            })
        }

        async fn approval_history(
            &self,
            _params: conex_types::device::ApprovalHistoryParams,
        ) -> Result<conex_types::device::ApprovalHistoryResult, ServerError> {
            self.fail()?;
            Ok(conex_types::device::ApprovalHistoryResult {
                items: vec![
                    conex_types::device::ApprovalHistoryItem {
                        sequence: 12,
                        tool_call_id: "tc-5".to_string(),
                        tool_name: None,
                        decision: conex_types::events::ApprovalDecision::Approved,
                        reason: None,
                        channel: Some(conex_types::device::ApprovalChannel::Mobile),
                        resolved_at: Some(1_754_700_005_000),
                        session_id: Some("s-1".to_string()),
                        run_id: Some("r-1".to_string()),
                    },
                    conex_types::device::ApprovalHistoryItem {
                        sequence: 14,
                        tool_call_id: "tc-6".to_string(),
                        tool_name: None,
                        decision: conex_types::events::ApprovalDecision::Denied,
                        reason: Some("风险过高".to_string()),
                        channel: Some(conex_types::device::ApprovalChannel::Mobile),
                        resolved_at: Some(1_754_700_006_000),
                        session_id: Some("s-1".to_string()),
                        run_id: Some("r-1".to_string()),
                    },
                ],
                next_after_sequence: Some(14),
                has_more: Some(false),
            })
        }

        async fn settings_get(
            &self,
            params: conex_types::device::GetSettingsParams,
        ) -> Result<conex_types::device::GetSettingsResult, ServerError> {
            self.fail()?;
            *self.last_settings_keys.lock().unwrap() = params.keys.clone();
            Ok(conex_types::device::GetSettingsResult {
                settings: serde_json::json!({
                    "apiKey": "",
                    "baseUrl": "https://api.example.com",
                    "model": "deepseek-v4",
                    "hasApiKey": true,
                    "credentialMode": "direct",
                    "endpoint": "responses",
                    "stream": true,
                }),
            })
        }

        async fn settings_set(
            &self,
            params: SettingsUpdateParams,
        ) -> Result<conex_types::device::GetSettingsResult, ServerError> {
            self.fail()?;
            if params.credential_mode.is_some()
                || params.endpoint.is_some()
                || params.stream.is_some()
            {
                return Err(Self::invalid(
                    "credentialMode / endpoint / stream 不在 REST 非敏感配置更新面（mock）",
                ));
            }
            Ok(conex_types::device::GetSettingsResult {
                settings: serde_json::json!({
                    "apiKey": "",
                    "baseUrl": params.base_url.unwrap_or_else(|| "https://api.example.com".to_string()),
                    "model": params.model.unwrap_or_else(|| "deepseek-v4".to_string()),
                    "hasApiKey": true,
                    "credentialMode": "direct",
                    "endpoint": "responses",
                    "stream": true,
                }),
            })
        }

        // ── R2-12c 新增面（C21/C30/C31 透传断言；C22 占位继承缺省）──

        async fn search_files(
            &self,
            params: SearchFilesParams,
        ) -> Result<SearchFilesResult, ServerError> {
            self.fail()?;
            *self.last_search_files.lock().unwrap() = Some(params);
            Ok(SearchFilesResult {
                results: vec![
                    FileSearchHit {
                        rel_path: "src/main.rs".to_string(),
                        kind: None,
                        size: None,
                    },
                    FileSearchHit {
                        rel_path: "README.md".to_string(),
                        kind: None,
                        size: None,
                    },
                ],
            })
        }

        async fn settings_confirm(
            &self,
            params: SettingsConfirmParams,
        ) -> Result<SettingsConfirmResult, ServerError> {
            self.fail()?;
            *self.last_settings_confirm.lock().unwrap() = Some(params);
            Ok(SettingsConfirmResult {
                status: SettingsConfirmStatus::Withdrawn,
                reason: Some("mock 回执".to_string()),
            })
        }

        async fn pause_automation(
            &self,
            params: PauseAutomationParams,
        ) -> Result<PauseAutomationResult, ServerError> {
            self.fail()?;
            *self.last_pause_duration.lock().unwrap() = params.duration_sec;
            Ok(PauseAutomationResult {
                ok: true,
                paused_until: 1_754_700_060_000,
            })
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

    #[test]
    fn backend_injectable_into_state() {
        let handle = ServerHandle::new(
            ServerConfig::new(std::env::temp_dir()),
            "127.0.0.1:0".parse().unwrap(),
        );
        let backend: Option<Arc<dyn crate::server::backend::ApiBackend>> =
            Some(Arc::new(MockBackend::new()));
        let state = ServerState::new(
            &handle,
            TokenStore::new(std::env::temp_dir().join("pairing-router-inject-test.json")),
            backend,
        );
        assert!(state.backend().is_some(), "backend 注入后应可读取");
    }

    #[tokio::test]
    async fn info_endpoint_shape() {
        let app = build_router(test_state());
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .uri(INFO_PATH)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let info: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(info["service"].as_str(), Some("crish-agent-workbench"));
        assert!(info["version"].is_string());
        assert_eq!(info["protocolVersion"].as_u64(), Some(1));
        assert_eq!(info["minProtocolVersion"].as_u64(), Some(1));
        assert_eq!(info["bindMode"].as_str(), Some("loopback"));
        assert_eq!(info["pairingActive"].as_bool(), Some(false));
        assert!(info["port"].is_u64(), "port 必须存在");
        assert!(info["serverTimeMs"].is_u64(), "serverTimeMs 必须存在");
        let caps = info["capabilities"]
            .as_object()
            .expect("capabilities 必须为对象");
        assert_eq!(caps.len(), 17, "能力位必须 17 位全表");
    }

    #[tokio::test]
    async fn hello_without_token_succeeds_and_returns_clock() {
        let app = build_router(test_state());
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .uri(HELLO_PATH)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response
            .headers()
            .contains_key(crate::server::auth::SERVER_TIME_HEADER));
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["protocolVersion"].as_u64(), Some(1));
        assert!(body["serverVersion"].is_string());
        assert!(body["serverTimeMs"].is_u64());
    }

    #[tokio::test]
    async fn status_without_token_is_401() {
        let app = build_router(test_state());
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .uri(STATUS_PATH)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(response
            .headers()
            .contains_key(crate::server::auth::SERVER_TIME_HEADER));
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body.code, DeviceErrorCode::AuthBadSignature);
        assert!(!body.retryable);
    }

    #[tokio::test]
    async fn hello_with_valid_token_succeeds() {
        let state = test_state();
        let raw = issue_token(&state);
        let app = build_router(state);
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .uri(HELLO_PATH)
                    .header(axum::http::header::AUTHORIZATION, format!("Bearer {raw}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response
            .headers()
            .contains_key(crate::server::auth::SERVER_TIME_HEADER));
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["protocolVersion"].as_u64(), Some(1));
        assert!(body["serverVersion"].is_string());
        assert!(body["serverTimeMs"].is_u64());
    }

    #[tokio::test]
    async fn status_with_revoked_token_is_401() {
        let state = test_state();
        let raw = issue_token(&state);
        let hash = sha256_hex(raw.as_bytes());
        assert!(state.tokens().lock().unwrap().revoke(&hash));
        let app = build_router(state);
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .uri(STATUS_PATH)
                    .header(axum::http::header::AUTHORIZATION, format!("Bearer {raw}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body.code, DeviceErrorCode::AuthDeviceRevoked);
    }

    #[tokio::test]
    async fn malformed_auth_header_is_401() {
        let app = build_router(test_state());
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .uri(STATUS_PATH)
                    // 非 Bearer 前缀 / 空令牌
                    .header(axum::http::header::AUTHORIZATION, "Token abc")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    // ── R1-10 T-01：伪造端无令牌直连 ──

    /// T-01 伪造端直连（无令牌）：状态只读 / 会话列表 / 审批写面代表性端点一律
    /// 401 + AuthBadSignature（D2 §7.1 零信任：认证先于一切业务面），并注入 X-Server-Time-Ms
    #[tokio::test]
    async fn t01_no_token_direct_connection_rejected() {
        let app = build_router(test_state());
        let cases = [
            ("只读状态面", "GET", STATUS_PATH),
            ("会话列表面", "GET", SESSIONS_PATH),
            ("审批写面", "POST", "/v1/approval/tc-fake/approve"),
        ];
        for (label, method, uri) in cases {
            let request = axum::http::Request::builder()
                .uri(uri)
                .method(method)
                .body(Body::empty())
                .unwrap();
            let response = app.clone().oneshot(request).await.unwrap();
            assert_eq!(
                response.status(),
                StatusCode::UNAUTHORIZED,
                "{label} {uri} 无令牌直连必须 401"
            );
            assert!(
                response
                    .headers()
                    .contains_key(crate::server::auth::SERVER_TIME_HEADER),
                "{label} 401 响应头必须携带 X-Server-Time-Ms"
            );
            let body: ErrorBody = serde_json::from_value(json_body(response).await)
                .expect("401 载荷必须可反序列化为 ErrorBody");
            assert_eq!(
                body.code,
                DeviceErrorCode::AuthBadSignature,
                "{label} 无令牌错误码必须为 auth.bad_signature"
            );
            assert!(!body.retryable, "{label} 认证失败不可重试");
        }
    }

    /// T-01 伪造令牌（错误令牌）直连：认证失败 + 失败计数（R1-10 T-01
    /// 计数锚——伪造端每次失败按尝试令牌哈希累计）；合法令牌不受影响
    #[tokio::test]
    async fn t01_forged_token_rejected_and_counts_failure() {
        let state = test_state_with(Some(MockBackend::new()));
        let app = build_router(state.clone());
        let forged = "f".repeat(64);
        let forged_hash = sha256_hex(forged.as_bytes());
        for expected in 1..=3 {
            let response = app
                .clone()
                .oneshot(authed_get(STATUS_PATH, &forged))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
            let body: ErrorBody = serde_json::from_value(json_body(response).await)
                .expect("401 载荷必须可反序列化为 ErrorBody");
            assert_eq!(body.code, DeviceErrorCode::AuthBadSignature);
            let count = state
                .tokens()
                .lock()
                .unwrap()
                .auth_failure_count(&forged_hash);
            assert_eq!(
                count, expected,
                "第 {expected} 次伪造直连后失败计数应为 {expected}"
            );
        }
        // 合法令牌随后可正常通过（伪造尝试不影响合法路径）
        let raw = issue_token(&state);
        let response = app
            .clone()
            .oneshot(authed_get(STATUS_PATH, &raw))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    // ── R1-10 T-11：撤销即时性（重连被拒） ──

    /// T-11 撤销即时性：撤销前旧令牌可连（200）→ 撤销后同一令牌重连请求
    /// 立即被拒（401 + AuthDeviceRevoked）；Revoked 失败计入认证失败计数
    #[tokio::test]
    async fn t11_reconnect_with_revoked_token_rejected() {
        let state = test_state_with(Some(MockBackend::new()));
        let raw = issue_token(&state);
        let hash = sha256_hex(raw.as_bytes());
        let app = build_router(state.clone());

        // 撤销前：旧令牌连接成功
        let before = app
            .clone()
            .oneshot(authed_get(STATUS_PATH, &raw))
            .await
            .unwrap();
        assert_eq!(before.status(), StatusCode::OK, "撤销前旧令牌应可连");

        // 撤销（注册表删除）→ 旧令牌重连请求被拒
        assert!(state.tokens().lock().unwrap().revoke(&hash));
        let after = app
            .clone()
            .oneshot(authed_get(STATUS_PATH, &raw))
            .await
            .unwrap();
        assert_eq!(
            after.status(),
            StatusCode::UNAUTHORIZED,
            "撤销后旧令牌重连必须被拒"
        );
        let body: ErrorBody = serde_json::from_value(json_body(after).await)
            .expect("401 载荷必须可反序列化为 ErrorBody");
        assert_eq!(
            body.code,
            DeviceErrorCode::AuthDeviceRevoked,
            "撤销后重连错误码必须为 auth.device_revoked"
        );
        // Revoked 计入认证失败计数（T-01 计数锚与 T-11 联动）
        let count = state.tokens().lock().unwrap().auth_failure_count(&hash);
        assert_eq!(count, 1, "撤销后重放一次 = 一次认证失败");
    }

    #[tokio::test]
    async fn unknown_path_returns_404_error_body() {
        let app = build_router(test_state());
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/v1/does-not-exist")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body.code, DeviceErrorCode::CmdNotFound);
    }

    #[tokio::test]
    async fn error_response_maps_status_and_body() {
        let response = error_response(&ServerError::protocol(
            DeviceErrorCode::PairExpired,
            "配对码已过期",
        ));
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body.code, DeviceErrorCode::PairExpired);
    }

    // ── R1-03 只读面：鉴权 ──

    /// 全部 10 条只读端点无令牌必须 401（D2 §7.1 零信任）
    #[tokio::test]
    async fn all_read_endpoints_require_token() {
        let app = build_router(test_state());
        for (path, label) in [
            (STATUS_PATH, "status"),
            (RUN_SNAPSHOT_PATH, "run snapshot"),
            (RUN_EVENTS_PATH, "run events"),
            (SESSIONS_PATH, "sessions"),
            (SESSION_EVENTS_PATH, "session events"),
            (SESSION_FLOW_PATH, "session flow"),
            (TASKS_PATH, "tasks"),
            (TASK_OUTPUT_PATH, "task output"),
            (COMMANDS_PATH, "commands"),
            (SEARCH_INDEX_PATH, "search index"),
        ] {
            // 路径参数用具体值（{id} 段占位符不可直接请求）
            let uri = path
                .replace("{id}", "x-1")
                .replace("{sessionId}", "s-1")
                .replace("{runId}", "r-1")
                .replace("{taskId}", "t-1");
            let response = app
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .uri(&uri)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::UNAUTHORIZED,
                "{label}（{uri}）无令牌必须 401"
            );
        }
    }

    // ── R1-03 只读面：C01 状态 ──

    #[tokio::test]
    async fn status_endpoint_returns_m6_subset() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        let response = app.oneshot(authed_get("/v1/status", &token)).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["initialized"], true);
        assert_eq!(body["engineReady"], true);
        assert_eq!(body["providerStatus"]["model"], "deepseek-v4");
        assert_eq!(body["restore"]["state"], "done");
        assert_eq!(body["activeRuns"][0]["runId"], "r-1");
        assert_eq!(body["pendingApprovals"][0]["toolCallId"], "tc-9");
    }

    #[tokio::test]
    async fn query_params_are_percent_decoded() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        // %2D = '-'（编码后的查询值仍应正确解码 → 200 而非 400）
        let response = app
            .clone()
            .oneshot(authed_get("/v1/runs/r-1/snapshot?sessionId=s%2D1", &token))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        // 非法百分号编码 → cmd.invalid 400
        let response = app
            .oneshot(authed_get("/v1/runs/r-1/snapshot?sessionId=s%ZZ1", &token))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = json_body(response).await;
        assert_eq!(body["code"], "cmd.invalid");
    }

    // ── R1-03 只读面：C02 run 快照 ──

    #[tokio::test]
    async fn run_snapshot_endpoint_returns_snapshot() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        let response = app
            .oneshot(authed_get("/v1/runs/r-1/snapshot?sessionId=s-1", &token))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["snapshot"]["runId"], "r-1");
        assert_eq!(body["snapshot"]["status"], "running");
        assert_eq!(body["snapshot"]["cursor"], 127);
        assert_eq!(body["snapshot"]["usage"]["sampleCount"], 3);
    }

    #[tokio::test]
    async fn run_snapshot_unknown_run_is_404() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        let response = app
            .oneshot(authed_get("/v1/runs/r-missing/snapshot", &token))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = json_body(response).await;
        assert_eq!(body["code"], "cmd.not_found");
    }

    // ── R1-03 只读面：C03 会话事件分页（游标契约核心）──

    #[tokio::test]
    async fn session_events_cursor_pagination_forward() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        // afterSequence=2 开区间 + maxEvents=2 → 取 [3,4]，hasMore
        let response = app
            .oneshot(authed_get(
                "/v1/sessions/s-1/events?afterSequence=2&maxEvents=2",
                &token,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["events"].as_array().unwrap().len(), 2);
        assert_eq!(body["events"][0]["sequence"], 3);
        assert_eq!(body["events"][1]["sequence"], 4);
        assert_eq!(body["nextAfterSequence"], 4);
        assert_eq!(body["hasMore"], true);
        assert_eq!(body["latestSequence"], 5);
    }

    #[tokio::test]
    async fn session_events_next_page_terminates() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        let response = app
            .oneshot(authed_get(
                "/v1/sessions/s-1/events?afterSequence=4&maxEvents=10",
                &token,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["events"].as_array().unwrap().len(), 1);
        assert_eq!(body["events"][0]["sequence"], 5);
        assert_eq!(body["nextAfterSequence"], 5);
        assert_eq!(body["hasMore"], false);
    }

    #[tokio::test]
    async fn session_events_default_page_size_200() {
        let state = test_state_with(Some(MockBackend::with_events(250)));
        let token = issue_token(&state);
        let app = build_router(state);
        // 缺省 maxEvents = 200（对齐 EventPage 契约）
        let response = app
            .oneshot(authed_get("/v1/sessions/s-1/events", &token))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["events"].as_array().unwrap().len(), 200);
        assert_eq!(body["hasMore"], true);
    }

    #[tokio::test]
    async fn session_events_max_events_clamped_to_1000() {
        let state = test_state_with(Some(MockBackend::with_events(1500)));
        let token = issue_token(&state);
        let app = build_router(state);
        // maxEvents=10000 夹紧到 1000（对齐 normalize_max_events，不报错）
        let response = app
            .oneshot(authed_get(
                "/v1/sessions/s-1/events?maxEvents=10000",
                &token,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["events"].as_array().unwrap().len(), 1000);
        assert_eq!(body["hasMore"], true);
    }

    #[tokio::test]
    async fn session_events_empty_page_keeps_cursor() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        // 游标越过尾部 → 空页，nextAfterSequence 保持入参（对齐 EventPage）
        let response = app
            .oneshot(authed_get(
                "/v1/sessions/s-1/events?afterSequence=99",
                &token,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["events"].as_array().unwrap().len(), 0);
        assert_eq!(body["nextAfterSequence"], 99);
        assert_eq!(body["hasMore"], false);
    }

    #[tokio::test]
    async fn session_events_unknown_session_is_404() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        let response = app
            .oneshot(authed_get("/v1/sessions/s-missing/events", &token))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = json_body(response).await;
        assert_eq!(body["code"], "cmd.not_found");
    }

    #[tokio::test]
    async fn session_events_invalid_params_are_400() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        for (uri, label) in [
            (
                "/v1/sessions/s-1/events?afterSequence=abc",
                "afterSequence 非数字",
            ),
            (
                "/v1/sessions/s-1/events?afterSequence=-5",
                "afterSequence 负值",
            ),
            ("/v1/sessions/s-1/events?maxEvents=-5", "maxEvents 负值"),
            (
                "/v1/sessions/s-1/events?direction=sideways",
                "direction 非法",
            ),
        ] {
            let response = app.clone().oneshot(authed_get(uri, &token)).await.unwrap();
            assert_eq!(
                response.status(),
                StatusCode::BAD_REQUEST,
                "{label} 必须 400"
            );
            let body = json_body(response).await;
            assert_eq!(
                body["code"], "cmd.invalid",
                "{label} 错误码应为 cmd.invalid"
            );
        }
    }

    // ── R1-03 只读面：C04 run 事件分页 ──

    #[tokio::test]
    async fn run_events_endpoint_paginates_by_cursor() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        let response = app
            .clone()
            .oneshot(authed_get(
                "/v1/runs/r-1/events?afterSequence=0&maxEvents=3",
                &token,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["events"].as_array().unwrap().len(), 3);
        assert_eq!(body["nextAfterSequence"], 3);
        assert_eq!(body["hasMore"], true);
        // 未知 run → 404（对齐 core_read_run_events NotFound 语义）
        let response = app
            .oneshot(authed_get("/v1/runs/r-missing/events", &token))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = json_body(response).await;
        assert_eq!(body["code"], "cmd.not_found");
    }

    // ── R1-03 只读面：C05 会话列表 ──

    #[tokio::test]
    async fn list_sessions_endpoint_returns_index() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        let response = app
            .oneshot(authed_get("/v1/sessions?includeLastMessage=true", &token))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["sessions"][0]["id"], "s-1");
        assert_eq!(body["sessions"][0]["title"], "修复登录页 bug");
        assert_eq!(body["sessions"][0]["messageCount"], 42);
        assert_eq!(body["sessions"][0]["engineCursor"], 128);
    }

    // ── R1-03 只读面：C06 后台任务列表 ──

    #[tokio::test]
    async fn list_tasks_endpoint_returns_summary() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        let response = app.oneshot(authed_get("/v1/tasks", &token)).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["tasks"].as_array().unwrap().len(), 2);
        assert_eq!(body["tasks"][0]["taskId"], "t-1");
        assert_eq!(body["tasks"][0]["status"], "running");
        assert_eq!(body["tasks"][1]["status"], "completed");
        assert!(
            body["tasks"][0].get("output").is_none(),
            "列表不携带输出内容"
        );
    }

    // ── R1-03 只读面：C07 任务输出补取 ──

    #[tokio::test]
    async fn task_output_endpoint_paginates_lines() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        // afterLine 偏移分页
        let response = app
            .clone()
            .oneshot(authed_get(
                "/v1/tasks/t-1/output?maxLines=10&afterLine=5",
                &token,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["lines"].as_array().unwrap().len(), 10);
        assert_eq!(body["lines"][0], "line 5");
        assert_eq!(body["lines"][9], "line 14");
        assert_eq!(body["lineCount"], 100);
        assert_eq!(body["nextAfterLine"], 15);
        assert_eq!(body["hasMore"], true);
        assert_eq!(body["truncated"], true);
        // 缺省整页（maxLines 缺省 200 > 100 行 → 全部 + 无更多）
        let response = app
            .oneshot(authed_get("/v1/tasks/t-1/output", &token))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["lines"].as_array().unwrap().len(), 100);
        assert_eq!(body["hasMore"], false);
    }

    #[tokio::test]
    async fn task_output_unknown_task_is_404() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        let response = app
            .oneshot(authed_get("/v1/tasks/t-missing/output", &token))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = json_body(response).await;
        assert_eq!(body["code"], "cmd.not_found");
    }

    // ── R1-03 只读面：C08 流程快照 ──

    #[tokio::test]
    async fn flow_snapshot_endpoint_returns_dag_summary() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        let response = app
            .clone()
            .oneshot(authed_get("/v1/sessions/s-1/flow", &token))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["flow"]["agents"][0]["agentId"], "sub-3");
        assert_eq!(body["flow"]["agents"][0]["status"], "running");
        // 未知会话 → 404
        let response = app
            .oneshot(authed_get("/v1/sessions/s-missing/flow", &token))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = json_body(response).await;
        assert_eq!(body["code"], "cmd.not_found");
    }

    // ── R1-03 只读面：C09 命令清单 ──

    #[tokio::test]
    async fn list_commands_endpoint_returns_manifest() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        let response = app
            .oneshot(authed_get("/v1/commands", &token))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["contractVersion"], "1.0.0");
        assert_eq!(body["commands"][0]["name"], "core_get_status");
        assert_eq!(body["commands"][0]["surface"], "engine");
        assert_eq!(body["commands"][0]["registered"], true);
    }

    // ── R1-03 只读面：C10 搜索索引状态 ──

    #[tokio::test]
    async fn search_index_endpoint_returns_ready_state() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        let response = app
            .oneshot(authed_get("/v1/search/index", &token))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["ready"], true);
        assert_eq!(body["state"]["totalFiles"], 1200);
    }

    // ── R1-03 只读面：错误映射 ──

    #[tokio::test]
    async fn backend_not_wired_returns_500_internal() {
        let state = test_state();
        let token = issue_token(&state);
        let app = build_router(state);
        let response = app.oneshot(authed_get("/v1/status", &token)).await.unwrap();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body = json_body(response).await;
        assert_eq!(body["code"], "internal");
    }

    #[tokio::test]
    async fn failing_backend_maps_http_status_by_code_domain() {
        let state = test_state_with(Some(MockBackend::failing(DeviceErrorCode::Internal)));
        let token = issue_token(&state);
        let app = build_router(state);
        let response = app
            .clone()
            .oneshot(authed_get("/v1/sessions", &token))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body = json_body(response).await;
        assert_eq!(body["code"], "internal");

        // engine 未就绪 → 409（D2 §8.1.2 映射）
        let state = test_state_with(Some(MockBackend::failing(
            DeviceErrorCode::CmdEngineNotReady,
        )));
        let token = issue_token(&state);
        let app = build_router(state);
        let response = app.oneshot(authed_get("/v1/status", &token)).await.unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = json_body(response).await;
        assert_eq!(body["code"], "cmd.engine_not_ready");
    }

    // ── R1-04 写面：鉴权 ──

    /// 全部 8 条写端点无令牌必须 401（D2 §7.1 零信任；与只读面同组）
    #[tokio::test]
    async fn all_write_endpoints_require_token() {
        let app = build_router(test_state());
        for (method, path, label) in [
            ("POST", RUNS_PATH, "run task"),
            ("POST", RUN_CONTROL_PATH, "run control"),
            ("POST", RUN_CANCEL_PATH, "run cancel"),
            ("POST", APPROVAL_APPROVE_PATH, "approve"),
            ("POST", APPROVAL_DENY_PATH, "deny"),
            ("GET", APPROVALS_PENDING_PATH, "approvals pending"),
            ("GET", APPROVALS_HISTORY_PATH, "approvals history"),
            ("GET", SETTINGS_PATH, "settings get"),
            ("PUT", SETTINGS_PATH, "settings set"),
            // R2-12c 新增写面
            ("POST", SETTINGS_CONFIRM_PATH, "settings confirm"),
            ("POST", PAUSE_AUTOMATION_PATH, "pause automation"),
        ] {
            // 路径参数用具体值（{id} 段占位符不可直接请求）
            let uri = path.replace("{id}", "r-1").replace("{toolCallId}", "tc-9");
            let request = if method == "GET" {
                axum::http::Request::builder()
                    .uri(&uri)
                    .body(Body::empty())
                    .unwrap()
            } else {
                axum::http::Request::builder()
                    .uri(&uri)
                    .method(method)
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from("{}"))
                    .unwrap()
            };
            let response = app.clone().oneshot(request).await.unwrap();
            assert_eq!(
                response.status(),
                StatusCode::UNAUTHORIZED,
                "{label}（{method} {uri}）无令牌必须 401"
            );
        }
    }

    // ── R1-04 写面：C24 发起 run ──

    #[tokio::test]
    async fn run_task_endpoint_starts_run() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        let response = app
            .oneshot(authed_body(
                "POST",
                RUNS_PATH,
                &token,
                serde_json::json!({ "prompt": "帮我修登录页 bug" }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["runId"], "r-remote");
        assert_eq!(body["sessionId"], "s-1");
    }

    #[tokio::test]
    async fn run_task_idempotent_by_client_message_id() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        // 同 clientMessageId 重发 → 回显首次 runId（M6 C24 幂等键）
        let first = app
            .clone()
            .oneshot(authed_body(
                "POST",
                RUNS_PATH,
                &token,
                serde_json::json!({
                    "prompt": "帮我修 bug",
                    "clientMessageId": "msg-01HZ...",
                }),
            ))
            .await
            .unwrap();
        let second = app
            .oneshot(authed_body(
                "POST",
                RUNS_PATH,
                &token,
                serde_json::json!({
                    "prompt": "帮我修 bug",
                    "clientMessageId": "msg-01HZ...",
                }),
            ))
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(second.status(), StatusCode::OK);
        let first_body = json_body(first).await;
        let second_body = json_body(second).await;
        assert_eq!(
            first_body["runId"], second_body["runId"],
            "同 clientMessageId 必须返回同一 runId"
        );
    }

    #[tokio::test]
    async fn run_task_empty_prompt_is_400() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        let response = app
            .oneshot(authed_body(
                "POST",
                RUNS_PATH,
                &token,
                serde_json::json!({ "prompt": "  " }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = json_body(response).await;
        assert_eq!(body["code"], "cmd.invalid");
    }

    #[tokio::test]
    async fn run_task_malformed_body_is_400() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        // 非 JSON / 缺 prompt 字段 → cmd.invalid 400（JsonBody extractor）
        for payload in ["not-json", "{}", r#"{"prompt": 42}"#] {
            let response = app
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .uri(RUNS_PATH)
                        .method("POST")
                        .header(axum::http::header::AUTHORIZATION, format!("Bearer {token}"))
                        .header(axum::http::header::CONTENT_TYPE, "application/json")
                        .body(Body::from(payload.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::BAD_REQUEST,
                "载荷 {payload:?} 必须 400"
            );
            let body = json_body(response).await;
            assert_eq!(body["code"], "cmd.invalid");
        }
    }

    // ── R1-04 写面：C25 run 控制 ──

    #[tokio::test]
    async fn run_control_endpoint_uses_path_run_id() {
        let mock = Arc::new(MockBackend::new());
        let state = test_state_from_backend(Some(Arc::clone(&mock) as Arc<dyn ApiBackend>));
        let token = issue_token(&state);
        let app = build_router(state);
        // 路径 runId = r-1，body 携带 r-wrong → 路径优先（REST 资源地址即真键）
        let response = app
            .oneshot(authed_body(
                "POST",
                "/v1/runs/r-1/control",
                &token,
                serde_json::json!({
                    "level": "cooperative_stop",
                    "runId": "r-wrong",
                    "sessionId": "s-1",
                    "reason": "用户远程暂停",
                }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["ok"], true);
        let received = mock.last_run_control.lock().unwrap().clone().unwrap();
        assert_eq!(received.run_id, "r-1", "路径 runId 必须覆盖 body 值");
        assert_eq!(received.session_id, "s-1");
        assert_eq!(received.reason.as_deref(), Some("用户远程暂停"));
    }

    #[tokio::test]
    async fn run_control_invalid_level_is_400() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        let response = app
            .oneshot(authed_body(
                "POST",
                "/v1/runs/r-1/control",
                &token,
                serde_json::json!({
                    "level": "sideways",
                    "runId": "r-1",
                    "sessionId": "s-1",
                }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = json_body(response).await;
        assert_eq!(body["code"], "cmd.invalid");
    }

    // ── R1-04 写面：C26 取消 run ──

    #[tokio::test]
    async fn cancel_run_endpoint_ok() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        let response = app
            .oneshot(authed_body(
                "POST",
                "/v1/runs/r-1/cancel",
                &token,
                serde_json::json!({ "reason": "用户远程取消" }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["ok"], true);
        assert_eq!(body["runId"], "r-1");
    }

    #[tokio::test]
    async fn cancel_run_unknown_run_is_404() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        let response = app
            .oneshot(authed_body(
                "POST",
                "/v1/runs/r-missing/cancel",
                &token,
                serde_json::json!({}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = json_body(response).await;
        assert_eq!(body["code"], "cmd.not_found");
    }

    // ── R1-04 写面：C11 审批批准 / C12 审批拒绝（I-02 语义核心）──

    #[tokio::test]
    async fn approve_endpoint_ok() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        let response = app
            .oneshot(authed_body(
                "POST",
                "/v1/approval/tc-9/approve",
                &token,
                serde_json::json!({ "runId": "r-1" }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["ok"], true);
        assert_eq!(body["toolCallId"], "tc-9");
        assert_eq!(body["decision"], "approved");
    }

    #[tokio::test]
    async fn approve_duplicate_decision_conflicts_409() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        // 首次决策 → 200；重复决策（幂等键冲突信号）→ 409 approval_mismatch
        let first = app
            .clone()
            .oneshot(authed_body(
                "POST",
                "/v1/approval/tc-9/approve",
                &token,
                serde_json::json!({}),
            ))
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        let second = app
            .oneshot(authed_body(
                "POST",
                "/v1/approval/tc-9/approve",
                &token,
                serde_json::json!({}),
            ))
            .await
            .unwrap();
        assert_eq!(second.status(), StatusCode::CONFLICT, "重复决策必须 409");
        let body = json_body(second).await;
        assert_eq!(body["code"], "cmd.approval_mismatch");
        assert_eq!(body["retryable"], false);
    }

    #[tokio::test]
    async fn approve_unknown_tool_call_is_404() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        let response = app
            .oneshot(authed_body(
                "POST",
                "/v1/approval/tc-missing/approve",
                &token,
                serde_json::json!({}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = json_body(response).await;
        assert_eq!(body["code"], "cmd.not_found");
    }

    #[tokio::test]
    async fn deny_endpoint_ok_with_reason() {
        let mock = Arc::new(MockBackend::new());
        let state = test_state_from_backend(Some(Arc::clone(&mock) as Arc<dyn ApiBackend>));
        let token = issue_token(&state);
        let app = build_router(state);
        let response = app
            .oneshot(authed_body(
                "POST",
                "/v1/approval/tc-7/deny",
                &token,
                serde_json::json!({ "reason": "风险过高" }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["ok"], true);
        assert_eq!(body["toolCallId"], "tc-7");
        assert_eq!(body["decision"], "denied");
        assert_eq!(
            mock.last_deny_reason.lock().unwrap().as_deref(),
            Some("风险过高"),
            "deny 的 reason 必须透传到后端"
        );
    }

    // ── R1-04 写面：C13 待审批对账 / C14 审批历史 ──

    #[tokio::test]
    async fn approvals_pending_endpoint_returns_list() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        let response = app
            .oneshot(authed_get("/v1/approvals/pending", &token))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        let approvals = body["approvals"].as_array().unwrap();
        assert_eq!(approvals.len(), 2);
        assert_eq!(approvals[0]["toolCallId"], "tc-9");
        assert_eq!(approvals[0]["toolName"], "shell:write");
        assert_eq!(approvals[0]["dangerLevel"], 2);
        assert_eq!(approvals[0]["requestId"], "approval-tc-9");
        assert_eq!(approvals[1]["dangerLevel"], 1);
    }

    #[tokio::test]
    async fn approvals_history_endpoint_returns_items() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        let response = app
            .oneshot(authed_get(
                "/v1/approvals/history?sessionId=s-1&afterSequence=10&limit=5",
                &token,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        let items = body["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["sequence"], 12);
        assert_eq!(items[0]["decision"], "approved");
        assert_eq!(items[1]["decision"], "denied");
        assert_eq!(items[1]["reason"], "风险过高");
        assert_eq!(body["nextAfterSequence"], 14);
        assert_eq!(body["hasMore"], false);
    }

    // ── R1-04 写面：C28 设置快照 / C29 非敏感配置更新 ──

    #[tokio::test]
    async fn settings_get_endpoint_returns_snapshot_and_forwards_keys() {
        let mock = Arc::new(MockBackend::new());
        let state = test_state_from_backend(Some(Arc::clone(&mock) as Arc<dyn ApiBackend>));
        let token = issue_token(&state);
        let app = build_router(state);
        let response = app
            .oneshot(authed_get("/v1/settings?keys=model,baseUrl", &token))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["settings"]["model"], "deepseek-v4");
        // 快照脱敏：apiKey 恒空串（K-02 由 config 层保证，mock 同形状）
        assert_eq!(body["settings"]["apiKey"], "");
        assert_eq!(
            mock.last_settings_keys.lock().unwrap().as_deref(),
            Some(vec!["model".to_string(), "baseUrl".to_string()]).as_deref(),
            "keys 必须解析为列表透传到后端"
        );
    }

    #[tokio::test]
    async fn settings_set_endpoint_updates() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        let response = app
            .oneshot(authed_body(
                "PUT",
                SETTINGS_PATH,
                &token,
                serde_json::json!({ "model": "deepseek-v5" }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["settings"]["model"], "deepseek-v5");
    }

    #[tokio::test]
    async fn settings_set_restricted_fields_are_400() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        for (payload, label) in [
            (
                serde_json::json!({ "credentialMode": "direct" }),
                "credentialMode 拒绝字段",
            ),
            (
                serde_json::json!({ "endpoint": "auto" }),
                "endpoint 拒绝字段",
            ),
            (serde_json::json!({ "stream": false }), "stream 拒绝字段"),
        ] {
            let response = app
                .clone()
                .oneshot(authed_body("PUT", SETTINGS_PATH, &token, payload))
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::BAD_REQUEST,
                "{label} 必须 400"
            );
            let body = json_body(response).await;
            assert_eq!(
                body["code"], "cmd.invalid",
                "{label} 错误码应为 cmd.invalid"
            );
        }
    }

    // ── R2-12c 新增面：C21 文件搜索 / C22 资源 URL / C30 设置确认 / C31 暂停 ──

    /// 鉴权：4 条新端点无令牌一律 401（与只读/写面同组零信任）
    #[tokio::test]
    async fn r2_12_new_endpoints_require_token() {
        let app = build_router(test_state());
        for (method, path, label) in [
            ("GET", SEARCH_FILES_PATH, "search files"),
            ("GET", ASSET_URL_PATH, "asset url"),
            ("POST", SETTINGS_CONFIRM_PATH, "settings confirm"),
            ("POST", PAUSE_AUTOMATION_PATH, "pause automation"),
        ] {
            let request = axum::http::Request::builder()
                .uri(path)
                .method(method)
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .unwrap();
            let response = app.clone().oneshot(request).await.unwrap();
            assert_eq!(
                response.status(),
                StatusCode::UNAUTHORIZED,
                "{label}（{method} {path}）无令牌必须 401"
            );
        }
    }

    /// C21：搜索端点返回命中 + 查询参数透传后端（query / root / maxResults
    /// 原样抵达）
    #[tokio::test]
    async fn r2_12_search_files_endpoint_returns_hits_and_forwards_params() {
        let mock = Arc::new(MockBackend::new());
        let state = test_state_from_backend(Some(Arc::clone(&mock) as Arc<dyn ApiBackend>));
        let token = issue_token(&state);
        let app = build_router(state);
        let response = app
            .oneshot(authed_get(
                "/v1/search/files?query=login&root=src&maxResults=50",
                &token,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["results"][0]["relPath"], "src/main.rs");
        assert_eq!(body["results"][1]["relPath"], "README.md");
        let received = mock.last_search_files.lock().unwrap().clone().unwrap();
        assert_eq!(received.query, "login");
        assert_eq!(received.root.as_deref(), Some("src"));
        assert_eq!(received.max_results, Some(50));
    }

    /// C21：query 缺失/空串 → 400 cmd.invalid（注册表必填 1-256）；
    /// maxResults 非数字 → 400
    #[tokio::test]
    async fn r2_12_search_files_invalid_params_are_400() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        for (uri, label) in [
            ("/v1/search/files", "query 缺失"),
            ("/v1/search/files?query=%20%20", "query 空白"),
            (
                "/v1/search/files?query=main&maxResults=abc",
                "maxResults 非数字",
            ),
        ] {
            let response = app.clone().oneshot(authed_get(uri, &token)).await.unwrap();
            assert_eq!(
                response.status(),
                StatusCode::BAD_REQUEST,
                "{label} 必须 400"
            );
            let body = json_body(response).await;
            assert_eq!(
                body["code"], "cmd.invalid",
                "{label} 错误码应为 cmd.invalid"
            );
        }
    }

    /// C22：资源 URL 占位 → 501 + cmd.unknown（F4 §5.4 资源代理未实现，
    /// 诚实降级不捏造 URL；错误码经 http_status 映射 501）
    #[tokio::test]
    async fn r2_12_asset_url_placeholder_returns_501() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        let response = app
            .oneshot(authed_get(
                "/v1/assets/url?path=docs%2Fx.png&kind=image",
                &token,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_IMPLEMENTED);
        let body = json_body(response).await;
        assert_eq!(body["code"], "cmd.unknown");
        assert_eq!(body["retryable"], false);
    }

    /// C22：kind 缺失 → 400 cmd.invalid（注册表 AssetUrlParams.kind 必填）
    #[tokio::test]
    async fn r2_12_asset_url_missing_kind_is_400() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        for (uri, label) in [
            ("/v1/assets/url?path=docs%2Fx.png", "kind 缺失"),
            (
                "/v1/assets/url?path=docs%2Fx.png&kind=sideways",
                "kind 非法",
            ),
        ] {
            let response = app.clone().oneshot(authed_get(uri, &token)).await.unwrap();
            assert_eq!(
                response.status(),
                StatusCode::BAD_REQUEST,
                "{label} 必须 400"
            );
            let body = json_body(response).await;
            assert_eq!(
                body["code"], "cmd.invalid",
                "{label} 错误码应为 cmd.invalid"
            );
        }
    }

    /// C30：确认回执端点返回状态 + 参数透传（confirmRequestId / action）
    #[tokio::test]
    async fn r2_12_settings_confirm_endpoint_returns_status_and_forwards() {
        let mock = Arc::new(MockBackend::new());
        let state = test_state_from_backend(Some(Arc::clone(&mock) as Arc<dyn ApiBackend>));
        let token = issue_token(&state);
        let app = build_router(state);
        let response = app
            .oneshot(authed_body(
                "POST",
                SETTINGS_CONFIRM_PATH,
                &token,
                serde_json::json!({ "confirmRequestId": "req-1", "action": "withdraw" }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["status"], "withdrawn");
        assert_eq!(body["reason"], "mock 回执");
        let received = mock.last_settings_confirm.lock().unwrap().clone().unwrap();
        assert_eq!(received.confirm_request_id, "req-1");
        assert_eq!(received.action, SettingsConfirmAction::Withdraw);
    }

    /// C30：body 非法（缺 confirmRequestId / action 枚举非法）→ 400 cmd.invalid
    #[tokio::test]
    async fn r2_12_settings_confirm_invalid_body_is_400() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        for (payload, label) in [
            (
                serde_json::json!({ "action": "query" }),
                "缺 confirmRequestId",
            ),
            (
                serde_json::json!({ "confirmRequestId": "req-1", "action": "sideways" }),
                "action 非法",
            ),
            (serde_json::json!("not-an-object"), "非对象 body"),
        ] {
            let response = app
                .clone()
                .oneshot(authed_body("POST", SETTINGS_CONFIRM_PATH, &token, payload))
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::BAD_REQUEST,
                "{label} 必须 400"
            );
            let body = json_body(response).await;
            assert_eq!(
                body["code"], "cmd.invalid",
                "{label} 错误码应为 cmd.invalid"
            );
        }
    }

    /// C31：暂停端点返回 {ok, pausedUntil} + durationSec 透传后端
    #[tokio::test]
    async fn r2_12_pause_automation_endpoint_ok_and_forwards_duration() {
        let mock = Arc::new(MockBackend::new());
        let state = test_state_from_backend(Some(Arc::clone(&mock) as Arc<dyn ApiBackend>));
        let token = issue_token(&state);
        let app = build_router(state);
        let response = app
            .clone()
            .oneshot(authed_body(
                "POST",
                PAUSE_AUTOMATION_PATH,
                &token,
                serde_json::json!({ "durationSec": 120 }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["ok"], true);
        assert_eq!(body["pausedUntil"], 1_754_700_060_000_u64);
        assert_eq!(
            *mock.last_pause_duration.lock().unwrap(),
            Some(120),
            "durationSec 必须透传到后端（钳制在装配面执行）"
        );
        // 缺省 durationSec → 透传 None（后端按缺省 3600 处理）
        let response = app
            .oneshot(authed_body(
                "POST",
                PAUSE_AUTOMATION_PATH,
                &token,
                serde_json::json!({}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(*mock.last_pause_duration.lock().unwrap(), None);
    }

    /// C31：body 非法（durationSec 非数字 / 非对象）→ 400 cmd.invalid
    #[tokio::test]
    async fn r2_12_pause_automation_invalid_body_is_400() {
        let state = test_state_with(Some(MockBackend::new()));
        let token = issue_token(&state);
        let app = build_router(state);
        for (payload, label) in [
            (
                serde_json::json!({ "durationSec": "abc" }),
                "durationSec 非数字",
            ),
            (serde_json::json!("not-an-object"), "非对象 body"),
        ] {
            let response = app
                .clone()
                .oneshot(authed_body("POST", PAUSE_AUTOMATION_PATH, &token, payload))
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::BAD_REQUEST,
                "{label} 必须 400"
            );
            let body = json_body(response).await;
            assert_eq!(
                body["code"], "cmd.invalid",
                "{label} 错误码应为 cmd.invalid"
            );
        }
    }

    /// 白名单对账（G-5 双源）：4 条新端点对应命令必须登记于远程白名单
    /// （白名单是命令执行面唯一真源——端点与白名单漂移即红）
    #[test]
    fn r2_12_endpoints_registered_in_whitelist() {
        for command in [
            "searchFiles",
            "assetUrl",
            "settingsConfirm",
            "pauseAutomation",
        ] {
            assert!(
                crate::server::remote_whitelist::is_remote_command_whitelisted(command),
                "命令 {command} 必须登记于远程白名单（R2-12c 新端点）"
            );
        }
    }

    // ── R1-10 T-07：远程面白名单拒绝（密钥命令面触达；D5 §9.1）──

    /// 白名单拒绝：密钥命令面（config_secret_reveal 等）在 REST 面（=
    /// 远程面）无路由 → 403 Forbidden（cmd.denied「命令被安全策略拒绝」）
    /// + remote-source-attempt 审计标记发射（handle_not_found 拒绝分支）
    #[tokio::test]
    async fn t07_secret_command_surface_rejected_forbidden() {
        let app = build_router(test_state());
        for (name, label) in [
            ("config_secret_reveal", "密钥 reveal 命令"),
            ("config_secret_get", "密钥 get 命令"),
            ("config_secret_set", "密钥 set 命令"),
            ("config_secret_clear", "密钥 clear 命令"),
            ("config_secret_has", "密钥 has 命令"),
            ("workbench_run_shell", "shell 执行面"),
            ("workbench_git_run", "git 执行面"),
            ("host_openers", "宿主打开器面"),
        ] {
            let uri = format!("/v1/commands/{name}");
            let response = app
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .uri(&uri)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::FORBIDDEN,
                "{label}（{uri}）必须 403 Forbidden"
            );
            let body = json_body(response).await;
            assert_eq!(body["code"], "cmd.denied", "{label} 错误码应为 cmd.denied");
            assert_eq!(body["retryable"], false);
        }
        // 非密钥未知路径仍 404（白名单拒绝不扩大化——未知普通命令不泄露
        // 被禁面信息）
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/v1/commands/unknown_tool_xyz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = json_body(response).await;
        assert_eq!(body["code"], "cmd.not_found");
    }

    /// 审计标记：secret_command_hit 命中/未命中纯函数 + 发射载荷形状
    /// （remote-source-attempt 标记载荷与 core_backend 同源——审计断言锚）
    #[test]
    fn t07_secret_surface_detection_and_audit_marker() {
        for name in SECRET_COMMAND_SURFACE {
            let uri = format!("/v1/commands/{name}").parse::<Uri>().unwrap();
            assert_eq!(secret_command_hit(&uri), Some(*name), "{name} 必须命中");
        }
        let clean: Uri = "/v1/status".parse().unwrap();
        assert_eq!(secret_command_hit(&clean), None, "非密钥路径不得命中");
        let marker =
            crate::server::remote_whitelist::remote_source_attempt_marker("config_secret_reveal");
        assert!(marker.contains("operation=remote-source-attempt"));
        assert!(marker.contains("command=config_secret_reveal"));
        assert!(marker.contains("decision=blocked"));
    }

    // ── R1-11 G-5：远程命令白名单接线（D5 §4.5 M-REG 端到端）──

    /// 审计事件桥测试替身（G-5：remote-source-attempt 事件发射端到端
    /// 断言锚；对齐 core_backend 测试先例）
    #[derive(Default)]
    struct G5RecordingEmitter(std::sync::Mutex<Vec<String>>);

    impl crate::core_event_bridge::Emitter for G5RecordingEmitter {
        fn emit(&self, _channel: &str, payload: &str) {
            self.0.lock().unwrap().push(payload.to_string());
        }
    }

    fn g5_recording_bridge() -> (
        crate::core_event_bridge::EventBridge,
        Arc<G5RecordingEmitter>,
    ) {
        let emitter = Arc::new(G5RecordingEmitter::default());
        let bridge = crate::core_event_bridge::EventBridge::new(
            "workbench-run-event",
            Arc::clone(&emitter) as Arc<dyn crate::core_event_bridge::Emitter>,
        );
        (bridge, emitter)
    }

    /// 命令执行端点与白名单双源对账（防漂移）：REST 命令执行端点
    /// （runTask / runControl / cancelRun）必须登记于远程白名单——未来
    /// 移除白名单条目而保留端点即红（白名单是命令执行面唯一真源）
    #[test]
    fn g5_command_execution_endpoints_registered_in_whitelist() {
        for command in ["runTask", "runControl", "cancelRun"] {
            assert!(
                crate::server::remote_whitelist::is_remote_command_whitelisted(command),
                "命令执行端点 {command} 必须登记于远程白名单"
            );
        }
        // 审批端点不挂执行守卫，但命令面注册表仍完整声明能力位（D5
        // §4.2 审批决策是移动端核心能力）
        for command in ["approve", "deny", "listPendingApprovals", "approvalHistory"] {
            assert!(
                crate::server::remote_whitelist::is_remote_command_whitelisted(command),
                "审批命令 {command} 必须在白名单表内（能力声明）"
            );
        }
    }

    /// 守卫拒绝路径：非白名单命令名 → Err（403 cmd.denied 语义）+ 审计
    /// 事件发射（事件桥注入形态；守卫把白名单拒绝与审计绑成一体——
    /// D5 §4.5「命令名 ∉ 白名单 → 403 cmd.denied + RemoteSourceAttempt
    /// 审计事件」）
    #[test]
    fn g5_whitelist_guard_rejects_off_whitelist_command() {
        let (bridge, emitter) = g5_recording_bridge();
        let state = test_state_with(Some(MockBackend::new())).with_audit_bridge(bridge);
        let err = ensure_command_execution_allowed(&state, "config_secret_reveal")
            .expect_err("非白名单命令名必须被守卫拒绝");
        let response = error_response(&err);
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        // 审计事件：remote-source-attempt + blocked + 命令名 targets
        let recorded = emitter.0.lock().unwrap();
        assert_eq!(recorded.len(), 1, "守卫拒绝必须发射一条审计事件");
        let envelope: conex_types::events::AgentEventEnvelope =
            serde_json::from_str(&recorded[0]).expect("信封 JSON 可解析");
        // 显式释放 guard——后续放行路径断言需再次锁同一 Mutex
        // （std Mutex 不可重入，guard 存活期间重入即死锁）
        drop(recorded);
        let conex_types::events::AgentEvent::SecurityAudit {
            operation,
            targets,
            decision,
            ..
        } = envelope.event
        else {
            panic!("守卫拒绝应发射 SecurityAudit 事件");
        };
        assert_eq!(
            operation,
            conex_types::events::SecurityAuditOperation::RemoteSourceAttempt
        );
        assert_eq!(targets, vec!["config_secret_reveal".to_string()]);
        assert_eq!(
            decision,
            conex_types::events::SecurityAuditDecision::Blocked
        );
        // 白名单内命令名放行（无 Err 无审计）
        assert!(ensure_command_execution_allowed(&state, "runTask").is_ok());
        assert_eq!(emitter.0.lock().unwrap().len(), 1, "放行路径不得发射审计");
    }

    /// 红线 5 / T-07 端到端（R1-11 §3「config_secret_* 远程来源 100%
    /// Forbidden」）：REST 面无 config_secret_* 执行端点（白名单天然
    /// 拦截）——带令牌请求未知路径 /v1/config_secret_reveal → 403
    /// cmd.denied + RemoteSourceAttempt 审计事件（端到端：鉴权面 →
    /// fallback 拒绝分支 → 事件桥发射）
    #[tokio::test]
    async fn t07_config_secret_forbidden_end_to_end_with_audit_event() {
        let (bridge, emitter) = g5_recording_bridge();
        let state = test_state_with(Some(MockBackend::new())).with_audit_bridge(bridge);
        let token = issue_token(&state);
        let app = build_router(state);
        for name in [
            "config_secret_reveal",
            "config_secret_get",
            "config_secret_set",
            "config_secret_clear",
            "config_secret_has",
        ] {
            let uri = format!("/v1/{name}");
            let response = app.clone().oneshot(authed_get(&uri, &token)).await.unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{uri} 必须 403");
            let body = json_body(response).await;
            assert_eq!(body["code"], "cmd.denied", "{uri} 错误码应为 cmd.denied");
            assert_eq!(body["retryable"], false);
        }
        // 审计事件：5 条触达 = 5 条 remote-source-attempt（逐条可对账）
        let recorded = emitter.0.lock().unwrap();
        assert_eq!(recorded.len(), 5, "每条被禁命令触达必须发射一条审计");
        for payload in recorded.iter() {
            let envelope: conex_types::events::AgentEventEnvelope =
                serde_json::from_str(payload).expect("信封 JSON 可解析");
            let conex_types::events::AgentEvent::SecurityAudit {
                operation,
                decision,
                ..
            } = envelope.event
            else {
                panic!("应为 SecurityAudit 事件");
            };
            assert_eq!(
                operation,
                conex_types::events::SecurityAuditOperation::RemoteSourceAttempt
            );
            assert_eq!(
                decision,
                conex_types::events::SecurityAuditDecision::Blocked
            );
        }
    }

    /// REST 已注册端点与 SECRET_COMMAND_SURFACE 双源对账：被禁命令面
    /// 不得注册任何路由（白名单天然拦截的静态面——无路由即 403；未来
    /// 给被禁命令注册路由即红）
    #[test]
    fn g5_rest_routes_never_register_secret_surface() {
        let registered = [
            INFO_PATH,
            HELLO_PATH,
            STATUS_PATH,
            RUN_SNAPSHOT_PATH,
            SESSION_EVENTS_PATH,
            RUN_EVENTS_PATH,
            SESSIONS_PATH,
            TASKS_PATH,
            TASK_OUTPUT_PATH,
            SESSION_FLOW_PATH,
            COMMANDS_PATH,
            SEARCH_INDEX_PATH,
            PAIR_PATH,
            RUNS_PATH,
            RUN_CONTROL_PATH,
            RUN_CANCEL_PATH,
            APPROVAL_APPROVE_PATH,
            APPROVAL_DENY_PATH,
            APPROVALS_PENDING_PATH,
            APPROVALS_HISTORY_PATH,
            SETTINGS_PATH,
            // R2-12c 新增面（C21/C22/C30/C31）
            SEARCH_FILES_PATH,
            ASSET_URL_PATH,
            SETTINGS_CONFIRM_PATH,
            PAUSE_AUTOMATION_PATH,
        ];
        for name in SECRET_COMMAND_SURFACE {
            assert!(
                !registered.iter().any(|path| path.contains(name)),
                "被禁命令面 {name} 不得注册任何 REST 路由"
            );
        }
    }

    // ── R1-10 T-08：远程 run 权限模式申报（装配面降级前置）──

    /// 远程申报 full-access 原样抵达后端装配面（路由层不拦截申报——
    /// 降级语义由装配面 apply_remote_mode 保证：D5 §9.2 operate ×
    /// full-access → ask 降级 + 审计）
    #[tokio::test]
    async fn t08_run_task_passes_permission_mode_wire() {
        let mock = Arc::new(MockBackend::new());
        let state = test_state_from_backend(Some(Arc::clone(&mock) as Arc<dyn ApiBackend>));
        let token = issue_token(&state);
        let app = build_router(state);
        let response = app
            .oneshot(authed_body(
                "POST",
                RUNS_PATH,
                &token,
                serde_json::json!({
                    "prompt": "远程 run（full-access 申报）",
                    "permissionMode": "full-access",
                }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            *mock.last_run_permission_mode.lock().unwrap(),
            Some(conex_types::device::PermissionMode::FullAccess),
            "远程申报 full-access 必须原样透传到后端装配面"
        );
    }

    // ── R1-11 G-2：POST /v1/pair 移动端配对入口 ──

    /// 配对测试状态：服务开关开启 + 配对协调器注入（协调器令牌库与路由
    /// 层令牌库同文件——reload_tokens 收口断言「令牌立即生效」）。
    /// 返回 (state, coordinator)；码经 coordinator.start_pairing 激活。
    fn test_pair_state() -> (ServerState, Arc<crate::server::pairing::PairingCoordinator>) {
        let seq = TOKEN_FILE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let file = std::env::temp_dir().join(format!("pairing-pair-{seq}.json"));
        let mut config = ServerConfig::new(std::env::temp_dir());
        config.multi_device_enabled = true;
        config.pairing_file_path = file.clone();
        let handle = ServerHandle::new(config, "127.0.0.1:0".parse().expect("固定测试地址"));
        let tokens = Arc::new(std::sync::Mutex::new(TokenStore::new(file)));
        let ws_registry = Arc::new(crate::server::ws::WsRegistry::new());
        let coordinator = Arc::new(crate::server::pairing::PairingCoordinator::new(
            tokens,
            ws_registry,
        ));
        let state = ServerState::new(
            &handle,
            TokenStore::new(handle.config().pairing_file_path.clone()),
            Some(Arc::new(MockBackend::new())),
        )
        .with_pairing(Arc::clone(&coordinator));
        (state, coordinator)
    }

    /// 激活配对并返回展示码（CXN-XXXX-XXXX-XXXX）
    fn activate_pairing(coordinator: &crate::server::pairing::PairingCoordinator) -> String {
        coordinator
            .start_pairing(now_ms())
            .expect("激活配对必须成功")
            .code
    }

    /// 无鉴权 JSON POST（/v1/pair 免鉴权端点测试用；注入 ConnectInfo——
    /// 限速读取源 IP，路由经 serve 的 into_make_service_with_connect_info
    /// 装配，测试侧以扩展手动注入对拍）
    fn plain_post(uri: &str, body: serde_json::Value) -> axum::http::Request<Body> {
        plain_post_from_ip(uri, body, "127.0.0.1".parse().expect("固定测试地址"))
    }

    /// 指定源 IP 的无鉴权 JSON POST（每 IP 限速测试用）
    fn plain_post_from_ip(
        uri: &str,
        body: serde_json::Value,
        ip: std::net::IpAddr,
    ) -> axum::http::Request<Body> {
        let mut request = axum::http::Request::builder()
            .uri(uri)
            .method("POST")
            .header(axum::http::header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::new(ip, 40000)));
        request
    }

    /// 免鉴权 POST /v1/pair：正确码 → 200 {token, label?}，且令牌**无
    /// Authorization 头**即可拿到（配对端点豁免鉴权——否则先有令牌才能
    /// 拿令牌）；令牌立即可用于后续鉴权请求（GET /v1/status 200）
    #[tokio::test]
    async fn pair_endpoint_issues_token_usable_immediately() {
        let (state, coordinator) = test_pair_state();
        let code = activate_pairing(&coordinator);
        let app = build_router(state);

        // 无令牌 POST → 200（免鉴权入口）
        let response = app
            .clone()
            .oneshot(plain_post(PAIR_PATH, serde_json::json!({ "code": code })))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        let token = body["token"].as_str().expect("必须返回令牌明文");
        assert_eq!(token.len(), 64, "32B hex 令牌");
        assert!(body.get("label").is_none(), "未提供 label 时省略");

        // 令牌立即可用于后续请求（reload_tokens 收口：协调器 store 与
        // 路由 store 分离的 R1-07 装配断裂修复点）
        let response = app
            .clone()
            .oneshot(authed_get(STATUS_PATH, token))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "新令牌必须立即通过鉴权");
    }

    /// 免鉴权 POST /v1/pair：label 回显；错误码 → 401 + pair.invalid_code
    #[tokio::test]
    async fn pair_endpoint_wrong_code_is_401_with_label_echo() {
        let (state, coordinator) = test_pair_state();
        activate_pairing(&coordinator);
        let app = build_router(state);
        let response = app
            .oneshot(plain_post(
                PAIR_PATH,
                serde_json::json!({ "code": "CXN-AAAA-BBBB-CCCC", "label": "我的手机" }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let body = json_body(response).await;
        assert_eq!(body["code"], "pair.invalid_code");
    }

    /// 格式非法码 → 401 + pair.invalid_code（标准化失败，不计数）
    #[tokio::test]
    async fn pair_endpoint_invalid_format_is_401() {
        let (state, coordinator) = test_pair_state();
        activate_pairing(&coordinator);
        let app = build_router(state);
        let response = app
            .oneshot(plain_post(PAIR_PATH, serde_json::json!({ "code": "BAD" })))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let body = json_body(response).await;
        assert_eq!(body["code"], "pair.invalid_code");
    }

    /// 5 次失败 → 锁定语义（R1-10 T-05 的 REST 形态）：4 次错误仅计数
    /// 401；第 5 次失败后正确码 → 409 + pair.too_many_attempts（对齐
    /// complete_pairing 的 Locked 映射；Destroyed 冷却后的永久失效已由
    /// pairing.rs T-05 状态机测试覆盖——REST 层时钟不可控）
    #[tokio::test]
    async fn pair_endpoint_five_failures_lock_with_409() {
        let (state, coordinator) = test_pair_state();
        let code = activate_pairing(&coordinator);
        let app = build_router(state);
        for _ in 0..4 {
            let response = app
                .clone()
                .oneshot(plain_post(
                    PAIR_PATH,
                    serde_json::json!({ "code": "CXN-AAAA-BBBB-CCCC" }),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
        // 第 5 次错误：计数达上限（仍 401，计数语义）
        let response = app
            .clone()
            .oneshot(plain_post(
                PAIR_PATH,
                serde_json::json!({ "code": "CXN-AAAA-BBBB-CCCC" }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        // 锁定期内正确码 → 409 + pair.too_many_attempts
        let response = app
            .oneshot(plain_post(PAIR_PATH, serde_json::json!({ "code": code })))
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::CONFLICT,
            "锁定期间正确码必须 409"
        );
        let body = json_body(response).await;
        assert_eq!(body["code"], "pair.too_many_attempts");
    }

    /// 服务开关关闭（multi_device.enabled=false）→ 503（服务未开启；
    /// 生产装配面此时根本不 bind，本断言兜住路由层直测语义）
    #[tokio::test]
    async fn pair_endpoint_service_disabled_is_503() {
        let seq = TOKEN_FILE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let file = std::env::temp_dir().join(format!("pairing-pair-disabled-{seq}.json"));
        let mut config = ServerConfig::new(std::env::temp_dir());
        config.multi_device_enabled = false; // 服务开关默认关闭
        config.pairing_file_path = file.clone();
        let handle = ServerHandle::new(config, "127.0.0.1:0".parse().expect("固定测试地址"));
        let tokens = Arc::new(std::sync::Mutex::new(TokenStore::new(file)));
        let coordinator = Arc::new(crate::server::pairing::PairingCoordinator::new(
            tokens,
            Arc::new(crate::server::ws::WsRegistry::new()),
        ));
        let state = ServerState::new(
            &handle,
            TokenStore::new(handle.config().pairing_file_path.clone()),
            None,
        )
        .with_pairing(Arc::clone(&coordinator));
        activate_pairing(&coordinator); // 即使有活跃码也拒绝（开关优先）
        let app = build_router(state);
        let response = app
            .oneshot(plain_post(
                PAIR_PATH,
                serde_json::json!({ "code": "CXN-7K4P-Q2MB-9XRT" }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = json_body(response).await;
        assert_eq!(body["code"], "cmd.denied");
    }

    /// 请求体非法（缺 code / 非 JSON）→ 400 + cmd.invalid
    #[tokio::test]
    async fn pair_endpoint_malformed_body_is_400() {
        let (state, coordinator) = test_pair_state();
        activate_pairing(&coordinator);
        let app = build_router(state);
        for body in [
            serde_json::json!({}),
            serde_json::json!({ "code": 42 }),
            serde_json::json!("not-an-object"),
        ] {
            let body_label = body.to_string();
            let response = app
                .clone()
                .oneshot(plain_post(PAIR_PATH, body))
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::BAD_REQUEST,
                "body={body_label}"
            );
        }
    }

    /// 令牌仅此一次明文返回：重复使用同一码 → 401 + pair.used（一次性）
    #[tokio::test]
    async fn pair_endpoint_code_is_single_use() {
        let (state, coordinator) = test_pair_state();
        let code = activate_pairing(&coordinator);
        let app = build_router(state);
        let response = app
            .clone()
            .oneshot(plain_post(PAIR_PATH, serde_json::json!({ "code": code })))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let response = app
            .oneshot(plain_post(PAIR_PATH, serde_json::json!({ "code": code })))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let body = json_body(response).await;
        assert_eq!(body["code"], "pair.used");
    }

    // ── R1 收口：/v1/pair 每源 IP 限速（D2 §12.4「10 次/分钟」；
    //    AU4 问题 #1 缺口销号）──

    /// D2 §12.4 断言锚：同 IP 前 10 次请求（混合 200/401/409 业务面——
    /// 成功与失败统一计）全部到达业务逻辑；第 11 次 → 429 +
    /// cmd.too_many_requests（error.rs 既有 429 映射）+ 审计 1；拒绝不
    /// 计数（count_for 恒 10，防拒绝路径被刷爆窗口）
    #[tokio::test]
    async fn pair_endpoint_rate_limits_11th_request_per_ip() {
        let (state, coordinator) = test_pair_state();
        let code = activate_pairing(&coordinator);
        let app = build_router(state.clone());
        let ip: std::net::IpAddr = "192.168.1.50".parse().expect("固定测试 IP");
        for i in 0..10 {
            // 混合业务面：第 5 次正确码（200 成功），其余错误码（401；
            // 5 次失败锁定后可能 409）——限速口径「窗口内全部请求计数」
            let body = if i == 4 {
                serde_json::json!({ "code": code })
            } else {
                serde_json::json!({ "code": "CXN-AAAA-BBBB-CCCC" })
            };
            let response = app
                .clone()
                .oneshot(plain_post_from_ip(PAIR_PATH, body, ip))
                .await
                .unwrap();
            assert!(
                matches!(
                    response.status(),
                    StatusCode::OK | StatusCode::UNAUTHORIZED | StatusCode::CONFLICT
                ),
                "第 {} 次应在限速前到达业务面：{:?}",
                i + 1,
                response.status()
            );
        }
        assert_eq!(state.pair_limiter().count_for(ip), 10);
        // 第 11 次 → 429 + cmd.too_many_requests
        let response = app
            .oneshot(plain_post_from_ip(
                PAIR_PATH,
                serde_json::json!({ "code": "CXN-AAAA-BBBB-CCCC" }),
                ip,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        let body = json_body(response).await;
        assert_eq!(body["code"], "cmd.too_many_requests");
        assert_eq!(state.pair_limiter().audit_rejected(), 1, "超限必须审计 +1");
        assert_eq!(
            state.pair_limiter().count_for(ip),
            10,
            "拒绝不计数（防拒绝路径被刷爆窗口）"
        );
    }

    /// 每源 IP 独立：IP-A 打满拒绝不影响 IP-B（IP-B 请求必须到达业务面，
    /// 绝非 429）
    #[tokio::test]
    async fn pair_endpoint_rate_limit_per_ip_independent() {
        let (state, coordinator) = test_pair_state();
        let code = activate_pairing(&coordinator);
        let app = build_router(state.clone());
        let ip_a: std::net::IpAddr = "192.168.1.60".parse().expect("固定测试 IP");
        let ip_b: std::net::IpAddr = "192.168.1.61".parse().expect("固定测试 IP");
        for _ in 0..10 {
            let response = app
                .clone()
                .oneshot(plain_post_from_ip(
                    PAIR_PATH,
                    serde_json::json!({ "code": "CXN-AAAA-BBBB-CCCC" }),
                    ip_a,
                ))
                .await
                .unwrap();
            assert!(response.status().is_client_error());
        }
        assert_eq!(
            app.clone()
                .oneshot(plain_post_from_ip(
                    PAIR_PATH,
                    serde_json::json!({ "code": "x" }),
                    ip_a,
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::TOO_MANY_REQUESTS,
            "IP-A 第 11 次必须 429"
        );
        // IP-B 首次请求（正确码）：必须到达业务面（配对锁定语义下可能
        // 409——只要不是 429 即证明 IP-B 独立桶未受影响）
        let response = app
            .oneshot(plain_post_from_ip(
                PAIR_PATH,
                serde_json::json!({ "code": code }),
                ip_b,
            ))
            .await
            .unwrap();
        assert_ne!(
            response.status(),
            StatusCode::TOO_MANY_REQUESTS,
            "IP-B 独立桶不受 IP-A 限速影响"
        );
        assert_eq!(state.pair_limiter().count_for(ip_b), 1);
        assert_eq!(state.pair_limiter().audit_rejected(), 1);
    }

    /// 服务关闭（multi_device.enabled=false）→ 503 不消耗限速额度：
    /// 连发 12 次后审计与窗口计数均为 0（限速在服务开关检查之后）
    #[tokio::test]
    async fn pair_endpoint_rate_limit_service_disabled_not_counted() {
        let seq = TOKEN_FILE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let file = std::env::temp_dir().join(format!("pairing-pair-ratelimit-{seq}.json"));
        let mut config = ServerConfig::new(std::env::temp_dir());
        config.multi_device_enabled = false;
        config.pairing_file_path = file.clone();
        let handle = ServerHandle::new(config, "127.0.0.1:0".parse().expect("固定测试地址"));
        let tokens = Arc::new(std::sync::Mutex::new(TokenStore::new(file)));
        let coordinator = Arc::new(crate::server::pairing::PairingCoordinator::new(
            tokens,
            Arc::new(crate::server::ws::WsRegistry::new()),
        ));
        let state = ServerState::new(
            &handle,
            TokenStore::new(handle.config().pairing_file_path.clone()),
            None,
        )
        .with_pairing(Arc::clone(&coordinator));
        let app = build_router(state.clone());
        let ip: std::net::IpAddr = "192.168.1.70".parse().expect("固定测试 IP");
        for _ in 0..12 {
            let response = app
                .clone()
                .oneshot(plain_post_from_ip(
                    PAIR_PATH,
                    serde_json::json!({ "code": "CXN-7K4P-Q2MB-9XRT" }),
                    ip,
                ))
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::SERVICE_UNAVAILABLE,
                "关闭态恒 503"
            );
        }
        assert_eq!(
            state.pair_limiter().count_for(ip),
            0,
            "关闭态不得消耗限速额度"
        );
        assert_eq!(state.pair_limiter().audit_rejected(), 0);
    }

    /// 成功也计入窗口：配对成功（200）后窗口计数 +1——防「成功换码绕过
    /// 限速」的计数一致性断言
    #[tokio::test]
    async fn pair_endpoint_rate_limit_success_consumes_window() {
        let (state, coordinator) = test_pair_state();
        let code = activate_pairing(&coordinator);
        let app = build_router(state.clone());
        let ip: std::net::IpAddr = "192.168.1.80".parse().expect("固定测试 IP");
        let response = app
            .oneshot(plain_post_from_ip(
                PAIR_PATH,
                serde_json::json!({ "code": code }),
                ip,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            state.pair_limiter().count_for(ip),
            1,
            "成功请求必须计入窗口（成功与失败统一计）"
        );
    }

    // ── Preview Proxy 免鉴权端点测试 ──

    /// 预览代理缺少 url 参数或参数非法时返回 400 cmd.invalid
    #[tokio::test]
    async fn preview_proxy_without_url_param_returns_400_cmd_invalid() {
        let app = build_router(test_state());

        // 无查询参数
        let response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri(PREVIEW_PROXY_PATH)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = json_body(response).await;
        assert_eq!(body["code"], "cmd.invalid");

        // url 参数为空
        let response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri(format!("{PREVIEW_PROXY_PATH}?url="))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = json_body(response).await;
        assert_eq!(body["code"], "cmd.invalid");

        // url 协议不支持（如 ftp）
        let response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri(format!("{PREVIEW_PROXY_PATH}?url=ftp://example.com/test"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = json_body(response).await;
        assert_eq!(body["code"], "cmd.invalid");
    }

    /// 预览代理 OPTIONS 预检请求返回 204 及 CORS 头部
    #[tokio::test]
    async fn preview_proxy_options_returns_204_with_cors_headers() {
        let app = build_router(test_state());
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .method("OPTIONS")
                    .uri(PREVIEW_PROXY_PATH)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            response
                .headers()
                .get("access-control-allow-origin")
                .unwrap(),
            "*"
        );
        assert!(response
            .headers()
            .get("access-control-allow-methods")
            .unwrap()
            .to_str()
            .unwrap()
            .contains("GET"));
    }
}
