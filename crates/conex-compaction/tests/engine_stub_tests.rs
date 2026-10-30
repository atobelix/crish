//! 摘要（stub / LLM 文档 / 折叠链）主题用例。

mod common;

use common::{amsg, summary_doc_json, text_block};
use conex_compaction::{
    count_agent_message_tokens, count_tokens, CompactionEngine, CompactionPolicy, Summarizer,
};
use conex_types::message::{AgentMessage, AgentMessageRole};

#[test]
fn compact_uses_summarizer_and_iterative_merge() {
    let engine = CompactionEngine::new();
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
fn critical_line_hard_compression_deterministic_placeholder() {
    let engine = CompactionEngine::new();
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
    // 场景口径：estimate/window = 0.96 属调用方的临界水位触发
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
    let engine = CompactionEngine::new();
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
    // 场景口径：estimate/window = 0.90 属调用方的常规水位触发
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
    let engine = CompactionEngine::new();
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
