// SR-06c · 拆分 · ≠ EL：loop/mod.rs 测试旁挂（include! 接线，无孤儿；
// 全部既有测试原样保留）。
use super::*;
use agent_tools::registry::ToolRegistry;
use conex_types::error::CrishError;
use conex_types::events::AgentEvent;
use conex_types::message::AgentMessage;
use conex_types::session::{
    AgentSessionEvent as E, AgentSessionState as S, AgentSessionState,
};
use std::sync::Arc;

    use conex_types::{AgentMessageBlock, AgentMessageRole};
    use crate::testing::TestProvider;

    fn registry() -> Arc<ToolRegistry> {
        Arc::new(ToolRegistry::new())
    }

    /// T06.4.4：构造器默认值断言——SessionLoopOptions 缺省与字段一致
    /// （删 2 增 1 后：无 payload_recovery_limit / compression_hook，
    /// 新增 idempotency_enabled=false 默认关闭）
    #[test]
    fn default_options_match_documented_defaults() {
        let options = SessionLoopOptions::default();
        assert_eq!(options.retry.transient_retry_limit, 3);
        assert_eq!(options.retry.length_upgrade_limit, 2);
        assert_eq!(options.retry.continue_nudge_limit, 1);
        assert!(options.hooks.steering_enabled, "steering 默认启用（行为不变）");
        assert!(!options.tool_exec.idempotency_enabled, "幂等默认关闭（Q14 接线默认行为不变）");
        assert!(options.hooks.turn_end_hook.is_none());
        assert!(options.hooks.should_stop_after_turn.is_none());
        assert!(options.hooks.recovery_hook.is_none());
        assert!(options.tool_exec.cwd.is_none());
        assert!(options.tool_exec.assistant_client_message_id.is_none());
        assert!(
            options.assembly.system_prompt.is_none(),
            "system_prompt 默认不发送（P1 阶段 2 透传字段）"
        );
        // P4 阶段 2-2/3-2：预算与压缩配置缺省全部关闭（未配置即现状）
        assert!(
            options.assembly.context_budget.is_none(),
            "context_budget 缺省 None = 不钳制不预检（向后兼容）"
        );
        assert!(
            options.compaction.compaction_policy.is_none(),
            "compaction_policy 缺省 None = 无自动压缩（向后兼容）"
        );
        assert!(options.compaction.summarizer.is_none(), "summarizer 缺省 None = L1 静态占位符");
        assert_eq!(
            options.compaction.max_auto_compactions_per_run, 1,
            "单 run 自动压缩上限默认 1（P4 §3.4.6）"
        );
        assert!(
            options.cache.cache_tracking.is_none(),
            "cache_tracking 缺省 None = 不启用缓存测量（T-36 向后兼容）"
        );
        // C1b（反向依赖移出）：默认中间件链 = 空——核心不再内建
        // BackupMiddleware 具体实例（不变量 5；写前备份由壳层 run_launch.rs
        // 唯一注入，测试/编排经 with_tool_middleware 注入）
        assert!(
            options.tool_exec.tool_middleware.is_empty(),
            "默认中间件链为空（C1b：核心不内建具体策略实例）"
        );
        // T-EG-06：注册表与配额缺省 None（装配发生在 with_options 装配块：
        // 注册表按工作区根新建并注入 ESC 判定器；配额 None = 主 agent
        // 不受约束）
        assert!(
            options.assembly.write_claims.is_none(),
            "write_claims 缺省 None = 由 with_options 按根新建"
        );
        assert!(
            options.assembly.explore_docs_quota.is_none(),
            "explore_docs_quota 缺省 None = 主 agent 不受配额约束"
        );
        // T-33：摘要后台调度缺省 None = 生产退避参数（1s/3s/9s）
        assert!(
            options.summary.summary_dispatch.is_none(),
            "summary_dispatch 缺省 None = 生产缺省退避参数（T-33）"
        );
        // E2 F2 层 1（低功耗模式）：窗口内累计尝试护栏默认 8 / 观察窗口
        // 默认 30min（设计默认，E2 §3.1 层 1）
        assert_eq!(
            options.summary.compact_summary_max_attempts,
            summary_dispatch::DEFAULT_RETRY_GUARD_MAX_ATTEMPTS,
            "compact_summary_max_attempts 默认 8（累计成本护栏）"
        );
        assert_eq!(
            options.summary.compact_summary_retry_window_ms,
            summary_dispatch::DEFAULT_RETRY_GUARD_WINDOW_MS,
            "compact_summary_retry_window_ms 默认 30min（观察窗口）"
        );
    }

    /// C1b（反向依赖移出）：两条注入面自证——with_tool_middleware 装配
    /// 中间件链（默认空链替换）、with_steering 替换 steering 协调器
    /// （核心 new() 不再内建具体策略实例，注入面行为必须可验证）
    #[test]
    fn c1b_injection_surfaces_replace_defaults() {
        use agent_tools::backup::BackupMiddleware;
        use crate::steering::{
            RecoverySteeringStrategy, SteeringCoordinator, SteeringCoordinatorOptions,
        };

        // with_tool_middleware：默认空链 → 注入写前备份中间件（与壳层
        // run_launch.rs:605 同构造）
        let options = SessionLoopOptions::default().with_tool_middleware(vec![Arc::new(
            BackupMiddleware::with_defaults(None),
        )]);
        assert_eq!(options.tool_exec.tool_middleware.len(), 1, "注入链恰 1 项");
        assert_eq!(options.tool_exec.tool_middleware[0].name(), "backup");

        // with_steering：默认空策略协调器 → 注入 RecoverySteeringStrategy
        // 协调器（预算可观测：默认 3 → 注入预算 7 替换生效）
        let provider = TestProvider::text_reply("hi");
        let loop_ = AgentSessionLoop::new("s1", "r1", 16, Box::new(provider), registry());
        assert_eq!(
            loop_.state.steering.budget_remaining(),
            3,
            "默认空策略协调器预算 = 默认 3（行为不变）"
        );
        let loop_ = loop_.with_steering(SteeringCoordinator::new(
            vec![Box::new(RecoverySteeringStrategy::default())],
            SteeringCoordinatorOptions {
                max_steering_budget: Some(7),
            },
        ));
        assert_eq!(
            loop_.state.steering.budget_remaining(),
            7,
            "注入协调器生效（预算 7 替换默认 3）"
        );
    }

    /// T-33：摘要调度配置缺省值 = 生产参数（退避 1s/3s/9s ±20% jitter、
    /// 单次墙钟 60s、attempts 上限 4 含同步）
    #[test]
    fn summary_dispatch_config_defaults_match_plan() {
        let config = summary_dispatch::SummaryDispatchConfig::default();
        assert_eq!(
            config.backoff_ms,
            summary_dispatch::SUMMARY_BACKOFF_MS.to_vec(),
            "退避序列必须为 1s/3s/9s（00-plan §6.4）"
        );
        assert!(
            (config.jitter - summary_dispatch::SUMMARY_JITTER_RATIO).abs() < 1e-9,
            "jitter 默认 ±20%"
        );
        assert_eq!(
            config.max_wall_ms,
            summary_dispatch::LOOP_SUMMARY_MAX_WALL_MS,
            "单次调用墙钟 ≈60s（04 §5.2 / 评审 02 P1-10）"
        );
        assert_eq!(
            config.max_attempts,
            summary_dispatch::MAX_SUMMARY_ATTEMPTS,
            "attempts 上限 4（含同步那次）"
        );
    }

    /// T-36 首尾双约束（正例）：user 开头 + 无链对话水合通过；
    /// 含水合链 + user 收尾通过
    #[test]
    fn hydration_head_tail_accepts_valid_shapes() {
        fn msg(id: &str, role: AgentMessageRole, text: &str) -> Arc<AgentMessage> {
            Arc::new(AgentMessage {
                id: id.to_string(),
                role,
                created_at: "2026-08-03T10:00:00.000Z".to_string(),
                blocks: vec![AgentMessageBlock::Text {
                    text: text.to_string(),
                }],
                metadata: None,
                client_message_id: None,
                content: None,
            })
        }
        // 无 system + user 首条 → 通过（长会话历史 / run outcome 续接）
        let conversation = vec![
            msg("h0", AgentMessageRole::User, "历史"),
            msg("h1", AgentMessageRole::Assistant, "回复"),
        ];
        handlers::assert_conversation_head_tail(&conversation);
        // 含水合链 + user 收尾 → 通过（B4 形状）
        let with_chain = vec![
            msg("compacted-summary-1-1", AgentMessageRole::Assistant, "链摘要"),
            msg("u1", AgentMessageRole::User, "继续"),
        ];
        handlers::assert_conversation_head_tail(&with_chain);
        // system 首条 → 通过（wire 首条 = system）
        let with_system = vec![
            msg("sys", AgentMessageRole::System, "系统提示"),
            msg("u1", AgentMessageRole::User, "你好"),
        ];
        handlers::assert_conversation_head_tail(&with_system);
    }

    /// T-36 首尾双约束（反例）：无 system + assistant 首条 → debug 断言
    /// 拒绝（provider 400 风险，评审 02 P1-7）
    #[test]
    #[should_panic(expected = "首条（跳过链后）必须为 user")]
    fn hydration_rejects_assistant_head_without_system() {
        fn msg(role: AgentMessageRole) -> Arc<AgentMessage> {
            Arc::new(AgentMessage {
                id: "m".to_string(),
                role,
                created_at: "2026-08-03T10:00:00.000Z".to_string(),
                blocks: vec![AgentMessageBlock::Text {
                    text: "正文".to_string(),
                }],
                metadata: None,
                client_message_id: None,
                content: None,
            })
        }
        let conversation = vec![msg(AgentMessageRole::Assistant), msg(AgentMessageRole::User)];
        handlers::assert_conversation_head_tail(&conversation);
    }

    /// T-36 首尾双约束（反例）：含水合链 + 非 user 收尾 → debug 断言拒绝
    /// （B4 形状：链后保留区必须以 user 收尾）
    #[test]
    #[should_panic(expected = "必须以 user 收尾")]
    fn hydration_rejects_chain_with_non_user_tail() {
        fn msg(id: &str, role: AgentMessageRole) -> Arc<AgentMessage> {
            Arc::new(AgentMessage {
                id: id.to_string(),
                role,
                created_at: "2026-08-03T10:00:00.000Z".to_string(),
                blocks: vec![AgentMessageBlock::Text {
                    text: "正文".to_string(),
                }],
                metadata: None,
                client_message_id: None,
                content: None,
            })
        }
        // 链（assistant）+ 保留区收尾 assistant → 尾部约束拒绝（首条
        // 约束已通过：链后首条 = u1 user）
        let conversation = vec![
            msg("compacted-summary-1-1", AgentMessageRole::Assistant),
            msg("u1", AgentMessageRole::User),
            msg("a1", AgentMessageRole::Assistant),
        ];
        handlers::assert_conversation_head_tail(&conversation);
    }

    /// T06.4.4：with_options 派生状态同步——cwd 联动到工具执行上下文
    #[test]
    fn with_options_syncs_cwd_to_tool_ctx() {
        let provider = TestProvider::text_reply("hi");
        let loop_ = AgentSessionLoop::new("s1", "r1", 16, Box::new(provider), registry());
        let loop_ = loop_.with_options({ let mut o: SessionLoopOptions = SessionLoopOptions::default(); o.tool_exec.cwd = Some("C:\\work".into()); o });
        assert_eq!(loop_.tool_ctx.cwd.as_deref(), Some("C:\\work"));
    }

    /// T06.4.4：with_options 派生状态同步——idempotency_enabled 开关联动
    /// 工具执行器（true 注入守卫 / false 移除）
    #[test]
    fn with_options_syncs_idempotency_guard() {
        let provider = TestProvider::text_reply("hi");
        let loop_ = AgentSessionLoop::new("s1", "r1", 16, Box::new(provider), registry());
        // 开启：注入守卫
        let loop_ = loop_.with_options({ let mut o: SessionLoopOptions = SessionLoopOptions::default(); o.tool_exec.idempotency_enabled = true; o });
        assert!(loop_.tool_executor.idempotency_enabled());
        // 关闭：守卫移除
        let loop_ = loop_.with_options(SessionLoopOptions::default());
        assert!(!loop_.tool_executor.idempotency_enabled());
    }

    /// F6 / T06.5.3：RecoveryHook::decide 接收结构化 CrishError——
    /// 钩子基于码分类裁决而非文本匹配（错误码跨层保留，AA-01 Q29）
    #[test]
    fn recovery_hook_receives_crish_error_code() {
        use conex_types::error::codes;
        use std::sync::Mutex;

        struct CodeCapturingHook {
            received: Arc<Mutex<Option<String>>>,
        }
        impl RecoveryHook for CodeCapturingHook {
            fn decide(
                &self,
                error: &CrishError,
                _state: AgentSessionState,
            ) -> RecoveryDecision {
                *self
                    .received
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(error.code.clone());
                RecoveryDecision::Skip
            }
        }

        let provider = TestProvider::text_reply("hi");
        let mut loop_ = AgentSessionLoop::new("s1", "r1", 16, Box::new(provider), registry());
        let received = Arc::new(Mutex::new(None));
        let hook = CodeCapturingHook {
            received: Arc::clone(&received),
        };
        loop_ = loop_.with_options({ let mut o: SessionLoopOptions = SessionLoopOptions::default(); o.hooks.recovery_hook = Some(Arc::new(hook)); o });

        // 显式码构造的 LoopError → decide 收到 &CrishError（码 + 可重试性）
        let err = LoopError::with_code(codes::TOOL_EXECUTION_FAILED, "工具执行失败");
        let decision = loop_.recovery_decision(&err);
        assert_eq!(decision, RecoveryDecision::Skip);
        let received_code = received
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .expect("decide 必须收到结构化错误");
        assert_eq!(received_code, codes::TOOL_EXECUTION_FAILED);
    }

    // ── F1-01（PS-04 T4.1）：缺省恢复决策红测试 ──
    // 缺陷：无 recovery_hook 且未 abort 时 `recovery_decision` 缺省返回
    // Skip（:722），streaming 态被静默降级为 NO_TOOL_CALLS 正常收场——
    // 与模块头注释「abort 类 → aborted，否则 error 收场」相反（F1-01）。

    /// T4.1-R1/R2：缺省恢复决策不是 Skip 且恒为 Fatal——无 hook、未 abort
    /// 时内部错误必须走 error 收场路径（修复前返回 Skip，R1 红；修复后
    /// 断言缺省恒为 Fatal，R2 绿）
    #[test]
    fn recovery_default_is_not_skip() {
        let provider = TestProvider::text_reply("hi");
        let loop_ = AgentSessionLoop::new("s1", "r1", 16, Box::new(provider), registry());
        let err = LoopError::internal("模拟 handler 内部错误");
        let decision = loop_.recovery_decision(&err);
        assert_ne!(
            decision,
            RecoveryDecision::Skip,
            "无恢复钩子且未 abort 时缺省不得 Skip（错误被静默降级为正常收场，F1-01）"
        );
        assert_eq!(
            decision,
            RecoveryDecision::Fatal,
            "缺省决策应为 Fatal（error 收场，F1-01 契约）"
        );
    }

    /// T4.1-R4（红）：Streaming 态内部错误（无 hook）经 catch 兜底
    /// （recovery_decision + apply_recovery，即 run() 的 catch 逻辑
    /// loop/mod.rs:655-661）必须收敛为 error 收场——修复前缺省 Skip →
    /// 派发 NO_TOOL_CALLS 返回 None（继续循环 → turn-complete 以 stop
    /// 收场，错误被吞），断言收敛失败
    #[tokio::test]
    async fn recovery_default_converges_to_error_not_stop() {
        use conex_types::session::AgentEndReason;
        let provider = TestProvider::text_reply("hi");
        let mut loop_ = AgentSessionLoop::new("s1", "r1", 16, Box::new(provider), registry());
        // 按 transition.rs:271-307 合法序列推进到 Streaming 态
        //（Idle --Initialized--> AwaitingInput --InputReady--> PreparingTurn
        //  --TurnPrepared--> Streaming）
        loop_.state.machine = crate::state::AgentSessionMachine::new("s1", 16);
        loop_.state.machine.dispatch(E::Initialized).expect("合法转移：Initialized");
        loop_.state.machine.dispatch(E::InputReady).expect("合法转移：InputReady");
        loop_.state.machine.dispatch(E::TurnPrepared).expect("合法转移：TurnPrepared");
        assert_eq!(loop_.state.machine.state(), S::Streaming);
        // 模拟 catch 兜底路径（handler 抛内部错误）
        let err = LoopError::internal("handler 内部错误");
        let decision = loop_.recovery_decision(&err);
        let end = loop_.apply_recovery(decision, &err).await;
        let end = end.expect("缺省恢复必须收敛（错误不得静默降级为继续循环）");
        assert_eq!(
            end.reason, AgentEndReason::Error,
            "streaming 态内部错误必须 error 收场（而非继续循环 stop 收场）"
        );
        assert_eq!(end.error.as_deref(), Some("handler 内部错误"));
    }

    /// T4.1-R3（契约锁定）：Skip 语义不回归——恢复钩子**显式**返回 Skip
    /// 时 streaming 态仍按 NO_TOOL_CALLS 继续循环（apply_recovery 返回
    /// None）；Fatal 恒 error 收场（Some(EndDecision) 且 reason == Error）
    #[tokio::test]
    async fn recovery_skip_via_hook_keeps_loop_but_fatal_converges() {
        use conex_types::session::AgentEndReason;

        struct SkipHook;
        impl RecoveryHook for SkipHook {
            fn decide(&self, _error: &CrishError, _state: AgentSessionState) -> RecoveryDecision {
                RecoveryDecision::Skip
            }
        }

        let provider = TestProvider::text_reply("hi");
        let mut loop_ = AgentSessionLoop::new("s1", "r1", 16, Box::new(provider), registry());
        loop_ = loop_.with_options({ let mut o: SessionLoopOptions = SessionLoopOptions::default(); o.hooks.recovery_hook = Some(Arc::new(SkipHook)); o });
        // 推进到 Streaming 态（transition.rs 合法序列）
        loop_.state.machine = crate::state::AgentSessionMachine::new("s1", 16);
        loop_.state.machine.dispatch(E::Initialized).expect("合法转移：Initialized");
        loop_.state.machine.dispatch(E::InputReady).expect("合法转移：InputReady");
        loop_.state.machine.dispatch(E::TurnPrepared).expect("合法转移：TurnPrepared");
        assert_eq!(loop_.state.machine.state(), S::Streaming);

        let err = LoopError::internal("模拟内部错误");
        // 钩子显式 Skip：streaming 态继续循环（Skip 语义不回归）
        let decision = loop_.recovery_decision(&err);
        assert_eq!(decision, RecoveryDecision::Skip);
        let end = loop_.apply_recovery(decision, &err).await;
        assert!(end.is_none(), "钩子显式 Skip 在 streaming 态应继续循环");

        // Fatal：恒 error 收场（不经状态分派）
        let end = loop_
            .apply_recovery(RecoveryDecision::Fatal, &err)
            .await
            .expect("Fatal 必须收敛");
        assert_eq!(end.reason, AgentEndReason::Error);
        assert_eq!(end.error.as_deref(), Some("模拟内部错误"));
    }

    /// 0 预算无上限重构（对齐方案 04 §4.2）：max_turns=0 代表无限预算模式，
    /// 允许正常执行轮次而不被误杀；单轮纯文本回复正常以 Stop 收场。
    #[tokio::test]
    async fn run_with_max_turns_zero_represents_unlimited_and_executes_normally() {
        use conex_types::session::AgentEndReason;
        let provider = Arc::new(TestProvider::text_reply("hi"));
        let mut loop_ = AgentSessionLoop::new("s1", "r1", 0, Box::new(provider.clone()), registry());
        let outcome = loop_.run(user_input("hello")).await;
        assert_eq!(
            outcome.reason.to_core_reason(),
            AgentEndReason::Stop,
            "max_turns=0 无限模式下，纯文本回复对外以 stop 收场（内核 YieldSuspended 映射），绝不被误判为 MaxTurns"
        );
        assert_eq!(outcome.turn_index, 1, "max_turns=0 允许正常执行轮次");
        assert_eq!(provider.call_count(), 1, "max_turns=0 正常调用 provider");
        assert!(
            outcome
                .events
                .iter()
                .any(|e| matches!(e, AgentEvent::TurnStart { turn_index: 1, .. })),
            "max_turns=0 正常产生首轮 turn-start 事件"
        );
    }

    /// F2-02 边界锚定：max_turns=1 首轮完整执行后以 max-turns 收场
    /// （「max_turns=N = 允许 N 轮」语义不回归）
    #[tokio::test]
    async fn run_with_max_turns_one_stops_after_first_turn() {
        use conex_types::session::AgentEndReason;
        let provider = Arc::new(TestProvider::text_reply("hi"));
        let mut loop_ = AgentSessionLoop::new("s1", "r1", 1, Box::new(provider.clone()), registry());
        let outcome = loop_.run(user_input("hello")).await;
        assert_eq!(outcome.reason, AgentEndReason::MaxTurns);
        assert_eq!(outcome.turn_index, 1, "max_turns=1 允许首轮执行");
        assert_eq!(provider.call_count(), 1, "max_turns=1 恰好调用一次 provider");
        assert!(
            outcome
                .events
                .iter()
                .any(|e| matches!(e, AgentEvent::TurnStart { turn_index: 1, .. })),
            "max_turns=1 必须产生第 1 轮 turn-start 事件"
        );
    }


