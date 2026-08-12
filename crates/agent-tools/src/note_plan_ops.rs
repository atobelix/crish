//! Memory 块级批规划 / 提交（SD-01 纵向切开 · `plan_block_ops`）
//!
//! 从 `note_backend` 巨石抽出 W4-F 规划引擎：校验 + 预览 + mutations，
//! 与权威树提交分离（dryRun 零写）。
//!
//! # 诚实边界
//! - Memory 扁平列表；**≠** Store 真事务
//! - **≠ EL-05**；**≠ W6-E Strict**；不宣称 Store 后端完成

use crate::note_md_parse::parse_heading_level_from_text;
use crate::note_types::{
    NoteBackendError, NoteBlockOp, NoteBlockOpKind, NoteBlockOpPreview,
};
use serde_json::{Map, Value as JsonValue};

// ── Memory 扁平块模型（plan / Memory 共用）──────────────────────────

/// 进程内块（Memory 伪实现）
#[derive(Debug, Clone)]
pub(crate) struct MemBlock {
    pub(crate) id: String,
    pub(crate) kind: String,
    pub(crate) text: String,
    pub(crate) attrs: Map<String, JsonValue>,
    /// 该块引用的目标 id 列表（ref_from 查询）
    pub(crate) refs_to: Vec<String>,
    /// heading level（paragraph = 0）
    pub(crate) level: u32,
}

/// 进程内文档
#[derive(Debug, Default)]
pub(crate) struct MemDoc {
    pub(crate) blocks: Vec<MemBlock>,
}

// ── 规划结果 ────────────────────────────────────────────────────────

/// 规划结果：预览 + 待提交 mutation（与当前树校验后）
#[derive(Debug)]
pub(crate) struct BlockOpPlan {
    pub(crate) previews: Vec<NoteBlockOpPreview>,
    pub(crate) block_ids: Vec<String>,
    pub(crate) mutations: Vec<PlannedMutation>,
}

#[derive(Debug)]
pub(crate) enum PlannedMutation {
    Insert {
        at: usize,
        block: MemBlock,
    },
    Update {
        id: String,
        content: String,
    },
    Delete {
        id: String,
    },
    Move {
        id: String,
        to_index: usize,
    },
    SetAttr {
        id: String,
        attrs: Map<String, JsonValue>,
    },
}

