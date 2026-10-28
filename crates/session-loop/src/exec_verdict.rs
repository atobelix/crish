//! 裁决与审批面（SR-03 拆分 · ≠ EL）：approval_wait / call_verdict /
//! result_is_fatal / 错误分类 / 拒绝文案 / cancel-siblings
//!
//! 批级审批竞速封装（approval_wait + ApprovalWaitOutcome + 缺省超时）、
//! 权限判定（call_verdict / revert_refusal_message）、致命判定
//! （result_is_fatal）、错误分类与拒绝结果构造（classify_tool_error /
//! denied_result / denied_message / mark_rest_cancelled）随本模落位。

use super::*;
use agent_tools::permission::{decide_verdict, PermissionMode, PermissionVerdict};
use conex_sandbox::SmartClassifier;

/// 裁决详情：判点结果 + 需审批原因（审批卡片展示与审计共用）
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct VerdictDecision {
    pub verdict: PermissionVerdict,
    pub reason: Option<String>,
}

impl VerdictDecision {
    fn allow() -> Self {
        Self {
            verdict: PermissionVerdict::Allow,
            reason: None,
        }
    }

    fn deny(reason: String) -> Self {
        Self {
            verdict: PermissionVerdict::Deny,
            reason: Some(reason),
        }
    }
}

/// 批级审批缺省超时（120s，F1-02 修复）：与编排层 approval_router 的
/// APPROVAL_TIMEOUT=120s 超时兜底对齐——审批卡片丢失/事件桥断连时
/// 内核强制收敛（Expired），run 不再无限悬挂。
const DEFAULT_APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);

/// 审批等待结果（F1-02 修复：abort 竞速 / 门决策 / 超时三路收敛）
pub(crate) enum ApprovalWaitOutcome {
    /// abort 竞速命中（不伪造审批事件，按取消收场——对齐
    /// approval.rs:135 语义）
    Cancelled,
    /// 审批门在超时内返回决策（超时 → [ApprovalDecision::Expired]，
    /// 调用方既有 Expired 分支直接复用）
    Decision(ApprovalDecision),
}

/// 批级审批三个 await 点（顺序路径 / 并行组审批循环 /
/// requires_approval 重试）共用本函数：`tokio::select!{biased}` 竞速
/// abort 等待 vs 审批门（带超时），对齐 approval.rs:131-160 的
/// `wait_aborted` + 竞速兜底 is_aborted 复查模式——abort 触发即打断
/// 审批等待，超时兜底保证 gate 不响应时有限收敛。
///
/// 超时语义：`timeout` 为 None 时用 [DEFAULT_APPROVAL_TIMEOUT]；超时
/// 命中返回 `Expired`（既有 Expired 分支复用：非致命、喂回模型）。
/// 竞速兜底：超时/裁决与 abort 同时就绪时取消优先（L3 强停语义）。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn approval_wait(
    gate: &dyn ApprovalGate,
    call_id: &str,
    tool_name: &str,
    input: &Value,
    requester: Option<&ApprovalRequester>,
    reason: Option<&str>,
    abort: Option<&AbortSignal>,
    timeout: Option<Duration>,
) -> ApprovalWaitOutcome {
    let t = timeout.unwrap_or(DEFAULT_APPROVAL_TIMEOUT);
    let wait = gate.request_approval(call_id, tool_name, input, requester, reason);
    let cancelled = async {
        match abort {
            Some(sig) => sig.wait_aborted().await,
            // 无批级信号：取消分支永不就绪（不参与竞速）
            None => std::future::pending::<()>().await,
        }
    };
    tokio::select! {
        biased;
        () = cancelled => ApprovalWaitOutcome::Cancelled,
        result = tokio::time::timeout(t, wait) => {
            // 竞速兜底（对齐 approval.rs:139-141）：等待期间 abort 与
            // 裁决/超时同时就绪 → 取消优先（L3 强停语义）
            if abort.map(|s| s.is_aborted()).unwrap_or(false) {
                return ApprovalWaitOutcome::Cancelled;
            }
            match result {
                Ok(decision) => ApprovalWaitOutcome::Decision(decision),
                // 超时：Expired（调用方既有分支复用，非致命）
                Err(_) => ApprovalWaitOutcome::Decision(ApprovalDecision::Expired),
            }
        }
    }
}

