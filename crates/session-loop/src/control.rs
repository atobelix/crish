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
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use conex_shared::time::now_iso_utc;
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

impl ControlKind {
    /// control-intent 事件 kind 载荷（EV-04 / D-03：soft-inject 聚合
    /// steer / follow_up / soft_inject 三运行时变体；其余一一对应）
    pub fn as_event_kind(&self) -> &'static str {
        match self {
            ControlKind::SoftInject | ControlKind::Steer | ControlKind::FollowUp => "soft-inject",
            ControlKind::CooperativeStop => "cooperative-stop",
            ControlKind::ForceCancel => "force-cancel",
            ControlKind::Continue => "continue",
        }
    }
}

/// L1 注入类 kind（写入 input queue 的某一环）
pub fn is_l1_inject_kind(kind: ControlKind) -> bool {
    matches!(
        kind,
        ControlKind::SoftInject | ControlKind::Steer | ControlKind::FollowUp
    )
}

/// follow_up → followUp 环；soft_inject / steer → steer 环；其余无环
pub fn inject_ring_for_kind(kind: ControlKind) -> Option<RingChoice> {
    match kind {
        ControlKind::FollowUp => Some(RingChoice::FollowUp),
        ControlKind::SoftInject | ControlKind::Steer => Some(RingChoice::Steer),
        _ => None,
    }
}

// ── C8/M8：运行中注入（wait 期间主 agent 向子代理注入提示词）──────

/// 子代理注入消息自增序号（id 唯一性，与 create_at 共用防同毫秒碰撞）
static SUBAGENT_INJECT_SEQ: AtomicU64 = AtomicU64::new(0);

