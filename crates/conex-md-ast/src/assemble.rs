//! 块序列 → `BlockTree` 容器栈组装（Conex 嵌套模型）。
//!
//! 与 P 后端无关：handwritten / markdown-rs 均产出 [`RawBlock`] 后走同一组装。
//!
//! # 嵌套规则（容器栈）
//! - **容器**：`Heading{level}`（秩=level）、`BulletItem` / `OrderedItem` / `Quote`（秩=10）
//! - **叶子**：`Paragraph`、`Code`、`Divider`、`Unknown` —— 挂到当前栈顶，不入栈
//! - 新容器：弹出栈中秩 ≥ 自身的容器后，挂到新栈顶（或根），再入栈

use crate::{BlockId, BlockKind, BlockNode, BlockProps, BlockTree, MdError};
use std::collections::HashMap;

/// 解析阶段中间块（尚未挂父子）。
#[derive(Debug, Clone)]
pub(crate) struct RawBlock {
    pub id: BlockId,
    pub kind: BlockKind,
    pub text: String,
    pub props: BlockProps,
    #[allow(dead_code)]
    pub line: usize,
}

/// 容器秩：越小越高；叶子返回 None。
pub(crate) fn container_rank(kind: &BlockKind) -> Option<u8> {
    match kind {
        BlockKind::Heading { level } => Some((*level).clamp(1, 6)),
        BlockKind::BulletItem | BlockKind::OrderedItem | BlockKind::Quote => Some(10),
        _ => None,
    }
}

/// 将扁平 `RawBlock` 序列按容器栈组装为 `BlockTree`。
pub(crate) fn assemble_tree(blocks: &[RawBlock]) -> Result<BlockTree, MdError> {
    let mut nodes: HashMap<BlockId, BlockNode> = HashMap::new();
    let mut root_children: Vec<BlockId> = Vec::new();
    // 栈：(id, rank)
    let mut stack: Vec<(BlockId, u8)> = Vec::new();
    // 各父下已分配的子序号（用于 order 字符串）
    let mut sibling_seq: HashMap<Option<BlockId>, u32> = HashMap::new();

    for b in blocks {
        // 弹出秩 ≥ 当前容器秩 的容器
        if let Some(rank) = container_rank(&b.kind) {
            while stack.last().map(|(_, r)| *r >= rank).unwrap_or(false) {
                stack.pop();
            }
        }

        let parent = stack.last().map(|(id, _)| *id);
        let seq = sibling_seq.entry(parent).or_insert(0);
        let order = format!("a{seq:04}");
        *seq += 1;

        let node = BlockNode {
            id: b.id,
            parent,
            order,
            kind: b.kind.clone(),
            props: b.props.clone(),
            text_snapshot: Some(b.text.clone()),
            children: Vec::new(),
        };
        nodes.insert(b.id, node);

        match parent {
            Some(pid) => {
                if let Some(p) = nodes.get_mut(&pid) {
                    p.children.push(b.id);
                } else {
                    return Err(MdError::Parse(format!("内部错误：父节点 {pid} 不存在")));
                }
            }
            None => root_children.push(b.id),
        }

        if let Some(rank) = container_rank(&b.kind) {
            stack.push((b.id, rank));
        }
    }

    Ok(BlockTree {
        root_children,
        nodes,
    })
}
