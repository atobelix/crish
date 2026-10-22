//! sched 模块测试桩与共享测试夹具

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use conex_types::CoreError;
use orchestrator::steering_queue::SteeringInputEntry;
use orchestrator::PendingMessageQueue;

use super::registry::*;
use super::store::*;
use super::types::*;

mod execution;
mod parsing;
mod persistence;

/// 测试桩：事件发射记录
#[derive(Default)]
pub(crate) struct ProbeEvents {
    pub(crate) emitted: Mutex<Vec<CronEvent>>,
}

impl EventSink for ProbeEvents {
    fn emit(&self, event: CronEvent) {
        self.emitted
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(event);
    }
}

/// 测试桩：is_daemon run 拉起点
#[derive(Default)]
pub(crate) struct ProbeLauncher {
    pub(crate) prompts: Mutex<Vec<String>>,
    pub(crate) fail: bool,
}

#[async_trait]
impl DaemonRunLauncher for ProbeLauncher {
    async fn launch(&self, prompt: String) -> bool {
        if self.fail {
            return false;
        }
        self.prompts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(prompt);
        true
    }
}

pub(crate) struct ProbeScheduledLauncher {
    pub(crate) contexts: Mutex<Vec<ScheduledExecutionContext>>,
    pub(crate) should_fail: bool,
}

impl ProbeScheduledLauncher {
    pub(crate) fn new(should_fail: bool) -> Self {
        Self {
            contexts: Mutex::new(Vec::new()),
            should_fail,
        }
    }
}

#[async_trait]
impl ScheduledTaskLauncher for ProbeScheduledLauncher {
    async fn launch_scheduled_task(
        &self,
        ctx: ScheduledExecutionContext,
    ) -> Result<ScheduledRunHandle, CoreError> {
        self.contexts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(ctx.clone());
        tokio::time::sleep(Duration::from_millis(15)).await;
        if self.should_fail {
            Err(CoreError::Internal("模拟真实 Agent 启动失败".to_string()))
        } else {
            Ok(ScheduledRunHandle {
                run_id: ctx.run_id,
                session_id: ctx.target_session_id.unwrap_or_else(|| {
                    format!("sched-run-{}-{}", ctx.cron_id, ctx.fired_at_ms)
                }),
                async_terminal_managed: false,
                immediate_output_summary: Some("自动调度执行完成".to_string()),
            })
        }
    }
}

pub(crate) fn snapshot_queue(queue: &Arc<Mutex<PendingMessageQueue>>) -> Vec<SteeringInputEntry> {
    queue
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .dequeue_all()
}

pub(crate) fn queue_len(queue: &Arc<Mutex<PendingMessageQueue>>) -> usize {
    queue.lock().unwrap_or_else(|e| e.into_inner()).len()
}

pub(crate) async fn wait_until<F: Fn() -> bool>(what: &str, cond: F) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    loop {
        if cond() {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "等待条件超时（8s）：{what}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

pub(crate) fn test_registry() -> (
    Arc<SchedulerRegistry>,
    Arc<Mutex<PendingMessageQueue>>,
    Arc<ProbeEvents>,
    Arc<MemorySchedStore>,
) {
    let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
    let pending = Arc::new(QueuePendingSink::new(Arc::clone(&queue)));
    let events = Arc::new(ProbeEvents::default());
    let store = MemorySchedStore::shared();
    let registry = Arc::new(SchedulerRegistry::new(
        Arc::clone(&pending) as Arc<dyn PendingSink>,
        Arc::clone(&events) as Arc<dyn EventSink>,
        Arc::clone(&store) as Arc<dyn SchedStore>,
        None,
    ));
    (registry, queue, events, store)
}

pub(crate) fn test_input(expression: &str, max_iterations: Option<u64>, is_daemon: bool) -> CronTaskInput {
    CronTaskInput {
        expression: expression.to_string(),
        prompt: "检查编译结果".to_string(),
        max_iterations,
        is_daemon,
    }
}

pub(crate) fn task(cron_id: &str) -> CronTask {
    CronTask {
        cron_id: cron_id.to_string(),
        expression: "0 9 * * *".to_string(),
        prompt: "日报".to_string(),
        max_iterations: Some(2),
        is_daemon: false,
        next_fire_at_ms: 1_000_000,
        fired_count: 0,
        status: CronTaskStatus::Active,
        enabled: true,
        target_session_id: None,
        created_at_ms: 0,
        updated_at_ms: 0,
    }
}
