use conex_types::response::ProviderOutput;
use conex_types::tool::ProviderDiagnostic;
use serde::{Deserialize, Serialize};
use serde_json::Value;

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
