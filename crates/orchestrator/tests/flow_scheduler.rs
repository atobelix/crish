//! C6 依赖图调度器集成测试（I5-M6）
//!
//! 覆盖 04 文档 C6 验收 1–6 + 02 方案 M6 扩展项：
//! - 依赖就绪门控（B 在 A completed 前不启动；running 不算）；
//! - 并发预算（10 个 parallel 峰值 ≤ maxConcurrent；终态事件即时补位不轮询）；
//! - on_failed 三策略（Skip / Block / Report，含会话级默认与传递阻塞）；
//! - 环声明拒绝零 run；一轮一编排；
//! - 重启恢复（已完成不重复启动、未完成按图恢复、预算跨重启重算）；
//! - 合成唤醒（gate 前置全 completed 触发唤醒事件不轮询、planner_run_id
//!   亲和、观测态挂接与自动排队两路）。
//!
//! 测试替身：InMemoryMeta（session_meta 内存实现）+ RecordingSpawner
//! （记录请求 / 可注入失败 / 可选落库 session_agents——重启场景用真实
//! SQLite 库，连接关闭再打开等效进程重启）。

// G2 禁令豁免：测试临时目录清理（非产品删除路径，可恢复语义不适用）。
#![allow(clippy::disallowed_methods)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use agent_tools::tools::subagent::{
    SubagentSpawnError, SubagentSpawnRequest, SubagentSpawnResult, SubagentSpawner,
    SubagentState,
};
use async_trait::async_trait;
use conex_db::LocalDb;
use conex_test_utils::TempWorkspace;
use conex_types::SessionAgent;
use orchestrator::flow_graph::{
    FailStrategy, FlowDeclaration, FlowError, FlowGraphError, FlowMetaStore, FlowNode,
    FlowNodeState, FlowReportKind, FlowScheduler, FLOW_AUTO_COMPOSITE_KEY,
    FLOW_DECLARATION_KEY, FLOW_MAX_SIBLINGS_KEY, FLOW_ON_FAILED_KEY, FLOW_RELEASED_KEY,
    FLOW_RESERVED_KEY,
};

// ── 测试替身 ──────────────────────────────────────────────────────

/// session_meta 内存实现（FlowMetaStore 契约；可预置可配键）
struct InMemoryMeta {
    store: Mutex<HashMap<String, String>>,
}

impl InMemoryMeta {
    fn new() -> Self {
        Self {
            store: Mutex::new(HashMap::new()),
        }
    }
}

impl FlowMetaStore for InMemoryMeta {
    fn get_meta(&self, key: &str) -> Result<Option<String>, FlowError> {
        Ok(self.store.lock().unwrap().get(key).cloned())
    }

    fn set_meta(&self, key: &str, value: &str) -> Result<(), FlowError> {
        self.store.lock().unwrap().insert(key.to_string(), value.to_string());
        Ok(())
    }
}

/// 记录式 spawner：记录请求、自增 run id、可注入一次失败；
/// DB 模式（with_db）同时落库 session_agents 行（pending 首写即 running）
struct RecordingSpawner {
    requests: Mutex<Vec<SubagentSpawnRequest>>,
    /// 剩余失败次数（消费式；>0 时下次 spawn 失败）
    fail_left: AtomicUsize,
    seq: AtomicUsize,
    db: Option<LocalDb>,
    session_id: String,
}

impl RecordingSpawner {
    fn new() -> Self {
        Self {
            requests: Mutex::new(Vec::new()),
            fail_left: AtomicUsize::new(0),
            seq: AtomicUsize::new(0),
            db: None,
            session_id: String::new(),
        }
    }

    /// DB 模式：spawn 时把行写入 session_agents（重启恢复场景）
    fn with_db(db: LocalDb, session_id: &str) -> Self {
        Self {
            requests: Mutex::new(Vec::new()),
            fail_left: AtomicUsize::new(0),
            seq: AtomicUsize::new(0),
            db: Some(db),
            session_id: session_id.to_string(),
        }
    }

    fn requests(&self) -> Vec<SubagentSpawnRequest> {
        self.requests.lock().unwrap().clone()
    }

    fn fail_next_spawn(&self) {
        self.fail_left.store(1, Ordering::SeqCst);
    }
}

impl std::fmt::Debug for RecordingSpawner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RecordingSpawner").finish_non_exhaustive()
    }
}

#[async_trait]
impl SubagentSpawner for RecordingSpawner {
    async fn spawn(
        &self,
        req: &SubagentSpawnRequest,
    ) -> Result<SubagentSpawnResult, SubagentSpawnError> {
        self.requests.lock().unwrap().push(req.clone());
        let should_fail = {
            let left = self.fail_left.load(Ordering::SeqCst);
            if left > 0 {
                self.fail_left.store(left - 1, Ordering::SeqCst);
                true
            } else {
                false
            }
        };
        if should_fail {
            return Err(SubagentSpawnError::SpawnFailed("模拟 spawn 失败".to_string()));
        }
        let n = self.seq.fetch_add(1, Ordering::SeqCst);
        let run_id = format!("flow-run-{n}");
        if let Some(db) = &self.db {
            let mut agents = db
                .load_session_agents(&self.session_id)
                .map_err(|e| SubagentSpawnError::PersistFailed(e.to_string()))?;
            agents.push(SessionAgent {
                id: format!("sub-{n}"),
                subagent_run_id: run_id.clone(),
                parent_session_id: self.session_id.clone(),
                parent_run_id: req.parent_run_id.clone().unwrap_or_default(),
                parent_tool_call_id: req.parent_tool_call_id.clone(),
                description: req.flow_node_id.clone().unwrap_or_default(),
                mode: String::new(),
                status: "running".to_string(),
                summary: None,
                messages: Vec::new(),
                started_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as i64,
                ended_at: None,
                depth: Some(1),
                subagent_path_json: None,
                // T-D-07 v6 新列：测试域 spawner 透传请求字段（模型覆盖不落库）
                task_type: req.task_type.map(|t| t.as_str().to_string()),
                display_label: req.display_label.clone(),
                allowed_write_paths_json: req.allowed_write_paths.as_ref().map(|paths| {
                    serde_json::to_string(paths).expect("路径白名单序列化不应失败")
                }),
                // D-02 LK-04：子会话 id 随行（与结果信封 session_id 同源）
                sub_session_id: Some(format!("sess-{n}")),
            });
            db.save_session_agents(&self.session_id, &agents)
                .map_err(|e| SubagentSpawnError::PersistFailed(e.to_string()))?;
        }
        Ok(SubagentSpawnResult {
            subagent_id: format!("sub-{n}"),
            subagent_run_id: run_id,
            session_id: format!("sess-{n}"),
            status: SubagentState::Running,
            summary: None,
            flow_node_id: req.flow_node_id.clone(),
            display_label: req.display_label.clone(),
        })
    }
}

