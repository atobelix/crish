//! 静默时段（R3-01：D7 §3.4.3 / M8 §3.4.3 实现规范）
//!
//! - 默认窗口 22:30-07:30（分钟级粒度，支持跨午夜；用户可配）；
//! - 时区：移动端注册上报 `timezoneOffsetMinutes`，桌面按该时区判定
//!   （D7 §3.4.3；移动端展示层再做本地「响不响」二次判定，双层职责）；
//! - 分级行为（M8 §3.4.3）：P0 静默时段仍发（可选静音）；P1 不立即发，
//!   折叠进夜间摘要（`push_night_summary` 表持久化由 R3-02/03 接线）；
//!   P2 静默时段不推。
//!
//! ## 夜间摘要合成（R3-01a 补强交付）
//!
//! - 折叠路径：[quiet_hours_policy] 判 [QuietPolicy::InQuietFoldNight] → 折叠
//!   [NightSummaryItem]（engine 累积 + [compose_night_summary] 合成）；
//! - 日归属：[night_summary_date]（静默窗**起始日**——跨午夜窗口的折叠条目
//!   一律归属窗口起始日，去重键 = `night-summary:{YYYY-MM-DD}`，M8 §3.4.3）；
//! - 产出：[NightSummary]（类型/数量/时间窗结构 + 正文，D7 §3.4.3 样例同构）。

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
pub fn quiet_hours_policy(
    level: super::PushLevel,
    now_ms: u64,
    cfg: &QuietHoursConfig,
) -> QuietPolicy {
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

// ── 夜间摘要合成（R3-01a 补强：D7 §3.4.3 / M8 §3.4.3）──

use super::scenes::SceneId;

/// 夜间摘要折叠条目（P1 静默时段折叠的最小单元；`push_night_summary`
/// 表 items JSON 的结构映射源——持久化接线由 R3-02/03 承担）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NightSummaryItem {
    /// 来源场景（折叠条目的类型归属）
    pub scene: SceneId,
    /// 所在会话
    pub session_id: String,
    /// 业务键（runId/taskId/subagentId/timerId/cronId——去重键业务键同源）
    pub biz_key: String,
    /// 折叠时刻（epoch ms；摘要时间窗的聚合输入）
    pub occurred_at_ms: u64,
    /// 文案素材（prompt/summary 等；正文模板渲染输入，可空）
    pub digest: Option<String>,
}

/// 摘要统计组（按场景聚合：类型/数量/时间窗）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NightSummaryGroup {
    /// 场景类型
    pub scene: SceneId,
    /// 折叠条数（同场景聚合）
    pub count: usize,
    /// 组内最早折叠时刻（时间窗起点）
    pub first_at_ms: u64,
    /// 组内最晚折叠时刻（时间窗终点）
    pub last_at_ms: u64,
    /// 组内首条业务键（正文单条形态的展示样本）
    pub first_biz_key: String,
}

/// 夜间摘要（合成产物；D7 §3.4.3：次日静默结束发一条
/// `night-summary` 推送，去重键 = `night-summary:{date}`，M8 §3.4.3）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NightSummary {
    /// 静默窗起始日（YYYY-MM-DD；去重键 = night-summary:{date}）
    pub date: String,
    /// 折叠总条数（「夜间完成 N 项」）
    pub total: usize,
    /// 全量时间窗起点（epoch ms）
    pub first_at_ms: u64,
    /// 全量时间窗终点（epoch ms）
    pub last_at_ms: u64,
    /// 类型/数量统计组（按场景聚合）
    pub groups: Vec<NightSummaryGroup>,
    /// 正文（D7 §3.4.3 样例同构：「夜间完成 N 项：<顿号连接各类型>」）
    pub body: String,
}

