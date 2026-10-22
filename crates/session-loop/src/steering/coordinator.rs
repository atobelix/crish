//! 统一纠偏协调器 [SteeringCoordinator]：预算与计数唯一持有者、按阶段调度策略、执行纠偏动作。

use std::sync::Arc;

use conex_shared::time::now_iso_utc;
use conex_types::events::AgentEvent;
use conex_types::message::AgentMessage;

use super::nudge;
use super::types::{
    AppliedResult, SteeringAction, SteeringContext, SteeringCoordinatorOptions,
    SteeringEvaluationTrace, SteeringPhase, SteeringStrategy,
};
use super::{DEFAULT_INTERVENTION_MESSAGE, DEFAULT_MAX_STEERING_BUDGET};

/// 统一纠偏协调器（对齐 TS SteeringCoordinator）
///
/// 职责（01 §3.1-3.3）：
/// - 预算持有者：`maxSteeringBudget` 为单一配置源；
/// - 计数持有者：`steering_count` 私有，唯一增量点在 [Self::apply] 执行
///   `inject-message` 时（状态机转移不 bump 计数，D10 死检查已删除）；
/// - 策略调度：按 [SteeringPhase] 过滤策略；
/// - 动作执行：[Self::apply] 将注入消息 append 进对话消息列表并产事件。
pub struct SteeringCoordinator {
    strategies: Vec<Box<dyn SteeringStrategy>>,
    steering_count: usize,
    max_steering_budget: usize,
}

impl SteeringCoordinator {
    /// 新建协调器（注册策略列表 + 预算配置）
    pub fn new(
        strategies: Vec<Box<dyn SteeringStrategy>>,
        options: SteeringCoordinatorOptions,
    ) -> Self {
        Self {
            strategies,
            steering_count: 0,
            max_steering_budget: options
                .max_steering_budget
                .unwrap_or(DEFAULT_MAX_STEERING_BUDGET),
        }
    }

    /// 评估指定阶段所有关注策略的纠偏需求。
    ///
    /// - 仅调用 `phases` 包含该阶段的策略；
    /// - `inject-message` 受全局预算限制：潜在计数达到预算即跳过（D9）；
    /// - `intervention-required` / `emit-diagnostic` 不受预算限制；
    /// - **不修改** `steering_count`（计数唯一增量点在 [Self::apply]，D10）。
    ///
    /// 返回需要执行的纠偏动作列表（可为空）。
    pub fn evaluate(
        &self,
        phase: SteeringPhase,
        context: &SteeringContext<'_>,
    ) -> Vec<SteeringAction> {
        let (actions, _) = self.evaluate_traced(phase, context);
        actions
    }

    /// 评估 + 命中策略轨迹（EV-03 / D-03：steering-evaluated 事件载荷素材）。
    ///
    /// 与 [Self::evaluate] 同逻辑，额外返回本次评估的观测轨迹：
    /// - `hit_strategies`：命中策略名列表（策略产出动作即计入，含预算
    ///   跳过——「命中但未注入」也属观测对象；空 = 无动作）；
    /// - `steering_count_before`：评估前计数；
    /// - `steering_count_after`：评估后潜在计数（含本次 inject-message
    ///   预占，对齐 TS potentialSteeringCount 传递语义）。
    pub(crate) fn evaluate_traced(
        &self,
        phase: SteeringPhase,
        context: &SteeringContext<'_>,
    ) -> (Vec<SteeringAction>, SteeringEvaluationTrace) {
        let steering_count_before = self.steering_count as u32;
        let mut actions = Vec::new();
        let mut potential = self.steering_count;
        let mut hit_strategies = Vec::new();
        for strategy in &self.strategies {
            if !strategy.phases().contains(&phase) {
                continue;
            }
            // 策略看到的是潜在计数（含本次评估已计入的注入）
            let strategy_ctx = SteeringContext {
                messages: context.messages,
                turn_index: context.turn_index,
                steering_count: potential,
                tool_call_count: context.tool_call_count,
                has_pending_input: context.has_pending_input,
            };
            let Some(action) = strategy.evaluate(phase, &strategy_ctx) else {
                continue;
            };
            // EV-03（D-03）：策略命中记录（聚合语义——单事件一次发射，
            // 不逐策略逐条发；预算跳过也计入命中）
            hit_strategies.push(strategy.name().to_string());
            match &action {
                // 超预算跳过 inject-message（intervention/diagnostic 不受限）。
                // T06.3 Q08 接线 + Q32 修复：不静默跳过——产出一条
                // budget-exhausted 诊断事件（EmitDiagnostic 分支经此复活），
                // 用户可见「预算耗尽」的原因与计数。
                SteeringAction::InjectMessage { .. } if potential >= self.max_steering_budget => {
                    actions.push(SteeringAction::EmitDiagnostic {
                        reason: "steering-budget-exhausted".to_string(),
                        diagnostic: serde_json::json!({
                            "phase": phase,
                            "budget": self.max_steering_budget,
                            "steeringCount": potential,
                        }),
                    });
                    continue;
                }
                // 仅 inject-message 在评估期预占潜在计数（实际计数在 apply）
                SteeringAction::InjectMessage { .. } => potential += 1,
                _ => {}
            }
            actions.push(action);
        }
        (
            actions,
            SteeringEvaluationTrace {
                hit_strategies,
                steering_count_before,
                steering_count_after: potential as u32,
            },
        )
    }

