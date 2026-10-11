//! 事件域：events 表追加 / 查询（含 StoredEvent 记录行），以及会话级
//! sequence 原子取号（session_sequence，T08.12）。

use super::{DbFailure, DbFailureKind, LocalDb};

impl LocalDb {
    /// Append an event to a session.
    ///
    /// `run_id` 为 run 归属（列级权威；None = 会话域事件，如空闲态事件）。
    /// `created_at` 由 INSERT 显式写毫秒精度时间戳（`%Y-%m-%d %H:%M:%S.%f`，
    /// R-08/G-06），不再依赖列 DEFAULT `datetime('now')`（秒级）；存量行
    /// 不回写，DEFAULT 仅作兜底。
    pub fn append_event(
        &self,
        session_id: &str,
        sequence: i64,
        event_type: &str,
        payload: &str,
        run_id: Option<&str>,
    ) -> Result<(), DbFailure> {
        let session_id = session_id.to_string();
        let event_type = event_type.to_string();
        let payload = payload.to_string();
        let run_id = run_id.map(|s| s.to_string());
        self.write_blocking(move |conn| {
            append_event_conn(
                conn,
                &session_id,
                sequence,
                &event_type,
                &payload,
                run_id.as_deref(),
            )
        })
    }

    /// 持久化一轮 recovery escalation：首事件、通知元数据、次事件共用
    /// 一个 Single Writer 请求与一个 SQLite 事务。两个事件均为会话级事件
    /// （`run_id = NULL`），sequence 在同一事务中连续分配。
    ///
    /// 参数顺序对应旧行为：recovery-escalated → recover_notifications
    /// upsert → recovery-steering。任一步失败均回滚所有行与序号。
    pub fn append_two_events_and_set_session_meta(
        &self,
        session_id: &str,
        first_event: (&str, &str),
        meta: (&str, &str),
        second_event: (&str, &str),
    ) -> Result<[i64; 2], DbFailure> {
        let session_id = session_id.to_string();
        let (first_type, first_payload) = (first_event.0.to_string(), first_event.1.to_string());
        let (meta_key, meta_value) = (meta.0.to_string(), meta.1.to_string());
        let (second_type, second_payload) =
            (second_event.0.to_string(), second_event.1.to_string());

        self.write_blocking(move |conn| {
            let first_sequence = reserve_sequence_conn(conn, &session_id)?;
            append_event_conn(
                conn,
                &session_id,
                first_sequence,
                &first_type,
                &first_payload,
                None,
            )?;

            conn.execute(
                "INSERT INTO session_meta (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                rusqlite::params![meta_key, meta_value],
            )
            .map_err(|e| DbFailure {
                message: format!("append_two_events_set_meta: {e}"),
                kind: DbFailureKind::Other("append_two_events_set_meta".to_string()),
            })?;

            let second_sequence = reserve_sequence_conn(conn, &session_id)?;
            append_event_conn(
                conn,
                &session_id,
                second_sequence,
                &second_type,
                &second_payload,
                None,
            )?;

            Ok([first_sequence, second_sequence])
        })
    }

    /// Query events for a session after a given sequence number.
    ///
    /// `limit` 限制返回条数（修复无界查询性能问题，对齐 Stream B 6.3）。
    /// 传 `None` 等价于无限制（兼容旧行为），但推荐显式传 `Some(n)`。
    ///
    /// 读路径经 [`LocalDb::read`]（ReaderPool 8 槽位，无池回退主连接）；
    /// 闭包内刚性 `.collect()` 物化，游标在闭包返回前即刻释放——杜绝
    /// Oldest Active Read Mark 把持 WAL 导致 Checkpoint 饥饿（03 详案 §4.1）。
    pub fn query_events(
        &self,
        session_id: &str,
        after_sequence: i64,
        limit: Option<i64>,
    ) -> Result<Vec<StoredEvent>, DbFailure> {
        let sid = session_id.to_string();
        let limit_value = limit.unwrap_or(i64::MAX);
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT session_id, sequence, event_type, payload, run_id, created_at
                     FROM events WHERE session_id = ?1 AND sequence > ?2
                     ORDER BY sequence ASC LIMIT ?3",
                )
                .map_err(|e| self.latch_error("query_events_prepare", e))?;

