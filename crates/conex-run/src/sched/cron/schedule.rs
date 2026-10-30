//! Cron 调度触发计算（下一次命中时刻 + 人类可读标签）
//!
//! 日历换算统一走 `conex_shared::time`（[civil_from_days] / [days_from_civil]，
//! Hinnant 算法唯一真源）；时区偏移由 [LocalOffset] 注入：生产入口
//! [CronSchedule::next_fire_after] 按目标时刻取偏移并在 DST 切换点复算，
//! 测试入口 [CronSchedule::next_fire_after_in_offset] 用固定偏移保证确定性。

use conex_shared::time::{civil_from_days, days_from_civil};
use serde::{Deserialize, Serialize};

use super::parse::CronField;
use super::LocalOffset;

/// 5 段式 cron 表达式（分 时 日 月 周；语义对齐前端校验器
/// workflowScheduler.ts:99-205：`*`、`n`、`a-b`、列表、步进、范围步进）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CronSchedule {
    /// 分钟（0-59）
    pub minute: CronField,
    /// 小时（0-23）
    pub hour: CronField,
    /// 日（1-31）
    pub day_of_month: CronField,
    /// 月（1-12）
    pub month: CronField,
    /// 周（0-7；0 与 7 均为周日）
    pub day_of_week: CronField,
}

/// 星期（0 = 周日，与 cron dow 0-7 语义对齐；1970-01-01 为周四）
fn weekday_sunday0(days: i64) -> u32 {
    u32::try_from((days + 4).rem_euclid(7)).unwrap_or(0)
}

/// epoch 毫秒 + 时区偏移 → 本地墙钟字段（年 月 日 时 分；秒与毫秒不参与
/// cron 匹配，直接丢弃——触发时刻恒为整分钟）
fn epoch_ms_to_local_fields(after_ms: u64, offset_minutes: i32) -> (i64, u32, u32, u32, u32) {
    let total_secs =
        i64::try_from(after_ms / 1000).unwrap_or(i64::MAX) + i64::from(offset_minutes) * 60;
    let days = total_secs.div_euclid(86_400);
    let secs_of_day = total_secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let h = u32::try_from(secs_of_day / 3_600).unwrap_or(0);
    let min = u32::try_from((secs_of_day % 3_600) / 60).unwrap_or(0);
    (y, m, d, h, min)
}

/// 本地墙钟字段 + 时区偏移 → epoch 毫秒（秒恒 0；负 epoch 钳为 0——
/// 扫描窗口恒在未来，负值仅理论边界可达，钳位后不满足「> after_ms」自然跳过）
fn local_fields_to_epoch_ms(y: i64, m: u32, d: u32, h: u32, min: u32, offset_minutes: i32) -> u64 {
    let days = days_from_civil(y, m, d);
    let local_secs = days * 86_400 + i64::from(h) * 3_600 + i64::from(min) * 60;
    let utc_secs = local_secs - i64::from(offset_minutes) * 60;
    if utc_secs < 0 {
        return 0;
    }
    u64::try_from(utc_secs).unwrap_or(u64::MAX) * 1000
}

/// 周字段命中判定（7 与 0 都表周日：值集含 wd，或 wd==0 且值集含 7）
fn dow_field_matches(field: &CronField, weekday_sunday0: u32) -> bool {
    field.values.contains(&weekday_sunday0) || (weekday_sunday0 == 0 && field.values.contains(&7))
}

impl CronSchedule {
    /// 下一次触发时刻（after_ms **之后**第一个命中时刻；无命中返回 None）
    ///
    /// 本地时区语义（TY-11 修复）：偏移按**目标时刻**求值——先用 after_ms
    /// 时刻的偏移算候选，再用候选时刻的偏移复核；两次偏移不同（跨 DST 切换）
    /// 则按新偏移重算一次，避免切换点前后偏一小时。
    pub fn next_fire_after(&self, after_ms: u64, tz: &dyn LocalOffset) -> Option<u64> {
        let offset_at_after = tz.offset_minutes_at(i64::try_from(after_ms).unwrap_or(i64::MAX));
        let candidate = self.next_fire_after_in_offset(after_ms, offset_at_after)?;
        let offset_at_candidate =
            tz.offset_minutes_at(i64::try_from(candidate).unwrap_or(i64::MAX));
        if offset_at_candidate == offset_at_after {
            return Some(candidate);
        }
        // DST 切换：候选墙钟在新偏移下对应另一个 UTC 时刻，按新偏移重算一次
        self.next_fire_after_in_offset(after_ms, offset_at_candidate)
    }

    /// 带时区偏移的触发时刻计算（确定性入口：偏移注入保证可复现；
    /// 生产入口 [CronSchedule::next_fire_after] 在此之上做 DST 复核）
    pub fn next_fire_after_in_offset(&self, after_ms: u64, offset_minutes: i32) -> Option<u64> {
        // 扫描窗口 40 年：公历中任意 (月, 日, 周) 组合若存在必在 28 年内复现
        // （固定日期星期的 28 年周期）；40 年留足闰年与边界余量，超出即无命中。
        const MAX_SCAN_DAYS: i64 = 40 * 366;
        let (y0, m0, d0, _, _) = epoch_ms_to_local_fields(after_ms, offset_minutes);
        let start_day = days_from_civil(y0, m0, d0);
        for day in start_day..=start_day + MAX_SCAN_DAYS {
            let (yy, mm, dd) = civil_from_days(day);
            // 月/日/周 三域联合匹配（AND 语义，任务书定稿：「两域都命中才
            // 触发」；「0 0 30 2 *」恒无命中返回 None，见模块文档「语义选择」）
            if !self.month.values.contains(&mm) || !self.day_of_month.values.contains(&dd) {
                continue;
            }
            let wd = weekday_sunday0(day);
            if !dow_field_matches(&self.day_of_week, wd) {
                continue;
            }
            // 当天命中：在当天（小时, 分钟）值集中找第一个严格大于 after_ms
            // 的时刻（首日早于 after_ms 的候选由 `cand > after_ms` 自然跳过）
            for &h in &self.hour.values {
                for &m in &self.minute.values {
                    let cand = local_fields_to_epoch_ms(yy, mm, dd, h, m, offset_minutes);
                    if cand > after_ms {
                        return Some(cand);
                    }
                }
            }
        }
        None
    }

    /// 人类可读标签（对齐前端 cronExpressionLabel workflowScheduler.ts:212-241：
    /// 常见模式短标签 + 表达式回显；非法表达式由 parse_cron 拒绝，
    /// 本函数只在已解析的调度上调用）
    pub fn cron_label(&self) -> String {
        let e = format!(
            "{} {} {} {} {}",
            self.minute.text,
            self.hour.text,
            self.day_of_month.text,
            self.month.text,
            self.day_of_week.text
        );
        match e.as_str() {
            "0 * * * *" => "每小时 · 0 * * * *".into(),
            "0 0 * * *" => "每天 0 点 · 0 0 * * *".into(),
            "0 9 * * *" => "每天 9 点 · 0 9 * * *".into(),
            "*/5 * * * *" => "每 5 分钟 · */5 * * * *".into(),
            "*/15 * * * *" => "每 15 分钟 · */15 * * * *".into(),
            "*/30 * * * *" => "每 30 分钟 · */30 * * * *".into(),
            "0 0 * * 0" | "0 0 * * 7" => format!("每周日 0 点 · {e}"),
            _ => e,
        }
    }
}
