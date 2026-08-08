//! steering 子系统（B3.3，对齐 01 第三章 + 第四章 D2/D3/D7/D8/D9/D10）
//!
//! 组件：
//! - [SteeringCoordinator]：预算与计数的**唯一**持有者（01 §3.3 单一计数源，
//!   D10）。`maxSteeringBudget`（默认 3）为单一配置源；`apply` 执行
//!   `inject-message` 是唯一的计数增量点；`evaluate` 中 inject-message
//!   超预算即跳过，`intervention-required` / `emit-diagnostic` 不受预算限制。
//! - [strategy]：[RecoverySteeringStrategy]——唯一活跃策略，
//!   phases = `after-tools` / `empty-response`（01 §3.1）。
//! - [nudge]：nudge 文本生成 + pending-nudge 注入通道（D8：run 内不注入，
//!   排入下一条用户消息队列，orchestrator 在下一 run 开始时消费）。
//! - [diagnostics]：自终止诊断（D4：非 error 语义，字段结构保留）。
//!
//! 裁决落点（01 第四章，本子系统承担部分；其余由 B3.4 主循环挂接）：
//! - **D2**：tool-promise 机制删除；`promisedToolsWithoutCall` 计数删除，
//!   仅 [diagnostics::SelfTerminationDiagnostic] 保留字段结构。
//! - **D3**：预注入短路保留——`evaluate` 前若输入队列有可运行输入
//!   （`has_pending_input`），调用方（B3.4）应跳过策略评估，避免重复注入。
//! - **D7**：empty-response 预算内重试注入；预算耗尽返回
//!   `intervention-required`（事件照发），但不以 error 收场。
//! - **D8**：nudge 一律不注入当前 run；注入走 [nudge::PendingNudgeChannel]。
//! - **D9**：预算耗尽禁止 `inject-message`（`evaluate` 超预算跳过）；
//!   run 以 stop 收场由 B3.4 保证——本子系统 [AppliedResult] 无 error 语义。
//! - **D10**：删除机器上下文 `steeringCount` 死检查；预算/计数只在
//!   coordinator，单一配置源（coordinator 预算默认 3、策略层
//!   `maxSteeringMessages` 默认 1）。

mod diagnostics;
mod nudge;
mod strategy;

use std::sync::Arc;

use conex_types::events::AgentEvent;
use conex_types::message::AgentMessage;
use serde::{Deserialize, Serialize};

/// 全局最大纠偏注入数（对齐 TS coordinator 默认 3，steering-coordinator.ts:50）
pub const DEFAULT_MAX_STEERING_BUDGET: usize = 3;

/// intervention-required 的默认附带消息（对齐 TS 默认文案）
pub(crate) const DEFAULT_INTERVENTION_MESSAGE: &str =
    "The agent did not recover after runtime steering.";

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
        let mut actions = Vec::new();
        let mut potential = self.steering_count;
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
        actions
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
                    let text = serde_json::to_string(diagnostic)
                        .unwrap_or_else(|_| "{}".to_string());
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

    /// 重置纠偏计数（01 §3.3：工具批全部成功 / length 升级 / 无 tool-call 正常结束）
    pub fn reset(&mut self) {
        self.steering_count = 0;
    }
}

/// 当前 UTC 时间 ISO8601 字符串（毫秒精度，`2026-07-31T08:00:00.000Z`）
///
/// 事件时间戳与注入消息 `createdAt` 共用；无 chrono 依赖，手工换算
/// （Howard Hinnant civil-from-days 算法）。
pub(crate) fn now_iso_utc() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    let (hours, mins, sec) = (secs / 3600 % 24, secs / 60 % 60, secs % 60);
    let (year, month, day) = civil_from_days((secs / 86400) as i64);
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{mins:02}:{sec:02}.{millis:03}Z")
}

/// 从 Unix 天数换算公历年月日（Howard Hinnant 算法）
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 当前 Unix 毫秒（消息 id 前缀用）
pub(crate) fn unix_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

