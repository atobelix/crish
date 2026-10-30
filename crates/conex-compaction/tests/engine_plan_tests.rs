//! 压缩计划（切割点 / system 保留 / 丢弃段）主题用例。

mod common;

use common::{amsg, text_block, tool_call_block, tool_result_block};
use conex_compaction::{count_agent_message_tokens, CompactionEngine, CompactionPolicy};
use conex_types::AgentMessageRole;

#[test]
fn compact_empty_input() {
    let engine = CompactionEngine::new();
    let plan = engine.compact_agent_messages(&[], 100, &CompactionPolicy::default(), None);
    assert!(plan.messages.is_empty());
    assert_eq!(plan.tokens_before, 0);
    assert_eq!(plan.tokens_after, 0);
    assert!(plan.dropped_ids.is_empty());
    assert!(plan.summary.is_empty());
}

#[test]
fn compact_under_budget_returns_original() {
    let engine = CompactionEngine::new();
    let messages = vec![
        amsg(
            "s1",
            AgentMessageRole::System,
            "2026-08-03T10:00:00.000Z",
            vec![text_block("system")],
            None,
        ),
        amsg(
            "u1",
            AgentMessageRole::User,
            "2026-08-03T10:00:01.000Z",
            vec![text_block("hello")],
            None,
        ),
        amsg(
            "a1",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:02.000Z",
            vec![text_block("hi")],
            None,
        ),
    ];
    let plan = engine.compact_agent_messages(&messages, 10_000, &CompactionPolicy::default(), None);
    assert_eq!(plan.messages.len(), messages.len());
    assert_eq!(
        plan.messages
            .iter()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>(),
        vec!["s1", "u1", "a1"]
    );
    assert!(plan.dropped_ids.is_empty());
    assert!(plan.summary.is_empty());
    assert_eq!(plan.tokens_before, plan.tokens_after);
}

#[test]
fn compact_keeps_system_and_recent_with_placeholder() {
    let engine = CompactionEngine::new();
    let messages = vec![
        amsg(
            "s1",
            AgentMessageRole::System,
            "2026-08-03T10:00:00.000Z",
            vec![text_block("system prompt")],
            None,
        ),
        amsg(
            "u1",
            AgentMessageRole::User,
            "2026-08-03T10:00:01.000Z",
            vec![text_block(&"long user one".repeat(50))],
            None,
        ),
        amsg(
            "a1",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:02.000Z",
            vec![text_block(&"long asst one".repeat(50))],
            None,
        ),
        amsg(
            "u2",
            AgentMessageRole::User,
            "2026-08-03T10:00:03.000Z",
            vec![text_block("recent user")],
            None,
        ),
        amsg(
            "a2",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:04.000Z",
            vec![text_block("recent asst")],
            None,
        ),
    ];
    let keep = count_agent_message_tokens(&messages[3]) + count_agent_message_tokens(&messages[4]);
    let policy = CompactionPolicy {
        keep_recent_tokens: keep,
        min_recent_turns: 1,
        ..CompactionPolicy::default()
    };
    let plan = engine.compact_agent_messages(&messages, 30, &policy, None);
    assert_eq!(
        plan.messages
            .iter()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>(),
        vec!["s1", "compacted-summary-1-1", "u2", "a2"]
    );
    assert_eq!(
        plan.summary,
        "[Compacted(compacted-summary-1-1) 2 条消息 · 摘要见块表]"
    );
    assert!(
        !plan.summary.contains("生成中"),
        "stub 不得含「生成中」措辞（R-C）"
    );
    assert_eq!(plan.dropped_ids, vec!["u1", "a1"]);
    assert_eq!(plan.first_kept_message_id.as_deref(), Some("u2"));
    assert_eq!(
        plan.kept_ids,
        vec!["s1", "compacted-summary-1-1", "u2", "a2"]
    );
    assert!(plan.tokens_after < plan.tokens_before);
    assert!(!plan.summary_is_llm);
}

