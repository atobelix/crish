//! 子代理生产 spawner（T-D-13：引擎侧 SubagentSpawner 接线，REQ-D01 落地前提）
//!
//! 职责（对齐 subagent.rs:769-781 的 SubagentSpawner 契约清单）：
//! 1. **守卫快照采集**：深度沿 parent_run_id 链（主会话 run = 0，直接子代理
//!    = 1），兄弟/并发按未终态子代理记账（M6 并发预算同口径）→
//!    [check_recursion_guard] + [check_ancestor_chain]；新会话深度 > 1
//!    （发起者是子 Agent）→ [RecursionGuardRejection::NestingDenied]
//!    （T-D-02 结构化错误：所有子 Agent 由主 Agent 分配）；
//! 2. **session_agents 落库**：agent_id / subagent_run_id / parent 链 / depth /
//!    task_type / display_label / allowed_write_paths_json（v6 新列）随行保存；
//! 3. **独立 run 启动**：走 core_run_task 同通道（[SubagentRunLauncher] trait
//!    object 切断 CoreRunState 类型递归）——子代理 run 装配 ContextInjector
//!    时注入 T-D-03 角色约束段 + C2 started_at 段 + T-D-14 权限申请指引段 +
//!    产出目录段（主控已定产出目录时）；按 task_type 默认权限集装配（工具
//!    注册表裁剪 + 写路径沙箱 + 配额上下文）；父 run 归属经
//!    `RunTaskOptions.parent_run_id` 透传（审批请求路由给主 agent 裁决）；
//! 4. **流程关联**：flow_node_id 回显（FlowScheduler 经运行时记录映射回
//!    节点），终态经 [Self::on_subagent_terminal] 统一处理——记账释放 +
//!    行终态更新 + subagent-ended 发射（flow 事件由明确 owner 单轨发射）+ wait
//!    通道 feed + steering 通知（主 agent 下一 run 唤醒）；
//! 5. **spawn_many 批量实现**：前瞻快照统一守卫（深度共享、兄弟/并发按 N
//!    预加）→ 全部通过后逐条落库启动（原子语义：任一守卫拒绝 → 整体失败
//!    **零 run**，session_agents 无新增行）。
//!
//! 发起者定位：工具直调路径的请求 `parent_run_id` 恒 None（agent-tools 冻结
//! 契约），引擎侧按「当前活动 run 上下文」补齐——[Self::set_current_run]
//! 按**会话**登记（run_task_impl 装配时登记、收口清除），spawn 时以请求的
//! `parent_session_id` 定位发起 run；跨会话并发互不串扰（对齐 T-AB-19
//! owner_run_id 注入槽模式，但按会话索引避免单槽覆盖）。
//!
//! 注入面（[Self::init]，CoreRunState 构造完成后调用）：launcher（run 启动）、
//! db（session_agents 行读写）、terminal_stream（wait 通道订阅面）、
//! steering_queue（主 agent 唤醒通知落点）。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use agent_tools::tools::subagent::{
    check_ancestor_chain, check_recursion_guard, DeadlockCheckInput, RecursionGuardConfig,
    RecursionGuardSnapshot, SubagentSpawnError, SubagentSpawnRequest, SubagentSpawnResult,
    SubagentSpawner, SubagentState, DEFAULT_RECURSION_GUARD,
};
use async_trait::async_trait;
use conex_db::LocalDb;
use conex_types::events::SubagentEndStatus;
use conex_types::SessionAgent;
use orchestrator::persist::LocalDbStore;
use orchestrator::steering_queue::{PendingMessageQueue, SteeringInputEntry};
use orchestrator::subagent_events::{
    build_subagent_ended, started_info_from_spawn, SubagentEmitContext, SubagentEndedInfo,
    SubagentEventEmitter,
};

use crate::core_error::CoreError;
use crate::core_run_commands::{RunTaskOptions, RunTaskResponse};
use crate::engine::now_iso_utc;
use crish_agent_workbench::wait_channel::EventStreamBroadcast;

/// 当前 UTC 毫秒时间戳（epoch ms；与全仓 epoch ms 惯例一致；时钟异常 0）
pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// 子代理 run 装配配置（run_task_impl 消费；IPC 命令面不携带——
/// serde 缺省 None，仅引擎内部 spawner 构造）
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubagentRunConfig {
    /// 子代理 id（session_agents.agent_id）
    pub subagent_id: String,
    /// 子代理 run id（session_agents.subagent_run_id；终态定位行）
    pub subagent_run_id: String,
    /// 父会话 id（subagent-started/ended 事件归属会话 + steering 通知目标）
    pub parent_session_id: String,
    /// 任务类型（wire 名；驱动默认权限集装配；None = 缺省 analysis）
    pub task_type: Option<String>,
    /// 显式写路径白名单（硬沙箱输入；None = 按默认集装配）
    pub allowed_write_paths: Option<Vec<String>>,
    /// 主控已定产出目录（Some = 注入 output_dir_section 提示词段）
    pub output_dir: Option<String>,
    /// 创建时刻（epoch ms；C2 started_at 注入与落库同源）
    pub started_at_ms: i64,
}

/// 子代理 run 启动器（trait object 切断 CoreRunState 类型递归——spawner
/// 在 CoreRunState 内，run 启动需回调 CoreRunState 上的 run_task_impl；
/// 生产实现 [CoreRunStateLauncher] 持 Weak 引用，无循环强引用）
#[async_trait]
pub(crate) trait SubagentRunLauncher: Send + Sync + std::fmt::Debug {
    /// 启动一次子代理 run（core_run_task 同通道）
    async fn launch(&self, options: RunTaskOptions) -> Result<RunTaskResponse, CoreError>;
}

/// 活动 run 注册记录（spawn 时按发起会话定位父 run + 祖先链会话收集）
#[derive(Debug, Clone)]
struct RunRecord {
    /// run 归属会话
    session_id: String,
    /// 父 run id（None = 主 agent run / 无父 run）
    parent_run_id: Option<String>,
}

/// 生产 spawner 状态
pub(crate) struct SubagentSpawnerImpl {
    /// 守卫配置（默认：maxDepth=1 / maxSiblings=5 / maxConcurrent=12，
    /// [DEFAULT_RECURSION_GUARD]；flow 调度器可配位不传导——引擎侧统一）
    guard: RecursionGuardConfig,
    /// 自增序号（agent id / run id / 会话 id 唯一性）
    seq: AtomicUsize,
    /// run 启动器（注入槽：CoreRunState 构造后经 [Self::init] 注入）
    launcher: Mutex<Option<Arc<dyn SubagentRunLauncher>>>,
    /// 子代理行存储（注入槽；None = 未注入，落库返回 PersistFailed）
    db: Mutex<Option<LocalDb>>,
    /// wait 通道终态事件流广播（注入槽；终态 feed 订阅者）
    terminal_stream: Mutex<Option<Arc<EventStreamBroadcast>>>,
    /// 跨 run steering 队列（注入槽；终态通知主 agent 唤醒）
    steering_queue: Mutex<Option<Arc<Mutex<PendingMessageQueue>>>>,
    /// 当前活动 run 上下文（session_id → run_id；spawn 时按发起会话定位
    /// 父 run——跨会话并发互不串扰）
    current_runs: Mutex<HashMap<String, String>>,
    /// run 所有权、容量和生命周期的共享状态。后台启动任务持有 Arc，
    /// 调用方 future 取消后仍能完成登记与清理。
    tracking: Arc<RunTracking>,
}

/// 全局及同父容量的唯一记账源。预留项从 launcher await 前计入，直到
/// 启动失败或收到首个终态时移除。
#[derive(Debug, Default)]
struct CapacityLedger {
    reservations: HashMap<String, Option<String>>,
}

/// 终态释放时一次性取出的运行归属。
struct RunOwnership {
    parent_run_id: Option<String>,
    flow_registration: Option<FlowRegistration>,
    run_record: Option<RunRecord>,
}

#[derive(Debug, Clone)]
struct FlowRegistration {
    node_id: String,
    emit_lifecycle_events: bool,
}

#[derive(Debug, Default)]
struct RunTracking {
    /// 深度记账（run_id → depth；主会话 run = 0，直接子代理 = 1）
    run_depths: Mutex<HashMap<String, usize>>,
    /// 并发容量所有权（run_id → parent_run_id）。预留与计数共享同一把锁，
    /// 因此此表也是终态一次性释放 token。
    capacity: Mutex<CapacityLedger>,
    /// launcher/started/terminal 生命周期闩锁（run_id → 异步通知状态）。
    launch_lifecycles: Mutex<HashMap<String, Arc<RunLaunchLifecycle>>>,
    /// 流程节点与生命周期事件所有权（subagent_run_id → flow registration）。
    flow_nodes: Mutex<HashMap<String, FlowRegistration>>,
    /// 活动 run → session / parent 的导航索引。
    runs: Mutex<HashMap<String, RunRecord>>,
}

impl RunTracking {
    /// 移除唯一 owner token，并清理该 run 的辅助注册。None 表示已经释放或
    /// 从未预留；unknown/重复终态不会改动其它 run 的计数。
    fn release_run_ownership(&self, run_id: &str) -> Option<RunOwnership> {
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

    fn cancel_pending_run(&self, run_id: &str) {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LaunchPhase {
    Pending,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug)]
struct RunLaunchState {
    phase: LaunchPhase,
    started_event_complete: bool,
    pending_terminal: Option<SubagentState>,
    terminal_claimed: bool,
}

/// 跨 launcher await 的生命周期闩锁。标准 Mutex 只保护短状态读写，等待均在
/// guard 释放后进行；Notify 让取消后的后台 started 发射仍可唤醒终态处理。
#[derive(Debug)]
struct RunLaunchLifecycle {
    state: Mutex<RunLaunchState>,
    changed: tokio::sync::Notify,
}

/// started 发射任务无论正常返回、panic 还是被取消，都要解除终态等待闩锁。
struct StartedEventCompletionGuard(Arc<RunLaunchLifecycle>);

impl Drop for StartedEventCompletionGuard {
    fn drop(&mut self) {
        self.0.mark_started_event_complete();
    }
}

impl RunLaunchLifecycle {
    fn new() -> Self {
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

    fn mark_launch_succeeded(&self, started_event_complete: bool) {
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.phase = LaunchPhase::Succeeded;
            state.started_event_complete = started_event_complete;
        }
        self.changed.notify_waiters();
    }

    fn mark_started_event_complete(&self) {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .started_event_complete = true;
        self.changed.notify_waiters();
    }

    fn mark_launch_failed(&self) {
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.phase = LaunchPhase::Failed;
            state.pending_terminal = None;
        }
        self.changed.notify_waiters();
    }

    fn mark_cancelled(&self) {
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.phase = LaunchPhase::Cancelled;
            state.pending_terminal = None;
        }
        self.changed.notify_waiters();
    }

