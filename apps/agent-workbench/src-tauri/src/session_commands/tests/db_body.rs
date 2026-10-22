//! SharedDb / 校验守卫 / 正文自愈写入。

use super::*;

#[test]
fn shared_db_reports_ready() {
    let db = LocalDb::open_in_memory().unwrap();
    let shared = SharedDb::new(db);
    assert!(shared.db_ready());
}

#[test]
fn shared_db_inner_clones() {
    let db = LocalDb::open_in_memory().unwrap();
    let shared = SharedDb::new(db);
    let _clone = shared.local_db();
    // 原始 SharedDb 仍可用
    assert!(shared.db_ready());
}

#[test]
fn require_session_id_rejects_empty() {
    assert!(require_session_id("").is_err());
    assert!(require_session_id("   ").is_err());
    assert!(require_session_id("s1").is_ok());
}

#[test]
fn map_db_err_preserves_message() {
    let e = DbFailure {
        message: "locked".to_string(),
        // kind 现为 DbFailureKind 枚举（R6 收敛）；Display 仍输出操作名
        kind: conex_db::DbFailureKind::Lock,
    };
    let core = map_db_err(e);
    match core {
        CoreError::Internal(msg) => assert!(msg.contains("locked")),
        other => panic!("expected Internal, got {other:?}"),
    }
}

// ── F4：空 keepIds 默认拒绝（PE-08 T08.2）──

#[test]
fn cleanup_guard_rejects_empty_keep_without_confirm() {
    let err = guard_cleanup_keep(&[], false).expect_err("must reject");
    match err {
        CoreError::InvalidInput(detail) => assert_eq!(detail, "cleanup_orphan_empty_keep"),
        other => panic!("expected InvalidInput, got {other:?}"),
    }
}

#[test]
fn cleanup_guard_allows_explicit_empty_confirm() {
    guard_cleanup_keep(&[], true).expect("explicit confirm allows clear");
    guard_cleanup_keep(&["s1".to_string()], false).expect("non-empty keep is allowed");
}

// ── T08.1：save_session_body 自愈补建会话行 ──

#[test]
fn save_session_body_self_heals_missing_session_row() {
    let db = LocalDb::open_in_memory().unwrap();
    let messages = [
        sample_message("m1", "user", 1),
        sample_message("m2", "assistant", 2),
    ];

    // 全新内存库：无索引行，自愈后正文可写入（不再 FK 失败）。
    // 自愈语义与批次 CAS 无关：None = 显式非 CAS rebase 路径
    self_heal_then_save_body(&db, "s1", &messages, None).expect("self-heal save");

    let body = db.load_session_body("s1").unwrap();
    assert_eq!(body.len(), 2);
    let list = db.list_sessions().unwrap();
    assert_eq!(list[0].id, "s1");
    // 触发器维护 message_count。
    assert_eq!(list[0].message_count, 2);
}

#[test]
fn save_session_body_self_heal_keeps_existing_row() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();

    let messages = [sample_message("m1", "user", 1)];
    self_heal_then_save_body(&db, "s1", &messages, None).expect("save with existing row");

    // 既有索引行不被覆盖（INSERT OR IGNORE 幂等）。
    let list = db.list_sessions().unwrap();
    assert_eq!(list[0].title, "Title s1");
}

// ── F3：upsert_session_entry 命令层校验 ──

#[test]
fn upsert_requires_non_empty_entry_id() {
    let mut entry = sample_entry("s1");
    entry.id = "   ".to_string();
    assert!(require_session_id(&entry.id).is_err());
}

#[test]
fn upsert_does_not_cascade_delete_messages() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();
    db.save_session_body(
        "s1",
        &[
            sample_message("m1", "user", 1),
            sample_message("m2", "assistant", 2),
        ],
    )
    .unwrap();

    // 再次 upsert 同一会话，不应丢失消息。
    let mut entry = sample_entry("s1");
    entry.title = "Updated Title".to_string();
    db.upsert_session_entry(&entry).unwrap();

    let body = db.load_session_body("s1").unwrap();
    assert_eq!(body.len(), 2);
    let list = db.list_sessions().unwrap();
    assert_eq!(list[0].title, "Updated Title");
    assert_eq!(list[0].message_count, 2);
}

#[test]
fn end_to_end_via_shared_db() {
    // 验证 SharedDb.local_db() 与 LocalDb 行为一致
    let db = LocalDb::open_in_memory().unwrap();
    let shared = SharedDb::new(db);
    let inner = shared.local_db();

    inner.upsert_session_entry(&sample_entry("s1")).unwrap();
    inner
        .save_session_body(
            "s1",
            &[
                sample_message("m1", "user", 1),
                sample_message("m2", "assistant", 2),
            ],
        )
        .unwrap();

    let body = inner.load_session_body("s1").unwrap();
    assert_eq!(body.len(), 2);

    let list = inner.list_sessions().unwrap();
    assert_eq!(list[0].message_count, 2);
}
