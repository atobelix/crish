//! 调度域（flow_graph 拆分：调度）
//!
//! 职责：`FlowScheduler` 结构体与并发预算、合成唤醒、持久化键、
//! `FlowMetaStore` trait、声明/挂接/重启恢复/预算持久化。推进的不动点
//! 循环与 dirty 集逻辑在 `flow_graph_advance`。

use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::sync::Arc;

use agent_tools::tools::subagent::{
    check_recursion_guard, RecursionGuardConfig, RecursionGuardRejection, RecursionGuardSnapshot,
    SubagentSpawner, SubagentState, DEFAULT_RECURSION_GUARD,
};
use conex_db::LocalDb;
use conex_types::SessionAgent;

use crate::subagent_events::SubagentEventEmitter;

use super::model::{
    FailStrategy, FlowDeclaration, FlowGraph, FlowGraphError, FlowNodeId, FlowNodeRuntime,
    FlowNodeState,
};

// ── 并发预算（reserve / release，复用 RecursionGuard）─────────────

/// 并发预算（记账「已分配」而非「已消耗」：reserved 累计分配、
/// released 累计释放，in_flight = reserved - released）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConcurrencyBudget {
    reserved: u64,
    released: u64,
}

impl Default for ConcurrencyBudget {
    fn default() -> Self {
        Self::new()
    }
}

impl ConcurrencyBudget {
    /// 空预算
    pub fn new() -> Self {
        Self {
            reserved: 0,
            released: 0,
        }
    }

    /// 已分配计数（session_meta `flow_reserved`）
    pub fn reserved(&self) -> u64 {
        self.reserved
    }

    /// 已释放计数（session_meta `flow_released`）
    pub fn released(&self) -> u64 {
        self.released
    }

    /// 在途（未释放）预留数
    pub fn in_flight(&self) -> u64 {
        self.reserved.saturating_sub(self.released)
    }

    /// 分配一个槽位（容量判定由调用方经 RecursionGuard 完成）
    pub fn reserve(&mut self) {
        self.reserved += 1;
    }

    /// 释放一个槽位（节点到终态时调用，幂等由调用方终态守卫保证）
    pub fn release(&mut self) {
        self.released += 1;
    }

    /// 跨重启重算（防 double-charge）：reserved = 活跃 + 已终态，
    /// released = 已终态 → in_flight = 活跃数（已完成任务的预留
    /// 被 released 抵消，未完成任务保留预留）
    pub fn recompute(active: u64, terminal: u64) -> Self {
        Self {
            reserved: active + terminal,
            released: terminal,
        }
    }
}

/// 预算超限类别（RecursionGuard 判定结果映射）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BudgetExceededKind {
    /// 兄弟并发超限（maxSiblings）
    Siblings,
    /// 全局并发超限（maxConcurrent）
    Concurrent,
}

// ── 调度推进产物 ──────────────────────────────────────────────────

/// 本轮启动的节点（spawn 结果）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlowStarted {
    /// 节点 id
    pub node_id: FlowNodeId,
    /// 子代理 run id（引擎侧终态事件按此回传）
    pub subagent_run_id: String,
    /// 综合节点标记（合成唤醒自动排队位）
    pub is_composite: bool,
}

/// 合成唤醒（后置节点全部前置就绪时由调度器产出——不轮询）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlowWakeup {
    /// 就绪的节点 id
    pub node_id: FlowNodeId,
    /// 是否综合节点（gate / verify / critique 类）
    pub is_composite: bool,
    /// planner_run_id 亲和（综合 run 偏好原 planner 执行，记录位）
    pub planner_run_id: Option<String>,
    /// 是否已由调度器自动排队（auto_spawn_composite=true 时综合 run
    /// 已 spawn；false = 观测态只发事件，引擎侧通知主 agent）
    pub auto_spawned: bool,
}

/// 上报类别
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlowReportKind {
    /// 节点失败（Report / Block 策略的上报位；Skip 不上报）
    NodeFailed,
    /// spawn 失败（节点按失败处理并应用策略）
    SpawnFailed,
    /// Block 传播阻塞（阻塞依赖节点并上报）
    Blocked,
    /// 重启数据不一致（run 映射缺失，按失败处理）
    DataInconsistent,
}

