//! 单工具执行面（SR-03 拆分 · ≠ EL）：execute_one / execute_single /
//! execute_single_with_retry
//!
//! 顺序路径完整事件序列（execute_one）、无事件产出的单工具执行
//! （execute_single，中间件链 + tool.pre/post 钩子 + 超时/abort 竞速）
//! 与 requires_approval 真实审批重试（execute_single_with_retry）随本模落位。
//! 语义与拆分前逐行一致（只搬移不改行为）。

mod execution;
mod post_exec;
mod pre_exec;
mod types;

use std::sync::Arc;

use super::*;
use types::ToolEmit;

impl ToolExecutor {
    /// 执行单个工具（顺序路径：完整事件序列 + 审批）
    // G2 允许理由（clippy::too_many_arguments）：参数为工具执行上下文聚合
    // 注入（批调用/下标/执行上下文/审批门/批选项/中止信号/事件收集/致命
    // 错误槽），各参数来源独立，收缩将退化为全局态或拆分 struct 而收益低。
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn execute_one(
        &self,
        calls: &[ToolBatchCall],
        idx: usize,
        ctx: &ToolExecCtx,
        approval: Option<Arc<dyn ApprovalGate>>,
        options: &ToolBatchOptions,
        abort: Option<&crate::safe_point::AbortSignal>,
        events: &mut Vec<ToolEvent>,
        fatal: &mut Option<String>,
    ) -> ClassifiedToolResult {
        let call = &calls[idx];
        Self::emit_tool_events(call, events, ToolEmit::Start);

        // abort 前置检查
        if let Some(sig) = abort {
            if sig.is_aborted() {
                Self::emit_tool_events(call, events, ToolEmit::EndAborted);
                return ClassifiedToolResult::error(
                    &call.id,
                    &call.tool_name,
                    ToolErrorKind::Cancelled,
                    "aborted",
                    0,
                );
            }
        }

        let call_cx = types::ExecCallContext {
            call,
            ctx,
            options,
            abort,
            approval,
        };
        let r = self.handle_verdict_and_approval(&call_cx, events).await;
        if self.result_is_fatal(call, &r) {
            *fatal = Some(
                r.error_message
                    .clone()
                    .unwrap_or_else(|| "tool failed".into()),
            );
        }
        Self::emit_tool_events(call, events, ToolEmit::End(&r));
        r
    }
}
