//! push-core 推送决策引擎（R3-01 · 纯函数决策面）+ 直推通道（R3-02）
//!
//! 规格真源：
//! - `docs/multi-device/plans/D7-push-notifications.md`（§3 场景清单 / §3.4 防打扰 /
//!   §6.1 push_intent 链路 / §6.2 PushMessage schema / §7.4 跳转映射 / §7.7 通知渠道）；
//! - `docs/multi-device/plans/M8-push-release.md`（§3.2.3 场景级别唯一真源 /
//!   §3.4 决策引擎实现规范：去重两级 / 合并窗口 / 静默时段 / 节流护栏；
//!   裁决修正 2：在线直推并入协议面 `events.push`）；
//! - `docs/multi-device/Z0-master-plan.md` §9.5（R3-01 / R3-02 任务包）与 §9.9（验收锚点）。
//!
//! 职责分层：
//! - **决策面（R3-01，无 I/O）**：纯输入事件 → 推送决策
//!   （[intent] → [dedupe] → [coalesce] → [quiet] → [throttle] → [engine]）；
//! - **直推通道（R3-02）**：[online] 设备在线判定 + [schema] PushMessage
//!   载荷映射 + [pusher] PushAwareEmitter 挂点 / 在线直推 / 离线 pending。
//!
//! 决策管线（对齐 D7 §6.1）：
//!
//! ```text
//! AgentEvent (49 变体)
//!   │
//!   ▼ [intent] push_intent(event, ctx) -> Option<PushIntent>   场景筛选（18 行登记表）
//!   │
//!   ▼ [dedupe] DedupeState.check_and_record(dedupe_key)        24h TTL 去重（P1/P2 内存；
//!   │                                                          审批键持久化注记，见 dedupe.rs）
//!   ▼ [coalesce] CoalesceState.push(pending) -> Option<MergedPush>  窗口合并（60s/10min）
//!   │
//!   ▼ [quiet] quiet_hours_policy(level, now_ms, cfg)           P0 仍发 / P1 折叠夜间摘要 /
//!   │                                                          P2 不推
//!   ▼ [throttle] ThrottleTracker.check(intent, now_ms)         每分钟 ≤2 / 每 10min ≤3 /
//!   │                                                          每日 ≤50
//!   ▼ PushDecision { deliver, scene, level, severity, dedupe_key, payload, outcome, ... }
//! ```
//!
//! ## 场景登记口径（13 vs 18）
//!
//! 任务包名「13 场景」为旧口径（按事件类合并）；**M8 §3.2.3 裁决修正 4 后的
//! S1-S12 展开表（18 行：P0×9 / P1×7 / P2×2）是推送场景级别的唯一真源**，
//! 本模块按 18 行实现：[SceneId] 枚举、[intent::push_intent] 判定、[scenes] 测试矩阵
//! 三者逐行对齐（新事件变体必须补 arm——match 穷尽性是编译期护栏）。
//!
//! 18 行登记表（`M8 §3.2.3`；级别含 AU1 §10.1 P0-4 裁决）：
//!
//! | 场景 | 事件 | 条件 | 级别 | 去重键 | target | 渠道 |
//! | --- | --- | --- | --- | --- | --- | --- |
//! | S1 | approval-requested | 全部 | P0 | approval-requested:{toolCallId} | approval | approval |
//! | S2 | approval-resolved | Expired | P0 | approval-resolved:{toolCallId}:expired | approval | approval |
//! | S3 | run-terminal | Completed | P1 | run-terminal:{runId} | session | run |
//! | S4 | run-terminal | Failed | P0 | run-terminal:{runId}:failed | session | run |
//! | S5 | run-terminal | Cancelled | P1 | run-terminal:{runId}:cancelled | session | run |
//! | S6 | subagent-ended | Completed / Cancelled | P1 | subagent-ended:{subagentId} | subagent | subagent |
//! | S7 | subagent-ended | Failed | P0 | subagent-ended:{subagentId} | subagent | subagent |
//! | S8a | task-started | is_daemon 或预计长耗时 | P2 | task-started:{taskId} | task | task |
//! | S8b | task-completed | 全部 | P1 | task-completed:{taskId} | task | task |
//! | S8c | task-suspicious | 全部 | P0 | task-suspicious:{taskId} | task | task |
//! | S8d | task-failed | 全部 | P0 | task-failed:{taskId} | task | task |
//! | S8e | task-killed | 非用户主动 | P1 | task-killed:{taskId} | task | task |
//! | S9a | timer-fired | 全部 | P1 | timer-fired:{timerId} | timer | timer |
//! | S9b | cron-fired | 全部 | P1 | cron-fired:{cronId} | timer | timer |
//! | S10a | runtime-error | 全部 | P0 | runtime-error:{runId} | session | run |
//! | S10b | runtime-intervention-required | 全部 | P0 | intervention:{runId} | session | run |
//! | S11 | security-audit | decision ∈ {blocked, purged} | P0 | security-audit:{toolCallId 或回退} | audit | security |
//! | S12 | cache-waste-alert | 全部 | P2 | cache-waste-alert:{runId} | session | summary |
//!
//! 其余 31 类事件不推（P3）：`message-*`/`tool-*`/`turn-*`/`agent-*` 过程态、
//! `task-output`/`task-heartbeat` 增量、`checkpoint-*`/`cache-stats-updated`/
//! `cold-cache-warning`/`provider-diagnostic`/`runtime-steering` 诊断类、
//! `subagent-started`/`subagent-event` 过程态、`timer-cancelled` 低价值、
//! 以及 41 变体冻结口径之后新增的 `recovery-*`×5 与 `goal-*`×3（登记表外，
//! 保守不推，未来场景登记扩展时可评审——见 [intent] 模块文档）。
//!
//! ## 与 R3-02 / R3-03 的接口注记
//!
//! - **装配**：`PushDecisionEngine` 挂在 `core_event_bridge.rs` 的
//!   `PushAwareEmitter` 旁路（D7 §9.2 方案 a；R3-02 [pusher] 已交付挂点
//!   装饰器 + 分发器，main.rs 接线留 R3 接线轮），`decide()` 逐事件调用；
//!   合并桶经 `flush()` 周期 drain（对齐 main.rs:430-441 的 500ms drain 先例）。
//! - **事件信封**：`AgentEventEnvelope.run_id`（events.rs:1109）注入
//!   [intent::PushIntentCtx::envelope_run_id]（缓存/审计/运行异常等事件体无
//!   runId 字段，去重键需要）。
//! - **审批持久化**：S1/S2 去重键与重推阶梯（15min → 60min → 每小时×5，M8 §3.4.4）
//!   必须落 SQLite `push_pending_approvals`/`push_events_dedupe`（D7 §8.2）；
//!   [dedupe::DedupeBackend] 接口与内存实现已交付，SQLite 后端 R3-02/03 接线。
//! - **输出消费（R3-02 直推通道）**：deliver=true 的决策 →
//!   [pusher::PushDispatcher]：在线设备经 [pusher::PushChannel] WS 直推
//!   （帧 kind = `events.push`，[schema::WS_PUSH_KIND]，M8 裁决修正 2）；
//!   离线设备标记 [pusher::PendingDelivery]（内存队列，[pusher::PushDispatcher::
//!   take_pending] 由 R3-03 厂商发送器消费）；在线判定见 [online]。
//! - **载荷**：[engine::PushDecision] → [schema::PushMessage]（D7 §6.2 schema
//!   v1）映射由 [schema::message_from_decision] 承担；title/body 文案渲染
//!   （push/copy.rs，D7 §6.5）不在 R3-02，映射置 None 由接线轮经
//!   [schema::PushMessage::with_copy] 填充。
//!
//! ## 临时过渡允许（对齐 wakeup_summary.rs 先例）
//!
//! 本模块 R3-01 交付决策面、R3-02 交付直推通道，R3 接线轮接线前无调用点，
//! 暂时允许 dead_code；接线落地即移除本属性（不允许长期保留）。

