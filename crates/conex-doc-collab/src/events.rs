//! ProjectionDiff / DocEvent（W0-E）。

use crate::block_id::BlockId;
use crate::ir::{BlockKind, BlockProps};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockUpsert {
    pub id: BlockId,
    pub kind: BlockKind,
    pub props: BlockProps,
    pub children: Vec<BlockId>,
    pub order: String,
    pub parent: Option<BlockId>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectionDiff {
    pub doc_id: String,
    /// 单调版本
    pub rev: u64,
    pub upserts: Vec<BlockUpsert>,
    pub removes: Vec<BlockId>,
    pub text_touches: Vec<BlockId>,
    /// 默认 false；仅灾难恢复
    #[serde(default)]
    pub full_rebuild: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DocEvent {
    Projection { diff: ProjectionDiff },
    Reject { intent_id: String, reason: String },
    Awareness { payload: serde_json::Value },
}
