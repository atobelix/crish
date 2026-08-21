//! 推进域（flow_graph 拆分：推进）
//!
//! 职责：`advance` 不动点循环、dirty 集增量就绪、`propagate_block` 传递阻塞、
//! `is_ready` / `serial_predecessor_pending` 同级串行约束、`seed_dirty_pending` /
//! `mark_successors_dirty`。保留 Q3 dirty 集逻辑（O(dirty) 按声明序推进），
//! 预算判定与 spawn 在本模块内完成。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use agent_tools::tools::subagent::{
    check_recursion_guard, RecursionGuardSnapshot, SubagentSpawnRequest, SubagentState,
};
use conex_types::events::SubagentEndStatus;

use crate::subagent_events::{started_info_from_spawn, SubagentEmitContext, SubagentEndedInfo};

use super::model::{FailStrategy, FlowGraph, FlowNode, FlowNodeId, FlowNodeRuntime, FlowNodeState};
use super::scheduler::{
    FlowAdvance, FlowError, FlowReport, FlowReportKind, FlowScheduler, FlowStarted, FlowWakeup,
};

// ── 声明序索引缓存（预计算一次，复用）─────────────────────────────
// 审计02指出 advance 每轮重建 HashMap（每轮分配）。此处改为会话级缓存复用：
// FlowGraph 构造（声明校验通过）后首次计算 `id -> 声明序` 并缓存；同会话
// 后续 advance 仅查表（Arc 复用），不再每轮重建 HashMap。图声明变更（节点
// 增删或重排导致 ids 序列变化）时重算。实现语义等价于“FlowGraph 构造时一次
// 计算声明序索引”，但不改 FlowGraph 结构，仅在本推进域内缓存。

struct CachedDeclarationOrder {
    ids: Vec<FlowNodeId>,
    map: Arc<HashMap<FlowNodeId, usize>>,
}

fn declaration_order_cache() -> &'static Mutex<HashMap<String, CachedDeclarationOrder>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedDeclarationOrder>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 获取声明序索引（会话级预计算复用，advance 内仅查表）
///
/// 命中缓存且 ids 序列一致时直接复用 Arc（无 HashMap 重建）；未命中或图
/// 声明变更时重算一次并更新缓存。
fn cached_declaration_order(
    session_id: &str,
    graph: &FlowGraph,
) -> Arc<HashMap<FlowNodeId, usize>> {
    // 快路径：尝试命中
    {
        let cache = declaration_order_cache()
            .lock()
            .unwrap_or_else(|e| {
                tracing::error!(
                    target: "orchestrator",
                    "declaration_order_cache 锁中毒，已恢复"
                );
                e.into_inner()
            });
        if let Some(cached) = cache.get(session_id) {
            if cached.ids.len() == graph.len()
                && cached
                    .ids
                    .iter()
                    .zip(graph.nodes())
                    .all(|(a, b)| a == &b.id)
            {
                return Arc::clone(&cached.map);
            }
        }
    }
    // 未命中：重算
    let map: HashMap<FlowNodeId, usize> = graph
        .nodes()
        .iter()
        .enumerate()
        .map(|(i, n)| (n.id.clone(), i))
        .collect();
    let arc = Arc::new(map);
    let ids = graph.nodes().iter().map(|n| n.id.clone()).collect();
    let mut cache = declaration_order_cache()
        .lock()
        .unwrap_or_else(|e| {
            tracing::error!(
                target: "orchestrator",
                "declaration_order_cache 锁中毒，已恢复"
            );
            e.into_inner()
        });
    cache.insert(
        session_id.to_string(),
        CachedDeclarationOrder {
            ids,
            map: Arc::clone(&arc),
        },
    );
    arc
}

impl FlowScheduler {
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
        // 声明序索引改为会话级缓存复用（预计算一次，advance 内仅查表，不再每轮重建 HashMap）
        let order_index = cached_declaration_order(&self.session_id, &graph);
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
                    parent_tool_call_id: None,
                    flow_node_id: Some(node_id.clone()),
                    is_composite: node.is_composite,
                    task_type: None,
                    allowed_write_paths: None,
                    display_label: None,
                    model_override: None,
                };
                match self.spawner.spawn(&request).await {
                    Ok(result) => {
                        self.states.insert(node_id.clone(), FlowNodeState::Running);
                        self.mark_successors_dirty(&node_id);
                        {
                            let runtime = self
                                .runtime
                                .entry(node_id.clone())
                                .or_insert_with(|| FlowNodeRuntime::new(node_id.clone()));
                            runtime.subagent_run_id = Some(result.subagent_run_id.clone());
                            runtime.subagent_session_id = Some(result.session_id.clone());
                        }
                        self.persist_runtime()?;
                        self.persist_budget()?;
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
        self.budget.release();
        let next = FlowNodeState::from_subagent(state);
        self.states.insert(node_id.clone(), next);
        self.mark_successors_dirty(&node_id);
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
        let mut fail_reports = Vec::new();
        if next == FlowNodeState::Failed {
            let strategy = self.effective_strategy(&node_id);
            match strategy {
                FailStrategy::Skip => {}
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
        advance.reports.splice(0..0, fail_reports);
        Ok(advance)
    }

    pub(crate) fn is_ready(&self, node: &FlowNode) -> bool {
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

    pub(crate) fn propagate_block(&mut self, graph: &FlowGraph, out: &mut FlowAdvance) {
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
                    self.mark_successors_dirty(&node_id);
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
    }

    pub(crate) fn seed_dirty_pending(&mut self) {
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

    pub(crate) fn mark_successors_dirty(&mut self, node_id: &str) {
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

    pub(crate) fn effective_strategy(&self, node_id: &str) -> FailStrategy {
        self.graph
            .as_ref()
            .and_then(|g| g.node(node_id))
            .and_then(|n| n.on_failed)
            .unwrap_or(self.default_strategy)
    }

    pub(crate) fn all_terminal(&self) -> bool {
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
}
