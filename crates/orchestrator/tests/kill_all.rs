//! T-D-09：kill_all 批量终止 + resume_subagent 显式恢复（orchestrator 域
//! 集成测试，真实 SQLite 落库路径）
//!
//! - kill_all：spawn 3 个 running 子代理 → kill_all → 全部 failed、产出
//!   保留、FlowScheduler 无残留节点；过滤面（非 running / 其它父会话
//!   不动）；投递失败 → 未终态汇总；
//! - resume_subagent：kill 后 resume → fork 新 run、三态判定正确、预算
//!   消费记账（与恢复阶梯共用 Episode 预算池）、prompt 覆盖、结构化错误。

// G2 禁令豁免：测试临时目录清理（非产品删除路径，可恢复语义不适用）。
#![allow(clippy::disallowed_methods)]

use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use agent_tools::tools::subagent::{
    SubagentSpawnError, SubagentSpawnRequest, SubagentSpawnResult, SubagentSpawner,
    SubagentState,
};
use async_trait::async_trait;
use conex_db::LocalDb;
use conex_types::error::ProviderErrorKind;
use conex_types::{SessionAgent, SessionMessage};
use orchestrator::flow_graph::{FlowDeclaration, FlowNode, FlowNodeState, FlowScheduler};
use orchestrator::lifecycle::{LifecycleError, ResumeOutcome, SubagentLifecycleService};
use orchestrator::recovery::{
    fingerprint, ForkContextMode, RecoveryCoordinator, RecoveryError, RecoveryLadder,
    RecoveryRetryPolicy, RecoveryStore, RunFailureContext,
};
use orchestrator::session::SessionTree;
use orchestrator::steering_queue::PendingMessageQueue;

use common::RecordingCancelSink;

mod common;

// ── 测试替身 ──────────────────────────────────────────────────────

/// 落库 spawner：写 session_agents 行（每条带一条 user 产出消息，供
/// 「产出保留」断言）+ 记录 spawn 请求
struct DbSpawner {
    db: LocalDb,
    session_id: String,
    requests: Mutex<Vec<SubagentSpawnRequest>>,
    seq: AtomicUsize,
    run_seq: AtomicUsize,
}

impl DbSpawner {
    fn with_db(db: LocalDb, session_id: &str) -> Arc<Self> {
        Arc::new(Self {
            db,
            session_id: session_id.to_string(),
            requests: Mutex::new(Vec::new()),
            // agent_id 从 1000 起号：避免与测试预置行（sub-1/sub-2 等）的
            // agent_id 撞主键 (session_id, agent_id)；run id 独立计数
            seq: AtomicUsize::new(1000),
            run_seq: AtomicUsize::new(0),
        })
    }

    fn requests(&self) -> Vec<SubagentSpawnRequest> {
        self.requests.lock().unwrap().clone()
    }
}

impl std::fmt::Debug for DbSpawner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DbSpawner").finish_non_exhaustive()
    }
}

#[async_trait]
impl SubagentSpawner for DbSpawner {
    async fn spawn(
        &self,
        req: &SubagentSpawnRequest,
    ) -> Result<SubagentSpawnResult, SubagentSpawnError> {
        self.requests.lock().unwrap().push(req.clone());
        let n = self.seq.fetch_add(1, Ordering::SeqCst);
        let m = self.run_seq.fetch_add(1, Ordering::SeqCst);
        let run_id = format!("spawn-run-{m}");
        let subagent_id = format!("sub-{n}");
        let now = now_ms();
        let mut agents = self
            .db
            .load_session_agents(&self.session_id)
            .map_err(|e| SubagentSpawnError::PersistFailed(e.to_string()))?;
        agents.push(SessionAgent {
            id: subagent_id.clone(),
            subagent_run_id: run_id.clone(),
            parent_session_id: self.session_id.clone(),
            parent_run_id: req.parent_run_id.clone().unwrap_or_default(),
            parent_tool_call_id: req.parent_tool_call_id.clone(),
            description: req.flow_node_id.clone().unwrap_or_else(|| "直调".to_string()),
            mode: String::new(),
            status: "running".to_string(),
            summary: None,
            // 产出保留断言数据源：每行一条 user 消息（任务 prompt 落库形态）
            messages: vec![SessionMessage {
                id: format!("m-{n}"),
                sender: "user".to_string(),
                text: Some(format!("任务产出 {n}")),
                thinking: None,
                timestamp: now,
                status: None,
                stream_text_offset: None,
                thinking_time: None,
                tool_calls_json: None,
                blocks_json: None,
                tool_call_results_json: None,
                usage: None,
            }],
            started_at: now,
            ended_at: None,
            depth: Some(1),
            subagent_path_json: None,
            // T-D-07 v6 新列：测试域 spawner 透传请求字段
            task_type: req.task_type.map(|t| t.as_str().to_string()),
            display_label: req.display_label.clone(),
            allowed_write_paths_json: req.allowed_write_paths.as_ref().map(|paths| {
                serde_json::to_string(paths).expect("路径白名单序列化不应失败")
            }),
        });
        self.db
            .save_session_agents(&self.session_id, &agents)
            .map_err(|e| SubagentSpawnError::PersistFailed(e.to_string()))?;
        Ok(SubagentSpawnResult {
            subagent_id,
            subagent_run_id: run_id,
            session_id: format!("sess-{n}"),
            status: SubagentState::Running,
            summary: None,
            flow_node_id: req.flow_node_id.clone(),
            display_label: req.display_label.clone(),
        })
    }
}

