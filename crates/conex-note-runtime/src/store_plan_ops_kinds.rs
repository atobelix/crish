//! Store plan→collab：按 op kind 的私有规划函数（**SD-11** 内聚切开）
//!
//! 由 [`super::plan_block_ops_to_collab`] 调度；**不**对外暴露第二入口。
//! **≠ EL-05**；语义与切开前一致（不静默改 D-0x / Memory∥Store 差异）。

use super::{
    kind_label, parse_block_id, parse_block_kind, sibling_base_seq, PlanNodeMeta, PlanState,
};
use agent_tools::note_backend::{NoteBackendError, NoteBlockOp, NoteBlockOpPreview};
use conex_doc_collab::{BlockId, BlockProps, BlockTree, Op};

/// Insert：解析 id / parent / previous → order → Op::Insert (+ 可选 TextEdit)。
pub(super) fn plan_insert(
    state: &mut PlanState,
    tree: &BlockTree,
    op: &NoteBlockOp,
) -> Result<(), NoteBackendError> {
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
            if state.known.contains_key(&bid) {
                return Err(NoteBackendError::IdConflict(format!(
                    "block id already exists: {bid}"
                )));
            }
            bid
        }
        _ => BlockId::new(),
    };

    let previous = match &op.previous_id {
        Some(s) if !s.trim().is_empty() => Some(parse_block_id(s, "previous_id")?),
        _ => None,
    };
    let explicit_parent = match &op.parent_id {
        Some(s) if !s.trim().is_empty() => Some(parse_block_id(s, "parent_id")?),
        _ => None,
    };

    let parent = if let Some(pid) = explicit_parent {
        if !state.known.contains_key(&pid) {
            return Err(NoteBackendError::NotFound(format!(
                "parent_id not found: {pid}"
            )));
        }
        Some(pid)
    } else if let Some(prev) = previous {
        let meta = state.known.get(&prev).ok_or_else(|| {
            NoteBackendError::NotFound(format!("previous_id not found: {prev}"))
        })?;
        meta.parent
    } else {
        None
    };

    if let Some(prev) = previous {
        if !state.known.contains_key(&prev) {
            return Err(NoteBackendError::NotFound(format!(
                "previous_id not found: {prev}"
            )));
        }
    }

    let order = if let Some(prev) = previous {
        let prev_order = state
            .known
            .get(&prev)
            .map(|m| m.order.clone())
            .unwrap_or_else(|| "a0".into());
        let seq = state.order_seq_by_parent.entry(parent).or_insert(0);
        let o = format!("{prev_order}~{seq:04}");
        *seq += 1;
        o
    } else {
        let base = sibling_base_seq(tree, parent)
            + state
                .children_of
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
        let seq = state.order_seq_by_parent.entry(parent).or_insert(0);
        let o = format!("a{:04}", base + *seq);
        *seq += 1;
        o
    };

    let mut props = BlockProps::default();
    if let Some(ref attrs) = op.attrs {
        props.attrs = attrs.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    }

    state.collab_ops.push(Op::Insert {
        id,
        parent,
        order: order.clone(),
        kind: kind.clone(),
        props,
    });
    if !content.is_empty() {
        state.collab_ops.push(Op::TextEdit {
            id,
            start: 0,
            end: 0,
            insert: content.clone(),
        });
    }

    state.known.insert(
        id,
        PlanNodeMeta {
            parent,
            order: order.clone(),
            kind: kind.clone(),
            text_len: content.chars().count() as u32,
            text: content.clone(),
        },
    );
    state
        .children_of
        .entry(parent)
        .or_default()
        .push((id, order));

    let summary = Some(content.chars().take(80).collect::<String>());
    state.previews.push(NoteBlockOpPreview {
        op: "insert".into(),
        id: Some(id.to_string()),
        kind: Some(kind_label),
        summary,
    });
    state.block_ids.push(id.to_string());
    Ok(())
}

/// Update：全量 TextEdit 替换 + 可选 UpdateProps。
pub(super) fn plan_update(
    state: &mut PlanState,
    op: &NoteBlockOp,
) -> Result<(), NoteBackendError> {
    let id_s = op
        .id
        .clone()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| NoteBackendError::Invalid("update requires non-empty id".into()))?;
    let id = parse_block_id(&id_s, "id")?;
    let meta = state
        .known
        .get(&id)
        .ok_or_else(|| NoteBackendError::NotFound(format!("block not found: {id}")))?;
    let content = op
        .content
        .clone()
        .ok_or_else(|| NoteBackendError::Invalid("update requires content".into()))?;
    let end = meta.text_len;
    let kind_label = kind_label(&meta.kind);
    state.collab_ops.push(Op::TextEdit {
        id,
        start: 0,
        end,
        insert: content.clone(),
    });
    if let Some(ref attrs) = op.attrs {
        let mut props = BlockProps::default();
        props.attrs = attrs.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        state.collab_ops.push(Op::UpdateProps { id, props });
    }
    if let Some(m) = state.known.get_mut(&id) {
        m.text_len = content.chars().count() as u32;
        m.text = content.clone();
    }
    state.previews.push(NoteBlockOpPreview {
        op: "update".into(),
        id: Some(id.to_string()),
        kind: Some(kind_label),
        summary: Some(content.chars().take(80).collect()),
    });
    state.block_ids.push(id.to_string());
    Ok(())
}

