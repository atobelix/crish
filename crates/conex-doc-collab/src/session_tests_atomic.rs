//! A-INV-09a/c + A-MEM-01/02 + CommitBatch 同源测试（SR-06g · 拆分 · 测外置 · ≠ EL）。
use super::super::*;
use super::*;

/// A-INV-09a：同批 TextEdit + 故意失败 Op → 树与文本均不变。
#[test]
fn a_inv_09a_text_edit_plus_failing_op_atomic() {
    let mut s = DocSession::new("d1");
    let id = BlockId::new();
    insert_root(&mut s, id, "a0");
    s.apply(
        Origin::User,
        &[Op::TextEdit {
            id,
            start: 0,
            end: 0,
            insert: "base".into(),
        }],
    )
    .unwrap();
    let rev_before = s.rev;
    let text_before = s.read_text(&id);
    let hot_before = s.text_hot_count();
    let missing = BlockId::new();

    let err = s
        .apply(
            Origin::User,
            &[
                Op::TextEdit {
                    id,
                    start: 0,
                    end: 4,
                    insert: "CHANGED".into(),
                },
                Op::Move {
                    id,
                    new_parent: Some(missing),
                    order: "a0".into(),
                },
            ],
        )
        .unwrap_err();
    assert!(matches!(err, ApplyError::NotFound(_)));
    assert_eq!(s.rev, rev_before);
    assert_eq!(s.read_text(&id), text_before);
    assert_eq!(
        s.tree.get(&id).unwrap().text_snapshot.as_deref(),
        Some(text_before.as_str())
    );
    assert_eq!(s.text_hot_count(), hot_before);
}

/// A-INV-09a 变体：非法文本偏移 + 合法结构 Op 同批 → 全拒。
#[test]
fn a_inv_09a_bad_text_offset_rejects_whole_batch() {
    let mut s = DocSession::new("d1");
    let id = BlockId::new();
    let id2 = BlockId::new();
    insert_root(&mut s, id, "a0");
    let rev_before = s.rev;
    let nodes_before = s.tree.nodes.len();

    let err = s
        .apply(
            Origin::User,
            &[
                Op::TextEdit {
                    id,
                    start: 99,
                    end: 99,
                    insert: "x".into(),
                },
                Op::Insert {
                    id: id2,
                    parent: None,
                    order: "a1".into(),
                    kind: BlockKind::Paragraph,
                    props: BlockProps::default(),
                },
            ],
        )
        .unwrap_err();
    assert!(matches!(err, ApplyError::Schema(_)));
    assert_eq!(s.rev, rev_before);
    assert_eq!(s.tree.nodes.len(), nodes_before);
    assert!(!s.tree.nodes.contains_key(&id2));
    assert!(!s.text_is_registered(&id2));
}

/// A-INV-09c：Delete 后 TextEngine 无该 id；热计数下降。
#[test]
fn a_inv_09c_delete_releases_text_engine() {
    let mut s = DocSession::new("d1");
    let id = BlockId::new();
    insert_root(&mut s, id, "a0");
    s.apply(
        Origin::User,
        &[Op::TextEdit {
            id,
            start: 0,
            end: 0,
            insert: "hot".into(),
        }],
    )
    .unwrap();
    assert!(s.text_is_hot(&id));
    assert_eq!(s.text_hot_count(), 1);

    s.apply(Origin::User, &[Op::Delete { id }]).unwrap();
    assert!(!s.text_is_registered(&id));
    assert!(!s.text_is_hot(&id));
    assert_eq!(s.text_hot_count(), 0);
    assert!(s.tree.nodes.is_empty());
}

/// A-MEM-01 / W6-C：默认热集上界常量导出为 512，且 DocSession 默认采用该值。
#[test]
fn a_mem_01_default_max_hot_constant_is_512() {
    use crate::a_mem;
    use crate::DEFAULT_MAX_HOT;
    assert_eq!(DEFAULT_MAX_HOT, 512, "H1 默认热集上界须为 512");
    assert_eq!(a_mem::DEFAULT_MAX_HOT, DEFAULT_MAX_HOT);
    assert_eq!(a_mem::A_MEM_01, "A-MEM-01");
    let s = DocSession::new("d1");
    assert_eq!(
        s.text_max_hot(),
        DEFAULT_MAX_HOT,
        "DocSession::new 默认 text_max_hot 须等于 DEFAULT_MAX_HOT"
    );
    // 退化治理 ID 可引用（数值比较见 perf-baseline.md）
    assert_eq!(crate::a_perf::A_PERF_DEG_01, "A-PERF-DEG-01");
}

/// A-MEM-01（会话层）：max_hot=8，编辑超限后 hot_count 受界。
#[test]
fn a_mem_01_session_hot_bounded() {
    let mut s = DocSession::new("d1").with_text_max_hot(8);
    let mut ids = Vec::new();
    for i in 0..24 {
        let id = BlockId::new();
        insert_root(&mut s, id, &format!("a{i:02}"));
        s.apply(
            Origin::User,
            &[Op::TextEdit {
                id,
                start: 0,
                end: 0,
                insert: "x".into(),
            }],
        )
        .unwrap();
        ids.push(id);
    }
    assert!(s.text_hot_count() <= 8);
    assert_eq!(s.text_max_hot(), 8);
    // 最近编辑仍热
    assert!(s.text_is_hot(ids.last().unwrap()));
}

