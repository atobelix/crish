//! A-BLK 契约/属性抽样（**W6-A-S** · Skeleton）。
//!
//! **本文件 ≠ 关闭 EL-01 / A-BLK 全表 / 块工作区完成**：只钉抽样契约：
//! create/move/delete/**undo** 后 `block_id` 稳定、单次 `Op::Move` 重排、
//! indent/nest Move 半覆盖、跨文档导入重生 id 策略、未知 flavour 占位可恢复、
//! **A-BLK-08** `Op::TurnInto` 保 `block_id` + 文本（本波余量加深；≠ 选区 e2e）。
//!
//! 包锚：[`conex_doc_collab::W6_A_S_PACKAGE_ID`]（必须带 `-S`）。
//! 权威：`docs/block-workspace-architecture/round-D-stack/07-技术栈矩阵裁决.md` §5.1
//! 进度：`docs/block-workspace-architecture/plans/acceptance/A-BLK-progress.md`
//! 调度：`plans/09` **W6-A-S**（禁止用本文件关 **W6-A** / **EL-01**）

use conex_doc_collab::structure_codec::{decode_structure_payload, encode_structure_payload};
use conex_doc_collab::{
    BlockId, BlockKind, BlockProps, DocSession, Op, Origin, W6_A_S_A_BLK_SCENARIOS,
    W6_A_S_NOT_CLOSING, W6_A_S_PACKAGE_ID, W6_A_S_TRACK,
};

fn insert_root(s: &mut DocSession, id: BlockId, order: &str) {
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
    .expect("insert root");
}

/// 包轨钉（W6-A-S · 与 `w6_a_s` 模块互证；不关 EL-01 / W6-A）。
#[test]
fn w6_a_s_package_track_is_skeleton_not_el01() {
    assert_eq!(W6_A_S_PACKAGE_ID, "W6-A-S");
    assert!(
        W6_A_S_PACKAGE_ID.ends_with("-S"),
        "Skeleton 轨必须带 -S；禁止去 -S 冒充 W6-A Strict"
    );
    assert_eq!(W6_A_S_TRACK, "Skeleton");
    assert!(
        W6_A_S_NOT_CLOSING.iter().any(|s| s.contains("EL-01")),
        "诚实钉：不得关闭 EL-01"
    );
    assert!(
        W6_A_S_NOT_CLOSING.iter().any(|s| s.contains("W6-A Strict")),
        "诚实钉：不得关闭 W6-A Strict"
    );
    assert!(
        W6_A_S_A_BLK_SCENARIOS
            .iter()
            .any(|s| s.contains("a_blk_08_turn_into")),
        "本波余量加深场景须登记 A-BLK-08"
    );
    let _ = "W6-A-S ≠ W6-A / ≠ EL-01 满关";
}

