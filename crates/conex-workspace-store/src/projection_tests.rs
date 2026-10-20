//! `projection` 单元测入口（**SD-52** 测拆；语义与拆前一致）。
//!
//! 由父模 [`crate::projection`] 经 `#[path]` 接入。子域：
//! - [`hydrate`]：`g_hyd_02_*` / `a_inv_04_*`（杀进程同构；**≠** 打开完成）
//! - [`commit`]：`apply_projection_diff_*` / `commit_ops_*` / `index_after_*`
//!
//! **≠ EL-03**；**≠ EL-04**；**≠ 打开完成**；**≠** 重做 projection 实现。
//! 不静默改投影/FTS 语义。测绿不抬关。

pub use super::*;
pub use crate::{SharedWorkspaceStore, WorkspaceStore};
pub use conex_doc_collab::{
    BlockId, BlockKind, BlockProps, BlockUpsert, DocEvent, DocSession, Op, Origin, ProjectionDiff,
};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// 独立 tempfile `workspace.db`（进程 id + 纳秒 + 计数）。
pub fn temp_db() -> (PathBuf, PathBuf) {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "conex-proj-{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        n
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("workspace.db");
    (dir, db)
}

/// 测试尾临时目录清理（尽力而为）：失败记录到 stderr 后忽略——Windows
/// 下 db / 锁文件句柄可能尚未释放，清理失败不影响断言结论。
pub fn cleanup_dir(dir: &PathBuf) {
    if let Err(e) = std::fs::remove_dir_all(dir) {
        eprintln!("[workspace-store-tests] 临时目录清理失败（忽略）: {}: {}", dir.display(), e);
    }
}

#[path = "projection_tests_hydrate.rs"]
mod hydrate;

#[path = "projection_tests_commit.rs"]
mod commit;