/// 更新 session_agents 行状态（模拟引擎侧子代理终态落库）
fn set_row_status(db: &LocalDb, session_id: &str, run_id: &str, status: &str) {
    let mut agents = db.load_session_agents(session_id).expect("读取行失败");
    let row = agents
        .iter_mut()
        .find(|a| a.subagent_run_id == run_id)
        .expect("run 行必须存在");
    row.status = status.to_string();
    db.save_session_agents(session_id, &agents).expect("保存行失败");
}

// ── 构造助手 ──────────────────────────────────────────────────────

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

fn decl(tasks: Vec<FlowNode>) -> FlowDeclaration {
    FlowDeclaration {
        tasks,
        planner_run_id: Some("planner-1".to_string()),
    }
}

/// 内存 meta + 记录 spawner + 新调度器
fn harness() -> (FlowScheduler, Arc<RecordingSpawner>, Arc<InMemoryMeta>) {
    let spawner = Arc::new(RecordingSpawner::new());
    let meta = Arc::new(InMemoryMeta::new());
    let sched = FlowScheduler::new("sess-a", spawner.clone(), meta.clone()).expect("调度器创建失败");
    (sched, spawner, meta)
}

// ── 依赖就绪门控（04 C6 验收 1）───────────────────────────────────

#[tokio::test]
async fn dependent_starts_only_after_prerequisite_completed() {
    let (mut sched, spawner, _meta) = harness();
    let adv = sched
        .declare_flow(&decl(vec![node("a", &[]), node("b", &["a"])]))
        .await
        .expect("DAG 声明应接受");
    assert_eq!(adv.started.len(), 1);
    assert_eq!(adv.started[0].node_id, "a");
    assert_eq!(sched.node_state("a"), Some(FlowNodeState::Running));
    assert_eq!(
        sched.node_state("b"),
        Some(FlowNodeState::Pending),
        "B 在 A completed 前不启动"
    );
    // running 不算前置完成：显式推进也不启动 B
    let adv2 = sched.advance().await.unwrap();
    assert!(adv2.started.is_empty(), "A running 时 B 不得启动");
    assert_eq!(spawner.requests().len(), 1);
    // A completed → B 启动
    let run_a = adv.started[0].subagent_run_id.clone();
    let adv3 = sched
        .on_subagent_terminal(&run_a, SubagentState::Completed)
        .await
        .unwrap();
    assert_eq!(adv3.started.len(), 1);
    assert_eq!(adv3.started[0].node_id, "b");
    assert_eq!(sched.node_state("b"), Some(FlowNodeState::Running));
    // B completed → 编排终态（只推进不回溯，无重复启动）
    let run_b = adv3.started[0].subagent_run_id.clone();
    let adv4 = sched
        .on_subagent_terminal(&run_b, SubagentState::Completed)
        .await
        .unwrap();
    assert!(adv4.flow_terminal);
    assert!(adv4.started.is_empty());
    assert_eq!(spawner.requests().len(), 2, "全程只 spawn 两个节点");
}

// ── 并发上限（04 C6 验收 2：20 个 parallel 峰值 ≤ maxConcurrent）──

#[tokio::test]
async fn parallel_burst_peak_respects_max_concurrent_event_driven() {
    let (mut sched, spawner, _meta) = harness();
    let tasks: Vec<FlowNode> = (0..20).map(|i| node(&format!("n{i}"), &[])).collect();
    let adv = sched.declare_flow(&decl(tasks)).await.unwrap();
    assert_eq!(adv.started.len(), 17, "快照不含本次请求：in_flight 到 16 后第 17 个放行、第 18 个被拒");
    assert_eq!(spawner.requests().len(), 17);
    assert_eq!(sched.budget_in_flight(), 17);
    // 事件驱动不轮询：完成一个 → 终态事件内部立即补位一个
    let first_run = adv.started[0].subagent_run_id.clone();
    let adv2 = sched
        .on_subagent_terminal(&first_run, SubagentState::Completed)
        .await
        .unwrap();
    assert_eq!(adv2.started.len(), 1, "终态事件即时补位（不轮询）");
    assert_eq!(spawner.requests().len(), 18);
    assert!(sched.budget_in_flight() <= 17, "在途峰值不超过预算");
    // 逐个完成 → 剩余节点全部补位，峰值全程 ≤ 17
    let mut run_queue: Vec<String> = adv.started.iter().map(|s| s.subagent_run_id.clone()).collect();
    run_queue.push(adv2.started[0].subagent_run_id.clone());
    let mut in_flight_peak = sched.budget_in_flight();
    let mut cursor = 0usize;
    while spawner.requests().len() < 20 {
        let finished = run_queue[cursor].clone();
        let adv_n = sched
            .on_subagent_terminal(&finished, SubagentState::Completed)
            .await
            .unwrap();
        in_flight_peak = in_flight_peak.max(sched.budget_in_flight());
        run_queue.extend(adv_n.started.iter().map(|s| s.subagent_run_id.clone()));
        cursor += 1;
    }
    assert_eq!(spawner.requests().len(), 20, "20 个 parallel 任务全部启动");
    assert!(in_flight_peak <= 17, "并发峰值全程 ≤ maxConcurrent");
}

// ── parallel 同级串行约束（裁决 D2：同级 = 同 depends_on 集合）───

