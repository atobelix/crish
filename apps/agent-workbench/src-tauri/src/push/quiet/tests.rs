//! push quiet 测试（quiet.rs 拆分）：静默窗与夜间摘要合成。

use super::super::PushLevel;
use super::*;

/// 基准时刻：2026-08-10 12:00:00 UTC（中午，非静默；日分 = 720）
const NOON_UTC_MS: u64 = 1_786_276_800_000;
const HOUR_MS: u64 = 3_600_000;

fn cfg_at(local_minute: u16) -> QuietHoursConfig {
    // 用「UTC 偏移使本地时刻 = 指定分钟」构造（offset = local - utc）
    let utc_minute = ((NOON_UTC_MS / 60_000) % 1440) as i32;
    QuietHoursConfig {
        timezone_offset_minutes: i32::from(local_minute) - utc_minute,
        ..QuietHoursConfig::default()
    }
}

#[test]
fn default_window_crosses_midnight() {
    assert_eq!(DEFAULT_QUIET_START_MINUTES, 1350); // 22:30
    assert_eq!(DEFAULT_QUIET_END_MINUTES, 450); // 07:30

    // 静默内：23:00、00:30、07:29
    assert!(is_quiet(
        NOON_UTC_MS + 11 * HOUR_MS,
        &QuietHoursConfig::default()
    ));
    assert!(is_quiet(
        NOON_UTC_MS + 12 * HOUR_MS + 30 * 60_000,
        &QuietHoursConfig::default()
    ));
    assert!(is_quiet(
        NOON_UTC_MS + 19 * HOUR_MS + 29 * 60_000,
        &QuietHoursConfig::default()
    ));
    // 静默外：07:30（结束边界）、22:29、12:00
    assert!(!is_quiet(
        NOON_UTC_MS + 19 * HOUR_MS + 30 * 60_000,
        &QuietHoursConfig::default()
    ));
    assert!(!is_quiet(
        NOON_UTC_MS + 10 * HOUR_MS + 29 * 60_000,
        &QuietHoursConfig::default()
    ));
    assert!(!is_quiet(NOON_UTC_MS, &QuietHoursConfig::default()));
}

#[test]
fn timezone_offset_shifts_window() {
    // 东八区（+480min）：UTC 12:00 = 本地 20:00（静默外）
    let east8 = QuietHoursConfig {
        timezone_offset_minutes: 480,
        ..QuietHoursConfig::default()
    };
    assert!(!is_quiet(NOON_UTC_MS, &east8));
    // 本地 23:00 = UTC 15:00
    assert!(is_quiet(NOON_UTC_MS + 3 * HOUR_MS, &east8));
}

#[test]
fn same_day_window() {
    // 13:00-14:00 窗口（UTC 基准 12:00 + 2h = 14:00 之外）
    let cfg = QuietHoursConfig {
        start_minutes: 13 * 60,
        end_minutes: 14 * 60,
        timezone_offset_minutes: 0,
    };
    assert!(is_quiet(NOON_UTC_MS + 70 * 60_000, &cfg)); // 13:10
    assert!(!is_quiet(NOON_UTC_MS + 125 * 60_000, &cfg)); // 14:05
}

#[test]
fn policy_by_level() {
    let quiet_night = cfg_at(23 * 60);
    assert_eq!(
        quiet_hours_policy(PushLevel::P0Critical, NOON_UTC_MS, &quiet_night),
        QuietPolicy::InQuietDeliver
    );
    assert_eq!(
        quiet_hours_policy(PushLevel::P1Important, NOON_UTC_MS, &quiet_night),
        QuietPolicy::InQuietFoldNight
    );
    assert_eq!(
        quiet_hours_policy(PushLevel::P2Collapsible, NOON_UTC_MS, &quiet_night),
        QuietPolicy::InQuietSkip
    );
}

#[test]
fn policy_outside_quiet_delivers_all() {
    let noon = cfg_at(12 * 60);
    for level in [
        PushLevel::P0Critical,
        PushLevel::P1Important,
        PushLevel::P2Collapsible,
    ] {
        assert_eq!(
            quiet_hours_policy(level, NOON_UTC_MS, &noon),
            QuietPolicy::OutsideDeliver
        );
    }
}

// ── R3-01a 补强：夜间摘要合成（类型/数量/时间窗/日归属）──

/// 基准实测：NOON_UTC_MS = 2026-08-09 12:00 UTC（minute 720）；
/// +11h = 08-09 23:00（静默内，窗口起始日 08-09）；
/// +12h30m = 08-10 00:30（跨午夜静默内）；+19h30m = 08-10 07:30（静默结束）
fn item(scene: SceneId, biz_key: &str, at_ms: u64) -> NightSummaryItem {
    NightSummaryItem {
        scene,
        session_id: "s-7".to_string(),
        biz_key: biz_key.to_string(),
        occurred_at_ms: at_ms,
        digest: None,
    }
}

