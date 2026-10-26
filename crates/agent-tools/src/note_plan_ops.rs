//! Memory 块级批规划 / 提交（SD-01 纵向切开 · **SD-14** 函数内聚 · `plan_block_ops`）
//!
//! 从 `note_backend` 巨石抽出 W4-F 规划引擎：校验 + 预览 + mutations，
//! 与权威树提交分离（dryRun 零写）。
//!
//! # SD-14 边界（本包）
//! - **本模块职责**：单入口 [`plan_block_ops`] + 规划期类型 + [`apply_planned_ops`]
//! - **SD-14**：按 op kind 拆至 [`kinds`]（insert/update/delete/move/set_attr）；
//!   测旁挂 `note_plan_ops_tests.rs`；**仍仅一处**权威 `plan_block_ops` 定义
//! - **≠ EL-05**；**≠** 整包重做 SD-07 契约；**≠** SD-11（Store 侧）重做
//!
//! # SD-07 · 双 plan 引擎对齐契约（Memory ∥ Store）
//!
//! 平行实现：本模块 [`plan_block_ops`]（Memory 扁平）∥
//! `conex-note-runtime` 的 `plan_block_ops_to_collab`（collab 树 · Store 侧 SD-11 已切）。
//! **禁止** silently 行为分叉；同场景须同稳定错误码，或登记在有意差异表。
//! 差分测：`crates/conex-note-runtime/tests/note_plan_parity.rs`（经 `NoteBackend` 公开 API）。
//!
//! ## 共享用例表（N≥5 · 同码 / 同 dry_run 零写）
//!
//! | ID | 场景 | 稳定码 / 形状 | 双端 |
//! | -- | ---- | ------------- | ---- |
//! | **P-01** | insert 预分配 id 已存在 | `note.id_conflict` | ✅ |
//! | **P-02** | insert `previous_id` 不存在（合法 id 形） | `note.not_found` | ✅ |
//! | **P-03** | update/delete 目标块不存在 | `note.not_found` | ✅ |
//! | **P-04** | `dry_run=true` 规划成功 | preview 非空 + **零写**权威树 | ✅ |
//! | **P-05** | `force_execution_unknown`（非 dry_run） | `note.execution_unknown` + **零半写** | ✅ |
//! | **P-06** | update 缺 content / 空 id | `note.invalid` | ✅ |
//!
//! ## 有意差异表（Memory 扁平 vs Store collab · 可审计）
//!
//! | ID | 维度 | Memory | Store | 说明 |
//! | -- | ---- | ------ | ----- | ---- |
//! | **D-01** | 块 id 格式 | 任意非空串 | **UUID only**（`parse_block_id`） | 非 UUID → Store `note.invalid`；Memory 当普通 id |
//! | **D-02** | 树模型 | 扁平 `Vec` 序 | parent + fractional `order` | move/insert 锚点语义同 previous，落盘结构不同 |
//! | **D-03** | `parent_id` 空树 | 空文档时可不存在 parent | parent 必须已在 known | Memory 宽松探测；Store 严格 |
//! | **D-04** | heading `kind` 预览 | `"heading"` | `"heading:{level}"` | preview 标签；错误码无关 |
//! | **D-05** | 提交形态 | `apply_planned_ops` 列表 mutate | `commit_ops` collab Op 批 | 测形状对齐，**≠** 宣称同事务实现 |
//!
//! # 诚实边界
//! - Memory 扁平列表；**≠** Store 真事务
//! - **≠ EL-05**；**≠ W6-E Strict**；不宣称 Store 后端完成；**不**删除 Memory

#[path = "note_plan_ops_kinds.rs"]
mod kinds;

#[cfg(test)]
#[path = "note_plan_ops_tests.rs"]
mod tests;

use crate::note_types::{NoteBackendError, NoteBlockOp, NoteBlockOpKind, NoteBlockOpPreview};
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

/// 规划期工作态（批内 insert 可互引；失败整批丢弃）。
/// kinds 子模写入；入口组装为 [`BlockOpPlan`]。
pub(crate) struct MemPlanState {
    pub(crate) work: Vec<MemBlock>,
    pub(crate) previews: Vec<NoteBlockOpPreview>,
    pub(crate) block_ids: Vec<String>,
    pub(crate) mutations: Vec<PlannedMutation>,
}

impl MemPlanState {
    fn from_existing(existing: Option<&[MemBlock]>, ops_len: usize) -> Self {
        Self {
            work: existing.map(|s| s.to_vec()).unwrap_or_default(),
            previews: Vec::with_capacity(ops_len),
            block_ids: Vec::new(),
            mutations: Vec::with_capacity(ops_len),
        }
    }

    fn into_plan(self) -> BlockOpPlan {
        BlockOpPlan {
            previews: self.previews,
            block_ids: self.block_ids,
            mutations: self.mutations,
        }
    }
}

// ── 规划主入口（唯一权威定义） ──────────────────────────────────────

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
    let mut state = MemPlanState::from_existing(existing, ops.len());

    for op in ops {
        match op.op {
            NoteBlockOpKind::Insert => kinds::plan_insert(&mut state, op, &mut next_id)?,
            NoteBlockOpKind::Update => kinds::plan_update(&mut state, op)?,
            NoteBlockOpKind::Delete => kinds::plan_delete(&mut state, op)?,
            NoteBlockOpKind::Move => kinds::plan_move(&mut state, op)?,
            NoteBlockOpKind::SetAttr => kinds::plan_set_attr(&mut state, op)?,
        }
    }

    Ok(state.into_plan())
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
                let b = doc.blocks.iter_mut().find(|b| b.id == id).ok_or_else(|| {
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
                let b = doc.blocks.iter_mut().find(|b| b.id == id).ok_or_else(|| {
                    NoteBackendError::NotFound(format!("block not found on commit: {id}"))
                })?;
                b.attrs.extend(attrs);
            }
        }
    }
    Ok(())
}
