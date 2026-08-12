//! Memory plan→mutation：按 op kind 的私有规划函数（**SD-14** 内聚切开）
//!
//! 由 [`super::plan_block_ops`] 调度；**不**对外暴露第二入口。
//! **≠ EL-05**；语义与切开前一致（不静默改 D-0x / Memory∥Store 差异）。
//! **≠** 重做 SD-07 契约整包；**≠** SD-11（Store 侧）重做。

use super::{MemBlock, MemPlanState, PlannedMutation};
use crate::note_md_parse::parse_heading_level_from_text;
use crate::note_types::{NoteBackendError, NoteBlockOp, NoteBlockOpPreview};

/// Insert：解析 id / previous / parent → 工作副本插入 + PlannedMutation::Insert。
pub(super) fn plan_insert(
    state: &mut MemPlanState,
    op: &NoteBlockOp,
    next_id: &mut impl FnMut() -> String,
) -> Result<(), NoteBackendError> {
    let content = op.content.clone().unwrap_or_default();
    let kind = op
        .kind
        .clone()
        .unwrap_or_else(|| "paragraph".to_string());
    let level = if kind == "heading" {
        parse_heading_level_from_text(&content).unwrap_or(1)
    } else {
        0
    };
    let id = match &op.id {
        Some(id) if !id.trim().is_empty() => {
            if state.work.iter().any(|b| b.id == *id) {
                return Err(NoteBackendError::IdConflict(format!(
                    "block id already exists: {id}"
                )));
            }
            id.clone()
        }
        _ => next_id(),
    };
    let mut insert_at = state.work.len();
    if let Some(ref prev) = op.previous_id {
        match state.work.iter().position(|b| b.id == *prev) {
            Some(i) => insert_at = i + 1,
            None => {
                return Err(NoteBackendError::NotFound(format!(
                    "previous_id not found: {prev}"
                )));
            }
        }
    }
    if let Some(ref parent) = op.parent_id {
        // D-03：空文档时可不存在 parent；非空则须已在 work
        if !state.work.iter().any(|b| b.id == *parent) && !state.work.is_empty() {
            return Err(NoteBackendError::NotFound(format!(
                "parent_id not found: {parent}"
            )));
        }
    }
    let block = MemBlock {
        id: id.clone(),
        kind: kind.clone(),
        text: content.clone(),
        attrs: op.attrs.clone().unwrap_or_default(),
        refs_to: Vec::new(),
        level,
    };
    let summary = Some(content.chars().take(80).collect::<String>());
    state.previews.push(NoteBlockOpPreview {
        op: "insert".into(),
        id: Some(id.clone()),
        kind: Some(kind),
        summary,
    });
    state.block_ids.push(id);
    state.work.insert(insert_at, block.clone());
    state.mutations.push(PlannedMutation::Insert {
        at: insert_at,
        block,
    });
    Ok(())
}

/// Update：校验 id/content → 工作副本改 text + PlannedMutation::Update。
pub(super) fn plan_update(
    state: &mut MemPlanState,
    op: &NoteBlockOp,
) -> Result<(), NoteBackendError> {
    let id = op
        .id
        .clone()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| NoteBackendError::Invalid("update requires non-empty id".into()))?;
    let content = op
        .content
        .clone()
        .ok_or_else(|| NoteBackendError::Invalid("update requires content".into()))?;
    let pos = state
        .work
        .iter()
        .position(|b| b.id == id)
        .ok_or_else(|| NoteBackendError::NotFound(format!("block not found: {id}")))?;
    state.work[pos].text = content.clone();
    state.previews.push(NoteBlockOpPreview {
        op: "update".into(),
        id: Some(id.clone()),
        kind: Some(state.work[pos].kind.clone()),
        summary: Some(content.chars().take(80).collect()),
    });
    state.block_ids.push(id.clone());
    state.mutations.push(PlannedMutation::Update { id, content });
    Ok(())
}

/// Delete：校验 id → 工作副本摘除 + PlannedMutation::Delete。
pub(super) fn plan_delete(
    state: &mut MemPlanState,
    op: &NoteBlockOp,
) -> Result<(), NoteBackendError> {
    let id = op
        .id
        .clone()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| NoteBackendError::Invalid("delete requires non-empty id".into()))?;
    let pos = state
        .work
        .iter()
        .position(|b| b.id == id)
        .ok_or_else(|| NoteBackendError::NotFound(format!("block not found: {id}")))?;
    let kind = state.work[pos].kind.clone();
    state.work.remove(pos);
    state.previews.push(NoteBlockOpPreview {
        op: "delete".into(),
        id: Some(id.clone()),
        kind: Some(kind),
        summary: None,
    });
    state.block_ids.push(id.clone());
    state.mutations.push(PlannedMutation::Delete { id });
    Ok(())
}

/// Move：校验 id / previous → 工作副本重排 + PlannedMutation::Move。
pub(super) fn plan_move(
    state: &mut MemPlanState,
    op: &NoteBlockOp,
) -> Result<(), NoteBackendError> {
    let id = op
        .id
        .clone()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| NoteBackendError::Invalid("move requires non-empty id".into()))?;
    let from = state
        .work
        .iter()
        .position(|b| b.id == id)
        .ok_or_else(|| NoteBackendError::NotFound(format!("block not found: {id}")))?;
    let block = state.work.remove(from);
    let mut to_index = state.work.len();
    if let Some(ref prev) = op.previous_id {
        match state.work.iter().position(|b| b.id == *prev) {
            Some(i) => to_index = i + 1,
            None => {
                return Err(NoteBackendError::NotFound(format!(
                    "previous_id not found: {prev}"
                )));
            }
        }
    }
    let kind = block.kind.clone();
    state.work.insert(to_index, block);
    state.previews.push(NoteBlockOpPreview {
        op: "move".into(),
        id: Some(id.clone()),
        kind: Some(kind),
        summary: None,
    });
    state.block_ids.push(id.clone());
    state.mutations.push(PlannedMutation::Move { id, to_index });
    Ok(())
}

/// SetAttr：校验 id → 工作副本改 attrs + PlannedMutation::SetAttr。
pub(super) fn plan_set_attr(
    state: &mut MemPlanState,
    op: &NoteBlockOp,
) -> Result<(), NoteBackendError> {
    let id = op
        .id
        .clone()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            NoteBackendError::Invalid("set_attr requires non-empty id".into())
        })?;
    let attrs = op.attrs.clone().unwrap_or_default();
    let pos = state
        .work
        .iter()
        .position(|b| b.id == id)
        .ok_or_else(|| NoteBackendError::NotFound(format!("block not found: {id}")))?;
    state.work[pos].attrs = attrs.clone();
    state.previews.push(NoteBlockOpPreview {
        op: "set_attr".into(),
        id: Some(id.clone()),
        kind: Some(state.work[pos].kind.clone()),
        summary: Some(format!("{} attrs", attrs.len())),
    });
    state.block_ids.push(id.clone());
    state
        .mutations
        .push(PlannedMutation::SetAttr { id, attrs });
    Ok(())
}