    fn stage_terminal(&self, terminal: SubagentState) -> bool {
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

    async fn wait_until_terminal_ready(&self) -> Option<SubagentState> {
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

    async fn wait_until_started_event_complete(&self) {
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

/// 生成后即参与容量预留的标识，避免 launcher 运行期间才产生 owner id。
struct SpawnIds {
    subagent_id: String,
    subagent_run_id: String,
    session_id: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ReservationState {
    Pending,
    Launching,
    Settled,
}

/// 容量预留守卫：交给后台启动任务前取消时释放；移交后由后台失败收口或
/// 子代理真实终态消费 owner token。
struct CapacityReservation {
    tracking: Arc<RunTracking>,
    run_id: String,
    state: ReservationState,
}

impl CapacityReservation {
    fn new(tracking: Arc<RunTracking>, run_id: &str) -> Self {
        Self {
            tracking,
            run_id: run_id.to_string(),
            state: ReservationState::Pending,
        }
    }

    fn begin_launch(&mut self) {
        self.state = ReservationState::Launching;
    }

    fn transfer_to_background(&mut self) {
        self.state = ReservationState::Settled;
    }

    fn release_now(&mut self) {
        let _ = self.tracking.release_run_ownership(&self.run_id);
        self.state = ReservationState::Settled;
    }
}

impl Drop for CapacityReservation {
    fn drop(&mut self) {
        if self.state == ReservationState::Pending {
            self.tracking.cancel_pending_run(&self.run_id);
        }
    }
}

impl std::fmt::Debug for SubagentSpawnerImpl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SubagentSpawnerImpl")
            .field("guard", &self.guard)
            .field(
                "active_concurrent",
                &self
                    .tracking
                    .capacity
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .reservations
                    .len(),
            )
            .finish_non_exhaustive()
    }
}

impl SubagentSpawnerImpl {
    /// 新建生产 spawner（注入槽为空；[Self::init] 装配后可用）
    pub(crate) fn new() -> Self {
        Self {
            guard: DEFAULT_RECURSION_GUARD,
            seq: AtomicUsize::new(0),
            launcher: Mutex::new(None),
            db: Mutex::new(None),
            terminal_stream: Mutex::new(None),
            steering_queue: Mutex::new(None),
            current_runs: Mutex::new(HashMap::new()),
            tracking: Arc::new(RunTracking::default()),
        }
    }

    /// 装配注入槽（CoreRunState 构造完成后调用；启动器 / 行存储 /
    /// wait 广播 / steering 队列——引擎侧真实接线面）
    pub(crate) fn init(
        &self,
        launcher: Option<Arc<dyn SubagentRunLauncher>>,
        db: Option<LocalDb>,
        terminal_stream: Option<Arc<EventStreamBroadcast>>,
        steering_queue: Option<Arc<Mutex<PendingMessageQueue>>>,
    ) {
        *self.launcher.lock().unwrap_or_else(|e| e.into_inner()) = launcher;
        *self.db.lock().unwrap_or_else(|e| e.into_inner()) = db;
        *self
            .terminal_stream
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = terminal_stream;
        *self
            .steering_queue
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = steering_queue;
    }

    /// 登记活动 run（run_task_impl 装配时调用：主会话 run 深度 0 记账；
    /// 子代理 run 经 [Self::spawn_unchecked] 已登记，重复登记幂等覆盖）
    pub(crate) fn register_run(
        &self,
        run_id: &str,
        session_id: &str,
        parent_run_id: Option<String>,
    ) {
        self.tracking
            .runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                run_id.to_string(),
                RunRecord {
                    session_id: session_id.to_string(),
                    parent_run_id: parent_run_id.clone(),
                },
            );
        self.tracking
            .run_depths
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(run_id.to_string())
            .or_insert(0);
        let _ = parent_run_id;
    }

    /// 登记当前活动 run（会话 → run；spawn 时按发起会话定位父 run）
    pub(crate) fn set_current_run(&self, session_id: &str, run_id: &str) {
        self.current_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(session_id.to_string(), run_id.to_string());
    }

    /// 测试面：登记「存活子代理 run」的深度记账（嵌套守卫测试直接构造
    /// 子代理发起场景——不经真实 spawn，避免 drive_run_loop 收口竞态；
    /// 对齐 CoreRunState::set_timer_has_active 的 cfg(test) 注入先例）
    #[cfg(test)]
    pub(crate) fn note_depth_for_test(&self, run_id: &str, depth: usize, session_id: &str) {
        self.tracking
            .run_depths
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(run_id.to_string(), depth);
        self.tracking
            .runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(run_id.to_string())
            .or_insert_with(|| RunRecord {
                session_id: session_id.to_string(),
                parent_run_id: Some("run-main".to_string()),
            });
    }

    /// 清除当前活动 run（收口时调用；仅当登记值等于本 run 时移除——
    /// 防跨会话并发覆盖后误删他 run）
    pub(crate) fn clear_current_run(&self, session_id: &str, run_id: &str) {
        let mut map = self.current_runs.lock().unwrap_or_else(|e| e.into_inner());
        if map.get(session_id).map(String::as_str) == Some(run_id) {
            map.remove(session_id);
        }
    }

    /// 解析发起 run（工具直调路径请求恒 None；flow 调度器路径已携带）：
    /// 显式值优先，缺省按「发起会话的当前活动 run」补齐
    fn resolve_parent_run(&self, req: &SubagentSpawnRequest) -> Option<String> {
        if req.parent_run_id.is_some() {
            return req.parent_run_id.clone();
        }
        self.current_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&req.parent_session_id)
            .cloned()
    }

    /// 守卫判定（T-D-02 映射：嵌套禁止走专用错误变体 + 专用错误码
    /// subagent.nesting_denied；其余复用 GuardRejected——对齐 DbSpawner
    /// 测试域先例 subagent.rs:2521-2531）
    fn check_guard(&self, snapshot: RecursionGuardSnapshot) -> Result<(), SubagentSpawnError> {
        check_recursion_guard(snapshot, self.guard).map_err(|rejection| match rejection {
            agent_tools::tools::subagent::RecursionGuardRejection::NestingDenied { .. } => {
                SubagentSpawnError::NestingDenied(rejection)
            }
            other => SubagentSpawnError::GuardRejected(other),
        })
    }

    fn next_spawn_ids(&self, depth: usize) -> SpawnIds {
        let n = self.seq.fetch_add(1, Ordering::SeqCst);
        SpawnIds {
            subagent_id: format!("sub-{depth}-{n}"),
            subagent_run_id: format!("sub-run-{depth}-{n}"),
            session_id: format!("sub-sess-{depth}-{n}"),
        }
    }

    /// 在一个临界区内判定并预留整批容量。兄弟和全局计数都包含尚在
    /// persist/launch 阶段的 run，避免并发调用看到同一份旧快照。
    fn reserve_capacity(
        &self,
        run_ids: &[String],
        parent_run: Option<&str>,
        depth: usize,
    ) -> Result<(), SubagentSpawnError> {
        if run_ids.is_empty() {
            return Ok(());
        }

        let mut capacity = self
            .tracking
            .capacity
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let mut unique_run_ids = HashSet::with_capacity(run_ids.len());
        if run_ids.iter().any(|run_id| {
            capacity.reservations.contains_key(run_id) || !unique_run_ids.insert(run_id)
        }) {
            return Err(SubagentSpawnError::Unavailable(
                "子代理 run id 冲突，容量预留未执行".to_string(),
            ));
        }

        let active_siblings = capacity
            .reservations
            .values()
            .filter(|reserved_parent| reserved_parent.as_deref() == parent_run)
            .count();
        let requested = run_ids.len();
        self.check_guard(RecursionGuardSnapshot {
            depth,
            active_siblings: active_siblings.saturating_add(requested),
            active_concurrent: capacity.reservations.len().saturating_add(requested),
        })?;

        for run_id in run_ids {
            capacity
                .reservations
                .insert(run_id.clone(), parent_run.map(str::to_string));
        }
        Ok(())
    }

    fn launch_lifecycle(&self, run_id: &str) -> Option<Arc<RunLaunchLifecycle>> {
        self.tracking
            .launch_lifecycles
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(run_id)
            .cloned()
    }

    #[cfg(test)]
    fn active_count_for_test(&self) -> usize {
        self.tracking
            .capacity
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reservations
            .len()
    }

    /// 落库 + 记账 + 启动 + 结果（守卫已在调用方完成——单发经 [Self::spawn]
    /// 检查，批量经 [Self::spawn_many] 前瞻统一检查；此处不重复检查，否则
    /// 批量逐条路径会与「前瞻预加」判定产生中间态偏差）
    async fn spawn_unchecked(
        &self,
        req: &SubagentSpawnRequest,
        depth: usize,
        parent_run: Option<String>,
        ids: &SpawnIds,
        reservation: &mut CapacityReservation,
        emit_flow_lifecycle_events: bool,
    ) -> Result<SubagentSpawnResult, SubagentSpawnError> {
        // 标识在容量预留之前已生成，便于 launcher await 前注册终态 owner。
        let subagent_id = ids.subagent_id.clone();
        let subagent_run_id = ids.subagent_run_id.clone();
        let session_id = ids.session_id.clone();
        let now = now_ms();

        // 2. session_agents 落库（pending 首写即 running；v6 新列随行）
        //    db 访问收敛在块内（MutexGuard 不跨 await 持有——AA-02 并发模型）
        //    单行 upsert（11-T3）：ON CONFLICT DO UPDATE，不触碰既有行与
        //    messages（全量先删后插在并发写面已废弃）
        let row = self.row_for(req, &subagent_id, &subagent_run_id, &session_id, depth, now);
        {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            let Some(db) = db.as_ref() else {
                return Err(SubagentSpawnError::PersistFailed(
                    "session_agents 存储未注入（LocalDb 未装配）".to_string(),
                ));
            };
            db.upsert_session_agent(&row)
                .map_err(|e| SubagentSpawnError::PersistFailed(e.to_string()))?;
            // 会话索引条目幂等写入（子代理独立会话；与前端会话列表同表）
            let entry = conex_types::SessionIndexEntry {
                id: session_id.clone(),
                title: format!("子代理 {subagent_id}"),
                folder: String::new(),
                is_pinned: false,
                is_archived: false,
                branch_parent_id: None,
                timestamp: now_iso_utc(),
                updated_at: now,
                message_count: 0,
                pinned_message_ids: None,
                engine_cursor: Some(0),
                engine_last_run_id: Some(subagent_run_id.clone()),
                hydrated_from_engine: Some(true),
            };
            if let Err(error) = db.upsert_session_entry(&entry) {
                // 会话条目写入失败仅告警（run 启动仍可进行；行落库已成功）
                tracing::warn!(
                    target: "subagent_spawner",
                    subagent_id = %subagent_id,
                    error = %error,
                    "子代理会话条目写入失败（仅告警）"
                );
            }
        }

        // 所有 run 归属和生命周期闩锁必须在 launcher await 前登记；快速终态
        // 先暂存，只有 launcher 确认成功后才允许完成终态副作用。
        let lifecycle = Arc::new(RunLaunchLifecycle::new());
        self.tracking
            .launch_lifecycles
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(subagent_run_id.clone(), Arc::clone(&lifecycle));
        self.tracking
            .run_depths
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(subagent_run_id.clone(), depth);
        self.tracking
            .runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                subagent_run_id.clone(),
                RunRecord {
                    session_id: session_id.clone(),
                    parent_run_id: parent_run.clone(),
                },
            );
        if let Some(node_id) = &req.flow_node_id {
            self.tracking
                .flow_nodes
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(
                    subagent_run_id.clone(),
                    FlowRegistration {
                        node_id: node_id.clone(),
                        emit_lifecycle_events: emit_flow_lifecycle_events,
                    },
                );
        }

        // 3. 独立 run 启动（core_run_task 同通道）。启动过程及其成功/失败
        //    收口放在独立任务中；调用方取消只放弃等待，不会取消已交给 launcher
        //    的启动操作，也不会丢掉 owner token 或 started 事件。
        let config = SubagentRunConfig {
            subagent_id: subagent_id.clone(),
            subagent_run_id: subagent_run_id.clone(),
            parent_session_id: req.parent_session_id.clone(),
            task_type: req.task_type.map(|t| t.as_str().to_string()),
            allowed_write_paths: req.allowed_write_paths.as_ref().map(|paths| {
                paths
                    .iter()
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect()
            }),
            output_dir: None,
            started_at_ms: now,
        };
        let launch_options = RunTaskOptions {
            run_id: subagent_run_id.clone(),
            session_id: session_id.clone(),
            prompt: Some(req.prompt.clone()),
            mode: req.mode.clone().or_else(|| Some("research".to_string())),
            cwd: None,
            permission_mode: None,
            client_message_id: None,
            assistant_client_message_id: None,
            system_prompt: None,
            history: None,
            context_window: None,
            parent_run_id: parent_run.clone(),
            subagent_config: Some(config),
            // D5 §3.1：子代理 run 非 goal 模式，goal 三字段恒 None。
            visible_goal: None,
            max_rounds: None,
            max_stalled_rounds: None,
            reasoning_effort: None,
            context_state: None,
            content: None,
            has_images: None,
        };
        let started_context = SubagentEmitContext {
            session_id: req.parent_session_id.clone(),
            parent_run_id: parent_run.clone().unwrap_or_default(),
        };
        let started_request = req.clone();
        let started_result = SubagentSpawnResult {
            subagent_id: subagent_id.clone(),
            subagent_run_id: subagent_run_id.clone(),
            session_id: session_id.clone(),
            status: SubagentState::Running,
            summary: None,
            flow_node_id: req.flow_node_id.clone(),
            display_label: req.display_label.clone(),
        };
        let started_info = started_info_from_spawn(&started_request, &started_result);
        let emit_started_event = req.flow_node_id.is_none() || emit_flow_lifecycle_events;
        let failed_context = SubagentEmitContext {
            session_id: req.parent_session_id.clone(),
            parent_run_id: parent_run.clone().unwrap_or_default(),
        };
        let failed_info = SubagentEndedInfo {
            subagent_id: subagent_id.clone(),
            subagent_run_id: subagent_run_id.clone(),
            status: SubagentEndStatus::Failed,
            summary: Some("子代理启动失败".to_string()),
            subagent_session_id: Some(session_id.clone()),
        };
        let launcher = self
            .launcher
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let tracking = Arc::clone(&self.tracking);
        let lifecycle_for_launch = Arc::clone(&lifecycle);
        let run_id_for_launch = subagent_run_id.clone();
        let parent_session_id = req.parent_session_id.clone();
        let emit_failure_event = emit_started_event;
        let (launch_tx, launch_rx) = tokio::sync::oneshot::channel();

        // 从此处开始，独立任务持有启动操作与所有完成责任。reservation Drop
        // 不再释放它；失败由任务释放，成功由真实终态释放。
        reservation.begin_launch();
        reservation.transfer_to_background();
        let launcher_task = tokio::spawn(async move {
            match launcher {
                Some(launcher) => launcher
                    .launch(launch_options)
                    .await
                    .map_err(|error| error.to_string()),
                None => Err("子代理 run 启动器未注入（SubagentRunLauncher 未装配）".to_string()),
            }
        });
        tokio::spawn(async move {
            let launch_result = match launcher_task.await {
                Ok(result) => result,
                Err(error) => Err(format!("子代理启动器任务异常终止：{error}")),
            };
            match launch_result {
                Ok(response) => {
                    lifecycle_for_launch.mark_launch_succeeded(false);
                    if emit_started_event {
                        if let Some(db) = db {
                            let lifecycle_for_event = Arc::clone(&lifecycle_for_launch);
                            tokio::spawn(async move {
                                let _completion = StartedEventCompletionGuard(lifecycle_for_event);
                                let emitter =
                                    SubagentEventEmitter::new(Arc::new(LocalDbStore::new(db)));
                                if let Err(error) =
                                    emitter.emit_started(&started_context, &started_info).await
                                {
                                    tracing::warn!(
                                        target: "subagent_spawner",
                                        event = "emit_started_failed",
                                        subagent_run_id = %run_id_for_launch,
                                        error = %error,
                                        "subagent-started 发射失败（终态处理仍等待该事件尝试完成）"
                                    );
                                }
                            });
                        } else {
                            lifecycle_for_launch.mark_started_event_complete();
                        }
                    } else {
                        lifecycle_for_launch.mark_started_event_complete();
                    }
                    let _ = launch_tx.send(Ok(response));
                }
                Err(error) => {
                    lifecycle_for_launch.mark_launch_failed();
                    let _ = tracking.release_run_ownership(&run_id_for_launch);
                    if let Some(db) = db {
                        if let Err(status_error) = db.update_session_agent_status(
                            &parent_session_id,
                            &run_id_for_launch,
                            SubagentState::Failed.to_db_status(),
                            Some(now_ms()),
                        ) {
                            tracing::warn!(
                                target: "subagent_spawner",
                                subagent_run_id = %run_id_for_launch,
                                error = %status_error,
                                "启动失败的子代理行未能归一 failed"
                            );
                        }
                        if emit_failure_event {
                            let emitter =
                                SubagentEventEmitter::new(Arc::new(LocalDbStore::new(db)));
                            if let Err(emit_error) =
                                emitter.emit_ended(&failed_context, &failed_info).await
                            {
                                tracing::warn!(
                                    target: "subagent_spawner",
                                    event = "emit_launch_failed_ended_failed",
                                    subagent_run_id = %run_id_for_launch,
                                    error = %emit_error,
                                    "spawn 失败补发 subagent-ended 落库失败（仅告警）"
                                );
                            }
                        }
                    }
                    let _ = launch_tx.send(Err(error));
                }
            }
        });

        let launch_result = launch_rx
            .await
            .map_err(|_| SubagentSpawnError::SpawnFailed("启动任务提前退出".to_string()))?;
        let _response = launch_result.map_err(SubagentSpawnError::SpawnFailed)?;
        lifecycle.wait_until_started_event_complete().await;

        Ok(SubagentSpawnResult {
            subagent_id,
            subagent_run_id,
            session_id,
            status: SubagentState::Running,
            summary: None,
            flow_node_id: req.flow_node_id.clone(),
            display_label: req.display_label.clone(),
        })
    }