    /// 执行纠偏动作。
    ///
    /// - `inject-message`：消息 append 进 `conversation`，**唯一**计数增量点，
    ///   发射 `runtime-steering` 事件（reason + message，01 §3.2）；
    /// - `emit-diagnostic`：不修改对话，发射 `runtime-steering`（诊断消息）；
    /// - `intervention-required`：置 `intervention_required`，发射
    ///   `runtime-intervention-required`（choices = rollback/pause/user-instruction）。
    ///
    /// PE-09 T09.3.2：对话为 Arc 共享形态（steering 注入低频——预算上限 3，
    /// 不属 P3/P4 热路径，注入消息本身仍 2 次深克隆用于对话 + 事件两处）。
    ///
    /// P1 不变量（append-only）：`inject-message` 是会话内 4 个追加点之一
    /// （steering 注入路径）——只允许把注入消息**追加到对话尾部**；改写
    /// 既有消息破坏请求前缀字节稳定性；压缩是唯一例外（P4 闸门）。
    pub fn apply(
        &mut self,
        actions: &[SteeringAction],
        session_id: &str,
        conversation: &mut Vec<Arc<AgentMessage>>,
    ) -> AppliedResult {
        let mut events = Vec::new();
        let mut intervention_required = false;
        for action in actions {
            match action {
                SteeringAction::InjectMessage { message, reason } => {
                    conversation.push(Arc::new(message.clone()));
                    self.steering_count += 1;
                    events.push(AgentEvent::RuntimeSteering {
                        session_id: session_id.to_string(),
                        timestamp: now_iso_utc(),
                        reason: reason.as_str().to_string(),
                        message: message.clone(),
                    });
                }
                SteeringAction::EmitDiagnostic { diagnostic, reason } => {
                    let text =
                        serde_json::to_string(diagnostic).unwrap_or_else(|_| "{}".to_string());
                    events.push(AgentEvent::RuntimeSteering {
                        session_id: session_id.to_string(),
                        timestamp: now_iso_utc(),
                        reason: reason.clone(),
                        message: nudge::diagnostic_message(&text),
                    });
                }
                SteeringAction::InterventionRequired { reason, message } => {
                    intervention_required = true;
                    events.push(AgentEvent::RuntimeInterventionRequired {
                        session_id: session_id.to_string(),
                        timestamp: now_iso_utc(),
                        reason: reason.as_str().to_string(),
                        choices: vec![
                            "rollback".to_string(),
                            "pause".to_string(),
                            "user-instruction".to_string(),
                        ],
                        message: message
                            .clone()
                            .unwrap_or_else(|| DEFAULT_INTERVENTION_MESSAGE.to_string()),
                    });
                }
            }
        }
        AppliedResult {
            events,
            intervention_required,
        }
    }

    /// 当前纠偏计数
    pub fn get_steering_count(&self) -> usize {
        self.steering_count
    }

    /// 当前预算剩余（max_steering_budget − steering_count，0 封底；
    /// EV-03 / D-03 steering-evaluated 事件 budget_remaining 载荷）
    pub fn budget_remaining(&self) -> u32 {
        self.max_steering_budget.saturating_sub(self.steering_count) as u32
    }

    /// 重置纠偏计数（01 §3.3：工具批全部成功 / length 升级 / 无 tool-call 正常结束）
    pub fn reset(&mut self) {
        self.steering_count = 0;
    }
}
