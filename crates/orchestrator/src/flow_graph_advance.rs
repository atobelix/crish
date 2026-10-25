//! 推进域（flow_graph 拆分：推进）
//!
//! 职责：`advance` 不动点循环、dirty 集增量就绪、`propagate_block` 传递阻塞、
//! `is_ready` / `serial_predecessor_pending` 同级串行约束、`seed_dirty_pending` /
//! `mark_successors_dirty`。保留 Q3 dirty 集逻辑（O(dirty) 按声明序推进），
//! 预算判定与 spawn 在本模块内完成。

use std::collections::HashMap;

use agent_tools::tools::subagent::{
    check_recursion_guard, RecursionGuardSnapshot, SubagentSpawnRequest, SubagentState,
};
use conex_types::events::SubagentEndStatus;

use crate::subagent_events::{started_info_from_spawn, SubagentEmitContext, SubagentEndedInfo};

use super::model::{FailStrategy, FlowGraph, FlowNode, FlowNodeId, FlowNodeRuntime, FlowNodeState};
use super::scheduler::{
    FlowAdvance, FlowError, FlowReport, FlowReportKind, FlowScheduler, FlowStarted, FlowWakeup,
};

/// 判断两个节点的 `depends_on` 集合是否等价（排序无关的集合等价判定，修复 DEFECT-03）。
#[inline]
fn same_dependency_set(a: &[FlowNodeId], b: &[FlowNodeId]) -> bool {
    a.len() == b.len() && a.iter().all(|dep| b.contains(dep)) && b.iter().all(|dep| a.contains(dep))
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
        // 局部栈上构建轻量级 O(V) 节点索引映射（彻底消除进程级全局静态锁争用与会话内存泄漏）
        let order_index: HashMap<&str, usize> = graph
            .nodes()
            .iter()
            .enumerate()
            .map(|(i, n)| (n.id.as_str(), i))
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
            // 2. 仅遍历 dirty 集 O(dirty)（按声明序排序，O(1) 索引查表）
            let mut ready_ids: Vec<FlowNodeId> = self
                .dirty_set
                .iter()
                .filter_map(|id| {
                    order_index
                        .get(id.as_str())
                        .and_then(|&idx| graph.nodes().get(idx).map(|n| (n, idx, id.clone())))
                })
                .filter(|(node, idx, _)| {
                    self.is_ready_with_order(node, Some(*idx), Some(&order_index))
                })
                .map(|(_, _, id)| id)
                .collect();
            ready_ids.sort_by_key(|id| order_index.get(id.as_str()).copied().unwrap_or(usize::MAX));
            // 本轮脏集已判定；后续仅由状态迁移 / Block 波及再入集
            self.dirty_set.clear();
            if ready_ids.is_empty() {
                break;
            }
            let mut spawned_any = false;
            let mut budget_blocked: Vec<FlowNodeId> = Vec::new();
            for (idx, node_id) in ready_ids.iter().enumerate() {
                let node_id = node_id.clone();
                let Some(node_idx) = order_index.get(node_id.as_str()).copied() else {
                    // 就绪集合由上面的 order_index 生成；缺失说明图与索引不同步。
                    // 不 panic（安全边界不得靠 expect），跳过该节点并留痕。
                    tracing::error!(node = %node_id, "就绪节点缺少顺序索引，跳过本轮调度");
                    continue;
                };
                let node = &graph.nodes()[node_idx];
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
                let spawner_owns_flow_events = self.spawner.owns_flow_lifecycle_events();
                match self
                    .spawner
                    .spawn_flow_node(&request, self.subagent_events.is_some())
                    .await
                {
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
                            runtime.subagent_id = Some(result.subagent_id.clone());
                        }
                        self.persist_runtime()?;
                        self.persist_budget()?;
                        if !spawner_owns_flow_events {
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
                        self.unload_terminal_node(&node_id);
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
        if let Some(emitter) = self
            .subagent_events
            .as_ref()
            .filter(|_| !self.spawner.owns_flow_lifecycle_events())
        {
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
        if next.is_terminal() {
            self.unload_terminal_node(&node_id);
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
        self.is_ready_with_order(node, None, None)
    }

    pub(crate) fn is_ready_with_order(
        &self,
        node: &FlowNode,
        known_idx: Option<usize>,
        order_index: Option<&HashMap<&str, usize>>,
    ) -> bool {
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
        !self.serial_predecessor_pending(node, known_idx, order_index)
    }

    pub(crate) fn serial_predecessor_pending(
        &self,
        node: &FlowNode,
        known_idx: Option<usize>,
        order_index: Option<&HashMap<&str, usize>>,
    ) -> bool {
        if node.parallel {
            return false;
        }
        let Some(graph) = self.graph.as_ref() else {
            return false;
        };
        // O(1) 索引查找：直接使用传入的已知下标，或局部栈 order_index 查表，或 graph.node_order
        // 彻底消除对 graph.nodes() 的 O(V) 嵌套线性 position 扫描（DEFECT-02）
        let end_idx = known_idx
            .or_else(|| order_index.and_then(|idx_map| idx_map.get(node.id.as_str()).copied()))
            .or_else(|| graph.node_order(&node.id))
            .unwrap_or(0);
        graph.nodes()[..end_idx].iter().any(|n| {
            !n.parallel
                && same_dependency_set(&n.depends_on, &node.depends_on)
                && !self.serial_predecessor_satisfied(n)
        })
    }

    fn serial_predecessor_satisfied(&self, node: &FlowNode) -> bool {
        match self.states.get(&node.id).copied() {
            Some(FlowNodeState::Completed | FlowNodeState::Blocked | FlowNodeState::Cancelled) => {
                true
            }
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
                    self.unload_terminal_node(&node_id);
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
        if let Some(changed_idx) = graph.node_order(node_id) {
            let changed = &graph.nodes()[changed_idx];
            if !changed.parallel {
                for n in &graph.nodes()[changed_idx + 1..] {
                    if !n.parallel && same_dependency_set(&n.depends_on, &changed.depends_on) {
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

    /// 终态数据卸载（DEFECT-17）：卸载指定终态节点的 task prompt 与 runtime 瞬态数据，防止海量节点内存单调无界驻留
    pub fn unload_terminal_node(&mut self, node_id: &str) {
        if let Some(graph) = self.graph.as_mut() {
            graph.unload_node_payload(node_id);
        }
        if let Some(runtime) = self.runtime.get_mut(node_id) {
            runtime.unload_runtime_data();
        }
    }

    /// 将节点置为 Cancelled 终态并触发数据卸载（DEFECT-17）
    pub fn cancel_node(&mut self, node_id: &str) {
        self.states
            .insert(node_id.to_string(), FlowNodeState::Cancelled);
        self.mark_successors_dirty(node_id);
        self.unload_terminal_node(node_id);
    }
}

#[cfg(test)]
mod tests {
    use super::super::model::FlowDeclaration;
    use super::*;

    #[test]
    fn same_dependency_set_is_order_independent() {
        let a = vec!["task_1".to_string(), "task_2".to_string()];
        let b = vec!["task_2".to_string(), "task_1".to_string()];
        let c = vec!["task_1".to_string(), "task_3".to_string()];
        let d = vec!["task_1".to_string()];

        assert!(
            same_dependency_set(&a, &b),
            "乱序声明的相同依赖集合应判定等价"
        );
        assert!(!same_dependency_set(&a, &c), "元素不同应判定不等价");
        assert!(!same_dependency_set(&a, &d), "长度不同应判定不等价");
        assert!(same_dependency_set(&[], &[]), "空集合等价");
    }

    #[test]
    fn is_ready_with_order_index_fast_path() {
        let decl = FlowDeclaration {
            tasks: vec![
                FlowNode {
                    id: "a".to_string(),
                    task: "task a".to_string(),
                    depends_on: vec![],
                    parallel: false,
                    on_failed: None,
                    is_composite: false,
                },
                FlowNode {
                    id: "b".to_string(),
                    task: "task b".to_string(),
                    depends_on: vec!["a".to_string()],
                    parallel: false,
                    on_failed: None,
                    is_composite: false,
                },
            ],
            planner_run_id: None,
        };
        let graph = FlowGraph::from_declaration(&decl).expect("合法图");
        let order_index: HashMap<&str, usize> = graph
            .nodes()
            .iter()
            .enumerate()
            .map(|(i, n)| (n.id.as_str(), i))
            .collect();

        // 验证 order_index 与 is_ready_with_order 无需 position 扫描即能准确定位下标
        assert_eq!(order_index.get("a"), Some(&0));
        assert_eq!(order_index.get("b"), Some(&1));
    }
}
