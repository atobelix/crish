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
use super::intent::{PushIntent, PushIntentCtx, RunTerminationSource};
use super::quiet::{
    compose_night_summary, night_summary_date, quiet_hours_policy, NightSummary, NightSummaryItem,
    QuietHoursConfig, QuietPolicy,
};
use super::scenes::SceneId;
use super::throttle::{ThrottleDecision, ThrottleLimits, ThrottleTracker};
use super::{PushLevel, PushSeverity};

/// S10a 双推抑制窗口（D7 §3.3 S10a：run-terminal(failed) 到达后
/// 30 分钟内不再推 runtime-error）
pub const S10A_SUPPRESS_MS: u64 = 30 * 60_000;

/// S8e 任务归属映射最大容量（防常驻进程无界内存增长，ISSUE-14）
pub const MAX_TRACKED_TASK_OWNERS: usize = 1024;

/// S8e Run 终止来源映射最大容量（防常驻进程无界内存增长，ISSUE-14）
pub const MAX_TRACKED_RUN_SOURCES: usize = 1024;

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
    /// S8e 事件流观察（R3-01a 补强）：task_id → 归属 run（task-started 登记，ISSUE-14 有界）
    task_owner_run: std::collections::HashMap<String, String>,
    /// task_owner_run 的 FIFO 插入序队列（超容量淘汰最旧条目）
    task_owner_order: std::collections::VecDeque<String>,
    /// S8e 事件流观察（R3-01a 补强）：run_id → (终止来源, 记录时刻)（run-terminal 登记，ISSUE-14 有界）
    run_term_source: std::collections::HashMap<String, (RunTerminationSource, u64)>,
    /// run_term_source 的 FIFO 插入序队列（超容量淘汰最旧条目）
    run_term_order: std::collections::VecDeque<String>,
    /// 夜间摘要折叠累积（R3-01a 补强：静默时段 P1 折叠条目；
    ///   `push_night_summary` 表持久化接线由 R3-02/03 承担）
    folded: Vec<NightSummaryItem>,
}

impl PushDecisionEngine {
    /// 用配置构造（默认内存去重后端）
    pub fn new(cfg: EngineConfig) -> Self {
        Self::with_dedupe_backend(cfg, Box::new(super::dedupe::MemoryDedupeBackend::new()))
    }

    /// 用配置 + 自定义去重后端构造（R3-01a 补强：注入模式——SQLite 后端
    /// 经此装配，审批键持久化；与 [super::dedupe::DedupeState] 注入同 trait）
    pub fn with_dedupe_backend(
        cfg: EngineConfig,
        backend: Box<dyn super::dedupe::DedupeBackend>,
    ) -> Self {
        Self {
            dedupe: DedupeState::new(backend, cfg.dedupe_ttl_ms),
            coalesce: CoalesceState::new(cfg.windows),
            throttle: ThrottleTracker::new(cfg.limits),
            quiet_cfg: cfg.quiet,
            run_failed_at: std::collections::HashMap::new(),
            task_owner_run: std::collections::HashMap::new(),
            task_owner_order: std::collections::VecDeque::new(),
            run_term_source: std::collections::HashMap::new(),
            run_term_order: std::collections::VecDeque::new(),
            folded: Vec::new(),
        }
    }