/// 依赖图节点构造（并行全开，无依赖）
fn flow_node(id: &str) -> FlowNode {
    FlowNode {
        id: id.to_string(),
        task: format!("任务 {id}"),
        depends_on: Vec::new(),
        parallel: true,
        on_failed: None,
        is_composite: false,
    }
}

/// 当前 UTC 毫秒
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// user 消息构造
fn user_msg(text: &str) -> SessionMessage {
    SessionMessage {
        id: format!("msg-user-{}", text.len()),
        sender: "user".to_string(),
        text: Some(text.to_string()),
        thinking: None,
        timestamp: now_ms(),
        status: None,
        stream_text_offset: None,
        thinking_time: None,
        tool_calls_json: None,
        blocks_json: None,
        tool_call_results_json: None,
        usage: None,
    }
}

/// assistant 消息构造（撑会话窗口字节数用）
fn assistant_msg(text: &str) -> SessionMessage {
    SessionMessage {
        id: format!("msg-assistant-{}", text.len()),
        sender: "assistant".to_string(),
        text: Some(text.to_string()),
        thinking: None,
        timestamp: now_ms(),
        status: None,
        stream_text_offset: None,
        thinking_time: None,
        tool_calls_json: None,
        blocks_json: None,
        tool_call_results_json: None,
        usage: None,
    }
}

/// 子代理行构造（工作流路径可选；parent_session_id 显式给定）
fn agent_row(
    id: &str,
    run_id: &str,
    status: &str,
    started_at: i64,
    parent_session_id: &str,
    path: Option<&str>,
    messages: Vec<SessionMessage>,
) -> SessionAgent {
    SessionAgent {
        id: id.to_string(),
        subagent_run_id: run_id.to_string(),
        parent_session_id: parent_session_id.to_string(),
        parent_run_id: "planner-1".to_string(),
        parent_tool_call_id: None,
        description: String::new(),
        mode: String::new(),
        status: status.to_string(),
        summary: None,
        messages,
        started_at,
        ended_at: if status == "failed" {
            Some(started_at + 10_000)
        } else {
            None
        },
        depth: Some(1),
        subagent_path_json: path.map(str::to_string),
        task_type: None,
        display_label: None,
        allowed_write_paths_json: None,
    }
}

/// 会话的恢复协调器环境（LocalDb 作 RecoveryStore + 会话树含
/// leaf-root → leaf-1 + 落库 spawner）
struct ResumeEnv {
    db: LocalDb,
    spawner: Arc<DbSpawner>,
    coordinator: RecoveryCoordinator,
}

fn resume_env(session_id: &str) -> ResumeEnv {
    let db = LocalDb::open_in_memory().unwrap();
    db.insert_session(session_id, "主会话").unwrap();
    let spawner = DbSpawner::with_db(db.clone(), session_id);
    let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
    let tree = Arc::new(Mutex::new(SessionTree::new(session_id)));
    tree.lock()
        .unwrap()
        .append("leaf-root", serde_json::json!({ "text": "root" }))
        .unwrap();
    tree.lock()
        .unwrap()
        .append("leaf-1", serde_json::json!({ "text": "子代理" }))
        .unwrap();
    let coordinator = RecoveryCoordinator::new(
        session_id,
        Arc::new(db.clone()),
        queue,
        tree,
        spawner.clone(),
        RecoveryRetryPolicy {
            max_retries: 5,
            ..RecoveryRetryPolicy::default()
        },
    )
    .expect("协调器构造失败");
    ResumeEnv { db, spawner, coordinator }
}

/// 服务构造（投递替身默认成功）
fn service(env: &ResumeEnv, sink: &Arc<RecordingCancelSink>) -> SubagentLifecycleService {
    SubagentLifecycleService::new(Arc::new(env.db.clone()), sink.clone())
}

// ── kill_all ─────────────────────────────────────────────────────

