use conex_types::error::ProviderErrorKind;
use conex_types::tool::ProviderDiagnostic;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::types::{ModelRequestInfo, ModelResponseInfo, ProviderUsage, StopReason};
use crate::error::classify_provider_error;

/// 低级流事件（wire 层唯一出口，02 §1.1 表；所有 provider 解析器必须归一为此 5 种）
///
/// 约束（02 §六.9-10）：
/// - 每流恰好一个 `stop` 且必须是最后的事件（由 [StreamParser] 状态机保证）；
/// - `tool-call` 为完整调用一次性产出，无增量阶段（02 §六.9）；
/// - `thought-delta` 保留 `redacted` 标志（02 §六.10；Responses 的 reasoning 事件必须标 true）。
///
/// 说明：`provider-diagnostic` 变体携带完整的 conex-types ProviderDiagnostic（体积最大），
/// 事件按值短暂传递、跨进程序列化是主用途，装箱会破坏调用方 API 形态，
/// 故显式允许 large_enum_variant（与 conex-types 的 AgentEvent 同理由）。
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
        /// 是否脱敏（Responses reasoning 事件为 true；Anthropic 不标）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        redacted: Option<bool>,
    },
    /// 完整工具调用（一次性产出，无增量阶段，02 §六.9）
    #[serde(rename_all = "camelCase")]
    ToolCall {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        /// toolName
        tool_name: String,
        /// input：调用参数（对象）
        input: serde_json::Value,
    },
    /// 观测诊断（复用 conex-types 的 ProviderDiagnostic）
    #[serde(rename_all = "camelCase")]
    ProviderDiagnostic { diagnostic: ProviderDiagnostic },
    /// 请求前（M14：model.beforeRequest 事件源；重试循环每次尝试前发射）
    #[serde(rename = "before-request", rename_all = "camelCase")]
    BeforeRequest { info: ModelRequestInfo },
    /// 响应后（M14：model.afterResponse 事件源；每次尝试结束后发射，
    /// 成功/失败均触发）
    #[serde(rename = "after-response", rename_all = "camelCase")]
    AfterResponse { info: ModelResponseInfo },
    /// 终止事件，每流恰好一个（02 §六.9）
    #[serde(rename_all = "camelCase")]
    Stop {
        reason: StopReason,
        /// 错误文案（reason=error 时携带）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        /// 错误分类（reason=error 时携带；G1-c / 轮次 3 T3.3）
        ///
        /// 流中错误经统一分类管线归类后的 [ProviderErrorKind] 13 类：
        /// - 读取错误（error 帧 / 传输 / 超时）→ 按 [classify_provider_error] 分类；
        /// - 解析层保护错误（空流 / 无终态帧 / invalid-stream）→ [ProviderErrorKind::Unknown]
        ///   （不可重试语义保持）；
        /// - 无错误（stop/tool-call/length）→ None。
        ///
        /// Option + `#[serde(default)]`：缺省为 None，既有消费方（session-loop stream.rs
        /// :149-162、适配层 to_loop_event）编译与 wire 形状不受影响，对接时透传。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_kind: Option<ProviderErrorKind>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<ProviderUsage>,
    },
}

/// 流中错误的 error_kind 分类（G1-c / 轮次 3 T3.3；Stop 事件构造点统一入口）
///
/// - 提供方 error 帧文案（读取/服务端错误）→ 走 [classify_provider_error] 统一分类
///   管线（消息模式兜底），与 consume 侧任务书 D7 §3.7 的 metadata.providerErrorKind
///   分类同源镜像，保证 Stop.error_kind 与消费侧分类一致；
/// - 解析层保护错误（空流、无终态帧等）不调用本函数，由构造点直接给
///   [ProviderErrorKind::Unknown]。
pub fn stream_error_kind(message: &str) -> ProviderErrorKind {
    classify_provider_error(None, Some(message), None, None).kind()
}

/// 流状态（[StreamParser] 内部状态机）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum StreamPhase {
    /// 流进行中
    #[default]
    Active,
    /// 已收到 stop，流已终结
    Stopped,
}

/// 流事件序列校验错误（02 §六.9：每流恰好一个 stop）
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum StreamParseError {
    /// stop 之后继续产出事件
    #[error("流已以 stop 终结，不能再产出事件")]
    EventAfterStop,
    /// 重复 stop
    #[error("每个流恰好一个 stop 事件，收到第二个 stop")]
    DuplicateStop,
}

/// 每流恰好一个 stop 的状态机包装器（02 §六.9）
///
/// 用法：解析层把产出的事件逐个 `push` 进来；校验失败返回 [StreamParseError]，
/// 保证任何消费者拿到的序列至多一个 stop、且 stop 之后无任何事件。
#[derive(Debug, Default)]
pub struct StreamParser {
    phase: StreamPhase,
}

impl StreamParser {
    /// 新建处于活跃状态的解析器
    pub fn new() -> Self {
        Self::default()
    }

    /// 当前流是否已终结（收到过 stop）
    pub fn is_stopped(&self) -> bool {
        matches!(self.phase, StreamPhase::Stopped)
    }

    /// 校验并消费一个事件；stop 唯一性校验失败返回错误
    pub fn push(&mut self, event: ProviderStreamEvent) -> Result<(), StreamParseError> {
        match event {
            ProviderStreamEvent::Stop { .. } => {
                if matches!(self.phase, StreamPhase::Stopped) {
                    return Err(StreamParseError::DuplicateStop);
                }
                self.phase = StreamPhase::Stopped;
                Ok(())
            }
            _ => {
                if matches!(self.phase, StreamPhase::Stopped) {
                    return Err(StreamParseError::EventAfterStop);
                }
                Ok(())
            }
        }
    }

    /// 批量校验并消费事件；遇到错误立即返回（错误前已消费的事件保持生效）
    pub fn extend<I>(&mut self, events: I) -> Result<(), StreamParseError>
    where
        I: IntoIterator<Item = ProviderStreamEvent>,
    {
        for event in events {
            self.push(event)?;
        }
        Ok(())
    }

    /// 借用检查事件序列并推进状态，避免调用方全量深拷贝（Audit-13 §5.4）
    pub fn check_events(&mut self, events: &[ProviderStreamEvent]) -> Result<(), StreamParseError> {
        for event in events {
            match event {
                ProviderStreamEvent::Stop { .. } => {
                    if matches!(self.phase, StreamPhase::Stopped) {
                        return Err(StreamParseError::DuplicateStop);
                    }
                    self.phase = StreamPhase::Stopped;
                }
                _ => {
                    if matches!(self.phase, StreamPhase::Stopped) {
                        return Err(StreamParseError::EventAfterStop);
                    }
                }
            }
        }
        Ok(())
    }
}
