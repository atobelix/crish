//! 时间戳与消息 id 域（SR-04 拆分 · engine_provider.rs → engine_provider/timestamp.rs）
//!
//! 承载当前 UTC ISO8601 时间戳换算与进程内唯一消息 id 生成。无 chrono 依赖，
//! 手工换算（Howard Hinnant civil-from-days 算法，与 orchestrator / session-loop
//! 同源）。头钉：SR-04 · 拆分 · ≠ EL。

use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use std::sync::atomic::{AtomicU64, Ordering};

/// 当前 UTC 时间 ISO8601 字符串（毫秒精度，`2026-07-31T08:00:00.000Z`）
pub(crate) fn now_iso_utc() -> String {
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
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (y + if m <= 2 { 1 } else { 0 }, m, d)
}

/// 消息 id 生成（前缀 + 毫秒时间戳 + 计数器，进程内唯一）
pub(crate) fn new_message_id(prefix: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    format!(
        "{prefix}-{now_ms}-{}",
        COUNTER.fetch_add(1, Ordering::SeqCst)
    )
}

/// 用户消息构造（run-task 下发 prompt）
///
/// 21-log §5.2 缺口 2 修复：`client_message_id` 填 run-task 下发的 user id
/// （03 §5.3-4：message-end 稳定幂等键）。
pub(crate) fn user_message(prompt: &str, client_message_id: Option<&str>) -> AgentMessage {
    AgentMessage {
        id: new_message_id("user"),
        role: AgentMessageRole::User,
        created_at: now_iso_utc(),
        blocks: vec![AgentMessageBlock::Text {
            text: prompt.to_string(),
        }],
        metadata: None,
        client_message_id: client_message_id.map(str::to_string),
        content: None,
    }
}
