//! request/build.rs chat 构建域测试旁挂（SR-06e · 拆分 · ≠ EL；经 #[path] 接线，非直接 mod）
//!
//! 原 build.rs `mod tests` 的 chat-completions 构建测试整段搬入（system prompt 规范化 /
//! 请求体形状 / compactObject / reasoning-thinking / 自适应思考 / wire-mode / endpoint
//! 兜底），零删除零合并；测试名与断言形状不变。公共构造复用 build_tests_common.rs。

use super::test_common::*;
use super::*;

use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use conex_types::tool::ToolOutput;
use serde_json::json;
use std::sync::Arc;

// ── system prompt 单点规范化（P1 B1）──

#[test]
fn build_system_prompt_trims_whitespace() {
    assert_eq!(
        build_system_prompt(Some("  你好，世界  \n\t".to_string())),
        Some("你好，世界".to_string())
    );
    assert_eq!(
        build_system_prompt(Some("  全局提示 \n ".to_string())),
        Some("全局提示".to_string())
    );
    // 内部空白保留（只做首尾 trim）
    assert_eq!(
        build_system_prompt(Some(" a  b ".to_string())),
        Some("a  b".to_string())
    );
}

#[test]
fn build_system_prompt_empty_or_whitespace_normalizes_to_none() {
    assert_eq!(build_system_prompt(Some(String::new())), None);
    assert_eq!(build_system_prompt(Some("   ".to_string())), None);
    assert_eq!(build_system_prompt(Some("\n\t  \n".to_string())), None);
}

#[test]
fn build_system_prompt_none_passes_through() {
    assert_eq!(build_system_prompt(None), None);
}

// ── 请求体构建与 compactObject ──

#[test]
fn body_shape_with_all_fields() {
    let opts = ChatCompletionsRequestOptions {
        model: Some("gpt-4o".to_string()),
        stream: Some(true),
        temperature: Some(0.7),
        top_p: Some(0.9),
        max_tokens: Some(2048),
        max_tokens_field: Some(MaxTokensField::MaxTokens),
        reasoning_effort: Some(ReasoningEffort::Low),
        ..ChatCompletionsRequestOptions::default()
    };
    let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_message("你好"))];
    let context = RequestBuildContext {
        system_prompt: Some("系统提示".to_string()),
        messages: &messages,
        tools: vec![tool("read_file")],
        wire_mode: SystemPromptWireMode::NativeSystemRole,
    };
    let body = build_chat_completions_request_body(&opts, &context);
    assert_eq!(body["model"], "gpt-4o");
    assert_eq!(body["stream"], true);
    assert_eq!(body["temperature"], 0.7);
    assert_eq!(body["top_p"], 0.9);
    assert_eq!(body["max_tokens"], 2048);
    assert_eq!(body["reasoning_effort"], "low");
    assert_eq!(body["messages"][0]["role"], "system");
    assert_eq!(body["messages"][1]["role"], "user");
    assert_eq!(body["messages"][1]["content"], "你好");
    assert_eq!(body["tools"][0]["function"]["name"], "read_file");
    assert_eq!(body["tool_choice"], "auto");
    assert_eq!(body["stream_options"], json!({ "include_usage": true }));
}

#[test]
fn compact_object_omits_none_fields() {
    let body = build_chat_completions_request_body(&base_opts(), &RequestBuildContext::default());
    for key in [
        "temperature",
        "top_p",
        "max_tokens",
        "reasoning_effort",
        "tools",
        "tool_choice",
        "stream",
    ] {
        assert!(
            body.get(key).is_none(),
            "None 字段 {key} 不应出现在请求体中：{body}"
        );
    }
    assert_eq!(body["model"], "gpt-4o");
    assert_eq!(body["messages"], json!([]));
    assert_eq!(body["stream_options"], json!({ "include_usage": true }));
}

#[test]
fn stream_false_omits_stream_options() {
    let opts = ChatCompletionsRequestOptions {
        stream: Some(false),
        ..base_opts()
    };
    let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
    assert_eq!(body["stream"], false);
    assert!(
        body.get("stream_options").is_none(),
        "非流式不带 include_usage"
    );
}

#[test]
fn max_tokens_field_name_is_respected() {
    for (field, wire_name) in [
        (MaxTokensField::MaxTokens, "max_tokens"),
        (MaxTokensField::MaxCompletionTokens, "max_completion_tokens"),
        (MaxTokensField::MaxOutputTokens, "max_output_tokens"),
    ] {
        let opts = ChatCompletionsRequestOptions {
            max_tokens: Some(100),
            max_tokens_field: Some(field),
            ..base_opts()
        };
        let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
        assert_eq!(body[wire_name], 100, "字段名 {wire_name}");
    }
}

