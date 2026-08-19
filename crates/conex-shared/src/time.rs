//! UTC ISO8601 与公历换算（纯 std，Howard Hinnant civil-from-days）。
//!
//! 事件时间戳与注入消息 `createdAt` 共用；无 chrono / time crate。
//! 格式：毫秒精度 `2026-07-31T08:00:00.000Z`。

/// 当前 UTC 时间 ISO8601 字符串（毫秒精度，`2026-07-31T08:00:00.000Z`）
pub fn now_iso_utc() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    let (hours, mins, sec) = (secs / 3600 % 24, secs / 60 % 60, secs % 60);
    let (year, month, day) = civil_from_days((secs / 86400) as i64);
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{mins:02}:{sec:02}.{millis:03}Z")
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

/// 当前 Unix 毫秒（消息 id 前缀用）
pub fn unix_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 时间戳格式：UTC ISO8601 毫秒精度
    #[test]
    fn now_iso_utc_formats_iso8601() {
        let ts = now_iso_utc();
        assert!(ts.len() >= 24, "含毫秒与 Z 后缀");
        assert!(ts.ends_with('Z'));
        let mid = &ts[..ts.len() - 1];
        let date_part = &mid[..10];
        assert_eq!(&date_part[4..5], "-");
        assert_eq!(&date_part[7..8], "-");
        let time_part = &mid[11..];
        assert_eq!(&time_part[2..3], ":");
        assert_eq!(&time_part[5..6], ":");
        assert_eq!(&time_part[8..9], ".");
    }

    /// 日期换算：Unix 天数 0 与已知基准（2026-07-31 = 20665）
    #[test]
    fn civil_from_days_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(1), (1970, 1, 2));
        assert_eq!(civil_from_days(20665), (2026, 7, 31));
    }

    /// 负时间戳：Unix 天 -1 = 1969-12-31（epoch 前一天）
    #[test]
    fn civil_from_days_negative_timestamp() {
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
    }

    /// 远未来：9999-12-31 = Unix 天 2_932_896
    #[test]
    fn civil_from_days_far_future() {
        assert_eq!(civil_from_days(2_932_896), (9999, 12, 31));
    }

    /// 闰年：2024-02-29 = Unix 天 19_782，次日进位 3 月 1 日
    #[test]
    fn civil_from_days_leap_year() {
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
        assert_eq!(civil_from_days(19_783), (2024, 3, 1));
    }

    /// 非闰年：2023-02-28 = Unix 天 19_416，次日进位 3 月 1 日（无 2 月 29）
    #[test]
    fn civil_from_days_non_leap_year() {
        assert_eq!(civil_from_days(19_416), (2023, 2, 28));
        assert_eq!(civil_from_days(19_417), (2023, 3, 1));
    }
}
