use super::*;

// ── 追加 / 分叉 / 叶子移动 ──

/// 追加：新节点挂在当前叶子下并推进叶子指针（session-tree.test.ts:7）
#[test]
fn append_chains_under_current_leaf_and_advances_pointer() {
    let mut t = tree();
    let first = t.append("first", json!({ "text": "first" })).unwrap();
    let second = t.append("second", json!({ "text": "second" })).unwrap();

    assert!(first.parent_id.is_none());
    assert_eq!(second.parent_id.as_deref(), Some("first"));
    assert_eq!(t.current_leaf_id(), Some("second"));
    // 当前叶子路径（None 入参 = 根前空路径，见 read_branch_path 文档）
    let branch = t.read_branch_path(t.current_leaf_id()).unwrap();
    let path: Vec<&str> = branch.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(path, vec!["first", "second"]);
}

/// 分叉：从某节点派生新叶子，原分支路径不被改写（session-tree.test.ts:19）
#[test]
fn fork_derives_new_leaf_without_rewriting_original_path() {
    let mut t = tree();
    let (root, original, _leaf) = chain(&mut t);

    let branch = t
        .fork(&root.id, "branch", json!({ "text": "branch" }))
        .unwrap();
    assert_eq!(branch.parent_id.as_deref(), Some("root"));
    assert_eq!(t.current_leaf_id(), Some("branch"));
    // 原叶子路径仍可回溯（original = mid，路径为 root → mid）
    let original_branch = t.read_branch_path(Some(&original.id)).unwrap();
    let original_path: Vec<&str> = original_branch.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(original_path, vec!["root", "mid"]);
    let branch_branch = t.read_branch_path(Some(&branch.id)).unwrap();
    let branch_path: Vec<&str> = branch_branch.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(branch_path, vec!["root", "branch"]);
}

/// 分叉：目标节点不存在 → NotFound（session-tree.test.ts:145）
#[test]
fn fork_rejects_missing_source() {
    let mut t = tree();
    t.append("root", json!({})).unwrap();
    let err = t.fork("missing", "x", json!({})).unwrap_err();
    assert!(matches!(err, SessionTreeError::NotFound { .. }));
}

/// 叶子移动：指针迁移不新增条目（session-tree.test.ts:33）
#[test]
fn move_leaf_migrates_pointer_without_appending() {
    let mut t = tree();
    let (root, _mid, _leaf) = chain(&mut t);
    let count_before = t.entries().len();

    t.move_leaf(Some(&root.id), None).unwrap();
    assert_eq!(t.entries().len(), count_before, "移动不新增条目");
    let new = t.append("new", json!({})).unwrap();
    assert_eq!(new.parent_id.as_deref(), Some("root"));
    // 旧分支路径仍可回溯
    assert!(t.read_branch_path(Some("leaf")).is_ok());
}

/// 叶子移动：目标不存在 → NotFound（session-tree.test.ts:145）
#[test]
fn move_leaf_rejects_missing_target() {
    let mut t = tree();
    t.append("root", json!({})).unwrap();
    let err = t.move_leaf(Some("missing"), None).unwrap_err();
    assert!(matches!(err, SessionTreeError::NotFound { .. }));
}

/// 叶子移动：expected_current_leaf 校验（乐观并发控制）
#[test]
fn move_leaf_validates_expected_current_leaf() {
    let mut t = tree();
    let (root, _mid, leaf) = chain(&mut t);

    // 期望与实际一致 → 成功
    t.move_leaf(Some(&root.id), Some(&leaf.id)).unwrap();
    assert_eq!(t.current_leaf_id(), Some("root"));

    // 期望与实际不一致 → ExpectedLeafMismatch（含实际值）
    let err = t.move_leaf(Some("leaf"), Some("mid")).unwrap_err();
    match err {
        SessionTreeError::ExpectedLeafMismatch { expected, actual } => {
            assert_eq!(expected, "mid");
            assert_eq!(actual.as_deref(), Some("root"), "实际叶子为当前 root");
        }
        other => panic!("期望 ExpectedLeafMismatch：{other:?}"),
    }
    // 失败后指针未被改写
    assert_eq!(t.current_leaf_id(), Some("root"));
}

/// 恢复叶子：无显式叶子时恢复到最后插入条目（session-tree.test.ts:86）
#[test]
fn restore_leaf_defaults_to_last_inserted() {
    let mut t = tree();
    chain(&mut t);
    t.move_leaf(Some("root"), None).unwrap();
    assert_eq!(t.current_leaf_id(), Some("root"));

    t.restore_leaf(None).unwrap();
    assert_eq!(
        t.current_leaf_id(),
        Some("leaf"),
        "无显式叶子时回最后插入条目"
    );
}

