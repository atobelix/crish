mod common;

use common::{amsg, msg, summary_doc_json, text_block, tool_call_block, tool_result_block};
use conex_compaction::{
    count_agent_message_tokens, count_tokens, CompactionEngine, CompactionPolicy,
    CompactionThresholds, Summarizer, ThresholdDecision,
};
use conex_types::{AgentMessage, AgentMessageRole};

#[test]
fn compact_empty_messages() {
    let engine = CompactionEngine::new(1000);
    let result = engine.compact(&[]);
    assert!(result.messages.is_empty());
    assert_eq!(result.tokens_consumed, 0);
}

#[test]
fn compact_under_budget_no_change() {
    let engine = CompactionEngine::new(10000);
    let messages = vec![
        msg("1", "system", "You are helpful."),
        msg("2", "user", "Hello"),
        msg("3", "assistant", "Hi there!"),
    ];
    let result = engine.compact(&messages);
    assert_eq!(result.messages.len(), 3);
    assert!(result.cache_hit_rate_optimized);
}

#[test]
fn compact_over_budget_compresses_oldest() {
    let engine = CompactionEngine::new(20);
    let messages = vec![
        msg("1", "system", "System prompt"),
        msg(
            "2",
            "user",
            "First message with quite a lot of content that takes many tokens to represent",
        ),
        msg(
            "3",
            "assistant",
            "First response with quite a lot of content that takes many tokens to represent",
        ),
        msg(
            "4",
            "user",
            "Second message with substantial content for testing purposes",
        ),
        msg(
            "5",
            "assistant",
            "Second response with substantial content for testing purposes",
        ),
        msg("6", "user", "Latest question"),
        msg("7", "assistant", "Latest answer"),
    ];
    let result = engine.compact(&messages);

    assert!(result.messages.len() < messages.len());
    assert!(result.messages.iter().any(|m| m.role == "system"));
    assert!(result
        .messages
        .iter()
        .any(|m| m.content == "Latest question"));
    assert!(result.messages.iter().any(|m| m.content == "Latest answer"));
    assert!(result
        .messages
        .iter()
        .any(|m| m.content.contains("Compacted")));
}

#[test]
fn compact_preserves_system_messages() {
    let engine = CompactionEngine::new(30);
    let messages = vec![
        msg("s1", "system", "System A"),
        msg("s2", "system", "System B"),
        msg(
            "u1",
            "user",
            "A very long user message that exceeds the budget significantly",
        ),
        msg("a1", "assistant", "A very long assistant response"),
        msg("u2", "user", "Recent"),
    ];
    let result = engine.compact(&messages);
    let system_count = result
        .messages
        .iter()
        .filter(|m| m.role == "system")
        .count();
    assert_eq!(system_count, 2);
}

#[test]
fn compact_single_message_over_budget() {
    let engine = CompactionEngine::new(5);
    let messages = vec![msg(
        "1",
        "user",
        "This is a very long message that far exceeds the token budget",
    )];
    let result = engine.compact(&messages);
    assert!(!result.messages.is_empty());
}

#[test]
fn compact_empty_input() {
    let engine = CompactionEngine::new(0);
    let plan = engine.compact_agent_messages(&[], 100, &CompactionPolicy::default(), None);
    assert!(plan.messages.is_empty());
    assert_eq!(plan.tokens_before, 0);
    assert_eq!(plan.tokens_after, 0);
    assert!(plan.dropped_ids.is_empty());
    assert!(plan.summary.is_empty());
}

#[test]
fn compact_under_budget_returns_original() {
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
    let engine = CompactionEngine::new(0);
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
    let engine = CompactionEngine::new(0);
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
    let plan = engine.compact_agent_messages(&messages, 40, &policy, None);
    let ids: Vec<&str> = plan.messages.iter().map(|m| m.id.as_str()).collect();
    assert!(ids.contains(&"a1"), "tool-call 消息须保留");
    assert!(ids.contains(&"u2"), "tool-result 消息须保留");
    assert_eq!(plan.dropped_ids, vec!["u1"]);
    assert_eq!(plan.first_kept_message_id.as_deref(), Some("a1"));
}

#[test]
fn compact_abandons_when_orphan_unfixable() {
    let engine = CompactionEngine::new(0);
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
    let engine = CompactionEngine::new(0);
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
    let plan = engine.compact_agent_messages(&messages, 40, &policy, None);
    assert_eq!(plan.dropped_ids, vec!["u1", "a1"]);
    assert!(plan.messages.iter().any(|m| m.id == "u2"));
}

