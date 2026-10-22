//! messages 测试 · to_responses_input_items（Responses 轨 input items）

use super::*;

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
