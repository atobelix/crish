//! 解析核心域（SR-06e · 拆分 · ≠ EL）
//!
//! 从 parse/gemini.rs 拆出的实现域：[GeminiParser] 状态机——帧分发
//! （[GeminiParser::push_frame]）、流收尾（[GeminiParser::finish] / 空流保护 /
//! 强制 tool-call），消费 [super::gemini_map] 的转换与映射函数。
//!
//! 门面（parse/gemini.rs）re-export [GeminiParser]，对外路径不变。

use serde_json::Value;

use conex_types::error::ProviderErrorKind;

use crate::events::{
    stream_error_kind, ProviderStreamEvent, ProviderUsage, StopReason, StreamParseError,
    StreamParser,
};
use crate::sse::frame::SseFrame;

use super::super::think_tags::StreamingTagExtractor;
use super::gemini_map::{
    gemini_finish_reason_to_stop, gemini_payload_error, has_candidates, merge_gemini_usage,
    non_empty_string, normalize_function_args, parse_gemini_usage, prompt_block_reason,
    string_field,
};

/// Gemini 流解析器（SseFrame → ProviderStreamEvent 序列）
#[derive(Debug)]
pub struct GeminiParser {
    /// 每流恰好一个 stop 的状态机（02 §六.9）
    stream: StreamParser,
    /// 当前 stop_reason（默认 stop，32-35）
    stop_reason: StopReason,
    /// 逐帧合并后的 usage（usageMetadata 为累计值）
    usage: Option<ProviderUsage>,
    /// 是否已产出过内容事件（text/thought/tool-call，空流保护判定）
    emitted_content: bool,
    /// 是否已见过终态帧（finishReason 非空，空流保护判定）
    saw_terminal: bool,
    /// 工具调用计数（id 兜底 `gemini_fc_{n}` 与强制 tool-call 判定）
    tool_call_count: u64,
    /// finishReason 映射出的错误文案（reason=error 时携带）
    stream_error: Option<String>,
    /// 已终结（错误帧或 finish 后）
    terminated: bool,
    /// 内嵌思考标签实时提取器（B2.5 / Markdown Stream Refactor）
    tag_extractor: StreamingTagExtractor,
}

impl Default for GeminiParser {
    fn default() -> Self {
        Self {
            stream: StreamParser::new(),
            stop_reason: StopReason::Stop,
            usage: None,
            emitted_content: false,
            saw_terminal: false,
            tool_call_count: 0,
            stream_error: None,
            terminated: false,
            tag_extractor: StreamingTagExtractor::default(),
        }
    }
}

impl GeminiParser {
    /// 新建解析器
    pub fn new() -> Self {
        Self::default()
    }

    /// 是否已终结（错误帧或 finish 后）
    pub fn is_terminated(&self) -> bool {
        self.terminated
    }

    /// 当前合并到的 usage（stop 事件携带用）
    pub fn usage(&self) -> Option<&ProviderUsage> {
        self.usage.as_ref()
    }

