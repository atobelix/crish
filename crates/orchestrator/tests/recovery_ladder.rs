//! C7 四级恢复阶梯 + 恢复预算制集成测试（I6-M9）
//!
//! 覆盖 04 文档 C7 验收 1–6 + 02 方案 M9 扩展项（恢复预算制）：
//! - 阶梯 1：2 次瞬态错误预算内自动恢复、无 steering 条目（验收 1）；
//! - 阶梯 2：预算耗尽产生 steering 条目且主 agent 可读（验收 2）；
//! - 阶梯 2 激活路径：steering 条目转为用户消息（L1 载体），acknowledge
//!   后通知关闭（验收 3 的注入面）；
//! - 阶梯 3：fork 新 run + subagent_path_json 记录路径 + 原 run failed +
//!   events 留痕（验收 4）；
//! - 重启后未处理阶梯 2 通知仍在队列（验收 5）；
//! - 阶梯 3 后仍失败 → 需用户介入标记 + 完整留痕 + 上报事件（验收 6）；
//! - 恢复预算制：fork 次数超预算即停、指纹幂等、预算跨重启恢复。
//!
//! 测试替身：InMemoryStore（RecoveryStore 契约，内存记账）+ DbStore
//! （真实 SQLite 库，验证 set_subagent_path / update_run_status /
//! append_event 经既有接口落库）+ RecordingSpawner（DB 模式同时落库
//! session_agents 行——阶梯 3 路径落库用真实库）。

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
use conex_db::{LocalDb, RunStatus};
use conex_test_utils::TempWorkspace;
use conex_types::error::ProviderErrorKind;
use conex_types::SessionAgent;
use orchestrator::recovery::{
    fingerprint, RecoveryAction, RecoveryCoordinator, RecoveryError, RecoveryLadder,
    RecoveryNotification, RecoveryRetryPolicy, RecoveryStore, RunFailureContext,
    RECOVER_EPISODES_KEY, RECOVER_ESCALATED_EVENT, RECOVER_FORK_EVENT,
    RECOVER_MAX_EPISODES_KEY, RECOVER_NOTIFICATIONS_KEY, RECOVER_REPORT_EVENT,
    RECOVER_STEERING_EVENT,
};
use orchestrator::session::SessionTree;
use orchestrator::steering_queue::PendingMessageQueue;

// ── 测试替身 ──────────────────────────────────────────────────────

/// 内存持久化实现（RecoveryStore 契约；events / run 状态 / 路径记账）
#[derive(Debug, Default)]
struct InMemoryRecoveryStore {
    meta: Mutex<HashMap<String, String>>,
    events: Mutex<Vec<(String, String, String)>>,
    run_status: Mutex<HashMap<String, (String, String)>>,
    paths: Mutex<HashMap<String, String>>,
}

impl InMemoryRecoveryStore {
    fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn events(&self) -> Vec<(String, String, String)> {
        self.events.lock().unwrap().clone()
    }
}

impl RecoveryStore for InMemoryRecoveryStore {
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
        subagent_run_id: &str,
        status: &str,
        end_reason: &str,
    ) -> Result<(), RecoveryError> {
        self.run_status.lock().unwrap().insert(
            subagent_run_id.to_string(),
            (status.to_string(), end_reason.to_string()),
        );
        Ok(())
    }

    fn set_subagent_path(
        &self,
        _session_id: &str,
        subagent_run_id: &str,
        path_json: &str,
    ) -> Result<(), RecoveryError> {
        self.paths
            .lock()
            .unwrap()
            .insert(subagent_run_id.to_string(), path_json.to_string());
        Ok(())
    }
}

/// DB 模式持久化：RecoveryStore for LocalDb 的真实落库验证面
/// （session_meta / events 表 / runs 表 / session_agents 行）
struct DbStore {
    db: LocalDb,
}

