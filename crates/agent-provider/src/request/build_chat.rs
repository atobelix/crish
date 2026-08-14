//! chat-completions 请求体构建域（SR-06e · 拆分 · ≠ EL）
//!
//! 从 request/build.rs 拆出的实现域（门面 build.rs re-export 全部公开符号，对外路径不变）：
//! - chat-completions 请求体构建（[super::build_chat_completions_request_body]：
//!   compactObject 等价、reasoning/thinking 注入、P2 缓存顶层字段与断点施加）
//! - 字段合并辅助（[super::merge_object] 私有）

use serde_json::{json, Map, Value};

use crate::config::Endpoint;

use super::{ChatCompletionsRequestOptions, RequestBuildContext};
use crate::request::cache::{
    allocate_breakpoints, apply_cache_controls, retention_wire_value, BreakpointPlan,
    CacheMechanism,
};
use crate::request::messages::{to_chat_messages, ChatMessage, ReasoningContentMode};
use crate::request::tools::{to_cache_aware_tool, to_chat_tool_choice, ToolChoice};
use crate::request::vendor::{
    infer_thinking_capability, reasoning_effort_object, resolve_thinking_params,
};

/// 构建 chat-completions 请求体（compactObject 等价：None 字段一律省略，02 §二.6:132）
pub fn build_chat_completions_request_body(
    opts: &ChatCompletionsRequestOptions,
    context: &RequestBuildContext,
) -> Value {
    let mut body = Map::new();

    if let Some(model) = &opts.model {
        body.insert("model".to_string(), json!(model));
    }
    if let Some(stream) = opts.stream {
        body.insert("stream".to_string(), json!(stream));
    }
    if let Some(temperature) = opts.temperature {
        body.insert("temperature".to_string(), json!(temperature));
    }
    if let Some(top_p) = opts.top_p {
        body.insert("top_p".to_string(), json!(top_p));
    }
    if let (Some(field), Some(value)) = (opts.max_tokens_field, opts.max_tokens) {
        body.insert(field.as_str().to_string(), json!(value));
    }

    // reasoning 字段（vendor 分支；02 §五 #2）
    if let Some(reasoning) = reasoning_effort_object(
        Endpoint::ChatCompletions,
        opts.model.as_deref().unwrap_or(""),
        opts.reasoning_effort,
        opts.reasoning_effort_format,
        opts.vendor,
    ) {
        merge_object(&mut body, &reasoning);
    }

    // 01 D5：per-request thinkingIntensity 优先注入，清除 legacy reasoning 字段
    // （对齐 `model:provider-openai-class.ts:551-585`：统一模块注入/覆盖/清空，
    // 消除 budgetDifficulty 语义混淆；"effort" 为 G7 自适应思考的顶层档位字段，
    // 一并清除防止 legacy 注入残留）
    if let Some(intensity) = opts.thinking_intensity {
        let capability = infer_thinking_capability(opts.model.as_deref().unwrap_or(""));
        let params = resolve_thinking_params(&capability, intensity, Endpoint::ChatCompletions);
        for key in [
            "reasoning_effort",
            "reasoning",
            "thinking",
            "generation_config",
            "effort",
        ] {
            body.remove(key);
        }
        merge_object(&mut body, &params);
    }

    // ── P2 步骤 3（T-15）：缓存顶层字段注入（compactObject：None 一律省略）──
    // 三字段：prompt_cache_key（会话亲和键，OpenAI 系）/ prompt_cache_retention
    // （OpenAI 官方值域 in_memory/24h，仅 Key 机制发 wire——Auto 机制 retention
    // 恒 Short 为内部档位，P2 §3.4 矩阵 Auto 行不发）/ prompt_cache_options
    // （GPT-5.6+ none 档显式化 {"mode":"explicit"}）；DeepSeek 等由
    // build_cache_policy 归 None，整个 cache 参数组不出现。
    // G2 注记：policy.affinity_header（x-grok-conv-id 会话亲和头）属 HTTP 头，
    // 不进请求体——由发送层经 [affinity_http_headers] 合并进基础请求头
    // （基础头 + 亲和头合并，P2 §3.3 注记；Grok 粘性路由，vendor-cache-mechanisms.md:121）
    if let Some(policy) = &opts.cache {
        if let Some(key) = &policy.cache_key {
            body.insert("prompt_cache_key".to_string(), json!(&key.0));
        }
        if policy.mechanism == CacheMechanism::Key {
            if let Some(retention) = retention_wire_value(policy.retention) {
                body.insert("prompt_cache_retention".to_string(), json!(retention));
            }
        }
        if let Some(options) = &policy.prompt_cache_options {
            body.insert(
                "prompt_cache_options".to_string(),
                json!({ "mode": options.mode.as_str() }),
            );
        }
    }

    // messages：先映射既有 wire 消息（to_chat_messages 保持纯函数），
    // 再 post-pass 施加断点（P2 §3.1.3：纯后处理，与映射解耦；plan 全 false
    // → 请求字节与未施加时完全一致）
    let mut wire = to_chat_messages(
        context.system_prompt.as_deref(),
        context.messages,
        opts.reasoning_content.unwrap_or(ReasoningContentMode::Omit),
        context.wire_mode,
    );
    // Explicit 机制断点：policy.breakpoints 为 Some（机制启用位，cache.rs
    // T-13b 产出）时，按请求形态（tools 数 / system / messages 锚点存在性）
    // 经 allocate_breakpoints 落地具体锚点（P2 §3.1.2：层级 tools→system→
    // messages，超限丢尾不报错）；锚点存在性判定与 apply_cache_controls 内部
    // 查找逻辑保持一致（system 回退首条 user / messages 回退最后 user/tool）
    let mut breakpoint_plan = BreakpointPlan::default();
    if let Some(policy) = &opts.cache {
        if policy.breakpoints.is_some() {
            breakpoint_plan = allocate_breakpoints(
                context.tools.len(),
                wire.iter().any(|m| m.role == "system" || m.role == "user"),
                wire.iter().any(|m| m.role == "user" || m.role == "tool"),
            );
            // chat-completions 兼容端点走 part 级断点（supports_message_cache_control
            // = false；消息级断点是 Anthropic 原生端点"顶层自动模式"载体，本线路不用）
            apply_cache_controls(&mut wire, &breakpoint_plan, policy.ttl, false);
        }
    }
    body.insert(
        "messages".to_string(),
        json!(wire.iter().map(ChatMessage::to_value).collect::<Vec<_>>()),
    );

    if !context.tools.is_empty() {
        // tools 级断点：plan.tools 为真时在**最后一个工具**附加 cache_control
        // （tools 层级锚点；to_cache_aware_tool 经 cache_control_for_ttl 映射，
        // 与消息级共用 TTL 桶 → 断点值转换，避免双实现漂移）
        let last_ttl = if breakpoint_plan.tools {
            opts.cache.as_ref().map(|policy| policy.ttl)
        } else {
            None
        };
        body.insert(
            "tools".to_string(),
            json!(context
                .tools
                .iter()
                .enumerate()
                .map(|(index, tool)| {
                    to_cache_aware_tool(
                        tool,
                        if index + 1 == context.tools.len() {
                            last_ttl
                        } else {
                            None
                        },
                    )
                })
                .collect::<Vec<_>>()),
        );
        body.insert(
            "tool_choice".to_string(),
            to_chat_tool_choice(opts.tool_choice.as_ref().unwrap_or(&ToolChoice::Auto)),
        );
    }

    // stream 非 false 时必带 include_usage（02 §二.6:132；`model:provider-openai-chat.ts:77`）
    if opts.stream != Some(false) {
        body.insert(
            "stream_options".to_string(),
            json!({ "include_usage": true }),
        );
    }

    Value::Object(body)
}

/// 把对象字段并入请求体（空对象不产生任何字段）
fn merge_object(body: &mut Map<String, Value>, extra: &Value) {
    if let Some(obj) = extra.as_object() {
        for (key, value) in obj {
            body.insert(key.clone(), value.clone());
        }
    }
}
