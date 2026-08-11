//! W3-D 方向 · plain Intent / CollabOpWire → **真** `DocSession::apply` 子集。
//!
//! # 轨声明（诚实 · 禁止偷换）
//!
//! | 可宣称 | 禁止宣称 |
//! | ------ | -------- |
//! | **W3-D-S 升级面** / **W3-D 子集**：wire JSON → `ops_from_json` → 真 apply → ProjectionDiff/树变化 | **W3-D Strict 终局**（09：真 PM + TextEditIntent + StructureIntent 双路径） |
//! | plain StructureIntent 形状的 collab wire 可进写锥 | **W3-D-PM**（本测无 ProseMirror） |
//! | mock sink **不得**冒充本测语义 | EL-01 / A-BLK 全表关闭 |
//!
//! 对齐：
//! - `plans/05` §2 W3-D 三阶段；`plans/09` §0.4 W3-D / W3-D-S / W3-D-PM
//! - TS `@crish/block-paper-contract` `CollabOpWire` / `structureIntentToOps` 产出形状
//! - `conex-doc-collab::ops_from_json` → [`DocSession::apply`]
//!
//! UI 默认 mock sink 仍合法（W3-D-S）；本文件只钉 **真 apply** 库侧路径。

use conex_doc_collab::{
    ops_from_json_str, BlockId, BlockKind, DocEvent, DocSession, Origin,
};
use std::str::FromStr;

fn bid(s: &str) -> BlockId {
    BlockId::from_str(s).expect("uuid")
}

/// 可测路径：StructureIntent/CollabOpWire JSON → `ops_from_json` → `DocSession::apply`
/// → ProjectionDiff / 树变化。
///
/// 覆盖：
/// 1. 结构 insert（slash_insert / insert_block 的 wire 形态）
/// 2. 文本 text_edit（plain TextEditIntent 的 wire 形态）
/// 3. 结构 delete（delete_blocks 的 wire 形态）
///
/// **≠ mock sink**；**≠ W3-D-PM**；plain Intent 真 apply 子集。
#[test]
fn w3_d_structure_intent_or_wire_applys_to_session() {
    let id_a = bid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    let id_b = bid("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");

    let mut session = DocSession::new("w3-d-wire-apply");

    // ── 1) Structure insert wire（对齐 TS structureIntentToOps insert_block / slash_insert）──
    // 形状与 packages/block-paper structureIntents + opsWire 一致（tag=op snake_case）
    let insert_json = r#"[
      {
        "op": "insert",
        "id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "parent": null,
        "order": "a0",
        "kind": "paragraph",
        "props": { "attrs": {} }
      },
      {
        "op": "insert",
        "id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        "parent": null,
        "order": "a1",
        "kind": { "heading": { "level": 1 } },
        "props": { "attrs": {} }
      }
    ]"#;

    let insert_ops = ops_from_json_str(insert_json).expect("parse structure insert wire");
    assert_eq!(insert_ops.len(), 2, "两条 insert wire");

    let event = session
        .apply(Origin::User, &insert_ops)
        .expect("真 apply structure insert（禁止 mock）");

    let DocEvent::Projection { diff } = event else {
        panic!("expect ProjectionDiff after structure insert, got {event:?}");
    };

    assert_eq!(diff.doc_id, "w3-d-wire-apply");
    assert_eq!(diff.rev, 1);
    assert_eq!(diff.upserts.len(), 2, "insert 须进 ProjectionDiff.upserts");
    assert!(diff.removes.is_empty());
    assert!(!diff.full_rebuild);

    // 树权威变化
    assert_eq!(session.tree().root_children, vec![id_a, id_b]);
    let node_a = session.tree().get(&id_a).expect("block A after apply");
    assert_eq!(node_a.kind, BlockKind::Paragraph);
    assert_eq!(node_a.order, "a0");
    let node_b = session.tree().get(&id_b).expect("block B after apply");
    assert_eq!(node_b.kind, BlockKind::Heading { level: 1 });

    // ── 2) TextEditIntent wire → 真 apply → text_touches + 快照 ──
    let text_json = r#"[
      {
        "op": "text_edit",
        "id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "start": 0,
        "end": 0,
        "insert": "hello-w3d"
      }
    ]"#;
    let text_ops = ops_from_json_str(text_json).expect("parse text_edit wire");
    let event2 = session
        .apply(Origin::User, &text_ops)
        .expect("真 apply text_edit");

    let DocEvent::Projection { diff: diff2 } = event2 else {
        panic!("expect Projection after text_edit");
    };
    assert_eq!(diff2.rev, 2);
    assert!(
        diff2.text_touches.contains(&id_a),
        "text_edit 须标记 text_touches"
    );
    let plain = session
        .tree()
        .get(&id_a)
        .and_then(|n| n.text_snapshot.as_deref())
        .unwrap_or("");
    assert_eq!(plain, "hello-w3d", "叶子文本须经 TextEngine 真写入");

    // ── 3) Structure delete_blocks wire → 真 apply → removes ──
    let delete_json = r#"[
      { "op": "delete", "id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }
    ]"#;
    let delete_ops = ops_from_json_str(delete_json).expect("parse delete wire");
    let event3 = session
        .apply(Origin::User, &delete_ops)
        .expect("真 apply structure delete");

    let DocEvent::Projection { diff: diff3 } = event3 else {
        panic!("expect Projection after delete");
    };
    assert_eq!(diff3.rev, 3);
    assert!(
        diff3.removes.contains(&id_b),
        "delete 须进 ProjectionDiff.removes"
    );
    assert!(
        !session.tree().nodes.contains_key(&id_b),
        "树须移除 B"
    );
    assert_eq!(session.tree().root_children, vec![id_a]);
    assert!(
        session.tree().nodes.contains_key(&id_a),
        "未删块保持"
    );
}
