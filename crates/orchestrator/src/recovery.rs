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
//!
//! **接线现状（EV-08 头注更新，08 审计建议 6）**：D3 实现后生产接线已
//! 存在——协调器装配（[RecoveryCoordinator]）与阶梯 1 决策/执行
//! （decide_subagent_recovery / execute_subagent_recovery）、阶梯 2
//! 通知恢复（restore_steering_notifications）均在壳层
//! （apps/agent-workbench run/run_resume.rs、run/run_idle.rs）接线；
//! acknowledge 由主 agent 处理阶梯 2 通知后调用。子代理 run 失败时
//! 生产链路触发四级阶梯恢复。conex-db 只读：session_meta 与事件/run/
//! session_agents 均经既有接口（[RecoveryStore] 抽象，无一行 conex-db
//! 改动）。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_tools::tools::subagent::{SubagentSpawnRequest, SubagentSpawner, SubagentState};
use conex_types::error::ProviderErrorKind;
use conex_types::events::AgentEvent;

use crate::now_ms;
use crate::session::SessionTree;
use crate::steering_queue::PendingMessageQueue;

// SR-06d · 拆分 · ≠ EL：本文件为薄门面（常量 + 协调器），逻辑域拆 3 模：
// - recovery_policy.rs：阶梯 1 重试策略与 Episode 预算制（recovery_policy::*）
// - recovery_notify.rs：阶梯 2 steering / 阶梯 3 fork / 阶梯 4 上报
//   （recovery_notify::*）
// - recovery_store.rs：持久化抽象 [RecoveryStore] 与 [RecoveryError]
// 公开面经 `pub use` 重导出，orchestrator::recovery::* 路径不 break；
// 测试旁挂 recovery_tests.rs / recovery_tests_coordinator.rs（include! 接线）。

#[path = "recovery_notify.rs"]
mod recovery_notify;
#[path = "recovery_policy.rs"]
mod recovery_policy;
#[path = "recovery_store.rs"]
mod recovery_store;

pub use recovery_notify::{
    build_steering_entry, build_user_report, decide_fork_context, fork_node_payload,
    steering_group_id, steering_text, AttemptRecord, ForkContextMode, ForkRecord, RecoveryLadder,
    RecoveryNotification, UserReport,
};
pub use recovery_policy::{
    backoff_delay_ms, fingerprint, is_transient_kind, ladder1_decision, EscalateReason,
    Ladder1Decision, RecoveryBudget, RecoveryRetryPolicy,
};
pub use recovery_store::{RecoveryError, RecoveryStore};

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
/// 阶梯 2 通知确认留痕（EV-08：acknowledge pending→false 翻转点）
pub const RECOVER_ACKNOWLEDGED_EVENT: &str = "recovery-acknowledged";
/// 阶梯 3 fork 留痕
pub const RECOVER_FORK_EVENT: &str = "recovery-fork";
/// 阶梯 4 上报用户留痕
pub const RECOVER_REPORT_EVENT: &str = "recovery-report";
/// Episode 预算耗尽拒绝留痕
pub const RECOVER_BUDGET_DENIED_EVENT: &str = "recovery-budget-denied";

// ── DM-05 直写路径规范化（D-01 轮 2）：recovery-* 事件 payload 统一
//    带顶层 type 键——读侧 D8 fallback 合成 wire 时以 type 路由事件种类
//    （G-20 读侧可见性）；背压语义不变（Critical 落库必达）────────────

/// typed 序列化：经 AgentEvent 枚举变体（serde tag="type" 自动产出
/// 顶层 type 键），字段形状与 conex-types 注册表（engine-events.json
/// id 42/46）严格一致。
fn serialize_recovery_typed(event: &AgentEvent) -> Result<String, RecoveryError> {
    serde_json::to_string(event).map_err(|e| RecoveryError::InvalidState {
        message: format!("恢复事件序列化失败：{e}"),
    })
}

/// 降级路径（规范化镜像构造函数）：payload 保留既有字段镜像并补顶层
/// type 键。用于镜像字段超出 typed 变体形状的场景（steering 的
/// errorKind / fork 的 createdAtMs / report 的 attempts——AgentEvent
/// 枚举变体无对应字段，typed 序列化会丢字段，故镜像保真降级；契约
/// 保真清单登记：DM-05 降级 3 处，字段形状为镜像超集 + type 键）。
fn serialize_recovery_mirror(
    event_type: &str,
    value: &serde_json::Value,
) -> Result<String, RecoveryError> {
    let mut value = value.clone();
    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            "type".to_string(),
            serde_json::Value::String(event_type.to_string()),
        );
    }
    serde_json::to_string(&value).map_err(|e| RecoveryError::InvalidState {
        message: format!("恢复事件序列化失败：{e}"),
    })
}

