//! 会话域：sessions 表 CRUD、会话索引、孤儿清理（宽限期）、会话级元数据
//! （session_meta）读写。

use super::{DbFailure, DbFailureKind, LocalDb, ORPHAN_GRACE_MS, ORPHAN_GRACE_MS_KEY};
use conex_types::SessionIndexEntry;
use rusqlite::OptionalExtension;

impl LocalDb {
    /// 幂等插入会话行（自愈路径 / 引擎兜底用）。
    ///
    /// 写入真实 `updated_at`（N0-2 ④ 修复）：此前自愈行 `updated_at=0`，
    /// 孤儿清理的宽限期（`updated_at < now - grace`）对其永远生效——
    /// 宽限期形同虚设，boot 窗口的 keepIds 缺失会直接命中这些行。
    /// 现在自愈行与普通行一样享受宽限期保护。
    pub fn insert_session(&self, id: &str, title: &str) -> Result<(), DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        conn.execute(
            "INSERT OR IGNORE INTO sessions (id, title, updated_at)
             VALUES (?1, ?2, strftime('%s','now') * 1000)",
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

    /// 会话级元数据原子更新（单次锁内读改写；F3 #9 配额 try_consume 用）——
    /// 并发调用序列化于连接互斥，compare-and-consume 原子生效。
    /// 返回写入的新值；`update` 返回 None = 更新被拒绝（未写入）。
    pub fn update_session_meta<F>(&self, key: &str, update: F) -> Result<Option<String>, DbFailure>
    where
        F: FnOnce(Option<&str>) -> Option<String>,
    {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        let current = conn
            .query_row(
                "SELECT value FROM session_meta WHERE key = ?1",
                rusqlite::params![key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| self.latch_error("get_session_meta_row", e))?;

        let Some(new_value) = update(current.as_deref()) else {
            return Ok(None);
        };
        conn.execute(
            "INSERT INTO session_meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![key, new_value],
        )
        .map_err(|e| self.latch_error("update_session_meta", e))?;
        Ok(Some(new_value))
    }

    /// 清理不在 `active_ids` 中的会话（孤儿清理）。
    /// 返回被删除的会话数。
    ///
    /// 安全护栏（P0-2 / PERSIST-03 P1-1 升级 P0 修复，2026-08-07）：
    /// - **宽限期**（F4/PE-08 T08.2）：`updated_at` 距今小于 `ORPHAN_GRACE_MS`
    ///   的行跳过删除（值可由 session_meta `orphan_grace_ms` 覆盖）；
    /// - **引擎子代理会话豁免**：`hydrated_from_engine = 1` 的会话（引擎创建的
    ///   sub-sess-*，subagent_spawner 落库且永不 touch）不在前端 keepIds、
    ///   updated_at 永不过期刷新——宽限期无法保护。一律豁免，防止孤儿清理
    ///   级联删除运行中子代理的会话树 / agents 行 / 审计事件流（删后
    ///   append_event 因 FK 失败会把子代理 run 标记 failed）；
    /// - **活动 run 豁免**：存在非终态 run（queued/initializing/running/
    ///   awaiting-approval/completing/cancelling）的会话跳过删除——防
    ///   「长 run 中途被清」的 FK 失败与审计断链（PERSIST-03 P2-7 联动校验）；
    /// - **未决 pending 豁免**：存在未消费 pending_inputs 的会话跳过删除
    ///   （T3.3/D3：pending 未决即会话仍处于运行期产出待消费状态，级联
    ///   删除会连 pending 一并清空）。
    ///
    /// 综上：即使 keepIds 为空或部分（boot 窗口 / hydrate 未完成），库层也
    /// **不会全库清空**——只可能删除「非引擎、无活动 run、无未决 pending、
    /// 超宽限期」的孤儿行。
    /// 空 keepIds 的显式清空语义由壳层守卫（guard_cleanup_keep + confirm_empty）
    /// 把关；库层对空 keepIds 仍执行上述护栏 + 宽限期保护。
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

        // 豁免条件（两个删除分支共用）：引擎子代理会话 + 活动 run 会话 +
        // 未决 pending 输入。hydrated_from_engine 为 NULL（普通会话）时
        // COALESCE 取 0 → 可删。
        let protected = "COALESCE(hydrated_from_engine, 0) != 1
            AND NOT EXISTS (
                SELECT 1 FROM runs r
                WHERE r.session_id = sessions.id
                  AND r.status IN (
                      'queued','initializing','running','awaiting-approval',
                      'completing','cancelling'
                  )
            )
            AND NOT EXISTS (
                SELECT 1 FROM pending_inputs p
                WHERE p.session_id = sessions.id
            )";

        let total_before: i64 = tx
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .map_err(|e| self.latch_error("cleanup_orphan_count_before", e))?;

        if active_ids.is_empty() {
            // 空 keepIds 的全表清理由壳层守卫（confirm_empty）把关；
            // 库层仍执行宽限期 + 豁免保护（近宽限期内新建 / 引擎 / 活动 run 保留）。
            tx.execute(
                &format!("DELETE FROM sessions WHERE updated_at < ?1 AND {protected}"),
                rusqlite::params![grace_cutoff],
            )
            .map_err(|e| self.latch_error("cleanup_orphan_delete_all", e))?;
        } else {
            // 构造 IN (?, ?, ...) 占位符
            let placeholders: Vec<String> = (0..active_ids.len()).map(|_| "?".to_string()).collect();
            let sql = format!(
                "DELETE FROM sessions WHERE id NOT IN ({}) AND updated_at < ?{} AND {protected}",
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
