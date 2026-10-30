//! request/build.rs chat 构建域测试旁挂（SR-06e · 拆分 · ≠ EL；经 #[path] 接线，非直接 mod）
//!
//! 原 build.rs `mod tests` 的 chat-completions 构建测试整段搬入（system prompt 规范化 /
//! 请求体形状 / compactObject / reasoning-thinking / 自适应思考 / wire-mode / endpoint
//! 兜底），零删除零合并；测试名与断言形状不变。公共构造复用 build_tests_common.rs。

use super::test_common::*;
use super::*;

use crate::models::catalog_types::ThinkingFormat;
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use conex_types::tool::ToolOutput;
use indexmap::IndexMap;
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
    let mut thinking_map = IndexMap::new();
    thinking_map.insert("Low".to_string(), "low".to_string());
    let opts = ChatCompletionsRequestOptions {
        model: Some("gpt-4o".to_string()),
        stream: Some(true),
        temperature: Some(0.7),
        top_p: Some(0.9),
        max_tokens: Some(2048),
        max_tokens_field: Some(MaxTokensField::MaxTokens),
        reasoning_effort: Some(ReasoningEffort::Low),
        thinking_format: Some(ThinkingFormat::OpenAi),
        thinking_map: Some(thinking_map),
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
    // plans/04 §7.1：显式 thinking_format + 字典 → 思考键只来自 dialect
    let mut thinking_map = IndexMap::new();
    thinking_map.insert("High".to_string(), "high".to_string());
    let opts = ChatCompletionsRequestOptions {
        reasoning_effort: Some(ReasoningEffort::High),
        thinking_format: Some(ThinkingFormat::OpenAi),
        thinking_map: Some(thinking_map),
        ..base_opts()
    };
    let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
    assert_eq!(body["reasoning_effort"], "high");
}

#[test]
fn thinking_format_driven_shapes_per_format() {
    // 显式 format 驱动：deepseek → thinking{type:enabled}（map 字面 enabled/disabled
    // 优先生效）；anthropic → budget；gemini → thinkingConfig（Map 值为准，禁止折叠）。
    // 无 format → 不注入。
    let mut deepseek_map = IndexMap::new();
    deepseek_map.insert("High".to_string(), "disabled".to_string());
    let opts = ChatCompletionsRequestOptions {
        reasoning_effort: Some(ReasoningEffort::High),
        model: Some("deepseek-reasoner".to_string()),
        thinking_format: Some(ThinkingFormat::DeepSeek),
        thinking_map: Some(deepseek_map),
        ..ChatCompletionsRequestOptions::default()
    };
    let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
    assert_eq!(
        body["thinking"],
        json!({ "type": "disabled" }),
        "map 字面 disabled 优先生效（非 Off 也按字典）"
    );

    let mut anthropic_map = IndexMap::new();
    anthropic_map.insert("High".to_string(), "16384".to_string());
    let opts = ChatCompletionsRequestOptions {
        reasoning_effort: Some(ReasoningEffort::High),
        model: Some("claude-sonnet-4".to_string()),
        thinking_format: Some(ThinkingFormat::Anthropic),
        thinking_map: Some(anthropic_map),
        ..ChatCompletionsRequestOptions::default()
    };
    let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
    assert_eq!(
        body["thinking"],
        json!({ "type": "enabled", "budget_tokens": 16384 })
    );

    let mut gemini_map = IndexMap::new();
    gemini_map.insert("High".to_string(), "HIGH".to_string());
    let opts = ChatCompletionsRequestOptions {
        reasoning_effort: Some(ReasoningEffort::High),
        model: Some("gemini-2.5-flash".to_string()),
        thinking_format: Some(ThinkingFormat::Gemini),
        thinking_map: Some(gemini_map),
        ..ChatCompletionsRequestOptions::default()
    };
    let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
    assert_eq!(
        body["generationConfig"],
        json!({ "thinkingConfig": { "thinkingLevel": "HIGH" } })
    );

    // 无 format → 不写任何思考键（fail-closed）
    let opts = ChatCompletionsRequestOptions {
        reasoning_effort: Some(ReasoningEffort::High),
        model: Some("unknown-model".to_string()),
        ..ChatCompletionsRequestOptions::default()
    };
    let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
    for key in ["reasoning_effort", "thinking", "generationConfig"] {
        assert!(body.get(key).is_none(), "{key} 不应出现：{body}");
    }
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
    // plans/04 §2.2：Anthropic 预算只来自字典数字（≥1024），禁止魔法刻度
    let mut thinking_map = IndexMap::new();
    thinking_map.insert("High".to_string(), "16384".to_string());
    let opts = ChatCompletionsRequestOptions {
        reasoning_effort: Some(ReasoningEffort::High),
        vendor: Some(ReasoningVendor::Anthropic),
        thinking_format: Some(ThinkingFormat::Anthropic),
        thinking_map: Some(thinking_map),
        ..base_opts()
    };
    let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
    assert_eq!(
        body["thinking"],
        json!({ "type": "enabled", "budget_tokens": 16384 })
    );
}

