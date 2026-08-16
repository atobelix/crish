//! 跨端事件会话面消息（events.* + session.*；M6 §10.5）
//!
//! - 事件载荷 = `AgentEventEnvelope` 扁平 JSON 原样透传（D3 §7.1：与桌面事件
//!   通道逐字节同构，跨端不二次包装）——[EventsPush::event] 以
//!   `serde_json::Value` 承载，[EventsPush::from_envelope] 从既有
//!   `crate::events::AgentEventEnvelope` 产形；
//! - 订阅 / 续传 / 回执 / 会话索引广播：与既有 41 变体（`crate::events::
//!   AgentEvent`，冻结不新增）正交，会话列表增量走 `session.updated` 会话面
//!   消息（P-3 裁决）；
//! - 双面策略映射：M6 §5.1 把 41 变体按「实时面 / 同步面」登记跨端策略
//!   （T 透明透传 13 / R 摘要化 18 / U 元组下发 10）；本模块的
//!   [event_cross_strategy] / [event_is_sync_eligible] 以 `AgentEvent` 变体
//!   匹配实现，编译期锁定 58 变体（与 events.rs `event_backpressure` 同范式）；
//!   2026-08-11 任务连续性方案恢复域 + goal 域兼容新增 8 变体（41 → 49，
//!   D8 事件登记）——跨端策略分组随之扩展为 T 14 / R 24 / U 11（recovery-* 与
//!   goal-* 事件为桌面观测面，移动端不消费，策略按数据面保守分配）；
//!   2026-08-14 D-03 契约窗口：tool-input-repaired 核销删除 + 9 新观测事件
//!   （49 → 57，全 Delta 可丢级）——跨端策略分组 T 14 / R 33 / U 10
//!   （新事件全部按观测字段摘要化保留，无正文敏感）；
//!   2026-08-16 统一输入流收敛战役 T1a/T1b：新增撤回域事件 timeline-truncate
//!   （57 → 58，Critical 必达透传）——跨端策略分组 T 15 / R 33 / U 10。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::device::skip_false;
use crate::events::{AgentEvent, AgentEventEnvelope, EVENT_ENVELOPE_SCHEMA_VERSION};
use crate::SessionIndexEntry;

/// 跨端事件裁剪策略（M6 §5.1 三档；wire kebab-case）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EventRedactStrategy {
    /// 透明透传（T）：事件字段原样出网
    Transparent,
    /// 摘要化（R）：敏感字段按 §5.2 规则表摘要后下发
    Redacted,
    /// 元组下发（U，fail-closed）：只下发 `{type, sequence, schemaVersion,
    /// sessionId, redacted}` 元组，正文不出网（宁可少数据，不可泄数据）
    Tuple,
}

