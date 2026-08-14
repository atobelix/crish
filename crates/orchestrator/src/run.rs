//! run 生命周期管理（任务书 B4.1）
//!
//! 状态机对齐 packages/agent-core/src/state-machine/run-lifecycle.ts：
//! `queued → initializing → running → awaiting-approval → cancelling →
//! completed/failed/cancelled`（completing 为收尾中间态），终态拒绝再转移。
//!
//! 生命周期 API：
//! - [RunManager::start_run]：注册 + 落库（insert_run），queued → running；
//! - [RunHandle::request_approval] / [RunHandle::resolve_approval]：
//!   审批挂起（awaiting-approval 中间态）与批准恢复（回 running → completed）；
//! - [RunHandle::cancel_run]：三路径——L2 协作（不 hard abort，等待安全点
//!   收场 stopped）、L3 强制（hard abort）、模式回落（引擎不支持 L2 时按
//!   L3 执行，mode=cooperative-fallback-force，05 §2.8）；
//! - [RunHandle::finalize]：收口到终态（run-terminal 由事件队列发出且
//!   唯一一次，B4.2 配合）。
//!
//! run 记录落库复用 conex-db（insert_run / update_run_status，经
//! [crate::persist::Store] 抽象）。
//!
//! 分歧约束：00 D1（cooperative stop 的 run 终态不触发自动续轮——收口
//! 映射见 [map_outcome_to_terminal]；会话层续轮裁决不在本模块范围）。

use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;
use conex_db::RunStatus;
use conex_types::events::RunTerminalStatus;
use conex_types::session::AgentEndReason;

use crate::persist::{Store, StoreError};
use crate::now_ms;

/// run 生命周期事件（对齐 run-lifecycle.ts 的 RunLifecycleEvent）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunLifecycleEvent {
    /// queued → initializing（run 启动）
    Start,
    /// initializing → running（运行时就绪）
    RuntimeReady,
    /// initializing → failed（初始化失败）
    InitError,
    /// running → awaiting-approval（审批挂起）
    ApprovalRequested,
    /// awaiting-approval → running（审批恢复）
    ApprovalResolved,
    /// 取消请求（进入 cancelling 中间态）
    CancelRequested,
    /// cancelling → cancelled（取消确认）
    CancelConfirmed,
    /// running → completing（agent 自然停止）
    AgentStop,
    /// running → completing（轮次预算用尽）
    MaxTurnsReached,
    /// running → completing（goal 完成）
    GoalComplete,
    /// 运行期错误 → failed
    RuntimeError,
    /// completing → completed（收尾完成）
    Finalized,
    /// completing → failed（收尾失败）
    FinalizeError,
    /// 强制中断（queued/initializing/running/awaiting-approval → failed；
    /// cancelling → cancelled；completing → failed）
    ForceInterrupt,
}

impl RunLifecycleEvent {
    /// 事件名（状态机错误信息用，对齐 TS 的 SCREAMING_SNAKE_CASE）
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Start => "START",
            Self::RuntimeReady => "RUNTIME_READY",
            Self::InitError => "INIT_ERROR",
            Self::ApprovalRequested => "APPROVAL_REQUESTED",
            Self::ApprovalResolved => "APPROVAL_RESOLVED",
            Self::CancelRequested => "CANCEL_REQUESTED",
            Self::CancelConfirmed => "CANCEL_CONFIRMED",
            Self::AgentStop => "AGENT_STOP",
            Self::MaxTurnsReached => "MAX_TURNS_REACHED",
            Self::GoalComplete => "GOAL_COMPLETE",
            Self::RuntimeError => "RUNTIME_ERROR",
            Self::Finalized => "FINALIZED",
            Self::FinalizeError => "FINALIZE_ERROR",
            Self::ForceInterrupt => "FORCE_INTERRUPT",
        }
    }
}

/// 状态机转移错误
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransitionError {
    /// 当前状态
    pub from: RunStatus,
    /// 被拒绝的事件名
    pub event: &'static str,
}

impl fmt::Display for TransitionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "状态机拒绝转移：{} + {}", self.from, self.event)
    }
}

impl std::error::Error for TransitionError {}

/// run 生命周期状态机（9 态，复用 conex-db 的 [RunStatus]）
///
/// 转移表对齐 run-lifecycle.ts 的 RUN_LIFECYCLE_DEFINITION：
/// - 终态（completed / failed / cancelled）拒绝任何再转移；
/// - 未定义转移显式失败（防御性，状态机一致性约束）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunStateMachine {
    state: RunStatus,
}

impl RunStateMachine {
    /// 从初始状态构建状态机
    pub fn new(initial: RunStatus) -> Self {
        Self { state: initial }
    }

    /// 当前状态
    pub fn state(&self) -> RunStatus {
        self.state.clone()
    }

    /// 是否已到终态（completed / failed / cancelled；Unknown 显式排除——
    /// 死态不可迁移、不属于三终态，由 [Self::transition] 拒绝一切事件）
    pub fn is_terminal(&self) -> bool {
        matches!(
            self.state,
            RunStatus::Completed | RunStatus::Failed | RunStatus::Cancelled
        )
    }

