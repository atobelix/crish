//! B2.10 Responses API 端到端测试（05 §5.2 stream::parse）
//!
//! mock 返回 Responses SSE 事件序列（output_text.delta / reasoning delta /
//! function_call 增量 / completed 终态 + usage），走 transport → parse →
//! consume 全链路。语义对齐 provider-openai-compatible.test.ts:389-489。

mod common;

use agent_provider::consume::{consume, ConsumeStopReason};
use agent_provider::events::ProviderStreamEvent;
use agent_provider::parse::responses::ResponsesParser;
use common::{MockFrame, MockResponse, MockServer};
use conex_types::message::ToolCallBlock;
use conex_types::response::ProviderOutput;
use serde_json::json;

/// 把读取到的帧序列解析为事件（Responses 路径）
fn events_from_output(output: &agent_provider::sse::StreamReadOutput) -> Vec<ProviderStreamEvent> {
    let mut parser = ResponsesParser::new();
    let mut events = Vec::new();
    for frame in &output.frames {
        events.extend(parser.push_frame(frame).expect("帧处理"));
    }
    events.extend(parser.finish().expect("流结束"));
    events
}

/// 全链路：正文 + 推理 + function_call 增量 + 终态 usage
#[tokio::test(flavor = "multi_thread")]
async fn responses_end_to_end() {
    let server = MockServer::start(|_request| {
        MockResponse::Sse {
            frames: vec![
                // 正文增量
                MockFrame::data(
                    json!({ "type": "response.output_text.delta", "delta": "你好" }).to_string(),
                ),
                // 推理增量（redacted=true，02 §六.10）
                MockFrame::data(
                    json!({ "type": "response.reasoning_summary_text.delta", "delta": "推理过程" })
                        .to_string(),
                ),
                // function_call item 加入（arguments 占位）
                MockFrame::data(
                    json!({
                        "type": "response.output_item.added",
                        "item": { "id": "item_1", "type": "function_call", "call_id": "call_1", "name": "read_file", "arguments": "" },
                    })
                    .to_string(),
                ),
                // arguments 半 JSON 分片追加
                MockFrame::data(
                    json!({ "type": "response.function_call_arguments.delta", "item_id": "item_1", "delta": r#"{"path":"/a""# })
                        .to_string(),
                ),
                // arguments 完整替换并 emit tool-call
                MockFrame::data(
                    json!({ "type": "response.function_call_arguments.done", "item_id": "item_1", "arguments": r#"{"path":"/a"}"# })
                        .to_string(),
                ),
                // 终态：completed + usage（02 §二.4 终态映射）
                MockFrame::data(
                    json!({
                        "type": "response.completed",
                        "response": { "status": "completed", "usage": { "input_tokens": 15, "output_tokens": 5, "total_tokens": 20 } },
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
        "/v1/responses",
        json!({ "model": "test-model", "input": "读一下文件" }),
    )
    .await;

    let events = events_from_output(&output);
    let result = consume(events, false);

    assert!(
        result.response.is_message(),
        "应产出 Message，得到 {:?}",
        result.response
    );
    assert_eq!(result.response.text(), "你好");
    assert_eq!(result.stop_reason(), Some(ConsumeStopReason::ToolCall));
    let ProviderOutput::Message { tool_calls, .. } = &result.response else {
        unreachable!("已断言为 Message")
    };
    assert_eq!(
        tool_calls.as_slice(),
        [ToolCallBlock {
            id: "call_1".to_string(),
            tool_name: "read_file".to_string(),
            input: json!({ "path": "/a" }),
        }]
    );
    // 终态帧 usage 覆盖式（response.usage）
    assert_eq!(result.metadata["usage"]["promptTokens"], 15);
    assert_eq!(result.metadata["usage"]["completionTokens"], 5);
    // Responses 推理标 redacted=true
    assert_eq!(result.metadata["thought"], "推理过程");
    let blocks = result.metadata["thoughtBlocks"].as_array().unwrap();
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0]["redacted"], true);
    assert_eq!(result.metadata["providerFinishReason"], "tool-call");
}

/// 终态 status=incomplete → stopReason=length（02 §二.4 终态映射表）
#[tokio::test(flavor = "multi_thread")]
async fn incomplete_terminal_maps_to_length() {
    let server = MockServer::start(|_request| MockResponse::Sse {
        frames: vec![
            MockFrame::data(
                json!({ "type": "response.output_text.delta", "delta": "半截" }).to_string(),
            ),
            MockFrame::data(
                json!({
                    "type": "response.incomplete",
                    "response": { "status": "incomplete" },
                })
                .to_string(),
            ),
            MockFrame::data("[DONE]"),
        ],
        interrupt_after: None,
    })
    .await;

    let output = common::fetch_sse(server.addr, "/v1/responses", json!({ "input": "x" })).await;
    let result = consume(events_from_output(&output), false);

    assert!(result.response.is_message());
    assert_eq!(result.response.text(), "半截");
    assert_eq!(result.stop_reason(), Some(ConsumeStopReason::Length));
    assert_eq!(result.metadata["providerFinishReason"], "length");
}
