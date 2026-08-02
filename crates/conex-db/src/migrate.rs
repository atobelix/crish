//! 迁移链域：`PRAGMA user_version` 驱动的版本化迁移（v1→v4，PE-08 T08.7）。
//! 逐版本独立事务、幂等可重试；DROP 前备份（[backup_before_drop]）；
//! 新库直接建 v4 结构。迁移实现保持原样，由 `LocalDb::open` 触发。

use super::schema::{create_v1_schema, create_v4_schema};
use super::{DbFailure, DbFailureKind, LocalDb, BACKUP_KEEP, LATEST_VERSION, SCHEMA_VERSION_STRING};
use std::path::Path;

impl LocalDb {
    /// 读取当前 schema 版本（PRAGMA user_version，PE-08 T08.7）。
    pub fn user_version(&self) -> Result<u32, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        conn.query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| self.latch_error("user_version", e))
    }

    /// 迁移备份：整库拷贝到 `sessions.db.bak-v{n}`，保留最近 [BACKUP_KEEP] 份。
    fn backup_before_drop(&self, path: &Path, version: u32) {
        let Some(dir) = path.parent() else {
            return;
        };
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "sessions.db".into());
        let backup = dir.join(format!("{name}.bak-v{version}"));
        if let Err(e) = std::fs::copy(path, &backup) {
            eprintln!("[conex-db] 迁移备份失败 v{version}: {e}（路径 {}）", path.display());
        }
        // 清理旧备份，只保留最近 BACKUP_KEEP 份
        let mut backups: Vec<std::path::PathBuf> = std::fs::read_dir(&dir)
            .ok()
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .map(|n| n.to_string_lossy().starts_with(&format!("{name}.bak-v")))
                    .unwrap_or(false)
            })
            .collect();
        backups.sort();
        while backups.len() > BACKUP_KEEP {
            if let Some(oldest) = backups.first() {
                let _ = std::fs::remove_file(oldest);
                backups.remove(0);
            }
        }
    }

    /// Run schema migrations.
    ///
    /// 版本化迁移（PE-08 T08.7）：以 `PRAGMA user_version` 为权威源，
    /// 从当前版本逐级迁移到 [LATEST_VERSION]；每版本独立事务、幂等可重试；
    /// DROP 前备份（[backup_before_drop]）；新库直接建 v4 结构。
    pub(crate) fn migrate(&self) -> Result<(), DbFailure> {
        let mut conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(|e| self.latch_error("pragma_foreign_keys", e))?;
        // WAL 模式 + busy_timeout（PE-08 T08.7：并发写友好）
        let _ = conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");

        let current: u32 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| self.latch_error("user_version_read", e))?;

        if current == LATEST_VERSION {
            // 已是目标版本：确保关键结构存在（幂等兜底，含备份恢复场景）
            conn.execute_batch(create_v4_schema())
                .map_err(|e| self.latch_error("schema_ensure", e))?;
            self.record_schema_version(&conn)?;
            return Ok(());
        }

        // 全新库（无 sessions 表）：建 v1 形态后走完整迁移链
        // （fresh_db_full_chain 测试锚定：全新建库也执行 v1..v4 全部迁移，
        // 验证迁移链自身正确性，且 DROP 前备份产生）。
        let has_sessions: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sessions'",
                [],
                |r| r.get(0),
            )
            .map_err(|e| self.latch_error("has_sessions", e))?;
        if current == 0 && has_sessions == 0 {
            conn.execute_batch(create_v1_schema())
                .map_err(|e| self.latch_error("schema_create_v1", e))?;
            conn.execute_batch("PRAGMA user_version = 1;")
                .map_err(|e| self.latch_error("user_version_set_1", e))?;
        }

        // 逐版本迁移（旧生产形态 user_version=0 但已有旧表：按 v1 起点迁移）
        let path: Option<std::path::PathBuf> = conn
            .path()
            .map(std::path::PathBuf::from)
            .filter(|p| p != Path::new(":memory:"));
        let start_version = if current == 0 { 1 } else { current };

        for version in (start_version + 1)..=LATEST_VERSION {
            let tx = conn
                .transaction()
                .map_err(|e| self.latch_error(&format!("migrate_tx_v{version}"), e))?;
            let step_result = match version {
                2 => migrate_v1_to_v2(&tx),
                3 => migrate_v2_to_v3(&tx),
                4 => migrate_v3_to_v4(&tx),
                _ => unreachable!(),
            };
            if let Err(e) = step_result {
                let msg = format!("migrate_v{version} failed: {e}");
                let failure = DbFailure {
                    message: msg,
                    kind: DbFailureKind::Migration,
                };
                self.set_failure(failure.clone());
                return Err(failure);
            }
            tx.commit()
                .map_err(|e| self.latch_error(&format!("migrate_commit_v{version}"), e))?;
            conn.execute_batch(&format!("PRAGMA user_version = {version};"))
                .map_err(|e| self.latch_error(&format!("user_version_set_v{version}"), e))?;
            if let Some(p) = &path {
                self.backup_before_drop(p, version);
            }
        }

        // 迁移完成后 ensure v4 结构（补触发器/索引；幂等）
        conn.execute_batch(create_v4_schema())
            .map_err(|e| self.latch_error("schema_ensure_post_migrate", e))?;
        self.record_schema_version(&conn)?;

        Ok(())
    }

    /// 登记 schema 版本到 session_meta（JS 侧经 get_session_meta 读取）。
    fn record_schema_version(&self, conn: &rusqlite::Connection) -> Result<(), DbFailure> {
        conn.execute(
            "INSERT OR IGNORE INTO session_meta (key, value) VALUES ('schema_version', ?1)",
            rusqlite::params![SCHEMA_VERSION_STRING],
        )
        .map_err(|e| self.latch_error("schema_version_set", e))?;
        conn.execute(
            "UPDATE session_meta SET value = ?1 WHERE key = 'schema_version'",
            rusqlite::params![SCHEMA_VERSION_STRING],
        )
        .map_err(|e| self.latch_error("schema_version_update", e))?;
        Ok(())
    }
}

