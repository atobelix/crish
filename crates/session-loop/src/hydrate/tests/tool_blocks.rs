use conex_types::error::codes;
use conex_types::message::{AgentMessageBlock, AgentMessageRole};

use super::super::hydrate_history;
use super::{ids, msg};

#[test]
fn orphan_tool_call_synthesized_as_memory_tool_message() {
    let mut a1 = msg("a1", "assistant", Some("调用工具"), Some("completed"));
    a1.tool_calls_json =
        Some(r#"[{"id":"c1","name":"shell_command","arguments":"{\"command\":\"ls\"}"}]"#.into());
    let history = vec![
        msg("u1", "user", Some("跑一下"), None),
        a1,
        msg("u2", "user", Some("继续"), None),
    ];
    let hydrated = hydrate_history(history);
    assert_eq!(ids(&hydrated), ["u1", "a1", "hydrate-tool-result-c1", "u2"]);
    let tool_msg = &hydrated[2];
    assert_eq!(tool_msg.role, AgentMessageRole::Tool);
    assert!(matches!(
        &tool_msg.blocks[0],
        AgentMessageBlock::ToolResult {
            tool_call_id,
            is_error: true,
            ..
        } if tool_call_id == "c1"
    ));
    let meta = tool_msg.metadata.as_ref().expect("合成消息带标记");
    assert_eq!(
        meta.get("errorCode"),
        Some(&serde_json::json!(codes::TOOL_ABORTED_BEFORE_DISPATCH))
    );
    assert_eq!(meta.get("synthesized"), Some(&serde_json::json!(true)));
}

#[test]
fn paired_tool_call_not_repaired() {
    let mut a1 = msg("a1", "assistant", Some("调用工具"), Some("completed"));
    a1.tool_calls_json = Some(r#"[{"id":"c1","name":"shell_command","arguments":"{}"}]"#.into());
    a1.tool_call_results_json = Some(r#"[{"id":"c1","output":"ok","isError":false}]"#.into());
    let history = vec![
        msg("u1", "user", Some("跑一下"), None),
        a1,
        msg("u2", "user", Some("继续"), None),
    ];
    let hydrated = hydrate_history(history);
    assert_eq!(
        ids(&hydrated),
        ["u1", "a1", "tool-result-c1", "u2"],
        "已配对结果生成为 Tool 角色消息，且不得二次合成孤儿自愈"
    );
    assert_eq!(hydrated[2].role, AgentMessageRole::Tool);
    match &hydrated[2].blocks[0] {
        AgentMessageBlock::ToolResult {
            output, is_error, ..
        } => {
            assert_eq!(output.text.as_deref(), Some("ok"));
            assert!(!is_error);
        }
        _ => panic!("Expected ToolResult"),
    }
}

#[test]
fn orphan_from_blocks_json_repaired() {
    let mut a1 = msg("a1", "assistant", None, Some("completed"));
    a1.blocks_json = Some(
        r#"[{"type":"tool-call","id":"c9","toolName":"shell_command","input":{"command":"ls"}}]"#
            .into(),
    );
    let history = vec![
        msg("u1", "user", Some("q"), None),
        a1,
        msg("u2", "user", Some("继续"), None),
    ];
    let hydrated = hydrate_history(history);
    assert_eq!(ids(&hydrated), ["u1", "a1", "hydrate-tool-result-c9", "u2"]);
    assert_eq!(hydrated[2].role, AgentMessageRole::Tool);
}

#[test]
fn blocks_json_parsed_as_agent_blocks_preferred() {
    let mut h = msg(
        "m1",
        "assistant",
        Some("合成文本不应出现"),
        Some("completed"),
    );
    h.blocks_json = Some(
        r#"[{"type":"text","text":"块保真"},{"type":"thought","text":"思考","redacted":true}]"#
            .into(),
    );
    let history = vec![
        msg("u0", "user", Some("首"), None),
        h,
        msg("tail", "user", Some("确认"), None),
    ];
    let hydrated = hydrate_history(history);
    assert_eq!(hydrated[1].blocks.len(), 2);
    assert_eq!(hydrated[1].text(), "块保真");
    assert_eq!(hydrated[1].thought(), "思考");
    assert_eq!(hydrated[1].content.as_deref(), Some("块保真"));
}

#[test]
fn unparseable_timeline_blocks_json_falls_back_to_text() {
    let mut h = msg("m1", "user", Some("正文"), Some("completed"));
    h.blocks_json = Some(r#"[{"type":"text","content":"正文"}]"#.into());
    let hydrated = hydrate_history(vec![h]);
    assert_eq!(
        hydrated[0].blocks,
        vec![AgentMessageBlock::Text {
            text: "正文".into()
        }]
    );
}

#[test]
fn thinking_synthesized_to_thought_block() {
    let mut h = msg("m1", "assistant", Some("正文"), None);
    h.thinking = Some("思考过程".into());
    let history = vec![
        msg("u0", "user", Some("首"), None),
        h,
        msg("tail", "user", Some("确认"), None),
    ];
    let hydrated = hydrate_history(history);
    assert!(matches!(
        &hydrated[1].blocks[1],
        AgentMessageBlock::Thought { text, redacted: None } if text == "思考过程"
    ));
}

#[test]
fn legacy_tool_calls_and_results_map_to_blocks() {
    let mut h = msg("m1", "assistant", Some("调用工具"), None);
    h.tool_calls_json = Some(
        r#"[{"id":"c1","name":"read_file","arguments":"{\"path\":\"a.txt\"}","status":"success"}]"#
            .into(),
    );
    h.tool_call_results_json =
        Some(r#"[{"id":"c1","output":"file content","isError":false}]"#.into());
    let history = vec![
        msg("u0", "user", Some("提问"), None),
        h,
        msg("tail", "user", Some("确认"), None),
    ];
    let hydrated = hydrate_history(history);
    assert_eq!(hydrated.len(), 4);
    assert_eq!(ids(&hydrated), ["u0", "m1", "tool-result-c1", "tail"]);

    let asst = &hydrated[1];
    assert_eq!(asst.role, AgentMessageRole::Assistant);
    assert_eq!(asst.blocks.len(), 2); // text + tool-call
    assert!(matches!(
        &asst.blocks[1],
        AgentMessageBlock::ToolCall(call)
            if call.id == "c1" && call.tool_name == "read_file" && call.input["path"] == "a.txt"
    ));

    let tool = &hydrated[2];
    assert_eq!(tool.role, AgentMessageRole::Tool);
    assert!(matches!(
        &tool.blocks[0],
        AgentMessageBlock::ToolResult {
            tool_call_id,
            tool_name,
            output,
            is_error: false,
        } if tool_call_id == "c1" && tool_name == "read_file" && output.text.as_deref() == Some("file content")
    ));
}

#[test]
fn raw_arguments_wrapped_as_string_value() {
    let mut h = msg("m1", "assistant", None, None);
    h.tool_calls_json = Some(r#"[{"id":"c1","name":"shell","arguments":"npm run dev"}]"#.into());
    let history = vec![
        msg("u0", "user", Some("首"), None),
        h,
        msg("tail", "user", Some("确认"), None),
    ];
    let hydrated = hydrate_history(history);
    assert!(matches!(
        &hydrated[1].blocks[0],
        AgentMessageBlock::ToolCall(call)
            if call.input == serde_json::Value::String("npm run dev".into())
    ));
}

#[test]
fn unmatched_tool_result_gets_empty_tool_name() {
    let mut h = msg("m1", "user", Some("结果回执"), None);
    h.tool_call_results_json = Some(r#"[{"id":"c1","output":"ok","isError":true}]"#.into());
    let hydrated = hydrate_history(vec![h]);
    assert!(matches!(
        &hydrated[0].blocks[1],
        AgentMessageBlock::ToolResult {
            tool_call_id,
            tool_name,
            is_error: true,
            ..
        } if tool_call_id == "c1" && tool_name.is_empty()
    ));
}

/// 用例 U-02：真实工具输出提取与拒绝假报错（对抗 BC01-5）
#[test]
fn test_hydrate_restores_real_tool_output() {
    let mut a1 = msg("a1", "assistant", None, Some("completed"));
    a1.tool_calls_json = Some(
        r#"[
        {
            "id": "c1",
            "name": "read_file",
            "arguments": "{\"path\":\"a.txt\"}",
            "status": "success",
            "output": "文件真实内容ABC"
        }
    ]"#
        .into(),
    );

    let history = vec![msg("u1", "user", Some("查看文件"), None), a1];
    let hydrated = hydrate_history(history);
    assert_eq!(
        hydrated.len(),
        3,
        "必须包含 User, Assistant 以及伴随的 Tool 角色消息"
    );

    assert_eq!(hydrated[0].role, AgentMessageRole::User);
    assert_eq!(hydrated[1].role, AgentMessageRole::Assistant);
    assert_eq!(hydrated[2].role, AgentMessageRole::Tool);

    let tool_msg = &hydrated[2];
    assert_eq!(tool_msg.blocks.len(), 1);
    match &tool_msg.blocks[0] {
        AgentMessageBlock::ToolResult {
            tool_call_id,
            output,
            is_error,
            ..
        } => {
            assert_eq!(tool_call_id, "c1");
            assert_eq!(output.text.as_deref(), Some("文件真实内容ABC"));
            assert!(!is_error, "正常成功的工具调用绝不能被标记为 error");
        }
        _ => panic!("必须为 ToolResult 块"),
    }
    assert!(
        tool_msg.metadata.is_none(),
        "正常成功执行的工具绝对不带假错误元数据"
    );
}
