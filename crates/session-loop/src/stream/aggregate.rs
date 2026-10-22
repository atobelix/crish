//! 流事件聚合与收口（Aggregate / consume / ConsumeBuilder / finish 家族 / metadata 构建）

use conex_types::error::ProviderErrorKind;
use conex_types::message::ToolCallBlock;
use conex_types::response::{ClassifiedStreamError, ProviderOutput};
use conex_types::tool::ProviderDiagnostic;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::events::{
    CacheAccounting, ConsumeResult, ConsumeStopReason, ProviderStreamEvent, ProviderUsage,
    StopReason,
};

/// 思考块（metadata.thoughtBlocks 元素，redacted 透传）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ThoughtBlock {
    text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    redacted: Option<bool>,
}

/// 聚合中间态
#[derive(Debug, Default)]
struct Aggregate {
    text: String,
    thought: String,
    thought_blocks: Vec<ThoughtBlock>,
    tool_calls: Vec<ToolCallBlock>,
    diagnostics: Vec<ProviderDiagnostic>,
    error: Option<String>,
    /// 错误分类（D7 §3.7：Stop 事件透传的 classified.kind，
    /// metadata.providerErrorKind/retryable 数据源）
    error_kind: Option<ProviderErrorKind>,
    usage: Option<ProviderUsage>,
    finish_reason: Option<StopReason>,
}

impl Aggregate {
    fn push(&mut self, event: ProviderStreamEvent) {
        match event {
            ProviderStreamEvent::TextDelta { text } => self.text.push_str(&text),
            ProviderStreamEvent::ThoughtDelta { text, redacted } => {
                self.thought.push_str(&text);
                self.thought_blocks.push(ThoughtBlock { text, redacted });
            }
            ProviderStreamEvent::ToolCall {
                id,
                tool_name,
                input,
            } => {
                // 空/纯空白 id → 合成 call_{n}；合成 id 须跳过已存在 id
                //（显式 id="call_0" 在场时空 id 合成 call_0 会碰撞）
                let id = match id.filter(|s| !s.trim().is_empty()) {
                    Some(id) => id,
                    None => {
                        let mut n = self.tool_calls.len();
                        let mut candidate = format!("call_{n}");
                        while self.tool_calls.iter().any(|tc| tc.id == candidate) {
                            n += 1;
                            candidate = format!("call_{n}");
                        }
                        candidate
                    }
                };
                self.tool_calls.push(ToolCallBlock {
                    id,
                    tool_name,
                    input,
                });
            }
            ProviderStreamEvent::ProviderDiagnostic { diagnostic } => {
                self.diagnostics.push(diagnostic);
            }
            ProviderStreamEvent::Stop {
                reason,
                error,
                error_kind,
                usage,
            } => {
                self.finish_reason = Some(reason);
                if reason == StopReason::Error {
                    self.error = Some(error.unwrap_or_else(|| "provider 流异常终止".to_string()));
                    self.error_kind = error_kind;
                }
                if let Some(usage) = usage {
                    self.usage = Some(usage);
                }
            }
        }
    }
}

/// 消费一条流的全部事件（B2.8 语义在 session-loop 的等价落地，01 D5/D6）
///
/// `aborted`：流中途收到 abort 信号（L3 force_cancel / AbortSignal）。仍完成
/// 聚合：有内容时保留部分并标 stopReason=aborted（partial salvage）；
/// 无内容时产出 StreamError（Aborted 类，不可重试）。
///
/// T09.1：本函数为 [ConsumeBuilder] 的薄包装（测试与既有调用点兼容）；
/// 增量消费路径直接使用 [ConsumeBuilder] 逐事件聚合。
pub fn consume<I>(events: I, aborted: bool) -> ConsumeResult
where
    I: IntoIterator<Item = ProviderStreamEvent>,
{
    let mut builder = ConsumeBuilder::new();
    for event in events {
        builder.push(event);
    }
    builder.finish(aborted)
}

/// 增量消费构建器（T09.1：流式消费期间逐事件聚合，流结束 [Self::finish]
/// 产出与 [consume] 等价的 [ConsumeResult]）
///
/// 语义与 [consume] 完全一致（复用内部 [Aggregate] 与 finish 家族）；
/// 区别仅是**逐步喂入**——配合 streaming handler 的边收边消费，
/// 不需要把整条流先收进 Vec。
#[derive(Debug, Default)]
pub struct ConsumeBuilder {
    aggregate: Aggregate,
    /// 已聚合事件数（流中错误归属判定：是否已产出任何事件）
    pushed: usize,
    /// 协议族口径提示（P2 §3.3 D）：收口时派生 metadata.cacheBreakdown 的
    /// miss/input_total 口径依据。默认 Included（chat-completions 主路径）；
    /// anthropic/gemini 解析路径由适配层显式传 Excluded（T-17/后续接线，
    /// 本任务只提供字段与 setter）。
    usage_accounting: CacheAccounting,
}

