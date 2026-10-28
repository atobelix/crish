//! subagent-ended 事件流广播与生产缺省控制总线解析器（自 wait_channel.rs 原样搬迁）

use std::sync::{Arc, Mutex};

use agent_tools::tools::subagent::SubagentState;
use agent_tools::tools::wait_subagents::SubagentTerminalEvent;
use conex_types::events::{AgentEvent, SubagentEndStatus};
use session_loop::control::ControlBus;
use tokio::sync::mpsc;

use super::{now_ms, ControlBusResolver, SUBSCRIBER_CAPACITY};

/// subagent-ended 事件流广播（EventQueue 旁路适配）
///
/// 事件面接线（R-CF3 后续轮落地）：事件消费旁路点把到达的 [AgentEvent]
/// 经 [Self::feed] 灌入本广播，映射为 [SubagentTerminalEvent] 分发给
/// 全部当前订阅者；wait 期间的订阅经 [Self::subscribe] 建立、随接收端
/// drop 自动断流（订阅生命周期契约，T-CF-10 内容 2）。
///
/// 背压语义：`feed` 为同步旁路点调用（不阻塞事件流），满通道时丢弃
/// 并记日志——终端事件量大为 [SUBSCRIBER_CAPACITY] 所容，容量充足；
/// 超时兜底保证 wait 不会悬挂。
pub struct EventStreamBroadcast {
    /// 订阅者发送端（接收端 drop 后 `try_send` 失败，feed 时修剪）
    subscribers: Mutex<Vec<mpsc::Sender<SubagentTerminalEvent>>>,
}

impl Default for EventStreamBroadcast {
    fn default() -> Self {
        Self::new()
    }
}

impl EventStreamBroadcast {
    /// 新建事件流广播（无订阅者）
    pub fn new() -> Self {
        Self {
            subscribers: Mutex::new(Vec::new()),
        }
    }

    /// 订阅终态事件流（返回接收端；wait_for_terminal 期间持有，
    /// 返回后 drop 自动断流）
    pub fn subscribe(&self) -> mpsc::Receiver<SubagentTerminalEvent> {
        let (tx, rx) = mpsc::channel(SUBSCRIBER_CAPACITY);
        self.subscribers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(tx);
        rx
    }

    /// 当前活跃订阅者数（订阅生命周期观测 / 测试同步用；
    /// 顺带修剪断流订阅者——接收端 drop 即 wait 已返回）
    pub fn subscriber_count(&self) -> usize {
        let mut subscribers = self.subscribers.lock().unwrap_or_else(|e| e.into_inner());
        subscribers.retain(|tx| !tx.is_closed());
        subscribers.len()
    }

    /// 旁路点调用：把一条 [AgentEvent] 灌入广播。
    ///
    /// 仅 `subagent-ended` 事件被映射转发（映射规则：Completed → Completed；
    /// Failed / Cancelled 归一 Failed——I0 裁决「cancelled 归一 failed」，
    /// 对齐 [SubagentTerminalEvent] 语义 wait_subagents.rs:207-216）；
    /// 其余事件忽略。同步段不跨 await 持有锁（AA-02 并发模型）。
    pub fn feed(&self, event: &AgentEvent) {
        let Some((subagent_id, status, summary)) = terminal_event_fields(event) else {
            return;
        };
        let terminal = SubagentTerminalEvent {
            subagent_id,
            status,
            summary,
            // 事件体 ended_at 为 ISO8601 文本；旁路点时刻即到达时刻，
            // 以 feed 时刻作为终止时刻（不引入时间解析依赖）
            ended_at_ms: now_ms(),
        };
        let mut subscribers = self.subscribers.lock().unwrap_or_else(|e| e.into_inner());
        // 修剪断流订阅者（接收端 drop = wait 已返回）并逐条投递
        subscribers.retain(|tx| match tx.try_send(terminal.clone()) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => {
                tracing::warn!(
                    target: "wait_channel",
                    subagent_id = %terminal.subagent_id,
                    "终态事件通道已满（丢弃；wait 超时兜底，不悬挂）"
                );
                true
            }
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        });
    }
}

/// 从 [AgentEvent] 提取终态事件字段（仅 SubagentEnded；其余返回 None）
fn terminal_event_fields(event: &AgentEvent) -> Option<(String, SubagentState, Option<String>)> {
    let AgentEvent::SubagentEnded {
        subagent_id,
        status,
        summary,
        ..
    } = event
    else {
        return None;
    };
    // cancelled 归一 failed（I0 裁决；对齐 wait_subagents 的
    // SubagentTerminalEvent.status 语义）
    let state = match status {
        SubagentEndStatus::Completed => SubagentState::Completed,
        SubagentEndStatus::Failed | SubagentEndStatus::Cancelled => SubagentState::Failed,
    };
    Some((subagent_id.clone(), state, summary.clone()))
}

/// 空控制总线解析器：供测试或尚未绑定的装配窗口使用，恒返回 None；
/// 生产路径由 [crate::engine_channels::ContinuityChannelBoard] 延迟绑定
/// 活动 run 注册表解析器。
pub struct NoopControlBusResolver;

impl ControlBusResolver for NoopControlBusResolver {
    fn control_bus(&self, _subagent_id: &str) -> Option<Arc<Mutex<ControlBus>>> {
        None
    }
}
