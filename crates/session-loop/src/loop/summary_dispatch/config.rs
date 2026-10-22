//! 摘要调度配置面：单 episode 退避配置 [SummaryDispatchConfig] 与跨 episode
//! 低功耗护栏配置 [SummaryRetryGuardConfig]（含 session_meta 读取 helper）。

use super::{
    DEFAULT_RETRY_GUARD_MAX_ATTEMPTS, DEFAULT_RETRY_GUARD_WINDOW_MS, LOOP_SUMMARY_MAX_WALL_MS,
    MAX_SUMMARY_ATTEMPTS, META_KEY_SUMMARY_BACKOFF_MS, META_KEY_SUMMARY_MAX_ATTEMPTS,
    META_KEY_SUMMARY_RETRY_WINDOW_MS, META_KEY_SUMMARY_WALL_MS, SUMMARY_BACKOFF_MS,
    SUMMARY_JITTER_RATIO,
};

/// 摘要调度器配置（可注入测试参数；生产缺省见 [Default]）。
/// 注：jitter 为 f64，不派生 Eq（浮点无 Eq 语义），比较以 PartialEq 为准。
#[derive(Debug, Clone, PartialEq)]
pub struct SummaryDispatchConfig {
    /// 退避序列（毫秒；测试注入快速序列 + jitter=0.0 得确定性序列）
    pub backoff_ms: Vec<u64>,
    /// jitter 幅度（0.0 ~ 0.2；0.0 = 确定性退避，测试断言用）
    pub jitter: f64,
    /// 单次调用墙钟上限（毫秒）
    pub max_wall_ms: u64,
    /// 累计尝试上限（含同步那次；默认 [MAX_SUMMARY_ATTEMPTS]）
    pub max_attempts: u32,
}

impl Default for SummaryDispatchConfig {
    fn default() -> Self {
        Self {
            backoff_ms: SUMMARY_BACKOFF_MS.to_vec(),
            jitter: SUMMARY_JITTER_RATIO,
            max_wall_ms: LOOP_SUMMARY_MAX_WALL_MS,
            max_attempts: MAX_SUMMARY_ATTEMPTS,
        }
    }
}

/// 解析 session_meta 键值 → [SummaryDispatchConfig]（T-44 配置读取 helper；
/// 缺省值兜底——键缺失 / 解析失败均回退生产缺省并 warn，不 panic）。
///
/// `meta`：键 → 值读取面（壳层经 `LocalDb::get_session_meta` 注入；
/// 测试注入内存表）。`backoff_ms` 值接受：
/// - JSON 数组（`[1000,3000,9000]`）→ 逐项取整（非法项丢弃，空数组回退）；
/// - 单个数值（退避基数）→ 退化为单元素序列；
/// - 其余形态 → 回退 [SUMMARY_BACKOFF_MS]。
impl SummaryDispatchConfig {
    pub fn from_session_meta(meta: impl Fn(&str) -> Option<String>, max_attempts: u32) -> Self {
        let backoff_ms = meta(META_KEY_SUMMARY_BACKOFF_MS)
            .as_deref()
            .and_then(parse_backoff_ms)
            .unwrap_or_else(|| {
                tracing::warn!(
                    key = META_KEY_SUMMARY_BACKOFF_MS,
                    "退避配置缺失/非法 → 缺省 [1000,3000,9000]"
                );
                SUMMARY_BACKOFF_MS.to_vec()
            });
        let max_wall_ms = meta(META_KEY_SUMMARY_WALL_MS)
            .as_deref()
            .and_then(|raw| raw.trim().parse::<u64>().ok())
            .filter(|v| *v > 0)
            .unwrap_or_else(|| {
                tracing::warn!(
                    key = META_KEY_SUMMARY_WALL_MS,
                    default = LOOP_SUMMARY_MAX_WALL_MS,
                    "墙钟配置缺失/非法 → 缺省 60000ms"
                );
                LOOP_SUMMARY_MAX_WALL_MS
            });
        Self {
            backoff_ms,
            jitter: SUMMARY_JITTER_RATIO,
            max_wall_ms,
            max_attempts,
        }
    }
}

