//! StoreNoteBackend 集成 / 契约测试入口（**SD-39** 按域拆）
//!
//! 由 `store_backend` 经 `#[path]` 接入（无孤儿）。子域：
//! - [`apply_md`]：apply_md / query / outline / W4-A lossy / factory / batch_token
//! - [`batch`]：W4-F `w4f_*` / insert / move / update / delete / dry_run
//! - [`hydrate`]：`hydrate_document_*` 冷热路径
//!
//! **≠ EL-05**；**≠ A-AGT 满表**；**≠ W6-E**；测绿不抬关。

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_db() -> (std::path::PathBuf, std::path::PathBuf) {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "conex-note-rt-{}-{}-{}",
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

#[path = "store_backend_tests_apply_md.rs"]
mod apply_md;

#[path = "store_backend_tests_batch.rs"]
mod batch;

#[path = "store_backend_tests_hydrate.rs"]
mod hydrate;
