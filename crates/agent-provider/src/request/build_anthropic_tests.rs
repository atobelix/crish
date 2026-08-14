//! request/build_anthropic.rs 测试旁挂（多模型适配战役 R2 T2.1a / G7-a）
//!
//! 验收断言（任务书 T2.1a）：
//! 1. mock 请求（system + user + assistant text + thinking + tool_calls + tool_result）
//!    → 请求体断言：`system` 字符串、assistant content 块数组含 text/thinking 块、
//!    tool_use/tool_result 配对、`max_tokens` 字段、thinking budget_tokens（思考启用）；
//! 2. 头断言：x-api-key / anthropic-version 存在；
//! 3. 思考关闭时请求体不含 `thinking` 键。

use super::*;

use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole, ToolCallBlock};
use conex_types::tool::{SystemPromptWireMode, ToolOutput};
use serde_json::json;
use std::sync::Arc;

fn user_message(text: &str) -> AgentMessage {
    AgentMessage {
        id: "u1".to_string(),
        role: AgentMessageRole::User,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        blocks: vec![AgentMessageBlock::Text {
            text: text.to_string(),
        }],
        metadata: None,
        client_message_id: None,
        content: None,
    }
}

// ── 验收 1：系统 + 用户 + 助手(text/thinking/tool_calls) + 工具结果 ──

fn assistant_with_thought_and_tool(text: &str, thinking: &str) -> AgentMessage {
    AgentMessage {
        id: "a1".to_string(),
        role: AgentMessageRole::Assistant,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        blocks: vec![
            AgentMessageBlock::Thought {
                text: thinking.to_string(),
                redacted: None,
            },
            AgentMessageBlock::Text {
                text: text.to_string(),
            },
            AgentMessageBlock::ToolCall(ToolCallBlock {
                id: "call_1".to_string(),
                tool_name: "read_file".to_string(),
                input: json!({ "path": "/tmp/a.txt" }),
            }),
        ],
        metadata: None,
        client_message_id: None,
        content: None,
    }
}

fn tool_result_message(call_id: &str, output: &str, is_error: bool) -> AgentMessage {
    AgentMessage {
        id: "t1".to_string(),
        role: AgentMessageRole::Tool,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        blocks: vec![AgentMessageBlock::ToolResult {
            tool_call_id: call_id.to_string(),
            tool_name: "read_file".to_string(),
            output: ToolOutput::text(output),
            is_error,
        }],
        metadata: None,
        client_message_id: None,
        content: None,
    }
}

fn tool(name: &str) -> crate::request::tools::ToolDefinition {
    crate::request::tools::ToolDefinition {
        name: name.to_string(),
        description: format!("工具 {name}"),
        input_schema: json!({ "type": "object" }),
    }
}

fn full_context() -> (AnthropicRequestOptions, RequestBuildContext<'static>) {
    let messages: Vec<Arc<AgentMessage>> = vec![
        Arc::new(user_message("查一下 /tmp/a.txt")),
        Arc::new(assistant_with_thought_and_tool("我来读取", "先想想路径")),
        Arc::new(tool_result_message("call_1", "文件内容：hello", false)),
    ];
    // 生命周期：借用放入上下文后被 drop 前必须存活；通过 Box::leak 构造 'static 简化
    let messages: &'static [Arc<AgentMessage>] = Box::leak(messages.into_boxed_slice());
    let opts = AnthropicRequestOptions {
        model: Some("claude-sonnet-4.5".to_string()),
        max_tokens: Some(4096),
        reasoning_effort: Some(ReasoningEffort::High),
        ..AnthropicRequestOptions::default()
    };
    let context = RequestBuildContext {
        system_prompt: Some("你是 Conex 助手".to_string()),
        messages,
        tools: vec![tool("read_file")],
        wire_mode: SystemPromptWireMode::NativeSystemRole,
    };
    (opts, context)
}