/// 调度上报记录（失败 / 阻塞留痕，供引擎侧转呈主 agent 或落事件）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlowReport {
    /// 节点 id
    pub node_id: FlowNodeId,
    /// 关联 run id（spawn 失败 / 阻塞 / 数据不一致时为 None）
    pub run_id: Option<String>,
    /// 生效策略（spawn 失败 / 数据不一致时为 None）
    pub strategy: Option<FailStrategy>,
    /// 上报类别
    pub kind: FlowReportKind,
    /// 结构化文案
    pub message: String,
}

/// 一次推进的结果（终态事件 / 声明 / 重启恢复后由 advance 产出）
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FlowAdvance {
    /// 本轮启动的节点（budget 内即时 spawn）
    pub started: Vec<FlowStarted>,
    /// 合成唤醒（就绪即产，不轮询）
    pub wakeups: Vec<FlowWakeup>,
    /// 本轮新阻塞的节点（Block 传播）
    pub blocked: Vec<FlowNodeId>,
    /// 本轮上报（失败 / 阻塞 / 数据不一致）
    pub reports: Vec<FlowReport>,
    /// 全部节点是否终态（编排完成）
    pub flow_terminal: bool,
}

// ── 调度错误 ──────────────────────────────────────────────────────

/// 调度器错误
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FlowError {
    /// 会话无编排声明（load / 终态通知前置检查）
    NotFound {
        /// 详情
        message: String,
    },
    /// 已有未终态编排（一轮一编排；主 agent 唯一编排者）
    AlreadyDeclared,
    /// 依赖图校验失败（环 / 自依赖 / 重复 id / 未知引用；声明被拒零 run）
    InvalidGraph(FlowGraphError),
    /// 并发预算不足（复用 RecursionGuard 判定）
    BudgetExceeded {
        /// 超限类别
        kind: BudgetExceededKind,
        /// 当前在途数
        current: usize,
        /// 上限
        max: usize,
    },
    /// spawn 失败（节点按失败处理并应用策略）
    SpawnFailed {
        /// 详情
        message: String,
    },
    /// session_meta 读写失败
    PersistFailed {
        /// 详情
        message: String,
    },
    /// 终态通知的 run 不在编排中
    UnknownRun {
        /// run id
        run_id: String,
    },
    /// 非法状态转移 / 参数
    InvalidState {
        /// 详情
        message: String,
    },
}

impl FlowError {
    /// 从 RecursionGuard 拒绝结果映射预算超限错误
    pub(crate) fn from_guard_rejection(rejection: RecursionGuardRejection) -> Self {
        match rejection {
            RecursionGuardRejection::SiblingsExceeded { current, max } => Self::BudgetExceeded {
                kind: BudgetExceededKind::Siblings,
                current,
                max,
            },
            RecursionGuardRejection::ConcurrentExceeded { current, max } => Self::BudgetExceeded {
                kind: BudgetExceededKind::Concurrent,
                current,
                max,
            },
            other => Self::InvalidState {
                message: format!("递归守卫意外拒绝：{}", other.message()),
            },
        }
    }
}
impl From<FlowGraphError> for FlowError {
    fn from(err: FlowGraphError) -> Self {
        Self::InvalidGraph(err)
    }
}

impl fmt::Display for FlowError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound { message } => write!(f, "无编排声明：{message}"),
            Self::AlreadyDeclared => write!(f, "会话已有未终态编排（一轮一编排）"),
            Self::InvalidGraph(err) => write!(f, "依赖图校验失败：{err}"),
            Self::BudgetExceeded { kind, current, max } => {
                write!(f, "并发预算超限（{:?}，当前 {current} > {max}）", kind)
            }
            Self::SpawnFailed { message } => write!(f, "spawn 失败：{message}"),
            Self::PersistFailed { message } => write!(f, "flow 持久化失败：{message}"),
            Self::UnknownRun { run_id } => write!(f, "未知 run（不在编排中）：{run_id}"),
            Self::InvalidState { message } => write!(f, "flow 状态非法：{message}"),
        }
    }
}

impl std::error::Error for FlowError {}

// ── 持久化（session_meta `flow_*` 键命名空间）────────────────────

