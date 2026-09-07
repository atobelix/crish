use conex_doc_collab::{
    ApplyError, BlockId, BlockKind, BlockProps, DocSession, HydrateBlob, Op, Origin,
    PersistencePlugin,
};
use conex_workspace_store::{commit_ops, CommitPipelineError, SharedWorkspaceStore, WorkspaceStore};
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
    assert_eq!(row_a.rev, 0);
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

    // 1. 创建文档 A（带初始标题；audit-repair-202609 T10：initial_markdown
    //    已砍除，带内容建文档唯一路径 = create 空文档 + apply_md）
    let doc_a = store.create_document(Some("架构设计笔记")).unwrap();
    assert_eq!(doc_a.title, "架构设计笔记");
    assert_eq!(doc_a.block_count, 0);
    assert_eq!(doc_a.rev, 0, "新建文档初始 rev 必须为 0");
    assert!(doc_a.created_at >= 1_000_000_000_000, "创建时间必须为 13 位毫秒");

    // 2. 创建文档 B（缺省参数）
    let doc_b = store.create_document(None).unwrap();
    assert_eq!(doc_b.title, "未命名笔记");
    assert_eq!(doc_b.block_count, 0);
    assert_eq!(doc_b.rev, 0, "新建文档初始 rev 必须为 0");

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

#[test]
fn test_created_note_document_first_edit_no_cas_conflict() {
    // 根治 DEF-NOTE-COLLAB-01 (DEF-NOTE-CAS-01)：
    // 验证新建文档初始 rev = 0，首笔编辑操作（expect_rev = Some(0)）100% 成功提交，
    // 不被 CAS 乐观锁版本冲突拦截。
    let tmp = TempDb::new("cas-regress");
    let store = SharedWorkspaceStore::open(tmp.db_path()).unwrap();

    // 1. 通过 create_document 创建新文档
    let doc_meta = store.create_document(Some("CAS回归测试便签")).unwrap();
    let doc_id = &doc_meta.id;

    // 断言初始返回元数据中 rev 必须为 0
    assert_eq!(doc_meta.rev, 0, "新建文档初始元数据 rev 必须为 0");
    assert_eq!(doc_meta.block_count, 0);

    // 断言 SQLite doc_meta 表中实际存储的 rev 必须为 0
    let db_rev_initial: i64 = store
        .load_rev(doc_id)
        .expect("读取数据库 doc_meta.rev");
    assert_eq!(db_rev_initial, 0, "新建文档在数据库中的初始 rev 必须为 0");

    // 2. 水合/加载会话（模拟前端/运行时打开该文档）
    let blob: HydrateBlob = store.load_doc(doc_id).expect("load_doc 必须成功");
    let mut session = DocSession::hydrate(doc_id, blob)
        .expect("hydrate 空文档会话必须成功")
        .with_persistence(Box::new(store.clone()));

    // 刚性断言：内存中空会话初始 rev 严格为 0
    assert_eq!(session.rev(), 0, "内存水合空会话 rev 初始值必须为 0");

    // 3. 执行首笔编辑操作（插入段落块并输入文字）
    let block_id_1 = BlockId::new();
    let first_edit_ops = [
        Op::Insert {
            id: block_id_1,
            parent: None,
            order: "a0".into(),
            kind: BlockKind::Paragraph,
            props: BlockProps::default(),
        },
        Op::TextEdit {
            id: block_id_1,
            start: 0,
            end: 0,
            insert: "便签首笔编辑文本 CAS-01-VERIFIED".into(),
        },
    ];

    // 在旧版本缺陷中，此处因 SQLite 中 rev=1 而会话 expect_rev=0，
    // 触发 affected == 0，抛出 PersistError::Conflict 导致提交失败回滚。
    // 修复后首笔提交必须 100% 成功！
    let commit_res = commit_ops(&mut session, &store, Origin::User, &first_edit_ops);
    assert!(
        commit_res.is_ok(),
        "新建文档首笔编辑必须成功提交，禁止发生 CAS 冲突: {:?}",
        commit_res.err()
    );

    // 4. 断言首笔提交后版本号与持久化状态
    assert_eq!(session.rev(), 1, "首笔提交后内存 session.rev 必须递增至 1");
    let db_rev_after_first = store.load_rev(doc_id).unwrap();
    assert_eq!(db_rev_after_first, 1, "首笔提交后数据库 doc_meta.rev 必须推进至 1");

    // 检验投影数据与全文检索（必须已物化入库）
    assert_eq!(store.count_blocks(doc_id).unwrap(), 1, "投影表 blocks 必须存在 1 块");
    let search_hits = store
        .search_fulltext(doc_id, "CAS-01-VERIFIED", 10)
        .unwrap();
    assert_eq!(search_hits.len(), 1, "全文索引 blocks_fts 必须检索到首笔写入内容");
    assert_eq!(search_hits[0].block_id, block_id_1.to_string());

    // 5. 执行第二笔编辑操作（expect_rev = Some(1)）
    let block_id_2 = BlockId::new();
    let second_edit_ops = [Op::Insert {
        id: block_id_2,
        parent: None,
        order: "a1".into(),
        kind: BlockKind::Heading { level: 2 },
        props: BlockProps::default(),
    }];

    let second_res = commit_ops(&mut session, &store, Origin::User, &second_edit_ops);
    assert!(second_res.is_ok(), "第二笔连续编辑必须平滑推进: {:?}", second_res.err());
    assert_eq!(session.rev(), 2, "第二笔提交后 session.rev 必须递增至 2");
    assert_eq!(store.load_rev(doc_id).unwrap(), 2, "第二笔提交后数据库 rev 必须推进至 2");
    assert_eq!(store.count_blocks(doc_id).unwrap(), 2, "投影表 blocks 必须累计至 2 块");

    // 6. 验证 CAS 保护机制未被削弱（陈旧会话期望 rev=0 必须被正确拦截）
    let stale_blob = HydrateBlob {
        snapshot: None,
        pending: vec![],
    };
    let mut stale_session = DocSession::hydrate(doc_id, stale_blob)
        .unwrap()
        .with_persistence(Box::new(store.clone()));
    assert_eq!(stale_session.rev(), 0, "陈旧会话持有旧版本 0");

    let stale_ops = [Op::Insert {
        id: BlockId::new(),
        parent: None,
        order: "z9".into(),
        kind: BlockKind::Paragraph,
        props: BlockProps::default(),
    }];
    let stale_err = commit_ops(&mut stale_session, &store, Origin::User, &stale_ops)
        .expect_err("持有 expect_rev=0 的陈旧会话向已推进至 rev=2 的文档写入必须被 CAS 拦截");
    assert!(
        matches!(stale_err, CommitPipelineError::Apply(ApplyError::PersistConflict { .. })
            | CommitPipelineError::Apply(ApplyError::Persist(_))),
        "陈旧写必须被 CAS Conflict 拦截并回滚: {stale_err:?}"
    );

    // 数据库权威未被陈旧会话污染
    assert_eq!(store.load_rev(doc_id).unwrap(), 2, "数据库版本不受陈旧写干扰");
    assert_eq!(store.count_blocks(doc_id).unwrap(), 2, "数据库块计数不受陈旧写干扰");

    // 7. 验证重开会话水合一致性
    let reload_blob = store.load_doc(doc_id).unwrap();
    let reload_session = DocSession::hydrate(doc_id, reload_blob).unwrap();
    assert_eq!(reload_session.rev(), 2, "重新加载的会话 rev 必须与权威库完全一致");
    assert!(reload_session.tree().get(&block_id_1).is_some());
    assert!(reload_session.tree().get(&block_id_2).is_some());
}

