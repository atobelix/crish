//! 紧急二次预检（Emergency Preflight）主题用例。

mod common;

use common::{amsg, text_block, tool_call_block, tool_result_block};
use conex_compaction::{CompactionEngine, CompactionPolicy};
use conex_types::message::AgentMessageRole;

#[test]
fn test_post_append_emergency_preflight() {
    let engine = CompactionEngine::new();

    let huge_text = "x".repeat(50_000);
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
            vec![text_block(&"early user".repeat(30))],
            None,
        ),
        amsg(
            "a1",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:02.000Z",
            vec![tool_call_block("t1", "big_tool", serde_json::json!({}))],
            None,
        ),
        amsg(
            "t1",
            AgentMessageRole::Tool,
            "2026-08-03T10:00:03.000Z",
            vec![tool_result_block("t1", "big_tool", &huge_text)],
            None,
        ),
        amsg(
            "u2",
            AgentMessageRole::User,
            "2026-08-03T10:00:04.000Z",
            vec![text_block("recent user")],
            None,
        ),
        amsg(
            "a2",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:05.000Z",
            vec![text_block("recent asst")],
            None,
        ),
    ];

    let budget_tokens = 5_000;
    let policy = CompactionPolicy {
        keep_recent_tokens: 3_000,
        min_recent_turns: 1,
        ..CompactionPolicy::default()
    };

    let plan = engine.compact_agent_messages(&messages, budget_tokens, &policy, None);

    assert!(
        plan.tokens_after <= budget_tokens as u64,
        "tokens_after ({}) 必须 <= budget_tokens ({})",
        plan.tokens_after,
        budget_tokens
    );

    let preflight_plan = engine.emergency_preflight(&messages, budget_tokens, &policy, None);
    assert!(
        preflight_plan.tokens_after <= budget_tokens as u64,
        "emergency_preflight tokens_after ({}) 必须 <= budget_tokens ({})",
        preflight_plan.tokens_after,
        budget_tokens
    );
}
