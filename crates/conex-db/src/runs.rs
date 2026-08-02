//! run 生命周期域：runs / pending_inputs 表 CRUD，以及 RunStatus / StoredRun /
//! PendingInput 记录类型（orchestrator persist/restore 层消费的最小 API 面）。

use super::{DbFailure, DbFailureKind, LocalDb};
use rusqlite::OptionalExtension;
use std::str::FromStr;

// ════════════════════════════════════════════════════════════════════
// 临时验证垫片（R6 落地后删除）：run 生命周期 + 待处理输入 + 会话级
// 序列号计数器——orchestrator persist/restore 层消费的最小 API 面。
// ════════════════════════════════════════════════════════════════════

/// run 状态字面量（对齐 restore.rs 快照 / frontend RunStatus 契约）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
}

impl RunStatus {
    /// 状态字面量（runs.status 列存储值）
    pub fn as_str(&self) -> &'static str {
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
    /// 插入（或覆盖）一条 run 记录。
    pub fn insert_run(
        &self,
        run_id: &str,
        session_id: &str,
        status: RunStatus,
        end_reason: Option<&str>,
        cursor: i64,
    ) -> Result<(), DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        let now = now_millis();
        conn.execute(
            "INSERT OR REPLACE INTO runs (run_id, session_id, status, end_reason, cursor, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                run_id,
                session_id,
                status.as_str(),
                end_reason,
                cursor,
                now,
                now
            ],
        )
        .map_err(|e| self.latch_error("insert_run", e))?;
        Ok(())
    }

    /// 更新 run 状态（end_reason 为 None 时保留旧值；cursor 为 Some 时写入）。
    pub fn update_run_status(
        &self,
        run_id: &str,
        status: RunStatus,
        end_reason: Option<&str>,
        cursor: Option<i64>,
    ) -> Result<(), DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        conn.execute(
            "UPDATE runs SET
                status = ?2,
                end_reason = COALESCE(?3, end_reason),
                cursor = COALESCE(?4, cursor),
                updated_at = ?5
             WHERE run_id = ?1",
            rusqlite::params![
                run_id,
                status.as_str(),
                end_reason,
                cursor,
                now_millis()
            ],
        )
        .map_err(|e| self.latch_error("update_run_status", e))?;
        Ok(())
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

    /// 保存一条待处理输入（按 id 幂等覆盖）。
    pub fn save_pending_input(
        &self,
        id: &str,
        session_id: &str,
        run_id: Option<&str>,
        payload: &str,
    ) -> Result<(), DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        conn.execute(
            "INSERT OR REPLACE INTO pending_inputs (id, session_id, run_id, payload, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![id, session_id, run_id, payload, now_millis()],
        )
        .map_err(|e| self.latch_error("save_pending_input", e))?;
        Ok(())
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

    /// 删除一条待处理输入（返回是否实际删除了行）。
    pub fn delete_pending_input(&self, id: &str) -> Result<bool, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        let deleted = conn
            .execute("DELETE FROM pending_inputs WHERE id = ?1", rusqlite::params![id])
            .map_err(|e| self.latch_error("delete_pending_input", e))?;
        Ok(deleted > 0)
    }
}

/// runs 行 → StoredRun 映射（status 字面量解析失败按 Unknown 兜底）
fn map_run_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredRun> {
    let status_str: String = row.get(2)?;
    let status = RunStatus::from_str(&status_str).unwrap_or(RunStatus::Failed);
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