/// 折叠条目的日归属：静默窗**起始日**（YYYY-MM-DD）。
///
/// 跨午夜窗口（默认 22:30-07:30）的折叠条目一律归属窗口起始日——次日
/// 00:30 折叠的条目与当晚 23:59 折叠的条目同属一夜（D7 样例键
/// `night-summary:2026-08-10` 即窗口起始日）；静默结束后白天调用同样
/// 归属刚结束的那一夜。
pub fn night_summary_date(now_ms: u64, cfg: &QuietHoursConfig) -> String {
    let local_minute = minute_of_day(now_ms, cfg.timezone_offset_minutes);
    let (y, m, d) = local_civil_date(now_ms, cfg.timezone_offset_minutes);
    // 本地分钟 < 窗口起始 → 处于跨午夜后半段（或静默已结束的白天），
    // 窗口起始日在昨天；否则（窗口起始后）就是今天
    let (y, m, d) = if local_minute < cfg.start_minutes {
        let days = days_from_civil(y, m, d) - 1;
        civil_from_days(days)
    } else {
        (y, m, d)
    };
    format!("{y:04}-{m:02}-{d:02}")
}

/// 夜间摘要合成纯函数：折叠条目列表 → 摘要结构（类型/数量/时间窗/正文）。
///
/// 调用方保证条目属于同一静默窗（跨午夜条目由 [night_summary_date] 归一
/// 到窗口起始日）；日期键取首条折叠时刻的窗口起始日。空列表返回
/// 零统计摘要（total=0，groups 空——调用方通常应在空时跳过生成）。
pub fn compose_night_summary(items: &[NightSummaryItem], cfg: &QuietHoursConfig) -> NightSummary {
    compose_night_summary_with_locale(items, cfg, None)
}

/// 携带设备偏好语言的多语言夜间摘要合成纯函数
pub fn compose_night_summary_with_locale(
    items: &[NightSummaryItem],
    cfg: &QuietHoursConfig,
    locale: Option<&str>,
) -> NightSummary {
    let is_en = matches!(locale, Some(l) if l.trim().to_ascii_lowercase().starts_with("en"));
    let mut groups: Vec<NightSummaryGroup> = Vec::new();
    for item in items {
        match groups.iter_mut().find(|g| g.scene == item.scene) {
            Some(g) => {
                g.count += 1;
                g.last_at_ms = g.last_at_ms.max(item.occurred_at_ms);
            }
            None => groups.push(NightSummaryGroup {
                scene: item.scene,
                count: 1,
                first_at_ms: item.occurred_at_ms,
                last_at_ms: item.occurred_at_ms,
                first_biz_key: item.biz_key.clone(),
            }),
        }
    }
    let total = groups.iter().map(|g| g.count).sum();
    let first_at_ms = items.iter().map(|i| i.occurred_at_ms).min().unwrap_or(0);
    let last_at_ms = items.iter().map(|i| i.occurred_at_ms).max().unwrap_or(0);
    let date = items
        .first()
        .map(|i| night_summary_date(i.occurred_at_ms, cfg))
        .unwrap_or_default();

    // 正文：D7 §3.4.3 样例同构（类型/数量；单条形态带业务键样本）
    let clauses: Vec<String> = groups.iter().map(|g| summary_group_clause_localized(g, is_en)).collect();
    let mut body = if is_en {
        if total == 1 {
            format!("{total} item completed during quiet hours")
        } else {
            format!("{total} items completed during quiet hours")
        }
    } else {
        format!("夜间完成 {total} 项")
    };
    if !clauses.is_empty() {
        if is_en {
            body.push_str(": ");
            body.push_str(&clauses.join(", "));
        } else {
            body.push('：');
            body.push_str(&clauses.join("、"));
        }
    }
    NightSummary {
        date,
        total,
        first_at_ms,
        last_at_ms,
        groups,
        body,
    }
}

/// 场景 → 摘要正文片段（向后兼容默认中文）
#[allow(dead_code)]
fn summary_group_clause(group: &NightSummaryGroup) -> String {
    summary_group_clause_localized(group, false)
}

