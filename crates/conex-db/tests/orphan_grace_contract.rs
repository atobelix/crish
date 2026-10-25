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
//! 扩展语义（v2，2026-08-07 P0-2 / PERSIST-03 P1-1 修复）：
//! - **引擎子代理会话豁免**：`hydrated_from_engine = 1` 的会话（引擎创建的
//!   sub-sess-*）即使超宽限期、不在 keepIds 也**永不删除**——防孤儿清理
//!   级联删除运行中子代理的会话树 / agents / 审计事件流（append FK 失败
//!   会把子代理 run 标记 failed）；
//! - **活动 run 豁免**：存在非终态 run（running/queued 等）的会话跳过删除；
//! - **自愈行真实 updated_at**：insert_session 写当前时间，宽限期对自愈行生效。
//!
//! 与现有覆盖的关系：
//! - 壳层守卫（空 keepIds 拒绝 / confirm_empty=true 放行）已由
//!   `apps/agent-workbench/src-tauri/src/session_commands.rs` 内联测试锚定；
//! - 库层「删除孤儿行」基础路径已由 conex-db `src/lib.rs` 内联测试锚定；
//! - 本文件补齐**宽限期语义**（F4 冻结表中此前唯一未测试化的部分）。
//!
//! 运行：`cargo test -p conex-db --test orphan_grace_contract`

use std::time::{SystemTime, UNIX_EPOCH};

use conex_db::{LocalDb, RunStatus, ORPHAN_GRACE_MS, ORPHAN_GRACE_MS_KEY};
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

/// 构造引擎子代理会话条目（hydrated_from_engine=true，前端 store 不可见，
/// 与 subagent_spawner 落库形状一致）
fn engine_entry(id: &str, updated_at: i64) -> SessionIndexEntry {
    let mut e = entry(id, updated_at);
    e.hydrated_from_engine = Some(true);
    e
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
    db.upsert_session_entry(&entry("recent", now_ms() - 60_000))
        .unwrap();
    db.upsert_session_entry(&entry("old", now_ms() - 2 * ORPHAN_GRACE_MS))
        .unwrap();
    // keepIds 另含一个保留目标（非孤儿）
    db.upsert_session_entry(&entry("keep", now_ms())).unwrap();

    let deleted = db.cleanup_orphan_sessions(&["keep".to_string()]).unwrap();

    assert_eq!(deleted.len(), 1, "仅超宽限期的孤儿被删除");
    assert_remaining_ids(&db, &["keep", "recent"]);
}

/// 超过宽限期的孤儿会话被删除（updated_at 距今 ≥ 5 分钟）
#[test]
fn orphan_beyond_grace_period_is_deleted() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&entry("stale", now_ms() - 2 * ORPHAN_GRACE_MS))
        .unwrap();

    let deleted = db.cleanup_orphan_sessions(&[]).unwrap();

    assert_eq!(deleted.len(), 1);
    assert_remaining_ids(&db, &[]);
}

/// 宽限期可配：session_meta `orphan_grace_ms` 覆盖默认值
/// （F4「session_meta 可配」条款；测试注入 0 → 宽限期保护关闭）
#[test]
fn grace_period_configurable_via_session_meta() {
    let db = LocalDb::open_in_memory().unwrap();
    db.set_session_meta(ORPHAN_GRACE_MS_KEY, "0").unwrap();
    // 1 分钟前的会话：默认宽限期（5 分钟）内应保留，配置为 0 后应删除
    db.upsert_session_entry(&entry("recent", now_ms() - 60_000))
        .unwrap();

    let deleted = db.cleanup_orphan_sessions(&[]).unwrap();

    assert_eq!(deleted.len(), 1, "orphan_grace_ms=0 时近期孤儿也删除");
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

    assert_eq!(deleted.len(), 1);
    assert_remaining_ids(&db, &["kept"]);
}

/// 空 keepIds（confirm 已由壳层把关后进入库层）仍执行宽限期保护：
/// 近宽限期内新建的会话保留，超期删除（防 boot 窗口误清，F4 语义）
#[test]
fn empty_keep_still_applies_grace() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&entry("recent", now_ms() - 60_000))
        .unwrap();
    db.upsert_session_entry(&entry("old", now_ms() - 2 * ORPHAN_GRACE_MS))
        .unwrap();

    let deleted = db.cleanup_orphan_sessions(&[]).unwrap();

    assert_eq!(deleted.len(), 1, "空 keepIds 下宽限期保护仍然生效");
    assert_remaining_ids(&db, &["recent"]);
}

// ===== v2 扩展语义：P0-2 / PERSIST-03 P1-1（升级 P0）防护 =====