/// 主场景：spawn 3 个 running 子代理（流程节点）→ kill_all → 全部 failed、
/// 产出保留、FlowScheduler 无残留节点
#[tokio::test]
async fn kill_all_terminates_running_and_flow_has_no_residual() {
    let session_id = "s-killall";
    let db = Arc::new(LocalDb::open_in_memory().unwrap());
    db.insert_session(session_id, "主会话").unwrap();
    let spawner = DbSpawner::with_db(db.as_ref().clone(), session_id);
    let mut sched =
        FlowScheduler::new(session_id, spawner.clone(), db.clone()).expect("调度器创建失败");
    let adv = sched
        .declare_flow(&FlowDeclaration {
            tasks: vec![flow_node("a"), flow_node("b"), flow_node("c")],
            planner_run_id: Some("planner-1".to_string()),
        })
        .await
        .expect("依赖图声明必须成功");
    assert_eq!(adv.started.len(), 3, "三个并行节点全部启动");
    let run_ids: Vec<String> = adv
        .started
        .iter()
        .map(|s| s.subagent_run_id.clone())
        .collect();
    assert_eq!(sched.budget_in_flight(), 3);

    // kill_all：批量终止全部 running 子代理
    let sink = RecordingCancelSink::new(true);
    let service = SubagentLifecycleService::new(db.clone(), sink.clone());
    let outcome = service.kill_all(session_id, "kill_all").unwrap();
    assert_eq!(outcome.terminated.len(), 3, "终止列表 = 3 个 running 子代理");
    assert!(outcome.non_terminal.is_empty(), "无未终态汇总");
    let terminated: HashSet<&str> = outcome
        .terminated
        .iter()
        .map(|e| e.subagent_id.as_str())
        .collect();
    assert_eq!(terminated.len(), 3);

    // L3 强停逐个投递（control.rs 队列面复用；reason 信封统一）
    let calls = sink.calls();
    assert_eq!(calls.len(), 3);
    assert!(calls.iter().all(|(_, r)| r == "kill_all"));
    let delivered: HashSet<&str> = calls.iter().map(|(run, _)| run.as_str()).collect();
    let expected: HashSet<&str> = run_ids.iter().map(|s| s.as_str()).collect();
    assert_eq!(delivered, expected, "全部运行中 run 收到 L3 强停");

    // 终态统一归一 failed + 产出保留（消息级联仍在）
    let rows = db.load_session_agents(session_id).unwrap();
    assert_eq!(rows.len(), 3);
    assert!(
        rows.iter().all(|a| a.status == "failed"),
        "kill_all 后全会话 running 清零（终态 failed）"
    );
    assert!(rows.iter().all(|a| a.ended_at.is_some()), "ended_at 落库");
    assert!(
        rows.iter().all(|a| !a.messages.is_empty()),
        "产出保留：session_agent_messages 级联保留"
    );

    // FlowScheduler：终态事件自然触发 on_subagent_terminal 推进，无残留节点
    for run_id in &run_ids {
        sched
            .on_subagent_terminal(run_id, SubagentState::Failed)
            .await
            .expect("终态回传推进必须成功");
    }
    assert!(sched.flow_terminal(), "编排全终态（无残留节点）");
    for node in ["a", "b", "c"] {
        assert_eq!(
            sched.node_state(node),
            Some(FlowNodeState::Failed),
            "节点 {node} 终态"
        );
    }
    assert_eq!(sched.budget_in_flight(), 0, "终态后预算归零");
    assert_eq!(spawner.requests().len(), 3, "无残留推进（不重复 spawn）");
}

/// 过滤面：非 running 行与其它父会话的行不受影响
#[tokio::test]
async fn kill_all_filters_non_running_and_other_parents() {
    let session_id = "s-filter";
    let db = Arc::new(LocalDb::open_in_memory().unwrap());
    db.insert_session(session_id, "主会话").unwrap();
    let now = now_ms();
    let rows = vec![
        // 命中：running + 父会话 = 主会话
        agent_row(
            "sub-1", "run-1", "running", now, session_id, None, vec![user_msg("产出 1")],
        ),
        // 状态不符：completed 不终止
        agent_row(
            "sub-2", "run-2", "completed", now, session_id, None, vec![],
        ),
        // 父会话不符：其它父会话的 run 不动
        agent_row(
            "sub-3", "run-3", "running", now, "other-session", None, vec![],
        ),
    ];
    db.save_session_agents(session_id, &rows).unwrap();

    let sink = RecordingCancelSink::new(true);
    let service = SubagentLifecycleService::new(db.clone(), sink.clone());
    let outcome = service.kill_all(session_id, "kill_all").unwrap();
    assert_eq!(outcome.terminated.len(), 1);
    assert_eq!(outcome.terminated[0].subagent_id, "sub-1");
    assert_eq!(sink.calls().len(), 1, "只投递命中行");

    let rows = db.load_session_agents(session_id).unwrap();
    let by_id = |id: &str| rows.iter().find(|a| a.id == id).unwrap();
    assert_eq!(by_id("sub-1").status, "failed");
    assert_eq!(by_id("sub-2").status, "completed", "非 running 行不受影响");
    assert_eq!(by_id("sub-3").status, "running", "其它父会话行不受影响");
}

