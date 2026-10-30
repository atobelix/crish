//! 事件背压 / 持久化 / 桥丢帧三决策的单一分类事实源。
//!
//! 与 `contracts/engine-events.json` 的 backpressure / persist / bridgePriority
//! 三字段一一对应，`tests/registry_drift.rs` 双向锁定。

use super::types::{
    BackpressureLevel, DropClass, EventPolicy, PersistenceDecision, SubagentEventKind,
};
use super::AgentEvent;

/// 单一事件策略：同一 match 产出三正交决策。
pub fn event_policy(event: &AgentEvent) -> EventPolicy {
    match event {
        AgentEvent::MessageDelta { .. } => EventPolicy::new(
            BackpressureLevel::Delta,
            PersistenceDecision::NoPersist,
            DropClass::Soft,
        ),
        AgentEvent::SubagentEvent { event, .. } => match event.kind {
            SubagentEventKind::Progress => EventPolicy::new(
                BackpressureLevel::Delta,
                PersistenceDecision::NoPersist,
                DropClass::Critical,
            ),
            SubagentEventKind::Message | SubagentEventKind::Tool => EventPolicy::new(
                BackpressureLevel::Soft,
                PersistenceDecision::Persist,
                DropClass::Critical,
            ),
        },
        AgentEvent::TaskOutput { .. } | AgentEvent::TaskHeartbeat { .. } => EventPolicy::new(
            BackpressureLevel::Delta,
            PersistenceDecision::NoPersist,
            DropClass::Critical,
        ),
        AgentEvent::TaskSuspicious { .. } => EventPolicy::new(
            BackpressureLevel::Soft,
            PersistenceDecision::NoPersist,
            DropClass::Critical,
        ),
        AgentEvent::TaskStarted { .. }
        | AgentEvent::TaskCompleted { .. }
        | AgentEvent::TaskFailed { .. }
        | AgentEvent::TaskKilled { .. } => EventPolicy::new(
            BackpressureLevel::Critical,
            PersistenceDecision::Persist,
            DropClass::Critical,
        ),
        AgentEvent::TimerFired { .. } | AgentEvent::CronFired { .. } => EventPolicy::new(
            BackpressureLevel::Critical,
            PersistenceDecision::NoPersist,
            DropClass::Critical,
        ),
        AgentEvent::TimerCancelled { .. } => EventPolicy::new(
            BackpressureLevel::Soft,
            PersistenceDecision::NoPersist,
            DropClass::Critical,
        ),
        AgentEvent::RecoveryEscalated { .. }
        | AgentEvent::RecoverySteering { .. }
        | AgentEvent::RecoveryFork { .. }
        | AgentEvent::RecoveryReport { .. }
        | AgentEvent::RecoveryBudgetDenied { .. }
        | AgentEvent::GoalRoundStarted { .. }
        | AgentEvent::GoalRoundCompleted { .. }
        | AgentEvent::GoalContinuationDecided { .. } => EventPolicy::new(
            BackpressureLevel::Critical,
            PersistenceDecision::Persist,
            DropClass::Critical,
        ),
        AgentEvent::SteeringEvaluated { .. }
        | AgentEvent::ControlIntent { .. }
        | AgentEvent::HookOutcome { .. }
        | AgentEvent::SummaryBackground { .. }
        | AgentEvent::StageSummaryMilestone { .. }
        | AgentEvent::NudgeEnqueued { .. }
        | AgentEvent::RecoveryAcknowledged { .. }
        | AgentEvent::RecoveryRetryAttempted { .. }
        | AgentEvent::ProviderRequestAnchored { .. } => EventPolicy::new(
            BackpressureLevel::Delta,
            PersistenceDecision::NoPersist,
            DropClass::Critical,
        ),
        AgentEvent::TimelineTruncate { .. } => EventPolicy::new(
            BackpressureLevel::Critical,
            PersistenceDecision::Persist,
            DropClass::Critical,
        ),
        _ => EventPolicy::new(
            BackpressureLevel::Critical,
            PersistenceDecision::Persist,
            DropClass::Critical,
        ),
    }
}

/// 事件 → 背压级别（[event_policy] 的薄投影）。
pub fn event_backpressure(event: &AgentEvent) -> BackpressureLevel {
    event_policy(event).backpressure
}

/// 子代理事件类别 → 背压级别（kind 级分类）。
pub fn subagent_event_kind_backpressure(kind: SubagentEventKind) -> BackpressureLevel {
    match kind {
        SubagentEventKind::Progress => BackpressureLevel::Delta,
        SubagentEventKind::Message | SubagentEventKind::Tool => BackpressureLevel::Soft,
    }
}