/// PERSIST-03 P1-1 回归：引擎子代理会话（hydrated_from_engine=1）不在前端
/// keepIds、引擎从不刷新 updated_at——宽限期无法保护。清理必须豁免该类
/// 会话，否则长于 5 分钟的子代理 run 中途被级联删除（append FK 失败 →
/// run 标记 failed，审计事件流 / runs 记录静默清除）。
#[test]
fn engine_subagent_session_never_deleted_by_cleanup() {
    let db = LocalDb::open_in_memory().unwrap();
    // 超宽限期的引擎子代理会话（永不被前端 keepIds 覆盖）
    db.upsert_session_entry(&engine_entry(
        "sub-sess-1-0",
        now_ms() - 10 * ORPHAN_GRACE_MS,
    ))
    .unwrap();
    // 超宽限期的普通孤儿会话（应正常被清理）
    db.upsert_session_entry(&entry("stale-user", now_ms() - 10 * ORPHAN_GRACE_MS))
        .unwrap();

    // 空 keepIds（壳层 confirm 后仍会到达库层）
    let deleted = db.cleanup_orphan_sessions(&[]).unwrap();

    assert_eq!(deleted.len(), 1, "仅普通孤儿被清理，引擎子代理会话豁免");
    assert_remaining_ids(&db, &["sub-sess-1-0"]);
}

/// P0-2 boot 窗口场景：keepIds 只含前端可见会话（子代理会话不在其中），
/// 引擎子代理会话仍必须保留——部分 keepIds 不得级联删除子代理会话树。
#[test]
fn engine_subagent_session_preserved_with_partial_keep() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&engine_entry(
        "sub-sess-2-0",
        now_ms() - 10 * ORPHAN_GRACE_MS,
    ))
    .unwrap();
    db.upsert_session_entry(&entry("user-old", now_ms() - 10 * ORPHAN_GRACE_MS))
        .unwrap();
    // boot 窗口新建的会话（前端唯一可见）
    db.upsert_session_entry(&entry("new-user", now_ms()))
        .unwrap();

    let deleted = db
        .cleanup_orphan_sessions(&["new-user".to_string()])
        .unwrap();

    assert_eq!(deleted.len(), 1, "仅超宽限期的普通孤儿被删");
    assert_remaining_ids(&db, &["sub-sess-2-0", "new-user"]);
}

/// P2-7 / P1-1 联动校验：存在非终态 run（running）的会话即使超宽限期、
/// 不在 keepIds 也跳过删除——防「长 run 中途被清」的 FK 失败与审计断链；
/// 只有终态 run（completed）的会话不豁免。
#[test]
fn session_with_active_run_preserved() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&entry("run-active", now_ms() - 10 * ORPHAN_GRACE_MS))
        .unwrap();
    db.insert_run("r1", "run-active", RunStatus::Running, None, 1)
        .unwrap();
    db.upsert_session_entry(&entry("run-done", now_ms() - 10 * ORPHAN_GRACE_MS))
        .unwrap();
    db.insert_run("r2", "run-done", RunStatus::Completed, Some("stop"), 3)
        .unwrap();
    db.upsert_session_entry(&entry("idle", now_ms() - 10 * ORPHAN_GRACE_MS))
        .unwrap();

    let deleted = db.cleanup_orphan_sessions(&[]).unwrap();

    assert_eq!(deleted.len(), 2, "run-done / idle 被清理，run-active 豁免");
    assert_remaining_ids(&db, &["run-active"]);
}

/// 活动 run 豁免覆盖多种非终态：queued 也应保护（排队中的 run 属于活动面）
#[test]
fn session_with_queued_run_preserved() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&entry("run-queued", now_ms() - 10 * ORPHAN_GRACE_MS))
        .unwrap();
    db.insert_run("r3", "run-queued", RunStatus::Queued, None, 0)
        .unwrap();
    db.upsert_session_entry(&entry("stale", now_ms() - 10 * ORPHAN_GRACE_MS))
        .unwrap();

    let deleted = db
        .cleanup_orphan_sessions(&["run-queued".to_string()])
        .unwrap();

    assert_eq!(deleted.len(), 1, "仅 stale 被清理");
    assert_remaining_ids(&db, &["run-queued"]);
}

/// N0-2 ④ 修复：insert_session（自愈路径）写入真实 updated_at，
/// 宽限期对自愈行生效——新建自愈行在宽限期内不被空 keepIds 清理
/// （此前 updated_at=0 使宽限期形同虚设，boot 窗口直接命中）。
#[test]
fn self_heal_row_within_grace_preserved() {
    let db = LocalDb::open_in_memory().unwrap();
    // 模拟 self_heal_then_save_body 的自愈行（insert_session 落库）
    db.insert_session("self-heal", "").unwrap();
    db.upsert_session_entry(&entry("old", now_ms() - 2 * ORPHAN_GRACE_MS))
        .unwrap();

    let deleted = db.cleanup_orphan_sessions(&[]).unwrap();

    assert_eq!(deleted.len(), 1, "仅超宽限期孤儿被删，自愈行保留");
    assert_remaining_ids(&db, &["self-heal"]);
}

