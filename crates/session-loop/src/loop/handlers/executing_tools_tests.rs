//! executing_tools 模块测试（G-02 批 1 顺带拆：测试外置至
//! executing_tools_tests.rs，行为零变更；模块内
//! `#[cfg(test)] #[path = "executing_tools_tests.rs"] mod tests;` 接线，
//! 仿 shell.rs/subagent.rs 测试旁挂先例）

use super::*;
use agent_tools::registry::ToolRegistry;
use conex_types::tool::ToolProgressUpdate;
use crate::r#loop::SessionLoopOptions;
use crate::steering::{
    RecoverySteeringStrategy, SteeringCoordinator, SteeringCoordinatorOptions,
};

/// 构造最小 LoopState（emit_tool_events 单测驱动）
fn state() -> LoopState {
    let steering = SteeringCoordinator::new(
        vec![Box::new(RecoverySteeringStrategy::default())],
        SteeringCoordinatorOptions::default(),
    );
    LoopState::new(
        "sess-1",
        16,
        steering,
        SessionLoopOptions::default(),
        Arc::new(ToolRegistry::new()),
    )
}

/// Text 形态出站映射（TOOLS-01 §3.1.5）：text 承载 + metadata.kind =
/// tool-progress；batch_id/tool_call_id 透传；时序
/// tool-start → tool-update → tool-end 保持；ToolUpdate 不进消息历史
#[test]
fn tool_progress_text_maps_to_tool_update() {
    let mut s = state();
    let events = vec![
        ToolEvent::BatchStart {
            batch_id: "batch-1".into(),
            count: 1,
        },
        ToolEvent::ToolStart {
            call_id: "c1".into(),
            tool_name: "shell_command".into(),
            input: serde_json::json!({}),
            category: ToolCategory::Internal,
            concurrency: ToolConcurrency::Sequential,
            summary: "call shell_command".into(),
            occurred_at_ms: Some(1_000),
        },
        ToolEvent::ToolProgress {
            call_id: "c1".into(),
            update: ToolProgressUpdate {
                text: Some("第一块".into()),
                json: None,
                metadata: Some(serde_json::json!({ "kind": "tool-progress" })),
            },
        },
        ToolEvent::ToolEnd {
            call_id: "c1".into(),
            tool_name: "shell_command".into(),
            is_error: false,
            duration_ms: 10,
            output: serde_json::json!({ "out": "x" }),
            error_code: None,
            error_message: None,
            attempt: Some(1),
            deduplicated: Some(false),
            executed_input: None,
            occurred_at_ms: Some(1_020),
        },
        ToolEvent::BatchEnd {
            batch_id: "batch-1".into(),
        },
    ];
    emit_tool_events(&mut s, &events);
    // 事件流时序：tool-batch-start → tool-start → tool-update →
    // tool-end → tool-batch-end
    let types: Vec<&str> = s.events.iter().map(|e| e.type_name()).collect();
    assert_eq!(
        types,
        vec![
            "tool-batch-start",
            "tool-start",
            "tool-update",
            "tool-end",
            "tool-batch-end"
        ],
        "tool-update 必须位于 tool-start 与 tool-end 之间"
    );
    match &s.events[2] {
        AgentEvent::ToolUpdate {
            batch_id,
            tool_call_id,
            update,
            ..
        } => {
            assert_eq!(batch_id, "batch-1", "batch_id 从批上下文透传");
            assert_eq!(tool_call_id, "c1", "tool_call_id 从执行上下文透传");
            assert_eq!(update.text.as_deref(), Some("第一块"));
            assert!(update.json.is_none());
            assert_eq!(
                update.metadata.as_ref().unwrap()["kind"],
                "tool-progress",
                "Text 形态 metadata.kind 固定为 tool-progress"
            );
        }
        _ => panic!("ToolProgress 应映射为 AgentEvent::ToolUpdate"),
    }
    // ToolUpdate 是展示面事件：不进消息历史（终值仍由 ToolEnd 承载）
    assert!(
        s.conversation.is_empty(),
        "emit_tool_events 不得写消息历史（ToolUpdate 不进对话缓存前缀）"
    );
}

/// Custom 形态出站映射：json 承载 + metadata.kind = subkind（与前端
/// tool-args-delta 预留消费面同槽位）
#[test]
fn tool_progress_custom_maps_to_tool_update() {
    let mut s = state();
    let events = vec![
        ToolEvent::BatchStart {
            batch_id: "batch-1".into(),
            count: 1,
        },
        ToolEvent::ToolProgress {
            call_id: "c2".into(),
            update: ToolProgressUpdate {
                text: None,
                json: Some(serde_json::json!({ "step": 1 })),
                metadata: Some(serde_json::json!({ "kind": "tool-args-delta" })),
            },
        },
    ];
    emit_tool_events(&mut s, &events);
    match &s.events[1] {
        AgentEvent::ToolUpdate {
            tool_call_id,
            update,
            ..
        } => {
            assert_eq!(tool_call_id, "c2");
            assert!(update.text.is_none());
            assert_eq!(update.json.as_ref().unwrap()["step"], 1);
            assert_eq!(
                update.metadata.as_ref().unwrap()["kind"],
                "tool-args-delta",
                "Custom 形态 metadata.kind = subkind"
            );
        }
        _ => panic!("ToolProgress 应映射为 AgentEvent::ToolUpdate"),
    }
}