    /// 逐事件决策。
    ///
    /// 返回 `Vec` 语义：多数事件 0..=1 条决策；`tool-batch-end`（P3 事件，
    /// 审批批次关闭信号）可产出 1 条合并决策。
    pub fn decide(
        &mut self,
        event: &AgentEvent,
        ctx: &PushIntentCtx,
        now_ms: u64,
    ) -> Vec<PushDecision> {
        // S8e 事件流观察（R3-01a 补强 & ISSUE-14 有界清理）：
        // task-started 登记任务归属 run；task 终态即时释放；run-terminal 登记 run 终止来源
        match event {
            AgentEvent::TaskStarted {
                task_id,
                owner_run_id,
                ..
            } => {
                self.record_task_owner(task_id.clone(), owner_run_id.clone());
            }
            AgentEvent::TaskCompleted { task_id, .. } | AgentEvent::TaskFailed { task_id, .. } => {
                self.task_owner_run.remove(task_id);
            }
            AgentEvent::RunTerminal {
                run_id, terminal, ..
            } => {
                self.record_run_term_source(
                    run_id.clone(),
                    super::intent::run_terminal_source(*terminal),
                    now_ms,
                );
            }
            _ => {}
        }

        // 批次关闭信号：审批「全组先发」，批次结束即提前出桶
        if let AgentEvent::ToolBatchEnd { session_id, .. } = event {
            return self
                .coalesce
                .close_approvals(session_id, now_ms)
                .into_iter()
                .map(|merged| self.finalize_merged(merged, now_ms))
                .collect();
        }

        // S8e：task-killed 来源注入（task → 归属 run → 终止来源；消费后即清理 task_owner_run）
        let kill_source = match event {
            AgentEvent::TaskKilled { task_id, .. } => {
                let source = self
                    .task_owner_run
                    .get(task_id)
                    .and_then(|run_id| self.run_term_source.get(run_id))
                    .map(|(src, _)| *src);
                self.task_owner_run.remove(task_id);
                source
            }
            _ => None,
        };

        let Some(intent) = super::intent::push_intent_with_kill_source(event, ctx, kill_source)
        else {
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
                return vec![self.decision_from_intent(
                    &intent,
                    false,
                    DecisionOutcome::QuietSkipped,
                )];
            }
            QuietPolicy::InQuietFoldNight => {
                // 夜间摘要折叠（R3-01a 补强）：P1 折叠条目入累积桶，
                // 次日静默结束经 [Self::take_night_summary] 合成；
                // `push_night_summary` 表持久化接线由 R3-02/03 承担
                self.folded.push(NightSummaryItem {
                    scene: intent.scene,
                    session_id: intent.payload.session_id.clone(),
                    biz_key: intent.payload.biz_key.clone(),
                    occurred_at_ms: now_ms,
                    digest: intent.payload.digest.clone(),
                });
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
                return vec![self.decision_from_intent(
                    &intent,
                    false,
                    DecisionOutcome::DedupeSuppressed,
                )];
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
                let merged = self
                    .coalesce
                    .close_run(self.pending_from(&intent, ctx, now_ms));
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
            self.run_failed_at
                .insert(intent.payload.biz_key.clone(), now_ms);
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

    /// 最近合并桶到期时刻（供 Notify 驱动 drain loop 计算 sleep 上限）
    pub fn next_expiry_ms(&self, now_ms: u64) -> Option<u64> {
        self.coalesce.next_expiry_ms(now_ms)
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

    /// 夜间摘要合成出桶（R3-01a 补强：D7 §3.4.3 次日静默结束调用）。
    ///
    /// - 取**当日归属**的折叠条目（跨午夜归一静默窗起始日，
    ///   [night_summary_date]）合成 [NightSummary]；
    /// - 空折叠 → `None`（无摘要可发）；
    /// - 去重键 `night-summary:{date}` 落 [DedupeState]（M8 §3.4.3：
    ///   每夜一条；重复调用同日被去重抑制）；
    /// - 其余夜（未到静默结束）的折叠条目保留，下次出桶时再取。
    pub fn take_night_summary(&mut self, now_ms: u64) -> Option<NightSummary> {
        let date = night_summary_date(now_ms, &self.quiet_cfg);
        let mut taken: Vec<NightSummaryItem> = Vec::new();
        let mut keep: Vec<NightSummaryItem> = Vec::new();
        for item in self.folded.drain(..) {
            if night_summary_date(item.occurred_at_ms, &self.quiet_cfg) == date {
                taken.push(item);
            } else {
                keep.push(item);
            }
        }
        self.folded = keep;
        if taken.is_empty() {
            return None;
        }
        let key = format!("night-summary:{date}");
        if !self.dedupe.check_and_record(&key, now_ms) {
            return None;
        }
        Some(compose_night_summary(&taken, &self.quiet_cfg))
    }

    /// 当前折叠累积条数（诊断/测试用）
    pub fn folded_len(&self) -> usize {
        self.folded.len()
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

    fn record_task_owner(&mut self, task_id: String, owner_run_id: String) {
        const MAX_TASK_OWNERS: usize = 1024;
        if self.task_owner_run.len() >= MAX_TASK_OWNERS {
            if let Some(oldest) = self.task_owner_order.pop_front() {
                self.task_owner_run.remove(&oldest);
            }
        }
        self.task_owner_order.push_back(task_id.clone());
        self.task_owner_run.insert(task_id, owner_run_id);
    }

    fn record_run_term_source(&mut self, run_id: String, source: RunTerminationSource, now_ms: u64) {
        const MAX_RUN_TERMS: usize = 1024;
        if self.run_term_source.len() >= MAX_RUN_TERMS {
            if let Some(oldest) = self.run_term_order.pop_front() {
                self.run_term_source.remove(&oldest);
            }
        }
        self.run_term_order.push_back(run_id.clone());
        self.run_term_source.insert(run_id, (source, now_ms));
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
            subagent_session_id: None,
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
        assert!(engine
            .decide(&approval("tc-2"), &ctx(), T0 + 100)
            .is_empty());
        // tool-batch-end 关闭信号 → 合并出桶
        let out = engine.decide(&batch_end(), &ctx(), T0 + 200);
        assert_eq!(out.len(), 1);
        let decision = &out[0];
        assert!(decision.deliver);
        assert_eq!(decision.scene, SceneId::ApprovalRequested);
        assert_eq!(decision.level, PushLevel::P0Critical);
        assert_eq!(decision.severity, PushSeverity::Critical);
        assert_eq!(decision.outcome, DecisionOutcome::Coalesced);
        assert!(decision
            .dedupe_key
            .starts_with("merged:approval-requested:s-7:"));
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
        let out = engine.decide(
            &run_terminal("run-1", RunTerminalStatus::Completed),
            &ctx(),
            quiet_ms,
        );
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
        let failed = engine.decide(
            &run_terminal("run-42", RunTerminalStatus::Failed),
            &ctx(),
            T0,
        );
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
        let out = engine.decide(
            &run_terminal("run-42", RunTerminalStatus::Completed),
            &ctx(),
            T0 + 30_000,
        );
        assert_eq!(out.len(), 1);
        let decision = &out[0];
        assert!(decision.deliver);
        assert_eq!(decision.scene, SceneId::RunCompleted);
        assert_eq!(decision.outcome, DecisionOutcome::Coalesced);
        assert!(decision
            .dedupe_key
            .starts_with("merged:run-completed:run-42:"));
    }

    #[test]
    fn run_completed_replay_suppressed() {
        let mut engine = PushDecisionEngine::default();
        engine.decide(
            &run_terminal("run-1", RunTerminalStatus::Completed),
            &ctx(),
            T0,
        );
        // 重放同一事件 → 去重抑制（单条形态键 = 原事件键）
        let replay = engine.decide(
            &run_terminal("run-1", RunTerminalStatus::Completed),
            &ctx(),
            T0 + 1_000,
        );
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

    // ── R3-01a 补强：S8e 事件流观察（task-started / run-terminal 联动）──

    fn task_started(task_id: &str, owner_run_id: &str) -> AgentEvent {
        AgentEvent::TaskStarted {
            session_id: "s-7".to_string(),
            task_id: task_id.to_string(),
            command: "cargo build".to_string(),
            cwd: "C:\\workspace".to_string(),
            owner_run_id: owner_run_id.to_string(),
            is_daemon: false,
        }
    }

    fn task_killed(task_id: &str, via_force: bool) -> AgentEvent {
        AgentEvent::TaskKilled {
            session_id: "s-7".to_string(),
            task_id: task_id.to_string(),
            via_force,
            diagnostics: None,
        }
    }

    /// S8e 联动矩阵：run 终止来源经事件流观察注入 task-killed 判定
    /// （各用例独立引擎，避免节流护栏（每分钟 ≤2）干扰矩阵断言）
    #[test]
    fn s8e_task_killed_uses_run_terminal_source() {
        // 用户取消 run（Cancelled → UserKilled）：连坐任务 kill 不推
        // （即使 Windows 两阶段升级 via_force=true——精确来源覆盖近似）
        let mut engine = PushDecisionEngine::default();
        engine.decide(&task_started("t-3", "run-42"), &ctx(), T0);
        engine.decide(
            &run_terminal("run-42", RunTerminalStatus::Cancelled),
            &ctx(),
            T0 + 1_000,
        );
        assert!(
            engine
                .decide(&task_killed("t-3", true), &ctx(), T0 + 2_000)
                .is_empty(),
            "用户取消 run 后的任务 kill 不推（来源精确判定覆盖 via_force）"
        );

        // 引擎终止（Failed → EngineTerminated）：watchdog 语义 → 推
        // （即使优雅形态 via_force=false——来源判定优先）
        let mut engine = PushDecisionEngine::default();
        engine.decide(&task_started("t-4", "run-43"), &ctx(), T0);
        engine.decide(
            &run_terminal("run-43", RunTerminalStatus::Failed),
            &ctx(),
            T0 + 1_000,
        );
        let out = engine.decide(&task_killed("t-4", false), &ctx(), T0 + 2_000);
        assert_eq!(out.len(), 1);
        assert!(out[0].deliver);
        assert_eq!(out[0].scene, SceneId::TaskKilled);
        assert_eq!(out[0].outcome, DecisionOutcome::Delivered);

        // 无 run-terminal 记录（来源未知）→ 回退 via_force 近似
        let mut fallback = PushDecisionEngine::default();
        fallback.decide(&task_started("t-5", "run-44"), &ctx(), T0);
        assert!(
            fallback
                .decide(&task_killed("t-5", false), &ctx(), T0 + 2_000)
                .is_empty(),
            "来源未知 + 优雅 → 不推（回退近似）"
        );
        let forced = fallback.decide(&task_killed("t-5", true), &ctx(), T0 + 3_000);
        assert!(forced[0].deliver, "来源未知 + 强制 → 推（回退近似）");
    }

    /// run 完成（EngineTerminated）→ 任务连坐 kill 推
    #[test]
    fn s8e_run_completed_then_task_killed_pushes() {
        let mut engine = PushDecisionEngine::default();
        engine.decide(&task_started("t-6", "run-50"), &ctx(), T0);
        engine.decide(
            &run_terminal("run-50", RunTerminalStatus::Completed),
            &ctx(),
            T0 + 1_000,
        );
        let out = engine.decide(&task_killed("t-6", true), &ctx(), T0 + 2_000);
        assert_eq!(out.len(), 1);
        assert!(out[0].deliver);
        assert_eq!(out[0].dedupe_key, "task-killed:t-6");
    }

    // ── R3-01a 补强：夜间摘要折叠与合成 ──

    /// 静默时段 P1 折叠 → 静默结束出桶合成（跨午夜同夜归一）
    #[test]
    fn night_summary_folds_p1_and_composes_at_quiet_end() {
        let mut engine = PushDecisionEngine::default();
        let evening = T0 + 11 * 3_600_000 + 59 * 60_000; // 08-09 23:59（静默内）
        let midnight = T0 + 12 * 3_600_000 + 30 * 60_000; // 08-10 00:30（跨午夜静默内）

        // P1 run 完成 ×2（一个跨午夜）→ 折叠
        let out1 = engine.decide(
            &run_terminal("run-1", RunTerminalStatus::Completed),
            &ctx(),
            evening,
        );
        assert_eq!(out1[0].outcome, DecisionOutcome::FoldedToNightSummary);
        let out2 = engine.decide(
            &run_terminal("run-2", RunTerminalStatus::Completed),
            &ctx(),
            midnight,
        );
        assert_eq!(out2[0].outcome, DecisionOutcome::FoldedToNightSummary);
        assert_eq!(engine.folded_len(), 2);

        // 07:30 静默结束出桶：跨午夜两条目同属一夜（窗口起始日键）
        let take_at = T0 + 19 * 3_600_000 + 30 * 60_000; // 08-10 07:30
        let summary = engine
            .take_night_summary(take_at)
            .expect("有折叠条目应合成");
        assert_eq!(summary.date, "2026-08-09");
        assert_eq!(summary.total, 2);
        assert_eq!(summary.body, "夜间完成 2 项：任务完成 ×2");
        assert_eq!(engine.folded_len(), 0);

        // 同日重复取 → 无折叠条目 → None（每夜一条幂等）
        assert!(engine.take_night_summary(take_at + 60_000).is_none());
    }

    /// 静默时段 P0 仍发（不折叠）；P2 跳过（不折叠）
    #[test]
    fn night_summary_only_folds_p1() {
        let mut engine = PushDecisionEngine::default();
        let quiet_ms = T0 + 11 * 3_600_000; // 23:00（静默内）

        // P0 任务卡死 → 仍发，不进折叠桶
        let p0 = engine.decide(&task_suspicious("t-1"), &ctx(), quiet_ms);
        assert!(p0[0].deliver);
        assert_eq!(engine.folded_len(), 0);

        // P1 run 完成 → 折叠
        engine.decide(
            &run_terminal("run-1", RunTerminalStatus::Completed),
            &ctx(),
            quiet_ms,
        );
        assert_eq!(engine.folded_len(), 1);

        // P2 缓存告警 → 静默跳过，不进折叠桶
        let cache = AgentEvent::CacheWasteAlert {
            session_id: "s-7".to_string(),
            timestamp: "t".to_string(),
            attribution: conex_types::events::MissAttribution::Cold,
            missed_tokens: 24_000,
            idle_ms: 100,
            model_changed: false,
            missed_cost_usd: Some(0.1),
        };
        engine.decide(&cache, &ctx_run("run-9"), quiet_ms);
        assert_eq!(engine.folded_len(), 1, "仅 P1 折叠");

        let summary = engine
            .take_night_summary(T0 + 19 * 3_600_000 + 30 * 60_000)
            .expect("有折叠条目");
        assert_eq!(summary.total, 1);
        assert_eq!(summary.body, "夜间完成 1 项：任务 run-1 已完成");
    }

    /// 静默内折叠 + 次夜新折叠：按窗口起始日分桶出桶
    #[test]
    fn night_summary_buckets_by_window_start_day() {
        let mut engine = PushDecisionEngine::default();
        // 第一夜 23:00（08-09）
        engine.decide(
            &run_terminal("run-1", RunTerminalStatus::Completed),
            &ctx(),
            T0 + 11 * 3_600_000,
        );
        let first = engine
            .take_night_summary(T0 + 19 * 3_600_000 + 30 * 60_000)
            .expect("第一夜摘要");
        assert_eq!(first.date, "2026-08-09");
        assert_eq!(first.total, 1);

        // 第二夜 23:00（08-10）
        let next_evening = T0 + 35 * 3_600_000; // 08-10 23:00
        engine.decide(
            &run_terminal("run-2", RunTerminalStatus::Completed),
            &ctx(),
            next_evening,
        );
        let second = engine
            .take_night_summary(next_evening + 8 * 3_600_000 + 30 * 60_000)
            .expect("第二夜摘要");
        assert_eq!(second.date, "2026-08-10");
        assert_eq!(second.total, 1);
        assert_eq!(second.body, "夜间完成 1 项：任务 run-2 已完成");
    }

    /// 空折叠出桶 → None
    #[test]
    fn night_summary_empty_take_returns_none() {
        let mut engine = PushDecisionEngine::default();
        assert!(engine
            .take_night_summary(T0 + 19 * 3_600_000 + 30 * 60_000)
            .is_none());
        assert_eq!(engine.folded_len(), 0);
    }

    // ── R3-01a 补强：去重后端注入（SQLite 与内存同 trait 等价）──

    #[test]
    fn engine_with_sqlite_dedupe_backend() {
        let backend = super::super::dedupe::SqliteDedupeBackend::open_in_memory(24 * 3_600_000)
            .expect("内存库");
        let mut engine =
            PushDecisionEngine::with_dedupe_backend(EngineConfig::default(), Box::new(backend));
        let out = engine.decide(&task_suspicious("t-1"), &ctx(), T0);
        assert!(out[0].deliver);
        let replay = engine.decide(&task_suspicious("t-1"), &ctx(), T0 + 1_000);
        assert_eq!(replay[0].outcome, DecisionOutcome::DedupeSuppressed);
        assert!(!replay[0].deliver);
    }
}