/// 编排声明键（单键 JSON，Q3 裁决：任务数 >20 再建表）
pub const FLOW_DECLARATION_KEY: &str = "flow_declaration";
/// 节点运行时状态键（run 映射 + 唤醒标记 JSON 数组）
pub const FLOW_STATE_KEY: &str = "flow_state";
/// 会话级默认失败策略键（skip / block / report，默认 block）
pub const FLOW_ON_FAILED_KEY: &str = "flow_on_failed";
/// 预算已分配计数键
pub const FLOW_RESERVED_KEY: &str = "flow_reserved";
/// 预算已释放计数键
pub const FLOW_RELEASED_KEY: &str = "flow_released";
/// 全局并发上限键（默认 RecursionGuardConfig.max_concurrent = 16，
/// 2026-08-11 用户裁决 12→16，跟随 DEFAULT_RECURSION_GUARD）
pub const FLOW_MAX_CONCURRENT_KEY: &str = "flow_max_concurrent";
/// 兄弟并发上限键（默认 RecursionGuardConfig.max_siblings = 16，
/// 2026-08-11 用户裁决 12→16，同父上限 = 全局上限）
pub const FLOW_MAX_SIBLINGS_KEY: &str = "flow_max_siblings";
/// 综合节点自动排队开关键（默认 true；false = 观测态只发唤醒事件）
pub const FLOW_AUTO_COMPOSITE_KEY: &str = "flow_auto_composite";

/// session_meta 读写抽象（引擎侧经 [LocalDb] 实现；测试用内存实现）
///
/// E2 收敛（保守路线）：本 trait 即 `MetaStore`（同步 get_meta/set_meta 最小公共面）。
/// - `Store`（persist.rs）为 async event/run trait，不含此同步 meta 方法；
/// - `RecoveryStore`（recovery_store.rs）的 `get_meta`/`set_meta` 与本 trait 同步签名形状一致
///  （`&str` key/value、`Option<String>`），错误类型 domain-specific（`FlowError` vs `RecoveryError`）
///   故不强制 supertrait 合并（async/sync 差异 + 循环依赖风险）；
/// - 历史名 `FlowMetaStore` 保留，新代码可使用 `MetaStore` 别名，re-export 路径不 break。
pub trait FlowMetaStore: Send + Sync {
    /// 读键（None = 键不存在）
    fn get_meta(&self, key: &str) -> Result<Option<String>, FlowError>;
    /// 写键（幂等 upsert）
    fn set_meta(&self, key: &str, value: &str) -> Result<(), FlowError>;
}

/// E2 别名：`MetaStore` 即 `FlowMetaStore`（同步 meta 最小公共面），供新代码直接使用；
/// `FlowMetaStore` 为历史名，保持 `crate::flow_graph::FlowMetaStore` 路径不 break。
pub use FlowMetaStore as MetaStore;

impl FlowMetaStore for LocalDb {
    fn get_meta(&self, key: &str) -> Result<Option<String>, FlowError> {
        self.get_session_meta(key)
            .map_err(|e| FlowError::PersistFailed {
                message: e.to_string(),
            })
    }

    fn set_meta(&self, key: &str, value: &str) -> Result<(), FlowError> {
        self.set_session_meta(key, value)
            .map_err(|e| FlowError::PersistFailed {
                message: e.to_string(),
            })
    }
}

/// 读取会话级默认失败策略（`flow_on_failed`，缺失 = Block）
pub(crate) fn read_meta_strategy(meta: &dyn FlowMetaStore) -> Result<FailStrategy, FlowError> {
    match meta.get_meta(FLOW_ON_FAILED_KEY)? {
        Some(raw) => FailStrategy::parse(&raw).ok_or_else(|| FlowError::InvalidState {
            message: format!("flow_on_failed 未知策略：{raw}"),
        }),
        None => Ok(FailStrategy::Block),
    }
}

/// 读取可配预算与综合节点开关（缺失 = DEFAULT_RECURSION_GUARD / true）
pub(crate) fn read_meta_config(
    meta: &dyn FlowMetaStore,
) -> Result<(usize, usize, bool), FlowError> {
    let default = DEFAULT_RECURSION_GUARD;
    let max_siblings = read_meta_usize(meta, FLOW_MAX_SIBLINGS_KEY, default.max_siblings)?;
    let max_concurrent = read_meta_usize(meta, FLOW_MAX_CONCURRENT_KEY, default.max_concurrent)?;
    let auto_spawn_composite = match meta.get_meta(FLOW_AUTO_COMPOSITE_KEY)? {
        Some(raw) => raw.parse::<bool>().map_err(|e| FlowError::InvalidState {
            message: format!("flow_auto_composite 解析失败：{e}"),
        })?,
        None => true,
    };
    Ok((max_siblings, max_concurrent, auto_spawn_composite))
}

