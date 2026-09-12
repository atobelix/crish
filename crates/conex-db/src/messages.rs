//! 消息域：session_messages 表正文的全量保存 / 加载，
//! 以及 localStorage 导入用的宽容解析助手。

use super::{DbFailure, DbFailureKind, LocalDb};
use conex_types::SessionMessage;

impl LocalDb {
    /// 加载会话正文消息（按 seq 升序）。
    /// 读路径经 [`LocalDb::read`]：优先 ReaderPool 并发读，无池时回退主连接。
    pub fn load_session_body(&self, session_id: &str) -> Result<Vec<SessionMessage>, DbFailure> {
        self.read(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, sender, text, thinking, timestamp, status,
                            stream_text_offset, thinking_time, tool_calls_json,
                            blocks_json, tool_call_results_json, usage_json
                     FROM session_messages
                     WHERE session_id = ?1
                     ORDER BY seq ASC",
                )
                .map_err(|e| self.latch_error("load_session_body_prepare", e))?;

            let messages = stmt
                .query_map(rusqlite::params![session_id], |row| {
                    Ok(SessionMessage {
                        id: row.get(0)?,
                        sender: row.get(1)?,
                        text: row.get(2)?,
                        thinking: row.get(3)?,
                        timestamp: row.get(4)?,
                        status: row.get(5)?,
                        stream_text_offset: row.get(6)?,
                        thinking_time: row.get(7)?,
                        tool_calls_json: row.get(8)?,
                        blocks_json: row.get(9)?,
                        tool_call_results_json: row.get(10)?,
                        usage: row.get(11)?,
                    })
                })
                .map_err(|e| self.latch_error("load_session_body_map", e))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| self.latch_error("load_session_body_collect", e))?;

            Ok(messages)
        })
    }

    /// 全量保存会话正文（显式 rebase API：先删后插）。
    ///
    /// 经组提交 Writer 提交（外层 Actor `BEGIN IMMEDIATE` 事务保证原子）。
    /// 批末单次重算 `message_count`（v12 后双触发器已 DROP，不再依赖触发器双轨）。
    /// 兼容旧调用：不传 `batch_version` 时跳过 CAS（见
    /// [Self::save_session_body_versioned] 的「禁止静默当 CAS 通过」——
    /// 缺参路径显式文档化为非 CAS 全量 rebase，导入/恢复/自愈用）。
    pub fn save_session_body(
        &self,
        session_id: &str,
        messages: &[SessionMessage],
    ) -> Result<(), DbFailure> {
        self.save_session_body_versioned(session_id, messages, None)
    }

    /// 带 CAS 的会话正文保存（D3-4 / DEL-8）。
    ///
    /// - `batch_version = Some(v)`：要求 `sessions.body_version < v` 才写入；
    ///   过期写返回 [`DbFailureKind::CasConflict`]（可识别错误，禁止静默 Ok）。
    /// - `batch_version = None`：显式非 CAS 全量 rebase（导入 / 损坏恢复 / 测试）。
    ///
    /// 写路径经组提交 Writer；闭包内不再开 `transaction()`（外层已 BEGIN IMMEDIATE）。
    pub fn save_session_body_versioned(
        &self,
        session_id: &str,
        messages: &[SessionMessage],
        batch_version: Option<i64>,
    ) -> Result<(), DbFailure> {
        let session_id = session_id.to_string();
        let messages = messages.to_vec();
        self.write_blocking(move |conn| {
            // 自愈补建会话行（与 session_commands::self_heal 同源，防 FK 失败）
            conn.execute(
                "INSERT OR IGNORE INTO sessions (id, title, updated_at)
                 VALUES (?1, '', strftime('%s','now') * 1000)",
                rusqlite::params![session_id],
            )
            .map_err(|e| DbFailure {
                message: format!("save_session_body_self_heal: {e}"),
                kind: DbFailureKind::Other("save_session_body".to_string()),
            })?;

            // CAS：读当前 body_version，过期批次拒绝
            if let Some(batch_version) = batch_version {
                let current: i64 = conn
                    .query_row(
                        "SELECT body_version FROM sessions WHERE id = ?1",
                        rusqlite::params![session_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(|e| DbFailure {
                        message: format!("save_session_body_cas_read: {e}"),
                        kind: DbFailureKind::Other("save_session_body".to_string()),
                    })?;
                if batch_version <= current {
                    return Err(DbFailure {
                        message: format!(
                            "CAS conflict: batch_version {batch_version} <= body_version {current}"
                        ),
                        kind: DbFailureKind::CasConflict,
                    });
                }
            }

            conn.execute(
                "DELETE FROM session_messages WHERE session_id = ?1",
                rusqlite::params![session_id],
            )
            .map_err(|e| DbFailure {
                message: format!("save_session_body_delete: {e}"),
                kind: DbFailureKind::Other("save_session_body".to_string()),
            })?;

            for (seq, msg) in messages.iter().enumerate() {
                let seq_i64 = seq as i64;
                conn.execute(
                    "INSERT INTO session_messages (
                        session_id, seq, id, sender, text, thinking, timestamp, status,
                        stream_text_offset, thinking_time, tool_calls_json,
                        blocks_json, tool_call_results_json, usage_json
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                    rusqlite::params![
                        session_id,
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
                        msg.usage,
                    ],
                )
                .map_err(|e| DbFailure {
                    message: format!("save_session_body_insert: {e}"),
                    kind: DbFailureKind::Other("save_session_body".to_string()),
                })?;
            }

            // 批末单次：重算 message_count + 推进 body_version（v12 触发器退役）
            if let Some(batch_version) = batch_version {
                conn.execute(
                    "UPDATE sessions SET
                        message_count = (SELECT COUNT(*) FROM session_messages WHERE session_id = ?1),
                        body_version = ?2
                     WHERE id = ?1",
                    rusqlite::params![session_id, batch_version],
                )
            } else {
                conn.execute(
                    "UPDATE sessions SET
                        message_count = (SELECT COUNT(*) FROM session_messages WHERE session_id = ?1)
                     WHERE id = ?1",
                    rusqlite::params![session_id],
                )
            }
            .map_err(|e| DbFailure {
                message: format!("save_session_body_count: {e}"),
                kind: DbFailureKind::Other("save_session_body".to_string()),
            })?;

            Ok(())
        })
    }
}

/// 灵活解析会话消息：先尝试 JSON 数组，失败再走 JSONL 行解析。
/// 对齐 `sessionLocalStorage.loadSessionBody` 的兼容策略。
pub(crate) fn parse_session_messages_flexible(raw: &str) -> Vec<SessionMessage> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    // 路径 1：JSON 数组
    if trimmed.starts_with('[') {
        if let Ok(msgs) = serde_json::from_str::<Vec<SessionMessage>>(trimmed) {
            return msgs;
        }
    }

    // 路径 2：JSONL（每行一条 JSON）
    let mut out = Vec::new();
    for line in trimmed.split('\n') {
        let line_trimmed = line.trim();
        if line_trimmed.is_empty() {
            continue;
        }
        if let Ok(msg) = serde_json::from_str::<SessionMessage>(line_trimmed) {
            out.push(msg);
        }
    }
    out
}
