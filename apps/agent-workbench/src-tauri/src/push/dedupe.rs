//! 去重（R3-01：D7 §3.4.1 / M8 §3.4.1 实现规范）
//!
//! - 去重键：`{eventType}:{业务键}`（构造见 [dedupe_key]，业务键逐场景登记
//!   于 [crate::push::intent] 与模块文档登记表）；
//! - TTL：24h（[DEDUPE_TTL_MS]），同键重复到达（背压重发等）只推一次；
//! - 存储两级（M8 §3.4.1）：
//!   1. 内存 Map（TTL 24h）：P1/P2 级（重启丢失可接受）；
//!   2. SQLite `push_events_dedupe` 表：**审批键（S1/S2，P0）必须持久化**
//!      ——审批不能漏，审批重推阶梯与去重表互斥（重推不走去重键，走
//!      approval_id 幂等）。
//!
//! 本模块交付 [DedupeBackend] 接口 + [MemoryDedupeBackend]（纯内存）+
//! [SqliteDedupeBackend]（R3-01a 补强：`push_events_dedupe` 表实现，审批键持久化）；
//! TTL 语义统一由 [DedupeState] 承担（后端只存「键 → 记录时刻」，SQLite 后端
//! 额外维护 expires_at 供 D7 24h TTL 扫描清理）；后端由装配点注入 [DedupeState]。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// 去重 TTL（D7 §3.4.1：24h）
pub const DEDUPE_TTL_MS: u64 = 24 * 60 * 60 * 1000;

/// 去重键构造（D7 §3.4.1：`{eventType}:{业务键}`）
///
/// 业务键规则（登记表）：
/// `approval-requested:{toolCallId}`、`approval-resolved:{toolCallId}:expired`、
/// `run-terminal:{runId}[:failed|cancelled]`、`subagent-ended:{subagentId}`、
/// `task-{started|completed|suspicious|failed|killed}:{taskId}`、
/// `timer-fired:{timerId}`、`cron-fired:{cronId}:{iteration}`、
/// `security-audit:{toolCallId|sequence}`、`cache-waste-alert:{runId}`。
pub fn dedupe_key(event_type: &str, biz_key: &str) -> String {
    format!("{event_type}:{biz_key}")
}

/// 去重后端抽象（内存 / SQLite 两种实现）
///
/// 后端只负责「键 → 记录时刻」的存取；TTL 判定与过期清理由
/// [DedupeState] 统一完成（两种后端行为一致，测试等价）。
/// 持久化注记：S1/S2 审批键由 [SqliteDedupeBackend] 实现（R3-01a 补强交付，
/// R3 接线轮按键路由：审批键落 SQLite、非审批键走内存），重启不丢。
pub trait DedupeBackend: Send + Sync {
    /// 记录键（幂等覆盖：同键重复记录刷新时间戳）
    fn record(&mut self, key: &str, now_ms: u64);
    /// 键的记录时刻（无记录 = `None`）
    fn recorded_at(&self, key: &str) -> Option<u64>;
    /// 清理记录时刻早于截止线的条目
    fn prune_older_than(&mut self, cutoff_ms: u64);
    /// 当前条目数（诊断/测试用）
    fn len(&self) -> usize;
}

/// 纯内存去重后端（HashMap<key, 记录时刻>）
#[derive(Debug, Default)]
pub struct MemoryDedupeBackend {
    entries: HashMap<String, u64>,
}

impl MemoryDedupeBackend {
    /// 新建空后端
    pub fn new() -> Self {
        Self::default()
    }
}

impl DedupeBackend for MemoryDedupeBackend {
    fn record(&mut self, key: &str, now_ms: u64) {
        self.entries.insert(key.to_string(), now_ms);
    }

    fn recorded_at(&self, key: &str) -> Option<u64> {
        self.entries.get(key).copied()
    }

    fn prune_older_than(&mut self, cutoff_ms: u64) {
        self.entries.retain(|_, at| *at >= cutoff_ms);
    }

