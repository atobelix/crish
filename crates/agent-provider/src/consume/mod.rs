//! 消费契约层（任务书 B2.8；02-provider-semantics.md §一.3、§五.12、§六.12；
//! 01-session-loop-semantics.md §2.4 步骤 5、§五.3）
//!
//! 对齐 TS 端 `core:runtime-components/provider-response-consumer.ts` 的消费聚合语义，
//! 并按 00 D5 / 01 D6 裁决取消「error 一票否决」：
//!
//! - [consume]：ProviderStreamEvent 序列 → [ConsumeResult]（ProviderOutput 分类 +
//!   diagnostics 透出 + metadata 标注）；
//! - text-delta 聚合为 text；thought-delta 聚合为 thought（redacted 逐段保留，
//!   产出 thought block 序列 + metadata.thought 聚合全文，02 §一.4）；
//! - tool-call 收集：低级契约的 tool-call 已是完整调用一次性产出（02 §六.9），
//!   等价于合同级 phase='end' 的事件——仅 end 阶段的 tool-call 收集（02 §一.3：86-99）；
//! - stopReason 生成（01 D6 裁决）：有文字/tool-call → 正常 Message，error 不作为
//!   stopReason 一票否决，降级为 metadata.providerError 标注；无内容且 error →
//!   StreamError{classified}；空响应 → Empty（02 §一.3：131-132）；
//! - abort 信号（finishAfterAbort 等价，02 §一.3：144-174）：仍完成聚合（flush 已收集
//!   内容），有内容时保留部分并标 stopReason=aborted，无内容时产出 StreamError；
//! - stop.reason=length → Message + metadata.stopReason=length（供上层 length 恢复阶梯，
//!   01 §2.6 步骤 1）。

use conex_types::error::ProviderErrorKind;
use conex_types::message::ToolCallBlock;
use conex_types::response::{ClassifiedStreamError, ProviderOutput};
use conex_types::tool::ProviderDiagnostic;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::events::{ProviderStreamEvent, ProviderUsage, StopReason};

/// 消费终止原因（metadata.stopReason 的取值域）
///
/// 01 D6 裁决下 Message 永不携带 error 类的 stopReason：有文字/tool-call 即正常
/// 产出，错误只作为 metadata 标注（providerError）或 diagnostics 呈现。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConsumeStopReason {
    /// 正常结束
    Stop,
    /// 工具调用收尾
    ToolCall,
    /// 长度截断（上层 length 恢复阶梯的输入，01 §2.6 步骤 1）
    Length,
    /// 流中途 abort（部分内容保留，01 §2.4 步骤 5 的 partial salvage 路径）
    Aborted,
}

impl ConsumeStopReason {
    /// wire 取值（对齐 TS 端 stopReason 字符串）
    pub const fn as_str(self) -> &'static str {
        match self {
            ConsumeStopReason::Stop => "stop",
            ConsumeStopReason::ToolCall => "tool-call",
            ConsumeStopReason::Length => "length",
            ConsumeStopReason::Aborted => "aborted",
        }
    }
}

impl std::str::FromStr for ConsumeStopReason {
    type Err = ();

    /// 解析 wire 取值（未识别返回 Err）
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "stop" => Ok(ConsumeStopReason::Stop),
            "tool-call" => Ok(ConsumeStopReason::ToolCall),
            "length" => Ok(ConsumeStopReason::Length),
            "aborted" => Ok(ConsumeStopReason::Aborted),
            _ => Err(()),
        }
    }
}

/// 消费结果（对齐 provider-response-consumer.ts:16-20 的 ConsumeResult）
///
/// - `response`：02 §五.12 裁决后的分类产物（Message / Empty / StreamError）；
/// - `diagnostics`：流期间收集的 provider-diagnostic，供上层 emit 事件（02 §六.12）；
/// - `metadata`：消息元数据标注（对齐 TS buildMessage 的 message.metadata，
///   provider-response-consumer.ts:195-203）。ProviderOutput::Message 仅承载
///   text/tool_calls，stopReason / providerError / thought 聚合 / usage 等标注
///   由本字段透出（01 §2.4 步骤 5 的响应分类枢纽依赖 stopReason）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumeResult {
    /// 分类后的响应（Message / Empty / StreamError）
    pub response: ProviderOutput,
    /// 流期间收集的诊断
    pub diagnostics: Vec<ProviderDiagnostic>,
    /// 消息元数据标注（非 Message 响应为 Null）
    pub metadata: Value,
}

