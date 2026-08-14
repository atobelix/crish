//! T2.5 · Gemini 全流式端到端（MockServer 基座）
//!
//! 战役 `docs/provider-adapter-campaign/` · 轮次 2 · 单元 T2.5（I1/M2）
//! 补齐 I1 不变式「四协议 mock 端到端断言各一」的 gemini 流式缺口：
//! mock 复刻 `candidates[].content.parts[]` + `usageMetadata` 全流
//! （SSE `data:` 分块流，对齐 `src/parse/gemini.rs` 帧语义——usageMetadata
//! 为累计值逐帧合并），走 transport → parse → consume 全链路；断言产出
//! Message（文本 + 思考块）+ 每流恰好一个 Stop + usage 逐字段透传
//! （cached/reasoning）。
//!
//! 验收口径：T3.4（G1-d）落地后，usage 归一化形状（`input = prompt - cached -
//! write`、reasoning 从 completion 拆分）在 usage 聚合层派生（C9 口径）；本单元
//! mock 显式上报 cache-write（兼容网关经 `cache.writeTokenCount`/camel 别名）并
//! 断言其透传。真实 Gemini 官方 wire 无独立写缓存计数，缺省保持 None。

mod common;

use agent_provider::consume::{consume, ConsumeStopReason};
use agent_provider::events::ProviderStreamEvent;
use agent_provider::parse::gemini::GeminiParser;
use common::{MockFrame, MockResponse, MockServer};
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

/// 统计一条帧序列解析出的 Stop 事件个数（每流应恰好 1 个）
fn stop_count(events: &[ProviderStreamEvent]) -> usize {
    events
        .iter()
        .filter(|event| matches!(event, ProviderStreamEvent::Stop { .. }))
        .count()
}

/// 全流端到端：thought part + text part + usageMetadata（累计值逐帧合并）
/// 覆盖 cached/reasoning 目标形状的现状透传断言。
#[tokio::test(flavor = "multi_thread")]
async fn gemini_full_stream_usage_pass_through() {
    let server = MockServer::start(|_request| {
        MockResponse::Sse {
            frames: vec![
                // 帧 1：思考部分 + usageMetadata（cached + reasoning + cache-write 累计值）
                // T3.4（G1-d）：兼容网关经 camel 别名 cacheWriteTokenCount 上报写缓存
                MockFrame::data(
                    json!({
                        "candidates": [{ "content": { "parts": [{ "text": "推理中", "thought": true }] } }],
                        "usageMetadata": {
                            "promptTokenCount": 40,
                            "cachedContentTokenCount": 6,
                            "cacheWriteTokenCount": 4,
                            "thoughtsTokenCount": 15,
                        },
                    })
                    .to_string(),
                ),
                // 帧 2：正文第一段（completion 未到，后续帧补全）
                MockFrame::data(
                    json!({
                        "candidates": [{ "content": { "parts": [{ "text": "你好" }] } }],
                    })
                    .to_string(),
                ),
                // 帧 3：正文第二段 + finishReason=STOP + usageMetadata 补 completion
                MockFrame::data(
                    json!({
                        "candidates": [{
                            "content": { "parts": [{ "text": "，世界" }] },
                            "finishReason": "STOP",
                        }],
                        "usageMetadata": {
                            "promptTokenCount": 40,
                            "candidatesTokenCount": 9,
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
        "/v1beta/models/test-model:streamGenerateContent",
        json!({ "contents": [{ "role": "user", "parts": [{ "text": "你好" }] }] }),
    )
    .await;

    let events = events_from_output(&output);
    // 每流恰好一个 Stop（02 §六.9）
    assert_eq!(stop_count(&events), 1, "gemini 全流应恰好产生 1 个 Stop");

    let result = consume(events, false);

    // 产出 Message：文本 + 思考块（thought=true part → ThoughtDelta）
    assert!(
        result.response.is_message(),
        "应产出 Message，得到 {:?}",
        result.response
    );
    assert_eq!(result.response.text(), "你好，世界");
    assert_eq!(result.metadata["thought"], "推理中");
    assert_eq!(
        result.metadata["thoughtBlocks"].as_array().unwrap().len(),
        1
    );
    assert_eq!(result.stop_reason(), Some(ConsumeStopReason::Stop));
    assert_eq!(result.metadata["providerFinishReason"], "stop");

    // ── usage 透传断言（T3.4 G1-d：prompt 保留原始 promptTokenCount，cached/write
    //    独立单列，reasoning 独立解析；归一 `input=prompt-cached-write` 由
    //    ProviderUsage::cache_breakdown 在聚合层派生）──
    let usage = &result.metadata["usage"];
    // prompt = promptTokenCount（Excluded 归一在聚合层派生，此处保留原始值）
    assert_eq!(usage["promptTokens"], 40);
    assert_eq!(usage["completionTokens"], 9);
    // total 重算（40+9=49；merge_usage_shards 恒由合并结果重算）
    assert_eq!(usage["totalTokens"], 49);
    // cached（cachedContentTokenCount）透传
    assert_eq!(usage["cacheReadTokens"], 6);
    // reasoning（thoughtsTokenCount）透传
    assert_eq!(usage["reasoningTokens"], 15);
    // T3.4（G1-d）：cache-write 不再恒 None——兼容网关经 camel 别名
    // cacheWriteTokenCount 上报时透传；真实 Gemini 官方 wire 无独立写缓存计数，缺省 None
    assert_eq!(
        usage["cacheWriteTokens"], 4,
        "gemini 兼容网关上报 cache-write 时应透传（T3.4 G1-d）"
    );
}

/// 合约护栏：无工具调用、finishReason=STOP 纯文本流 → Message + 唯一 Stop
#[tokio::test(flavor = "multi_thread")]
async fn gemini_full_stream_pure_text_message() {
    let server = MockServer::start(|_request| MockResponse::Sse {
        frames: vec![
            MockFrame::data(
                json!({
                    "candidates": [{ "content": { "parts": [{ "text": "hi" }] }, "finishReason": "STOP" }],
                    "usageMetadata": { "promptTokenCount": 5 },
                })
                .to_string(),
            ),
            MockFrame::data("[DONE]"),
        ],
        interrupt_after: None,
    })
    .await;

    let output = common::fetch_sse(
        server.addr,
        "/v1beta/models/test-model:streamGenerateContent",
        json!({ "contents": [] }),
    )
    .await;
    let events = events_from_output(&output);
    assert_eq!(stop_count(&events), 1, "gemini 流应恰好产生 1 个 Stop");

    let result = consume(events, false);
    let ProviderOutput::Message { text, tool_calls } = &result.response else {
        panic!("应产出 Message，得到 {:?}", result.response);
    };
    assert_eq!(text, "hi");
    assert!(tool_calls.is_empty(), "纯文本流无工具调用");
    assert_eq!(result.stop_reason(), Some(ConsumeStopReason::Stop));
    assert_eq!(result.metadata["usage"]["promptTokens"], 5);
}