    /// 应用转移；成功返回新状态，终态与未定义转移显式失败
    pub fn transition(&mut self, event: RunLifecycleEvent) -> Result<RunStatus, TransitionError> {
        let next = match (&self.state, event) {
            (RunStatus::Queued, RunLifecycleEvent::Start) => RunStatus::Initializing,
            (RunStatus::Queued, RunLifecycleEvent::CancelRequested) => RunStatus::Cancelling,
            (RunStatus::Queued, RunLifecycleEvent::CancelConfirmed) => RunStatus::Cancelled,
            (RunStatus::Queued, RunLifecycleEvent::ForceInterrupt) => RunStatus::Failed,
            (RunStatus::Initializing, RunLifecycleEvent::RuntimeReady) => RunStatus::Running,
            (RunStatus::Initializing, RunLifecycleEvent::InitError) => RunStatus::Failed,
            (RunStatus::Initializing, RunLifecycleEvent::CancelRequested) => RunStatus::Cancelling,
            (RunStatus::Initializing, RunLifecycleEvent::CancelConfirmed) => RunStatus::Cancelled,
            (RunStatus::Initializing, RunLifecycleEvent::ForceInterrupt) => RunStatus::Failed,
            (RunStatus::Running, RunLifecycleEvent::ApprovalRequested) => RunStatus::AwaitingApproval,
            (RunStatus::Running, RunLifecycleEvent::AgentStop) => RunStatus::Completing,
            (RunStatus::Running, RunLifecycleEvent::MaxTurnsReached) => RunStatus::Completing,
            (RunStatus::Running, RunLifecycleEvent::GoalComplete) => RunStatus::Completing,
            (RunStatus::Running, RunLifecycleEvent::CancelRequested) => RunStatus::Cancelling,
            (RunStatus::Running, RunLifecycleEvent::RuntimeError) => RunStatus::Failed,
            (RunStatus::Running, RunLifecycleEvent::ForceInterrupt) => RunStatus::Failed,
            (RunStatus::AwaitingApproval, RunLifecycleEvent::ApprovalResolved) => RunStatus::Running,
            (RunStatus::AwaitingApproval, RunLifecycleEvent::CancelRequested) => RunStatus::Cancelling,
            (RunStatus::AwaitingApproval, RunLifecycleEvent::RuntimeError) => RunStatus::Failed,
            (RunStatus::AwaitingApproval, RunLifecycleEvent::ForceInterrupt) => RunStatus::Failed,
            (RunStatus::Cancelling, RunLifecycleEvent::CancelConfirmed) => RunStatus::Cancelled,
            (RunStatus::Cancelling, RunLifecycleEvent::RuntimeError) => RunStatus::Failed,
            (RunStatus::Cancelling, RunLifecycleEvent::ForceInterrupt) => RunStatus::Cancelled,
            (RunStatus::Completing, RunLifecycleEvent::Finalized) => RunStatus::Completed,
            (RunStatus::Completing, RunLifecycleEvent::FinalizeError) => RunStatus::Failed,
            (RunStatus::Completing, RunLifecycleEvent::ForceInterrupt) => RunStatus::Failed,
            // 终态拒绝任何转移（05 §2.8：终态拒绝再转移）
            (RunStatus::Completed | RunStatus::Failed | RunStatus::Cancelled, _) => {
                return Err(TransitionError {
                    from: self.state.clone(),
                    event: event.as_str(),
                });
            }
            // Unknown 为死态（裁决 D3）：任何事件一律拒绝迁移，保真滞留
            (RunStatus::Unknown(_), _) => {
                return Err(TransitionError {
                    from: self.state.clone(),
                    event: event.as_str(),
                });
            }
            // 未定义转移显式失败
            _ => {
                return Err(TransitionError {
                    from: self.state.clone(),
                    event: event.as_str(),
                });
            }
        };
        self.state = next.clone();
        Ok(next)
    }
}

/// 取消模式（03 §3.2 core_cancel_run 的 mode 参数）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelMode {
    /// L2 协作停止（不 hard abort）
    Cooperative,
    /// L3 强制取消（hard abort）
    Force,
}

/// 实际执行的取消路径（05 §2.8：L2/L3/回落）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelPath {
    /// L2：协作停止注入成功，无 hard abort
    Cooperative,
    /// L3：强制 hard abort
    Force,
    /// 请求协作但引擎不支持 L2 → 回落 L3（mode=cooperative-fallback-force）
    CooperativeFallbackForce,
}

/// 取消请求记录（路径 + 原因）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CancelRequest {
    /// 实际执行的取消路径
    pub path: CancelPath,
    /// 取消原因（如 cancelled-by-user）
    pub reason: String,
}

