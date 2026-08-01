//! Provider 输出分类类型域（02-provider-semantics.md §五.12 裁决）
//!
//! 模型输出与传输错误分离：响应含文字或 tool-call 即视为有效模型输出
//! `Message`（纯文字永不失败，01 §五.3）；无任何内容为 `Empty`；
//! 仅「无文字且无 tool-call 且 stopReason=error」归入 `StreamError`。

use serde::{Deserialize, Serialize};

use crate::error::ProviderErrorKind;
use crate::message::ToolCallBlock;

/// 已分类的流错误（02 §4.1 分类管线产物：kind + retryable）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClassifiedStreamError {
    /// 02 §4.2 分类表 13 类
    pub kind: ProviderErrorKind,
    /// 错误描述
    pub message: String,
    /// 02 §4.2 默认重试矩阵
    pub retryable: bool,
    /// 429 限流时服务端建议的等待时长（毫秒，Retry-After）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
}

/// Provider 响应分类（02 §五.12 裁决 + 01 §五.3）
///
/// - `Message`：含文字或 tool-call 即有效输出，直接 commit 并走正常
///   turn-complete；error 降级为 metadata 标注，不标 stopReason=error。
/// - `Empty`：无 block 且无 error（空响应 → STEERING_NEEDED 路径）。
/// - `StreamError`：无文字且无 tool-call 的传输/服务端错误，
///   进入分类重试阶梯（瞬态 3 次 / payload 2 次 / length 升级 2 次）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ProviderOutput {
    /// 有效模型输出（text 可空：纯工具调用消息）
    #[serde(rename_all = "camelCase")]
    Message {
        text: String,
        tool_calls: Vec<ToolCallBlock>,
    },
    /// 空响应
    Empty,
    /// 传输/服务端错误（已分类）
    #[serde(rename_all = "camelCase")]
    StreamError {
        classified: ClassifiedStreamError,
    },
}

impl ProviderOutput {
    /// 构造有效模型输出
    pub fn message(text: impl Into<String>, tool_calls: Vec<ToolCallBlock>) -> Self {
        ProviderOutput::Message {
            text: text.into(),
            tool_calls,
        }
    }

    /// 构造空响应
    pub fn empty() -> Self {
        ProviderOutput::Empty
    }

    /// 构造已分类流错误
    pub fn stream_error(classified: ClassifiedStreamError) -> Self {
        ProviderOutput::StreamError { classified }
    }

    /// 是否为有效模型输出（含文字或 tool-call）
    pub fn is_message(&self) -> bool {
        matches!(self, ProviderOutput::Message { .. })
    }

    /// 是否含工具调用
    pub fn has_tool_calls(&self) -> bool {
        matches!(
            self,
            ProviderOutput::Message { tool_calls, .. } if !tool_calls.is_empty()
        )
    }

    /// 取文字正文（非 Message 返回空串）
    pub fn text(&self) -> &str {
        match self {
            ProviderOutput::Message { text, .. } => text,
            _ => "",
        }
    }
}
