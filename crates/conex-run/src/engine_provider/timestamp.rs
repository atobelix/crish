//! 时间戳与消息 id 域（SR-04 拆分 · engine_provider.rs → engine_provider/timestamp.rs）
//!
//! 承载进程内唯一消息 id 生成；ISO8601 时间戳统一取自
//! `conex_shared::time::now_iso_utc`。头钉：SR-04 · 拆分 · ≠ EL。

use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};

/// 消息 id 生成（前缀 + 毫秒时间戳 + 计数器，进程内唯一）
pub fn new_message_id(prefix: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let now_ms = conex_shared::time::unix_millis();
    format!(
        "{prefix}-{now_ms}-{}",
        COUNTER.fetch_add(1, Ordering::SeqCst)
    )
}

/// 用户消息构造（run-task 下发 prompt）
///
/// 21-log §5.2 缺口 2 修复：`client_message_id` 填 run-task 下发的 user id
/// （03 §5.3-4：message-end 稳定幂等键）。
pub fn user_message(prompt: &str, client_message_id: Option<&str>) -> AgentMessage {
    user_message_with_content(prompt, client_message_id, None)
}

/// 用户消息构造（含 IPC content 桥，plans/04 §4.2）
///
/// `content_parts` 为 OpenAI 形 parts（`type: image_url` 等），写入
/// `metadata.contentParts` ——出站多模态守卫与四轨图形状都从这里读，
/// 否则生产永远看不到 `ImageUrl`（M5：无 content 则守卫假绿）。
pub fn user_message_with_content(
    prompt: &str,
    client_message_id: Option<&str>,
    content_parts: Option<Value>,
) -> AgentMessage {
    AgentMessage {
        id: new_message_id("user"),
        role: AgentMessageRole::User,
        created_at: conex_shared::time::now_iso_utc(),
        blocks: vec![AgentMessageBlock::Text {
            text: prompt.to_string(),
        }],
        metadata: content_parts.map(|parts| json!({ "contentParts": parts })),
        client_message_id: client_message_id.map(str::to_string),
        content: None,
    }
}
