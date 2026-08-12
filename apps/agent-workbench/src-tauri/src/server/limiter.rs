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
//! ## 接线现状（P0-3 裁决，D-1 归档后）
//!
//! 已挂载于 [crate::server::ServerState::conn_limiter]（装配就绪，测试可
//! 直构）。D-1 裁决事实：每设备并发上限由 ws.rs 注册表「每设备一主连接
//! 踢旧」承担（P0-3：同令牌第二次连接即踢旧，每设备计数恒 ≤ 1，D2
//! §10.5），总量上限由 [crate::server::ws::MAX_WS_CONNECTIONS] 在注册表
//! 层保证——本限流器**不参与生产 register 路径接线**，保留为纯逻辑状态
//! 机（防回归测试面 + R2 装配预留：R2 移动端多连接场景落地时启用每设备
//! 2 语义）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// 每设备并发连接上限（D5 §7.2：每设备并发连接 2）
pub const DEFAULT_PER_DEVICE_LIMIT: usize = 2;
/// 总并发连接上限（D5 §7.2：总并发连接 8；与 ws.rs MAX_WS_CONNECTIONS 同值）
pub const DEFAULT_TOTAL_LIMIT: usize = 8;

/// 限流判定结果（结构化错误，D5 §7.2「新连接拒绝（too-many-connections
/// 结构化错误 + 审计）」；T-12 断言映射目标）
// 备注：D-1 裁决后生产接线由 ws.rs 踢旧承担，本限流器供测试面 + R2 装配
// 预留——dead_code 静音（测试构建保持检查）
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
// 备注：字段由 acquire/release 读写，D-1 裁决后本限流器供测试面 + R2 装配
// 预留——dead_code 静音（测试构建保持检查）
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
// 备注：D-1 裁决后生产接线由 ws.rs 踢旧承担，本限流器供测试面 + R2 装配
// 预留——dead_code 静音（测试构建保持检查）
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

// 备注：D-1 裁决后生产接线由 ws.rs 踢旧承担，本限流器供测试面 + R2 装配
// 预留——dead_code 静音（测试构建保持检查）
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

// ── 配对请求限速器（R1 收口：POST /v1/pair 每源 IP 限速，D2 §12.4）──

/// 配对端点每源 IP 限速默认上限（D2 §12.4「/v1/pair 按连接源 IP 限速
/// （10 次/分钟）」；AU4 问题 #1 缺口收口）
pub const DEFAULT_PAIR_LIMIT: usize = 10;
/// 配对端点限速窗口（1 分钟）
pub const DEFAULT_PAIR_WINDOW_MS: u64 = 60_000;

/// 配对请求限速判定结果
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairRateOutcome {
    /// 窗口内额度充足（本请求计数入窗）
    Allowed,
    /// 窗口内已达上限（拒绝；拒绝不计数，仅审计 +1）
    Rejected { limit: usize, current: usize },
}

/// 每源 IP 限速桶（固定窗口；窗口起点 + 窗口内计数）
struct PairRateBucket {
    /// 窗口起点（epoch ms；惰性推进——命中时过期即重置）
    window_start_ms: u64,
    /// 窗口内已计数请求数（成功与失败统一计）
    count: usize,
}

/// 配对请求限速器（R1-11 收口：D2 §12.4「10 次/分钟/源 IP」防配对码爆破
/// DoS——AU4 问题 #1）
///
/// 语义（与 [ConnectionLimiter] 同构的纯逻辑状态机）：
/// - 固定窗口 + 惰性推进：每源 IP 独立桶（[PairRateBucket]），仅命中时
///   检查 `now >= window_start + window` 过期重置，不主动清扫；
/// - 窗口内**全部请求计数**（配对成功与失败统一计——防爆破口径，
///   D2 §12.4「全部请求计数」）；超限拒绝（[PairRateOutcome::Rejected]）
///   **不计数**（防拒绝路径被刷爆当前窗口）；
/// - 超限时审计计数 +1（[PairRateLimiter::audit_rejected]），与
///   [ConnectionLimiter] 的 AtomicU64 审计模式一致；
/// - 时钟注入：`now_ms` 由调用方传入（[crate::server::now_ms]），单测
///   可注入时间推进验证窗口重置；
/// - 并发模型：记账一把 Mutex 串行化（毫秒级操作，不跨 await），审计
///   计数 AtomicU64 独立累加。
///
/// 桶表无界性说明：桶仅在请求命中时创建、无主动回收——TCP 连接需完整
/// 握手（源 IP 不可伪造），配对期客户端数量级 = 局域网设备数，桶常驻
/// 开销可忽略；不引入清扫逻辑（反过度设计，R2 若开放公网再评估）。
pub struct PairRateLimiter {
    /// 窗口内请求上限（每源 IP）
    limit: usize,
    /// 固定窗口时长（ms）
    window_ms: u64,
    /// 每源 IP 独立桶（单锁串行化）
    buckets: Mutex<std::collections::HashMap<std::net::IpAddr, PairRateBucket>>,
    /// 审计计数：超限拒绝次数
    rejected: AtomicU64,
}

