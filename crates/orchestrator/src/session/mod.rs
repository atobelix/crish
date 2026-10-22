//! 会话树与 conversation-rewind 计划（任务书 B4.3）
//!
//! - [SessionTree]：会话树——追加（append 新分支）、分叉（fork：从某节点
//!   派生新叶子）、叶子移动（move_leaf：当前叶子指针迁移，含
//!   expected_current_leaf 乐观校验）、分支放弃摘要（abandon_branch_
//!   with_summary），并对齐 packages/agent-orchestrator/src/session-tree.ts
//!   的校验语义（重复 id / 父先于子 / 环检测防御）；
//! - [SessionRecord]：会话记录（session_id / 当前叶子 id / 分支列表），
//!   供快照与重启恢复使用；
//! - conversation-rewind 计划（05 §5.4 rewind::plan，
//!   conversation-rewind.test.ts:14 语义）：按「取消 run → 清审批 →
//!   恢复检查点 → 移动叶子」的顺序产出 [RewindPlan]，并提供
//!   [execute_rewind] 执行骨架（审批清理由上层配合，见 [RewindExecutor]）。
//!
//! 语义来源：05-test-mapping.md §5.4 session::tree / rewind::plan、
//! §2.8 orchestrator.test.ts:813（叶子移动经 session-leaf-moved 事件
//! 持久化）。

mod record;
mod rewind_exec;
mod rewind_plan;
mod time;
mod tree;

pub use record::{
    session_leaf_moved_payload, SessionRecord, SessionTreeEntry, SessionTreeEntryKind,
    SessionTreeError, CONTEXT_COMPRESSION_END_EVENT, SESSION_LEAF_MOVED_EVENT,
};
pub use rewind_exec::{execute_rewind, RewindExecutor};
pub use rewind_plan::{
    plan_conversation_rewind, PlanRewindInput, RewindActiveSubagent, RewindApprovalClearance,
    RewindCheckpointSource, RewindCheckpointTarget, RewindError, RewindPendingApproval, RewindPlan,
    RewindRestorePolicy, RewindRunCancellation, RewindRunInfo, RewindRunRole, RewindStep,
    RewindWorkspaceRestore, REWIND_CANCEL_REASON,
};
#[cfg(test)]
pub(crate) use time::parse_iso8601_epoch_ms;
pub use tree::SessionTree;

#[cfg(test)]
mod tests;
