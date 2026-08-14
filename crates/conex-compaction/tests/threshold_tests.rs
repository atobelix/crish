mod common;

use common::{amsg, text_block, thought_block, usage_msg};
use conex_compaction::thresholds::parse_iso8601_epoch_ms;
use conex_compaction::{
    count_agent_message_tokens, count_tokens, CompactionEngine, CompactionThresholds,
    EstimateSource, ThresholdDecision, COMPACT_CRITICAL_RATIO_DEFAULT,
    COMPACT_THRESHOLD_RATIO_DEFAULT,
};
use conex_types::AgentMessageRole;

fn parse_ms(value: &str) -> i64 {
    parse_iso8601_epoch_ms(value).expect("测试时间戳可解析")
}

#[test]
fn estimate_heuristic_mixed_ascii_cjk() {
    let engine = CompactionEngine::new(0);
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
    let result = engine.estimate_context_tokens(&messages, None, None, None);
    assert_eq!(result.source, EstimateSource::Heuristic);
    assert_eq!(result.tokens, expected as u64);
    assert_eq!(result.usage_message_id, None);
    assert!(count_tokens("你好世界") >= 4);
    assert!(count_tokens("abcd") <= 2);
}

#[test]
fn estimate_tools_system_counted_in_heuristic_only() {
    let engine = CompactionEngine::new(0);
    let messages = vec![amsg(
        "m1",
        AgentMessageRole::User,
        "2026-08-03T10:00:00.000Z",
        vec![text_block("hi")],
        None,
    )];
    let tools = r#"[{"type":"function","function":{"name":"read_file"}}]"#;
    let system = "You are a helpful assistant.";
    let heuristic = engine.estimate_context_tokens(&messages, Some(tools), Some(system), None);
    assert_eq!(heuristic.source, EstimateSource::Heuristic);
    assert_eq!(
        heuristic.tokens,
        (count_agent_message_tokens(&messages[0]) + count_tokens(tools) + count_tokens(system))
            as u64
    );
}

#[test]
fn estimate_usage_priority_and_tail_heuristic() {
    let engine = CompactionEngine::new(0);
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
    let result = engine.estimate_context_tokens(&messages, None, None, None);
    assert_eq!(result.source, EstimateSource::Usage);
    assert_eq!(result.usage_message_id.as_deref(), Some("a1"));
    assert_eq!(
        result.tokens,
        800 + count_agent_message_tokens(&messages[1]) as u64
    );
}

#[test]
fn estimate_usage_ignores_aborted_and_zero_usage() {
    let engine = CompactionEngine::new(0);
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
    let result = engine.estimate_context_tokens(&messages, None, None, None);
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
    let result = engine.estimate_context_tokens(&messages, None, None, None);
    assert_eq!(result.source, EstimateSource::Heuristic);
    assert_eq!(
        result.tokens,
        count_agent_message_tokens(&messages[0]) as u64
    );
}

#[test]
fn estimate_timestamp_guard_invalidates_stale_usage() {
    let engine = CompactionEngine::new(0);
    let messages = vec![usage_msg("a1", "2026-08-03T10:00:00.000Z", 800, "old")];
    let boundary = parse_ms("2026-08-03T10:00:01.500Z");
    let result = engine.estimate_context_tokens(&messages, None, None, Some(boundary));
    assert_eq!(result.source, EstimateSource::Heuristic);
    assert_eq!(result.usage_message_id, None);
    assert_eq!(
        result.tokens,
        count_agent_message_tokens(&messages[0]) as u64
    );

    let result = engine.estimate_context_tokens(
        &messages,
        None,
        None,
        Some(parse_ms("2026-08-03T09:59:59.500Z")),
    );
    assert_eq!(result.source, EstimateSource::Usage);
    assert_eq!(result.tokens, 800);
}

#[test]
fn estimate_agent_context_p4_compat_entry() {
    let engine = CompactionEngine::new(0);
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
    let result = engine.estimate_agent_context(&messages, Some("a1"));
    assert_eq!(result.source, EstimateSource::Usage);
    assert_eq!(
        result.tokens,
        300 + count_agent_message_tokens(&messages[1]) as u64
    );

    let result = engine.estimate_agent_context(&messages, Some("missing"));
    assert_eq!(result.source, EstimateSource::Heuristic);
}