pub use diagnostics::SelfTerminationDiagnostic;
pub use nudge::{
    PendingNudge, PendingNudgeChannel, build_steering_message, runtime_steering_text,
    DEFAULT_PENDING_NUDGE_CAPACITY,
};
pub use strategy::{
    RecoverySteeringStrategy, RecoverySteeringStrategyOptions, detect_recent_tool_error_loop,
    detect_repeated_tool_call_loop, DEFAULT_MAX_CONSECUTIVE_TOOL_ERRORS,
    DEFAULT_MAX_REPEATED_TOOL_CALLS, DEFAULT_MAX_STEERING_MESSAGES,
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::steering::strategy::RecoverySteeringStrategy;

    /// 测试替身策略：对指定阶段固定返回一个动作
    struct FixedStrategy {
        phases: &'static [SteeringPhase],
        action: SteeringAction,
    }

    impl SteeringStrategy for FixedStrategy {
        fn name(&self) -> &'static str {
            "fixed"
        }
        fn phases(&self) -> &'static [SteeringPhase] {
            self.phases
        }
        fn evaluate(
            &self,
            phase: SteeringPhase,
            _context: &SteeringContext<'_>,
        ) -> Option<SteeringAction> {
            if self.phases.contains(&phase) {
                Some(self.action.clone())
            } else {
                None
            }
        }
    }

    fn fake_steering_message() -> AgentMessage {
        AgentMessage {
            id: "fake-inject".into(),
            role: conex_types::message::AgentMessageRole::System,
            created_at: "2026-01-01T00:00:00Z".into(),
            blocks: vec![conex_types::message::AgentMessageBlock::Text {
                text: "fake steering".into(),
            }],
            metadata: None,
            client_message_id: None,
            content: None,
        }
    }

    fn empty_context() -> SteeringContext<'static> {
        SteeringContext {
            messages: &[],
            turn_index: 0,
            steering_count: 0,
            tool_call_count: 0,
            has_pending_input: false,
        }
    }

    /// 计数唯一增量点：evaluate 不改计数，apply 的 inject-message 才 +1（D10）
    #[test]
    fn evaluate_does_not_bump_count_apply_is_the_only_increment_point() {
        let mut coordinator = SteeringCoordinator::new(
            vec![Box::new(FixedStrategy {
                phases: &[SteeringPhase::EmptyResponse],
                action: SteeringAction::InjectMessage {
                    message: fake_steering_message(),
                    reason: SteeringReason::EmptyResponse,
                },
            })],
            SteeringCoordinatorOptions::default(),
        );
        let mut conversation = Vec::new();

        let actions = coordinator.evaluate(SteeringPhase::EmptyResponse, &empty_context());
        assert_eq!(actions.len(), 1);
        assert_eq!(
            coordinator.get_steering_count(),
            0,
            "evaluate 不得改变计数（计数唯一增量点在 apply）"
        );

        coordinator
            .apply(&actions, "sess-1", &mut conversation)
            .events
            .len();
        assert_eq!(coordinator.get_steering_count(), 1, "apply inject-message 后计数 +1");
        assert_eq!(conversation.len(), 1, "注入消息已 append 进对话");
    }

    /// 预算边界：预算 N 允许恰好 N 次注入（N-1 为最后一次允许），第 N+1 次跳过
    #[test]
    fn inject_budget_boundary_n_minus_1_and_n() {
        let mut coordinator = SteeringCoordinator::new(
            vec![Box::new(FixedStrategy {
                phases: &[SteeringPhase::EmptyResponse],
                action: SteeringAction::InjectMessage {
                    message: fake_steering_message(),
                    reason: SteeringReason::EmptyResponse,
                },
            })],
            SteeringCoordinatorOptions {
                max_steering_budget: Some(3),
            },
        );
        let mut conversation = Vec::new();

        for expected in 1..=3 {
            let actions = coordinator.evaluate(SteeringPhase::EmptyResponse, &empty_context());
            assert_eq!(actions.len(), 1, "预算内第 {expected} 次注入应被允许");
            coordinator.apply(&actions, "sess-1", &mut conversation);
            assert_eq!(coordinator.get_steering_count(), expected);
        }

        // 预算耗尽：第 4 次 inject-message 被跳过（D9 禁止超预算注入）——
        // 不静默跳过，改产 budget-exhausted 诊断事件（T06.3 Q08 接线）
        let actions = coordinator.evaluate(SteeringPhase::EmptyResponse, &empty_context());
        assert_eq!(
            actions.len(),
            1,
            "预算耗尽应产出诊断事件而非空（Q32 修复）"
        );
        assert!(matches!(
            actions.as_slice(),
            [SteeringAction::EmitDiagnostic { reason, .. }]
                if reason == "steering-budget-exhausted"
        ));
        assert_eq!(coordinator.get_steering_count(), 3, "计数不再增长");
        assert_eq!(conversation.len(), 3, "对话不再追加");
    }

    /// 干预动作不受预算限制：预算 0 时 intervention-required 仍照发（D9）
    #[test]
    fn intervention_not_limited_by_budget() {
        let mut coordinator = SteeringCoordinator::new(
            vec![Box::new(FixedStrategy {
                phases: &[SteeringPhase::EmptyResponse],
                action: SteeringAction::InterventionRequired {
                    reason: SteeringReason::EmptyResponse,
                    message: None,
                },
            })],
            SteeringCoordinatorOptions {
                max_steering_budget: Some(0),
            },
        );
        let mut conversation = Vec::new();

        let actions = coordinator.evaluate(SteeringPhase::EmptyResponse, &empty_context());
        assert_eq!(actions.len(), 1, "预算耗尽不阻断 intervention-required");

        let result = coordinator.apply(&actions, "sess-1", &mut conversation);
        assert!(result.intervention_required);
        assert_eq!(coordinator.get_steering_count(), 0, "干预不消耗预算");
        assert!(conversation.is_empty(), "干预不修改对话");
        assert!(
            result
                .events
                .iter()
                .any(|e| matches!(e, AgentEvent::RuntimeInterventionRequired { .. })),
            "intervention 事件照发"
        );
    }

    /// 诊断动作不受预算限制且不计数、不修改对话
    #[test]
    fn emit_diagnostic_unlimited_no_count_no_conversation_change() {
        let mut coordinator = SteeringCoordinator::new(
            vec![Box::new(FixedStrategy {
                phases: &[SteeringPhase::AfterTools],
                action: SteeringAction::EmitDiagnostic {
                    diagnostic: serde_json::json!({"note": "observability"}),
                    reason: "after-tools".into(),
                },
            })],
            SteeringCoordinatorOptions {
                max_steering_budget: Some(0),
            },
        );
        let mut conversation = Vec::new();

        let actions = coordinator.evaluate(SteeringPhase::AfterTools, &empty_context());
        assert_eq!(actions.len(), 1);

        let result = coordinator.apply(&actions, "sess-1", &mut conversation);
        assert!(!result.intervention_required);
        assert_eq!(coordinator.get_steering_count(), 0, "诊断不计数");
        assert!(conversation.is_empty(), "诊断不修改对话");
        let steering = result
            .events
            .iter()
            .find_map(|e| match e {
                AgentEvent::RuntimeSteering { message, .. } => Some(message),
                _ => None,
            })
            .expect("应发射 runtime-steering 事件");
        assert_eq!(
            steering
                .metadata
                .as_ref()
                .and_then(|m| m.get("kind"))
                .and_then(|k| k.as_str()),
            Some("diagnostic")
        );
    }

    /// T06.3 Q08 / Q32：预算耗尽跳过 inject-message 时产出
    /// budget-exhausted 诊断事件——不静默跳过，用户可见预算/计数
    #[test]
    fn budget_exhausted_emits_diagnostic_instead_of_silent_skip() {
        let mut coordinator = SteeringCoordinator::new(
            vec![Box::new(FixedStrategy {
                phases: &[SteeringPhase::EmptyResponse],
                action: SteeringAction::InjectMessage {
                    message: fake_steering_message(),
                    reason: SteeringReason::EmptyResponse,
                },
            })],
            SteeringCoordinatorOptions {
                max_steering_budget: Some(1),
            },
        );
        let mut conversation = Vec::new();

        // 预算 1：首次注入允许
        let actions = coordinator.evaluate(SteeringPhase::EmptyResponse, &empty_context());
        assert_eq!(actions.len(), 1);
        coordinator.apply(&actions, "sess-1", &mut conversation);
        assert_eq!(coordinator.get_steering_count(), 1);

        // 预算耗尽：产出 EmitDiagnostic（reason=steering-budget-exhausted，
        // 载荷含 budget 与 steeringCount），不静默跳过
        let actions = coordinator.evaluate(SteeringPhase::EmptyResponse, &empty_context());
        assert_eq!(actions.len(), 1);
        match &actions[0] {
            SteeringAction::EmitDiagnostic { reason, diagnostic } => {
                assert_eq!(reason, "steering-budget-exhausted");
                assert_eq!(
                    diagnostic.get("budget").and_then(|b| b.as_u64()),
                    Some(1)
                );
                assert_eq!(
                    diagnostic.get("steeringCount").and_then(|c| c.as_u64()),
                    Some(1)
                );
            }
            other => panic!("应为 EmitDiagnostic，实际 {other:?}"),
        }
        // apply：诊断事件照发、不计数、不修改对话
        let result = coordinator.apply(&actions, "sess-1", &mut conversation);
        assert!(!result.intervention_required);
        assert_eq!(coordinator.get_steering_count(), 1, "诊断不消耗预算");
        assert_eq!(conversation.len(), 1, "诊断不修改对话（首轮注入的消息保留）");
        let steering = result
            .events
            .iter()
            .find_map(|e| match e {
                AgentEvent::RuntimeSteering { message, .. } => Some(message),
                _ => None,
            })
            .expect("应发射 runtime-steering 诊断事件");
        assert_eq!(
            steering
                .metadata
                .as_ref()
                .and_then(|m| m.get("kind"))
                .and_then(|k| k.as_str()),
            Some("diagnostic")
        );
    }

    /// 阶段过滤：策略只在其 phases 声明的阶段被调用
    #[test]
    fn phase_filtering_skips_unlisted_phases() {
        let coordinator = SteeringCoordinator::new(
            vec![Box::new(FixedStrategy {
                phases: &[SteeringPhase::AfterTools],
                action: SteeringAction::InjectMessage {
                    message: fake_steering_message(),
                    reason: SteeringReason::EmptyResponse,
                },
            })],
            SteeringCoordinatorOptions::default(),
        );
        assert!(coordinator
            .evaluate(SteeringPhase::EmptyResponse, &empty_context())
            .is_empty());
        assert_eq!(
            coordinator.evaluate(SteeringPhase::AfterTools, &empty_context()).len(),
            1
        );
    }

    /// reset 语义：清零后注入重新可用（01 §3.3 重置时机由 B3.4 调用）
    #[test]
    fn reset_clears_count_and_reopens_budget() {
        let mut coordinator = SteeringCoordinator::new(
            vec![Box::new(FixedStrategy {
                phases: &[SteeringPhase::EmptyResponse],
                action: SteeringAction::InjectMessage {
                    message: fake_steering_message(),
                    reason: SteeringReason::EmptyResponse,
                },
            })],
            SteeringCoordinatorOptions {
                max_steering_budget: Some(1),
            },
        );
        let mut conversation = Vec::new();

        let actions = coordinator.evaluate(SteeringPhase::EmptyResponse, &empty_context());
        coordinator.apply(&actions, "sess-1", &mut conversation);
        assert_eq!(coordinator.get_steering_count(), 1);

        // 预算耗尽：不再注入——改产 EmitDiagnostic（T06.3 Q32：不静默跳过）
        let actions = coordinator
            .evaluate(SteeringPhase::EmptyResponse, &empty_context());
        assert_eq!(actions.len(), 1);
        assert!(matches!(
            &actions[0],
            SteeringAction::EmitDiagnostic {
                reason,
                ..
            } if reason == "steering-budget-exhausted"
        ), "预算耗尽应产出 budget-exhausted 诊断而非注入");

        coordinator.reset();
        assert_eq!(coordinator.get_steering_count(), 0);

        let actions = coordinator.evaluate(SteeringPhase::EmptyResponse, &empty_context());
        assert_eq!(actions.len(), 1, "reset 后注入重新可用");
        coordinator.apply(&actions, "sess-1", &mut conversation);
        assert_eq!(coordinator.get_steering_count(), 1);
    }

    /// D7/D9 收场语义：empty-response 预算耗尽 → intervention 事件照发、
    /// 不再注入、结果无 error 语义（stop 收场由 B3.4 保证）
    #[test]
    fn empty_response_exhaustion_intervention_without_error_semantics() {
        // 真实策略 + 默认 maxSteeringMessages=1
        let mut coordinator = SteeringCoordinator::new(
            vec![Box::new(RecoverySteeringStrategy::default())],
            SteeringCoordinatorOptions::default(),
        );
        let mut conversation = Vec::new();

        // 第 1 次 empty-response：预算内重试（D7）
        let actions = coordinator.evaluate(SteeringPhase::EmptyResponse, &empty_context());
        assert_eq!(actions.len(), 1, "第 1 次空响应预算内注入");
        let result = coordinator.apply(&actions, "sess-1", &mut conversation);
        assert!(!result.intervention_required);
        assert_eq!(conversation.len(), 1);
        assert_eq!(coordinator.get_steering_count(), 1);

        // 第 2 次 empty-response：预算耗尽 → intervention-required（D7/D9）
        let actions = coordinator.evaluate(SteeringPhase::EmptyResponse, &empty_context());
        assert_eq!(actions.len(), 1);
        assert!(matches!(
            actions[0],
            SteeringAction::InterventionRequired { reason: SteeringReason::EmptyResponse, .. }
        ));
        let result = coordinator.apply(&actions, "sess-1", &mut conversation);
        assert!(result.intervention_required, "intervention 事件照发");
        assert_eq!(conversation.len(), 1, "耗尽后不再注入");
        assert_eq!(coordinator.get_steering_count(), 1, "干预不消耗预算");
        assert!(
            result
                .events
                .iter()
                .any(|e| matches!(e, AgentEvent::RuntimeInterventionRequired { .. })),
            "runtime-intervention-required 事件照发"
        );
    }

    /// 干预事件 choices 固定为 rollback/pause/user-instruction（对齐 TS）
    #[test]
    fn intervention_event_carries_choices() {
        let mut coordinator = SteeringCoordinator::new(
            vec![Box::new(FixedStrategy {
                phases: &[SteeringPhase::EmptyResponse],
                action: SteeringAction::InterventionRequired {
                    reason: SteeringReason::ToolLoop,
                    message: Some("stop repeating".into()),
                },
            })],
            SteeringCoordinatorOptions::default(),
        );
        let actions = coordinator.evaluate(SteeringPhase::EmptyResponse, &empty_context());
        let result = coordinator.apply(&actions, "sess-1", &mut Vec::new());
        match &result.events[0] {
            AgentEvent::RuntimeInterventionRequired {
                choices, message, reason, ..
            } => {
                assert_eq!(
                    choices,
                    &vec!["rollback".to_string(), "pause".to_string(), "user-instruction".to_string()]
                );
                assert_eq!(message, "stop repeating");
                assert_eq!(reason, "tool-loop");
            }
            other => panic!("应为 runtime-intervention-required 事件，实际 {other:?}"),
        }
    }

    /// 时间戳格式：UTC ISO8601 毫秒精度
    #[test]
    fn now_iso_utc_formats_iso8601() {
        let ts = now_iso_utc();
        assert!(ts.len() >= 24, "含毫秒与 Z 后缀");
        assert!(ts.ends_with('Z'));
        let mid = &ts[..ts.len() - 1];
        let date_part = &mid[..10];
        assert_eq!(&date_part[4..5], "-");
        assert_eq!(&date_part[7..8], "-");
        let time_part = &mid[11..];
        assert_eq!(&time_part[2..3], ":");
        assert_eq!(&time_part[5..6], ":");
        assert_eq!(&time_part[8..9], ".");
    }

    /// 日期换算：Unix 天数 0 与已知基准（2026-07-31 = 20665）
    #[test]
    fn civil_from_days_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(1), (1970, 1, 2));
        assert_eq!(civil_from_days(20665), (2026, 7, 31));
    }
}

