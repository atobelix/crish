//! Conex 文档心：块树权威 + 单一 apply 边界。
//!
//! # 不变量（见 docs/block-workspace-architecture/15、18）
//! - 唯一写入口 [`DocSession::apply`]
//! - 文本引擎（yrs）**crate 私有**（`mod text_engine`）：公共 API **禁止** 返回/ re-export
//!   `yrs::Doc` / `yrs::Text` / 任何 yrs 类型（A-INV-05 / W1-B）
//! - 热集/冷藏（H1）：活动 YText ≤ `max_hot`（默认 512）；冷块可读快照（A-MEM-01…04）
//! - Undo v1：[`DocSession::undo`] 按 origin 过滤（A-COL-04）；跨冷 plain 恢复（A-MEM-04）
//! - 跨引擎同批：[`a_inv_09`] 三连（树 Op + 文本 edit 同批提交/回滚；09c 含 undo 恢复）
//!
//! # W6-A-S（Skeleton · A-BLK 抽样）
//! - 包 ID：[`a_blk_skeleton::W6_A_S_PACKAGE_ID`] = `"W6-A-S"`（**必须**保留 `-S`）
//! - 测：`tests/a_blk_contract.rs` + TS `chrome.a_blk.test.ts`
//! - **诚实**：**≠ W6-A** Strict / **≠ EL-01** 满关（见 [`a_blk_skeleton`] 模块文档）
//!
//! # W6-D-S（Skeleton · 协作子集）
//! - 包 ID：[`a_col_skeleton::W6_D_S_PACKAGE_ID`] = `"W6-D-S"`（**必须**保留 `-S`）
//! - 子集：in-process **A-COL-01**（[`DualSessionHarness`] + `tests/a_col_dual_peer`）
//! - **诚实**：**≠ W6-D** Strict / **≠ EL-04** 满关（见 [`a_col_skeleton`] 模块文档）

#![allow(missing_docs)]

/// **W6-A-S** Skeleton：A-BLK 抽样轨锚（包 ID / 诚实边界 / 场景表）。
pub mod a_blk_skeleton;
/// **W6-D-S** Skeleton：A-COL-01 子集轨锚（包 ID / 诚实边界 / 场景表）。
pub mod a_col_skeleton;
mod block_id;
mod events;
/// W1-F / A-COL-01：双 DocSession in-process 互推 harness（pub 可测试）。
pub mod harness;
mod ir;
mod op;
mod persistence;
mod session;
/// 结构可逆 encode（G-HYD-1 / P-ENC 形态 A）；crate 内 + 测试可观测。
pub mod structure_codec;
/// 叶子文本引擎：yrs + 热集/冷藏（**非** `pub mod`，A-INV-05）。
mod text_engine;
mod tx;

/// W6-A-S 包锚 re-export（调度 / 集成测可 `use conex_doc_collab::W6_A_S_PACKAGE_ID`）。
pub use a_blk_skeleton::{
    W6_A_S_A_BLK_FAMILY, W6_A_S_A_BLK_SCENARIOS, W6_A_S_NOT_CLOSING, W6_A_S_PACKAGE_ID,
    W6_A_S_TRACK,
};
/// W6-D-S 包锚 re-export（调度 / 集成测可 `use conex_doc_collab::W6_D_S_PACKAGE_ID`）。
pub use a_col_skeleton::{
    W6_D_S_A_COL_01_SCENARIOS, W6_D_S_A_COL_SUBSET, W6_D_S_NOT_CLOSING, W6_D_S_PACKAGE_ID,
    W6_D_S_TRACK,
};
pub use block_id::{block_id_from_comment, block_id_to_comment, BlockId};
pub use events::{BlockUpsert, DocEvent, ProjectionDiff};
pub use harness::{DualSessionHarness, PeerSide, SimplifiedEncodedOps};
pub use ir::{
    cmp_order, pending_turn_into_kind, BlockKind, BlockNode, BlockProps, BlockTree,
    PENDING_TURN_INTO_FLAVOUR_ATTR,
};
pub use op::{ops_from_json, ops_from_json_str, ops_to_json, ops_to_json_string, Op, Origin};
pub use persistence::{CommitBatch, EncodedUpdate, HydrateBlob, PersistError, PersistencePlugin};
pub use session::{
    partition_utf8, ApplyError, DocSession, HydrateError, TextUpdatePayload, UndoError,
    DEFAULT_T_HUGE, DEFAULT_T_SEGMENT, MAX_T_HUGE, MIN_T_HUGE,
};
/// H1 / A-MEM-01：默认热集上界（活动 YText 实例数）；见 `plans/acceptance/perf-baseline.md`。
pub use text_engine::DEFAULT_MAX_HOT;
pub use tx::{TxGuard, TxId};

