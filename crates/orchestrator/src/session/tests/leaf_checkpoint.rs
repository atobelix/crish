use conex_types::checkpoint::{CheckpointPayload, LeafCheckpointState};

use super::*;

// ── C1 checkpoint 叶子 payload（M5A 最小落库面） ──

fn sample_checkpoint(target: &str) -> CheckpointPayload {
    CheckpointPayload {
        target: target.into(),
        summary: "基座完成".into(),
        timestamp: Some("2026-08-03T10:00:00.000Z".into()),
        completed: vec!["安装依赖".into()],
        files: vec!["crates/session-loop/src/safe_point.rs".into()],
        next: vec!["接线恢复注入".into()],
    }
}

/// 叶子 payload 读写往返：写入 checkpoint → 读回相等，payload
/// 其它字段不被触碰（最小落库面）
#[test]
fn leaf_checkpoint_write_read_roundtrip_preserves_other_fields() {
    let mut t = tree();
    t.append("leaf1", json!({ "text": "运行记录" })).unwrap();
    let checkpoint = sample_checkpoint("实现采集");
    t.set_leaf_checkpoint("leaf1", &checkpoint).unwrap();

    match t.read_leaf_checkpoint(Some("leaf1")) {
        LeafCheckpointState::Present(back) => assert_eq!(back, checkpoint),
        other => panic!("应读回有效检查点：{other:?}"),
    }
    // payload 其它字段原样保留
    let entry = t.entry("leaf1").expect("叶子存在");
    let SessionTreeEntryKind::Node { payload } = &entry.kind else {
        panic!("应为节点条目");
    };
    assert_eq!(payload["text"], "运行记录");
}

/// 无检查点回归：普通叶子 / 分支摘要 / 缺失叶子 → Absent（现状）
#[test]
fn leaf_checkpoint_absent_cases() {
    let mut t = tree();
    let (root, _mid, _leaf) = chain(&mut t);
    assert_eq!(
        t.read_leaf_checkpoint(Some(&root.id)),
        LeafCheckpointState::Absent,
        "无 checkpoint 键 → Absent"
    );
    let summary = t
        .abandon_branch_with_summary(None, "summary_1", "abandoned", None)
        .unwrap();
    assert_eq!(
        t.read_leaf_checkpoint(Some(summary.id())),
        LeafCheckpointState::Absent,
        "分支摘要条目 → Absent"
    );
    assert_eq!(
        t.read_leaf_checkpoint(Some("missing")),
        LeafCheckpointState::Absent,
        "缺失叶子 → Absent"
    );
    assert_eq!(
        t.read_leaf_checkpoint(None),
        LeafCheckpointState::Absent,
        "当前叶子（摘要条目）→ Absent"
    );
    // 值为 null → Absent（不是损坏）
    t.append("null_leaf", json!({ "checkpoint": null }))
        .unwrap();
    assert_eq!(
        t.read_leaf_checkpoint(Some("null_leaf")),
        LeafCheckpointState::Absent
    );
}

/// 损坏降级：checkpoint 值存在但解析失败 → Corrupt（不 panic）
#[test]
fn leaf_checkpoint_corrupt_degrades() {
    let mut t = tree();
    // 值类型错误（target 非字符串）
    t.append("bad1", json!({ "checkpoint": { "target": 123 } }))
        .unwrap();
    // 值非对象（字符串）
    t.append("bad2", json!({ "checkpoint": "oops" })).unwrap();
    for leaf in ["bad1", "bad2"] {
        match t.read_leaf_checkpoint(Some(leaf)) {
            LeafCheckpointState::Corrupt(reason) => {
                assert!(reason.contains("解析失败"), "损坏原因应可读：{reason}")
            }
            other => panic!("应降级为 Corrupt：{other:?}"),
        }
        assert_eq!(
            t.read_leaf_checkpoint(Some(leaf)).signal(),
            Some(conex_types::checkpoint::CHECKPOINT_CORRUPT_SIGNAL)
        );
    }
}

/// 写面校验：缺失叶子 → NotFound；分支摘要 / 非对象 payload →
/// InvalidState（写不坏树）
#[test]
fn leaf_checkpoint_write_rejects_invalid_targets() {
    let mut t = tree();
    chain(&mut t);
    let checkpoint = sample_checkpoint("目标");
    let err = t.set_leaf_checkpoint("missing", &checkpoint).unwrap_err();
    assert!(matches!(err, SessionTreeError::NotFound { .. }));

    let summary = t
        .abandon_branch_with_summary(None, "summary_1", "abandoned", None)
        .unwrap();
    let err = t
        .set_leaf_checkpoint(summary.id(), &checkpoint)
        .unwrap_err();
    assert!(matches!(err, SessionTreeError::InvalidState { .. }));

    t.append("text_payload", json!("just-a-string")).unwrap();
    let err = t
        .set_leaf_checkpoint("text_payload", &checkpoint)
        .unwrap_err();
    assert!(matches!(err, SessionTreeError::InvalidState { .. }));
}

/// 会话记录往返：带 checkpoint 的叶子经快照 serde 持久化后可读回
/// （叶子移动经 session-leaf-moved 事件重放的既有恢复面同构）
#[test]
fn leaf_checkpoint_survives_session_record_roundtrip() {
    let mut t = tree();
    t.append("leaf1", json!({ "text": "运行记录" })).unwrap();
    let checkpoint = sample_checkpoint("快照目标");
    t.set_leaf_checkpoint("leaf1", &checkpoint).unwrap();

    let json = serde_json::to_string(&t.to_session_record()).unwrap();
    let record: SessionRecord = serde_json::from_str(&json).unwrap();
    let restored = SessionTree::from_session_record(record).unwrap();
    match restored.read_leaf_checkpoint(Some("leaf1")) {
        LeafCheckpointState::Present(back) => assert_eq!(back, checkpoint),
        other => panic!("快照恢复后应读到检查点：{other:?}"),
    }
    assert_eq!(
        restored.read_leaf_checkpoint(None).signal(),
        Some(conex_types::checkpoint::CHECKPOINT_PRESENT_SIGNAL),
        "当前叶子即 checkpoint 叶子 → 优先恢复信号"
    );
}