/// 日归属：跨午夜窗口的折叠条目归一静默窗起始日（D7 样例键语义）
#[test]
fn night_summary_date_keys_to_window_start_day() {
    let cfg = QuietHoursConfig::default();
    // 静默窗内：23:00（起始日当天）与次日 00:30 / 07:30（跨午夜后半段）
    assert_eq!(
        night_summary_date(NOON_UTC_MS + 11 * HOUR_MS, &cfg),
        "2026-08-09"
    );
    assert_eq!(
        night_summary_date(NOON_UTC_MS + 12 * HOUR_MS + 30 * 60_000, &cfg),
        "2026-08-09"
    );
    assert_eq!(
        night_summary_date(NOON_UTC_MS + 19 * HOUR_MS + 30 * 60_000, &cfg),
        "2026-08-09"
    );
    // 静默结束后的白天：仍归属刚结束的那一夜（起始日）
    assert_eq!(night_summary_date(NOON_UTC_MS, &cfg), "2026-08-08");
    assert_eq!(
        night_summary_date(NOON_UTC_MS + 9 * HOUR_MS, &cfg),
        "2026-08-08"
    );
    // 东八区：UTC 12:00 = 本地 20:00（非静默，归属前一夜）；+3h = 本地 23:00（今日窗口）
    let east8 = QuietHoursConfig {
        timezone_offset_minutes: 480,
        ..QuietHoursConfig::default()
    };
    assert_eq!(night_summary_date(NOON_UTC_MS, &east8), "2026-08-08");
    assert_eq!(
        night_summary_date(NOON_UTC_MS + 3 * HOUR_MS, &east8),
        "2026-08-09"
    );
}

/// 合成边界：空列表 → 零统计（调用方通常应跳过生成，函数不 panic）
#[test]
fn compose_empty_items_returns_zero_summary() {
    let summary = compose_night_summary(&[], &QuietHoursConfig::default());
    assert_eq!(summary.total, 0);
    assert!(summary.groups.is_empty());
    assert_eq!(summary.first_at_ms, 0);
    assert_eq!(summary.last_at_ms, 0);
    assert_eq!(summary.date, "");
    assert_eq!(summary.body, "夜间完成 0 项");
}

/// 混合类型聚合：类型分组/计数/时间窗/正文（D7 §3.4.3 样例同构）
#[test]
fn compose_mixed_types_groups_counts_and_window() {
    let at1 = NOON_UTC_MS + 11 * HOUR_MS + 60_000; // 08-09 23:01
    let at2 = at1 + 30 * 60_000; // 23:31
    let at3 = at1 + 2 * HOUR_MS; // 次日 01:01（跨午夜）
    let items = vec![
        item(SceneId::RunCompleted, "run-55", at1),
        item(SceneId::SubagentCompleted, "sa-1", at2),
        item(SceneId::SubagentCompleted, "sa-2", at2 + 60_000),
        item(SceneId::TaskFailed, "t-21", at3),
        item(SceneId::CronFired, "cron-2", at1),
        item(SceneId::CronFired, "cron-2", at2),
        item(SceneId::CronFired, "cron-2", at3),
    ];
    let summary = compose_night_summary(&items, &QuietHoursConfig::default());
    assert_eq!(summary.date, "2026-08-09", "日归属 = 窗口起始日");
    assert_eq!(summary.total, 7, "折叠总条数");
    assert_eq!(summary.first_at_ms, at1);
    assert_eq!(summary.last_at_ms, at3);

    // 类型分组：场景顺序 = 首次出现顺序
    assert_eq!(summary.groups.len(), 4);
    let g0 = &summary.groups[0];
    assert_eq!(g0.scene, SceneId::RunCompleted);
    assert_eq!(g0.count, 1);
    assert_eq!(g0.first_biz_key, "run-55");
    let g1 = &summary.groups[1];
    assert_eq!(g1.scene, SceneId::SubagentCompleted);
    assert_eq!(g1.count, 2);
    assert_eq!(g1.first_at_ms, at2);
    assert_eq!(g1.last_at_ms, at2 + 60_000);
    let g3 = &summary.groups[3];
    assert_eq!(g3.scene, SceneId::CronFired);
    assert_eq!(g3.count, 3, "同 cron_id 多次触发聚为一条");

    // 正文：D7 样例同构（任务 run-55 已完成、子代理完成 ×2、任务 t-21 失败、cron-2 触发 3 次）
    assert_eq!(
        summary.body,
        "夜间完成 7 项：任务 run-55 已完成、子代理完成 ×2、任务 t-21 失败、cron-2 触发 3 次"
    );
}

/// 跨午夜：23:59 与次日 00:30 的折叠条目同属一夜（窗口起始日键）
#[test]
fn compose_cross_midnight_single_night() {
    let evening = NOON_UTC_MS + 11 * HOUR_MS + 59 * 60_000; // 08-09 23:59
    let after_midnight = NOON_UTC_MS + 12 * HOUR_MS + 30 * 60_000; // 08-10 00:30
    let items = vec![
        item(SceneId::TimerFired, "timer-1", evening),
        item(SceneId::RunCancelled, "run-7", after_midnight),
    ];
    let summary = compose_night_summary(&items, &QuietHoursConfig::default());
    assert_eq!(summary.date, "2026-08-09", "跨午夜归一窗口起始日");
    assert_eq!(summary.total, 2);
    assert_eq!(summary.groups.len(), 2);
    assert_eq!(summary.first_at_ms, evening);
    assert_eq!(summary.last_at_ms, after_midnight);
    assert_eq!(
        summary.body,
        "夜间完成 2 项：定时器 timer-1 已到期、任务 run-7 已取消"
    );
}

/// 单条/多条形态：单条带业务键样本，多条 ×N 计数
#[test]
fn compose_single_vs_many_clause_forms() {
    let at = NOON_UTC_MS + 11 * HOUR_MS;
    let single = compose_night_summary(
        &[item(SceneId::TaskCompleted, "t-1", at)],
        &QuietHoursConfig::default(),
    );
    assert_eq!(single.body, "夜间完成 1 项：任务 t-1 已完成");

    let many = compose_night_summary(
        &[
            item(SceneId::TaskCompleted, "t-1", at),
            item(SceneId::TaskCompleted, "t-2", at + 60_000),
        ],
        &QuietHoursConfig::default(),
    );
    assert_eq!(many.body, "夜间完成 2 项：任务完成 ×2");
}
