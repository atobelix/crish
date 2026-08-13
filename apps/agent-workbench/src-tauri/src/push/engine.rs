//! 决策引擎（R3-01：push-core 管线状态机）
//!
//! 管线（对齐 D7 §6.1 / M8 §3.2.1）：
//!
//! ```text
//! AgentEvent (49 变体)
//!   │  [intent] push_intent → Option<PushIntent>   场景筛选（18 行登记表）
//!   │  [suppress] S10a 双推抑制（run-failed 后 30min 不再推 runtime-error）
//!   │  [quiet] quiet_hours_policy                   P0 仍发 / P1 折叠夜间摘要 / P2 不推
//!   │  [dedupe] DedupeState.check_and_record        24h TTL（审批键持久化注记）
//!   │  [coalesce] CoalesceState                     60s/10min 窗口合并（桶 + 关闭信号）
//!   │  [throttle] ThrottleTracker                   每分钟 ≤2 / 每 10min ≤3 / 每日 ≤50
//!   ▼ PushDecision { deliver, scene, level, severity, dedupe_key, payload, outcome }
//! ```
//!
//! 使用方式（装配注记，R3-02/03 接线）：
//! - `decide()` 逐事件调用（`PushAwareEmitter` 旁路，D7 §9.2 方案 a）；
//! - `flush()` 周期 drain（对齐 main.rs:430-441 的 500ms drain 先例）——
//!   窗口未到期的合并桶由 flush 到点产出；
//! - `tool-batch-end` 事件作为审批桶的**批次关闭信号**（审批「全组先发」，
//!   无需等 60s 窗口）；
//! - 输出 `deliver=true` 的决策 → R3-02 WS 直推 / R3-03 厂商发送器；
//!   [crate::push::intent::PayloadDigest] 是 `push/copy.rs` 文案渲染输入契约。
//!
//! 审批持久化注记：S1/S2 去重键与重推阶梯必须落 SQLite
//! `push_pending_approvals` / `push_events_dedupe`（D7 §8.2），本任务交付
//! [crate::push::dedupe::DedupeBackend] 接口与内存实现，SQLite 后端 R3-02/03 接线。

use conex_types::events::AgentEvent;

use super::coalesce::{CoalesceState, CoalesceWindows, MergedPush, PendingPush};
use super::dedupe::DedupeState;
use super::intent::{PushIntent, PushIntentCtx};
use super::quiet::{quiet_hours_policy, QuietHoursConfig, QuietPolicy};
use super::scenes::SceneId;
use super::throttle::{ThrottleDecision, ThrottleLimits, ThrottleTracker};
use super::{PushLevel, PushSeverity};

/// S10a 双推抑制窗口（D7 §3.3 S10a：run-terminal(failed) 到达后
/// 30 分钟内不再推 runtime-error）
pub const S10A_SUPPRESS_MS: u64 = 30 * 60_000;

/// 决策引擎配置（R3-01；R3-02/03 接线时从设置面装配）
#[derive(Debug, Clone)]
pub struct EngineConfig {
    /// 静默时段配置（默认 22:30-07:30）
    pub quiet: QuietHoursConfig,
    /// 节流护栏（每分钟 ≤2 / 每 10min ≤3 / 每日 ≤50）
    pub limits: ThrottleLimits,
    /// 合并窗口（60s / 10min）
    pub windows: CoalesceWindows,
    /// 去重 TTL（默认 24h）
    pub dedupe_ttl_ms: u64,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            quiet: QuietHoursConfig::default(),
            limits: ThrottleLimits::default(),
            windows: CoalesceWindows::default(),
            dedupe_ttl_ms: super::dedupe::DEDUPE_TTL_MS,
        }
    }
}

