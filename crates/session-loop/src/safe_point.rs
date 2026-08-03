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

use conex_types::checkpoint::{
    CHECKPOINT_MARKER, CONEX_CHECKPOINT_MARKER, CheckpointError, CheckpointPayload,
};
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
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

// ===== C1 checkpoint 采集（M5A；04 §2 C1 采集端） =====

/// 检查点采集：解析文本中的检查点行标记（C1 / M5A）。
///
/// 行标记协议（jcode JCODE_CHECKPOINT 借鉴，02 方案 Top 5）：
/// - 主前缀 [CHECKPOINT_MARKER]（`CHECKPOINT:`）+ JSON 载荷；别名前缀
///   [CONEX_CHECKPOINT_MARKER]（`CONEX_CHECKPOINT`）+ JSON 载荷（仅
///   对象起始，防 `CONEX_CHECKPOINTING` 之类前缀词误匹配）；
/// - 逐行扫描（trim 后判定），同一文本取第一条命中行；
/// - 命中标记行但载荷解析失败 → Err（损坏降级信号，不 panic，调用方
///   降级普通会话并通知主 agent「检查点失效」）；
/// - 无标记行 → Ok(None)（现状，不启用优先恢复）。
pub fn parse_checkpoint_marker(
    text: &str,
) -> Result<Option<CheckpointPayload>, CheckpointError> {
    for raw_line in text.lines() {
        let line = raw_line.trim();
        let payload = if let Some(rest) = line.strip_prefix(CHECKPOINT_MARKER) {
            rest.trim()
        } else if let Some(rest) = line.strip_prefix(CONEX_CHECKPOINT_MARKER) {
            let rest = rest.trim_start();
            // 别名仅接受 JSON 对象起始（防 `CONEX_CHECKPOINTING` 误匹配）
            if !rest.starts_with('{') {
                continue;
            }
            rest
        } else {
            continue;
        };
        // 空载荷行跳过（孤立 `CHECKPOINT:` 行不视为损坏）
        if payload.is_empty() {
            continue;
        }
        return match serde_json::from_str::<CheckpointPayload>(payload) {
            Ok(checkpoint) => Ok(Some(checkpoint)),
            Err(err) => Err(CheckpointError::new(
                "checkpoint.parse_failed",
                format!("检查点行标记载荷解析失败: {err}"),
            )),
        };
    }
    Ok(None)
}