/// Delete：Op::Delete + 规划期 known/children 摘除。
pub(super) fn plan_delete(
    state: &mut PlanState,
    op: &NoteBlockOp,
) -> Result<(), NoteBackendError> {
    let id_s = op
        .id
        .clone()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| NoteBackendError::Invalid("delete requires non-empty id".into()))?;
    let id = parse_block_id(&id_s, "id")?;
    let meta = state
        .known
        .get(&id)
        .ok_or_else(|| NoteBackendError::NotFound(format!("block not found: {id}")))?;
    let kind_label = kind_label(&meta.kind);
    let parent = meta.parent;
    state.collab_ops.push(Op::Delete { id });
    state.known.remove(&id);
    if let Some(list) = state.children_of.get_mut(&parent) {
        list.retain(|(cid, _)| *cid != id);
    }
    state.previews.push(NoteBlockOpPreview {
        op: "delete".into(),
        id: Some(id.to_string()),
        kind: Some(kind_label),
        summary: None,
    });
    state.block_ids.push(id.to_string());
    Ok(())
}

/// Move：解析 new_parent / previous → order → Op::Move + 规划期父子重挂。
pub(super) fn plan_move(
    state: &mut PlanState,
    op: &NoteBlockOp,
) -> Result<(), NoteBackendError> {
    let id_s = op
        .id
        .clone()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| NoteBackendError::Invalid("move requires non-empty id".into()))?;
    let id = parse_block_id(&id_s, "id")?;
    let meta = state
        .known
        .get(&id)
        .ok_or_else(|| NoteBackendError::NotFound(format!("block not found: {id}")))?;
    let kind_label = kind_label(&meta.kind);
    let old_parent = meta.parent;

    let new_parent = match &op.parent_id {
        Some(s) if !s.trim().is_empty() => {
            let pid = parse_block_id(s, "parent_id")?;
            if !state.known.contains_key(&pid) {
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
            if !state.known.contains_key(&prev) {
                return Err(NoteBackendError::NotFound(format!(
                    "previous_id not found: {prev}"
                )));
            }
            Some(prev)
        }
        _ => None,
    };

    let order = if let Some(prev) = previous {
        let prev_order = state
            .known
            .get(&prev)
            .map(|m| m.order.clone())
            .unwrap_or_else(|| "a0".into());
        format!("{prev_order}~m")
    } else {
        let base = state
            .children_of
            .get(&new_parent)
            .map(|v| v.len() as u32)
            .unwrap_or(0);
        format!("a{base:04}")
    };

    state.collab_ops.push(Op::Move {
        id,
        new_parent,
        order: order.clone(),
    });
    if let Some(m) = state.known.get_mut(&id) {
        m.parent = new_parent;
        m.order = order.clone();
    }
    if let Some(list) = state.children_of.get_mut(&old_parent) {
        list.retain(|(cid, _)| *cid != id);
    }
    state
        .children_of
        .entry(new_parent)
        .or_default()
        .push((id, order));

    state.previews.push(NoteBlockOpPreview {
        op: "move".into(),
        id: Some(id.to_string()),
        kind: Some(kind_label),
        summary: None,
    });
    state.block_ids.push(id.to_string());
    Ok(())
}

/// SetAttr：UpdateProps 仅 attrs。
pub(super) fn plan_set_attr(
    state: &mut PlanState,
    op: &NoteBlockOp,
) -> Result<(), NoteBackendError> {
    let id_s = op
        .id
        .clone()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| NoteBackendError::Invalid("set_attr requires non-empty id".into()))?;
    let id = parse_block_id(&id_s, "id")?;
    let meta = state
        .known
        .get(&id)
        .ok_or_else(|| NoteBackendError::NotFound(format!("block not found: {id}")))?;
    let kind_label = kind_label(&meta.kind);
    let attrs = op.attrs.clone().unwrap_or_default();
    let mut props = BlockProps::default();
    props.attrs = attrs.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    state.collab_ops.push(Op::UpdateProps { id, props });
    state.previews.push(NoteBlockOpPreview {
        op: "set_attr".into(),
        id: Some(id.to_string()),
        kind: Some(kind_label),
        summary: Some(format!("{} attrs", attrs.len())),
    });
    state.block_ids.push(id.to_string());
    Ok(())
}
