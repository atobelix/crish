//! 工具成对性闭环（session-integrity-repair 02：Tier-1 就地合成 + Tier-2
//! converge 差集守门共用纯逻辑）
//!
//! 契约（02 §首契约补丁）：
//! 1. **合成幂等键 = `tool_call_id`**：同一 call_id 最多一条有效 ToolEnd
//!    事件与一条有效 ToolResult 消息；已终态时只允许补 conversation 缺失
//!    消息，禁止重复发 ToolStart/ToolEnd；
//! 2. Tool 结果在 conversation 内可为 `AgentMessageRole::Tool`（供导线组包）；
//!    本层不写库——持久化并入 assistant 载荷归壳层（02 §3.3）；
//! 3. 合成事件保持 ToolStart + ToolEnd 成对包络。

use std::sync::Arc;

use conex_types::error::codes;
use conex_types::events::AgentEvent;
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole, ToolCallBlock};
use conex_types::tool::{ToolCategory, ToolConcurrency};

use super::super::end::EndDecision;
use super::{record_message, LoopState};

/// 事件轨是否已存在该 call_id 的 ToolStart
fn events_have_tool_start(state: &LoopState, call_id: &str) -> bool {
    state.events.iter().any(|e| {
        matches!(
            e,
            AgentEvent::ToolStart { call, .. } if call.id == call_id
        )
    })
}

/// 事件轨是否已存在该 call_id 的 ToolEnd（幂等闸：终态判定）
pub(crate) fn events_have_tool_end(state: &LoopState, call_id: &str) -> bool {
    state.events.iter().any(|e| {
        matches!(
            e,
            AgentEvent::ToolEnd { result, .. } if result.id == call_id
        )
    })
}

/// conversation 是否已含该 call_id 的 ToolResult 块（任意消息、任意块位）
fn conversation_has_tool_result(state: &LoopState, call_id: &str) -> bool {
    conversation_has_tool_result_in(&state.conversation, call_id)
}

/// 对话切片版：是否含该 call_id 的 ToolResult（hydrate 复用）
pub(crate) fn conversation_has_tool_result_in(
    conversation: &[Arc<AgentMessage>],
    call_id: &str,
) -> bool {
    conversation.iter().any(|msg| {
        msg.blocks.iter().any(|b| {
            matches!(
                b,
                AgentMessageBlock::ToolResult { tool_call_id, .. } if tool_call_id == call_id
            )
        })
    })
}

/// 为单条孤儿 ToolCall 补齐事件包络 + ToolResult 消息（幂等闸生效）
///
/// - 已有 ToolEnd：不重发事件；仅在 conversation 缺 ToolResult 时补消息；
/// - 无 ToolEnd：补发缺失的 ToolStart 与 ToolEnd，再补消息（若缺）。
fn close_orphan_call(
    state: &mut LoopState,
    call: &ToolCallBlock,
    error_code: &str,
    reason: &str,
    metadata_extra: serde_json::Value,
) {
    let has_end = events_have_tool_end(state, &call.id);
    let has_result = conversation_has_tool_result(state, &call.id);
    if has_end && has_result {
        return;
    }
    let now_ms = conex_shared::time::unix_millis() as u64;
    if !has_end {
        if !events_have_tool_start(state, &call.id) {
            state.emit_event(AgentEvent::ToolStart {
                session_id: state.machine.context().session_id.clone(),
                batch_id: String::new(),
                call: conex_types::tool::ToolBatchCall {
                    id: call.id.clone(),
                    tool_name: call.tool_name.clone(),
                    summary: format!("call {}", call.tool_name),
                    input: call.input.clone(),
                    category: ToolCategory::Internal,
                    concurrency: ToolConcurrency::Parallel,
                },
                timestamp: crate::steering::iso_from_epoch_ms(now_ms),
                turn_index: Some(state.machine.context().turn_index),
            });
        }
        state.emit_event(AgentEvent::ToolEnd {
            session_id: state.machine.context().session_id.clone(),
            batch_id: String::new(),
            result: conex_types::tool::ToolBatchResult {
                id: call.id.clone(),
                tool_name: call.tool_name.clone(),
                output: conex_types::tool::ToolOutput {
                    text: Some(reason.to_string()),
                    json: Some(serde_json::json!({ "code": error_code })),
                    artifacts: None,
                },
                is_error: true,
                duration_ms: 0,
            },
            timestamp: crate::steering::iso_from_epoch_ms(now_ms),
            attempt: None,
            deduplicated: None,
            executed_input: None,
        });
    }
    if !has_result {
        record_message(
            state,
            synthesized_tool_result_message(call, error_code, reason, metadata_extra),
        );
    }
}

