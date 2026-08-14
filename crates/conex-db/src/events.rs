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
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        conn.execute(
            "INSERT INTO events (session_id, sequence, event_type, payload, run_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, strftime('%Y-%m-%d %H:%M:%f','now'))",
            rusqlite::params![session_id, sequence, event_type, payload, run_id],
        )
        .map_err(|e| self.latch_error("append_event", e))?;

        Ok(())
    }

    /// Query events for a session after a given sequence number.
    ///
    /// `limit` 限制返回条数（修复无界查询性能问题，对齐 Stream B 6.3）。
    /// 传 `None` 等价于无限制（兼容旧行为），但推荐显式传 `Some(n)`。
    pub fn query_events(
        &self,
        session_id: &str,
        after_sequence: i64,
        limit: Option<i64>,
    ) -> Result<Vec<StoredEvent>, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        let mut stmt = conn
            .prepare(
                "SELECT session_id, sequence, event_type, payload, run_id, created_at
                 FROM events WHERE session_id = ?1 AND sequence > ?2
                 ORDER BY sequence ASC LIMIT ?3",
            )
            .map_err(|e| self.latch_error("query_events_prepare", e))?;

        let limit_value = limit.unwrap_or(i64::MAX);
        let events = stmt
            .query_map(
                rusqlite::params![session_id, after_sequence, limit_value],
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
            .map_err(|e| self.latch_error("query_events_map", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| self.latch_error("query_events_collect", e))?;

        Ok(events)
    }

    /// 按 run 归属过滤查询会话内事件（SQL 下推，走 idx_events_run 索引）：
    /// `WHERE session_id = ?1 AND run_id = ?2 AND sequence > ?3 ORDER BY
    /// sequence ASC LIMIT ?4`——after 开区间（> after），limit 直下推。
    ///
    /// run_id 为 NULL 的行（会话域事件）恒不命中本查询（SQL NULL 比较
    /// 语义）；按会话全量读取请用 [Self::query_events]。
    pub fn query_events_by_run(
        &self,
        session_id: &str,
        run_id: &str,
        after_sequence: i64,
        limit: Option<i64>,
    ) -> Result<Vec<StoredEvent>, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        let mut stmt = conn
            .prepare(
                "SELECT session_id, sequence, event_type, payload, run_id, created_at
                 FROM events WHERE session_id = ?1 AND run_id = ?2 AND sequence > ?3
                 ORDER BY sequence ASC LIMIT ?4",
            )
            .map_err(|e| self.latch_error("query_events_by_run_prepare", e))?;

        let limit_value = limit.unwrap_or(i64::MAX);
        let events = stmt
            .query_map(
                rusqlite::params![session_id, run_id, after_sequence, limit_value],
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

        Ok(events)
    }

    /// 会话级序列号原子取号（T08.12 Q23：store 端自增；首次取号按库内
    /// max(sequence)+1 对齐——首个待发号即 max+1，取号后计数器 +1）。
    pub fn reserve_sequence(&self, session_id: &str) -> Result<i64, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        // 首次：以已落库 max(sequence)+1 建行（隐式预热）——该值即首个待发号
        conn.execute(
            "INSERT OR IGNORE INTO session_sequence (session_id, next_sequence)
             SELECT ?1, COALESCE((SELECT MAX(sequence) FROM events WHERE session_id = ?1), 0) + 1",
            rusqlite::params![session_id],
        )
        .map_err(|e| self.latch_error("reserve_sequence_seed", e))?;
        // 读当前待发号（单连接互斥下「读 + 写」等效单语句原子性）
        let sequence = conn
            .query_row(
                "SELECT next_sequence FROM session_sequence WHERE session_id = ?1",
                rusqlite::params![session_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|e| self.latch_error("reserve_sequence_read", e))?;
        conn.execute(
            "UPDATE session_sequence SET next_sequence = next_sequence + 1
             WHERE session_id = ?1",
            rusqlite::params![session_id],
        )
        .map_err(|e| self.latch_error("reserve_sequence_bump", e))?;
        Ok(sequence)
    }

    /// 会话级序列号预热校准（MAX 语义：只抬高不回退，幂等；
    /// seed(n) 后下次取号返回 n）。
    pub fn seed_sequence(&self, session_id: &str, next_sequence: i64) -> Result<(), DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        conn.execute(
            "INSERT OR IGNORE INTO session_sequence (session_id, next_sequence) VALUES (?1, 1)",
            rusqlite::params![session_id],
        )
        .map_err(|e| self.latch_error("seed_sequence_seed", e))?;
        conn.execute(
            "UPDATE session_sequence
             SET next_sequence = MAX(next_sequence, ?2)
             WHERE session_id = ?1",
            rusqlite::params![session_id, next_sequence],
        )
        .map_err(|e| self.latch_error("seed_sequence_set", e))?;
        Ok(())
    }
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
