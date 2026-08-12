//! Store plan→collab 规划期失败分支单测（**SD-11** 旁挂；**≠ EL-05**）
//!
//! 形状保持：IdConflict / NotFound / Invalid（update 缺 id、delete 目标缺失）。

use super::*;
use agent_tools::note_backend::NoteBlockOpKind;
use conex_doc_collab::{BlockProps, DocSession, HydrateBlob, Origin, Op};
use std::str::FromStr;

fn empty_session(doc_id: &str) -> DocSession {
    DocSession::hydrate(doc_id.to_string(), HydrateBlob::default()).expect("empty hydrate")
}

/// insert 预分配已存在 id → IdConflict（规划期，零写）。
#[test]
fn plan_block_ops_id_conflict() {
    let fixed = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let mut session = empty_session("plan-idc2");
    let id = BlockId::from_str(fixed).unwrap();
    session
        .apply(
            Origin::User,
            &[Op::Insert {
                id,
                parent: None,
                order: "a0000".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            }],
        )
        .expect("seed insert");
    let ops2 = vec![NoteBlockOp {
        op: NoteBlockOpKind::Insert,
        id: Some(fixed.into()),
        parent_id: None,
        previous_id: None,
        content: Some("dup".into()),
        kind: Some("paragraph".into()),
        attrs: None,
    }];
    let err = plan_block_ops_to_collab(&session, &ops2).unwrap_err();
    assert!(
        matches!(err, NoteBackendError::IdConflict(_)),
        "expect IdConflict, got {err:?}"
    );
}

/// previous_id / 目标块不存在 → NotFound。
#[test]
fn plan_block_ops_previous_not_found() {
    let session = empty_session("plan-nf");
    let missing = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let ops = vec![NoteBlockOp {
        op: NoteBlockOpKind::Insert,
        id: None,
        parent_id: None,
        previous_id: Some(missing.into()),
        content: Some("after missing".into()),
        kind: Some("paragraph".into()),
        attrs: None,
    }];
    let err = plan_block_ops_to_collab(&session, &ops).unwrap_err();
    assert!(
        matches!(err, NoteBackendError::NotFound(_)),
        "expect NotFound, got {err:?}"
    );
}

/// update 缺 id → Invalid；delete 目标不存在 → NotFound。
#[test]
fn plan_block_ops_update_invalid_delete_not_found() {
    let session = empty_session("plan-inv");
    let missing = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    let err_upd = plan_block_ops_to_collab(
        &session,
        &[NoteBlockOp {
            op: NoteBlockOpKind::Update,
            id: None,
            parent_id: None,
            previous_id: None,
            content: Some("x".into()),
            kind: None,
            attrs: None,
        }],
    )
    .unwrap_err();
    assert!(matches!(err_upd, NoteBackendError::Invalid(_)));

    let err_del = plan_block_ops_to_collab(
        &session,
        &[NoteBlockOp {
            op: NoteBlockOpKind::Delete,
            id: Some(missing.into()),
            parent_id: None,
            previous_id: None,
            content: None,
            kind: None,
            attrs: None,
        }],
    )
    .unwrap_err();
    assert!(matches!(err_del, NoteBackendError::NotFound(_)));
}