/// 决策结果（管线输出；R3-02/03 的输入契约）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushDecision {
    /// 是否放行投递（false = 各环节抑制/折叠）
    pub deliver: bool,
    /// 命中场景（登记表行）
    pub scene: SceneId,
    /// 推送级别（P0/P1/P2）
    pub level: PushLevel,
    /// schema severity（critical/important/normal）
    pub severity: PushSeverity,
    /// 去重键（单条 = 场景键；合并 = merged 键）
    pub dedupe_key: String,
    /// 载荷摘要（copy 层输入）
    pub payload: super::intent::PayloadDigest,
    /// 决策来源（intent/dedupe/quiet/throttle/coalesce 各环节）
    pub outcome: DecisionOutcome,
}

/// 决策来源标注（管线各环节产出；测试断言与审计用）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecisionOutcome {
    /// 正常放行（单条直发）
    Delivered,
    /// 合并/关闭信号产出（含单条 run 完成合并形态）
    Coalesced,
    /// 去重命中（TTL 内已推；含 S10a 双推抑制）
    DedupeSuppressed,
    /// 静默时段折叠进夜间摘要（P1）
    FoldedToNightSummary,
    /// 静默时段不推（P2）
    QuietSkipped,
    /// 节流超限折叠进摘要
    Throttled,
}

/// 决策引擎（管线状态机：去重 → 合并 → 静默 → 节流；时钟注入可测）
pub struct PushDecisionEngine {
    dedupe: DedupeState,
    coalesce: CoalesceState,
    throttle: ThrottleTracker,
    quiet_cfg: QuietHoursConfig,
    /// run-terminal(failed) 时刻表（runId → epoch ms；S10a 双推抑制）
    run_failed_at: std::collections::HashMap<String, u64>,
}

impl PushDecisionEngine {
    /// 用配置构造（默认内存去重后端）
    pub fn new(cfg: EngineConfig) -> Self {
        Self {
            dedupe: DedupeState::new(
                Box::new(super::dedupe::MemoryDedupeBackend::new()),
                cfg.dedupe_ttl_ms,
            ),
            coalesce: CoalesceState::new(cfg.windows),
            throttle: ThrottleTracker::new(cfg.limits),
            quiet_cfg: cfg.quiet,
            run_failed_at: std::collections::HashMap::new(),
        }
    }

