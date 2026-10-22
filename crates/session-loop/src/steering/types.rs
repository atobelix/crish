//! steering 公共类型：阶段 / 原因 / 动作 / 上下文、策略接口、coordinator 配置、
//! apply 结果与评估观测轨迹（由 mod.rs 重导出，对外路径 `crate::steering::*` 不变）。

use std::sync::Arc;

use conex_types::events::AgentEvent;
use conex_types::message::AgentMessage;
use serde::{Deserialize, Serialize};

/// steering 评估阶段（对齐 TS SteeringPhase）
///
/// 当前仅 `after-tools` 与 `empty-response` 被 [RecoverySteeringStrategy]
/// 关注；其余两个阶段为 TS 类型全集占位（GoalAudit / CompressionRecovery
/// 策略恒返回空，不参与本 crate 调度）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SteeringPhase {
    /// 工具批执行完成后（检测工具错误环 / 重复调用环）
    AfterTools,
    /// 占位变体（goal audit 占位）：prepare_turn 有评估点（步骤 4 遍历）
    /// 但当前无策略注册消费该相位（T06.3 Q12 标注）。待接：依赖未来
    /// GoalAudit 策略实现（无策略则不产生该相位事件，安全）。
    /// 接线状态：已确认接线计划——BeforeTurn 相位占位保留，待 GoalAudit 策略实现后接线
    /// （当前无策略消费该相位，安全；跟随 goal-state v2 方案，追踪：backend-optimization Q10-GoalAudit）。
    BeforeTurn,
    /// 空响应（模型未产出文字也未调用工具）
    EmptyResponse,
}

/// 纠偏原因（对齐 TS RuntimeRecoveryReason，kebab-case 序列化）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SteeringReason {
    /// 连续工具错误环
    ToolErrors,
    /// 重复工具调用环
    ToolLoop,
    /// 空响应
    EmptyResponse,
}

impl SteeringPhase {
    /// 事件/元数据使用的字符串形式（`after-tools` / `empty-response` /
    /// `before-turn`，与 serde kebab-case 序列化同口径——steering-evaluated
    /// 事件 phase 字段取值来源）
    pub fn as_str(&self) -> &'static str {
        match self {
            SteeringPhase::AfterTools => "after-tools",
            SteeringPhase::BeforeTurn => "before-turn",
            SteeringPhase::EmptyResponse => "empty-response",
        }
    }
}

impl SteeringReason {
    /// 事件/元数据使用的字符串形式（`tool-errors` / `tool-loop` / `empty-response`）
    pub fn as_str(&self) -> &'static str {
        match self {
            SteeringReason::ToolErrors => "tool-errors",
            SteeringReason::ToolLoop => "tool-loop",
            SteeringReason::EmptyResponse => "empty-response",
        }
    }
}

impl std::fmt::Display for SteeringReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 纠偏动作（对齐 TS SteeringAction）
///
/// - [SteeringAction::InjectMessage]：注入一条 system 消息进对话，消耗预算；
/// - [SteeringAction::EmitDiagnostic]：发射诊断事件，不修改对话，不消耗预算；
/// - [SteeringAction::InterventionRequired]：需要人工介入，不消耗预算。
#[derive(Debug, Clone, PartialEq)]
pub enum SteeringAction {
    /// 注入一条消息到对话（预算受限；唯一计数增量来源）
    InjectMessage {
        message: AgentMessage,
        reason: SteeringReason,
    },
    /// 发射诊断事件（不修改对话；不受预算限制）
    EmitDiagnostic {
        diagnostic: serde_json::Value,
        reason: String,
    },
    /// 需人工介入，run 应终止（不受预算限制；D9：事件照发但非 error 收场）
    InterventionRequired {
        reason: SteeringReason,
        message: Option<String>,
    },
}

/// 纠偏上下文快照（对齐 TS SteeringContext）
///
/// 策略评估时可见的共享视图：`steering_count` 由 coordinator 覆写为
/// **潜在计数**（含本次评估已计入的注入，对齐 TS coordinator 的
/// `potentialSteeringCount` 传递，steering-coordinator.ts:72-75）。
/// 消息载荷为 Arc 共享形态（PE-09 T09.3.2，读字段自动 deref）。
#[derive(Debug, Clone, Copy)]
pub struct SteeringContext<'a> {
    /// 当前对话消息列表
    pub messages: &'a [Arc<AgentMessage>],
    /// 当前轮次编号
    pub turn_index: u32,
    /// 当前已执行的纠偏计数（coordinator 的潜在计数）
    pub steering_count: usize,
    /// 当前轮工具调用数量
    pub tool_call_count: u32,
    /// 是否有待处理的新输入（D3 预注入短路由调用方据此跳过评估）
    pub has_pending_input: bool,
}

/// 纠偏策略接口（对齐 TS SteeringStrategy）
///
/// 策略只决定「是否需要纠偏」与「纠偏内容」，不负责执行；
/// 预算与计数由 [SteeringCoordinator] 统一掌管。
/// Send + Sync 约束：主循环运行于异步运行时（run 可跨线程调度），
/// 策略须可跨线程共享（B3.4 集成要求）。
pub trait SteeringStrategy: Send + Sync {
    /// 策略名（观测用）
    fn name(&self) -> &'static str;
    /// 关注的阶段列表
    fn phases(&self) -> &'static [SteeringPhase];
    /// 在指定阶段评估是否需要纠偏；返回空表示不需要
    fn evaluate(
        &self,
        phase: SteeringPhase,
        context: &SteeringContext<'_>,
    ) -> Option<SteeringAction>;
}

/// coordinator 配置（对齐 TS SteeringCoordinatorOptions）
#[derive(Debug, Clone, Copy, Default)]
pub struct SteeringCoordinatorOptions {
    /// 全局最大纠偏注入数（默认 [DEFAULT_MAX_STEERING_BUDGET] = 3）
    pub max_steering_budget: Option<usize>,
}

/// 应用纠偏动作的结果（对齐 TS apply 返回值）
///
/// 注意：本结构**没有 error 语义**——预算耗尽 / intervention-required
/// 均由事件上报（D7/D9），run 的 stop 收场由 B3.4 主循环保证。
#[derive(Debug, Clone, PartialEq)]
pub struct AppliedResult {
    /// 本次 apply 产生的事件（runtime-steering / runtime-intervention-required）
    pub events: Vec<AgentEvent>,
    /// 是否需要人工介入（intervention-required 动作存在即为真）
    pub intervention_required: bool,
}

/// steering 评估观测轨迹（EV-03 / D-03：steering-evaluated 事件载荷素材）
///
/// 由 [SteeringCoordinator::evaluate_traced] 产出，调用方（handler 安全点）
/// 组装 [steering_evaluated_event] 发射；计数重置点构造「空命中 + before/0」
/// 轨迹发射 reset=true 变体。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SteeringEvaluationTrace {
    /// 命中策略名列表（空 = 无动作；含预算跳过命中）
    pub hit_strategies: Vec<String>,
    /// 评估前计数
    pub steering_count_before: u32,
    /// 评估后潜在计数（含本次 inject-message 预占）
    pub steering_count_after: u32,
}

impl SteeringEvaluationTrace {
    /// 计数重置轨迹（reset 变体：无策略命中、计数清零）
    pub(crate) fn reset(steering_count_before: u32) -> Self {
        Self {
            hit_strategies: Vec::new(),
            steering_count_before,
            steering_count_after: 0,
        }
    }
}
