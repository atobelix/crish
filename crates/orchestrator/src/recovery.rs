//! C7 四级恢复阶梯 + 恢复预算制（I6-M9：02 方案 §2 M9 / 04 方案 §2 C7）
//!
//! 子 agent run 遇网络波动按四级阶梯逐级恢复；最终不可恢复留痕并上报
//! 用户；用恢复预算制（操作指纹 + Episode 预算，借鉴 Reasonix Auto Guard，
//! ref-analysis 01 Top 5）防止无限重试/fork。
//!
//! 四级阶梯：
//! - **阶梯 1 自动重试（引擎内）**：[ladder1_decision] 镜像复用
//!   `crates/agent-provider/src/retry.rs` 的分类与退避语义（750ms 起 /
//!   8s 封顶 / 60s 总预算）——orchestrator 不依赖 agent-provider（引
//!   reqwest 拉重依赖，G5 分层），瞬态分类直接用 conex-types 的
//!   [ProviderErrorKind]（retry.rs 同源真源），退避公式逐条镜像并由
//!   测试锁定（与 retry.rs 自身测试同期望值，防漂移）；重试不计入 run
//!   失败；预算内自动，超预算进入阶梯 2；
//! - **阶梯 2 主 agent 激活（软注入）**：[RecoveryCoordinator::escalate]
//!   经 [PendingMessageQueue] 写入 steering 条目（C7 写入侧，group_id
//!   = `recovery-<run_id>` 去重），并把通知**落库**（session_meta
//!   `recover_notifications`，重启后主 agent 仍可见）；主 agent 注入
//!   激活指令由引擎经 L1 steer 环送达（control.rs 归 C8，本模块只写
//!   队列与通知）；
//! - **阶梯 3 重分配/fork**：[RecoveryCoordinator::fork_and_reassign]
//!   基于 [SessionTree::fork]（冻结接口只读消费）+ `subagent_path_json`
//!   记录工作流路径；fork 三态上下文继承（ref-analysis 02 Top 6，
//!   grok verbatim/summarized/New）：同窗口（≤24h）且注入内容 ≤ 会话
//!   窗口 80% → 字节级继承（Verbatim）、超窗或超占比 → 摘要后注入
//!   （Summarized，C9 摘要位，M10 实装前以 context_normalized 记录）、
//!   空内容 → 全新（New）；原 run 置 failed 并留事件；
//! - **阶梯 4 上报用户**：[RecoveryCoordinator::report_to_user] 如实
//!   上报「卡在哪一步、试过什么（各阶梯尝试记录）、建议怎么办」，连同
//!   全部留痕（events 表）交用户决策；run 标记需用户介入（session_meta
//!   `recover_needs_user`，UI 可观察）。
//!
//! 恢复预算制（01 Top 5）：操作指纹（subagent_id + 任务哈希）+
//! Episode 预算（每会话每指纹最多恢复 N 次，默认 3，可配
//! `recover_max_episodes`）——超预算禁止自动恢复（含阶梯 2 通知），
//! 直接阶梯 4；预算计数落 session_meta `recover_episodes`，重启恢复
//! 不重放授权（C3 审批结果不因重启变自动放行）。
//!
//! 三问：
//! - 隔离边界：阶梯 1 只处理瞬态类错误，其余错误不上行；阶梯 3 fork
//!   受并发预算（引擎侧 RecursionGuard）与 Episode 预算双重约束；
//! - 干预入口：L1 注入（阶梯 2 激活）+ L3 强停随时可打断 + 阶梯 4 用户
//!   决策（主 agent 唯一编排者）；
//! - 持久化：steering 条目落队列且通知落库（`recover_notifications`）、
//!   fork 路径落 subagent_path_json 与 `recover_forks`、尝试记录与终态
//!   留痕入 events 表（`recovery-*` 域类型，M7 事件注册表外，M14 事件
//!   源补齐时登记）、预算计数落 `recover_episodes`。
//!
//! 接线契约：引擎侧（apps/agent-workbench）在子 agent run 的 provider
//! 流错误处调用 [RecoveryCoordinator::on_subagent_run_failure]；主 agent
//! 决定重分配时调用 [RecoveryCoordinator::fork_and_reassign]；主 agent
//! 处理完阶梯 2 通知后调用 [RecoveryCoordinator::acknowledge]；重启后
//! 经 [RecoveryCoordinator::restore_steering_notifications] 把未处理
//! 通知重新排入队列。conex-db 只读：session_meta 与事件/run/session_agents
//! 均经既有接口（[RecoveryStore] 抽象，无一行 conex-db 改动）。

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_tools::tools::subagent::{
    SubagentSpawnRequest, SubagentSpawner, SubagentState,
};
use conex_db::{LocalDb, RunStatus};
use conex_types::error::ProviderErrorKind;
use serde::{Deserialize, Serialize};

use crate::session::SessionTree;
use crate::steering_queue::{PendingMessageQueue, SteeringInputEntry};
use crate::now_ms;

// ── 键命名空间（session_meta `recover_*`，04 文档：各能力独占自己声明的
//    键命名空间；本模块独占 `recover_*`）────────────────────────────

/// Episode 预算上限键（每会话每操作指纹最多恢复次数，默认 3）
pub const RECOVER_MAX_EPISODES_KEY: &str = "recover_max_episodes";
/// 预算计数键（JSON 对象：操作指纹 → 已消费恢复次数）
pub const RECOVER_EPISODES_KEY: &str = "recover_episodes";
/// 阶梯 2 通知持久化键（JSON 数组：[RecoveryNotification]，pending 位
/// 由 [RecoveryCoordinator::acknowledge] 落 false）
pub const RECOVER_NOTIFICATIONS_KEY: &str = "recover_notifications";
/// 阶梯 3 fork 记录键（JSON 数组：[ForkRecord]，幂等依据）
pub const RECOVER_FORKS_KEY: &str = "recover_forks";
/// 阶梯 4 需用户介入标记键（JSON 数组：run id 列表，UI 可观察）
pub const RECOVER_NEEDS_USER_KEY: &str = "recover_needs_user";

/// 阶梯 2 steering 条目分组前缀（group_id = `recovery-<run_id>`，
/// replaceOrEnqueue 去重，同 run 重复升级原位替换）
pub const RECOVER_GROUP_PREFIX: &str = "recovery-";

// ── 恢复域事件类型（events 表留痕；M7 事件注册表外，M14 事件源补齐时
//    登记进 conex-types 注册表与 engine-events.json）────────────────

/// 阶梯 1 耗尽 → 阶梯 2 升级留痕
pub const RECOVER_ESCALATED_EVENT: &str = "recovery-escalated";
/// 阶梯 2 steering 通知留痕
pub const RECOVER_STEERING_EVENT: &str = "recovery-steering";
/// 阶梯 3 fork 留痕
pub const RECOVER_FORK_EVENT: &str = "recovery-fork";
/// 阶梯 4 上报用户留痕
pub const RECOVER_REPORT_EVENT: &str = "recovery-report";
/// Episode 预算耗尽拒绝留痕
pub const RECOVER_BUDGET_DENIED_EVENT: &str = "recovery-budget-denied";

// ── 阶梯 1：自动重试（镜像 agent-provider/retry.rs，B2.7）──────────

/// 首次退避基数（镜像 retry.rs RetryPolicy::default，750ms）
pub const RECOVERY_BASE_DELAY_MS: u64 = 750;
/// 单次等待上限（镜像 retry.rs，8s）
pub const RECOVERY_MAX_DELAY_MS: u64 = 8_000;
/// 总重试预算（镜像 retry.rs，60s）
pub const RECOVERY_TOTAL_BUDGET_MS: u64 = 60_000;

/// 重试策略（镜像 `agent-provider::retry::RetryPolicy` 的默认值；
/// orchestrator 不依赖 agent-provider，退避公式与分类语义逐条镜像，
/// 测试锁定与 retry.rs 同期望值防漂移）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecoveryRetryPolicy {
    /// 最大重试次数（0 = 不重试，与 retry.rs 同语义：显式开启才重试）
    pub max_retries: u32,
    /// 首次退避基数（默认 750ms）
    pub base_delay_ms: u64,
    /// 单次等待上限（默认 8s）
    pub max_delay_ms: u64,
    /// 总重试预算（默认 60s，超出即停止）
    pub total_budget_ms: u64,
}

impl Default for RecoveryRetryPolicy {
    fn default() -> Self {
        Self {
            max_retries: 0,
            base_delay_ms: RECOVERY_BASE_DELAY_MS,
            max_delay_ms: RECOVERY_MAX_DELAY_MS,
            total_budget_ms: RECOVERY_TOTAL_BUDGET_MS,
        }
    }
}

/// 瞬态类错误分类（镜像 retry.rs `should_retry` 的可重试集：rate-limit /
/// 5xx / 网络 / 超时；auth、quota、context_length 等不可重试——
/// context_length 由上层压缩处理，00 D5：分类与收口分离）
pub fn is_transient_kind(kind: ProviderErrorKind) -> bool {
    matches!(
        kind,
        ProviderErrorKind::RateLimit
            | ProviderErrorKind::ServerError
            | ProviderErrorKind::Timeout
            | ProviderErrorKind::Network
    )
}

/// 指数退避（镜像 retry.rs `retry_delay_ms`：`min(max_delay, base *
/// 2^(attempt-1))`，指数上限 62 防溢出）
pub fn backoff_delay_ms(policy: &RecoveryRetryPolicy, attempt: u32) -> Duration {
    let base_delay_ms = policy.base_delay_ms.max(1);
    let max_delay_ms = policy.max_delay_ms.max(base_delay_ms);
    let exponent = (attempt.max(1) - 1).min(62);
    let backoff = base_delay_ms.saturating_mul(1u64 << exponent);
    Duration::from_millis(backoff.min(max_delay_ms))
}

/// 阶梯 1 决策
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ladder1Decision {
    /// 预算内自动重试（重试不计入 run 失败；attempt 从 1 起）
    Retry {
        /// 本次重试序号
        attempt: u32,
        /// 重试前等待时长（已钳到单次上限与剩余预算）
        delay: Duration,
        /// 本次等待后的剩余总预算（毫秒）
        remaining_budget_ms: u64,
    },
    /// 超预算 / 不可重试：上行阶梯 2
    Escalate {
        /// 上行原因
        reason: EscalateReason,
    },
}

/// 阶梯 1 上行原因
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EscalateReason {
    /// 非瞬态类错误（auth/quota/context_length 等，不走本阶梯）
    NonTransient,
    /// 流已产出内容后的中途错误（对齐 retry.rs：重试会重复已流出的内容）
    ContentProduced,
    /// 总预算耗尽（elapsed >= total_budget_ms）
    BudgetExhausted,
    /// 达到最大重试次数
    RetriesExhausted,
}

