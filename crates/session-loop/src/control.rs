//! 控制总线（B3.2，对齐 TS control/control-bus.ts + control/types.ts）
//!
//! Run 控制消息基础设施的 L3 队列面：控制意图（intent）入队，在
//! session-loop 安全点 drain 聚合，避免用 Abort 实现「想停就停」。
//!
//! L0-L3 协议级别（RunControlLevelCode）：
//! - L0 continue：继续当前 run（不入队）
//! - L1 soft inject（soft_inject / steer / follow_up）：注入消息，不打断流
//! - L2 cooperative_stop：协作停止，等安全点
//! - L3 force_cancel：强停，可立即中断
//!
//! drain 聚合优先级：force_cancel > cooperative_stop > soft_inject
//! （01 §2.10，对齐 core:control-bus.ts:270-315）。
//! L1 分环（对齐 pi）：soft_inject / steer → steer 环（下一安全点）；
//! follow_up → followUp 环（仅 run idle）。

use std::collections::VecDeque;
use std::time::{SystemTime, UNIX_EPOCH};

use conex_types::message::AgentMessage;
use serde::{Deserialize, Serialize};

/// 控制意图种类（对齐 TS RunControlKind）
///
/// continue / soft_inject / cooperative_stop / force_cancel 为共享协议 wire 名；
/// steer / follow_up 为运行时 L1 变体（分环）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlKind {
    /// L0：继续当前 run（不入队）
    Continue,
    /// L1：软注入（入 steer 环）
    SoftInject,
    /// L1 变体：下一安全点注入（入 steer 环，pi steer）
    Steer,
    /// L1 变体：仅 run idle 注入（入 followUp 环，pi followUp）
    FollowUp,
    /// L2：协作停止（等安全点，不打断）
    CooperativeStop,
    /// L3：强停（可立即中断）
    ForceCancel,
}

/// L0-L3 协议级别代号
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum ControlLevel {
    /// L0 continue：继续
    L0,
    /// L1 soft inject / steer / follow_up
    L1,
    /// L2 cooperative_stop
    L2,
    /// L3 force_cancel
    L3,
}

/// kind → 默认 L0-L3（steer / follow_up → L1；其余走共享 runControlLevelCode）
pub fn level_for_kind(kind: ControlKind) -> ControlLevel {
    match kind {
        ControlKind::Continue => ControlLevel::L0,
        ControlKind::SoftInject | ControlKind::Steer | ControlKind::FollowUp => ControlLevel::L1,
        ControlKind::CooperativeStop => ControlLevel::L2,
        ControlKind::ForceCancel => ControlLevel::L3,
    }
}

/// L1 注入类 kind（写入 input queue 的某一环）
pub fn is_l1_inject_kind(kind: ControlKind) -> bool {
    matches!(kind, ControlKind::SoftInject | ControlKind::Steer | ControlKind::FollowUp)
}

/// follow_up → followUp 环；soft_inject / steer → steer 环；其余无环
pub fn inject_ring_for_kind(kind: ControlKind) -> Option<RingChoice> {
    match kind {
        ControlKind::FollowUp => Some(RingChoice::FollowUp),
        ControlKind::SoftInject | ControlKind::Steer => Some(RingChoice::Steer),
        _ => None,
    }
}

/// L1 注入目标环
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RingChoice {
    /// 下一安全点消费（provider 结束 / tool 批后）
    Steer,
    /// 仅 run idle 消费（promote 后）
    FollowUp,
}

/// 控制总线队列中的单条控制意图（对齐 TS RunControlIntent）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ControlIntent {
    /// 稳定 id，可观测 / 可测
    pub id: String,
    pub kind: ControlKind,
    /// L0-L3 代号
    pub level: ControlLevel,
    /// 入队时间（ms epoch）
    pub created_at: u64,
    /// soft_inject / steer / follow_up 附带消息
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<AgentMessage>,
    /// 人类可读原因
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// 来源（ui / hook / policy / system）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// request() 入参：id / createdAt / level 可由总线补齐
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlIntentInput {
    pub kind: ControlKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<AgentMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<u64>,
    /// 省略时按 kind 推导 level
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<ControlLevel>,
}

impl ControlIntentInput {
    /// 最简入队入口（kind + 可选消息）
    pub fn new(kind: ControlKind) -> Self {
        Self {
            kind,
            message: None,
            reason: None,
            source: None,
            id: None,
            created_at: None,
            level: None,
        }
    }
}