#[test]
fn estimate_empty_messages() {
    let engine = CompactionEngine::new(0);
    let result = engine.estimate_context_tokens(&[], None, None, None);
    assert_eq!(result.tokens, 0);
    assert_eq!(result.source, EstimateSource::Heuristic);
    assert_eq!(result.usage_message_id, None);

    let tools = "tools-json";
    let system = "system-prompt";
    let result = engine.estimate_context_tokens(&[], Some(tools), Some(system), None);
    assert_eq!(
        result.tokens,
        (count_tokens(tools) + count_tokens(system)) as u64
    );
}

#[test]
fn parse_iso8601_timestamp() {
    assert_eq!(
        parse_iso8601_epoch_ms("2026-08-03T12:00:00.000Z"),
        Some(1_785_758_400_000i64)
    );
    assert_eq!(
        parse_iso8601_epoch_ms("2026-08-03T12:00:00Z"),
        Some(1_785_758_400_000i64)
    );
    assert_eq!(
        parse_iso8601_epoch_ms("2026-08-03T12:00:00.999Z"),
        Some(1_785_758_400_999i64)
    );
    assert_eq!(parse_iso8601_epoch_ms(""), None);
    assert_eq!(parse_iso8601_epoch_ms("2026-08-03 12:00:00Z"), None);
    assert_eq!(parse_iso8601_epoch_ms("2026-13-03T12:00:00Z"), None);
    assert_eq!(parse_iso8601_epoch_ms("2026-08-03T12:00:00+08:00"), None);
}

#[test]
fn should_compact_threshold() {
    let engine = CompactionEngine::new(0);
    assert!(!engine.should_compact(999, 1000));
    assert!(engine.should_compact(1000, 1000));
    assert!(engine.should_compact(1001, 1000));
    let budget = 64_000u64 - 16_384u64;
    assert!(engine.should_compact(budget, budget));
}

#[test]
fn threshold_classification_regular_and_critical() {
    let thresholds = CompactionThresholds::default();
    let window = 100_000u64;
    assert_eq!(
        thresholds.classify(0, window),
        ThresholdDecision::UnderBudget
    );
    assert_eq!(
        thresholds.classify(84_999, window),
        ThresholdDecision::UnderBudget
    );
    assert_eq!(
        thresholds.classify(85_000, window),
        ThresholdDecision::Regular
    );
    assert_eq!(
        thresholds.classify(94_999, window),
        ThresholdDecision::Regular
    );
    assert_eq!(
        thresholds.classify(95_000, window),
        ThresholdDecision::Critical
    );
    assert_eq!(
        thresholds.classify(100_000, window),
        ThresholdDecision::Critical
    );
    assert_eq!(
        thresholds.classify(200_000, window),
        ThresholdDecision::Critical
    );
    assert_eq!(thresholds.classify(1, 0), ThresholdDecision::Critical);
}

#[test]
fn threshold_configurable_ratios_change_decision() {
    let window = 100_000u64;
    let custom = CompactionThresholds {
        regular_ratio: 0.70,
        critical_ratio: 0.90,
    };
    assert_eq!(
        custom.classify(60_000, window),
        ThresholdDecision::UnderBudget
    );
    assert_eq!(custom.classify(80_000, window), ThresholdDecision::Regular);
    assert_eq!(custom.classify(95_000, window), ThresholdDecision::Critical);
    assert_eq!(
        CompactionThresholds::default().classify(80_000, window),
        ThresholdDecision::UnderBudget
    );
    let clamped = CompactionThresholds {
        regular_ratio: 0.85,
        critical_ratio: 0.5,
    };
    assert_eq!(clamped.normalized().critical_ratio, 0.85);
}

#[test]
fn threshold_defaults_matched() {
    let thresholds = CompactionThresholds::default();
    assert_eq!(thresholds.regular_ratio, COMPACT_THRESHOLD_RATIO_DEFAULT);
    assert_eq!(thresholds.critical_ratio, COMPACT_CRITICAL_RATIO_DEFAULT);
    assert_eq!(COMPACT_THRESHOLD_RATIO_DEFAULT, 0.85);
    assert_eq!(COMPACT_CRITICAL_RATIO_DEFAULT, 0.95);
}