#[test]
fn tools_absent_when_tool_list_empty() {
    let body = build_chat_completions_request_body(&base_opts(), &RequestBuildContext::default());
    assert!(body.get("tools").is_none());
    assert!(body.get("tool_choice").is_none());
}

#[test]
fn tool_choice_explicit_function() {
    let context = RequestBuildContext {
        tools: vec![tool("read_file")],
        ..RequestBuildContext::default()
    };
    let opts = ChatCompletionsRequestOptions {
        tool_choice: Some(ToolChoice::Function {
            name: "read_file".to_string(),
        }),
        ..base_opts()
    };
    let body = build_chat_completions_request_body(&opts, &context);
    assert_eq!(
        body["tool_choice"],
        json!({ "type": "function", "function": { "name": "read_file" } })
    );
}

// ── reasoning 字段与 thinking 透传 ──

#[test]
fn reasoning_effort_vendor_auto_injects_reasoning_effort() {
    let opts = ChatCompletionsRequestOptions {
        reasoning_effort: Some(ReasoningEffort::High),
        ..base_opts()
    };
    let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
    assert_eq!(body["reasoning_effort"], "high");
}

#[test]
fn thinking_intensity_overrides_legacy_reasoning_fields() {
    // 01 D5：thinkingIntensity 提供时清除 legacy 字段并注入 vendor 原生参数
    let opts = ChatCompletionsRequestOptions {
        reasoning_effort: Some(ReasoningEffort::High),
        thinking_intensity: Some(ThinkingIntensity::Medium),
        model: Some("deepseek-reasoner".to_string()),
        ..ChatCompletionsRequestOptions::default()
    };
    let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
    // legacy reasoning_effort=high 被 thinkingIntensity 清除后重新注入 medium
    assert_eq!(
        body["reasoning_effort"], "medium",
        "deepseek → reasoning_effort"
    );

    let opts = ChatCompletionsRequestOptions {
        thinking_intensity: Some(ThinkingIntensity::High),
        model: Some("claude-sonnet-4".to_string()),
        ..ChatCompletionsRequestOptions::default()
    };
    let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
    assert_eq!(
        body["thinking"],
        json!({ "type": "enabled", "budget_tokens": 4096 })
    );

    let opts = ChatCompletionsRequestOptions {
        thinking_intensity: Some(ThinkingIntensity::Xhigh),
        model: Some("gemini-2.5-flash".to_string()),
        ..ChatCompletionsRequestOptions::default()
    };
    let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
    assert_eq!(
        body["generation_config"],
        json!({ "thinking_level": "high" })
    );
}

#[test]
fn thinking_intensity_off_clears_reasoning_fields() {
    // off 语义：清除 legacy 字段且不注入任何思考参数（对齐 provider-openai-class 覆盖/清空）
    let opts = ChatCompletionsRequestOptions {
        reasoning_effort: Some(ReasoningEffort::High),
        thinking_intensity: Some(ThinkingIntensity::Off),
        model: Some("deepseek-reasoner".to_string()),
        ..ChatCompletionsRequestOptions::default()
    };
    let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
    assert!(body.get("reasoning_effort").is_none());
    assert!(body.get("thinking").is_none());
}

#[test]
fn thinking_intensity_unsupported_model_injects_nothing() {
    let opts = ChatCompletionsRequestOptions {
        thinking_intensity: Some(ThinkingIntensity::High),
        model: Some("gpt-4o".to_string()),
        ..ChatCompletionsRequestOptions::default()
    };
    let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
    assert!(body.get("reasoning_effort").is_none());
    assert!(body.get("thinking").is_none());
}

#[test]
fn vendor_anthropic_effort_injects_thinking_budget() {
    let opts = ChatCompletionsRequestOptions {
        reasoning_effort: Some(ReasoningEffort::High),
        vendor: Some(ReasoningVendor::Anthropic),
        ..base_opts()
    };
    let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
    assert_eq!(
        body["thinking"],
        json!({ "type": "enabled", "budget_tokens": 4096 })
    );
}

// ── G7：Anthropic 自适应思考（Opus 4.7+ / Sonnet 5+）──

#[test]
fn adaptive_anthropic_thinking_intensity_injects_adaptive_shape() {
    // G7：新代际 thinkingIntensity → thinking{type:adaptive,display:summarized} + effort
    let opts = ChatCompletionsRequestOptions {
        thinking_intensity: Some(ThinkingIntensity::High),
        model: Some("claude-opus-4-7".to_string()),
        ..ChatCompletionsRequestOptions::default()
    };
    let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
    assert_eq!(
        body["thinking"],
        json!({ "type": "adaptive", "display": "summarized" })
    );
    assert_eq!(body["effort"], "high");
    assert!(
        body["thinking"].get("budget_tokens").is_none(),
        "adaptive 形态不带 budget_tokens"
    );

    let opts = ChatCompletionsRequestOptions {
        thinking_intensity: Some(ThinkingIntensity::Max),
        model: Some("claude-sonnet-5".to_string()),
        ..ChatCompletionsRequestOptions::default()
    };
    let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
    assert_eq!(
        body["thinking"],
        json!({ "type": "adaptive", "display": "summarized" })
    );
    assert_eq!(body["effort"], "max");
}