/// A-MEM-02（会话层）：冷块可读 + 再编辑变热。
///
/// **≠ A-MEM-04**：本测无 undo；跨冷 undo 契约见 W1-U / `pseudo-assert-register.md`。
#[test]
fn a_mem_02_session_cold_read_and_reheat() {
    let mut s = DocSession::new("d1").with_text_max_hot(1);
    let a = BlockId::new();
    let b = BlockId::new();
    insert_root(&mut s, a, "a0");
    insert_root(&mut s, b, "a1");
    s.apply(
        Origin::User,
        &[Op::TextEdit {
            id: a,
            start: 0,
            end: 0,
            insert: "alpha".into(),
        }],
    )
    .unwrap();
    s.apply(
        Origin::User,
        &[Op::TextEdit {
            id: b,
            start: 0,
            end: 0,
            insert: "beta".into(),
        }],
    )
    .unwrap();
    assert!(!s.text_is_hot(&a));
    assert_eq!(s.read_text(&a), "alpha");
    assert_eq!(
        s.tree.get(&a).unwrap().text_snapshot.as_deref(),
        Some("alpha")
    );
    s.apply(
        Origin::User,
        &[Op::TextEdit {
            id: a,
            start: 0,
            end: 5,
            insert: "ALPHA".into(),
        }],
    )
    .unwrap();
    assert!(s.text_is_hot(&a));
    assert_eq!(s.read_text(&a), "ALPHA");
}

/// CommitBatch 文本变更携带 Text 类 update（A-INV-09b 同源 tx_id）。
#[test]
fn commit_batch_includes_text_update_bytes() {
    struct Cap(std::sync::Arc<std::sync::Mutex<Option<CommitBatch>>>);
    impl PersistencePlugin for Cap {
        fn load_doc(
            &self,
            _: &str,
        ) -> Result<crate::persistence::HydrateBlob, crate::persistence::PersistError> {
            Ok(Default::default())
        }
        fn on_committed(
            &self,
            _: &str,
            c: &CommitBatch,
        ) -> Result<(), crate::persistence::PersistError> {
            *self.0.lock().unwrap() = Some(c.clone());
            Ok(())
        }
        fn flush_hint(&self, _: &str) -> Result<(), crate::persistence::PersistError> {
            Ok(())
        }
    }
    let last = std::sync::Arc::new(std::sync::Mutex::new(None::<CommitBatch>));
    let mut s = DocSession::new("d1").with_persistence(Box::new(Cap(last.clone())));
    let id = BlockId::new();
    s.apply(
        Origin::User,
        &[Op::Insert {
            id,
            parent: None,
            order: "a0".into(),
            kind: BlockKind::Paragraph,
            props: BlockProps::default(),
        }],
    )
    .unwrap();
    s.apply(
        Origin::User,
        &[Op::TextEdit {
            id,
            start: 0,
            end: 0,
            insert: "hi".into(),
        }],
    )
    .unwrap();
    let batch = last.lock().unwrap().clone().expect("commit");
    assert!(
        batch
            .updates
            .iter()
            .any(|u| matches!(u.kind, UpdateKind::Text) && !u.bytes.is_empty()),
        "应含非空 Text update 字节"
    );
    // 结构标记与 Text 同批、同 tx_id
    assert!(batch
        .updates
        .iter()
        .any(|u| matches!(u.kind, UpdateKind::Structure)));
    assert_eq!(s.last_tx_id(), Some(batch.tx_id));
    assert_eq!(s.last_commit_text_updates().len(), 1);
    assert_eq!(s.last_commit_text_updates()[0].block_id, id);
    assert!(!s.last_commit_text_updates()[0].bytes.is_empty());
}

/// A-INV-09b：一次 apply 的 CommitBatch 中 structure 与 text updates 共享同一 `tx_id`。
#[test]
fn a_inv_09b_structure_and_text_share_tx_id() {
    struct Cap(std::sync::Arc<std::sync::Mutex<Option<CommitBatch>>>);
    impl PersistencePlugin for Cap {
        fn load_doc(
            &self,
            _: &str,
        ) -> Result<crate::persistence::HydrateBlob, crate::persistence::PersistError> {
            Ok(Default::default())
        }
        fn on_committed(
            &self,
            _: &str,
            c: &CommitBatch,
        ) -> Result<(), crate::persistence::PersistError> {
            *self.0.lock().unwrap() = Some(c.clone());
            Ok(())
        }
        fn flush_hint(&self, _: &str) -> Result<(), crate::persistence::PersistError> {
            Ok(())
        }
    }
    let last = std::sync::Arc::new(std::sync::Mutex::new(None::<CommitBatch>));
    let mut s = DocSession::new("d1").with_persistence(Box::new(Cap(last.clone())));
    let id = BlockId::new();
    // 同批：结构 Insert + 文本 TextEdit → 单一 CommitBatch / 单一 tx_id
    s.apply(
        Origin::User,
        &[
            Op::Insert {
                id,
                parent: None,
                order: "a0".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            },
            Op::TextEdit {
                id,
                start: 0,
                end: 0,
                insert: "same-tx".into(),
            },
        ],
    )
    .unwrap();
    let batch = last.lock().unwrap().clone().expect("commit");
    let session_tx = s.last_tx_id().expect("last_tx_id");
    assert_eq!(batch.tx_id, session_tx, "CommitBatch.tx_id 与 session 同源");
    let has_struct = batch
        .updates
        .iter()
        .any(|u| matches!(u.kind, UpdateKind::Structure));
    let has_text = batch
        .updates
        .iter()
        .any(|u| matches!(u.kind, UpdateKind::Text) && !u.bytes.is_empty());
    assert!(has_struct, "同批须含 Structure 标记");
    assert!(has_text, "同批须含 Text update");
    // 全部 updates 挂在同一 batch.tx_id 下（结构体单字段，即共享）
    assert_eq!(s.read_text(&id), "same-tx");
    assert_eq!(s.last_commit_text_updates().len(), 1);
    assert_eq!(s.last_commit_text_updates()[0].block_id, id);
}
