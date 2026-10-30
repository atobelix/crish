//! retry.rs 流封装域测试旁挂（SR-06e · 拆分 · ≠ EL；经 #[path] 接线，非直接 mod）
//!
//! 原 retry.rs `mod tests` 的流封装域部分（provider_stream 重试循环 / 可中断睡眠 /
//! M14 观测器发射）整段搬入，零删除零合并；测试名与断言形状不变。
//! default_policy / server_error 两个极短辅助在决策域与流封装域旁挂文件内各自重建
//! （模块作用域隔离，避免跨测试模块可见性耦合）。

use super::*;
use crate::error::ProviderError;
use crate::events::{ModelRequestInfo, ModelRequestObserver, ModelResponseInfo};
use crate::sse::AbortFlag;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;

/// 测试用策略：显式开启 3 次重试
fn default_policy() -> RetryPolicy {
    RetryPolicy {
        max_retries: 3,
        ..RetryPolicy::default()
    }
}

fn server_error() -> ProviderError {
    ProviderError::Server {
        status: Some(503),
        body_hint: None,
    }
}

/// 测试 sleeper：记录每次等待时长并立即完成（不耗真实时间）
struct MockSleeper {
    sleeps: Vec<Duration>,
}

#[async_trait]
impl RetrySleeper for MockSleeper {
    async fn sleep(&mut self, duration: Duration) -> Result<(), ProviderError> {
        self.sleeps.push(duration);
        Ok(())
    }
}

// ── 高层封装 provider_stream ──