/// A-BLK-01：create / move / delete 后 `block_id` 稳定可解析。
///
/// - create：Insert 后节点 id 与调用方预分配 id 相同
/// - move：移动后 id 不变，parent/order 更新，引用仍可 `tree.get`
/// - delete：被删 id 从树消失；未删兄弟 id 不变
///
/// 撤销（undo）结构 API 尚未暴露 → 本测不覆盖；进度表 A-BLK-01 撤销列为 W6-A 余量。
#[test]
fn a_blk_01_block_id_stable_after_create_move_delete() {
    let mut s = DocSession::new("a-blk-01");
    let a = BlockId::new();
    let b = BlockId::new();
    let c = BlockId::new();

    // create：预分配 id 即权威 id
    insert_root(&mut s, a, "a0");
    insert_root(&mut s, b, "a1");
    insert_root(&mut s, c, "a2");
    assert!(s.tree().nodes.contains_key(&a));
    assert!(s.tree().nodes.contains_key(&b));
    assert!(s.tree().nodes.contains_key(&c));
    assert_eq!(s.tree().get(&a).unwrap().id, a);
    assert_eq!(s.tree().get(&b).unwrap().id, b);
    assert_eq!(s.tree().get(&c).unwrap().id, c);

    // move：b 移到 a 下；b 的 BlockId 不变
    s.apply(
        Origin::User,
        &[Op::Move {
            id: b,
            new_parent: Some(a),
            order: "a0".into(),
        }],
    )
    .expect("move b under a");
    assert_eq!(s.tree().get(&b).unwrap().id, b, "move 后 block_id 必须稳定");
    assert_eq!(s.tree().get(&b).unwrap().parent, Some(a));
    assert!(
        s.tree().get(&a).unwrap().children.contains(&b),
        "父 children 仍以原 block_id 引用"
    );
    // a、c 的 id 不受 move 影响
    assert_eq!(s.tree().get(&a).unwrap().id, a);
    assert_eq!(s.tree().get(&c).unwrap().id, c);
    assert_eq!(s.tree().get(&c).unwrap().parent, None);

    // delete：删 c；a/b 仍可解析且 id 不变
    s.apply(Origin::User, &[Op::Delete { id: c }])
        .expect("delete c");
    assert!(!s.tree().nodes.contains_key(&c));
    assert_eq!(s.tree().get(&a).unwrap().id, a);
    assert_eq!(s.tree().get(&b).unwrap().id, b);
    assert_eq!(s.tree().get(&b).unwrap().parent, Some(a));

    // 合并场景的半覆盖：同批再插 d 再删 a（级联子 b）后 d 的 id 仍稳定
    let d = BlockId::new();
    s.apply(
        Origin::User,
        &[Op::Insert {
            id: d,
            parent: None,
            order: "a9".into(),
            kind: BlockKind::Paragraph,
            props: BlockProps::default(),
        }],
    )
    .expect("insert d");
    assert_eq!(s.tree().get(&d).unwrap().id, d);
    s.apply(Origin::User, &[Op::Delete { id: a }])
        .expect("delete a cascade");
    assert!(!s.tree().nodes.contains_key(&a));
    assert!(!s.tree().nodes.contains_key(&b), "删 a 应级联释放子 b");
    assert_eq!(
        s.tree().get(&d).unwrap().id,
        d,
        "未受影响块 block_id 在删合并后仍稳定"
    );
}

/// A-BLK-04 半：`Op::Move` 单次重排兄弟 order 正确（不含拖拽落点线 e2e）。
///
/// 对齐既有 MV-01 order 语义；本测以 `a_blk_04_*` 命名显式挂 A-BLK-04 抽样。
#[test]
fn a_blk_04_move_single_reorder_order() {
    let mut s = DocSession::new("a-blk-04");
    let x = BlockId::new();
    let y = BlockId::new();
    let z = BlockId::new();
    insert_root(&mut s, x, "a0");
    insert_root(&mut s, y, "a1");
    insert_root(&mut s, z, "a2");
    assert_eq!(s.tree().root_children, vec![x, y, z], "初始 order a0<a1<a2");

    // 单次 Move：将 z 重排到 x 之前。
    // 字典序注意：`"a00" > "a0"`（前缀更短更小），故用 `"a"` 才 < `"a0"`。
    s.apply(
        Origin::User,
        &[Op::Move {
            id: z,
            new_parent: None,
            order: "a".into(), // "a" < "a0" < "a1"
        }],
    )
    .expect("reorder z");
    assert_eq!(
        s.tree().root_children,
        vec![z, x, y],
        "单次 Move 后根兄弟 order 全序应正确"
    );
    assert_eq!(s.tree().get(&z).unwrap().order, "a");
    assert_eq!(s.tree().get(&z).unwrap().id, z, "重排不改 block_id");

    // 再 Move：y 夹到 z 与 x 之间（"a" < "a/" < "a0"，'/' < '0'）
    s.apply(
        Origin::User,
        &[Op::Move {
            id: y,
            new_parent: None,
            order: "a/".into(),
        }],
    )
    .expect("reorder y between z and x");
    assert_eq!(
        s.tree().root_children,
        vec![z, y, x],
        "二次 Move 后顺序应为 z,y,x"
    );
    // 校验 order 字典全序与 children 一致
    let roots = &s.tree().root_children;
    let o0 = s.tree().get(&roots[0]).unwrap().order.as_str();
    let o1 = s.tree().get(&roots[1]).unwrap().order.as_str();
    let o2 = s.tree().get(&roots[2]).unwrap().order.as_str();
    assert!(
        o0 <= o1 && o1 <= o2,
        "children 必须按 order 升序: {o0},{o1},{o2}"
    );
}

