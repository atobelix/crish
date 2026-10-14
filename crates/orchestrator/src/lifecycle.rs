//! 子代理生命周期补缺（T-D-09 REQ-D08：kill_all + resume_subagent）
//!
//! 在 list/kill/resume（恢复阶梯 fork）既有能力之上的两个显式命令面：
//! - **kill_all**：批量终止主会话全部 running 子代理——过滤面走
//!   conex-db 查询扩展（parent_session_id = 主会话 且 status = running），
//!   逐个对子代理 run 投递 L3 `request_force_cancel`（control.rs:319
//!   队列面复用），终态统一归一 failed；**无递归**（maxDepth=1（T-D-01）
//!   后子代理无后代，无需遍历）；产出保留（行与消息原样保留，回收站与
//!   session_agent_messages 级联为既有机制）；返回终止列表 + 未终态汇总
//!   供主 Agent 编排；
//! - **resume_subagent**：显式恢复命令——目标 run 置 failed、经
//!   [RecoveryCoordinator::fork_and_reassign]（recovery.rs:1026）fork 新
//!   run 承接同一目标；上下文继承走 decide_fork_context 三态（≤24h 窗口
//!   + ≤80% 字节占比 → Verbatim；超限 Summarized；空内容 New）；消费
//!   Episode 预算（recovery.rs:259-329，与恢复阶梯共用预算池，防无限
//!   fork）。**resume 是恢复阶梯的显式命令面，不是新恢复机制**——阶梯 1
//!   自动重试仍优先（recovery.rs:198-236），resume 供主 Agent/用户手动兜底；
//!   **仅对恢复阶梯 fork 出的 run 可用**（LK-07 R-14：fork 路径落
//!   subagent_path_json 且树节点存在；普通 spawn 的 run 无树节点，fork 前
//!   置 failed 时按 InvalidState 拒绝——命令面错误文案显式标注该边界）；
//! - **kill_subagent**（D4 §3.2）：单目标终止——按 (session_id, agent_id)
//!   主键定位行，L3 强停投递 + 行归一 failed；三态结果（killed /
//!   already_terminal 幂等 / 未投递汇总）。与 kill_all 共用
//!   [ForceCancelSink] 与 [SubagentLifecycleService::mark_row_failed]，
//!   归一写面同源。
//!
//! 稳定域纪律：本模块只消费 [crate::recovery] 与 session-loop control.rs
//! 的既有公共面（L0-L3 协议 / fork 算法 / Episode 预算本体零改动）；
//! 引擎侧接线（ForceCancelSink 实现 = 按 run 定位 ControlBus 投递）在
//! workbench 域（T-D-13），本模块不感知具体总线实例。

use std::fmt;
use std::sync::Arc;

use conex_db::{DbFailure, LocalDb};
use conex_types::error::ProviderErrorKind;
use conex_types::events::{AgentEventEnvelope, SubagentEndStatus};
use conex_types::{HistoryMessage, SessionAgent, SessionMessage};
use serde::Serialize;

use crate::normalize::normalize_envelope;
use crate::now_ms;
use crate::recovery::{
    ForkRecord, RecoveryAction, RecoveryCoordinator, RecoveryError, RunFailureContext, UserReport,
};
use crate::subagent_events::{build_subagent_ended, SubagentEmitContext, SubagentEndedInfo};

/// L3 强停投递抽象（引擎侧实现：按 subagent_run_id 定位该 run 的控制总线，
/// 调 [session_loop::control::ControlBus::request_force_cancel]——control.rs:319
/// 队列面复用）。
///
/// 返回 false = 引擎内无该 run 的运行实例（无法投递，如重启后未恢复的
/// run），调用方按未终态汇总处理。
pub trait ForceCancelSink: Send + Sync {
    /// 向目标子代理 run 投递 L3 强停
    fn request_force_cancel(&self, subagent_run_id: &str, reason: &str) -> bool;

    /// BC03-2：广播触发目标子代理的 abort_signal.abort()（秒级物理打断）
    fn broadcast_abort(&self, _subagent_run_id: &str) -> bool {
        false
    }
}

