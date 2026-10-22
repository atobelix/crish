//! 写面 handler（R1-04：F5 会话域 / F2 审批域 / F6 设置域；R2-12c：C21/C22/C30/C31）

use crate::server::backend::SettingsUpdateParams;
use crate::server::{ServerError, ServerState};
use axum::extract::{Path, RawQuery, State};
use axum::Json;
use conex_types::device::commands::{SettingsConfirmParams, SettingsConfirmResult};
use conex_types::device::{
    ApprovalHistoryParams, ApprovalHistoryResult, ApproveParams, ApproveResult, AssetKind,
    AssetUrlParams, AssetUrlResult, CancelRunParams, CancelRunResult, DenyParams,
    GetSettingsParams, GetSettingsResult, ListPendingApprovalsParams, ListPendingApprovalsResult,
    PauseAutomationParams, PauseAutomationResult, RunControlParams, RunControlResult,
    RunTaskParams, RunTaskResult, SearchFilesParams, SearchFilesResult,
};

use super::extract::{invalid_param, JsonBody, QueryParams};
use super::guard::{ensure_command_execution_allowed, require_backend};

/// POST /v1/runs：C24 发起 run（body = RunTaskParams；runId 桌面生成，
/// sessionId 缺省 = 新建会话）。命令执行面白名单守卫：runTask 必须登记
/// 于远程白名单（R1-11 G-5 / D5 §4.5 M-REG）
pub(super) async fn handle_run_task(
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
pub(super) async fn handle_run_control(
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
pub(super) async fn handle_run_cancel(
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
pub(super) async fn handle_approve(
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
pub(super) async fn handle_deny(
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
pub(super) async fn handle_approvals_pending(
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
pub(super) async fn handle_approvals_history(
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
pub(super) async fn handle_settings_get(
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
pub(super) async fn handle_settings_set(
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
pub(super) async fn handle_search_files(
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
pub(super) async fn handle_asset_url(
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
pub(super) async fn handle_settings_confirm(
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
pub(super) async fn handle_pause_automation(
    State(state): State<ServerState>,
    JsonBody(params): JsonBody<PauseAutomationParams>,
) -> Result<Json<PauseAutomationResult>, ServerError> {
    let backend = require_backend(&state)?;
    Ok(Json(backend.pause_automation(params).await?))
}