impl ConsumeResult {
    /// 读取 metadata.stopReason（非 Message 响应或无标注返回 None）
    pub fn stop_reason(&self) -> Option<ConsumeStopReason> {
        let value = self.metadata.get("stopReason")?.as_str()?;
        value.parse().ok()
    }
}

/// 思考块（metadata.thoughtBlocks 的元素，redacted 透传，02 §一.4）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ThoughtBlock {
    text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    redacted: Option<bool>,
}

/// 聚合中间态（对齐 TS consume 内 textBuffer / thoughtBuffer / error / usage /
/// finishReasonFromStream，provider-response-consumer.ts:37-41）
#[derive(Debug, Default)]
struct Aggregate {
    /// 正文聚合
    text: String,
    /// 思考聚合
    thought: String,
    /// 逐段思考块（各带自己的 redacted 标记，对齐 TS blocks.push(thought)）
    thought_blocks: Vec<ThoughtBlock>,
    /// 工具调用（全部为 end 阶段完整调用，02 §六.9）
    tool_calls: Vec<ToolCallBlock>,
    /// 流期间收集的诊断
    diagnostics: Vec<ProviderDiagnostic>,
    /// 错误文案（stop.reason=error 携带，对齐 TS error / end.error 记录，02 §一.3：102-116）
    error: Option<String>,
    /// stop 携带的用量
    usage: Option<ProviderUsage>,
    /// 终止事件的原因（每流恰好一个，02 §六.9）
    finish_reason: Option<StopReason>,
}

/// 正文/思考聚合单流上限（F3-05）：慢速但持续发送的流使 text/thought 无界
/// 增长（idle 超时兜不住「数据缓慢不停」）；超过上限显式错误收场——
/// 不静默截断（丢内容不可感知）也不无界驻留（OOM 面）。64 MiB 远高于
/// 任何正常模型输出（上层输出预算另有 output_budget_bytes 处理）。
pub const MAX_AGGREGATE_TEXT_BYTES: usize = 64 * 1024 * 1024;

impl Aggregate {
    /// 聚合单个事件（事件序列合法性已由 events::StreamParser 保证）
    ///
    /// 返回 true = 聚合正文/思考超过 [MAX_AGGREGATE_TEXT_BYTES]（调用方
    /// 必须立即以显式 StreamError 收场，不得继续聚合）。
    fn push(&mut self, event: ProviderStreamEvent) -> bool {
        match event {
            ProviderStreamEvent::TextDelta { text } => {
                self.text.push_str(&text);
            }
            ProviderStreamEvent::ThoughtDelta { text, redacted } => {
                self.thought.push_str(&text);
                self.thought_blocks.push(ThoughtBlock { text, redacted });
            }
            ProviderStreamEvent::ToolCall { id, tool_name, input } => {
                // 低级契约的 tool-call 即完整调用（02 §六.9），对应合同级 phase='end'，
                // 满足「仅 phase=end 的 tool-call 收集」（02 §一.3：86-99）
                self.tool_calls.push(ToolCallBlock {
                    id: id.unwrap_or_else(|| format!("call_{}", self.tool_calls.len())),
                    tool_name,
                    input,
                });
            }
            ProviderStreamEvent::ProviderDiagnostic { diagnostic } => {
                self.diagnostics.push(diagnostic);
            }
            // M14：model 请求生命周期观测事件（before-request / after-response）
            // 不参与聚合——消费面在 I8 钩子桥（model.beforeRequest / afterResponse）
            ProviderStreamEvent::BeforeRequest { .. }
            | ProviderStreamEvent::AfterResponse { .. } => {}
            ProviderStreamEvent::Stop { reason, error, usage } => {
                self.finish_reason = Some(reason);
                if reason == StopReason::Error {
                    // error stop 即「流中曾有 error」（02 §一.3：102-116）
                    self.error =
                        Some(error.unwrap_or_else(|| "provider 流异常终止".to_string()));
                }
                if let Some(usage) = usage {
                    self.usage = Some(usage);
                }
            }
        }
        // F3-05：正文/思考任一超限即标记（不静默截断）
        self.text.len() > MAX_AGGREGATE_TEXT_BYTES
            || self.thought.len() > MAX_AGGREGATE_TEXT_BYTES
    }
}

