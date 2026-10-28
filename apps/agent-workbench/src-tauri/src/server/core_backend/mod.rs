//! CoreStateBackend：ApiBackend 的真实实现（R1-04：REST T1 写面直调
//! 既有 `*_impl` 契约体，不建第二套运行语义——D2 §11-B / AU2 审计点 3）
//!
//! - **写面**（run_task / run_control / cancel_run / approve / deny /
//!   list_pending_approvals / approval_history / settings_get /
//!   settings_set）：直调 core_run_commands 的直调体（不依赖 Tauri
//!   runtime），CoreError → [ServerError] 经单一真源映射
//!   （`DeviceErrorCode::from_core_error`，M6 §6.2.3）；
//! - **只读面**（R1-03 登记的 C01-C10）：同范式接入——能直调契约体的
//!   直调，数据源不可得的字段诚实降级（search_index_ready /
//!   compaction_ready 由装配方经 builder 注入，缺省 false）；
//! - 构造：`CoreStateBackend::new(Arc::clone(&core_state))`（main.rs
//!   装配面注入 [ServerState]，见 server/mod.rs router 装配）。

mod api;
pub(crate) mod state;
#[cfg(test)]
mod tests;

pub use state::CoreStateBackend;

use conex_types::device::PermissionMode;
use conex_types::events::{
    AgentEvent, AgentEventEnvelope, SecurityAuditDecision, SecurityAuditOperation,
};
use conex_types::impact::ImpactAssessment;

use conex_run::core_event_bridge::EventBridge;

// ── R1-10 安全测试面：远程装配与双轨路由纯函数（T-07 / T-08 / T-14）──
//
// 远程来源判定机制（R1-10 确认）：REST/WS 服务面即远程面——桌面本地操作
// 走 Tauri IPC，入站网络请求一律视为远程来源（D2 §8 / D5 §4.3「远程网关
// 不暴露 Tauri IPC」）；deviceId 身份注入（source=deviceId）留 §8.2
// 装配层扩展，本面先落地远程/本地的行为边界。

/// 远程权限模式上限装配（R1-10 T-08 / D5 §4.6.1）：min(requested, Ask)——远程不存在
/// full；ask 原样；None 原样。返回（生效模式, 是否降级）——降级时调用方必须发
/// remote-mode-downgrade 审计标记（D5 §8.2 / §9.2 矩阵：approve/operate × full → ask 降级）。
pub(crate) fn apply_remote_mode(
    requested: Option<PermissionMode>,
) -> (Option<PermissionMode>, bool) {
    match requested {
        Some(PermissionMode::Full) => (Some(PermissionMode::Ask), true),
        other => (other, false),
    }
}

/// remote-* 审计事件构造（R1-11 D-5 收口：D5 §6.2 载荷形状——operation +
/// targets + decision + permission_mode；信封 runId/sequence 不注入，
/// 对齐 emit_trash_audit 先例（core_run_commands.rs）——run 创建前 /
/// 无会话上下文的远程动作，前端对缺失 runId 的信封放行不过滤）
fn remote_audit_event(
    session_id: &str,
    operation: SecurityAuditOperation,
    targets: Vec<String>,
    decision: SecurityAuditDecision,
    permission_mode: Option<String>,
) -> AgentEvent {
    AgentEvent::SecurityAudit {
        session_id: session_id.to_string(),
        timestamp: conex_run::engine_provider::now_iso_utc(),
        operation,
        targets,
        impact: ImpactAssessment::default(),
        decision,
        permission_mode,
        tool_call_id: None,
    }
}

