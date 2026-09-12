//! chat-completions 请求体构建域（SR-06e · 拆分 · ≠ EL）
//!
//! 从 request/build.rs 拆出的实现域（门面 build.rs re-export 全部公开符号，对外路径不变）：
//! - chat-completions 请求体构建（[super::build_chat_completions_request_body]：
//!   compactObject 等价、reasoning/thinking 注入、P2 缓存顶层字段与断点施加）
//! - 字段合并辅助（[super::merge_object] 私有）

use serde_json::{json, Map, Value};

use super::dialect::{self, assemble_thinking_dialect, DialectBuildOptions, ThinkingDialectFormat};
use super::{ChatCompletionsRequestOptions, ReasoningEffort, RequestBuildContext};
use crate::request::cache::{
    allocate_breakpoints, apply_cache_controls, retention_wire_value, BreakpointPlan,
    CacheMechanism,
};
use crate::request::messages::{
    to_chat_messages_with_compat, validate_chat_tool_pairing, ChatMessage, ReasoningContentMode,
    WireCompat,
};
use crate::request::tools::{to_cache_aware_tool, to_chat_tool_choice, ToolChoice};

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

    // ── 思考推理参数组装：唯一入口 assemble_thinking_dialect（plans/04 §7.1）──
    // 显式 thinking_format 才组装；无 format → 不写任何思考键（fail-closed；
    // 非法档位由 host 侧 validate_reasoning_effort 在 HTTP 前拒绝）。已删除
    // 原 84-150 兜底枝（infer_thinking_capability / reasoning_effort_object /
    // resolve_thinking_params），产品默认永远不进兜底。
    let effective_effort: Option<dialect::ReasoningEffort> =
        if let Some(intensity) = opts.thinking_intensity {
            Some(intensity.into())
        } else if let Some(effort) = opts.reasoning_effort {
            match effort {
                ReasoningEffort::Off => Some(dialect::ReasoningEffort::Off),
                ReasoningEffort::Auto => None,
                other => Some(other.into()),
            }
        } else {
            None
        };

    if let Some(effort) = effective_effort {
        if let Some(format) = opts.thinking_format.map(ThinkingDialectFormat::from) {
            let dialect_opts = DialectBuildOptions {
                effort,
                format,
                // 0 = 无已知上限：dialect 不发明 64000 兜底（轨G P2）。
                // 仅当 opts.max_tokens 已为 Some 时才写请求体 max_tokens 字段
                // （见下方 elevated 分支）；None 时请求体省略该字段，跟随协议缺省。
                max_output_tokens: opts.max_tokens.unwrap_or(0),
                thinking_map: opts.thinking_map.as_ref(),
            };
            let (thinking_val, elevated_tokens) = assemble_thinking_dialect(&dialect_opts);
            if let Some(val) = thinking_val {
                merge_object(&mut body, &val);
            }
            if let Some(elevated) = elevated_tokens {
                if let (Some(field), Some(cur_max)) = (opts.max_tokens_field, opts.max_tokens) {
                    body.insert(field.as_str().to_string(), json!(cur_max.max(elevated)));
                }
            }
        }
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

    // messages：先映射既有 wire 消息（with_compat 生产入口——带真 WireCompat，
    // 不再灌 `WireCompat::default()`；plans/04 §3.3），再 post-pass 施加断点
    // （P2 §3.1.3：纯后处理，与映射解耦；plan 全 false → 请求字节与未施加时完全一致）
    let reasoning_mode = opts.reasoning_content.unwrap_or(ReasoningContentMode::Omit);
    let wire_compat = WireCompat::from_compat(
        opts.vendor.map(|v| v.as_str()),
        opts.model.as_deref(),
        None, // 不再传 base_url 给启发式（plans/04 §3.3）
        opts.supports_reasoning,
        opts.compat.as_ref(),
    );
    let mut wire = to_chat_messages_with_compat(
        context.system_prompt.as_deref(),
        context.messages,
        reasoning_mode,
        context.wire_mode,
        wire_compat,
    );

    // W04 · 出站成对性 Fail-Closed 守门（详案 02 §3.4 轨二）：在 wire 消息
    // 映射完成后刚性拦截孤儿 tool_calls——严禁静默伪造 tool 结果垫片。
    // Debug/CI panic（Fail-Fast 暴露内核断裂）；Release tracing::error! 后
    // 拒绝组包（绝不产出带毒请求体）。会话循环侧应优先调用
    // [validate_chat_tool_pairing] 走「补齐后单次重试」闭环。
    if let Err(err) = validate_chat_tool_pairing(&wire) {
        tracing::error!(
            target: "agent_provider::wire_pairing",
            protocol = "openai_chat",
            error = %err,
            orphan_ids = ?err.orphan_ids(),
            "build_chat 入口守门拦截：拒绝构造带毒请求体"
        );
        panic!("OpenAI 导线层入口守门拦截到孤儿工具调用（带毒请求体禁止出站）：{err:?}");
    }

    // 出站清洗保障（代理兼容模式 / Omit 模式）：
    // 彻底清除历史 assistant 消息中的 reasoning_content，杜绝第三方代理因未定义字段报 400
    if reasoning_mode == ReasoningContentMode::Omit {
        for msg in &mut wire {
            msg.reasoning_content = None;
        }
    }
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

#[cfg(test)]
mod dialect_wiring_tests {
    use super::*;
    use crate::models::catalog_types::ThinkingFormat;
    use indexmap::IndexMap;

    #[test]
    fn test_anti_dead_feature_flattened_thinking_map_driven() {
        // 断言 2（Anti-Dead-Feature Gate）：当传入 thinking 拍平字典映射时，生成的 JSON 请求体中 reasoning_effort 必须严格由字典驱动
        let mut map = IndexMap::new();
        map.insert("Low".to_string(), "custom-low-wire".to_string());
        map.insert("High".to_string(), "custom-high-wire".to_string());

        let opts = ChatCompletionsRequestOptions {
            model: Some("custom-model".to_string()),
            reasoning_effort: Some(ReasoningEffort::High),
            thinking_format: Some(ThinkingFormat::OpenAi),
            thinking_map: Some(map),
            ..ChatCompletionsRequestOptions::default()
        };
        let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
        assert_eq!(body["reasoning_effort"], "custom-high-wire");
    }

    #[test]
    fn test_unknown_model_zero_degradation_deepseek_native() {
        // 断言 3（未知模型零降级零崩溃断言）：虚构模型名称 + thinkingFormat: "deepseek"
        let opts = ChatCompletionsRequestOptions {
            model: Some("custom-proxy/unicorn-reasoner".to_string()),
            reasoning_effort: Some(ReasoningEffort::High),
            thinking_format: Some(ThinkingFormat::DeepSeek),
            ..ChatCompletionsRequestOptions::default()
        };
        let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
        assert_eq!(body["thinking"], json!({ "type": "enabled" }));
        assert!(body.get("reasoning_effort").is_none());
    }

    #[test]
    fn test_unknown_model_deepseek_native_disabled_when_off() {
        let opts = ChatCompletionsRequestOptions {
            model: Some("custom-proxy/unicorn-reasoner".to_string()),
            reasoning_effort: Some(ReasoningEffort::Off),
            thinking_format: Some(ThinkingFormat::DeepSeek),
            ..ChatCompletionsRequestOptions::default()
        };
        let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
        assert_eq!(body["thinking"], json!({ "type": "disabled" }));
    }

    #[test]
    fn test_unknown_model_qwen_bailian_boolean() {
        let opts_on = ChatCompletionsRequestOptions {
            model: Some("my-gateway/qwen-omni".to_string()),
            reasoning_effort: Some(ReasoningEffort::Medium),
            thinking_format: Some(ThinkingFormat::Qwen),
            ..ChatCompletionsRequestOptions::default()
        };
        let body_on =
            build_chat_completions_request_body(&opts_on, &RequestBuildContext::default());
        assert_eq!(body_on["enable_thinking"], true);

        let opts_off = ChatCompletionsRequestOptions {
            model: Some("my-gateway/qwen-omni".to_string()),
            reasoning_effort: Some(ReasoningEffort::Off),
            thinking_format: Some(ThinkingFormat::Qwen),
            ..ChatCompletionsRequestOptions::default()
        };
        let body_off =
            build_chat_completions_request_body(&opts_off, &RequestBuildContext::default());
        assert_eq!(body_off["enable_thinking"], false);
    }
}
