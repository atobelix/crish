//! 真 `DocSession::hydrate` / CDCS 树 → 打开投影形状（G-HYD-2 方向）。
//!
//! # 路径
//! ```ignore
//! store.load_doc(doc_id) → DocSession::hydrate(blob) → DFS 树投影
//! ```
//!
//! # 与 query 派生分轨（诚实）
//! | 路径 | `hydrate_path` 常量 | 权威 |
//! |------|---------------------|------|
//! | **本模块** | [`HYDRATE_PATH_DOC_SESSION`] | CDCS 结构 blob + 会话树 |
//! | query 派生 | [`HYDRATE_PATH_QUERY_BLOCKS`] | `blocks`/FTS 投影表（派生索引）|
//!
//! # 诚实未做 / 边界钉
//! - **≠ 产品「打开完成」**：仍依赖 G-HYD-1…5 全条件（`plans/00`/`09`）
//! - **≠ EL-04 / EL-01**；本路径可测 **不**关产品叙事
//! - **≠** 杀进程全链 e2e / W5-B 默认真 transport 产品关账
//! - 进程内已打开 session 时投影读热树；冷开路径经 `ensure_session` 走真 hydrate

use conex_doc_collab::{BlockId, BlockKind, DocSession};
use serde_json::{Map, Value as JsonValue};

/// 真 DocSession / CDCS 树投影路径标识（与 query 派生分轨）。
pub const HYDRATE_PATH_DOC_SESSION: &str = "doc-session";

/// 旧 query_blocks 映射投影路径标识（派生索引，非 hydrate 权威主路径）。
pub const HYDRATE_PATH_QUERY_BLOCKS: &str = "query-blocks";

/// 单块投影（对齐前端 hydrate IPC 块形状子集）。
#[derive(Debug, Clone, PartialEq)]
pub struct DocSessionHydrateBlock {
    pub id: String,
    pub flavour: String,
    pub index: usize,
    pub parent_id: Option<String>,
    pub props: Map<String, JsonValue>,
    pub text: String,
}

/// 文档级真 DocSession hydrate 投影。
///
/// `hydrate_path` 恒为 [`HYDRATE_PATH_DOC_SESSION`]——禁止标成 query 派生。
#[derive(Debug, Clone, PartialEq)]
pub struct DocSessionHydrateProjection {
    pub doc_id: String,
    /// 会话真 `rev`（非「有块=1」启发式）
    pub rev: u64,
    pub blocks: Vec<DocSessionHydrateBlock>,
    pub truncated: bool,
    /// 分轨字段：恒 `"doc-session"`
    pub hydrate_path: &'static str,
}

impl DocSessionHydrateProjection {
    /// 序列化为 note hydrate IPC 成功载荷子集（snake_case）。
    ///
    /// - `source`：调用方填 IPC 通道（如 `"tauri-ipc"`）
    /// - `hydrate_path`：本投影钉 `doc-session`（与 query 分轨）
    pub fn to_ipc_json(&self, source: &str) -> JsonValue {
        let blocks: Vec<JsonValue> = self
            .blocks
            .iter()
            .map(|b| {
                let mut obj = serde_json::Map::new();
                obj.insert("id".into(), JsonValue::String(b.id.clone()));
                obj.insert("flavour".into(), JsonValue::String(b.flavour.clone()));
                obj.insert("index".into(), JsonValue::Number(b.index.into()));
                if let Some(ref p) = b.parent_id {
                    obj.insert("parent_id".into(), JsonValue::String(p.clone()));
                }
                obj.insert("props".into(), JsonValue::Object(b.props.clone()));
                obj.insert("text".into(), JsonValue::String(b.text.clone()));
                JsonValue::Object(obj)
            })
            .collect();
        serde_json::json!({
            "ok": true,
            "doc_id": self.doc_id,
            "rev": self.rev,
            "blocks": blocks,
            "source": source,
            "hydrate_path": self.hydrate_path,
            "truncated": self.truncated,
        })
    }
}

/// 从**已 hydrate** 的 `DocSession` 做文档序 DFS 投影（纯函数，可库内测）。
///
/// - 不访问 store；不二次 hydrate
/// - `limit`：最大块条数（至少 1）
/// - 文本优先 `text_snapshot`，否则 `read_text`
pub fn project_session_tree(
    session: &DocSession,
    limit: usize,
) -> (Vec<DocSessionHydrateBlock>, bool) {
    let limit = limit.max(1);
    let mut out: Vec<DocSessionHydrateBlock> = Vec::new();
    let mut truncated = false;

    fn walk(
        session: &DocSession,
        ids: &[BlockId],
        limit: usize,
        out: &mut Vec<DocSessionHydrateBlock>,
        truncated: &mut bool,
    ) {
        for id in ids {
            if out.len() >= limit {
                *truncated = true;
                return;
            }
            let Some(node) = session.tree().get(id) else {
                continue;
            };
            let sibling_index = out.len();
            let text = node
                .text_snapshot
                .clone()
                .unwrap_or_else(|| session.read_text(id));
            let mut props = Map::new();
            for (k, v) in &node.props.attrs {
                props.insert(k.clone(), v.clone());
            }
            // order 可观测（调试 / 对齐）；非写权威
            props.insert("order".into(), JsonValue::String(node.order.clone()));
            out.push(DocSessionHydrateBlock {
                id: id.to_string(),
                flavour: kind_to_flavour(&node.kind),
                index: sibling_index,
                parent_id: node.parent.map(|p| p.to_string()),
                props,
                text,
            });
            if !node.children.is_empty() {
                walk(session, &node.children, limit, out, truncated);
                if *truncated {
                    return;
                }
            }
        }
    }

    walk(
        session,
        &session.tree().root_children,
        limit,
        &mut out,
        &mut truncated,
    );
    (out, truncated)
}