#[tokio::test]
async fn serial_siblings_start_in_declaration_order() {
    let (mut sched, spawner, _meta) = harness();
    // 同波次（depends_on=[]）两 parallel=false 节点：声明序为串行顺序
    let mut n1 = node("n1", &[]);
    n1.parallel = false;
    let mut n2 = node("n2", &[]);
    n2.parallel = false;
    let adv = sched
        .declare_flow(&decl(vec![n1, n2]))
        .await
        .unwrap();
    assert_eq!(adv.started.len(), 1, "同波次 parallel=false 首轮只启动声明序第一个");
    assert_eq!(adv.started[0].node_id, "n1");
    assert_eq!(sched.node_state("n1"), Some(FlowNodeState::Running));
    assert_eq!(
        sched.node_state("n2"),
        Some(FlowNodeState::Pending),
        "前驱同级未完成（Running）不得启动"
    );
    assert_eq!(spawner.requests().len(), 1, "spawn1 先于终态事件");
    // n1 Completed → n2 启动（终态事件驱动推进，不轮询）
    let run_n1 = adv.started[0].subagent_run_id.clone();
    let adv2 = sched
        .on_subagent_terminal(&run_n1, SubagentState::Completed)
        .await
        .unwrap();
    assert_eq!(adv2.started.len(), 1);
    assert_eq!(adv2.started[0].node_id, "n2", "spawn2 在 terminal 事件后");
    assert_eq!(sched.node_state("n2"), Some(FlowNodeState::Running));
    assert_eq!(spawner.requests().len(), 2, "spawn 时序：n1 先、n2 在终态事件后");
    // n2 完成 → 编排终态
    let run_n2 = adv2.started[0].subagent_run_id.clone();
    let adv3 = sched
        .on_subagent_terminal(&run_n2, SubagentState::Completed)
        .await
        .unwrap();
    assert!(adv3.flow_terminal);
    assert!(adv3.started.is_empty());
    assert_eq!(spawner.requests().len(), 2, "全程只 spawn 两个节点");
}

#[tokio::test]
async fn parallel_siblings_spawn_concurrently() {
    let (mut sched, spawner, _meta) = harness();
    // 同波次 parallel=true 两节点：同一轮 advance 均进入 Running
    let adv = sched
        .declare_flow(&decl(vec![node("p1", &[]), node("p2", &[])]))
        .await
        .unwrap();
    let ids: Vec<&str> = adv.started.iter().map(|s| s.node_id.as_str()).collect();
    assert_eq!(ids, vec!["p1", "p2"], "同轮就绪集合含两节点（并行不受约束）");
    assert_eq!(sched.node_state("p1"), Some(FlowNodeState::Running));
    assert_eq!(sched.node_state("p2"), Some(FlowNodeState::Running));
    assert_eq!(spawner.requests().len(), 2);
}

#[tokio::test]
async fn serial_constraint_applies_per_wave_independently() {
    let (mut sched, spawner, _meta) = harness();
    // 两波次：波 1 = [a1, a2]（同 depends_on=[]，串行）；波 2 = [b1, b2]
    // （同 depends_on=[a1, a2]，串行）——异波次互不约束（混合场景）
    let mut a1 = node("a1", &[]);
    a1.parallel = false;
    let mut a2 = node("a2", &[]);
    a2.parallel = false;
    let mut b1 = node("b1", &["a1", "a2"]);
    b1.parallel = false;
    let mut b2 = node("b2", &["a1", "a2"]);
    b2.parallel = false;
    let adv = sched.declare_flow(&decl(vec![a1, a2, b1, b2])).await.unwrap();
    assert_eq!(adv.started.len(), 1);
    assert_eq!(adv.started[0].node_id, "a1", "波 1 串行首节点");
    assert_eq!(sched.node_state("a2"), Some(FlowNodeState::Pending));
    let run_a1 = adv.started[0].subagent_run_id.clone();
    let adv2 = sched
        .on_subagent_terminal(&run_a1, SubagentState::Completed)
        .await
        .unwrap();
    assert_eq!(adv2.started.len(), 1);
    assert_eq!(adv2.started[0].node_id, "a2", "波 1 串行第二步");
    let run_a2 = adv2.started[0].subagent_run_id.clone();
    let adv3 = sched
        .on_subagent_terminal(&run_a2, SubagentState::Completed)
        .await
        .unwrap();
    assert_eq!(adv3.started.len(), 1);
    assert_eq!(adv3.started[0].node_id, "b1", "波 2 首节点（依赖满足后）");
    assert_eq!(sched.node_state("b2"), Some(FlowNodeState::Pending), "波 2 内串行");
    let run_b1 = adv3.started[0].subagent_run_id.clone();
    let adv4 = sched
        .on_subagent_terminal(&run_b1, SubagentState::Completed)
        .await
        .unwrap();
    assert_eq!(adv4.started.len(), 1);
    assert_eq!(adv4.started[0].node_id, "b2", "波 2 串行第二步");
    let run_b2 = adv4.started[0].subagent_run_id.clone();
    let adv5 = sched
        .on_subagent_terminal(&run_b2, SubagentState::Completed)
        .await
        .unwrap();
    assert!(adv5.flow_terminal);
    assert_eq!(spawner.requests().len(), 4, "两波次各串行两步");
}

