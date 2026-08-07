//! 崩溃一致性测试（R5-T12）
//!
//! 模拟「进程中断 → 重启恢复」场景，覆盖 T12.1–T12.8 验收项。不真实
//! kill 进程，而是以可执行方式构造崩溃时刻的状态后调用恢复流程：
//! - 崩溃状态数据：in-flight run 以崩溃时刻状态（queued/initializing/
//!   running/awaiting-approval/cancelling）留在库中，事件只落库到崩溃点；
//! - partial 写入：主快照内容截断（进程死于快照写中途）、tmp 文件残留
//!   （进程死于 rename 前）；
//! - 真实重启：SQLite 文件库关闭连接后重新打开（进程退出/重启等效）。
//!
//! 断言语义对齐 03 §1.4 T12 表：
//! - T12.1 杀进程恢复：cancelling→cancelled、其余→failed，审计事件逐条落库；
//! - T12.2 审计序列连续性：被打断 run 的审计事件序列连续无空洞；
//! - T12.3 cursor 口径：打断路径 cursor = 审计事件前会话最大已落库序列
//!   （sequence-1 语义）；
//! - T12.4 半写快照回退：主快照损坏回退 `.prev` + 增量重放，不丢已提交事件；
//! - T12.5 取号单调：恢复后 session_sequence 取号不重复、不回落；
//! - T12.6 终态唯一：恢复后 run-terminal 不重复发出；
//! - T12.7 写失败不假装可回放：end_reason = event-store-write-failed；
//! - pending FIFO 恢复：崩溃前未消费输入按创建时间升序（含 id 决胜）恢复。

// G2 禁令豁免：测试临时目录清理（非产品删除路径，可恢复语义不适用）。
#![allow(clippy::disallowed_methods)]

mod common;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use agent_tools::tools::subagent::{
    SubagentSpawnError, SubagentSpawnRequest, SubagentSpawnResult, SubagentSpawner,
    SubagentState,
};
use async_trait::async_trait;
use conex_db::{LocalDb, PendingInput, RunStatus, StoredRun};
use conex_test_utils::TempWorkspace;
use conex_types::error::ProviderErrorKind;
use conex_types::events::RunTerminalStatus;
use conex_types::session::AgentEndReason;
use conex_types::SessionAgent;
use orchestrator::events::{EventQueue, drive_outcome};
use orchestrator::flow_graph::{
    FlowDeclaration, FlowNode, FlowNodeState, FlowScheduler, FLOW_RELEASED_KEY,
    FLOW_RESERVED_KEY,
};
use orchestrator::lifecycle::SubagentLifecycleService;
use orchestrator::persist::{LocalDbStore, SessionSequencer, Store};
use orchestrator::recovery::{
    fingerprint, RecoveryCoordinator, RecoveryRetryPolicy, RunFailureContext,
};
use orchestrator::restore::{
    CANCEL_INTERRUPTED_ERROR, INTERRUPTED_ERROR, INTERRUPTED_REASON, RUN_INTERRUPTED_EVENT,
    RestoreManager, RestoreMode, SnapshotError, SnapshotFileStore, SnapshotStore, StateSnapshot,
};
use orchestrator::run::{EVENT_STORE_WRITE_FAILED_REASON, RunError, RunHandle, RunManager};
use orchestrator::session::{SessionRecord, SessionTree};
use orchestrator::steering_queue::PendingMessageQueue;

use common::{agent_end, agent_start, message_end, outcome, setup, RecordingCancelSink};

/// 无快照的恢复器（全量重放路径；与 restore.rs 内部测试同构）
struct NoSnapshots;

impl SnapshotStore for NoSnapshots {
    fn load_snapshot(&self) -> Result<(Option<StateSnapshot>, Option<String>), SnapshotError> {
        Ok((None, None))
    }

    fn save_snapshot(&self, _snapshot: &StateSnapshot) -> Result<(), SnapshotError> {
        Ok(())
    }
}

