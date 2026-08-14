//! Gemini generateContent 请求体构建与差异化请求头（战役 R2 · T2.1b；G7-a）
//!
//! 对齐 `model:provider-google.ts` / Gemini generateContent API（02 §二、§六；定稿方案
//! §三 T2.1：gemini 请求体 builder + 差异化头 x-goog-api-key）。
//!
//! 与 chat/responses 轨的关键形状差异（对齐 Gemini 原生 generateContent）：
//! - `contents`（`[{role:"user"|"model",parts:[...]}]`）替代 `messages`——角色值域
//!   仅 `user`/`model`（assistant → model）；系统提示词走顶层 `systemInstruction`
//!   （`{parts:[{text}]}`），**不进入** contents（禁复用 chat 轨形状）；
//! - `generationConfig`（camelCase）承载 `maxOutputTokens` / `temperature` /
//!   `thinking_level`（思考透传），替代 chat 轨 `max_tokens` / `reasoning_effort`；
//! - `tools` 为 `[{functionDeclarations:[{name,description,parameters}]}]`（DUP 语义：
//!   **同工具名函数声明只保留首个**，复用 P6 既有 `canonicalize_schema` 单点规范化）；
//! - `toolConfig`（`{functionCallingConfig:{mode}}`）替代 chat 轨 `tool_choice`；
//! - 消息映射直接从 AgentMessage 块构建（user/assistant text → `part.text`；
//!   assistant tool_calls → `part.functionCall`；tool_result → `part.functionResponse`），
//!   每条 AgentMessage 聚合成一条 content，块级 part 同 content 内并列。
//!
//! 头组装（[gemini_request_headers]）：Gemini 原生 key 头 `x-goog-api-key`
//! （对齐 `x-goog-api-key` 规约，01 R2 "Gemini Authorization 与 x-goog-api-key"）
//! + `content-type: application/json`。
//!
//! SR-06e · 拆分 · ≠ EL：门面文件。实现域即本文件（含私有映射/工具辅助）；
//! 测试旁挂 build_gemini_tests.rs（经 #[path] 接线）。

use conex_compaction::clean_output::{clean_output, CleanupOptions};
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use serde_json::{json, Map, Value};

use super::messages::{stringify_tool_output, strip_inline_data_urls};
use super::schema::canonicalize_schema;
use super::tools::{ToolChoice, ToolDefinition};
use super::vendor::{thinking_to_gemini_thinking_level, ThinkingIntensity};
use super::RequestBuildContext;

/// Gemini 请求构建选项（对齐 chat 轨 [super::ChatCompletionsRequestOptions] 的 Gemini 子集；
/// 只携带 Gemini generateContent 语义字段，排除 chat 专有注入面）
#[derive(Debug, Clone, Default)]
pub struct GeminiRequestOptions {
    /// 模型名（URL 路径 or body，以发送层取舍；此处放入 body `model`，与 chat 轨同径）
    pub model: Option<String>,
    pub temperature: Option<f64>,
    /// Gemini `maxOutputTokens`（generateContent 原生字段名）
    pub max_output_tokens: Option<u64>,
    /// 01 D5：thinkingIntensity 透传（off → 不含 thinking 相关键；其余档位 →
    /// `generationConfig.thinking_level`）
    pub thinking_intensity: Option<ThinkingIntensity>,
    pub tool_choice: Option<ToolChoice>,
}