#[test]
fn compact_placeholder_uses_dropped_count() {
    let engine = CompactionEngine::new();
    let messages = vec![
        amsg(
            "u1",
            AgentMessageRole::User,
            "2026-08-03T10:00:00.000Z",
            vec![text_block(&"m".repeat(300))],
            None,
        ),
        amsg(
            "a1",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:01.000Z",
            vec![text_block(&"m".repeat(300))],
            None,
        ),
        amsg(
            "a2",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:02.000Z",
            vec![text_block(&"m".repeat(300))],
            None,
        ),
        amsg(
            "u3",
            AgentMessageRole::User,
            "2026-08-03T10:00:03.000Z",
            vec![text_block("keep")],
            None,
        ),
        amsg(
            "a3",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:04.000Z",
            vec![text_block("keep")],
            None,
        ),
    ];
    let keep = count_agent_message_tokens(&messages[3]) + count_agent_message_tokens(&messages[4]);
    let policy = CompactionPolicy {
        keep_recent_tokens: keep,
        min_recent_turns: 1,
        ..CompactionPolicy::default()
    };
    let plan = engine.compact_agent_messages(&messages, 5, &policy, None);
    assert_eq!(
        plan.summary,
        "[Compacted(compacted-summary-1-1) 3 条消息 · 摘要见块表]"
    );
    assert_eq!(plan.dropped_ids, vec!["u1", "a1", "a2"]);
}

#[test]
fn compact_tool_pair_not_split() {
    let engine = CompactionEngine::new();
    let messages = vec![
        amsg(
            "u1",
            AgentMessageRole::User,
            "2026-08-03T10:00:00.000Z",
            vec![text_block(&"long question".repeat(50))],
            None,
        ),
        amsg(
            "a1",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:01.000Z",
            vec![tool_call_block(
                "t1",
                "read_file",
                serde_json::json!({"path": "/tmp/x"}),
            )],
            None,
        ),
        amsg(
            "u2",
            AgentMessageRole::User,
            "2026-08-03T10:00:02.000Z",
            vec![tool_result_block("t1", "read_file", "file content")],
            None,
        ),
        amsg(
            "u3",
            AgentMessageRole::User,
            "2026-08-03T10:00:03.000Z",
            vec![text_block("next")],
            None,
        ),
        amsg(
            "a2",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:04.000Z",
            vec![text_block("answer")],
            None,
        ),
    ];
    let keep = count_agent_message_tokens(&messages[2])
        + count_agent_message_tokens(&messages[3])
        + count_agent_message_tokens(&messages[4]);
    let policy = CompactionPolicy {
        keep_recent_tokens: keep,
        min_recent_turns: 1,
        ..CompactionPolicy::default()
    };
    let plan = engine.compact_agent_messages(&messages, 200, &policy, None);
    let ids: Vec<&str> = plan.messages.iter().map(|m| m.id.as_str()).collect();
    assert!(ids.contains(&"a1"), "tool-call 消息须保留");
    assert!(ids.contains(&"u2"), "tool-result 消息须保留");
    assert_eq!(plan.dropped_ids, vec!["u1"]);
    assert_eq!(plan.first_kept_message_id.as_deref(), Some("a1"));
}

