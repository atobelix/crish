//! stream_error_retry.rs（W3-T1 · 看门狗与长程弹性退避心跳租约协同）
//!
//! 核心职责（03 §二 专项改进一）：
//! 1. **消除看门狗 120s 刚性误杀**：在大模型 429 RateLimit（最高达 600s 退避）或
//!    瞬态网络故障休眠期间，向 [ActiveRun] 显式登记 [ExecutionPhase::Suspended]
//!    时效租约（Lease），看门狗巡检依据租约动态豁免放行；
//! 2. **执行阶段动态租约状态机**：退避 sleep 前登记挂起租约并刷新心跳，sleep 唤醒
//!    （或被 abort 取消）后无缝切回 [ExecutionPhase::Active] 活跃推进态；
//! 3. **AbortSignal 竞速感知**：休眠让渡期间实时监听用户取消信号，取消时立即唤醒退出，
//!    不盲目阻塞线程；
//! 4. **工业级 Full Jitter 弹性退避**：消除瞬态网络恢复时的集中惊群风暴。

use std::time::Duration;
use tracing::{debug, info};

use crate::run::{ActiveRun, SuspensionReason};

/// 弹性重试最大等待上限（ms；支持最高 600 秒 429 弹性退避）
pub const MAX_ELASTIC_BUDGET_CAP_MS: u64 = 600_000;
/// 瞬态网络错误重试基础延迟（ms）
pub const TRANSIENT_BACKOFF_BASE_MS: u64 = 750;
/// 瞬态网络错误单次等待封顶（ms）
pub const TRANSIENT_MAX_DELAY_MS: u64 = 8_000;

/// 重试休眠被外部打断（例如用户点击 Cancel 或 L3 强停触发 AbortSignal）
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("重试退避休眠被 AbortSignal 打断取消")]
pub struct RetrySleepInterrupted;

/// 计算工业标准 Full Jitter（全随机抖动）退避时长
///
/// 公式：`sleep = random_between(0, min(max_ms, base_ms * 2^(attempt - 1)))`
/// 消除网络或上游恢复时成百上千个 Agent 同时重试的惊群效应。
pub fn calculate_full_jitter_delay(base_ms: u64, max_ms: u64, attempt: u32) -> Duration {
    let exponent = (attempt.max(1) - 1).min(31);
    let backoff_limit = base_ms.saturating_mul(1u64 << exponent).min(max_ms);

    if backoff_limit == 0 {
        return Duration::ZERO;
    }

    // 生成 [0, backoff_limit] 之间的伪随机毫秒
    let mut random_bytes = [0u8; 8];
    if getrandom::getrandom(&mut random_bytes).is_ok() {
        let rand_val = u64::from_le_bytes(random_bytes);
        let jittered = rand_val % (backoff_limit + 1);
        Duration::from_millis(jittered)
    } else {
        // 降级使用中位数防退化
        Duration::from_millis(backoff_limit / 2)
    }
}

/// 计算 429 RateLimit 弹性退避时长
///
/// 优先使用供应商响应中的 `Retry-After: N`，并钳制在 `[0, min(MAX_ELASTIC_BUDGET_CAP_MS, remaining_budget)]`
pub fn calculate_rate_limit_delay(
    retry_after_ms: Option<u64>,
    elapsed_ms: u64,
    total_budget_ms: u64,
) -> Option<Duration> {
    if elapsed_ms >= total_budget_ms {
        return None;
    }
    let remaining = total_budget_ms.saturating_sub(elapsed_ms);
    let wait_ms = match retry_after_ms {
        Some(after) => after.min(MAX_ELASTIC_BUDGET_CAP_MS),
        None => 5_000, // 缺省 5 秒
    };
    Some(Duration::from_millis(wait_ms.min(remaining)))
}

/// 协同休眠核心函数：登记挂起租约 → 与 AbortSignal 竞速 sleep → 唤醒后切回 Active
///
/// 契约保证：
/// 1. sleep 之前 `active.enter_suspended_phase(delay, reason)`，租约在物理休眠前生效；
/// 2. 无论正常唤醒、睡眠完成还是遇 Abort 中途退出，均确保恢复为 `active.enter_active_phase()`；
/// 3. 若发生 AbortSignal 触发，立即返回 `Err(RetrySleepInterrupted)`。
pub async fn sleep_with_suspended_phase(
    active: &ActiveRun,
    delay: Duration,
    reason: SuspensionReason,
) -> Result<(), RetrySleepInterrupted> {
    if delay.is_zero() {
        return Ok(());
    }

    if active.abort_signal.is_aborted() {
        return Err(RetrySleepInterrupted);
    }

    // 1. 登记执行阶段时效租约并刷新心跳
    active.enter_suspended_phase(delay, reason);
    debug!(
        run_id = %active.run_id,
        session_id = %active.session_id,
        delay_ms = delay.as_millis(),
        "进入执行阶段挂起租约（看门狗已获准动态豁免）"
    );

    // 2. 与 AbortSignal 竞速异步休眠
    let sleep_fut = tokio::time::sleep(delay);
    tokio::pin!(sleep_fut);

    let interrupted = loop {
        tokio::select! {
            biased;
            _ = &mut sleep_fut => {
                break false;
            }
            _ = tokio::time::sleep(Duration::from_millis(50)) => {
                if active.abort_signal.is_aborted() {
                    break true;
                }
            }
        }
    };

    // 3. 唤醒/退出：无缝切回 Active 活跃推进态
    active.enter_active_phase();
    debug!(
        run_id = %active.run_id,
        session_id = %active.session_id,
        interrupted,
        "唤醒并切回执行阶段活跃态（心跳已刷新）"
    );

    if interrupted {
        Err(RetrySleepInterrupted)
    } else {
        Ok(())
    }
}

