/// ISO8601 时间戳 → epoch 毫秒（无 chrono 依赖的手工解析；与 session-loop
/// `now_iso_utc` 产出形态对齐：`YYYY-MM-DDTHH:MM:SS[.mmm]Z`，仅接受 UTC）。
///
/// 供压缩事件时间戳（epoch ms 语义，与 session-loop 时间戳护栏 `unix_millis`
/// 同精度）与 [SessionRecord::apply_compression_end] 使用；解析失败返回
/// None（调用方保持既有护栏状态，绝不写坏）。
pub(crate) fn parse_iso8601_epoch_ms(value: &str) -> Option<i64> {
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
    // 小数秒（可选；now_iso_utc 恒 3 位）
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
        // 不足 3 位补零、超 3 位截断（毫秒精度）
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
    // 基本范围校验（护栏判定用；不做逐月天数精确校验）
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let days = days_from_civil(year, month as u32, day as u32)?;
    Some((days * 86_400 + hour * 3_600 + minute * 60 + second) * 1_000 + millis)
}

/// 公历日期 → 1970-01-01 起天数（Howard Hinnant civil-from-days 逆运算，
/// 与 session-loop 同源算法）
fn days_from_civil(year: i64, month: u32, day: u32) -> Option<i64> {
    if month == 0 || day == 0 {
        return None;
    }
    let year = if month <= 2 { year - 1 } else { year };
    let era = (if year >= 0 { year } else { year - 399 }) / 400;
    let year_of_era = year - era * 400;
    let day_of_year: i64 = (153 * i64::from(if month > 2 { month - 3 } else { month + 9 }) + 2) / 5
        + i64::from(day)
        - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    Some(era * 146_097 + day_of_era - 719_468)
}
