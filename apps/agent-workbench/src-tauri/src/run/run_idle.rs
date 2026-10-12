//! run/run_idle.rs（SR-02 · 拆分 · ≠ EL）
//!
//! 经 run/mod.rs 聚合接线；顶层符号 pub(crate) 化供兄弟模与门面 re-export。
use super::*;
//
// 独立子模块（文件内）：drive_run_loop 与 run_task_impl 相互引用 opaque
// future（drive_run_loop 收口经 spawn_idle_resume_run 拉起新 run →
// run_task_impl → spawn(drive_run_loop)），同模块内递归 async fn 的
// auto-trait（Send）检查不被 Rust 支持（"fetching the hidden types of an
// opaque inside of the defining scope"）——跨模块定义后检查可终止。
pub(crate) mod idle_resume {
    use super::*;
    use orchestrator::steering_queue::SteeringInputEntry;

    /// 续 run 连续空转护栏上限（连续 N 次续 run 均无 AI 产出 → 停止续 run，
    /// 防空转风暴；默认 3 次）
    pub(super) const IDLE_RESUME_MAX_EMPTY_ROUNDS: u32 = 3;

    /// T-CF-11：唤醒源非空判定器（TimerRegistry 活跃 / SchedulerRegistry
    /// enabled 的判定封装；async 谓词——list_active 为 async 调用）。
    ///
    /// 生产接线：TimerRegistry 非空判定在 [CoreRunState::new] 经
    /// [EngineHandle::timer_registry] 的 list_active 封装注入；SchedulerRegistry
    /// 非空判定在 [CoreRunState::new] 经 [EngineHandle::scheduler_registry]
    /// 的 has_active 封装注入（30 方案 P7；None = 装配降级，Cron 不参与
    /// 续 run 判定，行为与接线前一致）。
    pub(crate) type WakeSourceCheck =
        Arc<dyn Fn() -> Pin<Box<dyn Future<Output = bool> + Send>> + Send + Sync>;

    /// T-CF-11：idle 续 run 拉起器（async；生产 = 经 [spawn_idle_resume_run]
    /// 复用 run 装配拉起新 run；测试 = 注入替身断言判定与注入载荷）。
    ///
    /// mode：续 run 类型（idle-resume / recovery-retry / content-resume /
    /// goal-continue）——D2 §3.4 拉起器 mode 参数化（自动恢复类型可观测，
    /// G-6）。
    pub(crate) type ResumeLauncher = Arc<
        dyn Fn(
                &Arc<CoreRunState>,
                &str,
                &str,
                Vec<AgentMessage>,
            ) -> Pin<Box<dyn Future<Output = ()> + Send>>
            + Send
            + Sync,
    >;

    /// 续 run 判定结果（mode + 注入消息；mode 供拉起器区分自动恢复类型）
    pub(crate) struct ResumeDecision {
        /// 续 run 类型（idle-resume / recovery-retry / content-resume /
        /// goal-continue）
        pub mode: &'static str,
        /// 注入消息（队列条目批量聚合 / goal 前缀 / 续写模板）
        pub inject: Vec<AgentMessage>,
    }

    /// T-CF-11：idle 待命续 run 判定（drive_run_loop 收口处调用）
    ///
    /// 续 run 条件（任一满足，02-CF 方案 T-CF-11 第 1 点）：
    /// - [PendingMessageQueue] 非空（跨 run steering 条目：子代理完成、定时器
    ///   到期、Cron 触发、watchdog 兜底通知——条目生成侧已按 §4.8 模板拼入
    ///   wakeup_summary 摘要文本，注入即条目原文）；
    /// - TimerRegistry 存在活跃定时器（timer_has_active 判定器非空）；
    /// - enabled Cron 任务（cron_has_enabled 判定器非空）。
    ///
    /// 不续 run（硬条件与用户语义）：
    /// - abort_signal 触发（force_cancel，双保险）/ 用户消息到达后的正常收场
    ///   （本 run 有用户 L1 交互，user_touched）——对全部路径生效；
    /// - reason = Stopped / Aborted（用户停止）永不续；MaxTurns 保守不续；
    /// - error 收场（D2 分支）：非 retryable / 熔断触发 / 预算超限 → 不续；
    /// - Stop 分支四源全空（队列 / 定时器 / Cron / goal_pending）→ AI 休眠
    ///   待用户；续 run 连续 N 次（默认 3 次）均无 AI 产出 → 停止续 run。
    ///
    /// 三路分派（D2 §3.1 判定顺序，00 总纲 §6:140 契约）：
    /// - Stop → ① E1 续写子分支（部分保留断流瞬态标注）→ ② 三源 + D5 第四源
    ///   goal_pending 判定；
    /// - Error → retryable 分支（D2：熔断 / 预算 / 退避 / 恢复条目入队）；
    /// - Stopped / Aborted / MaxTurns → 永不续。
    ///
    /// 返回：None = 不续 run；Some(decision) = 续 run（mode + 注入消息）。
    pub(crate) async fn decide_idle_resume(
        state: &CoreRunState,
        active: &ActiveRun,
        reason: AgentEndReason,
        had_ai_output: bool,
        signals: &ResumeSignals,
    ) -> Option<ResumeDecision> {
        // 1. 硬条件（保持，扩语义）：abort 永不续（双保险）；对 Stop 与
        //    Error 两路径均生效（01 敲定 §4 红线 2：user_touched 永不自动续）
        if active.abort_signal.is_aborted() {
            return None;
        }
        if active.user_touched.load(Ordering::SeqCst) {
            return None;
        }
        // D6 §8 决策 1：会话级 user_stopped 标记（跨 run 语义——用户显式
        // 停止后 watcher 与收口判定共享同一判停，直到用户新 run 清除；
        // 兜底 L2 协作停止 + error 收场的竞态：run 级 user_touched 在 L2
        // 路径不置位，会话级标记覆盖该窗口）
        if state.is_user_stopped(&active.session_id) {
            return None;
        }
        match reason {
            // ── 正常收场：E1 续写子分支 + 三源 + D5 goal_pending 第四源 ──
            AgentEndReason::Stop => {
                // ── E1 续写子分支（内容级续接，扩展定夺 E0 R4）──
                // 条件（E1 §2.2 全满足）：最后一条 assistant 消息为纯文本、
                // metadata.providerErrorKind ∈ 瞬态四类且 providerErrorRetryable
                // != false（D7 流中断标注，与 D1 熔断 S2 计数同数据源）、
                // 熔断未触发、续写开关开启、content-resume 预算内（上限 2）。
                if let Some(decision) = content_resume_decision(state, active, signals).await {
                    return Some(decision);
                }
                // ── 四源判定：队列（首要唤醒源）/ 定时器 / Cron / goal_pending ──
                let queue_pending = {
                    let queue = state
                        .pending_queue
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    queue.has_pending_for(&active.session_id)
                };
                let timer_check = state
                    .timer_has_active
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone();
                let timer_active = if !queue_pending {
                    match timer_check {
                        Some(check) => check().await,
                        None => false,
                    }
                } else {
                    false
                };
                let cron_check = state
                    .cron_has_enabled
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone();
                let cron_enabled = if !queue_pending && !timer_active {
                    match cron_check {
                        Some(check) => check().await,
                        None => false,
                    }
                } else {
                    false
                };
                // D5 §3.6：goal_pending 第四源（与三源并存评估——队列条目 +
                // goal_pending 并存时注入拼接；仅三源全空时 goal 独立命中）
                let goal_state = state.load_goal_state(&active.session_id).await;
                let goal_pending = goal_state
                    .as_ref()
                    .map(|goal| goal.goal_pending(reason))
                    .unwrap_or(false);
                if !(queue_pending || timer_active || cron_enabled || goal_pending) {
                    // 四源全空：run 正常收场，AI 休眠待用户（硬条件）
                    return None;
                }
                // D6-⑤（W2）：空注入轮判定 = 唤醒源 ∈ {timer, cron} && 无队列
                // 条目 && 无 goal 注入（三者同时成立 → 注入文本为空）——定时器
                // /Cron 待命是正常态，不计 streak（裁决 #21）；goal 续轮（D5
                // 四源命中）与 error 续 run（D2 error 分支）不受本判定影响，
                // 走各自独立计数路径
                let empty_inject_round =
                    (timer_active || cron_enabled) && !queue_pending && !goal_pending;
                // 空转护栏（仅续 run 路径计数）：本 run 有 AI 产出 → 清零；
                // 否则 +1，连续 N 次（默认 3 次）无产出 → 停止续 run 并记日志。
                // W2：error 续 run 不计 streak（早退于本护栏）；goal 续轮计入
                // 空转且按 stalled 独立计数（D5 §3.4 双路径并存）
                {
                    let mut streak = state
                        .resume_empty_streak
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    let entry = streak.entry(active.session_id.clone()).or_insert(0);
                    if had_ai_output {
                        *entry = 0;
                    } else if empty_inject_round {
                        // 定时器/Cron 空注入轮不计 streak（不增不减，保持原值
                        // ——有产出轮自会清零，空注入轮不为待命代劳清零或消耗
                        // 计数，D6 §8 决策 7）
                    } else {
                        *entry += 1;
                        if *entry > IDLE_RESUME_MAX_EMPTY_ROUNDS {
                            tracing::info!(
                                target: "run",
                                session_id = %active.session_id,
                                consecutive_empty = *entry,
                                limit = IDLE_RESUME_MAX_EMPTY_ROUNDS,
                                "idle 续 run 停止：连续 N 次无 AI 产出（防空转风暴）"
                            );
                            return None;
                        }
                    }
                }
                // 注入拼接（D5 §3.6：队列条目在前，goal 前缀拼接其后——一条
                // 消息；仅 goal_pending → 纯前缀；仅三源 → 现状语义）
                let goal_text: Option<String> = if goal_pending {
                    let next_steps = state.read_summary_next_steps(&active.session_id).await;
                    goal_state
                        .as_ref()
                        .map(|goal| build_goal_continuation_prompt(goal, &next_steps))
                } else {
                    None
                };
                // D5 §3.9 / EV-07：goal-continuation-decided（命中 goal_pending、
                // 注入拼接处发射；action=continue，round = 下一轮序号 = 评估前
                // current_round + 1，与注入 prompt 的轮次一致；envelope 通道）
                if goal_pending {
                    let next_round = goal_state
                        .as_ref()
                        .map(|goal| goal.current_round + 1)
                        .unwrap_or(1);
                    emit_goal_continuation_decided(
                        active,
                        goal_state.as_ref(),
                        "continue",
                        "needs-continuation",
                        next_round,
                        goal_text.clone(),
                    )
                    .await;
                }
                let inject = if queue_pending {
                    let mut queue = state
                        .pending_queue
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    let drained = drain_pending_to_inject_messages(&mut queue, &active.session_id);
                    match (drained.into_iter().next(), goal_text) {
                        (Some(mut message), Some(text)) => {
                            message.blocks.push(AgentMessageBlock::Text { text });
                            vec![message]
                        }
                        (Some(message), None) => vec![message],
                        (None, Some(text)) => vec![goal_continue_message(&active.session_id, text)],
                        (None, None) => Vec::new(),
                    }
                } else if let Some(text) = goal_text {
                    vec![goal_continue_message(&active.session_id, text)]
                } else {
                    Vec::new()
                };
                if inject.is_empty() && !timer_active && !cron_enabled && !goal_pending {
                    return None;
                }
                let mode = if goal_pending {
                    "goal-continue"
                } else {
                    "idle-resume"
                };
                Some(ResumeDecision { mode, inject })
            }
            // ── 主 run error 收场：D2 retryable 分支 ──
            AgentEndReason::Error => {
                // 3a. 数据面：无结构化错误 / 非 retryable → 不续
                let Some(pe) = signals.provider_error.as_ref() else {
                    return None;
                };
                if !pe.retryable {
                    return None;
                }
                // 3b. 熔断（D1 is_tripped）→ 不续
                if state.circuit_breaker_is_tripped(&active.session_id).await {
                    return None;
                }
                // 3c/3d. 任务文本 + 指纹（裁决 #8：source = "error-retry"）
                let fp =
                    fingerprint_with_source("main", &signals.task_text, WAKE_SOURCE_ERROR_RETRY);
                // 3e. 预算消费（RecoveryBudget 纯函数复用；超限 → denied 事件
                //     + 不续）
                let attempt = match state
                    .consume_resume_episode(
                        &active.session_id,
                        &fp,
                        RECOVER_MAX_EPISODES_KEY,
                        RecoveryBudget::default_limit(),
                    )
                    .await
                {
                    EpisodeConsume::Consumed(attempt) => attempt,
                    EpisodeConsume::Denied { count, max } => {
                        emit_recovery_budget_denied(active, &fp, &active.session_id, count, max)
                            .await;
                        return None;
                    }
                };
                // 3f. 跨 run 退避（镜像 recovery.rs 常量；C4 注入点测试驱动）
                //     + 退避期 abort 复查（醒来不续，对齐 D1 abort 竞速语义）
                let delay = state.backoff_delay_for(attempt);
                state.sleep_resume_backoff(delay).await;
                if active.abort_signal.is_aborted() {
                    return None;
                }
                // 3g. 恢复条目入队 → drain 注入 → 拉起；注入文本最小化
                //     「继续任务」（约束 C：kind/retries 走 provider-diagnostic
                //     事件 + 临时通知，不进对话、不给 AI）
                let now = now_ms_internal();
                let entry = SteeringInputEntry {
                    session_id: active.session_id.clone(),
                    id: format!("recovery-main-{}-{now}", active.run_id),
                    text: MAIN_RESUME_INJECT_TEXT.to_string(),
                    attachments: Vec::new(),
                    enqueued_at: now,
                    group_id: Some(format!("{RECOVER_GROUP_PREFIX}{}", active.run_id)),
                    is_steering: true,
                };
                let mut queue = state
                    .pending_queue
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                queue.replace_or_enqueue(entry);
                let inject = drain_pending_to_inject_messages(&mut queue, &active.session_id);
                Some(ResumeDecision {
                    mode: "recovery-retry",
                    inject,
                })
            }
            // ── 用户停止 / 其它：永不续（Stopped/Aborted/MaxTurns）──
            _ => None,
        }
    }