/// 子代理注入消息构造（C8 §2.2：执行期可注入不打断流）
///
/// user 角色文本消息，经目标 run 的 L1 steer 环在下一安全点注入——
/// transfer 到 steer 环语义（pi steer）；id 带子代理标识与自增序号，
/// 保证可观测可测。created_at 与 steering 侧同源（now_iso_utc）。
pub fn subagent_inject_message(subagent_id: &str, prompt: &str) -> AgentMessage {
    let seq = SUBAGENT_INJECT_SEQ.fetch_add(1, Ordering::Relaxed);
    AgentMessage {
        id: format!("subagent-inject:{subagent_id}:{seq}"),
        role: conex_types::message::AgentMessageRole::User,
        created_at: now_iso_utc(),
        blocks: vec![conex_types::message::AgentMessageBlock::Text {
            text: prompt.to_string(),
        }],
        metadata: None,
        client_message_id: None,
        content: None,
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
///
/// EV-04（D-03）入队观测：request() 无 session 上下文无法直接发射
/// control-intent 事件，故在总线内保留 enqueued 态轨迹（[Self::take_trace]），
/// 由会话事件面（loop/handlers check_control 安全点）取走并发射——
/// 与 consumed 态同一次安全点发射，intent_id 两态配对。
#[derive(Debug, Clone, Default)]
pub struct ControlBus {
    queue: VecDeque<ControlIntent>,
    seq: u64,
    /// EV-04（D-03）：入队观测轨迹——request() 记录非 continue 意图，
    /// check_control 安全点经 [Self::take_trace] 取走发射
    /// control-intent(enqueued)；continue 不入队不记录。
    trace: VecDeque<ControlIntent>,
    /// BC03-1 / BC03-2：可选绑定的 Run 级 AbortSignal；在 L3 强停入队时立即广播触发
    abort_signal: Option<crate::safe_point::AbortSignal>,
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

    /// 绑定 Run 级 AbortSignal：当总线接收到 L3 强停时，自动物理触发信号 abort()
    pub fn attach_abort_signal(&mut self, signal: crate::safe_point::AbortSignal) {
        self.abort_signal = Some(signal);
    }

    /// 获取绑定的 AbortSignal
    pub fn abort_signal(&self) -> Option<&crate::safe_point::AbortSignal> {
        self.abort_signal.as_ref()
    }

    /// 入队一条控制意图；返回规范化后的 intent。
    ///
    /// continue 不入队（对齐 TS：`kind === 'continue'` 直接返回）。
    pub fn request(&mut self, input: ControlIntentInput) -> ControlIntent {
        let kind = input.kind;
        if kind == ControlKind::ForceCancel {
            if let Some(sig) = &self.abort_signal {
                sig.abort();
            }
        }
        self.seq += 1;
        let intent = ControlIntent {
            id: input
                .id
                .unwrap_or_else(|| format!("ctrl-{}-{}", now_millis(), self.seq)),
            kind,
            level: input.level.unwrap_or_else(|| level_for_kind(kind)),
            created_at: input.created_at.unwrap_or_else(now_millis),
            message: input.message,
            reason: input.reason,
            source: input.source,
        };
        if kind != ControlKind::Continue {
            self.queue.push_back(intent.clone());
            // EV-04（D-03）：入队观测轨迹（事件发射在安全点 check_control）
            self.trace.push_back(intent.clone());
        }
        intent
    }

    /// EV-04（D-03）：取走全部入队观测轨迹（enqueued 态事件素材；消费侧
    /// 在安全点先取走再 drain——幂等，重复调用只返回新增轨迹）
    pub fn take_trace(&mut self) -> Vec<ControlIntent> {
        self.trace.drain(..).collect()
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

    /// C8/M8：wait 期间主 agent 向子代理注入提示词——经 L1 steer 环
    /// transfer 到目标 run 的下一安全点（不打断流，无 L2/L3）；
    /// reason 携带 `subagent_inject:<id>` 可观测标识。
    ///
    /// 注：本总线为注入目标 run（子代理 run）的实例；主 agent 侧按
    /// 子代理 run 定位其总线后调用。L3 强停仍优先（drain_as_action
    /// 聚合优先级不变，control.rs:315 语义）。
    pub fn request_subagent_inject(
        &mut self,
        subagent_id: &str,
        prompt: &str,
        source: Option<&str>,
    ) -> ControlIntent {
        self.request_steer(
            subagent_inject_message(subagent_id, prompt),
            Some(format!("subagent_inject:{subagent_id}")),
            source.map(str::to_string),
        )
    }

    /// T-D-09：kill_all / resume_subagent 向子代理 run 投递 L3 强停——
    /// 直连 [Self::request_force_cancel]（L3 队列面），reason 携带
    /// `subagent_force_cancel:<run_id>` 可观测标识（与注入信封
    /// `subagent_inject:<id>` 同风格）。
    ///
    /// 注：本总线为被杀目标 run（子代理 run）的实例；引擎侧按
    /// subagent_run_id 定位其总线后调用。L0-L3 协议与聚合优先级
    /// 不变（force_cancel > cooperative_stop > soft_inject）。
    pub fn request_subagent_force_cancel(
        &mut self,
        subagent_run_id: &str,
        source: Option<&str>,
    ) -> ControlIntent {
        self.request_force_cancel(
            Some(format!("subagent_force_cancel:{subagent_run_id}")),
            source.map(str::to_string),
        )
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
        if !stop.is_empty() {
            let reason = stop.last().and_then(|i| i.reason.clone());
            let mut pending_messages = steer_messages;
            pending_messages.extend(follow_up_messages);
            return ControlDrainAction::CooperativeStop {
                reason,
                intents,
                pending_messages,
            };
        }

        if !steer_messages.is_empty() || !follow_up_messages.is_empty() {
            return ControlDrainAction::SoftInject {
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
            blocks: vec![conex_types::message::AgentMessageBlock::Text { text: text.into() }],
            metadata: None,
            client_message_id: None,
            content: None,
        }
    }

    /// 05 §2.2：request 入队并补齐 id/level/createdAt（对齐 control-bus.test.ts:8）
    #[test]
    fn request_normalizes_id_level_created_at() {
        let mut bus = ControlBus::new();
        let intent =
            bus.request_force_cancel(Some("user hit stop".to_string()), Some("ui".to_string()));
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
        assert_eq!(
            level_for_kind(ControlKind::CooperativeStop),
            ControlLevel::L2
        );
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
                steer_messages,
                follow_up_messages,
                intents,
            } => {
                assert_eq!(steer_messages.len(), 2, "steer 环 2 条");
                assert_eq!(follow_up_messages.len(), 1, "followUp 环 1 条");
                assert_eq!(intents.len(), 3);
                assert_eq!(follow_up_messages[0].text(), "follow-1", "followUp 独立成环");
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
            ControlDrainAction::CooperativeStop {
                pending_messages, ..
            } => {
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

    // ── EV-04（D-03）：入队观测轨迹（control-intent enqueued 态素材）──

    /// 入队轨迹：非 continue 意图 request 即记录（含 id/source/reason 供
    /// 事件载荷）；continue 不入队不记录；take_trace 幂等（只取新增）
    #[test]
    fn trace_records_enqueued_intents_and_is_idempotent() {
        let mut bus = ControlBus::new();
        // continue 不入队不记录
        bus.request(ControlIntentInput::new(ControlKind::Continue));
        assert!(bus.take_trace().is_empty(), "continue 不得记录轨迹");
        // L2 协作停止：reason/source 随轨迹保留（cooperative_stop 的
        // reason 不再丢弃，EV-04 验收）
        let stop =
            bus.request_cooperative_stop(Some("用户协作停止".to_string()), Some("ui".to_string()));
        let l1 = bus.request_steer(msg("提示"), Some("subagent_inject:sub-1".into()), None);
        let trace = bus.take_trace();
        assert_eq!(trace.len(), 2, "两条非 continue 意图入队轨迹");
        assert_eq!(trace[0].id, stop.id);
        assert_eq!(trace[0].reason.as_deref(), Some("用户协作停止"));
        assert_eq!(trace[0].source.as_deref(), Some("ui"));
        assert_eq!(trace[1].id, l1.id);
        assert_eq!(trace[1].reason.as_deref(), Some("subagent_inject:sub-1"));
        // 幂等：取走后再次取为空；新请求只返回新增
        assert!(bus.take_trace().is_empty());
        bus.request_force_cancel(None, None);
        let trace2 = bus.take_trace();
        assert_eq!(trace2.len(), 1, "只返回新增轨迹");
        assert_eq!(trace2[0].kind, ControlKind::ForceCancel);
    }

    /// 事件 kind 载荷映射（soft-inject 聚合 steer/follow_up/soft_inject）
    #[test]
    fn event_kind_maps_runtime_variants_to_wire_kinds() {
        assert_eq!(ControlKind::SoftInject.as_event_kind(), "soft-inject");
        assert_eq!(ControlKind::Steer.as_event_kind(), "soft-inject");
        assert_eq!(ControlKind::FollowUp.as_event_kind(), "soft-inject");
        assert_eq!(
            ControlKind::CooperativeStop.as_event_kind(),
            "cooperative-stop"
        );
        assert_eq!(ControlKind::ForceCancel.as_event_kind(), "force-cancel");
        assert_eq!(ControlKind::Continue.as_event_kind(), "continue");
    }

    // ── C8/M8：运行中注入（wait 期间向子代理注入提示词）──────────

    /// 注入走 L1 steer 环：drain 聚合为 SoftInject，消息进入 steer 环，
    /// 不产生任何 L2/L3 动作
    #[test]
    fn subagent_inject_lands_in_steer_ring() {
        let mut bus = ControlBus::new();
        let intent =
            bus.request_subagent_inject("sub-1", "调整方向：优先低风险改动", Some("subagent_wait"));
        assert_eq!(intent.kind, ControlKind::Steer);
        assert_eq!(intent.level, ControlLevel::L1);
        assert_eq!(intent.reason.as_deref(), Some("subagent_inject:sub-1"));
        assert_eq!(intent.source.as_deref(), Some("subagent_wait"));

        match bus.drain_as_action() {
            ControlDrainAction::SoftInject {
                steer_messages,
                follow_up_messages,
                ..
            } => {
                assert!(
                    follow_up_messages.is_empty(),
                    "注入只走 steer 环，不进 followUp 环"
                );
                assert_eq!(steer_messages.len(), 1);
                assert_eq!(steer_messages[0].text(), "调整方向：优先低风险改动");
            }
            other => panic!("注入应聚合为 SoftInject（L1），实际 {other:?}"),
        }
    }

    /// 等待期间注入不打断流：多次注入 + 无 L2/L3 意图时，drain 结果恒为
    /// SoftInject（C8 §2.2：不触发 L2/L3）
    #[test]
    fn subagent_inject_during_wait_is_soft_only() {
        let mut bus = ControlBus::new();
        bus.request_subagent_inject("sub-1", "提示 A", None);
        bus.request_subagent_inject("sub-2", "提示 B", None);
        match bus.drain_as_action() {
            ControlDrainAction::SoftInject { steer_messages, .. } => {
                assert_eq!(steer_messages.len(), 2);
                assert_eq!(steer_messages[0].text(), "提示 A");
                assert_eq!(steer_messages[1].text(), "提示 B", "注入顺序保持");
            }
            other => panic!("应为 SoftInject，实际 {other:?}"),
        }
    }

    /// L3 强停优先（control.rs:315 drain 聚合优先级）：注入与强停并存时
    /// 强停胜出，注入消息随强停一并带出
    #[test]
    fn force_cancel_still_beats_subagent_inject() {
        let mut bus = ControlBus::new();
        bus.request_subagent_inject("sub-1", "提示 A", None);
        bus.request_force_cancel(Some("user cancel".to_string()), Some("ui".to_string()));
        match bus.drain_as_action() {
            ControlDrainAction::ForceCancel { reason, intents } => {
                assert_eq!(reason.as_deref(), Some("user cancel"));
                assert_eq!(intents.len(), 2, "注入意图随强停一并带出");
            }
            other => panic!("L3 强停应优先于 L1 注入，实际 {other:?}"),
        }
    }

    /// 注入消息信封：user 角色 + 文本块 + 幂等 id（含子代理标识）
    #[test]
    fn subagent_inject_message_shape() {
        let m1 = subagent_inject_message("sub-1", "调整方向");
        assert_eq!(m1.role, conex_types::message::AgentMessageRole::User);
        assert!(
            m1.id.starts_with("subagent-inject:sub-1:"),
            "id 带子代理标识"
        );
        assert_eq!(m1.text(), "调整方向");
        // 同毫秒两次注入 id 不碰撞（自增序号）
        let m2 = subagent_inject_message("sub-1", "继续");
        assert_ne!(m1.id, m2.id);
    }

    // ── T-D-09：kill_all / resume 的 L3 强停投递信封 ──────────────

    /// kill_all / resume 投递 L3 强停：reason 携带 run 标识、drain 聚合
    /// 为 ForceCancel（聚合优先级不变），不入 steer/followUp 环
    #[test]
    fn subagent_force_cancel_envelope_is_l3() {
        let mut bus = ControlBus::new();
        let intent = bus.request_subagent_force_cancel("run-9", Some("kill_all"));
        assert_eq!(intent.kind, ControlKind::ForceCancel);
        assert_eq!(intent.level, ControlLevel::L3);
        assert_eq!(
            intent.reason.as_deref(),
            Some("subagent_force_cancel:run-9")
        );
        assert_eq!(intent.source.as_deref(), Some("kill_all"));
        match bus.drain_as_action() {
            ControlDrainAction::ForceCancel { reason, .. } => {
                assert_eq!(reason.as_deref(), Some("subagent_force_cancel:run-9"));
            }
            other => panic!("L3 强停应聚合为 ForceCancel：{other:?}"),
        }
    }

    #[test]
    fn force_cancel_triggers_attached_abort_signal() {
        let mut bus = ControlBus::new();
        let signal = crate::safe_point::AbortSignal::new();
        bus.attach_abort_signal(signal.clone());
        assert!(!signal.is_aborted());
        bus.request_force_cancel(Some("test-stop".into()), None);
        assert!(signal.is_aborted());
    }

    #[test]
    fn subagent_force_cancel_triggers_attached_abort_signal() {
        let mut bus = ControlBus::new();
        let signal = crate::safe_point::AbortSignal::new();
        bus.attach_abort_signal(signal.clone());
        assert!(!signal.is_aborted());
        bus.request_subagent_force_cancel("sub-1", Some("kill_all"));
        assert!(signal.is_aborted());
    }
}
