//! # SD-07 · 双 plan 引擎对齐契约（Memory ∥ Store）
//!
//! 共享用例：同 `NoteBlockOp` 入参 → 双后端 **同稳定错误码** 或 **同 dry_run 零写形状**。
//! 经公开 [`NoteBackend`] API 测（不侵入 `plan_block_ops_to_collab` 私有路径；
//! 避免与 SD-06 整文件切开抢写）。
//!
//! | ID | 场景 | 期望 |
//! | -- | ---- | ---- |
//! | **P-01** | insert 预分配 id 冲突 | `note.id_conflict` |
//! | **P-02** | insert previous 不存在 | `note.not_found` |
//! | **P-03** | update 目标不存在 | `note.not_found` |
//! | **P-04** | dry_run 成功 | preview + 零写 |
//! | **P-05** | force_execution_unknown | `note.execution_unknown` + 零半写 |
//! | **P-06** | update 缺 content | `note.invalid` |
//!
//! 有意差异（D-01…D-05）见 `agent_tools` `note_plan_ops` 模块文档；本文件末尾
//! 有 D-01 可审计断言（Store 拒非 UUID / Memory 接受）。
//!
//! **≠ EL-05**；不删除 Memory；不合并为强耦共 crate。
//!
//! 门禁：`cargo test -p conex-note-runtime --test note_plan_parity`

#![allow(clippy::disallowed_methods)]

use agent_tools::note_backend::{
    MemoryNoteBackend, NoteBackend, NoteBackendError, NoteBlockBatchRequest, NoteBlockOp,
    NoteBlockOpKind, NoteQueryBlocksParams,
};
use conex_note_runtime::StoreNoteBackend;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// 固定 UUID 形 id（双端均可作块 id；Store 强制 UUID）。
const SEED_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GHOST_ID: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONFLICT_ID: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

fn temp_db() -> (std::path::PathBuf, std::path::PathBuf) {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "conex-plan-parity-{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        n
    ));
    let _ = std::fs::create_dir_all(&dir);
    let db = dir.join("workspace.db");
    (dir, db)
}

fn batch(
    doc_id: &str,
    ops: Vec<NoteBlockOp>,
    dry_run: bool,
    force_execution_unknown: bool,
) -> NoteBlockBatchRequest {
    NoteBlockBatchRequest {
        doc_id: doc_id.into(),
        ops,
        dry_run,
        batch_id: None,
        origin: Some("agent".into()),
        force_execution_unknown,
    }
}

fn op_insert(id: Option<&str>, previous_id: Option<&str>, content: &str) -> NoteBlockOp {
    NoteBlockOp {
        op: NoteBlockOpKind::Insert,
        id: id.map(str::to_string),
        parent_id: None,
        previous_id: previous_id.map(str::to_string),
        content: Some(content.into()),
        kind: Some("paragraph".into()),
        attrs: None,
    }
}

fn op_update(id: &str, content: Option<&str>) -> NoteBlockOp {
    NoteBlockOp {
        op: NoteBlockOpKind::Update,
        id: Some(id.into()),
        parent_id: None,
        previous_id: None,
        content: content.map(str::to_string),
        kind: None,
        attrs: None,
    }
}

/// 种子一块（固定 id），供后续冲突 / 锚点用例。
async fn seed_paragraph(backend: &dyn NoteBackend, doc_id: &str, id: &str, text: &str) {
    let r = backend
        .apply_block_ops(batch(
            doc_id,
            vec![op_insert(Some(id), None, text)],
            false,
            false,
        ))
        .await
        .expect("seed insert must succeed");
    assert_eq!(r.applied, 1);
    assert!(r.block_ids.iter().any(|b| b == id));
}

async fn block_count(backend: &dyn NoteBackend, doc_id: &str) -> usize {
    backend
        .query_blocks(NoteQueryBlocksParams {
            doc_id: doc_id.into(),
            ..Default::default()
        })
        .await
        .expect("query")
        .blocks
        .len()
}

// ── 共享用例 runner（Memory 与 Store 各跑一遍）──────────────────────

async fn run_p01_id_conflict(backend: &dyn NoteBackend, doc_id: &str) {
    seed_paragraph(backend, doc_id, CONFLICT_ID, "seed").await;
    let err = backend
        .apply_block_ops(batch(
            doc_id,
            vec![op_insert(Some(CONFLICT_ID), None, "dup")],
            false,
            false,
        ))
        .await
        .expect_err("P-01 expects IdConflict");
    assert_eq!(err.code(), "note.id_conflict", "P-01 {err:?}");
    assert!(matches!(err, NoteBackendError::IdConflict(_)));
    assert_eq!(block_count(backend, doc_id).await, 1, "P-01 不得半写");
}

async fn run_p02_previous_not_found(backend: &dyn NoteBackend, doc_id: &str) {
    seed_paragraph(backend, doc_id, SEED_ID, "anchor").await;
    let err = backend
        .apply_block_ops(batch(
            doc_id,
            vec![op_insert(None, Some(GHOST_ID), "orphan")],
            false,
            false,
        ))
        .await
        .expect_err("P-02 expects NotFound");
    assert_eq!(err.code(), "note.not_found", "P-02 {err:?}");
    assert!(
        err.message().contains("previous_id") || err.message().contains(GHOST_ID),
        "P-02 message should mention previous: {}",
        err.message()
    );
    assert_eq!(block_count(backend, doc_id).await, 1, "P-02 不得半写");
}