// ── G7 收敛：自适应思考经字典值表达（plans/04 §2.2：`High: "adaptive"`）──

#[test]
fn adaptive_anthropic_thinking_intensity_injects_adaptive_shape() {
    // 字典值 "adaptive" → thinking{type:"adaptive"}（不折 budget 表）
    let mut thinking_map = IndexMap::new();
    thinking_map.insert("High".to_string(), "adaptive".to_string());
    let opts = ChatCompletionsRequestOptions {
        thinking_intensity: Some(ThinkingIntensity::High),
        model: Some("claude-opus-4-7".to_string()),
        thinking_format: Some(ThinkingFormat::Anthropic),
        thinking_map: Some(thinking_map),
        ..ChatCompletionsRequestOptions::default()
    };
    let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
    assert_eq!(body["thinking"], json!({ "type": "adaptive" }));
    assert!(
        body["thinking"].get("budget_tokens").is_none(),
        "adaptive 形态不带 budget_tokens"
    );
}

#[test]
fn adaptive_anthropic_legacy_effort_injects_adaptive_shape() {
    // 字典值 adaptive（Max 档）→ {type:"adaptive"}
    let mut thinking_map = IndexMap::new();
    thinking_map.insert("Max".to_string(), "adaptive".to_string());
    let opts = ChatCompletionsRequestOptions {
        reasoning_effort: Some(ReasoningEffort::Max),
        vendor: Some(ReasoningVendor::Anthropic),
        model: Some("claude-opus-4-7".to_string()),
        thinking_format: Some(ThinkingFormat::Anthropic),
        thinking_map: Some(thinking_map),
        ..ChatCompletionsRequestOptions::default()
    };
    let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
    assert_eq!(body["thinking"], json!({ "type": "adaptive" }));

    // 字典数字 → enabled + budget_tokens（同一 builder，值决定形态）
    let mut thinking_map = IndexMap::new();
    thinking_map.insert("High".to_string(), "16384".to_string());
    let opts = ChatCompletionsRequestOptions {
        reasoning_effort: Some(ReasoningEffort::High),
        vendor: Some(ReasoningVendor::Anthropic),
        model: Some("claude-opus-4-6".to_string()),
        thinking_format: Some(ThinkingFormat::Anthropic),
        thinking_map: Some(thinking_map),
        ..ChatCompletionsRequestOptions::default()
    };
    let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
    assert_eq!(
        body["thinking"],
        json!({ "type": "enabled", "budget_tokens": 16384 })
    );
}

