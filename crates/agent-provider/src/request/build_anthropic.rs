//! Anthropic Messages API 请求体构建域（多模型适配战役 R2 T2.1a / G7-a）
//!
//! 独立于 chat/responses 两轨的第三协议请求体（对齐 pi-ai
//! `@earendil-works/pi-ai/dist/api/anthropic-messages.js` buildParams 的形状语义，
//! 不共享 chat 轨的 tool_calls 数组形状——Anthropic 用 content 块数组承载
//! `tool_use` / `tool_result` / `text` / `thinking`）。
//!
//! 请求体形状（anthropic.messages API）：
//! ```json
//! {
//!   "model": "claude-...",
//!   "system": "<string>",
//!   "messages": [
//!     { "role": "user", "content": [ {"type":"text","text":"..."} ] },
//!     { "role": "assistant", "content": [
//!         {"type":"text","text":"..."},
//!         {"type":"thinking","thinking":"..."},
//!         {"type":"tool_use","id":"...","name":"...","input":{...}}
//!     ]},
//!     { "role": "user", "content": [
//!         {"type":"tool_result","tool_use_id":"...","content":"..."}
//!     ]}
//!   ],
//!   "max_tokens": 2048,
//!   "tools": [ {"name":"...","description":"...","input_schema":{...}} ],
//!   "thinking": { "type":"enabled", "budget_tokens": 2048 }
//! }
//! ```
//!
//! 差异化请求头：[anthropic_request_headers]（x-api-key / anthropic-version /
//!   content-type: application/json）。
//!
//! 复用基建：thinking 预算经 [super::vendor::effort_to_budget_tokens] /
//! [super::vendor::thinking_to_budget_tokens] 换算；消息块消毒复用
//! [super::messages::sanitize_tool_call_id] 与 T-34 清洗
//! [conex_compaction::clean_output::clean_output]；input_schema 复用
//! [super::schema::canonicalize_schema]。

use std::borrow::Borrow;

use conex_compaction::clean_output::{clean_output, CleanupOptions};
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use serde_json::{json, Map, Value};

use super::cache::allocate_breakpoints;
use super::messages::{
    sanitize_tool_call_id, stringify_tool_output, user_message_content, ChatContent,
    ChatContentPart, WIRE_CONTINUATION_NOTE,
};
use super::schema::canonicalize_schema;
use super::tools::ToolChoice;
use super::vendor::ReasoningEffort;
use super::{RequestBuildContext, ThinkingIntensity};
use crate::error::RequestBuildError;
use crate::request::build::dialect::{
    self, assemble_thinking_dialect, DialectBuildOptions, ThinkingDialectFormat,
};

/// anthropic.messages 接口显式版本头
pub const ANTHROPIC_VERSION: &str = "2023-06-01";

/// Anthropic 请求体构建选项（对齐 pi-ai buildParams 的 opts 子集）
#[derive(Debug, Clone, Default)]
pub struct AnthropicRequestOptions {
    /// 模型名
    pub model: Option<String>,
    /// 是否流式（缺省 false；流式头由发送层决定）
    pub stream: Option<bool>,
    pub temperature: Option<f64>,
    /// max_tokens（Anthropic 官方恒 `max_tokens`，无三字段兼容）
    pub max_tokens: Option<u64>,
    /// reasoning effort（旧代际 → thinking.enabled budget_tokens）
    pub reasoning_effort: Option<ReasoningEffort>,
    /// 01 D5 thinkingIntensity 透传（提供时覆盖 reasoning_effort 换算）
    pub thinking_intensity: Option<ThinkingIntensity>,
    /// 显式下发的精确 Token 预算（1024 ~ 64000）
    pub thinking_budget: Option<u64>,
    /// 用户在 models.yaml 中配置的思考拍平映射（TitleCase → wire）
    pub thinking_map: Option<indexmap::IndexMap<String, String>>,
    /// 显式配置的思考方言组装格式（思考键只来自 dialect）
    pub thinking_format: Option<crate::models::catalog_types::ThinkingFormat>,
    pub tool_choice: Option<ToolChoice>,
    /// 显式 PromptCache 策略
    pub cache: Option<super::cache::CachePolicy>,
}

