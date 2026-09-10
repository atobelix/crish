//! CT-01 CAS（乐观锁）· 双会话陈旧写全分支（T5–T7）
//!
//! 验收锚：`docs/review-md-audit/2026-08-13-wave/plans/D-06` §五 T5/T6/T7；
//! `00-执行方案定稿`（CT-01 排 SR-06g-1 后）。
//!
//! ## 场景语义
//! - 同进程双会话 = 跨进程并发写同一 doc 的可确定性复现（无需线程/sleep）。
//! - 陈旧写入者被 `PersistError::Conflict` 拦截 → 既有 P-H2 快照回滚
//!   （rev 保持、updates 零追加、seq 不空洞）。
//!
//! ## 诚实边界
//! - **CAS = 检测并报错，不自动合并**；≠ 冲突解决 / ≠ 自动合并 / ≠ EL 关账。
//! - 同进程双会话 ≠ 跨进程实测（跨进程语义同构，本测为确定性复现）。

use conex_doc_collab::{
    ApplyError, BlockId, BlockKind, BlockProps, CommitBatch, DocSession, HydrateBlob, Op, Origin,
    PersistError, PersistencePlugin, UndoError,
};
use conex_workspace_store::SharedWorkspaceStore;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!(
            "conex-cas-dual-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            n
        ));
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }

    fn db(&self) -> PathBuf {
        self.0.join("workspace.db")
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// 从 store 现行权威态水合一个会话（新 doc → rev=0 空会话）。
fn hydrate_session(store: &SharedWorkspaceStore, doc_id: &str) -> DocSession {
    let blob: HydrateBlob = store.load_doc(doc_id).expect("load_doc");
    DocSession::hydrate(doc_id, blob).expect("hydrate")
}

fn insert_op(id: BlockId, order: &str) -> Op {
    Op::Insert {
        id,
        parent: None,
        order: order.into(),
        kind: BlockKind::Paragraph,
        props: BlockProps::default(),
    }
}

/// T5 · 会话级主场景：双会话陈旧写失败分支（三断言 + 权威线未断）。
#[test]
fn cas_dual_session_stale_write_conflicts_and_rolls_back() {
    let dir = TempDir::new();
    let store = SharedWorkspaceStore::open(dir.db()).unwrap();
    let doc_id = "doc-cas-t5";

    // 双会话从同一初始权威（rev=0）水合；B 是「陈旧会话」
    let mut a = hydrate_session(&store, doc_id).with_persistence(Box::new(store.clone()));
    let mut b = hydrate_session(&store, doc_id).with_persistence(Box::new(store.clone()));
    assert_eq!(a.rev(), 0);
    assert_eq!(b.rev(), 0);

    // A 写入成功 → DB rev=1，updates=N
    let id_a = BlockId::new();
    a.apply(Origin::User, &[insert_op(id_a, "a0")])
        .expect("A 首写");
    assert_eq!(store.load_rev(doc_id).unwrap(), 1);
    let updates_before = store.load_pending_count(doc_id).unwrap();

    // B 陈旧写（期望 rev=0，DB 已 1）→ Conflict（ApplyError::Persist 含 "conflict"）
    let id_b = BlockId::new();
    let err = b
        .apply(Origin::User, &[insert_op(id_b, "b0")])
        .expect_err("B 陈旧写必须失败");
    assert!(
        matches!(
            &err,
            ApplyError::PersistConflict { .. } | ApplyError::Persist(_)
        ),
        "err={err:?}"
    );

    // 断言①：doc_meta.rev == 1（不被 B 覆盖）
    assert_eq!(store.load_rev(doc_id).unwrap(), 1);
    // 断言②：doc_updates 计数 == N（B 零追加）
    assert_eq!(store.load_pending_count(doc_id).unwrap(), updates_before);
    // 断言③：B.rev() == 0 且 B.tree() 无 B 的块 → P-H2 内存态回滚生效
    assert_eq!(b.rev(), 0);
    assert!(b.tree().get(&id_b).is_none());

    // 再断言：A 继续 apply → Ok，rev=2（权威线未断）
    let id_a2 = BlockId::new();
    a.apply(Origin::User, &[insert_op(id_a2, "a1")])
        .expect("A 续写");
    assert_eq!(store.load_rev(doc_id).unwrap(), 2);

    // load_doc 后 hydrate 树 ≡ A 的树（含 a/a2，不含 b）
    let h = hydrate_session(&store, doc_id);
    assert_eq!(h.rev(), 2);
    assert!(h.tree().get(&id_a).is_some());
    assert!(h.tree().get(&id_a2).is_some());
    assert!(h.tree().get(&id_b).is_none());
}

/// T6 · 陈旧会话 undo 路径：期望 = rev_before，被 Conflict 拦截，栈深度回滚。
#[test]
fn cas_dual_session_stale_undo_conflicts() {
    let dir = TempDir::new();
    let store = SharedWorkspaceStore::open(dir.db()).unwrap();
    let doc_id = "doc-cas-t6";

    let mut b = hydrate_session(&store, doc_id).with_persistence(Box::new(store.clone()));

    // B 先写一步（占栈，DB rev=1）
    let id_b = BlockId::new();
    b.apply(Origin::User, &[insert_op(id_b, "b0")])
        .expect("B 写");
    assert_eq!(store.load_rev(doc_id).unwrap(), 1);
    assert_eq!(b.undo_len(), 1);

    // 另一会话 A 基于最新权威（rev=1）重新水合后再推进 → DB rev=2
    // （若 A 仍持旧 rev=0 会话，其 apply 本身就会被 CAS 拦截——那是 T5 的场景）
    let mut a = hydrate_session(&store, doc_id).with_persistence(Box::new(store.clone()));
    assert_eq!(a.rev(), 1);
    a.apply(Origin::User, &[insert_op(BlockId::new(), "a0")])
        .expect("A 写");
    assert_eq!(store.load_rev(doc_id).unwrap(), 2);
    let updates_before = store.load_pending_count(doc_id).unwrap();

    // B 陈旧 undo：期望 rev_before=1 vs DB rev=2 → Conflict
    let err = b.undo(None).expect_err("陈旧 undo 必须失败");
    assert!(
        matches!(&err, UndoError::Persist(msg) if msg.contains("conflict")),
        "err={err:?}"
    );

    // 回滚断言：rev/栈深度还原，DB 不变
    assert_eq!(b.rev(), 1);
    assert_eq!(b.undo_len(), 1);
    assert_eq!(store.load_rev(doc_id).unwrap(), 2);
    assert_eq!(store.load_pending_count(doc_id).unwrap(), updates_before);
}

/// 最小插件：只实现 3 个必选方法，**不**覆写 `on_committed_expect`（走 trait 默认实现）。
///
/// 与 `MemoryPersistence`（不对外 re-export）行为同构：默认实现忽略期望值 = 旧 LWW 兼容。
struct NoopPersistence;

impl PersistencePlugin for NoopPersistence {
    fn load_doc(&self, _doc_id: &str) -> Result<HydrateBlob, PersistError> {
        Ok(HydrateBlob::default())
    }

    fn on_committed(&self, _doc_id: &str, _commit: &CommitBatch) -> Result<(), PersistError> {
        Ok(())
    }

    fn flush_hint(&self, _doc_id: &str) -> Result<(), PersistError> {
        Ok(())
    }
}

/// T7 · 默认实现忽略期望（兼容护栏）：apply 两次均 Ok，行为与现状一致。
#[test]
fn cas_default_impl_ignores_expect_rev() {
    let mut s = DocSession::new("doc-cas-t7").with_persistence(Box::new(NoopPersistence));
    let id1 = BlockId::new();
    s.apply(Origin::User, &[insert_op(id1, "a0")])
        .expect("首次 apply");
    let id2 = BlockId::new();
    s.apply(Origin::User, &[insert_op(id2, "a1")])
        .expect("二次 apply");
    assert_eq!(s.rev(), 2);
    assert!(s.tree().get(&id1).is_some());
    assert!(s.tree().get(&id2).is_some());
}
