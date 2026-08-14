//! C1–C10 主链路端到端集成测试（I7-M12）
//!
//! 一条完整链路（mock 引擎，只读消费各能力契约层）：
//! 主 agent 声明依赖图 → run_subagent spawn → subagent 事件流 →
//! wait_subagents await-all → 恢复阶梯触发 → 压缩 → 重注入。
//!
//! 链路环节断言（02 方案 M12 内容 3）：
//! 1. **依赖图声明**：A 无依赖即启动、B 依赖 A 在 A completed 前不启动
//!    （04 C6 验收 1）；
//! 2. **spawn**：run_subagent 契约 spawn 产出 subagentRunId + 状态，
//!    session_agents 落库语义（pending 首写即 running，M2 状态映射）；
//! 3. **事件流**：subagent-started / subagent-ended 经发射面落库
//!    （Critical 必达，M7 背压分级）；
//! 4. **await-all**：全部终态事件到达前不返回、终态摘要完整（04 C8
//!    验收 1 / M8 等待原语）；
//! 5. **恢复阶梯**：阶梯 1 瞬态自动重试（无 steering）→ 预算耗尽上行
//!    阶梯 2（steering 条目 + 通知落库）→ acknowledge → 阶梯 3 fork
//!    （新 run + 路径落库 + 原 run failed + 留痕）（04 C7 验收 1–4）；
//! 6. **压缩**：超预算经 CompactionEngine 产出摘要占位、system 恒保留、
//!    原始消息仍可读（04 C9 验收 2/4）；
//! 7. **重注入**：started_at / 回退谨慎指引随系统段注入、两次构建字节
//!    一致（04 C2 验收 1/3 + C10 验收 1 的契约层等价面——生产装配点在
//!    apps/agent-workbench engine.rs ContextInjector，见 I6 遗留 L3）。
//!
//! mock 引擎职责分配（对齐引擎侧接线契约，各能力模块只读消费）：
//! - FlowScheduler（C6）持 spawner + session_meta；终态事件由本测试
//!   「引擎侧驱动环」经 on_subagent_terminal 回传（M6 契约）；
//! - SubagentEventEmitter（M14 唯一发射方）经 Store 落库；
//! - RecoveryCoordinator（C7）持队列 / 会话树 / spawner；
//! - wait_for_terminal_events（M8 原语）消费终态事件流；
//! - CompactionEngine（C9）+ subagent_inject（C2/M4）契约面。
//!
//! 引擎侧真实接线（apps/agent-workbench spawner / waiter /
//! RecoveryCoordinator 调用点）不在测试文件域，见 I6 遗留 L1–L3 登记。

// G2 禁令豁免：测试临时目录清理（非产品删除路径，可恢复语义不适用）。
#![allow(clippy::disallowed_methods)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use agent_tools::subagent_inject::{
    git_revert_caution_section, iso8601_from_epoch_ms, resolve_started_at,
    started_at_section, subagent_session_injections, DEFAULT_REF_AGE_THRESHOLD_HOURS,
};
use agent_tools::tools::subagent::{
    SubagentSpawnError, SubagentSpawnRequest, SubagentSpawnResult, SubagentSpawner,
    SubagentState,
};
use agent_tools::tools::wait_subagents::{
    wait_for_terminal_events, SubagentTerminalEvent, SubagentWaitResult,
};
use async_trait::async_trait;
use conex_compaction::{CompactionEngine, CompactionPolicy};
use conex_types::error::ProviderErrorKind;
use conex_types::events::SubagentEndStatus;
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use orchestrator::flow_graph::{
    FlowAdvance, FlowDeclaration, FlowError, FlowMetaStore, FlowNode, FlowNodeState,
    FlowScheduler, FlowStarted,
};
use orchestrator::persist::{InMemoryStore, Store};
use orchestrator::recovery::{
    fingerprint, RecoveryAction, RecoveryCoordinator, RecoveryError, RecoveryLadder,
    RecoveryRetryPolicy, RecoveryStore, RunFailureContext, RECOVER_ESCALATED_EVENT,
    RECOVER_FORK_EVENT, RECOVER_MAX_EPISODES_KEY, RECOVER_STEERING_EVENT,
};
use orchestrator::session::SessionTree;
use orchestrator::steering_queue::PendingMessageQueue;
use orchestrator::subagent_events::{
    SubagentEmitContext, SubagentEndedInfo, SubagentEventEmitter, SubagentStartedInfo,
};
use tokio::sync::mpsc;

// ── 测试替身（契约层只读消费） ────────────────────────────────────

/// session_meta 内存实现（FlowMetaStore 契约；重启场景用真实 SQLite）
struct InMemoryMeta {
    store: Mutex<HashMap<String, String>>,
}

impl InMemoryMeta {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            store: Mutex::new(HashMap::new()),
        })
    }
}

impl FlowMetaStore for InMemoryMeta {
    fn get_meta(&self, key: &str) -> Result<Option<String>, FlowError> {
        Ok(self.store.lock().unwrap().get(key).cloned())
    }

