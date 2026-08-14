//! CONN-D · 链 D：turn_into 权威消费（RS apply 后 kind 真可变）。
//!
//! # 轨声明（诚实 · 禁止偷换）
//!
//! | 可宣称 | 禁止宣称 |
//! | ------ | -------- |
//! | `UpdateProps` 含 `pending_turn_into_flavour` → apply 后 **kind 变更** | A-BLK-08/09 **全表 e2e** / **EL-01** |
//! | 真 `Op::TurnInto` wire → apply 后 kind 变更 | 桌面 PM/HiddenInput 产品键入全链已接线 |
//! | MD 前缀 provisional 同批（text_edit 剥前缀 + pending props）→ 文本+kind | 单测绿关 A-BLK-08 |
//! | 与 slash 结构 Op **同批/分批不互抹**（本测） | 假关 W3-H Strict 产品 e2e |
//!
//! composing 拒绝在 TS `tryMdPrefixFastPath` / `submitTurnIntoIntent`（不回退）；
//! 本文件测 RS 权威侧。
//!
//! 对齐：`06-交叉连通性审计` §4 链 D；TS `turnIntoIntentToProvisionalOps`。

use conex_doc_collab::{
    ops_from_json_str, pending_turn_into_kind, BlockId, BlockKind, BlockProps, DocSession, Op,
    Origin, PENDING_TURN_INTO_FLAVOUR_ATTR,
};
use std::str::FromStr;

fn bid(s: &str) -> BlockId {
    BlockId::from_str(s).expect("uuid")
}

fn insert_paragraph(s: &mut DocSession, id: BlockId, order: &str) {
    s.apply(
        Origin::User,
        &[Op::Insert {
            id,
            parent: None,
            order: order.into(),
            kind: BlockKind::Paragraph,
            props: BlockProps::default(),
        }],
    )
    .expect("insert paragraph");
}

/// D-1：`pending_turn_into_flavour` 经 UpdateProps apply → 权威 kind 变 heading-1。
#[test]
fn conn_d_pending_turn_into_flavour_changes_kind() {
    let id = bid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    let mut s = DocSession::new("conn-d-pending");
    insert_paragraph(&mut s, id, "a0");
    assert_eq!(
        s.tree().get(&id).unwrap().kind,
        BlockKind::Paragraph,
        "初态 paragraph"
    );

    let mut props = BlockProps::default();
    props.attrs.insert(
        PENDING_TURN_INTO_FLAVOUR_ATTR.into(),
        serde_json::json!("heading-1"),
    );
    props
        .attrs
        .insert("turn_into_trigger".into(), serde_json::json!("md_prefix"));

    s.apply(
        Origin::User,
        &[Op::UpdateProps {
            id,
            props: props.clone(),
        }],
    )
    .expect("apply pending update_props");

    let node = s.tree().get(&id).expect("node");
    assert_eq!(
        node.kind,
        BlockKind::Heading { level: 1 },
        "CONN-D：消费 pending 后权威 kind 须为 Heading{{1}}"
    );
    // 标记保留审计；UI 不得单读 attrs 当 kind（权威是 node.kind）
    assert_eq!(
        node.props
            .attrs
            .get(PENDING_TURN_INTO_FLAVOUR_ATTR)
            .and_then(|v| v.as_str()),
        Some("heading-1"),
        "pending 标记保留作审计"
    );
    assert_eq!(
        pending_turn_into_kind(&node.props),
        Some(BlockKind::Heading { level: 1 })
    );
}

/// D-2：真 `Op::TurnInto` wire → apply 后 kind 可变。
#[test]
fn conn_d_turn_into_op_wire_changes_kind() {
    let id = bid("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    let mut s = DocSession::new("conn-d-turn-into-op");
    insert_paragraph(&mut s, id, "a0");

    let wire = r#"[
      {
        "op": "turn_into",
        "id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        "kind": "quote"
      }
    ]"#;
    let ops = ops_from_json_str(wire).expect("parse turn_into wire");
    s.apply(Origin::User, &ops).expect("apply turn_into Op");

    assert_eq!(
        s.tree().get(&id).unwrap().kind,
        BlockKind::Quote,
        "真 TurnInto Op 须改 kind"
    );
}