/// 事件 → 跨端裁剪策略（M6 §5.1 映射表；41 变体分组计数 13/18/10，
/// 2026-08-11 D8 登记恢复域 + goal 域 8 变体后为 49 变体分组 14/24/11；
/// 2026-08-14 D-03 契约窗口后为 57 变体分组 14/33/10；
/// 2026-08-16 T1a/T1b 新增 timeline-truncate 后为 58 变体分组 15/33/10）
///
/// 与 `AgentEvent` 变体逐一匹配（缺 arm 编译报错），未登记的未来变体在
/// 网关层按 fail-closed 元组兜底（本函数只覆盖既有 57 变体）。
pub fn event_cross_strategy(event: &AgentEvent) -> EventRedactStrategy {
    match event {
        // T 透明透传（14）：agent-start/end、turn-start/end、压缩 start/end、
        // run-terminal、subagent-started/ended、task-started/suspicious/
        // completed/killed、recovery-fork（fork 拓扑与 subagent-started
        // 同性质：run 关联信息，无敏感正文，D8 登记）
        AgentEvent::AgentStart { .. }
        | AgentEvent::AgentEnd { .. }
        | AgentEvent::TurnStart { .. }
        | AgentEvent::TurnEnd { .. }
        | AgentEvent::ContextCompressionStart { .. }
        | AgentEvent::ContextCompressionEnd { .. }
        | AgentEvent::RunTerminal { .. }
        | AgentEvent::SubagentStarted { .. }
        | AgentEvent::SubagentEnded { .. }
        | AgentEvent::TaskStarted { .. }
        | AgentEvent::TaskSuspicious { .. }
        | AgentEvent::TaskCompleted { .. }
        | AgentEvent::TaskKilled { .. }
        | AgentEvent::RecoveryFork { .. }
        // T1a 统一输入流收敛战役：timeline-truncate 为 Critical 必达会话内
        // 事件（R1 撤回出站），device 端透传不裁剪（与 message-end 同级，
        // 会话树撤回语义须完整跨端透传，字段全为结构标识符无正文敏感）
        | AgentEvent::TimelineTruncate { .. } => EventRedactStrategy::Transparent,

        // R 摘要化（33）：message-delta/end、tool-start/update/end、
        // runtime-error/intervention-required、approval-requested/resolved、
        // cache 三件、security-audit、subagent-event、task-output/failed、
        // timer-fired、cron-fired、recovery-escalated/steering/report/
        // budget-denied、goal-round-started/completed（恢复与 goal 数据面
        // 事件：无正文内容，观测字段保留；D8 登记）+
        // D-03 九观测事件（steering-evaluated/control-intent/hook-outcome/
        // summary-background/stage-summary-milestone/nudge-enqueued/
        // recovery-acknowledged/recovery-retry-attempted/
        // provider-request-anchored：观测字段无正文敏感，摘要化保留）
        AgentEvent::MessageDelta { .. }
        | AgentEvent::MessageEnd { .. }
        | AgentEvent::ToolStart { .. }
        | AgentEvent::ToolUpdate { .. }
        | AgentEvent::ToolEnd { .. }
        | AgentEvent::RuntimeError { .. }
        | AgentEvent::RuntimeInterventionRequired { .. }
        | AgentEvent::ApprovalRequested { .. }
        | AgentEvent::ApprovalResolved { .. }
        | AgentEvent::CacheStatsUpdated { .. }
        | AgentEvent::CacheWasteAlert { .. }
        | AgentEvent::ColdCacheWarning { .. }
        | AgentEvent::SecurityAudit { .. }
        | AgentEvent::SubagentEvent { .. }
        | AgentEvent::TaskOutput { .. }
        | AgentEvent::TaskFailed { .. }
        | AgentEvent::TimerFired { .. }
        | AgentEvent::CronFired { .. }
        | AgentEvent::RecoveryEscalated { .. }
        | AgentEvent::RecoverySteering { .. }
        | AgentEvent::RecoveryReport { .. }
        | AgentEvent::RecoveryBudgetDenied { .. }
        | AgentEvent::GoalRoundStarted { .. }
        | AgentEvent::GoalRoundCompleted { .. }
        | AgentEvent::SteeringEvaluated { .. }
        | AgentEvent::ControlIntent { .. }
        | AgentEvent::HookOutcome { .. }
        | AgentEvent::SummaryBackground { .. }
        | AgentEvent::StageSummaryMilestone { .. }
        | AgentEvent::NudgeEnqueued { .. }
        | AgentEvent::RecoveryAcknowledged { .. }
        | AgentEvent::RecoveryRetryAttempted { .. }
        | AgentEvent::ProviderRequestAnchored { .. } => EventRedactStrategy::Redacted,

        // U 元组下发（10）：message-start、tool-batch-start/end、
        // provider-diagnostic、runtime-steering、
        // checkpoint-created/restored、task-heartbeat、timer-cancelled、
        // goal-continuation-decided（prompt 为续轮注入文本，任务级内容——
        // fail-closed 元组兜底，对齐 runtime-steering；D8 登记）
        AgentEvent::MessageStart { .. }
        | AgentEvent::ToolBatchStart { .. }
        | AgentEvent::ToolBatchEnd { .. }
        | AgentEvent::ProviderDiagnostic { .. }
        | AgentEvent::RuntimeSteering { .. }
        | AgentEvent::CheckpointCreated { .. }
        | AgentEvent::CheckpointRestored { .. }
        | AgentEvent::TaskHeartbeat { .. }
        | AgentEvent::TimerCancelled { .. }
        | AgentEvent::GoalContinuationDecided { .. } => EventRedactStrategy::Tuple,
    }
}

