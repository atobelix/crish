use super::*;

use std::sync::atomic::{AtomicU32, Ordering};

use crate::ai_summary::{
    retry_allowed, summarize_with_guard, RetryGuardSummarizer, SummaryOutcome, SummaryRetryPolicy,
};
use crate::compaction::{CompactionEngine, CompactionPolicy};

// ── 重试决策（纯函数）──

#[test]
fn retry_allowed_respects_attempts_and_wall_clock() {
    let policy = SummaryRetryPolicy {
        max_attempts: 3,
        wall_clock_budget_ms: Some(1000),
        ..SummaryRetryPolicy::default()
    };
    // 次数：已用 1/2 次仍可重试，已用 3 次停
    assert!(retry_allowed(1, 0, &policy));
    assert!(retry_allowed(2, 0, &policy));
    assert!(!retry_allowed(3, 0, &policy));
    // 墙钟：预算内可、超预算停
    assert!(retry_allowed(1, 999, &policy));
    assert!(!retry_allowed(1, 1000, &policy));
    // 无墙钟上限
    let no_clock = SummaryRetryPolicy {
        wall_clock_budget_ms: None,
        ..SummaryRetryPolicy::default()
    };
    assert!(retry_allowed(2, u64::MAX, &no_clock));
    // max_attempts=0 钳到 1
    let zero = SummaryRetryPolicy {
        max_attempts: 0,
        wall_clock_budget_ms: None,
        ..SummaryRetryPolicy::default()
    };
    assert!(!retry_allowed(1, 0, &zero));
}

// ── 退化重试护栏 ──

/// 前 2 次退化（过短）、第 3 次成功 → 成功，attempts=3，退化计数 2
#[test]
fn guard_retries_degenerate_then_succeeds() {
    let summarizer = ScriptedSummarizer::new(vec![
        Ok("过短".to_string()),
        Ok("仍过短".to_string()),
        Ok(long_summary()),
    ]);
    let waits = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let waits_arc = waits.clone();
    let mut wait = move |duration: std::time::Duration| {
        waits_arc.lock().unwrap().push(duration);
    };
    let outcome = summarize_with_guard(
        &summarizer,
        &[],
        None,
        &SummaryRetryPolicy::default(),
        &mut wait,
    );
    assert!(!outcome.degraded);
    assert_eq!(outcome.attempts, 3);
    assert_eq!(outcome.degenerate_attempts, 2);
    assert!(outcome.summary.as_deref().unwrap().contains("压缩摘要"));
    assert!(outcome.last_error.is_none());
    // 两次等待均为 3s 间隔
    assert_eq!(
        waits.lock().unwrap().clone(),
        vec![
            std::time::Duration::from_millis(3_000),
            std::time::Duration::from_millis(3_000)
        ]
    );
}

/// 全部退化 → 降级（summary=None、degraded=true），不抛错
#[test]
fn guard_degrades_after_exhaustion() {
    let summarizer = ScriptedSummarizer::new(vec![
        Ok("退化一".to_string()),
        Ok("退化二".to_string()),
        Ok("退化三".to_string()),
    ]);
    let outcome = summarize_with_guard(
        &summarizer,
        &[],
        None,
        &SummaryRetryPolicy::default(),
        &mut empty_wait(),
    );
    assert!(outcome.degraded);
    assert_eq!(outcome.attempts, 3);
    assert_eq!(outcome.degenerate_attempts, 3);
    assert!(outcome.summary.is_none());
    assert!(outcome.last_error.unwrap().contains("退化"));
}

/// 连续失败（Err）→ 重试后仍失败 → 降级并记录原因
#[test]
fn guard_failing_summarizer_degrades_with_error() {
    let summarizer = ScriptedSummarizer::new(vec![
        Err("provider error".to_string()),
        Err("provider error".to_string()),
        Err("provider error".to_string()),
    ]);
    let outcome = summarize_with_guard(
        &summarizer,
        &[],
        None,
        &SummaryRetryPolicy::default(),
        &mut empty_wait(),
    );
    assert!(outcome.degraded);
    assert_eq!(outcome.attempts, 3);
    assert_eq!(outcome.last_error.as_deref(), Some("provider error"));
}

