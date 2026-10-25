//! run 生命周期域：runs / pending_inputs 表 CRUD，以及 RunStatus / StoredRun /
//! PendingInput 记录类型（orchestrator persist/restore 层消费的最小 API 面）。

use super::{DbFailure, DbFailureKind, LocalDb};
use conex_types::RunCacheStats;
use rusqlite::OptionalExtension;
use std::str::FromStr;

/// run 状态字面量（对齐 restore.rs 快照 / frontend RunStatus 契约）
///
/// 裁决 D3（11-T1）：新增 [Unknown] 变体透传未知字面量，放弃 `Copy`
/// 派生（Unknown 携带 String）。透传语义——读边界（DB 行 / 快照）对
/// 未知字面量保真保留，不静默改写为 failed；写边界保持严格（FromStr
/// 不解析未知，恢复等生产写面不会落未知字面量）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunStatus {
    Queued,
    Initializing,
    Running,
    AwaitingApproval,
    /// 收口中（AgentStop / MaxTurns / GoalComplete 后，finalize 前）
    Completing,
    Cancelling,
    Completed,
    Failed,
    Cancelled,
    /// 未知状态字面量（roundtrip 保真透传；不参与 FromStr 解析——
    /// 写边界保持严格，恢复面语义不动）
    Unknown(String),
}

impl RunStatus {
    /// 状态字面量（runs.status 列存储值；Unknown 透传原始字面量）
    pub fn as_str(&self) -> &str {
        match self {
            RunStatus::Queued => "queued",
            RunStatus::Initializing => "initializing",
            RunStatus::Running => "running",
            RunStatus::AwaitingApproval => "awaiting-approval",
            RunStatus::Completing => "completing",
            RunStatus::Cancelling => "cancelling",
            RunStatus::Completed => "completed",
            RunStatus::Failed => "failed",
            RunStatus::Cancelled => "cancelled",
            RunStatus::Unknown(s) => s,
        }
    }
}

/// RunStatus 字面量解析错误（restore.rs:211 消费 `e.message` 字段）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseRunStatusError {
    pub message: String,
}

impl FromStr for RunStatus {
    type Err = ParseRunStatusError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "queued" => Ok(RunStatus::Queued),
            "initializing" => Ok(RunStatus::Initializing),
            "running" => Ok(RunStatus::Running),
            "awaiting-approval" => Ok(RunStatus::AwaitingApproval),
            "completing" => Ok(RunStatus::Completing),
            "cancelling" => Ok(RunStatus::Cancelling),
            "completed" => Ok(RunStatus::Completed),
            "failed" => Ok(RunStatus::Failed),
            "cancelled" => Ok(RunStatus::Cancelled),
            other => Err(ParseRunStatusError {
                message: format!("unknown run status: {other}"),
            }),
        }
    }
}

impl std::fmt::Display for RunStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// run 记录行（persist.rs `Store::query_runs` 返回）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredRun {
    pub run_id: String,
    pub session_id: String,
    pub status: RunStatus,
    pub end_reason: Option<String>,
    pub cursor: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 待处理输入行（persist.rs `Store::load_pending_inputs` 返回）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingInput {
    pub id: String,
    pub session_id: String,
    pub run_id: Option<String>,
    pub payload: String,
    pub created_at: i64,
}

impl LocalDb {
    /// 插入（或覆盖）一条 run 记录。经组提交 Writer。
    pub fn insert_run(
        &self,
        run_id: &str,
        session_id: &str,
        status: RunStatus,
        end_reason: Option<&str>,
        cursor: i64,
    ) -> Result<(), DbFailure> {
        let run_id = run_id.to_string();
        let session_id = session_id.to_string();
        let status_lit = status.as_str().to_string();
        let end_reason = end_reason.map(|s| s.to_string());
        self.write_blocking(move |conn| {
            let now = now_millis();
            conn.execute(
                "INSERT INTO runs (run_id, session_id, status, end_reason, cursor, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(run_id) DO UPDATE SET
                     session_id = excluded.session_id,
                     status = excluded.status,
                     end_reason = excluded.end_reason,
                     cursor = excluded.cursor,
                     updated_at = excluded.updated_at",
                rusqlite::params![
                    run_id,
                    session_id,
                    status_lit,
                    end_reason,
                    cursor,
                    now,
                    now
                ],
            )
            .map_err(|e| DbFailure {
                message: format!("insert_run: {e}"),
                kind: DbFailureKind::Other("insert_run".to_string()),
            })?;
            Ok(())
        })
    }