#[tokio::test]
async fn serial_siblings_do_not_deadlock_with_budget_one() {
    let (mut sched, spawner, meta) = harness();
    // 预算 1（maxSiblings=0：首个 spawn 时 current=0 通过，此后 current>0 拒绝）；
    // 同波次含 parallel=false 串行对 + 一个 parallel=true 节点竞争槽位
    meta.set_meta(FLOW_MAX_SIBLINGS_KEY, "0").unwrap();
    let mut n1 = node("n1", &[]);
    n1.parallel = false;
    let mut n2 = node("n2", &[]);
    n2.parallel = false;
    let adv = sched
        .declare_flow(&decl(vec![n1, n2, node("p3", &[])]))
        .await
        .unwrap();
    assert_eq!(adv.started.len(), 1, "预算 1：同一时刻只 spawn 一个节点");
    assert_eq!(adv.started[0].node_id, "n1", "声明序靠前且就绪者先 spawn");
    assert_eq!(sched.node_state("n2"), Some(FlowNodeState::Pending), "串行前驱未完成不启动");
    // 逐个终态事件推进：n2、p3 依次启动——预算不足只延迟、不永久阻塞
    let run_n1 = adv.started[0].subagent_run_id.clone();
    let adv2 = sched
        .on_subagent_terminal(&run_n1, SubagentState::Completed)
        .await
        .unwrap();
    assert_eq!(adv2.started.len(), 1);
    assert_eq!(adv2.started[0].node_id, "n2", "前驱完成后第二节点启动");
    let run_n2 = adv2.started[0].subagent_run_id.clone();
    let adv3 = sched
        .on_subagent_terminal(&run_n2, SubagentState::Completed)
        .await
        .unwrap();
    assert_eq!(adv3.started.len(), 1);
    assert_eq!(adv3.started[0].node_id, "p3", "并行节点随后补位");
    let run_p3 = adv3.started[0].subagent_run_id.clone();
    let adv4 = sched
        .on_subagent_terminal(&run_p3, SubagentState::Completed)
        .await
        .unwrap();
    assert!(adv4.flow_terminal, "预算不足不引入死锁（终态事件驱动推进）");
    assert_eq!(spawner.requests().len(), 3, "三个节点全部启动");
    assert_eq!(sched.budget_in_flight(), 0, "全部终态后预算归零");
}

// ── on_failed 三策略（04 C6 验收 3/4 + 任务卡 Skip/Block/Report）──

#[tokio::test]
async fn on_failed_skip_allows_dependents_without_report() {
    let (mut sched, spawner, _meta) = harness();
    let mut task_a = node("a", &[]);
    task_a.on_failed = Some(FailStrategy::Skip);
    let adv = sched
        .declare_flow(&decl(vec![task_a, node("b", &["a"])]))
        .await
        .unwrap();
    let run_a = adv.started[0].subagent_run_id.clone();
    let adv2 = sched
        .on_subagent_terminal(&run_a, SubagentState::Failed)
        .await
        .unwrap();
    assert_eq!(adv2.started.len(), 1, "Skip：后置照常启动");
    assert_eq!(adv2.started[0].node_id, "b");
    assert_eq!(sched.node_state("a"), Some(FlowNodeState::Failed));
    assert!(
        adv2
            .reports
            .iter()
            .all(|r| r.kind != FlowReportKind::NodeFailed),
        "Skip 策略不上报失败"
    );
    assert!(adv2.blocked.is_empty(), "Skip 不影响同级（不阻塞）");
    assert_eq!(spawner.requests().len(), 2);
}

#[tokio::test]
async fn on_failed_block_blocks_downstream_transitively_with_reports() {
    let (mut sched, spawner, _meta) = harness();
    // a → b → c；a 失败（节点未声明 → 会话默认 Block）
    let adv = sched
        .declare_flow(&decl(vec![node("a", &[]), node("b", &["a"]), node("c", &["b"])]))
        .await
        .unwrap();
    let run_a = adv.started[0].subagent_run_id.clone();
    let adv2 = sched
        .on_subagent_terminal(&run_a, SubagentState::Failed)
        .await
        .unwrap();
    assert!(adv2.started.is_empty(), "Block：后置不启动");
    assert!(adv2.blocked.contains(&"b".to_string()));
    assert!(adv2.blocked.contains(&"c".to_string()), "阻塞传递到 c");
    assert_eq!(sched.node_state("b"), Some(FlowNodeState::Blocked));
    assert_eq!(sched.node_state("c"), Some(FlowNodeState::Blocked));
    assert!(
        adv2
            .reports
            .iter()
            .any(|r| r.kind == FlowReportKind::NodeFailed && r.strategy == Some(FailStrategy::Block)),
        "Block 策略必须上报失败"
    );
    assert!(
        adv2.reports.iter().any(|r| r.kind == FlowReportKind::Blocked),
        "阻塞节点产生上报"
    );
    assert!(adv2.flow_terminal, "部分完成即编排终态（后续不启动）");
    assert_eq!(spawner.requests().len(), 1, "只 spawn 过 a，零多余 run");
}

#[tokio::test]
async fn on_failed_report_proceeds_and_records() {
    let (mut sched, _spawner, _meta) = harness();
    let mut task_a = node("a", &[]);
    task_a.on_failed = Some(FailStrategy::Report);
    let adv = sched
        .declare_flow(&decl(vec![task_a, node("b", &["a"])]))
        .await
        .unwrap();
    let run_a = adv.started[0].subagent_run_id.clone();
    let adv2 = sched
        .on_subagent_terminal(&run_a, SubagentState::Failed)
        .await
        .unwrap();
    assert_eq!(adv2.started.len(), 1, "Report：照常推进");
    assert_eq!(adv2.started[0].node_id, "b");
    assert!(
        adv2
            .reports
            .iter()
            .any(|r| r.kind == FlowReportKind::NodeFailed && r.strategy == Some(FailStrategy::Report)),
        "Report 策略必须记录上报"
    );
}

#[tokio::test]
async fn session_default_strategy_read_from_meta_key() {
    let (mut sched, _spawner, meta) = harness();
    // 会话级默认：flow_on_failed = report（节点级未声明时生效）
    meta.set_meta(FLOW_ON_FAILED_KEY, "report").unwrap();
    let adv = sched
        .declare_flow(&decl(vec![node("a", &[]), node("b", &["a"])]))
        .await
        .unwrap();
    let run_a = adv.started[0].subagent_run_id.clone();
    let adv2 = sched
        .on_subagent_terminal(&run_a, SubagentState::Failed)
        .await
        .unwrap();
    assert_eq!(adv2.started.len(), 1, "会话默认 report：后置照常启动");
    assert!(
        adv2.reports.iter().any(|r| r.kind == FlowReportKind::NodeFailed),
        "会话默认 report 产生上报记录"
    );
}

// ── 环检测（04 C6 验收 5：含环声明被拒且零 run）───────────────────

