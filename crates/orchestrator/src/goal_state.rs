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

/// 收口评估纯函数（§3.3 判定伪代码；无 IO、无副作用，可单测）。
///
/// 判定优先级：NoGoal → reason 门禁 → L0+L1 完成 → 轮数上限 → stalled →
/// 默认 Continue。完成判定先于轮数上限（伪代码步骤 3「且未完成」修饰 +
/// 前端 decideGoalContinuation 先 done 后 max_iter 顺序，
/// goalModeController.ts:235-257）。
pub fn assess_round(input: &RoundInput) -> RoundAssessment {
    let current = &input.current;
    // 1. 无 goal / 已终态：不评估不写（§3.3 步骤 1；goal_pending 恒 false
    //    由壳层 status 拦截）
    if !current.is_active() {
        return RoundAssessment {
            decision: GoalDecision::NoGoal,
            stopped_reason: None,
            reason_detail: String::new(),
            next_progress_signature: None,
            stalled_delta: 0,
            should_continue: false,
        };
    }
    let continue_allowed = normalize::allows_auto_continue(input.end_reason);
    // 2. reason 门禁：非 Stop（Error/MaxTurns/Aborted/Stopped）→ Blocked；
    //    error 轮不计轮数、不计 stalled（01 敲定 §3 第3条；error 收场转
    //    D2 error 分支，不触发 goal_pending）
    if input.end_reason != AgentEndReason::Stop {
        let detail = end_reason_detail(input.end_reason);
        return RoundAssessment {
            decision: GoalDecision::Blocked,
            stopped_reason: Some(detail.clone()),
            reason_detail: detail,
            next_progress_signature: None,
            stalled_delta: 0,
            should_continue: continue_allowed,
        };
    }
    // 3. 完成判定 L0+L1（§3.5 / 裁决 #10）：
    //    - L1：checklist 非空且全勾 → Completed（主门禁）；
    //    - L0：无 checklist 且文案 DONE → Completed（候选收口）；
    //    - 文案 DONE 但 checklist 非空未全勾 → 不完成（prematureDoneClaim
    //      对齐 goalModeController.ts:232，继续推进路径）
    let checklist = parse_checklist(&input.assistant_text);
    let has_tasks = !checklist.is_empty();
    let all_done = has_tasks && checklist.iter().all(|item| item.done);
    let looks_done = reply_looks_goal_done(&input.assistant_text);
    if all_done || (looks_done && !has_tasks) {
        return RoundAssessment {
            decision: GoalDecision::Completed,
            stopped_reason: Some(GOAL_COMPLETED_REASON.into()),
            reason_detail: GOAL_COMPLETED_REASON.into(),
            next_progress_signature: None,
            stalled_delta: 0,
            should_continue: continue_allowed,
        };
    }
    // 4. 轮数上限：current_round + 1 >= max_rounds 且未完成 → Blocked
    //    （goal-max-rounds；A3，前端语义对齐 goalModeController.ts:244-257）
    if current.current_round + 1 >= current.max_rounds {
        return RoundAssessment {
            decision: GoalDecision::Blocked,
            stopped_reason: Some(GOAL_MAX_ROUNDS_REASON.into()),
            reason_detail: GOAL_MAX_ROUNDS_REASON.into(),
            next_progress_signature: None,
            stalled_delta: 0,
            should_continue: continue_allowed,
        };
    }
    // 5. stalled 检测（§3.4 / 裁决 #11）：
    //    - 无工具轮 → 签名不变（沿用上轮），自动落入「签名相同」轨道，
    //      正确计入 stalled（03 §2D 论证：消息 id 链误判率高已弃用）；
    //    - 本轮有成功工具结果（tool_success_count > 0）→ 重置 stalled；
    //    - 签名变化 → 重置 stalled。
    let next_sig = tool_batch_fingerprint(&input.tool_calls);
    let effective_sig = next_sig
        .clone()
        .or_else(|| current.progress_signature.clone());
    let stalled_delta = if input.tool_success_count > 0 {
        0
    } else if effective_sig == current.progress_signature {
        1
    } else {
        0
    };
    if stalled_delta == 1 && current.stalled_rounds + 1 >= current.max_stalled_rounds {
        return RoundAssessment {
            decision: GoalDecision::Blocked,
            stopped_reason: Some(GOAL_STALLED_REASON.into()),
            reason_detail: GOAL_STALLED_REASON.into(),
            next_progress_signature: next_sig,
            stalled_delta: 1,
            should_continue: continue_allowed,
        };
    }
    if stalled_delta == 1 {
        return RoundAssessment {
            decision: GoalDecision::NoProgress,
            stopped_reason: Some(STOP_REASON.into()),
            reason_detail: STOP_REASON.into(),
            next_progress_signature: next_sig,
            stalled_delta: 1,
            should_continue: continue_allowed,
        };
    }
    // 6. 默认 → Continue（needs-continuation）
    RoundAssessment {
        decision: GoalDecision::Continue,
        stopped_reason: Some(STOP_REASON.into()),
        reason_detail: STOP_REASON.into(),
        next_progress_signature: next_sig,
        stalled_delta: 0,
        should_continue: continue_allowed,
    }
}

