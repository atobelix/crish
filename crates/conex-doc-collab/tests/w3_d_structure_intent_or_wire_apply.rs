//! W3-D Strict · TextEditIntent + StructureIntent wire → **真** `DocSession::apply`。
//!
//! # 轨声明（诚实 · 禁止偷换）
//!
//! | 可宣称 | 禁止宣称 |
//! | ------ | -------- |
//! | **W3-D Strict 库侧关闭面**：至少一条 StructureIntent wire + 一条 TextEditIntent wire → 真 apply → 树 / `read_text` 可观测 | **EL-01** / A-BLK **全表** e2e |
//! | 与 TS `createCollabApplySink` + `submitStructureToCollabWire` wire 形状互通 | 桌面 IPC `note_apply_ops` 全链路已接线（可选；未做则本测 + TS 工厂形状为最低关闭面） |
//! | mock sink **不得**冒充本测语义 | 仅 W3-D-PM（真 PM、sink 仍 mock）冒充 **W3-D** |
//! | 真 PM 适配器在 TS `packages/block-paper/src/leaves/pm/**`（W3-D-PM，已入库） | 「块工作区完成」 |
//!
//! 对齐：
//! - `plans/05` §2 W3-D 三阶段 D2；`plans/09` §0.4 一字定义
//! - TS `@crish/block-paper-contract` `CollabOpWire` / `structureIntentToOps` / `createCollabApplySink`
//! - `conex-doc-collab::ops_from_json` → [`DocSession::apply`] → [`DocSession::read_text`]
//!
//! **生产默认写路径**：TS `createCollabApplySink`（非 `createMockIntentSink`）。

use conex_doc_collab::{
    ops_from_json_str, BlockId, BlockKind, DocEvent, DocSession, Origin,
};
use std::str::FromStr;

fn bid(s: &str) -> BlockId {
    BlockId::from_str(s).expect("uuid")
}

/// 结构 insert + text_edit + delete → 真 apply → 树 / `read_text`。
fn run_w3_d_strict_true_apply() {
    let id_a = bid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    let id_b = bid("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");

    let mut session = DocSession::new("w3-d-strict-apply");

    // ── 1) Structure insert wire（对齐 TS structureIntentToOps / createCollabApplySink）──
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

    assert_eq!(diff.doc_id, "w3-d-strict-apply");
    assert_eq!(diff.rev, 1);
    assert_eq!(diff.upserts.len(), 2, "insert 须进 ProjectionDiff.upserts");
    assert!(diff.removes.is_empty());
    assert!(!diff.full_rebuild);

    // 树权威变化（StructureIntent 可观测）
    assert_eq!(session.tree().root_children, vec![id_a, id_b]);
    let node_a = session.tree().get(&id_a).expect("block A after apply");
    assert_eq!(node_a.kind, BlockKind::Paragraph);
    assert_eq!(node_a.order, "a0");
    let node_b = session.tree().get(&id_b).expect("block B after apply");
    assert_eq!(node_b.kind, BlockKind::Heading { level: 1 });

    // ── 2) TextEditIntent wire → 真 apply → read_text 匹配 ──
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
    // 关闭断言：read_text（非仅 mock / 非仅旁路叙事）
    assert_eq!(
        session.read_text(&id_a),
        "hello-w3d",
        "TextEditIntent → apply → read_text 须匹配"
    );
    assert_eq!(
        session
            .tree()
            .get(&id_a)
            .and_then(|n| n.text_snapshot.as_deref())
            .unwrap_or(""),
        "hello-w3d",
        "叶子 text_snapshot 与 read_text 一致"
    );

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
    assert_eq!(
        session.read_text(&id_a),
        "hello-w3d",
        "删他块后文本叶 plain 保持"
    );
}

/// W3-D Strict · 结构 + 文本双路径真 apply（关闭证据 · 禁止 mock.calls）。
///
/// 覆盖：Structure insert / TextEdit → `read_text` / Structure delete。
/// 交叉：TS `intentBridge.w3d_apply.test.ts` 钉工厂形状；本测钉 **真** DocSession。
#[test]
fn w3_d_strict_text_and_structure_intent_true_apply() {
    run_w3_d_strict_true_apply();
}

/// 历史测名锚点（TS wire 半桥等交叉引用）；语义同 strict 测。
#[test]
fn w3_d_structure_intent_or_wire_applys_to_session() {
    run_w3_d_strict_true_apply();
}