/// 已终止子代理条目（L3 强停投递成功）
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KilledEntry {
    /// 子代理 id（session_agents.agent_id）
    pub subagent_id: String,
    /// 子代理 run id
    pub subagent_run_id: String,
}

/// 未终态汇总条目（L3 强停未投递）
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NonTerminalEntry {
    /// 子代理 id
    pub subagent_id: String,
    /// 子代理 run id
    pub subagent_run_id: String,
    /// 未投递原因（结构化文案，供主 Agent 编排核实）
    pub reason: String,
}

/// kill_all 结果载荷（结构化，供主 Agent 编排：已终止列表 + 未终态汇总）
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KillAllOutcome {
    /// 已终止的子代理（L3 强停投递成功 + 行归一 failed）
    pub terminated: Vec<KilledEntry>,
    /// 未终态汇总：L3 未投递（引擎无该 run 的运行实例）——行已归一
    /// failed，但 run 可能仍存活在引擎内存中，主 Agent 需核实或重试
    pub non_terminal: Vec<NonTerminalEntry>,
}

/// kill_subagent 单目标终止结果（三态：已终止 / 已终态幂等 / 未投递汇总）
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KillSubagentResult {
    /// 子代理 id（session_agents.agent_id）
    pub subagent_id: String,
    /// 子代理 run id
    pub subagent_run_id: String,
    /// 处置结果：killed = L3 强停投递成功 + 行归一 failed；
    /// already_terminal = 行非 running（失败/完成），无动作（幂等）
    pub outcome: &'static str,
    /// killed 时 L3 是否实际投递（引擎无该 run 的运行实例 = false）
    pub force_cancel_delivered: bool,
}

/// resume_subagent 结果
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ResumeOutcome {
    /// 阶梯 3 fork 成功：新 run 已 spawn 承接同一目标、原 run 置 failed。
    ///
    /// 幂等语义（recovery.rs fork_and_reassign）：同指纹同源 run 已 fork
    /// 过 → 返回既有 ForkRecord（不重复 spawn），主 Agent 以
    /// record.new_run_id 对齐后续编排。
    Forked(ForkRecord),
    /// Episode 预算耗尽 → 阶梯 4 上报用户（不产生 fork，需用户介入）
    NeedsUser(UserReport),
}

/// 生命周期域错误
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LifecycleError {
    /// 引用的子代理 / run / 行不存在
    NotFound {
        /// 详情
        message: String,
    },
    /// 参数或状态非法（如缺少工作流路径、无法推断任务）
    InvalidState {
        /// 详情
        message: String,
    },
    /// 落库失败
    PersistFailed {
        /// 详情
        message: String,
    },
    /// 恢复域错误（fork 上抛，如会话树 fork 失败）
    Recovery(RecoveryError),
}

impl fmt::Display for LifecycleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound { message } => write!(f, "生命周期目标不存在：{message}"),
            Self::InvalidState { message } => write!(f, "生命周期状态非法：{message}"),
            Self::PersistFailed { message } => write!(f, "生命周期持久化失败：{message}"),
            Self::Recovery(err) => write!(f, "恢复域失败：{err}"),
        }
    }
}

impl std::error::Error for LifecycleError {}

/// 子代理生命周期补缺服务（T-D-09）：kill_all 批量终止 + resume_subagent
/// 显式恢复。
///
/// 依赖：LocalDb（行读写，查询扩展走 agents.rs）+ [ForceCancelSink]
/// （L3 强停投递）。resume 额外消费调用方持有的 [RecoveryCoordinator]
/// 权威实例（预算 / fork 记录与引擎内存态同源，不另建实例防双写分裂）。
///
/// Clone 语义：字段全为 Arc（db / control），克隆 = 共享同一服务实例
/// （命令层 spawn_blocking 闭包按需 clone，D4 §3.5）。
#[derive(Clone)]
pub struct SubagentLifecycleService {
    /// 子代理行存储（session_agents 读写）
    db: Arc<LocalDb>,
    /// L3 强停投递通道（引擎侧接线）
    control: Arc<dyn ForceCancelSink>,
    /// BC03-2：子代理 run 的 AbortSignal 广播注册表（秒级物理打断工具批）
    signals: Arc<std::sync::RwLock<std::collections::HashMap<String, session_loop::safe_point::AbortSignal>>>,
}

