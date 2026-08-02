//! F4 孤儿清理宽限期契约测试（AU-04 F4 / PE-08 T08.2 冻结语义测试化）
//!
//! 冻结语义（v1）：
//! - `cleanup_orphan_sessions(active_ids, confirm_empty)`：keepIds 之外、
//!   `updated_at` 距今 < `ORPHAN_GRACE_MS`（300_000ms = 5 分钟）的会话**跳过删除**
//!   （F4 宽限期取定：5 分钟，PE-01 的 24h 常量作废）；
//! - 宽限期可经 session_meta `orphan_grace_ms` 键覆盖（F4 可配性）；
//! - keepIds 内会话恒保留（无论 updated_at 新旧）；
//! - 空 keepIds 的 confirm 把关在壳层（session_commands guard 已有测试），
//!   库层对空 keepIds 仍执行宽限期保护（近宽限期内新建的会话保留）。
//!
//! 与现有覆盖的关系：
//! - 壳层守卫（空 keepIds 拒绝 / confirm_empty=true 放行）已由
//!   `apps/agent-workbench/src-tauri/src/session_commands.rs` 内联测试锚定；
//! - 库层「删除孤儿行」基础路径已由 conex-db `src/lib.rs` 内联测试锚定；
//! - 本文件补齐**宽限期语义**（F4 冻结表中此前唯一未测试化的部分）。
//!
//! 运行：`cargo test -p conex-db --test orphan_grace_contract`

use std::time::{SystemTime, UNIX_EPOCH};

use conex_db::{LocalDb, ORPHAN_GRACE_MS, ORPHAN_GRACE_MS_KEY};
use conex_types::SessionIndexEntry;

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

/// 断言语义汇总：清理后剩余会话 id 集合 == expected
fn assert_remaining_ids(db: &LocalDb, expected: &[&str]) {
    let mut actual: Vec<String> = db
        .list_sessions()
        .unwrap()
        .into_iter()
        .map(|e| e.id)
        .collect();
    actual.sort();
    let mut sorted_expected: Vec<&str> = expected.to_vec();
    sorted_expected.sort();
    assert_eq!(actual, sorted_expected, "清理后剩余会话集合不符");
}

/// 宽限期冻结值：300_000ms = 5 分钟（F4 取定，PE-01 24h 常量作废）
#[test]
fn grace_period_constant_is_five_minutes() {
    assert_eq!(ORPHAN_GRACE_MS, 300_000, "F4 宽限期取定 5 分钟");
    assert_eq!(ORPHAN_GRACE_MS_KEY, "orphan_grace_ms", "可配键冻结");
}

/// 宽限期内的孤儿会话跳过删除（updated_at 距今 < 5 分钟）
#[test]
fn orphan_within_grace_period_is_preserved() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&entry("recent", now_ms() - 60_000)).unwrap();
    db.upsert_session_entry(&entry("old", now_ms() - 2 * ORPHAN_GRACE_MS)).unwrap();
    // keepIds 另含一个保留目标（非孤儿）
    db.upsert_session_entry(&entry("keep", now_ms())).unwrap();

    let deleted = db.cleanup_orphan_sessions(&["keep".to_string()]).unwrap();

    assert_eq!(deleted, 1, "仅超宽限期的孤儿被删除");
    assert_remaining_ids(&db, &["keep", "recent"]);
}

/// 超过宽限期的孤儿会话被删除（updated_at 距今 ≥ 5 分钟）
#[test]
fn orphan_beyond_grace_period_is_deleted() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&entry("stale", now_ms() - 2 * ORPHAN_GRACE_MS))
        .unwrap();

    let deleted = db.cleanup_orphan_sessions(&[]).unwrap();

    assert_eq!(deleted, 1);
    assert_remaining_ids(&db, &[]);
}

/// 宽限期可配：session_meta `orphan_grace_ms` 覆盖默认值
/// （F4「session_meta 可配」条款；测试注入 0 → 宽限期保护关闭）
#[test]
fn grace_period_configurable_via_session_meta() {
    let db = LocalDb::open_in_memory().unwrap();
    db.set_session_meta(ORPHAN_GRACE_MS_KEY, "0").unwrap();
    // 1 分钟前的会话：默认宽限期（5 分钟）内应保留，配置为 0 后应删除
    db.upsert_session_entry(&entry("recent", now_ms() - 60_000)).unwrap();

    let deleted = db.cleanup_orphan_sessions(&[]).unwrap();

    assert_eq!(deleted, 1, "orphan_grace_ms=0 时近期孤儿也删除");
    assert_remaining_ids(&db, &[]);
}

/// keepIds 内会话恒保留（即使 updated_at 远超宽限期）
#[test]
fn keep_ids_preserved_beyond_grace_period() {
    let db = LocalDb::open_in_memory().unwrap();
    let ancient = now_ms() - 10 * ORPHAN_GRACE_MS;
    db.upsert_session_entry(&entry("kept", ancient)).unwrap();
    db.upsert_session_entry(&entry("stale", ancient)).unwrap();

    let deleted = db.cleanup_orphan_sessions(&["kept".to_string()]).unwrap();

    assert_eq!(deleted, 1);
    assert_remaining_ids(&db, &["kept"]);
}

/// 空 keepIds（confirm 已由壳层把关后进入库层）仍执行宽限期保护：
/// 近宽限期内新建的会话保留，超期删除（防 boot 窗口误清，F4 语义）
#[test]
fn empty_keep_still_applies_grace() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&entry("recent", now_ms() - 60_000)).unwrap();
    db.upsert_session_entry(&entry("old", now_ms() - 2 * ORPHAN_GRACE_MS)).unwrap();

    let deleted = db.cleanup_orphan_sessions(&[]).unwrap();

    assert_eq!(deleted, 1, "空 keepIds 下宽限期保护仍然生效");
    assert_remaining_ids(&db, &["recent"]);
}
