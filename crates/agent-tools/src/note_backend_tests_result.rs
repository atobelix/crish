//! W4-A/F/R Memory 形状测（**SD-47** 按域拆）
//!
//! 由 [`super`]（`note_backend_tests`）经 `#[path]` 接入。
//! **≠ EL-05**；**≠ A-AGT 满表**；**≠ W6-E**；Memory 测绿 **禁关**生产。

use super::super::*;

/// W4-A：工具 result JSON 必须含 `lossy.items`（可观测；空数组亦合法）。
/// **≠ EL-05**；仅证形状，不关 A-AGT。
#[test]
fn apply_result_json_exposes_lossy_items() {
    let result = NoteApplyMdResult {
        block_ids: vec!["b1".into()],
        inserted: 1,
        idempotent: false,
        lossy: NoteLossyReport {
            items: vec![NoteLossyItem {
                code: "missing_block_id".into(),
                detail: "paragraph without <!--c:UUID-->".into(),
                line: Some(1),
            }],
        },
    };
    let j = apply_result_json(&result);
    assert_eq!(j["ok"], true);
    assert_eq!(j["inserted"], 1);
    assert_eq!(j["block_ids"][0], "b1");
    let items = j["lossy"]["items"]
        .as_array()
        .expect("lossy.items must be array");
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["code"], "missing_block_id");
    assert_eq!(items[0]["line"], 1);
    assert!(
        items[0]["detail"]
            .as_str()
            .unwrap_or("")
            .contains("paragraph"),
        "detail should be human-readable"
    );
}

/// W4-A：空 lossy 亦进入结果面（items=[]），禁止缺字段冒充「未定义」。
#[test]
fn apply_result_json_empty_lossy_still_present() {
    let result = NoteApplyMdResult {
        block_ids: vec![],
        inserted: 0,
        idempotent: false,
        lossy: NoteLossyReport::default(),
    };
    let j = apply_result_json(&result);
    assert!(j.get("lossy").is_some(), "lossy key required");
    assert!(
        j["lossy"]["items"].as_array().unwrap().is_empty(),
        "empty items when no lossy"
    );
}

// ── W4-F：block_batch / dryRun / execution_unknown（Memory 形状）──

