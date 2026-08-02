//! 会话状态机类型域（对齐 01-session-loop-semantics.md §1）
//!
//! 8 态 × 20 事件 × 上下文 × endReason 作为一等类型；
//! 转移表在 transition.rs 穷举实现（01 §五.1：未定义转移必须显式失败）。

use serde::{Deserialize, Serialize};

/// 默认最大轮次（TS 端常量 DEFAULT_MAX_TURNS = 16 同值）
pub const DEFAULT_MAX_TURNS: u32 = 16;

/// 会话状态机 8 态（01 §1.1）
///
/// 状态流：`idle` → `awaiting-input` → `preparing-turn` → `streaming`
/// （→ `steering-evaluation` ｜→ `executing-tools`）→ `turn-complete` → `done`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentSessionState {
    /// 初始态，等待 INITIALIZED 进入等待输入
    Idle,
    /// 等待外部输入（dequeue force/steer 环；无输入 → NO_INPUT 收场）
    AwaitingInput,
    /// 准备一轮：输入消费、steering 评估、上下文压缩，随后 TURN_PREPARED
    PreparingTurn,
    /// 流式消费 provider 输出（可抢占打断；响应分类后分派）
    Streaming,
    /// steering 评估中（预算用尽/无策略 → 收场路径）
    SteeringEvaluation,
    /// 工具批量执行中
    ExecutingTools,
    /// 一轮完成：按 01 §2.9 优先级决定下一轮或收场
    TurnComplete,
    /// 终态：无任何转移（01 §1.4 最后一行）
    Done,
}

/// 会话状态机 20 事件（01 §1.2）
///
/// 事件名保持 TS 端 SCREAMING_SNAKE_CASE（agent-session.ts:20-40）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AgentSessionEvent {
    /// run 初始化完成（agent-start 之后）
    Initialized,
    /// 输入已消费，可进入准备
    InputReady,
    /// 无输入，默认 stop 收场
    NoInput,
    /// 一轮准备完毕（turnIndex+1，toolCallCount 归零）
    TurnPrepared,
    /// 模型输出含工具调用，携带调用数量
    HasToolCalls {
        count: u32,
    },
    /// 无工具调用（纯文字正常收场路径）
    NoToolCalls,
    /// 流错误恢复后继续（重试/压缩后重进准备）
    NoProgressContinue,
    /// 工具批执行完毕
    ToolsComplete,
    /// 有可运行输入（force/steer 环）
    InputAvailable,
    /// 进入下一轮（turn-complete 后工具已调用）
    NextTurn,
    /// 协作停止建议（cooperative，不打断）
    ShouldStop,
    /// 用户取消 / L3 force_cancel / AbortSignal
    Abort,
    /// 致命错误（01 §1.6 四事件之一）
    Error,
    /// 达到最大轮次（独立预算 reason，非错误）
    MaxTurnsReached,
    /// 需人工介入（01 §1.6 四事件之一）
    InterventionRequired,
    /// provider 错误且重试/恢复均失败（01 §1.6 四事件之一）
    ProviderError,
    /// 收尾完成（turn-complete 的兜底收场）
    Finish,
    /// 空响应需 steering 评估
    SteeringNeeded,
    /// steering 注入完成，重进 provider 循环
    SteeringComplete,
    /// steering 预算耗尽（01 §1.6 四事件之一）
    SteeringBudgetExhausted,
}

/// run 结束原因（01 §1.5 + D1 遗留）
///
/// - stop：默认收场（NO_INPUT / SHOULD_STOP / FINISH 等不带 patch 的转移）
/// - max-turns：仅 MAX_TURNS_REACHED，预算用尽可观测但**非错误**
/// - aborted：仅 ABORT 事件（用户取消 / L3 force_cancel）
/// - error：「错误收场」最小集合，仅 01 §1.6 四个事件产生
/// - stopped：D1 遗留新增值——cooperative_stop 独立 reason，
///   用户协作停止既不是错误也不是取消（01 第四章 D1 / 遗留问题 1）。
///   与前端 EventRouter 对齐后定稿；序列化为 kebab-case。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentEndReason {
    /// 正常停止（默认收场）
    Stop,
    /// 预算用尽（非错误非中止）
    MaxTurns,
    /// 用户中止
    Aborted,
    /// 错误收场（仅 01 §1.6 四事件）
    Error,
    /// 用户协作停止（D1 新增，独立于 stop/aborted）
    Stopped,
}

/// 状态机上下文（01 §1.3）
///
/// 初始值：endReason='stop'，turnIndex/steeringCount/toolCallCount=0。
/// 注意 01 第三章 3.3：steeringCount 增量唯一入口是 steering 策略
/// apply()，状态机转移不 bump 该计数（Rust 实现须单一计数源）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionContext {
    pub session_id: String,
    /// 当前轮次（TURN_PREPARED 时 +1；turn-complete INPUT_AVAILABLE 时归零）
    pub turn_index: u32,
    /// 最大轮次上限（shouldStopForMaxTurns = turnIndex >= maxTurns）
    pub max_turns: u32,
    /// 收场原因（初始 stop）
    pub end_reason: AgentEndReason,
    /// 当前轮工具调用数
    pub tool_call_count: u32,
    /// steering 计数（coordinator 持有预算，此处仅镜像/归零）
    pub steering_count: u32,
}

impl AgentSessionContext {
    /// 初始上下文（对齐 createAgentSessionMachine 的 initialContext）
    pub fn initial(session_id: impl Into<String>, max_turns: u32) -> Self {
        Self {
            session_id: session_id.into(),
            turn_index: 0,
            max_turns,
            end_reason: AgentEndReason::Stop,
            tool_call_count: 0,
            steering_count: 0,
        }
    }
}

impl Default for AgentSessionContext {
    fn default() -> Self {
        Self::initial("", DEFAULT_MAX_TURNS)
    }
}

impl AgentSessionContext {
    /// 是否达到最大轮次（对齐 shouldStopForMaxTurns）
    pub fn should_stop_for_max_turns(&self) -> bool {
        self.turn_index >= self.max_turns
    }
}
