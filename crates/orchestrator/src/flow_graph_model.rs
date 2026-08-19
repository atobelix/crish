//! 图结构域（flow_graph 拆分：模型）
//!
//! 职责：`FlowGraph` / `FlowNode` / `FlowNodeId` / `FailStrategy` / `add_dependency` 环检测
//! / `FlowNodeState` / `FlowNodeRuntime`。不含推进/调度逻辑，保持纯结构
//! 校验与依赖查询。dirty 集等推进语义在 `flow_graph_advance`。

use std::collections::{HashMap, HashSet};
use std::fmt;

use agent_tools::tools::subagent::SubagentState;
use serde::{Deserialize, Serialize};

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
    pub(crate) fn new(node_id: FlowNodeId) -> Self {
        Self {
            node_id,
            subagent_run_id: None,
            subagent_id: None,
            subagent_session_id: None,
            wakeup_sent: false,
        }
    }
}
