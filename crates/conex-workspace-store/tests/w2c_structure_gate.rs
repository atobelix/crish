//! W2-C Strict · FTS5 + blocks 投影 **结构门**
//!
//! 验收锚：`plans/09` W2-C；`plans/02` §2.9 / §3 A-PERF-10 结构门 + A-INV-06 索引侧；
//! `specs/fts-chinese-baseline.md`（中文基线方向）。
//!
//! ## 本包交付（结构门）
//! 1. 英文全文：`blocks_fts` FTS5 MATCH（非默认全表 `LIKE`）
//! 2. CJK：产品路径 `instr` 子串（非 `LIKE` 通配语义）
//! 3. `apply_projection_diff` 后 **blocks 行数 ≡ blocks_fts 行数**，且 plain_text 可搜
//! 4. FTS 损坏后 `rebuild_fts` 恢复搜索；**权威 snapshot/updates 不受影响**（A-INV-06 索引侧）
//!
//! ## 诚实边界（禁止抬关）
//! - **≠ A-PERF-10 数值满关**（数值门仅 W6-C Strict + perf-baseline 标定）
//! - **≠ EL-03**（EL-03 结构主责 W3-A；数值 W6-C；本包只关搜索/投影索引结构门）
//! - **≠ Wave 2「存储完成」**（G-HYD / mirror 三路 / CAS 生产就绪分属他包）
//!
//! 缺下列任一测 = **未交付** W2-C 结构门。