// ===== v3 扩展语义：T3.3（D3）孤儿清理 in-flight 保护（PS-03）=====

/// D3 回归：存在未消费 pending_inputs 的会话即使超宽限期、不在 keepIds
/// 也跳过删除——pending 输入未决即会话仍处于运行期产出待消费状态，
/// 级联删除会连 pending 一并清空（任务书 T3.3 验收主用例之二）。
#[test]
fn cleanup_preserves_session_with_unconsumed_pending() {
    let db = LocalDb::open_in_memory().unwrap();
    // 超宽限期 + 不在 keepIds（最严路径：空 keepIds）
    db.upsert_session_entry(&entry("pending-s1", now_ms() - 10 * ORPHAN_GRACE_MS))
        .unwrap();
    db.save_pending_input("p1", "pending-s1", None, "{}")
        .unwrap();
    // 对照：无 pending 的陈旧会话仍应被清理（防护不误伤正常清理）
    db.upsert_session_entry(&entry("idle", now_ms() - 10 * ORPHAN_GRACE_MS))
        .unwrap();

    let deleted = db.cleanup_orphan_sessions(&[]).unwrap();

    assert_eq!(
        deleted.len(),
        1,
        "仅无 pending 的陈旧会话被清理，pending 未决会话豁免"
    );
    assert_remaining_ids(&db, &["pending-s1"]);
    assert_eq!(
        db.load_pending_inputs("pending-s1").unwrap().len(),
        1,
        "pending_inputs 行未被级联删除"
    );
}

/// D3 回归：超宽限期 + 不在 keepIds 的 running run 会话不得被清理
/// （最严路径 `cleanup_orphan_sessions(&[])`——级联会清空运行中 run
/// 及其全部事件；任务书 T3.3 验收主用例之一）。
#[test]
fn cleanup_preserves_session_with_inflight_run() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&entry("s1", now_ms() - 10 * ORPHAN_GRACE_MS))
        .unwrap();
    db.insert_run("r1", "s1", RunStatus::Running, None, 1)
        .unwrap();
    db.append_event("s1", 1, "agent-start", "{}", None).unwrap();

    let deleted = db.cleanup_orphan_sessions(&[]).unwrap();

    assert_eq!(deleted.len(), 0, "最严路径下 running run 会话保留");
    assert_remaining_ids(&db, &["s1"]);
    assert!(db.get_run("r1").unwrap().is_some(), "run 行未被级联删除");
    assert_eq!(
        db.query_events("s1", 0, None).unwrap().len(),
        1,
        "events 未被级联删除"
    );
}

/// D3 回归：宽限期内的 running run 会话同样保留——宽限期与 in-flight
/// 双保护叠加，宽限期内/外口径一致（「有 running run 的会话在宽限期
/// 内/外都不应被清理」）。
#[test]
fn cleanup_preserves_inflight_run_within_grace() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&entry("recent-run", now_ms() - 60_000))
        .unwrap();
    db.insert_run("r2", "recent-run", RunStatus::Running, None, 1)
        .unwrap();

    let deleted = db.cleanup_orphan_sessions(&["other".to_string()]).unwrap();

    assert_eq!(deleted.len(), 0, "宽限期内的 running run 会话保留");
    assert_remaining_ids(&db, &["recent-run"]);
}

/// D3 回归：cancelling / completing 中间态 run 同样触发 in-flight 保护
/// （任务书 T3.3 断言 1 的参数化变体——两种收口状态都不得被清理）。
#[test]
fn cleanup_preserves_session_with_intermediate_run_statuses() {
    for status in [RunStatus::Cancelling, RunStatus::Completing] {
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&entry("mid-run", now_ms() - 10 * ORPHAN_GRACE_MS))
            .unwrap();
        db.insert_run("r-mid", "mid-run", status.clone(), None, 2)
            .unwrap();

        let deleted = db.cleanup_orphan_sessions(&[]).unwrap();

        assert_eq!(deleted.len(), 0, "{status:?} 中间态 run 的会话必须保留");
        assert_remaining_ids(&db, &["mid-run"]);
    }
}

/// D3 对照：同库无 run、无 pending 的陈旧会话仍正常清理
/// （防护不得误伤正常孤儿清理，任务书 T3.3 对照用例）。
#[test]
fn cleanup_still_removes_stale_session_without_run() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&entry("stale", now_ms() - 10 * ORPHAN_GRACE_MS))
        .unwrap();
    db.upsert_session_entry(&entry("fresh", now_ms())).unwrap();

    let deleted = db.cleanup_orphan_sessions(&["fresh".to_string()]).unwrap();

    assert_eq!(deleted.len(), 1);
    assert_remaining_ids(&db, &["fresh"]);
}
