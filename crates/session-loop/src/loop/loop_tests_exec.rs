// SR-06c · 拆分 · ≠ EL：loop_tests.rs 第二段（run 输入辅助 + 缓存统计 +
// T-EG-06 装配冒烟 + D1 provider_error 数据面测试），经 mod tests
// { include! } 合成单一 tests 模块（测试路径不 break）。
    /// 构造用户消息（run 输入）
    fn user_input(text: &str) -> AgentMessage {
        AgentMessage {
            id: format!("user-{text}"),
            role: AgentMessageRole::User,
            created_at: "2026-01-01T00:00:00Z".into(),
            blocks: vec![AgentMessageBlock::Text { text: text.into() }],
            metadata: None,
            client_message_id: None,
            content: None,
        }
    }

    /// 携带 usage 的停止事件（ProviderUsage camelCase 标量面，T-36 消费面）
    fn stop_with_usage(
        prompt: u64,
        completion: u64,
        read: u64,
        write: u64,
        miss: Option<u64>,
    ) -> crate::stream::ProviderStreamEvent {
        crate::stream::ProviderStreamEvent::Stop {
            reason: crate::stream::StopReason::Stop,
            error: None,
            error_kind: None,
            usage: Some(crate::stream::ProviderUsage {
                prompt_tokens: Some(prompt),
                completion_tokens: Some(completion),
                total_tokens: Some(prompt.saturating_add(completion)),
                cache_read_tokens: Some(read),
                cache_write_tokens: Some(write),
                cache_miss_tokens: miss,
                reasoning_tokens: None,
            }),
        }
    }

    /// T-36：run 收口携带缓存统计（usage → RunCacheStats 聚合）；
    /// 未配置 cache_tracking 时缺省 None（向后兼容）
    #[tokio::test]
    async fn run_outcome_carries_cache_stats_and_defaults_to_none() {
        use crate::cache_tracker::CacheTrackingConfig;
        // 配置跟踪器：单轮 usage（Included 口径）→ RunCacheStats 聚合
        let provider = TestProvider::new(vec![
            crate::stream::ProviderStreamEvent::text("你好"),
            stop_with_usage(1_000, 50, 800, 100, None),
        ]);
        let mut loop_ = AgentSessionLoop::new("s1", "r1", 16, Box::new(provider), registry());
        loop_ = loop_.with_options({ let mut o: SessionLoopOptions = SessionLoopOptions::default(); o.cache.cache_tracking = Some(CacheTrackingConfig {
                provider: "deepseek".to_string(),
                model: "deepseek-v4-flash".to_string(),
                ttl_seconds: 60,
            }); o });
        let outcome = loop_.run(user_input("你好")).await;
        let stats = outcome.cache_stats.expect("配置后收口必须携带缓存统计");
        assert_eq!(stats.sample_count, 1);
        assert_eq!(stats.prompt_tokens, 1_000);
        assert_eq!(stats.completion_tokens, 50);
        assert_eq!(stats.total_tokens, 1_050);
        assert_eq!(stats.cache_read_tokens, 800);
        assert_eq!(stats.cache_write_tokens, 100);
        // Included：miss = prompt - read - write
        assert_eq!(stats.cache_miss_tokens, 100);
        assert_eq!(stats.hit_ratio, Some(0.8));
        assert_eq!(stats.missed_tokens, 0, "首轮无基线 → 不计 miss");
        assert!(stats.warm_until_ms.is_some(), "TTL 已知 → 温暖截止可计算");

        // 未配置 → None（向后兼容，行为与现状一致）
        let provider2 = TestProvider::new(vec![
            crate::stream::ProviderStreamEvent::text("hi"),
            stop_with_usage(100, 10, 0, 0, None),
        ]);
        let mut loop2 = AgentSessionLoop::new("s1", "r2", 16, Box::new(provider2), registry());
        let outcome2 = loop2.run(user_input("hi")).await;
        assert!(outcome2.cache_stats.is_none(), "未配置缓存测量 → cache_stats 为 None");
    }

    // ── T-EG-06：引擎装配冒烟（互斥 / 配额 / 中间件链 / ESC 判定器）──

    /// 装配探针工具：记录工具执行面见到的装配状态（注册表 / 配额 /
    /// 持有者 / 写路径声明结果），供 smoke 测试断言 with_options 装配块
    /// 的四线接线是否真实生效
    #[derive(Debug, Default)]
    struct AssemblyProbeTool {
        observed: Arc<std::sync::Mutex<AssemblyProbeRecord>>,
    }

    /// 探针观测记录（执行面装配状态快照）
    #[derive(Debug, Default, Clone)]
    struct AssemblyProbeRecord {
        /// 写路径互斥注册表是否已注入
        write_claims_some: bool,
        /// 配额上下文是否已注入
        quota_some: bool,
        /// 写声明持有者（应为当前 run 标识）
        holder: Option<String>,
        /// 执行面声明写路径是否成功
        claim_ok: bool,
    }

    impl AssemblyProbeTool {
        /// 取观测记录（测试断言）
        fn observed(&self) -> AssemblyProbeRecord {
            self.observed
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
        }
    }

    #[async_trait]
    impl agent_tools::definition::Tool for AssemblyProbeTool {
        fn name(&self) -> &str {
            "assembly_probe"
        }

        fn definition(&self) -> &agent_tools::definition::ToolDefinition {
            static DEF: std::sync::OnceLock<agent_tools::definition::ToolDefinition> =
                std::sync::OnceLock::new();
            DEF.get_or_init(|| agent_tools::definition::ToolDefinition {
                name: "assembly_probe".to_string(),
                description: "装配冒烟探针".to_string(),
                input_schema: serde_json::json!({"type": "object"}),
                dangerous: false,
                fatal_on_error: false,
            })
        }

        async fn execute(
            &self,
            ctx: &agent_tools::context::ToolContext,
            _args: serde_json::Value,
        ) -> Result<serde_json::Value, agent_tools::definition::ToolError> {
            // 执行面声明写路径（守卫为临时值，随 execute 结束释放——
            // run 后注册表无残留即证明 guard 无泄漏）
            let claim_ok = match &ctx.write_claims {
                Some(reg) => {
                    let holder = ctx
                        .write_claim_holder
                        .clone()
                        .unwrap_or_else(|| ctx.session_id.clone());
                    reg.claim_one(holder, "probe.txt", agent_tools::write_paths::ClaimMode::Write)
                        .is_ok()
                }
                None => false,
            };
            *self.observed.lock().unwrap_or_else(|e| e.into_inner()) = AssemblyProbeRecord {
                write_claims_some: ctx.write_claims.is_some(),
                quota_some: ctx.explore_docs_quota.is_some(),
                holder: ctx.write_claim_holder.clone(),
                claim_ok,
            };
            Ok(serde_json::json!({"probe": true}))
        }
    }

    /// T-EG-06 装配冒烟：with_options 装配块接线全链路生效——
    /// 注册表（互斥）/ 配额 / 默认中间件链；run 后守卫无泄漏
    #[tokio::test]
    async fn assembly_smoke_wires_registry_quota_and_middleware() {
        use agent_tools::context::ExploreDocsQuotaContext;
        use agent_tools::explore_quota::InMemoryExploreDocsQuotaStore;
        use conex_test_utils::TempWorkspace;
        use conex_types::session::AgentEndReason;
        use crate::stream::{ProviderStreamEvent, StopReason};

        let ws = TempWorkspace::new("eg06_assembly_smoke");
        // 探针工具注册进注册表（run 内工具调用走执行面）
        let probe = Arc::new(AssemblyProbeTool::default());
        let mut reg = ToolRegistry::new();
        reg.register(Arc::clone(&probe) as Arc<dyn agent_tools::definition::Tool>)
            .expect("注册探针工具");
        // 两轮脚本：第 1 轮工具调用（探针），第 2 轮文字收尾
        let provider = TestProvider::with_scripts(vec![
            vec![
                ProviderStreamEvent::tool_call(
                    Some("call_probe".into()),
                    "assembly_probe",
                    serde_json::json!({}),
                ),
                ProviderStreamEvent::stop(StopReason::Stop),
            ],
            vec![
                ProviderStreamEvent::text("装配完成"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ],
        ]);

        let quota_store = Arc::new(InMemoryExploreDocsQuotaStore::new());
        let mut loop_ =
            AgentSessionLoop::new("s1", "run-eg06", 16, Box::new(provider), Arc::new(reg));
        loop_ = loop_.with_options({
            let mut o: SessionLoopOptions = SessionLoopOptions::default();
            o.tool_exec.cwd = Some(ws.path_str());
            o.tool_exec.tool_middleware = vec![Arc::new(
                agent_tools::backup::BackupMiddleware::with_defaults(None),
            )];
            o.assembly.explore_docs_quota = Some(ExploreDocsQuotaContext {
                session_id: "s1".to_string(),
                run_id: "run-eg06".to_string(),
                granted: true,
                quota: 1,
                store: Some(Arc::clone(&quota_store) as Arc<dyn agent_tools::explore_quota::ExploreDocsQuotaStore>),
            });
            o
        });

        let outcome = loop_.run(user_input("装配冒烟")).await;
        assert_eq!(
            outcome.reason.to_core_reason(),
            AgentEndReason::Stop,
            "装配冒烟 run 对外应正常收场（YieldSuspended 映射为 Stop）"
        );
        assert!(outcome.error.is_none());

        // 1) 工具执行面装配可见（注册表 / 配额 / 持有者 / 声明成功）
        let record = probe.observed();
        assert!(record.write_claims_some, "执行面必须看到注册表");
        assert!(record.quota_some, "执行面必须看到配额上下文");
        assert_eq!(
            record.holder.as_deref(),
            Some("run-eg06"),
            "写声明持有者 = 当前 run 标识"
        );
        assert!(record.claim_ok, "执行面声明写路径必须成功");

        // 2) 注册表无泄漏：run 后活跃声明为空（探针声明随执行结束释放）
        let registry = loop_
            .tool_ctx
            .write_claims
            .clone()
            .expect("装配后注册表必须存在");
        assert!(
            registry.active_claims().is_empty(),
            "run 后不得残留活跃声明（guard 无泄漏）"
        );

        // 3) 中间件链生效：options 注入的写前自动备份（backup）同步到执行器
        assert_eq!(
            loop_.tool_executor.middleware_names(),
            vec!["backup".to_string()],
            "注入中间件链 = 备份中间件（with_options 同步链路）"
        );
    }

    // ── D1 A7：RunOutcome.provider_error 数据面（01 敲定 §2.3，验收断言）──

    /// D1 T7（A7）：3 次瞬态重试耗尽 → RunOutcome.provider_error =
    /// Some{kind: Network, retryable: true, retries: 3}（02 W1 验收①）；
    /// 退避走生产路径（1ms 级自定义配置，零注入，真实时钟可跑）
    #[tokio::test]
    async fn run_outcome_provider_error_filled_after_transient_exhaustion() {
        use conex_types::error::ProviderErrorKind;
        use conex_types::response::ClassifiedStreamError;
        use conex_types::session::AgentEndReason;
        let err = ClassifiedStreamError {
            kind: ProviderErrorKind::Network,
            message: "模拟断网".to_string(),
            retryable: true,
            retry_after_ms: None,
        };
        let provider = TestProvider::new(vec![crate::stream::ProviderStreamEvent::text("x")])
            .with_error(err);
        let mut loop_ = AgentSessionLoop::new("s1", "r1", 16, Box::new(provider), registry());
        loop_ = loop_.with_options({ let mut o: SessionLoopOptions = SessionLoopOptions::default(); o.retry.retry_backoff = Some(RetryBackoffConfig {
                base_ms: Some(1),
                max_ms: Some(1),
                total_budget_ms: None,
            }); o });
        let outcome = loop_.run(user_input("你好")).await;
        assert_eq!(outcome.reason, AgentEndReason::Error);
        let p = outcome.provider_error.expect("瞬态耗尽必须填充 provider_error");
        assert_eq!(p.kind, ProviderErrorKind::Network);
        assert!(p.retryable, "瞬态类 retryable=true");
        assert_eq!(p.retries, 3, "retries = run 内实际重试次数");
        // 观测面：fatal 发 runtime-error 事件（retryable 透传）
        assert!(
            outcome
                .events
                .iter()
                .any(|e| matches!(e, AgentEvent::RuntimeError { .. })),
            "fatal 必须发 runtime-error 事件"
        );
    }

    /// D1 T7（A7）：非瞬态 fatal（Auth）→ provider_error = Some{kind: Auth,
    /// retryable: false, retries: 0}（02 W1 验收②）
    #[tokio::test]
    async fn run_outcome_provider_error_auth_fatal_not_retryable() {
        use conex_types::error::ProviderErrorKind;
        use conex_types::response::ClassifiedStreamError;
        use conex_types::session::AgentEndReason;
        let err = ClassifiedStreamError {
            kind: ProviderErrorKind::Auth,
            message: "认证失败".to_string(),
            retryable: false,
            retry_after_ms: None,
        };
        let provider = Arc::new(
            TestProvider::new(vec![crate::stream::ProviderStreamEvent::text("x")])
                .with_error(err),
        );
        let mut loop_ = AgentSessionLoop::new("s1", "r1", 16, Box::new(provider.clone()), registry());
        let outcome = loop_.run(user_input("你好")).await;
        assert_eq!(outcome.reason, AgentEndReason::Error);
        let p = outcome.provider_error.expect("Auth fatal 必须填充 provider_error");
        assert_eq!(p.kind, ProviderErrorKind::Auth);
        assert!(!p.retryable, "非瞬态 retryable=false");
        assert_eq!(p.retries, 0, "非瞬态直接 fatal 无重试");
        assert_eq!(provider.call_count(), 1, "非瞬态错误不重试（单次调用）");
    }

    /// D1 T7（A7）：正常 stop 收场 → provider_error = None（02 W1 验收③）
    #[tokio::test]
    async fn run_outcome_provider_error_none_on_normal_stop() {
        use conex_types::session::AgentEndReason;
        let provider = TestProvider::text_reply("hi");
        let mut loop_ = AgentSessionLoop::new("s1", "r1", 16, Box::new(provider), registry());
        let outcome = loop_.run(user_input("你好")).await;
        assert_eq!(outcome.reason.to_core_reason(), AgentEndReason::Stop);
        assert!(
            outcome.provider_error.is_none(),
            "正常 stop 收场不得携带 provider_error"
        );
    }