    fn len(&self) -> usize {
        self.entries.len()
    }
}

/// SQLite 去重后端（R3-01a 补强：D7 §8.2 `push_events_dedupe` 表实现）
///
/// 表结构（对齐 D7 §8.2 审批去重表语义 + 任务书 dedupe_key/expires_at 口径；
/// recorded_at 为 [DedupeBackend] trait 的「键 → 记录时刻」存取面，
/// expires_at 为 D7「24h TTL 扫描清理」的过期面，两者差 = TTL）：
///
/// ```sql
/// CREATE TABLE IF NOT EXISTS push_events_dedupe (
///     dedupe_key  TEXT PRIMARY KEY,   -- {eventType}:{业务键}（§3.4.1）
///     recorded_at INTEGER NOT NULL,   -- 记录时刻（epoch ms）
///     expires_at  INTEGER NOT NULL    -- 过期时刻 = recorded_at + ttl（24h 扫描清理）
/// );
/// ```
///
/// - 与 [MemoryDedupeBackend] 同 trait（[DedupeBackend]），[DedupeState] 可注入互换；
/// - **审批键与 `push_pending_approvals` 关联注记**（D7 §8.2 / §9.3 / M8 §3.4.1）：
///   S1/S2 审批键（`approval-requested:{toolCallId}` /
///   `approval-resolved:{toolCallId}:expired`）必须落本表**持久化**（审批不能漏，
///   桌面重启不丢）；重推阶梯表 `push_pending_approvals` 以 approval_id 幂等
///   （重推不走去重键，与去重表**互斥**——同一审批只落一张表的记录面）；
/// - 线程模型：rusqlite `Connection` 非 Send/Sync，包 [Arc<Mutex>]（对齐
///   conex-db `LocalDb` 的 single-writer 先例，克隆廉价可跨线程持有）；
/// - trait 方法为 infallible 接口：落库失败 `tracing::warn` 降级为无操作
///   （不 panic、不阻塞决策管线；去重失效 = 尽力而为的多推一次，可接受）。
#[derive(Debug)]
pub struct SqliteDedupeBackend {
    conn: Arc<Mutex<rusqlite::Connection>>,
    /// 去重 TTL（与 [DedupeState] 的 ttl_ms 同值装配；用于 expires_at 列）
    ttl_ms: u64,
}

impl SqliteDedupeBackend {
    /// 建表 DDL（幂等；缺表自动创建）
    const CREATE_TABLE_SQL: &'static str = "\
        CREATE TABLE IF NOT EXISTS push_events_dedupe (\
            dedupe_key  TEXT PRIMARY KEY,\
            recorded_at INTEGER NOT NULL,\
            expires_at  INTEGER NOT NULL\
        )";

    /// 绑定连接构造（自动建表；ttl_ms 与 [DedupeState] 装配同值）
    pub fn new(conn: rusqlite::Connection, ttl_ms: u64) -> rusqlite::Result<Self> {
        conn.execute_batch(Self::CREATE_TABLE_SQL)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            ttl_ms,
        })
    }

    /// 内存库构造（测试用；对齐 [MemoryDedupeBackend::new] 测试等价）
    pub fn open_in_memory(ttl_ms: u64) -> rusqlite::Result<Self> {
        Self::new(rusqlite::Connection::open_in_memory()?, ttl_ms)
    }

    /// 显式清理已过期条目（D7 §8.2「24h TTL 扫描清理」周期维护；
    /// [DedupeState::prune] 之外的独立清理面）
    pub fn prune_expired(&mut self, now_ms: u64) {
        let _ = self
            .conn
            .lock()
            .map_err(|_| {
                tracing::warn!(target: "push", "SQLite 去重表锁损坏，跳过过期清理");
            })
            .and_then(|conn| {
                conn.execute(
                    "DELETE FROM push_events_dedupe WHERE expires_at < ?1",
                    rusqlite::params![now_ms as i64],
                )
                .map(|_| ())
                .map_err(|e| tracing::warn!(target: "push", "SQLite 去重表过期清理失败: {e}"))
            });
    }
}

