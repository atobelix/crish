//! 笔记后端契约类型与错误（SD-01 纵向切开 · **SD-32** 类型分模）
//!
//! 请求 / 结果 / 错误码 / batch token；**不含** Memory 实现与 plan 引擎。
//! 公开路径经 [`crate::note_backend`] re-export，保持 API 稳定。
//!
//! # SD-32 分模
//! - [`error`]：[`NoteBackendError`]
//! - [`ops`]：query / outline / apply_md / 细粒度 block op
//! - [`batch`]：[`NoteBatchTokens`]
//!
//! # 诚实边界
//! - **≠ EL-05**；**≠ A-AGT 满表关闭**
//! - **≠** 宣称 Store 后端完成（本模块仅为叶子契约形状）
//! - **≠** 重做 plan kinds / set_attr

#[path = "note_types_batch.rs"]
mod batch;
#[path = "note_types_error.rs"]
mod error;
#[path = "note_types_ops.rs"]
mod ops;

pub use batch::{NoteBatchTokens, DEFAULT_BATCH_TOKEN_TTL};
pub use error::NoteBackendError;
pub use ops::{
    NoteApplyMdRequest, NoteApplyMdResult, NoteApplyMode, NoteBlockBatchRequest,
    NoteBlockBatchResult, NoteBlockDeleteRequest, NoteBlockDeleteResult, NoteBlockInsertRequest,
    NoteBlockInsertResult, NoteBlockMoveRequest, NoteBlockMoveResult, NoteBlockOp, NoteBlockOpKind,
    NoteBlockOpPreview, NoteBlockSetAttrRequest, NoteBlockSetAttrResult, NoteBlockUpdateRequest,
    NoteBlockUpdateResult, NoteLossyItem, NoteLossyReport, NoteOutline, NoteOutlineNode,
    NoteQueryBlockHit, NoteQueryBlocksParams, NoteQueryBlocksResult,
};