#[tokio::test]
async fn cycle_declaration_rejected_with_zero_runs() {
    let (mut sched, spawner, meta) = harness();
    let err = sched
        .declare_flow(&decl(vec![
            node("a", &["c"]),
            node("b", &["a"]),
            node("c", &["b"]),
        ]))
        .await
        .unwrap_err();
    assert!(
        matches!(err, FlowError::InvalidGraph(FlowGraphError::Cycle { .. })),
        "含环声明被拒：{err:?}"
    );
    assert!(spawner.requests().is_empty(), "含环声明零 run");
    assert!(
        meta.get_meta(FLOW_DECLARATION_KEY).unwrap().is_none(),
        "校验失败不得写库（原子回滚）"
    );
    assert_eq!(sched.node_state("a"), None, "无节点进入运行态");
}

#[tokio::test]
async fn second_declare_rejected_while_flow_active() {
    let (mut sched, spawner, _meta) = harness();
    sched
        .declare_flow(&decl(vec![node("a", &[]), node("b", &["a"])]))
        .await
        .unwrap();
    let err = sched
        .declare_flow(&decl(vec![node("x", &[])]))
        .await
        .unwrap_err();
    assert!(matches!(err, FlowError::AlreadyDeclared), "一轮一编排：{err:?}");
    assert_eq!(spawner.requests().len(), 1, "第二次声明零 run");
}

// ── 重启恢复（04 C6 验收 6 + 预算跨重启重算）──────────────────────

#[tokio::test]
async fn restart_recovers_incomplete_flow_without_restarting_completed() {
    let ws = TempWorkspace::new("flow_restart");
    let db = LocalDb::open(ws.path().join("sessions.db")).expect("打开测试库失败");
    db.insert_session("sess-main", "主会话").unwrap();
    let spawner = Arc::new(RecordingSpawner::with_db(db.clone(), "sess-main"));
    // LocalDb 直接实现 FlowMetaStore（生产路径同一实现）
    let meta = Arc::new(db.clone());
    let mut sched = FlowScheduler::new("sess-main", spawner.clone(), meta.clone()).unwrap();
    let adv = sched
        .declare_flow(&decl(vec![node("a", &[]), node("b", &["a"])]))
        .await
        .unwrap();
    let run_a = adv.started[0].subagent_run_id.clone();
    // a 完成（落库 completed + 终态事件）→ b 启动
    set_row_status(&db, "sess-main", &run_a, "completed");
    let adv2 = sched
        .on_subagent_terminal(&run_a, SubagentState::Completed)
        .await
        .unwrap();
    let run_b = adv2.started[0].subagent_run_id.clone();
    // 崩溃：b 运行中未完成，调度器实例丢弃
    drop(sched);
    let spawns_before = spawner.requests().len();
    // 重启：从库恢复（session_agents 行 → 节点状态重建）
    let rows = db.load_session_agents("sess-main").unwrap();
    let mut restored = FlowScheduler::load("sess-main", spawner.clone(), meta.clone(), &rows)
        .expect("重启恢复应成功");
    assert_eq!(
        restored.node_state("a"),
        Some(FlowNodeState::Completed),
        "已完成节点不重复启动"
    );
    assert_eq!(
        restored.node_state("b"),
        Some(FlowNodeState::Running),
        "未完成节点按图恢复为运行中"
    );
    let adv3 = restored.advance().await.unwrap();
    assert!(adv3.started.is_empty(), "b 已在运行，不重复启动");
    assert_eq!(spawner.requests().len(), spawns_before, "零重复 spawn");
    assert!(!adv3.flow_terminal);
    // 完成 b → 编排终态
    set_row_status(&db, "sess-main", &run_b, "completed");
    let adv4 = restored
        .on_subagent_terminal(&run_b, SubagentState::Completed)
        .await
        .unwrap();
    assert!(adv4.flow_terminal, "重启后未完成后置继续推进至终态");
    assert_eq!(spawner.requests().len(), spawns_before, "终态不产生新 run");
}

#[tokio::test]
async fn restart_resumes_ready_node_that_never_spawned() {
    let ws = TempWorkspace::new("flow_restart_ready");
    let db = LocalDb::open(ws.path().join("sessions.db")).expect("打开测试库失败");
    db.insert_session("sess-main", "主会话").unwrap();
    let spawner = Arc::new(RecordingSpawner::with_db(db.clone(), "sess-main"));
    let meta = Arc::new(db.clone());
    let mut sched = FlowScheduler::new("sess-main", spawner.clone(), meta.clone()).unwrap();
    let adv = sched
        .declare_flow(&decl(vec![node("a", &[]), node("b", &["a"])]))
        .await
        .unwrap();
    let run_a = adv.started[0].subagent_run_id.clone();
    // 崩溃窗口：a 已完成落库，但终态事件未达调度器（b 尚未 spawn）
    set_row_status(&db, "sess-main", &run_a, "completed");
    drop(sched);
    let rows = db.load_session_agents("sess-main").unwrap();
    let mut restored = FlowScheduler::load("sess-main", spawner.clone(), meta.clone(), &rows)
        .expect("重启恢复应成功");
    assert_eq!(restored.node_state("a"), Some(FlowNodeState::Completed));
    assert_eq!(restored.node_state("b"), Some(FlowNodeState::Pending));
    // 恢复后按图推进：未完成后置 b 补启动，已完成 a 不重复启动
    let adv2 = restored.advance().await.unwrap();
    assert_eq!(adv2.started.len(), 1);
    assert_eq!(adv2.started[0].node_id, "b", "未完成后置按图恢复启动");
    assert_eq!(spawner.requests().len(), 2, "a 不重复启动，b 补启动");
}