    /// 终态统一处理（子代理 run 收口后由 CoreRunState 调用）：
    /// 记账释放 → 行终态更新 → subagent-ended 发射（非 flow 路径）→
    /// wait 通道 feed → steering 通知（主 agent 下一 run 唤醒）。
    pub(crate) async fn on_subagent_terminal(&self, cfg: &SubagentRunConfig, state: SubagentState) {
        let run_id = cfg.subagent_run_id.clone();
        // 终态可能抢在 launcher 返回或 started 事件落库前到达。首个终态先
        // 占用闩锁并等待启动结果及 started 发射尝试，重复终态不重复消费。
        if let Some(lifecycle) = self.launch_lifecycle(&run_id) {
            if !lifecycle.stage_terminal(state) {
                tracing::debug!(
                    target: "subagent_spawner",
                    subagent_run_id = %run_id,
                    "忽略重复或已关闭 run 的子代理终态"
                );
                return;
            }
            if lifecycle.wait_until_terminal_ready().await != Some(state) {
                return;
            }
        }
        // reservation 是该 run 唯一释放 token；unknown/重复终态不会减计数，
        // 也不会重复发射事件。None parent 仍有可精确消费的 token。
        let Some(ownership) = self.tracking.release_run_ownership(&run_id) else {
            tracing::debug!(
                target: "subagent_spawner",
                subagent_run_id = %run_id,
                "忽略未登记或已处理的子代理终态"
            );
            return;
        };
        let parent_run = ownership.parent_run_id;
        let flow_registration = ownership.flow_registration;
        let flow_node_id = flow_registration
            .as_ref()
            .map(|registration| registration.node_id.clone());
        let emit_ended_event = flow_registration
            .as_ref()
            .map(|registration| registration.emit_lifecycle_events)
            .unwrap_or(true);
        // D-02 LK-04：runs 注册表反查子会话 id（run 记录携带子代理会话；
        // remove 取出即释放，供 subagent-ended 反向导航键装配）
        let sub_session_id = ownership.run_record.map(|record| record.session_id);

        // 2. 行终态更新（status/ended_at；产出保留——summary/messages 原样）
        {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner()).clone();
            if let Some(db) = db {
                let now = now_ms();
                let loaded = db.load_session_agents(&cfg.parent_session_id);
                match loaded {
                    Ok(mut agents) => {
                        if let Some(row) = agents
                            .iter_mut()
                            .find(|a| a.subagent_run_id == cfg.subagent_run_id)
                        {
                            row.status = state.to_db_status().to_string();
                            if row.ended_at.is_none() {
                                row.ended_at = Some(now);
                            }
                            row.summary = Some(match state {
                                SubagentState::Completed => "子代理已完成".to_string(),
                                _ => "子代理已结束（失败）".to_string(),
                            });
                        }
                        if let Err(error) = db.save_session_agents(&cfg.parent_session_id, &agents)
                        {
                            tracing::warn!(
                                target: "subagent_spawner",
                                subagent_run_id = %run_id,
                                error = %error,
                                "子代理行终态落库失败（仅告警）"
                            );
                        }
                    }
                    Err(error) => {
                        tracing::warn!(
                            target: "subagent_spawner",
                            subagent_run_id = %run_id,
                            error = %error,
                            "子代理行终态读取失败（仅告警）"
                        );
                    }
                }
            }
        }

        // 3. subagent-ended 事件：启用 flow 生命周期事件时由 spawner 负责，
        //    FlowScheduler 按 owner 契约跳过重复发射；未启用时仅供 wait 通道
        //    feed 与 steering 摘要使用，不落库事件。
        let mut info =
            SubagentEndedInfo::from_subagent_state(cfg.subagent_id.clone(), run_id.clone(), state);
        // D-02 LK-04：后置赋值子会话 id（runs 注册表反查；None = 注册表
        // 无记录/未接线，前端回退行级反查）
        info.subagent_session_id = sub_session_id;
        let emit_ctx = SubagentEmitContext {
            session_id: cfg.parent_session_id.clone(),
            parent_run_id: parent_run.clone().unwrap_or_default(),
        };
        // LK-07 R-14：双发幂等——kill 命令面已直发 ended(cancelled)（lifecycle
        // kill_all/kill_subagent）时，本收口兜底不再重复发射（同一父 run 归
        // 属性查询 events 表；query_events_by_run 走 idx_events_run 索引，
        // 终态低频可接受）。flow 路径不查（事件由 FlowScheduler 发射）。
        let already_ended = if emit_ended_event {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner()).clone();
            match db {
                Some(db) => {
                    let parent = parent_run.clone().unwrap_or_default();
                    if parent.is_empty() {
                        false
                    } else {
                        db.query_events_by_run(&cfg.parent_session_id, &parent, 0, Some(200))
                            .map(|rows| {
                                rows.iter().any(|e| {
                                    if e.event_type != "subagent-ended" {
                                        return false;
                                    }
                                    if let Ok(val) =
                                        serde_json::from_str::<serde_json::Value>(&e.payload)
                                    {
                                        let sub_id = val.get("subagentId").and_then(|v| v.as_str());
                                        let sub_run_id =
                                            val.get("subagentRunId").and_then(|v| v.as_str());
                                        if sub_id == Some(&cfg.subagent_id)
                                            || sub_run_id == Some(&run_id)
                                        {
                                            return true;
                                        }
                                    }
                                    false
                                })
                            })
                            .unwrap_or(false)
                    }
                }
                None => false,
            }
        } else {
            false
        };
        let event = if emit_ended_event {
            if already_ended {
                // kill 已直发 ended：跳过落库发射（wait 通道仍以本地副本
                // feed 兜底，订阅者收口不丢）
                build_subagent_ended(&emit_ctx, &info)
            } else {
                let emitted = {
                    let db = self.db.lock().unwrap_or_else(|e| e.into_inner()).clone();
                    match db {
                        Some(db) => {
                            let emitter =
                                SubagentEventEmitter::new(Arc::new(LocalDbStore::new(db)));
                            match emitter.emit_ended(&emit_ctx, &info).await {
                                Ok(sequenced) => Some(sequenced.event),
                                Err(error) => {
                                    tracing::warn!(
                                        target: "subagent_spawner",
                                        event = "emit_ended_failed",
                                        subagent_run_id = %run_id,
                                        error = %error,
                                        "subagent-ended 发射失败（wait 通道仍 feed 兜底）"
                                    );
                                    None
                                }
                            }
                        }
                        None => None,
                    }
                };
                emitted.unwrap_or_else(|| build_subagent_ended(&emit_ctx, &info))
            }
        } else {
            // 纯编排 flow 路径不发生命周期事件；本处仅构造副本供 wait
            // 通道 feed 与 steering 摘要。
            build_subagent_ended(&emit_ctx, &info)
        };

        // 4. wait 通道 feed（wait_subagents 订阅者实时唤醒）
        if let Some(stream) = self
            .terminal_stream
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
        {
            stream.feed(&event);
        }

        // 5. steering 通知（主 agent 下一 run 经 decide_idle_resume 唤醒；
        // 摘要模板对齐 wakeup_summary.rs 子代理完成段——role 取展示标签）
        if let Some(queue) = self
            .steering_queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
        {
            let summary_text = crate::wakeup_summary::wakeup_summary(
                &event,
                &crate::wakeup_summary::SummaryCtx {
                    subagent_role: cfg
                        .task_type
                        .as_deref()
                        .and_then(agent_tools::tools::subagent::TaskType::parse)
                        .map(|t| t.boundary_summary().to_string()),
                    ..crate::wakeup_summary::SummaryCtx::default()
                },
            );
            queue
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .enqueue(SteeringInputEntry::steering(
                    format!("subagent-terminal-{run_id}"),
                    summary_text,
                    now_ms() as u64,
                ));
        }

        tracing::info!(
            target: "subagent_spawner",
            subagent_run_id = %run_id,
            status = state.as_str(),
            flow_node_id = ?flow_node_id,
            "子代理终态处理完成（记账释放 + 行更新 + 事件/通知面）"
        );
    }

    /// 落库行构造（pending 首写即 running；depth 沿 parent_run_id 链；
    /// v6 新列 task_type / display_label / allowed_write_paths_json 随行）
    fn row_for(
        &self,
        req: &SubagentSpawnRequest,
        subagent_id: &str,
        subagent_run_id: &str,
        session_id: &str,
        depth: usize,
        now: i64,
    ) -> SessionAgent {
        SessionAgent {
            id: subagent_id.to_string(),
            subagent_run_id: subagent_run_id.to_string(),
            parent_session_id: req.parent_session_id.clone(),
            parent_run_id: req
                .parent_run_id
                .clone()
                .unwrap_or_else(|| self.resolve_parent_run(req).unwrap_or_default()),
            parent_tool_call_id: req.parent_tool_call_id.clone(),
            // F-013 接线（双防线②数据源）：flow 调度请求 description 恒
            // None（flow_graph.rs:1028 唯一构造点），description 字段在
            // flow 路径下本就空闲——load() 反向校验（flow_graph.rs:1417
            // -1442）以 row.description 为 flow_node_id 载体定位「有 run
            // 行、flow_state 无映射」的节点，生产 spawner 必须把
            // flow_node_id 落库，否则崩溃窗口兜底在生产域退化为不命中
            // （description 空串）。flow_node_id 优先（机器可定位 id）；
            // 非 flow 路径无 flow_node_id → 普通描述文本原样承载，语义
            // 不变。
            description: req
                .flow_node_id
                .clone()
                .or_else(|| req.description.clone())
                .unwrap_or_default(),
            mode: req.mode.clone().unwrap_or_default(),
            status: SubagentState::Pending.to_db_status().to_string(),
            summary: None,
            messages: Vec::new(),
            started_at: now,
            ended_at: None,
            depth: Some(depth as i64),
            subagent_path_json: None,
            // T-D-07 落库面：task_type / display_label / 写路径白名单
            // 随 spawn 请求落库（model_override 扩展点预留不落库）
            task_type: req.task_type.map(|t| t.as_str().to_string()),
            display_label: req.display_label.clone(),
            allowed_write_paths_json: req
                .allowed_write_paths
                .as_ref()
                .map(|paths| serde_json::to_string(paths).expect("路径白名单序列化不应失败")),
            // D-02 LK-04：子会话 id 随行落库（v9 新列；反向导航键——子会话
            // 事件流 → session_agents 行反查，`sub-sess-{depth}-{n}`）
            sub_session_id: Some(session_id.to_string()),
        }
    }

    /// 祖先链会话收集（沿 parent_run_id 链，从父到根；死锁检查输入）
    fn ancestor_sessions(&self, parent_run: Option<&str>) -> Vec<String> {
        let runs = self.tracking.runs.lock().unwrap_or_else(|e| e.into_inner());
        let mut chain = Vec::new();
        let mut cursor = parent_run.map(str::to_string);
        // 防环护栏（数据异常时最多收集 64 级）
        for _ in 0..64 {
            match cursor {
                Some(run_id) => match runs.get(&run_id) {
                    Some(record) => {
                        chain.push(record.session_id.clone());
                        cursor = record.parent_run_id.clone();
                    }
                    None => break,
                },
                None => break,
            }
        }
        chain
    }

    async fn spawn_with_flow_event_policy(
        &self,
        req: &SubagentSpawnRequest,
        emit_flow_lifecycle_events: bool,
    ) -> Result<SubagentSpawnResult, SubagentSpawnError> {
        let parent_run = self.resolve_parent_run(req);
        let depth = self
            .tracking
            .run_depths
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(parent_run.as_deref().unwrap_or_default())
            .copied()
            .unwrap_or(0)
            + 1;
        let ids = self.next_spawn_ids(depth);
        check_ancestor_chain(&DeadlockCheckInput {
            target_session_id: ids.session_id.clone(),
            ancestor_session_ids: self.ancestor_sessions(parent_run.as_deref()),
        })
        .map_err(SubagentSpawnError::GuardRejected)?;
        self.reserve_capacity(
            std::slice::from_ref(&ids.subagent_run_id),
            parent_run.as_deref(),
            depth,
        )?;
        let mut reservation =
            CapacityReservation::new(Arc::clone(&self.tracking), &ids.subagent_run_id);
        let result = self
            .spawn_unchecked(
                req,
                depth,
                parent_run,
                &ids,
                &mut reservation,
                emit_flow_lifecycle_events,
            )
            .await;
        if result.is_err() {
            reservation.release_now();
        }
        result
    }
}