impl SubagentLifecycleService {
    /// 新建服务
    pub fn new(db: Arc<LocalDb>, control: Arc<dyn ForceCancelSink>) -> Self {
        Self {
            db,
            control,
            signals: Arc::new(std::sync::RwLock::new(std::collections::HashMap::new())),
        }
    }

    /// 注册子代理 run 的 AbortSignal 实例
    pub fn register_signal(&self, subagent_run_id: impl Into<String>, signal: session_loop::safe_point::AbortSignal) {
        if let Ok(mut map) = self.signals.write() {
            map.insert(subagent_run_id.into(), signal);
        }
    }

    /// 注销子代理 run 的 AbortSignal 实例
    pub fn unregister_signal(&self, subagent_run_id: &str) {
        if let Ok(mut map) = self.signals.write() {
            map.remove(subagent_run_id);
        }
    }

    /// 广播触发子代理 run 的 AbortSignal（秒级打断正在运行的工具批）
    pub fn broadcast_abort(&self, subagent_run_id: &str) -> bool {
        let mut triggered = false;
        if let Ok(map) = self.signals.read() {
            if let Some(sig) = map.get(subagent_run_id) {
                sig.abort();
                triggered = true;
            }
        }
        if self.control.broadcast_abort(subagent_run_id) {
            triggered = true;
        }
        triggered
    }

    /// 数据库句柄（调用方按需复用）
    pub fn db(&self) -> Arc<LocalDb> {
        self.db.clone()
    }

    /// kill_all 引擎入口：批量终止主会话全部 running 子代理。
    ///
    /// - 过滤面：session_agents 行 parent_session_id = 主会话 且
    ///   status = running（查询扩展，agents.rs）；
    /// - 逐个对子代理 run 投递 L3 `request_force_cancel`（control.rs:319
    ///   队列面复用，reason 信封带 run 标识可观测）；
    /// - 终态统一归一 failed（写面规则同源：被终止 run 终态 = failed，
    ///   subagent.rs to_db_status 语义）；
    /// - **无递归**：maxDepth=1（T-D-01）后子代理无后代，无需递归遍历；
    /// - 产出保留：只改 status/ended_at，summary / messages / 路径原样
    ///   保留（单行定点写 update_session_agent_status，只动目标行；
    ///   回收站与 session_agent_messages 级联为既有机制，无新增）；
    /// - FlowScheduler 侧每个终态事件自然触发 on_subagent_terminal 推进
    ///   （flow_graph.rs:1121），本服务不做额外编排。
    ///
    /// 返回：终止的子代理列表 + 未终态汇总（结构化载荷，供主 Agent 编排）。
    pub fn kill_all(
        &self,
        session_id: &str,
        reason: &str,
    ) -> Result<KillAllOutcome, LifecycleError> {
        let reason = if reason.trim().is_empty() {
            "kill_all"
        } else {
            reason
        };
        // 过滤面：父会话 = 主会话 且 running
        let targets = self
            .db
            .load_session_agents_by_parent_status(session_id, "running")
            .map_err(db_err)?;
        if targets.is_empty() {
            return Ok(KillAllOutcome {
                terminated: Vec::new(),
                non_terminal: Vec::new(),
            });
        }
        // 逐个投递 L3 强停（无递归：子代理无后代，不遍历层级）
        let mut terminated = Vec::new();
        let mut non_terminal = Vec::new();
        for agent in &targets {
            self.broadcast_abort(&agent.subagent_run_id);
            let delivered = self
                .control
                .request_force_cancel(&agent.subagent_run_id, reason);
            if delivered {
                terminated.push(KilledEntry {
                    subagent_id: agent.id.clone(),
                    subagent_run_id: agent.subagent_run_id.clone(),
                });
            } else {
                non_terminal.push(NonTerminalEntry {
                    subagent_id: agent.id.clone(),
                    subagent_run_id: agent.subagent_run_id.clone(),
                    reason: "L3 强停未投递（引擎无该 run 的运行实例）".to_string(),
                });
            }
        }
        // 终态统一归一 failed（单行定点写：只动 targets 快照中的目标行，
        // 非目标行与 messages 原样保留；kill_all 期间引擎并发 spawn 的
        // 新行不再被全量先删后插覆写删除——11-T3 N05 根因收束）
        let now = now_ms();
        for agent in &targets {
            // 缺行静默成功（affected=0 不报错：目标行在投递期间被删时
            // 宽容跳过，与 save 面语义一致）
            self.db
                .update_session_agent_status(
                    session_id,
                    &agent.subagent_run_id,
                    "failed",
                    Some(now),
                )
                .map_err(db_err)?;
            // LK-07 R-14：kill 直发 subagent-ended(status=cancelled)——使
            // Cancelled 成为生产真值（引擎侧显式传，subagent_events.rs:101
            // 注释既有）；同步写面（命令层 spawn_blocking 包裹，F2-27）；
            // 收口兜底双发幂等由 spawner on_subagent_terminal「已发 ended
            // 不重发」防护承担
            self.emit_killed_ended(session_id, agent);
        }
        Ok(KillAllOutcome {
            terminated,
            non_terminal,
        })
    }

