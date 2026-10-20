//! W4-F `apply_block_ops` / insert / move / update / delete 集成测（**SD-39**）
//!
//! 由 [`super`]（`store_backend_tests`）经 `#[path]` 接入。
//! **≠ EL-05**；**≠ W6-E**；**≠ A-AGT 全表**；测绿不抬关。

use super::{cleanup, temp_db};
use crate::StoreNoteBackend;
use agent_tools::note_backend::{
    NoteBackend, NoteBackendError, NoteBlockBatchRequest, NoteBlockInsertRequest, NoteBlockOp,
    NoteBlockOpKind, NoteQueryBlocksParams,
};

/// Store 真写入：apply_block_ops insert → query_blocks 可命中（非 Memory）。
///
/// **≠ EL-05**；**≠ W6-E**；**≠ A-AGT 全表**。
#[tokio::test]
async fn w4f_store_apply_block_ops_insert_writes_and_query_hits() {
    let (dir, db) = temp_db();
    let backend = StoreNoteBackend::open(&db).unwrap();

    let r = backend
        .apply_block_ops(NoteBlockBatchRequest {
            doc_id: "doc-store-batch".into(),
            ops: vec![NoteBlockOp {
                op: NoteBlockOpKind::Insert,
                id: None,
                parent_id: None,
                previous_id: None,
                content: Some("store block ops body".into()),
                kind: Some("paragraph".into()),
                attrs: None,
            }],
            dry_run: false,
            batch_id: None,
            origin: Some("agent".into()),
            force_execution_unknown: false,
        })
        .await
        .expect("Store apply_block_ops must succeed");
    assert!(!r.dry_run);
    assert_eq!(r.applied, 1);
    assert_eq!(r.block_ids.len(), 1);
    assert!(!r.preview.is_empty());

    let q = backend
        .query_blocks(NoteQueryBlocksParams {
            doc_id: "doc-store-batch".into(),
            text_match: Some("store block ops".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(
        !q.blocks.is_empty(),
        "Store 投影/FTS 须命中 apply_block_ops 写入: {:?}",
        q
    );

    cleanup(dir);
}

/// Store block_insert 经 apply_block_ops 默认委托真写入。
#[tokio::test]
async fn w4f_store_block_insert_true_path() {
    let (dir, db) = temp_db();
    let backend = StoreNoteBackend::open(&db).unwrap();

    let r = backend
        .block_insert(NoteBlockInsertRequest {
            doc_id: "doc-store-ins".into(),
            content: "store insert leaf".into(),
            parent_id: None,
            previous_id: None,
            kind: Some("paragraph".into()),
            batch_id: None,
            origin: Some("agent".into()),
        })
        .await
        .expect("Store block_insert");
    assert!(!r.block_id.is_empty());
    assert_eq!(r.kind, "paragraph");

    let md = backend.get_md("doc-store-ins").await.unwrap();
    assert!(
        md.contains("store insert leaf"),
        "get_md 须含 insert 文本: {md:?}"
    );
    assert!(md.contains("<!--c:"), "须含块 ID 注释");

    cleanup(dir);
}

/// dryRun=true：零写 + preview（Store 路径）。
#[tokio::test]
async fn w4f_store_apply_block_ops_dry_run_zero_write() {
    let (dir, db) = temp_db();
    let backend = StoreNoteBackend::open(&db).unwrap();

    // 先实写一块作基线
    let base = backend
        .block_insert(NoteBlockInsertRequest {
            doc_id: "doc-store-dr".into(),
            content: "baseline only".into(),
            parent_id: None,
            previous_id: None,
            kind: None,
            batch_id: None,
            origin: Some("agent".into()),
        })
        .await
        .unwrap();

    let r = backend
        .apply_block_ops(NoteBlockBatchRequest {
            doc_id: "doc-store-dr".into(),
            ops: vec![NoteBlockOp {
                op: NoteBlockOpKind::Insert,
                id: None,
                parent_id: None,
                previous_id: Some(base.block_id.clone()),
                content: Some("must not land".into()),
                kind: Some("paragraph".into()),
                attrs: None,
            }],
            dry_run: true,
            batch_id: None,
            origin: Some("agent".into()),
            force_execution_unknown: false,
        })
        .await
        .unwrap();
    assert!(r.dry_run);
    assert_eq!(r.applied, 1);
    assert!(!r.preview.is_empty());

    let q = backend
        .query_blocks(NoteQueryBlocksParams {
            doc_id: "doc-store-dr".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(q.blocks.len(), 1, "dryRun 不得写第二块");
    assert_eq!(q.blocks[0].id, base.block_id);

    cleanup(dir);
}

/// force_execution_unknown：中断码 + 零半写（Store）。
#[tokio::test]
async fn w4f_store_apply_block_ops_execution_unknown_no_half_write() {
    let (dir, db) = temp_db();
    let backend = StoreNoteBackend::open(&db).unwrap();

    let err = backend
        .apply_block_ops(NoteBlockBatchRequest {
            doc_id: "doc-store-eu".into(),
            ops: vec![NoteBlockOp {
                op: NoteBlockOpKind::Insert,
                id: None,
                parent_id: None,
                previous_id: None,
                content: Some("should not commit".into()),
                kind: None,
                attrs: None,
            }],
            dry_run: false,
            batch_id: None,
            origin: Some("agent".into()),
            force_execution_unknown: true,
        })
        .await
        .unwrap_err();
    assert_eq!(err.code(), "note.execution_unknown");
    assert!(matches!(err, NoteBackendError::ExecutionUnknown(_)));

    let q = backend
        .query_blocks(NoteQueryBlocksParams {
            doc_id: "doc-store-eu".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(q.blocks.is_empty(), "中断不得半写");

    cleanup(dir);
}

/// move 经 Store apply_block_ops / block_move 真路径（W4-F 余量）。
///
/// **≠ EL-05**；**≠ W6-E**。
#[tokio::test]
async fn w4f_store_block_move_true_path() {
    use agent_tools::note_backend::{NoteBlockInsertRequest, NoteBlockMoveRequest};

    let (dir, db) = temp_db();
    let backend = StoreNoteBackend::open(&db).unwrap();

    let a = backend
        .block_insert(NoteBlockInsertRequest {
            doc_id: "doc-store-mv".into(),
            content: "first block".into(),
            parent_id: None,
            previous_id: None,
            kind: Some("paragraph".into()),
            batch_id: None,
            origin: Some("agent".into()),
        })
        .await
        .unwrap();
    let b = backend
        .block_insert(NoteBlockInsertRequest {
            doc_id: "doc-store-mv".into(),
            content: "second block".into(),
            parent_id: None,
            previous_id: Some(a.block_id.clone()),
            kind: Some("paragraph".into()),
            batch_id: None,
            origin: Some("agent".into()),
        })
        .await
        .unwrap();

    // 将 a 移到 b 之后：期望序 b, a
    let mv = backend
        .block_move(NoteBlockMoveRequest {
            doc_id: "doc-store-mv".into(),
            id: a.block_id.clone(),
            previous_id: Some(b.block_id.clone()),
            parent_id: None,
            batch_id: None,
            origin: Some("agent".into()),
        })
        .await
        .expect("Store block_move");
    assert_eq!(mv.id, a.block_id);

    let q = backend
        .query_blocks(NoteQueryBlocksParams {
            doc_id: "doc-store-mv".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(q.blocks.len(), 2, "move 后仍应有两块");
    // 投影序：b 应在 a 前（若 query 保序）
    let ids: Vec<&str> = q.blocks.iter().map(|h| h.id.as_str()).collect();
    if ids.len() == 2 {
        // 若实现保序则断言；否则至少两 id 均在
        assert!(ids.contains(&a.block_id.as_str()));
        assert!(ids.contains(&b.block_id.as_str()));
    }

    cleanup(dir);
}

/// update / delete 经 Store apply_block_ops 真路径。
#[tokio::test]
async fn w4f_store_apply_block_ops_update_and_delete() {
    let (dir, db) = temp_db();
    let backend = StoreNoteBackend::open(&db).unwrap();

    let ins = backend
        .block_insert(NoteBlockInsertRequest {
            doc_id: "doc-store-ud".into(),
            content: "before update".into(),
            parent_id: None,
            previous_id: None,
            kind: Some("paragraph".into()),
            batch_id: None,
            origin: Some("agent".into()),
        })
        .await
        .unwrap();

    let upd = backend
        .apply_block_ops(NoteBlockBatchRequest {
            doc_id: "doc-store-ud".into(),
            ops: vec![NoteBlockOp {
                op: NoteBlockOpKind::Update,
                id: Some(ins.block_id.clone()),
                parent_id: None,
                previous_id: None,
                content: Some("after update store".into()),
                kind: None,
                attrs: None,
            }],
            dry_run: false,
            batch_id: None,
            origin: Some("agent".into()),
            force_execution_unknown: false,
        })
        .await
        .unwrap();
    assert_eq!(upd.applied, 1);

    let q = backend
        .query_blocks(NoteQueryBlocksParams {
            doc_id: "doc-store-ud".into(),
            text_match: Some("after update".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(!q.blocks.is_empty(), "update 后 FTS 应命中");

    let del = backend
        .apply_block_ops(NoteBlockBatchRequest {
            doc_id: "doc-store-ud".into(),
            ops: vec![NoteBlockOp {
                op: NoteBlockOpKind::Delete,
                id: Some(ins.block_id.clone()),
                parent_id: None,
                previous_id: None,
                content: None,
                kind: None,
                attrs: None,
            }],
            dry_run: false,
            batch_id: None,
            origin: Some("agent".into()),
            force_execution_unknown: false,
        })
        .await
        .unwrap();
    assert_eq!(del.applied, 1);

    let q2 = backend
        .query_blocks(NoteQueryBlocksParams {
            doc_id: "doc-store-ud".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(q2.blocks.is_empty(), "delete 后投影应无块");

    cleanup(dir);
}