/// 阶梯 1 判定（镜像 retry.rs `should_retry` + `provider_stream` 语义：
/// 已产出内容不重试 → 瞬态分类 → 次数上限 → 总预算 → 退避钳制）
pub fn ladder1_decision(
    kind: ProviderErrorKind,
    retries: u32,
    elapsed_ms: u64,
    produced_content: bool,
    policy: &RecoveryRetryPolicy,
) -> Ladder1Decision {
    // 流已产出内容：中途错误不重试，直接上行阶梯 2（02 §六.7）
    if produced_content {
        return Ladder1Decision::Escalate {
            reason: EscalateReason::ContentProduced,
        };
    }
    // 仅瞬态类可重试
    if !is_transient_kind(kind) {
        return Ladder1Decision::Escalate {
            reason: EscalateReason::NonTransient,
        };
    }
    if retries >= policy.max_retries {
        return Ladder1Decision::Escalate {
            reason: EscalateReason::RetriesExhausted,
        };
    }
    // 预算：elapsed < total_budget 才继续（对齐 withinRetryBudget 的严格小于）
    if elapsed_ms >= policy.total_budget_ms {
        return Ladder1Decision::Escalate {
            reason: EscalateReason::BudgetExhausted,
        };
    }
    let attempt = retries + 1;
    let remaining_budget_ms = policy.total_budget_ms - elapsed_ms;
    let delay = backoff_delay_ms(policy, attempt).min(Duration::from_millis(remaining_budget_ms));
    Ladder1Decision::Retry {
        attempt,
        delay,
        remaining_budget_ms,
    }
}

// ── 恢复预算制（操作指纹 + Episode 预算，01 Top 5）────────────────

/// 操作指纹：subagent_id + 任务文本的 FNV-1a 64 位哈希（十六进制）。
///
/// 语义（对齐 Reasonix Auto Guard）：同一操作（同子代理定义 + 同任务）
/// 共享一个 Episode 预算，重启不重放授权；不同任务不互相消耗。
pub fn fingerprint(subagent_id: &str, task: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in subagent_id.as_bytes().iter().chain(&[0u8]) {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0001_0000_01b3);
    }
    for byte in task.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0001_0000_01b3);
    }
    format!("{hash:016x}")
}

/// 恢复预算（Episode 预算制：每会话每操作指纹最多恢复 N 次，
/// 默认 3，可配 `recover_max_episodes`）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryBudget {
    /// 每指纹恢复上限（阶梯 3 fork 次数）
    limit: u32,
    /// 操作指纹 → 已消费恢复次数
    counts: HashMap<String, u32>,
}

impl RecoveryBudget {
    /// 新建预算（默认上限 [Self::default_limit] = 3）
    pub fn new(limit: u32) -> Self {
        Self {
            limit: limit.max(1),
            counts: HashMap::new(),
        }
    }

    /// 默认 Episode 预算上限
    pub fn default_limit() -> u32 {
        3
    }

    /// 预算上限
    pub fn limit(&self) -> u32 {
        self.limit
    }

    /// 某指纹已消费的恢复次数
    pub fn count(&self, fingerprint: &str) -> u32 {
        self.counts.get(fingerprint).copied().unwrap_or(0)
    }

    /// 该指纹是否仍有自动恢复额度（超预算禁止自动恢复，直接阶梯 4）
    pub fn can_recover(&self, fingerprint: &str) -> bool {
        self.count(fingerprint) < self.limit
    }

    /// 消费一次恢复额度（阶梯 3 fork 前调用）。
    ///
    /// 超预算返回 [RecoveryError::BudgetExceeded]（调用方转阶梯 4）；
    /// 幂等由调用方保证（同指纹同源 run 已 fork 过则不再计数）。
    pub fn record_fork(&mut self, fingerprint: &str) -> Result<u32, RecoveryError> {
        if !self.can_recover(fingerprint) {
            let count = self.count(fingerprint);
            return Err(RecoveryError::BudgetExceeded {
                fingerprint: fingerprint.to_string(),
                count,
                max: self.limit,
            });
        }
        let entry = self.counts.entry(fingerprint.to_string()).or_insert(0);
        *entry += 1;
        Ok(*entry)
    }

    /// 序列化（`recover_episodes` 键落库形态）
    pub fn to_json(&self) -> String {
        serde_json::to_string(&self.counts).unwrap_or_else(|_| "{}".to_string())
    }

    /// 从持久化恢复（宽容解析：缺失 / 坏 JSON → 空预算，fail-open 不 panic）
    pub fn from_json(raw: Option<&str>, limit: u32) -> Self {
        let counts = raw
            .and_then(|raw| serde_json::from_str::<HashMap<String, u32>>(raw).ok())
            .unwrap_or_default();
        Self {
            limit: limit.max(1),
            counts,
        }
    }
}

// ── 阶梯 2：主 agent 激活（steering 落库 + 队列条目）───────────────

/// 阶梯 2 通知（落库 `recover_notifications`；pending 位重启后仍入队）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryNotification {
    /// 子代理 id
    pub subagent_id: String,
    /// 子代理 run id
    pub subagent_run_id: String,
    /// 操作指纹（报表聚合依据）
    pub fingerprint: String,
    /// 阶梯 1 已重试次数
    pub retries: u32,
    /// 剩余状态（上行时的 run 状态摘要）
    pub remaining_status: String,
    /// 是否仍未处理（acknowledge 置 false；重启只重排 pending 条目）
    pub pending: bool,
    /// 创建时间（epoch ms）
    pub created_at_ms: u64,
}

/// 阶梯 2 steering 分组名（`recovery-<run_id>`，replaceOrEnqueue 去重）
pub fn steering_group_id(subagent_run_id: &str) -> String {
    format!("{RECOVER_GROUP_PREFIX}{subagent_run_id}")
}

/// 阶梯 2 steering 条目文案（哪个 run、已重试次数、剩余状态）
pub fn steering_text(notification: &RecoveryNotification) -> String {
    format!(
        "子代理 {}（run {}）停摆：网络类错误重试预算已耗尽（已重试 {} 次，状态 {}）。\
         请注入激活指令处理：继续等待 / 降低要求 / 取消。",
        notification.subagent_id,
        notification.subagent_run_id,
        notification.retries,
        notification.remaining_status
    )
}

/// 构造阶梯 2 steering 条目（is_steering 受保护位 + 分组去重）
pub fn build_steering_entry(notification: &RecoveryNotification) -> SteeringInputEntry {
    SteeringInputEntry {
        id: format!("recovery-{}-{}", notification.subagent_run_id, notification.created_at_ms),
        text: steering_text(notification),
        attachments: Vec::new(),
        enqueued_at: notification.created_at_ms,
        group_id: Some(steering_group_id(&notification.subagent_run_id)),
        is_steering: true,
    }
}

// ── 阶梯 3：重分配 / fork（三态上下文继承，02 Top 6）──────────────

/// fork 上下文同窗口时长（默认 24h）
pub const FORK_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;
/// fork 字节级继承占比守卫（注入内容 ≤ 会话窗口 80%，grok SAFE_FORK_PERCENT）
pub const FORK_VERBATIM_MAX_RATIO: f64 = 0.8;

/// fork 三态上下文继承模式（grok verbatim mirror / summarized / New）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ForkContextMode {
    /// 同窗口且注入内容 ≤ 会话窗口 80%：字节级继承（省 token 且保缓存）
    Verbatim,
    /// 超窗或超占比：经 C9 摘要后注入（context_normalized 记录位，
    /// 摘要实装归 M10，本层记录模式与边界）
    Summarized,
    /// 无注入内容：全新上下文
    New,
}

impl ForkContextMode {
    /// wire 名（snake_case，落 ForkRecord / subagent_path_json 扩展位）
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Verbatim => "verbatim",
            Self::Summarized => "summarized",
            Self::New => "new",
        }
    }
}

/// fork 三态判定（对齐 grok subagent/mod.rs fork 语义）：
/// - 注入内容为空（0 字节）→ [ForkContextMode::New]（全新）；
/// - 会话窗口内（now - started_at ≤ 24h）且注入内容 ≤ 窗口 80% →
///   [ForkContextMode::Verbatim]（字节级继承）；
/// - 超窗或超占比 → [ForkContextMode::Summarized]（摘要后注入）。
pub fn decide_fork_context(
    started_at_ms: i64,
    now_ms: i64,
    inject_bytes: u64,
    window_bytes: u64,
) -> ForkContextMode {
    if inject_bytes == 0 {
        return ForkContextMode::New;
    }
    let in_window = now_ms.saturating_sub(started_at_ms) <= FORK_WINDOW_MS;
    let within_ratio = window_bytes == 0
        || (inject_bytes as f64) <= (window_bytes as f64) * FORK_VERBATIM_MAX_RATIO;
    if in_window && within_ratio {
        ForkContextMode::Verbatim
    } else {
        ForkContextMode::Summarized
    }
}

/// 阶梯 3 fork 记录（落库 `recover_forks`，幂等与报表依据）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkRecord {
    /// 操作指纹
    pub fingerprint: String,
    /// 子代理 id
    pub subagent_id: String,
    /// 原 run id（置 failed 的 run）
    pub from_run_id: String,
    /// 原 run 的会话树叶子 id（fork 起点）
    pub from_leaf_id: String,
    /// 新 run id（fork 分支承接同一目标）
    pub new_run_id: String,
    /// 新 run 的会话树叶子 id
    pub new_leaf_id: String,
    /// fork 三态上下文继承模式
    pub context_mode: ForkContextMode,
    /// 创建时间（epoch ms）
    pub created_at_ms: u64,
}

/// fork 节点载荷（挂到会话树新叶子的 payload）
pub fn fork_node_payload(record: &ForkRecord, task: &str) -> serde_json::Value {
    serde_json::json!({
        "kind": "recovery-fork",
        "fromRunId": record.from_run_id,
        "fromLeafId": record.from_leaf_id,
        "task": task,
        "contextMode": record.context_mode.as_str(),
    })
}

// ── 阶梯 4：上报用户 ───────────────────────────────────────────────

/// 恢复阶梯标识（wire 名：ladder-1..ladder-4）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryLadder {
    /// 阶梯 1：引擎内自动重试
    Ladder1AutoRetry,
    /// 阶梯 2：主 agent 激活（steering 软注入）
    Ladder2MainAgent,
    /// 阶梯 3：重分配 / fork
    Ladder3Fork,
    /// 阶梯 4：上报用户
    Ladder4User,
}

