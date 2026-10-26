//! SessionTree 单元测试（对齐 packages/agent-orchestrator session-tree.test.ts
//! 语义锚：append 推进叶子 / fork 不改写原分支 / move_leaf 乐观校验 /
//! abandon 回滚摘要 / restore_leaf 恢复序 / 分支路径与环检测 / checkpoint
//! 三态 / 记录往返与结构校验）。

use super::tree::SessionTree;
use crate::session::record::{
    SessionRecord, SessionTreeEntry, SessionTreeEntryKind, SessionTreeError,
};
use conex_types::checkpoint::{CheckpointPayload, LeafCheckpointState};
use serde_json::json;

/// 构造节点条目（测试helper：payload 固定含 id 便于断言）
fn node_entry(id: &str, parent: Option<&str>) -> SessionTreeEntry {
    SessionTreeEntry {
        id: id.to_string(),
        parent_id: parent.map(str::to_string),
        created_at: 1_000,
        kind: SessionTreeEntryKind::Node {
            payload: json!({ "id": id }),
        },
    }
}

// ── append / fork / 叶子指针 ─────────────────────────────────────────

#[test]
fn append_advances_leaf_and_links_parent() {
    let mut tree = SessionTree::new("s1");
    let a = tree.append("a", json!({"step": 1})).expect("追加 a");
    assert_eq!(a.parent_id, None, "空树首个 append 挂根");
    assert_eq!(tree.current_leaf_id(), Some("a"));
    let b = tree.append("b", json!({"step": 2})).expect("追加 b");
    assert_eq!(b.parent_id.as_deref(), Some("a"), "后续 append 挂当前叶子");
    assert_eq!(tree.current_leaf_id(), Some("b"));
    assert_eq!(tree.entries().len(), 2);
}

#[test]
fn fork_derives_from_explicit_leaf_without_rewriting_original_branch() {
    let mut tree = SessionTree::new("s1");
    tree.append("a", json!(1)).expect("a");
    tree.append("b", json!(2)).expect("b");
    let f = tree.fork("a", "f", json!(3)).expect("从 a 分叉");
    assert_eq!(
        f.parent_id.as_deref(),
        Some("a"),
        "fork 的父 = from_leaf_id"
    );
    assert_eq!(tree.current_leaf_id(), Some("f"), "叶子推进到新分叉");
    // 原分支路径不被改写：b 仍是 a 的子节点
    let b = tree.entry("b").expect("b 存在");
    assert_eq!(b.parent_id.as_deref(), Some("a"));
    assert_eq!(tree.entries().len(), 3);
}

#[test]
fn fork_from_missing_leaf_is_not_found() {
    let mut tree = SessionTree::new("s1");
    let err = tree.fork("missing", "f", json!(1)).unwrap_err();
    assert!(matches!(err, SessionTreeError::NotFound { ref id } if id == "missing"));
}

#[test]
fn move_leaf_moves_pointer_and_validates_expected_leaf() {
    let mut tree = SessionTree::new("s1");
    tree.append("a", json!(1)).expect("a");
    tree.append("b", json!(2)).expect("b");
    // 乐观并发校验：期望不匹配 → ExpectedLeafMismatch
    let err = tree.move_leaf(Some("a"), Some("wrong")).unwrap_err();
    assert!(matches!(err, SessionTreeError::ExpectedLeafMismatch { .. }));
    // 期望匹配 → 移动成功，不新增条目
    tree.move_leaf(Some("a"), Some("b")).expect("乐观校验通过");
    assert_eq!(tree.current_leaf_id(), Some("a"));
    assert_eq!(tree.entries().len(), 2, "move_leaf 不新增条目");
    // None = 根前位置
    tree.move_leaf(None, Some("a")).expect("移到根前");
    assert_eq!(tree.current_leaf_id(), None);
    // 目标不存在 → NotFound
    let err = tree.move_leaf(Some("missing"), None).unwrap_err();
    assert!(matches!(err, SessionTreeError::NotFound { ref id } if id == "missing"));
}

// ── abandon / restore ────────────────────────────────────────────────