/// 工具批指纹（§3.4 / 裁决 #11）：对每笔工具调用取
/// `tool_name + 参数 JSON 顶层 key 集合`（排序后拼串），序列整体 FNV-1a
/// 哈希（复用 recovery.rs:251-262 fingerprint 的 FNV-1a 参数）；参数值
/// 噪声（时间戳/随机值）被 key 集降级容忍；调用顺序敏感。
///
/// 无工具轮 → None（签名不变，沿用上轮 progress_signature）。
pub fn tool_batch_fingerprint(calls: &[ToolCallStamp]) -> Option<String> {
    if calls.is_empty() {
        return None;
    }
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for call in calls {
        feed_fnv1a(&mut hash, call.tool_name.as_bytes());
        feed_fnv1a(&mut hash, &[0]);
        let mut keys = call.param_keys.clone();
        keys.sort();
        for key in &keys {
            feed_fnv1a(&mut hash, key.as_bytes());
            feed_fnv1a(&mut hash, &[0]);
        }
    }
    Some(format!("tools:fnv1a:{hash:016x}"))
}

/// FNV-1a 64 位单步喂入（offset basis 0xcbf29ce484222325、prime
/// 0x100000001b3，与 recovery.rs fingerprint 同参数）
fn feed_fnv1a(hash: &mut u64, bytes: &[u8]) {
    for &byte in bytes {
        *hash ^= u64::from(byte);
        *hash = hash.wrapping_mul(0x0000_0001_0000_01b3);
    }
}

/// 解析助手 markdown checklist（L1 主门禁；对齐前端 parseChecklistTasks，
/// goalModeController.ts:103-122）：
///
/// - 行格式 `^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$`；
/// - 丢弃「本轮总结 / 小结 / 回顾」类伪任务（对齐前端 PSEUDO_TASK_RE，
///   goalModeController.ts:22 / :114）。
pub fn parse_checklist(text: &str) -> Vec<ChecklistItem> {
    let mut items = Vec::new();
    for line in text.lines() {
        if let Some((done, body)) = parse_checklist_line(line) {
            items.push(ChecklistItem {
                text: body.to_string(),
                done,
            });
        }
    }
    items
}

/// 单行 checklist 解析（纯函数；行格式与前端正则同构）
fn parse_checklist_line(line: &str) -> Option<(bool, &str)> {
    let trimmed = line.trim_start();
    let after_marker = trimmed
        .strip_prefix('-')
        .or_else(|| trimmed.strip_prefix('*'))?;
    let after_marker = after_marker.trim_start();
    let after_bracket = after_marker.strip_prefix('[')?;
    let (mark, rest) = after_bracket.split_at(1);
    let done = match mark {
        " " => false,
        "x" | "X" => true,
        _ => return None,
    };
    let rest = rest.strip_prefix(']')?;
    // `\s+` 要求至少一个空白（与前端正则一致）
    let first_char = rest.chars().next()?;
    if !first_char.is_whitespace() {
        return None;
    }
    let body = rest.trim_start();
    if body.is_empty() {
        return None;
    }
    // 伪任务丢弃（前端 PSEUDO_TASK_RE /^本轮(总结|小结|回顾)/）
    if is_pseudo_task(body) {
        return None;
    }
    Some((done, body.trim_end()))
}

