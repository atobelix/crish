//! C6 依赖图调度器（I5-M6：02 方案 §2 M6 / 04 方案 §2 C6）
//!
//! 主 agent 以依赖图编排子 agent 执行序列：after/parallel 声明、环检测、
//! gate 强制（全部前置 completed 才启动后置）、on_failed 三策略、并发预算
//! reserve/release、重启恢复、合成唤醒（不轮询）。本模块为调度核心，
//! session.rs 主写权归 C6（M6）保持（本模块独立成文件，不并写 SessionTree）。
//!
//! parallel 串行约束（裁决 D2 冻结：同级 = 同 depends_on 集合）：同波次
//! （depends_on 集合相同）的节点中，parallel=false 者须等待声明序在前、
//! 同样 parallel=false 的同级节点全部进入终态后才就绪；parallel=true 者
//! 不受约束（显式声明并发）。实现落点：is_ready + serial_predecessor_pending
//! 判定；advance 以 dirty 增量就绪集做不动点（状态变化标后继脏，dirty
//! 空则退出），终态事件驱动重推进。
//!
//! 三问：
//! - 隔离边界：依赖图只推进不回溯（已 completed 不重复启动）；并发预算
//!   只统计流程节点预留（全局守卫由引擎侧 spawner 的 RecursionGuard 兜底——
//!   maxDepth=1 嵌套禁止，T-D-01：流程节点全部为主 Agent 直接子节点，
//!   快照 depth 恒为 1，不受嵌套禁止影响）；
//! - 干预入口：终态事件驱动推进（[FlowScheduler::on_subagent_terminal]），
//!   主 agent 唯一编排者（子 agent 无权修改依赖图），L3 强停由引擎侧兜底；
//! - 持久化：编排声明与运行时状态存 session_meta `flow_*` 键命名空间
//!   （[FLOW_DECLARATION_KEY] 等），每任务状态在 session_agents 行。
//!
//! 策略映射说明（任务卡 I5-M6 与 04 文档 C6 的术语对齐）：
//! - [FailStrategy::Block] = 04 文档 `abort`（前置失败 → 阻塞依赖它的节点并上报）；
//! - [FailStrategy::Skip] = 04 文档 `skip`（跳过失败节点，后置照常，不影响同级）；
//! - [FailStrategy::Report] = 04 文档 `retry_once` 的去重试形态（照常推进但记录）。
//!
//! 合成唤醒（02 方案 M6 内容 7）：后置节点（gate / 综合 run）全部前置就绪时
//! 由调度器产唤醒事件（[FlowWakeup]），经 advance 返回值带回（引擎侧经 L1
//! 注入通知主 agent 或自动排队综合 run）——**不依赖轮询**：每次终态事件
//! 内部触发 advance，就绪节点随事件立即 spawn 或唤醒。
//!
//! 重启恢复：`flow_*` 键 + session_agents 行（[FlowScheduler::load]）——
//! 节点状态从 session_agents 行重建，预算按「活跃 + 已终态」重算
//! （[ConcurrencyBudget::recompute]，防 double-charge），再按图重新推进。

use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::sync::Arc;

use agent_tools::tools::subagent::{
    check_recursion_guard, RecursionGuardConfig, RecursionGuardRejection, RecursionGuardSnapshot,
    SubagentSpawnRequest, SubagentSpawner, SubagentState, DEFAULT_RECURSION_GUARD,
};
use conex_db::LocalDb;
use conex_types::events::SubagentEndStatus;
use conex_types::SessionAgent;
use serde::{Deserialize, Serialize};

use crate::subagent_events::{
    started_info_from_spawn, SubagentEmitContext, SubagentEndedInfo, SubagentEventEmitter,
};

// ── 依赖图模型（04 C6 §2.1：after / parallel 声明；
//    parallel=false = 同 depends_on 集合同级串行，声明序为串行顺序）───

/// 流程节点 id（主 agent 声明，会话内唯一）
pub type FlowNodeId = String;

/// 前置失败策略（任务卡 I5-M6 三策略；04 文档术语映射见模块头文档）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailStrategy {
    /// 跳过：失败节点对后置的依赖视为满足（后置照常启动），不影响同级，
    /// 不上报（对应 04 `skip`）
    Skip,
    /// 阻塞：失败节点阻塞依赖它的全部节点（含传递阻塞）并上报
    /// （对应 04 `abort`，04 文档默认值）
    Block,
    /// 记录：照常推进但把失败作为记录上报（对应 04 `retry_once` 去重试形态）
    Report,
}

impl FailStrategy {
    /// wire 名（snake_case，session_meta `flow_on_failed` 取值）
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Skip => "skip",
            Self::Block => "block",
            Self::Report => "report",
        }
    }

    /// 从 wire 名解析（未知返回 None）
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "skip" => Some(Self::Skip),
            "block" => Some(Self::Block),
            "report" => Some(Self::Report),
            _ => None,
        }
    }
}

/// 流程节点（主 agent 声明式：after / parallel）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowNode {
    /// 节点 id（会话内唯一，被 after 引用）
    pub id: FlowNodeId,
    /// 任务目标（spawn 子 agent 的 prompt）
    pub task: String,
    /// 前置节点 id 列表（对齐 jcode PlanItem.blocked_by：全部 completed
    /// 才允许启动本节点；空 = 无前置，可首批启动）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub depends_on: Vec<FlowNodeId>,
    /// 是否允许与同级节点并发（false = 与同级串行，声明序为串行顺序）。
    ///
    /// 同级 = depends_on 集合相同的节点（同一波次同时就绪，裁决 D2）：
    /// false 时须等待声明序在前、同 depends_on 集合、且同样 parallel=false
    /// 的节点全部进入终态后才就绪（Failed 按生效策略放宽，与依赖判定
    /// 同口径）；true = 不受约束，显式声明并发。异波次节点互不影响。
    #[serde(default)]
    pub parallel: bool,
    /// 节点级失败策略覆盖（None = 会话级 `flow_on_failed` 默认）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_failed: Option<FailStrategy>,
    /// 综合节点标记（合成唤醒：gate / verify / critique 类，全部前置
    /// 就绪时产唤醒事件；记录 planner_run_id 亲和，jcode NodeMeta.planner）
    #[serde(default)]
    pub is_composite: bool,
}

/// 编排声明（主 agent 一次性声明整图；存 session_meta 单键 JSON，
/// Q3 裁决：任务数 >20 再建独立表）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowDeclaration {
    /// 全部任务节点
    pub tasks: Vec<FlowNode>,
    /// 声明编排的主 run id（综合 run 偏好原 planner 执行，记录位）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planner_run_id: Option<String>,
}

// ── 依赖图结构（staged-clone 环检测）─────────────────────────────

/// 依赖图校验错误（声明被拒且不产生任何 run）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FlowGraphError {
    /// 节点 id 重复
    DuplicateNode { id: FlowNodeId },
    /// 自依赖（禁止：after 不允许包含自身）
    SelfDependency { node_id: FlowNodeId },
    /// 引用了不存在的节点
    UnknownDependency {
        node: FlowNodeId,
        dependency: FlowNodeId,
    },
    /// 依赖环（附环路径，如 ["a","b","c","a"]）
    Cycle { nodes: Vec<FlowNodeId> },
    /// 空声明（至少一个任务）
    EmptyDeclaration,
}

impl fmt::Display for FlowGraphError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DuplicateNode { id } => write!(f, "节点 id 重复：{id}"),
            Self::SelfDependency { node_id } => write!(f, "节点自依赖（禁止）：{node_id}"),
            Self::UnknownDependency { node, dependency } => {
                write!(f, "节点 {node} 引用了不存在的依赖：{dependency}")
            }
            Self::Cycle { nodes } => write!(f, "依赖环：{}", nodes.join(" → ")),
            Self::EmptyDeclaration => write!(f, "编排声明为空"),
        }
    }
}

impl std::error::Error for FlowGraphError {}

/// 依赖图（纯结构：声明校验 / 环检测 / 依赖查询；运行推进在
/// [FlowScheduler]，状态落库在 session_meta `flow_*` 键）
#[derive(Debug, Clone, PartialEq)]
pub struct FlowGraph {
    /// 节点列表（声明序 = 同层串行顺序）
    nodes: Vec<FlowNode>,
}

impl Default for FlowGraph {
    fn default() -> Self {
        Self::new()
    }
}

impl FlowGraph {
    /// 新建空图
    pub fn new() -> Self {
        Self { nodes: Vec::new() }
    }

    /// 节点列表（声明序）
    pub fn nodes(&self) -> &[FlowNode] {
        &self.nodes
    }

    /// 节点数
    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    /// 是否为空图
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    /// 按 id 查节点
    pub fn node(&self, id: &str) -> Option<&FlowNode> {
        self.nodes.iter().find(|n| n.id == id)
    }

    /// 依赖本节点的全部节点（反向边，Block 传播用）
    pub fn dependents(&self, node_id: &str) -> Vec<&FlowNode> {
        self.nodes
            .iter()
            .filter(|n| n.depends_on.iter().any(|d| d == node_id))
            .collect()
    }

    /// 从声明构建图（staged-clone 语义：候选即输入克隆，全量校验通过才
    /// 产出——失败时调用方不写库、不 spawn 任何 run，原子回滚）
    pub fn from_declaration(decl: &FlowDeclaration) -> Result<Self, FlowGraphError> {
        let graph = Self {
            nodes: decl.tasks.clone(),
        };
        graph.validate()?;
        Ok(graph)
    }

