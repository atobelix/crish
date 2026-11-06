//! S4 定稿保序：ConsumeResult.segments 必须是事件到达序的块序列
//! （thought / text / tool-call 逐段交错），定稿消息 blocks 直接取用它；
//! 分桶聚合（response 的全文 String / tool_calls Vec）只供分类与
//! 平坦文本消费，与 segments 分工，不得互相替代。

use super::*;
use conex_types::message::{AgentMessageBlock, ToolCallBlock};

fn tool_block(id: &str, tool_name: &str, input: serde_json::Value) -> AgentMessageBlock {
    AgentMessageBlock::ToolCall(ToolCallBlock {
        id: id.to_string(),
        tool_name: tool_name.to_string(),
        input,
    })
}

/// 交错轮：思考→正文→工具→正文→思考→工具→总结，segments 逐段同序；
/// 同时 response 的平坦聚合保持原口径（分类/历史用途不受影响）。
#[test]
fn segments_preserve_interleaved_event_order() {
    let result = consume(
        vec![
            ProviderStreamEvent::thought("想一", None),
            ProviderStreamEvent::text("正文一"),
            ProviderStreamEvent::tool_call(
                Some("call_1".to_string()),
                "read_file",
                serde_json::json!({ "path": "a.txt" }),
            ),
            ProviderStreamEvent::text("正文二"),
            ProviderStreamEvent::thought("想二", None),
            ProviderStreamEvent::tool_call(
                Some("call_2".to_string()),
                "grep",
                serde_json::json!({ "q": "x" }),
            ),
            ProviderStreamEvent::text("总结"),
            ProviderStreamEvent::stop(StopReason::ToolCall),
        ],
        false,
    );
    assert_eq!(
        result.segments,
        vec![
            AgentMessageBlock::Thought {
                text: "想一".to_string(),
                redacted: None,
            },
            AgentMessageBlock::Text {
                text: "正文一".to_string(),
            },
            tool_block("call_1", "read_file", serde_json::json!({ "path": "a.txt" })),
            AgentMessageBlock::Text {
                text: "正文二".to_string(),
            },
            AgentMessageBlock::Thought {
                text: "想二".to_string(),
                redacted: None,
            },
            tool_block("call_2", "grep", serde_json::json!({ "q": "x" })),
            AgentMessageBlock::Text {
                text: "总结".to_string(),
            },
        ]
    );
    // 分桶聚合分工不变：全文拼接 + 工具调用到达序
    assert_eq!(result.response.text(), "正文一正文二总结");
    let ProviderOutput::Message { tool_calls, .. } = &result.response else {
        panic!("交错轮应分类为 Message，实际 {:?}", result.response);
    };
    let call_ids: Vec<&str> = tool_calls.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(call_ids, vec!["call_1", "call_2"]);
    assert_eq!(result.stop_reason(), Some(ConsumeStopReason::ToolCall));
}

/// 段合并口径：连续同类增量合并为一段（段边界独立于网络分块粒度）；
/// 思考段仅在 redacted 取值相同时合并，redacted 边界各自成段。
#[test]
fn consecutive_deltas_coalesce_and_redacted_boundary_splits() {
    let result = consume(
        vec![
            ProviderStreamEvent::text("正"),
            ProviderStreamEvent::text("文"),
            ProviderStreamEvent::thought("甲", None),
            ProviderStreamEvent::thought("乙", Some(true)),
            ProviderStreamEvent::thought("丙", Some(true)),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        false,
    );
    assert_eq!(
        result.segments,
        vec![
            AgentMessageBlock::Text {
                text: "正文".to_string(),
            },
            AgentMessageBlock::Thought {
                text: "甲".to_string(),
                redacted: None,
            },
            AgentMessageBlock::Thought {
                text: "乙丙".to_string(),
                redacted: Some(true),
            },
        ]
    );
}

/// Empty / StreamError 响应不携带 segments（定稿只发生在 Message）。
#[test]
fn segments_empty_for_empty_and_error_outcomes() {
    let empty = consume(vec![ProviderStreamEvent::stop(StopReason::Stop)], false);
    assert_eq!(empty.response, ProviderOutput::Empty);
    assert!(empty.segments.is_empty());

    let errored = consume(
        vec![ProviderStreamEvent::Stop {
            reason: StopReason::Error,
            error: Some("boom".to_string()),
            error_kind: Some(ProviderErrorKind::Unknown),
            usage: None,
        }],
        false,
    );
    assert!(errored.segments.is_empty());
}

/// 中止打捞：部分内容定稿时 segments 仍按到达序（正文→工具→正文）。
#[test]
fn aborted_partial_stream_keeps_segment_order() {
    let result = consume(
        vec![
            ProviderStreamEvent::text("前文"),
            ProviderStreamEvent::tool_call(
                Some("call_1".to_string()),
                "read_file",
                serde_json::json!({ "path": "a.txt" }),
            ),
            ProviderStreamEvent::text("后文"),
        ],
        true,
    );
    assert_eq!(result.stop_reason(), Some(ConsumeStopReason::Aborted));
    assert_eq!(
        result.segments,
        vec![
            AgentMessageBlock::Text {
                text: "前文".to_string(),
            },
            tool_block("call_1", "read_file", serde_json::json!({ "path": "a.txt" })),
            AgentMessageBlock::Text {
                text: "后文".to_string(),
            },
        ]
    );
}