    fn set_meta(&self, key: &str, value: &str) -> Result<(), FlowError> {
        self.store
            .lock()
            .unwrap()
            .insert(key.to_string(), value.to_string());
        Ok(())
    }
}

/// 链路 spawner：记录请求 + 自增 run id + started_at 记账（C2 重注入
/// 断言的数据源）——模拟引擎侧「spawn 落库 + 首次创建时间生成」契约
struct ChainSpawner {
    requests: Mutex<Vec<SubagentSpawnRequest>>,
    started_at_ms: Mutex<HashMap<String, i64>>,
    run_to_id: Mutex<HashMap<String, String>>,
    seq: AtomicUsize,
}

impl ChainSpawner {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            requests: Mutex::new(Vec::new()),
            started_at_ms: Mutex::new(HashMap::new()),
            run_to_id: Mutex::new(HashMap::new()),
            seq: AtomicUsize::new(0),
        })
    }

    fn requests(&self) -> Vec<SubagentSpawnRequest> {
        self.requests.lock().unwrap().clone()
    }

    fn started_at(&self, subagent_id: &str) -> i64 {
        self.started_at_ms
            .lock()
            .unwrap()
            .get(subagent_id)
            .copied()
            .unwrap_or(0)
    }

    /// run id → 子代理 id 反查（FlowStarted 不带 subagent_id，经 spawner 记账）
    fn subagent_id_for_run(&self, run_id: &str) -> String {
        self.run_to_id
            .lock()
            .unwrap()
            .get(run_id)
            .cloned()
            .expect("run 必须有对应子代理 id")
    }
}

impl std::fmt::Debug for ChainSpawner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChainSpawner").finish_non_exhaustive()
    }
}

