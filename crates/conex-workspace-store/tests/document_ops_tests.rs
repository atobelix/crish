use conex_workspace_store::WorkspaceStore;
use rusqlite::params;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

struct TempDb(PathBuf);
impl TempDb {
    fn new(tag: &str) -> Self {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "conex-doc-ops-{}-{}-{}-{}",
            tag,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            n
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn db_path(&self) -> PathBuf {
        self.0.join("workspace.db")
    }
}

impl Drop for TempDb {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn test_workspace_store_4_core_crud_methods() {
    let tmp = TempDb::new("core-crud");
    let store = WorkspaceStore::open(tmp.db_path()).unwrap();

    let now_ms = 1_700_000_000_000i64;

    // 1. create_note_document
    let row_a = store
        .create_note_document("doc_a", "笔记 A", now_ms)
        .unwrap();
    assert_eq!(row_a.doc_id, "doc_a");
    assert_eq!(row_a.title, "笔记 A");
    assert_eq!(row_a.rev, 1);
    assert_eq!(row_a.created_at, now_ms);
    assert_eq!(row_a.updated_at, now_ms);
    assert_eq!(row_a.block_count, 0);

    // 默认空标题回退测试
    let row_b = store
        .create_note_document("doc_b", "   ", now_ms + 1000)
        .unwrap();
    assert_eq!(row_b.title, "未命名笔记");
    assert_eq!(row_b.created_at, now_ms + 1000);

    // 2. list_note_documents (按 updated_at 倒序)
    let list = store.list_note_documents().unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].doc_id, "doc_b");
    assert_eq!(list[1].doc_id, "doc_a");

    // 3. rename_note_document
    let renamed = store
        .rename_note_document("doc_b", "新产品路线图", now_ms + 2000)
        .unwrap();
    assert_eq!(renamed.doc_id, "doc_b");
    assert_eq!(renamed.title, "新产品路线图");
    assert_eq!(renamed.updated_at, now_ms + 2000);
    assert_eq!(renamed.created_at, now_ms + 1000);

    // 重命名不存在的文档必须报错
    let err = store.rename_note_document("doc_non_existent", "Title", now_ms);
    assert!(err.is_err(), "重命名不存在的文档必须返回 Err");

    // 4. delete_note_document
    let affected = store.delete_note_document("doc_a").unwrap();
    assert_eq!(affected, 1, "删除存在文档应影响 1 行");

    let list_after = store.list_note_documents().unwrap();
    assert_eq!(list_after.len(), 1);
    assert_eq!(list_after[0].doc_id, "doc_b");

    // 再次删除已删文档影响 0 行
    let affected_again = store.delete_note_document("doc_a").unwrap();
    assert_eq!(affected_again, 0);
}