    /// kill_subagent 引擎入口（D4 §3.2）：单目标终止指定子代理。
    ///
    /// - ① 定位：会话内 (session_id, agent_id) 主键，至多一行；缺行 →
    ///   [LifecycleError::NotFound]；
    /// - ② 已终态（行非 running）→ 幂等 no-op（不投递 L3、不强写
    ///   ended_at，保留终态审计事实——restore 域 previous_status 保真
    ///   纪律同源）；
    /// - ③ L3 强停投递（复用 [ForceCancelSink]，同 kill_all 语义；
    ///   返回 false = 引擎无该 run 的运行实例，未投递）；
    /// - ④ 行归一 failed（复用 [Self::mark_row_failed]，写面与
    ///   kill_all / resume 同源）；产出保留（只改 status/ended_at）；
    /// - **无递归**：maxDepth=1（T-D-01）后子代理无后代，无需遍历层级。
    ///
    /// 三态结果：[KillSubagentResult]（killed / already_terminal /
    /// force_cancel_delivered=false 未投递汇总——单目标场景不建
    /// non_terminal 列表，布尔位够用，D4 §8 D-7）。
    pub fn kill_subagent(
        &self,
        session_id: &str,
        subagent_id: &str,
        reason: &str,
    ) -> Result<KillSubagentResult, LifecycleError> {
        let reason = if reason.trim().is_empty() {
            "kill_subagent"
        } else {
            reason
        };
        // ① 定位：会话内 (session_id, agent_id) 主键，至多一行
        let rows = self.db.load_session_agents(session_id).map_err(db_err)?;
        let Some(row) = rows.iter().find(|a| a.id == subagent_id) else {
            return Err(LifecycleError::NotFound {
                message: format!("子代理不存在：{subagent_id}（会话 {session_id}）"),
            });
        };
        let subagent_run_id = row.subagent_run_id.clone();
        // ② 已终态 → 幂等 no-op（不投递、不覆写 ended_at）
        if row.status != "running" {
            return Ok(KillSubagentResult {
                subagent_id: subagent_id.to_string(),
                subagent_run_id,
                outcome: "already_terminal",
                force_cancel_delivered: false,
            });
        }
        // ③ L3 强停投递（复用 ForceCancelSink；false = 引擎无运行实例）
        self.broadcast_abort(&subagent_run_id);
        let delivered = self.control.request_force_cancel(&subagent_run_id, reason);
        // ④ 行归一 failed（复用 mark_row_failed，单行定点写）
        self.mark_row_failed(session_id, &subagent_run_id)?;
        // LK-07 R-14：kill 直发 subagent-ended(status=cancelled)（同
        // kill_all；Cancelled 成生产真值，收口兜底双发幂等由 spawner 防护）
        self.emit_killed_ended(session_id, &row);
        Ok(KillSubagentResult {
            subagent_id: subagent_id.to_string(),
            subagent_run_id,
            outcome: "killed",
            force_cancel_delivered: delivered,
        })
    }

