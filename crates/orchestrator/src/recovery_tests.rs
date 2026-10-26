// SR-06d · 拆分 · ≠ EL：recovery.rs 测试旁挂第 1 段（include! 接线，无孤儿；
// 全部既有测试原样保留——测试替身 + 阶梯 1 决策表 / 预算制 / fork 三态 /
// steering 条目）。
use super::*;
use std::collections::HashMap;
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use agent_tools::tools::subagent::{
    RecursionGuardRejection, SubagentSpawnError, SubagentSpawnResult,
};
use async_trait::async_trait;
use serde_json::json;

// ── 测试替身 ──────────────────────────────────────────────────

/// 内存持久化实现（RecoveryStore 契约；run 状态与子代理路径记账）
#[derive(Debug, Default)]
struct InMemoryRecoveryStore {
    meta: StdMutex<HashMap<String, String>>,
    fail_next_meta_key: StdMutex<Option<String>>,
    fail_next_event_type: StdMutex<Option<String>>,
    fail_next_status_run: StdMutex<Option<String>>,
    fail_next_path_run: StdMutex<Option<String>>,
    events: StdMutex<Vec<(String, String, String)>>,
    run_status: StdMutex<HashMap<String, (String, String)>>,
    paths: StdMutex<HashMap<String, String>>,
    // LK-02：原 run → parent_tool_call_id 记忆（fork 传播断言面）
    parent_tool_calls: StdMutex<HashMap<String, Option<String>>>,
}

impl InMemoryRecoveryStore {
    fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn events(&self) -> Vec<(String, String, String)> {
        self.events.lock().unwrap().clone()
    }

    fn run_status(&self, run_id: &str) -> Option<(String, String)> {
        self.run_status.lock().unwrap().get(run_id).cloned()
    }

    fn path(&self, run_id: &str) -> Option<String> {
        self.paths.lock().unwrap().get(run_id).cloned()
    }

    fn fail_next_meta_write(&self, key: &str) {
        *self.fail_next_meta_key.lock().unwrap() = Some(key.to_string());
    }

    fn fail_next_event_append(&self, event_type: &str) {
        *self.fail_next_event_type.lock().unwrap() = Some(event_type.to_string());
    }

    fn fail_next_run_status_write(&self, run_id: &str) {
        *self.fail_next_status_run.lock().unwrap() = Some(run_id.to_string());
    }