impl ToolExecutor {
    /// fatalOnError 判定（01 §五.8）：查工具定义标记；未注册/未知工具按
    /// 非致命处理（错误喂回模型）。审批/超时/取消类错误恒不致命。
    pub(crate) fn result_is_fatal(&self, call: &ToolBatchCall, r: &ClassifiedToolResult) -> bool {
        let Some(kind) = r.error_kind else {
            return false;
        };
        if kind.is_never_fatal() {
            return false;
        }
        self.registry
            .get(&call.tool_name)
            .map(|t| t.definition().fatal_on_error)
            .unwrap_or(false)
    }

    /// 裁决详情（含需审批原因）：执行器唯一判点的完整产物，
    /// 原因随 approval-requested 透传给审批卡片（SSOT）。
    pub(crate) fn call_verdict_detailed(
        &self,
        call: &ToolBatchCall,
        options: &ToolBatchOptions,
    ) -> VerdictDecision {
        if !self.registry.is_tool_enabled(&call.tool_name) {
            return VerdictDecision::deny(format!("工具未启用：{}", call.tool_name));
        }

        let mode = options.effective_permission_mode();

        if let Some(command) = call
            .input
            .get("command")
            .and_then(serde_json::Value::as_str)
        {
            // 任务类型命令白名单（BC10-6）：commit 等严格类型只允许白名单命令
            if let Some(task_type) = &options.task_type {
                if !agent_tools::readonly::command_allowed_for_task_type(task_type, command) {
                    tracing::warn!(
                        target: "security.audit",
                        task_type,
                        command,
                        "任务类型命令白名单拒绝执行"
                    );
                    return VerdictDecision::deny(format!("任务类型 {task_type} 不允许执行该命令"));
                }
            }
            return self.call_command_verdict_detailed(command, mode);
        }

        // 常规非命令工具审查
        let dangerous = self
            .registry
            .get(&call.tool_name)
            .map(|t| t.definition().dangerous)
            .unwrap_or(false);

        if mode == PermissionMode::Full {
            return VerdictDecision::allow();
        }

        let verdict = decide_verdict(mode, dangerous, !dangerous);
        let reason = (verdict == PermissionVerdict::NeedsApproval)
            .then(|| format!("工具 {} 标记为危险操作，需确认", call.tool_name));
        VerdictDecision { verdict, reason }
    }

    /// 全系统唯一的法定工具审查判点（SSOT）
    ///
    /// 所有工具调用在派发执行前必须经过本裁决，且后续环节绝不再进行任何二次审查：
    /// 1. 工具未启用 → Deny；超任务类型命令白名单 → Deny；
    /// 2. Full 模式：除物理红线（Redline）外全部放行——红线是"不可授权底线"，
    ///    任何模式不得豁免（防提示词注入抹盘）；其余命令 0 延迟直通；
    /// 3. Shell 命令审查：SmartClassifier 统一分析（重定向/命令替换/换行等复杂形态
    ///    保守升级审批），Smart 放行安全命令、Ask 仅放行严格只读；
    /// 4. 常规非命令工具审查：根据 dangerous 标记和权限模式判定。
    pub(crate) fn call_verdict(
        &self,
        call: &ToolBatchCall,
        options: &ToolBatchOptions,
    ) -> PermissionVerdict {
        self.call_verdict_detailed(call, options).verdict
    }