impl DedupeBackend for SqliteDedupeBackend {
    fn record(&mut self, key: &str, now_ms: u64) {
        let expires_at = now_ms.saturating_add(self.ttl_ms) as i64;
        let _ = self
            .conn
            .lock()
            .map_err(|_| {
                tracing::warn!(target: "push", "SQLite 去重表锁损坏，跳过记录");
            })
            .and_then(|conn| {
                conn.execute(
                    "INSERT OR REPLACE INTO push_events_dedupe (dedupe_key, recorded_at, expires_at) \
                     VALUES (?1, ?2, ?3)",
                    rusqlite::params![key, now_ms as i64, expires_at],
                )
                .map(|_| ())
                .map_err(|e| tracing::warn!(target: "push", "SQLite 去重表记录失败: {e}"))
            });
    }

    fn recorded_at(&self, key: &str) -> Option<u64> {
        let conn = self.conn.lock().ok()?;
        // 读失败（含缺行）一律 None：去重视为未记录（fail-open——
        // 推送尽力而为，宁可多推一次也不丢推送）
        conn.query_row(
            "SELECT recorded_at FROM push_events_dedupe WHERE dedupe_key = ?1",
            rusqlite::params![key],
            |row| row.get::<_, i64>(0),
        )
        .ok()
        .map(|t| t as u64)
    }

    fn prune_older_than(&mut self, cutoff_ms: u64) {
        let _ = self
            .conn
            .lock()
            .map_err(|_| {
                tracing::warn!(target: "push", "SQLite 去重表锁损坏，跳过清理");
            })
            .and_then(|conn| {
                conn.execute(
                    "DELETE FROM push_events_dedupe WHERE recorded_at < ?1",
                    rusqlite::params![cutoff_ms as i64],
                )
                .map(|_| ())
                .map_err(|e| tracing::warn!(target: "push", "SQLite 去重表清理失败: {e}"))
            });
    }

    fn len(&self) -> usize {
        let conn = match self.conn.lock() {
            Ok(c) => c,
            Err(_) => return 0,
        };
        conn.query_row("SELECT COUNT(*) FROM push_events_dedupe", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap_or(0) as usize
    }
}

/// 去重状态机（后端之上的语义层：TTL 判定 + 检查并记录一步完成）
pub struct DedupeState {
    backend: Box<dyn DedupeBackend>,
    ttl_ms: u64,
}

impl DedupeState {
    /// 用指定后端与 TTL 构造（TTL 0 = 关闭去重，恒放行）
    pub fn new(backend: Box<dyn DedupeBackend>, ttl_ms: u64) -> Self {
        Self { backend, ttl_ms }
    }

    /// 用内存后端构造（默认 TTL 24h）
    pub fn memory() -> Self {
        Self::new(Box::new(MemoryDedupeBackend::new()), DEDUPE_TTL_MS)
    }

    /// 检查并记录：键在 TTL 内已记录 → 返回 `false`（抑制本次推送，
    /// 时间戳不刷新，防止刷 TTL 无限续期）；未命中（或已过期）→
    /// 记录并返回 `true`（放行）
    pub fn check_and_record(&mut self, key: &str, now_ms: u64) -> bool {
        if self.ttl_ms == 0 {
            // 去重关闭：不记录不抑制
            return true;
        }
        let hit = self
            .backend
            .recorded_at(key)
            .is_some_and(|at| now_ms.saturating_sub(at) < self.ttl_ms);
        if !hit {
            self.backend.record(key, now_ms);
        }
        if self.backend.len() > 1024 {
            // 惰性容量护栏：条目超阈值时顺带清理过期键
            self.backend
                .prune_older_than(now_ms.saturating_sub(self.ttl_ms));
        }
        !hit
    }