/// run 引擎取消接口（对齐 task-executor.ts 的 ActiveRun.engine）
///
/// - L2：request_cooperative_stop 注入协作停止意图（ControlBus），不打断
///   当前流，安全点生效后以 stopped 收场（05 §2.8：不 hard abort）；
/// - L3：abort 硬中断 provider（hard abort）。
#[async_trait]
pub trait RunEngine: Send + Sync {
    /// 协作停止注入；返回 false 表示引擎不支持 L2（调用方回落 L3 强制）
    fn request_cooperative_stop(&self, reason: &str) -> bool;
    /// 强制中断（hard abort provider）
    fn abort(&self, reason: &str);
}

/// run 生命周期错误
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunError {
    /// 状态机拒绝转移（未定义转移）
    Transition(TransitionError),
    /// 终态不可再转移（终态事件已发出 / 已到终态）
    TerminalImmutable,
    /// 存储层错误
    Store(StoreError),
}

impl fmt::Display for RunError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RunError::Transition(err) => write!(f, "run 转移失败：{err}"),
            RunError::TerminalImmutable => write!(f, "run 已到终态，拒绝再转移"),
            RunError::Store(err) => write!(f, "run 存储失败：{err}"),
        }
    }
}

impl std::error::Error for RunError {}

/// run 句柄（B4.1：runId 生命周期）
///
/// status 复用 conex-db 的 [RunStatus] 9 态；cursor 为事件序列游标
/// （B4.2 由事件队列维护，已分配的最大 sequence）。
#[derive(Debug, Clone)]
pub struct RunHandle {
    /// run 标识
    pub run_id: String,
    /// 会话标识
    pub session_id: String,
    /// 当前状态（状态机镜像）
    pub status: RunStatus,
    /// 创建时间（epoch ms）
    pub created_at: i64,
    /// 最近更新时间（epoch ms）
    pub updated_at: i64,
    /// 事件序列游标（已分配的最大 sequence；0 = 尚未分配）
    pub cursor: u64,
    /// 终态 end_reason（stop / max-turns / error / aborted /
    /// event-store-write-failed）
    pub end_reason: Option<String>,
    /// 终态错误文案（failed 收场时）
    pub error: Option<String>,
    /// 状态机（内部持有，status 为其镜像）
    machine: RunStateMachine,
    /// run-terminal 是否已发出（终态事件唯一性，03 §5.2-2）
    terminal_sent: bool,
    /// 取消请求记录（None = 未取消）
    cancel: Option<CancelRequest>,
}

/// 事件存储写失败的 end_reason（05 §2.8 / 05 §3.4：不假装可回放）
pub const EVENT_STORE_WRITE_FAILED_REASON: &str = "event-store-write-failed";

impl RunHandle {
    /// 从初始状态构建句柄（注册落库由 [RunManager::start_run] 负责）
    pub fn new(run_id: &str, session_id: &str, initial: RunStatus) -> Self {
        let now = now_ms();
        Self {
            run_id: run_id.to_string(),
            session_id: session_id.to_string(),
            status: initial.clone(),
            created_at: now,
            updated_at: now,
            cursor: 0,
            end_reason: None,
            error: None,
            machine: RunStateMachine::new(initial.clone()),
            terminal_sent: false,
            cancel: None,
        }
    }

    /// 是否已到终态
    pub fn is_terminal(&self) -> bool {
        self.machine.is_terminal()
    }

    /// run-terminal 是否已发出（终态唯一性）
    pub fn terminal_sent(&self) -> bool {
        self.terminal_sent
    }

    /// 是否已请求取消（L2/L3 均置位）
    pub fn cancel_requested(&self) -> bool {
        self.cancel.is_some()
    }

    /// 实际执行的取消路径
    pub fn cancel_path(&self) -> Option<CancelPath> {
        self.cancel.as_ref().map(|request| request.path)
    }

    /// 取消原因
    pub fn cancel_reason(&self) -> Option<&str> {
        self.cancel.as_ref().map(|request| request.reason.as_str())
    }

    /// 状态机转移并落库（终态拒绝再转移；中间转移不覆盖 end_reason，
    /// 也不写 cursor——游标仅在终态写点落库，T08.4）
    ///
    /// F-005 touch 接线：非终态转移落库后刷新会话 `updated_at`（孤儿清理
    /// 宽限期随 run 活动重新起算——引擎侧会话不依赖前端 persist 顺带）。
    /// 刷新窗口 = 「启动 → 终态」活跃期：终态转移（含 finalize 链最后一
    /// 跳与终态记录改写）不 touch，终态落库后停止刷新。
    pub async fn transition(
        &mut self,
        store: &dyn Store,
        event: RunLifecycleEvent,
    ) -> Result<(), RunError> {
        if self.machine.is_terminal() {
            return Err(RunError::TerminalImmutable);
        }
        let next = self.machine.transition(event).map_err(RunError::Transition)?;
        store
            .update_run_status(&self.run_id, next.clone(), None, None)
            .await
            .map_err(RunError::Store)?;
        self.status = next;
        self.updated_at = now_ms();
        // F-005：活跃期（非终态）转移落库后 touch 会话；终态转移不 touch
        // （machine 已推进到新状态，is_terminal 即新状态判据）
        if !self.machine.is_terminal() {
            store
                .touch_session(&self.session_id)
                .await
                .map_err(RunError::Store)?;
        }
        Ok(())
    }

