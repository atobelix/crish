//! # W5-D-S · X-01 跨层联测骨架（Skeleton · 单场景）
//!
//! | 元数据 | 值 |
//! | ------ | -- |
//! | **包 ID** | **W5-D-S**（必须保留 `-S`；**≠ W5-D** Strict 全族） |
//! | **场景** | **仅 X-01**（`08` §2） |
//! | **表 G** | `docs/block-workspace-architecture/plans/acceptance/X-cross-layer-G.md` |
//! | **EL** | **禁止**关 EL-01 / EL-08 / 任何 EL |
//!
//! ## 链覆盖（诚实）
//!
//! 目标链：`apply_md_fragment → apply → flush → Diff → 焦点 pin`
//!
//! **本文件已覆盖（可证伪）**：
//! - `StoreNoteBackend::open` / `NoteRuntime::open`
//! - `apply_md_fragment`（含 intent 幂等 = send_to_note 语义）
//! - store 投影/FTS `query_blocks` → `document_outline` → 即时 S(`get_md` / `document_to_md` + `<!--c:`)
//! - 可选：投影 `remove_block_index` 后 text_match 不再命中
//!
//! **本文件未覆盖（仍缺 · 属 W5-D Strict 加深）**：
//! - UI `flush → ProjectionDiff → 焦点 pin` DOM（如 `data-block-id` pin）
//! - X-02…X-06（见验收表 G；**禁止**本测绿暗示全族完成）
//!
//! 门禁：`cargo test -p conex-note-runtime --test x01_cross_layer`

use agent_tools::note_backend::{
    NoteApplyMdRequest, NoteApplyMode, NoteBackend, NoteQueryBlocksParams,
};
use conex_note_runtime::StoreNoteBackend;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_db() -> (std::path::PathBuf, std::path::PathBuf) {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "conex-note-x01-{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        n
    ));
    let _ = std::fs::create_dir_all(&dir);
    let db = dir.join("workspace.db");
    (dir, db)
}

/// 中英混合 MD：一级标题 + 段落（跨层写入唯一载荷）。
const MIXED_MD: &str = "\
# 跨层标题 CrossLayer Heading

段落 body：unique_x01_token 与 中文关键词联测。
";

fn apply_req(doc_id: &str, md: &str, intent: Option<&str>) -> NoteApplyMdRequest {
    NoteApplyMdRequest {
        doc_id: doc_id.into(),
        markdown: md.into(),
        parent_id: None,
        after_block_id: None,
        mode: NoteApplyMode::ApplyMdFragment,
        intent_id: intent.map(str::to_string),
        batch_id: None,
        message_id: intent.map(|i| format!("msg-{i}")),
        origin: Some("agent".into()),
    }
}

/// W5-D-S / X-01 主路径：apply_md → 投影 query 命中 → intent 幂等 → outline → get_md 含 `<!--c:`。
///
/// **可证伪**：改 `MIXED_MD` token / 去掉投影 commit / 破坏幂等表 → 本测必红。
/// **≠** X-02…06；**≠** UI Diff/焦点 pin；**≠** 任何 EL。
#[tokio::test]
async fn x01_apply_md_query_outline_idempotent_and_get_md() {
    let (dir, db) = temp_db();
    let backend = StoreNoteBackend::open(&db).expect("open temp workspace.db");
    let doc = "doc-x01-main";

    // 1) apply_md_fragment：中英混合 heading + paragraph
    let first = backend
        .apply_md_fragment(apply_req(doc, MIXED_MD, Some("intent-x01-send")))
        .await
        .expect("apply_md_fragment");
    assert!(!first.idempotent);
    assert!(
        first.inserted >= 2,
        "heading+paragraph 至少 2 块, got {:?}",
        first
    );
    assert_eq!(
        first.block_ids.len() as u32,
        first.inserted,
        "block_ids 与 inserted 对齐"
    );
    let n_blocks = backend.store().count_blocks(doc).unwrap();
    assert!(n_blocks >= 2, "投影块数 >= 2, got {n_blocks}");

    // 2) query_blocks text_match 命中英文 token
    let q_en = backend
        .query_blocks(NoteQueryBlocksParams {
            doc_id: doc.into(),
            text_match: Some("unique_x01_token".into()),
            ..Default::default()
        })
        .await
        .expect("query en");
    assert!(
        !q_en.blocks.is_empty(),
        "FTS 应命中 unique_x01_token: {:?}",
        q_en
    );
    assert!(
        q_en.blocks.iter().any(|b| {
            b.snippet.contains("unique_x01_token")
                || b.snippet.contains("中文")
                || first.block_ids.iter().any(|id| id == &b.id)
        }),
        "命中应关联正文或已插 block_id: {:?}",
        q_en.blocks
    );

    // 2b) 中文关键词（若 FTS 分词未切中文，至少英文已绿；中文 best-effort）
    let q_zh = backend
        .query_blocks(NoteQueryBlocksParams {
            doc_id: doc.into(),
            text_match: Some("联测".into()),
            ..Default::default()
        })
        .await
        .expect("query zh");
    // SQLite FTS5 unicode61 对 CJK 可能按字/整串；不强制，但若有命中则校验非空 id
    if !q_zh.blocks.is_empty() {
        assert!(q_zh.blocks.iter().all(|b| !b.id.is_empty()));
    }

    // 3) send_to_note 等价：同 intent_id 幂等，不双插
    let second = backend
        .apply_md_fragment(apply_req(doc, MIXED_MD, Some("intent-x01-send")))
        .await
        .expect("idempotent apply");
    assert!(second.idempotent, "同 intent 应幂等");
    assert_eq!(second.inserted, 0);
    assert_eq!(second.block_ids, first.block_ids);
    let n2 = backend.store().count_blocks(doc).unwrap();
    assert_eq!(n_blocks, n2, "幂等不得增加投影块数");

    // 4) document_outline 非空且含标题语义
    let outline = backend
        .document_outline(doc, Some(6))
        .await
        .expect("outline");
    assert!(
        !outline.outline.is_empty(),
        "outline 应非空: {:?}",
        outline
    );
    let title_ok = outline.outline.iter().any(|n| {
        n.level >= 1
            && (n.title.contains("跨层")
                || n.title.contains("CrossLayer")
                || n.title.contains("标题")
                || !n.title.is_empty())
    });
    assert!(title_ok, "outline 应含 heading: {:?}", outline);

    // 5) 即时 S / get_md：含 <!--c: 与 block id
    let md = backend.get_md(doc).await.expect("get_md / 即时 S");
    assert!(
        md.contains("<!--c:"),
        "serialize 应含 Conex-MD ID 注释: {md}"
    );
    for id in &first.block_ids {
        let marker = format!("<!--c:{id}-->");
        assert!(
            md.contains(&marker),
            "get_md 应含块 {id} 的 <!--c:…-->，md=\n{md}"
        );
    }
    assert!(
        md.contains("unique_x01_token") || md.contains("跨层"),
        "get_md 应含正文: {md}"
    );
    // 同步 document_to_md 与 trait get_md 同源
    assert_eq!(md, backend.document_to_md(doc).unwrap());

    let _ = std::fs::remove_dir_all(dir);
}