impl RecoveryLadder {
    /// wire 名
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Ladder1AutoRetry => "ladder-1",
            Self::Ladder2MainAgent => "ladder-2",
            Self::Ladder3Fork => "ladder-3",
            Self::Ladder4User => "ladder-4",
        }
    }
}

/// 单次尝试记录（阶梯 4 上报的「试过什么」明细）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttemptRecord {
    /// 所在阶梯
    pub ladder: RecoveryLadder,
    /// 尝试时间（epoch ms）
    pub at_ms: u64,
    /// 结构化详情
    pub detail: String,
}

/// 阶梯 4 用户上报（卡在哪一步、试过什么、建议怎么办）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserReport {
    /// 子代理 id
    pub subagent_id: String,
    /// 当前 run id
    pub subagent_run_id: String,
    /// 停摆时间（epoch ms）
    pub stuck_at_ms: u64,
    /// 各阶梯尝试记录
    pub attempts: Vec<AttemptRecord>,
    /// 建议怎么办（固定指引文案）
    pub suggestion: String,
}

/// 构造阶梯 4 上报（从持久化的阶梯 2 通知与阶梯 3 fork 记录聚合同指纹
/// 尝试明细，附加本次阶梯 1 上行记录）
pub fn build_user_report(
    subagent_id: &str,
    subagent_run_id: &str,
    stuck_at_ms: u64,
    fingerprint: &str,
    notifications: &[RecoveryNotification],
    forks: &[ForkRecord],
    retries: u32,
) -> UserReport {
    let mut attempts = Vec::new();
    for notification in notifications.iter().filter(|n| n.fingerprint == fingerprint) {
        attempts.push(AttemptRecord {
            ladder: RecoveryLadder::Ladder2MainAgent,
            at_ms: notification.created_at_ms,
            detail: format!(
                "已重试 {} 次后通知主 agent 激活（run {}，状态 {}）",
                notification.retries, notification.subagent_run_id, notification.remaining_status
            ),
        });
    }
    for fork in forks.iter().filter(|f| f.fingerprint == fingerprint) {
        attempts.push(AttemptRecord {
            ladder: RecoveryLadder::Ladder3Fork,
            at_ms: fork.created_at_ms,
            detail: format!(
                "fork 重分配：{} → {}（上下文 {} 继承）",
                fork.from_run_id,
                fork.new_run_id,
                fork.context_mode.as_str()
            ),
        });
    }
    attempts.push(AttemptRecord {
        ladder: RecoveryLadder::Ladder1AutoRetry,
        at_ms: stuck_at_ms,
        detail: format!("瞬态错误自动重试 {retries} 次后预算耗尽"),
    });
    let suggestion = format!(
        "子代理 {} 停摆（run {}）：阶梯 1 自动重试与阶梯 2 主 agent 激活均未恢复，\
         阶梯 3 fork 重分配已达上限或仍失败。请检查 provider 网络与配额后人工决策：\
         继续重试 / 降低要求 / 取消该任务。",
        subagent_id, subagent_run_id
    );
    UserReport {
        subagent_id: subagent_id.to_string(),
        subagent_run_id: subagent_run_id.to_string(),
        stuck_at_ms,
        attempts,
        suggestion,
    }
}

// ── 持久化抽象（conex-db 只读，经既有接口）────────────────────────

/// 恢复域持久化抽象（session_meta / events 表 / run 状态 / 子代理路径）。
///
/// 实现方职责：全部经 conex-db 既有接口（get_session_meta / set_session_meta /
/// append_event / reserve_sequence / update_run_status / load_session_agents /
/// save_session_agents），不新增表结构与库方法。
pub trait RecoveryStore: Send + Sync {
    /// 读 session_meta 键（None = 键不存在）
    fn get_meta(&self, key: &str) -> Result<Option<String>, RecoveryError>;
    /// 写 session_meta 键（幂等 upsert）
    fn set_meta(&self, key: &str, value: &str) -> Result<(), RecoveryError>;
    /// events 表留痕（恢复域事件类型，如 recovery-escalated）
    fn append_event(
        &self,
        session_id: &str,
        event_type: &str,
        payload: &str,
    ) -> Result<(), RecoveryError>;
    /// 更新 run 状态（阶梯 3 原 run 置 failed）
    fn update_run_status(
        &self,
        subagent_run_id: &str,
        status: &str,
        end_reason: &str,
    ) -> Result<(), RecoveryError>;
    /// 写入子代理行的工作流路径（subagent_path_json，阶梯 3 fork 路径落库）
    fn set_subagent_path(
        &self,
        session_id: &str,
        subagent_run_id: &str,
        path_json: &str,
    ) -> Result<(), RecoveryError>;
}

impl RecoveryStore for LocalDb {
    fn get_meta(&self, key: &str) -> Result<Option<String>, RecoveryError> {
        self.get_session_meta(key).map_err(|e| RecoveryError::PersistFailed {
            message: e.to_string(),
        })
    }

    fn set_meta(&self, key: &str, value: &str) -> Result<(), RecoveryError> {
        self.set_session_meta(key, value).map_err(|e| RecoveryError::PersistFailed {
            message: e.to_string(),
        })
    }

    fn append_event(
        &self,
        session_id: &str,
        event_type: &str,
        payload: &str,
    ) -> Result<(), RecoveryError> {
        // 会话级原子取号（与事件基座同机制，保序列唯一连续）
        let sequence = self
            .reserve_sequence(session_id)
            .map_err(|e| RecoveryError::PersistFailed {
                message: e.to_string(),
            })?;
        conex_db::LocalDb::append_event(self, session_id, sequence, event_type, payload)
            .map_err(|e| RecoveryError::PersistFailed {
                message: e.to_string(),
            })
    }

    fn update_run_status(
        &self,
        subagent_run_id: &str,
        status: &str,
        end_reason: &str,
    ) -> Result<(), RecoveryError> {
        let run_status = match status {
            "failed" => RunStatus::Failed,
            "completed" => RunStatus::Completed,
            "cancelled" => RunStatus::Cancelled,
            other => {
                return Err(RecoveryError::InvalidState {
                    message: format!("recovery 不支持的 run 终态：{other}"),
                });
            }
        };
        conex_db::LocalDb::update_run_status(
            self,
            subagent_run_id,
            run_status,
            Some(end_reason),
            None,
        )
        .map_err(|e| RecoveryError::PersistFailed {
            message: e.to_string(),
        })
    }

    fn set_subagent_path(
        &self,
        session_id: &str,
        subagent_run_id: &str,
        path_json: &str,
    ) -> Result<(), RecoveryError> {
        let mut agents = self
            .load_session_agents(session_id)
            .map_err(|e| RecoveryError::PersistFailed {
                message: e.to_string(),
            })?;
        let row = agents
            .iter_mut()
            .find(|a| a.subagent_run_id == subagent_run_id)
            .ok_or_else(|| RecoveryError::NotFound {
                message: format!("子代理行不存在：{subagent_run_id}"),
            })?;
        row.subagent_path_json = Some(path_json.to_string());
        self.save_session_agents(session_id, &agents)
            .map_err(|e| RecoveryError::PersistFailed {
                message: e.to_string(),
            })
    }
}

/// 恢复域错误
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecoveryError {
    /// 引用的 run / 叶子不存在
    NotFound {
        /// 详情
        message: String,
    },
    /// session_meta / 事件 / run 落库失败
    PersistFailed {
        /// 详情
        message: String,
    },
    /// 非法状态或参数
    InvalidState {
        /// 详情
        message: String,
    },
    /// Episode 预算耗尽（禁止自动恢复，直接阶梯 4）
    BudgetExceeded {
        /// 操作指纹
        fingerprint: String,
        /// 已消费恢复次数
        count: u32,
        /// 预算上限
        max: u32,
    },
}

impl fmt::Display for RecoveryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound { message } => write!(f, "恢复目标不存在：{message}"),
            Self::PersistFailed { message } => write!(f, "恢复域持久化失败：{message}"),
            Self::InvalidState { message } => write!(f, "恢复域状态非法：{message}"),
            Self::BudgetExceeded {
                fingerprint,
                count,
                max,
            } => write!(
                f,
                "恢复预算耗尽（指纹 {fingerprint}，已 {count} 次 / 上限 {max}）"
            ),
        }
    }
}

impl std::error::Error for RecoveryError {}

// ── 协调器（四级阶梯入口）──────────────────────────────────────────

/// run 失败上下文（引擎侧 provider 流错误处装配）
#[derive(Debug, Clone)]
pub struct RunFailureContext {
    /// 子代理 id
    pub subagent_id: String,
    /// 子代理 run id
    pub subagent_run_id: String,
    /// 任务目标（操作指纹 + fork 同目标承接）
    pub task: String,
    /// provider 错误分类（阶梯 1 判定）
    pub error_kind: ProviderErrorKind,
    /// 阶梯 1 已重试次数
    pub retries: u32,
    /// 阶梯 1 已用预算（毫秒）
    pub retry_elapsed_ms: u64,
    /// 流是否已产出内容（中途错误不重试）
    pub produced_content: bool,
    /// 会话树叶子 id（fork 起点；None = 无叶子，阶梯 3 拒绝）
    pub from_leaf_id: Option<String>,
    /// 子代理创建时间（epoch ms，会话窗口判定）
    pub started_at_ms: i64,
    /// 注入内容字节数（fork 三态判定）
    pub inject_bytes: u64,
    /// 会话窗口字节数（fork 三态判定）
    pub window_bytes: u64,
}

/// 协调器动作
#[derive(Debug, Clone, PartialEq)]
pub enum RecoveryAction {
    /// 阶梯 1：预算内自动重试（重试不计入 run 失败）
    AutoRetry {
        /// 本次重试序号
        attempt: u32,
        /// 重试前等待时长
        delay: Duration,
    },
    /// 阶梯 2：steering 条目已入队且通知已落库
    SteeringQueued {
        /// 通知记录（pending = true）
        notification: RecoveryNotification,
    },
    /// 阶梯 3：fork 已完成（新 run 已 spawn，原 run 置 failed）
    Forked {
        /// fork 记录
        record: ForkRecord,
    },
    /// 阶梯 4：上报用户（run 标记需用户介入）
    NeedsUser {
        /// 上报内容
        report: UserReport,
    },
}

/// 一次恢复处置结果
#[derive(Debug, Clone, PartialEq)]
pub struct RecoveryOutcome {
    /// 落到的阶梯
    pub ladder: RecoveryLadder,
    /// 处置动作
    pub action: RecoveryAction,
}