    /// 审批挂起（running → awaiting-approval，B4.1）
    pub async fn request_approval(&mut self, store: &dyn Store) -> Result<(), RunError> {
        self.transition(store, RunLifecycleEvent::ApprovalRequested).await
    }

    /// 审批恢复（awaiting-approval → running；批准后回 running → completed）
    pub async fn resolve_approval(&mut self, store: &dyn Store) -> Result<(), RunError> {
        self.transition(store, RunLifecycleEvent::ApprovalResolved).await
    }

    /// 取消 run 三路径（B4.1 验收：L2 协作不 hard abort；L3 强制 hard
    /// abort；引擎不支持 L2 回落 L3，mode=cooperative-fallback-force）
    ///
    /// 返回实际执行的 [CancelPath]。终态 run 拒绝取消。
    pub async fn cancel_run(
        &mut self,
        mode: CancelMode,
        engine: Option<&dyn RunEngine>,
        reason: &str,
        store: &dyn Store,
    ) -> Result<CancelPath, RunError> {
        match mode {
            CancelMode::Cooperative => {
                // L2：引擎支持协作停止 → 注入意图，不 hard abort，
                // 等待安全点以 stopped 收场
                if let Some(engine) = engine {
                    if engine.request_cooperative_stop(reason) {
                        self.transition(store, RunLifecycleEvent::CancelRequested).await?;
                        self.cancel = Some(CancelRequest {
                            path: CancelPath::Cooperative,
                            reason: reason.to_string(),
                        });
                        return Ok(CancelPath::Cooperative);
                    }
                }
                // 模式回落：引擎不支持 L2 → 按 L3 强制
                self.cancel_force(engine, reason, store, CancelPath::CooperativeFallbackForce)
                    .await
            }
            CancelMode::Force => {
                self.cancel_force(engine, reason, store, CancelPath::Force).await
            }
        }
    }

    /// L3 强制路径（含回落）：cancelling 中间态 + hard abort
    async fn cancel_force(
        &mut self,
        engine: Option<&dyn RunEngine>,
        reason: &str,
        store: &dyn Store,
        path: CancelPath,
    ) -> Result<CancelPath, RunError> {
        self.transition(store, RunLifecycleEvent::CancelRequested).await?;
        if let Some(engine) = engine {
            engine.abort(reason);
        }
        self.cancel = Some(CancelRequest {
            path,
            reason: reason.to_string(),
        });
        Ok(path)
    }

    /// 收口到终态（B4.1：终态拒绝再转移；run-terminal 由调用方经事件队列
    /// 发出，本方法保证终态记录只写一次）
    ///
    /// `terminal_cursor` 为该 run 最后已分配 sequence（T08.4：终态游标 =
    /// run-terminal 事件 sequence；由调用方在终态事件发出后传入）。
    ///
    /// 转移链按当前状态选择（对齐 run-lifecycle.ts）：
    /// - completed：running →(AgentStop) completing →(Finalized) completed；
    /// - cancelled：running / awaiting-approval →(CancelRequested) cancelling
    ///   →(CancelConfirmed) cancelled；
    /// - failed：按当前状态走 RuntimeError / InitError / FinalizeError /
    ///   ForceInterrupt 路径。
    pub async fn finalize(
        &mut self,
        store: &dyn Store,
        terminal: RunTerminalStatus,
        end_reason: &str,
        error: Option<String>,
        terminal_cursor: u64,
    ) -> Result<(), RunError> {
        if self.machine.is_terminal() {
            return Err(RunError::TerminalImmutable);
        }
        let path = terminal_path(self.machine.state(), terminal)?;
        for event in path {
            self.transition(store, event).await?;
        }
        self.end_reason = Some(end_reason.to_string());
        self.error = error.clone();
        self.terminal_sent = true;
        self.cursor = terminal_cursor;
        self.updated_at = now_ms();
        // 终态落库（写入 end_reason + cursor，T08.4）
        store
            .update_run_status(
                &self.run_id,
                self.status.clone(),
                Some(end_reason),
                Some(terminal_cursor as i64),
            )
            .await
            .map_err(RunError::Store)?;
        Ok(())
    }

    /// 标记 run-terminal 已成功发出（drive_outcome 终态事件落库后置位；
    /// 收口落库失败兜底路径据此避免重复终态事件，T08.4）
    pub fn mark_terminal_emitted(&mut self) {
        self.terminal_sent = true;
    }

