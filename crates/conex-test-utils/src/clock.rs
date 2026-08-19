//! 注入式时钟与虚拟时间护栏（AA-01 Q41 承接，T11.7.2）
//!
//! 时间敏感测试统一走本模块，禁止裸用真实时钟（Q41：now_iso_utc 无注入
//! 时钟、TestProvider::with_pause 真实 sleep 等时间脆弱性归零）：
//! - [TestClock]：可手动推进的确定性时钟（`now_ms` / `now_iso_utc`），
//!   纯 std 实现，不依赖 tokio——断言时间戳/推进边界语义用；
//! - [TimePauseGuard]：tokio 虚拟时间 RAII 护栏（`pause` / `resume`），
//!   把测试内 `tokio::time::sleep` 类时序转为虚拟时间，配合
//!   `tokio::time::advance(...).await` 显式推进（确定性、零真实等待）。
//!
//! 边界（T11.7.2）：本模块只服务测试域，不进生产 API；生产代码不新增
//! 时钟参数，无注入点的模块以 TimePauseGuard 包测试体（最小侵入）。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// 可手动推进的确定性时钟（T11.7.2 / AA-01 Q41）
///
/// 以虚拟 Unix 毫秒为时间源：`now_ms` / `now_iso_utc` 完全由测试驱动，
/// 不读真实时钟。默认从 epoch 起点（0 毫秒）开始，保证跨运行确定性；
/// 测试用 [Self::advance] / [Self::set] 推进到期望的时间点。
#[derive(Debug, Clone)]
pub struct TestClock {
    inner: Arc<TestClockInner>,
}

#[derive(Debug)]
struct TestClockInner {
    /// 虚拟 Unix 毫秒（当前时间源）
    millis: AtomicU64,
}

impl TestClock {
    /// 新建：从 Unix epoch 起点（0 毫秒）开始
    pub fn new() -> Self {
        Self::at(0)
    }

    /// 从指定 Unix 毫秒起步（可对齐已知时间点，如 Y2K：946684800000）
    pub fn at(unix_millis: u64) -> Self {
        Self {
            inner: Arc::new(TestClockInner {
                millis: AtomicU64::new(unix_millis),
            }),
        }
    }

    /// 当前虚拟 Unix 毫秒
    pub fn now_ms(&self) -> u64 {
        self.inner.millis.load(Ordering::Relaxed)
    }

    /// 当前虚拟时间 ISO8601 字符串（毫秒精度，`1970-01-01T00:00:00.000Z` 起步）
    ///
    /// 与 `conex-shared::time` 同算法（Howard Hinnant
    /// civil-from-days 换算），无 chrono 依赖。
    pub fn now_iso_utc(&self) -> String {
        let millis = self.now_ms();
        let secs = millis / 1000;
        let (hours, mins, sec) = (secs / 3600 % 24, secs / 60 % 60, secs % 60);
        let (year, month, day) = civil_from_days((secs / 86400) as i64);
        format!(
            "{year:04}-{month:02}-{day:02}T{hours:02}:{mins:02}:{sec:02}.{:03}Z",
            millis % 1000
        )
    }

    /// 手动推进虚拟时间（毫秒）
    pub fn advance(&self, ms: u64) {
        self.inner.millis.fetch_add(ms, Ordering::Relaxed);
    }

    /// 直接设定虚拟时间（毫秒）
    pub fn set(&self, unix_millis: u64) {
        self.inner.millis.store(unix_millis, Ordering::Relaxed);
    }
}

impl Default for TestClock {
    fn default() -> Self {
        Self::new()
    }
}

/// 从 Unix 天数换算公历年月日（Howard Hinnant 算法，与 conex-shared::time 同算法）
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// tokio 虚拟时间 RAII 护栏（Q41：消除真实 sleep 的测试脆弱性）
///
/// 构造时调用 `tokio::time::pause()`，Drop 时自动 `resume()`；护栏生效期间
/// `tokio::time::sleep` 不再消耗真实时间，测试用 `tokio::time::advance(...).await`
/// 显式推进（确定性、零真实等待，连续运行零 flaky）。
///
/// 注意：仅适用于 current_thread 运行时（`#[tokio::test]` 默认形态）；
/// multi_thread 运行时会 panic（tokio 语义限制）。
#[derive(Debug)]
pub struct TimePauseGuard;

impl TimePauseGuard {
    /// 暂停 tokio 虚拟时间（构造即生效；作用域内与 [tokio::time::advance] 配合）
    pub fn new() -> Self {
        tokio::time::pause();
        Self
    }
}

impl Default for TimePauseGuard {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for TimePauseGuard {
    fn drop(&mut self) {
        tokio::time::resume();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 默认从 epoch 起点开始；推进/set 驱动 now_ms（确定性计数）
    #[test]
    fn manual_advance_drives_now_ms() {
        let clock = TestClock::new();
        assert_eq!(clock.now_ms(), 0);
        clock.advance(500);
        assert_eq!(clock.now_ms(), 500);
        clock.advance(1_500);
        assert_eq!(clock.now_ms(), 2_000);
        clock.set(946_684_800_000);
        assert_eq!(clock.now_ms(), 946_684_800_000);
    }

    /// now_iso_utc 与已知 Unix 时间点对齐（Y2K 与 2021-01-01，跨年算法验证）
    #[test]
    fn now_iso_utc_matches_known_epochs() {
        let clock = TestClock::at(946_684_800_000); // 2000-01-01T00:00:00Z
        assert_eq!(clock.now_iso_utc(), "2000-01-01T00:00:00.000Z");
        let clock = TestClock::at(1_609_459_200_000); // 2021-01-01T00:00:00Z
        assert_eq!(clock.now_iso_utc(), "2021-01-01T00:00:00.000Z");
        // 毫秒精度：0.500 秒
        let clock = TestClock::at(1_609_459_200_500);
        assert_eq!(clock.now_iso_utc(), "2021-01-01T00:00:00.500Z");
        // 闰年/月末进位（2020-02-29T23:59:59.999Z + 1ms → 2020-03-01）
        let clock = TestClock::at(1_583_020_799_999);
        assert_eq!(clock.now_iso_utc(), "2020-02-29T23:59:59.999Z");
        clock.advance(1);
        assert_eq!(clock.now_iso_utc(), "2020-03-01T00:00:00.000Z");
    }

    /// 时间护栏：暂停后 sleep 必须靠 advance 显式推进（零真实等待）
    #[tokio::test]
    async fn pause_guard_requires_virtual_advance() {
        let start = std::time::Instant::now();
        {
            let _guard = TimePauseGuard::new();
            let handle = tokio::spawn(async {
                tokio::time::sleep(std::time::Duration::from_millis(60_000)).await;
                "睡满 60 秒（虚拟）"
            });
            // 先推进 500ms：sleep(60s) 尚未完成
            tokio::time::advance(std::time::Duration::from_millis(500)).await;
            // 再推进 60s 使 sleep 完成
            tokio::time::advance(std::time::Duration::from_millis(60_000)).await;
            assert_eq!(handle.await.expect("任务不 panic"), "睡满 60 秒（虚拟）");
        }
        // 真实耗时远小于虚拟 60 秒（虚拟时间不落真实时钟）
        assert!(start.elapsed() < std::time::Duration::from_secs(5));
    }
}
