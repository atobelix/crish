//! 真 DocSession / CDCS hydrate 投影测（**SD-39** 按域拆）
//!
//! 由 [`super`]（`store_backend_tests`）经 `#[path]` 接入。
//! **≠** 产品「打开完成」（G-HYD 全条件）；**≠ EL-04 / EL-01**。
//! 与 query_blocks 派生分轨：`hydrate_path=doc-session`。
//! **≠ EL-05**；**≠ A-AGT 满表**；**≠ W6-E**。

use super::{cleanup, temp_db};
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

    cleanup(dir);
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

    cleanup(dir);
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

    cleanup(dir);
}

/// C2：并发首次打开**同一** doc → per-doc hydrate 许可串行化，
/// sessions 索引恰 1 条目（无重复 session）、hydrating 许可恰 1 条目（有界）、
/// 两线程投影一致（复用同一 session，无丢失/分叉）。
#[test]
fn concurrent_first_open_same_doc_dedups_to_single_hydrate() {
    use std::sync::{Arc, Barrier};
    let (dir, db) = temp_db();
    let backend = Arc::new(StoreNoteBackend::open(&db).unwrap());
    // 预写 seed（确保 load_doc 返回非空 blob，hydrate 出非空投影）
    super::apply_md(&backend, "c2-same", "# C2 Same\n\nseed body");

    let barrier = Arc::new(Barrier::new(3));
    let mut handles = Vec::new();
    for _ in 0..2 {
        let backend = Arc::clone(&backend);
        let barrier = Arc::clone(&barrier);
        handles.push(std::thread::spawn(move || {
            barrier.wait();
            backend.hydrate_document_from_session("c2-same", 50)
        }));
    }
    barrier.wait();
    let mut projections = Vec::new();
    for h in handles {
        projections.push(h.join().expect("线程不应 panic").expect("并发首开投影成功"));
    }
    // sessions 索引恰 1 条目（两线程复用同一 session，无重复）
    assert_eq!(
        backend.sessions.lock().unwrap().len(),
        1,
        "并发同 doc 首开应只产生 1 个 session 条目"
    );
    // hydrating 许可恰 1 条目（per-doc 许可有界，不随并发数增长）
    assert_eq!(
        backend.hydrating.lock().unwrap().len(),
        1,
        "per-doc hydrate 许可可恰 1 条目（同 doc 单许可）"
    );
    // 两投影一致：blocks 数与首块文本一致（复用同一 session 树）
    let (p0, p1) = (projections[0].clone(), projections[1].clone());
    assert_eq!(p0.blocks.len(), p1.blocks.len(), "两线程投影块数一致");
    assert_eq!(
        p0.rev, p1.rev,
        "两线程投影 rev 一致: {} vs {}",
        p0.rev, p1.rev
    );
    assert!(
        p0.blocks
            .iter()
            .any(|b| b.text.contains("C2 Same") || b.text.contains("seed body")),
        "投影须含 seed 内容: {:?}",
        p0.blocks
    );

    cleanup(dir);
}

/// C2 负例：并发首开**不同** doc → 两 doc 各自许可、互不串行，
/// 两 doc 均成功投影且 sessions 恰 2 条目、hydrating 恰 2 条目。
#[test]
fn concurrent_first_open_distinct_docs_dedups_independently() {
    use std::sync::{Arc, Barrier};
    let (dir, db) = temp_db();
    let backend = Arc::new(StoreNoteBackend::open(&db).unwrap());
    super::apply_md(&backend, "c2-dist-a", "# Dist A\n\na body");
    super::apply_md(&backend, "c2-dist-b", "# Dist B\n\nb body");

    let barrier = Arc::new(Barrier::new(3));
    let docs = ["c2-dist-a", "c2-dist-b"];
    let mut handles = Vec::new();
    for doc in docs {
        let backend = Arc::clone(&backend);
        let barrier = Arc::clone(&barrier);
        let doc = doc.to_string();
        handles.push(std::thread::spawn(move || {
            barrier.wait();
            backend.hydrate_document_from_session(&doc, 50)
        }));
    }
    barrier.wait();
    for h in handles {
        h.join()
            .expect("线程不应 panic")
            .expect("并发首开不同 doc 投影成功");
    }
    assert_eq!(
        backend.sessions.lock().unwrap().len(),
        2,
        "两 doc 并发首开 → sessions 恰 2 条目"
    );
    assert_eq!(
        backend.hydrating.lock().unwrap().len(),
        2,
        "两 doc 各自 per-doc 许可 → hydrating 恰 2 条目"
    );

    cleanup(dir);
}

/// C2：冷开摘除后 hydrating 许可条目回落（无泄漏）。
#[test]
fn cold_open_cleans_up_hydrating_permit() {
    let (dir, db) = temp_db();
    let backend = StoreNoteBackend::open(&db).unwrap();
    super::apply_md(&backend, "c2-cold", "# Cold Cleanup\n\nbody");
    // 首开 → sessions + hydrating 各 1 条目
    backend
        .hydrate_document_from_session("c2-cold", 10)
        .expect("首开投影");
    assert_eq!(backend.sessions.lock().unwrap().len(), 1);
    assert_eq!(backend.hydrating.lock().unwrap().len(), 1);
    // 冷开 = 摘除 + 重开 → hydrating 许可被清理后重插，仍 1 条目
    backend
        .hydrate_document_cold("c2-cold", 10)
        .expect("冷开重开投影");
    assert_eq!(
        backend.sessions.lock().unwrap().len(),
        1,
        "冷开重开后 sessions 仍 1 条目"
    );
    assert_eq!(
        backend.hydrating.lock().unwrap().len(),
        1,
        "冷开清理后重插 hydrating 许可仍 1 条目（无泄漏）"
    );
    cleanup(dir);
}
