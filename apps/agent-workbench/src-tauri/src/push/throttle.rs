//! 节流（R3-01：D7 §3.4.4 / M8 §3.4.4 实现规范）
//!
//! 护栏（超限折叠进摘要）：
//! - 厂商通道频控：同 device 每分钟 ≤ 2 条、同 session 每 10 分钟 ≤ 3 条；
//! - 每日总量：单 device 每日 ≤ 50 条（按 UTC 自然日分桶）；
//! - 审批重推阶梯（15min → 60min → 每小时 ×5）属于 S1/S2 专属逻辑，
//!   由 R3-02/03 的 `push/approve.rs` 实现，本模块只管通用频控。
//!
//! 本模块为纯内存滑动窗口（device 维度由装配注入单一 tracker 表达；
//! 多设备场景由 R3-02/03 按 device_id 持有多 tracker 或改造为
//! HashMap<device_id, Tracker>）。

use std::collections::{HashMap, VecDeque};

/// 节流护栏参数（M8 §3.4.4）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ThrottleLimits {
    /// 同 device 每分钟 ≤ 2 条
    pub per_device_per_minute: usize,
    /// 同 session 每 10 分钟 ≤ 3 条
    pub per_session_per_10min: usize,
    /// 单 device 每日 ≤ 50 条（UTC 自然日）
    pub per_device_per_day: usize,
}

impl Default for ThrottleLimits {
    fn default() -> Self {
        Self {
            per_device_per_minute: 2,
            per_session_per_10min: 3,
            per_device_per_day: 50,
        }
    }
}

/// 节流判定结果
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThrottleDecision {
    /// 放行（已记录本次）
    Allow,
    /// 超限：折叠进摘要（不记录，不占额度）
    FoldIntoSummary,
}

/// 节流追踪器（滑动窗口；时钟注入可测）
#[derive(Debug)]
pub struct ThrottleTracker {
    limits: ThrottleLimits,
    /// device 分钟窗口（最近放行的时刻）
    device_minute: VecDeque<u64>,
    /// session → 10 分钟窗口（最近放行的时刻）
    session_10min: HashMap<String, VecDeque<u64>>,
    /// UTC 自然日索引 → 当日放行计数
    device_day: HashMap<u64, usize>,
}

impl Default for ThrottleTracker {
    /// 默认护栏参数（每分钟 ≤2 / 每 10min ≤3 / 每日 ≤50）
    fn default() -> Self {
        Self::new(ThrottleLimits::default())
    }
}

const MINUTE_MS: u64 = 60_000;
const TEN_MINUTE_MS: u64 = 600_000;
const DAY_MS: u64 = 86_400_000;

impl ThrottleTracker {
    /// 用护栏参数构造
    pub fn new(limits: ThrottleLimits) -> Self {
        Self {
            limits,
            device_minute: VecDeque::new(),
            session_10min: HashMap::new(),
            device_day: HashMap::new(),
        }
    }

    /// 判定并记录：任一护栏超限 → [ThrottleDecision::FoldIntoSummary]
    /// （不记录）；全部未超限 → 记录并放行
    pub fn check(&mut self, session_id: &str, now_ms: u64) -> ThrottleDecision {
        self.prune(now_ms);
        let day_index = now_ms / DAY_MS;

        let minute_ok = self.device_minute.len() < self.limits.per_device_per_minute;
        let session_ok = self
            .session_10min
            .get(session_id)
            .is_none_or(|w| w.len() < self.limits.per_session_per_10min);
        let day_ok = self
            .device_day
            .get(&day_index)
            .is_none_or(|c| *c < self.limits.per_device_per_day);

        if !(minute_ok && session_ok && day_ok) {
            return ThrottleDecision::FoldIntoSummary;
        }

        self.device_minute.push_back(now_ms);
        self.session_10min
            .entry(session_id.to_string())
            .or_default()
            .push_back(now_ms);
        *self.device_day.entry(day_index).or_insert(0) += 1;
        ThrottleDecision::Allow
    }

