use super::*;

mod advance_status;
mod rounds;
mod serde_and_parsing;

/// 构造进行中的默认 goal 状态（current=0，max=12，stalled 阈值 2）
fn active_state() -> GoalState {
    GoalState::with_defaults("修复构建", Some(12), Some(2))
}

fn stamp(name: &str, keys: &[&str]) -> ToolCallStamp {
    ToolCallStamp {
        tool_name: name.to_string(),
        param_keys: keys.iter().map(|k| k.to_string()).collect(),
    }
}

fn round(end_reason: AgentEndReason, text: &str, calls: &[ToolCallStamp]) -> RoundInput {
    RoundInput {
        end_reason,
        assistant_text: text.to_string(),
        tool_calls: calls.to_vec(),
        tool_success_count: 0,
        runtime_error: None,
        current: active_state(),
    }
}
