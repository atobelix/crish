//! 推送消息 schema（R3-02：D7 §6.2 schema v1 的 Rust 契约 + 场景载荷映射）
//!
//! 规格真源：
//! - `docs/multi-device/plans/D7-push-notifications.md` §6.2（推送消息结构
//!   schema v1 全字段表）、§3.3.13（S1-S12 场景样例：category/channelId/
//!   target 形状）、§7.7（通知渠道表 channelId ↔ category）、§6.3（敏感度
//!   分级：WS 直推全量 data / 厂商通道摘要白名单）；
//! - `docs/multi-device/plans/M8-push-release.md` 裁决修正 2（在线直推并入
//!   协议面 `events.push`——[WS_PUSH_KIND]；D7 §4.5a 独立中继帧协议作废）。
//!
//! 职责：
//! - [PushMessage] / [PushTarget]：schema v1 结构（serde camelCase，与事件
//!   契约同风格）；
//! - [message_from_decision]：push-core 输出（[crate::push::engine::
//!   PushDecision]）→ PushMessage 映射——severity / category / channelId /
//!   dedupeKey / collapseKey / target（screen + sessionId + params）/ data；
//! - [ws_push_body]：构造协议面 `events.push` 帧载荷（[EventsPush] body，
//!   `event` 字段承载 PushMessage JSON——M8 裁决修正 2 复用 R1 WS 面）；
//! - title/body：**文案渲染（push/copy.rs）不在本任务**——映射时置 `None`，
//!   接线轮经 [PushMessage::with_copy] 填充（D7 §6.5）；data 事件全量注入
//!   （`data.event`，D7 §6.3 WS 直推全量语义）同样留接线轮（本任务 data={}）。
//!
//! 场景 → schema 字段映射表（样例对齐 D7 §3.3.13 逐条核对）：
//!
//! | 场景 | eventType | category | channelId | collapseKey | target.params |
//! | --- | --- | --- | --- | --- | --- |
//! | S1/S2 | approval-requested / approval-resolved | approval | approval | session:{s} | toolCallId |
//! | S3-S5 | run-terminal | run | run | session:{s} | runId |
//! | S6/S7 | subagent-ended | subagent | subagent | session:{s} | subagentId |
//! | S8 | task-* | task | task | session:{s} | taskId |
//! | S9a | timer-fired | timer | timer | timer:{id} | timerId |
//! | S9b | cron-fired | timer | timer | cron:{id} | cronId |
//! | S10 | runtime-error / runtime-intervention-required | run | run | session:{s} | runId |
//! | S11 | security-audit | security | security | session:{s} | {} |
//! | S12 | cache-waste-alert | system | summary | session:{s} | runId |

use conex_types::device::EventsPush;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::engine::PushDecision;
use super::intent::PayloadDigest;
use super::scenes::SceneId;

/// schema v1（D7 §6.2：当前版本 1；演进登记仿事件 schema changelog 惯例）
pub const PUSH_SCHEMA_VERSION: u32 = 1;

/// WS 直推帧 kind（协议面 `events.push`——M8 裁决修正 2：在线直推复用
/// R1 事件会话面 events.push 帧（M6 DeviceEnvelope）；D7 §4.5a 独立
/// WS 中继帧协议作废）
pub const WS_PUSH_KIND: &str = "events.push";

