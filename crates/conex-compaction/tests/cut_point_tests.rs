mod common;

use common::{
    amsg, first_compaction_fixture, push_long_turn, tail_keep_policy, text_block, tool_call_block,
    tool_result_block,
};
use conex_compaction::{count_agent_message_tokens, CompactionEngine, CompactionPolicy};
use conex_types::AgentMessageRole;

#[test]
fn cut_point_accumulates_from_tail_to_budget() {
    let engine = CompactionEngine::new(0);
    // 中间两条长消息 + 尾部两条短消息；keep 预算恰好覆盖尾部两条
    let messages = vec![
        amsg(
            "m1",
            AgentMessageRole::User,
            "2026-08-03T10:00:00.000Z",
            vec![text_block(&"x".repeat(200))],
            None,
        ),
        amsg(
            "m2",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:01.000Z",
            vec![text_block(&"y".repeat(200))],
            None,
        ),
        amsg(
            "m3",
            AgentMessageRole::User,
            "2026-08-03T10:00:02.000Z",
            vec![text_block("recent user")],
            None,
        ),
        amsg(
            "m4",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:03.000Z",
            vec![text_block("recent asst")],
            None,
        ),
    ];
    // 预算 = 尾部两条的 token 和 → 倒推累计恰好在 m3 达标 → 切割点 = 2
    let keep = count_agent_message_tokens(&messages[2]) + count_agent_message_tokens(&messages[3]);
    let cut = engine
        .find_cut_point(&messages, keep, 1)
        .expect("应存在切割点");
    assert_eq!(cut, 2);
}

#[test]
fn cut_point_min_recent_turns_extends_backward() {
    let engine = CompactionEngine::new(0);
    // 预算切割点落在 m3（assistant）→ 保留段仅 1 个 user 回合；
    // min_recent_turns=2 → 向前扩展到 m2（user）凑满 2 个回合
    let messages = vec![
        amsg(
            "m1",
            AgentMessageRole::User,
            "2026-08-03T10:00:00.000Z",
            vec![text_block(&"a".repeat(100))],
            None,
        ),
        amsg(
            "m2",
            AgentMessageRole::User,
            "2026-08-03T10:00:01.000Z",
            vec![text_block("u2")],
            None,
        ),
        amsg(
            "m3",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:02.000Z",
            vec![text_block("a2")],
            None,
        ),
        amsg(
            "m4",
            AgentMessageRole::User,
            "2026-08-03T10:00:03.000Z",
            vec![text_block("u3")],
            None,
        ),
        amsg(
            "m5",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:04.000Z",
            vec![text_block("a3")],
            None,
        ),
    ];
    let keep = count_agent_message_tokens(&messages[2])
        + count_agent_message_tokens(&messages[3])
        + count_agent_message_tokens(&messages[4]);
    let cut = engine
        .find_cut_point(&messages, keep, 2)
        .expect("应存在切割点");
    assert_eq!(cut, 1);
}

#[test]
fn cut_point_never_splits_tool_pair() {
    let engine = CompactionEngine::new(0);
    // m2 是 tool-call（id=t1），m3 是 tool-result(t1)；预算切割点落在
    // m3（保留段含 result 无 call）→ 向前扩展到 m2
    let messages = vec![
        amsg(
            "m1",
            AgentMessageRole::User,
            "2026-08-03T10:00:00.000Z",
            vec![text_block(&"a".repeat(200))],
            None,
        ),
        amsg(
            "m2",
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
            "m3",
            AgentMessageRole::User,
            "2026-08-03T10:00:02.000Z",
            vec![tool_result_block("t1", "read_file", "file content")],
            None,
        ),
        amsg(
            "m4",
            AgentMessageRole::User,
            "2026-08-03T10:00:03.000Z",
            vec![text_block("u2")],
            None,
        ),
        amsg(
            "m5",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:04.000Z",
            vec![text_block("a2")],
            None,
        ),
    ];
    let keep = count_agent_message_tokens(&messages[2])
        + count_agent_message_tokens(&messages[3])
        + count_agent_message_tokens(&messages[4]);
    let cut = engine
        .find_cut_point(&messages, keep, 1)
        .expect("应存在切割点");
    // 预算落在 m3，但 m3 含孤儿 result(t1) → 扩展到 m2（call 所在）
    assert_eq!(cut, 1);
}

