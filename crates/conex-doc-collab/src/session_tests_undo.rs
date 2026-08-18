//! W1-U undo 域测试（SR-06g · 拆分 · 测外置 · ≠ EL）。
//!
//! A-COL-04（origin 过滤）/ A-MEM-04（跨冷 undo）/ A-INV-09c 后半（删块 undo 恢复）。
use super::super::*;
use super::*;
use crate::text_engine::ROOT_TEXT;
use yrs::{ReadTxn, Text, Transact};

// ─── W1-U · Undo v1（A-COL-04 / A-MEM-04 / A-INV-09c 后半）────────

/// A-COL-04：`undo(filter)` 按 origin 过滤；栈顶不匹配不误撤。
///
/// 场景：User 批 + Agent 批 → `undo(Some(User))` 在栈顶为 Agent 时
/// `OriginMismatch` → `undo(None)` 撤 Agent → `undo(Some(User))` 撤 User。
/// Remote/System 不入栈。
#[test]
fn a_col_04_undo_origin_filter() {
    use crate::a_col::A_COL_04;
    assert_eq!(A_COL_04, "A-COL-04");

    let mut s = DocSession::new("a-col-04");
    let user_id = BlockId::new();
    let agent_id = BlockId::new();

    // User 批：插入 user_id
    s.apply(
        Origin::User,
        &[Op::Insert {
            id: user_id,
            parent: None,
            order: "a0".into(),
            kind: BlockKind::Paragraph,
            props: BlockProps::default(),
        }],
    )
    .unwrap();
    assert_eq!(s.undo_len(), 1);
    assert!(s.tree().nodes.contains_key(&user_id));

    // Agent 批：插入 agent_id（栈顶变为 Agent）
    s.apply(
        Origin::Agent,
        &[Op::Insert {
            id: agent_id,
            parent: None,
            order: "a1".into(),
            kind: BlockKind::Paragraph,
            props: BlockProps::default(),
        }],
    )
    .unwrap();
    assert_eq!(s.undo_len(), 2);
    assert!(s.tree().nodes.contains_key(&agent_id));

    // Remote 不入栈
    let remote_id = BlockId::new();
    s.apply(
        Origin::Remote,
        &[Op::Insert {
            id: remote_id,
            parent: None,
            order: "a2".into(),
            kind: BlockKind::Paragraph,
            props: BlockProps::default(),
        }],
    )
    .unwrap();
    assert_eq!(s.undo_len(), 2, "Remote 不得入 undo 栈");
    assert!(s.tree().nodes.contains_key(&remote_id));

    // System 不入栈
    let sys_id = BlockId::new();
    s.apply(
        Origin::System,
        &[Op::Insert {
            id: sys_id,
            parent: None,
            order: "a3".into(),
            kind: BlockKind::Paragraph,
            props: BlockProps::default(),
        }],
    )
    .unwrap();
    assert_eq!(s.undo_len(), 2, "System 不得入 undo 栈");

    // 栈顶为 Agent：undo(Some(User)) → OriginMismatch，不误撤
    let err = s.undo(Some(Origin::User)).expect_err("须 OriginMismatch");
    assert_eq!(
        err,
        UndoError::OriginMismatch {
            expected: Origin::User,
            actual: Origin::Agent,
        }
    );
    assert_eq!(s.undo_len(), 2, "OriginMismatch 不得弹栈");
    assert!(s.tree().nodes.contains_key(&agent_id), "不得误撤 Agent 批");
    assert!(s.tree().nodes.contains_key(&user_id));

    // undo(None) 撤栈顶 Agent
    let rev_before = s.rev();
    s.undo(None).expect("undo(None) 撤栈顶");
    assert_eq!(s.undo_len(), 1);
    assert!(!s.tree().nodes.contains_key(&agent_id), "Agent 批已撤");
    assert!(s.tree().nodes.contains_key(&user_id));
    // Remote/System 节点仍在（未入栈，undo 不碰它们；但 undo 恢复的是 Agent apply 前快照
    // → 快照时刻 remote/sys 尚不存在，故一并消失——符合「整批 pre 快照」语义）
    assert_eq!(s.rev(), rev_before + 1, "undo 后 rev 单调 +1");

    // undo(Some(User)) 撤 User
    s.undo(Some(Origin::User)).expect("撤 User 批");
    assert_eq!(s.undo_len(), 0);
    assert!(!s.tree().nodes.contains_key(&user_id));

    // 空栈
    assert_eq!(s.undo(None).unwrap_err(), UndoError::Empty);
}

