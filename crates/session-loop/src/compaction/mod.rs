//! 上下文压缩与不可变决策账本模块 (Compaction & Pinned Decision Ledger)
//!
//! 承载 `continuous-execution-hardening` 战役中关于上下文金字塔、不可变决策账本与
//! KV Cache 前缀不变性的核心实现：
//! - `decision_ledger`: Slot 2.2 不可变决策账本，跨代绝对不折叠核心决策；
//! - `template`: Slot 2 全局锚定与中性 Stub 模板；
//! - `invariance`: KV Cache 缓存绝对不变性守卫（废除 In-Flight Hot-Swap）。

pub mod decision_ledger;
pub mod invariance;
pub mod template;

pub use decision_ledger::{
    DecisionCategory, DecisionLedgerEntry, PinnedDecisionLedger, MAX_DECISION_LEDGER_TOKENS,
    PINNED_LEDGER_MESSAGE_ID,
};
pub use invariance::{CacheInvarianceGuard, InFlightSwapForbiddenError};
pub use template::{render_neutral_stub, render_slot2_global_anchor};