/// 消费一条流的全部事件（任务书 B2.8；02 §一.3、§五.12）
///
/// - `aborted`：流中途收到 abort 信号（L3 force_cancel / AbortSignal）。仍完成聚合
///   （flush 已收集内容）：有内容时保留部分并标 stopReason=aborted（finishAfterAbort
///   等价，02 §一.3：144-174）；无内容时产出 StreamError（Aborted 类，不可重试）。
/// - 事件序列合法性由 events::StreamParser 保证（每流至多一个 stop、stop 之后无事件，
///   02 §六.9），本层不再重复校验。
pub fn consume<I>(events: I, aborted: bool) -> ConsumeResult
where
    I: IntoIterator<Item = ProviderStreamEvent>,
{
    let mut aggregate = Aggregate::default();
    for event in events {
        // F3-05：聚合超限 → 立即显式错误收场（不静默截断、不无界驻留）
        if aggregate.push(event) {
            return aggregate_overflow_result(aggregate);
        }
    }
    finish(aggregate, aborted)
}

/// F3-05：正文/思考聚合超过 [MAX_AGGREGATE_TEXT_BYTES] 的显式收场——
/// StreamError（Unknown 类不可重试；错误文案含上限便于排障），
/// 已收集诊断仍透出
fn aggregate_overflow_result(aggregate: Aggregate) -> ConsumeResult {
    ConsumeResult {
        response: ProviderOutput::stream_error(ClassifiedStreamError {
            kind: ProviderErrorKind::Unknown,
            message: format!(
                "流聚合正文超过上限（{} 字节），拒绝无界增长",
                MAX_AGGREGATE_TEXT_BYTES
            ),
            retryable: false,
            retry_after_ms: None,
        }),
        diagnostics: aggregate.diagnostics,
        metadata: Value::Null,
    }
}

/// 终止聚合：按 01 D6 裁决生成 stopReason 并分类响应
fn finish(aggregate: Aggregate, aborted: bool) -> ConsumeResult {
    // abort 路径：finishAfterAbort 等价（02 §一.3：144-174），优先判定
    if aborted {
        return finish_after_abort(aggregate);
    }
    let has_content = !aggregate.text.is_empty() || !aggregate.tool_calls.is_empty();
    // 空响应：无 block 且无 error → Empty（02 §一.3：131-132；01 §五.3）
    if !has_content && aggregate.error.is_none() {
        return ConsumeResult {
            response: ProviderOutput::Empty,
            diagnostics: aggregate.diagnostics,
            metadata: Value::Null,
        };
    }
    // 无内容且 error → StreamError：仅「无文字且无 tool-call 且 stopReason=error」
    // 归入错误路径（01 §五.3 / 01 D6），进入上层分类重试阶梯
    if !has_content {
        let message = aggregate.error.unwrap_or_default();
        return ConsumeResult {
            response: ProviderOutput::stream_error(classify_stream_error(&message)),
            diagnostics: aggregate.diagnostics,
            metadata: Value::Null,
        };
    }
    // 有文字或 tool-call → Message（正常产出，纯文字永不失败）：error 不作为
    // stopReason 一票否决，降级为 metadata.providerError 标注（02 §五.12 / 01 D6）
    let stop_reason = if !aggregate.tool_calls.is_empty() {
        ConsumeStopReason::ToolCall
    } else {
        match aggregate.finish_reason {
            // stop.reason=length → stopReason=length（供上层 length 恢复阶梯，01 §2.6）
            Some(StopReason::Length) => ConsumeStopReason::Length,
            // 对齐 TS 的 finishReason 透传（tool-call 收尾但零捕获时为 RU-09 诊断场景）
            Some(StopReason::ToolCall) => ConsumeStopReason::ToolCall,
            // stop.reason=error 且有内容：错误已降级为标注，stopReason 取正常值（01 D6）
            _ => ConsumeStopReason::Stop,
        }
    };
    // 先借引用构建元数据，再整体移动字段（避免部分移动后借用）
    let metadata = build_message_metadata(&aggregate, stop_reason, false);
    ConsumeResult {
        response: ProviderOutput::message(aggregate.text.clone(), aggregate.tool_calls.clone()),
        diagnostics: aggregate.diagnostics,
        metadata,
    }
}

