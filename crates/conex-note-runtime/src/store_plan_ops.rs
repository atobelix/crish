//! Store 块级 ops → collab [`Op`] 规划（**SD-06** 纵向切开 · plan→collab）
//!
//! 从 `store_backend` 巨石抽出 W4-F 规划引擎：将工具层 [`NoteBlockOp`]
//! 规划为 collab 原子 Op 批（不修改 session；失败整批不返回 ops）。
//!
//! # SD-06 边界
//! - **本模块职责**：`plan_block_ops_to_collab` + kind/id 解析 + 规划期元数据
//! - **不**含 session open / hydrate / apply_md / outline / trait 门面
//! - **≠ EL-05**；**≠ A-AGT 满表**；**≠ W6-E**；不宣称 Store 生产关账
//!
//! # 与 Memory plan 的关系（SD-07 未做）
//! Memory：`agent_tools::note_plan_ops::plan_block_ops`（扁平列表）
//! Store：本模块（collab 树）。双引擎语义对齐归 **SD-07**，本包仅结构切开。

use agent_tools::note_backend::{
    NoteBackendError, NoteBlockOp, NoteBlockOpKind, NoteBlockOpPreview,
};
use conex_doc_collab::{BlockId, BlockKind, BlockProps, BlockTree, DocSession, Op};
use std::collections::HashMap;
use std::str::FromStr;

// ── 规划期类型 ──────────────────────────────────────────────────────

/// 规划期节点元数据（Store block ops）
pub(crate) struct PlanNodeMeta {
    pub(crate) parent: Option<BlockId>,
    pub(crate) order: String,
    pub(crate) kind: BlockKind,
    pub(crate) text_len: u32,
    #[allow(dead_code)]
    pub(crate) text: String,
}

/// Store `apply_block_ops` 规划结果
#[derive(Debug)]
pub(crate) struct StoreBlockOpPlan {
    pub(crate) collab_ops: Vec<Op>,
    pub(crate) previews: Vec<NoteBlockOpPreview>,
    pub(crate) block_ids: Vec<String>,
}

// ── 解析 / 标签 ─────────────────────────────────────────────────────

/// 解析块 UUID。
pub(crate) fn parse_block_id(s: &str, label: &str) -> Result<BlockId, NoteBackendError> {
    BlockId::from_str(s.trim()).map_err(|_| {
        NoteBackendError::Invalid(format!("{label} is not a valid block UUID: {s}"))
    })
}

/// 工具 kind 字符串 → collab [`BlockKind`]。
pub(crate) fn parse_block_kind(kind: &str) -> BlockKind {
    let k = kind.trim();
    if k.is_empty() || k == "paragraph" {
        return BlockKind::Paragraph;
    }
    if let Some(rest) = k.strip_prefix("heading:") {
        let level = rest.parse::<u8>().unwrap_or(1).clamp(1, 6);
        return BlockKind::Heading { level };
    }
    match k {
        "heading" => BlockKind::Heading { level: 1 },
        "bullet" | "bullet_item" | "list_item" => BlockKind::BulletItem,
        "ordered" | "ordered_item" => BlockKind::OrderedItem,
        "code" | "code_block" => BlockKind::Code,
        "quote" | "blockquote" => BlockKind::Quote,
        "divider" | "hr" => BlockKind::Divider,
        other => BlockKind::Unknown {
            flavour: other.to_string(),
        },
    }
}

/// collab kind → 工具层 label。
pub(crate) fn kind_label(kind: &BlockKind) -> String {
    match kind {
        BlockKind::Paragraph => "paragraph".into(),
        BlockKind::Heading { level } => format!("heading:{level}"),
        BlockKind::BulletItem => "bullet_item".into(),
        BlockKind::OrderedItem => "ordered_item".into(),
        BlockKind::Code => "code".into(),
        BlockKind::Quote => "quote".into(),
        BlockKind::Divider => "divider".into(),
        BlockKind::Unknown { flavour } => flavour.clone(),
    }
}

/// 父下兄弟 order 序号起点（对齐 md-ast sibling_base_seq）。
pub(crate) fn sibling_base_seq(tree: &BlockTree, parent: Option<BlockId>) -> u32 {
    match parent {
        Some(pid) => tree
            .get(&pid)
            .map(|n| n.children.len() as u32)
            .unwrap_or(0),
        None => tree.root_children.len() as u32,
    }
}

// ── 规划主函数 ──────────────────────────────────────────────────────

