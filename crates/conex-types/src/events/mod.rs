//! 域事件契约（Rust enum 为双端唯一事实源）
//!
//! [AgentEvent] 是 58 种域事件的 serde tagged enum（顶层 `type`），全部字段
//! camelCase。字段清单、类型映射与逐字段语义以 `contracts/engine-events.json`
//! 为准；前端 TS 由 `scripts/generate-engine-bindings.mjs` 生成，注册表与 enum
//! 的一致性由 `tests/registry_drift.rs` 锁定。
//!
//! 顶层 `runId` / `sequence` / `schemaVersion` 由 emit 层经 [AgentEventEnvelope]
//! 注入，不占事件体。message-start / message-end 正文经 [Arc] 承载（serde 对
//! `Arc<T>` 按 `T` 序列化，wire 不变），对话与事件共享同一份消息内存。

use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::impact::ImpactAssessment;
use crate::message::{AgentMessage, AgentMessageBlock};
use crate::session::AgentEndReason;
use crate::tool::{
    ContextCompressionRecord, ProviderDiagnostic, RuntimeCheckpointRecord,
    RuntimeCheckpointRestoreRecord, ToolBatchCall, ToolBatchResult,
};

mod envelope;
mod policy;
mod type_names;
mod types;

pub use envelope::{AgentEventEnvelope, EVENT_ENVELOPE_SCHEMA_VERSION};
pub use policy::{event_backpressure, event_policy, subagent_event_kind_backpressure};
pub use types::{
    ApprovalDecision, BackpressureLevel, DropClass, EventPolicy, MissAttribution,
    PermissionRequest, PersistenceDecision, RunCacheStats, RunTerminalStatus,
    SecurityAuditDecision, SecurityAuditOperation, SubagentEndStatus, SubagentEventKind,
    SubagentEventPayload, TimelineTruncateReason, ToolMetadata, TurnUsage,
};