/// 默认 Anthropic 物理最大输出 Token 限制（64K）
pub const DEFAULT_ANTHROPIC_MAX_OUTPUT: u64 = 64_000;

/// 构建 Anthropic Messages API 请求体（compactObject 等价：None 字段一律省略）
pub fn build_anthropic_request_body(
    opts: &AnthropicRequestOptions,
    context: &RequestBuildContext,
) -> Value {
    let mut body = Map::new();

    if let Some(model) = &opts.model {
        body.insert("model".to_string(), json!(model));
    }

    // 1. system prompt 构造与缓存断点注入
    let has_system = context
        .system_prompt
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .is_some();
    let has_messages = !context.messages.is_empty();
    let bp_plan = allocate_breakpoints(context.tools.len(), has_system, has_messages);

    if let Some(prompt) = build_system_prompt_string(context.system_prompt.as_deref()) {
        if bp_plan.system {
            body.insert(
                "system".to_string(),
                json!([
                    {
                        "type": "text",
                        "text": prompt,
                        "cache_control": { "type": "ephemeral" }
                    }
                ]),
            );
        } else {
            body.insert("system".to_string(), json!(prompt));
        }
    }

    if let Some(stream) = opts.stream {
        body.insert("stream".to_string(), json!(stream));
    }
    if let Some(temperature) = opts.temperature {
        body.insert("temperature".to_string(), json!(temperature));
    }

    // 2. thinking 参数与 max_tokens 自动安全抬升 (max_tokens >= budget + 4096)
    //    思考键只来自 assemble_thinking_dialect（AnthropicBudget：用户字典数字或
    //    fail-closed；plans/04 §3/§7.3——已删除 anthropic_thinking_object /
    //    effort_to_budget_tokens 魔法刻度生产调用）
    let (thinking_obj, budget) = anthropic_thinking_dialect(opts);
    if let Some(thinking) = thinking_obj {
        // dialect 输出为 `{"thinking": {...}}` 顶层包裹，取内层对象注入
        if let Some(inner) = thinking.get("thinking") {
            body.insert("thinking".to_string(), inner.clone());
        }
    }

    let min_max_tokens = budget.map(|b| b.saturating_add(4096)).unwrap_or(2048);
    let final_max_tokens = match opts.max_tokens {
        Some(m) => {
            if budget.is_some() {
                m.max(min_max_tokens)
            } else {
                m
            }
        }
        None => min_max_tokens,
    };
    let clamped_max_tokens = final_max_tokens.min(DEFAULT_ANTHROPIC_MAX_OUTPUT);
    body.insert("max_tokens".to_string(), json!(clamped_max_tokens));

    // 3. tools：`[{name, description, input_schema, cache_control?}]`
    if !context.tools.is_empty() {
        let tool_count = context.tools.len();
        body.insert(
            "tools".to_string(),
            json!(context
                .tools
                .iter()
                .enumerate()
                .map(|(idx, tool)| {
                    let mut map = serde_json::Map::new();
                    map.insert("name".to_string(), json!(tool.name));
                    map.insert("description".to_string(), json!(tool.description));
                    map.insert(
                        "input_schema".to_string(),
                        canonicalize_schema(&tool.effective_input_schema()),
                    );
                    if bp_plan.tools && (idx + 1 == tool_count) {
                        map.insert("cache_control".to_string(), json!({ "type": "ephemeral" }));
                    }
                    Value::Object(map)
                })
                .collect::<Vec<_>>()),
        );
        body.insert(
            "tool_choice".to_string(),
            anthropic_tool_choice(opts.tool_choice.as_ref().unwrap_or(&ToolChoice::Auto)),
        );
    }

    // 4. messages
    let mut messages = to_anthropic_messages(context);
    // W04 · 出站成对性 Fail-Closed 守门（详案 02 §3.4 轨一）：在 messages
    // 序列化完成后、进入请求体前刚性拦截孤儿 tool_use——严禁静默伪造
    // tool_result 垫片。Debug/CI panic（Fail-Fast 暴露内核断裂）；Release
    // tracing::error! 后中止组包（绝不产出带毒请求体）。
    fail_closed_anthropic_pairing_gate(&messages);
    if bp_plan.messages {
        inject_last_message_cache_control(&mut messages);
    }
    body.insert("messages".to_string(), json!(messages));

    Value::Object(body)
}