#[test]
fn cut_point_abandons_on_unfixable_orphan() {
    let engine = CompactionEngine::new(0);
    // 保留段含 result(t1) 但全对话无对应 call → 数据异常，放弃压缩
    let messages = vec![
        amsg(
            "m1",
            AgentMessageRole::User,
            "2026-08-03T10:00:00.000Z",
            vec![text_block(&"a".repeat(200))],
            None,
        ),
        amsg(
            "m2",
            AgentMessageRole::User,
            "2026-08-03T10:00:01.000Z",
            vec![text_block("u1")],
            None,
        ),
        amsg(
            "m3",
            AgentMessageRole::User,
            "2026-08-03T10:00:02.000Z",
            vec![tool_result_block("t1", "read_file", "orphan result")],
            None,
        ),
        amsg(
            "m4",
            AgentMessageRole::User,
            "2026-08-03T10:00:03.000Z",
            vec![text_block("u2")],
            None,
        ),
        amsg(
            "m5",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:04.000Z",
            vec![text_block("a2")],
            None,
        ),
    ];
    let keep = count_agent_message_tokens(&messages[2])
        + count_agent_message_tokens(&messages[3])
        + count_agent_message_tokens(&messages[4]);
    let cut = engine.find_cut_point(&messages, keep, 0);
    assert_eq!(cut, None);
}

#[test]
fn cut_point_none_on_empty_or_all_retained() {
    let engine = CompactionEngine::new(0);
    assert_eq!(engine.find_cut_point(&[], 100, 2), None);
    // 全部消息未达预算 → 无可丢内容
    let messages = vec![
        amsg(
            "m1",
            AgentMessageRole::User,
            "2026-08-03T10:00:00.000Z",
            vec![text_block("short")],
            None,
        ),
        amsg(
            "m2",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:01.000Z",
            vec![text_block("short")],
            None,
        ),
    ];
    assert_eq!(engine.find_cut_point(&messages, 10_000, 1), None);
}

#[test]
fn cut_never_below_fold_start() {
    let (engine, messages) = first_compaction_fixture();
    let mut conversation = messages;
    let mut prev_first_kept: Option<String> = None;
    for round in 0..3 {
        let policy = tail_keep_policy(&conversation, 1);
        let plan = engine.compact_agent_messages(&conversation, 30, &policy, None);
        let Some(first_kept) = &plan.first_kept_message_id else {
            panic!("第 {round} 轮压缩必须产生切割点");
        };
        if let Some(prev) = &prev_first_kept {
            let prev_idx = conversation
                .iter()
                .position(|m| m.id == *prev)
                .expect("旧保留点仍在对话");
            let new_idx = conversation
                .iter()
                .position(|m| m.id == *first_kept)
                .expect("新保留点在对话");
            assert!(
                new_idx >= prev_idx,
                "B2 单调：cut 不后退（{prev} @ {prev_idx} → {first_kept} @ {new_idx}）"
            );
        }
        prev_first_kept = Some(first_kept.clone());
        // 保留点恒位于链后（链 = system 后连续 compacted-summary 段）
        let chain_count = plan
            .messages
            .iter()
            .filter(|m| m.id.starts_with("compacted-summary"))
            .count();
        let fk_idx = plan
            .messages
            .iter()
            .position(|m| m.id == *first_kept)
            .expect("first_kept 在结果中");
        assert!(fk_idx >= chain_count, "first_kept 必须位于链后");
        // 追加新回合进入下一轮
        conversation = plan.messages.clone();
        push_long_turn(&mut conversation, &round.to_string());
    }
}

#[test]
fn budget_scan_starts_after_chain() {
    let engine = CompactionEngine::new(0);
    // 链消息本身远超预算 → 切割点仍必须落在链后（fold_start = 2）
    let messages = vec![
        amsg(
            "s1",
            AgentMessageRole::System,
            "2026-08-03T10:00:00.000Z",
            vec![text_block("system")],
            None,
        ),
        amsg(
            "compacted-summary-1-1",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:01.000Z",
            vec![text_block(&"chain token".repeat(4000))],
            None,
        ),
        amsg(
            "u1",
            AgentMessageRole::User,
            "2026-08-03T10:00:02.000Z",
            vec![text_block(&"long".repeat(200))],
            None,
        ),
        amsg(
            "u2",
            AgentMessageRole::User,
            "2026-08-03T10:00:03.000Z",
            vec![text_block(&"long".repeat(200))],
            None,
        ),
    ];
    let policy = CompactionPolicy {
        keep_recent_tokens: 10,
        min_recent_turns: 1,
        ..CompactionPolicy::default()
    };
    let plan = engine.compact_agent_messages(&messages, 5, &policy, None);
    assert_eq!(plan.first_kept_message_id.as_deref(), Some("u2"));
    assert_eq!(plan.dropped_ids, vec!["u1"], "链永不入 dropped");
    // 链 + system 原样保留在头部，新摘要接在链尾
    let ids: Vec<&str> = plan.messages.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(
        ids,
        vec!["s1", "compacted-summary-1-1", "compacted-summary-1-2", "u2"]
    );
}

