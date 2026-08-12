//! Round7+ · Tauri 笔记命令面（前端 `noteApi.ts` / `noteHydrateIpc.ts` /
//! `noteMirrorIpc.ts` / `noteApplyOpsIpc.ts` IPC）
//!
//! 命令名（wire = 函数名）：
//! - `note_document_apply_md`
//! - `note_query_blocks`
//! - `note_send_to_note`
//! - `note_document_hydrate`（打开/加载投影 · 默认真 DocSession 路径）
//! - `note_detect_mirror_drift`（A-INV-02 / W2-E · detect 可达前端）
//! - `note_import_mirror_proposal`（三路策略提案；**不** apply；X-05）
//! - `note_apply_ops`（CONN-B3 · collab wire JSON → DocSession::apply）
//!
//! 入参/出参 snake_case 线格式，对齐 `apps/crish-desktop/src/api/noteApi.ts`、
//! `noteHydrateIpc.ts` / `noteMirrorIpc.ts` / `noteApplyOpsIpc.ts` 与
//! `agent_tools::note_backend` 契约。
//!
//! 成功/业务失败均以 `{ ok: true|false, ... }` JSON 返回（Ok 包装），
//! 便于前端 `parseApplyOutcome` / `parseQueryOutcome` / `parseHydrateIpcOutcome` /
//! `parseDetectMirrorOutcome` / `parseImportMirrorOutcome` / `parseApplyOpsIpcOutcome`；
//! 仅 IPC 级故障走 `CoreError` reject。
//!
//! 纪律：
//! - 写路径：`apply_md_fragment` / send_to_note（intent 幂等）/
//!   **`note_apply_ops`**（collab wire → `DocSession::apply`）
//! - **不**静默流式写笔记
//! - 读路径走 store 投影；**不**默认读 MD mirror
//! - **hydrate 分轨**（禁止撒谎）：
//!   - 默认：`hydrate_path=doc-session`（`load_doc` → `DocSession::hydrate` → CDCS 树）
//!   - 旧：`hydrate_path=query-blocks`（`query_blocks` 派生索引；仅显式/回退）
//!   - `source` 仍为 IPC 通道 `tauri-ipc`（与 fixture 分轨）
//! - **mirror detect/import**：只提案、不 apply；unpushed 禁静默 DropUnacked（X-05）
//! - **≠** 产品「打开完成」（G-HYD 全条件）；**≠ EL-04 / EL-01 / EL-03**
//! - **≠** poll timer 双开 debounce；**≠** inotify 产品满关

use agent_tools::note_backend::{
    apply_result_json, NoteApplyMdRequest, NoteApplyMode, NoteBackendError, NoteQueryBlocksParams,
};
#[cfg(test)]
use agent_tools::note_backend::{NoteApplyMdResult, NoteBackend as _};
use conex_note_runtime::{
    ImportMirrorResult, MirrorDriftClass, MirrorDriftReport, ThreeWayStrategy,
    HYDRATE_PATH_DOC_SESSION, HYDRATE_PATH_QUERY_BLOCKS,
};
use conex_types::CoreError;
use serde::Deserialize;
use serde_json::{json, Map, Value as JsonValue};

use crate::note_runtime;

/// 未接线时的结构化失败（对齐 noteApi `note.command_missing` 语义族）。
fn unwired_failure() -> JsonValue {
    json!({
        "ok": false,
        "code": "note.unwired",
        "reason": "note backend not wired (workspace.db 未打开 / NoteRuntime 未装配)",
    })
}

fn err_outcome(err: NoteBackendError) -> JsonValue {
    json!({
        "ok": false,
        "code": err.code(),
        "reason": err.message(),
    })
}

/// send_to_note 专用入参（intent_id 必填；与 apply 字段同形）。
#[derive(Debug, Clone, Deserialize)]
pub struct NoteSendToNoteArgs {
    pub intent_id: String,
    pub markdown: String,
    pub doc_id: String,
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub after_block_id: Option<String>,
    #[serde(default)]
    pub mode: Option<NoteApplyMode>,
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub batch_id: Option<String>,
}

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

/// detect 镜像漂移入参（对齐前端 `NoteDetectMirrorRequest`）。
#[derive(Debug, Clone, Deserialize)]
pub struct NoteDetectMirrorArgs {
    pub doc_id: String,
    /// 当前权威 rev；缺省则 session.rev / store.load_rev
    #[serde(default)]
    pub authority_rev: Option<u64>,
}

