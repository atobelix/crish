//! 会话域：sessions 表 CRUD、会话索引、孤儿清理（宽限期）、会话级元数据
//! （session_meta）读写。

use super::{DbFailure, DbFailureKind, LocalDb};
use conex_types::SessionIndexEntry;
use rusqlite::OptionalExtension;

mod lease;
mod orphan;

pub use orphan::OrphanCleanupOutcome;
pub(crate) use orphan::{cleanup_orphan_sessions_conn, delete_session_meta_prefix_conn};

impl LocalDb {
    /// 幂等插入会话行（自愈路径 / 引擎兜底用）。
    ///
    /// 写入真实 `updated_at`（N0-2 ④ 修复）：此前自愈行 `updated_at=0`，
    /// 孤儿清理的宽限期（`updated_at < now - grace`）对其永远生效——
    /// 宽限期形同虚设，boot 窗口的 keepIds 缺失会直接命中这些行。
    /// 现在自愈行与普通行一样享受宽限期保护。
    pub fn insert_session(&self, id: &str, title: &str) -> Result<(), DbFailure> {
        let id = id.to_string();
        let title = title.to_string();
        self.write_blocking(move |conn| {
            conn.execute(
                "INSERT OR IGNORE INTO sessions (id, title, updated_at)
                 VALUES (?1, ?2, strftime('%s','now') * 1000)",
                rusqlite::params![id, title],
            )
            .map_err(|e| DbFailure {
                message: format!("insert_session: {e}"),
                kind: DbFailureKind::Other("insert_session".to_string()),
            })?;
            Ok(())
        })
    }

    // ===== Stream B: Session 持久化方法 =====

    /// 幂等写入会话索引条目。
    /// 使用 `ON CONFLICT DO UPDATE` 而非 `INSERT OR REPLACE`，避免触发
    /// `ON DELETE CASCADE` 误删 session_messages / session_agents。
    /// `message_count` / `created_at` 不被覆盖（由 save_session_body 批末重算维护）。
    pub fn upsert_session_entry(&self, entry: &SessionIndexEntry) -> Result<(), DbFailure> {
        let entry = entry.clone();
        self.write_blocking(move |conn| {
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
            .map_err(|e| DbFailure {
                message: format!("upsert_session_entry: {e}"),
                kind: DbFailureKind::Other("upsert_session_entry".to_string()),
            })?;
            Ok(())
        })
    }

