//! 指数退避重试器（任务书 B2.7；02-provider-semantics.md §四.3、§六.8）
//!
//! 对齐 TS 端 openai-retry.ts：
//! - 退避 `min(max_delay, base * 2^(attempt-1))`，默认 750ms 起、8s 封顶；
//! - Retry-After 支持秒数与 HTTP-date、上限 5 分钟，与退避取大后再钳
//!   max_delay 与剩余预算（[choose_retry_delay_ms]）；
//! - 总预算 60s（elapsed < total_budget 才继续，对齐 withinRetryBudget）；
//! - delay 可被 abort 中断（[RetrySleeper] + [TokioSleeper]，对齐 TS delay 可中断）；
//! - 仅瞬态类重试：rate-limit / 5xx / 网络 / 超时；auth、quota、context_length
//!   等不可由本循环重试（context_length 由上层压缩处理，00 D5：分类与收口分离）。
//!
//! [provider_stream] 为高层封装：循环发送请求 → 分类错误 → 退避重试，
//! 流已产出内容时中途错误不重试（02 §六.7），abort 一律直接传播。
//!
//! SR-06e · 拆分 · ≠ EL：门面文件。实现域拆分如下（测试旁挂
//! retry_decision_tests.rs / retry_stream_tests.rs，经 #[path] 接线，非直接 mod）：
//! - [retry_decision]：重试策略 / 状态 / 决策域（[RetryPolicy] / [RetryState] /
//!   [RetryDecision] / [should_retry] / [parse_retry_after_ms] / 退避计算）
//! - [retry_stream]：可中断睡眠与高层流封装域（[RetrySleeper] / [TokioSleeper] /
//!   [StreamAttempt] / [provider_stream_with_observer]）

#[path = "retry_decision.rs"]
mod retry_decision;
#[path = "retry_stream.rs"]
mod retry_stream;

pub use retry_decision::{
    choose_retry_delay_ms, parse_retry_after_ms, retry_delay_ms, should_retry, RetryDecision,
    RetryPolicy, RetryState, MAX_RETRY_AFTER_MS,
};
pub use retry_stream::{
    provider_stream, provider_stream_with_observer, RetrySleeper, StreamAttempt, TokioSleeper,
};

#[cfg(test)]
#[path = "retry_decision_tests.rs"]
mod decision_tests;
#[cfg(test)]
#[path = "retry_stream_tests.rs"]
mod stream_tests;