            let events = stmt
                .query_map(rusqlite::params![sid, after_sequence, limit_value], |row| {
                    Ok(StoredEvent {
                        session_id: row.get(0)?,
                        sequence: row.get(1)?,
                        event_type: row.get(2)?,
                        payload: row.get(3)?,
                        run_id: row.get(4)?,
                        created_at: row.get(5)?,
                    })
                })
                .map_err(|e| self.latch_error("query_events_map", e))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| self.latch_error("query_events_collect", e))?;
            drop(stmt);
            Ok(events)
        })
    }

    /// 按 run 归属过滤查询会话内事件（SQL 下推，走 idx_events_run 索引）：
    /// `WHERE session_id = ?1 AND run_id = ?2 AND sequence > ?3 ORDER BY
    /// sequence ASC LIMIT ?4`——after 开区间（> after），limit 直下推。
    ///
    /// run_id 为 NULL 的行（会话域事件）恒不命中本查询（SQL NULL 比较
    /// 语义）；按会话全量读取请用 [Self::query_events]。
    /// 读路径经 ReaderPool，闭包内 `.collect()` 物化即时释放游标。
    pub fn query_events_by_run(
        &self,
        session_id: &str,
        run_id: &str,
        after_sequence: i64,
        limit: Option<i64>,
    ) -> Result<Vec<StoredEvent>, DbFailure> {
        let sid = session_id.to_string();
        let rid = run_id.to_string();
        let limit_value = limit.unwrap_or(i64::MAX);
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT session_id, sequence, event_type, payload, run_id, created_at
                     FROM events WHERE session_id = ?1 AND run_id = ?2 AND sequence > ?3
                     ORDER BY sequence ASC LIMIT ?4",
                )
                .map_err(|e| self.latch_error("query_events_by_run_prepare", e))?;

            let events = stmt
                .query_map(
                    rusqlite::params![sid, rid, after_sequence, limit_value],
                    |row| {
                        Ok(StoredEvent {
                            session_id: row.get(0)?,
                            sequence: row.get(1)?,
                            event_type: row.get(2)?,
                            payload: row.get(3)?,
                            run_id: row.get(4)?,
                            created_at: row.get(5)?,
                        })
                    },
                )
                .map_err(|e| self.latch_error("query_events_by_run_map", e))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| self.latch_error("query_events_by_run_collect", e))?;
            drop(stmt);
            Ok(events)
        })
    }

    /// 会话内最大已落库 sequence（1C-1：恢复路径 SQL MAX 下推，避免全量
    /// 加载事件再内存 `iter().max()`）。返回 0 表示该会话无事件。
    ///
    /// SQL 为 `SELECT COALESCE(MAX(sequence), 0) FROM events WHERE
    /// session_id = ?1`——与 [Self::reserve_sequence] 的隐式预热口径一致
    ///（取号路径的 `COALESCE(MAX(sequence),0)+1` 同源）。
    /// 读路径经 ReaderPool，不阻塞写入 Actor。
    pub fn max_sequence(&self, session_id: &str) -> Result<i64, DbFailure> {
        let sid = session_id.to_string();
        self.read(move |conn| {
            conn.query_row(
                "SELECT COALESCE(MAX(sequence), 0) FROM events WHERE session_id = ?1",
                rusqlite::params![sid],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|e| self.latch_error("max_sequence", e))
        })
    }

    /// 按 run 归属 + event_type 过滤查询会话内事件（1C-2：SQL 下推
    /// event_type 过滤，替代 `query_events_by_run` 全量返回后内存
    /// `find`）。SQL 为 `WHERE session_id = ?1 AND run_id = ?2 AND
    /// sequence > ?3 AND event_type = ?4 ORDER BY sequence ASC LIMIT ?5`。
    ///
    /// `after_sequence` 开区间（> after）；`limit` 直下推；run_id 为 NULL
    /// 的会话域事件恒不命中（SQL NULL 比较语义）。
    /// 读路径经 ReaderPool，闭包内 `.collect()` 物化即时释放游标。
    pub fn query_events_by_type(
        &self,
        session_id: &str,
        run_id: &str,
        event_type: &str,
        after_sequence: i64,
        limit: Option<i64>,
    ) -> Result<Vec<StoredEvent>, DbFailure> {
        let sid = session_id.to_string();
        let rid = run_id.to_string();
        let etype = event_type.to_string();
        let limit_value = limit.unwrap_or(i64::MAX);
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT session_id, sequence, event_type, payload, run_id, created_at
                     FROM events WHERE session_id = ?1 AND run_id = ?2 AND sequence > ?3
                     AND event_type = ?4
                     ORDER BY sequence ASC LIMIT ?5",
                )
                .map_err(|e| self.latch_error("query_events_by_type_prepare", e))?;

            let events = stmt
                .query_map(
                    rusqlite::params![sid, rid, after_sequence, etype, limit_value],
                    |row| {
                        Ok(StoredEvent {
                            session_id: row.get(0)?,
                            sequence: row.get(1)?,
                            event_type: row.get(2)?,
                            payload: row.get(3)?,
                            run_id: row.get(4)?,
                            created_at: row.get(5)?,
                        })
                    },
                )
                .map_err(|e| self.latch_error("query_events_by_type_map", e))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| self.latch_error("query_events_by_type_collect", e))?;
            drop(stmt);
            Ok(events)
        })
    }

    /// 会话级序列号原子取号（T08.12 Q23 + D3-2 热路径单语句）。
    ///
    /// 热路径：`UPDATE … SET next_sequence = next_sequence + 1 … RETURNING next_sequence - 1`
    /// （SQLite 3.35+ RETURNING，bundled libsqlite3-sys 0.28 满足）。
    /// 冷路径 seed（首次 INSERT OR IGNORE）与热路径同批经组提交 Writer 提交——
    /// 整个取号闭包在 Actor 的 `BEGIN IMMEDIATE` 事务内，原子性由外层事务保证。
    pub fn reserve_sequence(&self, session_id: &str) -> Result<i64, DbFailure> {
        let session_id = session_id.to_string();
        self.write_blocking(move |conn| reserve_sequence_conn(conn, &session_id))
    }

    /// 会话级序列号预热校准（MAX 语义：只抬高不回退，幂等；
    /// seed(n) 后下次取号返回 n）。经组提交 Writer 提交。
    pub fn seed_sequence(&self, session_id: &str, next_sequence: i64) -> Result<(), DbFailure> {
        let session_id = session_id.to_string();
        self.write_blocking(move |conn| {
            conn.execute(
                "INSERT OR IGNORE INTO session_sequence (session_id, next_sequence) VALUES (?1, 1)",
                rusqlite::params![session_id],
            )
            .map_err(|e| DbFailure {
                message: format!("seed_sequence_seed: {e}"),
                kind: DbFailureKind::Other("seed_sequence".to_string()),
            })?;
            conn.execute(
                "UPDATE session_sequence
                 SET next_sequence = MAX(next_sequence, ?2)
                 WHERE session_id = ?1",
                rusqlite::params![session_id, next_sequence],
            )
            .map_err(|e| DbFailure {
                message: format!("seed_sequence_set: {e}"),
                kind: DbFailureKind::Other("seed_sequence".to_string()),
            })?;
            Ok(())
        })
    }
}

