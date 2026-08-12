//! `lib` 门面单元测（**SD-27** 外置；语义与拆前一致）。
//!
//! 由 crate 根经 `#[path]` 接入。**≠ EL-03**；**≠ Wave 2 存储完成**。

use super::*;
use conex_doc_collab::{BlockId, BlockKind, BlockNode, BlockProps, BlockTree};
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_db() -> (TempDir, PathBuf) {
    let dir = TempDir::new();
    let db = dir.path().join("workspace.db");
    (dir, db)
}

/// 极简 tempfile 目录，避免额外依赖。
struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!(
            "conex-ws-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            n
        ));
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn open_migrate_schema_version() {
    let (_dir, db) = temp_db();
    // 路径必须是独立 workspace.db，绝不碰 sessions
    assert!(db.ends_with("workspace.db"));
    let store = WorkspaceStore::open(&db).unwrap();
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
    // 二次 open 幂等
    let store2 = WorkspaceStore::open(&db).unwrap();
    assert_eq!(store2.schema_version().unwrap(), SCHEMA_VERSION);
    // 表存在：doc_clocks 可写
    store.upsert_clock("d1", "peer-a", 3).unwrap();
    assert_eq!(store.load_clock("d1", "peer-a").unwrap(), Some(3));
}

#[test]
fn separate_from_sessions_path() {
    // 验收：用 tempfile 路径，文件名 workspace.db，不触碰 sessions.db
    let (_dir, db) = temp_db();
    assert!(
        !db.to_string_lossy().contains("sessions"),
        "不得使用 sessions 库路径"
    );
    let store = WorkspaceStore::open(&db).unwrap();
    assert_eq!(store.path(), db.as_path());
}

fn sample_tree() -> BlockTree {
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
            text_snapshot: Some("mirror hello".into()),
            children: vec![],
        },
    );
    BlockTree {
        root_children: vec![id],
        nodes,
    }
}

#[test]
fn export_md_mirror_writes_conex_comments_and_lag_cycle() {
    let (dir, db) = temp_db();
    let store = WorkspaceStore::open(&db).unwrap();
    let mirror_root = dir.path().join("mirrors");
    let tree = sample_tree();

    // 尚未 export / advance → lag 不可观测
    assert_eq!(store.mirror_lag("doc-m").unwrap(), None);

    // 导出 rev=1：文件含 <!--c:，pending_lag=0
    let out = store
        .export_md_mirror("doc-m", &tree, 1, &mirror_root)
        .unwrap();
    assert!(out.ends_with("doc-m.md"));
    assert!(out.exists());
    let content = std::fs::read_to_string(&out).unwrap();
    assert!(
        content.contains("<!--c:"),
        "Conex-MD 必须含块 ID 注释，got:\n{content}"
    );
    assert!(content.contains("mirror hello"));
    assert_eq!(store.mirror_lag("doc-m").unwrap(), Some(0));

    // 权威前进 → lag > 0
    store.note_authority_advanced("doc-m", 5).unwrap();
    let lag = store.mirror_lag("doc-m").unwrap().unwrap();
    assert!(lag > 0, "advance 后 lag 应 > 0，got {lag}");
    assert_eq!(lag, 4); // |5 - 1|

    // 再 export 到最新 rev → lag 清零
    let out2 = store
        .export_md_mirror("doc-m", &tree, 5, &mirror_root)
        .unwrap();
    assert_eq!(out2, out);
    assert_eq!(store.mirror_lag("doc-m").unwrap(), Some(0));

    // 原子写可覆盖：二次内容仍可读
    let content2 = std::fs::read_to_string(&out2).unwrap();
    assert!(content2.contains("<!--c:"));
}

#[test]
fn safe_doc_id_sanitizes_path_chars() {
    assert_eq!(safe_doc_id("a/b\\c:d"), "a_b_c_d");
    assert_eq!(safe_doc_id("plain-id_1"), "plain-id_1");
}