/// A-BLK-06 半：indent / nest 通过 `Op::Move` 改 parent 实现（无独立 Indent Op）。
///
/// 钉：把块移到另一块下 = 嵌套；再移回根 = 反缩进。
/// 列表 schema（BulletItem 缩进级、有序编号）与 MD 前缀语义 → W6-A 余量（进度黄）。
#[test]
fn a_blk_06_indent_nest_via_move_parent() {
    let mut s = DocSession::new("a-blk-06");
    let parent = BlockId::new();
    let child = BlockId::new();
    let sibling = BlockId::new();
    insert_root(&mut s, parent, "a0");
    insert_root(&mut s, child, "a1");
    insert_root(&mut s, sibling, "a2");

    // indent：child 嵌到 parent 下
    s.apply(
        Origin::User,
        &[Op::Move {
            id: child,
            new_parent: Some(parent),
            order: "a0".into(),
        }],
    )
    .expect("indent nest under parent");
    assert_eq!(s.tree().get(&child).unwrap().parent, Some(parent));
    assert!(s.tree().get(&parent).unwrap().children.contains(&child));
    assert!(!s.tree().root_children.contains(&child));
    assert_eq!(s.tree().get(&child).unwrap().id, child);

    // 更深一层：sibling 嵌到 child 下
    s.apply(
        Origin::User,
        &[Op::Move {
            id: sibling,
            new_parent: Some(child),
            order: "a0".into(),
        }],
    )
    .expect("deeper nest");
    assert_eq!(s.tree().get(&sibling).unwrap().parent, Some(child));
    assert!(s.tree().get(&child).unwrap().children.contains(&sibling));

    // outdent：sibling 回到 parent 下（仍嵌套一层）
    s.apply(
        Origin::User,
        &[Op::Move {
            id: sibling,
            new_parent: Some(parent),
            order: "a1".into(),
        }],
    )
    .expect("partial outdent");
    assert_eq!(s.tree().get(&sibling).unwrap().parent, Some(parent));
    assert_eq!(
        s.tree().get(&parent).unwrap().children,
        vec![child, sibling],
        "parent 下 children 按 order 排列"
    );

    // 全出：child 回根；sibling 仍在 parent 下
    s.apply(
        Origin::User,
        &[Op::Move {
            id: child,
            new_parent: None,
            order: "a5".into(),
        }],
    )
    .expect("outdent child to root");
    assert_eq!(s.tree().get(&child).unwrap().parent, None);
    assert!(s.tree().root_children.contains(&child));
    // 所有 id 全程稳定
    assert_eq!(s.tree().get(&parent).unwrap().id, parent);
    assert_eq!(s.tree().get(&child).unwrap().id, child);
    assert_eq!(s.tree().get(&sibling).unwrap().id, sibling);
}

/// A-BLK-01 补强：同批 create + move 后 id 仍可解析（属性向）。
#[test]
fn a_blk_01_same_batch_insert_then_move_keeps_id() {
    let mut s = DocSession::new("a-blk-01-batch");
    let host = BlockId::new();
    let leaf = BlockId::new();
    insert_root(&mut s, host, "a0");

    s.apply(
        Origin::User,
        &[
            Op::Insert {
                id: leaf,
                parent: None,
                order: "a1".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            },
            Op::Move {
                id: leaf,
                new_parent: Some(host),
                order: "a0".into(),
            },
        ],
    )
    .expect("same-batch insert+move");

    assert_eq!(s.tree().get(&leaf).unwrap().id, leaf);
    assert_eq!(s.tree().get(&leaf).unwrap().parent, Some(host));
    assert!(s.tree().get(&host).unwrap().children.contains(&leaf));
}

