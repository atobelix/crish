//! 守卫与兜底：命令执行白名单守卫、密钥命令面拒绝、兜底 404、错误响应、后端取用、maxEvents 归一化

use crate::server::backend::ApiBackend;
use crate::server::{ServerError, ServerState};
use axum::extract::State;
use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Json;
use conex_types::device::version::PAGE_SIZE_MAX;
use conex_types::device::{DeviceErrorCode, ErrorBody};
use std::sync::Arc;

use super::SECRET_COMMAND_SURFACE;

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
pub(super) fn ensure_command_execution_allowed(
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

/// 识别被禁命令面触达（R1-10 T-07 纯函数；URI 路径含清单命令名 → 命中，
/// 返回命中的命令名供审计携带）
pub(super) fn secret_command_hit(uri: &Uri) -> Option<&'static str> {
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
pub(super) async fn handle_not_found(State(state): State<ServerState>, uri: Uri) -> Response {
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
pub(super) fn require_backend(state: &ServerState) -> Result<Arc<dyn ApiBackend>, ServerError> {
    state.backend().ok_or_else(|| {
        ServerError::internal("服务命令后端未接线（CoreStateBackend 由 R1-04 注入）")
    })
}

/// 归一化 maxEvents：缺省 200，夹紧 [1, 1000]（对齐
/// core_query_commands::normalize_max_events 语义）
pub(super) fn normalize_max_events(max_events: u32) -> u32 {
    max_events.clamp(1, PAGE_SIZE_MAX)
}