#[async_trait]
impl SubagentSpawner for SubagentSpawnerImpl {
    async fn spawn(
        &self,
        req: &SubagentSpawnRequest,
    ) -> Result<SubagentSpawnResult, SubagentSpawnError> {
        self.spawn_with_flow_event_policy(req, false).await
    }

    async fn spawn_flow_node(
        &self,
        req: &SubagentSpawnRequest,
        emit_lifecycle_events: bool,
    ) -> Result<SubagentSpawnResult, SubagentSpawnError> {
        self.spawn_with_flow_event_policy(req, emit_lifecycle_events)
            .await
    }

    fn owns_flow_lifecycle_events(&self) -> bool {
        true
    }

    /// 批量派发（T-D-06 原子语义）：**前瞻快照统一守卫**——批量任务同父
    /// （parent_run_id 取首条，工具直调路径按发起会话解析），depth 共享，
    /// 同一容量锁中按 N 一次预留；任一拒绝 → 整体失败**零 run**
    ///（session_agents 无新增行，不产生部分成功）；全部通过 → 逐条落库 +
    /// 启动（顺序与入参一致）。
    ///
    /// 注：逐条落库阶段若出现启动失败（run 启动异常，非守卫拒绝），前序
    /// run 已启动——该路径属灾难性失败，按 [Self::spawn_unchecked] 行归一
    /// failed 兜底；「零 run」保证针对守卫拒绝（验收断言 session_agents
    /// 无新增行）。
    async fn spawn_many(
        &self,
        requests: &[SubagentSpawnRequest],
    ) -> Result<Vec<SubagentSpawnResult>, SubagentSpawnError> {
        if requests.is_empty() {
            return Ok(Vec::new());
        }
        let n = requests.len();
        let parent_run = match &requests[0].parent_run_id {
            Some(run) => Some(run.clone()),
            None => self.resolve_parent_run(&requests[0]),
        };
        let depth = self
            .tracking
            .run_depths
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(parent_run.as_deref().unwrap_or_default())
            .copied()
            .unwrap_or(0)
            + 1;
        let ids: Vec<SpawnIds> = (0..n).map(|_| self.next_spawn_ids(depth)).collect();
        let run_ids: Vec<String> = ids
            .iter()
            .map(|spawn_ids| spawn_ids.subagent_run_id.clone())
            .collect();
        self.reserve_capacity(&run_ids, parent_run.as_deref(), depth)?;
        let mut reservations: Vec<_> = run_ids
            .iter()
            .zip(requests)
            .map(|(run_id, _req)| CapacityReservation::new(Arc::clone(&self.tracking), run_id))
            .collect();

        // 全部通过 → 逐条落库 + 启动。若某一项失败，保留已成功 run 的槽位，
        // 释放失败项及未尝试项；每个 release 都由 run_id token 幂等保护。
        let mut results = Vec::with_capacity(n);
        for (index, req) in requests.iter().enumerate() {
            match self
                .spawn_unchecked(
                    req,
                    depth,
                    parent_run.clone(),
                    &ids[index],
                    &mut reservations[index],
                    false,
                )
                .await
            {
                Ok(result) => results.push(result),
                Err(error) => {
                    for reservation in reservations.iter_mut().skip(index) {
                        reservation.release_now();
                    }
                    return Err(error);
                }
            }
        }
        Ok(results)
    }
}

#[cfg(test)]
mod tests {
    // G2 禁令豁免：测试临时目录清理（非产品删除路径，可恢复语义不适用）。
    #![allow(clippy::disallowed_methods)]

    use super::*;
    use agent_tools::tools::subagent::{RecursionGuardRejection, SubagentRole, TaskType};
    use std::sync::Mutex as StdMutex;

    /// 启动请求快照（RunTaskOptions 无 Debug/Clone——trait 对象 Debug 面
    /// 不承载，测试自存轻量快照断言装配面）
    #[derive(Debug, Clone)]
    struct LaunchSnapshot {
        run_id: String,
        session_id: String,
        parent_run_id: Option<String>,
        subagent_config: Option<SubagentRunConfig>,
    }

    /// 记录式启动器：记录 launch 请求并按预设结果应答（记录 subagent_config
    /// 装配断言面）
    #[derive(Debug)]
    struct RecordingLauncher {
        launches: StdMutex<Vec<LaunchSnapshot>>,
        outcome: Result<RunTaskResponse, CoreError>,
    }

    impl RecordingLauncher {
        fn ok() -> Self {
            Self {
                launches: StdMutex::new(Vec::new()),
                outcome: Ok(RunTaskResponse {
                    run_id: "sub-run-ok".to_string(),
                    session_id: "sub-sess-ok".to_string(),
                }),
            }
        }

        fn failing() -> Self {
            Self {
                launches: StdMutex::new(Vec::new()),
                outcome: Err(CoreError::internal("模拟 run 启动失败")),
            }
        }

