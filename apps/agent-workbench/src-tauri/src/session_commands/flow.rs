//! F11b（T-D-12）：DAG 只读快照查询（get_flow_snapshot）。

use std::collections::HashMap;

use agent_tools::tools::subagent::SubagentState;
use conex_types::{CoreError, SessionAgent};
use orchestrator::flow_graph::{
    FailStrategy, FlowDeclaration, FlowNodeRuntime, FlowNodeState, FLOW_DECLARATION_KEY,
    FLOW_ON_FAILED_KEY, FLOW_STATE_KEY,
};
use tauri::State;

use super::{map_db_err, require_session_id, SharedDb};

// ── F11b（T-D-12）：DAG 只读快照查询 ────────────────────────────────

/// 流程 DAG 快照（get_flow_snapshot 返回值）。
///
/// 载荷形状由主调度冻结（`{ nodes: [{ id, task, dependsOn, parallel,
/// isComposite, state, subagentRunId }] }`），DAG-2 前端按同形状消费——
/// 见 docs/feature-gap-analysis/调研-可视化与扩展点.md §2.5。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowSnapshot {
    /// 节点列表（声明序 = 同层串行顺序）
    pub nodes: Vec<FlowSnapshotNode>,
}

/// 单节点快照（字段对齐冻结形状；camelCase，对齐 flow_graph serde 命名）。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowSnapshotNode {
    /// 节点 id（会话内唯一，依赖边端点）
    pub id: String,
    /// 任务目标（spawn 子 agent 的 prompt）
    pub task: String,
    /// 前置节点 id 列表（空 = 无前置，可首批启动；恒输出数组对齐冻结形状）
    pub depends_on: Vec<String>,
    /// 是否允许与无依赖关系的同级节点并发（false = 与同级串行）
    pub parallel: bool,
    /// 综合节点标记（gate / verify / critique 类，合成唤醒）
    pub is_composite: bool,
    /// 节点状态（pending/running/completed/failed/blocked，对齐 FlowNodeState）
    pub state: String,
    /// 关联的子代理 run id（None = 未启动；挂接外部 run 也落此字段）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_run_id: Option<String>,
}