    /// resume_subagent 引擎命令：把子代理当前 run 显式恢复——原 run 置
    /// failed、经 [RecoveryCoordinator::fork_and_reassign]（recovery.rs:1026）
    /// fork 新 run 承接同一目标。
    ///
    /// 主体拆两段（D4 §3.5）：
    /// - [Self::prepare_resume]：同步准备段（取行 + 定位 + kill-for-resume
    ///   投递 + 任务/叶子推导 + 字节统计，纯 DB + 内存，可单测）；
    /// - [Self::resume_with_prepared]：异步 fork 段（fork_and_reassign +
    ///   行归一 failed）。
    ///
    /// 命令层可用两段式（prepare_resume 经 spawn_blocking、fork 段经
    /// coordinator 权威实例），既有调用方与测试保持本签名不变。
    pub async fn resume(
        &self,
        coordinator: &mut RecoveryCoordinator,
        session_id: &str,
        subagent_id: &str,
        prompt: Option<&str>,
    ) -> Result<ResumeOutcome, LifecycleError> {
        let ctx = self.prepare_resume(session_id, subagent_id, prompt)?;
        self.resume_with_prepared(coordinator, session_id, ctx)
            .await
    }

    /// resume 同步准备段（D4 §3.5）：加载子代理行、按 (session_id,
    /// agent_id) 主键定位、目标 run 仍 running 时先投递 L3 强停
    /// （kill-for-resume，防引擎侧存活循环的终态回写覆盖 fork 结果）、
    /// 推导任务与 fork 源叶子、统计 fork 三态字节数，构造
    /// [RunFailureContext]。
    ///
    /// 纯 DB + 内存操作（无 await），命令层经 spawn_blocking 包裹（F2-27，
    /// 同步 SQLite 调用面不落在 tokio worker 上）。
    ///
    /// - `prompt`：新任务目标（可选）；缺省从该 run 首条 user 消息推断
    ///   原任务（与恢复阶梯同操作指纹，Episode 预算共用同一池）；
    /// - history 转换（W3 契约）：row.messages → [HistoryMessage] 保真映射
    ///   由 [Self::subagent_history] 提供；[RunFailureContext.history]
    ///   字段属 D7 字段面（recovery.rs，轮 1 A5），该字段落地后此处一行
    ///   接入 `ctx.history = Some(subagent_history(current))`——两侧字段
    ///   语义同批次对齐，禁止一侧先行。
    pub fn prepare_resume(
        &self,
        session_id: &str,
        subagent_id: &str,
        prompt: Option<&str>,
    ) -> Result<RunFailureContext, LifecycleError> {
        let rows = self.db.load_session_agents(session_id).map_err(db_err)?;
        // 会话内子代理行以 (session_id, agent_id) 为主键，至多一行；
        // 缺行 → 不存在
        let Some(current) = rows.iter().find(|a| a.id == subagent_id) else {
            return Err(LifecycleError::NotFound {
                message: format!("子代理不存在：{subagent_id}（会话 {session_id}）"),
            });
        };
        let current_run_id = current.subagent_run_id.clone();
        // 目标 run 仍 running：先投递 L3 强停（kill-for-resume），终止存活
        // 循环，防其终态回写覆盖 fork 结果
        if current.status == "running" {
            self.broadcast_abort(&current_run_id);
            self.control
                .request_force_cancel(&current_run_id, "resume-subagent");
        }
        // 任务目标：显式 prompt 优先；缺省从 run 消息推断原任务——LK-07
        // R-14 改源（derive_task 以子代理独立会话消息 / session_agent_messages
        // 为推断源，见 derive_task 注释；原「恒空 messages 列」假承诺消灭）
        let task = match prompt.map(str::trim).filter(|p| !p.is_empty()) {
            Some(p) => p.to_string(),
            None => derive_task(&self.db, current).ok_or_else(|| LifecycleError::InvalidState {
                message: format!(
                    "无法推断子代理 {subagent_id}（run {current_run_id}）的原任务：\
                     子代理会话与消息表均无 user 消息，请显式提供 prompt 参数"
                ),
            })?,
        };
        // 源叶子：工作流路径末元素（subagent_path_json = 根 → 叶 id 数组）
        let from_leaf_id =
            leaf_from_path(current.subagent_path_json.as_deref()).ok_or_else(|| {
                LifecycleError::InvalidState {
                    message: format!(
                        "子代理 {subagent_id}（run {current_run_id}）缺少工作流路径\
                     （subagent_path_json），无法确定 fork 源叶子——resume 仅对\
                     恢复阶梯 fork 出的 run 可用（fork 路径落库且树节点存在），\
                     普通 spawn 的 run 无树节点，不支持 resume"
                    ),
                }
            })?;
        // fork 三态字节数：注入内容 = 该 run 消息字节；会话窗口 = 全会话
        // 子代理消息字节（decide_fork_context 输入）
        let inject_bytes = content_bytes(&current.messages);
        let window_bytes: u64 = rows.iter().map(|a| content_bytes(&a.messages)).sum();
        Ok(RunFailureContext {
            subagent_id: subagent_id.to_string(),
            subagent_run_id: current_run_id.clone(),
            task: task.clone(),
            // resume 是显式命令面，非错误上行：错误分类用占位值
            // （fork_and_reassign 不消费该字段）
            error_kind: ProviderErrorKind::Unknown,
            retries: 0,
            retry_elapsed_ms: 0,
            produced_content: false,
            from_leaf_id: Some(from_leaf_id),
            started_at_ms: current.started_at,
            inject_bytes,
            window_bytes,
        })
    }

