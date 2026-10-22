use super::*;

use crate::ai_summary::{compaction_event_details, covers_up_to_turn_for_dropped};

// ── covers_up_to_turn ──

#[test]
fn covers_up_to_turn_counts_dropped_user_turns() {
    let dropped = vec![
        amsg(
            "s1",
            AgentMessageRole::System,
            "2026-08-04T10:00:00.000Z",
            vec![text_block("system")],
        ),
        amsg(
            "u1",
            AgentMessageRole::User,
            "2026-08-04T10:00:01.000Z",
            vec![text_block("第一轮")],
        ),
        amsg(
            "a1",
            AgentMessageRole::Assistant,
            "2026-08-04T10:00:02.000Z",
            vec![text_block("答复一")],
        ),
        amsg(
            "u2",
            AgentMessageRole::User,
            "2026-08-04T10:00:03.000Z",
            vec![text_block("第二轮")],
        ),
        amsg(
            "a2",
            AgentMessageRole::Assistant,
            "2026-08-04T10:00:04.000Z",
            vec![text_block("答复二")],
        ),
    ];
    // 丢弃段含 u1/a1/u2/a2 → 覆盖到第 2 轮
    assert_eq!(covers_up_to_turn_for_dropped(&flat(&dropped)), Some(2));
    // 丢弃段无用户消息 → None
    let no_user = vec![amsg(
        "a1",
        AgentMessageRole::Assistant,
        "2026-08-04T10:00:00.000Z",
        vec![text_block("x")],
    )];
    assert_eq!(covers_up_to_turn_for_dropped(&flat(&no_user)), None);
    assert_eq!(covers_up_to_turn_for_dropped(&[]), None);
}

/// 事件 details 载荷：camelCase 字段、覆盖边界、降级与尝试次数留痕
#[test]
fn compaction_event_details_payload_shape() {
    let dropped = vec![
        amsg(
            "u1",
            AgentMessageRole::User,
            "2026-08-04T10:00:00.000Z",
            vec![text_block("第一轮")],
        ),
        amsg(
            "a1",
            AgentMessageRole::Assistant,
            "2026-08-04T10:00:01.000Z",
            vec![text_block("答复")],
        ),
    ];
    let value = compaction_event_details(&flat(&dropped), true, 3);
    let map = value.as_object().expect("载荷必须是 JSON 对象");
    assert_eq!(map.get("coversUpToTurn"), Some(&serde_json::json!(1)));
    assert_eq!(map.get("degraded"), Some(&serde_json::json!(true)));
    assert_eq!(map.get("summaryAttempts"), Some(&serde_json::json!(3)));
    assert_eq!(map.get("droppedCount"), Some(&serde_json::json!(2)));
    // 无可覆盖轮次 → null
    let value = compaction_event_details(&[], false, 1);
    assert_eq!(value.get("coversUpToTurn"), Some(&serde_json::Value::Null));
    // 序列化回环稳定（camelCase 字段名）
    let roundtrip: serde_json::Value =
        serde_json::from_str(&serde_json::to_string(&value).unwrap()).unwrap();
    assert_eq!(roundtrip, value);
}
