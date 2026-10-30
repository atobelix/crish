//! 解析核心域（SR-06e · 拆分 · ≠ EL）
//!
//! 从 parse/anthropic.rs 拆出的实现域：[AnthropicParser] 状态机——事件分发
//! （[AnthropicParser::push_frame]：message_start / content_block_* /
//! message_delta / message_stop / 错误帧）、流收尾（[AnthropicParser::finish] /
//! pending tool_use 防御性 flush / 空流保护），消费 [super::anthropic_map] 的
//! 转换与映射函数。
//!
//! 门面（parse/anthropic.rs）re-export [AnthropicParser]，对外路径不变。

use std::collections::BTreeMap;

use serde_json::Value;

use conex_types::error::ProviderErrorKind;

use crate::events::{
    stream_error_kind, ProviderStreamEvent, ProviderUsage, StopReason, StreamParseError,
    StreamParser,
};
use crate::sse::frame::SseFrame;

use super::super::tool_call::parse_arguments;
use super::anthropic_map::{
    anthropic_payload_error, anthropic_stop_reason_to_stop, merge_anthropic_usage,
    non_empty_string, number_field, parse_anthropic_usage, string_field,
};

/// pending 中的一条 tool_use 块（对齐 TS PendingToolUse 14-18）
#[derive(Debug, Clone)]
struct PendingToolUse {
    /// 调用 id（缺失兜底 `toolu_{index}`，02 §3.3 表）
    id: String,
    /// 工具名（缺失表示尚未捕获到 name）
    name: String,
    /// input_json_delta 追加拼接的 arguments JSON 片段
    arguments_text: String,
}

/// Anthropic Messages 流解析器（SseFrame → ProviderStreamEvent 序列）
#[derive(Debug)]
pub struct AnthropicParser {
    /// 每流恰好一个 stop 的状态机（02 §六.9）
    stream: StreamParser,
    /// 按 block index 分组的 pending tool_use
    pending_tools: BTreeMap<usize, PendingToolUse>,
    /// 当前 stop_reason（默认 stop，39-42）
    stop_reason: StopReason,
    /// 分片补全合并后的 usage（message_start 初始 + message_delta 增量）
    usage: Option<ProviderUsage>,
    /// 是否已产出过内容事件（text/thought/tool-call，空流保护判定）
    emitted_content: bool,
    /// 是否收到过 message_stop（空流保护判定）
    saw_message_stop: bool,
    /// 捕获的最近一个 thinking signature（Extended Thinking）
    last_thinking_signature: Option<String>,
    /// 按 block index 收集的 thinking signatures
    thinking_signatures: BTreeMap<usize, String>,
    /// 已终结（错误帧或 finish 后）
    terminated: bool,
}

impl Default for AnthropicParser {
    fn default() -> Self {
        Self {
            stream: StreamParser::new(),
            pending_tools: BTreeMap::new(),
            stop_reason: StopReason::Stop,
            usage: None,
            emitted_content: false,
            saw_message_stop: false,
            last_thinking_signature: None,
            thinking_signatures: BTreeMap::new(),
            terminated: false,
        }
    }
}

impl AnthropicParser {
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

    /// 最近一次捕获到的 thinking signature（Claude 3.7 Extended Thinking）
    pub fn last_thinking_signature(&self) -> Option<&str> {
        self.last_thinking_signature.as_deref()
    }

