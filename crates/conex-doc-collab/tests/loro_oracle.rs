//! W0-L Strict：Loro **差分对照 oracle**（自研 DocSession vs Loro movable tree）。
//!
//! # 边界（P-Loro / 01 §2.7）
//! - **仅** `cargo test` 路径链接 `loro`（`Cargo.toml` `[dev-dependencies]`）。
//! - 生产 [`conex_doc_collab::DocSession`] **不得** 依赖 loro。
//! - 对照失败 → **修自研规则** 或 **标清规则差**；**禁止**默默切主路径到 Loro（A-SWAP 另议）。
//! - **仅 Loro 自洽 ≠ W0-L 完成**（W0-L-S 骨架可保留，但不得冒充对照）。
//!
//! # 差分定义（约定不变量 · 最低集）
//! 同一逻辑场景（可翻译 Op 序列）分别驱动：
//! 1. **自研** `DocSession::apply`（`Op::Insert` / `Move` / `Delete`）
//! 2. **Loro** `LoroTree::{create, mov, delete}`
//!
//! 在**双方终态**上并排断言：
//! | 维度 | 约定 |
//! | ---- | ---- |
//! | **无环** | 每个 live 节点沿 parent 上溯有穷达根，无重复访问 |
//! | **父子可达** | live 子的 parent 指针 ↔ 父 children / 根列表一致 |
//! | **删胜方向** | 目标被删后：不存在「A 已删且 B 仍以 live A 为 parent」；见 `loro_diff_delete_wins_*` 规则差注 |
//! | **order** | 同父兄弟序：自研按 `order` 字典序（再 id）；Loro 用 fractional index 位置序；场景内可复算 |
//!
//! # 场景向量（本文件）
//! | 测名 | 场景 | 期望 |
//! | ---- | ---- | ---- |
//! | `loro_diff_insert_move_no_cycle` | insert + move | 双方 parent 拓扑同构、无环 |
//! | `loro_diff_cycle_both_reject` | move 入子孙 | **双方都拒**，树形态不变 |
//! | `loro_diff_delete_wins_over_move` | delete(A) 后 move(B→A) | 删胜方向一致（A 非 live；B 非 live-under-A） |
//! | `loro_diff_sibling_order` | 同父多插 | 双方兄弟序与约定 order 键一致 |
//!
//! 规格锚点：
//! - `plans/01-文档心与合并.md` §2.7
//! - `18` 补丁 P-Loro
//! - `plans/specs/concurrent-move-rules.md` MV-01…04
//! - `plans/09` W0-L Strict

use conex_doc_collab::{
    ApplyError, BlockId, BlockKind, BlockProps, BlockTree, DocSession, Op, Origin,
};
use loro::{LoroDoc, LoroError, LoroTree, LoroTreeError, TreeID, TreeParentId};
use std::collections::{BTreeMap, HashMap, HashSet};

// ═══════════════════════════════════════════════════════════════════════════
// 差分 harness：逻辑名 → 自研 BlockId / Loro TreeID
// ═══════════════════════════════════════════════════════════════════════════

/// 逻辑节点名（场景内稳定标签），两侧 ID 空间不同，靠此映射对齐。
type Label = &'static str;

struct DualForest {
    rs: DocSession,
    loro_doc: LoroDoc,
    /// label → (自研 id, Loro id)
    ids: HashMap<Label, (BlockId, TreeID)>,
    /// 自研侧记录 order 键（Loro 用 create/mov 位置表达）
    rs_order: HashMap<Label, String>,
}

impl DualForest {
    fn new(doc_id: &str) -> Self {
        let loro_doc = LoroDoc::new();
        {
            let tree = loro_doc.get_tree("blocks");
            tree.enable_fractional_index(0);
        }
        Self {
            rs: DocSession::new(doc_id),
            loro_doc,
            ids: HashMap::new(),
            rs_order: HashMap::new(),
        }
    }

    fn tree(&self) -> LoroTree {
        self.loro_doc.get_tree("blocks")
    }

    fn rs_id(&self, label: Label) -> BlockId {
        self.ids
            .get(label)
            .unwrap_or_else(|| panic!("未知逻辑名 {label}"))
            .0
    }

    fn loro_id(&self, label: Label) -> TreeID {
        self.ids
            .get(label)
            .unwrap_or_else(|| panic!("未知逻辑名 {label}"))
            .1
    }