/// 四级恢复阶梯协调器（C7 主写权：steering_queue 写入侧 + fork 记录逻辑）
pub struct RecoveryCoordinator {
    /// 会话 id
    session_id: String,
    /// 持久化抽象
    store: Arc<dyn RecoveryStore>,
    /// 跨 run steering 队列（阶梯 2 写入侧；引擎侧持有的共享队列）
    queue: Arc<Mutex<PendingMessageQueue>>,
    /// 会话树（阶梯 3 fork；只读消费冻结接口）
    tree: Arc<Mutex<SessionTree>>,
    /// spawn 通道（阶梯 3 fork 新 run 启动）
    spawner: Arc<dyn SubagentSpawner>,
    /// 阶梯 1 重试策略
    policy: RecoveryRetryPolicy,
    /// Episode 预算（`recover_episodes` 落库）
    budget: RecoveryBudget,
    /// 阶梯 3 fork 记录（`recover_forks` 落库，幂等依据）
    forks: Vec<ForkRecord>,
    /// 阶梯 2 通知（`recover_notifications` 落库）
    notifications: Vec<RecoveryNotification>,
    /// 阶梯 4 需用户介入标记（`recover_needs_user` 落库，UI 可观察）
    needs_user: Vec<String>,
}

impl RecoveryCoordinator {
    /// 新建协调器：读可配键（`recover_max_episodes`，默认 3）并恢复
    /// 全部持久化状态（预算 / fork 记录 / 通知 / 需介入标记）——
    /// 重启路径与首建路径同构（预算不重放授权）。
    pub fn new(
        session_id: impl Into<String>,
        store: Arc<dyn RecoveryStore>,
        queue: Arc<Mutex<PendingMessageQueue>>,
        tree: Arc<Mutex<SessionTree>>,
        spawner: Arc<dyn SubagentSpawner>,
        policy: RecoveryRetryPolicy,
    ) -> Result<Self, RecoveryError> {
        let session_id = session_id.into();
        let limit = store
            .get_meta(RECOVER_MAX_EPISODES_KEY)?
            .and_then(|raw| raw.parse::<u32>().ok())
            .unwrap_or_else(RecoveryBudget::default_limit);
        let budget = RecoveryBudget::from_json(store.get_meta(RECOVER_EPISODES_KEY)?.as_deref(), limit);
        let forks = parse_json_list::<ForkRecord>(store.get_meta(RECOVER_FORKS_KEY)?);
        let notifications =
            parse_json_list::<RecoveryNotification>(store.get_meta(RECOVER_NOTIFICATIONS_KEY)?);
        let needs_user = parse_json_list::<String>(store.get_meta(RECOVER_NEEDS_USER_KEY)?);
        Ok(Self {
            session_id,
            store,
            queue,
            tree,
            spawner,
            policy,
            budget,
            forks,
            notifications,
            needs_user,
        })
    }

    /// 会话 id
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// 当前预算快照
    pub fn budget(&self) -> &RecoveryBudget {
        &self.budget
    }

    /// 待处理（pending）通知数
    pub fn pending_notifications(&self) -> usize {
        self.notifications
            .iter()
            .filter(|n| n.pending)
            .count()
    }

    /// 需用户介入的 run id 列表
    pub fn needs_user(&self) -> &[String] {
        &self.needs_user
    }

    /// 该 run 是否已标记需用户介入（阶梯 4，UI 可观察位）
    pub fn run_needs_user(&self, subagent_run_id: &str) -> bool {
        self.needs_user.iter().any(|id| id == subagent_run_id)
    }

    /// 阶梯 1+2 入口：子 agent run 遇网络类错误时调用。
    ///
    /// - 阶梯 1 预算内（瞬态 + 未超时 + 未产出内容）→ [RecoveryAction::AutoRetry]，
    ///   重试不计入 run 失败；
    /// - 上行（非瞬态 / 已产出内容 / 预算或次数耗尽）且该指纹仍有预算 →
    ///   阶梯 2：steering 条目入队（同 run 分组去重）+ 通知落库 + 事件留痕；
    /// - 上行且该指纹 Episode 预算已耗尽 → 禁止自动恢复（含阶梯 2 通知），
    ///   直接阶梯 4 上报用户。
    pub async fn on_subagent_run_failure(
        &mut self,
        ctx: &RunFailureContext,
    ) -> Result<RecoveryOutcome, RecoveryError> {
        // 阶梯 1：预算内自动重试
        match ladder1_decision(
            ctx.error_kind,
            ctx.retries,
            ctx.retry_elapsed_ms,
            ctx.produced_content,
            &self.policy,
        ) {
            Ladder1Decision::Retry {
                attempt,
                delay,
                ..
            } => {
                return Ok(RecoveryOutcome {
                    ladder: RecoveryLadder::Ladder1AutoRetry,
                    action: RecoveryAction::AutoRetry { attempt, delay },
                });
            }
            Ladder1Decision::Escalate { reason } => {
                // 升级留痕（阶梯 1 → 阶梯 2 的边界证据）
                self.store.append_event(
                    &self.session_id,
                    RECOVER_ESCALATED_EVENT,
                    &serde_json::to_string(&serde_json::json!({
                        "subagentRunId": ctx.subagent_run_id,
                        "kind": format!("{reason:?}"),
                        "retries": ctx.retries,
                        "elapsedMs": ctx.retry_elapsed_ms,
                    }))
                    .map_err(|e| RecoveryError::InvalidState {
                        message: format!("升级事件序列化失败：{e}"),
                    })?,
                )?;
            }
        }
        // 预算制：上行前检查该指纹 Episode 预算——超预算禁止自动恢复
        // （含阶梯 2 通知），直接阶梯 4（01 Top 5）
        let fp = fingerprint(&ctx.subagent_id, &ctx.task);
        if !self.budget.can_recover(&fp) {
            self.store.append_event(
                &self.session_id,
                RECOVER_BUDGET_DENIED_EVENT,
                &serde_json::to_string(&serde_json::json!({
                    "subagentRunId": ctx.subagent_run_id,
                    "fingerprint": fp,
                    "count": self.budget.count(&fp),
                    "max": self.budget.limit(),
                }))
                .map_err(|e| RecoveryError::InvalidState {
                    message: format!("预算拒绝事件序列化失败：{e}"),
                })?,
            )?;
            return self.report_to_user(ctx);
        }
        // 阶梯 2：steering 条目 + 通知落库
        self.escalate(ctx, fp)
    }

    /// 阶梯 2：写 steering 条目（C7 写入侧，同 run 分组原位替换）并落库
    /// 通知（pending = true，重启后仍入队）。
    fn escalate(
        &mut self,
        ctx: &RunFailureContext,
        fp: String,
    ) -> Result<RecoveryOutcome, RecoveryError> {
        let notification = RecoveryNotification {
            subagent_id: ctx.subagent_id.clone(),
            subagent_run_id: ctx.subagent_run_id.clone(),
            fingerprint: fp,
            retries: ctx.retries,
            remaining_status: "running".to_string(),
            pending: true,
            created_at_ms: now_ms() as u64,
        };
        // 队列写入（同分组 replaceOrEnqueue：同 run 重复升级原位替换）
        {
            let mut queue = self.queue.lock().map_err(|e| RecoveryError::InvalidState {
                message: format!("steering 队列锁中毒：{e}"),
            })?;
            queue.replace_or_enqueue(build_steering_entry(&notification));
        }
        // 通知落库（幂等：同 run 替换旧记录）
        self.notifications.retain(|n| n.subagent_run_id != notification.subagent_run_id);
        self.notifications.push(notification.clone());
        self.persist_notifications()?;
        // 事件留痕
        self.store.append_event(
            &self.session_id,
            RECOVER_STEERING_EVENT,
            &serde_json::to_string(&notification).map_err(|e| {
                RecoveryError::InvalidState {
                    message: format!("steering 事件序列化失败：{e}"),
                }
            })?,
        )?;
        Ok(RecoveryOutcome {
            ladder: RecoveryLadder::Ladder2MainAgent,
            action: RecoveryAction::SteeringQueued { notification },
        })
    }