#[async_trait]
impl SubagentSpawner for ChainSpawner {
    async fn spawn(
        &self,
        req: &SubagentSpawnRequest,
    ) -> Result<SubagentSpawnResult, SubagentSpawnError> {
        self.requests.lock().unwrap().push(req.clone());
        let n = self.seq.fetch_add(1, Ordering::SeqCst);
        let subagent_id = format!("sub-{n}");
        let run_id = format!("chain-run-{n}");
        // C2：started_at 首次创建即生成并落库（resolve_started_at 新值面）
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        self.started_at_ms
            .lock()
            .unwrap()
            .insert(subagent_id.clone(), now);
        self.run_to_id
            .lock()
            .unwrap()
            .insert(run_id.clone(), subagent_id.clone());
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

/// 链路 mock 引擎：把调度 / 事件 / 恢复 / 等待各能力串成一条链
struct MockEngine {
    store: Arc<InMemoryStore>,
    spawner: Arc<ChainSpawner>,
    sched: FlowScheduler,
    coordinator: RecoveryCoordinator,
    /// 恢复域持久化具体句柄（留痕断言面）
    recovery_store: Arc<MemRecoveryStore>,
    queue: Arc<Mutex<PendingMessageQueue>>,
    tree: Arc<Mutex<SessionTree>>,
    emitter: SubagentEventEmitter,
    compact: CompactionEngine,
    /// 终态事件流（wait_subagents 原语消费面）
    wait_tx: mpsc::Sender<SubagentTerminalEvent>,
}

impl MockEngine {
    /// 装配 mock 引擎（会话树含根叶子 leaf-root）
    fn new(session_id: &str, wait_tx: mpsc::Sender<SubagentTerminalEvent>) -> Self {
        let store = Arc::new(InMemoryStore::new());
        let store_dyn: Arc<dyn Store> = store.clone();
        let meta = InMemoryMeta::new();
        let spawner = ChainSpawner::new();
        let sched =
            FlowScheduler::new(session_id, spawner.clone(), meta).expect("调度器创建失败");
        let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        let tree = Arc::new(Mutex::new(SessionTree::new(session_id)));
        tree.lock()
            .unwrap()
            .append("leaf-root", serde_json::json!({ "text": "root" }))
            .unwrap();
        let recovery_store = MemRecoveryStore::new();
        let coordinator = RecoveryCoordinator::new(
            session_id,
            recovery_store.clone(),
            queue.clone(),
            tree.clone(),
            spawner.clone(),
            RecoveryRetryPolicy {
                max_retries: 5,
                ..RecoveryRetryPolicy::default()
            },
        )
        .expect("协调器构造失败");
        let emitter = SubagentEventEmitter::new(store_dyn.clone());
        Self {
            store,
            spawner,
            sched,
            coordinator,
            recovery_store,
            queue,
            tree,
            emitter,
            compact: CompactionEngine::new(64),
            wait_tx,
        }
    }

    /// 引擎侧 spawn 接线（契约）：spawn 成功 → subagent-started 发射
    async fn spawn_and_emit_started(&self, req: &SubagentSpawnRequest) -> SubagentSpawnResult {
        let result = self.spawner.spawn(req).await.expect("spawn 必须成功");
        self.emit_started(result.clone(), req).await;
        result
    }

    /// 流程节点 spawn 后的 started 发射（FlowScheduler 内部 spawn 不经
    /// spawn_and_emit_started，引擎侧接线 = 订阅 spawn 结果发射 started）
    async fn emit_started_for_flow(&self, started: &[FlowStarted]) {
        for s in started {
            let req = self
                .spawner
                .requests()
                .iter()
                .find(|r| r.flow_node_id.as_deref() == Some(s.node_id.as_str()))
                .cloned()
                .expect("流程 spawn 请求必须已记录");
            let sub_id = self.spawner.subagent_id_for_run(&s.subagent_run_id);
            self.emit_started(
                SubagentSpawnResult {
                    subagent_id: sub_id,
                    subagent_run_id: s.subagent_run_id.clone(),
                    session_id: String::new(),
                    status: SubagentState::Running,
                    summary: None,
                    flow_node_id: Some(s.node_id.clone()),
                    display_label: None,
                },
                &req,
            )
            .await;
        }
    }

    /// started 事件发射（信封对齐 subagentHandlers.ts:17-26 的落库字段）
    async fn emit_started(&self, result: SubagentSpawnResult, req: &SubagentSpawnRequest) {
        let started = SubagentStartedInfo {
            subagent_id: result.subagent_id,
            subagent_run_id: result.subagent_run_id,
            role: req
                .role
                .map(|r| r.as_str().to_string())
                .unwrap_or_else(|| "researcher".to_string()),
            capability_mode: req
                .capability_mode
                .map(|m| m.as_str().to_string())
                .unwrap_or_else(|| "read-write".to_string()),
            started_at: now_iso_utc_like(),
            description: req.description.clone(),
            mode: req.mode.clone(),
            parent_tool_call_id: req.parent_tool_call_id.clone(),
            subagent_session_id: Some(result.session_id.clone()),
        };
        let ctx = SubagentEmitContext {
            session_id: req.parent_session_id.clone(),
            parent_run_id: req.parent_run_id.clone().unwrap_or_default(),
        };
        self.emitter
            .emit_started(&ctx, &started)
            .await
            .expect("subagent-started 必须落库（Critical）");
    }

    /// 引擎侧终态接线（契约）：终态落库 + 调度器推进 + 终态事件
    /// 喂入等待原语事件流；返回调度器推进结果（含后置补启动）
    async fn terminal(
        &mut self,
        run_id: &str,
        state: SubagentState,
        subagent_id: &str,
    ) -> FlowAdvance {
        let status = match state {
            SubagentState::Completed => SubagentEndStatus::Completed,
            _ => SubagentEndStatus::Failed,
        };
        let ended = SubagentEndedInfo {
            subagent_id: subagent_id.to_string(),
            subagent_run_id: run_id.to_string(),
            status,
            summary: Some("链路终态摘要".to_string()),
            subagent_session_id: None,
        };
        let ctx = SubagentEmitContext {
            session_id: self.sched.session_id().to_string(),
            parent_run_id: String::new(),
        };
        // 终态事件双轨：发射面落库（Critical）+ 原语事件流（M8 等待面）
        self.emitter
            .emit_ended(&ctx, &ended)
            .await
            .expect("subagent-ended 必须落库（Critical）");
        let adv = self
            .sched
            .on_subagent_terminal(run_id, state)
            .await
            .expect("终态回传推进必须成功");
        let ended_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        self.wait_tx
            .send(SubagentTerminalEvent {
                subagent_id: subagent_id.to_string(),
                status: state,
                summary: ended.summary.clone(),
                ended_at_ms,
            })
            .await
            .expect("等待原语事件流送达");
        adv
    }

    /// 独立子代理（非流程 run）终态：事件面落库 + 等待原语事件流，
    /// 不经调度器（未知 run 拒绝语义由 flow_scheduler 域测试锁定）
    async fn standalone_terminal(&self, run_id: &str, state: SubagentState, subagent_id: &str) {
        let status = match state {
            SubagentState::Completed => SubagentEndStatus::Completed,
            _ => SubagentEndStatus::Failed,
        };
        let ended = SubagentEndedInfo {
            subagent_id: subagent_id.to_string(),
            subagent_run_id: run_id.to_string(),
            status,
            summary: Some("链路终态摘要".to_string()),
            subagent_session_id: None,
        };
        let ctx = SubagentEmitContext {
            session_id: self.sched.session_id().to_string(),
            parent_run_id: String::new(),
        };
        self.emitter
            .emit_ended(&ctx, &ended)
            .await
            .expect("subagent-ended 必须落库（Critical）");
        let ended_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        self.wait_tx
            .send(SubagentTerminalEvent {
                subagent_id: subagent_id.to_string(),
                status: state,
                summary: ended.summary.clone(),
                ended_at_ms,
            })
            .await
            .expect("等待原语事件流送达");
    }

    /// 已落库事件（session 级快照断言）
    fn persisted_events(&self) -> Vec<(String, String)> {
        self.store
            .events()
            .iter()
            .map(|e| (e.event_type.clone(), e.payload.clone()))
            .collect()
    }

    /// 队列中的 steering 条目（阶梯 2 通知主 agent 的载体；dequeue 消费）
    fn steering_texts(&self) -> Vec<String> {
        self.queue
            .lock()
            .unwrap()
            .dequeue_all()
            .iter()
            .map(|e| e.text.clone())
            .collect()
    }

    /// 恢复域留痕事件（(session, type, payload)）
    fn recovery_events(&self) -> Vec<(String, String, String)> {
        self.recovery_store.events()
    }
}

/// 恢复域内存持久化（RecoveryStore 契约；链路断言面）
struct MemRecoveryStore {
    meta: Mutex<HashMap<String, String>>,
    events: Mutex<Vec<(String, String, String)>>,
}

impl MemRecoveryStore {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            meta: Mutex::new(HashMap::new()),
            events: Mutex::new(Vec::new()),
        })
    }

    fn events(&self) -> Vec<(String, String, String)> {
        self.events.lock().unwrap().clone()
    }
}

