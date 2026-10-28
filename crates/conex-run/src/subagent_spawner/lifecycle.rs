use std::sync::{Arc, Mutex};

use agent_tools::tools::subagent::SubagentState;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchPhase {
    Pending,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug)]
pub struct RunLaunchState {
    pub phase: LaunchPhase,
    pub started_event_complete: bool,
    pub pending_terminal: Option<SubagentState>,
    pub terminal_claimed: bool,
}

/// 跨 launcher await 的生命周期闩锁。标准 Mutex 只保护短状态读写，等待均在
/// guard 释放后进行；Notify 让取消后的后台 started 发射仍可唤醒终态处理。
#[derive(Debug)]
pub struct RunLaunchLifecycle {
    pub state: Mutex<RunLaunchState>,
    pub changed: tokio::sync::Notify,
}

/// started 发射任务无论正常返回、panic 还是被取消，都要解除终态等待闩锁。
pub struct StartedEventCompletionGuard(pub Arc<RunLaunchLifecycle>);

impl Drop for StartedEventCompletionGuard {
    fn drop(&mut self) {
        self.0.mark_started_event_complete();
    }
}

impl Default for RunLaunchLifecycle {
    fn default() -> Self {
        Self::new()
    }
}

impl RunLaunchLifecycle {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(RunLaunchState {
                phase: LaunchPhase::Pending,
                started_event_complete: false,
                pending_terminal: None,
                terminal_claimed: false,
            }),
            changed: tokio::sync::Notify::new(),
        }
    }

    pub fn mark_launch_succeeded(&self, started_event_complete: bool) {
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.phase = LaunchPhase::Succeeded;
            state.started_event_complete = started_event_complete;
        }
        self.changed.notify_waiters();
    }

    pub fn mark_started_event_complete(&self) {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .started_event_complete = true;
        self.changed.notify_waiters();
    }

    pub fn mark_launch_failed(&self) {
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.phase = LaunchPhase::Failed;
            state.pending_terminal = None;
        }
        self.changed.notify_waiters();
    }

    pub fn mark_cancelled(&self) {
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.phase = LaunchPhase::Cancelled;
            state.pending_terminal = None;
        }
        self.changed.notify_waiters();
    }

    pub fn stage_terminal(&self, terminal: SubagentState) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.phase == LaunchPhase::Failed
            || state.phase == LaunchPhase::Cancelled
            || state.pending_terminal.is_some()
            || state.terminal_claimed
        {
            return false;
        }
        state.pending_terminal = Some(terminal);
        drop(state);
        self.changed.notify_waiters();
        true
    }

    pub async fn wait_until_terminal_ready(&self) -> Option<SubagentState> {
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let ready = {
                let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                match state.phase {
                    LaunchPhase::Failed | LaunchPhase::Cancelled => return None,
                    LaunchPhase::Pending => None,
                    LaunchPhase::Succeeded if !state.started_event_complete => None,
                    LaunchPhase::Succeeded => {
                        let terminal = state.pending_terminal.take();
                        if terminal.is_some() {
                            state.terminal_claimed = true;
                        }
                        terminal
                    }
                }
            };
            if ready.is_some() {
                return ready;
            }
            notified.await;
        }
    }

    pub async fn wait_until_started_event_complete(&self) {
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .started_event_complete
            {
                return;
            }
            notified.await;
        }
    }
}