/// 伪任务判据（前端 PSEUDO_TASK_RE 同构：`本轮总结` / `本轮小结` /
/// `本轮回顾` 开头）
fn is_pseudo_task(body: &str) -> bool {
    body.starts_with("本轮总结") || body.starts_with("本轮小结") || body.starts_with("本轮回顾")
}

/// 文案 DONE 信号（L0 候选；对齐前端 replyLooksGoalDone，
/// goalModeController.ts:52-56）：`\bDONE\b`（大小写不敏感，ASCII 单词
/// 边界）或「目标已完成」
pub fn reply_looks_goal_done(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.contains("目标已完成") {
        return true;
    }
    let lower = trimmed.to_lowercase();
    let bytes = lower.as_bytes();
    for (index, window) in bytes.windows(4).enumerate() {
        if window == b"done" {
            let prev_ok = index == 0 || !bytes[index - 1].is_ascii_alphanumeric();
            let next_ok = index + 4 >= bytes.len() || !bytes[index + 4].is_ascii_alphanumeric();
            if prev_ok && next_ok {
                return true;
            }
        }
    }
    false
}

/// reason 落库文案（对齐 run.rs:641-646 map_outcome_to_terminal 的
/// end_reason 字面量，保证 goal_state.stopped_reason 与 runs 表口径一致）
fn end_reason_detail(reason: AgentEndReason) -> String {
    match reason {
        AgentEndReason::Stop => "stop",
        AgentEndReason::MaxTurns => "max-turns",
        AgentEndReason::Aborted => "aborted",
        AgentEndReason::Error => "error",
        AgentEndReason::Stopped => "stopped",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 构造进行中的默认 goal 状态（current=0，max=12，stalled 阈值 2）
    fn active_state() -> GoalState {
        GoalState::with_defaults("修复构建", Some(12), Some(2))
    }

    fn stamp(name: &str, keys: &[&str]) -> ToolCallStamp {
        ToolCallStamp {
            tool_name: name.to_string(),
            param_keys: keys.iter().map(|k| k.to_string()).collect(),
        }
    }

    fn round(end_reason: AgentEndReason, text: &str, calls: &[ToolCallStamp]) -> RoundInput {
        RoundInput {
            end_reason,
            assistant_text: text.to_string(),
            tool_calls: calls.to_vec(),
            tool_success_count: 0,
            runtime_error: None,
            current: active_state(),
        }
    }

    // ── U1：goal 未完成 stop 收场 → Continue（allows_auto_continue 生产
    //    调用首例）──────────────────────────────────────────────

    #[test]
    fn u1_incomplete_stop_round_continues() {
        let input = round(
            AgentEndReason::Stop,
            "继续推进，正在处理文件。",
            &[stamp("read_file", &["path"])],
        );
        let assessment = assess_round(&input);
        assert_eq!(assessment.decision, GoalDecision::Continue, "未完成应继续");
        assert!(assessment.should_continue, "stop 收场允许自动续轮（U1）");
        assert_eq!(assessment.stopped_reason.as_deref(), Some(STOP_REASON));
        assert_eq!(assessment.reason_detail, STOP_REASON);
        assert_eq!(assessment.stalled_delta, 0);
    }

    // ── U2：checklist 全勾 stop 收场 → Completed（L1 主门禁）─────

    #[test]
    fn u2_checklist_all_done_completes() {
        let input = round(
            AgentEndReason::Stop,
            "全部完成：\n- [x] 修复构建\n* [X] 补测试",
            &[],
        );
        let assessment = assess_round(&input);
        assert_eq!(assessment.decision, GoalDecision::Completed, "L1 全勾完成");
        assert_eq!(
            assessment.stopped_reason.as_deref(),
            Some(GOAL_COMPLETED_REASON)
        );
        assert_eq!(assessment.reason_detail, GOAL_COMPLETED_REASON);
    }

    // ── U3：无 checklist 文案 DONE → Completed（L0 收口）────────

    #[test]
    fn u3_done_without_checklist_completes() {
        let input = round(AgentEndReason::Stop, "修复完成 DONE", &[]);
        let assessment = assess_round(&input);
        assert_eq!(assessment.decision, GoalDecision::Completed, "L0 文案收口");
        assert_eq!(
            assessment.stopped_reason.as_deref(),
            Some(GOAL_COMPLETED_REASON)
        );
    }

    /// 「目标已完成」中文文案同样触发 L0
    #[test]
    fn u3_goal_done_chinese_phrase_completes() {
        let input = round(AgentEndReason::Stop, "目标已完成", &[]);
        assert_eq!(assess_round(&input).decision, GoalDecision::Completed);
    }

    // ── U4：文案 DONE 但 checklist 未全勾 → 不完成（prematureDoneClaim）
    //    ──────────────────────────────────────────────────────────

    #[test]
    fn u4_done_with_open_tasks_does_not_complete() {
        let input = round(AgentEndReason::Stop, "DONE\n- [x] 任务A\n- [ ] 任务B", &[]);
        let assessment = assess_round(&input);
        assert_ne!(
            assessment.decision,
            GoalDecision::Completed,
            "反假完成：清单未全勾不因文案 DONE 收口"
        );
        // 纯文字轮落入 stalled 检测（§3.3 步骤 5：NoProgress 即 continue
        // 路径，stalled 已递增——与 U6 无工具轮语义一致）
        assert!(
            matches!(
                assessment.decision,
                GoalDecision::Continue | GoalDecision::NoProgress
            ),
            "未完成应走继续推进路径（prematureDoneClaim 对齐）"
        );
    }

    // ── U5：工具批指纹连续相同 → stalled；达 max_stalled → Blocked ──

    #[test]
    fn u5_same_fingerprint_stalls_then_blocks() {
        let calls = [stamp("read_file", &["path"])];
        let sig = tool_batch_fingerprint(&calls).expect("有工具轮必有签名");
        let mut state = active_state();
        state.progress_signature = Some(sig);
        let first = RoundInput {
            current: state.clone(),
            tool_calls: calls.to_vec(),
            ..round(AgentEndReason::Stop, "重试读取", &calls)
        };
        let a1 = assess_round(&first);
        assert_eq!(a1.stalled_delta, 1, "指纹相同计入 stalled");
        assert_eq!(a1.decision, GoalDecision::NoProgress, "未达阈值继续");
        state = state.advance(&first, &a1);
        assert_eq!(state.stalled_rounds, 1);

        let second = RoundInput {
            current: state.clone(),
            tool_calls: calls.to_vec(),
            ..round(AgentEndReason::Stop, "再次重试", &calls)
        };
        let a2 = assess_round(&second);
        assert_eq!(a2.decision, GoalDecision::Blocked, "达阈值停滞阻断");
        assert_eq!(a2.stopped_reason.as_deref(), Some(GOAL_STALLED_REASON));
        assert_eq!(a2.reason_detail, GOAL_STALLED_REASON);
        state = state.advance(&second, &a2);
        assert_eq!(state.stalled_rounds, 2);
        assert!(state.is_terminal(), "goal-stalled 后为终态");
    }

    // ── U6：无工具轮（纯文字总结）→ 签名沿用 → stalled_delta=1 ──

    #[test]
    fn u6_text_only_round_keeps_signature_and_stalls() {
        let mut state = active_state();
        state.progress_signature = Some("tools:fnv1a:7f3a123456789abc".into());
        let input = RoundInput {
            current: state,
            tool_calls: vec![],
            ..round(AgentEndReason::Stop, "总结一下进展", &[])
        };
        let assessment = assess_round(&input);
        assert_eq!(
            assessment.stalled_delta, 1,
            "纯文字轮正确计入 stalled（03 §2D）"
        );
        assert_eq!(
            assessment.next_progress_signature, None,
            "无工具轮不产出新签名，沿用上轮"
        );
    }

    /// 从未有工具轮的第一轮纯文字：None 签名视为相同，同样计入 stalled
    #[test]
    fn u6_first_text_only_round_stalls() {
        let input = round(AgentEndReason::Stop, "先想一下方案", &[]);
        let assessment = assess_round(&input);
        assert_eq!(
            assessment.stalled_delta, 1,
            "无历史签名时纯文字轮计入 stalled"
        );
        assert_eq!(assessment.decision, GoalDecision::NoProgress);
    }

    // ── U7：成功工具结果重置 stalled、签名更新 ──────────────────

    #[test]
    fn u7_successful_tool_resets_stalled_and_updates_signature() {
        let mut state = active_state();
        state.stalled_rounds = 1;
        state.progress_signature = Some("tools:fnv1a:old000000000000".into());
        let calls = [stamp("write_file", &["path", "content"])];
        let input = RoundInput {
            current: state,
            tool_calls: calls.to_vec(),
            tool_success_count: 2,
            ..round(AgentEndReason::Stop, "写入成功", &calls)
        };
        let assessment = assess_round(&input);
        assert_eq!(
            assessment.stalled_delta, 0,
            "成功工具结果重置 stalled（U7）"
        );
        let next_sig = assessment.next_progress_signature.clone().unwrap();
        assert!(next_sig.starts_with("tools:fnv1a:"), "签名更新为工具批指纹");
        assert_ne!(next_sig, "tools:fnv1a:old000000000000");
        assert_eq!(assessment.decision, GoalDecision::Continue);
    }

    // ── U8：max_rounds 耗尽 → Blocked(goal-max-rounds)；后续 NoGoal ──

    #[test]
    fn u8_max_rounds_exhausted_blocks_and_no_goal_after() {
        let mut state = active_state();
        state.current_round = 11;
        let input = RoundInput {
            current: state.clone(),
            ..round(AgentEndReason::Stop, "还没完成", &[])
        };
        let assessment = assess_round(&input);
        assert_eq!(assessment.decision, GoalDecision::Blocked, "轮数耗尽阻断");
        assert_eq!(
            assessment.stopped_reason.as_deref(),
            Some(GOAL_MAX_ROUNDS_REASON)
        );

        let advanced = state.advance(&input, &assessment);
        assert_eq!(advanced.current_round, 12);
        assert!(advanced.is_terminal(), "goal-max-rounds 后为终态");
        assert!(
            !advanced.goal_pending(AgentEndReason::Stop),
            "此后 goal_pending 恒 false（A3）"
        );

        // 后续评估：已终态 → NoGoal，不评估不写、不续
        let after = RoundInput {
            current: advanced,
            ..round(AgentEndReason::Stop, "继续", &[])
        };
        let a2 = assess_round(&after);
        assert_eq!(a2.decision, GoalDecision::NoGoal);
        assert!(!a2.should_continue, "终态后不应继续（U8 后续评估）");
    }

    // ── U9：error 收场 → Blocked；stalled_delta=0、current_round 不递增 ──

    #[test]
    fn u9_error_round_blocks_without_consuming_rounds() {
        let mut state = active_state();
        state.stalled_rounds = 1;
        state.current_round = 2;
        let input = RoundInput {
            current: state.clone(),
            runtime_error: Some("provider 中断".into()),
            ..round(AgentEndReason::Error, "", &[])
        };
        let assessment = assess_round(&input);
        assert_eq!(assessment.decision, GoalDecision::Blocked);
        assert_eq!(assessment.reason_detail, "error");
        assert_eq!(assessment.stalled_delta, 0, "error 轮不计 stalled（U9）");
        assert!(
            !assessment.should_continue,
            "error 不触发 goal_pending（A4）"
        );

        let advanced = state.advance(&input, &assessment);
        assert_eq!(
            advanced.current_round, 2,
            "error 轮不递增 current_round（01 §3 第3条）"
        );
        assert_eq!(advanced.stalled_rounds, 1, "error 轮 stalled 保持");
    }

    // ── U10：max-turns / aborted / stopped 收场 → 不触发 goal_pending ──

    #[test]
    fn u10_non_stop_reasons_never_continue() {
        for reason in [
            AgentEndReason::MaxTurns,
            AgentEndReason::Aborted,
            AgentEndReason::Stopped,
        ] {
            let input = round(reason, "收场", &[]);
            let assessment = assess_round(&input);
            assert_eq!(
                assessment.decision,
                GoalDecision::Blocked,
                "{reason:?} 阻断"
            );
            assert!(
                !assessment.should_continue,
                "{reason:?} 不触发 goal_pending（U10）"
            );
            assert_eq!(assessment.stalled_delta, 0);
            let expected = match reason {
                AgentEndReason::MaxTurns => "max-turns",
                AgentEndReason::Aborted => "aborted",
                AgentEndReason::Stopped => "stopped",
                AgentEndReason::Stop | AgentEndReason::Error => unreachable!(),
            };
            assert_eq!(assessment.reason_detail, expected);
        }
    }

    // ── U11：无 goal_state / 坏 JSON → fail-open 不 panic ─────────

    #[test]
    fn u11_from_json_fail_open() {
        assert_eq!(GoalState::from_json(None), None, "缺键 = 无 goal");
        assert_eq!(
            GoalState::from_json(Some("not json{")),
            None,
            "坏 JSON = 无 goal"
        );
        // 字段级容忍：空对象 → 全默认
        let empty = GoalState::from_json(Some("{}")).expect("空对象应取默认态");
        assert_eq!(empty, GoalState::default());
        assert_eq!(empty.schema_version, GOAL_SCHEMA_VERSION);
    }

    /// 序列化键名断言（snake_case 主体 + schemaVersion/updatedAtMs 驼峰，
    /// §4.1 / 02-定夺 S1）
    #[test]
    fn u11_serialize_shape_snake_case_with_version_fields() {
        let state = GoalState::new("修复构建", 12, 2);
        let value = serde_json::to_value(&state).unwrap();
        assert_eq!(value["goal"], "修复构建");
        assert_eq!(value["max_rounds"], 12);
        assert_eq!(value["max_stalled_rounds"], 2);
        assert_eq!(value["current_round"], 0);
        assert_eq!(value["stalled_rounds"], 0);
        assert!(value.get("progress_signature").is_some());
        assert_eq!(value["schemaVersion"], 1, "schemaVersion 驼峰（S1）");
        assert_eq!(value["updatedAtMs"], 0, "updatedAtMs 驼峰（S1）");
        assert!(value.get("maxRounds").is_none(), "不得序列化为 camelCase");
    }

    /// 序列化 → 解析往返一致
    #[test]
    fn u11_roundtrip_preserves_state() {
        let mut state = active_state();
        state.current_round = 3;
        state.stalled_rounds = 1;
        state.progress_signature = Some("tools:fnv1a:7f3a123456789abc".into());
        state.stopped_reason = Some(STOP_REASON.into());
        state.updated_at_ms = 1_789_000_000_000;
        let restored = GoalState::from_json(Some(&state.to_json())).unwrap();
        assert_eq!(restored, state, "往返无损");
    }

    /// 未知字段忽略 + 缺省字段取默认值（字段级容忍）
    #[test]
    fn u11_unknown_fields_ignored_and_defaults_applied() {
        let raw = json!({
            "goal": "修复构建",
            "futureField": 42,
            "max_rounds": 5,
        });
        let state = GoalState::from_json(Some(&raw.to_string())).unwrap();
        assert_eq!(state.goal, "修复构建");
        assert_eq!(state.max_rounds, 5);
        assert_eq!(
            state.max_stalled_rounds, DEFAULT_GOAL_MAX_STALLED_ROUNDS,
            "缺省字段取默认值"
        );
        assert_eq!(state.current_round, 0);
        assert!(state.progress_signature.is_none());
    }

    // ── U12：L2 退化计数——tool_success_count 进入评估面 ─────────

    #[test]
    fn u12_success_count_reaches_assessment_as_evidence() {
        // 签名相同 + 成功工具结果 → 重置 stalled（计数消费证据）
        let mut state = active_state();
        state.stalled_rounds = 1;
        state.progress_signature = Some("tools:fnv1a:same00000000000".into());
        let calls = [stamp("read_file", &["path"])];
        let input = RoundInput {
            current: state,
            tool_calls: calls.to_vec(),
            tool_success_count: 3,
            ..round(AgentEndReason::Stop, "读取成功", &calls)
        };
        let assessment = assess_round(&input);
        assert_eq!(
            assessment.stalled_delta, 0,
            "成功计数 >0 重置 stalled（L2 证据）"
        );
        // 事件载荷 evidence 数据源：壳层直取 RoundInput.tool_success_count
        assert_eq!(
            input.tool_success_count, 3,
            "壳层可直取计数进 goal-round-completed 载荷"
        );
    }

    // ── 补充：checklist 解析器（L1 基础）────────────────────────

    #[test]
    fn checklist_parser_aligned_with_frontend() {
        let text = "\
- [x] 修复构建
- [ ] 补测试
* [X] 写文档
  * [ ] 缩进项
- [x] 本轮总结
- 普通列表项
1. [x] 有序号不算
- [x]任务无空白分隔不算
";
        let items = parse_checklist(text);
        let texts: Vec<(&str, bool)> = items.iter().map(|i| (i.text.as_str(), i.done)).collect();
        assert_eq!(
            texts,
            vec![
                ("修复构建", true),
                ("补测试", false),
                ("写文档", true),
                ("缩进项", false),
            ],
            "伪任务「本轮总结」丢弃，无空白分隔/有序号行不匹配（前端同构）"
        );
    }

    /// 伪任务三前缀全部丢弃
    #[test]
    fn checklist_pseudo_tasks_dropped() {
        let text = "- [x] 本轮总结\n- [x] 本轮小结\n- [x] 本轮回顾\n- [x] 真实任务";
        let items = parse_checklist(text);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, "真实任务");
    }

    // ── 补充：文案 DONE 检测（L0 基础）──────────────────────────

    #[test]
    fn done_detection_matches_frontend() {
        assert!(reply_looks_goal_done("DONE"));
        assert!(reply_looks_goal_done("done"));
        assert!(reply_looks_goal_done("全部完成 DONE"));
        assert!(reply_looks_goal_done("目标已完成"));
        assert!(reply_looks_goal_done("  完成 DONE  "));
        assert!(!reply_looks_goal_done(""));
        assert!(
            reply_looks_goal_done(r"DONE 未完成"),
            r"DONE 后空格即单词边界（\bDONE\b）"
        );
        assert!(!reply_looks_goal_done("DONEXX")); // \b 边界
        assert!(!reply_looks_goal_done("XDONE")); // \b 边界
        assert!(!reply_looks_goal_done("随便说说"));
    }

    // ── 补充：工具批指纹（§3.4 签名语义）────────────────────────

    #[test]
    fn fingerprint_empty_batch_is_none() {
        assert_eq!(tool_batch_fingerprint(&[]), None, "无工具轮签名不变");
    }

    #[test]
    fn fingerprint_stable_and_param_value_noise_tolerated() {
        let a = [stamp("read_file", &["path"])];
        let b = [stamp("read_file", &["path"])];
        assert_eq!(
            tool_batch_fingerprint(&a),
            tool_batch_fingerprint(&b),
            "同批同签名（确定性）"
        );
        // 参数值噪声容忍（key 集相同，值不同）
        let a = [ToolCallStamp {
            tool_name: "read_file".into(),
            param_keys: vec!["path".into()],
        }];
        let b = [ToolCallStamp {
            tool_name: "read_file".into(),
            param_keys: vec!["path".into()],
        }];
        assert_eq!(tool_batch_fingerprint(&a), tool_batch_fingerprint(&b));
    }

    #[test]
    fn fingerprint_key_order_insensitive_but_call_order_sensitive() {
        let a = [stamp("read_file", &["path", "depth"])];
        let b = [stamp("read_file", &["depth", "path"])];
        assert_eq!(
            tool_batch_fingerprint(&a),
            tool_batch_fingerprint(&b),
            "key 集合排序后拼串，顺序无关"
        );
        let c = [stamp("read_file", &["path"]), stamp("grep", &["pattern"])];
        let d = [stamp("grep", &["pattern"]), stamp("read_file", &["path"])];
        assert_ne!(
            tool_batch_fingerprint(&c),
            tool_batch_fingerprint(&d),
            "工具批顺序敏感（序列整体哈希）"
        );
    }

    #[test]
    fn fingerprint_prefix_shape() {
        let sig = tool_batch_fingerprint(&[stamp("read_file", &["path"])]).unwrap();
        assert!(sig.starts_with("tools:fnv1a:"), "签名带域前缀（§4.1）");
        assert_eq!(sig.len(), "tools:fnv1a:".len() + 16, "十六进制 16 位");
    }

    // ── 补充：advance 纯函数写回 ────────────────────────────────

    #[test]
    fn advance_updates_stopped_reason_and_timestamp() {
        let state = active_state();
        let input = round(AgentEndReason::Stop, "未完成", &[]);
        let assessment = assess_round(&input);
        let advanced = state.advance(&input, &assessment);
        assert_eq!(advanced.current_round, 1, "Stop 轮 current_round + 1");
        assert_eq!(advanced.stopped_reason.as_deref(), Some(STOP_REASON));
        assert!(advanced.updated_at_ms > 0, "写方刷新时间戳");
        assert!(advanced.is_active(), "未完成未阻断仍 Active");
    }

    #[test]
    fn advance_no_goal_returns_unchanged() {
        let mut state = active_state();
        state.stopped_reason = Some(GOAL_COMPLETED_REASON.into());
        let input = RoundInput {
            current: state.clone(),
            ..round(AgentEndReason::Stop, "完成后又一轮", &[])
        };
        let assessment = assess_round(&input);
        assert_eq!(assessment.decision, GoalDecision::NoGoal);
        assert_eq!(
            state.advance(&input, &assessment),
            state,
            "NoGoal 不评估不写"
        );
    }

    // ── 补充：goal_pending 判定（§3.6 第四源语义）────────────────

    #[test]
    fn goal_pending_only_when_active_under_limit_and_stop() {
        let state = active_state();
        assert!(
            state.goal_pending(AgentEndReason::Stop),
            "进行中未达上限 + stop → pending"
        );
        assert!(
            !state.goal_pending(AgentEndReason::Error),
            "error 不续（A4）"
        );
        assert!(
            !state.goal_pending(AgentEndReason::MaxTurns),
            "max-turns 不续"
        );
        assert!(!state.goal_pending(AgentEndReason::Stopped), "stopped 不续");

        let mut at_limit = active_state();
        at_limit.current_round = at_limit.max_rounds;
        assert!(
            !at_limit.goal_pending(AgentEndReason::Stop),
            "达上限后恒 false（A3）"
        );

        let mut terminal = active_state();
        terminal.stopped_reason = Some(GOAL_STALLED_REASON.into());
        assert!(
            !terminal.goal_pending(AgentEndReason::Stop),
            "终态后恒 false"
        );
    }

    // ── 补充：status 推断（§4.1：终态后 status 由 stopped_reason 推断）──

    #[test]
    fn status_inferred_from_stopped_reason() {
        assert_eq!(active_state().status(), GoalStatus::Active);
        let mut done = active_state();
        done.stopped_reason = Some(GOAL_COMPLETED_REASON.into());
        assert_eq!(done.status(), GoalStatus::Completed);
        for reason in [
            GOAL_MAX_ROUNDS_REASON,
            GOAL_STALLED_REASON,
            "error",
            "max-turns",
            "aborted",
            "stopped",
        ] {
            let mut state = active_state();
            state.stopped_reason = Some(reason.into());
            assert_eq!(state.status(), GoalStatus::Blocked, "{reason} 归为 Blocked");
        }
        let mut active = active_state();
        active.stopped_reason = Some(STOP_REASON.into());
        assert_eq!(active.status(), GoalStatus::Active, "stop 为中间态");
    }

    /// 完成优先于轮数上限：最后一轮达成完成信号 → goal-completed 而非
    /// goal-max-rounds（伪代码步骤 3「且未完成」+ 前端 done 先于 max_iter）
    #[test]
    fn completion_wins_over_round_limit_on_last_round() {
        let mut state = active_state();
        state.current_round = 11;
        let input = RoundInput {
            current: state,
            ..round(AgentEndReason::Stop, "- [x] 全部任务完成", &[])
        };
        let assessment = assess_round(&input);
        assert_eq!(
            assessment.decision,
            GoalDecision::Completed,
            "最后一轮完成 → goal-completed（非 goal-max-rounds）"
        );
        assert_eq!(assessment.reason_detail, GOAL_COMPLETED_REASON);
    }

    /// 完成判定不消耗 stalled 语义：完成轮不参与 stalled 检测
    #[test]
    fn completed_round_bypasses_stalled() {
        let mut state = active_state();
        state.stalled_rounds = 1;
        let input = RoundInput {
            current: state,
            tool_calls: vec![stamp("read_file", &["path"])],
            ..round(AgentEndReason::Stop, "- [x] 完成\nDONE", &[])
        };
        let assessment = assess_round(&input);
        assert_eq!(assessment.decision, GoalDecision::Completed);
        assert_eq!(assessment.stalled_delta, 0);
    }
}
