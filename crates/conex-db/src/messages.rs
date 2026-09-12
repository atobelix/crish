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

    /// 全量保存会话正文（先删后插，事务原子）。
    /// 触发器自动维护 `message_count`。
    pub fn save_session_body(
        &self,
        session_id: &str,
        messages: &[SessionMessage],
    ) -> Result<(), DbFailure> {
        let mut conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        let tx = conn
            .transaction()
            .map_err(|e| self.latch_error("save_session_body_tx", e))?;

        tx.execute(
            "DELETE FROM session_messages WHERE session_id = ?1",
            rusqlite::params![session_id],
        )
        .map_err(|e| self.latch_error("save_session_body_delete", e))?;

        for (seq, msg) in messages.iter().enumerate() {
            let seq_i64 = seq as i64;
            tx.execute(
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
            .map_err(|e| self.latch_error("save_session_body_insert", e))?;
        }

        tx.commit()
            .map_err(|e| self.latch_error("save_session_body_commit", e))?;

        Ok(())
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