#[test]
fn tool_pair_protection_clamps_to_chain() {
    let engine = CompactionEngine::new(0);
    // 场景 A：孤儿 result(t1) 的 call 位于链内（fold_start 处）→ 放弃压缩
    let messages_a = vec![
        amsg(
            "s1",
            AgentMessageRole::System,
            "2026-08-03T10:00:00.000Z",
            vec![text_block("system")],
            None,
        ),
        amsg(
            "compacted-summary-1-1",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:01.000Z",
            vec![tool_call_block("t1", "read_file", serde_json::json!({}))],
            None,
        ),
        amsg(
            "u1",
            AgentMessageRole::User,
            "2026-08-03T10:00:02.000Z",
            vec![text_block(&"long".repeat(100))],
            None,
        ),
        amsg(
            "u2",
            AgentMessageRole::User,
            "2026-08-03T10:00:03.000Z",
            vec![tool_result_block("t1", "read_file", "orphan")],
            None,
        ),
        amsg(
            "u3",
            AgentMessageRole::User,
            "2026-08-03T10:00:04.000Z",
            vec![text_block("keep")],
            None,
        ),
        amsg(
            "a2",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:05.000Z",
            vec![text_block("keep")],
            None,
        ),
    ];
    let keep = count_agent_message_tokens(&messages_a[3])
        + count_agent_message_tokens(&messages_a[4])
        + count_agent_message_tokens(&messages_a[5]);
    let policy = CompactionPolicy {
        keep_recent_tokens: keep,
        min_recent_turns: 1,
        ..CompactionPolicy::default()
    };
    let plan = engine.compact_agent_messages(&messages_a, 5, &policy, None);
    assert!(
        plan.dropped_ids.is_empty(),
        "孤儿 call 在链内 → 保守放弃压缩"
    );
    assert_eq!(plan.messages.len(), messages_a.len(), "原样返回");
    // 场景 B：call 位于链后（u1）→ 回扫正常扩展，链不进保留区
    let messages_b = vec![
        amsg(
            "s1",
            AgentMessageRole::System,
            "2026-08-03T10:00:00.000Z",
            vec![text_block("system")],
            None,
        ),
        amsg(
            "compacted-summary-1-1",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:01.000Z",
            vec![text_block("chain stub")],
            None,
        ),
        amsg(
            "u0",
            AgentMessageRole::User,
            "2026-08-03T10:00:02.000Z",
            vec![text_block(&"long".repeat(100))],
            None,
        ),
        amsg(
            "u1",
            AgentMessageRole::User,
            "2026-08-03T10:00:03.000Z",
            vec![tool_call_block("t1", "read_file", serde_json::json!({}))],
            None,
        ),
        amsg(
            "u2",
            AgentMessageRole::User,
            "2026-08-03T10:00:04.000Z",
            vec![tool_result_block("t1", "read_file", "result")],
            None,
        ),
        amsg(
            "u3",
            AgentMessageRole::User,
            "2026-08-03T10:00:05.000Z",
            vec![text_block("keep")],
            None,
        ),
        amsg(
            "a2",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:06.000Z",
            vec![text_block("keep")],
            None,
        ),
    ];
    let keep = count_agent_message_tokens(&messages_b[4])
        + count_agent_message_tokens(&messages_b[5])
        + count_agent_message_tokens(&messages_b[6]);
    let policy = CompactionPolicy {
        keep_recent_tokens: keep,
        min_recent_turns: 1,
        ..CompactionPolicy::default()
    };
    let plan = engine.compact_agent_messages(&messages_b, 5, &policy, None);
    assert_eq!(plan.dropped_ids, vec!["u0"], "仅 u0 被丢弃");
    let ids: Vec<&str> = plan.messages.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(
        ids,
        vec![
            "s1",
            "compacted-summary-1-1",
            "compacted-summary-1-2",
            "u1",
            "u2",
            "u3",
            "a2"
        ],
        "链恒在头部，tool 对一起保留，新摘要接链尾"
    );
    assert_eq!(plan.first_kept_message_id.as_deref(), Some("u1"));
}