    /// resume 异步 fork 段（D4 §3.5）：消费 [Self::prepare_resume] 的
    /// 准备结果，经调用方持有的 [RecoveryCoordinator] 权威实例 fork 新
    /// run 承接同一目标。
    ///
    /// - `coordinator`：会话的恢复协调器（引擎侧持有的权威实例，预算 /
    ///   fork 记录与其内存态同源——不另建实例，防双写分裂）；
    /// - 幂等：同指纹同源 run 已 fork 过 → 返回既有 ForkRecord（不重复
    ///   spawn，语义见 recovery.rs fork_and_reassign）；
    /// - Episode 预算耗尽 → [ResumeOutcome::NeedsUser]（阶梯 4，不产生
    ///   fork）。
    pub async fn resume_with_prepared(
        &self,
        coordinator: &mut RecoveryCoordinator,
        session_id: &str,
        ctx: RunFailureContext,
    ) -> Result<ResumeOutcome, LifecycleError> {
        let current_run_id = ctx.subagent_run_id.clone();
        let outcome = coordinator
            .fork_and_reassign(&ctx)
            .await
            .map_err(LifecycleError::Recovery)?;
        match outcome.action {
            RecoveryAction::Forked { record } => {
                // 原 run 置 failed（session_agents 行归一，与写面规则同源：
                // 被终止 run 终态 = failed）；新 run 行由引擎 spawner 落库。
                // 同步 SQLite 单行写：命令层按 F2-27 以 spawn_blocking 包裹。
                self.mark_row_failed(session_id, &current_run_id)?;
                Ok(ResumeOutcome::Forked(record))
            }
            RecoveryAction::NeedsUser { report } => {
                // Episode 预算耗尽 → 阶梯 4：需用户介入，不产生 fork
                Ok(ResumeOutcome::NeedsUser(report))
            }
            other => Err(LifecycleError::InvalidState {
                message: format!("resume 意外落阶：{other:?}"),
            }),
        }
    }

    /// 把子代理行终态归一 failed（ended_at 缺省补当前时间）。
    ///
    /// kill_all / resume 共用；单行定点写（update_session_agent_status），
    /// 不改动其余字段（summary / messages / 路径等产出保留）；
    /// 缺行按 affected=0 判定 NotFound。
    fn mark_row_failed(
        &self,
        session_id: &str,
        subagent_run_id: &str,
    ) -> Result<(), LifecycleError> {
        let affected = self
            .db
            .update_session_agent_status(session_id, subagent_run_id, "failed", Some(now_ms()))
            .map_err(db_err)?;
        if affected == 0 {
            return Err(LifecycleError::NotFound {
                message: format!("子代理 run 不存在：{subagent_run_id}（会话 {session_id}）"),
            });
        }
        Ok(())
    }

