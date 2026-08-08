//! F-005 touch 接线红绿测试：run 生命周期落库点刷新会话 updated_at
//!
//! 背景（R2-data-recheck §3 / 99-EXECUTION-FINDINGS F-005）：`touch_session`
//! 生产零调用（仅 conex-db tests.rs 使用），updated_at 只随前端 350ms
//! persist 顺带刷新——「运行期活跃」无独立 touch 链路（结构性缺位）。
//! 本测试验证引擎侧 run 落库点（RunManager::start_run / RunHandle 状态
//! 迁移）承担「运行期活跃」刷新职责：
//! - run 启动后会话 updated_at 被刷新（宽限期重新起算，非仅前端 persist）；
//! - run 活跃期中间态转移（如审批挂起）随动刷新（updated_at 随 run 活动推进）；
//! - 终态落库后可停止刷新（终态后的落库写不再 touch 会话）。
//!
//! 全链路走生产路径：RunManager + LocalDbStore + 真实 SQLite
//! （InMemoryStore 无 sessions 表，touch 为默认 no-op）。
//!
//! 运行：`cargo test -p orchestrator --test run_touch`

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use conex_db::{LocalDb, ORPHAN_GRACE_MS};
use conex_types::events::RunTerminalStatus;
use conex_types::SessionIndexEntry;
use orchestrator::persist::{LocalDbStore, Store};
use orchestrator::run::{RunManager, RunHandle};

/// 当前 epoch 毫秒（与库层 cleanup 的 now_ms 口径一致）
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 构造会话索引条目（updated_at 由调用方注入，时间可控）
fn entry(id: &str, updated_at: i64) -> SessionIndexEntry {
    SessionIndexEntry {
        id: id.to_string(),
        title: format!("Title {id}"),
        folder: "常规会话".to_string(),
        is_pinned: false,
        is_archived: false,
        branch_parent_id: None,
        timestamp: "2026-01-01T00:00:00Z".to_string(),
        updated_at,
        message_count: 0,
        pinned_message_ids: None,
        engine_cursor: None,
        engine_last_run_id: None,
        hydrated_from_engine: None,
    }
}

/// 读取会话 updated_at（刷新断言用）
fn session_updated_at(db: &LocalDb, id: &str) -> i64 {
    db.list_sessions()
        .unwrap()
        .into_iter()
        .find(|e| e.id == id)
        .expect("会话行应存在")
        .updated_at
}

/// 断言 updated_at 已刷新到当前时刻附近（允许 5s 余量；拨旧的宽限期
/// 距离 10 × ORPHAN_GRACE_MS = 50 分钟，量级差异保证不会误判）
fn assert_refreshed(db: &LocalDb, id: &str, what: &str) {
    let refreshed = session_updated_at(db, id);
    let fresh_cutoff = now_ms() - 5_000;
    assert!(
        refreshed >= fresh_cutoff,
        "{what}后会话 updated_at 应被刷新到当前（宽限期重新起算）：实际 {refreshed}，cutoff {fresh_cutoff}"
    );
}

/// 红测试主用例（F-005）：run 启动落库处必须 touch 会话——
/// 超宽限期的会话 updated_at 经 start_run 刷新，孤儿清理宽限期
/// 对该会话重新起算（非仅前端 350ms persist 顺带）。
#[tokio::test]
async fn start_run_refreshes_session_updated_at() {
    let db = LocalDb::open_in_memory().unwrap();
    // 超宽限期（10 × 5 分钟）的会话：无 touch 则宽限期恒过期
    db.upsert_session_entry(&entry("s1", now_ms() - 10 * ORPHAN_GRACE_MS))
        .unwrap();
    let store: Arc<dyn Store> = Arc::new(LocalDbStore::new(db.clone()));
    let manager = RunManager::new(store);

    manager.start_run("s1", "r1").await.unwrap();

    assert_refreshed(&db, "s1", "run 启动");
}

/// 红测试随动用例（F-005）：run 活跃期内中间态转移（审批挂起）落库
/// 同样刷新会话 updated_at——updated_at 随 run 活动推进，而非只在
/// 启动瞬间刷新一次。
#[tokio::test]
async fn intermediate_transition_advances_session_updated_at() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&entry("s1", now_ms())).unwrap();
    let store: Arc<dyn Store> = Arc::new(LocalDbStore::new(db.clone()));
    let manager = RunManager::new(store.clone());
    let mut run = manager.start_run("s1", "r2").await.unwrap();

    // 拨回超宽限期：模拟「run 活跃但会话长时间无任何写」（无 touch 时
    // 宽限期将过期；豁免只防删除，不防宽限期语义退化）
    db.upsert_session_entry(&entry("s1", now_ms() - 10 * ORPHAN_GRACE_MS))
        .unwrap();

    run.request_approval(store.as_ref()).await.unwrap();

    assert_refreshed(&db, "s1", "中间态转移（审批挂起）");
}

/// 终态后停止刷新的契约边界（非红测试，如实标注）：
/// run 收口到终态后，后续的终态记录改写（fail_event_store 已终态翻转
/// failed 分支，update_run_status 落库）不得再 touch 会话——刷新窗口
/// 只覆盖「启动 → 终态」的活跃期。
#[tokio::test]
async fn terminal_rewrite_does_not_refresh_session() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&entry("s1", now_ms())).unwrap();
    let store: Arc<dyn Store> = Arc::new(LocalDbStore::new(db.clone()));
    let manager = RunManager::new(store.clone());
    let mut run: RunHandle = manager.start_run("s1", "r3").await.unwrap();

    run.finalize(
        store.as_ref(),
        RunTerminalStatus::Completed,
        "stop",
        None,
        3,
    )
    .await
    .unwrap();
    assert_eq!(run.status, conex_db::RunStatus::Completed);

    // 终态后拨旧会话时间戳，触发终态后的落库写（已终态翻转 failed）
    db.upsert_session_entry(&entry("s1", now_ms() - 10 * ORPHAN_GRACE_MS))
        .unwrap();
    let before = session_updated_at(&db, "s1");
    run.fail_event_store(store.as_ref(), "终态事件落库失败")
        .await
        .unwrap();
    assert_eq!(run.status, conex_db::RunStatus::Failed, "已终态记录应翻转 failed");

    let after = session_updated_at(&db, "s1");
    assert_eq!(
        after, before,
        "终态后的落库写不应再刷新会话 updated_at（刷新窗口=启动→终态）"
    );
}
