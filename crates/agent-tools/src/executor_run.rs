//! 执行面（SR-06a-4 拆分 · executor.rs `#[path]` 接线）：单工具执行 +
//! 输出策略 + 幂等检查的两个入口（execute_with_output_policy 与流式变体），
//! 语义与拆分前逐行一致（只搬不移，不夹带功能改动）。

use crate::context::ToolContext;
use crate::definition::{Tool, ToolError};
use crate::idempotency::{IdempotencyDecision, ToolIdempotencyGuard};
use crate::output::{stringify_tool_output, summarize};
use crate::streaming::{ToolProgress, ToolStreamItem};
use conex_types::error::codes;
use futures_util::StreamExt;
use serde_json::Value;
use std::sync::Arc;
use std::time::Instant;

use super::executor_idem::build_idempotency_context;
use super::executor_types::{ExecutorContext, ToolExecutionPolicy, ToolResult};

/// 单工具执行 + 输出策略 + 幂等检查（B3.5 消费入口）
///
/// 流程：
/// 1. 幂等检查（policy.idempotency 且传入 guard）：已执行 → 直接返回
///    deduplicated 结果（不执行工具）
/// 2. 执行工具（R3 T9：携带会话级 ToolContext，失败返回 ToolError，
///    且不记录幂等键，允许重试）
/// 3. 输出预算：超出 budget_bytes 时截断并附加 contextBudget 标记字段
/// 4. 记录幂等键（成功执行后；store 先写、失败不写内存——record 失败
///    返回错误，同进程重试走执行路径重新执行，11-T6 语义）
pub async fn execute_with_output_policy(
    tool: &dyn Tool,
    args: Value,
    tool_ctx: &ToolContext,
    ctx: &ExecutorContext,
    guard: Option<&ToolIdempotencyGuard>,
    policy: &ToolExecutionPolicy,
) -> Result<ToolResult, ToolError> {
    let started = Instant::now();

    if policy.idempotency {
        if let Some(guard) = guard {
            let idem_ctx = build_idempotency_context(ctx, tool.name(), &args);
            if let IdempotencyDecision::Deduplicated { key } = guard.check(&idem_ctx, &args).await?
            {
                let output = serde_json::json!({
                    "text": format!("Tool call already executed; skipped re-execution (key: {key})"),
                    "json": { "deduplicated": true, "key": key },
                });
                return Ok(ToolResult {
                    text: stringify_tool_output(&output),
                    output,
                    truncated: false,
                    deduplicated: true,
                    duration_ms: 0,
                });
            }
        }
    }

    let output = tool.execute(tool_ctx, args.clone()).await?;

    let (output, truncated) = match policy.output_budget_bytes {
        Some(budget) => {
            let summarized = summarize(&output, budget);
            if summarized.truncated {
                (summarized.value, true)
            } else {
                (output, false)
            }
        }
        None => (output, false),
    };

    if policy.idempotency {
        if let Some(guard) = guard {
            let idem_ctx = build_idempotency_context(ctx, tool.name(), &args);
            // 记录失败（如 store 持久化失败）直接传播错误：工具已执行，
            // 但幂等键未写内存——重试不命中去重、重新执行（11-T6 语义）
            guard.record(&idem_ctx, &args).await?;
        }
    }

    Ok(ToolResult {
        text: stringify_tool_output(&output),
        output,
        truncated,
        deduplicated: false,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

/// S1：流式执行 + 输出策略 + 幂等 + 进度回调（TOOLS-01 §3.1.4）
///
/// 与旧路径 [execute_with_output_policy] 的差异点（旧函数保持不动供直连
/// 调用方使用）：
/// 1. 幂等 check：命中 → 返回 deduplicated 终值且**零 Progress**（D3：
///    Progress 不参与幂等键，幂等只按 Terminal 终值记录）；
/// 2. 消费 execute_stream：Progress → 经 progress 回调转发（None = 丢弃），
///    并做 abort 检查——中止即停止消费（流被 drop，已发 Progress 保留），
///    返回 runtime.aborted 错误且不记录幂等键；
///    Terminal → 取终值（Err 原样传播），走既有 summarize 截断；
/// 3. 幂等 record：与旧路径一致（失败/中断不记录）。
pub async fn execute_stream_with_output_policy(
    tool: &dyn Tool,
    args: Value,
    tool_ctx: &ToolContext,
    ctx: &ExecutorContext,
    guard: Option<&ToolIdempotencyGuard>,
    policy: &ToolExecutionPolicy,
    progress: Option<Arc<dyn Fn(ToolProgress) + Send + Sync>>,
) -> Result<ToolResult, ToolError> {
    let started = Instant::now();

    if policy.idempotency {
        if let Some(guard) = guard {
            let idem_ctx = build_idempotency_context(ctx, tool.name(), &args);
            if let IdempotencyDecision::Deduplicated { key } = guard.check(&idem_ctx, &args).await?
            {
                let output = serde_json::json!({
                    "text": format!("Tool call already executed; skipped re-execution (key: {key})"),
                    "json": { "deduplicated": true, "key": key },
                });
                return Ok(ToolResult {
                    text: stringify_tool_output(&output),
                    output,
                    truncated: false,
                    deduplicated: true,
                    duration_ms: 0,
                });
            }
        }
    }

    let mut stream = tool.execute_stream(tool_ctx, args.clone()).await;
    let mut terminal: Option<Result<Value, ToolError>> = None;
    while let Some(item) = stream.next().await {
        // abort 检查：中止后停止消费（drop 流即取消），已发 Progress 保留
        if tool_ctx.abort_token.is_aborted() {
            break;
        }
        match item {
            ToolStreamItem::Progress(p) => {
                if let Some(cb) = &progress {
                    cb(p);
                }
            }
            ToolStreamItem::Terminal(result) => {
                terminal = Some(result);
                // Terminal 恒为末项，短路收口
                break;
            }
        }
    }

    let output = match terminal {
        Some(Ok(output)) => output,
        Some(Err(e)) => return Err(e),
        None => {
            // 流在 Terminal 前收口：中止（runtime.aborted）或流实现违反不变式
            return Err(if tool_ctx.abort_token.is_aborted() {
                ToolError::new(
                    codes::RUNTIME_ABORTED,
                    format!("工具 {} 执行被中止", tool.name()),
                )
            } else {
                ToolError::execution_failed(tool.name(), "流在 Terminal 前收口（违反流不变式）")
            });
        }
    };

    let (output, truncated) = match policy.output_budget_bytes {
        Some(budget) => {
            let summarized = summarize(&output, budget);
            if summarized.truncated {
                (summarized.value, true)
            } else {
                (output, false)
            }
        }
        None => (output, false),
    };

    if policy.idempotency {
        if let Some(guard) = guard {
            let idem_ctx = build_idempotency_context(ctx, tool.name(), &args);
            // 记录失败（如 store 持久化失败）直接传播错误：同旧路径 11-T6 语义
            guard.record(&idem_ctx, &args).await?;
        }
    }

    Ok(ToolResult {
        text: stringify_tool_output(&output),
        output,
        truncated,
        deduplicated: false,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}
