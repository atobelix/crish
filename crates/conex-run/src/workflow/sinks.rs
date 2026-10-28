//! steering 落点与 workflow 域事件广播契约。

use std::sync::{Arc, Mutex};

use orchestrator::steering_queue::SteeringInputEntry;
use orchestrator::PendingMessageQueue;

use crate::workflow::CRON_ID_PREFIX;

// ── steering 落点（§4.7：唤醒走 steering 面而非事件面）────────────────

/// steering 条目落点（PendingMessageQueue 适配；触发 / 立即执行共用）
pub trait SteeringSink: Send + Sync {
    /// 写入一条 steering 条目（group_id = cron-<cronId>，replaceOrEnqueue 去重）。
    /// 当 `target_session_id` 为有效非空会话 ID 时路由至该目标会话，否则回退至 `sched-<cron_id>`。
    fn enqueue_steering(
        &self,
        cron_id: &str,
        text: String,
        enqueued_at_ms: u64,
        target_session_id: Option<&str>,
    );
}

/// PendingMessageQueue 适配（与 sched.rs QueuePendingSink 同构）
#[derive(Clone)]
pub struct QueueSteeringSink {
    queue: Arc<Mutex<PendingMessageQueue>>,
}

impl QueueSteeringSink {
    pub fn new(queue: Arc<Mutex<PendingMessageQueue>>) -> Self {
        Self { queue }
    }
}

impl SteeringSink for QueueSteeringSink {
    fn enqueue_steering(
        &self,
        cron_id: &str,
        text: String,
        enqueued_at_ms: u64,
        target_session_id: Option<&str>,
    ) {
        let entry = SteeringInputEntry {
            session_id: crate::sched::resolve_steering_session_id(cron_id, target_session_id),
            id: format!("{cron_id}-{enqueued_at_ms}"),
            text,
            attachments: Vec::new(),
            enqueued_at: enqueued_at_ms,
            group_id: Some(format!("{CRON_ID_PREFIX}{cron_id}")),
            is_steering: true,
        };
        let mut queue = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        queue.replace_or_enqueue(entry);
    }
}

/// workflow 全域事件广播契约（IPC 命令路径 / 工具通道路径 / 定时触发
/// 回调共用；发射失败仅留痕不阻断注册主流程——事件是通知面，不是落盘面。
/// Tauri 实现留壳层装配侧注入）
pub trait WorkflowEventSink: Send + Sync {
    /// 发射一条 workflow 域事件（`workflow:created` / `workflow:updated` /
    /// `workflow:deleted` / `workflow:run-Completed`）
    fn emit(&self, event: &str, payload: serde_json::Value);
}
