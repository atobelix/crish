//! Memory query/apply/get_md + batch token 集成测（**SD-47** 按域拆）
//!
//! 由 [`super`]（`note_backend_tests`）经 `#[path]` 接入。
//! **≠ EL-05**；**≠ A-AGT 满表**；Memory 测绿 **禁关**生产。

use super::super::*;
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
                .any(|n| n.children.iter().any(|c| c.title == "Section") || n.title == "Section"),
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
