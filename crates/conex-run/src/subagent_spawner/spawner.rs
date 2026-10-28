use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use crate::wait_channel::EventStreamBroadcast;
use agent_tools::tools::subagent::{
    SubagentSpawnError, SubagentSpawnRequest, SubagentSpawnResult, SubagentSpawner,
};
use conex_agents::guard::{
    check_recursion_guard, RecursionGuardSnapshot, SpawnPolicy, DEFAULT_SPAWN_POLICY,
};
use async_trait::async_trait;
use conex_db::LocalDb;
use orchestrator::steering_queue::PendingMessageQueue;

use super::capacity::{CapacityReservation, SpawnIds};
use super::lifecycle::RunLaunchLifecycle;
use super::tracking::{RunRecord, RunTracking};
use super::types::SubagentRunLauncher;

/// 生产 spawner 状态
pub struct SubagentSpawnerImpl {
    /// 默认派遣策略（未配置会话策略时的兜底；运行时可调）
    pub policy: Arc<Mutex<SpawnPolicy>>,
    /// 会话级派遣策略（`agent_policy` 持久化后的内存真值）
    pub session_policies: Mutex<HashMap<String, SpawnPolicy>>,
    /// 子代理路由注册（mailbox；spawn/终态时登记与注销）
    pub registrar:
        Mutex<Option<Arc<dyn agent_tools::tools::subagent_report::ChildAgentRegistrar>>>,
    /// 自增序号（agent id / run id / 会话 id 唯一性）
    pub seq: AtomicUsize,
    /// run 启动器（注入槽：CoreRunState 构造后经 [Self::init] 注入）
    pub launcher: Mutex<Option<Arc<dyn SubagentRunLauncher>>>,
    /// 子代理行存储（注入槽；None = 未注入，落库返回 PersistFailed）
    pub db: Mutex<Option<LocalDb>>,
    /// wait 通道终态事件流广播（注入槽；终态 feed 订阅者）
    pub terminal_stream: Mutex<Option<Arc<EventStreamBroadcast>>>,
    /// 跨 run steering 队列（注入槽；终态通知主 agent 唤醒）
    pub steering_queue: Mutex<Option<Arc<Mutex<PendingMessageQueue>>>>,
    /// 当前活动 run 上下文（session_id → run_id；spawn 时按发起会话定位
    /// 父 run——跨会话并发互不串扰）
    pub current_runs: Mutex<HashMap<String, String>>,
    /// run 所有权、容量和生命周期的共享状态。后台启动任务持有 Arc，
    /// 调用方 future 取消后仍能完成登记与清理。
    pub tracking: Arc<RunTracking>,
}

impl std::fmt::Debug for SubagentSpawnerImpl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SubagentSpawnerImpl")
            .field("policy", &self.policy())
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

impl Default for SubagentSpawnerImpl {
    fn default() -> Self {
        Self::new()
    }
}