#[test]
fn abandon_branch_writes_summary_and_advances_leaf() {
    let mut tree = SessionTree::new("s1");
    tree.append("a", json!(1)).expect("a");
    tree.append("b", json!(2)).expect("b");
    let summary = tree
        .abandon_branch_with_summary(Some("a"), "sum-1", "放弃 b 分支", None)
        .expect("放弃摘要");
    assert_eq!(summary.parent_id.as_deref(), Some("a"), "摘要挂在目标下");
    match &summary.kind {
        SessionTreeEntryKind::BranchSummary {
            abandoned_leaf_id, ..
        } => assert_eq!(abandoned_leaf_id.as_deref(), Some("b"), "记录被放弃叶子"),
        other => panic!("应为 BranchSummary，实际 {other:?}"),
    }
    assert_eq!(tree.current_leaf_id(), Some("sum-1"), "叶子推进到摘要");
}

#[test]
fn abandon_rejects_duplicate_summary_id() {
    let mut tree = SessionTree::new("s1");
    tree.append("a", json!(1)).expect("a");
    tree.abandon_branch_with_summary(Some("a"), "sum-1", "第一次", None)
        .expect("第一次放弃");
    let err = tree
        .abandon_branch_with_summary(Some("a"), "sum-1", "重复 id", None)
        .unwrap_err();
    assert!(matches!(err, SessionTreeError::DuplicateId { ref id } if id == "sum-1"));
}

#[test]
fn restore_leaf_defaults_to_last_inserted() {
    let mut tree = SessionTree::new("s1");
    tree.append("a", json!(1)).expect("a");
    tree.append("b", json!(2)).expect("b");
    tree.move_leaf(Some("a"), Some("b")).expect("移回 a");
    // None = 恢复到最后插入条目（b）
    tree.restore_leaf(None).expect("恢复最后插入");
    assert_eq!(tree.current_leaf_id(), Some("b"));
    // 显式 id 校验存在性
    let err = tree.restore_leaf(Some("missing")).unwrap_err();
    assert!(matches!(err, SessionTreeError::NotFound { ref id } if id == "missing"));
}

// ── 分支路径与环检测 ─────────────────────────────────────────────────

#[test]
fn read_branch_path_returns_root_to_leaf_chain() {
    let mut tree = SessionTree::new("s1");
    tree.append("a", json!(1)).expect("a");
    tree.append("b", json!(2)).expect("b");
    tree.fork("a", "c", json!(3)).expect("c");
    let path_ids = tree.read_branch_path_ids(Some("c")).expect("c 的路径");
    assert_eq!(path_ids, vec!["a", "c"], "根到叶子的引用链");
    // None 叶子 = 空路径
    assert!(tree.read_branch_path(None).expect("空路径").is_empty());
    // 不存在的叶子 → NotFound
    let err = tree.read_branch_path(Some("missing")).unwrap_err();
    assert!(matches!(err, SessionTreeError::NotFound { .. }));
}

// 环检测（traverse_branch_refs 的 seen-set 防御）经公共构造器不可达：
// from_entries 强制「父先于子出现」，父链必然终止于根（b→c 与 c→b 无法
// 同时满足插入序）——Cycle 变体防御的是 entry_index 与 entries 失同步的
// 内部不变量破坏，无法在不破坏结构校验的前提下构造，故无直接用例。

// ── checkpoint 三态 ──────────────────────────────────────────────────

#[test]
fn leaf_checkpoint_roundtrip_and_three_states() {
    use conex_types::checkpoint::CHECKPOINT_PAYLOAD_KEY as KEY;
    let mut tree = SessionTree::new("s1");
    tree.append("a", json!({"plain": true})).expect("a");

    // Absent：无 checkpoint 键
    assert!(matches!(
        tree.read_leaf_checkpoint(Some("a")),
        LeafCheckpointState::Absent
    ));
    // 写入 → Present（payload 其它字段保留）
    let checkpoint = CheckpointPayload {
        target: "完成剩余功能".to_string(),
        summary: "已完成主体".to_string(),
        timestamp: None,
        completed: vec!["主体实现".to_string()],
        files: Vec::new(),
        next: Vec::new(),
    };
    tree.set_leaf_checkpoint("a", &checkpoint)
        .expect("写检查点");
    match tree.read_leaf_checkpoint(Some("a")) {
        LeafCheckpointState::Present(c) => assert_eq!(c.target, "完成剩余功能"),
        other => panic!("应 Present，实际 {other:?}"),
    }
    let entry = tree.entry("a").expect("a");
    if let SessionTreeEntryKind::Node { payload } = &entry.kind {
        assert_eq!(payload["plain"], json!(true), "非 checkpoint 字段原样保留");
        assert!(payload.get(KEY).is_some());
    }
    // 条目不存在 → Absent（fail-open）
    assert!(matches!(
        tree.read_leaf_checkpoint(Some("missing")),
        LeafCheckpointState::Absent
    ));
    // 非节点条目（BranchSummary）→ Absent
    tree.abandon_branch_with_summary(Some("a"), "sum", "摘要", None)
        .expect("摘要");
    assert!(matches!(
        tree.read_leaf_checkpoint(Some("sum")),
        LeafCheckpointState::Absent
    ));
    // Corrupt：checkpoint 键存在但载荷非法
    let mut tree2 = SessionTree::new("s2");
    tree2
        .append("x", json!({ KEY: {"target": 123} }))
        .expect("x");
    match tree2.read_leaf_checkpoint(Some("x")) {
        LeafCheckpointState::Corrupt(_) => {}
        other => panic!("应 Corrupt，实际 {other:?}"),
    }
}