/// A-AGT-05 形状：dryRun=true 零写权威树，返回 preview
#[tokio::test]
async fn w4f_memory_block_batch_dry_run_zero_write() {
    let backend = MemoryNoteBackend::new();
    backend.seed_doc(
        "doc-b",
        vec![("p1".into(), "paragraph".into(), "keep".into())],
    );
    let r = backend
        .apply_block_ops(NoteBlockBatchRequest {
            doc_id: "doc-b".into(),
            ops: vec![NoteBlockOp {
                op: NoteBlockOpKind::Insert,
                id: None,
                parent_id: None,
                previous_id: Some("p1".into()),
                content: Some("new line".into()),
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
    // 权威树未变
    let q = backend
        .query_blocks(NoteQueryBlocksParams {
            doc_id: "doc-b".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(q.blocks.len(), 1);
    assert_eq!(q.blocks[0].id, "p1");
}

/// 实写 insert 进树
#[tokio::test]
async fn w4f_memory_block_batch_apply_insert() {
    let backend = MemoryNoteBackend::new();
    let r = backend
        .apply_block_ops(NoteBlockBatchRequest {
            doc_id: "doc-w".into(),
            ops: vec![NoteBlockOp {
                op: NoteBlockOpKind::Insert,
                id: None,
                parent_id: None,
                previous_id: None,
                content: Some("hello batch".into()),
                kind: Some("paragraph".into()),
                attrs: None,
            }],
            dry_run: false,
            batch_id: None,
            origin: Some("agent".into()),
            force_execution_unknown: false,
        })
        .await
        .unwrap();
    assert!(!r.dry_run);
    assert_eq!(r.applied, 1);
    assert_eq!(r.block_ids.len(), 1);
    let q = backend
        .query_blocks(NoteQueryBlocksParams {
            doc_id: "doc-w".into(),
            text_match: Some("hello batch".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(q.blocks.len(), 1);
}

/// A-AGT-07：execution_unknown 中断 → 可识别码 + 零半写
#[tokio::test]
async fn w4f_memory_block_batch_execution_unknown_no_half_write() {
    let backend = MemoryNoteBackend::new();
    backend.seed_doc(
        "doc-x",
        vec![("p1".into(), "paragraph".into(), "only".into())],
    );
    let err = backend
        .apply_block_ops(NoteBlockBatchRequest {
            doc_id: "doc-x".into(),
            ops: vec![NoteBlockOp {
                op: NoteBlockOpKind::Insert,
                id: None,
                parent_id: None,
                previous_id: None,
                content: Some("must not land".into()),
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
            doc_id: "doc-x".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(q.blocks.len(), 1, "中断不得半写");
    assert_eq!(q.blocks[0].id, "p1");
}

/// 细粒度 block_insert 默认路径
#[tokio::test]
async fn w4f_memory_block_insert() {
    let backend = MemoryNoteBackend::new();
    let r = backend
        .block_insert(NoteBlockInsertRequest {
            doc_id: "doc-i".into(),
            content: "inserted".into(),
            parent_id: None,
            previous_id: None,
            kind: Some("paragraph".into()),
            batch_id: None,
            origin: Some("agent".into()),
        })
        .await
        .unwrap();
    assert!(!r.block_id.is_empty());
    assert_eq!(r.kind, "paragraph");
}

/// W4-R：Memory `block_set_attr` 成功改属性（≠ EL-05 / ≠ 生产满表）
#[tokio::test]
async fn w4r_memory_block_set_attr_updates_attrs() {
    let backend = MemoryNoteBackend::new();
    backend.seed_doc(
        "doc-sa",
        vec![("b1".into(), "paragraph".into(), "body".into())],
    );
    let r = backend
        .block_set_attr(NoteBlockSetAttrRequest {
            doc_id: "doc-sa".into(),
            id: "b1".into(),
            attrs: serde_json::json!({ "checked": true, "level": 2 })
                .as_object()
                .cloned()
                .unwrap(),
            batch_id: None,
            origin: Some("agent".into()),
        })
        .await
        .unwrap();
    assert_eq!(r.id, "b1");
    let q = backend
        .query_blocks(NoteQueryBlocksParams {
            doc_id: "doc-sa".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(q.blocks.len(), 1);
    assert_eq!(q.blocks[0].attrs["checked"], true);
    assert_eq!(q.blocks[0].attrs["level"], 2);
}

/// W4-R：空 id 失败（委托 SetAttr / plan_set_attr）
#[tokio::test]
async fn w4r_memory_block_set_attr_empty_id_fails() {
    let backend = MemoryNoteBackend::new();
    backend.seed_doc(
        "doc-eid",
        vec![("b1".into(), "paragraph".into(), "stay".into())],
    );
    let err = backend
        .block_set_attr(NoteBlockSetAttrRequest {
            doc_id: "doc-eid".into(),
            id: "".into(),
            attrs: serde_json::json!({ "x": 1 }).as_object().cloned().unwrap(),
            batch_id: None,
            origin: Some("agent".into()),
        })
        .await
        .unwrap_err();
    assert!(matches!(err, NoteBackendError::Invalid(_)));
    assert!(
        err.message().contains("non-empty id"),
        "empty id must fail: {err:?}"
    );
    let q = backend
        .query_blocks(NoteQueryBlocksParams {
            doc_id: "doc-eid".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(q.blocks[0].attrs.is_empty(), "空 id 不得改属性");
}

/// 细粒度 block_move：b1 移到 b2 之后（Memory）
#[tokio::test]
async fn w4f_memory_block_move_reorders() {
    let backend = MemoryNoteBackend::new();
    backend.seed_doc(
        "doc-mv",
        vec![
            ("b1".into(), "paragraph".into(), "one".into()),
            ("b2".into(), "paragraph".into(), "two".into()),
            ("b3".into(), "paragraph".into(), "three".into()),
        ],
    );
    let r = backend
        .block_move(NoteBlockMoveRequest {
            doc_id: "doc-mv".into(),
            id: "b1".into(),
            previous_id: Some("b2".into()),
            parent_id: None,
            batch_id: None,
            origin: Some("agent".into()),
        })
        .await
        .unwrap();
    assert_eq!(r.id, "b1");
    let q = backend
        .query_blocks(NoteQueryBlocksParams {
            doc_id: "doc-mv".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    let ids: Vec<&str> = q.blocks.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(ids, vec!["b2", "b1", "b3"]);
}

#[test]
fn w4f_block_batch_result_json_shape() {
    let r = NoteBlockBatchResult {
        dry_run: true,
        applied: 1,
        block_ids: vec!["b1".into()],
        preview: vec![NoteBlockOpPreview {
            op: "insert".into(),
            id: Some("b1".into()),
            kind: Some("paragraph".into()),
            summary: Some("x".into()),
        }],
    };
    let j = block_batch_result_json(&r);
    assert_eq!(j["ok"], true);
    assert_eq!(j["dry_run"], true);
    assert_eq!(j["dryRun"], true);
    assert_eq!(j["applied"], 1);
    assert_eq!(j["preview"][0]["op"], "insert");
}

#[test]
fn w4f_backend_err_execution_unknown_maps_stable_code() {
    let e = backend_err_to_tool_err(
        "block_batch",
        NoteBackendError::ExecutionUnknown("interrupted".into()),
    );
    assert_eq!(e.code(), "note.execution_unknown");
}
