//! Conex 文档心：块树权威 + 单一 apply 边界。
//!
//! # 不变量（见 docs/block-workspace-architecture/15、18）
//! - 唯一写入口 [`DocSession::apply`]
//! - 文本引擎（yrs）**crate 私有**（`mod text_engine`）：公共 API **禁止** 返回/ re-export
//!   `yrs::Doc` / `yrs::Text` / 任何 yrs 类型（A-INV-05 / W1-B）
//! - 热集/冷藏（H1）：活动 YText ≤ `max_hot`（默认 512）；冷块可读快照（A-MEM-01…04）
//! - 跨引擎同批：[`a_inv_09`] 三连（树 Op + 文本 edit 同批提交/回滚）

#![allow(missing_docs)]

mod block_id;
mod events;
/// W1-F / A-COL-01：双 DocSession in-process 互推 harness（pub 可测试）。
pub mod harness;
mod ir;
mod op;
mod persistence;
mod session;
/// 叶子文本引擎：yrs + 热集/冷藏（**非** `pub mod`，A-INV-05）。
mod text_engine;
mod tx;

pub use block_id::{BlockId, block_id_from_comment, block_id_to_comment};
pub use events::{BlockUpsert, DocEvent, ProjectionDiff};
pub use harness::{DualSessionHarness, PeerSide, SimplifiedEncodedOps};
pub use ir::{BlockKind, BlockNode, BlockProps, BlockTree, cmp_order};
pub use op::{Op, Origin};
pub use persistence::{CommitBatch, EncodedUpdate, HydrateBlob, PersistError, PersistencePlugin};
pub use session::{
    partition_utf8, ApplyError, DocSession, TextUpdatePayload, DEFAULT_T_HUGE, DEFAULT_T_SEGMENT,
    MAX_T_HUGE, MIN_T_HUGE,
};
pub use tx::{TxGuard, TxId};

/// A-INV-09 文档锚点（测试与门禁引用此模块路径）。
pub mod a_inv_09 {
    //! a: 同批提交/回滚 · b: checkpoint 同源 · c: 删块释放叶子
    pub const A_INV_09A: &str = "A-INV-09a";
    pub const A_INV_09B: &str = "A-INV-09b";
    pub const A_INV_09C: &str = "A-INV-09c";
}

/// A-HUGE 文档锚点（M2 超长单块；测试引用此模块路径）。
pub mod a_huge {
    //! 01: 亚阈保持单叶 · 02: 超阈同事务分段或整批失败（零半树）
    pub const A_HUGE_01: &str = "A-HUGE-01";
    pub const A_HUGE_02: &str = "A-HUGE-02";
}