#[test]
fn full_mock_request_body_shape() {
    let (opts, context) = full_context();
    let body = build_anthropic_request_body(&opts, &context);

    // model / system 字符串 / max_tokens
    assert_eq!(body["model"], "claude-sonnet-4.5");
    assert_eq!(body["system"], "你是 Conex 助手");
    assert_eq!(body["max_tokens"], 4096);

    // thinking budget_tokens（High → 4096）
    assert_eq!(body["thinking"]["type"], "enabled");
    assert_eq!(body["thinking"]["budget_tokens"], 4096);

    // assistant 消息 content 块数组含 text / thinking / tool_use
    let messages = body["messages"].as_array().expect("messages 数组");
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[0]["role"], "user");
    // assistant 消息
    assert_eq!(messages[1]["role"], "assistant");
    let assistant_content = messages[1]["content"]
        .as_array()
        .expect("assistant content 数组");
    assert_eq!(assistant_content.len(), 3);
    // thinking 块
    assert_eq!(assistant_content[0]["type"], "thinking");
    assert_eq!(assistant_content[0]["thinking"], "先想想路径");
    // text 块
    assert_eq!(assistant_content[1]["type"], "text");
    assert_eq!(assistant_content[1]["text"], "我来读取");
    // tool_use 块
    assert_eq!(assistant_content[2]["type"], "tool_use");
    assert_eq!(assistant_content[2]["id"], "call_1");
    assert_eq!(assistant_content[2]["name"], "read_file");
    assert_eq!(
        assistant_content[2]["input"],
        json!({ "path": "/tmp/a.txt" })
    );

    // tool_result：Anthropic 官方 tool_result 属 user 角色
    assert_eq!(messages[2]["role"], "user");
    let tool_result_content = messages[2]["content"]
        .as_array()
        .expect("tool_result content 数组");
    assert_eq!(tool_result_content.len(), 1);
    assert_eq!(tool_result_content[0]["type"], "tool_result");
    assert_eq!(tool_result_content[0]["tool_use_id"], "call_1");
    assert_eq!(tool_result_content[0]["content"], "文件内容：hello");
}

// ── 验收 3：思考关闭时请求体不含 `thinking` 键 ──

#[test]
fn thinking_off_omits_thinking_key() {
    // effort off / auto / None 均不注入 thinking 键
    for effort in [ReasoningEffort::Off, ReasoningEffort::Auto] {
        let mut messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_message("你好"))];
        let msgs: &'static [Arc<AgentMessage>] =
            Box::leak(std::mem::take(&mut messages).into_boxed_slice());
        let opts = AnthropicRequestOptions {
            model: Some("claude-sonnet-4.5".to_string()),
            max_tokens: Some(1024),
            reasoning_effort: Some(effort),
            ..AnthropicRequestOptions::default()
        };
        let context = RequestBuildContext {
            system_prompt: None,
            messages: msgs,
            tools: Vec::new(),
            wire_mode: SystemPromptWireMode::NativeSystemRole,
        };
        let body = build_anthropic_request_body(&opts, &context);
        assert!(
            body.get("thinking").is_none(),
            "思考关闭（effort={effort:?}）时请求体不应含 thinking 键：{body}"
        );
    }

    // 无 effort/intensity：也不注入
    let mut messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_message("你好"))];
    let msgs: &'static [Arc<AgentMessage>] =
        Box::leak(std::mem::take(&mut messages).into_boxed_slice());
    let opts = AnthropicRequestOptions {
        model: Some("claude-sonnet-4.5".to_string()),
        max_tokens: Some(1024),
        ..AnthropicRequestOptions::default()
    };
    let context = RequestBuildContext {
        system_prompt: None,
        messages: msgs,
        tools: Vec::new(),
        wire_mode: SystemPromptWireMode::NativeSystemRole,
    };
    let body = build_anthropic_request_body(&opts, &context);
    assert!(body.get("thinking").is_none());
}

// ── 验收 3b：thinking_intensity Off 也不注入 ──

#[test]
fn thinking_intensity_off_omits_thinking() {
    let mut messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_message("你好"))];
    let msgs: &'static [Arc<AgentMessage>] =
        Box::leak(std::mem::take(&mut messages).into_boxed_slice());
    let opts = AnthropicRequestOptions {
        model: Some("claude-sonnet-4.5".to_string()),
        max_tokens: Some(1024),
        thinking_intensity: Some(ThinkingIntensity::Off),
        ..AnthropicRequestOptions::default()
    };
    let context = RequestBuildContext {
        system_prompt: None,
        messages: msgs,
        tools: Vec::new(),
        wire_mode: SystemPromptWireMode::NativeSystemRole,
    };
    let body = build_anthropic_request_body(&opts, &context);
    assert!(body.get("thinking").is_none());
}

// ── 验收 2：差异化请求头 ──

#[test]
fn anthropic_headers_shape() {
    let headers = anthropic_request_headers("sk-test-123");
    let map: std::collections::HashMap<&'static str, &String> =
        headers.iter().map(|(k, v)| (*k, v)).collect();
    assert_eq!(map["x-api-key"], "sk-test-123");
    assert_eq!(map["anthropic-version"], "2023-06-01");
    assert_eq!(map["content-type"], "application/json");
}

// ── 补充：D03-02/INV-07 严格交替约束（连续 assistant 400 防御）──

