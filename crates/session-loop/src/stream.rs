//! provider 流事件与消费聚合（B3.4 本地等价层，对齐 02 §1.1 / §六.9、01 §2.4）
//!
//! session-loop 按任务书 B3.4 第 5 点约束**不直接依赖 agent-provider**
//! （provider 解耦用 trait，HTTP/传输层不进入本 crate）。本模块自建与
//! agent-provider::events / consume 等价的类型与聚合逻辑：
//! - [ProviderStreamEvent] / [StopReason] / [ProviderUsage]：wire 形状与
//!   agent-provider::events 逐字段一致（02 §1.1、§六.9-10），供 ProviderCall
//!   实现方（真实 provider 适配层 / TestProvider）产出一致的事件序列；
//! - [CacheAccounting] / [CacheBreakdown]：usage 归一化口径与派生结果的本地
//!   等价类型（对齐 agent-provider::events，P2 §3.3 D / C9 口径唯一真源）——
//!   [ConsumeBuilder] 携带口径提示，流收口处把派生出的 `cacheBreakdown`
//!   （camelCase）写入消息 metadata；
//! - [consume] / [ConsumeResult] / [ConsumeStopReason]：与
//!   agent-provider::consume 等价的响应分类聚合（01 D5/D6：模型输出与传输
//!   错误分离——有文字或有 tool-call 即 Message，纯文字永不失败）。
//!
//! 依赖方向说明：agent-provider 仅依赖 conex-types（无环），若后续任务允许
//! 引入该依赖，可将本层整体替换为 agent-provider::consume 复用；当前保持
//! 自建等价类型以遵守「不引入新依赖」约束（任务书 B3.4 第 5 点）。
//!
//! 事件序列合法性（每流恰好一个 stop、stop 之后无事件，02 §六.9）由
//! provider 实现方保证，本层不再重复校验（与 agent-provider 的 consume 同）。

use conex_types::error::ProviderErrorKind;
use conex_types::message::ToolCallBlock;
use conex_types::response::{ClassifiedStreamError, ProviderOutput};
use conex_types::tool::ProviderDiagnostic;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// stop 原因（02 §1.1：stop|tool-call|length|error）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StopReason {
    /// 正常结束
    Stop,
    /// 工具调用收尾
    ToolCall,
    /// 长度截断
    Length,
    /// 错误收尾（解析异常、服务端错误帧、空流保护等）
    Error,
}

/// 用量统计（对齐 agent-provider ProviderUsage 的 camelCase 形状）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<u64>,
    /// cacheMissTokens：缓存未命中输入（DeepSeek 顶层 prompt_cache_miss_tokens；
    /// 其余协议族由 [ProviderUsage::cache_breakdown] 按口径推导，此处可为 None）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_miss_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u64>,
}

/// 协议族口径标记（对齐 agent-provider::events::CacheAccounting，T-10 交付，
/// P2 §3.3 D；LiteLLM 双命名空间：prompt 是否已含缓存）
///
/// 恒等式（C9 口径唯一真源）：`input_total = miss + read + write`；
/// Included 系下 `input_total = prompt`，Excluded 系下 `input_total = prompt + read + write`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CacheAccounting {
    /// OpenAI 系（chat/responses）：prompt 已含缓存
    #[default]
    Included,
    /// Anthropic/Gemini 系：prompt 不含缓存
    Excluded,
}

/// 归一化派生结果（camelCase，对齐 agent-provider CacheBreakdown；C9 口径真源）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheBreakdown {
    /// 缓存命中读取（cacheReadTokens）
    pub read: u64,
    /// 缓存写入（cacheWriteTokens）
    pub write: u64,
    /// 未缓存输入（= 计费输入；DeepSeek 顶层 miss 存在时优先）
    pub miss: u64,
    /// 归一化后的输入总量 = miss + read + write
    pub input_total: u64,
}