/// 未终态汇总：L3 未投递（引擎无运行实例）→ 行仍归一 failed，但报表带出
#[tokio::test]
async fn kill_all_reports_undelivered_as_non_terminal() {
    let session_id = "s-undelivered";
    let db = Arc::new(LocalDb::open_in_memory().unwrap());
    db.insert_session(session_id, "主会话").unwrap();
    let now = now_ms();
    let rows = vec![
        agent_row(
            "sub-1", "run-1", "running", now, session_id, None, vec![user_msg("产出 1")],
        ),
        agent_row(
            "sub-2", "run-2", "running", now, session_id, None, vec![user_msg("产出 2")],
        ),
    ];
    db.save_session_agents(session_id, &rows).unwrap();

    // 投递替身：引擎无运行实例（投递失败）
    let sink = RecordingCancelSink::new(false);
    let service = SubagentLifecycleService::new(db.clone(), sink.clone());
    let outcome = service.kill_all(session_id, "kill_all").unwrap();
    assert!(outcome.terminated.is_empty(), "投递失败不计入 terminated");
    assert_eq!(outcome.non_terminal.len(), 2, "未终态汇总 = 2 条");
    assert!(
        outcome.non_terminal[0].reason.contains("未投递"),
        "未终态带结构化原因：{}",
        outcome.non_terminal[0].reason
    );
    // 行仍归一 failed（服务侧收口，不依赖引擎回写）
    let rows = db.load_session_agents(session_id).unwrap();
    assert!(
        rows.iter().all(|a| a.status == "failed"),
        "行已归一 failed（投递失败不影响状态收口）"
    );
}

/// L3 强停投递替身：投递时同步插入一条新的 running 行（模拟引擎在
/// kill_all 查询面之后、写面前并发 spawn 落库——11-T3 竞态回归面）
struct SpawnDuringCancelSink {
    db: LocalDb,
    session_id: String,
    insert_run_id: String,
}

impl SpawnDuringCancelSink {
    fn new(db: LocalDb, session_id: &str, insert_run_id: &str) -> Arc<Self> {
        Arc::new(Self {
            db,
            session_id: session_id.to_string(),
            insert_run_id: insert_run_id.to_string(),
        })
    }
}

impl orchestrator::lifecycle::ForceCancelSink for SpawnDuringCancelSink {
    fn request_force_cancel(&self, _subagent_run_id: &str, _reason: &str) -> bool {
        // 并发 spawn 落库面 = 单行 upsert（与迁移后的 spawner 同面）
        let row = SessionAgent {
            id: "sub-race".to_string(),
            subagent_run_id: self.insert_run_id.clone(),
            parent_session_id: self.session_id.clone(),
            parent_run_id: "planner-1".to_string(),
            parent_tool_call_id: None,
            description: "竞态行".to_string(),
            mode: String::new(),
            status: "running".to_string(),
            summary: None,
            messages: vec![user_msg("竞态产出")],
            started_at: now_ms(),
            ended_at: None,
            depth: Some(1),
            subagent_path_json: None,
            task_type: None,
            display_label: None,
            allowed_write_paths_json: None,
        };
        self.db.upsert_session_agent(&row).unwrap();
        true
    }
}

/// 竞态回归（11-T3）：kill_all 写面期间并发 spawn 的行不丢失——
/// 旧全量先删后插会把查询面之后新增的行整批删除；单行定点写下保留
#[tokio::test]
async fn kill_all_preserves_row_spawned_during_kill() {
    let session_id = "s-race";
    let db = Arc::new(LocalDb::open_in_memory().unwrap());
    db.insert_session(session_id, "主会话").unwrap();
    let now = now_ms();
    let rows = vec![
        agent_row(
            "sub-1", "run-1", "running", now, session_id, None, vec![user_msg("产出 1")],
        ),
        agent_row(
            "sub-2", "run-2", "running", now, session_id, None, vec![user_msg("产出 2")],
        ),
    ];
    db.save_session_agents(session_id, &rows).unwrap();

    // 投递发生在 kill_all 查询面之后、写面前 → 模拟「kill 中 spawn」
    let sink = SpawnDuringCancelSink::new(db.as_ref().clone(), session_id, "run-race");
    let service = SubagentLifecycleService::new(db.clone(), sink.clone());
    let outcome = service.kill_all(session_id, "kill_all").unwrap();
    assert_eq!(outcome.terminated.len(), 2, "目标行照常终止");

    let rows = db.load_session_agents(session_id).unwrap();
    assert_eq!(rows.len(), 3, "kill 中 spawn 的行不丢失（行数 = 两方之和）");
    let race = rows
        .iter()
        .find(|a| a.subagent_run_id == "run-race")
        .expect("并发 spawn 行必须存在");
    assert_eq!(race.status, "running", "非目标行不被误改");
    assert_eq!(race.parent_session_id, session_id, "并发行字段原样");
    assert_eq!(race.depth, Some(1), "并发行字段原样");
    let by_id = |id: &str| rows.iter().find(|a| a.id == id).unwrap();
    assert_eq!(by_id("sub-1").status, "failed", "目标行归一 failed");
    assert_eq!(by_id("sub-2").status, "failed");
    assert_eq!(by_id("sub-1").messages.len(), 1, "目标行 messages 保留");
}

