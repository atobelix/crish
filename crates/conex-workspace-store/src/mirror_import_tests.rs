//! `mirror_import` 单元测（**SD-26** 外置；语义与拆前一致）。
//!
//! 由父模 [`crate::mirror_import`] 经 `#[path]` 接入。
//! **≠ EL-03** · **≠ inotify** · **≠** 默认双开；X-05 不回退。
//! `import_mirror_proposal` **只提案**，从不 apply。

use super::*;
use conex_doc_collab::{BlockId, BlockKind, BlockNode, BlockProps};
use std::collections::HashMap;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_dir() -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let p = std::env::temp_dir().join(format!(
        "conex-mirror-import-{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        n
    ));
    let _ = std::fs::create_dir_all(&p);
    p
}

fn sample_tree(text: &str) -> BlockTree {
    let id = BlockId::from_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap();
    let mut nodes = HashMap::new();
    nodes.insert(
        id,
        BlockNode {
            id,
            parent: None,
            order: "a0".into(),
            kind: BlockKind::Paragraph,
            props: BlockProps::default(),
            text_snapshot: Some(text.into()),
            children: vec![],
        },
    );
    BlockTree {
        root_children: vec![id],
        nodes,
    }
}

/// X-05：存在 unpushed 时，非 DropUnacked 不得静默覆盖。
#[test]
fn import_mirror_proposal_blocks_silent_overwrite_of_unpushed() {
    let dir = temp_dir();
    let db = dir.join("workspace.db");
    let mirror_root = dir.join("mirrors");
    let store = WorkspaceStore::open(&db).unwrap();
    let tree = sample_tree("mirror hello");

    store
        .export_md_mirror("doc-x", &tree, 1, &mirror_root)
        .unwrap();
    let path = mirror_root.join(format!("{}.md", crate::safe_doc_id("doc-x")));
    // 外部改 mirror
    let mut md = std::fs::read_to_string(&path).unwrap();
    md = md.replace("mirror hello", "external wins");
    std::fs::write(&path, md.as_bytes()).unwrap();

    // RetainLocal + unpushed>0 → 冲突，静默覆盖拦截
    let opts = ImportMirrorOpts::new(ThreeWayStrategy::RetainLocalAndReimport)
        .with_unpushed(3)
        .with_authority_tree(&tree);
    let res = store.import_mirror_proposal("doc-x", 1, &opts).unwrap();
    assert!(
        res.is_conflict(),
        "须冲突报告，got {:?}",
        std::mem::discriminant(&res)
    );
    assert!(
        res.silent_overwrite_blocked(),
        "X-05：silent_overwrite_blocked 必须为 true"
    );
    assert!(res.ops().is_none());

    // ConflictBlocks + unpushed → 同样拦截
    let opts2 = ImportMirrorOpts::new(ThreeWayStrategy::ConflictBlocks)
        .with_unpushed(1)
        .with_authority_tree(&tree);
    let res2 = store.import_mirror_proposal("doc-x", 1, &opts2).unwrap();
    assert!(res2.is_conflict());
    assert!(res2.silent_overwrite_blocked());

    // 显式 DropUnacked + unpushed → 允许产 Op 批（仍不 apply）
    let opts3 = ImportMirrorOpts::new(ThreeWayStrategy::DropUnacked)
        .with_unpushed(2)
        .with_authority_tree(&tree);
    let res3 = store.import_mirror_proposal("doc-x", 1, &opts3).unwrap();
    match res3 {
        ImportMirrorResult::OpBatch {
            discards_unpushed,
            is_block_level_diff,
            ops,
            ..
        } => {
            assert!(discards_unpushed);
            assert!(is_block_level_diff, "禁止默认 fullRemount 当唯一路径");
            // 至少应有针对同 ID 的 TextEdit，或 parse 后结构变化的 ops
            let _ = ops;
        }
        other => panic!("DropUnacked 应产 OpBatch，got {other:?}"),
    }

    // 权威库未因 import 提案被改写（无 apply）
    assert_eq!(store.load_rev("doc-x").unwrap(), 0);

    let _ = std::fs::remove_dir_all(&dir);
}

/// 无 unpushed 时 MirrorOnly 可产块级 TextEdit 提案。
#[test]
fn import_mirror_proposal_text_edit_without_unpushed() {
    let dir = temp_dir();
    let db = dir.join("workspace.db");
    let mirror_root = dir.join("mirrors");
    let store = WorkspaceStore::open(&db).unwrap();
    let tree = sample_tree("mirror hello");

    store
        .export_md_mirror("doc-t", &tree, 1, &mirror_root)
        .unwrap();
    let path = mirror_root.join(format!("{}.md", crate::safe_doc_id("doc-t")));
    let md = std::fs::read_to_string(&path)
        .unwrap()
        .replace("mirror hello", "edited");
    std::fs::write(&path, md.as_bytes()).unwrap();

    let opts = ImportMirrorOpts::new(ThreeWayStrategy::RetainLocalAndReimport)
        .with_authority_tree(&tree);
    let res = store.import_mirror_proposal("doc-t", 1, &opts).unwrap();
    match res {
        ImportMirrorResult::OpBatch {
            ops,
            preserves_unpushed,
            is_block_level_diff,
            ..
        } => {
            assert!(preserves_unpushed);
            assert!(is_block_level_diff);
            assert!(
                ops.iter().any(|op| matches!(op, Op::TextEdit { .. })),
                "期望 TextEdit 提案，ops={ops:?}"
            );
        }
        other => panic!("期望 OpBatch，got {other:?}"),
    }

    let _ = std::fs::remove_dir_all(&dir);
}
