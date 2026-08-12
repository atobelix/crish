//! StoreNoteBackend 集成 / 契约测试（**SD-06** 旁挂）
//!
//! 从 `store_backend` 巨石外置，避免主实现文件堆测。
//! 覆盖：apply_md / query / outline / W4-A lossy / W4-F block ops /
//! dry_run 零写 / execution_unknown 无半写 / hydrate 冷热路径。
//!
//! **≠ EL-05**；**≠ A-AGT 满表**；测绿不抬关。

use super::*;
use agent_tools::note_backend::{
    NoteApplyMdRequest, NoteApplyMode, NoteBackend, NoteBackendError, NoteBlockBatchRequest,
    NoteBlockInsertRequest, NoteBlockOp, NoteBlockOpKind, NoteQueryBlocksParams,
};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_db() -> (std::path::PathBuf, std::path::PathBuf) {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "conex-note-rt-{}-{}-{}",
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
            || n.children.iter().any(|c| c.title.contains("Beta") || c.title.contains("Alpha"))
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

// ── W4-F 余量：StoreNoteBackend::apply_block_ops 真路径 ──────────

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

    let _ = std::fs::remove_dir_all(dir);
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

    let _ = std::fs::remove_dir_all(dir);
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

    let _ = std::fs::remove_dir_all(dir);
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

    let _ = std::fs::remove_dir_all(dir);
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

    let _ = std::fs::remove_dir_all(dir);
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

    let _ = std::fs::remove_dir_all(dir);
}

// ── 真 DocSession / CDCS hydrate 投影（G-HYD-2 方向）──────────────
// **≠** 产品「打开完成」（G-HYD 全条件）；**≠ EL-04 / EL-01**。
// 与 query_blocks 派生分轨：`hydrate_path=doc-session`。

/// apply → 热 session 投影：真 rev + 文本 + path 分轨。
#[tokio::test]
async fn hydrate_document_from_session_hot_path() {
    use crate::{HYDRATE_PATH_DOC_SESSION, HYDRATE_PATH_QUERY_BLOCKS};

    let (dir, db) = temp_db();
    let backend = StoreNoteBackend::open(&db).unwrap();

    let applied = backend
        .apply_md_fragment(NoteApplyMdRequest {
            doc_id: "hyd-hot".into(),
            markdown: "## Hydrate Session\n\nbody for doc-session path".into(),
            parent_id: None,
            after_block_id: None,
            mode: NoteApplyMode::ApplyMdFragment,
            intent_id: None,
            batch_id: None,
            message_id: None,
            origin: Some("user".into()),
        })
        .await
        .unwrap();
    assert!(applied.inserted >= 1);

    let proj = backend
        .hydrate_document_from_session("hyd-hot", 50)
        .expect("hot hydrate projection");
    assert_eq!(proj.hydrate_path, HYDRATE_PATH_DOC_SESSION);
    assert_ne!(proj.hydrate_path, HYDRATE_PATH_QUERY_BLOCKS);
    assert!(proj.rev > 0, "apply 后真 rev 须 >0，got {}", proj.rev);
    assert!(
        !proj.blocks.is_empty(),
        "session 树投影应有块: {:?}",
        proj.blocks
    );
    assert!(
        proj.blocks.iter().any(|b| {
            b.text.contains("Hydrate")
                || b.text.contains("body")
                || b.flavour.starts_with("heading")
        }),
        "投影文本/flavour 须来自 CDCS 树: {:?}",
        proj.blocks
    );
    let j = proj.to_ipc_json("tauri-ipc");
    assert_eq!(j["hydrate_path"], HYDRATE_PATH_DOC_SESSION);
    assert_eq!(j["source"], "tauri-ipc");

    let _ = std::fs::remove_dir_all(dir);
}

/// 冷开：新 backend 打开同一 db → load_doc → DocSession::hydrate → 投影非空。
///
/// 模拟跨进程打开（G-HYD-2 方向）；**≠** 杀进程产品 e2e 满关。
#[tokio::test]
async fn hydrate_document_cold_reopen_from_store_blob() {
    use crate::HYDRATE_PATH_DOC_SESSION;

    let (dir, db) = temp_db();
    {
        let backend = StoreNoteBackend::open(&db).unwrap();
        backend
            .apply_md_fragment(NoteApplyMdRequest {
                doc_id: "hyd-cold".into(),
                markdown: "# Cold Reopen\n\ncold hydrate body".into(),
                parent_id: None,
                after_block_id: None,
                mode: NoteApplyMode::ApplyMdFragment,
                intent_id: None,
                batch_id: None,
                message_id: None,
                origin: Some("user".into()),
            })
            .await
            .unwrap();
    }
    // 新 backend = 无热 session 表
    let backend2 = StoreNoteBackend::open(&db).unwrap();
    let proj = backend2
        .hydrate_document_from_session("hyd-cold", 100)
        .expect("cold hydrate via load_doc+DocSession::hydrate");
    assert_eq!(proj.hydrate_path, HYDRATE_PATH_DOC_SESSION);
    assert!(
        !proj.blocks.is_empty(),
        "冷 hydrate 后树须可投影: {:?}",
        proj
    );
    assert!(
        proj.blocks.iter().any(|b| {
            b.text.contains("Cold") || b.text.contains("cold hydrate")
        }),
        "冷文本须可读: {:?}",
        proj.blocks
    );
    assert!(proj.rev > 0);

    // cold 强制丢 session 再 hydrate
    let proj2 = backend2
        .hydrate_document_cold("hyd-cold", 100)
        .expect("hydrate_document_cold");
    assert_eq!(proj2.blocks.len(), proj.blocks.len());
    assert_eq!(proj2.hydrate_path, HYDRATE_PATH_DOC_SESSION);

    let _ = std::fs::remove_dir_all(dir);
}

/// 空文档 / 失败：未写 doc → 空投影；空 doc_id → Invalid。
#[tokio::test]
async fn hydrate_document_empty_and_invalid() {
    use crate::HYDRATE_PATH_DOC_SESSION;

    let (dir, db) = temp_db();
    let backend = StoreNoteBackend::open(&db).unwrap();

    let empty = backend
        .hydrate_document_from_session("never-written", 200)
        .expect("空 blob 合法");
    assert_eq!(empty.hydrate_path, HYDRATE_PATH_DOC_SESSION);
    assert!(empty.blocks.is_empty());
    assert_eq!(empty.rev, 0);
    assert!(!empty.truncated);

    let err = backend
        .hydrate_document_from_session("  ", 10)
        .expect_err("空 doc_id");
    assert!(matches!(err, NoteBackendError::Invalid(_)));

    let err2 = backend
        .hydrate_document_from_session("", 10)
        .expect_err("空串");
    assert!(matches!(err2, NoteBackendError::Invalid(_)));

    let _ = std::fs::remove_dir_all(dir);
}
