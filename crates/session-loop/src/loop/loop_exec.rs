//! 会话运行循环控制面（SR-06c · 拆分 · ≠ EL）：run 主循环 + 状态分派 +
//! catch 兜底恢复 + 收口（run / dispatch_once / recovery_decision /
//! apply_recovery / converge）；自 loop/mod.rs 拆出。

use conex_types::events::AgentEvent;
use conex_types::message::AgentMessage;
use conex_types::session::{AgentSessionEvent as E, AgentSessionState as S};

use crate::cache_tracker::{build_tracker, CacheStatsTracker};

use super::end::{EndDecision, RunOutcome};
use super::handlers;
use super::runner::AgentSessionLoop;
use super::{LoopError, RecoveryDecision};

impl AgentSessionLoop {
    /// 运行一次 run（01 §2.1：入队 → INITIALIZED → agent-start →
    /// while(!done) 分派 → agent-end 收敛）
    ///
    /// 可观测性（PE-04 T04.2）：整个 run 生命周期处于 `run` span 内，
    /// 携带 session_id / run_id 字段，供日志关联。
    pub async fn run(&mut self, input: AgentMessage) -> RunOutcome {
        let run_span = tracing::info_span!(
            "session_loop.run",
            session_id = %self.session_id,
            run_id = %input.id,
        );
        let _enter = run_span.enter();
        tracing::info!(message_len = input.blocks.len(), "run 启动");
        // 装配观测（30-P1 改动点 6，防注入时序回退）：run 起始记录 abort
        // 信号状态——若已触发说明外部强停在 run 启动前已到达（合法场景：
        // 用户取消先于 run 真正开始，L3 ≤ 下一安全点收场，不阻断）；壳层
        // 「每 run 重建 loop + 新信号」契约由装配面保证（run_task_impl
        // 每 run 新建 AbortSignal），跨 run 泄漏语义登记 A4-M3 邻接
        //（AbortSignal::reset 不实现——Notify 无法复位）。仅观测不阻断。
        if self.state.abort_signal.is_aborted() {
            tracing::info!(
                target: "session_loop",
                "run 起始 abort 信号已触发（启动前取消：安全点立即收场）"
            );
        }
        // 每 run 全新状态机（会话 / 对话 / 输入队列跨 run 持久）
        self.state.machine =
            crate::state::AgentSessionMachine::new(self.session_id.clone(), self.max_turns);
        // F2-02：max_turns=0 边界——预算不允许任何轮次，run 起始显式收场
        // （修复前首轮完整执行后 turn_index(1) >= 0 恒真才收场：用户消息已
        // 消费、provider 已调用，「max_turns=0 = 不允许任何轮次」语义失效）。
        // 收场原因与观测对齐 turn_complete 的 max-turns 路径（独立预算 reason
        // + runtime-error 观测事件 + error.occurred 钩子广播）
        if self.max_turns == 0 {
            self.state.emit_event(AgentEvent::RuntimeError {
                session_id: self.session_id.clone(),
                timestamp: crate::steering::now_iso_utc(),
                error: "maxTurns 预算用尽（turnIndex=0，maxTurns=0）".to_string(),
                retryable: Some(true),
            });
            if let Some(hooks) = &self.state.options.tool_exec.hooks {
                let _ = hooks
                    .dispatch(&crate::hooks::HookEvent::ErrorOccurred {
                        session_id: self.session_id.clone(),
                        error: "maxTurns 预算用尽（turnIndex=0，maxTurns=0）".to_string(),
                        retryable: true,
                    })
                    .await;
            }
            return self.converge(EndDecision::max_turns(&self.state)).await;
        }
        // 恢复阶梯计数归零（fresh run）
        self.state.length_upgrades = 0;
        self.state.transient_retries = 0;
        self.state.tool_promise_heals = 0;
        // D1 R1（预算起点归零）：预算起点随 run 重建——fresh run 从零预算
        // 计时（跨 run 持续故障由会话级熔断 provider_fail_streak 承担，
        // 04 文档 G9 的跨 run 计数重置问题由壳层收口计数解决）
        self.state.transient_retry_started_at = None;
        // D1 §3.4：fatal 摘要随 run 归零（converge 时 mem::take 移交后
        // 本处复位，防跨 run 残留脏数据）
        self.state.terminal_provider_error = None;
        self.state.continue_nudges = 0;
        self.state.terminal_error = None;
        self.state.events.clear();
        // 压缩护栏归零（fresh run，P4 §3.4.6 / §3.5）：
        // - compactions_this_run：单 run 压缩上限计数（仅预检/用户消息
        //   边界/分阶段触发约束——E2 F2 层 2 裁决后溢出阶梯绕开本计数）；
        // - compression_retries：溢出压缩重试计数（上限
        //   [SessionLoopOptions::compact_overflow_retries]，默认 2）——
        //   stream_error.rs 压缩阶梯（ContextLengthExceeded 用尽后 /
        //   PayloadTooLarge）消费。归零语义 T-34（第四波）确认闭合：
        //   每 run 起始清零，压缩 + 重试上限后不可再超（防「压缩→仍超→
        //   再压缩」死循环）。
        // last_compaction_at 不在此归零（跨 run 时间戳护栏，压缩边界持续
        // 有效；跨重启由 orchestrator SessionContextMeta 持久化恢复，T-34）
        self.state.compaction.compactions_this_run = 0;
        self.state.compaction.compression_retries = 0;
        // E2 F1 L3：溢出 LLM 不可用标记随 run 归零（fatal 附注只在触发
        // 压缩阶梯的 run 内消费）
        self.state.compaction.overflow_llm_unavailable = false;
        // 缓存跟踪器复位（fresh run，P5 S2 / T-36 / §3.4.5「每 run 重建」语义）：
        // run 内跨 turn 基线在 tracker 内部维护；跨 run 基线持久化由 engine
        // 层负责（T-40，经 CacheStatsTracker::baseline 移交）——本层只保证
        // 每 run 从干净状态开始（压缩代数归 0、签名基线作废、聚合清零）。
        self.state.compaction.cache_tracker =
            build_tracker(self.state.options.cache.cache_tracking.as_ref());

        // 用户消息入队（force 环）→ INITIALIZED → agent-start（01 §2.1）
        // EV-12 输入留痕写点：用户消息主路径入队即落库（save_pending_input，
        // fail-open）——与 enqueue_input（loop_runner.rs）共同构成「每条
        // 用户消息 1 INSERT」；消费删点见 record_message（handlers/mod.rs）
        let input_snapshot = input.clone();
        self.state.input_queue.enqueue_force(input);
        self.spawn_pending_input_save(&input_snapshot);
        if let Err(err) = handlers::dispatch(&mut self.state, E::Initialized) {
            return self
                .converge(EndDecision::error(&self.state, err.message()))
                .await;
        }
        let start_event = AgentEvent::AgentStart {
            session_id: self.session_id.clone(),
            timestamp: crate::steering::now_iso_utc(),
        };
        self.state.emit_event(start_event);
        // I8-E1 第一批：session.start 钩子广播（run 启动处；载荷最小子集
        // sessionId；observe 观察者失败不阻塞 run 启动——dispatch 内部
        // 已按 failStrategy 处置 + 错误事件化）
        if let Some(hooks) = &self.state.options.tool_exec.hooks {
            let _ = hooks
                .dispatch(&crate::hooks::HookEvent::SessionStart {
                    session_id: self.session_id.clone(),
                })
                .await;
        }

        // while(!done) 按当前状态分派 handler（01 §2.1）
        while !self.state.machine.is_done() {
            let outcome = self.dispatch_once().await;
            match outcome {
                Ok(handler_outcome) => {
                    if let Some(end) = handler_outcome.end {
                        return self.converge(end).await;
                    }
                }
                Err(err) => {
                    // catch 兜底（01 §2.1 步骤 4）：恢复钩子裁决 retry/skip/abort
                    let decision = self.recovery_decision(&err);
                    if let Some(end) = self.apply_recovery(decision, &err).await {
                        return self.converge(end).await;
                    }
                }
            }
        }
        // 状态机已到 done 但未收敛（防御性）：按机器 endReason 收场
        let reason = self.state.machine.context().end_reason;
        self.converge(EndDecision::new(
            reason,
            self.state.terminal_error.clone(),
            None,
            &self.state,
        ))
        .await
    }

