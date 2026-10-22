use super::super::*;
use super::approval_fixture::*;
use super::fixture::*;
use agent_tools::definition::ToolDefinition;
use agent_tools::permission::PermissionMode;
use agent_tools::registry::ToolRegistry;
use conex_types::tool::{ToolBatchCall, ToolConcurrency};
use std::sync::Arc;

// ── T-D-14 权限传递层：子代理审批链路 ──

/// 子代理上下文（有父 run 归属）+ 危险工具入参（含申请理由保留键）
fn subagent_ctx() -> ToolExecCtx {
    ToolExecCtx {
        run_id: "run-sub-1".into(),
        session_id: "sess-1".into(),
        parent_run_id: Some("run-main".into()),
        ..Default::default()
    }
}

/// 申请→主 agent 放行链路：子代理 run 内工具触发 NeedsApproval →
/// gate 收到 requester（run_id = 子代理 run id + reason）→ 主 agent
/// 裁决 Approved → 工具执行成功、approval-requested 事件携带请求方
#[tokio::test]
async fn subagent_approval_flow_reaches_gate_with_requester_and_executes() {
    let reg = registry_with(vec![Arc::new(DangerousTool)]);
    let exec = ToolExecutor::new(reg);
    let received = Arc::new(std::sync::Mutex::new(None));
    let gate = Arc::new(RequesterRecordingApproval {
        decision: ApprovalDecision::Approved,
        received: Arc::clone(&received),
    });
    let calls = vec![ToolBatchCall {
        id: "c1".into(),
        tool_name: "dangerous_tool".into(),
        summary: "子代理越界写".into(),
        input: serde_json::json!({
            "path": "outside.md",
            "approval_reason": "需要写入默认范围外的报告目录",
        }),
        category: conex_types::tool::ToolCategory::Filesystem,
        concurrency: ToolConcurrency::Sequential,
    }];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        permission_mode: Some(PermissionMode::Ask),
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &subagent_ctx(), Some(gate), &opts, None)
        .await;
    // 工具执行成功（主 agent 放行）
    assert!(out.results[0].is_ok(), "结果: {:?}", out.results[0]);
    assert!(out.fatal.is_none());
    // gate 收到 requester：run_id = 子代理 run id + reason
    let requester = received
        .lock()
        .unwrap()
        .clone()
        .expect("gate 必收到 requester");
    assert_eq!(
        requester.run_id, "run-sub-1",
        "requester.run_id 应为子代理 run id"
    );
    assert_eq!(
        requester.reason.as_deref(),
        Some("需要写入默认范围外的报告目录"),
        "requester.reason 应透传申请理由"
    );
    // approval-requested 事件齐全且携带请求方
    let requested = out
        .events
        .iter()
        .find(|e| matches!(e, ToolEvent::ApprovalRequested { .. }))
        .expect("应有 approval-requested 事件");
    match requested {
        ToolEvent::ApprovalRequested { requester, .. } => {
            assert_eq!(
                requester.as_ref().map(|r| r.run_id.as_str()),
                Some("run-sub-1")
            );
            assert_eq!(
                requester.as_ref().and_then(|r| r.reason.as_deref()),
                Some("需要写入默认范围外的报告目录")
            );
        }
        _ => unreachable!(),
    }
}

/// 拒绝路径：主 agent 裁决 Denied → 子代理收到 UserDenied，错误文案
/// 含「主 agent 拒绝」与「回报主 agent」指引（对齐 explore_quota 断言面）
#[tokio::test]
async fn subagent_denied_carries_relay_guidance() {
    let reg = registry_with(vec![Arc::new(DangerousTool)]);
    let exec = ToolExecutor::new(reg);
    let gate = Arc::new(RequesterRecordingApproval {
        decision: ApprovalDecision::Denied {
            reason: "写入范围超出默认集".into(),
        },
        received: Arc::new(std::sync::Mutex::new(None)),
    });
    let calls = vec![ToolBatchCall {
        id: "c1".into(),
        tool_name: "dangerous_tool".into(),
        summary: "子代理越界写".into(),
        input: serde_json::json!({ "path": "outside.md", "approval_reason": "需要越界写入" }),
        category: conex_types::tool::ToolCategory::Filesystem,
        concurrency: ToolConcurrency::Sequential,
    }];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        permission_mode: Some(PermissionMode::Ask),
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &subagent_ctx(), Some(gate), &opts, None)
        .await;
    assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::UserDenied));
    let message = out.results[0].error_message.as_deref().unwrap_or("");
    assert!(message.contains("主 agent 拒绝"), "message: {message}");
    assert!(message.contains("回报主 agent"), "message: {message}");
    assert!(message.contains("写入范围超出默认集"), "message: {message}");
    // 拒绝非致命（run 不中断）
    assert!(out.fatal.is_none());
}