    /// E1 续写子分支判定（部分保留断流 → 内容级续写 run）。全部条件满足
    /// 才触发（E1 §2.2 T1-T8）；预算超限 / 条件不满足 → None（半截保留交
    /// 用户，不触发任何自动动作）。
    pub(crate) async fn content_resume_decision(
        state: &CoreRunState,
        active: &ActiveRun,
        signals: &ResumeSignals,
    ) -> Option<ResumeDecision> {
        let last = signals.last_assistant.as_ref()?;
        // T3：纯文本消息（无 tool_calls 且文本非空——工具调用已提交不续写）
        if !last.is_plain_text {
            return None;
        }
        // T2：瞬态四类标注 + providerErrorRetryable != false（D7 标注；
        // 与 D1 熔断 S2 计数同数据源）
        let kind = last.kind?;
        if !is_transient_kind(kind) {
            return None;
        }
        if last.retryable == Some(false) {
            return None;
        }
        // T7：续写开关键（默认开启）
        if !state.content_resume_enabled(&active.session_id).await {
            return None;
        }
        // T5：熔断闸（续写是自动动作，受熔断闸约束）
        if state.circuit_breaker_is_tripped(&active.session_id).await {
            return None;
        }
        // T6：续写预算（独立指纹域 content-resume，上限 content_resume_max
        // 默认 2——比 error-retry 的 3 更紧；域互斥不挪用）
        let fp = fingerprint_with_source("main", &signals.task_text, WAKE_SOURCE_CONTENT_RESUME);
        let attempt = match state
            .consume_resume_episode(
                &active.session_id,
                &fp,
                CONTENT_RESUME_MAX_KEY,
                CONTENT_RESUME_MAX_DEFAULT,
            )
            .await
        {
            EpisodeConsume::Consumed(attempt) => attempt,
            EpisodeConsume::Denied { count, max } => {
                emit_recovery_budget_denied(active, &fp, &active.session_id, count, max).await;
                return None;
            }
        };
        // 退避 + abort 复查（对齐 error 分支 3f：预算在退避前消费）
        let delay = state.backoff_delay_for(attempt);
        state.sleep_resume_backoff(delay).await;
        if active.abort_signal.is_aborted() {
            return None;
        }
        // 注入锁定模板（E1 §3.2：测试断言绑定）；history 经 SessionHistoryCache
        // 天然含已产出前缀，不重复注入（前缀不变性，约束 B）
        let now = now_ms_internal();
        let text = format!(
            "上一轮生成中断({}),请从断点继续完成,不要重复已输出的内容",
            resume_kind_label(kind)
        );
        let entry = SteeringInputEntry {
            session_id: active.session_id.clone(),
            id: format!("recovery-main-{}-{now}", active.run_id),
            text,
            attachments: Vec::new(),
            enqueued_at: now,
            group_id: Some(format!("{RECOVER_GROUP_PREFIX}{}", active.run_id)),
            is_steering: true,
        };
        let mut queue = state
            .pending_queue
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        queue.replace_or_enqueue(entry);
        let inject = drain_pending_to_inject_messages(&mut queue, &active.session_id);
        Some(ResumeDecision {
            mode: "content-resume",
            inject,
        })
    }

    /// D5 §3.7：goal 续轮注入消息（user 角色，metadata.kind=goal-continue，
    /// 取 T1a 枚举 [AgentMessageMetadataKind::GoalContinue] canonical wire）
    pub(crate) fn goal_continue_message(_session_id: &str, text: String) -> AgentMessage {
        AgentMessage {
            id: crate::engine::new_message_id("goal-continue"),
            role: AgentMessageRole::User,
            created_at: crate::engine::now_iso_utc(),
            blocks: vec![AgentMessageBlock::Text { text }],
            metadata: Some(serde_json::json!({
                "kind": AgentMessageMetadataKind::GoalContinue
            })),
            client_message_id: None,
            content: None,
        }
    }