impl ProviderUsage {
    /// 按协议族口径归一化派生缓存拆分（P2 §3.3 D；C9 口径真源，与
    /// agent-provider::events 的 [ProviderUsage::cache_breakdown] 公式一致）
    ///
    /// - Included（OpenAI 系）：miss = prompt - read - write、input_total = prompt；
    /// - Excluded（Anthropic/Gemini 系）：miss = prompt、input_total = prompt + read + write；
    /// - read/write 为 None 时按 0 处理；推导结果为负时钳 0；
    /// - DeepSeek 顶层 `cache_miss_tokens` 存在时直接取服务端报告值，不依赖推导；
    /// - prompt 缺失时返回 None（无输入侧数据可派）。
    pub fn cache_breakdown(&self, accounting: CacheAccounting) -> Option<CacheBreakdown> {
        let read = self.cache_read_tokens.unwrap_or(0);
        let write = self.cache_write_tokens.unwrap_or(0);
        let prompt = self.prompt_tokens?;
        let miss = self.cache_miss_tokens.unwrap_or_else(|| match accounting {
            CacheAccounting::Included => prompt.saturating_sub(read.saturating_add(write)),
            CacheAccounting::Excluded => prompt,
        });
        let input_total = match accounting {
            CacheAccounting::Included => prompt,
            CacheAccounting::Excluded => prompt.saturating_add(read).saturating_add(write),
        };
        Some(CacheBreakdown {
            read,
            write,
            miss,
            input_total,
        })
    }
}

/// 低级流事件（对齐 agent-provider::events::ProviderStreamEvent，02 §1.1 表）
// G2 允许理由（clippy::large_enum_variant）：流载荷变体语义必然大（诊断/
// 工具调用等变体含完整数据快照），Box 化破坏模式匹配便利性与序列化契约
// （事件面契约冻结，与 agent-provider::events 同理由）。
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ProviderStreamEvent {
    /// 正文增量
    #[serde(rename_all = "camelCase")]
    TextDelta { text: String },
    /// 推理/思考增量（02 §1.4）
    #[serde(rename_all = "camelCase")]
    ThoughtDelta {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        redacted: Option<bool>,
    },
    /// 完整工具调用（一次性产出，02 §六.9）
    #[serde(rename_all = "camelCase")]
    ToolCall {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        tool_name: String,
        input: serde_json::Value,
    },
    /// 观测诊断
    #[serde(rename_all = "camelCase")]
    ProviderDiagnostic { diagnostic: ProviderDiagnostic },
    /// 终止事件，每流恰好一个（02 §六.9）
    #[serde(rename_all = "camelCase")]
    Stop {
        reason: StopReason,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        /// 错误分类（reason=error 时携带；D7 §3.7：流中断结构化标注的
        /// providerErrorKind/retryable 数据源——streaming handler 注入
        /// Stop 时透传 classified.kind）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_kind: Option<ProviderErrorKind>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<ProviderUsage>,
    },
}

impl ProviderStreamEvent {
    /// 便捷构造：正文增量
    pub fn text(text: impl Into<String>) -> Self {
        ProviderStreamEvent::TextDelta { text: text.into() }
    }

    /// 便捷构造：思考增量（redacted 缺省 None）
    pub fn thought(text: impl Into<String>, redacted: Option<bool>) -> Self {
        ProviderStreamEvent::ThoughtDelta {
            text: text.into(),
            redacted,
        }
    }

    /// 便捷构造：完整工具调用（id 缺省为 None，消费层兜底生成）
    pub fn tool_call(id: Option<String>, tool_name: impl Into<String>, input: Value) -> Self {
        ProviderStreamEvent::ToolCall {
            id,
            tool_name: tool_name.into(),
            input,
        }
    }

    /// 便捷构造：终止事件
    pub fn stop(reason: StopReason) -> Self {
        ProviderStreamEvent::Stop {
            reason,
            error: None,
            error_kind: None,
            usage: None,
        }
    }
}

/// 消费终止原因（metadata.stopReason 取值域，对齐 agent-provider ConsumeStopReason）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConsumeStopReason {
    /// 正常结束
    Stop,
    /// 工具调用收尾（仅限成功完成且无未决错误的流）
    ToolCall,
    /// 长度截断（length 恢复阶梯输入，01 §2.6 步骤 1）
    Length,
    /// 流中途 abort（partial salvage，01 §2.4 步骤 5）
    Aborted,
    /// 【第一公民 Error 终态变体（BC02-2）】：流中途发生服务端错误/异常截断
    /// （内容部分留存，但绝非成功；严禁进入 HasToolCalls 派发真实工具执行）
    Error {
        kind: ProviderErrorKind,
        message: String,
        retryable: bool,
    },
}

impl ConsumeStopReason {
    /// wire 取值（对齐 TS stopReason 字符串）
    pub const fn as_str(&self) -> &'static str {
        match self {
            ConsumeStopReason::Stop => "stop",
            ConsumeStopReason::ToolCall => "tool-call",
            ConsumeStopReason::Length => "length",
            ConsumeStopReason::Aborted => "aborted",
            ConsumeStopReason::Error { .. } => "error",
        }
    }

    /// 是否为错误终态
    pub const fn is_error(&self) -> bool {
        matches!(self, ConsumeStopReason::Error { .. })
    }
}