/// abort 时完成聚合（finishAfterAbort 等价，02 §一.3：144-174）
///
/// 有内容 → 保留部分内容，stopReason=aborted、aborted=true 标注；无内容 → StreamError
/// （Aborted 类，不可重试；对齐 02 §4.2 第 1 行 abort 直接传播语义）。
fn finish_after_abort(aggregate: Aggregate) -> ConsumeResult {
    let has_content = !aggregate.text.is_empty() || !aggregate.tool_calls.is_empty();
    if !has_content {
        let message = aggregate.error.unwrap_or_else(|| "aborted".to_string());
        return ConsumeResult {
            response: ProviderOutput::stream_error(ClassifiedStreamError {
                kind: ProviderErrorKind::Aborted,
                message,
                retryable: false,
                retry_after_ms: None,
            }),
            diagnostics: aggregate.diagnostics,
            metadata: Value::Null,
        };
    }
    // 先借引用构建元数据，再整体移动字段（避免部分移动后借用）
    let metadata = build_message_metadata(&aggregate, ConsumeStopReason::Aborted, true);
    ConsumeResult {
        response: ProviderOutput::message(aggregate.text.clone(), aggregate.tool_calls.clone()),
        diagnostics: aggregate.diagnostics,
        metadata,
    }
}

/// 构建消息元数据（对齐 TS buildMessage 的 metadata 对象，
/// provider-response-consumer.ts:195-203）
///
/// 键名：stopReason / text / thought / thoughtBlocks / usage / providerFinishReason /
/// providerError / aborted。error 在此作为标注出现，不参与 stopReason 判定（01 D6）。
fn build_message_metadata(
    aggregate: &Aggregate,
    stop_reason: ConsumeStopReason,
    aborted: bool,
) -> Value {
    let mut metadata = serde_json::Map::new();
    metadata.insert(
        "stopReason".to_string(),
        Value::String(stop_reason.as_str().to_string()),
    );
    metadata.insert("text".to_string(), Value::String(aggregate.text.clone()));
    if !aggregate.thought.is_empty() {
        metadata.insert("thought".to_string(), Value::String(aggregate.thought.clone()));
    }
    if !aggregate.thought_blocks.is_empty() {
        metadata.insert(
            "thoughtBlocks".to_string(),
            serde_json::to_value(&aggregate.thought_blocks).unwrap_or_default(),
        );
    }
    if let Some(usage) = &aggregate.usage {
        metadata.insert(
            "usage".to_string(),
            serde_json::to_value(usage).unwrap_or_default(),
        );
    }
    if let Some(reason) = aggregate.finish_reason {
        metadata.insert(
            "providerFinishReason".to_string(),
            Value::String(finish_reason_str(reason).to_string()),
        );
    }
    if let Some(error) = &aggregate.error {
        metadata.insert("providerError".to_string(), Value::String(error.clone()));
    }
    if aborted {
        metadata.insert("aborted".to_string(), Value::Bool(true));
    }
    Value::Object(metadata)
}

/// 终止事件原因 → wire 文案（providerFinishReason 标注，对齐 TS 的 finishReason）
fn finish_reason_str(reason: StopReason) -> &'static str {
    match reason {
        StopReason::Stop => "stop",
        StopReason::ToolCall => "tool-call",
        StopReason::Length => "length",
        StopReason::Error => "error",
    }
}

