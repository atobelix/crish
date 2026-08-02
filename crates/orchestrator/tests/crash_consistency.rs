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

mod common;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use conex_db::{LocalDb, PendingInput, RunStatus, StoredRun};
use conex_types::events::RunTerminalStatus;
use conex_types::session::AgentEndReason;
use orchestrator::events::{EventQueue, drive_outcome};
use orchestrator::persist::{LocalDbStore, SessionSequencer, Store};
use orchestrator::restore::{
    CANCEL_INTERRUPTED_ERROR, INTERRUPTED_ERROR, INTERRUPTED_REASON, RUN_INTERRUPTED_EVENT,
    RestoreManager, RestoreMode, SnapshotError, SnapshotFileStore, SnapshotStore, StateSnapshot,
};
use orchestrator::run::{EVENT_STORE_WRITE_FAILED_REASON, RunError, RunHandle, RunManager};
use orchestrator::session::SessionRecord;

use common::{agent_end, agent_start, message_end, outcome, setup};

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
        }],
        Vec::new(),
        Vec::new(),
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
        let snapshot = StateSnapshot::build(1, 2, Vec::new(), Vec::new(), Vec::new());
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
