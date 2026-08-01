//! AgentMessage → wire 消息映射（任务书 B2.6；02-provider-semantics.md §二.6:134-140、§六.11）
//!
//! 对齐 `model:openai-request-build.ts:485-579`（buildChatMessages）：
//! - system → `{role:'system'}`；wireMode=user-prefix 时改 `role:'user'` +
//!   `System instructions for this run:\n\n` 前缀（02 §六.11）
//! - tool → 每个 tool-result block 一个 `{role:'tool', tool_call_id, content}`
//! - assistant → 文本 join + `tool_calls[]`（arguments 为 JSON 序列化）+ 可选 `reasoning_content`
//! - user → 纯文本或 metadata.contentParts 多模态 parts（02 §二.6:138）
//!
//! 不做 LruMap 消息转换缓存（02 §五.13：Rust 无 GC 压力，非热路径）。

use std::borrow::Borrow;

use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use conex_types::tool::{SystemPromptWireMode, ToolOutput};
use serde_json::{json, Map, Value};

/// reasoningContentMode（对齐 OpenAICompatibleReasoningContentMode；默认 omit）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ReasoningContentMode {
    /// 不回传思考内容
    #[default]
    Omit,
    /// 有思考内容时回传 reasoning_content
    Include,
    /// 无思考内容也回传（与 Include 在 wire 层等价，仅下游语义差异）
    Require,
}

/// wire 消息 content 载体（字符串或多模态 parts）
#[derive(Debug, Clone, PartialEq)]
pub enum ChatContent {
    Text(String),
    Parts(Vec<ChatContentPart>),
}

/// 多模态 content part（对齐 ChatContentPart：text / image_url）
#[derive(Debug, Clone, PartialEq)]
pub enum ChatContentPart {
    Text { text: String },
    ImageUrl { url: String, detail: Option<String> },
}

impl ChatContentPart {
    /// 序列化为 wire part
    pub fn to_value(&self) -> Value {
        match self {
            ChatContentPart::Text { text } => json!({ "type": "text", "text": text }),
            ChatContentPart::ImageUrl { url, detail } => {
                let mut image_url = Map::new();
                image_url.insert("url".to_string(), json!(url));
                if let Some(detail) = detail {
                    image_url.insert("detail".to_string(), json!(detail));
                }
                json!({ "type": "image_url", "image_url": image_url })
            }
        }
    }
}

/// wire 消息（对齐 ChatMessage）
#[derive(Debug, Clone, PartialEq)]
pub struct ChatMessage {
    /// role：system / user / assistant / tool
    pub role: String,
    /// None → wire 上的 null（assistant 无正文时，对齐 TS `content || null`）
    pub content: Option<ChatContent>,
    pub tool_call_id: Option<String>,
    pub reasoning_content: Option<String>,
    /// `{id, type:'function', function:{name, arguments}}`
    pub tool_calls: Vec<Value>,
}

impl ChatMessage {
    /// 序列化为 wire JSON 对象
    pub fn to_value(&self) -> Value {
        let mut message = Map::new();
        message.insert("role".to_string(), json!(self.role));
        match &self.content {
            Some(ChatContent::Text(text)) => {
                message.insert("content".to_string(), json!(text));
            }
            Some(ChatContent::Parts(parts)) => {
                message.insert(
                    "content".to_string(),
                    json!(parts.iter().map(ChatContentPart::to_value).collect::<Vec<_>>()),
                );
            }
            None => {
                message.insert("content".to_string(), Value::Null);
            }
        }
        if let Some(tool_call_id) = &self.tool_call_id {
            message.insert("tool_call_id".to_string(), json!(tool_call_id));
        }
        if let Some(reasoning_content) = &self.reasoning_content {
            message.insert("reasoning_content".to_string(), json!(reasoning_content));
        }
        if !self.tool_calls.is_empty() {
            message.insert("tool_calls".to_string(), json!(self.tool_calls));
        }
        Value::Object(message)
    }
}

