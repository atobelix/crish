//! commit / 投影 diff / index 测（**SD-52** 测拆）。
//!
//! 由 [`super`]（`projection_tests`）经 `#[path]` 接入。
//! **≠ 打开完成**；**≠ EL-04**；**≠** 重做 projection 实现。

use super::*;

#[test]
fn apply_projection_diff_upsert_search_and_remove() {
    let (dir, db) = temp_db();
    let store = WorkspaceStore::open(&db).unwrap();
    let id1 = BlockId::new();
    let id2 = BlockId::new();

    let diff = ProjectionDiff {
        doc_id: "doc-p".into(),
        rev: 1,
        upserts: vec![
            BlockUpsert {
                id: id1,
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
                children: vec![],
                order: "a0".into(),
                parent: None,
                plain_text: "alpha searchable_token_one".into(),
            },
            BlockUpsert {
                id: id2,
                kind: BlockKind::Heading { level: 2 },
                props: BlockProps::default(),
                children: vec![],
                order: "a1".into(),
                parent: None,
                plain_text: "beta searchable_token_two".into(),
            },
        ],
        removes: vec![],
        text_touches: vec![],
        full_rebuild: false,
    };
    store.apply_projection_diff("doc-p", &diff).unwrap();

    assert_eq!(store.count_blocks("doc-p").unwrap(), 2);
    let hits = store
        .search_fulltext("doc-p", "searchable_token_one", 10)
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].block_id, id1.to_string());
    assert_eq!(hits[0].kind, "paragraph");

    let hits2 = store
        .search_fulltext("doc-p", "searchable_token_two", 10)
        .unwrap();
    assert_eq!(hits2[0].kind, "heading:2");

    // lag 已抬升
    assert_eq!(store.mirror_lag("doc-p").unwrap(), Some(1));

    // remove id1
    let diff2 = ProjectionDiff {
        doc_id: "doc-p".into(),
        rev: 2,
        upserts: vec![],
        removes: vec![id1],
        text_touches: vec![],
        full_rebuild: false,
    };
    store.apply_projection_diff("doc-p", &diff2).unwrap();
    assert!(store
        .search_fulltext("doc-p", "searchable_token_one", 10)
        .unwrap()
        .is_empty());
    assert_eq!(store.count_blocks("doc-p").unwrap(), 1);
    assert_eq!(store.mirror_lag("doc-p").unwrap(), Some(2));

    cleanup_dir(&dir);
}

#[test]
fn commit_ops_session_shared_store_end_to_end() {
    let (dir, db) = temp_db();
    let store = SharedWorkspaceStore::open(&db).unwrap();
    let mut session = DocSession::new("doc-e2e").with_persistence(Box::new(store.clone()));

    let id_a = BlockId::new();
    let id_b = BlockId::new();
    let ops = [
        Op::Insert {
            id: id_a,
            parent: None,
            order: "a0".into(),
            kind: BlockKind::Paragraph,
            props: BlockProps::default(),
        },
        Op::TextEdit {
            id: id_a,
            start: 0,
            end: 0,
            insert: "pipeline_hit_alpha".into(),
        },
        Op::Insert {
            id: id_b,
            parent: None,
            order: "a1".into(),
            kind: BlockKind::Paragraph,
            props: BlockProps::default(),
        },
        Op::TextEdit {
            id: id_b,
            start: 0,
            end: 0,
            insert: "pipeline_hit_beta".into(),
        },
    ];

    let ev = commit_ops(&mut session, &store, Origin::User, &ops).unwrap();
    match &ev {
        DocEvent::Projection { diff } => {
            assert_eq!(diff.doc_id, "doc-e2e");
            assert!(diff.rev >= 1);
            assert!(!diff.upserts.is_empty());
        }
        other => panic!("expected Projection, got {other:?}"),
    }

    // 权威 updates 已写
    assert!(store.load_rev("doc-e2e").unwrap() >= 1);
    assert!(store.load_pending_count("doc-e2e").unwrap() >= 1);

    // 索引可搜
    let hits = store
        .search_fulltext("doc-e2e", "pipeline_hit_alpha", 10)
        .unwrap();
    assert_eq!(hits.len(), 1, "Insert+TextEdit 后应命中 plain_text");
    assert_eq!(hits[0].block_id, id_a.to_string());

    let hits_b = store
        .search_fulltext("doc-e2e", "pipeline_hit_beta", 10)
        .unwrap();
    assert_eq!(hits_b.len(), 1);

    // rev 前进 → mirror lag 非 0
    let lag = store.mirror_lag("doc-e2e").unwrap().unwrap();
    assert!(lag > 0, "advance 后 lag 应 > 0，got {lag}");

    // Delete → 索引消失
    let del = [Op::Delete { id: id_b }];
    commit_ops(&mut session, &store, Origin::User, &del).unwrap();
    assert!(store
        .search_fulltext("doc-e2e", "pipeline_hit_beta", 10)
        .unwrap()
        .is_empty());
    assert_eq!(
        store
            .search_fulltext("doc-e2e", "pipeline_hit_alpha", 10)
            .unwrap()
            .len(),
        1
    );

    // export 清 lag
    let mirror_root = dir.join("mirrors");
    store
        .export_md_mirror("doc-e2e", session.tree(), session.rev(), &mirror_root)
        .unwrap();
    assert_eq!(store.mirror_lag("doc-e2e").unwrap(), Some(0));

    cleanup_dir(&dir);
}

#[test]
fn commit_ops_with_mirror_auto_export_clears_lag() {
    let (dir, db) = temp_db();
    let store = SharedWorkspaceStore::open(&db).unwrap();
    let mut session = DocSession::new("doc-m2").with_persistence(Box::new(store.clone()));

    let id = BlockId::new();
    let mirror = CommitMirrorOpts::new(dir.join("mirrors")).with_lag_threshold(1);
    let ops = [
        Op::Insert {
            id,
            parent: None,
            order: "a0".into(),
            kind: BlockKind::Paragraph,
            props: BlockProps::default(),
        },
        Op::TextEdit {
            id,
            start: 0,
            end: 0,
            insert: "auto mirror body".into(),
        },
    ];
    commit_ops_with_mirror(&mut session, &store, Origin::User, &ops, Some(&mirror)).unwrap();

    // 自动 export 后 lag 清零
    assert_eq!(store.mirror_lag("doc-m2").unwrap(), Some(0));
    let md = dir.join("mirrors").join("doc-m2.md");
    assert!(md.exists());
    let content = std::fs::read_to_string(&md).unwrap();
    assert!(content.contains("auto mirror body") || content.contains("<!--c:"));

    cleanup_dir(&dir);
}

#[test]
fn index_after_apply_reject_is_noop() {
    let (dir, db) = temp_db();
    let store = WorkspaceStore::open(&db).unwrap();
    let ev = DocEvent::Reject {
        intent_id: "i1".into(),
        reason: "test".into(),
    };
    index_after_apply(&store, &ev).unwrap();
    assert_eq!(store.count_blocks("any").unwrap(), 0);
    cleanup_dir(&dir);
}