/// v1 → v2：sessions 补 folder 等列（ADD COLUMN，避免 RENAME+DROP 父表
/// 触发 ON DELETE CASCADE 清空 session_messages / session_agents 数据）。
fn migrate_v1_to_v2(tx: &rusqlite::Transaction<'_>) -> Result<(), rusqlite::Error> {
    let cols: Vec<String> = tx
        .prepare("PRAGMA table_info(sessions)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .collect();
    let add = |tx: &rusqlite::Transaction<'_>, col: &str, ddl: &str| -> Result<(), rusqlite::Error> {
        if !cols.iter().any(|c| c == col) {
            tx.execute_batch(&format!("ALTER TABLE sessions ADD COLUMN {ddl};"))?;
        }
        Ok(())
    };
    add(tx, "folder", "folder TEXT NOT NULL DEFAULT '常规会话'")?;
    add(tx, "is_pinned", "is_pinned INTEGER NOT NULL DEFAULT 0")?;
    add(tx, "is_archived", "is_archived INTEGER NOT NULL DEFAULT 0")?;
    add(tx, "branch_parent_id", "branch_parent_id TEXT")?;
    add(tx, "timestamp_source", "timestamp_source TEXT")?;
    add(tx, "pinned_message_ids", "pinned_message_ids TEXT")?;
    add(tx, "engine_cursor", "engine_cursor INTEGER")?;
    add(tx, "engine_last_run_id", "engine_last_run_id TEXT")?;
    add(tx, "hydrated_from_engine", "hydrated_from_engine INTEGER")?;
    Ok(())
}

/// v2 → v3：session_agent_messages 重建补 CHECK (status IN ...) 约束（数据拷贝）。
fn migrate_v2_to_v3(tx: &rusqlite::Transaction<'_>) -> Result<(), rusqlite::Error> {
    tx.execute_batch(
        "ALTER TABLE session_agent_messages RENAME TO sam_v2;
         CREATE TABLE session_agent_messages (
            session_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            id TEXT NOT NULL,
            sender TEXT NOT NULL CHECK (sender IN ('user','assistant')),
            text TEXT,
            thinking TEXT,
            timestamp INTEGER NOT NULL,
            status TEXT CHECK (status IN ('queued','processing','completed','error')),
            stream_text_offset INTEGER,
            thinking_time INTEGER,
            tool_calls_json TEXT,
            blocks_json TEXT,
            tool_call_results_json TEXT,
            PRIMARY KEY (session_id, agent_id, seq),
            FOREIGN KEY (session_id, agent_id) REFERENCES session_agents(session_id, agent_id) ON DELETE CASCADE
         ) WITHOUT ROWID;
         INSERT INTO session_agent_messages
            (session_id, agent_id, seq, id, sender, text, thinking, timestamp, status,
             stream_text_offset, thinking_time, tool_calls_json, blocks_json, tool_call_results_json)
            SELECT session_id, agent_id, seq, id, sender, text, thinking, timestamp, status,
             stream_text_offset, thinking_time, tool_calls_json, blocks_json, tool_call_results_json
            FROM sam_v2;
         DROP TABLE sam_v2;",
    )
}

