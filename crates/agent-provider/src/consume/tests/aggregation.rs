use super::{message, stop, stop_with, text_delta, thought_delta, tool_call};
use crate::consume::{consume, ConsumeStopReason};
use crate::events::{ProviderStreamEvent, ProviderUsage, StopReason};
use conex_types::error::ProviderErrorKind;
use conex_types::response::ProviderOutput;
use conex_types::tool::{ProviderDiagnostic, ProviderDiagnosticPhase};

/// thought 聚合：metadata.thought 为聚合全文，thoughtBlocks 逐段保留 redacted（02 §一.4）
#[test]
fn thought_aggregation_preserves_redacted() {
    let result = consume(
        vec![
            thought_delta("思考一", None),
            thought_delta("思考二", Some(true)),
            text_delta("正文"),
            stop(StopReason::Stop),
        ],
        false,
    );
    assert_eq!(result.response.text(), "正文");
    assert_eq!(result.metadata["thought"], "思考一思考二");
    let blocks = result.metadata["thoughtBlocks"].as_array().unwrap();
    assert_eq!(blocks.len(), 2);
    assert!(blocks[0].get("redacted").is_none());
    assert_eq!(blocks[1]["redacted"], true);
    assert_eq!(blocks[1]["text"], "思考二");
}

/// tool-call 收集：id 缺省兜底、入参保留、正文共存
#[test]
fn tool_call_collected_at_stream_end() {
    let result = consume(
        vec![
            tool_call(None, "read_file"),
            text_delta("调用后的话"),
            stop(StopReason::Stop),
        ],
        false,
    );
    let ProviderOutput::Message { text, tool_calls } = message(&result.response) else {
        unreachable!()
    };
    assert_eq!(text, "调用后的话");
    assert_eq!(tool_calls.len(), 1);
    assert_eq!(tool_calls[0].id, "call_0");
    assert_eq!(tool_calls[0].input, serde_json::json!({ "path": "/tmp/a" }));
}

/// 诊断事件必须收集返回（02 §六.12）
#[test]
fn diagnostics_are_collected() {
    let diagnostic = ProviderDiagnostic {
        phase: ProviderDiagnosticPhase::SseFirstByte,
        ..ProviderDiagnostic::default()
    };
    let result = consume(
        vec![
            ProviderStreamEvent::ProviderDiagnostic {
                diagnostic: diagnostic.clone(),
            },
            text_delta("x"),
            stop(StopReason::Stop),
        ],
        false,
    );
    assert_eq!(result.diagnostics, vec![diagnostic]);
}

/// usage 与 providerFinishReason 透传进 metadata（对齐 TS buildMessage）
#[test]
fn usage_and_finish_reason_in_metadata() {
    let usage = ProviderUsage {
        prompt_tokens: Some(10),
        completion_tokens: Some(5),
        ..ProviderUsage::default()
    };
    let result = consume(
        vec![
            text_delta("x"),
            stop_with(StopReason::ToolCall, None, Some(usage)),
        ],
        false,
    );
    assert_eq!(result.stop_reason(), Some(ConsumeStopReason::ToolCall));
    assert_eq!(result.metadata["usage"]["promptTokens"], 10);
    assert_eq!(result.metadata["providerFinishReason"], "tool-call");
    assert_eq!(result.metadata["text"], "x");
}

/// T3.4（G1-d）chat 轨归一口径：`prompt_tokens` 保留原始值（Included，
/// prompt 已含缓存），归一 `input = prompt - cached - write` 由
/// [ProviderUsage::cache_breakdown] 在 usage 聚合层派生收敛（C9 口径）——
/// Included 下 `CacheBreakdown.miss` 即归一 input。reasoning 从 completion 侧
/// 独立解析，completion 保留总输出（含思考）。
#[test]
fn chat_usage_normalized_input_matches_s_b1() {
    // chat 轨 mock usage：prompt 含 cached（Included 口径）
    let usage = ProviderUsage {
        prompt_tokens: Some(100),
        completion_tokens: Some(30),
        total_tokens: Some(130),
        cache_read_tokens: Some(70),
        cache_write_tokens: Some(10),
        reasoning_tokens: Some(12),
        ..ProviderUsage::default()
    };
    let result = consume(
        vec![
            text_delta("你好"),
            stop_with(StopReason::Stop, None, Some(usage.clone())),
        ],
        false,
    );
    assert!(result.response.is_message());
    // 归一口径（Included）：miss = prompt - cached - write = 100 - 70 - 10 = 20
    let breakdown = usage
        .cache_breakdown(crate::events::CacheAccounting::Included)
        .expect("prompt 存在必可派生");
    assert_eq!(breakdown.miss, 20, "归一 input = prompt - cached - write");
    assert_eq!(
        breakdown.input_total, 100,
        "Included：input_total = prompt（不重复计缓存）"
    );
    // 恒等式（C9）：input_total = miss + read + write
    assert_eq!(
        breakdown.miss + breakdown.read + breakdown.write,
        breakdown.input_total
    );
    // 元数据透传原始 usage（promptTokens 保持原始值，不回写归一值——对齐 session-loop）
    assert_eq!(result.metadata["usage"]["promptTokens"], 100);
    assert_eq!(result.metadata["usage"]["reasoningTokens"], 12);
    assert_eq!(
        result.metadata["usage"]["completionTokens"], 30,
        "reasoning 不把 completion 中的思考扣走"
    );
}