#[test]
fn compact_abandons_when_orphan_unfixable() {
    let engine = CompactionEngine::new();
    let messages = vec![
        amsg(
            "u1",
            AgentMessageRole::User,
            "2026-08-03T10:00:00.000Z",
            vec![text_block(&"long".repeat(100))],
            None,
        ),
        amsg(
            "u2",
            AgentMessageRole::User,
            "2026-08-03T10:00:01.000Z",
            vec![tool_result_block("t1", "read_file", "orphan")],
            None,
        ),
        amsg(
            "u3",
            AgentMessageRole::User,
            "2026-08-03T10:00:02.000Z",
            vec![text_block("keep")],
            None,
        ),
        amsg(
            "a2",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:03.000Z",
            vec![text_block("keep")],
            None,
        ),
    ];
    let keep = count_agent_message_tokens(&messages[1])
        + count_agent_message_tokens(&messages[2])
        + count_agent_message_tokens(&messages[3]);
    let policy = CompactionPolicy {
        keep_recent_tokens: keep,
        min_recent_turns: 0,
        ..CompactionPolicy::default()
    };
    let plan = engine.compact_agent_messages(&messages, 5, &policy, None);
    assert_eq!(
        plan.messages
            .iter()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>(),
        vec!["u1", "u2", "u3", "a2"],
        "放弃压缩：原序列原样返回"
    );
    assert!(plan.dropped_ids.is_empty());
    assert!(plan.summary.is_empty());
}

#[test]
fn compact_tool_pair_protection_can_be_disabled() {
    let engine = CompactionEngine::new();
    let messages = vec![
        amsg(
            "u1",
            AgentMessageRole::User,
            "2026-08-03T10:00:00.000Z",
            vec![text_block(&"long question".repeat(50))],
            None,
        ),
        amsg(
            "a1",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:01.000Z",
            vec![tool_call_block(
                "t1",
                "read_file",
                serde_json::json!({"path": "/tmp/x"}),
            )],
            None,
        ),
        amsg(
            "u2",
            AgentMessageRole::User,
            "2026-08-03T10:00:02.000Z",
            vec![tool_result_block("t1", "read_file", "file content")],
            None,
        ),
        amsg(
            "u3",
            AgentMessageRole::User,
            "2026-08-03T10:00:03.000Z",
            vec![text_block("next")],
            None,
        ),
        amsg(
            "a2",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:04.000Z",
            vec![text_block("answer")],
            None,
        ),
    ];
    let keep = count_agent_message_tokens(&messages[2])
        + count_agent_message_tokens(&messages[3])
        + count_agent_message_tokens(&messages[4]);
    let policy = CompactionPolicy {
        keep_recent_tokens: keep,
        min_recent_turns: 1,
        tool_pair_protection: false,
        ..CompactionPolicy::default()
    };
    let plan = engine.compact_agent_messages(&messages, 200, &policy, None);
    assert_eq!(plan.dropped_ids, vec!["u1", "a1"]);
    assert!(plan.messages.iter().any(|m| m.id == "u2"));
}

#[test]
fn compact_system_messages_always_kept() {
    let engine = CompactionEngine::new();
    let messages = vec![
        amsg(
            "s1",
            AgentMessageRole::System,
            "2026-08-03T10:00:00.000Z",
            vec![text_block("system")],
            None,
        ),
        amsg(
            "s2",
            AgentMessageRole::System,
            "2026-08-03T10:00:00.000Z",
            vec![text_block("steering transient")],
            None,
        ),
        amsg(
            "u1",
            AgentMessageRole::User,
            "2026-08-03T10:00:01.000Z",
            vec![text_block(&"long".repeat(100))],
            None,
        ),
        amsg(
            "a1",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:02.000Z",
            vec![text_block(&"long".repeat(100))],
            None,
        ),
        amsg(
            "u2",
            AgentMessageRole::User,
            "2026-08-03T10:00:03.000Z",
            vec![text_block("keep")],
            None,
        ),
        amsg(
            "a2",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:04.000Z",
            vec![text_block("keep")],
            None,
        ),
    ];
    let policy = CompactionPolicy {
        keep_recent_tokens: 10,
        min_recent_turns: 1,
        ..CompactionPolicy::default()
    };
    let plan = engine.compact_agent_messages(&messages, 5, &policy, None);
    assert_eq!(plan.messages[0].id, "s1");
    assert_eq!(plan.messages[1].id, "s2");
    assert_eq!(plan.messages[1].role, AgentMessageRole::System);
    assert!(
        plan.messages
            .iter()
            .filter(|m| m.role == AgentMessageRole::System)
            .count()
            == 2
    );
}