    /// 逐事件决策。
    ///
    /// 返回 `Vec` 语义：多数事件 0..=1 条决策；`tool-batch-end`（P3 事件，
    /// 审批批次关闭信号）可产出 1 条合并决策。
    pub fn decide(&mut self, event: &AgentEvent, ctx: &PushIntentCtx, now_ms: u64) -> Vec<PushDecision> {
        // 批次关闭信号：审批「全组先发」，批次结束即提前出桶
        if let AgentEvent::ToolBatchEnd { session_id, .. } = event {
            return self
                .coalesce
                .close_approvals(session_id, now_ms)
                .into_iter()
                .map(|merged| self.finalize_merged(merged, now_ms))
                .collect();
        }

        let Some(intent) = super::intent::push_intent(event, ctx) else {
            return Vec::new();
        };

        // 1. S10a 双推抑制：run-failed 后 30min 内不再推 runtime-error
        if intent.scene == SceneId::RuntimeError {
            if let Some(&failed_at) = self.run_failed_at.get(&intent.payload.biz_key) {
                if now_ms.saturating_sub(failed_at) < S10A_SUPPRESS_MS {
                    return vec![self.decision_from_intent(
                        &intent,
                        false,
                        DecisionOutcome::DedupeSuppressed,
                    )];
                }
            }
        }

        // 2. 静默时段（P0 仍发 / P1 折叠 / P2 不推）
        match quiet_hours_policy(intent.level, now_ms, &self.quiet_cfg) {
            QuietPolicy::InQuietSkip => {
                return vec![self.decision_from_intent(&intent, false, DecisionOutcome::QuietSkipped)];
            }
            QuietPolicy::InQuietFoldNight => {
                // 夜间摘要折叠表（push_night_summary）持久化由 R3-02/03 接线
                return vec![self.decision_from_intent(
                    &intent,
                    false,
                    DecisionOutcome::FoldedToNightSummary,
                )];
            }
            QuietPolicy::InQuietDeliver | QuietPolicy::OutsideDeliver => {}
        }

        // 3. 去重（RunCompleted 例外：单条形态的去重键即原事件键，由
        //    close_run 产物统一处理，避免「先记录后复查」自抑制）
        if intent.scene != SceneId::RunCompleted {
            if !self.dedupe.check_and_record(&intent.dedupe_key, now_ms) {
                return vec![self.decision_from_intent(&intent, false, DecisionOutcome::DedupeSuppressed)];
            }
        }

        // 4. 合并路由（累积族入桶 / 关闭信号当场产出 / 其余直发）
        match intent.scene {
            SceneId::SubagentCompleted | SceneId::ApprovalRequested | SceneId::CronFired => {
                self.coalesce.push(self.pending_from(&intent, ctx, now_ms));
                return Vec::new();
            }
            SceneId::TaskSuspicious => {
                // 卡死标记（供「卡死已失败」合并）；本条仍立即下发
                self.coalesce
                    .record_suspicious(&intent.payload.biz_key, now_ms);
            }
            SceneId::TaskFailed => {
                if let Some(merged) = self.coalesce.push(self.pending_from(&intent, ctx, now_ms)) {
                    return vec![self.finalize_merged(merged, now_ms)];
                }
                return Vec::new();
            }
            SceneId::RunCompleted => {
                let merged = self.coalesce.close_run(self.pending_from(&intent, ctx, now_ms));
                // 合并形态补记原事件键（防同一 run-terminal 重放二次下发）
                if merged.count > 1 {
                    self.dedupe.check_and_record(&intent.dedupe_key, now_ms);
                }
                return vec![self.finalize_merged(merged, now_ms)];
            }
            _ => {}
        }

        // 5. 单条直发（S4 记录 run-failed 时刻，供 S10a 抑制）
        if intent.scene == SceneId::RunFailed {
            self.run_failed_at.insert(intent.payload.biz_key.clone(), now_ms);
            self.prune_run_failed(now_ms);
        }
        self.finalize_intent(&intent, now_ms)
    }

    /// 周期 drain：产出窗口到期的合并桶（对齐 main.rs:430-441 的 500ms
    /// drain 先例；R3-02/03 装配在 drain loop 中调用）
    pub fn flush(&mut self, now_ms: u64) -> Vec<PushDecision> {
        self.coalesce
            .flush(now_ms)
            .into_iter()
            .map(|merged| self.finalize_merged(merged, now_ms))
            .collect()
    }

    /// 强制 drain 全部桶（应用退出/会话切换兜底；正常运行请用 [Self::flush]）
    pub fn flush_all(&mut self, now_ms: u64) -> Vec<PushDecision> {
        self.coalesce
            .flush_all(now_ms)
            .into_iter()
            .map(|merged| self.finalize_merged(merged, now_ms))
            .collect()
    }

    /// 显式清理去重表过期条目（周期维护可选）
    pub fn prune_dedupe(&mut self, now_ms: u64) {
        self.dedupe.prune(now_ms);
    }

    /// 单条直发收尾：节流判定 + 决策组装
    fn finalize_intent(&mut self, intent: &PushIntent, now_ms: u64) -> Vec<PushDecision> {
        match self.throttle.check(&intent.payload.session_id, now_ms) {
            ThrottleDecision::Allow => {
                vec![self.decision_from_intent(intent, true, DecisionOutcome::Delivered)]
            }
            ThrottleDecision::FoldIntoSummary => {
                vec![self.decision_from_intent(intent, false, DecisionOutcome::Throttled)]
            }
        }
    }