/// A-BLK-01 补强：结构 **undo** 后 `block_id` 仍可解析（W1-U 暴露面）。
///
/// 钉：delete 后 undo → 被删 id 回树且与预分配 id 同一值；未删块 id 全程不变。
/// **≠** 产品 undo 快捷键 / redo / 跨文档撤销 UI（W6-A e2e 余量）。
#[test]
fn a_blk_01_undo_restores_block_id_after_delete() {
    let mut s = DocSession::new("a-blk-01-undo");
    let keep = BlockId::new();
    let gone = BlockId::new();
    insert_root(&mut s, keep, "a0");
    insert_root(&mut s, gone, "a1");
    assert_eq!(s.tree().get(&gone).unwrap().id, gone);

    s.apply(Origin::User, &[Op::Delete { id: gone }])
        .expect("delete gone");
    assert!(!s.tree().nodes.contains_key(&gone));
    assert_eq!(s.tree().get(&keep).unwrap().id, keep);

    s.undo(Some(Origin::User)).expect("undo delete");
    assert!(
        s.tree().nodes.contains_key(&gone),
        "undo 后被删块须以原 block_id 回树"
    );
    assert_eq!(
        s.tree().get(&gone).unwrap().id,
        gone,
        "undo 不得重生 id；引用必须可解析为原 id"
    );
    assert_eq!(s.tree().get(&keep).unwrap().id, keep);
    assert!(s.tree().root_children.contains(&gone));
    assert!(s.tree().root_children.contains(&keep));
}

/// A-BLK-07 半：跨文档拖入 **必须重生 id**（策略契约；无拖放 UI）。
///
/// 模拟：源文档块 → 导入目标文档时分配新 `BlockId`，**禁止**复用源 id。
/// 跨块拖放预览 / 产品 e2e → **W6-A-S 余量（W6-A 未关）**。
#[test]
fn a_blk_07_cross_doc_import_must_regen_block_ids() {
    let mut src = DocSession::new("a-blk-07-src");
    let mut dst = DocSession::new("a-blk-07-dst");
    let src_id = BlockId::new();
    insert_root(&mut src, src_id, "a0");
    src.apply(
        Origin::User,
        &[Op::TextEdit {
            id: src_id,
            start: 0,
            end: 0,
            insert: "import-me".into(),
        }],
    )
    .expect("seed src text");
    let plain = src.read_text(&src_id);
    assert_eq!(plain, "import-me");

    // 跨文档导入策略：目标侧预分配 **新** id，再 Insert（不得以 src_id 写入 dst）
    let dst_id = BlockId::new();
    assert_ne!(dst_id, src_id, "导入预分配 id 必须与源 id 不同（重生契约）");
    dst.apply(
        Origin::User,
        &[Op::Insert {
            id: dst_id,
            parent: None,
            order: "a0".into(),
            kind: BlockKind::Paragraph,
            props: BlockProps::default(),
        }],
    )
    .expect("import insert with regen id");
    dst.apply(
        Origin::User,
        &[Op::TextEdit {
            id: dst_id,
            start: 0,
            end: 0,
            insert: plain.clone(),
        }],
    )
    .expect("copy plain");

    // 源 id 不得出现在目标树
    assert!(
        !dst.tree().nodes.contains_key(&src_id),
        "跨文档导入禁止把源 block_id 写入目标文档"
    );
    assert_eq!(dst.tree().get(&dst_id).unwrap().id, dst_id);
    assert_eq!(dst.read_text(&dst_id), "import-me");
    // 源文档原 id 仍稳定（导入不改写源）
    assert_eq!(src.tree().get(&src_id).unwrap().id, src_id);
    assert_eq!(src.read_text(&src_id), "import-me");
}

