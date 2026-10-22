//! Anthropic 请求体组装与思考/工具方言绑定（自 build_anthropic.rs 平移）。

use super::messages::to_anthropic_messages;
use super::options::{
    default_anthropic_max_tokens, AnthropicRequestOptions, DEFAULT_ANTHROPIC_MAX_OUTPUT,
};
use super::pairing::fail_closed_anthropic_pairing_gate;
use crate::models::catalog_types::ThinkingFormat;
use crate::request::build::dialect::{
    self, assemble_thinking_dialect, DialectBuildOptions, ThinkingDialectFormat,
};
use crate::request::cache::allocate_breakpoints;
use crate::request::schema::canonicalize_schema;
use crate::request::tools::ToolChoice;
use crate::request::vendor::ReasoningEffort;
use crate::request::{RequestBuildContext, ThinkingIntensity};
use serde_json::{json, Map, Value};

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

    let default_tokens = default_anthropic_max_tokens(opts.model.as_deref(), budget);
    let final_max_tokens = match opts.max_tokens {
        Some(m) => {
            if let Some(b) = budget {
                m.max(b.saturating_add(4096))
            } else {
                m
            }
        }
        None => default_tokens,
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
    // tool_result 垫片。过滤带毒孤儿工具调用，安全 Fail-Closed。
    fail_closed_anthropic_pairing_gate(&mut messages);
    if bp_plan.messages {
        inject_last_message_cache_control(&mut messages);
    }
    body.insert("messages".to_string(), json!(messages));

    Value::Object(body)
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
    if opts.thinking_format != Some(ThinkingFormat::Anthropic) {
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