    fn fail_next_path_write(&self, run_id: &str) {
        *self.fail_next_path_run.lock().unwrap() = Some(run_id.to_string());
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
        let mut fail_next_key = self.fail_next_meta_key.lock().unwrap();
        if fail_next_key.as_deref() == Some(key) {
            *fail_next_key = None;
            return Err(RecoveryError::PersistFailed {
                message: format!("injected failure writing {key}"),
            });
        }
        drop(fail_next_key);
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
        let mut fail_next_type = self.fail_next_event_type.lock().unwrap();
        if fail_next_type.as_deref() == Some(event_type) {
            *fail_next_type = None;
            return Err(RecoveryError::PersistFailed {
                message: format!("injected failure appending {event_type}"),
            });
        }
        drop(fail_next_type);
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
        let mut fail_next_type = self.fail_next_event_type.lock().unwrap();
        if fail_next_type.as_deref() == Some(RECOVER_REPORT_EVENT) {
            *fail_next_type = None;
            return Err(RecoveryError::PersistFailed {
                message: "injected recovery report event failure".to_string(),
            });
        }
        drop(fail_next_type);

        let mut events = self.events.lock().unwrap();
        let already_reported = events.iter().any(|(existing_session, event_type, existing_payload)| {
            existing_session == session_id
                && event_type == RECOVER_REPORT_EVENT
                && serde_json::from_str::<serde_json::Value>(existing_payload)
                    .ok()
                    .and_then(|value| value.get("subagentRunId").and_then(serde_json::Value::as_str).map(str::to_owned))
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
        let mut fail_next_type = self.fail_next_event_type.lock().unwrap();
        if fail_next_type.as_deref() == Some(RECOVER_ACKNOWLEDGED_EVENT) {
            *fail_next_type = None;
            return Err(RecoveryError::PersistFailed {
                message: "injected recovery acknowledgment event failure".to_string(),
            });
        }
        drop(fail_next_type);

        let mut fail_next_key = self.fail_next_meta_key.lock().unwrap();
        if fail_next_key.as_deref() == Some(RECOVER_NOTIFICATIONS_KEY) {
            *fail_next_key = None;
            return Err(RecoveryError::PersistFailed {
                message: "injected recovery notification metadata failure".to_string(),
            });
        }
        drop(fail_next_key);

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
        let mut fail_next_run = self.fail_next_status_run.lock().unwrap();
        if fail_next_run.as_deref() == Some(subagent_run_id) {
            *fail_next_run = None;
            return Err(RecoveryError::PersistFailed {
                message: format!("injected failure updating run {subagent_run_id}"),
            });
        }
        drop(fail_next_run);
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
        let mut fail_next_run = self.fail_next_path_run.lock().unwrap();
        if fail_next_run.as_deref() == Some(subagent_run_id) {
            *fail_next_run = None;
            return Err(RecoveryError::PersistFailed {
                message: format!("injected failure writing path for run {subagent_run_id}"),
            });
        }
        drop(fail_next_run);
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

/// 记录式 spawner：记录请求、自增 run id、可注入守卫拒绝
#[derive(Debug)]
struct RecordingSpawner {
    requests: StdMutex<Vec<SubagentSpawnRequest>>,
    seq: std::sync::atomic::AtomicUsize,
    reject_next: std::sync::atomic::AtomicBool,
}

impl RecordingSpawner {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            requests: StdMutex::new(Vec::new()),
            seq: std::sync::atomic::AtomicUsize::new(0),
            reject_next: std::sync::atomic::AtomicBool::new(false),
        })
    }

    fn rejecting_once() -> Arc<Self> {
        Arc::new(Self {
            requests: StdMutex::new(Vec::new()),
            seq: std::sync::atomic::AtomicUsize::new(0),
            reject_next: std::sync::atomic::AtomicBool::new(true),
        })
    }

    fn requests(&self) -> Vec<SubagentSpawnRequest> {
        self.requests.lock().unwrap().clone()
    }
}

#[async_trait]
impl SubagentSpawner for RecordingSpawner {
    async fn spawn(
        &self,
        req: &SubagentSpawnRequest,
    ) -> Result<SubagentSpawnResult, SubagentSpawnError> {
        self.requests.lock().unwrap().push(req.clone());
        if self
            .reject_next
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            return Err(SubagentSpawnError::GuardRejected(
                RecursionGuardRejection::ConcurrentExceeded { current: 7, max: 6 },
            ));
        }
        let n = self.seq.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(SubagentSpawnResult {
            subagent_id: format!("sub-{n}"),
            subagent_run_id: format!("fork-run-{n}"),
            session_id: format!("sess-{n}"),
            status: SubagentState::Running,
            summary: None,
            flow_node_id: None,
            display_label: None,
        })
    }
}

/// 测试环境（队列 + 会话树 + 协调器）
struct Env {
    store: Arc<InMemoryRecoveryStore>,
    queue: Arc<Mutex<PendingMessageQueue>>,
    tree: Arc<Mutex<SessionTree>>,
    spawner: Arc<RecordingSpawner>,
}

fn env() -> (Env, RecoveryCoordinator) {
    let store = InMemoryRecoveryStore::new();
    let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
    let tree = Arc::new(Mutex::new(SessionTree::new("s1")));
    tree.lock()
        .unwrap()
        .append("leaf-a", json!({ "text": "root" }))
        .unwrap();
    let spawner = RecordingSpawner::new();
    let coordinator = RecoveryCoordinator::new(
        "s1",
        store.clone(),
        queue.clone(),
        tree.clone(),
        spawner.clone(),
        RecoveryRetryPolicy {
            max_retries: 5,
            ..RecoveryRetryPolicy::default()
        },
    )
    .unwrap();
    (
        Env {
            store,
            queue,
            tree,
            spawner,
        },
        coordinator,
    )
}

