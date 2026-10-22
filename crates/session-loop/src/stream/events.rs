//! provider 流事件与消费结果类型（StopReason / ProviderUsage / ProviderStreamEvent / ConsumeResult 等）

use conex_types::error::ProviderErrorKind;
use conex_types::response::ProviderOutput;
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