/// import_mirror_proposal 入参（对齐前端 `NoteImportMirrorRequest`）。
///
/// **不** apply；策略须由调用方显式给出（前端 resolveThreeWay + X-05）。
#[derive(Debug, Clone, Deserialize)]
pub struct NoteImportMirrorArgs {
    pub doc_id: String,
    /// `retain_local_and_reimport` | `drop_unacked` | `conflict_blocks`
    pub strategy: String,
    /// 未推送 / 未 ACK 本地 op 数；>0 时非 DropUnacked → 冲突（X-05）
    #[serde(default)]
    pub unpushed_op_count: Option<u64>,
    #[serde(default)]
    pub authority_rev: Option<u64>,
    /// 是否用 DocSession 权威树做块级 diff（默认 true）
    #[serde(default)]
    pub use_session_tree: Option<bool>,
}

/// CONN-B3 · collab wire apply 入参（对齐前端 `NoteApplyOpsRequest`）。
///
/// `ops_json` = TS `createCollabApplySink` 产出的 collab Op 数组 JSON 字符串。
#[derive(Debug, Clone, Deserialize)]
pub struct NoteApplyOpsArgs {
    pub doc_id: String,
    /// collab Op 数组 JSON（`ops_from_json` 形状）
    pub ops_json: String,
    /// 幂等 / 审计键（可选；前端 ApplyOpsAdapter meta.intentId）
    #[serde(default)]
    pub intent_id: Option<String>,
    /// `user` | `agent` | `remote` | `system`；默认 user
    #[serde(default)]
    pub origin: Option<String>,
}

/// MirrorDriftClass → wire snake_case（对齐前端 `MirrorDriftClass`）。
fn drift_class_wire(c: MirrorDriftClass) -> &'static str {
    match c {
        MirrorDriftClass::None => "none",
        MirrorDriftClass::MirrorOnly => "mirror_only",
        MirrorDriftClass::AuthorityOnly => "authority_only",
        MirrorDriftClass::Both => "both",
        MirrorDriftClass::NoMeta => "no_meta",
        MirrorDriftClass::MissingFile => "missing_file",
    }
}

/// ThreeWayStrategy → wire snake_case。
fn strategy_wire(s: ThreeWayStrategy) -> &'static str {
    match s {
        ThreeWayStrategy::RetainLocalAndReimport => "retain_local_and_reimport",
        ThreeWayStrategy::DropUnacked => "drop_unacked",
        ThreeWayStrategy::ConflictBlocks => "conflict_blocks",
    }
}

fn parse_strategy(s: &str) -> Option<ThreeWayStrategy> {
    match s.trim() {
        "retain_local_and_reimport" => Some(ThreeWayStrategy::RetainLocalAndReimport),
        "drop_unacked" => Some(ThreeWayStrategy::DropUnacked),
        "conflict_blocks" => Some(ThreeWayStrategy::ConflictBlocks),
        _ => None,
    }
}

/// 漂移报告 → IPC JSON 子集（前端 `MirrorDriftReportView` 可解析）。
fn report_to_json(report: &MirrorDriftReport) -> JsonValue {
    json!({
        "doc_id": report.doc_id,
        "class": drift_class_wire(report.class),
        "path": report.path.to_string_lossy(),
        "last_export_rev": report.last_export_rev,
        "authority_rev": report.authority_rev,
        "pending_lag": report.pending_lag,
        "mirror_changed": report.mirror_changed,
        "authority_changed": report.authority_changed,
        "file_exists": report.file_exists,
        "stored_hash": report.stored_hash,
        "file_hash": report.file_hash,
    })
}

/// import 结果 → IPC JSON（提案/冲突；永不暗示已 apply）。
fn import_result_to_json(result: &ImportMirrorResult) -> JsonValue {
    match result {
        ImportMirrorResult::NoChange { report } => json!({
            "ok": true,
            "kind": "no_change",
            "report": report_to_json(report),
            "applied": false,
            "source": "tauri-ipc",
        }),
        ImportMirrorResult::OpBatch {
            report,
            strategy,
            ops,
            source_md_hash,
            preserves_unpushed,
            discards_unpushed,
            is_block_level_diff,
        } => {
            let ops_json: Vec<JsonValue> = ops
                .iter()
                .filter_map(|op| serde_json::to_value(op).ok())
                .collect();
            json!({
                "ok": true,
                "kind": "op_batch",
                "report": report_to_json(report),
                "strategy": strategy_wire(*strategy),
                "ops": ops_json,
                "ops_count": ops.len(),
                "source_md_hash": source_md_hash,
                "preserves_unpushed": preserves_unpushed,
                "discards_unpushed": discards_unpushed,
                "is_block_level_diff": is_block_level_diff,
                "applied": false,
                "source": "tauri-ipc",
            })
        }
        ImportMirrorResult::Conflict {
            report,
            reason,
            unpushed_op_count,
            silent_overwrite_blocked,
            suggested_strategies,
            conflicted_blocks,
        } => {
            let suggested: Vec<&str> = suggested_strategies
                .iter()
                .map(|s| strategy_wire(*s))
                .collect();
            let blocks: Vec<JsonValue> = conflicted_blocks
                .iter()
                .map(|b| {
                    json!({
                        "block_id": b.block_id,
                        "reason": b.reason,
                    })
                })
                .collect();
            json!({
                "ok": true,
                "kind": "conflict",
                "report": report_to_json(report),
                "reason": reason,
                "unpushed_op_count": unpushed_op_count,
                "silent_overwrite_blocked": silent_overwrite_blocked,
                "suggested_strategies": suggested,
                "conflicted_blocks": blocks,
                "applied": false,
                "source": "tauri-ipc",
            })
        }
    }
}

