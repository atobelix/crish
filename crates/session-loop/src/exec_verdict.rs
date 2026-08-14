//! 裁决与审批面（SR-03 拆分 · ≠ EL）：approval_wait / call_verdict /
//! result_is_fatal / 错误分类 / 拒绝文案 / cancel-siblings
//!
//! 批级审批竞速封装（approval_wait + ApprovalWaitOutcome + 缺省超时）、
//! 权限判定（call_verdict / revert_refusal_message）、致命判定
//! （result_is_fatal）、错误分类与拒绝结果构造（classify_tool_error /
//! denied_result / denied_message / mark_rest_cancelled）随本模落位。
//! 语义与拆分前逐行一致（只搬移不改行为）。

use super::*;

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

///
/// 批级审批三个 await 点（顺序路径 / 并行组审批循环 /
/// requires_approval 重试）共用本函数：`tokio::select!{biased}` 竞速
/// abort 等待 vs 审批门（带超时），对齐 approval.rs:131-160 的
/// `wait_aborted` + 竞速兜底 is_aborted 复查模式——abort 触发即打断
/// 审批等待，超时兜底保证 gate 不响应时有限收敛。
///
/// 超时语义：`timeout` 为 None 时用 [DEFAULT_APPROVAL_TIMEOUT]；超时
/// 命中返回 `Expired`（既有 Expired 分支复用：非致命、喂回模型）。
/// 竞速兜底：超时/裁决与 abort 同时就绪时取消优先（L3 强停语义）。
pub(crate) async fn approval_wait(
    gate: &dyn ApprovalGate,
    call_id: &str,
    tool_name: &str,
    input: &Value,
    requester: Option<&ApprovalRequester>,
    abort: Option<&AbortSignal>,
    timeout: Option<Duration>,
) -> ApprovalWaitOutcome {
    let t = timeout.unwrap_or(DEFAULT_APPROVAL_TIMEOUT);
    let wait = gate.request_approval(call_id, tool_name, input, requester);
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

    /// 权限判定（R4 T10）：permission_mode 显式设置时按工具 dangerous
    /// 标记 + 模式三态判定；未设置（None）时沿用既有语义——approval
    /// 开启即视为需审批。
    ///
    /// C3（I3-S6）判定点（C4/S10b 经此挂载，不并写本文件主体）：入参含
    /// 命令文本时先过回退护栏——GitRevertShape 段 + 面积超阈值 →
    /// NeedsApproval（无论权限模式，full-access 不豁免；plan 保持更严
    /// Deny），面积小 → 按既有矩阵。红线语义仍由工具内门禁 100% 拦截
    /// （S2），本层不重复。审批人 = 用户：NeedsApproval 走既有
    /// ApprovalGate 链路等待用户裁决，主 Agent 仅转呈。
    pub(crate) fn call_verdict(&self, call: &ToolBatchCall, options: &ToolBatchOptions) -> PermissionVerdict {
        if let Some(command) = call.input.get("command").and_then(serde_json::Value::as_str) {
            let mode = options.permission_mode.unwrap_or_default();
            if let Some(verdict) = self.revert_policy.gate_verdict_command(command, mode) {
                return verdict;
            }
        }
        match options.permission_mode {
            Some(mode) => {
                let dangerous = self
                    .registry
                    .get(&call.tool_name)
                    .map(|t| t.definition().dangerous)
                    .unwrap_or(false);
                decide(dangerous, false, mode)
            }
            None => PermissionVerdict::NeedsApproval,
        }
    }

    /// 构造审批请求方（T-D-14 权限传递层，任务书第 4 步）：子代理 run
    /// （有父 run 归属）→ Some（`run_id` = 子代理 run id，申请理由从工具
    /// 入参保留键 [crate::approval_router::APPROVAL_REASON_ARG_KEY] 提取）；
    /// 主 agent run（无父 run 归属）→ None（裁决者 = 用户，既有流程不变）。
    pub(crate) fn approval_requester_for(&self, ctx: &ToolExecCtx, args: &Value) -> Option<ApprovalRequester> {
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
        if let Some(command) = call.input.get("command").and_then(serde_json::Value::as_str) {
            if let Some(msg) = self.revert_policy.refusal_message(command) {
                return msg;
            }
        }
        format!("{} requires approval", call.tool_name)
    }
}

pub(crate) fn classify_tool_error(err: &ToolError) -> (ToolErrorKind, String) {    let code = err.code();
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

pub(crate) fn denied_result(call: &ToolBatchCall, options: &ToolBatchOptions) -> ClassifiedToolResult {
    let mode = options
        .permission_mode
        .unwrap_or(PermissionMode::Ask)
        .as_engine_str();
    ClassifiedToolResult::error(
        &call.id,
        &call.tool_name,
        ToolErrorKind::UserDenied,
        format!("permission denied by {mode} mode: {}", call.tool_name),
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
            // EV-09（D-03）：兄弟失败取消——标记时刻打点（未执行，duration=0）
            occurred_at_ms: Some(crate::steering::unix_millis() as u64),
        });
        events.push(ToolEvent::ToolEnd {
            call_id: call.id.clone(),
            tool_name: call.tool_name.clone(),
            is_error: true,
            duration_ms: 0,
            output: serde_json::Value::Null,
            error_code: Some("tool.cancelled".to_string()),
            error_message: Some("cancelled: sibling failure".to_string()),
            // EV-09（D-03）：未执行路径原子要素留空
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