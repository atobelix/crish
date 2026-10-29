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
use rusqlite::OptionalExtension;

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

    /// 保存会话正文（增量 Upsert + 显式全量替换，权威写入 API）。
    ///
    /// 经组提交 Writer 提交（外层 Actor `BEGIN IMMEDIATE` 事务保证原子）。
    /// `message_count` 取库内实际行数（v12 后双触发器已 DROP）。
    /// 本 API 表示「调用方持有完整正文」：允许 Diff Shrink（撤回/清空/恢复自愈）。
    /// 局部快照/进程首批 rebase 必须走 [Self::save_session_body_versioned]
    /// 的 `None` 分支——该分支不缩容，避免按短载荷删掉库内历史。
    pub fn save_session_body(
        &self,
        session_id: &str,
        messages: &[SessionMessage],
    ) -> Result<(), DbFailure> {
        self.save_session_body_inner(session_id, messages, None, true)
    }

    /// 带 CAS 的会话正文保存（D3-4 / DEL-8 → P04 增量 Upsert）。
    ///
    /// - `batch_version = Some(v)`：要求 `sessions.body_version < v` 才写入；
    ///   过期写返回 [`DbFailureKind::CasConflict`]（可识别错误，禁止静默 Ok）。
    ///   该分支允许 Diff Shrink（版本递增即调用方确认了更短的权威正文）。
    /// - `batch_version = None`：显式非 CAS rebase（导入 / 损坏恢复 /
    ///   **进程首批**）；该分支只做 Upsert 合并，**不删除**库内现有尾部——
    ///   载荷可能只是局部快照。随后把 `sessions.body_version` **归零**作为
    ///   「新纪元」标记，使前端随后递传的 `Some(1..n)` 与库中序列连续
    ///   （详见 [save_session_body_conn] 第 5 步的归零说明）。
    ///
    /// 写路径经组提交 Writer；闭包内不再开 `transaction()`（外层已 BEGIN IMMEDIATE）。
    /// 闭包仅捕获纯数据参数，禁止捕获 `self`（防 Actor 重入死锁）。
    pub fn save_session_body_versioned(
        &self,
        session_id: &str,
        messages: &[SessionMessage],
        batch_version: Option<i64>,
    ) -> Result<(), DbFailure> {
        self.save_session_body_inner(session_id, messages, batch_version, batch_version.is_some())
    }

    fn save_session_body_inner(
        &self,
        session_id: &str,
        messages: &[SessionMessage],
        batch_version: Option<i64>,
        allow_shrink: bool,
    ) -> Result<(), DbFailure> {
        let session_id = session_id.to_string();
        let messages = messages.to_vec();
        self.write_blocking(move |conn| {
            save_session_body_conn(conn, &session_id, &messages, batch_version, allow_shrink)
        })
    }

    /// 时间线撤回物理截断：
    /// 1. 按 target_message_id 在 session_messages 表精确定位其行序号 seq；
    /// 2. 物理删除 seq > target_seq 的所有后续消息行；
    /// 3. 原子重算 message_count 并自增 body_version（更新 updated_at）；
    ///
    /// 彻底根除应用重启或水合后被撤回消息死灰复燃。
    pub fn truncate_session_messages_after(
        &self,
        session_id: &str,
        target_message_id: &str,
    ) -> Result<usize, DbFailure> {
        let session_id = session_id.to_string();
        let target_message_id = target_message_id.to_string();
        self.write_blocking(move |conn| {
            truncate_session_messages_after_conn(conn, &session_id, &target_message_id)
        })
    }

    /// 按指定序号物理截断 target_seq 之后的所有消息行（若已知 target_seq）
    pub fn truncate_session_messages_after_seq(
        &self,
        session_id: &str,
        target_seq: i64,
    ) -> Result<usize, DbFailure> {
        let session_id = session_id.to_string();
        self.write_blocking(move |conn| {
            truncate_session_messages_after_seq_conn(conn, &session_id, target_seq)
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
fn save_session_body_conn(
    conn: &mut rusqlite::Connection,
    session_id: &str,
    messages: &[SessionMessage],
    batch_version: Option<i64>,
    allow_shrink: bool,
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
    } else if messages.is_empty() {
        // 防未水合空壳误删物理守卫（Task-2 / RC-01 / 根因链一）：
        // 当传入 messages.is_empty() 且 batch_version.is_none()（即无版本号 CAS 的盲写，如前端启动批量同步未水合空壳）时：
        // 查询该 session_id 在 session_messages 表中是否已有记录（existing_count > 0），
        // 或者在 events 表中是否存在 message-start / message-end 对话事件记录。
        // 如果存在已有消息或历史对话事件，拒绝执行清空删除（直接返回 Ok(())，拦截 DELETE FROM session_messages 与元数据清零）！
        let existing_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM session_messages WHERE session_id = ?1",
                rusqlite::params![session_id],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let has_events: bool = if existing_count > 0 {
            true
        } else {
            conn.query_row(
                "SELECT 1 FROM events WHERE session_id = ?1 AND event_type IN ('message-start', 'message-end') LIMIT 1",
                rusqlite::params![session_id],
                |_| Ok(true),
            )
            .unwrap_or(false)
        };

        if existing_count > 0 || has_events {
            // 物理拦截：存在历史消息或历史事件，拒绝无 CAS 的空数组删库
            return Ok(());
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

    // 4. 差异化尾部收缩（Diff Shrink）：仅权威全量正文允许缩容
    //    （CAS 成功批次 = 前端确认的更高版本；save_session_body = 显式替换）。
    //    非 CAS rebase 载荷可能只是局部快照，按长度删尾会物理抹掉库内历史。
    if allow_shrink {
        let new_len = messages.len() as i64;
        conn.execute(
            "DELETE FROM session_messages WHERE session_id = ?1 AND seq >= ?2",
            rusqlite::params![session_id, new_len],
        )
        .map_err(|e| DbFailure {
            message: format!("save_session_body_diff_shrink: {e}"),
            kind: DbFailureKind::Other("save_session_body".to_string()),
        })?;
    }

    // 5. 推进元数据：message_count 取库内实际行数（CAS 缩容后与载荷等长；
    //    非 CAS 分支保留的既有尾部也必须计数，禁止用载荷长度直接覆盖）。
    let stored_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_messages WHERE session_id = ?1",
            rusqlite::params![session_id],
            |row| row.get(0),
        )
        .map_err(|e| DbFailure {
            message: format!("save_session_body_count: {e}"),
            kind: DbFailureKind::Other("save_session_body".to_string()),
        })?;
    if let Some(batch_version) = batch_version {
        conn.execute(
            "UPDATE sessions SET message_count = ?2, body_version = ?3 WHERE id = ?1",
            rusqlite::params![session_id, stored_count, batch_version],
        )
    } else {
        // 显式非 CAS rebase（导入 / 恢复 / 自愈 / **进程首批**）：更新
        // message_count，并把 `body_version` **归零**——标记「新纪元开始」。
        //
        // 为什么必须归零（实证 2026-09-15）：前端的批次计数器是**模块级内存
        // 变量**，每次进程启动从 0 开始；若沿用旧纪元版本（数十），首批 rebase
        // 之后前端传 `Some(1)` 仍会命中 `1 <= 数十` 而 CasConflict ⇒ 65 个会话
        // 的正文全部写不进 SQLite、整批降级 LS。归零后 `Some(1..n)` 与库中
        // `0..n-1` 连续，CAS 的「后发起 = 高版本」防线在**进程内**完整保留
        // （跨进程时旧批次随进程结束，无并发可防，归零不削弱防线）。
        conn.execute(
            "UPDATE sessions SET message_count = ?2, body_version = 0 WHERE id = ?1",
            rusqlite::params![session_id, stored_count],
        )
    }
    .map_err(|e| DbFailure {
        message: format!("save_session_body_update_meta: {e}"),
        kind: DbFailureKind::Other("save_session_body".to_string()),
    })?;

    Ok(())
}

/// 连接级纯函数：撤回物理截断——按 target_message_id 截断其后所有的 session_messages 行
pub fn truncate_session_messages_after_conn(
    conn: &mut rusqlite::Connection,
    session_id: &str,
    target_message_id: &str,
) -> Result<usize, DbFailure> {
    // 1. 获取目标消息在 session_messages 表中的行序号 seq
    let target_seq: Option<i64> = conn
        .query_row(
            "SELECT seq FROM session_messages WHERE session_id = ?1 AND id = ?2 ORDER BY seq DESC LIMIT 1",
            rusqlite::params![session_id, target_message_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| DbFailure {
            message: format!("truncate_session_messages_after query seq: {e}"),
            kind: DbFailureKind::Other("truncate_session_messages_after".to_string()),
        })?;

    let Some(target_seq) = target_seq else {
        // 若该会话在 session_messages 表中没有任何消息（如空会话或尚未落库），直接安全返回 Ok(0)
        let existing_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM session_messages WHERE session_id = ?1",
                rusqlite::params![session_id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if existing_count == 0 {
            return Ok(0);
        }
        return Err(DbFailure {
            message: format!(
                "目标消息 {target_message_id} 在会话 {session_id} 的 session_messages 中不存在"
            ),
            kind: DbFailureKind::Other("truncate_target_not_found".to_string()),
        });
    };

    truncate_session_messages_after_seq_conn(conn, session_id, target_seq)
}

/// 连接级纯函数：物理删除 target_seq 之后的所有消息，原子重算 message_count 并自增 body_version
pub fn truncate_session_messages_after_seq_conn(
    conn: &mut rusqlite::Connection,
    session_id: &str,
    target_seq: i64,
) -> Result<usize, DbFailure> {
    // 自愈补建会话行（防 sessions 行缺失）
    conn.execute(
        "INSERT OR IGNORE INTO sessions (id, title, updated_at)
         VALUES (?1, '', strftime('%s','now') * 1000)",
        rusqlite::params![session_id],
    )
    .map_err(|e| DbFailure {
        message: format!("truncate_session_messages self_heal: {e}"),
        kind: DbFailureKind::Other("truncate_session_messages_after".to_string()),
    })?;

    // 1. 物理删除目标序号之后的所有消息行
    let deleted = conn
        .execute(
            "DELETE FROM session_messages WHERE session_id = ?1 AND seq > ?2",
            rusqlite::params![session_id, target_seq],
        )
        .map_err(|e| DbFailure {
            message: format!("truncate_session_messages delete: {e}"),
            kind: DbFailureKind::Other("truncate_session_messages_after".to_string()),
        })?;

    // 2. 原子重算 sessions 表的 message_count，自增 body_version，更新 updated_at
    conn.execute(
        "UPDATE sessions
         SET message_count = (SELECT COUNT(*) FROM session_messages WHERE session_id = ?1),
             body_version = COALESCE(body_version, 0) + 1,
             updated_at = strftime('%s','now') * 1000
         WHERE id = ?1",
        rusqlite::params![session_id],
    )
    .map_err(|e| DbFailure {
        message: format!("truncate_session_messages update meta: {e}"),
        kind: DbFailureKind::Other("truncate_session_messages_after".to_string()),
    })?;

    Ok(deleted)
}

/// 灵活解析会话消息：先尝试 JSON 数组，失败再走 JSONL 行解析。
///
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
