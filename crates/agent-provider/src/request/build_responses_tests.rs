//! request/build.rs Responses 构建域测试旁挂（SR-06e · 拆分 · ≠ EL；经 #[path] 接线，
//! 非直接 mod）
//!
//! 原 build.rs `mod tests` 的 Responses 轨测试整段搬入（input/instructions/
//! max_output_tokens 形状 / 工具循环 items / user-prefix / 缓存与 chat 专有字段不注入），
//! 零删除零合并；测试名与断言形状不变。公共构造复用 build_tests_common.rs。

use super::*;
use super::test_common::*;

use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use conex_types::tool::ToolOutput;
use crate::request::cache::{CacheMechanism, CacheRetention, TtlBucket};
use serde_json::json;
use std::sync::Arc;

// ── Responses 轨请求体（DEEPCHECK-05 #10：input/instructions/max_output_tokens）──

#[test]
fn responses_body_shape_with_all_fields() {
    let opts = ChatCompletionsRequestOptions {
        model: Some("deepseek-v4-flash".to_string()),
        stream: Some(true),
        temperature: Some(0.7),
        top_p: Some(0.9),
        max_tokens: Some(2048),
        max_tokens_field: Some(MaxTokensField::MaxTokens),
        ..ChatCompletionsRequestOptions::default()
    };
    let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_message("你好"))];
    let context = RequestBuildContext {
        system_prompt: Some("系统提示".to_string()),
        messages: &messages,
        tools: vec![tool("read_file")],
        wire_mode: SystemPromptWireMode::NativeSystemRole,
    };
    let body = build_responses_request_body(&opts, &context);
    assert_eq!(body["model"], "deepseek-v4-flash");
    assert_eq!(body["stream"], true);
    assert_eq!(body["temperature"], 0.7);
    assert_eq!(body["top_p"], 0.9);
    // system prompt → 顶层 instructions（Responses 原生首 system）
    assert_eq!(body["instructions"], "系统提示");
    // input items：user 消息（无 system item——instructions 已承载）
    assert_eq!(
        body["input"][0],
        json!({ "type": "message", "role": "user", "content": "你好" })
    );
    assert_eq!(body["input"].as_array().expect("input 数组").len(), 1);
    // max_output_tokens（Responses 原生字段名，忽略 chat 侧 max_tokens_field）
    assert_eq!(body["max_output_tokens"], 2048);
    assert!(
        body.get("max_tokens").is_none(),
        "Responses 轨不得出现 max_tokens"
    );
    // tools / tool_choice → Responses 原生形状（strict:false）
    assert_eq!(
        body["tools"][0],
        json!({
            "type": "function",
            "name": "read_file",
            "description": "工具 read_file",
            "parameters": { "type": "object" },
            "strict": false,
        })
    );
    assert_eq!(body["tool_choice"], "auto");
    // 不出现 chat 专有键（messages / stream_options / 缓存字段）
    for key in [
        "messages",
        "stream_options",
        "prompt_cache_key",
        "prompt_cache_retention",
        "prompt_cache_options",
    ] {
        assert!(body.get(key).is_none(), "Responses 轨不得注入 {key}");
    }
}

#[test]
fn responses_body_tool_loop_items() {
    // 工具循环：assistant（文本 + 工具调用）→ tool 结果 → function_call 与
    // function_call_output items（DeepSeek Responses 官方矩阵形状）
    let assistant = AgentMessage {
        id: "a1".to_string(),
        role: AgentMessageRole::Assistant,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        blocks: vec![
            text_block("我来查"),
            AgentMessageBlock::ToolCall(conex_types::message::ToolCallBlock {
                id: "call_1".to_string(),
                tool_name: "read_file".to_string(),
                input: json!({ "path": "/a" }),
            }),
        ],
        metadata: None,
        client_message_id: None,
        content: None,
    };
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
    let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(assistant), Arc::new(tool_result)];
    let context = RequestBuildContext {
        messages: &messages,
        ..RequestBuildContext::default()
    };
    let body = build_responses_request_body(&base_opts(), &context);
    let input = body["input"].as_array().expect("input 数组");
    assert_eq!(input.len(), 3);
    assert_eq!(
        input[0],
        json!({ "type": "message", "role": "assistant", "content": "我来查" })
    );
    assert_eq!(
        input[1],
        json!({
            "type": "function_call",
            "call_id": "call_1",
            "name": "read_file",
            "arguments": r#"{"path":"/a"}"#,
        })
    );
    assert_eq!(
        input[2],
        json!({
            "type": "function_call_output",
            "call_id": "call_1",
            "output": "文件内容",
        })
    );
}

#[test]
fn responses_body_user_prefix_system_prompt() {
    // wire_mode=user-prefix：system_prompt 改写为首条 user input item（无 instructions）
    let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_message("你好"))];
    let context = RequestBuildContext {
        system_prompt: Some("全局提示".to_string()),
        messages: &messages,
        tools: Vec::new(),
        wire_mode: SystemPromptWireMode::UserPrefix,
    };
    let body = build_responses_request_body(&base_opts(), &context);
    assert!(body.get("instructions").is_none(), "UserPrefix 模式不得发 instructions");
    assert_eq!(body["input"][0]["type"], "message");
    assert_eq!(body["input"][0]["role"], "user");
    assert_eq!(
        body["input"][0]["content"],
        "System instructions for this run:\n\n全局提示"
    );
    assert_eq!(body["input"][1]["content"], "你好");
}

#[test]
fn responses_body_cache_policy_never_injected() {
    // 即使 Key 机制 policy（GPT-5.x + 会话 ID）存在，Responses 轨也不得注入
    // chat 形状缓存字段（对 /responses 属无效载荷，DEEPCHECK-05 #10）；
    // DeepSeek 自动缓存零参数（官方矩阵 prompt_cache_* 不受支持）
    let opts = ChatCompletionsRequestOptions {
        cache: Some(cache_policy(
            CacheMechanism::Key,
            Some("ses-abc"),
            CacheRetention::Short,
            TtlBucket::FiveMinutes,
            None,
        )),
        ..base_opts()
    };
    let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_message("你好"))];
    let context = RequestBuildContext {
        messages: &messages,
        ..RequestBuildContext::default()
    };
    let body = build_responses_request_body(&opts, &context);
    for key in ["prompt_cache_key", "prompt_cache_retention", "prompt_cache_options"] {
        assert!(body.get(key).is_none(), "Responses 轨不得注入 {key}");
    }
    for item in body["input"].as_array().expect("input 数组") {
        assert!(item.get("cache_control").is_none(), "input item 不得携带断点");
    }
}

#[test]
fn responses_body_omits_chat_specific_fields() {
    // reasoning_effort / thinking_intensity：chat 专有注入面，Responses 轨忽略
    let opts = ChatCompletionsRequestOptions {
        reasoning_effort: Some(ReasoningEffort::High),
        thinking_intensity: Some(ThinkingIntensity::Medium),
        model: Some("claude-opus-4-7".to_string()),
        ..ChatCompletionsRequestOptions::default()
    };
    let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_message("你好"))];
    let context = RequestBuildContext {
        messages: &messages,
        ..RequestBuildContext::default()
    };
    let body = build_responses_request_body(&opts, &context);
    for key in ["reasoning_effort", "thinking", "effort", "generation_config", "stream_options"] {
        assert!(body.get(key).is_none(), "Responses 轨不得注入 chat 专有字段 {key}");
    }
}
