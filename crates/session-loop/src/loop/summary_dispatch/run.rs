//! 摘要后台任务执行体：退避重试主体与 spawn_blocking 单源摘要 helper（run 级 /
//! 会话级调度面共用）。

use std::sync::Arc;
use std::time::Duration;

use crate::safe_point::AbortSignal;
use conex_compaction::summary_document::{summary_to_markdown, validate_summary_document};
use conex_compaction::{recovery::SummaryState, Summarizer};
use conex_types::message::AgentMessage;

use super::{
    emit_summary_background, SummaryBackgroundSinkRef, SummaryDispatchConfig,
    SummaryDispatchOutcome, SummaryDispatchTask, SummaryOutcomeCallback,
};

/// 后台任务主体：退避重试摘要（单飞任务内循环）。
///
/// 尝试口径：同步那次已在引擎内完成（attempts 从 1 起算），退避序列
/// 每完成一次重试 attempts += 1；达到 [SummaryDispatchConfig::max_attempts]
/// 或退避序列耗尽停止（默认 4 = 同步 1 + 后台 3）。
///
/// **E2 F2 层 1（低功耗模式）**：episode 耗尽后**不再 retired 永驻**——
/// 结果状态上报 awaiting（块保持待重试），停止主动退避；后续被动触发
/// 点（用户消息边界 F3 / 新 run 装配 / 下一次压缩触发）重新触发摘要，
/// 跨 episode 累计成本由调用方持有的 [SummaryRetryGate] 护栏约束。
///
/// pub(crate)：会话级协调器（summary_coordinator.rs，T-42）复用同一执行体
/// ——run 级与会话级任务共用退避/墙钟/回调语义，行为单一事实源。
///
/// `background`：summary-background 事件发射器（EV-06；None = 不发射，
/// 退避/成功/失败/放弃 phase 均在此单点发射——两调度面事件口径一致）。
pub(crate) async fn run_summary_task(
    task: SummaryDispatchTask,
    config: SummaryDispatchConfig,
    on_done: Option<SummaryOutcomeCallback>,
    background: Option<SummaryBackgroundSinkRef>,
) {
    run_summary_task_with_abort(task, config, on_done, background, None).await
}

