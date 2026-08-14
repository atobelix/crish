//! SR-06f · note_commands 拆分 · 测试旁挂
//!
//! 接线：父模 `note_commands.rs` 内 `#[cfg(test)] #[path = "note_commands_tests.rs"]
//! mod tests;`（非直接 `mod`，无孤儿）。用例形状与拆分前完全一致（零删除、
//! 零合并）；诚实边界句全保留。

use super::note_commands_apply::{
    NoteApplyOpsArgs, NoteRedoTextArgs, NoteSendToNoteArgs, NoteUndoTextArgs,
};
use super::note_commands_hydrate::NoteHydrateDocumentArgs;
use super::note_commands_mirror::{NoteDetectMirrorArgs, NoteImportMirrorArgs};
use super::*;
use agent_tools::note_backend::{NoteApplyMdRequest, NoteApplyMode, NoteQueryBlocksParams};
use conex_note_runtime::{HYDRATE_PATH_DOC_SESSION, HYDRATE_PATH_QUERY_BLOCKS};
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::note_runtime;

static COUNTER: AtomicU64 = AtomicU64::new(0);
/// 全局 note_runtime 安装槽进程级共享；本模块测串行避免互踩。
static TEST_LOCK: Mutex<()> = Mutex::new(());

fn temp_install() -> (MutexGuard<'static, ()>, std::path::PathBuf) {
    let guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "workbench-note-cmd-{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        n
    ));
    let _ = std::fs::create_dir_all(&dir);
    let db = dir.join("workspace.db");
    note_runtime::install_for_test(&db).expect("install note runtime");
    (guard, dir)
}

