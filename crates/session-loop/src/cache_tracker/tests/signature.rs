use conex_types::message::AgentMessageRole;

use super::{msg, tools, tracker};
use crate::cache_tracker::hash::build_request_signature;
use crate::provider::ToolSchema;

/// 投影剔除 created_at / metadata / client_message_id / content（P5 §3.4.1）：
/// 同 role + 同 blocks 内容的消息，时间戳与元数据差异不改变哈希
#[test]
fn signature_capture_ignores_timestamps_and_metadata() {
    let a = msg("m1", AgentMessageRole::User, "你好", "2026-01-01T00:00:00Z");
    let b = msg("m1", AgentMessageRole::User, "你好", "2026-01-02T00:00:00Z");
    let sig_a = build_request_signature(Some("sys"), &tools(), &[a]);
    let sig_b = build_request_signature(Some("sys"), &tools(), &[b]);
    assert_eq!(sig_a, sig_b, "时间戳 / 元数据不得进入签名");
}

/// 内容变化可检测：system / 消息正文变化分别改变对应哈希
#[test]
fn signature_capture_detects_system_and_message_changes() {
    let m = msg("m1", AgentMessageRole::User, "你好", "2026-01-01T00:00:00Z");
    let base = build_request_signature(Some("sys"), &tools(), std::slice::from_ref(&m));
    let other_system = build_request_signature(Some("sys2"), &tools(), std::slice::from_ref(&m));
    assert_ne!(base.system_hash, other_system.system_hash);
    let other_text = build_request_signature(
        Some("sys"),
        &tools(),
        &[msg(
            "m1",
            AgentMessageRole::User,
            "你好啊",
            "2026-01-01T00:00:00Z",
        )],
    );
    assert_ne!(base.messages_hash, other_text.messages_hash);
    assert_ne!(base.message_hashes[0], other_text.message_hashes[0]);
    // 前缀对比：第二条消息被改写 → 前缀被改
    let m2 = msg(
        "m2",
        AgentMessageRole::Assistant,
        "回复",
        "2026-01-01T00:00:00Z",
    );
    let with_m2 = build_request_signature(Some("sys"), &tools(), &[m.clone(), m2.clone()]);
    let rewritten = build_request_signature(
        Some("sys"),
        &tools(),
        &[
            m.clone(),
            msg(
                "m2",
                AgentMessageRole::Assistant,
                "改写",
                "2026-01-01T00:00:00Z",
            ),
        ],
    );
    assert!(with_m2.messages_prefix_changed(&rewritten));
}

/// 确定性：同输入两次捕获结果一致（稳定哈希）
#[test]
fn signature_capture_is_deterministic() {
    let m = msg("m1", AgentMessageRole::User, "你好", "2026-01-01T00:00:00Z");
    let a = build_request_signature(Some("sys"), &tools(), std::slice::from_ref(&m));
    let b = build_request_signature(Some("sys"), &tools(), &[m]);
    assert_eq!(a, b);
}

/// 工具集合哈希：投影包含工具名 / 描述 / schema（顺序敏感——排序稳定
/// 由 P1 T-01 保证）
#[test]
fn signature_capture_hashes_tool_set() {
    let m = msg("m1", AgentMessageRole::User, "你好", "2026-01-01T00:00:00Z");
    let base = build_request_signature(Some("sys"), &tools(), std::slice::from_ref(&m));
    let other_tool = build_request_signature(
        Some("sys"),
        &[ToolSchema {
            name: "t2".to_string(),
            description: "另一个工具".to_string(),
            input_schema: serde_json::json!({ "type": "object" }),
        }],
        &[m],
    );
    assert_ne!(base.tools_hash, other_tool.tools_hash);
}

/// 增量签名与全量签名结果恒等：system/tools 不变、消息追加场景，
/// 第二轮 `capture_signature` 走增量路径，签名与全量重算一致。
#[test]
fn incremental_signature_matches_full_on_append() {
    let m1 = msg("m1", AgentMessageRole::User, "你好", "2026-01-01T00:00:00Z");
    let m2 = msg(
        "m2",
        AgentMessageRole::Assistant,
        "回复",
        "2026-01-01T00:00:00Z",
    );
    // 首轮（全量）
    let mut t = tracker(0);
    t.capture_signature(Some("sys"), &tools(), std::slice::from_ref(&m1));
    let sig_after_first = t.pending_signature.clone().unwrap();
    // 第二轮（追加 m2）走增量
    t.capture_signature(Some("sys"), &tools(), &[m1.clone(), m2.clone()]);
    let sig_incremental = t.pending_signature.clone().unwrap();
    // 对照：全量重算
    let sig_full = build_request_signature(Some("sys"), &tools(), &[m1, m2]);
    assert_eq!(sig_incremental, sig_full, "增量签名必须与全量签名一致");
    assert_eq!(sig_after_first.message_count, 1);
    assert_eq!(sig_incremental.message_count, 2);
}

/// system 变化 → 增量不适用，回退全量重算（结果与全量一致）。
#[test]
fn incremental_signature_falls_back_when_system_changes() {
    let m1 = msg("m1", AgentMessageRole::User, "你好", "2026-01-01T00:00:00Z");
    let m2 = msg("m2", AgentMessageRole::User, "追加", "2026-01-01T00:00:00Z");
    let mut t = tracker(0);
    t.capture_signature(Some("sys"), &tools(), std::slice::from_ref(&m1));
    t.capture_signature(Some("sys2"), &tools(), &[m1.clone(), m2.clone()]);
    let sig = t.pending_signature.clone().unwrap();
    let full = build_request_signature(Some("sys2"), &tools(), &[m1, m2]);
    assert_eq!(sig, full, "system 变化后应回退全量重算");
}

/// 消息缩减（prev_count > messages.len()）→ 增量不适用，回退全量。
#[test]
fn incremental_signature_falls_back_when_messages_shrink() {
    let m1 = msg("m1", AgentMessageRole::User, "你好", "2026-01-01T00:00:00Z");
    let m2 = msg("m2", AgentMessageRole::User, "追加", "2026-01-01T00:00:00Z");
    let mut t = tracker(0);
    t.capture_signature(Some("sys"), &tools(), std::slice::from_ref(&m1));
    t.capture_signature(Some("sys"), &tools(), &[m1.clone(), m2.clone()]);
    // 第二轮消息比首轮少 → prev_count(2) > len(1) → 回退全量
    t.capture_signature(Some("sys"), &tools(), std::slice::from_ref(&m1));
    let sig = t.pending_signature.clone().unwrap();
    let full = build_request_signature(Some("sys"), &tools(), &[m1]);
    assert_eq!(sig, full, "消息缩减应回退全量重算");
}