/// systemPromptAsUserPrefix（对齐 `model:openai-request-build.ts:71-73`）
pub fn system_prompt_as_user_prefix(system_prompt: &str) -> String {
    format!("System instructions for this run:\n\n{}", system_prompt.trim())
}

/// 思考内容（thought blocks 拼接，缺省回退 metadata.thought；thoughtContent）
pub fn thought_content(message: &AgentMessage) -> String {
    let from_blocks = message.thought();
    if !from_blocks.is_empty() {
        return from_blocks;
    }
    message
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("thought"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// stringifyToolOutput（对齐 `model:openai-request-build.ts:83-88`）：
/// text → json → artifacts JSON 字符串 → 空串
pub fn stringify_tool_output(output: &ToolOutput) -> String {
    if let Some(text) = &output.text {
        return text.clone();
    }
    if let Some(json) = &output.json {
        return serde_json::to_string(json).unwrap_or_default();
    }
    if let Some(artifacts) = &output.artifacts {
        if !artifacts.is_empty() {
            return serde_json::to_string(artifacts).unwrap_or_default();
        }
    }
    String::new()
}

/// 剥掉内联 `data:image/...;base64,...` 载荷（对齐 stripInlineDataUrls，
/// 避免与结构化 parts 重复载荷；不支持正则依赖，用扫描实现）
pub fn strip_inline_data_urls(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    loop {
        match next_data_url(rest) {
            None => {
                out.push_str(rest);
                break;
            }
            // 形似但非 base64 的 data url：原样保留并前进一个字符（按字符边界），避免死循环
            Some((start, end)) if start == end => {
                let char_len = rest.chars().next().map(char::len_utf8).unwrap_or(1);
                out.push_str(&rest[..char_len]);
                rest = &rest[char_len..];
            }
            Some((start, end)) => {
                out.push_str(&rest[..start]);
                out.push_str("[image]");
                rest = &rest[end..];
            }
        }
    }
    out
}

/// 定位 `data:image/<mime>;base64,<payload>`；形似但非法时返回 `(start, start)` 哨兵
fn next_data_url(rest: &str) -> Option<(usize, usize)> {
    let start = rest.find("data:image/")?;
    let after_prefix = &rest[start + "data:image/".len()..];
    let semi = after_prefix.find(';')?;
    let mime = &after_prefix[..semi];
    let mime_ok = mime
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '+' || c == '-');
    if !mime_ok {
        return Some((start, start));
    }
    let after_semi = &after_prefix[semi..];
    if !after_semi.starts_with(";base64,") {
        return Some((start, start));
    }
    let payload = &after_semi[";base64,".len()..];
    let payload_len = payload
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || "+/=\r\n".contains(*c))
        .count();
    Some((
        start,
        start + "data:image/".len() + semi + ";base64,".len() + payload_len,
    ))
}

/// normalizeContentParts（对齐 `model:openai-request-build.ts:347-377`）：
/// 仅保留合法 text / image_url part；image_url 支持 `image_url.url` 与平铺 `url` 变体
pub fn normalize_content_parts(value: &Value) -> Vec<ChatContentPart> {
    let Some(parts) = value.as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for raw in parts {
        let Some(part) = raw.as_object() else {
            continue;
        };
        match part.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    out.push(ChatContentPart::Text {
                        text: text.to_string(),
                    });
                }
            }
            Some("image_url") => {
                let nested = part.get("image_url").and_then(Value::as_object);
                if let Some(image_url) = nested {
                    let url = image_url
                        .get("url")
                        .and_then(Value::as_str)
                        .filter(|url| !url.trim().is_empty());
                    if let Some(url) = url {
                        let detail = image_url
                            .get("detail")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        out.push(ChatContentPart::ImageUrl {
                            url: url.to_string(),
                            detail,
                        });
                    }
                } else if let Some(url) = part
                    .get("url")
                    .and_then(Value::as_str)
                    .filter(|url| !url.trim().is_empty())
                {
                    out.push(ChatContentPart::ImageUrl {
                        url: url.to_string(),
                        detail: None,
                    });
                }
            }
            _ => {}
        }
    }
    out
}

