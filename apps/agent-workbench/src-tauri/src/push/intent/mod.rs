//! 推送意图判定（R3-01：事件 → 推送意图分类）
//!
//! `push_intent(event, ctx)` 是 D7 §3.1 判定顺序的纯函数实现：
//!
//! 1. 用户必须行动（审批/过期/安全拦截/需人工介入）→ 必达；
//! 2. 结果类终态（run/子代理/任务/定时器/cron）→ 按价值与频率分级；
//! 3. 过程类增量与诊断观测类 → 一律不推（返回 `None`）。
//!
//! 事件体缺字段兜底：`runtime-error` / `runtime-intervention-required` /
//! `cache-waste-alert` / `security-audit` 事件体不含 runId（由信封注入），
//! 去重键需要 runId 时经 [PushIntentCtx::envelope_run_id] 注入；缺失则回退
//! `session:{sessionId}`（单 run 场景仍具去重语义，多 run 并发时去重粒度
//! 变粗——装配层应保证信封 runId 注入，见模块文档「事件信封」注记）。

use conex_types::events::{AgentEvent, RunTerminalStatus};
use conex_types::session::AgentEndReason;

use super::scenes::SceneId;
use super::{PushLevel, PushTargetScreen};

mod approval;
mod run;
mod subagent_task;
mod system;

/// 推送意图上下文（事件体缺失字段的注入面）
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PushIntentCtx {
    /// 信封注入的 run_id（`AgentEventEnvelope.run_id`；事件体无 runId
    /// 字段时兜底——去重键需要，见 [AgentEventEnvelope] 文档）
    pub envelope_run_id: Option<String>,
    /// 事件序号（信封 sequence；S11 安全审计去重键的回退业务键）
    pub sequence: Option<u64>,
}

/// 审批推送引用（S1/S2 持久化去重 + 重推阶梯的输入契约）
///
/// 审批不能漏（D7 §3.4.1）：S1/S2 去重键必须落 SQLite
/// `push_events_dedupe` 表（审批键持久化，重启不丢）；本任务交付
/// [crate::push::dedupe::DedupeBackend] 接口与内存实现，SQLite 后端
/// 由 R3-02/03 接线。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalPushRef {
    /// 审批工具调用 id（`PermissionRequest.tool_call_id`）
    pub tool_call_id: String,
    /// 审批所在会话
    pub session_id: String,
    /// 去重键（与 [PushIntent::dedupe_key] 同值，供持久化后端直接落键）
    pub dedupe_key: String,
}

/// 推送载荷摘要（push/copy.rs 文案渲染的输入契约——title/body 渲染不在本任务）
///
/// - `digest`：正文主体文本（prompt/error/command/reason/概述等，长度
///   截断与模板渲染由 copy 层负责）；
/// - `detail`：次级文本（S1 工具名、S8d 退出码等，可空）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PayloadDigest {
    /// 场景所属会话
    pub session_id: String,
    /// 主业务键（toolCallId/runId/taskId/timerId/cronId/subagentId 等）
    pub biz_key: String,
    /// 正文主体文本（可空 = 由 copy 层按场景渲染）
    pub digest: Option<String>,
    /// 次级文本（可空）
    pub detail: Option<String>,
}

/// 推送意图（`push_intent` 判定产物；去重/合并/静默/节流各环节的输入）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushIntent {
    /// 命中场景（登记表行）
    pub scene: SceneId,
    /// 推送级别（scene 级别；P3 不推由 `None` 表达）
    pub level: PushLevel,
    /// 去重键（D7 §3.4.1：{eventType}:{业务键}）
    pub dedupe_key: String,
    /// 折叠键（厂商通道同链折叠 / iOS threadId 分组）
    pub collapse_key: String,
    /// 跳转目标屏幕
    pub target: PushTargetScreen,
    /// 载荷摘要（copy 层输入）
    pub payload: PayloadDigest,
    /// S1/S2 审批键（持久化去重注记；非审批为 `None`）
    pub approval: Option<ApprovalPushRef>,
}

/// 去重键构造（D7 §3.4.1：`{eventType}:{业务键}`）
pub fn dedupe_key(event_type: &str, biz_key: &str) -> String {
    format!("{event_type}:{biz_key}")
}

