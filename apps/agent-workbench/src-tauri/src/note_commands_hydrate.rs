//! SR-06f · note_commands 拆分 · 投影/查询面（hydrate / query）
//!
//! `note_document_hydrate`（默认 doc-session 真投影 / 显式 query-blocks 对照）、
//! `note_query_blocks`（组合查询块摘要）、`note_document_recent`（最近一篇
//! persist 非空 doc_id）与 `hydrate_via_query_blocks`（派生索引助手）。
//! 共享失败面（`unwired_failure` / `err_outcome`）持有于门面
//! `note_commands`（本模经 `super::` 引用）。
//!
//! B2 · spawn_blocking 两段式（2026-08-13）：同步核心段（SQLite 派生索引查询 /
//! DocSession hydrate + CDCS 树投影序列化）经 `tokio::task::spawn_blocking`
//! 承接，对齐 orchestrator `persist.rs::blocking_db_call` 样板——锁生命周期
//! 全在闭包内，不进 await 边界；join 失败归 `note.execution_unknown`。

use agent_tools::note_backend::{NoteBackendError, NoteQueryBlocksParams};
use conex_note_runtime::{HYDRATE_PATH_DOC_SESSION, HYDRATE_PATH_QUERY_BLOCKS};
use conex_types::CoreError;
use serde::Deserialize;
use serde_json::{json, Map, Value as JsonValue};

use crate::note_runtime;

use super::{err_outcome, unwired_failure};

/// 文档 hydrate / open 投影入参（对齐前端 `NoteHydrateDocumentRequest`）。
#[derive(Debug, Clone, Deserialize)]
pub struct NoteHydrateDocumentArgs {
    pub doc_id: String,
    /// 块投影条数上限；缺省 200，硬夹到 1..=200
    #[serde(default)]
    pub limit: Option<u32>,
    /// 强制走 query_blocks 派生路径（默认 false = 真 DocSession）。
    /// 仅测试/对照；生产默认 `doc-session`。
    #[serde(default)]
    pub prefer_query: Option<bool>,
}

/// 组合查询块摘要（投影 / FTS；非 mirror）。
///
/// wire 名 = `note_query_blocks`（前端 NOTE_CMD_QUERY_BLOCKS）。
#[tauri::command]
pub async fn note_query_blocks(params: NoteQueryBlocksParams) -> Result<JsonValue, CoreError> {
    let Some(backend) = note_runtime::try_backend() else {
        return Ok(unwired_failure());
    };
    // B2：同步核心段（SQLite 派生索引查询）在 blocking 线程执行
    let handle = tokio::runtime::Handle::current();
    let joined =
        tokio::task::spawn_blocking(move || handle.block_on(backend.query_blocks(params))).await;
    let result = match joined {
        Ok(r) => r.map_err(|e| NoteBackendError::ExecutionUnknown(e.to_string())),
        Err(join_err) => Err(NoteBackendError::ExecutionUnknown(format!(
            "spawn_blocking join 失败: {join_err}"
        ))),
    };
    match result {
        Ok(result) => Ok(json!({
            "ok": true,
            "blocks": result.blocks,
            "truncated": result.truncated,
        })),
        Err(e) => Ok(err_outcome(e)),
    }
}

/// 文档 hydrate / open 投影。
///
/// wire 名 = `note_document_hydrate`（前端 `NOTE_CMD_DOCUMENT_HYDRATE`）。
///
/// # 默认路径（`hydrate_path=doc-session`）
/// `load_doc` → **`DocSession::hydrate`** → CDCS 树 DFS 投影；
/// `rev` 为会话真 rev。
///
/// # 对照路径（`prefer_query=true` → `hydrate_path=query-blocks`）
/// 经 `query_blocks` 派生索引映射；**禁止**标成 full hydrate。
///
/// # 字段
/// - `source`：IPC 通道，固定 `"tauri-ipc"`（与 fixture 分轨）
/// - `hydrate_path`：数据面分轨（`doc-session` | `query-blocks`）
///
/// # 诚实边界
/// - **≠** 产品「打开完成」（G-HYD-1…5 全条件仍须满足）
/// - **≠ EL-04 / EL-01**；本命令可测 **不**关产品叙事
#[tauri::command]
pub async fn note_document_hydrate(req: NoteHydrateDocumentArgs) -> Result<JsonValue, CoreError> {
    let doc_id = req.doc_id.trim().to_string();
    if doc_id.is_empty() {
        return Ok(json!({
            "ok": false,
            "code": "note.invalid",
            "reason": "doc_id must be non-empty",
        }));
    }
    let limit = req.limit.unwrap_or(200).clamp(1, 200);
    let prefer_query = req.prefer_query.unwrap_or(false);

    // ── 默认：真 DocSession / CDCS 投影 ──────────────────────────
    if !prefer_query {
        let Some(store) = note_runtime::try_store_backend() else {
            return Ok(unwired_failure());
        };
        // B2：同步核心段（DocSession hydrate + CDCS 树投影序列化）在 blocking
        // 线程执行
        let joined = tokio::task::spawn_blocking(move || {
            let proj = store.hydrate_document_from_session(&doc_id, limit)?;
            debug_assert_eq!(proj.hydrate_path, HYDRATE_PATH_DOC_SESSION);
            Ok(proj.to_ipc_json("tauri-ipc"))
        })
        .await;
        let result = match joined {
            Ok(r) => r,
            Err(join_err) => Err(NoteBackendError::ExecutionUnknown(format!(
                "spawn_blocking join 失败: {join_err}"
            ))),
        };
        return match result {
            Ok(v) => Ok(v),
            Err(e) => Ok(err_outcome(e)),
        };
    }

    // ── 显式对照：query_blocks 派生（诚实标 query-blocks）────────
    hydrate_via_query_blocks(&doc_id, limit).await
}