impl ConsumeBuilder {
    /// 新建构建器
    pub fn new() -> Self {
        Self::default()
    }

    /// 设置协议族口径（默认 [CacheAccounting::Included]；Anthropic/Gemini 系
    /// 需显式传 [CacheAccounting::Excluded]，使 metadata.cacheBreakdown 的
    /// miss/input_total 按「prompt 不含缓存」口径派生）
    pub fn usage_accounting(mut self, accounting: CacheAccounting) -> Self {
        self.usage_accounting = accounting;
        self
    }

    /// 聚合一条事件（增量喂入）
    pub fn push(&mut self, event: ProviderStreamEvent) {
        self.aggregate.push(event);
        self.pushed += 1;
    }

    /// 是否存在可抢救的用户可见有效载荷（正文/思考/工具调用）
    ///
    /// 核心契约（BC02-3）：只有真实的 text、thought 或 tool-call 增量才算作有效正文载荷；
    /// SseFirstByte 等网络诊断事件绝不能破坏空流判定。
    pub fn has_salvageable_content(&self) -> bool {
        !self.aggregate.text.is_empty()
            || !self.aggregate.tool_calls.is_empty()
            || !self.aggregate.thought.is_empty()
            || !self.aggregate.thought_blocks.is_empty()
    }

    /// 是否尚未产生任何用户可见正文载荷（已升级为 !has_salvageable_content()）
    pub fn is_empty(&self) -> bool {
        !self.has_salvageable_content()
    }

    /// 流结束收口：产出与 [consume] 等价的 [ConsumeResult]
    /// （`aborted` 语义同 [consume]，partial salvage）
    pub fn finish(self, aborted: bool) -> ConsumeResult {
        finish(self.aggregate, aborted, self.usage_accounting)
    }
}

/// 终止聚合：按 BC02-2 / BC02-1 裁决生成 stopReason 并分类响应
fn finish(aggregate: Aggregate, aborted: bool, accounting: CacheAccounting) -> ConsumeResult {
    if aborted {
        return finish_after_abort(aggregate, accounting);
    }
    let has_content = !aggregate.text.is_empty()
        || !aggregate.tool_calls.is_empty()
        || !aggregate.thought.is_empty()
        || !aggregate.thought_blocks.is_empty();

    // 1. 无任何实质正文内容（BC02-1：无正文的错误 Stop 无损透传原始 ClassifiedStreamError，
    // 保留精确 error_kind，打通 429/超时退避阶梯，杜绝被无差别折叠为 Unknown fatal）
    if !has_content {
        let is_error =
            aggregate.finish_reason == Some(StopReason::Error) || aggregate.error.is_some();
        if is_error {
            let message = aggregate
                .error
                .unwrap_or_else(|| "provider 流异常终止".to_string());
            let kind = aggregate.error_kind.unwrap_or(ProviderErrorKind::Unknown);
            let retryable = kind.default_retryable();
            return ConsumeResult {
                response: ProviderOutput::stream_error(ClassifiedStreamError {
                    kind,
                    message,
                    retryable,
                    retry_after_ms: None,
                }),
                diagnostics: aggregate.diagnostics,
                metadata: Value::Null,
            };
        }
        return ConsumeResult {
            response: ProviderOutput::Empty,
            diagnostics: aggregate.diagnostics,
            metadata: Value::Null,
        };
    }

    // 2. 有正文内容（文本/思考/工具）
    // 【BC02-2 核心攻坚铁律】：流以错误终止时，第一公民 Error 终态变体，
    // 绝对严禁盖写为 Stop 或 ToolCall！
    let is_error_finish =
        aggregate.finish_reason == Some(StopReason::Error) || aggregate.error.is_some();
    let stop_reason = if is_error_finish {
        let kind = aggregate.error_kind.unwrap_or(ProviderErrorKind::Unknown);
        let retryable = kind.default_retryable();
        let message = aggregate
            .error
            .clone()
            .unwrap_or_else(|| "provider 流异常终止".to_string());
        ConsumeStopReason::Error {
            kind,
            message,
            retryable,
        }
    } else if !aggregate.tool_calls.is_empty() {
        ConsumeStopReason::ToolCall
    } else {
        match aggregate.finish_reason {
            Some(StopReason::Length) => ConsumeStopReason::Length,
            Some(StopReason::ToolCall) => ConsumeStopReason::ToolCall,
            _ => ConsumeStopReason::Stop,
        }
    };
    let metadata = build_message_metadata(&aggregate, &stop_reason, false, accounting);
    ConsumeResult {
        response: ProviderOutput::message(aggregate.text, aggregate.tool_calls),
        diagnostics: aggregate.diagnostics,
        metadata,
    }
}