/// 对当前块列表规划 ops（不修改输入权威树）
///
/// # 错误
/// - [`NoteBackendError::IdConflict`]：insert 预分配 id 已存在
/// - [`NoteBackendError::NotFound`]：previous / parent / 目标块缺失
/// - [`NoteBackendError::Invalid`]：缺必填字段
pub(crate) fn plan_block_ops(
    existing: Option<&[MemBlock]>,
    ops: &[NoteBlockOp],
    mut next_id: impl FnMut() -> String,
) -> Result<BlockOpPlan, NoteBackendError> {
    // 工作副本：仅用于规划期索引；实写另走 mutations
    let mut work: Vec<MemBlock> = existing
        .map(|s| s.to_vec())
        .unwrap_or_default();
    let mut previews = Vec::with_capacity(ops.len());
    let mut block_ids = Vec::new();
    let mut mutations = Vec::with_capacity(ops.len());

    for op in ops {
        match op.op {
            NoteBlockOpKind::Insert => {
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
                        if work.iter().any(|b| b.id == *id) {
                            return Err(NoteBackendError::IdConflict(format!(
                                "block id already exists: {id}"
                            )));
                        }
                        id.clone()
                    }
                    _ => next_id(),
                };
                let mut insert_at = work.len();
                if let Some(ref prev) = op.previous_id {
                    match work.iter().position(|b| b.id == *prev) {
                        Some(i) => insert_at = i + 1,
                        None => {
                            return Err(NoteBackendError::NotFound(format!(
                                "previous_id not found: {prev}"
                            )));
                        }
                    }
                }
                if let Some(ref parent) = op.parent_id {
                    if !work.iter().any(|b| b.id == *parent) && !work.is_empty() {
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
                previews.push(NoteBlockOpPreview {
                    op: "insert".into(),
                    id: Some(id.clone()),
                    kind: Some(kind),
                    summary,
                });
                block_ids.push(id);
                work.insert(insert_at, block.clone());
                mutations.push(PlannedMutation::Insert {
                    at: insert_at,
                    block,
                });
            }
            NoteBlockOpKind::Update => {
                let id = op
                    .id
                    .clone()
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| {
                        NoteBackendError::Invalid("update requires non-empty id".into())
                    })?;
                let content = op.content.clone().ok_or_else(|| {
                    NoteBackendError::Invalid("update requires content".into())
                })?;
                let pos = work.iter().position(|b| b.id == id).ok_or_else(|| {
                    NoteBackendError::NotFound(format!("block not found: {id}"))
                })?;
                work[pos].text = content.clone();
                previews.push(NoteBlockOpPreview {
                    op: "update".into(),
                    id: Some(id.clone()),
                    kind: Some(work[pos].kind.clone()),
                    summary: Some(content.chars().take(80).collect()),
                });
                block_ids.push(id.clone());
                mutations.push(PlannedMutation::Update { id, content });
            }
            NoteBlockOpKind::Delete => {
                let id = op
                    .id
                    .clone()
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| {
                        NoteBackendError::Invalid("delete requires non-empty id".into())
                    })?;
                let pos = work.iter().position(|b| b.id == id).ok_or_else(|| {
                    NoteBackendError::NotFound(format!("block not found: {id}"))
                })?;
                let kind = work[pos].kind.clone();
                work.remove(pos);
                previews.push(NoteBlockOpPreview {
                    op: "delete".into(),
                    id: Some(id.clone()),
                    kind: Some(kind),
                    summary: None,
                });
                block_ids.push(id.clone());
                mutations.push(PlannedMutation::Delete { id });
            }
            NoteBlockOpKind::Move => {
                let id = op
                    .id
                    .clone()
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| {
                        NoteBackendError::Invalid("move requires non-empty id".into())
                    })?;
                let from = work.iter().position(|b| b.id == id).ok_or_else(|| {
                    NoteBackendError::NotFound(format!("block not found: {id}"))
                })?;
                let block = work.remove(from);
                let mut to_index = work.len();
                if let Some(ref prev) = op.previous_id {
                    match work.iter().position(|b| b.id == *prev) {
                        Some(i) => to_index = i + 1,
                        None => {
                            return Err(NoteBackendError::NotFound(format!(
                                "previous_id not found: {prev}"
                            )));
                        }
                    }
                }
                let kind = block.kind.clone();
                work.insert(to_index, block);
                previews.push(NoteBlockOpPreview {
                    op: "move".into(),
                    id: Some(id.clone()),
                    kind: Some(kind),
                    summary: None,
                });
                block_ids.push(id.clone());
                mutations.push(PlannedMutation::Move { id, to_index });
            }
            NoteBlockOpKind::SetAttr => {
                let id = op
                    .id
                    .clone()
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| {
                        NoteBackendError::Invalid("set_attr requires non-empty id".into())
                    })?;
                let attrs = op.attrs.clone().unwrap_or_default();
                let pos = work.iter().position(|b| b.id == id).ok_or_else(|| {
                    NoteBackendError::NotFound(format!("block not found: {id}"))
                })?;
                work[pos].attrs = attrs.clone();
                previews.push(NoteBlockOpPreview {
                    op: "set_attr".into(),
                    id: Some(id.clone()),
                    kind: Some(work[pos].kind.clone()),
                    summary: Some(format!("{} attrs", attrs.len())),
                });
                block_ids.push(id.clone());
                mutations.push(PlannedMutation::SetAttr { id, attrs });
            }
        }
    }

    Ok(BlockOpPlan {
        previews,
        block_ids,
        mutations,
    })
}