impl RecoveryStore for DbStore {
    fn get_meta(&self, key: &str) -> Result<Option<String>, RecoveryError> {
        self.db
            .get_session_meta(key)
            .map_err(|e| RecoveryError::PersistFailed {
                message: e.to_string(),
            })
    }

    fn set_meta(&self, key: &str, value: &str) -> Result<(), RecoveryError> {
        self.db
            .set_session_meta(key, value)
            .map_err(|e| RecoveryError::PersistFailed {
                message: e.to_string(),
            })
    }

    fn append_event(
        &self,
        session_id: &str,
        event_type: &str,
        payload: &str,
    ) -> Result<(), RecoveryError> {
        let sequence = self
            .db
            .reserve_sequence(session_id)
            .map_err(|e| RecoveryError::PersistFailed {
                message: e.to_string(),
            })?;
        conex_db::LocalDb::append_event(&self.db, session_id, sequence, event_type, payload)
            .map_err(|e| RecoveryError::PersistFailed {
                message: e.to_string(),
            })
    }

    fn update_run_status(
        &self,
        subagent_run_id: &str,
        status: &str,
        end_reason: &str,
    ) -> Result<(), RecoveryError> {
        let run_status = match status {
            "failed" => RunStatus::Failed,
            "completed" => RunStatus::Completed,
            "cancelled" => RunStatus::Cancelled,
            other => {
                return Err(RecoveryError::InvalidState {
                    message: format!("不支持的 run 终态：{other}"),
                });
            }
        };
        conex_db::LocalDb::update_run_status(
            &self.db,
            subagent_run_id,
            run_status,
            Some(end_reason),
            None,
        )
        .map_err(|e| RecoveryError::PersistFailed {
            message: e.to_string(),
        })
    }

    fn set_subagent_path(
        &self,
        session_id: &str,
        subagent_run_id: &str,
        path_json: &str,
    ) -> Result<(), RecoveryError> {
        let mut agents = self
            .db
            .load_session_agents(session_id)
            .map_err(|e| RecoveryError::PersistFailed {
                message: e.to_string(),
            })?;
        let row = agents
            .iter_mut()
            .find(|a| a.subagent_run_id == subagent_run_id)
            .ok_or_else(|| RecoveryError::NotFound {
                message: format!("子代理行不存在：{subagent_run_id}"),
            })?;
        row.subagent_path_json = Some(path_json.to_string());
        self.db
            .save_session_agents(session_id, &agents)
            .map_err(|e| RecoveryError::PersistFailed {
                message: e.to_string(),
            })
    }
}

/// 记录式 spawner：DB 模式同时落库 session_agents 行（pending 首写即
/// running）；可注入守卫拒绝
struct RecordingSpawner {
    requests: Mutex<Vec<SubagentSpawnRequest>>,
    seq: AtomicUsize,
    db: Option<(LocalDb, String)>,
    reject: bool,
}