/// 不回归：主 agent run（无父 run）审批 requester=None → 既有
/// 「user denied: …」文案（UI 流程零回归）
#[tokio::test]
async fn main_agent_approval_requester_none_and_legacy_denied_text() {
    let reg = registry_with(vec![Arc::new(DangerousTool)]);
    let exec = ToolExecutor::new(reg);
    let received = Arc::new(std::sync::Mutex::new(None));
    let gate = Arc::new(RequesterRecordingApproval {
        decision: ApprovalDecision::Denied {
            reason: "no".into(),
        },
        received: Arc::clone(&received),
    });
    let calls = vec![call("c1", "dangerous_tool", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        permission_mode: Some(PermissionMode::Ask),
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(gate), &opts, None)
        .await;
    // gate 收到 requester = None（主 agent run 不携带子代理身份）
    assert!(
        received.lock().unwrap().is_none(),
        "主 agent run 审批 requester 应为 None"
    );
    // 既有拒绝文案不变（无「回报主 agent」注入）
    let message = out.results[0].error_message.as_deref().unwrap_or("");
    assert_eq!(message, "user denied: no");
    assert!(!message.contains("回报主 agent"), "message: {message}");
}

/// 超时：主 agent 不裁决 → Expired → 子代理 run 不中断（非致命）、
/// 工具返回 approval_expired
#[tokio::test]
async fn subagent_approval_expired_does_not_interrupt_run() {
    let reg = registry_with(vec![Arc::new(DangerousTool)]);
    let exec = ToolExecutor::new(reg);
    let gate = Arc::new(RequesterRecordingApproval {
        decision: ApprovalDecision::Expired,
        received: Arc::new(std::sync::Mutex::new(None)),
    });
    let calls = vec![ToolBatchCall {
        id: "c1".into(),
        tool_name: "dangerous_tool".into(),
        summary: "子代理越界写".into(),
        input: serde_json::json!({ "path": "outside.md", "approval_reason": "需要越界写入" }),
        category: conex_types::tool::ToolCategory::Filesystem,
        concurrency: ToolConcurrency::Sequential,
    }];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        permission_mode: Some(PermissionMode::Ask),
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &subagent_ctx(), Some(gate), &opts, None)
        .await;
    assert_eq!(
        out.results[0].error_kind,
        Some(ToolErrorKind::ApprovalExpired),
        "超时 → 工具返回 approval_expired"
    );
    assert!(
        out.fatal.is_none(),
        "approval_expired 非致命：子代理 run 不中断"
    );
}

/// 贯通验证：动态注册 MCP 工具在大模型发请求时的快照注入与执行转发（Task 4）
#[tokio::test]
async fn mcp_dynamic_tool_snapshot_injection_and_execution_forwarding() {
    let reg = Arc::new(ToolRegistry::new());
    let bridge = Arc::new(agent_tools::mcp::McpClientBridge::new());
    let server_id = "srv_demo";
    let tool_name = agent_tools::mcp::format_mcp_tool_name(server_id, "search");

    let def = ToolDefinition {
        name: tool_name.clone(),
        description: "搜索工作区内容".to_string(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "query": { "type": "string" }
            }
        }),
        dangerous: false,
        fatal_on_error: false,
    };

    let adapter = Arc::new(agent_tools::mcp::McpDynamicToolAdapter::new(
        bridge.clone(),
        server_id,
        "search",
        def.clone(),
    ));

    // 动态注册到 ToolRegistry
    reg.register_or_replace_runtime(adapter)
        .expect("注册应成功");

    // 1. 验证 LLM 发请求时可从 list_definitions 中真实拿到该 MCP 工具的定义（Prompt 注入）
    let defs = reg.list_definitions();
    assert!(
        defs.iter().any(|d| d.name == tool_name),
        "MCP 工具必须进入发往 LLM 的定义列表中"
    );

    // 2. 模拟 LLM 触发该 MCP 工具调用
    let exec = ToolExecutor::new(reg.clone());
    let calls = vec![ToolBatchCall {
        id: "call_mcp_1".into(),
        tool_name: tool_name.clone(),
        summary: "调用动态 MCP 搜索".into(),
        input: serde_json::json!({ "query": "hello" }),
        category: conex_types::tool::ToolCategory::Internal,
        concurrency: ToolConcurrency::Parallel,
    }];
    let opts = ToolBatchOptions::default();

    // 此时服务尚未就绪，执行应返回 connection_failed 而非 panic
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;
    assert_eq!(
        out.results[0].error_kind,
        Some(ToolErrorKind::ExecutionFailed)
    );
    assert!(out.results[0]
        .error_message
        .as_ref()
        .unwrap()
        .contains("不可用"));

    // 3. 验证 disabled_tools 运行时掩码：禁用后在 list_definitions 过滤，执行时拦截
    reg.set_tool_enabled(&tool_name, false);
    assert!(!reg.is_tool_enabled(&tool_name));
    assert!(
        !reg.list_definitions().iter().any(|d| d.name == tool_name),
        "被禁用的 MCP 工具必须被快照过滤"
    );

    // 再次调用被禁用的工具：被 UserDenied 阻断
    let out_disabled = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;
    assert_eq!(
        out_disabled.results[0].error_kind,
        Some(ToolErrorKind::UserDenied)
    );
    assert!(out_disabled.results[0]
        .error_message
        .as_ref()
        .unwrap()
        .contains("disabled"));

    // 4. 重新启用
    reg.set_tool_enabled(&tool_name, true);
    assert!(reg.is_tool_enabled(&tool_name));
    assert!(reg.list_definitions().iter().any(|d| d.name == tool_name));
}