        fn launches(&self) -> Vec<LaunchSnapshot> {
            self.launches.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl SubagentRunLauncher for RecordingLauncher {
        async fn launch(&self, options: RunTaskOptions) -> Result<RunTaskResponse, CoreError> {
            self.launches.lock().unwrap().push(LaunchSnapshot {
                run_id: options.run_id.clone(),
                session_id: options.session_id.clone(),
                parent_run_id: options.parent_run_id.clone(),
                subagent_config: options.subagent_config.clone(),
            });
            self.outcome.clone()
        }
    }

    #[derive(Debug, Default)]
    struct PanickingLauncher;

    #[async_trait]
    impl SubagentRunLauncher for PanickingLauncher {
        async fn launch(&self, _options: RunTaskOptions) -> Result<RunTaskResponse, CoreError> {
            panic!("simulated launcher panic");
        }
    }

    /// 在测试显式放行前阻塞 launcher，确保并发调用同时处于未终态预留态。
    #[derive(Debug)]
    struct GateLauncher {
        started: tokio::sync::Semaphore,
        resume: tokio::sync::Semaphore,
        launches: AtomicUsize,
    }

    impl GateLauncher {
        fn new() -> Self {
            Self {
                started: tokio::sync::Semaphore::new(0),
                resume: tokio::sync::Semaphore::new(0),
                launches: AtomicUsize::new(0),
            }
        }

        fn resume(&self, count: usize) {
            self.resume.add_permits(count);
        }
    }

    #[async_trait]
    impl SubagentRunLauncher for GateLauncher {
        async fn launch(&self, options: RunTaskOptions) -> Result<RunTaskResponse, CoreError> {
            self.launches.fetch_add(1, Ordering::SeqCst);
            self.started.add_permits(1);
            self.resume
                .acquire()
                .await
                .map_err(|error| CoreError::internal(error.to_string()))?
                .forget();
            Ok(RunTaskResponse {
                run_id: options.run_id,
                session_id: options.session_id,
            })
        }
    }

    /// 在 launcher 返回前同步送入终态，覆盖真实 drive loop 可命中的竞态窗口。
    #[derive(Debug, Default)]
    struct ImmediateTerminalLauncher {
        spawner: StdMutex<Option<std::sync::Weak<SubagentSpawnerImpl>>>,
        terminal_task: StdMutex<Option<tokio::task::JoinHandle<()>>>,
    }

    impl ImmediateTerminalLauncher {
        fn attach(&self, spawner: &Arc<SubagentSpawnerImpl>) {
            *self.spawner.lock().unwrap() = Some(Arc::downgrade(spawner));
        }

        async fn wait_for_terminal(&self) {
            let task = self.terminal_task.lock().unwrap().take();
            if let Some(task) = task {
                task.await.expect("terminal callback should not panic");
            }
        }
    }

    #[async_trait]
    impl SubagentRunLauncher for ImmediateTerminalLauncher {
        async fn launch(&self, options: RunTaskOptions) -> Result<RunTaskResponse, CoreError> {
            let spawner = self
                .spawner
                .lock()
                .unwrap()
                .as_ref()
                .and_then(std::sync::Weak::upgrade)
                .ok_or_else(|| CoreError::internal("test spawner is not attached"))?;
            let config = options
                .subagent_config
                .as_ref()
                .cloned()
                .ok_or_else(|| CoreError::internal("subagent config missing"))?;
            let terminal_task = tokio::spawn(async move {
                spawner
                    .on_subagent_terminal(&config, SubagentState::Completed)
                    .await;
            });
            *self.terminal_task.lock().unwrap() = Some(terminal_task);
            Ok(RunTaskResponse {
                run_id: options.run_id,
                session_id: options.session_id,
            })
        }
    }

    #[derive(Debug, Default)]
    struct FailSecondLauncher {
        attempts: AtomicUsize,
    }

    #[async_trait]
    impl SubagentRunLauncher for FailSecondLauncher {
        async fn launch(&self, options: RunTaskOptions) -> Result<RunTaskResponse, CoreError> {
            if self.attempts.fetch_add(1, Ordering::SeqCst) == 1 {
                return Err(CoreError::internal("second launch fails"));
            }
            Ok(RunTaskResponse {
                run_id: options.run_id,
                session_id: options.session_id,
            })
        }
    }

    /// 测试装配：spawner + 注入槽（mock launcher / LocalDb / 广播 / 队列）
    fn test_rig() -> (
        Arc<SubagentSpawnerImpl>,
        Arc<RecordingLauncher>,
        LocalDb,
        Arc<EventStreamBroadcast>,
        Arc<Mutex<PendingMessageQueue>>,
    ) {
        let launcher = Arc::new(RecordingLauncher::ok());
        let db = LocalDb::open_in_memory().expect("内存库");
        db.upsert_session_entry(&conex_types::SessionIndexEntry {
            id: "sess-main".to_string(),
            title: "主会话".to_string(),
            folder: String::new(),
            is_pinned: false,
            is_archived: false,
            branch_parent_id: None,
            timestamp: "2026-08-05T00:00:00.000Z".to_string(),
            updated_at: 1,
            message_count: 0,
            pinned_message_ids: None,
            engine_cursor: Some(0),
            engine_last_run_id: Some("run-main".to_string()),
            hydrated_from_engine: Some(true),
        })
        .expect("会话条目");
        let stream = Arc::new(EventStreamBroadcast::new());
        let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        let spawner = Arc::new(SubagentSpawnerImpl::new());
        spawner.init(
            Some(Arc::clone(&launcher) as Arc<dyn SubagentRunLauncher>),
            Some(db.clone()),
            Some(Arc::clone(&stream)),
            Some(Arc::clone(&queue)),
        );
        (spawner, launcher, db, stream, queue)
    }

    /// 单发请求构造（父会话 + 任务类型 + 显式白名单）
    fn request(prompt: &str, task_type: Option<TaskType>) -> SubagentSpawnRequest {
        SubagentSpawnRequest {
            agent_id: None,
            prompt: prompt.to_string(),
            role: Some(SubagentRole::Researcher),
            capability_mode: None,
            allowed_tools: None,
            description: Some("调研".to_string()),
            mode: Some("research".to_string()),
            parent_session_id: "sess-main".to_string(),
            parent_run_id: Some("run-main".to_string()),
            parent_tool_call_id: Some("call-1".to_string()),
            flow_node_id: None,
            is_composite: false,
            task_type,
            allowed_write_paths: Some(vec![std::path::PathBuf::from("docs/")]),
            display_label: Some("调研员".to_string()),
            // 扩展点预留：恒 None（编译器强制；本测试不携带）
            model_override: None,
        }
    }

    fn setup_main_run(spawner: &SubagentSpawnerImpl) {
        // 主 agent run 登记（深度 0）+ 当前活动 run 定位
        spawner.register_run("run-main", "sess-main", None);
        spawner.set_current_run("sess-main", "run-main");
    }

    // ── 单发端到端（落库 v6 列 / 启动装配 / 结果信封）──────────────

    #[tokio::test]
    async fn spawn_single_persists_row_and_launches_run() {
        let (spawner, launcher, db, _, _) = test_rig();
        setup_main_run(&spawner);

        let result = spawner
            .spawn(&request("完成调研 A", Some(TaskType::Analysis)))
            .await
            .expect("spawn 应成功");

        // 结果信封：id / run id / 会话 / running / display_label 回显
        assert!(result.subagent_id.starts_with("sub-1-"));
        assert!(result.subagent_run_id.starts_with("sub-run-1-"));
        assert!(result.session_id.starts_with("sub-sess-1-"));
        assert_eq!(result.status, SubagentState::Running);
        assert_eq!(result.display_label.as_deref(), Some("调研员"));

        // session_agents 落库（v6 新列 task_type / display_label /
        // allowed_write_paths_json + parent 链 + depth）
        let rows = db.load_session_agents("sess-main").expect("读行");
        assert_eq!(rows.len(), 1, "恰好一行");
        let row = &rows[0];
        assert_eq!(row.id, result.subagent_id);
        assert_eq!(row.subagent_run_id, result.subagent_run_id);
        assert_eq!(row.parent_session_id, "sess-main");
        assert_eq!(row.parent_run_id, "run-main");
        assert_eq!(row.parent_tool_call_id.as_deref(), Some("call-1"));
        assert_eq!(row.status, "running", "pending 首写即 running");
        assert_eq!(row.depth, Some(1), "直接子代理深度 1");
        assert_eq!(row.task_type.as_deref(), Some("analysis"));
        assert_eq!(row.display_label.as_deref(), Some("调研员"));
        let paths: Vec<String> =
            serde_json::from_str(row.allowed_write_paths_json.as_deref().unwrap()).unwrap();
        assert_eq!(paths, vec!["docs/"]);
        assert!(row.started_at > 0);
        // D-02 LK-04：反向导航键行级落库（子会话 id = sub-sess-{depth}-{n}）
        assert_eq!(
            row.sub_session_id.as_deref(),
            Some(result.session_id.as_str()),
            "行 sub_session_id == 子会话 id（子会话 → session_agents 行反查）"
        );

        // D-02 LK-04：subagent-started 事件体信封携带子会话 id（跨会话导航
        // 键：父会话三事件视图 → 子会话事件流）
        let events = db
            .query_events("sess-main", 0, Some(100))
            .expect("事件查询");
        let started: Vec<_> = events
            .iter()
            .filter(|e| e.event_type == "subagent-started")
            .collect();
        assert_eq!(started.len(), 1, "subagent-started 必达落库");
        let started_value: serde_json::Value =
            serde_json::from_str(&started[0].payload).expect("payload 应为 JSON");
        assert_eq!(
            started_value["subagentSessionId"].as_str(),
            Some(result.session_id.as_str()),
            "started 事件体信封 subagentSessionId == 子会话 id"
        );

        // 独立 run 启动：launcher 收到 subagent_config（task_type / started_at
        // / parent_run_id 透传；产出目录缺省 None）
        let launches = launcher.launches();
        assert_eq!(launches.len(), 1);
        let options = &launches[0];
        assert_eq!(options.run_id, result.subagent_run_id);
        assert_eq!(options.session_id, result.session_id);
        assert_eq!(options.parent_run_id.as_deref(), Some("run-main"));
        let config = options.subagent_config.as_ref().expect("子代理配置");
        assert_eq!(config.subagent_id, result.subagent_id);
        assert_eq!(config.subagent_run_id, result.subagent_run_id);
        assert_eq!(config.parent_session_id, "sess-main");
        assert_eq!(config.task_type.as_deref(), Some("analysis"));
        assert_eq!(
            config.started_at_ms, row.started_at,
            "started_at 与落库同源（C2）"
        );
        assert!(config.output_dir.is_none());
    }

    /// 工具直调路径（parent_run_id 恒 None）：按发起会话的当前活动 run 补齐
    #[tokio::test]
    async fn spawn_resolves_parent_run_from_current_session() {
        let (spawner, _, db, _, _) = test_rig();
        setup_main_run(&spawner);

        let mut req = request("调研", None);
        req.parent_run_id = None; // 工具直调路径：请求不携带父 run
        let result = spawner.spawn(&req).await.expect("spawn 应成功");
        let _ = result;

        let rows = db.load_session_agents("sess-main").unwrap();
        assert_eq!(rows[0].parent_run_id, "run-main", "发起 run 按会话补齐");
    }

    /// 默认模型继承（REQ-D03）：spawn 未携带模型覆盖 → 子代理 run 的
    /// provider 装配面与主 agent 一致（同一 engine provider 全局单例）；
    /// model_override 恒 None 且无消费逻辑（构造点显式 None 编译器强制，
    /// 引擎侧读取即编译断裂——此处断言请求携带值也不影响装配）
    #[tokio::test]
    async fn spawn_model_inheritance_and_override_never_consumed() {
        let (spawner, launcher, _, _, _) = test_rig();
        setup_main_run(&spawner);

        let mut req = request("调研", None);
        req.model_override = Some("grok-3".to_string());
        let _ = spawner.spawn(&req).await.expect("spawn 应成功");
        let launches = launcher.launches();
        assert_eq!(launches.len(), 1);
        // subagent_config 不含任何模型字段（模型走 engine provider 全局单例；
        // Debug 面断言字段集，编译期构造点恒 None 为强制面）
        let config = launches[0].subagent_config.as_ref().unwrap();
        assert!(!format!("{config:?}").contains("model"));
    }

    // ── 嵌套拒绝（T-D-02：子 Agent 无派发能力，结构化错误）────────

    #[tokio::test]
    async fn spawn_nesting_denied_from_subagent_run() {
        let (spawner, _, _, _, _) = test_rig();
        setup_main_run(&spawner);
        // 真实场景：主 agent 先 spawn 出子代理 A，A 作为发起者再派发
        let first = spawner
            .spawn(&request("子代理 A 的任务", None))
            .await
            .expect("主 agent 派发应成功");
        spawner.set_current_run("sess-main", &first.subagent_run_id);

        let mut req = request("再派发", None);
        req.parent_run_id = None; // 工具路径：按会话解析 → 子代理 run 为发起者
        let err = spawner.spawn(&req).await.expect_err("嵌套发起必须拒绝");
        // 专用变体 + 专用错误码（T-D-02 验收）
        match &err {
            SubagentSpawnError::NestingDenied(rejection) => {
                assert_eq!(rejection.code(), "subagent.nesting_denied");
                assert!(rejection.message().contains("所有子 Agent 由主 Agent 分配"));
            }
            other => panic!("必须为 NestingDenied，实际 {other:?}"),
        }
        assert_eq!(err.code(), "subagent.nesting_denied");
        // 零 run：无新增行
        assert_eq!(
            spawner
                .db
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .load_session_agents("sess-main")
                .unwrap()
                .len(),
            1
        );
    }

    /// 兄弟并发上限包含本次请求：已有 15 个时第 16 个可发起，第 17 个拒绝。
    #[tokio::test]
    async fn spawn_siblings_exceeded() {
        let (spawner, _, db, _, _) = test_rig();
        setup_main_run(&spawner);
        // 预置 15 个未终态兄弟，再发起第 16 个。
        for i in 0..15 {
            let mut req = request(&format!("任务 {i}"), None);
            req.parent_run_id = Some("run-main".to_string());
            let _ = spawner.spawn(&req).await.expect("前 16 个应成功");
        }
        let sixteenth = spawner
            .spawn(&request("第 16 个", None))
            .await
            .expect("已有 15 个时第 16 个应放行");
        let _ = sixteenth;
        // 第 17 个：已有 16 + 本次 1 = 17 > maxSiblings=16 → 拒绝（零 run）
        let err = spawner
            .spawn(&request("第 17 个", None))
            .await
            .expect_err("兄弟并发超限必须拒绝");
        match &err {
            SubagentSpawnError::GuardRejected(rejection) => {
                assert!(matches!(
                    rejection,
                    RecursionGuardRejection::SiblingsExceeded {
                        current: 17,
                        max: 16
                    }
                ));
            }
            other => panic!("必须为 GuardRejected(SiblingsExceeded)，实际 {other:?}"),
        }
        assert_eq!(
            db.load_session_agents("sess-main").unwrap().len(),
            16,
            "拒绝零 run"
        );
    }

    /// 全局并发上限包含本次请求：已有 15 个时第 16 个可发起，第 17 个拒绝。
    #[tokio::test]
    async fn spawn_concurrent_exceeded() {
        let (spawner, _, db, _, _) = test_rig();
        // 15 个并发子代理（不同父 run 也可计数——全局预算）
        for i in 0..15 {
            let mut req = request(&format!("任务 {i}"), None);
            req.parent_run_id = Some(format!("run-{i}"));
            let _ = spawner.spawn(&req).await.expect("预算内应成功");
        }
        let sixteenth = spawner
            .spawn(&request("第 16 个", None))
            .await
            .expect("已有 15 个时第 16 个应放行");
        let _ = sixteenth;
        // 第 17 个：已有 16 + 本次 1 = 17 > 16 → 拒绝（零 run）
        let err = spawner
            .spawn(&request("第 17 个", None))
            .await
            .expect_err("全局并发超限必须拒绝");
        assert!(matches!(
            err,
            SubagentSpawnError::GuardRejected(RecursionGuardRejection::ConcurrentExceeded {
                current: 17,
                max: 16
            })
        ));
        assert_eq!(
            db.load_session_agents("sess-main").unwrap().len(),
            16,
            "拒绝零 run"
        );
    }

    /// 17 个并发单发共享一个容量锁：首 16 个停在 launcher 内，第 17 个拒绝。
    #[tokio::test]
    async fn concurrent_spawn_reserves_capacity_before_launch() {
        let (spawner, _, db, stream, queue) = test_rig();
        let gate = Arc::new(GateLauncher::new());
        spawner.init(
            Some(Arc::clone(&gate) as Arc<dyn SubagentRunLauncher>),
            Some(db.clone()),
            Some(stream),
            Some(queue),
        );
        setup_main_run(&spawner);

        let tasks: Vec<_> = (0..17)
            .map(|index| {
                let spawner = Arc::clone(&spawner);
                tokio::spawn(async move {
                    let mut req = request(&format!("并发任务 {index}"), None);
                    req.parent_run_id = Some(format!("parallel-parent-{index}"));
                    spawner.spawn(&req).await
                })
            })
            .collect();

        let arrivals = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            gate.started.acquire_many(16),
        )
        .await
        .expect("16 个 launcher 应到达 gate")
        .expect("started semaphore remains open");
        arrivals.forget();
        gate.resume(17);

        let mut succeeded = 0;
        let mut rejected = 0;
        for task in tasks {
            match task.await.expect("spawn task should not panic") {
                Ok(_) => succeeded += 1,
                Err(SubagentSpawnError::GuardRejected(
                    RecursionGuardRejection::ConcurrentExceeded {
                        current: 17,
                        max: 16,
                    },
                )) => rejected += 1,
                Err(error) => panic!("unexpected spawn result: {error:?}"),
            }
        }
        assert_eq!(gate.launches.load(Ordering::SeqCst), 16);
        assert_eq!(succeeded, 16);
        assert_eq!(rejected, 1);
        assert_eq!(spawner.active_count_for_test(), 16);
        assert_eq!(db.load_session_agents("sess-main").unwrap().len(), 16);
    }

    /// spawn_many 在第一个 await 前一次预留 N；并发单发不能抢走批次容量。
    #[tokio::test]
    async fn spawn_many_reserves_all_capacity_before_first_launch() {
        let (spawner, _, db, stream, queue) = test_rig();
        let gate = Arc::new(GateLauncher::new());
        spawner.init(
            Some(Arc::clone(&gate) as Arc<dyn SubagentRunLauncher>),
            Some(db.clone()),
            Some(stream),
            Some(queue),
        );
        setup_main_run(&spawner);

        let requests: Vec<_> = (0..16)
            .map(|index| request(&format!("批量任务 {index}"), None))
            .collect();
        let batch_spawner = Arc::clone(&spawner);
        let batch = tokio::spawn(async move { batch_spawner.spawn_many(&requests).await });

        tokio::time::timeout(std::time::Duration::from_secs(3), gate.started.acquire())
            .await
            .expect("批量的首个 launcher 应到达 gate")
            .expect("started semaphore remains open")
            .forget();

        assert_eq!(spawner.active_count_for_test(), 16);
        let err = spawner
            .spawn(&request("竞争单发", None))
            .await
            .expect_err("批量已原子预留全部容量，单发必须拒绝");
        assert!(matches!(
            err,
            SubagentSpawnError::GuardRejected(RecursionGuardRejection::SiblingsExceeded {
                current: 17,
                max: 16
            })
        ));
        assert_eq!(gate.launches.load(Ordering::SeqCst), 1);
        assert_eq!(db.load_session_agents("sess-main").unwrap().len(), 1);

        gate.resume(16);
        let results = tokio::time::timeout(std::time::Duration::from_secs(3), batch)
            .await
            .expect("批量 launcher 应全部放行")
            .expect("batch task should not panic")
            .expect("16 个容量内任务应成功");
        assert_eq!(results.len(), 16);
        assert_eq!(gate.launches.load(Ordering::SeqCst), 16);
        assert_eq!(spawner.active_count_for_test(), 16);
        assert_eq!(db.load_session_agents("sess-main").unwrap().len(), 16);
    }

    #[tokio::test]
    async fn cancelled_spawn_keeps_launched_run_owned_until_terminal() {
        let (spawner, _, db, stream, queue) = test_rig();
        let gate = Arc::new(GateLauncher::new());
        spawner.init(
            Some(Arc::clone(&gate) as Arc<dyn SubagentRunLauncher>),
            Some(db.clone()),
            Some(stream),
            Some(queue),
        );
        setup_main_run(&spawner);

        let task_spawner = Arc::clone(&spawner);
        let task =
            tokio::spawn(async move { task_spawner.spawn(&request("取消中的单发", None)).await });
        tokio::time::timeout(std::time::Duration::from_secs(3), gate.started.acquire())
            .await
            .expect("单发应进入 launcher")
            .expect("started semaphore remains open")
            .forget();

        assert_eq!(spawner.active_count_for_test(), 1);
        task.abort();
        let _ = task.await;

        assert_eq!(
            spawner.active_count_for_test(),
            1,
            "启动操作仍在后台运行，容量继续占用"
        );
        let rows = db.load_session_agents("sess-main").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].status, "running", "调用方取消不应伪造子代理失败");