    /// 更新 run 状态（end_reason 为 None 时保留旧值；cursor 为 Some 时写入）。经组提交 Writer。
    pub fn update_run_status(
        &self,
        run_id: &str,
        status: RunStatus,
        end_reason: Option<&str>,
        cursor: Option<i64>,
    ) -> Result<(), DbFailure> {
        let run_id = run_id.to_string();
        let status_lit = status.as_str().to_string();
        let end_reason = end_reason.map(|s| s.to_string());
        self.write_blocking(move |conn| {
            conn.execute(
                "UPDATE runs SET
                    status = ?2,
                    end_reason = COALESCE(?3, end_reason),
                    cursor = COALESCE(?4, cursor),
                    updated_at = ?5
                 WHERE run_id = ?1",
                rusqlite::params![run_id, status_lit, end_reason, cursor, now_millis()],
            )
            .map_err(|e| DbFailure {
                message: format!("update_run_status: {e}"),
                kind: DbFailureKind::Other("update_run_status".to_string()),
            })?;
            Ok(())
        })
    }

    /// 按 run_id 读取单条记录（persist.rs 测试用）。
    pub fn get_run(&self, run_id: &str) -> Result<Option<StoredRun>, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        conn.query_row(
            "SELECT run_id, session_id, status, end_reason, cursor, created_at, updated_at
             FROM runs WHERE run_id = ?1",
            rusqlite::params![run_id],
            map_run_row,
        )
        .optional()
        .map_err(|e| self.latch_error("get_run", e))
    }

    /// 保存 run 级 usage/cache 统计（P5 §3.1.4，v5 列）。经组提交 Writer。
    ///
    /// `UPDATE runs SET ...`，缺行静默跳过（不报错）；
    /// hit_ratio / write_ratio 可派生（不落库），warm_until_ms NULL 兼容。
    pub fn save_run_usage(&self, run_id: &str, stats: RunCacheStats) -> Result<(), DbFailure> {
        let run_id = run_id.to_string();
        let prompt = stats.prompt_tokens as i64;
        let completion = stats.completion_tokens as i64;
        let total = stats.total_tokens as i64;
        let cache_read = stats.cache_read_tokens as i64;
        let cache_write = stats.cache_write_tokens as i64;
        let cache_miss = stats.cache_miss_tokens as i64;
        let sample_count = stats.sample_count as i64;
        let missed = stats.missed_tokens as i64;
        let warm_until = stats.warm_until_ms.map(|v| v as i64);
        self.write_blocking(move |conn| {
            conn.execute(
                "UPDATE runs SET
                    prompt_tokens = ?2,
                    completion_tokens = ?3,
                    total_tokens = ?4,
                    cache_read_tokens = ?5,
                    cache_write_tokens = ?6,
                    cache_miss_tokens = ?7,
                    sample_count = ?8,
                    missed_tokens = ?9,
                    warm_until_ms = ?10
                 WHERE run_id = ?1",
                rusqlite::params![
                    run_id,
                    prompt,
                    completion,
                    total,
                    cache_read,
                    cache_write,
                    cache_miss,
                    sample_count,
                    missed,
                    warm_until,
                ],
            )
            .map_err(|e| DbFailure {
                message: format!("save_run_usage: {e}"),
                kind: DbFailureKind::Other("save_run_usage".to_string()),
            })?;
            Ok(())
        })
    }

    /// 读取 run 级 usage/cache 统计（v5 列）。
    ///
    /// 缺行或 `sample_count == 0`（含 v4 迁移后旧行全零）返回 None——
    /// 「无样本 → 前端隐藏而非 0% 误导」语义（P5 §3.1.2）；
    /// hit_ratio / write_ratio 不落库，读回一律 None（由前端按原始计数重算）。
    pub fn get_run_usage(&self, run_id: &str) -> Result<Option<RunCacheStats>, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        // G2 允许理由（clippy::type_complexity）：存储层查询行元组（9 列
        // 计数字段 + 可选时间戳），类型由 SQL 列依赖链自然形成，定义别名
        // 可缓解但改动扩散大、豁免面小。
        #[allow(clippy::type_complexity)]
        let row: Option<(i64, i64, i64, i64, i64, i64, i64, i64, Option<i64>)> = conn
            .query_row(
                "SELECT prompt_tokens, completion_tokens, total_tokens,
                        cache_read_tokens, cache_write_tokens, cache_miss_tokens,
                        sample_count, missed_tokens, warm_until_ms
                 FROM runs WHERE run_id = ?1",
                rusqlite::params![run_id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                        r.get(8)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| self.latch_error("get_run_usage", e))?;
        let Some((
            prompt,
            completion,
            total,
            cache_read,
            cache_write,
            cache_miss,
            sample_count,
            missed,
            warm_until_ms,
        )) = row
        else {
            return Ok(None);
        };
        if sample_count <= 0 {
            // 无真实 usage 样本（含迁移后旧行全零）→ None
            return Ok(None);
        }
        Ok(Some(RunCacheStats {
            prompt_tokens: prompt.max(0) as u64,
            completion_tokens: completion.max(0) as u64,
            total_tokens: total.max(0) as u64,
            cache_read_tokens: cache_read.max(0) as u64,
            cache_write_tokens: cache_write.max(0) as u64,
            cache_miss_tokens: cache_miss.max(0) as u64,
            sample_count: sample_count.max(0) as u64,
            // hit_ratio / write_ratio 可派生，不落库
            hit_ratio: None,
            write_ratio: None,
            missed_tokens: missed.max(0) as u64,
            warm_until_ms: warm_until_ms.map(|v| v.max(0) as u64),
        }))
    }

    /// 读取全部 run 记录（按创建时间升序）。
    pub fn query_all_runs(&self) -> Result<Vec<StoredRun>, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        let mut stmt = conn
            .prepare(
                "SELECT run_id, session_id, status, end_reason, cursor, created_at, updated_at
                 FROM runs ORDER BY created_at ASC",
            )
            .map_err(|e| self.latch_error("query_all_runs_prepare", e))?;
        let rows = stmt
            .query_map([], map_run_row)
            .map_err(|e| self.latch_error("query_all_runs_map", e))?;
        let mut runs = Vec::new();
        for row in rows {
            runs.push(row.map_err(|e| self.latch_error("query_all_runs_row", e))?);
        }
        Ok(runs)
    }

    /// 保存一条待处理输入（按 id 幂等覆盖）。经组提交 Writer。
    pub fn save_pending_input(
        &self,
        id: &str,
        session_id: &str,
        run_id: Option<&str>,
        payload: &str,
    ) -> Result<(), DbFailure> {
        let id = id.to_string();
        let session_id = session_id.to_string();
        let run_id = run_id.map(|s| s.to_string());
        let payload = payload.to_string();
        self.write_blocking(move |conn| {
            conn.execute(
                "INSERT INTO pending_inputs (id, session_id, run_id, payload, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE SET
                     session_id = excluded.session_id,
                     run_id = excluded.run_id,
                     payload = excluded.payload,
                     created_at = excluded.created_at",
                rusqlite::params![id, session_id, run_id, payload, now_millis()],
            )
            .map_err(|e| DbFailure {
                message: format!("save_pending_input: {e}"),
                kind: DbFailureKind::Other("save_pending_input".to_string()),
            })?;
            Ok(())
        })
    }

    /// 加载某会话的全部待处理输入（FIFO：创建时间升序，含 id 决胜）。
    pub fn load_pending_inputs(&self, session_id: &str) -> Result<Vec<PendingInput>, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        let mut stmt = conn
            .prepare(
                "SELECT id, session_id, run_id, payload, created_at
                 FROM pending_inputs WHERE session_id = ?1
                 ORDER BY created_at ASC, id ASC",
            )
            .map_err(|e| self.latch_error("load_pending_inputs_prepare", e))?;
        let rows = stmt
            .query_map(rusqlite::params![session_id], |row| {
                Ok(PendingInput {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    run_id: row.get(2)?,
                    payload: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(|e| self.latch_error("load_pending_inputs_map", e))?;
        let mut inputs = Vec::new();
        for row in rows {
            inputs.push(row.map_err(|e| self.latch_error("load_pending_inputs_row", e))?);
        }
        Ok(inputs)
    }

    /// 删除一条待处理输入（返回是否实际删除了行）。经组提交 Writer。
    pub fn delete_pending_input(&self, id: &str) -> Result<bool, DbFailure> {
        let id = id.to_string();
        self.write_blocking(move |conn| {
            let deleted = conn
                .execute(
                    "DELETE FROM pending_inputs WHERE id = ?1",
                    rusqlite::params![id],
                )
                .map_err(|e| DbFailure {
                    message: format!("delete_pending_input: {e}"),
                    kind: DbFailureKind::Other("delete_pending_input".to_string()),
                })?;
            Ok(deleted > 0)
        })
    }
}

/// runs 行 → StoredRun 映射（status 字面量解析失败按 Unknown 透传保真，
/// 不再静默改写为 failed——裁决 D3，恢复面据此保真保留并显式上报）
fn map_run_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredRun> {
    let status_str: String = row.get(2)?;
    let status = match RunStatus::from_str(&status_str) {
        Ok(status) => status,
        // 未知字面量原样保留（行内 status 不被改写，roundtrip 保真）
        Err(_) => RunStatus::Unknown(status_str),
    };
    Ok(StoredRun {
        run_id: row.get(0)?,
        session_id: row.get(1)?,
        status,
        end_reason: row.get(3)?,
        cursor: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

/// 当前 UTC 毫秒时间戳（epoch ms；runs / pending_inputs 时间列）
fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_run_upsert_preserves_created_at_and_no_cascade_delete() {
        let db = LocalDb::open_in_memory().unwrap();
        db.write_blocking(|conn| {
            conn.execute(
                "INSERT INTO sessions (id, title) VALUES ('s1', 'Session 1')",
                [],
            )
            .map_err(|e| DbFailure {
                message: e.to_string(),
                kind: DbFailureKind::Other("test".to_string()),
            })?;
            Ok(())
        })
        .unwrap();

        // 1. Initial insert_run
        db.insert_run("r1", "s1", RunStatus::Running, None, 10)
            .unwrap();
        let run1 = db.get_run("r1").unwrap().expect("run exists");
        assert_eq!(run1.run_id, "r1");
        assert_eq!(run1.session_id, "s1");
        assert_eq!(run1.status, RunStatus::Running);
        assert_eq!(run1.cursor, 10);
        let created_at_1 = run1.created_at;

        std::thread::sleep(std::time::Duration::from_millis(5));

        // 2. Second insert_run with same run_id: must UPSERT and keep created_at
        db.insert_run("r1", "s1", RunStatus::Completed, Some("done"), 20)
            .unwrap();
        let run2 = db.get_run("r1").unwrap().expect("run exists");
        assert_eq!(run2.run_id, "r1");
        assert_eq!(run2.status, RunStatus::Completed);
        assert_eq!(run2.end_reason.as_deref(), Some("done"));
        assert_eq!(run2.cursor, 20);
        assert_eq!(
            run2.created_at, created_at_1,
            "created_at must be preserved on conflict"
        );
        assert!(run2.updated_at >= created_at_1);
    }

    #[test]
    fn save_pending_input_upsert_works_without_replace() {
        let db = LocalDb::open_in_memory().unwrap();
        db.write_blocking(|conn| {
            conn.execute(
                "INSERT INTO sessions (id, title) VALUES ('s1', 'Session 1')",
                [],
            )
            .map_err(|e| DbFailure {
                message: e.to_string(),
                kind: DbFailureKind::Other("test".to_string()),
            })?;
            Ok(())
        })
        .unwrap();

        db.save_pending_input("p1", "s1", None, "payload-1")
            .unwrap();
        let inputs1 = db.load_pending_inputs("s1").unwrap();
        assert_eq!(inputs1.len(), 1);
        assert_eq!(inputs1[0].payload, "payload-1");

        // Upsert same id with new payload
        db.save_pending_input("p1", "s1", Some("r1"), "payload-2")
            .unwrap();
        let inputs2 = db.load_pending_inputs("s1").unwrap();
        assert_eq!(inputs2.len(), 1);
        assert_eq!(inputs2[0].payload, "payload-2");
        assert_eq!(inputs2[0].run_id.as_deref(), Some("r1"));
    }
}
