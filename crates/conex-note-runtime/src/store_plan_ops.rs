//! Store 块级 ops → collab [`Op`] 规划（**SD-06** 纵向切开 · **SD-11** 函数内聚）
//!
//! 从 `store_backend` 巨石抽出 W4-F 规划引擎：将工具层 [`NoteBlockOp`]
//! 规划为 collab 原子 Op 批（不修改 session；失败整批不返回 ops）。
//!
//! # SD-06 / SD-11 边界
//! - **本模块职责**：单入口 `plan_block_ops_to_collab` + kind/id 解析 + 规划期元数据
//! - **SD-11**：按 op kind 拆至 [`kinds`]（insert/update/delete/move/set_attr）；
//!   测旁挂 `store_plan_ops_tests.rs`；**仍仅一处**权威 `plan_block_ops_to_collab` 定义
//! - **不**含 session open / hydrate / apply_md / outline / trait 门面
//! - **≠ EL-05**；**≠ A-AGT 满表**；**≠ W6-E**；不宣称 Store 生产关账
//!
//! # 与 Memory plan 的关系（SD-07 已消化）
//! Memory：`agent_tools::note_plan_ops::plan_block_ops`（扁平列表）
//! Store：本模块（collab 树）。双引擎对齐契约见 `tests/note_plan_parity.rs`
//! （有意差异 D-01… 保持；本包 **不**整包重做 SD-07）。

#[path = "store_plan_ops_kinds.rs"]
mod kinds;

#[cfg(test)]
#[path = "store_plan_ops_tests.rs"]
mod tests;

use agent_tools::note_backend::{
    NoteBackendError, NoteBlockOp, NoteBlockOpKind, NoteBlockOpPreview,
};
use conex_doc_collab::{BlockId, BlockKind, BlockTree, DocSession, Op};
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

/// 规划期工作态（批内 insert 可互引；失败整批丢弃）。
pub(crate) struct PlanState {
    pub(crate) known: HashMap<BlockId, PlanNodeMeta>,
    pub(crate) children_of: HashMap<Option<BlockId>, Vec<(BlockId, String)>>,
    pub(crate) order_seq_by_parent: HashMap<Option<BlockId>, u32>,
    pub(crate) collab_ops: Vec<Op>,
    pub(crate) previews: Vec<NoteBlockOpPreview>,
    pub(crate) block_ids: Vec<String>,
}

impl PlanState {
    fn from_session(session: &DocSession) -> Self {
        let tree = session.tree();
        let known: HashMap<BlockId, PlanNodeMeta> = tree
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
        let mut children_of: HashMap<Option<BlockId>, Vec<(BlockId, String)>> = HashMap::new();
        for (id, meta) in &known {
            children_of
                .entry(meta.parent)
                .or_default()
                .push((*id, meta.order.clone()));
        }
        Self {
            known,
            children_of,
            order_seq_by_parent: HashMap::new(),
            collab_ops: Vec::new(),
            previews: Vec::new(),
            block_ids: Vec::new(),
        }
    }

    fn into_plan(self) -> StoreBlockOpPlan {
        StoreBlockOpPlan {
            collab_ops: self.collab_ops,
            previews: self.previews,
            block_ids: self.block_ids,
        }
    }
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

// ── 规划主入口（唯一权威定义） ──────────────────────────────────────

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
    let mut state = PlanState::from_session(session);

    for op in ops {
        match op.op {
            NoteBlockOpKind::Insert => kinds::plan_insert(&mut state, tree, op)?,
            NoteBlockOpKind::Update => kinds::plan_update(&mut state, op)?,
            NoteBlockOpKind::Delete => kinds::plan_delete(&mut state, op)?,
            NoteBlockOpKind::Move => kinds::plan_move(&mut state, op)?,
            NoteBlockOpKind::SetAttr => kinds::plan_set_attr(&mut state, op)?,
        }
    }

    Ok(state.into_plan())
}
