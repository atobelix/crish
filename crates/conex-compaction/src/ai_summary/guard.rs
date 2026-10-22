//! 退化重试护栏：重试策略、有界重试驱动与 Summarizer 包装（从 ai_summary.rs 纯搬迁）

use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use conex_types::AgentMessage;

use super::prompt::is_acceptable_summary;
use super::{
    MIN_SUMMARY_SEED_CHARS_DEFAULT, SUMMARY_MAX_ATTEMPTS_DEFAULT,
    SUMMARY_RETRY_INTERVAL_MS_DEFAULT, SUMMARY_WALL_CLOCK_BUDGET_MS_DEFAULT,
};
use crate::compaction::Summarizer;

// ── 退化重试护栏（02 Top 3：空/过短 = 瞬态，重试 N 次后降级）──

/// 摘要重试策略（可配；session_meta 键见常量定义，默认值对齐 grok
/// code_compaction/config.rs：max_attempts=3、间隔 3s、500 字符下限、
/// wall-clock 预算兜底防推理 runaway）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SummaryRetryPolicy {
    /// 总尝试次数（含首次；默认 3，对齐 grok max_attempts=3）
    pub max_attempts: u32,
    /// 两次尝试间等待（默认 3000ms）
    pub retry_interval_ms: u64,
    /// 退化摘要字符下限（默认 500，对齐 grok MIN_SUMMARY_SEED_CHARS）
    pub min_summary_chars: usize,
    /// wall-clock 总预算（默认 300s，对齐 grok wall_clock_budget_secs=300；
    /// None = 不设墙钟上限）
    pub wall_clock_budget_ms: Option<u64>,
}

impl Default for SummaryRetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: SUMMARY_MAX_ATTEMPTS_DEFAULT,
            retry_interval_ms: SUMMARY_RETRY_INTERVAL_MS_DEFAULT,
            min_summary_chars: MIN_SUMMARY_SEED_CHARS_DEFAULT,
            wall_clock_budget_ms: Some(SUMMARY_WALL_CLOCK_BUDGET_MS_DEFAULT),
        }
    }
}

impl SummaryRetryPolicy {
    /// 边界钳制：max_attempts 至少 1
    pub fn normalized(&self) -> Self {
        Self {
            max_attempts: self.max_attempts.max(1),
            ..self.clone()
        }
    }
}

/// 单轮摘要结果（[summarize_with_guard] 的产出；[RetryGuardSummarizer]
/// 记录最近一次供事件留痕）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SummaryOutcome {
    /// 成功摘要文本（None = 最终降级，调用方回退占位符）
    pub summary: Option<String>,
    /// 是否降级（重试次数耗尽仍失败/退化）
    pub degraded: bool,
    /// 实际尝试次数（含首次）
    pub attempts: u32,
    /// 退化（过短）尝试次数
    pub degenerate_attempts: u32,
    /// 最近一次失败原因（成功时为 None）
    pub last_error: Option<String>,
}

/// 重试决策（纯函数，便于注入时钟测试）：已用次数未达上限且未超墙钟
/// 预算时允许下一次尝试
pub fn retry_allowed(attempts_used: u32, elapsed_ms: u64, policy: &SummaryRetryPolicy) -> bool {
    let policy = policy.normalized();
    if attempts_used >= policy.max_attempts {
        return false;
    }
    match policy.wall_clock_budget_ms {
        Some(budget) => elapsed_ms < budget,
        None => true,
    }
}

fn elapsed_ms_since(started: SystemTime) -> u64 {
    started
        .elapsed()
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// 有界重试摘要驱动：对退化/失败结果至多重试 [SummaryRetryPolicy] 次数，
/// 每次等待 `retry_interval_ms`（由调用方注入 wait，测试可注入立即返回；
/// 生产侧注入真实睡眠/异步调度）。最终失败返回 `degraded=true` 且
/// `summary=None`——调用方（经 [Summarizer] Err 路径）回退既有
/// `[Compacted N...]` 占位符，不阻塞 run。
pub fn summarize_with_guard(
    summarizer: &dyn Summarizer,
    dropped: &[AgentMessage],
    existing: Option<&str>,
    policy: &SummaryRetryPolicy,
    wait: &mut dyn FnMut(Duration),
) -> SummaryOutcome {
    let started = SystemTime::now();
    let mut attempts: u32 = 0;
    let mut degenerate_attempts: u32 = 0;
    let mut last_error: Option<String>;
    loop {
        attempts += 1;
        match summarizer.summarize(dropped, existing) {
            Ok(text) if is_acceptable_summary(&text, policy.min_summary_chars) => {
                return SummaryOutcome {
                    summary: Some(text),
                    degraded: false,
                    attempts,
                    degenerate_attempts,
                    last_error: None,
                };
            }
            Ok(_) => {
                degenerate_attempts += 1;
                last_error = Some(format!(
                    "退化摘要（少于 {} 字符）",
                    policy.min_summary_chars
                ));
            }
            Err(err) => {
                last_error = Some(err);
            }
        }
        if !retry_allowed(attempts, elapsed_ms_since(started), policy) {
            return SummaryOutcome {
                summary: None,
                degraded: true,
                attempts,
                degenerate_attempts,
                last_error,
            };
        }
        wait(Duration::from_millis(policy.retry_interval_ms));
    }
}

/// 摘要器包装：把 [summarize_with_guard] 折叠成 [Summarizer] trait，
/// 可直接注入 [crate::compaction::CompactionEngine::compact_agent_messages]
/// ——成功返回摘要，最终降级返回 Err（引擎回退 L1 占位符，语义不变）；
/// 最近一次 [SummaryOutcome] 由 [Self::last_outcome] 读取，供压缩事件
/// 记录降级事实（02 Top 3「降级事件记录事实，不阻塞会话循环」）。
pub struct RetryGuardSummarizer {
    inner: Box<dyn Summarizer>,
    policy: SummaryRetryPolicy,
    wait: Mutex<Box<dyn FnMut(Duration) + Send>>,
    last: Mutex<Option<SummaryOutcome>>,
}

impl RetryGuardSummarizer {
    /// 构造护栏（wait 由调用方注入：生产侧为真实睡眠/异步调度，
    /// 测试侧可注入立即返回）
    pub fn new(
        inner: Box<dyn Summarizer>,
        policy: SummaryRetryPolicy,
        wait: Box<dyn FnMut(Duration) + Send>,
    ) -> Self {
        Self {
            inner,
            policy,
            wait: Mutex::new(wait),
            last: Mutex::new(None),
        }
    }

    /// 最近一次摘要尝试结果（供事件留痕；尚未调用时为 None）
    pub fn last_outcome(&self) -> Option<SummaryOutcome> {
        self.last.lock().ok().and_then(|guard| guard.clone())
    }

    /// 当前重试策略（只读）
    pub fn policy(&self) -> &SummaryRetryPolicy {
        &self.policy
    }
}

impl Summarizer for RetryGuardSummarizer {
    fn summarize(
        &self,
        dropped: &[AgentMessage],
        existing: Option<&str>,
    ) -> Result<String, String> {
        let mut wait = self.wait.lock().expect("护栏 wait 锁可用");
        let outcome = summarize_with_guard(
            self.inner.as_ref(),
            dropped,
            existing,
            &self.policy,
            &mut *wait,
        );
        let result = outcome.summary.clone().ok_or_else(|| {
            outcome
                .last_error
                .clone()
                .unwrap_or_else(|| "摘要退化：重试次数耗尽".to_string())
        });
        if let Ok(mut last) = self.last.lock() {
            *last = Some(outcome);
        }
        result
    }
}
