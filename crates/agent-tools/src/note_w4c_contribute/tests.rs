//! W4-C / contribute 测（外置）
//!
//! 诚实边界：Memory 测绿 **禁关** EL-05 / EL-07 / A-EXT 全表 / 生产 A-AGT。
//! **≠ EL-05**；拒写方向不回退；不回退 W4-B 审批矩阵、W4-F batch token / move。

use super::*;
use crate::note_action_matrix::plan_denies_matrix_tool;
use crate::note_backend::{
    MemoryNoteBackend, NoteBackend, NoteBackendError, NoteBatchTokens, NoteBlockInsertRequest,
    NoteBlockMoveRequest, NoteQueryBlocksParams,
};
use crate::note_permission::plan_denies_note_tool;
use crate::note_w6e_skeleton::FORBIDDEN_WRITE_HANDLE_KEYS;
use crate::permission::{PermissionMode, PermissionVerdict};
use std::collections::BTreeMap;
use std::time::Duration;

fn slash_ok(id: &str) -> ContributeRegistration {
    let mut fields = BTreeMap::new();
    fields.insert("title".into(), "Hello".into());
    ContributeRegistration {
        id: id.into(),
        plugin_id: "@demo/plugin".into(),
        kind: ContributeKind::SlashItem,
        permissions: vec![REQUIRED_CONTRIBUTE_PERMISSION.into()],
        fields,
        payload: None,
    }
}

fn block_view_ok(id: &str, flavour: &str) -> ContributeRegistration {
    let mut fields = BTreeMap::new();
    fields.insert("flavour".into(), flavour.into());
    fields.insert("component".into(), "DemoView".into());
    ContributeRegistration {
        id: id.into(),
        plugin_id: "@demo/plugin".into(),
        kind: ContributeKind::BlockView,
        permissions: vec![REQUIRED_CONTRIBUTE_PERMISSION.into()],
        fields,
        payload: None,
    }
}

/// 包锚：W4-C 标识 + 诚实 ≠ EL-07 / ≠ A-EXT 全表
#[test]
fn w4c_package_id_and_honest_not_closing_el07() {
    assert_eq!(W4C_PACKAGE_ID, "W4-C");
    assert!(!W4C_PACKAGE_ID.ends_with("-S"), "W4-C 为 Strict 方向，非 Skeleton -S");
    assert!(W4C_NOT_CLOSING.iter().any(|s| s.contains("EL-07")));
    assert!(W4C_NOT_CLOSING.iter().any(|s| s.contains("A-EXT")));
    assert_eq!(REQUIRED_CONTRIBUTE_PERMISSION, "ui:contribute");
    assert_eq!(CONTRIBUTE_FORBIDDEN_WRITE, "note.contribute_forbidden_write_handle");
    // 禁写表与 W6-E-S / plugin-sdk 对齐方向
    assert!(FORBIDDEN_WRITE_HANDLE_KEYS.contains(&"applyOp"));
    assert!(FORBIDDEN_WRITE_HANDLE_KEYS.contains(&"store"));
    assert!(FORBIDDEN_WRITE_HANDLE_KEYS.contains(&"innerHTML"));
    let _ = "W4-C ≠ EL-07 满关 / ≠ A-EXT 全表 / 仅 View 轨拒写句柄方向";
}

/// 产品向路径：View 轨 register + list 仅 ViewDescriptor
#[test]
fn w4c_contribute_view_registry_register_and_list_projection_only() {
    let reg = ContributeViewRegistry::new();
    let ok = reg.register(slash_ok("cmd-1")).expect("register ok");
    assert!(ok.registration_key.contains("slash_item"));
    assert!(ok.registration_key.contains("cmd-1"));

    let list = reg.list(None);
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, "cmd-1");
    assert_eq!(list[0].kind, ContributeKind::SlashItem);
    assert!(list[0]
        .permissions
        .iter()
        .any(|p| p == REQUIRED_CONTRIBUTE_PERMISSION));
    assert_eq!(list[0].fields.get("title").map(String::as_str), Some("Hello"));

    // 投影-only：序列化 JSON 不得含写句柄键
    let json = serde_json::to_value(&list[0]).expect("ser");
    assert!(contribute_payload_has_write_handle(&json).is_none());
    for key in FORBIDDEN_WRITE_HANDLE_KEYS {
        assert!(
            json.get(*key).is_none(),
            "ViewDescriptor must not expose write handle `{key}`"
        );
    }

    // kind 过滤
    assert!(reg.list(Some(ContributeKind::BlockView)).is_empty());
    assert_eq!(reg.list(Some(ContributeKind::SlashItem)).len(), 1);
}

