//! T5.1 G7-b Azure OpenAI Responses 端到端测试（对齐 parse_responses.rs 形态）
//!
//! mock 返回 azure-openai-responses 的 SSE 事件序列（wire 与 openai responses 同构，
//! pi-ai azure-openai-responses.js:91 复用 processResponsesStream）——正文 / 推理 /
//! function_call 增量 / azure 错误帧 / 终态 usage，经 AzureResponsesParser（委托
//! ResponsesParser 内核）→ consume 全链路。语义对齐 parse_responses.rs。

mod common;

use agent_provider::consume::{consume, ConsumeStopReason};
use agent_provider::events::{stream_error_kind, ProviderStreamEvent};
use agent_provider::parse::azure_responses::AzureResponsesParser;
use common::{MockFrame, MockResponse, MockServer};
use conex_types::message::ToolCallBlock;
use conex_types::response::ProviderOutput;
use serde_json::json;

/// 把读取到的帧序列解析为事件（Azure Responses 路径）
fn events_from_output(output: &agent_provider::sse::StreamReadOutput) -> Vec<ProviderStreamEvent> {
    let mut parser = AzureResponsesParser::new();
    let mut events = Vec::new();
    for frame in &output.frames {
        events.extend(parser.push_frame(frame).expect("帧处理"));
    }
    events.extend(parser.finish().expect("流结束"));
    events
}

/// 全链路：正文 + 推理 + function_call 增量 + 终态 usage（azure 同 responses 形状）
#[tokio::test(flavor = "multi_thread")]
async fn azure_responses_end_to_end() {
    let server = MockServer::start(|_request| {
        MockResponse::Sse {
            frames: vec![
                // 正文增量
                MockFrame::data(
                    json!({ "type": "response.output_text.delta", "delta": "你好 Azure" })
                        .to_string(),
                ),
                // 推理增量（redacted=true）
                MockFrame::data(
                    json!({ "type": "response.reasoning_text.delta", "delta": "推理中" })
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
                // arguments 分片追加
                MockFrame::data(
                    json!({ "type": "response.function_call_arguments.delta", "item_id": "item_1", "delta": r#"{"path":"/b""# })
                        .to_string(),
                ),
                // arguments 完整替换并 emit tool-call
                MockFrame::data(
                    json!({ "type": "response.function_call_arguments.done", "item_id": "item_1", "arguments": r#"{"path":"/b"}"# })
                        .to_string(),
                ),
                // 终态：completed + azure usage（input_tokens_details 归一）
                MockFrame::data(
                    json!({
                        "type": "response.completed",
                        "response": {
                            "status": "completed",
                            "usage": {
                                "input_tokens": 100,
                                "output_tokens": 20,
                                "total_tokens": 120,
                                "input_tokens_details": { "cached_tokens": 40, "cache_write_tokens": 10 },
                                "output_tokens_details": { "reasoning_tokens": 6 },
                            },
                        },
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
        "/openai/v1/responses",
        json!({ "model": "test-deployment", "input": "读一下" }),
    )
    .await;

    let events = events_from_output(&output);
    let result = consume(events, false);

    assert!(
        result.response.is_message(),
        "应产出 Message，得到 {:?}",
        result.response
    );
    assert_eq!(result.response.text(), "你好 Azure");
    assert_eq!(result.stop_reason(), Some(ConsumeStopReason::ToolCall));
    let ProviderOutput::Message { tool_calls, .. } = &result.response else {
        unreachable!("已断言为 Message")
    };
    assert_eq!(
        tool_calls.as_slice(),
        [ToolCallBlock {
            id: "call_1".to_string(),
            tool_name: "read_file".to_string(),
            input: json!({ "path": "/b" }),
        }]
    );
    // 终态 usage 归一（原始值保留 + cache/reasoning 拆分）
    let usage = result.metadata["usage"].clone();
    assert_eq!(usage["promptTokens"], 100);
    assert_eq!(usage["completionTokens"], 20);
    assert_eq!(usage["cacheReadTokens"], 40);
    assert_eq!(usage["cacheWriteTokens"], 10);
    assert_eq!(usage["reasoningTokens"], 6);
    assert_eq!(usage["totalTokens"], 120);
    // reasoning redacted=true
    assert_eq!(result.metadata["thought"], "推理中");
    let blocks = result.metadata["thoughtBlocks"].as_array().unwrap();
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0]["redacted"], true);
    assert_eq!(result.metadata["providerFinishReason"], "tool-call");
}

/// azure 错误帧（code+message 顶层形状）→ 立即 error stop，归类正确
#[tokio::test(flavor = "multi_thread")]
async fn azure_error_frame_classified() {
    let server = MockServer::start(|_request| MockResponse::Sse {
        frames: vec![
            MockFrame::data(
                json!({ "type": "error", "code": "context_length_exceeded", "message": "超长" })
                    .to_string(),
            ),
            MockFrame::data("[DONE]"),
        ],
        interrupt_after: None,
    })
    .await;

    let output =
        common::fetch_sse(server.addr, "/openai/v1/responses", json!({ "input": "x" })).await;
    let events = events_from_output(&output);
    let stop = events
        .iter()
        .find(|event| matches!(event, ProviderStreamEvent::Stop { .. }))
        .expect("应产出 stop");
    let ProviderStreamEvent::Stop {
        reason,
        error,
        error_kind,
        ..
    } = stop
    else {
        unreachable!("已找到 stop")
    };
    assert_eq!(reason, &agent_provider::events::StopReason::Error);
    assert_eq!(error.as_deref(), Some("超长"), "azure message 优先于 code");
    // 错误文案走统一分类管线
    assert_eq!(*error_kind, Some(stream_error_kind("超长")));
}

/// 终态 status=incomplete → stopReason=length（azure 与 responses 同）
#[tokio::test(flavor = "multi_thread")]
async fn azure_incomplete_terminal_maps_to_length() {
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

    let output =
        common::fetch_sse(server.addr, "/openai/v1/responses", json!({ "input": "x" })).await;
    let result = consume(events_from_output(&output), false);

    assert!(result.response.is_message());
    assert_eq!(result.response.text(), "半截");
    assert_eq!(result.stop_reason(), Some(ConsumeStopReason::Length));
    assert_eq!(result.metadata["providerFinishReason"], "length");
}