/// drain 后的聚合动作（供 session-loop 一次决策，对齐 TS ControlDrainAction）
#[derive(Debug, Clone, PartialEq)]
pub enum ControlDrainAction {
    /// 无待处理意图
    None,
    /// L1 注入聚合（分环）
    SoftInject {
        /// 全部 L1 消息（steer + followUp），兼容既有消费者
        messages: Vec<AgentMessage>,
        /// soft_inject / steer → 下一安全点
        steer_messages: Vec<AgentMessage>,
        /// follow_up → 仅 idle
        follow_up_messages: Vec<AgentMessage>,
        intents: Vec<ControlIntent>,
    },
    /// L2 协作停止
    CooperativeStop {
        reason: Option<String>,
        intents: Vec<ControlIntent>,
        /// 若 stop 前还有 L1 注入，一并带上（默认入 steer 环）
        pending_messages: Vec<AgentMessage>,
    },
    /// L3 强停
    ForceCancel {
        reason: Option<String>,
        intents: Vec<ControlIntent>,
    },
}

/// 控制总线（对齐 TS ControlBus 的 L3 队列面）
///
/// 本任务范围只含 L3 意图队列（B3.2 产出：入队/peek/drainAsAction）；
/// L1 点对点 send / L2 事件订阅不属于 session-loop 内核，由上层另行实现。
#[derive(Debug, Clone, Default)]
pub struct ControlBus {
    queue: VecDeque<ControlIntent>,
    seq: u64,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl ControlBus {
    /// 新建空总线
    pub fn new() -> Self {
        Self::default()
    }

    /// 入队一条控制意图；返回规范化后的 intent。
    ///
    /// continue 不入队（对齐 TS：`kind === 'continue'` 直接返回）。
    pub fn request(&mut self, input: ControlIntentInput) -> ControlIntent {
        let kind = input.kind;
        self.seq += 1;
        let intent = ControlIntent {
            id: input.id.unwrap_or_else(|| format!("ctrl-{}-{}", now_millis(), self.seq)),
            kind,
            level: input.level.unwrap_or_else(|| level_for_kind(kind)),
            created_at: input.created_at.unwrap_or_else(now_millis),
            message: input.message,
            reason: input.reason,
            source: input.source,
        };
        if kind != ControlKind::Continue {
            self.queue.push_back(intent.clone());
        }
        intent
    }

    /// pi steer：下一安全点注入（与 soft_inject 同 L1 wire，入 steer 环）
    ///
    /// 注（T06.3 Q13）：`request_soft_inject` 兼容别名已删除——soft 即
    /// steer，统一以 steer 命名。
    pub fn request_steer(
        &mut self,
        message: AgentMessage,
        reason: Option<String>,
        source: Option<String>,
    ) -> ControlIntent {
        self.request(ControlIntentInput {
            kind: ControlKind::Steer,
            message: Some(message),
            reason,
            source,
            ..ControlIntentInput::new(ControlKind::Steer)
        })
    }

    /// pi followUp：仅 run idle 时注入
    pub fn request_follow_up(
        &mut self,
        message: AgentMessage,
        reason: Option<String>,
        source: Option<String>,
    ) -> ControlIntent {
        self.request(ControlIntentInput {
            kind: ControlKind::FollowUp,
            message: Some(message),
            reason,
            source,
            ..ControlIntentInput::new(ControlKind::FollowUp)
        })
    }

    /// L2 协作停止入队
    pub fn request_cooperative_stop(
        &mut self,
        reason: Option<String>,
        source: Option<String>,
    ) -> ControlIntent {
        self.request(ControlIntentInput {
            kind: ControlKind::CooperativeStop,
            reason,
            source,
            ..ControlIntentInput::new(ControlKind::CooperativeStop)
        })
    }

    /// L3 强停入队
    pub fn request_force_cancel(
        &mut self,
        reason: Option<String>,
        source: Option<String>,
    ) -> ControlIntent {
        self.request(ControlIntentInput {
            kind: ControlKind::ForceCancel,
            reason,
            source,
            ..ControlIntentInput::new(ControlKind::ForceCancel)
        })
    }

    /// 预览队首（不移除）
    pub fn peek(&self) -> Option<&ControlIntent> {
        self.queue.front()
    }

    /// 取出全部意图并清空队列
    pub fn drain(&mut self) -> Vec<ControlIntent> {
        self.queue.drain(..).collect()
    }

    /// 是否有待处理意图
    pub fn has_pending(&self) -> bool {
        !self.queue.is_empty()
    }

    /// 队列长度
    pub fn len(&self) -> usize {
        self.queue.len()
    }

    /// 是否为空
    pub fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }

    /// 清空队列
    pub fn clear(&mut self) {
        self.queue.clear();
    }