/// 将规划好的 mutations 应用到文档（调用方持锁）
pub(crate) fn apply_planned_ops(
    doc: &mut MemDoc,
    mutations: Vec<PlannedMutation>,
) -> Result<(), NoteBackendError> {
    for m in mutations {
        match m {
            PlannedMutation::Insert { at, block } => {
                let at = at.min(doc.blocks.len());
                doc.blocks.insert(at, block);
            }
            PlannedMutation::Update { id, content } => {
                let b = doc
                    .blocks
                    .iter_mut()
                    .find(|b| b.id == id)
                    .ok_or_else(|| {
                        NoteBackendError::NotFound(format!("block not found on commit: {id}"))
                    })?;
                b.text = content;
            }
            PlannedMutation::Delete { id } => {
                let pos = doc.blocks.iter().position(|b| b.id == id).ok_or_else(|| {
                    NoteBackendError::NotFound(format!("block not found on commit: {id}"))
                })?;
                doc.blocks.remove(pos);
            }
            PlannedMutation::Move { id, to_index } => {
                let from = doc.blocks.iter().position(|b| b.id == id).ok_or_else(|| {
                    NoteBackendError::NotFound(format!("block not found on commit: {id}"))
                })?;
                let block = doc.blocks.remove(from);
                let to = to_index.min(doc.blocks.len());
                doc.blocks.insert(to, block);
            }
            PlannedMutation::SetAttr { id, attrs } => {
                let b = doc
                    .blocks
                    .iter_mut()
                    .find(|b| b.id == id)
                    .ok_or_else(|| {
                        NoteBackendError::NotFound(format!("block not found on commit: {id}"))
                    })?;
                b.attrs = attrs;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed_p1() -> Vec<MemBlock> {
        vec![MemBlock {
            id: "p1".into(),
            kind: "paragraph".into(),
            text: "keep".into(),
            attrs: Map::new(),
            refs_to: Vec::new(),
            level: 0,
        }]
    }

    /// plan：预分配 id 已存在 → IdConflict（不修改输入切片）
    #[test]
    fn plan_block_ops_id_conflict() {
        let existing = seed_p1();
        let ops = [NoteBlockOp {
            op: NoteBlockOpKind::Insert,
            id: Some("p1".into()),
            parent_id: None,
            previous_id: None,
            content: Some("dup".into()),
            kind: Some("paragraph".into()),
            attrs: None,
        }];
        let err = plan_block_ops(Some(&existing), &ops, || "gen".into()).unwrap_err();
        assert!(matches!(err, NoteBackendError::IdConflict(_)));
        assert_eq!(err.code(), "note.id_conflict");
        // 输入权威树未变（plan 仅用副本）
        assert_eq!(existing.len(), 1);
    }

    /// plan：previous_id 不存在 → NotFound
    #[test]
    fn plan_block_ops_previous_not_found() {
        let existing = seed_p1();
        let ops = [NoteBlockOp {
            op: NoteBlockOpKind::Insert,
            id: None,
            parent_id: None,
            previous_id: Some("ghost".into()),
            content: Some("x".into()),
            kind: None,
            attrs: None,
        }];
        let err = plan_block_ops(Some(&existing), &ops, || "n1".into()).unwrap_err();
        assert!(matches!(err, NoteBackendError::NotFound(_)));
        assert!(err.message().contains("previous_id"));
    }

    /// plan 成功 + apply：insert 落盘；失败路径不调用 apply
    #[test]
    fn plan_and_apply_insert_commits() {
        let mut doc = MemDoc {
            blocks: seed_p1(),
        };
        let ops = [NoteBlockOp {
            op: NoteBlockOpKind::Insert,
            id: Some("p2".into()),
            parent_id: None,
            previous_id: Some("p1".into()),
            content: Some("new".into()),
            kind: Some("paragraph".into()),
            attrs: None,
        }];
        let plan = plan_block_ops(Some(&doc.blocks), &ops, || "unused".into()).unwrap();
        assert_eq!(plan.block_ids, vec!["p2".to_string()]);
        apply_planned_ops(&mut doc, plan.mutations).unwrap();
        assert_eq!(doc.blocks.len(), 2);
        assert_eq!(doc.blocks[1].id, "p2");
    }
}
