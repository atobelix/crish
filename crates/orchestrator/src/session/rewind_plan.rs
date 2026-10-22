use std::collections::HashSet;
use std::fmt;

use conex_db::RunStatus;

use crate::run::RunStateMachine;

use super::{SessionTree, SessionTreeEntry, SessionTreeError};

// ===== conversation-rewind 计划（05 §5.4 rewind::plan） =====

/// conversation-rewind 取消 / 清审批 reason（conversation-rewind.test.ts:17 语义）
pub const REWIND_CANCEL_REASON: &str = "conversation-rewind";

/// 被取消 run 的角色（conversation-rewind.ts ConversationRewindRunCancellation）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RewindRunRole {
    /// 会话主 run
    SessionRun,
    /// 子 agent run
    SubagentRun,
}

/// 需取消的 run
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RewindRunCancellation {
    /// run id
    pub run_id: String,
    /// 角色（会话 run / 子 agent run）
    pub role: RewindRunRole,
}

/// 需清除的挂起审批（取消 run 后由上层配合发出 approval-resolved）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RewindApprovalClearance {
    /// 审批对应的工具调用 id
    pub tool_call_id: String,
    /// 审批所属 run id
    pub run_id: String,
}

/// 工作区恢复来源
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RewindCheckpointSource {
    /// 无需恢复
    None,
    /// 运行时清单检查点
    RuntimeManifest,
    /// git 检查点
    GitCheckpoint,
}

/// 工作区恢复计划（conversation-rewind.ts ConversationRewindWorkspaceRestore）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RewindWorkspaceRestore {
    /// 是否必须恢复
    pub required: bool,
    /// 恢复来源（None = 不恢复）
    pub source: RewindCheckpointSource,
    /// 运行时检查点 id（RuntimeManifest）
    pub checkpoint_id: Option<String>,
    /// 清单路径（RuntimeManifest）
    pub manifest_path: Option<String>,
    /// git 检查点引用（GitCheckpoint）
    pub checkpoint: Option<String>,
    /// 是否清理未跟踪文件（GitCheckpoint）
    pub clean_untracked: bool,
}

/// rewind 执行步骤（顺序：取消 run → 清审批 → 恢复检查点 → 移动叶子）
#[derive(Debug, Clone, PartialEq)]
pub enum RewindStep {
    /// 取消非终态 run
    CancelRuns(Vec<RewindRunCancellation>),
    /// 清除已取消 run 的挂起审批
    ClearApprovals(Vec<RewindApprovalClearance>),
    /// 恢复工作区检查点
    RestoreWorkspace(RewindWorkspaceRestore),
    /// 移动会话叶子到目标（持久化 session-leaf-moved 事件）
    MoveSessionLeaf {
        /// 会话 id
        session_id: String,
        /// 原叶子 id
        from_leaf_id: Option<String>,
        /// 目标叶子 id
        to_leaf_id: Option<String>,
    },
}

impl RewindStep {
    /// 步骤类型名（测试断言用）
    pub fn type_name(&self) -> &'static str {
        match self {
            Self::CancelRuns(_) => "cancel-runs",
            Self::ClearApprovals(_) => "clear-approvals",
            Self::RestoreWorkspace(_) => "restore-workspace",
            Self::MoveSessionLeaf { .. } => "move-session-leaf",
        }
    }
}

/// conversation-rewind 计划（conversation-rewind.ts ConversationRewindPlan）
#[derive(Debug, Clone, PartialEq)]
pub struct RewindPlan {
    /// 会话 id
    pub session_id: String,
    /// 当前（原）叶子 id
    pub from_leaf_id: Option<String>,
    /// 目标叶子 id
    pub target_leaf_id: Option<String>,
    /// 目标分支路径（根 → 目标叶子；目标为 None 时为空）
    pub target_path: Vec<SessionTreeEntry>,
    /// 按「取消 run → 清审批 → 恢复检查点 → 移动叶子」排序的执行步骤
    pub steps: Vec<RewindStep>,
}

/// 计划输入的 run 信息（供非终态判定）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RewindRunInfo {
    /// run id
    pub run_id: String,
    /// 会话 id
    pub session_id: String,
    /// 当前状态
    pub status: RunStatus,
}

