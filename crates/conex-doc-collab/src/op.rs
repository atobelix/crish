use crate::block_id::BlockId;
use crate::ir::{BlockKind, BlockProps};
use serde::{Deserialize, Serialize};

/// 变更来源（undo 可过滤）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    User,
    Agent,
    Remote,
    System,
}

/// 结构化 Op（树）；文本细粒度另走 text_edit。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    Insert {
        id: BlockId,
        parent: Option<BlockId>,
        /// fractional index 字符串，排序键
        order: String,
        kind: BlockKind,
        props: BlockProps,
    },
    UpdateProps {
        id: BlockId,
        props: BlockProps,
    },
    Move {
        id: BlockId,
        new_parent: Option<BlockId>,
        order: String,
    },
    Delete {
        id: BlockId,
    },
    /// 叶子文本编辑：经 `TextEngine`（yrs YText，crate 私有）应用。
    TextEdit {
        id: BlockId,
        /// **Unicode 标量（char）偏移**（与 W0 骨架一致）；引擎内换算为 UTF-8 字节再写 yrs。
        start: u32,
        end: u32,
        insert: String,
    },
}