/// D-3：MD 前缀 provisional 同批——text_edit 剥 `# ` + pending update_props → 文本空 + kind heading。
#[test]
fn conn_d_md_prefix_provisional_wire_strip_and_kind() {
    let id = bid("cccccccc-cccc-cccc-cccc-cccccccccccc");
    let mut s = DocSession::new("conn-d-md-prefix-batch");
    insert_paragraph(&mut s, id, "a0");
    // 模拟用户已键入 "# Hello"
    s.apply(
        Origin::User,
        &[Op::TextEdit {
            id,
            start: 0,
            end: 0,
            insert: "# Hello".into(),
        }],
    )
    .expect("seed text");
    assert_eq!(s.read_text(&id), "# Hello");

    // 对齐 TS turnIntoIntentToProvisionalOps：strip [0,2) + pending heading-1
    let provisional = r#"[
      {
        "op": "text_edit",
        "id": "cccccccc-cccc-cccc-cccc-cccccccccccc",
        "start": 0,
        "end": 2,
        "insert": ""
      },
      {
        "op": "update_props",
        "id": "cccccccc-cccc-cccc-cccc-cccccccccccc",
        "props": {
          "attrs": {
            "pending_turn_into_flavour": "heading-1",
            "turn_into_trigger": "md_prefix"
          }
        }
      }
    ]"#;
    let ops = ops_from_json_str(provisional).expect("parse provisional wire");
    s.apply(Origin::User, &ops)
        .expect("apply provisional strip+pending");

    assert_eq!(s.read_text(&id), "Hello", "须剥前缀 # ");
    assert_eq!(
        s.tree().get(&id).unwrap().kind,
        BlockKind::Heading { level: 1 },
        "provisional pending 经 RS 消费后 kind 须变"
    );
}

/// D-4：未知 flavour → Unknown 占位（不静默丢）。
#[test]
fn conn_d_pending_unknown_flavour_becomes_unknown_kind() {
    let id = bid("dddddddd-dddd-dddd-dddd-dddddddddddd");
    let mut s = DocSession::new("conn-d-unknown");
    insert_paragraph(&mut s, id, "a0");

    let mut props = BlockProps::default();
    props.attrs.insert(
        PENDING_TURN_INTO_FLAVOUR_ATTR.into(),
        serde_json::json!("callout-ext"),
    );
    s.apply(Origin::User, &[Op::UpdateProps { id, props }])
        .expect("apply unknown pending");

    match &s.tree().get(&id).unwrap().kind {
        BlockKind::Unknown { flavour } => assert_eq!(flavour, "callout-ext"),
        other => panic!("expect Unknown, got {other:?}"),
    }
}

/// D-5：turn_into 与 slash 风格 insert **不互抹**——同会话先后 apply 后双方均在树。
#[test]
fn conn_d_turn_into_and_structure_insert_no_mutual_erase() {
    let para = bid("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee");
    let code = bid("ffffffff-ffff-ffff-ffff-ffffffffffff");
    let mut s = DocSession::new("conn-d-no-erase");
    insert_paragraph(&mut s, para, "a0");

    // ① 类 slash_insert：插入 code 块（结构 Op，不经 turn_into）
    s.apply(
        Origin::User,
        &[Op::Insert {
            id: code,
            parent: None,
            order: "a1".into(),
            kind: BlockKind::Code,
            props: BlockProps::default(),
        }],
    )
    .expect("slash-like insert code");

    // ② turn_into 转 paragraph → bullet
    s.apply(
        Origin::User,
        &[Op::TurnInto {
            id: para,
            kind: BlockKind::BulletItem,
        }],
    )
    .expect("turn_into bullet");

    // ③ 再 insert 一块：不得抹掉 turn_into 结果 / 既有 code
    let quote = bid("99999999-9999-9999-9999-999999999999");
    s.apply(
        Origin::User,
        &[Op::Insert {
            id: quote,
            parent: None,
            order: "a2".into(),
            kind: BlockKind::Quote,
            props: BlockProps::default(),
        }],
    )
    .expect("second structure insert");

    assert_eq!(
        s.tree().get(&para).unwrap().kind,
        BlockKind::BulletItem,
        "turn_into 结果不得被后续 insert 抹掉"
    );
    assert_eq!(
        s.tree().get(&code).unwrap().kind,
        BlockKind::Code,
        "先插入的 code 不得被 turn_into 抹掉"
    );
    assert_eq!(s.tree().get(&quote).unwrap().kind, BlockKind::Quote);
    assert_eq!(
        s.tree().root_children,
        vec![para, code, quote],
        "三块均在根"
    );
}

/// D-6：flavour 映射钉死（与 TS flavourToCollabKind 对齐子集）。
#[test]
fn conn_d_block_kind_from_flavour_mapping() {
    assert_eq!(
        BlockKind::from_flavour("heading-1"),
        BlockKind::Heading { level: 1 }
    );
    assert_eq!(
        BlockKind::from_flavour("heading-3"),
        BlockKind::Heading { level: 3 }
    );
    assert_eq!(BlockKind::from_flavour("bullet"), BlockKind::BulletItem);
    assert_eq!(BlockKind::from_flavour("ordered"), BlockKind::OrderedItem);
    assert_eq!(BlockKind::from_flavour("quote"), BlockKind::Quote);
    assert_eq!(BlockKind::from_flavour("code"), BlockKind::Code);
    assert_eq!(BlockKind::from_flavour("paragraph"), BlockKind::Paragraph);
    assert_eq!(BlockKind::from_flavour("divider"), BlockKind::Divider);
}