/// 同步面白名单（M6 §5.0：57 变体中 20 类参与 `events.resume` / C03 续传；
/// 29 类不同步——delta/诊断/定时器数据面、恢复域与 goal 域观测事件等由
/// 实时面或补取命令覆盖；D8 登记新增 8 事件均不入白名单；D-03 九观测事件
/// 同为 Delta 可丢级不入白名单）
pub const SYNC_ELIGIBLE_TYPES: [&str; 20] = [
    "agent-start",
    "agent-end",
    "turn-start",
    "turn-end",
    "message-end",
    "tool-start",
    "tool-update",
    "tool-end",
    "context-compression-start",
    "context-compression-end",
    "approval-requested",
    "approval-resolved",
    "run-terminal",
    "security-audit",
    "subagent-started",
    "subagent-ended",
    "task-started",
    "task-completed",
    "task-failed",
    "task-killed",
];

/// 事件是否参与同步面（M6 §5.0 白名单；以 `AgentEvent` 变体匹配锁定）
pub fn event_is_sync_eligible(event: &AgentEvent) -> bool {
    matches!(
        event,
        AgentEvent::AgentStart { .. }
            | AgentEvent::AgentEnd { .. }
            | AgentEvent::TurnStart { .. }
            | AgentEvent::TurnEnd { .. }
            | AgentEvent::MessageEnd { .. }
            | AgentEvent::ToolStart { .. }
            | AgentEvent::ToolUpdate { .. }
            | AgentEvent::ToolEnd { .. }
            | AgentEvent::ContextCompressionStart { .. }
            | AgentEvent::ContextCompressionEnd { .. }
            | AgentEvent::ApprovalRequested { .. }
            | AgentEvent::ApprovalResolved { .. }
            | AgentEvent::RunTerminal { .. }
            | AgentEvent::SecurityAudit { .. }
            | AgentEvent::SubagentStarted { .. }
            | AgentEvent::SubagentEnded { .. }
            | AgentEvent::TaskStarted { .. }
            | AgentEvent::TaskCompleted { .. }
            | AgentEvent::TaskFailed { .. }
            | AgentEvent::TaskKilled { .. }
    )
}

/// fail-closed 元组（M6 §5.2.3：未登记裁剪规则的事件只下发本元组）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRedactedTuple {
    /// 事件类型名（kebab-case）
    #[serde(rename = "type")]
    pub event_type: String,
    /// 事件序列号（DB 行为准）
    pub sequence: u64,
    /// 信封 schema 版本（恒为 1）
    pub schema_version: u32,
    /// 会话 id
    pub session_id: String,
    /// 恒为 true：正文已按策略抑制
    pub redacted: bool,
}

impl EventRedactedTuple {
    /// 构造抑制元组（redacted 恒 true，schema 版本取当前值）
    pub fn new(
        event_type: impl Into<String>,
        sequence: u64,
        session_id: impl Into<String>,
    ) -> Self {
        Self {
            event_type: event_type.into(),
            sequence,
            schema_version: EVENT_ENVELOPE_SCHEMA_VERSION,
            session_id: session_id.into(),
            redacted: true,
        }
    }
}

// ── 订阅 / 续传 / 回执（M6 §10.5）──

/// 会话 → 最后已确认持久化序列（断线续传游标；`events.subscribe.
/// lastSequences` / `auth.hello.resume` 共用）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ResumeState(pub HashMap<String, u64>);

impl ResumeState {
    /// 空游标集合
    pub fn new() -> Self {
        Self(HashMap::new())
    }

    /// 某会话的已确认序列（缺省 0）
    pub fn sequence_of(&self, session_id: &str) -> u64 {
        self.0.get(session_id).copied().unwrap_or(0)
    }
}

/// 订阅回执的单会话游标（events.subscribe.ok 条目）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCursor {
    /// 会话 id
    pub session_id: String,
    /// 会话当前最大已持久化序列 + 1（续传起点）
    pub next_sequence: u64,
    /// 游标落后超窗口（EVENT_WINDOW），需全量回放
    pub stale: bool,
}

/// 订阅确认模式（wire lowercase；仅诊断/调试模式启用 ack）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AckMode {
    /// 不确认（默认；续传游标已覆盖可靠性）
    None,
    /// 仅 Critical 事件回执（防 ack 风暴）
    Critical,
}

/// 摘要档位（M6 §5.2.2 三档；默认 standard）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Granularity {
    /// 轻量档（不传正文摘要）
    Light,
    /// 标准档（默认：正文 200 字符）
    Standard,
    /// 完整档（正文 2000 字符）
    Full,
}

