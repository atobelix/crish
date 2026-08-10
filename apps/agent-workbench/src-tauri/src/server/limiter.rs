//! 连接限流器（R1-10：D5 §7.2 M-LIMIT-2 的纯逻辑状态机）
//!
//! 职责：对「每设备（令牌）并发连接数」与「全局总连接数」做额度占用/释放
//! 记账，D5 §7.2 连接数限制表：
//!
//! - 每设备并发连接 ≤ 2（默认 [DEFAULT_PER_DEVICE_LIMIT]），超限拒绝；
//! - 总并发连接 ≤ 8（默认 [DEFAULT_TOTAL_LIMIT]，与 ws.rs
//!   [crate::server::ws::MAX_WS_CONNECTIONS] 同值），超限拒绝；
//! - 超限返回结构化错误 [LimiterOutcome]（`too-many-connections` 语义）并
//!   递增审计计数（[ConnectionLimiter::audit_rejected_per_device] /
//!   [ConnectionLimiter::audit_rejected_total]）——T-12「超限拒绝 + 审计」
//!   的断言锚；
//! - 连接队列语义：本限流器不设排队（D5 §7.2「队列满 → 立即拒绝（不排队
//!   等待）」）——超限即同步返回拒绝，不存在等待放行路径。
//!
//! 并发模型：记账一把 Mutex 串行化（毫秒级操作，不跨 await），审计计数用
//! AtomicU64 独立累加。纯逻辑状态机（[ConnectionLimiter::acquire] /
//! [ConnectionLimiter::release] / [ConnectionLimiter::reset]）：本模块不接触
//! 网络与注册表，由调用方在连接建立/注销处驱动。
//!
//! ## 接线现状（R1-10）
//!
//! 已挂载于 [crate::server::ServerState::conn_limiter]（装配就绪，测试可
//! 直构）；与 ws.rs 注册表的「每设备一主连接踢旧」（P0-3 裁决）在每设备
//! 上限语义上存在冲突（D5 每设备 2 vs P0-3 踢旧，同令牌第二次连接即踢旧，
//! 每设备计数恒 ≤ 1），register 路径接线待主 Agent 裁决（详见 R1-10 汇报）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// 每设备并发连接上限（D5 §7.2：每设备并发连接 2）
pub const DEFAULT_PER_DEVICE_LIMIT: usize = 2;
/// 总并发连接上限（D5 §7.2：总并发连接 8；与 ws.rs MAX_WS_CONNECTIONS 同值）
pub const DEFAULT_TOTAL_LIMIT: usize = 8;

/// 限流判定结果（结构化错误，D5 §7.2「新连接拒绝（too-many-connections
/// 结构化错误 + 审计）」；T-12 断言映射目标）
// R1-10 备注：register 接线待主 Agent 裁决（P0-3 踢旧 vs 每设备 2）——
// dead_code 静音（测试构建保持检查）
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LimiterOutcome {
    /// 额度占用成功（放行）
    Acquired,
    /// 每设备超限拒绝（携带上限与当前占用）
    RejectedPerDevice { limit: usize, current: u32 },
    /// 总量超限拒绝（携带上限与当前占用）
    RejectedTotal { limit: usize, current: u32 },
}

/// 记账内部态（单锁串行化）
// R1-10 备注：字段由 acquire/release 读写，接线待裁决——dead_code 静音
#[cfg_attr(not(test), allow(dead_code))]
struct LimiterInner {
    /// token_key（令牌哈希，每设备一个键）→ 当前并发连接数
    by_token: HashMap<String, u32>,
    /// 当前总连接数
    total: u32,
}

