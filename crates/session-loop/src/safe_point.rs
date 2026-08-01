//! 安全点控制检查（B3.2，对齐 TS session-loop/control-check.ts + 01 §2.10）
//!
//! 在 provider 消费结束、tool 批处理后的安全点调用，把 ControlBus 意图
//! 映射为循环动作，避免把 force abort 与 cooperative stop 混为一谈。
//!
//! 安全点语义（01 §2.10 / §五.5）：
//! - force_cancel（L3）：可立即中断流 → [ControlAction::ForceCancel]
//!   （endReason = aborted）
//! - cooperative_stop（L2）：不触发 abort，等安全点 → [ControlAction::CooperativeStop]
//!   （endReason = stopped，D1 裁决：协作停止 ≠ 错误也不等于取消）
//! - soft_inject（L1）：只读消费（drain 出消息），不打断流 →
//!   [ControlAction::SoftInject]，消息由上层写入 input queue 对应环
//!   （steer 环 / followUp 环）
//! - AbortSignal 已触发等价于 L3 强停，优先于总线内任何意图。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use conex_types::message::AgentMessage;
#[cfg(test)]
use conex_types::session::AgentEndReason;
use tokio::sync::Notify;

use crate::control::{ControlBus, ControlDrainAction};
#[cfg(test)]
use crate::control::{RingChoice, inject_ring_for_kind};

/// 简易中止信号（对齐 TS AbortSignal 的 is_aborted 语义）
///
/// 共享 [AtomicBool] 状态 + 触发通知，可 Clone 传递；线程安全。
/// [Self::wait_aborted] 供长等待方（工具执行 timeout 竞速等，T09.9 Q21）
/// 在 abort 触发时及时醒来，避免等完整超时才生效。
#[derive(Debug, Clone, Default)]
pub struct AbortSignal {
    aborted: Arc<AtomicBool>,
    /// 触发通知（notify_waiters 广播；wait_aborted 竞速等待用）
    notify: Arc<Notify>,
}

impl AbortSignal {
    /// 新建未触发的中止信号
    pub fn new() -> Self {
        Self::default()
    }

