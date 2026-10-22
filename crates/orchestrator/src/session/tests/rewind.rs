use conex_db::RunStatus;

use super::*;

// ── conversation-rewind 计划 ──

fn rewind_tree() -> SessionTree {
    let mut t = tree();
    t.append("root", json!({})).unwrap();
    t.append("leaf_target", json!({})).unwrap();
    t.move_leaf(Some("root"), None).unwrap();
    t.append("leaf_current", json!({})).unwrap();
    t
}

fn run(id: &str, session_id: &str, status: RunStatus) -> RewindRunInfo {
    RewindRunInfo {
        run_id: id.to_string(),
        session_id: session_id.to_string(),
        status,
    }
}

/// 计划步骤顺序：取消 run → 清审批 → 恢复检查点 → 移动叶子
/// （conversation-rewind.test.ts:14 语义）
#[test]
fn rewind_plan_steps_in_documented_order() {
    let session = rewind_tree();
    let plan = plan_conversation_rewind(&PlanRewindInput {
        session: &session,
        target_leaf_id: Some("leaf_target"),
        runs: &[
            run("run_active", "session_a", RunStatus::AwaitingApproval),
            run("run_done", "session_a", RunStatus::Completed),
            run("run_other", "session_b", RunStatus::Running),
            run("run_sub", "session_sub", RunStatus::Running),
        ],
        active_subagents: &[RewindActiveSubagent {
            subagent_run_id: "run_sub".to_string(),
            parent_run_id: "run_active".to_string(),
        }],
        pending_approvals: &[
            RewindPendingApproval {
                tool_call_id: "approval_active".to_string(),
                run_id: "run_active".to_string(),
            },
            RewindPendingApproval {
                tool_call_id: "approval_other".to_string(),
                run_id: "run_other".to_string(),
            },
            RewindPendingApproval {
                tool_call_id: "approval_sub".to_string(),
                run_id: "run_sub".to_string(),
            },
        ],
        checkpoint: Some(&RewindCheckpointTarget::GitCheckpoint {
            checkpoint: "git_checkpoint_1".to_string(),
            clean_untracked: false,
        }),
        restore_policy: RewindRestorePolicy::IfPresent,
    })
    .unwrap();

    assert_eq!(plan.from_leaf_id.as_deref(), Some("leaf_current"));
    let path: Vec<&str> = plan.target_path.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(path, vec!["root", "leaf_target"]);
    // 只取消本会话非终态 run 及其活动子 agent run
    let cancellations = match &plan.steps[0] {
        RewindStep::CancelRuns(runs) => runs,
        other => panic!("第一步应为 cancel-runs：{other:?}"),
    };
    let cancelled: Vec<&str> = cancellations.iter().map(|r| r.run_id.as_str()).collect();
    assert_eq!(cancelled, vec!["run_active", "run_sub"]);
    // 审批清除只针对被取消的 run（approval_other 属于 run_other，不在本会话）
    let clearances = match &plan.steps[1] {
        RewindStep::ClearApprovals(approvals) => approvals,
        other => panic!("第二步应为 clear-approvals：{other:?}"),
    };
    let cleared: Vec<&str> = clearances.iter().map(|a| a.tool_call_id.as_str()).collect();
    assert_eq!(cleared, vec!["approval_active", "approval_sub"]);
    // 步骤顺序断言
    let step_types: Vec<&str> = plan.steps.iter().map(|s| s.type_name()).collect();
    assert_eq!(
        step_types,
        vec![
            "cancel-runs",
            "clear-approvals",
            "restore-workspace",
            "move-session-leaf"
        ]
    );
}

/// 纯树回退（skip 策略）：只保留移动叶子步骤
/// （conversation-rewind.test.ts:87 语义）
#[test]
fn rewind_plan_skip_policy_keeps_only_leaf_move() {
    let session = rewind_tree();
    let plan = plan_conversation_rewind(&PlanRewindInput {
        session: &session,
        target_leaf_id: Some("leaf_target"),
        runs: &[],
        active_subagents: &[],
        pending_approvals: &[],
        checkpoint: None,
        restore_policy: RewindRestorePolicy::Skip,
    })
    .unwrap();
    let step_types: Vec<&str> = plan.steps.iter().map(|s| s.type_name()).collect();
    assert_eq!(step_types, vec!["move-session-leaf"]);
}

/// required 策略且无检查点 → store.write_failed
/// （conversation-rewind.test.ts:133 语义）
#[test]
fn rewind_plan_required_policy_without_checkpoint_fails() {
    let session = rewind_tree();
    let err = plan_conversation_rewind(&PlanRewindInput {
        session: &session,
        target_leaf_id: Some("leaf_target"),
        runs: &[],
        active_subagents: &[],
        pending_approvals: &[],
        checkpoint: None,
        restore_policy: RewindRestorePolicy::Required,
    })
    .unwrap_err();
    assert_eq!(err.kind, "store.write_failed");
}