    /// Shell 命令复合语义审查（两层分类矩阵）
    fn call_command_verdict_detailed(
        &self,
        command: &str,
        mode: PermissionMode,
    ) -> VerdictDecision {
        let analysis = SmartClassifier::analyze(command);

        // 红线：任何模式（含 Full）一律刚性拒绝
        if let conex_sandbox::SmartVerdict::Deny { reason } = analysis.verdict {
            tracing::warn!(
                target: "security.audit",
                mode = mode.as_str(),
                command,
                reason,
                "Redline 命令被硬阻断"
            );
            return VerdictDecision::deny(reason.to_string());
        }

        if mode == PermissionMode::Full {
            return VerdictDecision::allow();
        }

        match mode {
            PermissionMode::Smart => {
                // C3 大回退护栏检查（大面积回退弹窗确认）
                let semantic = conex_sandbox::semantics::analyze(command);
                if let Some(revert_verdict) = self.revert_policy.gate_verdict(&semantic, mode) {
                    let reason = (revert_verdict == PermissionVerdict::NeedsApproval)
                        .then(|| "检测到大面积回退操作，需确认".to_string());
                    return VerdictDecision {
                        verdict: revert_verdict,
                        reason,
                    };
                }
                match analysis.verdict {
                    conex_sandbox::SmartVerdict::Allow => VerdictDecision::allow(),
                    conex_sandbox::SmartVerdict::RequireApproval { reason } => {
                        let summary = reason.summary();
                        tracing::info!(
                            target: "security.audit",
                            mode = mode.as_str(),
                            command,
                            approval_reason = %summary,
                            "Smart 模式升级审批"
                        );
                        VerdictDecision {
                            verdict: PermissionVerdict::NeedsApproval,
                            reason: Some(summary),
                        }
                    }
                    conex_sandbox::SmartVerdict::Deny { reason } => {
                        VerdictDecision::deny(reason.to_string())
                    }
                }
            }
            // Ask（Full 已在上面早退；其余未知同样按 Ask 兜底）
            _ => {
                // Ask 模式：仅严格只读命令放行，其余均需审批
                if analysis.pure_read_only {
                    VerdictDecision::allow()
                } else {
                    tracing::info!(
                        target: "security.audit",
                        mode = mode.as_str(),
                        command,
                        "Ask 模式升级审批（非严格只读）"
                    );
                    VerdictDecision {
                        verdict: PermissionVerdict::NeedsApproval,
                        reason: Some("每次询问模式：非严格只读命令需确认".to_string()),
                    }
                }
            }
        }
    }

    /// 构造审批请求方（T-D-14 权限传递层，任务书第 4 步）：子代理 run
    /// （有父 run 归属）→ Some（`run_id` = 子代理 run id，申请理由从工具
    /// 入参保留键 [crate::approval_router::APPROVAL_REASON_ARG_KEY] 提取）；
    /// 主 agent run（无父 run 归属）→ None（裁决者 = 用户，既有流程不变）。
    pub(crate) fn approval_requester_for(
        &self,
        ctx: &ToolExecCtx,
        args: &Value,
    ) -> Option<ApprovalRequester> {
        requester_from_context(
            &ctx.run_id,
            ctx.parent_run_id.as_deref(),
            approval_reason_from_args(args),
        )
    }

    /// C3 兜底拒绝文案：大面积回退 + 审批通道缺失（approval=None）时阈值
    /// 检查仍生效（04 C3 第 2/5 条 + 01 方案 §4 关键关系：安全优先，不做
    /// 无限等待），拒绝结果带面积摘要与替代路径指引；非回退门禁项保持
    /// 既有通用文案。
    pub(crate) fn revert_refusal_message(&self, call: &ToolBatchCall) -> String {
        if let Some(command) = call
            .input
            .get("command")
            .and_then(serde_json::Value::as_str)
        {
            if let Some(msg) = self.revert_policy.refusal_message(command) {
                return msg;
            }
        }
        format!("{} requires approval", call.tool_name)
    }
}

pub(crate) fn classify_tool_error(err: &ToolError) -> (ToolErrorKind, String) {
    let code = err.code();
    let message = err.to_string();
    let kind = match code {
        "tool.not_found" => ToolErrorKind::NotFound,
        "tool.invalid_input" => ToolErrorKind::InvalidInput,
        "tool.requires_approval" => ToolErrorKind::ApprovalRequired,
        "tool.user_denied" => ToolErrorKind::UserDenied,
        "tool.approval_expired" => ToolErrorKind::ApprovalExpired,
        "tool.cancelled" => ToolErrorKind::Cancelled,
        _ => ToolErrorKind::ExecutionFailed,
    };
    (kind, message)
}

