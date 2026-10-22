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

mod extract;
mod guard;
mod handlers_read;
mod handlers_write;

use crate::server::{now_ms, ServerState};
use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;
use axum::routing::{get, post};
use axum::{middleware, Router};
use serde::Serialize;

use guard::handle_not_found;
use handlers_read::{
    handle_flow_snapshot, handle_hello, handle_info, handle_list_commands, handle_list_sessions,
    handle_list_tasks, handle_run_events, handle_run_snapshot, handle_search_index,
    handle_session_events, handle_status, handle_task_output,
};
use handlers_write::{
    handle_approvals_history, handle_approvals_pending, handle_approve, handle_asset_url,
    handle_deny, handle_pause_automation, handle_run_cancel, handle_run_control, handle_run_task,
    handle_search_files, handle_settings_confirm, handle_settings_get, handle_settings_set,
};

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
/// 应用预览透明代理入口（GET /v1/preview/proxy；配对 Bearer 鉴权）
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
        // 透明预览可向任意 http(s) 地址发起出站请求（包含用户明确允许的
        // localhost / 私网目标），因此 GET 响应必须位于配对 Bearer 鉴权组。
        // OPTIONS 预检单独留在公开组；其处理器只返回空 204，不会执行代理。
        .route(
            PREVIEW_PROXY_PATH,
            get(crate::server::preview_proxy::handle_preview_proxy),
        )
        .layer(middleware::from_fn_with_state(
            state.clone(),
            crate::server::auth::require_signed_request,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            crate::server::auth::require_bearer_token,
        ));
    let preview_preflight = Router::new().route(
        PREVIEW_PROXY_PATH,
        axum::routing::options(crate::server::preview_proxy::handle_preview_proxy_options),
    );
    Router::new()
        .merge(info)
        .merge(preview_preflight)
        .merge(ws_router)
        .merge(protected)
        .fallback(handle_not_found)
        .layer(middleware::from_fn(inject_server_time_header))
        .with_state(state)
}

#[cfg(test)]
mod tests;