/// 将工具层 [`NoteBlockOp`] 规划为 collab [`Op`] 批（不修改 session）。
///
/// 批内可引用本批新 insert 的 id；失败整批不返回 ops（调用方不 commit）。
///
/// # 错误
/// - [`NoteBackendError::IdConflict`]：insert 预分配 id 已存在
/// - [`NoteBackendError::NotFound`]：previous / parent / 目标块缺失
/// - [`NoteBackendError::Invalid`]：缺必填字段 / 非法 UUID
pub(crate) fn plan_block_ops_to_collab(
    session: &DocSession,
    ops: &[NoteBlockOp],
) -> Result<StoreBlockOpPlan, NoteBackendError> {
    let tree = session.tree();
    // 规划期工作态：id 存在性 + 临时文本长度（TextEdit 全量替换用）
    let mut known: HashMap<BlockId, PlanNodeMeta> = tree
        .nodes
        .iter()
        .map(|(id, n)| {
            let text = session.read_text(id);
            (
                *id,
                PlanNodeMeta {
                    parent: n.parent,
                    order: n.order.clone(),
                    kind: n.kind.clone(),
                    text_len: text.chars().count() as u32,
                    text,
                },
            )
        })
        .collect();
    // 父 → 子 order 列表（仅规划期；insert 后追加）
    let mut children_of: HashMap<Option<BlockId>, Vec<(BlockId, String)>> = HashMap::new();
    for (id, meta) in &known {
        children_of
            .entry(meta.parent)
            .or_default()
            .push((*id, meta.order.clone()));
    }

    let mut collab_ops: Vec<Op> = Vec::new();
    let mut previews: Vec<NoteBlockOpPreview> = Vec::new();
    let mut block_ids: Vec<String> = Vec::new();
    // 同批 append order 去重计数
    let mut order_seq_by_parent: HashMap<Option<BlockId>, u32> = HashMap::new();

    for op in ops {
        match op.op {
            NoteBlockOpKind::Insert => {
                let content = op.content.clone().unwrap_or_default();
                let kind_s = op
                    .kind
                    .clone()
                    .unwrap_or_else(|| "paragraph".to_string());
                let kind = parse_block_kind(&kind_s);
                let kind_label = kind_label(&kind);

                let id = match &op.id {
                    Some(s) if !s.trim().is_empty() => {
                        let bid = parse_block_id(s, "id")?;
                        if known.contains_key(&bid) {
                            return Err(NoteBackendError::IdConflict(format!(
                                "block id already exists: {bid}"
                            )));
                        }
                        bid
                    }
                    _ => BlockId::new(),
                };

                let previous = match &op.previous_id {
                    Some(s) if !s.trim().is_empty() => {
                        Some(parse_block_id(s, "previous_id")?)
                    }
                    _ => None,
                };
                let explicit_parent = match &op.parent_id {
                    Some(s) if !s.trim().is_empty() => {
                        Some(parse_block_id(s, "parent_id")?)
                    }
                    _ => None,
                };

                let parent = if let Some(pid) = explicit_parent {
                    if !known.contains_key(&pid) {
                        return Err(NoteBackendError::NotFound(format!(
                            "parent_id not found: {pid}"
                        )));
                    }
                    Some(pid)
                } else if let Some(prev) = previous {
                    let meta = known.get(&prev).ok_or_else(|| {
                        NoteBackendError::NotFound(format!("previous_id not found: {prev}"))
                    })?;
                    meta.parent
                } else {
                    None
                };

                if let Some(prev) = previous {
                    if !known.contains_key(&prev) {
                        return Err(NoteBackendError::NotFound(format!(
                            "previous_id not found: {prev}"
                        )));
                    }
                }

                let order = if let Some(prev) = previous {
                    let prev_order = known
                        .get(&prev)
                        .map(|m| m.order.clone())
                        .unwrap_or_else(|| "a0".into());
                    let seq = order_seq_by_parent.entry(parent).or_insert(0);
                    let o = format!("{prev_order}~{seq:04}");
                    *seq += 1;
                    o
                } else {
                    let base = sibling_base_seq(tree, parent)
                        + children_of
                            .get(&parent)
                            .map(|v| {
                                // 仅计本批追加到该父的（tree 内已有由 base 覆盖）
                                v.iter()
                                    .filter(|(cid, _)| {
                                        // 已在原 tree 的不计二次
                                        !tree.nodes.contains_key(cid)
                                    })
                                    .count() as u32
                            })
                            .unwrap_or(0);
                    let seq = order_seq_by_parent.entry(parent).or_insert(0);
                    let o = format!("a{:04}", base + *seq);
                    *seq += 1;
                    o
                };

                let mut props = BlockProps::default();
                if let Some(ref attrs) = op.attrs {
                    props.attrs = attrs.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
                }

                collab_ops.push(Op::Insert {
                    id,
                    parent,
                    order: order.clone(),
                    kind: kind.clone(),
                    props,
                });
                if !content.is_empty() {
                    collab_ops.push(Op::TextEdit {
                        id,
                        start: 0,
                        end: 0,
                        insert: content.clone(),
                    });
                }

                known.insert(
                    id,
                    PlanNodeMeta {
                        parent,
                        order: order.clone(),
                        kind: kind.clone(),
                        text_len: content.chars().count() as u32,
                        text: content.clone(),
                    },
                );
                children_of
                    .entry(parent)
                    .or_default()
                    .push((id, order));

                let summary = Some(content.chars().take(80).collect::<String>());
                previews.push(NoteBlockOpPreview {
                    op: "insert".into(),
                    id: Some(id.to_string()),
                    kind: Some(kind_label),
                    summary,
                });
                block_ids.push(id.to_string());
            }
            NoteBlockOpKind::Update => {
                let id_s = op
                    .id
                    .clone()
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| {
                        NoteBackendError::Invalid("update requires non-empty id".into())
                    })?;
                let id = parse_block_id(&id_s, "id")?;
                let meta = known.get(&id).ok_or_else(|| {
                    NoteBackendError::NotFound(format!("block not found: {id}"))
                })?;
                let content = op.content.clone().ok_or_else(|| {
                    NoteBackendError::Invalid("update requires content".into())
                })?;
                let end = meta.text_len;
                let kind_label = kind_label(&meta.kind);
                collab_ops.push(Op::TextEdit {
                    id,
                    start: 0,
                    end,
                    insert: content.clone(),
                });
                if let Some(ref attrs) = op.attrs {
                    let mut props = BlockProps::default();
                    props.attrs =
                        attrs.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
                    collab_ops.push(Op::UpdateProps { id, props });
                }
                if let Some(m) = known.get_mut(&id) {
                    m.text_len = content.chars().count() as u32;
                    m.text = content.clone();
                }
                previews.push(NoteBlockOpPreview {
                    op: "update".into(),
                    id: Some(id.to_string()),
                    kind: Some(kind_label),
                    summary: Some(content.chars().take(80).collect()),
                });
                block_ids.push(id.to_string());
            }
            NoteBlockOpKind::Delete => {
                let id_s = op
                    .id
                    .clone()
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| {
                        NoteBackendError::Invalid("delete requires non-empty id".into())
                    })?;
                let id = parse_block_id(&id_s, "id")?;
                let meta = known.get(&id).ok_or_else(|| {
                    NoteBackendError::NotFound(format!("block not found: {id}"))
                })?;
                let kind_label = kind_label(&meta.kind);
                let parent = meta.parent;
                collab_ops.push(Op::Delete { id });
                known.remove(&id);
                if let Some(list) = children_of.get_mut(&parent) {
                    list.retain(|(cid, _)| *cid != id);
                }
                previews.push(NoteBlockOpPreview {
                    op: "delete".into(),
                    id: Some(id.to_string()),
                    kind: Some(kind_label),
                    summary: None,
                });
                block_ids.push(id.to_string());
            }
            NoteBlockOpKind::Move => {
                let id_s = op
                    .id
                    .clone()
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| {
                        NoteBackendError::Invalid("move requires non-empty id".into())
                    })?;
                let id = parse_block_id(&id_s, "id")?;
                let meta = known.get(&id).ok_or_else(|| {
                    NoteBackendError::NotFound(format!("block not found: {id}"))
                })?;
                let kind_label = kind_label(&meta.kind);
                let old_parent = meta.parent;

                let new_parent = match &op.parent_id {
                    Some(s) if !s.trim().is_empty() => {
                        let pid = parse_block_id(s, "parent_id")?;
                        if !known.contains_key(&pid) {
                            return Err(NoteBackendError::NotFound(format!(
                                "parent_id not found: {pid}"
                            )));
                        }
                        Some(pid)
                    }
                    _ => old_parent,
                };

                let previous = match &op.previous_id {
                    Some(s) if !s.trim().is_empty() => {
                        let prev = parse_block_id(s, "previous_id")?;
                        if !known.contains_key(&prev) {
                            return Err(NoteBackendError::NotFound(format!(
                                "previous_id not found: {prev}"
                            )));
                        }
                        Some(prev)
                    }
                    _ => None,
                };

                let order = if let Some(prev) = previous {
                    let prev_order = known
                        .get(&prev)
                        .map(|m| m.order.clone())
                        .unwrap_or_else(|| "a0".into());
                    format!("{prev_order}~m")
                } else {
                    let base = children_of
                        .get(&new_parent)
                        .map(|v| v.len() as u32)
                        .unwrap_or(0);
                    format!("a{base:04}")
                };

                collab_ops.push(Op::Move {
                    id,
                    new_parent,
                    order: order.clone(),
                });
                if let Some(m) = known.get_mut(&id) {
                    m.parent = new_parent;
                    m.order = order.clone();
                }
                if let Some(list) = children_of.get_mut(&old_parent) {
                    list.retain(|(cid, _)| *cid != id);
                }
                children_of
                    .entry(new_parent)
                    .or_default()
                    .push((id, order));

                previews.push(NoteBlockOpPreview {
                    op: "move".into(),
                    id: Some(id.to_string()),
                    kind: Some(kind_label),
                    summary: None,
                });
                block_ids.push(id.to_string());
            }
            NoteBlockOpKind::SetAttr => {
                let id_s = op
                    .id
                    .clone()
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| {
                        NoteBackendError::Invalid("set_attr requires non-empty id".into())
                    })?;
                let id = parse_block_id(&id_s, "id")?;
                let meta = known.get(&id).ok_or_else(|| {
                    NoteBackendError::NotFound(format!("block not found: {id}"))
                })?;
                let kind_label = kind_label(&meta.kind);
                let attrs = op.attrs.clone().unwrap_or_default();
                let mut props = BlockProps::default();
                props.attrs = attrs.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
                collab_ops.push(Op::UpdateProps { id, props });
                previews.push(NoteBlockOpPreview {
                    op: "set_attr".into(),
                    id: Some(id.to_string()),
                    kind: Some(kind_label),
                    summary: Some(format!("{} attrs", attrs.len())),
                });
                block_ids.push(id.to_string());
            }
        }
    }

    Ok(StoreBlockOpPlan {
        collab_ops,
        previews,
        block_ids,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_tools::note_backend::NoteBlockOpKind;
    use conex_doc_collab::{DocSession, HydrateBlob, Origin};

    fn empty_session(doc_id: &str) -> DocSession {
        DocSession::hydrate(doc_id.to_string(), HydrateBlob::default()).expect("empty hydrate")
    }

    /// insert 预分配已存在 id → IdConflict（规划期，零写）。
    #[test]
    fn plan_block_ops_id_conflict() {
        let fixed = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let mut session = empty_session("plan-idc2");
        let id = BlockId::from_str(fixed).unwrap();
        session
            .apply(
                Origin::User,
                &[Op::Insert {
                    id,
                    parent: None,
                    order: "a0000".into(),
                    kind: BlockKind::Paragraph,
                    props: BlockProps::default(),
                }],
            )
            .expect("seed insert");
        let ops2 = vec![NoteBlockOp {
            op: NoteBlockOpKind::Insert,
            id: Some(fixed.into()),
            parent_id: None,
            previous_id: None,
            content: Some("dup".into()),
            kind: Some("paragraph".into()),
            attrs: None,
        }];
        let err = plan_block_ops_to_collab(&session, &ops2).unwrap_err();
        assert!(
            matches!(err, NoteBackendError::IdConflict(_)),
            "expect IdConflict, got {err:?}"
        );
    }

    /// previous_id / 目标块不存在 → NotFound。
    #[test]
    fn plan_block_ops_previous_not_found() {
        let session = empty_session("plan-nf");
        let missing = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        let ops = vec![NoteBlockOp {
            op: NoteBlockOpKind::Insert,
            id: None,
            parent_id: None,
            previous_id: Some(missing.into()),
            content: Some("after missing".into()),
            kind: Some("paragraph".into()),
            attrs: None,
        }];
        let err = plan_block_ops_to_collab(&session, &ops).unwrap_err();
        assert!(
            matches!(err, NoteBackendError::NotFound(_)),
            "expect NotFound, got {err:?}"
        );
    }

    /// update 缺 id → Invalid；delete 目标不存在 → NotFound。
    #[test]
    fn plan_block_ops_update_invalid_delete_not_found() {
        let session = empty_session("plan-inv");
        let missing = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        let err_upd = plan_block_ops_to_collab(
            &session,
            &[NoteBlockOp {
                op: NoteBlockOpKind::Update,
                id: None,
                parent_id: None,
                previous_id: None,
                content: Some("x".into()),
                kind: None,
                attrs: None,
            }],
        )
        .unwrap_err();
        assert!(matches!(err_upd, NoteBackendError::Invalid(_)));

        let err_del = plan_block_ops_to_collab(
            &session,
            &[NoteBlockOp {
                op: NoteBlockOpKind::Delete,
                id: Some(missing.into()),
                parent_id: None,
                previous_id: None,
                content: None,
                kind: None,
                attrs: None,
            }],
        )
        .unwrap_err();
        assert!(matches!(err_del, NoteBackendError::NotFound(_)));
    }
}
