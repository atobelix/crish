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
//!   自动重试仍优先（recovery.rs:198-236），resume 供主 Agent/用户手动兜底。
//!
//! 稳定域纪律：本模块只消费 [crate::recovery] 与 session-loop control.rs
//! 的既有公共面（L0-L3 协议 / fork 算法 / Episode 预算本体零改动）；
//! 引擎侧接线（ForceCancelSink 实现 = 按 run 定位 ControlBus 投递）在
//! workbench 域（T-D-13），本模块不感知具体总线实例。

use std::fmt;
use std::sync::Arc;

use conex_db::{DbFailure, LocalDb};
use conex_types::error::ProviderErrorKind;
use conex_types::{SessionAgent, SessionMessage};

use crate::now_ms;
use crate::recovery::{
    ForkRecord, RecoveryAction, RecoveryCoordinator, RecoveryError, RunFailureContext, UserReport,
};

/// L3 强停投递抽象（引擎侧实现：按 subagent_run_id 定位该 run 的控制总线，
/// 调 [session_loop::control::ControlBus::request_force_cancel]——control.rs:319
/// 队列面复用）。
///
/// 返回 false = 引擎内无该 run 的运行实例（无法投递，如重启后未恢复的
/// run），调用方按未终态汇总处理。
pub trait ForceCancelSink: Send + Sync {
    /// 向目标子代理 run 投递 L3 强停
    fn request_force_cancel(&self, subagent_run_id: &str, reason: &str) -> bool;
}

/// 已终止子代理条目（L3 强停投递成功）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KilledEntry {
    /// 子代理 id（session_agents.agent_id）
    pub subagent_id: String,
    /// 子代理 run id
    pub subagent_run_id: String,
}

/// 未终态汇总条目（L3 强停未投递）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NonTerminalEntry {
    /// 子代理 id
    pub subagent_id: String,
    /// 子代理 run id
    pub subagent_run_id: String,
    /// 未投递原因（结构化文案，供主 Agent 编排核实）
    pub reason: String,
}

/// kill_all 结果载荷（结构化，供主 Agent 编排：已终止列表 + 未终态汇总）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KillAllOutcome {
    /// 已终止的子代理（L3 强停投递成功 + 行归一 failed）
    pub terminated: Vec<KilledEntry>,
    /// 未终态汇总：L3 未投递（引擎无该 run 的运行实例）——行已归一
    /// failed，但 run 可能仍存活在引擎内存中，主 Agent 需核实或重试
    pub non_terminal: Vec<NonTerminalEntry>,
}

/// resume_subagent 结果
#[derive(Debug, Clone, PartialEq)]
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
pub struct SubagentLifecycleService {
    /// 子代理行存储（session_agents 读写）
    db: Arc<LocalDb>,
    /// L3 强停投递通道（引擎侧接线）
    control: Arc<dyn ForceCancelSink>,
}

impl SubagentLifecycleService {
    /// 新建服务
    pub fn new(db: Arc<LocalDb>, control: Arc<dyn ForceCancelSink>) -> Self {
        Self { db, control }
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
            let delivered = self.control.request_force_cancel(&agent.subagent_run_id, reason);
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
        }
        Ok(KillAllOutcome {
            terminated,
            non_terminal,
        })
    }

    /// resume_subagent 引擎命令：把子代理当前 run 显式恢复——原 run 置
    /// failed、经 [RecoveryCoordinator::fork_and_reassign]（recovery.rs:1026）
    /// fork 新 run 承接同一目标。
    ///
    /// - `coordinator`：会话的恢复协调器（引擎侧持有的权威实例，预算 /
    ///   fork 记录与其内存态同源——不另建实例，防双写分裂）；
    /// - `prompt`：新任务目标（可选）；缺省从该 run 首条 user 消息推断
    ///   原任务（与恢复阶梯同操作指纹，Episode 预算共用同一池）；
    /// - 上下文继承：注入内容 = 该 run 消息字节、会话窗口 = 全会话子代理
    ///   消息字节，走 decide_fork_context 三态（≤24h + ≤80% → Verbatim；
    ///   超限 Summarized；空内容 New）；
    /// - 目标 run 仍 running 时先投递 L3 强停（kill-for-resume），防引擎
    ///   侧存活循环的终态回写覆盖 fork 结果；
    /// - 幂等：同指纹同源 run 已 fork 过 → 返回既有 ForkRecord（不重复
    ///   spawn，语义见 recovery.rs fork_and_reassign）；
    /// - Episode 预算耗尽 → [ResumeOutcome::NeedsUser]（阶梯 4，不产生
    ///   fork）。
    pub async fn resume(
        &self,
        coordinator: &mut RecoveryCoordinator,
        session_id: &str,
        subagent_id: &str,
        prompt: Option<&str>,
    ) -> Result<ResumeOutcome, LifecycleError> {
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
            self.control
                .request_force_cancel(&current_run_id, "resume-subagent");
        }
        // 任务目标：显式 prompt 优先；缺省从 run 首条 user 消息推断原任务
        let task = match prompt.map(str::trim).filter(|p| !p.is_empty()) {
            Some(p) => p.to_string(),
            None => derive_task(current).ok_or_else(|| LifecycleError::InvalidState {
                message: format!(
                    "无法推断子代理 {subagent_id}（run {current_run_id}）的原任务：\
                     该 run 无 user 消息，请显式提供 prompt 参数"
                ),
            })?,
        };
        // 源叶子：工作流路径末元素（subagent_path_json = 根 → 叶 id 数组）
        let from_leaf_id = leaf_from_path(current.subagent_path_json.as_deref())
            .ok_or_else(|| LifecycleError::InvalidState {
                message: format!(
                    "子代理 {subagent_id}（run {current_run_id}）缺少工作流路径\
                     （subagent_path_json），无法确定 fork 源叶子"
                ),
            })?;
        // fork 三态字节数：注入内容 = 该 run 消息字节；会话窗口 = 全会话
        // 子代理消息字节（decide_fork_context 输入）
        let inject_bytes = content_bytes(&current.messages);
        let window_bytes: u64 = rows.iter().map(|a| content_bytes(&a.messages)).sum();
        let ctx = RunFailureContext {
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
        };
        let outcome = coordinator
            .fork_and_reassign(&ctx)
            .await
            .map_err(LifecycleError::Recovery)?;
        match outcome.action {
            RecoveryAction::Forked { record } => {
                // 原 run 置 failed（session_agents 行归一，与写面规则同源：
                // 被终止 run 终态 = failed）；新 run 行由引擎 spawner 落库
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
            .update_session_agent_status(
                session_id,
                subagent_run_id,
                "failed",
                Some(now_ms()),
            )
            .map_err(db_err)?;
        if affected == 0 {
            return Err(LifecycleError::NotFound {
                message: format!("子代理 run 不存在：{subagent_run_id}（会话 {session_id}）"),
            });
        }
        Ok(())
    }
}

/// 从子代理行推断原任务：首条 user 消息文本（子代理会话的首条 user
/// 消息即任务 prompt 的落库形态；resume 缺省任务来源）
fn derive_task(row: &SessionAgent) -> Option<String> {
    row.messages
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

/// 数据库失败 → 生命周期错误
fn db_err(e: DbFailure) -> LifecycleError {
    LifecycleError::PersistFailed {
        message: e.to_string(),
    }
}