    /// 合并推送收尾：merged 键去重（键含首条时刻，窗口唯一）+ 节流
    fn finalize_merged(&mut self, merged: MergedPush, now_ms: u64) -> PushDecision {
        if !self.dedupe.check_and_record(&merged.dedupe_key, now_ms) {
            return self.decision_from_merged(&merged, false, DecisionOutcome::DedupeSuppressed);
        }
        match self.throttle.check(&merged.session_id, now_ms) {
            ThrottleDecision::Allow => {
                self.decision_from_merged(&merged, true, DecisionOutcome::Coalesced)
            }
            ThrottleDecision::FoldIntoSummary => {
                self.decision_from_merged(&merged, false, DecisionOutcome::Throttled)
            }
        }
    }

    /// 意图 → 合并桶输入（组合键按场景族：子代理按父 run / 审批按 session /
    /// cron 按 cronId / task-failed 按 session + 卡死键 taskId）
    fn pending_from(&self, intent: &PushIntent, ctx: &PushIntentCtx, now_ms: u64) -> PendingPush {
        let group_key = match intent.scene {
            SceneId::SubagentCompleted => {
                // 子代理按父 run 归组（信封 runId；缺失回退子代理 id，不合并）
                ctx.envelope_run_id
                    .clone()
                    .unwrap_or_else(|| intent.payload.biz_key.clone())
            }
            SceneId::ApprovalRequested | SceneId::TaskFailed => intent.payload.session_id.clone(),
            SceneId::CronFired => intent.payload.biz_key.clone(),
            _ => intent.payload.biz_key.clone(),
        };
        let suspicious_key = match intent.scene {
            SceneId::TaskFailed => Some(intent.payload.biz_key.clone()),
            _ => None,
        };
        PendingPush {
            scene: intent.scene,
            session_id: intent.payload.session_id.clone(),
            dedupe_key: intent.dedupe_key.clone(),
            group_key,
            suspicious_key,
            arrived_at_ms: now_ms,
            digest: intent.payload.clone(),
        }
    }

    fn decision_from_intent(
        &self,
        intent: &PushIntent,
        deliver: bool,
        outcome: DecisionOutcome,
    ) -> PushDecision {
        PushDecision {
            deliver,
            scene: intent.scene,
            level: intent.level,
            severity: intent.level.severity(),
            dedupe_key: intent.dedupe_key.clone(),
            payload: intent.payload.clone(),
            outcome,
        }
    }

    fn decision_from_merged(
        &self,
        merged: &MergedPush,
        deliver: bool,
        outcome: DecisionOutcome,
    ) -> PushDecision {
        PushDecision {
            deliver,
            scene: merged.scene,
            level: merged.scene.level(),
            severity: merged.scene.level().severity(),
            dedupe_key: merged.dedupe_key.clone(),
            payload: merged.digest.clone(),
            outcome,
        }
    }

    /// 清理过期的 run-failed 时刻（超过 30min 抑制窗口即失效）
    fn prune_run_failed(&mut self, now_ms: u64) {
        self.run_failed_at
            .retain(|_, at| now_ms.saturating_sub(*at) < S10A_SUPPRESS_MS);
    }
}