/// 恢复域真实落库面（RecoveryStore for LocalDb）：set_subagent_path 缺行
/// 按 affected=0 判定 NotFound（11-T3 迁移后语义不变）
#[tokio::test]
async fn recovery_store_set_subagent_path_missing_row_returns_not_found() {
    let db = Arc::new(LocalDb::open_in_memory().unwrap());
    db.insert_session("s1", "主会话").unwrap();
    let store: Arc<dyn RecoveryStore> = db.clone();
    let err = store
        .set_subagent_path("s1", "no-such-run", r#"["leaf-a"]"#)
        .expect_err("缺行必须 NotFound");
    assert!(
        matches!(err, RecoveryError::NotFound { .. }),
        "缺行应 NotFound：{err:?}"
    );
}

// ── resume_subagent ──────────────────────────────────────────────

/// kill 后 resume：fork 新 run 承接同一目标（Verbatim 继承）、原 run
/// failed、预算消费记账
#[tokio::test]
async fn resume_forks_new_run_verbatim_and_consumes_budget() {
    let session_id = "s-resume";
    let mut env = resume_env(session_id);
    let started_at = now_ms() - 1_000;
    let rows = vec![
        // 目标行：sub-1 已 failed（kill 后），带 user 任务消息 + 工作流路径
        agent_row(
            "sub-1",
            "run-1",
            "failed",
            started_at,
            session_id,
            Some(r#"["leaf-root","leaf-1"]"#),
            vec![user_msg("完成模块 A")],
        ),
        // sub-2 的大消息撑会话窗口（window = 214B，inject = 14B ≤ 80%）
        agent_row(
            "sub-2",
            "run-2",
            "failed",
            started_at,
            session_id,
            Some(r#"["leaf-root","leaf-1"]"#),
            vec![assistant_msg(&"X".repeat(200))],
        ),
    ];
    env.db.save_session_agents(session_id, &rows).unwrap();
    let sink = RecordingCancelSink::new(true);
    let service = service(&env, &sink);

    // resume：缺省任务从 run 首条 user 消息推断（与恢复阶梯同指纹）
    let outcome = service
        .resume(&mut env.coordinator, session_id, "sub-1", None)
        .await
        .unwrap();
    let ResumeOutcome::Forked(record) = outcome else {
        panic!("期望 Forked：{outcome:?}");
    };
    assert_eq!(record.from_run_id, "run-1", "原 run 为 fork 起点");
    assert_eq!(record.new_run_id, "spawn-run-0", "fork 产出新 run");
    assert_eq!(
        record.context_mode,
        ForkContextMode::Verbatim,
        "同窗（≤24h）且注入 ≤ 会话窗口 80% → 字节级继承"
    );
    // fork 请求承接同一目标（spawner 记录）
    let reqs = env.spawner.requests();
    assert_eq!(reqs.len(), 1);
    assert_eq!(reqs[0].prompt, "完成模块 A", "fork 新 run 承接同一目标");

    // 原 run 置 failed + ended_at；新 run 生效（新行 running）
    let rows = env.db.load_session_agents(session_id).unwrap();
    let original = rows.iter().find(|a| a.id == "sub-1").unwrap();
    assert_eq!(original.status, "failed", "原 run 置 failed");
    assert!(original.ended_at.is_some(), "原 run ended_at 落库");
    let forked = rows
        .iter()
        .find(|a| a.subagent_run_id == "spawn-run-0")
        .expect("fork 新行必须落库");
    assert_eq!(forked.status, "running", "新 run 生效");
    assert_eq!(forked.parent_session_id, session_id);

    // 预算消费记账（操作指纹 = subagent_id + 任务）
    assert_eq!(
        env.coordinator.budget().count(&fingerprint("sub-1", "完成模块 A")),
        1,
        "resume 消费一次 Episode 预算"
    );
    // 已 failed 的 run 不再投递强停
    assert!(sink.calls().is_empty(), "非 running 目标不投递 L3");
}

/// 上下文三态判定：Verbatim / Summarized / New
#[tokio::test]
async fn resume_context_three_states() {
    // ── Verbatim：同窗且注入 ≤ 80% ──
    {
        let session_id = "s-vb";
        let mut env = resume_env(session_id);
        let started_at = now_ms() - 1_000;
        env.db
            .save_session_agents(
                session_id,
                &[
                    agent_row(
                        "sub-1", "run-1", "failed", started_at, session_id,
                        Some(r#"["leaf-root","leaf-1"]"#), vec![user_msg("完成模块 A")],
                    ),
                    agent_row(
                        "sub-2", "run-2", "failed", started_at, session_id,
                        Some(r#"["leaf-root","leaf-1"]"#), vec![assistant_msg(&"X".repeat(200))],
                    ),
                ],
            )
            .unwrap();
        let service = service(&env, &RecordingCancelSink::new(true));
        let outcome = service
            .resume(&mut env.coordinator, session_id, "sub-1", None)
            .await
            .unwrap();
        let ResumeOutcome::Forked(record) = outcome else {
            panic!("期望 Forked：{outcome:?}");
        };
        assert_eq!(record.context_mode, ForkContextMode::Verbatim);
    }
    // ── Summarized：注入超会话窗口 80%（900/1000 = 90%）──
    {
        let session_id = "s-sum";
        let mut env = resume_env(session_id);
        let started_at = now_ms() - 1_000;
        // 首条 user 消息 = 任务（14B），assistant 大段产出 886B → inject 900B
        env.db
            .save_session_agents(
                session_id,
                &[
                    agent_row(
                        "sub-1", "run-1", "failed", started_at, session_id,
                        Some(r#"["leaf-root","leaf-1"]"#),
                        vec![
                            user_msg("完成模块 A"),
                            assistant_msg(&"X".repeat(886)),
                        ],
                    ),
                    agent_row(
                        "sub-2", "run-2", "failed", started_at, session_id,
                        Some(r#"["leaf-root","leaf-1"]"#), vec![assistant_msg(&"Y".repeat(100))],
                    ),
                ],
            )
            .unwrap();
        let service = service(&env, &RecordingCancelSink::new(true));
        let outcome = service
            .resume(&mut env.coordinator, session_id, "sub-1", None)
            .await
            .unwrap();
        let ResumeOutcome::Forked(record) = outcome else {
            panic!("期望 Forked：{outcome:?}");
        };
        assert_eq!(
            record.context_mode,
            ForkContextMode::Summarized,
            "注入 900B > 窗口 1000B 的 80% → 摘要继承"
        );
    }
    // ── New：空内容（无消息）+ 显式 prompt → 全新上下文 ──
    {
        let session_id = "s-new";
        let mut env = resume_env(session_id);
        let started_at = now_ms() - 1_000;
        env.db
            .save_session_agents(
                session_id,
                &[agent_row(
                    "sub-1", "run-1", "failed", started_at, session_id,
                    Some(r#"["leaf-root","leaf-1"]"#), vec![],
                )],
            )
            .unwrap();
        let service = service(&env, &RecordingCancelSink::new(true));
        let outcome = service
            .resume(&mut env.coordinator, session_id, "sub-1", Some("全新任务"))
            .await
            .unwrap();
        let ResumeOutcome::Forked(record) = outcome else {
            panic!("期望 Forked：{outcome:?}");
        };
        assert_eq!(record.context_mode, ForkContextMode::New, "空内容 → 全新");
        let reqs = env.spawner.requests();
        assert_eq!(reqs[0].prompt, "全新任务", "显式 prompt 作为新任务目标");
    }
}

/// 预算共用：resume 与恢复阶梯共用 Episode 预算池（防无限 fork）；
/// 同指纹同源 run 重复 resume 幂等（返回既有记录，不重复 spawn）
#[tokio::test]
async fn resume_shares_episode_budget_with_recovery_ladder() {
    let session_id = "s-shared";
    let mut env = resume_env(session_id);
    let started_at = now_ms() - 1_000;
    env.db
        .save_session_agents(
            session_id,
            &[
                agent_row(
                    "sub-1", "run-1", "failed", started_at, session_id,
                    Some(r#"["leaf-root","leaf-1"]"#), vec![user_msg("完成模块 A")],
                ),
                agent_row(
                    "sub-2", "run-2", "failed", started_at, session_id,
                    Some(r#"["leaf-root","leaf-1"]"#), vec![assistant_msg(&"X".repeat(200))],
                ),
            ],
        )
        .unwrap();
    let fp = fingerprint("sub-1", "完成模块 A");
    // 恢复阶梯先消费 1 次（同指纹同任务，不同源 run）
    let ladder_ctx = |run_id: &str| RunFailureContext {
        subagent_id: "sub-1".to_string(),
        subagent_run_id: run_id.to_string(),
        task: "完成模块 A".to_string(),
        error_kind: ProviderErrorKind::ServerError,
        retries: 5,
        retry_elapsed_ms: 61_000,
        produced_content: false,
        from_leaf_id: Some("leaf-1".to_string()),
        started_at_ms: started_at,
        inject_bytes: 100,
        window_bytes: 10_000,
    };
    let out = env
        .coordinator
        .fork_and_reassign(&ladder_ctx("run-0"))
        .await
        .unwrap();
    assert_eq!(out.ladder, RecoveryLadder::Ladder3Fork);
    assert_eq!(env.coordinator.budget().count(&fp), 1, "阶梯 3 消费 1");

    // resume 消费同一预算池（第 2 次）
    let sink = RecordingCancelSink::new(true);
    let service = service(&env, &sink);
    let ResumeOutcome::Forked(record) = service
        .resume(&mut env.coordinator, session_id, "sub-1", None)
        .await
        .unwrap()
    else {
        panic!("期望 Forked");
    };
    assert_eq!(record.from_run_id, "run-1");
    assert_eq!(
        env.coordinator.budget().count(&fp),
        2,
        "resume 与恢复阶梯共用 Episode 预算池"
    );

    // 幂等：同指纹同源 run 重复 resume → 返回既有记录，不重复 spawn
    let idempotent = service
        .resume(&mut env.coordinator, session_id, "sub-1", None)
        .await
        .unwrap();
    let ResumeOutcome::Forked(existing) = idempotent else {
        panic!("重复 resume 应幂等返回既有 ForkRecord");
    };
    assert_eq!(existing, record, "幂等命中返回同一记录");
    assert_eq!(env.spawner.requests().len(), 2, "幂等不重复 spawn");
    assert_eq!(env.coordinator.budget().count(&fp), 2, "幂等不重复计数");
}

/// 预算耗尽：resume 目标 run 未 fork 过且指纹预算已耗尽 → 阶梯 4
/// NeedsUser（不产生 fork）
#[tokio::test]
async fn resume_budget_exhausted_falls_to_ladder4() {
    let session_id = "s-exhausted";
    let mut env = resume_env(session_id);
    let started_at = now_ms() - 1_000;
    env.db
        .save_session_agents(
            session_id,
            &[
                agent_row(
                    "sub-1", "run-1", "failed", started_at, session_id,
                    Some(r#"["leaf-root","leaf-1"]"#), vec![user_msg("完成模块 A")],
                ),
                agent_row(
                    "sub-2", "run-2", "failed", started_at, session_id,
                    Some(r#"["leaf-root","leaf-1"]"#), vec![assistant_msg(&"X".repeat(200))],
                ),
            ],
        )
        .unwrap();
    let fp = fingerprint("sub-1", "完成模块 A");
    // 恢复阶梯耗尽预算（默认 3）：run-0 / run-2 / run-3 三个源 run
    for i in 0..3u32 {
        let ctx = RunFailureContext {
            subagent_id: "sub-1".to_string(),
            subagent_run_id: format!("run-ladder-{i}"),
            task: "完成模块 A".to_string(),
            error_kind: ProviderErrorKind::ServerError,
            retries: 5,
            retry_elapsed_ms: 61_000,
            produced_content: false,
            from_leaf_id: Some("leaf-1".to_string()),
            started_at_ms: started_at,
            inject_bytes: 100,
            window_bytes: 10_000,
        };
        env.coordinator.fork_and_reassign(&ctx).await.unwrap();
    }
    assert_eq!(env.coordinator.budget().count(&fp), 3);
    assert!(!env.coordinator.budget().can_recover(&fp), "预算耗尽");

    // resume：run-1 未 fork 过（无幂等短路）→ 预算耗尽 → NeedsUser
    let service = service(&env, &RecordingCancelSink::new(true));
    let outcome = service
        .resume(&mut env.coordinator, session_id, "sub-1", None)
        .await
        .unwrap();
    match outcome {
        ResumeOutcome::NeedsUser(report) => {
            assert_eq!(report.subagent_run_id, "run-1", "需介入标记对应原 run");
        }
        other => panic!("预算耗尽 resume 应落 NeedsUser：{other:?}"),
    }
    // 不产生新 run、不重复计数
    assert_eq!(env.spawner.requests().len(), 3, "预算耗尽后不 spawn");
    assert_eq!(env.coordinator.budget().count(&fp), 3);
    assert!(
        env.coordinator.run_needs_user("run-1"),
        "需用户介入标记落库（UI 可观察）"
    );
}

/// prompt 覆盖：显式任务目标 → fork 请求携带新任务、指纹随之变化
#[tokio::test]
async fn resume_with_prompt_override_uses_new_task() {
    let session_id = "s-prompt";
    let mut env = resume_env(session_id);
    let started_at = now_ms() - 1_000;
    env.db
        .save_session_agents(
            session_id,
            &[
                agent_row(
                    "sub-1", "run-1", "failed", started_at, session_id,
                    Some(r#"["leaf-root","leaf-1"]"#), vec![user_msg("旧任务")],
                ),
                agent_row(
                    "sub-2", "run-2", "failed", started_at, session_id,
                    Some(r#"["leaf-root","leaf-1"]"#), vec![assistant_msg(&"X".repeat(200))],
                ),
            ],
        )
        .unwrap();
    let service = service(&env, &RecordingCancelSink::new(true));
    let outcome = service
        .resume(&mut env.coordinator, session_id, "sub-1", Some("新任务指令"))
        .await
        .unwrap();
    let ResumeOutcome::Forked(record) = outcome else {
        panic!("期望 Forked：{outcome:?}");
    };
    // fork 请求携带新任务（spawner 记录）
    let reqs = env.spawner.requests();
    assert_eq!(reqs.len(), 1);
    assert_eq!(reqs[0].prompt, "新任务指令");
    // 不同任务 = 不同操作指纹：不消耗旧任务预算，新任务独立记账
    assert_eq!(env.coordinator.budget().count(&fingerprint("sub-1", "旧任务")), 0);
    assert_eq!(env.coordinator.budget().count(&fingerprint("sub-1", "新任务指令")), 1);
    assert_eq!(record.context_mode, ForkContextMode::Verbatim);
}

/// running 目标 resume：先投递 L3 强停（kill-for-resume）再 fork
#[tokio::test]
async fn resume_running_target_delivers_force_cancel_first() {
    let session_id = "s-running";
    let mut env = resume_env(session_id);
    let started_at = now_ms() - 1_000;
    env.db
        .save_session_agents(
            session_id,
            &[agent_row(
                "sub-1", "run-1", "running", started_at, session_id,
                Some(r#"["leaf-root","leaf-1"]"#), vec![user_msg("完成模块 A")],
            )],
        )
        .unwrap();
    let sink = RecordingCancelSink::new(true);
    let service = service(&env, &sink);
    let outcome = service
        .resume(&mut env.coordinator, session_id, "sub-1", None)
        .await
        .unwrap();
    let ResumeOutcome::Forked(record) = outcome else {
        panic!("期望 Forked：{outcome:?}");
    };
    assert!(!record.new_run_id.is_empty(), "running 目标 resume 产出新 run");
    // kill-for-resume：目标 run 收到 L3 强停（防存活循环终态回写覆盖）
    let calls = sink.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "run-1");
    assert_eq!(calls[0].1, "resume-subagent");
    // 原 run 行归一 failed
    let rows = env.db.load_session_agents(session_id).unwrap();
    let original = rows.iter().find(|a| a.id == "sub-1").unwrap();
    assert_eq!(original.status, "failed", "running 目标 resume 后原 run 置 failed");
}

/// 结构化错误：未知子代理 / 无工作流路径 / 无法推断任务
#[tokio::test]
async fn resume_errors_structured() {
    let session_id = "s-err";
    let mut env = resume_env(session_id);
    let started_at = now_ms() - 1_000;
    env.db
        .save_session_agents(
            session_id,
            &[
                agent_row(
                    "sub-1", "run-1", "failed", started_at, session_id,
                    Some(r#"["leaf-root","leaf-1"]"#), vec![user_msg("完成模块 A")],
                ),
                // 无工作流路径行
                agent_row(
                    "sub-2", "run-2", "failed", started_at, session_id, None,
                    vec![user_msg("完成模块 B")],
                ),
                // 无消息行（无任务可推断）
                agent_row(
                    "sub-3", "run-3", "failed", started_at, session_id,
                    Some(r#"["leaf-root","leaf-1"]"#), vec![],
                ),
            ],
        )
        .unwrap();
    let service = service(&env, &RecordingCancelSink::new(true));

    // 未知子代理 → NotFound
    let err = service
        .resume(&mut env.coordinator, session_id, "sub-unknown", None)
        .await
        .unwrap_err();
    assert!(
        matches!(err, LifecycleError::NotFound { .. }),
        "未知子代理应 NotFound：{err:?}"
    );
    // 无工作流路径 → InvalidState
    let err = service
        .resume(&mut env.coordinator, session_id, "sub-2", None)
        .await
        .unwrap_err();
    assert!(
        matches!(err, LifecycleError::InvalidState { .. }),
        "无路径应 InvalidState：{err:?}"
    );
    // 无消息且无 prompt → InvalidState（无法推断任务）
    let err = service
        .resume(&mut env.coordinator, session_id, "sub-3", None)
        .await
        .unwrap_err();
    assert!(
        matches!(err, LifecycleError::InvalidState { .. }),
        "无法推断任务应 InvalidState：{err:?}"
    );
    // 全部错误路径不产生 spawn
    assert!(env.spawner.requests().is_empty(), "错误路径零 spawn");
}
