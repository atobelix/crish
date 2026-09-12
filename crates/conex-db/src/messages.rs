//! 消息域：session_messages 表正文的增量 Upsert 保存 / 加载，
//! 以及 localStorage 导入用的宽容解析助手。
//!
//! 写路径契约（03 §2.1 / 裁决 2）：
//! - 基于 PRIMARY KEY (session_id, seq) 的 `ON CONFLICT ... DO UPDATE` 增量 Upsert；
//! - 尾部有界 Diff Shrink（`seq >= messages.len()`）；
//! - `message_count` 绝对赋值为 `messages.len()`（禁单调累加 / 禁 COUNT(*) 唯一路径）；
//! - **禁止**无条件全量 `DELETE FROM session_messages WHERE session_id = ?1` 毁窗。

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

    /// 保存会话正文（增量 Upsert + Diff Shrink，显式 rebase API）。
    ///
    /// 经组提交 Writer 提交（外层 Actor `BEGIN IMMEDIATE` 事务保证原子）。
    /// `message_count` 绝对赋值为 `messages.len()`（v12 后双触发器已 DROP）。
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

    /// 带 CAS 的会话正文保存（D3-4 / DEL-8 → P04 增量 Upsert）。
    ///
    /// - `batch_version = Some(v)`：要求 `sessions.body_version < v` 才写入；
    ///   过期写返回 [`DbFailureKind::CasConflict`]（可识别错误，禁止静默 Ok）。
    /// - `batch_version = None`：显式非 CAS 全量 rebase（导入 / 损坏恢复 / 测试）。
    ///
    /// 写路径经组提交 Writer；闭包内不再开 `transaction()`（外层已 BEGIN IMMEDIATE）。
    /// 闭包仅捕获纯数据参数，禁止捕获 `self`（防 Actor 重入死锁）。
    pub fn save_session_body_versioned(
        &self,
        session_id: &str,
        messages: &[SessionMessage],
        batch_version: Option<i64>,
    ) -> Result<(), DbFailure> {
        let session_id = session_id.to_string();
        let messages = messages.to_vec();
        self.write_blocking(move |conn| {
            save_session_body_conn(conn, &session_id, &messages, batch_version)
        })
    }
}

/// 连接级纯函数：会话正文增量 Upsert + Diff Shrink + 元数据推进。
///
/// 契约（03 §2.1）：
/// 1. 自愈补建会话行（防 FK 失败）；
/// 2. 可选 CAS：`batch_version <= current` → [`DbFailureKind::CasConflict`]；
/// 3. `INSERT ... ON CONFLICT(session_id, seq) DO UPDATE SET` 全字段 Upsert；
/// 4. 尾部有界收缩 `DELETE ... WHERE seq >= messages.len()`（空数组 = 显式清空）；
/// 5. `message_count = messages.len()` 绝对赋值（禁单调累加 / 禁 COUNT(*) 唯一路径）。
///
/// 仅接收 `&mut Connection`，禁止捕获 `LocalDb` / `self`；禁止内部 `conn.transaction()`。
pub fn save_session_body_conn(
    conn: &mut rusqlite::Connection,
    session_id: &str,
    messages: &[SessionMessage],
    batch_version: Option<i64>,
) -> Result<(), DbFailure> {
    // 1. 自愈补建会话行（与 session_commands::self_heal 同源，防 FK 失败）
    conn.execute(
        "INSERT OR IGNORE INTO sessions (id, title, updated_at)
         VALUES (?1, '', strftime('%s','now') * 1000)",
        rusqlite::params![session_id],
    )
    .map_err(|e| DbFailure {
        message: format!("save_session_body_self_heal: {e}"),
        kind: DbFailureKind::Other("save_session_body".to_string()),
    })?;

    // 2. CAS：读当前 body_version，过期批次拒绝
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

    // 3. 增量 Upsert（PRIMARY KEY (session_id, seq)；全字段含 id/sender 等）
    //    旧「全量 DELETE 再循环 INSERT」毁窗路径已物理拔除（裁决 2 / DEL-01）。
    let mut upsert_stmt = conn
        .prepare_cached(
            "INSERT INTO session_messages (
                session_id, seq, id, sender, text, thinking, timestamp, status,
                stream_text_offset, thinking_time, tool_calls_json,
                blocks_json, tool_call_results_json, usage_json
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
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
                tool_call_results_json = excluded.tool_call_results_json,
                usage_json = excluded.usage_json",
        )
        .map_err(|e| DbFailure {
            message: format!("save_session_body_prepare_upsert: {e}"),
            kind: DbFailureKind::Other("save_session_body".to_string()),
        })?;

    for (seq, msg) in messages.iter().enumerate() {
        let seq_i64 = seq as i64;
        upsert_stmt
            .execute(rusqlite::params![
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
            ])
            .map_err(|e| DbFailure {
                message: format!("save_session_body_upsert: {e}"),
                kind: DbFailureKind::Other("save_session_body".to_string()),
            })?;
    }
    // 释放预编译语句，避免占住连接借用（后续 DELETE / UPDATE）
    drop(upsert_stmt);

    // 4. 差异化尾部收缩（Diff Shrink）：?2 = messages.len()；
    //    常规追加匹配 0 行；收缩/清空仅删 seq >= 新长度的越界尾部。
    let new_len = messages.len() as i64;
    conn.execute(
        "DELETE FROM session_messages WHERE session_id = ?1 AND seq >= ?2",
        rusqlite::params![session_id, new_len],
    )
    .map_err(|e| DbFailure {
        message: format!("save_session_body_diff_shrink: {e}"),
        kind: DbFailureKind::Other("save_session_body".to_string()),
    })?;

    // 5. 推进元数据：message_count 绝对赋值 + 可选 body_version
    //    （禁止 COUNT(*) 批末重算作为唯一路径——收缩/清空场景下绝对赋值即真理）
    if let Some(batch_version) = batch_version {
        conn.execute(
            "UPDATE sessions SET message_count = ?2, body_version = ?3 WHERE id = ?1",
            rusqlite::params![session_id, new_len, batch_version],
        )
    } else {
        conn.execute(
            "UPDATE sessions SET message_count = ?2 WHERE id = ?1",
            rusqlite::params![session_id, new_len],
        )
    }
    .map_err(|e| DbFailure {
        message: format!("save_session_body_update_meta: {e}"),
        kind: DbFailureKind::Other("save_session_body".to_string()),
    })?;

    Ok(())
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