fn ctx(run_id: &str, kind: ProviderErrorKind, retries: u32, elapsed_ms: u64) -> RunFailureContext {
    RunFailureContext {
        subagent_id: "sub-1".to_string(),
        subagent_run_id: run_id.to_string(),
        task: "完成模块 A".to_string(),
        error_kind: kind,
        retries,
        retry_elapsed_ms: elapsed_ms,
        produced_content: false,
        from_leaf_id: Some("leaf-a".to_string()),
        // 创建时间 = 当前时刻前 1 秒（同窗口语义；注入 100B ≤ 窗口 10KB 的 80%）
        started_at_ms: now_ms() - 1_000,
        inject_bytes: 100,
        window_bytes: 10_000,
    }
}

// ── 阶梯 1 决策表 ─────────────────────────────────────────────

/// 决策表：仅瞬态类（rate-limit/5xx/网络/超时）可重试；auth/quota/
/// context_length 等上行（镜像 retry.rs 决策表）
#[test]
fn ladder1_decision_table_mirrors_retry_rs() {
    let policy = RecoveryRetryPolicy {
        max_retries: 3,
        ..RecoveryRetryPolicy::default()
    };
    let cases: &[(ProviderErrorKind, bool)] = &[
        (ProviderErrorKind::RateLimit, true),
        (ProviderErrorKind::ServerError, true),
        (ProviderErrorKind::Timeout, true),
        (ProviderErrorKind::Network, true),
        (ProviderErrorKind::Auth, false),
        (ProviderErrorKind::Quota, false),
        (ProviderErrorKind::ContextLengthExceeded, false),
        (ProviderErrorKind::InvalidRequest, false),
        (ProviderErrorKind::PayloadTooLarge, false),
        (ProviderErrorKind::GatewayChallenge, false),
        (ProviderErrorKind::EndpointUnavailable, false),
        (ProviderErrorKind::Aborted, false),
        (ProviderErrorKind::Unknown, false),
    ];
    for (kind, retryable) in cases {
        let decision = ladder1_decision(*kind, 0, 0, false, &policy);
        match decision {
            Ladder1Decision::Retry { .. } => {
                assert!(*retryable, "{kind:?} 应不可重试");
            }
            Ladder1Decision::Escalate { reason } => {
                assert!(!*retryable, "{kind:?} 应可重试");
                assert_eq!(reason, EscalateReason::NonTransient);
            }
        }
    }
}

/// 退避序列：750 → 1500 → 3000 → 6000 → 8000（8s 封顶，镜像 retry.rs）
#[test]
fn backoff_sequence_exponential_then_capped() {
    let policy = RecoveryRetryPolicy {
        max_retries: 6,
        ..RecoveryRetryPolicy::default()
    };
    let expected = [750u64, 1500, 3000, 6000, 8000, 8000];
    for (index, expected_ms) in expected.iter().enumerate() {
        let attempt = index as u32 + 1;
        assert_eq!(
            backoff_delay_ms(&policy, attempt),
            Duration::from_millis(*expected_ms),
            "attempt {attempt}"
        );
    }
}

/// 总预算耗尽后不再重试（elapsed >= total_budget 即上行）
#[test]
fn ladder1_budget_exhaustion_escalates() {
    let policy = RecoveryRetryPolicy {
        max_retries: 10,
        total_budget_ms: 10_000,
        ..RecoveryRetryPolicy::default()
    };
    // t=0：预算充足 → 退避 750ms
    match ladder1_decision(ProviderErrorKind::ServerError, 0, 0, false, &policy) {
        Ladder1Decision::Retry { attempt, delay, .. } => {
            assert_eq!(attempt, 1);
            assert_eq!(delay, Duration::from_millis(750));
        }
        other => panic!("预算内应可重试：{other:?}"),
    }
    // t=9.5s：剩余 500ms，等待被钳到剩余预算
    match ladder1_decision(ProviderErrorKind::ServerError, 0, 9_500, false, &policy) {
        Ladder1Decision::Retry { delay, .. } => {
            assert_eq!(delay, Duration::from_millis(500));
        }
        other => panic!("预算内应可重试：{other:?}"),
    }
    // t=10s：预算耗尽 → 上行阶梯 2
    match ladder1_decision(ProviderErrorKind::ServerError, 0, 10_000, false, &policy) {
        Ladder1Decision::Escalate { reason } => {
            assert_eq!(reason, EscalateReason::BudgetExhausted);
        }
        other => panic!("预算耗尽应上行：{other:?}"),
    }
}