    /// 单次分派（按当前状态路由到对应 handler）
    async fn dispatch_once(&mut self) -> Result<handlers::HandlerOutcome, LoopError> {
        match self.state.machine.state() {
            S::AwaitingInput => handlers::awaiting_input::handle(&mut self.state).await,
            S::PreparingTurn => handlers::prepare_turn::handle(&mut self.state).await,
            S::Streaming => {
                handlers::streaming::handle(
                    &mut self.state,
                    self.provider.as_ref(),
                    self.delta_sink.as_deref(),
                )
                .await
            }
            S::SteeringEvaluation => handlers::steering_evaluation::handle(&mut self.state).await,
            S::ExecutingTools => {
                // T09.6/P8（AU-04 F9）：Arc 克隆传递（Arc 克隆便宜），
                // 供并行组内各 future 共享审批门
                let approval = self.approval.clone();
                handlers::executing_tools::handle(
                    &mut self.state,
                    &self.tool_executor,
                    &self.tool_ctx,
                    &self.tool_options,
                    approval,
                )
                .await
            }
            S::TurnComplete => handlers::turn_complete::handle(&mut self.state).await,
            // idle（run 前）/ done（循环条件已排除）：防御性收敛
            S::Idle | S::Done => Err(LoopError::internal(format!(
                "不可分派状态：{:?}",
                self.state.machine.state()
            ))),
        }
    }