/// 连接限流器（并发连接额度状态机）
///
/// 语义：
/// - [ConnectionLimiter::acquire]：成功占用额度，任一超限 → 结构化拒绝，
///   拒绝不改变记账态（不消耗额度）且审计计数 +1；
/// - [ConnectionLimiter::release]：释放额度（幂等——未持有该键额度时静默，
///   重复释放不会把计数减到 0 以下）；
/// - [ConnectionLimiter::reset]：整体清零占用与键表（审计计数保留——审计
///   是累计面，不随状态重置抹除）。
// R1-10 备注：字段与多数方法由测试消费，register 接线待裁决——dead_code
// 静音（测试构建保持检查）
#[cfg_attr(not(test), allow(dead_code))]
pub struct ConnectionLimiter {
    /// 每设备并发上限
    per_device_limit: usize,
    /// 总量上限
    total_limit: usize,
    /// 记账锁（串行化 acquire/release/reset）
    inner: Mutex<LimiterInner>,
    /// 审计计数：每设备超限拒绝次数（T-12「审计」断言锚）
    rejected_per_device: AtomicU64,
    /// 审计计数：总量超限拒绝次数（T-12「审计」断言锚）
    rejected_total: AtomicU64,
}

// R1-10 备注：接线待裁决，方法由测试消费——dead_code 静音（测试构建保持检查）
#[cfg_attr(not(test), allow(dead_code))]
impl ConnectionLimiter {
    /// 默认限值（每设备 2 / 总量 8，D5 §7.2）
    pub fn new() -> Self {
        Self::with_limits(DEFAULT_PER_DEVICE_LIMIT, DEFAULT_TOTAL_LIMIT)
    }

    /// 自定义限值（测试 / 未来配置面入口）
    pub fn with_limits(per_device_limit: usize, total_limit: usize) -> Self {
        Self {
            per_device_limit,
            total_limit,
            inner: Mutex::new(LimiterInner {
                by_token: HashMap::new(),
                total: 0,
            }),
            rejected_per_device: AtomicU64::new(0),
            rejected_total: AtomicU64::new(0),
        }
    }

    /// 每设备并发上限
    pub fn per_device_limit(&self) -> usize {
        self.per_device_limit
    }

    /// 总量上限
    pub fn total_limit(&self) -> usize {
        self.total_limit
    }

    /// 占用一个连接额度（连接建立时调用）
    ///
    /// 判定顺序：先每设备、后总量（D5 §7.2 表序）；任一超限 → 结构化拒绝
    /// + 对应审计计数 +1，记账态不变。
    pub fn acquire(&self, token_key: &str) -> LimiterOutcome {
        let mut inner = lock(&self.inner);
        let current = inner.by_token.get(token_key).copied().unwrap_or(0);
        if current >= self.per_device_limit as u32 {
            self.rejected_per_device.fetch_add(1, Ordering::Relaxed);
            return LimiterOutcome::RejectedPerDevice {
                limit: self.per_device_limit,
                current,
            };
        }
        if inner.total >= self.total_limit as u32 {
            self.rejected_total.fetch_add(1, Ordering::Relaxed);
            return LimiterOutcome::RejectedTotal {
                limit: self.total_limit,
                current: inner.total,
            };
        }
        inner.by_token.insert(token_key.to_string(), current + 1);
        inner.total += 1;
        LimiterOutcome::Acquired
    }

    /// 释放一个连接额度（连接注销时调用；幂等——未持有该键额度时静默，
    /// 重复释放不欠账）
    pub fn release(&self, token_key: &str) {
        let mut inner = lock(&self.inner);
        let Some(current) = inner.by_token.get_mut(token_key) else {
            return;
        };
        *current = current.saturating_sub(1);
        if *current == 0 {
            inner.by_token.remove(token_key);
        }
        inner.total = inner.total.saturating_sub(1);
    }

    /// 整体重置：清空全部占用与键表（审计计数保留）
    pub fn reset(&self) {
        let mut inner = lock(&self.inner);
        inner.by_token.clear();
        inner.total = 0;
    }

    /// 当前总占用
    pub fn count(&self) -> u32 {
        lock(&self.inner).total
    }

    /// 指定设备当前占用
    pub fn count_for(&self, token_key: &str) -> u32 {
        lock(&self.inner)
            .by_token
            .get(token_key)
            .copied()
            .unwrap_or(0)
    }