    /// D5 §3.9 / EV-07：goal-continuation-decided 发射（载荷对齐 TS
    /// GoalContinuationDecision：action/reason/prompt/progressSignature/detail）。
    ///
    /// action 语义对齐（不再恒 continue）：Continue 决策 → "continue"（idle
    /// 续轮判定处发射）；收口决策补发（[assess_goal_round]）→ Completed 决策
    /// = "complete"、Blocked = "blocked"、NoProgress = "stop"（reason 区分）。
    /// 与 goal-round-completed.decision 的语义边界：goal-round-completed 是
    /// 每轮收口必发的轮次账本事件，goal-continuation-decided 是续轮/收口决策
    /// 的观测镜像（决策全集覆盖，action 值域对齐 TS GoalContinuationDecision
    /// continue/complete/blocked/stop）。
    ///
    /// round = 本轮序号（与 goal-round-completed.round 同源：评估前
    /// current_round + 1）；事件变体无 round 字段（契约面已锁定），round 经
    /// detail 内嵌 "round=N" 透出。
    pub(crate) async fn emit_goal_continuation_decided(
        active: &ActiveRun,
        goal_state: Option<&GoalState>,
        action: &str,
        reason: &str,
        round: u32,
        prompt: Option<String>,
    ) {
        let event = AgentEvent::GoalContinuationDecided {
            action: action.to_string(),
            reason: reason.to_string(),
            prompt,
            progress_signature: goal_state.and_then(|goal| goal.progress_signature.clone()),
            detail: Some(format!("round={round}")),
        };
        emit_envelope_event(
            &active.queue,
            &active.bridge,
            &active.run_id,
            &active.session_id,
            event,
        )
        .await;
    }

    /// D2 §3.4 + E1 §3.4：恢复预算消费结果
    pub(crate) enum EpisodeConsume {
        /// 消费成功（本次消费后的预算计数；跨 run 退避 attempt 输入）
        Consumed(u32),
        /// 预算耗尽（recovery-budget-denied 留痕载荷）
        Denied { count: u32, max: u32 },
    }

    /// D2 §3.4（W6 双发射方）：主 run 侧预算耗尽留痕（subagentRunId=None）
    /// + denied 月度统计（recovery.rs:972-973）
    pub(crate) async fn emit_recovery_budget_denied(
        active: &ActiveRun,
        fp: &str,
        session_id: &str,
        count: u32,
        max: u32,
    ) {
        let event = AgentEvent::RecoveryBudgetDenied {
            session_id: session_id.to_string(),
            subagent_run_id: None,
            fingerprint: fp.to_string(),
            count,
            max,
        };
        emit_envelope_event(
            &active.queue,
            &active.bridge,
            &active.run_id,
            session_id,
            event,
        )
        .await;
        conex_types::denied_stats::global_denied_stats().record_recovery_budget_denied();
    }

    /// D1 §3.2.2（C5）：熔断触发边沿观测事件（[Self::update_provider_fail_
    /// streak] 返回 true = 本次更新跨过阈值时发射）。双事件仅观测面——
    /// 不注入对话、不给 AI，UI 横幅呈现（用户约束 C，final/00 §9.3）；
    /// detail=Some("circuit-trip") 语义对齐 02-定夺 W1（熔断侧 subagentRunId
    /// = None、detail=Some）。
    pub(crate) async fn emit_circuit_trip_events(active: &ActiveRun, session_id: &str) {
        let now = crate::engine::now_iso_utc();
        emit_envelope_event(
        &active.queue,
        &active.bridge,
        &active.run_id,
        session_id,
        AgentEvent::RuntimeInterventionRequired {
            session_id: session_id.to_string(),
            timestamp: now,
            reason: "circuit-trip".to_string(),
            choices: Vec::new(),
            message: "provider 连续失败已达熔断阈值，自动重试已暂停（观测面：请检查网络或配置后重试）"
                .to_string(),
        },
    )
    .await;
        emit_envelope_event(
            &active.queue,
            &active.bridge,
            &active.run_id,
            session_id,
            AgentEvent::RecoveryEscalated {
                session_id: session_id.to_string(),
                subagent_run_id: None,
                kind: "CircuitTrip".to_string(),
                retries: 0,
                elapsed_ms: 0,
                detail: Some("circuit-trip".to_string()),
            },
        )
        .await;
    }