/// userMessageContent（对齐 `model:openai-request-build.ts:383-409`）：
/// metadata.contentParts 含 image_url 时 → 多模态 parts（剥内联 base64、无文本时正文兜底）；
/// 否则 → blocks 纯文本
pub fn user_message_content(message: &AgentMessage) -> ChatContent {
    let parts_value = message
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("contentParts"))
        .unwrap_or(&Value::Null);
    let parts = normalize_content_parts(parts_value);
    let has_image = parts
        .iter()
        .any(|part| matches!(part, ChatContentPart::ImageUrl { .. }));
    if !has_image {
        return ChatContent::Text(message.text());
    }
    let mut out: Vec<ChatContentPart> = Vec::new();
    let mut saw_text = false;
    for part in parts {
        match part {
            ChatContentPart::Text { text } => {
                let cleaned = strip_inline_data_urls(&text).trim().to_string();
                if !cleaned.is_empty() {
                    out.push(ChatContentPart::Text { text: cleaned });
                    saw_text = true;
                }
            }
            image @ ChatContentPart::ImageUrl { .. } => out.push(image),
        }
    }
    if !saw_text {
        let fallback = strip_inline_data_urls(&message.text()).trim().to_string();
        if !fallback.is_empty() {
            out.insert(0, ChatContentPart::Text { text: fallback });
        }
    }
    if out.is_empty() {
        ChatContent::Text(message.text())
    } else {
        ChatContent::Parts(out)
    }
}

/// reasoningContentObject（对齐 `model:openai-request-build.ts:326-334`）：
/// omit → 不回传；有思考内容时回传 reasoning_content
fn reasoning_content_object(message: &AgentMessage, mode: ReasoningContentMode) -> Option<String> {
    if matches!(mode, ReasoningContentMode::Omit) {
        return None;
    }
    let thought = thought_content(message);
    if thought.is_empty() {
        None
    } else {
        Some(thought)
    }
}

/// toChatMessages（对齐 `model:openai-request-build.ts:485-579`；02 §二.6:134-140、§六.11）
///
/// systemPrompt 非空时前置 system 消息（user-prefix 模式改写为 user 角色 + 前缀文案）；
/// 消息内的 system 消息同样走 user-prefix 重写路径。
///
/// PE-09 T09.3 阶段 1：`M` 泛型（[AgentMessage] 或 `Arc<AgentMessage>` 均满足
/// [Borrow]）——请求链全链借用的 zero-copy 消费面：对话为
/// `&[Arc<AgentMessage>]` 时不再被迫克隆成 owned `Vec<AgentMessage>`。
pub fn to_chat_messages<M: Borrow<AgentMessage>>(
    system_prompt: Option<&str>,
    messages: &[M],
    reasoning_content_mode: ReasoningContentMode,
    wire_mode: SystemPromptWireMode,
) -> Vec<ChatMessage> {
    let mut result = Vec::new();
    if let Some(prompt) = system_prompt {
        if !prompt.trim().is_empty() {
            result.push(system_prompt_message(prompt, wire_mode));
        }
    }
    for message_ref in messages {
        let message = message_ref.borrow();
        match message.role {
            AgentMessageRole::Tool => {
                for block in &message.blocks {
                    if let AgentMessageBlock::ToolResult { tool_call_id, output, .. } = block {
                        result.push(ChatMessage {
                            role: "tool".to_string(),
                            content: Some(ChatContent::Text(stringify_tool_output(output))),
                            tool_call_id: Some(tool_call_id.clone()),
                            reasoning_content: None,
                            tool_calls: Vec::new(),
                        });
                    }
                }
            }
            AgentMessageRole::Assistant => {
                let content = message.text();
                let tool_calls: Vec<Value> = message
                    .blocks
                    .iter()
                    .filter_map(|block| match block {
                        AgentMessageBlock::ToolCall(call) => Some(json!({
                            "id": call.id,
                            "type": "function",
                            "function": {
                                "name": call.tool_name,
                                "arguments": serde_json::to_string(&call.input)
                                    .unwrap_or_else(|_| "{}".to_string()),
                            },
                        })),
                        _ => None,
                    })
                    .collect();
                let reasoning = reasoning_content_object(message, reasoning_content_mode);
                if content.is_empty() && tool_calls.is_empty() && reasoning.is_none() {
                    continue;
                }
                result.push(ChatMessage {
                    role: "assistant".to_string(),
                    content: if content.is_empty() {
                        None
                    } else {
                        Some(ChatContent::Text(content))
                    },
                    tool_call_id: None,
                    reasoning_content: reasoning,
                    tool_calls,
                });
            }
            AgentMessageRole::System => {
                result.push(system_prompt_message(&message.text(), wire_mode));
            }
            AgentMessageRole::User => {
                result.push(ChatMessage {
                    role: "user".to_string(),
                    content: Some(user_message_content(message)),
                    tool_call_id: None,
                    reasoning_content: None,
                    tool_calls: Vec::new(),
                });
            }
        }
    }
    result
}

