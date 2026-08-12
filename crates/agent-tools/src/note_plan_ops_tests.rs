//! Memory plan 规划期失败分支 / 成功路径单测（**SD-14** 旁挂；**≠ EL-05**）
//!
//! 经 [`super::plan_block_ops`] 单入口；语义与切开前一致。

use super::*;
use crate::note_types::{NoteBlockOp, NoteBlockOpKind};
use serde_json::Map;

fn seed_p1() -> Vec<MemBlock> {
    vec![MemBlock {
        id: "p1".into(),
        kind: "paragraph".into(),
        text: "keep".into(),
        attrs: Map::new(),
        refs_to: Vec::new(),
        level: 0,
    }]
}

/// plan：预分配 id 已存在 → IdConflict（不修改输入切片）
#[test]
fn plan_block_ops_id_conflict() {
    let existing = seed_p1();
    let ops = [NoteBlockOp {
        op: NoteBlockOpKind::Insert,
        id: Some("p1".into()),
        parent_id: None,
        previous_id: None,
        content: Some("dup".into()),
        kind: Some("paragraph".into()),
        attrs: None,
    }];
    let err = plan_block_ops(Some(&existing), &ops, || "gen".into()).unwrap_err();
    assert!(matches!(err, NoteBackendError::IdConflict(_)));
    assert_eq!(err.code(), "note.id_conflict");
    // 输入权威树未变（plan 仅用副本）
    assert_eq!(existing.len(), 1);
}

/// plan：previous_id 不存在 → NotFound
#[test]
fn plan_block_ops_previous_not_found() {
    let existing = seed_p1();
    let ops = [NoteBlockOp {
        op: NoteBlockOpKind::Insert,
        id: None,
        parent_id: None,
        previous_id: Some("ghost".into()),
        content: Some("x".into()),
        kind: None,
        attrs: None,
    }];
    let err = plan_block_ops(Some(&existing), &ops, || "n1".into()).unwrap_err();
    assert!(matches!(err, NoteBackendError::NotFound(_)));
    assert!(err.message().contains("previous_id"));
}

/// plan 成功 + apply：insert 落盘；失败路径不调用 apply
#[test]
fn plan_and_apply_insert_commits() {
    let mut doc = MemDoc {
        blocks: seed_p1(),
    };
    let ops = [NoteBlockOp {
        op: NoteBlockOpKind::Insert,
        id: Some("p2".into()),
        parent_id: None,
        previous_id: Some("p1".into()),
        content: Some("new".into()),
        kind: Some("paragraph".into()),
        attrs: None,
    }];
    let plan = plan_block_ops(Some(&doc.blocks), &ops, || "unused".into()).unwrap();
    assert_eq!(plan.block_ids, vec!["p2".to_string()]);
    apply_planned_ops(&mut doc, plan.mutations).unwrap();
    assert_eq!(doc.blocks.len(), 2);
    assert_eq!(doc.blocks[1].id, "p2");
}

// ── SD-07 共享用例（plan 层 · Memory；Store 对侧见 note_plan_parity）──

/// P-03：update 目标不存在 → note.not_found
#[test]
fn plan_block_ops_update_not_found() {
    let existing = seed_p1();
    let ops = [NoteBlockOp {
        op: NoteBlockOpKind::Update,
        id: Some("ghost".into()),
        parent_id: None,
        previous_id: None,
        content: Some("x".into()),
        kind: None,
        attrs: None,
    }];
    let err = plan_block_ops(Some(&existing), &ops, || "n".into()).unwrap_err();
    assert_eq!(err.code(), "note.not_found");
    assert!(matches!(err, NoteBackendError::NotFound(_)));
    assert_eq!(existing.len(), 1, "plan 不得改输入树");
}

/// P-03：delete 目标不存在 → note.not_found
#[test]
fn plan_block_ops_delete_not_found() {
    let existing = seed_p1();
    let ops = [NoteBlockOp {
        op: NoteBlockOpKind::Delete,
        id: Some("missing".into()),
        parent_id: None,
        previous_id: None,
        content: None,
        kind: None,
        attrs: None,
    }];
    let err = plan_block_ops(Some(&existing), &ops, || "n".into()).unwrap_err();
    assert_eq!(err.code(), "note.not_found");
}

/// P-06：update 缺 content → note.invalid
#[test]
fn plan_block_ops_update_missing_content_invalid() {
    let existing = seed_p1();
    let ops = [NoteBlockOp {
        op: NoteBlockOpKind::Update,
        id: Some("p1".into()),
        parent_id: None,
        previous_id: None,
        content: None,
        kind: None,
        attrs: None,
    }];
    let err = plan_block_ops(Some(&existing), &ops, || "n".into()).unwrap_err();
    assert_eq!(err.code(), "note.invalid");
    assert!(matches!(err, NoteBackendError::Invalid(_)));
}

/// P-06：update 空 id → note.invalid
#[test]
fn plan_block_ops_update_empty_id_invalid() {
    let existing = seed_p1();
    let ops = [NoteBlockOp {
        op: NoteBlockOpKind::Update,
        id: Some("  ".into()),
        parent_id: None,
        previous_id: None,
        content: Some("x".into()),
        kind: None,
        attrs: None,
    }];
    let err = plan_block_ops(Some(&existing), &ops, || "n".into()).unwrap_err();
    assert_eq!(err.code(), "note.invalid");
}

/// move：previous_id 不存在 → note.not_found（对齐 P-02 形状）
#[test]
fn plan_block_ops_move_previous_not_found() {
    let existing = seed_p1();
    let ops = [NoteBlockOp {
        op: NoteBlockOpKind::Move,
        id: Some("p1".into()),
        parent_id: None,
        previous_id: Some("ghost-prev".into()),
        content: None,
        kind: None,
        attrs: None,
    }];
    let err = plan_block_ops(Some(&existing), &ops, || "n".into()).unwrap_err();
    assert_eq!(err.code(), "note.not_found");
    assert!(err.message().contains("previous_id"));
    assert_eq!(existing.len(), 1);
}