/// A-BLK-08 半：`Op::TurnInto` 改 kind **保** `block_id` + 文本 + parent/order。
///
/// 钉（心侧抽样，**≠** 选区 e2e / 产品 turn-into UI）：
/// - paragraph → heading → quote 后 id 不变
/// - 文本 plain 不因 kind 切换而清空
/// - parent / order / 兄弟位置不变（turn-into ≠ move）
/// - 文本长度不变 → 逻辑 offset 上界仍合法（选区保真的心侧前置；UI 钳制见 TS）
///
/// 产品菜单 / MD 前缀 / 选区投影 e2e → **W6-A-S 余量（W6-A 未关）**。
#[test]
fn a_blk_08_turn_into_preserves_block_id_and_text() {
    let mut s = DocSession::new("a-blk-08-turn-into");
    let host = BlockId::new();
    let target = BlockId::new();
    let sibling = BlockId::new();

    insert_root(&mut s, host, "a0");
    // target 嵌在 host 下，验证 turn_into 不破坏 parent
    s.apply(
        Origin::User,
        &[Op::Insert {
            id: target,
            parent: Some(host),
            order: "a0".into(),
            kind: BlockKind::Paragraph,
            props: BlockProps::default(),
        }],
    )
    .expect("insert target under host");
    insert_root(&mut s, sibling, "a1");

    let body = "选区保真前缀_hello_世界";
    s.apply(
        Origin::User,
        &[Op::TextEdit {
            id: target,
            start: 0,
            end: 0,
            insert: body.into(),
        }],
    )
    .expect("seed text");
    let len_before = s.read_text(&target).chars().count() as u32;
    assert_eq!(s.read_text(&target), body);
    assert_eq!(s.tree().get(&target).unwrap().parent, Some(host));
    let order_before = s.tree().get(&target).unwrap().order.clone();

    // turn_into：paragraph → heading-2；id/text/parent/order 须稳
    s.apply(
        Origin::User,
        &[Op::TurnInto {
            id: target,
            kind: BlockKind::Heading { level: 2 },
        }],
    )
    .expect("turn_into heading");
    assert_eq!(
        s.tree().get(&target).unwrap().id,
        target,
        "turn_into 不得重生 block_id"
    );
    assert_eq!(
        s.tree().get(&target).unwrap().kind,
        BlockKind::Heading { level: 2 }
    );
    assert_eq!(
        s.read_text(&target),
        body,
        "turn_into 不得清空/改写文本（逻辑选区 offset 依赖）"
    );
    assert_eq!(s.tree().get(&target).unwrap().parent, Some(host));
    assert_eq!(s.tree().get(&target).unwrap().order, order_before);
    assert!(
        s.tree().get(&host).unwrap().children.contains(&target),
        "父 children 仍以原 block_id 引用"
    );
    let len_after = s.read_text(&target).chars().count() as u32;
    assert_eq!(
        len_after, len_before,
        "文本标量长度不变 → 逻辑 offset 上界仍合法"
    );
    // 中部 offset 仍在 [0, len]（心侧前置；真投影 e2e 属 W6-A）
    let mid = len_after / 2;
    assert!(mid <= len_after);

    // 再 turn_into → quote；兄弟 sibling 的 id 全程不受影响
    s.apply(
        Origin::User,
        &[Op::TurnInto {
            id: target,
            kind: BlockKind::Quote,
        }],
    )
    .expect("turn_into quote");
    assert_eq!(s.tree().get(&target).unwrap().kind, BlockKind::Quote);
    assert_eq!(s.tree().get(&target).unwrap().id, target);
    assert_eq!(s.read_text(&target), body);
    assert_eq!(s.tree().get(&sibling).unwrap().id, sibling);
    assert_eq!(s.tree().get(&host).unwrap().id, host);
    assert_eq!(
        s.tree().get(&sibling).unwrap().kind,
        BlockKind::Paragraph,
        "未 turn 的兄弟 kind 不得被误改"
    );
}