#![allow(dead_code)]

mod coalesce;
mod dedupe;
mod engine;
mod intent;
mod online;
mod pusher;
mod quiet;
mod scenes;
mod schema;
mod throttle;
mod vendor;

pub use coalesce::{CoalesceState, CoalesceWindows, MergedPush, PendingPush};
pub use dedupe::{DedupeBackend, DedupeState, MemoryDedupeBackend};
pub use engine::{DecisionOutcome, PushDecision, PushDecisionEngine};
pub use intent::{ApprovalPushRef, PayloadDigest, PushIntent, PushIntentCtx};
pub use online::{
    device_activity, is_device_online, DeviceActivity, DevicePresenceSource,
    MemoryPresenceSource, PRESENCE_TIMEOUT_MS,
};
pub use pusher::{
    DispatchReport, PendingDelivery, PushAwareEmitter, PushChannel, PushChannelError,
    PushDispatcher,
};
pub use quiet::{QuietHoursConfig, QuietPolicy, DEFAULT_QUIET_END_MINUTES, DEFAULT_QUIET_START_MINUTES};
pub use scenes::SceneId;
pub use schema::{
    message_from_decision, scene_category, scene_channel_id, scene_collapse_key,
    scene_event_type, scene_target, ws_push_body, PushMessage, PushTarget, PUSH_SCHEMA_VERSION,
    WS_PUSH_KIND,
};
pub use throttle::{ThrottleDecision, ThrottleLimits, ThrottleTracker};
pub use vendor::{
    ladder_delay_or, next_retry_delay, APNsCredentials, HMSCredentials, VendorDevice,
    VendorError, VendorNotification, VendorPlatform, VendorPushChannel, VendorSendOutcome,
    RETRY_LADDER_DELAYS,
};