/// 读取 usize 型元数据键（缺失 / 解析失败取默认；可配位宽容语义）
pub(crate) fn read_meta_usize(
    meta: &dyn FlowMetaStore,
    key: &str,
    default: usize,
) -> Result<usize, FlowError> {
    match meta.get_meta(key)? {
        Some(raw) => Ok(raw.parse::<usize>().unwrap_or(default)),
        None => Ok(default),
    }
}

// ── 调度器 ────────────────────────────────────────────────────────

/// 依赖图调度器（事件驱动：终态事件 → 内部推进；不轮询）
pub struct FlowScheduler {
    pub(crate) session_id: String,
    /// 编排声明（None = 未声明，advance 返回空推进）
    pub(crate) graph: Option<FlowGraph>,
    /// 声明编排的主 run id（综合 run 亲和记录位）
    pub(crate) planner_run_id: Option<String>,
    /// 会话级默认失败策略（节点 on_failed 未声明时生效）
    pub(crate) default_strategy: FailStrategy,
    /// 守卫配置（maxSiblings / maxConcurrent，复用 DEFAULT_RECURSION_GUARD）
    pub(crate) guard: RecursionGuardConfig,
    /// 综合节点自动排队开关（false = 观测态只发唤醒事件）
    pub(crate) auto_spawn_composite: bool,
    /// 节点运行时记录（run 映射 / 唤醒标记；状态在 session_agents 行）
    pub(crate) runtime: HashMap<FlowNodeId, FlowNodeRuntime>,
    /// 节点运行态（内存真源；重启时从 session_agents 行重建）
    pub(crate) states: HashMap<FlowNodeId, FlowNodeState>,
    /// 并发预算（reserved / released 落 `flow_reserved` / `flow_released`）
    pub(crate) budget: ConcurrencyBudget,
    /// spawn 通道（M2 契约：守卫校验 + 落库 + 独立 run 启动在引擎侧）
    pub(crate) spawner: Arc<dyn SubagentSpawner>,
    /// session_meta 读写
    pub(crate) meta: Arc<dyn FlowMetaStore>,
    /// 合成唤醒队列（take_wakeups 消费）
    pub(crate) wakeups: VecDeque<FlowWakeup>,
    /// 重启数据不一致上报（load 积压，首轮 advance 一次性带出）
    pub(crate) restart_reports: Vec<FlowReport>,
    /// 增量就绪集：状态变化波及的节点。advance 每轮只对这些节点做
    /// is_ready；入口可全量灌 Pending，循环内 dirty 空则退出。
    pub(crate) dirty_set: HashSet<FlowNodeId>,
    /// 子代理事件发射器（M14 唯一发射方；None = 纯编排逻辑不发射。
    /// 事件只观测不阻塞编排：发射失败记录日志继续）
    pub(crate) subagent_events: Option<SubagentEventEmitter>,
}

impl FlowScheduler {
    /// 新建调度器（空编排；声明经 [Self::declare_flow] 建立）。
    ///
    /// 可配位（session_meta 键）：`flow_on_failed` / `flow_max_concurrent` /
    /// `flow_max_siblings` / `flow_auto_composite`。
    pub fn new(
        session_id: impl Into<String>,
        spawner: Arc<dyn SubagentSpawner>,
        meta: Arc<dyn FlowMetaStore>,
    ) -> Result<Self, FlowError> {
        let (max_siblings, max_concurrent, auto_spawn_composite) = read_meta_config(&*meta)?;
        Ok(Self {
            session_id: session_id.into(),
            graph: None,
            planner_run_id: None,
            default_strategy: read_meta_strategy(&*meta)?,
            guard: RecursionGuardConfig {
                max_depth: DEFAULT_RECURSION_GUARD.max_depth,
                max_siblings,
                max_concurrent,
            },
            auto_spawn_composite,
            runtime: HashMap::new(),
            states: HashMap::new(),
            budget: ConcurrencyBudget::new(),
            spawner,
            meta,
            wakeups: VecDeque::new(),
            restart_reports: Vec::new(),
            dirty_set: HashSet::new(),
            subagent_events: None,
        })
    }