/// 从 session 组装完整投影（含 doc_id / rev / path）。
pub fn projection_from_session(
    session: &DocSession,
    doc_id: impl Into<String>,
    limit: usize,
) -> DocSessionHydrateProjection {
    let (blocks, truncated) = project_session_tree(session, limit);
    DocSessionHydrateProjection {
        doc_id: doc_id.into(),
        rev: session.rev(),
        blocks,
        truncated,
        hydrate_path: HYDRATE_PATH_DOC_SESSION,
    }
}

fn kind_to_flavour(kind: &BlockKind) -> String {
    match kind {
        BlockKind::Paragraph => "paragraph".into(),
        BlockKind::Heading { level } => format!("heading:{level}"),
        BlockKind::BulletItem => "bullet_item".into(),
        BlockKind::OrderedItem => "ordered_item".into(),
        BlockKind::TaskItem { ordered: false } => "task_item".into(),
        BlockKind::TaskItem { ordered: true } => "ordered_task_item".into(),
        BlockKind::Code => "code".into(),
        BlockKind::Quote => "quote".into(),
        BlockKind::Divider => "divider".into(),
        BlockKind::Table => "table".into(),
        BlockKind::Math => "math".into(),
        BlockKind::Callout { kind } => format!("callout:{kind}"),
        BlockKind::FootnoteDefinition => "footnote_definition".into(),
        BlockKind::Unknown { flavour } => flavour.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_doc_collab::{BlockProps, Op, Origin};

    fn insert_para(s: &mut DocSession, text: &str) -> BlockId {
        let id = BlockId::new();
        let order = format!("{:04}", s.tree().root_children.len());
        s.apply(
            Origin::User,
            &[
                Op::Insert {
                    id,
                    parent: None,
                    order,
                    kind: BlockKind::Paragraph,
                    props: BlockProps::default(),
                },
                Op::TextEdit {
                    id,
                    start: 0,
                    end: 0,
                    insert: text.into(),
                },
            ],
        )
        .expect("apply insert");
        id
    }

    #[test]
    fn project_empty_session_zero_blocks() {
        let s = DocSession::new("empty");
        let (blocks, truncated) = project_session_tree(&s, 50);
        assert!(blocks.is_empty());
        assert!(!truncated);
        let p = projection_from_session(&s, "empty", 50);
        assert_eq!(p.hydrate_path, HYDRATE_PATH_DOC_SESSION);
        assert_eq!(p.rev, 0);
        assert_eq!(p.blocks.len(), 0);
    }

    #[test]
    fn project_session_tree_reads_text_and_rev() {
        let mut s = DocSession::new("proj-1");
        insert_para(&mut s, "hello cdcs");
        let rev_after = s.rev();
        assert!(rev_after > 0, "apply 后 rev 须前进");

        let p = projection_from_session(&s, "proj-1", 200);
        assert_eq!(p.hydrate_path, HYDRATE_PATH_DOC_SESSION);
        assert_eq!(p.rev, rev_after);
        assert_eq!(p.blocks.len(), 1);
        assert_eq!(p.blocks[0].flavour, "paragraph");
        assert!(
            p.blocks[0].text.contains("hello"),
            "文本须可读: {:?}",
            p.blocks[0].text
        );
        assert!(p.blocks[0].parent_id.is_none());
        assert_eq!(p.blocks[0].index, 0);
    }

    #[test]
    fn project_respects_limit_truncated() {
        let mut s = DocSession::new("lim");
        for i in 0..5 {
            insert_para(&mut s, &format!("p{i}"));
        }
        let (blocks, truncated) = project_session_tree(&s, 2);
        assert_eq!(blocks.len(), 2);
        assert!(truncated);
    }

    #[test]
    fn ipc_json_carries_hydrate_path_doc_session() {
        let mut s = DocSession::new("j");
        insert_para(&mut s, "x");
        let p = projection_from_session(&s, "j", 10);
        let j = p.to_ipc_json("tauri-ipc");
        assert_eq!(j["ok"], true);
        assert_eq!(j["source"], "tauri-ipc");
        assert_eq!(j["hydrate_path"], HYDRATE_PATH_DOC_SESSION);
        assert_ne!(
            j["hydrate_path"], HYDRATE_PATH_QUERY_BLOCKS,
            "禁止与 query 路径混淆"
        );
        assert!(j["rev"].as_u64().unwrap_or(0) > 0);
    }
}
