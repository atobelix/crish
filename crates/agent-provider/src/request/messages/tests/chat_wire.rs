//! messages 测试 · 角色映射 / system prompt / tool result / wire 清洗 / assistant / reasoning / tool_call 消毒

use super::*;

// ── 角色映射与内容 ──

#[test]
fn roles_map_to_wire() {
    let messages = to_chat_messages(
        None,
        &[
            user_msg(vec![text_block("你好")]),
            assistant_msg(vec![text_block("回复")]),
            message(AgentMessageRole::System, vec![text_block("系统指令")]),
            message(
                AgentMessageRole::Tool,
                vec![tool_result_block("call_1", ToolOutput::text("结果"))],
            ),
        ],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert_eq!(messages.len(), 4);
    assert_text_content(&messages, 0, "user", "你好");
    assert_text_content(&messages, 1, "assistant", "回复");
    assert_text_content(&messages, 2, "system", "系统指令");
    // tool 结果消息
    assert_eq!(messages[3].role, "tool");
    assert_eq!(messages[3].tool_call_id.as_deref(), Some("call_1"));
    assert_eq!(
        messages[3].content,
        Some(ChatContent::Text("结果".to_string()))
    );
    assert_eq!(messages[3].tool_calls, Vec::<Value>::new());
}

#[test]
fn system_prompt_prepends_system_message() {
    let messages = to_chat_messages(
        Some("全局提示词"),
        &[user_msg(vec![text_block("hi")])],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert_eq!(messages.len(), 2);
    assert_text_content(&messages, 0, "system", "全局提示词");
    assert_text_content(&messages, 1, "user", "hi");
}

#[test]
fn empty_system_prompt_is_omitted() {
    let messages = to_chat_messages(
        Some("   "),
        &[user_msg(vec![text_block("hi")])],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert_eq!(messages.len(), 1);
    assert_text_content(&messages, 0, "user", "hi");
}

#[test]
fn user_prefix_rewrites_system_prompt_and_system_messages() {
    // 02 §六.11：user-prefix wireMode 改写 role 与文案
    let messages = to_chat_messages(
        Some("全局提示词"),
        &[message(
            AgentMessageRole::System,
            vec![text_block("消息内系统指令")],
        )],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::UserPrefix,
    );
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].role, "user");
    assert_eq!(
        messages[0].content,
        Some(ChatContent::Text(
            "System instructions for this run:\n\n全局提示词".to_string()
        ))
    );
    assert_eq!(messages[1].role, "user");
    assert_eq!(
        messages[1].content,
        Some(ChatContent::Text(
            "System instructions for this run:\n\n消息内系统指令".to_string()
        ))
    );
}

#[test]
fn system_prompt_as_user_prefix_trims_input() {
    assert_eq!(
        system_prompt_as_user_prefix("  带空白的提示  "),
        "System instructions for this run:\n\n带空白的提示"
    );
}

#[test]
fn each_tool_result_block_becomes_tool_message() {
    let blocks = vec![
        tool_result_block("call_1", ToolOutput::text("结果一")),
        tool_result_block(
            "call_2",
            ToolOutput {
                text: None,
                json: Some(json!({ "ok": true })),
                artifacts: None,
            },
        ),
    ];
    let messages = to_chat_messages(
        None,
        &[message(AgentMessageRole::Tool, blocks)],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].tool_call_id.as_deref(), Some("call_1"));
    assert_eq!(
        messages[0].content,
        Some(ChatContent::Text("结果一".to_string()))
    );
    assert_eq!(messages[1].tool_call_id.as_deref(), Some("call_2"));
    assert_eq!(
        messages[1].content,
        Some(ChatContent::Text(json!({ "ok": true }).to_string()))
    );
}

