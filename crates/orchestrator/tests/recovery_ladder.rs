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
//! append_event 与 escalation 复合写经域接口落库）+ RecordingSpawner（DB 模式同时落库
//! session_agents 行——阶梯 3 路径落库用真实库）。

// G2 禁令豁免：测试临时目录清理（非产品删除路径，可恢复语义不适用）。
#![allow(clippy::disallowed_methods)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use agent_tools::tools::subagent::{
    SubagentSpawnError, SubagentSpawnRequest, SubagentSpawnResult, SubagentSpawner, SubagentState,
};
use async_trait::async_trait;
use conex_db::{DbFailure, DbFailureKind, LocalDb, RunStatus};
use conex_test_utils::TempWorkspace;
use conex_types::error::ProviderErrorKind;
use conex_types::SessionAgent;
use orchestrator::recovery::{
    fingerprint, RecoveryAction, RecoveryCoordinator, RecoveryError, RecoveryLadder,
    RecoveryNotification, RecoveryRetryPolicy, RecoveryStore, RunFailureContext,
    RECOVER_ACKNOWLEDGED_EVENT, RECOVER_EPISODES_KEY, RECOVER_ESCALATED_EVENT, RECOVER_FORK_EVENT,
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
    // LK-02：原 run → parent_tool_call_id 记忆（fork 传播断言面）
    parent_tool_calls: Mutex<HashMap<String, Option<String>>>,
}

impl InMemoryRecoveryStore {
    fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn events(&self) -> Vec<(String, String, String)> {
        self.events.lock().unwrap().clone()
    }