/// v3 → v4：events 重建为组合主键（无 id 列 + FK）、metadata 删除、
/// runs/pending_inputs 加 FK（孤儿行过滤）、session_messages 加 updated_at、
/// session_sequence 建表/对齐。
fn migrate_v3_to_v4(tx: &rusqlite::Transaction<'_>) -> Result<(), rusqlite::Error> {
    // 孤儿计数（会话不存在的 events/runs/pending 行）→ 写入 session_meta 可观测
    let orphan_events: i64 = tx.query_row(
        "SELECT COUNT(*) FROM events WHERE session_id NOT IN (SELECT id FROM sessions)",
        [],
        |r| r.get(0),
    )?;
    let orphan_runs: i64 = tx.query_row(
        "SELECT COUNT(*) FROM runs WHERE session_id NOT IN (SELECT id FROM sessions)",
        [],
        |r| r.get(0),
    )?;
    let orphan_pending: i64 = tx.query_row(
        "SELECT COUNT(*) FROM pending_inputs WHERE session_id NOT IN (SELECT id FROM sessions)",
        [],
        |r| r.get(0),
    )?;
    tx.execute(
        "INSERT OR IGNORE INTO session_meta (key, value) VALUES ('migration_v4_dropped_orphans', ?1)",
        rusqlite::params![format!("{orphan_events}:{orphan_runs}:{orphan_pending}")],
    )?;
    tx.execute_batch(
        "ALTER TABLE events RENAME TO events_v3;
         CREATE TABLE events (
            session_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            payload TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (session_id, sequence),
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
         ) WITHOUT ROWID;
         INSERT INTO events (session_id, sequence, event_type, payload, created_at)
            SELECT session_id, sequence, event_type, payload, created_at FROM events_v3
            WHERE session_id IN (SELECT id FROM sessions);
         DROP TABLE events_v3;

         DROP TABLE IF EXISTS metadata;

         ALTER TABLE runs RENAME TO runs_v3;
         CREATE TABLE runs (
            run_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            status TEXT NOT NULL,
            end_reason TEXT,
            cursor INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
         ) WITHOUT ROWID;
         INSERT INTO runs (run_id, session_id, status, end_reason, cursor, created_at, updated_at)
            SELECT run_id, session_id, status, end_reason, cursor, created_at, updated_at FROM runs_v3
            WHERE session_id IN (SELECT id FROM sessions);
         DROP TABLE runs_v3;
         CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);

         ALTER TABLE pending_inputs RENAME TO pending_v3;
         CREATE TABLE pending_inputs (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            run_id TEXT,
            payload TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
         ) WITHOUT ROWID;
         INSERT INTO pending_inputs (id, session_id, run_id, payload, created_at)
            SELECT id, session_id, run_id, payload, created_at FROM pending_v3
            WHERE session_id IN (SELECT id FROM sessions);
         DROP TABLE pending_v3;
         CREATE INDEX IF NOT EXISTS idx_pending_session ON pending_inputs(session_id, created_at);

         ALTER TABLE session_messages ADD COLUMN updated_at INTEGER;",
    )?;
    // session_sequence：v3 形态可能不存在（v1/v2 fixture）——不存在则直接建；
    // 存在则重建对齐 next_sequence 列名并过滤孤儿。
    let has_ss: i64 = tx.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='session_sequence'",
        [],
        |r| r.get(0),
    )?;
    if has_ss > 0 {
        tx.execute_batch(
            "ALTER TABLE session_sequence RENAME TO ss_v3;
             CREATE TABLE session_sequence (
                session_id TEXT PRIMARY KEY,
                next_sequence INTEGER NOT NULL DEFAULT 1
             ) WITHOUT ROWID;
             INSERT INTO session_sequence (session_id, next_sequence)
                SELECT session_id, next_seq FROM ss_v3
                WHERE session_id IN (SELECT id FROM sessions);
             DROP TABLE ss_v3;",
        )?;
    } else {
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS session_sequence (
                session_id TEXT PRIMARY KEY,
                next_sequence INTEGER NOT NULL DEFAULT 1
             ) WITHOUT ROWID;",
        )?;
    }
    Ok(())
}