        gate.resume(1);
        let lifecycle = spawner
            .launch_lifecycle(&rows[0].subagent_run_id)
            .expect("后台启动任务应保留生命周期");
        tokio::time::timeout(
            std::time::Duration::from_secs(3),
            lifecycle.wait_until_started_event_complete(),
        )
        .await
        .expect("后台启动任务应继续完成 started 事件");
        let cfg = SubagentRunConfig {
            subagent_id: rows[0].id.clone(),
            subagent_run_id: rows[0].subagent_run_id.clone(),
            parent_session_id: "sess-main".to_string(),
            task_type: None,
            allowed_write_paths: None,
            output_dir: None,
            started_at_ms: rows[0].started_at,
        };
        spawner
            .on_subagent_terminal(&cfg, SubagentState::Completed)
            .await;
        assert_eq!(spawner.active_count_for_test(), 0, "真实终态释放启动预留");
        let ended = db.load_session_agents("sess-main").unwrap();
        assert_eq!(ended[0].status, "completed");
        assert!(ended[0].ended_at.is_some());
    }

    #[tokio::test]
    async fn cancelled_batch_keeps_launched_run_and_releases_unstarted_reservations() {
        let (spawner, _, db, stream, queue) = test_rig();
        let gate = Arc::new(GateLauncher::new());
        spawner.init(
            Some(Arc::clone(&gate) as Arc<dyn SubagentRunLauncher>),
            Some(db.clone()),
            Some(stream),
            Some(queue),
        );
        setup_main_run(&spawner);

        let requests: Vec<_> = (0..3)
            .map(|index| request(&format!("取消中的批量 {index}"), None))
            .collect();
        let task_spawner = Arc::clone(&spawner);
        let task = tokio::spawn(async move { task_spawner.spawn_many(&requests).await });
        tokio::time::timeout(std::time::Duration::from_secs(3), gate.started.acquire())
            .await
            .expect("批量首项应进入 launcher")
            .expect("started semaphore remains open")
            .forget();

        assert_eq!(spawner.active_count_for_test(), 3, "整批容量在启动前预留");
        task.abort();
        let _ = task.await;

        assert_eq!(
            spawner.active_count_for_test(),
            1,
            "仅当前后台启动项保留容量"
        );
        assert_eq!(gate.launches.load(Ordering::SeqCst), 1);
        let rows = db.load_session_agents("sess-main").unwrap();
        assert_eq!(rows.len(), 1, "仅尝试的首项有落库行");
        assert_eq!(rows[0].status, "running");

        gate.resume(1);
        let lifecycle = spawner
            .launch_lifecycle(&rows[0].subagent_run_id)
            .expect("后台启动任务应保留生命周期");
        tokio::time::timeout(
            std::time::Duration::from_secs(3),
            lifecycle.wait_until_started_event_complete(),
        )
        .await
        .expect("后台启动任务应继续完成 started 事件");
        let cfg = SubagentRunConfig {
            subagent_id: rows[0].id.clone(),
            subagent_run_id: rows[0].subagent_run_id.clone(),
            parent_session_id: "sess-main".to_string(),
            task_type: None,
            allowed_write_paths: None,
            output_dir: None,
            started_at_ms: rows[0].started_at,
        };
        spawner
            .on_subagent_terminal(&cfg, SubagentState::Completed)
            .await;
        assert_eq!(spawner.active_count_for_test(), 0, "真实终态释放活动项");
        assert_eq!(
            db.load_session_agents("sess-main").unwrap()[0].status,
            "completed"
        );
    }

    // ── 批量派发（T-D-06：前瞻快照统一守卫原子语义）───────────────

    #[tokio::test]
    async fn spawn_many_three_tasks_all_launched() {
        let (spawner, launcher, db, _, _) = test_rig();
        setup_main_run(&spawner);
        let reqs: Vec<SubagentSpawnRequest> = (0..3)
            .map(|i| {
                let mut req = request(&format!("批量任务 {i}"), Some(TaskType::Review));
                req.parent_run_id = None; // 工具批量路径：按会话解析
                req
            })
            .collect();

        let results = spawner.spawn_many(&reqs).await.expect("批量派发应成功");
        assert_eq!(results.len(), 3);
        // 结果顺序与入参一致 + id 唯一
        let ids: Vec<&str> = results.iter().map(|r| r.subagent_id.as_str()).collect();
        assert!(ids[0] != ids[1] && ids[1] != ids[2]);
        // 全部落库（3 行）+ 启动 3 次（配置按条携带）
        assert_eq!(db.load_session_agents("sess-main").unwrap().len(), 3);
        assert_eq!(launcher.launches().len(), 3);
        for launch in launcher.launches() {
            assert_eq!(launch.parent_run_id.as_deref(), Some("run-main"));
            assert_eq!(
                launch
                    .subagent_config
                    .as_ref()
                    .unwrap()
                    .task_type
                    .as_deref(),
                Some("review")
            );
        }
    }

    /// 批量守卫拒绝 → 整体失败零 run（session_agents 无新增行）
    #[tokio::test]
    async fn spawn_many_guard_rejection_zero_run() {
        let (spawner, launcher, db, _, _) = test_rig();
        setup_main_run(&spawner);
        // 预占预算：15 个并发 + 批量 3 个（15+3 = 18 > 16 → 拒绝）
        for i in 0..15 {
            let mut req = request(&format!("任务 {i}"), None);
            req.parent_run_id = Some(format!("run-{i}"));
            let _ = spawner.spawn(&req).await.expect("预算内应成功");
        }
        let before = db.load_session_agents("sess-main").unwrap().len();
        let launches_before = launcher.launches().len();
        let reqs: Vec<SubagentSpawnRequest> = (0..3)
            .map(|i| request(&format!("批量 {i}"), None))
            .collect();
        let err = spawner
            .spawn_many(&reqs)
            .await
            .expect_err("批量超限必须整体失败");
        assert!(matches!(
            err,
            SubagentSpawnError::GuardRejected(RecursionGuardRejection::ConcurrentExceeded { .. })
        ));
        assert_eq!(
            db.load_session_agents("sess-main").unwrap().len(),
            before,
            "零 run：无新增行"
        );
        assert_eq!(
            launcher.launches().len(),
            launches_before,
            "零 run：批量无新增启动（前序单发记录不变）"
        );
    }

    /// 空批量：成功返回空（不触碰守卫）
    #[tokio::test]
    async fn spawn_many_empty_returns_empty() {
        let (spawner, _, _, _, _) = test_rig();
        let results = spawner.spawn_many(&[]).await.expect("空批量应成功");
        assert!(results.is_empty());
    }

    // ── 启动失败兜底（行归一 failed；灾难性失败路径）──────────────

    #[tokio::test]
    async fn spawn_launch_failure_marks_row_failed() {
        let launcher = Arc::new(RecordingLauncher::failing());
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&conex_types::SessionIndexEntry {
            id: "sess-main".to_string(),
            title: "主会话".to_string(),
            folder: String::new(),
            is_pinned: false,
            is_archived: false,
            branch_parent_id: None,
            timestamp: "2026-08-05T00:00:00.000Z".to_string(),
            updated_at: 1,
            message_count: 0,
            pinned_message_ids: None,
            engine_cursor: Some(0),
            engine_last_run_id: Some("run-main".to_string()),
            hydrated_from_engine: Some(true),
        })
        .unwrap();
        let spawner = Arc::new(SubagentSpawnerImpl::new());
        spawner.init(
            Some(Arc::clone(&launcher) as Arc<dyn SubagentRunLauncher>),
            Some(db.clone()),
            None,
            None,
        );
        spawner.register_run("run-main", "sess-main", None);
        spawner.set_current_run("sess-main", "run-main");

        let err = spawner
            .spawn(&request("调研", None))
            .await
            .expect_err("启动失败必须上抛 SpawnFailed");
        assert!(matches!(err, SubagentSpawnError::SpawnFailed(_)));
        // 行已落库但归一 failed（防僵尸 running）
        let rows = db.load_session_agents("sess-main").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].status, "failed");
        assert!(rows[0].ended_at.is_some());
        assert_eq!(spawner.active_count_for_test(), 0, "启动失败须释放预留");
    }

    #[tokio::test]
    async fn spawn_launcher_panic_marks_row_failed_and_releases_capacity() {
        let (spawner, _, db, _, _) = test_rig();
        let launcher = Arc::new(PanickingLauncher);
        spawner.init(
            Some(launcher as Arc<dyn SubagentRunLauncher>),
            Some(db.clone()),
            None,
            None,
        );
        setup_main_run(&spawner);

        let err = spawner
            .spawn(&request("启动器 panic", None))
            .await
            .expect_err("启动器 panic 必须归一为启动失败");
        assert!(matches!(err, SubagentSpawnError::SpawnFailed(_)));
        let rows = db.load_session_agents("sess-main").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].status, "failed");
        assert!(rows[0].ended_at.is_some());
        assert_eq!(spawner.active_count_for_test(), 0, "panic 后必须释放容量");

        let terminal_events: Vec<_> = db
            .query_events("sess-main", 0, Some(100))
            .unwrap()
            .into_iter()
            .filter(|event| event.event_type == "subagent-ended")
            .collect();
        assert_eq!(terminal_events.len(), 1, "panic 收口只发一条 failed 终态");
        assert!(terminal_events[0].payload.contains("failed"));
    }

    #[tokio::test]
    async fn started_event_completion_guard_unblocks_terminal_after_panic() {
        let lifecycle = Arc::new(RunLaunchLifecycle::new());
        lifecycle.mark_launch_succeeded(false);
        let event_lifecycle = Arc::clone(&lifecycle);
        let task = tokio::spawn(async move {
            let _completion = StartedEventCompletionGuard(event_lifecycle);
            panic!("simulated started emitter panic");
        });
        assert!(task.await.is_err(), "模拟发射任务应 panic");

        let terminal = tokio::time::timeout(std::time::Duration::from_millis(100), async {
            lifecycle.stage_terminal(SubagentState::Completed);
            lifecycle.wait_until_terminal_ready().await
        })
        .await
        .expect("emitter panic 后终态等待不得卡住");
        assert_eq!(terminal, Some(SubagentState::Completed));
    }

    #[tokio::test]
    async fn spawn_persist_failure_releases_reservation() {
        let (spawner, launcher, db, stream, queue) = test_rig();
        setup_main_run(&spawner);
        spawner.init(
            Some(Arc::clone(&launcher) as Arc<dyn SubagentRunLauncher>),
            None,
            Some(Arc::clone(&stream)),
            Some(Arc::clone(&queue)),
        );

        let err = spawner
            .spawn(&request("存储未接线", None))
            .await
            .expect_err("缺少存储时应失败");
        assert!(matches!(err, SubagentSpawnError::PersistFailed(_)));
        assert_eq!(spawner.active_count_for_test(), 0, "落库失败须释放预留");
        assert!(launcher.launches().is_empty(), "落库失败不得启动 run");

        spawner.init(
            Some(Arc::clone(&launcher) as Arc<dyn SubagentRunLauncher>),
            Some(db),
            Some(stream),
            Some(queue),
        );
        spawner
            .spawn(&request("存储恢复后", None))
            .await
            .expect("落库失败后容量应可复用");
        assert_eq!(spawner.active_count_for_test(), 1);
    }

    #[tokio::test]
    async fn spawn_many_launch_failure_keeps_success_and_releases_rest() {
        let (spawner, _, db, stream, queue) = test_rig();
        let launcher = Arc::new(FailSecondLauncher::default());
        spawner.init(
            Some(Arc::clone(&launcher) as Arc<dyn SubagentRunLauncher>),
            Some(db.clone()),
            Some(stream),
            Some(queue),
        );
        setup_main_run(&spawner);
        let requests: Vec<_> = (0..3)
            .map(|index| request(&format!("部分批量 {index}"), None))
            .collect();

        let err = spawner
            .spawn_many(&requests)
            .await
            .expect_err("第二次启动失败应上抛");
        assert!(matches!(err, SubagentSpawnError::SpawnFailed(_)));
        assert_eq!(launcher.attempts.load(Ordering::SeqCst), 2);
        assert_eq!(spawner.active_count_for_test(), 1, "保留首个成功 run 槽");

        let rows = db.load_session_agents("sess-main").unwrap();
        assert_eq!(rows.len(), 2, "第三项未尝试，因此无落库行");
        assert_eq!(rows[0].status, "running");
        assert_eq!(rows[1].status, "failed");

        let first = &rows[0];
        let cfg = SubagentRunConfig {
            subagent_id: first.id.clone(),
            subagent_run_id: first.subagent_run_id.clone(),
            parent_session_id: "sess-main".to_string(),
            task_type: None,
            allowed_write_paths: None,
            output_dir: None,
            started_at_ms: first.started_at,
        };
        spawner
            .on_subagent_terminal(&cfg, SubagentState::Completed)
            .await;
        assert_eq!(spawner.active_count_for_test(), 0);
    }

    // ── 终态处理（记账释放 / 行更新 / 事件 / wait feed / steering）──

    #[tokio::test]
    async fn terminal_releases_accounting_and_notifies() {
        let (spawner, _, db, stream, queue) = test_rig();
        setup_main_run(&spawner);
        // 订阅 wait 通道（终态事件 feed 断言）
        let mut rx = stream.subscribe();

        let result = spawner
            .spawn(&request("调研", Some(TaskType::Analysis)))
            .await
            .expect("spawn 应成功");
        let cfg = SubagentRunConfig {
            subagent_id: result.subagent_id.clone(),
            subagent_run_id: result.subagent_run_id.clone(),
            parent_session_id: "sess-main".to_string(),
            task_type: Some("analysis".to_string()),
            allowed_write_paths: None,
            output_dir: None,
            started_at_ms: 1,
        };
        spawner
            .on_subagent_terminal(&cfg, SubagentState::Completed)
            .await;

        // 1. 行终态更新（status/ended_at/summary）
        let rows = db.load_session_agents("sess-main").unwrap();
        assert_eq!(rows[0].status, "completed");
        assert!(rows[0].ended_at.is_some());
        assert!(rows[0].summary.is_some());

        // 2. subagent-ended 落库（父会话事件流，M14 唯一发射方）
        let events = db
            .query_events("sess-main", 0, Some(100))
            .expect("事件查询");
        let ended: Vec<_> = events
            .iter()
            .filter(|e| e.event_type == "subagent-ended")
            .collect();
        assert_eq!(ended.len(), 1, "subagent-ended 必达落库");
        assert!(ended[0].payload.contains(&result.subagent_run_id));

        // 3. wait 通道 feed（订阅者实时收到终态事件）
        let terminal = tokio::time::timeout(std::time::Duration::from_secs(3), rx.recv())
            .await
            .expect("wait 通道事件应在窗口内到达")
            .expect("通道未关闭");
        assert_eq!(terminal.subagent_id, result.subagent_id);
        assert_eq!(terminal.status, SubagentState::Completed);

        // 4. steering 通知（主 agent 下一 run 唤醒条目）
        let entries = {
            let mut q = queue.lock().unwrap();
            q.dequeue_all()
        };
        assert_eq!(entries.len(), 1);
        assert!(entries[0].is_steering);
        assert!(
            entries[0].text.contains("子代理"),
            "摘要模板：{}",
            entries[0].text
        );
        assert!(entries[0].text.contains("成功"));
        assert!(entries[0].text.contains(&result.subagent_id));
    }

    #[tokio::test]
    async fn terminal_before_launcher_return_releases_once_and_preserves_event_order() {
        let (spawner, _, db, stream, queue) = test_rig();
        let launcher = Arc::new(ImmediateTerminalLauncher::default());
        spawner.init(
            Some(Arc::clone(&launcher) as Arc<dyn SubagentRunLauncher>),
            Some(db.clone()),
            Some(stream),
            Some(queue),
        );
        launcher.attach(&spawner);
        setup_main_run(&spawner);

        let result = spawner
            .spawn(&request("启动期间立即终态", None))
            .await
            .expect("快速终态不应使 launch 返回失败");
        launcher.wait_for_terminal().await;
        assert_eq!(spawner.active_count_for_test(), 0);
        assert!(!spawner
            .tracking
            .runs
            .lock()
            .unwrap()
            .contains_key(&result.subagent_run_id));
        assert!(!spawner
            .tracking
            .run_depths
            .lock()
            .unwrap()
            .contains_key(&result.subagent_run_id));

        let cfg = SubagentRunConfig {
            subagent_id: result.subagent_id.clone(),
            subagent_run_id: result.subagent_run_id.clone(),
            parent_session_id: "sess-main".to_string(),
            task_type: None,
            allowed_write_paths: None,
            output_dir: None,
            started_at_ms: 1,
        };
        spawner
            .on_subagent_terminal(&cfg, SubagentState::Completed)
            .await;
        assert_eq!(spawner.active_count_for_test(), 0, "重复终态不得二次释放");

        let events = db.query_events("sess-main", 0, Some(100)).unwrap();
        let lifecycle: Vec<&str> = events
            .iter()
            .filter(|event| {
                event.payload.contains(&result.subagent_run_id)
                    && (event.event_type == "subagent-started"
                        || event.event_type == "subagent-ended")
            })
            .map(|event| event.event_type.as_str())
            .collect();
        assert_eq!(lifecycle, vec!["subagent-started", "subagent-ended"]);

        let mut flow_request = request("flow 快速终态", None);
        flow_request.flow_node_id = Some("flow-node-fast".to_string());
        let flow_result = spawner
            .spawn(&flow_request)
            .await
            .expect("flow 快速终态应成功");
        launcher.wait_for_terminal().await;
        assert_eq!(spawner.active_count_for_test(), 0);
        assert!(!spawner
            .tracking
            .flow_nodes
            .lock()
            .unwrap()
            .contains_key(&flow_result.subagent_run_id));
        let events = db.query_events("sess-main", 0, Some(100)).unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|event| {
                    event.event_type == "subagent-ended"
                        && event.payload.contains(&flow_result.subagent_run_id)
                })
                .count(),
            0,
            "flow 快速终态由 FlowScheduler 发射，不应误走工具 ended 路径"
        );

        // 顺序完成的 run 可重复利用槽位，且每个均在 launcher 返回前回收。
        for index in 0..16 {
            spawner
                .spawn(&request(&format!("快速终态 {index}"), None))
                .await
                .expect("owner token 应在快速终态时被一次性释放");
            launcher.wait_for_terminal().await;
            assert_eq!(spawner.active_count_for_test(), 0);
        }
    }

    /// 终态后记账释放：再次 spawn 可复用并发预算
    #[tokio::test]
    async fn terminal_releases_concurrent_budget() {
        let (spawner, _, _, _, _) = test_rig();
        setup_main_run(&spawner);
        let result = spawner
            .spawn(&request("调研", None))
            .await
            .expect("spawn 应成功");
        let cfg = SubagentRunConfig {
            subagent_id: result.subagent_id.clone(),
            subagent_run_id: result.subagent_run_id.clone(),
            parent_session_id: "sess-main".to_string(),
            task_type: None,
            allowed_write_paths: None,
            output_dir: None,
            started_at_ms: 1,
        };
        spawner
            .on_subagent_terminal(&cfg, SubagentState::Failed)
            .await;
        // 兄弟记账释放：同父再 spawn 不触发 SiblingsExceeded
        let again = spawner
            .spawn(&request("再调研", None))
            .await
            .expect("记账释放后应可再派发");
        assert!(again.subagent_id != result.subagent_id);
    }

    // ── 祖先链死锁检查（防循环 fork）─────────────────────────────

    #[tokio::test]
    async fn deadlock_ancestor_chain_rejected() {
        let (spawner, _, _, _, _) = test_rig();
        // 构造链：run-main → sub-run-1（会话 sub-sess-1）→ sub-run-2（会话
        // sub-sess-2）；祖先会话作为目标 → DeadlockDetected
        spawner.register_run("run-main", "sess-main", None);
        spawner.register_run("sub-run-1", "sub-sess-1", Some("run-main".to_string()));
        spawner.register_run("sub-run-2", "sub-sess-2", Some("sub-run-1".to_string()));

        // check_ancestor_chain 纯函数单测：目标 = 祖先会话
        let input = DeadlockCheckInput {
            target_session_id: "sub-sess-1".to_string(),
            ancestor_session_ids: vec![
                "sub-sess-2".to_string(),
                "sub-sess-1".to_string(),
                "sess-main".to_string(),
            ],
        };
        let rejection = check_ancestor_chain(&input).expect_err("祖先链命中必须拒绝");
        assert!(matches!(
            rejection,
            RecursionGuardRejection::DeadlockDetected { target_session_id }
                if target_session_id == "sub-sess-1"
        ));
        // 非祖先链：放行
        let ok_input = DeadlockCheckInput {
            target_session_id: "fresh-sess".to_string(),
            ancestor_session_ids: vec!["sess-main".to_string()],
        };
        assert!(check_ancestor_chain(&ok_input).is_ok());
    }

    /// 祖先链会话收集（spawn 路径集成）：沿 parent_run_id 链从父到根
    #[tokio::test]
    async fn ancestor_chain_collection_follows_parent_links() {
        let (spawner, _, _, _, _) = test_rig();
        spawner.register_run("run-main", "sess-main", None);
        spawner.register_run("sub-run-1", "sub-sess-1", Some("run-main".to_string()));
        spawner.register_run("sub-run-2", "sub-sess-2", Some("sub-run-1".to_string()));

        let chain = spawner.ancestor_sessions(Some("sub-run-2"));
        assert_eq!(
            chain,
            vec![
                "sub-sess-2".to_string(),
                "sub-sess-1".to_string(),
                "sess-main".to_string()
            ],
            "沿 parent_run_id 链从父到根"
        );
        // 未知 run：空链（数据异常不 panic）
        assert!(spawner.ancestor_sessions(Some("ghost-run")).is_empty());
    }

    // ── DAG 端到端（T-D-13 验收：declare_flow → spawn 节点 run → 终态推进）──
    // 契约层等价面：FlowScheduler（orchestrator 公共 API）+ 生产 spawner
    // （SubagentSpawnerImpl，mock launcher 注入）——对齐
    // orchestrator/tests/multi_agent.rs:777 注释的「引擎侧驱动环」等价面：
    // 调度器经 spawner.spawn（flow_node_id 回显）启动节点 run，终态事件
    // 经 on_subagent_terminal 回传推进。

    use orchestrator::flow_graph::{
        FlowDeclaration, FlowNode, FlowNodeState, FlowReportKind, FlowScheduler, FLOW_STATE_KEY,
    };

    #[tokio::test]
    async fn dag_flow_scheduler_with_production_spawner_end_to_end() {
        let (spawner, launcher, db, _, _) = test_rig();
        setup_main_run(&spawner);
        // FlowScheduler 装配（LocalDb 即 FlowMetaStore；会话级 meta 读写）
        let mut scheduler = FlowScheduler::new(
            "sess-main",
            Arc::clone(&spawner) as Arc<dyn SubagentSpawner>,
            Arc::new(db.clone()),
        )
        .expect("调度器创建");
        // 声明编排：A（无依赖）→ B（依赖 A）
        let decl = FlowDeclaration {
            tasks: vec![
                FlowNode {
                    id: "node-a".to_string(),
                    task: "调研模块 A".to_string(),
                    depends_on: Vec::new(),
                    parallel: true,
                    on_failed: None,
                    is_composite: false,
                },
                FlowNode {
                    id: "node-b".to_string(),
                    task: "调研模块 B".to_string(),
                    depends_on: vec!["node-a".to_string()],
                    parallel: true,
                    on_failed: None,
                    is_composite: false,
                },
            ],
            planner_run_id: Some("run-main".to_string()),
        };
        let advance = scheduler.declare_flow(&decl).await.expect("声明编排成功");

        // 首波推进：A spawn（B 被 A 阻塞）
        assert_eq!(advance.started.len(), 1, "A 应启动");
        assert_eq!(advance.started[0].node_id, "node-a");
        let run_a = advance.started[0].subagent_run_id.clone();
        assert!(!advance.flow_terminal);
        // spawner 侧：flow 路径请求携带 parent_run_id = planner_run_id
        let launches = launcher.launches();
        assert_eq!(launches.len(), 1);
        assert_eq!(launches[0].parent_run_id.as_deref(), Some("run-main"));
        let rows = db.load_session_agents("sess-main").expect("行");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].parent_run_id, "run-main");

        // A 终态回传 → 推进：B spawn
        let advance_b = scheduler
            .on_subagent_terminal(&run_a, SubagentState::Completed)
            .await
            .expect("终态推进");
        assert_eq!(advance_b.started.len(), 1, "B 应启动");
        assert_eq!(advance_b.started[0].node_id, "node-b");
        assert_eq!(
            scheduler.node_state("node-a"),
            Some(FlowNodeState::Completed)
        );
        assert_eq!(scheduler.node_state("node-b"), Some(FlowNodeState::Running));
        let run_b = advance_b.started[0].subagent_run_id.clone();

        // B 终态回传 → 编排完成
        let advance_final = scheduler
            .on_subagent_terminal(&run_b, SubagentState::Completed)
            .await
            .expect("终态推进");
        assert!(advance_final.flow_terminal, "全部节点终态 → 编排完成");
        assert_eq!(
            scheduler.node_state("node-b"),
            Some(FlowNodeState::Completed)
        );
        // 幂等：同 run 重复终态通知忽略（不重复推进）
        let again = scheduler
            .on_subagent_terminal(&run_b, SubagentState::Completed)
            .await
            .expect("幂等通知");
        assert!(again.started.is_empty(), "重复终态不重复 spawn");
        // 两个子代理行（A、B）
        assert_eq!(db.load_session_agents("sess-main").unwrap().len(), 2);
    }

    #[tokio::test]
    async fn flow_started_event_is_attempted_before_fast_terminal_event() {
        let (spawner, _, db, stream, queue) = test_rig();
        let launcher = Arc::new(ImmediateTerminalLauncher::default());
        spawner.init(
            Some(Arc::clone(&launcher) as Arc<dyn SubagentRunLauncher>),
            Some(db.clone()),
            Some(stream),
            Some(queue),
        );
        launcher.attach(&spawner);
        setup_main_run(&spawner);

        let emitter = SubagentEventEmitter::new(Arc::new(LocalDbStore::new(db.clone())));
        let mut scheduler = FlowScheduler::new(
            "sess-main",
            Arc::clone(&spawner) as Arc<dyn SubagentSpawner>,
            Arc::new(db.clone()),
        )
        .expect("FlowScheduler")
        .with_subagent_event_emitter(emitter);
        let declaration = FlowDeclaration {
            tasks: vec![FlowNode {
                id: "fast-node".to_string(),
                task: "立即结束的 flow task".to_string(),
                depends_on: Vec::new(),
                parallel: true,
                on_failed: None,
                is_composite: false,
            }],
            planner_run_id: Some("run-main".to_string()),
        };

        let advance = scheduler
            .declare_flow(&declaration)
            .await
            .expect("flow 应启动");
        let run_id = advance.started[0].subagent_run_id.clone();
        launcher.wait_for_terminal().await;
        scheduler
            .on_subagent_terminal(&run_id, SubagentState::Completed)
            .await
            .expect("flow 终态应收口");

        let lifecycle: Vec<String> = db
            .query_events("sess-main", 0, Some(100))
            .unwrap()
            .into_iter()
            .filter(|event| {
                event.payload.contains(&run_id)
                    && (event.event_type == "subagent-started"
                        || event.event_type == "subagent-ended")
            })
            .map(|event| event.event_type)
            .collect();
        assert_eq!(lifecycle, vec!["subagent-started", "subagent-ended"]);
        assert_eq!(spawner.active_count_for_test(), 0);
    }

    #[tokio::test]
    async fn flow_without_event_emitter_keeps_zero_lifecycle_events() {
        let (spawner, _, db, stream, queue) = test_rig();
        let launcher = Arc::new(ImmediateTerminalLauncher::default());
        spawner.init(
            Some(Arc::clone(&launcher) as Arc<dyn SubagentRunLauncher>),
            Some(db.clone()),
            Some(stream),
            Some(queue),
        );
        launcher.attach(&spawner);
        setup_main_run(&spawner);

        let mut scheduler = FlowScheduler::new(
            "sess-main",
            Arc::clone(&spawner) as Arc<dyn SubagentSpawner>,
            Arc::new(db.clone()),
        )
        .expect("FlowScheduler");
        let declaration = FlowDeclaration {
            tasks: vec![FlowNode {
                id: "quiet-node".to_string(),
                task: "不发事件的 flow task".to_string(),
                depends_on: Vec::new(),
                parallel: true,
                on_failed: None,
                is_composite: false,
            }],
            planner_run_id: Some("run-main".to_string()),
        };

        let advance = scheduler
            .declare_flow(&declaration)
            .await
            .expect("flow 应启动");
        let run_id = advance.started[0].subagent_run_id.clone();
        launcher.wait_for_terminal().await;
        scheduler
            .on_subagent_terminal(&run_id, SubagentState::Completed)
            .await
            .expect("flow 终态应收口");

        let lifecycle_events: Vec<_> = db
            .query_events("sess-main", 0, Some(100))
            .unwrap()
            .into_iter()
            .filter(|event| {
                event.payload.contains(&run_id)
                    && (event.event_type == "subagent-started"
                        || event.event_type == "subagent-ended")
            })
            .collect();
        assert!(
            lifecycle_events.is_empty(),
            "未配置 emitter 时 flow 不发事件"
        );
        assert_eq!(spawner.active_count_for_test(), 0);
    }

    /// DAG 失败推进：节点失败（Block 策略默认）→ 依赖节点阻塞 + 上报
    #[tokio::test]
    async fn dag_failed_node_blocks_dependents() {
        let (spawner, _, db, _, _) = test_rig();
        setup_main_run(&spawner);
        let mut scheduler = FlowScheduler::new(
            "sess-main",
            Arc::clone(&spawner) as Arc<dyn SubagentSpawner>,
            Arc::new(db.clone()),
        )
        .expect("调度器创建");
        let decl = FlowDeclaration {
            tasks: vec![
                FlowNode {
                    id: "node-a".to_string(),
                    task: "任务 A".to_string(),
                    depends_on: Vec::new(),
                    parallel: true,
                    on_failed: None,
                    is_composite: false,
                },
                FlowNode {
                    id: "node-b".to_string(),
                    task: "任务 B".to_string(),
                    depends_on: vec!["node-a".to_string()],
                    parallel: true,
                    on_failed: None,
                    is_composite: false,
                },
            ],
            planner_run_id: Some("run-main".to_string()),
        };
        let advance = scheduler.declare_flow(&decl).await.expect("声明编排成功");
        let run_a = advance.started[0].subagent_run_id.clone();

        // A 失败 → Block 策略：B 阻塞 + 失败上报（不 spawn B）；
        // Blocked 为终态（all_terminal 含 Blocked）→ 编排收敛
        let advance_fail = scheduler
            .on_subagent_terminal(&run_a, SubagentState::Failed)
            .await
            .expect("失败推进");
        assert!(advance_fail.started.is_empty(), "B 被阻塞不得 spawn");
        assert!(
            advance_fail.flow_terminal,
            "A failed + B blocked → 编排收敛"
        );
        assert!(
            advance_fail.reports.iter().any(|r| r.node_id == "node-b"),
            "Block 传播上报：{reports:?}",
            reports = advance_fail.reports
        );
        assert_eq!(scheduler.node_state("node-b"), Some(FlowNodeState::Blocked));
    }

    // ── F-013 接线（生产 spawner 落库 flow_node_id，双防线②数据源）──

    /// F-013 红测试（生产 spawner 形态）：flow 调度请求 description=None +
    /// flow_node_id 存在 → 落库行 description 必须承载 flow_node_id，使
    /// load() 反向校验（双防线②，flow_graph.rs:1409-1442 读 row.description
    /// 定位节点）在生产域可命中。修复前：row_for 写 description =
    /// req.description（flow 请求恒 None → 空串），反向校验不命中，崩溃
    /// 窗口形态节点保持 Pending → 重启 advance 会重复 spawn（孤儿双跑）。
    #[tokio::test]
    async fn flow_spawn_row_carries_flow_node_id_for_load_reverse_check() {
        let (spawner, _, db, _, _) = test_rig();
        setup_main_run(&spawner);
        let mut scheduler = FlowScheduler::new(
            "sess-main",
            Arc::clone(&spawner) as Arc<dyn SubagentSpawner>,
            Arc::new(db.clone()),
        )
        .expect("调度器创建");
        let decl = FlowDeclaration {
            tasks: vec![FlowNode {
                id: "node-a".to_string(),
                task: "调研模块 A".to_string(),
                depends_on: Vec::new(),
                parallel: true,
                on_failed: None,
                is_composite: false,
            }],
            planner_run_id: Some("run-main".to_string()),
        };
        let advance = scheduler.declare_flow(&decl).await.expect("声明编排成功");
        assert_eq!(advance.started.len(), 1, "a 应启动");
        let run_a = advance.started[0].subagent_run_id.clone();

        // 断言 1（数据源落库）：run 行 description 承载 flow_node_id
        // （load 反向校验以 row.description 为节点定位载体）
        let rows = db.load_session_agents("sess-main").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].description, "node-a",
            "flow 路径行 description 应承载 flow_node_id（修复前为空串）"
        );

        // 崩溃窗口模拟（T3.4 形态 B）：run 已落库、flow_state 置空 →
        // 重启 load 反向校验须命中并置 Failed（防重复 spawn）
        db.set_session_meta(FLOW_STATE_KEY, "[]").unwrap();
        drop(scheduler);

        let rows = db.load_session_agents("sess-main").unwrap();
        let mut restored = FlowScheduler::load(
            "sess-main",
            Arc::clone(&spawner) as Arc<dyn SubagentSpawner>,
            Arc::new(db.clone()),
            &rows,
        )
        .expect("load 应成功");

        // 断言 2（反向校验命中）：a = Failed（修复前保持 Pending）
        assert_eq!(
            restored.node_state("node-a"),
            Some(FlowNodeState::Failed),
            "反向校验：生产 spawner 落库后 flow_state 无映射 → a = Failed"
        );
        // 断言 3（防双跑核心）：advance 不再 spawn a（DataInconsistent
        // 上报带出 + started 为空）
        let adv = restored.advance().await.expect("advance 应成功");
        assert!(
            adv.reports
                .iter()
                .any(|r| r.kind == FlowReportKind::DataInconsistent && r.node_id == "node-a"),
            "restart_reports 应含 DataInconsistent：{:?}",
            adv.reports
        );
        assert!(adv.started.is_empty(), "a 已按 Failed 处理，不得重复 spawn");
        // 防双跑：run 行数量不变（load + advance 未新增 spawn）
        assert_eq!(db.load_session_agents("sess-main").unwrap().len(), 1);
        let _ = run_a;
    }

    /// F-013 接线回归：非 flow 路径（工具直调）description 语义不受影响
    /// ——row_for 仅当 flow_node_id 存在时承载之，普通描述文本原样落库
    #[tokio::test]
    async fn non_flow_spawn_preserves_user_description() {
        let (spawner, _, db, _, _) = test_rig();
        setup_main_run(&spawner);
        let result = spawner
            .spawn(&request("调研", None))
            .await
            .expect("spawn 应成功");
        let _ = result;
        let rows = db.load_session_agents("sess-main").unwrap();
        assert_eq!(
            rows[0].description, "调研",
            "非 flow 路径 description 原样保留（接线不破坏既有语义）"
        );
    }

    // ── LK-07（R-14 死路径收口：spawn 失败补 ended(failed) + 双发幂等）──

    /// spawn 启动失败补发 subagent-ended(status=failed)：行已归一 failed
    /// 但事件链为空（「行存在但无终态事件」断链）——launch 失败后事件表
    /// 必须含 failed 终态（信封 runId = 父 run）
    #[tokio::test]
    async fn spawn_launch_failure_emits_ended_failed() {
        let launcher = Arc::new(RecordingLauncher::failing());
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&conex_types::SessionIndexEntry {
            id: "sess-main".to_string(),
            title: "主会话".to_string(),
            folder: String::new(),
            is_pinned: false,
            is_archived: false,
            branch_parent_id: None,
            timestamp: "2026-08-05T00:00:00.000Z".to_string(),
            updated_at: 1,
            message_count: 0,
            pinned_message_ids: None,
            engine_cursor: Some(0),
            engine_last_run_id: Some("run-main".to_string()),
            hydrated_from_engine: Some(true),
        })
        .unwrap();
        let spawner = Arc::new(SubagentSpawnerImpl::new());
        spawner.init(
            Some(Arc::clone(&launcher) as Arc<dyn SubagentRunLauncher>),
            Some(db.clone()),
            None,
            None,
        );
        spawner.register_run("run-main", "sess-main", None);
        spawner.set_current_run("sess-main", "run-main");

        let err = spawner
            .spawn(&request("调研", None))
            .await
            .expect_err("启动失败必须上抛 SpawnFailed");
        assert!(matches!(err, SubagentSpawnError::SpawnFailed(_)));

        // 事件链补齐：行 failed + ended(failed) 落库（此前断链——有行无事件）
        let rows = db.load_session_agents("sess-main").unwrap();
        assert_eq!(rows[0].status, "failed");
        let events = db
            .query_events("sess-main", 0, Some(100))
            .expect("事件查询");
        let ended: Vec<_> = events
            .iter()
            .filter(|e| e.event_type == "subagent-ended")
            .collect();
        assert_eq!(ended.len(), 1, "启动失败补发 ended(failed)");
        assert!(
            ended[0].payload.contains("\"status\":\"failed\""),
            "failed 终态：{}",
            ended[0].payload
        );
        assert_eq!(
            ended[0].run_id.as_deref(),
            Some("run-main"),
            "信封 runId = 父 run"
        );
    }

    /// 双发幂等（LK-07 R-14）：kill 命令面已直发 ended(cancelled)（lifecycle
    /// kill_all/kill_subagent 落库）后，run 收口兜底 on_subagent_terminal
    /// 不再重复发射 ended——按「同一父 run 归属性已落库 subagent-ended」
    /// 跳过落库发射（wait 通道仍以本地副本 feed）
    #[tokio::test]
    async fn terminal_skips_ended_when_kill_already_emitted() {
        let (spawner, _, db, stream, _) = test_rig();
        setup_main_run(&spawner);
        let mut rx = stream.subscribe();

        let result = spawner
            .spawn(&request("调研", None))
            .await
            .expect("spawn 应成功");

        // 模拟 kill 直发（lifecycle emit_killed_ended 同构）：父 run 归属
        // 落一条 subagent-ended(cancelled)
        let seq = db.reserve_sequence("sess-main").unwrap();
        db.append_event(
            "sess-main",
            seq,
            "subagent-ended",
            &format!(r#"{{"type":"subagent-ended","runId":"run-main","subagentId":"{}","status":"cancelled"}}"#, result.subagent_id),
            Some("run-main"),
        )
        .expect("kill 直发落库");

        // 收口兜底：kill 已直发 → 不再落库发射（双发消灭）
        let cfg = SubagentRunConfig {
            subagent_id: result.subagent_id.clone(),
            subagent_run_id: result.subagent_run_id.clone(),
            parent_session_id: "sess-main".to_string(),
            task_type: None,
            allowed_write_paths: None,
            output_dir: None,
            started_at_ms: 1,
        };
        spawner
            .on_subagent_terminal(&cfg, SubagentState::Completed)
            .await;

        let events = db
            .query_events("sess-main", 0, Some(100))
            .expect("事件查询");
        let ended: Vec<_> = events
            .iter()
            .filter(|e| e.event_type == "subagent-ended")
            .collect();
        assert_eq!(ended.len(), 1, "kill 直发后收口兜底不重复发 ended");

        // wait 通道仍收到终态（订阅者收口不丢）
        let terminal = tokio::time::timeout(std::time::Duration::from_secs(3), rx.recv())
            .await
            .expect("wait 通道事件应在窗口内到达")
            .expect("通道未关闭");
        assert_eq!(terminal.subagent_id, result.subagent_id);
    }
}