/// run 终止来源（R3-01a 补强：S8e 精确来源判定的判定输入）
///
/// D7 §3.3 S8e：task-killed 与 kill 来源联动——**用户主动 kill 不推**，
/// 系统/watchdog 强制 kill 才推。来源由装配层从事件流注入：
/// - 精确路径：[run_termination_source]（`agent-end.reason` 的
///   [AgentEndReason]——用户 cancel 命令 → `Aborted`/`Stopped`）；
/// - 等价路径：[run_terminal_source]（`run-terminal.terminal` 的
///   [RunTerminalStatus]——事件流无 agent-end 时的等价判定）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunTerminationSource {
    /// 用户主动终止（cancel 命令 / 用户协作停止）
    UserKilled,
    /// 引擎/系统终止（正常收场 / 错误收场 / 预算用尽）
    EngineTerminated,
}

/// [AgentEndReason] → run 终止来源（精确判定：agent-end 事件 reason 字段）
pub fn run_termination_source(reason: AgentEndReason) -> RunTerminationSource {
    match reason {
        // 用户中止（ABORT 事件 / L3 force_cancel）与用户协作停止 → 用户主动
        AgentEndReason::Aborted | AgentEndReason::Stopped => RunTerminationSource::UserKilled,
        // 正常收场 / 预算用尽（非错误非中止）/ 错误收场 → 引擎终止
        AgentEndReason::Stop | AgentEndReason::MaxTurns | AgentEndReason::Error => {
            RunTerminationSource::EngineTerminated
        }
    }
}

/// [RunTerminalStatus] → run 终止来源（等价判定：事件流无 agent-end reason
/// 时的回退；Cancelled 无法区分用户取消/引擎中止，保守按用户主动归入
/// [RunTerminationSource::UserKilled]——S8e 语境下「run 取消 → 任务被连坐
/// 终止」多为用户行为，宁可少推不可扰民）
pub fn run_terminal_source(terminal: RunTerminalStatus) -> RunTerminationSource {
    match terminal {
        RunTerminalStatus::Cancelled => RunTerminationSource::UserKilled,
        RunTerminalStatus::Completed | RunTerminalStatus::Failed => {
            RunTerminationSource::EngineTerminated
        }
    }
}

/// S8e 判定矩阵：task-killed 是否应推送。
///
/// | 来源（注入） | via_force | 判定 | 语义 |
/// | --- | --- | --- | --- |
/// | UserKilled | 任意 | 不推 | 用户主动 kill（Windows 两阶段升级后 via_force=true 仍属用户行为） |
/// | EngineTerminated | 任意 | 推 | 系统/watchdog 强制 kill |
/// | None（来源未知） | false | 不推 | 回退 R3-01a 近似：优雅 kill 视为用户主动 |
/// | None（来源未知） | true | 推 | 回退 R3-01a 近似：强制 kill 视为系统行为 |
pub fn task_killed_should_push(source: Option<RunTerminationSource>, via_force: bool) -> bool {
    match source {
        Some(RunTerminationSource::UserKilled) => false,
        Some(RunTerminationSource::EngineTerminated) => true,
        // 来源未知：回退 via_force 近似（R3-01a 口径）
        None => via_force,
    }
}

/// 事件 → 推送意图（D7 §3.2 全量筛选表 + M8 §3.2.3 级别真源）
///
/// 返回 `None` 即 P3 不推。match 覆盖全部 49 变体（穷尽是编译期护栏：
/// 新事件变体必须在此表态）。
///
/// kill 来源注入：S8e 需要精确来源时调用
/// [push_intent_with_kill_source]（引擎事件流观察 / 装配层注入）；
/// 本函数等价于注入 `None`（来源未知回退 via_force 近似）。
pub fn push_intent(event: &AgentEvent, ctx: &PushIntentCtx) -> Option<PushIntent> {
    push_intent_with_kill_source(event, ctx, None)
}

