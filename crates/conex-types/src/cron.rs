//! Cron 调度纯函数（T-CF-08：02-CF 定时唤醒与工具方案 §4.4 冻结接口）
//!
//! 模块职责：
//! - [parse_cron]：5 段式 cron 表达式解析（分 时 日 月 周），语义逐项对齐前端
//!   校验器 workflowScheduler.ts:99-205（`*`、`n`、`a-b`、列表、`*/step`、
//!   `a-b/step`、`n/step` 全语法）；
//! - [CronSchedule::next_fire_after]：after_ms 之后第一个命中时刻（本地时区
//!   语义，固定偏移展开；无命中返回 None）；
//! - [CronSchedule::cron_label]：人类可读标签（对齐前端 cronExpressionLabel
//!   workflowScheduler.ts:212-241）。
//!
//! 零依赖约束：时间计算全用 std（公历换算采用 Hinnant 算法），本地时区偏移
//! 解析走平台 API（Windows：kernel32 GetLocalTime，见 [local_utc_offset_minutes]），
//! 不引入 chrono 类依赖（T-CF-08 约束：不改 Cargo.toml）。
//!
//! ## 语义选择（任务书 T-CF-08 定稿，与前端标签逻辑对齐）
//!
//! 1. **月/日/周 联合匹配 = AND**：month、day-of-month、day-of-week 三域**都命中
//!    才触发**（「两域都命中才触发」的常见语义，任务书 :729 明示；与 Vixie
//!    cron 的「任一域命中即触发」OR 语义不同）——「0 0 30 2 *」（2 月 30 日）
//!    恒无命中，返回 None。
//! 2. **本地时区 = after_ms 时刻的固定偏移**：一次调用取定偏移并全程使用，
//!    不做 DST 切换窗口内的小时级精修（春令时跳变 02:00-03:00 等墙钟不连续
//!    窗口由引擎侧按需兜底；确定性测试走 [CronSchedule::next_fire_after_in_offset]）。
//! 3. **步进语义对齐前端**：`a-b/n` 展开为 a..=b 的等差序列（首项 a，步长 n，
//!    可越过 b 之后部分项被截断）；`n/step` 从 n 起步进至字段上限；`*/n` 要求
//!    n ≤ 上限（前端拒绝 `*/60`）；列表内不允许步进（前端 split(',') 后逐项
//!    只校验单值/范围）。
//! 4. **dow 0-7**：0 与 7 都表示周日（前端 CRON_FIELD_BOUNDS 注释同源）。

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

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

/// cron 解析错误（结构化：字段定位 + 中文文案，对齐前端拒绝文案
/// workflowScheduler.ts:169-205；serde 形态对齐 CoreError 先例 lib.rs:276-291）
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
    // 逆序 pop 还原五个字段（字段数已锁定为 5，pop 不会落空）
    let mut parsed = parsed;
    let day_of_week = parsed.pop().expect("字段数已锁定为 5");
    let month = parsed.pop().expect("字段数已锁定为 5");
    let day_of_month = parsed.pop().expect("字段数已锁定为 5");
    let hour = parsed.pop().expect("字段数已锁定为 5");
    let minute = parsed.pop().expect("字段数已锁定为 5");
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

// ── 公历换算（Hinnant 算法，std-only；日期算术的单一事实源）──

/// 自 1970-01-01 起的天数 → 公历（年, 月, 日）
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
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

/// 公历（年, 月, 日）→ 自 1970-01-01 起的天数
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// 星期（0 = 周日，与 cron dow 0-7 语义对齐；1970-01-01 为周四）
fn weekday_sunday0(days: i64) -> u32 {
    (days + 4).rem_euclid(7) as u32
}

/// epoch 毫秒 + 时区偏移 → 本地墙钟字段（年 月 日 时 分；秒与毫秒不参与
/// cron 匹配，直接丢弃——触发时刻恒为整分钟）
fn epoch_ms_to_local_fields(after_ms: u64, offset_minutes: i32) -> (i64, u32, u32, u32, u32) {
    let total_secs = (after_ms / 1000) as i64 + i64::from(offset_minutes) * 60;
    let days = total_secs.div_euclid(86_400);
    let secs_of_day = total_secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let h = (secs_of_day / 3_600) as u32;
    let min = ((secs_of_day % 3_600) / 60) as u32;
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
    utc_secs as u64 * 1000
}