/// 计划输入的活动子 agent
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RewindActiveSubagent {
    /// 子 agent run id
    pub subagent_run_id: String,
    /// 父 run id
    pub parent_run_id: String,
}

/// 计划输入的挂起审批
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RewindPendingApproval {
    /// 工具调用 id
    pub tool_call_id: String,
    /// 所属 run id
    pub run_id: String,
}

/// 检查点目标（conversation-rewind.ts ConversationRewindCheckpointTarget）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RewindCheckpointTarget {
    /// 运行时清单检查点
    RuntimeManifest {
        /// 检查点 id
        checkpoint_id: String,
        /// 清单路径
        manifest_path: Option<String>,
    },
    /// git 检查点
    GitCheckpoint {
        /// git 引用
        checkpoint: String,
        /// 是否清理未跟踪文件
        clean_untracked: bool,
    },
}

/// 工作区恢复策略（conversation-rewind.ts ConversationRewindRestorePolicy）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RewindRestorePolicy {
    /// 有检查点就恢复，没有则跳过
    IfPresent,
    /// 必须有检查点（缺失时报错）
    Required,
    /// 跳过工作区恢复（纯树回退）
    Skip,
}

/// rewind 计划 / 执行错误
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RewindError {
    /// 错误类别（如 store.write_failed，对齐 R6 迁移码）
    pub kind: String,
    /// 错误详情
    pub message: String,
}

impl RewindError {
    /// 构造错误
    pub fn new(kind: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            message: message.into(),
        }
    }
}

impl fmt::Display for RewindError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.kind, self.message)
    }
}

impl std::error::Error for RewindError {}

impl From<SessionTreeError> for RewindError {
    fn from(err: SessionTreeError) -> Self {
        Self::new("session.invalid_state", err.to_string())
    }
}

/// rewind 计划输入
pub struct PlanRewindInput<'a> {
    /// 当前会话树（提供会话 id、当前叶子与条目）
    pub session: &'a SessionTree,
    /// 目标叶子 id（None = 根前位置）
    pub target_leaf_id: Option<&'a str>,
    /// 全部 run 记录（跨会话，按会话过滤）
    pub runs: &'a [RewindRunInfo],
    /// 活动子 agent 列表
    pub active_subagents: &'a [RewindActiveSubagent],
    /// 挂起审批列表
    pub pending_approvals: &'a [RewindPendingApproval],
    /// 检查点目标（None = 无检查点）
    pub checkpoint: Option<&'a RewindCheckpointTarget>,
    /// 工作区恢复策略
    pub restore_policy: RewindRestorePolicy,
}