/// A-BLK-11 半：未知 flavour → `BlockKind::Unknown` 占位；文本与 id 可恢复。
///
/// 钉：Insert Unknown + TextEdit 后 kind/flavour/id/text 仍在；结构 encode/decode 不丢。
/// 产品占位 View / turn-into 恢复 UI → **W6-A-S 余量（W6-A 未关）**。
#[test]
fn a_blk_11_unknown_flavour_placeholder_preserves_text_and_id() {
    let mut s = DocSession::new("a-blk-11");
    let id = BlockId::new();
    let flavour = "callout-ext".to_string();

    s.apply(
        Origin::User,
        &[Op::Insert {
            id,
            parent: None,
            order: "a0".into(),
            kind: BlockKind::Unknown {
                flavour: flavour.clone(),
            },
            props: BlockProps::default(),
        }],
    )
    .expect("insert unknown flavour");

    match &s.tree().get(&id).unwrap().kind {
        BlockKind::Unknown { flavour: f } => assert_eq!(f, &flavour),
        other => panic!("expected Unknown, got {other:?}"),
    }
    assert_eq!(s.tree().get(&id).unwrap().id, id);

    s.apply(
        Origin::User,
        &[Op::TextEdit {
            id,
            start: 0,
            end: 0,
            insert: "payload-safe".into(),
        }],
    )
    .expect("text on unknown block");
    assert_eq!(s.read_text(&id), "payload-safe");
    // 写文本后 kind 不得被抹成 Paragraph 等已知类型
    match &s.tree().get(&id).unwrap().kind {
        BlockKind::Unknown { flavour: f } => assert_eq!(f, &flavour),
        other => panic!("text edit 后仍须 Unknown, got {other:?}"),
    }

    // 结构 snapshot 往返：Unknown + text_snapshot 可恢复（不丢数据）
    let bytes = encode_structure_payload(s.rev(), s.tree());
    let snap = decode_structure_payload(&bytes).expect("decode structure");
    let node = snap.tree.get(&id).expect("id 在 snapshot 可解析");
    assert_eq!(node.id, id);
    match &node.kind {
        BlockKind::Unknown { flavour: f } => assert_eq!(f, &flavour),
        other => panic!("snapshot kind 须 Unknown, got {other:?}"),
    }
    assert_eq!(
        node.text_snapshot.as_deref(),
        Some("payload-safe"),
        "占位块文本须随结构 snapshot 可恢复"
    );
}

/// A-BLK-11 余量加深：Unknown 占位 → `Op::TurnInto` 已知 kind **恢复**后 id/text 仍稳。
///
/// 对齐注释余量「turn-into 恢复」心侧前置；**≠** 产品占位 View / 恢复 UI e2e。
#[test]
fn a_blk_11_unknown_turn_into_recovery_keeps_id_and_text() {
    let mut s = DocSession::new("a-blk-11-turn-into-recovery");
    let id = BlockId::new();
    let flavour = "legacy-callout".to_string();

    s.apply(
        Origin::User,
        &[Op::Insert {
            id,
            parent: None,
            order: "a0".into(),
            kind: BlockKind::Unknown {
                flavour: flavour.clone(),
            },
            props: BlockProps::default(),
        }],
    )
    .expect("insert unknown");
    s.apply(
        Origin::User,
        &[Op::TextEdit {
            id,
            start: 0,
            end: 0,
            insert: "recover-me".into(),
        }],
    )
    .expect("seed unknown text");
    assert_eq!(s.read_text(&id), "recover-me");
    match &s.tree().get(&id).unwrap().kind {
        BlockKind::Unknown { flavour: f } => assert_eq!(f, &flavour),
        other => panic!("expected Unknown, got {other:?}"),
    }

    // 恢复路径：turn_into → 已知 Quote（模拟 registerFlavour / 用户转类型）
    s.apply(
        Origin::User,
        &[Op::TurnInto {
            id,
            kind: BlockKind::Quote,
        }],
    )
    .expect("turn_into recovery");
    assert_eq!(
        s.tree().get(&id).unwrap().id,
        id,
        "恢复转类型不得重生 block_id"
    );
    assert_eq!(s.tree().get(&id).unwrap().kind, BlockKind::Quote);
    assert_eq!(s.read_text(&id), "recover-me", "占位恢复后文本不得丢失");
    // 结构 snapshot 往返仍可解析原 id
    let bytes = encode_structure_payload(s.rev(), s.tree());
    let snap = decode_structure_payload(&bytes).expect("decode");
    let node = snap.tree.get(&id).expect("id 可解析");
    assert_eq!(node.id, id);
    assert_eq!(node.kind, BlockKind::Quote);
}