/// 检查点采集：从对话消息采集最新检查点（C1 / M5A）。
///
/// run 生命周期安全点调用（M5B 接线：采集结果写入会话树叶子 payload）。
/// 采集语义（M5 任务卡 M5A）：
/// - 倒序扫描消息（最新在前），最新命中优先；
/// - system 角色消息永不参与（C1 边界：system 永不进入检查点内容，
///   对齐 C9）；
/// - 扫描面 = 消息正文（Text 块）+ 工具结果输出文本
///   （ToolResult.output.text，工具输出中的显式标记行）；
/// - 命中标记行但载荷损坏 → Err（降级信号）；无标记 → Ok(None)；
/// - 载荷未携带时间戳时补当前时间（采集时间戳）。
pub fn collect_checkpoint_from_messages(
    messages: &[AgentMessage],
) -> Result<Option<CheckpointPayload>, CheckpointError> {
    for message in messages.iter().rev() {
        if message.role == AgentMessageRole::System {
            continue;
        }
        let mut text = message.text();
        for block in &message.blocks {
            if let AgentMessageBlock::ToolResult { output, .. } = block {
                if let Some(output_text) = &output.text {
                    text.push_str(output_text);
                }
            }
        }
        if let Some(mut checkpoint) = parse_checkpoint_marker(&text)? {
            if checkpoint.timestamp.is_none() {
                checkpoint.timestamp = Some(crate::steering::now_iso_utc());
            }
            return Ok(Some(checkpoint));
        }
    }
    Ok(None)
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

    // ── C1 checkpoint 采集（M5A） ──

    fn assistant_msg(text: &str) -> AgentMessage {
        AgentMessage {
            id: format!("a-{text}"),
            role: AgentMessageRole::Assistant,
            created_at: "2026-01-01T00:00:00Z".into(),
            blocks: vec![conex_types::message::AgentMessageBlock::Text {
                text: text.into(),
            }],
            metadata: None,
            client_message_id: None,
            content: None,
        }
    }

    fn system_msg(text: &str) -> AgentMessage {
        AgentMessage {
            id: format!("s-{text}"),
            role: AgentMessageRole::System,
            created_at: "2026-01-01T00:00:00Z".into(),
            blocks: vec![conex_types::message::AgentMessageBlock::Text {
                text: text.into(),
            }],
            metadata: None,
            client_message_id: None,
            content: None,
        }
    }

    fn tool_msg(text: &str) -> AgentMessage {
        AgentMessage {
            id: format!("t-{text}"),
            role: AgentMessageRole::Tool,
            created_at: "2026-01-01T00:00:00Z".into(),
            blocks: vec![conex_types::message::AgentMessageBlock::ToolResult {
                tool_call_id: format!("tc-{text}"),
                tool_name: "bash".into(),
                output: conex_types::tool::ToolOutput::text(text.to_string()),
                is_error: false,
            }],
            metadata: None,
            client_message_id: None,
            content: None,
        }
    }

    fn sample_checkpoint(target: &str) -> CheckpointPayload {
        CheckpointPayload {
            target: target.into(),
            summary: "基座完成".into(),
            timestamp: Some("2026-08-03T10:00:00.000Z".into()),
            completed: vec!["安装依赖".into()],
            files: vec!["crates/session-loop/src/safe_point.rs".into()],
            next: vec!["接线恢复注入".into()],
        }
    }

    fn marker_line(checkpoint: &CheckpointPayload) -> String {
        format!(
            "CHECKPOINT: {}",
            serde_json::to_string(checkpoint).expect("检查点载荷可序列化")
        )
    }

    /// 行标记采集：`CHECKPOINT: {json}` → 解析为检查点载荷（字段往返）
    #[test]
    fn parse_checkpoint_marker_roundtrip() {
        let checkpoint = sample_checkpoint("实现采集");
        let text = format!("已完成一半。\n{}\n接下来收尾。", marker_line(&checkpoint));
        let parsed = parse_checkpoint_marker(&text)
            .expect("不应报错")
            .expect("应命中标记行");
        assert_eq!(parsed, checkpoint);
    }

    /// 别名前缀 CONEX_CHECKPOINT {json} 同样识别（02 方案 Top 5 命名）
    #[test]
    fn parse_checkpoint_marker_accepts_conex_alias() {
        let text = r#"CONEX_CHECKPOINT {"target":"目标A","summary":"摘要A"}"#;
        let parsed = parse_checkpoint_marker(text)
            .expect("不应报错")
            .expect("应命中别名前缀");
        assert_eq!(parsed.target, "目标A");
        assert_eq!(parsed.summary, "摘要A");
    }

    /// 无标记行 → Ok(None)（现状，不启用优先恢复）
    #[test]
    fn parse_checkpoint_marker_no_marker_returns_none() {
        assert_eq!(parse_checkpoint_marker("普通对话内容，没有检查点。").unwrap(), None);
        assert_eq!(parse_checkpoint_marker("").unwrap(), None);
    }

    /// 损坏降级：命中标记行但 JSON 损坏 → Err（不 panic，调用方降级）
    #[test]
    fn parse_checkpoint_marker_corrupt_json_is_error() {
        let err = parse_checkpoint_marker("CHECKPOINT: {broken json").unwrap_err();
        assert_eq!(err.kind, "checkpoint.parse_failed");
    }

    /// 首行命中优先：同一文本多条标记取第一条
    #[test]
    fn parse_checkpoint_marker_first_line_wins() {
        let first = sample_checkpoint("第一目标");
        let second = sample_checkpoint("第二目标");
        let text = format!("{}\n{}", marker_line(&first), marker_line(&second));
        let parsed = parse_checkpoint_marker(&text)
            .unwrap()
            .expect("应命中标记行");
        assert_eq!(parsed.target, "第一目标");
    }

    /// 空载荷行跳过：孤立 `CHECKPOINT:` 不视为损坏
    #[test]
    fn parse_checkpoint_marker_empty_payload_skipped() {
        assert_eq!(parse_checkpoint_marker("CHECKPOINT:").unwrap(), None);
        assert_eq!(parse_checkpoint_marker("  CHECKPOINT:   ").unwrap(), None);
    }

    /// 别名防误匹配：`CONEX_CHECKPOINTING` 之类前缀词不算标记行
    #[test]
    fn parse_checkpoint_marker_alias_rejects_misleading_prefix() {
        assert_eq!(
            parse_checkpoint_marker("CONEX_CHECKPOINTING not a checkpoint").unwrap(),
            None
        );
    }

    /// 对话采集：倒序扫描，最新助手消息命中优先
    #[test]
    fn collect_latest_message_wins() {
        let old = sample_checkpoint("旧目标");
        let latest = sample_checkpoint("新目标");
        let messages = vec![
            assistant_msg(&marker_line(&old)),
            assistant_msg(&marker_line(&latest)),
        ];
        let collected = collect_checkpoint_from_messages(&messages)
            .expect("不应报错")
            .expect("应采集到检查点");
        assert_eq!(collected.target, "新目标");
    }

    /// system 消息永不进入检查点内容：仅 system 含标记 → 不采集
    #[test]
    fn collect_skips_system_messages() {
        let checkpoint = sample_checkpoint("系统注入");
        let messages = vec![system_msg(&marker_line(&checkpoint))];
        assert_eq!(collect_checkpoint_from_messages(&messages).unwrap(), None);
        // system 含标记但更早助手消息有效 → 采到助手消息
        let messages2 = vec![
            system_msg(&marker_line(&checkpoint)),
            assistant_msg(&marker_line(&sample_checkpoint("助手目标"))),
        ];
        let collected = collect_checkpoint_from_messages(&messages2)
            .unwrap()
            .expect("应采集助手消息标记");
        assert_eq!(collected.target, "助手目标");
    }

    /// 工具结果输出文本参与扫描（工具输出中的显式标记行）
    #[test]
    fn collect_scans_tool_result_output() {
        let checkpoint = sample_checkpoint("工具目标");
        let messages = vec![tool_msg(&marker_line(&checkpoint))];
        let collected = collect_checkpoint_from_messages(&messages)
            .unwrap()
            .expect("应采集工具输出标记");
        assert_eq!(collected.target, "工具目标");
    }

    /// 损坏降级：最新消息标记损坏 → Err（不 panic）
    #[test]
    fn collect_corrupt_latest_is_error() {
        let messages = vec![
            assistant_msg(&marker_line(&sample_checkpoint("旧目标"))),
            assistant_msg("CHECKPOINT: {broken"),
        ];
        let err = collect_checkpoint_from_messages(&messages).unwrap_err();
        assert_eq!(err.kind, "checkpoint.parse_failed");
    }

    /// 无标记对话 → Ok(None)（回归：普通会话采集不受影响）
    #[test]
    fn collect_no_marker_returns_none() {
        let messages = vec![msg("开始任务"), assistant_msg("完成了第一步。")];
        assert_eq!(collect_checkpoint_from_messages(&messages).unwrap(), None);
    }

    /// 载荷未带时间戳 → 采集端补当前时间（采集时间戳）
    #[test]
    fn collect_stamps_timestamp_when_missing() {
        let text = r#"CHECKPOINT: {"target":"目标B","summary":"摘要B"}"#;
        let messages = vec![assistant_msg(text)];
        let collected = collect_checkpoint_from_messages(&messages)
            .unwrap()
            .expect("应采集到检查点");
        assert_eq!(collected.target, "目标B");
        assert!(
            collected.timestamp.is_some(),
            "缺省时间戳由采集端补当前时间"
        );
    }
}