#[test]
fn adaptive_legacy_effort_cleared_by_thinking_intensity() {
    // thinkingIntensity 覆盖：intensity 优先生效（legacy effort 不再注入）
    let mut thinking_map = IndexMap::new();
    thinking_map.insert("Medium".to_string(), "adaptive".to_string());
    let opts = ChatCompletionsRequestOptions {
        reasoning_effort: Some(ReasoningEffort::Max),
        vendor: Some(ReasoningVendor::Anthropic),
        thinking_intensity: Some(ThinkingIntensity::Medium),
        model: Some("claude-opus-4-7".to_string()),
        thinking_format: Some(ThinkingFormat::Anthropic),
        thinking_map: Some(thinking_map),
        ..ChatCompletionsRequestOptions::default()
    };
    let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
    assert_eq!(
        body["thinking"],
        json!({ "type": "adaptive" }),
        "intensity=Medium → 字典 Medium 值 adaptive"
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

// ── 轨G P2：max_tokens 缺省不硬抬升 64000 ──

#[test]
fn max_tokens_none_omits_field_and_budget_not_clamped_to_64000() {
    // 无 max_tokens + AnthropicBudget 大预算：请求体省略 max_tokens 字段，
    // budget 不被发明的 64000 上限钳到 59904。
    let mut thinking_map = IndexMap::new();
    thinking_map.insert("High".to_string(), "32000".to_string());
    let opts = ChatCompletionsRequestOptions {
        model: Some("claude-sonnet-4-5".to_string()),
        reasoning_effort: Some(ReasoningEffort::High),
        thinking_format: Some(ThinkingFormat::Anthropic),
        thinking_map: Some(thinking_map),
        // max_tokens / max_tokens_field 均缺省
        ..ChatCompletionsRequestOptions::default()
    };
    let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
    assert!(
        body.get("max_tokens").is_none() && body.get("max_completion_tokens").is_none(),
        "无 max_tokens 时不得发明 64000 写入请求体：{body}"
    );
    let budget = body["thinking"]["budget_tokens"]
        .as_u64()
        .expect("thinking.budget_tokens");
    assert_eq!(
        budget, 32000,
        "无已知上限时 budget 应保底取用户字典值，不得按 64000-4096 钳制"
    );
}

#[test]
fn max_tokens_some_still_clamps_budget_with_known_cap() {
    // 有显式 max_tokens：预算仍按物理上限安全余量钳制（防回归）
    let mut thinking_map = IndexMap::new();
    thinking_map.insert("High".to_string(), "32000".to_string());
    let opts = ChatCompletionsRequestOptions {
        model: Some("claude-sonnet-4-5".to_string()),
        reasoning_effort: Some(ReasoningEffort::High),
        thinking_format: Some(ThinkingFormat::Anthropic),
        thinking_map: Some(thinking_map),
        max_tokens: Some(8192),
        max_tokens_field: Some(MaxTokensField::MaxTokens),
        ..ChatCompletionsRequestOptions::default()
    };
    let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
    let budget = body["thinking"]["budget_tokens"].as_u64().unwrap();
    assert_eq!(budget, 4096, "预算受 8192-4096 钳制");
    assert!(
        body["max_tokens"].as_u64().unwrap() >= budget + 4096,
        "max_tokens 须抬升至 budget+4096"
    );
}

// ── 轨G P2：ReasoningEffortFormat 字段已删，永不进请求体 ──

#[test]
fn reasoning_effort_format_field_removed_never_enters_body() {
    // ChatCompletionsRequestOptions 已无 reasoning_effort_format 字段；
    // 无论 thinking 配置如何，请求体不得出现该键（编译期字段删除 + wire 钉死）。
    let mut thinking_map = IndexMap::new();
    thinking_map.insert("Medium".to_string(), "medium".to_string());
    let opts = ChatCompletionsRequestOptions {
        model: Some("gpt-5.6-sol".to_string()),
        reasoning_effort: Some(ReasoningEffort::Medium),
        thinking_format: Some(ThinkingFormat::OpenAi),
        thinking_map: Some(thinking_map),
        ..ChatCompletionsRequestOptions::default()
    };
    let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
    assert_eq!(body["reasoning_effort"], "medium");
    for banned in [
        "reasoning_effort_format",
        "reasoningEffortFormat",
        "effort_format",
    ] {
        assert!(
            body.get(banned).is_none(),
            "请求体不得含遗留 reasoning_effort_format 键 {banned}"
        );
    }
}