    /// 取出并聚合为单一动作（01 §2.10 优先级：force_cancel > cooperative_stop > soft_inject）
    pub fn drain_as_action(&mut self) -> ControlDrainAction {
        let intents = self.drain();
        if intents.is_empty() {
            return ControlDrainAction::None;
        }

        let force: Vec<&ControlIntent> = intents
            .iter()
            .filter(|i| i.kind == ControlKind::ForceCancel)
            .collect();
        if !force.is_empty() {
            // 取最后一条的 reason（对齐 TS `force[force.length - 1]`）
            return ControlDrainAction::ForceCancel {
                reason: force.last().and_then(|i| i.reason.clone()),
                intents,
            };
        }

        let stop: Vec<&ControlIntent> = intents
            .iter()
            .filter(|i| i.kind == ControlKind::CooperativeStop)
            .collect();
        let inject_intents: Vec<&ControlIntent> = intents
            .iter()
            .filter(|i| is_l1_inject_kind(i.kind) && i.message.is_some())
            .collect();
        let steer_messages: Vec<AgentMessage> = inject_intents
            .iter()
            .filter(|i| inject_ring_for_kind(i.kind) == Some(RingChoice::Steer))
            .filter_map(|i| i.message.clone())
            .collect();
        let follow_up_messages: Vec<AgentMessage> = inject_intents
            .iter()
            .filter(|i| inject_ring_for_kind(i.kind) == Some(RingChoice::FollowUp))
            .filter_map(|i| i.message.clone())
            .collect();
        let mut messages = steer_messages.clone();
        messages.extend(follow_up_messages.iter().cloned());

        if !stop.is_empty() {
            return ControlDrainAction::CooperativeStop {
                reason: stop.last().and_then(|i| i.reason.clone()),
                intents,
                pending_messages: messages,
            };
        }

        if !messages.is_empty() {
            return ControlDrainAction::SoftInject {
                messages,
                steer_messages,
                follow_up_messages,
                intents,
            };
        }

        ControlDrainAction::None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(text: &str) -> AgentMessage {
        AgentMessage {
            id: format!("m-{text}"),
            role: conex_types::message::AgentMessageRole::User,
            created_at: "2026-01-01T00:00:00Z".into(),
            blocks: vec![conex_types::message::AgentMessageBlock::Text {
                text: text.into(),
            }],
            metadata: None,
            client_message_id: None,
            content: None,
        }
    }

    /// 05 §2.2：request 入队并补齐 id/level/createdAt（对齐 control-bus.test.ts:8）
    #[test]
    fn request_normalizes_id_level_created_at() {
        let mut bus = ControlBus::new();
        let intent = bus.request_force_cancel(Some("user hit stop".to_string()), Some("ui".to_string()));
        assert!(!intent.id.is_empty(), "id 由总线补齐");
        assert_eq!(intent.level, ControlLevel::L3);
        assert!(intent.created_at > 0, "createdAt 由总线补齐");
        assert_eq!(bus.len(), 1);
        assert!(bus.has_pending());
        assert_eq!(bus.peek().expect("队首").kind, ControlKind::ForceCancel);

        // 显式传入 id/level/createdAt 则保留
        let input = ControlIntentInput {
            kind: ControlKind::SoftInject,
            message: Some(msg("x")),
            id: Some("fixed-1".into()),
            level: Some(ControlLevel::L1),
            created_at: Some(42),
            ..ControlIntentInput::new(ControlKind::SoftInject)
        };
        let intent = bus.request(input);
        assert_eq!(intent.id, "fixed-1");
        assert_eq!(intent.level, ControlLevel::L1);
        assert_eq!(intent.created_at, 42);
    }

    /// level_for_kind 默认映射（L0-L3）
    #[test]
    fn level_defaults_per_kind() {
        assert_eq!(level_for_kind(ControlKind::Continue), ControlLevel::L0);
        assert_eq!(level_for_kind(ControlKind::SoftInject), ControlLevel::L1);
        assert_eq!(level_for_kind(ControlKind::Steer), ControlLevel::L1);
        assert_eq!(level_for_kind(ControlKind::FollowUp), ControlLevel::L1);
        assert_eq!(level_for_kind(ControlKind::CooperativeStop), ControlLevel::L2);
        assert_eq!(level_for_kind(ControlKind::ForceCancel), ControlLevel::L3);
    }

    /// continue 不入队（对齐 TS：直接返回，不 push）
    #[test]
    fn continue_kind_is_not_queued() {
        let mut bus = ControlBus::new();
        let intent = bus.request(ControlIntentInput::new(ControlKind::Continue));
        assert_eq!(intent.level, ControlLevel::L0);
        assert!(!bus.has_pending());
        assert!(bus.is_empty());
    }

    /// 05 §2.2：drainAsAction — force_cancel 优先于 cooperative_stop
    /// （对齐 control-bus.test.ts:44）
    #[test]
    fn drain_as_action_force_cancel_wins() {
        let mut bus = ControlBus::new();
        bus.request_cooperative_stop(Some("enough".to_string()), None);
        bus.request_force_cancel(Some("user cancel".to_string()), Some("ui".to_string()));
        bus.request_steer(msg("bye"), None, None);

        match bus.drain_as_action() {
            ControlDrainAction::ForceCancel { reason, intents } => {
                assert_eq!(reason.as_deref(), Some("user cancel"));
                assert_eq!(intents.len(), 3, "全部意图一并带出");
            }
            other => panic!("应为 ForceCancel，实际 {other:?}"),
        }
        assert!(!bus.has_pending(), "drain 后队列清空");
    }

    /// 05 §2.2：cooperative_stop 带 pending soft messages
    /// （对齐 control-bus.test.ts:56）
    #[test]
    fn cooperative_stop_carries_pending_messages() {
        let mut bus = ControlBus::new();
        bus.request_cooperative_stop(Some("done".to_string()), None);
        bus.request_steer(msg("next-prompt"), None, None);
        bus.request_follow_up(msg("later"), None, None);

        match bus.drain_as_action() {
            ControlDrainAction::CooperativeStop {
                reason,
                pending_messages,
                intents,
            } => {
                assert_eq!(reason.as_deref(), Some("done"));
                assert_eq!(pending_messages.len(), 2, "stop 前 L1 消息一并带上");
                assert_eq!(intents.len(), 3);
            }
            other => panic!("应为 CooperativeStop，实际 {other:?}"),
        }
    }

    /// 05 §2.2：steer 与 follow_up 分环（对齐 control-bus.test.ts:83）
    #[test]
    fn soft_inject_splits_rings() {
        let mut bus = ControlBus::new();
        bus.request_steer(msg("steer-a"), None, None);
        bus.request_steer(msg("steer-b"), None, None);
        bus.request_follow_up(msg("follow-1"), None, None);

        match bus.drain_as_action() {
            ControlDrainAction::SoftInject {
                messages,
                steer_messages,
                follow_up_messages,
                intents,
            } => {
                assert_eq!(steer_messages.len(), 2, "steer 环 2 条");
                assert_eq!(follow_up_messages.len(), 1, "followUp 环 1 条");
                assert_eq!(messages.len(), 3, "全部消息 = steer + followUp");
                assert_eq!(intents.len(), 3);
                assert_eq!(messages[2].text(), "follow-1", "followUp 排在末尾");
            }
            other => panic!("应为 SoftInject，实际 {other:?}"),
        }
    }

    /// 空队列 → None
    #[test]
    fn empty_bus_drains_to_none() {
        let mut bus = ControlBus::new();
        assert_eq!(bus.drain_as_action(), ControlDrainAction::None);
    }

    /// 只有 continue 的队列 → None（不入队，drain 空）
    #[test]
    fn only_continue_drains_to_none() {
        let mut bus = ControlBus::new();
        bus.request(ControlIntentInput::new(ControlKind::Continue));
        assert_eq!(bus.drain_as_action(), ControlDrainAction::None);
    }

    /// 无 L1 消息的混合队列（如仅 cooperative_stop + continue）→ cooperative_stop
    #[test]
    fn cooperative_stop_without_inject_still_returns_stop() {
        let mut bus = ControlBus::new();
        bus.request_cooperative_stop(None, None);
        match bus.drain_as_action() {
            ControlDrainAction::CooperativeStop { pending_messages, .. } => {
                assert!(pending_messages.is_empty());
            }
            other => panic!("应为 CooperativeStop，实际 {other:?}"),
        }
    }

    /// clear / len / drain 基础语义
    #[test]
    fn clear_len_drain() {
        let mut bus = ControlBus::new();
        bus.request_force_cancel(None, None);
        bus.request_cooperative_stop(None, None);
        assert_eq!(bus.len(), 2);
        let drained = bus.drain();
        assert_eq!(drained.len(), 2);
        assert!(bus.is_empty());
        bus.request_force_cancel(None, None);
        bus.clear();
        assert!(bus.is_empty());
    }

    /// 序列化：wire 名与 TS 一致（kind 用 snake_case，level 用 L0-L3）
    #[test]
    fn intent_serializes_to_ts_wire_names() {
        let mut bus = ControlBus::new();
        let intent = bus.request_steer(msg("s"), None, None);
        let json = serde_json::to_value(&intent).unwrap();
        assert_eq!(json["kind"], "steer");
        assert_eq!(json["level"], "L1");
        assert_eq!(json["message"]["id"], "m-s");

        let cancel = bus.request_force_cancel(Some("r".to_string()), Some("ui".to_string()));
        let json = serde_json::to_value(&cancel).unwrap();
        assert_eq!(json["kind"], "force_cancel");
        assert_eq!(json["level"], "L3");
        assert_eq!(json["reason"], "r");
        assert_eq!(json["source"], "ui");
    }
}
