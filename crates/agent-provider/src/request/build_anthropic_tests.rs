//! request/build_anthropic.rs 测试旁挂（多模型适配战役 R2 T2.1a / G7-a / Batch 2）
//!
//! 验收断言：
//! 1. mock 请求（system + user + assistant text + thinking + tool_calls + tool_result）
//!    → 请求体断言：`system` 缓存断点数组、assistant content 块数组含 text/thinking 块、
//!    tool_use/tool_result 配对、`max_tokens` 自动安全抬升、thinking budget_tokens；
//! 2. 头断言：x-api-key / anthropic-version 存在；
//! 3. 思考关闭时请求体不含 `thinking` 键；
//! 4. 显式 thinking_budget 与 prompt cache 注入验证。

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

/// 无 ToolCall 的纯文本/思考 assistant 消息（交替约束测试用——避免触发
/// W04 成对性守门：交替测试的 fixture 不应携带孤儿 tool_use）
fn assistant_with_text_and_thought(text: &str, thinking: &str) -> AgentMessage {
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
    let messages: &'static [Arc<AgentMessage>] = Box::leak(messages.into_boxed_slice());
    let mut thinking_map = indexmap::IndexMap::new();
    thinking_map.insert("High".to_string(), "4096".to_string());
    let opts = AnthropicRequestOptions {
        model: Some("claude-sonnet-4.5".to_string()),
        max_tokens: Some(8192),
        reasoning_effort: Some(ReasoningEffort::High),
        thinking_format: Some(crate::models::catalog_types::ThinkingFormat::Anthropic),
        thinking_map: Some(thinking_map),
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

    // model / system 缓存断点数组 / max_tokens 安全抬升 (High 4096 + 4096 = 8192)
    assert_eq!(body["model"], "claude-sonnet-4.5");
    assert_eq!(
        body["system"],
        json!([
            {
                "type": "text",
                "text": "你是 Conex 助手",
                "cache_control": { "type": "ephemeral" }
            }
        ])
    );
    assert_eq!(body["max_tokens"], 8192);

    // thinking budget_tokens（High → 4096）
    assert_eq!(body["thinking"]["type"], "enabled");
    assert_eq!(body["thinking"]["budget_tokens"], 4096);

    // tools 最后一个工具注入 cache_control
    assert_eq!(
        body["tools"][0]["cache_control"],
        json!({ "type": "ephemeral" })
    );

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

    // tool_result：Anthropic 官方 tool_result 属 user 角色，且末尾块注入 cache_control
    assert_eq!(messages[2]["role"], "user");
    let tool_result_content = messages[2]["content"]
        .as_array()
        .expect("tool_result content 数组");
    assert_eq!(tool_result_content.len(), 1);
    assert_eq!(tool_result_content[0]["type"], "tool_result");
    assert_eq!(tool_result_content[0]["tool_use_id"], "call_1");
    assert_eq!(tool_result_content[0]["content"], "文件内容：hello");
    assert_eq!(
        tool_result_content[0]["cache_control"],
        json!({ "type": "ephemeral" })
    );
}

// ── 验收 3：思考关闭时请求体不含 `thinking` 键 ──

#[test]
fn thinking_off_omits_thinking_key() {
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
        assert_eq!(body["max_tokens"], 1024);
    }

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
    assert_eq!(body["max_tokens"], 1024);
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

// ── 验收 4：显式 thinking_budget 测试 ──

#[test]
fn explicit_thinking_budget_override() {
    // plans/04 §2.2：预算只来自字典数字（≥1024），禁止魔法刻度兜底
    let mut messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_message("深度分析"))];
    let msgs: &'static [Arc<AgentMessage>] =
        Box::leak(std::mem::take(&mut messages).into_boxed_slice());
    let mut thinking_map = indexmap::IndexMap::new();
    thinking_map.insert("High".to_string(), "16000".to_string());
    let opts = AnthropicRequestOptions {
        model: Some("claude-3-7-sonnet".to_string()),
        thinking_format: Some(crate::models::catalog_types::ThinkingFormat::Anthropic),
        thinking_map: Some(thinking_map),
        reasoning_effort: Some(ReasoningEffort::High),
        max_tokens: Some(20096),
        ..AnthropicRequestOptions::default()
    };
    let context = RequestBuildContext {
        system_prompt: None,
        messages: msgs,
        tools: Vec::new(),
        wire_mode: SystemPromptWireMode::NativeSystemRole,
    };
    let body = build_anthropic_request_body(&opts, &context);
    assert_eq!(body["thinking"]["type"], "enabled");
    assert_eq!(body["thinking"]["budget_tokens"], 16000);
    // 16000 + 4096 = 20096 → 自动抬升
    assert_eq!(body["max_tokens"], 20096);
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
    let messages: Vec<Arc<AgentMessage>> = vec![
        Arc::new(assistant_with_text_and_thought("第一段", "想法A")),
        Arc::new(assistant_with_text_and_thought("第二段", "想法B")),
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
    assert_eq!(wire_messages.len(), 4);
    assert_eq!(wire_messages[0]["role"], "user");
    assert_eq!(wire_messages[0]["content"], WIRE_CONTINUATION_NOTE);
    assert_eq!(wire_messages[1]["role"], "assistant");
    assert_eq!(wire_messages[2]["role"], "user");
    assert_eq!(wire_messages[2]["content"], WIRE_CONTINUATION_NOTE);
    assert_eq!(wire_messages[3]["role"], "assistant");
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
    let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(assistant_with_text_and_thought(
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
    assert_eq!(body["tools"][0]["name"], "read_file");
    assert_eq!(body["tools"][0]["description"], "工具 read_file");
    assert_eq!(
        body["tools"][0]["input_schema"],
        json!({ "type": "object" })
    );
    assert_eq!(
        body["tools"][0]["cache_control"],
        json!({ "type": "ephemeral" })
    );
    assert_eq!(body["tool_choice"], json!({ "type": "auto" }));
}

// ── W04：出站成对性 Fail-Closed 守门（详案 02 §3.4 轨一）──
// 检测函数 detect_anthropic_unpaired_tool_calls 为纯只读面，任何构建模式
// 下均可直接断言孤儿 ID；validate_* 的 panic/Err 分级行为见注释。

/// 成对完整对话：detect 返回空、build 正常产出且请求体 messages 通过检测
#[test]
fn pairing_gate_paired_conversation_passes() {
    let (opts, context) = full_context();
    let body = build_anthropic_request_body(&opts, &context);
    let messages = body["messages"].as_array().expect("messages 数组");
    assert!(
        detect_anthropic_unpaired_tool_calls(messages).is_empty(),
        "成对完整对话不应检出孤儿：{messages:?}"
    );
}

/// 孤儿 tool_use（assistant 有 tool_use、缺对应 user tool_result）：
/// detect 返回排序后的孤儿 ID 列表（供会话循环补齐重试对账）。
/// 注意：不得经 build_anthropic_request_body——Debug 下其内部守门会 panic
/// （Fail-Fast）；Release 下拒绝组包。校验 API 面即 validate_*/detect_*。
#[test]
fn pairing_gate_detects_orphan_tool_use() {
    let messages = vec![
        json!({ "role": "user", "content": [{ "type": "text", "text": "读文件" }] }),
        json!({
            "role": "assistant",
            "content": [
                { "type": "text", "text": "好的" },
                { "type": "tool_use", "id": "call_orphan", "name": "read_file", "input": {} }
            ]
        }),
    ];
    let orphans = detect_anthropic_unpaired_tool_calls(&messages);
    assert_eq!(orphans, ["call_orphan"]);
}

/// 多孤儿 ID 排序稳定（BTreeSet 语义）：补齐重试路径依赖确定顺序逐 ID 对账
#[test]
fn pairing_gate_orphan_ids_sorted_stable() {
    let messages = vec![
        json!({
            "role": "assistant",
            "content": [
                { "type": "tool_use", "id": "call_z", "name": "a", "input": {} },
                { "type": "tool_use", "id": "call_a", "name": "b", "input": {} },
                { "type": "tool_use", "id": "call_m", "name": "c", "input": {} }
            ]
        }),
        json!({
            "role": "user",
            "content": [{ "type": "tool_result", "tool_use_id": "call_m", "content": "ok" }]
        }),
    ];
    let orphans = detect_anthropic_unpaired_tool_calls(&messages);
    assert_eq!(orphans, ["call_a", "call_z"]);
}

/// 部分闭合：同批次多 tool_use 仅一条被 tool_result 回答 → 仅余孤儿进列表
#[test]
fn pairing_gate_partial_closure_leaves_only_unanswered() {
    let messages = vec![
        json!({
            "role": "assistant",
            "content": [
                { "type": "tool_use", "id": "call_done", "name": "a", "input": {} },
                { "type": "tool_use", "id": "call_open", "name": "b", "input": {} }
            ]
        }),
        json!({
            "role": "user",
            "content": [{ "type": "tool_result", "tool_use_id": "call_done", "content": "ok" }]
        }),
    ];
    let orphans = detect_anthropic_unpaired_tool_calls(&messages);
    assert_eq!(orphans, ["call_open"]);
}

/// validate 对孤儿返回 Err(UnpairedToolCalls) 并记录结构化日志（Debug 与 Release 统一行为）。
#[test]
fn pairing_gate_validate_returns_err_on_orphan() {
    let messages = vec![json!({
        "role": "assistant",
        "content": [{ "type": "tool_use", "id": "call_x", "name": "a", "input": {} }]
    })];
    let res = validate_anthropic_tool_pairing(&messages);
    match res {
        Err(RequestBuildError::UnpairedToolCalls { protocol, orphan_ids }) => {
            assert_eq!(protocol, "anthropic");
            assert_eq!(orphan_ids, vec!["call_x"]);
        }
        other => panic!("期望 UnpairedToolCalls 错误，得到：{other:?}"),
    }
}

/// build 入口在孤儿输入下 Fail-Closed：安全过滤孤儿 tool_use，不发生 panic。
#[test]
fn build_anthropic_fail_closed_on_orphan() {
    let messages = vec![
        Arc::new(user_message("读文件")),
        Arc::new(assistant_with_thought_and_tool("我来读取", "先想想路径")),
    ];
    let context = RequestBuildContext {
        system_prompt: None,
        messages: &messages,
        tools: Vec::new(),
        wire_mode: SystemPromptWireMode::NativeSystemRole,
    };
    let body = build_anthropic_request_body(&AnthropicRequestOptions::default(), &context);
    let msgs = body["messages"].as_array().expect("messages 必须为数组");
    for msg in msgs {
        if let Some(content) = msg.get("content").and_then(Value::as_array) {
            for block in content {
                assert_ne!(
                    block.get("type").and_then(Value::as_str),
                    Some("tool_use"),
                    "带毒孤儿 tool_use 必须被过滤掉: {block:?}"
                );
            }
        }
    }
}

/// 从完整对话剔除 Tool 结果消息后的 wire 等价物：assistant 带 tool_use、
/// 无后续 user tool_result → 检出孤儿（模拟 Tier-1/2 失守时历史直接透传导线层）
#[test]
fn pairing_gate_missing_tool_result_message_detected() {
    let wire = vec![
        json!({ "role": "user", "content": [{ "type": "text", "text": "查一下 /tmp/a.txt" }] }),
        json!({
            "role": "assistant",
            "content": [
                { "type": "thinking", "thinking": "先想想路径" },
                { "type": "text", "text": "我来读取" },
                { "type": "tool_use", "id": "call_1", "name": "read_file", "input": { "path": "/tmp/a.txt" } }
            ]
        }),
    ];
    let orphans = detect_anthropic_unpaired_tool_calls(&wire);
    assert_eq!(orphans, ["call_1"]);
}

/// build 入口在纯孤儿 tool_use（无文本正文）下：过滤 tool_use 并补入 WIRE_CONTINUATION_NOTE 占位文本，杜绝 400
#[test]
fn build_anthropic_fail_closed_on_orphan_no_text_injects_continuation_note() {
    let orphan_call = AgentMessage {
        id: "a1".to_string(),
        role: AgentMessageRole::Assistant,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        blocks: vec![AgentMessageBlock::ToolCall(ToolCallBlock {
            id: "call_orphan".to_string(),
            tool_name: "test_tool".to_string(),
            input: json!({}),
        })],
        metadata: None,
        client_message_id: None,
        content: None,
    };
    let messages = vec![
        Arc::new(user_message("hello")),
        Arc::new(orphan_call),
    ];
    let context = RequestBuildContext {
        system_prompt: None,
        messages: &messages,
        tools: Vec::new(),
        wire_mode: SystemPromptWireMode::NativeSystemRole,
    };
    let body = build_anthropic_request_body(&AnthropicRequestOptions::default(), &context);
    let msgs = body["messages"].as_array().expect("messages 必须为数组");
    let mut found_assistant = false;
    for msg in msgs {
        if msg.get("role").and_then(Value::as_str) == Some("assistant") {
            found_assistant = true;
            let content = msg["content"].as_array().expect("assistant content 必须为数组");
            assert_eq!(content.len(), 1);
            assert_eq!(content[0]["type"], "text");
            assert_eq!(content[0]["text"], WIRE_CONTINUATION_NOTE);
        }
    }
    assert!(found_assistant, "必须包含 assistant 消息");
}

/// build 入口在思考 + 孤儿 tool_use（无文本）下：过滤 tool_use 并跟进 WIRE_CONTINUATION_NOTE，满足 thinking 必须跟随 text 的规范
#[test]
fn build_anthropic_fail_closed_on_orphan_thinking_only_injects_continuation_note() {
    let orphan_call = AgentMessage {
        id: "a1".to_string(),
        role: AgentMessageRole::Assistant,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        blocks: vec![
            AgentMessageBlock::Thought {
                text: "思考中...".to_string(),
                redacted: None,
            },
            AgentMessageBlock::ToolCall(ToolCallBlock {
                id: "call_orphan_thought".to_string(),
                tool_name: "test_tool".to_string(),
                input: json!({}),
            }),
        ],
        metadata: None,
        client_message_id: None,
        content: None,
    };
    let messages = vec![
        Arc::new(user_message("hello")),
        Arc::new(orphan_call),
    ];
    let context = RequestBuildContext {
        system_prompt: None,
        messages: &messages,
        tools: Vec::new(),
        wire_mode: SystemPromptWireMode::NativeSystemRole,
    };
    let body = build_anthropic_request_body(&AnthropicRequestOptions::default(), &context);
    let msgs = body["messages"].as_array().expect("messages 必须为数组");
    let mut found_assistant = false;
    for msg in msgs {
        if msg.get("role").and_then(Value::as_str) == Some("assistant") {
            found_assistant = true;
            let content = msg["content"].as_array().expect("assistant content 必须为数组");
            assert_eq!(content.len(), 2);
            assert_eq!(content[0]["type"], "thinking");
            assert_eq!(content[1]["type"], "text");
            assert_eq!(content[1]["text"], WIRE_CONTINUATION_NOTE);
        }
    }
    assert!(found_assistant, "必须包含 assistant 消息");
}

// ── 验收 4：运行时转向保真与角色交替测试 (BC08-5) ──

#[test]
fn test_system_steering_message_preservation_and_alternation() {
    let system_steering = AgentMessage {
        id: "s1".to_string(),
        role: AgentMessageRole::System,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        blocks: vec![AgentMessageBlock::Text {
            text: "请停止遍历，直接输出当前已找到的文件列表".to_string(),
        }],
        metadata: None,
        client_message_id: None,
        content: None,
    };

    let messages = vec![
        Arc::new(user_message("帮我搜索项目文件")),
        Arc::new(assistant_with_text_and_thought("正在检索...", "需要先遍历目录")),
        Arc::new(system_steering),
    ];
    let context = RequestBuildContext {
        system_prompt: Some("全局系统提示词".to_string()),
        messages: &messages,
        tools: Vec::new(),
        wire_mode: SystemPromptWireMode::NativeSystemRole,
    };
    let body = build_anthropic_request_body(&AnthropicRequestOptions::default(), &context);
    let msgs = body["messages"].as_array().expect("messages 必须为数组");

    // 严格交替：user -> assistant -> user (steering)
    assert_eq!(msgs.len(), 3);
    assert_eq!(msgs[0]["role"], "user");
    assert_eq!(msgs[1]["role"], "assistant");
    assert_eq!(msgs[2]["role"], "user");

    let steering_content = msgs[2]["content"].as_array().expect("content 为数组");
    assert_eq!(steering_content.len(), 1);
    assert_eq!(steering_content[0]["type"], "text");
    let steering_text = steering_content[0]["text"].as_str().expect("text 为字符串");
    assert!(
        steering_text.contains("[System Directive / Runtime Steering]"),
        "必须带有 [System Directive / Runtime Steering] 标识：{steering_text}"
    );
    assert!(
        steering_text.contains("请停止遍历，直接输出当前已找到的文件列表"),
        "必须保全转向文本：{steering_text}"
    );

    // 顶层 system 保持全局提示词（含可能的缓存断点结构），不被中途转向污染
    let sys_str = if let Some(arr) = body["system"].as_array() {
        arr[0]["text"].as_str().unwrap()
    } else {
        body["system"].as_str().unwrap()
    };
    assert_eq!(sys_str, "全局系统提示词");
}

#[test]
fn test_system_steering_after_tool_result_merges_into_user_message() {
    let system_steering = AgentMessage {
        id: "s2".to_string(),
        role: AgentMessageRole::System,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        blocks: vec![AgentMessageBlock::Text {
            text: "工具执行异常，请立即切换备用方案".to_string(),
        }],
        metadata: None,
        client_message_id: None,
        content: None,
    };

    let messages = vec![
        Arc::new(user_message("执行命令")),
        Arc::new(assistant_with_thought_and_tool("我来执行", "思考命令参数")),
        Arc::new(tool_result_message("call_1", "error: command not found", true)),
        Arc::new(system_steering),
    ];
    let context = RequestBuildContext {
        system_prompt: None,
        messages: &messages,
        tools: vec![tool("read_file")],
        wire_mode: SystemPromptWireMode::NativeSystemRole,
    };
    let body = build_anthropic_request_body(&AnthropicRequestOptions::default(), &context);
    let msgs = body["messages"].as_array().expect("messages 必须为数组");

    // user -> assistant -> user (tool_result + steering 融合)
    assert_eq!(msgs.len(), 3);
    assert_eq!(msgs[0]["role"], "user");
    assert_eq!(msgs[1]["role"], "assistant");
    assert_eq!(msgs[2]["role"], "user");

    let merged_content = msgs[2]["content"].as_array().expect("content 为数组");
    // tool_result 与 steering 应该被合并进同一个 user 消息的 content 数组
    assert_eq!(merged_content.len(), 2);
    assert_eq!(merged_content[0]["type"], "tool_result");
    assert_eq!(merged_content[0]["tool_use_id"], "call_1");
    assert_eq!(merged_content[1]["type"], "text");
    assert!(merged_content[1]["text"]
        .as_str()
        .unwrap()
        .contains("[System Directive / Runtime Steering]"));
}

// ── 验收 5：思考块与签名保真及脱敏思考测试 (BC08-4) ──

#[test]
fn test_thinking_signature_and_redacted_preservation() {
    let assistant_with_sig = AgentMessage {
        id: "a_sig".to_string(),
        role: AgentMessageRole::Assistant,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        blocks: vec![
            AgentMessageBlock::Thought {
                text: "深度推理中...".to_string(),
                redacted: None,
            },
            AgentMessageBlock::Text {
                text: "回答完毕".to_string(),
            },
        ],
        metadata: Some(json!({
            "signature": "sig_claude_37_valid_signature_xyz"
        })),
        client_message_id: None,
        content: None,
    };

    let assistant_redacted = AgentMessage {
        id: "a_redacted".to_string(),
        role: AgentMessageRole::Assistant,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        blocks: vec![
            AgentMessageBlock::Thought {
                text: "encrypted_redacted_data_blob".to_string(),
                redacted: Some(true),
            },
            AgentMessageBlock::Text {
                text: "脱敏回答".to_string(),
            },
        ],
        metadata: None,
        client_message_id: None,
        content: None,
    };

    let messages = vec![
        Arc::new(user_message("提问 1")),
        Arc::new(assistant_with_sig),
        Arc::new(user_message("提问 2")),
        Arc::new(assistant_redacted),
    ];
    let context = RequestBuildContext {
        system_prompt: None,
        messages: &messages,
        tools: Vec::new(),
        wire_mode: SystemPromptWireMode::NativeSystemRole,
    };
    let body = build_anthropic_request_body(&AnthropicRequestOptions::default(), &context);
    let msgs = body["messages"].as_array().expect("messages 必须为数组");

    // 检查第 1 条 assistant 消息：thinking 块原样携带 signature
    let a1_content = msgs[1]["content"].as_array().expect("a1 content");
    assert_eq!(a1_content[0]["type"], "thinking");
    assert_eq!(a1_content[0]["thinking"], "深度推理中...");
    assert_eq!(
        a1_content[0]["signature"],
        "sig_claude_37_valid_signature_xyz",
        "必须携带原版 signature"
    );

    // 检查第 2 条 assistant 消息：redacted_thinking 块
    let a2_content = msgs[3]["content"].as_array().expect("a2 content");
    assert_eq!(a2_content[0]["type"], "redacted_thinking");
    assert_eq!(a2_content[0]["data"], "encrypted_redacted_data_blob");
}

// ── 验收 6：长回答上限与动态 max_tokens 测试 (BC08-11) ──

#[test]
fn test_default_max_tokens_dynamic_allocation() {
    let dummy_messages = vec![Arc::new(user_message("hi"))];
    let context = RequestBuildContext {
        system_prompt: None,
        messages: &dummy_messages,
        tools: Vec::new(),
        wire_mode: SystemPromptWireMode::NativeSystemRole,
    };

    // 1. Claude 3.7 默认 64000
    let opts_37 = AnthropicRequestOptions {
        model: Some("claude-3-7-sonnet-20250219".to_string()),
        max_tokens: None,
        ..AnthropicRequestOptions::default()
    };
    let body_37 = build_anthropic_request_body(&opts_37, &context);
    assert_eq!(
        body_37["max_tokens"], 64000,
        "Claude 3.7 默认 max_tokens 必须为 64000，不再硬死锁 2048"
    );

    // 2. Claude 3.5 默认 8192
    let opts_35 = AnthropicRequestOptions {
        model: Some("claude-3-5-sonnet-20241022".to_string()),
        max_tokens: None,
        ..AnthropicRequestOptions::default()
    };
    let body_35 = build_anthropic_request_body(&opts_35, &context);
    assert_eq!(
        body_35["max_tokens"], 8192,
        "Claude 3.5 默认 max_tokens 必须为 8192"
    );

    // 3. Claude 3 Opus 默认 4096
    let opts_opus = AnthropicRequestOptions {
        model: Some("claude-3-opus-20240229".to_string()),
        max_tokens: None,
        ..AnthropicRequestOptions::default()
    };
    let body_opus = build_anthropic_request_body(&opts_opus, &context);
    assert_eq!(
        body_opus["max_tokens"], 4096,
        "Claude 3 Opus 默认 max_tokens 必须为 4096"
    );

    // 4. 未指定 model 时默认 8192
    let opts_default = AnthropicRequestOptions {
        model: None,
        max_tokens: None,
        ..AnthropicRequestOptions::default()
    };
    let body_default = build_anthropic_request_body(&opts_default, &context);
    assert_eq!(
        body_default["max_tokens"], 8192,
        "未指定 model 时默认 max_tokens 必须为 8192"
    );
}