    /// 挂载子代理事件发射器（M14：spawn 成功发 subagent-started、
    /// 收口发 subagent-ended；若生产 spawner 接管 flow 生命周期则由它成对发射；
    /// 不挂载则不发射——编排纯逻辑域保持零事件）
    pub fn with_subagent_event_emitter(mut self, emitter: SubagentEventEmitter) -> Self {
        self.subagent_events = Some(emitter);
        self
    }

    /// 会话 id
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// 编排声明（None = 未声明）
    pub fn graph(&self) -> Option<&FlowGraph> {
        self.graph.as_ref()
    }

    /// 节点运行态
    pub fn node_state(&self, node_id: &str) -> Option<FlowNodeState> {
        self.states.get(node_id).copied()
    }

    /// 当前预算快照
    pub fn budget(&self) -> ConcurrencyBudget {
        self.budget
    }

    /// 预算在途数（供引擎侧合并进全局 RecursionGuard 快照）
    pub fn budget_in_flight(&self) -> u64 {
        self.budget.in_flight()
    }

    /// 全部节点是否终态（编排完成）
    pub fn flow_terminal(&self) -> bool {
        self.all_terminal()
    }

    /// 待消费唤醒数
    pub fn wakeup_count(&self) -> usize {
        self.wakeups.len()
    }

    /// 消费合成唤醒队列（引擎侧经 L1 注入通知主 agent / 转呈）
    pub fn take_wakeups(&mut self) -> Vec<FlowWakeup> {
        self.wakeups.drain(..).collect()
    }

    /// run id → 节点 id 反查
    pub fn run_node(&self, subagent_run_id: &str) -> Option<&str> {
        self.runtime
            .iter()
            .find(|(_, rt)| rt.subagent_run_id.as_deref() == Some(subagent_run_id))
            .map(|(node_id, _)| node_id.as_str())
    }

    /// 声明编排（04 C6 行为 1/6）：staged-clone 校验（环 / 自依赖 /
    /// 重复 id / 未知引用）→ 原子落库 → 立即推进首波。
    pub async fn declare_flow(&mut self, decl: &FlowDeclaration) -> Result<FlowAdvance, FlowError> {
        let graph = FlowGraph::from_declaration(decl)?;
        if let Some(existing) = &self.graph {
            let all_terminal = existing.nodes().iter().all(|n| {
                self.states
                    .get(&n.id)
                    .map(|s| s.is_terminal())
                    .unwrap_or(false)
            });
            if !all_terminal {
                return Err(FlowError::AlreadyDeclared);
            }
        }
        self.planner_run_id = decl.planner_run_id.clone();
        self.persist_declaration(&graph)?;
        self.meta.set_meta(FLOW_STATE_KEY, "[]")?;
        self.meta.set_meta(FLOW_RESERVED_KEY, "0")?;
        self.meta.set_meta(FLOW_RELEASED_KEY, "0")?;
        self.graph = Some(graph);
        self.planner_run_id = decl.planner_run_id.clone();
        let (max_siblings, max_concurrent, auto_spawn_composite) = read_meta_config(&*self.meta)?;
        self.guard = RecursionGuardConfig {
            max_depth: DEFAULT_RECURSION_GUARD.max_depth,
            max_siblings,
            max_concurrent,
        };
        self.auto_spawn_composite = auto_spawn_composite;
        self.default_strategy = read_meta_strategy(&*self.meta)?;
        self.runtime.clear();
        self.states.clear();
        self.wakeups.clear();
        self.restart_reports.clear();
        self.dirty_set.clear();
        for node in self.graph.as_ref().expect("声明已写入").nodes() {
            self.states.insert(node.id.clone(), FlowNodeState::Pending);
        }
        self.budget = ConcurrencyBudget::new();
        self.advance().await
    }