/// 检测 Anthropic wire 消息序列中的孤儿 tool_use（纯只读，不改写不伪造）。
///
/// 遍历 messages：assistant content 中 `type:"tool_use"` 的 `id` 记入 pending；
/// user content 中 `type:"tool_result"` 的 `tool_use_id` 消去对应 pending。
/// 遍历结束后 pending 非空 → 孤儿（上游 Anthropic API 将 400：
/// `each tool_use block must have a corresponding tool_result block`）。
/// 返回排序后的孤儿 ID 列表（顺序稳定，供会话循环补齐重试逐 ID 对账）。
pub fn detect_anthropic_unpaired_tool_calls(messages: &[Value]) -> Vec<String> {
    let mut pending: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for msg in messages {
        let role = msg.get("role").and_then(Value::as_str).unwrap_or_default();
        let Some(content) = msg.get("content").and_then(Value::as_array) else {
            continue;
        };
        for block in content {
            let block_type = block
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if role == "assistant" && block_type == "tool_use" {
                if let Some(id) = block.get("id").and_then(Value::as_str) {
                    if !id.trim().is_empty() {
                        pending.insert(id.to_string());
                    }
                }
            } else if role == "user" && block_type == "tool_result" {
                if let Some(tool_use_id) = block.get("tool_use_id").and_then(Value::as_str) {
                    pending.remove(tool_use_id);
                }
            }
        }
    }
    pending.into_iter().collect()
}

/// Anthropic 出站成对性校验入口（详案 02 §3.4 分级守门）。
///
/// - **Debug / CI（`debug_assertions`）**：检测到孤儿 → 立即 panic（Fail-Fast，
///   迫使开发者在内核层根治，而非在导线层掩盖）；
/// - **Release**：返回 [RequestBuildError::UnpairedToolCalls]（含排序
///   `orphan_ids`）并 `tracing::error!` 结构化日志——调用方（会话循环出站
///   组装处）据此执行「本地合成补齐 → 单次重试组包」；仍失败则标记会话
///   `wire_pairing_poisoned`。**禁止**在导线层静默插入假 tool_result。
pub fn validate_anthropic_tool_pairing(messages: &[Value]) -> Result<(), RequestBuildError> {
    let orphan_ids = detect_anthropic_unpaired_tool_calls(messages);
    if orphan_ids.is_empty() {
        return Ok(());
    }
    let err = RequestBuildError::UnpairedToolCalls {
        protocol: "anthropic",
        orphan_ids,
    };
    #[cfg(debug_assertions)]
    {
        panic!("Anthropic 导线层校验拦截到孤儿工具调用！{err:?}");
    }
    #[cfg(not(debug_assertions))]
    {
        tracing::error!(
            target: "agent_provider::wire_pairing",
            protocol = "anthropic",
            error = %err,
            orphan_ids = ?err.orphan_ids(),
            "导线层刚性拦截带毒请求出站（禁止静默伪造 tool_result；调用方须走补齐重试闭环）"
        );
        return Err(err);
    }
    #[allow(unreachable_code)]
    Ok(())
}

/// 出站前从 [RequestBuildContext] 直接成对性预检（不经过 build 入口 panic tripwire）。
///
/// Debug：孤儿 → panic（Fail-Fast）；Release：返回 `Err(UnpairedToolCalls)`。
/// 供 engine_provider 在调用 `build_anthropic_request_body` 前软失败拦截。
pub fn validate_anthropic_pairing_from_context(
    context: &RequestBuildContext,
) -> Result<(), RequestBuildError> {
    let messages = to_anthropic_messages(context);
    validate_anthropic_tool_pairing(&messages)
}

/// build 入口接线的 fail-closed 守门（Debug panic / Release error + 拒绝产出）。
///
/// `build_anthropic_request_body` 返回签名保持 `Value`（既有 ~100 调用面零
/// 破坏）：Release 下一旦拦截即 `tracing::error!` 并 panic——语义为「带毒
/// 请求体绝不静默出站」；会话循环侧须优先捕获 [validate_anthropic_tool_pairing]
/// 的 `Err(UnpairedToolCalls)` 走补齐重试，正常路径不会抵达本函数的错误分支。
fn fail_closed_anthropic_pairing_gate(messages: &[Value]) {
    if let Err(err) = validate_anthropic_tool_pairing(messages) {
        tracing::error!(
            target: "agent_provider::wire_pairing",
            protocol = "anthropic",
            error = %err,
            orphan_ids = ?err.orphan_ids(),
            "build_anthropic 入口守门拦截：拒绝构造带毒请求体"
        );
        panic!("Anthropic 导线层入口守门拦截到孤儿工具调用（带毒请求体禁止出站）：{err:?}");
    }
}

