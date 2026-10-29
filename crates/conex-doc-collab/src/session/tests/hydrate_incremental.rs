//! P-H2 回滚与增量 checkpoint 测试（SR-06g · 拆分 · 测外置 · ≠ EL）。
use super::super::*;
use super::*;

/// P-H2 / A-INV-09a：`on_committed` 第二次失败 → 树/文本/rev 与失败前 ≡，零半提交。
///
/// MockPersistence：第 1 次成功（Insert 落盘），第 2 次 TextEdit 返回 Persist 错；
/// 断言内存权威未前进（方案 A 快照回滚，非逆 op）。
#[test]
fn p_h2_persist_fail_rolls_back_tree_and_text() {
    use crate::persistence::PersistError;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

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

/// 3-5 / P-H2：多块文档只改一块时增量回滚 ≡ apply 前；未涉及块与新建/删除均正确。
#[test]
fn p_h2_incremental_checkpoint_uninvolved_and_new_blocks() {
    use crate::persistence::PersistError;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

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
                Err(PersistError::Io("p_h2 incremental persist fail".into()))
            } else {
                Ok(())
            }
        }
        fn flush_hint(&self, _: &str) -> Result<(), PersistError> {
            Ok(())
        }
    }

    let a = BlockId::new();
    let b = BlockId::new();
    let c = BlockId::new();

    // n=2：建树成功，随后 TextEdit 失败
    let mut s = DocSession::new("p-h2-inc").with_persistence(Box::new(FailAfterN {
        n: 2,
        calls: AtomicUsize::new(0),
    }));
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
                parent: None,
                order: "a1".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            },
            Op::Insert {
                id: c,
                parent: None,
                order: "a2".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            },
            Op::TextEdit {
                id: a,
                start: 0,
                end: 0,
                insert: "alpha".into(),
            },
            Op::TextEdit {
                id: b,
                start: 0,
                end: 0,
                insert: "beta".into(),
            },
            Op::TextEdit {
                id: c,
                start: 0,
                end: 0,
                insert: "gamma".into(),
            },
        ],
    )
    .expect("seed apply");
    let rev = s.rev();
    let tree = s.tree().clone();

    let err = s
        .apply(
            Origin::User,
            &[Op::TextEdit {
                id: a,
                start: 0,
                end: 5,
                insert: "ALPHA".into(),
            }],
        )
        .expect_err("edit A must fail persist");
    assert!(matches!(err, ApplyError::Persist(_)));
    assert_eq!(s.rev(), rev);
    assert_eq!(s.read_text(&a), "alpha");
    assert_eq!(s.read_text(&b), "beta", "未涉及块 B 不得被 restore 抹掉");
    assert_eq!(s.read_text(&c), "gamma", "未涉及块 C 不得被 restore 抹掉");
    assert_eq!(s.tree(), &tree);

    // Insert D 失败 → D 不得残留，A/B/C 不变
    let mut s = DocSession::new("p-h2-ins").with_persistence(Box::new(FailAfterN {
        n: 2,
        calls: AtomicUsize::new(0),
    }));
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
            Op::TextEdit {
                id: a,
                start: 0,
                end: 0,
                insert: "keep".into(),
            },
        ],
    )
    .unwrap();
    let d = BlockId::new();
    s.apply(
        Origin::User,
        &[Op::Insert {
            id: d,
            parent: None,
            order: "a1".into(),
            kind: BlockKind::Paragraph,
            props: BlockProps::default(),
        }],
    )
    .expect_err("insert D persist fail");
    assert!(!s.tree().nodes.contains_key(&d));
    assert!(!s.text_is_registered(&d));
    assert_eq!(s.read_text(&a), "keep");

    // Delete A 失败 → A 与文本须在
    let mut s = DocSession::new("p-h2-del").with_persistence(Box::new(FailAfterN {
        n: 2,
        calls: AtomicUsize::new(0),
    }));
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
                parent: None,
                order: "a1".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            },
            Op::TextEdit {
                id: a,
                start: 0,
                end: 0,
                insert: "alive".into(),
            },
            Op::TextEdit {
                id: b,
                start: 0,
                end: 0,
                insert: "sibling".into(),
            },
        ],
    )
    .unwrap();
    s.apply(Origin::User, &[Op::Delete { id: a }])
        .expect_err("delete A persist fail");
    assert!(s.tree().nodes.contains_key(&a));
    assert!(s.text_is_registered(&a));
    assert_eq!(s.read_text(&a), "alive");
    assert_eq!(s.read_text(&b), "sibling");
}

/// 3-5 / P-H2：huge split 新建段在 persist 失败后须被增量 restore 释放。
#[test]
fn p_h2_incremental_huge_split_releases_new_segments() {
    use crate::persistence::PersistError;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

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
                Err(PersistError::Io("p_h2 huge persist fail".into()))
            } else {
                Ok(())
            }
        }
        fn flush_hint(&self, _: &str) -> Result<(), PersistError> {
            Ok(())
        }
    }

    let id = BlockId::new();
    let mut s = DocSession::new("p-h2-huge")
        .with_huge_threshold(MIN_T_HUGE)
        .with_persistence(Box::new(FailAfterN {
            n: 2,
            calls: AtomicUsize::new(0),
        }));
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
                insert: "seed".into(),
            },
        ],
    )
    .unwrap();
    let nodes_before = s.tree().nodes.len();
    let payload = "z".repeat(MIN_T_HUGE * 2 + MIN_T_HUGE / 2);
    s.apply(
        Origin::User,
        &[Op::TextEdit {
            id,
            start: 0,
            end: 4,
            insert: payload,
        }],
    )
    .expect_err("huge split persist fail");
    assert_eq!(s.tree().nodes.len(), nodes_before, "新段不得残留");
    assert_eq!(s.read_text(&id), "seed");
    assert_eq!(super::count_split_segments(&s, id), 1);
}