/// A-MEM-04：跨冷 undo——小 max_hot 逼冷后 undo；结构正确；文本 plain 恢复。
///
/// **禁止**用 reheat 测冒充：本测断言 undo 后结构 + plain，而非冷→热编辑路径。
/// 细粒度 yrs 击键史在冷藏后允许截断；undo 以栈内 plain 快照为准。
#[test]
fn a_mem_04_undo_across_cold_restores_structure_and_plain_text() {
    use crate::a_mem::A_MEM_04;
    assert_eq!(A_MEM_04, "A-MEM-04");

    // max_hot=1：第二块热编辑会把第一块冷藏
    let mut s = DocSession::new("a-mem-04").with_text_max_hot(1);
    let a = BlockId::new();
    let b = BlockId::new();

    // 批1：插入 A + 文本 "alpha-v1"
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
                insert: "alpha-v1".into(),
            },
        ],
    )
    .unwrap();
    assert_eq!(s.read_text(&a), "alpha-v1");

    // 批2：编辑 A → "alpha-v2"
    s.apply(
        Origin::User,
        &[Op::TextEdit {
            id: a,
            start: 0,
            end: 8,
            insert: "alpha-v2".into(),
        }],
    )
    .unwrap();
    assert_eq!(s.read_text(&a), "alpha-v2");
    let rev_after_v2 = s.rev();

    // 批3：插入 B + 文本，逼 A 冷藏（跨冷边界）
    s.apply(
        Origin::User,
        &[
            Op::Insert {
                id: b,
                parent: None,
                order: "a1".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            },
            Op::TextEdit {
                id: b,
                start: 0,
                end: 0,
                insert: "beta".into(),
            },
        ],
    )
    .unwrap();
    assert!(!s.text_is_hot(&a), "A 须已冷藏（max_hot=1，B 占热槽）");
    assert_eq!(s.read_text(&a), "alpha-v2", "冷块仍可读 plain");
    assert!(s.text_is_hot(&b));
    assert_eq!(s.undo_len(), 3);

    // 在 A 仍冷时 undo 栈顶（撤 B）——跨冷后的第一步
    let rev_before = s.rev();
    s.undo(None).unwrap();
    assert!(!s.tree().nodes.contains_key(&b), "结构：B 已撤");
    assert!(s.tree().nodes.contains_key(&a), "结构：A 仍在");
    assert_eq!(s.read_text(&a), "alpha-v2", "plain 仍为 v2");
    assert_eq!(s.rev(), rev_before + 1);

    // 再 undo 批2（v1→v2）：文本以 plain 快照恢复为 v1
    s.undo(None).unwrap();
    assert!(s.tree().nodes.contains_key(&a), "跨冷 undo 后结构仍含 A");
    assert_eq!(
        s.read_text(&a),
        "alpha-v1",
        "文本以 plain 快照恢复（yrs 击键史可截断）"
    );
    assert_eq!(
        s.tree().get(&a).and_then(|n| n.text_snapshot.as_deref()),
        Some("alpha-v1")
    );
    assert!(s.rev() > rev_after_v2, "undo 路径 rev 单调前进");
}

/// A-INV-09c 后半：Insert+TextEdit → Delete → undo → 块与文本恢复。
#[test]
fn a_inv_09c_undo_restores_deleted_block_and_text() {
    use crate::a_inv_09::A_INV_09C;
    let _ = A_INV_09C;

    let mut s = DocSession::new("a-inv-09c-undo");
    let id = BlockId::new();

    // 同批 Insert + TextEdit
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
                insert: "keep-me".into(),
            },
        ],
    )
    .unwrap();
    assert_eq!(s.read_text(&id), "keep-me");
    assert!(s.text_is_registered(&id));
    assert_eq!(s.undo_len(), 1);

    // Delete 释放文本槽（09c 前半）
    s.apply(Origin::User, &[Op::Delete { id }]).unwrap();
    assert!(!s.tree().nodes.contains_key(&id));
    assert!(!s.text_is_registered(&id));
    assert_eq!(s.undo_len(), 2);

    // undo Delete → 块与文本恢复（09c 后半）
    let rev_before = s.rev();
    s.undo(None).unwrap();
    assert!(s.tree().nodes.contains_key(&id), "块须恢复");
    assert!(s.text_is_registered(&id), "文本槽须恢复");
    assert_eq!(s.read_text(&id), "keep-me", "文本 plain 须恢复");
    assert_eq!(
        s.tree().get(&id).and_then(|n| n.text_snapshot.as_deref()),
        Some("keep-me")
    );
    assert_eq!(s.rev(), rev_before + 1);
    assert_eq!(s.undo_len(), 1);

    // 再 undo 创建批 → 空树
    s.undo(None).unwrap();
    assert!(!s.tree().nodes.contains_key(&id));
    assert!(!s.text_is_registered(&id));
    assert_eq!(s.undo_len(), 0);
}