    /// T-CF-11：PendingMessageQueue 条目批量转出 → 注入消息（对齐 D07 批量
    /// 推送：一次续 run 承载全部条目，不逐条唤醒）。
    ///
    /// 注入文本 = 队列条目原文（生成侧已按 §4.8 模板拼入 wakeup_summary
    /// 摘要，与 prompt 并存）；多条普通条目按序拼接（换行分隔）为一条用户
    /// 角色消息——对齐 D8「条目作为下一条用户消息注入」语义（steering_queue.rs
    /// into_user_message，普通注入带 kind=steering 枚举 canonical）。
    /// 过滤丢弃任何残留的 context-state 条目（绝不伪造成用户消息，绝不拉起 idle-resume run）。
    /// 消息 id 沿用首条条目 id 保证幂等（对齐 transfer_follow_up 的 id 沿用）。
    pub(crate) fn drain_pending_to_inject_messages(
        queue: &mut PendingMessageQueue,
        session_id: &str,
    ) -> Vec<AgentMessage> {
        let entries = queue.dequeue_all_for(session_id);
        if entries.is_empty() {
            return Vec::new();
        }
        // 彻底移除 context_states 伪造 User 消息逻辑；过滤丢弃任何残留的 CONTEXT_STATE_GROUP 条目
        let valid_entries: Vec<_> = entries
            .into_iter()
            .filter(|e| e.group_id.as_deref() != Some(CONTEXT_STATE_GROUP))
            .collect();
        if valid_entries.is_empty() {
            return Vec::new();
        }
        // D6 §3.4：合并注入上限（评审 selection-03:220 建议 ≤16 条）——保留
        // 最新 ≤16 条（FIFO 尾部即最新；省略最旧——旧条目信息过时风险高，
        // D6 §8 决策 4），超出在文本注明省略 N 条。省略轨迹不丢：恢复域
        // 条目有 recover_notifications 落库冗余，定时器/子代理终态条目有
        // 事件表留痕——队列只承载提醒，不承载全量。
        let mut entries = valid_entries;
        let (kept, omitted) = if entries.len() > RESTORE_MERGE_INJECT_LIMIT {
            let split = entries.len() - RESTORE_MERGE_INJECT_LIMIT;
            let omitted = entries[..split].len();
            (entries.split_off(split), omitted)
        } else {
            (entries, 0)
        };
        let mut text = kept
            .iter()
            .map(|entry| entry.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        if omitted > 0 {
            text = format!("{text}\n（其余 {omitted} 条唤醒通知省略，详情见事件流）");
        }
        // 消息 id 沿用保留集首条条目 id 保证幂等（对齐 transfer_follow_up
        // 的 id 沿用）
        let first = &kept[0];
        let trigger_source = if first
            .group_id
            .as_deref()
            .is_some_and(|g| g.starts_with("timer-"))
            || first.id.starts_with("timer-")
        {
            Some("system_timer")
        } else if first
            .group_id
            .as_deref()
            .is_some_and(|g| g.starts_with("cron-"))
            || first.id.starts_with("cron-")
        {
            Some("cron")
        } else if first.group_id.as_deref() == Some("subagent-complete")
            || first.id.starts_with("subagent-")
        {
            Some("subagent_complete")
        } else {
            None
        };

        let mut meta = serde_json::json!({
            "kind": AgentMessageMetadataKind::Steering
        });
        if let Some(src) = trigger_source {
            meta["triggerSource"] = serde_json::json!(src);
        }

        vec![AgentMessage {
            id: first.id.clone(),
            role: AgentMessageRole::User,
            created_at: crate::engine::now_iso_utc(),
            blocks: vec![AgentMessageBlock::Text { text }],
            metadata: Some(meta),
            client_message_id: None,
            content: None,
        }]
    }

    /// D7 §8 决策 1：会话树访问器（D3 session_trees 表优先——共享实例直读
    /// 直写；无记录回退 [CoreRunState::sessions] 快照注册表临时重建 +
    /// to_session_record 回写；无会话记录 → None 跳过——子代理会话
    /// （sub-sess-*）天然无树无叶子，采集语义只落在有树会话，R8）。
    /// 全程 std Mutex 锁内完成（纯内存，无 await，对齐 AA-02）。
    pub(crate) fn with_session_tree<R>(
        state: &CoreRunState,
        session_id: &str,
        f: impl FnOnce(&mut SessionTree) -> R,
    ) -> Option<R> {
        {
            let trees = state
                .session_trees
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(tree) = trees.get(session_id) {
                return Some(f(&mut tree.lock().unwrap_or_else(|e| e.into_inner())));
            }
        }
        let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let idx = sessions
            .iter()
            .position(|record| record.session_id == session_id)?;
        let mut tree = SessionTree::from_session_record(sessions[idx].clone()).ok()?;
        let result = f(&mut tree);
        sessions[idx] = tree.to_session_record();
        Some(result)
    }

    /// D7 §3.1：收口采集接线（M5B；纯函数 collect_checkpoint_from_messages
    /// → 写面 set_leaf_checkpoint）。三态：
    /// - Ok(Some) → 写叶子（无叶子 / 写失败 → warn 不阻断）；
    /// - Ok(None) → 无标记行，现状；
    /// - Err → 对话内坏标记行：视为无 checkpoint，warn + 不写 + 不阻断
    ///   （§3.5 采集侧降级——该标记行是模型输出噪音，不中止 run 生命周期）。
    ///
    /// EV-02（D-03 R-15）：写叶子成功 → 发射 checkpoint-created（载荷 =
    /// [conex_types::tool::RuntimeCheckpointRecord]，复用既有变体；Persistent
    /// 级随收口落库）；Corrupt 只 warn 不发；Absent 不发。仅加观测，写面
    /// 行为不变。
    pub(crate) async fn collect_checkpoint_on_close(
        state: &CoreRunState,
        session_id: &str,
        outcome: &RunOutcome,
        queue: &Arc<tokio::sync::Mutex<EventQueue>>,
        bridge: &Arc<BufferedRunEventBridge>,
        run_id: &str,
    ) {
        // 采集 API 收具体消息（非引用）——收口处一次 clone，与
        // to_history_messages 的收口克隆同频（每 run 一次，可接受）
        let messages: Vec<AgentMessage> = outcome
            .messages
            .iter()
            .map(|m| m.as_ref().clone())
            .collect();
        match session_loop::safe_point::collect_checkpoint_from_messages(&messages) {
            Ok(Some(payload)) => {
                // 写面闭包返回「写成功时的叶子 id」（EV-02：created 事件载荷
                // id 锚点，与注入面 restored 的 checkpoint_id 配对）
                let leaf_id = with_session_tree(state, session_id, |tree| {
                    let Some(leaf_id) = tree.current_leaf_id().map(str::to_string) else {
                        return None;
                    };
                    tree.set_leaf_checkpoint(&leaf_id, &payload)
                        .ok()
                        .map(|_| leaf_id)
                });
                if let Some(leaf_id) = leaf_id.flatten() {
                    // EV-02：写叶子成功 → checkpoint-created（metadata 承载
                    // CheckpointPayload 全文，字段保真不丢失）
                    let record = conex_types::tool::RuntimeCheckpointRecord {
                        id: leaf_id,
                        kind: conex_types::tool::RuntimeCheckpointKind::WorkspaceCheckpoint,
                        label: payload.target.clone(),
                        tool_call_id: String::new(),
                        tool_name: "session-checkpoint".to_string(),
                        artifact_uri: None,
                        manifest_path: None,
                        snapshot_path: None,
                        source_path: None,
                        metadata: serde_json::to_value(&payload).ok(),
                    };
                    emit_envelope_event(
                        queue,
                        bridge,
                        run_id,
                        session_id,
                        AgentEvent::CheckpointCreated {
                            session_id: session_id.to_string(),
                            timestamp: crate::engine::now_iso_utc(),
                            checkpoint: record,
                        },
                    )
                    .await;
                } else {
                    tracing::warn!(
                        target: "run",
                        session_id,
                        "checkpoint 采集命中但写面跳过/失败（无叶子或无会话记录；不阻断收口）"
                    );
                }
            }
            Ok(None) => {}
            Err(error) => tracing::warn!(
                target: "run",
                session_id,
                error = %error,
                "checkpoint 采集损坏降级（对话含坏标记行；不写叶子、不阻断收口）"
            ),
        }
    }

    /// D7 §3.2：checkpoint 摘要注入段（spawn_idle_resume_run 注入文本拼接；
    /// 三态分发——Present → 「上次检查点」摘要段（summary 截断 ≤500 字符，
    /// completed/next 各 ≤5 项，§8 决策 4）；Corrupt → 降级提示不阻断；
    /// Absent / 无树 → 空串（行为与现状一致，无 checkpoint 不注入）。
    ///
    /// EV-02（D-03 R-15）：Present 分支注入命中 → 发射 checkpoint-restored
    /// （载荷 = [conex_types::tool::RuntimeCheckpointRestoreRecord]，复用既有
    /// 变体；会话域事件——EventQueue run_id=None 构造，落库 run_id 列与信封
    /// runId 均 None，对齐 EventQueue「None = 会话域/空闲态事件」头注）；
    /// Corrupt 只 warn 不发；Absent 不发。仅加观测，注入面行为不变。
    pub(crate) async fn checkpoint_injection_section(
        state: &CoreRunState,
        session_id: &str,
    ) -> String {
        let (leaf_id, checkpoint) = with_session_tree(state, session_id, |tree| {
            (
                tree.current_leaf_id().map(str::to_string),
                tree.read_leaf_checkpoint(None),
            )
        })
        .unwrap_or((None, conex_types::LeafCheckpointState::Absent));
        match checkpoint {
            conex_types::LeafCheckpointState::Present(payload) => {
                // EV-02：恢复注入命中 → checkpoint-restored（record.checkpoint_id
                // = 叶子 id，与 created 事件的 record.id 配对；restored = 检查点
                // 涉及文件清单；metadata 承载载荷全文）
                if let Some(checkpoint_id) = leaf_id {
                    let record = conex_types::tool::RuntimeCheckpointRestoreRecord {
                        checkpoint_id,
                        tool_call_id: String::new(),
                        tool_name: "session-checkpoint".to_string(),
                        restored: payload.files.clone(),
                        deleted: Vec::new(),
                        skipped: Vec::new(),
                        metadata: serde_json::to_value(&payload).ok(),
                    };
                    emit_session_domain_event(
                        state,
                        session_id,
                        AgentEvent::CheckpointRestored {
                            session_id: session_id.to_string(),
                            timestamp: crate::engine::now_iso_utc(),
                            restore: record,
                        },
                    )
                    .await;
                }
                let completed = join_limited(&payload.completed, CHECKPOINT_LIST_ITEMS_MAX, "、");
                let next = join_limited(&payload.next, CHECKPOINT_LIST_ITEMS_MAX, "、");
                format!(
                    "[检查点摘要]\n上次检查点：目标「{}」。\n已完成：{}。\n摘要：{}\n下一步：{}",
                    payload.target,
                    if completed.is_empty() {
                        "(无)".to_string()
                    } else {
                        completed
                    },
                    truncate_chars(&payload.summary, CHECKPOINT_SUMMARY_TRUNCATE_CHARS),
                    if next.is_empty() {
                        "(无)".to_string()
                    } else {
                        next
                    },
                )
            }
            conex_types::LeafCheckpointState::Corrupt(message) => {
                tracing::warn!(
                    target: "run",
                    session_id,
                    message,
                    "检查点载荷损坏（降级提示，run 照常拉起）"
                );
                "(检查点损坏已忽略，按对话历史继续)".to_string()
            }
            _ => String::new(),
        }
    }

    /// EV-02（D-03 R-15）：会话域事件发射（无 run 归属上下文——idle 续
    /// run 拉起的恢复注入发生在 run 边界，旧 run 已收口、新 run 未装配，
    /// 均无活动通道；EventQueue run_id=None 构造 = 会话域事件，落库
    /// run_id 列与信封 runId 均 None）。持久化事件随 queue.push 落库
    /// （Persistent 语义），发射失败静默（观测面不阻断注入）。
    pub(crate) async fn emit_session_domain_event(
        state: &CoreRunState,
        session_id: &str,
        event: AgentEvent,
    ) {
        let base = state.base_sequence_for(session_id).await;
        let mut queue = EventQueue::new(Arc::clone(&state.store), base, None);
        if let Ok(sequenced) = queue.push(session_id, event).await {
            let bridge = BufferedRunEventBridge::new(state.bridge.clone(), "session-event");
            let envelope = AgentEventEnvelope::new(sequenced.event, None, Some(sequenced.sequence));
            bridge.emit(&envelope);
            bridge.flush();
        }
    }

    /// D7 §8 决策 4：清单项拼接（取前 max 项，其余省略——注入文本长度
    /// 护栏，防注意力稀释）
    pub(crate) fn join_limited(items: &[String], max: usize, sep: &str) -> String {
        items
            .iter()
            .take(max)
            .cloned()
            .collect::<Vec<_>>()
            .join(sep)
    }

    /// D7 §8 决策 4：文本截断护栏（≤max 字符；超长截断 + 省略号「…」；
    /// 按字符（char）截断不按字节，中文安全）
    pub(crate) fn truncate_chars(text: &str, max: usize) -> String {
        let mut result: String = text.chars().take(max).collect();
        if text.chars().count() > max {
            result.push('…');
        }
        result
    }

    // ── E2 F5（07 §4 卡 D）：分阶段总结壳层接线 ────────────────────────
    //
    // 里程碑触发（run 收口评估）+ 阶段总结产出（Summarizer 通道）+ 系统提示
    // 词段注入（build_system_prompt 输出后拼接）+ checkpoint 载荷落库。
    // 已触发记录选型（动态决策）：会话级 session_meta 键
    // `{session_id}:compact_stage_triggered`（已触发里程碑下标集合）与
    // `{session_id}:compact_stage_summaries`（阶段总结列表 {tier, markdown}）
    // ——与 compact_stage_ratios 同一命名空间、跨 run 持久、无 goal_state 耦合；
    // 事件面最小化（E2 §7.2「若事件总数最小化」分支）：阶段总结不新增事件
    // 类型（避免 registry_drift 双面登记级联），观测面 = session_meta 键 +
    // checkpoint + 日志。

    /// F5：会话级已触发里程碑键（`{session_id}:compact_stage_triggered`）
    pub(crate) fn stage_triggered_meta_key(session_id: &str) -> String {
        crate::outputs_config::session_meta_key_of(session_id, "compact_stage_triggered")
    }

    /// F5：会话级阶段总结列表键（`{session_id}:compact_stage_summaries`）
    pub(crate) fn stage_summaries_meta_key(session_id: &str) -> String {
        crate::outputs_config::session_meta_key_of(session_id, "compact_stage_summaries")
    }

    /// F5：读取已触发里程碑下标集合（session_meta 键；缺失/坏 JSON → 空集
    /// fail-open，不 panic）
    pub(crate) fn stage_triggered_indices(state: &CoreRunState, session_id: &str) -> Vec<u32> {
        let Some(db) = state.local_db() else {
            return Vec::new();
        };
        db.get_session_meta(&stage_triggered_meta_key(session_id))
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str::<Vec<u32>>(&raw).ok())
            .unwrap_or_default()
    }

