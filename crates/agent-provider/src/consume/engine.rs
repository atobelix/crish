use conex_types::error::ProviderErrorKind;
use conex_types::response::{ClassifiedStreamError, ProviderOutput};
use serde_json::Value;

use super::aggregate::{Aggregate, MAX_AGGREGATE_TEXT_BYTES};
use super::types::{ConsumeResult, ConsumeStopReason};
use crate::events::{ProviderStreamEvent, StopReason};

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
    let has_content = !aggregate.text.is_empty()
        || !aggregate.tool_calls.is_empty()
        || !aggregate.thought.is_empty()
        || !aggregate.thought_blocks.is_empty();
    // 空响应：无 block 且无 error → Empty（02 §一.3：131-132；01 §五.3）
    if !has_content && aggregate.error.is_none() {
        return ConsumeResult {
            response: ProviderOutput::Empty,
            diagnostics: aggregate.diagnostics,
            metadata: Value::Null,
        };
    }
    // 无内容且 error → StreamError：仅「无文字且无 tool-call 且无思考且 stopReason=error」
    // 归入错误路径（01 §五.3 / 01 D6），进入上层分类重试阶梯
    if !has_content {
        // G1-c：沿用 Stop 构造点携带的 error_kind，兜底由错误文案重分类
        let classified = aggregate.classify_error();
        return ConsumeResult {
            response: ProviderOutput::stream_error(classified),
            diagnostics: aggregate.diagnostics,
            metadata: Value::Null,
        };
    }
    // 有文字或 tool-call 或思考 → Message（正常产出，纯文字永不失败）：error 不作为
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
    let has_content = !aggregate.text.is_empty()
        || !aggregate.tool_calls.is_empty()
        || !aggregate.thought.is_empty()
        || !aggregate.thought_blocks.is_empty();
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
/// providerError / providerErrorKind / providerErrorRetryable / aborted。
/// error 在此作为标注出现，不参与 stopReason 判定（01 D6）；D7 §3.7 结构化
/// 分类字段（kind kebab-case 13 类 + retryable bool）由统一分类管线派生。
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
        metadata.insert(
            "thought".to_string(),
            Value::String(aggregate.thought.clone()),
        );
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
        // D7 §3.7 流中断结构化标注（镜像 session-loop stream.rs）：providerError
        // 之外新增 providerErrorKind（kebab-case 13 类）+ providerErrorRetryable
        // （bool），供水合后模型/熔断感知中断原因（E1 续写触发信号数据源）。
        // G1-c：优先采用 Stop 构造点携带的 error_kind（构造点已按统一管线分类），
        // 否则由 error 文案经同一管线兜底重分类——两处镜像分类一致
        let kind = aggregate
            .effective_error_kind()
            .unwrap_or(ProviderErrorKind::Unknown);
        metadata.insert(
            "providerErrorKind".to_string(),
            serde_json::to_value(kind).unwrap_or_else(|_| Value::String("unknown".to_string())),
        );
        metadata.insert(
            "providerErrorRetryable".to_string(),
            Value::Bool(kind.default_retryable()),
        );
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
