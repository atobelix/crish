//! Store plan→collab 规划期失败分支单测（**SD-11** 旁挂；**≠ EL-05**）
//!
//! 形状保持：IdConflict / NotFound / Invalid（update 缺 id、delete 目标缺失）。

use super::*;
use agent_tools::note_backend::NoteBlockOpKind;
use conex_doc_collab::{BlockKind, BlockProps, DocSession, HydrateBlob, Op, Origin};
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

/// Store Update 带 attrs 必须拒绝，且不得生成文本或属性写入。
#[test]
fn plan_update_with_attrs_is_rejected_without_mutating_session() {
    let id_s = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    let id = BlockId::from_str(id_s).unwrap();
    let mut session = empty_session("plan-update-attrs-rejected");
    let mut props = BlockProps::default();
    props
        .attrs
        .insert("conex_md_ordered_item_number".into(), serde_json::json!(5));
    session
        .apply(
            Origin::User,
            &[Op::Insert {
                id,
                parent: None,
                order: "a0000".into(),
                kind: BlockKind::OrderedItem,
                props,
            }],
        )
        .expect("seed ordered item");
    session
        .apply(
            Origin::User,
            &[Op::TextEdit {
                id,
                start: 0,
                end: 0,
                insert: "original".into(),
            }],
        )
        .expect("seed original text");

    let err = plan_block_ops_to_collab(
        &session,
        &[NoteBlockOp {
            op: NoteBlockOpKind::Update,
            id: Some(id_s.into()),
            parent_id: None,
            previous_id: None,
            content: Some("replacement".into()),
            kind: None,
            attrs: Some(serde_json::Map::from_iter([(
                "collapsed".into(),
                serde_json::json!(true),
            )])),
        }],
    )
    .unwrap_err();

    assert!(matches!(err, NoteBackendError::Invalid(_)));
    assert_eq!(err.message(), "update does not accept attrs; use set_attr");
    let node = session.tree().get(&id).expect("ordered item remains");
    assert_eq!(node.text_snapshot.as_deref(), Some("original"));
    assert_eq!(session.read_text(&id), "original");
    assert_eq!(
        node.props
            .attrs
            .get("conex_md_ordered_item_number")
            .and_then(serde_json::Value::as_u64),
        Some(5)
    );
    assert!(!node.props.attrs.contains_key("collapsed"));
}

/// SetAttr 只改指定 attrs；ordered item 的编号和其它属性须保留。
#[test]
fn plan_set_attr_patches_existing_attrs() {
    let id_s = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    let id = BlockId::from_str(id_s).unwrap();
    let mut session = empty_session("plan-set-attr-patch");
    let mut props = BlockProps::default();
    props
        .attrs
        .insert("conex_md_ordered_item_number".into(), serde_json::json!(5));
    props
        .attrs
        .insert("existing_attr".into(), serde_json::json!("keep"));
    session
        .apply(
            Origin::User,
            &[Op::Insert {
                id,
                parent: None,
                order: "a0000".into(),
                kind: BlockKind::OrderedItem,
                props,
            }],
        )
        .expect("seed ordered item");

    let plan = plan_block_ops_to_collab(
        &session,
        &[NoteBlockOp {
            op: NoteBlockOpKind::SetAttr,
            id: Some(id_s.into()),
            parent_id: None,
            previous_id: None,
            content: None,
            kind: None,
            attrs: Some(serde_json::Map::from_iter([(
                "collapsed".into(),
                serde_json::json!(true),
            )])),
        }],
    )
    .expect("plan partial set_attr");

    match &plan.collab_ops[..] {
        [Op::PatchAttrs {
            id: patch_id,
            set,
            remove,
        }] => {
            assert_eq!(*patch_id, id);
            assert_eq!(
                set.get("collapsed").and_then(serde_json::Value::as_bool),
                Some(true)
            );
            assert!(remove.is_empty(), "SetAttr does not imply removal");
        }
        other => panic!("SetAttr must plan one PatchAttrs op, got {other:?}"),
    }

    session
        .apply(Origin::Agent, &plan.collab_ops)
        .expect("apply partial set_attr");
    let attrs = &session.tree().get(&id).expect("ordered item").props.attrs;
    assert_eq!(
        attrs
            .get("conex_md_ordered_item_number")
            .and_then(serde_json::Value::as_u64),
        Some(5)
    );
    assert_eq!(
        attrs
            .get("existing_attr")
            .and_then(serde_json::Value::as_str),
        Some("keep")
    );
    assert_eq!(
        attrs.get("collapsed").and_then(serde_json::Value::as_bool),
        Some(true)
    );
}