#[test]
fn consecutive_assistant_messages_get_user_separator() {
    // 两个连续 assistant 消息 → wire 中第二个 assistant 前插入 user 占位
    let messages: Vec<Arc<AgentMessage>> = vec![
        Arc::new(assistant_with_thought_and_tool("第一段", "想法A")),
        Arc::new(assistant_with_thought_and_tool("第二段", "想法B")),
    ];
    let msgs: &'static [Arc<AgentMessage>] = Box::leak(messages.into_boxed_slice());
    let opts = AnthropicRequestOptions {
        model: Some("claude-sonnet-4.5".to_string()),
        max_tokens: Some(1024),
        ..AnthropicRequestOptions::default()
    };
    let context = RequestBuildContext {
        system_prompt: None,
        messages: msgs,
        tools: Vec::new(),
        wire_mode: SystemPromptWireMode::NativeSystemRole,
    };
    let body = build_anthropic_request_body(&opts, &context);
    let wire_messages = body["messages"].as_array().expect("messages 数组");
    // 首条 assistant → 前置 user 占位；两个 assistant 之间再插 user 占位
    assert_eq!(wire_messages.len(), 4);
    assert_eq!(wire_messages[0]["role"], "user");
    assert_eq!(wire_messages[0]["content"], WIRE_CONTINUATION_NOTE);
    assert_eq!(wire_messages[1]["role"], "assistant");
    assert_eq!(wire_messages[2]["role"], "user");
    assert_eq!(wire_messages[2]["content"], WIRE_CONTINUATION_NOTE);
    assert_eq!(wire_messages[3]["role"], "assistant");
    // 相邻消息角色严格交替（无连续 assistant）
    for pair in wire_messages.windows(2) {
        let (a, b) = (&pair[0]["role"], &pair[1]["role"]);
        assert!(
            !(a == "assistant" && b == "assistant"),
            "wire 不应出现连续 assistant：{wire_messages:?}"
        );
    }
}

#[test]
fn leading_assistant_gets_user_prefix() {
    // 首条为 assistant（无任何 user 前缀）→ 前插 user 占位满足「首条 user」要求
    let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(assistant_with_thought_and_tool(
        "直接开场",
        "思考",
    ))];
    let msgs: &'static [Arc<AgentMessage>] = Box::leak(messages.into_boxed_slice());
    let opts = AnthropicRequestOptions {
        model: Some("claude-sonnet-4.5".to_string()),
        max_tokens: Some(1024),
        ..AnthropicRequestOptions::default()
    };
    let context = RequestBuildContext {
        system_prompt: None,
        messages: msgs,
        tools: Vec::new(),
        wire_mode: SystemPromptWireMode::NativeSystemRole,
    };
    let body = build_anthropic_request_body(&opts, &context);
    let wire_messages = body["messages"].as_array().expect("messages 数组");
    assert_eq!(wire_messages.len(), 2);
    assert_eq!(wire_messages[0]["role"], "user");
    assert_eq!(wire_messages[0]["content"], WIRE_CONTINUATION_NOTE);
    assert_eq!(wire_messages[1]["role"], "assistant");
}

// ── 补充：系统 prompt 空值归一 / compactObject ──

#[test]
fn empty_system_prompt_omits_system_key() {
    let mut messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_message("你好"))];
    let msgs: &'static [Arc<AgentMessage>] =
        Box::leak(std::mem::take(&mut messages).into_boxed_slice());
    let opts = AnthropicRequestOptions {
        model: Some("claude-sonnet-4.5".to_string()),
        max_tokens: Some(1024),
        ..AnthropicRequestOptions::default()
    };
    let context = RequestBuildContext {
        system_prompt: Some("   ".to_string()),
        messages: msgs,
        tools: Vec::new(),
        wire_mode: SystemPromptWireMode::NativeSystemRole,
    };
    let body = build_anthropic_request_body(&opts, &context);
    assert!(body.get("system").is_none(), "空白 system 不应出现在请求体");
}

#[test]
fn tool_choice_shape_and_tools() {
    let mut messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_message("你好"))];
    let msgs: &'static [Arc<AgentMessage>] =
        Box::leak(std::mem::take(&mut messages).into_boxed_slice());
    let opts = AnthropicRequestOptions {
        model: Some("claude-sonnet-4.5".to_string()),
        max_tokens: Some(1024),
        tool_choice: Some(ToolChoice::Auto),
        ..AnthropicRequestOptions::default()
    };
    let context = RequestBuildContext {
        system_prompt: None,
        messages: msgs,
        tools: vec![tool("read_file")],
        wire_mode: SystemPromptWireMode::NativeSystemRole,
    };
    let body = build_anthropic_request_body(&opts, &context);
    // tools：Anthropic 官方 shape {name, description, input_schema}，无 type 字段
    assert_eq!(body["tools"][0]["name"], "read_file");
    assert_eq!(body["tools"][0]["description"], "工具 read_file");
    assert_eq!(
        body["tools"][0]["input_schema"],
        json!({ "type": "object" })
    );
    // tool_choice：auto → {type:"auto"}
    assert_eq!(body["tool_choice"], json!({ "type": "auto" }));
}