    /// 触发中止
    pub fn abort(&self) {
        self.aborted.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    /// 是否已触发
    pub fn is_aborted(&self) -> bool {
        self.aborted.load(Ordering::SeqCst)
    }

    /// 等待 abort 触发（已触发立即返回）。
    ///
    /// 竞速语义：与长等待 future（timeout 等）并置时 abort 触发即返回，
    /// 调用方随即走取消收场（T09.9 Q21）。双重 is_aborted 复查兜住
    /// Notify 注册窗口内触发的情形（tokio Notify 标准防丢通知模式）。
    pub async fn wait_aborted(&self) {
        if self.is_aborted() {
            return;
        }
        let notified = self.notify.notified();
        if self.is_aborted() {
            return;
        }
        notified.await;
    }
}

/// 安全点检查后的循环动作（对齐 TS SafePointControlResult）
#[derive(Debug, Clone, PartialEq)]
pub enum ControlAction {
    /// L3 强停：可立即中断流（endReason = aborted）
    ForceCancel {
        reason: Option<String>,
    },
    /// L2 协作停止：等安全点推 SM 到 done，不 abort（endReason = stopped，D1）
    CooperativeStop {
        reason: Option<String>,
        /// stop 前若有 L1 消息仍保留（便于观测 / 下次续跑；默认入 steer 环）
        pending_messages: Vec<AgentMessage>,
    },
    /// L1 软注入：只读消费，不打断流；消息由上层写入输入队列对应环
    SoftInject {
        steer_messages: Vec<AgentMessage>,
        follow_up_messages: Vec<AgentMessage>,
    },
}

impl ControlAction {
    /// 本动作对应的收场 reason（None = 不改变收场，继续 run）
    ///
    /// - force_cancel → aborted（用户取消 / L3 强停）
    /// - cooperative_stop → stopped（D1 独立 reason：协作停止）
    /// - soft_inject → None（不打断流）
    ///
    /// T06.3 Q06：生产零消费（check_control 内联落环），仅测试使用
    #[cfg(test)]
    pub fn end_reason(&self) -> Option<AgentEndReason> {
        match self {
            ControlAction::ForceCancel { .. } => Some(AgentEndReason::Aborted),
            ControlAction::CooperativeStop { .. } => Some(AgentEndReason::Stopped),
            ControlAction::SoftInject { .. } => None,
        }
    }
}

/// 安全点检查：drain 控制总线意图并映射为循环动作。
///
/// 优先级：AbortSignal（已触发）> force_cancel > cooperative_stop > soft_inject
/// （01 §2.10 L3 drain 优先级）。soft_inject 只读消费：只取出消息返回，
/// 不写入输入队列、不改变收场（对齐 TS mapDrainAction 的注入侧语义，
/// 但消息落环交给上层主循环，本函数保持无副作用于流本身）。
pub fn apply_safe_point_control(
    bus: &mut ControlBus,
    abort_signal: Option<&AbortSignal>,
) -> Option<ControlAction> {
    // AbortSignal 等价 L3 强停（对齐 core:index.ts:293-299 抢占检查）
    if let Some(signal) = abort_signal {
        if signal.is_aborted() {
            return Some(ControlAction::ForceCancel { reason: None });
        }
    }

    match bus.drain_as_action() {
        ControlDrainAction::None => None,
        ControlDrainAction::ForceCancel { reason, .. } => {
            Some(ControlAction::ForceCancel { reason })
        }
        ControlDrainAction::CooperativeStop {
            reason,
            pending_messages,
            ..
        } => Some(ControlAction::CooperativeStop {
            reason,
            pending_messages,
        }),
        ControlDrainAction::SoftInject {
            steer_messages,
            follow_up_messages,
            ..
        } => Some(ControlAction::SoftInject {
            steer_messages,
            follow_up_messages,
        }),
    }
}

/// 把 L1 消息按环写入输入队列（安全点动作的落环侧）
///
/// steer 环 → 下一安全点消费；followUp 环 → 仅 run idle promote 后消费。
/// 主循环在 check_control 内联落环（本函数生产零消费，T06.3 Q06 标注：
/// 仅测试使用）。
#[cfg(test)]
pub fn write_inject_messages(
    queue: &mut crate::input::AgentInputQueue,
    action: &ControlAction,
) -> usize {
    match action {
        ControlAction::SoftInject {
            steer_messages,
            follow_up_messages,
        } => {
            let n = steer_messages.len() + follow_up_messages.len();
            for m in steer_messages {
                queue.enqueue_steer(m.clone());
            }
            for m in follow_up_messages {
                queue.enqueue_follow_up(m.clone());
            }
            n
        }
        ControlAction::CooperativeStop { pending_messages, .. } => {
            // stop 路径：默认入 steer（下一次 run 可立刻看到），不拆 followUp
            let n = pending_messages.len();
            for m in pending_messages {
                queue.enqueue_steer(m.clone());
            }
            n
        }
        _ => 0,
    }
}

/// 环名取数辅助（供上层按 TS injectRingForKind 语义使用）
///
/// T06.3 Q06：生产零消费（check_control 内联落环），仅测试使用
#[cfg(test)]
pub fn ring_for_kind(kind: crate::control::ControlKind) -> Option<RingChoice> {
    inject_ring_for_kind(kind)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control::{ControlKind, ControlIntentInput};
    use crate::input::AgentInputQueue;
    use crate::state::AgentSessionMachine;
    use conex_types::message::AgentMessageRole;
    use conex_types::session::{AgentSessionEvent as E, AgentSessionState as S};

    fn msg(text: &str) -> AgentMessage {
        AgentMessage {
            id: format!("m-{text}"),
            role: AgentMessageRole::User,
            created_at: "2026-01-01T00:00:00Z".into(),
            blocks: vec![conex_types::message::AgentMessageBlock::Text {
                text: text.into(),
            }],
            metadata: None,
            client_message_id: None,
            content: None,
        }
    }

    /// 空总线 + 无 abort 信号 → None（继续 run）
    #[test]
    fn empty_bus_returns_none() {
        let mut bus = ControlBus::new();
        assert_eq!(apply_safe_point_control(&mut bus, None), None);
        assert!(apply_safe_point_control(&mut bus, Some(&AbortSignal::new())).is_none());
    }

    /// force_cancel → ForceCancel + endReason=aborted（05 §2.2 对齐 control-check.test.ts:17）
    #[test]
    fn force_cancel_yields_aborted() {
        let mut bus = ControlBus::new();
        bus.request_force_cancel(Some("user stop".to_string()), Some("ui".to_string()));
        let action = apply_safe_point_control(&mut bus, None).expect("应有动作");
        assert_eq!(
            action,
            ControlAction::ForceCancel {
                reason: Some("user stop".into())
            }
        );
        assert_eq!(action.end_reason(), Some(AgentEndReason::Aborted));
    }

    /// cooperative_stop → CooperativeStop + endReason=stopped（D1：非 abort）
    #[test]
    fn cooperative_stop_yields_stopped() {
        let mut bus = ControlBus::new();
        bus.request_cooperative_stop(Some("enough".to_string()), None);
        bus.request_steer(msg("next-prompt"), None, None);
        let action = apply_safe_point_control(&mut bus, None).expect("应有动作");
        match &action {
            ControlAction::CooperativeStop {
                reason,
                pending_messages,
            } => {
                assert_eq!(reason.as_deref(), Some("enough"));
                assert_eq!(pending_messages.len(), 1, "stop 前 L1 消息保留");
            }
            other => panic!("应为 CooperativeStop，实际 {other:?}"),
        }
        assert_eq!(action.end_reason(), Some(AgentEndReason::Stopped));
        assert_ne!(action.end_reason(), Some(AgentEndReason::Aborted), "协作停止不是取消");
    }

    /// soft_inject 只读消费（不打断流）：end_reason = None
    #[test]
    fn soft_inject_is_read_only_and_does_not_stop() {
        let mut bus = ControlBus::new();
        bus.request_steer(msg("steer-1"), None, None);
        bus.request_follow_up(msg("follow-1"), None, None);
        let action = apply_safe_point_control(&mut bus, None).expect("应有动作");
        match &action {
            ControlAction::SoftInject {
                steer_messages,
                follow_up_messages,
            } => {
                assert_eq!(steer_messages.len(), 1);
                assert_eq!(follow_up_messages.len(), 1);
            }
            other => panic!("应为 SoftInject，实际 {other:?}"),
        }
        assert_eq!(action.end_reason(), None, "soft_inject 不改变收场");
    }

    /// AbortSignal 已触发 → 等价 L3 强停（即使总线为空）
    #[test]
    fn abort_signal_preempts_bus() {
        let signal = AbortSignal::new();
        let mut bus = ControlBus::new();
        bus.request_cooperative_stop(Some("soft".to_string()), None);
        signal.abort();
        let action = apply_safe_point_control(&mut bus, Some(&signal)).expect("应有动作");
        assert_eq!(action.end_reason(), Some(AgentEndReason::Aborted));

        // 未触发的信号不抢占
        let signal2 = AbortSignal::new();
        let action = apply_safe_point_control(&mut bus, Some(&signal2)).expect("应有动作");
        assert!(matches!(action, ControlAction::CooperativeStop { .. }));
    }

    /// 安全点优先级：force_cancel > cooperative_stop > soft_inject
    #[test]
    fn safe_point_priority_matches_drain() {
        let mut bus = ControlBus::new();
        bus.request_cooperative_stop(None, None);
        bus.request_force_cancel(Some("L3".to_string()), None);
        let action = apply_safe_point_control(&mut bus, None).expect("应有动作");
        assert!(matches!(action, ControlAction::ForceCancel { .. }), "force 优先");
    }

    /// 注入落环：steer → steer 环、followUp → followUp 环（对齐 control-check.test.ts:39/53）
    #[test]
    fn inject_messages_land_on_correct_rings() {
        let mut bus = ControlBus::new();
        bus.request_steer(msg("s1"), None, None);
        bus.request_follow_up(msg("f1"), None, None);
        let action = apply_safe_point_control(&mut bus, None).unwrap();

        let mut queue = AgentInputQueue::new();
        let n = write_inject_messages(&mut queue, &action);
        assert_eq!(n, 2);
        assert!(queue.has_steer_pending());
        assert!(queue.has_follow_up_pending());
        assert!(queue.has_runnable_pending(), "steer 环可运行输入存在");
        // steer 可被 dequeue；followUp 保持挂起直至 promote
        assert_eq!(queue.dequeue().expect("steer 可消费").text(), "s1");
        assert!(queue.has_follow_up_pending(), "followUp 仍挂起");
        assert_eq!(queue.promote_follow_up(), 1);
    }

    /// cooperative_stop 的 pending 消息默认入 steer 环（下次 run 可立刻看到）
    #[test]
    fn cooperative_stop_pending_goes_to_steer_ring() {
        let mut bus = ControlBus::new();
        bus.request_cooperative_stop(None, None);
        bus.request_steer(msg("next"), None, None);
        let action = apply_safe_point_control(&mut bus, None).unwrap();

        let mut queue = AgentInputQueue::new();
        write_inject_messages(&mut queue, &action);
        assert!(queue.has_steer_pending());
        assert!(!queue.has_follow_up_pending());
    }

    /// D1 集成：cooperative_stop 在安全点推 SM 到 done、不 abort
    ///
    /// 流程对齐 01 §2.10：streaming 安全点 NO_TOOL_CALLS → SHOULD_STOP。
    /// 收场 reason 由动作端给出（stopped），状态机端保持 stop 语义且不 abort。
    #[test]
    fn cooperative_stop_drives_machine_to_done() {
        let mut bus = ControlBus::new();
        bus.request_cooperative_stop(Some("user said enough".to_string()), None);
        let action = apply_safe_point_control(&mut bus, None).expect("应有动作");
        assert!(matches!(action, ControlAction::CooperativeStop { .. }));
        assert_eq!(action.end_reason(), Some(AgentEndReason::Stopped));

        let mut machine = AgentSessionMachine::new("s1", 16);
        machine.dispatch(E::Initialized).unwrap();
        machine.dispatch(E::InputReady).unwrap();
        machine.dispatch(E::TurnPrepared).unwrap();
        assert_eq!(machine.state(), S::Streaming);
        // 安全点：协作停止不触发 ABORT，走正常收场路径
        machine.dispatch(E::NoToolCalls).unwrap();
        machine.dispatch(E::ShouldStop).unwrap();
        assert_eq!(machine.state(), S::Done);
        assert_ne!(machine.context().end_reason, AgentEndReason::Aborted);
    }

    /// 显式 kind 入队：continue 不入队、不产生动作
    #[test]
    fn continue_intent_never_affects_safe_point() {
        let mut bus = ControlBus::new();
        bus.request(ControlIntentInput::new(ControlKind::Continue));
        assert_eq!(apply_safe_point_control(&mut bus, None), None);
    }

    /// ring_for_kind 辅助与 TS injectRingForKind 一致
    #[test]
    fn ring_for_kind_matches_ts() {
        use crate::control::ControlKind as K;
        assert_eq!(ring_for_kind(K::SoftInject), Some(RingChoice::Steer));
        assert_eq!(ring_for_kind(K::Steer), Some(RingChoice::Steer));
        assert_eq!(ring_for_kind(K::FollowUp), Some(RingChoice::FollowUp));
        assert_eq!(ring_for_kind(K::ForceCancel), None);
        assert_eq!(ring_for_kind(K::CooperativeStop), None);
    }

    /// T09.9 Q21：wait_aborted 在 abort 触发后及时返回（竞速等待语义）
    #[tokio::test]
    async fn wait_aborted_returns_when_abort_fires() {
        let signal = AbortSignal::new();
        let waiter = signal.clone();
        let handle = tokio::spawn(async move { waiter.wait_aborted().await });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        signal.abort();
        tokio::time::timeout(std::time::Duration::from_secs(1), handle)
            .await
            .expect("abort 后等待应立刻返回")
            .expect("等待任务不应 panic");
    }

    /// T09.9 Q21：已触发的信号 wait_aborted 立即返回（不挂起）
    #[tokio::test]
    async fn wait_aborted_returns_immediately_when_already_aborted() {
        let signal = AbortSignal::new();
        signal.abort();
        tokio::time::timeout(std::time::Duration::from_millis(100), signal.wait_aborted())
            .await
            .expect("已触发的信号应立即返回");
    }
}
