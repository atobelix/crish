//! UTC 时间与公历换算唯一真源（纯 std，无 chrono）。
//!
//! 全仓库时间戳统一为 `i64` Unix 毫秒；ISO8601 输出统一为毫秒精度
//! `YYYY-MM-DDTHH:MM:SS.mmmZ`。禁止在其它 crate 重复实现公历换算、
//! epoch 换算或 ISO 格式化/解析。

use std::time::{SystemTime, UNIX_EPOCH};

/// 当前 UTC 时间 ISO8601 字符串（毫秒精度，`2026-07-31T08:00:00.000Z`）
pub fn now_iso_utc() -> String {
    format_iso_utc_ms(millis_of(SystemTime::now()))
}

/// 当前 Unix 秒。
pub fn unix_secs() -> i64 {
    millis_of(SystemTime::now()).div_euclid(1_000)
}

/// 从 Unix 天数换算公历年月日（Howard Hinnant 算法）
///
/// Unix 天 0 = 1970-01-01；负天数对应 epoch 之前（如 -1 = 1969-12-31）。
pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
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

/// 公历年月日换算为 Unix 天数（Howard Hinnant 算法逆运算）。
///
/// 纯算法，不做合法性校验；需要校验的调用方使用 [`parse_iso8601_ms`]。
pub fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = (if year >= 0 { year } else { year - 399 }) / 400;
    let year_of_era = year - era * 400;
    let month = i64::from(month);
    let day = i64::from(day);
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// 毫秒时间戳 → `YYYY-MM-DDTHH:MM:SS.mmmZ`（UTC）。
pub fn format_iso_utc_ms(epoch_ms: i64) -> String {
    let secs = epoch_ms.div_euclid(1_000);
    let millis = epoch_ms.rem_euclid(1_000);
    let days = secs.div_euclid(86_400);
    let seconds_of_day = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let (hours, mins, sec) = (
        seconds_of_day / 3_600,
        seconds_of_day / 60 % 60,
        seconds_of_day % 60,
    );
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{mins:02}:{sec:02}.{millis:03}Z")
}

/// 毫秒时间戳 → `YYYY-MM-DD`（UTC 日期）。
pub fn format_date_utc(epoch_ms: i64) -> String {
    let days = epoch_ms.div_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}

/// 当前 Unix 毫秒（协议 u64 面；时钟早于 epoch 时返回 0）。
pub fn now_millis() -> u64 {
    u64::try_from(unix_millis()).unwrap_or(0)
}

/// 当前 Unix 秒（协议 u64 面；时钟早于 epoch 时返回 0）。
pub fn now_secs() -> u64 {
    now_millis() / 1_000
}

/// 毫秒时间戳 → `YYYYMMDD_HHMMSS`（UTC，文件名/版本戳）。
pub fn compact_utc_stamp(epoch_ms: i64) -> String {
    let secs = epoch_ms.div_euclid(1_000);
    let days = secs.div_euclid(86_400);
    let seconds_of_day = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let (hours, mins, sec) = (
        seconds_of_day / 3_600,
        seconds_of_day / 60 % 60,
        seconds_of_day % 60,
    );
    format!("{year:04}{month:02}{day:02}_{hours:02}{mins:02}{sec:02}")
}

/// 任意 [`SystemTime`]（如文件 mtime）→ Unix 毫秒；早于 epoch 返回负值。
pub fn millis_of(t: SystemTime) -> i64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(duration) => i64::try_from(duration.as_millis()).unwrap_or(i64::MAX),
        Err(err) => -i64::try_from(err.duration().as_millis()).unwrap_or(i64::MAX),
    }
}

/// 当前 Unix 毫秒（时钟早于 1970 时返回负值）。
pub fn unix_millis() -> i64 {
    millis_of(SystemTime::now())
}