/// 事务化 apply MD 片段 → 块树（权威路径）。
///
/// wire 名 = `note_document_apply_md`（前端 NOTE_CMD_DOCUMENT_APPLY_MD）。
#[tauri::command]
pub async fn note_document_apply_md(req: NoteApplyMdRequest) -> Result<JsonValue, CoreError> {
    let Some(backend) = note_runtime::try_backend() else {
        return Ok(unwired_failure());
    };
    match backend.apply_md_fragment(req).await {
        Ok(result) => Ok(apply_result_json(&result)),
        Err(e) => Ok(err_outcome(e)),
    }
}

/// 组合查询块摘要（投影 / FTS；非 mirror）。
///
/// wire 名 = `note_query_blocks`（前端 NOTE_CMD_QUERY_BLOCKS）。
#[tauri::command]
pub async fn note_query_blocks(params: NoteQueryBlocksParams) -> Result<JsonValue, CoreError> {
    let Some(backend) = note_runtime::try_backend() else {
        return Ok(unwired_failure());
    };
    match backend.query_blocks(params).await {
        Ok(result) => Ok(json!({
            "ok": true,
            "blocks": result.blocks,
            "truncated": result.truncated,
        })),
        Err(e) => Ok(err_outcome(e)),
    }
}

/// 显式 send_to_note Intent 写路径（幂等 intent_id；禁止静默缝合）。
///
/// wire 名 = `note_send_to_note`（前端 NOTE_CMD_SEND_TO_NOTE）。
#[tauri::command]
pub async fn note_send_to_note(req: NoteSendToNoteArgs) -> Result<JsonValue, CoreError> {
    if req.intent_id.trim().is_empty() {
        return Ok(json!({
            "ok": false,
            "code": "note.invalid",
            "reason": "intent_id must be non-empty",
        }));
    }
    let Some(backend) = note_runtime::try_backend() else {
        return Ok(unwired_failure());
    };
    let apply_req = NoteApplyMdRequest {
        doc_id: req.doc_id,
        markdown: req.markdown,
        parent_id: req.parent_id,
        after_block_id: req.after_block_id,
        mode: req.mode.unwrap_or(NoteApplyMode::ApplyMdFragment),
        intent_id: Some(req.intent_id),
        batch_id: req.batch_id,
        message_id: req.message_id,
        origin: Some(req.origin.unwrap_or_else(|| "user".into())),
    };
    match backend.apply_md_fragment(apply_req).await {
        Ok(result) => Ok(apply_result_json(&result)),
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
        return match store.hydrate_document_from_session(&doc_id, limit) {
            Ok(proj) => {
                debug_assert_eq!(proj.hydrate_path, HYDRATE_PATH_DOC_SESSION);
                Ok(proj.to_ipc_json("tauri-ipc"))
            }
            Err(e) => Ok(err_outcome(e)),
        };
    }

    // ── 显式对照：query_blocks 派生（诚实标 query-blocks）────────
    hydrate_via_query_blocks(&doc_id, limit).await
}

/// detect 镜像漂移（A-INV-02 / W2-E 产品 IPC）。
///
/// wire 名 = `note_detect_mirror_drift`（前端 `NOTE_CMD_DETECT_MIRROR_DRIFT`）。
///
/// 结果可达前端 `MirrorDriftReportView`；**不**实现 poll/OS watcher；
/// **≠ EL-03**；**≠ inotify 产品满关**。
#[tauri::command]
pub async fn note_detect_mirror_drift(req: NoteDetectMirrorArgs) -> Result<JsonValue, CoreError> {
    let doc_id = req.doc_id.trim().to_string();
    if doc_id.is_empty() {
        return Ok(json!({
            "ok": false,
            "code": "note.invalid",
            "reason": "doc_id must be non-empty",
        }));
    }
    let Some(store) = note_runtime::try_store_backend() else {
        return Ok(unwired_failure());
    };
    match store.detect_mirror_drift(&doc_id, req.authority_rev) {
        Ok(report) => {
            let mut body = report_to_json(&report);
            if let Some(obj) = body.as_object_mut() {
                obj.insert("ok".into(), json!(true));
                obj.insert("source".into(), json!("tauri-ipc"));
            }
            Ok(body)
        }
        Err(e) => Ok(err_outcome(e)),
    }
}