    /// 清理窗口外的旧时刻（惰性维护；被 [Self::check] 每次调用触发）
    pub fn prune(&mut self, now_ms: u64) {
        while self
            .device_minute
            .front()
            .is_some_and(|t| now_ms.saturating_sub(*t) >= MINUTE_MS)
        {
            self.device_minute.pop_front();
        }
        self.session_10min.retain(|_, w| {
            while w
                .front()
                .is_some_and(|t| now_ms.saturating_sub(*t) >= TEN_MINUTE_MS)
            {
                w.pop_front();
            }
            !w.is_empty()
        });
        // 只保留当日与昨日索引（今日计数查询即可；过期索引无查询路径）
        self.device_day.retain(|&d, _| d >= now_ms / DAY_MS - 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 1_786_276_800_000;

    #[test]
    fn per_device_per_minute_limit() {
        let mut tracker = ThrottleTracker::default();
        assert_eq!(tracker.check("s-7", T0), ThrottleDecision::Allow);
        assert_eq!(tracker.check("s-7", T0 + 1_000), ThrottleDecision::Allow);
        // 第 3 条（同分钟）超限
        assert_eq!(tracker.check("s-7", T0 + 2_000), ThrottleDecision::FoldIntoSummary);
        // 跨分钟后额度恢复
        assert_eq!(tracker.check("s-7", T0 + 60_000), ThrottleDecision::Allow);
    }

    #[test]
    fn per_session_per_10min_limit() {
        let mut tracker = ThrottleTracker::default();
        // 不同 session 各自计额
        assert_eq!(tracker.check("s-1", T0), ThrottleDecision::Allow);
        assert_eq!(tracker.check("s-1", T0 + 60_100), ThrottleDecision::Allow);
        assert_eq!(tracker.check("s-1", T0 + 120_200), ThrottleDecision::Allow);
        // s-1 第 4 条（10min 内）折叠
        assert_eq!(tracker.check("s-1", T0 + 180_300), ThrottleDecision::FoldIntoSummary);
        // s-2 独立额度
        assert_eq!(tracker.check("s-2", T0 + 180_400), ThrottleDecision::Allow);
        // 10min 窗口滑出后恢复
        assert_eq!(tracker.check("s-1", T0 + 601_000), ThrottleDecision::Allow);
    }

    #[test]
    fn per_device_per_day_limit() {
        let limits = ThrottleLimits {
            per_device_per_minute: 100,
            per_session_per_10min: 100,
            per_device_per_day: 3,
        };
        let mut tracker = ThrottleTracker::new(limits);
        for i in 0..3 {
            assert_eq!(
                tracker.check("s-7", T0 + i * MINUTE_MS + i),
                ThrottleDecision::Allow,
                "第 {i} 条应放行"
            );
        }
        assert_eq!(tracker.check("s-7", T0 + 3 * MINUTE_MS), ThrottleDecision::FoldIntoSummary);
        // 次日恢复（跨 UTC 自然日）
        let next_day = T0 + DAY_MS + 1_000;
        assert_eq!(tracker.check("s-7", next_day), ThrottleDecision::Allow);
    }

    #[test]
    fn window_rolls_off_after_expiry() {
        let limits = ThrottleLimits {
            per_device_per_minute: 1,
            per_session_per_10min: 100,
            per_device_per_day: 100,
        };
        let mut tracker = ThrottleTracker::new(limits);
        assert_eq!(tracker.check("s-7", T0), ThrottleDecision::Allow);
        assert_eq!(tracker.check("s-7", T0 + 1_000), ThrottleDecision::FoldIntoSummary);
        assert_eq!(tracker.check("s-7", T0 + 60_000), ThrottleDecision::Allow);
        assert_eq!(tracker.check("s-7", T0 + 60_001), ThrottleDecision::FoldIntoSummary);
    }

    #[test]
    fn folded_pushes_do_not_consume_quota() {
        let limits = ThrottleLimits {
            per_device_per_minute: 1,
            per_session_per_10min: 100,
            per_device_per_day: 100,
        };
        let mut tracker = ThrottleTracker::new(limits);
        tracker.check("s-7", T0);
        // 折叠多次不消耗额度：窗口滑出后仍只有 1 条额度
        for _ in 0..5 {
            assert_eq!(tracker.check("s-7", T0 + 1_000), ThrottleDecision::FoldIntoSummary);
        }
        assert_eq!(tracker.check("s-7", T0 + 60_000), ThrottleDecision::Allow);
    }

    #[test]
    fn prune_cleans_stale_windows() {
        let mut tracker = ThrottleTracker::default();
        tracker.check("s-7", T0);
        tracker.check("s-7", T0 + 60_000);
        // 10min 窗口从最早条目起算：+661s 后两个条目均已过期
        // （60s 条目满 601s、最早条目满 661s——否则 10min 窗口清不空）
        tracker.prune(T0 + 661_000);
        assert!(tracker.device_minute.is_empty(), "分钟窗口应清空");
        assert!(tracker.session_10min.is_empty(), "10 分钟窗口应清空");
    }
}