/// 构建 Gemini generateContent 请求体（compactObject 等价：None 字段一律省略）
///
/// 返回 `{model, contents, systemInstruction?, generationConfig?, tools?, toolConfig?}`。
/// - `contents`：由 [RequestBuildContext.messages] 块级映射直接构建（每 AgentMessage →
///   一条 content；assistant 的 text 与 tool-call 块并入同一条 model content）；
/// - `systemInstruction`：全局 system prompt 非空时输出（兜底为上下文内
///   system 角色消息文本）——**不注入 contents**；
/// - `systemInstruction` 不随 wire_mode 改写（Gemini 原生无 user-prefix 语义，
///   system-instruction 恒顶层）；上下文内 system 消息同样贡献 systemInstruction；
/// - `generationConfig`：maxOutputTokens / temperature / thinking_level（思考启用时插入）；
/// - `tools` / `toolConfig`：工具列表非空时输出。
pub fn build_gemini_request_body(
    opts: &GeminiRequestOptions,
    context: &RequestBuildContext,
) -> Value {
    let mut body = Map::new();

    if let Some(model) = &opts.model {
        // model 同时放 body（对齐 chat/responses 轨；URL 路径侧由发送层按协议路由取舍）
        body.insert("model".to_string(), json!(model));
    }

    // systemInstruction：全局 prompt 优先；缺失时回退上下文内 system 角色消息拼接
    append_system_instruction(&mut body, context);

    // contents（块级映射；从 AgentMessage 直接构建，禁复用 chat 轨形状）
    let contents = to_gemini_contents(context.messages);
    body.insert("contents".to_string(), json!(contents));

    // generationConfig（camelCase）：maxOutputTokens / temperature / thinking_level
    let mut generation = Map::new();
    if let Some(max_output_tokens) = opts.max_output_tokens {
        generation.insert("maxOutputTokens".to_string(), json!(max_output_tokens));
    }
    if let Some(temperature) = opts.temperature {
        generation.insert("temperature".to_string(), json!(temperature));
    }
    // 01 D5：thinkingIntensity 透传。off → 不注入任何 thinking 相关键；
    // 启用 → generationConfig.thinking_level（复用 vendor 线值换算）
    if let Some(intensity) = opts.thinking_intensity {
        if intensity != ThinkingIntensity::Off {
            generation.insert(
                "thinking_level".to_string(),
                json!(thinking_to_gemini_thinking_level(intensity)),
            );
        }
    }
    if !generation.is_empty() {
        body.insert("generationConfig".to_string(), Value::Object(generation));
    }

    if !context.tools.is_empty() {
        let declarations: Vec<Value> = context
            .tools
            .iter()
            .map(to_gemini_function_declaration)
            .collect();
        body.insert(
            "tools".to_string(),
            json!([{ "functionDeclarations": declarations }]),
        );
        body.insert(
            "toolConfig".to_string(),
            gemini_tool_config(opts.tool_choice.as_ref().unwrap_or(&ToolChoice::Auto)),
        );
    }

    Value::Object(body)
}

