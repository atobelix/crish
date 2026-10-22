use std::sync::Arc;

use conex_types::message::{AgentMessage, AgentMessageMetadataKind, AgentMessageRole};
use serde_json::json;

use super::*;
use crate::steering::metadata_kind_wire;
use crate::steering::testutil::{
    assistant_with_tool_calls, tool_result, tool_result_json, user,
};
use crate::steering::{
    SteeringAction, SteeringContext, SteeringPhase, SteeringReason, SteeringStrategy,
    DEFAULT_INTERVENTION_MESSAGE,
};

mod eval_tests;
mod loop_tests;
mod promise_tests;

fn context<'a>(
    messages: &'a [Arc<AgentMessage>],
    steering_count: usize,
) -> SteeringContext<'a> {
    SteeringContext {
        messages,
        turn_index: 0,
        steering_count,
        tool_call_count: 0,
        has_pending_input: false,
    }
}

/// 测试便捷层：owned 消息 → Arc 共享视图（PE-09 T09.3.2 后策略消费
/// `&[Arc<AgentMessage>]`，测试构造统一经此转换）
fn arc_messages(messages: Vec<AgentMessage>) -> Vec<Arc<AgentMessage>> {
    messages.into_iter().map(Arc::new).collect()
}

fn inject_of(action: SteeringAction) -> (AgentMessage, SteeringReason) {
    match action {
        SteeringAction::InjectMessage { message, reason } => (message, reason),
        other => panic!("应为 inject-message，实际 {other:?}"),
    }
}

fn action_type(action: SteeringAction) -> Option<&'static str> {
    match action {
        SteeringAction::InjectMessage { .. } => Some("inject"),
        SteeringAction::EmitDiagnostic { .. } => Some("diagnostic"),
        SteeringAction::InterventionRequired { .. } => Some("intervention"),
    }
}