async fn run_p03_update_not_found(backend: &dyn NoteBackend, doc_id: &str) {
    seed_paragraph(backend, doc_id, SEED_ID, "keep").await;
    let err = backend
        .apply_block_ops(batch(
            doc_id,
            vec![op_update(GHOST_ID, Some("nope"))],
            false,
            false,
        ))
        .await
        .expect_err("P-03 expects NotFound");
    assert_eq!(err.code(), "note.not_found", "P-03 {err:?}");
    assert_eq!(block_count(backend, doc_id).await, 1, "P-03 不得半写");
}

async fn run_p04_dry_run_zero_write(backend: &dyn NoteBackend, doc_id: &str) {
    seed_paragraph(backend, doc_id, SEED_ID, "baseline").await;
    let r = backend
        .apply_block_ops(batch(
            doc_id,
            vec![op_insert(None, Some(SEED_ID), "must not land")],
            true,
            false,
        ))
        .await
        .expect("P-04 dry_run plan ok");
    assert!(r.dry_run, "P-04 dry_run flag");
    assert_eq!(r.applied, 1);
    assert!(!r.preview.is_empty(), "P-04 preview");
    assert_eq!(block_count(backend, doc_id).await, 1, "P-04 dry_run 零写");
}

async fn run_p05_execution_unknown(backend: &dyn NoteBackend, doc_id: &str) {
    seed_paragraph(backend, doc_id, SEED_ID, "only").await;
    let err = backend
        .apply_block_ops(batch(
            doc_id,
            vec![op_insert(None, None, "should not commit")],
            false,
            true,
        ))
        .await
        .expect_err("P-05 expects ExecutionUnknown");
    assert_eq!(err.code(), "note.execution_unknown", "P-05 {err:?}");
    assert!(matches!(err, NoteBackendError::ExecutionUnknown(_)));
    assert_eq!(block_count(backend, doc_id).await, 1, "P-05 零半写");
}

async fn run_p06_invalid_update(backend: &dyn NoteBackend, doc_id: &str) {
    seed_paragraph(backend, doc_id, SEED_ID, "keep").await;
    let err = backend
        .apply_block_ops(batch(doc_id, vec![op_update(SEED_ID, None)], false, false))
        .await
        .expect_err("P-06 expects Invalid");
    assert_eq!(err.code(), "note.invalid", "P-06 {err:?}");
    assert!(matches!(err, NoteBackendError::Invalid(_)));
    assert_eq!(block_count(backend, doc_id).await, 1, "P-06 不得半写");
}

async fn run_all_shared(backend: &dyn NoteBackend, prefix: &str) {
    run_p01_id_conflict(backend, &format!("{prefix}-p01")).await;
    run_p02_previous_not_found(backend, &format!("{prefix}-p02")).await;
    run_p03_update_not_found(backend, &format!("{prefix}-p03")).await;
    run_p04_dry_run_zero_write(backend, &format!("{prefix}-p04")).await;
    run_p05_execution_unknown(backend, &format!("{prefix}-p05")).await;
    run_p06_invalid_update(backend, &format!("{prefix}-p06")).await;
}

// ── 入口：Memory / Store 各一套 ─────────────────────────────────────

#[tokio::test]
async fn sd07_memory_shared_plan_cases() {
    let backend = MemoryNoteBackend::new();
    run_all_shared(&backend, "mem").await;
}

#[tokio::test]
async fn sd07_store_shared_plan_cases() {
    let (dir, db) = temp_db();
    let backend = StoreNoteBackend::open(&db).expect("open store");
    run_all_shared(&backend, "store").await;
    let _ = std::fs::remove_dir_all(dir);
}

/// D-01 有意差异：非 UUID id → Store `note.invalid`；Memory 接受并写入。
///
/// 登记在差异表，**禁止**单端 silently 改到另一语义而不改表。
#[tokio::test]
async fn sd07_d01_id_format_intentional_diff() {
    let non_uuid = "not-a-uuid-id";

    // Memory：任意非空串合法
    let mem = MemoryNoteBackend::new();
    let mem_ok = mem
        .apply_block_ops(batch(
            "mem-d01",
            vec![op_insert(Some(non_uuid), None, "mem accepts")],
            false,
            false,
        ))
        .await
        .expect("Memory accepts non-UUID id (D-01)");
    assert_eq!(mem_ok.block_ids, vec![non_uuid.to_string()]);

    // Store：须 UUID
    let (dir, db) = temp_db();
    let store = StoreNoteBackend::open(&db).unwrap();
    let store_err = store
        .apply_block_ops(batch(
            "store-d01",
            vec![op_insert(Some(non_uuid), None, "store rejects")],
            false,
            false,
        ))
        .await
        .expect_err("Store rejects non-UUID id (D-01)");
    assert_eq!(
        store_err.code(),
        "note.invalid",
        "D-01 Store must Invalid, got {store_err:?}"
    );
    assert!(matches!(store_err, NoteBackendError::Invalid(_)));
    assert_eq!(block_count(&store, "store-d01").await, 0);

    let _ = std::fs::remove_dir_all(dir);
}