#[test]
fn tool_output_stringify_precedence() {
    // text → json → artifacts → ''
    let text = ToolOutput::text("纯文本");
    assert_eq!(stringify_tool_output(&text), "纯文本");
    let json = ToolOutput {
        text: None,
        json: Some(json!({ "a": 1 })),
        artifacts: None,
    };
    assert_eq!(stringify_tool_output(&json), r#"{"a":1}"#);
    let artifacts = ToolOutput {
        text: None,
        json: None,
        artifacts: Some(vec![ToolArtifact {
            kind: conex_types::tool::ToolArtifactKind::File,
            title: "t".to_string(),
            uri: Some("file:///a".to_string()),
            text: None,
            metadata: None,
        }]),
    };
    assert!(stringify_tool_output(&artifacts).contains("file:///a"));
    assert_eq!(stringify_tool_output(&ToolOutput::empty()), "");
}

/// T-34（R-J）：wire 投影面统一清洗——ToolResult 文本经 clean_output
/// 管线（R1 ANSI 剥离 / R3 空行合并 / R4 重复行折叠 / R5 超长行截断），
/// wire content 为清洗后字节
#[test]
fn wire_tool_output_is_cleaned() {
    let raw = "\x1b[31merror: build failed\x1b[0m\n\n\nwarning: unused\nwarning: unused\nwarning: unused\n这条行非常非常长";
    let messages = to_chat_messages(
        None,
        &[message(
            AgentMessageRole::Tool,
            vec![tool_result_block("call_1", ToolOutput::text(raw))],
        )],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    let Some(ChatContent::Text(wire)) = &messages[0].content else {
        panic!("tool wire content 必须为文本");
    };
    // R1：ANSI 剥离（正文保留）
    assert!(!wire.contains('\x1b'), "ANSI 序列必须剥离：{wire}");
    assert!(
        wire.contains("error: build failed"),
        "ANSI 包裹的正文剥离后保留"
    );
    // R3：连续空行合并
    assert!(!wire.contains("\n\n\n"), "连续空行必须合并：{wire}");
    // R4：重复行折叠（3+ 连续相等行 → 标记）
    assert!(
        !wire.contains("warning: unused\nwarning: unused\nwarning: unused"),
        "重复行必须折叠"
    );
    assert!(
        wire.contains("… 重复 2 行 …"),
        "重复行折叠标记必须出现：{wire}"
    );
    // R5：超长行截断（默认 120 字符 + 省略号）
    assert!(
        wire.lines().all(|l| l.chars().count() <= 120),
        "超长行必须截断到 120 字符：{wire}"
    );
}

/// T-34（R-J）：清洗确定性 + 幂等——同输入两次 to_chat_messages 的
/// wire 字节完全一致（历史回放与新增消息同路径，无前缀漂移）
#[test]
fn wire_cleaning_is_deterministic_and_byte_stable() {
    let raw = "\x1b[90mline1\x1b[0m\n\n\nline2\nline2\nline2\n".repeat(2);
    let msg = message(
        AgentMessageRole::Tool,
        vec![tool_result_block("call_1", ToolOutput::text(&raw))],
    );
    let first = to_chat_messages(
        None,
        std::slice::from_ref(&msg),
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    let second = to_chat_messages(
        None,
        &[msg],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert_eq!(
        first, second,
        "同输入两次 wire 投影必须字节一致（确定性 + 幂等）"
    );
    let ser_first = serde_json::to_string(&first[0].to_value()).expect("序列化");
    let ser_second = serde_json::to_string(&second[0].to_value()).expect("序列化");
    assert_eq!(
        ser_first, ser_second,
        "序列化字节必须一致（历史回放与新增同路径）"
    );
}

/// T-34（R-J）：消息本体保持 raw——清洗只发生在 wire 投影面，落库/
/// 事件/工具返回的 AgentMessage 原文不被修改（不污染共享 Arc）
#[test]
fn wire_cleaning_keeps_message_body_raw() {
    let raw = "\x1b[31mraw\x1b[0m\n\n\nx\nx\nx\n".repeat(3);
    let msg = message(
        AgentMessageRole::Tool,
        vec![tool_result_block("call_1", ToolOutput::text(&raw))],
    );
    let _ = to_chat_messages(
        None,
        std::slice::from_ref(&msg),
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    // 消息本体逐字节不变（清洗不落到记录面）
    let AgentMessageBlock::ToolResult { output, .. } = &msg.blocks[0] else {
        panic!("必须为 ToolResult 块");
    };
    assert_eq!(
        output.text.as_deref(),
        Some(raw.as_str()),
        "消息本体必须保持 raw（清洗只发生在 wire 投影面，R-J）"
    );
}

#[test]
fn assistant_message_carries_tool_calls() {
    let messages = to_chat_messages(
        None,
        &[assistant_msg(vec![
            text_block("正文"),
            tool_call_block("call_1", "read_file", json!({ "path": "/a" })),
        ])],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert_eq!(messages.len(), 1);
    assert_eq!(
        messages[0].content,
        Some(ChatContent::Text("正文".to_string()))
    );
    assert_eq!(messages[0].tool_calls.len(), 1);
    let call = &messages[0].tool_calls[0];
    assert_eq!(call["id"], "call_1");
    assert_eq!(call["type"], "function");
    assert_eq!(call["function"]["name"], "read_file");
    assert_eq!(call["function"]["arguments"], r#"{"path":"/a"}"#);
}

#[test]
fn assistant_without_content_emits_empty_string_content() {
    let messages = to_chat_messages(
        None,
        &[assistant_msg(vec![tool_call_block(
            "call_1",
            "noop",
            json!({}),
        )])],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].role, "assistant");
    assert_eq!(
        messages[0].content, None,
        "领域模型 content 仍为 None（wire 层才回写空串）"
    );
    assert_eq!(messages[0].tool_calls.len(), 1);
    let value = messages[0].to_value();
    // G5-b（T2.2）：空文本 assistant → wire `content:""`（非 null，契约 M8）
    assert_eq!(value["content"], "");
}

#[test]
fn empty_assistant_message_is_skipped() {
    // 无正文、无工具调用、无思考 → 整条跳过（对齐 TS continue）
    let messages = to_chat_messages(
        None,
        &[assistant_msg(vec![]), user_msg(vec![text_block("hi")])],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert_eq!(messages.len(), 1);
    assert_text_content(&messages, 0, "user", "hi");
}

#[test]
fn reasoning_content_include_mode_attaches_thought() {
    // Include 模式：thought block 拼接为 reasoning_content
    let msg = message(
        AgentMessageRole::Assistant,
        vec![AgentMessageBlock::Thought {
            text: "推理过程".to_string(),
            redacted: None,
        }],
    );
    let messages = to_chat_messages(
        None,
        &[msg],
        ReasoningContentMode::Include,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].reasoning_content.as_deref(), Some("推理过程"));

    // Omit 模式：不回传；纯思考消息无正文/工具调用/思考回传 → 整条跳过（对齐 TS continue）
    let messages = to_chat_messages(
        None,
        &[message(
            AgentMessageRole::Assistant,
            vec![AgentMessageBlock::Thought {
                text: "推理过程".to_string(),
                redacted: None,
            }],
        )],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert!(messages.is_empty(), "omit 模式下纯思考消息整条跳过");
}

#[test]
fn reasoning_content_falls_back_to_metadata_thought() {
    let mut msg = assistant_msg(vec![]);
    msg.metadata = Some(json!({ "thought": "元数据思考" }));
    let messages = to_chat_messages(
        None,
        &[msg],
        ReasoningContentMode::Include,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert_eq!(messages[0].reasoning_content.as_deref(), Some("元数据思考"));
}

// ── P1：tool_call id 消毒与 arguments 规范化 ──

#[test]
fn sanitize_tool_call_id_replaces_invalid_chars_and_is_idempotent() {
    // 非法字符（空格/斜杠/点号）替换为下划线；合法字符保留
    assert_eq!(sanitize_tool_call_id("a b/c"), "a_b_c");
    assert_eq!(sanitize_tool_call_id("call.1"), "call_1");
    assert_eq!(sanitize_tool_call_id("call_1-2"), "call_1-2");
    // 幂等：二次消毒结果不变（历史字节不回改）
    let once = sanitize_tool_call_id("a b/c");
    assert_eq!(sanitize_tool_call_id(&once), once);
    // 空串 → 空串
    assert_eq!(sanitize_tool_call_id(""), "");
}

#[test]
fn sanitize_tool_call_id_preserves_whitelist_chars() {
    // 白名单 [a-zA-Z0-9_-] 全部保留，含大小写字母与数字
    assert_eq!(sanitize_tool_call_id("ABCdef_012-9"), "ABCdef_012-9");
    // 非 ASCII 字符（中文/全角）视为非法 → 下划线
    assert_eq!(sanitize_tool_call_id("call_中文"), "call___");
}

#[test]
fn tool_call_ids_are_sanitized_on_wire() {
    // assistant 分支：tool_calls[].id 消毒
    let messages = to_chat_messages(
        None,
        &[assistant_msg(vec![tool_call_block(
            "call 1/2",
            "noop",
            json!({}),
        )])],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert_eq!(messages[0].tool_calls[0]["id"], "call_1_2");

    // tool 分支：tool_call_id 消毒
    let messages = to_chat_messages(
        None,
        &[message(
            AgentMessageRole::Tool,
            vec![tool_result_block("call 1/2", ToolOutput::text("结果"))],
        )],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert_eq!(messages[0].tool_call_id.as_deref(), Some("call_1_2"));
}

#[test]
fn tool_call_arguments_canonical_serialization() {
    // arguments 使用 canonical_json_string：递归键序确定，
    // 同语义不同插入序的对象输出相同字节
    let input = json!({ "path": "/a", "options": { "z": 1, "a": 2 } });
    let messages = to_chat_messages(
        None,
        &[assistant_msg(vec![tool_call_block(
            "call_1",
            "read_file",
            input.clone(),
        )])],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    let arguments = messages[0].tool_calls[0]["function"]["arguments"]
        .as_str()
        .expect("arguments 必须为字符串");
    assert_eq!(arguments, canonical_json_string(&input));
    assert_eq!(arguments, r#"{"options":{"a":2,"z":1},"path":"/a"}"#);

    // 键序无关：不同插入序构建的等价对象序列化结果相同
    let mut b_first = Map::new();
    b_first.insert("b".to_string(), json!(1));
    b_first.insert("a".to_string(), json!(2));
    let mut a_first = Map::new();
    a_first.insert("a".to_string(), json!(2));
    a_first.insert("b".to_string(), json!(1));
    let messages = to_chat_messages(
        None,
        &[assistant_msg(vec![
            tool_call_block("call_1", "noop", Value::Object(b_first)),
            tool_call_block("call_2", "noop", Value::Object(a_first)),
        ])],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert_eq!(
        messages[0].tool_calls[0]["function"]["arguments"],
        messages[0].tool_calls[1]["function"]["arguments"],
        "不同插入序的等价对象必须序列化为相同字节"
    );
    assert_eq!(
        messages[0].tool_calls[0]["function"]["arguments"],
        r#"{"a":2,"b":1}"#
    );
}

// ── P1：reasoning_content Require 键存在性 ──

#[test]
fn reasoning_content_require_emits_empty_string() {
    // Require 模式 + 无思考 → Some("")，序列化含 "reasoning_content":"" 键
    // （DeepSeek 工具轮次缺键 400 兜底；Reasonix openai.go:669-680）
    let messages = to_chat_messages(
        None,
        &[assistant_msg(vec![text_block("正文")])],
        ReasoningContentMode::Require,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].reasoning_content.as_deref(), Some(""));
    let value = messages[0].to_value();
    assert!(
        value.get("reasoning_content").is_some(),
        "Require 模式必须含 reasoning_content 键"
    );
    assert_eq!(value["reasoning_content"], "");

    // Require 模式有思考 → 原样回传
    let messages = to_chat_messages(
        None,
        &[message(
            AgentMessageRole::Assistant,
            vec![AgentMessageBlock::Thought {
                text: "推理过程".to_string(),
                redacted: None,
            }],
        )],
        ReasoningContentMode::Require,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert_eq!(messages[0].reasoning_content.as_deref(), Some("推理过程"));

    // Omit 模式：不含该键（行为不变）
    let messages = to_chat_messages(
        None,
        &[assistant_msg(vec![text_block("正文")])],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert_eq!(messages[0].reasoning_content, None);
    let value = messages[0].to_value();
    assert!(
        value.get("reasoning_content").is_none(),
        "Omit 模式不得含 reasoning_content 键"
    );
}

#[test]
fn reasoning_content_require_keeps_empty_assistant_message() {
    // Require 模式空思考 → reasoning_content: Some("") 使跳过条件不成立，
    // 空 assistant 消息保留且带键（Omit/Include 下该消息整条跳过）
    let messages = to_chat_messages(
        None,
        &[assistant_msg(vec![])],
        ReasoningContentMode::Require,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].reasoning_content.as_deref(), Some(""));
    assert_eq!(messages[0].content, None);
}