/// 解析 ISO8601 UTC 时间戳（接受 `YYYY-MM-DDTHH:MM:SS[.fraction]Z`）。
///
/// 小数秒不足 3 位补零、超过 3 位截断到毫秒；不带毫秒也可解析。时区偏移
/// （`+08:00` 等）与非法日历日期返回 `None`。语义与旧
/// `conex-compaction::thresholds::parse_iso8601_epoch_ms` 一致，并补齐
/// 逐月天数/闰年校验。
pub fn parse_iso8601_ms(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() < 20 {
        return None;
    }
    if bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    if bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }
    let num =
        |start: usize, len: usize| -> Option<i64> { value.get(start..start + len)?.parse().ok() };
    let year = num(0, 4)?;
    let month = num(5, 2)?;
    let day = num(8, 2)?;
    let hour = num(11, 2)?;
    let minute = num(14, 2)?;
    let second = num(17, 2)?;

    let mut millis = 0i64;
    let mut idx = 19;
    if idx < bytes.len() && bytes[idx] == b'.' {
        idx += 1;
        let start = idx;
        while idx < bytes.len() && bytes[idx].is_ascii_digit() {
            idx += 1;
        }
        if idx == start {
            return None;
        }
        let fraction = &value[start..idx];
        let mut padded = String::with_capacity(3);
        padded.push_str(fraction);
        while padded.len() < 3 {
            padded.push('0');
        }
        padded.truncate(3);
        millis = padded.parse().ok()?;
    }
    if idx >= bytes.len() || bytes[idx] != b'Z' {
        return None;
    }
    if !valid_calendar_date(year, month, day) || hour > 23 || minute > 59 || second > 60 {
        return None;
    }

    let days = days_from_civil(year, month as u32, day as u32);
    Some((days * 86_400 + hour * 3_600 + minute * 60 + second) * 1_000 + millis)
}

fn valid_calendar_date(year: i64, month: i64, day: i64) -> bool {
    if !(1..=12).contains(&month) || day < 1 {
        return false;
    }
    let leap = year.rem_euclid(4) == 0 && (year.rem_euclid(100) != 0 || year.rem_euclid(400) == 0);
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    day <= max_day
}

/// 可注入时钟（生产用 [`SystemClock`]，测试用 `conex-test-utils::FakeClock`）。
pub trait Clock: Send + Sync {
    fn now_ms(&self) -> i64;
}

/// 系统时钟实现。
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        millis_of(SystemTime::now())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_known_epoch_millis() {
        assert_eq!(format_iso_utc_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(format_iso_utc_ms(1), "1970-01-01T00:00:00.001Z");
        assert_eq!(format_iso_utc_ms(86_399_999), "1970-01-01T23:59:59.999Z");
        assert_eq!(
            format_iso_utc_ms(951_782_400_000),
            "2000-02-29T00:00:00.000Z"
        );
        assert_eq!(
            format_iso_utc_ms(1_709_164_800_000),
            "2024-02-29T00:00:00.000Z"
        );
        assert_eq!(
            format_iso_utc_ms(253_402_300_799_999),
            "9999-12-31T23:59:59.999Z"
        );
        assert_eq!(format_date_utc(0), "1970-01-01");
    }

    #[test]
    fn parse_round_trips_and_rejects_invalid_shapes() {
        for value in [
            0,
            1,
            86_399_999,
            951_782_400_000,
            1_709_164_800_000,
            253_402_300_799_999,
        ] {
            let text = format_iso_utc_ms(value);
            assert_eq!(parse_iso8601_ms(&text), Some(value), "{text}");
        }
        assert_eq!(
            parse_iso8601_ms("2026-08-03T12:00:00Z"),
            Some(1_785_758_400_000)
        );
        assert_eq!(
            parse_iso8601_ms("2026-08-03T12:00:00.5Z"),
            Some(1_785_758_400_500)
        );
        assert_eq!(parse_iso8601_ms("2023-02-29T00:00:00Z"), None);
        assert_eq!(
            parse_iso8601_ms("2024-02-29T00:00:00Z"),
            Some(1_709_164_800_000)
        );
        assert_eq!(parse_iso8601_ms("2026-13-01T00:00:00Z"), None);
        assert_eq!(parse_iso8601_ms("2026-01-32T00:00:00Z"), None);
        assert_eq!(parse_iso8601_ms("2026-01-01T24:00:00Z"), None);
        assert_eq!(parse_iso8601_ms("2026-01-01T00:00:00+08:00"), None);
    }

    #[test]
    fn days_from_civil_inverts_civil_from_days() {
        for days in (-1_000_000..=3_000_000).step_by(997) {
            let (year, month, day) = civil_from_days(days);
            assert_eq!(days_from_civil(year, month, day), days);
        }
    }

    #[test]
    fn system_clock_matches_now_iso() {
        let clock = SystemClock;
        let before = clock.now_ms();
        let iso = now_iso_utc();
        let after = clock.now_ms();
        let parsed = parse_iso8601_ms(&iso).expect("now_iso_utc 必须可解析");
        assert!(parsed >= before && parsed <= after);
    }
}