/// 消费结果（与 agent-provider::consume::ConsumeResult 等价形状）
///
/// - `response`：分类产物（Message / Empty / StreamError，01 §五.3）；
/// - `diagnostics`：流期间收集的诊断（01 §2.4 步骤 4：provider-diagnostic 事件源）；
/// - `metadata`：消息元数据标注（stopReason / thought / usage / providerError /
///   providerErrorKind / providerErrorRetryable / aborted，对齐
///   agent-provider buildMessageMetadata；D7 §3.7 结构化分类字段）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumeResult {
    pub response: ProviderOutput,
    pub diagnostics: Vec<ProviderDiagnostic>,
    pub metadata: Value,
}

impl ConsumeResult {
    /// 读取 metadata.stopReason（非 Message 响应或无标注返回 None）
    pub fn stop_reason(&self) -> Option<ConsumeStopReason> {
        let value = self.metadata.get("stopReason")?.as_str()?;
        match value {
            "stop" => Some(ConsumeStopReason::Stop),
            "tool-call" => Some(ConsumeStopReason::ToolCall),
            "length" => Some(ConsumeStopReason::Length),
            "aborted" => Some(ConsumeStopReason::Aborted),
            "error" => {
                let message = self
                    .metadata
                    .get("providerError")
                    .and_then(|v| v.as_str())
                    .unwrap_or("provider 流异常终止")
                    .to_string();
                let kind = self
                    .metadata
                    .get("providerErrorKind")
                    .and_then(|v| serde_json::from_value(v.clone()).ok())
                    .unwrap_or(ProviderErrorKind::Unknown);
                let retryable = self
                    .metadata
                    .get("providerErrorRetryable")
                    .and_then(|v| v.as_bool())
                    .unwrap_or_else(|| kind.default_retryable());
                Some(ConsumeStopReason::Error {
                    kind,
                    message,
                    retryable,
                })
            }
            _ => None,
        }
    }
}

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
        let is_error = aggregate.finish_reason == Some(StopReason::Error) || aggregate.error.is_some();
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
    let is_error_finish = aggregate.finish_reason == Some(StopReason::Error) || aggregate.error.is_some();
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
    let metadata = build_message_metadata(&aggregate, &ConsumeStopReason::Aborted, true, accounting);
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


#[cfg(test)]
mod tests {
    use super::*;

    /// 文字 + error stop → Message（内容部分保留）；stopReason=error 第一公民变体（BC02-2）。
    /// D7 §3.7（T9）：标注含结构化分类 providerErrorKind/providerErrorRetryable
    #[test]
    fn text_then_error_stop_yields_message() {
        let result = consume(
            vec![
                ProviderStreamEvent::text("你好"),
                ProviderStreamEvent::Stop {
                    reason: StopReason::Error,
                    error: Some("上游超时".to_string()),
                    error_kind: Some(ProviderErrorKind::Timeout),
                    usage: None,
                },
            ],
            false,
        );
        assert_eq!(result.response, ProviderOutput::message("你好", vec![]));
        assert_eq!(
            result.stop_reason(),
            Some(ConsumeStopReason::Error {
                kind: ProviderErrorKind::Timeout,
                message: "上游超时".to_string(),
                retryable: true,
            })
        );
        assert_eq!(result.metadata["stopReason"], "error");
        // providerError 字符串保持 + 结构化字段（kebab-case kind / retryable）
        assert_eq!(result.metadata["providerError"], "上游超时");
        assert_eq!(result.metadata["providerErrorKind"], "timeout");
        assert_eq!(result.metadata["providerErrorRetryable"], true);
    }

    /// D7 §3.7：不可重试分类（Unknown）→ providerErrorRetryable=false
    #[test]
    fn error_stop_unknown_kind_marks_not_retryable() {
        let result = consume(
            vec![
                ProviderStreamEvent::text("部分内容"),
                ProviderStreamEvent::Stop {
                    reason: StopReason::Error,
                    error: Some("未知错误".to_string()),
                    error_kind: Some(ProviderErrorKind::Unknown),
                    usage: None,
                },
            ],
            false,
        );
        assert_eq!(
            result.stop_reason(),
            Some(ConsumeStopReason::Error {
                kind: ProviderErrorKind::Unknown,
                message: "未知错误".to_string(),
                retryable: false,
            })
        );
        assert_eq!(result.metadata["stopReason"], "error");
        assert_eq!(result.metadata["providerErrorKind"], "unknown");
        assert_eq!(result.metadata["providerErrorRetryable"], false);
    }