impl PairRateLimiter {
    /// 默认限速（10 次/分钟/源 IP，D2 §12.4）
    pub fn new() -> Self {
        Self::with_config(DEFAULT_PAIR_LIMIT, DEFAULT_PAIR_WINDOW_MS)
    }

    /// 自定义限速配置（测试 / 未来配置面入口）
    pub fn with_config(limit: usize, window_ms: u64) -> Self {
        Self {
            limit,
            window_ms,
            buckets: Mutex::new(std::collections::HashMap::new()),
            rejected: AtomicU64::new(0),
        }
    }

    /// 判定并计数：窗口过期 → 重置（惰性推进）；未达上限 → 计数放行；
    /// 已达上限 → 拒绝 + 审计计数 +1（拒绝不计数）。
    pub fn check_and_count(&self, ip: std::net::IpAddr, now_ms: u64) -> PairRateOutcome {
        let mut buckets = lock(&self.buckets);
        let bucket = buckets.entry(ip).or_insert(PairRateBucket {
            window_start_ms: now_ms,
            count: 0,
        });
        // 惰性推进：窗口过期 → 从当前时刻重新开窗（旧桶的 window_start_ms
        // 与 count 一并重置）
        if now_ms >= bucket.window_start_ms + self.window_ms {
            bucket.window_start_ms = now_ms;
            bucket.count = 0;
        }
        if bucket.count >= self.limit {
            self.rejected.fetch_add(1, Ordering::Relaxed);
            return PairRateOutcome::Rejected {
                limit: self.limit,
                current: bucket.count,
            };
        }
        bucket.count += 1;
        PairRateOutcome::Allowed
    }

    /// 审计计数：超限拒绝次数（拒绝路径被刷也计入——可见性锚）
    pub fn audit_rejected(&self) -> u64 {
        self.rejected.load(Ordering::Relaxed)
    }

    /// 指定源 IP 当前窗口内计数（未命中过 → 0）
    pub fn count_for(&self, ip: std::net::IpAddr) -> usize {
        lock(&self.buckets)
            .get(&ip)
            .map_or(0, |bucket| bucket.count)
    }
}

impl Default for PairRateLimiter {
    fn default() -> Self {
        Self::new()
    }
}

