//! T2.5 · Anthropic 全流式端到端（MockServer 基座）
//!
//! 战役 `docs/provider-adapter-campaign/` · 轮次 2 · 单元 T2.5（I1/M2）
//! 补齐 I1 不变式「四协议 mock 端到端断言各一」的 anthropic 流式缺口：
//! mock 复刻 `message_start → content_block_start → content_block_delta →
//! content_block_stop → message_delta → message_stop` 完整事件序列
//! （SSE `data:` 帧，对齐 `src/parse/anthropic.rs` 帧语义），走
//! transport → parse → consume 全链路，断言产出 Message（文本 + 思考块）
//! + 每流恰好一个 Stop + usage 逐字段透传（cached/write/reasoning）。
//!
//! 与既有 `parse_anthropic.rs` 的差异：本文件专注「cached/write/reasoning
//! 拆分是否正确」的验收口径。T3.4（G1-d）落地后：`reasoning_tokens` 由
//! anthropic_map 解析（兼容网关经 `output_tokens_details.reasoning_tokens` 上报时
//! 非 None），本单元 mock 显式上报 reasoning 并断言其透传；
//! 归一化形状（`input = prompt - cached - write`）落在 usage 聚合层
//! （[ProviderUsage::cache_breakdown]，C9 口径），不在本 wire 层改写 prompt。

mod common;

use agent_provider::consume::{consume, ConsumeStopReason};
use agent_provider::events::ProviderStreamEvent;
use agent_provider::parse::anthropic::AnthropicParser;
use common::{MockFrame, MockResponse, MockServer};
use conex_types::response::ProviderOutput;
use serde_json::json;

/// 把读取到的帧序列解析为事件（Anthropic 路径），并返回 Stop 事件个数
fn events_from_output(output: &agent_provider::sse::StreamReadOutput) -> Vec<ProviderStreamEvent> {
    let mut parser = AnthropicParser::new();
    let mut events = Vec::new();
    for frame in &output.frames {
        events.extend(parser.push_frame(frame).expect("帧处理"));
    }
    events.extend(parser.finish().expect("流结束"));
    events
}

/// 统计一条帧序列解析出的 Stop 事件个数（每流应恰好 1 个）
fn stop_count(events: &[ProviderStreamEvent]) -> usize {
    events
        .iter()
        .filter(|event| matches!(event, ProviderStreamEvent::Stop { .. }))
        .count()
}