    /// catch 兜底决策（01 §2.1 步骤 4：abort/cancel 类 → Abort；
    /// 其余走 recovery hook）
    pub(crate) fn recovery_decision(&self, err: &LoopError) -> RecoveryDecision {
        if self.state.abort_signal.is_aborted() {
            return RecoveryDecision::Abort;
        }
        if let Some(hook) = &self.state.options.hooks.recovery_hook {
            // F6：传结构化错误（码分类裁决）
            return hook.decide(err.crish(), self.state.machine.state());
        }
        // 缺省（F1-01 根因修复）：不可恢复内部错误 → Fatal（error 收场），
        // 与模块头注释「abort 类 → aborted，否则 error 收场」一致——
        // 不再缺省 Skip 把错误静默降级为 NO_TOOL_CALLS 正常收场
        RecoveryDecision::Fatal
    }

    /// 应用恢复决策；返回 Some 表示 run 已收敛
    pub(crate) async fn apply_recovery(
        &mut self,
        decision: RecoveryDecision,
        err: &LoopError,
    ) -> Option<EndDecision> {
        // 错误日志（T04.3-3）：catch 兜底错误按类型化错误码记录（Q29 消费侧；
        // 位于 run span 内，session_id/run_id 由 span 字段携带；retryable
        // 只表「可重试」，与收场正交）
        tracing::error!(
            target: "run",
            event = "runtime_error",
            error_code = %err.crish().code,
            retryable = decision == RecoveryDecision::Retry,
            "run 循环错误（catch 兜底）"
        );
        // 观测事件（runtime-error：retryable 只表「可重试」，与收场正交）
        self.state.emit_event(AgentEvent::RuntimeError {
            session_id: self.session_id.clone(),
            timestamp: crate::steering::now_iso_utc(),
            error: err.message().to_string(),
            retryable: Some(decision == RecoveryDecision::Retry),
        });
        // I8-E1 第二批：error.occurred 钩子广播（引擎错误分类处——runtime-error
        // 事件同点位；observe 默认，失败吞掉 + 计数，收场流程继续）
        if let Some(hooks) = &self.state.options.tool_exec.hooks {
            let _ = hooks
                .dispatch(&crate::hooks::HookEvent::ErrorOccurred {
                    session_id: self.session_id.clone(),
                    error: err.message().to_string(),
                    retryable: decision == RecoveryDecision::Retry,
                })
                .await;
        }
        match decision {
            RecoveryDecision::Retry => {
                // 仅 streaming 下可 NO_PROGRESS_CONTINUE 重进 provider 循环；
                // 其余状态按 error 收场（防御）
                if self.state.machine.state() == S::Streaming
                    && handlers::dispatch(&mut self.state, E::NoProgressContinue).is_ok()
                {
                    return None;
                }
                Some(EndDecision::error(&self.state, err.message()))
            }
            RecoveryDecision::Skip => {
                // skip 走 dispatchErrorRecovery（状态 → 继续事件映射）：
                // streaming → NO_TOOL_CALLS 正常收场该轮；其余按 error 收场
                if self.state.machine.state() == S::Streaming
                    && handlers::dispatch(&mut self.state, E::NoToolCalls).is_ok()
                {
                    return None;
                }
                Some(EndDecision::error(&self.state, err.message()))
            }
            RecoveryDecision::Abort => {
                // abort：按当前状态 ABORT（streaming/executing-tools → turn-complete，
                // 内容保留；其余 → done）
                if handlers::dispatch(&mut self.state, E::Abort).is_ok() {
                    // 若推进到 turn-complete 则交回主循环收敛（内容保留），
                    // 否则直接 aborted 收场
                    if self.state.machine.state() != S::TurnComplete {
                        // EV-08：孤儿 turn-start 兜底——直接 aborted 收场
                        // 不经 turn_complete，补发 turn-end 闭合
                        handlers::emit_missing_turn_end(&mut self.state);
                        return Some(EndDecision::aborted(&self.state));
                    }
                    return None;
                }
                // dispatch 失败（状态机拒绝 ABORT）：同样直接收场，补发闭合
                handlers::emit_missing_turn_end(&mut self.state);
                Some(EndDecision::aborted(&self.state))
            }
            RecoveryDecision::Fatal => {
                // 致命（缺省决策）：不经状态分派，直接 error 收场——不派发
                // NO_TOOL_CALLS（F1-01 根因修复：内部错误不得静默降级为
                // streaming 正常收场，错误必须随 outcome.error 暴露给用户）
                Some(EndDecision::error(&self.state, err.message()))
            }
        }
    }