#[tokio::test]
async fn command_apply_and_query_roundtrip() {
    let (_guard, dir) = temp_install();
    let apply = note_document_apply_md(NoteApplyMdRequest {
        doc_id: "cmd-doc".into(),
        markdown: "## Cmd Test\n\nhello note command".into(),
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
    assert_eq!(apply["ok"], true);
    assert!(apply["inserted"].as_u64().unwrap_or(0) >= 1);

    let q = note_query_blocks(NoteQueryBlocksParams {
        doc_id: "cmd-doc".into(),
        text_match: Some("command".into()),
        ..Default::default()
    })
    .await
    .unwrap();
    assert_eq!(q["ok"], true);
    assert!(q["blocks"]
        .as_array()
        .map(|a| !a.is_empty())
        .unwrap_or(true));

    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn send_to_note_idempotent() {
    let (_guard, dir) = temp_install();
    let req = NoteSendToNoteArgs {
        intent_id: "intent-cmd-1".into(),
        markdown: "send once".into(),
        doc_id: "send-doc".into(),
        message_id: Some("msg-1".into()),
        parent_id: None,
        after_block_id: None,
        mode: None,
        origin: Some("user".into()),
        batch_id: None,
    };
    let first = note_send_to_note(req.clone()).await.unwrap();
    assert_eq!(first["ok"], true);
    assert_eq!(first["idempotent"], false);
    let second = note_send_to_note(req).await.unwrap();
    assert_eq!(second["ok"], true);
    assert_eq!(second["idempotent"], true);
    assert_eq!(second["inserted"], 0);
    assert_eq!(second["block_ids"], first["block_ids"]);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn send_rejects_empty_intent() {
    let (_guard, dir) = temp_install();
    let out = note_send_to_note(NoteSendToNoteArgs {
        intent_id: "  ".into(),
        markdown: "x".into(),
        doc_id: "d".into(),
        message_id: None,
        parent_id: None,
        after_block_id: None,
        mode: None,
        origin: None,
        batch_id: None,
    })
    .await
    .unwrap();
    assert_eq!(out["ok"], false);
    assert_eq!(out["code"], "note.invalid");
    let _ = std::fs::remove_dir_all(dir);
}

/// B2 慢盘注入：慢 apply（400ms 延迟在 spawn_blocking 闭包内执行，占用阻塞
/// 线程池）期间，单 worker runtime 的 async ticker（10ms × 5 ≈ 50ms）仍推进。
/// 阈值 200ms（Windows 定时器粒度 ~15.6ms，5 拍最坏 ~80ms，余量充足）；
/// 若退化为同步直调，worker 被占满，ticker 只能等 400ms 延迟结束。
/// 对齐 persist.rs:972 `local_db_store_slow_append_does_not_block_worker`。
#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn slow_apply_core_does_not_block_async_worker() {
    let (_guard, dir) = temp_install();
    super::note_commands_apply::TEST_APPLY_DELAY_MS.store(400, Ordering::SeqCst);

    let slow = tokio::spawn(async {
        let req = NoteApplyMdRequest {
            doc_id: "slow-doc".into(),
            markdown: "slow disk body".into(),
            parent_id: None,
            after_block_id: None,
            mode: NoteApplyMode::ApplyMdFragment,
            intent_id: None,
            batch_id: None,
            message_id: None,
            origin: Some("user".into()),
        };
        note_document_apply_md(req).await.expect("apply");
    });
    let ticker = tokio::spawn(async {
        let t0 = std::time::Instant::now();
        for _ in 0..5 {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        t0.elapsed()
    });
    slow.await.unwrap();
    let elapsed = ticker.await.unwrap();
    super::note_commands_apply::TEST_APPLY_DELAY_MS.store(0, Ordering::SeqCst);
    assert!(
        elapsed < std::time::Duration::from_millis(200),
        "慢核心应占用阻塞线程池而非 tokio worker，ticker 被阻塞: {elapsed:?}"
    );

    let _ = std::fs::remove_dir_all(dir);
}

/// CONN-B3：collab wire insert → note_apply_ops → rev/applied 可观测。
///
/// **≠ EL-01**；本命令可测 **≠** A-BLK 全表 e2e。
#[tokio::test]
async fn note_apply_ops_collab_wire_insert() {
    let (_guard, dir) = temp_install();
    let id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    let ops_json = format!(
        r#"[{{
          "op": "insert",
          "id": "{id}",
          "parent": null,
          "order": "a0",
          "kind": "paragraph",
          "props": {{ "attrs": {{}} }}
        }}]"#
    );
    let out = note_apply_ops(NoteApplyOpsArgs {
        doc_id: "apply-ops-doc".into(),
        ops_json,
        intent_id: Some("conn-b3-1".into()),
        origin: Some("user".into()),
    })
    .await
    .unwrap();
    assert_eq!(out["ok"], true, "apply_ops must succeed: {out}");
    assert_eq!(out["source"], "tauri-ipc");
    assert_eq!(out["doc_id"], "apply-ops-doc");
    assert_eq!(out["applied"], 1);
    assert!(out["rev"].as_u64().unwrap_or(0) >= 1);
    assert_eq!(out["intent_id"], "conn-b3-1");

    // 空 doc_id / 空 ops → invalid
    let bad = note_apply_ops(NoteApplyOpsArgs {
        doc_id: "  ".into(),
        ops_json: "[]".into(),
        intent_id: None,
        origin: None,
    })
    .await
    .unwrap();
    assert_eq!(bad["ok"], false);
    assert_eq!(bad["code"], "note.invalid");

    let bad_ops = note_apply_ops(NoteApplyOpsArgs {
        doc_id: "apply-ops-doc".into(),
        ops_json: "  ".into(),
        intent_id: None,
        origin: None,
    })
    .await
    .unwrap();
    assert_eq!(bad_ops["ok"], false);
    assert_eq!(bad_ops["code"], "note.invalid");

    let _ = std::fs::remove_dir_all(dir);
}

/// 真 DocSession hydrate IPC：apply → hydrate_path=doc-session。
///
/// **≠** 打开完成 / **≠ EL-04/01**；仅证命令默认走 CDCS 会话投影。
#[tokio::test]
async fn note_document_hydrate_projection_shape() {
    let (_guard, dir) = temp_install();
    let apply = note_document_apply_md(NoteApplyMdRequest {
        doc_id: "hyd-doc".into(),
        markdown: "## Hydrate IPC\n\nbody for open shape".into(),
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
    assert_eq!(apply["ok"], true);

    let h = note_document_hydrate(NoteHydrateDocumentArgs {
        doc_id: "hyd-doc".into(),
        limit: Some(50),
        prefer_query: None,
    })
    .await
    .unwrap();
    assert_eq!(h["ok"], true);
    assert_eq!(h["source"], "tauri-ipc");
    assert_eq!(h["hydrate_path"], HYDRATE_PATH_DOC_SESSION);
    assert_ne!(h["hydrate_path"], HYDRATE_PATH_QUERY_BLOCKS);
    assert_eq!(h["doc_id"], "hyd-doc");
    assert!(
        h["rev"].as_u64().unwrap_or(0) > 0,
        "doc-session 路径须返回真 rev>0: {h}"
    );
    let blocks = h["blocks"].as_array().expect("blocks array");
    assert!(!blocks.is_empty(), "hydrate 投影应有块: {h}");
    assert!(blocks[0].get("flavour").is_some());
    assert!(blocks[0].get("index").is_some());
    assert!(blocks[0].get("id").is_some());

    let empty_doc = note_document_hydrate(NoteHydrateDocumentArgs {
        doc_id: "never-written".into(),
        limit: None,
        prefer_query: None,
    })
    .await
    .unwrap();
    assert_eq!(empty_doc["ok"], true);
    assert_eq!(empty_doc["source"], "tauri-ipc");
    assert_eq!(empty_doc["hydrate_path"], HYDRATE_PATH_DOC_SESSION);
    assert_eq!(
        empty_doc["blocks"].as_array().map(|a| a.len()).unwrap_or(1),
        0
    );

    let bad = note_document_hydrate(NoteHydrateDocumentArgs {
        doc_id: "  ".into(),
        limit: None,
        prefer_query: None,
    })
    .await
    .unwrap();
    assert_eq!(bad["ok"], false);
    assert_eq!(bad["code"], "note.invalid");

    let _ = std::fs::remove_dir_all(dir);
}

/// 分轨：prefer_query=true → hydrate_path=query-blocks（禁止标成 doc-session）。
#[tokio::test]
async fn note_document_hydrate_query_path_is_labeled() {
    let (_guard, dir) = temp_install();
    let apply = note_document_apply_md(NoteApplyMdRequest {
        doc_id: "hyd-q".into(),
        markdown: "query path body".into(),
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
    assert_eq!(apply["ok"], true);

    let h = note_document_hydrate(NoteHydrateDocumentArgs {
        doc_id: "hyd-q".into(),
        limit: Some(50),
        prefer_query: Some(true),
    })
    .await
    .unwrap();
    assert_eq!(h["ok"], true);
    assert_eq!(h["source"], "tauri-ipc");
    assert_eq!(h["hydrate_path"], HYDRATE_PATH_QUERY_BLOCKS);
    assert_ne!(h["hydrate_path"], HYDRATE_PATH_DOC_SESSION);

    let _ = std::fs::remove_dir_all(dir);
}

/// detect 可达：export → 外部改盘 → class=mirror_only；**≠ EL-03**。
#[tokio::test]
async fn note_detect_mirror_drift_ipc_classifies_mirror_only() {
    let (_guard, dir) = temp_install();
    let store = note_runtime::try_store_backend().expect("store");

    let apply = note_document_apply_md(NoteApplyMdRequest {
        doc_id: "mir-d".into(),
        markdown: "mirror hello".into(),
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
    assert_eq!(apply["ok"], true);

    // 未 export → no_meta（IPC 形状）
    let no_meta = note_detect_mirror_drift(NoteDetectMirrorArgs {
        doc_id: "mir-d".into(),
        authority_rev: Some(1),
    })
    .await
    .unwrap();
    assert_eq!(no_meta["ok"], true);
    assert_eq!(no_meta["source"], "tauri-ipc");
    assert_eq!(no_meta["class"], "no_meta");
    assert_eq!(no_meta["doc_id"], "mir-d");

    // export + 外部改盘 → mirror_only
    let mirror_root = dir.join("mirrors");
    let path = store
        .export_md_mirror_from_session("mir-d", &mirror_root, Some(1))
        .expect("export from session");
    let mut md = std::fs::read_to_string(&path).unwrap();
    md.push_str("\n\nexternal edit\n");
    std::fs::write(&path, md.as_bytes()).unwrap();

    let det = note_detect_mirror_drift(NoteDetectMirrorArgs {
        doc_id: "mir-d".into(),
        authority_rev: Some(1),
    })
    .await
    .unwrap();
    assert_eq!(det["ok"], true, "{det}");
    assert_eq!(det["class"], "mirror_only", "{det}");
    assert_eq!(det["mirror_changed"], true);
    assert_eq!(det["source"], "tauri-ipc");

    let bad = note_detect_mirror_drift(NoteDetectMirrorArgs {
        doc_id: "  ".into(),
        authority_rev: None,
    })
    .await
    .unwrap();
    assert_eq!(bad["ok"], false);
    assert_eq!(bad["code"], "note.invalid");

    let _ = std::fs::remove_dir_all(dir);
}

/// X-05：IPC import 在 unpushed>0 且非 DropUnacked 时 silent_overwrite_blocked。
///
/// 策略层不回退 store 测；本测钉 **命令面** 透传。
#[tokio::test]
async fn note_import_mirror_proposal_ipc_blocks_silent_overwrite() {
    let (_guard, dir) = temp_install();
    let store_be = note_runtime::try_store_backend().expect("store");

    let apply = note_document_apply_md(NoteApplyMdRequest {
        doc_id: "mir-x".into(),
        markdown: "mirror hello".into(),
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
    assert_eq!(apply["ok"], true);

    let mirror_root = dir.join("mirrors");
    let path = store_be
        .export_md_mirror_from_session("mir-x", &mirror_root, Some(1))
        .expect("export");
    // 外部改 mirror
    let mut md = std::fs::read_to_string(&path).unwrap();
    if let Some(pos) = md.find("mirror hello") {
        md.replace_range(pos..pos + "mirror hello".len(), "external wins");
    } else {
        md.push_str("\n\nexternal wins\n");
    }
    std::fs::write(&path, md.as_bytes()).unwrap();

    // RetainLocal + unpushed>0 → conflict + silent_overwrite_blocked
    let res = note_import_mirror_proposal(NoteImportMirrorArgs {
        doc_id: "mir-x".into(),
        strategy: "retain_local_and_reimport".into(),
        unpushed_op_count: Some(3),
        authority_rev: Some(1),
        use_session_tree: Some(true),
    })
    .await
    .unwrap();
    assert_eq!(res["ok"], true, "{res}");
    assert_eq!(res["kind"], "conflict");
    assert_eq!(res["silent_overwrite_blocked"], true);
    assert_eq!(res["applied"], false);
    assert_eq!(res["source"], "tauri-ipc");

    // 显式 DropUnacked → 允许提案（仍 applied=false）
    let drop_res = note_import_mirror_proposal(NoteImportMirrorArgs {
        doc_id: "mir-x".into(),
        strategy: "drop_unacked".into(),
        unpushed_op_count: Some(2),
        authority_rev: Some(1),
        use_session_tree: Some(true),
    })
    .await
    .unwrap();
    assert_eq!(drop_res["ok"], true, "{drop_res}");
    assert_eq!(drop_res["applied"], false);
    if drop_res["kind"] == "op_batch" {
        assert_eq!(drop_res["discards_unpushed"], true);
        assert_eq!(drop_res["is_block_level_diff"], true);
    } else {
        // 缺树等业务冲突仍可；但 X-05 不得把 DropUnacked 标 silent blocked
        assert_ne!(
            drop_res.get("silent_overwrite_blocked"),
            Some(&json!(true)),
            "DropUnacked 不应 silent_overwrite_blocked: {drop_res}"
        );
    }

    // 非法 strategy
    let bad = note_import_mirror_proposal(NoteImportMirrorArgs {
        doc_id: "mir-x".into(),
        strategy: "silent_drop".into(),
        unpushed_op_count: Some(1),
        authority_rev: None,
        use_session_tree: None,
    })
    .await
    .unwrap();
    assert_eq!(bad["ok"], false);
    assert_eq!(bad["code"], "note.invalid");

    // detect 在 export+改盘后应为 mirror_only
    let det = note_detect_mirror_drift(NoteDetectMirrorArgs {
        doc_id: "mir-x".into(),
        authority_rev: Some(1),
    })
    .await
    .unwrap();
    assert_eq!(det["ok"], true, "{det}");
    assert_eq!(det["class"], "mirror_only", "{det}");
    assert_eq!(det["mirror_changed"], true);

    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn test_apply_md_for_test_direct_smoke() {
    let (_guard, dir) = temp_install();
    let res = apply_md_for_test(NoteApplyMdRequest {
        doc_id: "test-direct-smoke".into(),
        markdown: "# Direct Smoke Test\n\ncontent".into(),
        parent_id: None,
        after_block_id: None,
        mode: NoteApplyMode::ApplyMdFragment,
        intent_id: None,
        batch_id: None,
        message_id: None,
        origin: None,
    })
    .await
    .expect("apply_md_for_test 应成功");
    assert_eq!(res.inserted, 2);
    assert_eq!(res.block_ids.len(), 2);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn note_undo_and_redo_text_ipc_roundtrip() {
    let (_guard, dir) = temp_install();
    let apply = note_document_apply_md(NoteApplyMdRequest {
        doc_id: "undo-ipc-doc".into(),
        markdown: "first content".into(),
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
    assert_eq!(apply["ok"], true);
    let block_id = apply["block_ids"][0].as_str().unwrap().to_string();

    // 1. apply 细粒度更新文本
    let ops_json = serde_json::json!([
        {
            "op": "text_edit",
            "id": block_id,
            "start": 0,
            "end": 0,
            "insert": "Extra Text "
        }
    ])
    .to_string();
    let apply_res = note_apply_ops(NoteApplyOpsArgs {
        doc_id: "undo-ipc-doc".into(),
        ops_json,
        intent_id: None,
        origin: Some("user".into()),
    })
    .await
    .unwrap();
    assert_eq!(apply_res["ok"], true, "apply_res failed: {apply_res}");

    // 2. 触发 note_undo_text
    let undo_res = note_undo_text(NoteUndoTextArgs {
        doc_id: "undo-ipc-doc".into(),
        block_id: block_id.clone(),
    })
    .await
    .unwrap();
    assert_eq!(undo_res["ok"], true);
    assert_eq!(undo_res["is_noop"], false);

    // 3. 触发 note_redo_text
    let redo_res = note_redo_text(NoteRedoTextArgs {
        doc_id: "undo-ipc-doc".into(),
        block_id: block_id.clone(),
    })
    .await
    .unwrap();
    assert_eq!(redo_res["ok"], true);
    assert_eq!(redo_res["is_noop"], false);

    let _ = std::fs::remove_dir_all(dir);
}