/// 当前已打开 `workspace.db` 最近一篇已 persist 且投影非空的文档。
///
/// wire 名 = `note_document_recent`（前端 `NOTE_CMD_DOCUMENT_RECENT`）。
/// 工作区 = 已装 store（`doc_meta` 无 workspace 列）。无命中 `doc_id=null`。
/// ≠ 打开完成；≠ 平行账本。
#[tauri::command]
pub async fn note_document_recent() -> Result<JsonValue, CoreError> {
    let Some(store) = note_runtime::try_store_backend() else {
        return Ok(unwired_failure());
    };
    let joined = tokio::task::spawn_blocking(move || {
        store.store().recent_persisted_nonempty_doc_id()
    })
    .await;
    let result = match joined {
        Ok(r) => r.map_err(|e| NoteBackendError::ExecutionUnknown(e.to_string())),
        Err(join_err) => Err(NoteBackendError::ExecutionUnknown(format!(
            "spawn_blocking join 失败: {join_err}"
        ))),
    };
    match result {
        Ok(doc_id) => Ok(json!({
            "ok": true,
            "doc_id": doc_id,
        })),
        Err(e) => Ok(err_outcome(e)),
    }
}

/// query_blocks → hydrate 投影形状（派生索引；`hydrate_path=query-blocks`）。
///
/// **不是** DocSession 权威主路径；仅对照 / 回归；禁止叙事为 full hydrate。
async fn hydrate_via_query_blocks(doc_id: &str, limit: u32) -> Result<JsonValue, CoreError> {
    let Some(backend) = note_runtime::try_backend() else {
        return Ok(unwired_failure());
    };
    let params = NoteQueryBlocksParams {
        doc_id: doc_id.to_string(),
        limit: Some(limit),
        ..Default::default()
    };
    // B2：同步核心段（SQLite 派生索引查询）在 blocking 线程执行
    let handle = tokio::runtime::Handle::current();
    let joined =
        tokio::task::spawn_blocking(move || handle.block_on(backend.query_blocks(params))).await;
    let result = match joined {
        Ok(r) => r.map_err(|e| NoteBackendError::ExecutionUnknown(e.to_string())),
        Err(join_err) => Err(NoteBackendError::ExecutionUnknown(format!(
            "spawn_blocking join 失败: {join_err}"
        ))),
    };
    match result {
        Ok(result) => {
            let blocks: Vec<JsonValue> = result
                .blocks
                .iter()
                .enumerate()
                .map(|(i, hit)| {
                    let mut props = Map::new();
                    for (k, v) in &hit.attrs {
                        props.insert(k.clone(), v.clone());
                    }
                    json!({
                        "id": hit.id,
                        "flavour": if hit.kind.is_empty() { "paragraph" } else { &hit.kind },
                        "index": i,
                        "props": props,
                        "text": hit.snippet,
                    })
                })
                .collect();
            // rev：投影版本占位（块数启发式）；非 DocSession rev
            let rev = if blocks.is_empty() { 0u64 } else { 1u64 };
            Ok(json!({
                "ok": true,
                "doc_id": doc_id,
                "rev": rev,
                "blocks": blocks,
                "source": "tauri-ipc",
                "hydrate_path": HYDRATE_PATH_QUERY_BLOCKS,
                "truncated": result.truncated,
            }))
        }
        Err(e) => Ok(err_outcome(e)),
    }
}
