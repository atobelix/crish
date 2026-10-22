use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use agent_tools::tools::subagent::{
    check_recursion_guard, RecursionGuardConfig, RecursionGuardSnapshot, SubagentSpawnError,
    SubagentSpawnRequest, SubagentSpawnResult, SubagentSpawner, DEFAULT_RECURSION_GUARD,
};
use async_trait::async_trait;
use conex_db::LocalDb;
use crish_agent_workbench::wait_channel::EventStreamBroadcast;
use orchestrator::steering_queue::PendingMessageQueue;

use super::capacity::{CapacityReservation, SpawnIds};
use super::lifecycle::RunLaunchLifecycle;
use super::tracking::{RunRecord, RunTracking};
use super::types::SubagentRunLauncher;

/// 生产 spawner 状态
pub(crate) struct SubagentSpawnerImpl {
    /// 守卫配置（默认：maxDepth=1 / maxSiblings=5 / maxConcurrent=12，
    /// [DEFAULT_RECURSION_GUARD]；flow 调度器可配位不传导——引擎侧统一）
    pub(crate) guard: RecursionGuardConfig,
    /// 自增序号（agent id / run id / 会话 id 唯一性）
    pub(crate) seq: AtomicUsize,
    /// run 启动器（注入槽：CoreRunState 构造后经 [Self::init] 注入）
    pub(crate) launcher: Mutex<Option<Arc<dyn SubagentRunLauncher>>>,
    /// 子代理行存储（注入槽；None = 未注入，落库返回 PersistFailed）
    pub(crate) db: Mutex<Option<LocalDb>>,
    /// wait 通道终态事件流广播（注入槽；终态 feed 订阅者）
    pub(crate) terminal_stream: Mutex<Option<Arc<EventStreamBroadcast>>>,
    /// 跨 run steering 队列（注入槽；终态通知主 agent 唤醒）
    pub(crate) steering_queue: Mutex<Option<Arc<Mutex<PendingMessageQueue>>>>,
    /// 当前活动 run 上下文（session_id → run_id；spawn 时按发起会话定位
    /// 父 run——跨会话并发互不串扰）
    pub(crate) current_runs: Mutex<HashMap<String, String>>,
    /// run 所有权、容量和生命周期的共享状态。后台启动任务持有 Arc，
    /// 调用方 future 取消后仍能完成登记与清理。
    pub(crate) tracking: Arc<RunTracking>,
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
    pub(crate) fn resolve_parent_run(&self, req: &SubagentSpawnRequest) -> Option<String> {
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
    pub(crate) fn check_guard(
        &self,
        snapshot: RecursionGuardSnapshot,
    ) -> Result<(), SubagentSpawnError> {
        check_recursion_guard(snapshot, self.guard).map_err(|rejection| match rejection {
            agent_tools::tools::subagent::RecursionGuardRejection::NestingDenied { .. } => {
                SubagentSpawnError::NestingDenied(rejection)
            }
            other => SubagentSpawnError::GuardRejected(other),
        })
    }

    pub(crate) fn next_spawn_ids(&self, depth: usize) -> SpawnIds {
        let n = self.seq.fetch_add(1, Ordering::SeqCst);
        SpawnIds {
            subagent_id: format!("sub-{depth}-{n}"),
            subagent_run_id: format!("sub-run-{depth}-{n}"),
            session_id: format!("sub-sess-{depth}-{n}"),
        }
    }

    /// 在一个临界区内判定并预留整批容量。兄弟和全局计数都包含尚在
    /// persist/launch 阶段的 run，避免并发调用看到同一份旧快照。
    pub(crate) fn reserve_capacity(
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

    pub(crate) fn launch_lifecycle(&self, run_id: &str) -> Option<Arc<RunLaunchLifecycle>> {
        self.tracking
            .launch_lifecycles
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(run_id)
            .cloned()
    }

    #[cfg(test)]
    pub(crate) fn active_count_for_test(&self) -> usize {
        self.tracking
            .capacity
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reservations
            .len()
    }

    /// 祖先链会话收集（沿 parent_run_id 链，从父到根；死锁检查输入）
    pub(crate) fn ancestor_sessions(&self, parent_run: Option<&str>) -> Vec<String> {
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
