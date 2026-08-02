//! 会话域：sessions 表 CRUD、会话索引、孤儿清理（宽限期）、会话级元数据
//! （session_meta）读写。

use super::{DbFailure, DbFailureKind, LocalDb, ORPHAN_GRACE_MS, ORPHAN_GRACE_MS_KEY};
use conex_types::SessionIndexEntry;
use rusqlite::OptionalExtension;

impl LocalDb {
    pub fn insert_session(&self, id: &str, title: &str) -> Result<(), DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        conn.execute(
            "INSERT OR IGNORE INTO sessions (id, title) VALUES (?1, ?2)",
            rusqlite::params![id, title],
        )
        .map_err(|e| self.latch_error("insert_session", e))?;

        Ok(())
    }

    // ===== Stream B: Session 持久化方法 =====

    /// 幂等写入会话索引条目。
    /// 使用 `ON CONFLICT DO UPDATE` 而非 `INSERT OR REPLACE`，避免触发
    /// `ON DELETE CASCADE` 误删 session_messages / session_agents。
    /// `message_count` / `created_at` 不被覆盖（由触发器 / 创建时维护）。
    pub fn upsert_session_entry(&self, entry: &SessionIndexEntry) -> Result<(), DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        let is_pinned: i64 = entry.is_pinned.into();
        let is_archived: i64 = entry.is_archived.into();
        let hydrated: Option<i64> = entry.hydrated_from_engine.map(|b| b.into());

        conn.execute(
            "INSERT INTO sessions (
                id, title, folder, is_pinned, is_archived, branch_parent_id,
                timestamp, updated_at, pinned_message_ids,
                engine_cursor, engine_last_run_id, hydrated_from_engine
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
            ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                folder = excluded.folder,
                is_pinned = excluded.is_pinned,
                is_archived = excluded.is_archived,
                branch_parent_id = excluded.branch_parent_id,
                timestamp = excluded.timestamp,
                updated_at = excluded.updated_at,
                pinned_message_ids = excluded.pinned_message_ids,
                engine_cursor = excluded.engine_cursor,
                engine_last_run_id = excluded.engine_last_run_id,
                hydrated_from_engine = excluded.hydrated_from_engine",
            rusqlite::params![
                entry.id,
                entry.title,
                entry.folder,
                is_pinned,
                is_archived,
                entry.branch_parent_id,
                entry.timestamp,
                entry.updated_at,
                entry.pinned_message_ids,
                entry.engine_cursor,
                entry.engine_last_run_id,
                hydrated,
            ],
        )
        .map_err(|e| self.latch_error("upsert_session_entry", e))?;

        Ok(())
    }

    /// 列出所有会话索引条目，按 `updated_at` 降序（最近更新在前）。
    pub fn list_sessions(&self) -> Result<Vec<SessionIndexEntry>, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        let mut stmt = conn
            .prepare(
                "SELECT id, title, folder, is_pinned, is_archived, branch_parent_id,
                        timestamp, updated_at, message_count, pinned_message_ids,
                        engine_cursor, engine_last_run_id, hydrated_from_engine
                 FROM sessions
                 ORDER BY updated_at DESC, id ASC",
            )
            .map_err(|e| self.latch_error("list_sessions_prepare", e))?;

        let entries = stmt
            .query_map([], |row| {
                let is_pinned: i64 = row.get(3)?;
                let is_archived: i64 = row.get(4)?;
                let hydrated: Option<i64> = row.get(12)?;
                Ok(SessionIndexEntry {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    folder: row.get(2)?,
                    is_pinned: is_pinned != 0,
                    is_archived: is_archived != 0,
                    branch_parent_id: row.get(5)?,
                    timestamp: row.get(6)?,
                    updated_at: row.get(7)?,
                    message_count: row.get(8)?,
                    pinned_message_ids: row.get(9)?,
                    engine_cursor: row.get(10)?,
                    engine_last_run_id: row.get(11)?,
                    hydrated_from_engine: hydrated.map(|v| v != 0),
                })
            })
            .map_err(|e| self.latch_error("list_sessions_map", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| self.latch_error("list_sessions_collect", e))?;

        Ok(entries)
    }

    /// 删除会话（级联删除 messages / agents / agent_messages，由 ON DELETE CASCADE 保证）。
    pub fn delete_session(&self, session_id: &str) -> Result<(), DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        conn.execute(
            "DELETE FROM sessions WHERE id = ?1",
            rusqlite::params![session_id],
        )
        .map_err(|e| self.latch_error("delete_session", e))?;

        Ok(())
    }

    /// 读取会话级元数据键。
    pub fn get_session_meta(&self, key: &str) -> Result<Option<String>, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        let mut stmt = conn
            .prepare("SELECT value FROM session_meta WHERE key = ?1")
            .map_err(|e| self.latch_error("get_session_meta_prepare", e))?;

        let value = stmt
            .query_row(rusqlite::params![key], |row| row.get::<_, String>(0))
            .optional()
            .map_err(|e| self.latch_error("get_session_meta_row", e))?;

        Ok(value)
    }

    /// 写入会话级元数据键（幂等 upsert）。
    pub fn set_session_meta(&self, key: &str, value: &str) -> Result<(), DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        conn.execute(
            "INSERT INTO session_meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![key, value],
        )
        .map_err(|e| self.latch_error("set_session_meta", e))?;

        Ok(())
    }

    /// 清理不在 `active_ids` 中的会话（孤儿清理）。
    /// 返回被删除的会话数。
    pub fn cleanup_orphan_sessions(&self, active_ids: &[String]) -> Result<usize, DbFailure> {
        let mut conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        let tx = conn
            .transaction()
            .map_err(|e| self.latch_error("cleanup_orphan_tx", e))?;

        // 宽限期（PE-08 T08.2）：updated_at 距今小于该值的会话不被清理。
        // 值可从 session_meta 的 orphan_grace_ms 覆盖（默认 ORPHAN_GRACE_MS）。
        let grace_ms: i64 = tx
            .query_row(
                "SELECT value FROM session_meta WHERE key = ?1",
                rusqlite::params![ORPHAN_GRACE_MS_KEY],
                |row| row.get::<_, String>(0),
            )
            .ok()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(ORPHAN_GRACE_MS);
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let grace_cutoff = now_ms - grace_ms;

        let total_before: i64 = tx
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .map_err(|e| self.latch_error("cleanup_orphan_count_before", e))?;

        if active_ids.is_empty() {
            // 空 keepIds 的全表清理由壳层守卫（confirm_empty）把关；
            // 库层仍执行宽限期保护（近宽限期内新建的会话保留）。
            tx.execute(
                "DELETE FROM sessions WHERE updated_at < ?1",
                rusqlite::params![grace_cutoff],
            )
            .map_err(|e| self.latch_error("cleanup_orphan_delete_all", e))?;
        } else {
            // 构造 IN (?, ?, ...) 占位符
            let placeholders: Vec<String> = (0..active_ids.len()).map(|_| "?".to_string()).collect();
            let sql = format!(
                "DELETE FROM sessions WHERE id NOT IN ({}) AND updated_at < ?{}",
                placeholders.join(", "),
                active_ids.len() + 1
            );
            let mut params: Vec<&dyn rusqlite::ToSql> = active_ids
                .iter()
                .map(|s| s as &dyn rusqlite::ToSql)
                .collect();
            params.push(&grace_cutoff);
            tx.execute(&sql, params.as_slice())
                .map_err(|e| self.latch_error("cleanup_orphan_delete", e))?;
        }

        let total_after: i64 = tx
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .map_err(|e| self.latch_error("cleanup_orphan_count_after", e))?;

        tx.commit()
            .map_err(|e| self.latch_error("cleanup_orphan_commit", e))?;

        Ok((total_before - total_after) as usize)
    }

    /// 更新会话的 `updated_at` 为当前 epoch ms。
    pub fn touch_session(&self, session_id: &str) -> Result<(), DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        conn.execute(
            "UPDATE sessions SET updated_at = strftime('%s','now') * 1000 WHERE id = ?1",
            rusqlite::params![session_id],
        )
        .map_err(|e| self.latch_error("touch_session", e))?;

        Ok(())
    }
}
