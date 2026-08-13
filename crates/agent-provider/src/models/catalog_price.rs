//! 长度分档与峰谷定价域（SR-06e · 拆分 · ≠ EL）
//!
//! 从 models/catalog.rs 拆出的实现域：分档/峰谷类型与纯函数底。
//! - [super::TieredPriceTier] / [super::PriceDerivation] / [super::PeakPricingSchedule]
//! - [super::tier_for_tokens] / [super::peak_pricing_2x_at]（无 chrono 依赖，纯 std 日期算术）
//!
//! 门面（models/catalog.rs）re-export 公开符号；纯函数经 pub(crate) 供门面
//! 查询方法与旁挂测试消费。

use serde::{Deserialize, Serialize};

use super::ModelCatalogEntry;

/// 长度分档（v2 Schema §3.1；对齐 litellm `tiered_pricing` 的 `range: [min, max)`
/// 半开区间；只写 `minTokens` 的档 = 长上下文档 2x 档）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TieredPriceTier {
    /// 输入长度下界（半开区间下界，含）
    pub min_tokens: u64,
    /// 输入长度上界（半开区间上界，不含）；null = 无上界（长上下文档档）
    pub max_tokens: Option<u64>,
    /// 输出长度组合约束下界（null = 无约束）
    pub min_output_tokens: Option<u64>,
    /// 输出长度组合约束上界（null = 无约束）
    pub max_output_tokens: Option<u64>,
    /// 档内输入价（null = 沿用基础四价）
    pub input_price: Option<f64>,
    /// 档内输出价（null = 沿用基础四价）
    pub output_price: Option<f64>,
    /// 档内缓存命中价（null = 沿用基础四价）
    pub cache_read_price: Option<f64>,
    /// 档内通用写价（null = 沿用基础四价）
    pub cache_write_price: Option<f64>,
}

/// 推导标注（v2 Schema §3.2；`priceStatus = "derived"` 时必填）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PriceDerivation {
    /// 推导依据文字说明（必填）
    pub note: String,
    /// 显式命中比例（qwen 0.1）
    pub cache_read_factor: Option<f64>,
    /// 显式创建比例（qwen 1.25）
    pub cache_write_factor: Option<f64>,
    /// 隐式命中比例（qwen 0.2；目录不存隐式绝对价，供 P5 按比例折算）
    pub implicit_cache_read_factor: Option<f64>,
}

/// 峰谷时段（v2 Schema §3.3；`peakPricing2x = true` 时条件必填）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PeakPricingSchedule {
    /// 峰谷时段窗口（如 ["09:00-12:00", "14:00-18:00"]）
    pub windows: Vec<String>,
    /// 时区（Asia/Shanghai）
    pub tz: String,
    /// 峰谷生效日期（YYYY-MM-DD | null = 待官方公告）
    pub effective_from: Option<String>,
    pub note: Option<String>,
}

/// 输入长度分档命中（`[min, max)` 半开区间；`maxTokens = None` = 无上界档）。
/// 无档 / 长度不落任何档 → None。
pub(crate) fn tier_for_tokens(
    tiers: Option<&[TieredPriceTier]>,
    input_tokens: u64,
) -> Option<&TieredPriceTier> {
    tiers?.iter().find(|tier| {
        input_tokens >= tier.min_tokens
            && tier.max_tokens.is_none_or(|max| input_tokens < max)
    })
}

/// 峰谷定价判定（[super::ModelCatalog::peak_pricing_2x_for] 的纯函数底，供测试与未来
/// P5 成本域复用）：规则见方法文档，全部失败路径保守 false（不高估成本）。
pub(crate) fn peak_pricing_2x_at(entry: &ModelCatalogEntry, now_utc_secs: u64) -> bool {
    if !entry.peak_pricing_2x {
        return false;
    }
    let Some(schedule) = entry.peak_pricing_schedule.as_ref() else {
        return false;
    };
    // 时区仅支持 Asia/Shanghai（UTC+8）；其余时区无换算表 → 保守 false
    if schedule.tz != "Asia/Shanghai" {
        return false;
    }
    // effectiveFrom = 北京当日 0 点生效（UTC 前一日 16:00）；未到 → 未生效
    if let Some(from_utc) = schedule
        .effective_from
        .as_deref()
        .and_then(parse_date_utc_epoch)
    {
        if now_utc_secs < from_utc.saturating_sub(28_800) {
            return false;
        }
    }
    let beijing_minutes = beijing_minutes_of(now_utc_secs);
    schedule
        .windows
        .iter()
        .any(|window| window_contains(window, beijing_minutes))
}

/// UTC epoch 秒 → 北京（UTC+8）当日分钟数（0..=1439）。
pub(crate) fn beijing_minutes_of(now_utc_secs: u64) -> u64 {
    ((now_utc_secs + 28_800) % 86_400) / 60
}

/// 窗口字符串 `"HH:MM-HH:MM"` 左闭右开包含判定；解析失败 → false。
pub(crate) fn window_contains(window: &str, beijing_minutes: u64) -> bool {
    let Some((start, end)) = window.split_once('-') else {
        return false;
    };
    let (Some(start_hhmm), Some(end_hhmm)) = (parse_hhmm(start), parse_hhmm(end)) else {
        return false;
    };
    beijing_minutes >= start_hhmm && beijing_minutes < end_hhmm
}

/// 解析 `"HH:MM"` → 分钟数；非法（非两位数字 / 越界）→ None。
fn parse_hhmm(hhmm: &str) -> Option<u64> {
    let (h, m) = hhmm.split_once(':')?;
    if h.len() != 2 || m.len() != 2 {
        return None;
    }
    let hour: u64 = h.parse().ok()?;
    let minute: u64 = m.parse().ok()?;
    if hour > 23 || minute > 59 {
        return None;
    }
    Some(hour * 60 + minute)
}

/// 解析 `"YYYY-MM-DD"` → 该日 UTC 0 点 epoch 秒；非法 → None。
pub(crate) fn parse_date_utc_epoch(date: &str) -> Option<u64> {
    let mut parts = date.split('-');
    let year: i64 = parts.next()?.parse().ok()?;
    let month: i64 = parts.next()?.parse().ok()?;
    let day: i64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let days = days_from_civil(year, month, day);
    u64::try_from(days.checked_mul(86_400)?).ok()
}

/// 公历日期（年/月/日）→ 自 Unix 纪元（1970-01-01）的天数（Howard Hinnant
/// civil 算法；1970-01-01 返回 0，负值为纪元前）。无 chrono 依赖（本 crate
/// 仅 std），峰值时段判定不引入时间库。
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_adj = (month + 9) % 12;
    let day_of_year = (153 * month_adj + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}
