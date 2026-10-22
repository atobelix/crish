use conex_types::message::{AgentMessageBlock, AgentMessageRole};

use super::super::hydrate_history;
use super::super::time_text::iso8601_from_epoch_millis;
use super::{ids, msg};

#[test]
fn user_and_assistant_map_to_correct_roles() {
    let history = vec![
        msg("u1", "user", Some("你好"), None),
        msg("a1", "assistant", Some("回复"), Some("completed")),
        msg("u3", "user", Some("确认"), None),
    ];
    let hydrated = hydrate_history(history);
    assert_eq!(hydrated.len(), 3);
    assert_eq!(hydrated[0].role, AgentMessageRole::User);
    assert_eq!(hydrated[1].role, AgentMessageRole::Assistant);
    assert_eq!(hydrated[2].role, AgentMessageRole::User);
    // 正文块 + content 兜底
    assert_eq!(
        hydrated[0].blocks,
        vec![AgentMessageBlock::Text {
            text: "你好".into()
        }]
    );
    assert_eq!(hydrated[0].content.as_deref(), Some("你好"));
    assert_eq!(hydrated[1].content.as_deref(), Some("回复"));
    // metadata 裁剪 + 幂等键对齐
    assert!(hydrated[0].metadata.is_none());
    assert!(hydrated[1].metadata.is_none());
    assert_eq!(hydrated[0].client_message_id.as_deref(), Some("u1"));
    assert_eq!(hydrated[1].client_message_id.as_deref(), Some("a1"));
    // 时间戳 → created_at（ISO8601 毫秒精度）
    assert_eq!(hydrated[0].created_at, "2023-11-14T22:13:20.000Z");
}

#[test]
fn incomplete_status_entries_skipped() {
    let history = vec![
        msg("a", "user", Some("进"), Some("completed")),
        msg("b", "user", Some("跳过"), Some("processing")),
        msg("c", "user", Some("跳过"), Some("streaming")),
        msg("d", "user", Some("跳过"), Some("queued")),
        msg("e", "user", Some("进"), Some("error")),
        msg("f", "user", Some("跳过"), Some("")),
        msg("g", "user", Some("旧数据兼容"), None),
    ];
    assert_eq!(ids(&hydrate_history(history)), ["a", "e", "g"]);
}

#[test]
fn error_status_hydrates_with_failed_turn_marker() {
    let history = vec![
        msg("u1", "user", Some("开始"), None),
        msg("f1", "assistant", Some("失败轮的部分产出"), Some("error")),
        msg("u2", "user", Some("继续"), Some("completed")),
    ];
    let hydrated = hydrate_history(history);
    assert_eq!(ids(&hydrated), ["u1", "f1", "u2"]);
    assert_eq!(
        hydrated[1].metadata.as_ref(),
        Some(&serde_json::json!({ "kind": "failed-turn" }))
    );
    assert!(hydrated[0].metadata.is_none());
    assert!(hydrated[2].metadata.is_none());
}

#[test]
fn unknown_sender_and_empty_content_skipped() {
    let history = vec![
        msg("s1", "system", Some("瞬态角色不进"), None),
        msg("t1", "tool", Some("工具角色不进"), None),
        msg("e1", "user", None, None),
        msg("e2", "assistant", None, None),
        msg("ok", "user", Some("正常"), None),
    ];
    assert_eq!(ids(&hydrate_history(history)), ["ok"]);
}

#[test]
fn timestamp_out_of_order_keeps_array_order() {
    let mut m1 = msg("m1", "user", Some("q1"), None);
    m1.timestamp = 300;
    let mut m2 = msg("m2", "assistant", Some("r1"), None);
    m2.timestamp = 100;
    let mut m3 = msg("m3", "user", Some("q2"), None);
    m3.timestamp = 200;
    let hydrated = hydrate_history(vec![m1, m2, m3]);
    assert_eq!(ids(&hydrated), ["m1", "m2", "m3"]);
    assert_eq!(hydrated[1].created_at, iso8601_from_epoch_millis(100));
}

#[test]
fn empty_history_yields_empty() {
    assert!(hydrate_history(Vec::new()).is_empty());
}

#[test]
fn created_at_derived_from_epoch_millis() {
    assert_eq!(
        iso8601_from_epoch_millis(1_785_456_000_000),
        "2026-07-31T00:00:00.000Z"
    );
    assert_eq!(
        iso8601_from_epoch_millis(1_785_456_000_123),
        "2026-07-31T00:00:00.123Z"
    );
}

/// 多模态图片块全保真水合验证
#[test]
fn test_multimodal_image_blocks_hydrated() {
    let mut u1 = msg("u1", "user", None, Some("completed"));
    u1.blocks_json = Some(
        r#"[
        {"type":"text","text":"看这张图"},
        {"type":"image","mimeType":"image/png","url":"https://example.com/pic.png","alt":"示例图"}
    ]"#
        .into(),
    );

    let history = vec![
        u1,
        msg("a1", "assistant", Some("我看到了示例图"), Some("completed")),
    ];
    let hydrated = hydrate_history(history);
    assert_eq!(hydrated.len(), 2);
    assert_eq!(hydrated[0].blocks.len(), 2);
    match &hydrated[0].blocks[1] {
        AgentMessageBlock::Image(img) => {
            assert_eq!(img.mime_type, "image/png");
            assert_eq!(img.url.as_deref(), Some("https://example.com/pic.png"));
            assert_eq!(img.alt.as_deref(), Some("示例图"));
        }
        other => panic!("预期 Image 块，得到 {other:?}"),
    }
    assert_eq!(hydrated[1].text(), "我看到了示例图");
}
