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

use crate::error::RequestBuildError;
use crate::request::cache::CacheControl;
use crate::request::compat::empty_content_wire_value;
use crate::request::schema::canonical_json_string;

#[path = "messages_compat.rs"]
mod messages_compat;
#[path = "messages_content.rs"]
mod messages_content;

pub(crate) use messages_content::responses_input_content;
pub use messages_content::{
    ensure_content_modalities, ensure_outbound_modalities, normalize_content_parts,
    sanitize_tool_call_id, stringify_tool_output, strip_inline_data_urls,
    system_prompt_as_user_prefix, thought_content, user_message_content,
};
// G5-compat 序列化消费辅助（R2 T2.2/T2.3）：WireCompat 上下文 + 模型级判定
// （is_deepseek / resolve_system_role / deepseek_tool_call_reasoning）
pub use messages_compat::{deepseek_tool_call_reasoning, resolve_system_role, WireCompat};

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
    ImageUrl {
        url: String,
        detail: Option<String>,
    },
}

impl ChatContentPart {
    /// 序列化为 wire part（cache_control 仅 Some 时输出 `"cache_control"` 键）
    pub fn to_value(&self) -> Value {
        match self {
            ChatContentPart::Text {
                text,
                cache_control,
            } => {
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
                    json!(parts
                        .iter()
                        .map(ChatContentPart::to_value)
                        .collect::<Vec<_>>()),
                );
            }
            None => {
                // G5-b（T2.2）：空 content 序列化 `""`（非 `null`）——消费
                // empty_content_wire_value（R1 T1.7）；对齐 DSH serialize.ts:95
                // 「Text-less turns send "" — NEVER null」、pi-ai
                // openai-completions.js:836-839。当前 None 仅出现在空文本
                // assistant 消息（纯思考轮 / 纯工具调用轮），此处统一回写 ""。
                message.insert(
                    "content".to_string(),
                    json!(empty_content_wire_value(&self.role)),
                );
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

/// Wire 层安全占位文本常量（中性系统提示词；防止模型上游连续 Assistant 报 HTTP 400 错误）
pub const WIRE_CONTINUATION_NOTE: &str =
    "[System Note: The following is a continuation of previous output.]";

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
    // 既有四参入口（build_chat.rs / deepseek_invariants / 全部既有测试）保持
    // 语义不变：缺省 [WireCompat]（非 DeepSeek、无 developer role）→ 默认轨
    // wire 字节与现状逐字节一致。compat 消费面由 [to_chat_messages_with_compat]
    // 承载（R3 适配层接线时切换入口，本入口不动）。
    to_chat_messages_with_compat(
        system_prompt,
        messages,
        reasoning_content_mode,
        wire_mode,
        WireCompat::default(),
    )
}

/// [to_chat_messages] 的 compat 消费面（G5-a/G5-b · T2.2/T2.3）
///
/// 在既有四参语义上叠加 [WireCompat] 驱动的两处模型级序列化行为：
/// - **reasoning_content 模型级强制键（T2.2）**：[WireCompat::is_deepseek]
///   为真且 assistant 带 tool_calls 的回合 → 必带 `reasoning_content` 键（无
///   思考时空串兜底，对齐 DSH serialize.ts:99 的 tool-call 回合必带语义；
///   [ReasoningContentMode] 恒被覆盖，Omit 亦强制）；DeepSeek 纯思考轮
///   （无 tool_calls）→ 带思考时保留（不强加键）；非 DeepSeek → 不改写，
///   保持既有 mode 语义。
/// - **system → developer role（T2.3）**：system 消息接入 [resolve_developer_role]
///   ——openrouter + `anthropic/`|`openai/` 前缀模型 + reasoning → `role:"developer"`，
///   否则 `role:"system"`（chat 轨；user-prefix 模式恒 `role:"user"` 不改写）。
///
/// 缺省 [WireCompat] 时与 [to_chat_messages] 完全等价（逐字节一致）。
pub fn to_chat_messages_with_compat<M: Borrow<AgentMessage>>(
    system_prompt: Option<&str>,
    messages: &[M],
    reasoning_content_mode: ReasoningContentMode,
    wire_mode: SystemPromptWireMode,
    compat: WireCompat<'_>,
) -> Vec<ChatMessage> {
    let mut result = Vec::new();
    if let Some(prompt) = system_prompt {
        if !prompt.trim().is_empty() {
            result.push(system_prompt_message(prompt, wire_mode, compat));
        }
    }

    for message_ref in messages {
        let message = message_ref.borrow();
        match message.role {
            AgentMessageRole::Tool => {
                for block in &message.blocks {
                    if let AgentMessageBlock::ToolResult {
                        tool_call_id,
                        output,
                        ..
                    } = block
                    {
                        // T-34（R-J）：wire 投影面统一清洗（默认 CleanupOptions；
                        // 确定性 + 幂等——历史回放与新增同路径；消息本体 raw 不变，
                        // 落库/事件/工具返回不受影响，评审 02 §3.4 / 00-plan §8.2）
                        result.push(tool_result_chat_message(tool_call_id, output));
                    }
                }
            }
            AgentMessageRole::Assistant => {
                let content = message.text();
                let tool_calls: Vec<Value> = message
                    .blocks
                    .iter()
                    .filter_map(|block| match block {
                        AgentMessageBlock::ToolCall(call) => {
                            let tool_name = call.tool_name.trim();
                            if tool_name.is_empty() {
                                return None;
                            }
                            let raw_id = sanitize_tool_call_id(&call.id);
                            let id = if raw_id.trim().is_empty() {
                                format!("call_{tool_name}")
                            } else {
                                raw_id
                            };
                            let mut args = canonical_json_string(&call.input);
                            if args.trim().is_empty() {
                                args = "{}".to_string();
                            }
                            Some(json!({
                                "id": id,
                                "type": "function",
                                "function": {
                                    "name": tool_name,
                                    "arguments": args,
                                },
                            }))
                        }
                        _ => None,
                    })
                    .collect();
                let has_tool_call = !tool_calls.is_empty();
                let reasoning = reasoning_content_object(message, reasoning_content_mode);
                // G5-b（T2.2）：reasoning_content 模型级强制键（判定与取值在
                // [messages_compat::deepseek_tool_call_reasoning]，本处仅消费）。
                // DeepSeek 厂商 + 带 tool_calls 的回合 → 必带键（有思考回传思考、
                // 无思考空串兜底，对齐 DSH serialize.ts:99 tool-call 回合必带
                // passback 语义）；DeepSeek 纯思考轮（无 tool_calls）→ 带思考时
                // 保留、不强加键；非 DeepSeek → 不改写（保持既有
                // [ReasoningContentMode] 语义，deepseek_invariants 的
                // Require/Omit 边界钉死不破坏）。
                let reasoning = match deepseek_tool_call_reasoning(&compat, has_tool_call, message)
                {
                    // DeepSeek tool-call 回合 → 强制键取值（已有思考回传、空串兜底）
                    Some(forced) => Some(forced),
                    // 其余（非 DeepSeek / 纯思考轮）→ 沿用既有 mode 语义（不改写）
                    None => reasoning,
                };
                let has_tool_results = message
                    .blocks
                    .iter()
                    .any(|b| matches!(b, AgentMessageBlock::ToolResult { .. }));
                if content.is_empty() && tool_calls.is_empty() && reasoning.is_none() && !has_tool_results {
                    continue;
                }

                // 【Wire-Only 角色交替防 400 投影层】
                // 检查输出流前驱项：若前驱亦为 assistant，瞬态注入 user 占位消息
                if let Some(prev) = result.last() {
                    if prev.role == "assistant" {
                        result.push(ChatMessage {
                            role: "user".to_string(),
                            content: Some(ChatContent::Text(WIRE_CONTINUATION_NOTE.to_string())),
                            tool_call_id: None,
                            reasoning_content: None,
                            tool_calls: Vec::new(),
                            cache_control: None,
                        });
                    }
                }

                if !content.is_empty() || !tool_calls.is_empty() || reasoning.is_some() {
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

                // 历史水合兜底（OpenAI/TokenHub wire 铁律）：
                // 前端历史水合后的 assistant 消息可能同体携带 ToolResult 块（hydrate.rs），
                // 必须紧随 assistant 消息后立即发出对应的 tool 消息，保证 wire 上
                // 每个 tool_call_id 都有对应的 role: "tool" 结果，否则 TokenHub/OpenAI 400001 报非法请求。
                for block in &message.blocks {
                    if let AgentMessageBlock::ToolResult {
                        tool_call_id,
                        output,
                        ..
                    } = block
                    {
                        result.push(tool_result_chat_message(tool_call_id, output));
                    }
                }
            }
            AgentMessageRole::System => {
                result.push(system_prompt_message(&message.text(), wire_mode, compat));
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

fn tool_result_chat_message(
    tool_call_id: &str,
    output: &conex_types::tool::ToolOutput,
) -> ChatMessage {
    let cleaned = clean_output(
        &stringify_tool_output(output),
        &CleanupOptions::default(),
    );
    let text = if cleaned.cleaned.is_empty() {
        "(no output)".to_string()
    } else {
        cleaned.cleaned
    };
    ChatMessage {
        role: "tool".to_string(),
        content: Some(ChatContent::Text(text)),
        tool_call_id: Some(sanitize_tool_call_id(tool_call_id)),
        reasoning_content: None,
        tool_calls: Vec::new(),
        cache_control: None,
    }
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
                    if let AgentMessageBlock::ToolResult {
                        tool_call_id,
                        output,
                        ..
                    } = block
                    {
                        // T-34（R-J）：与 chat 轨 tool 消息同口径清洗（确定性 + 幂等）
                        let cleaned = clean_output(
                            &stringify_tool_output(output),
                            &CleanupOptions::default(),
                        );
                        let text = if cleaned.cleaned.is_empty() {
                            "(no output)".to_string()
                        } else {
                            cleaned.cleaned
                        };
                        result.push(json!({
                            "type": "function_call_output",
                            "call_id": sanitize_tool_call_id(tool_call_id),
                            "output": text,
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
                let has_tool_results = message
                    .blocks
                    .iter()
                    .any(|b| matches!(b, AgentMessageBlock::ToolResult { .. }));
                if content.is_empty() && !has_tool_call && reasoning.is_none() && !has_tool_results {
                    continue;
                }

                // 【Wire-Only 角色交替防 400 投影层】
                // 检查输出流前驱项：若前驱亦为 assistant message，瞬态注入 user 占位 item
                if let Some(prev) = result.last() {
                    if prev.get("type").and_then(|t| t.as_str()) == Some("message")
                        && prev.get("role").and_then(|r| r.as_str()) == Some("assistant")
                    {
                        result.push(json!({
                            "type": "message",
                            "role": "user",
                            "content": WIRE_CONTINUATION_NOTE,
                        }));
                    }
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
                        let tool_name = call.tool_name.trim();
                        if tool_name.is_empty() {
                            continue;
                        }
                        let raw_id = sanitize_tool_call_id(&call.id);
                        let id = if raw_id.trim().is_empty() {
                            format!("call_{tool_name}")
                        } else {
                            raw_id
                        };
                        let mut args = canonical_json_string(&call.input);
                        if args.trim().is_empty() {
                            args = "{}".to_string();
                        }
                        result.push(json!({
                            "type": "function_call",
                            "call_id": id,
                            "name": tool_name,
                            "arguments": args,
                        }));
                    }
                }
                for block in &message.blocks {
                    if let AgentMessageBlock::ToolResult {
                        tool_call_id,
                        output,
                        ..
                    } = block
                    {
                        let cleaned = clean_output(
                            &stringify_tool_output(output),
                            &CleanupOptions::default(),
                        );
                        let text = if cleaned.cleaned.is_empty() {
                            "(no output)".to_string()
                        } else {
                            cleaned.cleaned
                        };
                        result.push(json!({
                            "type": "function_call_output",
                            "call_id": sanitize_tool_call_id(tool_call_id),
                            "output": text,
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
///
/// G5-a（T2.3）：NativeSystemRole 分支接入 [resolve_system_role]——openrouter +
/// `anthropic/`|`openai/` 前缀模型 + reasoning → `role:"developer"`，否则
/// `role:"system"`（chat 轨）。缺省 [WireCompat]（supports_reasoning=false →
/// 恒 `false`）时 role 恒 `"system"`，与既有字节一致；user-prefix 分支恒
/// `role:"user"`，不参与 developer 判定。
fn system_prompt_message(
    prompt: &str,
    wire_mode: SystemPromptWireMode,
    compat: WireCompat<'_>,
) -> ChatMessage {
    match wire_mode {
        SystemPromptWireMode::NativeSystemRole => ChatMessage {
            role: resolve_system_role(&compat).to_string(),
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

/// 检测 OpenAI chat wire 消息序列中的孤儿 tool_calls（纯只读，不改写不伪造）。
///
/// 遍历 wire 消息：assistant 的 `tool_calls[]` 各项 `id` 记入 pending；
/// `role:"tool"` 消息的 `tool_call_id` 消去对应 pending。遍历结束后 pending
/// 非空 → 孤儿（上游 OpenAI 将 400：`messages with role 'tool' must follow
/// messages with role 'assistant'`）。返回排序后的孤儿 ID 列表（顺序稳定，
/// 供会话循环补齐重试逐 ID 对账）。
pub fn detect_chat_unpaired_tool_calls(messages: &[ChatMessage]) -> Vec<String> {
    let mut pending: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for msg in messages {
        if msg.role == "assistant" {
            for call in &msg.tool_calls {
                if let Some(id) = call.get("id").and_then(Value::as_str) {
                    if !id.trim().is_empty() {
                        pending.insert(id.to_string());
                    }
                }
            }
        } else if msg.role == "tool" {
            if let Some(tool_call_id) = msg.tool_call_id.as_deref() {
                pending.remove(tool_call_id);
            }
        }
    }
    pending.into_iter().collect()
}

/// OpenAI chat 出站成对性校验入口（详案 02 §3.4 分级守门 · 轨二）。
///
/// - **Debug / CI（`debug_assertions`）**：检测到孤儿 → 立即 panic（Fail-Fast）；
/// - **Release**：返回 [RequestBuildError::UnpairedToolCalls]（含排序
///   `orphan_ids`）并 `tracing::error!` 结构化日志——调用方（会话循环出站
///   组装处）据此执行「本地合成补齐 → 单次重试组包」；仍失败则标记会话
///   `wire_pairing_poisoned`。**禁止**在导线层静默插入假 tool 结果。
pub fn validate_chat_tool_pairing(messages: &[ChatMessage]) -> Result<(), RequestBuildError> {
    let orphan_ids = detect_chat_unpaired_tool_calls(messages);
    if orphan_ids.is_empty() {
        return Ok(());
    }
    let err = RequestBuildError::UnpairedToolCalls {
        protocol: "openai_chat",
        orphan_ids,
    };
    #[cfg(debug_assertions)]
    {
        panic!("OpenAI 导线层校验拦截到孤儿工具调用！{err:?}");
    }
    #[cfg(not(debug_assertions))]
    {
        tracing::error!(
            target: "agent_provider::wire_pairing",
            protocol = "openai_chat",
            error = %err,
            orphan_ids = ?err.orphan_ids(),
            "导线层刚性拦截带毒请求出站（禁止静默伪造 tool_result；调用方须走补齐重试闭环）"
        );
        return Err(err);
    }
    #[allow(unreachable_code)]
    Ok(())
}

/// 从 AgentMessage 序列做 chat 轨成对性预检（tool_calls/tool 映射与推理模式无关）。
///
/// Debug：孤儿 → panic；Release：`Err(UnpairedToolCalls)`。供 engine_provider
/// 在 build 前软失败拦截（不经过 build 入口 tripwire）。
pub fn validate_chat_pairing_from_messages(
    system_prompt: Option<&str>,
    messages: &[std::sync::Arc<AgentMessage>],
) -> Result<(), RequestBuildError> {
    let wire = to_chat_messages(
        system_prompt,
        messages,
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    validate_chat_tool_pairing(&wire)
}

#[cfg(test)]
#[path = "messages_tests.rs"]
mod tests;
