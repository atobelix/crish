//! request/messages.rs 测试旁挂（SR-06e · 拆分 · ≠ EL；经 #[path] 接线，非直接 mod）
//!
//! 原 messages.rs `mod tests` 整段搬入，零删除零合并；测试名与断言形状不变。

use super::*;
use conex_types::message::ToolCallBlock;
use conex_types::tool::{ToolArtifact, ToolOutput};

/// 便捷构造消息
fn message(role: AgentMessageRole, blocks: Vec<AgentMessageBlock>) -> AgentMessage {
    AgentMessage {
        id: format!("m-{role:?}"),
        role,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        blocks,
        metadata: None,
        client_message_id: None,
        content: None,
    }
}

fn text_block(text: &str) -> AgentMessageBlock {
    AgentMessageBlock::Text {
        text: text.to_string(),
    }
}

fn user_msg(blocks: Vec<AgentMessageBlock>) -> AgentMessage {
    message(AgentMessageRole::User, blocks)
}

fn assistant_msg(blocks: Vec<AgentMessageBlock>) -> AgentMessage {
    message(AgentMessageRole::Assistant, blocks)
}

fn tool_call_block(id: &str, name: &str, input: Value) -> AgentMessageBlock {
    AgentMessageBlock::ToolCall(ToolCallBlock {
        id: id.to_string(),
        tool_name: name.to_string(),
        input,
    })
}

fn tool_result_block(tool_call_id: &str, output: ToolOutput) -> AgentMessageBlock {
    AgentMessageBlock::ToolResult {
        tool_call_id: tool_call_id.to_string(),
        tool_name: "read_file".to_string(),
        output,
        is_error: false,
    }
}

/// 断言消息 role 与 content（字符串形态）
fn assert_text_content(messages: &[ChatMessage], index: usize, role: &str, content: &str) {
    assert_eq!(messages[index].role, role);
    assert_eq!(
        messages[index].content,
        Some(ChatContent::Text(content.to_string()))
    );
}

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

// ── 多模态 contentParts ──