pub(crate) fn denied_result(
    call: &ToolBatchCall,
    options: &ToolBatchOptions,
    registry: Option<&ToolRegistry>,
) -> ClassifiedToolResult {
    let mode = options.effective_permission_mode().as_str();
    let message = if let Some(reg) = registry {
        if !reg.is_tool_enabled(&call.tool_name) {
            format!("tool disabled: {}", call.tool_name)
        } else {
            format!("permission denied by {mode} mode: {}", call.tool_name)
        }
    } else {
        format!("permission denied by {mode} mode: {}", call.tool_name)
    };
    ClassifiedToolResult::error(
        &call.id,
        &call.tool_name,
        ToolErrorKind::UserDenied,
        message,
        0,
    )
}

pub(crate) fn denied_message(subagent_request: bool, reason: &str) -> String {
    if subagent_request {
        relay_denied_message(reason)
    } else {
        format!("user denied: {reason}")
    }
}

pub(crate) fn mark_rest_cancelled(
    calls: &[ToolBatchCall],
    results: &mut [Option<ClassifiedToolResult>],
    events: &mut Vec<ToolEvent>,
) {
    for (i, call) in calls.iter().enumerate() {
        if results[i].is_some() {
            continue;
        }
        events.push(ToolEvent::ToolStart {
            call_id: call.id.clone(),
            tool_name: call.tool_name.clone(),
            input: call.input.clone(),
            category: call.category,
            concurrency: call.concurrency,
            summary: call.summary.clone(),
            occurred_at_ms: Some(conex_shared::time::unix_millis() as u64),
        });
        events.push(ToolEvent::ToolEnd {
            call_id: call.id.clone(),
            tool_name: call.tool_name.clone(),
            is_error: true,
            duration_ms: 0,
            output: Arc::new(serde_json::Value::Null),
            error_code: Some(conex_types::error::codes::TOOL_CANCELLED.to_string()),
            error_message: Some("cancelled: sibling failure".to_string()),
            attempt: None,
            deduplicated: None,
            executed_input: None,
            occurred_at_ms: None,
        });
        results[i] = Some(ClassifiedToolResult::error(
            &call.id,
            &call.tool_name,
            ToolErrorKind::Cancelled,
            "cancelled: sibling failure",
            0,
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_tools::definition::{Tool, ToolDefinition};

    struct DummyShellTool;
    #[async_trait::async_trait]
    impl Tool for DummyShellTool {
        fn name(&self) -> &str {
            "execute_command"
        }
        fn definition(&self) -> &ToolDefinition {
            static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
            DEF.get_or_init(|| ToolDefinition {
                name: "execute_command".into(),
                description: "shell command execution".into(),
                input_schema: serde_json::json!({"type": "object"}),
                dangerous: false,
                fatal_on_error: false,
            })
        }
        async fn execute(&self, _ctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
            Ok(args)
        }
    }

    struct DummyFsTool {
        name: &'static str,
        dangerous: bool,
    }
    #[async_trait::async_trait]
    impl Tool for DummyFsTool {
        fn name(&self) -> &str {
            self.name
        }
        fn definition(&self) -> &ToolDefinition {
            static DEF_SAFE: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
            static DEF_DANGEROUS: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
            if self.dangerous {
                DEF_DANGEROUS.get_or_init(|| ToolDefinition {
                    name: "write_file".into(),
                    description: "write file".into(),
                    input_schema: serde_json::json!({"type": "object"}),
                    dangerous: true,
                    fatal_on_error: false,
                })
            } else {
                DEF_SAFE.get_or_init(|| ToolDefinition {
                    name: "read_file".into(),
                    description: "read file".into(),
                    input_schema: serde_json::json!({"type": "object"}),
                    dangerous: false,
                    fatal_on_error: false,
                })
            }
        }
        async fn execute(&self, _ctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
            Ok(args)
        }
    }

    #[test]
    fn full_mode_denies_redline_but_allows_regular_commands() {
        let mut reg = ToolRegistry::new();
        let _ = reg.register(Arc::new(DummyShellTool));
        let exec = ToolExecutor::new(Arc::new(reg));

        let full_options = ToolBatchOptions {
            permission_mode: Some(PermissionMode::Full),
            ..ToolBatchOptions::default()
        };

        // 物理红线是不可授权底线：Full 模式同样刚性拒绝
        let redline_call = ToolBatchCall {
            id: "call-redline".into(),
            tool_name: "execute_command".into(),
            input: serde_json::json!({ "command": "rm -rf /" }),
            category: conex_types::tool::ToolCategory::Internal,
            concurrency: ToolConcurrency::Sequential,
            summary: String::new(),
        };
        assert_eq!(
            exec.call_verdict(&redline_call, &full_options),
            PermissionVerdict::Deny
        );

        // Regular commands also Allow
        let normal_call = ToolBatchCall {
            id: "call-normal".into(),
            tool_name: "execute_command".into(),
            input: serde_json::json!({ "command": "npm test" }),
            category: conex_types::tool::ToolCategory::Internal,
            concurrency: ToolConcurrency::Sequential,
            summary: String::new(),
        };
        assert_eq!(
            exec.call_verdict(&normal_call, &full_options),
            PermissionVerdict::Allow
        );
    }

    #[test]
    fn smart_mode_classifies_commands() {
        let mut reg = ToolRegistry::new();
        let _ = reg.register(Arc::new(DummyShellTool));
        let exec = ToolExecutor::new(Arc::new(reg));

        let smart_options = ToolBatchOptions {
            permission_mode: Some(PermissionMode::Smart),
            ..ToolBatchOptions::default()
        };

        // 1. Safe build/test/probe commands are allowed directly
        for cmd in ["git status", "ls -la", "cargo check", "npm test", "pwd"] {
            let call = ToolBatchCall {
                id: "call-safe".into(),
                tool_name: "execute_command".into(),
                input: serde_json::json!({ "command": cmd }),
                category: conex_types::tool::ToolCategory::Internal,
                concurrency: ToolConcurrency::Sequential,
                summary: String::new(),
            };
            assert_eq!(
                exec.call_verdict(&call, &smart_options),
                PermissionVerdict::Allow,
                "Safe command {cmd} should be Allowed in Smart mode"
            );
        }

        // 2. Sensitive commands require approval
        for cmd in ["rm -rf ./tmp", "git push origin main -f", "sudo apt update"] {
            let call = ToolBatchCall {
                id: "call-sensitive".into(),
                tool_name: "execute_command".into(),
                input: serde_json::json!({ "command": cmd }),
                category: conex_types::tool::ToolCategory::Internal,
                concurrency: ToolConcurrency::Sequential,
                summary: String::new(),
            };
            assert_eq!(
                exec.call_verdict(&call, &smart_options),
                PermissionVerdict::NeedsApproval,
                "Sensitive command {cmd} should require approval in Smart mode"
            );
        }

        // 3. Redline commands are Denied in Smart mode
        let redline_call = ToolBatchCall {
            id: "call-redline".into(),
            tool_name: "execute_command".into(),
            input: serde_json::json!({ "command": "rm -rf /" }),
            category: conex_types::tool::ToolCategory::Internal,
            concurrency: ToolConcurrency::Sequential,
            summary: String::new(),
        };
        assert_eq!(
            exec.call_verdict(&redline_call, &smart_options),
            PermissionVerdict::Deny,
            "Redline command should be Denied in Smart mode"
        );
    }

    #[test]
    fn ask_mode_requires_approval_except_pure_readonly() {
        let mut reg = ToolRegistry::new();
        let _ = reg.register(Arc::new(DummyShellTool));
        let exec = ToolExecutor::new(Arc::new(reg));

        let ask_options = ToolBatchOptions {
            permission_mode: Some(PermissionMode::Ask),
            ..ToolBatchOptions::default()
        };

        // Pure read-only probe commands are allowed
        let read_call = ToolBatchCall {
            id: "call-read".into(),
            tool_name: "execute_command".into(),
            input: serde_json::json!({ "command": "git status" }),
            category: conex_types::tool::ToolCategory::Internal,
            concurrency: ToolConcurrency::Sequential,
            summary: String::new(),
        };
        assert_eq!(
            exec.call_verdict(&read_call, &ask_options),
            PermissionVerdict::Allow
        );

        // Build/test commands require approval in Ask mode
        let test_call = ToolBatchCall {
            id: "call-test".into(),
            tool_name: "execute_command".into(),
            input: serde_json::json!({ "command": "npm test" }),
            category: conex_types::tool::ToolCategory::Internal,
            concurrency: ToolConcurrency::Sequential,
            summary: String::new(),
        };
        assert_eq!(
            exec.call_verdict(&test_call, &ask_options),
            PermissionVerdict::NeedsApproval
        );

        // Redline is denied
        let redline_call = ToolBatchCall {
            id: "call-redline".into(),
            tool_name: "execute_command".into(),
            input: serde_json::json!({ "command": "rm -rf /" }),
            category: conex_types::tool::ToolCategory::Internal,
            concurrency: ToolConcurrency::Sequential,
            summary: String::new(),
        };
        assert_eq!(
            exec.call_verdict(&redline_call, &ask_options),
            PermissionVerdict::Deny
        );
    }

    #[test]
    fn non_command_tools_handled_by_dangerous_flag() {
        let mut reg = ToolRegistry::new();
        let _ = reg.register(Arc::new(DummyFsTool {
            name: "read_file",
            dangerous: false,
        }));
        let _ = reg.register(Arc::new(DummyFsTool {
            name: "write_file",
            dangerous: true,
        }));
        let exec = ToolExecutor::new(Arc::new(reg));

        let ask_options = ToolBatchOptions {
            permission_mode: Some(PermissionMode::Ask),
            ..ToolBatchOptions::default()
        };

        let read_call = ToolBatchCall {
            id: "call-read".into(),
            tool_name: "read_file".into(),
            input: serde_json::json!({ "path": "test.txt" }),
            category: conex_types::tool::ToolCategory::Internal,
            concurrency: ToolConcurrency::Sequential,
            summary: String::new(),
        };
        assert_eq!(
            exec.call_verdict(&read_call, &ask_options),
            PermissionVerdict::Allow
        );

        let write_call = ToolBatchCall {
            id: "call-write".into(),
            tool_name: "write_file".into(),
            input: serde_json::json!({ "path": "test.txt" }),
            category: conex_types::tool::ToolCategory::Internal,
            concurrency: ToolConcurrency::Sequential,
            summary: String::new(),
        };
        assert_eq!(
            exec.call_verdict(&write_call, &ask_options),
            PermissionVerdict::NeedsApproval
        );
    }

    #[test]
    fn disabled_tools_are_denied() {
        let mut reg = ToolRegistry::new();
        let _ = reg.register(Arc::new(DummyShellTool));
        reg.set_tool_enabled("execute_command", false);
        let exec = ToolExecutor::new(Arc::new(reg));

        let full_options = ToolBatchOptions {
            permission_mode: Some(PermissionMode::Full),
            ..ToolBatchOptions::default()
        };

        let disabled_call = ToolBatchCall {
            id: "call-disabled".into(),
            tool_name: "execute_command".into(),
            input: serde_json::json!({ "command": "git status" }),
            category: conex_types::tool::ToolCategory::Internal,
            concurrency: ToolConcurrency::Sequential,
            summary: String::new(),
        };
        assert_eq!(
            exec.call_verdict(&disabled_call, &full_options),
            PermissionVerdict::Deny
        );
    }
}