    /// D7 §3.7 向后兼容：Stop 未携带 error_kind（老注入方）→ 只标
    /// providerError，不写 kind/retryable 字段（标注增量、不伪造分类）
    #[test]
    fn error_stop_without_kind_omits_classification_fields() {
        let result = consume(
            vec![
                ProviderStreamEvent::text("部分内容"),
                ProviderStreamEvent::stop(StopReason::Error),
            ],
            false,
        );
        assert_eq!(
            result.stop_reason(),
            Some(ConsumeStopReason::Error {
                kind: ProviderErrorKind::Unknown,
                message: "provider 流异常终止".to_string(),
                retryable: false,
            })
        );
        assert_eq!(result.metadata["stopReason"], "error");
        assert_eq!(result.metadata["providerError"], "provider 流异常终止");
        assert!(result.metadata.get("providerErrorKind").is_none());
        assert!(result.metadata.get("providerErrorRetryable").is_none());
    }

    /// 纯 error 无内容 → StreamError（Unknown，不可重试）
    #[test]
    fn pure_error_stop_yields_stream_error() {
        let result = consume(vec![ProviderStreamEvent::stop(StopReason::Error)], false);
        let ProviderOutput::StreamError { classified } = &result.response else {
            panic!("应为 StreamError，得到 {:?}", result.response);
        };
        assert_eq!(classified.kind, ProviderErrorKind::Unknown);
        assert!(!classified.retryable);
    }

    /// abort 有内容 → 保留部分，stopReason=aborted
    #[test]
    fn abort_with_content_keeps_partial_message() {
        let result = consume(vec![ProviderStreamEvent::text("已流出的部分")], true);
        assert_eq!(result.response.text(), "已流出的部分");
        assert_eq!(result.stop_reason(), Some(ConsumeStopReason::Aborted));
        assert_eq!(result.metadata["aborted"], true);
    }

    /// 空流 → Empty
    #[test]
    fn empty_stream_yields_empty() {
        let result = consume(Vec::<ProviderStreamEvent>::new(), false);
        assert_eq!(result.response, ProviderOutput::Empty);
    }

    /// stop.reason=length → Message + stopReason=length（length 阶梯输入）
    #[test]
    fn length_stop_yields_message_with_length() {
        let result = consume(
            vec![
                ProviderStreamEvent::text("长回复"),
                ProviderStreamEvent::stop(StopReason::Length),
            ],
            false,
        );
        assert_eq!(result.stop_reason(), Some(ConsumeStopReason::Length));
    }