#[test]
fn user_content_parts_used_when_image_present() {
    let mut msg = user_msg(vec![text_block("正文文本")]);
    msg.metadata = Some(json!({
        "contentParts": [
            { "type": "text", "text": "看图说话" },
            { "type": "image_url", "image_url": { "url": "https://example.com/a.png", "detail": "high" } },
        ]
    }));
    let messages = to_chat_messages(
        None,
        &[msg],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert_eq!(
        messages[0].content,
        Some(ChatContent::Parts(vec![
            ChatContentPart::Text {
                text: "看图说话".to_string(),
                cache_control: None
            },
            ChatContentPart::ImageUrl {
                url: "https://example.com/a.png".to_string(),
                detail: Some("high".to_string()),
            },
        ]))
    );
    let value = messages[0].to_value();
    assert_eq!(value["content"][0]["type"], "text");
    assert_eq!(
        value["content"][1]["image_url"]["url"],
        "https://example.com/a.png"
    );
}

#[test]
fn user_content_parts_text_only_degrades_to_plain_text() {
    let mut msg = user_msg(vec![text_block("正文")]);
    msg.metadata = Some(json!({
        "contentParts": [{ "type": "text", "text": "只有文本" }]
    }));
    let messages = to_chat_messages(
        None,
        &[msg],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    // 无图片 → 退回 blocks 纯文本（对齐 TS hasImage 判定）
    assert_text_content(&messages, 0, "user", "正文");
}

#[test]
fn user_content_parts_image_url_flat_variant() {
    let mut msg = user_msg(vec![]);
    msg.metadata = Some(json!({
        "contentParts": [{ "type": "image_url", "url": "https://example.com/b.png" }]
    }));
    let messages = to_chat_messages(
        None,
        &[msg],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    match &messages[0].content {
        Some(ChatContent::Parts(parts)) => {
            assert_eq!(parts.len(), 1);
            match &parts[0] {
                ChatContentPart::ImageUrl { url, detail } => {
                    assert_eq!(url, "https://example.com/b.png");
                    assert_eq!(*detail, None);
                }
                other => panic!("期望 image part，得到：{other:?}"),
            }
        }
        other => panic!("期望 parts 内容，得到：{other:?}"),
    }
}

#[test]
fn strip_inline_data_urls_removes_base64_payloads() {
    let text = "看图 data:image/png;base64,iVBORw0KGgo= 之后";
    assert_eq!(strip_inline_data_urls(text), "看图 [image] 之后");
    // markdown 图片语法
    let text = "![alt](data:image/jpeg;base64,AAAA) 结尾";
    assert_eq!(strip_inline_data_urls(text), "![alt]([image]) 结尾");
}

#[test]
fn strip_inline_data_urls_keeps_plain_text() {
    assert_eq!(strip_inline_data_urls(""), "");
    assert_eq!(strip_inline_data_urls("没有图片"), "没有图片");
    // 非 base64 的 data url 原样保留
    assert_eq!(
        strip_inline_data_urls("data:text/plain;charset=utf-8,hi"),
        "data:text/plain;charset=utf-8,hi"
    );
}

#[test]
fn wire_value_shape() {
    let messages = to_chat_messages(
        None,
        &[assistant_msg(vec![text_block("回复")])],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    let value = messages[0].to_value();
    assert_eq!(value["role"], "assistant");
    assert_eq!(value["content"], "回复");
    assert!(value.get("tool_call_id").is_none());
    assert!(value.get("reasoning_content").is_none());
    assert!(value.get("tool_calls").is_none());
}

// ── P2：cache_control 载体字段与序列化（T-14）──

/// 便捷构造 user wire 消息（cache_control 恒 None，构造点补齐语义）
fn wire_user(content: &str) -> ChatMessage {
    ChatMessage {
        role: "user".to_string(),
        content: Some(ChatContent::Text(content.to_string())),
        tool_call_id: None,
        reasoning_content: None,
        tool_calls: Vec::new(),
        cache_control: None,
    }
}

#[test]
fn text_part_cache_control_omitted_when_none() {
    // None → 序列化省略 cache_control 键（与 P2 前 wire 字节一致）
    let part = ChatContentPart::Text {
        text: "hi".to_string(),
        cache_control: None,
    };
    assert_eq!(part.to_value(), json!({ "type": "text", "text": "hi" }));
}

#[test]
fn text_part_cache_control_serialized_when_some() {
    // Some → 输出块级断点键（Anthropic 系 wire 值）
    let part = ChatContentPart::Text {
        text: "hi".to_string(),
        cache_control: Some(CacheControl::Ephemeral),
    };
    assert_eq!(
        part.to_value(),
        json!({ "type": "text", "text": "hi", "cache_control": { "type": "ephemeral" } })
    );
    // Ephemeral1h → 带 ttl 键
    let part = ChatContentPart::Text {
        text: "hi".to_string(),
        cache_control: Some(CacheControl::Ephemeral1h),
    };
    assert_eq!(
        part.to_value()["cache_control"],
        json!({ "type": "ephemeral", "ttl": "1h" })
    );
}

#[test]
fn message_cache_control_omitted_when_none() {
    // 消息级 None → 不输出 cache_control 键
    let value = wire_user("hi").to_value();
    assert!(
        value.get("cache_control").is_none(),
        "None 不得输出 cache_control 键"
    );
}

#[test]
fn message_cache_control_serialized_when_some() {
    // 消息级 Some → 输出 `"cache_control":{"type":"ephemeral"}`（原生端点顶层载体）
    let message = wire_user("hi").with_cache_control(CacheControl::Ephemeral);
    let value = message.to_value();
    assert_eq!(value["cache_control"], json!({ "type": "ephemeral" }));
    assert_eq!(value["content"], "hi", "消息级断点不改写内容");
}

#[test]
fn with_cache_control_helpers() {
    // part 级：文本 part 挂断点；非文本 part 原样返回自身
    let part = ChatContentPart::Text {
        text: "hi".to_string(),
        cache_control: None,
    }
    .with_cache_control(CacheControl::Ephemeral);
    assert_eq!(
        part,
        ChatContentPart::Text {
            text: "hi".to_string(),
            cache_control: Some(CacheControl::Ephemeral),
        }
    );
    let image = ChatContentPart::ImageUrl {
        url: "https://example.com/a.png".to_string(),
        detail: None,
    };
    assert_eq!(
        image.clone().with_cache_control(CacheControl::Ephemeral),
        image,
        "非文本 part 原样返回"
    );
    // 消息级：设置 cache_control 字段
    let message = wire_user("hi").with_cache_control(CacheControl::Ephemeral1h);
    assert_eq!(message.cache_control, Some(CacheControl::Ephemeral1h));
}

// ── to_responses_input_items（DEEPCHECK-05 #10：Responses 轨 input items）──

/// 构造带思考的 assistant 消息（Require 模式回传断言用）
fn assistant_with_thought(text: &str, thought: &str) -> AgentMessage {
    let mut message = assistant_msg(vec![text_block(text)]);
    message.metadata = Some(serde_json::json!({ "thought": thought }));
    message
}

#[test]
fn responses_input_basic_message_items() {
    // user → message item（content 字符串）；system → message item（role=system）
    let items = to_responses_input_items(
        &[
            user_msg(vec![text_block("你好")]),
            message(AgentMessageRole::System, vec![text_block("系统指令")]),
        ],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert_eq!(items.len(), 2);
    assert_eq!(
        items[0],
        json!({ "type": "message", "role": "user", "content": "你好" })
    );
    assert_eq!(
        items[1],
        json!({ "type": "message", "role": "system", "content": "系统指令" })
    );
}

#[test]
fn responses_input_tool_loop_items() {
    // 工具循环：assistant（文本 + tool_call）→ tool 结果 → function_call 与
    // function_call_output items 分开（Responses 形状；arguments canonical 序列化）
    let assistant = assistant_msg(vec![
        text_block("我来查"),
        tool_call_block("call_1", "read_file", json!({ "zeta": 1, "alpha": 2 })),
    ]);
    let tool = message(
        AgentMessageRole::Tool,
        vec![tool_result_block("call_1", ToolOutput::text("文件内容"))],
    );
    let items = to_responses_input_items(
        &[assistant, tool],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert_eq!(items.len(), 3);
    assert_eq!(
        items[0],
        json!({ "type": "message", "role": "assistant", "content": "我来查" })
    );
    assert_eq!(
        items[1],
        json!({
            "type": "function_call",
            "call_id": "call_1",
            "name": "read_file",
            "arguments": r#"{"alpha":2,"zeta":1}"#,
        })
    );
    assert_eq!(
        items[2],
        json!({
            "type": "function_call_output",
            "call_id": "call_1",
            "output": "文件内容",
        })
    );
}

#[test]
fn responses_input_assistant_only_tool_calls_skips_message_item() {
    // 无文本纯工具调用 → 不发空 message item，只发 function_call items
    let assistant = assistant_msg(vec![tool_call_block("c1", "search", json!({}))]);
    let items = to_responses_input_items(
        &[assistant],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["type"], "function_call");
    assert_eq!(items[0]["call_id"], "c1");
}

#[test]
fn responses_input_reasoning_item_before_message() {
    // Require 模式 + 有思考内容 → reasoning item 先于 message item（对齐
    // OpenAI response.output 顺序）；Omit 模式 → 无 reasoning item
    let assistant = assistant_with_thought("正文", "思考摘要");
    let items = to_responses_input_items(
        &[assistant],
        ReasoningContentMode::Require,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert_eq!(items.len(), 2);
    assert_eq!(
        items[0],
        json!({ "type": "reasoning", "content": "思考摘要" })
    );
    assert_eq!(items[1]["type"], "message");
    assert_eq!(items[1]["role"], "assistant");

    let items = to_responses_input_items(
        &[assistant_with_thought("正文", "思考摘要")],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert_eq!(items.len(), 1, "Omit 模式不得发 reasoning item");
    assert_eq!(items[0]["type"], "message");
}

#[test]
fn responses_input_empty_assistant_skipped() {
    // 无文本 / 无工具调用 / 无思考 → 整条跳过（与 chat 轨 continue 同语义）
    let assistant = assistant_msg(Vec::new());
    let items = to_responses_input_items(
        &[assistant],
        ReasoningContentMode::Require,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert!(items.is_empty(), "空 assistant 消息不得产出 items");
}

#[test]
fn responses_input_user_prefix_rewrites_system_role() {
    // wire_mode=user-prefix: system message rewritten to user + prefix (same as chat rail)
    let items = to_responses_input_items(
        &[message(AgentMessageRole::System, vec![text_block("指令")])],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::UserPrefix,
    );
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["type"], "message");
    assert_eq!(items[0]["role"], "user");
    assert_eq!(
        items[0]["content"],
        "System instructions for this run:\n\n指令"
    );
}

#[test]
fn responses_input_multimodal_parts() {
    // metadata.contentParts 含 image_url → parts 数组（input_text / input_image）
    let mut user = user_msg(vec![text_block("看图")]);
    user.metadata = Some(serde_json::json!({
        "contentParts": [
            { "type": "text", "text": "看图" },
            { "type": "image_url", "image_url": { "url": "https://example.com/a.png", "detail": "high" } },
        ],
    }));
    let items = to_responses_input_items(
        &[user],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["type"], "message");
    assert_eq!(items[0]["role"], "user");
    assert_eq!(
        items[0]["content"],
        json!([
            { "type": "input_text", "text": "看图" },
            { "type": "input_image", "image_url": "https://example.com/a.png", "detail": "high" },
        ])
    );
}

#[test]
fn responses_input_tool_call_id_sanitized() {
    // 非法 id 字符消毒（与 chat 轨 tool_calls 同口径，P1）
    let assistant = assistant_msg(vec![tool_call_block("a/b:c", "read_file", json!({}))]);
    let items = to_responses_input_items(
        &[assistant],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert_eq!(items[0]["call_id"], "a_b_c");
}

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

// ── W04：出站成对性 Fail-Closed 守门（详案 02 §3.4 轨二）──
// 检测函数 detect_chat_unpaired_tool_calls 为纯只读面，任何构建模式下均可
// 直接断言孤儿 ID；validate_* 的 panic/Err 分级行为见注释。

/// 成对完整对话经 to_chat_messages 投影后：detect 返回空
#[test]
fn chat_pairing_gate_paired_conversation_passes() {
    let messages = to_chat_messages(
        None,
        &[
            user_msg(vec![text_block("读文件")]),
            assistant_msg(vec![
                text_block("好的"),
                tool_call_block("call_1", "read_file", json!({})),
            ]),
            message(
                AgentMessageRole::Tool,
                vec![tool_result_block("call_1", ToolOutput::text("内容"))],
            ),
        ],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert!(
        detect_chat_unpaired_tool_calls(&messages).is_empty(),
        "成对完整对话不应检出孤儿：{messages:?}"
    );
}

/// 孤儿 tool_calls（assistant 有 tool_calls、缺 role:"tool" 结果消息）：
/// detect 返回排序后的孤儿 ID 列表。
/// 注意：不得经 build_chat_completions_request_body——Debug 下其内部守门
/// panic（Fail-Fast）；Release 下拒绝组包。校验 API 面即 validate_*/detect_*。
#[test]
fn chat_pairing_gate_detects_orphan_tool_calls() {
    let messages = to_chat_messages(
        None,
        &[
            user_msg(vec![text_block("读文件")]),
            assistant_msg(vec![
                text_block("好的"),
                tool_call_block("call_orphan", "read_file", json!({})),
            ]),
            // 故意缺失 role:Tool 结果消息
        ],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    let orphans = detect_chat_unpaired_tool_calls(&messages);
    assert_eq!(orphans, ["call_orphan"]);
}

/// 多孤儿 ID 排序稳定（BTreeSet 语义）：补齐重试路径依赖确定顺序逐 ID 对账
#[test]
fn chat_pairing_gate_orphan_ids_sorted_stable() {
    let messages = to_chat_messages(
        None,
        &[
            assistant_msg(vec![
                tool_call_block("call_z", "a", json!({})),
                tool_call_block("call_a", "b", json!({})),
                tool_call_block("call_m", "c", json!({})),
            ]),
            message(
                AgentMessageRole::Tool,
                vec![tool_result_block("call_m", ToolOutput::text("ok"))],
            ),
        ],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    let orphans = detect_chat_unpaired_tool_calls(&messages);
    assert_eq!(orphans, ["call_a", "call_z"]);
}

/// 部分闭合：同批次多 tool_calls 仅一条被 tool 消息回答 → 仅余孤儿进列表
#[test]
fn chat_pairing_gate_partial_closure_leaves_only_unanswered() {
    let messages = to_chat_messages(
        None,
        &[
            assistant_msg(vec![
                tool_call_block("call_done", "a", json!({})),
                tool_call_block("call_open", "b", json!({})),
            ]),
            message(
                AgentMessageRole::Tool,
                vec![tool_result_block("call_done", ToolOutput::text("ok"))],
            ),
        ],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    let orphans = detect_chat_unpaired_tool_calls(&messages);
    assert_eq!(orphans, ["call_open"]);
}

/// validate 对孤儿返回 Err(UnpairedToolCalls) 并记录结构化日志（Debug 与 Release 统一行为）。
#[test]
fn chat_pairing_gate_validate_returns_err_on_orphan() {
    let orphan_msg = ChatMessage {
        role: "assistant".to_string(),
        content: None,
        tool_call_id: None,
        reasoning_content: None,
        tool_calls: vec![json!({
            "id": "call_x",
            "type": "function",
            "function": { "name": "a", "arguments": "{}" }
        })],
        cache_control: None,
    };
    let res = validate_chat_tool_pairing(&[orphan_msg]);
    match res {
        Err(RequestBuildError::UnpairedToolCalls { protocol, orphan_ids }) => {
            assert_eq!(protocol, "openai_chat");
            assert_eq!(orphan_ids, vec!["call_x"]);
        }
        other => panic!("期望 UnpairedToolCalls 错误，得到：{other:?}"),
    }
}

/// validate_chat_pairing_from_messages 对孤儿返回 Err(UnpairedToolCalls)
#[test]
fn chat_pairing_from_messages_returns_err_on_orphan() {
    let orphan_call = AgentMessage {
        id: "a1".to_string(),
        role: AgentMessageRole::Assistant,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        blocks: vec![AgentMessageBlock::ToolCall(ToolCallBlock {
            id: "call_y".to_string(),
            tool_name: "test_tool".to_string(),
            input: json!({}),
        })],
        metadata: None,
        client_message_id: None,
        content: None,
    };
    let user_message = AgentMessage {
        id: "u1".to_string(),
        role: AgentMessageRole::User,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        blocks: vec![AgentMessageBlock::Text {
            text: "hello".to_string(),
        }],
        metadata: None,
        client_message_id: None,
        content: None,
    };
    let messages = vec![std::sync::Arc::new(user_message), std::sync::Arc::new(orphan_call)];
    let res = validate_chat_pairing_from_messages(None, &messages);
    match res {
        Err(RequestBuildError::UnpairedToolCalls { protocol, orphan_ids }) => {
            assert_eq!(protocol, "openai_chat");
            assert_eq!(orphan_ids, vec!["call_y"]);
        }
        other => panic!("期望 UnpairedToolCalls 错误，得到：{other:?}"),
    }
}
