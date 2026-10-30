mod common;

use common::{amsg, text_block, thought_block, usage_msg};
use conex_compaction::{
    count_agent_message_tokens, count_tokens, estimate_agent_context, estimate_context_tokens,
    should_compact, EstimateSource,
};
use conex_types::AgentMessageRole;

/// 时间戳护栏用例的毫秒常量（与消息 `created_at` 一一对应）：
/// `2026-08-03T10:00:01.500Z` / `2026-08-03T09:59:59.500Z`
const GUARD_BOUNDARY_MS: i64 = 1_785_751_201_500;
const GUARD_BEFORE_MS: i64 = 1_785_751_199_500;

#[test]
fn estimate_heuristic_mixed_ascii_cjk() {
    let messages = vec![
        amsg(
            "m1",
            AgentMessageRole::User,
            "2026-08-03T10:00:00.000Z",
            vec![text_block("你好世界 hello world")],
            None,
        ),
        amsg(
            "m2",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:01.000Z",
            vec![thought_block("思考过程"), text_block("Response text")],
            None,
        ),
    ];
    let expected =
        count_agent_message_tokens(&messages[0]) + count_agent_message_tokens(&messages[1]);
    let result = estimate_context_tokens(&messages, None, None, None);
    assert_eq!(result.source, EstimateSource::Heuristic);
    assert_eq!(result.tokens, expected as u64);
    assert_eq!(result.usage_message_id, None);
    assert!(count_tokens("你好世界") >= 4);
    assert!(count_tokens("abcd") <= 2);
}

#[test]
fn estimate_tools_system_counted_in_heuristic_only() {
    let messages = vec![amsg(
        "m1",
        AgentMessageRole::User,
        "2026-08-03T10:00:00.000Z",
        vec![text_block("hi")],
        None,
    )];
    let tools = r#"[{"type":"function","function":{"name":"read_file"}}]"#;
    let system = "You are a helpful assistant.";
    let heuristic = estimate_context_tokens(&messages, Some(tools), Some(system), None);
    assert_eq!(heuristic.source, EstimateSource::Heuristic);
    assert_eq!(
        heuristic.tokens,
        (count_agent_message_tokens(&messages[0]) + count_tokens(tools) + count_tokens(system))
            as u64
    );
}

#[test]
fn estimate_usage_priority_and_tail_heuristic() {
    let messages = vec![
        usage_msg("a1", "2026-08-03T10:00:00.000Z", 800, "first response"),
        amsg(
            "u2",
            AgentMessageRole::User,
            "2026-08-03T10:00:01.000Z",
            vec![text_block("tail message")],
            None,
        ),
    ];
    let result = estimate_context_tokens(&messages, None, None, None);
    assert_eq!(result.source, EstimateSource::Usage);
    assert_eq!(result.usage_message_id.as_deref(), Some("a1"));
    assert_eq!(
        result.tokens,
        800 + count_agent_message_tokens(&messages[1]) as u64
    );
}

#[test]
fn estimate_usage_ignores_aborted_and_zero_usage() {
    let messages = vec![
        usage_msg("a1", "2026-08-03T10:00:00.000Z", 500, "first"),
        amsg(
            "a2",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:01.000Z",
            vec![text_block("aborted")],
            Some(serde_json::json!({
                "aborted": true,
                "usage": { "promptTokens": 900 },
                "cacheBreakdown": { "inputTotal": 900, "read": 0, "write": 0, "miss": 900 },
            })),
        ),
    ];
    let result = estimate_context_tokens(&messages, None, None, None);
    assert_eq!(result.source, EstimateSource::Usage);
    assert_eq!(result.usage_message_id.as_deref(), Some("a1"));
    assert_eq!(
        result.tokens,
        500 + count_agent_message_tokens(&messages[1]) as u64
    );

    let messages = vec![amsg(
        "a3",
        AgentMessageRole::Assistant,
        "2026-08-03T10:00:02.000Z",
        vec![text_block("zero usage")],
        Some(serde_json::json!({
            "stopReason": "stop",
            "usage": { "promptTokens": 0 },
            "cacheBreakdown": { "inputTotal": 0, "read": 0, "write": 0, "miss": 0 },
        })),
    )];
    let result = estimate_context_tokens(&messages, None, None, None);
    assert_eq!(result.source, EstimateSource::Heuristic);
    assert_eq!(
        result.tokens,
        count_agent_message_tokens(&messages[0]) as u64
    );
}

#[test]
fn estimate_timestamp_guard_invalidates_stale_usage() {
    let messages = vec![usage_msg("a1", "2026-08-03T10:00:00.000Z", 800, "old")];
    let boundary = GUARD_BOUNDARY_MS;
    let result = estimate_context_tokens(&messages, None, None, Some(boundary));
    assert_eq!(result.source, EstimateSource::Heuristic);
    assert_eq!(result.usage_message_id, None);
    assert_eq!(
        result.tokens,
        count_agent_message_tokens(&messages[0]) as u64
    );

    let result = estimate_context_tokens(&messages, None, None, Some(GUARD_BEFORE_MS));
    assert_eq!(result.source, EstimateSource::Usage);
    assert_eq!(result.tokens, 800);
}

#[test]
fn estimate_agent_context_p4_compat_entry() {
    let messages = vec![
        usage_msg("a1", "2026-08-03T10:00:00.000Z", 300, "resp"),
        amsg(
            "u2",
            AgentMessageRole::User,
            "2026-08-03T10:00:01.000Z",
            vec![text_block("tail")],
            None,
        ),
    ];
    let result = estimate_agent_context(&messages, Some("a1"));
    assert_eq!(result.source, EstimateSource::Usage);
    assert_eq!(
        result.tokens,
        300 + count_agent_message_tokens(&messages[1]) as u64
    );

    let result = estimate_agent_context(&messages, Some("missing"));
    assert_eq!(result.source, EstimateSource::Heuristic);
}

#[test]
fn estimate_empty_messages() {
    let result = estimate_context_tokens(&[], None, None, None);
    assert_eq!(result.tokens, 0);
    assert_eq!(result.source, EstimateSource::Heuristic);
    assert_eq!(result.usage_message_id, None);

    let tools = "tools-json";
    let system = "system-prompt";
    let result = estimate_context_tokens(&[], Some(tools), Some(system), None);
    assert_eq!(
        result.tokens,
        (count_tokens(tools) + count_tokens(system)) as u64
    );
}

#[test]
fn should_compact_threshold() {
    assert!(!should_compact(999, 1000));
    assert!(should_compact(1000, 1000));
    assert!(should_compact(1001, 1000));
    let budget = 64_000u64 - 16_384u64;
    assert!(should_compact(budget, budget));
}
