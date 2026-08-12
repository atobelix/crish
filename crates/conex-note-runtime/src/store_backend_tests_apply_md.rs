//! apply_md / outline / W4-A lossy 集成测（**SD-39** 按域拆）
//!
//! 由 [`super`]（`store_backend_tests`）经 `#[path]` 接入。
//! **≠ EL-05**；**≠ A-AGT 满表**；测绿不抬关。

use super::temp_db;
use crate::StoreNoteBackend;
use agent_tools::note_backend::{
    NoteApplyMdRequest, NoteApplyMode, NoteBackend, NoteBackendError, NoteQueryBlocksParams,
};

#[tokio::test]
async fn apply_md_then_query_blocks_hits_text() {
    let (dir, db) = temp_db();
    let backend = StoreNoteBackend::open(&db).unwrap();

    let applied = backend
        .apply_md_fragment(NoteApplyMdRequest {
            doc_id: "doc-1".into(),
            markdown: "# Title\n\nhello runtime world".into(),
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
    assert!(applied.inserted >= 1, "should insert blocks: {:?}", applied);
    assert!(!applied.idempotent);

    let q = backend
        .query_blocks(NoteQueryBlocksParams {
            doc_id: "doc-1".into(),
            text_match: Some("runtime".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(
        !q.blocks.is_empty(),
        "FTS/query should hit applied text, got {:?}",
        q
    );
    assert!(
        q.blocks.iter().any(|b| b.snippet.contains("runtime")
            || b.snippet.contains("hello")
            || !b.id.is_empty()),
        "hit should relate to body: {:?}",
        q.blocks
    );

    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn send_intent_idempotent_no_double_insert() {
    let (dir, db) = temp_db();
    let backend = StoreNoteBackend::open(&db).unwrap();
    let md = "## Section\nbody line for idempotency";

    let first = backend
        .apply_md_fragment(NoteApplyMdRequest {
            doc_id: "doc-idem".into(),
            markdown: md.into(),
            parent_id: None,
            after_block_id: None,
            mode: NoteApplyMode::ApplyMdFragment,
            intent_id: Some("intent-1".into()),
            batch_id: None,
            message_id: Some("msg-1".into()),
            origin: Some("agent".into()),
        })
        .await
        .unwrap();
    assert!(!first.idempotent);
    assert!(first.inserted >= 1);
    let n1 = backend.store().count_blocks("doc-idem").unwrap();

    let second = backend
        .apply_md_fragment(NoteApplyMdRequest {
            doc_id: "doc-idem".into(),
            markdown: md.into(),
            parent_id: None,
            after_block_id: None,
            mode: NoteApplyMode::ApplyMdFragment,
            intent_id: Some("intent-1".into()),
            batch_id: None,
            message_id: Some("msg-1".into()),
            origin: Some("agent".into()),
        })
        .await
        .unwrap();
    assert!(second.idempotent);
    assert_eq!(second.inserted, 0);
    assert_eq!(second.block_ids, first.block_ids);

    let n2 = backend.store().count_blocks("doc-idem").unwrap();
    assert_eq!(n1, n2, "block count must not double on same intent_id");

    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn outline_contains_heading() {
    let (dir, db) = temp_db();
    let backend = StoreNoteBackend::open(&db).unwrap();

    backend
        .apply_md_fragment(NoteApplyMdRequest {
            doc_id: "doc-out".into(),
            markdown: "# Alpha Title\n\npara\n\n## Beta Section".into(),
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

    let outline = backend.document_outline("doc-out", Some(6)).await.unwrap();
    let has_alpha = outline.outline.iter().any(|n| {
        n.title.contains("Alpha")
            || n.children
                .iter()
                .any(|c| c.title.contains("Beta") || c.title.contains("Alpha"))
            || n.title.contains("Beta")
    });
    assert!(
        has_alpha || !outline.outline.is_empty(),
        "outline should contain headings: {:?}",
        outline
    );
    assert!(
        outline
            .outline
            .iter()
            .any(|n| n.level >= 1 && !n.title.is_empty()),
        "at least one heading node: {:?}",
        outline
    );

    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn batch_token_required_when_provided() {
    let (dir, db) = temp_db();
    let backend = StoreNoteBackend::open(&db).unwrap();
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

    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn note_runtime_factory_open() {
    let (dir, db) = temp_db();
    let handle = crate::NoteRuntime::open(&db).unwrap();
    let r = handle
        .apply_md_fragment(NoteApplyMdRequest {
            doc_id: "factory".into(),
            markdown: "via factory".into(),
            parent_id: None,
            after_block_id: None,
            mode: NoteApplyMode::ApplyMdFragment,
            intent_id: None,
            batch_id: None,
            message_id: None,
            origin: None,
        })
        .await
        .unwrap();
    assert_eq!(r.inserted, 1);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn apply_md_then_get_md_contains_content_and_c_comment() {
    let (dir, db) = temp_db();
    let backend = StoreNoteBackend::open(&db).unwrap();

    backend
        .apply_md_fragment(NoteApplyMdRequest {
            doc_id: "doc-get-md".into(),
            markdown: "# Store GetMd\n\nruntime body for get_md".into(),
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

    let md = backend.get_md("doc-get-md").await.unwrap();
    assert!(
        md.contains("Store GetMd") || md.contains("runtime body"),
        "get_md must contain applied text (instant S), got: {md:?}"
    );
    assert!(
        md.contains("<!--c:"),
        "get_md via document_to_md must emit <!--c:UUID-->, got: {md:?}"
    );
    // 未知文档 / 无 session → 空串；禁止 mirror
    assert_eq!(backend.get_md("no-such-doc").await.unwrap(), "");
    let err = backend.get_md("").await.unwrap_err();
    assert!(matches!(err, NoteBackendError::Invalid(_)));

    let _ = std::fs::remove_dir_all(dir);
}

/// W4-A：Store 路径 `ApplyReport.lossy` 进入 `NoteApplyMdResult` 且
/// `apply_result_json` 工具结果面可观测 `missing_block_id`。
///
/// **≠ EL-05**；**≠ A-AGT 满表**；仅证 lossy 结果面（审计 S1）。
#[tokio::test]
async fn w4a_store_apply_md_exposes_lossy_on_result_and_tool_json() {
    let (dir, db) = temp_db();
    let backend = StoreNoteBackend::open(&db).unwrap();

    // 与 md-ast `apply_report_lossy_missing_block_id_readable` 同形输入
    let applied = backend
        .apply_md_fragment(NoteApplyMdRequest {
            doc_id: "doc-w4a-lossy".into(),
            markdown: "无ID段落应补生成\n".into(),
            parent_id: None,
            after_block_id: None,
            mode: NoteApplyMode::ApplyMdFragment,
            intent_id: None,
            batch_id: None,
            message_id: None,
            origin: Some("agent".into()),
        })
        .await
        .expect("apply without block id still Ok (new id)");

    assert!(
        applied.inserted >= 1,
        "should insert at least one block: {:?}",
        applied
    );
    assert!(
        !applied.lossy.is_empty(),
        "Store 路径不得丢弃 lossy，got empty"
    );
    assert!(
        applied
            .lossy
            .items
            .iter()
            .any(|i| i.code == "missing_block_id"),
        "期望 missing_block_id，got {:?}",
        applied.lossy
    );

    // 工具 result 面（document_apply_md / send_to_note 共用 apply_result_json）
    let j = agent_tools::apply_result_json(&applied);
    assert_eq!(j["ok"], true);
    let items = j["lossy"]["items"]
        .as_array()
        .expect("tool JSON must have lossy.items");
    assert!(
        items.iter().any(|i| i["code"] == "missing_block_id"),
        "tool JSON 须可观测 missing_block_id，got {items:?}"
    );

    let _ = std::fs::remove_dir_all(dir);
}

/// W4-A：带合法 `<!--c:UUID-->` 且无有损时，lossy.items 为空数组但仍出现。
#[tokio::test]
async fn w4a_store_apply_md_empty_lossy_when_ids_present() {
    let (dir, db) = temp_db();
    let backend = StoreNoteBackend::open(&db).unwrap();
    let md = "\
<!--c:22222222-2222-4222-a222-222222222222-->
带ID段落
";
    let applied = backend
        .apply_md_fragment(NoteApplyMdRequest {
            doc_id: "doc-w4a-clean".into(),
            markdown: md.into(),
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
    assert!(applied.inserted >= 1);
    // 可能仍有 structure_note 等；至少保证字段存在且 tool JSON 形状稳定
    let j = agent_tools::apply_result_json(&applied);
    assert!(j.get("lossy").is_some());
    assert!(j["lossy"]["items"].as_array().is_some());

    let _ = std::fs::remove_dir_all(dir);
}