/// Gemini 差异化请求头（对齐 01 R2 "Gemini Authorization 与 x-goog-api-key 的差异化头组装"）。
///
/// Gemini generateContent 原生 key 鉴权头 `x-goog-api-key` + `content-type: application/json`
/// （发送层把本返回合并进基础请求头）。api_key 为空串时省略 key 头（零参数）。
pub fn gemini_request_headers(api_key: &str) -> Vec<(&'static str, String)> {
    let mut headers: Vec<(&'static str, String)> = Vec::new();
    if !api_key.is_empty() {
        headers.push(("x-goog-api-key", api_key.to_string()));
    }
    headers.push(("content-type", "application/json".to_string()));
    headers
}

/// 全局 system prompt → 顶层 `systemInstruction`（`{parts:[{text}]}`）。
///
/// 优先 [RequestBuildContext.system_prompt]；缺失时把上下文内 system 角色消息
/// 的文本 join 为一条 systemInstruction（逐条输出会重复全局 prompt 语义）。
fn append_system_instruction(body: &mut Map<String, Value>, context: &RequestBuildContext) {
    let mut parts: Vec<String> = Vec::new();
    if let Some(prompt) = &context.system_prompt {
        if !prompt.trim().is_empty() {
            parts.push(prompt.trim().to_string());
        }
    }
    // 上下文内 system 消息文本拼接（不含已并入 system_prompt 的全局提示，避免重复）
    for msg in context.messages {
        let msg = msg.borrow_message();
        if msg.role == AgentMessageRole::System {
            let text = msg.text();
            if !text.trim().is_empty() {
                parts.push(text.trim().to_string());
            }
        }
    }
    if parts.is_empty() {
        return;
    }
    let texts: Vec<Value> = parts.iter().map(|text| json!({ "text": text })).collect();
    body.insert("systemInstruction".to_string(), json!({ "parts": texts }));
}

/// AgentMessage → Gemini contents（块级映射，每消息一条 content）
///
/// - user：text 块 → `[{text}]`
/// - assistant(model)：text 块 → `[{text}]`；tool-call 块 → `[{functionCall:{name,args}}]`；
///   两者并入同一条 model content（同消息多 part）
/// - tool：每个 tool-result 块 → `[{functionResponse:{name,response}}]`（并入同一条 user content）
/// - system：跳过（并入 systemInstruction）
fn to_gemini_contents<M: BorrowMessage>(messages: &[M]) -> Vec<Value> {
    let mut contents: Vec<Value> = Vec::new();
    for msg in messages {
        let msg = msg.borrow_message();
        match msg.role {
            AgentMessageRole::User => {
                let parts = text_parts(&msg.text());
                if parts.is_empty() {
                    continue;
                }
                contents.push(gemini_content("user", parts));
            }
            AgentMessageRole::Assistant => {
                let mut parts: Vec<Value> = Vec::new();
                for block in &msg.blocks {
                    match block {
                        AgentMessageBlock::Text { text } => {
                            if !text.trim().is_empty() {
                                parts.push(json!({ "text": text }));
                            }
                        }
                        AgentMessageBlock::ToolCall(call) => {
                            // functionCall part：args 取结构化入参（null 兜底 `{}`——
                            // Gemini 要求 args 为对象；对齐 parse 侧 functionCall.args 读取）
                            let args = if call.input.is_object() {
                                call.input.clone()
                            } else {
                                json!({ "value": call.input })
                            };
                            parts.push(json!({
                                "functionCall": {
                                    "name": call.tool_name,
                                    "args": args,
                                }
                            }));
                        }
                        _ => {}
                    }
                }
                if parts.is_empty() {
                    continue;
                }
                contents.push(gemini_content("model", parts));
            }
            AgentMessageRole::Tool => {
                let mut parts: Vec<Value> = Vec::new();
                for block in &msg.blocks {
                    if let AgentMessageBlock::ToolResult {
                        tool_name, output, ..
                    } = block
                    {
                        // T-34（R-J）：wire 投影面统一清洗（与 chat 轨 tool 消息同口径，
                        // 确定性 + 幂等）
                        let cleaned = clean_output(
                            &stringify_tool_output(output),
                            &CleanupOptions::default(),
                        );
                        parts.push(json!({
                            "functionResponse": {
                                "name": tool_name,
                                "response": tool_response_value(&cleaned.cleaned),
                            }
                        }));
                    }
                }
                if parts.is_empty() {
                    continue;
                }
                contents.push(gemini_content("user", parts));
            }
            AgentMessageRole::System => {
                // system 消息并入 systemInstruction（append_system_instruction 处理）
            }
        }
    }
    contents
}

/// Gemini content 载体：`{role, parts}`
fn gemini_content(role: &str, parts: Vec<Value>) -> Value {
    json!({ "role": role, "parts": parts })
}

/// user 文本 → Gemini text parts（清洗 inline data url，对齐 user_message_content 语义）
fn text_parts(text: &str) -> Vec<Value> {
    let cleaned = strip_inline_data_urls(text).trim().to_string();
    if cleaned.is_empty() {
        Vec::new()
    } else {
        vec![json!({ "text": cleaned })]
    }
}

/// ToolDefinition → Gemini functionDeclarations 条目（参数单点规范化）
fn to_gemini_function_declaration(tool: &ToolDefinition) -> Value {
    json!({
        "name": tool.name,
        "description": tool.description,
        "parameters": canonicalize_schema(&tool.effective_input_schema()),
    })
}

/// ToolChoice → Gemini toolConfig `{functionCallingConfig:{mode}}`
///
/// 对齐 Gemini generateContent tool_config 语义：auto → AUTO、none → NONE、
/// required/指定函数 → ANY（指定函数在 functionDeclarations 已含，无需白名单托管）。
fn gemini_tool_config(choice: &ToolChoice) -> Value {
    let mode = match choice {
        ToolChoice::Auto => "AUTO",
        ToolChoice::None => "NONE",
        ToolChoice::Required | ToolChoice::Function { .. } => "ANY",
    };
    json!({ "functionCallingConfig": { "mode": mode } })
}

/// tool 输出 → Gemini functionResponse.response（须为对象/数组）：
/// 可 JSON 解析则原样复用；否则包装为 `{"result": <string>}`（对齐 Gemini
/// response 对象要求，避免裸字符串 400）。
fn tool_response_value(output: &str) -> Value {
    if output.trim().is_empty() {
        return json!({ "result": "" });
    }
    match serde_json::from_str::<Value>(output) {
        Ok(value) if value.is_array() || value.is_object() => value,
        _ => json!({ "result": output }),
    }
}

/// Borrow 桥（对齐 messages.rs `Borrow<AgentMessage>` 泛型消费面：`&AgentMessage`
/// 与 `Arc<AgentMessage>` 均满足）。局部辅助，避免扩大影响面。
trait BorrowMessage {
    fn borrow_message(&self) -> &AgentMessage;
}

impl BorrowMessage for AgentMessage {
    fn borrow_message(&self) -> &AgentMessage {
        self
    }
}

impl BorrowMessage for std::sync::Arc<AgentMessage> {
    fn borrow_message(&self) -> &AgentMessage {
        self
    }
}

// 测试旁挂接线（SR-06e）
#[cfg(test)]
#[path = "build_gemini_tests.rs"]
mod tests;