/// 场景 → 摘要正文片段（多语言支持）
fn summary_group_clause_localized(group: &NightSummaryGroup, is_en: bool) -> String {
    let n = group.count;
    if is_en {
        match group.scene {
            SceneId::RunCompleted => single_or_many(
                n,
                &format!("Task {} completed", group.first_biz_key),
                &format!("{n} tasks completed"),
            ),
            SceneId::RunCancelled => single_or_many(
                n,
                &format!("Task {} cancelled", group.first_biz_key),
                &format!("{n} tasks cancelled"),
            ),
            SceneId::SubagentCompleted => single_or_many(
                n,
                &format!("Subagent {} completed", group.first_biz_key),
                &format!("{n} subagents completed"),
            ),
            SceneId::TaskCompleted => single_or_many(
                n,
                &format!("Task {} completed", group.first_biz_key),
                &format!("{n} tasks completed"),
            ),
            SceneId::TaskKilled => single_or_many(
                n,
                &format!("Task {} terminated", group.first_biz_key),
                &format!("{n} tasks terminated"),
            ),
            SceneId::TaskFailed => single_or_many(
                n,
                &format!("Task {} failed", group.first_biz_key),
                &format!("{n} tasks failed"),
            ),
            SceneId::TaskSuspicious => single_or_many(
                n,
                &format!("Task {} suspected stalled", group.first_biz_key),
                &format!("{n} tasks suspected stalled"),
            ),
            SceneId::TimerFired => single_or_many(
                n,
                &format!("Timer {} expired", group.first_biz_key),
                &format!("{n} timers expired"),
            ),
            SceneId::CronFired => if n == 1 {
                format!("{} triggered 1 time", group.first_biz_key)
            } else {
                format!("{} triggered {n} times", group.first_biz_key)
            },
            _ => format!("{} ×{n}", group.scene.as_str()),
        }
    } else {
        match group.scene {
            SceneId::RunCompleted => single_or_many(
                n,
                &format!("任务 {} 已完成", group.first_biz_key),
                &format!("任务完成 ×{n}"),
            ),
            SceneId::RunCancelled => single_or_many(
                n,
                &format!("任务 {} 已取消", group.first_biz_key),
                &format!("任务取消 ×{n}"),
            ),
            SceneId::SubagentCompleted => single_or_many(
                n,
                &format!("子代理 {} 完成", group.first_biz_key),
                &format!("子代理完成 ×{n}"),
            ),
            SceneId::TaskCompleted => single_or_many(
                n,
                &format!("任务 {} 已完成", group.first_biz_key),
                &format!("任务完成 ×{n}"),
            ),
            SceneId::TaskKilled => single_or_many(
                n,
                &format!("任务 {} 已被终止", group.first_biz_key),
                &format!("任务终止 ×{n}"),
            ),
            SceneId::TaskFailed => single_or_many(
                n,
                &format!("任务 {} 失败", group.first_biz_key),
                &format!("任务失败 ×{n}"),
            ),
            SceneId::TaskSuspicious => single_or_many(
                n,
                &format!("任务 {} 疑似卡死", group.first_biz_key),
                &format!("任务疑似卡死 ×{n}"),
            ),
            SceneId::TimerFired => single_or_many(
                n,
                &format!("定时器 {} 已到期", group.first_biz_key),
                &format!("定时器到期 ×{n}"),
            ),
            // cron 同族折叠计数（S9b：同 cron_id 静默时段只推首条，其余进摘要；
            // biz_key 即 cronId，正文形态 = D7 样例「cron-2 触发 3 次」）
            SceneId::CronFired => format!("{} 触发 {n} 次", group.first_biz_key),
            // 其他场景保守回退（登记表外 P1 折叠兜底）
            _ => format!("{} ×{n}", group.scene.as_str()),
        }
    }
}

/// 单条/多条形态选择
fn single_or_many(n: usize, single: &str, many: &str) -> String {
    if n == 1 {
        single.to_string()
    } else {
        many.to_string()
    }
}

/// 本地日期（epoch ms + 时区偏移 → 公历 y/m/d；纯函数，无外部依赖）
fn local_civil_date(now_ms: u64, tz_offset_minutes: i32) -> (i64, u32, u32) {
    // i128 防溢出：now_ms(u64) + 偏移（±12h 量级）
    let local_ms = now_ms as i128 + i128::from(tz_offset_minutes) * 60_000;
    let days = local_ms.div_euclid(86_400_000) as i64;
    civil_from_days(days)
}

/// 天数 → 公历（Howard Hinnant civil_from_days；负天数安全）
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m as u32, d as u32)
}

/// 公历 → 天数（civil_from_days 逆运算；供「昨天」减法）
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = i64::from((153 * mp + 2) / 5 + d - 1);
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
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
        let at1 = NOON_UTC_MS + 11 * HOUR_MS + 1 * 60_000; // 08-09 23:01
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
}