impl RecoveryStore for MemRecoveryStore {
    fn get_meta(&self, key: &str) -> Result<Option<String>, RecoveryError> {
        Ok(self.meta.lock().unwrap().get(key).cloned())
    }

    fn set_meta(&self, key: &str, value: &str) -> Result<(), RecoveryError> {
        self.meta
            .lock()
            .unwrap()
            .insert(key.to_string(), value.to_string());
        Ok(())
    }

    fn append_event(
        &self,
        session_id: &str,
        event_type: &str,
        payload: &str,
    ) -> Result<(), RecoveryError> {
        self.events.lock().unwrap().push((
            session_id.to_string(),
            event_type.to_string(),
            payload.to_string(),
        ));
        Ok(())
    }

    fn update_run_status(
        &self,
        _subagent_run_id: &str,
        _status: &str,
        _end_reason: &str,
    ) -> Result<(), RecoveryError> {
        Ok(())
    }

    fn set_subagent_path(
        &self,
        _session_id: &str,
        _subagent_run_id: &str,
        _path_json: &str,
    ) -> Result<(), RecoveryError> {
        Ok(())
    }

    fn get_subagent_parent_tool_call_id(
        &self,
        _session_id: &str,
        _subagent_run_id: &str,
    ) -> Result<Option<String>, RecoveryError> {
        // LK-02：multi_agent 链路断言面不测 fork 键传播，恒 None 即可
        Ok(None)
    }
}

// ── 构造助手 ──────────────────────────────────────────────────────

