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
use super::messages::{sanitize_tool_call_id, stringify_tool_output, WIRE_CONTINUATION_NOTE};
use super::schema::canonicalize_schema;
use super::tools::ToolChoice;
use super::vendor::{effort_to_budget_tokens, thinking_to_budget_tokens, ReasoningEffort};
use super::{RequestBuildContext, ThinkingIntensity};

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
    pub tool_choice: Option<ToolChoice>,
}

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
    let bp_plan = allocate_breakpoints(context.tools.len(), has_system, false);

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
    let thinking_obj = anthropic_thinking_object(opts);
    if let Some(thinking) = thinking_obj {
        body.insert("thinking".to_string(), thinking);
    }

    let budget = if let Some(explicit_budget) = opts.thinking_budget {
        if explicit_budget > 0 {
            Some(explicit_budget)
        } else {
            None
        }
    } else if let Some(intensity) = opts.thinking_intensity {
        if intensity != ThinkingIntensity::Off {
            Some(thinking_to_budget_tokens(intensity))
        } else {
            None
        }
    } else if let Some(effort) = opts.reasoning_effort {
        if !matches!(effort, ReasoningEffort::Off | ReasoningEffort::Auto) {
            Some(effort_to_budget_tokens(effort))
        } else {
            None
        }
    } else {
        None
    };

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
    body.insert("max_tokens".to_string(), json!(final_max_tokens));

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
                        map.insert(
                            "cache_control".to_string(),
                            json!({ "type": "ephemeral" }),
                        );
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
    body.insert(
        "messages".to_string(),
        json!(to_anthropic_messages(context)),
    );

    Value::Object(body)
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

/// system prompt 稳定构造（字符串形态；trim + 空值归一）
fn build_system_prompt_string(system_prompt: Option<&str>) -> Option<String> {
    system_prompt
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// thinking 参数（对齐 pi-ai buildParams 的 budget-based 形态）；
/// 优先使用显式 thinking_budget，次选 intensity / effort 换算；
/// effort/intensity 均为 None 或 off → None（不注入 `thinking` 键）
fn anthropic_thinking_object(opts: &AnthropicRequestOptions) -> Option<Value> {
    let budget = if let Some(explicit_budget) = opts.thinking_budget {
        if explicit_budget == 0 {
            return None;
        }
        explicit_budget
    } else if let Some(intensity) = opts.thinking_intensity {
        if intensity == ThinkingIntensity::Off {
            return None;
        }
        thinking_to_budget_tokens(intensity)
    } else if let Some(effort) = opts.reasoning_effort {
        if matches!(effort, ReasoningEffort::Off | ReasoningEffort::Auto) {
            return None;
        }
        effort_to_budget_tokens(effort)
    } else {
        return None;
    };
    Some(json!({
        "type": "enabled",
        "budget_tokens": budget,
    }))
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
                if content.is_empty() {
                    continue;
                }
                push_alternating(
                    &mut result,
                    &json!({ "role": "assistant", "content": content }),
                );
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
/// (b) 上一条已是 assistant。user 消息（含 tool_result 的 user 角色）天然满足
/// 交替，不触发占位。
fn push_alternating(result: &mut Vec<Value>, message: &Value) {
    let next_role = message["role"].as_str().unwrap_or_default();
    let needs_user_prefix = next_role == "assistant"
        && (result.is_empty() || result.last().is_some_and(|m| m["role"] == "assistant"));
    if needs_user_prefix {
        result.push(json!({ "role": "user", "content": WIRE_CONTINUATION_NOTE }));
    }
    result.push(message.clone());
}

/// user 消息 content 块数组（text 块；带 thinking 时不适用）
fn user_anthropic_content(message: &AgentMessage) -> Vec<Value> {
    message
        .blocks
        .iter()
        .filter_map(|block| match block {
            AgentMessageBlock::Text { text } => Some(json!({ "type": "text", "text": text })),
            _ => None,
        })
        .collect()
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
