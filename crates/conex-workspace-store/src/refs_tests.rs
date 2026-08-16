//! `refs` 单元测入口（**SD-53** 测拆；SD-18 外置后按域再切）。
//!
//! 由父模 [`crate::refs`] 经 `#[path]` 接入。本文件只放共享 TempDir / 再导出。
//! **≠ 占 SD-18**（不改 `refs.rs` 实现）；**≠ EL-03**；**≠ Wave 2 存储完成**；
//! 不静默改抽边 / 物化语义。

pub use super::*;
pub use crate::projection::commit_ops;
pub use crate::query_blocks::QueryBlocksParams;
pub use crate::{ReindexBlockOpts, SharedWorkspaceStore, WorkspaceStore, SCHEMA_VERSION};
pub use conex_doc_collab::{
    BlockId, BlockKind, BlockProps, DocSession, Op, Origin, ProjectionDiff,
};

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

pub(crate) struct TempDir(PathBuf);
impl TempDir {
    pub(crate) fn new() -> Self {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!(
            "conex-refs-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            n
        ));
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
    pub(crate) fn db(&self) -> PathBuf {
        self.0.join("workspace.db")
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[path = "refs_tests_extract.rs"]
mod extract;
#[path = "refs_tests_query.rs"]
mod query;
#[path = "refs_tests_materialize.rs"]
mod materialize;
