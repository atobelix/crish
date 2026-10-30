//! messages 测试 · 角色交替续写注记 / 领域纯度 / WireCompat / developer 角色

use super::*;

// ── Wire-Only 角色交替防 400 投影层测试 ──

#[test]
fn consecutive_assistant_messages_inject_wire_continuation_note_in_chat_messages() {
    // 连续 Assistant 消息：中间瞬态注入 User 占位消息，避免 Anthropic/OpenAI 400 报错
    let messages = to_chat_messages(
        None,
        &[
            user_msg(vec![text_block("问题 1")]),
            assistant_msg(vec![text_block("第一段回复")]),
            assistant_msg(vec![text_block("第二段回复")]),
        ],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert_eq!(messages.len(), 4);
    assert_text_content(&messages, 0, "user", "问题 1");
    assert_text_content(&messages, 1, "assistant", "第一段回复");
    assert_text_content(&messages, 2, "user", WIRE_CONTINUATION_NOTE);
    assert_text_content(&messages, 3, "assistant", "第二段回复");
}

#[test]
fn multiple_consecutive_assistants_inject_alternating_notes() {
    let messages = to_chat_messages(
        None,
        &[
            assistant_msg(vec![text_block("段落 1")]),
            assistant_msg(vec![text_block("段落 2")]),
            assistant_msg(vec![text_block("段落 3")]),
        ],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert_eq!(messages.len(), 5);
    assert_text_content(&messages, 0, "assistant", "段落 1");
    assert_text_content(&messages, 1, "user", WIRE_CONTINUATION_NOTE);
    assert_text_content(&messages, 2, "assistant", "段落 2");
    assert_text_content(&messages, 3, "user", WIRE_CONTINUATION_NOTE);
    assert_text_content(&messages, 4, "assistant", "段落 3");
}

#[test]
fn alternating_user_assistant_does_not_inject_extra_notes() {
    let messages = to_chat_messages(
        None,
        &[
            user_msg(vec![text_block("问题 1")]),
            assistant_msg(vec![text_block("回答 1")]),
            user_msg(vec![text_block("问题 2")]),
            assistant_msg(vec![text_block("回答 2")]),
        ],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert_eq!(messages.len(), 4);
    assert_text_content(&messages, 0, "user", "问题 1");
    assert_text_content(&messages, 1, "assistant", "回答 1");
    assert_text_content(&messages, 2, "user", "问题 2");
    assert_text_content(&messages, 3, "assistant", "回答 2");
}

#[test]
fn consecutive_assistant_messages_inject_wire_continuation_note_in_responses_items() {
    let items = to_responses_input_items(
        &[
            user_msg(vec![text_block("问题")]),
            assistant_msg(vec![text_block("回复 A")]),
            assistant_msg(vec![text_block("回复 B")]),
        ],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert_eq!(items.len(), 4);
    assert_eq!(items[0]["role"], "user");
    assert_eq!(items[0]["content"], "问题");
    assert_eq!(items[1]["role"], "assistant");
    assert_eq!(items[1]["content"], "回复 A");
    assert_eq!(items[2]["role"], "user");
    assert_eq!(items[2]["content"], WIRE_CONTINUATION_NOTE);
    assert_eq!(items[3]["role"], "assistant");
    assert_eq!(items[3]["content"], "回复 B");
}

#[test]
fn domain_messages_remain_100_percent_pure_and_unmodified() {
    // 领域消息原序列保持纯净（0 假消息注入领域模型）
    let domain_messages = vec![
        user_msg(vec![text_block("用户指令")]),
        assistant_msg(vec![text_block("历史摘要（role=Assistant）")]),
        assistant_msg(vec![text_block("新回复（role=Assistant）")]),
    ];
    let wire_messages = to_chat_messages(
        None,
        &domain_messages,
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    // Wire 包含 4 条（插入了 1 条瞬态 user 占位）
    assert_eq!(wire_messages.len(), 4);
    // 领域消息切片仍仅有 3 条，内容与角色 100% 原始未变
    assert_eq!(domain_messages.len(), 3);
    assert_eq!(domain_messages[0].role, AgentMessageRole::User);
    assert_eq!(domain_messages[1].role, AgentMessageRole::Assistant);
    assert_eq!(domain_messages[2].role, AgentMessageRole::Assistant);
}

// ── G5-a/G5-b（T2.2/T2.3）：WireCompat 驱动的模型级序列化消费面 ──

/// 便捷构造 DeepSeek 判定上下文（vendor=deepseek）
fn deepseek_compat() -> WireCompat<'static> {
    WireCompat {
        vendor: Some("deepseek"),
        thinking_format: None,
        supports_developer_role: false,
    }
}

#[test]
fn empty_text_assistant_wire_content_is_empty_string() {
    // G5-b（T2.2）：空文本 assistant（带 tool_call，不跳过）→ wire `content:""`
    // （非 null，逐字节断言；契约 M8）。缺省 compat 与非 DeepSeek 均如此。
    for compat in [WireCompat::default(), deepseek_compat()] {
        let messages = to_chat_messages_with_compat(
            None,
            &[assistant_msg(vec![tool_call_block(
                "c1",
                "noop",
                json!({}),
            )])],
            ReasoningContentMode::Omit,
            SystemPromptWireMode::NativeSystemRole,
            compat,
        );
        let wire = messages[0].to_value();
        let json = serde_json::to_string(&wire).expect("序列化");
        assert_eq!(
            wire["content"], "",
            "空文本 assistant wire content 必须为空串"
        );
        assert!(
            json.contains("\"content\":\"\""),
            "wire 字节必须含 content:\"\"：{json}"
        );
        assert!(!json.contains("null"), "wire 不得含 null content：{json}");
    }
}

#[test]
fn empty_text_pure_thinking_assistant_wire_content_is_empty_string() {
    // G5-b（T2.2）：纯思考轮（无 tool_calls）assistant 空文本 → wire content:""
    // （非 null）；有思考保留 reasoning_content（DeepSeek Include 轨）。
    let thinking = assistant_msg(vec![AgentMessageBlock::Thought {
        text: "推理过程".to_string(),
        redacted: None,
    }]);
    let messages = to_chat_messages_with_compat(
        None,
        &[thinking],
        ReasoningContentMode::Include,
        SystemPromptWireMode::NativeSystemRole,
        deepseek_compat(),
    );
    let wire = messages[0].to_value();
    assert_eq!(wire["content"], "", "纯思考轮空文本 → wire content 空串");
    assert_eq!(
        wire["reasoning_content"], "推理过程",
        "带思考时保留 reasoning_content"
    );
}

#[test]
fn deepseek_tool_call_round_always_carries_reasoning_content_key() {
    // G5-b（T2.2）：DeepSeek 厂商 + 带 tool_calls 的回合 → 必含 reasoning_content 键
    // （空串兜底）。**Omit 模式亦强制**（键存在性与 mode 无关，对齐 DSH
    // serialize.ts:99 tool-call 回合必带 passback 语义）。
    let messages = to_chat_messages_with_compat(
        None,
        &[assistant_msg(vec![tool_call_block(
            "c1",
            "noop",
            json!({}),
        )])],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
        deepseek_compat(),
    );
    let wire = messages[0].to_value();
    assert!(
        wire.get("reasoning_content").is_some(),
        "DeepSeek tool_calls 回合必含键：{wire}"
    );
    assert_eq!(wire["reasoning_content"], "", "无思考时空串兜底");
    assert!(wire.get("tool_calls").is_some(), "tool_calls 键必须在");

    // 有思考时回传思考内容
    let with_thought = to_chat_messages_with_compat(
        None,
        &[message(
            AgentMessageRole::Assistant,
            vec![
                tool_call_block("c1", "noop", json!({})),
                AgentMessageBlock::Thought {
                    text: "思考".to_string(),
                    redacted: None,
                },
            ],
        )],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
        deepseek_compat(),
    );
    assert_eq!(with_thought[0].to_value()["reasoning_content"], "思考");
}

#[test]
fn non_deepseek_does_not_force_reasoning_content_key() {
    // G5-b（T2.2）：非 DeepSeek 厂商 → 不带键（Omit 模式 key 恒无；
    // Include 有思考才带，属既有 mode 语义，不做强制）。
    let non_deepseek = WireCompat {
        vendor: Some("openai"),
        thinking_format: None,
        supports_developer_role: false,
    };
    let messages = to_chat_messages_with_compat(
        None,
        &[assistant_msg(vec![tool_call_block(
            "c1",
            "noop",
            json!({}),
        )])],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
        non_deepseek,
    );
    let wire = messages[0].to_value();
    assert!(
        wire.get("reasoning_content").is_none(),
        "非 DeepSeek 不得强制 reasoning_content 键：{wire}"
    );

    // 缺省 compat（非 DeepSeek）+ Omit → 同样不带键
    let messages = to_chat_messages(
        None,
        &[assistant_msg(vec![tool_call_block(
            "c1",
            "noop",
            json!({}),
        )])],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert!(messages[0].to_value().get("reasoning_content").is_none());
}

#[test]
fn deepseek_plain_thinking_round_keeps_thought_not_forced() {
    // G5-b（T2.2）：DeepSeek 纯思考轮（无 tool_calls）带思考时保留 reasoning_content；
    // 无思考（Omit）则不强制空串键（与 tool-call 回合的必带语义区分）。
    let with_thought = to_chat_messages_with_compat(
        None,
        &[message(
            AgentMessageRole::Assistant,
            vec![AgentMessageBlock::Thought {
                text: "思考过程".to_string(),
                redacted: None,
            }],
        )],
        ReasoningContentMode::Require,
        SystemPromptWireMode::NativeSystemRole,
        deepseek_compat(),
    );
    assert_eq!(with_thought[0].to_value()["reasoning_content"], "思考过程");

    // Omit + 无思考 → 不带键（纯思考轮不强加）
    let omit = to_chat_messages_with_compat(
        None,
        &[assistant_msg(vec![])],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
        deepseek_compat(),
    );
    // 无文本/无工具/无思考 → 整条跳过
    assert!(omit.is_empty(), "Omit 纯空消息整条跳过");
}

#[test]
fn developer_role_openrouter_anthropic_prefix_reasoning_uses_developer() {
    // G5-a（T2.3，plans/04 §2.4）：yaml 显式声明 developer role → role:"developer"
    // （不再走 openrouter URL / 模型前缀启发式；supports_developer_role 是唯一开关）
    let compat = WireCompat {
        vendor: Some("openrouter"),
        thinking_format: None,
        supports_developer_role: true,
    };
    let messages = to_chat_messages_with_compat(
        Some("系统提示"),
        &[user_msg(vec![text_block("hi")])],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
        compat,
    );
    assert_eq!(messages[0].role, "developer");
    assert_eq!(
        messages[0].content,
        Some(ChatContent::Text("系统提示".to_string()))
    );
}

#[test]
fn developer_role_openai_prefix_reasoning_uses_developer() {
    // 同上：supports_developer_role=true → developer（与 vendor/前缀无关）
    let compat = WireCompat {
        vendor: Some("openrouter"),
        thinking_format: None,
        supports_developer_role: true,
    };
    let messages = to_chat_messages_with_compat(
        Some("系统提示"),
        &[user_msg(vec![text_block("hi")])],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
        compat,
    );
    assert_eq!(messages[0].role, "developer");
}

#[test]
fn developer_role_not_reasoning_or_not_openrouter_uses_system() {
    // 未显式声明 supports_developer_role → role:"system"
    let cases: Vec<WireCompat<'static>> = vec![
        WireCompat {
            vendor: Some("openrouter"),
            thinking_format: None,
            supports_developer_role: false,
        },
        WireCompat {
            vendor: Some("anthropic"),
            thinking_format: None,
            supports_developer_role: false,
        },
        WireCompat::default(),
    ];
    for (i, compat) in cases.iter().enumerate() {
        let messages = to_chat_messages_with_compat(
            Some("系统提示"),
            &[user_msg(vec![text_block("hi")])],
            ReasoningContentMode::Omit,
            SystemPromptWireMode::NativeSystemRole,
            *compat,
        );
        assert_eq!(messages[0].role, "system", "case {i} 应恒 role:system");
    }

    // user-prefix 模式恒 role:"user"，不做 developer 判定
    let messages = to_chat_messages_with_compat(
        Some("系统提示"),
        &[user_msg(vec![text_block("hi")])],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::UserPrefix,
        WireCompat {
            vendor: Some("openrouter"),
            thinking_format: None,
            supports_developer_role: true,
        },
    );
    assert_eq!(messages[0].role, "user");
}

#[test]
fn wire_compat_deepseek_inference() {
    // WireCompat::is_deepseek：vendor / thinking_format 命中 deepseek（精确判定，无 URL 盲猜）
    assert!(WireCompat {
        vendor: Some("deepseek"),
        ..WireCompat::default()
    }
    .is_deepseek());
    assert!(WireCompat {
        vendor: Some("DeepSeek"),
        ..WireCompat::default()
    }
    .is_deepseek());
    assert!(WireCompat {
        thinking_format: Some("deepseek"),
        ..WireCompat::default()
    }
    .is_deepseek());
    // 非 DeepSeek / 缺省 → false
    assert!(!WireCompat::default().is_deepseek());
    assert!(!WireCompat {
        vendor: Some("openai"),
        ..WireCompat::default()
    }
    .is_deepseek());
}

#[test]
fn compat_entry_is_byte_identical_to_legacy_entry_on_default() {
    // 缺省 WireCompat 的 compat 入口与既有四参入口逐字节一致（回归：compat
    // 消费面不改变既有无关路径的请求形状）
    let msgs = vec![
        user_msg(vec![text_block("你好")]),
        assistant_msg(vec![
            text_block("回复"),
            tool_call_block("call_1", "read_file", json!({ "path": "/a" })),
        ]),
        message(
            AgentMessageRole::Tool,
            vec![tool_result_block("call_1", ToolOutput::text("结果"))],
        ),
    ];
    let legacy = to_chat_messages(
        Some("全局提示"),
        &msgs,
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    let compat = to_chat_messages_with_compat(
        Some("全局提示"),
        &msgs,
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
        WireCompat::default(),
    );
    assert_eq!(
        legacy, compat,
        "缺省 compat 与既有入口 wire 投影必须逐字节一致"
    );
}

#[test]
fn assistant_with_tool_call_and_result_blocks_emits_both_on_wire() {
    // 历史水合兜底（OpenAI/TokenHub 400001 根因修复）：
    // 当 assistant 消息内同时携带 ToolCall 与 ToolResult 块时，
    // wire 层必须保证 assistant 消息后立即发出对应的 role: "tool" 消息。
    let msgs = vec![
        user_msg(vec![text_block("查看文件")]),
        assistant_msg(vec![
            text_block("我来查看"),
            tool_call_block("call_read_1", "read_file", json!({ "path": "a.txt" })),
            tool_result_block("call_read_1", ToolOutput::text("file content")),
        ]),
        user_msg(vec![text_block("谢谢")]),
    ];
    let wire = to_chat_messages(
        None,
        &msgs,
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert_eq!(wire.len(), 4);
    assert_eq!(wire[0].role, "user");
    assert_eq!(wire[1].role, "assistant");
    assert_eq!(wire[1].tool_calls.len(), 1);
    assert_eq!(wire[1].tool_calls[0]["id"], "call_read_1");
    // tool 消息必须紧随 assistant 出现
    assert_eq!(wire[2].role, "tool");
    assert_eq!(wire[2].tool_call_id.as_deref(), Some("call_read_1"));
    assert_eq!(
        wire[2].content,
        Some(ChatContent::Text("file content".to_string()))
    );
    // 新用户消息在 tool 消息后正常到达
    assert_eq!(wire[3].role, "user");
}

#[test]
fn responses_api_assistant_with_tool_call_and_result_blocks() {
    let msgs = vec![
        assistant_msg(vec![
            text_block("查看文件"),
            tool_call_block("call_read_1", "read_file", json!({ "path": "a.txt" })),
            tool_result_block("call_read_1", ToolOutput::text("file content")),
        ]),
        user_msg(vec![text_block("谢谢")]),
    ];
    let items = to_responses_input_items(
        &msgs,
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    let types: Vec<&str> = items
        .iter()
        .filter_map(|i| i.get("type").and_then(|t| t.as_str()))
        .collect();
    assert_eq!(
        types,
        vec![
            "message",
            "function_call",
            "function_call_output",
            "message"
        ]
    );
    assert_eq!(items[1]["call_id"], "call_read_1");
    assert_eq!(items[2]["call_id"], "call_read_1");
    assert_eq!(items[2]["output"], "file content");
}