    /// LK-02：预置原 run 行的父工具调用 id（fork 传播测试锚）
    fn seed_parent_tool_call(&self, run_id: &str, value: Option<String>) {
        self.parent_tool_calls
            .lock()
            .unwrap()
            .insert(run_id.to_string(), value);
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

    fn append_recovery_report_once(
        &self,
        session_id: &str,
        subagent_run_id: &str,
        payload: &str,
    ) -> Result<bool, RecoveryError> {
        let mut events = self.events.lock().unwrap();
        let already_reported =
            events
                .iter()
                .any(|(existing_session, event_type, existing_payload)| {
                    existing_session == session_id
                        && event_type == RECOVER_REPORT_EVENT
                        && serde_json::from_str::<serde_json::Value>(existing_payload)
                            .ok()
                            .and_then(|value| {
                                value
                                    .get("subagentRunId")
                                    .and_then(serde_json::Value::as_str)
                                    .map(str::to_owned)
                            })
                            .as_deref()
                            == Some(subagent_run_id)
                });
        if already_reported {
            return Ok(false);
        }
        events.push((
            session_id.to_string(),
            RECOVER_REPORT_EVENT.to_string(),
            payload.to_string(),
        ));
        Ok(true)
    }

    fn persist_acknowledgment(
        &self,
        session_id: &str,
        notification_json: &str,
        acknowledgment_payload: &str,
    ) -> Result<(), RecoveryError> {
        let mut meta = self.meta.lock().unwrap();
        let mut events = self.events.lock().unwrap();
        meta.insert(
            RECOVER_NOTIFICATIONS_KEY.to_string(),
            notification_json.to_string(),
        );
        events.push((
            session_id.to_string(),
            RECOVER_ACKNOWLEDGED_EVENT.to_string(),
            acknowledgment_payload.to_string(),
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

    fn get_subagent_parent_tool_call_id(
        &self,
        _session_id: &str,
        subagent_run_id: &str,
    ) -> Result<Option<String>, RecoveryError> {
        // LK-02：查 seed 记忆，缺省 None（未预置 = 行不存在语义）
        Ok(self
            .parent_tool_calls
            .lock()
            .unwrap()
            .get(subagent_run_id)
            .cloned()
            .flatten())
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
        let sequence =
            self.db
                .reserve_sequence(session_id)
                .map_err(|e| RecoveryError::PersistFailed {
                    message: e.to_string(),
                })?;
        // DM-05：RecoveryStore::append_event 的既有签名保持不变；recovery-*
        // 事件按会话级留痕，run_id 列继续恒为 None。
        conex_db::LocalDb::append_event(&self.db, session_id, sequence, event_type, payload, None)
            .map_err(|e| RecoveryError::PersistFailed {
                message: e.to_string(),
            })
    }

    fn persist_acknowledgment(
        &self,
        session_id: &str,
        notification_json: &str,
        acknowledgment_payload: &str,
    ) -> Result<(), RecoveryError> {
        self.db
            .append_event_and_set_session_meta(
                session_id,
                (RECOVER_ACKNOWLEDGED_EVENT, acknowledgment_payload),
                (RECOVER_NOTIFICATIONS_KEY, notification_json),
            )
            .map(|_| ())
            .map_err(|e| RecoveryError::PersistFailed {
                message: e.to_string(),
            })
    }

    fn append_recovery_report_once(
        &self,
        session_id: &str,
        subagent_run_id: &str,
        payload: &str,
    ) -> Result<bool, RecoveryError> {
        self.db
            .append_recovery_report_once(session_id, subagent_run_id, payload)
            .map_err(|e| RecoveryError::PersistFailed {
                message: e.to_string(),
            })
    }

    fn persist_escalation(
        &self,
        session_id: &str,
        notification_json: &str,
        escalation_payload: &str,
        steering_payload: &str,
    ) -> Result<(), RecoveryError> {
        self.db
            .append_two_events_and_set_session_meta(
                session_id,
                (RECOVER_ESCALATED_EVENT, escalation_payload),
                (RECOVER_NOTIFICATIONS_KEY, notification_json),
                (RECOVER_STEERING_EVENT, steering_payload),
            )
            .map(|_| ())
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
        let mut agents =
            self.db
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

    fn persist_fork_completion(
        &self,
        completion: conex_db::RecoveryForkCompletion<'_>,
    ) -> Result<(), RecoveryError> {
        self.db
            .persist_recovery_fork_completion(completion)
            .map(|_| ())
            .map_err(|e| RecoveryError::PersistFailed {
                message: e.to_string(),
            })
    }

    fn get_subagent_parent_tool_call_id(
        &self,
        session_id: &str,
        subagent_run_id: &str,
    ) -> Result<Option<String>, RecoveryError> {
        // LK-02：对齐 recovery_store.rs 的 LocalDb 实现（load_session_agents
        // 过滤原行）；行缺失 = None
        let agents =
            self.db
                .load_session_agents(session_id)
                .map_err(|e| RecoveryError::PersistFailed {
                    message: e.to_string(),
                })?;
        Ok(agents
            .iter()
            .find(|a| a.subagent_run_id == subagent_run_id)
            .and_then(|a| a.parent_tool_call_id.clone()))
    }
}

/// 记录式 spawner：DB 模式同时落库 session_agents 行（pending 首写即
/// running）；可注入一次启动失败并将子代理行归一为 failed。
struct RecordingSpawner {
    requests: Mutex<Vec<SubagentSpawnRequest>>,
    seq: AtomicUsize,
    db: Option<(LocalDb, String)>,
    fail_next_launch: AtomicBool,
}

impl RecordingSpawner {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            requests: Mutex::new(Vec::new()),
            seq: AtomicUsize::new(0),
            db: None,
            fail_next_launch: AtomicBool::new(false),
        })
    }

    fn with_db(db: LocalDb, session_id: &str) -> Arc<Self> {
        Arc::new(Self {
            requests: Mutex::new(Vec::new()),
            seq: AtomicUsize::new(0),
            db: Some((db, session_id.to_string())),
            fail_next_launch: AtomicBool::new(false),
        })
    }

    fn with_db_rejecting_once(db: LocalDb, session_id: &str) -> Arc<Self> {
        Arc::new(Self {
            requests: Mutex::new(Vec::new()),
            seq: AtomicUsize::new(0),
            db: Some((db, session_id.to_string())),
            fail_next_launch: AtomicBool::new(true),
        })
    }

    fn requests(&self) -> Vec<SubagentSpawnRequest> {
        self.requests.lock().unwrap().clone()
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
        let n = self.seq.fetch_add(1, Ordering::SeqCst);
        let run_id = format!("fork-run-{n}");
        let fail_launch = self.fail_next_launch.swap(false, Ordering::SeqCst);
        if let Some((db, session_id)) = &self.db {
            let mut agents = db
                .load_session_agents(session_id)
                .map_err(|e| SubagentSpawnError::PersistFailed(e.to_string()))?;
            agents.push(SessionAgent {
                id: format!("sub-{n}"),
                subagent_run_id: run_id.clone(),
                parent_session_id: session_id.clone(),
                parent_run_id: String::new(),
                // LK-02：对齐真实 spawner 的 row_for 行为——落库透传请求键
                // （sqlite fork 传播测试依赖该真值）
                parent_tool_call_id: req.parent_tool_call_id.clone(),
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
                allowed_write_paths_json: req
                    .allowed_write_paths
                    .as_ref()
                    .map(|paths| serde_json::to_string(paths).expect("路径白名单序列化不应失败")),
                // D-02 LK-04 v9 列：测试域无子会话映射（None）
                sub_session_id: None,
                capability_mode: None,
                model_override: None,
                resumable: true,
                last_heartbeat_ms: None,
            });
            db.save_session_agents(session_id, &agents)
                .map_err(|e| SubagentSpawnError::PersistFailed(e.to_string()))?;
            if fail_launch {
                db.update_session_agent_status(session_id, &run_id, "failed", Some(now_ms()))
                    .map_err(|e| SubagentSpawnError::PersistFailed(e.to_string()))?;
                return Err(SubagentSpawnError::SpawnFailed(
                    "模拟 run 启动失败；子代理行已归一 failed".to_string(),
                ));
            }
        } else if fail_launch {
            return Err(SubagentSpawnError::SpawnFailed(
                "模拟 spawn 失败".to_string(),
            ));
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
        capability_mode: None,
        model_override: None,
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
        .on_subagent_run_failure(&failure_ctx("run-1", ProviderErrorKind::Network, 5, 61_000))
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

#[tokio::test]
async fn ladder2_localdb_escalation_publishes_state_after_atomic_commit() {
    let ws = TempWorkspace::new("recovery_ladder2_atomic_success");
    let db = LocalDb::open(ws.path().join("sessions.db")).expect("打开测试库失败");
    db.insert_session("s1", "会话").expect("插入会话失败");
    let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
    let tree = Arc::new(Mutex::new(SessionTree::new("s1")));
    let mut coordinator = RecoveryCoordinator::new(
        "s1",
        Arc::new(db.clone()),
        queue.clone(),
        tree,
        RecordingSpawner::new(),
        retry_policy(),
    )
    .expect("协调器构造失败");

    let outcome = coordinator
        .on_subagent_run_failure(&failure_ctx(
            "run-atomic-success",
            ProviderErrorKind::Network,
            5,
            61_000,
        ))
        .await
        .expect("LocalDb escalation 应原子成功");
    assert_eq!(outcome.ladder, RecoveryLadder::Ladder2MainAgent);
    assert_eq!(coordinator.pending_notifications(), 1);
    assert_eq!(queue.lock().unwrap().len(), 1);

    let events = db
        .query_events("s1", 0, None)
        .expect("读取 recovery events");
    assert_eq!(
        events
            .iter()
            .map(|event| event.sequence)
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert_eq!(
        events
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>(),
        vec![RECOVER_ESCALATED_EVENT, RECOVER_STEERING_EVENT]
    );
    assert!(events.iter().all(|event| event.run_id.is_none()));
    let escalation_payload: serde_json::Value =
        serde_json::from_str(&events[0].payload).expect("升级 payload JSON 有效");
    let steering_payload: serde_json::Value =
        serde_json::from_str(&events[1].payload).expect("steering payload JSON 有效");
    assert_eq!(escalation_payload["type"], RECOVER_ESCALATED_EVENT);
    assert_eq!(steering_payload["type"], RECOVER_STEERING_EVENT);
    let notification_json = db
        .get_session_meta(RECOVER_NOTIFICATIONS_KEY)
        .expect("读取通知元数据")
        .expect("通知元数据必须与事件同事务落库");
    let notifications: Vec<RecoveryNotification> =
        serde_json::from_str(&notification_json).expect("通知 JSON 有效");
    assert_eq!(notifications.len(), 1);
    assert_eq!(notifications[0].subagent_run_id, "run-atomic-success");
    assert!(notifications[0].pending);
}

#[tokio::test]
async fn ladder2_localdb_failure_does_not_publish_uncommitted_state() {
    let ws = TempWorkspace::new("recovery_ladder2_atomic_failure");
    let db = LocalDb::open(ws.path().join("sessions.db")).expect("打开测试库失败");
    db.insert_session("s1", "会话").expect("插入会话失败");
    db.write_blocking(|conn| {
        conn.execute_batch(
            "CREATE TRIGGER reject_recovery_steering
             BEFORE INSERT ON events
             WHEN NEW.event_type = 'recovery-steering'
             BEGIN SELECT RAISE(ABORT, 'injected recovery batch failure'); END;",
        )
        .map_err(|e| DbFailure {
            message: e.to_string(),
            kind: DbFailureKind::Other("test_trigger".to_string()),
        })?;
        Ok(())
    })
    .expect("创建失败注入触发器");
    let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
    let tree = Arc::new(Mutex::new(SessionTree::new("s1")));
    let mut coordinator = RecoveryCoordinator::new(
        "s1",
        Arc::new(db.clone()),
        queue.clone(),
        tree,
        RecordingSpawner::new(),
        retry_policy(),
    )
    .expect("协调器构造失败");
    let ctx = failure_ctx("run-atomic-failure", ProviderErrorKind::Network, 5, 61_000);

    let error = coordinator
        .on_subagent_run_failure(&ctx)
        .await
        .expect_err("第二个事件注入失败后 escalation 必须失败");
    assert!(matches!(error, RecoveryError::PersistFailed { .. }));
    assert_eq!(coordinator.pending_notifications(), 0);
    assert_eq!(queue.lock().unwrap().len(), 0);
    assert!(db.query_events("s1", 0, None).unwrap().is_empty());
    assert_eq!(
        db.get_session_meta(RECOVER_NOTIFICATIONS_KEY).unwrap(),
        None
    );

    db.write_blocking(|conn| {
        conn.execute_batch("DROP TRIGGER reject_recovery_steering;")
            .map_err(|e| DbFailure {
                message: e.to_string(),
                kind: DbFailureKind::Other("test_trigger".to_string()),
            })?;
        Ok(())
    })
    .expect("移除失败注入触发器");
    coordinator
        .on_subagent_run_failure(&ctx)
        .await
        .expect("失败回滚后同一 escalation 应可重试");
    assert_eq!(coordinator.pending_notifications(), 1);
    assert_eq!(queue.lock().unwrap().len(), 1);
    let events = db.query_events("s1", 0, None).unwrap();
    assert_eq!(
        events
            .iter()
            .map(|event| event.sequence)
            .collect::<Vec<_>>(),
        vec![1, 2],
        "失败事务不能消费事件序号"
    );
}

// ── C7 验收 3：注入激活指令载体面 + acknowledge ─────────────────

#[tokio::test]
async fn ladder2_steering_injectable_and_acknowledgeable() {
    let (store, queue, _tree, mut coordinator) = setup_mem();
    coordinator
        .on_subagent_run_failure(&failure_ctx("run-1", ProviderErrorKind::Timeout, 3, 61_000))
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
            // D-02 LK-04 v9 列：测试域无子会话映射（None）
            sub_session_id: None,
            capability_mode: None,
            model_override: None,
            resumable: true,
            last_heartbeat_ms: None,
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
    let original_tree = tree.lock().unwrap().clone();
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
        .fork_and_reassign(&failure_ctx(
            "run-1",
            ProviderErrorKind::ServerError,
            5,
            61_000,
        ))
        .await
        .expect("fork 应成功");
    assert_eq!(outcome.ladder, RecoveryLadder::Ladder3Fork);
    let RecoveryAction::Forked { record } = outcome.action else {
        panic!("期望 Forked");
    };
    assert_eq!(record.from_run_id, "run-1");
    assert_eq!(record.new_run_id, "fork-run-0");
    assert!(record
        .new_leaf_id
        .starts_with(&format!("recovery-fork-{}-", record.from_run_id)));
    assert!(original_tree.entry(&record.new_leaf_id).is_none());
    assert_eq!(
        record.context_mode.as_str(),
        "verbatim",
        "同窗 ≤80% 字节级继承"
    );

    // subagent_path_json：新 run 行落工作流路径（根 → 新叶子）
    let agents = db.load_session_agents("s1").expect("读取子代理行失败");
    let new_row = agents
        .iter()
        .find(|a| a.subagent_run_id == "fork-run-0")
        .expect("新 run 行必须存在");
    let path: Vec<String> =
        serde_json::from_str(new_row.subagent_path_json.as_deref().expect("路径必须落库"))
            .expect("路径 JSON 解析失败");
    assert_eq!(path, vec!["leaf-a".to_string(), record.new_leaf_id.clone()]);

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
    assert!(store.get_meta(RECOVER_EPISODES_KEY).unwrap().is_some());

    // 会话树新叶子挂源叶子下
    let tree_guard = tree.lock().unwrap();
    let new_leaf = tree_guard
        .entry(&record.new_leaf_id)
        .expect("fork 叶子必须存在");
    assert_eq!(new_leaf.parent_id.as_deref(), Some("leaf-a"));
    assert_eq!(
        tree_guard.entries().len(),
        original_tree.entries().len() + 1,
        "fork id 必须只插入一次"
    );
}

/// spawn 启动失败会留下 failed 子代理行；同一协调器重试复用收口事务，
/// 只保留一个活动 child、一个树分支和一条 recovery-fork 事件。
#[tokio::test]
async fn ladder3_sqlite_spawn_failure_keeps_state_and_retry_completes_once() {
    let ws = TempWorkspace::new("recovery_ladder3_spawn_retry");
    let db = LocalDb::open(ws.path().join("sessions.db")).expect("打开测试库失败");
    db.insert_session("s1", "会话").expect("插入会话失败");
    db.insert_run("run-1", "s1", RunStatus::Running, None, 1)
        .expect("插入 run 失败");
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
            task_type: None,
            display_label: None,
            allowed_write_paths_json: None,
            sub_session_id: None,
            capability_mode: None,
            model_override: None,
            resumable: true,
            last_heartbeat_ms: None,
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
    let original_tree = tree.lock().unwrap().clone();
    let spawner = RecordingSpawner::with_db_rejecting_once(db.clone(), "s1");
    let mut coordinator = RecoveryCoordinator::new(
        "s1",
        store.clone(),
        queue,
        tree.clone(),
        spawner.clone(),
        retry_policy(),
    )
    .expect("协调器构造失败");
    let ctx = failure_ctx("run-1", ProviderErrorKind::ServerError, 5, 61_000);

    let error = coordinator
        .fork_and_reassign(&ctx)
        .await
        .expect_err("第一次启动注入失败必须向上返回");
    assert!(matches!(error, RecoveryError::PersistFailed { .. }));
    assert_eq!(*tree.lock().unwrap(), original_tree, "失败时树必须保持不变");
    assert_eq!(
        coordinator
            .budget()
            .count(&fingerprint("sub-a", "完成模块 A")),
        0,
        "spawn 失败不能消费 fork 预算"
    );
    assert_eq!(spawner.requests().len(), 1);

    let agents_after_failure = db.load_session_agents("s1").expect("读取子代理行失败");
    let failed_child = agents_after_failure
        .iter()
        .find(|agent| agent.subagent_run_id == "fork-run-0")
        .expect("失败的启动仍应保留子代理行");
    assert_eq!(failed_child.status, "failed");
    assert!(failed_child.ended_at.is_some(), "失败行必须记录结束时间");
    let original_run_after_failure = db
        .query_all_runs()
        .expect("读取 runs 失败")
        .into_iter()
        .find(|run| run.run_id == "run-1")
        .expect("原 run 必须存在");
    assert_eq!(original_run_after_failure.status, RunStatus::Running);
    assert_eq!(original_run_after_failure.end_reason, None);
    assert!(
        db.query_events("s1", 0, None)
            .expect("读取 events 失败")
            .iter()
            .all(|event| event.event_type != RECOVER_FORK_EVENT),
        "spawn 失败不能留下成功 fork 事件"
    );

    let outcome = coordinator
        .fork_and_reassign(&ctx)
        .await
        .expect("同一协调器重试应完成 fork");
    let RecoveryAction::Forked { record } = outcome.action else {
        panic!("期望 Forked");
    };
    assert_eq!(record.new_run_id, "fork-run-1");
    assert!(record.new_leaf_id.starts_with("recovery-fork-run-1-"));
    assert_eq!(spawner.requests().len(), 2, "失败尝试一次，重试 spawn 一次");

    let agents_after_retry = db.load_session_agents("s1").expect("读取子代理行失败");
    let failed_child = agents_after_retry
        .iter()
        .find(|agent| agent.subagent_run_id == "fork-run-0")
        .expect("失败 child 行必须保留");
    assert_eq!(failed_child.status, "failed");
    let active_children: Vec<_> = agents_after_retry
        .iter()
        .filter(|agent| agent.subagent_run_id.starts_with("fork-run-") && agent.status == "running")
        .collect();
    assert_eq!(active_children.len(), 1, "只能有一个活动 fork child");
    assert_eq!(active_children[0].subagent_run_id, record.new_run_id);
    let path: Vec<String> = serde_json::from_str(
        active_children[0]
            .subagent_path_json
            .as_deref()
            .expect("活动 child 的工作流路径必须落库"),
    )
    .expect("工作流路径 JSON 必须合法");
    assert_eq!(path, vec!["leaf-a".to_string(), record.new_leaf_id.clone()]);

    let original_run_after_retry = db
        .query_all_runs()
        .expect("读取 runs 失败")
        .into_iter()
        .find(|run| run.run_id == "run-1")
        .expect("原 run 必须存在");
    assert_eq!(original_run_after_retry.status, RunStatus::Failed);
    assert_eq!(
        original_run_after_retry.end_reason.as_deref(),
        Some("recovery-fork")
    );

    let tree_guard = tree.lock().unwrap();
    assert_eq!(
        tree_guard.entries().len(),
        original_tree.entries().len() + 1
    );
    assert_eq!(
        tree_guard.current_leaf_id(),
        Some(record.new_leaf_id.as_str())
    );
    assert_eq!(
        tree_guard
            .entries()
            .iter()
            .filter(|entry| entry.id.starts_with("recovery-fork-"))
            .count(),
        1,
        "重试只能发布一个树分支"
    );
    drop(tree_guard);

    let events = db.query_events("s1", 0, None).expect("读取 events 失败");
    let fork_events: Vec<_> = events
        .iter()
        .filter(|event| event.event_type == RECOVER_FORK_EVENT)
        .collect();
    assert_eq!(fork_events.len(), 1, "重试只能落一条 fork 事件");
    let fork_payload: serde_json::Value =
        serde_json::from_str(&fork_events[0].payload).expect("fork 事件载荷必须合法");
    assert_eq!(
        fork_payload["newRunId"].as_str(),
        Some(record.new_run_id.as_str())
    );
}

// ── LK-02 fork 反查传播（真实 SQLite：session_agents 行真值）──────

/// LK-02 S5 测钉（有行态，真实 sqlite）：原 run 行带 parent_tool_call_id
/// → fork 反查传播到新请求（DbStore 反查路径 + RecordingSpawner 落库
/// 透传，新 run 行同样携带）
#[tokio::test]
async fn ladder3_fork_propagates_parent_tool_call_id_in_sqlite() {
    let ws = TempWorkspace::new("recovery_ladder_lk02");
    let db = LocalDb::open(ws.path().join("sessions.db")).expect("打开测试库失败");
    db.insert_session("s1", "会话").expect("插入会话失败");
    db.insert_run("run-1", "s1", RunStatus::Running, None, 1)
        .expect("插入 run 失败");
    // 原 run 行带父工具调用键（LK-02 反查源）
    db.save_session_agents(
        "s1",
        &[SessionAgent {
            id: "sub-a".to_string(),
            subagent_run_id: "run-1".to_string(),
            parent_session_id: "s1".to_string(),
            parent_run_id: "run-main".to_string(),
            parent_tool_call_id: Some("call-orig-lk02".to_string()),
            description: String::new(),
            mode: String::new(),
            status: "running".to_string(),
            summary: None,
            messages: Vec::new(),
            started_at: now_ms(),
            ended_at: None,
            depth: Some(1),
            subagent_path_json: None,
            task_type: None,
            display_label: None,
            allowed_write_paths_json: None,
            // v9 新列（LK-04 并行契约）：测试域构造点缺省 None
            sub_session_id: None,
            capability_mode: None,
            model_override: None,
            resumable: true,
            last_heartbeat_ms: None,
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
        spawner.clone(),
        retry_policy(),
    )
    .expect("协调器构造失败");

    let outcome = coordinator
        .fork_and_reassign(&failure_ctx(
            "run-1",
            ProviderErrorKind::ServerError,
            5,
            61_000,
        ))
        .await
        .expect("fork 应成功");
    assert_eq!(outcome.ladder, RecoveryLadder::Ladder3Fork);
    let requests = spawner.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].parent_tool_call_id.as_deref(),
        Some("call-orig-lk02"),
        "fork 请求必须经 DbStore 反查传播原行真键"
    );
    // 新 run 行同样携带（RecordingSpawner 落库透传，对齐真实 row_for）
    let agents = db.load_session_agents("s1").expect("读取子代理行失败");
    let new_row = agents
        .iter()
        .find(|a| a.subagent_run_id == "fork-run-0")
        .expect("新 run 行必须存在");
    assert_eq!(
        new_row.parent_tool_call_id.as_deref(),
        Some("call-orig-lk02"),
        "fork 新行必须落库传播键（行面真值）"
    );
}

/// LK-02 S5 测钉（内存 Mock 态）：InMemoryRecoveryStore 预置 parent_tool_call_id 传播验证
#[tokio::test]
async fn ladder3_fork_propagates_parent_tool_call_id_in_memory() {
    let store = InMemoryRecoveryStore::new();
    store.seed_parent_tool_call("run-1", Some("call-orig-mem".to_string()));
    let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
    let tree = Arc::new(Mutex::new(SessionTree::new("s1")));
    tree.lock()
        .unwrap()
        .append("leaf-a", serde_json::json!({ "text": "root" }))
        .unwrap();
    let spawner = RecordingSpawner::new();
    let mut coordinator = RecoveryCoordinator::new(
        "s1",
        store.clone(),
        queue.clone(),
        tree.clone(),
        spawner.clone(),
        retry_policy(),
    )
    .expect("协调器构造失败");

    let outcome = coordinator
        .fork_and_reassign(&failure_ctx(
            "run-1",
            ProviderErrorKind::ServerError,
            5,
            61_000,
        ))
        .await
        .expect("fork 应成功");
    assert_eq!(outcome.ladder, RecoveryLadder::Ladder3Fork);
    let requests = spawner.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].parent_tool_call_id.as_deref(),
        Some("call-orig-mem")
    );
}

/// LK-02 S5 测钉（无行态，真实 sqlite）：原 run 在 session_agents 无行
/// → fork 照常成功且请求 parent_tool_call_id = None（键缺失不阻断恢复）
#[tokio::test]
async fn ladder3_fork_without_row_keeps_none_in_sqlite() {
    let ws = TempWorkspace::new("recovery_ladder_lk02_none");
    let db = LocalDb::open(ws.path().join("sessions.db")).expect("打开测试库失败");
    db.insert_session("s1", "会话").expect("插入会话失败");
    db.insert_run("run-ghost", "s1", RunStatus::Running, None, 1)
        .expect("插入 run 失败");
    // 注意：session_agents 无原 run 行（反查返回 None）

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
        spawner.clone(),
        retry_policy(),
    )
    .expect("协调器构造失败");

    let outcome = coordinator
        .fork_and_reassign(&failure_ctx(
            "run-ghost",
            ProviderErrorKind::ServerError,
            5,
            61_000,
        ))
        .await
        .expect("fork 应成功（缺键不阻断）");
    assert_eq!(outcome.ladder, RecoveryLadder::Ladder3Fork);
    let requests = spawner.requests();
    assert_eq!(requests.len(), 1);
    assert!(
        requests[0].parent_tool_call_id.is_none(),
        "无行态 fork 保持 None"
    );
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
        .on_subagent_run_failure(&failure_ctx("run-1", ProviderErrorKind::Network, 4, 62_000))
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
    assert_eq!(
        outcome.ladder,
        RecoveryLadder::Ladder4User,
        "超预算禁止自动恢复"
    );
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