/// 流已产出内容：中途错误不重试，直接上行（02 §六.7）
#[test]
fn ladder1_produced_content_escalates() {
    let policy = RecoveryRetryPolicy {
        max_retries: 3,
        ..RecoveryRetryPolicy::default()
    };
    let decision = ladder1_decision(ProviderErrorKind::Network, 0, 0, true, &policy);
    assert_eq!(
        decision,
        Ladder1Decision::Escalate {
            reason: EscalateReason::ContentProduced
        }
    );
}

/// 达到 max_retries 后上行（对齐 maxAttempts 语义）
#[test]
fn ladder1_max_retries_escalates() {
    let policy = RecoveryRetryPolicy {
        max_retries: 2,
        ..RecoveryRetryPolicy::default()
    };
    assert!(matches!(
        ladder1_decision(ProviderErrorKind::ServerError, 1, 0, false, &policy),
        Ladder1Decision::Retry { attempt: 2, .. }
    ));
    match ladder1_decision(ProviderErrorKind::ServerError, 2, 0, false, &policy) {
        Ladder1Decision::Escalate { reason } => {
            assert_eq!(reason, EscalateReason::RetriesExhausted);
        }
        other => panic!("次数耗尽应上行：{other:?}"),
    }
    // max_retries=0（默认）：不重试（显式开启才重试）
    let default_policy = RecoveryRetryPolicy::default();
    assert!(matches!(
        ladder1_decision(ProviderErrorKind::ServerError, 0, 0, false, &default_policy),
        Ladder1Decision::Escalate { .. }
    ));
}

// ── 预算制（指纹 + Episode）───────────────────────────────────

/// 指纹稳定性：同 (subagent_id, task) 恒同指纹；不同任务不同指纹
#[test]
fn fingerprint_stable_and_unique() {
    let a1 = fingerprint("sub-1", "完成模块 A");
    let a2 = fingerprint("sub-1", "完成模块 A");
    let b = fingerprint("sub-1", "完成模块 B");
    let c = fingerprint("sub-2", "完成模块 A");
    assert_eq!(a1, a2, "同操作指纹必须稳定");
    assert_ne!(a1, b, "不同任务指纹必须不同");
    assert_ne!(a1, c, "不同子代理指纹必须不同");
    assert_eq!(a1.len(), 16, "FNV-1a 64 位十六进制");
}

/// Episode 预算：默认 3 次；超限拒绝并报 BudgetExceeded
#[test]
fn budget_episode_limit_and_exhaustion() {
    let mut budget = RecoveryBudget::new(3);
    let fp = fingerprint("sub-1", "任务");
    assert!(budget.can_recover(&fp));
    for expected in 1..=3 {
        assert_eq!(budget.record_fork(&fp).unwrap(), expected);
    }
    assert!(!budget.can_recover(&fp), "第 4 次应超限");
    let err = budget.record_fork(&fp).unwrap_err();
    match err {
        RecoveryError::BudgetExceeded {
            fingerprint,
            count,
            max,
        } => {
            assert_eq!(fingerprint, fp);
            assert_eq!(count, 3);
            assert_eq!(max, 3);
        }
        other => panic!("期望 BudgetExceeded：{other:?}"),
    }
}