#[test]
fn test_cut_point_at_fold_start_success() {
    let engine = CompactionEngine::new(0);
    let messages = vec![
        amsg(
            "s1",
            AgentMessageRole::System,
            "2026-08-03T10:00:00.000Z",
            vec![text_block("system prompt")],
            None,
        ),
        amsg(
            "compacted-summary-1-1",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:01.000Z",
            vec![text_block("OLD SUMMARY")],
            None,
        ),
        amsg(
            "u1",
            AgentMessageRole::User,
            "2026-08-03T10:00:02.000Z",
            vec![text_block(&"long u1".repeat(50))],
            None,
        ),
        amsg(
            "a1",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:03.000Z",
            vec![tool_call_block(
                "t1",
                "read_file",
                serde_json::json!({"path": "/a"}),
            )],
            None,
        ),
        amsg(
            "u2",
            AgentMessageRole::User,
            "2026-08-03T10:00:04.000Z",
            vec![tool_result_block("t1", "read_file", "content of /a")],
            None,
        ),
        amsg(
            "u3",
            AgentMessageRole::User,
            "2026-08-03T10:00:05.000Z",
            vec![text_block("recent question")],
            None,
        ),
        amsg(
            "a2",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:06.000Z",
            vec![text_block("recent answer")],
            None,
        ),
    ];

    let keep = count_agent_message_tokens(&messages[5]) + count_agent_message_tokens(&messages[6]);
    let policy = CompactionPolicy {
        keep_recent_tokens: keep,
        min_recent_turns: 1,
        ..CompactionPolicy::default()
    };

    let plan = engine.compact_agent_messages(&messages, 100, &policy, None);
    assert_eq!(
        plan.dropped_ids,
        vec!["u1", "a1", "u2"],
        "旧摘要后的历史业务项被正确丢弃"
    );
    assert_eq!(plan.first_kept_message_id.as_deref(), Some("u3"));
    assert_eq!(plan.fold_index, 2);
    assert_eq!(plan.messages[0].id, "s1");
    assert_eq!(plan.messages[1].id, "compacted-summary-1-1");
    assert_eq!(plan.messages[2].id, "compacted-summary-1-2");
    assert_eq!(plan.messages[3].id, "u3");
    assert_eq!(plan.messages[4].id, "a2");

    let keep_tool = count_agent_message_tokens(&messages[4])
        + count_agent_message_tokens(&messages[5])
        + count_agent_message_tokens(&messages[6]);
    let policy_tool = CompactionPolicy {
        keep_recent_tokens: keep_tool,
        min_recent_turns: 1,
        ..CompactionPolicy::default()
    };
    let plan_b = engine.compact_agent_messages(&messages, 100, &policy_tool, None);
    assert_eq!(
        plan_b.dropped_ids,
        vec!["u1"],
        "仅 u1 被丢弃，tool call 与 result 闭包保留"
    );
    assert_eq!(plan_b.first_kept_message_id.as_deref(), Some("a1"));
}

#[test]
fn test_tool_batch_atomicity_closure() {
    let engine = CompactionEngine::new(0);
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
            vec![text_block(&"very long user context".repeat(40))],
            None,
        ),
        amsg(
            "a1",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:02.000Z",
            vec![
                tool_call_block("call_A", "tool_a", serde_json::json!({})),
                tool_call_block("call_B", "tool_b", serde_json::json!({})),
                tool_call_block("call_C", "tool_c", serde_json::json!({})),
            ],
            None,
        ),
        amsg(
            "t_a",
            AgentMessageRole::Tool,
            "2026-08-03T10:00:03.000Z",
            vec![tool_result_block("call_A", "tool_a", "out_a")],
            None,
        ),
        amsg(
            "t_b",
            AgentMessageRole::Tool,
            "2026-08-03T10:00:04.000Z",
            vec![tool_result_block("call_B", "tool_b", "out_b")],
            None,
        ),
        amsg(
            "t_c",
            AgentMessageRole::Tool,
            "2026-08-03T10:00:05.000Z",
            vec![tool_result_block("call_C", "tool_c", "out_c")],
            None,
        ),
        amsg(
            "u2",
            AgentMessageRole::User,
            "2026-08-03T10:00:06.000Z",
            vec![text_block("latest prompt")],
            None,
        ),
        amsg(
            "a2",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:07.000Z",
            vec![text_block("latest answer")],
            None,
        ),
    ];

    let keep = count_agent_message_tokens(&messages[4])
        + count_agent_message_tokens(&messages[5])
        + count_agent_message_tokens(&messages[6])
        + count_agent_message_tokens(&messages[7]);

    let policy = CompactionPolicy {
        keep_recent_tokens: keep,
        min_recent_turns: 1,
        tool_pair_protection: true,
        ..CompactionPolicy::default()
    };

    let plan = engine.compact_agent_messages(&messages, 100, &policy, None);
    let ids: Vec<&str> = plan.messages.iter().map(|m| m.id.as_str()).collect();

    assert!(ids.contains(&"a1"), "Assistant 消息必须被闭包拉入保留段");
    assert!(ids.contains(&"t_a"), "ToolResult A 必须被完整保留");
    assert!(ids.contains(&"t_b"), "ToolResult B 必须被完整保留");
    assert!(ids.contains(&"t_c"), "ToolResult C 必须被完整保留");
    assert!(ids.contains(&"u2"), "Recent User 必须保留");
    assert!(ids.contains(&"a2"), "Recent Assistant 必须保留");

    assert_eq!(plan.dropped_ids, vec!["u1"]);
    assert_eq!(plan.first_kept_message_id.as_deref(), Some("a1"));
}
