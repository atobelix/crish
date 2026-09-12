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
use std::sync::Arc;

use super::messages::{stringify_tool_output, user_message_content, ChatContent, ChatContentPart};
use super::schema::canonicalize_schema;
use super::tools::{ToolChoice, ToolDefinition};
use super::vendor::{ReasoningEffort, ThinkingIntensity};
use super::RequestBuildContext;
use crate::error::RequestBuildError;
use crate::request::build::dialect::{
    self, assemble_thinking_dialect, DialectBuildOptions, ThinkingDialectFormat,
};

/// Gemini 请求构建选项（对齐 chat 轨 [super::ChatCompletionsRequestOptions] 的 Gemini 子集；
/// 只携带 Gemini generateContent 语义字段，排除 chat 专有注入面）
#[derive(Debug, Clone, Default)]
pub struct GeminiRequestOptions {
    /// 模型名（URL 路径 or body，以发送层取舍；此处放入 body `model`，与 chat 轨同径）
    pub model: Option<String>,
    pub temperature: Option<f64>,
    /// Gemini `maxOutputTokens`（generateContent 原生字段名）
    pub max_output_tokens: Option<u64>,
    /// 01 D5：thinkingIntensity 透传（off → 不含 thinking 相关键）
    pub thinking_intensity: Option<ThinkingIntensity>,
    /// reasoning effort（思考键经 dialect 换算；off/auto → 不注入）
    pub reasoning_effort: Option<ReasoningEffort>,
    /// 用户在 models.yaml 中配置的思考拍平映射（TitleCase → wire）
    pub thinking_map: Option<indexmap::IndexMap<String, String>>,
    /// 显式配置的思考方言组装格式（思考键只来自 dialect）
    pub thinking_format: Option<crate::models::catalog_types::ThinkingFormat>,
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

