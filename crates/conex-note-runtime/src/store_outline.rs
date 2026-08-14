//! Store 文档大纲（session 树 DFS / 投影表）（**SD-06** 纵向切开）
//!
//! 从 `store_backend` 巨石抽出：
//! - session 文档序 heading DFS → [`NoteOutline`]
//! - 无 session 时从投影 `query_blocks(kind=heading:N)` 建树
//!
//! # SD-06 边界
//! - **本模块职责**：大纲构建 + level 嵌套插入
//! - **不**含 plan / apply_md / hydrate 投影
//! - **≠ EL-05**

use agent_tools::note_backend::{NoteBackendError, NoteOutline, NoteOutlineNode};
use conex_doc_collab::{BlockId, BlockKind, DocSession};
use conex_workspace_store::QueryBlocksParams;

use crate::store_backend::{map_store_err, StoreNoteBackend};

impl StoreNoteBackend {
    /// 从已打开 session 树抽 heading 大纲（文档序 DFS）。
    pub(crate) fn build_outline_from_session(session: &DocSession, max_depth: u32) -> NoteOutline {
        let mut flat: Vec<(String, u32, String)> = Vec::new();
        let mut saw_deeper = false;
        // 文档序：DFS 根 children
        fn walk(
            session: &DocSession,
            ids: &[BlockId],
            max_depth: u32,
            flat: &mut Vec<(String, u32, String)>,
            saw_deeper: &mut bool,
        ) {
            for id in ids {
                let Some(n) = session.tree().get(id) else {
                    continue;
                };
                if let BlockKind::Heading { level } = &n.kind {
                    let lv = u32::from(*level);
                    if lv > max_depth {
                        *saw_deeper = true;
                    } else {
                        let title = n
                            .text_snapshot
                            .clone()
                            .unwrap_or_else(|| session.read_text(id));
                        flat.push((id.to_string(), lv, title));
                    }
                }
                if !n.children.is_empty() {
                    walk(session, &n.children, max_depth, flat, saw_deeper);
                }
            }
        }
        walk(
            session,
            &session.tree().root_children,
            max_depth,
            &mut flat,
            &mut saw_deeper,
        );

        let mut roots: Vec<NoteOutlineNode> = Vec::new();
        for (id, level, title) in flat {
            let node = NoteOutlineNode {
                id,
                level,
                title,
                children: vec![],
            };
            insert_outline_node(&mut roots, node);
        }
        NoteOutline {
            outline: roots,
            truncated: saw_deeper,
        }
    }

    /// 无 session 时从投影表抽 heading（kind = `heading:N`）。
    pub(crate) fn build_outline_from_store(
        &self,
        doc_id: &str,
        max_depth: u32,
    ) -> Result<NoteOutline, NoteBackendError> {
        let kinds: Vec<String> = (1..=max_depth.min(6))
            .map(|l| format!("heading:{l}"))
            .collect();
        let result = self
            .store
            .query_blocks(&QueryBlocksParams {
                doc_id: doc_id.to_string(),
                kind_in: Some(kinds),
                attrs_eq: None,
                text_match: None,
                ref_to: None,
                ref_from: None,
                limit: Some(200),
            })
            .map_err(map_store_err)?;

        let mut roots: Vec<NoteOutlineNode> = Vec::new();
        for hit in result.blocks {
            let level = hit
                .kind
                .strip_prefix("heading:")
                .and_then(|s| s.parse::<u32>().ok())
                .unwrap_or(1);
            let node = NoteOutlineNode {
                id: hit.id,
                level,
                title: hit.snippet,
                children: vec![],
            };
            insert_outline_node(&mut roots, node);
        }
        Ok(NoteOutline {
            outline: roots,
            truncated: result.truncated,
        })
    }
}

/// 将节点插入大纲树（按 level 嵌套；与 MemoryNoteBackend 同策略）。
fn insert_outline_node(roots: &mut Vec<NoteOutlineNode>, node: NoteOutlineNode) {
    if !try_insert_child(roots, &node) {
        roots.push(node);
    }
}

fn try_insert_child(nodes: &mut [NoteOutlineNode], node: &NoteOutlineNode) -> bool {
    for i in (0..nodes.len()).rev() {
        if nodes[i].level < node.level {
            if try_insert_child(&mut nodes[i].children, node) {
                return true;
            }
            nodes[i].children.push(node.clone());
            return true;
        }
    }
    false
}
