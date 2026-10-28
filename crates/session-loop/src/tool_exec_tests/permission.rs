use super::super::*;
use super::approval_fixture::*;
use super::fixture::*;
use agent_tools::permission::PermissionMode;
use agent_tools::registry::ToolRegistry;
use conex_agents::capability::CapabilityCell;
use conex_agents::task::SubagentCapabilityMode;
use conex_types::tool::ToolConcurrency;
use std::sync::Arc;

#[tokio::test]
async fn permission_ask_mode_routes_only_dangerous_to_approval() {
    let reg = registry_with(vec![Arc::new(DangerousTool), Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![
        call("c1", "dangerous_tool", ToolConcurrency::Parallel),
        call("c2", "echo", ToolConcurrency::Parallel),
    ];
    let opts = ToolBatchOptions {
        permission_mode: Some(PermissionMode::Ask),
        ..Default::default()
    };
    let order = Arc::new(std::sync::Mutex::new(Vec::new()));
    let gate = Arc::new(RecordingApproval {
        order: Arc::clone(&order),
    });
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(gate), &opts, None)
        .await;
    // 仅 dangerous 项发起审批；echo 直接执行
    assert_eq!(*order.lock().unwrap(), vec!["c1".to_string()]);
    assert!(out.results.iter().all(|r| r.is_ok()));
    // approval-requested 事件仅对应危险项
    let approvals: Vec<&str> = out
        .events
        .iter()
        .filter_map(|e| match e {
            ToolEvent::ApprovalRequested { call_id, .. } => Some(call_id.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(approvals, vec!["c1"]);
}

/// T10 消费 dangerous：ask 模式危险项被用户拒绝 → UserDenied 不执行
#[tokio::test]
async fn permission_ask_mode_denied_dangerous_skips_execution() {
    let reg = registry_with(vec![Arc::new(DangerousTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "dangerous_tool", ToolConcurrency::Sequential)];
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
}

/// T10 消费 dangerous：smart 模式写类（dangerous）工具需审批；安全工具直接放行
#[tokio::test]
async fn permission_smart_mode_routes_dangerous_to_approval() {
    let reg = registry_with(vec![Arc::new(DangerousTool), Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![
        call("c1", "dangerous_tool", ToolConcurrency::Sequential),
        call("c2", "echo", ToolConcurrency::Sequential),
    ];
    let opts = ToolBatchOptions {
        permission_mode: Some(PermissionMode::Smart),
        ..Default::default()
    };
    let order = Arc::new(std::sync::Mutex::new(Vec::new()));
    let gate = Arc::new(RecordingApproval {
        order: Arc::clone(&order),
    });
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(gate), &opts, None)
        .await;
    // Smart 模式：危险工具发起审批，通过后执行；安全工具直接放行
    assert_eq!(*order.lock().unwrap(), vec!["c1".to_string()]);
    assert!(out.results[0].is_ok());
    assert!(out.results[1].is_ok());
    assert!(out
        .events
        .iter()
        .any(|e| matches!(e, ToolEvent::ApprovalRequested { call_id, .. } if call_id == "c1")));
    assert!(out.fatal.is_none());
}

/// T10 消费 dangerous：smart 模式下危险工具被用户拒绝 → UserDenied 且不执行
#[tokio::test]
async fn permission_smart_mode_denied_dangerous_skips_execution() {
    let reg = registry_with(vec![Arc::new(DangerousTool), Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![
        call("c1", "dangerous_tool", ToolConcurrency::Sequential),
        call("c2", "echo", ToolConcurrency::Sequential),
    ];
    let opts = ToolBatchOptions {
        permission_mode: Some(PermissionMode::Smart),
        ..Default::default()
    };
    let gate = MockApproval {
        decision: ApprovalDecision::Denied {
            reason: "denied by user".into(),
        },
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
        .await;
    assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::UserDenied));
    assert!(out.results[1].is_ok());
    assert!(out.fatal.is_none());
}

/// T10 消费 dangerous：smart 模式并行组——危险项走审批，安全项并行执行
#[tokio::test]
async fn permission_smart_parallel_routes_dangerous_runs_safe() {
    let reg = registry_with(vec![Arc::new(DangerousTool), Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![
        call("c1", "dangerous_tool", ToolConcurrency::Parallel),
        call("c2", "echo", ToolConcurrency::Parallel),
        call("c3", "echo", ToolConcurrency::Sequential),
    ];
    let opts = ToolBatchOptions {
        permission_mode: Some(PermissionMode::Smart),
        ..Default::default()
    };
    let order = Arc::new(std::sync::Mutex::new(Vec::new()));
    let gate = Arc::new(RecordingApproval {
        order: Arc::clone(&order),
    });
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(gate), &opts, None)
        .await;
    // Smart 模式下危险项触发审批，安全项直接放行
    assert_eq!(*order.lock().unwrap(), vec!["c1".to_string()]);
    assert!(out.results[0].is_ok());
    assert!(out.results[1].is_ok());
    assert!(out.results[2].is_ok());
    assert!(out.fatal.is_none());
}

/// T10 消费 dangerous：full 模式危险工具直接放行（无审批）
#[tokio::test]
async fn permission_full_access_allows_dangerous_tools() {
    let reg = registry_with(vec![Arc::new(DangerousTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "dangerous_tool", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        permission_mode: Some(PermissionMode::Full),
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;
    assert!(out.results[0].is_ok(), "full 放行危险工具");
    assert!(!out
        .events
        .iter()
        .any(|e| matches!(e, ToolEvent::ApprovalRequested { .. })));
}

/// T10：显式 ask 模式但无审批门 → 危险项透传需审批状态（不静默执行）
#[tokio::test]
async fn permission_ask_without_gate_passes_through_approval_required() {
    let reg = registry_with(vec![Arc::new(DangerousTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "dangerous_tool", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        permission_mode: Some(PermissionMode::Ask),
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;
    assert_eq!(
        out.results[0].error_kind,
        Some(ToolErrorKind::ApprovalRequired),
        "无审批基础设施时不应静默执行危险工具"
    );
}

// ── W4-B：笔记写工具经 session-loop 审批矩阵接线 ──────────────────

/// W4-B：smart 模式对真实 `document_apply_md` 发起审批（通过后执行至 backend）
#[tokio::test]
async fn w4b_smart_mode_routes_document_apply_md_to_approval() {
    use agent_tools::register_builtin_tools;
    let mut reg = ToolRegistry::new();
    register_builtin_tools(&mut reg).expect("register builtins");
    let exec = ToolExecutor::new(Arc::new(reg));
    let calls = vec![ToolBatchCall {
        id: "c-note-write".into(),
        tool_name: "document_apply_md".into(),
        summary: "note write".into(),
        input: serde_json::json!({ "doc_id": "d", "markdown": "x" }),
        category: conex_types::tool::ToolCategory::Internal,
        concurrency: ToolConcurrency::Sequential,
    }];
    let opts = ToolBatchOptions {
        permission_mode: Some(PermissionMode::Smart),
        ..Default::default()
    };
    let order = Arc::new(std::sync::Mutex::new(Vec::new()));
    let gate = Arc::new(RecordingApproval {
        order: Arc::clone(&order),
    });
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(gate), &opts, None)
        .await;
    // Smart 模式：笔记写工具属于 dangerous，必须触发审批；审批通过后进入工具执行（unwired backend）
    assert_eq!(*order.lock().unwrap(), vec!["c-note-write".to_string()]);
    assert!(
        out.results[0].error_kind.is_none(),
        "审批通过后不应报权限错误：{:?}",
        out.results[0]
    );
    assert_eq!(out.results[0].output["ok"], false);
    assert_eq!(out.results[0].output["reason"], "note_backend_unwired");
    assert!(out.events.iter().any(
        |e| matches!(e, ToolEvent::ApprovalRequested { call_id, .. } if call_id == "c-note-write")
    ));
    assert!(out.fatal.is_none());
}

/// W4-B：smart 模式放行笔记只读 `query_blocks`（safe 边界，无需审批）
#[tokio::test]
async fn w4b_smart_mode_allows_query_blocks_safe() {
    use agent_tools::register_builtin_tools;
    let mut reg = ToolRegistry::new();
    register_builtin_tools(&mut reg).expect("register builtins");
    let exec = ToolExecutor::new(Arc::new(reg));
    let calls = vec![ToolBatchCall {
        id: "c-note-read".into(),
        tool_name: "query_blocks".into(),
        summary: "note read".into(),
        input: serde_json::json!({ "doc_id": "d" }),
        category: conex_types::tool::ToolCategory::Internal,
        concurrency: ToolConcurrency::Sequential,
    }];
    let opts = ToolBatchOptions {
        permission_mode: Some(PermissionMode::Smart),
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;
    // Smart 模式下只读应执行且无需审批（未接线 backend → ok=false unwired，非 user_denied）
    assert!(
        out.results[0].error_kind.is_none(),
        "Smart 模式不得拒 safe 读：{:?}",
        out.results[0]
    );
    let out_val = &out.results[0].output;
    assert_eq!(out_val["ok"], false);
    assert_eq!(out_val["reason"], "note_backend_unwired");
}

/// W4-B：ask 模式 + 用户拒绝 → document_apply_md 得 user_denied
#[tokio::test]
async fn w4b_ask_mode_denied_document_apply_md_user_denied() {
    use agent_tools::register_builtin_tools;
    let mut reg = ToolRegistry::new();
    register_builtin_tools(&mut reg).expect("register builtins");
    let exec = ToolExecutor::new(Arc::new(reg));
    let calls = vec![ToolBatchCall {
        id: "c-note-deny".into(),
        tool_name: "document_apply_md".into(),
        summary: "note write denied".into(),
        input: serde_json::json!({ "doc_id": "d", "markdown": "blocked" }),
        category: conex_types::tool::ToolCategory::Internal,
        concurrency: ToolConcurrency::Sequential,
    }];
    let opts = ToolBatchOptions {
        permission_mode: Some(PermissionMode::Ask),
        ..Default::default()
    };
    let gate = MockApproval {
        decision: ApprovalDecision::Denied {
            reason: "user said no notes".into(),
        },
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
        .await;
    assert_eq!(
        out.results[0].error_kind,
        Some(ToolErrorKind::UserDenied),
        "ask 拒绝 → user_denied：{:?}",
        out.results[0]
    );
    assert!(
        out.results[0]
            .error_message
            .as_deref()
            .unwrap_or_default()
            .contains("user said no notes")
            || out.results[0]
                .error_message
                .as_deref()
                .unwrap_or_default()
                .contains("user denied")
    );
    assert!(out.fatal.is_none());
}

/// T10 集成：dangerous shell 工具经权限判定进入审批（Approved 后执行），
/// ApprovalChannel 的审批事件进入批事件流
#[tokio::test]
async fn permission_ask_mode_approval_channel_events_in_batch_stream() {
    let reg = registry_with(vec![Arc::new(DangerousTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "dangerous_tool", ToolConcurrency::Sequential)];
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
    assert!(out.results[0].is_ok());
    // 事件顺序契约：tool-start → approval-requested → tool-end
    let start = out
        .events
        .iter()
        .position(|e| matches!(e, ToolEvent::ToolStart { call_id, .. } if call_id == "c1"))
        .unwrap();
    let approval = out
        .events
        .iter()
        .position(|e| matches!(e, ToolEvent::ApprovalRequested { call_id, .. } if call_id == "c1"))
        .unwrap();
    let end = out
        .events
        .iter()
        .position(|e| matches!(e, ToolEvent::ToolEnd { call_id, .. } if call_id == "c1"))
        .unwrap();
    assert!(start < approval && approval < end, "审批事件顺序契约被破坏");
}

/// 能力 gate：只读子代理调用写类工具 → PolicyBlocked；父级授权后同 run 可写
#[tokio::test]
async fn capability_gate_blocks_write_until_granted() {
    let reg = registry_with(vec![Arc::new(DangerousTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "dangerous_tool", ToolConcurrency::Sequential)];
    let capability = CapabilityCell::root(SubagentCapabilityMode::ReadOnly);
    let opts = ToolBatchOptions {
        permission_mode: Some(PermissionMode::Full),
        capability_cell: Some(Arc::clone(&capability)),
        ..Default::default()
    };

    let denied = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;
    assert_eq!(
        denied.results[0].error_kind,
        Some(ToolErrorKind::PolicyBlocked)
    );
    assert!(
        denied.results[0]
            .error_message
            .as_deref()
            .unwrap_or_default()
            .contains("agent.capability_denied"),
        "拒绝必须带结构化能力错误"
    );

    // 运行中授权（下一批次生效）
    capability.set(SubagentCapabilityMode::ReadWrite);
    let allowed = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;
    assert!(allowed.results[0].is_ok(), "授权后同 run 内应可写");
}