    // generationConfig（camelCase）：maxOutputTokens / temperature / thinkingConfig
    let mut generation = Map::new();
    if let Some(max_output_tokens) = opts.max_output_tokens {
        generation.insert("maxOutputTokens".to_string(), json!(max_output_tokens));
    }
    if let Some(temperature) = opts.temperature {
        generation.insert("temperature".to_string(), json!(temperature));
    }
    // thinking 键只来自 assemble_thinking_dialect（GeminiThinkingConfig，map 值
    // 原样；plans/04 §2.2——禁止 thinking_to_gemini_thinking_level 把 Max 折 high）
    if let (Some(thinking_val), _) = gemini_thinking_dialect(opts) {
        if let Some(inner) = thinking_val
            .get("generationConfig")
            .and_then(|v| v.get("thinkingConfig"))
        {
            generation.insert("thinkingConfig".to_string(), inner.clone());
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

    // W04 · 出站成对性 Fail-Closed 守门（详案 02 §3.4 轨三补齐）：在 contents
    // 组装完成后刚性拦截孤儿 functionCall——严禁静默伪造 functionResponse
    // 垫片。Debug/CI panic（Fail-Fast 暴露内核断裂）；Release tracing::error!
    // 后中止组包（绝不产出带毒请求体）。会话循环侧应优先调用
    // [validate_gemini_tool_pairing] 走「补齐后单次重试」闭环。
    fail_closed_gemini_pairing_gate(context.messages);

    Value::Object(body)
}

/// 检测 Gemini wire contents 中的孤儿 functionCall（纯只读，不改写不伪造）。
///
/// Gemini functionCall / functionResponse 无独立 call_id，按 **函数名 + 出现
/// 顺序计数** 配对：同名多次调用按顺序与同名多次 response 一一配对；剩余未
/// 配对的 functionCall → 孤儿（上游 Gemini API 将 400 / INVALID_ARGUMENT）。
/// 返回排序后的孤儿合成 ID 列表（`{name}#{occurrence}`，顺序稳定，供会话循环
/// 补齐重试逐 ID 对账）。
///
/// **禁止假阴性误伤**：同名多次调用全部被同名 response 覆盖时不报孤儿；
/// 仅当该名字的 call 计数 > response 计数时，多余部分（按出现顺序）为孤儿。
pub fn detect_gemini_unpaired_tool_calls(messages: &[Arc<AgentMessage>]) -> Vec<String> {
    // 按出现顺序收集 functionCall / functionResponse 的 (name, global_order)
    let mut calls: Vec<(String, usize)> = Vec::new();
    let mut responses: Vec<(String, usize)> = Vec::new();
    let mut order: usize = 0;

    for msg in messages {
        let msg: &AgentMessage = msg;
        match msg.role {
            AgentMessageRole::Assistant => {
                for block in &msg.blocks {
                    if let AgentMessageBlock::ToolCall(call) = block {
                        let name = call.tool_name.trim();
                        if !name.is_empty() {
                            calls.push((name.to_string(), order));
                            order += 1;
                        }
                    }
                }
                // 历史水合兜底：assistant 同体 ToolResult 块
                for block in &msg.blocks {
                    if let AgentMessageBlock::ToolResult { tool_name, .. } = block {
                        let name = tool_name.trim();
                        if !name.is_empty() {
                            responses.push((name.to_string(), order));
                            order += 1;
                        }
                    }
                }
            }
            AgentMessageRole::Tool => {
                for block in &msg.blocks {
                    if let AgentMessageBlock::ToolResult { tool_name, .. } = block {
                        let name = tool_name.trim();
                        if !name.is_empty() {
                            responses.push((name.to_string(), order));
                            order += 1;
                        }
                    }
                }
            }
            _ => {}
        }
    }

    // 同名配对：按出现顺序 FIFO，多出的 call 为孤儿
    use std::collections::{BTreeMap, BTreeSet};
    let mut response_pool: BTreeMap<String, usize> = BTreeMap::new();
    for (name, _) in &responses {
        *response_pool.entry(name.clone()).or_insert(0) += 1;
    }

    let mut call_seen: BTreeMap<String, usize> = BTreeMap::new();
    let mut orphans: BTreeSet<String> = BTreeSet::new();
    for (name, _) in &calls {
        let seen = call_seen.entry(name.clone()).or_insert(0);
        let available = response_pool.get(name).copied().unwrap_or(0);
        if *seen >= available {
            orphans.insert(format!("{name}#{seen}"));
        }
        *seen += 1;
    }

    orphans.into_iter().collect()
}

/// Gemini 出站成对性校验入口（详案 02 §3.4 分级守门 · 轨三补齐）。
///
/// - **Debug / CI（`debug_assertions`）**：检测到孤儿 → 立即 panic（Fail-Fast，
///   迫使开发者在内核层根治，而非在导线层掩盖）；
/// - **Release**：返回 [RequestBuildError::UnpairedToolCalls]（含排序
///   `orphan_ids`）并 `tracing::error!` 结构化日志——调用方（会话循环出站
///   组装处）据此执行「本地合成补齐 → 单次重试组包」；仍失败则标记会话
///   `wire_pairing_poisoned`。**禁止**在导线层静默插入假 functionResponse。
pub fn validate_gemini_tool_pairing(messages: &[Arc<AgentMessage>]) -> Result<(), RequestBuildError> {
    let orphan_ids = detect_gemini_unpaired_tool_calls(messages);
    if orphan_ids.is_empty() {
        return Ok(());
    }
    let err = RequestBuildError::UnpairedToolCalls {
        protocol: "gemini",
        orphan_ids,
    };
    #[cfg(debug_assertions)]
    {
        panic!("Gemini 导线层校验拦截到孤儿工具调用！{err:?}");
    }
    #[cfg(not(debug_assertions))]
    {
        tracing::error!(
            target: "agent_provider::wire_pairing",
            protocol = "gemini",
            error = %err,
            orphan_ids = ?err.orphan_ids(),
            "导线层刚性拦截带毒请求出站（禁止静默伪造 functionResponse；调用方须走补齐重试闭环）"
        );
        return Err(err);
    }
    #[allow(unreachable_code)]
    Ok(())
}

/// build 入口接线的 fail-closed 守门（Debug panic / Release error + 拒绝产出）。
///
/// `build_gemini_request_body` 返回签名保持 `Value`（既有调用面零破坏）：
/// Release 下一旦拦截即 `tracing::error!` 并 panic——语义为「带毒请求体绝不
/// 静默出站」；会话循环侧须优先捕获 [validate_gemini_tool_pairing] 的
/// `Err(UnpairedToolCalls)` 走补齐重试，正常路径不会抵达本函数的错误分支。
fn fail_closed_gemini_pairing_gate(messages: &[Arc<AgentMessage>]) {
    if let Err(err) = validate_gemini_tool_pairing(messages) {
        tracing::error!(
            target: "agent_provider::wire_pairing",
            protocol = "gemini",
            error = %err,
            orphan_ids = ?err.orphan_ids(),
            "build_gemini 入口守门拦截：拒绝构造带毒请求体"
        );
        panic!("Gemini 导线层入口守门拦截到孤儿工具调用（带毒请求体禁止出站）：{err:?}");
    }
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
                // 多模态：metadata.contentParts 含图 → inline_data / fileData part；
                // 否则纯文本（plans/04 §4.2——禁止把 data URL 剥成 [image] 文本丢图）
                let content = user_message_content(msg);
                let parts: Vec<Value> = match &content {
                    ChatContent::Text(text) => text_parts(text),
                    ChatContent::Parts(parts) => parts.iter().map(gemini_user_part).collect(),
                };
                push_gemini_content(&mut contents, "user", parts);
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
                push_gemini_content(&mut contents, "model", parts);

                // 历史水合兜底：若 assistant 消息同体携带 ToolResult 块（hydrate.rs）
                let tool_parts = tool_result_gemini_parts(msg);
                push_gemini_content(&mut contents, "user", tool_parts);
            }
            AgentMessageRole::Tool => {
                let parts = tool_result_gemini_parts(msg);
                push_gemini_content(&mut contents, "user", parts);
            }
            AgentMessageRole::System => {
                // system 消息并入 systemInstruction（append_system_instruction 处理）
            }
        }
    }
    contents
}