    /// 按 block index 收集的全部 thinking signatures
    pub fn thinking_signatures(&self) -> &BTreeMap<usize, String> {
        &self.thinking_signatures
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
        let Some(payload) = payload.as_object() else {
            return Ok(Vec::new());
        };
        let mut events = Vec::new();

        let event_type = string_field(payload.get("type")).unwrap_or("");

        // 帧级 error → 立即终止（55-65；错误帧后不得再产出任何事件）
        if event_type == "error" {
            let error = anthropic_payload_error(payload)
                .unwrap_or_else(|| "Anthropic streaming error".to_string());
            let kind = stream_error_kind(&error);
            events.push(ProviderStreamEvent::Stop {
                reason: StopReason::Error,
                error: Some(error),
                error_kind: Some(kind),
                usage: self.usage.clone(),
            });
            self.stream.check_events(&events)?;
            self.terminated = true;
            return Ok(events);
        }

        match event_type {
            // usage 初始分片（message.usage，67-74；或顶层 usage）
            "message_start" => {
                if let Some(message) = payload.get("message").and_then(Value::as_object) {
                    if let Some(usage) = parse_anthropic_usage(message.get("usage")) {
                        self.usage = Some(usage);
                    }
                } else if let Some(usage) = parse_anthropic_usage(payload.get("usage")) {
                    self.usage = Some(usage);
                }
            }
            // content_block_start：注册 tool_use pending（按 index）或捕获 redacted_thinking（76-94）
            "content_block_start" => {
                let index = number_field(payload.get("index")).unwrap_or(0);
                let Some(block) = payload.get("content_block").and_then(Value::as_object) else {
                    return Ok(Vec::new());
                };
                let block_type = string_field(block.get("type")).unwrap_or("");
                if block_type == "tool_use" {
                    let id = string_field(block.get("id"))
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("toolu_{index}"));
                    let name = string_field(block.get("name")).unwrap_or("").to_owned();
                    self.pending_tools.insert(
                        index,
                        PendingToolUse {
                            id,
                            name,
                            arguments_text: String::new(),
                        },
                    );
                } else if block_type == "redacted_thinking" {
                    if let Some(data) = non_empty_string(block.get("data")) {
                        self.emitted_content = true;
                        events.push(ProviderStreamEvent::ThoughtDelta {
                            text: data.to_owned(),
                            redacted: Some(true),
                        });
                    }
                }
            }
            // content_block_delta：text / thinking / signature / input_json（96-140）
            "content_block_delta" => {
                let index = number_field(payload.get("index")).unwrap_or(0);
                let Some(delta) = payload.get("delta").and_then(Value::as_object) else {
                    return Ok(Vec::new());
                };
                let delta_type = string_field(delta.get("type")).unwrap_or("");
                if delta_type == "text_delta" || delta.get("text").is_some_and(Value::is_string) {
                    if let Some(text) = non_empty_string(delta.get("text")) {
                        self.emitted_content = true;
                        events.push(ProviderStreamEvent::TextDelta {
                            text: text.to_owned(),
                        });
                    }
                } else if delta_type == "thinking_delta"
                    || delta.get("thinking").is_some_and(Value::is_string)
                {
                    // thought-delta 不标 redacted（02 §1.4：Anthropic 不标）
                    let thinking_text = non_empty_string(delta.get("thinking"))
                        .or_else(|| non_empty_string(delta.get("thought")))
                        .or_else(|| {
                            if delta_type == "thinking_delta" {
                                non_empty_string(delta.get("text"))
                            } else {
                                None
                            }
                        });
                    if let Some(text) = thinking_text {
                        self.emitted_content = true;
                        events.push(ProviderStreamEvent::ThoughtDelta {
                            text: text.to_owned(),
                            redacted: None,
                        });
                    }
                } else if delta_type == "signature_delta"
                    || delta.get("signature").is_some_and(Value::is_string)
                {
                    if let Some(sig) = non_empty_string(delta.get("signature")) {
                        self.last_thinking_signature = Some(sig.to_owned());
                        self.thinking_signatures.insert(index, sig.to_owned());
                    }
                } else if delta_type == "input_json_delta"
                    || delta.get("partial_json").is_some_and(Value::is_string)
                {
                    // 半 JSON 分片追加（126-137）；无对应 pending（工具块尚未 start）时忽略
                    if let Some(partial) = string_field(delta.get("partial_json")) {
                        if let Some(pending) = self.pending_tools.get_mut(&index) {
                            pending.arguments_text.push_str(partial);
                        }
                    }
                }
            }
            // content_block_stop：pending 有 name 则 emit tool-call（142-156）
            "content_block_stop" => {
                let index = number_field(payload.get("index")).unwrap_or(0);
                if let Some(pending) = self.pending_tools.get(&index) {
                    if !pending.name.is_empty() {
                        self.emitted_content = true;
                        events.push(ProviderStreamEvent::ToolCall {
                            id: Some(pending.id.clone()),
                            tool_name: pending.name.clone(),
                            input: parse_arguments(&pending.arguments_text),
                        });
                    }
                    self.pending_tools.remove(&index);
                }
            }
            // message_delta：stop_reason 覆盖 + usage 分片补全合并（158-175）
            "message_delta" => {
                if let Some(delta) = payload.get("delta").and_then(Value::as_object) {
                    // TS 判定为 `stop_reason !== undefined`：字段存在即映射（含 null → stop）
                    if delta.get("stop_reason").is_some() {
                        self.stop_reason = anthropic_stop_reason_to_stop(
                            delta.get("stop_reason").and_then(Value::as_str),
                        );
                    }
                }
                // message_start 带 input_tokens，message_delta 通常只带 output_tokens → 合并（169-175）
                let delta_usage = parse_anthropic_usage(payload.get("usage")).or_else(|| {
                    payload
                        .get("message")
                        .and_then(Value::as_object)
                        .and_then(|msg| parse_anthropic_usage(msg.get("usage")))
                });
                if let Some(delta_usage) = delta_usage {
                    self.usage = Some(merge_anthropic_usage(self.usage.as_ref(), &delta_usage));
                }
            }
            // message_stop → 终态（177-180）
            "message_stop" => {
                self.saw_message_stop = true;
                // 部分网关/代理在 message_stop 上携带 usage 或 message.usage
                let stop_usage = parse_anthropic_usage(payload.get("usage")).or_else(|| {
                    payload
                        .get("message")
                        .and_then(Value::as_object)
                        .and_then(|msg| parse_anthropic_usage(msg.get("usage")))
                });
                if let Some(delta_usage) = stop_usage {
                    self.usage = Some(merge_anthropic_usage(self.usage.as_ref(), &delta_usage));
                }
            }
            // 无 type 或未知事件：代理噪声忽略（182）
            _ => {}
        }