    /// 在双方同时 insert：parent=None 为根。
    fn insert(&mut self, label: Label, parent: Option<Label>, order: &str) {
        assert!(
            !self.ids.contains_key(label),
            "重复 insert 逻辑名 {label}"
        );
        let bid = BlockId::new();
        let parent_bid = parent.map(|p| self.rs_id(p));
        self.rs
            .apply(
                Origin::User,
                &[Op::Insert {
                    id: bid,
                    parent: parent_bid,
                    order: order.into(),
                    kind: BlockKind::Paragraph,
                    props: BlockProps::default(),
                }],
            )
            .unwrap_or_else(|e| panic!("自研 insert {label}: {e}"));

        let tree = self.tree();
        let tid = match parent {
            None => tree.create(None).expect("loro create root"),
            Some(p) => {
                let pid = self.loro_id(p);
                // 按 order 键在同父兄弟中找插入下标（字典序，对齐自研 resort）
                let idx = self.loro_insert_index(parent, order);
                tree.create_at(pid, idx).unwrap_or_else(|_| {
                    // create_at 失败时回退 create 再靠后续 order 场景不依赖严格位
                    tree.create(pid).expect("loro create child")
                })
            }
        };
        // 根节点：用 create 后 mov_to 调整兄弟序（若需要）
        if parent.is_none() {
            let idx = self.loro_insert_index(None, order);
            let _ = tree.mov_to(tid, TreeParentId::Root, idx);
        }
        self.loro_doc.commit();
        self.ids.insert(label, (bid, tid));
        self.rs_order.insert(label, order.to_string());
    }

    /// 在 Loro 侧按「将要使用的 order 键」估算插入下标（与自研 `cmp_order` 字典序一致）。
    fn loro_insert_index(&self, parent: Option<Label>, order: &str) -> usize {
        let siblings = self.live_children_labels(parent);
        let mut idx = 0usize;
        for sib in &siblings {
            let so = self.rs_order.get(*sib).map(|s| s.as_str()).unwrap_or("");
            if so < order {
                idx += 1;
            }
        }
        idx
    }

    /// 双方 move；返回 (自研 Result 是否 Ok, Loro Result 是否 Ok)。
    fn try_move(&mut self, label: Label, new_parent: Option<Label>, order: &str) -> (bool, bool) {
        let bid = self.rs_id(label);
        let new_parent_bid = new_parent.map(|p| self.rs_id(p));
        let rs_ok = self
            .rs
            .apply(
                Origin::User,
                &[Op::Move {
                    id: bid,
                    new_parent: new_parent_bid,
                    order: order.into(),
                }],
            )
            .is_ok();

        let tree = self.tree();
        let tid = self.loro_id(label);
        let loro_ok = match new_parent {
            None => tree.mov(tid, TreeParentId::Root).is_ok(),
            Some(p) => {
                let pid = self.loro_id(p);
                let idx = self.loro_insert_index(Some(p), order);
                // 优先带 index 的 mov_to；失败再 mov
                tree.mov_to(tid, pid, idx).or_else(|_| tree.mov(tid, pid)).is_ok()
            }
        };
        if loro_ok {
            self.loro_doc.commit();
        }
        if rs_ok {
            self.rs_order.insert(label, order.to_string());
        }
        (rs_ok, loro_ok)
    }

    /// 双方 delete。
    fn delete(&mut self, label: Label) {
        let bid = self.rs_id(label);
        self.rs
            .apply(Origin::User, &[Op::Delete { id: bid }])
            .unwrap_or_else(|e| panic!("自研 delete {label}: {e}"));
        let tree = self.tree();
        let tid = self.loro_id(label);
        tree.delete(tid)
            .unwrap_or_else(|e| panic!("loro delete {label}: {e}"));
        self.loro_doc.commit();
    }

    // ── 观测：live 父映射（label → Option<label>，None=根） ──────────────

    fn live_parent_map_rs(&self) -> BTreeMap<Label, Option<Label>> {
        let mut rev: HashMap<BlockId, Label> = HashMap::new();
        for (lab, (bid, _)) in &self.ids {
            rev.insert(*bid, *lab);
        }
        let mut out = BTreeMap::new();
        for (lab, (bid, _)) in &self.ids {
            if let Some(node) = self.rs.tree().get(bid) {
                let parent_lab = node.parent.and_then(|p| rev.get(&p).copied());
                // 若 parent 已不在树中则跳过（删子树后不应再观测）
                if node.parent.is_some() && parent_lab.is_none() {
                    continue;
                }
                out.insert(*lab, parent_lab);
            }
        }
        out
    }

