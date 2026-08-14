//! Round7 · 中文 FTS 召回基准（A-FTS-ZH-01）
//!
//! - unicode61 对无空格连续汉字：整段成 token，子串 MATCH = known gap
//! - 产品路径 `search_fulltext` / `query_blocks`：含 CJK 时 `instr` 子串回退须命中
//! - 英文 FTS 路径不得被本改进破坏（见 crate 内既有 `reindex_two_blocks_search_hits`）

use conex_workspace_store::{QueryBlocksParams, ReindexBlockOpts, WorkspaceStore};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!(
            "conex-fts-zh-{}-{}-{}",
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

fn seed_chinese_notes(store: &WorkspaceStore) {
    // 无空格连续汉字段落（中文笔记典型形态）
    store
        .reindex_block(
            "doc-zh",
            "b-ws",
            "本段介绍工作区与投影索引的用法",
            ReindexBlockOpts {
                kind: "paragraph".into(),
                order_key: "a".into(),
                ..Default::default()
            },
        )
        .unwrap();
    store
        .reindex_block(
            "doc-zh",
            "b-bn",
            "块笔记是以块为粒度的本地优先笔记模型",
            ReindexBlockOpts {
                kind: "paragraph".into(),
                order_key: "b".into(),
                ..Default::default()
            },
        )
        .unwrap();
    store
        .reindex_block(
            "doc-zh",
            "b-en",
            "english only workspace token",
            ReindexBlockOpts {
                kind: "paragraph".into(),
                order_key: "c".into(),
                ..Default::default()
            },
        )
        .unwrap();
    // 另一文档：不得串 doc
    store
        .reindex_block(
            "doc-other",
            "ox",
            "工作区只在其他文档",
            ReindexBlockOpts::default(),
        )
        .unwrap();
}

/// A-FTS-ZH-01 · known gap：纯 unicode61 FTS MATCH 对汉字子串不命中。
#[test]
fn a_fts_zh_01_unicode61_known_gap_substring() {
    let dir = TempDir::new();
    let store = WorkspaceStore::open(dir.db()).unwrap();
    seed_chinese_notes(&store);

    // 全文恰为整段时，MATCH 整段短语可能命中；子串「工作区」则不应依赖 unicode61
    let fts_hits = store
        .search_fulltext_fts_only("doc-zh", "工作区", 50)
        .unwrap();
    assert!(
        fts_hits.is_empty(),
        "known gap：unicode61 将连续汉字整段成 token，子串 MATCH 应 0 命中，got {:?}",
        fts_hits.iter().map(|h| &h.block_id).collect::<Vec<_>>()
    );

    let fts_bn = store
        .search_fulltext_fts_only("doc-zh", "块笔记", 50)
        .unwrap();
    assert!(
        fts_bn.is_empty(),
        "known gap：块笔记 子串纯 FTS 应 0 命中，got {:?}",
        fts_bn.iter().map(|h| &h.block_id).collect::<Vec<_>>()
    );
}

/// A-FTS-ZH-01 · 产品路径：中文词「工作区」「块笔记」须 search 命中。
#[test]
fn a_fts_zh_01_search_fulltext_cjk_hits() {
    let dir = TempDir::new();
    let store = WorkspaceStore::open(dir.db()).unwrap();
    seed_chinese_notes(&store);

    let hits_ws = store.search_fulltext("doc-zh", "工作区", 50).unwrap();
    assert_eq!(hits_ws.len(), 1, "工作区 → b-ws，got {hits_ws:?}");
    assert_eq!(hits_ws[0].block_id, "b-ws");
    assert!(
        hits_ws[0].snippet.contains("工作区"),
        "snippet 应含原文片段: {}",
        hits_ws[0].snippet
    );

    let hits_bn = store.search_fulltext("doc-zh", "块笔记", 50).unwrap();
    assert_eq!(hits_bn.len(), 1, "块笔记 → b-bn");
    assert_eq!(hits_bn[0].block_id, "b-bn");

    // 单字 / 更短子串
    let hits_char = store.search_fulltext("doc-zh", "投影", 50).unwrap();
    assert_eq!(hits_char.len(), 1);
    assert_eq!(hits_char[0].block_id, "b-ws");

    // 不串 doc
    let cross = store.search_fulltext("doc-zh", "工作区", 50).unwrap();
    assert!(!cross.iter().any(|h| h.block_id == "ox"));
}

/// query_blocks text_match 与 search_fulltext 同源 CJK 策略。
#[test]
fn a_fts_zh_01_query_blocks_cjk_text_match() {
    let dir = TempDir::new();
    let store = WorkspaceStore::open(dir.db()).unwrap();
    seed_chinese_notes(&store);

    let r = store
        .query_blocks(&QueryBlocksParams {
            doc_id: "doc-zh".into(),
            text_match: Some("工作区".into()),
            limit: Some(50),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(r.blocks.len(), 1);
    assert_eq!(r.blocks[0].id, "b-ws");
    assert!(!r.truncated);

    let r2 = store
        .query_blocks(&QueryBlocksParams {
            doc_id: "doc-zh".into(),
            kind_in: Some(vec!["paragraph".into()]),
            text_match: Some("块笔记".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(r2.blocks.len(), 1);
    assert_eq!(r2.blocks[0].id, "b-bn");
}

/// 英文路径回归：无 CJK 时仍走 FTS，既有 token 命中。
#[test]
fn english_fts_path_unchanged_when_no_cjk() {
    let dir = TempDir::new();
    let store = WorkspaceStore::open(dir.db()).unwrap();
    seed_chinese_notes(&store);

    let hits = store.search_fulltext("doc-zh", "workspace", 50).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].block_id, "b-en");

    // fts_only 与 search_fulltext 对英文应一致
    let fts_only = store
        .search_fulltext_fts_only("doc-zh", "workspace", 50)
        .unwrap();
    assert_eq!(fts_only.len(), 1);
    assert_eq!(fts_only[0].block_id, "b-en");
}

/// 多词 CJK：空白分词 AND（两段均须出现）。
#[test]
fn cjk_multi_token_and() {
    let dir = TempDir::new();
    let store = WorkspaceStore::open(dir.db()).unwrap();
    store
        .reindex_block(
            "doc-m",
            "both",
            "工作区里写块笔记很方便",
            ReindexBlockOpts::default(),
        )
        .unwrap();
    store
        .reindex_block(
            "doc-m",
            "one",
            "只有工作区没有另一词",
            ReindexBlockOpts::default(),
        )
        .unwrap();

    let hits = store.search_fulltext("doc-m", "工作区 块笔记", 50).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].block_id, "both");
}

/// 索引侧：无空格中文段落可 reindex；remove 后不再命中。
#[test]
fn cjk_reindex_and_remove() {
    let dir = TempDir::new();
    let store = WorkspaceStore::open(dir.db()).unwrap();
    store
        .reindex_block("doc-rm", "x", "临时工作区内容", ReindexBlockOpts::default())
        .unwrap();
    assert_eq!(
        store.search_fulltext("doc-rm", "工作区", 10).unwrap().len(),
        1
    );
    store.remove_block_index("doc-rm", "x").unwrap();
    assert!(store
        .search_fulltext("doc-rm", "工作区", 10)
        .unwrap()
        .is_empty());
}