/// abort 时完成聚合（partial salvage，02 §一.3：144-174）
fn finish_after_abort(aggregate: Aggregate, accounting: CacheAccounting) -> ConsumeResult {
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
    let metadata =
        build_message_metadata(&aggregate, &ConsumeStopReason::Aborted, true, accounting);
    ConsumeResult {
        response: ProviderOutput::message(aggregate.text, aggregate.tool_calls),
        diagnostics: aggregate.diagnostics,
        metadata,
    }
}

/// 构建消息元数据（对齐 agent-provider buildMessageMetadata）
///
/// `accounting`：协议族口径（P2 §3.3 D）——usage 存在且可派生时，
/// 额外写入 `cacheBreakdown`（camelCase，C9 恒等式派生块）。
fn build_message_metadata(
    aggregate: &Aggregate,
    stop_reason: &ConsumeStopReason,
    aborted: bool,
    accounting: CacheAccounting,
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
        // cacheBreakdown：流收口处按口径派生的缓存拆分（P2 §3.3 D 事件/遥测
        // 输出字段；prompt 缺失时无输入侧数据可派，省略不写）
        if let Some(breakdown) = usage.cache_breakdown(accounting) {
            metadata.insert(
                "cacheBreakdown".to_string(),
                serde_json::to_value(breakdown).unwrap_or_default(),
            );
        }
    }
    if let Some(reason) = aggregate.finish_reason {
        metadata.insert(
            "providerFinishReason".to_string(),
            Value::String(finish_reason_str(reason).to_string()),
        );
    }
    if let Some(error) = &aggregate.error {
        metadata.insert("providerError".to_string(), Value::String(error.clone()));
        // D7 §3.7 流中断结构化标注：providerError 之外新增分类字段——
        // providerErrorKind（kebab-case 13 类）+ providerErrorRetryable（bool），
        // 供水合后模型/熔断感知中断原因（E1 续写触发信号数据源）。分类来自
        // Stop 事件透传的 classified.kind；未携带时只标 providerError 不伪造
        if let Some(kind) = aggregate.error_kind {
            metadata.insert(
                "providerErrorKind".to_string(),
                serde_json::to_value(kind).unwrap_or_else(|_| Value::String("unknown".to_string())),
            );
            metadata.insert(
                "providerErrorRetryable".to_string(),
                Value::Bool(kind.default_retryable()),
            );
        }
    }
    if aborted {
        metadata.insert("aborted".to_string(), Value::Bool(true));
    }
    Value::Object(metadata)
}

/// Q33（T09.9）：consume 完成后重读 abort 命中时的补标注——把以正常形态
/// 聚合的结果改写为 aborted 语义（partial salvage 标注一致性，AA-01 Q33：
/// consume 完成瞬间触发 abort 时消息不得漏标 stopReason=aborted）：
/// - `Message` → metadata.stopReason=aborted + aborted=true（内容保留）；
/// - `Empty` / `StreamError` → 无内容可抢救，归为 Aborted 类错误（aborted 收场）。
pub fn reannotate_aborted(mut consumed: ConsumeResult) -> ConsumeResult {
    match &mut consumed.response {
        ProviderOutput::Message { .. } => {
            match consumed.metadata.as_object_mut() {
                Some(metadata) => {
                    metadata.insert(
                        "stopReason".to_string(),
                        Value::String("aborted".to_string()),
                    );
                    metadata.insert("aborted".to_string(), Value::Bool(true));
                }
                // 防御性兜底：Message 正常聚合必带 metadata 对象
                None => {
                    let mut metadata = serde_json::Map::new();
                    metadata.insert(
                        "stopReason".to_string(),
                        Value::String("aborted".to_string()),
                    );
                    metadata.insert("aborted".to_string(), Value::Bool(true));
                    consumed.metadata = Value::Object(metadata);
                }
            }
        }
        ProviderOutput::Empty | ProviderOutput::StreamError { .. } => {
            consumed.response = ProviderOutput::stream_error(ClassifiedStreamError {
                kind: ProviderErrorKind::Aborted,
                message: "aborted".to_string(),
                retryable: false,
                retry_after_ms: None,
            });
            consumed.metadata = Value::Null;
        }
    }
    consumed
}

/// 终止原因 → wire 文案（providerFinishReason 标注）
fn finish_reason_str(reason: StopReason) -> &'static str {
    match reason {
        StopReason::Stop => "stop",
        StopReason::ToolCall => "tool-call",
        StopReason::Length => "length",
        StopReason::Error => "error",
    }
}