#[tokio::test]
async fn budget_recomputed_across_restart_from_active_runs() {
    let ws = TempWorkspace::new("flow_budget_restart");
    let db = LocalDb::open(ws.path().join("sessions.db")).expect("打开测试库失败");
    db.insert_session("sess-main", "主会话").unwrap();
    let spawner = Arc::new(RecordingSpawner::with_db(db.clone(), "sess-main"));
    let meta = Arc::new(db.clone());
    let mut sched = FlowScheduler::new("sess-main", spawner.clone(), meta.clone()).unwrap();
    let adv = sched
        .declare_flow(&decl(vec![node("a", &[]), node("b", &["a"])]))
        .await
        .unwrap();
    let run_a = adv.started[0].subagent_run_id.clone();
    set_row_status(&db, "sess-main", &run_a, "completed");
    sched
        .on_subagent_terminal(&run_a, SubagentState::Completed)
        .await
        .unwrap();
    // 崩溃时刻：a 已终态、b 运行中（预留未释放）
    drop(sched);
    let rows = db.load_session_agents("sess-main").unwrap();
    let restored = FlowScheduler::load("sess-main", spawner.clone(), meta.clone(), &rows).unwrap();
    // 重算：reserved = 活跃 + 已终态 = 2，released = 已终态 = 1，in_flight = 1
    let budget = restored.budget();
    assert_eq!(budget.in_flight(), 1, "活跃 run 保留预留");
    assert_eq!(budget.reserved(), 2);
    assert_eq!(budget.released(), 1);
    // 落库一致（防 double-charge：已完成任务不再占位）
    assert_eq!(meta.get_meta(FLOW_RESERVED_KEY).unwrap().as_deref(), Some("2"));
    assert_eq!(meta.get_meta(FLOW_RELEASED_KEY).unwrap().as_deref(), Some("1"));
}

// ── 合成唤醒（02 方案 M6 内容 7：不轮询 + planner 亲和）────────────

#[tokio::test]
async fn synthetic_wakeup_composite_observation_mode() {
    let (mut sched, spawner, meta) = harness();
    meta.set_meta(FLOW_AUTO_COMPOSITE_KEY, "false").unwrap();
    let mut gate = node("gate", &["a"]);
    gate.is_composite = true;
    let adv = sched
        .declare_flow(&decl(vec![node("a", &[]), gate]))
        .await
        .unwrap();
    assert_eq!(adv.started.len(), 1);
    let run_a = adv.started[0].subagent_run_id.clone();
    // gate 前置全部 completed → 唤醒事件随终态事件返回值带出（不轮询）
    let adv2 = sched
        .on_subagent_terminal(&run_a, SubagentState::Completed)
        .await
        .unwrap();
    assert_eq!(adv2.wakeups.len(), 1, "就绪即产唤醒事件（不轮询）");
    let wakeup = &adv2.wakeups[0];
    assert_eq!(wakeup.node_id, "gate");
    assert!(wakeup.is_composite);
    assert_eq!(
        wakeup.planner_run_id.as_deref(),
        Some("planner-1"),
        "综合 run 记录 planner_run_id 亲和"
    );
    assert!(!wakeup.auto_spawned, "观测态：只发事件不自动排队");
    assert!(adv2.started.is_empty(), "观测态不自动 spawn 综合 run");
    assert!(!adv2.flow_terminal, "综合节点待主 agent 行动");
    // 唤醒队列可消费（引擎侧经 L1 注入通知主 agent）
    assert_eq!(sched.take_wakeups(), vec![wakeup.clone()]);
    assert_eq!(sched.wakeup_count(), 0);
    // 主 agent 自行启动综合 run → 引擎挂接 → 完成 → 编排终态
    sched.attach_run("gate", "external-run-1").unwrap();
    assert_eq!(sched.node_state("gate"), Some(FlowNodeState::Running));
    let adv3 = sched
        .on_subagent_terminal("external-run-1", SubagentState::Completed)
        .await
        .unwrap();
    assert!(adv3.flow_terminal);
    assert_eq!(sched.node_state("gate"), Some(FlowNodeState::Completed));
    assert_eq!(spawner.requests().len(), 1, "综合 run 由主 agent 启动，调度器不 spawn");
}

#[tokio::test]
async fn synthetic_wakeup_composite_auto_spawns_consuming_budget() {
    let (mut sched, _spawner, _meta) = harness();
    // 默认 auto_spawn_composite=true：就绪即自动排队（消耗并发预算）
    let mut gate = node("gate", &["a"]);
    gate.is_composite = true;
    let adv = sched
        .declare_flow(&decl(vec![node("a", &[]), gate]))
        .await
        .unwrap();
    let run_a = adv.started[0].subagent_run_id.clone();
    let adv2 = sched
        .on_subagent_terminal(&run_a, SubagentState::Completed)
        .await
        .unwrap();
    assert_eq!(adv2.started.len(), 1);
    assert_eq!(adv2.started[0].node_id, "gate");
    assert!(adv2.started[0].is_composite);
    assert_eq!(sched.budget_in_flight(), 1, "综合 run 消耗并发预算");
    assert_eq!(adv2.wakeups.len(), 1, "唤醒事件仍产出");
    assert!(adv2.wakeups[0].auto_spawned, "自动排队标记");
    assert_eq!(adv2.wakeups[0].planner_run_id.as_deref(), Some("planner-1"));
    let run_gate = adv2.started[0].subagent_run_id.clone();
    let adv3 = sched
        .on_subagent_terminal(&run_gate, SubagentState::Completed)
        .await
        .unwrap();
    assert!(adv3.flow_terminal);
}

#[tokio::test]
async fn attach_run_requires_all_prerequisites_completed() {
    let (mut sched, _spawner, meta) = harness();
    meta.set_meta(FLOW_AUTO_COMPOSITE_KEY, "false").unwrap();
    let mut gate = node("gate", &["a"]);
    gate.is_composite = true;
    let adv = sched
        .declare_flow(&decl(vec![node("a", &[]), gate]))
        .await
        .unwrap();
    let run_a = adv.started[0].subagent_run_id.clone();
    // gate 强制对挂接同样生效：前置 running（非 completed）→ 挂接被拒
    let err = sched.attach_run("gate", "ext-1").unwrap_err();
    assert!(matches!(err, FlowError::InvalidState { .. }));
    // 非综合节点不可挂接外部 run
    let err2 = sched.attach_run("a", "ext-2").unwrap_err();
    assert!(matches!(err2, FlowError::InvalidState { .. }));
    // 前置完成 → 挂接成功
    sched
        .on_subagent_terminal(&run_a, SubagentState::Completed)
        .await
        .unwrap();
    sched.attach_run("gate", "ext-1").unwrap();
    // 重复挂接被拒
    let err3 = sched.attach_run("gate", "ext-3").unwrap_err();
    assert!(matches!(err3, FlowError::InvalidState { .. }));
}