    /// F5：写入已触发里程碑下标集合（失败仅告警——下次收口按当前集合重判，
    /// 幂等语义）
    pub(crate) fn save_stage_triggered(state: &CoreRunState, session_id: &str, indices: &[u32]) {
        let Some(db) = state.local_db() else {
            return;
        };
        let raw = serde_json::to_string(indices).unwrap_or_else(|_| "[]".to_string());
        if let Err(error) = db.set_session_meta(&stage_triggered_meta_key(session_id), &raw) {
            tracing::warn!(
                target: "run",
                session_id,
                error = %error,
                "阶段里程碑标记落库失败（下次收口重判）"
            );
        }
    }

    /// F5：读取已产出阶段总结列表（{tier, markdown}；缺失/坏 JSON → 空）
    pub(crate) fn stored_stage_summaries(
        state: &CoreRunState,
        session_id: &str,
    ) -> Vec<(String, String)> {
        let Some(db) = state.local_db() else {
            return Vec::new();
        };
        let Some(raw) = db
            .get_session_meta(&stage_summaries_meta_key(session_id))
            .ok()
            .flatten()
        else {
            return Vec::new();
        };
        let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(&raw) else {
            return Vec::new();
        };
        items
            .into_iter()
            .filter_map(|item| {
                let tier = item.get("tier")?.as_str()?.to_string();
                let markdown = item.get("markdown")?.as_str()?.to_string();
                Some((tier, markdown))
            })
            .collect()
    }

