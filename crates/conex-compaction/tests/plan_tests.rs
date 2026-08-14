mod common;

use common::{first_compaction_fixture, push_long_turn, tail_keep_policy};
use conex_compaction::{count_tokens, CompactionPolicy, MIN_RECENT_TURNS_DEFAULT};

#[test]
fn default_policy_matches_plan_constants() {
    let policy = CompactionPolicy::default();
    assert_eq!(policy.keep_recent_tokens, 20_000);
    assert_eq!(policy.min_recent_turns, MIN_RECENT_TURNS_DEFAULT);
    assert_eq!(policy.max_summary_tokens, 1_024);
    assert!(policy.tool_pair_protection);
}

#[test]
fn count_tokens_empty() {
    assert_eq!(count_tokens(""), 0);
}

#[test]
fn count_tokens_simple_word() {
    let tokens = count_tokens("hello");
    assert!((1..=3).contains(&tokens));
}

#[test]
fn count_tokens_sentence() {
    let tokens = count_tokens("Hello, world! This is a test.");
    assert!(tokens >= 5);
    assert!(tokens <= 20);
}

#[test]
fn count_tokens_cjk() {
    let tokens = count_tokens("你好世界");
    assert!(tokens >= 4);
}

#[test]
fn count_tokens_long_text() {
    let text = "word ".repeat(100);
    let tokens = count_tokens(&text);
    assert!(tokens >= 100);
    assert!(tokens <= 300);
}

#[test]
fn summary_ids_increase_with_fold() {
    let (engine, messages) = first_compaction_fixture();
    let mut conversation = messages;
    for round in 1..=3 {
        let policy = tail_keep_policy(&conversation, 1);
        let plan = engine.compact_agent_messages(&conversation, 30, &policy, None);
        assert_eq!(plan.fold_chain_prev, round - 1);
        assert_eq!(plan.fold_chain_after, round);
        assert_eq!(plan.fold_index, round);
        assert_eq!(plan.generation, 1, "本轮引擎侧占位代数");
        let new_summary = plan
            .messages
            .iter()
            .rfind(|m| m.id.starts_with("compacted-summary"))
            .expect("链须新增一条");
        assert_eq!(new_summary.id, format!("compacted-summary-1-{round}"));
        assert_eq!(
            plan.messages
                .iter()
                .filter(|m| m.id.starts_with("compacted-summary"))
                .count(),
            round,
            "链只增（B3）"
        );
        conversation = plan.messages.clone();
        push_long_turn(&mut conversation, &round.to_string());
    }
}

#[test]
fn chain_never_in_dropped_ids() {
    let (engine, messages) = first_compaction_fixture();
    let policy = tail_keep_policy(&messages, 1);
    let first = engine.compact_agent_messages(&messages, 30, &policy, None);
    assert!(
        first
            .dropped_ids
            .iter()
            .all(|id| !id.starts_with("compacted-summary")),
        "首压 dropped 不得含链消息"
    );
    let mut conversation = first.messages.clone();
    push_long_turn(&mut conversation, "3");
    let policy = tail_keep_policy(&conversation, 1);
    let second = engine.compact_agent_messages(&conversation, 30, &policy, None);
    assert!(
        second
            .dropped_ids
            .iter()
            .all(|id| !id.starts_with("compacted-summary")),
        "二次压缩 dropped 不得含链消息"
    );
    assert_eq!(second.dropped_ids, vec!["u2", "a2"]);
    assert_eq!(
        second
            .messages
            .iter()
            .filter(|m| m.id.starts_with("compacted-summary"))
            .count(),
        2,
        "链全保留"
    );
}

#[test]
fn stub_is_deterministic_and_neutral() {
    let (engine, messages) = first_compaction_fixture();
    let policy = tail_keep_policy(&messages, 1);
    let first = engine.compact_agent_messages(&messages, 30, &policy, None);
    let second = engine.compact_agent_messages(&messages, 30, &policy, None);
    assert_eq!(first.summary, second.summary, "stub 确定性：同输入同输出");
    let stub = &first.summary;
    assert!(stub.starts_with("[Compacted("), "stub 前缀：{stub}");
    assert!(!stub.contains("生成中"), "中性措辞：无「生成中」");
    assert!(!stub.contains("generating"), "中性措辞：无 generating");
    assert!(!stub.contains("失败"), "中性措辞：无失败");
    let summary_msg = first
        .messages
        .iter()
        .find(|m| m.id.starts_with("compacted-summary"))
        .expect("stub 消息须入对话");
    let meta = summary_msg
        .metadata
        .as_ref()
        .expect("stub 消息须带 metadata 快照");
    assert_eq!(meta["summary"]["blockId"], "compacted-summary-1-1");
    assert_eq!(meta["summary"]["state"], "awaiting");
    assert_eq!(meta["summary"]["height"], 1);
    assert_eq!(meta["summary"]["generation"], 1);
    assert_eq!(
        meta["summary"]["droppedIds"],
        serde_json::json!(["u1", "a1"])
    );
    let tiny = CompactionPolicy {
        max_summary_tokens: 1,
        ..policy
    };
    let plan = engine.compact_agent_messages(&messages, 30, &tiny, None);
    assert_eq!(plan.summary, "…");
    assert_eq!(
        plan.summary,
        engine
            .compact_agent_messages(&messages, 30, &tiny, None)
            .summary,
        "截断后依然确定性"
    );
}

#[test]
fn fold_chain_is_frozen_across_compactions() {
    let (engine, messages) = first_compaction_fixture();
    let policy = tail_keep_policy(&messages, 1);
    let first = engine.compact_agent_messages(&messages, 30, &policy, None);
    let chain_msg = first
        .messages
        .iter()
        .find(|m| m.id.starts_with("compacted-summary"))
        .expect("首压必须产出链消息");
    let chain_bytes = serde_json::to_string(&**chain_msg).expect("链消息可序列化");
    let mut conversation = first.messages.clone();
    push_long_turn(&mut conversation, "3");
    let policy = tail_keep_policy(&conversation, 1);
    let second = engine.compact_agent_messages(&conversation, 30, &policy, None);
    let chain_ids: Vec<&str> = second
        .messages
        .iter()
        .filter(|m| m.id.starts_with("compacted-summary"))
        .map(|m| m.id.as_str())
        .collect();
    assert_eq!(
        chain_ids,
        vec!["compacted-summary-1-1", "compacted-summary-1-2"]
    );
    let preserved = second
        .messages
        .iter()
        .find(|m| m.id == chain_msg.id)
        .expect("旧链消息必须保留");
    assert_eq!(
        serde_json::to_string(&**preserved).expect("链消息可序列化"),
        chain_bytes,
        "B1 冻结：链消息逐字节相同"
    );
    assert_eq!(second.messages[0].id, "s1");
    assert_eq!(second.first_kept_message_id.as_deref(), Some("u3"));
    assert_eq!(second.dropped_ids, vec!["u2", "a2"]);
}