/// 发射 remote-* 审计（双写：结构化审计日志 + SecurityAudit 事件——红线
/// 7「全部远程动作 remote-* 审计打码」的端到端事件面；bridge 为 None
/// （事件总线未接线）时降级为纯结构化日志，与 R1-10 行为一致）
fn emit_remote_audit(
    bridge: Option<&EventBridge>,
    session_id: &str,
    operation: SecurityAuditOperation,
    targets: Vec<String>,
    decision: SecurityAuditDecision,
    permission_mode: Option<String>,
) {
    tracing::info!(
        target: "security.audit",
        kind = "remote-action",
        operation = ?operation,
        decision = ?decision,
        targets = ?targets,
        session_id,
        "远程动作审计（结构化日志 + SecurityAudit 事件双写）"
    );
    let Some(bridge) = bridge else {
        return;
    };
    let envelope = AgentEventEnvelope::new(
        remote_audit_event(session_id, operation, targets, decision, permission_mode),
        None,
        None,
    );
    bridge.emit_envelope(&envelope);
}

/// remote-mode-downgrade 审计标记（远程 Full → Ask 降级；D5 §6.2 / TH-12）
pub(crate) fn emit_remote_mode_downgrade_audit(
    bridge: Option<&EventBridge>,
    run_id: &str,
    session_id: &str,
) {
    emit_remote_audit(
        bridge,
        session_id,
        SecurityAuditOperation::RemoteModeDowngrade,
        vec![run_id.to_string(), "full".to_string()],
        SecurityAuditDecision::Blocked,
        Some("full".to_string()),
    );
}

/// 远程审批双轨路由（R1-10 T-14 / D5 §4.4 纯函数）：
/// - 桌面端本地用户在场 → 双轨确认（[RemoteApprovalRoute::Dual]）：移动端
///   确认 + 桌面端弹窗确认，任一方拒绝即拒绝（防手机离身/被他人持有时
///   桌面端无人察觉地批准）；
/// - 桌面不在场（无人值守）→ 移动端单一确认（[RemoteApprovalRoute::RemoteOnly]），
///   审计标记 remote-only（事后追责可区分单方批准与双轨批准）。
///
/// 「桌面在场」判定由引擎侧装配注入，缺省 false = 保守模式（D5 §4.4）。
#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RemoteApprovalRoute {
    /// 双轨确认：移动端 + 桌面端弹窗（任一方拒绝即拒绝）
    Dual,
    /// 移动端单一确认（无人值守；审计标记 remote-only）
    RemoteOnly,
}

/// remote-only 审计标记（D5 §4.4：区分「手机端单方批准」与「双轨批准」）
#[cfg(test)]
pub(crate) const REMOTE_ONLY_AUDIT_MARKER: &str = "remote-only";

/// 双轨裁决路由纯函数（R1-10 T-14：desktop_user_present 由装配面注入，
/// 缺省 false = 无人值守按 remote-only 处理）
#[cfg(test)]
pub(crate) fn route_remote_approval(desktop_user_present: bool) -> RemoteApprovalRoute {
    if desktop_user_present {
        RemoteApprovalRoute::Dual
    } else {
        RemoteApprovalRoute::RemoteOnly
    }
}

/// 双轨裁决合成（R1-10 T-14：任一方拒绝即拒绝——仅双方均批准才放行）
#[cfg(test)]
pub(crate) fn combine_dual_decisions(mobile_approved: bool, desktop_approved: bool) -> bool {
    mobile_approved && desktop_approved
}

/// 发射 remote-only 审计（D5 §4.4：桌面不在场时移动端单方批准——审计
/// 标记使事后追责可区分单方批准与双轨批准；双写：结构化日志 +
/// SecurityAudit(remote-only)，decision 取 approved 语义：单方批准已
/// 放行。装配点 = R2 远程网关双轨裁决落地面（当前无生产调用，测试直
/// 接覆盖事件形状））
#[cfg(test)]
pub(crate) fn emit_remote_only_audit(bridge: Option<&EventBridge>, session_id: &str) {
    emit_remote_audit(
        bridge,
        session_id,
        SecurityAuditOperation::RemoteOnly,
        vec![],
        SecurityAuditDecision::Approved,
        None,
    );
    tracing::info!(
        target: "security.audit",
        kind = "remote-approval",
        operation = %REMOTE_ONLY_AUDIT_MARKER,
        session_id,
        "远程单一确认（无人值守 remote-only 审计标记）"
    );
}
