//! Schema 迁移、版本化升级与跨版本兼容性单测。

// G2 禁令豁免：测试临时 DB 清理（非产品删除路径，可恢复语义不适用）。
#![allow(clippy::disallowed_methods)]

use super::*;
use crate::migrate_steps::{migrate_v10_to_v11, step_10_to_11};
use crate::schema::create_v5_schema;
use conex_types::{RunCacheStats, SessionIndexEntry, SessionMessage};
use rusqlite::Connection;
use std::collections::HashMap;

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

#[test]
fn schema_version_is_current() {
    let db = LocalDb::open_in_memory().unwrap();
    let v = db
        .get_session_meta("schema_version")
        .unwrap()
        .expect("schema_version should be set by migrate()");
    assert_eq!(v, SCHEMA_VERSION_STRING);
}

// ===== P5 T-39：v5 迁移（runs usage/cache 列 + session_messages.usage_json）=====

/// 唯一临时文件库（v5 迁移磁盘 fixture；Drop 清理主文件 / WAL / SHM / 目录）。
struct TempV5Db {
    path: std::path::PathBuf,
}

impl TempV5Db {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "conex-v5-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        ));
        if let Err(err) = std::fs::create_dir_all(&dir) {
            // 创建失败会让后续 open 以真实错误暴露；此处留痕以区分「目录建不出来」
            eprintln!("[conex-db test] 创建临时目录失败 {}: {err}", dir.display());
        }
        let path = dir.join("sessions.db");
        crate::tests::cleanup_temp_path(&path);
        Self { path }
    }
}

impl Drop for TempV5Db {
    fn drop(&mut self) {
        crate::tests::cleanup_temp_path(&self.path);
        crate::tests::cleanup_temp_path(format!("{}-wal", self.path.display()));
        crate::tests::cleanup_temp_path(format!("{}-shm", self.path.display()));
        if let Some(parent) = self.path.parent() {
            crate::tests::cleanup_temp_path(parent);
        }
    }
}

fn table_columns_v5(conn: &Connection, table: &str) -> Vec<String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .unwrap();
    stmt.query_map([], |r| r.get::<_, String>(1))
        .unwrap()
        .filter_map(|c| c.ok())
        .collect()
}

mod usage_and_fresh;
mod v12_import;
mod v4_v5;
