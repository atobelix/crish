//! 调度 wire 形状 + daily/interval ↔ cron 转换与校验。

use conex_types::cron::parse_cron;
use serde::{Deserialize, Serialize};

/// 间隔分钟上限（对齐前端 WORKFLOW_INTERVAL_MINUTES_MAX = 60*24*7）
const INTERVAL_MINUTES_MAX: u64 = 60 * 24 * 7;

// ── 调度 wire 形状（对齐前端 workflowScheduler.ts 类型面）──────────────

/// 调度配置 wire（serde tag=type；与前端 WorkflowSchedule 逐项对应）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WorkflowScheduleWire {
    /// 手动（仅触发执行，无自动调度）
    Manual,
    /// 每日固定时刻（`M H * * *`；本地时区语义由 parse_cron 承载）
    Daily {
        /// HH:mm（00:00–23:59）
        time: String,
        /// IANA 时区名（命令层展示用；调度语义按本地时区）
        timezone: String,
    },
    /// 间隔分钟（`*/N * * * *` 近似语义，N 不整除 60 时漂移）
    IntervalMinutes {
        /// 间隔分钟（1–10080）
        interval_minutes: u64,
    },
    /// 5 字段标准 cron（前端双重校验通过后原样下发）
    Cron {
        /// cron 表达式原文
        expression: String,
    },
}

impl WorkflowScheduleWire {
    /// 从命令入参 JSON 解析（未知类型返回中文错误，不让 serde 英文文案裸奔）
    pub fn parse(value: &serde_json::Value) -> Result<Self, String> {
        let obj = value
            .as_object()
            .ok_or_else(|| "调度配置无效".to_string())?;
        let t = obj
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        match t.as_str() {
            "" | "manual" => Ok(Self::Manual),
            "daily" => {
                let time = obj
                    .get("time")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if !is_valid_daily_time(&time) {
                    return Err("每日时刻须为 HH:mm（00:00–23:59）".to_string());
                }
                let timezone = obj
                    .get("timezone")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if timezone.is_empty() {
                    return Err("时区不能为空，请使用 IANA 名称（如 Asia/Shanghai）".to_string());
                }
                Ok(Self::Daily { time, timezone })
            }
            "intervalMinutes" => {
                let raw = obj
                    .get("intervalMinutes")
                    .or_else(|| obj.get("minutes"))
                    .and_then(|v| v.as_u64());
                match raw {
                    Some(n) if (1..=INTERVAL_MINUTES_MAX).contains(&n) => {
                        Ok(Self::IntervalMinutes {
                            interval_minutes: n,
                        })
                    }
                    _ => Err(format!("间隔分钟须为 1–{} 的整数", INTERVAL_MINUTES_MAX)),
                }
            }
            "cron" => {
                let expression = obj
                    .get("expression")
                    .or_else(|| obj.get("cron"))
                    .or_else(|| obj.get("cronExpression"))
                    .or_else(|| obj.get("expr"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let normalized = validate_cron_expression(&expression)?;
                Ok(Self::Cron {
                    expression: normalized,
                })
            }
            "weekly" | "fileWatch" | "onFileChange" => Err(format!(
                "引擎暂不支持「{}」调度，请改用「每天」或「间隔分钟」",
                t
            )),
            _ => Err(format!("不支持的调度类型：{}", t)),
        }
    }
}

/// 每日时刻 HH:mm 合法性（00:00–23:59，对齐前端 isValidDailyTime）
fn is_valid_daily_time(value: &str) -> bool {
    let t = value.trim();
    if t.is_empty() {
        return false;
    }
    let mut parts = t.split(':');
    let (h, m) = match (parts.next(), parts.next(), parts.next()) {
        (Some(h), Some(m), None) => (h, m),
        _ => return false,
    };
    if !(h.len() == 2
        && m.len() == 2
        && h.chars().all(|c| c.is_ascii_digit())
        && m.chars().all(|c| c.is_ascii_digit()))
    {
        return false;
    }
    let hh: u32 = h.parse().unwrap_or(100);
    let mm: u32 = m.parse().unwrap_or(100);
    hh <= 23 && mm <= 59
}

/// 调度 → cron 表达式（manual 返回 None；边界语义见模块头注记）。
/// 时刻字段做数值归一（"09:30" → "30 9 * * *"，不保留零填充）
pub(crate) fn schedule_to_expression(schedule: &WorkflowScheduleWire) -> Option<String> {
    match schedule {
        WorkflowScheduleWire::Manual => None,
        WorkflowScheduleWire::Daily { time, .. } => {
            let (h, m) = time.split_once(':').unwrap_or(("0", "0"));
            let hh: u32 = h.parse().unwrap_or(0);
            let mm: u32 = m.parse().unwrap_or(0);
            Some(format!("{mm} {hh} * * *"))
        }
        WorkflowScheduleWire::IntervalMinutes { interval_minutes } => {
            Some(format!("*/{} * * * *", interval_minutes))
        }
        WorkflowScheduleWire::Cron { expression } => Some(expression.clone()),
    }
}

// ── cron 校验与 next_fire（委托 T-CF-08 解析器，真实 Rust 侧文案）──────

/// 校验 5 字段 cron 表达式（委托 `conex_types::cron::parse_cron`）。
///
/// 通过返回空白压缩的规范化表达式；失败返回**解析器真实中文错误文案**
/// （前端双重校验的第二道；T-CF-14 内容 4）。
pub(crate) fn validate_cron_expression(expr: &str) -> Result<String, String> {
    let normalized = expr.split_whitespace().collect::<Vec<_>>().join(" ");
    parse_cron(&normalized).map_err(|e| e.to_string())?;
    Ok(normalized)
}

/// 下一次触发时刻（委托 `CronSchedule::next_fire_after`，本地时区固定偏移；
/// 无未来命中时刻返回 None——如 2 月 30 日类表达式）
pub(crate) fn next_fire_after_ms(expression: &str, after_ms: u64) -> Option<u64> {
    parse_cron(expression).ok()?.next_fire_after(after_ms)
}

// ── 时间展示（ISO-8601 UTC；next_fire 为本地时刻，展示做 UTC 归一）──────

/// 从 epoch 天数求公历（年/月/日），Hinnant 逆算法
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// epoch 毫秒 → ISO-8601 UTC（`YYYY-MM-DDTHH:MM:SS.mmmZ`；前端 Date.parse 可直接解析）
pub(crate) fn epoch_ms_to_iso(ms: u64) -> String {
    let secs = ms / 1000;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, mo, d) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y,
        mo,
        d,
        h,
        m,
        s,
        ms % 1000
    )
}
