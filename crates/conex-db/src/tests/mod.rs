//! 核心 API 与事务单测（原 lib.rs tests 模块核心部分，行为不变）。

// G2 禁令豁免：测试临时 DB 清理（非产品删除路径，可恢复语义不适用）。
#![allow(clippy::disallowed_methods)]

use super::*;
use conex_types::{SessionIndexEntry, SessionMessage};
use std::time::{SystemTime, UNIX_EPOCH};

mod cascade_meta;
mod events;
mod lease_agents;
mod recovery_tx;
mod session_body;

/// 测试临时路径清理（best-effort，跨测试模块共享）。
///
/// 清理失败只影响本机磁盘残留、不影响用例断言，故不 panic；但也**禁止**
/// 静默丢弃（`let _ =`）—— 临时库残留无从定位，且会掩盖真实删除失败。
pub(crate) fn cleanup_temp_path(path: impl AsRef<std::path::Path>) {
    let path = path.as_ref();
    let result = if path.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    if let Err(err) = result {
        if err.kind() != std::io::ErrorKind::NotFound {
            eprintln!("[conex-db test] 清理临时路径失败 {}: {err}", path.display());
        }
    }
}

/// 真实临时 WAL 文件库守卫（open_temp_wal_for_test 尚未落地，先用
/// 与 tests_concurrency 同源的 tempfile 真库模式；禁止用纯内存库冒充
/// 持久化 Upsert / Diff Shrink 验收）。
struct TempWalDbGuard {
    path: std::path::PathBuf,
}

impl Drop for TempWalDbGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_file(format!("{}-wal", self.path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", self.path.display()));
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::remove_dir_all(parent);
        }
    }
}

/// 打开真实临时 WAL 文件库（LocalDb::open → 完整迁移链 + 单写 Actor + ReaderPool）。
fn open_temp_wal_db() -> (LocalDb, TempWalDbGuard) {
    static TEST_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let id = TEST_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "conex_msg_body_{}_{}_{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        id
    ));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    let path = dir.join("sessions.db");
    let db = LocalDb::open(&path).expect("open temp wal db");
    (db, TempWalDbGuard { path })
}

// ===== Stream B 新增测试 =====

fn sample_entry(id: &str) -> SessionIndexEntry {
    SessionIndexEntry {
        id: id.to_string(),
        title: format!("Title {id}"),
        folder: "常规会话".to_string(),
        is_pinned: false,
        is_archived: false,
        branch_parent_id: None,
        timestamp: "2026-01-01T00:00:00Z".to_string(),
        updated_at: 1000,
        message_count: 0,
        pinned_message_ids: None,
        engine_cursor: None,
        engine_last_run_id: None,
        hydrated_from_engine: None,
    }
}

fn sample_message(id: &str, sender: &str, ts: i64) -> SessionMessage {
    SessionMessage {
        id: id.to_string(),
        sender: sender.to_string(),
        text: Some(format!("text-{id}")),
        thinking: None,
        timestamp: ts,
        status: Some("completed".to_string()),
        stream_text_offset: None,
        thinking_time: None,
        tool_calls_json: None,
        blocks_json: None,
        tool_call_results_json: None,
        usage: None,
    }
}
