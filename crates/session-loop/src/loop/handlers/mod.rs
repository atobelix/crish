//! handler 集公共状态与辅助（B3.4）
//!
//! [LoopState] 是主循环的可变状态载体：状态机 / 输入队列 / 控制总线 /
//! abort 信号 / steering 协调器 / 对话 / 事件累加器 / 恢复阶梯计数。
//! 各 handler 以 `&mut LoopState` 驱动，产出 [HandlerOutcome]（可选收口决策）。
//!
//! [check_control] 是安全点集成的统一入口：每个 handler 起始与
//! stream / tool 批结束调用，把 ControlBus 意图 / AbortSignal 映射为
//! 循环动作（01 §2.10 优先级：force_cancel > cooperative_stop > soft_inject）：
//! - force_cancel / AbortSignal → ABORT 收场（aborted，可立即中断）；
//! - cooperative_stop → 按当前状态 D1 驱动状态机到 done（stopped 收场，
//!   不 abort；preparing-turn / steering-evaluation 为瞬时相位，停止在
//!   下一安全点生效）；
//! - soft_inject / steer / follow_up → 只读消费，消息写入输入队列对应环
//!   （01 §五.5 三环语义：steer → 下一安全点；followUp → 仅 idle promote），
//!   不打断流。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use agent_tools::registry::ToolRegistry;
use conex_types::error::codes;
use conex_types::events::AgentEvent;
use conex_types::message::{AgentMessage, AgentMessageRole};
use conex_types::session::{AgentSessionEvent as E, AgentSessionState as S};

use crate::control::ControlBus;
use crate::input::AgentInputQueue;
use crate::safe_point::{AbortSignal, apply_safe_point_control};
use crate::state::AgentSessionMachine;
use crate::steering::{SteeringContext, SteeringCoordinator};

use super::end::EndDecision;
use super::{LoopError, SessionLoopOptions};

pub(crate) mod awaiting_input;
pub(crate) mod executing_tools;
pub(crate) mod no_tool_calls;
pub(crate) mod prepare_turn;
pub(crate) mod steering_evaluation;
pub(crate) mod stream_error;
pub(crate) mod streaming;
pub(crate) mod turn_complete;

/// 消息 id 计数器（同毫秒内多次生成保证唯一）
static MESSAGE_ID_COUNTER: AtomicU64 = AtomicU64::new(0);

/// 生成唯一消息 id（前缀 + 毫秒时间戳 + 序号）
pub(crate) fn new_message_id(prefix: &str) -> String {
    let n = MESSAGE_ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{}-{n}", crate::steering::unix_millis())
}

/// 主循环可变状态（各 handler 的共享载体）
pub(crate) struct LoopState {
    /// 会话状态机（B3.1）
    pub(crate) machine: AgentSessionMachine,
    /// 三环输入队列（force / steer / followUp）
    pub(crate) input_queue: AgentInputQueue,
    /// 控制总线（Arc<Mutex>：外部（UI / 测试）可并发入队意图）
    pub(crate) control_bus: Arc<Mutex<ControlBus>>,
    /// abort 信号（L3 强停等价，可 Clone 共享）
    pub(crate) abort_signal: AbortSignal,
    /// steering 协调器（预算 / 计数单一来源，01 §3.3 / D10）
    pub(crate) steering: SteeringCoordinator,
    /// 会话对话消息列表（跨 run 持久；Arc 共享——记录路径 0 深克隆，
    /// PE-09 T09.3.2）
    pub(crate) conversation: Vec<Arc<AgentMessage>>,
    /// 本次 run 的事件累加器（agent-start … agent-end）
    pub(crate) events: Vec<AgentEvent>,
    /// 循环配置（恢复阶梯上限 / 钩子等，由 AgentSessionLoop 注入）
    pub(crate) options: SessionLoopOptions,
    /// 工具注册表（请求构建导出工具定义 + 供 ToolExecutor 使用）
    pub(crate) tool_registry: Arc<ToolRegistry>,
    /// length 阶梯当前 max_tokens（8192 → 16384 → 32768，01 §2.6 步骤 1）
    pub(crate) max_tokens: u32,
    /// length 阶梯已升级次数（上限 2）
    pub(crate) length_upgrades: u32,
    /// 瞬态错误已重试次数（上限 3，01 §2.5 步骤 2）
    pub(crate) transient_retries: u32,
    /// continue nudge 已用次数（上限 1，01 §2.6 步骤 1）
    pub(crate) continue_nudges: u32,
    /// error 收场时的错误文案（turn-complete 收敛读取）
    pub(crate) terminal_error: Option<String>,
}

impl LoopState {
    /// 新建状态（max_tokens 起点 [crate::r#loop::DEFAULT_MAX_TOKENS]）
    pub(crate) fn new(
        session_id: impl Into<String>,
        max_turns: u32,
        steering: SteeringCoordinator,
        options: SessionLoopOptions,
        tool_registry: Arc<ToolRegistry>,
    ) -> Self {
        Self {
            machine: AgentSessionMachine::new(session_id, max_turns),
            input_queue: AgentInputQueue::new(),
            control_bus: Arc::new(Mutex::new(ControlBus::new())),
            abort_signal: AbortSignal::new(),
            steering,
            conversation: Vec::new(),
            events: Vec::new(),
            options,
            tool_registry,
            max_tokens: crate::r#loop::DEFAULT_MAX_TOKENS,
            length_upgrades: 0,
            transient_retries: 0,
            continue_nudges: 0,
            terminal_error: None,
        }
    }
}

/// handler 产出：可选收口决策（None = 继续循环）
#[derive(Debug, Clone)]
pub(crate) struct HandlerOutcome {
    pub(crate) end: Option<EndDecision>,
}

