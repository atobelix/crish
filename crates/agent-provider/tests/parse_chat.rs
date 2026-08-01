//! B2.10 chat-completions 端到端测试（05 §5.2 stream::parse）
//!
//! mock 服务器返回 chat-completions SSE 帧序列（thinking delta / tool_calls
//! 增量 / finish_reason / usage / [DONE]），走 transport → parse → consume
//! 全链路后断言 Message / tool-call / usage / stopReason。
//! 语义对齐 provider-openai-compatible.test.ts:43-212（流式文本/分段工具参数）。

mod common;

use agent_provider::consume::{consume, ConsumeStopReason};
use agent_provider::events::ProviderStreamEvent;
use agent_provider::parse::chat::ChatCompletionsParser;
use common::{MockFrame, MockResponse, MockServer};
use conex_types::message::ToolCallBlock;
use conex_types::response::ProviderOutput;
use serde_json::json;

/// 把读取到的帧序列解析为事件（chat 路径）
fn events_from_output(output: &agent_provider::sse::StreamReadOutput) -> Vec<ProviderStreamEvent> {
    let mut parser = ChatCompletionsParser::new();
    let mut events = Vec::new();
    for frame in &output.frames {
        events.extend(parser.push_frame(frame).expect("帧处理"));
    }
    events.extend(parser.finish().expect("流结束"));
    events
}

/// 全链路：thinking + 分段 tool_calls + usage → Message/tool-call/usage/stopReason
#[tokio::test(flavor = "multi_thread")]
async fn chat_completions_end_to_end() {
    let server = MockServer::start(|_request| {
        MockResponse::Sse {
            frames: vec![
                // 思考增量（reasoning_content，02 §1.4 优先级第一位）
                MockFrame::data(
                    json!({
                        "id": "chatcmpl-1",
                        "choices": [{ "index": 0, "delta": { "reasoning_content": "思考中" }, "finish_reason": null }],
                    })
                    .to_string(),
                ),
                // 正文增量两段
                MockFrame::data(
                    json!({
                        "choices": [{ "index": 0, "delta": { "content": "你好" }, "finish_reason": null }],
                    })
                    .to_string(),
                ),
                MockFrame::data(
                    json!({
                        "choices": [{ "index": 0, "delta": { "content": "，" }, "finish_reason": null }],
                    })
                    .to_string(),
                ),
                // tool_calls 增量第一片：带 id 与 name
                MockFrame::data(
                    json!({
                        "choices": [{ "index": 0, "delta": {
                            "tool_calls": [{ "index": 0, "id": "call_1", "function": { "name": "read_file", "arguments": r#"{"path":"/a""# } }],
                        }, "finish_reason": null }],
                    })
                    .to_string(),
                ),
                // tool_calls 增量第二片：仅追加 arguments（跨帧拼接）
                MockFrame::data(
                    json!({
                        "choices": [{ "index": 0, "delta": {
                            "tool_calls": [{ "index": 0, "function": { "arguments": r#","mode":"r"}"# } }],
                        }, "finish_reason": null }],
                    })
                    .to_string(),
                ),
                // 终帧：finish_reason=tool_calls + 覆盖式 usage
                MockFrame::data(
                    json!({
                        "choices": [{ "index": 0, "delta": {}, "finish_reason": "tool_calls" }],
                        "usage": { "prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20 },
                    })
                    .to_string(),
                ),
                MockFrame::data("[DONE]"),
            ],
            interrupt_after: None,
        }
    })
    .await;

    let request_body = json!({
        "model": "test-model",
        "messages": [{ "role": "user", "content": "读一下文件" }],
    });
    let output = common::fetch_sse(server.addr, "/v1/chat/completions", request_body).await;

    // 记录到的请求：方法/路径/头/体
    let requests = server.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "POST");
    assert_eq!(requests[0].path, "/v1/chat/completions");
    assert!(
        requests[0]
            .header("content-type")
            .unwrap_or("")
            .contains("application/json")
    );
    assert!(requests[0].body.contains("读一下文件"));

    // 全链路：解析 + 消费
    let events = events_from_output(&output);
    let result = consume(events, false);

    assert!(
        result.response.is_message(),
        "应产出 Message，得到 {:?}",
        result.response
    );
    assert_eq!(result.response.text(), "你好，");
    assert_eq!(result.stop_reason(), Some(ConsumeStopReason::ToolCall));
    // 分段工具参数跨帧合并为完整调用
    let ProviderOutput::Message { tool_calls, .. } = &result.response else {
        unreachable!("已断言为 Message")
    };
    assert_eq!(
        tool_calls.as_slice(),
        [ToolCallBlock {
            id: "call_1".to_string(),
            tool_name: "read_file".to_string(),
            input: json!({ "path": "/a", "mode": "r" }),
        }]
    );
    // usage 覆盖式进入 metadata（02 §六.6 OpenAI 覆盖式）
    assert_eq!(result.metadata["usage"]["promptTokens"], 12);
    assert_eq!(result.metadata["usage"]["completionTokens"], 8);
    assert_eq!(result.metadata["usage"]["totalTokens"], 20);
    // 思考聚合与 provider 终态透传
    assert_eq!(result.metadata["thought"], "思考中");
    assert_eq!(result.metadata["providerFinishReason"], "tool-call");
}

/// finish_reason=length 透传 → stopReason=length（供上层 length 恢复阶梯）
#[tokio::test(flavor = "multi_thread")]
async fn length_finish_reason_propagates_to_stop_reason() {
    let server = MockServer::start(|_request| {
        MockResponse::Sse {
            frames: vec![
                MockFrame::data(
                    json!({
                        "choices": [{ "index": 0, "delta": { "content": "截断的回复" }, "finish_reason": null }],
                    })
                    .to_string(),
                ),
                MockFrame::data(
                    json!({
                        "choices": [{ "index": 0, "delta": {}, "finish_reason": "length" }],
                    })
                    .to_string(),
                ),
                MockFrame::data("[DONE]"),
            ],
            interrupt_after: None,
        }
    })
    .await;

    let output = common::fetch_sse(
        server.addr,
        "/v1/chat/completions",
        json!({ "messages": [] }),
    )
    .await;
    let result = consume(events_from_output(&output), false);

    assert!(result.response.is_message());
    assert_eq!(result.response.text(), "截断的回复");
    assert_eq!(result.stop_reason(), Some(ConsumeStopReason::Length));
    assert_eq!(result.metadata["providerFinishReason"], "length");
}
