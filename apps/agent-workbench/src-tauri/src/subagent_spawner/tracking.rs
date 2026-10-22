use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use super::lifecycle::RunLaunchLifecycle;

/// 活动 run 注册记录（spawn 时按发起会话定位父 run + 祖先链会话收集）
#[derive(Debug, Clone)]
pub(crate) struct RunRecord {
    /// run 归属会话
    pub(crate) session_id: String,
    /// 父 run id（None = 主 agent run / 无父 run）
    pub(crate) parent_run_id: Option<String>,
}

/// 全局及同父容量的唯一记账源。预留项从 launcher await 前计入，直到
/// 启动失败或收到首个终态时移除。
#[derive(Debug, Default)]
pub(crate) struct CapacityLedger {
    pub(crate) reservations: HashMap<String, Option<String>>,
}

/// 终态释放时一次性取出的运行归属。
pub(crate) struct RunOwnership {
    pub(crate) parent_run_id: Option<String>,
    pub(crate) flow_registration: Option<FlowRegistration>,
    pub(crate) run_record: Option<RunRecord>,
}

#[derive(Debug, Clone)]
pub(crate) struct FlowRegistration {
    pub(crate) node_id: String,
    pub(crate) emit_lifecycle_events: bool,
}

#[derive(Debug, Default)]
pub(crate) struct RunTracking {
    /// 深度记账（run_id → depth；主会话 run = 0，直接子代理 = 1）
    pub(crate) run_depths: Mutex<HashMap<String, usize>>,
    /// 并发容量所有权（run_id → parent_run_id）。预留与计数共享同一把锁，
    /// 因此此表也是终态一次性释放 token。
    pub(crate) capacity: Mutex<CapacityLedger>,
    /// launcher/started/terminal 生命周期闩锁（run_id → 异步通知状态）。
    pub(crate) launch_lifecycles: Mutex<HashMap<String, Arc<RunLaunchLifecycle>>>,
    /// 流程节点与生命周期事件所有权（subagent_run_id → flow registration）。
    pub(crate) flow_nodes: Mutex<HashMap<String, FlowRegistration>>,
    /// 活动 run → session / parent 的导航索引。
    pub(crate) runs: Mutex<HashMap<String, RunRecord>>,
}

impl RunTracking {
    /// 移除唯一 owner token，并清理该 run 的辅助注册。None 表示已经释放或
    /// 从未预留；unknown/重复终态不会改动其它 run 的计数。
    pub(crate) fn release_run_ownership(&self, run_id: &str) -> Option<RunOwnership> {
        let parent_run_id = self
            .capacity
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reservations
            .remove(run_id)?;
        let flow_registration = self
            .flow_nodes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(run_id);
        self.run_depths
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(run_id);
        let run_record = self
            .runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(run_id);
        self.launch_lifecycles
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(run_id);

        Some(RunOwnership {
            parent_run_id,
            flow_registration,
            run_record,
        })
    }

    pub(crate) fn cancel_pending_run(&self, run_id: &str) {
        if let Some(lifecycle) = self
            .launch_lifecycles
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(run_id)
            .cloned()
        {
            lifecycle.mark_cancelled();
        }
        let _ = self.release_run_ownership(run_id);
    }
}
