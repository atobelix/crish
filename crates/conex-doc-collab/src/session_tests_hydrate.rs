//! G-HYD + 远端文本合入 + P-H2 回滚测试（SR-06g · 拆分 · 测外置 · ≠ EL）。
use super::super::*;
use super::*;
use crate::persistence::MemoryPersistence;

// ─── G-HYD / W1-H：结构可逆 encode + hydrate ───────────────────

/// G-HYD-1：结构 EncodedUpdate **不是** `rev.to_le_bytes()` 占位，且可解码。
#[test]
fn g_hyd_01_structure_encode_not_rev_placeholder() {
    use crate::structure_codec::{decode_structure_payload, is_structure_payload};
    let last = std::sync::Arc::new(std::sync::Mutex::new(None::<CommitBatch>));
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
    let mut s = DocSession::new("g-hyd-1").with_persistence(Box::new(Cap(last.clone())));
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
    let batch = last.lock().unwrap().clone().expect("commit");
    let structure = batch
        .updates
        .iter()
        .find(|u| matches!(u.kind, UpdateKind::Structure))
        .expect("须含 Structure update");
    let rev = s.rev;
    assert_ne!(
        structure.bytes,
        rev.to_le_bytes().to_vec(),
        "禁止结构 bytes = rev LE 占位"
    );
    assert!(structure.bytes.len() > 8, "结构载荷须长于 8 字节 rev 占位");
    assert!(
        is_structure_payload(&structure.bytes),
        "须为 CDCS 结构 magic"
    );
    let snap = decode_structure_payload(&structure.bytes).expect("可解码");
    assert_eq!(snap.rev, rev);
    assert!(snap.tree.nodes.contains_key(&id));
    assert_eq!(snap.tree.root_children, vec![id]);
}

/// G-HYD-2：apply → persist → hydrate → 树同构。
#[test]
fn g_hyd_02_apply_persist_hydrate_tree_isomorphic() {
    use crate::structure_codec::structure_eq;
    let mem = MemoryPersistence::default();
    // 用 Arc 共享同一 MemoryPersistence 状态：Box 会移走所有权，故直接用闭包插件
    let blob_slot = std::sync::Arc::new(std::sync::Mutex::new(
        crate::persistence::HydrateBlob::default(),
    ));
    let last = std::sync::Arc::new(std::sync::Mutex::new(None::<CommitBatch>));
    struct MemP {
        blob: std::sync::Arc<std::sync::Mutex<crate::persistence::HydrateBlob>>,
        last: std::sync::Arc<std::sync::Mutex<Option<CommitBatch>>>,
    }
    impl PersistencePlugin for MemP {
        fn load_doc(
            &self,
            _: &str,
        ) -> Result<crate::persistence::HydrateBlob, crate::persistence::PersistError> {
            Ok(self.blob.lock().unwrap().clone())
        }
        fn on_committed(
            &self,
            _: &str,
            c: &CommitBatch,
        ) -> Result<(), crate::persistence::PersistError> {
            *self.last.lock().unwrap() = Some(c.clone());
            let mut blob = self.blob.lock().unwrap();
            for u in &c.updates {
                if matches!(u.kind, UpdateKind::Structure | UpdateKind::Combined) {
                    blob.snapshot = Some(u.bytes.clone());
                    blob.pending.clear();
                }
            }
            Ok(())
        }
        fn flush_hint(&self, _: &str) -> Result<(), crate::persistence::PersistError> {
            Ok(())
        }
    }
    let mut s = DocSession::new("g-hyd-2").with_persistence(Box::new(MemP {
        blob: blob_slot.clone(),
        last: last.clone(),
    }));
    let a = BlockId::new();
    let b = BlockId::new();
    s.apply(
        Origin::User,
        &[
            Op::Insert {
                id: a,
                parent: None,
                order: "a0".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            },
            Op::Insert {
                id: b,
                parent: Some(a),
                order: "a0".into(),
                kind: BlockKind::Heading { level: 2 },
                props: BlockProps::default(),
            },
            Op::TextEdit {
                id: a,
                start: 0,
                end: 0,
                insert: "parent-text".into(),
            },
        ],
    )
    .unwrap();
    let expected_tree = s.tree.clone();
    let expected_rev = s.rev;
    assert_eq!(expected_rev, 1);
    assert!(last.lock().unwrap().is_some());

    let blob = blob_slot.lock().unwrap().clone();
    assert!(blob.snapshot.is_some());
    let restored = DocSession::hydrate("g-hyd-2", blob).expect("hydrate");
    assert!(
        structure_eq(restored.tree(), &expected_tree),
        "hydrate 后树须同构（id/parent/order/kind/props/children/text_snapshot）"
    );
    assert_eq!(restored.rev(), expected_rev);
    assert_eq!(restored.tree().get(&a).unwrap().parent, None);
    assert_eq!(restored.tree().get(&b).unwrap().parent, Some(a));
    assert_eq!(restored.tree().get(&a).unwrap().kind, BlockKind::Paragraph);
    // 避免 unused 告警
    let _ = mem;
}