/// 首试成功不等待、不重试
#[test]
fn guard_first_attempt_success_no_retry() {
    let summarizer = ScriptedSummarizer::new(vec![Ok(long_summary())]);
    let wait_count = std::sync::Arc::new(AtomicU32::new(0));
    let counter = wait_count.clone();
    let mut wait = move |_: std::time::Duration| {
        counter.fetch_add(1, Ordering::SeqCst);
    };
    let outcome = summarize_with_guard(
        &summarizer,
        &[],
        None,
        &SummaryRetryPolicy::default(),
        &mut wait,
    );
    assert!(!outcome.degraded);
    assert_eq!(outcome.attempts, 1);
    assert_eq!(wait_count.load(Ordering::SeqCst), 0);
}

/// 重试次数可配：max_attempts=1 单次失败即降级（改策略后触发行为变化）
#[test]
fn guard_respects_configurable_max_attempts() {
    let policy = SummaryRetryPolicy {
        max_attempts: 1,
        wall_clock_budget_ms: None,
        ..SummaryRetryPolicy::default()
    };
    let summarizer = ScriptedSummarizer::new(vec![Ok("退化".to_string())]);
    let outcome = summarize_with_guard(&summarizer, &[], None, &policy, &mut empty_wait());
    assert!(outcome.degraded);
    assert_eq!(outcome.attempts, 1);
    // 同一输入换回默认策略（3 次）→ 全部退化仍降级，但次数为 3
    let summarizer = ScriptedSummarizer::new(vec![Ok("退化".to_string())]);
    let outcome = summarize_with_guard(
        &summarizer,
        &[],
        None,
        &SummaryRetryPolicy::default(),
        &mut empty_wait(),
    );
    assert!(outcome.degraded);
    assert_eq!(outcome.attempts, 3);
}

/// 墙钟预算为 0：一次尝试后立即降级
#[test]
fn guard_wall_clock_budget_zero_stops_immediately() {
    let policy = SummaryRetryPolicy {
        max_attempts: 10,
        wall_clock_budget_ms: Some(0),
        ..SummaryRetryPolicy::default()
    };
    let summarizer = ScriptedSummarizer::new(vec![Err("超时".to_string())]);
    let outcome = summarize_with_guard(&summarizer, &[], None, &policy, &mut empty_wait());
    assert!(outcome.degraded);
    assert_eq!(outcome.attempts, 1);
}

// ── RetryGuardSummarizer（Summarizer 包装，可注入引擎）──

