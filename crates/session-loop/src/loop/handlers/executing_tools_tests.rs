//! executing_tools 模块测试（G-02 批 1 顺带拆：测试外置至
//! executing_tools_tests.rs，行为零变更；模块内
//! `#[cfg(test)] #[path = "executing_tools_tests.rs"] mod tests;` 接线，
//! 仿 shell.rs/subagent.rs 测试旁挂先例）
//!
//! > 统一输入流收敛战役 R1（tool-update 事件契约删除）：ToolProgress →
//! > 该事件映射测试随变体删除（前端零消费，终值仍由 tool-end 承载）。

use super::*;
use crate::r#loop::SessionLoopOptions;
use crate::steering::{RecoverySteeringStrategy, SteeringCoordinator, SteeringCoordinatorOptions};
use agent_tools::registry::ToolRegistry;

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
            reason: None,
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
            output: serde_json::Value::Null.into(),
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
            assert_eq!(decision, &conex_types::events::ApprovalDecision::Expired);
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
        output: serde_json::json!({"ok": true}).into(),
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
        output: serde_json::json!({"ok": true}).into(),
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

/// G8 正常路径（U-G8 / DEL-10）：超限工具输出在写 conversation 前被
/// head+标记+tail 截断；留痕写入消息 metadata.g8ToolOutputTruncation。
#[test]
fn g8_normal_path_truncates_oversize_tool_text() {
    // 超默认字节阈值（50KiB）：单行长文本必截断
    let oversized =
        "x".repeat(conex_compaction::tool_output::TOOL_OUTPUT_MAX_BYTES_DEFAULT + 1_024);
    let ok = ClassifiedToolResult {
        id: "call_g8".into(),
        tool_name: "shell_command".into(),
        error_kind: None,
        error_message: None,
        output: serde_json::json!(oversized).into(),
        duration_ms: 1,
        attempt: 1,
        deduplicated: false,
        executed_input: None,
        occurred_at_ms: None,
    };
    let message = tool_result_message(&ok);
    let AgentMessageBlock::ToolResult { output, .. } = &message.blocks[0] else {
        panic!("tool 角色消息应含 ToolResult 块");
    };
    let text = output.text.as_deref().expect("截断后仍应有 text");
    assert!(
        text.len() < oversized.len(),
        "G8 正常路径必须截断超限文本（原 {} → 现 {}）",
        oversized.len(),
        text.len()
    );
    assert!(
        text.contains("截断") || text.contains("..."),
        "截断文本必须携带可见标记（留痕不静默丢弃）"
    );
    // 留痕：metadata 记录截断计数
    let meta = message
        .metadata
        .as_ref()
        .expect("发生截断时 metadata 必须携带 g8 留痕");
    let record = meta
        .get("g8ToolOutputTruncation")
        .expect("metadata.g8ToolOutputTruncation 必须存在");
    assert_eq!(
        record.get("truncated").and_then(|v| v.as_bool()),
        Some(true)
    );
    assert!(
        record
            .get("originalBytes")
            .and_then(|v| v.as_u64())
            .unwrap_or(0)
            > 0,
        "留痕必须含 originalBytes"
    );
}

/// G8 正常路径：限内短输出不截断、不写留痕（零行为变化回归锚）。
#[test]
fn g8_normal_path_leaves_short_tool_text_untouched() {
    let ok = ClassifiedToolResult {
        id: "call_short".into(),
        tool_name: "echo".into(),
        error_kind: None,
        error_message: None,
        output: serde_json::json!("ok").into(),
        duration_ms: 1,
        attempt: 1,
        deduplicated: false,
        executed_input: None,
        occurred_at_ms: None,
    };
    let message = tool_result_message(&ok);
    let AgentMessageBlock::ToolResult { output, .. } = &message.blocks[0] else {
        panic!("tool 角色消息应含 ToolResult 块");
    };
    assert_eq!(output.text.as_deref(), Some("ok"), "限内文本不得被改写");
    assert!(
        message.metadata.is_none(),
        "未截断不得写 g8 留痕 metadata（避免污染零截断路径）"
    );
}