/// 在最后一条 user 或 tool 消息的末尾块上注入 cache_control
fn inject_last_message_cache_control(messages: &mut [Value]) {
    for msg in messages.iter_mut().rev() {
        if let Some(role) = msg.get("role").and_then(|r| r.as_str()) {
            if role == "user" {
                if let Some(content) = msg.get_mut("content").and_then(|c| c.as_array_mut()) {
                    if let Some(last_block) = content.last_mut() {
                        if let Some(obj) = last_block.as_object_mut() {
                            obj.insert("cache_control".to_string(), json!({ "type": "ephemeral" }));
                            break;
                        }
                    }
                }
            }
        }
    }
}

/// 差异化请求头（anthropic.messages API）：x-api-key / anthropic-version /
///   content-type: application/json
pub fn anthropic_request_headers(api_key: &str) -> Vec<(&'static str, String)> {
    vec![
        ("x-api-key", api_key.to_string()),
        ("anthropic-version", ANTHROPIC_VERSION.to_string()),
        ("content-type", "application/json".to_string()),
    ]
}

/// 聚合带 beta 功能标头的 Anthropic 完整请求头
pub fn build_anthropic_headers(
    api_key: &str,
    opts: &AnthropicRequestOptions,
    has_cache: bool,
) -> Vec<(&'static str, String)> {
    let mut headers = anthropic_request_headers(api_key);
    let mut betas = Vec::new();
    if has_cache {
        betas.push("prompt-caching-2024-07-31");
    }
    if opts.thinking_budget.is_some()
        || opts
            .thinking_intensity
            .is_some_and(|i| i != ThinkingIntensity::Off)
        || opts
            .reasoning_effort
            .is_some_and(|e| !matches!(e, ReasoningEffort::Off | ReasoningEffort::Auto))
    {
        betas.push("interleaved-thinking-2025-05-14");
    }
    if opts.max_tokens.is_some_and(|m| m > 4096) {
        betas.push("output-128k-2025-02-19");
    }
    if !betas.is_empty() {
        headers.push(("anthropic-beta", betas.join(",")));
    }
    headers
}