    /// tool-call 收集与正文共存
    #[test]
    fn tool_call_collected_at_stream_end() {
        let result = consume(
            vec![
                ProviderStreamEvent::tool_call(
                    None,
                    "read_file",
                    serde_json::json!({"path": "/tmp/a"}),
                ),
                ProviderStreamEvent::text("调用后的话"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ],
            false,
        );
        assert_eq!(result.stop_reason(), Some(ConsumeStopReason::ToolCall));
        let ProviderOutput::Message { text, tool_calls } = &result.response else {
            panic!("应为 Message");
        };
        assert_eq!(text, "调用后的话");
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(tool_calls[0].id, "call_0");
    }

    /// 空 id → 合成 call_0（既有行为锁定）
    #[test]
    fn empty_tool_call_id_generates_call_0() {
        let result = consume(
            vec![
                ProviderStreamEvent::tool_call(
                    Some("".into()),
                    "read_file",
                    serde_json::json!({"path": "/tmp/a"}),
                ),
                ProviderStreamEvent::stop(StopReason::Stop),
            ],
            false,
        );
        let ProviderOutput::Message { tool_calls, .. } = &result.response else {
            panic!("应为 Message");
        };
        assert_eq!(tool_calls[0].id, "call_0", "空字符串 id 必须合成 call_0");
    }

    /// 纯空白 id（"   "）→ 合成 call_0（trim 后为空视为空 id）
    #[test]
    fn whitespace_tool_call_id_generates_call_0() {
        let result = consume(
            vec![
                ProviderStreamEvent::tool_call(
                    Some("   \t".into()),
                    "read_file",
                    serde_json::json!({"path": "/tmp/a"}),
                ),
                ProviderStreamEvent::stop(StopReason::Stop),
            ],
            false,
        );
        let ProviderOutput::Message { tool_calls, .. } = &result.response else {
            panic!("应为 Message");
        };
        assert_eq!(tool_calls[0].id, "call_0", "纯空白 id 必须合成 call_0");
    }

    /// 合成 id 与显式 id 碰撞：显式 call_0 在场时空 id 不得再生成 call_0
    ///（修复前 format!("call_{}", len) 在 len=1 时生成 call_1 恰好不撞——
    /// 真正碰撞场景是空 id 先到生成 call_0、显式 call_0 后到；以及多个空 id
    /// 后显式 call_N 插入。本测试锁定「合成跳过已存在 id」语义）
    #[test]
    fn synthesized_id_skips_existing_explicit_id() {
        // 场景①：显式 call_0 先到（len=0 时不占合成位），空 id 后到
        // 修复前 len=1 → 生成 call_1（不撞）；锁定无碰撞 + id 唯一
        let result = consume(
            vec![
                ProviderStreamEvent::tool_call(
                    Some("call_0".into()),
                    "first",
                    serde_json::json!({}),
                ),
                ProviderStreamEvent::tool_call(None, "second", serde_json::json!({})),
                ProviderStreamEvent::stop(StopReason::Stop),
            ],
            false,
        );
        let ProviderOutput::Message { tool_calls, .. } = &result.response else {
            panic!("应为 Message");
        };
        assert_eq!(tool_calls.len(), 2);
        assert_eq!(tool_calls[0].id, "call_0", "显式 id 保留");
        assert_ne!(
            tool_calls[1].id, "call_0",
            "空 id 合成结果不得与显式 call_0 碰撞"
        );
        assert_ne!(
            tool_calls[0].id, tool_calls[1].id,
            "两条 tool-call id 必须唯一"
        );
    }

    /// 合成 id 跳过已存在 id（含显式插入后的空洞场景，修复前真实碰撞路径）：
    /// 显式 ["call_0","call_2"] 在场时空 id 修复前生成 call_2（len=2）碰撞；
    /// 修复后合成须跳到 call_3。多空 id 连续合成亦互不相同。
    #[test]
    fn synthesized_id_skips_existing_after_explicit_insert() {
        let result = consume(
            vec![
                // 显式 call_0 / call_2 先占位，制造合成候选 call_2 碰撞
                ProviderStreamEvent::tool_call(Some("call_0".into()), "a", serde_json::json!({})),
                ProviderStreamEvent::tool_call(Some("call_2".into()), "b", serde_json::json!({})),
                // 空 id：len=2 → 候选 call_2 已存在 → 跳到 call_3
                ProviderStreamEvent::tool_call(None, "c", serde_json::json!({})),
                ProviderStreamEvent::tool_call(Some("".into()), "d", serde_json::json!({})),
                ProviderStreamEvent::tool_call(Some("  ".into()), "e", serde_json::json!({})),
                ProviderStreamEvent::stop(StopReason::Stop),
            ],
            false,
        );
        let ProviderOutput::Message { tool_calls, .. } = &result.response else {
            panic!("应为 Message");
        };
        assert_eq!(tool_calls.len(), 5);
        assert_eq!(tool_calls[0].id, "call_0", "显式 id 保留");
        assert_eq!(tool_calls[1].id, "call_2", "显式 id 保留");
        // c：候选 call_2 撞已存在 → call_3
        assert_eq!(
            tool_calls[2].id, "call_3",
            "合成 id 必须跳过已存在的 call_2"
        );
        // d：len=3 → 候选 call_3 已存在 → call_4
        assert_eq!(tool_calls[3].id, "call_4");
        // e：len=4 → 候选 call_4 已存在 → call_5
        assert_eq!(tool_calls[4].id, "call_5");
        // 全部合成 id（c/d/e）与显式 id 互不相同
        let all: std::collections::HashSet<&str> =
            tool_calls.iter().map(|tc| tc.id.as_str()).collect();
        assert_eq!(all.len(), 5, "五条 tool-call id 必须全部唯一");
    }

    /// Q33（T09.9）：reannotate_aborted——Message 正常聚合后补 aborted 标注
    /// （内容保留，stopReason 改写为 aborted，原有标注不丢失）
    #[test]
    fn reannotate_message_sets_aborted_stop_reason() {
        let mut consumed = consume(
            vec![
                ProviderStreamEvent::text("已流出的部分"),
                ProviderStreamEvent::stop(StopReason::Length),
            ],
            false,
        );
        assert_eq!(consumed.stop_reason(), Some(ConsumeStopReason::Length));
        consumed = reannotate_aborted(consumed);
        assert_eq!(consumed.response.text(), "已流出的部分", "内容保留");
        assert_eq!(consumed.stop_reason(), Some(ConsumeStopReason::Aborted));
        assert_eq!(consumed.metadata["aborted"], true);
        // 原有标注保留（providerFinishReason 等不因补标注丢失）
        assert_eq!(consumed.metadata["providerFinishReason"], "length");
    }

    /// Q33（T09.9）：reannotate_aborted——Empty 无内容可抢救 → Aborted 类
    /// 流错误（aborted 收场，不误入 Empty/steering 路径）
    #[test]
    fn reannotate_empty_becomes_aborted_error() {
        let consumed = consume(Vec::<ProviderStreamEvent>::new(), false);
        assert_eq!(consumed.response, ProviderOutput::Empty);
        let reannotated = reannotate_aborted(consumed);
        let ProviderOutput::StreamError { classified } = &reannotated.response else {
            panic!("应为 StreamError，得到 {:?}", reannotated.response);
        };
        assert_eq!(classified.kind, ProviderErrorKind::Aborted);
        assert!(!classified.retryable);
    }

    /// T09.1：ConsumeBuilder 增量聚合与 consume 全量等价（finish 语义一致）
    #[test]
    fn consume_builder_matches_consume() {
        let events = vec![
            ProviderStreamEvent::text("你"),
            ProviderStreamEvent::thought("思考", Some(true)),
            ProviderStreamEvent::text("好"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ];
        let full = consume(events.clone(), false);
        let mut builder = ConsumeBuilder::new();
        assert!(builder.is_empty(), "构建器初始为空");
        for event in events {
            builder.push(event);
            assert!(!builder.is_empty(), "push 后非空");
        }
        let incremental = builder.finish(false);
        assert_eq!(incremental, full, "增量聚合与全量聚合等价");
        assert_eq!(incremental.response.text(), "你好");
        assert!(matches!(
            incremental.stop_reason(),
            Some(ConsumeStopReason::Stop)
        ));
    }

    /// T09.1：ConsumeBuilder 空构建器 is_empty 判定（流中错误归属输入）
    #[test]
    fn consume_builder_is_empty_before_any_push() {
        let mut builder = ConsumeBuilder::new();
        assert!(builder.is_empty());
        builder.push(ProviderStreamEvent::text("x"));
        assert!(!builder.is_empty());
        let empty = ConsumeBuilder::new().finish(false);
        assert_eq!(empty.response, ProviderOutput::Empty);
    }

    // ── T-16（P2 步骤 4a）：metadata.cacheBreakdown 派生（C9 口径，camelCase）────

    /// 构造带 usage 的停止事件（read/write/miss 齐备）
    fn stop_with_usage(miss: Option<u64>) -> ProviderStreamEvent {
        ProviderStreamEvent::Stop {
            reason: StopReason::Stop,
            error: None,
            error_kind: None,
            usage: Some(ProviderUsage {
                prompt_tokens: Some(100),
                completion_tokens: Some(20),
                total_tokens: Some(120),
                cache_read_tokens: Some(70),
                cache_write_tokens: Some(10),
                cache_miss_tokens: miss,
                reasoning_tokens: None,
            }),
        }
    }

    /// T-16：默认口径（Included，consume/ConsumeBuilder::new 缺省）下
    /// metadata 派生 cacheBreakdown，键为 camelCase（inputTotal）
    #[test]
    fn metadata_cache_breakdown_included_default() {
        let result = consume(
            vec![ProviderStreamEvent::text("你好"), stop_with_usage(None)],
            false,
        );
        let breakdown = result
            .metadata
            .get("cacheBreakdown")
            .expect("默认口径（Included）应派生 cacheBreakdown")
            .clone();
        assert_eq!(breakdown["read"], 70);
        assert_eq!(breakdown["write"], 10);
        assert_eq!(
            breakdown["miss"], 20,
            "Included：miss = prompt - read - write"
        );
        assert_eq!(
            breakdown["inputTotal"], 100,
            "Included：inputTotal = prompt"
        );
        // 恒等式（C9）：input_total = miss + read + write
        assert_eq!(
            breakdown["miss"].as_u64().unwrap()
                + breakdown["read"].as_u64().unwrap()
                + breakdown["write"].as_u64().unwrap(),
            breakdown["inputTotal"].as_u64().unwrap()
        );
    }

    /// T-16：Excluded 口径（适配层显式传入，Anthropic/Gemini 系）下
    /// miss = prompt、inputTotal = prompt + read + write
    #[test]
    fn metadata_cache_breakdown_excluded_via_builder() {
        let mut builder = ConsumeBuilder::new().usage_accounting(CacheAccounting::Excluded);
        builder.push(ProviderStreamEvent::text("你好"));
        builder.push(stop_with_usage(None));
        let result = builder.finish(false);
        let breakdown = result.metadata["cacheBreakdown"].clone();
        assert_eq!(breakdown["miss"], 100, "Excluded：miss = prompt");
        assert_eq!(
            breakdown["inputTotal"], 180,
            "Excluded：inputTotal = prompt + read + write"
        );
        assert_eq!(breakdown["read"], 70);
        assert_eq!(breakdown["write"], 10);
    }

    /// T-16：DeepSeek 顶层 miss 优先（服务端报告值直接采用，不依赖口径推导）
    #[test]
    fn metadata_cache_breakdown_deepseek_miss_priority() {
        // 显式 Excluded 也应尊重服务端报告的 miss 值（C9：miss 报告值优先）
        let mut builder = ConsumeBuilder::new().usage_accounting(CacheAccounting::Excluded);
        builder.push(ProviderStreamEvent::text("你好"));
        builder.push(stop_with_usage(Some(15)));
        let result = builder.finish(false);
        let breakdown = result.metadata["cacheBreakdown"].clone();
        assert_eq!(breakdown["miss"], 15, "DeepSeek 顶层 miss 字段优先");
        assert_eq!(breakdown["inputTotal"], 180);
    }

    /// T-16：prompt 缺失 → 不写 cacheBreakdown（无输入侧数据可派）
    #[test]
    fn metadata_omits_cache_breakdown_without_prompt() {
        let result = consume(
            vec![
                ProviderStreamEvent::text("你好"),
                ProviderStreamEvent::Stop {
                    reason: StopReason::Stop,
                    error: None,
                    error_kind: None,
                    usage: Some(ProviderUsage {
                        completion_tokens: Some(20),
                        ..ProviderUsage::default()
                    }),
                },
            ],
            false,
        );
        assert!(
            result.metadata.get("cacheBreakdown").is_none(),
            "prompt 缺失不派生"
        );
        assert!(result.metadata.get("usage").is_some(), "usage 原样保留");
    }

    /// T-16：无 usage 的 Stop → 不写 cacheBreakdown
    #[test]
    fn metadata_omits_cache_breakdown_without_usage() {
        let result = consume(
            vec![
                ProviderStreamEvent::text("你好"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ],
            false,
        );
        assert!(result.metadata.get("cacheBreakdown").is_none());
    }

    /// T-16：CacheBreakdown 序列化形状（camelCase，与 agent-provider 同形）
    #[test]
    fn cache_breakdown_serializes_camel_case() {
        let breakdown = CacheBreakdown {
            read: 1,
            write: 2,
            miss: 3,
            input_total: 6,
        };
        let value = serde_json::to_value(breakdown).unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "read": 1, "write": 2, "miss": 3, "inputTotal": 6 })
        );
        assert!(value.get("input_total").is_none(), "禁止 snake_case 键");
    }

