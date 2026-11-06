//! streaming handler 测试（R2 整改：自源文件机械迁出，内容未改）

use super::*;
use crate::r#loop::SessionLoopOptions;
use crate::steering::{RecoverySteeringStrategy, SteeringCoordinator, SteeringCoordinatorOptions};
use agent_tools::registry::ToolRegistry;
use conex_types::message::ToolCallBlock;
use conex_types::session::AgentSessionState as S;

fn test_state() -> LoopState {
    let steering = SteeringCoordinator::new(
        vec![Box::new(RecoverySteeringStrategy::default())],
        SteeringCoordinatorOptions::default(),
    );
    let mut state = LoopState::new(
        "s1",
        16,
        steering,
        SessionLoopOptions::default(),
        Arc::new(ToolRegistry::new()),
    );
    let _ = state
        .machine
        .dispatch(conex_types::session::AgentSessionEvent::Initialized);
    let _ = state
        .machine
        .dispatch(conex_types::session::AgentSessionEvent::InputReady);
    let _ = state
        .machine
        .dispatch(conex_types::session::AgentSessionEvent::TurnPrepared);
    state
}

/// BC02-2：流以 Error 终止且存在未决 tool_calls 时，严禁派发真实工具执行！
/// 必须合成 TOOL_STREAM_ERROR_BEFORE_DISPATCH 拦截记录，并以 fatal_provider_error 收场。
#[tokio::test]
async fn test_error_stop_with_tool_calls_triggers_isolation_firewall() {
    let mut state = test_state();
    let tool_call = ToolCallBlock {
        id: "call_hazard_1".into(),
        tool_name: "dangerous_rm".into(),
        input: serde_json::json!({ "path": "/etc" }),
    };
    let consumed = crate::stream::consume(
        vec![
            ProviderStreamEvent::text("准备执行危险操作"),
            ProviderStreamEvent::tool_call(
                Some("call_hazard_1".into()),
                "dangerous_rm",
                serde_json::json!({ "path": "/etc" }),
            ),
            ProviderStreamEvent::Stop {
                reason: StopReason::Error,
                error: Some("网络连接突然重置".into()),
                error_kind: Some(conex_types::error::ProviderErrorKind::Network),
                usage: None,
            },
        ],
        false,
    );
    assert_eq!(
        consumed.stop_reason(),
        Some(ConsumeStopReason::Error {
            kind: conex_types::error::ProviderErrorKind::Network,
            message: "网络连接突然重置".into(),
            retryable: true,
        })
    );

    let outcome = consume_classify(&mut state, &consumed, "a1", false, false)
        .await
        .expect("consume_classify 应处理并返回结果");

    // 验证 1：坚决以错误收场，绝不伪装为成功
    assert!(outcome.end.is_some(), "必须产生终止决策");
    assert_eq!(state.machine.state(), S::TurnComplete);

    // 验证 2：状态机绝对未进入 ExecutingTools（工具派发被物理阻断）
    assert_ne!(
        state.machine.state(),
        S::ExecutingTools,
        "严禁进入 ExecutingTools 状态！"
    );

    // 验证 3：就地合成带有 TOOL_STREAM_ERROR_BEFORE_DISPATCH 的 ToolResult
    let last_tool_msg = state
        .conversation
        .iter()
        .find(|m| m.role == AgentMessageRole::Tool)
        .expect("必须合成 Tool 角色消息");
    assert_eq!(last_tool_msg.role, AgentMessageRole::Tool);
    let metadata = last_tool_msg.metadata.as_ref().expect("必须有 metadata");
    assert_eq!(
        metadata.get("errorCode").and_then(|v| v.as_str()),
        Some(conex_types::error::codes::TOOL_STREAM_ERROR_BEFORE_DISPATCH),
        "错误码必须为 TOOL_STREAM_ERROR_BEFORE_DISPATCH"
    );
    if let Some(AgentMessageBlock::ToolResult {
        tool_call_id,
        is_error,
        ..
    }) = last_tool_msg.blocks.first()
    {
        assert_eq!(tool_call_id, &tool_call.id);
        assert!(is_error);
    } else {
        panic!("缺少 ToolResult 块");
    }
}