/// A-INV-09 文档锚点（测试与门禁引用此模块路径）。
///
/// a: 同批提交/回滚 · b: checkpoint 同源 · c: 删块释放叶子
pub mod a_inv_09 {
    pub const A_INV_09A: &str = "A-INV-09a";
    pub const A_INV_09B: &str = "A-INV-09b";
    pub const A_INV_09C: &str = "A-INV-09c";
}

/// A-HUGE 文档锚点（M2 超长单块；测试引用此模块路径）。
///
/// 01: 亚阈保持单叶 · 02: 超阈同事务分段或整批失败（零半树）
pub mod a_huge {
    pub const A_HUGE_01: &str = "A-HUGE-01";
    pub const A_HUGE_02: &str = "A-HUGE-02";
}

/// A-MEM 文档锚点（H1 热集/冷藏；结构门可执行常量见 [`DEFAULT_MAX_HOT`]）。
///
/// **A-MEM-04**（W1-U）：跨冷 undo 契约测见
/// `session::tests::a_mem_04_undo_across_cold_restores_structure_and_plain_text`；
/// reheat 烟雾测 `a_mem_reheat_*` **不得**冒充本 ID。
///
/// 01: 活动 YText ≤ max_hot（默认 512）· 02: 冷可读 · 03: 远端不丢
/// 04: undo 跨冷 — 结构正确 + 文本 plain 快照恢复（细粒度 yrs 史允许截断）
pub mod a_mem {
    pub const A_MEM_01: &str = "A-MEM-01";
    pub const A_MEM_02: &str = "A-MEM-02";
    pub const A_MEM_03: &str = "A-MEM-03";
    /// 跨冷 undo 契约（W1-U / 01 §1.6）；测路径见模块文档。
    pub const A_MEM_04: &str = "A-MEM-04";

    /// 与 crate 根 [`super::DEFAULT_MAX_HOT`] 同值（门禁/文档引用本路径亦可）。
    pub const DEFAULT_MAX_HOT: usize = super::DEFAULT_MAX_HOT;
}

/// A-COL 文档锚点（协同；本 crate 心侧子集）。
///
/// - **A-COL-01**（**W6-D-S** Skeleton）：in-process 双 peer 子集；
///   测见 `tests/a_col_dual_peer.rs` / `tests/a_col_subset_skeleton.rs`；
///   包锚 [`crate::a_col_skeleton`]；**≠ W6-D** / **≠ EL-04**。
/// - **A-COL-04**（W1-U）：[`DocSession::undo`] 按 `Option<Origin>` 过滤；
///   测见 `session::tests::a_col_04_undo_origin_filter`。
///
/// 01: 双 peer 最终一致方向（W6-D-S 子集；满语义属 W6-D / EL-04）
/// 04: origin 可区分；undo 可按 origin 过滤（栈顶不匹配 → OriginMismatch，不误撤）
pub mod a_col {
    /// 双 peer 最终一致（结构 id + 文本）；**满语义**属 W6-D，本 crate Skeleton 见 [`crate::a_col_skeleton`]。
    pub const A_COL_01: &str = "A-COL-01";
    pub const A_COL_04: &str = "A-COL-04";
}

/// A-PERF-DEG 文档锚点（H3 退化治理；数值比较见 `plans/acceptance/perf-baseline.md`）。
///
/// DEG-01: p95≥2× 或 p50≥1.5× 连续 3 次 → A-SWAP 评估
pub mod a_perf {
    pub const A_PERF_DEG_01: &str = "A-PERF-DEG-01";
}