    /// 处理一帧，产出该帧触发的事件
    ///
    /// 分帧层（sse/frame.rs）已保证 data 为合法 JSON 对象或 `[DONE]` 哨兵；
    /// 此处防御性解析失败仅跳过不炸流。
    pub fn push_frame(
        &mut self,
        frame: &SseFrame,
    ) -> Result<Vec<ProviderStreamEvent>, StreamParseError> {
        if self.terminated {
            return Ok(Vec::new());
        }
        let Some(data) = frame.data.as_deref() else {
            return Ok(Vec::new());
        };
        let Ok(payload) = serde_json::from_str::<Value>(data) else {
            return Ok(Vec::new());
        };
        let items: Vec<&serde_json::Map<String, Value>> = match &payload {
            Value::Object(map) => vec![map],
            Value::Array(arr) => arr.iter().filter_map(Value::as_object).collect(),
            _ => return Ok(Vec::new()),
        };
        let mut events = Vec::new();

        for payload in items {
            if self.terminated {
                break;
            }
            // 顶层 error 对象（部分代理 / API 错误帧，48-58）→ 立即终止
            if let Some(error) = gemini_payload_error(payload) {
                let kind = stream_error_kind(&error);
                events.push(ProviderStreamEvent::Stop {
                    reason: StopReason::Error,
                    error: Some(error),
                    error_kind: Some(kind),
                    usage: self.usage.clone(),
                });
                self.terminated = true;
                break;
            }

            // promptFeedback.blockReason 且无 candidates → blocked（60-71、398-414）
            if let Some(block) = prompt_block_reason(payload) {
                if !has_candidates(payload) {
                    let block_usage =
                        parse_gemini_usage(payload.get("usageMetadata")).or_else(|| self.usage.clone());
                    let kind = stream_error_kind(&block);
                    events.push(ProviderStreamEvent::Stop {
                        reason: StopReason::Error,
                        error: Some(block),
                        error_kind: Some(kind),
                        usage: block_usage,
                    });
                    self.terminated = true;
                    break;
                }
            }

            // usageMetadata 每帧合并（73-76、456-479；02 §六.6：Gemini 逐帧合并）
            if let Some(chunk) = parse_gemini_usage(payload.get("usageMetadata")) {
                self.usage = Some(merge_gemini_usage(self.usage.as_ref(), &chunk));
            }

            // candidates[].content.parts[]（78-139）；注意 Gemini 遍历全部 candidates（与 chat 仅取首个不同）
            if let Some(candidates) = payload.get("candidates").and_then(Value::as_array) {
                for raw in candidates {
                    let Some(candidate) = raw.as_object() else {
                        continue;
                    };
                    let parts = candidate
                        .get("content")
                        .and_then(Value::as_object)
                        .and_then(|content| content.get("parts"))
                        .and_then(Value::as_array);
                    if let Some(parts) = parts {
                        for raw_part in parts {
                            let Some(part) = raw_part.as_object() else {
                                continue;
                            };
                            // thought 部分（96-104）：thought===true 且带 text → thought-delta
                            if part.get("thought").and_then(Value::as_bool) == Some(true) {
                                if let Some(text) = non_empty_string(part.get("text")) {
                                    self.emitted_content = true;
                                    events.push(ProviderStreamEvent::ThoughtDelta {
                                        text: text.to_owned(),
                                        redacted: None,
                                    });
                                }
                                continue;
                            }
                            // 正文部分（106-110）
                            if let Some(text) = non_empty_string(part.get("text")) {
                                self.emitted_content = true;
                                let extracted = self.tag_extractor.push_text(text);
                                events.extend(extracted);
                                continue;
                            }
                            // functionCall / function_call 完整调用一次性产出（112-138）
                            let function_call = part
                                .get("functionCall")
                                .and_then(Value::as_object)
                                .or_else(|| part.get("function_call").and_then(Value::as_object));
                            if let Some(function_call) = function_call {
                                // 缺 name 丢弃（对齐 TS `if (!name) continue`，120-123）
                                let Some(name) = string_field(function_call.get("name")) else {
                                    continue;
                                };
                                self.emitted_content = true;
                                self.tool_call_count += 1;
                                let args = normalize_function_args(
                                    function_call
                                        .get("args")
                                        .filter(|value| !value.is_null())
                                        .or_else(|| {
                                            function_call
                                                .get("arguments")
                                                .filter(|value| !value.is_null())
                                        }),
                                );
                                let id = string_field(function_call.get("id"))
                                    .or_else(|| string_field(function_call.get("call_id")))
                                    .or_else(|| string_field(function_call.get("callId")))
                                    .map(str::to_owned)
                                    .unwrap_or_else(|| format!("gemini_fc_{}", self.tool_call_count));
                                events.push(ProviderStreamEvent::ToolCall {
                                    id: Some(id),
                                    tool_name: name.to_owned(),
                                    input: args,
                                });
                            }
                        }
                    }
                    // finishReason 映射（141-154、305-336；null/缺失不触发）
                    if let Some(finish_reason) = candidate.get("finishReason") {
                        if !finish_reason.is_null() {
                            self.saw_terminal = true;
                            let mapped = gemini_finish_reason_to_stop(
                                finish_reason.as_str(),
                                self.tool_call_count > 0,
                            );
                            self.stop_reason = mapped.0;
                            if let Some(error) = mapped.1 {
                                self.stream_error = Some(error);
                            }
                        }
                    }
                }
            }
        }

        self.stream.check_events(&events)?;
        Ok(events)
    }

    /// 流结束：强制 tool-call → 空流保护 → 唯一 stop
    ///
    /// 对齐 TS 158-187：先强制 tool-call（158-160），再空流保护（162-169），
    /// reason=error 时携带错误文案（171-187）。
    pub fn finish(&mut self) -> Result<Vec<ProviderStreamEvent>, StreamParseError> {
        if self.terminated {
            return Ok(Vec::new());
        }
        let mut events = Vec::new();
        // 冲刷标签状态机未决的缓冲区
        let remaining_tag_events = self.tag_extractor.finish();
        if !remaining_tag_events.is_empty() {
            self.emitted_content = true;
            events.extend(remaining_tag_events);
        }
        // 有工具调用且 reason 为 stop → 强制 tool-call（158-160）
        if self.tool_call_count > 0 && self.stop_reason == StopReason::Stop {
            self.stop_reason = StopReason::ToolCall;
        }
        // 空流保护（162-169）：无内容事件且无终态帧且无 usage → error
        // （解析层保护错误 → error_kind=Unknown，不可重试语义保持）
        if !self.emitted_content && !self.saw_terminal && self.usage.is_none() {
            events.push(ProviderStreamEvent::Stop {
                reason: StopReason::Error,
                error: Some(
                    "Gemini streaming response completed without content events".to_string(),
                ),
                error_kind: Some(ProviderErrorKind::Unknown),
                usage: None,
            });
        } else {
            // reason=error 时携带 streamError（171-187）
            let error = if self.stop_reason == StopReason::Error {
                self.stream_error.clone()
            } else {
                None
            };
            events.push(ProviderStreamEvent::Stop {
                reason: self.stop_reason,
                error,
                error_kind: match self.stream_error.as_deref() {
                    Some(err) => Some(stream_error_kind(err)),
                    // 正常终态（stop/tool-call/length）无错误分类
                    None => None,
                },
                usage: self.usage.clone(),
            });
        }
        self.stream.check_events(&events)?;
        self.terminated = true;
        Ok(events)
    }
}