/// 支持 AbortSignal 抢断的后台任务主体（SL-PERF-04）
pub(crate) async fn run_summary_task_with_abort(
    task: SummaryDispatchTask,
    config: SummaryDispatchConfig,
    on_done: Option<SummaryOutcomeCallback>,
    background: Option<SummaryBackgroundSinkRef>,
    abort_signal: Option<Arc<AbortSignal>>,
) {
    let mut attempts: u32 = 1; // 含同步那次
    let mut outcome: Option<SummaryDispatchOutcome> = None;
    for delay_ms in &config.backoff_ms {
        if attempts >= config.max_attempts {
            break;
        }
        // 退避（±jitter；sleep 不阻塞主循环——任务独立于 run）
        let delay = jittered_ms(*delay_ms, config.jitter);
        if let Some(sig) = abort_signal.as_ref() {
            tokio::select! {
                biased;
                _ = sig.wait_aborted() => {
                    tracing::info!(session_id = %task.session_id, "摘要重试退避被 abort 抢断");
                    break;
                }
                _ = tokio::time::sleep(Duration::from_millis(delay)) => {}
            }
        } else {
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }
        if abort_signal
            .as_ref()
            .map(|s| s.is_aborted())
            .unwrap_or(false)
        {
            break;
        }
        attempts += 1;
        // EV-06：每次退避重试发射 attempt（reason = 本次退避延迟；attempt
        // 序号单调递增，含同步那次口径）
        emit_summary_background(
            &background,
            &task.session_id,
            "attempt",
            attempts,
            Some(format!("退避重试（第 {attempts} 次；延迟 {delay}ms）")),
            Some(task.block_id.clone()),
        );
        match summarize_once_with_abort(&task, config.max_wall_ms, abort_signal.as_deref()).await {
            Ok(json) => {
                // 合法 Schema V1 文档 → committed（R-G：JSON 规范面）；
                // 校验失败按失败尝试继续（不 byte 截断 JSON，保解析）
                match validate_summary_document(&json, task.max_bytes) {
                    Ok(doc) => {
                        // EV-06：成功 → success（attempt = 本次成功尝试序号）
                        emit_summary_background(
                            &background,
                            &task.session_id,
                            "success",
                            attempts,
                            None,
                            Some(task.block_id.clone()),
                        );
                        outcome = Some(SummaryDispatchOutcome {
                            session_id: task.session_id.clone(),
                            block_id: task.block_id.clone(),
                            generation: task.generation,
                            summary_json: Some(json),
                            rendered_markdown: Some(summary_to_markdown(&doc)),
                            state: SummaryState::Committed,
                            attempts,
                        });
                        break;
                    }
                    Err(err) => {
                        // EV-06：失败（输出非 Schema V1，按失败尝试计数）
                        emit_summary_background(
                            &background,
                            &task.session_id,
                            "failure",
                            attempts,
                            Some(format!("输出非 Schema V1 文档：{err}")),
                            Some(task.block_id.clone()),
                        );
                        tracing::warn!(
                            block_id = %task.block_id,
                            error = %err,
                            "摘要重试输出非 Schema V1 文档（按失败尝试计数）"
                        );
                    }
                }
            }
            Err(err) => {
                // EV-06：失败（摘要器错误 / 墙钟超时，reason = 错误文本）
                emit_summary_background(
                    &background,
                    &task.session_id,
                    "failure",
                    attempts,
                    Some(err.clone()),
                    Some(task.block_id.clone()),
                );
                tracing::warn!(
                    block_id = %task.block_id,
                    error = %err,
                    "摘要重试失败（attempts={attempts}）"
                );
            }
        }
    }
    let outcome = match outcome {
        Some(outcome) => outcome,
        // E2 F2 层 1：episode 耗尽 → 低功耗待重试（**不 retired 永驻**）。
        // 块保持 awaiting；attempts 达 [SummaryDispatchConfig::max_attempts]
        // 作为「episode 耗尽」标记——壳层可据此发临时通知事件（E2 §7.2
        // provider-diagnostic phase=summary 投影由后续批次接线），不进对话
        None => {
            // EV-06：放弃 → give-up（MAX_SUMMARY_ATTEMPTS 触顶——用户可
            // 据此区分「正在补摘要」与「已放弃」；与 ContextCompressionEnd
            // summaryState=awaiting 语义对齐：awaiting = 本轮放弃待被动触发）
            emit_summary_background(
                &background,
                &task.session_id,
                "give-up",
                attempts,
                Some(format!(
                    "MAX_SUMMARY_ATTEMPTS={} 触顶 → episode 耗尽（awaiting 低功耗待重试）",
                    config.max_attempts
                )),
                Some(task.block_id.clone()),
            );
            SummaryDispatchOutcome {
                session_id: task.session_id,
                block_id: task.block_id,
                generation: task.generation,
                summary_json: None,
                rendered_markdown: None,
                state: SummaryState::Awaiting,
                attempts,
            }
        }
    };
    tracing::info!(
        session_id = %outcome.session_id,
        block_id = %outcome.block_id,
        state = outcome.state.as_str(),
        attempts = outcome.attempts,
        "摘要后台任务结束（结果经回调移交壳层 / 只落日志）"
    );
    if let Some(callback) = on_done {
        callback(outcome);
    }
}

/// 单次摘要调用（墙钟上限内；阻塞调用经 spawn_blocking 承接——trait 为
/// 同步签名，真实实现可能涉及网络往返，不占用主循环 worker）。
/// D10-A：收敛到 [summarize_via_blocking] 单源实现。
#[allow(dead_code)]
async fn summarize_once(task: &SummaryDispatchTask, max_wall_ms: u64) -> Result<String, String> {
    summarize_once_with_abort(task, max_wall_ms, None).await
}

