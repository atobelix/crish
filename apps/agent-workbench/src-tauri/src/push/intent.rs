//! 推送意图判定（R3-01：事件 → 推送意图分类）
//!
//! `push_intent(event, ctx)` 是 D7 §3.1 判定顺序的纯函数实现：
//!
//! 1. 用户必须行动（审批/过期/安全拦截/需人工介入）→ 必达；
//! 2. 结果类终态（run/子代理/任务/定时器/cron）→ 按价值与频率分级；
//! 3. 过程类增量与诊断观测类 → 一律不推（返回 `None`）。
//!
//! 事件体缺字段兜底：`runtime-error` / `runtime-intervention-required` /
//! `cache-waste-alert` / `security-audit` 事件体不含 runId（由信封注入），
//! 去重键需要 runId 时经 [PushIntentCtx::envelope_run_id] 注入；缺失则回退
//! `session:{sessionId}`（单 run 场景仍具去重语义，多 run 并发时去重粒度
//! 变粗——装配层应保证信封 runId 注入，见模块文档「事件信封」注记）。

use conex_types::events::{
    AgentEvent, ApprovalDecision, RunTerminalStatus, SecurityAuditDecision, SubagentEndStatus,
};
use conex_types::session::AgentEndReason;

use super::scenes::SceneId;
use super::{PushLevel, PushTargetScreen};

/// 推送意图上下文（事件体缺失字段的注入面）
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PushIntentCtx {
    /// 信封注入的 run_id（`AgentEventEnvelope.run_id`；事件体无 runId
    /// 字段时兜底——去重键需要，见 [AgentEventEnvelope] 文档）
    pub envelope_run_id: Option<String>,
    /// 事件序号（信封 sequence；S11 安全审计去重键的回退业务键）
    pub sequence: Option<u64>,
}

/// 审批推送引用（S1/S2 持久化去重 + 重推阶梯的输入契约）
///
/// 审批不能漏（D7 §3.4.1）：S1/S2 去重键必须落 SQLite
/// `push_events_dedupe` 表（审批键持久化，重启不丢）；本任务交付
/// [crate::push::dedupe::DedupeBackend] 接口与内存实现，SQLite 后端
/// 由 R3-02/03 接线。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalPushRef {
    /// 审批工具调用 id（`PermissionRequest.tool_call_id`）
    pub tool_call_id: String,
    /// 审批所在会话
    pub session_id: String,
    /// 去重键（与 [PushIntent::dedupe_key] 同值，供持久化后端直接落键）
    pub dedupe_key: String,
}

/// 推送载荷摘要（push/copy.rs 文案渲染的输入契约——title/body 渲染不在本任务）
///
/// - `digest`：正文主体文本（prompt/error/command/reason/概述等，长度
///   截断与模板渲染由 copy 层负责）；
/// - `detail`：次级文本（S1 工具名、S8d 退出码等，可空）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PayloadDigest {
    /// 场景所属会话
    pub session_id: String,
    /// 主业务键（toolCallId/runId/taskId/timerId/cronId/subagentId 等）
    pub biz_key: String,
    /// 正文主体文本（可空 = 由 copy 层按场景渲染）
    pub digest: Option<String>,
    /// 次级文本（可空）
    pub detail: Option<String>,
}

/// 推送意图（`push_intent` 判定产物；去重/合并/静默/节流各环节的输入）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushIntent {
    /// 命中场景（登记表行）
    pub scene: SceneId,
    /// 推送级别（scene 级别；P3 不推由 `None` 表达）
    pub level: PushLevel,
    /// 去重键（D7 §3.4.1：{eventType}:{业务键}）
    pub dedupe_key: String,
    /// 折叠键（厂商通道同链折叠 / iOS threadId 分组）
    pub collapse_key: String,
    /// 跳转目标屏幕
    pub target: PushTargetScreen,
    /// 载荷摘要（copy 层输入）
    pub payload: PayloadDigest,
    /// S1/S2 审批键（持久化去重注记；非审批为 `None`）
    pub approval: Option<ApprovalPushRef>,
}

/// 去重键构造（D7 §3.4.1：`{eventType}:{业务键}`）
pub fn dedupe_key(event_type: &str, biz_key: &str) -> String {
    format!("{event_type}:{biz_key}")
}

/// run 终止来源（R3-01a 补强：S8e 精确来源判定的判定输入）
///
/// D7 §3.3 S8e：task-killed 与 kill 来源联动——**用户主动 kill 不推**，
/// 系统/watchdog 强制 kill 才推。来源由装配层从事件流注入：
/// - 精确路径：[run_termination_source]（`agent-end.reason` 的
///   [AgentEndReason]——用户 cancel 命令 → `Aborted`/`Stopped`）；
/// - 等价路径：[run_terminal_source]（`run-terminal.terminal` 的
///   [RunTerminalStatus]——事件流无 agent-end 时的等价判定）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunTerminationSource {
    /// 用户主动终止（cancel 命令 / 用户协作停止）
    UserKilled,
    /// 引擎/系统终止（正常收场 / 错误收场 / 预算用尽）
    EngineTerminated,
}

/// [AgentEndReason] → run 终止来源（精确判定：agent-end 事件 reason 字段）
pub fn run_termination_source(reason: AgentEndReason) -> RunTerminationSource {
    match reason {
        // 用户中止（ABORT 事件 / L3 force_cancel）与用户协作停止 → 用户主动
        AgentEndReason::Aborted | AgentEndReason::Stopped => RunTerminationSource::UserKilled,
        // 正常收场 / 预算用尽（非错误非中止）/ 错误收场 → 引擎终止
        AgentEndReason::Stop | AgentEndReason::MaxTurns | AgentEndReason::Error => {
            RunTerminationSource::EngineTerminated
        }
    }
}

/// [RunTerminalStatus] → run 终止来源（等价判定：事件流无 agent-end reason
/// 时的回退；Cancelled 无法区分用户取消/引擎中止，保守按用户主动归入
/// [RunTerminationSource::UserKilled]——S8e 语境下「run 取消 → 任务被连坐
/// 终止」多为用户行为，宁可少推不可扰民）
pub fn run_terminal_source(terminal: RunTerminalStatus) -> RunTerminationSource {
    match terminal {
        RunTerminalStatus::Cancelled => RunTerminationSource::UserKilled,
        RunTerminalStatus::Completed | RunTerminalStatus::Failed => {
            RunTerminationSource::EngineTerminated
        }
    }
}

