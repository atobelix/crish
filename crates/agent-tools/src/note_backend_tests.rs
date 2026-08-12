//! `note_backend` 集成测（**SD-23** 外置；语义与拆前一致）。
//!
//! 由父模 [`crate::note_backend`] 经 `#[path]` 接入。公开 API 面；
//! plan 单测见 `note_plan_ops`。
//!
//! **≠ EL-05**；**≠ W6-E**；Memory 测绿 **禁关**生产 A-AGT / EL-05。
//! 不重写 trait 语义，只迁测。

use super::*;
use std::time::Duration;

#[tokio::test]
async fn memory_query_and_apply_outline() {
    let backend = MemoryNoteBackend::new();
    backend.seed_doc(
        "doc-1",
        vec![
            ("h1".into(), "heading".into(), "Title".into()),
            ("p1".into(), "paragraph".into(), "hello world".into()),
        ],
    );

    let q = backend
        .query_blocks(NoteQueryBlocksParams {
            doc_id: "doc-1".into(),
            text_match: Some("hello".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(q.blocks.len(), 1);
    assert_eq!(q.blocks[0].id, "p1");

    let applied = backend
        .apply_md_fragment(NoteApplyMdRequest {
            doc_id: "doc-1".into(),
            markdown: "## Section\nbody line".into(),
            parent_id: None,
            after_block_id: None,
            mode: NoteApplyMode::ApplyMdFragment,
            intent_id: Some("intent-1".into()),
            batch_id: None,
            message_id: None,
            origin: Some("agent".into()),
        })
        .await
        .unwrap();
    assert_eq!(applied.inserted, 2);
    assert!(!applied.idempotent);

    // 幂等
    let again = backend
        .apply_md_fragment(NoteApplyMdRequest {
            doc_id: "doc-1".into(),
            markdown: "## Section\nbody line".into(),
            parent_id: None,
            after_block_id: None,
            mode: NoteApplyMode::ApplyMdFragment,
            intent_id: Some("intent-1".into()),
            batch_id: None,
            message_id: None,
            origin: Some("agent".into()),
        })
        .await
        .unwrap();
    assert!(again.idempotent);
    assert_eq!(again.inserted, 0);
    assert_eq!(again.block_ids, applied.block_ids);

    let outline = backend.document_outline("doc-1", Some(6)).await.unwrap();
    assert!(
        outline.outline.iter().any(|n| n.title == "Title")
            || outline
                .outline
                .iter()
                .any(|n| n.children.iter().any(|c| c.title == "Section")
                    || n.title == "Section"),
        "outline should contain headings: {:?}",
        outline
    );
}

#[test]
fn batch_tokens_acquire_validate_release_expire() {
    let tokens = NoteBatchTokens::with_ttl(Duration::from_millis(50));
    assert!(tokens.validate("b1").is_err());
    tokens.acquire("b1").unwrap();
    tokens.validate("b1").unwrap();
    tokens.release("b1");
    assert!(matches!(
        tokens.validate("b1"),
        Err(NoteBackendError::BatchTokenInvalid(_))
    ));

    tokens.acquire("b2").unwrap();
    std::thread::sleep(Duration::from_millis(80));
    assert!(matches!(
        tokens.validate("b2"),
        Err(NoteBackendError::BatchTokenExpired(_))
    ));
}

#[tokio::test]
async fn memory_apply_requires_valid_batch_when_provided() {
    let backend = MemoryNoteBackend::new();
    let err = backend
        .apply_md_fragment(NoteApplyMdRequest {
            doc_id: "d".into(),
            markdown: "x".into(),
            parent_id: None,
            after_block_id: None,
            mode: NoteApplyMode::ApplyMdFragment,
            intent_id: None,
            batch_id: Some("missing".into()),
            message_id: None,
            origin: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(err, NoteBackendError::BatchTokenInvalid(_)));

    backend.batch_tokens().acquire("ok-batch").unwrap();
    let r = backend
        .apply_md_fragment(NoteApplyMdRequest {
            doc_id: "d".into(),
            markdown: "line".into(),
            parent_id: None,
            after_block_id: None,
            mode: NoteApplyMode::ApplyMdFragment,
            intent_id: None,
            batch_id: Some("ok-batch".into()),
            message_id: None,
            origin: None,
        })
        .await
        .unwrap();
    assert_eq!(r.inserted, 1);
}

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

#[tokio::test]
async fn memory_get_md_after_apply_contains_content_and_c_comment() {
    let backend = MemoryNoteBackend::new();
    backend
        .apply_md_fragment(NoteApplyMdRequest {
            doc_id: "doc-md".into(),
            markdown: "# Hello GetMd\n\nbody of get_md test".into(),
            parent_id: None,
            after_block_id: None,
            mode: NoteApplyMode::ApplyMdFragment,
            intent_id: None,
            batch_id: None,
            message_id: None,
            origin: Some("agent".into()),
        })
        .await
        .unwrap();

    let md = backend.get_md("doc-md").await.unwrap();
    assert!(
        md.contains("Hello GetMd") || md.contains("body of get_md"),
        "get_md must contain applied text, got: {md:?}"
    );
    assert!(
        md.contains("<!--c:"),
        "get_md should emit block id comments, got: {md:?}"
    );
    // 空 doc_id 非法
    let err = backend.get_md("").await.unwrap_err();
    assert!(matches!(err, NoteBackendError::Invalid(_)));
    // 未知文档 → 空串（非 mirror）
    assert_eq!(backend.get_md("ghost").await.unwrap(), "");
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
            attrs: serde_json::json!({ "x": 1 })
                .as_object()
                .cloned()
                .unwrap(),
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