/// 推送级别（D7 §3.1 四级定义中的前三级；P3 = 不推，由 `push_intent` 返回 None 表达）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushLevel {
    /// P0 必达：用户必须知道/行动，漏了有实际损失
    P0Critical,
    /// P1 重要：结果/进展，用户大概率关心
    P1Important,
    /// P2 可折叠：信息价值有限，可合并
    P2Collapsible,
}

impl PushLevel {
    /// schema 映射（D7 §6.2 severity：critical/important/normal）
    pub fn severity(&self) -> PushSeverity {
        match self {
            PushLevel::P0Critical => PushSeverity::Critical,
            PushLevel::P1Important => PushSeverity::Important,
            PushLevel::P2Collapsible => PushSeverity::Normal,
        }
    }

    /// wire 值（schema severity 字段）
    pub fn as_str(&self) -> &'static str {
        match self.severity() {
            PushSeverity::Critical => "critical",
            PushSeverity::Important => "important",
            PushSeverity::Normal => "normal",
        }
    }
}

/// 推送严重度（D7 §6.2 severity 字段；移动端据此决定横幅/静音）。
///
/// serde wire 值（schema severity 字段）：critical / important / normal——
/// 与 [PushLevel] 的 `severity()` 映射同口径，序列化经 schema.rs 消费。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PushSeverity {
    /// P0：critical
    Critical,
    /// P1：important
    Important,
    /// P2：normal
    Normal,
}

/// 跳转目标屏幕（D7 §7.4 路由映射表；移动端深链契约）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushTargetScreen {
    /// S1/S2 审批中心（params.toolCallId 定位）
    Approval,
    /// S3/S4/S5/S10 会话详情
    Session,
    /// S6/S7 子代理时间线
    Subagent,
    /// S8 任务详情/后台任务面板
    Task,
    /// S9 定时器详情
    Timer,
    /// S11 审计面板
    Audit,
    /// 夜间摘要等汇总
    Home,
}

impl PushTargetScreen {
    /// wire 值（schema target.screen）
    pub fn as_str(&self) -> &'static str {
        match self {
            PushTargetScreen::Approval => "approval",
            PushTargetScreen::Session => "session",
            PushTargetScreen::Subagent => "subagent",
            PushTargetScreen::Task => "task",
            PushTargetScreen::Timer => "timer",
            PushTargetScreen::Audit => "audit",
            PushTargetScreen::Home => "home",
        }
    }
}
