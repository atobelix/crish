//! messages 测试 · 出站成对性 Fail-Closed 守门

use super::*;

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
        Err(RequestBuildError::UnpairedToolCalls {
            protocol,
            orphan_ids,
        }) => {
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
    let messages = vec![
        std::sync::Arc::new(user_message),
        std::sync::Arc::new(orphan_call),
    ];
    let res = validate_chat_pairing_from_messages(None, &messages);
    match res {
        Err(RequestBuildError::UnpairedToolCalls {
            protocol,
            orphan_ids,
        }) => {
            assert_eq!(protocol, "openai_chat");
            assert_eq!(orphan_ids, vec!["call_y"]);
        }
        other => panic!("期望 UnpairedToolCalls 错误，得到：{other:?}"),
    }
}
