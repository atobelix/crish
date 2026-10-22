//! 孤儿会话清理（F4 / RUN-07 产出回收）与 localStorage 一次性导入命令。

use std::collections::HashMap;

use conex_types::{CoreError, ImportStats};
use tauri::State;

use super::{guard_cleanup_keep, map_db_err, SharedDb};

/// 清理不在 keepIds 中的会话（孤儿清理，F4 冻结签名）。
///
/// - `active_ids` 非空：删除不在集合内的孤儿行，返回删除行数；
/// - `active_ids` 为空且 `confirm_empty = false`：**不执行任何 DELETE**，返回
///   `Err(InvalidInput, "cleanup_orphan_empty_keep")`（前端可见，防 P02 全库清空）；
/// - `active_ids` 为空且 `confirm_empty = true`：显式清空（仅测试 / 显式清空入口）。
///
/// 宽限期（`ORPHAN_GRACE_MS`，session_meta `orphan_grace_ms` 可配）与
/// `confirm_empty` 的库层实现由 conex-db 侧承接（PE-08 T08.2 产出）。
///
/// RUN-07（产出清理链接线）：delete_session 命令已 T-F 06 退役，本命令即
/// 生产删除路径——库层删除事务返回被删会话的产出 meta 捕获值
/// ([conex_db::OrphanCleanupOutcome]) 后，逐会话调用
/// `outputs_config::cleanup_session_outputs`（`.agent-outputs/<id>` 进
/// 回收站，不直接 remove），结果经 `session-outputs-cleanup` 事件推给
/// 前端 toast（真实结果驱动，不硬编码成功）并落 tracing。返回值仍为
/// 删除会话数（F4 签名保持）。
#[tauri::command]
pub async fn cleanup_orphan_sessions(
    active_ids: Vec<String>,
    confirm_empty: Option<bool>,
    app: tauri::AppHandle,
    db_state: State<'_, SharedDb>,
) -> Result<usize, CoreError> {
    guard_cleanup_keep(&active_ids, confirm_empty.unwrap_or(false))?;
    let db = db_state.inner().local_db();
    let outcomes = tokio::task::spawn_blocking(move || db.cleanup_orphan_sessions(&active_ids))
        .await
        .map_err(|e| CoreError::Internal(format!("cleanup_orphan_sessions join: {e}")))?
        .map_err(map_db_err)?;
    let deleted = outcomes.len();
    if deleted == 0 {
        return Ok(0);
    }

    // RUN-07：逐会话产出目录清理（回收站接管）+ 结果事件
    use tauri::Emitter;
    let mut events: Vec<SessionOutputsCleanupEvent> = Vec::with_capacity(deleted);
    for outcome in &outcomes {
        let result = crate::outputs_config::cleanup_session_outputs(
            &app,
            &outcome.session_id,
            outcome.output_dir.as_deref(),
            outcome.output_root.as_deref(),
        );
        match result {
            Ok(cleanup) => {
                tracing::info!(
                    target: "outputs",
                    session_id = %outcome.session_id,
                    cleaned = cleanup.cleaned,
                    trashed = ?cleanup.trashed_dirs,
                    "孤儿会话产出目录清理完成"
                );
                events.push(SessionOutputsCleanupEvent {
                    session_id: outcome.session_id.clone(),
                    cleaned: cleanup.cleaned,
                    skipped_outside: cleanup.skipped_outside,
                    trash_root: cleanup.trash_root,
                    notice: cleanup.notice,
                });
            }
            Err(e) => {
                tracing::warn!(
                    target: "outputs",
                    session_id = %outcome.session_id,
                    error = %e,
                    "孤儿会话产出目录清理失败（不阻断删除）"
                );
                events.push(SessionOutputsCleanupEvent {
                    session_id: outcome.session_id.clone(),
                    cleaned: false,
                    skipped_outside: false,
                    trash_root: String::new(),
                    notice: format!("会话产出目录清理失败：{e}"),
                });
            }
        }
    }
    if let Err(e) = app.emit("session-outputs-cleanup", &events) {
        tracing::warn!(target: "outputs", error = %e, "清理结果事件发送失败（清理本身已完成）");
    }
    Ok(deleted)
}

/// RUN-07：孤儿清理产出回收结果事件载荷（camelCase 序列化，前端
/// `session-outputs-cleanup` 监听端消费弹 toast）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionOutputsCleanupEvent {
    session_id: String,
    cleaned: bool,
    skipped_outside: bool,
    trash_root: String,
    notice: String,
}

#[tauri::command]
pub async fn import_from_localstorage(
    index_json: String,
    bodies: HashMap<String, String>,
    agents: HashMap<String, String>,
    active_session_id: Option<String>,
    folder_order: Vec<String>,
    db_state: State<'_, SharedDb>,
) -> Result<ImportStats, CoreError> {
    let db = db_state.inner().local_db();
    let stats = tokio::task::spawn_blocking(move || {
        db.import_from_localstorage(
            &index_json,
            bodies,
            agents,
            active_session_id.as_deref(),
            &folder_order,
        )
    })
    .await
    .map_err(|e| CoreError::Internal(format!("import_from_localstorage join: {e}")))?
    .map_err(map_db_err)?;
    Ok(stats)
}
