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
    /// cacheMissTokens：缓存未命中输入（DeepSeek 顶层 prompt_cache_miss_tokens；
    /// 其余协议族由 [ProviderUsage::cache_breakdown] 按口径推导，此处可为 None）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_miss_tokens: Option<u64>,
    /// reasoningTokens：推理 token 数
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u64>,
}

/// 协议族口径标记（LiteLLM 双命名空间：prompt 是否已含缓存，P2 §3.3 D）
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

/// 归一化派生结果（唯一口径入口，P5 测量/成本直接消费；C9）
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

/// model 请求信息（`before-request` 载荷，M14：model.beforeRequest 事件源）
///
/// 请求前发射点装配（引擎侧接线位）：url/model/max_tokens 由请求构建
/// 完成后填充；`attempt` 为第几次尝试（重试循环内从 1 起）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRequestInfo {
    /// 请求 URL（endpoint）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// 生效模型名
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// 本次调用 max_tokens（None = 未限制）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
    /// 第几次尝试（1 起；重试循环内每次尝试递增）
    pub attempt: u32,
}

/// model 响应信息（`after-response` 载荷，M14：model.afterResponse 事件源）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelResponseInfo {
    /// HTTP 状态码（流前响应可观测；无 HTTP 层信息为 None）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    /// 本次尝试是否成功（2xx / 无错误）
    pub ok: bool,
    /// 失败文案（ok=false 时携带）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 单次尝试耗时（毫秒）
    pub duration_ms: u64,
    /// 响应用量（流成功收口时携带）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<ProviderUsage>,
}

/// model 请求生命周期观测器（M14：before-request / after-response 发射点
/// 消费面；I8 生态轮接 HookRegistry 的 model.beforeRequest / model.afterResponse
/// 钩子——本 trait 只观测不改写，失败不阻塞请求路径）
pub trait ModelRequestObserver: Send + Sync {
    /// 请求前回调（每次尝试发起前）
    fn on_before_request(&self, info: &ModelRequestInfo);
    /// 响应后回调（每次尝试结束后；成功/失败均触发）
    fn on_after_response(&self, info: &ModelResponseInfo);
}