    /// 事件存储写失败 → run 标记 failed(event-store-write-failed)
    /// （B4.2：不假装可回放，05 §2.8 / 05 §3.4）
    ///
    /// 尚未终态时走状态机收口；已终态（终态事件落库失败）时直接改写
    /// 终态记录为 failed（对齐 task-executor.ts failRunForPersistenceFailure
    /// 的 isTerminalRunStatus 分支）。两分支均携带 cursor（T08.4：
    /// 终态游标 = 最后已分配 sequence）。
    pub async fn fail_event_store(&mut self, store: &dyn Store, message: &str) -> Result<(), RunError> {
        if !self.machine.is_terminal() {
            return self
                .finalize(
                    store,
                    RunTerminalStatus::Failed,
                    EVENT_STORE_WRITE_FAILED_REASON,
                    Some(message.to_string()),
                    self.cursor,
                )
                .await;
        }
        if self.status != RunStatus::Failed {
            // 已终态（completed/cancelled）但终态事件落库失败：翻转记录
            self.status = RunStatus::Failed;
            self.end_reason = Some(EVENT_STORE_WRITE_FAILED_REASON.to_string());
            self.error = Some(message.to_string());
            self.updated_at = now_ms();
            store
                .update_run_status(
                    &self.run_id,
                    RunStatus::Failed,
                    Some(EVENT_STORE_WRITE_FAILED_REASON),
                    Some(self.cursor as i64),
                )
                .await
                .map_err(RunError::Store)?;
        }
        Ok(())
    }
}

/// run 管理器（B4.1：注册 + 状态机驱动 + 落库）
#[derive(Clone)]
pub struct RunManager {
    store: Arc<dyn Store>,
}

impl RunManager {
    /// 新建管理器（store 为共享连接，事件队列复用同一连接）
    pub fn new(store: Arc<dyn Store>) -> Self {
        Self { store }
    }

    /// 共享 store
    pub fn store(&self) -> Arc<dyn Store> {
        self.store.clone()
    }

    /// 注册并启动 run（B4.1：注册 + 落库，queued → running）
    ///
    /// 落库路径：insert_run(queued) → update(initializing) → update(running)。
    /// F-005 touch 接线：run 记录一落库（queued）即进入活跃期，立即刷新
    /// 会话 `updated_at`（宽限期从 run 启动时刻起算；后续状态迁移由
    /// [RunHandle::transition] 通用 touch 持续推进）。
    pub async fn start_run(&self, session_id: &str, run_id: &str) -> Result<RunHandle, RunError> {
        self.store
            .insert_run(run_id, session_id, RunStatus::Queued, None, 0)
            .await
            .map_err(RunError::Store)?;
        self.store
            .touch_session(session_id)
            .await
            .map_err(RunError::Store)?;
        let mut handle = RunHandle::new(run_id, session_id, RunStatus::Queued);
        handle
            .transition(self.store.as_ref(), RunLifecycleEvent::Start)
            .await?;
        handle
            .transition(self.store.as_ref(), RunLifecycleEvent::RuntimeReady)
            .await?;
        Ok(handle)
    }
}

/// 当前状态 → 目标终态的合法转移链（对齐 run-lifecycle.ts 转移表）
fn terminal_path(from: RunStatus, terminal: RunTerminalStatus) -> Result<Vec<RunLifecycleEvent>, RunError> {
    match terminal {
        RunTerminalStatus::Completed => match from {
            RunStatus::Running => Ok(vec![
                RunLifecycleEvent::AgentStop,
                RunLifecycleEvent::Finalized,
            ]),
            RunStatus::Completing => Ok(vec![RunLifecycleEvent::Finalized]),
            _ => Err(RunError::Transition(TransitionError {
                from,
                event: "FINALIZED",
            })),
        },
        RunTerminalStatus::Cancelled => match from {
            RunStatus::Queued
            | RunStatus::Initializing
            | RunStatus::Running
            | RunStatus::AwaitingApproval => Ok(vec![
                RunLifecycleEvent::CancelRequested,
                RunLifecycleEvent::CancelConfirmed,
            ]),
            RunStatus::Cancelling => Ok(vec![RunLifecycleEvent::CancelConfirmed]),
            _ => Err(RunError::Transition(TransitionError {
                from,
                event: "CANCEL_CONFIRMED",
            })),
        },
        RunTerminalStatus::Failed => match from {
            RunStatus::Queued => Ok(vec![RunLifecycleEvent::ForceInterrupt]),
            RunStatus::Initializing => Ok(vec![RunLifecycleEvent::InitError]),
            RunStatus::Running | RunStatus::AwaitingApproval | RunStatus::Cancelling => {
                Ok(vec![RunLifecycleEvent::RuntimeError])
            }
            RunStatus::Completing => Ok(vec![RunLifecycleEvent::FinalizeError]),
            _ => Err(RunError::Transition(TransitionError {
                from,
                event: "RUNTIME_ERROR",
            })),
        },
    }
}

