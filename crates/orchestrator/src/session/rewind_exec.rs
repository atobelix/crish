use super::{
    RewindApprovalClearance, RewindError, RewindPlan, RewindRunRole, RewindStep,
    RewindWorkspaceRestore,
};

/// rewind 执行器（执行骨架的下层协作接口；审批清理由上层配合：
/// 由上层持有审批分发通道，clear_approval 实现发出 approval-resolved）
#[async_trait::async_trait]
pub trait RewindExecutor: Send + Sync {
    /// 取消一个 run（conversation-rewind reason）
    async fn cancel_run(&self, run_id: &str, role: RewindRunRole) -> Result<(), RewindError>;
    /// 清除一条挂起审批
    async fn clear_approval(&self, clearance: &RewindApprovalClearance) -> Result<(), RewindError>;
    /// 恢复工作区检查点
    async fn restore_workspace(&self, restore: &RewindWorkspaceRestore) -> Result<(), RewindError>;
    /// 移动会话叶子（上层持久化 session-leaf-moved 事件并更新会话树）
    async fn move_session_leaf(
        &self,
        session_id: &str,
        to_leaf_id: Option<&str>,
    ) -> Result<(), RewindError>;
}

/// 按计划顺序执行 rewind 步骤（执行骨架，05 §5.4 rewind::plan：
/// 取消 run → 清审批 → 恢复检查点 → 移动叶子）
///
/// 任一步骤失败立即返回，不继续后续步骤（顺序语义保证：审批清除
/// 必须发生在 run 取消之后，叶子移动发生在工作区恢复之后）。
pub async fn execute_rewind(
    plan: &RewindPlan,
    executor: &dyn RewindExecutor,
) -> Result<(), RewindError> {
    for step in &plan.steps {
        match step {
            RewindStep::CancelRuns(runs) => {
                for run in runs {
                    executor.cancel_run(&run.run_id, run.role).await?;
                }
            }
            RewindStep::ClearApprovals(approvals) => {
                for approval in approvals {
                    executor.clear_approval(approval).await?;
                }
            }
            RewindStep::RestoreWorkspace(restore) => {
                executor.restore_workspace(restore).await?;
            }
            RewindStep::MoveSessionLeaf {
                session_id,
                to_leaf_id,
                ..
            } => {
                executor
                    .move_session_leaf(session_id, to_leaf_id.as_deref())
                    .await?;
            }
        }
    }
    Ok(())
}