/// import 镜像提案（三路策略；**不** apply）。
///
/// wire 名 = `note_import_mirror_proposal`（前端 `NOTE_CMD_IMPORT_MIRROR_PROPOSAL`）。
///
/// # X-05
/// `unpushed_op_count > 0` 且 `strategy != drop_unacked` → `kind=conflict` 且
/// `silent_overwrite_blocked=true`（禁止静默盖 unpushed）。
///
/// 前端应先经 `resolveThreeWayAction` 门禁，再调本命令。
#[tauri::command]
pub async fn note_import_mirror_proposal(
    req: NoteImportMirrorArgs,
) -> Result<JsonValue, CoreError> {
    let doc_id = req.doc_id.trim().to_string();
    if doc_id.is_empty() {
        return Ok(json!({
            "ok": false,
            "code": "note.invalid",
            "reason": "doc_id must be non-empty",
        }));
    }
    let Some(strategy) = parse_strategy(&req.strategy) else {
        return Ok(json!({
            "ok": false,
            "code": "note.invalid",
            "reason": format!(
                "strategy 须为 retain_local_and_reimport | drop_unacked | conflict_blocks，got {:?}",
                req.strategy
            ),
        }));
    };
    let Some(store) = note_runtime::try_store_backend() else {
        return Ok(unwired_failure());
    };
    let unpushed = req.unpushed_op_count.unwrap_or(0) as usize;
    let use_tree = req.use_session_tree.unwrap_or(true);
    match store.import_mirror_proposal(
        &doc_id,
        strategy,
        unpushed,
        req.authority_rev,
        use_tree,
    ) {
        Ok(result) => Ok(import_result_to_json(&result)),
        Err(e) => Ok(err_outcome(e)),
    }
}

/// collab wire JSON → 真 `DocSession::apply`（CONN-B3 产品写锥 IPC）。
///
/// wire 名 = `note_apply_ops`（前端 `NOTE_CMD_APPLY_OPS`）。
///
/// # 形状
/// - 入参：`doc_id` + `ops_json`（collab Op 数组字符串，对齐
///   TS `createCollabApplySink` / `collabOpsToJson`）
/// - 成功：`{ ok:true, doc_id, rev, applied, source:'tauri-ipc', intent_id? }`
/// - 失败：`{ ok:false, code, reason }`（解析失败 / apply 拒 / unwired）
///
/// # 诚实边界
/// - **≠ EL-01**；**≠ A-BLK 全表 e2e**；命令可测 **≠** 打开完成
/// - 无 NoteRuntime → `note.unwired`（结构化失败，不抛）
#[tauri::command]
pub async fn note_apply_ops(req: NoteApplyOpsArgs) -> Result<JsonValue, CoreError> {
    let doc_id = req.doc_id.trim().to_string();
    if doc_id.is_empty() {
        return Ok(json!({
            "ok": false,
            "code": "note.invalid",
            "reason": "doc_id must be non-empty",
        }));
    }
    if req.ops_json.trim().is_empty() {
        return Ok(json!({
            "ok": false,
            "code": "note.invalid",
            "reason": "ops_json must be non-empty",
        }));
    }
    let Some(store) = note_runtime::try_store_backend() else {
        return Ok(unwired_failure());
    };
    match store.apply_collab_ops_json(&doc_id, &req.ops_json, req.origin.as_deref()) {
        Ok(out) => {
            let mut body = json!({
                "ok": true,
                "doc_id": doc_id,
                "rev": out.rev,
                "applied": out.applied,
                "source": "tauri-ipc",
            });
            if let Some(intent) = req
                .intent_id
                .as_ref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
            {
                if let Some(obj) = body.as_object_mut() {
                    obj.insert("intent_id".into(), json!(intent));
                }
            }
            Ok(body)
        }
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
    match backend.query_blocks(params).await {
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

/// 命令层同步 smoke 助手（测试 / 非 Tauri 路径）：apply 后返回结果。
#[cfg(test)]
pub(crate) async fn apply_md_for_test(
    req: NoteApplyMdRequest,
) -> Result<NoteApplyMdResult, NoteBackendError> {
    let backend = note_runtime::try_backend().ok_or(NoteBackendError::Unwired)?;
    backend.apply_md_fragment(req).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_tools::note_backend::NoteApplyMode;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Mutex, MutexGuard};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);
    /// 全局 note_runtime 安装槽进程级共享；本模块测串行避免互踩。
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn temp_install() -> (MutexGuard<'static, ()>, std::path::PathBuf) {
        let guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
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
        assert!(q["blocks"].as_array().map(|a| !a.is_empty()).unwrap_or(true));

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
        assert_eq!(empty_doc["blocks"].as_array().map(|a| a.len()).unwrap_or(1), 0);

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
}
