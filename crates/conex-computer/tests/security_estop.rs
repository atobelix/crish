//! 三级急停 + 空闲挂起穷举测试（S4：04 §4.3 / §4.4——三源同旗、触发记录、
//! 复位、并发触发；空闲挂起注入时钟 119s / 120s / 121s 边界与活动刷新）。
//!
//! 验证面：
//! - 三源（全局 / 热键 / 面板）共用一个急停旗，触发源与序号分源记录；
//! - 重复触发旗幂等、记录追加（审计完整事件链）；复位清旗 + 清记录；
//! - 并发触发记录无丢失（互斥锁保护）；
//! - 空闲挂起：默认 120s 常量、注入时钟边界（119/120/121s）、活动刷新、
//!   tick 只判定不消费、可配时长与下限校验。

use conex_computer::security::{
    EmergencyStop, IdleTimeout, IdleTimeoutError, ManualClock, StopRecord, StopSource,
    DEFAULT_IDLE_TIMEOUT, IDLE_TIMEOUT_MIN,
};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

/// 初始未停止：旗未置位、无记录、零触发
#[test]
fn initially_not_stopped() {
    let stop = EmergencyStop::new();
    assert!(!stop.stopped());
    assert_eq!(stop.records(), Vec::new());
    assert_eq!(stop.trigger_count(), 0);
}

/// 三源同旗：任意一路触发 → 同一旗置位；触发源与序号按先后记录
#[test]
fn three_sources_share_single_flag() {
    let stop = EmergencyStop::new();
    stop.global_stop();
    assert!(stop.stopped(), "全局急停必须置旗");
    assert_eq!(
        stop.records(),
        vec![StopRecord { source: StopSource::Global, seq: 1 }]
    );

    stop.hotkey_trigger();
    assert!(stop.stopped(), "热键触发后同一旗仍置位");
    assert_eq!(stop.records().len(), 2);

    stop.panel_stop();
    assert!(stop.stopped(), "面板触发后同一旗仍置位");
    let records = stop.records();
    assert_eq!(records.len(), 3);
    assert_eq!(records[0].source, StopSource::Global);
    assert_eq!(records[1].source, StopSource::Hotkey);
    assert_eq!(records[2].source, StopSource::Panel);
    let seqs: Vec<u64> = records.iter().map(|r| r.seq).collect();
    assert_eq!(seqs, vec![1, 2, 3], "触发序号必须自 1 起递增");
    assert_eq!(stop.trigger_count(), 3);
}

/// 重复触发：旗幂等（不抖动），记录仍追加（审计需要完整急停事件链）
#[test]
fn repeated_trigger_flag_idempotent_records_append() {
    let stop = EmergencyStop::new();
    for _ in 0..3 {
        stop.panel_stop();
    }
    assert!(stop.stopped());
    assert_eq!(stop.trigger_count(), 3);
    let seqs: Vec<u64> = stop.records().iter().map(|r| r.seq).collect();
    assert_eq!(seqs, vec![1, 2, 3], "重复触发序号仍递增");
}

/// 复位：清旗 + 清记录；复位后可再次急停（序号跨复位不归零）
#[test]
fn reset_clears_flag_and_records() {
    let stop = EmergencyStop::new();
    stop.global_stop();
    stop.hotkey_trigger();
    stop.reset();
    assert!(!stop.stopped(), "复位必须清旗");
    assert!(stop.records().is_empty(), "复位必须清记录");
    assert_eq!(stop.trigger_count(), 0);
    // 复位后可再次急停（序号继续递增，不归零——审计全局唯一）
    stop.panel_stop();
    assert!(stop.stopped());
    assert_eq!(stop.records().len(), 1);
    assert_eq!(stop.records()[0].seq, 3, "序号跨复位保持递增");
}

/// 急停复位不自动恢复开启（04 §4.4 恢复需重新显式开启）——旗与开启态
/// 解耦：复位只影响急停旗
#[test]
fn reset_does_not_touch_enablement() {
    use conex_computer::security::{EnableSource, SessionEnablement};
    let stop = EmergencyStop::new();
    let enablement = SessionEnablement::new();
    stop.panel_stop();
    stop.reset();
    assert!(!enablement.enabled(), "急停复位不自动开启会话");
    enablement.enable(EnableSource::User).unwrap();
    assert!(enablement.enabled(), "重新开启需显式 enable");
}

/// 并发触发：多线程三源齐发 → 旗置位 + 记录无丢失（互斥锁保护）
#[test]
fn concurrent_triggers_all_recorded() {
    let stop = Arc::new(EmergencyStop::new());
    let threads: Vec<_> = (0..12)
        .map(|i| {
            let stop = Arc::clone(&stop);
            thread::spawn(move || match i % 3 {
                0 => stop.global_stop(),
                1 => stop.hotkey_trigger(),
                _ => stop.panel_stop(),
            })
        })
        .collect();
    for t in threads {
        t.join().expect("触发线程不得 panic");
    }
    assert!(stop.stopped());
    assert_eq!(stop.trigger_count(), 12, "并发触发记录不得丢失");
    let sources: Vec<StopSource> = stop.records().iter().map(|r| r.source).collect();
    assert!(sources.contains(&StopSource::Global));
    assert!(sources.contains(&StopSource::Hotkey));
    assert!(sources.contains(&StopSource::Panel));
    // 序号无重复（全局唯一）
    let mut seqs: Vec<u64> = stop.records().iter().map(|r| r.seq).collect();
    seqs.sort_unstable();
    let deduped: Vec<u64> = seqs.clone();
    seqs.dedup();
    assert_eq!(deduped, seqs, "并发触发序号必须全局唯一");
}