impl RecordingSpawner {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            requests: Mutex::new(Vec::new()),
            seq: AtomicUsize::new(0),
            db: None,
            reject: false,
        })
    }

    fn with_db(db: LocalDb, session_id: &str) -> Arc<Self> {
        Arc::new(Self {
            requests: Mutex::new(Vec::new()),
            seq: AtomicUsize::new(0),
            db: Some((db, session_id.to_string())),
            reject: false,
        })
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
        if self.reject {
            return Err(SubagentSpawnError::SpawnFailed("模拟 spawn 失败".to_string()));
        }
        let n = self.seq.fetch_add(1, Ordering::SeqCst);
        let run_id = format!("fork-run-{n}");
        if let Some((db, session_id)) = &self.db {
            let mut agents = db
                .load_session_agents(session_id)
                .map_err(|e| SubagentSpawnError::PersistFailed(e.to_string()))?;
            agents.push(SessionAgent {
                id: format!("sub-{n}"),
                subagent_run_id: run_id.clone(),
                parent_session_id: session_id.clone(),
                parent_run_id: String::new(),
                parent_tool_call_id: None,
                description: "恢复 fork（C7 阶梯 3，承接同一目标）".to_string(),
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
            });
            db.save_session_agents(session_id, &agents)
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

// ── 构造助手 ──────────────────────────────────────────────────────

/// 失败上下文构造（同窗口：创建于 1 秒前，注入 100B ≤ 10KB 窗口 80%）
fn failure_ctx(
    run_id: &str,
    kind: ProviderErrorKind,
    retries: u32,
    elapsed_ms: u64,
) -> RunFailureContext {
    RunFailureContext {
        subagent_id: "sub-a".to_string(),
        subagent_run_id: run_id.to_string(),
        task: "完成模块 A".to_string(),
        error_kind: kind,
        retries,
        retry_elapsed_ms: elapsed_ms,
        produced_content: false,
        from_leaf_id: Some("leaf-a".to_string()),
        started_at_ms: now_ms() - 1_000,
        inject_bytes: 100,
        window_bytes: 10_000,
    }
}

/// 当前 UTC 毫秒
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn retry_policy() -> RecoveryRetryPolicy {
    RecoveryRetryPolicy {
        max_retries: 5,
        ..RecoveryRetryPolicy::default()
    }
}

/// 内存环境别名（store / queue / tree / 协调器）
type MemEnv = (
    Arc<InMemoryRecoveryStore>,
    Arc<Mutex<PendingMessageQueue>>,
    Arc<Mutex<SessionTree>>,
    RecoveryCoordinator,
);

/// 新建内存环境（队列 / 会话树含根叶子 leaf-a / 记录 spawner）
fn setup_mem() -> MemEnv {
    let store = InMemoryRecoveryStore::new();
    let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
    let tree = Arc::new(Mutex::new(SessionTree::new("s1")));
    tree.lock()
        .unwrap()
        .append("leaf-a", serde_json::json!({ "text": "root" }))
        .unwrap();
    let spawner = RecordingSpawner::new();
    let coordinator = RecoveryCoordinator::new(
        "s1",
        store.clone(),
        queue.clone(),
        tree.clone(),
        spawner,
        retry_policy(),
    )
    .expect("协调器构造失败");
    (store, queue, tree, coordinator)
}

// ── C7 验收 1：阶梯 1 自动恢复、无 steering ───────────────────────

#[tokio::test]
async fn ladder1_two_transient_errors_recover_without_steering() {
    let (store, queue, _tree, mut coordinator) = setup_mem();
    for (retries, expected_delay_ms) in [(0u32, 750u64), (1, 1500)] {
        let outcome = coordinator
            .on_subagent_run_failure(&failure_ctx(
                "run-1",
                ProviderErrorKind::ServerError,
                retries,
                0,
            ))
            .await
            .expect("阶梯 1 预算内应自动重试");
        assert_eq!(outcome.ladder, RecoveryLadder::Ladder1AutoRetry);
        let RecoveryAction::AutoRetry { attempt, delay } = outcome.action else {
            panic!("期望 AutoRetry");
        };
        assert_eq!(attempt, retries + 1);
        assert_eq!(delay.as_millis() as u64, expected_delay_ms);
    }
    // 无 steering 条目、无通知落库、无留痕事件（重试不计入 run 失败）
    assert!(!queue.lock().unwrap().has_pending());
    assert_eq!(coordinator.pending_notifications(), 0);
    assert!(store.events().is_empty());
}

// ── C7 验收 2：预算耗尽产生 steering 条目且主 agent 可读 ─────────

#[tokio::test]
async fn ladder2_budget_exhausted_creates_steering_readable() {
    let (store, queue, _tree, mut coordinator) = setup_mem();
    let outcome = coordinator
        .on_subagent_run_failure(&failure_ctx(
            "run-1",
            ProviderErrorKind::Network,
            5,
            61_000,
        ))
        .await
        .expect("预算耗尽应升级阶梯 2");
    assert_eq!(outcome.ladder, RecoveryLadder::Ladder2MainAgent);
    // 主 agent 可读：dequeue_all 取到条目，文案含 run / 重试次数
    let mut queue_guard = queue.lock().unwrap();
    let drained = queue_guard.dequeue_all();
    assert_eq!(drained.len(), 1);
    assert!(drained[0].text.contains("run-1"));
    assert!(drained[0].text.contains("5 次"));
    assert!(drained[0].is_steering);
    drop(queue_guard);
    // 通知已落库（验收 5 的重启恢复依据）
    assert_eq!(coordinator.pending_notifications(), 1);
    // 留痕事件：升级 + steering
    let events = store.events();
    let types: Vec<&str> = events.iter().map(|(_, t, _)| t.as_str()).collect();
    assert_eq!(types, vec![RECOVER_ESCALATED_EVENT, RECOVER_STEERING_EVENT]);
}

// ── C7 验收 3：注入激活指令载体面 + acknowledge ─────────────────

#[tokio::test]
async fn ladder2_steering_injectable_and_acknowledgeable() {
    let (store, queue, _tree, mut coordinator) = setup_mem();
    coordinator
        .on_subagent_run_failure(&failure_ctx(
            "run-1",
            ProviderErrorKind::Timeout,
            3,
            61_000,
        ))
        .await
        .expect("应升级阶梯 2");
    // 主 agent 注入激活的载体：steering 条目转为用户消息（下一条消息
    // 边界；经 L1 steer 环送达子代理会话由引擎侧完成——M8 通道已就绪）
    let mut queue_guard = queue.lock().unwrap();
    let mut input = session_loop::input::AgentInputQueue::new();
    let transferred = queue_guard.transfer_follow_up(&mut input);
    assert_eq!(transferred, 1);
    assert!(input.has_follow_up_pending());
    assert_eq!(input.promote_follow_up(), 1);
    let message = input.dequeue().expect("promote 后可消费");
    assert!(message.text().contains("run-1"));
    drop(queue_guard);
    // 引擎侧收到激活指令后 acknowledge：通知关闭，重启不再重排
    assert!(coordinator.acknowledge("run-1").expect("确认应成功"));
    assert!(
        !coordinator.acknowledge("run-1").expect("二次确认应幂等"),
        "幂等：无变更返回 false"
    );
    assert_eq!(coordinator.pending_notifications(), 0);
    // 通知落库为 pending=false（重启后不重排）
    let raw = store
        .meta
        .lock()
        .unwrap()
        .get(RECOVER_NOTIFICATIONS_KEY)
        .cloned()
        .expect("通知必须落库");
    let notifications: Vec<RecoveryNotification> = serde_json::from_str(&raw).unwrap();
    assert_eq!(notifications.len(), 1);
    assert!(!notifications[0].pending);
}

// ── C7 验收 4：fork 新 run + 路径 + 原 run failed + 事件留痕 ──────
// ── （真实 SQLite：session_agents 行 / runs 表 / events 表 / session_meta）

#[tokio::test]
async fn ladder3_fork_persists_path_and_events_in_sqlite() {
    let ws = TempWorkspace::new("recovery_ladder3");
    let db = LocalDb::open(ws.path().join("sessions.db")).expect("打开测试库失败");
    db.insert_session("s1", "会话").expect("插入会话失败");
    // 原 run 先落 runs 表（阶梯 3 置 failed 的前提）
    db.insert_run("run-1", "s1", RunStatus::Running, None, 1)
        .expect("插入 run 失败");
    // 原子代理行落库（阶梯 3 路径写面经 session_agents 行）
    db.save_session_agents(
        "s1",
        &[SessionAgent {
            id: "sub-a".to_string(),
            subagent_run_id: "run-1".to_string(),
            parent_session_id: "s1".to_string(),
            parent_run_id: "run-main".to_string(),
            parent_tool_call_id: None,
            description: String::new(),
            mode: String::new(),
            status: "running".to_string(),
            summary: None,
            messages: Vec::new(),
            started_at: now_ms(),
            ended_at: None,
            depth: Some(1),
            subagent_path_json: None,
            // T-D-07 v6 新列：测试域构造点缺省 None
            task_type: None,
            display_label: None,
            allowed_write_paths_json: None,
        }],
    )
    .expect("原子代理行落库失败");

    let store: Arc<dyn RecoveryStore> = Arc::new(DbStore { db: db.clone() });
    let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
    let tree = Arc::new(Mutex::new(SessionTree::new("s1")));
    tree.lock()
        .unwrap()
        .append("leaf-a", serde_json::json!({ "text": "root" }))
        .unwrap();
    let spawner = RecordingSpawner::with_db(db.clone(), "s1");
    let mut coordinator = RecoveryCoordinator::new(
        "s1",
        store.clone(),
        queue.clone(),
        tree.clone(),
        spawner,
        retry_policy(),
    )
    .expect("协调器构造失败");

    // 前置一次失败（预算耗尽升级）再 fork
    coordinator
        .on_subagent_run_failure(&failure_ctx(
            "run-1",
            ProviderErrorKind::ServerError,
            5,
            61_000,
        ))
        .await
        .expect("应升级阶梯 2");
    let outcome = coordinator
        .fork_and_reassign(&failure_ctx("run-1", ProviderErrorKind::ServerError, 5, 61_000))
        .await
        .expect("fork 应成功");
    assert_eq!(outcome.ladder, RecoveryLadder::Ladder3Fork);
    let RecoveryAction::Forked { record } = outcome.action else {
        panic!("期望 Forked");
    };
    assert_eq!(record.from_run_id, "run-1");
    assert_eq!(record.new_run_id, "fork-run-0");
    assert_eq!(record.context_mode.as_str(), "verbatim", "同窗 ≤80% 字节级继承");

    // subagent_path_json：新 run 行落工作流路径（根 → 新叶子）
    let agents = db.load_session_agents("s1").expect("读取子代理行失败");
    let new_row = agents
        .iter()
        .find(|a| a.subagent_run_id == "fork-run-0")
        .expect("新 run 行必须存在");
    let path: Vec<String> = serde_json::from_str(
        new_row
            .subagent_path_json
            .as_deref()
            .expect("路径必须落库"),
    )
    .expect("路径 JSON 解析失败");
    assert_eq!(path, vec!["leaf-a", "recovery-fork-run-1-0"]);

    // 原 run 置 failed（runs 表经既有 update_run_status 接口）
    let runs = db.query_all_runs().expect("读取 runs 失败");
    let original = runs
        .iter()
        .find(|r| r.run_id == "run-1")
        .expect("原 run 必须存在");
    assert_eq!(original.status, RunStatus::Failed);
    assert_eq!(original.end_reason.as_deref(), Some("recovery-fork"));

    // events 表留痕：升级 + steering（fork 前一次失败）+ fork
    let events = db.query_events("s1", 0, None).expect("读取 events 失败");
    let types: Vec<&str> = events.iter().map(|e| e.event_type.as_str()).collect();
    assert!(types.contains(&RECOVER_ESCALATED_EVENT));
    assert!(types.contains(&RECOVER_STEERING_EVENT));
    assert!(types.contains(&RECOVER_FORK_EVENT));

    // 预算计数落 session_meta（recover_episodes）
    let fp = fingerprint("sub-a", "完成模块 A");
    assert_eq!(coordinator.budget().count(&fp), 1);
    assert!(store
        .get_meta(RECOVER_EPISODES_KEY)
        .unwrap()
        .is_some());

    // 会话树新叶子挂源叶子下
    let tree_guard = tree.lock().unwrap();
    let new_leaf = tree_guard
        .entry(&record.new_leaf_id)
        .expect("fork 叶子必须存在");
    assert_eq!(new_leaf.parent_id.as_deref(), Some("leaf-a"));
}

// ── C7 验收 5：重启后未处理阶梯 2 通知仍在队列 ───────────────────

#[tokio::test]
async fn restart_keeps_unhandled_steering() {
    let ws = TempWorkspace::new("recovery_restart");
    let db = LocalDb::open(ws.path().join("sessions.db")).expect("打开测试库失败");
    db.insert_session("s1", "会话").expect("插入会话失败");
    let store: Arc<dyn RecoveryStore> = Arc::new(DbStore { db: db.clone() });
    let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
    let tree = Arc::new(Mutex::new(SessionTree::new("s1")));
    tree.lock()
        .unwrap()
        .append("leaf-a", serde_json::json!({ "text": "root" }))
        .unwrap();
    let spawner = RecordingSpawner::with_db(db.clone(), "s1");

    // 第一段：升级阶梯 2（未处理即退出）
    let mut coordinator = RecoveryCoordinator::new(
        "s1",
        store.clone(),
        queue.clone(),
        tree.clone(),
        spawner.clone(),
        retry_policy(),
    )
    .expect("协调器构造失败");
    coordinator
        .on_subagent_run_failure(&failure_ctx(
            "run-1",
            ProviderErrorKind::Network,
            4,
            62_000,
        ))
        .await
        .expect("应升级阶梯 2");
    drop(coordinator);

    // 第二段：模拟重启——新协调器 + 新队列，同一库
    let new_queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
    let mut restarted = RecoveryCoordinator::new(
        "s1",
        store.clone(),
        new_queue.clone(),
        tree.clone(),
        spawner.clone(),
        retry_policy(),
    )
    .expect("重启后协调器构造失败");
    assert_eq!(restarted.pending_notifications(), 1, "通知跨重启恢复");
    let restored = restarted
        .restore_steering_notifications()
        .expect("重排应成功");
    assert_eq!(restored, 1, "未处理通知重排入队");
    let drained = new_queue.lock().unwrap().dequeue_all();
    assert_eq!(drained.len(), 1);
    assert!(drained[0].text.contains("run-1"));
}

// ── C7 验收 6：阶梯 3 后仍失败 → 阶梯 4 上报用户 ──────────────────

#[tokio::test]
async fn ladder4_reports_to_user_after_fork_failure() {
    let (store, _queue, _tree, mut coordinator) = setup_mem();
    // 第一次失败：阶梯 1 耗尽 → 阶梯 2 → 主 agent 决策 fork
    let ctx1 = failure_ctx("run-1", ProviderErrorKind::ServerError, 5, 61_000);
    let outcome = coordinator.on_subagent_run_failure(&ctx1).await.unwrap();
    assert_eq!(outcome.ladder, RecoveryLadder::Ladder2MainAgent);
    let fork = coordinator.fork_and_reassign(&ctx1).await.unwrap();
    assert_eq!(fork.ladder, RecoveryLadder::Ladder3Fork);
    // fork 出的新 run 再失败 → 阶梯 1 耗尽 → 阶梯 2 → 主 agent 决策上报
    let ctx2 = failure_ctx("fork-run-0", ProviderErrorKind::ServerError, 5, 61_000);
    let outcome = coordinator.on_subagent_run_failure(&ctx2).await.unwrap();
    assert_eq!(outcome.ladder, RecoveryLadder::Ladder2MainAgent);
    let report = coordinator.report_to_user(&ctx2).unwrap();
    assert_eq!(report.ladder, RecoveryLadder::Ladder4User);
    let RecoveryAction::NeedsUser { report } = report.action else {
        panic!("期望 NeedsUser");
    };
    // 卡在哪一步 + 试过什么 + 建议怎么办
    assert_eq!(report.subagent_run_id, "fork-run-0");
    assert!(
        report
            .attempts
            .iter()
            .any(|a| a.ladder == RecoveryLadder::Ladder1AutoRetry),
        "留痕含阶梯 1 尝试"
    );
    assert!(
        report
            .attempts
            .iter()
            .any(|a| a.ladder == RecoveryLadder::Ladder2MainAgent),
        "留痕含阶梯 2 尝试"
    );
    assert!(
        report
            .attempts
            .iter()
            .any(|a| a.ladder == RecoveryLadder::Ladder3Fork),
        "留痕含阶梯 3 尝试"
    );
    assert!(report.suggestion.contains("人工决策"));
    // 需用户介入标记（UI 可观察）+ 上报事件留痕
    assert!(coordinator.run_needs_user("fork-run-0"));
    let events = store.events();
    let types: Vec<&str> = events.iter().map(|(_, t, _)| t.as_str()).collect();
    assert!(types.contains(&RECOVER_REPORT_EVENT));
}

// ── 恢复预算制：fork 超预算即停、指纹幂等、跨重启恢复 ────────────

#[tokio::test]
async fn budget_limits_forks_per_episode() {
    let store = InMemoryRecoveryStore::new();
    // 预置上限 1（可配位生效：recover_max_episodes=1）
    store
        .set_meta(RECOVER_MAX_EPISODES_KEY, "1")
        .expect("写可配键失败");
    let tree = Arc::new(Mutex::new(SessionTree::new("s1")));
    tree.lock()
        .unwrap()
        .append("leaf-a", serde_json::json!({}))
        .unwrap();
    let mut coordinator = RecoveryCoordinator::new(
        "s1",
        store.clone(),
        Arc::new(Mutex::new(PendingMessageQueue::new())),
        tree.clone(),
        RecordingSpawner::new(),
        retry_policy(),
    )
    .expect("协调器构造失败");
    // 第 1 次 fork：预算内
    let ctx1 = failure_ctx("run-1", ProviderErrorKind::ServerError, 5, 61_000);
    let outcome = coordinator.fork_and_reassign(&ctx1).await.unwrap();
    assert_eq!(outcome.ladder, RecoveryLadder::Ladder3Fork);
    // 第 2 次 fork（同指纹不同 run）：预算超限即停 → 阶梯 4
    let ctx2 = failure_ctx("run-2", ProviderErrorKind::ServerError, 5, 61_000);
    let outcome = coordinator.fork_and_reassign(&ctx2).await.unwrap();
    assert_eq!(outcome.ladder, RecoveryLadder::Ladder4User, "超预算禁止自动恢复");
    assert!(coordinator.run_needs_user("run-2"));
}

#[tokio::test]
async fn fingerprint_idempotent_across_restart() {
    let (store, _queue, _tree, mut coordinator) = setup_mem();
    let ctx1 = failure_ctx("run-1", ProviderErrorKind::Network, 5, 61_000);
    coordinator.fork_and_reassign(&ctx1).await.unwrap();
    // 模拟重启：同一 store 恢复预算计数
    let tree = Arc::new(Mutex::new(SessionTree::new("s1")));
    tree.lock()
        .unwrap()
        .append("leaf-a", serde_json::json!({}))
        .unwrap();
    let mut restarted = RecoveryCoordinator::new(
        "s1",
        store.clone(),
        Arc::new(Mutex::new(PendingMessageQueue::new())),
        tree.clone(),
        RecordingSpawner::new(),
        retry_policy(),
    )
    .expect("重建协调器失败");
    let fp = fingerprint("sub-a", "完成模块 A");
    assert_eq!(restarted.budget().count(&fp), 1, "预算跨重启恢复");
    assert!(restarted.budget().can_recover(&fp));
    // 同指纹同源 run 幂等：返回既有 fork 记录，不重复 spawn、不重复计数
    let outcome = restarted
        .fork_and_reassign(&failure_ctx("run-1", ProviderErrorKind::Network, 5, 61_000))
        .await
        .expect("幂等 fork 应返回既有记录");
    assert_eq!(outcome.ladder, RecoveryLadder::Ladder3Fork);
    assert_eq!(restarted.budget().count(&fp), 1, "幂等：不重复计数");
}