    /// 全量结构校验（两阶段：id 全集 → 自依赖 / 未知引用 → 环）。
    ///
    /// after 按 id 引用，**允许前向引用**（依赖声明在后置之后出现——
    /// 对齐 jcode PlanItem.blocked_by 语义，声明序只决定同层串行顺序）。
    pub fn validate(&self) -> Result<(), FlowGraphError> {
        if self.nodes.is_empty() {
            return Err(FlowGraphError::EmptyDeclaration);
        }
        // 第一遍：id 全集 + 重复检测
        let mut seen = HashSet::new();
        for node in &self.nodes {
            if !seen.insert(node.id.clone()) {
                return Err(FlowGraphError::DuplicateNode {
                    id: node.id.clone(),
                });
            }
        }
        // 第二遍：自依赖 + 未知引用（引用目标必须是图内节点）
        for node in &self.nodes {
            for dep in &node.depends_on {
                if dep == &node.id {
                    return Err(FlowGraphError::SelfDependency {
                        node_id: node.id.clone(),
                    });
                }
                if !seen.contains(dep) {
                    return Err(FlowGraphError::UnknownDependency {
                        node: node.id.clone(),
                        dependency: dep.clone(),
                    });
                }
            }
        }
        // 第三遍：环检测
        if let Some(cycle) = self.detect_cycle() {
            return Err(FlowGraphError::Cycle { nodes: cycle });
        }
        Ok(())
    }

    /// 新增依赖边（staged-clone：克隆本图 → 克隆上加边 → 环检测 →
    /// 通过才原子替换；发现环返回错误且**本图不被改写**）
    pub fn add_dependency(
        &mut self,
        node: &FlowNodeId,
        after: &FlowNodeId,
    ) -> Result<(), FlowGraphError> {
        if node == after {
            return Err(FlowGraphError::SelfDependency {
                node_id: node.clone(),
            });
        }
        // staged-clone：先克隆候选再校验，失败回滚（self 不变）
        let mut staged = self.clone();
        let after_exists = staged.nodes.iter().any(|n| &n.id == after);
        if !after_exists {
            return Err(FlowGraphError::UnknownDependency {
                node: node.clone(),
                dependency: after.clone(),
            });
        }
        let target = staged
            .nodes
            .iter_mut()
            .find(|n| &n.id == node)
            .ok_or_else(|| FlowGraphError::UnknownDependency {
                node: node.clone(),
                dependency: after.clone(),
            })?;
        if !target.depends_on.iter().any(|d| d == after) {
            target.depends_on.push(after.clone());
        }
        staged.validate()?;
        *self = staged;
        Ok(())
    }

    /// 环检测（DFS 三色标记），命中返回环路径（`["a","b","c","a"]`，
    /// 每对相邻 id 表示前者 depends_on 后者，闭合回起点）
    pub fn detect_cycle(&self) -> Option<Vec<FlowNodeId>> {
        let mut index: HashMap<&str, usize> = HashMap::new();
        for (i, node) in self.nodes.iter().enumerate() {
            index.insert(node.id.as_str(), i);
        }
        // 三色：0 = 未访问，1 = 当前递归栈中，2 = 完成
        let mut color = vec![0u8; self.nodes.len()];
        let mut stack: Vec<usize> = Vec::new();
        for start in 0..self.nodes.len() {
            if color[start] == 0 {
                if let Some(cycle) =
                    dfs_visit_cycle(start, &self.nodes, &index, &mut color, &mut stack)
                {
                    return Some(cycle);
                }
            }
        }
        None
    }
}

/// DFS 访问（环检测递归体；命中回边时从栈中截取环路径）
fn dfs_visit_cycle(
    i: usize,
    nodes: &[FlowNode],
    index: &HashMap<&str, usize>,
    color: &mut [u8],
    stack: &mut Vec<usize>,
) -> Option<Vec<FlowNodeId>> {
    color[i] = 1;
    stack.push(i);
    for dep in &nodes[i].depends_on {
        let j = match index.get(dep.as_str()) {
            Some(&j) => j,
            // 防御：未知依赖不参与环检测（validate 已拒绝，走不到这里）
            None => continue,
        };
        match color[j] {
            1 => {
                // 回边：栈中 j 到栈顶构成环，闭合回 j
                let start = stack.iter().position(|&k| k == j)?;
                let mut cycle: Vec<FlowNodeId> = stack[start..]
                    .iter()
                    .map(|&k| nodes[k].id.clone())
                    .collect();
                cycle.push(nodes[j].id.clone());
                return Some(cycle);
            }
            0 => {
                if let Some(cycle) = dfs_visit_cycle(j, nodes, index, color, stack) {
                    return Some(cycle);
                }
            }
            _ => {}
        }
    }
    stack.pop();
    color[i] = 2;
    None
}

// ── 节点运行态 ────────────────────────────────────────────────────

/// 流程节点状态（运行期内存态；重启时从 session_agents 行重建，
/// Blocked 为 Block 策略的派生终态——只推进不回溯）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlowNodeState {
    /// 待启动（未 spawn；依赖未满足或等待预算）
    Pending,
    /// 运行中（已 spawn 或已挂接外部 run）
    Running,
    /// 完成（前置 completed 才允许启动后置）
    Completed,
    /// 失败（按生效策略处理：Skip/Block/Report）
    Failed,
    /// 被阻塞（前置 failed 且 Block 策略；终态，永不启动）
    Blocked,
}

impl FlowNodeState {
    /// wire 名
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Blocked => "blocked",
        }
    }

    /// 从子代理状态映射（Blocked 不来自子代理——阻塞节点不会被 spawn）
    pub fn from_subagent(state: SubagentState) -> Self {
        match state {
            SubagentState::Pending => Self::Pending,
            SubagentState::Running => Self::Running,
            SubagentState::Completed => Self::Completed,
            SubagentState::Failed => Self::Failed,
        }
    }

    /// 是否终态（终态节点不重复启动）
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Blocked)
    }
}

/// 流程节点运行时记录（持久化到 `flow_state` 键：run 映射 + 唤醒标记；
/// 状态本身在 session_agents 行，不重复落两份真源）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowNodeRuntime {
    /// 节点 id
    pub node_id: FlowNodeId,
    /// 关联的子代理 run id（None = 未启动；挂接外部 run 也落此映射）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_run_id: Option<String>,
    /// 关联的子代理 id（M14：subagent-ended 发射需要；spawn 成功时记录）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_id: Option<String>,
    /// 子会话 id（D-02 LK-04：spawn 结果信封 session_id，subagent-ended
    /// 发射透传反向导航键）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_session_id: Option<String>,
    /// 合成唤醒已发出（幂等：同节点只唤醒一次，防 gate 死观测）
    #[serde(default)]
    pub wakeup_sent: bool,
}

