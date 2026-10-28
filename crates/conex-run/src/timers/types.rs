//! 定时器基础类型、事件契约与 Sink 适配器（§4.3，§4.7）

use std::sync::{Arc, Mutex};

use conex_types::events::AgentEvent;
use orchestrator::steering_queue::SteeringInputEntry;
use orchestrator::PendingMessageQueue;

/// 定时器 id 前缀（`timer-<seq>`，命名风格对齐 `task-<seq>` 先例）
pub const TIMER_ID_PREFIX: &str = "timer-";
/// 注册时长上限（秒，与工具 schema 一致）
pub const MAX_DURATION_SECONDS: u64 = 86400;

/// 当前 epoch 毫秒（定时器全域时间基准；实现复用
/// [crate::engine_assembly::unix_millis_now]，全 crate 单一时间源）
pub fn now_ms() -> u64 {
    crate::engine_assembly::unix_millis_now()
}

/// 从 timer id 解析序号（`timer-<seq>` → `seq`；恢复时推进分配器防撞 id）
pub fn timer_seq(timer_id: &str) -> Option<u64> {
    timer_id
        .strip_prefix(TIMER_ID_PREFIX)
        .and_then(|seq| seq.parse::<u64>().ok())
}

/// steering 分组名（group_id = `timer-<id>`，replaceOrEnqueue 去重；
/// 对齐 recovery.rs:371-380 的 build_steering_entry 分组模式）
pub fn steering_group_id(timer_id: &str) -> String {
    format!("{TIMER_ID_PREFIX}{timer_id}")
}

// ── 适配器契约（§4.3）──────────────────────────────────────────────

/// steering 条目落点（PendingMessageQueue 适配；到期 / 早退通知共用）
pub trait PendingSink: Send + Sync {
    /// 写入一条 steering 条目（group_id = timer-<id>，replaceOrEnqueue 去重；
    /// is_steering 受保护位，容量挤占时优先保留）
    fn enqueue_steering(&self, timer_id: &str, text: String, enqueued_at_ms: u64);
}

/// 事件发射点（EventQueue 适配；TimerFired=Critical / TimerCancelled=Soft
/// 的分级由适配器承载，本层只描述内部形状）
pub trait EventSink: Send + Sync {
    /// 发射定时器事件
    fn emit(&self, event: TimerEvent);
}

/// 定时器内部事件形状（适配器单点映射为 AgentEvent 的
/// TimerFired / TimerCancelled，§4.7 冻结字段）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TimerEvent {
    /// 到期（Critical 必达落库：timerId / prompt / firedAtMs）
    Fired {
        timer_id: String,
        prompt: String,
        fired_at_ms: u64,
    },
    /// 取消（Soft 尽力投递：timerId / reason / cancelledAtMs）
    Cancelled {
        timer_id: String,
        reason: TimerCancelReason,
        cancelled_at_ms: u64,
    },
}

/// 取消原因（wire 值 kebab-case：`cancelled` / `early-exit`）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimerCancelReason {
    /// 显式取消（cancel 工具 / AI 主动取消）
    Cancelled,
    /// 早退命中（sender 终态消息触发的条件取消）
    EarlyExit,
}

impl TimerCancelReason {
    /// wire 名（kebab-case，与 §4.7 reason 字段一致）
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::EarlyExit => "early-exit",
        }
    }
}

// ── 生产适配器 ─────────────────────────────────────────────────────

/// PendingMessageQueue 适配（steering 条目构造 + replaceOrEnqueue 去重）
#[derive(Clone)]
pub struct QueuePendingSink {
    /// 底层跨 run steering 队列（EngineHandle 持有，R-CF3 续 run 消费）
    queue: Arc<Mutex<PendingMessageQueue>>,
}

impl QueuePendingSink {
    /// 新建适配（queue 由装配方持有同一实例）
    pub fn new(queue: Arc<Mutex<PendingMessageQueue>>) -> Self {
        Self { queue }
    }
}

impl PendingSink for QueuePendingSink {
    fn enqueue_steering(&self, timer_id: &str, text: String, enqueued_at_ms: u64) {
        let entry = SteeringInputEntry {
            session_id: format!("timer-{timer_id}"),
            // 条目 id 带时间戳保证同组替换后仍唯一（对齐 recovery 模式）
            id: format!("{timer_id}-{enqueued_at_ms}"),
            text,
            attachments: Vec::new(),
            enqueued_at: enqueued_at_ms,
            group_id: Some(steering_group_id(timer_id)),
            is_steering: true,
        };
        let mut queue = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        queue.replace_or_enqueue(entry);
    }
}

/// AgentEvent 适配事件槽（TimerEvent → AgentEvent 单点映射；
/// 缓冲 + 日志，事件面经 engine_channels.rs `forward_drained_timer_events`
/// drain 转发到 EventBridge（P4，30 方案 §4）——本层不直接
/// 依赖事件桥，转发由引擎装配面持有，缓冲供测试断言与调试观测）。
///
/// Stage 6（ACT-602）：内嵌 `tokio::sync::Notify`，`emit` 即 `notify_one`；
/// main.rs drain 协程挂起于 `notified().await`，无事件时 0 Hz 待机
/// （取代旧 500ms 盲 sleep tick）。
pub struct AgentEventSink {
    /// 已发射事件缓冲（drain 转发 / 测试断言）
    buffered: Mutex<Vec<AgentEvent>>,
    /// 事件写入唤醒句柄（main.rs drain 协程消费；permit 语义防丢唤醒）
    notify: Arc<tokio::sync::Notify>,
}

impl Default for AgentEventSink {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentEventSink {
    /// 新建事件槽
    pub fn new() -> Self {
        Self {
            buffered: Mutex::new(Vec::new()),
            notify: Arc::new(tokio::sync::Notify::new()),
        }
    }

    /// 唤醒句柄（main.rs drain 协程持有 clone；与 emit 同一 Notify 实例）
    pub fn wake_notify(&self) -> Arc<tokio::sync::Notify> {
        Arc::clone(&self.notify)
    }

    /// 取走缓冲事件（drain 转发 helper 与测试断言消费；
    /// Vec::take 语义，空缓冲返回空集；生产消费方 = 壳层 drain
    /// 任务（Stage 6 Notify 事件驱动，经
    /// [crate::engine_channels::forward_drained_timer_events] 转发））
    pub fn drain(&self) -> Vec<AgentEvent> {
        std::mem::take(&mut *self.buffered.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

impl EventSink for AgentEventSink {
    fn emit(&self, event: TimerEvent) {
        let agent_event = match event {
            TimerEvent::Fired {
                timer_id,
                prompt,
                fired_at_ms,
            } => AgentEvent::TimerFired {
                // 注册表每引擎一个、无会话归属，sessionId 置空串；
                // 会话归属语义在 R-CF3 定时器会话化时定稿（§4.7 注）
                session_id: String::new(),
                timer_id,
                prompt,
                fired_at_ms,
            },
            TimerEvent::Cancelled {
                timer_id,
                reason,
                cancelled_at_ms,
            } => AgentEvent::TimerCancelled {
                session_id: String::new(),
                timer_id,
                reason: reason.as_str().to_string(),
                cancelled_at_ms,
            },
        };
        tracing::debug!(
            target: "timers",
            event = agent_event.type_name(),
            "定时器事件已发射（缓冲；drain 转发 P4 接线）"
        );
        self.buffered
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(agent_event);
        // ACT-602：唤醒 main.rs drain 协程（permit 未被消费则挂起方立即醒来）
        self.notify.notify_one();
    }
}
