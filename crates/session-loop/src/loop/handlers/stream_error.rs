//! handleStreamError（01 §2.5：传输/服务端错误处理阶梯）
//!
//! 错误按分类进入恢复阶梯，**不误伤文字回复**（错误已在 streaming 分类层
//! 与模型输出分离，01 D5/D6）：
//! - 瞬态 provider 错误（02 §4.2 retryable：RateLimit / ServerError /
//!   Timeout / Network）：重试上限 3（默认），provider-diagnostic 事件 +
//!   NO_PROGRESS_CONTINUE（01 §2.5 步骤 2，上限可配置）；
//! - 长度/上下文超限（ContextLengthExceeded）：length 恢复阶梯
//!   8192→16384→32768，上限 2 次升级（01 §2.6 步骤 1 共用）；**阶梯用尽后
//!   接压缩阶梯**（P4 §3.5）——两个维度正交（输出预算 / 输入预算），
//!   都做了才覆盖两类超限；
//! - payload-too-large：**真实压缩阶梯**（P4 §3.5，代替 T06.2.2 删除的
//!   「假恢复」阶梯——请求体不变时重试必败；压缩对话后请求体真实变化，
//!   重试一次是真实恢复）；仍失败才 fatal（诊断含压缩后 token 数）；
//! - 其余（不可重试）：PROVIDER_ERROR + endReason=error（01 §1.6 四事件）。
//!
//! SR-06c · 拆分 · ≠ EL：本文件为分类面门面——handle 入口 + 公共面
//! re-export（stream_error::* 路径不 break）；恢复面拆至
//! stream_error_retry.rs（瞬态重试）/ stream_error_recover.rs（超限阶梯）/
//! stream_error_fatal.rs（降级 fatal）；测试旁挂 stream_error_tests.rs
//! （`#[path]` 接线，无孤儿）。

use conex_types::error::ProviderErrorKind;
use conex_types::response::ClassifiedStreamError;

use super::super::handlers::{HandlerOutcome, LoopState};
use super::super::LoopError;
use super::streaming::streaming_aborted;

#[path = "stream_error_retry.rs"]
mod retry;
#[path = "stream_error_recover.rs"]
mod recover;
#[path = "stream_error_fatal.rs"]
mod fatal;

// 公共面 re-export（外部经 stream_error::* 引用不 break：no_tool_calls.rs
// 的 MAX_LENGTH_UPGRADES、loop options 装配的 MAX_OVERFLOW_COMPRESSION_RETRIES、
// EV-03 length 升级诊断 emit_length_escalation_diagnostic）
pub(crate) use recover::{MAX_LENGTH_UPGRADES, MAX_OVERFLOW_COMPRESSION_RETRIES};
pub(crate) use retry::emit_length_escalation_diagnostic;

// handle 分派消费的恢复阶梯入口（生产路径）
use fatal::fatal_provider_error;
use recover::{compression_ladder, length_ladder};
use retry::transient_retry;

// 测试旁挂消费的纯函数面（cfg(test) 避免非测试构建 unused-import）
#[cfg(test)]
use recover::OVERFLOW_KEEP_RECENT_STAIRCASE;
#[cfg(test)]
use retry::retry_delay_ms;

/// stream error handler（01 §2.5）
pub(crate) async fn handle(
    state: &mut LoopState,
    classified: ClassifiedStreamError,
) -> Result<HandlerOutcome, LoopError> {
    // Q40（T09.9）：重试决策前先查 abort，取消则跳过剩余阶梯直接收场
    // （与 streaming 的 abort 收场路径共享，避免无效请求。AA-01 Q40）
    if state.abort_signal.is_aborted() {
        return streaming_aborted(state);
    }
    tracing::info!(
        kind = ?classified.kind,
        error_code = %classified.kind.code(),
        retryable = classified.retryable,
        "provider 流错误"
    );
    match classified.kind {
        // 瞬态 provider 错误：重试阶梯（01 §2.5 步骤 2；D1：退避 + 预算 +
        // Retry-After + 熔断闸）
        ProviderErrorKind::RateLimit
        | ProviderErrorKind::ServerError
        | ProviderErrorKind::Timeout
        | ProviderErrorKind::Network => transient_retry(state, &classified).await,
        // 长度/上下文超限：length 恢复阶梯（8192→16384→32768，上限 2 次）；
        // 用尽后接压缩阶梯（P4 §3.5，输入超限维度——只放大输出预算对
        // 输入超限无效，comparison.md:24）
        ProviderErrorKind::ContextLengthExceeded => length_ladder(state, &classified).await,
        // payload 过大：压缩阶梯（P4 §3.5）——真实压缩 + 重试一次，
        // 代替 T06.2.2 的假恢复（请求体不变时重试必败）与直接 fatal
        ProviderErrorKind::PayloadTooLarge => compression_ladder(state, &classified).await,
        // 其余（Auth / Quota / InvalidRequest / Unknown / Aborted 等）：不可重试
        _ => fatal_provider_error(state, &classified),
    }
}

#[cfg(test)]
mod tests {
    // 测试旁挂分三段（crate-size 门禁对 src 内每个文件限 600 行，故用
    // include! 合成单一 tests 模块——测试路径 stream_error::tests::* 不 break）
    include!("stream_error_tests.rs");
    include!("stream_error_tests_ladder.rs");
    include!("stream_error_tests_e2.rs");
}