#[test]
fn adaptive_anthropic_legacy_effort_injects_adaptive_shape() {
    // 新代际 + 显式 anthropic vendor：adaptive + display summarized + effort
    let opts = ChatCompletionsRequestOptions {
        reasoning_effort: Some(ReasoningEffort::Xhigh),
        vendor: Some(ReasoningVendor::Anthropic),
        model: Some("claude-opus-4-7".to_string()),
        ..ChatCompletionsRequestOptions::default()
    };
    let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
    assert_eq!(
        body["thinking"],
        json!({ "type": "adaptive", "display": "summarized" })
    );
    assert_eq!(body["effort"], "xhigh");
    assert!(
        body["thinking"].get("budget_tokens").is_none(),
        "adaptive 形态不带 budget_tokens"
    );

    // 旧代际行为不变：enabled+budget_tokens、无顶层 effort
    let opts = ChatCompletionsRequestOptions {
        reasoning_effort: Some(ReasoningEffort::High),
        vendor: Some(ReasoningVendor::Anthropic),
        model: Some("claude-opus-4-6".to_string()),
        ..ChatCompletionsRequestOptions::default()
    };
    let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
    assert_eq!(
        body["thinking"],
        json!({ "type": "enabled", "budget_tokens": 4096 })
    );
    assert!(body.get("effort").is_none(), "旧代际不注入顶层 effort");
}

#[test]
fn adaptive_legacy_effort_cleared_by_thinking_intensity() {
    // thinkingIntensity 覆盖时，legacy 注入的顶层 effort 必须被清除
    let opts = ChatCompletionsRequestOptions {
        reasoning_effort: Some(ReasoningEffort::Max),
        vendor: Some(ReasoningVendor::Anthropic),
        thinking_intensity: Some(ThinkingIntensity::Medium),
        model: Some("claude-opus-4-7".to_string()),
        ..ChatCompletionsRequestOptions::default()
    };
    let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
    assert_eq!(
        body["thinking"],
        json!({ "type": "adaptive", "display": "summarized" })
    );
    assert_eq!(
        body["effort"], "medium",
        "thinkingIntensity 覆盖后 effort 应为新档位"
    );
}

#[test]
fn wire_mode_user_prefix_is_honored() {
    let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_message("你好"))];
    let context = RequestBuildContext {
        system_prompt: Some("全局提示".to_string()),
        messages: &messages,
        tools: Vec::new(),
        wire_mode: SystemPromptWireMode::UserPrefix,
    };
    let body = build_chat_completions_request_body(&base_opts(), &context);
    assert_eq!(body["messages"][0]["role"], "user");
    assert_eq!(
        body["messages"][0]["content"],
        "System instructions for this run:\n\n全局提示"
    );
}

// ── endpoint 兜底（00 D3）──

#[test]
fn resolve_endpoint_defaults_to_chat_completions() {
    assert_eq!(resolve_endpoint(None), Endpoint::ChatCompletions);
    assert_eq!(
        resolve_endpoint(Some(Endpoint::Auto)),
        Endpoint::ChatCompletions
    );
    assert_eq!(
        resolve_endpoint(Some(Endpoint::ChatCompletions)),
        Endpoint::ChatCompletions
    );
    assert_eq!(
        resolve_endpoint(Some(Endpoint::Responses)),
        Endpoint::Responses
    );
}

#[test]
fn build_with_tool_result_message() {
    let tool_result = AgentMessage {
        id: "t1".to_string(),
        role: AgentMessageRole::Tool,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        blocks: vec![AgentMessageBlock::ToolResult {
            tool_call_id: "call_1".to_string(),
            tool_name: "read_file".to_string(),
            output: ToolOutput::text("文件内容"),
            is_error: false,
        }],
        metadata: None,
        client_message_id: None,
        content: None,
    };
    let messages: Vec<Arc<AgentMessage>> =
        vec![Arc::new(user_message("查一下")), Arc::new(tool_result)];
    let context = RequestBuildContext {
        messages: &messages,
        ..RequestBuildContext::default()
    };
    let body = build_chat_completions_request_body(&base_opts(), &context);
    let messages = body["messages"].as_array().expect("messages 数组");
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[1]["role"], "tool");
    assert_eq!(messages[1]["tool_call_id"], "call_1");
    assert_eq!(messages[1]["content"], "文件内容");
}