/// 按会话订阅（events.subscribe，M→D；D3 §7.3 / M6 §10.5 Subscribe）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subscribe {
    /// 订阅会话列表（≤ MAX_SUBSCRIPTIONS=32）
    pub sessions: Vec<String>,
    /// 逐会话断线游标（重连追平锚点）
    pub last_sequences: ResumeState,
    /// 确认模式（缺省 none）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ack_mode: Option<AckMode>,
    /// 摘要档位（缺省 standard）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub granularity: Option<Granularity>,
}

/// 全局轻订阅（events.subscribeAll，M→D；type 白名单）
///
/// 仅推送会话无关/低频事件（security-audit / device.* / timer/cron 数据面 /
/// session.*），防移动端盲扫全量。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeAll {
    /// type 白名单（kebab-case 事件名）
    pub events: Vec<String>,
}

/// 订阅确认（events.subscribe.ok，D→M）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeOk {
    /// 逐会话游标（nextSequence / stale）
    pub sessions: Vec<SessionCursor>,
}

/// 事件实时推送（events.push，D→M；一帧一事件）
///
/// `event` 为 `AgentEventEnvelope` 扁平 JSON（裁剪后；type/runId/sequence/
/// schemaVersion/sessionId + 事件字段），与桌面事件通道逐字节同构。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsPush {
    /// 会话 id
    pub session_id: String,
    /// 实时预览帧标记（sequence 未落库；移动端不推进游标，持久化副本
    /// 按同 sequence 原地覆盖，D3 §7.4）
    #[serde(default, skip_serializing_if = "skip_false")]
    pub preview: bool,
    /// 扁平事件 JSON（AgentEventEnvelope 形态）
    pub event: serde_json::Value,
}

impl EventsPush {
    /// 从既有信封产形（序列化 AgentEventEnvelope → 扁平 JSON）
    pub fn from_envelope(
        session_id: impl Into<String>,
        envelope: &AgentEventEnvelope,
        preview: bool,
    ) -> Self {
        let event = serde_json::to_value(envelope)
            .expect("AgentEventEnvelope 必须可序列化为 JSON");
        Self {
            session_id: session_id.into(),
            preview,
            event,
        }
    }
}

/// 事件确认（events.ack，M→D；仅 ackMode=critical 诊断模式）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventAck {
    /// 被确认事件的 msgId
    pub msg_id: String,
}

/// 断线续传请求（events.resume，M→D；body = C03 参数子集，D3 §7.5）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resume {
    /// 会话 id
    pub session_id: String,
    /// 开区间游标（`sequence > afterSequence`）
    pub after_sequence: u64,
    /// 页大小（缺省 200，上限 1000）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_events: Option<u32>,
}

/// 续传分页（events.resume.page，D→M；复用 EventPage 契约）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumePage {
    /// 会话 id
    pub session_id: String,
    /// 裁剪后扁平事件 JSON 列表（sequence 以 DB 行为准回填）
    pub events: Vec<serde_json::Value>,
    /// 下一续传游标（hasMore 时继续）
    pub next_after_sequence: u64,
    /// 是否还有更早事件
    pub has_more: bool,
}

/// 续传完成（events.resume.done，D→M；桌面恢复实时推流）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeDone {
    /// 会话 id
    pub session_id: String,
    /// 已追平到的序列（游标 = resumedTo）
    pub resumed_to: u64,
}

// ── 会话索引广播（F5 列表增量刷新；P-3 裁决：走会话面，不新增事件变体）──

/// 会话索引变更广播（session.updated，D→M）
///
/// `session` 复用 [SessionIndexEntry]（既有会话索引契约，字段 camelCase
/// 原样；M6 §10.5 的 id/updatedAt 必填为其子集）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUpdated {
    /// 会话索引条目（含增量字段）
    pub session: SessionIndexEntry,
}

/// 会话删除广播（session.removed，D→M；本地清理投影与游标）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRemoved {
    /// 被删除会话 id
    pub session_id: String,
}