/// agent-end reason → run 终态的**单一权威映射**（T08.9 D1 裁决）：
/// - stop / stopped → completed（stopped 是协作停止，不是取消也不是错误，
///   01 §四 D1）；
/// - max-turns → failed（预算耗尽属阻断而非自然完成，05 §2.8
///   orchestrator.test.ts:1223；与 normalize 侧「max-turns 不续轮」语义一致）；
/// - aborted → cancelled（用户取消 / L3 force_cancel）；
/// - error → failed。
///
/// [crate::normalize::terminal_status_for_end_reason] 委托本函数（薄包装
/// 防破坏既有 import），两处映射永不分叉。
pub fn map_agent_end_to_terminal(reason: AgentEndReason) -> RunTerminalStatus {
    match reason {
        AgentEndReason::Stop | AgentEndReason::Stopped => RunTerminalStatus::Completed,
        AgentEndReason::MaxTurns => RunTerminalStatus::Failed,
        AgentEndReason::Aborted => RunTerminalStatus::Cancelled,
        AgentEndReason::Error => RunTerminalStatus::Failed,
    }
}

/// 收场 reason → run 终态映射（05 §2.8 语义）：
/// - 已请求取消（L2/L3）→ cancelled（end_reason=aborted，05 §2.8
///   orchestrator.test.ts:1113/1151）；
/// - stop / stopped → completed；
/// - max-turns → failed（05 §2.8 orchestrator.test.ts:1223：max-turns 以
///   failed 收场而非 completed）；
/// - aborted → cancelled；
/// - error → failed。
///
/// 终态本体经 [map_agent_end_to_terminal]（T08.9：与 normalize 侧共享同一
/// 权威映射）；本函数只附加「已取消覆盖」与落库 end_reason 文案。
pub fn map_outcome_to_terminal(
    cancel_requested: bool,
    reason: AgentEndReason,
) -> (RunTerminalStatus, &'static str) {
    if cancel_requested {
        return (RunTerminalStatus::Cancelled, "aborted");
    }
    let terminal = map_agent_end_to_terminal(reason);
    let end_reason = match reason {
        AgentEndReason::Stop | AgentEndReason::Stopped => "stop",
        AgentEndReason::MaxTurns => "max-turns",
        AgentEndReason::Aborted => "aborted",
        AgentEndReason::Error => "error",
    };
    (terminal, end_reason)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn machine() -> RunStateMachine {
        RunStateMachine::new(RunStatus::Queued)
    }

    #[test]
    fn machine_follows_main_lifecycle_path() {
        let mut m = machine();
        assert_eq!(m.transition(RunLifecycleEvent::Start).unwrap(), RunStatus::Initializing);
        assert_eq!(m.transition(RunLifecycleEvent::RuntimeReady).unwrap(), RunStatus::Running);
        assert_eq!(m.transition(RunLifecycleEvent::AgentStop).unwrap(), RunStatus::Completing);
        assert_eq!(m.transition(RunLifecycleEvent::Finalized).unwrap(), RunStatus::Completed);
        assert!(m.is_terminal());
    }

    #[test]
    fn machine_approval_roundtrip_does_not_terminate() {
        let mut m = machine();
        m.transition(RunLifecycleEvent::Start).unwrap();
        m.transition(RunLifecycleEvent::RuntimeReady).unwrap();
        assert_eq!(
            m.transition(RunLifecycleEvent::ApprovalRequested).unwrap(),
            RunStatus::AwaitingApproval
        );
        assert!(!m.is_terminal(), "awaiting-approval 为中间态");
        assert_eq!(
            m.transition(RunLifecycleEvent::ApprovalResolved).unwrap(),
            RunStatus::Running
        );
        m.transition(RunLifecycleEvent::AgentStop).unwrap();
        m.transition(RunLifecycleEvent::Finalized).unwrap();
        assert_eq!(m.state(), RunStatus::Completed);
    }

    #[test]
    fn machine_cancel_from_running_and_error_paths() {
        let mut m = machine();
        m.transition(RunLifecycleEvent::Start).unwrap();
        m.transition(RunLifecycleEvent::RuntimeReady).unwrap();
        m.transition(RunLifecycleEvent::CancelRequested).unwrap();
        assert_eq!(m.state(), RunStatus::Cancelling);
        assert_eq!(m.transition(RunLifecycleEvent::CancelConfirmed).unwrap(), RunStatus::Cancelled);
        assert!(m.is_terminal());

        let mut m2 = machine();
        m2.transition(RunLifecycleEvent::Start).unwrap();
        m2.transition(RunLifecycleEvent::RuntimeReady).unwrap();
        assert_eq!(m2.transition(RunLifecycleEvent::RuntimeError).unwrap(), RunStatus::Failed);
        assert!(m2.is_terminal());
    }

    #[test]
    fn machine_terminal_states_reject_further_transitions() {
        for terminal in [RunStatus::Completed, RunStatus::Failed, RunStatus::Cancelled] {
            let mut m = RunStateMachine::new(terminal.clone());
            for event in [
                RunLifecycleEvent::Start,
                RunLifecycleEvent::RuntimeReady,
                RunLifecycleEvent::CancelRequested,
                RunLifecycleEvent::Finalized,
                RunLifecycleEvent::ForceInterrupt,
            ] {
                let err = m.transition(event).unwrap_err();
                assert_eq!(err.from, terminal, "终态 {terminal} 应拒绝 {event:?}");
            }
        }
    }

    #[test]
    fn machine_undefined_transition_fails() {
        let mut m = machine();
        let err = m.transition(RunLifecycleEvent::ApprovalResolved).unwrap_err();
        assert_eq!(err.from, RunStatus::Queued);
        assert_eq!(err.event, "APPROVAL_RESOLVED");
    }

    /// 11-T1（裁决 D3）：Unknown 为死态——is_terminal 显式排除（不属于
    /// 三终态），任何事件一律拒绝迁移（保真滞留，不可迁移）
    #[test]
    fn machine_unknown_status_is_dead_state_rejecting_all_events() {
        let mut m = RunStateMachine::new(RunStatus::Unknown("sneaky".to_string()));
        assert!(!m.is_terminal(), "Unknown 不属于三终态（显式排除）");
        assert_eq!(m.state(), RunStatus::Unknown("sneaky".to_string()));
        // 全事件面逐一拒绝
        for event in [
            RunLifecycleEvent::Start,
            RunLifecycleEvent::RuntimeReady,
            RunLifecycleEvent::InitError,
            RunLifecycleEvent::ApprovalRequested,
            RunLifecycleEvent::ApprovalResolved,
            RunLifecycleEvent::CancelRequested,
            RunLifecycleEvent::CancelConfirmed,
            RunLifecycleEvent::AgentStop,
            RunLifecycleEvent::MaxTurnsReached,
            RunLifecycleEvent::GoalComplete,
            RunLifecycleEvent::RuntimeError,
            RunLifecycleEvent::Finalized,
            RunLifecycleEvent::FinalizeError,
            RunLifecycleEvent::ForceInterrupt,
        ] {
            let err = m.transition(event).unwrap_err();
            assert_eq!(err.from, RunStatus::Unknown("sneaky".to_string()), "{event:?} 应被拒绝");
            assert_eq!(m.state(), RunStatus::Unknown("sneaky".to_string()), "状态不变（死态滞留）");
        }
    }

    #[test]
    fn terminal_path_maps_states() {
        use RunLifecycleEvent as E;
        use RunStatus as S;
        assert_eq!(
            terminal_path(S::Running, RunTerminalStatus::Completed).unwrap(),
            vec![E::AgentStop, E::Finalized]
        );
        assert_eq!(
            terminal_path(S::AwaitingApproval, RunTerminalStatus::Cancelled).unwrap(),
            vec![E::CancelRequested, E::CancelConfirmed]
        );
        assert_eq!(
            terminal_path(S::Cancelling, RunTerminalStatus::Cancelled).unwrap(),
            vec![E::CancelConfirmed]
        );
        assert_eq!(
            terminal_path(S::Running, RunTerminalStatus::Failed).unwrap(),
            vec![E::RuntimeError]
        );
        assert!(terminal_path(S::Queued, RunTerminalStatus::Completed).is_err());
    }

    #[test]
    fn outcome_mapping_follows_documented_semantics() {
        // 未取消：stop/stopped → completed；max-turns → failed；
        // aborted → cancelled；error → failed
        for (reason, terminal, end_reason) in [
            (AgentEndReason::Stop, RunTerminalStatus::Completed, "stop"),
            (AgentEndReason::Stopped, RunTerminalStatus::Completed, "stop"),
            (AgentEndReason::MaxTurns, RunTerminalStatus::Failed, "max-turns"),
            (AgentEndReason::Aborted, RunTerminalStatus::Cancelled, "aborted"),
            (AgentEndReason::Error, RunTerminalStatus::Failed, "error"),
        ] {
            let (t, r) = map_outcome_to_terminal(false, reason);
            assert_eq!(t, terminal);
            assert_eq!(r, end_reason);
        }
        // 已取消（L2/L3）：一律 cancelled（end_reason=aborted，05 §2.8）
        for reason in [
            AgentEndReason::Stop,
            AgentEndReason::Stopped,
            AgentEndReason::Aborted,
            AgentEndReason::Error,
        ] {
            let (t, r) = map_outcome_to_terminal(true, reason);
            assert_eq!(t, RunTerminalStatus::Cancelled);
            assert_eq!(r, "aborted");
        }
    }

    #[tokio::test]
    async fn start_run_persists_queued_then_running() {
        let mem = Arc::new(crate::persist::InMemoryStore::new());
        let store: Arc<dyn Store> = mem.clone();
        let manager = RunManager::new(store);

        let run = manager.start_run("s1", "r1").await.unwrap();
        assert_eq!(run.status, RunStatus::Running);
        assert_eq!(run.run_id, "r1");
        assert_eq!(run.cursor, 0);
        assert!(!run.is_terminal());
        assert!(!run.terminal_sent());

        let runs = mem.runs();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, RunStatus::Running, "落库状态应为 running");
        assert!(runs[0].created_at > 0);
        assert!(
            runs[0].updated_at >= runs[0].created_at,
            "updated_at 不应早于 created_at（insert 与 update 可能跨毫秒）"
        );
    }

    #[tokio::test]
    async fn approval_suspend_and_resume_persists_intermediate_state() {
        let mem = Arc::new(crate::persist::InMemoryStore::new());
        let store: Arc<dyn Store> = mem.clone();
        let manager = RunManager::new(store.clone());
        let mut run = manager.start_run("s1", "r_approval").await.unwrap();

        run.request_approval(store.as_ref()).await.unwrap();
        assert_eq!(run.status, RunStatus::AwaitingApproval);
        assert_eq!(mem.runs()[0].status, RunStatus::AwaitingApproval);

        run.resolve_approval(store.as_ref()).await.unwrap();
        assert_eq!(run.status, RunStatus::Running);
        assert_eq!(mem.runs()[0].status, RunStatus::Running);
    }

    #[tokio::test]
    async fn finalize_completes_and_rejects_second_call() {
        let mem = Arc::new(crate::persist::InMemoryStore::new());
        let store: Arc<dyn Store> = mem.clone();
        let manager = RunManager::new(store.clone());
        let mut run = manager.start_run("s1", "r_fin").await.unwrap();

        // T08.4：终态游标 = 该 run 最后事件 sequence（调用方在终态事件
        // 发出后传入）
        run.cursor = 3;
        run.finalize(store.as_ref(), RunTerminalStatus::Completed, "stop", None, run.cursor)
            .await
            .unwrap();
        assert_eq!(run.status, RunStatus::Completed);
        assert_eq!(run.end_reason.as_deref(), Some("stop"));
        assert!(run.terminal_sent());
        assert_eq!(mem.runs()[0].status, RunStatus::Completed);
        assert_eq!(mem.runs()[0].end_reason.as_deref(), Some("stop"));
        assert_eq!(mem.runs()[0].cursor, 3, "终态 cursor 落库（T08.4）");

        // 终态拒绝再转移（验收：终态拒绝再转移）
        let err = run
            .finalize(store.as_ref(), RunTerminalStatus::Failed, "error", None, 0)
            .await
            .unwrap_err();
        assert_eq!(err, RunError::TerminalImmutable);
        let err = run
            .transition(store.as_ref(), RunLifecycleEvent::Start)
            .await
            .unwrap_err();
        assert_eq!(err, RunError::TerminalImmutable);
    }

    #[tokio::test]
    async fn fail_event_store_marks_failed_with_reason() {
        let mem = Arc::new(crate::persist::InMemoryStore::new());
        let store: Arc<dyn Store> = mem.clone();
        let manager = RunManager::new(store.clone());
        let mut run = manager.start_run("s1", "r_fail_store").await.unwrap();

        // T08.4：失败收口同样携带 cursor（最后已分配序列）
        run.cursor = 2;
        run.fail_event_store(store.as_ref(), "disk is read-only")
            .await
            .unwrap();
        assert_eq!(run.status, RunStatus::Failed);
        assert_eq!(run.end_reason.as_deref(), Some(EVENT_STORE_WRITE_FAILED_REASON));
        assert_eq!(run.error.as_deref(), Some("disk is read-only"));
        assert_eq!(mem.runs()[0].status, RunStatus::Failed);
        assert_eq!(
            mem.runs()[0].end_reason.as_deref(),
            Some(EVENT_STORE_WRITE_FAILED_REASON)
        );
        assert_eq!(mem.runs()[0].cursor, 2, "失败路径 cursor 落库（T08.4）");
    }

    /// T08.9：互引测试——normalize 侧委托 run.rs 权威函数，两处终态映射
    /// 对全部 reason 必须一致；MaxTurns 裁决 = Failed（D1）
    #[test]
    fn terminal_mappings_agree_with_normalize_delegation() {
        let reasons = [
            AgentEndReason::Stop,
            AgentEndReason::Stopped,
            AgentEndReason::MaxTurns,
            AgentEndReason::Aborted,
            AgentEndReason::Error,
        ];
        for reason in reasons {
            let (terminal, _) = map_outcome_to_terminal(false, reason);
            assert_eq!(
                crate::normalize::terminal_status_for_end_reason(reason),
                terminal,
                "{reason:?} 两处终态映射一致（T08.9 互引）"
            );
            assert_eq!(
                map_agent_end_to_terminal(reason),
                terminal,
                "{reason:?} 权威函数与收口映射一致"
            );
        }
        // MaxTurns 裁决锚点：预算耗尽 → Failed（run.rs 为权威，D1）
        assert_eq!(
            map_agent_end_to_terminal(AgentEndReason::MaxTurns),
            RunTerminalStatus::Failed
        );
        // 映射确定性：同一 reason 只对应唯一终态（无互斥分叉）
        let mut seen: Vec<(AgentEndReason, RunTerminalStatus)> = Vec::new();
        for reason in reasons {
            let terminal = map_agent_end_to_terminal(reason);
            if let Some((_, prev)) = seen.iter().find(|(r, _)| *r == reason) {
                assert_eq!(*prev, terminal, "同一 reason 不应映射到不同终态");
            }
            seen.push((reason, terminal));
        }
    }
}
