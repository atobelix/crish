// SR-06c · 拆分 · ≠ EL：stream_error_tests.rs 第二段（D1 熔断闸补充 +
// provider_error 摘要 + Q40 abort 阶梯 + T-34 溢出压缩阶梯测试），经
// mod tests { include! } 合成单一 tests 模块（测试路径不 break）。
    /// D1 T5（A5）：streak=Some(5) < 阈值 → 正常重试（闸只卡 ≥ 阈值）
    #[tokio::test]
    async fn circuit_breaker_below_threshold_still_retries() {
        let mut state = backoff_state();
        state.options.retry.provider_fail_streak = Some(5);
        let o = handle(&mut state, transient_error(ProviderErrorKind::ServerError))
            .await
            .unwrap();
        assert!(o.end.is_none(), "streak=5 未达阈值必须正常重试");
        assert_eq!(state.transient_retries, 1);
    }

    /// D1 T5（A5）：streak=None（缺省）→ 现状行为（熔断不启用，向后兼容）
    #[tokio::test]
    async fn circuit_breaker_disabled_by_default_still_retries() {
        let mut state = backoff_state();
        assert!(state.options.retry.provider_fail_streak.is_none());
        let o = handle(&mut state, transient_error(ProviderErrorKind::ServerError))
            .await
            .unwrap();
        assert!(o.end.is_none());
        assert_eq!(state.transient_retries, 1);
    }

    /// D1 Q40 顺序保持：abort 检查先于熔断闸——熔断命中且已 abort → aborted
    /// 收场（非 fatal；既有 abort 优先级不被熔断覆盖）
    #[tokio::test]
    async fn abort_check_precedes_circuit_breaker_gate() {
        let mut state = streaming_state();
        state.options.retry.provider_fail_streak = Some(6);
        state.abort_signal.abort();
        let o = handle(&mut state, transient_error(ProviderErrorKind::ServerError))
            .await
            .unwrap();
        assert!(o.end.is_some());
        assert_eq!(state.machine.context().end_reason, R::Aborted, "abort 优先于熔断");
        assert_eq!(state.transient_retries, 0);
    }

    /// D1 T7（A7）：3 次瞬态重试耗尽 → terminal_provider_error =
    /// Some{kind: Network, retryable: true, retries: 3}（fatal 填充面）
    #[tokio::test]
    async fn provider_error_summary_filled_after_transient_exhaustion() {
        let mut state = backoff_state();
        state.retry_delay = Some(Box::new(|_, _| Duration::ZERO));
        for _ in 0..3 {
            let o = handle(&mut state, transient_error(ProviderErrorKind::Network))
                .await
                .unwrap();
            assert!(o.end.is_none());
            re_enter_streaming(&mut state);
        }
        let o4 = handle(&mut state, transient_error(ProviderErrorKind::Network))
            .await
            .unwrap();
        assert!(o4.end.is_some());
        let p = state.terminal_provider_error.as_ref().expect("fatal 必须填充摘要");
        assert_eq!(p.kind, ProviderErrorKind::Network);
        assert!(p.retryable);
        assert_eq!(p.retry_after_ms, None);
        assert_eq!(p.retries, 3, "retries = run 内实际重试次数");
    }

    /// D1 T7（A7）：非瞬态 fatal（Auth）→ Some{kind: Auth, retryable: false,
    /// retries: 0}（02 W1 验收②）
    #[tokio::test]
    async fn provider_error_summary_filled_on_auth_fatal() {
        let mut state = streaming_state();
        let o = handle(&mut state, transient_error(ProviderErrorKind::Auth))
            .await
            .unwrap();
        assert!(o.end.is_some());
        let p = state.terminal_provider_error.as_ref().expect("fatal 必须填充摘要");
        assert_eq!(p.kind, ProviderErrorKind::Auth);
        assert!(!p.retryable);
        assert_eq!(p.retries, 0, "非瞬态直接 fatal 无重试");
    }

    /// D1 A9（R7/R9 前缀不变性）：退避 sleep 期间与重试后对话零改动——
    /// 无消息产出、无 commit、无 message-start/end 事件（前缀不变性是
    /// provider 前缀缓存命中的前提，约束 B；sleep 期间未来暂停轮询，
    /// 无代码路径可写对话——结构保证，测试锁定重试全程零对话改动）
    #[tokio::test]
    async fn backoff_sleep_keeps_conversation_prefix_untouched() {
        let _time = TimePauseGuard::new();
        let mut state = backoff_state();
        // 预置已 commit 消息（前缀基线快照）
        state.conversation.push(Arc::new(AgentMessage {
            id: "m0".to_string(),
            role: AgentMessageRole::User,
            created_at: "2026-08-03T10:00:00.000Z".to_string(),
            blocks: vec![AgentMessageBlock::Text { text: "已提交前缀".to_string() }],
            metadata: None,
            client_message_id: None,
            content: None,
        }));
        let snapshot: Vec<Arc<AgentMessage>> = state.conversation.clone();
        let mut fut = Box::pin(handle(&mut state, transient_error(ProviderErrorKind::ServerError)));
        assert!(poll!(fut.as_mut()).is_pending(), "必须已进入退避 sleep");
        // 推进退避：sleep 期间未来不被轮询（结构上零对话改动）
        tokio::time::advance(Duration::from_millis(750)).await;
        let o = fut.await.unwrap();
        assert!(o.end.is_none());
        // 重试全程（含退避 sleep 期间）：对话零改动（长度不变 + Arc 身份
        // 一致 = 零 commit）、除重试诊断外无任何事件（无 message-start/end）
        assert_eq!(state.conversation.len(), snapshot.len(), "重试路径不得产生消息");
        assert!(
            state
                .conversation
                .iter()
                .zip(&snapshot)
                .all(|(a, b)| Arc::ptr_eq(a, b)),
            "重试路径消息 Arc 身份不得变化（零 commit，前缀字节级一致 R7）"
        );
        assert!(
            state.events.iter().all(|e| matches!(
                e,
                AgentEvent::ProviderDiagnostic { .. }
            )),
            "重试路径只允许重试诊断事件（不得注入对话/消息事件）"
        );
    }

    /// 从事件列表取最近一次压缩记录（断言辅助）
    fn compression_record(state: &LoopState) -> Option<conex_types::tool::ContextCompressionRecord> {
        state.events.iter().rev().find_map(|e| match e {
            AgentEvent::ContextCompressionEnd { result: Some(record), .. } => Some(record.clone()),
            _ => None,
        })
    }

    /// Q40（T09.9）：重试阶梯入口 abort → 跳过剩余阶梯直接收场——
    /// 不消耗重试计数、不发重试诊断、不派发 NO_PROGRESS_CONTINUE
    #[tokio::test]
    async fn abort_at_ladder_entry_skips_retry_and_closes_out() {
        let mut state = streaming_state();
        state.abort_signal.abort();
        let outcome = handle(&mut state, transient_error(ProviderErrorKind::RateLimit))
            .await
            .unwrap();
        // 不重试：重试计数零消耗、无 retry 诊断事件
        assert_eq!(state.transient_retries, 0, "abort 后不得消耗重试计数");
        assert_eq!(state.length_upgrades, 0, "abort 后不得消耗 length 计数");
        assert!(
            !state
                .events
                .iter()
                .any(|e| matches!(e, AgentEvent::ProviderDiagnostic { .. })),
            "abort 后不得发重试诊断"
        );
        // 收场共享 streaming 的 abort 决策路径：aborted 收场
        assert!(outcome.end.is_some(), "应直接收场而非继续 run");
        assert_eq!(state.machine.state(), S::TurnComplete);
        assert_eq!(state.machine.context().end_reason, R::Aborted);
    }

    /// Q40（T09.9）：瞬态重试每级决策前查 abort——梯级内 abort 同样直接收场
    /// （D1 §3.1.6：transient_retry 改 async，调用点加 .await）
    #[tokio::test]
    async fn abort_at_transient_level_skips_remaining_ladder() {
        let mut state = streaming_state();
        state.abort_signal.abort();
        let outcome = transient_retry(&mut state, &transient_error(ProviderErrorKind::ServerError))
            .await
            .expect("瞬态重试决策");
        assert_eq!(state.transient_retries, 0, "梯级内 abort 不消耗计数");
        assert!(outcome.end.is_some());
        assert_eq!(state.machine.context().end_reason, R::Aborted);
    }

    /// Q40（T09.9）：length 恢复阶梯每级决策前查 abort——已取消不再升级重试
    #[tokio::test]
    async fn abort_at_length_level_skips_upgrade() {
        let mut state = streaming_state();
        state.abort_signal.abort();
        let outcome = length_ladder(
            &mut state,
            &transient_error(ProviderErrorKind::ContextLengthExceeded),
        )
        .await
        .expect("length 阶梯为同步决策");
        assert_eq!(state.length_upgrades, 0, "abort 后不升级 max_tokens");
        assert_eq!(state.max_tokens, crate::r#loop::DEFAULT_MAX_TOKENS);
        assert!(outcome.end.is_some());
        assert_eq!(state.machine.context().end_reason, R::Aborted);
    }

    /// 对照：未 abort 时阶梯照常派发 NO_PROGRESS_CONTINUE（行为不回归）
    #[tokio::test]
    async fn retry_ladder_still_dispatches_without_abort() {
        let mut state = streaming_state();
        let outcome = handle(&mut state, transient_error(ProviderErrorKind::RateLimit))
            .await
            .unwrap();
        assert!(outcome.end.is_none(), "未 abort 应继续 run");
        assert_eq!(state.transient_retries, 1, "重试计数递增");
        assert_eq!(state.machine.state(), S::PreparingTurn, "NO_PROGRESS_CONTINUE 重进准备");
        // 重试诊断事件照发
        assert!(
            state
                .events
                .iter()
                .any(|e| matches!(e, AgentEvent::ProviderDiagnostic { .. })),
            "重试诊断照发"
        );
    }

    // ── T-34：溢出压缩阶梯（P4 §3.5）──

    /// PayloadTooLarge：压缩 + 重试一次（不再直接 fatal）——Overflow 触发
    /// 事件成对广播、对话替换（摘要占位 + 保留段）、护栏置位
    #[tokio::test]
    async fn payload_too_large_compresses_and_retries_once() {
        let mut state = budgeted_state();
        let outcome = handle(&mut state, transient_error(ProviderErrorKind::PayloadTooLarge))
            .await
            .unwrap();
        // 压缩后重试：不 fatal、继续 run（NO_PROGRESS_CONTINUE 重进准备）
        assert!(outcome.end.is_none(), "压缩后必须重试而非 fatal");
        assert_eq!(state.machine.state(), S::PreparingTurn);
        // 护栏：溢出重试计数 + 单 run 压缩计数 + 时间戳护栏
        assert_eq!(state.compaction.compression_retries, 1, "溢出压缩重试计数 = 1");
        assert_eq!(state.compaction.compactions_this_run, 1);
        assert!(state.compaction.last_compaction_at.is_some(), "压缩后时间戳护栏必须重置");
        // 事件：Overflow 触发成对广播
        let record = compression_record(&state).expect("必须广播压缩结束事件");
        assert_eq!(record.trigger, ContextCompressionTrigger::Overflow);
        assert_eq!(record.reason, Some(ContextCompressionReason::Overflow));
        let starts = state
            .events
            .iter()
            .filter(|e| matches!(e, AgentEvent::ContextCompressionStart { .. }))
            .count();
        assert_eq!(starts, 1);
        // 对话替换：摘要占位 + 保留段（压缩是唯一前缀重写点）
        assert!(
            state.conversation.iter().any(|m| m.id.starts_with("compacted-summary")),
            "压缩后对话必须含摘要占位消息"
        );
        assert!(state.conversation.len() < 10, "压缩后消息数必须减少");
    }

    /// PayloadTooLarge 压缩后重试仍超限 → 第二次压缩（上限 2，E2 F2 层 2：
    /// 第二次重试前 keep_recent_tokens 阶梯下调 20K→12K→8K 优先更小保留
    /// 预算——请求体真实变化）→ 仍超限才 fatal（第三次）；
    /// fatal 诊断含压缩后 token 数
    #[tokio::test]
    async fn payload_too_large_still_over_after_retry_goes_fatal() {
        let mut state = budgeted_state();
        // 第一次：压缩 + 重试（retries 0→1）
        let o1 = handle(&mut state, transient_error(ProviderErrorKind::PayloadTooLarge))
            .await
            .unwrap();
        assert!(o1.end.is_none());
        assert_eq!(state.compaction.compression_retries, 1);
        re_enter_streaming(&mut state);
        // 第二次（压缩后仍 PayloadTooLarge）：再次压缩 + 重试（retries 1→2，
        // 上限 2 未耗尽——E2 新语义）
        let o2 = handle(&mut state, transient_error(ProviderErrorKind::PayloadTooLarge))
            .await
            .unwrap();
        assert!(o2.end.is_none(), "重试上限 2 内第二次压缩必须发生（E2 F2 层 2）");
        assert_eq!(state.compaction.compression_retries, 2);
        re_enter_streaming(&mut state);
        // 第三次（仍超限）：上限耗尽 → fatal，不再压缩
        let outcome = handle(&mut state, transient_error(ProviderErrorKind::PayloadTooLarge))
            .await
            .unwrap();
        assert!(outcome.end.is_some(), "压缩后仍超限必须 fatal");
        assert_eq!(state.compaction.compression_retries, 2, "重试上限 2 不可再超");
        assert_eq!(state.machine.context().end_reason, R::Error);
        assert_eq!(state.machine.state(), S::TurnComplete);
        // 诊断含压缩后 token 数（P4 §3.5：压缩后仍超 = 单条消息过大或窗口过小）
        let runtime_error = state
            .events
            .iter()
            .find_map(|e| match e {
                AgentEvent::RuntimeError { error, .. } => Some(error.clone()),
                _ => None,
            })
            .expect("fatal 必须发 runtime-error 事件");
        assert!(
            runtime_error.contains("压缩后") && runtime_error.contains("仍超限"),
            "fatal 诊断应含压缩后 token 数：{runtime_error}"
        );
        // terminal_error 同步携带附注（fatal 文案面，E2 一致性）
        let terminal = state.terminal_error.as_deref().expect("fatal 必须填充文案");
        assert!(
            terminal.contains("仍超限"),
            "terminal_error 应携带压缩阶梯附注：{terminal}"
        );
    }

    /// ContextLengthExceeded：length 阶梯（8192→16384→32768，上限 2 次）
    /// 用尽后接压缩阶梯——压缩 + 重试（上限 2，E2 F2 层 2），压缩两次后
    /// 仍超限才 fatal（P4 §3.5 验收：第三次 length 升级后先压缩两次，
    /// compression_retries ≤ 2）
    #[tokio::test]
    async fn context_length_over_threshold_bypasses_length_ladder_and_compresses() {
        // W1-T7：输入上下文超限（≥80% 阈值）直接穿透 length 阶梯进入压缩，
        // 不再翻倍输出预算；压缩上限 2 次，第三次仍超限才 fatal。
        let mut state = budgeted_state();
        let o1 = handle(&mut state, transient_error(ProviderErrorKind::ContextLengthExceeded))
            .await
            .unwrap();
        assert!(o1.end.is_none(), "输入超限应直接压缩而非 fatal");
        assert_eq!(state.length_upgrades, 0, "输入超限不再消费 length 阶梯");
        assert_eq!(state.compaction.compression_retries, 1);
        assert_eq!(state.compaction.compactions_this_run, 1);
        assert_eq!(
            compression_record(&state).expect("压缩必须广播结束事件").trigger,
            ContextCompressionTrigger::Overflow
        );
        re_enter_streaming(&mut state);
        let o2 = handle(&mut state, transient_error(ProviderErrorKind::ContextLengthExceeded))
            .await
            .unwrap();
        assert!(o2.end.is_none(), "压缩 #2 必须发生（上限 2 未耗尽）");
        assert_eq!(state.compaction.compression_retries, 2);
        assert_eq!(state.compaction.compactions_this_run, 2);
        re_enter_streaming(&mut state);
        let o3 = handle(&mut state, transient_error(ProviderErrorKind::ContextLengthExceeded))
            .await
            .unwrap();
        assert!(o3.end.is_some(), "压缩上限耗尽后仍超限必须 fatal");
        assert_eq!(state.machine.context().end_reason, R::Error);
        assert_eq!(state.compaction.compression_retries, 2, "compression_retries ≤ 2");
        assert_eq!(state.compaction.compactions_this_run, 2, "不得再次压缩");
    }

    /// 缺省配置（无预算 / 无压缩策略）：PayloadTooLarge 保持「直接 fatal」
    /// 语义（向后兼容现状；T06.2.2 的无压缩恢复路径说明保留）
    #[tokio::test]
    async fn payload_too_large_without_config_goes_fatal() {
        let mut state = streaming_state();
        let outcome = handle(&mut state, transient_error(ProviderErrorKind::PayloadTooLarge))
            .await
            .unwrap();
        assert!(outcome.end.is_some());
        assert_eq!(state.machine.context().end_reason, R::Error);
        assert_eq!(state.compaction.compression_retries, 0, "缺省配置不消耗压缩重试计数");
        let runtime_error = state
            .events
            .iter()
            .find_map(|e| match e {
                AgentEvent::RuntimeError { error, .. } => Some(error.clone()),
                _ => None,
            })
            .expect("fatal 必须发 runtime-error 事件");
        assert!(
            runtime_error.contains("无压缩恢复路径"),
            "缺省配置诊断应保留无压缩恢复路径说明：{runtime_error}"
        );
    }

    /// 无可丢内容（对话在预算内 → 压缩为 noop）：不重试直接 fatal
    /// （请求体未变，重试必再超——对齐 T06.2.2 删除假恢复的裁决）
    #[tokio::test]
    async fn noop_compaction_does_not_fake_retry() {
        let mut state = budgeted_state();
        state.conversation = vec![Arc::new(AgentMessage {
            id: "m0".to_string(),
            role: AgentMessageRole::User,
            created_at: "2026-08-03T10:00:00.000Z".to_string(),
            blocks: vec![AgentMessageBlock::Text { text: "短消息".to_string() }],
            metadata: None,
            client_message_id: None,
            content: None,
        })];
        let outcome = handle(&mut state, transient_error(ProviderErrorKind::PayloadTooLarge))
            .await
            .unwrap();
        assert!(outcome.end.is_some(), "无可丢内容不得假恢复（直接 fatal）");
        assert_eq!(state.compaction.compression_retries, 0, "noop 压缩不消耗重试计数");
        assert_eq!(state.compaction.compactions_this_run, 0);
        assert!(
            state.events.iter().all(|e| !matches!(e, AgentEvent::ContextCompressionEnd { .. })),
            "noop 压缩不得广播压缩事件"
        );
    }

    /// E2 F2 层 2（D1 §3.5.1，DEEPCHECK-11 §7 冲突 1 修复）：溢出阶梯
    /// **绕开预检共享计数**——预检已用掉本 run 唯一一次压缩
    /// （compactions_this_run = max_auto_compactions_per_run = 1）后，
    /// PayloadTooLarge 仍走压缩阶梯恢复（不再被预检计数饿死）；
    /// max_auto_compactions_per_run 仅约束预检/边界/分阶段触发
    #[tokio::test]
    async fn overflow_compaction_bypasses_preflight_run_limit() {
        let mut state = budgeted_state();
        state.compaction.compactions_this_run = 1; // 模拟预检已压缩（单 run 上限 1 已用尽）
        let outcome = handle(&mut state, transient_error(ProviderErrorKind::PayloadTooLarge))
            .await
            .unwrap();
        assert!(
            outcome.end.is_none(),
            "溢出阶梯必须绕开预检共享计数（预检不再饿死溢出恢复）"
        );
        assert_eq!(state.compaction.compression_retries, 1, "溢出压缩照常发生");
        assert_eq!(
            state.compaction.compactions_this_run, 2,
            "溢出压缩也计入总计数（apply_compaction 统一口径），但不受其约束"
        );
        assert!(
            state
                .conversation
                .iter()
                .any(|m| m.id.starts_with("compacted-summary")),
            "溢出压缩必须真实替换对话"
        );
    }

    /// 对照回归：预检路径本身仍受 max_auto_compactions_per_run 约束
    /// （E2 F2 层 2：计数解耦只放行溢出，预检护栏不变）
    #[tokio::test]
    async fn preflight_guard_still_blocks_second_preflight_compaction() {
        let mut state = budgeted_state();
        state.compaction.compactions_this_run = 1;
        // 直接驱动预检触发（阈值估计：对话 10 条 × 5000 token 远超 8000）
        let compacted = crate::r#loop::handlers::maybe_compact_preflight(&mut state).await;
        assert!(
            !compacted,
            "预检路径必须仍受单 run 上限约束（计数解耦只针对溢出）"
        );
        assert_eq!(state.compaction.compactions_this_run, 1, "预检被挡下不得计数");
    }

    /// F2-01（红→绿）：length 阶梯配置放大溢出防护——length_upgrade_limit
    /// 配置为 30 时有效上限仍为 2 次（8192→16384→32768，01 §2.6 上限 2），
    /// 第三次 ContextLengthExceeded 不得继续翻倍（修复前按配置 30 翻倍：
    /// 第 3 次升级 max_tokens=65536 且无收场，红；19 次后 8192×2^19 溢出
    /// u32::MAX——debug panic / release 回绕成小值退化）
    #[tokio::test]
    async fn length_ladder_caps_upgrades_even_with_huge_limit() {
        let mut state = streaming_state();
        state.options.retry.length_upgrade_limit = 30;
        // 第一次：升级（1/2）
        let o1 = handle(&mut state, transient_error(ProviderErrorKind::ContextLengthExceeded))
            .await
            .unwrap();
        assert!(o1.end.is_none());
        assert_eq!(state.length_upgrades, 1);
        assert_eq!(state.max_tokens, DEFAULT_MAX_TOKENS * 2);
        re_enter_streaming(&mut state);
        // 第二次：升级（2/2）
        let o2 = handle(&mut state, transient_error(ProviderErrorKind::ContextLengthExceeded))
            .await
            .unwrap();
        assert!(o2.end.is_none());
        assert_eq!(state.length_upgrades, 2);
        assert_eq!(state.max_tokens, DEFAULT_MAX_TOKENS * 4);
        re_enter_streaming(&mut state);
        // 第三次：配置 30 也按阶梯上限 2 计——不再翻倍（进入压缩阶梯，
        // 无预算配置 → fatal 收场）
        let o3 = handle(&mut state, transient_error(ProviderErrorKind::ContextLengthExceeded))
            .await
            .unwrap();
        assert!(
            o3.end.is_some(),
            "length_upgrade_limit=30 不得触发第 3 次 length 升级（阶梯上限 2，红）"
        );
        assert_eq!(state.length_upgrades, 2, "升级计数必须停在 2");
        assert_eq!(
            state.max_tokens,
            DEFAULT_MAX_TOKENS * 4,
            "max_tokens 不得超出 32768 阶梯上限"
        );
    }

    /// F2-01 防御性饱和（绿锚点）：即便绕过上限（内部计数异常），
    /// max_tokens 翻倍也永不溢出——saturating_mul 保语义
    #[tokio::test]
    async fn max_tokens_doubling_saturates_never_overflow() {
        let mut state = streaming_state();
        state.max_tokens = u32::MAX - 1;
        state.options.retry.length_upgrade_limit = 1;
        let outcome = handle(&mut state, transient_error(ProviderErrorKind::ContextLengthExceeded))
            .await
            .unwrap();
        assert!(outcome.end.is_none());
        assert_eq!(state.max_tokens, u32::MAX, "saturating_mul 后必须饱和保持");
    }

    /// I4 补充（C14）：溢出压缩阶梯同样经 Summarizer trait 边界——
    /// 摘要器只收到丢弃消息（无 session_id / 无缓存键 / 无 tools / 无
    /// system 参数；trait 签名即隔离保证），Schema V1 JSON 文档的 md
    /// 渲染进入事件载荷（R-G 新契约：非 JSON 输出一律降级 stub）
    // G2 允许理由（clippy::type_complexity）：测试局部嵌套类型
    // （RecordingSummarizer 回调签名含 Arc<Mutex<Vec<(Vec<String>,
    // Option<String>)>>>），类型由被测接口依赖链自然形成，定义别名可缓解
    // 但改动扩散大、豁免面小。
    #[tokio::test]
    #[allow(clippy::type_complexity)]
    async fn overflow_compaction_uses_summarizer_without_affinity() {
        use std::sync::Mutex;
        struct RecordingSummarizer {
            calls: Arc<Mutex<Vec<(Vec<String>, Option<String>)>>>,
        }
        impl conex_compaction::Summarizer for RecordingSummarizer {
            fn summarize(
                &self,
                dropped: &[AgentMessage],
                existing: Option<&str>,
            ) -> Result<String, String> {
                self.calls.lock().unwrap().push((
                    dropped.iter().map(|m| m.id.clone()).collect(),
                    existing.map(str::to_string),
                ));
                // 合法 Schema V1 JSON 文档（R-G 契约）
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
                    "criticalContext": ["context length exceeded"],
                })
                .to_string())
            }
        }
        let calls = Arc::new(Mutex::new(Vec::new()));
        let summarizer = Arc::new(RecordingSummarizer { calls: calls.clone() });
        let mut state = budgeted_state();
        state.compaction.summarizer = Some(summarizer.clone());
        let outcome = handle(&mut state, transient_error(ProviderErrorKind::PayloadTooLarge))
            .await
            .unwrap();
        assert!(outcome.end.is_none(), "L2 摘要路径压缩必须完成并重试");
        let recorded = calls.lock().unwrap().clone();
        assert_eq!(recorded.len(), 1, "摘要器只调用一次");
        let (dropped_ids, existing) = &recorded[0];
        assert!(existing.is_none(), "首次压缩无既有摘要");
        assert!(!dropped_ids.is_empty(), "摘要器收到被丢弃消息");
        assert!(
            dropped_ids.iter().all(|id| id.starts_with('m')),
            "摘要器只收到消息 id（无会话/缓存亲和参数）"
        );
        // 事件载荷摘要 = Schema V1 JSON 文档的 md 渲染（R-G 语源唯一）
        let summary = compression_record(&state)
            .map(|r| r.summary)
            .expect("必须有记录");
        assert!(
            summary.contains("## Goal") && summary.contains("溢出恢复"),
            "事件摘要 = JSON 文档的 markdown 渲染：{summary}"
        );
        assert!(
            !summary.starts_with("[Compacted"),
            "同步成功路径不得降级 stub：{summary}"
        );
    }