/// 构造合成 ToolResult 消息（role=Tool；metadata 标记 synthesized）
fn synthesized_tool_result_message(
    call: &ToolCallBlock,
    error_code: &str,
    reason: &str,
    metadata_extra: serde_json::Value,
) -> AgentMessage {
    let mut metadata = serde_json::json!({
        "synthesized": true,
        "errorCode": error_code,
    });
    if let (Some(obj), Some(extra)) = (metadata.as_object_mut(), metadata_extra.as_object()) {
        for (k, v) in extra {
            obj.insert(k.clone(), v.clone());
        }
    }
    AgentMessage {
        id: format!("tool-result-{}", call.id),
        role: AgentMessageRole::Tool,
        created_at: conex_shared::time::now_iso_utc(),
        blocks: vec![AgentMessageBlock::ToolResult {
            tool_call_id: call.id.clone(),
            tool_name: call.tool_name.clone(),
            output: conex_types::tool::ToolOutput::text(format!("interrupted: {reason}")),
            is_error: true,
        }],
        metadata: Some(metadata),
        client_message_id: None,
        content: None,
    }
}

/// Tier-1：对指定 assistant 消息上的全部 ToolCall 就地合成（中断现场闭环）
pub(crate) fn synthesize_and_record_interrupted_calls(
    state: &mut LoopState,
    assistant: &AgentMessage,
    error_code: &'static str,
    reason: &str,
) {
    // 先收集 call 块（借用拆分：后续 &mut state 需要释放对 assistant 的引用）
    let calls: Vec<ToolCallBlock> = assistant.tool_calls().cloned().collect();
    if calls.is_empty() {
        return;
    }
    tracing::warn!(
        session_id = %state.machine.context().session_id,
        call_count = calls.len(),
        error_code,
        "Tier-1 就地合成：中断现场为未派发工具调用补齐 ToolResult"
    );
    for call in &calls {
        close_orphan_call(
            state,
            call,
            error_code,
            reason,
            serde_json::json!({ "tier": 1 }),
        );
    }
}