    /// 阶梯 3：主 agent 决定不等待时的重分配 / fork（04 C7 行为 3）。
    ///
    /// - 幂等：同指纹同源 run 已 fork → 返回既有记录（不重复 spawn）；
    /// - Episode 预算耗尽 → 转阶梯 4（[RecoveryError::BudgetExceeded] 不
    ///   上行，内部直接上报用户）；
    /// - 基于 [SessionTree::fork] 派生新叶子，[read_branch_path] 产出
    ///   工作流路径落 subagent_path_json；新 run 经 spawner 启动承接
    ///   同一目标；原 run 置 failed 并留事件。
    pub async fn fork_and_reassign(
        &mut self,
        ctx: &RunFailureContext,
    ) -> Result<RecoveryOutcome, RecoveryError> {
        let fp = fingerprint(&ctx.subagent_id, &ctx.task);
        // 幂等：同指纹同源 run 已 fork 过 → 直接返回既有记录
        if let Some(existing) = self
            .forks
            .iter()
            .find(|f| f.fingerprint == fp && f.from_run_id == ctx.subagent_run_id)
        {
            return Ok(RecoveryOutcome {
                ladder: RecoveryLadder::Ladder3Fork,
                action: RecoveryAction::Forked {
                    record: existing.clone(),
                },
            });
        }
        // 预算制：超预算禁止自动恢复，直接阶梯 4
        if !self.budget.can_recover(&fp) {
            self.store.append_event(
                &self.session_id,
                RECOVER_BUDGET_DENIED_EVENT,
                &serde_json::to_string(&serde_json::json!({
                    "subagentRunId": ctx.subagent_run_id,
                    "fingerprint": fp,
                    "count": self.budget.count(&fp),
                    "max": self.budget.limit(),
                }))
                .map_err(|e| RecoveryError::InvalidState {
                    message: format!("预算拒绝事件序列化失败：{e}"),
                })?,
            )?;
            return self.report_to_user(ctx);
        }
        let from_leaf_id = ctx.from_leaf_id.clone().ok_or_else(|| {
            RecoveryError::InvalidState {
                message: "fork 需要源叶子节点（from_leaf_id 为空）".to_string(),
            }
        })?;
        // 会话树 fork（冻结接口只读消费）：派生新叶子承接同一目标
        let new_leaf_id = format!("recovery-fork-{}-{}", ctx.subagent_run_id, self.forks.len());
        let context_mode = decide_fork_context(
            ctx.started_at_ms,
            now_ms(),
            ctx.inject_bytes,
            ctx.window_bytes,
        );
        let record = ForkRecord {
            fingerprint: fp,
            subagent_id: ctx.subagent_id.clone(),
            from_run_id: ctx.subagent_run_id.clone(),
            from_leaf_id: from_leaf_id.clone(),
            new_run_id: String::new(),
            new_leaf_id: new_leaf_id.clone(),
            context_mode,
            created_at_ms: now_ms() as u64,
        };
        let payload = fork_node_payload(&record, &ctx.task);
        {
            let mut tree = self.tree.lock().map_err(|e| RecoveryError::InvalidState {
                message: format!("会话树锁中毒：{e}"),
            })?;
            tree.fork(&from_leaf_id, &new_leaf_id, payload)
                .map_err(|e| RecoveryError::InvalidState {
                    message: format!("会话树 fork 失败：{e}"),
                })?;
        }
        // 工作流路径（根 → 新叶子）落 subagent_path_json
        let path_json = {
            let tree = self.tree.lock().map_err(|e| RecoveryError::InvalidState {
                message: format!("会话树锁中毒：{e}"),
            })?;
            let path = tree
                .read_branch_path(Some(&new_leaf_id))
                .map_err(|e| RecoveryError::InvalidState {
                    message: format!("工作流路径读取失败：{e}"),
                })?;
            serde_json::to_string(&path.iter().map(|e| e.id.clone()).collect::<Vec<_>>())
                .map_err(|e| RecoveryError::InvalidState {
                    message: format!("工作流路径序列化失败：{e}"),
                })?
        };
        // 新 run 启动（spawner 契约：守卫校验 + 落库 + 独立 run，引擎侧实现）
        let request = SubagentSpawnRequest {
            agent_id: None,
            prompt: ctx.task.clone(),
            role: None,
            capability_mode: None,
            allowed_tools: None,
            timeout_ms: None,
            description: Some("恢复 fork（C7 阶梯 3，承接同一目标）".to_string()),
            mode: None,
            parent_session_id: self.session_id.clone(),
            parent_run_id: None,
            parent_tool_call_id: None,
            flow_node_id: None,
            is_composite: false,
        };
        let spawned = self
            .spawner
            .spawn(&request)
            .await
            .map_err(|e| RecoveryError::PersistFailed {
                message: format!("fork 新 run 启动失败：{}", e.message()),
            })?;
        if spawned.status != SubagentState::Running {
            return Err(RecoveryError::InvalidState {
                message: format!("fork 新 run 状态异常：{:?}", spawned.status),
            });
        }
        let record = ForkRecord {
            new_run_id: spawned.subagent_run_id.clone(),
            ..record
        };
        // 新 run 行落工作流路径（subagent_path_json）
        self.store.set_subagent_path(&self.session_id, &spawned.subagent_run_id, &path_json)?;
        // 原 run 置 failed 并留痕（C7 行为 3：原 run 状态置 failed）
        self.store
            .update_run_status(&ctx.subagent_run_id, "failed", "recovery-fork")?;
        // 预算消费 + 记录落库 + 事件留痕
        self.budget.record_fork(&record.fingerprint)?;
        self.forks.push(record.clone());
        self.persist_forks()?;
        self.persist_budget()?;
        self.store.append_event(
            &self.session_id,
            RECOVER_FORK_EVENT,
            &serde_json::to_string(&record).map_err(|e| RecoveryError::InvalidState {
                message: format!("fork 事件序列化失败：{e}"),
            })?,
        )?;
        Ok(RecoveryOutcome {
            ladder: RecoveryLadder::Ladder3Fork,
            action: RecoveryAction::Forked { record },
        })
    }

    /// 阶梯 4：全部失败后如实上报用户（04 C7 行为 4 / 05 手册第 5 节
    /// 第 4 级语义）。
    ///
    /// run 标记需用户介入（`recover_needs_user`，UI 可观察）+ 上报事件
    /// 留痕（report 含各阶梯尝试记录与建议）。
    pub fn report_to_user(
        &mut self,
        ctx: &RunFailureContext,
    ) -> Result<RecoveryOutcome, RecoveryError> {
        let fp = fingerprint(&ctx.subagent_id, &ctx.task);
        let report = build_user_report(
            &ctx.subagent_id,
            &ctx.subagent_run_id,
            now_ms() as u64,
            &fp,
            &self.notifications,
            &self.forks,
            ctx.retries,
        );
        if !self.needs_user.iter().any(|id| id == &ctx.subagent_run_id) {
            self.needs_user.push(ctx.subagent_run_id.clone());
            self.persist_needs_user()?;
        }
        self.store.append_event(
            &self.session_id,
            RECOVER_REPORT_EVENT,
            &serde_json::to_string(&report).map_err(|e| RecoveryError::InvalidState {
                message: format!("上报事件序列化失败：{e}"),
            })?,
        )?;
        Ok(RecoveryOutcome {
            ladder: RecoveryLadder::Ladder4User,
            action: RecoveryAction::NeedsUser { report },
        })
    }

    /// 阶梯 2 确认：主 agent 已注入激活指令处理该 run——通知置
    /// pending = false（幂等），重启后不再重排入队。
    pub fn acknowledge(&mut self, subagent_run_id: &str) -> Result<bool, RecoveryError> {
        let mut changed = false;
        for notification in &mut self.notifications {
            if notification.subagent_run_id == subagent_run_id && notification.pending {
                notification.pending = false;
                changed = true;
            }
        }
        if changed {
            self.persist_notifications()?;
        }
        Ok(changed)
    }

    /// 重启恢复：把持久化的 pending 通知重新排入 steering 队列
    /// （04 C7 验收 5：重启后未处理的阶梯 2 通知仍在队列）。
    ///
    /// 返回重排条数；同 run 已消费（pending = false）不重排。
    pub fn restore_steering_notifications(
        &mut self,
    ) -> Result<usize, RecoveryError> {
        let mut count = 0;
        {
            let mut queue = self.queue.lock().map_err(|e| RecoveryError::InvalidState {
                message: format!("steering 队列锁中毒：{e}"),
            })?;
            for notification in self.notifications.iter().filter(|n| n.pending) {
                let entry = build_steering_entry(notification);
                let replaced = queue.replace_or_enqueue(entry);
                if !replaced {
                    count += 1;
                }
            }
        }
        Ok(count)
    }

    /// 持久化通知列表
    fn persist_notifications(&self) -> Result<(), RecoveryError> {
        let raw = serde_json::to_string(&self.notifications).map_err(|e| {
            RecoveryError::InvalidState {
                message: format!("通知列表序列化失败：{e}"),
            }
        })?;
        self.store.set_meta(RECOVER_NOTIFICATIONS_KEY, &raw)
    }

    /// 持久化 fork 记录列表
    fn persist_forks(&self) -> Result<(), RecoveryError> {
        let raw = serde_json::to_string(&self.forks).map_err(|e| {
            RecoveryError::InvalidState {
                message: format!("fork 记录列表序列化失败：{e}"),
            }
        })?;
        self.store.set_meta(RECOVER_FORKS_KEY, &raw)
    }

    /// 持久化预算计数
    fn persist_budget(&self) -> Result<(), RecoveryError> {
        self.store.set_meta(RECOVER_EPISODES_KEY, &self.budget.to_json())
    }

    /// 持久化需介入标记列表
    fn persist_needs_user(&self) -> Result<(), RecoveryError> {
        let raw = serde_json::to_string(&self.needs_user).map_err(|e| {
            RecoveryError::InvalidState {
                message: format!("需介入列表序列化失败：{e}"),
            }
        })?;
        self.store.set_meta(RECOVER_NEEDS_USER_KEY, &raw)
    }
}