impl ProviderUsage {
    /// 按协议族口径归一化派生缓存拆分（P2 §3.3 D；C9 口径真源）
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

/// 取两分片字段的较大值（next 存在且大于 prev 时取 next；防 0/部分值覆盖）
fn max_or(prev: Option<u64>, next: Option<u64>) -> Option<u64> {
    match (prev, next) {
        (Some(p), Some(n)) => Some(p.max(n)),
        (Some(p), None) => Some(p),
        (None, n) => n,
    }
}

/// 分片流式合并的 max 语义（P2 §3.3 D；02 §六.6 的延续裁决）
///
/// - 输入侧三字段（prompt/cacheRead/cacheWrite/cacheMiss）在分片间取 max，
///   防代理用 0/部分值覆盖 message_start 的完整 input（pi anthropic-messages.ts 同类防御）；
/// - completion/reasoning 侧维持"后到优先"（next 存在时取 next）；
/// - total 恒由最终合并结果重算（prompt/completion 任一存在时），否则回退显式 total
///   （next 优先，其次 prev）。
pub fn merge_usage_shards(prev: &ProviderUsage, next: &ProviderUsage) -> ProviderUsage {
    let prompt_tokens = max_or(prev.prompt_tokens, next.prompt_tokens);
    let cache_read_tokens = max_or(prev.cache_read_tokens, next.cache_read_tokens);
    let cache_write_tokens = max_or(prev.cache_write_tokens, next.cache_write_tokens);
    let cache_miss_tokens = max_or(prev.cache_miss_tokens, next.cache_miss_tokens);
    let completion_tokens = next.completion_tokens.or(prev.completion_tokens);
    let reasoning_tokens = next.reasoning_tokens.or(prev.reasoning_tokens);
    let total_tokens = if prompt_tokens.is_some() || completion_tokens.is_some() {
        Some(prompt_tokens.unwrap_or(0) + completion_tokens.unwrap_or(0))
    } else {
        next.total_tokens.or(prev.total_tokens)
    };
    ProviderUsage {
        prompt_tokens,
        completion_tokens,
        total_tokens,
        cache_read_tokens,
        cache_write_tokens,
        cache_miss_tokens,
        reasoning_tokens,
    }
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
            // M14：请求生命周期观测事件（before-request / after-response）
            ProviderStreamEvent::BeforeRequest {
                info: ModelRequestInfo {
                    url: Some("https://api.example.com/v1/chat/completions".into()),
                    model: Some("deepseek-v4".into()),
                    max_tokens: Some(4096),
                    attempt: 2,
                },
            },
            ProviderStreamEvent::AfterResponse {
                info: ModelResponseInfo {
                    status: Some(200),
                    ok: true,
                    error: None,
                    duration_ms: 812,
                    usage: Some(ProviderUsage {
                        prompt_tokens: Some(100),
                        ..ProviderUsage::default()
                    }),
                },
            },
            ProviderStreamEvent::AfterResponse {
                info: ModelResponseInfo {
                    status: Some(503),
                    ok: false,
                    error: Some("upstream down".into()),
                    duration_ms: 34,
                    usage: None,
                },
            },
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

    /// M14：before-request / after-response 的 wire 形状（kebab-case type +
    /// camelCase 字段，复用 ProviderStreamEvent 通道结构）
    #[test]
    fn model_lifecycle_wire_names() {
        let before = ProviderStreamEvent::BeforeRequest {
            info: ModelRequestInfo {
                url: None,
                model: Some("m".into()),
                max_tokens: None,
                attempt: 1,
            },
        };
        let value = serde_json::to_value(&before).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "type": "before-request",
                "info": { "model": "m", "attempt": 1 }
            })
        );

        let after = ProviderStreamEvent::AfterResponse {
            info: ModelResponseInfo {
                status: None,
                ok: false,
                error: Some("boom".into()),
                duration_ms: 5,
                usage: None,
            },
        };
        let value = serde_json::to_value(&after).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "type": "after-response",
                "info": { "ok": false, "error": "boom", "durationMs": 5 }
            })
        );
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
            cache_miss_tokens: Some(4),
            reasoning_tokens: Some(8),
        };
        let value = serde_json::to_value(&usage).unwrap();
        assert_eq!(value["promptTokens"], 10);
        assert_eq!(value["totalTokens"], 20);
        assert_eq!(value["cacheReadTokens"], 5);
        assert_eq!(value["cacheMissTokens"], 4);
        assert_eq!(value["reasoningTokens"], 8);
        assert!(value.get("completionTokens").is_none(), "None 字段应省略");
        let back: ProviderUsage = serde_json::from_value(value).unwrap();
        assert_eq!(usage, back);
    }

    #[test]
    fn usage_omits_none_cache_miss_tokens() {
        let usage = ProviderUsage {
            prompt_tokens: Some(10),
            ..ProviderUsage::default()
        };
        let value = serde_json::to_value(&usage).unwrap();
        assert!(
            value.get("cacheMissTokens").is_none(),
            "None 的 cacheMissTokens 应省略"
        );
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

    // ---- cache_breakdown：两种口径 + miss 优先值 + 钳 0（P2 §3.3 D、§5.1 测试组） ----

    fn usage_with_parts(
        prompt: Option<u64>,
        read: Option<u64>,
        write: Option<u64>,
    ) -> ProviderUsage {
        ProviderUsage {
            prompt_tokens: prompt,
            cache_read_tokens: read,
            cache_write_tokens: write,
            ..ProviderUsage::default()
        }
    }

    #[test]
    fn cache_breakdown_included() {
        // Included（OpenAI 系）：miss = prompt - read - write、input_total = prompt
        let usage = usage_with_parts(Some(100), Some(70), Some(10));
        let breakdown = usage.cache_breakdown(CacheAccounting::Included).unwrap();
        assert_eq!(
            breakdown,
            CacheBreakdown {
                read: 70,
                write: 10,
                miss: 20,
                input_total: 100
            }
        );
    }

    #[test]
    fn cache_breakdown_excluded() {
        // Excluded（Anthropic/Gemini 系）：miss = prompt、input_total = prompt + read + write
        let usage = usage_with_parts(Some(100), Some(70), Some(10));
        let breakdown = usage.cache_breakdown(CacheAccounting::Excluded).unwrap();
        assert_eq!(
            breakdown,
            CacheBreakdown {
                read: 70,
                write: 10,
                miss: 100,
                input_total: 180
            }
        );
    }

    #[test]
    fn cache_breakdown_none_read_write_are_zero() {
        // read/write 为 None 按 0 处理：两种口径下 miss/input_total 均等于 prompt
        let usage = usage_with_parts(Some(100), None, None);
        assert_eq!(
            usage.cache_breakdown(CacheAccounting::Included).unwrap(),
            CacheBreakdown {
                read: 0,
                write: 0,
                miss: 100,
                input_total: 100
            }
        );
        assert_eq!(
            usage.cache_breakdown(CacheAccounting::Excluded).unwrap(),
            CacheBreakdown {
                read: 0,
                write: 0,
                miss: 100,
                input_total: 100
            }
        );
    }

    #[test]
    fn cache_breakdown_miss_field_priority() {
        // DeepSeek 顶层 miss 字段优先：直接取服务端报告值，不依赖推导（两种口径一致）
        let usage = ProviderUsage {
            cache_miss_tokens: Some(15),
            ..usage_with_parts(Some(100), Some(70), Some(10))
        };
        assert_eq!(
            usage.cache_breakdown(CacheAccounting::Included).unwrap(),
            CacheBreakdown {
                read: 70,
                write: 10,
                miss: 15,
                input_total: 100
            }
        );
        assert_eq!(
            usage.cache_breakdown(CacheAccounting::Excluded).unwrap(),
            CacheBreakdown {
                read: 70,
                write: 10,
                miss: 15,
                input_total: 180
            }
        );
    }

    #[test]
    fn cache_breakdown_clamps_negative_miss() {
        // 推导结果为负时钳 0：prompt=10、read=15 → Included miss = 0
        let usage = usage_with_parts(Some(10), Some(15), Some(5));
        assert_eq!(
            usage.cache_breakdown(CacheAccounting::Included).unwrap(),
            CacheBreakdown {
                read: 15,
                write: 5,
                miss: 0,
                input_total: 10
            }
        );
    }

    #[test]
    fn cache_breakdown_requires_prompt() {
        // prompt 缺失时无输入侧数据可派 → None
        let usage = usage_with_parts(None, Some(70), Some(10));
        assert_eq!(usage.cache_breakdown(CacheAccounting::Included), None);
        assert_eq!(usage.cache_breakdown(CacheAccounting::Excluded), None);
    }

    // ---- merge_usage_shards：max 语义 + 后到优先 + total 重算（P2 §3.3 D、§5.1 测试组） ----

    #[test]
    fn merge_usage_shards_input_max_not_overridden_by_zero() {
        // 输入侧取 max：next 传 0 不覆盖 prev 的 100；read/write 同理防 0 覆盖
        let prev = usage_with_parts(Some(100), Some(50), Some(20));
        let next = usage_with_parts(Some(0), Some(60), Some(0));
        let merged = merge_usage_shards(&prev, &next);
        assert_eq!(
            merged.prompt_tokens,
            Some(100),
            "next 传 0 不应覆盖 prev 的 100"
        );
        assert_eq!(merged.cache_read_tokens, Some(60), "read 取较大值");
        assert_eq!(merged.cache_write_tokens, Some(20), "write 取较大值");
    }

    #[test]
    fn merge_usage_shards_input_fallback_and_miss_max() {
        // next 缺失时回退 prev；cache_miss_tokens 与输入侧同取 max
        let prev = ProviderUsage {
            cache_miss_tokens: Some(30),
            ..usage_with_parts(Some(100), Some(50), None)
        };
        let next = usage_with_parts(None, None, Some(0));
        let merged = merge_usage_shards(&prev, &next);
        assert_eq!(merged.prompt_tokens, Some(100));
        assert_eq!(merged.cache_read_tokens, Some(50));
        assert_eq!(merged.cache_write_tokens, Some(0));
        assert_eq!(merged.cache_miss_tokens, Some(30), "miss 取较大值");

        let next_lower = usage_with_parts(Some(80), None, None);
        assert_eq!(
            merge_usage_shards(&prev, &next_lower).prompt_tokens,
            Some(100)
        );
    }

    #[test]
    fn merge_usage_shards_completion_last_wins() {
        // completion 侧后到优先：next 存在时取 next，缺失回退 prev
        let mut prev = usage_with_parts(Some(100), None, None);
        prev.completion_tokens = Some(5);
        let mut next = usage_with_parts(Some(0), None, None);
        next.completion_tokens = Some(8);
        let merged = merge_usage_shards(&prev, &next);
        assert_eq!(merged.completion_tokens, Some(8), "completion 后到优先");

        let next_none = usage_with_parts(Some(90), None, None);
        assert_eq!(
            merge_usage_shards(&prev, &next_none).completion_tokens,
            Some(5),
            "next 缺失时回退 prev"
        );
    }

    #[test]
    fn merge_usage_shards_total_recompute() {
        // total 恒由合并后 prompt+completion 重算，忽略分片显式 total
        let mut prev = usage_with_parts(Some(100), None, None);
        prev.completion_tokens = Some(5);
        prev.total_tokens = Some(105);
        let mut next = usage_with_parts(Some(0), None, None);
        next.completion_tokens = Some(10);
        next.total_tokens = Some(10);
        let merged = merge_usage_shards(&prev, &next);
        assert_eq!(merged.total_tokens, Some(110), "total 重算 = 100 + 10");
    }

    #[test]
    fn merge_usage_shards_total_fallback_to_explicit() {
        // prompt/completion 均缺失时回退显式 total（next 优先，其次 prev）
        let mut prev = usage_with_parts(None, Some(50), None);
        prev.total_tokens = Some(7);
        let mut next = usage_with_parts(None, Some(60), None);
        next.total_tokens = Some(9);
        assert_eq!(merge_usage_shards(&prev, &next).total_tokens, Some(9));
        assert_eq!(
            merge_usage_shards(&next, &prev).total_tokens,
            Some(7),
            "prev 的显式 total 兜底"
        );
    }
}