    /// F5：追加一条阶段总结（按 tier 幂等去重——同阶梯只存一份，防重复注入
    /// 造成前缀碎片，E2 §6.5 ①/⑤ 稳定化纪律）
    pub(crate) fn append_stage_summary(
        state: &CoreRunState,
        session_id: &str,
        tier: &str,
        markdown: &str,
    ) {
        let Some(db) = state.local_db() else {
            return;
        };
        let key = stage_summaries_meta_key(session_id);
        let mut items: Vec<serde_json::Value> = db
            .get_session_meta(&key)
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str::<Vec<serde_json::Value>>(&raw).ok())
            .unwrap_or_default();
        if items
            .iter()
            .any(|item| item.get("tier").and_then(|v| v.as_str()) == Some(tier))
        {
            return;
        }
        items.push(serde_json::json!({ "tier": tier, "markdown": markdown }));
        let raw = serde_json::to_string(&items).unwrap_or_else(|_| "[]".to_string());
        if let Err(error) = db.set_session_meta(&key, &raw) {
            tracing::warn!(
                target: "run",
                session_id,
                error = %error,
                "阶段总结存储失败（注入面不可见，checkpoint 仍可携带）"
            );
        }
    }

    /// F5 §6.3：系统提示词段注入——build_system_prompt 规范化输出后拼接
    /// 「阶段总结：N 条」段（每阶梯 md 渲染 + tier 标注；零对话污染、天然跨
    /// run 携带，E2 §6.3 主选）。读取会话级阶段总结列表；无总结 → 原样返回
    /// build_system_prompt 输出（行为与接线前一致）。
    pub(crate) fn assemble_system_prompt_with_stages(
        state: &CoreRunState,
        session_id: &str,
        system_prompt: Option<String>,
    ) -> Option<String> {
        let base = build_system_prompt(system_prompt);
        let stages = stored_stage_summaries(state, session_id);
        if stages.is_empty() {
            return base;
        }
        let mut section = format!("阶段总结：{} 条", stages.len());
        for (_, markdown) in &stages {
            section.push_str("\n\n");
            section.push_str(markdown);
        }
        match base {
            Some(base) => Some(format!("{base}\n\n{section}")),
            None => Some(section),
        }
    }

    /// F5：Schema V1 字符串数组字段提取（非数组/非字符串项跳过；阶段总结
    /// 构造辅助）
    pub(crate) fn stage_doc_string_array(doc: &serde_json::Value, key: &str) -> Vec<String> {
        doc.get(key)
            .and_then(|v| v.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// EV-07：stage-summary-milestone 发射单点（[evaluate_stage_milestones]
    /// 各态调用；milestone_type = reached/summarizing/produced/persisted，
    /// Delta 可丢观测事件，不进主链；Summarizer 缺失时止于 reached——
    /// 「达标但不可产出」可辨）。
    async fn emit_stage_summary_milestone(
        active: &ActiveRun,
        session_id: &str,
        milestone_type: &str,
        tier: &str,
        milestone_index: u32,
    ) {
        emit_envelope_event(
            &active.queue,
            &active.bridge,
            &active.run_id,
            session_id,
            AgentEvent::StageSummaryMilestone {
                session_id: session_id.to_string(),
                timestamp: crate::engine::now_iso_utc(),
                milestone_type: milestone_type.to_string(),
                tier: Some(tier.to_string()),
                milestone_index: Some(milestone_index),
            },
        )
        .await;
    }

    /// F5 §6.2/07 §4.1：run 收口里程碑评估（触发点 = run 收口，Stop 收场路径）。
    ///
    /// - 输入：当前对话（outcome.messages）+ 会话级已触发集合（session_meta）；
    /// - 判定：estimate（count_agent_message_tokens 启发式合计，压缩链同源
    ///   口径）/ window（生效模型目录窗口；目录缺失回退 ContextBudget 默认
    ///   64000）比例 ≥ compact_stage_ratios（默认 [0.4,0.6,0.8]，可配）中
    ///   首个未触发阶梯（next_pending_milestone 纯函数）；
    /// - 触发：经 Summarizer 对完整对话产出 Schema V1 阶段总结（tier=stage-N、
    ///   droppedIds 空、custom range = 消息 id 区间）→ 存储 + checkpoint 落载荷；
    /// - 失败语义：Summarizer 缺失 / 摘要失败 / 非法 JSON → 里程碑**不标记**
    ///   （下轮收口重试，与 F2 层 1「被动重试」同向）；标记在产出成功后写入
    ///   （防「假触发」）；
    /// - 每阶梯只触发一次：已触发集合跨 run 持久（session_meta 键），新 run
    ///   重新评估时更高阶梯达标才补触发（重复触发抑制，07 §4.4 测试 1）；
    /// - EV-07 观测面：达标（reached）/Summarizer 调用（summarizing）/产出
    ///   （produced）/落库（persisted）各一态 stage-summary-milestone 事件。
    pub(crate) async fn evaluate_stage_milestones(
        state: &Arc<CoreRunState>,
        active: &ActiveRun,
        session_id: &str,
        messages: &[Arc<AgentMessage>],
    ) {
        if messages.is_empty() {
            return;
        }
        // 里程碑阶梯（session_meta `compact_stage_ratios` 可配；键缺失回退
        // 默认 40/60/80%——stage_ratios_from_session_meta fail-open）
        let ratios = {
            let db = state.local_db();
            let meta = |key: &str| {
                db.as_ref()
                    .and_then(|d| d.get_session_meta(key).ok().flatten())
            };
            stage_ratios_from_session_meta(meta)
                .unwrap_or_else(|| DEFAULT_COMPACT_STAGE_RATIOS.to_vec())
        };
        // 估算（启发式 token 合计）与窗口（生效模型目录；缺目录回退默认窗口）
        let estimate: u64 = messages
            .iter()
            .map(|m| conex_compaction::count_agent_message_tokens(m) as u64)
            .sum();
        let window = state
            .engine
            .provider_config()
            .and_then(|config| crate::engine::effective_context_window(&config))
            .map(u64::from)
            .unwrap_or(u64::from(ContextBudget::default().context_window));
        let ratio = session_loop::r#loop::stage_summary::estimate_ratio(estimate, window);
        let triggered = stage_triggered_indices(state, session_id);
        let Some(index) = next_pending_milestone(ratio, &ratios, &triggered) else {
            return;
        };
        // EV-07：里程碑达标（reached）
        emit_stage_summary_milestone(active, session_id, "reached", &stage_tier(index), index)
            .await;
        // 触发：Summarizer 解析（F1 L1：无 Summarizer → 不产出、不标记）
        let Some(summarizer) = state.summarizer_for(session_id) else {
            tracing::warn!(
                target: "run",
                session_id,
                ratio,
                "阶段里程碑达标但 LLM 摘要不可用 → 跳过（下轮收口重试）"
            );
            return;
        };
        // EV-07：Summarizer 调用（summarizing）
        emit_stage_summary_milestone(active, session_id, "summarizing", &stage_tier(index), index)
            .await;
        // 完整对话 → 阶段总结（Summarizer 为同步 trait，ProviderSummarizer
        // 内部专用线程异步——收口 async 面经 spawn_blocking 隔离阻塞，与
        // save_run_usage 先例同纪律）
        let dropped: Vec<AgentMessage> = messages.iter().map(|m| m.as_ref().clone()).collect();
        let summarizer = Arc::clone(&summarizer);
        let summarize_result =
            tokio::task::spawn_blocking(move || summarizer.summarize(&dropped, None))
                .await
                .map_err(|join| format!("阶段总结任务 join 失败：{join}"));
        let text = match summarize_result {
            Ok(Ok(text)) => text,
            Ok(Err(error)) => {
                tracing::warn!(
                    target: "run",
                    session_id,
                    error,
                    "阶段总结产出失败 → 不标记（下轮收口重试）"
                );
                return;
            }
            Err(error) => {
                tracing::warn!(
                    target: "run",
                    session_id,
                    error,
                    "阶段总结任务失败 → 不标记（下轮收口重试）"
                );
                return;
            }
        };
        // Schema V1 校验 + 字段提取（goal/constraints/progress/decisions/
        // nextSteps/criticalContext）；非法输出 → 不标记（下轮重试）
        let llm_doc: serde_json::Value = match serde_json::from_str(&text) {
            Ok(doc) => doc,
            Err(error) => {
                tracing::warn!(
                    target: "run",
                    session_id,
                    error = %error,
                    "阶段总结非 Schema V1 JSON → 不标记（下轮收口重试）"
                );
                return;
            }
        };
        let tier = stage_tier(index);
        // EV-07：阶段总结产出（Schema V1 校验通过，produced）
        emit_stage_summary_milestone(active, session_id, "produced", &tier, index).await;
        let stage_doc = build_stage_summary_document(&StageSummaryDocument {
            stage_index: index,
            block_id: format!("stage-summary-{}", index + 1),
            generation: 1,
            goal: llm_doc
                .get("goal")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            constraints: stage_doc_string_array(&llm_doc, "constraints"),
            progress: stage_doc_string_array(&llm_doc, "progress"),
            decisions: stage_doc_string_array(&llm_doc, "decisions"),
            next_steps: stage_doc_string_array(&llm_doc, "nextSteps"),
            critical_context: llm_doc
                .get("criticalContext")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            range: Some(StageSummaryRange {
                start_message_id: messages.first().map(|m| m.id.clone()).unwrap_or_default(),
                end_message_id: messages.last().map(|m| m.id.clone()).unwrap_or_default(),
                message_count: messages.len() as u32,
            }),
        });
        let markdown = stage_summary_to_markdown(&stage_doc);
        // 标记已触发（产出成功后）+ 存储总结（注入面数据源；tier 幂等去重）
        let mut next_triggered = triggered;
        next_triggered.push(index);
        next_triggered.sort_unstable();
        next_triggered.dedup();
        save_stage_triggered(state, session_id, &next_triggered);
        append_stage_summary(state, session_id, &tier, &markdown);
        // EV-07：阶段总结落库（触发标记 + 存储写入完成，persisted）
        emit_stage_summary_milestone(active, session_id, "persisted", &tier, index).await;
        // checkpoint 落载荷（set_leaf_checkpoint；无树/无叶子 → 跳过不阻断，
        // 与 collect_checkpoint_on_close 同语义）
        let payload = stage_summary_to_checkpoint_payload(&stage_doc);
        let written = with_session_tree(state, session_id, |tree| {
            let Some(leaf_id) = tree.current_leaf_id().map(str::to_string) else {
                return false;
            };
            tree.set_leaf_checkpoint(&leaf_id, &payload).is_ok()
        });
        tracing::info!(
            target: "run",
            session_id,
            tier,
            message_count = messages.len(),
            checkpoint = written.unwrap_or(false),
            "阶段里程碑触发：阶段总结已产出并存储"
        );
    }

    /// T-CF-11：idle 续 run 拉起（收口处判定命中后调用）——复用
    /// [run_task_impl] 的 run 装配拉起新 run（新 run id / 新 producer /
    /// 新 ActiveRun / 新 drive_run_loop；history 回退 SessionHistoryCache，
    /// 上一轮收口已缓存——历史自动续接，T-29 混合路线）。
    ///
    /// prompt = 注入消息文本（队列条目批量聚合；仅定时器/Cron 源触发时为
    /// 空文本——AI 醒来保持待命态，等待事件条目入队后经下一次收口送达）；
    /// mode = 续 run 类型（D2 §3.4 mode 参数化：idle-resume / recovery-retry
    /// / content-resume / goal-continue，自动恢复类型可观测，G-6）。失败仅
    /// 告警不重试（下一收口再判定；空转护栏防风暴）。
    pub(crate) async fn spawn_idle_resume_run(
        state: Arc<CoreRunState>,
        session_id: String,
        mode: &str,
        inject: Vec<AgentMessage>,
    ) {
        let mut text = inject
            .iter()
            .map(|message| message.text())
            .collect::<Vec<_>>()
            .join("\n");
        // D7 §3.2：checkpoint 摘要注入（read_leaf_checkpoint 三态分发——
        // Present 追加「上次检查点」段（摘要 ≤500 字符截断）；Corrupt 追加
        // 降级提示；Absent 不追加，行为与现状一致；不 panic、不阻断拉起。
        // 注入仅发生在中断恢复/新 run 拉起场景：该场景 run 上下文本就是
        // 重建态，前缀缓存必然失效，接受前缀变更（约束 B 权衡注记）
        let checkpoint_section = checkpoint_injection_section(&state, &session_id).await;
        if !checkpoint_section.is_empty() {
            if !text.is_empty() {
                text.push_str("\n\n");
            }
            text.push_str(&checkpoint_section);
        }
        let options = RunTaskOptions {
            run_id: crate::engine::new_message_id("idle-resume"),
            session_id: session_id.clone(),
            prompt: Some(text),
            mode: Some(mode.to_string()),
            cwd: None,
            permission_mode: None,
            client_message_id: None,
            assistant_client_message_id: None,
            system_prompt: None,
            history: None,
            context_window: None,
            parent_run_id: None,
            // T-D-13：续 run 为普通 run（子代理配置仅 spawner 构造）
            subagent_config: None,
            // D5 §3.1：续轮 run 的 goal 三字段从 goal_state 重建（不依赖
            // 前端再下发——引擎自主行为，goal_state 是权威，D5 §8 决策 7）；
            // 此处缺省 None：装配面在 [run_task_impl] 内按 mode 判定
            visible_goal: None,
            max_rounds: None,
            max_stalled_rounds: None,
            // I1-β：idle 续 run 无前端档位参数——None = 引擎默认档位
            //（与 context_window None 同待遇：自动恢复路径不携带用户
            // 装配面之外的思考档位，向后兼容）
            reasoning_effort: None,
            // I1-α②：续 run 不产生 context-state（状态切换告知仅由前端
            // 用户提交边界携带；引擎自主续 run 无状态切换语义）
            context_state: None,
            // plans/04 §4.2：续 run 无多模态 content（引擎自主行为，纯文本）
            content: None,
            has_images: None,
        };
        if let Err(error) = run_task_impl(Arc::clone(&state), options).await {
            tracing::warn!(
                target: "run",
                session_id,
                error = %error,
                "idle 续 run 拉起失败（下一收口再判定；空转护栏防风暴）"
            );
        }
    }

    // ── drive_run_loop ────────────────────────────────────────────────

    /// run 驱动循环（B6.1：produce → drive_outcome → emit → 终态）
    ///
    /// 流程（T09.2 步骤 4/5：by value 零克隆）：
    /// 1. `produce`（[RunProducer]）→ [RunOutcome]；
    /// 2. [orchestrator::events::drive_outcome]：事件入队（sequence 会话级
    ///    原子分配，delta 不阻塞）+ 终态收口（run-terminal 唯一一次）；
    /// 3. 事件 emit：信封 runId/sequence 注入（03 §5.3-2/6）；**T09.1 后收口
    ///    message-delta 跳过不双发**（实时轨已发，sequence=None；前端按
    ///    messageId 幂等累加）；
    /// 4. cursor 发布：drive_outcome 已更新 run.cursor（终态游标 = 最后事件
    ///    sequence，T08.4），终态记录落库；
    /// 5. 终态：移出活动注册表 + 快照（T08.6 触发点 A）；
    /// 6. 错误路径：drive 失败（防御性）→ [finalize_failed]。
    pub(crate) async fn drive_run_loop(
        state: Arc<CoreRunState>,
        active: Arc<ActiveRun>,
        mut producer: Box<dyn RunProducer>,
    ) {
        let session_id = active.session_id.clone();
        let run_id = active.run_id.clone();
        // span 约定（26-frontend-observability-audit.md：drive_run_loop 入口
        // info_span!("run", session_id, run_id)，引擎各阶段统一字段名）
        let span = tracing::info_span!("run", session_id = %session_id, run_id = %run_id);
        let _enter = span.enter();
        tracing::info!("drive_run_loop 启动");

        // 1. produce（单次即覆盖整个 run：多 turn 由 AgentSessionLoop 内部驱动；
        //    未来 goal 多轮模式在本循环续轮）
        let outcome = producer.produce().await;
        // 产出完成即释放生产者：其持有的 options（含逃逸监视配置引用 →
        // 审计桥引用）随 Drop 归还——审计落库 worker 的通道关闭时点
        // 确定性依据（收口 await 排空不依赖生产者存活，L4）
        drop(producer);
        // T-CF-11：产出信号提前捕获（outcome 随后被 drive_outcome 消费——
        // reason / turn_index / tool_call_count 为 Copy 字段，收口判定用）
        let resume_reason = outcome.reason;
        let resume_turn_index = outcome.turn_index;
        let resume_tool_calls = outcome.tool_call_count;
        // D3：C7 恢复决策输入提前捕获（outcome 随后被 drive_outcome 移动消费
        // ——selection-02 评审报告 §2.5：provider_error 必须在此同批提前提取
        // clone；任务文本与产出判定来自 messages 快照）
        let resume_provider_error = outcome.provider_error.clone();
        let first_user_text = CoreRunState::first_user_text(&outcome.messages);
        let has_assistant_output = outcome
            .messages
            .iter()
            .any(|m| m.role == AgentMessageRole::Assistant);
        // D2 §3.3 + E1 §3.3：续 run 判定数据面（与 provider_error 同批提前
        // 提取——outcome 随后被 drive_outcome 移动消费）。task_text = 会话
        // 首条非 steering user 消息（指纹输入，避免 error 续 run 的注入文本
        // 使指纹从第二次起漂移）；last_assistant = 最后一条 assistant 消息的
        // 流中断标注（E1 续写子分支触发信号，D7 §3.7）。
        let resume_task_text = main_task_text(&outcome.messages);
        let resume_last_assistant = last_assistant_provider_signal(&outcome.messages);
        // D5 §3.3：goal 收口评估输入预提取（outcome 随后被 drive_outcome
        // 移动消费——与 provider_error 同批提前提取；assess_goal_round 在
        // :4957 收口区块调用，数据面必须在此备好）
        let goal_signals = extract_goal_round_signals(&outcome.messages);
        // E3-2：子代理 run 汇报素材（仅子代理 run 捕获——主 run 不产生
        // subagent 汇报；Arc 克隆零拷贝共享同一份消息内存）
        let subagent_messages = if active.subagent.is_some() {
            outcome.messages.clone()
        } else {
            Vec::new()
        };
        // D3 §3.2.4：window_bytes（fork 三态判定的会话窗口字节；本触发点
        // 以本 run 消息字节合计近似——content_bytes 语义同源，lifecycle.rs:
        // 451-458；仅装配进 ctx，本决策不消费）
        let run_message_bytes: u64 = outcome.messages.iter().map(|m| m.text().len() as u64).sum();

        // T-29 收口写入（P4 阶段 1-4）：run 引擎侧收口后，把对话消息收口为
        // HistoryMessage 原子替换 SessionHistoryCache——不落库、不改写会话语义
        // （混合路线核心）；缓存 = 下次 run 的 history 参数回退源；压缩后序列
        // 随收口自然携带（缓存基线重建，P4 §3.6 I5 / C13）
        state
            .session_history
            .store(&session_id, to_history_messages(&outcome));

        // ── D7-① checkpoint 收口采集（M5B 接线：收口一次，produce 后 /
        // drive_outcome 前——outcome.messages 仍在手，借用完成后即 move；
        // finalize_failed 防御路径跳过并注释——drive 失败消息未消费属极
        // 罕见，跳过可接受，D7 §8 决策 3）。采集侧损坏 warn + 不写 + 不
        // 阻断（§3.5 降级）；子代理会话无树自动跳过（R8）。EV-02：写叶子
        // 成功经 active 通道发射 checkpoint-created（Persistent 随收口落库）──
        collect_checkpoint_on_close(
            &state,
            &session_id,
            &outcome,
            &active.queue,
            &active.bridge,
            &run_id,
        )
        .await;

        // ── E2 F5（07 §4 卡 D）：run 收口里程碑评估——对话长度达
        // compact_stage_ratios 阈值（默认 40/60/80%）时经 Summarizer 对完整
        // 对话产出阶段总结（tier=stage-N），存储（session_meta 注入面数据源）
        // + checkpoint 落载荷；每阶梯只触发一次（会话级已触发集合跨 run
        // 持久）。子代理 run 不评估（一次性任务，无里程碑语义——与 goal
        // 收口评估同守卫）──
        if active.subagent.is_none() {
            evaluate_stage_milestones(&state, &active, &session_id, &outcome.messages).await;
        }

        // T-40 缓存测量收口（P5 S5 §3.2 数据流，R5-D3 轮末合并接线 ②）：
        // outcome.cache_stats 非空（tracker.finish 产物，T-36）→ 会话级状态
        // 写回（下一 run 冷缓存预警 / 模型切换检测）+ save_run_usage 落库
        // （runs 表 v5 列，T-39）——实现细节见 [write_back_cache_stats]
        if let Some(stats) = &outcome.cache_stats {
            write_back_cache_stats(&state, &session_id, &run_id, *stats).await;
        }

        // 2. drive_outcome（锁在作用域内持有，错误路径先释放再收口）
        let driven = {
            let mut run = active.handle.lock().await;
            let mut queue = active.queue.lock().await;
            drive_outcome(&mut run, &mut queue, outcome).await
        };

        let driven = match driven {
            Ok(driven) => driven,
            Err(error) => {
                // 防御性：终态不可再驱动（已有终态 / 异常收口）→ 失败收场
                tracing::error!(
                    target: "run",
                    error = %error,
                    "drive_outcome 失败（防御性收口）"
                );
                finalize_failed(&state, &active, &error.to_string()).await;
                return;
            }
        };

        // 3. 事件 emit（信封 runId/sequence 注入；缓冲桥组装背压）
        let mut report = EmitReport::default();
        let mut runtime_error: Option<String> = None;
        for sequenced in driven.events {
            // T-CF-13（R-CF3）：事件收口旁路点 mark_wakeup 接线——任何事件
            // 到达即更新 last_wakeup（watchdog 失联判定数据源；子代理等待
            // 期间有事件到达则不误报"无唤醒"）
            state.engine.last_wakeup().mark_wakeup();
            // T09.1：实时轨已发 delta，收口流 message-delta 跳过不双发
            // （序列号已分配；持久化不落库；前端按 messageId 累加，AA-06 F1）
            if active.delta_sink_active
                && matches!(sequenced.event, AgentEvent::MessageDelta { .. })
            {
                continue;
            }
            // T04.5-1：事件桥 runtime-error 事件处写入 lastError
            if let AgentEvent::RuntimeError { error, .. } = &sequenced.event {
                runtime_error = Some(error.clone());
            }
            let envelope = AgentEventEnvelope::new(
                sequenced.event,
                Some(run_id.clone()),
                Some(sequenced.sequence),
            );
            report.add(active.bridge.emit(&envelope));
        }
        if let Some(ref error) = runtime_error {
            state
                .diagnostics
                .set_last_error(crish_payload_from_message(error));
        }
        report.add(active.bridge.flush());
        tracing::info!(
            target: "run",
            emitted = report.emitted,
            dropped = report.dropped,
            "事件发射完成（缓冲桥）"
        );

        // 4-5. 终态：移出注册表 + 快照（T08.6 触发点 A；cursor 已由
        //      drive_outcome 维护并在 finalize 落库）
        state
            .active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&run_id);
        // 15-T-6（裁决 D9）：工具级审计路由收口注销（run 级桥随 run 结束
        // 释放，防 session 泄漏；与 escape_watch 句柄同生命周期收口——
        // 重复注销幂等，finalize_failed 失败路径不重复进入本函数）
        state.engine.audit_sink().unregister(&session_id);
        // L4（F12）：审计落库收口——注销即释放桥引用（sender drop 发出
        // 通道关闭信号），await worker 排空全部审计事件再报 run 终态
        // （审计底账在终态前完整落库；None = 测试驱动路径未装配）。
        // 先 take 出句柄再 await：std Mutex 锁不跨 await 持有（AA-02）
        let audit_worker = active
            .audit_persist
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(handle) = audit_worker {
            let _ = handle.await;
        }
        // T-AB-19 run 终态显式接线：**不清理后台任务注册表、不级联杀任务**
        // ——任务属会话级（registry 生命周期独立于 run，T-AB-12 只读契约升级
        // 为显式收口契约；run_end_daemon_survives / run_end_normal_task_survives
        // _no_cascade 测试锚定）。守护任务（is_daemon=true）与普通任务在 run
        // 终态后均持续运行、日志持续累积；会话切换同理不受影响。此处仅释放
        // 「当前 run」上下文（owner_run_id 注入槽，供下一 run 复用）。
        state.background.clear_current_run(&run_id);
        // T-D-13：spawner 侧 run 上下文释放（当前活动 run 定位槽）
        state
            .subagent_spawner
            .clear_current_run(&session_id, &run_id);

        // ── T-D-13：子代理 run 终态收口（记账释放 / 行更新 / subagent-ended
        // 发射 / wait 通道 feed / steering 通知）──
        // 须在 decide_idle_resume 之前完成：steering 条目入队后，收口判定
        // 「队列非空」→ 主 agent 下一 run 自动唤醒收到子代理完成通知。
        if let Some(cfg) = active.subagent.clone() {
            let terminal_status = {
                let run = active.handle.lock().await;
                run.status.clone()
            };
            // ── D3：C7 恢复触发（决策先行于既有收口——裁决 #5 语义
            //     「on_subagent_run_terminal 之前」：escalate 的 steering 条目
            //     先入队，与 subagent-terminal-<run_id> 终态通知共存）──
            // ── E3-2：子代理运行中汇报（subagent-event 通道 kind=progress；
            //     观测面，不写 steering 队列；wait 语义零改变）──
            let recovery_plan = state
                .decide_subagent_recovery(
                    &session_id,
                    &cfg,
                    &terminal_status,
                    // D1 数据面：fatal 收场填充 kind（正常 stop 收场 None）
                    resume_provider_error.as_ref().map(|pe| pe.kind),
                    &first_user_text,
                    has_assistant_output,
                    run_message_bytes,
                )
                .await;
            state
                .emit_subagent_progress(&cfg, &active.bridge, &subagent_messages)
                .await;
            // 既有收口五步（记账释放 → 行更新 → subagent-ended → wait feed →
            // steering 通知；子代理终态通知保留——C5 断言允许其存在）
            state.on_subagent_run_terminal(&cfg, terminal_status).await;
            // ── D3：阶梯 1 收口后重派（裁决 #5：旧 run 记账已释放 → spawn
            //     守卫计数正确，无「被自己挡住」误拒；原 run failed
            //     reason=recovery-retry；预算内重派 mode=recovery-retry；
            //     不消费 Episode、无 steering）──
            if let Some(plan) = recovery_plan {
                state
                    .execute_subagent_recovery(&session_id, &cfg, plan, &active)
                    .await;
            }
        }

        state.save_snapshot_now().await;
        tracing::info!(
            target: "run",
            run_id = %run_id,
            "drive_run_loop 收口（终态）：后台任务注册表未清理、任务不级联杀（T-AB-19 契约）"
        );

        // ── T-CF-11：idle 待命续 run（收口处判定；run 正常结束而非用户取消）──
        // 唤醒源：PendingMessageQueue 非空（跨 run steering 条目）/ 活跃定时器 /
        // enabled Cron（判定器注入）；三源全空 → AI 休眠待用户。队列条目批量
        // 转出注入新 run（对齐 D07 批量推送），摘要文本已由生成侧按 §4.8
        // 模板拼入条目原文。空转护栏：连续 3 次续 run 无 AI 产出 → 停止。
        //
        // T-D-13：**子代理 run 不参与 idle 待命续 run**——子代理是一次性任务，
        // 收口即完成（终态通知已由 [Self::on_subagent_run_terminal] 发出）；若
        // 子代理收口也判定 idle 续 run，会消费自己入队的 steering 条目造成
        // 自续循环（靠空转护栏刹停，浪费模型调用）。steering 条目保留在队列，
        // 由主 agent 会话的收口消费（通知链路完整）。
        if active.subagent.is_none() {
            // ── D1 §3.2.2（S2）+ D5 §3.3：收口恢复面（熔断计数 + goal
            //    轮次评估）──
            // 熔断计数（唯一写方 [Self::update_provider_fail_streak]，
            // spawn_blocking 落键）：判定顺序（D1 §3.2.2 S2 落点）——
            // 1. RunOutcome.provider_error 存在：瞬态四类（RateLimit/
            //    ServerError/Timeout/Network）→ +1；非瞬态 → 清零（C3）；
            // 2. 无 provider_error 但最后一条 assistant 消息 metadata 标注
            //    瞬态四类（部分保留断流，D7 流中断标注）→ +1（S2 补丁：
            //    「产出一点再断流」无法绕开熔断）；
            // 3. 其余（正常完成 / 无 provider 错误信号）→ 清零。
            // 子代理 run 不参与（本区块守卫）：子代理失败走 D3 恢复阶梯，
            // 熔断是主 run provider 健康信号（子代理会话键无消费方）。
            let transient_failure = match &resume_provider_error {
                Some(pe) => is_transient_kind(pe.kind),
                None => resume_last_assistant
                    .as_ref()
                    .map(|last| {
                        last.kind.is_some_and(is_transient_kind) && last.retryable != Some(false)
                    })
                    .unwrap_or(false),
            };
            if state
                .update_provider_fail_streak(&session_id, transient_failure)
                .await
            {
                // 熔断触发边沿（跨过阈值）：观测事件（D1 §3.2.2 C5——
                // runtime-intervention-required + recovery-escalated
                // detail="circuit-trip"；仅观测面，不注入对话、不给 AI）
                emit_circuit_trip_events(&active, &session_id).await;
            }
            // D5 §3.3：收口 goal 轮次评估（唯一写方 [Self::assess_goal_round]；
            // 无 goal_state 键 → 不评估不写；error 轮由 assess_round reason
            // 门禁拦截——不递增 current_round/stalled_rounds（01 敲定 §3
            // 第3条）。评估先于 decide_idle_resume：goal_pending 读面消费
            // 本轮已推进的 goal_state（收口评估 → 续轮判定同区衔接）。
            state
                .assess_goal_round(
                    &active,
                    resume_reason,
                    &goal_signals,
                    runtime_error.as_deref(),
                )
                .await;

            // D2 §3.2：判定输入组装（outcome 已移动消费，数据面在同批提取；
            // ProviderErrorSummary 为 session-loop 私有模块类型，逐字段映射）
            let resume_signals = ResumeSignals {
                task_text: resume_task_text,
                provider_error: resume_provider_error
                    .as_ref()
                    .map(|pe| ProviderErrorFields {
                        kind: pe.kind,
                        retryable: pe.retryable,
                        retries: pe.retries,
                    }),
                last_assistant: resume_last_assistant,
            };
            if let Some(decision) = decide_idle_resume(
                &state,
                &active,
                resume_reason,
                // 「有 AI 产出」= 完成过 turn 或执行过工具（空转 run 两者皆 0）
                resume_turn_index > 0 || resume_tool_calls > 0,
                &resume_signals,
            )
            .await
            {
                tracing::info!(
                    target: "run",
                    session_id = %session_id,
                    run_id = %run_id,
                    inject_messages = decision.inject.len(),
                    "idle 待命命中：自动续开一轮 run（队列条目批量注入 / 定时器 / Cron / goal / 恢复源）"
                );
                let launcher = state
                    .resume_launcher
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone();
                match launcher {
                    Some(launcher) => {
                        launcher(&state, &session_id, decision.mode, decision.inject).await
                    }
                    None => {
                        // 防御分支：拉起器未注入（生产恒注入——CoreRunState::new
                        // 预装配生产拉起器，见 [production_resume_launcher]）。
                        // 不在此处直接引用 run_task_impl：drive_run_loop 与
                        // run_task_impl 相互包含 opaque future 会让 auto-trait
                        // 检查无法终止（Rust 限制）——经 trait object 拉起器
                        // （叶子类型）切断类型递归。未注入时跳过续 run 并记日志。
                        tracing::warn!(
                            target: "run",
                            session_id = %session_id,
                            run_id = %run_id,
                            "idle 续 run 拉起器未注入（跳过本轮续 run）"
                        );
                    }
                }
            } else {
                // 当不再续跑（如错误收场、熔断、空转超限、四源全空时）：
                // 清理本会话可能残留的旧条目，杜绝 poison pill 遗留
                let mut queue = state
                    .pending_queue
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                queue.clear_for(&session_id);
            }
        }
    } // drive_run_loop 收口闭
} // mod idle_resume 闭合（drive_run_loop 与 run_task_impl 的 opaque
  // future 跨模块定义 + trait object 拉起器切断类型递归，Send 检查可终止）

/// T-CF-11 / drive_run_loop 子模块 re-export（drive_run_loop 与
/// run_task_impl 相互引用 opaque future，跨模块定义后 Send 检查可终止；
/// 外层与测试经此引用）
pub(crate) use idle_resume::{
    assemble_system_prompt_with_stages, drive_run_loop, emit_goal_continuation_decided,
    EpisodeConsume, ResumeLauncher, WakeSourceCheck,
};