/// 宽容解析持久化 JSON 列表（缺失 / 坏 JSON → 空，fail-open 不 panic）
fn parse_json_list<T: serde::de::DeserializeOwned>(
    raw: Option<String>,
) -> Vec<T> {
    raw.and_then(|raw| serde_json::from_str::<Vec<T>>(&raw).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex as StdMutex;
    use std::time::Duration;

    use agent_tools::tools::subagent::{
        RecursionGuardRejection, SubagentSpawnError, SubagentSpawnResult,
    };
    use async_trait::async_trait;
    use serde_json::json;

    // ── 测试替身 ──────────────────────────────────────────────────

    /// 内存持久化实现（RecoveryStore 契约；run 状态与子代理路径记账）
    #[derive(Debug, Default)]
    struct InMemoryRecoveryStore {
        meta: StdMutex<HashMap<String, String>>,
        events: StdMutex<Vec<(String, String, String)>>,
        run_status: StdMutex<HashMap<String, (String, String)>>,
        paths: StdMutex<HashMap<String, String>>,
    }

    impl InMemoryRecoveryStore {
        fn new() -> Arc<Self> {
            Arc::new(Self::default())
        }

        fn events(&self) -> Vec<(String, String, String)> {
            self.events.lock().unwrap().clone()
        }

        fn run_status(&self, run_id: &str) -> Option<(String, String)> {
            self.run_status.lock().unwrap().get(run_id).cloned()
        }

        fn path(&self, run_id: &str) -> Option<String> {
            self.paths.lock().unwrap().get(run_id).cloned()
        }
    }

    impl RecoveryStore for InMemoryRecoveryStore {
        fn get_meta(&self, key: &str) -> Result<Option<String>, RecoveryError> {
            Ok(self.meta.lock().unwrap().get(key).cloned())
        }

        fn set_meta(&self, key: &str, value: &str) -> Result<(), RecoveryError> {
            self.meta
                .lock()
                .unwrap()
                .insert(key.to_string(), value.to_string());
            Ok(())
        }

        fn append_event(
            &self,
            session_id: &str,
            event_type: &str,
            payload: &str,
        ) -> Result<(), RecoveryError> {
            self.events.lock().unwrap().push((
                session_id.to_string(),
                event_type.to_string(),
                payload.to_string(),
            ));
            Ok(())
        }

        fn update_run_status(
            &self,
            subagent_run_id: &str,
            status: &str,
            end_reason: &str,
        ) -> Result<(), RecoveryError> {
            self.run_status.lock().unwrap().insert(
                subagent_run_id.to_string(),
                (status.to_string(), end_reason.to_string()),
            );
            Ok(())
        }

        fn set_subagent_path(
            &self,
            _session_id: &str,
            subagent_run_id: &str,
            path_json: &str,
        ) -> Result<(), RecoveryError> {
            self.paths
                .lock()
                .unwrap()
                .insert(subagent_run_id.to_string(), path_json.to_string());
            Ok(())
        }
    }

    /// 记录式 spawner：记录请求、自增 run id、可注入守卫拒绝
    #[derive(Debug)]
    struct RecordingSpawner {
        requests: StdMutex<Vec<SubagentSpawnRequest>>,
        seq: std::sync::atomic::AtomicUsize,
        reject: bool,
    }

    impl RecordingSpawner {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                requests: StdMutex::new(Vec::new()),
                seq: std::sync::atomic::AtomicUsize::new(0),
                reject: false,
            })
        }

        fn rejecting() -> Arc<Self> {
            Arc::new(Self {
                requests: StdMutex::new(Vec::new()),
                seq: std::sync::atomic::AtomicUsize::new(0),
                reject: true,
            })
        }

        fn requests(&self) -> Vec<SubagentSpawnRequest> {
            self.requests.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl SubagentSpawner for RecordingSpawner {
        async fn spawn(
            &self,
            req: &SubagentSpawnRequest,
        ) -> Result<SubagentSpawnResult, SubagentSpawnError> {
            self.requests.lock().unwrap().push(req.clone());
            if self.reject {
                return Err(SubagentSpawnError::GuardRejected(
                    RecursionGuardRejection::ConcurrentExceeded {
                        current: 7,
                        max: 6,
                    },
                ));
            }
            let n = self.seq.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(SubagentSpawnResult {
                subagent_id: format!("sub-{n}"),
                subagent_run_id: format!("fork-run-{n}"),
                session_id: format!("sess-{n}"),
                status: SubagentState::Running,
                summary: None,
                flow_node_id: None,
            })
        }
    }

    /// 测试环境（队列 + 会话树 + 协调器）
    struct Env {
        store: Arc<InMemoryRecoveryStore>,
        queue: Arc<Mutex<PendingMessageQueue>>,
        tree: Arc<Mutex<SessionTree>>,
        spawner: Arc<RecordingSpawner>,
    }

    fn env() -> (Env, RecoveryCoordinator) {
        let store = InMemoryRecoveryStore::new();
        let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        let tree = Arc::new(Mutex::new(SessionTree::new("s1")));
        tree.lock()
            .unwrap()
            .append("leaf-a", json!({ "text": "root" }))
            .unwrap();
        let spawner = RecordingSpawner::new();
        let coordinator = RecoveryCoordinator::new(
            "s1",
            store.clone(),
            queue.clone(),
            tree.clone(),
            spawner.clone(),
            RecoveryRetryPolicy {
                max_retries: 5,
                ..RecoveryRetryPolicy::default()
            },
        )
        .unwrap();
        (Env { store, queue, tree, spawner }, coordinator)
    }

    fn ctx(
        run_id: &str,
        kind: ProviderErrorKind,
        retries: u32,
        elapsed_ms: u64,
    ) -> RunFailureContext {
        RunFailureContext {
            subagent_id: "sub-1".to_string(),
            subagent_run_id: run_id.to_string(),
            task: "完成模块 A".to_string(),
            error_kind: kind,
            retries,
            retry_elapsed_ms: elapsed_ms,
            produced_content: false,
            from_leaf_id: Some("leaf-a".to_string()),
            // 创建时间 = 当前时刻前 1 秒（同窗口语义；注入 100B ≤ 窗口 10KB 的 80%）
            started_at_ms: now_ms() - 1_000,
            inject_bytes: 100,
            window_bytes: 10_000,
        }
    }

    // ── 阶梯 1 决策表 ─────────────────────────────────────────────

    /// 决策表：仅瞬态类（rate-limit/5xx/网络/超时）可重试；auth/quota/
    /// context_length 等上行（镜像 retry.rs 决策表）
    #[test]
    fn ladder1_decision_table_mirrors_retry_rs() {
        let policy = RecoveryRetryPolicy {
            max_retries: 3,
            ..RecoveryRetryPolicy::default()
        };
        let cases: &[(ProviderErrorKind, bool)] = &[
            (ProviderErrorKind::RateLimit, true),
            (ProviderErrorKind::ServerError, true),
            (ProviderErrorKind::Timeout, true),
            (ProviderErrorKind::Network, true),
            (ProviderErrorKind::Auth, false),
            (ProviderErrorKind::Quota, false),
            (ProviderErrorKind::ContextLengthExceeded, false),
            (ProviderErrorKind::InvalidRequest, false),
            (ProviderErrorKind::PayloadTooLarge, false),
            (ProviderErrorKind::GatewayChallenge, false),
            (ProviderErrorKind::EndpointUnavailable, false),
            (ProviderErrorKind::Aborted, false),
            (ProviderErrorKind::Unknown, false),
        ];
        for (kind, retryable) in cases {
            let decision = ladder1_decision(*kind, 0, 0, false, &policy);
            match decision {
                Ladder1Decision::Retry { .. } => {
                    assert!(*retryable, "{kind:?} 应不可重试");
                }
                Ladder1Decision::Escalate { reason } => {
                    assert!(!*retryable, "{kind:?} 应可重试");
                    assert_eq!(reason, EscalateReason::NonTransient);
                }
            }
        }
    }

    /// 退避序列：750 → 1500 → 3000 → 6000 → 8000（8s 封顶，镜像 retry.rs）
    #[test]
    fn backoff_sequence_exponential_then_capped() {
        let policy = RecoveryRetryPolicy {
            max_retries: 6,
            ..RecoveryRetryPolicy::default()
        };
        let expected = [750u64, 1500, 3000, 6000, 8000, 8000];
        for (index, expected_ms) in expected.iter().enumerate() {
            let attempt = index as u32 + 1;
            assert_eq!(
                backoff_delay_ms(&policy, attempt),
                Duration::from_millis(*expected_ms),
                "attempt {attempt}"
            );
        }
    }

    /// 总预算耗尽后不再重试（elapsed >= total_budget 即上行）
    #[test]
    fn ladder1_budget_exhaustion_escalates() {
        let policy = RecoveryRetryPolicy {
            max_retries: 10,
            total_budget_ms: 10_000,
            ..RecoveryRetryPolicy::default()
        };
        // t=0：预算充足 → 退避 750ms
        match ladder1_decision(ProviderErrorKind::ServerError, 0, 0, false, &policy) {
            Ladder1Decision::Retry { attempt, delay, .. } => {
                assert_eq!(attempt, 1);
                assert_eq!(delay, Duration::from_millis(750));
            }
            other => panic!("预算内应可重试：{other:?}"),
        }
        // t=9.5s：剩余 500ms，等待被钳到剩余预算
        match ladder1_decision(ProviderErrorKind::ServerError, 0, 9_500, false, &policy) {
            Ladder1Decision::Retry { delay, .. } => {
                assert_eq!(delay, Duration::from_millis(500));
            }
            other => panic!("预算内应可重试：{other:?}"),
        }
        // t=10s：预算耗尽 → 上行阶梯 2
        match ladder1_decision(ProviderErrorKind::ServerError, 0, 10_000, false, &policy) {
            Ladder1Decision::Escalate { reason } => {
                assert_eq!(reason, EscalateReason::BudgetExhausted);
            }
            other => panic!("预算耗尽应上行：{other:?}"),
        }
    }

    /// 流已产出内容：中途错误不重试，直接上行（02 §六.7）
    #[test]
    fn ladder1_produced_content_escalates() {
        let policy = RecoveryRetryPolicy {
            max_retries: 3,
            ..RecoveryRetryPolicy::default()
        };
        let decision = ladder1_decision(ProviderErrorKind::Network, 0, 0, true, &policy);
        assert_eq!(
            decision,
            Ladder1Decision::Escalate {
                reason: EscalateReason::ContentProduced
            }
        );
    }

    /// 达到 max_retries 后上行（对齐 maxAttempts 语义）
    #[test]
    fn ladder1_max_retries_escalates() {
        let policy = RecoveryRetryPolicy {
            max_retries: 2,
            ..RecoveryRetryPolicy::default()
        };
        assert!(matches!(
            ladder1_decision(ProviderErrorKind::ServerError, 1, 0, false, &policy),
            Ladder1Decision::Retry { attempt: 2, .. }
        ));
        match ladder1_decision(ProviderErrorKind::ServerError, 2, 0, false, &policy) {
            Ladder1Decision::Escalate { reason } => {
                assert_eq!(reason, EscalateReason::RetriesExhausted);
            }
            other => panic!("次数耗尽应上行：{other:?}"),
        }
        // max_retries=0（默认）：不重试（显式开启才重试）
        let default_policy = RecoveryRetryPolicy::default();
        assert!(matches!(
            ladder1_decision(ProviderErrorKind::ServerError, 0, 0, false, &default_policy),
            Ladder1Decision::Escalate { .. }
        ));
    }

    // ── 预算制（指纹 + Episode）───────────────────────────────────

    /// 指纹稳定性：同 (subagent_id, task) 恒同指纹；不同任务不同指纹
    #[test]
    fn fingerprint_stable_and_unique() {
        let a1 = fingerprint("sub-1", "完成模块 A");
        let a2 = fingerprint("sub-1", "完成模块 A");
        let b = fingerprint("sub-1", "完成模块 B");
        let c = fingerprint("sub-2", "完成模块 A");
        assert_eq!(a1, a2, "同操作指纹必须稳定");
        assert_ne!(a1, b, "不同任务指纹必须不同");
        assert_ne!(a1, c, "不同子代理指纹必须不同");
        assert_eq!(a1.len(), 16, "FNV-1a 64 位十六进制");
    }

    /// Episode 预算：默认 3 次；超限拒绝并报 BudgetExceeded
    #[test]
    fn budget_episode_limit_and_exhaustion() {
        let mut budget = RecoveryBudget::new(3);
        let fp = fingerprint("sub-1", "任务");
        assert!(budget.can_recover(&fp));
        for expected in 1..=3 {
            assert_eq!(budget.record_fork(&fp).unwrap(), expected);
        }
        assert!(!budget.can_recover(&fp), "第 4 次应超限");
        let err = budget.record_fork(&fp).unwrap_err();
        match err {
            RecoveryError::BudgetExceeded {
                fingerprint,
                count,
                max,
            } => {
                assert_eq!(fingerprint, fp);
                assert_eq!(count, 3);
                assert_eq!(max, 3);
            }
            other => panic!("期望 BudgetExceeded：{other:?}"),
        }
    }

    /// 预算持久化：to_json / from_json 往返；坏 JSON 宽容为空
    #[test]
    fn budget_json_roundtrip_and_lenient_parse() {
        let mut budget = RecoveryBudget::new(3);
        budget.record_fork("fp-1").unwrap();
        budget.record_fork("fp-1").unwrap();
        budget.record_fork("fp-2").unwrap();
        let restored = RecoveryBudget::from_json(Some(&budget.to_json()), 3);
        assert_eq!(restored.count("fp-1"), 2);
        assert_eq!(restored.count("fp-2"), 1);
        assert_eq!(restored.count("fp-3"), 0);
        assert!(restored.can_recover("fp-1"), "2 < 3 仍有额度");
        // 坏 JSON → 空预算（fail-open 不 panic）
        let lenient = RecoveryBudget::from_json(Some("not-json"), 3);
        assert_eq!(lenient.count("fp-1"), 0);
        let missing = RecoveryBudget::from_json(None, 3);
        assert_eq!(missing.count("fp-1"), 0);
    }

    // ── fork 三态上下文继承 ───────────────────────────────────────

    /// 三态判定：空内容全新 / 同窗 ≤80% 字节级 / 超窗或超占比摘要
    #[test]
    fn fork_context_three_states() {
        let now = 1_700_000_100_000i64;
        // 空注入内容 → New
        assert_eq!(
            decide_fork_context(now - 1_000, now, 0, 10_000),
            ForkContextMode::New
        );
        // 同窗口且 ≤ 80% → Verbatim
        assert_eq!(
            decide_fork_context(now - 1_000, now, 5_000, 10_000),
            ForkContextMode::Verbatim
        );
        // 恰好 80% → Verbatim（边界含等号）
        assert_eq!(
            decide_fork_context(now - 1_000, now, 8_000, 10_000),
            ForkContextMode::Verbatim
        );
        // 超过 80% → Summarized
        assert_eq!(
            decide_fork_context(now - 1_000, now, 8_001, 10_000),
            ForkContextMode::Summarized
        );
        // 超窗（>24h）即使占比小也 → Summarized
        assert_eq!(
            decide_fork_context(now - FORK_WINDOW_MS - 1, now, 100, 10_000),
            ForkContextMode::Summarized
        );
        // 恰好 24h 窗内 → Verbatim（边界含等号）
        assert_eq!(
            decide_fork_context(now - FORK_WINDOW_MS, now, 100, 10_000),
            ForkContextMode::Verbatim
        );
    }

    /// 三态 wire 名
    #[test]
    fn fork_context_wire_names() {
        assert_eq!(ForkContextMode::Verbatim.as_str(), "verbatim");
        assert_eq!(ForkContextMode::Summarized.as_str(), "summarized");
        assert_eq!(ForkContextMode::New.as_str(), "new");
        assert_eq!(RecoveryLadder::Ladder1AutoRetry.as_str(), "ladder-1");
        assert_eq!(RecoveryLadder::Ladder2MainAgent.as_str(), "ladder-2");
        assert_eq!(RecoveryLadder::Ladder3Fork.as_str(), "ladder-3");
        assert_eq!(RecoveryLadder::Ladder4User.as_str(), "ladder-4");
    }

    // ── 阶梯 2 steering 条目 ──────────────────────────────────────

    /// steering 条目形状：分组去重 + steering 受保护位 + 文案含关键信息
    #[test]
    fn steering_entry_shape() {
        let notification = RecoveryNotification {
            subagent_id: "sub-1".to_string(),
            subagent_run_id: "run-1".to_string(),
            fingerprint: fingerprint("sub-1", "任务"),
            retries: 3,
            remaining_status: "running".to_string(),
            pending: true,
            created_at_ms: 1_700_000_000_000,
        };
        let entry = build_steering_entry(&notification);
        assert!(entry.is_steering, "steering 受保护位");
        assert_eq!(
            entry.group_id.as_deref(),
            Some("recovery-run-1"),
            "同 run 分组去重"
        );
        assert!(entry.text.contains("sub-1"));
        assert!(entry.text.contains("run-1"));
        assert!(entry.text.contains("已重试 3 次"));
        // 同分组 replaceOrEnqueue 去重
        let mut queue = PendingMessageQueue::new();
        queue.replace_or_enqueue(build_steering_entry(&notification));
        let replaced = queue.replace_or_enqueue(build_steering_entry(&notification));
        assert!(replaced, "同 run 重复升级应原位替换");
        assert_eq!(queue.len(), 1);
    }

    // ── 协调器逐级测试 ────────────────────────────────────────────

    /// 阶梯 1 自动重试：瞬态错误预算内 → AutoRetry，无 steering、无通知
    #[tokio::test]
    async fn ladder1_auto_retry_within_budget() {
        let (env, mut coordinator) = env();
        for (retries, expected_attempt, expected_delay) in
            [(0u32, 1u32, 750u64), (1, 2, 1500)]
        {
            let outcome = coordinator
                .on_subagent_run_failure(&ctx(
                    "run-1",
                    ProviderErrorKind::Network,
                    retries,
                    0,
                ))
                .await
                .unwrap();
            assert_eq!(outcome.ladder, RecoveryLadder::Ladder1AutoRetry);
            match outcome.action {
                RecoveryAction::AutoRetry { attempt, delay } => {
                    assert_eq!(attempt, expected_attempt);
                    assert_eq!(delay, Duration::from_millis(expected_delay));
                }
                other => panic!("期望 AutoRetry：{other:?}"),
            }
        }
        // 无 steering 条目、无通知落库、无任何留痕事件
        assert!(!env.queue.lock().unwrap().has_pending());
        assert_eq!(coordinator.pending_notifications(), 0);
        assert!(env.store.events().is_empty(), "重试不计入留痕");
    }

    /// 阶梯 2：预算耗尽 → steering 条目入队 + 通知落库 + 事件留痕
    #[tokio::test]
    async fn ladder2_steering_queued_on_budget_exhaustion() {
        let (env, mut coordinator) = env();
        let outcome = coordinator
            .on_subagent_run_failure(&ctx(
                "run-1",
                ProviderErrorKind::ServerError,
                5,
                61_000,
            ))
            .await
            .unwrap();
        assert_eq!(outcome.ladder, RecoveryLadder::Ladder2MainAgent);
        let RecoveryAction::SteeringQueued { notification } = outcome.action else {
            panic!("期望 SteeringQueued");
        };
        assert!(notification.pending);
        assert_eq!(notification.retries, 5);
        // 主 agent 可读（dequeue_all 取到条目）
        let mut queue = env.queue.lock().unwrap();
        let drained = queue.dequeue_all();
        assert_eq!(drained.len(), 1);
        assert!(drained[0].text.contains("run-1"));
        drop(queue);
        // 通知已落库（重启恢复依据）
        assert_eq!(coordinator.pending_notifications(), 1);
        // 留痕事件：升级 + steering 两条
        let events = env.store.events();
        let types: Vec<&str> = events
            .iter()
            .map(|(_, t, _)| t.as_str())
            .collect();
        assert_eq!(types, vec![RECOVER_ESCALATED_EVENT, RECOVER_STEERING_EVENT]);
    }

    /// 阶梯 2 激活路径：steering 条目可转为用户消息注入主 agent
    /// （transfer_follow_up 语义）；acknowledge 后重启不重排
    #[tokio::test]
    async fn ladder2_activation_path_and_acknowledge() {
        let (env, mut coordinator) = env();
        coordinator
            .on_subagent_run_failure(&ctx(
                "run-1",
                ProviderErrorKind::Timeout,
                3,
                61_000,
            ))
            .await
            .unwrap();
        // 引擎在主 agent 下一条消息边界消费：条目转为用户消息（L1 载体）
        let mut queue = env.queue.lock().unwrap();
        let mut input = session_loop::input::AgentInputQueue::new();
        let count = queue.transfer_follow_up(&mut input);
        assert_eq!(count, 1);
        assert!(input.has_follow_up_pending());
        assert_eq!(input.promote_follow_up(), 1);
        let message = input.dequeue().expect("promote 后可消费");
        assert!(message.text().contains("run-1"));
        assert_eq!(
            message
                .metadata
                .as_ref()
                .and_then(|m| m.get("kind"))
                .and_then(|k| k.as_str()),
            Some("steering")
        );
        drop(queue);
        // acknowledge：主 agent 已处理 → pending = false
        assert!(coordinator.acknowledge("run-1").unwrap());
        assert!(!coordinator.acknowledge("run-1").unwrap(), "幂等：二次确认无变更");
        assert_eq!(coordinator.pending_notifications(), 0);
    }

    /// 重启恢复：未处理的阶梯 2 通知仍在队列（04 C7 验收 5）
    #[tokio::test]
    async fn restart_keeps_pending_steering() {
        let (env, mut coordinator) = env();
        coordinator
            .on_subagent_run_failure(&ctx(
                "run-1",
                ProviderErrorKind::Network,
                4,
                62_000,
            ))
            .await
            .unwrap();
        // 模拟重启：同一 store 新建协调器（预算/通知恢复）
        let new_queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        let mut restarted = RecoveryCoordinator::new(
            "s1",
            env.store.clone(),
            new_queue.clone(),
            env.tree.clone(),
            env.spawner.clone(),
            RecoveryRetryPolicy {
                max_retries: 5,
                ..RecoveryRetryPolicy::default()
            },
        )
        .unwrap();
        assert_eq!(restarted.pending_notifications(), 1, "通知跨重启恢复");
        // 重排入队后主 agent 可读
        let restored = restarted.restore_steering_notifications().unwrap();
        assert_eq!(restored, 1);
        let mut queue = new_queue.lock().unwrap();
        let drained = queue.dequeue_all();
        assert_eq!(drained.len(), 1);
        assert!(drained[0].text.contains("run-1"));
    }

    /// 阶梯 3：fork 新 run + 路径落库 + 原 run failed + 事件留痕
    #[tokio::test]
    async fn ladder3_fork_creates_new_run_with_path() {
        let (env, mut coordinator) = env();
        let failure_ctx = ctx("run-1", ProviderErrorKind::ServerError, 5, 61_000);
        coordinator.on_subagent_run_failure(&failure_ctx).await.unwrap();
        let outcome = coordinator.fork_and_reassign(&failure_ctx).await.unwrap();
        assert_eq!(outcome.ladder, RecoveryLadder::Ladder3Fork);
        let RecoveryAction::Forked { record } = outcome.action else {
            panic!("期望 Forked");
        };
        assert_eq!(record.from_run_id, "run-1");
        assert_eq!(record.new_run_id, "fork-run-0");
        assert_eq!(record.context_mode, ForkContextMode::Verbatim);
        // 会话树：新叶子挂在源叶子下
        let tree = env.tree.lock().unwrap();
        let new_leaf = tree
            .entry(&record.new_leaf_id)
            .expect("fork 叶子必须存在");
        assert_eq!(new_leaf.parent_id.as_deref(), Some("leaf-a"));
        // 工作流路径（根 → 新叶子）
        let path = tree.read_branch_path(Some(&record.new_leaf_id)).unwrap();
        let ids: Vec<&str> = path.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["leaf-a", record.new_leaf_id.as_str()]);
        drop(tree);
        // 路径落 subagent_path_json（新 run 行）
        let path_json = env.store.path("fork-run-0").expect("路径必须落库");
        let ids: Vec<String> = serde_json::from_str(&path_json).unwrap();
        assert_eq!(ids, vec!["leaf-a".to_string(), record.new_leaf_id]);
        // 原 run 置 failed
        assert_eq!(
            env.store.run_status("run-1").unwrap(),
            ("failed".to_string(), "recovery-fork".to_string())
        );
        // spawner 请求：同一目标 prompt
        let requests = env.spawner.requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].prompt, "完成模块 A");
        // 事件留痕
        let events = env.store.events();
        let types: Vec<&str> = events
            .iter()
            .map(|(_, t, _)| t.as_str())
            .collect();
        assert!(types.contains(&RECOVER_FORK_EVENT));
        // 预算计数
        assert_eq!(
            coordinator.budget().count(&fingerprint("sub-1", "完成模块 A")),
            1
        );
    }

    /// 阶梯 3 幂等：同指纹同源 run 重复 fork 返回既有记录，不重复 spawn
    #[tokio::test]
    async fn ladder3_fork_idempotent() {
        let (env, mut coordinator) = env();
        let failure_ctx = ctx("run-1", ProviderErrorKind::Network, 4, 61_000);
        let first = coordinator.fork_and_reassign(&failure_ctx).await.unwrap();
        let second = coordinator.fork_and_reassign(&failure_ctx).await.unwrap();
        let RecoveryAction::Forked { record: a } = first.action else {
            panic!("期望 Forked");
        };
        let RecoveryAction::Forked { record: b } = second.action else {
            panic!("期望 Forked");
        };
        assert_eq!(a, b, "幂等：重复 fork 返回同一记录");
        assert_eq!(env.spawner.requests().len(), 1, "不重复 spawn");
        assert_eq!(coordinator.budget().count(&a.fingerprint), 1, "不重复计数");
    }

    /// 预算超限：fork 第 4 次（limit=3）→ 阶梯 4 上报用户，不再 fork
    #[tokio::test]
    async fn ladder3_budget_exhausted_goes_ladder4() {
        let (env, mut coordinator) = env();
        // 前 3 次 fork 成功
        for i in 0..3 {
            let failure_ctx = ctx(
                &format!("run-{i}"),
                ProviderErrorKind::ServerError,
                4,
                61_000,
            );
            let outcome = coordinator.fork_and_reassign(&failure_ctx).await.unwrap();
            assert_eq!(outcome.ladder, RecoveryLadder::Ladder3Fork, "第 {} 次 fork", i + 1);
        }
        // 第 4 次（不同 run 同指纹）→ 直接阶梯 4
        let failure_ctx = ctx("run-3", ProviderErrorKind::ServerError, 4, 61_000);
        let outcome = coordinator.fork_and_reassign(&failure_ctx).await.unwrap();
        assert_eq!(outcome.ladder, RecoveryLadder::Ladder4User);
        let RecoveryAction::NeedsUser { report } = outcome.action else {
            panic!("期望 NeedsUser");
        };
        assert_eq!(report.subagent_run_id, "run-3");
        assert!(report.suggestion.contains("人工决策"));
        assert!(env.store.run_status("run-3").is_none(), "预算超限不再置 failed 之外的状态");
        // 需介入标记 + 上报事件
        assert!(coordinator.run_needs_user("run-3"));
        let events = env.store.events();
        let types: Vec<&str> = events
            .iter()
            .map(|(_, t, _)| t.as_str())
            .collect();
        assert!(types.contains(&RECOVER_BUDGET_DENIED_EVENT));
        assert!(types.contains(&RECOVER_REPORT_EVENT));
    }

    /// 预算超限直接阶梯 4（on_subagent_run_failure 路径：不产生阶梯 2 通知）
    #[tokio::test]
    async fn ladder2_skipped_when_budget_exhausted() {
        let (env, mut coordinator) = env();
        // 前 3 次 fork 耗尽预算
        for i in 0..3 {
            let failure_ctx = ctx(
                &format!("run-{i}"),
                ProviderErrorKind::Network,
                4,
                61_000,
            );
            coordinator.fork_and_reassign(&failure_ctx).await.unwrap();
        }
        // 新 run 再失败：预算已耗尽 → 跳过阶梯 2 直接阶梯 4
        let outcome = coordinator
            .on_subagent_run_failure(&ctx(
                "run-9",
                ProviderErrorKind::Network,
                4,
                61_000,
            ))
            .await
            .unwrap();
        assert_eq!(outcome.ladder, RecoveryLadder::Ladder4User);
        // 无新的 steering 条目
        assert_eq!(env.queue.lock().unwrap().len(), 0);
        // 上报含 3 次 fork 尝试记录
        let RecoveryAction::NeedsUser { report } = outcome.action else {
            panic!("期望 NeedsUser");
        };
        let fork_attempts = report
            .attempts
            .iter()
            .filter(|a| a.ladder == RecoveryLadder::Ladder3Fork)
            .count();
        assert_eq!(fork_attempts, 3, "试过什么：3 次 fork 记录");
    }

    /// 重启恢复预算：跨重启计数一致，不重放授权
    #[tokio::test]
    async fn restart_recovers_budget_counts() {
        let (env, mut coordinator) = env();
        for i in 0..2 {
            let failure_ctx = ctx(
                &format!("run-{i}"),
                ProviderErrorKind::ServerError,
                4,
                61_000,
            );
            coordinator.fork_and_reassign(&failure_ctx).await.unwrap();
        }
        // 模拟重启
        let mut restarted = RecoveryCoordinator::new(
            "s1",
            env.store.clone(),
            env.queue.clone(),
            env.tree.clone(),
            env.spawner.clone(),
            RecoveryRetryPolicy {
                max_retries: 5,
                ..RecoveryRetryPolicy::default()
            },
        )
        .unwrap();
        let fp = fingerprint("sub-1", "完成模块 A");
        assert_eq!(restarted.budget().count(&fp), 2, "预算跨重启恢复");
        assert!(restarted.budget().can_recover(&fp), "2 < 3 仍可恢复");
        // 第 3 次 fork 后超限
        let failure_ctx = ctx("run-2", ProviderErrorKind::ServerError, 4, 61_000);
        let outcome = restarted.fork_and_reassign(&failure_ctx).await.unwrap();
        assert_eq!(outcome.ladder, RecoveryLadder::Ladder3Fork);
        assert!(!restarted.budget().can_recover(&fp));
    }

    /// 阶梯 4 上报内容：卡在哪一步 + 试过什么 + 建议怎么办
    #[tokio::test]
    async fn ladder4_report_content() {
        let (env, mut coordinator) = env();
        // 一次阶梯 2 通知 + 一次 fork
        let failure_ctx = ctx("run-1", ProviderErrorKind::Timeout, 3, 61_000);
        coordinator.on_subagent_run_failure(&failure_ctx).await.unwrap();
        coordinator.fork_and_reassign(&failure_ctx).await.unwrap();
        // 新 run 再失败 → 预算仍够 → 阶梯 2；主 agent 决策上报
        let failure_ctx = ctx("fork-run-0", ProviderErrorKind::Timeout, 3, 61_000);
        let outcome = coordinator.report_to_user(&failure_ctx).unwrap();
        assert_eq!(outcome.ladder, RecoveryLadder::Ladder4User);
        let RecoveryAction::NeedsUser { report } = outcome.action else {
            panic!("期望 NeedsUser");
        };
        assert_eq!(report.subagent_run_id, "fork-run-0");
        // 尝试记录：阶梯 1 + 阶梯 2 + 阶梯 3 各 ≥1 条
        assert!(
            report
                .attempts
                .iter()
                .any(|a| a.ladder == RecoveryLadder::Ladder1AutoRetry)
        );
        assert!(
            report
                .attempts
                .iter()
                .any(|a| a.ladder == RecoveryLadder::Ladder2MainAgent)
        );
        assert!(
            report
                .attempts
                .iter()
                .any(|a| a.ladder == RecoveryLadder::Ladder3Fork)
        );
        assert!(report.suggestion.contains("人工决策"), "建议含决策指引");
        assert!(report.suggestion.contains("fork-run-0"), "建议引用停摆 run");
        // 需介入标记落库
        assert!(coordinator.run_needs_user("fork-run-0"));
        let raw = env
            .store
            .meta
            .lock()
            .unwrap()
            .get(RECOVER_NEEDS_USER_KEY)
            .cloned();
        let ids: Vec<String> = serde_json::from_str(&raw.unwrap()).unwrap();
        assert_eq!(ids, vec!["fork-run-0"]);
    }

    /// fork 源叶子缺失 → 结构化错误（不 panic、不产生 run）
    #[tokio::test]
    async fn ladder3_fork_without_leaf_rejected() {
        let (_env, mut coordinator) = env();
        let mut ctx = ctx("run-1", ProviderErrorKind::ServerError, 4, 61_000);
        ctx.from_leaf_id = None;
        let err = coordinator.fork_and_reassign(&ctx).await.unwrap_err();
        assert!(
            matches!(err, RecoveryError::InvalidState { .. }),
            "缺少源叶子必须结构化拒绝：{err:?}"
        );
    }

    /// fork spawn 失败 → 结构化错误上抛（不 panic、原 run 状态不变）
    #[tokio::test]
    async fn ladder3_spawn_failure_escalates() {
        let store = InMemoryRecoveryStore::new();
        let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        let tree = Arc::new(Mutex::new(SessionTree::new("s1")));
        tree.lock()
            .unwrap()
            .append("leaf-a", json!({ "text": "root" }))
            .unwrap();
        let spawner = RecordingSpawner::rejecting();
        let mut coordinator = RecoveryCoordinator::new(
            "s1",
            store.clone(),
            queue.clone(),
            tree.clone(),
            spawner,
            RecoveryRetryPolicy {
                max_retries: 5,
                ..RecoveryRetryPolicy::default()
            },
        )
        .unwrap();
        let failure_ctx = ctx("run-1", ProviderErrorKind::ServerError, 4, 61_000);
        let err = coordinator.fork_and_reassign(&failure_ctx).await.unwrap_err();
        assert!(
            matches!(err, RecoveryError::PersistFailed { .. }),
            "spawn 失败必须结构化上抛：{err:?}"
        );
        // 预算未消费（spawn 失败不计数）
        assert_eq!(coordinator.budget().count(&fingerprint("sub-1", "完成模块 A")), 0);
    }
}
