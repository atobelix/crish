// SR-06c · 拆分 · ≠ EL：stream_error_tests.rs 第三段（E2 上下文压缩增强：
// LLM 强制 / 溢出上限 2 / 绕开预检计数测试），经 mod tests { include! }
// 合成单一 tests 模块（测试路径不 break）。
    // ── E2 上下文压缩增强（LLM 强制 / 溢出上限 2 / 绕开预检计数）──

    /// E2 F1 L3：无 Summarizer（LLM 摘要不可用）+ 默认 LLM 强制 →
    /// 溢出路径不落 stub、不压缩、直接 fatal——fatal 文案含「LLM 不可用」
    /// （显式失败不静默丢语义，禁止纯丢弃式线性压缩）；对话原样、
    /// 无压缩事件、compression_retries 不消耗
    #[tokio::test]
    async fn overflow_without_summarizer_fatals_with_llm_unavailable_note() {
        let mut state = budgeted_state();
        state.compaction.summarizer = None; // 无 Summarizer 注入（LLM 摘要不可用）
        let snapshot = state.conversation.clone();
        let outcome = handle(&mut state, transient_error(ProviderErrorKind::PayloadTooLarge))
            .await
            .unwrap();
        assert!(outcome.end.is_some(), "无 Summarizer 且 LLM 强制必须直接 fatal");
        assert_eq!(state.machine.context().end_reason, R::Error);
        assert_eq!(state.compaction.compression_retries, 0, "未压缩不消耗重试计数");
        assert_eq!(state.compaction.compactions_this_run, 0, "未压缩不消耗单 run 计数");
        // 对话原样（无 stub 入对话——禁止纯丢弃式）
        assert_eq!(state.conversation.len(), snapshot.len(), "对话必须保持原样");
        assert!(
            !state
                .conversation
                .iter()
                .any(|m| m.id.starts_with("compacted-summary")),
            "不得产出中性 stub（F1 禁止面）"
        );
        // 无压缩事件（未发生压缩）
        assert!(
            state
                .events
                .iter()
                .all(|e| !matches!(e, AgentEvent::ContextCompressionEnd { .. })),
            "未压缩不得广播压缩事件"
        );
        // fatal 文案含「LLM 不可用」（runtime-error 事件 + terminal_error 双面）
        let runtime_error = state
            .events
            .iter()
            .find_map(|e| match e {
                AgentEvent::RuntimeError { error, .. } => Some(error.clone()),
                _ => None,
            })
            .expect("fatal 必须发 runtime-error 事件");
        assert!(
            runtime_error.contains("LLM 不可用"),
            "runtime-error 文案必须含「LLM 不可用」：{runtime_error}"
        );
        let terminal = state.terminal_error.as_deref().expect("fatal 必须填充文案");
        assert!(
            terminal.contains("LLM 不可用"),
            "terminal_error 必须含「LLM 不可用」：{terminal}"
        );
        // provider_error 数据面照常填充（D1 §3.4）
        let p = state.terminal_provider_error.as_ref().expect("fatal 必须填充摘要");
        assert_eq!(p.kind, ProviderErrorKind::PayloadTooLarge);
    }

    /// E2 F1 L3 豁免：compact_allow_stub_fallback=true + 无 Summarizer →
    /// 允许临时 stub 降级（唯一显式豁免路径，默认关）——压缩照常完成并
    /// 重试（stub 非永驻：后台补摘要成功自动替换）
    #[tokio::test]
    async fn overflow_stub_fallback_exemption_allows_stub() {
        let mut state = budgeted_state();
        state.compaction.summarizer = None;
        state.options.compaction.compact_allow_stub_fallback = true;
        let outcome = handle(&mut state, transient_error(ProviderErrorKind::PayloadTooLarge))
            .await
            .unwrap();
        assert!(outcome.end.is_none(), "豁免路径必须压缩并重试");
        assert_eq!(state.compaction.compression_retries, 1);
        // stub 入对话（降级路径语义）
        let summary = compression_record(&state)
            .map(|r| r.summary)
            .expect("必须有压缩记录");
        assert!(
            summary.starts_with("[Compacted(") && summary.contains("摘要见块表"),
            "豁免路径降级中性 stub：{summary}"
        );
    }

    /// E2 F1 键面合一：compact_require_llm=false（门关闭）+ 无 Summarizer
    /// → 显式允许 stub 降级（与 compact_allow_stub_fallback 键面合一，
    /// E2 §7.1 / D1 §3.5.2）
    #[tokio::test]
    async fn overflow_require_llm_disabled_allows_stub() {
        let mut state = budgeted_state();
        state.compaction.summarizer = None;
        state.options.compaction.compact_require_llm = false;
        let outcome = handle(&mut state, transient_error(ProviderErrorKind::PayloadTooLarge))
            .await
            .unwrap();
        assert!(outcome.end.is_none(), "compact_require_llm=false 必须放行 stub 压缩");
        assert_eq!(state.compaction.compression_retries, 1);
        let summary = compression_record(&state)
            .map(|r| r.summary)
            .expect("必须有压缩记录");
        assert!(summary.starts_with("[Compacted("), "stub 降级：{summary}");
    }

    /// E2 F1 L2：Summarizer 注入但同步摘要失败（Err）+ 默认 LLM 强制 →
    /// 不落 stub 先行（「压缩不成功不生效」而非「先丢后补」）→ 直接 fatal，
    /// 文案含「LLM 不可用」；失败重试留给后台/后续触发（F2 层 1 语义）
    #[tokio::test]
    async fn overflow_summarizer_error_fatals_with_llm_unavailable() {
        struct FailingSummarizer;
        impl conex_compaction::Summarizer for FailingSummarizer {
            fn summarize(
                &self,
                _dropped: &[conex_types::message::AgentMessage],
                _existing: Option<&str>,
            ) -> Result<String, String> {
                Err("摘要请求失败（模拟 L2 降级）".to_string())
            }
        }
        let mut state = budgeted_state();
        state.compaction.summarizer = Some(Arc::new(FailingSummarizer));
        let snapshot = state.conversation.clone();
        let outcome = handle(&mut state, transient_error(ProviderErrorKind::PayloadTooLarge))
            .await
            .unwrap();
        assert!(outcome.end.is_some(), "摘要失败且 LLM 强制必须直接 fatal");
        assert_eq!(state.compaction.compression_retries, 0);
        assert_eq!(state.conversation.len(), snapshot.len(), "对话保持原样");
        let runtime_error = state
            .events
            .iter()
            .find_map(|e| match e {
                AgentEvent::RuntimeError { error, .. } => Some(error.clone()),
                _ => None,
            })
            .expect("fatal 必须发 runtime-error 事件");
        assert!(
            runtime_error.contains("LLM 不可用"),
            "摘要失败 fatal 文案必须含「LLM 不可用」：{runtime_error}"
        );
    }

    /// E2 F2 层 2 可配：compact_overflow_retries=0 → 溢出不压缩直接 fatal
    /// （等价禁用溢出压缩恢复）；=1 → 只压缩一次，第二次仍超限即 fatal
    #[tokio::test]
    async fn overflow_retry_limit_configurable() {
        // 0 = 溢出不压缩直接 fatal
        let mut state = budgeted_state();
        state.options.compaction.compact_overflow_retries = 0;
        let outcome = handle(&mut state, transient_error(ProviderErrorKind::PayloadTooLarge))
            .await
            .unwrap();
        assert!(outcome.end.is_some(), "上限 0 必须直接 fatal");
        assert_eq!(state.compaction.compression_retries, 0);
        assert_eq!(state.compaction.compactions_this_run, 0, "未压缩不得计数");
        // 1 = 只压缩一次，第二次仍超限直接 fatal（旧语义上限）
        let mut state = budgeted_state();
        state.options.compaction.compact_overflow_retries = 1;
        let o1 = handle(&mut state, transient_error(ProviderErrorKind::PayloadTooLarge))
            .await
            .unwrap();
        assert!(o1.end.is_none());
        assert_eq!(state.compaction.compression_retries, 1);
        re_enter_streaming(&mut state);
        let o2 = handle(&mut state, transient_error(ProviderErrorKind::PayloadTooLarge))
            .await
            .unwrap();
        assert!(o2.end.is_some(), "上限 1 耗尽后必须 fatal");
        assert_eq!(state.compaction.compression_retries, 1);
    }

    /// E2 F2 层 2 阶梯下调（D1 §3.5.1 / DEEPCHECK-11 §8 机制化）：
    /// 第二次压缩前 keep_recent_tokens 从 20000 下调到 12000（min 配置值）
    /// ——构造 12 条 × 5000 token 对话 + keep=20000：
    /// 第一次 cut=8（dropped 8 条）；第二次（对话 = 链 + m8..m11）若阶梯
    /// 生效 keep=12000 → cut=3（dropped = m8,m9 共 2 条）；若阶梯未生效
    /// keep=20000 → cut=2（dropped = m8 仅 1 条）——断言 dropped = [m8, m9]
    /// 即锁定阶梯下调语义
    #[tokio::test]
    async fn overflow_retry_uses_smaller_keep_recent_staircase() {
        // 12 条 × 5000 字（CJK 逐字符 ≈ 5000 token/条）≈ 6 万 token
        let conversation: Vec<Arc<AgentMessage>> = (0..12)
            .map(|i| {
                Arc::new(AgentMessage {
                    id: format!("m{i}"),
                    role: if i % 2 == 0 {
                        AgentMessageRole::User
                    } else {
                        AgentMessageRole::Assistant
                    },
                    created_at: "2026-08-03T10:00:00.000Z".to_string(),
                    blocks: vec![AgentMessageBlock::Text {
                        text: "字".repeat(5_000),
                    }],
                    metadata: None,
                    client_message_id: None,
                    content: None,
                })
            })
            .collect();
        let mut state = streaming_state();
        let options = { let mut o: SessionLoopOptions = SessionLoopOptions::default(); o.assembly.context_budget = Some(ContextBudget {
                context_window: 100_000,
                reserve_tokens: 1_000,
                safety_tokens: 100,
            }); o.compaction.compaction_policy = Some(CompactionPolicy {
                keep_recent_tokens: 20_000,
                min_recent_turns: 1,
                ..Default::default()
            }); o.compaction.max_auto_compactions_per_run = 1; o.compaction.summarizer = Some(Arc::new(OkSummarizer)); o };
        state.options = options.clone();
        state.budget_state.budget = options.assembly.context_budget;
        state.compaction.compaction_policy = options.compaction.compaction_policy.clone();
        state.compaction.summarizer = options.compaction.summarizer.clone();
        state.conversation = conversation;
        // 第一次压缩（keep=20000 → cut=8）
        let o1 = handle(&mut state, transient_error(ProviderErrorKind::PayloadTooLarge))
            .await
            .unwrap();
        assert!(o1.end.is_none());
        assert_eq!(state.compaction.compression_retries, 1);
        // 压缩后对话 = 链 + m8..m11（5 条）
        assert_eq!(state.conversation.len(), 5);
        re_enter_streaming(&mut state);
        // 第二次压缩：阶梯下调 keep=min(20000, 12000)=12000 → cut=3 → dropped=[m8, m9]
        let o2 = handle(&mut state, transient_error(ProviderErrorKind::PayloadTooLarge))
            .await
            .unwrap();
        assert!(o2.end.is_none(), "阶梯下调后第二次压缩必须成功（非 noop fatal）");
        assert_eq!(state.compaction.compression_retries, 2);
        let record = compression_record(&state).expect("第二次压缩必须广播事件");
        assert_eq!(
            record.compressed_message_ids,
            vec!["m8".to_string(), "m9".to_string()],
            "keep 阶梯 12000 生效：cut=3（dropped m8,m9；若未下调则 cut=2 仅 dropped m8）"
        );
        // 阶梯常量语义：默认 20K→12K→8K（下调方向，min 配置值逻辑在实现内）
        assert_eq!(OVERFLOW_KEEP_RECENT_STAIRCASE, [20_000, 12_000, 8_000]);
    }

    /// E2 信息分级（约束 C）：LLM 摘要不可用的等待/fatal 一律经事件面
    /// （runtime-error / runtime-intervention-required）呈现，对话零注入
    /// ——无 Summarizer 溢出 fatal 路径对话逐字节不变（无「重试中」/失败
    /// 标记类注入消息）
    #[tokio::test]
    async fn llm_unavailable_overflow_never_injects_diagnostic_into_conversation() {
        let mut state = budgeted_state();
        state.compaction.summarizer = None;
        let snapshot: Vec<Arc<AgentMessage>> = state.conversation.clone();
        handle(&mut state, transient_error(ProviderErrorKind::PayloadTooLarge))
            .await
            .unwrap();
        assert_eq!(state.conversation.len(), snapshot.len(), "对话长度不变");
        assert!(
            state
                .conversation
                .iter()
                .zip(&snapshot)
                .all(|(a, b)| Arc::ptr_eq(a, b)),
            "对话 Arc 身份不变（零注入、零改写——信息分级约束 C）"
        );
        // 事件面呈现：runtime-error 含「LLM 不可用」
        assert!(
            state.events.iter().any(|e| matches!(
                e,
                AgentEvent::RuntimeError { error, .. } if error.contains("LLM 不可用")
            )),
            "LLM 不可用必须经 runtime-error 事件呈现"
        );
    }