/// 全流端到端：message_start → content_block_* → message_delta → message_stop
/// 完整事件序列；usage 含 read/write/reasoning 目标形状的现状透传断言。
#[tokio::test(flavor = "multi_thread")]
async fn anthropic_full_stream_usage_pass_through() {
    let server = MockServer::start(|_request| {
        MockResponse::Sse {
            frames: vec![
                // 第 1 帧：message_start（usage 初始分片：input + cache_read + cache_creation/write）
                MockFrame::data(
                    json!({
                        "type": "message_start",
                        "message": {
                            "usage": {
                                "input_tokens": 50,
                                "cache_read_input_tokens": 8,
                                "cache_creation_input_tokens": 4,
                            }
                        },
                    })
                    .to_string(),
                ),
                // 第 2 帧：content_block_start（thinking 块）
                MockFrame::data(
                    json!({
                        "type": "content_block_start",
                        "index": 0,
                        "content_block": { "type": "thinking" },
                    })
                    .to_string(),
                ),
                // 第 3 帧：thinking_delta
                MockFrame::data(
                    json!({
                        "type": "content_block_delta",
                        "index": 0,
                        "delta": { "type": "thinking_delta", "thinking": "深入推理" },
                    })
                    .to_string(),
                ),
                // 第 4 帧：content_block_stop（thinking）
                MockFrame::data(json!({ "type": "content_block_stop", "index": 0 }).to_string()),
                // 第 5 帧：content_block_start（text 块）
                MockFrame::data(
                    json!({
                        "type": "content_block_start",
                        "index": 1,
                        "content_block": { "type": "text" },
                    })
                    .to_string(),
                ),
                // 第 6-7 帧：text_delta 两段
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
                // 第 8 帧：content_block_stop（text）
                MockFrame::data(json!({ "type": "content_block_stop", "index": 1 }).to_string()),
                // 第 9 帧：message_delta（stop_reason + usage 分片补全 output）
                // T3.4（G1-d）：兼容网关经 output_tokens_details.reasoning_tokens
                // 显式上报思考计数（Anthropic 官方 wire 不单列，缺省 None）
                MockFrame::data(
                    json!({
                        "type": "message_delta",
                        "delta": { "stop_reason": "end_turn" },
                        "usage": {
                            "output_tokens": 12,
                            "output_tokens_details": { "reasoning_tokens": 4 },
                        },
                    })
                    .to_string(),
                ),
                // 第 10 帧：message_stop（终态）
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
    // 每流恰好一个 Stop（02 §六.9）
    assert_eq!(stop_count(&events), 1, "anthropic 全流应恰好产生 1 个 Stop");

    let result = consume(events, false);

    // 产出 Message：文本 + 思考块（按解析器语义：thinking_delta → ThoughtDelta）
    assert!(
        result.response.is_message(),
        "应产出 Message，得到 {:?}",
        result.response
    );
    assert_eq!(result.response.text(), "你好，世界");
    assert_eq!(result.metadata["thought"], "深入推理");
    assert_eq!(
        result.metadata["thoughtBlocks"].as_array().unwrap().len(),
        1
    );
    assert_eq!(result.stop_reason(), Some(ConsumeStopReason::Stop));
    assert_eq!(result.metadata["providerFinishReason"], "stop");

    // ── usage 透传断言（T3.4 G1-d：prompt 保持原始 input，cached/write 独立单列，
    //    reasoning 从 completion 侧拆分解析；归一 `input=prompt-cached-write` 由
    //    ProviderUsage::cache_breakdown 在聚合层派生，不在本 wire 层改写 prompt）──
    let usage = &result.metadata["usage"];
    // prompt = input_tokens（Included 归一在聚合层派生，此处保留原始值）
    assert_eq!(usage["promptTokens"], 50);
    assert_eq!(usage["completionTokens"], 12);
    // total 由合并后 prompt+completion 重算（consume 透传 ProviderUsage.total）
    assert_eq!(usage["totalTokens"], 62);
    // cached（read）命中读取透传
    assert_eq!(usage["cacheReadTokens"], 8);
    // write（cache_creation_input_tokens）透传
    assert_eq!(usage["cacheWriteTokens"], 4);
    // T3.4（G1-d）：reasoning 从 completion 侧拆分解析（output_tokens_details.
    // reasoning_tokens），不再恒 None；completion 保留总输出（含思考）
    assert_eq!(
        usage["reasoningTokens"], 4,
        "anthropic 兼容网关上报 reasoning 时应透传（T3.4 G1-d）"
    );
}

/// 合约护栏：Message 响应（ProviderOutput::Message）的字段不变量
/// （本单元新增端到端断言不破坏既有 consume 输出形状）
#[tokio::test(flavor = "multi_thread")]
async fn anthropic_full_stream_produces_message_output() {
    let server = MockServer::start(|_request| MockResponse::Sse {
        frames: vec![
            MockFrame::data(
                json!({
                    "type": "message_start",
                    "message": { "usage": { "input_tokens": 3 } },
                })
                .to_string(),
            ),
            MockFrame::data(
                json!({
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": { "type": "text" },
                })
                .to_string(),
            ),
            MockFrame::data(
                json!({
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": { "type": "text_delta", "text": "hi" },
                })
                .to_string(),
            ),
            MockFrame::data(json!({ "type": "content_block_stop", "index": 0 }).to_string()),
            MockFrame::data(json!({ "type": "message_stop" }).to_string()),
            MockFrame::data("[DONE]"),
        ],
        interrupt_after: None,
    })
    .await;

    let output = common::fetch_sse(
        server.addr,
        "/v1/messages",
        json!({ "model": "claude-test", "messages": [] }),
    )
    .await;
    let events = events_from_output(&output);
    assert_eq!(stop_count(&events), 1);

    let result = consume(events, false);
    let ProviderOutput::Message { text, tool_calls } = &result.response else {
        panic!("应产出 Message，得到 {:?}", result.response);
    };
    assert_eq!(text, "hi");
    assert!(tool_calls.is_empty(), "本流无工具调用");
    // usage 透传：input → promptTokens，total 重算
    assert_eq!(result.metadata["usage"]["promptTokens"], 3);
    assert_eq!(result.metadata["usage"]["totalTokens"], 3);
}