/// G-HYD-3 / A-MEM-02 方向：hydrate 后冷 `text_snapshot` 可读。
#[test]
fn g_hyd_03_text_snapshot_readable_after_hydrate() {
    let blob_slot = std::sync::Arc::new(std::sync::Mutex::new(
        crate::persistence::HydrateBlob::default(),
    ));
    struct MemP(std::sync::Arc<std::sync::Mutex<crate::persistence::HydrateBlob>>);
    impl PersistencePlugin for MemP {
        fn load_doc(
            &self,
            _: &str,
        ) -> Result<crate::persistence::HydrateBlob, crate::persistence::PersistError> {
            Ok(self.0.lock().unwrap().clone())
        }
        fn on_committed(
            &self,
            _: &str,
            c: &CommitBatch,
        ) -> Result<(), crate::persistence::PersistError> {
            let mut blob = self.0.lock().unwrap();
            for u in &c.updates {
                if matches!(u.kind, UpdateKind::Structure | UpdateKind::Combined) {
                    blob.snapshot = Some(u.bytes.clone());
                    blob.pending.clear();
                }
            }
            Ok(())
        }
        fn flush_hint(&self, _: &str) -> Result<(), crate::persistence::PersistError> {
            Ok(())
        }
    }
    let mut s = DocSession::new("g-hyd-3").with_persistence(Box::new(MemP(blob_slot.clone())));
    let id = BlockId::new();
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
                insert: "cold-readable-after-hydrate".into(),
            },
        ],
    )
    .unwrap();
    assert_eq!(s.read_text(&id), "cold-readable-after-hydrate");

    let blob = blob_slot.lock().unwrap().clone();
    let restored = DocSession::hydrate("g-hyd-3", blob).unwrap();
    // 冷登记：默认不热，但可读（A-MEM-02）
    assert!(!restored.text_is_hot(&id), "hydrate 后默认冷，不强制全热");
    assert_eq!(
        restored.read_text(&id),
        "cold-readable-after-hydrate",
        "冷 text_snapshot 须可读"
    );
    assert_eq!(
        restored.tree().get(&id).unwrap().text_snapshot.as_deref(),
        Some("cold-readable-after-hydrate")
    );
    assert!(restored.text_is_registered(&id));
}

/// 空 blob hydrate → 空会话（新文档合法）；非空不可解码 → Corrupt。
#[test]
fn g_hyd_empty_and_corrupt_blob() {
    let empty = DocSession::hydrate("e", crate::persistence::HydrateBlob::default()).unwrap();
    assert!(empty.tree().nodes.is_empty());
    assert_eq!(empty.rev(), 0);

    let bad = crate::persistence::HydrateBlob {
        snapshot: Some(42u64.to_le_bytes().to_vec()),
        pending: vec![],
    };
    match DocSession::hydrate("bad", bad) {
        Ok(_) => panic!("rev LE 占位不得 hydrate 成功"),
        Err(err) => assert!(matches!(err, HydrateError::Corrupt(_))),
    }
}