#[test]
fn compact_uses_summarizer_and_iterative_merge() {
    let engine = CompactionEngine::new(0);
    let messages = vec![
        amsg(
            "compacted-summary-1",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:00.000Z",
            vec![text_block("OLD SUMMARY")],
            None,
        ),
        amsg(
            "u1",
            AgentMessageRole::User,
            "2026-08-03T10:00:01.000Z",
            vec![text_block(&"long user".repeat(60))],
            None,
        ),
        amsg(
            "a1",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:02.000Z",
            vec![text_block(&"long asst".repeat(60))],
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
    struct RecordingSummarizer;
    impl Summarizer for RecordingSummarizer {
        fn summarize(
            &self,
            dropped: &[AgentMessage],
            existing: Option<&str>,
        ) -> Result<String, String> {
            assert_eq!(existing, Some("OLD SUMMARY"), "迭代合并须携带链尾既有摘要");
            assert_eq!(dropped.len(), 2, "链消息不进入摘要器（T-06）");
            Ok(summary_doc_json("合并 2 条丢弃消息"))
        }
    }
    let keep = count_agent_message_tokens(&messages[3]) + count_agent_message_tokens(&messages[4]);
    let policy = CompactionPolicy {
        keep_recent_tokens: keep,
        min_recent_turns: 1,
        ..CompactionPolicy::default()
    };
    let plan = engine.compact_agent_messages(&messages, 5, &policy, Some(&RecordingSummarizer));
    assert!(plan.summary_is_llm);
    assert!(
        plan.summary.contains("## Goal"),
        "md 渲染进链：{}",
        plan.summary
    );
    assert!(plan.summary.contains("合并 2 条丢弃消息"));
    let chain_ids: Vec<&str> = plan
        .messages
        .iter()
        .filter(|m| m.id.starts_with("compacted-summary"))
        .map(|m| m.id.as_str())
        .collect();
    assert_eq!(
        chain_ids,
        vec!["compacted-summary-1", "compacted-summary-1-2"],
        "既有链全保留 + 新摘要追加（T-08）"
    );
    let new_msg = plan
        .messages
        .iter()
        .find(|m| m.id == "compacted-summary-1-2")
        .expect("新摘要消息在场");
    assert_eq!(
        new_msg.metadata.as_ref().unwrap()["summary"]["state"],
        "committed"
    );
    assert_eq!(plan.fold_chain_prev, 1);
    assert_eq!(plan.fold_chain_after, 2);
    assert_eq!(plan.fold_index, 2);
    assert_eq!(plan.generation, 1);
    assert_eq!(plan.dropped_ids, vec!["u1", "a1"]);
}

#[test]
fn compact_summarizer_error_falls_back_to_stub() {
    let engine = CompactionEngine::new(0);
    let messages = vec![
        amsg(
            "u1",
            AgentMessageRole::User,
            "2026-08-03T10:00:00.000Z",
            vec![text_block(&"long".repeat(100))],
            None,
        ),
        amsg(
            "a1",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:01.000Z",
            vec![text_block(&"long".repeat(100))],
            None,
        ),
        amsg(
            "u2",
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
    struct FailingSummarizer;
    impl Summarizer for FailingSummarizer {
        fn summarize(
            &self,
            _dropped: &[AgentMessage],
            _existing: Option<&str>,
        ) -> Result<String, String> {
            Err("provider error".to_string())
        }
    }
    let keep = count_agent_message_tokens(&messages[2]) + count_agent_message_tokens(&messages[3]);
    let policy = CompactionPolicy {
        keep_recent_tokens: keep,
        min_recent_turns: 1,
        ..CompactionPolicy::default()
    };
    let plan = engine.compact_agent_messages(&messages, 5, &policy, Some(&FailingSummarizer));
    assert!(!plan.summary_is_llm);
    assert_eq!(
        plan.summary,
        "[Compacted(compacted-summary-1-1) 2 条消息 · 摘要见块表]"
    );
    let summary_msg = plan
        .messages
        .iter()
        .find(|m| m.id.starts_with("compacted-summary"))
        .expect("stub 消息须入对话");
    assert_eq!(
        summary_msg.metadata.as_ref().unwrap()["summary"]["state"],
        "awaiting"
    );
}

#[test]
fn compact_summary_capped_by_max_summary_tokens() {
    let engine = CompactionEngine::new(0);
    let messages = vec![
        amsg(
            "u1",
            AgentMessageRole::User,
            "2026-08-03T10:00:00.000Z",
            vec![text_block(&"long".repeat(100))],
            None,
        ),
        amsg(
            "a1",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:01.000Z",
            vec![text_block(&"long".repeat(100))],
            None,
        ),
        amsg(
            "u2",
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
    let keep = count_agent_message_tokens(&messages[2]) + count_agent_message_tokens(&messages[3]);
    let policy = CompactionPolicy {
        keep_recent_tokens: keep,
        min_recent_turns: 1,
        max_summary_tokens: 1,
        ..CompactionPolicy::default()
    };
    let plan = engine.compact_agent_messages(&messages, 5, &policy, None);
    assert_eq!(plan.summary, "…");
    assert!(count_tokens(&plan.summary) <= 1);
}

#[test]
fn compact_system_messages_always_kept() {
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

#[test]
fn critical_line_hard_compression_deterministic_placeholder() {
    let engine = CompactionEngine::new(0);
    let messages = vec![
        amsg(
            "s1",
            AgentMessageRole::System,
            "2026-08-04T10:00:00.000Z",
            vec![text_block("system")],
            None,
        ),
        amsg(
            "u1",
            AgentMessageRole::User,
            "2026-08-04T10:00:01.000Z",
            vec![text_block(&"长".repeat(200))],
            None,
        ),
        amsg(
            "a1",
            AgentMessageRole::Assistant,
            "2026-08-04T10:00:02.000Z",
            vec![text_block(&"长".repeat(200))],
            None,
        ),
        amsg(
            "u2",
            AgentMessageRole::User,
            "2026-08-04T10:00:03.000Z",
            vec![text_block("keep")],
            None,
        ),
        amsg(
            "a2",
            AgentMessageRole::Assistant,
            "2026-08-04T10:00:04.000Z",
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
    let window = 1_000u64;
    let estimate = 960u64;
    assert_eq!(
        CompactionThresholds::default().classify(estimate, window),
        ThresholdDecision::Critical
    );
    let plan = engine.compact_agent_messages(&messages, 5, &policy, None);
    assert!(!plan.summary_is_llm);
    assert_eq!(
        plan.summary,
        "[Compacted(compacted-summary-1-1) 2 条消息 · 摘要见块表]"
    );
    assert!(plan.tokens_after < plan.tokens_before);
}

#[test]
fn regular_line_ai_summary_document_into_conversation() {
    let engine = CompactionEngine::new(0);
    let messages = vec![
        amsg(
            "u1",
            AgentMessageRole::User,
            "2026-08-04T10:00:00.000Z",
            vec![text_block(&"长".repeat(200))],
            None,
        ),
        amsg(
            "a1",
            AgentMessageRole::Assistant,
            "2026-08-04T10:00:01.000Z",
            vec![text_block(&"长".repeat(200))],
            None,
        ),
        amsg(
            "u2",
            AgentMessageRole::User,
            "2026-08-04T10:00:02.000Z",
            vec![text_block("keep")],
            None,
        ),
        amsg(
            "a2",
            AgentMessageRole::Assistant,
            "2026-08-04T10:00:03.000Z",
            vec![text_block("keep")],
            None,
        ),
    ];
    let keep = count_agent_message_tokens(&messages[2]) + count_agent_message_tokens(&messages[3]);
    let policy = CompactionPolicy {
        keep_recent_tokens: keep,
        min_recent_turns: 1,
        ..CompactionPolicy::default()
    };
    assert_eq!(
        CompactionThresholds::default().classify(900, 1_000),
        ThresholdDecision::Regular
    );
    struct AiSummarizer;
    impl Summarizer for AiSummarizer {
        fn summarize(
            &self,
            _dropped: &[AgentMessage],
            _existing: Option<&str>,
        ) -> Result<String, String> {
            Ok(summary_doc_json("压缩升级"))
        }
    }
    let plan = engine.compact_agent_messages(&messages, 5, &policy, Some(&AiSummarizer));
    assert!(plan.summary_is_llm);
    assert!(plan.summary.contains("## Goal"));
    assert!(plan.summary.contains("压缩升级"));
    let summary_msg = plan
        .messages
        .iter()
        .find(|m| m.id.starts_with("compacted-summary"))
        .expect("摘要消息须入对话");
    assert_eq!(summary_msg.text(), plan.summary);
    assert_eq!(
        summary_msg.metadata.as_ref().unwrap()["summary"]["state"],
        "committed"
    );
    assert_eq!(plan.dropped_ids, vec!["u1", "a1"]);
    assert!(plan.tokens_after < plan.tokens_before);
}

#[test]
fn system_never_compressed_on_ai_path() {
    let engine = CompactionEngine::new(0);
    let injected = "## Agent 定义\nagent-body";
    let messages = vec![
        amsg(
            "s1",
            AgentMessageRole::System,
            "2026-08-04T10:00:00.000Z",
            vec![text_block(injected)],
            None,
        ),
        amsg(
            "u1",
            AgentMessageRole::User,
            "2026-08-04T10:00:01.000Z",
            vec![text_block(&"长".repeat(200))],
            None,
        ),
        amsg(
            "a1",
            AgentMessageRole::Assistant,
            "2026-08-04T10:00:02.000Z",
            vec![text_block(&"长".repeat(200))],
            None,
        ),
        amsg(
            "u2",
            AgentMessageRole::User,
            "2026-08-04T10:00:03.000Z",
            vec![text_block("keep")],
            None,
        ),
        amsg(
            "a2",
            AgentMessageRole::Assistant,
            "2026-08-04T10:00:04.000Z",
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
    struct AiSummarizer;
    impl Summarizer for AiSummarizer {
        fn summarize(
            &self,
            _dropped: &[AgentMessage],
            _existing: Option<&str>,
        ) -> Result<String, String> {
            Ok(summary_doc_json("x"))
        }
    }
    let plan = engine.compact_agent_messages(&messages, 5, &policy, Some(&AiSummarizer));
    assert_eq!(plan.messages[0].id, "s1", "system 恒在输出最前");
    assert_eq!(plan.messages[0].text(), injected, "注入段字节原样保留");
    assert!(!plan.dropped_ids.iter().any(|id| id == "s1"));
    assert!(!plan.summary.contains("## Agent 定义"));
}

#[test]
fn test_post_append_emergency_preflight() {
    let engine = CompactionEngine::new(0);

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
