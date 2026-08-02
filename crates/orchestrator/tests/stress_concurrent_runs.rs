//! 并发 run 压力测试（PE-11 T11.6.2，SessionSequencer 压力——Q23/T08.12）
//!
//! 场景与断言：
//! - 同会话 10 路并发 run：sequence 唯一连续（会话级原子取号无冲突）、
//!   无持久化失败（无 UNIQUE 冲突 → 无 event-store-write-failed）、
//!   终态记录完整（cursor 落库）；
//! - 跨会话 20 路并发 run：会话级计数器隔离——每会话序列 1..=n 连续。
//!
//! 运行方式（release，显式跑；默认不进常规 CI）：
//!   cargo test -p orchestrator --release --test stress_concurrent_runs -- --ignored --nocapture

mod common;

use std::sync::Arc;
use std::time::Instant;

use conex_db::RunStatus;
use conex_types::events::RunTerminalStatus;
use conex_types::session::AgentEndReason;
use orchestrator::events::{EventQueue, PersistFailureInfo, drive_outcome};
use orchestrator::persist::{InMemoryStore, Store};
use orchestrator::run::RunManager;

use common::{agent_end, agent_start, message_end, outcome};

/// 单 run 全生命周期驱动：agent-start + n 条 message-end + agent-end，
/// 经 drive_outcome 收口终态（返回终态与持久化失败详情）
async fn drive_completed_run(
    store: Arc<dyn Store>,
    session_id: &str,
    run_id: &str,
    message_ends: usize,
) -> (RunTerminalStatus, Option<PersistFailureInfo>) {
    let manager = RunManager::new(store.clone());
    let mut run = manager
        .start_run(session_id, run_id)
        .await
        .expect("注册 run 不应失败");
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1);
    let mut events = vec![agent_start(session_id)];
    for _ in 0..message_ends {
        events.push(message_end(session_id));
    }
    events.push(agent_end(session_id, AgentEndReason::Stop));
    let result = drive_outcome(&mut run, &mut queue, outcome(AgentEndReason::Stop, None, events))
        .await
        .expect("驱动 run 不应失败");
    (result.terminal_status, result.persist_failure)
}

/// 同会话 10 路并发 run：sequence 唯一连续 + 无持久化失败 + 终态完整
///
/// 每 run 50 条持久化事件（agent-start + 48 message-end + agent-end）+ 终态
/// 事件 = 51 事件 × 10 run = 510 事件，全部走共享 SessionSequencer 取号。
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
#[ignore]
async fn stress_same_session_10_concurrent_runs() {
    let mem = Arc::new(InMemoryStore::new());
    let store: Arc<dyn Store> = mem.clone();
    let started = Instant::now();

    let mut handles = Vec::new();
    for i in 0..10u64 {
        let store = store.clone();
        handles.push(tokio::spawn(async move {
            drive_completed_run(store, "s_shared", &format!("r{i}"), 48).await
        }));
    }
    let mut results = Vec::new();
    for handle in handles {
        results.push(handle.await.expect("并发任务不应 panic"));
    }
    let elapsed = started.elapsed();

    for (i, (status, failure)) in results.iter().enumerate() {
        assert_eq!(*status, RunTerminalStatus::Completed, "run {i} 应 completed 收场");
        assert!(failure.is_none(), "run {i} 不得有持久化失败（无 UNIQUE 冲突）");
    }

    // sequence 唯一连续（Q23：会话级原子取号 + UNIQUE 约束 TOCTOU 守卫）
    let stored = mem.events();
    let total = stored.len();
    assert_eq!(total, 510, "10 run × 51 事件全部落库");
    let mut seqs: Vec<u64> = stored.iter().map(|e| e.sequence).collect();
    seqs.sort_unstable();
    assert_eq!(
        seqs,
        (1..=total as u64).collect::<Vec<_>>(),
        "同会话并发 run 序列必须唯一连续（SessionSequencer 压力）"
    );

    // 终态记录完整（T08.4：cursor 落库）
    let runs = mem.runs();
    assert_eq!(runs.len(), 10, "10 条 run 记录全部落库");
    assert!(runs.iter().all(|r| r.status == RunStatus::Completed), "全部 run 终态 completed");
    assert!(runs.iter().all(|r| r.cursor > 0), "终态 cursor 全部落库（T08.4）");

    println!(
        "[stress] 同会话 10 并发 run（各 51 事件，共 {total} 事件）耗时 {elapsed:?}：序列唯一连续、无持久化失败、终态完整"
    );
}

/// 跨会话 20 路并发 run：会话级计数器隔离——每会话序列 1..=6 连续
///
/// 每 run 4 条持久化事件（agent-start + 3 message-end + agent-end）+ 终态
/// 事件 = 6 事件 × 20 会话。
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
#[ignore]
async fn stress_cross_session_20_concurrent_runs() {
    let mem = Arc::new(InMemoryStore::new());
    let store: Arc<dyn Store> = mem.clone();
    let started = Instant::now();

    let mut handles = Vec::new();
    for i in 0..20u64 {
        let store = store.clone();
        handles.push(tokio::spawn(async move {
            drive_completed_run(store, &format!("s{i}"), &format!("r{i}"), 3).await
        }));
    }
    for handle in handles {
        let (status, failure) = handle.await.expect("并发任务不应 panic");
        assert_eq!(status, RunTerminalStatus::Completed, "跨会话 run 应 completed 收场");
        assert!(failure.is_none(), "跨会话并发 run 不得有持久化失败");
    }
    let elapsed = started.elapsed();

    // 每会话序列独立连续（会话级计数器互不干扰）
    let stored = mem.events();
    for i in 0..20u64 {
        let session = format!("s{i}");
        let mut seqs: Vec<u64> = stored
            .iter()
            .filter(|e| e.session_id == session)
            .map(|e| e.sequence)
            .collect();
        seqs.sort_unstable();
        assert_eq!(seqs, vec![1, 2, 3, 4, 5, 6], "会话 {session} 序列应 1..=6 连续");
    }
    assert_eq!(mem.runs().len(), 20, "20 条 run 记录全部落库");
    assert!(mem.runs().iter().all(|r| r.status == RunStatus::Completed), "全部 run 终态 completed");

    println!(
        "[stress] 跨会话 20 并发 run（各 6 事件）耗时 {elapsed:?}：会话级序列隔离正确、终态完整"
    );
}