#[tokio::test]
async fn attach_run_rejected_when_budget_full() {
    let (mut sched, _spawner, meta) = harness();
    meta.set_meta(FLOW_AUTO_COMPOSITE_KEY, "false").unwrap();
    // 17 个并行普通节点 + 1 个综合节点（全部无前置 → gate 立即就绪）
    let mut tasks: Vec<FlowNode> = (0..17).map(|i| node(&format!("n{i}"), &[])).collect();
    let mut gate = node("gate", &[]);
    gate.is_composite = true;
    tasks.push(gate);
    let adv = sched.declare_flow(&decl(tasks)).await.unwrap();
    assert_eq!(adv.started.len(), 17, "普通节点占满预算");
    assert_eq!(adv.wakeups.len(), 1, "gate 就绪唤醒");
    // 预算满（in_flight=17，maxSiblings=16）：挂接外部 run 被拒（复用
    // RecursionGuard 判定，错误携带超限类别）
    let err = sched.attach_run("gate", "ext-1").unwrap_err();
    assert!(
        matches!(err, FlowError::BudgetExceeded { kind, current: 17, max: 16 } if matches!(kind, orchestrator::flow_graph::BudgetExceededKind::Siblings)),
        "预算满挂接被拒：{err:?}"
    );
    // 完成一个普通节点 → 槽位释放 → 挂接成功
    let first_run = adv.started[0].subagent_run_id.clone();
    sched
        .on_subagent_terminal(&first_run, SubagentState::Completed)
        .await
        .unwrap();
    sched.attach_run("gate", "ext-1").unwrap();
    assert_eq!(sched.node_state("gate"), Some(FlowNodeState::Running));
}

#[tokio::test]
async fn declare_after_flow_terminal_allows_new_round() {
    let (mut sched, spawner, _meta) = harness();
    // 第一轮：a 完成 → 编排终态
    let adv = sched.declare_flow(&decl(vec![node("a", &[])])).await.unwrap();
    let run_a = adv.started[0].subagent_run_id.clone();
    sched
        .on_subagent_terminal(&run_a, SubagentState::Completed)
        .await
        .unwrap();
    assert!(sched.flow_terminal());
    // 第二轮：旧编排全终态 → 允许替换声明（新一轮编排，预算归零）
    let adv2 = sched
        .declare_flow(&decl(vec![node("x", &[]), node("y", &["x"])]))
        .await
        .unwrap();
    assert_eq!(adv2.started.len(), 1);
    assert_eq!(adv2.started[0].node_id, "x");
    assert_eq!(sched.node_state("y"), Some(FlowNodeState::Pending));
    assert_eq!(sched.budget_in_flight(), 1, "新一轮预算从零起算");
    assert_eq!(spawner.requests().len(), 2, "新一轮只 spawn 新节点");
}

// ── 边界与失败路径 ────────────────────────────────────────────────

#[tokio::test]
async fn spawn_failure_marks_node_failed_and_blocks_downstream() {
    let (mut sched, spawner, _meta) = harness();
    spawner.fail_next_spawn();
    let adv = sched
        .declare_flow(&decl(vec![node("a", &[]), node("b", &["a"])]))
        .await
        .unwrap();
    // a spawn 失败 → Failed；a 默认 Block → b 阻塞；编排终态（同一调用内收敛）
    assert_eq!(sched.node_state("a"), Some(FlowNodeState::Failed));
    assert_eq!(sched.node_state("b"), Some(FlowNodeState::Blocked));
    assert!(
        adv.reports.iter().any(|r| r.kind == FlowReportKind::SpawnFailed),
        "spawn 失败必须上报"
    );
    assert!(adv.flow_terminal);
    assert_eq!(sched.budget_in_flight(), 0, "spawn 失败释放预留");
    assert_eq!(spawner.requests().len(), 1);
}

#[tokio::test]
async fn terminal_event_for_unknown_run_rejected() {
    let (mut sched, _spawner, _meta) = harness();
    sched
        .declare_flow(&decl(vec![node("a", &[])]))
        .await
        .unwrap();
    let err = sched
        .on_subagent_terminal("no-such-run", SubagentState::Completed)
        .await
        .unwrap_err();
    assert!(matches!(err, FlowError::UnknownRun { .. }), "{err:?}");
}

#[tokio::test]
async fn duplicate_terminal_event_is_idempotent() {
    let (mut sched, _spawner, _meta) = harness();
    let adv = sched.declare_flow(&decl(vec![node("a", &[])])).await.unwrap();
    let run_a = adv.started[0].subagent_run_id.clone();
    let adv1 = sched
        .on_subagent_terminal(&run_a, SubagentState::Completed)
        .await
        .unwrap();
    assert!(adv1.flow_terminal);
    assert_eq!(sched.budget_in_flight(), 0);
    // 重复终态通知：幂等忽略（不重复 release / 不上报 / 不推进）
    let adv2 = sched
        .on_subagent_terminal(&run_a, SubagentState::Completed)
        .await
        .unwrap();
    assert!(adv2.flow_terminal);
    assert!(adv2.started.is_empty() && adv2.reports.is_empty());
    assert_eq!(sched.budget_in_flight(), 0, "重复终态不得重复释放");
}

#[tokio::test]
async fn load_without_declaration_reports_not_found() {
    let ws = TempWorkspace::new("flow_no_decl");
    let db = LocalDb::open(ws.path().join("sessions.db")).expect("打开测试库失败");
    let meta = Arc::new(db.clone());
    let spawner = Arc::new(RecordingSpawner::new());
    let err = match FlowScheduler::load("sess-empty", spawner, meta, &[]) {
        Ok(_) => panic!("无声明 load 必须失败"),
        Err(err) => err,
    };
    assert!(matches!(err, FlowError::NotFound { .. }), "{err:?}");
}

// ── M14（I7 事件源补齐）：子代理域事件发射点（唯一发射方接线）────

