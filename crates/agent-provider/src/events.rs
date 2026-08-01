//! 低级流事件与合同类型（任务书 B2.4；02-provider-semantics.md §1.1、§六.9-10）
//!
//! [ProviderStreamEvent] 5 种 + [ProviderUsage] + [StopReason]，对齐 TS 端
//! `shared:tool.ts:295-305`（唯一 wire 出口，三家 API 统一归一）。
//!
//! 类型约束（02 §六.9）：每流恰好一个 `stop`，且 stop 之后不得再有任何事件；
//! 由 [StreamParser] 状态机包装器保证——收到第二个 stop 返回错误。

use conex_types::tool::ProviderDiagnostic;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// stop 原因（02 §1.1：stop|tool-call|length|error）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StopReason {
    /// 正常结束（finish_reason=stop/null 等）
    Stop,
    /// 工具调用收尾（finish_reason=tool_calls/function_call，或流内有工具调用）
    ToolCall,
    /// 长度截断（finish_reason=length / max_tokens / status=incomplete）
    Length,
    /// 错误收尾（解析异常、服务端错误帧、空流保护等）
    Error,
}

/// 用量统计（对齐 shared:tool.ts:286-293 的 ProviderUsage）
///
/// 字段序列化为 camelCase（promptTokens/completionTokens/…）；wire 层的
/// `prompt_tokens??input_tokens` 归一（02 §2.5）由解析层负责，本类型不感知。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    /// promptTokens：提示词 token 数
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_tokens: Option<u64>,
    /// completionTokens：生成 token 数
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_tokens: Option<u64>,
    /// totalTokens：总数
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
    /// cacheReadTokens：缓存命中读取
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<u64>,
    /// cacheWriteTokens：缓存写入
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<u64>,
    /// reasoningTokens：推理 token 数
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u64>,
}

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
    /// 终止事件，每流恰好一个（02 §六.9）
    #[serde(rename_all = "camelCase")]
    Stop {
        reason: StopReason,
        /// 错误文案（reason=error 时携带）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<ProviderUsage>,
    },
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_types::tool::ProviderDiagnostic;

    fn text_event() -> ProviderStreamEvent {
        ProviderStreamEvent::TextDelta {
            text: "你好".into(),
        }
    }

    fn stop_event(reason: StopReason) -> ProviderStreamEvent {
        ProviderStreamEvent::Stop {
            reason,
            error: None,
            usage: None,
        }
    }

    fn diagnostic_event() -> ProviderStreamEvent {
        ProviderStreamEvent::ProviderDiagnostic {
            diagnostic: ProviderDiagnostic {
                phase: conex_types::tool::ProviderDiagnosticPhase::SseFirstByte,
                ..ProviderDiagnostic::default()
            },
        }
    }

    #[test]
    fn serde_roundtrip_all_variants() {
        let events = vec![
            text_event(),
            ProviderStreamEvent::ThoughtDelta {
                text: "思考".into(),
                redacted: Some(true),
            },
            ProviderStreamEvent::ThoughtDelta {
                text: "思考".into(),
                redacted: None,
            },
            ProviderStreamEvent::ToolCall {
                id: Some("call_1".into()),
                tool_name: "read_file".into(),
                input: serde_json::json!({ "path": "/tmp/a" }),
            },
            diagnostic_event(),
            stop_event(StopReason::Stop),
            stop_event(StopReason::ToolCall),
            stop_event(StopReason::Length),
            stop_event(StopReason::Error),
        ];
        for event in events {
            let json = serde_json::to_string(&event).unwrap();
            let back: ProviderStreamEvent = serde_json::from_str(&json).unwrap();
            assert_eq!(event, back, "roundtrip 失败: {json}");
        }
    }

    #[test]
    fn serde_wire_names_match_ts() {
        // 顶层 type 为 kebab-case，字段为 camelCase（对齐 shared:tool.ts）
        let event = ProviderStreamEvent::ThoughtDelta {
            text: "x".into(),
            redacted: Some(true),
        };
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "type": "thought-delta", "text": "x", "redacted": true })
        );

        let event = ProviderStreamEvent::ToolCall {
            id: None,
            tool_name: "read_file".into(),
            input: serde_json::json!({}),
        };
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "type": "tool-call", "toolName": "read_file", "input": {} })
        );

        let event = stop_event(StopReason::ToolCall);
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "type": "stop", "reason": "tool-call" })
        );
    }

    #[test]
    fn stop_reason_wire_names() {
        for (reason, expected) in [
            (StopReason::Stop, "stop"),
            (StopReason::ToolCall, "tool-call"),
            (StopReason::Length, "length"),
            (StopReason::Error, "error"),
        ] {
            assert_eq!(
                serde_json::to_value(reason).unwrap(),
                serde_json::json!(expected)
            );
        }
    }

    #[test]
    fn usage_serializes_camel_case() {
        let usage = ProviderUsage {
            prompt_tokens: Some(10),
            completion_tokens: None,
            total_tokens: Some(20),
            cache_read_tokens: Some(5),
            cache_write_tokens: None,
            reasoning_tokens: Some(8),
        };
        let value = serde_json::to_value(&usage).unwrap();
        assert_eq!(value["promptTokens"], 10);
        assert_eq!(value["totalTokens"], 20);
        assert_eq!(value["cacheReadTokens"], 5);
        assert_eq!(value["reasoningTokens"], 8);
        assert!(value.get("completionTokens").is_none(), "None 字段应省略");
        let back: ProviderUsage = serde_json::from_value(value).unwrap();
        assert_eq!(usage, back);
    }

    #[test]
    fn stop_event_carries_error_and_usage() {
        let event = ProviderStreamEvent::Stop {
            reason: StopReason::Error,
            error: Some("boom".into()),
            usage: Some(ProviderUsage {
                prompt_tokens: Some(1),
                ..ProviderUsage::default()
            }),
        };
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["error"], "boom");
        assert_eq!(value["usage"]["promptTokens"], 1);
    }

    #[test]
    fn parser_accepts_single_stop() {
        let mut parser = StreamParser::new();
        assert!(!parser.is_stopped());
        parser.push(text_event()).unwrap();
        parser.push(stop_event(StopReason::Stop)).unwrap();
        assert!(parser.is_stopped());
    }

    #[test]
    fn parser_rejects_duplicate_stop() {
        let mut parser = StreamParser::new();
        parser.push(stop_event(StopReason::Stop)).unwrap();
        let error = parser.push(stop_event(StopReason::Error)).unwrap_err();
        assert_eq!(error, StreamParseError::DuplicateStop);
    }

    #[test]
    fn parser_rejects_event_after_stop() {
        let mut parser = StreamParser::new();
        parser.push(stop_event(StopReason::Length)).unwrap();
        assert_eq!(
            parser.push(text_event()).unwrap_err(),
            StreamParseError::EventAfterStop
        );
        assert_eq!(
            parser
                .push(ProviderStreamEvent::ToolCall {
                    id: None,
                    tool_name: "x".into(),
                    input: serde_json::json!({}),
                })
                .unwrap_err(),
            StreamParseError::EventAfterStop
        );
        assert!(parser.is_stopped());
    }

    #[test]
    fn parser_allows_diagnostics_anytime_before_stop() {
        let mut parser = StreamParser::new();
        parser.push(diagnostic_event()).unwrap();
        parser.push(text_event()).unwrap();
        parser.push(diagnostic_event()).unwrap();
        parser.push(stop_event(StopReason::Stop)).unwrap();
        assert!(parser.is_stopped());
    }

    #[test]
    fn parser_extend_stops_at_first_error() {
        let mut parser = StreamParser::new();
        let events = vec![text_event(), stop_event(StopReason::Stop), text_event()];
        let error = parser.extend(events).unwrap_err();
        assert_eq!(error, StreamParseError::EventAfterStop);
        assert!(parser.is_stopped());
    }

    #[test]
    fn parser_extend_empty_is_ok() {
        let mut parser = StreamParser::new();
        parser.extend(Vec::<ProviderStreamEvent>::new()).unwrap();
        assert!(!parser.is_stopped());
    }
}