fn append_event_conn(
    conn: &rusqlite::Connection,
    session_id: &str,
    sequence: i64,
    event_type: &str,
    payload: &str,
    run_id: Option<&str>,
) -> Result<(), DbFailure> {
    conn.execute(
        "INSERT INTO events (session_id, sequence, event_type, payload, run_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, strftime('%Y-%m-%d %H:%M:%f','now'))",
        rusqlite::params![session_id, sequence, event_type, payload, run_id],
    )
    .map_err(|e| DbFailure {
        message: format!("append_event: {e}"),
        kind: DbFailureKind::Other("append_event".to_string()),
    })?;
    Ok(())
}

fn reserve_sequence_conn(conn: &rusqlite::Connection, session_id: &str) -> Result<i64, DbFailure> {
    // 冷路径 seed：首次以已落库 max(sequence)+1 建行（隐式预热）
    conn.execute(
        "INSERT OR IGNORE INTO session_sequence (session_id, next_sequence)
         SELECT ?1, COALESCE((SELECT MAX(sequence) FROM events WHERE session_id = ?1), 0) + 1",
        rusqlite::params![session_id],
    )
    .map_err(|e| DbFailure {
        message: format!("reserve_sequence_seed: {e}"),
        kind: DbFailureKind::Other("reserve_sequence".to_string()),
    })?;
    // 热路径单语句：自增并返回自增前的待发号
    conn.query_row(
        "UPDATE session_sequence SET next_sequence = next_sequence + 1
         WHERE session_id = ?1
         RETURNING next_sequence - 1",
        rusqlite::params![session_id],
        |row| row.get::<_, i64>(0),
    )
    .map_err(|e| DbFailure {
        message: format!("reserve_sequence_bump: {e}"),
        kind: DbFailureKind::Other("reserve_sequence".to_string()),
    })
}

#[derive(Debug, Clone)]
pub struct StoredEvent {
    pub session_id: String,
    pub sequence: i64,
    pub event_type: String,
    pub payload: String,
    /// run 归属（列级权威；None = 会话域事件或存量未归属行）
    pub run_id: Option<String>,
    pub created_at: String,
}
