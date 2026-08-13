//! 静默时段（R3-01：D7 §3.4.3 / M8 §3.4.3 实现规范）
//!
//! - 默认窗口 22:30-07:30（分钟级粒度，支持跨午夜；用户可配）；
//! - 时区：移动端注册上报 `timezoneOffsetMinutes`，桌面按该时区判定
//!   （D7 §3.4.3；移动端展示层再做本地「响不响」二次判定，双层职责）；
//! - 分级行为（M8 §3.4.3）：P0 静默时段仍发（可选静音）；P1 不立即发，
//!   折叠进夜间摘要（`push_night_summary` 表持久化由 R3-02/03 接线）；
//!   P2 静默时段不推。
//!
//! 夜间摘要合成（次日静默结束时刻发一条 `night-summary:{YYYY-MM-DD}`）
//! 属于 R3-02/03 装配职责，本模块只给出折叠判定。

/// 静默时段默认开始（22:30，分钟）
pub const DEFAULT_QUIET_START_MINUTES: u16 = 22 * 60 + 30;
/// 静默时段默认结束（07:30，分钟）
pub const DEFAULT_QUIET_END_MINUTES: u16 = 7 * 60 + 30;

/// 静默时段配置（分钟粒度；跨午夜窗口用 start > end 表达）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QuietHoursConfig {
    /// 静默开始（当日分钟，0-1439；默认 22:30 = 1350）
    pub start_minutes: u16,
    /// 静默结束（当日分钟，0-1439；默认 07:30 = 450）
    pub end_minutes: u16,
    /// 移动端时区偏移（相对 UTC，分钟；移动端注册上报）
    pub timezone_offset_minutes: i32,
}

impl Default for QuietHoursConfig {
    fn default() -> Self {
        Self {
            start_minutes: DEFAULT_QUIET_START_MINUTES,
            end_minutes: DEFAULT_QUIET_END_MINUTES,
            timezone_offset_minutes: 0,
        }
    }
}

/// 静默时段判定结果（分级行为在 [quiet_hours_policy] 中落定）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuietPolicy {
    /// 静默时段内（P0）：仍发（可选静音，由移动端渠道音量策略决定）
    InQuietDeliver,
    /// 静默时段内（P1）：折叠进夜间摘要
    InQuietFoldNight,
    /// 静默时段内（P2）：不推
    InQuietSkip,
    /// 非静默时段：全部级别立即发
    OutsideDeliver,
}

/// 当前时刻是否在静默窗口内（按配置时区判定；[`QuietHoursConfig`] 分钟粒度）
pub fn is_quiet(now_ms: u64, cfg: &QuietHoursConfig) -> bool {
    let minute = minute_of_day(now_ms, cfg.timezone_offset_minutes);
    if cfg.start_minutes < cfg.end_minutes {
        // 同日内窗口（如 13:00-14:00）
        minute >= cfg.start_minutes && minute < cfg.end_minutes
    } else {
        // 跨午夜窗口（默认 22:30-07:30）
        minute >= cfg.start_minutes || minute < cfg.end_minutes
    }
}

/// 静默时段策略（M8 §3.4.3：P0 仍发 / P1 折叠 / P2 不推；非静默全发）
pub fn quiet_hours_policy(level: super::PushLevel, now_ms: u64, cfg: &QuietHoursConfig) -> QuietPolicy {
    if !is_quiet(now_ms, cfg) {
        return QuietPolicy::OutsideDeliver;
    }
    match level {
        super::PushLevel::P0Critical => QuietPolicy::InQuietDeliver,
        super::PushLevel::P1Important => QuietPolicy::InQuietFoldNight,
        super::PushLevel::P2Collapsible => QuietPolicy::InQuietSkip,
    }
}

/// epoch 毫秒 → 时区当日分钟（0-1439；负偏移与跨日取模安全）
fn minute_of_day(now_ms: u64, tz_offset_minutes: i32) -> u16 {
    let utc_minute = (now_ms / 60_000) as i64 % 1440;
    ((utc_minute + i64::from(tz_offset_minutes)).rem_euclid(1440)) as u16
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::PushLevel;

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
        assert!(is_quiet(NOON_UTC_MS + 11 * HOUR_MS, &QuietHoursConfig::default()));
        assert!(is_quiet(NOON_UTC_MS + 12 * HOUR_MS + 30 * 60_000, &QuietHoursConfig::default()));
        assert!(is_quiet(NOON_UTC_MS + 19 * HOUR_MS + 29 * 60_000, &QuietHoursConfig::default()));
        // 静默外：07:30（结束边界）、22:29、12:00
        assert!(!is_quiet(NOON_UTC_MS + 19 * HOUR_MS + 30 * 60_000, &QuietHoursConfig::default()));
        assert!(!is_quiet(NOON_UTC_MS + 10 * HOUR_MS + 29 * 60_000, &QuietHoursConfig::default()));
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
        for level in [PushLevel::P0Critical, PushLevel::P1Important, PushLevel::P2Collapsible] {
            assert_eq!(
                quiet_hours_policy(level, NOON_UTC_MS, &noon),
                QuietPolicy::OutsideDeliver
            );
        }
    }
}