/// 预算持久化：to_json / from_json 往返；坏 JSON 宽容为空
#[test]
fn budget_json_roundtrip_and_lenient_parse() {
    let mut budget = RecoveryBudget::new(3);
    budget.record_fork("fp-1").unwrap();
    budget.record_fork("fp-1").unwrap();
    budget.record_fork("fp-2").unwrap();
    let restored = RecoveryBudget::from_json(Some(&budget.to_json()), 3);
    assert_eq!(restored.count("fp-1"), 2);
    assert_eq!(restored.count("fp-2"), 1);
    assert_eq!(restored.count("fp-3"), 0);
    assert!(restored.can_recover("fp-1"), "2 < 3 仍有额度");
    // 坏 JSON → 空预算（fail-open 不 panic）
    let lenient = RecoveryBudget::from_json(Some("not-json"), 3);
    assert_eq!(lenient.count("fp-1"), 0);
    let missing = RecoveryBudget::from_json(None, 3);
    assert_eq!(missing.count("fp-1"), 0);
}

// ── fork 三态上下文继承 ───────────────────────────────────────

/// 三态判定：空内容全新 / 同窗 ≤80% 字节级 / 超窗或超占比摘要
#[test]
fn fork_context_three_states() {
    let now = 1_700_000_100_000i64;
    // 空注入内容 → New
    assert_eq!(
        decide_fork_context(now - 1_000, now, 0, 10_000),
        ForkContextMode::New
    );
    // 同窗口且 ≤ 80% → Verbatim
    assert_eq!(
        decide_fork_context(now - 1_000, now, 5_000, 10_000),
        ForkContextMode::Verbatim
    );
    // 恰好 80% → Verbatim（边界含等号）
    assert_eq!(
        decide_fork_context(now - 1_000, now, 8_000, 10_000),
        ForkContextMode::Verbatim
    );
    // 超过 80% → Verbatim（B6 收敛，原 Summarized）
    assert_eq!(
        decide_fork_context(now - 1_000, now, 8_001, 10_000),
        ForkContextMode::Verbatim
    );
    // 超窗（>24h）即使占比小也 → Verbatim（B6 收敛，原 Summarized）
    assert_eq!(
        decide_fork_context(now - FORK_WINDOW_MS - 1, now, 100, 10_000),
        ForkContextMode::Verbatim
    );
    // 恰好 24h 窗内 → Verbatim（边界含等号）
    assert_eq!(
        decide_fork_context(now - FORK_WINDOW_MS, now, 100, 10_000),
        ForkContextMode::Verbatim
    );
}

/// 二态 wire 名（B6 收敛：Summarized 已删除，alias 兼容）
#[test]
fn fork_context_wire_names() {
    assert_eq!(ForkContextMode::Verbatim.as_str(), "verbatim");
    assert_eq!(ForkContextMode::New.as_str(), "new");
    // 历史库 "summarized" 经 alias 反序列化为 Verbatim
    assert_eq!(
        serde_json::from_str::<ForkContextMode>("\"summarized\"").unwrap(),
        ForkContextMode::Verbatim
    );
    assert_eq!(RecoveryLadder::Ladder1AutoRetry.as_str(), "ladder-1");
    assert_eq!(RecoveryLadder::Ladder2MainAgent.as_str(), "ladder-2");
    assert_eq!(RecoveryLadder::Ladder3Fork.as_str(), "ladder-3");
    assert_eq!(RecoveryLadder::Ladder4User.as_str(), "ladder-4");
}

// ── 阶梯 2 steering 条目 ──────────────────────────────────────