/// S8e 判定矩阵：task-killed 是否应推送。
///
/// | 来源（注入） | via_force | 判定 | 语义 |
/// | --- | --- | --- | --- |
/// | UserKilled | 任意 | 不推 | 用户主动 kill（Windows 两阶段升级后 via_force=true 仍属用户行为） |
/// | EngineTerminated | 任意 | 推 | 系统/watchdog 强制 kill |
/// | None（来源未知） | false | 不推 | 回退 R3-01a 近似：优雅 kill 视为用户主动 |
/// | None（来源未知） | true | 推 | 回退 R3-01a 近似：强制 kill 视为系统行为 |
pub fn task_killed_should_push(
    source: Option<RunTerminationSource>,
    via_force: bool,
) -> bool {
    match source {
        Some(RunTerminationSource::UserKilled) => false,
        Some(RunTerminationSource::EngineTerminated) => true,
        // 来源未知：回退 via_force 近似（R3-01a 口径）
        None => via_force,
    }
}

/// 事件 → 推送意图（D7 §3.2 全量筛选表 + M8 §3.2.3 级别真源）
///
/// 返回 `None` 即 P3 不推。match 覆盖全部 49 变体（穷尽是编译期护栏：
/// 新事件变体必须在此表态）。
///
/// kill 来源注入：S8e 需要精确来源时调用
/// [push_intent_with_kill_source]（引擎事件流观察 / 装配层注入）；
/// 本函数等价于注入 `None`（来源未知回退 via_force 近似）。
pub fn push_intent(event: &AgentEvent, ctx: &PushIntentCtx) -> Option<PushIntent> {
    push_intent_with_kill_source(event, ctx, None)
}

