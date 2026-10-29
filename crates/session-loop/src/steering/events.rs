//! steering-evaluated 观测事件构造（EV-03 / EV-09，D-03）。

use conex_shared::time::now_iso_utc;
use conex_types::events::AgentEvent;

use super::types::SteeringEvaluationTrace;

/// 构造 steering-evaluated 事件（EV-03 / D-03，Delta 可丢观测事件）
///
/// 发射点两类：
/// - **evaluate 命中/跳过**：策略评估处（reset=false，hit_strategies 为
///   命中策略列表，计数前后取自 [SteeringCoordinator::evaluate_traced]）；
/// - **计数重置**：reset=true，hit_strategies 恒空，计数 = before/0。
///
/// 聚合语义（禁止项）：每次评估只发一条（不逐策略逐条发射）。
pub(crate) fn steering_evaluated_event(
    session_id: &str,
    phase: &str,
    trace: &SteeringEvaluationTrace,
    budget_remaining: Option<u32>,
    reset: bool,
) -> AgentEvent {
    AgentEvent::SteeringEvaluated {
        session_id: session_id.to_string(),
        timestamp: now_iso_utc(),
        phase: phase.to_string(),
        hit_strategies: trace.hit_strategies.clone(),
        steering_count_before: trace.steering_count_before,
        steering_count_after: trace.steering_count_after,
        budget_remaining,
        reset,
    }
}