fn tool_result_gemini_parts(msg: &AgentMessage) -> Vec<Value> {
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
    parts
}

fn push_gemini_content(contents: &mut Vec<Value>, role: &str, parts: Vec<Value>) {
    if parts.is_empty() {
        return;
    }
    if role == "user" && contents.last().is_some_and(|c| c["role"] == "user") {
        if let Some(last_msg) = contents.last_mut() {
            if let Some(last_parts) = last_msg.get_mut("parts").and_then(|p| p.as_array_mut()) {
                last_parts.extend(parts);
                return;
            }
        }
    }
    contents.push(gemini_content(role, parts));
}

/// Gemini content 载体：`{role, parts}`
fn gemini_content(role: &str, parts: Vec<Value>) -> Value {
    json!({ "role": role, "parts": parts })
}

/// user 文本 → Gemini text parts（清洗 inline data url 占位，对齐既有语义）
fn text_parts(text: &str) -> Vec<Value> {
    let cleaned = text.trim().to_string();
    if cleaned.is_empty() {
        Vec::new()
    } else {
        vec![json!({ "text": cleaned })]
    }
}

/// Gemini user part：text → `{text}`；image_url → `inline_data`（data URL）/
/// `file_data`（https URL），禁止只发 `[图片附件]` 文本备注（plans/04 §0.1 #6）。
fn gemini_user_part(part: &ChatContentPart) -> Value {
    match part {
        ChatContentPart::Text { text, .. } => json!({ "text": text }),
        ChatContentPart::ImageUrl { url, .. } => {
            if let Some((mime, data)) = split_data_url(url) {
                json!({ "inline_data": { "mime_type": mime, "data": data } })
            } else {
                json!({ "file_data": { "file_uri": url } })
            }
        }
    }
}

/// `data:image/<mime>;base64,<payload>` → (mime, base64 payload)；非 data URL → None
fn split_data_url(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("data:")?;
    let (mime, payload) = rest.split_once(";base64,")?;
    if mime.is_empty() || payload.is_empty() {
        return None;
    }
    Some((mime.to_string(), payload.to_string()))
}

/// Gemini 思考键组装（plans/04 §2.2）：`thinking_format != gemini`（含未声明）→
/// 不注入（fail-closed）；effort 经 dialect 换算；map 值原样进
/// `generationConfig.thinkingConfig`。
fn gemini_thinking_dialect(opts: &GeminiRequestOptions) -> (Option<Value>, Option<u64>) {
    if opts.thinking_format != Some(crate::models::catalog_types::ThinkingFormat::Gemini) {
        return (None, None);
    }
    let dialect_effort: Option<dialect::ReasoningEffort> =
        if let Some(effort) = opts.reasoning_effort {
            match effort {
                ReasoningEffort::Off | ReasoningEffort::Auto => None,
                other => Some(other.into()),
            }
        } else {
            opts.thinking_intensity
                .filter(|i| *i != ThinkingIntensity::Off)
                .map(Into::into)
        };
    let Some(effort) = dialect_effort else {
        return (None, None);
    };
    assemble_thinking_dialect(&DialectBuildOptions {
        effort,
        format: ThinkingDialectFormat::GeminiThinkingConfig,
        // 0 = 无已知上限：dialect 不发明 64000 兜底（轨G P2，对齐 build_chat）。
        // 仅当 opts.max_output_tokens 已为 Some 时才写请求体 maxOutputTokens 字段
        // （见 build_gemini_request_body 的 generationConfig 分支）；None 时省略。
        max_output_tokens: opts.max_output_tokens.unwrap_or(0),
        thinking_map: opts.thinking_map.as_ref(),
    })
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