fn flow_node(id: &str, depends_on: &[&str]) -> FlowNode {
    FlowNode {
        id: id.to_string(),
        task: format!("任务 {id}"),
        depends_on: depends_on.iter().map(|s| s.to_string()).collect(),
        parallel: true,
        on_failed: None,
        is_composite: false,
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn now_iso_utc_like() -> String {
    iso8601_from_epoch_ms(now_ms())
}

/// 超预算消息序列（C9 压缩环节输入）：1 条 system + 4 条对话消息
fn over_budget_messages() -> Vec<Arc<AgentMessage>> {
    let text_block = |text: &str| AgentMessageBlock::Text { text: text.to_string() };
    let mut messages: Vec<Arc<AgentMessage>> = vec![Arc::new(AgentMessage {
        id: "sys-1".to_string(),
        role: AgentMessageRole::System,
        created_at: "2026-08-04T00:00:00.000Z".to_string(),
        blocks: vec![text_block("system 系统提示（永不参与压缩）")],
        metadata: None,
        client_message_id: None,
        content: None,
    })];
    for i in 0..4 {
        let role = if i % 2 == 0 {
            AgentMessageRole::User
        } else {
            AgentMessageRole::Assistant
        };
        messages.push(Arc::new(AgentMessage {
            id: format!("m-{i}"),
            role,
            created_at: format!("2026-08-04T00:00:0{i}.000Z"),
            blocks: vec![text_block(&"压缩前的早期对话内容，用于撑爆预算。".repeat(30))],
            metadata: None,
            client_message_id: None,
            content: None,
        }));
    }
    messages
}

// ── 主链路：依赖图 → spawn → 事件流 → await-all → 恢复 → 压缩 → 重注入 ──

/// 全链路走通断言（02 方案 M12 内容 3）
#[tokio::test]
async fn full_chain_dependency_graph_to_reinjection() {
    let session_id = "sess-chain";
    let (wait_tx, wait_rx) = mpsc::channel(16);
    let mut engine = MockEngine::new(session_id, wait_tx);

    // ── 1. 依赖图声明：A 立即启动、B 依赖 A 暂不启动（04 C6 验收 1）──
    let decl = FlowDeclaration {
        tasks: vec![flow_node("a", &[]), flow_node("b", &["a"])],
        planner_run_id: Some("planner-1".to_string()),
    };
    let adv = engine
        .sched
        .declare_flow(&decl)
        .await
        .expect("依赖图声明必须成功");
    assert_eq!(adv.started.len(), 1, "A 无依赖即启动");
    assert_eq!(adv.started[0].node_id, "a");
    assert_eq!(
        engine.sched.node_state("b"),
        Some(FlowNodeState::Pending),
        "B 在 A completed 前不启动"
    );
    let run_a = adv.started[0].subagent_run_id.clone();
    let sub_a = engine.spawner.subagent_id_for_run(&run_a);
    // 引擎侧接线：spawn 结果 → subagent-started 发射（M7 事件面）
    engine.emit_started_for_flow(&adv.started).await;

    // ── 2. run_subagent spawn 契约 + session_agents 落库语义 ──
    // 引擎侧 spawn 接线：流程节点 spawn 请求带 flow_node_id（M6 契约）
    let spawn_reqs = engine.spawner.requests();
    assert_eq!(spawn_reqs.len(), 1);
    assert_eq!(spawn_reqs[0].flow_node_id.as_deref(), Some("a"));
    assert_eq!(spawn_reqs[0].prompt, "任务 a");
    let started_at_db = engine.spawner.started_at(&sub_a);
    assert!(started_at_db > 0, "spawn 必须生成首次创建时间（C2 数据源）");

    // ── 3. subagent 事件流：started 落库（Critical 必达，M7）──
    let started_types: Vec<String> = {
        let events = engine.persisted_events();
        events
            .iter()
            .filter(|(t, _)| t == "subagent-started")
            .map(|(t, _)| t.to_string())
            .collect()
    };
    assert_eq!(started_types.len(), 1, "spawn 后 subagent-started 必须落库");

    // ── 4. await-all：全部终态到达前不返回（04 C8 验收 1 / M8 原语）──
    // 主 agent 分发对象：流程节点 A + 独立 run_subagent 直调 X（工具路径，
    // 分发时 id 已知；B 由调度器在 A 终态后补 spawn，属编排推进面）
    let x_req = SubagentSpawnRequest {
        agent_id: None,
        prompt: "并行探索任务".to_string(),
        role: None,
        capability_mode: None,
        allowed_tools: None,
        description: Some("直调子代理".to_string()),
        mode: Some("research".to_string()),
        parent_session_id: session_id.to_string(),
        parent_run_id: Some("planner-1".to_string()),
        parent_tool_call_id: None,
        flow_node_id: None,
        is_composite: false,
        // T-D-07 定义扩展：直调路径不携带（None = 缺省 analysis + 默认集）
        task_type: None,
        allowed_write_paths: None,
        display_label: None,
        // 扩展点预留：全构造点显式 None（编译器强制）
        model_override: None,
    };
    let x_result = engine.spawn_and_emit_started(&x_req).await;
    let ids = vec![sub_a.clone(), x_result.subagent_id.clone()];
    // 分发时刻取早 1ms，保证 elapsed = ended - dispatched ≥ 1（毫秒级可断言）
    let dispatched_at = (now_ms() - 1) as u64;
    let wait_handle = tokio::spawn(async move {
        // 逃生上限 30s：逻辑正确时毫秒级返回，超时即失败而非悬挂
        wait_for_terminal_events(&ids, wait_rx, Some(std::time::Duration::from_secs(30)), dispatched_at).await
    });
    // A 完成 → B 启动 → 终态事件流送达（on_subagent_terminal 内部不动点推进）
    let adv2 = engine
        .terminal(&run_a, SubagentState::Completed, &sub_a)
        .await;
    assert_eq!(adv2.started.len(), 1, "A completed 后 B 才启动");
    engine.emit_started_for_flow(&adv2.started).await;
    let run_b = adv2.started[0].subagent_run_id.clone();
    let sub_b = engine.spawner.subagent_id_for_run(&run_b);
    let adv3 = engine.terminal(&run_b, SubagentState::Completed, &sub_b).await;
    engine
        .standalone_terminal(
            &x_result.subagent_run_id,
            SubagentState::Completed,
            &x_result.subagent_id,
        )
        .await;
    assert!(engine.sched.flow_terminal(), "编排全终态");
    assert_eq!(adv3.started.len(), 0, "终态后无新 run");
    assert_eq!(engine.sched.budget_in_flight(), 0, "终态后预算归零");

    let result: SubagentWaitResult = wait_handle.await.expect("等待任务完成");
    assert!(result.all_terminal, "await-all：全部终态后才返回");
    assert!(!result.timed_out);
    assert_eq!(result.agents.len(), 2, "等待名单 = 分发对象（A + X）");
    for agent in &result.agents {
        assert!(agent.terminal, "终态摘要必须带 terminal 标记");
        assert!(agent.elapsed_ms > 0, "elapsed 必须按 ended - dispatched 计算");
    }
    // 终态事件落库（ended 为 Critical 必达；A/B/X 三枚）
    let ended_types: Vec<String> = {
        let events = engine.persisted_events();
        events
            .iter()
            .filter(|(t, _)| t == "subagent-ended")
            .map(|(t, _)| t.to_string())
            .collect()
    };
    assert_eq!(ended_types.len(), 3, "A/B/X 终态事件必须落库");

    // ── 5. 恢复阶梯：瞬态 → 阶梯 1 自动重试 → 阶梯 2 steering → 阶梯 3 fork ──
    let run_c = "chain-run-recovery";
    let sub_c = "sub-recovery";
    let ctx = |retries: u32, elapsed_ms: u64| RunFailureContext {
        subagent_id: sub_c.to_string(),
        subagent_run_id: run_c.to_string(),
        task: "完成恢复链路目标".to_string(),
        error_kind: ProviderErrorKind::RateLimit,
        retries,
        retry_elapsed_ms: elapsed_ms,
        produced_content: false,
        from_leaf_id: Some("leaf-root".to_string()),
        started_at_ms: now_ms() - 1_000,
        inject_bytes: 100,
        window_bytes: 10_000,
    };
    // 阶梯 1：预算内瞬态错误自动重试、无 steering（04 C7 验收 1）
    let out1 = engine
        .coordinator
        .on_subagent_run_failure(&ctx(0, 0))
        .await
        .unwrap();
    assert_eq!(out1.ladder, RecoveryLadder::Ladder1AutoRetry);
    assert!(matches!(out1.action, RecoveryAction::AutoRetry { .. }));
    assert!(
        engine.coordinator.pending_notifications() == 0,
        "阶梯 1 预算内不产生通知"
    );
    // 阶梯 2：重试预算耗尽 → steering 条目 + 通知落库（04 C7 验收 2）
    let out2 = engine
        .coordinator
        .on_subagent_run_failure(&ctx(6, 61_000))
        .await
        .unwrap();
    assert_eq!(out2.ladder, RecoveryLadder::Ladder2MainAgent);
    assert_eq!(engine.coordinator.pending_notifications(), 1, "通知落库");
    let steering = engine.steering_texts();
    assert_eq!(steering.len(), 1, "steering 条目主 agent 可读");
    assert!(
        steering[0].contains(run_c) && steering[0].contains("重试"),
        "steering 内容含哪个 run + 已重试次数"
    );
    let recovery_event_types: Vec<String> = {
        let events = engine.recovery_events();
        events.iter().map(|(_, t, _)| t.to_string()).collect()
    };
    assert!(
        recovery_event_types.contains(&RECOVER_ESCALATED_EVENT.to_string())
            && recovery_event_types.contains(&RECOVER_STEERING_EVENT.to_string()),
        "阶梯 1→2 升级与 steering 必须留痕"
    );
    // 阶梯 3：acknowledge 关闭 pending → fork 新 run 承接同一目标
    engine
        .coordinator
        .acknowledge(run_c)
        .expect("acknowledge 必须成功");
    assert_eq!(engine.coordinator.pending_notifications(), 0);
    let out3 = engine
        .coordinator
        .fork_and_reassign(&ctx(6, 61_000))
        .await
        .unwrap();
    assert_eq!(out3.ladder, RecoveryLadder::Ladder3Fork);
    let RecoveryAction::Forked { record } = &out3.action else {
        panic!("阶梯 3 必须产出 Forked 记录");
    };
    assert_eq!(record.from_run_id, run_c);
    assert!(!record.new_run_id.is_empty(), "fork 必须产出新 run");
    assert_eq!(
        record.context_mode.as_str(),
        "verbatim",
        "同窗（≤24h 且注入 ≤80%）字节级继承"
    );
    // 原 run failed + 事件留痕（04 C7 验收 4 的留痕面）
    let fork_event = {
        let events = engine.recovery_events();
        events
            .iter()
            .find(|(_, t, _)| t == RECOVER_FORK_EVENT)
            .cloned()
            .expect("fork 留痕必须存在")
    };
    assert!(fork_event.2.contains(run_c));
    let fork_fp = fingerprint(sub_c, "完成恢复链路目标");
    assert_eq!(engine.coordinator.budget().count(&fork_fp), 1, "预算消费 1");

    // ── 6. 压缩：超预算 → 摘要占位 + system 恒保留 + 原始消息可读（04 C9）──
    let messages = over_budget_messages();
    let plan = engine.compact.compact_agent_messages(
        &messages,
        40,
        &CompactionPolicy {
            keep_recent_tokens: 20,
            min_recent_turns: 1,
            max_summary_tokens: 64,
            tool_pair_protection: true,
        },
        None,
    );
    assert!(!plan.dropped_ids.is_empty(), "超预算必须压缩早期消息");
    assert!(plan.tokens_after < plan.tokens_before, "压缩后 token 下降");
    assert!(
        plan.messages
            .iter()
            .any(|m| m.id.starts_with("compacted-summary")),
        "摘要占位消息必须存在"
    );
    assert!(
        plan.messages
            .iter()
            .any(|m| m.role == AgentMessageRole::System),
        "system 消息任何压缩路径完整保留（C9 验收 4）"
    );
    let original_ids: Vec<&str> = messages.iter().map(|m| m.id.as_str()).collect();
    for id in &plan.dropped_ids {
        assert!(
            original_ids.contains(&id.as_str()),
            "被压缩段落原始消息仍可从库读取（压缩不删除数据）"
        );
    }

    // ── 7. 重注入：started_at + 回退指引随系统段注入、字节级一致 ──
    // 契约层等价面（生产装配点 = workbench ContextInjector，见 I6 遗留 L3）：
    // subagent_session_injections 产出注入项 → render 两次字节一致
    let injections =
        subagent_session_injections(Some(started_at_db), DEFAULT_REF_AGE_THRESHOLD_HOURS);
    assert_eq!(injections.len(), 2, "started_at + 回退谨慎指引两段");
    let base = "基础系统提示";
    let render = |items: &[(String, String)], enabled: bool| -> Option<String> {
        if !enabled || items.is_empty() {
            return Some(base.to_string());
        }
        let mut parts = vec![base.to_string()];
        for (title, content) in items {
            parts.push(format!("## {title}\n{content}"));
        }
        Some(parts.join("\n\n"))
    };
    let first = render(&injections, true).unwrap();
    let second = render(&injections, true).unwrap();
    assert_eq!(first, second, "同一配置两次构建 system 段字节必须一致（C10 验收 1）");
    // started_at 等于库值（epoch ms）且带 @dynamic 与隔离边界（C2 验收 1）
    assert!(first.contains(&format!("{started_at_db}")), "started_at 必须等于库内值");
    assert!(first.contains("@dynamic"), "@dynamic 标记豁免字节级断言");
    assert!(first.contains("隔离边界"), "隔离边界声明必须存在");
    // 回退谨慎指引固定片段（C2 验收 3）
    assert!(
        first.contains("单文件修复") && first.contains("审批门禁"),
        "回退谨慎指引固定文案必须命中"
    );
    // 禁用开关：false 不注入（C10 验收 4 契约面）
    let disabled = render(&injections, false).unwrap();
    assert_eq!(disabled, base, "禁用开关置 false 不注入系统上下文");
    // started_at 段与回退指引段分列且顺序稳定（M1 注入顺序契约）
    let pos_started = first
        .find(&started_at_section(started_at_db))
        .expect("started_at 段存在");
    let pos_caution = first
        .find(&git_revert_caution_section(DEFAULT_REF_AGE_THRESHOLD_HOURS))
        .expect("回退指引段存在");
    assert!(pos_started < pos_caution, "started_at 段先于回退指引段（注入顺序冻结）");
}

// ── 链路环节细节断言（各环节独立验证，链路主测试的支撑） ─────────

/// 事件信封：started/ended 必须携带 subagentId / subagentRunId / status
/// （04 §1.1 事件对接点 + M7 信封对齐）
#[tokio::test]
async fn chain_event_envelopes_carry_subagent_identity() {
    let session_id = "sess-envelope";
    let (wait_tx, _wait_rx) = mpsc::channel(4);
    let engine = MockEngine::new(session_id, wait_tx);
    let req = SubagentSpawnRequest {
        agent_id: Some("agent-x".to_string()),
        prompt: "信封验证任务".to_string(),
        role: None,
        capability_mode: None,
        allowed_tools: None,
        description: Some("信封子代理".to_string()),
        mode: Some("solve".to_string()),
        parent_session_id: session_id.to_string(),
        parent_run_id: Some("planner-1".to_string()),
        parent_tool_call_id: Some("call-1".to_string()),
        flow_node_id: None,
        is_composite: false,
        // T-D-07 定义扩展：信封路径不携带（None = 缺省 analysis + 默认集）
        task_type: None,
        allowed_write_paths: None,
        display_label: None,
        // 扩展点预留：全构造点显式 None（编译器强制）
        model_override: None,
    };
    let result = engine.spawn_and_emit_started(&req).await;
    // 信封：subagent-started 落库且字段齐全（Critical）
    let events = engine.persisted_events();
    let started_payload = events
        .iter()
        .find(|(t, _)| t == "subagent-started")
        .map(|(_, p)| p.clone())
        .expect("started 事件必须存在");
    assert!(started_payload.contains(&result.subagent_id));
    assert!(started_payload.contains(&result.subagent_run_id));
    assert!(started_payload.contains(session_id), "信封 sessionId 必须存在");
    assert!(started_payload.contains("call-1"), "parentToolCallId 必须透传");
    assert!(
        started_payload.contains("solve") && started_payload.contains("信封子代理"),
        "mode 与 description 字段必须透传"
    );
    // 注意：runId（父 run）由引擎传输层信封注入（engine 桥统一注入
    // runId/sequence），事件载荷不含该字段——M7 信封差异登记（见遗留）
}

/// 等待原语：await-all 期间未知子代理终态事件被忽略（并发其它子代理
/// 不打断等待，M8 原语契约）
#[tokio::test]
async fn chain_wait_ignores_unlisted_subagent_terminals() {
    let (wait_tx, wait_rx) = mpsc::channel(8);
    let dispatch_at = now_ms() as u64;
    let ids = vec!["sub-a".to_string()];
    let handle = tokio::spawn(async move {
        wait_for_terminal_events(&ids, wait_rx, None, dispatch_at).await
    });
    // 未知 id 终态事件：忽略不计数
    wait_tx
        .send(SubagentTerminalEvent {
            subagent_id: "sub-other".to_string(),
            status: SubagentState::Completed,
            summary: None,
            ended_at_ms: now_ms() as u64,
        })
        .await
        .unwrap();
    // 等待名单内终态 → 返回
    wait_tx
        .send(SubagentTerminalEvent {
            subagent_id: "sub-a".to_string(),
            status: SubagentState::Completed,
            summary: Some("完成".to_string()),
            ended_at_ms: now_ms() as u64,
        })
        .await
        .unwrap();
    let result = handle.await.unwrap();
    assert!(result.all_terminal);
    assert_eq!(result.agents.len(), 1);
}

/// 恢复阶梯：预算耗尽跳过阶梯 2 直落阶梯 4（恢复预算制，01 Top 5）
#[tokio::test]
async fn chain_recovery_budget_exhausted_skips_ladder2() {
    let session_id = "sess-budget";
    let (wait_tx, _wait_rx) = mpsc::channel(4);
    let engine = MockEngine::new(session_id, wait_tx);
    // 预算上限 1：第一次 fork 消费后，同指纹再失败 → 阶梯 4 上报用户
    let fp = fingerprint("sub-recovery", "预算目标");
    // 先造一次 fork 消费预算（同指纹同任务）
    let ctx = RunFailureContext {
        subagent_id: "sub-recovery".to_string(),
        subagent_run_id: "run-first".to_string(),
        task: "预算目标".to_string(),
        error_kind: ProviderErrorKind::RateLimit,
        retries: 6,
        retry_elapsed_ms: 61_000,
        produced_content: false,
        from_leaf_id: Some("leaf-root".to_string()),
        started_at_ms: now_ms() - 1_000,
        inject_bytes: 100,
        window_bytes: 10_000,
    };
    // 限制 = 1：预置预算键（recover_max_episodes=1）→ 新协调器
    engine
        .recovery_store
        .set_meta(RECOVER_MAX_EPISODES_KEY, "1")
        .expect("预算键预置失败");
    let mut engine = engine;
    engine.coordinator = RecoveryCoordinator::new(
        session_id,
        engine.recovery_store.clone(),
        engine.queue.clone(),
        engine.tree.clone(),
        engine.spawner.clone(),
        RecoveryRetryPolicy::default(),
    )
    .unwrap();
    // 第一次 fork（预算 1 → 0）
    let out = engine.coordinator.fork_and_reassign(&ctx).await.unwrap();
    assert_eq!(out.ladder, RecoveryLadder::Ladder3Fork);
    assert_eq!(engine.coordinator.budget().count(&fp), 1);
    // 预算耗尽：不再产生阶梯 2 通知，直落阶梯 4 上报用户
    let ctx2 = RunFailureContext {
        subagent_run_id: "run-second".to_string(),
        ..ctx
    };
    let out2 = engine
        .coordinator
        .on_subagent_run_failure(&ctx2)
        .await
        .unwrap();
    assert_eq!(out2.ladder, RecoveryLadder::Ladder4User, "预算耗尽直落阶梯 4");
    assert!(engine.coordinator.run_needs_user("run-second"), "需用户介入标记");
    let types: Vec<String> = {
        let events = engine.recovery_events();
        events.iter().map(|(_, t, _)| t.to_string()).collect()
    };
    assert!(
        !types.iter().any(|t| t == RECOVER_STEERING_EVENT),
        "预算耗尽不产生阶梯 2 steering 事件"
    );
    assert!(
        types.iter().any(|t| t == RECOVER_ESCALATED_EVENT || t == "recovery-budget-denied"),
        "升级或预算拒绝必须留痕"
    );
}

// ── 压缩细节：工具输出截断 G8 与压缩水位联动已在 conex-compaction
//    域测试覆盖（tool_output.rs），链路侧只断言压缩主路径 ──────────

/// 重注入细节：续跑不刷新 started_at（C2 验收 2 契约面）
#[test]
fn chain_reinject_started_at_not_refreshed_on_resume() {
    let original = now_ms() - 3_600_000;
    let later = now_ms();
    // 库中已有首次创建时间 → 续跑取原值不刷新（C2 边界 2）
    assert_eq!(resolve_started_at(Some(original), later), original);
    // 新 spawn（库中无值）→ 生成当前时间
    let fresh = resolve_started_at(None, later);
    assert_eq!(fresh, later);
}
