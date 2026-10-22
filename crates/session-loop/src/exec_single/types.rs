use std::sync::Arc;

use agent_tools::definition::Tool;
use agent_tools::executor::{ExecutorContext, ToolExecutionPolicy};
use agent_tools::idempotency::ToolIdempotencyGuard;
use agent_tools::middleware::ToolExecutionContext;
use agent_tools::ToolContext;
use serde_json::Value;

use super::super::*;

/// execute_one 事件相：start / 未执行 abort 收场 / 正常 tool-end。
pub(super) enum ToolEmit<'a> {
    Start,
    EndAborted,
    End(&'a ClassifiedToolResult),
}

/// 预执行结果（中间件/钩子阶段）
pub(super) enum PreExecOutcome {
    Proceed(Value),
    Blocked(String),
    Aborted,
}

/// 单工具执行/重试环境聚合
pub(super) struct ExecCallContext<'a> {
    pub call: &'a ToolBatchCall,
    pub ctx: &'a ToolExecCtx,
    pub options: &'a ToolBatchOptions,
    pub abort: Option<&'a crate::safe_point::AbortSignal>,
    pub approval: Option<Arc<dyn ApprovalGate>>,
}

/// 工具执行时间打点与重试要素
#[derive(Clone, Copy, Debug)]
pub(super) struct ExecTiming {
    pub attempt: u32,
    pub duration_ms: u64,
    pub occurred_at_ms: u64,
}

/// 工具执行超时/中断竞速参数
pub(super) struct RaceExecParams<'a> {
    pub tool: &'a dyn Tool,
    pub exec_input: Value,
    pub tool_ctx: &'a ToolContext,
    pub exec_ctx: &'a ExecutorContext,
    pub guard: Option<&'a ToolIdempotencyGuard>,
    pub policy: &'a ToolExecutionPolicy,
    pub timeout: std::time::Duration,
    pub abort: Option<&'a crate::safe_point::AbortSignal>,
}

/// 后置执行中间件与收尾上下文聚合
pub(super) struct PostExecContext<'a> {
    pub tool: &'a dyn Tool,
    pub call: &'a ToolBatchCall,
    pub ctx: &'a ToolExecCtx,
    pub mw_ctx: &'a ToolExecutionContext,
}

impl ToolExecutor {
    /// 顺序路径 tool-start / tool-end 发射（从 execute_one 抽出，只搬移）。
    /// abort 未执行收场与正常收场载荷不同（原子要素留空 vs 透传），故分相。
    pub(super) fn emit_tool_events(
        call: &ToolBatchCall,
        events: &mut Vec<ToolEvent>,
        kind: ToolEmit<'_>,
    ) {
        match kind {
            ToolEmit::Start => {
                events.push(ToolEvent::ToolStart {
                    call_id: call.id.clone(),
                    tool_name: call.tool_name.clone(),
                    input: call.input.clone(),
                    category: call.category,
                    concurrency: call.concurrency,
                    summary: call.summary.clone(),
                    // EV-09（D-03）：工具开始时刻打点（翻译层回填 timestamp）
                    occurred_at_ms: Some(conex_shared::time::unix_millis() as u64),
                });
            }
            ToolEmit::EndAborted => {
                events.push(ToolEvent::ToolEnd {
                    call_id: call.id.clone(),
                    tool_name: call.tool_name.clone(),
                    is_error: true,
                    duration_ms: 0,
                    // U-OUT-RS：出口 Arc——Null 也走共享边界
                    output: Arc::new(serde_json::Value::Null),
                    // Tier-1（02 §4.1）：统一 codes::TOOL_CANCELLED 常量
                    error_code: Some(conex_types::error::codes::TOOL_CANCELLED.to_string()),
                    error_message: Some("aborted".to_string()),
                    // EV-09（D-03）：未执行路径原子要素留空
                    attempt: None,
                    deduplicated: None,
                    executed_input: None,
                    occurred_at_ms: None,
                });
            }
            ToolEmit::End(r) => {
                events.push(ToolEvent::ToolEnd {
                    call_id: call.id.clone(),
                    tool_name: call.tool_name.clone(),
                    is_error: r.error_kind.is_some(),
                    duration_ms: r.duration_ms,
                    // U-OUT-RS：Arc::clone 浅拷贝（refcount+1），消除深 clone
                    output: Arc::clone(&r.output),
                    error_code: r.error_kind.map(|k| k.error_code().to_string()),
                    error_message: r.error_message.clone(),
                    // EV-09（D-03）：原子要素透传（attempt/dedup/实际入参/打点）
                    attempt: Some(r.attempt),
                    deduplicated: Some(r.deduplicated),
                    executed_input: r.executed_input.clone(),
                    occurred_at_ms: r.occurred_at_ms,
                });
            }
        }
    }

    pub(super) fn not_found_result(call: &ToolBatchCall) -> ClassifiedToolResult {
        ClassifiedToolResult::error(
            &call.id,
            &call.tool_name,
            ToolErrorKind::NotFound,
            format!("unknown tool: {}", call.tool_name),
            0,
        )
    }

    pub(super) fn blocked_result(call: &ToolBatchCall, reason: String) -> ClassifiedToolResult {
        ClassifiedToolResult::error(
            &call.id,
            &call.tool_name,
            ToolErrorKind::ExecutionFailed,
            reason,
            0,
        )
    }

    pub(super) fn cancelled_result(call: &ToolBatchCall, duration_ms: u64) -> ClassifiedToolResult {
        ClassifiedToolResult::error(
            &call.id,
            &call.tool_name,
            ToolErrorKind::Cancelled,
            "aborted",
            duration_ms,
        )
    }
}
