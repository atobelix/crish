//! Cron 表达式解析（5 段式：分 时 日 月 周）
//!
//! 语义逐项对齐前端校验器 workflowScheduler.ts:99-205：`*`、`n`、`a-b`、
//! 列表、`*/step`、`a-b/step`、`n/step`；字段级错误带定位（index 0-4）与
//! 中文原因。解析结果是 [CronField] 的「值集 + 原文」双层表示，供
//! [crate::sched::cron::CronSchedule] 匹配与标签回显使用。

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

use super::schedule::CronSchedule;

/// 单个 cron 字段（值集展开 + 原文保留）
///
/// 内部表示分两层：「值集」承载匹配（[CronField::values] 为升序去重展开），
/// 「原文」承载回显（[CronField::text] 保留原始写法，cron_label 与校验定位
/// 依赖它，不做零填充等规范化——对齐前端原样回显语义）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CronField {
    /// 字段原文（trim 后保留；`*`、`*/5`、`8-10`、`1,15` 等原样）
    pub text: String,
    /// 命中值集（升序去重；`*` = 全字段范围、`a-b/n` = 等差序列展开）
    pub values: Vec<u32>,
}

/// cron 解析错误（结构化：字段定位 + 中文文案，对齐前端拒绝文案
/// workflowScheduler.ts:169-205；serde 形态对齐 CoreError 先例）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "detail")]
pub enum CronError {
    /// 空表达式
    Empty,
    /// @ 宏不支持（@yearly/@daily/@monthly/@weekly/@hourly/@reboot）
    MacroNotSupported,
    /// 字段数错误（actual=6 为含秒字段；其余为非 5 字段）
    WrongFieldCount {
        /// 实际字段数
        actual: usize,
    },
    /// 字段级错误（index 0-4 = 分 时 日 月 周；raw 为字段原文；
    /// reason 为中文原因；min/max 为字段范围）
    FieldInvalid {
        /// 字段定位（0-4 = 分 时 日 月 周）
        index: usize,
        /// 字段中文名（分钟/小时/日/月/周）
        field_name: String,
        /// 字段原文
        raw: String,
        /// 字段下限
        min: u32,
        /// 字段上限
        max: u32,
        /// 中文原因
        reason: String,
    },
}

impl std::fmt::Display for CronError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CronError::Empty => write!(f, "cron 表达式不能为空"),
            CronError::MacroNotSupported => {
                write!(f, "不支持 @yearly 等 cron 宏，请用 5 字段表达式")
            }
            // 6 字段文案与前端 :181-187 完全一致（含秒的常见误用单独提示）
            CronError::WrongFieldCount { actual: 6 } => {
                write!(f, "不支持 6 字段（含秒）cron，请用 5 字段：分 时 日 月 周")
            }
            CronError::WrongFieldCount { actual } => {
                write!(f, "cron 须为 5 个字段（分 时 日 月 周），当前 {actual} 个")
            }
            CronError::FieldInvalid {
                field_name,
                raw,
                min,
                max,
                reason,
                ..
            } => write!(
                f,
                "cron {field_name}字段无效：{raw}（范围 {min}–{max}，{reason}）"
            ),
        }
    }
}

impl std::error::Error for CronError {}

/// 5 段式 cron 表达式解析（分 时 日 月 周；语义对齐前端校验器
/// workflowScheduler.ts:169-205）
///
/// 拒绝：空串、`@` 宏（@daily 等）、6 字段（含秒）与非 5 字段；字段级错误
/// 带定位（index 0-4 = 分 时 日 月 周）与中文原因。
pub fn parse_cron(expression: &str) -> Result<CronSchedule, CronError> {
    let raw = expression.trim();
    if raw.is_empty() {
        return Err(CronError::Empty);
    }
    // @ 宏：对齐前端 :177-180 的拒绝分支
    if raw.starts_with('@') {
        return Err(CronError::MacroNotSupported);
    }
    let fields: Vec<&str> = raw.split_whitespace().collect();
    if fields.len() != 5 {
        return Err(CronError::WrongFieldCount {
            actual: fields.len(),
        });
    }
    // 字段边界与中文名（对齐前端 CRON_FIELD_BOUNDS 与 names 数组
    // workflowScheduler.ts:100-106、:197）
    const BOUNDS: [(u32, u32); 5] = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)];
    const NAMES: [&str; 5] = ["分钟", "小时", "日", "月", "周"];
    let parsed: Vec<CronField> = fields
        .iter()
        .enumerate()
        .map(|(i, field)| {
            let (min, max) = BOUNDS[i];
            parse_cron_field(field, min, max).map_err(|reason| CronError::FieldInvalid {
                index: i,
                field_name: NAMES[i].to_string(),
                raw: (*field).to_string(),
                min,
                max,
                reason,
            })
        })
        .collect::<Result<_, _>>()?;
    // 字段数已在上方锁定为 5；数组转换失败仅防御性返回结构化错误，
    // 不用 panic 表达不可达状态。
    let [minute, hour, day_of_month, month, day_of_week]: [CronField; 5] = parsed
        .try_into()
        .map_err(|fields: Vec<CronField>| CronError::WrongFieldCount {
            actual: fields.len(),
        })?;
    Ok(CronSchedule {
        minute,
        hour,
        day_of_month,
        month,
        day_of_week,
    })
}