/// 远端文本合入须走 on_committed（写锥 / 统一 commit 面）。
#[test]
fn apply_remote_text_update_emits_on_committed() {
    let last = std::sync::Arc::new(std::sync::Mutex::new(None::<CommitBatch>));
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
    let mut s = DocSession::new("remote-commit").with_persistence(Box::new(Cap(last.clone())));
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
    // 造一份 text update：先本地写再取 encode
    s.apply(
        Origin::User,
        &[Op::TextEdit {
            id,
            start: 0,
            end: 0,
            insert: "local".into(),
        }],
    )
    .unwrap();
    let bytes = s.last_commit_text_updates()[0].bytes.clone();
    *last.lock().unwrap() = None;
    s.apply_remote_text_update(id, &bytes).unwrap();
    let batch = last
        .lock()
        .unwrap()
        .clone()
        .expect("remote 须 on_committed");
    assert!(matches!(batch.origin, Origin::Remote));
    assert!(batch
        .updates
        .iter()
        .any(|u| matches!(u.kind, UpdateKind::Structure)
            && crate::structure_codec::is_structure_payload(&u.bytes)));
    assert!(batch
        .updates
        .iter()
        .any(|u| matches!(u.kind, UpdateKind::Text) && !u.bytes.is_empty()));
}

/// P-H2 / A-INV-09a：`on_committed` 第二次失败 → 树/文本/rev 与失败前 ≡，零半提交。
///
/// MockPersistence：第 1 次成功（Insert 落盘），第 2 次 TextEdit 返回 Persist 错；
/// 断言内存权威未前进（方案 A 快照回滚，非逆 op）。
#[test]
fn p_h2_persist_fail_rolls_back_tree_and_text() {
    use crate::a_inv_09::A_INV_09A;
    use crate::persistence::PersistError;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

    let _ = A_INV_09A; // 验收锚：A-INV-09a + 18 补丁 P-H2

    /// MockPersistence：第 N 次 `on_committed` 起失败（计数从 1；P-H2 第二次失败）。
    struct FailAfterN {
        n: usize,
        calls: AtomicUsize,
    }
    impl PersistencePlugin for FailAfterN {
        fn load_doc(&self, _: &str) -> Result<crate::persistence::HydrateBlob, PersistError> {
            Ok(Default::default())
        }
        fn on_committed(&self, _: &str, _: &CommitBatch) -> Result<(), PersistError> {
            let c = self.calls.fetch_add(1, AtomicOrdering::SeqCst) + 1;
            if c >= self.n {
                Err(PersistError::Io("p_h2 mock persist fail".into()))
            } else {
                Ok(())
            }
        }
        fn flush_hint(&self, _: &str) -> Result<(), PersistError> {
            Ok(())
        }
    }

    // n=2：第二次 on_committed 失败
    let mut s = DocSession::new("p-h2").with_persistence(Box::new(FailAfterN {
        n: 2,
        calls: AtomicUsize::new(0),
    }));
    let id = BlockId::new();

    // 第一次 apply（Insert）→ on_committed 成功
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
    .expect("first apply (insert) must succeed");

    // 基线：apply 前快照（第二次失败后须 ≡）
    let rev_before = s.rev();
    let tree_before = s.tree().clone();
    let text_before = s.read_text(&id);
    let tx_before = s.last_tx_id();
    let text_upd_before = s.last_commit_text_updates().to_vec();
    assert_eq!(rev_before, 1);
    assert_eq!(text_before, "");
    assert!(s.tree().nodes.contains_key(&id));

    // 第二次 apply（TextEdit）→ on_committed 失败 → 须整域回滚
    let err = s
        .apply(
            Origin::User,
            &[Op::TextEdit {
                id,
                start: 0,
                end: 0,
                insert: "should-not-stick".into(),
            }],
        )
        .expect_err("second apply must fail on persist");
    assert!(
        matches!(err, ApplyError::Persist(_)),
        "须为 Persist 错，got: {err:?}"
    );

    // 树 / 文本 / rev / 观测字段 ≡ 第二次 apply 前
    assert_eq!(s.rev(), rev_before, "rev 不得半前进");
    assert_eq!(s.tree(), &tree_before, "树结构须与 persist 失败前同构");
    assert_eq!(s.read_text(&id), text_before, "文本引擎 plain text 须回滚");
    assert_eq!(
        s.tree().get(&id).and_then(|n| n.text_snapshot.as_deref()),
        tree_before
            .get(&id)
            .and_then(|n| n.text_snapshot.as_deref()),
        "树内 text_snapshot 须回滚"
    );
    assert_eq!(s.last_tx_id(), tx_before, "失败批不得污染 last_tx_id");
    assert_eq!(
        s.last_commit_text_updates(),
        text_upd_before.as_slice(),
        "失败批不得污染 last_text_updates"
    );
    // 半提交禁令：不得残留失败批写入的文本
    assert_ne!(s.read_text(&id), "should-not-stick");
}
