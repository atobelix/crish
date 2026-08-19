// SR-06c · 拆分 · ≠ EL：stream_error.rs 测试旁挂（include! 接线，无孤儿；
// 全部既有测试原样保留）。
use super::*;
use conex_types::events::AgentEvent;
    use crate::r#loop::handlers::LoopState;
    use crate::steering::{
        RecoverySteeringStrategy, SteeringCoordinator, SteeringCoordinatorOptions,
    };
    use crate::r#loop::{DEFAULT_MAX_TOKENS, RetryBackoffConfig, SessionLoopOptions};
    use agent_tools::registry::ToolRegistry;
    use conex_compaction::CompactionPolicy;
    use conex_test_utils::clock::TimePauseGuard;
    use conex_types::context::ContextBudget;
    use conex_types::error::ProviderErrorKind;
    use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
    use conex_types::response::ClassifiedStreamError;
    use conex_types::session::{AgentEndReason as R, AgentSessionEvent as E, AgentSessionState as S};
    use conex_types::tool::{ContextCompressionReason, ContextCompressionTrigger};
    use futures::poll;
    use std::sync::Arc;
    use std::time::Duration;

    /// 构造处于 streaming 状态的 LoopState（供重试阶梯单测驱动）
    fn streaming_state() -> LoopState {
        let steering = SteeringCoordinator::new(
            vec![Box::new(RecoverySteeringStrategy::default())],
            SteeringCoordinatorOptions::default(),
        );
        let mut state = LoopState::new(
            "sess-1",
            16,
            steering,
            SessionLoopOptions::default(),
            Arc::new(ToolRegistry::new()),
        );
        state.machine.dispatch(E::Initialized).unwrap();
        state.machine.dispatch(E::InputReady).unwrap();
        state.machine.dispatch(E::TurnPrepared).unwrap();
        assert_eq!(state.machine.state(), S::Streaming);
        state
    }

    /// 带预算/压缩策略的溢出恢复状态（窗口 1 万、阈值 = window - reserve
    /// = 8000；压缩策略 keep_recent_tokens 20000 / min_recent_turns 1——
    /// 对话 10 条 × 5000 字 ≈ 5 万 token：第一次压缩保留段 4 条
    /// （cut=6），第二次压缩（上限 2）仍有可丢内容（cut=3），供新语义
    /// 测试驱动两轮压缩；E2 F2 层 2 上限 2 需要保留段足够长才能二次压缩）。
    ///
    /// E2 F1（LLM 摘要强制）：默认注入成功 Summarizer（模拟生产已接线
    /// ProviderSummarizer，COMPACTION-01 P0-3 闭环）——既有「压缩成功重试」
    /// 语义测试以此为基座；无 Summarizer 默认 fatal 的语义由专项测试
    /// （[Self::overflow_without_summarizer_fatals_with_llm_unavailable_note]）
    /// 构造无注入状态覆盖。
    fn budgeted_state() -> LoopState {
        let mut state = streaming_state();
        let options = {
            let mut o: SessionLoopOptions = SessionLoopOptions::default();
            o.assembly.context_budget = Some(ContextBudget {
                context_window: 10_000,
                reserve_tokens: 2_000,
                safety_tokens: 100,
            });
            o.compaction.compaction_policy = Some(CompactionPolicy {
                keep_recent_tokens: 20_000,
                min_recent_turns: 1,
                ..Default::default()
            });
            o.compaction.max_auto_compactions_per_run = 1;
            o.compaction.summarizer = Some(Arc::new(OkSummarizer));
            o
        };
        // LoopState 构造期从 options 派生 budget/policy——测试内直接改
        // options 需同步派生字段（生产路径经 with_options 派生）
        state.options = options.clone();
        state.budget_state.budget = options.assembly.context_budget;
        state.compaction.compaction_policy = options.compaction.compaction_policy.clone();
        state.compaction.summarizer = options.compaction.summarizer.clone();
        state.conversation = big_conversation();
        state
    }

    /// 成功 Summarizer（E2 F1 基座：LLM 摘要成功 → 压缩路径可完成）
    /// ——合法 Schema V1 JSON 文档（R-G 契约）
    struct OkSummarizer;
    impl conex_compaction::Summarizer for OkSummarizer {
        fn summarize(
            &self,
            _dropped: &[conex_types::message::AgentMessage],
            _existing: Option<&str>,
        ) -> Result<String, String> {
            Ok(serde_json::json!({
                "schemaVersion": 1,
                "blockId": "compacted-summary-1-1",
                "generation": 1,
                "droppedIds": [],
                "height": 1,
                "tier": "chunk",
                "goal": "溢出恢复",
                "constraints": [],
                "progress": ["已压缩上下文"],
                "decisions": [],
                "nextSteps": ["重试请求"],
                "criticalContext": [],
            })
            .to_string())
        }
    }

    /// 超阈值对话：10 条消息 × 5000 字（CJK 逐字符 ≈ 5000 token）≈ 5 万 token
    fn big_conversation() -> Vec<Arc<AgentMessage>> {
        (0..10)
            .map(|i| {
                Arc::new(AgentMessage {
                    id: format!("m{i}"),
                    role: if i % 2 == 0 {
                        AgentMessageRole::User
                    } else {
                        AgentMessageRole::Assistant
                    },
                    created_at: "2026-08-03T10:00:00.000Z".to_string(),
                    blocks: vec![AgentMessageBlock::Text { text: "字".repeat(5_000) }],
                    metadata: None,
                    client_message_id: None,
                    content: None,
                })
            })
            .collect()
    }

    fn transient_error(kind: ProviderErrorKind) -> ClassifiedStreamError {
        ClassifiedStreamError {
            kind,
            message: format!("{kind:?} 模拟错误"),
            retryable: kind.default_retryable(),
            retry_after_ms: None,
        }
    }

    /// 模拟 NO_PROGRESS_CONTINUE 后循环重进 streaming（生产路径由
    /// prepare_turn::handle 步骤 6 的 TURN_PREPARED 转移完成；
    /// 测试驱动多次 handle 调用前必须回到 Streaming 状态）
    fn re_enter_streaming(state: &mut LoopState) {
        state.machine.dispatch(E::TurnPrepared).unwrap();
        assert_eq!(state.machine.state(), S::Streaming);
    }

    /// D1：开启默认退避配置（750/8000/60000）的 streaming 状态
    /// （[SessionLoopOptions::retry_backoff] = Some(默认)——生产退避语义的
    /// 单测驱动面；None = 现状立即重试由既有测试覆盖）
    fn backoff_state() -> LoopState {
        let mut state = streaming_state();
        state.options.retry.retry_backoff = Some(RetryBackoffConfig::default());
        state
    }

    /// D1：429 + Retry-After 的已分类错误（裁决 #3 主场景）
    fn rate_limit_error(retry_after_ms: u64) -> ClassifiedStreamError {
        ClassifiedStreamError {
            kind: ProviderErrorKind::RateLimit,
            message: "429 限流".to_string(),
            retryable: true,
            retry_after_ms: Some(retry_after_ms),
        }
    }

    /// 从事件列表取最近一次重试诊断（断言辅助）
    fn retry_diagnostic(state: &LoopState) -> Option<conex_types::tool::ProviderDiagnostic> {
        state.events.iter().rev().find_map(|e| match e {
            AgentEvent::ProviderDiagnostic { diagnostic, .. } => Some(diagnostic.clone()),
            _ => None,
        })
    }

    // ── D1 退避/预算/Retry-After/abort 竞速/熔断闸（维度 D1 §5.1 T1-T8）──

    /// D1 T6：retry_delay_ms 纯函数决策表——退避序列 750/1500/3000、
    /// 429 放行 5min、5xx 钳 8s、Retry-After 取大、预算耗尽 None、
    /// 指数上限 62 防溢出（镜像 retry.rs:503-514 期望值防漂移）
    #[test]
    fn retry_delay_ms_decision_table() {
        let cfg = RetryBackoffConfig::default();
        // 退避序列：ServerError 无 Retry-After → 750/1500/3000/6000/8000（8s 封顶）
        let expected = [750u64, 1500, 3000, 6000, 8000, 8000];
        for (index, expected_ms) in expected.iter().enumerate() {
            let attempt = index as u32 + 1;
            let delay = retry_delay_ms(
                &cfg,
                ProviderErrorKind::ServerError,
                attempt,
                None,
                0,
            )
            .expect("预算充足必须返回等待");
            assert_eq!(
                delay,
                Duration::from_millis(*expected_ms),
                "attempt {attempt} 退避序列"
            );
        }
        // 429：Retry-After 30s → 等待 = max(750, 30000) = 30s（不被 8s 钳制，裁决 #3）
        let delay = retry_delay_ms(&cfg, ProviderErrorKind::RateLimit, 1, Some(30_000), 0)
            .expect("预算充足必须返回等待");
        assert_eq!(delay, Duration::from_millis(30_000), "429+Retry-After 取大");
        // 429 无 Retry-After：纯退避 750
        let delay = retry_delay_ms(&cfg, ProviderErrorKind::RateLimit, 1, None, 0)
            .expect("预算充足必须返回等待");
        assert_eq!(delay, Duration::from_millis(750));
        // 429 上限 5min：大退避指数下被钳制——60s 总预算下剩余钳制
        // （min(5min, 60s 剩余) = 60s，预算闸兜底）
        let delay = retry_delay_ms(&cfg, ProviderErrorKind::RateLimit, 13, None, 0)
            .expect("预算充足必须返回等待");
        assert_eq!(
            delay,
            Duration::from_millis(60_000),
            "60s 总预算下 429 被剩余预算钳制（预算闸兜底 5min 放行）"
        );
        // 5xx 上限 8s：大指数下被 8s 钳制
        let delay = retry_delay_ms(&cfg, ProviderErrorKind::ServerError, 13, None, 0)
            .expect("预算充足必须返回等待");
        assert_eq!(delay, Duration::from_millis(8_000), "5xx 钳到 8s 上限");
        // Retry-After 超 5min：钳到 min(5min, 剩余预算)（60s 预算下 = 60s）
        let delay = retry_delay_ms(&cfg, ProviderErrorKind::RateLimit, 1, Some(10 * 60_000), 0)
            .expect("预算充足必须返回等待");
        assert_eq!(
            delay,
            Duration::from_millis(60_000),
            "Retry-After 不得突破 5min 上限（预算闸下先钳 60s）"
        );
        // 429 5min 上限可观测面：放大预算（>5min）后 429 钳到 5min 而非
        // 继续放大（裁决 #3 字面：429 突破 8s 封顶放行到 5min）
        let big_budget = RetryBackoffConfig {
            base_ms: None,
            max_ms: None,
            total_budget_ms: Some(400_000),
        };
        let delay = retry_delay_ms(&big_budget, ProviderErrorKind::RateLimit, 13, None, 0)
            .expect("预算充足必须返回等待");
        assert_eq!(
            delay,
            Duration::from_millis(5 * 60_000),
            "429 钳到 5min 上限（预算放大后可观测）"
        );
        // 预算钳制：elapsed 40s（剩余 20s）+ Retry-After 30s → 钳到 20s
        let delay = retry_delay_ms(&cfg, ProviderErrorKind::RateLimit, 1, Some(30_000), 40_000)
            .expect("预算未耗尽必须返回等待");
        assert_eq!(delay, Duration::from_millis(20_000), "剩余预算钳制");
        // 预算耗尽：elapsed >= 60s → None（严格小于，对齐 retry.rs:163-166）
        assert!(retry_delay_ms(&cfg, ProviderErrorKind::ServerError, 1, None, 60_000).is_none());
        assert!(retry_delay_ms(&cfg, ProviderErrorKind::RateLimit, 1, Some(30_000), 60_000).is_none());
        // 指数上限 62 防溢出：attempt 63 → exponent 62 → saturating 不 panic
        let delay = retry_delay_ms(&cfg, ProviderErrorKind::ServerError, 63, None, 0)
            .expect("预算充足必须返回等待");
        assert_eq!(delay, Duration::from_millis(8_000), "指数上限 62 后仍钳 8s");
        // 自定义配置生效：base=100 → 退避 100/200/400；budget=1000 → 预算钳制
        let custom = RetryBackoffConfig {
            base_ms: Some(100),
            max_ms: Some(500),
            total_budget_ms: Some(1_000),
        };
        assert_eq!(
            retry_delay_ms(&custom, ProviderErrorKind::ServerError, 1, None, 0).unwrap(),
            Duration::from_millis(100)
        );
        assert_eq!(
            retry_delay_ms(&custom, ProviderErrorKind::ServerError, 4, None, 0).unwrap(),
            Duration::from_millis(500),
            "自定义 max 钳制"
        );
        assert_eq!(
            retry_delay_ms(&custom, ProviderErrorKind::ServerError, 1, None, 950).unwrap(),
            Duration::from_millis(50),
            "自定义预算剩余钳制"
        );
        assert!(retry_delay_ms(&custom, ProviderErrorKind::ServerError, 1, None, 1_000).is_none());
    }

    /// D1 T1（A1）：退避序列 750/1500/3000（虚拟时钟驱动，零真实等待）——
    /// ServerError 无 Retry-After；每次 handle 间的墙钟推进 = 750/1500/3000；
    /// 诊断事件 elapsed_ms 与等待一致（镜像 retry.rs:503-514 期望值）
    #[tokio::test]
    async fn backoff_sequence_750_1500_3000_virtual_clock() {
        let _time = TimePauseGuard::new();
        let mut state = backoff_state();
        // 第 1 次：等待 750ms（推进 749ms 不完成，第 750ms 完成）
        let mut fut = Box::pin(handle(&mut state, transient_error(ProviderErrorKind::ServerError)));
        assert!(poll!(fut.as_mut()).is_pending(), "首 poll 后应进入退避 sleep");
        tokio::time::advance(Duration::from_millis(749)).await;
        assert!(poll!(fut.as_mut()).is_pending(), "749ms 未到 750ms 不得重试");
        tokio::time::advance(Duration::from_millis(1)).await;
        let o1 = fut.await.unwrap();
        assert!(o1.end.is_none());
        assert_eq!(state.transient_retries, 1);
        assert_eq!(
            retry_diagnostic(&state).map(|d| d.elapsed_ms),
            Some(Some(750)),
            "第 1 次诊断等待 = 750ms"
        );
        re_enter_streaming(&mut state);
        // 第 2 次：等待 1500ms
        let mut fut = Box::pin(handle(&mut state, transient_error(ProviderErrorKind::ServerError)));
        assert!(poll!(fut.as_mut()).is_pending());
        tokio::time::advance(Duration::from_millis(1_499)).await;
        assert!(poll!(fut.as_mut()).is_pending(), "1499ms 未到 1500ms 不得重试");
        tokio::time::advance(Duration::from_millis(1)).await;
        let o2 = fut.await.unwrap();
        assert!(o2.end.is_none());
        assert_eq!(state.transient_retries, 2);
        assert_eq!(retry_diagnostic(&state).map(|d| d.elapsed_ms), Some(Some(1_500)));
        re_enter_streaming(&mut state);
        // 第 3 次：等待 3000ms
        let mut fut = Box::pin(handle(&mut state, transient_error(ProviderErrorKind::ServerError)));
        assert!(poll!(fut.as_mut()).is_pending());
        tokio::time::advance(Duration::from_millis(2_999)).await;
        assert!(poll!(fut.as_mut()).is_pending(), "2999ms 未到 3000ms 不得重试");
        tokio::time::advance(Duration::from_millis(1)).await;
        let o3 = fut.await.unwrap();
        assert!(o3.end.is_none());
        assert_eq!(state.transient_retries, 3);
        assert_eq!(retry_diagnostic(&state).map(|d| d.elapsed_ms), Some(Some(3_000)));
        re_enter_streaming(&mut state);
        // 第 4 次：次数用尽（limit=3）→ fatal，不进入退避
        let o4 = handle(&mut state, transient_error(ProviderErrorKind::ServerError))
            .await
            .unwrap();
        assert!(o4.end.is_some());
        assert_eq!(state.machine.context().end_reason, R::Error);
        assert_eq!(state.transient_retries, 3);
        // provider_error 摘要：retries = 3
        let p = state.terminal_provider_error.as_ref().expect("fatal 必须填充摘要");
        assert_eq!(p.kind, ProviderErrorKind::ServerError);
        assert!(p.retryable);
        assert_eq!(p.retries, 3);
    }

    /// D1 T2（A2）：mock 429 + Retry-After=30s → 等待 ≥30s（不被 8s 钳制）——
    /// advance(29s) 断言不重试（无 NO_PROGRESS_CONTINUE），advance(1s) 后重试；
    /// 等待 = max(750, 30000) = 30s（裁决 #3）
    #[tokio::test]
    async fn rate_limit_retry_after_waits_at_least_30s() {
        let _time = TimePauseGuard::new();
        let mut state = backoff_state();
        let mut fut = Box::pin(handle(&mut state, rate_limit_error(30_000)));
        assert!(poll!(fut.as_mut()).is_pending(), "首 poll 后应进入 Retry-After sleep");
        // 29s：不得重试（30s 未到；若被 8s 钳制此处已完成，红）
        tokio::time::advance(Duration::from_millis(29_000)).await;
        assert!(
            poll!(fut.as_mut()).is_pending(),
            "429+Retry-After=30s 不得被 8s 钳制（29s 时不得重试）"
        );
        // 第 30s：重试发生
        tokio::time::advance(Duration::from_millis(1_000)).await;
        let o = fut.await.unwrap();
        assert!(o.end.is_none(), "30s 后必须重试而非 fatal");
        assert_eq!(state.transient_retries, 1);
        assert_eq!(
            retry_diagnostic(&state).map(|d| d.elapsed_ms),
            Some(Some(30_000)),
            "诊断等待 = 30s"
        );
        assert_eq!(
            retry_diagnostic(&state).and_then(|d| d.retry_after_ms),
            Some(30_000),
            "诊断透传 Retry-After"
        );
    }

    /// D1 T3（A3）：429 重试的等待被预算钳制——第一次等 30s、第二次钳到
    /// 剩余 30s、第三次前预算耗尽（elapsed >= 60s）→ 不进重试直接 fatal
    /// （endReason=Error，不消耗次数；04 §4.1「不无限尊重服务端再来一次」）
    #[tokio::test]
    async fn rate_limit_budget_clamp_exhausts_before_third_retry() {
        let _time = TimePauseGuard::new();
        let mut state = backoff_state();
        // 第一次：等 30s（累计 0→30s）
        let mut fut = Box::pin(handle(&mut state, rate_limit_error(30_000)));
        assert!(poll!(fut.as_mut()).is_pending());
        tokio::time::advance(Duration::from_millis(30_000)).await;
        let o1 = fut.await.unwrap();
        assert!(o1.end.is_none());
        assert_eq!(state.transient_retries, 1);
        re_enter_streaming(&mut state);
        // 第二次：elapsed=30s → 剩余 30s → 等待钳到 min(30000, 30000)=30s
        let mut fut = Box::pin(handle(&mut state, rate_limit_error(30_000)));
        assert!(poll!(fut.as_mut()).is_pending());
        tokio::time::advance(Duration::from_millis(30_000)).await;
        let o2 = fut.await.unwrap();
        assert!(o2.end.is_none(), "剩余预算 30s 内第二次重试必须发生");
        assert_eq!(state.transient_retries, 2);
        re_enter_streaming(&mut state);
        // 第三次：elapsed=60s >= 预算 → retry_delay_ms 返回 None → 直接 fatal
        // （不消耗次数，严格小于对齐 retry.rs:163-166）
        let o3 = handle(&mut state, rate_limit_error(30_000)).await.unwrap();
        assert!(o3.end.is_some(), "预算耗尽必须 fatal");
        assert_eq!(state.machine.context().end_reason, R::Error);
        assert_eq!(state.transient_retries, 2, "预算耗尽不消耗重试次数");
    }

    /// D1 T4（A4）：abort 竞速——sleep 中 abort → 立即 aborted 收场、
    /// 不消耗重试计数、无 retry 诊断（规则 R5，零通知零噪声；biased 优先）
    #[tokio::test]
    async fn abort_during_backoff_sleep_closes_aborted_without_consuming_retry() {
        let _time = TimePauseGuard::new();
        let mut state = backoff_state();
        // 预克隆信号（未来持有 &mut state 期间经共享句柄触发 abort）
        let signal = state.abort_signal.clone();
        let mut fut = Box::pin(handle(&mut state, transient_error(ProviderErrorKind::ServerError)));
        assert!(poll!(fut.as_mut()).is_pending(), "必须已进入退避 sleep");
        // sleep 中 abort（竞速窗口）
        signal.abort();
        tokio::time::advance(Duration::from_millis(1)).await;
        let o = fut.await.unwrap();
        assert!(o.end.is_some(), "abort 必须立即收场");
        assert_eq!(state.machine.context().end_reason, R::Aborted);
        assert_eq!(state.transient_retries, 0, "abort 不消耗重试计数");
        assert!(
            !state
                .events
                .iter()
                .any(|e| matches!(e, AgentEvent::ProviderDiagnostic { .. })),
            "abort 竞速收场不发诊断"
        );
    }

    /// D1 规则 R5 补充：sleep 完成后 abort 竞速窗口收口——sleep 结束瞬间
    /// abort 已触发 → 复查后仍 aborted 收场（不重试）
    #[tokio::test]
    async fn abort_after_sleep_completion_race_window_closes_aborted() {
        let _time = TimePauseGuard::new();
        let mut state = backoff_state();
        let signal = state.abort_signal.clone();
        let mut fut = Box::pin(handle(&mut state, transient_error(ProviderErrorKind::ServerError)));
        assert!(poll!(fut.as_mut()).is_pending());
        // 推进到 sleep 完成点同时 abort：biased select 以 sleep 分支返回 →
        // sleep 后复查 abort 兜住竞速窗口（Q40 纪律）
        tokio::time::advance(Duration::from_millis(750)).await;
        signal.abort();
        tokio::time::advance(Duration::from_millis(1)).await;
        let o = fut.await.unwrap();
        assert!(o.end.is_some());
        assert_eq!(state.machine.context().end_reason, R::Aborted);
        assert_eq!(state.transient_retries, 0, "竞速窗口收口不消耗计数");
    }

    /// D1 注入面：可注入延迟函数驱动序列（attempt 1/2/3 + Retry-After 透传），
    /// 零真实等待不依赖 tokio pause——测试直接驱动（任务书注入点要求）
    // G2 允许理由（clippy::type_complexity）：测试局部记录类型
    // Arc<Mutex<Vec<(u32, Option<u64>)>>>，由注入面签名自然形成
    #[tokio::test]
    #[allow(clippy::type_complexity)]
    async fn injected_delay_drives_retry_sequence_without_clock_pause() {
        use std::sync::Mutex;
        let mut state = backoff_state();
        let calls: Arc<Mutex<Vec<(u32, Option<u64>)>>> = Arc::new(Mutex::new(Vec::new()));
        let calls_handle = calls.clone();
        state.retry_delay = Some(Box::new(move |attempt, retry_after| {
            calls_handle.lock().unwrap().push((attempt, retry_after));
            Duration::ZERO
        }));
        for i in 0..3 {
            let o = handle(&mut state, transient_error(ProviderErrorKind::ServerError))
                .await
                .unwrap();
            assert!(o.end.is_none(), "第 {} 次重试应继续 run", i + 1);
            re_enter_streaming(&mut state);
        }
        let recorded = calls.lock().unwrap().clone();
        assert_eq!(recorded, vec![(1, None), (2, None), (3, None)], "注入面收到 attempt 序列");
        // 第 4 次：次数用尽 → fatal
        let o4 = handle(&mut state, transient_error(ProviderErrorKind::ServerError))
            .await
            .unwrap();
        assert!(o4.end.is_some());
        assert_eq!(state.machine.context().end_reason, R::Error);
        assert_eq!(calls.lock().unwrap().len(), 3, "fatal 不再查询延迟");
    }

    /// D1 注入面（429）：注入函数收到 Retry-After 透传（test-only 注入面
    /// 不经预算钳制——注入值即最终等待）
    // G2 允许理由（clippy::type_complexity）：同 injected_delay_drives 记录类型
    #[tokio::test]
    #[allow(clippy::type_complexity)]
    async fn injected_delay_receives_retry_after_passthrough() {
        use std::sync::Mutex;
        let mut state = backoff_state();
        let calls: Arc<Mutex<Vec<(u32, Option<u64>)>>> = Arc::new(Mutex::new(Vec::new()));
        let calls_handle = calls.clone();
        state.retry_delay = Some(Box::new(move |attempt, retry_after| {
            calls_handle.lock().unwrap().push((attempt, retry_after));
            Duration::from_millis(30_000)
        }));
        let o = handle(&mut state, rate_limit_error(30_000)).await.unwrap();
        assert!(o.end.is_none());
        assert_eq!(
            calls.lock().unwrap().clone(),
            vec![(1, Some(30_000))],
            "注入面收到 attempt=1 与 Retry-After 透传"
        );
        assert_eq!(
            retry_diagnostic(&state).map(|d| d.elapsed_ms),
            Some(Some(30_000)),
            "诊断等待 = 注入值 30s"
        );
    }

    /// D1 R6：retry_backoff=None（缺省）→ 现状立即重试（无退避、无 sleep、
    /// 无预算闸——向后兼容；诊断 elapsed_ms=0）
    #[tokio::test]
    async fn default_no_backoff_retries_immediately() {
        let mut state = streaming_state(); // retry_backoff = None（缺省）
        let o = handle(&mut state, transient_error(ProviderErrorKind::ServerError))
            .await
            .unwrap();
        assert!(o.end.is_none());
        assert_eq!(state.transient_retries, 1);
        assert_eq!(
            retry_diagnostic(&state).map(|d| d.elapsed_ms),
            Some(Some(0)),
            "无退避配置等待 = 0"
        );
        assert!(
            state.transient_retry_started_at.is_some(),
            "预算起点照常惰性初始化"
        );
    }

    /// D1 T5（A5）：熔断闸——streak=Some(6) ≥ 阈值 → 注入瞬态错误直接 fatal
    /// （endReason=Error、transient_retries=0、发 runtime-error 事件、
    /// 无 retry 诊断；熔断期不烧 run 内配额）
    #[tokio::test]
    async fn circuit_breaker_trips_at_six_streak_fatals_without_retry() {
        let mut state = backoff_state();
        state.options.retry.provider_fail_streak = Some(6);
        let o = handle(&mut state, transient_error(ProviderErrorKind::ServerError))
            .await
            .unwrap();
        assert!(o.end.is_some(), "熔断命中必须直接 fatal");
        assert_eq!(state.machine.context().end_reason, R::Error);
        assert_eq!(state.transient_retries, 0, "熔断期不消耗 run 内重试配额");
        assert!(
            state
                .events
                .iter()
                .any(|e| matches!(e, AgentEvent::RuntimeError { .. })),
            "熔断 fatal 必须发 runtime-error 观测事件"
        );
        assert!(
            !state
                .events
                .iter()
                .any(|e| matches!(e, AgentEvent::ProviderDiagnostic { .. })),
            "熔断 fatal 不发重试诊断"
        );
        // provider_error 摘要照常填充（retries=0）
        let p = state.terminal_provider_error.as_ref().expect("fatal 必须填充摘要");
        assert_eq!(p.kind, ProviderErrorKind::ServerError);
        assert_eq!(p.retries, 0);
    }