#[test]
fn test_create_note_document_direct_first_edit_no_cas_conflict() {
    // 验证底层 create_note_document 直接创建后首笔编辑同样无 CAS 冲突
    let tmp = TempDb::new("cas-direct");
    let store = SharedWorkspaceStore::open(tmp.db_path()).unwrap();
    let doc_id = "doc_direct_test";

    let row = store
        .create_note_document(doc_id, "直接创建文档", 1_700_000_000_000)
        .unwrap();
    assert_eq!(row.rev, 0, "create_note_document 返回的初始 rev 必须为 0");

    let blob: HydrateBlob = store.load_doc(doc_id).unwrap();
    let mut session = DocSession::hydrate(doc_id, blob)
        .unwrap()
        .with_persistence(Box::new(store.clone()));
    assert_eq!(session.rev(), 0, "水合初始 rev 必须为 0");

    let b_id = BlockId::new();
    let ops = [
        Op::Insert {
            id: b_id,
            parent: None,
            order: "a0".into(),
            kind: BlockKind::Paragraph,
            props: BlockProps::default(),
        },
        Op::TextEdit {
            id: b_id,
            start: 0,
            end: 0,
            insert: "直创文档首写成功".into(),
        },
    ];

    let res = commit_ops(&mut session, &store, Origin::User, &ops);
    assert!(res.is_ok(), "create_note_document 后首笔编辑必须成功: {:?}", res.err());
    assert_eq!(session.rev(), 1);
    assert_eq!(store.load_rev(doc_id).unwrap(), 1);
}
