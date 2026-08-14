//! Azure OpenAI Responses API SSE 流解析器（T5.1 G7-b 边缘协议先例）
//!
//! 协议同一性结论（架构纪律：复用 > 复制）：
//! azure-openai-responses 与 openai-responses 的 SSE wire 形状**完全一致**——pi-ai 的
//! `azure-openai-responses.js:91` 直接复用 `openai-responses-shared.js` 的
//! `processResponsesStream`（与 openai-responses 同一条解析路径），事件集合逐项对齐：
//! `response.output_text.delta` / `response.reasoning_summary_text.delta` |
//! `response.reasoning_text.delta` | `response.reasoning.delta` /
//! `response.output_item.added|done` / `response.function_call_arguments.delta|done` /
//! `response.completed|failed|incomplete` / 帧级 `error`。因此本先例**不复刻内核**，
//! 直接委托既有 [super::responses::ResponsesParser]（100% 复用，零复制粘贴）。
//!
//! 差异点清单（契约登记；均在复用层已收敛，包装层零改核）：
//! 1. **错误帧形状**：azure 由 OpenAI SDK 产出 `{"type":"error","code":"…","message":"…"}`
//!    （`processResponsesStream` 的 `Error Code ${code}: ${message}`）。既有
//!    [super::responses::responses_core] 错误帧处理链 `response_error → message → code`
//!    已覆盖：无 `error` 字段时回退 `message`、再回退 `code`，文案归一取 message。
//!    包装层追加断言测试钉住该形状收敛（[self] 测试 `azure_error_frame_*`）。
//! 2. **usage 字段名**：azure/reponses 均为
//!    `input_tokens`/`output_tokens`/`total_tokens` + `input_tokens_details.{cached_tokens,
//!    cache_write_tokens}` + `output_tokens_details.reasoning_tokens`。既有
//!    [super::chat::parse_usage]（chat 与 responses 同构）已将 `input_tokens??prompt_tokens`、
//!    `output_tokens??completion_tokens`、hit/write 别名链、reasoning 全部收敛到
//!    [ProviderUsage]。包装层不重写 usage。
//! 3. **C14 语义**：`input = prompt - cache_read - cache_write` 是**派生量**，按
//!    events.rs:35-40 裁决由解析层保留原始 `prompt_tokens` + `cache_read`/`cache_write`，
//!    消费侧经 [ProviderUsage::cache_breakdown](crate::events::CacheAccounting::Included)
//!    推导（Included 轨，azure 属 OpenAI 系）——本解析器与 responses 一致地保留原始值，
//!    不自行减法。包装层提供 [AzureResponsesParser::cache_breakdown] 便捷归一访问器。
//! 4. **终态映射**：`response.completed|incomplete|failed` 的 `response.status` 走
//!    [super::responses::response_status_to_stop]（incomplete→length、failed/cancelled→error、
//!    其余→stop），azure 与 openai 一致，包装层直接透传。
//!
//! 协议路由接线说明：RESPONSES 轨已有的 [super::responses::ResponsesParser] 已能消费
//! azure 同形状流；[AzureResponsesParser] 作为 azure-openai-responses 协议面的**独立
//! 身份类型**暴露（供 dispatch 命名与审计区分），帧处理全量委托内核。

use crate::events::{
    CacheAccounting, CacheBreakdown, ProviderStreamEvent, ProviderUsage, StreamParseError,
};
use crate::sse::frame::SseFrame;

use super::responses::ResponsesParser;

/// Azure OpenAI Responses API 流解析器（SseFrame → ProviderStreamEvent 序列）
///
/// 浅层包装 [ResponsesParser] 内核：wire 同构（见模块文档差异清单），全部帧分发 /
/// 终态 / usage 覆盖式 / 工具调用分组去重均委托内核，本类型只审计 / 暴露 azure 便捷面。
#[derive(Debug, Default)]
pub struct AzureResponsesParser {
    /// 复用内核：openai-responses 同形状状态机
    inner: ResponsesParser,
}

impl AzureResponsesParser {
    /// 新建解析器（协议面身份入口）
    pub fn new() -> Self {
        Self::default()
    }

    /// 是否已终结（错误帧或 finish 后；透传内核）
    pub fn is_terminated(&self) -> bool {
        self.inner.is_terminated()
    }

    /// 当前覆盖到的 usage（透传内核）
    pub fn usage(&self) -> Option<&ProviderUsage> {
        self.inner.usage()
    }

    /// 归一净输入便捷访问器（C14 语义，Included 轨派生；见模块文档差异 3）
    ///
    /// 消费侧若需计费/测量口径可直接取净输入而不自算：
    /// `net = prompt - cache_read - cache_write`（derive，非改写原始上报值）。
    pub fn cache_breakdown(&self) -> Option<CacheBreakdown> {
        self.usage()?.cache_breakdown(CacheAccounting::Included)
    }

    /// 处理一帧，产出该帧触发的事件（全部委托复用内核）
    pub fn push_frame(
        &mut self,
        frame: &SseFrame,
    ) -> Result<Vec<ProviderStreamEvent>, StreamParseError> {
        self.inner.push_frame(frame)
    }

    /// 流结束收尾（唯一 stop；委托复用内核）
    pub fn finish(&mut self) -> Result<Vec<ProviderStreamEvent>, StreamParseError> {
        self.inner.finish()
    }
}

#[cfg(test)]
#[path = "azure_responses_tests.rs"]
mod tests;