/// W1-U 辅：undo persist 失败时内存态与栈深度回滚。
#[test]
fn undo_persist_fail_rolls_back_stack_and_state() {
    use crate::persistence::PersistError;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

    struct FailUndoCommit {
        /// 允许成功的 on_committed 次数；之后失败。
        allow: usize,
        calls: AtomicUsize,
    }
    impl PersistencePlugin for FailUndoCommit {
        fn load_doc(&self, _: &str) -> Result<crate::persistence::HydrateBlob, PersistError> {
            Ok(Default::default())
        }
        fn on_committed(&self, _: &str, _: &CommitBatch) -> Result<(), PersistError> {
            let n = self.calls.fetch_add(1, AtomicOrdering::SeqCst);
            if n >= self.allow {
                Err(PersistError::Io("undo persist fail".into()))
            } else {
                Ok(())
            }
        }
        fn flush_hint(&self, _: &str) -> Result<(), PersistError> {
            Ok(())
        }
    }

    // allow=1：仅第一次 apply 的 commit 成功；undo 的 emit_commit 失败
    let mut s = DocSession::new("undo-persist").with_persistence(Box::new(FailUndoCommit {
        allow: 1,
        calls: AtomicUsize::new(0),
    }));
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
    assert_eq!(s.undo_len(), 1);
    let rev = s.rev();
    let nodes = s.tree().nodes.len();

    let err = s.undo(None).expect_err("undo persist must fail");
    assert!(matches!(err, UndoError::Persist(_)));
    assert_eq!(s.undo_len(), 1, "失败须压回栈");
    assert_eq!(s.rev(), rev, "rev 不得半前进");
    assert_eq!(s.tree().nodes.len(), nodes);
    assert!(s.tree().nodes.contains_key(&id));
}

/// 会话级 CRDT 文本撤销/重做与 CAS 修订号推进
#[test]
fn session_crdt_text_undo_and_redo_with_rev_cas() {
    let mut s = DocSession::new("session-text-undo");
    let id = BlockId::new();

    // 插入块并编辑
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
                insert: "First Line".into(),
            },
        ],
    )
    .unwrap();
    assert_eq!(s.read_text(&id), "First Line");
    assert!(s.can_text_undo(id));

    let rev_before_undo = s.rev();
    // 执行 text_undo
    let undone_text = s.text_undo(id).unwrap();
    assert_eq!(undone_text, "");
    assert_eq!(s.read_text(&id), "");
    assert_eq!(s.rev(), rev_before_undo + 1, "text_undo 推进单调 rev");
    assert!(s.can_text_redo(id));

    // 执行 text_redo
    let redone_text = s.text_redo(id).unwrap();
    assert_eq!(redone_text, "First Line");
    assert_eq!(s.read_text(&id), "First Line");
    assert_eq!(s.rev(), rev_before_undo + 2, "text_redo 推进单调 rev");
}

