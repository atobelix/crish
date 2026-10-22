//! 定时器测试套件与测试桩

mod lifecycle;
mod persistence;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use conex_types::events::AgentEvent;
use conex_types::timer::{TimerCondition, TimerDeclaration};
use orchestrator::PendingMessageQueue;
use orchestrator::steering_queue::SteeringInputEntry;

use crate::timers::registry::TimerRegistry;
use crate::timers::store::{MemoryTimerStore, TimerStore};
use crate::timers::types::{EventSink, QueuePendingSink, TimerEvent, steering_group_id};

/// 测试桩：事件发射记录
#[derive(Default)]
pub(crate) struct ProbeEvents {
    pub(crate) emitted: Mutex<Vec<TimerEvent>>,
}

impl EventSink for ProbeEvents {
    fn emit(&self, event: TimerEvent) {
        self.emitted
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(event);
    }
}

/// 构造测试注册表（真实 QueuePendingSink 落点 + mock 事件 + 共享
/// 内存 store + 注入时钟）。时钟初始 1_000_000（对齐 watchdog.rs
/// 测试时钟同值）；返回队列句柄与时钟句柄供断言 / 推进。
pub(crate) fn test_registry() -> (
    Arc<TimerRegistry>,
    Arc<Mutex<PendingMessageQueue>>,
    Arc<ProbeEvents>,
    Arc<MemoryTimerStore>,
    Arc<AtomicU64>,
) {
    let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
    let events = Arc::new(ProbeEvents::default());
    let store = MemoryTimerStore::shared();
    let clock = Arc::new(AtomicU64::new(1_000_000));
    let shared = Arc::clone(&clock);
    let now: Arc<dyn Fn() -> u64 + Send + Sync> = Arc::new(move || shared.load(Ordering::Relaxed));
    let registry = Arc::new(TimerRegistry::with_clock(
        Arc::new(QueuePendingSink::new(Arc::clone(&queue))),
        Arc::clone(&events) as Arc<dyn EventSink>,
        Arc::clone(&store) as Arc<dyn TimerStore>,
        now,
    ));
    (registry, queue, events, store, clock)
}

/// 消费式队列快照（dequeue_all 取走全部条目；同测试多处断言时
/// 须分别重新取快照——对齐真实队列 replaceOrEnqueue 语义）
pub(crate) fn queue_snapshot(queue: &Arc<Mutex<PendingMessageQueue>>) -> Vec<SteeringInputEntry> {
    queue
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .dequeue_all()
}

/// 队列当前条目数（非消费；poll_until 轮询条件用）
pub(crate) fn queue_len(queue: &Arc<Mutex<PendingMessageQueue>>) -> usize {
    queue.lock().unwrap_or_else(|e| e.into_inner()).len()
}

/// 轮询收口辅助：时钟推进后等待条件成立；真实时间上限 500ms 护栏
/// （~50×10ms 轮询窗，与到期任务同粒度），超时 panic——防时钟未
/// 推进时测试悬挂。
pub(crate) async fn poll_until<F>(mut condition: F)
where
    F: FnMut() -> bool,
{
    let deadline = std::time::Instant::now() + Duration::from_millis(500);
    loop {
        if condition() {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "poll_until 超时：条件在 500ms 内未成立（时钟是否已推进越过到期点？）"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// 断言当前早退通知条目存在（group_id = timer-<id>；消费式队列快照）
pub(crate) fn assert_early_exit_notice(
    queue: &Arc<Mutex<PendingMessageQueue>>,
    timer_id: &str,
    sender: &str,
) {
    let entries = queue_snapshot(queue);
    assert!(
        entries.iter().any(|p| {
            p.group_id.as_deref() == Some(steering_group_id(timer_id).as_str())
                && p.text == format!("定时器 {timer_id} 已因 {sender} 完成而取消")
        }),
        "应存在早退通知条目：{entries:?}"
    );
}

/// 子代理结束事件构造（早退测试用）
pub(crate) fn subagent_ended(subagent_id: &str) -> AgentEvent {
    AgentEvent::SubagentEnded {
        session_id: "ses-test".to_string(),
        subagent_id: subagent_id.to_string(),
        subagent_run_id: format!("run-{subagent_id}"),
        status: conex_types::events::SubagentEndStatus::Completed,
        summary: None,
        ended_at: "2026-08-05T00:00:00.000Z".to_string(),
        subagent_session_id: None,
    }
}

/// 测试声明构造（各测试独立字段，避免跨测试共享状态）
pub(crate) fn declaration(timer_id: &str) -> TimerDeclaration {
    TimerDeclaration {
        timer_id: timer_id.to_string(),
        created_at_ms: 1_000_000,
        expires_at_ms: 1_001_000,
        prompt: "检查编译结果".to_string(),
        condition: TimerCondition::Never,
        fired: false,
        cancelled: false,
    }
}