impl HandlerOutcome {
    /// 继续循环
    pub(crate) fn continue_run() -> Self {
        Self { end: None }
    }

    /// 收敛 run
    pub(crate) fn end(decision: EndDecision) -> Self {
        Self { end: Some(decision) }
    }
}

/// 状态机事件分派（未定义转移显式失败，01 §五.1）
pub(crate) fn dispatch(state: &mut LoopState, event: E) -> Result<(), LoopError> {
    state
        .machine
        .dispatch(event)
        // T06.5.1：显式码构造（runtime.transition_failed），TransitionError
        // 上下文保留在 message（不再丢原始结构化信息，AA-01 Q29）
        .map_err(|e| {
            LoopError::with_code(codes::RUNTIME_TRANSITION_FAILED, format!("状态机转移失败：{e}"))
        })
}

/// 记录一条消息到对话并产出 message-start / message-end 事件对
/// （01 §五.6：每条消息必成对）
///
/// PE-09 T09.3.2：`Arc::new` 一次后对话与事件共享同一份消息内存
/// （0 深克隆；serde 对 `Arc<T>` 按 `T` 序列化，wire 逐字节不变）。
pub(crate) fn record_message(state: &mut LoopState, message: AgentMessage) {
    let session_id = state.machine.context().session_id.clone();
    let message = Arc::new(message);
    state
        .events
        .push(AgentEvent::MessageStart { session_id: session_id.clone(), message: message.clone() });
    state.conversation.push(message.clone());
    state.events.push(AgentEvent::MessageEnd { session_id, message });
}

/// 构建 steering 评估上下文（计数取 coordinator 单一计数源，01 §3.3 / D10）
pub(crate) fn steering_context(state: &LoopState) -> SteeringContext<'_> {
    SteeringContext {
        messages: &state.conversation,
        turn_index: state.machine.context().turn_index,
        steering_count: state.steering.get_steering_count(),
        tool_call_count: state.machine.context().tool_call_count,
        has_pending_input: state.input_queue.has_runnable_pending(),
    }
}

/// 驱动状态机到 done（cooperative_stop 安全点，D1：不 abort）
///
/// 01 §2.10 覆盖的三态路径：streaming: NO_TOOL_CALLS+SHOULD_STOP；
/// executing-tools: TOOLS_COMPLETE+SHOULD_STOP；turn-complete: SHOULD_STOP。
/// awaiting-input 无输入即 NO_INPUT 收场；preparing-turn / steering-evaluation
/// 为瞬时相位（同步代码），停止在下一安全点（stream 结束 / tool 批后）生效。
fn drive_machine_to_stop(state: &mut LoopState) -> Result<(), LoopError> {
    match state.machine.state() {
        S::Streaming => {
            dispatch(state, E::NoToolCalls)?;
            dispatch(state, E::ShouldStop)?;
        }
        S::ExecutingTools => {
            dispatch(state, E::ToolsComplete)?;
            dispatch(state, E::ShouldStop)?;
        }
        S::TurnComplete => dispatch(state, E::ShouldStop)?,
        S::AwaitingInput => dispatch(state, E::NoInput)?,
        // 瞬时相位：不驱动，下一安全点生效
        S::PreparingTurn | S::SteeringEvaluation => {}
        S::Idle | S::Done => {}
    }
    Ok(())
}

/// 安全点统一检查：handler 起始与 stream / tool 批结束调用。
///
/// 返回 [Some] 表示 run 已可收敛（force_cancel / cooperative_stop），
/// [None] 表示继续（soft_inject 只读消费后消息已落环）。
pub(crate) fn check_control(state: &mut LoopState) -> Result<Option<EndDecision>, LoopError> {
    // AbortSignal 等价 L3 强停，优先于总线内任何意图（01 §2.10）
    let action = {
        let mut bus = state.control_bus.lock().unwrap_or_else(|e| e.into_inner());
        apply_safe_point_control(&mut bus, Some(&state.abort_signal))
    };
    let Some(action) = action else {
        return Ok(None);
    };
    match action {
        crate::safe_point::ControlAction::ForceCancel { reason } => {
            // L3 强停：可立即中断 → ABORT（endReason=aborted；取消原因经
            // aborted_with_diagnostic 透出，T06.3 Q02：不再写 state.abort_reason）
            dispatch(state, E::Abort)?;
            Ok(Some(EndDecision::aborted_with_diagnostic(state, reason)))
        }
        crate::safe_point::ControlAction::CooperativeStop { pending_messages, .. } => {
            // L2 协作停止：不 abort，D1 驱动状态机到 done（stopped 收场）
            for message in pending_messages {
                state.input_queue.enqueue_steer(message);
            }
            drive_machine_to_stop(state)?;
            Ok(Some(EndDecision::stopped(state)))
        }
        crate::safe_point::ControlAction::SoftInject { steer_messages, follow_up_messages } => {
            // L1 软注入：只读消费，消息落环（不打断流）
            for message in steer_messages {
                state.input_queue.enqueue_steer(message);
            }
            for message in follow_up_messages {
                state.input_queue.enqueue_follow_up(message);
            }
            Ok(None)
        }
    }
}

/// 取最后一条携带工具调用的 assistant 消息（01 §2.8 步骤 2 的输入）
pub(crate) fn last_assistant_with_tool_calls(
    state: &LoopState,
) -> Option<&Arc<conex_types::message::AgentMessage>> {
    state.conversation.iter().rev().find(|m| {
        m.role == AgentMessageRole::Assistant && m.tool_calls().next().is_some()
    })
}
