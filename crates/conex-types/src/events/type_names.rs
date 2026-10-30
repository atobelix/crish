//! 事件类型名清单：由同一份变体名 → wire 名展开 `type_name` 与
//! `ALL_TYPE_NAMES`，保证两处永不漂移。

use super::AgentEvent;

macro_rules! engine_event_type_names {
    ($($variant:ident => $name:literal),+ $(,)?) => {
        impl AgentEvent {
            /// 事件类型名（顶层 `type` 值，kebab-case）
            pub fn type_name(&self) -> &'static str {
                match self {
                    $(AgentEvent::$variant { .. } => $name,)+
                }
            }

            /// 全部事件类型名（enum 声明顺序，与事件注册表编号一一对应）
            pub const ALL_TYPE_NAMES: &'static [&'static str] = &[$($name),+];
        }
    };
}

engine_event_type_names! {
    AgentStart => "agent-start",
    AgentEnd => "agent-end",
    TurnStart => "turn-start",
    TurnEnd => "turn-end",
    MessageStart => "message-start",
    MessageDelta => "message-delta",
    MessageEnd => "message-end",
    ToolStart => "tool-start",
    ToolEnd => "tool-end",
    ToolBatchStart => "tool-batch-start",
    ToolBatchEnd => "tool-batch-end",
    ContextCompressionStart => "context-compression-start",
    ContextCompressionEnd => "context-compression-end",
    ProviderDiagnostic => "provider-diagnostic",
    RuntimeError => "runtime-error",
    RuntimeSteering => "runtime-steering",
    RuntimeInterventionRequired => "runtime-intervention-required",
    ApprovalRequested => "approval-requested",
    ApprovalResolved => "approval-resolved",
    CheckpointCreated => "checkpoint-created",
    CheckpointRestored => "checkpoint-restored",
    RunTerminal => "run-terminal",
    CacheStatsUpdated => "cache-stats-updated",
    CacheWasteAlert => "cache-waste-alert",
    ColdCacheWarning => "cold-cache-warning",
    SecurityAudit => "security-audit",
    SubagentStarted => "subagent-started",
    SubagentEvent => "subagent-event",
    SubagentEnded => "subagent-ended",
    TaskStarted => "task-started",
    TaskOutput => "task-output",
    TaskHeartbeat => "task-heartbeat",
    TaskSuspicious => "task-suspicious",
    TaskCompleted => "task-completed",
    TaskFailed => "task-failed",
    TaskKilled => "task-killed",
    TimerFired => "timer-fired",
    TimerCancelled => "timer-cancelled",
    CronFired => "cron-fired",
    RecoveryEscalated => "recovery-escalated",
    RecoverySteering => "recovery-steering",
    RecoveryFork => "recovery-fork",
    RecoveryReport => "recovery-report",
    RecoveryBudgetDenied => "recovery-budget-denied",
    GoalRoundStarted => "goal-round-started",
    GoalRoundCompleted => "goal-round-completed",
    GoalContinuationDecided => "goal-continuation-decided",
    SteeringEvaluated => "steering-evaluated",
    ControlIntent => "control-intent",
    HookOutcome => "hook-outcome",
    SummaryBackground => "summary-background",
    StageSummaryMilestone => "stage-summary-milestone",
    NudgeEnqueued => "nudge-enqueued",
    RecoveryAcknowledged => "recovery-acknowledged",
    RecoveryRetryAttempted => "recovery-retry-attempted",
    ProviderRequestAnchored => "provider-request-anchored",
    TimelineTruncate => "timeline-truncate",
}
