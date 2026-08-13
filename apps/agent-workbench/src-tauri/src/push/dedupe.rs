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
//! 本任务交付 [DedupeBackend] 接口 + [MemoryDedupeBackend]（纯内存）；
//! TTL 语义统一由 [DedupeState] 承担（后端只存「键 → 记录时刻」）；
//! SQLite 后端（R3-02/03 接线）实现该接口后由装配点注入 [DedupeState]。

use std::collections::HashMap;

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
/// 持久化注记：S1/S2 审批键由 SQLite 后端实现（R3-02/03 接线），
/// 非审批键走内存后端即可（重启丢失可接受，推送本就尽力而为）。
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
}