/// 恢复叶子：根前位置（null）合法（session-tree.test.ts:110）
#[test]
fn restore_leaf_allows_root_before_first_position() {
    let mut t = tree();
    t.append("old_root", json!({})).unwrap();
    t.move_leaf(None, None).unwrap();
    let new_root = t.append("new_root", json!({})).unwrap();
    assert!(new_root.parent_id.is_none());
    let branch = t.read_branch_path(t.current_leaf_id()).unwrap();
    let path: Vec<&str> = branch.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(path, vec!["new_root"]);
}

// ── 结构校验与防御 ──

/// 重复 id → DuplicateId（session-tree.test.ts:180 / :215）
#[test]
fn from_entries_rejects_duplicate_ids() {
    let entries = vec![
        SessionTreeEntry::node("dup", None, json!({})),
        SessionTreeEntry::node("dup", Some("dup".to_string()), json!({})),
    ];
    let err = SessionTree::from_entries("s".into(), entries, None).unwrap_err();
    assert!(matches!(err, SessionTreeError::DuplicateId { .. }));
}

/// 父先于子校验（session-tree.test.ts:121）
#[test]
fn from_entries_rejects_parent_after_child() {
    let entries = vec![SessionTreeEntry::node(
        "child",
        Some("missing".to_string()),
        json!({}),
    )];
    let err = SessionTree::from_entries("s".into(), entries, None).unwrap_err();
    assert!(matches!(err, SessionTreeError::InvalidState { .. }));
}

/// 分支摘要引用缺失的被放弃叶子 → NotFound（session-tree.test.ts:195）
#[test]
fn from_entries_rejects_abandoned_leaf_not_found() {
    let entries = vec![
        SessionTreeEntry::node("root", None, json!({})),
        SessionTreeEntry {
            id: "summary_1".to_string(),
            parent_id: Some("root".to_string()),
            created_at: 1,
            kind: SessionTreeEntryKind::BranchSummary {
                summary: "abandoned".to_string(),
                abandoned_leaf_id: Some("ghost".to_string()),
                details: None,
            },
        },
    ];
    let err = SessionTree::from_entries("s".into(), entries, None).unwrap_err();
    assert!(matches!(err, SessionTreeError::NotFound { .. }));
}

/// 分支路径环检测（防御，session-tree.test.ts:156）
#[test]
fn read_branch_path_detects_cycle() {
    // 手工构造非法树：a → b、b → a 成环
    let mut t = tree();
    t.append("a", json!({})).unwrap();
    t.append("b", json!({})).unwrap();
    let (a, b) = (t.entry("a").unwrap().clone(), t.entry("b").unwrap().clone());
    t.entries = vec![
        SessionTreeEntry {
            parent_id: Some(b.id.clone()),
            ..a.clone()
        },
        SessionTreeEntry {
            parent_id: Some(a.id.clone()),
            ..b.clone()
        },
    ];
    let err = t.read_branch_path(Some("b")).unwrap_err();
    assert!(matches!(err, SessionTreeError::Cycle { .. }));
}

/// 分支放弃摘要：挂到目标节点，记录被放弃叶子（session-tree.test.ts:47）
#[test]
fn abandon_branch_attaches_summary_at_target() {
    let mut t = tree();
    let (root, _mid, abandoned) = chain(&mut t);
    let summary = t
        .abandon_branch_with_summary(
            Some(&root.id),
            "summary_1",
            "Captured the abandoned work.",
            Some(json!({ "reason": "changed direction" })),
        )
        .unwrap();
    assert_eq!(summary.parent_id.as_deref(), Some("root"));
    match &summary.kind {
        SessionTreeEntryKind::BranchSummary {
            summary,
            abandoned_leaf_id,
            ..
        } => {
            assert_eq!(summary, "Captured the abandoned work.");
            assert_eq!(abandoned_leaf_id.as_deref(), Some(abandoned.id()));
        }
        other => panic!("期望 BranchSummary：{other:?}"),
    }
    assert_eq!(t.current_leaf_id(), Some("summary_1"));
    let branch = t.read_branch_path(t.current_leaf_id()).unwrap();
    let path: Vec<&str> = branch.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(path, vec!["root", "summary_1"]);
}