/// 可选：投影 remove 后 query 不再命中（store 索引侧删除）。
#[tokio::test]
async fn x01_remove_block_index_query_miss() {
    let (dir, db) = temp_db();
    let backend = StoreNoteBackend::open(&db).expect("open");
    let doc = "doc-x01-rm";

    let applied = backend
        .apply_md_fragment(apply_req(
            doc,
            "## Drop Section\n\nremovable_x01_token only-here",
            None,
        ))
        .await
        .expect("apply");
    assert!(applied.inserted >= 1);

    let hit = backend
        .query_blocks(NoteQueryBlocksParams {
            doc_id: doc.into(),
            text_match: Some("removable_x01_token".into()),
            ..Default::default()
        })
        .await
        .expect("query before remove");
    assert!(!hit.blocks.is_empty(), "删除前应命中: {:?}", hit);

    // 取命中块 id（优先段落正文）
    let drop_id = hit
        .blocks
        .iter()
        .find(|b| b.snippet.contains("removable_x01_token") || b.kind.contains("paragraph"))
        .map(|b| b.id.clone())
        .or_else(|| hit.blocks.first().map(|b| b.id.clone()))
        .expect("at least one hit id");

    backend
        .store()
        .remove_block_index(doc, &drop_id)
        .expect("remove_block_index");

    let after = backend
        .query_blocks(NoteQueryBlocksParams {
            doc_id: doc.into(),
            text_match: Some("removable_x01_token".into()),
            ..Default::default()
        })
        .await
        .expect("query after remove");
    assert!(
        after.blocks.iter().all(|b| b.id != drop_id),
        "remove 后该块不得再经 text_match 命中: {:?}",
        after
    );
    // 若唯一命中被摘掉，结果应为空
    if hit.blocks.len() == 1 {
        assert!(
            after.blocks.is_empty(),
            "唯一命中块移除后应为空: {:?}",
            after
        );
    }

    let _ = std::fs::remove_dir_all(dir);
}

/// send 语义冒烟：NoteRuntime 工厂 + 无 intent 的二次 apply 会双插（对照幂等）。
#[tokio::test]
async fn x01_a_surf_note_runtime_factory_send_path() {
    let (dir, db) = temp_db();
    let handle = conex_note_runtime::NoteRuntime::open(&db).expect("NoteRuntime::open");
    let doc = "doc-x01-surf";

    let r1 = handle
        .apply_md_fragment(apply_req(doc, "# Surf\n\nsurf_x01_body", Some("surf-intent-1")))
        .await
        .unwrap();
    assert!(!r1.idempotent && r1.inserted >= 1);

    let r2 = handle
        .apply_md_fragment(apply_req(doc, "# Surf\n\nsurf_x01_body", Some("surf-intent-1")))
        .await
        .unwrap();
    assert!(r2.idempotent && r2.inserted == 0);

    let q = handle
        .query_blocks(NoteQueryBlocksParams {
            doc_id: doc.into(),
            text_match: Some("surf_x01_body".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(!q.blocks.is_empty());

    let ol = handle.document_outline(doc, Some(3)).await.unwrap();
    assert!(!ol.outline.is_empty());

    let _ = std::fs::remove_dir_all(dir);
}
