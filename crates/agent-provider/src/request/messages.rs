//! AgentMessage → wire 消息映射（任务书 B2.6；02-provider-semantics.md §二.6:134-140、§六.11）
//!
//! 对齐 `model:openai-request-build.ts:485-579`（buildChatMessages）：
//! - system → `{role:'system'}`；wireMode=user-prefix 时改 `role:'user'` +
//!   `System instructions for this run:\n\n` 前缀（02 §六.11）
//! - tool → 每个 tool-result block 一个 `{role:'tool', tool_call_id, content}`
//!   ——**T-34（R-J）**：文本在 wire 投影面统一经
//!   [conex_compaction::clean_output::clean_output]（默认
//!   [CleanupOptions]）清洗（R1-R6：ANSI 剥离 / 行尾空白 / 空行合并 /
//!   重复行折叠 / 超长行截断 / JSON 压缩）；落库/事件/工具返回保持 raw，
//!   清洗只发生在请求构造面（可重复计算、确定性、幂等——历史回放与
//!   新增消息同路径，不产生前缀漂移，评审 02 §3.4 P1-3）
//! - assistant → 文本 join + `tool_calls[]`（arguments 为 canonical JSON 序列化，P1 C2）+ 可选 `reasoning_content`
//! - user → 纯文本或 metadata.contentParts 多模态 parts（02 §二.6:138）
//!
//! 不做 LruMap 消息转换缓存（02 §五.13：Rust 无 GC 压力，非热路径）。
//!
//! SR-06e · 拆分 · ≠ EL：门面文件。实现域拆分如下（测试旁挂 messages_tests.rs）：
//! - [messages_content]：内容构造域（user_message_content / normalize_content_parts /
//!   stringify_tool_output / strip_inline_data_urls / sanitize_tool_call_id /
//!   responses_input_content 等纯函数与内容载体转换）

use std::borrow::Borrow;

use conex_compaction::clean_output::{clean_output, CleanupOptions};
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use conex_types::tool::SystemPromptWireMode;
use serde_json::{json, Map, Value};

use crate::request::cache::CacheControl;
use crate::request::schema::canonical_json_string;

#[path = "messages_content.rs"]
mod messages_content;

pub use messages_content::{
    normalize_content_parts, sanitize_tool_call_id, stringify_tool_output,
    strip_inline_data_urls, system_prompt_as_user_prefix, thought_content, user_message_content,
};
pub(crate) use messages_content::responses_input_content;

/// reasoningContentMode（对齐 OpenAICompatibleReasoningContentMode；默认 omit）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ReasoningContentMode {
    /// 不回传思考内容
    #[default]
    Omit,
    /// 有思考内容时回传 reasoning_content
    Include,
    /// 无思考内容也回传空串（P1 C3：键存在性——DeepSeek thinking
    /// 工具轮次缺 reasoning_content 键 400，空串兜底；Reasonix
    /// openai.go:669-680）
    Require,
}

/// wire 消息 content 载体（字符串或多模态 parts）
#[derive(Debug, Clone, PartialEq)]
pub enum ChatContent {
    Text(String),
    Parts(Vec<ChatContentPart>),
}

/// 多模态 content part（对齐 ChatContentPart：text / image_url；Text 可携带
/// Anthropic 系块级 cache_control 断点，P2 §3.2）
///
/// 序列化采用手写 to_value（compactObject 等价），不派生 serde——"仅 Some 时
/// 序列化"语义在 to_value 分支落地（None 时请求字节与 P2 前逐字节一致）。
#[derive(Debug, Clone, PartialEq)]
pub enum ChatContentPart {
    Text {
        text: String,
        /// Anthropic 系块级断点标记（仅 Some 时序列化，见 to_value）
        cache_control: Option<CacheControl>,
    },
    ImageUrl { url: String, detail: Option<String> },
}

