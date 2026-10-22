//! 低功耗尝试护栏状态机 [SummaryRetryGate]（E2 F2 层 1：跨 episode 累计尝试 + 窗口重置）。

use super::SummaryRetryGuardConfig;

/// 低功耗尝试护栏状态机（E2 F2 层 1 / 07 §5.1）：跨 episode 累计尝试次数，
/// 窗口内达上限后拒绝新触发（停止重试）；窗口过期自动重置（窗口内 0 次
/// 被动触发 → 计数重置），之后可再试。
///
/// 语义与既有护栏正交（防死循环面）：
/// - 单飞（run 级 [SummaryDispatch::task] / 会话级 coordinator 句柄）防
///   同会话并发重复任务；
/// - 全局并发 ≤2（summary_coordinator.rs）防多会话打爆 provider；
/// - 压缩层溢出重试上限 2（stream_error.rs `compact_overflow_retries`）
///   防「压缩→仍超→再压缩」死循环——本护栏防「摘要失败→无限被动触发」
///   循环，两者互不消耗对方计数。
///
/// 时间注入面：`now_ms` 由调用方提供（生产 [conex_shared::time::unix_millis]），
/// 测试注入假时钟驱动窗口过期断言，零真实等待。
pub struct SummaryRetryGate {
    config: SummaryRetryGuardConfig,
    /// 当前窗口内累计尝试次数（含同步那次口径，与 episode attempts 同源）
    attempts_in_window: u32,
    /// 当前窗口起点（epoch ms；None = 窗口尚未开始）。用 Option 而非 0
    /// 哨兵——epoch 0 是合法时刻（测试假时钟从 0 起步），0 哨兵会误判
    /// 「未开始」导致窗口起点滑动错误
    window_started_at_ms: Option<u64>,
}

impl SummaryRetryGate {
    /// 新建护栏（config 装配时定；state 从零开始，窗口未开始 = None）
    pub fn new(config: SummaryRetryGuardConfig) -> Self {
        Self {
            config,
            attempts_in_window: 0,
            window_started_at_ms: None,
        }
    }

    /// 窗口过期检查：窗口已开始（Some）且自窗口起点流逝 ≥
    /// [SummaryRetryGuardConfig::retry_window_ms] → 重置计数与窗口起点
    /// （窗口内 0 次被动触发 → 计数重置语义）
    fn reset_if_window_expired(&mut self, now_ms: u64) {
        if let Some(started_at) = self.window_started_at_ms {
            if now_ms.saturating_sub(started_at) >= self.config.retry_window_ms {
                tracing::debug!(
                    attempts_in_window = self.attempts_in_window,
                    window_ms = self.config.retry_window_ms,
                    "低功耗观察窗口过期 → 尝试计数重置（可再试）"
                );
                self.attempts_in_window = 0;
                self.window_started_at_ms = None;
            }
        }
    }

    /// episode 开始检查：窗口过期先重置，随后窗口内累计尝试 < 上限 → 放行
    /// （返回 true）；达上限 → 拒绝本次触发（返回 false，不记账）。
    ///
    /// `max_attempts = 0`（配置为禁用重试）时恒拒绝。
    pub fn try_begin_episode(&mut self, now_ms: u64) -> bool {
        self.reset_if_window_expired(now_ms);
        self.attempts_in_window < self.config.max_attempts
    }

    /// episode 结束记账：把本次 episode 消耗的尝试次数累加进窗口（窗口
    /// 过期先重置；窗口未开始则以此为窗口起点）。
    ///
    /// 被拒绝的 episode（未 spawn）不记账。
    pub fn record_episode(&mut self, attempts_used: u32, now_ms: u64) {
        self.reset_if_window_expired(now_ms);
        if self.window_started_at_ms.is_none() {
            self.window_started_at_ms = Some(now_ms);
        }
        self.attempts_in_window = self.attempts_in_window.saturating_add(attempts_used);
    }

    /// 当前窗口内累计尝试次数（测试 / 观测断言面）
    pub fn attempts_in_window(&self) -> u32 {
        self.attempts_in_window
    }

    /// 护栏配置（测试 / 配置面断言）
    pub fn config(&self) -> SummaryRetryGuardConfig {
        self.config
    }
}