/// 推送消息（D7 §6.2 schema v1；serde camelCase，与事件契约同风格）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushMessage {
    /// schema 版本（当前 [PUSH_SCHEMA_VERSION]）
    pub schema_version: u32,
    /// 全局唯一 id（`push-<递增>`；对齐事件 sequence 语义）
    pub id: String,
    /// 来源事件 wire 名（41 枚举之一；night-summary 为合成事件）
    pub event_type: String,
    /// 每设备单调递增序号（WS 帧级去重与 ack 对应）
    pub seq: u64,
    /// 生成时刻（epoch 毫秒）
    pub ts_ms: u64,
    /// 严重度（critical/important/normal；移动端横幅与声音决策）
    pub severity: super::PushSeverity,
    /// 分类（approval/run/subagent/task/timer/security/system，§7.7）
    pub category: String,
    /// 标题（push/copy.rs 渲染；本任务未交付渲染 → None，接线轮填充）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// 正文（push/copy.rs 渲染；本任务未交付渲染 → None，接线轮填充）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// 去重键（D7 §3.4.1；移动端展示层幂等键）
    pub dedupe_key: String,
    /// 折叠键（厂商通道系统级折叠：Android tag / iOS threadId）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collapse_key: Option<String>,
    /// Android 通知渠道 id（D7 §7.7 表）
    pub channel_id: String,
    /// 跳转目标（D7 §7.4）
    pub target: PushTarget,
    /// 结构化附加数据（WS 直推时可为事件全量 data.event，D7 §6.3；
    /// 厂商通道时仅白名单字段——本任务 data={}，事件全量接线轮注入）
    #[serde(default)]
    pub data: serde_json::Value,
}

impl PushMessage {
    /// 填充渲染后的标题/正文（copy.rs 接线：R3 接线轮渲染后调用，
    /// D7 §6.5 push/copy.rs 消费 [PayloadDigest] 产出 title/body）
    pub fn with_copy(mut self, title: impl Into<String>, body: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self.body = Some(body.into());
        self
    }
}

/// 跳转目标（D7 §7.4 路由映射表；移动端深链契约）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushTarget {
    /// 目标屏幕（approval/session/subagent/task/timer/audit/home）
    pub screen: String,
    /// 会话 id
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// 场景参数（toolCallId/runId/subagentId/taskId/timerId/cronId 等）
    #[serde(default)]
    pub params: serde_json::Value,
}

/// 场景 → 分类（D7 §7.7 渠道表 category 列）
pub fn scene_category(scene: SceneId) -> &'static str {
    match scene {
        SceneId::ApprovalRequested | SceneId::ApprovalExpired => "approval",
        SceneId::RunCompleted
        | SceneId::RunFailed
        | SceneId::RunCancelled
        | SceneId::RuntimeError
        | SceneId::InterventionRequired => "run",
        SceneId::SubagentCompleted | SceneId::SubagentFailed => "subagent",
        SceneId::TaskStarted
        | SceneId::TaskCompleted
        | SceneId::TaskSuspicious
        | SceneId::TaskFailed
        | SceneId::TaskKilled => "task",
        SceneId::TimerFired | SceneId::CronFired => "timer",
        SceneId::SecurityBlocked => "security",
        SceneId::CacheWasteAlert => "system",
    }
}

/// 场景 → 通知渠道 id（D7 §7.7 表：summary 渠道专属 S12/夜间摘要）
pub fn scene_channel_id(scene: SceneId) -> &'static str {
    match scene {
        SceneId::CacheWasteAlert => "summary",
        _ => scene_category(scene),
    }
}

/// 场景 → 来源事件 wire 名（schema eventType 字段；**场景名 ≠ 事件名**：
/// S2 场景 approval-expired 的来源事件是 approval-resolved；S3-S5 场景
/// run-completed/failed/cancelled 的来源事件都是 run-terminal——样例
/// D7 §3.3.13 S2-S5 的 eventType 逐条核对）
pub fn scene_event_type(scene: SceneId) -> &'static str {
    match scene {
        SceneId::ApprovalRequested => "approval-requested",
        SceneId::ApprovalExpired => "approval-resolved",
        SceneId::RunCompleted | SceneId::RunFailed | SceneId::RunCancelled => "run-terminal",
        SceneId::SubagentCompleted | SceneId::SubagentFailed => "subagent-ended",
        SceneId::TaskStarted => "task-started",
        SceneId::TaskCompleted => "task-completed",
        SceneId::TaskSuspicious => "task-suspicious",
        SceneId::TaskFailed => "task-failed",
        SceneId::TaskKilled => "task-killed",
        SceneId::TimerFired => "timer-fired",
        SceneId::CronFired => "cron-fired",
        SceneId::RuntimeError => "runtime-error",
        SceneId::InterventionRequired => "runtime-intervention-required",
        SceneId::SecurityBlocked => "security-audit",
        SceneId::CacheWasteAlert => "cache-waste-alert",
    }
}