/// spawn 成功 → subagent-started 恰一次；收口 → subagent-ended 恰一次；
/// 终态通知幂等（重复通知不重复发射）；信封字段对齐前端契约。
#[tokio::test]
async fn subagent_events_emitted_once_on_spawn_and_terminal() {
    use conex_types::events::AgentEvent;
    use orchestrator::persist::{InMemoryStore, Store};
    use orchestrator::subagent_events::SubagentEventEmitter;

    let mem = Arc::new(InMemoryStore::new());
    let store: Arc<dyn Store> = mem.clone();
    let emitter = SubagentEventEmitter::new(store);
    let spawner = Arc::new(RecordingSpawner::new());
    let meta = Arc::new(InMemoryMeta::new());
    let mut sched = FlowScheduler::new("sess-a", spawner.clone(), meta.clone())
        .expect("调度器创建失败")
        .with_subagent_event_emitter(emitter);

    let adv = sched
        .declare_flow(&decl(vec![node("a", &[]), node("b", &["a"])]))
        .await
        .expect("DAG 声明应接受");
    assert_eq!(adv.started.len(), 1);

    // spawn 后：subagent-started 恰一次落库（Critical 必达）
    let stored = mem.events();
    assert_eq!(stored.len(), 1, "spawn 只产生一条事件");
    assert_eq!(stored[0].event_type, "subagent-started");
    let parsed: AgentEvent = serde_json::from_str(&stored[0].payload).expect("信封 JSON 可解析");
    match parsed {
        AgentEvent::SubagentStarted {
            subagent_run_id,
            description,
            mode,
            ..
        } => {
            assert_eq!(
                subagent_run_id,
                adv.started[0].subagent_run_id,
                "信封 subagentRunId = spawn 结果 run id"
            );
            // flow 节点 spawn 不携带 description/mode（M2 契约可选字段）
            assert_eq!(description.as_deref(), None);
            assert_eq!(mode.as_deref(), None);
        }
        other => panic!("期望 subagent-started：{other:?}"),
    }

    // 收口 → subagent-ended 恰一次；推进同时 spawn B → started(B) 恰一次
    let run_a = adv.started[0].subagent_run_id.clone();
    let adv2 = sched
        .on_subagent_terminal(&run_a, SubagentState::Completed)
        .await
        .unwrap();
    assert_eq!(adv2.started.len(), 1, "A completed 后 B 启动");
    let stored = mem.events();
    let types: Vec<&str> = stored.iter().map(|e| e.event_type.as_str()).collect();
    assert_eq!(
        types,
        vec![
            "subagent-started",
            "subagent-ended",
            "subagent-started",
        ],
        "事件流：started(A) → ended(A) → started(B)，各恰一次"
    );
    let parsed: AgentEvent = serde_json::from_str(&stored[1].payload).expect("信封 JSON 可解析");
    match parsed {
        AgentEvent::SubagentEnded {
            subagent_run_id,
            status,
            ..
        } => {
            assert_eq!(subagent_run_id, run_a);
            assert_eq!(status, conex_types::events::SubagentEndStatus::Completed);
        }
        other => panic!("期望 subagent-ended：{other:?}"),
    }

    // 终态通知幂等：重复通知不重复发射 ended（事件源唯一性）
    let _ = sched
        .on_subagent_terminal(&run_a, SubagentState::Completed)
        .await
        .unwrap();
    assert_eq!(
        mem.events()
            .iter()
            .filter(|e| e.event_type == "subagent-ended")
            .count(),
        1,
        "重复终态通知不得重复发射 ended"
    );

    // B 收口：ended(B) 恰一次，编排终态
    let run_b = adv2.started[0].subagent_run_id.clone();
    let adv3 = sched
        .on_subagent_terminal(&run_b, SubagentState::Completed)
        .await
        .unwrap();
    assert!(adv3.flow_terminal);
    let stored = mem.events();
    assert_eq!(
        stored
            .iter()
            .filter(|e| e.event_type == "subagent-started")
            .count(),
        2,
        "两个节点各 started 一次"
    );
    assert_eq!(
        stored
            .iter()
            .filter(|e| e.event_type == "subagent-ended")
            .count(),
        2,
        "两个节点各 ended 一次"
    );
    assert_eq!(stored.len(), 4, "全链路事件总数 = 2 started + 2 ended");
}

/// 未挂载发射器时编排不产生子代理事件（纯逻辑域零事件，可选接线语义）
#[tokio::test]
async fn without_emitter_no_subagent_events() {
    use orchestrator::persist::InMemoryStore;

    let mem = Arc::new(InMemoryStore::new());
    let spawner = Arc::new(RecordingSpawner::new());
    let meta = Arc::new(InMemoryMeta::new());
    let mut sched =
        FlowScheduler::new("sess-a", spawner.clone(), meta.clone()).expect("调度器创建失败");

    let adv = sched.declare_flow(&decl(vec![node("a", &[])])).await.unwrap();
    let run_a = adv.started[0].subagent_run_id.clone();
    let _ = sched
        .on_subagent_terminal(&run_a, SubagentState::Completed)
        .await
        .unwrap();
    assert!(mem.events().is_empty(), "未挂载发射器不得产生任何事件");
}

// ── LK-02 flow 路径链路键定案（parent_tool_call_id 恒 None）───────

/// LK-02 S5 测钉：flow 路径 spawn 请求 parent_tool_call_id 恒 None——
/// 链路键 = flow_node_id（调度驱动无父工具调用，语义正确非欠接线，
/// 禁止虚构 id 填充）
#[tokio::test]
async fn flow_spawn_request_parent_tool_call_id_none() {
    let (mut sched, spawner, _meta) = harness();
    sched
        .declare_flow(&decl(vec![node("a", &[])]))
        .await
        .expect("DAG 声明应接受");
    let requests = spawner.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].flow_node_id.as_deref(),
        Some("a"),
        "flow 路径链路键 = flow_node_id"
    );
    assert!(
        requests[0].parent_tool_call_id.is_none(),
        "flow 路径 parent_tool_call_id 恒 None（语义正确非欠接线）"
    );
}
