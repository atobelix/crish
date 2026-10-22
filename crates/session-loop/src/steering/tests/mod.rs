//! steering coordinator 测试：共享替身策略与构造器；用例按职责分在子模块。

use super::*;
use conex_types::message::AgentMessage;

/// 测试替身策略：对指定阶段固定返回一个动作
struct FixedStrategy {
    phases: &'static [SteeringPhase],
    action: SteeringAction,
}

impl SteeringStrategy for FixedStrategy {
    fn name(&self) -> &'static str {
        "fixed"
    }
    fn phases(&self) -> &'static [SteeringPhase] {
        self.phases
    }
    fn evaluate(
        &self,
        phase: SteeringPhase,
        _context: &SteeringContext<'_>,
    ) -> Option<SteeringAction> {
        if self.phases.contains(&phase) {
            Some(self.action.clone())
        } else {
            None
        }
    }
}

fn fake_steering_message() -> AgentMessage {
    AgentMessage {
        id: "fake-inject".into(),
        role: conex_types::message::AgentMessageRole::System,
        created_at: "2026-01-01T00:00:00Z".into(),
        blocks: vec![conex_types::message::AgentMessageBlock::Text {
            text: "fake steering".into(),
        }],
        metadata: None,
        client_message_id: None,
        content: None,
    }
}

fn empty_context() -> SteeringContext<'static> {
    SteeringContext {
        messages: &[],
        turn_index: 0,
        steering_count: 0,
        tool_call_count: 0,
        has_pending_input: false,
    }
}

mod budget;
mod intervention;
mod trace_and_time;
