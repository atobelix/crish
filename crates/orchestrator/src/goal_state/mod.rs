//! D5 goal 引擎化——GoalState + RoundAssessment 纯函数侧（实施轮 1 A2）
//!
//! 设计依据：
//! - `docs/continuity-repair/dimensions/D5-Goal引擎化与完成契约.md`
//!   （§3.2 goal_state 键读写、§3.3 收口 RoundAssessment 纯函数、
//!   §3.4 stalled 工具批指纹、§3.5 L0+L1 完成判定、§4.1 数据面冻结形状）；
//! - `docs/continuity-repair/01-敲定方案.md`（裁决 #9 判定位置 / #10 L0+L1 /
//!   #11 工具批指纹、§3 第3条 error 轮不计 stalled 与 current_round）；
//! - `docs/continuity-repair/final/00-正式实现规范.md`（§3.4 goal 引擎化、
//!   §4 数据面）；
//! - `docs/continuity-repair/05-Goal模式与主动结束后继续能力.md`（领域背景）。
//!
//! 本模块为**纯函数域**：无 IO、无副作用，直接单测；session_meta 读写
//! （load/save）与事件发射由壳层（drive_run_loop 收口）接线，本模块仅
//! 提供 JSON 序列化/反序列化面（fail-open）。
//!
//! 判定优先级（§3.3，从高到低）：
//! 1. 无 goal / 已终态 → [GoalDecision::NoGoal]（不评估不写）；
//! 2. reason 门禁：非 Stop（Error/MaxTurns/Aborted/Stopped）→ Blocked，
//!    error 轮不计轮数、不计 stalled（01 §3 第3条）；
//! 3. 完成判定 L0+L1（§3.5）：checklist 全勾，或无 checklist 且文案 DONE；
//!    文案 DONE 但 checklist 未全勾 → 不完成（prematureDoneClaim 对齐）；
//! 4. 轮数上限：current_round + 1 >= max_rounds → Blocked(goal-max-rounds)；
//! 5. stalled 检测（§3.4）：工具批指纹相同且无成功工具结果 → stalled+1，
//!    达 max_stalled_rounds → Blocked(goal-stalled)，否则 NoProgress；
//! 6. 默认 → Continue（needs-continuation）。

use conex_types::session::AgentEndReason;
use serde::{Deserialize, Serialize};

use crate::normalize;

mod assess;
mod checklist;

pub use assess::{assess_round, tool_batch_fingerprint};
pub use checklist::{parse_checklist, reply_looks_goal_done};

/// session_meta `goal_state` 键名（01 敲定 §2.1：键命名空间独占，不复用
/// `recover_*` 前缀）
pub const GOAL_STATE_KEY: &str = "goal_state";

/// goal 轮数硬上限缺省值（§3.1 / A5：对齐前端 GOAL_DEFAULT_MAX_ITERATIONS=12，
/// 消除 `?? 5` 分叉）
pub const DEFAULT_GOAL_MAX_ROUNDS: u32 = 12;

/// stalled 阈值缺省值（§3.1 / 动态决策 9：对齐前端
/// GOAL_DEFAULT_MAX_STALLED_ROUNDS=2）
pub const DEFAULT_GOAL_MAX_STALLED_ROUNDS: u32 = 2;

/// goal_state 内嵌 schema 自描述版本（02-定夺 S1 批准纳入；缺省视为 1，
/// 不参与迁移判定，§4.1）
pub const GOAL_SCHEMA_VERSION: u32 = 1;

/// 完成轮 stopped_reason（§4.1 / A6：终态 reason=goal-completed）
pub const GOAL_COMPLETED_REASON: &str = "goal-completed";

/// 轮数耗尽 stopped_reason（§4.1 / A3：终态 reason=goal-max-rounds）
pub const GOAL_MAX_ROUNDS_REASON: &str = "goal-max-rounds";

/// 停滞 stopped_reason（§4.1 / A2：终态 reason=goal-stalled）
pub const GOAL_STALLED_REASON: &str = "goal-stalled";

/// 正常停止收场 stopped_reason（§4.1 枚举首值；非终态）
pub const STOP_REASON: &str = "stop";

/// 终态 stopped_reason 集合（goal-completed 由 [GoalState::status] 单独
/// 归为 Completed，其余归为 Blocked；§4.1「终态后 status 由 stopped_reason
/// 推断」）
const TERMINAL_STOPPED_REASONS: [&str; 6] = [
    GOAL_MAX_ROUNDS_REASON,
    GOAL_STALLED_REASON,
    "error",
    "max-turns",
    "aborted",
    "stopped",
];