/// 可重试错误按指数退避重试直到成功
#[tokio::test]
async fn provider_stream_retries_then_succeeds() {
    let policy = default_policy();
    let attempts = Arc::new(AtomicU32::new(0));
    let counter = attempts.clone();
    let mut sleeper = MockSleeper { sleeps: Vec::new() };
    let mut state = RetryState::new();
    let frames = provider_stream(&policy, &mut sleeper, &mut state, move || {
        let counter = counter.clone();
        async move {
            let n = counter.fetch_add(1, Ordering::SeqCst);
            if n < 2 {
                StreamAttempt {
                    frames: vec![],
                    error: Some(server_error()),
                    produced_content: false,
                }
            } else {
                StreamAttempt {
                    frames: vec![],
                    error: None,
                    produced_content: false,
                }
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(attempts.load(Ordering::SeqCst), 3);
    assert_eq!(state.retries, 2);
    assert_eq!(
        sleeper.sleeps,
        vec![Duration::from_millis(750), Duration::from_millis(1500)]
    );
    assert!(frames.is_empty());
}

/// 不可重试错误立即上抛（不重试）
#[tokio::test]
async fn provider_stream_no_retry_on_non_retryable() {
    let policy = default_policy();
    let attempts = Arc::new(AtomicU32::new(0));
    let counter = attempts.clone();
    let mut sleeper = MockSleeper { sleeps: Vec::new() };
    let mut state = RetryState::new();
    let error = provider_stream(&policy, &mut sleeper, &mut state, move || {
        let counter = counter.clone();
        async move {
            counter.fetch_add(1, Ordering::SeqCst);
            StreamAttempt {
                frames: vec![],
                error: Some(ProviderError::Auth { status: Some(401) }),
                produced_content: false,
            }
        }
    })
    .await
    .unwrap_err();
    assert!(matches!(error, ProviderError::Auth { .. }));
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
    assert!(sleeper.sleeps.is_empty());
}

/// 达到 max_retries 后停止重试并上抛
#[tokio::test]
async fn provider_stream_stops_after_max_retries() {
    let policy = RetryPolicy {
        max_retries: 2,
        ..RetryPolicy::default()
    };
    let attempts = Arc::new(AtomicU32::new(0));
    let counter = attempts.clone();
    let mut sleeper = MockSleeper { sleeps: Vec::new() };
    let mut state = RetryState::new();
    let error = provider_stream(&policy, &mut sleeper, &mut state, move || {
        let counter = counter.clone();
        async move {
            counter.fetch_add(1, Ordering::SeqCst);
            StreamAttempt {
                frames: vec![],
                error: Some(server_error()),
                produced_content: false,
            }
        }
    })
    .await
    .unwrap_err();
    assert!(matches!(error, ProviderError::Server { .. }));
    assert_eq!(attempts.load(Ordering::SeqCst), 3);
    assert_eq!(
        sleeper.sleeps,
        vec![Duration::from_millis(750), Duration::from_millis(1500)]
    );
}

/// 流已产出内容时中途错误不重试（02 §六.7 语义）
#[tokio::test]
async fn provider_stream_no_retry_after_content_produced() {
    let policy = default_policy();
    let attempts = Arc::new(AtomicU32::new(0));
    let counter = attempts.clone();
    let mut sleeper = MockSleeper { sleeps: Vec::new() };
    let mut state = RetryState::new();
    let error = provider_stream(&policy, &mut sleeper, &mut state, move || {
        let counter = counter.clone();
        async move {
            let n = counter.fetch_add(1, Ordering::SeqCst);
            StreamAttempt {
                frames: vec![],
                error: Some(server_error()),
                // 第二次尝试已产出内容：即使错误可重试也不再重试
                produced_content: n > 0,
            }
        }
    })
    .await
    .unwrap_err();
    assert!(matches!(error, ProviderError::Server { .. }));
    assert_eq!(attempts.load(Ordering::SeqCst), 2);
    assert_eq!(sleeper.sleeps, vec![Duration::from_millis(750)]);
}

/// abort 直接传播：错误本身为 Aborted 时立即上抛
#[tokio::test]
async fn provider_stream_abort_propagates() {
    let policy = default_policy();
    let mut sleeper = MockSleeper { sleeps: Vec::new() };
    let mut state = RetryState::new();
    let error = provider_stream(&policy, &mut sleeper, &mut state, || async {
        StreamAttempt {
            frames: vec![],
            error: Some(ProviderError::Aborted),
            produced_content: false,
        }
    })
    .await
    .unwrap_err();
    assert_eq!(error, ProviderError::Aborted);
    assert!(sleeper.sleeps.is_empty());
}

/// TokioSleeper：等待期间 abort 中断睡眠（对齐 TS delay 可中断）
#[tokio::test]
async fn tokio_sleeper_abort_interrupts_delay() {
    let (flag, abort) = AbortFlag::new();
    let mut sleeper = TokioSleeper::new(abort);
    let handle = tokio::spawn(async move { sleeper.sleep(Duration::from_secs(60)).await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    flag.abort();
    let error = handle.await.unwrap().unwrap_err();
    assert_eq!(error, ProviderError::Aborted);
}

/// 高层封装 + 总预算：超出预算即停止（TokioSleeper 真实退避等待）
#[tokio::test(start_paused = true)]
async fn provider_stream_respects_total_budget() {
    let policy = RetryPolicy {
        max_retries: 10,
        base_delay_ms: 750,
        max_delay_ms: 8_000,
        total_budget_ms: 2_000,
    };
    let (_flag, abort) = AbortFlag::new();
    let mut sleeper = TokioSleeper::new(abort);
    let attempts = Arc::new(AtomicU32::new(0));
    let counter = attempts.clone();
    let handle = tokio::spawn(async move {
        let mut state = RetryState::new();
        provider_stream(&policy, &mut sleeper, &mut state, move || {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                StreamAttempt {
                    frames: vec![],
                    error: Some(server_error()),
                    produced_content: false,
                }
            }
        })
        .await
    });
    // 让任务注册首个 sleep 后按退避节奏推进时钟：
    // 第一次退避 750ms（预算剩 1250），第二次退避钳到剩余预算 1250ms
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(750)).await;
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(1_250)).await;
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(10_000)).await;
    let error = handle.await.unwrap().unwrap_err();
    assert!(matches!(error, ProviderError::Server { .. }));
    // 尝试 1 失败 → 等 750ms → 尝试 2 失败 → 等 1250ms → 尝试 3（预算耗尽，停止）
    assert_eq!(attempts.load(Ordering::SeqCst), 3);
}

// ── M14：model 请求生命周期观测器（before-request / after-response 发射点）──

/// 记录式观测器：按序记录 before/after 事件
struct RecordingObserver {
    before: Arc<std::sync::Mutex<Vec<u32>>>,
    after: Arc<std::sync::Mutex<Vec<bool>>>,
}

impl RecordingObserver {
    fn new() -> Self {
        Self {
            before: Arc::new(std::sync::Mutex::new(Vec::new())),
            after: Arc::new(std::sync::Mutex::new(Vec::new())),
        }
    }

    fn events(&self) -> (Vec<u32>, Vec<bool>) {
        (
            self.before.lock().unwrap().clone(),
            self.after.lock().unwrap().clone(),
        )
    }
}

impl ModelRequestObserver for RecordingObserver {
    fn on_before_request(&self, info: &ModelRequestInfo) {
        self.before.lock().unwrap().push(info.attempt);
    }

    fn on_after_response(&self, info: &ModelResponseInfo) {
        self.after.lock().unwrap().push(info.ok);
    }
}

/// 每次尝试「请求前 → 尝试 → 响应后」成对发射；重试循环内每次尝试均发射
/// （before-request 的 attempt 从 1 起递增）
#[tokio::test]
async fn observer_emits_before_and_after_per_attempt() {
    let policy = default_policy();
    let observer = RecordingObserver::new();
    let attempts = Arc::new(AtomicU32::new(0));
    let counter = attempts.clone();
    let mut sleeper = MockSleeper { sleeps: Vec::new() };
    let mut state = RetryState::new();
    let result = provider_stream_with_observer(
        &policy,
        &mut sleeper,
        &mut state,
        Some(&observer),
        move || {
            let counter = counter.clone();
            async move {
                let n = counter.fetch_add(1, Ordering::SeqCst);
                if n < 2 {
                    StreamAttempt {
                        frames: vec![],
                        error: Some(server_error()),
                        produced_content: false,
                    }
                } else {
                    StreamAttempt {
                        frames: vec![],
                        error: None,
                        produced_content: false,
                    }
                }
            }
        },
    )
    .await
    .unwrap();
    assert!(result.is_empty());
    let (before, after) = observer.events();
    // 3 次尝试：before-request 各一次（attempt 1/2/3），after-response 各一次
    assert_eq!(before, vec![1, 2, 3], "请求前每次尝试发射且 attempt 递增");
    assert_eq!(
        after,
        vec![false, false, true],
        "响应后每次尝试发射（ok 标记）"
    );
    // 发射顺序保证：before 先于对应 after（成对配对）
    assert_eq!(before.len(), after.len(), "before/after 必须成对");
}

/// 成功路径只发射一对 before/after（无重试时 attempt 恒为 1）
#[tokio::test]
async fn observer_single_attempt_on_success() {
    let policy = default_policy();
    let observer = RecordingObserver::new();
    let mut sleeper = MockSleeper { sleeps: Vec::new() };
    let mut state = RetryState::new();
    let result = provider_stream_with_observer(
        &policy,
        &mut sleeper,
        &mut state,
        Some(&observer),
        || async {
            StreamAttempt {
                frames: vec![],
                error: None,
                produced_content: false,
            }
        },
    )
    .await
    .unwrap();
    assert!(result.is_empty());
    let (before, after) = observer.events();
    assert_eq!(before, vec![1]);
    assert_eq!(after, vec![true]);
    assert!(sleeper.sleeps.is_empty());
}

/// 观测器不改变重试语义：不可重试错误只发射一对后上抛
#[tokio::test]
async fn observer_non_retryable_single_pair() {
    let policy = default_policy();
    let observer = RecordingObserver::new();
    let mut sleeper = MockSleeper { sleeps: Vec::new() };
    let mut state = RetryState::new();
    let error = provider_stream_with_observer(
        &policy,
        &mut sleeper,
        &mut state,
        Some(&observer),
        || async {
            StreamAttempt {
                frames: vec![],
                error: Some(ProviderError::Auth { status: Some(401) }),
                produced_content: false,
            }
        },
    )
    .await
    .unwrap_err();
    assert!(matches!(error, ProviderError::Auth { .. }));
    let (before, after) = observer.events();
    assert_eq!(before, vec![1], "不可重试：只发射一次 before");
    assert_eq!(after, vec![false], "失败尝试 after-response 标记 ok=false");
}

/// 无观测器时行为与既有 provider_stream 一致（零事件零开销）
#[tokio::test]
async fn without_observer_emits_nothing() {
    let policy = default_policy();
    let mut sleeper = MockSleeper { sleeps: Vec::new() };
    let mut state = RetryState::new();
    let observer: Option<&dyn ModelRequestObserver> = None;
    let result =
        provider_stream_with_observer(&policy, &mut sleeper, &mut state, observer, || async {
            StreamAttempt {
                frames: vec![],
                error: None,
                produced_content: false,
            }
        })
        .await
        .unwrap();
    assert!(result.is_empty());
}
