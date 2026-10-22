//! S9–S12 定时器/cron、运行时异常与人工介入、安全拦截、缓存浪费推送意图

use conex_types::events::{AgentEvent, SecurityAuditDecision};

use super::{dedupe_key, run_or_session_key, PayloadDigest, PushIntent, PushIntentCtx};
use crate::push::scenes::SceneId;
use crate::push::{PushLevel, PushTargetScreen};

/// S9–S12 判定（臂体与拆分前 `push_intent_with_kill_source` 同臂逐字一致；runId / sequence
/// 经 `ctx` 信封注入）
pub(super) fn system_intent(event: &AgentEvent, ctx: &PushIntentCtx) -> Option<PushIntent> {
    match event {
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
            session_id, error, ..
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
            session_id, reason, ..
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
                .or_else(|| ctx.sequence.map(|s| format!("seq:{s}")))
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
        // 非本族变体：分发层（mod.rs `push_intent_with_kill_source`）已按事件族
        // 穷尽路由，不会进入本函数；保守按 P3 不推返回 None
        _ => None,
    }
}