    /// kill 直发 `subagent-ended(status=cancelled)`（LK-07 R-14：使 Cancelled
    /// 成为生产真值——引擎侧显式传，subagent_events.rs:101 注释既有；
    /// 此前 Cancelled 生产不可达，前端 stopped 映射恒空转）。
    ///
    /// **同步写面**（kill_all/kill_subagent 是同步命令层，F2-27 以
    /// spawn_blocking 包裹）：经 LocalDb 直写（reserve_sequence +
    /// append_event），与 [crate::persist::LocalDbStore] 的持久化逻辑同构
    /// （信封 runId = 父 run，与 spawner/FlowScheduler 发射面一致，DM-04
    /// 归属性统一）。
    ///
    /// **双发幂等**：本直发后引擎侧 run 收口（spawner on_subagent_terminal）
    /// 仍会走一遍终态兜底——防护按「该 run 已落库 subagent-ended 事件则不
    /// 重发」在 spawner 收口面落地，此处不重复防重（单点职责）。
    ///
    /// 失败语义：仅告警不阻断（事件是观测增强，kill 行归一已成功；与
    /// spawner 发射面失败仅告警对齐）。
    fn emit_killed_ended(&self, session_id: &str, agent: &SessionAgent) {
        let Ok(sequence) = self.db.reserve_sequence(session_id) else {
            tracing::warn!(target: "lifecycle", "kill 直发取号失败（跳过 subagent-ended）");
            return;
        };
        let info = SubagentEndedInfo {
            subagent_id: agent.id.clone(),
            subagent_run_id: agent.subagent_run_id.clone(),
            status: SubagentEndStatus::Cancelled,
            summary: None,
            // LK-04 反向导航键：随行值透传（None = 旧行/未接线，前端回退行级反查）
            subagent_session_id: agent.sub_session_id.clone(),
        };
        let ctx = SubagentEmitContext {
            session_id: session_id.to_string(),
            parent_run_id: agent.parent_run_id.clone(),
        };
        let envelope = normalize_envelope(
            AgentEventEnvelope::new(
                build_subagent_ended(&ctx, &info),
                Some(agent.parent_run_id.clone()),
                Some(sequence as u64),
            ),
            Some(&agent.parent_run_id),
            session_id,
        );
        let Ok(payload) = serde_json::to_string(&envelope) else {
            tracing::warn!(target: "lifecycle", "kill 直发信封序列化失败（跳过 subagent-ended）");
            return;
        };
        if let Err(error) = self.db.append_event(
            session_id,
            sequence,
            "subagent-ended",
            &payload,
            Some(&agent.parent_run_id),
        ) {
            tracing::warn!(
                target: "lifecycle",
                event = "kill_ended_persist_failed",
                subagent_run_id = %agent.subagent_run_id,
                error = %error,
                "kill 直发 subagent-ended 落库失败（仅告警）"
            );
        }
    }
}

/// 从子代理行推断原任务（LK-07 R-14 重设计：真实持久化轨优先，消灭
/// 「恒空 messages 列」假承诺——spawn 落库行 messages 恒空，原实现
/// 依赖该列导致 resume 缺省任务恒不可得）：
///
/// 1. **首选子代理独立会话消息**（row.sub_session_id → session_messages，
///    子代理 run 消息的真实写入轨：spawner 装配独立会话，run 消息随
///    正常消息链路落该会话）；
/// 2. **兜底 session_agent_messages**（row.messages——load_session_agents
///    从该表加载，前端 save 面写入轨）。
///
/// 两轨皆空 → None（resume 缺省任务不可得，调用方按 InvalidState 上抛
/// 并要求显式 prompt）。首条 user 消息即任务 prompt 的落库形态。
fn derive_task(db: &LocalDb, row: &SessionAgent) -> Option<String> {
    if let Some(sub_sess) = row.sub_session_id.as_deref().filter(|s| !s.is_empty()) {
        if let Ok(messages) = db.load_session_body(sub_sess) {
            if let Some(task) = first_user_text(&messages) {
                return Some(task);
            }
        }
    }
    first_user_text(&row.messages)
}