/// 拒写句柄：fields 夹带 applyOp / store → 拒绝且不入表
#[test]
fn w4c_contribute_reject_write_handle_in_fields() {
    let reg = ContributeViewRegistry::new();
    let mut evil = slash_ok("evil-apply");
    evil.fields.insert("applyOp".into(), "steal".into());

    let err = reg.register(evil).expect_err("must reject applyOp");
    assert_eq!(err.code(), "forbidden_write_handle");
    assert!(err.message().contains(CONTRIBUTE_FORBIDDEN_WRITE));
    assert!(err.message().contains("applyOp"));
    assert!(reg.is_empty(), "拒写后注册表须为空");

    let mut evil2 = slash_ok("evil-store");
    evil2.fields.insert("store".into(), "x".into());
    let err2 = reg.register(evil2).expect_err("must reject store");
    assert_eq!(err2.code(), "forbidden_write_handle");
    assert!(reg.is_empty());
}

/// 拒写句柄：payload JSON 嵌套夹带 sqlite / innerHTML
#[test]
fn w4c_contribute_reject_write_handle_in_payload_json() {
    let reg = ContributeViewRegistry::new();
    let mut evil = slash_ok("evil-nested");
    evil.payload = Some(serde_json::json!({
        "action": { "sqlite": "/tmp/evil.db" }
    }));
    let err = reg.register(evil).expect_err("must reject nested sqlite");
    assert_eq!(err.code(), "forbidden_write_handle");
    assert!(
        err.message().contains("sqlite") || err.message().contains(CONTRIBUTE_FORBIDDEN_WRITE)
    );
    assert!(reg.is_empty());

    let mut evil2 = block_view_ok("evil-html", "paragraph");
    evil2.payload = Some(serde_json::json!({ "innerHTML": "<script>" }));
    let err2 = reg.register(evil2).expect_err("must reject innerHTML");
    assert_eq!(err2.code(), "forbidden_write_handle");
    assert!(reg.is_empty());
}

/// 权限：无 ui:contribute → missing_permission
#[test]
fn w4c_contribute_requires_ui_contribute_permission() {
    let reg = ContributeViewRegistry::new();
    let mut bare = slash_ok("no-perm");
    bare.permissions.clear();
    let err = reg.register(bare).expect_err("must require ui:contribute");
    assert_eq!(err.code(), "missing_permission");
    assert!(err.message().contains("ui:contribute"));

    let mut note_only = slash_ok("note-only");
    note_only.permissions = vec!["note:write".into()];
    let err2 = reg.register(note_only).expect_err("note:write alone insufficient");
    assert_eq!(err2.code(), "missing_permission");
    assert!(reg.is_empty());
}

/// 声明 note:write 仍只得 ViewDescriptor（不提升写能力）
#[test]
fn w4c_note_write_permission_does_not_grant_write_handle() {
    let reg = ContributeViewRegistry::new();
    let mut c = slash_ok("with-write-decl");
    c.permissions = vec![
        REQUIRED_CONTRIBUTE_PERMISSION.into(),
        "note:write".into(),
    ];
    reg.register(c).expect("ui:contribute + note:write ok");
    let list = reg.list(None);
    assert_eq!(list.len(), 1);
    // 描述符仍无写句柄
    let json = serde_json::to_value(&list[0]).unwrap();
    assert!(contribute_payload_has_write_handle(&json).is_none());
    // 旁路 mutate 仍拒
    let deny = try_mutate_via_contribute(&reg, "with-write-decl", "doc-x", "hack");
    assert!(deny.is_err());
    let e = deny.unwrap_err();
    assert!(
        e.message().contains(CONTRIBUTE_MUTATE_DENIED)
            || format!("{e:?}").contains("contribute_mutate")
    );
}