/// 空闲挂起默认时长常量登记（04 §4.4：默认 120s，可配）
#[test]
fn default_timeout_is_120s() {
    assert_eq!(DEFAULT_IDLE_TIMEOUT, Duration::from_secs(120));
    let timeout = IdleTimeout::new(DEFAULT_IDLE_TIMEOUT).expect("默认时长合法");
    assert_eq!(timeout.duration(), DEFAULT_IDLE_TIMEOUT);
    assert!(!timeout.tick(), "刚构造不挂起");
}

/// 空闲挂起边界：注入时钟推进 119s 不挂起、120s 挂起、121s 挂起
/// （04 §4.4 空闲挂起计时单测）
#[test]
fn idle_boundary_119_120_121() {
    let clock = Arc::new(ManualClock::new());
    let timeout = IdleTimeout::with_clock(Duration::from_secs(120), clock.clone()).unwrap();
    // 构造即开始计时
    assert!(!timeout.tick(), "初始 0s 不挂起");
    clock.advance(Duration::from_secs(119));
    assert!(!timeout.tick(), "119s：未达阈值，不挂起");
    assert_eq!(timeout.idle_elapsed(), Duration::from_secs(119));
    clock.advance(Duration::from_secs(1));
    assert!(timeout.tick(), "120s：达到阈值，应挂起");
    clock.advance(Duration::from_secs(1));
    assert!(timeout.tick(), "121s：超过阈值，应挂起");
    assert_eq!(timeout.idle_elapsed(), Duration::from_secs(121));
}

/// 活动刷新：AI 动作 / 审批发生时重置空闲基线（119s 活动 → 再计 119s
/// 不挂起；再 1s 挂起）
#[test]
fn record_activity_refreshes_idle_baseline() {
    let clock = Arc::new(ManualClock::new());
    let timeout = IdleTimeout::with_clock(Duration::from_secs(120), clock.clone()).unwrap();
    clock.advance(Duration::from_secs(119));
    timeout.record_activity();
    clock.advance(Duration::from_secs(119));
    assert!(!timeout.tick(), "活动后 119s 不挂起（基线已刷新）");
    clock.advance(Duration::from_secs(1));
    assert!(timeout.tick(), "活动后 120s 挂起");
}

/// tick 只判定不消费：重复 tick 不刷新计时，不改变空闲基线
#[test]
fn tick_is_pure_judgement() {
    let clock = Arc::new(ManualClock::new());
    let timeout = IdleTimeout::with_clock(Duration::from_secs(120), clock.clone()).unwrap();
    clock.advance(Duration::from_secs(60));
    assert!(!timeout.tick());
    assert!(!timeout.tick(), "tick 不得刷新计时");
    assert_eq!(timeout.idle_elapsed(), Duration::from_secs(60));
    clock.advance(Duration::from_secs(60));
    assert!(timeout.tick(), "仍按最近活动判定（120s 挂起）");
}

/// 可配时长 + 下限校验：0s / 亚秒拒绝；下限 1s 通过；任意可配正时长生效
#[test]
fn configurable_duration_and_validation() {
    assert_eq!(IDLE_TIMEOUT_MIN, Duration::from_secs(1), "下限登记为 1s");
    assert_eq!(
        IdleTimeout::new(Duration::ZERO).unwrap_err(),
        IdleTimeoutError::InvalidDuration(Duration::ZERO)
    );
    assert_eq!(
        IdleTimeout::new(Duration::from_millis(500)).unwrap_err(),
        IdleTimeoutError::InvalidDuration(Duration::from_millis(500))
    );
    let one_sec = IdleTimeout::new(Duration::from_secs(1)).expect("下限时长合法");
    assert_eq!(one_sec.duration(), Duration::from_secs(1));
    let custom = IdleTimeout::new(Duration::from_secs(30)).expect("可配时长合法");
    assert_eq!(custom.duration(), Duration::from_secs(30));
    // 错误文案含下限与实收值（引擎侧配置报错可读；Duration::ZERO 的
    // Debug 形如 `0ns`）
    let err = IdleTimeoutError::InvalidDuration(Duration::ZERO);
    let msg = err.to_string();
    assert!(msg.contains("1s"), "错误文案应含下限：{msg}");
    assert!(msg.contains("0ns"), "错误文案应含实收值：{msg}");
}

/// 空闲挂起与急停联动语义：挂起判定与急停旗各自独立判定
/// （挂起 → 引擎侧走 disable + 回 Idle；急停 → 旗置位），互不覆盖
#[test]
fn idle_and_estop_independent() {
    let clock = Arc::new(ManualClock::new());
    let timeout = IdleTimeout::with_clock(Duration::from_secs(120), clock.clone()).unwrap();
    let stop = EmergencyStop::new();
    clock.advance(Duration::from_secs(121));
    assert!(timeout.tick(), "空闲超时判定成立");
    assert!(!stop.stopped(), "空闲超时不影响急停旗");
    stop.panel_stop();
    assert!(stop.stopped());
    timeout.record_activity();
    assert!(!timeout.tick(), "活动刷新后挂起判定解除（引擎侧另行处置急停）");
}