/// 目标叶子与当前叶子相同：省略移动步骤（tree-only 场景）
#[test]
fn rewind_plan_omits_move_step_when_target_is_current() {
    let session = rewind_tree();
    let plan = plan_conversation_rewind(&PlanRewindInput {
        session: &session,
        target_leaf_id: Some("leaf_current"),
        runs: &[],
        active_subagents: &[],
        pending_approvals: &[],
        checkpoint: None,
        restore_policy: RewindRestorePolicy::Skip,
    })
    .unwrap();
    assert!(plan.steps.is_empty(), "目标即当前叶子时不产生步骤");
}

/// 目标叶子不存在 → 计划失败（conversation-rewind.test.ts:153 语义）
#[test]
fn rewind_plan_rejects_missing_target() {
    let session = rewind_tree();
    let err = plan_conversation_rewind(&PlanRewindInput {
        session: &session,
        target_leaf_id: Some("missing"),
        runs: &[],
        active_subagents: &[],
        pending_approvals: &[],
        checkpoint: None,
        restore_policy: RewindRestorePolicy::IfPresent,
    })
    .unwrap_err();
    assert_eq!(err.kind, "session.invalid_state");
}

// ── 执行骨架 ──

/// 记录调用顺序的执行器（测试替身）
struct RecordingExecutor {
    calls: std::sync::Mutex<Vec<String>>,
}

impl RecordingExecutor {
    fn new() -> Self {
        Self {
            calls: std::sync::Mutex::new(Vec::new()),
        }
    }
}

#[async_trait::async_trait]
impl RewindExecutor for RecordingExecutor {
    async fn cancel_run(&self, run_id: &str, role: RewindRunRole) -> Result<(), RewindError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("cancel:{run_id}:{role:?}"));
        Ok(())
    }

    async fn clear_approval(&self, clearance: &RewindApprovalClearance) -> Result<(), RewindError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("clear:{}", clearance.tool_call_id));
        Ok(())
    }

    async fn restore_workspace(&self, restore: &RewindWorkspaceRestore) -> Result<(), RewindError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("restore:{:?}", restore.source));
        Ok(())
    }

    async fn move_session_leaf(
        &self,
        session_id: &str,
        to_leaf_id: Option<&str>,
    ) -> Result<(), RewindError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("move:{session_id}:{to_leaf_id:?}"));
        Ok(())
    }
}

/// 执行骨架按计划顺序调用执行器
#[tokio::test]
async fn execute_rewind_calls_executor_in_step_order() {
    let session = rewind_tree();
    let plan = plan_conversation_rewind(&PlanRewindInput {
        session: &session,
        target_leaf_id: Some("leaf_target"),
        runs: &[run("run_active", "session_a", RunStatus::Running)],
        active_subagents: &[],
        pending_approvals: &[RewindPendingApproval {
            tool_call_id: "approval_active".to_string(),
            run_id: "run_active".to_string(),
        }],
        checkpoint: Some(&RewindCheckpointTarget::RuntimeManifest {
            checkpoint_id: "checkpoint_1".to_string(),
            manifest_path: Some("C:/repo/.agent-runtime/checkpoint.json".to_string()),
        }),
        restore_policy: RewindRestorePolicy::IfPresent,
    })
    .unwrap();

    let executor = RecordingExecutor::new();
    execute_rewind(&plan, &executor).await.unwrap();

    let calls = executor.calls.lock().unwrap().clone();
    assert_eq!(
        calls,
        vec![
            "cancel:run_active:SessionRun".to_string(),
            "clear:approval_active".to_string(),
            "restore:RuntimeManifest".to_string(),
            "move:session_a:Some(\"leaf_target\")".to_string(),
        ],
        "执行顺序 = 计划顺序（取消 → 清审批 → 恢复检查点 → 移动叶子）"
    );
}

/// 执行后按计划移动会话叶子（上层配合：持久化事件 + 树更新）
#[tokio::test]
async fn execute_rewind_then_move_session_leaf_on_tree() {
    let session = rewind_tree();
    let plan = plan_conversation_rewind(&PlanRewindInput {
        session: &session,
        target_leaf_id: Some("leaf_target"),
        runs: &[],
        active_subagents: &[],
        pending_approvals: &[],
        checkpoint: None,
        restore_policy: RewindRestorePolicy::Skip,
    })
    .unwrap();

    let mut tree = session;
    let executor = RecordingExecutor::new();
    execute_rewind(&plan, &executor).await.unwrap();
    // 移动叶子步骤：expected_current_leaf = 计划记录的 from_leaf_id
    tree.move_leaf(plan.target_leaf_id.as_deref(), plan.from_leaf_id.as_deref())
        .unwrap();
    assert_eq!(tree.current_leaf_id(), Some("leaf_target"));
}