/// 投影-only 旁路写：try_mutate 失败且权威树不变
#[tokio::test]
async fn w4c_try_mutate_via_contribute_zero_persist() {
    let backend = MemoryNoteBackend::new();
    backend.seed_doc(
        "doc-w4c",
        vec![("keep".into(), "paragraph".into(), "authority-stay".into())],
    );

    let reg = ContributeViewRegistry::new();
    reg.register(slash_ok("ui-only")).expect("view ok");

    // 试图经 contribute 写 → 恒拒
    let err = try_mutate_via_contribute(&reg, "ui-only", "doc-w4c", "should-never-land")
        .expect_err("View 轨禁止 mutate");
    assert!(
        err.message().contains(CONTRIBUTE_MUTATE_DENIED)
            || format!("{err:?}").contains("denied"),
        "err must name contribute_mutate_denied: {err:?}"
    );

    // 权威树不变
    let q = backend
        .query_blocks(NoteQueryBlocksParams {
            doc_id: "doc-w4c".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(q.blocks.len(), 1);
    assert_eq!(q.blocks[0].id, "keep");
    assert!(
        q.blocks[0].snippet.contains("authority-stay"),
        "零持久化：权威块须保留 authority-stay，got {:?}",
        q.blocks[0].snippet
    );

    // 正常工具面写仍可用（分轨：contribute 拒写 ≠ 工具面拒写）
    let ins = backend
        .block_insert(NoteBlockInsertRequest {
            doc_id: "doc-w4c".into(),
            content: "tool-path-ok".into(),
            parent_id: None,
            previous_id: None,
            kind: Some("paragraph".into()),
            batch_id: None,
            origin: Some("agent".into()),
        })
        .await
        .expect("tool path insert");
    assert!(!ins.block_id.is_empty());
    assert_eq!(ins.kind, "paragraph");

    let q2 = backend
        .query_blocks(NoteQueryBlocksParams {
            doc_id: "doc-w4c".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(q2.blocks.len(), 2, "工具面写应落盘；contribute 旁路不影响");

    // 诚实：Memory 形状 ≠ 关 EL-07
    let _ = "W4-C Memory 投影-only 拒写 ≠ EL-07 满关 / ≠ A-EXT 全表";
}

/// 拒写注册后零持久化：恶意载荷不入表 + 不触达后端写
#[tokio::test]
async fn w4c_forbidden_write_register_zero_persist_authority() {
    let backend = MemoryNoteBackend::new();
    backend.seed_doc(
        "doc-evil-reg",
        vec![("root".into(), "paragraph".into(), "seed".into())],
    );
    let before = backend
        .query_blocks(NoteQueryBlocksParams {
            doc_id: "doc-evil-reg".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(before.blocks.len(), 1);

    let reg = ContributeViewRegistry::new();
    let mut evil = slash_ok("malware");
    evil.fields.insert("documentWrite".into(), "yes".into());
    evil.payload = Some(serde_json::json!({ "fsWrite": "/notes/x.md" }));

    let err = reg.register(evil).expect_err("must reject");
    let be = contribute_err_to_backend_err(&err);
    assert!(
        be.message().contains("forbidden_write_handle")
            || be.message().contains(CONTRIBUTE_FORBIDDEN_WRITE)
    );
    assert!(reg.is_empty());

    // 权威树仍仅 seed
    let after = backend
        .query_blocks(NoteQueryBlocksParams {
            doc_id: "doc-evil-reg".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(after.blocks.len(), 1);
    assert_eq!(after.blocks[0].id, "root");
    assert!(after.blocks[0].snippet.contains("seed"));
}

/// 去重 / 注销
#[test]
fn w4c_contribute_duplicate_and_unregister() {
    let reg = ContributeViewRegistry::new();
    let ok = reg.register(slash_ok("dup")).unwrap();
    let err = reg.register(slash_ok("dup")).expect_err("duplicate");
    assert_eq!(err.code(), "duplicate_id");
    assert!(reg.unregister(&ok.registration_key));
    assert!(reg.is_empty());
    reg.register(slash_ok("a")).unwrap();
    reg.register(block_view_ok("b", "paragraph")).unwrap();
    assert_eq!(reg.unregister_by_plugin("@demo/plugin"), 2);
    assert!(reg.is_empty());
}

/// 不回退：plan Deny（W4-B/F）对写工具仍生效
#[test]
fn w4c_no_regress_plan_deny_write_tools() {
    for tool in [
        "block_batch",
        "block_insert",
        "block_update",
        "block_delete",
        "block_move",
        "document_apply_md",
        "send_to_note",
    ] {
        assert!(
            plan_denies_note_tool(tool),
            "W4-C 不得回退 note_permission plan Deny: {tool}"
        );
        assert!(
            plan_denies_matrix_tool(tool),
            "W4-C 不得回退 action_matrix plan Deny: {tool}"
        );
    }
    // 读工具 plan 仍 Allow
    assert_eq!(
        crate::note_permission::decide_note_tool("query_blocks", PermissionMode::Plan),
        Some(PermissionVerdict::Allow)
    );
}

/// 不回退：batch token 占用 / 过期
/// TTL 用 200ms 量级，避免并行测/调度抖动下 30ms 窗过窄导致 acquire 后立刻 Expired。
#[test]
fn w4c_no_regress_batch_token_acquire_validate_expire() {
    let tokens = NoteBatchTokens::with_ttl(Duration::from_millis(200));
    tokens.acquire("w4c-batch").unwrap();
    tokens
        .validate("w4c-batch")
        .expect("fresh acquire must validate within TTL");
    assert!(matches!(
        tokens.validate("missing"),
        Err(NoteBackendError::BatchTokenInvalid(_))
    ));
    std::thread::sleep(Duration::from_millis(250));
    assert!(matches!(
        tokens.validate("w4c-batch"),
        Err(NoteBackendError::BatchTokenExpired(_))
    ));
}

/// 不回退：block_move 工具路径（Memory 形状；禁关生产 A-AGT）
#[tokio::test]
async fn w4c_no_regress_block_move_memory_shape() {
    let backend = MemoryNoteBackend::new();
    backend.seed_doc(
        "doc-move",
        vec![
            ("a".into(), "paragraph".into(), "first".into()),
            ("b".into(), "paragraph".into(), "second".into()),
        ],
    );
    let mv = backend
        .block_move(NoteBlockMoveRequest {
            doc_id: "doc-move".into(),
            id: "b".into(),
            parent_id: None,
            previous_id: None, // 移到最前
            batch_id: None,
            origin: Some("agent".into()),
        })
        .await
        .expect("block_move shape");
    assert_eq!(mv.id, "b");
    let q = backend
        .query_blocks(NoteQueryBlocksParams {
            doc_id: "doc-move".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(q.blocks.len(), 2);
    // Memory 测绿 ≠ 生产关项
    let _ = "W4-C 不回退 move；Memory ≠ EL-05 / ≠ A-AGT 满表";
}

/// kind 解析与注册键稳定
#[test]
fn w4c_contribute_kind_parse_and_registration_key() {
    assert_eq!(ContributeKind::parse("slash_item"), Some(ContributeKind::SlashItem));
    assert_eq!(ContributeKind::parse("block_view"), Some(ContributeKind::BlockView));
    assert_eq!(ContributeKind::parse("nope"), None);
    assert_eq!(CONTRIBUTE_KINDS.len(), 4);
    let k = make_registration_key("@p/x", ContributeKind::Widget, "w1");
    assert_eq!(k, "@p/x\0widget\0w1");
}

/// 无效载荷
#[test]
fn w4c_contribute_invalid_payload_empty_id() {
    let reg = ContributeViewRegistry::new();
    let mut bad = slash_ok("");
    bad.id = "  ".into();
    let err = reg.register(bad).expect_err("empty id");
    assert_eq!(err.code(), "invalid_payload");
}