/// 支持 AbortSignal 抢断的单次摘要调用（SL-PERF-04）
async fn summarize_once_with_abort(
    task: &SummaryDispatchTask,
    max_wall_ms: u64,
    abort_signal: Option<&AbortSignal>,
) -> Result<String, String> {
    summarize_via_blocking_with_abort(
        task.summarizer.clone(),
        task.dropped.clone(),
        task.existing.clone(),
        max_wall_ms,
        abort_signal,
    )
    .await
}

/// 摘要 spawn_blocking 单源 helper（D10-A / U-SUMMARY · OVL-06）。
///
/// 与后台 [summarize_once] 同源：`spawn_blocking` + `tokio::time::timeout`
/// 墙钟承接同步 Summarizer（trait 为同步签名，实现可能网络往返）。
/// **禁止**在 compaction / dispatch 侧再写第二份阻塞纪律——预检/边界/
/// 溢出路径一律经本 helper 预计算摘要后传入引擎
/// `compact_agent_messages_with_stub_policy` 的 `summarize_precomputed`
/// （DEL-9：run loop 无同步 summarize 直调）。
pub(crate) async fn summarize_via_blocking(
    summarizer: Arc<dyn Summarizer>,
    dropped: Vec<AgentMessage>,
    existing: Option<String>,
    max_wall_ms: u64,
) -> Result<String, String> {
    summarize_via_blocking_with_abort(summarizer, dropped, existing, max_wall_ms, None).await
}

/// 支持 AbortSignal 抢断的阻塞摘要 helper（SL-PERF-04 / D10-A / U-SUMMARY · OVL-06）
///
/// 与 `abort_signal.wait_aborted()` 进行 `tokio::select!` 竞速：若在阻塞计算或超时等待期间触发中止，
/// 立即返回中断错误，避免主循环卡死达 60s 墙钟上限。
pub(crate) async fn summarize_via_blocking_with_abort(
    summarizer: Arc<dyn Summarizer>,
    dropped: Vec<AgentMessage>,
    existing: Option<String>,
    max_wall_ms: u64,
    abort_signal: Option<&AbortSignal>,
) -> Result<String, String> {
    if let Some(sig) = abort_signal {
        if sig.is_aborted() {
            return Err("摘要调用被中断（abort 信号已置位）".to_string());
        }
    }
    let call =
        tokio::task::spawn_blocking(move || summarizer.summarize(&dropped, existing.as_deref()));
    let timeout_fut = tokio::time::timeout(Duration::from_millis(max_wall_ms), call);

    let res = if let Some(sig) = abort_signal {
        tokio::select! {
            biased;
            _ = sig.wait_aborted() => {
                return Err("摘要调用被中断（abort 信号触发）".to_string());
            }
            r = timeout_fut => r,
        }
    } else {
        timeout_fut.await
    };

    match res {
        Ok(Ok(Ok(text))) => Ok(text),
        Ok(Ok(Err(err))) => Err(err),
        Ok(Err(err)) => Err(format!("摘要任务 panic：{err}")),
        Err(_) => Err(format!("摘要调用超时（> {max_wall_ms}ms 墙钟上限）")),
    }
}

/// 退避延迟（±jitter；jitter <= 0.0 时返回 base——确定性序列供测试断言）。
/// 抖动以时间种子生成（无 rand 依赖），幅度钳制在 [0.0, 0.2] 内。
pub(super) fn jittered_ms(base: u64, jitter: f64) -> u64 {
    if jitter <= 0.0 {
        return base;
    }
    let jitter = jitter.min(0.2);
    let seed = conex_shared::time::unix_millis();
    // [-1, 1) 伪随机（时间种子低位）
    let spread = ((seed % 2001) as f64 / 2000.0) * 2.0 - 1.0;
    let scaled = base as f64 * (1.0 + spread * jitter);
    scaled.max(1.0) as u64
}