/// goal_state 键形状（§4.1 冻结；字段名 snake_case，schemaVersion/
/// updatedAtMs 两字段经 02-定夺 S1 批准为驼峰，不引入版本列）。
///
/// serde 全部字段带缺省（fail-open 字段级容忍：缺省字段取默认值，
/// max_rounds/max_stalled_rounds 取 [DEFAULT_GOAL_MAX_ROUNDS] /
/// [DEFAULT_GOAL_MAX_STALLED_ROUNDS]，空对象即默认态）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct GoalState {
    /// 自描述 schema 版本（缺省视为 1，不参与迁移判定）
    #[serde(rename = "schemaVersion", default = "default_schema_version")]
    pub schema_version: u32,
    /// 目标文本（续轮注入主源，每轮必有）
    #[serde(default)]
    pub goal: String,
    /// 轮数硬上限（缺省 12，落库后为权威值）
    #[serde(default = "default_max_rounds")]
    pub max_rounds: u32,
    /// stalled 阈值（缺省 2，连续签名相同轮达阈值即 goal-stalled）
    #[serde(default = "default_max_stalled_rounds")]
    pub max_stalled_rounds: u32,
    /// 已收口正常轮次（仅 Stop 收场轮递增；error/max-turns/aborted/
    /// stopped 轮不递增，01 §3 第3条）
    #[serde(default)]
    pub current_round: u32,
    /// 连续 stalled 轮计数（成功工具结果或签名变化重置，§3.4）
    #[serde(default)]
    pub stalled_rounds: u32,
    /// 最近一次工具批指纹（`tools:fnv1a:<hex>`；无工具轮不更新）
    pub progress_signature: Option<String>,
    /// 最近一轮收场原因（终态判定依据，§4.1 枚举）
    pub stopped_reason: Option<String>,
    /// 最后写入时间（epoch ms，收口写方刷新）
    #[serde(rename = "updatedAtMs", default)]
    pub updated_at_ms: i64,
}

fn default_schema_version() -> u32 {
    GOAL_SCHEMA_VERSION
}

fn default_max_rounds() -> u32 {
    DEFAULT_GOAL_MAX_ROUNDS
}

fn default_max_stalled_rounds() -> u32 {
    DEFAULT_GOAL_MAX_STALLED_ROUNDS
}

/// goal 状态投影（status 不落库，由 stopped_reason 推断，§4.1）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GoalStatus {
    /// 进行中（无终态 stopped_reason，goal_pending 可判定）
    Active,
    /// 已完成（stopped_reason=goal-completed）
    Completed,
    /// 被阻断（goal-max-rounds / goal-stalled / error / max-turns /
    /// aborted / stopped）
    Blocked,
}

impl GoalState {
    /// 装配新 goal（run_task_impl 装配处调用；新 /goal 覆盖语义，§3.8）
    pub fn new(goal: impl Into<String>, max_rounds: u32, max_stalled_rounds: u32) -> Self {
        Self {
            schema_version: GOAL_SCHEMA_VERSION,
            goal: goal.into(),
            max_rounds,
            max_stalled_rounds,
            current_round: 0,
            stalled_rounds: 0,
            progress_signature: None,
            stopped_reason: None,
            updated_at_ms: 0,
        }
    }

    /// 缺省规则装配（§3.1：max_rounds None → 12，max_stalled_rounds
    /// None → 2）
    pub fn with_defaults(
        goal: impl Into<String>,
        max_rounds: Option<u32>,
        max_stalled_rounds: Option<u32>,
    ) -> Self {
        Self::new(
            goal,
            max_rounds.unwrap_or(DEFAULT_GOAL_MAX_ROUNDS),
            max_stalled_rounds.unwrap_or(DEFAULT_GOAL_MAX_STALLED_ROUNDS),
        )
    }

    /// status 由 stopped_reason 推断（§4.1：终态后 status 由 stopped_reason
    /// 推断，不单列 status 字段避免双计数源）
    pub fn status(&self) -> GoalStatus {
        match self.stopped_reason.as_deref() {
            Some(GOAL_COMPLETED_REASON) => GoalStatus::Completed,
            Some(reason) if TERMINAL_STOPPED_REASONS.contains(&reason) => GoalStatus::Blocked,
            _ => GoalStatus::Active,
        }
    }

    /// 是否仍处进行中（goal_pending 判定前提）
    pub fn is_active(&self) -> bool {
        self.status() == GoalStatus::Active
    }

    /// 是否已终态（后续收口评估直接 NoGoal，不评估不写）
    pub fn is_terminal(&self) -> bool {
        !self.is_active()
    }

    /// goal_pending 判定（§3.6 第四源，壳层 decide_idle_resume 接线时
    /// 调用；[normalize::allows_auto_continue] 的首个生产调用点）：
    /// 进行中 && 未达轮数上限 && reason 允许自动续轮（仅 Stop）。
    pub fn goal_pending(&self, reason: AgentEndReason) -> bool {
        self.is_active()
            && self.current_round < self.max_rounds
            && normalize::allows_auto_continue(reason)
    }