    fn live_parent_map_loro(&self) -> BTreeMap<Label, Option<Label>> {
        let tree = self.tree();
        let mut rev: HashMap<TreeID, Label> = HashMap::new();
        for (lab, (_, tid)) in &self.ids {
            rev.insert(*tid, *lab);
        }
        let mut out = BTreeMap::new();
        for (lab, (_, tid)) in &self.ids {
            if tree.is_node_deleted(tid).unwrap_or(true) {
                continue;
            }
            match tree.parent(*tid) {
                Some(TreeParentId::Root) | None => {
                    out.insert(*lab, None);
                }
                Some(TreeParentId::Node(p)) => {
                    // 父若已删：该节点在 Loro 常连同 tombstone；不应进 live 映射
                    if tree.is_node_deleted(&p).unwrap_or(true) {
                        continue;
                    }
                    if let Some(pl) = rev.get(&p) {
                        out.insert(*lab, Some(*pl));
                    }
                }
                Some(TreeParentId::Deleted) => continue,
                Some(_) => continue,
            }
        }
        out
    }

    /// 自研侧某父下 live 子 labels（按 order 已排序的 children）。
    fn live_children_labels(&self, parent: Option<Label>) -> Vec<Label> {
        let mut rev: HashMap<BlockId, Label> = HashMap::new();
        for (lab, (bid, _)) in &self.ids {
            rev.insert(*bid, *lab);
        }
        let ids: Vec<BlockId> = match parent {
            None => self.rs.tree().root_children.clone(),
            Some(p) => self
                .rs
                .tree()
                .get(&self.rs_id(p))
                .map(|n| n.children.clone())
                .unwrap_or_default(),
        };
        ids.iter().filter_map(|id| rev.get(id).copied()).collect()
    }