/// Tier-2：converge 前全局差集对账——Orphans = AssistantCalls \ AnsweredCalls
///
/// 幂等闸与 Tier-1 共用（已有 ToolEnd 的 call_id 不重复发事件）。
pub(crate) fn reconcile_orphan_tool_calls(state: &mut LoopState, decision: &EndDecision) {
    use std::collections::HashSet;

    let mut answered: HashSet<String> = HashSet::new();
    for msg in &state.conversation {
        for block in &msg.blocks {
            if let AgentMessageBlock::ToolResult { tool_call_id, .. } = block {
                answered.insert(tool_call_id.clone());
            }
        }
    }

    let mut orphan_calls: Vec<ToolCallBlock> = Vec::new();
    for msg in &state.conversation {
        if msg.role != AgentMessageRole::Assistant {
            continue;
        }
        for call in msg.tool_calls() {
            if !answered.contains(&call.id) {
                orphan_calls.push(call.clone());
                answered.insert(call.id.clone());
            }
        }
    }

    if orphan_calls.is_empty() {
        return;
    }

    tracing::warn!(
        session_id = %state.machine.context().session_id,
        orphan_count = orphan_calls.len(),
        end_reason = ?decision.reason,
        "Tier-2 converge 守门员触发：检测到孤儿工具调用，执行强制集合差集闭合"
    );

    for call in &orphan_calls {
        close_orphan_call(
            state,
            call,
            codes::TOOL_ABORTED_BEFORE_DISPATCH,
            &format!("auto-reconciled at turn completion: {:?}", decision.reason),
            serde_json::json!({ "reconciledAtConverge": true }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::r#loop::SessionLoopOptions;
    use crate::steering::{
        RecoverySteeringStrategy, SteeringCoordinator, SteeringCoordinatorOptions,
    };
    use agent_tools::registry::ToolRegistry;

    fn test_state() -> LoopState {
        let steering = SteeringCoordinator::new(
            vec![Box::new(RecoverySteeringStrategy::default())],
            SteeringCoordinatorOptions::default(),
        );
        LoopState::new(
            "s1",
            16,
            steering,
            SessionLoopOptions::default(),
            Arc::new(ToolRegistry::new()),
        )
    }

    fn assistant_with_call(id: &str) -> AgentMessage {
        AgentMessage {
            id: "a1".into(),
            role: AgentMessageRole::Assistant,
            created_at: conex_shared::time::now_iso_utc(),
            blocks: vec![
                AgentMessageBlock::Text {
                    text: "调用工具".into(),
                },
                AgentMessageBlock::ToolCall(ToolCallBlock {
                    id: id.into(),
                    tool_name: "shell_command".into(),
                    input: serde_json::json!({ "command": "ls" }),
                }),
            ],
            metadata: None,
            client_message_id: None,
            content: None,
        }
    }

    fn tool_results(state: &LoopState) -> Vec<String> {
        state
            .conversation
            .iter()
            .flat_map(|m| m.blocks.iter())
            .filter_map(|b| match b {
                AgentMessageBlock::ToolResult { tool_call_id, .. } => Some(tool_call_id.clone()),
                _ => None,
            })
            .collect()
    }

    fn tool_end_count(state: &LoopState, call_id: &str) -> usize {
        state
            .events
            .iter()
            .filter(|e| matches!(e, AgentEvent::ToolEnd { result, .. } if result.id == call_id))
            .count()
    }

    /// Tier-1：中断就地合成产生 ToolResult + 成对 ToolStart/ToolEnd
    #[test]
    fn synthesize_emits_result_and_paired_events() {
        let mut state = test_state();
        let assistant = assistant_with_call("c1");
        state.conversation.push(Arc::new(assistant.clone()));
        synthesize_and_record_interrupted_calls(
            &mut state,
            &assistant,
            codes::TOOL_ABORTED_BEFORE_DISPATCH,
            "aborted before dispatch",
        );
        assert_eq!(tool_results(&state), ["c1"]);
        assert_eq!(tool_end_count(&state, "c1"), 1);
        assert!(events_have_tool_start(&state, "c1"));
    }

    /// 幂等闸：已有 ToolEnd + ToolResult → 重复调用零副作用
    #[test]
    fn synthesize_is_idempotent_when_already_terminal() {
        let mut state = test_state();
        let assistant = assistant_with_call("c1");
        state.conversation.push(Arc::new(assistant.clone()));
        synthesize_and_record_interrupted_calls(
            &mut state,
            &assistant,
            codes::TOOL_ABORTED_BEFORE_DISPATCH,
            "first",
        );
        let events_len = state.events.len();
        let conv_len = state.conversation.len();
        synthesize_and_record_interrupted_calls(
            &mut state,
            &assistant,
            codes::TOOL_ABORTED_BEFORE_DISPATCH,
            "second",
        );
        assert_eq!(state.events.len(), events_len, "不得重复发事件");
        assert_eq!(state.conversation.len(), conv_len, "不得重复补消息");
        assert_eq!(tool_end_count(&state, "c1"), 1);
        assert_eq!(tool_results(&state), ["c1"]);
    }

    /// 幂等闸补消息：已有 ToolEnd 但 conversation 缺 ToolResult → 只补消息不发事件
    #[test]
    fn synthesize_fills_missing_result_without_reemitting_events() {
        let mut state = test_state();
        let assistant = assistant_with_call("c1");
        state.conversation.push(Arc::new(assistant.clone()));
        // 仅放 ToolEnd（无 ToolStart、无 ToolResult）
        state.emit_event(AgentEvent::ToolEnd {
            session_id: "s1".into(),
            batch_id: String::new(),
            result: conex_types::tool::ToolBatchResult {
                id: "c1".into(),
                tool_name: "shell_command".into(),
                output: conex_types::tool::ToolOutput::empty(),
                is_error: true,
                duration_ms: 0,
            },
            timestamp: conex_shared::time::now_iso_utc(),
            attempt: None,
            deduplicated: None,
            executed_input: None,
        });
        let events_len = state.events.len();
        synthesize_and_record_interrupted_calls(
            &mut state,
            &assistant,
            codes::TOOL_ABORTED_BEFORE_DISPATCH,
            "fill only",
        );
        // record_message 会追加 message-start/end（合法）；不得再发 ToolStart/ToolEnd
        assert!(
            state.events.len() >= events_len,
            "事件只增不减（消息包络合法追加）"
        );
        assert_eq!(tool_end_count(&state, "c1"), 1, "已有 ToolEnd 不得再发");
        assert!(
            !events_have_tool_start(&state, "c1"),
            "已有终态不补 ToolStart"
        );
        assert_eq!(tool_results(&state), ["c1"], "缺 ToolResult 时必须补消息");
    }

    /// Tier-2：converge 差集闭合孤儿
    #[test]
    fn reconcile_closes_orphan_calls() {
        let mut state = test_state();
        state
            .conversation
            .push(Arc::new(assistant_with_call("orphan-1")));
        // 正常 user 收尾形状不强制（reconcile 不做头尾断言）
        state.conversation.push(Arc::new(AgentMessage {
            id: "u2".into(),
            role: AgentMessageRole::User,
            created_at: conex_shared::time::now_iso_utc(),
            blocks: vec![AgentMessageBlock::Text {
                text: "继续".into(),
            }],
            metadata: None,
            client_message_id: None,
            content: None,
        }));
        let decision = EndDecision::aborted(&state);
        reconcile_orphan_tool_calls(&mut state, &decision);
        assert_eq!(tool_results(&state), ["orphan-1"]);
        assert_eq!(tool_end_count(&state, "orphan-1"), 1);
        assert!(events_have_tool_start(&state, "orphan-1"));
    }

    /// Tier-2：已配对的调用不得被再次合成
    #[test]
    fn reconcile_skips_paired_calls() {
        let mut state = test_state();
        let mut assistant = assistant_with_call("paired-1");
        assistant.blocks.push(AgentMessageBlock::ToolResult {
            tool_call_id: "paired-1".into(),
            tool_name: "shell_command".into(),
            output: conex_types::tool::ToolOutput::text("ok"),
            is_error: false,
        });
        state.conversation.push(Arc::new(assistant));
        let decision = EndDecision::aborted(&state);
        reconcile_orphan_tool_calls(&mut state, &decision);
        assert!(
            !state
                .conversation
                .iter()
                .any(|m| m.role == AgentMessageRole::Tool),
            "已配对不得合成 Tool 消息"
        );
        assert!(
            !state
                .events
                .iter()
                .any(|e| matches!(e, AgentEvent::ToolEnd { .. })),
            "已配对不得发 ToolEnd"
        );
    }

    /// Tier-2：已终态（有 ToolEnd）但缺消息 → 只补消息
    #[test]
    fn reconcile_respects_terminal_event_gate() {
        let mut state = test_state();
        state
            .conversation
            .push(Arc::new(assistant_with_call("half-1")));
        state.emit_event(AgentEvent::ToolEnd {
            session_id: "s1".into(),
            batch_id: String::new(),
            result: conex_types::tool::ToolBatchResult {
                id: "half-1".into(),
                tool_name: "shell_command".into(),
                output: conex_types::tool::ToolOutput::empty(),
                is_error: true,
                duration_ms: 0,
            },
            timestamp: conex_shared::time::now_iso_utc(),
            attempt: None,
            deduplicated: None,
            executed_input: None,
        });
        let decision = EndDecision::error(&state, "boom");
        reconcile_orphan_tool_calls(&mut state, &decision);
        assert_eq!(tool_results(&state), ["half-1"]);
        assert_eq!(tool_end_count(&state, "half-1"), 1, "不得重复 ToolEnd");
    }
}