    /// 挂接外部 run 到综合节点（合成唤醒观测态：主 agent 收到唤醒事件后
    /// 自行 spawn 综合 run，引擎侧把 run id 挂回节点）。
    pub fn attach_run(&mut self, node_id: &str, subagent_run_id: &str) -> Result<(), FlowError> {
        let Some(graph) = &self.graph else {
            return Err(FlowError::NotFound {
                message: "会话无编排声明".to_string(),
            });
        };
        let node = graph.node(node_id).ok_or_else(|| FlowError::InvalidState {
            message: format!("节点不存在：{node_id}"),
        })?;
        if !node.is_composite {
            return Err(FlowError::InvalidState {
                message: format!("只有综合节点可挂接外部 run：{node_id}"),
            });
        }
        if self.states.get(node_id).copied() != Some(FlowNodeState::Pending) {
            return Err(FlowError::InvalidState {
                message: format!("节点 {node_id} 非待启动态，不能挂接 run"),
            });
        }
        if !self.is_ready(node) {
            return Err(FlowError::InvalidState {
                message: format!("节点 {node_id} 前置未全部 completed，不能挂接 run"),
            });
        }
        let runtime = self
            .runtime
            .entry(node_id.to_string())
            .or_insert_with(|| FlowNodeRuntime::new(node_id.to_string()));
        if runtime.subagent_run_id.is_some() {
            return Err(FlowError::InvalidState {
                message: format!("节点 {node_id} 已有关联 run"),
            });
        }
        let in_flight = self.budget.in_flight() as usize;
        let snapshot = RecursionGuardSnapshot {
            depth: 1,
            active_siblings: in_flight,
            active_concurrent: in_flight,
        };
        if let Err(rejection) = check_recursion_guard(snapshot, self.guard) {
            return Err(FlowError::from_guard_rejection(rejection));
        }
        runtime.subagent_run_id = Some(subagent_run_id.to_string());
        self.states
            .insert(node_id.to_string(), FlowNodeState::Running);
        self.mark_successors_dirty(node_id);
        self.budget.reserve();
        self.persist_runtime()?;
        self.persist_budget()?;
        Ok(())
    }

    /// 重启恢复：从 `flow_*` 键 + session_agents 行重建调度器。
    pub fn load(
        session_id: impl Into<String>,
        spawner: Arc<dyn SubagentSpawner>,
        meta: Arc<dyn FlowMetaStore>,
        agent_rows: &[SessionAgent],
    ) -> Result<Self, FlowError> {
        let session_id = session_id.into();
        let raw = meta
            .get_meta(FLOW_DECLARATION_KEY)?
            .ok_or_else(|| FlowError::NotFound {
                message: "会话无 flow_declaration 编排声明".to_string(),
            })?;
        let declaration: FlowDeclaration =
            serde_json::from_str(&raw).map_err(|e| FlowError::InvalidState {
                message: format!("flow_declaration 解析失败：{e}"),
            })?;
        let graph = FlowGraph::from_declaration(&declaration)?;
        let runtime: HashMap<FlowNodeId, FlowNodeRuntime> = match meta.get_meta(FLOW_STATE_KEY)? {
            Some(state_raw) => {
                let entries: Vec<FlowNodeRuntime> =
                    serde_json::from_str(&state_raw).map_err(|e| FlowError::InvalidState {
                        message: format!("flow_state 解析失败：{e}"),
                    })?;
                entries
                    .into_iter()
                    .map(|rt| (rt.node_id.clone(), rt))
                    .collect()
            }
            None => HashMap::new(),
        };
        let (max_siblings, max_concurrent, auto_spawn_composite) = read_meta_config(&*meta)?;
        let default_strategy = read_meta_strategy(&*meta)?;
        let mut states: HashMap<FlowNodeId, FlowNodeState> = graph
            .nodes()
            .iter()
            .map(|n| (n.id.clone(), FlowNodeState::Pending))
            .collect();
        let rows: HashMap<&str, &SessionAgent> = agent_rows
            .iter()
            .map(|r| (r.subagent_run_id.as_str(), r))
            .collect();
        let mut restart_reports = Vec::new();
        for (node_id, rt) in &runtime {
            let Some(run_id) = &rt.subagent_run_id else {
                continue;
            };
            match rows.get(run_id.as_str()) {
                Some(row) => {
                    let subagent_state = SubagentState::from_db_status(&row.status);
                    states.insert(
                        node_id.clone(),
                        FlowNodeState::from_subagent(subagent_state),
                    );
                }
                None => {
                    states.insert(node_id.clone(), FlowNodeState::Failed);
                    restart_reports.push(FlowReport {
                        node_id: node_id.clone(),
                        run_id: Some(run_id.clone()),
                        strategy: None,
                        kind: FlowReportKind::DataInconsistent,
                        message: format!(
                            "节点 {node_id} 的 run {run_id} 在 session_agents 无记录，按失败处理"
                        ),
                    });
                }
            }
        }
        for row in agent_rows {
            let node_id = &row.description;
            if node_id.is_empty() {
                continue;
            }
            let Some(node) = graph.node(node_id) else {
                continue;
            };
            if runtime.contains_key(&node.id) {
                continue;
            }
            if states.get(&node.id).copied() != Some(FlowNodeState::Pending) {
                continue;
            }
            states.insert(node.id.clone(), FlowNodeState::Failed);
            restart_reports.push(FlowReport {
                node_id: node.id.clone(),
                run_id: Some(row.subagent_run_id.clone()),
                strategy: None,
                kind: FlowReportKind::DataInconsistent,
                message: format!(
                    "节点 {} 的 run {} 已存在于 session_agents 但 flow_state 无映射（spawn 后崩溃窗口），按失败处理防重复 spawn",
                    node.id, row.subagent_run_id
                ),
            });
        }
        let active = states
            .values()
            .filter(|s| **s == FlowNodeState::Running)
            .count() as u64;
        let terminal = states.values().filter(|s| s.is_terminal()).count() as u64;
        let budget = ConcurrencyBudget::recompute(active, terminal);
        let scheduler = Self {
            session_id,
            graph: Some(graph),
            planner_run_id: declaration.planner_run_id.clone(),
            default_strategy,
            guard: RecursionGuardConfig {
                max_depth: DEFAULT_RECURSION_GUARD.max_depth,
                max_siblings,
                max_concurrent,
            },
            auto_spawn_composite,
            runtime,
            states,
            budget,
            spawner,
            meta,
            wakeups: VecDeque::new(),
            restart_reports,
            dirty_set: HashSet::new(),
            subagent_events: None,
        };
        scheduler.persist_budget()?;
        Ok(scheduler)
    }