/// 1-2 位 ASCII 数字解析（对齐前端 `\d{1,2}` 语义；"00" → 0，
/// 空串/三位及以上/非数字 → None）
fn parse_1to2_digits(s: &str) -> Option<u32> {
    if s.is_empty() || s.len() > 2 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// 范围越界检查（lo/hi 须落在 [min, max] 内）
fn check_bounds(lo: u32, hi: u32, min: u32, max: u32) -> Result<(), String> {
    if lo < min || hi > max {
        return Err(format!("数值越界：须在 {min}-{max} 之间"));
    }
    Ok(())
}

/// 等差序列展开（首项 lo，步长 step，超过 hi 即终止；`*/n` 即
/// lo=min、hi=max 的调用形态；调用方保证 step >= 1 且 lo <= hi）
fn step_range(lo: u32, hi: u32, step: u32) -> impl Iterator<Item = u32> {
    (0u32..)
        .map(move |k| lo + k * step)
        .take_while(move |&v| v <= hi)
}

/// 组装字段（值集去重升序；text 保留原文）
fn make_field(text: &str, values: impl IntoIterator<Item = u32>) -> CronField {
    let values: Vec<u32> = values
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    CronField {
        text: text.to_string(),
        values,
    }
}

/// 解析单个 cron 字段（语义逐项对齐前端 isValidCronField
/// workflowScheduler.ts:113-159：`*`、`n`、`a-b`、列表、`*/step`、`a-b/step`、
/// `n/step`；列表内不允许步进；返回结构化原因供上层定位）
fn parse_cron_field(field: &str, min: u32, max: u32) -> Result<CronField, String> {
    let f = field.trim();
    if f.is_empty() {
        return Err("字段为空".into());
    }
    if f == "*" {
        return Ok(make_field(f, min..=max));
    }
    // 步进形态：*/n、a-b/n、n/n（对齐前端 stepMatch 正则
    // `^(\*|\d{1,2}(?:-\d{1,2})?)/(\d{1,2})$`）
    if let Some((base, step_str)) = f.split_once('/') {
        let step = parse_1to2_digits(step_str)
            .ok_or_else(|| "非法步进：步进须为 1-2 位正整数".to_string())?;
        if step == 0 {
            return Err("非法步进：步进必须大于 0".into());
        }
        if base == "*" {
            // 前端对 */step 额外校验 step <= max（拒绝 */60 类写法）
            if step > max {
                return Err(format!("步进越界：*/{step} 超出字段上限 {max}"));
            }
            return Ok(make_field(f, step_range(min, max, step)));
        }
        if let Some((a, b)) = base.split_once('-') {
            let lo = parse_1to2_digits(a)
                .ok_or_else(|| "非法格式：范围起点须为 1-2 位数字".to_string())?;
            let hi = parse_1to2_digits(b)
                .ok_or_else(|| "非法格式：范围终点须为 1-2 位数字".to_string())?;
            if lo > hi {
                return Err("非法范围：范围起点不能大于终点".into());
            }
            check_bounds(lo, hi, min, max)?;
            return Ok(make_field(f, step_range(lo, hi, step)));
        }
        let n = parse_1to2_digits(base)
            .ok_or_else(|| "非法格式：步进基数须为 *、单值或 a-b 范围".to_string())?;
        check_bounds(n, n, min, max)?;
        // n/step：从 n 起步进至字段上限（前端对单值步进不校验 step 上限）
        return Ok(make_field(f, step_range(n, max, step)));
    }
    // 列表 / 单值 / 范围（不含步进——前端 split(',') 后逐项校验，列表内
    // 步进写法 `15/5` 因不匹配 `^\d{1,2}$` 被拒绝，本处同样拒绝）
    let mut set: BTreeSet<u32> = BTreeSet::new();
    for part in f.split(',') {
        let p = part.trim();
        if p.is_empty() {
            return Err("非法格式：列表含空项".into());
        }
        if let Some((a, b)) = p.split_once('-') {
            let lo = parse_1to2_digits(a)
                .ok_or_else(|| "非法格式：范围起点须为 1-2 位数字".to_string())?;
            let hi = parse_1to2_digits(b)
                .ok_or_else(|| "非法格式：范围终点须为 1-2 位数字".to_string())?;
            if lo > hi {
                return Err("非法范围：范围起点不能大于终点".into());
            }
            check_bounds(lo, hi, min, max)?;
            set.extend(lo..=hi);
        } else {
            let n =
                parse_1to2_digits(p).ok_or_else(|| "非法格式：须为数字、范围或 *".to_string())?;
            check_bounds(n, n, min, max)?;
            set.insert(n);
        }
    }
    Ok(CronField {
        text: f.to_string(),
        values: set.into_iter().collect(),
    })
}
