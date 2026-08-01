//! B2.10 Gemini streamGenerateContent 端到端测试（05 §5.2 stream::parse）
//!
//! mock 返回 Gemini 帧式 SSE 序列（thought part / text part / functionCall /
//! finishReason / usageMetadata 逐帧合并），走 transport → parse → consume
//! 全链路。语义对齐 gemini-stream-parse.ts（02 §三.2、§六.6）。

mod common;

use agent_provider::consume::{consume, ConsumeStopReason};
use agent_provider::events::ProviderStreamEvent;
use agent_provider::parse::gemini::GeminiParser;
use common::{MockFrame, MockResponse, MockServer};
use conex_types::message::ToolCallBlock;
use conex_types::response::ProviderOutput;
use serde_json::json;

/// 把读取到的帧序列解析为事件（Gemini 路径）
fn events_from_output(output: &agent_provider::sse::StreamReadOutput) -> Vec<ProviderStreamEvent> {
    let mut parser = GeminiParser::new();
    let mut events = Vec::new();
    for frame in &output.frames {
        events.extend(parser.push_frame(frame).expect("帧处理"));
    }
    events.extend(parser.finish().expect("流结束"));
    events
}

/// 全链路：thought + 正文 + functionCall + usageMetadata 逐帧合并
#[tokio::test(flavor = "multi_thread")]
async fn gemini_end_to_end() {
    let server = MockServer::start(|_request| {
        MockResponse::Sse {
            frames: vec![
                // 思考部分（thought=true，不标 redacted，02 §1.4）
                MockFrame::data(
                    json!({
                        "candidates": [{ "content": { "parts": [{ "text": "推理中", "thought": true }] } }],
                    })
                    .to_string(),
                ),
                // 正文第一段 + usageMetadata（累计值帧 1）
                MockFrame::data(
                    json!({
                        "candidates": [{ "content": { "parts": [{ "text": "你好" }] } }],
                        "usageMetadata": { "promptTokenCount": 10, "cachedContentTokenCount": 2 },
                    })
                    .to_string(),
                ),
                // 正文第二段 + functionCall + finishReason=STOP + usageMetadata 帧 2
                MockFrame::data(
                    json!({
                        "candidates": [{
                            "content": {
                                "parts": [
                                    { "text": "，世界" },
                                    { "functionCall": { "name": "read_file", "args": { "path": "/a" } } },
                                ],
                            },
                            "finishReason": "STOP",
                        }],
                        "usageMetadata": { "promptTokenCount": 10, "candidatesTokenCount": 7 },
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
        "/v1beta/models/test-model:streamGenerateContent",
        json!({ "contents": [{ "role": "user", "parts": [{ "text": "你好" }] }] }),
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
    // 有工具调用且 finishReason=STOP → 强制 tool-call（158-160）
    assert_eq!(result.stop_reason(), Some(ConsumeStopReason::ToolCall));
    let ProviderOutput::Message { tool_calls, .. } = &result.response else {
        unreachable!("已断言为 Message")
    };
    assert_eq!(
        tool_calls.as_slice(),
        [ToolCallBlock {
            id: "gemini_fc_1".to_string(),
            tool_name: "read_file".to_string(),
            input: json!({ "path": "/a" }),
        }]
    );
    // 逐帧合并：帧 1 的 cacheRead 回退保留，帧 2 的 completion 补全
    assert_eq!(result.metadata["usage"]["promptTokens"], 10);
    assert_eq!(result.metadata["usage"]["completionTokens"], 7);
    assert_eq!(result.metadata["usage"]["totalTokens"], 17);
    assert_eq!(result.metadata["usage"]["cacheReadTokens"], 2);
    assert_eq!(result.metadata["thought"], "推理中");
    assert_eq!(result.metadata["providerFinishReason"], "tool-call");
}

/// 阻断：promptFeedback.blockReason 且无 candidates → error stop
#[tokio::test(flavor = "multi_thread")]
async fn prompt_blocked_produces_error_stop() {
    let server = MockServer::start(|_request| {
        MockResponse::Sse {
            frames: vec![MockFrame::data(
                json!({
                    "promptFeedback": { "blockReason": "SAFETY", "blockReasonMessage": "含违禁内容" },
                })
                .to_string(),
            )],
            interrupt_after: None,
        }
    })
    .await;

    let output = common::fetch_sse(
        server.addr,
        "/v1beta/models/test-model:streamGenerateContent",
        json!({ "contents": [] }),
    )
    .await;
    let events = events_from_output(&output);
    let result = consume(events, false);

    let ProviderOutput::StreamError { classified } = &result.response else {
        panic!("阻断应产出 StreamError，得到 {:?}", result.response);
    };
    assert!(classified.message.contains("Gemini prompt blocked (SAFETY)"));
}