    /// 显式清理过期条目（周期维护可选）
    pub fn prune(&mut self, now_ms: u64) {
        self.backend
            .prune_older_than(now_ms.saturating_sub(self.ttl_ms));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_and_record_deduplicates_within_ttl() {
        let mut state = DedupeState::memory();
        assert!(state.check_and_record("approval-requested:tc-1", 1_000));
        // 同键在 TTL 内重复到达 → 抑制
        assert!(!state.check_and_record("approval-requested:tc-1", 1_500));
        // 不同键放行
        assert!(state.check_and_record("approval-requested:tc-2", 2_000));
    }

    #[test]
    fn ttl_expiry_allows_repush() {
        let mut state = DedupeState::new(Box::new(MemoryDedupeBackend::new()), 10_000);
        assert!(state.check_and_record("run-terminal:run-1", 1_000));
        assert!(!state.check_and_record("run-terminal:run-1", 10_999));
        // 窗口过后（TTL 10s）重新放行
        assert!(state.check_and_record("run-terminal:run-1", 11_000));
    }

    #[test]
    fn ttl_zero_disables_dedupe() {
        let mut state = DedupeState::new(Box::new(MemoryDedupeBackend::new()), 0);
        // TTL 0 = 关闭去重：恒放行且不落表
        assert!(state.check_and_record("x:1", 1_000));
        assert!(state.check_and_record("x:1", 2_000));
    }

    #[test]
    fn expired_entries_pruned() {
        let mut state = DedupeState::new(Box::new(MemoryDedupeBackend::new()), 10_000);
        state.check_and_record("old", 0);
        state.check_and_record("new", 5_000);
        state.prune(20_000);
        // old（0 记录，20s 后）应被清掉；new（5s 后，15s > TTL？）——
        // 5_000 与 20_000 差 15s > 10s TTL，也应过期
        assert_eq!(state.backend.len(), 0, "过期条目应被全部清理");
        // 过期后重新放行
        assert!(state.check_and_record("old", 21_000));
    }

    #[test]
    fn dedupe_key_helper() {
        assert_eq!(dedupe_key("run-terminal", "run-42"), "run-terminal:run-42");
        assert_eq!(
            dedupe_key("approval-resolved", "tc-1:expired"),
            "approval-resolved:tc-1:expired"
        );
    }

    // ── R3-01a 补强：SQLite 去重后端（CRUD / TTL / 持久化语义）──

    /// SQLite 后端与内存后端同 trait 行为等价（DedupeState 语义层不感知后端）
    #[test]
    fn sqlite_backend_crud_roundtrip() {
        let mut backend = SqliteDedupeBackend::open_in_memory(DEDUPE_TTL_MS).expect("内存库");
        assert_eq!(backend.len(), 0);
        backend.record("approval-requested:tc-1", 1_000);
        assert_eq!(backend.recorded_at("approval-requested:tc-1"), Some(1_000));
        assert_eq!(backend.len(), 1);
        // 未记录键 → None（fail-open：视为未去重）
        assert_eq!(backend.recorded_at("approval-requested:tc-9"), None);
        // 同键重记刷新时刻（幂等覆盖语义）
        backend.record("approval-requested:tc-1", 2_000);
        assert_eq!(backend.recorded_at("approval-requested:tc-1"), Some(2_000));
        assert_eq!(backend.len(), 1);
    }

    #[test]
    fn sqlite_backend_prune_older_than() {
        let mut backend = SqliteDedupeBackend::open_in_memory(10_000).expect("内存库");
        backend.record("old", 0);
        backend.record("new", 5_000);
        backend.prune_older_than(4_000);
        assert_eq!(backend.recorded_at("old"), None, "截止线前的条目应清理");
        assert_eq!(
            backend.recorded_at("new"),
            Some(5_000),
            "截止线后的条目保留"
        );
        assert_eq!(backend.len(), 1);
    }

    #[test]
    fn sqlite_backend_prune_expired_uses_expires_at() {
        // ttl 10s：recorded_at 0 → expires_at 10_000；recorded_at 5_000 → expires_at 15_000
        let mut backend = SqliteDedupeBackend::open_in_memory(10_000).expect("内存库");
        backend.record("a", 0);
        backend.record("b", 5_000);
        backend.prune_expired(12_000);
        assert_eq!(
            backend.recorded_at("a"),
            None,
            "expires_at(10s) < now(12s) → 清理"
        );
        assert_eq!(
            backend.recorded_at("b"),
            Some(5_000),
            "expires_at(15s) ≥ now(12s) → 保留"
        );
    }

    /// DedupeState 装配 SQLite 后端：TTL 判定语义与内存后端一致（同 trait 等价）
    #[test]
    fn dedupe_state_with_sqlite_backend_ttl_equivalent() {
        let mut state = DedupeState::new(
            Box::new(SqliteDedupeBackend::open_in_memory(10_000).expect("内存库")),
            10_000,
        );
        assert!(state.check_and_record("run-terminal:run-1", 1_000));
        assert!(
            !state.check_and_record("run-terminal:run-1", 10_999),
            "TTL 内重复抑制"
        );
        assert!(
            state.check_and_record("run-terminal:run-1", 11_000),
            "TTL 过后重新放行"
        );
        // 惰性容量护栏路径同样工作（不 panic）
        assert!(state.check_and_record("approval-requested:tc-2", 12_000));
    }

    /// 审批键持久化语义（D7 §8.2：审批去重表必须持久化，重启不丢）：
    /// 连接关闭重开（模拟桌面重启）后已记录审批键仍在
    #[test]
    fn sqlite_backend_persists_across_reopen() {
        let dir = tempfile::tempdir().expect("临时目录");
        let db_path = dir.path().join("push-dedupe.db");
        let ttl = DEDUPE_TTL_MS;

        {
            let conn = rusqlite::Connection::open(&db_path).expect("建库");
            let mut backend = SqliteDedupeBackend::new(conn, ttl).expect("建表");
            backend.record("approval-requested:tc-1", 1_000);
            backend.record("approval-requested:tc-2", 2_000);
        } // 连接 drop（模拟进程退出）

        // 重启后重新打开：审批键仍在（内存后端此时必丢——这正是持久化价值）
        let conn = rusqlite::Connection::open(&db_path).expect("重开库");
        let backend = SqliteDedupeBackend::new(conn, ttl).expect("建表");
        assert_eq!(backend.len(), 2, "重启后记录不丢");
        assert_eq!(backend.recorded_at("approval-requested:tc-1"), Some(1_000));
        assert_eq!(backend.recorded_at("approval-requested:tc-2"), Some(2_000));
    }

    /// 持久化后端经 DedupeState 重启后仍抑制重复推送（审批重放防护）
    #[test]
    fn sqlite_backend_restart_suppresses_approval_replay() {
        let dir = tempfile::tempdir().expect("临时目录");
        let db_path = dir.path().join("push-dedupe-replay.db");
        let ttl = DEDUPE_TTL_MS;

        {
            let conn = rusqlite::Connection::open(&db_path).expect("建库");
            let mut state = DedupeState::new(
                Box::new(SqliteDedupeBackend::new(conn, ttl).expect("建表")),
                ttl,
            );
            assert!(state.check_and_record("approval-requested:tc-1", 1_000));
        } // 重启

        let conn = rusqlite::Connection::open(&db_path).expect("重开库");
        let mut state = DedupeState::new(
            Box::new(SqliteDedupeBackend::new(conn, ttl).expect("建表")),
            ttl,
        );
        assert!(
            !state.check_and_record("approval-requested:tc-1", 2_000),
            "重启后同审批键仍在 TTL 内 → 抑制重推"
        );
    }
}