/// 带 kill 来源注入的推送意图判定（R3-01a 补强：S8e 精确来源）
///
/// 与 [push_intent] 的唯一差异是 S8e（task-killed）场景按来源精确判定；
/// 其余场景行为完全一致。`kill_source = None` 时行为 = [push_intent]。
pub fn push_intent_with_kill_source(
    event: &AgentEvent,
    ctx: &PushIntentCtx,
    kill_source: Option<RunTerminationSource>,
) -> Option<PushIntent> {
    match event {
        // ── S1 审批请求（P0 必达最高）──
        AgentEvent::ApprovalRequested {
            session_id,
            request,
            ..
        } => {
            let key = dedupe_key("approval-requested", &request.tool_call_id);
            Some(PushIntent {
                scene: SceneId::ApprovalRequested,
                level: PushLevel::P0Critical,
                dedupe_key: key.clone(),
                collapse_key: format!("session:{session_id}"),
                target: PushTargetScreen::Approval,
                payload: PayloadDigest {
                    session_id: session_id.clone(),
                    biz_key: request.tool_call_id.clone(),
                    digest: Some(request.summary.clone()),
                    detail: Some(request.tool_name.clone()),
                },
                approval: Some(ApprovalPushRef {
                    tool_call_id: request.tool_call_id.clone(),
                    session_id: session_id.clone(),
                    dedupe_key: key,
                }),
            })
        }

        // ── S2 审批结果（仅 expired 推；approved/denied 不推）──
        AgentEvent::ApprovalResolved {
            session_id,
            tool_call_id,
            decision,
            ..
        } => {
            if *decision != ApprovalDecision::Expired {
                return None;
            }
            let key = dedupe_key("approval-resolved", &format!("{tool_call_id}:expired"));
            Some(PushIntent {
                scene: SceneId::ApprovalExpired,
                level: PushLevel::P0Critical,
                dedupe_key: key.clone(),
                collapse_key: format!("session:{session_id}"),
                target: PushTargetScreen::Approval,
                payload: PayloadDigest {
                    session_id: session_id.clone(),
                    biz_key: tool_call_id.clone(),
                    digest: None,
                    detail: None,
                },
                approval: Some(ApprovalPushRef {
                    tool_call_id: tool_call_id.clone(),
                    session_id: session_id.clone(),
                    dedupe_key: key,
                }),
            })
        }

        // ── S3/S4/S5 run 终态 ──
        AgentEvent::RunTerminal {
            session_id,
            run_id,
            terminal,
            error,
            ..
        } => match terminal {
            RunTerminalStatus::Completed => Some(PushIntent {
                scene: SceneId::RunCompleted,
                level: PushLevel::P1Important,
                dedupe_key: dedupe_key("run-terminal", run_id),
                collapse_key: format!("session:{session_id}"),
                target: PushTargetScreen::Session,
                payload: PayloadDigest {
                    session_id: session_id.clone(),
                    biz_key: run_id.clone(),
                    digest: None,
                    detail: None,
                },
                approval: None,
            }),
            RunTerminalStatus::Failed => Some(PushIntent {
                scene: SceneId::RunFailed,
                level: PushLevel::P0Critical,
                dedupe_key: dedupe_key("run-terminal", &format!("{run_id}:failed")),
                collapse_key: format!("session:{session_id}"),
                target: PushTargetScreen::Session,
                payload: PayloadDigest {
                    session_id: session_id.clone(),
                    biz_key: run_id.clone(),
                    digest: error.clone(),
                    detail: None,
                },
                approval: None,
            }),
            RunTerminalStatus::Cancelled => Some(PushIntent {
                scene: SceneId::RunCancelled,
                level: PushLevel::P1Important,
                dedupe_key: dedupe_key("run-terminal", &format!("{run_id}:cancelled")),
                collapse_key: format!("session:{session_id}"),
                target: PushTargetScreen::Session,
                payload: PayloadDigest {
                    session_id: session_id.clone(),
                    biz_key: run_id.clone(),
                    digest: None,
                    detail: None,
                },
                approval: None,
            }),
        },

        // ── S6/S7 子代理终态 ──
        AgentEvent::SubagentEnded {
            session_id,
            subagent_id,
            status,
            summary,
            ..
        } => match status {
            SubagentEndStatus::Failed => Some(PushIntent {
                scene: SceneId::SubagentFailed,
                level: PushLevel::P0Critical,
                dedupe_key: dedupe_key("subagent-ended", &format!("{subagent_id}:failed")),
                collapse_key: format!("session:{session_id}"),
                target: PushTargetScreen::Subagent,
                payload: PayloadDigest {
                    session_id: session_id.clone(),
                    biz_key: subagent_id.clone(),
                    digest: summary.clone(),
                    detail: None,
                },
                approval: None,
            }),
            // completed / cancelled 同族 P1（D7 §3.2 行 31：cancelled→P1）；
            // cancelled 用独立去重键，避免与 completed 的推发互相抑制
            SubagentEndStatus::Completed => Some(PushIntent {
                scene: SceneId::SubagentCompleted,
                level: PushLevel::P1Important,
                dedupe_key: dedupe_key("subagent-ended", subagent_id),
                collapse_key: format!("session:{session_id}"),
                target: PushTargetScreen::Subagent,
                payload: PayloadDigest {
                    session_id: session_id.clone(),
                    biz_key: subagent_id.clone(),
                    digest: summary.clone(),
                    detail: None,
                },
                approval: None,
            }),
            SubagentEndStatus::Cancelled => Some(PushIntent {
                scene: SceneId::SubagentCompleted,
                level: PushLevel::P1Important,
                dedupe_key: dedupe_key("subagent-ended", &format!("{subagent_id}:cancelled")),
                collapse_key: format!("session:{session_id}"),
                target: PushTargetScreen::Subagent,
                payload: PayloadDigest {
                    session_id: session_id.clone(),
                    biz_key: subagent_id.clone(),
                    digest: summary.clone(),
                    detail: None,
                },
                approval: None,
            }),
        },

        // ── S8a 任务启动（仅 daemon/预计长耗时；D7 §3.3 S8a）──
        AgentEvent::TaskStarted {
            session_id,
            task_id,
            command,
            is_daemon,
            ..
        } => {
            if !is_daemon {
                return None;
            }
            Some(PushIntent {
                scene: SceneId::TaskStarted,
                level: PushLevel::P2Collapsible,
                dedupe_key: dedupe_key("task-started", task_id),
                collapse_key: format!("session:{session_id}"),
                target: PushTargetScreen::Task,
                payload: PayloadDigest {
                    session_id: session_id.clone(),
                    biz_key: task_id.clone(),
                    digest: Some(command.clone()),
                    detail: None,
                },
                approval: None,
            })
        }

        // ── S8b 任务完成（P1）──
        AgentEvent::TaskCompleted {
            session_id,
            task_id,
            exit_code,
            ..
        } => Some(PushIntent {
            scene: SceneId::TaskCompleted,
            level: PushLevel::P1Important,
            dedupe_key: dedupe_key("task-completed", task_id),
            collapse_key: format!("session:{session_id}"),
            target: PushTargetScreen::Task,
            payload: PayloadDigest {
                session_id: session_id.clone(),
                biz_key: task_id.clone(),
                digest: None,
                detail: Some(format!("exit code {exit_code}")),
            },
            approval: None,
        }),

        // ── S8c 任务疑似卡死（P0）──
        AgentEvent::TaskSuspicious {
            session_id,
            task_id,
            silence_ms,
            ..
        } => Some(PushIntent {
            scene: SceneId::TaskSuspicious,
            level: PushLevel::P0Critical,
            dedupe_key: dedupe_key("task-suspicious", task_id),
            collapse_key: format!("session:{session_id}"),
            target: PushTargetScreen::Task,
            payload: PayloadDigest {
                session_id: session_id.clone(),
                biz_key: task_id.clone(),
                digest: Some(format!("{silence_ms}")),
                detail: None,
            },
            approval: None,
        }),

        // ── S8d 任务失败（P0）──
        AgentEvent::TaskFailed {
            session_id,
            task_id,
            exit_code,
            tail,
            ..
        } => Some(PushIntent {
            scene: SceneId::TaskFailed,
            level: PushLevel::P0Critical,
            dedupe_key: dedupe_key("task-failed", task_id),
            collapse_key: format!("session:{session_id}"),
            target: PushTargetScreen::Task,
            payload: PayloadDigest {
                session_id: session_id.clone(),
                biz_key: task_id.clone(),
                // 日志尾部末行作正文素材（全量 tail 由 copy/任务详情消费）
                digest: tail.last().cloned(),
                detail: Some(format!("exit code {exit_code}")),
            },
            approval: None,
        }),

        // ── S8e 任务被终止（P1；与 kill 来源联动——用户主动 kill 不推，
        //    系统/watchdog 强制 kill 才推；来源经
        //    [push_intent_with_kill_source] 注入，未知回退 via_force 近似）──
        AgentEvent::TaskKilled {
            session_id,
            task_id,
            via_force,
            diagnostics,
            ..
        } => {
            if !task_killed_should_push(kill_source, *via_force) {
                return None;
            }
            Some(PushIntent {
                scene: SceneId::TaskKilled,
                level: PushLevel::P1Important,
                dedupe_key: dedupe_key("task-killed", task_id),
                collapse_key: format!("session:{session_id}"),
                target: PushTargetScreen::Task,
                payload: PayloadDigest {
                    session_id: session_id.clone(),
                    biz_key: task_id.clone(),
                    digest: diagnostics.clone(),
                    detail: None,
                },
                approval: None,
            })
        }

        // ── S9a 定时器到期（P1）──
        AgentEvent::TimerFired {
            session_id,
            timer_id,
            prompt,
            ..
        } => Some(PushIntent {
            scene: SceneId::TimerFired,
            level: PushLevel::P1Important,
            dedupe_key: dedupe_key("timer-fired", timer_id),
            collapse_key: format!("timer:{timer_id}"),
            target: PushTargetScreen::Timer,
            payload: PayloadDigest {
                session_id: session_id.clone(),
                biz_key: timer_id.clone(),
                digest: Some(prompt.clone()),
                detail: None,
            },
            approval: None,
        }),

        // ── S9b cron 触发（P1；去重键带 iteration——每次触发独立，
        //    防打扰由合并桶（10min 窗口「cron 已触发 N 次」）承担，
        //    Z0 §4.12 键：cron-fired:{cronId}:{iteration}）──
        AgentEvent::CronFired {
            session_id,
            cron_id,
            prompt,
            iteration,
            ..
        } => Some(PushIntent {
            scene: SceneId::CronFired,
            level: PushLevel::P1Important,
            dedupe_key: dedupe_key("cron-fired", &format!("{cron_id}:{iteration}")),
            collapse_key: format!("cron:{cron_id}"),
            target: PushTargetScreen::Timer,
            payload: PayloadDigest {
                session_id: session_id.clone(),
                biz_key: cron_id.clone(),
                digest: Some(prompt.clone()),
                detail: Some(format!("iteration {iteration}")),
            },
            approval: None,
        }),

        // ── S10a 运行异常（P0；runId 经信封注入）──
        AgentEvent::RuntimeError {
            session_id,
            error,
            ..
        } => Some(PushIntent {
            scene: SceneId::RuntimeError,
            level: PushLevel::P0Critical,
            dedupe_key: dedupe_key(
                "runtime-error",
                &run_or_session_key(ctx.envelope_run_id.as_deref(), session_id),
            ),
            collapse_key: format!("session:{session_id}"),
            target: PushTargetScreen::Session,
            payload: PayloadDigest {
                session_id: session_id.clone(),
                biz_key: ctx.envelope_run_id.clone().unwrap_or_default(),
                digest: Some(error.clone()),
                detail: None,
            },
            approval: None,
        }),

        // ── S10b 需人工介入（P0；run 以 stop 收场，用户必须知情）──
        AgentEvent::RuntimeInterventionRequired {
            session_id,
            reason,
            ..
        } => Some(PushIntent {
            scene: SceneId::InterventionRequired,
            level: PushLevel::P0Critical,
            dedupe_key: dedupe_key(
                "intervention",
                &run_or_session_key(ctx.envelope_run_id.as_deref(), session_id),
            ),
            collapse_key: format!("session:{session_id}"),
            target: PushTargetScreen::Session,
            payload: PayloadDigest {
                session_id: session_id.clone(),
                biz_key: ctx.envelope_run_id.clone().unwrap_or_default(),
                digest: Some(reason.clone()),
                detail: None,
            },
            approval: None,
        }),

        // ── S11 安全拦截（P0 子集：decision ∈ {blocked, purged}）──
        AgentEvent::SecurityAudit {
            session_id,
            operation,
            decision,
            tool_call_id,
            ..
        } => {
            if !matches!(
                decision,
                SecurityAuditDecision::Blocked | SecurityAuditDecision::Purged
            ) {
                return None;
            }
            // 去重业务键优先级：tool_call_id（D7 §3.3 S11 样例
            // security-audit:tc-9f4b）→ 信封 sequence（Z0 §4.12
            // security-audit:{sequence}）→ session 回退
            let biz_key = tool_call_id
                .clone()
                .or_else(|| {
                    ctx.sequence
                        .map(|s| format!("seq:{s}"))
                })
                .unwrap_or_else(|| format!("session:{session_id}"));
            Some(PushIntent {
                scene: SceneId::SecurityBlocked,
                level: PushLevel::P0Critical,
                dedupe_key: dedupe_key("security-audit", &biz_key),
                collapse_key: format!("session:{session_id}"),
                target: PushTargetScreen::Audit,
                payload: PayloadDigest {
                    session_id: session_id.clone(),
                    biz_key,
                    digest: Some(format!("{:?}", operation)),
                    detail: None,
                },
                approval: None,
            })
        }

        // ── S12 缓存浪费告警（P2；runId 经信封注入）──
        AgentEvent::CacheWasteAlert {
            session_id,
            missed_tokens,
            missed_cost_usd,
            ..
        } => Some(PushIntent {
            scene: SceneId::CacheWasteAlert,
            level: PushLevel::P2Collapsible,
            dedupe_key: dedupe_key(
                "cache-waste-alert",
                &run_or_session_key(ctx.envelope_run_id.as_deref(), session_id),
            ),
            collapse_key: format!("session:{session_id}"),
            target: PushTargetScreen::Session,
            payload: PayloadDigest {
                session_id: session_id.clone(),
                biz_key: ctx.envelope_run_id.clone().unwrap_or_default(),
                digest: Some(format!("{missed_tokens}")),
                detail: missed_cost_usd.map(|c| format!("{c:.2}")),
            },
            approval: None,
        }),

        // ── P3 不推（过程态/增量/诊断/恢复域/goal 域）──
        AgentEvent::AgentStart { .. }
        | AgentEvent::AgentEnd { .. }
        | AgentEvent::TurnStart { .. }
        | AgentEvent::TurnEnd { .. }
        | AgentEvent::MessageStart { .. }
        | AgentEvent::MessageDelta { .. }
        | AgentEvent::MessageEnd { .. }
        | AgentEvent::ToolStart { .. }
        | AgentEvent::ToolUpdate { .. }
        | AgentEvent::ToolEnd { .. }
        | AgentEvent::ToolBatchStart { .. }
        | AgentEvent::ToolBatchEnd { .. }
        | AgentEvent::ContextCompressionStart { .. }
        | AgentEvent::ContextCompressionEnd { .. }
        | AgentEvent::ProviderDiagnostic { .. }
        | AgentEvent::RuntimeSteering { .. }
        | AgentEvent::CheckpointCreated { .. }
        | AgentEvent::CheckpointRestored { .. }
        | AgentEvent::CacheStatsUpdated { .. }
        | AgentEvent::ColdCacheWarning { .. }
        | AgentEvent::SubagentStarted { .. }
        | AgentEvent::SubagentEvent { .. }
        | AgentEvent::TaskOutput { .. }
        | AgentEvent::TaskHeartbeat { .. }
        | AgentEvent::TimerCancelled { .. }
        | AgentEvent::RecoveryEscalated { .. }
        | AgentEvent::RecoverySteering { .. }
        | AgentEvent::RecoveryFork { .. }
        | AgentEvent::RecoveryReport { .. }
        | AgentEvent::RecoveryBudgetDenied { .. }
        | AgentEvent::GoalRoundStarted { .. }
        | AgentEvent::GoalRoundCompleted { .. }
        | AgentEvent::GoalContinuationDecided { .. }
        // D-03 观测补全九事件（全 Delta 可丢级观测，桌面观测面，
        // 不产生推送意图——tool-input-repaired 已核销删除）
        | AgentEvent::SteeringEvaluated { .. }
        | AgentEvent::ControlIntent { .. }
        | AgentEvent::HookOutcome { .. }
        | AgentEvent::SummaryBackground { .. }
        | AgentEvent::StageSummaryMilestone { .. }
        | AgentEvent::NudgeEnqueued { .. }
        | AgentEvent::RecoveryAcknowledged { .. }
        | AgentEvent::RecoveryRetryAttempted { .. }
        | AgentEvent::ProviderRequestAnchored { .. } => None,
    }
}

