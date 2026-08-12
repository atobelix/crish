//! `mirror_poll` 单元测（**SD-45** 外置；语义与拆前一致）。
//!
//! 由父模 [`crate::mirror_poll`] 经 `#[path]` 接入。
//! **≠ EL-03**；**≠ inotify 产品满关**；**≠** 默认双开 poll+OS；**≠** 占 SD-19。

use super::*;
use crate::mirror_detect::MirrorDriftClass;
use conex_doc_collab::{BlockId, BlockKind, BlockNode, BlockProps, BlockTree};
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_dir() -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let p = std::env::temp_dir().join(format!(
        "conex-mirror-poll-{}-{}-{}",
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

/// watcher 子集：改 mirror 文件 → `poll_mirror_once` 观察到 `MirrorOnly`。
///
/// **≠ OS inotify**；**≠ A-INV-02 产品 UI**；**≠ EL-03**。
#[test]
fn poll_mirror_once_observes_mirror_only_after_external_edit() {
    let dir = temp_dir();
    let db = dir.join("workspace.db");
    let mirror_root = dir.join("mirrors");
    let store = WorkspaceStore::open(&db).unwrap();
    let tree = sample_tree("mirror hello");

    store
        .export_md_mirror("doc-w", &tree, 1, &mirror_root)
        .unwrap();

    let mut handle = MirrorWatchHandle::new("doc-w");
    // 首次 poll：建基线，非 change event
    let r0 = handle.poll_mirror_once(&store, 1).unwrap();
    assert!(r0.first_poll);
    assert!(!r0.is_change_event());
    assert_eq!(r0.report.class, MirrorDriftClass::None);

    // 无状态便捷入口也应对齐 detect
    let free = poll_mirror_once(&store, "doc-w", 1).unwrap();
    assert_eq!(free.class, MirrorDriftClass::None);

    // 外部改盘
    let path = r0.report.path.clone();
    let mut content = std::fs::read_to_string(&path).unwrap();
    content.push_str("\n\nexternal via poll\n");
    std::fs::write(&path, content.as_bytes()).unwrap();

    let r1 = handle.poll_mirror_once(&store, 1).unwrap();
    assert!(!r1.first_poll);
    assert!(r1.fingerprint_changed, "mtime/hash 应变");
    assert!(r1.is_change_event());
    assert_eq!(
        r1.report.class,
        MirrorDriftClass::MirrorOnly,
        "外部改 mirror 须 MirrorOnly，got {:?}",
        r1.report.class
    );
    assert!(r1.report.mirror_changed);
    assert!(!r1.report.authority_changed);

    // poll_if_changed：无再改时应 None
    let r2 = handle.poll_if_changed(&store, 1).unwrap();
    assert!(r2.is_none(), "指纹未变不应再报 change");

    let _ = std::fs::remove_dir_all(&dir);
}

/// watcher 子集：`on_mirror_change` 回调在外部改盘后拿到 `MirrorOnly`。
///
/// **≠ OS inotify**；**≠ A-INV-02 产品 UI**；**≠ EL-03**。
#[test]
fn on_mirror_change_callback_receives_mirror_only() {
    use std::sync::{Arc, Mutex};

    let dir = temp_dir();
    let db = dir.join("workspace.db");
    let mirror_root = dir.join("mirrors");
    let store = WorkspaceStore::open(&db).unwrap();
    let tree = sample_tree("mirror hello");

    store
        .export_md_mirror("doc-cb", &tree, 1, &mirror_root)
        .unwrap();

    let events: Arc<Mutex<Vec<MirrorDriftClass>>> = Arc::new(Mutex::new(Vec::new()));
    let events_cb = Arc::clone(&events);

    let mut watcher = MirrorWatcher::new("doc-cb");
    watcher.on_mirror_change(move |ev| {
        events_cb.lock().unwrap().push(ev.report.class);
    });

    // 建基线：不应触发回调
    let r0 = watcher.poll_once(&store, 1).unwrap();
    assert!(r0.first_poll);
    assert!(events.lock().unwrap().is_empty(), "首次基线不回调");

    // 外部改盘
    let path = r0.report.path.clone();
    let md = std::fs::read_to_string(&path)
        .unwrap()
        .replace("mirror hello", "callback sees me");
    std::fs::write(&path, md.as_bytes()).unwrap();

    let r1 = watcher.poll_once(&store, 1).unwrap();
    assert!(r1.is_change_event());
    assert_eq!(r1.report.class, MirrorDriftClass::MirrorOnly);

    let fired = events.lock().unwrap().clone();
    assert_eq!(
        fired,
        vec![MirrorDriftClass::MirrorOnly],
        "回调须收到 MirrorOnly，got {fired:?}"
    );

    // 再 poll 无变更：不重复回调
    let r2 = watcher.poll_once(&store, 1).unwrap();
    assert!(!r2.is_change_event());
    assert_eq!(events.lock().unwrap().len(), 1);

    let _ = std::fs::remove_dir_all(&dir);
}