/// 编制 conversation-rewind 计划（05 §5.4 rewind::plan）
///
/// 步骤顺序固定：取消 run → 清审批 → 恢复检查点 → 移动叶子
/// （conversation-rewind.test.ts:52 语义）；空步骤省略；目标与当前
/// 叶子相同则省略移动步骤。
///
/// 语义对齐 conversation-rewind.ts planConversationRewind：
/// - 只取消本会话的非终态 run（含其活动子 agent run）；
/// - 审批清除只针对「被取消 run」的挂起审批；
/// - 恢复策略 required 且无检查点 → 报错（store.write_failed，R6 迁移码）。
pub fn plan_conversation_rewind(input: &PlanRewindInput) -> Result<RewindPlan, RewindError> {
    // 目标分支路径（None = 空路径）
    let target_path = input.session.read_branch_path(input.target_leaf_id)?;

    // 1. 取消计划：本会话非终态 run + 其活动子 agent run
    let active_session_run_ids: HashSet<String> = input
        .runs
        .iter()
        .filter(|run| {
            run.session_id == input.session.session_id
                && !RunStateMachine::new(run.status.clone()).is_terminal()
        })
        .map(|run| run.run_id.clone())
        .collect();
    let mut cancellations: Vec<RewindRunCancellation> = Vec::new();
    let mut cancelled_ids = HashSet::new();
    for run in input.runs {
        if run.session_id != input.session.session_id {
            continue;
        }
        if !RunStateMachine::new(run.status.clone()).is_terminal() {
            cancellations.push(RewindRunCancellation {
                run_id: run.run_id.clone(),
                role: RewindRunRole::SessionRun,
            });
            cancelled_ids.insert(run.run_id.clone());
        }
    }
    for subagent in input.active_subagents {
        if !active_session_run_ids.contains(&subagent.parent_run_id) {
            continue;
        }
        // 子 agent run 本身已终态则跳过（无 run 记录时仍按活动处理）
        let terminal = input
            .runs
            .iter()
            .find(|run| run.run_id == subagent.subagent_run_id)
            .map(|run| RunStateMachine::new(run.status.clone()).is_terminal())
            .unwrap_or(false);
        if terminal {
            continue;
        }
        if cancelled_ids.insert(subagent.subagent_run_id.clone()) {
            cancellations.push(RewindRunCancellation {
                run_id: subagent.subagent_run_id.clone(),
                role: RewindRunRole::SubagentRun,
            });
        }
    }

    // 2. 审批清除：只针对被取消 run 的挂起审批
    let approval_clearances: Vec<RewindApprovalClearance> = input
        .pending_approvals
        .iter()
        .filter(|approval| cancelled_ids.contains(&approval.run_id))
        .map(|approval| RewindApprovalClearance {
            tool_call_id: approval.tool_call_id.clone(),
            run_id: approval.run_id.clone(),
        })
        .collect();

    // 3. 工作区恢复计划
    let workspace_restore = plan_workspace_restore(input.checkpoint, input.restore_policy)?;

    // 4. 步骤排序（取消 → 清审批 → 恢复检查点 → 移动叶子）
    let from_leaf_id = input.session.current_leaf_id.clone();
    let target_leaf_id = input.target_leaf_id.map(str::to_string);
    let mut steps = Vec::new();
    if !cancellations.is_empty() {
        steps.push(RewindStep::CancelRuns(cancellations));
    }
    if !approval_clearances.is_empty() {
        steps.push(RewindStep::ClearApprovals(approval_clearances));
    }
    if workspace_restore.source != RewindCheckpointSource::None {
        steps.push(RewindStep::RestoreWorkspace(workspace_restore));
    }
    if from_leaf_id != target_leaf_id {
        steps.push(RewindStep::MoveSessionLeaf {
            session_id: input.session.session_id.clone(),
            from_leaf_id: from_leaf_id.clone(),
            to_leaf_id: target_leaf_id.clone(),
        });
    }

    Ok(RewindPlan {
        session_id: input.session.session_id.clone(),
        from_leaf_id,
        target_leaf_id,
        target_path,
        steps,
    })
}

/// 工作区恢复计划（conversation-rewind.ts planWorkspaceRestore 语义）
fn plan_workspace_restore(
    checkpoint: Option<&RewindCheckpointTarget>,
    policy: RewindRestorePolicy,
) -> Result<RewindWorkspaceRestore, RewindError> {
    if policy == RewindRestorePolicy::Skip {
        return Ok(RewindWorkspaceRestore {
            required: false,
            source: RewindCheckpointSource::None,
            checkpoint_id: None,
            manifest_path: None,
            checkpoint: None,
            clean_untracked: false,
        });
    }
    let checkpoint = match checkpoint {
        Some(target) => target,
        None if policy == RewindRestorePolicy::Required => {
            return Err(RewindError::new(
                "store.write_failed",
                "conversation-rewind 需要工作区检查点（restorePolicy=required）",
            ));
        }
        None => {
            return Ok(RewindWorkspaceRestore {
                required: false,
                source: RewindCheckpointSource::None,
                checkpoint_id: None,
                manifest_path: None,
                checkpoint: None,
                clean_untracked: false,
            });
        }
    };
    match checkpoint {
        RewindCheckpointTarget::RuntimeManifest {
            checkpoint_id,
            manifest_path,
        } => Ok(RewindWorkspaceRestore {
            required: true,
            source: RewindCheckpointSource::RuntimeManifest,
            checkpoint_id: Some(checkpoint_id.clone()),
            manifest_path: manifest_path.clone(),
            checkpoint: None,
            clean_untracked: false,
        }),
        RewindCheckpointTarget::GitCheckpoint {
            checkpoint,
            clean_untracked,
        } => Ok(RewindWorkspaceRestore {
            required: true,
            source: RewindCheckpointSource::GitCheckpoint,
            checkpoint_id: None,
            manifest_path: None,
            checkpoint: Some(checkpoint.clone()),
            clean_untracked: *clean_untracked,
        }),
    }
}