/// 消息列表首条 user 消息文本（trim 非空才有效）
fn first_user_text(messages: &[SessionMessage]) -> Option<String> {
    messages
        .iter()
        .find(|m| m.sender == "user")
        .and_then(|m| m.text.as_deref())
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
}

/// 工作流路径末元素（subagent_path_json = 根 → 叶 id 数组；fork 源叶子；
/// 缺失 / 坏 JSON → None）
fn leaf_from_path(path_json: Option<&str>) -> Option<String> {
    let path: Vec<String> = serde_json::from_str(path_json?).ok()?;
    path.last().cloned()
}

/// 消息文本字节数合计（fork 三态判定的字节输入）
fn content_bytes(messages: &[SessionMessage]) -> u64 {
    messages
        .iter()
        .filter_map(|m| m.text.as_deref())
        .map(|t| t.len() as u64)
        .sum()
}

/// W3 契约（D7 history 扩展，02 定夺 §二 W3）：子代理行消息 → 历史回流
/// 消息的保真映射。
///
/// [HistoryMessage] 与 [SessionMessage] 1:1（history.rs:17 字段一一对应），
/// 本转换供 resume 路径的 Verbatim 上下文继承使用——新 run 以原 run 消息
/// 作 history（比摘要更便宜更基础，spawner `history: None` 缺口
/// subagent_spawner.rs:364-365 的填充数据源）。
///
/// [RunFailureContext.history] 字段属 D7 字段面（recovery.rs，与 D3 装配
/// 表同批次对齐，禁止一侧先行）；字段落地后 [Self::prepare_resume] 以
/// `Some(Self::subagent_history(row))` 一行接入。本函数独立暴露以便单测。
///
/// 接线状态：已确认接线计划——D7 字段占位已实现，待 recovery.rs RunFailureContext.history
/// 字段落地后以 `ctx.history = Some(subagent_history(current))` 一行接入；当前占位保留，
/// 跟随 D7 实现轮（追踪：backend-optimization Q10-D7）。
pub fn subagent_history(row: &SessionAgent) -> Vec<HistoryMessage> {
    row.messages
        .iter()
        .map(|m| HistoryMessage {
            id: m.id.clone(),
            sender: m.sender.clone(),
            text: m.text.clone(),
            thinking: m.thinking.clone(),
            blocks_json: m.blocks_json.clone(),
            tool_calls_json: m.tool_calls_json.clone(),
            tool_call_results_json: m.tool_call_results_json.clone(),
            status: m.status.clone(),
            timestamp: m.timestamp,
        })
        .collect()
}

/// 数据库失败 → 生命周期错误
fn db_err(e: DbFailure) -> LifecycleError {
    LifecycleError::PersistFailed {
        message: e.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MockSink {
        aborted_runs: std::sync::Mutex<Vec<String>>,
    }

    impl ForceCancelSink for MockSink {
        fn request_force_cancel(&self, _subagent_run_id: &str, _reason: &str) -> bool {
            true
        }
        fn broadcast_abort(&self, subagent_run_id: &str) -> bool {
            self.aborted_runs.lock().unwrap().push(subagent_run_id.to_string());
            true
        }
    }

    #[test]
    fn test_broadcast_abort_triggers_signal_and_sink() {
        let db = Arc::new(LocalDb::open_in_memory().unwrap());
        let sink = Arc::new(MockSink {
            aborted_runs: std::sync::Mutex::new(Vec::new()),
        });
        let service = SubagentLifecycleService::new(db, sink.clone());

        let signal = session_loop::safe_point::AbortSignal::new();
        assert!(!signal.is_aborted());

        service.register_signal("sub-run-123", signal.clone());
        let triggered = service.broadcast_abort("sub-run-123");
        assert!(triggered);
        assert!(signal.is_aborted(), "AbortSignal should be triggered");
        assert_eq!(
            sink.aborted_runs.lock().unwrap().as_slice(),
            &["sub-run-123"]
        );

        // unregister
        service.unregister_signal("sub-run-123");
        let signal2 = session_loop::safe_point::AbortSignal::new();
        service.register_signal("sub-run-456", signal2.clone());
        service.broadcast_abort("sub-run-123");
        assert!(!signal2.is_aborted());
    }
}