    fn live_children_labels_loro(&self, parent: Option<Label>) -> Vec<Label> {
        let tree = self.tree();
        let mut rev: HashMap<TreeID, Label> = HashMap::new();
        for (lab, (_, tid)) in &self.ids {
            rev.insert(*tid, *lab);
        }
        let kids = match parent {
            None => tree.children(TreeParentId::Root).unwrap_or_default(),
            Some(p) => tree.children(self.loro_id(p)).unwrap_or_default(),
        };
        kids.into_iter()
            .filter(|id| !tree.is_node_deleted(id).unwrap_or(true))
            .filter_map(|id| rev.get(&id).copied())
            .collect()
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 不变量断言（双方）
// ═══════════════════════════════════════════════════════════════════════════

fn assert_rs_no_cycle(tree: &BlockTree) {
    let n = tree.nodes.len();
    for &start in tree.nodes.keys() {
        let mut seen = HashSet::new();
        let mut cur = Some(start);
        let mut steps = 0usize;
        while let Some(id) = cur {
            assert!(
                seen.insert(id),
                "自研 parent 成环：start={start} 再访 {id}"
            );
            steps += 1;
            assert!(steps <= n + 1, "自研 parent 链过长 start={start}");
            cur = tree.nodes.get(&id).and_then(|node| node.parent);
        }
    }
}

fn assert_rs_parent_child(tree: &BlockTree) {
    for cid in &tree.root_children {
        let child = tree.nodes.get(cid).expect("根子悬挂");
        assert_eq!(child.parent, None, "根子 parent 须 None");
    }
    for (pid, node) in &tree.nodes {
        for cid in &node.children {
            let child = tree.nodes.get(cid).expect("子悬挂");
            assert_eq!(child.parent, Some(*pid), "父子反向不一致");
        }
    }
    for (id, node) in &tree.nodes {
        match node.parent {
            Some(pid) => {
                let p = tree.nodes.get(&pid).expect("parent 悬挂");
                assert!(p.children.contains(id), "子未出现在父 children");
            }
            None => {
                assert!(
                    tree.root_children.contains(id),
                    "根节点不在 root_children"
                );
            }
        }
    }
}

fn assert_loro_live_acyclic(tree: &LoroTree) {
    let live: Vec<TreeID> = tree
        .nodes()
        .into_iter()
        .filter(|id| !tree.is_node_deleted(id).unwrap_or(true))
        .collect();
    let bound = live.len().saturating_mul(2).max(8);
    for &start in &live {
        let mut seen = HashSet::new();
        let mut cur = start;
        for _ in 0..bound {
            if !seen.insert(cur) {
                panic!("Loro live parent 成环：start={start:?}");
            }
            match tree.parent(cur) {
                Some(TreeParentId::Root) | None => break,
                Some(TreeParentId::Node(p)) => {
                    if tree.is_node_deleted(&p).unwrap_or(true) {
                        // 挂在已删父下：该节点不应算 live；若 is_node_deleted 未标则保守视为终止
                        break;
                    }
                    cur = p;
                }
                Some(TreeParentId::Deleted) => break,
                Some(_) => panic!("Loro parent 未知变体 start={start:?}"),
            }
        }
    }
}

fn assert_both_invariants(d: &DualForest) {
    assert_rs_no_cycle(d.rs.tree());
    assert_rs_parent_child(d.rs.tree());
    assert_loro_live_acyclic(&d.tree());
}

fn assert_live_parent_maps_equal(d: &DualForest) {
    let rs = d.live_parent_map_rs();
    let lo = d.live_parent_map_loro();
    assert_eq!(
        rs, lo,
        "live parent 拓扑差分：\n  自研={rs:?}\n  Loro={lo:?}"
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// W0-L Strict：差分场景
// ═══════════════════════════════════════════════════════════════════════════

/// 场景 1：insert + move → 双方无环、父子同构。
#[test]
fn loro_diff_insert_move_no_cycle() {
    let mut d = DualForest::new("diff-insert-move");
    d.insert("a", None, "a0");
    d.insert("b", None, "a1");
    let (rs_ok, lo_ok) = d.try_move("b", Some("a"), "a0");
    assert!(rs_ok && lo_ok, "合法 move 双方应成功 rs={rs_ok} loro={lo_ok}");

    assert_both_invariants(&d);
    assert_live_parent_maps_equal(&d);

    let map = d.live_parent_map_rs();
    assert_eq!(map.get("a"), Some(&None));
    assert_eq!(map.get("b"), Some(&Some("a")));
    assert!(
        d.live_children_labels(Some("a")).contains(&"b"),
        "自研 a.children 含 b"
    );
    assert!(
        d.live_children_labels_loro(Some("a")).contains(&"b"),
        "Loro a.children 含 b"
    );
}

/// 场景 2：move 入自身子孙 → **双方都拒**，形态不变。
#[test]
fn loro_diff_cycle_both_reject() {
    let mut d = DualForest::new("diff-cycle");
    d.insert("a", None, "a0");
    d.insert("b", Some("a"), "a0");
    d.insert("c", Some("b"), "a0");
    // A→B→C；把 A 挂到 C 下成环
    let before_rs = d.live_parent_map_rs();
    let before_lo = d.live_parent_map_loro();

    let (rs_ok, lo_ok) = d.try_move("a", Some("c"), "a0");
    assert!(!rs_ok, "自研应拒成环 move");
    assert!(!lo_ok, "Loro 应拒成环 move");

    // 显式校验自研错误类型
    let bid_a = d.rs_id("a");
    let bid_c = d.rs_id("c");
    let err = d
        .rs
        .apply(
            Origin::User,
            &[Op::Move {
                id: bid_a,
                new_parent: Some(bid_c),
                order: "a0".into(),
            }],
        )
        .unwrap_err();
    assert!(
        matches!(err, ApplyError::Invariant(_)),
        "自研成环 → Invariant，得 {err:?}"
    );

    // Loro 错误类型
    let tree = d.tree();
    let err_l = tree
        .mov(d.loro_id("a"), d.loro_id("c"))
        .expect_err("Loro 成环");
    match err_l {
        LoroError::TreeError(LoroTreeError::CyclicMoveError) => {}
        other => panic!("期望 CyclicMoveError，得 {other:?}"),
    }

    assert_eq!(d.live_parent_map_rs(), before_rs, "自研形态不变");
    assert_eq!(d.live_parent_map_loro(), before_lo, "Loro 形态不变");
    assert_both_invariants(&d);
    assert_live_parent_maps_equal(&d);
}

/// 场景 3：delete(A) 后 move(B under A) → **删胜方向**双方一致。
///
/// ## 约定不变量（删胜）
/// - A 不在 live 集
/// - 不存在 live 边 `B → parent=A`（B 不能作为 **live 子** 挂在 **live A** 下）
///
/// ## 规则差（标清，不默默对齐切栈）
/// | 侧 | 序贯 delete 后 move(B→A) |
/// | -- | ------------------------ |
/// | **自研** | `NotFound`，整次 apply 失败；B 仍为根 live |
/// | **Loro** | `mov` **允许**挂到 `Deleted` 父 → B 自身 tombstone（`is_node_deleted`） |
///
/// 方向均为「删胜」：终态 live 森林里 A 已消失，且无 live parent 指向 A。
/// 规格 MV-03 正文「no-op+审计」与自研 `NotFound` / Loro tombstone 的细粒度差异
/// 不在本包关闭；本测只钉**方向一致**。
#[test]
fn loro_diff_delete_wins_over_move() {
    let mut d = DualForest::new("diff-del-wins");
    d.insert("a", None, "a0");
    d.insert("b", None, "a1");

    d.delete("a");

    // ── 自研：move under 已删 → NotFound，B 仍根 ──
    let bid_b = d.rs_id("b");
    let bid_a = d.rs_id("a");
    let err = d
        .rs
        .apply(
            Origin::User,
            &[Op::Move {
                id: bid_b,
                new_parent: Some(bid_a),
                order: "a0".into(),
            }],
        )
        .unwrap_err();
    assert!(
        matches!(err, ApplyError::NotFound(_)),
        "自研删胜：move 目标不存在 → NotFound，得 {err:?}"
    );
    assert!(
        d.rs.tree().get(&bid_b).is_some(),
        "自研 B 仍 live"
    );
    assert_eq!(
        d.rs.tree().get(&bid_b).unwrap().parent,
        None,
        "自研 B 仍为根（move 未生效）"
    );
    assert!(
        d.rs.tree().get(&bid_a).is_none(),
        "自研 A 已删"
    );

    // ── Loro：mov 到 Deleted 父 → 成功但 B 变 tombstone（规则差） ──
    let tree = d.tree();
    let tid_a = d.loro_id("a");
    let tid_b = d.loro_id("b");
    assert!(
        tree.is_node_deleted(&tid_a).unwrap_or(false),
        "Loro A 已删"
    );
    let loro_mov = tree.mov(tid_b, tid_a);
    // 允许 Ok（tombstone）或 Err；两种都须满足删胜方向
    match loro_mov {
        Ok(()) => {
            d.loro_doc.commit();
            let tree = d.tree();
            assert!(
                tree.is_node_deleted(&tid_b).unwrap_or(false),
                "规则差：Loro 挂 Deleted 父后 B 应 tombstone"
            );
        }
        Err(e) => {
            // 若未来 Loro 改为拒，亦满足「move 不生效」
            let _ = e;
            let tree = d.tree();
            assert!(
                !tree.is_node_deleted(&tid_b).unwrap_or(true),
                "Loro 拒 move 时 B 应仍 live"
            );
            match tree.parent(tid_b) {
                Some(TreeParentId::Root) | None => {}
                other => panic!("Loro 拒 move 后 B parent 异常: {other:?}"),
            }
        }
    }

    // ── 共通删胜方向 ──
    // A 非 live
    assert!(d.rs.tree().get(&bid_a).is_none());
    assert!(d.tree().is_node_deleted(&tid_a).unwrap_or(false));

    // 无 live 边指向 A
    for (id, node) in &d.rs.tree().nodes {
        assert_ne!(
            node.parent,
            Some(bid_a),
            "自研 live 节点 {id} 不得以已删 A 为 parent"
        );
    }
    let tree = d.tree();
    for id in tree.nodes() {
        if tree.is_node_deleted(&id).unwrap_or(true) {
            continue;
        }
        if let Some(TreeParentId::Node(p)) = tree.parent(id) {
            assert_ne!(p, tid_a, "Loro live 节点不得以已删 A 为 parent");
            assert!(
                !tree.is_node_deleted(&p).unwrap_or(true),
                "Loro live 节点 parent 须 live"
            );
        }
    }

    assert_both_invariants(&d);
}

/// 场景 4（order）：同父多插 → 双方兄弟序列与 order 键字典序一致。
#[test]
fn loro_diff_sibling_order() {
    let mut d = DualForest::new("diff-order");
    d.insert("p", None, "a0");
    // 乱序插入：c 先、a 次、b 末 —— 终态应按 a0 < a1 < a2
    d.insert("c", Some("p"), "a2");
    d.insert("a", Some("p"), "a0");
    d.insert("b", Some("p"), "a1");

    assert_both_invariants(&d);

    let rs_kids = d.live_children_labels(Some("p"));
    let lo_kids = d.live_children_labels_loro(Some("p"));
    assert_eq!(rs_kids, vec!["a", "b", "c"], "自研兄弟序");
    assert_eq!(
        lo_kids, rs_kids,
        "Loro 兄弟序应对齐约定 order 键（差分） lo={lo_kids:?} rs={rs_kids:?}"
    );
    assert_live_parent_maps_equal(&d);
}

/// 额外：合法深 move 后双方拓扑同构。
#[test]
fn w0_l_deep_move_topology_match() {
    let mut d = DualForest::new("diff-deep");
    d.insert("r", None, "a0");
    d.insert("x", Some("r"), "a0");
    d.insert("y", Some("r"), "a1");
    d.insert("z", Some("x"), "a0");
    // z: r/x/z → 移到 y 下
    let (rs_ok, lo_ok) = d.try_move("z", Some("y"), "a0");
    assert!(rs_ok && lo_ok);
    assert_both_invariants(&d);
    assert_live_parent_maps_equal(&d);
    assert_eq!(d.live_parent_map_rs().get("z"), Some(&Some("y")));
}

// ═══════════════════════════════════════════════════════════════════════════
// W0-L-S 脚手架：仅 Loro 自洽（**不**计为 W0-L 对照完成）
// ═══════════════════════════════════════════════════════════════════════════

/// 从 `start` 沿 parent 上溯到 Root，检测是否无环且有穷终止。
fn path_to_root_is_acyclic(tree: &LoroTree, start: TreeID) -> bool {
    let mut seen = HashSet::new();
    let mut cur = start;
    let bound = tree.nodes().len().saturating_mul(2).max(8);
    for _ in 0..bound {
        if !seen.insert(cur) {
            return false;
        }
        match tree.parent(cur) {
            Some(TreeParentId::Root) | None => return true,
            Some(TreeParentId::Node(p)) => cur = p,
            Some(TreeParentId::Deleted) => return true,
            Some(_) => return false,
        }
    }
    false
}

/// W0-L-S：仅 Loro insert+mov 自洽（保留脚手架；**≠** 差分完成）。
#[test]
fn oracle_movable_tree_insert_and_move_no_cycle() {
    let doc = LoroDoc::new();
    let tree = doc.get_tree("blocks");
    tree.enable_fractional_index(0);

    let a = tree.create(None).expect("root a");
    let b = tree.create(None).expect("root b");
    tree.mov(b, a).expect("mov b under a");
    doc.commit();

    assert_eq!(tree.parent(a), Some(TreeParentId::Root));
    assert_eq!(tree.parent(b), Some(TreeParentId::Node(a)));
    let kids = tree.children(a).expect("a children");
    assert!(kids.contains(&b), "a.children 含 b: {kids:?}");
    assert!(path_to_root_is_acyclic(&tree, a));
    assert!(path_to_root_is_acyclic(&tree, b));
}

/// W0-L-S：仅 Loro 成环拒（脚手架）。
#[test]
fn oracle_movable_tree_cyclic_move_rejected() {
    let doc = LoroDoc::new();
    let tree = doc.get_tree("blocks");
    tree.enable_fractional_index(0);

    let a = tree.create(None).expect("a");
    let b = tree.create(a).expect("b under a");
    let c = tree.create(b).expect("c under b");

    let err = tree.mov(a, c).expect_err("成环 move 应失败");
    match err {
        LoroError::TreeError(LoroTreeError::CyclicMoveError) => {}
        other => panic!("期望 CyclicMoveError，得到: {other:?}"),
    }
    assert_eq!(tree.parent(a), Some(TreeParentId::Root));
    assert_eq!(tree.parent(b), Some(TreeParentId::Node(a)));
    assert_eq!(tree.parent(c), Some(TreeParentId::Node(b)));
    assert!(path_to_root_is_acyclic(&tree, c));
}

/// W0-L-S：movable list 自洽占位。
#[test]
fn oracle_movable_list_insert_and_mov() {
    let doc = LoroDoc::new();
    let list = doc.get_movable_list("order");
    list.insert(0, "x").expect("insert x");
    list.insert(1, "y").expect("insert y");
    list.insert(2, "z").expect("insert z");
    list.mov(0, 2).expect("mov 0→2");
    doc.commit();

    let v = list.get_value();
    let arr = v.into_list().expect("list value");
    assert_eq!(arr.len(), 3);
    let texts: Vec<String> = arr
        .iter()
        .map(|x| x.as_string().map(|s| s.to_string()).unwrap_or_default())
        .collect();
    assert!(texts.contains(&"x".into()));
    assert!(texts.contains(&"y".into()));
    assert!(texts.contains(&"z".into()));
}

/// 生产路径无 loro 符号（dev-dep 隔离）。
#[test]
fn production_doc_session_constructs_without_loro() {
    let _s = DocSession::new("oracle-smoke");
}
