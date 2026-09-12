//! localStorage 导入域：一次性迁移 `crish_session_index_v1` / body / agents /
//! active / folder_order 到 SQLite（T08.10 语义），单事务原子。
//!
//! 写路径收敛（03 DEL-05/DEL-05b/DEL-06）：
//! - **禁止**主连接裸锁双轨（`self.conn.lock()` + `conn.transaction()` 已废除）；
//!   整场导入统一收敛 [`LocalDb::write_blocking`] 单写 Actor——外层 Actor
//!   `BEGIN IMMEDIATE` 提供事务原子，闭包内严禁再开 `transaction()`；
//! - `session_messages` / `session_agent_messages`：`ON CONFLICT` 增量 Upsert
//!   （冲突以导入载荷覆盖）+ 条件尾部收缩，废除无条件全量 DELETE；
//! - `session_agents`：共用 [`crate::agents::save_session_agents_conn`]
//!   （Upsert + `agent_id NOT IN` 移除差集，ADD-01 同级契约）。

use super::agents::parse_session_agents_safe;
use super::agents::save_session_agents_conn;
use super::messages::parse_session_messages_flexible;
use super::{DbFailure, DbFailureKind, LocalDb};
use conex_types::{ImportStats, SessionIndexEntry};
use std::collections::HashMap;

impl LocalDb {
    /// 从 localStorage 历史数据迁移到 SQLite。
    ///
    /// - `index_json`: `crish_session_index_v1` 的 JSON 数组字符串
    /// - `bodies`: `crish_session_body_v1:<id>` → JSONL 或 JSON 数组字符串
    /// - `agents`: `crish_session_agents_v1:<id>` → JSON 数组字符串
    /// - `active_id`: `crish_active_session_v1` 的值
    /// - `folder_order`: `crish_folder_order_v1` 数组
    ///
    /// body 解析策略：先尝试 `Vec<SessionMessage>` JSON 数组，失败再走 JSONL 行解析。
    /// 整个迁移在单写 Actor 事务（`BEGIN IMMEDIATE`）内完成，任一会话失败则回滚。
    pub fn import_from_localstorage(
        &self,
        index_json: &str,
        bodies: HashMap<String, String>,
        agents: HashMap<String, String>,
        active_id: Option<&str>,
        folder_order: &[String],
    ) -> Result<ImportStats, DbFailure> {
        let entries: Vec<SessionIndexEntry> =
            serde_json::from_str(index_json).map_err(|e| DbFailure {
                message: format!("import_from_localstorage: parse index failed: {e}"),
                kind: DbFailureKind::ImportIndexParse,
            })?;

        let active = active_id.map(str::to_string);
        let folder_order = folder_order.to_vec();

        // 整场导入收敛单写 Actor（闭包仅捕获纯数据，不捕获 self；
        // 外层 Actor 已持 BEGIN IMMEDIATE，闭包内禁开 transaction）
        self.write_blocking(move |conn| {
            let mut stats = ImportStats::default();

            for entry in &entries {
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
                    message: format!("import_upsert_session: {e}"),
                    kind: DbFailureKind::Other("import_from_localstorage".to_string()),
                })?;

                // 迁移 body：增量 Upsert（冲突以导入载荷覆盖）+ 尾部收缩
                // （废除全量 DELETE——毁窗与写放大根除，DEL-05）
                if let Some(body_raw) = bodies.get(&entry.id) {
                    let messages = parse_session_messages_flexible(body_raw);

                    for (seq, msg) in messages.iter().enumerate() {
                        let seq_i64 = seq as i64;
                        conn.execute(
                            "INSERT INTO session_messages (
                                session_id, seq, id, sender, text, thinking, timestamp, status,
                                stream_text_offset, thinking_time, tool_calls_json,
                                blocks_json, tool_call_results_json
                            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                            ON CONFLICT(session_id, seq) DO UPDATE SET
                                id = excluded.id,
                                sender = excluded.sender,
                                text = excluded.text,
                                thinking = excluded.thinking,
                                timestamp = excluded.timestamp,
                                status = excluded.status,
                                stream_text_offset = excluded.stream_text_offset,
                                thinking_time = excluded.thinking_time,
                                tool_calls_json = excluded.tool_calls_json,
                                blocks_json = excluded.blocks_json,
                                tool_call_results_json = excluded.tool_call_results_json",
                            rusqlite::params![
                                entry.id,
                                seq_i64,
                                msg.id,
                                msg.sender,
                                msg.text,
                                msg.thinking,
                                msg.timestamp,
                                msg.status,
                                msg.stream_text_offset,
                                msg.thinking_time,
                                msg.tool_calls_json,
                                msg.blocks_json,
                                msg.tool_call_results_json,
                            ],
                        )
                        .map_err(|e| DbFailure {
                            message: format!("import_upsert_message: {e}"),
                            kind: DbFailureKind::Other("import_from_localstorage".to_string()),
                        })?;
                    }

                    // 条件尾部收缩：载荷条数 < 现存行数时清理多余 seq
                    let new_len = messages.len() as i64;
                    conn.execute(
                        "DELETE FROM session_messages WHERE session_id = ?1 AND seq >= ?2",
                        rusqlite::params![entry.id, new_len],
                    )
                    .map_err(|e| DbFailure {
                        message: format!("import_message_diff_shrink: {e}"),
                        kind: DbFailureKind::Other("import_from_localstorage".to_string()),
                    })?;

                    stats.messages += messages.len() as u64;
                }

                // 迁移 agents：共用 save_session_agents_conn（Upsert + 消息
                // Upsert/尾部收缩 + 移除差集；废除全量 DELETE，DEL-05b/ADD-01）
                if let Some(agents_raw) = agents.get(&entry.id) {
                    let agent_list = parse_session_agents_safe(agents_raw);
                    save_session_agents_conn(conn, &entry.id, &agent_list)?;
                    stats.agents += agent_list.len() as u64;
                }

                stats.sessions += 1;
            }

            // 写入 active_session_id 到 session_meta
            if let Some(active_val) = &active {
                if !active_val.trim().is_empty() {
                    conn.execute(
                        "INSERT INTO session_meta (key, value) VALUES ('active_session_id', ?1)
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                        rusqlite::params![active_val],
                    )
                    .map_err(|e| DbFailure {
                        message: format!("import_set_active: {e}"),
                        kind: DbFailureKind::Other("import_from_localstorage".to_string()),
                    })?;
                }
            }

            // 写入 folder_order 到 session_meta
            if !folder_order.is_empty() {
                let folder_json =
                    serde_json::to_string(&folder_order).map_err(|e| DbFailure {
                        message: format!(
                            "import_from_localstorage: serialize folder_order failed: {e}"
                        ),
                        kind: DbFailureKind::ImportFolderSerialize,
                    })?;
                conn.execute(
                    "INSERT INTO session_meta (key, value) VALUES ('folder_order', ?1)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    rusqlite::params![folder_json],
                )
                .map_err(|e| DbFailure {
                    message: format!("import_set_folder_order: {e}"),
                    kind: DbFailureKind::Other("import_from_localstorage".to_string()),
                })?;
            }

            Ok(stats)
        })
    }
}