impl ChatContentPart {
    /// 序列化为 wire part（cache_control 仅 Some 时输出 `"cache_control"` 键）
    pub fn to_value(&self) -> Value {
        match self {
            ChatContentPart::Text { text, cache_control } => {
                let mut part = Map::new();
                part.insert("type".to_string(), json!("text"));
                part.insert("text".to_string(), json!(text));
                if let Some(cc) = cache_control {
                    part.insert("cache_control".to_string(), cc.to_value());
                }
                Value::Object(part)
            }
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

    /// 文本 part 挂断点（供 apply_cache_controls 改写；返回带断点的新 part，
    /// 非文本 part 原样返回自身）
    pub fn with_cache_control(self, cc: CacheControl) -> Self {
        match self {
            ChatContentPart::Text { text, .. } => ChatContentPart::Text {
                text,
                cache_control: Some(cc),
            },
            other => other,
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
    /// 消息级 cache_control（Anthropic 原生端点"顶层自动模式"载体，P2 §3.1.3；
    /// chat-completions 兼容端点走 part 级，本字段恒 None；仅 Some 时序列化）
    pub cache_control: Option<CacheControl>,
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
        if let Some(cc) = &self.cache_control {
            message.insert("cache_control".to_string(), cc.to_value());
        }
        Value::Object(message)
    }

    /// 消息级断点设置（Anthropic 原生端点顶层自动模式用；返回自身）
    pub fn with_cache_control(mut self, cc: CacheControl) -> Self {
        self.cache_control = Some(cc);
        self
    }
}

/// reasoningContentObject（对齐 `model:openai-request-build.ts:326-334`）：
/// omit → 不回传；有思考内容时回传 reasoning_content
fn reasoning_content_object(message: &AgentMessage, mode: ReasoningContentMode) -> Option<String> {
    match mode {
        ReasoningContentMode::Omit => None,
        // P1：Require 模式无思考内容也回传空串——键存在性（DeepSeek
        // thinking 工具轮次缺键 400；空串兜底，Reasonix openai.go:669-680）
        ReasoningContentMode::Include => {
            let thought = thought_content(message);
            if thought.is_empty() {
                None
            } else {
                Some(thought)
            }
        }
        ReasoningContentMode::Require => {
            let thought = thought_content(message);
            // 空串也回传（to_value 对 Some("") 插入键，本文件 to_value 分支）
            Some(thought)
        }
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
                        // T-34（R-J）：wire 投影面统一清洗（默认 CleanupOptions；
                        // 确定性 + 幂等——历史回放与新增同路径；消息本体 raw 不变，
                        // 落库/事件/工具返回不受影响，评审 02 §3.4 / 00-plan §8.2）
                        let cleaned = clean_output(&stringify_tool_output(output), &CleanupOptions::default());
                        result.push(ChatMessage {
                            role: "tool".to_string(),
                            content: Some(ChatContent::Text(cleaned.cleaned)),
                            tool_call_id: Some(sanitize_tool_call_id(tool_call_id)),
                            reasoning_content: None,
                            tool_calls: Vec::new(),
                            cache_control: None,
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
                            // P1 C2：id 消毒 + arguments canonical 序列化（键序确定，
                            // 防御 provider 回传 wire JSON 的键序依赖；幂等保证历史不回改）
                            "id": sanitize_tool_call_id(&call.id),
                            "type": "function",
                            "function": {
                                "name": call.tool_name,
                                "arguments": canonical_json_string(&call.input),
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
                    cache_control: None,
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
                    cache_control: None,
                });
            }
        }
    }
    result
}

/// toResponsesInputItems（DEEPCHECK-05 #10：Responses 轨协议补全）
///
/// AgentMessage → Responses API input items（OpenAI Responses 形状；对齐
/// DeepSeek Responses API 官方兼容矩阵，api-docs.deepseek.com/guides/responses_api）：
/// - user → `{"type":"message","role":"user","content": <string|parts>}`（单文本 →
///   content 字符串；多模态 → input_text / input_image parts，DeepSeek 对 input_image
///   以占位符替换不报错）；
/// - system → message item（role=system；wire_mode=user-prefix 时改写 user + 前缀文案，
///   与 chat 轨 [system_prompt_message] 同语义）；
/// - assistant → reasoning item（Require/Include 且**有思考内容**时才发，plain-text
///   content 由服务端合并进相邻 assistant 消息）+ message item（有文本时）+
///   function_call item（每条 ToolCall；call_id 消毒 + arguments canonical 序列化，
///   与 chat 轨 tool_calls 同口径）；
/// - tool → function_call_output item（每条 ToolResult；output 经 T-34 清洗，
///   与 chat 轨 tool 消息同口径）。
///
/// 顺序保持对话时序（reasoning → message → function_call items，对齐 OpenAI
/// response.output 顺序）。`system_prompt` 不进 input：Responses 轨由 build.rs
/// 走顶层 `instructions` 字段（Responses 原生首 system 语义）。
pub fn to_responses_input_items<M: Borrow<AgentMessage>>(
    messages: &[M],
    reasoning_content_mode: ReasoningContentMode,
    wire_mode: SystemPromptWireMode,
) -> Vec<Value> {
    let mut result: Vec<Value> = Vec::new();
    for message_ref in messages {
        let message = message_ref.borrow();
        match message.role {
            AgentMessageRole::Tool => {
                for block in &message.blocks {
                    if let AgentMessageBlock::ToolResult { tool_call_id, output, .. } = block {
                        // T-34（R-J）：与 chat 轨 tool 消息同口径清洗（确定性 + 幂等）
                        let cleaned =
                            clean_output(&stringify_tool_output(output), &CleanupOptions::default());
                        result.push(json!({
                            "type": "function_call_output",
                            "call_id": sanitize_tool_call_id(tool_call_id),
                            "output": cleaned.cleaned,
                        }));
                    }
                }
            }
            AgentMessageRole::Assistant => {
                let content = message.text();
                let has_tool_call = message
                    .blocks
                    .iter()
                    .any(|b| matches!(b, AgentMessageBlock::ToolCall(_)));
                // Responses 轨思考回传：仅非空思考才发 reasoning item——DeepSeek
                // 官方矩阵 plain-text content 合并进相邻 assistant 消息，空内容无
                // 意义；与 chat 轨 Require 模式的"空串键存在性"有意分歧（那是
                // chat-completions 缺 reasoning_content 键 400 的兼容措施，
                // Responses 无此需求，ReasoningContentMode::Require 的键语义
                // 不随轨传递）
                let reasoning = reasoning_content_object(message, reasoning_content_mode)
                    .filter(|thought| !thought.is_empty());
                if content.is_empty() && !has_tool_call && reasoning.is_none() {
                    continue;
                }
                // reasoning item 先于 message item（对齐 OpenAI response.output 顺序）
                if let Some(thought) = reasoning {
                    result.push(json!({ "type": "reasoning", "content": thought }));
                }
                if !content.is_empty() {
                    result.push(json!({
                        "type": "message",
                        "role": "assistant",
                        "content": content,
                    }));
                }
                for block in &message.blocks {
                    if let AgentMessageBlock::ToolCall(call) = block {
                        result.push(json!({
                            "type": "function_call",
                            "call_id": sanitize_tool_call_id(&call.id),
                            "name": call.tool_name,
                            "arguments": canonical_json_string(&call.input),
                        }));
                    }
                }
            }
            AgentMessageRole::System => {
                result.push(json!({
                    "type": "message",
                    "role": match wire_mode {
                        SystemPromptWireMode::NativeSystemRole => "system",
                        SystemPromptWireMode::UserPrefix => "user",
                    },
                    "content": match wire_mode {
                        SystemPromptWireMode::NativeSystemRole => json!(message.text()),
                        SystemPromptWireMode::UserPrefix => {
                            json!(system_prompt_as_user_prefix(&message.text()))
                        }
                    },
                }));
            }
            AgentMessageRole::User => {
                result.push(json!({
                    "type": "message",
                    "role": "user",
                    "content": responses_input_content(&user_message_content(message)),
                }));
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
            cache_control: None,
        },
        SystemPromptWireMode::UserPrefix => ChatMessage {
            role: "user".to_string(),
            content: Some(ChatContent::Text(system_prompt_as_user_prefix(prompt))),
            tool_call_id: None,
            reasoning_content: None,
            tool_calls: Vec::new(),
            cache_control: None,
        },
    }
}

#[cfg(test)]
#[path = "messages_tests.rs"]
mod tests;