    /// 序列化为 `goal_state` 键落库形态（JSON 字符串；坏形状兜底 `{}`，
    /// 由 [Self::from_json] fail-open 兜回默认态）
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    /// 宽容解析（fail-open，§4.1）：缺键（None）/ 坏 JSON → None = 无 goal；
    /// 字段级容忍：未知字段忽略、缺省字段用默认值（对齐 recovery.rs:327-335
    /// RecoveryBudget::from_json 先例）
    pub fn from_json(raw: Option<&str>) -> Option<Self> {
        raw.and_then(|raw| serde_json::from_str::<GoalState>(raw).ok())
    }

    /// 纯函数写回（§3.3 壳层收口清单的集中形态）：应用本轮 [RoundAssessment]
    /// 推进 current_round / stalled_rounds / progress_signature /
    /// stopped_reason / updated_at_ms。
    ///
    /// - NoGoal → 原样返回（不评估不写）；
    /// - current_round 仅 Stop 收场轮 +1（01 §3 第3条：error 等轮不递增）；
    /// - stalled_rounds += stalled_delta；
    /// - progress_signature：本轮有签名则更新，无工具轮（None）沿用旧值；
    /// - stopped_reason = assessment.reason_detail（终态由 status 推断）。
    pub fn advance(&self, input: &RoundInput, assessment: &RoundAssessment) -> Self {
        if assessment.decision == GoalDecision::NoGoal {
            return self.clone();
        }
        let mut next = self.clone();
        if input.end_reason == AgentEndReason::Stop {
            next.current_round = next.current_round.saturating_add(1);
        }
        next.stalled_rounds = next.stalled_rounds.saturating_add(assessment.stalled_delta);
        if let Some(sig) = &assessment.next_progress_signature {
            next.progress_signature = Some(sig.clone());
        }
        next.stopped_reason = Some(assessment.reason_detail.clone());
        next.updated_at_ms = crate::now_ms();
        next
    }
}

impl Default for GoalState {
    fn default() -> Self {
        Self::with_defaults("", None, None)
    }
}

/// 收口 RoundAssessment 输入（§3.3 签名；无 IO 纯输入）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoundInput {
    /// 本轮收场 reason（RunOutcome.reason）
    pub end_reason: AgentEndReason,
    /// 本轮助手终稿文本（L0/L1 完成判定输入）
    pub assistant_text: String,
    /// 本轮工具批（tool_name + 参数顶层 key 集，stalled 指纹输入）
    pub tool_calls: Vec<ToolCallStamp>,
    /// 本轮成功工具结果计数（L2 退化证据；>0 重置 stalled，§3.4）
    pub tool_success_count: u32,
    /// runtime-error 事件文案（drive_run_loop 已捕获；观测字段，错误
    /// 收场由 end_reason 拦截，本字段不改变判定）
    pub runtime_error: Option<String>,
    /// 评估前 goal_state 读快照
    pub current: GoalState,
}

/// 单笔工具调用指纹戳记（§3.4：tool_name + 参数 JSON 顶层 key 集合）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCallStamp {
    /// 工具名
    pub tool_name: String,
    /// 参数 JSON 顶层 key 集合（值噪声被 key 集降级容忍）
    pub param_keys: Vec<String>,
}

/// 收口 RoundAssessment 输出（§3.3 签名；状态落库与事件发射由壳层负责）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoundAssessment {
    /// 本轮决策
    pub decision: GoalDecision,
    /// 落 goal_state.stopped_reason（NoGoal 轮为 None，不写）
    pub stopped_reason: Option<String>,
    /// 观测：goal-completed / goal-max-rounds / goal-stalled / stop /
    /// error / max-turns / aborted / stopped
    pub reason_detail: String,
    /// 本轮工具批签名（无工具轮 = None = 沿用上轮签名，§3.4）
    pub next_progress_signature: Option<String>,
    /// 本轮 stalled 增量（0 或 1；error 轮恒 0）
    pub stalled_delta: u32,
    /// [normalize::allows_auto_continue] 生产调用结果（仅 Stop 为 true；
    /// NoGoal 轮恒 false——不评估不写，不参与 goal 续轮）
    pub should_continue: bool,
}

/// 本轮 goal 决策（§3.3 枚举）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GoalDecision {
    /// 继续推进（needs-continuation）
    Continue,
    /// 完成（L0+L1 门禁通过，stopped_reason=goal-completed）
    Completed,
    /// 无实质进展（stalled 已递增但未达阈值；继续推进）
    NoProgress,
    /// 被阻断（error/max-turns/aborted/stopped 收场，或
    /// goal-max-rounds / goal-stalled）
    Blocked,
    /// 无 goal / 已终态（不评估不写）
    NoGoal,
}

/// markdown checklist 条目（L1 解析产物）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChecklistItem {
    /// 任务正文
    pub text: String,
    /// 是否已勾选（`[x]` / `[X]`）
    pub done: bool,
}

#[cfg(test)]
mod tests;