impl FlowNodeRuntime {
    fn new(node_id: FlowNodeId) -> Self {
        Self {
            node_id,
            subagent_run_id: None,
            subagent_id: None,
            subagent_session_id: None,
            wakeup_sent: false,
        }
    }
}

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
    fn from_guard_rejection(rejection: RecursionGuardRejection) -> Self {
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
            // T-D-01 确认：NestingDenied 等深度类拒绝不会经流程快照产生
            // （流程快照 depth 恒为 1，maxDepth=1 嵌套判定按「新会话深度
            // > 1」命中）——若意外出现按 InvalidState 上报兜底
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
pub trait FlowMetaStore: Send + Sync {
    /// 读键（None = 键不存在）
    fn get_meta(&self, key: &str) -> Result<Option<String>, FlowError>;
    /// 写键（幂等 upsert）
    fn set_meta(&self, key: &str, value: &str) -> Result<(), FlowError>;
}

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
fn read_meta_strategy(meta: &dyn FlowMetaStore) -> Result<FailStrategy, FlowError> {
    match meta.get_meta(FLOW_ON_FAILED_KEY)? {
        Some(raw) => FailStrategy::parse(&raw).ok_or_else(|| FlowError::InvalidState {
            message: format!("flow_on_failed 未知策略：{raw}"),
        }),
        None => Ok(FailStrategy::Block),
    }
}

/// 读取可配预算与综合节点开关（缺失 = DEFAULT_RECURSION_GUARD / true）
fn read_meta_config(meta: &dyn FlowMetaStore) -> Result<(usize, usize, bool), FlowError> {
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
fn read_meta_usize(
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
    session_id: String,
    /// 编排声明（None = 未声明，advance 返回空推进）
    graph: Option<FlowGraph>,
    /// 声明编排的主 run id（综合 run 亲和记录位）
    planner_run_id: Option<String>,
    /// 会话级默认失败策略（节点 on_failed 未声明时生效）
    default_strategy: FailStrategy,
    /// 守卫配置（maxSiblings / maxConcurrent，复用 DEFAULT_RECURSION_GUARD）
    guard: RecursionGuardConfig,
    /// 综合节点自动排队开关（false = 观测态只发唤醒事件）
    auto_spawn_composite: bool,
    /// 节点运行时记录（run 映射 / 唤醒标记；状态在 session_agents 行）
    runtime: HashMap<FlowNodeId, FlowNodeRuntime>,
    /// 节点运行态（内存真源；重启时从 session_agents 行重建）
    states: HashMap<FlowNodeId, FlowNodeState>,
    /// 并发预算（reserved / released 落 `flow_reserved` / `flow_released`）
    budget: ConcurrencyBudget,
    /// spawn 通道（M2 契约：守卫校验 + 落库 + 独立 run 启动在引擎侧）
    spawner: Arc<dyn SubagentSpawner>,
    /// session_meta 读写
    meta: Arc<dyn FlowMetaStore>,
    /// 合成唤醒队列（take_wakeups 消费）
    wakeups: VecDeque<FlowWakeup>,
    /// 重启数据不一致上报（load 积压，首轮 advance 一次性带出）
    restart_reports: Vec<FlowReport>,
    /// 增量就绪集：状态变化波及的节点。advance 每轮只对这些节点做
    /// is_ready；入口可全量灌 Pending，循环内 dirty 空则退出。
    dirty_set: HashSet<FlowNodeId>,
    /// 子代理事件发射器（M14 唯一发射方；None = 纯编排逻辑不发射。
    /// 事件只观测不阻塞编排：发射失败记录日志继续）
    subagent_events: Option<SubagentEventEmitter>,
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
            // T-D-01 确认：max_depth 跟随 DEFAULT_RECURSION_GUARD（=1，仅
            // 主 Agent 可派发）；流程节点全部为主 Agent 直接子节点（新会话
            // 深度恒 1），嵌套拒绝（NestingDenied）按「新会话深度 > 1」判定，
            // 流程快照 depth 恒为 1 不受影响（见 advance 快照注释）
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
    /// 收口发 subagent-ended；不挂载则不发射——编排纯逻辑域保持零事件）
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
    ///
    /// 拒绝语义：校验失败不写任何 `flow_*` 键、不 spawn 任何 run
    /// （04 C6 验收 5：含环声明被拒且零 run）。一轮一编排：已有未终态
    /// 编排时拒绝（主 agent 唯一编排者）。
    pub async fn declare_flow(&mut self, decl: &FlowDeclaration) -> Result<FlowAdvance, FlowError> {
        // 1. staged-clone 校验（候选图全量校验通过才允许落库）
        let graph = FlowGraph::from_declaration(decl)?;
        // 2. 一轮一编排：已有未终态编排 → 拒绝（终态后可替换开新一轮）
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
        // 3. 原子提交：先写声明（锚点）→ 重置状态 / 预算 → 内存替换。
        //    声明写成功即视为提交点；未 spawn 任何 run 前崩溃，重启后
        //    按新声明从零推进（旧编排必已终态才允许替换，无部分运行态）
        self.planner_run_id = decl.planner_run_id.clone();
        self.persist_declaration(&graph)?;
        self.meta.set_meta(FLOW_STATE_KEY, "[]")?;
        self.meta.set_meta(FLOW_RESERVED_KEY, "0")?;
        self.meta.set_meta(FLOW_RELEASED_KEY, "0")?;
        self.graph = Some(graph);
        self.planner_run_id = decl.planner_run_id.clone();
        // 声明时刻刷新可配位（flow_on_failed / 预算 / 自动排队）
        let (max_siblings, max_concurrent, auto_spawn_composite) = read_meta_config(&*self.meta)?;
        // T-D-01 确认：max_depth 跟随 DEFAULT_RECURSION_GUARD（=1）；流程
        // 节点全部为主 Agent 直接子节点，快照 depth 恒为 1 不受影响
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
        // 4. 立即推进首波就绪节点
        self.advance().await
    }

    /// 事件驱动推进（终态事件后 / 声明后 / 重启恢复后调用；内部处理
    /// Block 传播、合成唤醒、预算 reserve + spawn；就绪但预算不足的
    /// 节点保持就绪，等下一终态事件——**不轮询**）。
    ///
    /// 不动点语义：一轮推进产生的失败（spawn 失败）可能改变后置的
    /// 就绪/阻塞判定，故循环到不再产生新状态变化为止（每轮至少
    /// spawn 或阻塞一个节点，迭代次数有界）。
    pub async fn advance(&mut self) -> Result<FlowAdvance, FlowError> {
        let mut out = FlowAdvance::default();
        let Some(graph) = self.graph.clone() else {
            return Ok(out);
        };
        // 重启数据不一致上报（load 积压，首轮推进一次性带出）
        out.reports.append(&mut self.restart_reports);

        // 入口：若 dirty 为空则全量灌 Pending（首轮/恢复/预算重试兜底），否则保持增量集 O(dirty)
        if self.dirty_set.is_empty() {
            self.seed_dirty_pending();
        }

        let mut mutated = false;
        let mut iteration = 0usize;
        // 预计算声明序索引，保证就绪集按声明序确定（与原全量扫描语义一致，O(N)一次）
        let order_index: HashMap<FlowNodeId, usize> = graph
            .nodes()
            .iter()
            .enumerate()
            .map(|(i, n)| (n.id.clone(), i))
            .collect();
        loop {
            iteration += 1;
            // 防御性上界：每轮至少一个节点发生状态迁移，节点数 + 1 轮内收敛
            // +2 而非 +1：第一轮 Block 传播可能产生新阻塞节点，第二轮确认无新状态迁移后收敛；+2 为传播 + 确认两阶段余量。
            if iteration > graph.len() + 2 {
                break;
            }
            if self.dirty_set.is_empty() {
                break;
            }
            // 1. Block 传播（失败 + Block 策略 → 依赖节点阻塞，含传递）
            // T-D-01 确认：Block 按依赖边传播，与「父子链」无关；嵌套禁止
            // （maxDepth=1）后流程节点无后代，传播语义不受影响
            self.propagate_block(&graph, &mut out);
            if self.dirty_set.is_empty() {
                break;
            }
            // 2. 仅遍历 dirty 集 O(dirty)（按声明序排序，与原全量扫描语义一致）
            let mut ready_ids: Vec<FlowNodeId> = self
                .dirty_set
                .iter()
                .filter_map(|id| graph.node(id).map(|n| (n, id.clone())))
                .filter(|(node, _)| self.is_ready(node))
                .map(|(_, id)| id)
                .collect();
            ready_ids.sort_by_key(|id| order_index.get(id).copied().unwrap_or(usize::MAX));
            // 本轮脏集已判定；后续仅由状态迁移 / Block 波及再入集
            self.dirty_set.clear();
            if ready_ids.is_empty() {
                break;
            }
            let mut spawned_any = false;
            let mut budget_blocked: Vec<FlowNodeId> = Vec::new();
            for (idx, node_id) in ready_ids.iter().enumerate() {
                let node_id = node_id.clone();
                let node = graph.node(&node_id).expect("就绪集合来自图节点");
                // 合成唤醒：综合节点就绪即产事件（不轮询；同节点只唤醒一次）
                if node.is_composite {
                    let runtime = self
                        .runtime
                        .entry(node_id.clone())
                        .or_insert_with(|| FlowNodeRuntime::new(node_id.clone()));
                    if !runtime.wakeup_sent {
                        runtime.wakeup_sent = true;
                        let wakeup = FlowWakeup {
                            node_id: node_id.clone(),
                            is_composite: true,
                            planner_run_id: self.planner_run_id.clone(),
                            auto_spawned: false,
                        };
                        out.wakeups.push(wakeup.clone());
                        self.wakeups.push_back(wakeup);
                        mutated = true;
                    }
                    if !self.auto_spawn_composite {
                        // 观测态：只发唤醒事件，不自动排队（引擎侧通知主 agent）
                        continue;
                    }
                }
                // 并发预算 reserve（复用 RecursionGuard：maxSiblings 先命中，
                // maxConcurrent 兜底；快照按流程内当前在途计数）。
                // T-D-01 语义确认：流程节点快照 depth 恒为 1（主 Agent 直接
                // 子节点；子 Agent 无后代，流程节点全部是主 Agent 的直接子
                // 节点），maxDepth=1 下嵌套拒绝（NestingDenied）按「新会话
                // 深度 > 1」判定——流程快照深度 1 恒在界限内，不受嵌套禁止
                // 影响；预算维度（siblings/concurrent）照常作为预算门。
                // 2026-08-11 用户裁决确认：预算默认值跟随 DEFAULT_RECURSION_GUARD
                // （max_concurrent 12→16 自动生效，meta 未配置 flow_max_concurrent
                // 时按 16 预算）；批量派发（spawn_many，无依赖平铺并行）与
                // DAG 调度器并存——流程节点仍逐条经 spawn 启动（预算 reserve
                // 逐节点判定，语义不变），批量原子性由 spawner 层承担，不改变
                // 本模块的预算判定行为。
                let in_flight = self.budget.in_flight() as usize;
                let snapshot = RecursionGuardSnapshot {
                    depth: 1,
                    active_siblings: in_flight,
                    active_concurrent: in_flight,
                };
                if let Err(_rejection) = check_recursion_guard(snapshot, self.guard) {
                    // 预算满：剩余就绪节点保留入 dirty，下次终态释放后重试（O(dirty)保留，不全量重扫）
                    budget_blocked.extend(ready_ids[idx..].iter().cloned());
                    break;
                }
                self.budget.reserve();
                let request = SubagentSpawnRequest {
                    agent_id: None,
                    prompt: node.task.clone(),
                    role: None,
                    capability_mode: None,
                    allowed_tools: None,
                    description: None,
                    mode: None,
                    parent_session_id: self.session_id.clone(),
                    parent_run_id: self.planner_run_id.clone(),
                    // LK-02 定案：flow 路径链路键 = flow_node_id（下字段已填
                    // 并落库 session_agents.description 载体）；parent_tool_call_id
                    // 恒 None——调度驱动无父工具调用，语义正确非欠接线，
                    // 禁止虚构 id 填充
                    parent_tool_call_id: None,
                    flow_node_id: Some(node_id.clone()),
                    is_composite: node.is_composite,
                    // T-D-07 定义扩展：调度器路径不携带任务类型/写路径/标签
                    // （None = 引擎按缺省 analysis + 默认集装配）
                    task_type: None,
                    allowed_write_paths: None,
                    display_label: None,
                    // 扩展点预留：全构造点显式 None（编译器强制）
                    model_override: None,
                };
                match self.spawner.spawn(&request).await {
                    Ok(result) => {
                        self.states.insert(node_id.clone(), FlowNodeState::Running);
                        self.mark_successors_dirty(&node_id);
                        // 先写内存 runtime 映射（作用域内完成，随后立即持久化，
                        // 避免借用冲突：persist 需要 &self 的不可变借用）
                        {
                            let runtime = self
                                .runtime
                                .entry(node_id.clone())
                                .or_insert_with(|| FlowNodeRuntime::new(node_id.clone()));
                            runtime.subagent_run_id = Some(result.subagent_run_id.clone());
                            // D-02 LK-04：子会话 id 落 runtime（ended 发射
                            // 透传反向导航键；与 spawner 行级同源）
                            runtime.subagent_session_id = Some(result.session_id.clone());
                        }
                        // D4 双防线①（T3.4）：spawn 状态持久化前置——run 已由
                        // spawner 落库 session_agents，这里在**任何 await 之前**
                        // （emit_started 挂起点不再放大窗口）立即持久化节点
                        // runtime + 预算。崩溃窗口归零：spawn 后任意时刻崩溃，
                        // flow_state 均已含本节点映射，重启 load 重建为 Running
                        // 而非 Pending，杜绝重复 spawn（孤儿双跑）。
                        // 失败按 Err 传播（spawn 已成功则 run 已落库、runtime
                        // 不落库 = 崩溃窗口形态，重开由双防线②反向校验兜底）
                        self.persist_runtime()?;
                        self.persist_budget()?;
                        // M14：spawn 成功发射 subagent-started（唯一发射方；
                        // 事件只观测不阻塞编排——失败记录日志继续）
                        if let Some(emitter) = &self.subagent_events {
                            let ctx = SubagentEmitContext {
                                session_id: self.session_id.clone(),
                                parent_run_id: self.planner_run_id.clone().unwrap_or_default(),
                            };
                            match emitter
                                .emit_started(&ctx, &started_info_from_spawn(&request, &result))
                                .await
                            {
                                Ok(_) => {}
                                Err(error) => {
                                    tracing::warn!(
                                        target: "subagent_events",
                                        event = "emit_started_failed",
                                        subagent_run_id = %result.subagent_run_id,
                                        error = %error,
                                        "subagent-started 发射失败（不阻塞编排）"
                                    );
                                }
                            }
                            if let Some(runtime) = self.runtime.get_mut(&node_id) {
                                runtime.subagent_id = Some(result.subagent_id.clone());
                            }
                        }
                        out.started.push(FlowStarted {
                            node_id: node_id.clone(),
                            subagent_run_id: result.subagent_run_id,
                            is_composite: node.is_composite,
                        });
                        // 自动排队成功：补记本轮唤醒事件的 auto_spawned 标记
                        if node.is_composite {
                            if let Some(w) =
                                out.wakeups.iter_mut().rev().find(|w| w.node_id == node_id)
                            {
                                w.auto_spawned = true;
                            }
                            if let Some(w) =
                                self.wakeups.iter_mut().rev().find(|w| w.node_id == node_id)
                            {
                                w.auto_spawned = true;
                            }
                        }
                    }
                    Err(err) => {
                        // spawn 失败：释放预留，节点按失败处理（策略在
                        // Block 传播 / 上报中生效，下一轮不动点收敛）
                        self.budget.release();
                        self.states.insert(node_id.clone(), FlowNodeState::Failed);
                        self.mark_successors_dirty(&node_id);
                        out.reports.push(FlowReport {
                            node_id: node_id.clone(),
                            run_id: None,
                            strategy: None,
                            kind: FlowReportKind::SpawnFailed,
                            message: format!("节点 {node_id} spawn 失败：{}", err.message()),
                        });
                    }
                }
                spawned_any = true;
                mutated = true;
            }
            if !budget_blocked.is_empty() {
                self.dirty_set.extend(budget_blocked);
            }
            if !spawned_any {
                break;
            }
        }
        if mutated {
            self.persist_runtime()?;
            self.persist_budget()?;
        }
        out.flow_terminal = self.all_terminal();
        Ok(out)
    }

    /// 子代理终态事件（引擎侧 subagent-ended 回传）：release 预算 →
    /// 应用失败策略（Skip / Block / Report）→ 事件驱动推进。
    ///
    /// 幂等：同 run 重复终态通知忽略（不重复 release / 不上报）。
    pub async fn on_subagent_terminal(
        &mut self,
        subagent_run_id: &str,
        state: SubagentState,
    ) -> Result<FlowAdvance, FlowError> {
        if state != SubagentState::Completed && state != SubagentState::Failed {
            return Err(FlowError::InvalidState {
                message: format!("非终态通知：{:?}", state),
            });
        }
        if self.graph.is_none() {
            return Err(FlowError::NotFound {
                message: "会话无编排声明".to_string(),
            });
        }
        let node_id = self
            .run_node(subagent_run_id)
            .ok_or_else(|| FlowError::UnknownRun {
                run_id: subagent_run_id.to_string(),
            })?
            .to_string();
        let current = self
            .states
            .get(&node_id)
            .copied()
            .unwrap_or(FlowNodeState::Pending);
        if current.is_terminal() {
            return Ok(FlowAdvance {
                flow_terminal: self.all_terminal(),
                ..FlowAdvance::default()
            });
        }
        // 终态：释放该 run 的预留（记账「已分配」而非「已消耗」）
        self.budget.release();
        let next = FlowNodeState::from_subagent(state);
        self.states.insert(node_id.clone(), next);
        // 终态后后继入脏集；advance 入口仍会全量灌 Pending（含预算等待节点）
        self.mark_successors_dirty(&node_id);
        // M14：收口发射 subagent-ended（唯一发射方；事件只观测不阻塞编排——
        // 失败记录日志继续；subagent_id 缺省回退 run id，保证信封完整性）
        if let Some(emitter) = &self.subagent_events {
            let ctx = SubagentEmitContext {
                session_id: self.session_id.clone(),
                parent_run_id: self.planner_run_id.clone().unwrap_or_default(),
            };
            let subagent_id = self
                .runtime
                .get(&node_id)
                .and_then(|r| r.subagent_id.clone())
                .unwrap_or_else(|| subagent_run_id.to_string());
            // D-02 LK-04：子会话 id 透传（spawn 成功时落 runtime；None =
            // 运行时映射缺失，前端回退行级反查）
            let subagent_session_id = self
                .runtime
                .get(&node_id)
                .and_then(|r| r.subagent_session_id.clone());
            let status = match next {
                FlowNodeState::Completed => SubagentEndStatus::Completed,
                _ => SubagentEndStatus::Failed,
            };
            match emitter
                .emit_ended(
                    &ctx,
                    &SubagentEndedInfo {
                        subagent_id,
                        subagent_run_id: subagent_run_id.to_string(),
                        status,
                        summary: None,
                        subagent_session_id,
                    },
                )
                .await
            {
                Ok(_) => {}
                Err(error) => {
                    tracing::warn!(
                        target: "subagent_events",
                        event = "emit_ended_failed",
                        subagent_run_id = %subagent_run_id,
                        error = %error,
                        "subagent-ended 发射失败（不阻塞编排）"
                    );
                }
            }
        }
        // 失败策略（04 C6 行为 5：abort=Block / skip=Skip / retry_once=Report）
        let mut fail_reports = Vec::new();
        if next == FlowNodeState::Failed {
            let strategy = self.effective_strategy(&node_id);
            match strategy {
                FailStrategy::Skip => {
                    // 跳过：失败节点对后置的依赖视为满足，不上报
                }
                FailStrategy::Report => {
                    fail_reports.push(FlowReport {
                        node_id: node_id.clone(),
                        run_id: Some(subagent_run_id.to_string()),
                        strategy: Some(strategy),
                        kind: FlowReportKind::NodeFailed,
                        message: format!("节点 {node_id} 失败（Report 策略：照常推进但记录）"),
                    });
                }
                FailStrategy::Block => {
                    fail_reports.push(FlowReport {
                        node_id: node_id.clone(),
                        run_id: Some(subagent_run_id.to_string()),
                        strategy: Some(strategy),
                        kind: FlowReportKind::NodeFailed,
                        message: format!("节点 {node_id} 失败（Block 策略：阻塞依赖节点并上报）"),
                    });
                }
            }
        }
        self.persist_runtime()?;
        self.persist_budget()?;
        let mut advance = self.advance().await?;
        // 失败上报置前（推进可能追加 Block 传播上报）
        advance.reports.splice(0..0, fail_reports);
        Ok(advance)
    }

    /// 挂接外部 run 到综合节点（合成唤醒观测态：主 agent 收到唤醒事件后
    /// 自行 spawn 综合 run，引擎侧把 run id 挂回节点）。
    ///
    /// gate 强制对挂接同样生效：仅当全部前置 completed（running 不算）、
    /// 节点未启动、且无未终态的串行同级（[Self::is_ready] 统一判定，
    /// 含裁决 D2 同级串行约束）时才允许挂接。
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
        // 预算校验（复用 RecursionGuard：挂接的外部 run 同样占用并发预算，
        // 预算满时拒绝挂接——等后续终态事件释放槽位再重试）。
        // T-D-01 确认：快照 depth 恒为 1（主 Agent 直接子节点），maxDepth=1
        // 嵌套禁止按「新会话深度 > 1」判定，此处不受影响；预算维度照常
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
        // 挂接的外部 run 同样计入流程内预算（终态时随 release 释放）
        self.budget.reserve();
        self.persist_runtime()?;
        self.persist_budget()?;
        Ok(())
    }

    /// 重启恢复：从 `flow_*` 键 + session_agents 行重建调度器。
    ///
    /// - 编排声明缺失 / 解析失败 → [FlowError::NotFound]；
    /// - 节点状态从 session_agents 行重建（每任务状态在 session_agents 行）；
    /// - run 映射缺失的节点按失败处理并积压数据不一致上报；
    /// - 预算跨重启重算（[ConcurrencyBudget::recompute]，防 double-charge）。
    ///
    /// 恢复后由调用方执行 [Self::advance] 按图重新推进（未完成后置启动、
    /// 已完成不重复启动——状态已重建为终态）。
    pub fn load(
        session_id: impl Into<String>,
        spawner: Arc<dyn SubagentSpawner>,
        meta: Arc<dyn FlowMetaStore>,
        agent_rows: &[SessionAgent],
    ) -> Result<Self, FlowError> {
        let session_id = session_id.into();
        // 1. 编排声明（缺 / 解析失败 → NotFound：没有编排就没有可恢复的流程）
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
        // 2. 运行时状态（run 映射 / 唤醒标记）
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
        // 3. 可配位与默认策略
        let (max_siblings, max_concurrent, auto_spawn_composite) = read_meta_config(&*meta)?;
        let default_strategy = read_meta_strategy(&*meta)?;
        // 4. 从 session_agents 行重建节点状态
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
                    // 数据不一致：run 记录缺失 → 按失败处理并记录（fail-open）
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
        // D4 双防线②（T3.4）：反向校验——session_agents 行带 flow_node_id
        // （测试域 spawner 约定：description 字段承载，DbSpawner /
        // RecordingSpawner 均 `description: req.flow_node_id`）且指向图中
        // 某节点、但 flow_state 无该节点 runtime 映射 → 崩溃窗口兜底
        // （spawn 已落库、runtime 未持久化）：节点按 Failed 处理 +
        // DataInconsistent 上报，杜绝重启后按 Pending 重复 spawn（孤儿双跑）。
        // 正向路径已恢复的节点（flow_state 有映射）不受影响；预算重算
        // （步骤 5）随之把 Failed 计入终态 → released 抵消，防 double-charge。
        for row in agent_rows {
            let node_id = &row.description;
            if node_id.is_empty() {
                continue;
            }
            let Some(node) = graph.node(node_id) else {
                continue;
            };
            if runtime.contains_key(&node.id) {
                continue; // 正向路径已有映射（flow_state 有 runtime）
            }
            if states.get(&node.id).copied() != Some(FlowNodeState::Pending) {
                continue; // 已被正向/其它逻辑改写（终态等），不覆盖
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
        // 5. 预算跨重启重算（防 double-charge）
        let active = states
            .values()
            .filter(|s| **s == FlowNodeState::Running)
            .count() as u64;
        let terminal = states.values().filter(|s| s.is_terminal()).count() as u64;
        let budget = ConcurrencyBudget::recompute(active, terminal);
        // 6. 构造并落盘重算后的预算（库与内存一致）
        let scheduler = Self {
            session_id,
            graph: Some(graph),
            planner_run_id: declaration.planner_run_id.clone(),
            default_strategy,
            // T-D-01 确认：max_depth 跟随 DEFAULT_RECURSION_GUARD（=1）；
            // 流程节点快照 depth 恒为 1，恢复语义不受嵌套禁止影响
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
    ///
    /// 清空动作会抹掉 `flow_declaration` 键（load 将报告无编排）。
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

    // ── 内部 ──────────────────────────────────────────────────────

    /// 全部节点是否终态（未声明 = false）
    fn all_terminal(&self) -> bool {
        self.graph
            .as_ref()
            .map(|g| {
                g.nodes().iter().all(|n| {
                    self.states
                        .get(&n.id)
                        .map(|s| s.is_terminal())
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false)
    }

    /// 节点生效失败策略（节点级覆盖 ?? 会话级默认）
    fn effective_strategy(&self, node_id: &str) -> FailStrategy {
        self.graph
            .as_ref()
            .and_then(|g| g.node(node_id))
            .and_then(|n| n.on_failed)
            .unwrap_or(self.default_strategy)
    }

    /// gate 强制：就绪 = 待启动且全部前置 completed（running 不算；
    /// 前置 failed 时按失败节点的生效策略放宽——Skip / Report 视为
    /// 满足，Block 视为阻塞）+ 同级串行约束（裁决 D2：parallel=false
    /// 节点须等声明序在前、同 depends_on 集合的串行同级全部终态，
    /// 见 [Self::serial_predecessor_pending]）
    fn is_ready(&self, node: &FlowNode) -> bool {
        if self.states.get(&node.id).copied() != Some(FlowNodeState::Pending) {
            return false;
        }
        if !node
            .depends_on
            .iter()
            .all(|dep| match self.states.get(dep) {
                Some(FlowNodeState::Completed) => true,
                Some(FlowNodeState::Failed) => matches!(
                    self.effective_strategy(dep),
                    FailStrategy::Skip | FailStrategy::Report
                ),
                _ => false,
            })
        {
            return false;
        }
        !self.serial_predecessor_pending(node)
    }

    /// 同波次串行前置检查（裁决 D2 冻结：同级 = 同 depends_on 集合）：
    /// 声明序在前（graph.nodes() 即声明序）、同 depends_on 集合、
    /// parallel=false、且状态未达「满足」判定（[Self::serial_predecessor_satisfied]）
    /// 的同级节点存在 → 尚未就绪。parallel=true 节点不受本约束。
    fn serial_predecessor_pending(&self, node: &FlowNode) -> bool {
        if node.parallel {
            return false;
        }
        let Some(graph) = self.graph.as_ref() else {
            return false;
        };
        graph
            .nodes()
            .iter()
            .take_while(|n| n.id != node.id)
            .any(|n| {
                n.depends_on == node.depends_on
                    && !n.parallel
                    && !self.serial_predecessor_satisfied(n)
            })
    }

    /// 串行前置「满足」判定（与 is_ready 依赖判定同口径，
    /// flow_graph.rs:1463-1470）：Completed / Blocked → 满足；Failed →
    /// 生效策略 Skip / Report 满足、Block 不满足——Blocked 传播由
    /// [Self::propagate_block] 先行处理（本节点被置 Blocked 终态后
    /// is_ready 不再命中），此处不重复拦截；其余非终态 → 不满足。
    fn serial_predecessor_satisfied(&self, node: &FlowNode) -> bool {
        match self.states.get(&node.id).copied() {
            Some(FlowNodeState::Completed | FlowNodeState::Blocked) => true,
            Some(FlowNodeState::Failed) => matches!(
                self.effective_strategy(&node.id),
                FailStrategy::Skip | FailStrategy::Report
            ),
            _ => false,
        }
    }

    /// Block 传播：dirty 中的待启动节点任一前置为 Blocked，或前置 Failed 且其
    /// 生效策略为 Block → 本节点置 Blocked（终态）并上报；后继入 dirty，
    /// 迭代到不动点（传递阻塞）。依赖环已在声明校验拒绝，无需防循环。
    fn propagate_block(&mut self, graph: &FlowGraph, out: &mut FlowAdvance) {
        loop {
            let candidates: Vec<FlowNodeId> = self
                .dirty_set
                .iter()
                .filter(|id| self.states.get(*id).copied() == Some(FlowNodeState::Pending))
                .cloned()
                .collect();
            let mut changed = false;
            for node_id in candidates {
                let Some(node) = graph.node(&node_id) else {
                    continue;
                };
                let blocker = node
                    .depends_on
                    .iter()
                    .find(|dep| match self.states.get(*dep) {
                        Some(FlowNodeState::Blocked) => true,
                        Some(FlowNodeState::Failed) => {
                            self.effective_strategy(dep) == FailStrategy::Block
                        }
                        _ => false,
                    })
                    .cloned();
                if let Some(blocker) = blocker {
                    self.states.insert(node_id.clone(), FlowNodeState::Blocked);
                    out.blocked.push(node_id.clone());
                    out.reports.push(FlowReport {
                        node_id: node_id.clone(),
                        run_id: None,
                        strategy: Some(FailStrategy::Block),
                        kind: FlowReportKind::Blocked,
                        message: format!(
                            "前置 {blocker} 失败（Block 策略），节点 {node_id} 被阻塞"
                        ),
                    });
                    // 波及后继进 dirty，供本函数内下一轮传递阻塞
                    self.mark_successors_dirty(&node_id);
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
    }

    /// 把全部 Pending 灌入 dirty（advance 入口初始化；之后只扫脏集）
    fn seed_dirty_pending(&mut self) {
        let pending: Vec<FlowNodeId> = self
            .graph
            .as_ref()
            .map(|g| {
                g.nodes()
                    .iter()
                    .filter(|n| self.states.get(&n.id).copied() == Some(FlowNodeState::Pending))
                    .map(|n| n.id.clone())
                    .collect()
            })
            .unwrap_or_default();
        self.dirty_set.clear();
        self.dirty_set.extend(pending);
    }

    /// 状态变化后把后继标脏：DAG 反向边（depends_on 后继）+ 同波次串行后继。
    /// 同波次串行后继不在 depends_on 上，但 is_ready 受 serial_predecessor
    /// 约束，必须一并标脏才能与全量重算语义一致。
    fn mark_successors_dirty(&mut self, node_id: &str) {
        let Some(graph) = self.graph.as_ref() else {
            return;
        };
        let mut ids: Vec<FlowNodeId> = graph
            .dependents(node_id)
            .into_iter()
            .map(|n| n.id.clone())
            .collect();
        if let Some(changed) = graph.node(node_id) {
            if !changed.parallel {
                let mut past = false;
                for n in graph.nodes() {
                    if n.id == node_id {
                        past = true;
                        continue;
                    }
                    if past && !n.parallel && n.depends_on == changed.depends_on {
                        ids.push(n.id.clone());
                    }
                }
            }
        }
        self.dirty_set.extend(ids);
    }

    /// 持久化编排声明（含 planner_run_id；入参图 = 待提交的候选图，
    /// 在内存替换前落库——先写库后换内存的原子提交顺序）
    fn persist_declaration(&self, graph: &FlowGraph) -> Result<(), FlowError> {
        let declaration = FlowDeclaration {
            tasks: graph.nodes().to_vec(),
            planner_run_id: self.planner_run_id.clone(),
        };
        let json = serde_json::to_string(&declaration).map_err(|e| FlowError::InvalidState {
            message: format!("编排声明序列化失败：{e}"),
        })?;
        self.meta.set_meta(FLOW_DECLARATION_KEY, &json)
    }

    /// 持久化节点运行时状态（按节点 id 排序，写入确定性）
    fn persist_runtime(&self) -> Result<(), FlowError> {
        let mut runtimes: Vec<FlowNodeRuntime> = self.runtime.values().cloned().collect();
        runtimes.sort_by(|a, b| a.node_id.cmp(&b.node_id));
        let json = serde_json::to_string(&runtimes).map_err(|e| FlowError::InvalidState {
            message: format!("flow_state 序列化失败：{e}"),
        })?;
        self.meta.set_meta(FLOW_STATE_KEY, &json)
    }

    /// 持久化预算计数（reserved / released 两键）
    fn persist_budget(&self) -> Result<(), FlowError> {
        self.meta
            .set_meta(FLOW_RESERVED_KEY, &self.budget.reserved().to_string())?;
        self.meta
            .set_meta(FLOW_RELEASED_KEY, &self.budget.released().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use agent_tools::tools::subagent::{
        check_recursion_guard, RecursionGuardSnapshot, SubagentSpawnError, SubagentSpawnResult,
    };

    fn node(id: &str, depends_on: &[&str]) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            task: format!("任务 {id}"),
            depends_on: depends_on.iter().map(|s| s.to_string()).collect(),
            parallel: true,
            on_failed: None,
            is_composite: false,
        }
    }

    fn declaration(tasks: Vec<FlowNode>) -> FlowDeclaration {
        FlowDeclaration {
            tasks,
            planner_run_id: Some("planner-1".to_string()),
        }
    }

    // ── 声明校验 / 环检测 ─────────────────────────────────────────

    #[test]
    fn from_declaration_accepts_normal_dag() {
        // a → b → c（链）+ d 并行
        let decl = declaration(vec![
            node("a", &[]),
            node("b", &["a"]),
            node("c", &["b"]),
            node("d", &[]),
        ]);
        let graph = FlowGraph::from_declaration(&decl).expect("正常 DAG 应接受");
        assert_eq!(graph.len(), 4);
        assert_eq!(graph.node("b").unwrap().depends_on, vec!["a".to_string()]);
        assert!(graph.detect_cycle().is_none());
        let dependents: Vec<&str> = graph
            .dependents("a")
            .iter()
            .map(|n| n.id.as_str())
            .collect();
        assert_eq!(dependents, vec!["b"], "a 的后置 = b");
    }

    #[test]
    fn from_declaration_rejects_cycle_with_path() {
        // a → c → b → a（前向引用 + 成环）：拒绝且携带环路径
        let decl = declaration(vec![
            node("a", &["c"]),
            node("b", &["a"]),
            node("c", &["b"]),
        ]);
        let err = FlowGraph::from_declaration(&decl).unwrap_err();
        match err {
            FlowGraphError::Cycle { nodes } => {
                assert_eq!(nodes.len(), 4, "环路径闭合回起点");
                assert_eq!(nodes.first(), nodes.last(), "环路径首尾闭合");
                let mut sorted: Vec<&str> = nodes[..nodes.len() - 1]
                    .iter()
                    .map(|s| s.as_str())
                    .collect();
                sorted.sort_unstable();
                assert_eq!(sorted, vec!["a", "b", "c"], "环路径覆盖 a/b/c 三节点");
            }
            other => panic!("期望 Cycle：{other:?}"),
        }
    }

    #[test]
    fn from_declaration_rejects_self_dependency() {
        let decl = declaration(vec![node("a", &["a"])]);
        let err = FlowGraph::from_declaration(&decl).unwrap_err();
        assert!(
            matches!(err, FlowGraphError::SelfDependency { .. }),
            "自依赖必须单独拒绝：{err:?}"
        );
    }

    #[test]
    fn from_declaration_rejects_duplicate_ids() {
        let decl = declaration(vec![node("a", &[]), node("a", &[])]);
        let err = FlowGraph::from_declaration(&decl).unwrap_err();
        assert!(matches!(err, FlowGraphError::DuplicateNode { id } if id == "a"));
    }

    #[test]
    fn from_declaration_rejects_unknown_dependency() {
        let decl = declaration(vec![node("a", &["ghost"])]);
        let err = FlowGraph::from_declaration(&decl).unwrap_err();
        assert!(
            matches!(err, FlowGraphError::UnknownDependency { node, dependency } if node == "a" && dependency == "ghost")
        );
    }

    #[test]
    fn from_declaration_rejects_empty() {
        let err = FlowGraph::from_declaration(&declaration(vec![])).unwrap_err();
        assert!(matches!(err, FlowGraphError::EmptyDeclaration));
    }

    // ── staged-clone 增量加边（发现环原子回滚不写入）───────────────

    #[test]
    fn add_dependency_staged_clone_rolls_back_on_cycle() {
        // 先建 a → b、c → a（无环），再尝试 b → c 构成 a→b→c→a
        let mut graph = FlowGraph::from_declaration(&declaration(vec![
            node("a", &[]),
            node("b", &["a"]),
            node("c", &["a"]),
        ]))
        .unwrap();
        graph
            .add_dependency(&"b".to_string(), &"c".to_string())
            .expect("b → c 无环应接受");
        // 此刻 b 依赖 c、c 依赖 a、b 依赖 a → a→c? 重新设计：b→c 后 c 已有 a 依赖，
        // 再加 c → b 形成 c→b→c 环
        let err = graph
            .add_dependency(&"c".to_string(), &"b".to_string())
            .unwrap_err();
        assert!(matches!(err, FlowGraphError::Cycle { .. }), "{err:?}");
        // 原子回滚：失败的边不写入，图保持 b → c 之前…（见下）
        assert_eq!(
            graph.node("b").unwrap().depends_on,
            vec!["a".to_string(), "c".to_string()],
            "b → c 已写入"
        );
        assert_eq!(
            graph.node("c").unwrap().depends_on,
            vec!["a".to_string()],
            "c → b 被拒绝且未写入（原子回滚）"
        );
    }

    #[test]
    fn add_dependency_rejects_self_edge_without_mutation() {
        let mut graph = FlowGraph::from_declaration(&declaration(vec![node("a", &[])])).unwrap();
        let err = graph
            .add_dependency(&"a".to_string(), &"a".to_string())
            .unwrap_err();
        assert!(matches!(err, FlowGraphError::SelfDependency { .. }));
        assert!(graph.node("a").unwrap().depends_on.is_empty(), "图不变");
    }

    #[test]
    fn add_dependency_rejects_unknown_nodes() {
        let mut graph = FlowGraph::from_declaration(&declaration(vec![node("a", &[])])).unwrap();
        assert!(graph
            .add_dependency(&"ghost".to_string(), &"a".to_string())
            .is_err());
        assert!(graph
            .add_dependency(&"a".to_string(), &"ghost".to_string())
            .is_err());
        assert_eq!(graph.len(), 1, "图不变");
    }

    // ── wire 序列化 ────────────────────────────────────────────────

    #[test]
    fn declaration_wire_format_roundtrip() {
        let mut task = node("gate", &["research"]);
        task.parallel = false;
        task.on_failed = Some(FailStrategy::Skip);
        task.is_composite = true;
        let decl = declaration(vec![node("research", &[]), task]);
        let json = serde_json::to_value(&decl).unwrap();
        // camelCase 键 + snake_case 策略
        assert_eq!(json["tasks"][0]["id"], "research");
        assert_eq!(json["tasks"][0]["parallel"], true);
        assert_eq!(json["tasks"][1]["dependsOn"][0], "research");
        assert_eq!(json["tasks"][1]["onFailed"], "skip");
        assert_eq!(json["tasks"][1]["isComposite"], true);
        assert_eq!(json["plannerRunId"], "planner-1");
        let back: FlowDeclaration = serde_json::from_value(json).unwrap();
        assert_eq!(back, decl, "序列化往返一致");
    }

    #[test]
    fn fail_strategy_wire_parse() {
        for (wire, strategy) in [
            ("skip", FailStrategy::Skip),
            ("block", FailStrategy::Block),
            ("report", FailStrategy::Report),
        ] {
            assert_eq!(FailStrategy::parse(wire), Some(strategy));
            assert_eq!(strategy.as_str(), wire);
        }
        assert_eq!(
            FailStrategy::parse("abort"),
            None,
            "04 术语已映射，未知拒绝"
        );
        assert_eq!(FailStrategy::parse(""), None);
    }

    // ── 并发预算 ──────────────────────────────────────────────────

    #[test]
    fn budget_reserve_release_tracks_in_flight() {
        let mut budget = ConcurrencyBudget::new();
        assert_eq!(budget.in_flight(), 0);
        budget.reserve();
        budget.reserve();
        assert_eq!(budget.in_flight(), 2);
        assert_eq!(budget.reserved(), 2);
        budget.release();
        assert_eq!(budget.in_flight(), 1);
        assert_eq!(budget.released(), 1);
    }

    #[test]
    fn budget_recompute_across_restart_prevents_double_charge() {
        // 崩溃时刻：2 活跃 + 3 已终态 → 重算后 in_flight = 2
        let budget = ConcurrencyBudget::recompute(2, 3);
        assert_eq!(budget.reserved(), 5);
        assert_eq!(budget.released(), 3);
        assert_eq!(budget.in_flight(), 2, "已完成任务预留被 released 抵消");
    }

    // ── is_ready 同级串行约束（裁决 D2：同级 = 同 depends_on 集合）──

    /// is_ready 单测用最小 spawner（仅满足构造签名，不真正 spawn）
    #[derive(Debug)]
    struct NoopSpawner;

    #[async_trait::async_trait]
    impl SubagentSpawner for NoopSpawner {
        async fn spawn(
            &self,
            _req: &SubagentSpawnRequest,
        ) -> Result<SubagentSpawnResult, SubagentSpawnError> {
            unreachable!("is_ready 单测不发起 spawn")
        }
    }

    /// is_ready 单测用空 meta（全部键缺省 → 默认策略 Block / 默认预算）
    struct EmptyMeta;

    impl FlowMetaStore for EmptyMeta {
        fn get_meta(&self, _key: &str) -> Result<Option<String>, FlowError> {
            Ok(None)
        }

        fn set_meta(&self, _key: &str, _value: &str) -> Result<(), FlowError> {
            Ok(())
        }
    }

    /// is_ready 单测构造：调度器 + 指定图（全部节点 Pending 初始态）
    fn sched_with_graph(tasks: Vec<FlowNode>) -> FlowScheduler {
        let spawner = Arc::new(NoopSpawner);
        let meta = Arc::new(EmptyMeta);
        let mut sched = FlowScheduler::new("sess-u", spawner, meta).expect("调度器创建失败");
        let graph = FlowGraph::from_declaration(&declaration(tasks)).expect("声明应接受");
        for node in graph.nodes() {
            sched.states.insert(node.id.clone(), FlowNodeState::Pending);
        }
        sched.graph = Some(graph);
        sched
    }

    #[test]
    fn is_ready_same_wave_serial_blocks_until_predecessor_terminal() {
        // 同波次（depends_on=[]）两 parallel=false 节点：声明序在前的
        // 未终态时后置不就绪；终态后就绪；Failed + Block 策略不满足
        let mut n1 = node("n1", &[]);
        n1.parallel = false;
        let mut n2 = node("n2", &[]);
        n2.parallel = false;
        let mut sched = sched_with_graph(vec![n1, n2]);
        let n2_node = sched.graph.as_ref().unwrap().node("n2").unwrap().clone();
        sched
            .states
            .insert("n1".to_string(), FlowNodeState::Running);
        assert!(
            !sched.is_ready(&n2_node),
            "前驱同级 Running 时不得就绪（同波次串行）"
        );
        sched
            .states
            .insert("n1".to_string(), FlowNodeState::Completed);
        assert!(sched.is_ready(&n2_node), "前驱同级终态后就绪");
        sched.states.insert("n1".to_string(), FlowNodeState::Failed);
        assert!(
            !sched.is_ready(&n2_node),
            "前驱 Failed + 默认 Block 策略不满足（由 propagate_block 置 Blocked）"
        );
    }

    #[test]
    fn is_ready_same_wave_serial_but_different_waves_free() {
        // 波 1（depends_on=[]）：a → y 串行；波 2（depends_on=[a]）：x 独立
        // ——异波次互不约束，即使同为 parallel=false
        let mut a = node("a", &[]);
        a.parallel = false;
        let mut x = node("x", &["a"]);
        x.parallel = false;
        let mut y = node("y", &[]);
        y.parallel = false;
        let mut sched = sched_with_graph(vec![a, x, y]);
        let graph = sched.graph.as_ref().unwrap();
        let x_node = graph.node("x").unwrap().clone();
        let y_node = graph.node("y").unwrap().clone();
        sched.states.insert("a".to_string(), FlowNodeState::Running);
        assert!(!sched.is_ready(&y_node), "同波次前驱 Running → y 不就绪");
        assert!(!sched.is_ready(&x_node), "x 依赖（a）未完成 → 不就绪");
        // a 终态：同波次 y 就绪；异波次 x 也同时就绪（两波次并行推进）
        sched
            .states
            .insert("a".to_string(), FlowNodeState::Completed);
        assert!(sched.is_ready(&y_node));
        assert!(sched.is_ready(&x_node), "异波次不受 parallel 串行约束");
    }

    #[test]
    fn is_ready_parallel_flag_waives_serial_constraint() {
        // parallel=true 节点不受同级串行约束（前驱同级运行中也就绪）
        let mut n1 = node("n1", &[]);
        n1.parallel = false;
        let n2 = node("n2", &[]); // helper 默认 parallel=true
        let mut sched = sched_with_graph(vec![n1, n2]);
        let n2_node = sched.graph.as_ref().unwrap().node("n2").unwrap().clone();
        sched
            .states
            .insert("n1".to_string(), FlowNodeState::Running);
        assert!(
            sched.is_ready(&n2_node),
            "parallel=true 显式并发，不受串行约束"
        );
    }

    #[test]
    fn is_ready_serial_predecessor_failed_with_skip_strategy_satisfied() {
        // 前驱同级 Failed + Skip 策略 → 视为满足（与 is_ready 依赖判定同口径）
        let mut n1 = node("n1", &[]);
        n1.parallel = false;
        n1.on_failed = Some(FailStrategy::Skip);
        let mut n2 = node("n2", &[]);
        n2.parallel = false;
        let mut sched = sched_with_graph(vec![n1, n2]);
        let n2_node = sched.graph.as_ref().unwrap().node("n2").unwrap().clone();
        sched.states.insert("n1".to_string(), FlowNodeState::Failed);
        assert!(sched.is_ready(&n2_node), "Failed + Skip 生效策略视为满足");
        // 对照：Report 同样视为满足
        let mut n1 = node("n1", &[]);
        n1.parallel = false;
        n1.on_failed = Some(FailStrategy::Report);
        let mut n2 = node("n2", &[]);
        n2.parallel = false;
        let mut sched2 = sched_with_graph(vec![n1, n2]);
        let n2_node2 = sched2.graph.as_ref().unwrap().node("n2").unwrap().clone();
        sched2
            .states
            .insert("n1".to_string(), FlowNodeState::Failed);
        assert!(sched2.is_ready(&n2_node2), "Failed + Report 视为满足");
    }

    // ── 节点状态映射 ──────────────────────────────────────────────

    #[test]
    fn node_state_maps_from_subagent_and_terminal_semantics() {
        assert_eq!(
            FlowNodeState::from_subagent(SubagentState::Pending),
            FlowNodeState::Pending
        );
        assert_eq!(
            FlowNodeState::from_subagent(SubagentState::Running),
            FlowNodeState::Running
        );
        assert_eq!(
            FlowNodeState::from_subagent(SubagentState::Completed),
            FlowNodeState::Completed
        );
        assert_eq!(
            FlowNodeState::from_subagent(SubagentState::Failed),
            FlowNodeState::Failed
        );
        for terminal in [
            FlowNodeState::Completed,
            FlowNodeState::Failed,
            FlowNodeState::Blocked,
        ] {
            assert!(terminal.is_terminal());
        }
        assert!(!FlowNodeState::Pending.is_terminal());
        assert!(!FlowNodeState::Running.is_terminal());
        // wire 名
        assert_eq!(FlowNodeState::Blocked.as_str(), "blocked");
    }

    // ── 增量就绪集 vs 全量 is_ready（详案 3-3）────────────────────

    #[derive(Debug, Default)]
    struct RecordingTestSpawner {
        seq: AtomicUsize,
        requests: Mutex<Vec<String>>,
        fail_ids: Mutex<HashSet<String>>,
    }

    impl RecordingTestSpawner {
        fn new() -> Arc<Self> {
            Arc::new(Self::default())
        }

        fn fail_ids(ids: &[&str]) -> Arc<Self> {
            Arc::new(Self {
                fail_ids: Mutex::new(ids.iter().map(|s| (*s).to_string()).collect()),
                ..Self::default()
            })
        }

        fn started_nodes(&self) -> Vec<String> {
            self.requests
                .lock()
                .expect("RecordingTestSpawner mutex")
                .clone()
        }
    }

    #[async_trait::async_trait]
    impl SubagentSpawner for RecordingTestSpawner {
        async fn spawn(
            &self,
            req: &SubagentSpawnRequest,
        ) -> Result<SubagentSpawnResult, SubagentSpawnError> {
            let node_id = req.flow_node_id.clone().unwrap_or_default();
            if self
                .fail_ids
                .lock()
                .expect("RecordingTestSpawner mutex")
                .contains(&node_id)
            {
                return Err(SubagentSpawnError::SpawnFailed(format!(
                    "模拟 spawn 失败：{node_id}"
                )));
            }
            self.requests
                .lock()
                .expect("RecordingTestSpawner mutex")
                .push(node_id.clone());
            let n = self.seq.fetch_add(1, Ordering::SeqCst);
            Ok(SubagentSpawnResult {
                subagent_id: format!("sub-{n}"),
                subagent_run_id: format!("flow-run-{n}"),
                session_id: format!("sess-{n}"),
                status: SubagentState::Running,
                summary: None,
                flow_node_id: req.flow_node_id.clone(),
                display_label: req.display_label.clone(),
            })
        }
    }

    fn sched_with_spawner(
        tasks: Vec<FlowNode>,
        spawner: Arc<dyn SubagentSpawner>,
    ) -> FlowScheduler {
        let meta = Arc::new(EmptyMeta);
        let mut sched = FlowScheduler::new("sess-u", spawner, meta).expect("调度器创建失败");
        let graph = FlowGraph::from_declaration(&declaration(tasks)).expect("声明应接受");
        for node in graph.nodes() {
            sched.states.insert(node.id.clone(), FlowNodeState::Pending);
        }
        sched.graph = Some(graph);
        sched
    }

    /// 全量 is_ready（声明序），对照增量调度结果
    fn full_ready_ids(sched: &FlowScheduler) -> Vec<FlowNodeId> {
        sched
            .graph
            .as_ref()
            .map(|g| {
                g.nodes()
                    .iter()
                    .filter(|n| sched.is_ready(n))
                    .map(|n| n.id.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 增量 advance 结束后必须是全量 is_ready / 全量 Block 传播的不动点
    fn assert_incremental_matches_full_scan(sched: &FlowScheduler) {
        let Some(graph) = sched.graph.as_ref() else {
            return;
        };
        for node in graph.nodes() {
            if sched.states.get(&node.id).copied() != Some(FlowNodeState::Pending) {
                continue;
            }
            let would_block = node
                .depends_on
                .iter()
                .any(|dep| match sched.states.get(dep) {
                    Some(FlowNodeState::Blocked) => true,
                    Some(FlowNodeState::Failed) => {
                        sched.effective_strategy(dep) == FailStrategy::Block
                    }
                    _ => false,
                });
            assert!(
                !would_block,
                "全量 propagate_block 仍会阻塞 {}，增量漏传播",
                node.id
            );
        }
        let full_ready = full_ready_ids(sched);
        if full_ready.is_empty() {
            return;
        }
        let in_flight = sched.budget.in_flight() as usize;
        let snapshot = RecursionGuardSnapshot {
            depth: 1,
            active_siblings: in_flight,
            active_concurrent: in_flight,
        };
        assert!(
            check_recursion_guard(snapshot, sched.guard).is_err(),
            "全量 is_ready 仍有 {full_ready:?} 且预算未满，增量漏调度"
        );
    }

    #[tokio::test]
    async fn advance_dirty_ready_set_matches_full_is_ready() {
        // 同一图：DAG 后继 b←a、同波次串行 s1→s2、s2 后继 t
        // 手工终态 a/s1 后，全量 is_ready = {b, s2}；增量 advance 必须正好启动这两个
        let mut s1 = node("s1", &[]);
        s1.parallel = false;
        let mut s2 = node("s2", &[]);
        s2.parallel = false;
        let spawner = RecordingTestSpawner::new();
        let mut sched = sched_with_spawner(
            vec![
                node("a", &[]),
                node("b", &["a"]),
                s1,
                s2,
                node("t", &["s2"]),
            ],
            spawner.clone(),
        );
        sched
            .states
            .insert("a".to_string(), FlowNodeState::Completed);
        sched
            .states
            .insert("s1".to_string(), FlowNodeState::Completed);
        let expected = full_ready_ids(&sched);
        assert_eq!(expected, vec!["b".to_string(), "s2".to_string()]);

        let adv = sched.advance().await.expect("增量推进");
        let mut started: Vec<&str> = adv.started.iter().map(|s| s.node_id.as_str()).collect();
        started.sort_unstable();
        assert_eq!(started, vec!["b", "s2"], "增量启动集 == 全量 is_ready");
        assert_eq!(sched.node_state("t"), Some(FlowNodeState::Pending));
        assert!(sched.dirty_set.is_empty(), "推进结束后脏集应收空");
        assert_incremental_matches_full_scan(&sched);

        let run_s2 = adv
            .started
            .iter()
            .find(|s| s.node_id == "s2")
            .expect("s2 已启动")
            .subagent_run_id
            .clone();
        let adv2 = sched
            .on_subagent_terminal(&run_s2, SubagentState::Completed)
            .await
            .expect("s2 终态推进");
        assert_eq!(
            adv2.started
                .iter()
                .map(|s| s.node_id.as_str())
                .collect::<Vec<_>>(),
            vec!["t"],
            "s2 完成后全量 is_ready={{t}}，增量同样只启动 t"
        );
        assert_incremental_matches_full_scan(&sched);
        assert_eq!(spawner.started_nodes(), vec!["b", "s2", "t"]);
    }

    #[tokio::test]
    async fn advance_dirty_spawn_fail_skip_matches_full_ready_same_call() {
        // spawn 失败 + Skip：同一轮 advance 必须启动 DAG 后继与同波次串行后继
        let mut a = node("a", &[]);
        a.parallel = false;
        a.on_failed = Some(FailStrategy::Skip);
        let mut s = node("s", &[]);
        s.parallel = false;
        let spawner = RecordingTestSpawner::fail_ids(&["a"]);
        let mut sched = sched_with_spawner(vec![a, s, node("b", &["a"])], spawner.clone());
        // 推进前全量就绪只有 a（s 受串行约束）
        assert_eq!(full_ready_ids(&sched), vec!["a".to_string()]);
        let adv = sched.advance().await.expect("增量推进");
        assert_eq!(sched.node_state("a"), Some(FlowNodeState::Failed));
        let mut started: Vec<&str> = adv.started.iter().map(|s| s.node_id.as_str()).collect();
        started.sort_unstable();
        assert_eq!(
            started,
            vec!["b", "s"],
            "Failed+Skip 后全量 is_ready={{b,s}}，须在同一轮增量启动"
        );
        assert!(sched.dirty_set.is_empty());
        assert_incremental_matches_full_scan(&sched);
    }

    #[tokio::test]
    async fn advance_dirty_block_propagation_matches_full_scan() {
        // a spawn 失败 + 默认 Block：同一轮须传递阻塞 b→c，且不动点与全量一致
        let spawner = RecordingTestSpawner::fail_ids(&["a"]);
        let mut sched = sched_with_spawner(
            vec![
                node("a", &[]),
                node("b", &["a"]),
                node("c", &["b"]),
                node("d", &[]),
            ],
            spawner.clone(),
        );
        let adv = sched.advance().await.expect("增量推进");
        assert_eq!(sched.node_state("a"), Some(FlowNodeState::Failed));
        assert_eq!(sched.node_state("b"), Some(FlowNodeState::Blocked));
        assert_eq!(sched.node_state("c"), Some(FlowNodeState::Blocked));
        assert_eq!(sched.node_state("d"), Some(FlowNodeState::Running));
        assert_eq!(
            adv.started
                .iter()
                .map(|s| s.node_id.as_str())
                .collect::<Vec<_>>(),
            vec!["d"]
        );
        assert!(adv.blocked.contains(&"b".to_string()));
        assert!(adv.blocked.contains(&"c".to_string()), "Block 须传递到 c");
        assert!(sched.dirty_set.is_empty());
        assert_incremental_matches_full_scan(&sched);
        assert_eq!(full_ready_ids(&sched).len(), 0, "阻塞后全量就绪集为空");
    }
}