/// system 提示词 wire 化：user-prefix 模式改写 role 与文案（02 §六.11）
fn system_prompt_message(prompt: &str, wire_mode: SystemPromptWireMode) -> ChatMessage {
    match wire_mode {
        SystemPromptWireMode::NativeSystemRole => ChatMessage {
            role: "system".to_string(),
            content: Some(ChatContent::Text(prompt.to_string())),
            tool_call_id: None,
            reasoning_content: None,
            tool_calls: Vec::new(),
        },
        SystemPromptWireMode::UserPrefix => ChatMessage {
            role: "user".to_string(),
            content: Some(ChatContent::Text(system_prompt_as_user_prefix(prompt))),
            tool_call_id: None,
            reasoning_content: None,
            tool_calls: Vec::new(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_types::message::ToolCallBlock;
    use conex_types::tool::ToolArtifact;

    /// 便捷构造消息
    fn message(role: AgentMessageRole, blocks: Vec<AgentMessageBlock>) -> AgentMessage {
        AgentMessage {
            id: format!("m-{role:?}"),
            role,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            blocks,
            metadata: None,
            client_message_id: None,
            content: None,
        }
    }

    fn text_block(text: &str) -> AgentMessageBlock {
        AgentMessageBlock::Text {
            text: text.to_string(),
        }
    }

    fn user_msg(blocks: Vec<AgentMessageBlock>) -> AgentMessage {
        message(AgentMessageRole::User, blocks)
    }

    fn assistant_msg(blocks: Vec<AgentMessageBlock>) -> AgentMessage {
        message(AgentMessageRole::Assistant, blocks)
    }

    fn tool_call_block(id: &str, name: &str, input: Value) -> AgentMessageBlock {
        AgentMessageBlock::ToolCall(ToolCallBlock {
            id: id.to_string(),
            tool_name: name.to_string(),
            input,
        })
    }

    fn tool_result_block(tool_call_id: &str, output: ToolOutput) -> AgentMessageBlock {
        AgentMessageBlock::ToolResult {
            tool_call_id: tool_call_id.to_string(),
            tool_name: "read_file".to_string(),
            output,
            is_error: false,
        }
    }

    /// 断言消息 role 与 content（字符串形态）
    fn assert_text_content(messages: &[ChatMessage], index: usize, role: &str, content: &str) {
        assert_eq!(messages[index].role, role);
        assert_eq!(messages[index].content, Some(ChatContent::Text(content.to_string())));
    }

    // ── 角色映射与内容 ──

    #[test]
    fn roles_map_to_wire() {
        let messages = to_chat_messages(
            None,
            &[
                user_msg(vec![text_block("你好")]),
                assistant_msg(vec![text_block("回复")]),
                message(
                    AgentMessageRole::System,
                    vec![text_block("系统指令")],
                ),
                message(
                    AgentMessageRole::Tool,
                    vec![tool_result_block("call_1", ToolOutput::text("结果"))],
                ),
            ],
            ReasoningContentMode::Omit,
            SystemPromptWireMode::NativeSystemRole,
        );
        assert_eq!(messages.len(), 4);
        assert_text_content(&messages, 0, "user", "你好");
        assert_text_content(&messages, 1, "assistant", "回复");
        assert_text_content(&messages, 2, "system", "系统指令");
        // tool 结果消息
        assert_eq!(messages[3].role, "tool");
        assert_eq!(messages[3].tool_call_id.as_deref(), Some("call_1"));
        assert_eq!(messages[3].content, Some(ChatContent::Text("结果".to_string())));
        assert_eq!(messages[3].tool_calls, Vec::<Value>::new());
    }

    #[test]
    fn system_prompt_prepends_system_message() {
        let messages = to_chat_messages(
            Some("全局提示词"),
            &[user_msg(vec![text_block("hi")])],
            ReasoningContentMode::Omit,
            SystemPromptWireMode::NativeSystemRole,
        );
        assert_eq!(messages.len(), 2);
        assert_text_content(&messages, 0, "system", "全局提示词");
        assert_text_content(&messages, 1, "user", "hi");
    }

    #[test]
    fn empty_system_prompt_is_omitted() {
        let messages = to_chat_messages(
            Some("   "),
            &[user_msg(vec![text_block("hi")])],
            ReasoningContentMode::Omit,
            SystemPromptWireMode::NativeSystemRole,
        );
        assert_eq!(messages.len(), 1);
        assert_text_content(&messages, 0, "user", "hi");
    }

    #[test]
    fn user_prefix_rewrites_system_prompt_and_system_messages() {
        // 02 §六.11：user-prefix wireMode 改写 role 与文案
        let messages = to_chat_messages(
            Some("全局提示词"),
            &[message(AgentMessageRole::System, vec![text_block("消息内系统指令")])],
            ReasoningContentMode::Omit,
            SystemPromptWireMode::UserPrefix,
        );
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(
            messages[0].content,
            Some(ChatContent::Text("System instructions for this run:\n\n全局提示词".to_string()))
        );
        assert_eq!(messages[1].role, "user");
        assert_eq!(
            messages[1].content,
            Some(ChatContent::Text("System instructions for this run:\n\n消息内系统指令".to_string()))
        );
    }

    #[test]
    fn system_prompt_as_user_prefix_trims_input() {
        assert_eq!(
            system_prompt_as_user_prefix("  带空白的提示  "),
            "System instructions for this run:\n\n带空白的提示"
        );
    }

    #[test]
    fn each_tool_result_block_becomes_tool_message() {
        let blocks = vec![
            tool_result_block("call_1", ToolOutput::text("结果一")),
            tool_result_block("call_2", ToolOutput {
                text: None,
                json: Some(json!({ "ok": true })),
                artifacts: None,
            }),
        ];
        let messages = to_chat_messages(
            None,
            &[message(AgentMessageRole::Tool, blocks)],
            ReasoningContentMode::Omit,
            SystemPromptWireMode::NativeSystemRole,
        );
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].tool_call_id.as_deref(), Some("call_1"));
        assert_eq!(messages[0].content, Some(ChatContent::Text("结果一".to_string())));
        assert_eq!(messages[1].tool_call_id.as_deref(), Some("call_2"));
        assert_eq!(
            messages[1].content,
            Some(ChatContent::Text(json!({ "ok": true }).to_string()))
        );
    }

    #[test]
    fn tool_output_stringify_precedence() {
        // text → json → artifacts → ''
        let text = ToolOutput::text("纯文本");
        assert_eq!(stringify_tool_output(&text), "纯文本");
        let json = ToolOutput {
            text: None,
            json: Some(json!({ "a": 1 })),
            artifacts: None,
        };
        assert_eq!(stringify_tool_output(&json), r#"{"a":1}"#);
        let artifacts = ToolOutput {
            text: None,
            json: None,
            artifacts: Some(vec![ToolArtifact {
                kind: conex_types::tool::ToolArtifactKind::File,
                title: "t".to_string(),
                uri: Some("file:///a".to_string()),
                text: None,
                metadata: None,
            }]),
        };
        assert!(stringify_tool_output(&artifacts).contains("file:///a"));
        assert_eq!(stringify_tool_output(&ToolOutput::empty()), "");
    }

    #[test]
    fn assistant_message_carries_tool_calls() {
        let messages = to_chat_messages(
            None,
            &[assistant_msg(vec![
                text_block("正文"),
                tool_call_block("call_1", "read_file", json!({ "path": "/a" })),
            ])],
            ReasoningContentMode::Omit,
            SystemPromptWireMode::NativeSystemRole,
        );
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].content, Some(ChatContent::Text("正文".to_string())));
        assert_eq!(messages[0].tool_calls.len(), 1);
        let call = &messages[0].tool_calls[0];
        assert_eq!(call["id"], "call_1");
        assert_eq!(call["type"], "function");
        assert_eq!(call["function"]["name"], "read_file");
        assert_eq!(call["function"]["arguments"], r#"{"path":"/a"}"#);
    }

    #[test]
    fn assistant_without_content_emits_null_content() {
        let messages = to_chat_messages(
            None,
            &[assistant_msg(vec![tool_call_block("call_1", "noop", json!({}))])],
            ReasoningContentMode::Omit,
            SystemPromptWireMode::NativeSystemRole,
        );
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "assistant");
        assert_eq!(messages[0].content, None, "无正文 → wire null");
        assert_eq!(messages[0].tool_calls.len(), 1);
        let value = messages[0].to_value();
        assert_eq!(value["content"], Value::Null);
    }

    #[test]
    fn empty_assistant_message_is_skipped() {
        // 无正文、无工具调用、无思考 → 整条跳过（对齐 TS continue）
        let messages = to_chat_messages(
            None,
            &[assistant_msg(vec![]), user_msg(vec![text_block("hi")])],
            ReasoningContentMode::Omit,
            SystemPromptWireMode::NativeSystemRole,
        );
        assert_eq!(messages.len(), 1);
        assert_text_content(&messages, 0, "user", "hi");
    }

    #[test]
    fn reasoning_content_include_mode_attaches_thought() {
        // Include 模式：thought block 拼接为 reasoning_content
        let msg = message(
            AgentMessageRole::Assistant,
            vec![AgentMessageBlock::Thought {
                text: "推理过程".to_string(),
                redacted: None,
            }],
        );
        let messages = to_chat_messages(
            None,
            &[msg],
            ReasoningContentMode::Include,
            SystemPromptWireMode::NativeSystemRole,
        );
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].reasoning_content.as_deref(), Some("推理过程"));

        // Omit 模式：不回传；纯思考消息无正文/工具调用/思考回传 → 整条跳过（对齐 TS continue）
        let messages = to_chat_messages(
            None,
            &[message(
                AgentMessageRole::Assistant,
                vec![AgentMessageBlock::Thought {
                    text: "推理过程".to_string(),
                    redacted: None,
                }],
            )],
            ReasoningContentMode::Omit,
            SystemPromptWireMode::NativeSystemRole,
        );
        assert!(messages.is_empty(), "omit 模式下纯思考消息整条跳过");
    }

    #[test]
    fn reasoning_content_falls_back_to_metadata_thought() {
        let mut msg = assistant_msg(vec![]);
        msg.metadata = Some(json!({ "thought": "元数据思考" }));
        let messages = to_chat_messages(
            None,
            &[msg],
            ReasoningContentMode::Include,
            SystemPromptWireMode::NativeSystemRole,
        );
        assert_eq!(messages[0].reasoning_content.as_deref(), Some("元数据思考"));
    }

    // ── 多模态 contentParts ──

    #[test]
    fn user_content_parts_used_when_image_present() {
        let mut msg = user_msg(vec![text_block("正文文本")]);
        msg.metadata = Some(json!({
            "contentParts": [
                { "type": "text", "text": "看图说话" },
                { "type": "image_url", "image_url": { "url": "https://example.com/a.png", "detail": "high" } },
            ]
        }));
        let messages = to_chat_messages(
            None,
            &[msg],
            ReasoningContentMode::Omit,
            SystemPromptWireMode::NativeSystemRole,
        );
        assert_eq!(
            messages[0].content,
            Some(ChatContent::Parts(vec![
                ChatContentPart::Text { text: "看图说话".to_string() },
                ChatContentPart::ImageUrl {
                    url: "https://example.com/a.png".to_string(),
                    detail: Some("high".to_string()),
                },
            ]))
        );
        let value = messages[0].to_value();
        assert_eq!(value["content"][0]["type"], "text");
        assert_eq!(value["content"][1]["image_url"]["url"], "https://example.com/a.png");
    }

    #[test]
    fn user_content_parts_text_only_degrades_to_plain_text() {
        let mut msg = user_msg(vec![text_block("正文")]);
        msg.metadata = Some(json!({
            "contentParts": [{ "type": "text", "text": "只有文本" }]
        }));
        let messages = to_chat_messages(
            None,
            &[msg],
            ReasoningContentMode::Omit,
            SystemPromptWireMode::NativeSystemRole,
        );
        // 无图片 → 退回 blocks 纯文本（对齐 TS hasImage 判定）
        assert_text_content(&messages, 0, "user", "正文");
    }

    #[test]
    fn user_content_parts_image_url_flat_variant() {
        let mut msg = user_msg(vec![]);
        msg.metadata = Some(json!({
            "contentParts": [{ "type": "image_url", "url": "https://example.com/b.png" }]
        }));
        let messages = to_chat_messages(
            None,
            &[msg],
            ReasoningContentMode::Omit,
            SystemPromptWireMode::NativeSystemRole,
        );
        match &messages[0].content {
            Some(ChatContent::Parts(parts)) => {
                assert_eq!(parts.len(), 1);
                match &parts[0] {
                    ChatContentPart::ImageUrl { url, detail } => {
                        assert_eq!(url, "https://example.com/b.png");
                        assert_eq!(*detail, None);
                    }
                    other => panic!("期望 image part，得到：{other:?}"),
                }
            }
            other => panic!("期望 parts 内容，得到：{other:?}"),
        }
    }

    #[test]
    fn strip_inline_data_urls_removes_base64_payloads() {
        let text = "看图 data:image/png;base64,iVBORw0KGgo= 之后";
        assert_eq!(strip_inline_data_urls(text), "看图 [image] 之后");
        // markdown 图片语法
        let text = "![alt](data:image/jpeg;base64,AAAA) 结尾";
        assert_eq!(strip_inline_data_urls(text), "![alt]([image]) 结尾");
    }

    #[test]
    fn strip_inline_data_urls_keeps_plain_text() {
        assert_eq!(strip_inline_data_urls(""), "");
        assert_eq!(strip_inline_data_urls("没有图片"), "没有图片");
        // 非 base64 的 data url 原样保留
        assert_eq!(strip_inline_data_urls("data:text/plain;charset=utf-8,hi"), "data:text/plain;charset=utf-8,hi");
    }

    #[test]
    fn wire_value_shape() {
        let messages = to_chat_messages(
            None,
            &[assistant_msg(vec![text_block("回复")])],
            ReasoningContentMode::Omit,
            SystemPromptWireMode::NativeSystemRole,
        );
        let value = messages[0].to_value();
        assert_eq!(value["role"], "assistant");
        assert_eq!(value["content"], "回复");
        assert!(value.get("tool_call_id").is_none());
        assert!(value.get("reasoning_content").is_none());
        assert!(value.get("tool_calls").is_none());
    }
}