/// steering 条目形状：分组去重 + steering 受保护位 + 文案含关键信息
#[test]
fn steering_entry_shape() {
    let notification = RecoveryNotification {
        subagent_id: "sub-1".to_string(),
        subagent_run_id: "run-1".to_string(),
        fingerprint: fingerprint("sub-1", "任务"),
        error_kind: Some(ProviderErrorKind::Network),
        retries: 3,
        remaining_status: "running".to_string(),
        pending: true,
        created_at_ms: 1_700_000_000_000,
    };
    let entry = build_steering_entry(&notification);
    assert!(entry.is_steering, "steering 受保护位");
    assert_eq!(
        entry.group_id.as_deref(),
        Some("recovery-run-1"),
        "同 run 分组去重"
    );
    assert!(entry.text.contains("sub-1"));
    assert!(entry.text.contains("run-1"));
    assert!(entry.text.contains("已重试 3 次"));
    assert!(
        entry.text.contains("网络类错误(Network)"),
        "steering 文案承载具体 kind（区分 rate-limit/server-error 等决策因子）"
    );
    assert!(
        entry.text.contains("接管继续")
            && entry.text.contains("resume_subagent")
            && entry.text.contains("kill_subagent"),
        "三决策路径指引：接管继续 / 重派 / 关闭重来（附命令面提示）"
    );
    // 同分组 replaceOrEnqueue 去重
    let mut queue = PendingMessageQueue::new();
    queue.replace_or_enqueue(build_steering_entry(&notification));
    let replaced = queue.replace_or_enqueue(build_steering_entry(&notification));
    assert!(replaced, "同 run 重复升级应原位替换");
    assert_eq!(queue.len(), 1);
}

/// steering 文案三决策对齐 + kind 缺省降级：error_kind=None（旧数据/
/// 未知）时不出现 kind 段，三决策指引保持完整
#[test]
fn steering_text_kind_degrade_and_three_decisions() {
    let base = RecoveryNotification {
        subagent_id: "sub-1".to_string(),
        subagent_run_id: "run-1".to_string(),
        fingerprint: fingerprint("sub-1", "任务"),
        error_kind: None,
        retries: 2,
        remaining_status: "running".to_string(),
        pending: true,
        created_at_ms: 1_700_000_000_000,
    };
    let text = steering_text(&base);
    assert!(text.contains("接管继续"), "接管决策指引");
    assert!(text.contains("resume_subagent"), "重派命令面提示");
    assert!(text.contains("kill_subagent"), "关闭重来命令面提示");
    assert!(text.contains("已重试 2 次"));
    assert!(!text.contains("类错误"), "None 降级：不含 kind 段");
    // 各分类 kind 段（瞬态四类抽样，AI 决策因子区分的关键）
    for (kind, label) in [
        (ProviderErrorKind::RateLimit, "限速类错误(RateLimit)"),
        (ProviderErrorKind::ServerError, "服务端类错误(ServerError)"),
        (ProviderErrorKind::Timeout, "超时类错误(Timeout)"),
        (ProviderErrorKind::Network, "网络类错误(Network)"),
    ] {
        let with_kind = RecoveryNotification {
            error_kind: Some(kind),
            ..base.clone()
        };
        assert!(
            steering_text(&with_kind).contains(label),
            "kind 段应含 {label}"
        );
    }
}

/// 序列化向后兼容：旧持久化 JSON 无 errorKind 字段 → 反序列化
/// error_kind = None；Some(kind) 序列化为 camelCase 键 + kebab-case wire 名
#[test]
fn notification_serialization_backward_compatible() {
    // 旧形状（无 errorKind 字段，recover_notifications 既有落库形态）
    let legacy = r#"{"subagentId":"sub-1","subagentRunId":"run-1","fingerprint":"fp","retries":3,"remainingStatus":"running","pending":true,"createdAtMs":1700000000000}"#;
    let n: RecoveryNotification = serde_json::from_str(legacy).unwrap();
    assert_eq!(n.error_kind, None, "缺省 None：旧数据可正常读回");
    assert_eq!(n.retries, 3);
    // 新形状 roundtrip：errorKind = "network"（kebab-case wire 名）
    let n2 = RecoveryNotification {
        error_kind: Some(ProviderErrorKind::Network),
        ..n
    };
    let json = serde_json::to_string(&n2).unwrap();
    assert!(
        json.contains("\"errorKind\":\"network\""),
        "error_kind 序列化为 camelCase 键"
    );
    let back: RecoveryNotification = serde_json::from_str(&json).unwrap();
    assert_eq!(back.error_kind, Some(ProviderErrorKind::Network));
}