impl Default for PushDecisionEngine {
    fn default() -> Self {
        Self::new(EngineConfig::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_types::events::{
        PermissionRequest, RunTerminalStatus, SecurityAuditDecision, SecurityAuditOperation,
        SubagentEndStatus, ToolMetadata,
    };
    use conex_types::impact::ImpactAssessment;

    /// 基准时刻：2026-08-10 12:00:00 UTC（非静默）
    const T0: u64 = 1_786_276_800_000;

    fn ctx() -> PushIntentCtx {
        PushIntentCtx::default()
    }

    fn ctx_run(run_id: &str) -> PushIntentCtx {
        PushIntentCtx {
            envelope_run_id: Some(run_id.to_string()),
            sequence: None,
        }
    }

    fn approval(tool_call_id: &str) -> AgentEvent {
        AgentEvent::ApprovalRequested {
            session_id: "s-7".to_string(),
            timestamp: "t".to_string(),
            request: PermissionRequest {
                id: "req-1".to_string(),
                session_id: "s-7".to_string(),
                cwd: "C:\\workspace".to_string(),
                tool_call_id: tool_call_id.to_string(),
                tool_name: "bash".to_string(),
                parameters: serde_json::json!({}),
                summary: "执行部署脚本".to_string(),
                tool_metadata: ToolMetadata::default(),
                metadata: None,
                requester_run_id: None,
                reason: None,
            },
        }
    }

    fn run_terminal(run_id: &str, terminal: RunTerminalStatus) -> AgentEvent {
        AgentEvent::RunTerminal {
            session_id: "s-7".to_string(),
            run_id: run_id.to_string(),
            timestamp: "t".to_string(),
            terminal,
            error: None,
        }
    }

    fn subagent_completed(id: &str) -> AgentEvent {
        AgentEvent::SubagentEnded {
            session_id: "s-7".to_string(),
            subagent_id: id.to_string(),
            subagent_run_id: format!("{id}-run"),
            status: SubagentEndStatus::Completed,
            summary: None,
            ended_at: "t".to_string(),
        }
    }

    fn task_failed(task_id: &str) -> AgentEvent {
        AgentEvent::TaskFailed {
            session_id: "s-7".to_string(),
            task_id: task_id.to_string(),
            exit_code: 1,
            tail: vec![],
            duration_ms: 100,
        }
    }

    fn task_suspicious(task_id: &str) -> AgentEvent {
        AgentEvent::TaskSuspicious {
            session_id: "s-7".to_string(),
            task_id: task_id.to_string(),
            silence_ms: 120_000,
            last_output_at_ms: T0,
        }
    }

    fn runtime_error() -> AgentEvent {
        AgentEvent::RuntimeError {
            session_id: "s-7".to_string(),
            timestamp: "t".to_string(),
            error: "provider 429".to_string(),
            retryable: Some(true),
        }
    }

    fn batch_end() -> AgentEvent {
        AgentEvent::ToolBatchEnd {
            session_id: "s-7".to_string(),
            batch_id: "b-1".to_string(),
            timestamp: "t".to_string(),
            calls: vec![],
        }
    }

    #[test]
    fn approval_delivered_on_batch_close() {
        let mut engine = PushDecisionEngine::default();
        // 审批入桶（累积族）
        assert!(engine.decide(&approval("tc-1"), &ctx(), T0).is_empty());
        assert!(engine.decide(&approval("tc-2"), &ctx(), T0 + 100).is_empty());
        // tool-batch-end 关闭信号 → 合并出桶
        let out = engine.decide(&batch_end(), &ctx(), T0 + 200);
        assert_eq!(out.len(), 1);
        let decision = &out[0];
        assert!(decision.deliver);
        assert_eq!(decision.scene, SceneId::ApprovalRequested);
        assert_eq!(decision.level, PushLevel::P0Critical);
        assert_eq!(decision.severity, PushSeverity::Critical);
        assert_eq!(decision.outcome, DecisionOutcome::Coalesced);
        assert!(decision.dedupe_key.starts_with("merged:approval-requested:s-7:"));
    }

    #[test]
    fn approval_batch_close_without_bucket_noop() {
        let mut engine = PushDecisionEngine::default();
        assert!(engine.decide(&batch_end(), &ctx(), T0).is_empty());
    }

    #[test]
    fn p0_direct_scene_delivers_immediately() {
        let mut engine = PushDecisionEngine::default();
        let out = engine.decide(&task_suspicious("t-1"), &ctx(), T0);
        assert_eq!(out.len(), 1);
        let decision = &out[0];
        assert!(decision.deliver);
        assert_eq!(decision.scene, SceneId::TaskSuspicious);
        assert_eq!(decision.outcome, DecisionOutcome::Delivered);
    }

    #[test]
    fn dedupe_suppresses_replay() {
        let mut engine = PushDecisionEngine::default();
        engine.decide(&task_suspicious("t-1"), &ctx(), T0);
        let replay = engine.decide(&task_suspicious("t-1"), &ctx(), T0 + 1_000);
        assert_eq!(replay.len(), 1);
        assert!(!replay[0].deliver);
        assert_eq!(replay[0].outcome, DecisionOutcome::DedupeSuppressed);
    }

    #[test]
    fn quiet_hours_folds_p1_skips_p2_delivers_p0() {
        // 静默时段：23:00（UTC 分钟 1380，基准 T0 分钟 720 + 11h）
        let quiet_ms = T0 + 11 * 3_600_000;
        let mut engine = PushDecisionEngine::default();

        // P1 run 完成 → 折叠夜间摘要
        let out = engine.decide(&run_terminal("run-1", RunTerminalStatus::Completed), &ctx(), quiet_ms);
        assert_eq!(out[0].outcome, DecisionOutcome::FoldedToNightSummary);
        assert!(!out[0].deliver);

        // P0 审批请求（非合并族）→ 仍发（静默可选静音由移动端决定）
        let p0 = engine.decide(&task_suspicious("t-2"), &ctx(), quiet_ms);
        assert!(p0[0].deliver);
        assert_eq!(p0[0].outcome, DecisionOutcome::Delivered);

        // P2 缓存告警 → 静默不推（先构造事件）
        let cache = AgentEvent::CacheWasteAlert {
            session_id: "s-7".to_string(),
            timestamp: "t".to_string(),
            attribution: conex_types::events::MissAttribution::Cold,
            missed_tokens: 24_000,
            idle_ms: 100,
            model_changed: false,
            missed_cost_usd: Some(0.1),
        };
        let p2 = engine.decide(&cache, &ctx_run("run-9"), quiet_ms);
        assert!(!p2[0].deliver);
        assert_eq!(p2[0].outcome, DecisionOutcome::QuietSkipped);
    }

    #[test]
    fn throttle_folds_third_push_in_minute() {
        let mut engine = PushDecisionEngine::default();
        // 直接单条场景（避开合并族）
        assert!(engine.decide(&task_suspicious("t-1"), &ctx(), T0)[0].deliver);
        assert!(engine.decide(&task_suspicious("t-2"), &ctx(), T0 + 1_000)[0].deliver);
        let third = engine.decide(&task_suspicious("t-3"), &ctx(), T0 + 2_000);
        assert!(!third[0].deliver);
        assert_eq!(third[0].outcome, DecisionOutcome::Throttled);
    }

    #[test]
    fn run_failed_suppresses_runtime_error_30min() {
        let mut engine = PushDecisionEngine::default();
        // run 失败（P0 直发）
        let failed = engine.decide(&run_terminal("run-42", RunTerminalStatus::Failed), &ctx(), T0);
        assert!(failed[0].deliver);
        // 30min 内的 runtime-error → 抑制（避免与 S4 双推）
        let err = engine.decide(&runtime_error(), &ctx_run("run-42"), T0 + 10 * 60_000);
        assert!(!err[0].deliver);
        assert_eq!(err[0].outcome, DecisionOutcome::DedupeSuppressed);
        // 超过 30min → 恢复推送
        let late = engine.decide(&runtime_error(), &ctx_run("run-42"), T0 + 31 * 60_000);
        assert!(late[0].deliver);
    }

    #[test]
    fn run_completed_merges_subagents() {
        let mut engine = PushDecisionEngine::default();
        engine.decide(&subagent_completed("sa-1"), &ctx_run("run-42"), T0);
        engine.decide(&subagent_completed("sa-2"), &ctx_run("run-42"), T0 + 100);
        let out = engine.decide(&run_terminal("run-42", RunTerminalStatus::Completed), &ctx(), T0 + 30_000);
        assert_eq!(out.len(), 1);
        let decision = &out[0];
        assert!(decision.deliver);
        assert_eq!(decision.scene, SceneId::RunCompleted);
        assert_eq!(decision.outcome, DecisionOutcome::Coalesced);
        assert!(decision.dedupe_key.starts_with("merged:run-completed:run-42:"));
    }

    #[test]
    fn run_completed_replay_suppressed() {
        let mut engine = PushDecisionEngine::default();
        engine.decide(&run_terminal("run-1", RunTerminalStatus::Completed), &ctx(), T0);
        // 重放同一事件 → 去重抑制（单条形态键 = 原事件键）
        let replay = engine.decide(&run_terminal("run-1", RunTerminalStatus::Completed), &ctx(), T0 + 1_000);
        assert_eq!(replay[0].outcome, DecisionOutcome::DedupeSuppressed);
    }

    #[test]
    fn suspicious_then_failed_merges() {
        let mut engine = PushDecisionEngine::default();
        engine.decide(&task_suspicious("t-12"), &ctx(), T0);
        // 5min 后 task-failed → 合并产出「卡死已失败」
        let out = engine.decide(&task_failed("t-12"), &ctx(), T0 + 300_000);
        assert_eq!(out.len(), 1);
        assert!(out[0].deliver);
        assert_eq!(out[0].scene, SceneId::TaskFailed);
        assert_eq!(out[0].outcome, DecisionOutcome::Coalesced);
    }

    #[test]
    fn cron_accumulates_then_flush() {
        let mut engine = PushDecisionEngine::default();
        let cron = |iteration: u64| AgentEvent::CronFired {
            session_id: "s-7".to_string(),
            cron_id: "cron-2".to_string(),
            prompt: "日报".to_string(),
            expression: "0 9 * * *".to_string(),
            iteration,
            fired_at_ms: T0,
        };
        assert!(engine.decide(&cron(1), &ctx(), T0).is_empty());
        assert!(engine.decide(&cron(2), &ctx(), T0 + 5 * 60_000).is_empty());
        // 10min 窗口到期 → flush 产出合并
        let out = engine.flush(T0 + 601_000);
        assert_eq!(out.len(), 1);
        assert!(out[0].deliver);
        assert_eq!(out[0].outcome, DecisionOutcome::Coalesced);
        assert!(out[0].dedupe_key.starts_with("merged:cron-fired:cron-2:"));
    }

    #[test]
    fn security_blocked_delivers() {
        let mut engine = PushDecisionEngine::default();
        let audit = AgentEvent::SecurityAudit {
            session_id: "s-7".to_string(),
            timestamp: "t".to_string(),
            operation: SecurityAuditOperation::Delete,
            targets: vec!["C:\\a".to_string()],
            impact: ImpactAssessment::default(),
            decision: SecurityAuditDecision::Blocked,
            permission_mode: None,
            tool_call_id: Some("tc-9".to_string()),
        };
        let out = engine.decide(&audit, &ctx(), T0);
        assert!(out[0].deliver);
        assert_eq!(out[0].scene, SceneId::SecurityBlocked);
    }

    #[test]
    fn p3_events_produce_no_decisions() {
        let mut engine = PushDecisionEngine::default();
        let noise = AgentEvent::TaskOutput {
            session_id: "s-7".to_string(),
            task_id: "t-1".to_string(),
            line: Some("x".to_string()),
            chunk: None,
            line_count: Some(1),
        };
        assert!(engine.decide(&noise, &ctx(), T0).is_empty());
    }

    #[test]
    fn flush_all_drains_pending_buckets() {
        let mut engine = PushDecisionEngine::default();
        engine.decide(&subagent_completed("sa-1"), &ctx_run("run-7"), T0);
        let out = engine.flush_all(T0 + 1_000);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].scene, SceneId::SubagentCompleted);
        assert!(out[0].deliver);
    }
}