/// 场景 → 折叠键（D7 样例：timer/cron 按实体折叠，其余按会话折叠）
pub fn scene_collapse_key(scene: SceneId, payload: &PayloadDigest) -> String {
    match scene {
        SceneId::TimerFired => format!("timer:{}", payload.biz_key),
        SceneId::CronFired => format!("cron:{}", payload.biz_key),
        _ => format!("session:{}", payload.session_id),
    }
}

/// 场景 → 跳转目标（D7 §7.4：screen + sessionId + 场景 params）
pub fn scene_target(scene: SceneId, payload: &PayloadDigest) -> PushTarget {
    let screen = scene.target_screen().as_str();
    let params = match scene {
        SceneId::ApprovalRequested | SceneId::ApprovalExpired => {
            json!({ "toolCallId": payload.biz_key })
        }
        SceneId::RunCompleted
        | SceneId::RunFailed
        | SceneId::RunCancelled
        | SceneId::RuntimeError
        | SceneId::InterventionRequired
        | SceneId::CacheWasteAlert => json!({ "runId": payload.biz_key }),
        SceneId::SubagentCompleted | SceneId::SubagentFailed => {
            json!({ "subagentId": payload.biz_key })
        }
        SceneId::TaskStarted
        | SceneId::TaskCompleted
        | SceneId::TaskSuspicious
        | SceneId::TaskFailed
        | SceneId::TaskKilled => json!({ "taskId": payload.biz_key }),
        SceneId::TimerFired => json!({ "timerId": payload.biz_key }),
        SceneId::CronFired => json!({ "cronId": payload.biz_key }),
        // D7 样例 S11：security-audit 的 params 为空（跳审计面板即可）
        SceneId::SecurityBlocked => json!({}),
    };
    PushTarget {
        screen: screen.to_string(),
        session_id: Some(payload.session_id.clone()),
        params,
    }
}

/// 决策 → 推送消息（push-core 输出消费，M8 §3.2.1「PushMessage 组装」）
///
/// `id`（全局递增）与 `seq`（每设备单调）由分发器
/// （[crate::push::pusher::PushDispatcher]）注入——本函数保持纯映射。
pub fn message_from_decision(
    decision: &PushDecision,
    id: String,
    seq: u64,
    now_ms: u64,
) -> PushMessage {
    PushMessage {
        schema_version: PUSH_SCHEMA_VERSION,
        id,
        event_type: scene_event_type(decision.scene).to_string(),
        seq,
        ts_ms: now_ms,
        severity: decision.severity,
        category: scene_category(decision.scene).to_string(),
        title: None,
        body: None,
        dedupe_key: decision.dedupe_key.clone(),
        collapse_key: Some(scene_collapse_key(decision.scene, &decision.payload)),
        channel_id: scene_channel_id(decision.scene).to_string(),
        target: scene_target(decision.scene, &decision.payload),
        data: json!({}),
    }
}