/// system prompt 稳定构造（字符串形态；trim + 空值归一）
fn build_system_prompt_string(system_prompt: Option<&str>) -> Option<String> {
    system_prompt
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// thinking 参数（对齐 pi-ai buildParams 的 budget-based 形态；plans/04 §3）
///
/// 思考键唯一入口 = [assemble_thinking_dialect]（`AnthropicBudget`）：
/// - `thinking_format != Anthropic`（含未声明）→ 不注入（fail-closed，§2.3）；
/// - effort 为 None / off / auto → 不注入；
/// - 预算只来自用户字典 `High: "16384"` 等（≥1024）；值 `adaptive` →
///   `{"type":"adaptive"}`；不可解析 → 不注入（不降级到魔法刻度）。
///
/// 返回值第二项 = 供 max_tokens 自动抬升的预算（dialect 产出的 budget_tokens）。
fn anthropic_thinking_dialect(opts: &AnthropicRequestOptions) -> (Option<Value>, Option<u64>) {
    if opts.thinking_format != Some(crate::models::catalog_types::ThinkingFormat::Anthropic) {
        return (None, None);
    }
    // effort：reasoning_effort 优先，thinking_intensity 兜底（off/auto → 不注入）
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
    let (thinking_obj, _) = assemble_thinking_dialect(&DialectBuildOptions {
        effort,
        format: ThinkingDialectFormat::AnthropicBudget,
        max_output_tokens: DEFAULT_ANTHROPIC_MAX_OUTPUT,
        thinking_map: opts.thinking_map.as_ref(),
    });
    // budget = dialect 产出的 budget_tokens（供 max_tokens 自动抬升；非 elevated）
    let budget = thinking_obj
        .as_ref()
        .and_then(|t| t.get("thinking"))
        .and_then(|t| t.get("budget_tokens"))
        .and_then(Value::as_u64);
    (thinking_obj, budget)
}

/// tool_choice：Anthropic 官方形状 `{type: "auto"|"any"|"tool", name?}`；
/// 自 chat 轨语义映射（auto/none/required/function）
fn anthropic_tool_choice(choice: &ToolChoice) -> Value {
    match choice {
        ToolChoice::Auto => json!({ "type": "auto" }),
        ToolChoice::None => json!({ "type": "none" }),
        ToolChoice::Required => json!({ "type": "any" }),
        ToolChoice::Function { name } => json!({ "type": "tool", "name": name }),
    }
}

/// AgentMessage → Anthropic messages 数组（独立映射；从块直接构建 content 块数组）
///
/// 角色映射：
/// - user → content 块数组 `[{type:"text",text}]`
/// - assistant → content 块数组：text/thinking/tool_use 块，且按顺序保留
/// - tool → user 消息携带 `tool_result` 块（Anthropic 官方 tool_result 属 user 角色，
///   与 chat 轨独立 `role:"tool"` 不同）
/// - system → 顶层 `system` 字段（本映射函数不产出独立 system 消息）
///
/// D03-02/INV-07 严格交替约束（Anthropic wire 铁律）：
/// Anthropic Messages API 要求 `messages` 中 user/assistant 严格交替，**连续
/// assistant 消息会触发 HTTP 400**。本函数在**序列化/投影层**保证交替性（不向核心
/// 领域模型注入合成消息，对齐 message.rs 既有 `WIRE_CONTINUATION_NOTE` 投影机制）：
/// - 前一条已产出 assistant，再遇 assistant → 插入一条 user 占位消息
///   `[System Note: The following is a continuation of previous output.]`
///   （复用 [super::messages::WIRE_CONTINUATION_NOTE]）。
/// - 首条为 assistant（无任何 user 前缀）→ 同样前置 user 占位，满足 Anthropic
///   官方「首条必须为 user 或 image」要求。
fn to_anthropic_messages(context: &RequestBuildContext) -> Vec<Value> {
    let mut result: Vec<Value> = Vec::new();
    for message_ref in context.messages {
        let message: &AgentMessage = message_ref.borrow();
        match message.role {
            AgentMessageRole::User => {
                let content = user_anthropic_content(message);
                if content.is_empty() {
                    continue;
                }
                push_alternating(&mut result, &json!({ "role": "user", "content": content }));
            }
            AgentMessageRole::Assistant => {
                let content = assistant_anthropic_content(message);
                if !content.is_empty() {
                    push_alternating(
                        &mut result,
                        &json!({ "role": "assistant", "content": content }),
                    );
                }
                // 历史水合兜底：若 assistant 消息同体携带 ToolResult 块（hydrate.rs）
                let tool_results = tool_result_anthropic_content(message);
                if !tool_results.is_empty() {
                    push_alternating(
                        &mut result,
                        &json!({ "role": "user", "content": tool_results }),
                    );
                }
            }
            AgentMessageRole::Tool => {
                let content = tool_result_anthropic_content(message);
                if content.is_empty() {
                    continue;
                }
                push_alternating(&mut result, &json!({ "role": "user", "content": content }));
            }
            // system 消息走顶层 system 字段；消息域 system 不影响 wire 交替序列
            // （anthropic.messages 无独立 system 角色消息）
            AgentMessageRole::System => {}
        }
    }
    result
}

/// 交替约束投影：向 result 追加一条 wire 消息，仅当该消息为 assistant 且会破坏
/// Anthropic 交替铁律时前置 user 占位——(a) 首条即 assistant（空首条须为 user）；
/// (b) 上一条已是 assistant。
/// 当连续两条均为 user 消息时（如工具响应后紧跟新用户提问），将其 content 数组合并，
/// 满足 Anthropic wire user/assistant 严格交替铁律。
fn push_alternating(result: &mut Vec<Value>, message: &Value) {
    let next_role = message["role"].as_str().unwrap_or_default();
    if next_role == "user" && result.last().is_some_and(|m| m["role"] == "user") {
        if let Some(last_msg) = result.last_mut() {
            if let (Some(last_arr), Some(next_arr)) = (
                last_msg.get_mut("content").and_then(|c| c.as_array_mut()),
                message.get("content").and_then(|c| c.as_array()),
            ) {
                last_arr.extend(next_arr.iter().cloned());
                return;
            }
        }
    }
    let needs_user_prefix = next_role == "assistant"
        && (result.is_empty() || result.last().is_some_and(|m| m["role"] == "assistant"));
    if needs_user_prefix {
        result.push(json!({ "role": "user", "content": WIRE_CONTINUATION_NOTE }));
    }
    result.push(message.clone());
}

/// user 消息 content 块数组（text / image 块；图像来自 metadata.contentParts——
/// plans/04 §4.2：视觉模型图进 Anthropic image source 块，禁止只发 `[图片附件]`
/// 文本备注）
fn user_anthropic_content(message: &AgentMessage) -> Vec<Value> {
    let content = user_message_content(message);
    match content {
        ChatContent::Text(text) => {
            if text.trim().is_empty() {
                Vec::new()
            } else {
                vec![json!({ "type": "text", "text": text })]
            }
        }
        ChatContent::Parts(parts) => parts.iter().filter_map(anthropic_user_part).collect(),
    }
}

/// ChatContentPart → Anthropic content 块（text → text；image_url → image source）
fn anthropic_user_part(part: &ChatContentPart) -> Option<Value> {
    match part {
        ChatContentPart::Text { text, .. } => {
            if text.trim().is_empty() {
                None
            } else {
                Some(json!({ "type": "text", "text": text }))
            }
        }
        ChatContentPart::ImageUrl { url, .. } => Some(anthropic_image_source(url)),
    }
}

/// image_url → Anthropic image source 块：data URL → base64 source；否则 url source
fn anthropic_image_source(url: &str) -> Value {
    if let Some((mime, data)) = split_data_url(url) {
        json!({
            "type": "image",
            "source": { "type": "base64", "media_type": mime, "data": data },
        })
    } else {
        json!({
            "type": "image",
            "source": { "type": "url", "url": url },
        })
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

/// tool 消息 → user content 的 `tool_result` 块（Anthropic 官方语义）
fn tool_result_anthropic_content(message: &AgentMessage) -> Vec<Value> {
    message
        .blocks
        .iter()
        .filter_map(|block| match block {
            AgentMessageBlock::ToolResult {
                tool_call_id,
                output,
                is_error,
                ..
            } => {
                // T-34（R-J）：与 chat 轨 tool 消息同口径清洗（确定性 + 幂等）
                let cleaned =
                    clean_output(&stringify_tool_output(output), &CleanupOptions::default());
                let mut tr = Map::new();
                tr.insert("type".to_string(), json!("tool_result"));
                tr.insert(
                    "tool_use_id".to_string(),
                    json!(sanitize_tool_call_id(tool_call_id)),
                );
                tr.insert(
                    "content".to_string(),
                    json!(if cleaned.cleaned.is_empty() {
                        "(no output)".to_string()
                    } else {
                        cleaned.cleaned
                    }),
                );
                if *is_error {
                    tr.insert("is_error".to_string(), json!(true));
                }
                Some(Value::Object(tr))
            }
            _ => None,
        })
        .collect()
}

/// assistant 消息 content 块数组：text / thinking / tool_use 块，按原块顺序保留
fn assistant_anthropic_content(message: &AgentMessage) -> Vec<Value> {
    message
        .blocks
        .iter()
        .filter_map(|block| match block {
            AgentMessageBlock::Text { text } => Some(json!({ "type": "text", "text": text })),
            AgentMessageBlock::Thought { text, .. } => {
                Some(json!({ "type": "thinking", "thinking": text }))
            }
            AgentMessageBlock::ToolCall(call) => {
                // tool_use 块：id/name/input（input 为结构化对象，直接透传）
                Some(json!({
                    "type": "tool_use",
                    "id": sanitize_tool_call_id(&call.id),
                    "name": call.tool_name,
                    "input": call.input,
                }))
            }
            AgentMessageBlock::ToolResult { .. } => None,
        })
        .collect()
}

#[cfg(test)]
#[path = "build_anthropic_tests.rs"]
mod tests;