#[test]
fn set_leaf_checkpoint_rejects_non_node_entries() {
    let mut tree = SessionTree::new("s1");
    tree.append("a", json!(1)).expect("a");
    tree.abandon_branch_with_summary(Some("a"), "sum", "摘要", None)
        .expect("摘要");
    let checkpoint = CheckpointPayload {
        target: "t".to_string(),
        summary: "s".to_string(),
        timestamp: None,
        completed: Vec::new(),
        files: Vec::new(),
        next: Vec::new(),
    };
    let err = tree.set_leaf_checkpoint("sum", &checkpoint).unwrap_err();
    assert!(matches!(err, SessionTreeError::InvalidState { .. }));
    let err = tree
        .set_leaf_checkpoint("missing", &checkpoint)
        .unwrap_err();
    assert!(matches!(err, SessionTreeError::NotFound { .. }));
}

// ── 记录往返与结构校验 ───────────────────────────────────────────────

#[test]
fn session_record_roundtrip_preserves_tree() {
    let mut tree = SessionTree::new("s1");
    tree.append("a", json!(1)).expect("a");
    tree.append("b", json!(2)).expect("b");
    tree.fork("a", "c", json!(3)).expect("c");
    // fork 后叶子在 c；乐观校验移动到 a
    tree.move_leaf(Some("a"), Some("c")).expect("乐观校验通过");

    let record: SessionRecord = tree.to_session_record();
    assert_eq!(record.current_leaf_id.as_deref(), Some("a"));
    let restored = SessionTree::from_session_record(record).expect("记录还原");
    assert_eq!(restored, tree, "往返等价（PartialEq 含 entries 与指针）");
}

#[test]
fn from_entries_rejects_duplicate_id_and_out_of_order_parent() {
    // 重复 id
    let dup = vec![node_entry("a", None), node_entry("a", Some("a"))];
    let err = SessionTree::from_entries("s1".to_string(), dup, None).unwrap_err();
    assert!(matches!(err, SessionTreeError::DuplicateId { ref id } if id == "a"));
    // 父未先出现
    let orphan = vec![node_entry("b", Some("a")), node_entry("a", None)];
    let err = SessionTree::from_entries("s1".to_string(), orphan, None).unwrap_err();
    assert!(
        matches!(err, SessionTreeError::InvalidState { .. }),
        "父必须先于子出现"
    );
    // 分支摘要的 abandoned_leaf_id 未出现过
    let dangling = vec![SessionTreeEntry {
        id: "sum".to_string(),
        parent_id: None,
        created_at: 1_000,
        kind: SessionTreeEntryKind::BranchSummary {
            summary: "摘要".to_string(),
            abandoned_leaf_id: Some("ghost".to_string()),
            details: None,
        },
    }];
    let err = SessionTree::from_entries("s1".to_string(), dangling, None).unwrap_err();
    assert!(
        matches!(err, SessionTreeError::NotFound { ref id } if id == "ghost"),
        "abandoned_leaf_id 必须已出现"
    );
}

#[test]
fn entry_lookup_is_o1_index_backed() {
    let mut tree = SessionTree::new("s1");
    for i in 0..100 {
        tree.append(format!("n{i}"), json!(i)).expect("append");
    }
    // 索引查表：任意位置 O(1) 命中且返回正确条目
    let mid = tree.entry("n50").expect("n50");
    assert_eq!(mid.parent_id.as_deref(), Some("n49"));
    assert!(tree.entry("nope").is_none());
}