/// 会话索引全量刷新信号（session.updatedAll，D→M；对账兜底）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUpdatedAll {
    /// 索引代数（对账兜底；变化即重拉）
    pub version: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::{AgentEvent, AgentEventEnvelope, ApprovalDecision, RunTerminalStatus};

    #[test]
    fn event_cross_strategy_groups() {
        // T 组代表
        assert_eq!(
            event_cross_strategy(&AgentEvent::AgentStart {
                session_id: "s1".into(),
                timestamp: "2026-08-09T00:00:00Z".into(),
            }),
            EventRedactStrategy::Transparent
        );
        assert_eq!(
            event_cross_strategy(&AgentEvent::RunTerminal {
                session_id: "s1".into(),
                run_id: "r1".into(),
                timestamp: "t".into(),
                terminal: RunTerminalStatus::Completed,
                error: None,
            }),
            EventRedactStrategy::Transparent
        );
        // R 组代表
        assert_eq!(
            event_cross_strategy(&AgentEvent::ApprovalRequested {
                session_id: "s1".into(),
                request: crate::events::PermissionRequest {
                    id: "req-1".into(),
                    session_id: "s1".into(),
                    cwd: "/".into(),
                    tool_call_id: "tc-9".into(),
                    tool_name: "shell:write".into(),
                    parameters: serde_json::json!({}),
                    summary: "s".into(),
                    tool_metadata: Default::default(),
                    metadata: None,
                    requester_run_id: None,
                    reason: None,
                },
                timestamp: "t".into(),
            }),
            EventRedactStrategy::Redacted
        );
        // U 组代表（fail-closed）
        assert_eq!(
            event_cross_strategy(&AgentEvent::TaskHeartbeat {
                session_id: "s1".into(),
                task_id: "t-7".into(),
                resource: serde_json::json!({}),
            }),
            EventRedactStrategy::Tuple
        );
    }

    #[test]
    fn sync_eligible_table_locks_registry() {
        // 20 类白名单全部命中既有事件注册表（防新增事件忘登记）
        assert_eq!(SYNC_ELIGIBLE_TYPES.len(), 20);
        for name in SYNC_ELIGIBLE_TYPES {
            assert!(
                crate::events::AgentEvent::ALL_TYPE_NAMES.contains(&name),
                "同步面白名单 {name} 不在 41 变体注册表中"
            );
        }
        // 不同步代表：message-delta / task-output / timer-fired
        assert!(!event_is_sync_eligible(&AgentEvent::MessageDelta {
            session_id: "s1".into(),
            timestamp: "t".into(),
            message_id: "m1".into(),
            block: crate::message::AgentMessageBlock::Text {
                text: "x".into()
            },
        }));
    }

    #[test]
    fn events_push_roundtrip_and_flat_envelope() {
        let envelope = AgentEventEnvelope::new(
            AgentEvent::ApprovalResolved {
                session_id: "s-abc".into(),
                tool_call_id: "tc-9".into(),
                request_id: None,
                decision: ApprovalDecision::Approved,
                timestamp: "t".into(),
            },
            Some("r-01".into()),
            Some(130),
        );
        let push = EventsPush::from_envelope("s-abc", &envelope, false);
        let json = serde_json::to_value(&push).unwrap();
        assert_eq!(json["sessionId"], "s-abc");
        assert!(json.get("preview").is_none(), "preview=false 应省略");
        // 事件为扁平信封 JSON（type/runId/sequence/schemaVersion/sessionId 平铺）
        assert_eq!(json["event"]["type"], "approval-resolved");
        assert_eq!(json["event"]["runId"], "r-01");
        assert_eq!(json["event"]["sequence"], 130);
        assert_eq!(json["event"]["schemaVersion"], 1);
        assert_eq!(json["event"]["sessionId"], "s-abc");

        let back: EventsPush = serde_json::from_str(&serde_json::to_string(&push).unwrap()).unwrap();
        assert_eq!(push, back);
    }

    #[test]
    fn events_push_preview_flag() {
        let push = EventsPush {
            session_id: "s-abc".into(),
            preview: true,
            event: serde_json::json!({ "type": "message-delta" }),
        };
        let json = serde_json::to_value(&push).unwrap();
        assert_eq!(json["preview"], true);
    }

    #[test]
    fn redacted_tuple_format() {
        let tuple = EventRedactedTuple::new("unknown-event-42", 140, "s-abc");
        let json = serde_json::to_value(&tuple).unwrap();
        assert_eq!(json["type"], "unknown-event-42");
        assert_eq!(json["sequence"], 140);
        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(json["sessionId"], "s-abc");
        assert_eq!(json["redacted"], true);
        let back: EventRedactedTuple =
            serde_json::from_str(&serde_json::to_string(&tuple).unwrap()).unwrap();
        assert_eq!(tuple, back);
    }

    #[test]
    fn subscribe_roundtrip() {
        let mut resume = ResumeState::new();
        resume.0.insert("s-abc".into(), 128);
        let sub = Subscribe {
            sessions: vec!["s-abc".into()],
            last_sequences: resume,
            ack_mode: Some(AckMode::Critical),
            granularity: Some(Granularity::Standard),
        };
        let json = serde_json::to_value(&sub).unwrap();
        assert_eq!(json["sessions"][0], "s-abc");
        assert_eq!(json["lastSequences"]["s-abc"], 128);
        assert_eq!(json["ackMode"], "critical");
        assert_eq!(json["granularity"], "standard");
        let back: Subscribe = serde_json::from_str(&serde_json::to_string(&sub).unwrap()).unwrap();
        assert_eq!(sub, back);

        // ackMode/granularity 缺省 → None
        let minimal = r#"{"sessions":["s1"],"lastSequences":{}}"#;
        let parsed: Subscribe = serde_json::from_str(minimal).unwrap();
        assert_eq!(parsed.ack_mode, None);
        assert_eq!(parsed.granularity, None);
        assert_eq!(parsed.last_sequences.sequence_of("missing"), 0);
    }

    #[test]
    fn resume_and_session_messages_roundtrip() {
        let resume = Resume { session_id: "s-abc".into(), after_sequence: 128, max_events: Some(200) };
        let json = serde_json::to_value(&resume).unwrap();
        assert_eq!(json["sessionId"], "s-abc");
        assert_eq!(json["afterSequence"], 128);
        let back: Resume = serde_json::from_str(&serde_json::to_string(&resume).unwrap()).unwrap();
        assert_eq!(resume, back);

        let page = ResumePage {
            session_id: "s-abc".into(),
            events: vec![serde_json::json!({ "type": "run-terminal" })],
            next_after_sequence: 130,
            has_more: true,
        };
        let json = serde_json::to_value(&page).unwrap();
        assert_eq!(json["nextAfterSequence"], 130);
        assert_eq!(json["hasMore"], true);
        let back: ResumePage = serde_json::from_str(&serde_json::to_string(&page).unwrap()).unwrap();
        assert_eq!(page, back);

        let done = ResumeDone { session_id: "s-abc".into(), resumed_to: 135 };
        let back: ResumeDone = serde_json::from_str(&serde_json::to_string(&done).unwrap()).unwrap();
        assert_eq!(done, back);

        // session.updated 复用既有 SessionIndexEntry
        let updated = SessionUpdated {
            session: SessionIndexEntry {
                id: "s-abc".into(),
                title: "修复登录页 bug".into(),
                folder: "常规会话".into(),
                is_pinned: false,
                is_archived: false,
                branch_parent_id: None,
                timestamp: String::new(),
                updated_at: 1754700000000_i64,
                message_count: 42,
                pinned_message_ids: None,
                engine_cursor: Some(128),
                engine_last_run_id: Some("r-01".into()),
                hydrated_from_engine: Some(true),
            },
        };
        let json = serde_json::to_value(&updated).unwrap();
        assert_eq!(json["session"]["id"], "s-abc");
        assert_eq!(json["session"]["updatedAt"], 1754700000000_i64);
        assert_eq!(json["session"]["engineCursor"], 128);
        let back: SessionUpdated =
            serde_json::from_str(&serde_json::to_string(&updated).unwrap()).unwrap();
        assert_eq!(updated, back);
    }

    #[test]
    fn subscribe_ok_and_session_broadcast_wire() {
        let ok = SubscribeOk {
            sessions: vec![SessionCursor {
                session_id: "s-abc".into(),
                next_sequence: 136,
                stale: false,
            }],
        };
        let json = serde_json::to_value(&ok).unwrap();
        assert_eq!(json["sessions"][0]["sessionId"], "s-abc");
        assert_eq!(json["sessions"][0]["nextSequence"], 136);
        assert_eq!(json["sessions"][0]["stale"], false);
        let back: SubscribeOk = serde_json::from_str(&serde_json::to_string(&ok).unwrap()).unwrap();
        assert_eq!(ok, back);

        let removed = SessionRemoved { session_id: "s-abc".into() };
        let json = serde_json::to_value(&removed).unwrap();
        assert_eq!(json["sessionId"], "s-abc");

        let all = SessionUpdatedAll { version: 3 };
        let json = serde_json::to_value(&all).unwrap();
        assert_eq!(json["version"], 3);
    }
}