/// 会话级并发远端编辑与原生因果撤销交叉验证
#[test]
fn session_crdt_concurrent_text_undo_preserves_remote_edits() {
    let mut s = DocSession::new("session-concurrent-undo");
    let id = BlockId::new();

    // 本地 Client A 插入并编辑
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
                insert: "Client A Content ".into(),
            },
        ],
    )
    .unwrap();

    // 模拟远端 Client B 在独立 Doc 上生成并发编辑
    let remote_doc = yrs::Doc::new();
    {
        let t = remote_doc.get_or_insert_text(ROOT_TEXT);
        let mut txn = remote_doc.transact_mut();
        t.insert(&mut txn, 0, "Client B Content ");
    }
    let remote_bytes = remote_doc
        .transact()
        .encode_state_as_update_v1(&yrs::StateVector::default());

    // 本地合入远端增量
    s.apply_remote_text_update(id, &remote_bytes).unwrap();
    let merged = s.read_text(&id);
    assert!(merged.contains("Client A Content ") && merged.contains("Client B Content "));

    // 本地触发 text_undo：仅撤销 Client A 的内容，Client B 100% 保持！
    let undone = s.text_undo(id).unwrap();
    assert_eq!(undone, "Client B Content ", "远端协作者内容绝不受损");
}

/// CRDT-02: 无可撤销历史时 text_undo 返回 Err(UndoError::Empty)，且 rev 保持不变
#[test]
fn test_empty_text_undo_does_not_advance_rev() {
    let mut s = DocSession::new("empty-text-undo");
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

    let rev_before = s.rev();
    // 尚未对该块进行任何 text edit，此时 text_undo 必须返回 Empty 且不推进 rev
    let res = s.text_undo(id);
    assert!(res.is_err(), "Empty undo stack must return error");
    match res.unwrap_err() {
        ApplyError::Undo(UndoError::Empty) => {}
        other => panic!("Expected UndoError::Empty, got {other:?}"),
    }
    assert_eq!(s.rev(), rev_before, "Empty text_undo must NOT advance rev");

    // redo 亦然
    let redo_res = s.text_redo(id);
    assert!(redo_res.is_err(), "Empty redo stack must return error");
    match redo_res.unwrap_err() {
        ApplyError::Undo(UndoError::Empty) => {}
        other => panic!("Expected UndoError::Empty, got {other:?}"),
    }
    assert_eq!(s.rev(), rev_before, "Empty text_redo must NOT advance rev");
}

// ── B3 · CAS 冲突类型化（产生侧：session.rs emit_commit → ApplyError::PersistConflict）──

/// B3：`on_committed_expect` 返回 `PersistError::Conflict` 时，`emit_commit`
/// 经 `apply` 对外暴露 [`ApplyError::PersistConflict { expected }`]（类型化
/// 变体，不再退化为 `ApplyError::Persist(String)`），且 `expected` = 传入期望 rev。
#[test]
fn cas_conflict_produces_typed_persist_conflict_variant() {
    use crate::persistence::PersistError;

    /// 恒返回 CAS Conflict 的持久化插件（模拟陈旧写被存储层拦截）。
    struct CasConflictPlugin;
    impl PersistencePlugin for CasConflictPlugin {
        fn load_doc(&self, _: &str) -> Result<crate::persistence::HydrateBlob, PersistError> {
            Ok(Default::default())
        }
        fn on_committed(&self, _: &str, _: &CommitBatch) -> Result<(), PersistError> {
            Err(PersistError::Conflict { expect: 0 })
        }
        fn on_committed_expect(
            &self,
            _: &str,
            _: &CommitBatch,
            expect_rev: Option<u64>,
        ) -> Result<(), PersistError> {
            Err(PersistError::Conflict {
                expect: expect_rev.unwrap_or(0),
            })
        }
        fn flush_hint(&self, _: &str) -> Result<(), PersistError> {
            Ok(())
        }
    }

    let mut s = DocSession::new("cas-conflict").with_persistence(Box::new(CasConflictPlugin));
    let id = BlockId::new();
    let rev_before = s.rev();
    let err = s
        .apply(
            Origin::User,
            &[Op::Insert {
                id,
                parent: None,
                order: "a0".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            }],
        )
        .expect_err("CAS conflict must fail apply");
    // 类型化匹配：必须是 PersistConflict 变体（非 Persist(String)）
    match &err {
        ApplyError::PersistConflict { expected } => {
            // expect_rev = apply 前会话 rev（increment 前）
            assert_eq!(*expected, rev_before, "expected 应为 apply 前 rev");
        }
        other => panic!("期望 ApplyError::PersistConflict，得到 {other:?}"),
    }
    // P-H2 回滚：rev 不前进
    assert_eq!(s.rev(), rev_before, "CAS 冲突后 rev 不得前进");
}