/// 临时快照目录（快照文件 + `.prev` 备份）
fn temp_snapshot_store(name: &str) -> (SnapshotFileStore, PathBuf) {
    let dir = std::env::temp_dir().join(format!(
        "conex_crash_snap_{}_{}_{}",
        std::process::id(),
        name,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("snapshot.json");
    (SnapshotFileStore::new(path), dir)
}

/// 待处理输入构造（created_at 显式给定，控制 FIFO 顺序）
fn pending(id: &str, session_id: &str, run_id: Option<&str>, created_at: i64) -> PendingInput {
    PendingInput {
        id: id.to_string(),
        session_id: session_id.to_string(),
        run_id: run_id.map(str::to_string),
        payload: format!(r#"{{"text":"{id}"}}"#),
        created_at,
    }
}

/// 会话 s1 带叶子状态的快照构造
fn snapshot_with_leaf(generation: u64, last_sequence: u64, leaf: &str) -> StateSnapshot {
    StateSnapshot::build(
        generation,
        last_sequence,
        vec![SessionRecord {
            session_id: "s1".to_string(),
            current_leaf_id: Some(leaf.to_string()),
            branches: Vec::new(),
            context_meta: None,
        }],
        Vec::new(),
        Vec::new(),
        HashMap::new(),
    )
}

// ── T12.1 杀进程恢复：in-flight → interrupted，审计事件逐条落库 ──

#[tokio::test]
async fn crash_restore_interrupts_in_flight_runs_with_status_mapping() {
    let (mem, store) = setup();
    // 崩溃时刻状态：五个 in-flight run + 一个已终态 run
    for (run_id, status) in [
        ("r_queued", RunStatus::Queued),
        ("r_init", RunStatus::Initializing),
        ("r_running", RunStatus::Running),
        ("r_approval", RunStatus::AwaitingApproval),
        ("r_cancelling", RunStatus::Cancelling),
        ("r_done", RunStatus::Completed),
    ] {
        store
            .insert_run(run_id, "s1", status, None, 0)
            .await
            .unwrap();
    }
    store
        .update_run_status("r_done", RunStatus::Completed, Some("stop"), None)
        .await
        .unwrap();

    // 重启恢复
    let outcome = RestoreManager::new()
        .restore(store.as_ref(), &NoSnapshots)
        .await
        .unwrap();

    assert_eq!(outcome.mode, RestoreMode::FullReplay);
    let by_id: HashMap<&str, &StoredRun> = outcome
        .runs
        .iter()
        .map(|r| (r.run_id.as_str(), r))
        .collect();
    // cancelling → cancelled，其余 in-flight → failed
    for id in ["r_queued", "r_init", "r_running", "r_approval"] {
        assert_eq!(by_id[id].status, RunStatus::Failed, "{id} → failed");
        assert_eq!(by_id[id].end_reason.as_deref(), Some(INTERRUPTED_REASON));
    }
    assert_eq!(by_id["r_cancelling"].status, RunStatus::Cancelled);
    assert_eq!(
        by_id["r_cancelling"].end_reason.as_deref(),
        Some(INTERRUPTED_REASON)
    );
    // 终态保真：不打断、不追加审计
    assert_eq!(by_id["r_done"].status, RunStatus::Completed);
    assert_eq!(by_id["r_done"].end_reason.as_deref(), Some("stop"));

    // 审计记录：previousStatus 可追溯，错误文案按路径区分
    assert_eq!(outcome.interrupted.len(), 5);
    let prev: Vec<&str> = outcome
        .interrupted
        .iter()
        .map(|i| i.previous_status.as_str())
        .collect();
    assert_eq!(
        prev,
        vec!["queued", "initializing", "running", "awaiting-approval", "cancelling"]
    );
    assert_eq!(outcome.interrupted[0].error, INTERRUPTED_ERROR);
    assert_eq!(outcome.interrupted[4].error, CANCEL_INTERRUPTED_ERROR);

    // 审计事件逐条落库（每个被打断 run 一条，run-interrupted）
    let events = mem.events();
    let audit: Vec<_> = events
        .iter()
        .filter(|e| e.event_type == RUN_INTERRUPTED_EVENT)
        .collect();
    assert_eq!(audit.len(), 5, "每个被打断的 run 一条审计事件");
    let payload: serde_json::Value = serde_json::from_str(&audit[0].payload).unwrap();
    assert_eq!(payload["previousStatus"], "queued");
    assert_eq!(payload["status"], "failed");
    assert_eq!(payload["reason"], "daemon-restarted");
}

// ── T12.2 + T12.3 审计序列连续无空洞 + cursor = sequence-1 ──

#[tokio::test]
async fn crash_restore_audit_sequences_contiguous_and_cursor_consistent() {
    let (mem, store) = setup();
    // 崩溃前已落库事件 seq 1..=2（历史 run 的事件流）
    for seq in 1..=2u64 {
        store
            .append_event("s1", seq, "agent-start", "{}")
            .await
            .unwrap();
    }
    store
        .insert_run("r_prev", "s1", RunStatus::Completed, Some("stop"), 2)
        .await
        .unwrap();
    store
        .insert_run("r_crash", "s1", RunStatus::Running, None, 2)
        .await
        .unwrap();

    let outcome = RestoreManager::new()
        .restore(store.as_ref(), &NoSnapshots)
        .await
        .unwrap();

    // T12.2：审计事件序列续接崩溃前最大序列之后，连续无空洞
    let audit_seqs: Vec<u64> = mem
        .events()
        .iter()
        .filter(|e| e.event_type == RUN_INTERRUPTED_EVENT)
        .map(|e| e.sequence)
        .collect();
    assert_eq!(audit_seqs, vec![3], "审计序列 = 崩溃前 max(sequence)+1");
    // 全事件序列连续（1..=3，无空洞）
    let mut all: Vec<u64> = mem.events().iter().map(|e| e.sequence).collect();
    all.sort_unstable();
    assert_eq!(all, vec![1, 2, 3]);

    // T12.3：cursor = 审计事件前会话最大已落库序列（sequence-1 语义）
    let by_id: HashMap<&str, &StoredRun> = outcome
        .runs
        .iter()
        .map(|r| (r.run_id.as_str(), r))
        .collect();
    assert_eq!(by_id["r_crash"].cursor, 2, "cursor = 审计序列 - 1");
    assert_eq!(by_id["r_crash"].status, RunStatus::Failed);
    // 终态 run 不打断、cursor 保真
    assert_eq!(by_id["r_prev"].status, RunStatus::Completed);
    assert_eq!(by_id["r_prev"].cursor, 2);
}

// ── T12.4 半写快照回退 .prev + 增量重放，不丢已提交事件 ──

#[tokio::test]
async fn half_written_snapshot_falls_back_to_prev_and_replays_increment() {
    let (snapshots, dir) = temp_snapshot_store("halfwrite");
    let (_mem, store) = setup();
    // 已提交事件 1..=8（events 表为权威数据源，快照只是加速）
    for seq in 1..=8u64 {
        store
            .append_event("s1", seq, "agent-start", "{}")
            .await
            .unwrap();
    }
    // 两次完好快照：v2 保存时 v1 轮转为 .prev
    let v1 = snapshot_with_leaf(1, 3, "leaf_v1");
    let v2 = snapshot_with_leaf(2, 5, "leaf_v2");
    snapshots.save_snapshot(&v1).unwrap();
    snapshots.save_snapshot(&v2).unwrap();
    // 快照后新提交事件（seq 6..=8）——崩溃发生在下一次快照之前

    // 模拟进程死于主快照写中途：主快照内容截断（半写 JSON，checksum 必失效）
    let main = dir.join("snapshot.json");
    let raw = std::fs::read_to_string(&main).unwrap();
    let half = &raw[..raw.len() / 2];
    std::fs::write(&main, half).unwrap();
    // 模拟 tmp 半写残留（进程死于 rename 前）
    std::fs::write(
        dir.join(format!("snapshot.json.{}.tmp", std::process::id())),
        r#"{"type":"orchestrator-state-snapshot""#,
    )
    .unwrap();

    // 重启恢复：主快照损坏 → 回退 .prev（v1）
    let outcome = RestoreManager::new()
        .restore(store.as_ref(), &snapshots)
        .await
        .unwrap();

    assert_eq!(outcome.mode, RestoreMode::SnapshotIncremental);
    let note = outcome.snapshot_note.as_deref().unwrap_or_default();
    assert!(note.contains("回退"), "应有回退说明：{note}");
    assert_eq!(
        outcome.sessions[0].current_leaf_id.as_deref(),
        Some("leaf_v1"),
        "回退到上一完好备份快照（v1，而非半写的 v2）"
    );
    // 增量重放：v1.lastSequence=3 之后的事件 4..=8 全部重放，锚点推进
    assert_eq!(outcome.last_sequence, 8, "锚点推进到全部增量事件");
    // 不丢已提交事件：权威源 events 表全量可读（快照回退不影响）
    let events = store.query_events("s1", 0).await.unwrap();
    assert_eq!(events.len(), 8, "快照回退不丢已提交事件");

    let _ = std::fs::remove_dir_all(&dir);
}

// ── T12.5 恢复后取号单调：不重复、不回落 ──

#[tokio::test]
async fn restore_then_sequence_reservations_monotonic_and_continue() {
    let (mem, store) = setup();
    // 崩溃前已落库事件 1..=5
    for seq in 1..=5u64 {
        store
            .append_event("s1", seq, "agent-start", "{}")
            .await
            .unwrap();
    }
    store
        .insert_run("r1", "s1", RunStatus::Running, None, 5)
        .await
        .unwrap();

    // 恢复：r1 → interrupted，审计事件 seq 6，cursor 回填 5
    let restored = RestoreManager::new()
        .restore(store.as_ref(), &NoSnapshots)
        .await
        .unwrap();
    assert_eq!(restored.interrupted.len(), 1);
    assert_eq!(restored.runs[0].cursor, 5, "打断路径 cursor 回填");

    // 生产行为：恢复后 seed 预热（按库内 max+1 对齐）后取号单调
    let sequencer = SessionSequencer::new(store.clone());
    sequencer.seed("s1", 7).await.unwrap();
    assert_eq!(sequencer.reserve("s1").await.unwrap(), 7, "取号 = 恢复后 max+1");
    assert_eq!(sequencer.reserve("s1").await.unwrap(), 8, "取号单调不回退");

    // 恢复后新 run 续接序列（无重复无回落，9 起为已消费取号后的续接），终态唯一
    let manager = RunManager::new(store.clone());
    let mut run = manager.start_run("s1", "r2").await.unwrap();
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1);
    let result = drive_outcome(
        &mut run,
        &mut queue,
        outcome(
            AgentEndReason::Stop,
            None,
            vec![agent_start("s1"), agent_end("s1", AgentEndReason::Stop)],
        ),
    )
    .await
    .unwrap();
    let seqs: Vec<u64> = result.events.iter().map(|e| e.sequence).collect();
    assert_eq!(seqs, vec![9, 10, 11], "R2 从已消费取号后续接（不重复不回落）");
    assert_eq!(result.terminal_status, RunTerminalStatus::Completed);
    assert!(result.persist_failure.is_none(), "无序列冲突");
    let mut all: Vec<u64> = mem.events().iter().map(|e| e.sequence).collect();
    all.sort_unstable();
    // 7/8 为手动取号（未产生事件），事件流 = 1..=6 + 9..=11：
    // 无重复、不回落到 6 以下（单调性以取号断言为准）
    assert_eq!(all, vec![1, 2, 3, 4, 5, 6, 9, 10, 11], "全事件无重复且不回退");
}

// ── T12.6 终态唯一：恢复不重发 run-terminal，再驱动被拒绝 ──

#[tokio::test]
async fn crash_restore_does_not_reemit_terminal_events() {
    let (mem, store) = setup();
    // 崩溃前：r_done 已终态（run-terminal 已落库 seq 2）；r_active 运行中
    store
        .insert_run("r_done", "s1", RunStatus::Completed, Some("stop"), 2)
        .await
        .unwrap();
    store
        .append_event("s1", 1, "agent-start", "{}")
        .await
        .unwrap();
    store
        .append_event("s1", 2, "run-terminal", r#"{"terminal":"completed"}"#)
        .await
        .unwrap();
    store
        .insert_run("r_active", "s1", RunStatus::Running, None, 2)
        .await
        .unwrap();

    let restored = RestoreManager::new()
        .restore(store.as_ref(), &NoSnapshots)
        .await
        .unwrap();

    // 终态 run 保真不打断；恢复只追加审计事件，不重发 run-terminal
    assert_eq!(restored.interrupted.len(), 1);
    let by_id: HashMap<&str, &StoredRun> = restored
        .runs
        .iter()
        .map(|r| (r.run_id.as_str(), r))
        .collect();
    assert_eq!(by_id["r_done"].status, RunStatus::Completed);
    let terminal_count = mem
        .events()
        .iter()
        .filter(|e| e.event_type == "run-terminal")
        .count();
    assert_eq!(terminal_count, 1, "恢复后 run-terminal 仍只有一条");

    // 恢复后的终态记录再驱动 → TerminalImmutable（不产生第二个终态事件）
    let mut handle = RunHandle::new("r_done", "s1", RunStatus::Completed);
    let mut queue = EventQueue::new(store.clone(), 10);
    let err = drive_outcome(
        &mut handle,
        &mut queue,
        outcome(
            AgentEndReason::Stop,
            None,
            vec![agent_start("s1"), agent_end("s1", AgentEndReason::Stop)],
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(err, RunError::TerminalImmutable);
}

// ── T12.7 写失败不假装可回放 ──

#[tokio::test]
async fn event_store_write_failure_does_not_pretend_replayable() {
    let (mem, store) = setup();
    // 事件存储彻底损坏（写失败 latch，模拟磁盘只读）
    mem.fail_all_appends("disk is read-only");
    let manager = RunManager::new(store.clone());
    let mut run = manager.start_run("s1", "r1").await.unwrap();
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1);

    let result = drive_outcome(
        &mut run,
        &mut queue,
        outcome(
            AgentEndReason::Stop,
            None,
            vec![
                agent_start("s1"),
                message_end("s1"),
                agent_end("s1", AgentEndReason::Stop),
            ],
        ),
    )
    .await
    .unwrap();

    // 持久化失败被上报，run 收口 failed(event-store-write-failed)
    assert!(result.persist_failure.is_some(), "持久化失败应被上报");
    assert_eq!(result.terminal_status, RunTerminalStatus::Failed);
    assert_eq!(result.end_reason, EVENT_STORE_WRITE_FAILED_REASON);
    // 不假装可回放：事件存储无一落库；终态事件尽力发出但未持久化
    assert!(mem.events().is_empty(), "写失败不得留下已持久化事件");
    assert!(
        result.events.iter().all(|e| !e.persisted),
        "终态事件未持久化（尽力发出，不产生已持久化假象）"
    );
    let runs = mem.runs();
    assert_eq!(runs[0].status, RunStatus::Failed);
    assert_eq!(
        runs[0].end_reason.as_deref(),
        Some(EVENT_STORE_WRITE_FAILED_REASON)
    );
    let error = result.terminal_error.as_deref().unwrap_or_default();
    assert!(error.contains("disk is read-only"), "错误文案保留原因：{error}");
}

// ── pending FIFO 恢复：崩溃前未消费输入按创建时间升序 ──

#[tokio::test]
async fn crash_restore_recovers_pending_inputs_in_fifo_order() {
    let (mem, store) = setup();
    store
        .insert_run("r1", "s1", RunStatus::Running, None, 0)
        .await
        .unwrap();
    store
        .insert_run("r2", "s2", RunStatus::Completed, Some("stop"), 0)
        .await
        .unwrap();
    // 崩溃前注入：乱序（p3 创建时间最早），含 after-current-run（无 run 绑定）
    mem.seed_pending_inputs(vec![
        pending("p3", "s1", Some("r1"), 300),
        pending("p1", "s1", None, 100),
        pending("p2", "s1", Some("r1"), 200),
        pending("q1", "s2", None, 50),
    ]);

    let outcome = RestoreManager::new()
        .restore(store.as_ref(), &NoSnapshots)
        .await
        .unwrap();

    // FIFO：会话内创建时间升序，id 决胜（s1 → s2 的会话序）
    let ids: Vec<&str> = outcome
        .pending_inputs
        .iter()
        .map(|p| p.id.as_str())
        .collect();
    assert_eq!(ids, vec!["p1", "p2", "p3", "q1"], "FIFO 恢复顺序");
    assert!(
        outcome.pending_inputs[0].run_id.is_none(),
        "after-current-run 模式保真"
    );
    assert_eq!(outcome.pending_inputs[1].run_id.as_deref(), Some("r1"));
    assert!(outcome.pending_inputs[1].payload.contains("p2"));
    // 不丢失、不重复
    let loaded = store.load_pending_inputs("s1").await.unwrap();
    assert_eq!(loaded.len(), 3);
}

// ── 真实重启路径：SQLite 文件库关闭后重开（进程退出/重启等效） ──

#[tokio::test]
async fn sqlite_restart_full_crash_cycle_recovers_and_continues() {
    let dir = std::env::temp_dir().join(format!(
        "conex_crash_db_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("sessions.db");
    let snapshot_path = dir.join("snapshot.json");
    let session_id = "s1";
    let run_id = "r_crash";

    // 阶段一：进程存活期间写入（会话 + run + 事件 + pending + 快照）
    {
        let db = LocalDb::open(&db_path).unwrap();
        db.insert_session(session_id, session_id).unwrap();
        let store = LocalDbStore::new(db);
        store
            .insert_run(run_id, session_id, RunStatus::Running, None, 2)
            .await
            .unwrap();
        store
            .append_event(session_id, 1, "agent-start", "{}")
            .await
            .unwrap();
        store
            .append_event(session_id, 2, "message-end", "{}")
            .await
            .unwrap();
        store
            .save_pending_input("p1", session_id, Some(run_id), r#"{"text":"hi"}"#)
            .await
            .unwrap();
        let snapshot = StateSnapshot::build(1, 2, Vec::new(), Vec::new(), Vec::new(), HashMap::new());
        SnapshotFileStore::new(&snapshot_path)
            .save_snapshot(&snapshot)
            .unwrap();
    } // 连接关闭 = 模拟进程退出

    // 阶段二：进程重启，重新打开数据库与快照
    let db = LocalDb::open(&db_path).unwrap();
    let mem = Arc::new(LocalDbStore::new(db));
    let store: Arc<dyn Store> = mem.clone();
    let snapshots = SnapshotFileStore::new(&snapshot_path);

    let outcome = RestoreManager::new()
        .restore(store.as_ref(), &snapshots)
        .await
        .unwrap();

    // 快照增量恢复 + in-flight 打断（真实 SQLite 路径）
    assert_eq!(outcome.mode, RestoreMode::SnapshotIncremental);
    assert_eq!(outcome.interrupted.len(), 1);
    assert_eq!(outcome.interrupted[0].previous_status, "running");
    assert_eq!(outcome.interrupted[0].status, "failed");
    assert_eq!(outcome.runs[0].status, RunStatus::Failed);
    assert_eq!(outcome.runs[0].cursor, 2, "打断 cursor = 审计事件前 max(sequence)");
    // pending FIFO 恢复
    assert_eq!(outcome.pending_inputs.len(), 1);
    assert_eq!(outcome.pending_inputs[0].id, "p1");
    // 审计事件落库（SQLite events 表，序列续接 max+1）
    let events = store.query_events(session_id, 0).await.unwrap();
    assert_eq!(events.len(), 3, "2 条历史 + 1 条 run-interrupted");
    assert_eq!(events[2].event_type, RUN_INTERRUPTED_EVENT);
    assert_eq!(events[2].sequence, 3, "审计序列续接 max+1");
    // 恢复后取号单调（SQLite session_sequence 路径）
    let sequencer = SessionSequencer::new(store.clone());
    sequencer.seed(session_id, 4).await.unwrap();
    assert_eq!(
        sequencer.reserve(session_id).await.unwrap(),
        4,
        "取号 = 恢复后 max+1（不重复）"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

// ── T12 扩展（I7-M12）：并发预算跨重启验证 ─────────────────────────
// 同一崩溃窗口内同时落 flow 预算（C6 reserve/release）与 recovery
// Episode 预算（C7 恢复预算制）+ 阶梯 2 通知，重启后三类状态全部恢复：
// - flow 预算按「活跃 + 已终态」重算（reserved=2 / released=1 / in_flight=1），
//   落库键一致（防 double-charge）；
// - recovery Episode 计数保留（不重放授权）、未耗尽仍可恢复；
// - 未处理阶梯 2 通知仍在队列（C7 验收 5）。

/// 崩溃窗口落库 spawner（真实 SQLite：session_agents 行落库，
/// pending 首写即 running——FlowScheduler::load 的状态重建数据源）
struct DbSpawner {
    db: LocalDb,
    session_id: String,
    seq: AtomicUsize,
}

impl DbSpawner {
    fn with_db(db: LocalDb, session_id: &str) -> Arc<Self> {
        Arc::new(Self {
            db,
            session_id: session_id.to_string(),
            seq: AtomicUsize::new(0),
        })
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
        let n = self.seq.fetch_add(1, Ordering::SeqCst);
        let run_id = format!("crash-run-{n}");
        let mut agents = self
            .db
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
        });
        self.db
            .save_session_agents(&self.session_id, &agents)
            .map_err(|e| SubagentSpawnError::PersistFailed(e.to_string()))?;
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

/// 依赖图节点构造（parallel 全开，A→B 依赖）
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

/// 当前 UTC 毫秒
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[tokio::test]
async fn flow_budget_and_recovery_episodes_survive_crash_window() {
    let ws = TempWorkspace::new("crash_flow_recovery");
    let db_path = ws.path().join("sessions.db");
    let session_id = "sess-crash";
    let fp = fingerprint("sub-recovery", "崩溃窗口任务");

    // 阶段一：进程存活期间（flow 预算 + 恢复预算 + 阶梯 2 通知全部落库）
    {
        let db = LocalDb::open(&db_path).unwrap();
        db.insert_session(session_id, "崩溃会话").unwrap();
        let spawner = DbSpawner::with_db(db.clone(), session_id);
        // ── C6 预算：a 完成、b 运行中（reserved=2 / released=1 / in_flight=1）──
        let mut sched =
            FlowScheduler::new(session_id, spawner.clone(), Arc::new(db.clone())).unwrap();
        let adv = sched
            .declare_flow(&FlowDeclaration {
                tasks: vec![flow_node("a", &[]), flow_node("b", &["a"])],
                planner_run_id: Some("planner-1".to_string()),
            })
            .await
            .unwrap();
        let run_a = adv.started[0].subagent_run_id.clone();
        set_row_status(&db, session_id, &run_a, "completed");
        sched
            .on_subagent_terminal(&run_a, SubagentState::Completed)
            .await
            .unwrap();
        // 崩溃：b 运行中未完成，调度器实例丢弃（预留未释放）
        drop(sched);
        // ── C7 预算 + 阶梯 2 通知：fork 消费 1 个 Episode、通知落库（pending）──
        let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        let tree = Arc::new(Mutex::new(SessionTree::new(session_id)));
        tree.lock()
            .unwrap()
            .append("leaf-root", serde_json::json!({}))
            .unwrap();
        let mut coordinator = RecoveryCoordinator::new(
            session_id,
            Arc::new(db.clone()),
            queue.clone(),
            tree.clone(),
            spawner.clone(),
            RecoveryRetryPolicy::default(),
        )
        .unwrap();
        let ctx = RunFailureContext {
            subagent_id: "sub-recovery".to_string(),
            subagent_run_id: "run-1".to_string(),
            task: "崩溃窗口任务".to_string(),
            error_kind: ProviderErrorKind::RateLimit,
            retries: 6,
            retry_elapsed_ms: 61_000,
            produced_content: false,
            from_leaf_id: Some("leaf-root".to_string()),
            started_at_ms: now_ms() - 1_000,
            inject_bytes: 100,
            window_bytes: 10_000,
        };
        // 阶梯 2：通知落库（pending=true，重启后仍可见）
        coordinator.on_subagent_run_failure(&ctx).await.unwrap();
        // 阶梯 3：fork 消费预算（重启后计数保留）
        coordinator.fork_and_reassign(&ctx).await.unwrap();
        assert_eq!(coordinator.budget().count(&fp), 1);
    } // 连接关闭 = 进程退出

    // 阶段二：进程重启（同一库文件重开，等效真实重启）
    let db = LocalDb::open(&db_path).unwrap();
    let spawner = DbSpawner::with_db(db.clone(), session_id);
    let rows = db.load_session_agents(session_id).unwrap();
    let restored =
        FlowScheduler::load(session_id, spawner.clone(), Arc::new(db.clone()), &rows).unwrap();

    // ── flow 预算重算：reserved=2、released=1、in_flight=1（防 double-charge）──
    let budget = restored.budget();
    assert_eq!(budget.in_flight(), 1, "活跃 run 保留预留");
    assert_eq!(budget.reserved(), 2);
    assert_eq!(budget.released(), 1);
    assert_eq!(
        db.get_session_meta(FLOW_RESERVED_KEY).unwrap().as_deref(),
        Some("2"),
        "重算值回写库（与内存一致）"
    );
    assert_eq!(
        db.get_session_meta(FLOW_RELEASED_KEY).unwrap().as_deref(),
        Some("1"),
        "已终态预留被 released 抵消"
    );
    // 节点状态从 session_agents 行重建：a 已终态不重复启动、b 运行中
    assert_eq!(restored.node_state("a"), Some(FlowNodeState::Completed));
    assert_eq!(restored.node_state("b"), Some(FlowNodeState::Running));

    // ── recovery Episode 计数跨重启：保留、未耗尽仍可恢复 ──
    let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
    let tree = Arc::new(Mutex::new(SessionTree::new(session_id)));
    let mut coordinator = RecoveryCoordinator::new(
        session_id,
        Arc::new(db.clone()),
        queue.clone(),
        tree,
        spawner.clone(),
        RecoveryRetryPolicy::default(),
    )
    .unwrap();
    assert_eq!(
        coordinator.budget().count(&fp),
        1,
        "Episode 计数跨重启保留（不重放授权）"
    );
    assert!(coordinator.budget().can_recover(&fp), "预算未耗尽仍可恢复");
    // 阶梯 2 通知跨重启保留（04 C7 验收 5）
    assert_eq!(
        coordinator.pending_notifications(),
        1,
        "未处理通知重启后仍在队列（pending 位）"
    );
    // 重启后恢复队列条目（引擎侧 restore_steering_notifications 接线点）
    coordinator
        .restore_steering_notifications()
        .expect("通知恢复入队必须成功");
    assert!(!queue.lock().unwrap().is_empty(), "重启后 steering 条目重新入队");
}

// ── T-D-09 扩展：kill_all 崩溃一致性（kill_all 后重启，session_agents
//    状态一致）─────────────────────────────────────────────────────
// kill_all 批量终止把 running 行统一归一 failed 并落库（终态收口在服务侧，
// 不依赖引擎异步回写）——进程随后崩溃/重启，行状态必须保持一致；流程编排
// 从行重建后全部节点终态、无残留运行节点（防 double-charge）。

#[tokio::test]
async fn kill_all_rows_stay_terminal_across_restart() {
    let ws = TempWorkspace::new("killall_crash");
    let db_path = ws.path().join("sessions.db");
    let session_id = "sess-killall";
    // 阶段一：声明编排 → spawn 3 个 running 子代理 → 补产出消息 → kill_all
    {
        let db = LocalDb::open(&db_path).unwrap();
        db.insert_session(session_id, "主会话").unwrap();
        let spawner = DbSpawner::with_db(db.clone(), session_id);
        let mut sched =
            FlowScheduler::new(session_id, spawner.clone(), Arc::new(db.clone())).unwrap();
        let adv = sched
            .declare_flow(&FlowDeclaration {
                tasks: vec![
                    flow_node("a", &[]),
                    flow_node("b", &[]),
                    flow_node("c", &[]),
                ],
                planner_run_id: Some("planner-1".to_string()),
            })
            .await
            .unwrap();
        assert_eq!(adv.started.len(), 3, "三个并行节点全部启动");
        // 崩溃窗口内写入的产出消息（重启后必须保留）
        let mut rows = db.load_session_agents(session_id).unwrap();
        let now = now_ms();
        for row in &mut rows {
            row.messages.push(conex_types::SessionMessage {
                id: format!("msg-{}", row.id),
                sender: "user".to_string(),
                text: Some(format!("产出 {}", row.id)),
                thinking: None,
                timestamp: now,
                status: None,
                stream_text_offset: None,
                thinking_time: None,
                tool_calls_json: None,
                blocks_json: None,
                tool_call_results_json: None,
                usage: None,
            });
        }
        db.save_session_agents(session_id, &rows).unwrap();
        // kill_all：逐个投递 L3 强停 + 行归一 failed（终态收口在服务侧）
        let sink = RecordingCancelSink::new(true);
        let service = SubagentLifecycleService::new(Arc::new(db.clone()), sink.clone());
        let outcome = service.kill_all(session_id, "kill_all").unwrap();
        assert_eq!(outcome.terminated.len(), 3);
        assert_eq!(sink.calls().len(), 3, "全部 running run 收到 L3 强停");
        let rows = db.load_session_agents(session_id).unwrap();
        assert!(rows.iter().all(|r| r.status == "failed"));
    } // 连接关闭 = 进程退出（kill_all 之后无其它写入，等效崩溃）

    // 阶段二：重启——session_agents 状态一致（无 running 残留、产出保留）
    let db = LocalDb::open(&db_path).unwrap();
    let rows = db.load_session_agents(session_id).unwrap();
    assert_eq!(rows.len(), 3);
    assert!(
        rows.iter().all(|r| r.status == "failed"),
        "kill_all 后重启：全部行保持 failed（状态一致）"
    );
    assert!(
        rows.iter().all(|r| r.ended_at.is_some()),
        "ended_at 跨重启保留"
    );
    assert!(
        rows.iter().all(|r| !r.messages.is_empty()),
        "产出消息跨重启保留（session_agent_messages 级联）"
    );
    // FlowScheduler 从行重建：全部节点终态、无残留运行节点
    let spawner = DbSpawner::with_db(db.clone(), session_id);
    let restored =
        FlowScheduler::load(session_id, spawner.clone(), Arc::new(db.clone()), &rows).unwrap();
    for node in ["a", "b", "c"] {
        assert_eq!(
            restored.node_state(node),
            Some(FlowNodeState::Failed),
            "节点 {node} 从行重建为终态"
        );
    }
    assert!(restored.flow_terminal(), "编排全终态（无残留节点）");
    assert_eq!(restored.budget_in_flight(), 0, "无运行残留（预算不 double-charge）");
}

// ── PERSIST-02 P1-3：running 中崩溃（无 kill_all）重启归一 ────────
// 子代理运行中进程崩溃 → session_agents 行残留 running；旧实现 restore
// 只处理 runs 表，FlowScheduler::load 重建为 Running 节点（is_ready 要求
// Pending → 永不重派发、流程永久卡死，需人工 kill_all）。修复后 restore
// 对 running 行执行 kill_all 语义归一（failed + ended_at），重启自愈。

#[tokio::test]
async fn running_subagents_normalized_across_crash_restart() {
    let ws = TempWorkspace::new("running_subagents_crash");
    let db_path = ws.path().join("sessions.db");
    let session_id = "sess-running-crash";
    // 阶段一：声明编排 → spawn 3 个 running 子代理 → 直接崩溃（不 kill_all）
    {
        let db = LocalDb::open(&db_path).unwrap();
        db.insert_session(session_id, "主会话").unwrap();
        let spawner = DbSpawner::with_db(db.clone(), session_id);
        let mut sched =
            FlowScheduler::new(session_id, spawner.clone(), Arc::new(db.clone())).unwrap();
        let adv = sched
            .declare_flow(&FlowDeclaration {
                tasks: vec![
                    flow_node("a", &[]),
                    flow_node("b", &[]),
                    flow_node("c", &[]),
                ],
                planner_run_id: Some("planner-1".to_string()),
            })
            .await
            .unwrap();
        assert_eq!(adv.started.len(), 3, "三个并行节点全部启动");
        // 崩溃点：全部行 running、ended_at 未写
        let rows = db.load_session_agents(session_id).unwrap();
        assert_eq!(rows.len(), 3);
        assert!(rows.iter().all(|r| r.status == "running"));
        assert!(rows.iter().all(|r| r.ended_at.is_none()));
    } // 连接关闭 = 进程退出（running 中崩溃，无 kill_all）

    // 阶段二：重启 → restore 归一 running 行 → 编排重建全终态（自愈）
    let db = LocalDb::open(&db_path).unwrap();
    let store = LocalDbStore::new(db.clone());
    let outcome = RestoreManager::new()
        .restore(&store, &NoSnapshots)
        .await
        .unwrap();
    assert!(outcome.runs.is_empty(), "runs 表无主 run（子代理 run 不落 runs 表）");

    // running 行归一 failed + ended_at；终态写面与 kill_all 语义一致
    let rows = db.load_session_agents(session_id).unwrap();
    assert_eq!(rows.len(), 3);
    assert!(
        rows.iter().all(|r| r.status == "failed"),
        "崩溃残留 running 行被 restore 归一 failed：{rows:?}"
    );
    assert!(
        rows.iter().all(|r| r.ended_at.is_some()),
        "ended_at 由 restore 落库"
    );

    // FlowScheduler 从归一后的行重建：全部节点终态、无残留运行节点，
    // 流程不再永久 Running（修复前 is_ready 卡死、需人工 kill_all）
    let spawner = DbSpawner::with_db(db.clone(), session_id);
    let restored =
        FlowScheduler::load(session_id, spawner.clone(), Arc::new(db.clone()), &rows).unwrap();
    for node in ["a", "b", "c"] {
        assert_eq!(
            restored.node_state(node),
            Some(FlowNodeState::Failed),
            "节点 {node} 从归一后行重建为终态"
        );
    }
    assert!(restored.flow_terminal(), "编排全终态（running 中崩溃重启自愈）");
    assert_eq!(restored.budget_in_flight(), 0, "无运行残留（预算不 double-charge）");
}