/// Mutex 锁（中毒自愈，跟随 ws.rs 先例；本模块内共享——连接限流器与
/// 配对限速器均消费）
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

    // ── 配对请求限速器（D2 §12.4：10 次/分钟/源 IP；AU4 问题 #1 收口）──

    /// D2 §12.4 断言锚：同 IP 前 10 次全部放行，窗口内计数递增至上限
    #[test]
    fn pair_limiter_allows_up_to_limit_per_ip() {
        let limiter = PairRateLimiter::new();
        let ip: std::net::IpAddr = "192.168.1.10".parse().expect("固定测试 IP");
        let t0 = 1_000_000;
        for i in 1..=DEFAULT_PAIR_LIMIT {
            assert_eq!(
                limiter.check_and_count(ip, t0),
                PairRateOutcome::Allowed,
                "第 {i} 次应在窗口内放行"
            );
            assert_eq!(limiter.count_for(ip), i, "放行后窗口计数必须递增");
        }
        assert_eq!(limiter.audit_rejected(), 0);
    }

    /// D2 §12.4 断言锚：第 11 次同 IP → 结构化拒绝（携带 limit/current）+
    /// 审计计数 +1
    #[test]
    fn pair_limiter_11th_request_rejected_with_audit() {
        let limiter = PairRateLimiter::new();
        let ip: std::net::IpAddr = "192.168.1.10".parse().expect("固定测试 IP");
        let t0 = 1_000_000;
        for _ in 0..DEFAULT_PAIR_LIMIT {
            assert_eq!(limiter.check_and_count(ip, t0), PairRateOutcome::Allowed);
        }
        assert_eq!(
            limiter.check_and_count(ip, t0),
            PairRateOutcome::Rejected {
                limit: DEFAULT_PAIR_LIMIT,
                current: DEFAULT_PAIR_LIMIT
            }
        );
        assert_eq!(limiter.audit_rejected(), 1, "超限必须审计 +1");
    }

    /// 窗口重置（惰性推进，注入时间）：窗口内拒绝 → 推进满 60s → 重置
    /// 放行；推进不足 60s → 仍拒绝（窗口边界精确）
    #[test]
    fn pair_limiter_window_resets_lazily_on_time_advance() {
        let limiter = PairRateLimiter::new();
        let ip: std::net::IpAddr = "192.168.1.10".parse().expect("固定测试 IP");
        let t0 = 1_000_000;
        for _ in 0..DEFAULT_PAIR_LIMIT {
            assert_eq!(limiter.check_and_count(ip, t0), PairRateOutcome::Allowed);
        }
        // 窗口内（< 60s）：仍拒绝
        assert!(
            matches!(
                limiter.check_and_count(ip, t0 + DEFAULT_PAIR_WINDOW_MS - 1),
                PairRateOutcome::Rejected { .. }
            ),
            "窗口未满 60s 不得重置"
        );
        // 推进满 60s：惰性重置 → 放行，计数重新从 1 计
        assert_eq!(
            limiter.check_and_count(ip, t0 + DEFAULT_PAIR_WINDOW_MS),
            PairRateOutcome::Allowed,
            "窗口过期后必须重置放行"
        );
        assert_eq!(limiter.count_for(ip), 1, "重置后窗口计数应从新窗口起算");
        // 新窗口再次放行至上限
        for _ in 1..DEFAULT_PAIR_LIMIT {
            assert_eq!(
                limiter.check_and_count(ip, t0 + DEFAULT_PAIR_WINDOW_MS),
                PairRateOutcome::Allowed
            );
        }
        assert!(
            matches!(
                limiter.check_and_count(ip, t0 + DEFAULT_PAIR_WINDOW_MS),
                PairRateOutcome::Rejected { .. }
            ),
            "新窗口打满后必须再次拒绝"
        );
        assert_eq!(limiter.audit_rejected(), 2, "两次窗口各自超限各审计一次");
    }

    /// 每源 IP 独立桶：IP-A 打满拒绝不影响 IP-B 的窗口额度
    #[test]
    fn pair_limiter_buckets_are_independent_per_ip() {
        let limiter = PairRateLimiter::new();
        let ip_a: std::net::IpAddr = "192.168.1.10".parse().expect("固定测试 IP");
        let ip_b: std::net::IpAddr = "192.168.1.11".parse().expect("固定测试 IP");
        let t0 = 1_000_000;
        for _ in 0..DEFAULT_PAIR_LIMIT {
            assert_eq!(limiter.check_and_count(ip_a, t0), PairRateOutcome::Allowed);
        }
        assert!(
            matches!(
                limiter.check_and_count(ip_a, t0),
                PairRateOutcome::Rejected { .. }
            ),
            "IP-A 打满必须拒绝"
        );
        assert_eq!(
            limiter.check_and_count(ip_b, t0),
            PairRateOutcome::Allowed,
            "IP-B 独立桶不受 IP-A 影响"
        );
        assert_eq!(limiter.count_for(ip_b), 1);
        assert_eq!(limiter.audit_rejected(), 1, "IP-B 的放行不得产生审计");
    }

    /// 拒绝不计数（防拒绝路径被刷爆当前窗口）：连续拒绝后窗口计数恒为
    /// 上限值，审计逐次递增
    #[test]
    fn pair_limiter_rejected_requests_do_not_count() {
        let limiter = PairRateLimiter::new();
        let ip: std::net::IpAddr = "192.168.1.10".parse().expect("固定测试 IP");
        let t0 = 1_000_000;
        for _ in 0..DEFAULT_PAIR_LIMIT {
            assert_eq!(limiter.check_and_count(ip, t0), PairRateOutcome::Allowed);
        }
        for expected_audit in 1..=3 {
            assert!(
                matches!(
                    limiter.check_and_count(ip, t0),
                    PairRateOutcome::Rejected { .. }
                ),
                "第 {expected_audit} 次拒绝"
            );
            assert_eq!(limiter.audit_rejected(), expected_audit, "拒绝逐次审计");
            assert_eq!(
                limiter.count_for(ip),
                DEFAULT_PAIR_LIMIT,
                "拒绝不得改变窗口计数"
            );
        }
    }

    /// 自定义配置（测试 / 未来配置面入口）：with_config(2, 1000)
    #[test]
    fn pair_limiter_custom_config_respected() {
        let limiter = PairRateLimiter::with_config(2, 1000);
        let ip: std::net::IpAddr = "192.168.1.10".parse().expect("固定测试 IP");
        assert_eq!(limiter.check_and_count(ip, 100), PairRateOutcome::Allowed);
        assert_eq!(limiter.check_and_count(ip, 200), PairRateOutcome::Allowed);
        assert_eq!(
            limiter.check_and_count(ip, 300),
            PairRateOutcome::Rejected {
                limit: 2,
                current: 2
            }
        );
        // 自定义窗口 1000ms 后重置
        assert_eq!(
            limiter.check_and_count(ip, 1100),
            PairRateOutcome::Allowed,
            "自定义窗口过期后必须重置"
        );
        assert_eq!(limiter.audit_rejected(), 1);
    }
}