    /// 纯思考流（无正文）→ Message（不判定为 Empty），metadata 完整保留 thought 与 thoughtBlocks
    #[test]
    fn pure_thought_stream_yields_message() {
        let result = consume(
            vec![
                ProviderStreamEvent::thought("纯思考深度分析1", None),
                ProviderStreamEvent::thought("纯思考深度分析2", Some(true)),
                ProviderStreamEvent::stop(StopReason::Stop),
            ],
            false,
        );
        assert!(
            result.response.is_message(),
            "纯思考流必须产出 Message，不得被判定为 Empty"
        );
        assert_eq!(result.response.text(), "");
        assert_eq!(result.stop_reason(), Some(ConsumeStopReason::Stop));
        assert_eq!(result.metadata["thought"], "纯思考深度分析1纯思考深度分析2");
        let blocks = result.metadata["thoughtBlocks"].as_array().unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["text"], "纯思考深度分析1");
        assert!(blocks[0].get("redacted").is_none());
        assert_eq!(blocks[1]["text"], "纯思考深度分析2");
        assert_eq!(blocks[1]["redacted"], true);
    }

    /// abort 发生在纯思考流中 → 保留思考内容，stopReason=aborted（partial salvage）
    #[test]
    fn abort_with_only_thought_keeps_partial_message() {
        let result = consume(
            vec![ProviderStreamEvent::thought(
                "流中被 abort 的思考片段",
                None,
            )],
            true,
        );
        assert!(
            result.response.is_message(),
            "仅有思考内容时 abort 必须保留为 Message"
        );
        assert_eq!(result.response.text(), "");
        assert_eq!(result.stop_reason(), Some(ConsumeStopReason::Aborted));
        assert_eq!(result.metadata["aborted"], true);
        assert_eq!(result.metadata["thought"], "流中被 abort 的思考片段");
    }

    /// 纯思考流 + error stop → Message，思考内容不丢，stopReason 标记为 error（BC02-2）
    #[test]
    fn thought_with_error_stop_yields_message() {
        let result = consume(
            vec![
                ProviderStreamEvent::thought("思考到一半发生错误", None),
                ProviderStreamEvent::Stop {
                    reason: StopReason::Error,
                    error: Some("网络连接重置".to_string()),
                    error_kind: Some(ProviderErrorKind::Timeout),
                    usage: None,
                },
            ],
            false,
        );
        assert!(
            result.response.is_message(),
            "有思考内容且发生 error stop 时必须产出 Message"
        );
        assert_eq!(
            result.stop_reason(),
            Some(ConsumeStopReason::Error {
                kind: ProviderErrorKind::Timeout,
                message: "网络连接重置".to_string(),
                retryable: true,
            })
        );
        assert_eq!(result.metadata["stopReason"], "error");
        assert_eq!(result.metadata["thought"], "思考到一半发生错误");
        assert_eq!(result.metadata["providerError"], "网络连接重置");
        assert_eq!(result.metadata["providerErrorKind"], "timeout");
    }

    /// BC02-2：tool-call + error stop → 严禁盖写为 ToolCall，必须为 Error 终态变体！
    #[test]
    fn tool_call_then_error_stop_yields_error_stop_reason_not_tool_call() {
        let result = consume(
            vec![
                ProviderStreamEvent::tool_call(
                    Some("call_1".into()),
                    "execute_command",
                    serde_json::json!({"cmd": "rm -rf /"}),
                ),
                ProviderStreamEvent::Stop {
                    reason: StopReason::Error,
                    error: Some("连接异常中断".to_string()),
                    error_kind: Some(ProviderErrorKind::Network),
                    usage: None,
                },
            ],
            false,
        );
        assert_eq!(
            result.stop_reason(),
            Some(ConsumeStopReason::Error {
                kind: ProviderErrorKind::Network,
                message: "连接异常中断".to_string(),
                retryable: true,
            }),
            "有 tool-call 时发生 error 严禁被盖写为 ToolCall！"
        );
        assert_eq!(result.metadata["stopReason"], "error");
    }

    /// BC02-1：纯 error stop 携带 RateLimit 时，无损透传原始分类（保留精确 kind 与 retryable），杜绝被折叠为 Unknown fatal
    #[test]
    fn pure_error_stop_with_rate_limit_preserves_error_kind() {
        let result = consume(
            vec![ProviderStreamEvent::Stop {
                reason: StopReason::Error,
                error: Some("429 Too Many Requests".to_string()),
                error_kind: Some(ProviderErrorKind::RateLimit),
                usage: None,
            }],
            false,
        );
        let ProviderOutput::StreamError { classified } = &result.response else {
            panic!("应为 StreamError，得到 {:?}", result.response);
        };
        assert_eq!(
            classified.kind,
            ProviderErrorKind::RateLimit,
            "429 RateLimit 错误必须保全精确分类"
        );
        assert!(classified.retryable, "RateLimit 必须可重试");
        assert_eq!(classified.message, "429 Too Many Requests");
    }

    /// BC02-3：网络诊断事件（如 SseFirstByte）绝不能破坏空流有效载荷判定
    #[test]
    fn diagnostic_does_not_break_has_salvageable_content() {
        let mut builder = ConsumeBuilder::new();
        assert!(!builder.has_salvageable_content());
        assert!(builder.is_empty());

        // 推入网络诊断事件
        builder.push(ProviderStreamEvent::ProviderDiagnostic {
            diagnostic: ProviderDiagnostic {
                reason: Some("首字节就绪".to_string()),
                ..Default::default()
            },
        });

        // 诊断事件绝不能破坏空流判定
        assert!(
            !builder.has_salvageable_content(),
            "仅有诊断事件时不得视为有效正文载荷"
        );
        assert!(
            builder.is_empty(),
            "仅有诊断事件时 is_empty 必须返回 true"
        );

        // 推入正文增量后成为有效载荷
        builder.push(ProviderStreamEvent::text("正文内容"));
        assert!(builder.has_salvageable_content());
        assert!(!builder.is_empty());
    }
}