    /// 审计计数：每设备超限拒绝次数
    pub fn audit_rejected_per_device(&self) -> u64 {
        self.rejected_per_device.load(Ordering::Relaxed)
    }

    /// 审计计数：总量超限拒绝次数
    pub fn audit_rejected_total(&self) -> u64 {
        self.rejected_total.load(Ordering::Relaxed)
    }
}

impl Default for ConnectionLimiter {
    fn default() -> Self {
        Self::new()
    }
}

/// Mutex 锁（中毒自愈，跟随 ws.rs 先例）
// R1-10 备注：接线待裁决——dead_code 静音（测试构建保持检查）
#[cfg_attr(not(test), allow(dead_code))]
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// T-12 断言锚：每设备最多 2（D5 §7.2「每设备并发连接 2」）
    #[test]
    fn limiter_acquires_up_to_per_device_limit() {
        let limiter = ConnectionLimiter::new();
        assert_eq!(limiter.acquire("device-a"), LimiterOutcome::Acquired);
        assert_eq!(limiter.acquire("device-a"), LimiterOutcome::Acquired);
        assert_eq!(limiter.count_for("device-a"), 2);
        assert_eq!(limiter.count(), 2);
    }

    /// T-12 断言锚：第 3 个同设备连接 → 结构化拒绝 + 审计计数
    #[test]
    fn limiter_third_per_device_connection_rejected_with_audit() {
        let limiter = ConnectionLimiter::new();
        assert_eq!(limiter.acquire("device-a"), LimiterOutcome::Acquired);
        assert_eq!(limiter.acquire("device-a"), LimiterOutcome::Acquired);
        let outcome = limiter.acquire("device-a");
        assert_eq!(
            outcome,
            LimiterOutcome::RejectedPerDevice {
                limit: 2,
                current: 2
            }
        );
        // 审计：每设备拒绝计数 +1；总量拒绝计数不受影响
        assert_eq!(limiter.audit_rejected_per_device(), 1);
        assert_eq!(limiter.audit_rejected_total(), 0);
        // 拒绝不消耗额度（记账态不变）
        assert_eq!(limiter.count_for("device-a"), 2);
        assert_eq!(limiter.count(), 2);
    }

    /// T-12 断言锚：总量 8 满后第 9 个连接 → 结构化拒绝 + 审计计数
    #[test]
    fn limiter_total_limit_rejects_ninth_with_audit() {
        let limiter = ConnectionLimiter::new();
        for i in 0..8 {
            assert_eq!(
                limiter.acquire(&format!("dev-{i}")),
                LimiterOutcome::Acquired,
                "前 8 个设备必须全部占用成功"
            );
        }
        let outcome = limiter.acquire("dev-8");
        assert_eq!(
            outcome,
            LimiterOutcome::RejectedTotal {
                limit: 8,
                current: 8
            }
        );
        assert_eq!(limiter.audit_rejected_total(), 1);
        assert_eq!(limiter.audit_rejected_per_device(), 0);
        assert_eq!(limiter.count(), 8, "拒绝不得改变记账态");
    }

    /// release 释放额度：每设备与总量同步回收，可再次占用
    #[test]
    fn limiter_release_frees_per_device_and_total_slots() {
        let limiter = ConnectionLimiter::new();
        assert_eq!(limiter.acquire("device-a"), LimiterOutcome::Acquired);
        assert_eq!(limiter.acquire("device-a"), LimiterOutcome::Acquired);
        limiter.release("device-a");
        assert_eq!(limiter.count_for("device-a"), 1);
        assert_eq!(limiter.count(), 1);
        assert_eq!(
            limiter.acquire("device-a"),
            LimiterOutcome::Acquired,
            "释放后必须可再占用"
        );
        // 总量维度：8 个设备占满后，释放一个 → 新设备可接入
        let limiter = ConnectionLimiter::new();
        for i in 0..8 {
            assert_eq!(
                limiter.acquire(&format!("dev-{i}")),
                LimiterOutcome::Acquired
            );
        }
        limiter.release("dev-0");
        assert_eq!(
            limiter.acquire("dev-8"),
            LimiterOutcome::Acquired,
            "释放总量槽位后必须可再占用"
        );
    }

    /// release 幂等：对未持有/已清零的键静默（不 panic、不欠账）
    #[test]
    fn limiter_release_is_idempotent() {
        let limiter = ConnectionLimiter::new();
        limiter.release("never-acquired");
        assert_eq!(limiter.count(), 0);
        assert_eq!(limiter.acquire("device-a"), LimiterOutcome::Acquired);
        limiter.release("device-a");
        limiter.release("device-a");
        limiter.release("device-a");
        assert_eq!(limiter.count(), 0, "重复释放不得把计数减到 0 以下");
        assert_eq!(limiter.audit_rejected_per_device(), 0);
    }

    /// reset 整体清零：占用清空、可重新接入；审计计数保留（累计面不重置）
    #[test]
    fn limiter_reset_clears_usage_but_keeps_audit() {
        let limiter = ConnectionLimiter::new();
        assert_eq!(limiter.acquire("device-a"), LimiterOutcome::Acquired);
        assert_eq!(limiter.acquire("device-a"), LimiterOutcome::Acquired);
        assert_eq!(limiter.acquire("device-b"), LimiterOutcome::Acquired);
        assert_eq!(
            limiter.acquire("device-a"),
            LimiterOutcome::RejectedPerDevice {
                limit: 2,
                current: 2
            }
        );
        let audit_before = limiter.audit_rejected_per_device();
        limiter.reset();
        assert_eq!(limiter.count(), 0);
        assert_eq!(limiter.count_for("device-a"), 0);
        assert_eq!(
            limiter.acquire("device-a"),
            LimiterOutcome::Acquired,
            "重置后必须可重新接入"
        );
        assert_eq!(
            limiter.audit_rejected_per_device(),
            audit_before,
            "审计计数是累计面，不得随状态重置抹除"
        );
    }

    /// 自定义限值（测试 / 未来配置面入口）
    #[test]
    fn limiter_custom_limits_respected() {
        let limiter = ConnectionLimiter::with_limits(1, 3);
        assert_eq!(limiter.per_device_limit(), 1);
        assert_eq!(limiter.total_limit(), 3);
        assert_eq!(limiter.acquire("device-a"), LimiterOutcome::Acquired);
        assert_eq!(
            limiter.acquire("device-a"),
            LimiterOutcome::RejectedPerDevice {
                limit: 1,
                current: 1
            }
        );
        assert_eq!(limiter.acquire("device-b"), LimiterOutcome::Acquired);
        assert_eq!(limiter.acquire("device-c"), LimiterOutcome::Acquired);
        assert_eq!(
            limiter.acquire("device-d"),
            LimiterOutcome::RejectedTotal {
                limit: 3,
                current: 3
            }
        );
    }

    /// 队列拒绝语义：超限同步返回拒绝，不存在排队等待路径（D5 §7.2
    /// 「队列满 → 立即拒绝（不排队等待）」）——acquire 同步返回即证明，
    /// 连续重试仍拒绝（不因等待/轮换而放行）
    #[test]
    fn limiter_rejects_without_queuing() {
        let limiter = ConnectionLimiter::new();
        for i in 0..8 {
            assert_eq!(
                limiter.acquire(&format!("dev-{i}")),
                LimiterOutcome::Acquired
            );
        }
        assert!(matches!(
            limiter.acquire("dev-8"),
            LimiterOutcome::RejectedTotal { .. }
        ));
        assert!(matches!(
            limiter.acquire("dev-8"),
            LimiterOutcome::RejectedTotal { .. }
        ));
        assert_eq!(limiter.count(), 8, "拒绝路径不得产生占用");
    }
}