#[test]
fn test_delete_note_document_cascades_all_9_tables() {
    let tmp = TempDb::new("cascade-9-tables");
    let store = WorkspaceStore::open(tmp.db_path()).unwrap();

    let target_id = "doc_cascade_target";
    let other_id = "doc_cascade_other";

    // 向全部 9 张关联表插入测试数据
    {
        let conn = rusqlite::Connection::open(tmp.db_path()).unwrap();

        // 1. doc_meta
        conn.execute(
            "INSERT INTO doc_meta(doc_id, rev, updated_at, title, created_at) VALUES (?1, 1, 1000, 'T', 1000)",
            params![target_id],
        ).unwrap();
        conn.execute(
            "INSERT INTO doc_meta(doc_id, rev, updated_at, title, created_at) VALUES (?1, 1, 1000, 'O', 1000)",
            params![other_id],
        ).unwrap();

        // 2. doc_snapshots
        conn.execute(
            "INSERT INTO doc_snapshots(doc_id, blob, updated_at) VALUES (?1, X'0102', 1000)",
            params![target_id],
        ).unwrap();
        conn.execute(
            "INSERT INTO doc_snapshots(doc_id, blob, updated_at) VALUES (?1, X'0102', 1000)",
            params![other_id],
        ).unwrap();

        // 3. doc_updates
        conn.execute(
            "INSERT INTO doc_updates(doc_id, seq, blob) VALUES (?1, 1, X'0304')",
            params![target_id],
        ).unwrap();
        conn.execute(
            "INSERT INTO doc_updates(doc_id, seq, blob) VALUES (?1, 1, X'0304')",
            params![other_id],
        ).unwrap();

        // 4. doc_clocks
        conn.execute(
            "INSERT INTO doc_clocks(doc_id, peer_id, clock) VALUES (?1, 'peer1', 1)",
            params![target_id],
        ).unwrap();
        conn.execute(
            "INSERT INTO doc_clocks(doc_id, peer_id, clock) VALUES (?1, 'peer1', 1)",
            params![other_id],
        ).unwrap();

        // 5. mirror_meta
        conn.execute(
            "INSERT INTO mirror_meta(doc_id, path) VALUES (?1, 'path/target.md')",
            params![target_id],
        ).unwrap();
        conn.execute(
            "INSERT INTO mirror_meta(doc_id, path) VALUES (?1, 'path/other.md')",
            params![other_id],
        ).unwrap();

        // 6. blocks
        conn.execute(
            "INSERT INTO blocks(doc_id, block_id, plain_text) VALUES (?1, 'b_t1', 'text target')",
            params![target_id],
        ).unwrap();
        conn.execute(
            "INSERT INTO blocks(doc_id, block_id, plain_text) VALUES (?1, 'b_o1', 'text other')",
            params![other_id],
        ).unwrap();

        // 7. block_refs
        conn.execute(
            "INSERT INTO block_refs(doc_id, from_id, to_id, kind) VALUES (?1, 'b_t1', 'b_t2', 'ref')",
            params![target_id],
        ).unwrap();
        conn.execute(
            "INSERT INTO block_refs(doc_id, from_id, to_id, kind) VALUES (?1, 'b_o1', 'b_o2', 'ref')",
            params![other_id],
        ).unwrap();

        // 8. blob_cas + block_attachments
        conn.execute(
            "INSERT OR IGNORE INTO blob_cas(hash, size) VALUES ('hash1', 10)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO block_attachments(doc_id, block_id, hash) VALUES (?1, 'b_t1', 'hash1')",
            params![target_id],
        ).unwrap();
        conn.execute(
            "INSERT INTO block_attachments(doc_id, block_id, hash) VALUES (?1, 'b_o1', 'hash1')",
            params![other_id],
        ).unwrap();

        // 9. blocks_fts
        conn.execute(
            "INSERT INTO blocks_fts(plain_text, block_id, doc_id) VALUES ('text target', 'b_t1', ?1)",
            params![target_id],
        ).unwrap();
        conn.execute(
            "INSERT INTO blocks_fts(plain_text, block_id, doc_id) VALUES ('text other', 'b_o1', ?1)",
            params![other_id],
        ).unwrap();
    }

    // 执行 9 表事务级联硬删除
    let deleted_count = store.delete_note_document(target_id).unwrap();
    assert_eq!(deleted_count, 1);

    // 检验 9 张表中 target_id 记录全部物理清理净空 (count == 0)，而 other_id 仍完整保留 (count == 1)
    let conn = rusqlite::Connection::open(tmp.db_path()).unwrap();
    let tables = [
        "blocks_fts",
        "block_attachments",
        "block_refs",
        "blocks",
        "mirror_meta",
        "doc_clocks",
        "doc_updates",
        "doc_snapshots",
        "doc_meta",
    ];

    for table in tables {
        let count_target: i64 = conn
            .query_row(
                &format!("SELECT count(1) FROM {table} WHERE doc_id = ?1"),
                params![target_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            count_target, 0,
            "9 表级联删除后，表 {table} 中关于 {target_id} 的行必须全为 0"
        );

        let count_other: i64 = conn
            .query_row(
                &format!("SELECT count(1) FROM {table} WHERE doc_id = ?1"),
                params![other_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            count_other, 1,
            "表 {table} 中关于非目标文档 {other_id} 的行必须不受影响"
        );
    }
}

#[test]
fn test_timestamp_normalization_legacy_and_modern() {
    let tmp = TempDb::new("ts-norm");
    let store = WorkspaceStore::open(tmp.db_path()).unwrap();

    // 1. 手工向 doc_meta 注入 10 位标准秒级时间戳
    {
        let conn = rusqlite::Connection::open(tmp.db_path()).unwrap();
        conn.execute(
            "INSERT INTO doc_meta(doc_id, rev, updated_at, title, created_at) VALUES ('legacy_doc', 1, 1600000000, '老笔记', 1500000000)",
            [],
        ).unwrap();
    }

    // 2. list_note_documents 自动归一化为 13 位毫秒级时间戳 (* 1000)
    let list = store.list_note_documents().unwrap();
    let legacy = list.iter().find(|d| d.doc_id == "legacy_doc").unwrap();
    assert_eq!(legacy.updated_at, 1_600_000_000_000i64);
    assert_eq!(legacy.created_at, 1_500_000_000_000i64);

    // 3. create_note_document 传入 10 位秒级时间戳时也自动归一化
    let row_created = store
        .create_note_document("doc_sec", "秒级新建", 1_650_000_000)
        .unwrap();
    assert_eq!(row_created.updated_at, 1_650_000_000_000i64);
    assert_eq!(row_created.created_at, 1_650_000_000_000i64);

    // 4. rename_note_document 传入 10 位秒级时间戳时也自动归一化
    let row_renamed = store
        .rename_note_document("doc_sec", "秒级更名", 1_660_000_000)
        .unwrap();
    assert_eq!(row_renamed.updated_at, 1_660_000_000_000i64);
}

#[test]
fn test_workspace_store_document_lifecycle_crud() {
    let tmp = TempDb::new("doc-lifecycle");
    let store = WorkspaceStore::open(tmp.db_path()).unwrap();

    // 1. 创建文档 A（带初始标题与 Markdown 内容）
    let doc_a = store
        .create_document(Some("架构设计笔记"), Some("# 架构总览"))
        .unwrap();
    assert_eq!(doc_a.title, "架构设计笔记");
    assert_eq!(doc_a.block_count, 1);
    assert!(doc_a.created_at >= 1_000_000_000_000, "创建时间必须为 13 位毫秒");

    // 2. 创建文档 B（缺省参数）
    let doc_b = store.create_document(None, None).unwrap();
    assert_eq!(doc_b.title, "未命名笔记");
    assert_eq!(doc_b.block_count, 0);

    // 3. 列出文档（按更新倒序）
    let list = store.list_documents().unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].id, doc_b.id);
    assert_eq!(list[1].id, doc_a.id);

    // 4. 重命名文档 B
    let new_ts = store.rename_document(&doc_b.id, "产品规划会议纪要").unwrap();
    assert!(new_ts >= doc_b.updated_at);
    assert!(new_ts >= 1_000_000_000_000, "更新时间必须为 13 位毫秒");

    let list_after_rename = store.list_documents().unwrap();
    let renamed = list_after_rename.iter().find(|d| d.id == doc_b.id).unwrap();
    assert_eq!(renamed.title, "产品规划会议纪要");

    // 5. 彻底删除文档 A（事务级联清理，包含 blocks_fts）
    let deleted = store.delete_document(&doc_a.id).unwrap();
    assert!(deleted, "删除文档应返回 true");

    let list_after_delete = store.list_documents().unwrap();
    assert_eq!(list_after_delete.len(), 1, "删除后彻底从数据库移除");
    assert_eq!(list_after_delete[0].id, doc_b.id);
}
