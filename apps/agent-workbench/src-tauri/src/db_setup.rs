//! 双 SQLite 并发装配（ACT-102 / INV-02 Phase-1）。
//!
//! # 架构约束
//! - `sessions.db`（LocalDb）与 `workspace.db`（NoteRuntime）经
//!   `spawn_blocking` **并发**打开，禁止在同步 setup 语句序列里串行 I/O；
//! - 本模块提供 async 入口；同步 setup 闭包经
//!   `tauri::async_runtime::block_on(setup_databases_concurrently(...))`
//!   汇聚（方案 B：manage 必须在 setup 返回前完成时的合法路径——内部仍
//!   是并发 spawn_blocking，非串行）；
//! - 禁止虚构 `open_lightweight` / `warmup_to_target` 等现网不存在的 API；
//!   ReaderPool 随 `LocalDb::open` 默认建立（Phase-1 现网语义）。
//!
//! # 失败策略
//! - sessions.db 打开失败 → 降级内存库 + `set_ready(false)`（诚实降级，
//!   不阻断启动）；
//! - NoteRuntime 打开失败 → 返回 None（笔记命令保持 unwired）。

use std::path::PathBuf;
use std::sync::Arc;

use tokio::task;

use crate::note_runtime::{self, SharedNoteRuntime};
use crate::session_commands::SharedDb;
use conex_run::status_diagnostics::StatusDiagnostics;

/// 并发装配完成后的微内核数据库集合。
pub struct InitializedDatabases {
    /// 会话库（SharedDb manage 消费）
    pub session_db: SharedDb,
    /// 笔记运行时（成功时 Some；失败 None = unwired）
    pub note_runtime: Option<SharedNoteRuntime>,
}

/// 并发打开 sessions.db 与 workspace.db。
///
/// 调用方（同步 setup）：
/// ```ignore
/// let dbs = tauri::async_runtime::block_on(
///     db_setup::setup_databases_concurrently(app_dir, diagnostics)
/// )?;
/// ```
/// 或在 async runtime spawn 任务内 `.await`。**禁止**在同步 setup 里
/// 对本函数结果直接裸 `tokio::join!` 而不经 async 上下文。
pub async fn setup_databases_concurrently(
    app_dir: PathBuf,
    diagnostics: Arc<StatusDiagnostics>,
) -> Result<InitializedDatabases, String> {
    let session_db_path = app_dir.join("sessions.db");
    let diag_session = Arc::clone(&diagnostics);

    // 任务 1：阻塞线程打开 sessions.db（LocalDb::open 内建 ReaderPool）
    let session_task = task::spawn_blocking(move || {
        let start = std::time::Instant::now();
        let shared = open_session_db_at(&session_db_path, &diag_session);
        let elapsed = start.elapsed().as_millis();
        tracing::info!(
            target: "db",
            path = %session_db_path.display(),
            elapsed_ms = elapsed,
            ready = shared.db_ready(),
            "会话数据库装配完成（并发路径）"
        );
        shared
    });

    // 任务 2：阻塞线程打开 workspace.db（NoteRuntime）
    let diag_note = Arc::clone(&diagnostics);
    let note_task = task::spawn_blocking(move || {
        let start = std::time::Instant::now();
        match note_runtime::init_default() {
            Ok(path) => {
                let elapsed = start.elapsed().as_millis();
                tracing::info!(
                    target: "note_runtime",
                    path = %path.display(),
                    elapsed_ms = elapsed,
                    "NoteRuntime 独立数据库并发打开就绪"
                );
                diag_note.record("note_runtime", true, Some(format!("{elapsed}ms")));
                note_runtime::try_shared()
            }
            Err(error) => {
                tracing::error!(
                    target: "note_runtime",
                    error = %error,
                    "NoteRuntime 打开失败（笔记工具/命令保持 unwired 状态）"
                );
                diag_note.record("note_runtime", false, Some(error));
                None
            }
        }
    });

    // 本函数已在 async 上下文，join! 合法（禁止挪到同步 setup 裸调）
    let (session_res, note_res) = tokio::join!(session_task, note_task);

    let session_db = session_res.map_err(|e| format!("Session DB task join failed: {e}"))?;
    let note_runtime = note_res.map_err(|e| format!("Note runtime task join failed: {e}"))?;

    Ok(InitializedDatabases {
        session_db,
        note_runtime,
    })
}

/// 打开会话库；失败降级内存库 + 诊断（原 main.rs::open_session_db 语义）。
fn open_session_db_at(db_path: &PathBuf, diagnostics: &StatusDiagnostics) -> SharedDb {
    match conex_db::LocalDb::open(db_path) {
        Ok(db) => {
            let shared = SharedDb::new(db);
            // SharedDb::new 默认 ready=true；失败路径显式 set_ready(false)
            shared
        }
        Err(error) => {
            let err_msg = format!("{}: {}", error.kind, error.message);
            tracing::error!(
                target: "db",
                error = %err_msg,
                "[DB] 打开 sessions.db 失败，降级为内存库"
            );
            diagnostics.record(
                "db",
                false,
                Some(format!("sessions.db 打开失败：{err_msg}")),
            );
            let mem = conex_db::LocalDb::open_in_memory().expect("in-memory DB must always open");
            let shared = SharedDb::new(mem);
            shared.set_ready(false);
            shared
        }
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods)] // 测试临时目录清理，非产品物理删除路径
mod tests {
    use super::*;

    /// 并发装配在临时目录上成功返回（功能断言；性能阈值待基线冻结）。
    #[tokio::test]
    async fn concurrent_setup_succeeds_on_tempdir() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("crish-db-setup-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let diagnostics = Arc::new(StatusDiagnostics::new());
        let result = setup_databases_concurrently(dir.clone(), diagnostics)
            .await
            .expect("并发装配必须成功返回");

        assert!(result.session_db.db_ready(), "临时目录打开应 ready");
        assert!(result.note_runtime.is_some(), "NoteRuntime 应接线");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