/// 58 种域事件（tagged enum，双端契约唯一事实源）。
///
/// 变体顺序即注册表编号；每个变体的 wire 名与字段语义见注册表。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum AgentEvent {
    #[serde(rename = "agent-start", rename_all = "camelCase")]
    AgentStart {
        session_id: String,
        timestamp: String,
    },
    #[serde(rename = "agent-end", rename_all = "camelCase")]
    AgentEnd {
        session_id: String,
        timestamp: String,
        reason: AgentEndReason,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },

    #[serde(rename = "turn-start", rename_all = "camelCase")]
    TurnStart {
        session_id: String,
        turn_index: u32,
        timestamp: String,
    },
    #[serde(rename = "turn-end", rename_all = "camelCase")]
    TurnEnd {
        session_id: String,
        turn_index: u32,
        timestamp: String,
        tool_call_count: u32,
        /// 每 turn usage；旧帧缺省 None
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<TurnUsage>,
    },

    #[serde(rename = "message-start", rename_all = "camelCase")]
    MessageStart {
        session_id: String,
        message: Arc<AgentMessage>,
    },
    #[serde(rename = "message-delta", rename_all = "camelCase")]
    MessageDelta {
        session_id: String,
        timestamp: String,
        message_id: String,
        block: AgentMessageBlock,
    },
    #[serde(rename = "message-end", rename_all = "camelCase")]
    MessageEnd {
        session_id: String,
        message: Arc<AgentMessage>,
        /// 多轮 run 前端按 turnIndex 分段合并
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_index: Option<u32>,
    },

    #[serde(rename = "tool-start", rename_all = "camelCase")]
    ToolStart {
        session_id: String,
        batch_id: String,
        call: ToolBatchCall,
        timestamp: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_index: Option<u32>,
    },
    #[serde(rename = "tool-end", rename_all = "camelCase")]
    ToolEnd {
        session_id: String,
        batch_id: String,
        result: ToolBatchResult,
        timestamp: String,
        /// 审批重试 attempt 链
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attempt: Option<u32>,
        /// 批内去重标记
        #[serde(default, skip_serializing_if = "Option::is_none")]
        deduplicated: Option<bool>,
        /// 中间件改写后的实际执行入参
        #[serde(default, skip_serializing_if = "Option::is_none")]
        executed_input: Option<serde_json::Value>,
    },
    #[serde(rename = "tool-batch-start", rename_all = "camelCase")]
    ToolBatchStart {
        session_id: String,
        batch_id: String,
        timestamp: String,
        summary: String,
        calls: Vec<ToolBatchCall>,
    },
    #[serde(rename = "tool-batch-end", rename_all = "camelCase")]
    ToolBatchEnd {
        session_id: String,
        batch_id: String,
        timestamp: String,
        calls: Vec<ToolBatchResult>,
    },

    #[serde(rename = "context-compression-start", rename_all = "camelCase")]
    ContextCompressionStart {
        session_id: String,
        timestamp: String,
        reason: String,
        tokens_before: u64,
    },
    #[serde(rename = "context-compression-end", rename_all = "camelCase")]
    ContextCompressionEnd {
        session_id: String,
        timestamp: String,
        /// Box 化以压平枚举变体体积（wire 序列化不变）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<Box<ContextCompressionRecord>>,
        aborted: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },

    #[serde(rename = "provider-diagnostic", rename_all = "camelCase")]
    ProviderDiagnostic {
        session_id: String,
        timestamp: String,
        diagnostic: ProviderDiagnostic,
    },
    #[serde(rename = "runtime-error", rename_all = "camelCase")]
    RuntimeError {
        session_id: String,
        timestamp: String,
        error: String,
        /// 只表「可重试」，与收场 reason 正交
        #[serde(default, skip_serializing_if = "Option::is_none")]
        retryable: Option<bool>,
    },
    #[serde(rename = "runtime-steering", rename_all = "camelCase")]
    RuntimeSteering {
        session_id: String,
        timestamp: String,
        reason: String,
        message: AgentMessage,
    },
    #[serde(rename = "runtime-intervention-required", rename_all = "camelCase")]
    RuntimeInterventionRequired {
        session_id: String,
        timestamp: String,
        reason: String,
        choices: Vec<String>,
        message: String,
    },
    #[serde(rename = "approval-requested", rename_all = "camelCase")]
    ApprovalRequested {
        session_id: String,
        request: PermissionRequest,
        timestamp: String,
    },
    #[serde(rename = "approval-resolved", rename_all = "camelCase")]
    ApprovalResolved {
        session_id: String,
        tool_call_id: String,
        /// 保留兼容（03 §5.3-3）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        decision: ApprovalDecision,
        timestamp: String,
    },
    #[serde(rename = "checkpoint-created", rename_all = "camelCase")]
    CheckpointCreated {
        session_id: String,
        timestamp: String,
        checkpoint: RuntimeCheckpointRecord,
    },
    #[serde(rename = "checkpoint-restored", rename_all = "camelCase")]
    CheckpointRestored {
        session_id: String,
        timestamp: String,
        restore: RuntimeCheckpointRestoreRecord,
    },
    #[serde(rename = "run-terminal", rename_all = "camelCase")]
    RunTerminal {
        session_id: String,
        run_id: String,
        timestamp: String,
        terminal: RunTerminalStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },

    #[serde(rename = "cache-stats-updated", rename_all = "camelCase")]
    CacheStatsUpdated {
        session_id: String,
        timestamp: String,
        stats: RunCacheStats,
    },
    #[serde(rename = "cache-waste-alert", rename_all = "camelCase")]
    CacheWasteAlert {
        session_id: String,
        timestamp: String,
        attribution: MissAttribution,
        missed_tokens: u64,
        idle_ms: u64,
        model_changed: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        missed_cost_usd: Option<f64>,
    },
    #[serde(rename = "cold-cache-warning", rename_all = "camelCase")]
    ColdCacheWarning {
        session_id: String,
        timestamp: String,
        ttl_seconds: u64,
        idle_ms: u64,
        resend_estimate_tokens: u64,
    },

    #[serde(rename = "security-audit", rename_all = "camelCase")]
    SecurityAudit {
        session_id: String,
        timestamp: String,
        operation: SecurityAuditOperation,
        targets: Vec<String>,
        impact: ImpactAssessment,
        decision: SecurityAuditDecision,
        /// 统一三态 ask/smart/full；工具侧为 None
        #[serde(default, skip_serializing_if = "Option::is_none")]
        permission_mode: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_call_id: Option<String>,
    },

    #[serde(rename = "subagent-started", rename_all = "camelCase")]
    SubagentStarted {
        session_id: String,
        subagent_id: String,
        subagent_run_id: String,
        role: String,
        capability_mode: String,
        started_at: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mode: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_tool_call_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subagent_session_id: Option<String>,
    },
    #[serde(rename = "subagent-event", rename_all = "camelCase")]
    SubagentEvent {
        session_id: String,
        subagent_id: String,
        subagent_run_id: String,
        event: SubagentEventPayload,
    },
    #[serde(rename = "subagent-ended", rename_all = "camelCase")]
    SubagentEnded {
        session_id: String,
        subagent_id: String,
        subagent_run_id: String,
        status: SubagentEndStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
        ended_at: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subagent_session_id: Option<String>,
    },

    #[serde(rename = "task-started", rename_all = "camelCase")]
    TaskStarted {
        session_id: String,
        task_id: String,
        command: String,
        cwd: String,
        owner_run_id: String,
        is_daemon: bool,
    },
    #[serde(rename = "task-output", rename_all = "camelCase")]
    TaskOutput {
        session_id: String,
        task_id: String,
        /// line 或 chunk 二选一
        #[serde(default, skip_serializing_if = "Option::is_none")]
        line: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        chunk: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        line_count: Option<u64>,
    },
    #[serde(rename = "task-heartbeat", rename_all = "camelCase")]
    TaskHeartbeat {
        session_id: String,
        task_id: String,
        resource: serde_json::Value,
    },
    #[serde(rename = "task-suspicious", rename_all = "camelCase")]
    TaskSuspicious {
        session_id: String,
        task_id: String,
        silence_ms: u64,
        last_output_at_ms: u64,
    },
    #[serde(rename = "task-completed", rename_all = "camelCase")]
    TaskCompleted {
        session_id: String,
        task_id: String,
        exit_code: i32,
        duration_ms: u64,
        line_count: u64,
    },
    #[serde(rename = "task-failed", rename_all = "camelCase")]
    TaskFailed {
        session_id: String,
        task_id: String,
        exit_code: i32,
        /// 最后 20 行日志
        tail: Vec<String>,
        duration_ms: u64,
    },
    #[serde(rename = "task-killed", rename_all = "camelCase")]
    TaskKilled {
        session_id: String,
        task_id: String,
        via_force: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        diagnostics: Option<String>,
    },

    #[serde(rename = "timer-fired", rename_all = "camelCase")]
    TimerFired {
        session_id: String,
        timer_id: String,
        prompt: String,
        fired_at_ms: u64,
    },
    #[serde(rename = "timer-cancelled", rename_all = "camelCase")]
    TimerCancelled {
        session_id: String,
        timer_id: String,
        /// early-exit|cancelled
        reason: String,
        cancelled_at_ms: u64,
    },
    #[serde(rename = "cron-fired", rename_all = "camelCase")]
    CronFired {
        session_id: String,
        cron_id: String,
        prompt: String,
        expression: String,
        iteration: u64,
        fired_at_ms: u64,
    },

    #[serde(rename = "recovery-escalated", rename_all = "camelCase")]
    RecoveryEscalated {
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subagent_run_id: Option<String>,
        kind: String,
        retries: u32,
        elapsed_ms: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    #[serde(rename = "recovery-steering", rename_all = "camelCase")]
    RecoverySteering {
        session_id: String,
        subagent_id: String,
        subagent_run_id: String,
        fingerprint: String,
        retries: u32,
        remaining_status: String,
        pending: bool,
        created_at_ms: u64,
    },
    #[serde(rename = "recovery-fork", rename_all = "camelCase")]
    RecoveryFork {
        session_id: String,
        fingerprint: String,
        subagent_id: String,
        from_run_id: String,
        from_leaf_id: String,
        new_run_id: String,
        new_leaf_id: String,
        /// verbatim/summarized/new
        context_mode: String,
    },
    #[serde(rename = "recovery-report", rename_all = "camelCase")]
    RecoveryReport {
        session_id: String,
        subagent_id: String,
        subagent_run_id: String,
        stuck_at_ms: u64,
        suggestion: String,
    },
    #[serde(rename = "recovery-budget-denied", rename_all = "camelCase")]
    RecoveryBudgetDenied {
        session_id: String,
        /// 主 run 侧 None；子代理侧 Some
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subagent_run_id: Option<String>,
        fingerprint: String,
        count: u32,
        max: u32,
    },

    #[serde(rename = "goal-round-started", rename_all = "camelCase")]
    GoalRoundStarted {
        round: u32,
        max_rounds: u32,
        goal: String,
    },
    #[serde(rename = "goal-round-completed", rename_all = "camelCase")]
    GoalRoundCompleted {
        round: u32,
        tool_call_count: u32,
        tool_success_count: u32,
        message_count: u32,
        /// Continue/Completed/NoProgress/Blocked/NoGoal
        decision: String,
        reason_detail: String,
        stalled_delta: u32,
        evidence: String,
    },
    #[serde(rename = "goal-continuation-decided", rename_all = "camelCase")]
    GoalContinuationDecided {
        /// continue/complete/stop 等
        action: String,
        reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prompt: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        progress_signature: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },

    #[serde(rename = "steering-evaluated", rename_all = "camelCase")]
    SteeringEvaluated {
        session_id: String,
        timestamp: String,
        /// "empty-response" | "after-tools"
        phase: String,
        hit_strategies: Vec<String>,
        steering_count_before: u32,
        steering_count_after: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        budget_remaining: Option<u32>,
        reset: bool,
    },
    #[serde(rename = "control-intent", rename_all = "camelCase")]
    ControlIntent {
        session_id: String,
        timestamp: String,
        /// soft-inject | cooperative-stop | force-cancel
        kind: String,
        intent_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        /// enqueued | consumed
        state: String,
    },
    #[serde(rename = "hook-outcome", rename_all = "camelCase")]
    HookOutcome {
        session_id: String,
        timestamp: String,
        hook_type: String,
        /// ok | blocked | failed | timeout
        outcome: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hook_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        blocked_reason: Option<String>,
    },
    #[serde(rename = "summary-background", rename_all = "camelCase")]
    SummaryBackground {
        session_id: String,
        timestamp: String,
        /// spawned | attempt | success | failure | give-up
        phase: String,
        attempt: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message_id: Option<String>,
    },
    #[serde(rename = "stage-summary-milestone", rename_all = "camelCase")]
    StageSummaryMilestone {
        session_id: String,
        timestamp: String,
        /// reached | summarizing | produced | persisted
        milestone_type: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tier: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        milestone_index: Option<u32>,
    },
    #[serde(rename = "nudge-enqueued", rename_all = "camelCase")]
    NudgeEnqueued {
        session_id: String,
        timestamp: String,
        reason: String,
        /// followUp | pending
        target_ring: String,
        overwrote: bool,
    },
    #[serde(rename = "recovery-acknowledged", rename_all = "camelCase")]
    RecoveryAcknowledged {
        session_id: String,
        timestamp: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        notification_id: Option<String>,
        subagent_run_id: String,
    },
    #[serde(rename = "recovery-retry-attempted", rename_all = "camelCase")]
    RecoveryRetryAttempted {
        session_id: String,
        timestamp: String,
        attempt: u32,
        delay_ms: u64,
        budget_remaining: u32,
        from_run_id: String,
        new_run_id: String,
    },
    #[serde(rename = "provider-request-anchored", rename_all = "camelCase")]
    ProviderRequestAnchored {
        session_id: String,
        timestamp: String,
        turn_index: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        request_started_at_ms: u64,
    },

    #[serde(rename = "timeline-truncate", rename_all = "camelCase")]
    TimelineTruncate {
        session_id: String,
        /// 与信封 runId 同值，emit 层注入值覆盖
        run_id: String,
        /// 重放只到此前；事件流只追加不物理删
        boundary_seq: u64,
        reason: TimelineTruncateReason,
        /// 被撤回的 user 消息稳定 id
        target_message_id: String,
        timestamp: String,
    },
}