    /// 清空编排（引擎侧在编排全终态后调用；允许新一轮声明）。
    pub fn reset_flow(&mut self) -> Result<(), FlowError> {
        self.graph = None;
        self.planner_run_id = None;
        self.runtime.clear();
        self.states.clear();
        self.wakeups.clear();
        self.restart_reports.clear();
        self.dirty_set.clear();
        self.budget = ConcurrencyBudget::new();
        self.meta.set_meta(FLOW_DECLARATION_KEY, "")?;
        self.meta.set_meta(FLOW_STATE_KEY, "[]")?;
        self.meta.set_meta(FLOW_RESERVED_KEY, "0")?;
        self.meta.set_meta(FLOW_RELEASED_KEY, "0")?;
        Ok(())
    }

    pub(crate) fn persist_declaration(&self, graph: &FlowGraph) -> Result<(), FlowError> {
        let declaration = FlowDeclaration {
            tasks: graph.nodes().to_vec(),
            planner_run_id: self.planner_run_id.clone(),
        };
        let json = serde_json::to_string(&declaration).map_err(|e| FlowError::InvalidState {
            message: format!("编排声明序列化失败：{e}"),
        })?;
        self.meta.set_meta(FLOW_DECLARATION_KEY, &json)
    }

    pub(crate) fn persist_runtime(&self) -> Result<(), FlowError> {
        let mut runtimes: Vec<FlowNodeRuntime> = self.runtime.values().cloned().collect();
        runtimes.sort_by(|a, b| a.node_id.cmp(&b.node_id));
        let json = serde_json::to_string(&runtimes).map_err(|e| FlowError::InvalidState {
            message: format!("flow_state 序列化失败：{e}"),
        })?;
        self.meta.set_meta(FLOW_STATE_KEY, &json)
    }

    pub(crate) fn persist_budget(&self) -> Result<(), FlowError> {
        self.meta
            .set_meta(FLOW_RESERVED_KEY, &self.budget.reserved().to_string())?;
        self.meta
            .set_meta(FLOW_RELEASED_KEY, &self.budget.released().to_string())
    }
}