/// 包装成功路径：引擎产出 LLM 摘要（Schema V1 文档 md 渲染），
/// last_outcome 留痕
#[test]
fn retry_guard_wrapper_success_into_engine() {
    let guard = RetryGuardSummarizer::new(
        Box::new(ScriptedSummarizer::new(vec![Ok(summary_doc_json(
            "实现双阈值压缩",
        ))])),
        SummaryRetryPolicy::default(),
        empty_wait(),
    );
    let engine = CompactionEngine::new(0);
    let messages = vec![
        amsg(
            "u1",
            AgentMessageRole::User,
            "2026-08-04T10:00:00.000Z",
            vec![text_block(&"长".repeat(100))],
        ),
        amsg(
            "a1",
            AgentMessageRole::Assistant,
            "2026-08-04T10:00:01.000Z",
            vec![text_block(&"长".repeat(100))],
        ),
        amsg(
            "u2",
            AgentMessageRole::User,
            "2026-08-04T10:00:02.000Z",
            vec![text_block("keep")],
        ),
        amsg(
            "a2",
            AgentMessageRole::Assistant,
            "2026-08-04T10:00:03.000Z",
            vec![text_block("keep")],
        ),
    ];
    let keep = crate::count_agent_message_tokens(&messages[2])
        + crate::count_agent_message_tokens(&messages[3]);
    let policy = CompactionPolicy {
        keep_recent_tokens: keep,
        min_recent_turns: 1,
        ..CompactionPolicy::default()
    };
    let plan = engine.compact_agent_messages(&messages, 5, &policy, Some(&guard));
    assert!(plan.summary_is_llm);
    // md 渲染投影进链（T-13：合法 JSON 文档 → summary_to_markdown）
    assert!(plan.summary.contains("## Goal"));
    assert!(plan.summary.contains("实现双阈值压缩"));
    // 摘要消息入对话（system 后、保留段前）
    assert!(plan
        .messages
        .iter()
        .any(|m| m.id.starts_with("compacted-summary")));
    // metadata 快照：LLM 成功 → committed
    let summary_msg = plan
        .messages
        .iter()
        .find(|m| m.id.starts_with("compacted-summary"))
        .expect("摘要消息须入对话");
    assert_eq!(
        summary_msg.metadata.as_ref().unwrap()["summary"]["state"],
        "committed"
    );
    // last_outcome 留痕（成功、无降级）
    let outcome = guard.last_outcome().expect("护栏须记录最近一次结果");
    assert!(!outcome.degraded);
    assert_eq!(outcome.attempts, 1);
}

/// 包装失败路径：连续失败 → Err → 引擎回退中性 stub（不阻塞 run），
/// last_outcome 记录降级事实
#[test]
fn retry_guard_wrapper_degrades_into_engine_placeholder() {
    let guard = RetryGuardSummarizer::new(
        Box::new(ScriptedSummarizer::new(vec![
            Err("provider error".to_string()),
            Err("provider error".to_string()),
            Err("provider error".to_string()),
        ])),
        SummaryRetryPolicy::default(),
        empty_wait(),
    );
    let engine = CompactionEngine::new(0);
    let messages = vec![
        amsg(
            "u1",
            AgentMessageRole::User,
            "2026-08-04T10:00:00.000Z",
            vec![text_block(&"长".repeat(100))],
        ),
        amsg(
            "a1",
            AgentMessageRole::Assistant,
            "2026-08-04T10:00:01.000Z",
            vec![text_block(&"长".repeat(100))],
        ),
        amsg(
            "u2",
            AgentMessageRole::User,
            "2026-08-04T10:00:02.000Z",
            vec![text_block("keep")],
        ),
        amsg(
            "a2",
            AgentMessageRole::Assistant,
            "2026-08-04T10:00:03.000Z",
            vec![text_block("keep")],
        ),
    ];
    let keep = crate::count_agent_message_tokens(&messages[2])
        + crate::count_agent_message_tokens(&messages[3]);
    let policy = CompactionPolicy {
        keep_recent_tokens: keep,
        min_recent_turns: 1,
        ..CompactionPolicy::default()
    };
    let plan = engine.compact_agent_messages(&messages, 5, &policy, Some(&guard));
    // 中性 stub 语义（T-13：R-C 永不改写；块 id + 丢弃数，无"生成中"措辞）
    assert!(!plan.summary_is_llm);
    assert!(
        plan.summary.contains("[Compacted(compacted-summary-1-1)"),
        "stub 须携带块 id：{}",
        plan.summary
    );
    assert!(plan.summary.contains("2 条消息"));
    assert!(!plan.summary.contains("生成中"));
    // 降级事实可读
    let outcome = guard.last_outcome().expect("护栏须记录最近一次结果");
    assert!(outcome.degraded);
    assert_eq!(outcome.attempts, 3);
    assert_eq!(outcome.last_error.as_deref(), Some("provider error"));
}

#[test]
fn summary_outcome_shape() {
    let outcome = SummaryOutcome {
        summary: None,
        degraded: true,
        attempts: 3,
        degenerate_attempts: 0,
        last_error: Some("x".to_string()),
    };
    assert!(outcome.degraded);
}