    /// 收口：agent-end 事件 + RunOutcome（01 §2.1：reason 必填、error 可选）
    ///
    /// PE-09 T09.3.3：对话经 `mem::take` 零拷贝移交 [RunOutcome]（不再
    /// 每 run 收口全量克隆，O(n) → O(1)）；行为变化面 R4 已登记——converge
    /// 后 `state.conversation` 清空，真实接线每 run 重建 loop 无影响，
    /// 测试路径经 [Self::with_initial_conversation] 续接。
    async fn converge(&mut self, decision: EndDecision) -> RunOutcome {
        // EV-08：孤儿 turn-start **最终兜底**——任何收敛路径（含未来新增
        // 路径 / 防御性收敛）在 agent-end 前闭合未完成的 turn（converge 是
        // 全部收敛路径的唯一收口；current_turn_index 为 None 时幂等无操作，
        // 与各收敛路径显式挂接并存不重复发射）
        handlers::emit_missing_turn_end(&mut self.state);
        let reason = decision.reason;
        let error = decision.error.clone();
        let diagnostic = decision.diagnostic.clone();
        let end_event = AgentEvent::AgentEnd {
            session_id: self.session_id.clone(),
            timestamp: crate::steering::now_iso_utc(),
            reason,
            error: error.clone(),
        };
        self.state.emit_event(end_event);
        // I8-E1 第一批：session.end 钩子广播（run 收场终态；observe 默认，
        // 失败吞掉 + 计数，收场流程继续——03 §2.4 表）
        if let Some(hooks) = &self.state.options.tool_exec.hooks {
            let _ = hooks
                .dispatch(&crate::hooks::HookEvent::SessionEnd {
                    session_id: self.session_id.clone(),
                })
                .await;
        }
        tracing::info!(end_reason = ?reason, has_error = error.is_some(), "run 收场");
        RunOutcome {
            reason,
            error,
            diagnostic,
            messages: std::mem::take(&mut self.state.conversation),
            events: std::mem::take(&mut self.state.events),
            turn_index: decision.turn_index,
            tool_call_count: decision.tool_call_count,
            steering_count: decision.steering_count,
            // 缓存统计收口（P5 S2 / T-36）：tracker.finish() 产出 run 级聚合；
            // 未配置 / 无样本 → None（缺省向后兼容，T-40 落库与事件消费）
            cache_stats: self
                .state
                .compaction
                .cache_tracker
                .take()
                .map(CacheStatsTracker::finish),
            // provider 错误摘要（D1 §3.4）：fatal 填充 → 收口零拷贝移交
            // （与 messages/events 同批 mem::take；D2/D3 消费，00 §6 契约）
            provider_error: std::mem::take(&mut self.state.terminal_provider_error),
        }
    }
}