    /// 列出所有会话索引条目，按 `(updated_at DESC, id ASC)` 排序（最近更新在前）。
    ///
    /// SQL `ORDER BY updated_at DESC, id ASC` 与复合索引
    /// `idx_sessions_updated ON sessions(updated_at DESC, id ASC)` 物理对齐（SEC-10 / SEC-12），
    /// SQLite 直接沿索引单向扫描输出，彻底消除 `USE TEMP B-TREE FOR ORDER BY` 临时表排序。
    /// 读路径经 [`LocalDb::read`]：优先 ReaderPool 并发读，无池时回退主连接。
    pub fn list_sessions(&self) -> Result<Vec<SessionIndexEntry>, DbFailure> {
        self.read(|conn| {
            let mut stmt = conn
                .prepare_cached(
                    "SELECT id, title, folder, is_pinned, is_archived, branch_parent_id,
                            timestamp, updated_at, message_count, pinned_message_ids,
                            engine_cursor, engine_last_run_id, hydrated_from_engine
                     FROM sessions
                     ORDER BY updated_at DESC, id ASC",
                )
                .map_err(|e| self.latch_error("list_sessions_prepare", e))?;

            let entries = stmt
                .query_map([], map_session_index_entry)
                .map_err(|e| self.latch_error("list_sessions_map", e))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| self.latch_error("list_sessions_collect", e))?;

            Ok(entries)
        })
    }

    /// 基于 `(updated_at DESC, id ASC)` 复合游标的 Keyset 分页查询会话索引列表（SEC-10）。
    ///
    /// - `after_cursor`: `Some((cursor_updated_at, cursor_id))` 时，利用顶层 `updated_at <= ?1`
    ///   索引前导列定界 + `(updated_at < ?1 OR id > ?2)` 精确游标推进；`None` 时返回首页；
    /// - `limit`: 单页最大条数（`0` 时直接返回空向量）；
    /// - 全程命中 `idx_sessions_updated (updated_at DESC, id ASC)`，零 filesort 临时表。
    pub fn list_sessions_page(
        &self,
        after_cursor: Option<(i64, &str)>,
        limit: usize,
    ) -> Result<Vec<SessionIndexEntry>, DbFailure> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let limit_i64 = limit as i64;
        let cursor_owned = after_cursor.map(|(ts, id)| (ts, id.to_string()));
        self.read(move |conn| match &cursor_owned {
            None => {
                let mut stmt = conn
                    .prepare_cached(
                        "SELECT id, title, folder, is_pinned, is_archived, branch_parent_id,
                                timestamp, updated_at, message_count, pinned_message_ids,
                                engine_cursor, engine_last_run_id, hydrated_from_engine
                         FROM sessions
                         ORDER BY updated_at DESC, id ASC
                         LIMIT ?1",
                    )
                    .map_err(|e| self.latch_error("list_sessions_page_prepare", e))?;

                let entries = stmt
                    .query_map(rusqlite::params![limit_i64], map_session_index_entry)
                    .map_err(|e| self.latch_error("list_sessions_page_map", e))?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| self.latch_error("list_sessions_page_collect", e))?;
                Ok(entries)
            }
            Some((cursor_updated_at, cursor_id)) => {
                let mut stmt = conn
                    .prepare_cached(
                        "SELECT id, title, folder, is_pinned, is_archived, branch_parent_id,
                                timestamp, updated_at, message_count, pinned_message_ids,
                                engine_cursor, engine_last_run_id, hydrated_from_engine
                         FROM sessions
                         WHERE updated_at <= ?1 AND (updated_at < ?1 OR id > ?2)
                         ORDER BY updated_at DESC, id ASC
                         LIMIT ?3",
                    )
                    .map_err(|e| self.latch_error("list_sessions_page_prepare", e))?;

                let entries = stmt
                    .query_map(
                        rusqlite::params![cursor_updated_at, cursor_id, limit_i64],
                        map_session_index_entry,
                    )
                    .map_err(|e| self.latch_error("list_sessions_page_map", e))?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| self.latch_error("list_sessions_page_collect", e))?;
                Ok(entries)
            }
        })
    }

    /// 删除会话（级联删除 messages / agents / agent_messages，由 ON DELETE CASCADE 保证）
    /// 并显式清理该会话前缀的全部 session_meta 键（RUN-15：session_meta 为独立
    /// KV 表、无外键级联，会话行删除后 `{session_id}:*` 键残留——同事务内按
    /// 前缀显式删除，保证「删会话 → 按前缀查询 session_meta 返回 0 行」）。
    pub fn delete_session(&self, session_id: &str) -> Result<(), DbFailure> {
        let session_id = session_id.to_string();
        self.write_blocking(move |conn| {
            conn.execute(
                "DELETE FROM sessions WHERE id = ?1",
                rusqlite::params![session_id],
            )
            .map_err(|e| DbFailure {
                message: format!("delete_session: {e}"),
                kind: DbFailureKind::Other("delete_session".to_string()),
            })?;
            delete_session_meta_prefix_conn(conn, &session_id)?;
            orphan::delete_session_sequence_conn(conn, &session_id)?;
            Ok(())
        })
    }

    /// 读取会话级元数据键。
    /// 读路径经 [`LocalDb::read`]：优先 ReaderPool 并发读，无池时回退主连接。
    pub fn get_session_meta(&self, key: &str) -> Result<Option<String>, DbFailure> {
        self.read(|conn| {
            let mut stmt = conn
                .prepare("SELECT value FROM session_meta WHERE key = ?1")
                .map_err(|e| self.latch_error("get_session_meta_prepare", e))?;

            let value = stmt
                .query_row(rusqlite::params![key], |row| row.get::<_, String>(0))
                .optional()
                .map_err(|e| self.latch_error("get_session_meta_row", e))?;

            Ok(value)
        })
    }

    /// 写入会话级元数据键（幂等 upsert）。经组提交 Writer。
    pub fn set_session_meta(&self, key: &str, value: &str) -> Result<(), DbFailure> {
        let key = key.to_string();
        let value = value.to_string();
        self.write_blocking(move |conn| {
            conn.execute(
                "INSERT INTO session_meta (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                rusqlite::params![key, value],
            )
            .map_err(|e| DbFailure {
                message: format!("set_session_meta: {e}"),
                kind: DbFailureKind::Other("set_session_meta".to_string()),
            })?;
            Ok(())
        })
    }

    /// 会话级元数据原子更新（单写闭包内读改写；F3 #9 配额 try_consume 用）——
    /// 并发调用序列化于组提交 Actor 单写事务，compare-and-consume 原子生效。
    /// 返回写入的新值；`update` 返回 None = 更新被拒绝（未写入）。
    pub fn update_session_meta<F>(&self, key: &str, update: F) -> Result<Option<String>, DbFailure>
    where
        F: FnOnce(Option<&str>) -> Option<String> + Send + 'static,
    {
        self.update_session_meta_with_result(key, move |current| {
            let Some(new_value) = update(current) else {
                return Ok((None, None));
            };
            Ok((Some(new_value.clone()), Some(new_value)))
        })
    }

    /// 在单写事务中读改写元数据，并返回调用方结果。
    ///
    /// `update` 返回的第一个值为 `None` 时不写入元数据；第二个值不论是否写入都会返回。
    pub fn update_session_meta_with_result<F, R>(
        &self,
        key: &str,
        update: F,
    ) -> Result<R, DbFailure>
    where
        F: FnOnce(Option<&str>) -> Result<(Option<String>, R), DbFailure> + Send + 'static,
        R: Send + 'static,
    {
        let key = key.to_string();
        self.write_blocking(move |conn| {
            let current = conn
                .query_row(
                    "SELECT value FROM session_meta WHERE key = ?1",
                    rusqlite::params![key],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|e| DbFailure {
                    message: format!("get_session_meta_row: {e}"),
                    kind: DbFailureKind::Other("update_session_meta".to_string()),
                })?;

            let (new_value, result) = update(current.as_deref())?;
            if let Some(new_value) = new_value {
                conn.execute(
                    "INSERT INTO session_meta (key, value) VALUES (?1, ?2)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    rusqlite::params![key, new_value],
                )
                .map_err(|e| DbFailure {
                    message: format!("update_session_meta: {e}"),
                    kind: DbFailureKind::Other("update_session_meta".to_string()),
                })?;
            }
            Ok(result)
        })
    }

    /// 清理不在 `active_ids` 中的会话（孤儿清理）。
    /// 返回被删除的会话数。
    ///
    /// 写路径经组提交 Writer（`write_blocking`，D-P11：废除主连接裸锁
    /// 事务旁路与嵌套 `conn.transaction()`；COUNT 前后对比与删除同处
    /// Actor 的 `BEGIN IMMEDIATE` 事务内，原子性由外层事务保证）。
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
    ///
    /// RUN-07：返回值由 `usize` 升级为 [OrphanCleanupOutcome] 列表——删除
    /// 事务内在删行/删键前捕获被删会话的产出 meta 值（output_dir/output_root），
    /// 供壳层把产出目录送回收站并通知用户（delete_session 命令已 T-F 06
    /// 退役，本方法即生产删除路径）。删除数 = 返回列表长度。
    pub fn cleanup_orphan_sessions(
        &self,
        active_ids: &[String],
    ) -> Result<Vec<OrphanCleanupOutcome>, DbFailure> {
        let ids = active_ids.to_vec();
        self.write_blocking(move |conn| cleanup_orphan_sessions_conn(conn, &ids))
    }

    /// 更新会话的 `updated_at` 为当前 epoch ms。经组提交 Writer。
    pub fn touch_session(&self, session_id: &str) -> Result<(), DbFailure> {
        let session_id = session_id.to_string();
        self.write_blocking(move |conn| {
            conn.execute(
                "UPDATE sessions SET updated_at = strftime('%s','now') * 1000 WHERE id = ?1",
                rusqlite::params![session_id],
            )
            .map_err(|e| DbFailure {
                message: format!("touch_session: {e}"),
                kind: DbFailureKind::Other("touch_session".to_string()),
            })?;
            Ok(())
        })
    }
}

fn map_session_index_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionIndexEntry> {
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
}

#[cfg(test)]
mod tests;
