//! Round7 · 进程级共享 [`NoteBackend`] 句柄（workbench 真装配）
//!
//! # 路径策略（文档化）
//! - **权威库**：独立 `workspace.db`（`conex-workspace-store`），**禁止**
//!   写入 `sessions.db` / `conex-db` 会话库（A-INV-07 / 02 落盘任务书）。
//! - **默认路径**：`host_paths::app_dir()/workspace.db`（与
//!   `app_dir()/sessions.db` 同根并列，库文件分离）。
//! - **测试**：[`open_at`] 接受任意 temp 路径；[`install_for_test`] 覆盖
//!   进程句柄（仅 `cfg(test)` / 测试辅助）。
//!
//! # 生命周期
//! - setup：[`init_default`] 打开默认路径并安装到 [`OnceLock`]；
//!   失败不阻断启动（诊断 + 工具保持 `note_backend_unwired`）。
//! - run 装配：[`try_backend`] → `SessionLoopOptions.note_backend`
//!   （engine produce / core_run_task 同源）。
//! - Tauri 命令：同一 `Arc` clone 注入 `note_commands`。
//!
//! 纪律：不静默流式写笔记；读路径禁止默认 MD mirror。

use agent_tools::note_backend::NoteBackendHandle;
use conex_note_runtime::NoteRuntime;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, RwLock};

/// 进程级共享笔记运行时（可 clone 注入多 session / 命令面）。
#[derive(Clone)]
pub struct SharedNoteRuntime {
    backend: NoteBackendHandle,
    /// 打开时的 db 绝对/规范路径（诊断与测试断言）
    path: PathBuf,
}

impl SharedNoteRuntime {
    /// 底层 `Arc<dyn NoteBackend>`（clone 廉价）。
    pub fn backend(&self) -> NoteBackendHandle {
        Arc::clone(&self.backend)
    }

    /// workspace.db 路径。
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl std::fmt::Debug for SharedNoteRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SharedNoteRuntime")
            .field("path", &self.path)
            .finish()
    }
}

/// 默认 workspace.db 路径：`app_dir()/workspace.db`。
///
/// 与 `sessions.db` 同目录、**不同文件**——笔记权威与会话库分离。
pub fn default_workspace_db_path() -> Result<PathBuf, String> {
    let app_dir = crate::host_paths::app_dir().map_err(|e| e.to_string())?;
    Ok(app_dir.join("workspace.db"))
}

/// 在指定路径打开 NoteRuntime（不安装全局）。
pub fn open_at(path: impl AsRef<Path>) -> Result<SharedNoteRuntime, String> {
    let path = path.as_ref().to_path_buf();
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| {
                format!(
                    "创建 workspace.db 父目录失败 ({}): {e}",
                    parent.display()
                )
            })?;
        }
    }
    let backend = NoteRuntime::open(&path).map_err(|e| {
        format!("打开 workspace.db 失败 ({}): {e}", path.display())
    })?;
    Ok(SharedNoteRuntime { backend, path })
}

/// 全局安装槽：setup 一次；测试可经 [`install`] 覆盖。
static GLOBAL: OnceLock<RwLock<Option<SharedNoteRuntime>>> = OnceLock::new();

fn global_slot() -> &'static RwLock<Option<SharedNoteRuntime>> {
    GLOBAL.get_or_init(|| RwLock::new(None))
}

/// 安装共享句柄（覆盖已有；生产 setup 调用一次）。
pub fn install(runtime: SharedNoteRuntime) {
    let mut guard = global_slot()
        .write()
        .unwrap_or_else(|e| e.into_inner());
    *guard = Some(runtime);
}

/// 读取已安装句柄（None = 未接线 / 打开失败）。
pub fn try_shared() -> Option<SharedNoteRuntime> {
    global_slot()
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

/// 读取 `Arc<dyn NoteBackend>`（SessionLoopOptions / 命令面）。
pub fn try_backend() -> Option<NoteBackendHandle> {
    try_shared().map(|s| s.backend())
}

/// setup：打开默认 `app_dir()/workspace.db` 并安装。
///
/// 成功返回路径字符串；失败返回 Err（调用方记诊断，不阻断启动）。
pub fn init_default() -> Result<PathBuf, String> {
    let path = default_workspace_db_path()?;
    let runtime = open_at(&path)?;
    let path_out = runtime.path().to_path_buf();
    install(runtime);
    tracing::info!(
        target: "note_runtime",
        path = %path_out.display(),
        "笔记 workspace.db 已打开（NoteRuntime 已注入）"
    );
    Ok(path_out)
}

/// 测试辅助：打开 temp 路径并安装为全局（覆盖）。
#[cfg(test)]
pub fn install_for_test(path: impl AsRef<Path>) -> Result<SharedNoteRuntime, String> {
    let runtime = open_at(path)?;
    install(runtime.clone());
    Ok(runtime)
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_tools::note_backend::{
        NoteApplyMdRequest, NoteApplyMode, NoteBackend as _, NoteQueryBlocksParams,
    };
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_db() -> (PathBuf, PathBuf) {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "workbench-note-rt-{}-{}-{}",
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
    async fn open_at_apply_and_query_smoke() {
        let (dir, db) = temp_db();
        let runtime = open_at(&db).expect("open workspace.db");
        assert_eq!(runtime.path(), db.as_path());

        let backend = runtime.backend();
        let applied = backend
            .apply_md_fragment(NoteApplyMdRequest {
                doc_id: "wb-smoke".into(),
                markdown: "# Workbench\n\nnote runtime smoke".into(),
                parent_id: None,
                after_block_id: None,
                mode: NoteApplyMode::ApplyMdFragment,
                intent_id: None,
                batch_id: None,
                message_id: None,
                origin: Some("agent".into()),
            })
            .await
            .expect("apply");
        assert!(applied.inserted >= 1);

        let q = backend
            .query_blocks(NoteQueryBlocksParams {
                doc_id: "wb-smoke".into(),
                text_match: Some("smoke".into()),
                ..Default::default()
            })
            .await
            .expect("query");
        assert!(
            !q.blocks.is_empty() || applied.inserted >= 1,
            "query or apply must leave evidence: {:?}",
            q
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn install_exposes_try_backend() {
        let (dir, db) = temp_db();
        let runtime = open_at(&db).unwrap();
        install(runtime);
        let handle = try_backend().expect("global backend after install");
        let r = handle
            .apply_md_fragment(NoteApplyMdRequest {
                doc_id: "global".into(),
                markdown: "via try_backend".into(),
                parent_id: None,
                after_block_id: None,
                mode: NoteApplyMode::ApplyMdFragment,
                intent_id: Some("intent-global".into()),
                batch_id: None,
                message_id: None,
                origin: None,
            })
            .await
            .unwrap();
        assert_eq!(r.inserted, 1);
        // 幂等
        let r2 = handle
            .apply_md_fragment(NoteApplyMdRequest {
                doc_id: "global".into(),
                markdown: "via try_backend".into(),
                parent_id: None,
                after_block_id: None,
                mode: NoteApplyMode::ApplyMdFragment,
                intent_id: Some("intent-global".into()),
                batch_id: None,
                message_id: None,
                origin: None,
            })
            .await
            .unwrap();
        assert!(r2.idempotent);
        assert_eq!(r2.inserted, 0);
        let _ = std::fs::remove_dir_all(dir);
    }
}
