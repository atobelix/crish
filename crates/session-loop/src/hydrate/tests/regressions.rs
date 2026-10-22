use conex_types::error::codes;
use conex_types::message::{AgentMessageBlock, AgentMessageRole};

use super::super::hydrate_history;
use super::super::repair::repair_orphan_tool_calls;
use super::{ids, msg};

#[test]
fn trailing_assistant_preserved_without_truncation() {
    let history = vec![
        msg("u1", "user", Some("q1"), None),
        msg("a1", "assistant", Some("r1"), None),
        msg("a2", "assistant", Some("r2"), None),
    ];
    assert_eq!(ids(&hydrate_history(history)), ["u1", "a1", "a2"]);
}

#[test]
fn mixed_order_preserves_trailing_assistant() {
    let history = vec![
        msg("u1", "user", Some("q1"), None),
        msg("a1", "assistant", Some("r1"), None),
        msg("u2", "user", Some("q2"), None),
        msg("a2", "assistant", Some("r2"), None),
    ];
    assert_eq!(ids(&hydrate_history(history)), ["u1", "a1", "u2", "a2"]);
}

#[test]
fn all_assistant_history_cleared_by_head_sanitizer() {
    let history = vec![
        msg("a1", "assistant", Some("r1"), None),
        msg("a2", "assistant", Some("r2"), None),
    ];
    assert!(hydrate_history(history).is_empty());
}

#[test]
fn leading_illegal_assistant_cleared_by_head_sanitizer() {
    let history = vec![
        msg("a0", "assistant", Some("非法开头"), None),
        msg("u1", "user", Some("合法首个用户提问"), None),
        msg("a1", "assistant", Some("合法助手回复"), None),
    ];
    assert_eq!(ids(&hydrate_history(history)), ["u1", "a1"]);
}

#[test]
fn malformed_entries_skipped_without_aborting() {
    let mut bad = msg("bad", "user", Some("正文仍保留"), None);
    bad.blocks_json = Some("不是 JSON".into());
    let mut bad2 = msg("bad2", "user", Some("工具部分跳过"), None);
    bad2.tool_calls_json = Some("[{\"id\":}]".into());
    let history = vec![bad, bad2.clone(), msg("ok", "user", Some("正常"), None)];
    assert_eq!(ids(&hydrate_history(history)), ["bad", "bad2", "ok"]);
    assert_eq!(
        hydrate_history(vec![bad2])[0].blocks,
        vec![AgentMessageBlock::Text {
            text: "工具部分跳过".into()
        }]
    );
}

/// 用例 U-01：多轮已完成历史 Assistant 保留验证（对抗 BC01-4）
#[test]
fn test_hydrate_preserves_trailing_assistant() {
    let history = vec![
        msg("u1", "user", Some("你好"), None),
        msg(
            "a1",
            "assistant",
            Some("我是助手，请问有什么可以帮您？"),
            Some("completed"),
        ),
        msg("u2", "user", Some("请基于你上一句回答总结"), None),
        msg(
            "a2",
            "assistant",
            Some("上一句我是问您有什么需要帮助。"),
            Some("completed"),
        ),
    ];
    let hydrated = hydrate_history(history);
    assert_eq!(hydrated.len(), 4, "尾部助手回复不得被截断丢失");
    assert_eq!(hydrated[0].role, AgentMessageRole::User);
    assert_eq!(hydrated[1].role, AgentMessageRole::Assistant);
    assert_eq!(hydrated[2].role, AgentMessageRole::User);
    assert_eq!(hydrated[3].role, AgentMessageRole::Assistant);
    assert_eq!(hydrated[3].text(), "上一句我是问您有什么需要帮助。");
}

/// 用例 U-03：真孤儿调用的降级自愈幂等性
#[test]
fn test_true_orphan_tool_call_self_healing_and_idempotency() {
    let mut a1 = msg("a1", "assistant", None, Some("completed"));
    a1.tool_calls_json = Some(
        r#"[
        {
            "id": "c2",
            "name": "interrupted_tool",
            "arguments": "{}"
        }
    ]"#
        .into(),
    );

    let history = vec![msg("u1", "user", Some("执行"), None), a1];
    let mut hydrated = hydrate_history(history);
    assert_eq!(hydrated.len(), 3);
    assert_eq!(hydrated[2].role, AgentMessageRole::Tool);

    let tool_msg = &hydrated[2];
    match &tool_msg.blocks[0] {
        AgentMessageBlock::ToolResult {
            tool_call_id,
            is_error,
            ..
        } => {
            assert_eq!(tool_call_id, "c2");
            assert!(is_error, "中断孤儿调用必须标记为 is_error=true");
        }
        _ => panic!("必须为 ToolResult 块"),
    }
    let meta = tool_msg.metadata.as_ref().expect("真孤儿必须携带错误标记");
    assert_eq!(
        meta.get("errorCode"),
        Some(&serde_json::json!(codes::TOOL_ABORTED_BEFORE_DISPATCH))
    );

    // 幂等性断言：再次执行自愈，不会重复合成
    let len_before = hydrated.len();
    repair_orphan_tool_calls(&mut hydrated);
    assert_eq!(hydrated.len(), len_before, "自愈操作必须严格满足幂等性");
}
