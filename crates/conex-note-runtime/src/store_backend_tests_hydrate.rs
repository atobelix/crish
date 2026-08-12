//! 真 DocSession / CDCS hydrate 投影测（**SD-39** 按域拆）
//!
//! 由 [`super`]（`store_backend_tests`）经 `#[path]` 接入。
//! **≠** 产品「打开完成」（G-HYD 全条件）；**≠ EL-04 / EL-01**。
//! 与 query_blocks 派生分轨：`hydrate_path=doc-session`。
//! **≠ EL-05**；**≠ A-AGT 满表**；**≠ W6-E**。

use super::temp_db;
use crate::StoreNoteBackend;
use agent_tools::note_backend::{NoteApplyMdRequest, NoteApplyMode, NoteBackend, NoteBackendError};

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
        proj.blocks
            .iter()
            .any(|b| { b.text.contains("Cold") || b.text.contains("cold hydrate") }),
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