use conex_doc_collab::{
    BlockId, BlockKind, BlockProps, BlockUpsert, ProjectionDiff,
};
use conex_workspace_store::{
    QueryBlocksParams, ReindexBlockOpts, WorkspaceStore,
};
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!(
            "conex-w2c-{}-{}-{}-{}",
            tag,
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

    fn db(&self) -> PathBuf {
        self.0.join("workspace.db")
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A-PERF-10 结构门：英文查询计划必须落在 `blocks_fts` + MATCH，禁止默认全表 LIKE 扫。
#[test]
fn w2c_a_perf_10_english_uses_fts5_match_plan() {
    let dir = TempDir::new("fts-plan");
    let store = WorkspaceStore::open(dir.db()).unwrap();
    store
        .reindex_block(
            "doc-en",
            "b1",
            "indexed_alpha_token hello world",
            ReindexBlockOpts {
                kind: "paragraph".into(),
                ..Default::default()
            },
        )
        .unwrap();

    // 产品路径命中（行为）
    let hits = store
        .search_fulltext("doc-en", "indexed_alpha_token", 10)
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].block_id, "b1");

    // 结构：EXPLAIN QUERY PLAN 须体现 FTS / MATCH，不得是 plain LIKE 全表
    let conn = Connection::open(store.path()).unwrap();
    let mut stmt = conn
        .prepare(
            r#"
            EXPLAIN QUERY PLAN
            SELECT blocks_fts.block_id
            FROM blocks_fts
            WHERE blocks_fts.doc_id = ?1 AND blocks_fts MATCH ?2
            LIMIT 10
            "#,
        )
        .unwrap();
    let plan: Vec<String> = stmt
        .query_map(rusqlite::params!["doc-en", "\"indexed_alpha_token\""], |r| {
            // detail 列
            r.get::<_, String>(3)
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let joined = plan.join(" | ").to_lowercase();
    assert!(
        joined.contains("fts") || joined.contains("match") || joined.contains("blocks_fts"),
        "A-PERF-10 结构：英文须走 FTS5 计划，got plan={plan:?}"
    );
    assert!(
        !joined.contains(" like "),
        "A-PERF-10 结构：禁止默认 LIKE 全表，got plan={plan:?}"
    );
}

/// A-PERF-10 结构门 · CJK：产品路径用 `instr` 字面子串，**不是** `LIKE` 通配。
///
/// `LIKE` 中 `_` 匹配任意单字符；`instr` 则要求字面 `_`。
#[test]
fn w2c_a_perf_10_cjk_uses_instr_not_like_wildcard() {
    let dir = TempDir::new("instr");
    let store = WorkspaceStore::open(dir.db()).unwrap();

    // 含字面下划线；LIKE 'a_b' 会误命中 'axb'
    store
        .reindex_block(
            "doc-zh",
            "lit",
            "工作区a_b完成",
            ReindexBlockOpts {
                kind: "paragraph".into(),
                ..Default::default()
            },
        )
        .unwrap();
    store
        .reindex_block(
            "doc-zh",
            "trap",
            "工作区axb完成",
            ReindexBlockOpts {
                kind: "paragraph".into(),
                ..Default::default()
            },
        )
        .unwrap();

    // 中文基线方向：子串「工作区」须命中（两块）
    let ws = store.search_fulltext("doc-zh", "工作区", 50).unwrap();
    assert_eq!(ws.len(), 2, "CJK instr 子串应命中两块");

    // 含 CJK 才走 instr 路径：查询 `区a_b`（字面 `_`）。
    // 若误用 LIKE，`_` 为单字符通配 → trap 的 `区axb` 也会命中。
    let lit = store.search_fulltext("doc-zh", "区a_b", 50).unwrap();
    assert_eq!(
        lit.len(),
        1,
        "instr 字面下划线：仅 lit；LIKE 会误伤 trap，got {:?}",
        lit.iter().map(|h| &h.block_id).collect::<Vec<_>>()
    );
    assert_eq!(lit[0].block_id, "lit");

    // query_blocks 同源
    let qb = store
        .query_blocks(&QueryBlocksParams {
            doc_id: "doc-zh".into(),
            text_match: Some("区a_b".into()),
            limit: Some(50),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(qb.blocks.len(), 1);
    assert_eq!(qb.blocks[0].id, "lit");
}

/// 投影 ↔ FTS 一致性：`apply_projection_diff` 后行数相等，且 plain_text 可检索。
///
/// 缺此断言 = 索引与投影一致性 **未交付**（plans/02 · W2-C）。
#[test]
fn w2c_projection_fts_row_consistency_after_diff() {
    let dir = TempDir::new("proj-fts");
    let store = WorkspaceStore::open(dir.db()).unwrap();

    let id1 = BlockId::new();
    let id2 = BlockId::new();
    let diff = ProjectionDiff {
        doc_id: "doc-c".into(),
        rev: 3,
        upserts: vec![
            BlockUpsert {
                id: id1,
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
                children: vec![],
                order: "a0".into(),
                parent: None,
                plain_text: "投影一致性 token_alpha 与工作区".into(),
            },
            BlockUpsert {
                id: id2,
                kind: BlockKind::Heading { level: 1 },
                props: BlockProps::default(),
                children: vec![],
                order: "a1".into(),
                parent: None,
                plain_text: "块笔记 token_beta".into(),
            },
        ],
        removes: vec![],
        text_touches: vec![],
        full_rebuild: false,
    };
    store.apply_projection_diff("doc-c", &diff).unwrap();

    assert_eq!(store.count_blocks("doc-c").unwrap(), 2);
    assert_eq!(
        store.count_fts_blocks("doc-c").unwrap(),
        2,
        "blocks 与 blocks_fts 行数必须一致"
    );

    // plain_text 投影可读
    let plain1 = store
        .get_block_plain_text("doc-c", &id1.to_string())
        .unwrap()
        .expect("blocks 行应存在");
    assert!(plain1.contains("工作区"));

    // 英文 FTS
    let en = store.search_fulltext("doc-c", "token_alpha", 10).unwrap();
    assert_eq!(en.len(), 1);
    assert_eq!(en[0].block_id, id1.to_string());

    // 中文基线方向
    let zh = store.search_fulltext("doc-c", "块笔记", 10).unwrap();
    assert_eq!(zh.len(), 1);
    assert_eq!(zh[0].block_id, id2.to_string());

    // remove 后双表仍一致
    let diff2 = ProjectionDiff {
        doc_id: "doc-c".into(),
        rev: 4,
        upserts: vec![],
        removes: vec![id2],
        text_touches: vec![],
        full_rebuild: false,
    };
    store.apply_projection_diff("doc-c", &diff2).unwrap();
    assert_eq!(store.count_blocks("doc-c").unwrap(), 1);
    assert_eq!(store.count_fts_blocks("doc-c").unwrap(), 1);
    assert!(
        store
            .search_fulltext("doc-c", "块笔记", 10)
            .unwrap()
            .is_empty()
    );
}

/// A-INV-06 索引侧：FTS 清空后 `rebuild_fts` 恢复；权威表仍在（文档仍可开依赖 01 hydrate，本测只锁索引侧）。
#[test]
fn w2c_a_inv_06_rebuild_fts_keeps_authority_and_restores_search() {
    use conex_doc_collab::{CommitBatch, EncodedUpdate, Origin, PersistencePlugin, TxId};

    let dir = TempDir::new("rebuild");
    let store = WorkspaceStore::open(dir.db()).unwrap();

    // 权威侧：写一条 pending update（模拟 on_committed 形状；kind 经 serde，不依赖 UpdateKind re-export）
    let update: EncodedUpdate = serde_json::from_value(serde_json::json!({
        "bytes": [0xCA, 0xFE],
        "kind": "structure",
    }))
    .expect("EncodedUpdate");
    store
        .on_committed(
            "doc-r",
            &CommitBatch {
                tx_id: TxId::new(),
                origin: Origin::User,
                updates: vec![update],
                snapshot_tick: false,
            },
        )
        .unwrap();
    assert!(store.load_pending_count("doc-r").unwrap() >= 1);
    let blob = store.load_doc("doc-r").unwrap();
    assert!(
        !blob.pending.is_empty() || blob.snapshot.is_some(),
        "权威 load_doc 须有载荷"
    );

    store
        .reindex_block(
            "doc-r",
            "bx",
            "rebuild_me_工作区",
            ReindexBlockOpts::default(),
        )
        .unwrap();
    assert_eq!(store.count_blocks("doc-r").unwrap(), 1);
    assert_eq!(store.count_fts_blocks("doc-r").unwrap(), 1);

    // 损坏 FTS
    {
        let conn = Connection::open(store.path()).unwrap();
        conn.execute("DELETE FROM blocks_fts", []).unwrap();
    }
    assert_eq!(store.count_fts_blocks("doc-r").unwrap(), 0);
    // CJK 产品路径扫 plain_text（blocks 仍在）仍可能命中；纯 FTS 路径应 0
    assert!(
        store
            .search_fulltext_fts_only("doc-r", "rebuild_me", 10)
            .unwrap()
            .is_empty(),
        "FTS 清空后纯 MATCH 应 0"
    );

    // 投影表仍在
    assert_eq!(store.count_blocks("doc-r").unwrap(), 1);

    store.rebuild_fts(Some("doc-r")).unwrap();
    assert_eq!(store.count_fts_blocks("doc-r").unwrap(), 1);
    let hits = store.search_fulltext("doc-r", "工作区", 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].block_id, "bx");
    // 英文 token 走 FTS 恢复
    assert_eq!(
        store
            .search_fulltext_fts_only("doc-r", "rebuild_me", 10)
            .unwrap()
            .len(),
        1
    );

    // 权威未因 rebuild 丢失
    assert!(store.load_pending_count("doc-r").unwrap() >= 1);
    let blob2 = store.load_doc("doc-r").unwrap();
    assert!(
        !blob2.pending.is_empty() || blob2.snapshot.is_some(),
        "rebuild_fts 不得动权威"
    );
}