/// 测试共享构造器（仅测试编译目标）
#[cfg(test)]
pub(crate) mod testutil {
    use conex_types::message::{
        AgentMessage, AgentMessageBlock, AgentMessageRole, ToolCallBlock,
    };
    use conex_types::tool::ToolOutput;

    /// 用户消息
    pub(crate) fn user(text: &str) -> AgentMessage {
        AgentMessage {
            id: format!("user-{text}"),
            role: AgentMessageRole::User,
            created_at: "2026-01-01T00:00:00Z".into(),
            blocks: vec![AgentMessageBlock::Text { text: text.into() }],
            metadata: None,
            client_message_id: None,
            content: None,
        }
    }

    /// 工具结果消息（文本输出 + 错误标志）
    pub(crate) fn tool_result(text: &str, is_error: bool) -> AgentMessage {
        tool_result_output(text, is_error, ToolOutput::text(text))
    }

    /// 工具结果消息（json 输出 + 错误标志）
    pub(crate) fn tool_result_json(is_error: bool, json: serde_json::Value) -> AgentMessage {
        tool_result_output("", is_error, ToolOutput {
            text: None,
            json: Some(json),
            artifacts: None,
        })
    }

    fn tool_result_output(text: &str, is_error: bool, output: ToolOutput) -> AgentMessage {
        AgentMessage {
            id: format!("tool-result-{text}"),
            role: AgentMessageRole::Tool,
            created_at: "2026-01-01T00:00:00Z".into(),
            blocks: vec![AgentMessageBlock::ToolResult {
                tool_call_id: format!("call-{text}"),
                tool_name: "test_tool".into(),
                output,
                is_error,
            }],
            metadata: None,
            client_message_id: None,
            content: None,
        }
    }

    /// 助手消息（携带若干工具调用块）
    pub(crate) fn assistant_with_tool_calls(calls: &[(&str, serde_json::Value)]) -> AgentMessage {
        let blocks = calls
            .iter()
            .map(|(name, input)| {
                AgentMessageBlock::ToolCall(ToolCallBlock {
                    id: format!("call-{name}"),
                    tool_name: (*name).into(),
                    input: input.clone(),
                })
            })
            .collect();
        AgentMessage {
            id: "assistant-tool".into(),
            role: AgentMessageRole::Assistant,
            created_at: "2026-01-01T00:00:00Z".into(),
            blocks,
            metadata: None,
            client_message_id: None,
            content: None,
        }
    }
}
