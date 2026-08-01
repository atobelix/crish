//! B2.10 Anthropic Messages 端到端测试（05 §5.2 stream::parse）
//!
//! mock 返回 Anthropic 事件驱动 SSE 序列（message_start usage 初始 /
//! thinking + text delta / tool_use input_json 分片 / message_delta usage
//! 分片补全 / message_stop），走 transport → parse → consume 全链路。
//! 语义对齐 anthropic-stream-parse.ts（02 §三.1、§六.6）。

mod common;

use agent_provider::consume::{consume, ConsumeStopReason};
use agent_provider::events::ProviderStreamEvent;
use agent_provider::parse::anthropic::AnthropicParser;
use common::{MockFrame, MockResponse, MockServer};
use conex_types::message::ToolCallBlock;
use conex_types::response::ProviderOutput;
use serde_json::json;

/// 把读取到的帧序列解析为事件（Anthropic 路径）
fn events_from_output(output: &agent_provider::sse::StreamReadOutput) -> Vec<ProviderStreamEvent> {
    let mut parser = AnthropicParser::new();
    let mut events = Vec::new();
    for frame in &output.frames {
        events.extend(parser.push_frame(frame).expect("帧处理"));
    }
    events.extend(parser.finish().expect("流结束"));
    events
}

/// 全链路：thinking + 正文 + tool_use 分片 + usage 分片补全
#[tokio::test(flavor = "multi_thread")]
async fn anthropic_end_to_end() {
    let server = MockServer::start(|_request| {
        MockResponse::Sse {
            frames: vec![
                // usage 初始分片（input_tokens / cache_read）
                MockFrame::data(
                    json!({
                        "type": "message_start",
                        "message": { "usage": { "input_tokens": 11, "cache_read_input_tokens": 3 } },
                    })
                    .to_string(),
                ),
                // thinking 块（内容经 thinking_delta 到达，不标 redacted）
                MockFrame::data(
                    json!({
                        "type": "content_block_start",
                        "index": 0,
                        "content_block": { "type": "thinking" },
                    })
                    .to_string(),
                ),
                MockFrame::data(
                    json!({
                        "type": "content_block_delta",
                        "index": 0,
                        "delta": { "type": "thinking_delta", "thinking": "让我想想" },
                    })
                    .to_string(),
                ),
                // 正文块两段
                MockFrame::data(
                    json!({
                        "type": "content_block_start",
                        "index": 1,
                        "content_block": { "type": "text" },
                    })
                    .to_string(),
                ),
                MockFrame::data(
                    json!({
                        "type": "content_block_delta",
                        "index": 1,
                        "delta": { "type": "text_delta", "text": "你好" },
                    })
                    .to_string(),
                ),
                MockFrame::data(
                    json!({
                        "type": "content_block_delta",
                        "index": 1,
                        "delta": { "type": "text_delta", "text": "，世界" },
                    })
                    .to_string(),
                ),
                // tool_use 块 + input_json 半 JSON 分片
                MockFrame::data(
                    json!({
                        "type": "content_block_start",
                        "index": 2,
                        "content_block": { "type": "tool_use", "id": "toolu_1", "name": "read_file" },
                    })
                    .to_string(),
                ),
                MockFrame::data(
                    json!({
                        "type": "content_block_delta",
                        "index": 2,
                        "delta": { "type": "input_json_delta", "partial_json": r#"{"path":"/a""# },
                    })
                    .to_string(),
                ),
                MockFrame::data(
                    json!({
                        "type": "content_block_delta",
                        "index": 2,
                        "delta": { "type": "input_json_delta", "partial_json": r#"}"# },
                    })
                    .to_string(),
                ),
                // 块结束：emit tool-call
                MockFrame::data(
                    json!({ "type": "content_block_stop", "index": 2 }).to_string(),
                ),
                // 终态：stop_reason=tool_use + usage 分片补全（output_tokens）
                MockFrame::data(
                    json!({
                        "type": "message_delta",
                        "delta": { "stop_reason": "tool_use" },
                        "usage": { "output_tokens": 9 },
                    })
                    .to_string(),
                ),
                MockFrame::data(json!({ "type": "message_stop" }).to_string()),
                MockFrame::data("[DONE]"),
            ],
            interrupt_after: None,
        }
    })
    .await;

    let output = common::fetch_sse(
        server.addr,
        "/v1/messages",
        json!({ "model": "claude-test", "messages": [{ "role": "user", "content": "你好" }] }),
    )
    .await;

    let events = events_from_output(&output);
    let result = consume(events, false);

    assert!(
        result.response.is_message(),
        "应产出 Message，得到 {:?}",
        result.response
    );
    assert_eq!(result.response.text(), "你好，世界");
    assert_eq!(result.stop_reason(), Some(ConsumeStopReason::ToolCall));
    let ProviderOutput::Message { tool_calls, .. } = &result.response else {
        unreachable!("已断言为 Message")
    };
    assert_eq!(
        tool_calls.as_slice(),
        [ToolCallBlock {
            id: "toolu_1".to_string(),
            tool_name: "read_file".to_string(),
            input: json!({ "path": "/a" }),
        }]
    );
    // Anthropic thought 不标 redacted（02 §1.4）
    assert_eq!(result.metadata["thought"], "让我想想");
    assert_eq!(result.metadata["thoughtBlocks"][0].get("redacted"), None);
    // usage 分片补全：message_start 的 input + message_delta 的 output 合并
    assert_eq!(result.metadata["usage"]["promptTokens"], 11);
    assert_eq!(result.metadata["usage"]["completionTokens"], 9);
    assert_eq!(result.metadata["usage"]["totalTokens"], 20);
    assert_eq!(result.metadata["usage"]["cacheReadTokens"], 3);
    assert_eq!(result.metadata["providerFinishReason"], "tool-call");
}

/// 空流保护：无内容/无 message_stop/无 usage → error stop
#[tokio::test(flavor = "multi_thread")]
async fn empty_stream_produces_error_stop() {
    let server = MockServer::start(|_request| {
        MockResponse::Sse {
            frames: vec![MockFrame::data("[DONE]")],
            interrupt_after: None,
        }
    })
    .await;

    let output = common::fetch_sse(server.addr, "/v1/messages", json!({ "messages": [] })).await;
    let events = events_from_output(&output);
    let result = consume(events, false);

    let ProviderOutput::StreamError { classified } = &result.response else {
        panic!("空流应产出 StreamError，得到 {:?}", result.response);
    };
    assert!(classified.message.contains("without content events"));
    assert!(!classified.retryable);
}