/// 带 kill 来源注入的推送意图判定（R3-01a 补强：S8e 精确来源）
///
/// 与 [push_intent] 的唯一差异是 S8e（task-killed）场景按来源精确判定；
/// 其余场景行为完全一致。`kill_source = None` 时行为 = [push_intent]。
pub fn push_intent_with_kill_source(
    event: &AgentEvent,
    ctx: &PushIntentCtx,
    kill_source: Option<RunTerminationSource>,
) -> Option<PushIntent> {
    match event {
        // S1/S2 审批族（approval.rs）
        AgentEvent::ApprovalRequested { .. } | AgentEvent::ApprovalResolved { .. } => {
            approval::approval_intent(event)
        }
        // S3/S4/S5 run 终态（run.rs）
        AgentEvent::RunTerminal { .. } => run::run_terminal_intent(event),
        // S6–S8e 子代理终态 / 后台任务（subagent_task.rs；S8e 消费 kill 来源）
        AgentEvent::SubagentEnded { .. }
        | AgentEvent::TaskStarted { .. }
        | AgentEvent::TaskCompleted { .. }
        | AgentEvent::TaskSuspicious { .. }
        | AgentEvent::TaskFailed { .. }
        | AgentEvent::TaskKilled { .. } => subagent_task::subagent_task_intent(event, kill_source),
        // S9a/S9b/S10a/S10b/S11/S12（system.rs；runId / sequence 经 ctx 注入）
        AgentEvent::TimerFired { .. }
        | AgentEvent::CronFired { .. }
        | AgentEvent::RuntimeError { .. }
        | AgentEvent::RuntimeInterventionRequired { .. }
        | AgentEvent::SecurityAudit { .. }
        | AgentEvent::CacheWasteAlert { .. } => system::system_intent(event, ctx),

        // ── P3 不推（过程态/增量/诊断/恢复域/goal 域）──
        AgentEvent::AgentStart { .. }
        | AgentEvent::AgentEnd { .. }
        | AgentEvent::TurnStart { .. }
        | AgentEvent::TurnEnd { .. }
        | AgentEvent::MessageStart { .. }
        | AgentEvent::MessageDelta { .. }
        | AgentEvent::MessageEnd { .. }
        | AgentEvent::ToolStart { .. }
        | AgentEvent::ToolEnd { .. }
        | AgentEvent::ToolBatchStart { .. }
        | AgentEvent::ToolBatchEnd { .. }
        | AgentEvent::ContextCompressionStart { .. }
        | AgentEvent::ContextCompressionEnd { .. }
        | AgentEvent::ProviderDiagnostic { .. }
        | AgentEvent::RuntimeSteering { .. }
        | AgentEvent::CheckpointCreated { .. }
        | AgentEvent::CheckpointRestored { .. }
        | AgentEvent::CacheStatsUpdated { .. }
        | AgentEvent::ColdCacheWarning { .. }
        | AgentEvent::SubagentStarted { .. }
        | AgentEvent::SubagentEvent { .. }
        | AgentEvent::TaskOutput { .. }
        | AgentEvent::TaskHeartbeat { .. }
        | AgentEvent::TimerCancelled { .. }
        | AgentEvent::RecoveryEscalated { .. }
        | AgentEvent::RecoverySteering { .. }
        | AgentEvent::RecoveryFork { .. }
        | AgentEvent::RecoveryReport { .. }
        | AgentEvent::RecoveryBudgetDenied { .. }
        | AgentEvent::GoalRoundStarted { .. }
        | AgentEvent::GoalRoundCompleted { .. }
        | AgentEvent::GoalContinuationDecided { .. }
        // D-03 观测补全九事件（全 Delta 可丢级观测，桌面观测面，
        // 不产生推送意图——tool-input-repaired 已核销删除）
        | AgentEvent::SteeringEvaluated { .. }
        | AgentEvent::ControlIntent { .. }
        | AgentEvent::HookOutcome { .. }
        | AgentEvent::SummaryBackground { .. }
        | AgentEvent::StageSummaryMilestone { .. }
        | AgentEvent::NudgeEnqueued { .. }
        | AgentEvent::RecoveryAcknowledged { .. }
        | AgentEvent::RecoveryRetryAttempted { .. }
        | AgentEvent::ProviderRequestAnchored { .. }
        // R1 撤回域（会话内截断事件，不产生推送意图——撤回由前端投影重放呈现）
        | AgentEvent::TimelineTruncate { .. } => None,
    }
}

/// runId 兜底键：信封注入的 runId 优先，缺失回退 `session:{sessionId}`
fn run_or_session_key(run_id: Option<&str>, session_id: &str) -> String {
    match run_id {
        Some(run) => run.to_string(),
        None => format!("session:{session_id}"),
    }
}

#[cfg(test)]
mod tests;