/// BC02-2：流以 Error 终止且无 tool_calls 时，保留正文内容并进入 TurnComplete（以便外层触发 E1 content-resume 续写）
#[tokio::test]
async fn test_error_stop_without_tool_calls_salvages_and_completes_turn_for_resume() {
    let mut state = test_state();
    let consumed = crate::stream::consume(
        vec![
            ProviderStreamEvent::text("吐了部分正文后断网"),
            ProviderStreamEvent::Stop {
                reason: StopReason::Error,
                error: Some("500 Internal Server Error".into()),
                error_kind: Some(conex_types::error::ProviderErrorKind::ServerError),
                usage: None,
            },
        ],
        false,
    );

    let outcome = consume_classify(&mut state, &consumed, "a1", false, false)
        .await
        .expect("consume_classify 应处理并返回结果");

    // 验证：无 tool_calls 时内容被部分保留，回合正常收工进入 TurnComplete（由外层触发 content-resume 续写）
    assert!(
        outcome.end.is_none(),
        "无工具调用的断流不直接 fatal 终止，而放行由外层触发续写"
    );
    assert_eq!(state.machine.state(), S::TurnComplete);
}

/// BC02-6：流解析器发出 Stop 事件后即刻终结消费循环，不再消费 Stop 之后的任何条目
#[tokio::test]
async fn test_consume_stream_breaks_immediately_on_stop() {
    let stream = futures::stream::iter(vec![
        Ok(ProviderStreamEvent::text("正文1")),
        Ok(ProviderStreamEvent::stop(StopReason::Stop)),
        Ok(ProviderStreamEvent::text(
            "Stop 之后的脏数据（绝不应被推入）",
        )),
    ]);
    let mut state = test_state();
    let outcome = consume_stream(&mut state, None, "a1", Ok(Box::pin(stream))).await;

    let consumed = outcome.consumed.expect("应成功聚合");
    assert_eq!(consumed.response.text(), "正文1");
}

/// S4 定稿保序：交错事件序（思考→正文→工具→正文→思考→工具→总结）经
/// consume + build_assistant_message 后，定稿 blocks 逐段同序、多段思考
/// 各自成块——禁止再归拢为 [thought 块 → 本轮全文一块 → tool-call 块]。
#[test]
fn build_assistant_message_preserves_interleaved_segment_order() {
    let consumed = crate::stream::consume(
        vec![
            ProviderStreamEvent::thought("先想一想", None),
            ProviderStreamEvent::text("第一段正文"),
            ProviderStreamEvent::tool_call(
                Some("call_1".to_string()),
                "read_file",
                serde_json::json!({ "path": "a.txt" }),
            ),
            ProviderStreamEvent::text("第二段正文"),
            ProviderStreamEvent::thought("再想一想", None),
            ProviderStreamEvent::tool_call(
                Some("call_2".to_string()),
                "read_file",
                serde_json::json!({ "path": "b.txt" }),
            ),
            ProviderStreamEvent::text("总结"),
            ProviderStreamEvent::stop(StopReason::ToolCall),
        ],
        false,
    );
    let message = build_assistant_message(&consumed, "a1", None);
    assert_eq!(
        message.blocks,
        vec![
            AgentMessageBlock::Thought {
                text: "先想一想".to_string(),
                redacted: None,
            },
            AgentMessageBlock::Text {
                text: "第一段正文".to_string(),
            },
            AgentMessageBlock::ToolCall(ToolCallBlock {
                id: "call_1".to_string(),
                tool_name: "read_file".to_string(),
                input: serde_json::json!({ "path": "a.txt" }),
            }),
            AgentMessageBlock::Text {
                text: "第二段正文".to_string(),
            },
            AgentMessageBlock::Thought {
                text: "再想一想".to_string(),
                redacted: None,
            },
            AgentMessageBlock::ToolCall(ToolCallBlock {
                id: "call_2".to_string(),
                tool_name: "read_file".to_string(),
                input: serde_json::json!({ "path": "b.txt" }),
            }),
            AgentMessageBlock::Text {
                text: "总结".to_string(),
            },
        ]
    );
}