// ── 阶梯 1：自动重试（镜像 agent-provider/retry.rs，B2.7）──────────

/// 首次退避基数（镜像 retry.rs RetryPolicy::default，750ms）
pub const RECOVERY_BASE_DELAY_MS: u64 = 750;
/// 单次等待上限（镜像 retry.rs，8s）
pub const RECOVERY_MAX_DELAY_MS: u64 = 8_000;
/// 总重试预算（镜像 retry.rs，60s）
pub const RECOVERY_TOTAL_BUDGET_MS: u64 = 60_000;

// ── 阶梯 3：重分配 / fork（三态上下文继承，02 Top 6）──────────────

/// fork 上下文同窗口时长（默认 24h）
pub const FORK_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;
/// fork 字节级继承占比守卫（注入内容 ≤ 会话窗口 80%，grok SAFE_FORK_PERCENT）
pub const FORK_VERBATIM_MAX_RATIO: f64 = 0.8;

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
    /// 并发 Fork 防重占位表（TOCTOU 保护：(fingerprint:from_run_id) 集合）
    in_flight_forks: std::collections::HashSet<String>,
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
        let budget =
            RecoveryBudget::from_json(store.get_meta(RECOVER_EPISODES_KEY)?.as_deref(), limit);
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
            in_flight_forks: std::collections::HashSet::new(),
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
        self.notifications.iter().filter(|n| n.pending).count()
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
            Ladder1Decision::Retry { attempt, delay, .. } => {
                return Ok(RecoveryOutcome {
                    ladder: RecoveryLadder::Ladder1AutoRetry,
                    action: RecoveryAction::AutoRetry { attempt, delay },
                });
            }
            Ladder1Decision::Escalate { reason } => {
                // 升级留痕（阶梯 1 → 阶梯 2 的边界证据；DM-05 typed
                // 序列化：字段形状与 engine-events.json id 42 对齐，
                // serde 自动产出顶层 type 键）
                self.store.append_event(
                    &self.session_id,
                    RECOVER_ESCALATED_EVENT,
                    &serialize_recovery_typed(&AgentEvent::RecoveryEscalated {
                        session_id: self.session_id.clone(),
                        subagent_run_id: Some(ctx.subagent_run_id.clone()),
                        kind: format!("{reason:?}"),
                        retries: ctx.retries,
                        elapsed_ms: ctx.retry_elapsed_ms,
                        detail: None,
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
                // DM-05 typed 序列化：字段形状与 engine-events.json id 46
                // 对齐（subagentRunId 本路径恒 Some——子代理侧发射方）
                &serialize_recovery_typed(&AgentEvent::RecoveryBudgetDenied {
                    session_id: self.session_id.clone(),
                    subagent_run_id: Some(ctx.subagent_run_id.clone()),
                    fingerprint: fp.clone(),
                    count: self.budget.count(&fp),
                    max: self.budget.limit(),
                })?,
            )?;
            // G10 月度统计收集点：恢复预算 denied 计数（进程级累计，
            // 月度报告经 conex_types::denied_stats 拉取；持久化由事件留痕承载）
            conex_types::denied_stats::global_denied_stats().record_recovery_budget_denied();
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
            error_kind: Some(ctx.error_kind),
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
        self.notifications
            .retain(|n| n.subagent_run_id != notification.subagent_run_id);
        self.notifications.push(notification.clone());
        self.persist_notifications()?;
        // 事件留痕（DM-05 降级路径：RecoveryNotification 镜像 + 顶层
        // type 键——errorKind 字段超出 typed 变体形状，镜像保真不丢失）
        let payload_value =
            serde_json::to_value(&notification).map_err(|e| RecoveryError::InvalidState {
                message: format!("steering 事件序列化失败：{e}"),
            })?;
        self.store.append_event(
            &self.session_id,
            RECOVER_STEERING_EVENT,
            &serialize_recovery_mirror(RECOVER_STEERING_EVENT, &payload_value)?,
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
        // TOCTOU 锁保护：并发 Fork 防重占位
        let in_flight_key = format!("{}:{}", fp, ctx.subagent_run_id);
        if !self.in_flight_forks.insert(in_flight_key.clone()) {
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
            return Err(RecoveryError::InvalidState {
                message: format!(
                    "子代理 run {} 正在进行并发 fork 恢复中，拒绝重复触发",
                    ctx.subagent_run_id
                ),
            });
        }

        let res = self.fork_and_reassign_inner(ctx, fp).await;
        self.in_flight_forks.remove(&in_flight_key);
        res
    }

    async fn fork_and_reassign_inner(
        &mut self,
        ctx: &RunFailureContext,
        fp: String,
    ) -> Result<RecoveryOutcome, RecoveryError> {
        // 预算制：超预算禁止自动恢复，直接阶梯 4
        if !self.budget.can_recover(&fp) {
            self.store.append_event(
                &self.session_id,
                RECOVER_BUDGET_DENIED_EVENT,
                // DM-05 typed 序列化：字段形状与 engine-events.json id 46
                // 对齐（fork 路径同 on_subagent_run_failure 路径形状）
                &serialize_recovery_typed(&AgentEvent::RecoveryBudgetDenied {
                    session_id: self.session_id.clone(),
                    subagent_run_id: Some(ctx.subagent_run_id.clone()),
                    fingerprint: fp.clone(),
                    count: self.budget.count(&fp),
                    max: self.budget.limit(),
                })?,
            )?;
            return self.report_to_user(ctx);
        }
        let from_leaf_id = ctx
            .from_leaf_id
            .clone()
            .ok_or_else(|| RecoveryError::InvalidState {
                message: "fork 需要源叶子节点（from_leaf_id 为空）".to_string(),
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
        // fork 与读路径同一次持锁：消除 fork 后、读路径前的 TOCTOU
        let path_json = {
            let mut tree = self.tree.lock().map_err(|e| RecoveryError::InvalidState {
                message: format!("会话树锁中毒：{e}"),
            })?;
            tree.fork(&from_leaf_id, &new_leaf_id, payload)
                .map_err(|e| RecoveryError::InvalidState {
                    message: format!("会话树 fork 失败：{e}"),
                })?;
            // 工作流路径（根 → 新叶子）落 subagent_path_json
            let path = tree.read_branch_path(Some(&new_leaf_id)).map_err(|e| {
                RecoveryError::InvalidState {
                    message: format!("工作流路径读取失败：{e}"),
                }
            })?;
            serde_json::to_string(&path.iter().map(|e| e.id.clone()).collect::<Vec<_>>()).map_err(
                |e| RecoveryError::InvalidState {
                    message: format!("工作流路径序列化失败：{e}"),
                },
            )?
        };
        // 新 run 启动（spawner 契约：守卫校验 + 落库 + 独立 run，引擎侧实现）
        // LK-02：fork 前反查原 run 的 session_agents 行，传播其
        // parent_tool_call_id（链路键随 fork 延续，行 + 事件体真值）；
        // 查不到（行不存在 → None）/查询失败（降级 None）均不阻断
        // fork——键是观测增强而非前置条件，失败留告警不静默
        let parent_tool_call_id = self
            .store
            .get_subagent_parent_tool_call_id(&self.session_id, &ctx.subagent_run_id)
            .unwrap_or_else(|e| {
                tracing::warn!(
                    target: "recovery",
                    event = "fork_parent_tool_call_lookup_failed",
                    subagent_run_id = %ctx.subagent_run_id,
                    error = %e,
                    "fork 反查父工具调用 id 失败，按 None 传播"
                );
                None
            });
        let request = SubagentSpawnRequest {
            agent_id: None,
            prompt: ctx.task.clone(),
            role: None,
            capability_mode: None,
            allowed_tools: None,
            description: Some("恢复 fork（C7 阶梯 3，承接同一目标）".to_string()),
            mode: None,
            parent_session_id: self.session_id.clone(),
            parent_run_id: None,
            // LK-02：fork 传播原行键（反查见上；查不到保持 None）
            parent_tool_call_id,
            flow_node_id: None,
            is_composite: false,
            // T-D-07 定义扩展：恢复 fork 路径不携带任务类型/写路径/标签
            task_type: None,
            allowed_write_paths: None,
            display_label: None,
            // 扩展点预留：全构造点显式 None（编译器强制）
            model_override: None,
        };
        let spawned =
            self.spawner
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
        self.store
            .set_subagent_path(&self.session_id, &spawned.subagent_run_id, &path_json)?;
        // 原 run 置 failed 并留痕（C7 行为 3：原 run 状态置 failed）
        self.store
            .update_run_status(&ctx.subagent_run_id, "failed", "recovery-fork")?;
        // 预算消费 + 记录落库 + 事件留痕
        self.budget.record_fork(&record.fingerprint)?;
        self.forks.push(record.clone());
        self.persist_forks()?;
        self.persist_budget()?;
        // DM-05 降级路径：ForkRecord 镜像 + 顶层 type 键（createdAtMs
        // 超出 typed 变体形状，镜像保真不丢失）
        let payload_value =
            serde_json::to_value(&record).map_err(|e| RecoveryError::InvalidState {
                message: format!("fork 事件序列化失败：{e}"),
            })?;
        self.store.append_event(
            &self.session_id,
            RECOVER_FORK_EVENT,
            &serialize_recovery_mirror(RECOVER_FORK_EVENT, &payload_value)?,
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
        // DM-05 降级路径：UserReport 镜像 + 顶层 type 键（attempts 尝试
        // 明细超出 typed 变体形状——注册表明确「attempts 不在事件面」，
        // 镜像保真不丢失，读侧仍可聚合）
        let payload_value =
            serde_json::to_value(&report).map_err(|e| RecoveryError::InvalidState {
                message: format!("上报事件序列化失败：{e}"),
            })?;
        self.store.append_event(
            &self.session_id,
            RECOVER_REPORT_EVENT,
            &serialize_recovery_mirror(RECOVER_REPORT_EVENT, &payload_value)?,
        )?;
        Ok(RecoveryOutcome {
            ladder: RecoveryLadder::Ladder4User,
            action: RecoveryAction::NeedsUser { report },
        })
    }

    /// 阶梯 2 确认：主 agent 已注入激活指令处理该 run——通知置
    /// pending = false（幂等），重启后不再重排入队。
    ///
    /// EV-08：每次实际翻转（pending→false）发射 `recovery-acknowledged`
    /// 留痕事件（动作链闭合——「主 agent 已处理该通知」可查；幂等二次
    /// 确认无翻转不发）。
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
            // DM-05 typed 序列化：字段形状与 engine-events.json 注册表
            // 一致（recovery-acknowledged；notificationId 缺省 None——
            // RecoveryNotification 无独立 id，subagentRunId 即关联键）
            self.store.append_event(
                &self.session_id,
                RECOVER_ACKNOWLEDGED_EVENT,
                &serialize_recovery_typed(&AgentEvent::RecoveryAcknowledged {
                    session_id: self.session_id.clone(),
                    timestamp: conex_shared::time::now_iso_utc(),
                    notification_id: None,
                    subagent_run_id: subagent_run_id.to_string(),
                })?,
            )?;
        }
        Ok(changed)
    }

    /// 重启恢复：把持久化的 pending 通知重新排入 steering 队列
    /// （04 C7 验收 5：重启后未处理的阶梯 2 通知仍在队列）。
    ///
    /// 返回重排条数；同 run 已消费（pending = false）不重排。
    pub fn restore_steering_notifications(&mut self) -> Result<usize, RecoveryError> {
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
        let raw = serde_json::to_string(&self.forks).map_err(|e| RecoveryError::InvalidState {
            message: format!("fork 记录列表序列化失败：{e}"),
        })?;
        self.store.set_meta(RECOVER_FORKS_KEY, &raw)
    }

    /// 持久化预算计数
    fn persist_budget(&self) -> Result<(), RecoveryError> {
        self.store
            .set_meta(RECOVER_EPISODES_KEY, &self.budget.to_json())
    }

    /// 持久化需介入标记列表
    fn persist_needs_user(&self) -> Result<(), RecoveryError> {
        let raw =
            serde_json::to_string(&self.needs_user).map_err(|e| RecoveryError::InvalidState {
                message: format!("需介入列表序列化失败：{e}"),
            })?;
        self.store.set_meta(RECOVER_NEEDS_USER_KEY, &raw)
    }
}

/// 宽容解析持久化 JSON 列表（缺失 / 坏 JSON → 空，fail-open 不 panic）
fn parse_json_list<T: serde::de::DeserializeOwned>(raw: Option<String>) -> Vec<T> {
    raw.and_then(|raw| serde_json::from_str::<Vec<T>>(&raw).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    // SR-06d · 拆分 · ≠ EL：测试旁挂分两段（crate-size 门禁对 src 内每个
    // 文件限 600 行，故用 include! 合成单一 tests 模块——测试路径
    // recovery::tests::* 不 break）。
    include!("recovery_tests.rs");
    include!("recovery_tests_coordinator.rs");
}