/// runId 兜底键：信封注入的 runId 优先，缺失回退 `session:{sessionId}`
fn run_or_session_key(run_id: Option<&str>, session_id: &str) -> String {
    match run_id {
        Some(run) => run.to_string(),
        None => format!("session:{session_id}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_types::events::{
        ApprovalDecision, MissAttribution, PermissionRequest, RunCacheStats, RunTerminalStatus,
        SecurityAuditDecision, SecurityAuditOperation, SubagentEndStatus, SubagentEventKind,
        SubagentEventPayload, ToolMetadata,
    };
    // AgentEndReason 定义于 session 域（events.rs 仅私有导入，外部不可达）
    use conex_types::session::AgentEndReason;
    use conex_types::impact::ImpactAssessment;

    fn ctx() -> PushIntentCtx {
        PushIntentCtx::default()
    }

    fn ctx_with_run(run_id: &str) -> PushIntentCtx {
        PushIntentCtx {
            envelope_run_id: Some(run_id.to_string()),
            sequence: None,
        }
    }

    fn approval_requested(tool_call_id: &str, tool_name: &str, summary: &str) -> AgentEvent {
        AgentEvent::ApprovalRequested {
            session_id: "s-7".to_string(),
            timestamp: "2026-08-13T10:00:00Z".to_string(),
            request: PermissionRequest {
                id: "req-1".to_string(),
                session_id: "s-7".to_string(),
                cwd: "C:\\workspace".to_string(),
                tool_call_id: tool_call_id.to_string(),
                tool_name: tool_name.to_string(),
                parameters: serde_json::json!({}),
                summary: summary.to_string(),
                tool_metadata: ToolMetadata::default(),
                metadata: None,
                requester_run_id: None,
                reason: None,
            },
        }
    }

    fn run_terminal(run_id: &str, terminal: RunTerminalStatus, error: Option<&str>) -> AgentEvent {
        AgentEvent::RunTerminal {
            session_id: "s-7".to_string(),
            run_id: run_id.to_string(),
            timestamp: "2026-08-13T10:00:00Z".to_string(),
            terminal,
            error: error.map(str::to_string),
        }
    }

    fn subagent_ended(id: &str, status: SubagentEndStatus) -> AgentEvent {
        AgentEvent::SubagentEnded {
            session_id: "s-7".to_string(),
            subagent_id: id.to_string(),
            subagent_run_id: format!("{id}-run"),
            status,
            summary: Some("已产出缺口分析 5 页".to_string()),
            ended_at: "2026-08-13T10:00:00Z".to_string(),
            subagent_session_id: None,
        }
    }

    fn security_audit(decision: SecurityAuditDecision, tool_call_id: Option<&str>) -> AgentEvent {
        AgentEvent::SecurityAudit {
            session_id: "s-7".to_string(),
            timestamp: "2026-08-13T10:00:00Z".to_string(),
            operation: SecurityAuditOperation::Delete,
            targets: vec!["C:\\workspace\\src\\main.rs".to_string()],
            impact: ImpactAssessment::default(),
            decision,
            permission_mode: None,
            tool_call_id: tool_call_id.map(str::to_string),
        }
    }

    // ── 13 场景矩阵（登记表 18 行逐行断言）──

    #[test]
    fn s1_approval_requested_p0() {
        let intent = push_intent(&approval_requested("tc-9f3a", "bash", "执行部署脚本"), &ctx())
            .expect("S1 必须推");
        assert_eq!(intent.scene, SceneId::ApprovalRequested);
        assert_eq!(intent.level, PushLevel::P0Critical);
        assert_eq!(intent.dedupe_key, "approval-requested:tc-9f3a");
        assert_eq!(intent.target, PushTargetScreen::Approval);
        assert_eq!(intent.payload.biz_key, "tc-9f3a");
        assert_eq!(intent.payload.detail.as_deref(), Some("bash"));
        let approval = intent.approval.expect("S1 必须带审批引用");
        assert_eq!(approval.tool_call_id, "tc-9f3a");
        assert_eq!(approval.dedupe_key, "approval-requested:tc-9f3a");
    }

    #[test]
    fn s2_approval_expired_p0_others_skipped() {
        let expired = AgentEvent::ApprovalResolved {
            session_id: "s-7".to_string(),
            tool_call_id: "tc-9f3a".to_string(),
            request_id: None,
            decision: ApprovalDecision::Expired,
            timestamp: "2026-08-13T10:00:00Z".to_string(),
        };
        let intent = push_intent(&expired, &ctx()).expect("S2 expired 必须推");
        assert_eq!(intent.scene, SceneId::ApprovalExpired);
        assert_eq!(intent.level, PushLevel::P0Critical);
        assert_eq!(intent.dedupe_key, "approval-resolved:tc-9f3a:expired");
        assert!(intent.approval.is_some());

        for decision in [ApprovalDecision::Approved, ApprovalDecision::Denied] {
            let resolved = AgentEvent::ApprovalResolved {
                session_id: "s-7".to_string(),
                tool_call_id: "tc-9f3a".to_string(),
                request_id: None,
                decision,
                timestamp: "2026-08-13T10:00:00Z".to_string(),
            };
            assert_eq!(
                push_intent(&resolved, &ctx()),
                None,
                "approved/denied 是决策回执，不推（D7 §3.3 S2）"
            );
        }
    }

    #[test]
    fn s3_run_completed_p1() {
        let intent =
            push_intent(&run_terminal("run-42", RunTerminalStatus::Completed, None), &ctx())
                .expect("S3 必须推");
        assert_eq!(intent.scene, SceneId::RunCompleted);
        assert_eq!(intent.level, PushLevel::P1Important);
        assert_eq!(intent.dedupe_key, "run-terminal:run-42");
        assert_eq!(intent.target, PushTargetScreen::Session);
    }

    #[test]
    fn s4_run_failed_p0() {
        let intent = push_intent(
            &run_terminal("run-42", RunTerminalStatus::Failed, Some("provider 401")),
            &ctx(),
        )
        .expect("S4 必须推");
        assert_eq!(intent.scene, SceneId::RunFailed);
        assert_eq!(intent.level, PushLevel::P0Critical);
        assert_eq!(intent.dedupe_key, "run-terminal:run-42:failed");
        assert_eq!(intent.payload.digest.as_deref(), Some("provider 401"));
    }

    #[test]
    fn s5_run_cancelled_p1() {
        let intent =
            push_intent(&run_terminal("run-42", RunTerminalStatus::Cancelled, None), &ctx())
                .expect("S5 必须推");
        assert_eq!(intent.scene, SceneId::RunCancelled);
        assert_eq!(intent.level, PushLevel::P1Important);
        assert_eq!(intent.dedupe_key, "run-terminal:run-42:cancelled");
    }

    #[test]
    fn s6_subagent_completed_p1() {
        let intent = push_intent(
            &subagent_ended("sa-3", SubagentEndStatus::Completed),
            &ctx(),
        )
        .expect("S6 必须推");
        assert_eq!(intent.scene, SceneId::SubagentCompleted);
        assert_eq!(intent.level, PushLevel::P1Important);
        assert_eq!(intent.dedupe_key, "subagent-ended:sa-3");

        // cancelled 同族 P1（D7 §3.2 行 31），去重键独立
        let cancelled = push_intent(
            &subagent_ended("sa-4", SubagentEndStatus::Cancelled),
            &ctx(),
        )
        .expect("S6 cancelled 同族 P1");
        assert_eq!(cancelled.scene, SceneId::SubagentCompleted);
        assert_eq!(cancelled.level, PushLevel::P1Important);
        assert_eq!(cancelled.dedupe_key, "subagent-ended:sa-4:cancelled");
    }

    #[test]
    fn s7_subagent_failed_p0() {
        let intent = push_intent(&subagent_ended("sa-4", SubagentEndStatus::Failed), &ctx())
            .expect("S7 必须推");
        assert_eq!(intent.scene, SceneId::SubagentFailed);
        assert_eq!(intent.level, PushLevel::P0Critical);
        assert_eq!(intent.dedupe_key, "subagent-ended:sa-4:failed");
    }

    #[test]
    fn s8a_task_started_daemon_p2() {
        let daemon = AgentEvent::TaskStarted {
            session_id: "s-7".to_string(),
            task_id: "t-1".to_string(),
            command: "npm run build".to_string(),
            cwd: "C:\\workspace".to_string(),
            owner_run_id: "run-42".to_string(),
            is_daemon: true,
        };
        let intent = push_intent(&daemon, &ctx()).expect("S8a daemon 必须推");
        assert_eq!(intent.scene, SceneId::TaskStarted);
        assert_eq!(intent.level, PushLevel::P2Collapsible);
        assert_eq!(intent.dedupe_key, "task-started:t-1");

        let plain = AgentEvent::TaskStarted {
            session_id: "s-7".to_string(),
            task_id: "t-2".to_string(),
            command: "echo hi".to_string(),
            cwd: "C:\\workspace".to_string(),
            owner_run_id: "run-42".to_string(),
            is_daemon: false,
        };
        assert_eq!(push_intent(&plain, &ctx()), None, "普通任务启动不推");
    }

    #[test]
    fn s8b_task_completed_p1() {
        let event = AgentEvent::TaskCompleted {
            session_id: "s-7".to_string(),
            task_id: "t-11".to_string(),
            exit_code: 0,
            duration_ms: 125_000,
            line_count: 42,
        };
        let intent = push_intent(&event, &ctx()).expect("S8b 必须推");
        assert_eq!(intent.scene, SceneId::TaskCompleted);
        assert_eq!(intent.level, PushLevel::P1Important);
        assert_eq!(intent.dedupe_key, "task-completed:t-11");
        assert_eq!(intent.payload.detail.as_deref(), Some("exit code 0"));
    }

    #[test]
    fn s8c_task_suspicious_p0() {
        let event = AgentEvent::TaskSuspicious {
            session_id: "s-7".to_string(),
            task_id: "t-12".to_string(),
            silence_ms: 120_000,
            last_output_at_ms: 1_786_214_500_000,
        };
        let intent = push_intent(&event, &ctx()).expect("S8c 必须推");
        assert_eq!(intent.scene, SceneId::TaskSuspicious);
        assert_eq!(intent.level, PushLevel::P0Critical);
        assert_eq!(intent.dedupe_key, "task-suspicious:t-12");
    }

    #[test]
    fn s8d_task_failed_p0() {
        let event = AgentEvent::TaskFailed {
            session_id: "s-7".to_string(),
            task_id: "t-11".to_string(),
            exit_code: 1,
            tail: vec!["npm ERR! code ELIFECYCLE".to_string()],
            duration_ms: 125_000,
        };
        let intent = push_intent(&event, &ctx()).expect("S8d 必须推");
        assert_eq!(intent.scene, SceneId::TaskFailed);
        assert_eq!(intent.level, PushLevel::P0Critical);
        assert_eq!(intent.dedupe_key, "task-failed:t-11");
        assert_eq!(
            intent.payload.digest.as_deref(),
            Some("npm ERR! code ELIFECYCLE")
        );
    }

    #[test]
    fn s8e_task_killed_force_p1() {
        let force = AgentEvent::TaskKilled {
            session_id: "s-7".to_string(),
            task_id: "t-3".to_string(),
            via_force: true,
            diagnostics: Some("watchdog 强制终止".to_string()),
        };
        let intent = push_intent(&force, &ctx()).expect("S8e 强制终止必须推");
        assert_eq!(intent.scene, SceneId::TaskKilled);
        assert_eq!(intent.level, PushLevel::P1Important);
        assert_eq!(intent.dedupe_key, "task-killed:t-3");

        let graceful = AgentEvent::TaskKilled {
            session_id: "s-7".to_string(),
            task_id: "t-3".to_string(),
            via_force: false,
            diagnostics: None,
        };
        assert_eq!(
            push_intent(&graceful, &ctx()),
            None,
            "用户主动（非强制）kill 不推（D7 §3.3 S8e）"
        );
    }

    /// S8e 来源判定矩阵（R3-01a 补强）：来源精确优先，未知回退 via_force
    #[test]
    fn s8e_kill_source_matrix() {
        // 来源精确判定优先于 via_force：用户 kill 即使两阶段升级强制也不推
        assert!(!task_killed_should_push(Some(RunTerminationSource::UserKilled), true));
        assert!(!task_killed_should_push(Some(RunTerminationSource::UserKilled), false));
        // 系统/watchdog：来源=引擎终止恒推
        assert!(task_killed_should_push(Some(RunTerminationSource::EngineTerminated), true));
        assert!(task_killed_should_push(Some(RunTerminationSource::EngineTerminated), false));
        // 来源未知：回退 R3-01a via_force 近似
        assert!(!task_killed_should_push(None, false));
        assert!(task_killed_should_push(None, true));
    }

    /// AgentEndReason → 来源（精确路径：agent-end 事件 reason 字段）
    #[test]
    fn s8e_agent_end_reason_mapping() {
        // 用户中止 / 用户协作停止 → 用户主动 kill
        assert_eq!(
            run_termination_source(AgentEndReason::Aborted),
            RunTerminationSource::UserKilled
        );
        assert_eq!(
            run_termination_source(AgentEndReason::Stopped),
            RunTerminationSource::UserKilled
        );
        // 正常收场 / 预算用尽 / 错误收场 → 引擎终止
        assert_eq!(
            run_termination_source(AgentEndReason::Stop),
            RunTerminationSource::EngineTerminated
        );
        assert_eq!(
            run_termination_source(AgentEndReason::MaxTurns),
            RunTerminationSource::EngineTerminated
        );
        assert_eq!(
            run_termination_source(AgentEndReason::Error),
            RunTerminationSource::EngineTerminated
        );
    }

    /// RunTerminalStatus → 来源（等价路径：无 agent-end 时的回退判定）
    #[test]
    fn s8e_run_terminal_status_mapping() {
        assert_eq!(
            run_terminal_source(RunTerminalStatus::Cancelled),
            RunTerminationSource::UserKilled,
            "取消保守归用户主动（S8e 宁可少推）"
        );
        assert_eq!(
            run_terminal_source(RunTerminalStatus::Completed),
            RunTerminationSource::EngineTerminated
        );
        assert_eq!(
            run_terminal_source(RunTerminalStatus::Failed),
            RunTerminationSource::EngineTerminated
        );
    }

    /// S8e 注入面：用户 kill（含 Windows 升级强制形态）→ 不推；
    /// 系统/watchdog kill → 推（优雅形态也推——来源判定优先）
    #[test]
    fn s8e_injected_source_overrides_via_force() {
        let killed_force = AgentEvent::TaskKilled {
            session_id: "s-7".to_string(),
            task_id: "t-3".to_string(),
            via_force: true,
            diagnostics: Some("升级强制终止".to_string()),
        };
        // 用户 kill（Windows 两阶段升级 via_force=true 仍属用户行为）→ 不推
        assert_eq!(
            push_intent_with_kill_source(
                &killed_force,
                &ctx(),
                Some(RunTerminationSource::UserKilled)
            ),
            None,
            "用户 kill 即使升级为强制也不推（精确来源覆盖 via_force 近似）"
        );

        // 系统/watchdog 强制 kill → 推（P1）
        let intent = push_intent_with_kill_source(
            &killed_force,
            &ctx(),
            Some(RunTerminationSource::EngineTerminated),
        )
        .expect("系统强制 kill 必须推");
        assert_eq!(intent.scene, SceneId::TaskKilled);
        assert_eq!(intent.level, PushLevel::P1Important);
        assert_eq!(intent.dedupe_key, "task-killed:t-3");

        // 系统优雅形态（via_force=false 但来源=引擎终止）→ 推
        let killed_graceful = AgentEvent::TaskKilled {
            session_id: "s-7".to_string(),
            task_id: "t-3".to_string(),
            via_force: false,
            diagnostics: None,
        };
        let intent = push_intent_with_kill_source(
            &killed_graceful,
            &ctx(),
            Some(RunTerminationSource::EngineTerminated),
        )
        .expect("系统终止任务必须推");
        assert_eq!(intent.dedupe_key, "task-killed:t-3");

        // 注入 None = push_intent 等价（来源未知回退 via_force 近似）
        assert_eq!(
            push_intent_with_kill_source(&killed_graceful, &ctx(), None),
            push_intent(&killed_graceful, &ctx()),
            "注入 None 与默认函数行为一致"
        );
    }

    #[test]
    fn s9a_timer_fired_p1() {
        let event = AgentEvent::TimerFired {
            session_id: "s-7".to_string(),
            timer_id: "timer-1".to_string(),
            prompt: "请检查任务进度".to_string(),
            fired_at_ms: 1_786_214_700_000,
        };
        let intent = push_intent(&event, &ctx()).expect("S9a 必须推");
        assert_eq!(intent.scene, SceneId::TimerFired);
        assert_eq!(intent.level, PushLevel::P1Important);
        assert_eq!(intent.dedupe_key, "timer-fired:timer-1");
        assert_eq!(intent.collapse_key, "timer:timer-1");
        assert_eq!(intent.payload.digest.as_deref(), Some("请检查任务进度"));
    }

    #[test]
    fn s9b_cron_fired_p1() {
        let event = AgentEvent::CronFired {
            session_id: "s-7".to_string(),
            cron_id: "cron-2".to_string(),
            prompt: "日报生成".to_string(),
            expression: "0 9 * * *".to_string(),
            iteration: 3,
            fired_at_ms: 1_786_214_700_000,
        };
        let intent = push_intent(&event, &ctx()).expect("S9b 必须推");
        assert_eq!(intent.scene, SceneId::CronFired);
        assert_eq!(intent.level, PushLevel::P1Important);
        assert_eq!(intent.dedupe_key, "cron-fired:cron-2:3");
        assert_eq!(intent.collapse_key, "cron:cron-2");
    }

    #[test]
    fn s10a_runtime_error_p0() {
        let event = AgentEvent::RuntimeError {
            session_id: "s-7".to_string(),
            timestamp: "2026-08-13T10:00:00Z".to_string(),
            error: "provider 429 限流".to_string(),
            retryable: Some(true),
        };
        let intent =
            push_intent(&event, &ctx_with_run("run-42")).expect("S10a 必须推");
        assert_eq!(intent.scene, SceneId::RuntimeError);
        assert_eq!(intent.level, PushLevel::P0Critical);
        assert_eq!(intent.dedupe_key, "runtime-error:run-42");

        // 信封 runId 缺失 → session 回退键（不 panic）
        let fallback = push_intent(&event, &ctx()).expect("S10a runId 缺失仍推");
        assert_eq!(fallback.dedupe_key, "runtime-error:session:s-7");
    }

    #[test]
    fn s10b_intervention_required_p0() {
        let event = AgentEvent::RuntimeInterventionRequired {
            session_id: "s-7".to_string(),
            timestamp: "2026-08-13T10:00:00Z".to_string(),
            reason: "缺少 API 密钥".to_string(),
            choices: vec!["设置密钥".to_string(), "跳过".to_string()],
            message: "请选择".to_string(),
        };
        let intent = push_intent(&event, &ctx_with_run("run-42")).expect("S10b 必须推");
        assert_eq!(intent.scene, SceneId::InterventionRequired);
        assert_eq!(intent.level, PushLevel::P0Critical);
        assert_eq!(intent.dedupe_key, "intervention:run-42");
        assert_eq!(intent.payload.digest.as_deref(), Some("缺少 API 密钥"));
    }

    #[test]
    fn s11_security_blocked_purged_p0() {
        let blocked = push_intent(
            &security_audit(SecurityAuditDecision::Blocked, Some("tc-9f4b")),
            &ctx(),
        )
        .expect("S11 blocked 必须推");
        assert_eq!(blocked.scene, SceneId::SecurityBlocked);
        assert_eq!(blocked.level, PushLevel::P0Critical);
        assert_eq!(blocked.dedupe_key, "security-audit:tc-9f4b");
        assert_eq!(blocked.target, PushTargetScreen::Audit);

        let purged = push_intent(
            &security_audit(SecurityAuditDecision::Purged, Some("tc-9f4c")),
            &ctx(),
        )
        .expect("S11 purged 必须推");
        assert_eq!(purged.dedupe_key, "security-audit:tc-9f4c");

        // 无 tool_call_id → sequence 回退（Z0 §4.12：security-audit:{sequence}）
        let seq_ctx = PushIntentCtx {
            envelope_run_id: None,
            sequence: Some(112),
        };
        let fallback =
            push_intent(&security_audit(SecurityAuditDecision::Blocked, None), &seq_ctx)
                .expect("S11 sequence 回退");
        assert_eq!(fallback.dedupe_key, "security-audit:seq:112");

        // 不推子集：approved/denied/redirected/restored
        for decision in [
            SecurityAuditDecision::Approved,
            SecurityAuditDecision::Denied,
            SecurityAuditDecision::Redirected,
            SecurityAuditDecision::Restored,
        ] {
            assert_eq!(
                push_intent(&security_audit(decision, Some("tc-1")), &ctx()),
                None,
                "S11 不推子集：{decision:?}"
            );
        }
    }

    #[test]
    fn s12_cache_waste_alert_p2() {
        let event = AgentEvent::CacheWasteAlert {
            session_id: "s-7".to_string(),
            timestamp: "2026-08-13T10:00:00Z".to_string(),
            attribution: MissAttribution::IdleTtlExpired,
            missed_tokens: 24_000,
            idle_ms: 3_600_000,
            model_changed: false,
            missed_cost_usd: Some(0.12),
        };
        let intent = push_intent(&event, &ctx_with_run("run-42")).expect("S12 必须推");
        assert_eq!(intent.scene, SceneId::CacheWasteAlert);
        assert_eq!(intent.level, PushLevel::P2Collapsible);
        assert_eq!(intent.dedupe_key, "cache-waste-alert:run-42");

        let fallback = push_intent(&event, &ctx()).expect("S12 runId 缺失仍推");
        assert_eq!(fallback.dedupe_key, "cache-waste-alert:session:s-7");
    }

    /// P3 负例：过程态/增量/诊断/低价值/恢复域/goal 域一律不推
    #[test]
    fn p3_no_push_events() {
        let no_push: Vec<AgentEvent> = vec![
            AgentEvent::AgentStart {
                session_id: "s-7".to_string(),
                timestamp: "t".to_string(),
            },
            AgentEvent::AgentEnd {
                session_id: "s-7".to_string(),
                timestamp: "t".to_string(),
                reason: AgentEndReason::Stop,
                error: None,
            },
            AgentEvent::TurnStart {
                session_id: "s-7".to_string(),
                turn_index: 1,
                timestamp: "t".to_string(),
            },
            AgentEvent::TurnEnd {
                session_id: "s-7".to_string(),
                turn_index: 1,
                timestamp: "t".to_string(),
                tool_call_count: 0,
                usage: None,
            },
            AgentEvent::SteeringEvaluated {
                session_id: "s-7".to_string(),
                timestamp: "t".to_string(),
                phase: "empty-response".to_string(),
                hit_strategies: vec![],
                steering_count_before: 0,
                steering_count_after: 0,
                budget_remaining: None,
                reset: false,
            },
            AgentEvent::ContextCompressionStart {
                session_id: "s-7".to_string(),
                timestamp: "t".to_string(),
                reason: "超长".to_string(),
                tokens_before: 10,
            },
            AgentEvent::CacheStatsUpdated {
                session_id: "s-7".to_string(),
                timestamp: "t".to_string(),
                stats: RunCacheStats::default(),
            },
            AgentEvent::ColdCacheWarning {
                session_id: "s-7".to_string(),
                timestamp: "t".to_string(),
                ttl_seconds: 60,
                idle_ms: 100,
                resend_estimate_tokens: 5,
            },
            AgentEvent::SubagentStarted {
                session_id: "s-7".to_string(),
                subagent_id: "sa-1".to_string(),
                subagent_run_id: "sa-1-run".to_string(),
                role: "分析".to_string(),
                capability_mode: "readonly".to_string(),
                started_at: "t".to_string(),
                description: None,
                mode: None,
                parent_tool_call_id: None,
                subagent_session_id: None,
            },
            AgentEvent::SubagentEvent {
                session_id: "s-7".to_string(),
                subagent_id: "sa-1".to_string(),
                subagent_run_id: "sa-1-run".to_string(),
                event: SubagentEventPayload {
                    kind: SubagentEventKind::Progress,
                    payload: None,
                },
            },
            AgentEvent::TaskOutput {
                session_id: "s-7".to_string(),
                task_id: "t-1".to_string(),
                line: Some("hello".to_string()),
                chunk: None,
                line_count: Some(1),
            },
            AgentEvent::TaskHeartbeat {
                session_id: "s-7".to_string(),
                task_id: "t-1".to_string(),
                resource: serde_json::json!({"cpu": 1}),
            },
            AgentEvent::TimerCancelled {
                session_id: "s-7".to_string(),
                timer_id: "timer-1".to_string(),
                reason: "early-exit".to_string(),
                cancelled_at_ms: 100,
            },
            AgentEvent::RecoveryEscalated {
                session_id: "s-7".to_string(),
                subagent_run_id: Some("sa-1-run".to_string()),
                kind: "Timeout".to_string(),
                retries: 2,
                elapsed_ms: 100,
                detail: None,
            },
            AgentEvent::RecoverySteering {
                session_id: "s-7".to_string(),
                subagent_id: "sa-1".to_string(),
                subagent_run_id: "sa-1-run".to_string(),
                fingerprint: "fp-1".to_string(),
                retries: 2,
                remaining_status: "pending".to_string(),
                pending: true,
                created_at_ms: 100,
            },
            AgentEvent::RecoveryFork {
                session_id: "s-7".to_string(),
                fingerprint: "fp-1".to_string(),
                subagent_id: "sa-1".to_string(),
                from_run_id: "r1".to_string(),
                from_leaf_id: "l1".to_string(),
                new_run_id: "r2".to_string(),
                new_leaf_id: "l2".to_string(),
                context_mode: "verbatim".to_string(),
            },
            AgentEvent::RecoveryReport {
                session_id: "s-7".to_string(),
                subagent_id: "sa-1".to_string(),
                subagent_run_id: "sa-1-run".to_string(),
                stuck_at_ms: 100,
                suggestion: "人工检查".to_string(),
            },
            AgentEvent::RecoveryBudgetDenied {
                session_id: "s-7".to_string(),
                subagent_run_id: Some("sa-1-run".to_string()),
                fingerprint: "fp-1".to_string(),
                count: 3,
                max: 5,
            },
            AgentEvent::GoalRoundStarted {
                round: 1,
                max_rounds: 5,
                goal: "修复 bug".to_string(),
            },
            AgentEvent::GoalRoundCompleted {
                round: 1,
                tool_call_count: 2,
                tool_success_count: 1,
                message_count: 3,
                decision: "Continue".to_string(),
                reason_detail: "继续".to_string(),
                stalled_delta: 0,
                evidence: "".to_string(),
            },
            AgentEvent::GoalContinuationDecided {
                action: "continue".to_string(),
                reason: "未完成".to_string(),
                prompt: None,
                progress_signature: None,
                detail: None,
            },
        ];
        for event in no_push {
            assert_eq!(
                push_intent(&event, &ctx()),
                None,
                "P3 事件不应产生推送意图：{}",
                event.type_name()
            );
        }
    }

    #[test]
    fn dedupe_key_format() {
        assert_eq!(dedupe_key("approval-requested", "tc-1"), "approval-requested:tc-1");
        assert_eq!(dedupe_key("run-terminal", "run-42:failed"), "run-terminal:run-42:failed");
    }
}
