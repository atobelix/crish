use super::super::*;
use super::fixture::*;
use agent_tools::permission::PermissionMode;
use conex_types::tool::{ToolBatchCall, ToolConcurrency};
use std::sync::Arc;

#[derive(Debug)]
struct FixedAreaAssessor(agent_tools::revert::RevertArea);

impl agent_tools::revert::RevertAssessor for FixedAreaAssessor {
    fn assess(
        &self,
        _target: &agent_tools::revert::RevertTarget,
    ) -> agent_tools::revert::RevertArea {
        self.0.clone()
    }
}

fn revert_policy(area: agent_tools::revert::RevertArea) -> agent_tools::revert::RevertPolicy {
    agent_tools::revert::RevertPolicy::default().with_assessor(Arc::new(FixedAreaAssessor(area)))
}

fn large_area() -> agent_tools::revert::RevertArea {
    agent_tools::revert::RevertArea {
        file_count: Some(25),
        line_count: Some(1200),
        cross_directory: true,
        ref_age_seconds: Some(36 * 3600),
    }
}

fn small_area() -> agent_tools::revert::RevertArea {
    agent_tools::revert::RevertArea {
        file_count: Some(2),
        line_count: Some(40),
        cross_directory: false,
        ref_age_seconds: Some(3600),
    }
}

/// 携带命令文本入参的工具调用（C3 判定点从 input.command 取命令）
fn command_call(id: &str, name: &str, command: &str) -> ToolBatchCall {
    ToolBatchCall {
        id: id.into(),
        tool_name: name.into(),
        summary: format!("call {name}"),
        input: serde_json::json!({ "command": command }),
        category: conex_types::tool::ToolCategory::Internal,
        concurrency: ToolConcurrency::Sequential,
    }
}

/// Full 模式语义（用户裁决）：除物理红线外所有命令直接执行——C3 大面积
/// 回退护栏属权限审批层，Full 由 call_verdict 早退放行，不弹审批、不拒绝。
#[tokio::test]
async fn full_access_large_revert_executes_without_gate() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg).with_revert_policy(revert_policy(large_area()));
    let calls = vec![command_call("c1", "echo", "git checkout abc1234")];
    let opts = ToolBatchOptions {
        permission_mode: Some(PermissionMode::Full),
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;
    assert!(
        out.results[0].is_ok(),
        "Full 模式下大面积回退直接执行：{:?}",
        out.results[0]
    );
    assert!(
        !out.events
            .iter()
            .any(|e| matches!(e, ToolEvent::ApprovalRequested { .. })),
        "Full 模式不发起审批"
    );
    assert!(out.fatal.is_none(), "放行不是引擎故障");
}

/// C3 验收 1：ask 模式大面积回退产生审批请求（approval-requested 事件），
/// 审批人 = 用户（门裁决）；Denied → 结构化拒绝、工具不执行
#[tokio::test]
async fn ask_large_revert_denied_after_approval_request() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg).with_revert_policy(revert_policy(large_area()));
    let calls = vec![command_call("c1", "echo", "git reset --hard HEAD~30")];
    let opts = ToolBatchOptions {
        permission_mode: Some(PermissionMode::Ask),
        ..Default::default()
    };
    let gate = MockApproval {
        decision: ApprovalDecision::Denied {
            reason: "no".into(),
        },
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
        .await;
    assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::UserDenied));
    assert!(
        out.events
            .iter()
            .any(|e| matches!(e, ToolEvent::ApprovalRequested { .. })),
        "审批请求必须真实发出（用户裁决入口）"
    );
    assert!(out.fatal.is_none(), "拒绝不崩溃、run 状态正常");
}

/// C3 验收 1 通过路径：用户批准后大面积回退才执行
#[tokio::test]
async fn ask_large_revert_approved_then_executes() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg).with_revert_policy(revert_policy(large_area()));
    let calls = vec![command_call("c1", "echo", "git checkout abc1234")];
    let opts = ToolBatchOptions {
        permission_mode: Some(PermissionMode::Ask),
        ..Default::default()
    };
    let gate = MockApproval {
        decision: ApprovalDecision::Approved,
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
        .await;
    assert!(out.results[0].is_ok(), "用户批准后才执行");
}

/// C3 验收 3：面积低于全部阈值 → full-access 放行（零打扰，无审批事件）
#[tokio::test]
async fn full_access_small_revert_executes_without_approval() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg).with_revert_policy(revert_policy(small_area()));
    let calls = vec![command_call(
        "c1",
        "echo",
        "git restore --source=HEAD~1 src/main.rs",
    )];
    let opts = ToolBatchOptions {
        permission_mode: Some(PermissionMode::Full),
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;
    assert!(out.results[0].is_ok(), "小面积回退零打扰");
    assert!(!out
        .events
        .iter()
        .any(|e| matches!(e, ToolEvent::ApprovalRequested { .. })));
}

/// 分支切换（非回退形态）不被 C3 门禁拦截：full-access 直接执行
#[tokio::test]
async fn checkout_branch_switch_not_gated() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg).with_revert_policy(revert_policy(large_area()));
    let calls = vec![command_call("c1", "echo", "git checkout main")];
    let opts = ToolBatchOptions {
        permission_mode: Some(PermissionMode::Full),
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;
    assert!(out.results[0].is_ok(), "分支切换不是回退，C3 不拦截");
}

/// 无命令文本入参（非命令类工具）不受 C3 门禁影响（既有语义不变）
#[tokio::test]
async fn non_command_input_not_gated() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg).with_revert_policy(revert_policy(large_area()));
    let calls = vec![call("c1", "echo", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        permission_mode: Some(PermissionMode::Full),
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;
    assert!(out.results[0].is_ok(), "非命令入参按既有矩阵放行");
}