/// 周字段命中判定（7 与 0 都表周日：值集含 wd，或 wd==0 且值集含 7）
fn dow_field_matches(field: &CronField, weekday_sunday0: u32) -> bool {
    field.values.contains(&weekday_sunday0) || (weekday_sunday0 == 0 && field.values.contains(&7))
}

impl CronSchedule {
    /// 下一次触发时刻（after_ms **之后**第一个命中时刻；无命中返回 None）
    ///
    /// 本地时区语义：偏移取 after_ms 时刻的本地 UTC 偏移并全程固定（DST
    /// 切换窗口内不做小时级精修，见模块文档「语义选择」）；确定性计算走
    /// [CronSchedule::next_fire_after_in_offset]。
    pub fn next_fire_after(&self, after_ms: u64) -> Option<u64> {
        self.next_fire_after_in_offset(after_ms, local_utc_offset_minutes())
    }

    /// 带时区偏移的触发时刻计算（内部与测试入口：偏移注入保证确定性；
    /// 引擎侧若会话配置了明确 IANA 时区，可据其偏移复用本入口）
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
    /// 常见模式短标签 + 表达式回显；非法表达式由 [parse_cron] 拒绝，
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

// ── 本地时区偏移解析（零依赖：Windows 走 kernel32，其余平台按 UTC）──

/// 本地时区偏移（分钟；UTC+8 返回 480；返回调用时刻生效的偏移，含夏令时）
#[cfg(windows)]
fn local_utc_offset_minutes() -> i32 {
    local_offset_via_win32()
}

/// 本地时区偏移（分钟）
///
/// 非 Windows 平台：std 不提供本地时区查询接口，按 UTC（偏移 0）处理。
/// 本项目引擎目标平台为 Windows 桌面（Tauri 壳），Unix 端如需本地时区
/// 语义需引入 chrono 类依赖（T-CF-08 零依赖约束不允许），留待后续轮次。
#[cfg(not(windows))]
fn local_utc_offset_minutes() -> i32 {
    0
}

/// Win32 本地时间读取（kernel32 GetLocalTime，零依赖 FFI）
///
/// 思路：GetLocalTime 返回当前本地墙钟（年/月/日/时/分/秒），把墙钟按偏移 0
/// 折算成假想 epoch 秒，与真实 UTC epoch 秒相减即得当前生效的 UTC 偏移
/// （含夏令时）。两次读数之间的亚秒竞态最多造成 ±1 分钟误差，仅在 DST
/// 边界时刻可能短暂影响偏移取值，下一调用自动纠正。
#[cfg(windows)]
fn local_offset_via_win32() -> i32 {
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Win32 SYSTEMTIME（GetLocalTime 输出结构；8 个 u16 顺序字段）
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct SystemTimeFields {
        w_year: u16,
        w_month: u16,
        w_day_of_week: u16,
        w_day: u16,
        w_hour: u16,
        w_minute: u16,
        w_second: u16,
        w_milliseconds: u16,
    }

    #[link(name = "kernel32")]
    extern "system" {
        /// 取当前本地墙钟（kernel32；无失败返回值，恒成功）
        fn GetLocalTime(lp_system_time: *mut SystemTimeFields);
    }

    let mut st = SystemTimeFields::default();
    // 豁免 unsafe_code：只读系统调用，仅写入栈上结构体（Win32 文档保证
    // 调用成功后全部字段有效），无指针逃逸与生命周期问题，对齐
    // agent-provider credentials.rs 的 DPAPI FFI 评审先例。
    #[allow(unsafe_code)]
    // SAFETY: GetLocalTime 恒成功（kernel32 无失败返回值），调用成功时全部字段
    // 有效（Win32 文档保证）；仅写栈上 SystemTimeFields POD（repr(C) 8×u16），
    // 无指针逃逸；外部函数声明与结构布局已核对
    unsafe {
        GetLocalTime(&mut st);
    }
    let local_epoch_secs = days_from_civil(
        i64::from(st.w_year),
        u32::from(st.w_month),
        u32::from(st.w_day),
    ) * 86_400
        + i64::from(st.w_hour) * 3_600
        + i64::from(st.w_minute) * 60
        + i64::from(st.w_second);
    let utc_epoch_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    ((local_epoch_secs - utc_epoch_secs) / 60) as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试辅助：构造固定墙钟时刻的 epoch 毫秒（UTC 偏移展开，秒恒 0）
    fn utc_ms(y: i64, m: u32, d: u32, h: u32, min: u32) -> u64 {
        local_fields_to_epoch_ms(y, m, d, h, min, 0)
    }

    // ── 解析：合法表达式（T-CF-08 验收 1）──

    /// T-CF-08 验收：任务书五条合法表达式全部解析成功（覆盖 *、n、a-b、
    /// 列表、*/step、a-b/step 语法；对齐前端 workflowScheduler.test.ts:36-42）
    #[test]
    fn cron_parse_valid_expressions() {
        for expr in [
            "0 9 * * *",
            "*/5 * * * *",
            "0 8-10 * * 1-5",
            "30 4 1,15 * *",
            "0 0 * * 0",
        ] {
            parse_cron(expr).unwrap_or_else(|e| panic!("{expr} 应解析成功：{e}"));
        }
        // 额外覆盖：*/step 上限值、a-b/step、n/step（前端允许）、列表内范围、
        // dow=7、多位空格分隔
        for expr in [
            "*/30 * * * *",
            "0-59/5 * * * *",
            "5/10 * * * *",
            "0 0 1-15 * 1,3,5",
            "0 0 * * 7",
            "0  9  *  *  *",
        ] {
            parse_cron(expr).unwrap_or_else(|e| panic!("{expr} 应解析成功：{e}"));
        }
    }

    /// 展开语义锚定：值集展开（* = 全集、*/5 = 5 的倍数、a-b = 闭区间、
    /// a-b/step = 等差序列、n/step = 从 n 起步进至上限、列表 = 合并）
    #[test]
    fn cron_field_values_expanded_correctly() {
        let sched = parse_cron("*/5 * * * *").unwrap();
        assert_eq!(
            sched.minute.values,
            vec![0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]
        );
        assert_eq!(sched.minute.text, "*/5", "原文保留（回显用）");

        let sched = parse_cron("0 8-10 * * 1-5").unwrap();
        assert_eq!(sched.hour.values, vec![8, 9, 10], "a-b 闭区间展开");
        assert_eq!(sched.day_of_week.values, vec![1, 2, 3, 4, 5]);

        let sched = parse_cron("0-59/20 * * * *").unwrap();
        assert_eq!(sched.minute.values, vec![0, 20, 40], "a-b/step 等差序列");

        let sched = parse_cron("5/10 * * * *").unwrap();
        assert_eq!(
            sched.minute.values,
            vec![5, 15, 25, 35, 45, 55],
            "n/step 至上限"
        );

        let sched = parse_cron("30 4 1,15 * *").unwrap();
        assert_eq!(sched.day_of_month.values, vec![1, 15], "列表展开");

        let sched = parse_cron("* * * * *").unwrap();
        assert_eq!(
            sched.day_of_week.values,
            (0..=7).collect::<Vec<_>>(),
            "* 展开为全集"
        );
    }

    // ── 解析：非法表达式（T-CF-08 验收 2）──

    /// T-CF-08 验收：非法表达式全部拒绝且带字段定位
    #[test]
    fn cron_parse_rejects_invalid() {
        // 6 字段（含秒）：字段数定位（文案对齐前端 :181-187）
        let err = parse_cron("0 0 0 * * *").unwrap_err();
        assert!(
            matches!(err, CronError::WrongFieldCount { actual: 6 }),
            "6 字段必须拒绝：{err:?}"
        );
        assert_eq!(
            err.to_string(),
            "不支持 6 字段（含秒）cron，请用 5 字段：分 时 日 月 周"
        );

        // @ 宏（文案对齐前端 :177-180）
        let err = parse_cron("@daily").unwrap_err();
        assert!(matches!(err, CronError::MacroNotSupported));
        assert_eq!(
            err.to_string(),
            "不支持 @yearly 等 cron 宏，请用 5 字段表达式"
        );
        assert!(parse_cron("@yearly * * * *").is_err(), "@ 开头一律拒绝");

        // 非 5 字段：4 字段与 7 字段
        let err = parse_cron("0 9 * *").unwrap_err();
        assert!(matches!(err, CronError::WrongFieldCount { actual: 4 }));
        assert!(matches!(
            parse_cron("0 0 0 0 0 0 0").unwrap_err(),
            CronError::WrongFieldCount { actual: 7 }
        ));

        // 越界字段：minute=60 → 字段定位 0（分钟）
        match parse_cron("60 * * * *").unwrap_err() {
            CronError::FieldInvalid {
                index,
                field_name,
                raw,
                min,
                max,
                reason,
            } => {
                assert_eq!(index, 0, "字段定位必须为分钟");
                assert_eq!(field_name, "分钟");
                assert_eq!(raw, "60");
                assert_eq!((min, max), (0, 59));
                assert!(reason.contains("越界"), "原因应含越界：{reason}");
            }
            other => panic!("应返回字段级错误，实际 {other:?}"),
        }

        // 越界字段：hour=24（定位 1）、dom=0（定位 2）、month=13（定位 3）、
        // dow=8（定位 4）
        assert!(matches!(
            parse_cron("0 24 * * *").unwrap_err(),
            CronError::FieldInvalid { index: 1, .. }
        ));
        assert!(matches!(
            parse_cron("0 0 0 * *").unwrap_err(),
            CronError::FieldInvalid { index: 2, .. }
        ));
        assert!(matches!(
            parse_cron("0 0 * 13 *").unwrap_err(),
            CronError::FieldInvalid { index: 3, .. }
        ));
        assert!(matches!(
            parse_cron("0 0 * * 8").unwrap_err(),
            CronError::FieldInvalid { index: 4, .. }
        ));

        // 非法步进：*/0（步进为 0）、*/60（分钟上限 59 内越界）
        let err = parse_cron("*/0 * * * *").unwrap_err();
        assert!(matches!(err, CronError::FieldInvalid { index: 0, .. }));
        let err = parse_cron("*/60 * * * *").unwrap_err();
        assert!(matches!(err, CronError::FieldInvalid { index: 0, .. }));
        assert!(err.to_string().contains("步进"), "文案应含步进原因");

        // 非法范围：a > b、三段连字符、列表空项、列表内步进（前端同拒）
        assert!(matches!(
            parse_cron("0 10-5 * * *").unwrap_err(),
            CronError::FieldInvalid { index: 1, .. }
        ));
        assert!(parse_cron("0 1-2-3 * * *").is_err(), "多段连字符拒绝");
        assert!(parse_cron("0 1,,2 * * *").is_err(), "列表空项拒绝");
        assert!(
            parse_cron("0 1,15/5 * * *").is_err(),
            "列表内步进拒绝（前端同语义）"
        );
        assert!(parse_cron("0 1- * * *").is_err(), "开放范围拒绝");
        assert!(parse_cron("*/-1 * * * *").is_err(), "负步进拒绝");

        // 空表达式
        assert!(matches!(parse_cron("").unwrap_err(), CronError::Empty));
        assert!(matches!(parse_cron("   ").unwrap_err(), CronError::Empty));
        assert_eq!(
            parse_cron("").unwrap_err().to_string(),
            "cron 表达式不能为空"
        );
    }

    /// 前端对照（双实现锁定）：workflowScheduler.test.ts:36-49 的 cron 用例
    /// 在 Rust 侧一一对应——"0 * * * *" 合法、"0 0 0 * * *"（6 字段）拒绝
    #[test]
    fn cron_parse_mirrors_frontend_test_cases() {
        assert!(
            parse_cron("0 * * * *").is_ok(),
            "前端合法用例 0 * * * * 必须解析成功"
        );
        let err = parse_cron("0 0 0 * * *").unwrap_err();
        assert!(
            matches!(err, CronError::WrongFieldCount { actual: 6 }),
            "前端 6 字段用例必须拒绝"
        );
    }

    /// CronError 结构化错误 serde 往返（tagged enum，kind + detail 形态）
    #[test]
    fn cron_error_serde_roundtrip() {
        for err in [
            CronError::Empty,
            CronError::MacroNotSupported,
            CronError::WrongFieldCount { actual: 6 },
            CronError::FieldInvalid {
                index: 0,
                field_name: "分钟".into(),
                raw: "60".into(),
                min: 0,
                max: 59,
                reason: "数值越界：须在 0-59 之间".into(),
            },
        ] {
            let json = serde_json::to_value(&err).unwrap();
            let back: CronError = serde_json::from_value(json).unwrap();
            assert_eq!(back, err, "CronError roundtrip 保真");
        }
    }

    // ── 触发时刻（T-CF-08 验收 3）──

    /// T-CF-08 验收：*/5 从整点后 1 秒起算 → 下一命中 = 该分钟内最近 5 的
    /// 倍数（构造固定时刻断言：2026-08-05 09:01:00 UTC 起算 → 09:05:00 UTC）
    #[test]
    fn cron_next_fire_after_known_sequence() {
        let sched = parse_cron("*/5 * * * *").unwrap();
        let after = utc_ms(2026, 8, 5, 9, 1);
        let next = sched
            .next_fire_after_in_offset(after, 0)
            .expect("必须有下一命中");
        assert_eq!(next, utc_ms(2026, 8, 5, 9, 5), "下一命中应为 09:05:00 UTC");

        // 严格大于：恰在命中时刻起算 → 跳过该命中
        assert_eq!(
            sched.next_fire_after_in_offset(utc_ms(2026, 8, 5, 9, 5), 0),
            Some(utc_ms(2026, 8, 5, 9, 10))
        );

        // 毫秒级起算：09:00:00.999 之后 → 09:05:00 仍为下一命中
        assert_eq!(
            sched.next_fire_after_in_offset(utc_ms(2026, 8, 5, 9, 0) + 999, 0),
            Some(utc_ms(2026, 8, 5, 9, 5))
        );

        // 跨日：23:58 起算 → 次日 00:00
        let daily = parse_cron("0 0 * * *").unwrap();
        assert_eq!(
            daily.next_fire_after_in_offset(utc_ms(2026, 8, 5, 23, 58), 0),
            Some(utc_ms(2026, 8, 6, 0, 0))
        );

        // 跨月：8 月 31 日 23:58 起算 → 9 月 1 日 00:00
        assert_eq!(
            daily.next_fire_after_in_offset(utc_ms(2026, 8, 31, 23, 58), 0),
            Some(utc_ms(2026, 9, 1, 0, 0))
        );

        // 跨年：2026-12-31 23:58 起算 → 2027-01-01 00:00
        assert_eq!(
            daily.next_fire_after_in_offset(utc_ms(2026, 12, 31, 23, 58), 0),
            Some(utc_ms(2027, 1, 1, 0, 0))
        );
    }

    /// T-CF-08 验收：2 月 30 日不存在 → 无命中返回 None（月/日联合匹配
    /// AND 语义，任务书 :737）
    #[test]
    fn cron_next_fire_after_month_dom() {
        let sched = parse_cron("0 0 30 2 *").unwrap();
        assert_eq!(
            sched.next_fire_after_in_offset(utc_ms(2026, 1, 1, 0, 0), 0),
            None
        );

        // 4 月 31 日同样恒无命中（AND 语义的另一个锚点）
        let apr31 = parse_cron("0 0 31 4 *").unwrap();
        assert_eq!(
            apr31.next_fire_after_in_offset(utc_ms(2026, 1, 1, 0, 0), 0),
            None
        );

        // 2 月 29 日：闰年命中（2028-02-29 00:00 UTC；从 2026-01-01 与
        // 2027-01-01 起算都会在 40 年窗口内遇到最近闰年——仅当日期不存在
        // 才返回 None，如 2 月 30 日）
        let leap = parse_cron("0 0 29 2 *").unwrap();
        assert_eq!(
            leap.next_fire_after_in_offset(utc_ms(2026, 1, 1, 0, 0), 0),
            Some(utc_ms(2028, 2, 29, 0, 0)),
            "2028 闰年 2 月 29 日必须命中"
        );
        assert_eq!(
            leap.next_fire_after_in_offset(utc_ms(2029, 1, 1, 0, 0), 0),
            Some(utc_ms(2032, 2, 29, 0, 0)),
            "最近闰年 2032 必须命中"
        );
    }

    /// 本地时区语义（固定偏移注入，确定性）：UTC+8 下 "0 9 * * *" 的
    /// 09:00 本地 = 01:00 UTC；偏移只平移墙钟，不改变相对间隔
    #[test]
    fn cron_next_fire_after_respects_offset() {
        let sched = parse_cron("0 9 * * *").unwrap();
        // 2026-08-05 23:00 UTC = 2026-08-06 07:00 UTC+8；本地 09:00（UTC+8）
        // = 2026-08-06 01:00 UTC
        let after_utc = utc_ms(2026, 8, 5, 23, 0);
        assert_eq!(
            sched.next_fire_after_in_offset(after_utc, 480),
            Some(utc_ms(2026, 8, 6, 1, 0))
        );
        // 同一起算时刻，UTC（偏移 0）下 09:00 在次日 09:00 UTC 命中
        assert_eq!(
            sched.next_fire_after_in_offset(after_utc, 0),
            Some(utc_ms(2026, 8, 6, 9, 0))
        );
    }

    /// dow 0-7 语义：dow=7 与 dow=0 都表周日（2026-08-06 为周四，
    /// 最近周日是 2026-08-09）
    #[test]
    fn cron_dow_seven_means_sunday() {
        for expr in ["0 0 * * 7", "0 0 * * 0"] {
            let sched = parse_cron(expr).unwrap();
            let next = sched
                .next_fire_after_in_offset(utc_ms(2026, 8, 6, 0, 0), 0)
                .unwrap_or_else(|| panic!("{expr} 必须命中最近周日"));
            assert_eq!(next, utc_ms(2026, 8, 9, 0, 0), "{expr} 的下一命中应为周日");
        }
    }

    /// 公开入口（本地时区）结构性断言：结果必在未来、整分钟对齐且距
    /// after_ms 不超过 10 分钟（精确值依赖机器时区，由注入偏移的确定性
    /// 测试覆盖；本测试只做公共面冒烟）
    #[test]
    fn cron_next_fire_after_public_path_structural() {
        let sched = parse_cron("*/5 * * * *").unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let next = sched.next_fire_after(now).expect("必须有下一命中");
        assert!(next > now, "命中必须严格晚于 after_ms");
        assert_eq!(next % 60_000, 0, "cron 命中时刻必须整分钟对齐");
        assert!(next - now < 10 * 60_000, "*/5 的下一命中距离应在 10 分钟内");
    }

    // ── 标签（T-CF-08 验收 4）──

    /// T-CF-08 验收：cron_label 人类可读（对齐前端 cronExpressionLabel
    /// workflowScheduler.ts:212-241——"0 9 * * *" 含 09:00 语义标签）
    #[test]
    fn cron_label_readable() {
        let sched = parse_cron("0 9 * * *").unwrap();
        let label = sched.cron_label();
        assert!(label.contains("每天 9 点"), "标签应含 09:00 语义：{label}");
        assert!(label.contains("0 9 * * *"), "标签应回显表达式：{label}");

        assert_eq!(
            parse_cron("*/5 * * * *").unwrap().cron_label(),
            "每 5 分钟 · */5 * * * *"
        );
        assert_eq!(
            parse_cron("0 * * * *").unwrap().cron_label(),
            "每小时 · 0 * * * *"
        );
        assert_eq!(
            parse_cron("0 0 * * 0").unwrap().cron_label(),
            "每周日 0 点 · 0 0 * * 0"
        );
        assert_eq!(
            parse_cron("0 0 * * 7").unwrap().cron_label(),
            "每周日 0 点 · 0 0 * * 7"
        );
        // 非常见模式：原样回显
        assert_eq!(
            parse_cron("30 4 1,15 * *").unwrap().cron_label(),
            "30 4 1,15 * *"
        );
    }

    // ── serde（derive 完整性；CronSchedule 无事件引用，不入注册表）──

    /// CronSchedule/CronField serde 往返保真（cron-fired 事件不引用本类型，
    /// 故不进事件注册表——registry_drift 可达性护栏禁止死条目）
    #[test]
    fn cron_schedule_serde_roundtrip() {
        let sched = parse_cron("0 8-10 * * 1-5").unwrap();
        let json = serde_json::to_value(&sched).unwrap();
        assert_eq!(json["hour"]["text"], "8-10");
        assert_eq!(json["hour"]["values"], serde_json::json!([8, 9, 10]));
        let back: CronSchedule = serde_json::from_value(json).unwrap();
        assert_eq!(sched, back);
    }
}
