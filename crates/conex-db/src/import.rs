//! localStorage 导入域：一次性迁移 `crish_session_index_v1` / body / agents /
//! active / folder_order 到 SQLite（T08.10 语义），单事务原子。

use super::agents::parse_session_agents_safe;
use super::messages::parse_session_messages_flexible;
use super::{DbFailure, DbFailureKind, LocalDb};
use conex_types::{ImportStats, SessionAgent, SessionIndexEntry};
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
    /// 整个迁移在单事务内完成，任一会话失败则回滚。
    pub fn import_from_localstorage(
        &self,
        index_json: &str,
        bodies: HashMap<String, String>,
        agents: HashMap<String, String>,
        active_id: Option<&str>,
        folder_order: &[String],
    ) -> Result<ImportStats, DbFailure> {
        let entries: Vec<SessionIndexEntry> = serde_json::from_str(index_json).map_err(|e| {
            DbFailure {
                message: format!("import_from_localstorage: parse index failed: {e}"),
                kind: DbFailureKind::ImportIndexParse,
            }
        })?;

        let mut conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        let tx = conn
            .transaction()
            .map_err(|e| self.latch_error("import_tx", e))?;

        let mut stats = ImportStats::default();

        for entry in &entries {
            let is_pinned: i64 = entry.is_pinned.into();
            let is_archived: i64 = entry.is_archived.into();
            let hydrated: Option<i64> = entry.hydrated_from_engine.map(|b| b.into());

            tx.execute(
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
            .map_err(|e| self.latch_error("import_upsert_session", e))?;

            // 迁移 body
            if let Some(body_raw) = bodies.get(&entry.id) {
                let messages = parse_session_messages_flexible(body_raw);
                // 先清空已有消息（避免重复导入导致 UNIQUE 冲突）
                tx.execute(
                    "DELETE FROM session_messages WHERE session_id = ?1",
                    rusqlite::params![entry.id],
                )
                .map_err(|e| self.latch_error("import_delete_messages", e))?;

                for (seq, msg) in messages.iter().enumerate() {
                    let seq_i64 = seq as i64;
                    tx.execute(
                        "INSERT INTO session_messages (
                            session_id, seq, id, sender, text, thinking, timestamp, status,
                            stream_text_offset, thinking_time, tool_calls_json,
                            blocks_json, tool_call_results_json
                        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
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
                    .map_err(|e| self.latch_error("import_insert_message", e))?;
                }
                stats.messages += messages.len() as u64;
            }

            // 迁移 agents
            if let Some(agents_raw) = agents.get(&entry.id) {
                let agent_list: Vec<SessionAgent> = parse_session_agents_safe(agents_raw);
                tx.execute(
                    "DELETE FROM session_agents WHERE session_id = ?1",
                    rusqlite::params![entry.id],
                )
                .map_err(|e| self.latch_error("import_delete_agents", e))?;

                for agent in &agent_list {
                    tx.execute(
                        "INSERT INTO session_agents (
                            session_id, agent_id, subagent_run_id, parent_session_id, parent_run_id,
                            parent_tool_call_id, description, mode, status, summary,
                            started_at, ended_at, depth, subagent_path_json
                        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                        rusqlite::params![
                            entry.id,
                            agent.id,
                            agent.subagent_run_id,
                            agent.parent_session_id,
                            agent.parent_run_id,
                            agent.parent_tool_call_id,
                            agent.description,
                            agent.mode,
                            agent.status,
                            agent.summary,
                            agent.started_at,
                            agent.ended_at,
                            agent.depth,
                            agent.subagent_path_json,
                        ],
                    )
                    .map_err(|e| self.latch_error("import_insert_agent", e))?;

                    for (seq, msg) in agent.messages.iter().enumerate() {
                        let seq_i64 = seq as i64;
                        tx.execute(
                            "INSERT INTO session_agent_messages (
                                session_id, agent_id, seq, id, sender, text, thinking, timestamp, status,
                                stream_text_offset, thinking_time, tool_calls_json,
                                blocks_json, tool_call_results_json
                            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                            rusqlite::params![
                                entry.id,
                                agent.id,
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
                        .map_err(|e| self.latch_error("import_insert_agent_message", e))?;
                    }
                }
                stats.agents += agent_list.len() as u64;
            }

            stats.sessions += 1;
        }

        // 写入 active_session_id 到 session_meta
        if let Some(active) = active_id {
            if !active.trim().is_empty() {
                tx.execute(
                    "INSERT INTO session_meta (key, value) VALUES ('active_session_id', ?1)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    rusqlite::params![active],
                )
                .map_err(|e| self.latch_error("import_set_active", e))?;
            }
        }

        // 写入 folder_order 到 session_meta
        if !folder_order.is_empty() {
            let folder_json = serde_json::to_string(folder_order).map_err(|e| DbFailure {
                message: format!("import_from_localstorage: serialize folder_order failed: {e}"),
                kind: DbFailureKind::ImportFolderSerialize,
            })?;
            tx.execute(
                "INSERT INTO session_meta (key, value) VALUES ('folder_order', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                rusqlite::params![folder_json],
            )
            .map_err(|e| self.latch_error("import_set_folder_order", e))?;
        }

        tx.commit()
            .map_err(|e| self.latch_error("import_commit", e))?;

        Ok(stats)
    }
}