/// G-9：审批超时权威语义落库——引擎记录 ApprovalResolved(Expired)
/// 翻译为 AgentEvent::approval-resolved（复用既有变体与
/// decision=expired 规范值，协议不变；载荷与壳层 approve/deny 路径
/// 对齐：request_id 缺省 None）
#[test]
fn approval_resolved_expired_maps_to_agent_event() {
    let mut s = state();
    let events = vec![
        ToolEvent::BatchStart {
            batch_id: "batch-1".into(),
            count: 1,
        },
        ToolEvent::ApprovalRequested {
            call_id: "c1".into(),
            tool_name: "shell_command".into(),
            args: serde_json::json!({ "command": "git push" }),
            requester: None,
        },
        ToolEvent::ApprovalResolved {
            call_id: "c1".into(),
            decision: ApprovalDecision::Expired,
        },
        ToolEvent::ToolEnd {
            call_id: "c1".into(),
            tool_name: "shell_command".into(),
            is_error: true,
            duration_ms: 0,
            output: serde_json::Value::Null,
            error_code: Some("tool.approval_expired".into()),
            error_message: Some("approval expired".into()),
            attempt: Some(1),
            deduplicated: Some(false),
            executed_input: None,
            occurred_at_ms: None,
        },
        ToolEvent::BatchEnd {
            batch_id: "batch-1".into(),
        },
    ];
    emit_tool_events(&mut s, &events);
    match &s.events[2] {
        AgentEvent::ApprovalResolved {
            session_id,
            tool_call_id,
            request_id,
            decision,
            timestamp,
        } => {
            assert_eq!(session_id, "sess-1");
            assert_eq!(tool_call_id, "c1");
            assert_eq!(request_id, &None);
            assert_eq!(
                decision,
                &conex_types::events::ApprovalDecision::Expired
            );
            assert!(!timestamp.is_empty());
        }
        other => panic!("应映射为 AgentEvent::ApprovalResolved，实际 {other:?}"),
    }
}

/// F1 盲区 8 / F3-10：tool-result 消息 id 派生契约——不同 tool-call id
/// 产出不同消息 id；**同一 tool-call id 复用（模型跨轮重发同 id 调用）
/// 时消息 id 相同（已知冲突，F3-10 观察项）**——本测试钉住现状形态，
/// 未来去重修复（按出现序消歧）时以此为回归锚点。
#[test]
fn tool_result_message_id_derivation_documented() {
    let ok = ClassifiedToolResult {
        id: "call_x".into(),
        tool_name: "echo".into(),
        error_kind: None,
        error_message: None,
        output: serde_json::json!({"ok": true}),
        duration_ms: 1,
        attempt: 1,
        deduplicated: false,
        executed_input: None,
        occurred_at_ms: None,
    };
    let message = tool_result_message(&ok);
    assert_eq!(message.id, "tool-result-call_x");
    assert_eq!(message.role, AgentMessageRole::Tool);
    // tool_call_id 回指原调用 id（回放侧配对语义）
    let AgentMessageBlock::ToolResult { tool_call_id, .. } = &message.blocks[0] else {
        panic!("tool 角色消息应含 ToolResult 块");
    };
    assert_eq!(tool_call_id, "call_x");

    // 不同调用 id → 消息 id 互异
    let other = ClassifiedToolResult {
        id: "call_y".into(),
        tool_name: "echo".into(),
        error_kind: None,
        error_message: None,
        output: serde_json::json!({"ok": true}),
        duration_ms: 1,
        attempt: 1,
        deduplicated: false,
        executed_input: None,
        occurred_at_ms: None,
    };
    assert_ne!(
        tool_result_message(&ok).id,
        tool_result_message(&other).id,
        "不同 tool-call id 不得共享消息 id"
    );
    // 同 id 复用（模型重发）→ 消息 id 相同（F3-10 已知形态：跨轮
    // 复用同 id 时消息 id 冲突，事件侧无重复检查）
    assert_eq!(
        tool_result_message(&ok).id,
        tool_result_message(&ClassifiedToolResult {
            id: "call_x".into(),
            ..ok
        })
        .id,
        "同 tool-call id 派生相同消息 id（F3-10 现状契约：冲突形态已知）"
    );
}