/// 纯思考流（无正文）→ Message（不判定为 Empty），metadata 完整保留 thought 与 thoughtBlocks
#[test]
fn pure_thought_stream_yields_message() {
    let result = consume(
        vec![
            thought_delta("深度思考内容片段1", None),
            thought_delta("深度思考内容片段2", Some(true)),
            stop(StopReason::Stop),
        ],
        false,
    );
    assert!(
        result.response.is_message(),
        "纯思考流必须产出 Message，不得被判定为 Empty"
    );
    assert_eq!(result.response.text(), "");
    assert_eq!(result.stop_reason(), Some(ConsumeStopReason::Stop));
    assert_eq!(
        result.metadata["thought"],
        "深度思考内容片段1深度思考内容片段2"
    );
    let blocks = result.metadata["thoughtBlocks"].as_array().unwrap();
    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[0]["text"], "深度思考内容片段1");
    assert!(blocks[0].get("redacted").is_none());
    assert_eq!(blocks[1]["text"], "深度思考内容片段2");
    assert_eq!(blocks[1]["redacted"], true);
}

/// abort 发生在纯思考流中 → 保留思考内容，stopReason=aborted（partial salvage）
#[test]
fn abort_with_only_thought_keeps_partial_message() {
    let result = consume(vec![thought_delta("流中被 abort 的思考片段", None)], true);
    assert!(
        result.response.is_message(),
        "仅有思考内容时 abort 必须保留为 Message"
    );
    assert_eq!(result.response.text(), "");
    assert_eq!(result.stop_reason(), Some(ConsumeStopReason::Aborted));
    assert_eq!(result.metadata["aborted"], true);
    assert_eq!(result.metadata["thought"], "流中被 abort 的思考片段");
}

/// 纯思考流 + error stop → Message，错误降级为 metadata 标注，思考内容不丢
#[test]
fn thought_with_error_stop_yields_message() {
    let result = consume(
        vec![
            thought_delta("思考到一半发生错误", None),
            stop_with(StopReason::Error, Some("网络异常中断"), None),
        ],
        false,
    );
    assert!(
        result.response.is_message(),
        "有思考内容且发生 error stop 时必须产出 Message"
    );
    assert_eq!(result.metadata["thought"], "思考到一半发生错误");
    assert_eq!(result.metadata["providerError"], "网络异常中断");
}

/// F3-05（红→绿）：正文聚合无界内存——文本 delta 累计超过聚合上限
/// （64 MiB，与 [MAX_AGGREGATE_TEXT_BYTES] 对齐）时显式错误收场
/// （StreamError，不静默截断也不无界增长；修复前全量聚合为 Message，红）
#[test]
fn aggregate_text_over_cap_yields_explicit_stream_error() {
    let chunk = "a".repeat(1024 * 1024);
    // 65 MiB > 64 MiB 上限（字面量构造，红阶段不依赖尚未实现的常量）
    let events = (0..65).map(|_| text_delta(&chunk)).collect::<Vec<_>>();
    let result = consume(events, false);
    let ProviderOutput::StreamError { classified } = &result.response else {
        panic!("超限应显式错误收场，得到 {:?}", result.response);
    };
    assert_eq!(classified.kind, ProviderErrorKind::Unknown);
    assert!(!classified.retryable, "聚合超限不可重试");
    assert!(
        classified.message.contains("聚合正文"),
        "错误文案应说明聚合上限：{}",
        classified.message
    );
}

/// F3-05 边界锚定：聚合在上限内（63 MiB < 64 MiB）仍正常产出 Message
/// （上限不误伤合法输出）
#[test]
fn aggregate_text_at_cap_still_yields_message() {
    let chunk = "a".repeat(1024 * 1024);
    let events = (0..63)
        .map(|_| text_delta(&chunk))
        .chain(std::iter::once(stop(StopReason::Stop)))
        .collect::<Vec<_>>();
    let result = consume(events, false);
    assert!(result.response.is_message(), "未超上限必须正常产出 Message");
    assert_eq!(result.response.text().len(), 63 * chunk.len());
}

/// stopReason wire 取值与解析
#[test]
fn stop_reason_wire_values() {
    assert_eq!(ConsumeStopReason::Stop.as_str(), "stop");
    assert_eq!(ConsumeStopReason::ToolCall.as_str(), "tool-call");
    assert_eq!(ConsumeStopReason::Length.as_str(), "length");
    assert_eq!(ConsumeStopReason::Aborted.as_str(), "aborted");
    assert_eq!(
        "aborted".parse::<ConsumeStopReason>(),
        Ok(ConsumeStopReason::Aborted)
    );
    // error 不再作为 Message 的 stopReason（01 D6），故不参与取值域
    assert!("error".parse::<ConsumeStopReason>().is_err());
    assert!("nope".parse::<ConsumeStopReason>().is_err());
}

/// abort 有内容且流中有 error → 部分保留同时带 providerError 标注
#[test]
fn abort_with_content_keeps_provider_error_annotation() {
    let result = consume(
        vec![
            text_delta("部分"),
            stop_with(StopReason::Error, Some("boom"), None),
        ],
        true,
    );
    assert_eq!(result.response.text(), "部分");
    assert_eq!(result.stop_reason(), Some(ConsumeStopReason::Aborted));
    assert_eq!(result.metadata["aborted"], true);
    assert_eq!(result.metadata["providerError"], "boom");
}