/// 从持久化数据拼装 DAG 快照（只读，T-D-12 引擎侧核心组装逻辑）。
///
/// 数据源：
/// - `flow_declaration` 键：编排声明（节点 / 依赖 / parallel / is_composite）；
/// - `flow_state` 键：节点 → run 映射（[FlowNodeRuntime] JSON 数组）；
/// - `session_agents` 行：按 `subagent_run_id` 拼装节点状态
///   （`SubagentState::from_db_status` → `FlowNodeState::from_subagent`，
///   与 FlowScheduler::load 同口径）。
///
/// 派生语义（只读镜像 FlowScheduler 恢复面，flow_graph.rs:1346-1380）：
/// - 无编排声明（键缺失）→ 空 nodes（空态，不报错）；
/// - 未启动节点（无 run 映射）→ pending；
/// - run 映射存在但 session_agents 无行 → failed（fail-open，数据不一致兜底）；
/// - Block 传播到不动点：待启动节点任一前置为 blocked，或前置 failed 且其
///   生效策略为 Block → 本节点 blocked（镜像 propagate_block，
///   flow_graph.rs:1476-1512；生效策略 = 节点级 on_failed ?? 会话级
///   flow_on_failed，键缺失默认 Block；解析失败宽容取 Block）。
pub(super) fn build_flow_snapshot(
    declaration_raw: Option<String>,
    state_raw: Option<String>,
    on_failed_raw: Option<String>,
    agents: &[SessionAgent],
) -> Result<FlowSnapshot, CoreError> {
    // 空态：无 flow 声明 → 空 nodes（前端空态判定直接命中）
    let Some(declaration_raw) = declaration_raw else {
        return Ok(FlowSnapshot { nodes: Vec::new() });
    };
    let declaration: FlowDeclaration = serde_json::from_str(&declaration_raw)
        .map_err(|e| CoreError::Internal(format!("flow_declaration 解析失败：{e}")))?;
    // 运行时状态：节点 id → FlowNodeRuntime（run 映射 / 唤醒标记）
    let runtime: HashMap<String, FlowNodeRuntime> = match state_raw {
        Some(state_raw) => {
            let entries: Vec<FlowNodeRuntime> = serde_json::from_str(&state_raw)
                .map_err(|e| CoreError::Internal(format!("flow_state 解析失败：{e}")))?;
            entries
                .into_iter()
                .map(|rt| (rt.node_id.clone(), rt))
                .collect()
        }
        None => HashMap::new(),
    };
    // 会话级默认失败策略（缺失 = Block，对齐 read_meta_strategy 默认值）
    let session_strategy = on_failed_raw
        .as_deref()
        .and_then(FailStrategy::parse)
        .unwrap_or(FailStrategy::Block);
    let rows: HashMap<&str, &SessionAgent> = agents
        .iter()
        .map(|r| (r.subagent_run_id.as_str(), r))
        .collect();
    // 节点级生效策略（节点级覆盖 ?? 会话级默认，对齐 effective_strategy）
    let node_strategy = |id: &str| {
        declaration
            .tasks
            .iter()
            .find(|n| n.id == id)
            .and_then(|n| n.on_failed)
            .unwrap_or(session_strategy)
    };

    // 1. 基础状态：按 run 映射 + session_agents 行拼装（镜像 load 步骤 4）
    let mut states: HashMap<String, FlowNodeState> = HashMap::new();
    for node in &declaration.tasks {
        let state = match runtime
            .get(&node.id)
            .and_then(|rt| rt.subagent_run_id.as_deref())
        {
            Some(run_id) => match rows.get(run_id) {
                Some(row) => {
                    FlowNodeState::from_subagent(SubagentState::from_db_status(&row.status))
                }
                // 数据不一致：run 记录缺失 → 按失败处理（fail-open）
                None => FlowNodeState::Failed,
            },
            None => FlowNodeState::Pending,
        };
        states.insert(node.id.clone(), state);
    }

    // 2. Block 传播到不动点（只读派生，镜像 propagate_block；依赖环已在
    //    声明校验拒绝，无需防循环）
    loop {
        let mut changed = false;
        for node in &declaration.tasks {
            if states.get(&node.id).copied() != Some(FlowNodeState::Pending) {
                continue;
            }
            let blocker = node.depends_on.iter().any(|dep| match states.get(dep) {
                Some(FlowNodeState::Blocked) => true,
                Some(FlowNodeState::Failed) => node_strategy(dep) == FailStrategy::Block,
                _ => false,
            });
            if blocker {
                states.insert(node.id.clone(), FlowNodeState::Blocked);
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }

    // 3. 组装冻结形状（声明序输出）
    let nodes = declaration
        .tasks
        .iter()
        .map(|n| FlowSnapshotNode {
            id: n.id.clone(),
            task: n.task.clone(),
            depends_on: n.depends_on.clone(),
            parallel: n.parallel,
            is_composite: n.is_composite,
            state: states
                .get(&n.id)
                .copied()
                .unwrap_or(FlowNodeState::Pending)
                .as_str()
                .to_string(),
            subagent_run_id: runtime.get(&n.id).and_then(|rt| rt.subagent_run_id.clone()),
        })
        .collect();
    Ok(FlowSnapshot { nodes })
}

/// get_flow_snapshot：DAG 只读查询命令（T-D-12 引擎侧，F11b）。
///
/// 读 `flow_declaration` + `flow_state` + `session_agents`（按 subagent_run_id
/// 拼装节点状态），返回冻结载荷形状 `{ nodes: [...] }`（见 [FlowSnapshot]）。
/// 只读通用面：不新增任何写入（编排权仍在主 Agent）；命令保留无害——
/// `flow_dag_visible` 开关（默认关）关闭时前端不调用本命令。
#[tauri::command]
pub async fn get_flow_snapshot(
    session_id: String,
    db_state: State<'_, SharedDb>,
) -> Result<FlowSnapshot, CoreError> {
    require_session_id(&session_id)?;
    let db = db_state.inner().local_db();
    let snapshot = tokio::task::spawn_blocking(move || -> Result<FlowSnapshot, CoreError> {
        let declaration = db
            .get_session_meta(FLOW_DECLARATION_KEY)
            .map_err(map_db_err)?;
        let state = db.get_session_meta(FLOW_STATE_KEY).map_err(map_db_err)?;
        let on_failed = db
            .get_session_meta(FLOW_ON_FAILED_KEY)
            .map_err(map_db_err)?;
        let agents = db.load_session_agents(&session_id).map_err(map_db_err)?;
        build_flow_snapshot(declaration, state, on_failed, &agents)
    })
    .await
    .map_err(|e| CoreError::Internal(format!("get_flow_snapshot join: {e}")))??;
    Ok(snapshot)
}