/// 构造协议面 `events.push` 帧载荷（M8 裁决修正 2：在线直推并入
/// events.push（M6 DeviceEnvelope）——body 复用 [EventsPush] 形状，
/// `event` 字段承载 PushMessage JSON；WS 信封（v/kind/msgId/ts/from/to/
/// auth）由 R1 连接面（ws.rs outbound_frame）构造，不在此重复）
pub fn ws_push_body(message: &PushMessage) -> EventsPush {
    EventsPush {
        session_id: message
            .target
            .session_id
            .clone()
            .unwrap_or_default(),
        preview: false,
        event: serde_json::to_value(message).expect("PushMessage 必须可序列化为 JSON"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::push::engine::{DecisionOutcome, PushDecision};
    use crate::push::intent::PayloadDigest;
    use crate::push::{PushLevel, PushSeverity};

    /// 构造决策 fixture（默认 S4 run 失败：P0）
    fn decision(scene: SceneId, deliver: bool) -> PushDecision {
        PushDecision {
            deliver,
            scene,
            level: scene.level(),
            severity: scene.level().severity(),
            dedupe_key: format!("{}:run-42", super::scene_event_type(scene)),
            payload: PayloadDigest {
                session_id: "s-7".to_string(),
                biz_key: "run-42".to_string(),
                digest: Some("provider 401".to_string()),
                detail: None,
            },
            outcome: DecisionOutcome::Delivered,
        }
    }

    /// S4 run 失败（P0）：severity/category/channelId/target/折叠键全映射
    #[test]
    fn run_failed_maps_all_fields() {
        let message = message_from_decision(
            &decision(SceneId::RunFailed, true),
            "push-000001".to_string(),
            1,
            1_784_078_400_000,
        );
        assert_eq!(message.schema_version, PUSH_SCHEMA_VERSION);
        assert_eq!(message.id, "push-000001");
        assert_eq!(message.event_type, "run-terminal", "S4 事件 wire 名");
        assert_eq!(message.seq, 1);
        assert_eq!(message.ts_ms, 1_784_078_400_000);
        assert_eq!(message.severity, PushSeverity::Critical, "P0 → critical");
        assert_eq!(message.category, "run");
        assert_eq!(message.channel_id, "run");
        assert_eq!(message.dedupe_key, "run-terminal:run-42");
        assert_eq!(message.collapse_key.as_deref(), Some("session:s-7"));
        assert_eq!(message.target.screen, "session");
        assert_eq!(message.target.session_id.as_deref(), Some("s-7"));
        assert_eq!(message.target.params, json!({ "runId": "run-42" }));
        assert_eq!(message.data, json!({}), "本任务 data 为空（事件全量接线轮注入）");
        assert_eq!(message.title, None, "copy.rs 未交付 → title 待渲染");
        assert_eq!(message.body, None, "copy.rs 未交付 → body 待渲染");
    }

    /// S1 审批（P0）：category=approval、params=toolCallId、事件名不变
    #[test]
    fn approval_maps_tool_call_target() {
        let mut decision = decision(SceneId::ApprovalRequested, true);
        decision.payload.biz_key = "tc-9f3a".to_string();
        decision.dedupe_key = "approval-requested:tc-9f3a".to_string();
        let message = message_from_decision(&decision, "push-1".to_string(), 1, 1);
        assert_eq!(message.event_type, "approval-requested");
        assert_eq!(message.category, "approval");
        assert_eq!(message.channel_id, "approval");
        assert_eq!(message.severity, PushSeverity::Critical);
        assert_eq!(message.target.screen, "approval");
        assert_eq!(message.target.params, json!({ "toolCallId": "tc-9f3a" }));
        assert_eq!(message.collapse_key.as_deref(), Some("session:s-7"));
    }

    /// S2 审批过期：场景名 ≠ 事件名（场景 approval-expired、事件
    /// approval-resolved——D7 §3.3.13 S2 样例）
    #[test]
    fn approval_expired_event_type_is_source_event() {
        let message = message_from_decision(
            &decision(SceneId::ApprovalExpired, true),
            "push-2".to_string(),
            1,
            1,
        );
        assert_eq!(message.event_type, "approval-resolved");
        assert_eq!(message.category, "approval");
    }

    /// S3-S5 同源 run-terminal：三个场景的事件 wire 名一致
    #[test]
    fn run_scenes_share_event_type() {
        for scene in [
            SceneId::RunCompleted,
            SceneId::RunFailed,
            SceneId::RunCancelled,
        ] {
            assert_eq!(
                scene_event_type(scene),
                "run-terminal",
                "场景 {scene:?} 来源事件一致"
            );
        }
    }

    /// S9a/S9b：timer/cron 按实体折叠（collapseKey = timer:|cron:|id），
    /// 跳转参数 = timerId/cronId
    #[test]
    fn timer_and_cron_collapse_by_entity() {
        let mut timer = decision(SceneId::TimerFired, true);
        timer.payload.biz_key = "timer-1".to_string();
        timer.payload.session_id = "s-7".to_string();
        let message = message_from_decision(&timer, "push-3".to_string(), 1, 1);
        assert_eq!(message.collapse_key.as_deref(), Some("timer:timer-1"));
        assert_eq!(message.target.params, json!({ "timerId": "timer-1" }));
        assert_eq!(message.category, "timer");
        assert_eq!(message.severity, PushSeverity::Important, "S9a P1");

        let mut cron = decision(SceneId::CronFired, true);
        cron.payload.biz_key = "cron-2".to_string();
        let message = message_from_decision(&cron, "push-4".to_string(), 1, 1);
        assert_eq!(message.collapse_key.as_deref(), Some("cron:cron-2"));
        assert_eq!(message.target.params, json!({ "cronId": "cron-2" }));
    }

    /// S11 安全拦截：category=security、params 为空（D7 样例 S11）
    #[test]
    fn security_maps_empty_params() {
        let message = message_from_decision(
            &decision(SceneId::SecurityBlocked, true),
            "push-5".to_string(),
            1,
            1,
        );
        assert_eq!(message.category, "security");
        assert_eq!(message.channel_id, "security");
        assert_eq!(message.target.screen, "audit");
        assert_eq!(message.target.params, json!({}));
        assert_eq!(message.severity, PushSeverity::Critical, "S11 P0");
    }

    /// S12 缓存告警：category=system、channelId=summary（D7 §7.7 summary 渠道）
    #[test]
    fn cache_waste_uses_summary_channel() {
        let message = message_from_decision(
            &decision(SceneId::CacheWasteAlert, true),
            "push-6".to_string(),
            1,
            1,
        );
        assert_eq!(message.category, "system");
        assert_eq!(message.channel_id, "summary");
        assert_eq!(message.severity, PushSeverity::Normal, "S12 P2 → normal");
        assert_eq!(message.target.params, json!({ "runId": "run-42" }));
    }

    /// 完整场景 → 分类 / 渠道映射表全量断言（18 场景逐行）
    #[test]
    fn scene_category_channel_table_covers_18_rows() {
        let cases = [
            (SceneId::ApprovalRequested, "approval", "approval"),
            (SceneId::ApprovalExpired, "approval", "approval"),
            (SceneId::RunCompleted, "run", "run"),
            (SceneId::RunFailed, "run", "run"),
            (SceneId::RunCancelled, "run", "run"),
            (SceneId::SubagentCompleted, "subagent", "subagent"),
            (SceneId::SubagentFailed, "subagent", "subagent"),
            (SceneId::TaskStarted, "task", "task"),
            (SceneId::TaskCompleted, "task", "task"),
            (SceneId::TaskSuspicious, "task", "task"),
            (SceneId::TaskFailed, "task", "task"),
            (SceneId::TaskKilled, "task", "task"),
            (SceneId::TimerFired, "timer", "timer"),
            (SceneId::CronFired, "timer", "timer"),
            (SceneId::RuntimeError, "run", "run"),
            (SceneId::InterventionRequired, "run", "run"),
            (SceneId::SecurityBlocked, "security", "security"),
            (SceneId::CacheWasteAlert, "system", "summary"),
        ];
        assert_eq!(cases.len(), 18, "M8 §3.2.3 18 行登记");
        for (scene, category, channel) in cases {
            assert_eq!(scene_category(scene), category, "场景 {scene:?} 分类");
            assert_eq!(scene_channel_id(scene), channel, "场景 {scene:?} 渠道");
        }
    }

    /// severity serde wire 值（schema severity 字段形状）
    #[test]
    fn severity_serializes_to_wire_values() {
        assert_eq!(
            serde_json::to_string(&PushSeverity::Critical).expect("可序列化"),
            "\"critical\""
        );
        assert_eq!(
            serde_json::to_string(&PushSeverity::Important).expect("可序列化"),
            "\"important\""
        );
        assert_eq!(
            serde_json::to_string(&PushSeverity::Normal).expect("可序列化"),
            "\"normal\""
        );
        // 反序列化 roundtrip
        let back: PushSeverity =
            serde_json::from_str("\"critical\"").expect("可反序列化");
        assert_eq!(back, PushSeverity::Critical);
        // 级别 → severity 语义一致（mod.rs 映射）
        assert_eq!(PushLevel::P0Critical.severity(), PushSeverity::Critical);
        assert_eq!(PushLevel::P1Important.severity(), PushSeverity::Important);
        assert_eq!(PushLevel::P2Collapsible.severity(), PushSeverity::Normal);
    }

    /// PushMessage serde roundtrip（camelCase wire 形状 + title/body 缺省
    /// 跳过 + collapseKey 存在）
    #[test]
    fn push_message_serde_roundtrip_camel_case() {
        let message = message_from_decision(
            &decision(SceneId::RunFailed, true),
            "push-000001".to_string(),
            1,
            1_784_078_400_000,
        );
        let json = serde_json::to_value(&message).expect("可序列化");
        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(json["eventType"], "run-terminal");
        assert_eq!(json["tsMs"], 1_784_078_400_000_i64);
        assert_eq!(json["dedupeKey"], "run-terminal:run-42");
        assert_eq!(json["collapseKey"], "session:s-7");
        assert_eq!(json["channelId"], "run");
        assert_eq!(json["target"]["screen"], "session");
        assert_eq!(json["target"]["sessionId"], "s-7");
        assert_eq!(json["target"]["params"]["runId"], "run-42");
        assert_eq!(json["data"], json!({}));
        assert!(json.get("title").is_none(), "title 缺省跳过（待 copy 渲染）");
        assert!(json.get("body").is_none(), "body 缺省跳过（待 copy 渲染）");

        // roundtrip 还原
        let back: PushMessage = serde_json::from_value(json).expect("可反序列化");
        assert_eq!(back, message);
    }

    /// with_copy 填充渲染文案（copy.rs 接线入口）
    #[test]
    fn with_copy_fills_title_body() {
        let message = message_from_decision(
            &decision(SceneId::RunFailed, true),
            "push-1".to_string(),
            1,
            1,
        )
        .with_copy("任务运行失败", "provider 401");
        assert_eq!(message.title.as_deref(), Some("任务运行失败"));
        assert_eq!(message.body.as_deref(), Some("provider 401"));
        let json = serde_json::to_value(&message).expect("可序列化");
        assert_eq!(json["title"], "任务运行失败");
        assert_eq!(json["body"], "provider 401");
    }

    /// ws_push_body：events.push 帧载荷形状（body.event = PushMessage JSON，
    /// 对齐 M8 裁决修正 2——复用 R1 WS 面 events.push 帧）
    #[test]
    fn ws_push_body_carries_message_as_event() {
        let message = message_from_decision(
            &decision(SceneId::RunFailed, true),
            "push-000001".to_string(),
            1,
            1_784_078_400_000,
        );
        let body = ws_push_body(&message);
        assert_eq!(body.session_id, "s-7");
        assert!(!body.preview, "直推非预览帧");
        assert_eq!(body.event["eventType"], "run-terminal");
        assert_eq!(body.event["dedupeKey"], "run-terminal:run-42");

        // 帧 JSON 形状（camelCase；kind 常量）
        let json = serde_json::to_value(&body).expect("可序列化");
        assert_eq!(json["sessionId"], "s-7");
        assert!(json.get("preview").is_none(), "preview=false 由 skip_false 在 wire 上省略");
        assert_eq!(json["event"]["id"], "push-000001");
        assert_eq!(WS_PUSH_KIND, "events.push");
    }
}