        self.stream.check_events(&events)?;
        Ok(events)
    }

    /// 流结束：flush 未 stop 的 pending → 空流保护 → 唯一 stop
    ///
    /// 对齐 TS 185-207：先防御性 flush（185-196），再空流保护（198-205），
    /// 最后产出唯一 stop（207）。
    pub fn finish(&mut self) -> Result<Vec<ProviderStreamEvent>, StreamParseError> {
        if self.terminated {
            return Ok(Vec::new());
        }
        let mut events = Vec::new();
        // 防御性 flush：未收到 content_block_stop 的 pending tool_use（185-196）
        for pending in self.pending_tools.values() {
            if !pending.name.is_empty() {
                self.emitted_content = true;
                events.push(ProviderStreamEvent::ToolCall {
                    id: Some(pending.id.clone()),
                    tool_name: pending.name.clone(),
                    input: parse_arguments(&pending.arguments_text),
                });
            }
        }
        self.pending_tools.clear();

        // 空流保护（198-205）：无内容事件且无 message_stop 且无 usage → error
        // （解析层保护错误 → error_kind=Unknown，不可重试语义保持）
        if !self.emitted_content && !self.saw_message_stop && self.usage.is_none() {
            events.push(ProviderStreamEvent::Stop {
                reason: StopReason::Error,
                error: Some(
                    "Anthropic streaming response completed without content events".to_string(),
                ),
                error_kind: Some(ProviderErrorKind::Unknown),
                usage: None,
            });
        } else {
            events.push(ProviderStreamEvent::Stop {
                reason: self.stop_reason,
                error: None,
                error_kind: None,
                usage: self.usage.clone(),
            });
        }

        self.stream.check_events(&events)?;
        self.terminated = true;
        Ok(events)
    }
}