/// 流错误兜底分类（B2.7 分类管线接入前的最小实现）
///
/// 输入为解析层 error stop 的原始文案（02 §六.9：空流保护、服务端错误帧等）；
/// 传输/HTTP 层错误由 retry::provider_stream 上抛、不经本层。此处恒按
/// 02 §4.2 第 13 行兜底 Unknown（不可重试）；abort 路径单独归 Aborted 类。
fn classify_stream_error(message: &str) -> ClassifiedStreamError {
    ClassifiedStreamError {
        kind: ProviderErrorKind::Unknown,
        message: message.to_string(),
        retryable: false,
        retry_after_ms: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_types::tool::ProviderDiagnosticPhase;

    fn text_delta(text: &str) -> ProviderStreamEvent {
        ProviderStreamEvent::TextDelta {
            text: text.to_string(),
        }
    }

    fn thought_delta(text: &str, redacted: Option<bool>) -> ProviderStreamEvent {
        ProviderStreamEvent::ThoughtDelta {
            text: text.to_string(),
            redacted,
        }
    }

    fn tool_call(id: Option<&str>, name: &str) -> ProviderStreamEvent {
        ProviderStreamEvent::ToolCall {
            id: id.map(str::to_string),
            tool_name: name.to_string(),
            input: serde_json::json!({ "path": "/tmp/a" }),
        }
    }

    fn stop(reason: StopReason) -> ProviderStreamEvent {
        stop_with(reason, None, None)
    }

    fn stop_with(
        reason: StopReason,
        error: Option<&str>,
        usage: Option<ProviderUsage>,
    ) -> ProviderStreamEvent {
        ProviderStreamEvent::Stop {
            reason,
            error: error.map(str::to_string),
            usage,
        }
    }

    fn message(response: &ProviderOutput) -> &ProviderOutput {
        assert!(response.is_message(), "应为 Message，得到 {response:?}");
        response
    }

    // ── D5/D6 裁决路径 ──

    /// 文字 + error stop → Message（不失败）；error 降级为 metadata 标注，stopReason 不为 error
    #[test]
    fn text_then_error_stop_yields_message() {
        let result = consume(
            vec![text_delta("你好"), stop_with(StopReason::Error, Some("boom"), None)],
            false,
        );
        assert_eq!(result.response, ProviderOutput::message("你好", vec![]));
        assert_eq!(result.stop_reason(), Some(ConsumeStopReason::Stop));
        assert_eq!(result.metadata["providerError"], "boom");
        assert_eq!(result.metadata["providerFinishReason"], "error");
    }

    /// tool-call + error stop → Message；stopReason=tool-call，错误仅标注
    #[test]
    fn tool_call_then_error_stop_yields_message() {
        let result = consume(
            vec![
                tool_call(Some("call_1"), "read_file"),
                stop_with(StopReason::Error, Some("boom"), None),
            ],
            false,
        );
        let ProviderOutput::Message { text, tool_calls } = message(&result.response) else {
            unreachable!()
        };
        assert_eq!(text, "");
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(tool_calls[0].id, "call_1");
        assert_eq!(tool_calls[0].tool_name, "read_file");
        assert_eq!(result.stop_reason(), Some(ConsumeStopReason::ToolCall));
        assert_eq!(result.metadata["providerError"], "boom");
    }

    /// 纯 error 无内容 → StreamError（Unknown 类，不可重试）
    #[test]
    fn pure_error_stop_yields_stream_error() {
        let result = consume(
            vec![stop_with(StopReason::Error, Some("服务端错误"), None)],
            false,
        );
        let ProviderOutput::StreamError { classified } = &result.response else {
            panic!("应为 StreamError，得到 {:?}", result.response);
        };
        assert_eq!(classified.kind, ProviderErrorKind::Unknown);
        assert!(!classified.retryable);
        assert_eq!(classified.message, "服务端错误");
        assert!(result.stop_reason().is_none());
    }

    /// abort 有内容 → 保留部分，stopReason=aborted（partial salvage）
    #[test]
    fn abort_with_content_keeps_partial_message() {
        let result = consume(vec![text_delta("已流出的部分")], true);
        assert_eq!(result.response, ProviderOutput::message("已流出的部分", vec![]));
        assert_eq!(result.stop_reason(), Some(ConsumeStopReason::Aborted));
        assert_eq!(result.metadata["aborted"], true);
    }

    /// abort 无内容 → StreamError（Aborted 类，不可重试）
    #[test]
    fn abort_without_content_yields_stream_error() {
        let result = consume(Vec::<ProviderStreamEvent>::new(), true);
        let ProviderOutput::StreamError { classified } = &result.response else {
            panic!("应为 StreamError，得到 {:?}", result.response);
        };
        assert_eq!(classified.kind, ProviderErrorKind::Aborted);
        assert!(!classified.retryable);
        assert_eq!(classified.message, "aborted");
    }

    /// abort 无内容且流中有 error 文案 → StreamError 携带该文案
    #[test]
    fn abort_without_content_uses_collected_error_message() {
        let result = consume(vec![stop_with(StopReason::Error, Some("boom"), None)], true);
        let ProviderOutput::StreamError { classified } = &result.response else {
            panic!("应为 StreamError，得到 {:?}", result.response);
        };
        assert_eq!(classified.kind, ProviderErrorKind::Aborted);
        assert_eq!(classified.message, "boom");
    }

    // ── 空响应 / length ──

    /// 空流（无任何事件）→ Empty（02 §一.3）
    #[test]
    fn empty_stream_yields_empty() {
        let result = consume(Vec::<ProviderStreamEvent>::new(), false);
        assert_eq!(result.response, ProviderOutput::Empty);
        assert!(result.diagnostics.is_empty());
    }

    /// 有 stop 但无 block 无 error → 仍为空响应
    #[test]
    fn stop_without_content_yields_empty() {
        let result = consume(vec![stop(StopReason::Stop)], false);
        assert_eq!(result.response, ProviderOutput::Empty);
    }

    /// stop.reason=length → Message + stopReason=length（供上层 length 恢复阶梯）
    #[test]
    fn length_stop_yields_message_with_length() {
        let result = consume(vec![text_delta("长回复"), stop(StopReason::Length)], false);
        assert_eq!(result.response, ProviderOutput::message("长回复", vec![]));
        assert_eq!(result.stop_reason(), Some(ConsumeStopReason::Length));
        assert_eq!(result.metadata["providerFinishReason"], "length");
    }

    /// 有 tool-call 时 stopReason=tool-call 优先于 length（对齐 TS 优先级）
    #[test]
    fn tool_call_wins_over_length_stop() {
        let result = consume(
            vec![tool_call(Some("c1"), "read_file"), stop(StopReason::Length)],
            false,
        );
        assert_eq!(result.stop_reason(), Some(ConsumeStopReason::ToolCall));
    }

    // ── 聚合语义 ──

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
            vec![text_delta("x"), stop_with(StopReason::ToolCall, None, Some(usage))],
            false,
        );
        assert_eq!(result.stop_reason(), Some(ConsumeStopReason::ToolCall));
        assert_eq!(result.metadata["usage"]["promptTokens"], 10);
        assert_eq!(result.metadata["providerFinishReason"], "tool-call");
        assert_eq!(result.metadata["text"], "x");
    }

    /// abort 有内容且流中有 error → 部分保留同时带 providerError 标注
    #[test]
    fn abort_with_content_keeps_provider_error_annotation() {
        let result = consume(
            vec![text_delta("部分"), stop_with(StopReason::Error, Some("boom"), None)],
            true,
        );
        assert_eq!(result.response.text(), "部分");
        assert_eq!(result.stop_reason(), Some(ConsumeStopReason::Aborted));
        assert_eq!(result.metadata["aborted"], true);
        assert_eq!(result.metadata["providerError"], "boom");
    }

    /// F3-05（红→绿）：正文聚合无界内存——文本 delta 累计超过聚合上限
    /// （64 MiB，与 [MAX_AGGREGATE_TEXT_BYTES] 对齐）时显式错误收场
    /// （StreamError，不静默截断也不无界增长；修复前全量聚合为 Message，红）
    #[test]
    fn aggregate_text_over_cap_yields_explicit_stream_error() {
        let chunk = "a".repeat(1024 * 1024);
        // 65 MiB > 64 MiB 上限（字面量构造，红阶段不依赖尚未实现的常量）
        let events = (0..65)
            .map(|_| text_delta(&chunk))
            .collect::<Vec<_>>();
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
        assert!(
            result.response.is_message(),
            "未超上限必须正常产出 Message"
        );
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
}