/// 处于大模型 429 RateLimit 时进入长程挂起退避休眠
pub async fn sleep_rate_limit_backoff(
    active: &ActiveRun,
    delay: Duration,
    retry_after_ms: Option<u64>,
    elapsed_ms: u64,
    total_budget_ms: u64,
) -> Result<(), RetrySleepInterrupted> {
    info!(
        run_id = %active.run_id,
        session_id = %active.session_id,
        delay_secs = delay.as_secs(),
        retry_after_ms = ?retry_after_ms,
        "触发 429 RateLimit 弹性退避休眠，登记执行阶段时效租约"
    );
    let reason = SuspensionReason::RateLimitBackoff {
        retry_after_ms,
        elapsed_ms,
        total_budget_ms,
    };
    sleep_with_suspended_phase(active, delay, reason).await
}

/// 处于瞬态网络故障时进入指数退避休眠
pub async fn sleep_transient_network_backoff(
    active: &ActiveRun,
    delay: Duration,
    attempt: u32,
) -> Result<(), RetrySleepInterrupted> {
    debug!(
        run_id = %active.run_id,
        session_id = %active.session_id,
        attempt,
        delay_ms = delay.as_millis(),
        "触发瞬态网络错误指数退避休眠，登记执行阶段时效租约"
    );
    let reason = SuspensionReason::TransientNetworkBackoff { attempt };
    sleep_with_suspended_phase(active, delay, reason).await
}

/// 处于断路器冷却中进入挂起休眠
pub async fn sleep_circuit_breaker_cooling(
    active: &ActiveRun,
    delay: Duration,
    cooldown_until_ms: u64,
) -> Result<(), RetrySleepInterrupted> {
    info!(
        run_id = %active.run_id,
        session_id = %active.session_id,
        cooldown_until_ms,
        "进入三态断路器冷却挂起休眠，登记执行阶段时效租约"
    );
    let reason = SuspensionReason::CircuitBreakerCooling { cooldown_until_ms };
    sleep_with_suspended_phase(active, delay, reason).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core_event_bridge::{Emitter, EventBridge};
    use crate::engine_channels::BufferedRunEventBridge;
    use crate::run::run_approval::ApprovalGateImpl;
    use crate::run::run_core::ExecutionPhase;
    use orchestrator::events::EventQueue;
    use orchestrator::run::RunHandle;
    use session_loop::{AbortSignal, ControlBus};
    use std::sync::{Arc, Mutex};

    /// 记录型发射器（事件桥测试替身）
    #[derive(Default)]
    struct RecordingEmitter(Mutex<Vec<String>>);

    impl Emitter for RecordingEmitter {
        fn emit(&self, _channel: &str, payload: &str) {
            self.0.lock().unwrap().push(payload.to_string());
        }
    }

    fn test_active_run() -> ActiveRun {
        let store = Arc::new(orchestrator::persist::InMemoryStore::new());
        let queue = Arc::new(tokio::sync::Mutex::new(EventQueue::new(
            store.clone(),
            0,
            None,
        )));
        let bus = Arc::new(Mutex::new(ControlBus::new()));
        let abort = AbortSignal::new();
        let emitter = Arc::new(RecordingEmitter::default());
        let bridge = Arc::new(BufferedRunEventBridge::new(
            EventBridge::new("test", emitter),
            "r1",
        ));
        let handle = Arc::new(tokio::sync::Mutex::new(RunHandle::new(
            "r1",
            "s1",
            conex_db::RunStatus::Running,
        )));
        let approval = Arc::new(ApprovalGateImpl::new(
            "r1".to_string(),
            "s1".to_string(),
            None,
            Box::new(|_| {}),
            Arc::clone(&handle),
            store,
            None,
        ));

        ActiveRun::new(
            "s1".to_string(),
            "r1".to_string(),
            handle,
            queue,
            bus,
            abort,
            approval,
            bridge,
            false,
            None,
            None,
            conex_types::PermissionMode::default(),
            String::new(),
        )
    }

    #[tokio::test]
    async fn sleep_with_suspended_phase_normal_cycle() {
        let active = test_active_run();
        assert_eq!(active.suspended_until_ms(), None);

        let delay = Duration::from_millis(60);
        let result = sleep_with_suspended_phase(
            &active,
            delay,
            SuspensionReason::TransientNetworkBackoff { attempt: 1 },
        )
        .await;

        assert!(result.is_ok(), "正常休眠应成功完成");
        // 休眠结束后已恢复为 Active
        assert_eq!(active.suspended_until_ms(), None);
        assert_eq!(*active.phase.read().unwrap(), ExecutionPhase::Active);
    }

    #[tokio::test]
    async fn sleep_with_suspended_phase_aborted_early() {
        let active = test_active_run();
        let delay = Duration::from_millis(1000);

        let abort_clone = active.abort_signal.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            abort_clone.abort();
        });

        let result = sleep_with_suspended_phase(
            &active,
            delay,
            SuspensionReason::TransientNetworkBackoff { attempt: 2 },
        )
        .await;

        assert!(result.is_err(), "提前 Abort 应返回打断错误");
        assert_eq!(result.unwrap_err(), RetrySleepInterrupted);
        // 打断后仍安全恢复为 Active 态
        assert_eq!(active.suspended_until_ms(), None);
        assert_eq!(*active.phase.read().unwrap(), ExecutionPhase::Active);
    }

    #[test]
    fn test_calculate_rate_limit_delay() {
        let delay = calculate_rate_limit_delay(Some(300_000), 50_000, 600_000).unwrap();
        assert_eq!(delay, Duration::from_secs(300));

        let expired = calculate_rate_limit_delay(Some(300_000), 600_000, 600_000);
        assert_eq!(expired, None);
    }
}
