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
    let clauses: Vec<String> = groups
        .iter()
        .map(|g| summary_group_clause_localized(g, is_en))
        .collect();
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
            SceneId::CronFired => {
                if n == 1 {
                    format!("{} triggered 1 time", group.first_biz_key)
                } else {
                    format!("{} triggered {n} times", group.first_biz_key)
                }
            }
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
mod tests;
