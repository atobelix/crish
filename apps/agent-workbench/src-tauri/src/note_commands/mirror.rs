//! SR-06f · note_commands 拆分 · mirror 面（detect / import 提案）
//!
//! `note_detect_mirror_drift`（A-INV-02 / W2-E · detect 可达前端）与
//! `note_import_mirror_proposal`（三路策略提案；**不** apply；X-05），
//! 连同 wire 转换助手（`drift_class_wire` / `strategy_wire` / `parse_strategy` /
//! `report_to_json` / `import_result_to_json`）。共享失败面（`unwired_failure` /
//! `err_outcome`）持有于门面 `note_commands`（本模经 `super::` 引用）。
//!
//! B2 · spawn_blocking 两段式（2026-08-13）：同步核心段（mirror 文件 hash /
//! 三路 diff 提案 + 报告 JSON 序列化）经 `tokio::task::spawn_blocking` 承接，
//! 对齐 orchestrator `persist.rs::blocking_db_call` 样板——锁生命周期全在
//! 闭包内，不进 await 边界；join 失败归 `note.execution_unknown`。

use agent_tools::note_backend::NoteBackendError;
use conex_note_runtime::{
    ImportMirrorResult, MirrorDriftClass, MirrorDriftReport, ThreeWayStrategy,
};
use conex_types::CoreError;
use serde::Deserialize;
use serde_json::{json, Value as JsonValue};

use crate::note_runtime;

use super::{err_outcome, unwired_failure};

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
    // B2：同步核心段（mirror 文件 hash + 漂移分类 + 报告序列化）在 blocking
    // 线程执行
    let authority_rev = req.authority_rev;
    let joined = tokio::task::spawn_blocking(move || {
        let report = store.detect_mirror_drift(&doc_id, authority_rev)?;
        let mut body = report_to_json(&report);
        if let Some(obj) = body.as_object_mut() {
            obj.insert("ok".into(), json!(true));
            obj.insert("source".into(), json!("tauri-ipc"));
        }
        Ok(body)
    })
    .await;
    match joined {
        Ok(Ok(body)) => Ok(body),
        Ok(Err(e)) => Ok(err_outcome(e)),
        Err(join_err) => Ok(err_outcome(NoteBackendError::ExecutionUnknown(format!(
            "spawn_blocking join 失败: {join_err}"
        )))),
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
    let authority_rev = req.authority_rev;
    // B2：同步核心段（三路 diff 提案 + 报告 JSON 序列化）在 blocking 线程执行
    let joined = tokio::task::spawn_blocking(move || {
        store
            .import_mirror_proposal(&doc_id, strategy, unpushed, authority_rev, use_tree)
            .map(|result| import_result_to_json(&result))
    })
    .await;
    match joined {
        Ok(Ok(body)) => Ok(body),
        Ok(Err(e)) => Ok(err_outcome(e)),
        Err(join_err) => Ok(err_outcome(NoteBackendError::ExecutionUnknown(format!(
            "spawn_blocking join 失败: {join_err}"
        )))),
    }
}
