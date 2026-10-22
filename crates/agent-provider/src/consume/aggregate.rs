use conex_types::error::ProviderErrorKind;
use conex_types::message::ToolCallBlock;
use conex_types::response::ClassifiedStreamError;
use conex_types::tool::ProviderDiagnostic;
use serde::{Deserialize, Serialize};

use crate::error::classify_provider_error;
use crate::events::{stream_error_kind, ProviderStreamEvent, ProviderUsage, StopReason};

/// 思考块（metadata.thoughtBlocks 的元素，redacted 透传，02 §一.4）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThoughtBlock {
    pub(crate) text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) redacted: Option<bool>,
}

/// 聚合中间态（对齐 TS consume 内 textBuffer / thoughtBuffer / error / usage /
/// finishReasonFromStream，provider-response-consumer.ts:37-41）
#[derive(Debug, Default)]
pub(crate) struct Aggregate {
    /// 正文聚合
    pub(crate) text: String,
    /// 思考聚合
    pub(crate) thought: String,
    /// 逐段思考块（各带自己的 redacted 标记，对齐 TS blocks.push(thought)）
    pub(crate) thought_blocks: Vec<ThoughtBlock>,
    /// 工具调用（全部为 end 阶段完整调用，02 §六.9）
    pub(crate) tool_calls: Vec<ToolCallBlock>,
    /// 流期间收集的诊断
    pub(crate) diagnostics: Vec<ProviderDiagnostic>,
    /// 错误文案（stop.reason=error 携带，对齐 TS error / end.error 记录，02 §一.3：102-116）
    pub(crate) error: Option<String>,
    /// Stop 事件携带的错误分类（G1-c：构造点已分类，消费侧优先沿用；
    /// 无 → 兜底由 [Aggregate::error] 文案经 [classify_provider_error] 重分类）
    pub(crate) error_kind: Option<ProviderErrorKind>,
    /// stop 携带的用量
    pub(crate) usage: Option<ProviderUsage>,
    /// 终止事件的原因（每流恰好一个，02 §六.9）
    pub(crate) finish_reason: Option<StopReason>,
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
    pub(crate) fn push(&mut self, event: ProviderStreamEvent) -> bool {
        match event {
            ProviderStreamEvent::TextDelta { text } => {
                self.text.push_str(&text);
            }
            ProviderStreamEvent::ThoughtDelta { text, redacted } => {
                self.thought.push_str(&text);
                self.thought_blocks.push(ThoughtBlock { text, redacted });
            }
            ProviderStreamEvent::ToolCall {
                id,
                tool_name,
                input,
            } => {
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
            ProviderStreamEvent::Stop {
                reason,
                error,
                error_kind,
                usage,
            } => {
                self.finish_reason = Some(reason);
                if reason == StopReason::Error {
                    // error stop 即「流中曾有 error」（02 §一.3：102-116）
                    self.error = Some(error.unwrap_or_else(|| "provider 流异常终止".to_string()));
                }
                // G1-c：构造点分类透传；仅携带 error 文案而分类为空时，消费侧兜底重分类
                self.error_kind = error_kind;
                if let Some(usage) = usage {
                    self.usage = Some(usage);
                }
            }
        }
        // F3-05：正文/思考任一超限即标记（不静默截断）
        self.text.len() > MAX_AGGREGATE_TEXT_BYTES || self.thought.len() > MAX_AGGREGATE_TEXT_BYTES
    }

    /// 有效错误分类（G1-c）：优先采用 Stop 构造点携带的 [Self::error_kind]，
    /// 否则由错误文案经统一分类管线兜底重分类（与构造点同源镜像，两处分类一致）。
    pub(crate) fn effective_error_kind(&self) -> Option<ProviderErrorKind> {
        match (self.error_kind, self.error.as_deref()) {
            (Some(kind), _) => Some(kind),
            (None, Some(message)) => Some(stream_error_kind(message)),
            (None, None) => None,
        }
    }

    /// 构建无内容流错误分类（G1-c：沿用构造点分类；无内容时 error 文案经
    /// 统一管线兜底为 Unknown 等分类，retry_after 由消息模式分类给出）
    pub(crate) fn classify_error(&self) -> ClassifiedStreamError {
        let message = self.error.clone().unwrap_or_default();
        let kind = self
            .effective_error_kind()
            .unwrap_or(ProviderErrorKind::Unknown);
        let retry_after_ms = classify_provider_error(None, Some(&message), None, None)
            .retry_after()
            .map(|d| d.as_millis() as u64);
        ClassifiedStreamError {
            kind,
            message,
            retryable: kind.default_retryable(),
            retry_after_ms,
        }
    }
}