impl SubagentSpawnerImpl {
    /// 新建生产 spawner（注入槽为空；[Self::init] 装配后可用）
    pub fn new() -> Self {
        Self {
            policy: Arc::new(Mutex::new(DEFAULT_SPAWN_POLICY)),
            session_policies: Mutex::new(HashMap::new()),
            registrar: Mutex::new(None),
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
    pub fn init(
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
    pub fn register_run(&self, run_id: &str, session_id: &str, parent_run_id: Option<String>) {
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
    pub fn set_current_run(&self, session_id: &str, run_id: &str) {
        self.current_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(session_id.to_string(), run_id.to_string());
    }

    /// 测试面：登记「存活子代理 run」的深度记账（嵌套守卫测试直接构造
    /// 子代理发起场景——不经真实 spawn，避免 drive_run_loop 收口竞态；
    /// 对齐 CoreRunState::set_timer_has_active 的 cfg(test) 注入先例）
    #[cfg(test)]
    pub fn note_depth_for_test(&self, run_id: &str, depth: usize, session_id: &str) {
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
    pub fn clear_current_run(&self, session_id: &str, run_id: &str) {
        let mut map = self.current_runs.lock().unwrap_or_else(|e| e.into_inner());
        if map.get(session_id).map(String::as_str) == Some(run_id) {
            map.remove(session_id);
        }
    }

    /// 解析发起 run（工具直调路径请求恒 None；flow 调度器路径已携带）：
    /// 显式值优先，缺省按「发起会话的当前活动 run」补齐
    pub fn resolve_parent_run(&self, req: &SubagentSpawnRequest) -> Option<String> {
        if req.parent_run_id.is_some() {
            return req.parent_run_id.clone();
        }
        self.current_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&req.parent_session_id)
            .cloned()
    }

    /// 从父级 ActiveRun 提取生效的权限模式（单一真源，供子代理无损继承）
    pub fn get_active_run_permission_mode(
        &self,
        run_id: Option<&str>,
    ) -> Option<conex_types::PermissionMode> {
        let run_id = run_id?;
        let launcher = self.launcher.lock().unwrap_or_else(|e| e.into_inner()).clone()?;
        launcher.get_active_run_permission_mode(run_id)
    }

    /// 守卫判定（T-D-02 映射：嵌套禁止走专用错误变体 + 专用错误码
    /// subagent.nesting_denied；其余复用 GuardRejected——对齐 DbSpawner
    /// 测试域先例 subagent.rs:2521-2531）
    /// 当前派遣策略快照
    pub fn policy(&self) -> SpawnPolicy {
        *self.policy.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 运行时更新默认派遣策略（无会话策略时生效）
    pub fn set_policy(&self, policy: SpawnPolicy) {
        *self.policy.lock().unwrap_or_else(|e| e.into_inner()) = policy;
    }

    /// 绑定子代理路由注册（mailbox）
    pub fn set_child_registrar(
        &self,
        registrar: Arc<dyn agent_tools::tools::subagent_report::ChildAgentRegistrar>,
    ) {
        *self.registrar.lock().unwrap_or_else(|e| e.into_inner()) = Some(registrar);
    }

    /// 当前路由注册（None = 未绑定）
    pub fn child_registrar(
        &self,
    ) -> Option<Arc<dyn agent_tools::tools::subagent_report::ChildAgentRegistrar>> {
        self.registrar
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 设置会话级策略（`AgentPolicyService` 加载/修改后调用）
    pub fn set_session_policy(&self, session_id: &str, policy: SpawnPolicy) {
        self.session_policies
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(session_id.to_string(), policy);
    }

    /// 会话当前策略（无会话配置 → 默认策略）
    pub fn policy_for(&self, session_id: &str) -> SpawnPolicy {
        self.session_policies
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session_id)
            .copied()
            .unwrap_or_else(|| self.policy())
    }

    pub fn check_guard(
        &self,
        session_id: &str,
        snapshot: RecursionGuardSnapshot,
    ) -> Result<(), SubagentSpawnError> {
        check_recursion_guard(snapshot, self.policy_for(session_id)).map_err(|rejection| {
            match rejection {
                conex_agents::guard::RecursionGuardRejection::NestingDenied { .. } => {
                    SubagentSpawnError::NestingDenied(rejection)
                }
                other => SubagentSpawnError::GuardRejected(other),
            }
        })
    }

    pub fn next_spawn_ids(&self, depth: usize) -> SpawnIds {
        let n = self.seq.fetch_add(1, Ordering::SeqCst);
        SpawnIds {
            subagent_id: format!("sub-{depth}-{n}"),
            subagent_run_id: format!("sub-run-{depth}-{n}"),
            session_id: format!("sub-sess-{depth}-{n}"),
        }
    }

    /// 在一个临界区内判定并预留整批容量。兄弟和全局计数都包含尚在
    /// persist/launch 阶段的 run，避免并发调用看到同一份旧快照。
    pub fn reserve_capacity(
        &self,
        session_id: &str,
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
        self.check_guard(
            session_id,
            RecursionGuardSnapshot {
                depth,
                active_siblings: active_siblings.saturating_add(requested),
                active_concurrent: capacity.reservations.len().saturating_add(requested),
            },
        )?;

        for run_id in run_ids {
            capacity
                .reservations
                .insert(run_id.clone(), parent_run.map(str::to_string));
        }
        Ok(())
    }

    pub fn launch_lifecycle(&self, run_id: &str) -> Option<Arc<RunLaunchLifecycle>> {
        self.tracking
            .launch_lifecycles
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(run_id)
            .cloned()
    }

    #[cfg(test)]
    pub fn active_count_for_test(&self) -> usize {
        self.tracking
            .capacity
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reservations
            .len()
    }

    /// 祖先链会话收集（沿 parent_run_id 链，从父到根；死锁检查输入）
    pub fn ancestor_sessions(&self, parent_run: Option<&str>) -> Vec<String> {
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

    fn set_session_policy(&self, session_id: &str, policy: SpawnPolicy) {
        SubagentSpawnerImpl::set_session_policy(self, session_id, policy);
    }

    fn set_child_registrar(
        &self,
        registrar: Arc<dyn agent_tools::tools::subagent_report::ChildAgentRegistrar>,
    ) {
        SubagentSpawnerImpl::set_child_registrar(self, registrar);
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
        self.reserve_capacity(
            &requests[0].parent_session_id,
            &run_ids,
            parent_run.as_deref(),
            depth,
        )?;
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
