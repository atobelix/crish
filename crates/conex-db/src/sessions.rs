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

    /// 列出所有会话索引条目，按 `updated_at` 降序（最近更新在前）。
    /// 读路径经 [`LocalDb::read`]：优先 ReaderPool 并发读，无池时回退主连接。
    pub fn list_sessions(&self) -> Result<Vec<SessionIndexEntry>, DbFailure> {
        self.read(|conn| {
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
        })
    }

    /// 删除会话（级联删除 messages / agents / agent_messages，由 ON DELETE CASCADE 保证）。
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

            let Some(new_value) = update(current.as_deref()) else {
                return Ok(None);
            };
            conn.execute(
                "INSERT INTO session_meta (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                rusqlite::params![key, new_value],
            )
            .map_err(|e| DbFailure {
                message: format!("update_session_meta: {e}"),
                kind: DbFailureKind::Other("update_session_meta".to_string()),
            })?;
            Ok(Some(new_value))
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
    pub fn cleanup_orphan_sessions(&self, active_ids: &[String]) -> Result<usize, DbFailure> {
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

    // ===== 全局恢复排他租约（04 详案 §6.2：session_meta 键承载，零 DDL） =====

    /// 原子抢占全局恢复排他租约（TTL 默认 [`RECOVERY_LEASE_TTL_MS`] = 30s）。
    ///
    /// 经 [`Self::update_session_meta`] 的写 Actor 串行化闭包实现 CAS：
    /// 租约不存在或已过期 → 抢占成功（写入 `instance_id` + 过期戳）；
    /// 租约未过期且被他人持有 → 拒绝（返回 `false`，调用方应安全跳过
    /// 事件合成、以只读模式加载）。同一实例未过期时重抢同样被拒——
    /// 续期请走 [`Self::renew_recovery_lease`]。
    pub fn try_acquire_recovery_lease(
        &self,
        instance_id: &str,
        ttl_ms: Option<i64>,
    ) -> Result<bool, DbFailure> {
        let instance_id = instance_id.to_string();
        let ttl = ttl_ms.unwrap_or(crate::RECOVERY_LEASE_TTL_MS);
        let result = self.update_session_meta(crate::RECOVERY_LEASE_KEY, move |current| {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            if let Some(val_str) = current {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(val_str) {
                    if let Some(exp) = v.get("expiresAt").and_then(|e| e.as_i64()) {
                        if now_ms < exp {
                            // 租约未过期且被他人持有：抢占拒绝
                            return None;
                        }
                    }
                }
            }
            let lease_payload = serde_json::json!({
                "instanceId": instance_id,
                "acquiredAt": now_ms,
                "expiresAt": now_ms + ttl,
            });
            Some(lease_payload.to_string())
        })?;
        Ok(result.is_some())
    }

    /// 续期自己持有的全局恢复租约（TTL 默认 30s）。
    /// 仅当当前持有者为 `instance_id` 时续期成功；租约不存在 / 已易主 /
    /// 已过期 → `false`（应重新 [`Self::try_acquire_recovery_lease`]）。
    pub fn renew_recovery_lease(
        &self,
        instance_id: &str,
        ttl_ms: Option<i64>,
    ) -> Result<bool, DbFailure> {
        let instance_id = instance_id.to_string();
        let ttl = ttl_ms.unwrap_or(crate::RECOVERY_LEASE_TTL_MS);
        let result = self.update_session_meta(crate::RECOVERY_LEASE_KEY, move |current| {
            let val_str = current?;
            let v: serde_json::Value = serde_json::from_str(val_str).ok()?;
            if v.get("instanceId").and_then(|e| e.as_str()) != Some(instance_id.as_str()) {
                return None;
            }
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            let lease_payload = serde_json::json!({
                "instanceId": instance_id,
                "acquiredAt": v.get("acquiredAt").and_then(|e| e.as_i64()).unwrap_or(now_ms),
                "expiresAt": now_ms + ttl,
            });
            Some(lease_payload.to_string())
        })?;
        Ok(result.is_some())
    }

    /// 释放自己持有的全局恢复租约（条件删除：仅持有者匹配时清除）。
    /// 返回 `true` 表示本次确实删除了租约行。
    pub fn release_recovery_lease(&self, instance_id: &str) -> Result<bool, DbFailure> {
        let instance_id = instance_id.to_string();
        self.write_blocking(move |conn| {
            let current: Option<String> = conn
                .query_row(
                    "SELECT value FROM session_meta WHERE key = ?1",
                    rusqlite::params![crate::RECOVERY_LEASE_KEY],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|e| DbFailure {
                    message: format!("release_recovery_lease_read: {e}"),
                    kind: DbFailureKind::Other("release_recovery_lease".to_string()),
                })?;
            let holder_matches = current
                .as_deref()
                .and_then(|val_str| serde_json::from_str::<serde_json::Value>(val_str).ok())
                .and_then(|v| {
                    v.get("instanceId")
                        .and_then(|e| e.as_str())
                        .map(|s| s == instance_id)
                })
                .unwrap_or(false);
            if !holder_matches {
                return Ok(false);
            }
            conn.execute(
                "DELETE FROM session_meta WHERE key = ?1",
                rusqlite::params![crate::RECOVERY_LEASE_KEY],
            )
            .map_err(|e| DbFailure {
                message: format!("release_recovery_lease_delete: {e}"),
                kind: DbFailureKind::Other("release_recovery_lease".to_string()),
            })?;
            Ok(true)
        })
    }
}

/// 孤儿会话清理连接级纯函数（D-P11：供 `write_blocking` 闭包调用；
/// 绝对禁止捕获 `LocalDb` / 调用 `self.*` / 开启 `conn.transaction()`——
/// 外层 Actor 已持 `BEGIN IMMEDIATE`，本函数直接在其事务内顺序执行）。
pub(crate) fn cleanup_orphan_sessions_conn(
    conn: &rusqlite::Connection,
    active_ids: &[String],
) -> Result<usize, DbFailure> {
    // 宽限期（PE-08 T08.2）：updated_at 距今小于该值的会话不被清理。
    // 值可从 session_meta 的 orphan_grace_ms 覆盖（默认 ORPHAN_GRACE_MS）。
    let grace_ms: i64 = conn
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

    let total_before: i64 = conn
        .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
        .map_err(|e| DbFailure {
            message: format!("cleanup_orphan_count_before: {e}"),
            kind: DbFailureKind::Other("cleanup_orphan_sessions".to_string()),
        })?;

    if active_ids.is_empty() {
        // 空 keepIds 的全表清理由壳层守卫（confirm_empty）把关；
        // 库层仍执行宽限期 + 豁免保护（近宽限期内新建 / 引擎 / 活动 run 保留）。
        conn.execute(
            &format!("DELETE FROM sessions WHERE updated_at < ?1 AND {protected}"),
            rusqlite::params![grace_cutoff],
        )
        .map_err(|e| DbFailure {
            message: format!("cleanup_orphan_delete_all: {e}"),
            kind: DbFailureKind::Other("cleanup_orphan_sessions".to_string()),
        })?;
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
        conn.execute(&sql, params.as_slice())
            .map_err(|e| DbFailure {
                message: format!("cleanup_orphan_delete: {e}"),
                kind: DbFailureKind::Other("cleanup_orphan_sessions".to_string()),
            })?;
    }

    let total_after: i64 = conn
        .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
        .map_err(|e| DbFailure {
            message: format!("cleanup_orphan_count_after: {e}"),
            kind: DbFailureKind::Other("cleanup_orphan_sessions".to_string()),
        })?;

    Ok((total_before - total_after) as usize)
}