/// 解析退避序列值（JSON 数组 / 单个数值；非法返回 None 触发缺省兜底）
fn parse_backoff_ms(raw: &str) -> Option<Vec<u64>> {
    let trimmed = raw.trim();
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        match value {
            serde_json::Value::Array(items) => {
                let parsed: Vec<u64> = items
                    .into_iter()
                    .filter_map(|item| item.as_u64().filter(|v| *v > 0))
                    .collect();
                if parsed.is_empty() {
                    None
                } else {
                    Some(parsed)
                }
            }
            serde_json::Value::Number(n) => n.as_u64().filter(|v| *v > 0).map(|v| vec![v]),
            _ => None,
        }
    } else if let Ok(v) = trimmed.parse::<u64>() {
        if v > 0 {
            Some(vec![v])
        } else {
            None
        }
    } else {
        None
    }
}

// ── E2 F2 层 1 低功耗模式：跨 episode 累计尝试护栏（07 §5.1/§5.2）───────

/// 低功耗护栏配置（E2 F2 层 1 两新键：`compact_summary_max_attempts` 默认 8
/// + `compact_summary_retry_window_ms` 默认 30min）。
///
/// 与 [SummaryDispatchConfig] 的区分：后者是**单 episode** 的主动退避参数
/// （backoff / 墙钟 / max_attempts=4）；本结构是**跨 episode** 的累计成本
/// 护栏——废除 retired 永驻后，被动触发（用户消息边界 F3 / 新 run / 下一
/// 次压缩）可反复重新触发摘要，累计尝试次数须有窗口护栏防无界成本。
///
/// 壳层装配：`SessionLoopOptions::compact_summary_max_attempts` /
/// `compact_summary_retry_window_ms` 字段（loop/mod.rs），经
/// [SummaryDispatch::set_retry_guard] 接线 run 级调度器；session_meta
/// 读取由 [SummaryRetryGuardConfig::from_session_meta] 提供（壳层经
/// session_meta 装配由后续批次接线，本结构为读取 helper）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SummaryRetryGuardConfig {
    /// 窗口内累计尝试上限（含同步那次；0 = 禁用摘要重试——窗口护栏拒绝
    /// 一切触发，防无界成本）
    pub max_attempts: u32,
    /// 低功耗观察窗口（毫秒）：窗口过期后尝试计数重置（窗口内 0 次被动
    /// 触发则重置计数），之后可再试
    pub retry_window_ms: u64,
}

impl Default for SummaryRetryGuardConfig {
    fn default() -> Self {
        Self {
            max_attempts: DEFAULT_RETRY_GUARD_MAX_ATTEMPTS,
            retry_window_ms: DEFAULT_RETRY_GUARD_WINDOW_MS,
        }
    }
}

impl SummaryRetryGuardConfig {
    /// 解析 session_meta 键值 → 低功耗护栏配置（T-44 配置读取 helper；
    /// 键缺失 / 解析失败均回退缺省并 warn，不 panic）。
    ///
    /// 消费键：`compact_summary_max_attempts`（u32 > 0）、
    /// `compact_summary_retry_window_ms`（u64 > 0）。
    pub fn from_session_meta(meta: impl Fn(&str) -> Option<String>) -> Self {
        let max_attempts = meta(META_KEY_SUMMARY_MAX_ATTEMPTS)
            .as_deref()
            .and_then(|raw| raw.trim().parse::<u32>().ok())
            .filter(|v| *v > 0)
            .unwrap_or_else(|| {
                tracing::warn!(
                    key = META_KEY_SUMMARY_MAX_ATTEMPTS,
                    default = DEFAULT_RETRY_GUARD_MAX_ATTEMPTS,
                    "护栏尝试上限配置缺失/非法 → 缺省 8"
                );
                DEFAULT_RETRY_GUARD_MAX_ATTEMPTS
            });
        let retry_window_ms = meta(META_KEY_SUMMARY_RETRY_WINDOW_MS)
            .as_deref()
            .and_then(|raw| raw.trim().parse::<u64>().ok())
            .filter(|v| *v > 0)
            .unwrap_or_else(|| {
                tracing::warn!(
                    key = META_KEY_SUMMARY_RETRY_WINDOW_MS,
                    default = DEFAULT_RETRY_GUARD_WINDOW_MS,
                    "观察窗口配置缺失/非法 → 缺省 1800000ms"
                );
                DEFAULT_RETRY_GUARD_WINDOW_MS
            });
        Self {
            max_attempts,
            retry_window_ms,
        }
    }
}
