//! run 生命周期命令桥（B6.1：core_run_task / core_run_control /
//! core_cancel_run / core_approve_tool / core_deny_tool）
//!
//! 本模块同时承载：
//! - [CoreRunState]：进程内核心运行状态（store / 引擎 / 事件桥 / 活动 run
//!   注册表 / 恢复门禁 / 快照状态，B6.4）；
//! - [drive_run_loop]：run 驱动循环——`produce`（[RunProducer] trait）→
//!   [orchestrator::events::drive_outcome] → 事件 emit（信封 runId/sequence
//!   注入；T09.1 后收口 message-delta 跳过不双发）→ cursor 发布 → 终态
//!   退出；错误路径 [finalize_failed]；退出后快照（T08.6 触发点 A）；
//! - [ApprovalGateImpl]：审批门（approval-requested 先发后等防死锁，
//!   01 §五.8；I-02 / PE-12 T12.3：待审批集合校验）；
//! - 快照三触发（PE-08 T08.6）：终态保存（[CoreRunState::save_snapshot_now]）/
//!   周期任务（[CoreRunState::spawn_snapshot_loop]，默认 60s 可配）/
//!   退出钩子（[CoreRunState::save_snapshot_blocking]，main.rs `RunEvent::Exit`）；
//!   restore 在 app.manage(CoreRunState) 之前经 run_in_runtime 执行
//!   （[CoreRunState::run_restore]）；run_task 门禁 restore_ready（Q24 竞态）。
//!
//! 错误协议：命令返回 [crate::core_error::CoreError]（`{kind, detail}`，
//! 03 §5.3-5 IPC 面唯一协议；R2 的 core_error.rs 已接线，run/store 错误
//! 经 `map_run_err` / `map_store_err` 无损映射，77 码经 `core_error_code`
//! 显式映射——见 PE-03 §2.4.2 映射表）。
//!
//! TODO(集成 agent)：main.rs 声明 `mod core_run_commands` 并
//! `app.manage(Arc::new(CoreRunState::new(...)))`（restore 在 manage 之前）。

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_provider::request::build_system_prompt;
use agent_tools::audit::{AuditSink, SecurityAuditSink};
use agent_tools::backup::BackupMiddleware;
use agent_tools::background::{
    BackgroundAdoptRequest, BackgroundTaskInfo, BackgroundTaskManager, BackgroundTaskRef, LogSlice,
    TaskState,
};
use agent_tools::context::ExploreDocsQuotaContext;
use agent_tools::definition::ToolError;
use agent_tools::tools::subagent::SubagentState;
use agent_tools::write_paths::{WritePathPolicy, WritePathRegistry};
use conex_db::LocalDb;
// DEEPCHECK-01 P0：历史 token 估算复用 conex-compaction count_tokens 启发式
// （ASCII 单词约 4 字符/token，与前端 estimateTextTokens 对齐）
use conex_compaction::count_tokens;
use conex_types::device::{
    ApprovalChannel as RemoteApprovalChannel, ApprovalHistoryItem, ApprovalHistoryResult, Arbiter,
    PendingApproval,
};
use conex_types::events::{
    AgentEvent, AgentEventEnvelope, ApprovalDecision as WireApprovalDecision, PermissionRequest,
    RunCacheStats, RunTerminalStatus, SecurityAuditDecision, SecurityAuditOperation,
};
use conex_types::impact::ImpactAssessment;
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use conex_types::session::AgentEndReason;
use conex_types::{codes, ContextBudget, CrishError, CrishErrorPayload, HistoryMessage};
use orchestrator::events::{build_run_terminal, drive_outcome, EventQueue};
use orchestrator::persist::{SessionSequencer, Store};
use orchestrator::restore::{RestoreManager, RestoreMode, RestoreOutcome, SnapshotStore, StateSnapshot};
use orchestrator::run::{CancelMode, RunEngine, RunHandle, RunManager};
use orchestrator::session::SessionRecord;
use orchestrator::PendingMessageQueue;
use session_loop::hydrate::hydrate_history;
use session_loop::approval_router::{
    classify_source, route_approval, route_approval_guarded, arbiter_metadata,
};
use session_loop::tool_events::{ApprovalDecision, ApprovalRequester};
use tauri::Manager as _;
use session_loop::{
    AbortSignal, ApprovalGate, ControlBus, DeltaSink, EscapeWatchConfig, EscapeWatchHandle,
    EscapeWatchInjector, PermissionMode, RegistryBackedDetector, RunOutcome, SessionLoopOptions,
    SummaryDispatchConfig, ToolBatchOptions, spawn_escape_watch,
};

use crate::core_error::CoreError;
use crate::core_event_bridge::{EmitReport, EventBridge};
use crate::core_query_commands::{BackgroundTasksSummary, RestoreStatus, RunUsage, SnapshotStatus};
use crate::engine::{
    BridgeDeltaSink, BufferedRunEventBridge, ContextInjection, ContextInjectionKind, ContextInjector,
    EngineHandle, SessionLoopProducer,
};
use crate::status_diagnostics::StatusDiagnostics;
use crate::task_event_consumer::TaskEventConsumer;

/// run 的 max-turns 预算（对齐 01 §1.5：独立预算 reason）
const MAX_TURNS_DEFAULT: u32 = 64;
/// 审批等待超时（超时 → Expired；前端 ApprovalFlow 亦有兜底）
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);
/// 快照周期默认值（T08.6 触发点 B：默认 60s，session_meta
/// `snapshot_interval_ms` 可配）
const DEFAULT_SNAPSHOT_INTERVAL_MS: u64 = 60_000;
/// DEEPCHECK-01 P0：SessionHistoryCache 每会话 token 预算（防膨胀；超出时
/// 按「稳定锚点 + 预算尾部」截断，跨 run 请求前缀字节稳定，见
/// [truncate_history_with_anchor]；估算对齐 conex-compaction count_tokens，
/// 与前端 HISTORY_TOKEN_BUDGET 同语义）
const SESSION_HISTORY_TOKEN_BUDGET: usize = 200_000;
/// 单条历史消息的固定线缆开销估算（role/id/timestamp/status + JSON 信封，
/// 与前端 HISTORY_MESSAGE_TOKEN_OVERHEAD 对齐）
const SESSION_HISTORY_MESSAGE_TOKEN_OVERHEAD: usize = 8;
/// T-29：SessionHistoryCache 会话数上限（防膨胀；超出时 FIFO 淘汰
/// 最久未更新的会话）
const SESSION_HISTORY_MAX_SESSIONS: usize = 32;

// ── 命令返回形状（03 §3.2 A 组契约）───────────────────────────────

/// core_run_task 返回（03 §3.1：{runId, sessionId} 回执）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunTaskResponse {
    pub run_id: String,
    pub session_id: String,
}

/// core_cancel_run 返回（{ok, runId}；pid 无进程内概念，省略）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelRunResponse {
    pub ok: bool,
    pub run_id: String,
}

/// core_approve_tool / core_deny_tool 返回（{ok, toolCallId, decision}）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproveResponse {
    pub ok: bool,
    pub tool_call_id: String,
    pub decision: &'static str,
}

// ── RunProducer trait（drive_run_loop 的循环输入）──────────────────

/// run 生产接口（drive_run_loop 的 `produce` 步骤）
///
/// 当前实现 [SessionLoopProducer]（engine.rs）：单次 produce 即覆盖整个
/// run（含多 turn），drive_outcome 收口终态后退出；未来 goal 多轮模式
/// 在本循环续轮。
#[async_trait::async_trait]
pub(crate) trait RunProducer: Send {
    /// 生产一次 run 结果
    async fn produce(&mut self) -> RunOutcome;
}

#[async_trait::async_trait]
impl RunProducer for SessionLoopProducer {
    async fn produce(&mut self) -> RunOutcome {
        SessionLoopProducer::produce(self).await
    }
}

// ── 审批门（ApprovalGate 实现）────────────────────────────────────

/// 待审批请求元信息（R1-04 REST 写面 [list_pending_approvals_impl] 数据源）
///
/// 生命周期与 [ApprovalGateImpl::pending] 的 oneshot 通道完全一致：
/// `request_approval` 登记、`resolve` 清除——「已请求未裁决」的运行时真源
/// （M6 C13 派生态的实时版本；run 终态移出活动注册表，天然满足「run 未
/// 终态」条件）。parameters 全量不下发（隐私红线，D6 §7.2），只记键名。
pub(crate) struct PendingRequestMeta {
    /// 工具名
    pub tool_name: String,
    /// 请求摘要
    pub summary: String,
    /// 工具工作目录
    pub cwd: String,
    /// 会话 id
    pub session_id: String,
    /// 请求方 run 归属（None = 主 agent run；与 approval-requested 同源）
    pub requester_run_id: Option<String>,
    /// 申请理由（子代理来源；None = 主 agent 请求）
    pub reason: Option<String>,
    /// 裁决者 wire 名（user / main-agent；与
    /// approval-requested.metadata.arbiter 同源）
    pub arbiter: String,
    /// 请求时刻（epoch ms；expiresAt = requestedAt + APPROVAL_TIMEOUT）
    pub requested_at_ms: u64,
    /// 参数键名列表（parameters 全量不下发，仅键名，M6 C13）
    pub param_keys: Vec<String>,
}

/// 审批门（B6.1：approval-requested 先发后等防死锁，01 §五.8）
///
/// - `request_approval`：广播 approval-requested（经缓冲事件桥，实时通道）
///   → 注册 oneshot 等待 → 超时返回 [ApprovalDecision::Expired]；
/// - `resolve`：core_approve_tool / core_deny_tool 入口——**先校验
///   tool_call_id 在待审批集合**（AA-05 I-02 / PE-12 T12.3：不匹配返回
///   NotFound，杜绝伪造审计事件），再送决策并恢复 run 状态机
///   （awaiting-approval → running）。
pub(crate) struct ApprovalGateImpl {
    /// run 标识
    run_id: String,
    /// 会话标识
    session_id: String,
    /// 父 run 归属（T-D-14 权限传递层）：None = 主 agent run / 无父 run
    /// （审批裁决者 = 用户，现状不变）；Some = 子代理 run 的父 run id
    /// （审批请求路由给主 agent 裁决，可经死锁防护转用户兜底）
    parent_run_id: Option<String>,
    /// 死锁检测器（T-D-14 开放问题 6.4，时序评审见 approval_router.rs 模块
    /// 头注）：判定「裁决者（主 agent）正在 wait 本 run（子代理）」——
    /// 命中时路由转用户打破 120s 空等；None = 未接线（退化纯超时兜底，
    /// 行为与现状一致）。真实 wait 态信号源 = orchestrator 子代理跟踪器
    /// （wait_subagents 工具执行期间标记），由 F11 T-D-13 引擎接线注入。
    deadlock_detector: Option<Box<dyn Fn(&str) -> bool + Send + Sync>>,
    /// 广播 approval-requested（先发后等；信封 sequence=None 实时预览，
    /// 收口流携带持久化序列）
    broadcast: Box<dyn Fn(AgentEvent) + Send + Sync>,
    /// 待审批集合：tool_call_id → 决策通道（I-02 校验依据）
    pending: std::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<ApprovalDecision>>>,
    /// 待审批请求元信息（R1-04：与 [Self::pending] 同生命周期，见
    /// [PendingRequestMeta]——request 登记、resolve 清除）
    pending_meta: std::sync::Mutex<HashMap<String, PendingRequestMeta>>,
    /// run 状态机联动（awaiting-approval 中间态落库）
    handle: Arc<tokio::sync::Mutex<RunHandle>>,
    /// store（状态机转移落库）
    store: Arc<dyn Store>,
    /// 工具执行工作目录（PermissionRequest.cwd）
    cwd: Option<String>,
}

impl ApprovalGateImpl {
    /// 新建审批门
    pub(crate) fn new(
        run_id: String,
        session_id: String,
        parent_run_id: Option<String>,
        broadcast: Box<dyn Fn(AgentEvent) + Send + Sync>,
        handle: Arc<tokio::sync::Mutex<RunHandle>>,
        store: Arc<dyn Store>,
        cwd: Option<String>,
    ) -> Self {
        Self {
            run_id,
            session_id,
            parent_run_id,
            deadlock_detector: None,
            broadcast,
            pending: std::sync::Mutex::new(HashMap::new()),
            pending_meta: std::sync::Mutex::new(HashMap::new()),
            handle,
            store,
            cwd,
        }
    }

    /// 注入死锁检测器（T-D-14 开放问题 6.4）：判定「裁决者 run 正在 wait
    /// 本 run（子代理）」——命中时审批请求路由转用户（UI 裁决面不受主
    /// agent wait 状态阻塞）；不注入 = 纯超时兜底（120s Expired，子代理
    /// run 不中断，行为与现状一致）。
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn with_deadlock_detector(
        mut self,
        detector: Box<dyn Fn(&str) -> bool + Send + Sync>,
    ) -> Self {
        self.deadlock_detector = Some(detector);
        self
    }

    /// 解析审批（core_approve_tool / core_deny_tool 入口）
    ///
    /// I-02（T12.3）：tool_call_id 必须在待审批集合，不匹配返回
    /// NotFound（杜绝伪造 approval-resolved 审计事件 / 提前审批）。
    /// 文案含 `pending` 关键字：`DeviceErrorCode::from_core_error` 对
    /// 审批域 NotFound 升级为 cmd.approval_mismatch（F2 §11.2 冲突信号，
    /// 移动端据此收敛「已被其他设备处理 / 已过期」）。
    pub(crate) async fn resolve(
        &self,
        tool_call_id: &str,
        decision: ApprovalDecision,
    ) -> Result<(), CoreError> {
        let sender = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(tool_call_id)
            .ok_or_else(|| {
                CoreError::NotFound(format!(
                    "tool_call_id not in pending approvals（run={}）：{tool_call_id}",
                    self.run_id
                ))
            })?;
        // R1-04：与决策通道同步清除待办元信息（list_pending_approvals
        // 不再返回已裁决条目）
        self.pending_meta
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(tool_call_id);
        let _ = sender.send(decision);
        // 状态机恢复：awaiting-approval → running（B4.1 审批恢复路径）
        let mut handle = self.handle.lock().await;
        if let Err(error) = handle.resolve_approval(self.store.as_ref()).await {
            tracing::warn!(
                target: "approval",
                run_id = %self.run_id,
                error = %error,
                "resolve_approval 失败（审批决策已送达，状态机兜底）"
            );
        }
        Ok(())
    }

    /// 待审批集合是否包含指定工具调用（R1-04：run_id 缺失时按待审批
    /// 集合反查——M6 C11「runId 缺失容错」）
    pub(crate) fn contains_pending(&self, tool_call_id: &str) -> bool {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(tool_call_id)
    }

    /// 待审批请求元信息快照（R1-04：[list_pending_approvals_impl]
    /// 数据源；返回 (tool_call_id, meta) 列表，与 pending 通道同生命周期）
    pub(crate) fn pending_requests(&self) -> Vec<(String, PendingRequestMeta)> {
        self.pending_meta
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|(tool_call_id, meta)| {
                (
                    tool_call_id.clone(),
                    PendingRequestMeta {
                        tool_name: meta.tool_name.clone(),
                        summary: meta.summary.clone(),
                        cwd: meta.cwd.clone(),
                        session_id: meta.session_id.clone(),
                        requester_run_id: meta.requester_run_id.clone(),
                        reason: meta.reason.clone(),
                        arbiter: meta.arbiter.clone(),
                        requested_at_ms: meta.requested_at_ms,
                        param_keys: meta.param_keys.clone(),
                    },
                )
            })
            .collect()
    }
}

#[async_trait::async_trait]
impl ApprovalGate for ApprovalGateImpl {
    async fn request_approval(
        &self,
        call_id: &str,
        tool_name: &str,
        args: &serde_json::Value,
        requester: Option<&ApprovalRequester>,
    ) -> ApprovalDecision {
        // 1. 来源分类 + 裁决者路由（T-D-14 权限传递层）：子代理来源 →
        //    主 agent 裁决（默认）；主 agent 来源 → 用户（现状不变）；
        //    死锁检测命中（主 agent 正在 wait 该子代理）→ 转用户兜底。
        let source = classify_source(&self.run_id, self.parent_run_id.as_deref());
        let arbiter = self
            .deadlock_detector
            .as_ref()
            .map(|detector| route_approval_guarded(&source, detector(&self.run_id)))
            .unwrap_or_else(|| route_approval(&source));
        tracing::info!(
            target: "approval",
            run_id = %self.run_id,
            parent_run_id = ?self.parent_run_id,
            arbiter = ?arbiter,
            requester_run_id = requester.map(|r| r.run_id.as_str()),
            "审批请求（权限传递层裁决者路由）"
        );

        // 2. 广播 approval-requested（防死锁：先发出再等待，01 §五.8；
        //    实时通道 sequence=None 预览，持久化副本随收口流落库）
        let request = PermissionRequest {
            id: format!("approval-{call_id}"),
            session_id: self.session_id.clone(),
            cwd: self.cwd.clone().unwrap_or_default(),
            tool_call_id: call_id.to_string(),
            tool_name: tool_name.to_string(),
            parameters: args.clone(),
            summary: format!("call {tool_name}"),
            tool_metadata: Default::default(),
            // T-D-14：路由分支可观测落点——子代理来源路由给主 agent 时
            // metadata.arbiter=main-agent（前端据此渲染主 agent 裁决面）；
            // 用户裁决面 None（主 agent run 现状载荷字节不变）
            metadata: arbiter_metadata(arbiter),
            // T-D-14：请求方身份（子代理 run id + 申请理由）随载荷广播
            // 与落库（None = 主 agent run，向后兼容）
            requester_run_id: requester.map(|r| r.run_id.clone()),
            reason: requester.and_then(|r| r.reason.clone()),
        };
        (self.broadcast)(AgentEvent::ApprovalRequested {
            session_id: self.session_id.clone(),
            request,
            timestamp: crate::engine::now_iso_utc(),
        });

        // 2. 状态机联动：running → awaiting-approval（落库，中间态可观测）
        {
            let mut handle = self.handle.lock().await;
            if let Err(error) = handle.request_approval(self.store.as_ref()).await {
                tracing::warn!(
                    target: "approval",
                    run_id = %self.run_id,
                    error = %error,
                    "request_approval 状态机转移失败（审批仍可等待）"
                );
            }
        }

        // 3. 注册等待通道（先发后等，防死锁）
        let (tx, rx) = tokio::sync::oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            if pending.contains_key(call_id) {
                // 同 call 重复审批请求：覆盖旧通道（旧等待超时自然收口）
                let _ = pending.remove(call_id);
            }
            pending.insert(call_id.to_string(), tx);
        }
        // R1-04：同步登记待办元信息（list_pending_approvals 对账数据源；
        // 与 pending 通道同生命周期，resolve 时清除）。arbiter wire 名与
        // 上方广播的 metadata.arbiter 同源（main-agent / user）。
        {
            let mut meta = self.pending_meta.lock().unwrap_or_else(|e| e.into_inner());
            meta.insert(
                call_id.to_string(),
                PendingRequestMeta {
                    tool_name: tool_name.to_string(),
                    summary: format!("call {tool_name}"),
                    cwd: self.cwd.clone().unwrap_or_default(),
                    session_id: self.session_id.clone(),
                    requester_run_id: requester.map(|r| r.run_id.clone()),
                    reason: requester.and_then(|r| r.reason.clone()),
                    arbiter: match arbiter {
                        session_loop::approval_router::Arbiter::MainAgent => "main-agent".to_string(),
                        session_loop::approval_router::Arbiter::User => "user".to_string(),
                    },
                    requested_at_ms: crate::server::now_ms(),
                    param_keys: args
                        .as_object()
                        .map(|map| map.keys().cloned().collect())
                        .unwrap_or_default(),
                },
            );
        }

        // 4. 等待决策（超时 → Expired；工具侧按非致命处理，01 §五.8）
        match tokio::time::timeout(APPROVAL_TIMEOUT, rx).await {
            Ok(Ok(decision)) => decision,
            Ok(Err(_)) | Err(_) => ApprovalDecision::Expired,
        }
    }
}

// ── ActiveRun：活动 run 注册表条目 ────────────────────────────────

/// 活动 run 条目（活动注册表 `active_runs: run_id → ActiveRun`）
///
/// 并发模型（AA-02）：异步路径（drive / cancel / approve）经 tokio Mutex
/// 访问 [RunHandle] 与 [EventQueue]；std Mutex（控制总线）不跨 await 持有。
pub(crate) struct ActiveRun {
    /// 会话标识
    session_id: String,
    /// run 标识
    run_id: String,
    /// run 状态机句柄（drive 收口 / cancel 三路径 / approve 状态机联动）
    handle: Arc<tokio::sync::Mutex<RunHandle>>,
    /// 事件队列（drive 收口 + approve-resolved 落库共用）
    queue: Arc<tokio::sync::Mutex<EventQueue>>,
    /// 控制总线（L2 协作停止 / L1 注入意图）
    control_bus: Arc<Mutex<ControlBus>>,
    /// L3 强停信号（AbortSignal，安全点协作）
    abort_signal: AbortSignal,
    /// 审批门
    approval: Arc<ApprovalGateImpl>,
    /// 本 run 的缓冲事件桥（gate 广播 / delta sink / 收口 emit 共用）
    bridge: Arc<BufferedRunEventBridge>,
    /// 实时 delta 是否激活（T09.1：激活时收口 message-delta 跳过不双发）
    delta_sink_active: bool,
    /// 逃逸监视句柄（T-ESC-03：run 起停钩子；None = 未启用。Mutex 包装：
    /// drive / finalize 路径经锁 take 出句柄后 async 收口，锁不跨 await）
    escape_watch: Mutex<Option<EscapeWatchHandle>>,
    /// 驱动任务句柄（30-P1：spawn(drive_run_loop) 的 JoinHandle）。
    /// Mutex<Option> 形态——ActiveRun 构造在前、spawn 在后，句柄经
    /// [Self::set_driver] 事后登记；收口**不 await**（JoinHandle drop 即
    /// detach，tokio 语义，防挂起），句柄供可观测与未来 join
    driver: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    /// T-CF-11：本 run 是否有用户交互（用户经 L1 soft_inject 注入消息 /
    /// force_cancel 置位；收口判定「用户消息到达后的正常收场不触发续
    /// run」的依据）
    user_touched: AtomicBool,
    /// 子代理 run 装配配置（T-D-13：Some = 本 run 是子代理 run——收口
    /// 时经 spawner 终态处理（记账释放 / 事件发射 / steering 通知）；
    /// None = 普通 run，收口行为与现状一致）
    subagent: Option<crate::subagent_spawner::SubagentRunConfig>,
    /// L4（F12）：审计落库 worker 句柄（run 级；收口处 take + await
    /// 排空——保证审计底账在 run 终态前全部落库；None = 测试驱动路径
    /// 未装配）
    audit_persist: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl ActiveRun {
    /// 登记驱动任务句柄（30-P1；spawn 后调用一次，重复登记覆盖——驱动
    /// 任务每 run 仅一个）
    pub(crate) fn set_driver(&self, handle: tauri::async_runtime::JoinHandle<()>) {
        *self.driver.lock().unwrap_or_else(|e| e.into_inner()) = Some(handle);
    }

    /// 驱动任务是否已收口（观测 / 测试轮询；不 await，语义 = tokio
    /// JoinHandle::is_finished——已收口 / 已取消均成立）
    #[cfg_attr(not(test), allow(dead_code))] // 测试断言面消费；生产供未来 join/观测（30-P1 句柄管理）
    pub(crate) fn driver_finished(&self) -> bool {
        self.driver
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|handle| handle.inner().is_finished())
            .unwrap_or(false)
    }
}

/// 活动 run 的引擎取消接口（[orchestrator::run::RunEngine] 实现：
/// L2 协作停止入控制总线，L3 强停触发 AbortSignal + 总线 force_cancel）
struct ActiveRunEngine {
    active: Arc<ActiveRun>,
}

impl RunEngine for ActiveRunEngine {
    fn request_cooperative_stop(&self, reason: &str) -> bool {
        let mut bus = self
            .active
            .control_bus
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        bus.request_cooperative_stop(Some(reason.to_string()), Some("ui".to_string()));
        true
    }

    fn abort(&self, reason: &str) {
        self.active.abort_signal.abort();
        let mut bus = self
            .active
            .control_bus
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        bus.request_force_cancel(Some(reason.to_string()), Some("ui".to_string()));
    }
}

/// 逃逸监视审计 sink（T-ESC-03 壳层适配）：security-audit 事件经本 run
/// 缓冲事件桥实时广播（信封 sequence=None 实时预览，前端审计面板实时
/// 可见；与审批门 broadcast 同构）。落库（append_event）L4（F12）已
/// 接线：同步广播外另发持久化通道，由单 worker 按发射序
/// reserve_sequence + append_event 落库（events 表审计底账；广播保实时、
/// 落库保底账，双轨并存）。
#[derive(Debug)]
struct BridgeAuditSink {
    /// 本 run 缓冲事件桥
    bridge: Arc<BufferedRunEventBridge>,
    /// run 标识（信封注入）
    run_id: String,
    /// 审计持久化通道（L4：worker 按发射序落库；发送失败 = worker 已
    /// 退出，落库尽力而为，广播不受影响）
    persist: tokio::sync::mpsc::UnboundedSender<AgentEvent>,
}

impl BridgeAuditSink {
    /// 新建桥接审计 sink（run 级实例；persist 通道由 run 装配轮创建，
    /// worker 与 run 同生命周期）
    fn new(
        bridge: Arc<BufferedRunEventBridge>,
        run_id: String,
        persist: tokio::sync::mpsc::UnboundedSender<AgentEvent>,
    ) -> Self {
        Self {
            bridge,
            run_id,
            persist,
        }
    }
}

impl SecurityAuditSink for BridgeAuditSink {
    fn emit(&self, event: &AgentEvent) {
        // L4（F12）：审计底账落库——先发持久化通道（worker 按发射序
        // reserve + append_event；通道关闭仅告警，广播已保实时轨）
        if let Err(error) = self.persist.send(event.clone()) {
            tracing::warn!(
                target: "audit",
                run_id = %self.run_id,
                error = %error,
                "审计落库通道已关闭（保留实时轨，落库尽力而为）"
            );
        }
        let envelope = AgentEventEnvelope::new(event.clone(), Some(self.run_id.clone()), None);
        self.bridge.emit(&envelope);
        self.bridge.flush();
    }
}

/// 审计落库 worker（L4：审计底账持久化——广播保实时、落库保底账）
///
/// 单 worker 串行消费 mpsc 通道：严格保持发射序 → 会话级 sequence
/// 单调不逆序；复用 [orchestrator::events::EventQueue] 的
/// `push_terminal_best_effort` 尽力语义（store 失败仅告警，审计不阻断
/// run、不标记 run 失败）。生命周期：随 run 收口（桥引用全部释放 →
/// sender drop 发出关闭信号 → 排空后退出；收口处 await 保证终态前
/// 落库完成）。
fn spawn_audit_persistence(
    queue: Arc<tokio::sync::Mutex<EventQueue>>,
    session_id: String,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<AgentEvent>,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            let sequenced = queue
                .lock()
                .await
                .push_terminal_best_effort(&session_id, event)
                .await;
            if !sequenced.persisted {
                tracing::warn!(
                    target: "audit",
                    session_id = %session_id,
                    event_type = sequenced.event.type_name(),
                    "审计事件落库失败（保留实时轨，审计底账尽力而为）"
                );
            }
        }
    })
}

/// 逃逸监视主 agent 注入器（T-ESC-03 壳层适配）：归因摘要经 L1
/// followUp 环注入会话（D8：run 内不注入，run idle promote 后成为
/// 下一条用户消息——主 agent 下一轮即可看到，REQ §3.3 第 3 点；
/// 注入频率限流由聚合报告粒度承担）
struct ControlBusInjector {
    /// 本 run 控制总线（std Mutex，锁不跨 await 持有）
    bus: Arc<Mutex<ControlBus>>,
}

impl ControlBusInjector {
    /// 新建注入器（总线与 run 同生命周期）
    fn new(bus: Arc<Mutex<ControlBus>>) -> Self {
        Self { bus }
    }
}

impl EscapeWatchInjector for ControlBusInjector {
    fn inject(&self, text: &str) {
        let mut bus = self.bus.lock().unwrap_or_else(|e| e.into_inner());
        bus.request_follow_up(
            crate::engine::user_message(text, None),
            Some("escape-watch".to_string()),
            Some("system".to_string()),
        );
    }
}

// ── SessionHistoryCache（T-29：per-session 历史缓存）────────────

/// 引擎壳侧 per-session 历史缓存（P4 阶段 1-3/1-4，任务单元 T-29）
///
/// - 结构：`session_id → Vec<HistoryMessage>`——与前端 `history` 参数
///   同构（混合路线统一载荷形态，P4 §3.2.3）；
/// - 内存态、不落库：避免与前端全量写 session_messages 双写冲突
///   （P4 §1.3 验收红线 2）；不改写会话语义；
/// - 写入时机：run 收口（[drive_run_loop] 收口处，[RunOutcome]::messages
///   收口映射后原子替换 = 压缩后缓存基线重建，P4 §3.6 I5 / C13）；
/// - 读取：下次 run 组装 history 参数（[core_run_task]：前端 history
///   为空/未传时回退本缓存——混合路线"引擎侧缓存主"）；
/// - 容量护栏：每会话消息条数上限 + 会话数上限（防膨胀）。
pub(crate) struct SessionHistoryCache {
    inner: Mutex<CacheInner>,
    /// 每会话 token 预算（DEEPCHECK-01 P0 起替代消息条数上限）
    max_tokens: usize,
    /// 会话数上限
    max_sessions: usize,
}

struct CacheInner {
    sessions: HashMap<String, Vec<HistoryMessage>>,
    /// 写入顺序（FIFO 淘汰最久未更新的会话；重复写入移到末尾 ≈ LRU）
    order: VecDeque<String>,
}

impl SessionHistoryCache {
    /// 新建缓存（默认容量：每会话 `SESSION_HISTORY_TOKEN_BUDGET` token、
    /// 最多 `SESSION_HISTORY_MAX_SESSIONS` 个会话）
    pub(crate) fn new() -> Self {
        Self::with_limits(SESSION_HISTORY_TOKEN_BUDGET, SESSION_HISTORY_MAX_SESSIONS)
    }

    /// 新建缓存（显式容量；测试用小容量验证上限语义）
    /// `max_tokens`：每会话 token 预算（DEEPCHECK-01 P0 起替代消息条数上限）
    pub(crate) fn with_limits(max_tokens: usize, max_sessions: usize) -> Self {
        Self {
            inner: Mutex::new(CacheInner {
                sessions: HashMap::new(),
                order: VecDeque::new(),
            }),
            max_tokens,
            max_sessions,
        }
    }

    /// 读取会话历史（下次 run 组装 history 参数的缓存源；None = 无缓存）
    pub(crate) fn get(&self, session_id: &str) -> Option<Vec<HistoryMessage>> {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .sessions
            .get(session_id)
            .cloned()
    }

    /// 写入会话历史（run 收口原子替换）
    ///
    /// 写入前执行两级护栏（DEEPCHECK-01 P0：锚点 + 预算，跨 run 前缀稳定）：
    /// 1. token 预算：超预算按 [truncate_history_with_anchor] 截断——首条
    ///    user 锚点恒在 + 尾部预算窗口（不再固定条数尾部滑窗）；
    /// 2. 安全前缀：逐条前移直到首条为 user（不保留孤儿 tool/system
    ///    首条与带未配对 ToolCall 的 assistant 首条——wire 400 风险）。
    ///
    /// 会话数超限：FIFO 淘汰最久未更新的会话。
    pub(crate) fn store(&self, session_id: &str, mut messages: Vec<HistoryMessage>) {
        truncate_history_with_anchor(&mut messages, self.max_tokens);
        ensure_safe_prefix(&mut messages);
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(pos) = inner.order.iter().position(|id| id == session_id) {
            inner.order.remove(pos);
        }
        inner.order.push_back(session_id.to_string());
        while inner.order.len() > self.max_sessions {
            if let Some(oldest) = inner.order.pop_front() {
                inner.sessions.remove(&oldest);
            }
        }
        inner.sessions.insert(session_id.to_string(), messages);
    }

    /// 缓存中的会话数（测试/诊断专用，生产路径暂不消费）
    #[cfg(test)]
    pub(crate) fn session_count(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .sessions
            .len()
    }

    /// 指定会话缓存的消息条数（测试/诊断专用，生产路径暂不消费）
    #[cfg(test)]
    pub(crate) fn message_count(&self, session_id: &str) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .sessions
            .get(session_id)
            .map(|messages| messages.len())
            .unwrap_or(0)
    }
}

/// DEEPCHECK-01 P0：历史截断统一语义——「稳定锚点 + token 预算」（前端
/// buildHistoryMessages / 引擎缓存读写三层同语义，跨 run 请求前缀稳定）。
///
/// 语义：
/// 1. 预算内 → 原样保留（append-only，请求前缀天然字节稳定，服务端自动
///    前缀缓存全量命中——不再逐轮尾部滑窗整体漂移）；
/// 2. 超预算 → 锚点恒在：保留「首条 user 消息及其前的稳定头部」，其余从
///    最老消息起逐条让位直到尾部窗口装入预算（预算内尾部截断而非固定
///    条数截断）——锚点 = 会话首条 user，永不因截断消失，失配点收敛到
///    尾部增量；
/// 3. 尾部边界 wire 安全：截断点不落在孤儿 tool 消息（其 ToolCall 已被
///    截掉，结果在截断区必然紧随其调用，故只可能落在窗口起点）或携带
///    孤儿 ToolCall 的 assistant 上（wire 400 风险，与 [ensure_safe_prefix]
///    同语义；前端载荷仅 user/assistant 且单条自包含，无此步骤）。
pub(crate) fn truncate_history_with_anchor(
    messages: &mut Vec<HistoryMessage>,
    max_tokens: usize,
) {
    let total: usize = messages.iter().map(estimate_history_tokens).sum();
    if messages.is_empty() || total <= max_tokens {
        return;
    }
    // 锚点 = 首条 user 消息；无 user → 以首条为锚（退化形态仍保证前缀稳定）
    let anchor_end = messages
        .iter()
        .position(|m| m.sender == "user")
        .unwrap_or(0);
    let head_tokens: usize = messages[..=anchor_end]
        .iter()
        .map(estimate_history_tokens)
        .sum();
    // 尾部窗口：从旧到新尽量多带（tail_start 尽可能小，预算内）
    let mut tail_start = anchor_end + 1;
    let mut tail_tokens = total - head_tokens;
    while tail_start < messages.len() && head_tokens + tail_tokens > max_tokens {
        tail_tokens -= estimate_history_tokens(&messages[tail_start]);
        tail_start += 1;
    }
    // 尾部边界 wire 安全：跳过孤儿 tool 首条与携带孤儿 ToolCall 的
    // assistant（结果消息的调用恒在其前，孤儿只可能落在窗口起点）
    while tail_start < messages.len() {
        let must_drop = match messages[tail_start].sender.as_str() {
            "tool" | "system" => true,
            "assistant" => first_has_orphan_tool_call(&messages[tail_start..]),
            _ => false,
        };
        if !must_drop {
            break;
        }
        tail_start += 1;
    }
    // 移除锚点后到尾部窗口起点之间的中间段（锚点与尾部恒在）
    if tail_start > anchor_end + 1 {
        messages.drain(anchor_end + 1..tail_start);
    }
}

/// 单条 HistoryMessage 的 token 估算（对齐前端 estimateHistoryMessageTokens：
/// 复用 conex-compaction count_tokens 启发式——ASCII 单词约 4 字符/token、
/// 分隔符与 CJK 每字符 1 token；固定消息开销 8 token）。
///
/// 字段口径：缓存路径消息带完整 `blocks_json`（收口保真）→ 直接估算其
/// JSON 序列（覆盖 text/thinking/tool-call/tool-result 全部块与输出正文）；
/// 缺块（前端载荷形态）→ 按 text/thinking/tool_calls_json/
/// tool_call_results_json 合成字段估算。
fn estimate_history_tokens(entry: &HistoryMessage) -> usize {
    let content_tokens = if let Some(blocks) = entry.blocks_json.as_deref() {
        count_tokens(blocks)
    } else {
        entry.text.as_deref().map(count_tokens).unwrap_or(0)
            + entry.thinking.as_deref().map(count_tokens).unwrap_or(0)
            + entry.tool_calls_json.as_deref().map(count_tokens).unwrap_or(0)
            + entry
                .tool_call_results_json
                .as_deref()
                .map(count_tokens)
                .unwrap_or(0)
    };
    content_tokens + SESSION_HISTORY_MESSAGE_TOKEN_OVERHEAD
}

/// 缓存安全前缀化：首条不得为 tool/system（孤儿——需要前置上下文），
/// 也不得为携带未配对 ToolCall 的 assistant（孤儿调用——wire 400）。
/// 逐条前移直到首条为 user（或序列为空）。
fn ensure_safe_prefix(messages: &mut Vec<HistoryMessage>) {
    while let Some(first) = messages.first() {
        let must_drop = match first.sender.as_str() {
            "tool" | "system" => true,
            "assistant" => first_has_orphan_tool_call(messages),
            _ => false,
        };
        if must_drop {
            messages.remove(0);
        } else {
            break;
        }
    }
}

/// 首条 assistant 是否携带孤儿 ToolCall（其调用 id 在后续消息中无
/// 对应 ToolResult——截断落在 assistant(tool_calls) 与其结果之间）。
/// 全部调用都有结果才算配对完整（wire 要求每个 call 都有 result）。
fn first_has_orphan_tool_call(messages: &[HistoryMessage]) -> bool {
    let Some(first) = messages.first() else {
        return false;
    };
    let Some(blocks) = parse_blocks(first) else {
        return false;
    };
    let call_ids: Vec<&str> = blocks
        .iter()
        .filter_map(|block| match block {
            AgentMessageBlock::ToolCall(call) => Some(call.id.as_str()),
            _ => None,
        })
        .collect();
    if call_ids.is_empty() {
        return false;
    }
    let has_all_results = call_ids.iter().all(|call_id| {
        messages.iter().skip(1).any(|entry| {
            parse_blocks(entry).is_some_and(|entry_blocks| {
                entry_blocks.iter().any(|block| match block {
                    AgentMessageBlock::ToolResult { tool_call_id, .. } => tool_call_id == call_id,
                    _ => false,
                })
            })
        })
    });
    !has_all_results
}

/// 解析 HistoryMessage 的 blocks_json（缓存收口/读回均保真携带完整块序列）
fn parse_blocks(entry: &HistoryMessage) -> Option<Vec<AgentMessageBlock>> {
    entry
        .blocks_json
        .as_deref()
        .and_then(|json| serde_json::from_str::<Vec<AgentMessageBlock>>(json).ok())
}

// ── T-29 收口映射：RunOutcome::messages → HistoryMessage ─────────

/// run 收口：对话消息 → HistoryMessage（任务书第 4 点）
///
/// - **全角色保真**（user/assistant/tool/system 都收口）：引擎缓存是
///   权威增量，工具结果（Tool 角色独立消息，executing_tools.rs:143-158）
///   必须原样续接，否则 wire 前缀 tool_call 无对应 result（400）；
///   hydrate.rs 的前端过滤规则（P4 §3.2.3 规则 2）只适用于 UI 载荷，
///   不适用于本收口路径（读回走 [cached_history_to_conversation] 保真水合）；
/// - `blocks_json` 保真（完整 AgentMessageBlock 序列）；`tool_calls_json`
///   /`tool_call_results_json` 置 None（有 blocks_json 时不再需要合成源）；
/// - `status = completed`（收口消息均为完成态）；
/// - `timestamp` = created_at 的 epoch ms 折算。
fn to_history_messages(outcome: &RunOutcome) -> Vec<HistoryMessage> {
    outcome
        .messages
        .iter()
        .map(|message| to_history_message(message.as_ref()))
        .collect()
}

/// 单条 AgentMessage → HistoryMessage（全角色保真）
fn to_history_message(message: &AgentMessage) -> HistoryMessage {
    HistoryMessage {
        id: message.id.clone(),
        sender: role_sender(message.role),
        text: non_empty(message.text()),
        thinking: non_empty(message.thought()),
        blocks_json: if message.blocks.is_empty() {
            None
        } else {
            serde_json::to_string(&message.blocks).ok()
        },
        tool_calls_json: None,
        tool_call_results_json: None,
        status: Some("completed".to_string()),
        timestamp: iso8601_to_epoch_millis(&message.created_at),
    }
}

/// 角色 → sender 字符串（与 hydrate.rs 规则 2 的 user/assistant 子集
/// 兼容，额外保留 tool/system——缓存路径读回不过滤）
fn role_sender(role: AgentMessageRole) -> String {
    match role {
        AgentMessageRole::System => "system",
        AgentMessageRole::User => "user",
        AgentMessageRole::Assistant => "assistant",
        AgentMessageRole::Tool => "tool",
    }
    .to_string()
}

/// 空串 → None（HistoryMessage 载荷字段可选语义）
fn non_empty(text: String) -> Option<String> {
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

// ── T-29 时间戳互逆（与 session-loop hydrate.rs 同源算法）────────

/// ISO8601 → epoch ms（引擎统一格式 `YYYY-MM-DDTHH:MM:SS.mmmZ`；
/// 宽容解析：毫秒段可缺省（`SSZ`），时区仅接受 Z；失败兜底 0）
fn iso8601_to_epoch_millis(iso: &str) -> i64 {
    let Some((date, rest)) = iso.split_once('T') else {
        return 0;
    };
    let mut parts = date.split('-');
    let (Some(year), Some(month), Some(day)) = (
        parts.next().and_then(|v| v.parse::<i64>().ok()),
        parts.next().and_then(|v| v.parse::<u32>().ok()),
        parts.next().and_then(|v| v.parse::<u32>().ok()),
    ) else {
        return 0;
    };
    let mut time = rest.split(':');
    let (Some(hour), Some(minute)) = (
        time.next().and_then(|v| v.parse::<i64>().ok()),
        time.next().and_then(|v| v.parse::<i64>().ok()),
    ) else {
        return 0;
    };
    let sec_rest = time.next().unwrap_or("0");
    let stripped = sec_rest.strip_suffix('Z').unwrap_or(sec_rest);
    let (sec, millis) = match stripped.split_once('.') {
        Some((s, ms)) => (
            s.parse::<i64>().unwrap_or(0),
            ms.parse::<i64>().unwrap_or(0),
        ),
        None => (stripped.parse::<i64>().unwrap_or(0), 0),
    };
    let days = days_from_civil(year, month, day);
    ((days * 86_400 + hour * 3600 + minute * 60 + sec) * 1000) + millis
}

/// 公历年月日 → Unix 天数（Howard Hinnant civil_from_days 的逆函数；
/// 与 session-loop hydrate.rs / steering mod.rs 同源算法）
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// epoch ms → ISO8601（毫秒精度 UTC；算法与 session-loop hydrate.rs
/// iso8601_from_epoch_millis 同源——读回缓存还原 created_at 用）
fn epoch_millis_to_iso8601(epoch_ms: i64) -> String {
    let secs = epoch_ms.div_euclid(1000);
    let millis = epoch_ms.rem_euclid(1000);
    let (hours, minutes, sec) = (secs / 3600 % 24, secs / 60 % 60, secs % 60);
    let (year, month, day) = civil_from_days(secs.div_euclid(86_400));
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{sec:02}.{millis:03}Z")
}

/// Unix 天数 → 公历年月日（Howard Hinnant 算法，与 session-loop
/// hydrate.rs:251-271 同源，不引入 chrono 依赖）
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
    (y + if m <= 2 { 1 } else { 0 }, m, d)
}

// ── T-29 读回水合与混合路线装配 ──────────────────────────────────

/// 缓存读回 → 对话（**保真水合**：T-29 缓存路径，与 T-28 前端载荷
/// 过滤规则互补——缓存是引擎权威增量，tool/system 角色与完整 blocks
/// 原样续接，工具结果配对不拆散；单条不可用（角色未知 / blocks 不可
/// 解析）宽容跳过，不中断整体）
///
/// DEEPCHECK-01 P0：读回前同样按「锚点 + token 预算」截断（与 store 写入
/// 语义对齐的防御性一致性；正常路径 store 已截断，此处幂等）。
fn cached_history_to_conversation(entries: Vec<HistoryMessage>) -> Vec<Arc<AgentMessage>> {
    let mut entries = entries;
    truncate_history_with_anchor(&mut entries, SESSION_HISTORY_TOKEN_BUDGET);
    entries
        .iter()
        .filter_map(|entry| {
            let role = match entry.sender.as_str() {
                "user" => AgentMessageRole::User,
                "assistant" => AgentMessageRole::Assistant,
                "tool" => AgentMessageRole::Tool,
                "system" => AgentMessageRole::System,
                _ => return None,
            };
            let blocks = parse_blocks(entry).unwrap_or_default();
            if blocks.is_empty() {
                return None;
            }
            Some(Arc::new(AgentMessage {
                id: entry.id.clone(),
                role,
                created_at: epoch_millis_to_iso8601(entry.timestamp),
                blocks,
                // metadata 裁剪（usage 等运行期数据不进 LLM 上下文，双保险）
                metadata: None,
                client_message_id: Some(entry.id.clone()),
                content: None,
            }))
        })
        .collect()
}

/// 历史装配源（P4 §3.2.3 混合路线：前端水合兜底 + 引擎侧缓存主）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HistorySource {
    /// 前端 store 已完成消息（冷启动/重启后的第一个 run）
    Frontend,
    /// 引擎侧 SessionHistoryCache（运行期连续 run 的权威增量）
    Cache,
}

/// 历史源判定：前端 history 非空 → Frontend；为空/未传但缓存有值 →
/// Cache；两者皆无 → None（现状单消息 run，向后兼容）。
fn resolve_history_source(
    history: &Option<Vec<HistoryMessage>>,
    cached: Option<Vec<HistoryMessage>>,
) -> Option<(HistorySource, Vec<HistoryMessage>)> {
    match history {
        Some(h) if !h.is_empty() => Some((HistorySource::Frontend, h.clone())),
        _ => cached.map(|messages| (HistorySource::Cache, messages)),
    }
}

/// context_window 入站 → ContextBudget（P4 §3.3.2：reserve/safety 取
/// 默认 16384/4096；T-33 在 SessionLoopOptions.context_budget 消费钳制）
fn assemble_context_budget(context_window: u32) -> ContextBudget {
    ContextBudget {
        context_window,
        ..ContextBudget::default()
    }
}

/// DEEPCHECK-06 P0（子代理预算接线）：run 装配时的预算入站解析——
/// 显式 context_window（前端/调用方下发）优先；子代理 run（spawner 路径
/// 前端参数不可达，RunTaskOptions.context_window 恒 None）按生效模型
/// catalog 窗口兜底（[crate::engine::effective_context_window]，与主会话
/// 前端 resolveContextWindow 的 catalog 兜底同源）；目录缺失 → None =
/// 不钳制（与主会话 catalog 兜底失败行为一致）。两者皆缺 → None
/// （向后兼容现状，普通 run 无窗口不钳制）。
fn resolve_context_budget(
    context_window: Option<u32>,
    subagent_config: &Option<crate::subagent_spawner::SubagentRunConfig>,
    engine: &EngineHandle,
) -> Option<ContextBudget> {
    match context_window {
        Some(window) => Some(assemble_context_budget(window)),
        None if subagent_config.is_some() => engine
            .provider_config()
            .and_then(|config| crate::engine::effective_context_window(&config))
            .map(assemble_context_budget),
        None => None,
    }
}

// ── COMPACTION-01 P0-1：压缩策略装配（session_meta 键面）────────────

/// session_meta 键（预留）：保留最近 token 预算覆盖
/// （conex-compaction 缺省 [conex_compaction::KEEP_RECENT_TOKENS_DEFAULT]）
const META_KEY_COMPACT_KEEP_RECENT_TOKENS: &str = "compact_keep_recent_tokens";
/// session_meta 键（预留）：保留最近完整回合数下限覆盖
/// （conex-compaction 缺省 [conex_compaction::MIN_RECENT_TURNS_DEFAULT]）
const META_KEY_COMPACT_MIN_RECENT_TURNS: &str = "compact_min_recent_turns";

/// session_meta 键 → [conex_compaction::compaction::CompactionPolicy]
/// （COMPACTION-01 P0-1 装配 helper：缺省 = 常量默认；键缺失 / 坏值回退
/// 默认 + warn，不 panic）。
///
/// `meta`：键 → 值读取面（生产经 `LocalDb::get_session_meta` 注入；
/// 测试注入内存表）。
fn compaction_policy_from_session_meta(
    meta: impl Fn(&str) -> Option<String>,
) -> conex_compaction::compaction::CompactionPolicy {
    let mut policy = conex_compaction::compaction::CompactionPolicy::default();
    if let Some(raw) = meta(conex_compaction::SESSION_META_KEY_COMPACT_SUMMARY_MAX_TOKENS) {
        match raw.trim().parse::<usize>() {
            Ok(value) if value > 0 => policy.max_summary_tokens = value,
            _ => tracing::warn!(
                key = conex_compaction::SESSION_META_KEY_COMPACT_SUMMARY_MAX_TOKENS,
                raw = %raw,
                default = conex_compaction::MAX_SUMMARY_TOKENS_DEFAULT,
                "压缩策略键值非法 → 回退缺省 max_summary_tokens"
            ),
        }
    }
    if let Some(raw) = meta(META_KEY_COMPACT_KEEP_RECENT_TOKENS) {
        match raw.trim().parse::<usize>() {
            Ok(value) if value > 0 => policy.keep_recent_tokens = value,
            _ => tracing::warn!(
                key = META_KEY_COMPACT_KEEP_RECENT_TOKENS,
                raw = %raw,
                default = conex_compaction::KEEP_RECENT_TOKENS_DEFAULT,
                "压缩策略键值非法 → 回退缺省 keep_recent_tokens"
            ),
        }
    }
    if let Some(raw) = meta(META_KEY_COMPACT_MIN_RECENT_TURNS) {
        match raw.trim().parse::<u32>() {
            Ok(value) if value > 0 => policy.min_recent_turns = value,
            _ => tracing::warn!(
                key = META_KEY_COMPACT_MIN_RECENT_TURNS,
                raw = %raw,
                default = conex_compaction::MIN_RECENT_TURNS_DEFAULT,
                "压缩策略键值非法 → 回退缺省 min_recent_turns"
            ),
        }
    }
    policy
}

// ── T-AB-19：run 感知后台任务管理器（owner_run_id 注入装饰器）────

/// run 感知后台任务管理器（T-AB-19 装饰器，包壳 [BackgroundTaskManager]）
///
/// 职责（方案 §7.4 T-AB-19 第 1/3 点）：
/// - **owner_run_id 注入**：工具执行链的 adopt 调用点（agent-tools
///   shell.rs:1088）构造请求时 `owner_run_id` 恒 None——本装饰器在请求
///   进入注册表前注入「当前 run 上下文」的 runId（审计与过滤用，不级联
///   杀）；请求已显式携带（非 None）时透传不改写；
/// - **L3 可选联动**：`graceful_stop_tasks_for_run`——对指定 run 的普通
///   任务（is_daemon=false）发起优雅终止（两阶段 kill）；默认不联动，
///   仅 `core_run_control` L3 force 且配置项开启时调用；
/// - **状态汇总查询面**：`summary`——core_get_status.backgroundTasks 数据源。
///
/// 上下文约定：run 开始（[core_run_task]）→ `set_current_run(run_id)`；
/// run 终态（[drive_run_loop] 收口 / [finalize_failed]）→
/// `clear_current_run(run_id)`（仅清匹配者）。**不清理注册表、不级联杀
/// 任务**——任务属会话级，registry 生命周期独立于 run（T-AB-12 只读
/// 契约升级为显式收口契约，run_end_* 测试锚定）。
///
/// 诚实边界：引擎与注册表均为进程内单例，装饰器维护「最近启动的 run」
/// 单一上下文槽；多会话并发 run 时以最近启动者为准（owner_run_id 是
/// 审计元数据粒度，不参与生命周期决策，误差不产生行为差异）。
#[derive(Debug)]
pub(crate) struct RunAwareBackgroundManager {
    /// 被包壳的注册表（None = 未接线，测试环境；adopt/list 等返回
    /// 工具未接线错误，生产路径恒 Some）
    inner: Option<Arc<dyn BackgroundTaskManager>>,
    /// 当前 run 上下文（owner_run_id 注入槽；std Mutex 不跨 await 持有）
    current_run_id: Mutex<Option<String>>,
}

impl RunAwareBackgroundManager {
    /// 新建装饰器（包壳 main.rs 注入的注册表）
    pub(crate) fn new(inner: Option<Arc<dyn BackgroundTaskManager>>) -> Self {
        Self {
            inner,
            current_run_id: Mutex::new(None),
        }
    }

    /// run 启动：登记当前 run 上下文（[core_run_task] spawn 前调用）
    pub(crate) fn set_current_run(&self, run_id: &str) {
        *self
            .current_run_id
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(run_id.to_string());
    }

    /// run 终态：释放当前 run 上下文（仅清匹配者——多会话并发 run 时
    /// 较晚启动者占槽，较早结束者不清，避免误伤仍在运行的 run）
    pub(crate) fn clear_current_run(&self, run_id: &str) {
        let mut slot = self
            .current_run_id
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if slot.as_deref() == Some(run_id) {
            *slot = None;
        }
    }

    /// 当前 run 上下文（测试与诊断用）
    #[cfg(test)]
    pub(crate) fn current_run(&self) -> Option<String> {
        self.current_run_id
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 后台任务汇总（core_get_status.backgroundTasks 数据源）
    ///
    /// 口径说明（与前端状态栏 / 诊断面板展示对齐）：
    /// - `active_count`：活跃（Running）任务数——不含终态与已归档条目；
    /// - `daemon_count`：活跃守护进程数（is_daemon=true 且 Running）——
    ///   与 activeCount 同口径（「守护进程仍在运行」语义）；
    /// - `last_finished`：最近终态（全量口径取 finished_at_ms 最大；
    ///   尚无终态任务时 None）。
    ///
    /// 未接线（注册表缺失）或查询失败 → 全零缺省（展示型数据，前端
    /// 显示「无任务」而非报错）。
    pub(crate) async fn summary(&self) -> BackgroundTasksSummary {
        let Some(manager) = &self.inner else {
            return BackgroundTasksSummary::default();
        };
        match manager.list(true).await {
            Ok(tasks) => {
                let mut last_finished: Option<(u64, String, String)> = None;
                for info in &tasks {
                    if info.status == TaskState::Running {
                        continue;
                    }
                    if let Some(finished_at) = info.finished_at_ms {
                        if last_finished
                            .as_ref()
                            .is_none_or(|(max_at, _, _)| finished_at > *max_at)
                        {
                            last_finished = Some((
                                finished_at,
                                info.task_id.clone(),
                                task_state_wire_name(info.status).to_string(),
                            ));
                        }
                    }
                }
                BackgroundTasksSummary {
                    active_count: tasks
                        .iter()
                        .filter(|info| info.status == TaskState::Running)
                        .count(),
                    daemon_count: tasks
                        .iter()
                        .filter(|info| info.is_daemon && info.status == TaskState::Running)
                        .count(),
                    last_finished: last_finished.map(|(finished_at, task_id, status)| {
                        crate::core_query_commands::LastTaskTerminal {
                            task_id,
                            status,
                            finished_at_ms: finished_at as i64,
                        }
                    }),
                }
            }
            Err(error) => {
                tracing::warn!(
                    target: "run",
                    error = %error,
                    "后台任务汇总查询失败（返回全零缺省）"
                );
                BackgroundTasksSummary::default()
            }
        }
    }

    /// T-AB-19 可选接线：对指定 run 的普通任务（is_daemon=false）发起
    /// 优雅终止（注册表两阶段 kill：优雅 → 5s → 强制）。
    ///
    /// 默认不联动：仅 `core_run_control` L3 force 且配置项
    /// `CONEX_RUN_CONTROL_L3_TASK_CANCEL` 开启时调用（职责单一，避免
    /// 误杀，对齐方案 REQ 4.3）。守护任务（is_daemon=true）与其它 run
    /// 的任务一律不碰。best-effort：单任务失败仅告警，不中断整批。
    pub(crate) async fn graceful_stop_tasks_for_run(&self, run_id: &str) {
        let Some(manager) = &self.inner else {
            return;
        };
        let tasks = match manager.list(false).await {
            Ok(tasks) => tasks,
            Err(error) => {
                tracing::warn!(
                    target: "run",
                    run_id,
                    error = %error,
                    "L3 联动：任务查询失败（跳过联动，run 强停不受影响）"
                );
                return;
            }
        };
        for info in tasks
            .iter()
            .filter(|info| info.owner_run_id.as_deref() == Some(run_id) && !info.is_daemon)
        {
            match manager.kill(&info.task_id).await {
                Ok(result) => {
                    tracing::info!(
                        target: "run",
                        run_id,
                        task_id = %info.task_id,
                        kill = ?result,
                        "L3 联动：当前 run 的普通任务已发起优雅终止"
                    );
                }
                Err(error) => {
                    tracing::warn!(
                        target: "run",
                        run_id,
                        task_id = %info.task_id,
                        error = %error,
                        "L3 联动：任务终止失败（best-effort 继续）"
                    );
                }
            }
        }
    }
}

/// T-AB-19 配置项（默认关闭）：L3 force 取消时是否对「当前 run 的普通
/// 任务（is_daemon=false）」发起优雅终止（两阶段 kill）。
///
/// 配置面现状：通用设置存储（config store）尚无布尔项，暂以环境变量
/// `CONEX_RUN_CONTROL_L3_TASK_CANCEL=1` 开启（进程级配置项，登记于
/// T-AB-19 交付说明；接入设置面板后改读设置项，默认值保持 false）。
fn l3_force_cancel_tasks_enabled() -> bool {
    matches!(
        std::env::var("CONEX_RUN_CONTROL_L3_TASK_CANCEL").as_deref(),
        Ok("1") | Ok("true") | Ok("yes")
    )
}

/// 任务状态 wire 名（TaskState kebab-case 序列化名；汇总面用）
fn task_state_wire_name(state: TaskState) -> &'static str {
    match state {
        TaskState::Running => "running",
        TaskState::Completed => "completed",
        TaskState::Failed => "failed",
        TaskState::Killed => "killed",
    }
}

#[async_trait::async_trait]
impl BackgroundTaskManager for RunAwareBackgroundManager {
    /// adopt：注入 owner_run_id（工具链恒 None → 当前 run 上下文；
    /// 显式携带时透传不改写），其余原样转发注册表。
    async fn adopt(&self, mut req: BackgroundAdoptRequest) -> Result<BackgroundTaskRef, ToolError> {
        if req.owner_run_id.is_none() {
            req.owner_run_id = self
                .current_run_id
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
        }
        match &self.inner {
            Some(manager) => manager.adopt(req).await,
            None => Err(ToolError::new(
                codes::TOOL_NOT_FOUND,
                "后台任务注册表未接线（RunAwareBackgroundManager）",
            )),
        }
    }

    async fn list(&self, include_finished: bool) -> Result<Vec<BackgroundTaskInfo>, ToolError> {
        match &self.inner {
            Some(manager) => manager.list(include_finished).await,
            None => Err(ToolError::new(
                codes::TOOL_NOT_FOUND,
                "后台任务注册表未接线（RunAwareBackgroundManager）",
            )),
        }
    }

    async fn status(&self, task_id: &str) -> Result<agent_tools::background::BackgroundTaskStatus, ToolError> {
        match &self.inner {
            Some(manager) => manager.status(task_id).await,
            None => Err(ToolError::new(
                codes::TOOL_NOT_FOUND,
                "后台任务注册表未接线（RunAwareBackgroundManager）",
            )),
        }
    }

    async fn read_log(
        &self,
        task_id: &str,
        start_line: Option<u64>,
        max_lines: u64,
    ) -> Result<agent_tools::background::LogSlice, ToolError> {
        match &self.inner {
            Some(manager) => manager.read_log(task_id, start_line, max_lines).await,
            None => Err(ToolError::new(
                codes::TOOL_NOT_FOUND,
                "后台任务注册表未接线（RunAwareBackgroundManager）",
            )),
        }
    }

    async fn send_input(
        &self,
        task_id: &str,
        text: &str,
        append_newline: bool,
    ) -> Result<(), ToolError> {
        match &self.inner {
            Some(manager) => manager.send_input(task_id, text, append_newline).await,
            None => Err(ToolError::new(
                codes::TOOL_NOT_FOUND,
                "后台任务注册表未接线（RunAwareBackgroundManager）",
            )),
        }
    }

    async fn kill(&self, task_id: &str) -> Result<agent_tools::background::KillResult, ToolError> {
        match &self.inner {
            Some(manager) => manager.kill(task_id).await,
            None => Err(ToolError::new(
                codes::TOOL_NOT_FOUND,
                "后台任务注册表未接线（RunAwareBackgroundManager）",
            )),
        }
    }
}

// ── CoreRunState ──────────────────────────────────────────────────

/// 核心运行状态（B6.4：进程内核心的共享状态）
///
/// main.rs 接线（集成 agent）：`app.manage(Arc::new(CoreRunState::new(...)))`；
/// restore 在 manage 之前经 `run_in_runtime` 执行 [Self::run_restore]（T08.6）。
pub struct CoreRunState {
    /// 事件存储连接（run 记录 + 事件流 + pending 输入）
    store: Arc<dyn Store>,
    /// run 管理器（注册 + 生命周期）
    run_manager: RunManager,
    /// 引擎句柄（provider 配置 + 工具注册表 + engineReady；Arc 包装——
    /// 生产 Summarizer 工厂闭包需 'static 捕获以按会话读取当前生效配置）
    engine: Arc<EngineHandle>,
    /// 全局事件桥（Tauri 通道；每 run 经 BufferedRunEventBridge 组装缓冲）
    bridge: EventBridge,
    /// 活动 run 注册表（终态移出；会话内串行守卫依据）
    active_runs: Mutex<HashMap<String, Arc<ActiveRun>>>,
    /// 状态诊断（环形 20 条 + lastError AtomicSlot，PE-04 T04.5）
    diagnostics: Arc<StatusDiagnostics>,
    /// T08.8：会话级序列号预热缓存（base_sequence_for；恢复后 seed）
    next_sequences: Mutex<HashMap<String, u64>>,
    /// T08.6 门禁：restore 完成标记（完成前 run_task 拒绝新 run，Q24 竞态）
    restore_ready: AtomicBool,
    /// 快照存储（主文件 + .prev 备份，双文件模型）
    snapshots: Arc<dyn SnapshotStore>,
    /// 快照周期（ms；session_meta `snapshot_interval_ms` 可配，默认 60s）
    snapshot_interval_ms: Mutex<u64>,
    /// 最近一次快照代数（恢复成功后的首次保存以 generation+1 续接）
    snapshot_generation: AtomicU64,
    /// T3.5 D5（F2-11 / R2 §4 修复建议 1）：快照保存互斥锁——三触发
    /// （终态 [Self::save_snapshot_now] 调用点 / 周期 [Self::spawn_snapshot_loop]
    /// / 退出 [Self::save_snapshot_blocking]）共用 [Self::save_snapshot_now]
    /// 入口，锁内完成「generation 读-改-写 + build + 落盘 + 状态回写」全
    /// 链路。根因：无锁时两路并发保存同读 G 同写 G+1（丢失更新），且轮转
    /// remove/rename 交叉（实测并发双线程下主/备份同代数 + snapshot_rename
    /// 错误）。锁为 tokio::sync::Mutex：跨 runtime 可用（退出钩子经
    /// `tauri::async_runtime::block_on` 从独立 std::thread 汇入同一锁面），
    /// 无嵌套锁面（唯一持有点），死锁风险低（AU-03 选型确认）。
    snapshot_mutex: tokio::sync::Mutex<()>,
    /// 快照保存失败显式标记（P16：core_get_status.snapshot.lastError 数据源）
    snapshot_last_error: Mutex<Option<String>>,
    /// 会话树注册表（T08.6 第 4 点；goal 模式未激活时为空数组，快照结构不变）
    sessions: Mutex<Vec<SessionRecord>>,
    /// 周期快照任务运行标记（幂等防重复启动）
    snapshot_loop_running: AtomicBool,
    /// setup 完成标记（PE-01 T01.2：main.rs setup 末尾置 true；
    /// core_get_status.initialized 数据源）
    initialized: AtomicBool,
    /// restore 是否已开始（restore.state = pending 数据源）
    restore_started: AtomicBool,
    /// restore 是否失败（restore.state = failed 数据源；失败不阻塞启动）
    restore_failed: AtomicBool,
    /// 恢复模式字面量（full-replay / snapshot-incremental；restore.mode 数据源）
    restore_mode: Mutex<Option<String>>,
    /// 快照回退说明（restore.snapshotNote 数据源；None = 未回退/无说明）
    restore_note: Mutex<Option<String>>,
    /// 本次恢复打断的 run 数（restore.interruptedCount 数据源）
    interrupted_count: Mutex<usize>,
    /// 事件流锚点（restore.lastSequence 数据源；无事件时 None）
    restore_last_sequence: Mutex<Option<u64>>,
    /// 最近一次快照写入时间（epoch ms；snapshot.writtenAt 数据源）
    snapshot_written_at: Mutex<Option<i64>>,
    /// T-29：per-session 历史缓存（P4 阶段 1-3/1-4；运行期内存态，
    /// 不落库——前端 history 为空时回退，混合路线"引擎侧缓存主"）
    session_history: SessionHistoryCache,
    /// T-AB-19：run 感知后台任务管理器（包壳 main.rs 注入的注册表——
    /// 工具链 adopt 的 owner_run_id 注入槽 + L3 可选联动 + 状态汇总
    /// 查询面；引擎侧注入同一包装实例，工具执行链 adopt 走装饰器）
    background: Arc<RunAwareBackgroundManager>,
    /// T-CF-11：跨 run steering 队列（PendingMessageQueue——定时器到期 /
    /// Cron 触发 / 子代理完成 / watchdog 兜底通知的落点；与
    /// [EngineHandle::timer_steering_queue] 同一实例，收口处非空判定 +
    /// 批量转出注入续 run）
    pending_queue: Arc<Mutex<PendingMessageQueue>>,
    /// 30 方案 P3：任务事件消费器（task_events.rs 消费面接线——与
    /// [Self::pending_queue] 同实例、bridge 直发 security-audit（域隔离
    /// 不经 engine audit_sink）；main.rs 装配轮经
    /// [Self::task_events] 注入 background 注册表）
    task_events: Arc<TaskEventConsumer>,
    /// T-CF-11：定时器活跃判定器（TimerRegistry 非空封装；None = 未接线
    /// ——收口时不因定时器续 run。生产在 [Self::new] 经
    /// [EngineHandle::timer_registry] 的 list_active 封装注入；测试可替换）
    timer_has_active: Mutex<Option<WakeSourceCheck>>,
    /// T-CF-11：enabled Cron 判定器（SchedulerRegistry 非空封装；None =
    /// 未接线——Cron 不参与续 run 判定，行为与接线前一致。30 方案 P7：
    /// 生产在 [Self::new] 内直接装配（engine.scheduler_registry() 非空
    /// 封装 has_active，对齐 timer_has_active 先例）；setter 保留测试
    /// 替换槽）
    cron_has_enabled: Mutex<Option<WakeSourceCheck>>,
    /// T-CF-11：idle 续 run 空转护栏计数（session_id → 连续无 AI 产出
    /// 的续 run 轮数；有产出清零，超 [IDLE_RESUME_MAX_EMPTY_ROUNDS] 停止）
    resume_empty_streak: Mutex<HashMap<String, u32>>,
    /// T-CF-11：idle 续 run 拉起器（生产 = [production_resume_launcher]
    /// 预装配——经 run_task_impl 复用装配拉起新 run；测试经
    /// set_resume_launcher 注入替身断言判定与注入载荷）
    resume_launcher: Mutex<Option<ResumeLauncher>>,
    /// 子代理生产 spawner（T-D-13：SubagentSpawner 契约引擎侧实现；
    /// 同一实例经 EngineHandle 注入 run_subagent 工具 + 本状态持有——
    /// 注入面（launcher / db / wait 广播 / steering 队列）经
    /// [Self::finalize_subagent_spawner] 装配）
    subagent_spawner: Arc<crate::subagent_spawner::SubagentSpawnerImpl>,
    /// T-42：会话级摘要协调器注册表（00-plan §6.5 R-I / 评审 02 P0-2）——
    /// 与 [Self::session_history] 同生命周期（进程级单例）：摘要任务状态
    /// （JoinHandle/退避/attempts/last_outcome）挂会话级容器，run 收口不
    /// 摧毁任务，跨 run 单飞成立；完成回调经默认回调落 compression_blocks
    /// 表（两阶段写协议阶段二，orchestrator::blocks 面）。
    summary_coordinators: Arc<session_loop::SessionSummaryCoordinatorRegistry>,
    /// T-43：会话级 Summarizer 工厂（壳层注入通道；None = 无注入——不
    /// spawn 后台摘要任务，纯 stub awaiting 永驻）。生产经
    /// [Self::set_summarizer_factory] 由 session.start / 配置加载注入；
    /// 真实 provider 调用实现属产品功能（通道本轮打通，实现挂 V2/产品面）。
    summarizer_factory: Mutex<Option<crate::engine::SummarizerFactory>>,
}

impl CoreRunState {
    /// 新建核心运行状态（store / snapshots / bridge / diagnostics 由 main.rs
    /// 接线传入；diagnostics 与 `core_get_status` 的 `State<StatusDiagnostics>`
    /// 共享同一实例，避免「写入侧与读取侧实例漂移」）
    pub fn new(
        store: Arc<dyn Store>,
        snapshots: Arc<dyn SnapshotStore>,
        bridge: EventBridge,
        diagnostics: Arc<StatusDiagnostics>,
        background_manager: Option<Arc<dyn agent_tools::background::BackgroundTaskManager>>,
    ) -> Self {
        // T-AB-19：注册表包壳为 run 感知装饰器（owner_run_id 注入 + L3
        // 可选联动 + 汇总查询面）；引擎与状态共享同一包装实例——工具执行
        // 链 adopt（agent-tools shell.rs）经引擎注入的 trait 引用走到装饰器。
        let background = Arc::new(RunAwareBackgroundManager::new(background_manager));
        // T-D-13：子代理生产 spawner 实例（注入槽为空；launcher / db /
        // wait 广播 / steering 队列经 [Self::finalize_subagent_spawner]
        // 装配——Arc 构造完成后注入，防构造期循环引用）
        let subagent_spawner = Arc::new(crate::subagent_spawner::SubagentSpawnerImpl::new());
        // T-CF-11：idle 待命唤醒源接线——跨 run steering 队列与定时器
        // 活跃判定经 EngineHandle 访问器取得（engine.rs:775-783，R-CF3
        // 装配收口预留）；SchedulerRegistry enabled 判定在下方经
        // engine.scheduler_registry() 直接装配（30 方案 P7）。
        let engine = Arc::new(EngineHandle::new_with_spawner(
            // 引擎侧注入包装实例（保持 Option 语义：未接线 = 引擎无
            // 后台任务通道，与接线前行为一致）
            background
                .inner
                .is_some()
                .then(|| Arc::clone(&background) as Arc<dyn BackgroundTaskManager>),
            // T-D-13：spawn 通道注入（run_subagent 工具接线；None =
            // run_subagent 返回 common.unsupported 降级）
            Some(Arc::clone(&subagent_spawner)
                as Arc<dyn agent_tools::tools::subagent::SubagentSpawner>),
        ));
        // COMPACTION-01 P0-3（生产闭环）：真实 LLM 摘要器工厂装配——会话级
        // SummarizerFactory = production_summarizer_factory（返回
        // ProviderSummarizer：经 chat-completions 通道 + 当前 provider
        // 配置；provider 未就绪 → None → 纯 stub awaiting 语义保持）。
        // 工厂每次解析读取引擎当前生效配置——config_profile_apply 热更新后
        // 下一次 run 立即生效。T-43 通道生产注入点（session.start /
        // 配置加载 = CoreRunState::new，与 SessionHistoryCache 同生命周期）。
        let summarizer_factory =
            Some(crate::engine::production_summarizer_factory(Arc::clone(&engine)));
        let pending_queue = engine.timer_steering_queue();
        // 30 方案 P3：任务事件消费器（与 pending_queue 同实例；bridge 为
        // 本状态持有实例的克隆——security-audit 直发不经 engine audit_sink，
        // 30 文档 §9 域隔离接口约定）
        let task_events = Arc::new(TaskEventConsumer::new(
            Arc::clone(&pending_queue),
            bridge.clone(),
            String::new(), // 空串占位（任务为会话级存活，归属经 payload ownerRunId）
        ));
        let timer_registry = engine.timer_registry();
        let timer_has_active: WakeSourceCheck = Arc::new(move || {
            let registry = Arc::clone(&timer_registry);
            Box::pin(async move { !registry.list_active().await.is_empty() })
        });
        // 30 方案 P7：enabled Cron 判定器装配（对齐 timer_has_active 先例
        // ——SchedulerRegistry 非空封装：表内条目即活跃（停止/取消时已
        // 移除，sched.rs has_active 语义自洽）。None = 装配降级（引擎
        // scheduler_registry 为 None），Cron 不参与续 run 判定，行为与
        // 接线前一致（main.rs 装配轮已加 warn 提示——D-29 精神）。
        let scheduler_registry = engine.scheduler_registry();
        let cron_has_enabled: Option<WakeSourceCheck> = scheduler_registry.map(|reg| {
            let reg = Arc::clone(&reg);
            let check: WakeSourceCheck = Arc::new(move || {
                let reg = Arc::clone(&reg);
                Box::pin(async move { reg.has_active() })
            });
            check
        });
        // T-CF-11：生产续 run 拉起器预装配（trait object 叶子类型——
        // drive_run_loop 经 trait object 调用，不直接包含 run_task_impl
        // 的 opaque future，避免 auto-trait 检查递归限制；测试经
        // set_resume_launcher 覆盖替身）
        let resume_launcher = production_resume_launcher();
        // T-42：会话级摘要协调器注册表（与 session_history 同生命周期）——
        // 默认完成回调 = 落 compression_blocks 表（两阶段写协议阶段二：
        // 调度器成功后推进 summary_json/state/attempts；orchestrator
        // 同步面，回调为 FnOnce 语义直接调用；失败仅告警不阻断——块表
        // 是索引面，原文仍在事件流可回放）
        let persist_store = Arc::clone(&store);
        let summary_coordinators = Arc::new(session_loop::SessionSummaryCoordinatorRegistry::new(
            Some(Arc::new(move |outcome: session_loop::SummaryDispatchOutcome| {
                let outcome_state = match outcome.state.as_str() {
                    "committed" => conex_db::BlockState::Committed,
                    "retired" => conex_db::BlockState::Retired,
                    _ => conex_db::BlockState::Awaiting,
                };
                if let Err(error) = orchestrator::blocks::update_compression_block_summary(
                    persist_store.as_ref(),
                    &outcome.session_id,
                    &outcome.block_id,
                    outcome_state,
                    outcome.summary_json.as_deref(),
                    outcome.attempts,
                ) {
                    tracing::warn!(
                        target: "run",
                        session_id = %outcome.session_id,
                        block_id = %outcome.block_id,
                        error = %error,
                        "摘要任务完成回调落库失败（块表是索引面，原文在事件流可回放）"
                    );
                }
            }) as Arc<dyn Fn(session_loop::SummaryDispatchOutcome) + Send + Sync>),
        ));
        Self {
            store: Arc::clone(&store),
            run_manager: RunManager::new(store),
            engine,
            bridge,
            active_runs: Mutex::new(HashMap::new()),
            diagnostics,
            next_sequences: Mutex::new(HashMap::new()),
            restore_ready: AtomicBool::new(false),
            snapshots,
            snapshot_interval_ms: Mutex::new(DEFAULT_SNAPSHOT_INTERVAL_MS),
            snapshot_generation: AtomicU64::new(0),
            snapshot_mutex: tokio::sync::Mutex::new(()),
            snapshot_last_error: Mutex::new(None),
            sessions: Mutex::new(Vec::new()),
            snapshot_loop_running: AtomicBool::new(false),
            initialized: AtomicBool::new(false),
            restore_started: AtomicBool::new(false),
            restore_failed: AtomicBool::new(false),
            restore_mode: Mutex::new(None),
            restore_note: Mutex::new(None),
            interrupted_count: Mutex::new(0),
            restore_last_sequence: Mutex::new(None),
            snapshot_written_at: Mutex::new(None),
            session_history: SessionHistoryCache::new(),
            background,
            pending_queue,
            task_events,
            timer_has_active: Mutex::new(Some(timer_has_active)),
            cron_has_enabled: Mutex::new(cron_has_enabled),
            resume_empty_streak: Mutex::new(HashMap::new()),
            resume_launcher: Mutex::new(Some(resume_launcher)),
            subagent_spawner,
            summary_coordinators,
            summarizer_factory: Mutex::new(summarizer_factory),
        }
    }

    /// T-CF-11：注入 Cron enabled 判定器（30 方案 P7 后为测试替换槽——
    /// 生产在 [Self::new] 内直接装配 engine.scheduler_registry() 的
    /// has_active 封装；测试经本方法注入替身/清空断言判定分支。cfg(test)
    /// 门控对齐 [Self::set_timer_has_active] 先例——非测试构建无生产
    /// 调用方，函数体整体不编译，零 dead_code 警告）
    #[cfg(test)]
    pub(crate) fn set_cron_has_enabled(&self, check: Option<WakeSourceCheck>) {
        *self
            .cron_has_enabled
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = check;
    }

    /// T-CF-11：注入定时器活跃判定器（测试可替换；None = 收口时不因
    /// 定时器续 run）
    #[cfg(test)]
    pub(crate) fn set_timer_has_active(&self, check: Option<WakeSourceCheck>) {
        *self
            .timer_has_active
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = check;
    }

    /// T-CF-11：注入 idle 续 run 拉起器（测试替身断言判定与注入载荷；
    /// None = 恢复生产路径 [production_resume_launcher] 的缺省行为）
    #[cfg(test)]
    pub(crate) fn set_resume_launcher(&self, launcher: Option<ResumeLauncher>) {
        *self
            .resume_launcher
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = launcher;
    }

    /// setup 完成标记（PE-01 T01.2：setup 失败 = false，不假装成功）
    pub fn initialized(&self) -> bool {
        self.initialized.load(Ordering::SeqCst)
    }

    /// 标记 setup 完成（main.rs setup 末尾调用）
    pub fn mark_initialized(&self) {
        self.initialized.store(true, Ordering::SeqCst);
    }

    /// 引擎（session-loop）就绪（provider 配置三件套齐备）
    pub fn engine_ready(&self) -> bool {
        self.engine.ready()
    }

    /// 重载引擎 provider 适配层（PS-04 T4.3 / F4 F1-01 接线：config 命令
    /// 写 store 成功后调用——重建 `HttpProviderCall`（新 key/baseUrl/model
    /// 快照）并原子交换，下一次 run 用新凭据）。
    pub(crate) fn reload_provider(&self) {
        self.engine.reload_provider();
    }

    /// restore 域状态（core_get_status.restore 数据源；F2 冻结形状）
    pub fn restore_status(&self) -> RestoreStatus {
        let state = if !self.restore_started.load(Ordering::SeqCst) {
            "pending"
        } else if self.restore_failed.load(Ordering::SeqCst) {
            "failed"
        } else {
            "done"
        };
        let mode = self
            .restore_mode
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
            .unwrap_or_default();
        let snapshot_note = self
            .restore_note
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let interrupted_count = self
            .interrupted_count
            .lock()
            .map(|guard| *guard)
            .unwrap_or_default();
        let last_sequence = self
            .restore_last_sequence
            .lock()
            .map(|guard| *guard)
            .unwrap_or_default();
        RestoreStatus {
            state,
            mode,
            snapshot_note,
            interrupted_count,
            last_sequence,
        }
    }

    /// 快照域状态（core_get_status.snapshot 数据源；F2 冻结形状）
    pub fn snapshot_status(&self) -> SnapshotStatus {
        let written_at = self
            .snapshot_written_at
            .lock()
            .map(|guard| *guard)
            .unwrap_or_default();
        SnapshotStatus {
            generation: self.snapshot_generation(),
            written_at,
            last_error: self.snapshot_last_error(),
        }
    }

    /// run 终态错误文案（无则 None；当前未接线，终态错误由
    /// core_get_run_snapshot.endReason 承载）
    pub fn run_error(&self, _run_id: &str) -> Option<String> {
        None
    }

    /// run usage 域（T-40 真实实现，R5-D3 轮末合并接线）
    ///
    /// 数据源 = runs 表 v5 列（T-39 `get_run_usage`，drive_run_loop 收口
    /// `save_run_usage` 写入）；经 [Self::local_db] 下转型取底层连接。
    /// 无 LocalDb（InMemoryStore 等测试替身）/ 无样本（sample_count == 0，
    /// 含 v4 迁移旧行）/ 读失败 → None——前端回退估算（contract 注释约定：
    /// usage 域未接线时 None）。
    pub fn run_usage(&self, run_id: &str) -> Option<RunUsage> {
        let db = self.local_db()?;
        let stats = match db.get_run_usage(run_id) {
            Ok(Some(stats)) => stats,
            Ok(None) => return None,
            Err(error) => {
                tracing::warn!(
                    target: "run",
                    run_id,
                    error = %error,
                    "get_run_usage 读失败（usage 查询回退前端估算）"
                );
                return None;
            }
        };
        RunUsage::from_run_cache_stats(stats)
    }

    /// T-40（R5-D3 轮末合并接线 ④）：store 下转型取 [LocalDb]——run
    /// usage 数据面（get_run_usage / save_run_usage，runs 表 v5 列）经
    /// 此访问。
    ///
    /// 实现说明：生产路径 store 恒为 [orchestrator::persist::LocalDbStore]
    /// （main.rs 接线），经 [orchestrator::persist::Store::as_local_db] 返回
    /// 连接克隆（Arc +1）；非 LocalDb 实现（InMemoryStore 测试替身）保持
    /// 默认 None——usage 查询回退前端估算，不阻塞其他功能。
    pub fn local_db(&self) -> Option<LocalDb> {
        self.store.as_local_db()
    }

    /// 引擎句柄（27 方案 S5/S6 装配面访问器：run 装配块取浏览器会话槽
    /// 挂 abort 桥，browser_commands 命令面取同一进程级单例）
    pub(crate) fn engine(&self) -> Arc<EngineHandle> {
        Arc::clone(&self.engine)
    }

    /// T-43：注入会话级 Summarizer 工厂（壳层注入通道；None = 无注入——
    /// 不 spawn 后台摘要任务，纯 stub awaiting 永驻，与接线前行为一致）。
    /// **生产装配点已闭环（COMPACTION-01 P0-3）**：[Self::new] 直接装配
    /// [crate::engine::production_summarizer_factory]（真实 LLM 实现
    /// ProviderSummarizer，经 chat-completions 通道）；本 setter 保留为
    /// 测试替换槽 / 显式降级面。
    #[cfg_attr(not(test), allow(dead_code))] // 生产在 new() 内直接装配；测试替换槽
    pub(crate) fn set_summarizer_factory(&self, factory: Option<crate::engine::SummarizerFactory>) {
        *self
            .summarizer_factory
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = factory;
    }

    /// T-43：按会话解析 Summarizer（工厂注入面；无工厂 / 工厂返回 None →
    /// None——不 spawn）。per-session 实例边界（04 §7.1 隔离决议：
    /// 每会话独立 Summarizer 实例，共享 provider 客户端但无共享可变状态）。
    pub(crate) fn summarizer_for(
        &self,
        session_id: &str,
    ) -> Option<Arc<dyn conex_compaction::Summarizer>> {
        self.summarizer_factory
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .and_then(|factory| factory(session_id))
    }

    /// T-44：session_meta 配置面 → [SummaryDispatchConfig]（读取 helper；
    /// 键缺失 / 解析失败回退生产缺省——None = 生产缺省参数，与轮次 4
    /// `summary_dispatch: None` 语义一致）。
    ///
    /// 可配键（对齐 04 §9.4 T17 / 00-plan §10 轮次 6）：
    /// - `compact_summary_backoff_ms`：退避基数（JSON 数组或单数值，缺省
    ///   [1000,3000,9000]）；
    /// - `compact_summary_wall_ms`：单次调用墙钟（缺省 60000ms，P1-10）。
    /// - `compact_l1_placeholder`：L1 回退开关——**V1 启动级配置**：引擎
    ///   侧（轮次 1）已删 AgentMessage 面 L1 改 stub，运行时双态切换需
    ///   引擎支持；V1 仅读取面（[session_loop::summary_l1_placeholder]）
    ///   文档化、不改变行为，预留给 V2。
    pub(crate) fn summary_dispatch_config(&self, session_id: &str) -> Option<SummaryDispatchConfig> {
        let db = self.local_db()?;
        // 仅当任一配置键存在时构造（无键 = 生产缺省 None，行为不变）
        let has_key = [
            session_loop::META_KEY_SUMMARY_BACKOFF_MS,
            session_loop::META_KEY_SUMMARY_WALL_MS,
        ]
        .iter()
        .any(|key| {
            db.get_session_meta(key)
                .ok()
                .flatten()
                .is_some()
        });
        if !has_key {
            return None;
        }
        // L1 回退开关读取（V1 启动级：不改变行为，仅登记读取；引擎动态
        // 双态支持见 V2 挂账）
        if session_loop::summary_l1_placeholder(|key| {
            db.get_session_meta(key).ok().flatten()
        }) {
            tracing::warn!(
                target: "run",
                session_id = session_id,
                "compact_l1_placeholder=true：旧 L1 占位符回退开关为启动级配置，V1 未接线（引擎已改中性 stub），预留给 V2"
            );
        }
        Some(SummaryDispatchConfig::from_session_meta(
            |key| db.get_session_meta(key).ok().flatten(),
            session_loop::MAX_SUMMARY_ATTEMPTS,
        ))
    }

    /// COMPACTION-01 P0-1（生产闭环）：压缩策略装配——生产恒装配（LocalDb
    /// store 存在即 Some），默认 [conex_compaction::CompactionPolicy::default]
    /// （keep_recent_tokens=20000 / min_recent_turns=2 / max_summary_tokens=
    /// 1024 / tool_pair_protection=true，常量同源），并经 session_meta 键
    /// 覆盖（读取键不实现 UI；坏值回退默认 + warn，不 panic）：
    /// - `compact_summary_max_tokens`（[conex_compaction::SESSION_META_KEY_COMPACT_SUMMARY_MAX_TOKENS]）
    ///   → max_summary_tokens；
    /// - `compact_keep_recent_tokens` → keep_recent_tokens（预留键）；
    /// - `compact_min_recent_turns` → min_recent_turns（预留键）。
    ///
    /// 阈值键（compact_threshold_ratio / compact_critical_ratio）属双阈值
    /// 触发面（DEEPCHECK-11 P1-6 挂账），本策略面不消费。装配后预检
    /// （maybe_compact_preflight）与溢出阶梯（compression_ladder）在生产
    /// 可触发——总闸门解除焊死。
    pub(crate) fn compaction_policy_for(
        &self,
        session_id: &str,
    ) -> Option<conex_compaction::compaction::CompactionPolicy> {
        let db = self.local_db()?;
        let policy = compaction_policy_from_session_meta(|key| {
            db.get_session_meta(key).ok().flatten()
        });
        tracing::debug!(
            target: "run",
            session_id = session_id,
            keep_recent_tokens = policy.keep_recent_tokens,
            min_recent_turns = policy.min_recent_turns,
            max_summary_tokens = policy.max_summary_tokens,
            "压缩策略装配完成（P0-1：session_meta 键覆盖 / 常量默认）"
        );
        Some(policy)
    }

    /// T-42：会话级摘要协调器（跨 run 单飞容器；注册表持有——同会话
    /// 返回同一 Arc，run 收口不摧毁任务）。config 缺省 = 生产缺省退避
    /// 参数（T-44 配置面未启用时与轮次 4 语义一致）。
    pub(crate) fn summary_coordinator_for(
        &self,
        session_id: &str,
    ) -> Arc<session_loop::SessionSummaryCoordinator> {
        let config = self
            .summary_dispatch_config(session_id)
            .unwrap_or_default();
        self.summary_coordinators.get_or_create(session_id, config)
    }

    /// T-AB-19：后台任务汇总（core_get_status.backgroundTasks 数据源；
    /// 活跃任务数 / 守护进程数 / 最近终态——口径见
    /// [RunAwareBackgroundManager::summary]）
    pub async fn background_tasks_summary(&self) -> BackgroundTasksSummary {
        self.background.summary().await
    }

    /// 共享 store（查询命令 / 集成接线用）
    pub fn store(&self) -> Arc<dyn Store> {
        Arc::clone(&self.store)
    }

    /// 30 方案 P3/P6：共享 steering 队列（与引擎
    /// [EngineHandle::timer_steering_queue] 同一实例；P6（批 3 装配轮）
    /// 经此注入 workflow 队列——消除队列双实例，对齐 [Self::store]
    /// Arc::clone 模式；消费方 = main.rs 装配轮（已接线））
    pub(crate) fn steering_queue(&self) -> Arc<Mutex<PendingMessageQueue>> {
        Arc::clone(&self.pending_queue)
    }

    /// 30 方案 P3：任务事件消费器（main.rs 装配轮接线
    /// `background_tasks.set_task_event_consumer(core_state.task_events())`——
    /// 必须在 set_event_bridge 之前调用，EventBridgeSink 构造时读取快照；
    /// 消费方 = main.rs 装配轮（已接线））
    pub(crate) fn task_events(&self) -> Arc<TaskEventConsumer> {
        Arc::clone(&self.task_events)
    }

    /// 30 方案 P6/P7：Cron 调度注册表（透传引擎句柄；None = 装配降级）。
    /// 消费方：main.rs 装配轮（P6 WorkflowBackend::set_registry）+
    /// [Self::new]（P7 cron_has_enabled 判定器装配）
    pub(crate) fn scheduler_registry(&self) -> Option<Arc<crate::sched::SchedulerRegistry>> {
        self.engine.scheduler_registry()
    }

    /// 30 方案 P4：定时器事件缓冲（main.rs drain 任务 500ms tick 取走
    /// 缓冲 → [crate::engine::forward_drained_timer_events] 转发到事件桥；
    /// 与引擎装配实例同一 Arc）
    pub(crate) fn timer_event_sink(&self) -> Arc<crate::timers::AgentEventSink> {
        self.engine.timer_event_sink()
    }

    /// 30 方案 P4：cron 事件缓冲（同 timer 的 drain 转发路径——cron-fired
    /// 单臂，cancel 走数据面 + steering 面，无 cron-cancelled 发射目标）
    pub(crate) fn scheduler_event_sink(&self) -> Arc<crate::sched::SchedEventSink> {
        self.engine.scheduler_event_sink()
    }

    /// restore 是否完成（run_task 门禁；查询命令 restore.state 数据源）
    pub fn restore_ready(&self) -> bool {
        self.restore_ready.load(Ordering::SeqCst)
    }

    // ── T-D-13：子代理 spawner 注入面装配与终态处理 ────────────────

    /// 装配 spawner 注入面（main.rs 在 Arc 构造完成后调用）：启动器
    /// （Weak 引用本状态，run 启动走 run_task_impl 同通道）、行存储
    /// （LocalDb 下转型）、wait 通道终态广播、跨 run steering 队列
    /// （主 agent 唤醒通知落点）。
    pub(crate) fn finalize_subagent_spawner(self: &Arc<Self>) {
        let launcher: Arc<dyn crate::subagent_spawner::SubagentRunLauncher> =
            Arc::new(CoreRunStateLauncher {
                state: Arc::downgrade(self),
            });
        self.subagent_spawner.init(
            Some(launcher),
            self.local_db(),
            Some(self.engine.terminal_stream()),
            Some(Arc::clone(&self.pending_queue)),
        );
    }

    /// 子代理 run 终态处理（drive_run_loop 收口调用）：终态状态映射 →
    /// spawner 统一收口（记账释放 / 行更新 / subagent-ended 发射 / wait
    /// 通道 feed / steering 通知）。
    pub(crate) async fn on_subagent_run_terminal(
        &self,
        cfg: &crate::subagent_spawner::SubagentRunConfig,
        status: conex_db::RunStatus,
    ) {
        // T-CF-13（R-CF3）：子代理终态事件到达壳层即视为一次唤醒——
        // 等待期间的关键事件源（watchdog 失联判定数据源；长等待中
        // 子代理完成事件推进 last_wakeup，防误报"无唤醒"）
        self.engine.last_wakeup().mark_wakeup();
        let state = match status {
            conex_db::RunStatus::Completed => SubagentState::Completed,
            _ => SubagentState::Failed,
        };
        self.subagent_spawner.on_subagent_terminal(cfg, state).await;
    }

    /// 子代理生命周期服务（T-D-09：kill_all / resume_subagent 命令面
    /// 依赖；db 与 [orchestrator::lifecycle::ForceCancelSink]（本状态实现）
    /// 装配；LocalDb 不可用（测试替身 store）→ None）
    #[cfg_attr(not(test), allow(dead_code))] // T-D-12 命令面消费；测试断言面消费
    pub(crate) fn lifecycle_service(
        self: &Arc<Self>,
    ) -> Option<orchestrator::lifecycle::SubagentLifecycleService> {
        let db = self.local_db()?;
        // Arc 宽化：CoreRunState 实现 ForceCancelSink → trait object 引用
        // （先克隆具体类型再宽化——编译器对 Arc::clone 的 trait object
        // 目标推断不收敛，显式两步断开）
        let this: Arc<CoreRunState> = Arc::clone(self);
        let control: Arc<dyn orchestrator::lifecycle::ForceCancelSink> = this;
        Some(orchestrator::lifecycle::SubagentLifecycleService::new(
            Arc::new(db),
            control,
        ))
    }

    /// 最近快照代数（查询命令 snapshot.generation 数据源）
    pub fn snapshot_generation(&self) -> u64 {
        self.snapshot_generation.load(Ordering::SeqCst)
    }

    /// 快照保存失败标记（P16：查询命令 snapshot.lastError 数据源）
    pub fn snapshot_last_error(&self) -> Option<String> {
        self.snapshot_last_error
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 会话级序列号 base（T08.8：预热命中缓存；未预热按库内 max+1 懒计算，
    /// 不重置为 1）
    async fn base_sequence_for(&self, session_id: &str) -> u64 {
        if let Some(next) = self
            .next_sequences
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session_id)
            .copied()
        {
            return next;
        }
        let max = self
            .store
            .query_events(session_id, 0)
            .await
            .map(|events| events.iter().map(|e| e.sequence).max().unwrap_or(0))
            .unwrap_or(0);
        let next = max + 1;
        self.next_sequences
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(session_id.to_string(), next);
        next
    }

    /// T08.8：恢复结果注入——逐会话预热序列号（库内 max(sequence)+1，
    /// 审计事件已落库口径自然含之；MAX 语义幂等）
    pub async fn seed_sequences(&self, outcome: &RestoreOutcome) {
        let sequencer = SessionSequencer::new(self.store.clone());
        for session in &outcome.sessions {
            let max = self
                .store
                .query_events(&session.session_id, 0)
                .await
                .map(|events| events.iter().map(|e| e.sequence).max().unwrap_or(0))
                .unwrap_or(0);
            let next = max + 1;
            if let Err(error) = sequencer.seed(&session.session_id, next).await {
                tracing::warn!(
                    target: "restore",
                    session_id = %session.session_id,
                    error = %error,
                    "seed_sequence 失败（base_sequence_for 懒计算兜底）"
                );
            }
            // 预热缓存写入（锁仅覆盖短临界区，不跨 await 持有——AA-02 并发模型）
            self.next_sequences
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(session.session_id.clone(), next);
        }
    }

    /// T08.6 启动接线：restore + seed + 立即快照（main.rs 在
    /// `app.manage(CoreRunState)` 之前 run_in_runtime 执行）
    ///
    /// 失败路径：restore 返回 Err → tracing error + 诊断记录
    /// （restore.state=failed），**不阻塞启动**——run 命令照常可用
    /// （事件序列锚点由 [Self::base_sequence_for] 懒计算兜底）。
    pub async fn run_restore(&self) -> Option<RestoreOutcome> {
        self.restore_started.store(true, Ordering::SeqCst);
        match RestoreManager::new()
            .restore(self.store.as_ref(), self.snapshots.as_ref())
            .await
        {
            Ok(outcome) => {
                // 1. 序列号预热（审计事件已落库口径，T08.8）
                self.seed_sequences(&outcome).await;
                // 2. 会话树注册表水合（快照会话 ∪ run 派生会话）
                self.sessions
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .extend(outcome.sessions.clone());
                // 3. 门禁放行（必须在 seed 之后：新 run 的 base 从预热值续接）
                self.restore_ready.store(true, Ordering::SeqCst);
                // 4. 恢复成功后立即保存快照（restore.rs 文档：
                //    「After successful restore (full or incremental)」）
                self.save_snapshot_now().await;
                // 恢复结果入状态域（restore_status 数据源，F2 冻结形状）
                self.restore_failed.store(false, Ordering::SeqCst);
                let mode = match outcome.mode {
                    RestoreMode::FullReplay => "full-replay",
                    RestoreMode::SnapshotIncremental => "snapshot-incremental",
                };
                *self.restore_mode.lock().unwrap_or_else(|e| e.into_inner()) =
                    Some(mode.to_string());
                *self.restore_note.lock().unwrap_or_else(|e| e.into_inner()) =
                    outcome.snapshot_note.clone();
                *self.interrupted_count.lock().unwrap_or_else(|e| e.into_inner()) =
                    outcome.interrupted.len();
                *self.restore_last_sequence.lock().unwrap_or_else(|e| e.into_inner()) =
                    Some(outcome.last_sequence);
                tracing::info!(
                    target: "restore",
                    mode = ?outcome.mode,
                    interrupted = outcome.interrupted.len(),
                    last_sequence = outcome.last_sequence,
                    snapshot_generation = outcome.snapshot_generation,
                    "重启恢复完成"
                );
                Some(outcome)
            }
            Err(error) => {
                tracing::error!(
                    target: "restore",
                    error = %error,
                    "重启恢复失败（不阻塞启动，懒计算兜底）"
                );
                self.diagnostics
                    .record("restore", false, Some(error.to_string()));
                self.restore_failed.store(true, Ordering::SeqCst);
                *self.restore_note.lock().unwrap_or_else(|e| e.into_inner()) =
                    Some(error.to_string());
                // 门禁放行：run 命令照常可用（懒计算兜底序列锚点）
                self.restore_ready.store(true, Ordering::SeqCst);
                None
            }
        }
    }

    /// T08.6 触发点 A/B/C 共用：保存快照（generation 续接；P16 失败显式标记）
    ///
    /// T3.5 D5（F2-11）：互斥入口——三触发（终态收口 / 周期 loop / 退出
    /// 钩子）全部汇入本函数；tokio Mutex 守卫跨 await 持有（build 内 store
    /// 查询与落盘均在锁内），generation 读-改-写原子化：任意时刻至多一路
    /// 在写，杜绝同进程并发交叉写（R2 §4：修复前两路同读 G 同写 G+1 +
    /// tmp 同名交叉写可致快照损坏）。std Mutex 锁不跨 await 持有（AA-02），
    /// 快照互斥必须用 tokio Mutex。
    pub async fn save_snapshot_now(&self) {
        let _guard = self.snapshot_mutex.lock().await;
        match self.build_and_save_snapshot().await {
            Ok(generation) => {
                self.snapshot_generation.store(generation, Ordering::SeqCst);
                *self.snapshot_last_error.lock().unwrap_or_else(|e| e.into_inner()) = None;
                *self.snapshot_written_at.lock().unwrap_or_else(|e| e.into_inner()) = Some(
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or_default(),
                );
                tracing::info!(target: "restore", generation, "快照已保存");
            }
            Err(error) => {
                tracing::error!(target: "restore", error = %error, "快照保存失败（P16 显式标记）");
                *self.snapshot_last_error.lock().unwrap_or_else(|e| e.into_inner()) = Some(error);
            }
        }
    }

    /// 组装并保存快照（内容：会话树注册表 + 全部 runs + 逐会话 pending +
    /// last_sequence = 全会话事件 max + 逐会话锚点；快照只是近似一致，
    /// 增量重放以锚点补足）。
    ///
    /// PERSIST-02 P1-2 门禁：restore 未完成或失败时**禁止覆盖既有快照
    /// 文件**——注册表仅在 run_restore 成功路径水合（sessions.extend），
    /// 未水合时本函数会保存「0 会话 + 全部 runs + last_sequence=0」的
    /// 半水合快照覆盖主快照，下次恢复全走派生路径（branches 空、
    /// meta None），会话树分支历史永久丢失。restore 成功后立即保存
    /// （run_restore 先置 restore_ready 再调本函数）不受影响。
    async fn build_and_save_snapshot(&self) -> Result<u64, String> {
        if !self.restore_ready.load(Ordering::SeqCst) {
            return Err("restore 未完成，跳过快照保存（防半水合快照覆盖主快照）".to_string());
        }
        if self.restore_failed.load(Ordering::SeqCst) {
            return Err("restore 失败，跳过快照保存（保留既有快照文件）".to_string());
        }
        let runs = self.store.query_runs().await.map_err(|e| e.to_string())?;
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let mut pending = Vec::new();
        let mut last_sequence = 0u64;
        // PERSIST-02 P1-1：逐会话锚点（session_id → 该会话事件 max）。
        // 事件序列为会话内独立，恢复按会话自身锚点取增量，全局 max 作
        // 会话级 base 会永久跳过落后会话的快照后事件（多会话粘性错误）。
        let mut session_last_sequence: HashMap<String, u64> = HashMap::new();
        for session in &sessions {
            let events = self
                .store
                .query_events(&session.session_id, 0)
                .await
                .map_err(|e| e.to_string())?;
            let session_max = events.iter().map(|e| e.sequence).max().unwrap_or(0);
            last_sequence = last_sequence.max(session_max);
            session_last_sequence.insert(session.session_id.clone(), session_max);
            pending.extend(
                self.store
                    .load_pending_inputs(&session.session_id)
                    .await
                    .map_err(|e| e.to_string())?,
            );
        }
        let generation = self.snapshot_generation.load(Ordering::SeqCst) + 1;
        let snapshot = StateSnapshot::build(
            generation,
            last_sequence,
            sessions,
            runs,
            pending,
            session_last_sequence,
        );
        self.snapshots
            .save_snapshot(&snapshot)
            .map_err(|e| e.to_string())?;
        Ok(generation)
    }

    /// T08.6 触发点 B：周期快照（默认 60s，`snapshot_interval_ms` 可配；
    /// 仅在存在活动 run 时保存，避免空转写）。幂等（重复调用不重复启动）。
    pub fn spawn_snapshot_loop(self: &Arc<Self>) {
        if self.snapshot_loop_running.swap(true, Ordering::SeqCst) {
            return;
        }
        let this = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let interval_ms = *this
                .snapshot_interval_ms
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let mut interval = tokio::time::interval(Duration::from_millis(interval_ms.max(1_000)));
            interval.tick().await; // 首拍立即触发（interval 首拍即完成），跳过
            loop {
                interval.tick().await;
                let has_active = this
                    .active_runs
                    .lock()
                    .map(|runs| !runs.is_empty())
                    .unwrap_or(false);
                if has_active {
                    this.save_snapshot_now().await;
                }
            }
        });
    }

    /// T08.6 触发点 C：优雅退出钩子（main.rs `RunEvent::Exit` 调用；
    /// 阻塞语义——同步事件回调内完成快照保存）
    pub fn save_snapshot_blocking(self: &Arc<Self>) {
        let this = Arc::clone(self);
        tauri::async_runtime::block_on(async move { this.save_snapshot_now().await });
    }
}

// ── T-D-13：子代理 run 启动器（Weak 引用切断 CoreRunState 类型递归）──

/// 子代理 run 启动器生产实现：经 [crate::subagent_spawner::SubagentRunLauncher]
/// trait object 调用 [run_task_impl]（core_run_task 同通道）——spawner 在
/// CoreRunState 内（engine 注入面），run 启动回调 CoreRunState，Weak 引用
/// 避免 Arc 循环强引用（进程级单例，Weak 升级失败为启动器未装配兜底）。
#[derive(Debug)]
pub(crate) struct CoreRunStateLauncher {
    /// 状态弱引用（finalize 装配时注入；主进程存活期恒可升级）
    state: std::sync::Weak<CoreRunState>,
}

#[async_trait::async_trait]
impl crate::subagent_spawner::SubagentRunLauncher for CoreRunStateLauncher {
    async fn launch(
        &self,
        options: RunTaskOptions,
    ) -> Result<RunTaskResponse, CoreError> {
        let state = self.state.upgrade().ok_or_else(|| {
            CoreError::internal("子代理 run 启动失败：CoreRunState 已释放（启动器弱引用失效）")
        })?;
        run_task_impl(state, options).await
    }
}

// ── T-D-09/T-D-13：ForceCancelSink 接线（kill_all 的引擎侧实现）────

/// L3 强停投递（[orchestrator::lifecycle::ForceCancelSink]）：按
/// subagent_run_id 定位活动 run 的控制总线，投递 L3 `request_force_cancel`
/// （reason 携带 `subagent_force_cancel:<run_id>` 可观测标识）；无该 run
/// 的运行实例（已终态 / 重启后未恢复）→ false（调用方按未终态汇总）。
impl orchestrator::lifecycle::ForceCancelSink for CoreRunState {
    fn request_force_cancel(&self, subagent_run_id: &str, reason: &str) -> bool {
        let active = self
            .active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let Some(run) = active.get(subagent_run_id) else {
            return false;
        };
        // std Mutex 不跨 await 持有：投递为同步调用，锁在语句内释放
        run.control_bus
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .request_subagent_force_cancel(subagent_run_id, Some(reason));
        true
    }
}

// ── T-CF-11：会话级 idle 待命 + 自动续 run（G7 / REQ-C04 验收 1/2）──

/// T-CF-11：生产续 run 拉起器构造（CoreRunState::new 预装配；测试经
/// set_resume_launcher 覆盖替身）。
///
/// 实现经 [ResumeLauncher] trait object（`Pin<Box<dyn Future + Send>>`
/// 叶子类型）间接引用 [run_task_impl]：drive_run_loop 与 run_task_impl
/// 相互包含 opaque future 会让 auto-trait（Send）检查无法终止（Rust
/// 限制："fetching the hidden types of an opaque inside of the defining
/// scope is not supported"）——trait object 断链后检查可终止。
fn production_resume_launcher() -> ResumeLauncher {
    let launcher: ResumeLauncher = Arc::new(|state, session_id, messages| {
        let state = Arc::clone(state);
        let session_id = session_id.to_string();
        Box::pin(async move {
            idle_resume::spawn_idle_resume_run(state, session_id, messages).await;
        })
    });
    launcher
}

//
// 独立子模块（文件内）：drive_run_loop 与 run_task_impl 相互引用 opaque
// future（drive_run_loop 收口经 spawn_idle_resume_run 拉起新 run →
// run_task_impl → spawn(drive_run_loop)），同模块内递归 async fn 的
// auto-trait（Send）检查不被 Rust 支持（"fetching the hidden types of an
// opaque inside of the defining scope"）——跨模块定义后检查可终止。
mod idle_resume {
    use super::*;

    /// 续 run 连续空转护栏上限（连续 N 次续 run 均无 AI 产出 → 停止续 run，
    /// 防空转风暴；默认 3 次）
    pub(super) const IDLE_RESUME_MAX_EMPTY_ROUNDS: u32 = 3;

    /// T-CF-11：唤醒源非空判定器（TimerRegistry 活跃 / SchedulerRegistry
    /// enabled 的判定封装；async 谓词——list_active 为 async 调用）。
    ///
    /// 生产接线：TimerRegistry 非空判定在 [CoreRunState::new] 经
    /// [EngineHandle::timer_registry] 的 list_active 封装注入；SchedulerRegistry
    /// 非空判定在 [CoreRunState::new] 经 [EngineHandle::scheduler_registry]
    /// 的 has_active 封装注入（30 方案 P7；None = 装配降级，Cron 不参与
    /// 续 run 判定，行为与接线前一致）。
    pub(crate) type WakeSourceCheck =
        Arc<dyn Fn() -> Pin<Box<dyn Future<Output = bool> + Send>> + Send + Sync>;

/// T-CF-11：idle 续 run 拉起器（async；生产 = 经 [spawn_idle_resume_run]
/// 复用 run 装配拉起新 run；测试 = 注入替身断言判定与注入载荷）
pub(crate) type ResumeLauncher = Arc<
    dyn Fn(
            &Arc<CoreRunState>,
            &str,
            Vec<AgentMessage>,
        ) -> Pin<Box<dyn Future<Output = ()> + Send>>
        + Send
        + Sync,
>;

/// T-CF-11：idle 待命续 run 判定（drive_run_loop 收口处调用）
///
/// 续 run 条件（任一满足，02-CF 方案 T-CF-11 第 1 点）：
/// - [PendingMessageQueue] 非空（跨 run steering 条目：子代理完成、定时器
///   到期、Cron 触发、watchdog 兜底通知——条目生成侧已按 §4.8 模板拼入
///   wakeup_summary 摘要文本，注入即条目原文）；
/// - TimerRegistry 存在活跃定时器（timer_has_active 判定器非空）；
/// - enabled Cron 任务（cron_has_enabled 判定器非空）。
///
/// 不续 run（硬条件与用户语义）：
/// - run 非正常收场（reason != Stop：Aborted / Stopped = 用户取消，
///   Error / MaxTurns = 异常边界，保守不续）；
/// - 用户显式结束：force_cancel（abort_signal 触发，双保险）/ 用户消息
///   到达后的正常收场（本 run 有用户 L1 交互，user_touched）；
/// - 三源全空（队列空 + 定时器表空 + Cron 表空）→ run 正常收场，AI 休眠
///   待用户（T-CF-11 第 3 点开放问题 4）；
/// - 续 run 连续 N 次（默认 3 次）均无 AI 产出 → 停止续 run（防空转风暴）
///   并记日志。
///
/// 返回：None = 不续 run；Some(messages) = 续 run（messages = 队列条目
/// 批量转出的注入消息；空 Vec = 仅定时器/Cron 源触发——无队列条目文本
/// 可注入，仍续 run 保持待命，事件条目入队后经下一次收口送达）。
pub(crate) async fn decide_idle_resume(
    state: &CoreRunState,
    active: &ActiveRun,
    reason: AgentEndReason,
    had_ai_output: bool,
) -> Option<Vec<AgentMessage>> {
    // 1. 用户取消 / 异常收场不续（force_cancel → abort_signal + reason
    //    Aborted/Stopped；判定双保险）
    if active.abort_signal.is_aborted() || reason != AgentEndReason::Stop {
        return None;
    }
    // 2. 用户消息到达后的正常收场不续（本 run 内经 L1 收到用户消息）
    if active.user_touched.load(Ordering::SeqCst) {
        return None;
    }
    // 3. 唤醒源判定：队列（首要唤醒源）非空直接命中；否则查定时器 /
    //    Cron 判定器（锁内取克隆，锁不跨 await 持有——AA-02 并发模型）
    let queue_pending = {
        let queue = state
            .pending_queue
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        queue.has_pending()
    };
    let timer_check = state
        .timer_has_active
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let timer_active = if !queue_pending {
        match timer_check {
            Some(check) => check().await,
            None => false,
        }
    } else {
        false
    };
    let cron_check = state
        .cron_has_enabled
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let cron_enabled = if !queue_pending && !timer_active {
        match cron_check {
            Some(check) => check().await,
            None => false,
        }
    } else {
        false
    };
    if !(queue_pending || timer_active || cron_enabled) {
        // 4. 三源全空：run 正常收场，AI 休眠待用户（硬条件）
        return None;
    }
    // 5. 空转护栏（仅续 run 路径计数）：本 run 有 AI 产出 → 清零；
    //    否则 +1，连续 N 次（默认 3 次）无产出 → 停止续 run 并记日志
    {
        let mut streak = state
            .resume_empty_streak
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let entry = streak.entry(active.session_id.clone()).or_insert(0);
        if had_ai_output {
            *entry = 0;
        } else {
            *entry += 1;
            if *entry > IDLE_RESUME_MAX_EMPTY_ROUNDS {
                tracing::info!(
                    target: "run",
                    session_id = %active.session_id,
                    consecutive_empty = *entry,
                    limit = IDLE_RESUME_MAX_EMPTY_ROUNDS,
                    "idle 续 run 停止：连续 N 次无 AI 产出（防空转风暴）"
                );
                return None;
            }
        }
    }
    // 6. 队列条目批量转出为注入消息（无队列条目 = 仅定时器/Cron 源，
    //    空注入保持待命）
    if queue_pending {
        let mut queue = state
            .pending_queue
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        return Some(drain_pending_to_inject_messages(&mut queue, &active.session_id));
    }
    Some(Vec::new())
}

/// T-CF-11：PendingMessageQueue 条目批量转出 → 注入消息（对齐 D07 批量
/// 推送：一次续 run 承载全部条目，不逐条唤醒）。
///
/// 注入文本 = 队列条目原文（生成侧已按 §4.8 模板拼入 wakeup_summary
/// 摘要，与 prompt 并存）；多条条目按序拼接（换行分隔）为一条用户角色
/// 消息——对齐 D8「条目作为下一条用户消息注入」语义（steering_queue.rs
/// :86-106，注入消息带 `{kind:"steering"}` 元数据供下游识别）。
/// 消息 id 沿用首条条目 id 保证幂等（对齐 transfer_follow_up 的 id 沿用）。
fn drain_pending_to_inject_messages(
    queue: &mut PendingMessageQueue,
    _session_id: &str,
) -> Vec<AgentMessage> {
    let entries = queue.dequeue_all();
    if entries.is_empty() {
        return Vec::new();
    }
    let text = entries
        .iter()
        .map(|entry| entry.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let first = &entries[0];
    vec![AgentMessage {
        id: first.id.clone(),
        role: AgentMessageRole::User,
        created_at: crate::engine::now_iso_utc(),
        blocks: vec![AgentMessageBlock::Text { text }],
        metadata: Some(serde_json::json!({ "kind": "steering" })),
        client_message_id: None,
        content: None,
    }]
}

/// T-CF-11：idle 续 run 拉起（收口处判定命中后调用）——复用
/// [run_task_impl] 的 run 装配拉起新 run（新 run id / 新 producer /
/// 新 ActiveRun / 新 drive_run_loop；history 回退 SessionHistoryCache，
/// 上一轮收口已缓存——历史自动续接，T-29 混合路线）。
///
/// prompt = 注入消息文本（队列条目批量聚合；仅定时器/Cron 源触发时为
/// 空文本——AI 醒来保持待命态，等待事件条目入队后经下一次收口送达）；
/// mode 标记 `idle-resume`（可观测：前端区分自动续 run 与用户发起的
/// run）。失败仅告警不重试（下一收口再判定；空转护栏防风暴）。
pub(crate) async fn spawn_idle_resume_run(
    state: Arc<CoreRunState>,
    session_id: String,
    inject: Vec<AgentMessage>,
) {
    let text = inject
        .iter()
        .map(|message| message.text())
        .collect::<Vec<_>>()
        .join("\n");
    let options = RunTaskOptions {
        run_id: crate::engine::new_message_id("idle-resume"),
        session_id: session_id.clone(),
        prompt: Some(text),
        mode: Some("idle-resume".to_string()),
        cwd: None,
        permission_mode: None,
        client_message_id: None,
        assistant_client_message_id: None,
        system_prompt: None,
        history: None,
        context_window: None,
        parent_run_id: None,
        // T-D-13：续 run 为普通 run（子代理配置仅 spawner 构造）
        subagent_config: None,
    };
    if let Err(error) = run_task_impl(Arc::clone(&state), options).await {
        tracing::warn!(
            target: "run",
            session_id,
            error = %error,
            "idle 续 run 拉起失败（下一收口再判定；空转护栏防风暴）"
        );
    }
}

// ── drive_run_loop ────────────────────────────────────────────────

/// run 驱动循环（B6.1：produce → drive_outcome → emit → 终态）
///
/// 流程（T09.2 步骤 4/5：by value 零克隆）：
/// 1. `produce`（[RunProducer]）→ [RunOutcome]；
/// 2. [orchestrator::events::drive_outcome]：事件入队（sequence 会话级
///    原子分配，delta 不阻塞）+ 终态收口（run-terminal 唯一一次）；
/// 3. 事件 emit：信封 runId/sequence 注入（03 §5.3-2/6）；**T09.1 后收口
///    message-delta 跳过不双发**（实时轨已发，sequence=None；前端按
///    messageId 幂等累加）；
/// 4. cursor 发布：drive_outcome 已更新 run.cursor（终态游标 = 最后事件
///    sequence，T08.4），终态记录落库；
/// 5. 终态：移出活动注册表 + 快照（T08.6 触发点 A）；
/// 6. 错误路径：drive 失败（防御性）→ [finalize_failed]。
pub(crate) async fn drive_run_loop(
    state: Arc<CoreRunState>,
    active: Arc<ActiveRun>,
    mut producer: Box<dyn RunProducer>,
) {
    let session_id = active.session_id.clone();
    let run_id = active.run_id.clone();
    // span 约定（26-frontend-observability-audit.md：drive_run_loop 入口
    // info_span!("run", session_id, run_id)，引擎各阶段统一字段名）
    let span = tracing::info_span!("run", session_id = %session_id, run_id = %run_id);
    let _enter = span.enter();
    tracing::info!("drive_run_loop 启动");

    // 1. produce（单次即覆盖整个 run：多 turn 由 AgentSessionLoop 内部驱动；
    //    未来 goal 多轮模式在本循环续轮）
    let outcome = producer.produce().await;
    // 产出完成即释放生产者：其持有的 options（含逃逸监视配置引用 →
    // 审计桥引用）随 Drop 归还——审计落库 worker 的通道关闭时点
    // 确定性依据（收口 await 排空不依赖生产者存活，L4）
    drop(producer);
    // T-CF-11：产出信号提前捕获（outcome 随后被 drive_outcome 消费——
    // reason / turn_index / tool_call_count 为 Copy 字段，收口判定用）
    let resume_reason = outcome.reason;
    let resume_turn_index = outcome.turn_index;
    let resume_tool_calls = outcome.tool_call_count;

    // T-29 收口写入（P4 阶段 1-4）：run 引擎侧收口后，把对话消息收口为
    // HistoryMessage 原子替换 SessionHistoryCache——不落库、不改写会话语义
    // （混合路线核心）；缓存 = 下次 run 的 history 参数回退源；压缩后序列
    // 随收口自然携带（缓存基线重建，P4 §3.6 I5 / C13）
    state.session_history.store(&session_id, to_history_messages(&outcome));

    // T-40 缓存测量收口（P5 S5 §3.2 数据流，R5-D3 轮末合并接线 ②）：
    // outcome.cache_stats 非空（tracker.finish 产物，T-36）→ 会话级状态
    // 写回（下一 run 冷缓存预警 / 模型切换检测）+ save_run_usage 落库
    // （runs 表 v5 列，T-39）——实现细节见 [write_back_cache_stats]
    if let Some(stats) = &outcome.cache_stats {
        write_back_cache_stats(&state, &session_id, &run_id, *stats).await;
    }

    // 2. drive_outcome（锁在作用域内持有，错误路径先释放再收口）
    let driven = {
        let mut run = active.handle.lock().await;
        let mut queue = active.queue.lock().await;
        drive_outcome(&mut run, &mut queue, outcome).await
    };

    let driven = match driven {
        Ok(driven) => driven,
        Err(error) => {
            // 防御性：终态不可再驱动（已有终态 / 异常收口）→ 失败收场
            tracing::error!(
                target: "run",
                error = %error,
                "drive_outcome 失败（防御性收口）"
            );
            // T-ESC-03：失败收口同样停止监视 + flush 剩余事件
            // （run 中崩溃不泄漏监视任务，REQ §5.4 风险缓解）
            let escape_handle = active
                .escape_watch
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take();
            if let Some(mut handle) = escape_handle {
                handle.shutdown().await;
            }
            finalize_failed(&state, &active, &error.to_string()).await;
            return;
        }
    };

    // 3. 事件 emit（信封 runId/sequence 注入；缓冲桥组装背压）
    let mut report = EmitReport::default();
    let mut runtime_error: Option<String> = None;
    for sequenced in driven.events {
        // T-CF-13（R-CF3）：事件收口旁路点 mark_wakeup 接线——任何事件
        // 到达即更新 last_wakeup（watchdog 失联判定数据源；子代理等待
        // 期间有事件到达则不误报"无唤醒"）
        state.engine.last_wakeup().mark_wakeup();
        // T09.1：实时轨已发 delta，收口流 message-delta 跳过不双发
        // （序列号已分配；持久化不落库；前端按 messageId 累加，AA-06 F1）
        if active.delta_sink_active && matches!(sequenced.event, AgentEvent::MessageDelta { .. }) {
            continue;
        }
        // T04.5-1：事件桥 runtime-error 事件处写入 lastError
        if let AgentEvent::RuntimeError { error, .. } = &sequenced.event {
            runtime_error = Some(error.clone());
        }
        let envelope = AgentEventEnvelope::new(
            sequenced.event,
            Some(run_id.clone()),
            Some(sequenced.sequence),
        );
        report.add(active.bridge.emit(&envelope));
    }
    if let Some(error) = runtime_error {
        state
            .diagnostics
            .set_last_error(crish_payload_from_message(&error));
    }
    report.add(active.bridge.flush());
    tracing::info!(
        target: "run",
        emitted = report.emitted,
        dropped = report.dropped,
        "事件发射完成（缓冲桥）"
    );

    // T-ESC-03 run 收口钩子：停止监视 + flush 剩余事件（聚合补发最后
    // 一条报告——审计经桥广播，注入经 followUp 环落会话，REQ §3.5.1）
    let escape_handle = active
        .escape_watch
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    if let Some(mut handle) = escape_handle {
        handle.shutdown().await;
    }

    // 4-5. 终态：移出注册表 + 快照（T08.6 触发点 A；cursor 已由
    //      drive_outcome 维护并在 finalize 落库）
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&run_id);
    // 15-T-6（裁决 D9）：工具级审计路由收口注销（run 级桥随 run 结束
    // 释放，防 session 泄漏；与 escape_watch 句柄同生命周期收口——
    // 重复注销幂等，finalize_failed 失败路径不重复进入本函数）
    state.engine.audit_sink().unregister(&session_id);
    // L4（F12）：审计落库收口——注销即释放桥引用（sender drop 发出
    // 通道关闭信号），await worker 排空全部审计事件再报 run 终态
    // （审计底账在终态前完整落库；None = 测试驱动路径未装配）。
    // 先 take 出句柄再 await：std Mutex 锁不跨 await 持有（AA-02）
    let audit_worker = active
        .audit_persist
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    if let Some(handle) = audit_worker {
        let _ = handle.await;
    }
    // T-AB-19 run 终态显式接线：**不清理后台任务注册表、不级联杀任务**
    // ——任务属会话级（registry 生命周期独立于 run，T-AB-12 只读契约升级
    // 为显式收口契约；run_end_daemon_survives / run_end_normal_task_survives
    // _no_cascade 测试锚定）。守护任务（is_daemon=true）与普通任务在 run
    // 终态后均持续运行、日志持续累积；会话切换同理不受影响。此处仅释放
    // 「当前 run」上下文（owner_run_id 注入槽，供下一 run 复用）。
    state.background.clear_current_run(&run_id);
    // T-D-13：spawner 侧 run 上下文释放（当前活动 run 定位槽）
    state.subagent_spawner.clear_current_run(&session_id, &run_id);

    // ── T-D-13：子代理 run 终态收口（记账释放 / 行更新 / subagent-ended
    // 发射 / wait 通道 feed / steering 通知）──
    // 须在 decide_idle_resume 之前完成：steering 条目入队后，收口判定
    // 「队列非空」→ 主 agent 下一 run 自动唤醒收到子代理完成通知。
    if let Some(cfg) = active.subagent.clone() {
        let terminal_status = {
            let run = active.handle.lock().await;
            run.status.clone()
        };
        state
            .on_subagent_run_terminal(&cfg, terminal_status)
            .await;
    }

    state.save_snapshot_now().await;
    tracing::info!(
        target: "run",
        run_id = %run_id,
        "drive_run_loop 收口（终态）：后台任务注册表未清理、任务不级联杀（T-AB-19 契约）"
    );

    // ── T-CF-11：idle 待命续 run（收口处判定；run 正常结束而非用户取消）──
    // 唤醒源：PendingMessageQueue 非空（跨 run steering 条目）/ 活跃定时器 /
    // enabled Cron（判定器注入）；三源全空 → AI 休眠待用户。队列条目批量
    // 转出注入新 run（对齐 D07 批量推送），摘要文本已由生成侧按 §4.8
    // 模板拼入条目原文。空转护栏：连续 3 次续 run 无 AI 产出 → 停止。
    //
    // T-D-13：**子代理 run 不参与 idle 待命续 run**——子代理是一次性任务，
    // 收口即完成（终态通知已由 [Self::on_subagent_run_terminal] 发出）；若
    // 子代理收口也判定 idle 续 run，会消费自己入队的 steering 条目造成
    // 自续循环（靠空转护栏刹停，浪费模型调用）。steering 条目保留在队列，
    // 由主 agent 会话的收口消费（通知链路完整）。
    if active.subagent.is_none() {
        if let Some(inject) = decide_idle_resume(
            &state,
            &active,
            resume_reason,
            // 「有 AI 产出」= 完成过 turn 或执行过工具（空转 run 两者皆 0）
            resume_turn_index > 0 || resume_tool_calls > 0,
        )
        .await
        {
            tracing::info!(
                target: "run",
                session_id = %session_id,
                run_id = %run_id,
                inject_messages = inject.len(),
                "idle 待命命中：自动续开一轮 run（队列条目批量注入 / 定时器 / Cron 源）"
            );
            let launcher = state
                .resume_launcher
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            match launcher {
                Some(launcher) => launcher(&state, &session_id, inject).await,
                None => {
                    // 防御分支：拉起器未注入（生产恒注入——CoreRunState::new
                    // 预装配生产拉起器，见 [production_resume_launcher]）。
                    // 不在此处直接引用 run_task_impl：drive_run_loop 与
                    // run_task_impl 相互包含 opaque future 会让 auto-trait
                    // 检查无法终止（Rust 限制）——经 trait object 拉起器
                    // （叶子类型）切断类型递归。未注入时跳过续 run 并记日志。
                    tracing::warn!(
                        target: "run",
                        session_id = %session_id,
                        run_id = %run_id,
                        "idle 续 run 拉起器未注入（跳过本轮续 run）"
                    );
                }
            }
        }
    }
} // drive_run_loop 收口闭
} // mod idle_resume 闭合（drive_run_loop 与 run_task_impl 的 opaque
  // future 跨模块定义 + trait object 拉起器切断类型递归，Send 检查可终止）

/// T-CF-11 / drive_run_loop 子模块 re-export（drive_run_loop 与
/// run_task_impl 相互引用 opaque future，跨模块定义后 Send 检查可终止；
/// 外层与测试经此引用）
use idle_resume::{ResumeLauncher, WakeSourceCheck, drive_run_loop};
#[cfg(test)]
use idle_resume::decide_idle_resume;

/// T-40 缓存测量收口（P5 S5 §3.2 数据流，R5-D3 轮末合并接线 ②；
/// 拆分独立函数以便测试直测）：
///
/// 1. **会话级状态写回**：经 `state.engine.update_cache_session` 写入
///    EngineHandle（下一 run 冷缓存预警 / 模型切换检测数据源；内存态
///    跨 run 续接，跨重启由 runs 表 v5 列兜底，T-39）。跟踪配置缺失
///    （provider 未就绪/重载）时跳过写回——本 run 已无跟踪上下文，
///    仅告警不中断收口；
/// 2. **save_run_usage 落库**：runs 表 v5 列幂等 UPDATE（T-39；
///    core_get_run_snapshot.usage 查询数据面）。db 经 [CoreRunState::local_db]
///    从 store 下转型取得——非 LocalDb 实现（InMemoryStore 测试替身）
///    跳过落库。写路径走 `spawn_blocking`（P05：消除同步直调对 tokio
///    worker 的阻塞，与 session_commands.rs 既有模式一致）。
///
/// 失败仅告警不中断收口（usage 查询面回退前端估算，contract 约定）。
async fn write_back_cache_stats(
    state: &CoreRunState,
    session_id: &str,
    run_id: &str,
    stats: RunCacheStats,
) {
    if let Some(config) = state.engine.cache_tracking_config() {
        state.engine.update_cache_session(session_id, &stats, &config.model);
    } else {
        tracing::warn!(
            target: "run",
            run_id,
            "收口缓存统计但缓存跟踪配置缺失（跳过会话级状态写回）"
        );
    }
    let Some(db) = state.local_db() else {
        return;
    };
    let run_id_owned = run_id.to_string();
    match tokio::task::spawn_blocking(move || db.save_run_usage(&run_id_owned, stats)).await {
        Ok(Ok(())) => {}
        Ok(Err(failure)) => {
            tracing::warn!(
                target: "run",
                run_id,
                error = %failure,
                "save_run_usage 落库失败（usage 查询回退前端估算）"
            );
        }
        Err(join_error) => {
            tracing::warn!(
                target: "run",
                run_id,
                error = %join_error,
                "save_run_usage spawn_blocking join 失败（usage 查询回退前端估算）"
            );
        }
    }
}

/// 错误路径收口（四源失败 / 防御性驱动失败）
///
/// - runtime-error 事件（持久化，03 §2.4 四源失败收口）；
/// - run 标记 failed（event-store-write-failed 语义，不假装可回放）；
/// - 终态事件尽力发出（run-terminal 唯一终态，03 §5.2-2）；
/// - lastError 写入（T04.5-1：finalize_failed 写入点）。
async fn finalize_failed(state: &Arc<CoreRunState>, active: &ActiveRun, message: &str) {
    // T-ESC-03：失败收口兜底停止监视 + flush（drive 错误分支已收口
    // 时此处幂等跳过——句柄经 take 已取出）
    let escape_handle = active
        .escape_watch
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    if let Some(mut handle) = escape_handle {
        handle.shutdown().await;
    }

    let session_id = active.session_id.clone();
    let run_id = active.run_id.clone();
    let mut run = active.handle.lock().await;
    let mut queue = active.queue.lock().await;

    // runtime-error 事件（持久化）
    let _ = queue
        .push(
            &session_id,
            AgentEvent::RuntimeError {
                session_id: session_id.clone(),
                timestamp: crate::engine::now_iso_utc(),
                error: message.to_string(),
                retryable: None,
            },
        )
        .await;

    // run 标记 failed（不假装可回放）
    if let Err(error) = run.fail_event_store(queue.store(), message).await {
        tracing::error!(
            target: "run",
            error = %error,
            "finalize_failed：fail_event_store 失败"
        );
    }

    // 终态事件尽力发出（唯一终态事件）
    let terminal = build_run_terminal(&run, RunTerminalStatus::Failed, Some(message.to_string()));
    let sequenced = queue.push_terminal_best_effort(&session_id, terminal).await;
    let envelope = AgentEventEnvelope::new(
        sequenced.event,
        Some(run_id.clone()),
        Some(sequenced.sequence),
    );
    active.bridge.emit(&envelope);
    active.bridge.flush();

    // lastError（T04.5-1 写入点）
    state
        .diagnostics
        .set_last_error(crish_payload_from_message(message));

    drop(queue);
    drop(run);
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&run_id);
    // 15-T-6（裁决 D9）：失败收口同样注销工具级审计路由（防泄漏；
    // drive 错误分支未走 drive_run_loop 正常收口，本处兜底——重复
    // 注销幂等）
    state.engine.audit_sink().unregister(&session_id);
    // L4（F12）：失败收口同样排空审计落库 worker（注销即释放桥引用
    // 发出通道关闭信号；await 保证失败收口前审计底账完整落库；
    // None = 测试驱动路径未装配）。先 take 出句柄再 await：
    // std Mutex 锁不跨 await 持有（AA-02）
    let audit_worker = active
        .audit_persist
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    if let Some(handle) = audit_worker {
        let _ = handle.await;
    }
    // T-AB-19 失败收口显式接线（与成功收口同一契约）：不清理后台任务
    // 注册表、不级联杀任务——任务属会话级；仅释放「当前 run」上下文。
    state.background.clear_current_run(&run_id);
    // T-D-13：spawner 侧 run 上下文释放 + 子代理终态收口（防御性失败
    // 路径同样归一 failed——记账释放 / 行更新 / 事件发射 / 通知面）
    state.subagent_spawner.clear_current_run(&active.session_id, &run_id);
    if let Some(cfg) = active.subagent.clone() {
        state
            .on_subagent_run_terminal(&cfg, conex_db::RunStatus::Failed)
            .await;
    }
    state.save_snapshot_now().await;
}

/// 错误文案 → CrishErrorPayload（lastError 槽载荷；77 码显式兜底）
fn crish_payload_from_message(message: &str) -> CrishErrorPayload {
    CrishError::new(codes::COMMON_UNKNOWN, message.to_string()).to_error_payload(0)
}

/// 活动 run 查找（命令入口共用）
fn active_run(state: &CoreRunState, run_id: &str) -> Result<Arc<ActiveRun>, CoreError> {
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(run_id)
        .cloned()
        .ok_or_else(|| CoreError::NotFound(format!("run 不存在或已终态：{run_id}")))
}

/// 逃逸监视根解析（30-P5 共用 helper，与 loop 装配块 with_options 解析链
/// 同源：workspace_root → cwd → 当前目录；壳层 workspace_root 恒 None，
/// 等效 cwd → current_dir）。
///
/// run 装配面的三处根解析共用本函数（单一真源，杜绝双处漂移复发——
/// 00 风险 2）：逃逸监视 spawn 根 / 共享写路径注册表根 / 子代理沙箱根。
/// None（无 cwd）时监视不启动、注册表以 current_dir 为根、run 装配不
/// panic（E2E-3 无 cwd 分支）。
fn resolve_escape_watch_root(cwd: Option<&str>) -> PathBuf {
    cwd.map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

// ── 命令：core_run_task ───────────────────────────────────────────

/// 发起一次 run（03 §3.2 A 组；返回 {runId, sessionId} 回执）
///
/// 流程：门禁（restore 完成 + engine 就绪 + 会话内串行）→ start_run →
/// EventQueue（base = 预热/懒计算 max+1，T08.8）→ 装配
/// （approval 门 / BridgeDeltaSink / SessionLoopProducer）→ spawn
/// [drive_run_loop]。system_prompt 入站经 build_system_prompt 规范化一次
/// （P1 B1：trim + 空值 → None），全链透传原始。
///
/// T-29（P4 阶段 1-3/1-4）：新增 `history`（前端 store 已完成消息，
/// 冷启动水合兜底）与 `context_window`（生效模型窗口元数据，P3 目录
/// 接线前由前端下发；T-33 预算钳制消费）。混合路线（P4 §3.2.3）：
/// 前端 history 为空/未传时回退引擎侧 SessionHistoryCache（缓存主，
/// run 收口写入的权威增量）；两者皆空 = 现状单消息 run（向后兼容）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunTaskOptions {
    pub run_id: String,
    pub session_id: String,
    pub prompt: Option<String>,
    pub mode: Option<String>,
    pub cwd: Option<String>,
    pub permission_mode: Option<String>,
    pub client_message_id: Option<String>,
    pub assistant_client_message_id: Option<String>,
    pub system_prompt: Option<String>,
    pub history: Option<Vec<HistoryMessage>>,
    pub context_window: Option<u32>,
    /// 父 run 归属（T-D-14 权限传递层，F11 T-D-13 spawner 装配时携带）：
    /// None = 主 agent run / 无父 run（审批裁决者 = 用户，现状不变）；
    /// Some = 子代理 run 的父 run id（审批请求路由给主 agent 裁决）
    pub parent_run_id: Option<String>,
    /// 子代理 run 装配配置（T-D-13：仅引擎内部 spawner 构造；IPC 命令面
    /// 不携带——serde 缺省 None = 普通 run，装配行为与现状一致）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_config: Option<crate::subagent_spawner::SubagentRunConfig>,
}

#[tauri::command]
pub(crate) async fn core_run_task(
    state: tauri::State<'_, Arc<CoreRunState>>,
    options: RunTaskOptions,
) -> Result<RunTaskResponse, CoreError> {
    run_task_impl(Arc::clone(state.inner()), options).await
}

/// estop 桥装配判定（31 评审 F2 / 30 评审 H-2 邻接）：**仅主 run 装配**——
/// 子代理 run 不 reset_estop、不挂 watcher。故障链：子代理 run 被取消
/// （L3/超时/kill_all）→ watcher 触发 cancel_estop → 急停旗置位 → 主 run
/// 本 run 剩余全部 browser_* 命令被 EmergencyStop 拒绝且同 run 无复位点
/// （浏览器操作整段失效，直到下一 run 启动）。browser_* 工具已按 27 §3
/// 从子代理注册面剔除（F1，readonly.rs filter_registry_for_task_type），
/// 子代理无 estop 消费方，装配即纯风险。
fn assemble_browser_estop(
    subagent_config: &Option<crate::subagent_spawner::SubagentRunConfig>,
) -> bool {
    subagent_config.is_none()
}

/// run 任务命令体（core_run_task 与 T-CF-11 idle 续 run 共用装配路径；
/// 测试可直调，不依赖 Tauri runtime——对齐 background.rs「契约体」模式）。
/// owned Arc 参数：future 内不持有引用，保证 Send（spawn 任务内可 await）。
pub(crate) async fn run_task_impl(
    state: Arc<CoreRunState>,
    options: RunTaskOptions,
) -> Result<RunTaskResponse, CoreError> {
    let state = Arc::clone(&state);
    // 参数校验（S-15：trim + 显式 InvalidInput）
    let run_id = options.run_id.trim().to_string();
    let session_id = options.session_id.trim().to_string();
    let prompt = options.prompt;
    let mode = options.mode;
    let cwd = options.cwd;
    let permission_mode = options.permission_mode;
    let client_message_id = options.client_message_id;
    let assistant_client_message_id = options.assistant_client_message_id;
    let system_prompt = options.system_prompt;
    let history = options.history;
    let context_window = options.context_window;
    // T-D-13：子代理 run 装配配置（None = 普通 run，装配行为与现状一致）
    let subagent_config = options.subagent_config;
    // T-D-14：父 run 归属（审批裁决者路由 + spawner 侧 run 注册表——先于
    // SessionLoopOptions 遮蔽取出，避免「options 已被 move」借用错误）
    let parent_run_id = options.parent_run_id.clone();

    if run_id.is_empty() || session_id.is_empty() {
        return Err(CoreError::invalid_input("runId / sessionId 不能为空"));
    }
    // T08.6 门禁：restore 完成前拒绝新 run（Q24 竞态：杜绝「新 run 先算
    // base、restore 后写审计事件」）
    if !state.restore_ready() {
        return Err(CoreError::internal("restore in progress：等待重启恢复完成"));
    }
    // engine 未就绪（provider 配置缺失）拒绝发起
    if !state.engine.ready() {
        let reason = state
            .engine
            .ready_reason()
            .unwrap_or_else(|| "engine not ready".to_string());
        return Err(CoreError::internal(reason));
    }
    // 会话内串行守卫（同会话同时只允许一个活动 run）
    {
        let active = state.active_runs.lock().unwrap_or_else(|e| e.into_inner());
        if active.values().any(|run| run.session_id == session_id) {
            return Err(CoreError::invalid_input(format!(
                "会话 {session_id} 已有活动 run（串行守卫）"
            )));
        }
    }
    // provider / 工具注册表（engine 生效配置）
    let Some(provider) = state.engine.provider() else {
        return Err(CoreError::internal("engine not ready（provider 配置缺失）"));
    };
    // T-D-13：子代理 run 的工具注册表按 task_type 默认权限集裁剪
    // （filter_registry_for_task_type，T-D-08 fail-closed 白名单）+ 剔除
    // run_subagent（T-D-02 工具面防护：子代理无派发能力，防浪费非安全
    // 边界；守卫层 NestingDenied 兜底）。普通 run 保持引擎共享注册表。
    let base_registry = state.engine.tool_registry();
    let tool_registry = match &subagent_config {
        Some(config) => {
            let task_type_wire = config.task_type.as_deref().unwrap_or("analysis");
            let filtered = agent_tools::readonly::filter_registry_for_task_type(
                &base_registry,
                task_type_wire,
            )
            .map_err(|error| {
                CoreError::internal(format!("子代理工具集裁剪失败：{error}"))
            })?;
            let filtered = agent_tools::readonly::filter_registry(&filtered, |name| {
                name != agent_tools::tools::subagent::SUBAGENT_SPAWNER_TOOL_NAME
            })
            .map_err(|error| {
                CoreError::internal(format!("子代理工具集剔除失败：{error}"))
            })?;
            Arc::new(filtered)
        }
        None => base_registry,
    };

    // 注册 run（queued → initializing → running，落库）
    let handle = state
        .run_manager
        .start_run(&session_id, &run_id)
        .await
        .map_err(crate::core_error::map_run_err)?;
    let handle_shared = Arc::new(tokio::sync::Mutex::new(handle));

    // 事件队列（base = 预热/懒计算 max+1，T08.8：不重置为 1）
    let base = state.base_sequence_for(&session_id).await;
    let queue = Arc::new(tokio::sync::Mutex::new(EventQueue::new(
        state.store.clone(),
        base,
    )));

    // 本 run 的缓冲事件桥（gate 广播 / delta sink / 收口 emit 共用）
    let bridge = Arc::new(BufferedRunEventBridge::new(
        state.bridge.clone(),
        run_id.clone(),
    ));

    // 审批门广播（approval-requested 实时预览：信封 sequence=None）
    let broadcast_bridge = Arc::clone(&bridge);
    let broadcast_run_id = run_id.clone();
    let broadcast = Box::new(move |event: AgentEvent| {
        let envelope = AgentEventEnvelope::new(event, Some(broadcast_run_id.clone()), None);
        broadcast_bridge.emit(&envelope);
        broadcast_bridge.flush();
    });
    // 死锁检测器（F9-05）待接：with_deadlock_detector 的 detector 需要
    // 「主 agent 正在 wait 该子代理」信号源——引擎侧尚无 orchestrator 子
    // 代理跟踪器的 await 态标记（approval_router.rs:41-45 自述的 F11
    // T-D-13 引擎接线未落地）。缺省 None = 恒走纯超时兜底（120s Expired），
    // 行为与现状一致；信号源落地后在此注入。
    let approval_gate = Arc::new(ApprovalGateImpl::new(
        run_id.clone(),
        session_id.clone(),
        // T-D-14：父 run 归属（子代理 run 由 spawner 携带；None = 主 agent）
        parent_run_id.clone(),
        broadcast,
        Arc::clone(&handle_shared),
        state.store.clone(),
        cwd.clone(),
    ));

    // permissionMode：full-access 不启用审批；其余（ask / plan）启用
    let approval_enabled = permission_mode.as_deref() != Some("full-access");
    let approval: Option<Arc<dyn ApprovalGate>> = if approval_enabled {
        Some(Arc::clone(&approval_gate) as Arc<dyn ApprovalGate>)
    } else {
        None
    };

    // T09.1 实时 delta 双轨：BridgeDeltaSink 注入 SessionLoopProducer
    // （core_run_commands.rs:667-716 装配，PE-09 T09.1.2 步骤 4）
    let delta_sink: Arc<dyn DeltaSink> = Arc::new(BridgeDeltaSink::new(
        Arc::clone(&bridge),
        run_id.clone(),
    ));

    // ── T-29 context_window 入站（P4 §3.3.2）──────────────────────
    // 生效模型窗口 → ContextBudget（reserve/safety 取默认）；经
    // SessionLoopOptions.context_budget 透传（T-30 装配，T-33 预算层
    // 消费钳制与预检）。DEEPCHECK-06 P0：子代理 run 的窗口入站由引擎
    // 按生效模型 catalog 解析（spawner 路径前端参数不可达，context_window
    // 恒 None——resolve_context_budget 的 subagent 兜底臂，与主会话前端
    // resolveContextWindow 的 catalog 兜底同源）。
    let context_budget = resolve_context_budget(context_window, &subagent_config, &state.engine);
    if let Some(budget) = context_budget {
        tracing::debug!(
            target: "run",
            session_id = %session_id,
            context_window = budget.context_window,
            reserve_tokens = budget.reserve_tokens,
            "context_window 入站（T-33 预算钳制消费）"
        );
    }

    // 循环选项（cwd / assistant clientMessageId / 幂等；21-log §5.2 回补）
    // P1 B1：systemPrompt 入站规范化一次（trim + 空值 → None），全链透传原始
    // P4 T-30：context_budget 装配进 options（预算钳制 + 预检压缩消费入口）

    // ── T-ESC-03 P3 装配面：逃逸监视启动钩子（run 开始）──────────
    // 监视根 = cwd（工作目录，run 驱动的工作区根）；watcher.start →
    // 消费任务 spawn（聚合 → 审计发射 + 主 agent 注入，REQ §3.5.1），
    // 句柄绑定 ActiveRun 随 run 收口（shutdown = stop + flush 剩余）。
    // 监视启动失败仅告警不阻断 run（监视是追踪面，REQ §3.6 不阻断）。
    //
    // 30-P5 时序更正（A4-H1 / C-36 假闭环消除）：判定器在本装配点直接
    // 注入（spawn_escape_watch 的 config 是值传递，装配后即就位，不再
    // 依赖 loop 侧 with_options 的配置副本）——detector 与 write_claims
    // 同一 registry 实例（双端注入成对，评审清单项）：
    // - 工具执行面声明写路径（options.write_claims 注入共享注册表）→
    //   声明覆盖静默（审计不误报）；
    // - 声明释放 / 未声明写入 → 上报（未声明写审计）。
    //
    // 15-T-6（裁决 D9）：run 级审计桥实例（工具级审计路由与逃逸监视
    // 共用——同一 run 缓冲事件桥双注入，无重复广播；注册语句见下方
    // 装配块）。L4（F12）：审计底账落库接线——持久化通道 + 单 worker
    // （按发射序 reserve + append_event 落库 events 表；句柄随
    // ActiveRun 收口 await 排空，终态前落库完成）
    let (audit_persist_tx, audit_persist_rx) = tokio::sync::mpsc::unbounded_channel();
    let audit_worker = spawn_audit_persistence(
        Arc::clone(&queue),
        session_id.clone(),
        audit_persist_rx,
    );
    let bridge_audit_sink = Arc::new(BridgeAuditSink::new(
        Arc::clone(&bridge),
        run_id.clone(),
        audit_persist_tx,
    ));
    let escape_root = resolve_escape_watch_root(cwd.as_deref());
    let control_bus = Arc::new(Mutex::new(ControlBus::new()));
    // 30-P5：共享写路径注册表（会话级，与逃逸监视根同源）——工具执行
    // 面与逃逸判定器读同一实例；loop 侧 with_options 解析链
    // （options.write_claims 优先）保持同源
    let shared_registry = Arc::new(WritePathRegistry::new(session_id.clone(), &escape_root));
    // 30-P1：每 run 新建 abort 信号（M3 契约「每 run 重建 loop + 新信号」——
    // AbortSignal 共享 AtomicBool 不可复位，跨 run 泄漏语义禁止复用；
    // 同一实例注入 ActiveRun 与 loop，L3 强停 / kill_all 经同一触发面）。
    // AbortSignal::reset 不实现（Notify 无法复位，跨 run 泄漏语义登记
    // A4-M3 邻接，以「每 run 新信号」契约兜底）
    let abort_signal = AbortSignal::new();
    // ── 27 方案 S5：browser estop 桥（M-2，run 级 abort → CDP 发送层取消）──
    // 三层信号联动（27 §1.3 表）：run 级 AbortSignal（L3 强停/用户取消）
    // → 浏览器会话槽 estop 令牌（发送层在途命令逐 id 取消 +
    // CdpError::Cancelled）+ 急停旗（新命令拒绝）。每 run 先 reset_estop
    // 换新周期——新 run 不继承上一 run 的取消态（防跨 run 毒化会话）；
    // 急停旗随下一启动周期复位（browser/mod.rs BrowserSlot::reset_estop）。
    // 并发 run 共享同一 estop 周期（最后复位者生效）：多 run 并发操作
    // 同一浏览器实例登记遗留（27 §6 P1 会话归属迁移）。
    // 31 评审 F2（P1）：装配判定见 [assemble_browser_estop]——仅主 run
    // （subagent_config = None）装配；子代理 run 不装配（杜绝「子代理
    // abort → cancel 主 run estop」故障链）。
    if assemble_browser_estop(&subagent_config) {
        let browser_slot = state.engine.browser_slot();
        browser_slot.reset_estop();
        crate::browser::spawn_browser_estop_watcher(browser_slot, abort_signal.clone());
    }
    let (escape_watch, escape_config) = if let Some(dir) = cwd.clone() {
        let root = PathBuf::from(dir);
        let config = EscapeWatchConfig::new(
            root.clone(),
            session_id.clone(),
            run_id.clone(),
            // 15-T-6：与工具级审计路由共用同一 run 级桥（同一
            // BridgeAuditSink 实例双注入，无重复广播）
            Arc::clone(&bridge_audit_sink) as AuditSink,
        )
        .with_injector(Arc::new(ControlBusInjector::new(Arc::clone(&control_bus))))
        // 30-P5：判定器在 spawn 前注入（与 write_claims 同一 registry
        // 实例——声明写静默 / 未声明上报；消除 detector 恒 None 的
        // C-36 假闭环）
        .with_detector(Arc::new(RegistryBackedDetector::new(Arc::clone(
            &shared_registry,
        ))));
        match spawn_escape_watch(root, config.clone()) {
            Ok(handle) => {
                tracing::info!(
                    target: "run",
                    run_id = %run_id,
                    "逃逸监视已启动（T-ESC-03）"
                );
                (Some(handle), Some(config))
            }
            Err(error) => {
                tracing::warn!(
                    target: "run",
                    run_id = %run_id,
                    error = %error,
                    "逃逸监视启动失败（仅告警，run 继续）"
                );
                (None, None)
            }
        }
    } else {
        (None, None)
    };

    // ── 15-T-6（裁决 D9）：工具级审计路由注册（run 级桥）──────────
    // 工具级 security-audit（shell/delete 经 BuiltinToolConfig.audit_sink
    // 发射，接线前 NoopAuditSink 静默丢弃）经路由 sink 送达本 run 缓冲
    // 事件桥（信封注入 run_id → 前端审计面板 per-run 面实时可见，34-T7
    // 口径；L4（F12）已补落库面——审计底账经持久化 worker 写入 events
    // 表，见 [spawn_audit_persistence]）。与逃逸监视共用同一
    // BridgeAuditSink 实例（同一 run 桥双注入，无重复广播）。
    // **域隔离边界**（30 §9 最终口径）：任务域审计（10-P3
    // TaskAuditAccumulator → EventBridge 直发，operation=command-exec）
    // **不经本路由 sink**——本卡只承接工具级审计，两路均以
    // security-audit 事件形态经 run 桥到达前端，无重复无遗漏。
    // 收口注销在 drive_run_loop / finalize_failed 强制执行（防泄漏）。
    state
        .engine
        .audit_sink()
        .register(&session_id, Arc::clone(&bridge_audit_sink) as AuditSink);

    // ── T-D-13：子代理 run 装配块（默认权限集 / 提示词注入 / 配额）──
    // 普通 run（subagent_config = None）全部保持现状（None 不装配）。
    // - 写路径沙箱（T-D-08）：显式 allowed_write_paths → WritePathPolicy
    //   注册（Allowed 优先）；无显式字段且 implementation → 工作区根沙箱；
    //   其余类型工具面/配额面闭合，不注册策略（不强制越权检查）；
    // - 权限申请上下文（T-D-14）：design/review 装配配额凭证
    //   （granted=true quota=1，session_meta 后端）；
    // - 提示词注入（ContextInjector）：T-D-03 角色约束段 + C2 started_at
    //   段 + git 回退指引段 + T-D-14 权限申请指引段 + 产出目录段
    //   （主控已定产出目录时）。
    let subagent_injector: Option<ContextInjector> = None;
    let subagent_write_registry: Option<Arc<WritePathRegistry>> = None;
    let subagent_quota: Option<ExploreDocsQuotaContext> = None;
    let (subagent_write_registry, subagent_quota, subagent_injector) =
        match &subagent_config {
            None => (subagent_write_registry, subagent_quota, subagent_injector),            Some(config) => {
                // 工作区根解析链（30-P5：与 loop 装配块同源，经共用 helper
                // resolve_escape_watch_root——单一真源，杜绝双处漂移复发；
                // 壳层 workspace_root 恒 None，等效 cwd → current_dir）
                let root = resolve_escape_watch_root(cwd.as_deref());
                // 写路径沙箱装配
                let write_registry = match &config.allowed_write_paths {
                    Some(paths) => {
                        let policy = WritePathPolicy::from_entries(&root, paths.clone())
                            .map_err(|error| {
                                CoreError::internal(format!("写路径白名单解析失败：{error}"))
                            })?;
                        Some(Arc::new(
                            WritePathRegistry::new(session_id.clone(), &root)
                                .with_write_policy(policy),
                        ))
                    }
                    None => match config.task_type.as_deref() {
                        // implementation 默认 = 工作区根沙箱（Allowed 白名单）
                        Some("implementation") => Some(Arc::new(
                            WritePathRegistry::new(session_id.clone(), &root)
                                .with_write_policy(WritePathPolicy::Allowed(vec![root.clone()])),
                        )),
                        // 其余类型：工具面（只读/仅 shell）+ 配额面闭合，
                        // 不注册策略（越权检查不强制）
                        _ => None,
                    },
                };
                // 权限申请上下文（design/review 配额凭证；T-D-14）
                let quota = match config.task_type.as_deref() {
                    Some("design") | Some("review") => state.local_db().map(|db| {
                        ExploreDocsQuotaContext {
                            session_id: session_id.clone(),
                            run_id: run_id.clone(),
                            granted: true,
                            quota: 1,
                            store: Some(Arc::new(
                                conex_db::SessionMetaExploreDocsQuotaStore::new(db),
                            )),
                        }
                    }),
                    _ => None,
                };
                // 提示词注入段装配（M1 挂载形状：title + content → push）
                let mut injector = ContextInjector::new();
                // T-D-03：子代理角色约束（主 Agent run 装配点不调用——
                // 「主 Agent run 不含本段」断言的关键差异点）
                crate::engine::push_subagent_role_constraint(&mut injector);
                // C2：started_at 段 + git 回退谨慎指引（started_at 与落库同源）
                for (title, content) in agent_tools::subagent_inject::subagent_session_injections(
                    Some(config.started_at_ms),
                    agent_tools::subagent_inject::DEFAULT_REF_AGE_THRESHOLD_HOURS,
                ) {
                    injector.push(ContextInjection::new(
                        ContextInjectionKind::System,
                        title,
                        content,
                    ));
                }
                // T-D-14：权限申请指引段（任务类型 + 一句话边界参数化）
                let boundary = config
                    .task_type
                    .as_deref()
                    .and_then(agent_tools::tools::subagent::TaskType::parse)
                    .map(|t| t.boundary_summary());
                let (title, content) =
                    agent_tools::subagent_inject::permission_relay_injection(
                        config.task_type.as_deref(),
                        boundary,
                    );
                injector.push(ContextInjection::new(
                    ContextInjectionKind::System,
                    title,
                    content,
                ));
                // 产出目录段（主控已定产出目录时注入）
                if let Some(dir) = &config.output_dir {
                    let (title, content) = agent_tools::subagent_inject::output_dir_injection(dir);
                    injector.push(ContextInjection::new(
                        ContextInjectionKind::System,
                        title,
                        content,
                    ));
                }
                (write_registry, quota, Some(injector))
            }
        };

    let options = SessionLoopOptions {
        cwd: cwd.clone(),
        assistant_client_message_id: assistant_client_message_id.clone(),
        system_prompt: build_system_prompt(system_prompt),
        context_budget,
        // T-ESC-03：逃逸监视配置透传（装配上下文，LoopState 不消费）
        escape_watch: escape_config,
        // T-EG-05（F7）：写前自动备份中间件装配（S10b）——备份根经
        // with_defaults(None) 执行期回退工作区 `.crish-trash`，与 UI 删除
        // 命令（trash_root_for 未注入时兜底，core_run_commands.rs:2356）及
        // 工具侧 BuiltinToolConfig.trash_root（引擎装配处亦为 None）同源，
        // 保证恢复面板与写前快照落入同一回收站根；中间件链经
        // options.tool_middleware → loop/mod.rs:343 with_middleware 同步到
        // 工具执行器（消费侧循环装配由 F7 T-EG-06 负责，本处只做 options
        // 侧构造）。
        tool_middleware: vec![Arc::new(BackupMiddleware::with_defaults(None))],
        // T-D-14 权限传递层：父 run 归属透传执行器（审批请求来源判定与
        // 裁决者路由依据；None = 主 agent run，现状行为）
        parent_run_id: parent_run_id.clone(),
        // T-D-13：子代理 run 的写路径沙箱注册表（with_write_policy 装配；
        // 子代理沙箱优先，策略注册逻辑不动）；普通 run 由 None 变
        // Some(shared_registry)——30-P5：与逃逸判定器同一实例（双端注入
        // 成对：工具声明写不误报未声明）
        write_claims: subagent_write_registry
            .clone()
            .or_else(|| Some(Arc::clone(&shared_registry))),
        // T-D-13：子代理 run 的配额上下文（design/review 凭证；None =
        // 主 agent 不受配额约束，现状行为）
        explore_docs_quota: subagent_quota.clone(),
        // COMPACTION-01 P0-1（生产闭环）：压缩策略装配——默认 20000/2/1024
        // （conex-compaction 常量）经 session_meta 键覆盖（compact_summary_
        // max_tokens 等，读取键不实现 UI）；装配后预检压缩在生产可触发
        // （此前走 ..Default::default() 回落到 None，预检/溢出恒不触发）
        compaction_policy: state.compaction_policy_for(&session_id),
        // T-42/T-43/T-44（记忆韧性轮次 6）：摘要后台面三线装配——
        // - summarizer：会话级 Summarizer 工厂解析（生产工厂 = 真实 LLM
        //   实现 ProviderSummarizer，COMPACTION-01 P0-3 闭环；无注入 →
        //   None → 不 spawn，纯 stub awaiting 永驻，与接线前行为一致）；
        // - summary_dispatch：session_meta 配置面（compact_summary_backoff_ms
        //   / compact_summary_wall_ms；无键 = None = 生产缺省退避参数）；
        // - summary_coordinator：会话级协调器（跨 run 单飞 + 全局并发
        //   上限 ≤2 + 任务跨 run 存活；默认回调落 compression_blocks 表）
        summarizer: state.summarizer_for(&session_id),
        summary_dispatch: state.summary_dispatch_config(&session_id),
        summary_coordinator: Some(state.summary_coordinator_for(&session_id)),
        ..SessionLoopOptions::default()
    };
    let tool_options = ToolBatchOptions {
        approval_enabled,
        // R4 T10：permission_mode 显式下传时按 dangerous 标记三态判定
        // （ask 问询 / plan 拒绝写类 / full-access 放行）；None = 既有语义
        permission_mode: permission_mode
            .as_deref()
            .map(|mode| PermissionMode::from_engine_str(Some(mode))),
        ..ToolBatchOptions::default()
    };
    // 用户消息（clientMessageId 透传，03 §5.3-4）
    let message =
        crate::engine::user_message(&prompt.unwrap_or_default(), client_message_id.as_deref());

    // ── T-29/T-30 历史参数装配（P4 §3.2.3 混合路线）───────────────
    // 前端 history（store 已完成消息）为冷启动水合兜底；为空/未传时回退
    // SessionHistoryCache（引擎侧缓存主，run 收口写入的权威增量）。
    // 产出 initial_conversation（Vec<Arc<AgentMessage>>）：前端载荷走
    // T-28 hydrate_history（过滤 + 尾部 user 截断），缓存走保真水合
    // （工具结果配对不拆散）。已由 T-30 物理接线：经
    // SessionLoopProducer::initial_conversation 字段传入 produce，
    // 由 with_initial_conversation_arc 零拷贝水合。
    let assembled_history =
        resolve_history_source(&history, state.session_history.get(&session_id));
    let initial_conversation: Option<Vec<Arc<AgentMessage>>> = assembled_history
        .as_ref()
        .map(|(source, payload)| match source {
            HistorySource::Frontend => hydrate_history(payload.clone()),
            HistorySource::Cache => cached_history_to_conversation(payload.clone()),
        });
    tracing::debug!(
        target: "run",
        session_id = %session_id,
        source = ?assembled_history.as_ref().map(|(source, _)| source),
        hydrated = initial_conversation.as_ref().map(Vec::len).unwrap_or(0),
        "历史装配完成（前端水合兜底 / 引擎缓存主）"
    );

    let producer = SessionLoopProducer::new(
        session_id.clone(),
        run_id.clone(),
        MAX_TURNS_DEFAULT,
        provider,
        tool_registry,
        options,
        tool_options,
        approval,
        Some(delta_sink),
        initial_conversation,
        message,
    )
    // T-40（P5 S5 §3.2，R5-D3 轮末合并接线 ①）：缓存测量装配——
    // with_cache_tracking：tracking 配置（provider / model / TTL，
    // engine 侧 cache_tracking_config 产出；None = 不测量，行为与现状
    // 一致）；with_cache_session：上一 run 会话缓存状态（冷缓存预警 +
    // 模型切换检测数据源，engine 侧 cache_session 按会话维护）
    .with_cache_tracking(state.engine.cache_tracking_config())
    .with_cache_session(state.engine.cache_session(&session_id))
    // T-D-13：子代理 run 的上下文注入通道（角色约束 / started_at /
    // 权限申请指引 / 产出目录段；None = 无注入，system_prompt 原样透传）
    .with_context_injector(subagent_injector)
    // 30-P1：run 控制面接线——壳层与 loop 同源（同一控制总线 + 同一
    // abort 信号实例；check_control 安全点消费，运行中 run 有真实外部
    // 终止路径：core_run_control → 总线 → run 终止，L3 ≤ 下一安全点
    // 收场）。builder 顺序契约：with_* 在 run() 前（produce 内装配，
    // loop/mod.rs with_control_bus 注释）
    .with_control_bus(Arc::clone(&control_bus))
    .with_abort_signal(abort_signal.clone());

    // T-AB-19：登记当前 run 上下文（owner_run_id 注入槽）——须在 spawn
    // drive_run_loop 之前，保证 run 内工具执行链 adopt 时已可见；run
    // 终态（drive_run_loop 收口 / finalize_failed）经 clear_current_run 释放。
    state.background.set_current_run(&run_id);
    // T-D-13：spawner 侧 run 上下文登记（深度记账 + 当前活动 run 定位——
    // 子代理 spawn 时按发起会话解析父 run；收口经 clear 释放）
    state
        .subagent_spawner
        .register_run(&run_id, &session_id, parent_run_id.clone());
    state.subagent_spawner.set_current_run(&session_id, &run_id);

    // 注册活动 run 并 spawn 驱动循环
    let active = Arc::new(ActiveRun {
        session_id: session_id.clone(),
        run_id: run_id.clone(),
        handle: handle_shared,
        queue,
        control_bus: Arc::clone(&control_bus),
        // 30-P1：与 loop 共享同一信号实例（克隆即同一触发面；L3 强停
        // 经 ActiveRun.abort_signal 或 run_control_impl 任一入口生效）
        abort_signal: abort_signal.clone(),
        approval: approval_gate,
        bridge,
        delta_sink_active: true,
        escape_watch: Mutex::new(escape_watch),
        user_touched: AtomicBool::new(false),
        // 30-P1：spawn 句柄经 set_driver 事后登记（构造在前、spawn 在后）
        driver: Mutex::new(None),
        // T-D-13：子代理 run 装配配置随活动 run 登记（收口终态处理依据）
        subagent: subagent_config.clone(),
        // L4（F12）：审计落库 worker 句柄（收口处 take + await 排空）
        audit_persist: Mutex::new(Some(audit_worker)),
    });
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(run_id.clone(), Arc::clone(&active));
    // 30-P1 改动点 4：JoinHandle 管理——spawn 句柄存入 ActiveRun（驱动
    // 任务持同一 active 实例）；收口不 await（JoinHandle drop 即 detach，
    // tokio 语义，防挂起）；句柄供可观测与未来 join（测试经
    // driver_finished 轮询断言）
    let driver = tauri::async_runtime::spawn(drive_run_loop(
        state,
        Arc::clone(&active),
        Box::new(producer),
    ));
    active.set_driver(driver);

    tracing::info!(
        target: "run",
        session_id = %session_id,
        run_id = %run_id,
        mode = %mode.as_deref().unwrap_or("task"),
        permission_mode = %permission_mode.as_deref().unwrap_or("ask"),
        "core_run_task 已发起"
    );
    Ok(RunTaskResponse { run_id, session_id })
}

// ── 命令：core_run_control ────────────────────────────────────────

/// run 控制（03 §3.2 A 组：L0-L3 全枚举）
///
/// - `continue`（L0）：不入队（ControlBus 语义），no-op 返回 Ok；
/// - `soft_inject` / `steer` / `follow_up`（L1）：消息注入对应环，
///   不打断流（文本取 `message` 或 `payload.text`；环由 payload.kind
///   或 level 决定）；
/// - `cooperative_stop`（L2）：协作停止，等安全点收场（stopped，D1）；
/// - `force_cancel`（L3）：AbortSignal 强停 + 总线 force_cancel
///   （aborted 收场）。
#[tauri::command]
pub(crate) async fn core_run_control(
    state: tauri::State<'_, Arc<CoreRunState>>,
    run_id: String,
    level: String,
    message: Option<String>,
    reason: Option<String>,
    payload: Option<serde_json::Value>,
) -> Result<(), CoreError> {
    run_control_impl(state.inner(), run_id.trim(), &level, message, reason, payload).await
}

/// run 控制命令体（测试直调，不依赖 Tauri runtime；对齐 background.rs
/// 「契约体」模式）
pub(crate) async fn run_control_impl(
    state: &Arc<CoreRunState>,
    run_id: &str,
    level: &str,
    message: Option<String>,
    reason: Option<String>,
    payload: Option<serde_json::Value>,
) -> Result<(), CoreError> {
    let active = active_run(state, run_id)?;
    match level {
        // L0：继续当前 run（不入队）
        "continue" => Ok(()),
        // L1：软注入（不打断流；消息入 steer / followUp 环）
        "soft_inject" | "steer" | "follow_up" => {
            let text = message
                .or_else(|| {
                    payload
                        .as_ref()
                        .and_then(|p| p.get("text"))
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string)
                })
                .ok_or_else(|| {
                    CoreError::invalid_input("soft_inject 需要 message / payload.text")
                })?;
            // payload.kind 优先决定环（runControlClient.ts: follow_up /
            // soft_inject / steer 变体）
            let follow_up = payload
                .as_ref()
                .and_then(|p| p.get("kind"))
                .and_then(serde_json::Value::as_str)
                .map(|kind| kind == "follow_up")
                .unwrap_or(level == "follow_up");
            let injected = crate::engine::user_message(&text, None);
            // T-CF-11：用户经 L1 注入消息 → 标记用户交互（收口判定
            // 「用户消息到达后的正常收场不触发续 run」）
            active.user_touched.store(true, Ordering::SeqCst);
            let mut bus = active
                .control_bus
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if follow_up {
                bus.request_follow_up(injected, reason, Some("ui".to_string()));
            } else {
                bus.request_steer(injected, reason, Some("ui".to_string()));
            }
            Ok(())
        }
        // L2：协作停止（等安全点，不 hard abort）
        "cooperative_stop" => {
            let mut bus = active
                .control_bus
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            bus.request_cooperative_stop(
                Some(reason.unwrap_or_else(|| "ui-stop".to_string())),
                Some("ui".to_string()),
            );
            Ok(())
        }
        // L3：强停（可立即中断；AbortSignal + 总线）
        "force_cancel" => {
            // T-CF-11：用户显式取消 → 标记用户交互（收口不续 run 双保险）
            active.user_touched.store(true, Ordering::SeqCst);
            active.abort_signal.abort();
            {
                let mut bus = active
                    .control_bus
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                bus.request_force_cancel(
                    Some(reason.unwrap_or_else(|| "ui-force-cancel".to_string())),
                    Some("ui".to_string()),
                );
            }
            // T-AB-19 L0-L3 控制总线对接：L2 / L3 **不触碰任务**——任务属
            // 会话级，run 控制只作用于 run 本身（职责单一，避免误杀，对齐
            // 方案 REQ 4.3；l3_force_cancel_keeps_tasks 测试锚定）。可选联动
            // 默认关闭（配置项 CONEX_RUN_CONTROL_L3_TASK_CANCEL，见
            // [l3_force_cancel_tasks_enabled]）：开启时 L3 force 对「当前
            // run 的普通任务（is_daemon=false）」发起优雅终止（两阶段 kill，
            // best-effort，不阻断强停）。
            if l3_force_cancel_tasks_enabled() {
                state.background.graceful_stop_tasks_for_run(&active.run_id).await;
            }
            Ok(())
        }
        other => Err(CoreError::invalid_input(format!("未知 level：{other}"))),
    }
}

// ── 命令：core_cancel_run ─────────────────────────────────────────

/// 取消 run（过渡双线（03 §4.2）：IPC 模式经 run-control 单线为主，
/// 本命令保留双线兼容——L2 协作 / L3 强制，模式回落走 RunEngine 语义）
///
/// T-AB-19 显式接线：取消**不清理后台任务注册表、不级联杀任务**——
/// 任务属会话级（registry 生命周期独立于 run）；run 终态（aborted /
/// cancelled）统一由 drive_run_loop 收口（含 owner_run_id 上下文释放），
/// 本命令只请求取消，不做任何任务域操作。
#[tauri::command]
pub(crate) async fn core_cancel_run(
    state: tauri::State<'_, Arc<CoreRunState>>,
    run_id: String,
    mode: Option<String>,
) -> Result<CancelRunResponse, CoreError> {
    cancel_run_impl(state.inner(), &run_id, mode.as_deref(), None).await
}

/// 取消 run 直调体（R1-04 REST 写面：与 core_cancel_run 同一语义——
/// L2 协作 / L3 强制；不依赖 Tauri runtime）。reason 缺省
/// "cancelled-by-user"（与 IPC 命令面行为一致）。
pub(crate) async fn cancel_run_impl(
    state: &CoreRunState,
    run_id: &str,
    mode: Option<&str>,
    reason: Option<&str>,
) -> Result<CancelRunResponse, CoreError> {
    let active = active_run(state, run_id.trim())?;
    let cancel_mode = match mode {
        Some("cooperative") => CancelMode::Cooperative,
        _ => CancelMode::Force,
    };
    let engine = ActiveRunEngine {
        active: Arc::clone(&active),
    };
    let mut handle = active.handle.lock().await;
    let path = handle
        .cancel_run(
            cancel_mode,
            Some(&engine),
            reason.unwrap_or("cancelled-by-user"),
            state.store.as_ref(),
        )
        .await
        .map_err(crate::core_error::map_run_err)?;
    drop(handle);
    tracing::info!(
        target: "run",
        run_id = %active.run_id,
        path = ?path,
        "cancel_run_impl（终态由 drive_run_loop 收口）：后台任务注册表未清理、任务不级联杀（T-AB-19 契约）"
    );
    Ok(CancelRunResponse {
        ok: true,
        run_id: active.run_id.clone(),
    })
}

// ── 命令：core_approve_tool / core_deny_tool ──────────────────────

/// 批准工具调用（03 §3.2 A 组：{ok, toolCallId, decision:'approved'}）
///
/// I-02（PE-12 T12.3）：tool_call_id 必须在待审批集合（ApprovalGateImpl
/// 校验）；审批决策送达后落地 approval-resolved（持久化，03 §5.1-10
/// 硬依赖）并实时发射（前端关闭审批卡片）。
#[tauri::command]
pub(crate) async fn core_approve_tool(
    state: tauri::State<'_, Arc<CoreRunState>>,
    run_id: String,
    tool_call_id: String,
    decision: Option<String>,
) -> Result<ApproveResponse, CoreError> {
    approve_tool_impl(state.inner(), &run_id, &tool_call_id, decision).await
}

/// 批准工具调用直调体（R1-04 REST 写面：与 core_approve_tool 同一
/// 语义——I-02 pending 校验 + approval-resolved 落库与实时发射；
/// 不依赖 Tauri runtime）。
pub(crate) async fn approve_tool_impl(
    state: &CoreRunState,
    run_id: &str,
    tool_call_id: &str,
    decision: Option<String>,
) -> Result<ApproveResponse, CoreError> {
    let active = active_run(state, run_id.trim())?;
    // 仅接受 approved（其余值按 InvalidInput 拒绝，杜绝伪造）
    if decision.is_some_and(|d| d != "approved") {
        return Err(CoreError::invalid_input(
            "approve 的 decision 只能为 approved",
        ));
    }
    active
        .approval
        .resolve(tool_call_id, ApprovalDecision::Approved)
        .await?;
    emit_approval_resolved(&active, tool_call_id, WireApprovalDecision::Approved).await;
    Ok(ApproveResponse {
        ok: true,
        tool_call_id: tool_call_id.to_string(),
        decision: "approved",
    })
}

/// 拒绝工具调用（03 §3.2 A 组：{ok, toolCallId, decision:'denied'}）
#[tauri::command]
pub(crate) async fn core_deny_tool(
    state: tauri::State<'_, Arc<CoreRunState>>,
    run_id: String,
    tool_call_id: String,
    reason: Option<String>,
) -> Result<ApproveResponse, CoreError> {
    deny_tool_impl(state.inner(), &run_id, &tool_call_id, reason.as_deref()).await
}

/// 拒绝工具调用直调体（R1-04 REST 写面：与 core_deny_tool 同一语义；
/// 不依赖 Tauri runtime；reason 缺省 "user denied"）。
pub(crate) async fn deny_tool_impl(
    state: &CoreRunState,
    run_id: &str,
    tool_call_id: &str,
    reason: Option<&str>,
) -> Result<ApproveResponse, CoreError> {
    let active = active_run(state, run_id.trim())?;
    active
        .approval
        .resolve(
            tool_call_id,
            ApprovalDecision::Denied {
                reason: reason.unwrap_or("user denied").to_string(),
            },
        )
        .await?;
    emit_approval_resolved(&active, tool_call_id, WireApprovalDecision::Denied).await;
    Ok(ApproveResponse {
        ok: true,
        tool_call_id: tool_call_id.to_string(),
        decision: "denied",
    })
}

/// 按待审批集合反查 run（R1-04：M6 C11「runId 缺失容错」——toolCallId
/// 为真键，run_id 缺失时遍历活动 run 注册表命中首个包含该 tool_call_id
/// 的 run；未命中 None）
pub(crate) fn find_run_by_pending_tool_call(
    state: &CoreRunState,
    tool_call_id: &str,
) -> Option<String> {
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .find(|(_, active)| active.approval.contains_pending(tool_call_id))
        .map(|(run_id, _)| run_id.clone())
}

/// 待审批对账（R1-04 / M6 C13：活动 run 审批门待审批集合快照——「已
/// 请求未裁决」的运行时真源；run 未终态天然成立（终态移出活动注册表）。
/// after_sequence 增量水位属 wire 层对账扩展，实现为全量对账（M6 C13
/// 参数可选，缺省即全量）。
pub(crate) fn list_pending_approvals_impl(state: &CoreRunState) -> Vec<PendingApproval> {
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .flat_map(|active| {
            active.approval.pending_requests().into_iter().map(move |(tool_call_id, meta)| {
                // 危险级别在字段 move 前计算（tool_name 随后移入结构体）
                let danger_level = derive_danger_level(&meta.tool_name, &meta.param_keys);
                PendingApproval {
                    request_id: format!("approval-{tool_call_id}"),
                    tool_call_id,
                    tool_name: meta.tool_name,
                    summary: Some(meta.summary),
                    cwd: Some(meta.cwd),
                    session_id: Some(meta.session_id),
                    run_id: Some(active.run_id.clone()),
                    requester_run_id: meta.requester_run_id,
                    reason: meta.reason,
                    arbiter: if meta.arbiter == "main-agent" {
                        Arbiter::MainAgent
                    } else {
                        Arbiter::User
                    },
                    requested_at: meta.requested_at_ms,
                    expires_at: meta.requested_at_ms + APPROVAL_TIMEOUT.as_millis() as u64,
                    danger_level,
                    param_keys: Some(meta.param_keys),
                }
            })
        })
        .collect()
}

/// 危险级别推导（R1-04 / M6 C13：桌面按 F2 §2.2 表推导，移动端不重算）
///
/// 轻量启发式（与前端 approvalHandlers S9 宽容解析同语义的子集）：
/// 删除类工具 / 参数含删除语义 → 2（高风险，移动端二次确认），其余
/// 常规确认 → 1。红线请求不会到达审批门（decide_with_redline 先行拒绝），
/// 此处无需红线分支。
fn derive_danger_level(tool_name: &str, param_keys: &[String]) -> u8 {
    const DESTRUCTIVE_TOOLS: [&str; 5] = [
        "shell:write",
        "shell:exec",
        "git:revert",
        "file:delete",
        "workspace:delete",
    ];
    if DESTRUCTIVE_TOOLS.contains(&tool_name) {
        return 2;
    }
    if param_keys
        .iter()
        .any(|k| k.contains("delete") || k.contains("remove") || k.contains("overwrite"))
    {
        return 2;
    }
    1
}

/// 审批历史补拉（R1-04 / M6 C14：approval-resolved 事件白名单投影——
/// events 表按事件类型过滤，不携带参数全量（同 C13 隐私红线）。
/// sessionId 提供时按会话内 sequence 水位过滤，缺省跨会话按落库时刻
/// 近似排序；limit 缺省 100、上限 500。
pub(crate) async fn approval_history_impl(
    state: &CoreRunState,
    session_id: Option<&str>,
    after_sequence: Option<u64>,
    limit: Option<u32>,
) -> Result<ApprovalHistoryResult, CoreError> {
    let limit = limit.unwrap_or(100).clamp(1, 500) as usize;
    let Some(db) = state.local_db() else {
        // 无本地库（测试替身 store）：诚实返回空历史（不编造）
        return Ok(ApprovalHistoryResult {
            items: Vec::new(),
            next_after_sequence: None,
            has_more: None,
        });
    };
    let after = after_sequence.unwrap_or(0);
    // 会话范围：显式 sessionId → 单会话；缺省 → 全部会话索引
    let session_ids: Vec<String> = match session_id {
        Some(id) if !id.trim().is_empty() => vec![id.trim().to_string()],
        _ => db.list_sessions().map_err(map_db_failure)?.into_iter().map(|s| s.id).collect(),
    };
    // 逐会话拉取 approval-resolved 事件行（(sequence, created_at, payload)；
    // created_at 为 ISO 字符串列，跨会话排序按字典序 = 时间序）
    let mut rows: Vec<(i64, String, serde_json::Value)> = Vec::new();
    for sid in &session_ids {
        let events = db
            .query_events(sid, after as i64, None)
            .map_err(map_db_failure)?;
        for event in events {
            if event.event_type != "approval-resolved" {
                continue;
            }
            let Ok(payload) = serde_json::from_str::<serde_json::Value>(&event.payload) else {
                continue; // 损坏载荷跳过（防御性，与 core_read_session_events 同口径）
            };
            rows.push((event.sequence, event.created_at, payload));
        }
    }
    // 排序：跨会话按落库时刻（单会话天然按 sequence 升序，created_at 同序）
    rows.sort_by(|a, b| a.1.cmp(&b.1));
    let has_more = rows.len() > limit;
    let page = rows.into_iter().take(limit).collect::<Vec<_>>();
    let next_after_sequence = page.last().map(|(sequence, _, _)| (*sequence).max(0) as u64);
    let items = page
        .into_iter()
        .filter_map(|(sequence, _, payload)| {
            let tool_call_id = payload
                .get("toolCallId")
                .and_then(serde_json::Value::as_str)?
                .to_string();
            let decision = serde_json::from_value(payload.get("decision").cloned().unwrap_or_default())
                .unwrap_or(conex_types::events::ApprovalDecision::Expired);
            let resolved_at = payload
                .get("timestamp")
                .and_then(serde_json::Value::as_str)
                .map(|iso| iso8601_to_epoch_millis(iso).max(0) as u64);
            Some(ApprovalHistoryItem {
                sequence: sequence.max(0) as u64,
                tool_call_id,
                tool_name: None,
                decision,
                reason: None,
                channel: Some(RemoteApprovalChannel::Mobile),
                resolved_at,
                session_id: payload
                    .get("sessionId")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
                run_id: payload
                    .get("runId")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
            })
        })
        .collect();
    Ok(ApprovalHistoryResult {
        items,
        next_after_sequence,
        has_more: Some(has_more),
    })
}

/// conex-db [conex_db::DbFailure] → CoreError（本地库访问直调面通用映射）
fn map_db_failure(error: conex_db::DbFailure) -> CoreError {
    CoreError::Io(format!("本地库访问失败：{error}"))
}

/// 落地 approval-resolved 事件（持久化 + 实时发射）
async fn emit_approval_resolved(
    active: &ActiveRun,
    tool_call_id: &str,
    decision: WireApprovalDecision,
) {
    let event = AgentEvent::ApprovalResolved {
        session_id: active.session_id.clone(),
        tool_call_id: tool_call_id.to_string(),
        request_id: None,
        decision,
        timestamp: crate::engine::now_iso_utc(),
    };
    let mut queue = active.queue.lock().await;
    match queue.push(&active.session_id, event).await {
        Ok(sequenced) => {
            let envelope = AgentEventEnvelope::new(
                sequenced.event,
                Some(active.run_id.clone()),
                Some(sequenced.sequence),
            );
            active.bridge.emit(&envelope);
            active.bridge.flush();
        }
        Err(error) => {
            tracing::error!(
                target: "approval",
                run_id = %active.run_id,
                tool_call_id,
                error = %error,
                "approval-resolved 落库失败"
            );
        }
    }
}

// ── R1-04 REST 写面：只读查询直调体（服务网关 CoreStateBackend 接入；
//    不依赖 Tauri runtime——与既有 *_impl 契约体同范式）──────────────

/// 会话事件分页直调体（与 core_read_session_events 同一语义：store 游标
/// 分页 + 信封解析；after_sequence 开区间，max_events 缺省 200 夹紧 1000）
pub(crate) async fn read_session_events_impl(
    state: &CoreRunState,
    session_id: &str,
    after_sequence: Option<u64>,
    max_events: Option<u64>,
) -> Result<crate::core_query_commands::EventPage, CoreError> {
    if session_id.trim().is_empty() {
        return Err(CoreError::invalid_input("session_id 不能为空"));
    }
    let page_size = normalize_remote_page_size(max_events);
    let after = after_sequence.unwrap_or(0);
    let store = state.store();
    let events = store
        .query_events(session_id, after)
        .await
        .map_err(crate::core_error::map_store_err)?;
    let page_items: Vec<(u64, serde_json::Value)> = events
        .iter()
        .filter_map(|event| {
            let envelope: AgentEventEnvelope = serde_json::from_str(&event.payload).ok()?;
            serde_json::to_value(envelope)
                .ok()
                .map(|value| (event.sequence, value))
        })
        .collect();
    let (page, has_more) = paginate_remote(page_items, page_size);
    let next_after_sequence = page.last().map(|(seq, _)| *seq).unwrap_or(after);
    Ok(crate::core_query_commands::EventPage {
        events: page.into_iter().map(|(_, value)| value).collect(),
        next_after_sequence,
        has_more,
    })
}

/// run 事件分页直调体（与 core_read_run_events 同一语义：按信封 runId
/// 过滤的会话事件子集；sessionId 缺省从 run 记录反查）
pub(crate) async fn read_run_events_impl(
    state: &CoreRunState,
    run_id: &str,
    session_id: Option<&str>,
    after_sequence: Option<u64>,
    max_events: Option<u64>,
) -> Result<crate::core_query_commands::EventPage, CoreError> {
    if run_id.trim().is_empty() {
        return Err(CoreError::invalid_input("run_id 不能为空"));
    }
    let page_size = normalize_remote_page_size(max_events);
    let after = after_sequence.unwrap_or(0);
    let store = state.store();
    // 未提供 sessionId：从 run 记录反查（与 core_read_run_events 同语义）
    let session_id = match session_id {
        Some(id) if !id.trim().is_empty() => id.trim().to_string(),
        _ => {
            let runs = store
                .query_runs()
                .await
                .map_err(crate::core_error::map_store_err)?;
            runs.into_iter()
                .find(|run| run.run_id == run_id)
                .map(|run| run.session_id)
                .ok_or_else(|| CoreError::NotFound(format!("run not found: {run_id}")))?
        }
    };
    let events = store
        .query_events(&session_id, after)
        .await
        .map_err(crate::core_error::map_store_err)?;
    let run_events: Vec<(u64, serde_json::Value)> = events
        .iter()
        .filter_map(|event| {
            let envelope: AgentEventEnvelope = serde_json::from_str(&event.payload).ok()?;
            if envelope.run_id.as_deref() != Some(run_id) {
                return None;
            }
            serde_json::to_value(envelope)
                .ok()
                .map(|value| (event.sequence, value))
        })
        .collect();
    let (page, has_more) = paginate_remote(run_events, page_size);
    let next_after_sequence = page.last().map(|(seq, _)| *seq).unwrap_or(after);
    Ok(crate::core_query_commands::EventPage {
        events: page.into_iter().map(|(_, value)| value).collect(),
        next_after_sequence,
        has_more,
    })
}

/// run 快照直调体（与 core_get_run_snapshot 同一语义：store run 记录 +
/// usage 缓存；sessionId 提供时校验与 run 记录一致）
pub(crate) async fn get_run_snapshot_impl(
    state: &CoreRunState,
    run_id: &str,
    session_id: Option<&str>,
) -> Result<crate::core_query_commands::RunSnapshotResponse, CoreError> {
    if run_id.trim().is_empty() {
        return Err(CoreError::invalid_input("run_id 不能为空"));
    }
    let store = state.store();
    let runs = store
        .query_runs()
        .await
        .map_err(crate::core_error::map_store_err)?;
    let run = runs
        .into_iter()
        .find(|run| run.run_id == run_id)
        .ok_or_else(|| CoreError::NotFound(format!("run not found: {run_id}")))?;
    if let Some(session_id) = session_id {
        if !session_id.is_empty() && session_id != run.session_id {
            return Err(CoreError::InvalidInput(format!(
                "session_id mismatch: run {run_id} belongs to session {}, got {session_id}",
                run.session_id
            )));
        }
    }
    Ok(crate::core_query_commands::RunSnapshotResponse {
        snapshot: crate::core_query_commands::RunSnapshot {
            run_id: run.run_id.clone(),
            session_id: run.session_id.clone(),
            status: run.status.as_str().to_string(),
            cursor: run.cursor.max(0) as u64,
            created_at: run.created_at,
            updated_at: run.updated_at,
            end_reason: run.end_reason.clone(),
            error: state.run_error(run_id),
            usage: state.run_usage(run_id),
        },
    })
}

/// 会话列表直调体（LocalDb 索引直读；includeLastMessage 预览属 F5 增量
/// 面，R1-04 直调面不实现——缺省语义不变）
pub(crate) fn list_sessions_impl(
    state: &CoreRunState,
) -> Result<Vec<conex_types::SessionIndexEntry>, CoreError> {
    let Some(db) = state.local_db() else {
        return Ok(Vec::new());
    };
    db.list_sessions().map_err(map_db_failure)
}

/// 子代理 DAG 概览直调体（M6 C08 行投影：完整消息树不下发（D6 §3.3
/// N8），仅 flowDeclaration / flowState 原样 + agents 行投影
/// （agentId/status/description/summary/depth）；depth = 1——agents 表
/// 仅子代理行，主 agent 不在其中）
pub(crate) fn get_flow_snapshot_impl(
    state: &CoreRunState,
    session_id: &str,
) -> Result<serde_json::Value, CoreError> {
    if session_id.trim().is_empty() {
        return Err(CoreError::invalid_input("session_id 不能为空"));
    }
    let Some(db) = state.local_db() else {
        return Err(CoreError::NotFound(format!("会话不存在：{session_id}")));
    };
    let declaration = db
        .get_session_meta(orchestrator::flow_graph::FLOW_DECLARATION_KEY)
        .map_err(map_db_failure)?;
    let flow_state = db
        .get_session_meta(orchestrator::flow_graph::FLOW_STATE_KEY)
        .map_err(map_db_failure)?;
    let agents = db.load_session_agents(session_id).map_err(map_db_failure)?;
    let agents: Vec<serde_json::Value> = agents
        .into_iter()
        .map(|agent| {
            serde_json::json!({
                "agentId": agent.id,
                "status": agent.status,
                "description": agent.description,
                "summary": agent.summary,
                "depth": 1_u8,
            })
        })
        .collect();
    let parse_meta = |raw: Option<String>| {
        raw.and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
    };
    Ok(serde_json::json!({
        "flowDeclaration": parse_meta(declaration),
        "flowState": parse_meta(flow_state),
        "agents": agents,
    }))
}

/// 页大小归一（缺省 200、夹紧 [1, 1000]，与
/// core_query_commands::normalize_max_events 同口径）
fn normalize_remote_page_size(max_events: Option<u64>) -> usize {
    max_events
        .unwrap_or(crate::core_query_commands::DEFAULT_PAGE_SIZE)
        .clamp(1, crate::core_query_commands::MAX_PAGE_SIZE) as usize
}

/// 纯分页（与 core_query_commands::paginate 同语义：全量切前 max 条）
fn paginate_remote<T>(all: Vec<T>, max: usize) -> (Vec<T>, bool) {
    if all.len() <= max {
        return (all, false);
    }
    let page = all.into_iter().take(max).collect::<Vec<_>>();
    (page, true)
}

// ── R1-04 REST 写面：设置域直调体（M6 C28/C29 的 REST T1 形态）──────

/// 设置脱敏快照直调体（M6 C28：config_get 直透——apiKey 恒空串 + last4
/// 脱敏由 config 层保证；keys 子集过滤在服务层完成）
pub(crate) fn settings_get_impl() -> Result<serde_json::Value, CoreError> {
    crate::config::config_get()
}

/// 非敏感配置更新直调体（Z0 §9.3 R1-04「配置非敏感更新」：与
/// config_update 同语义——baseUrl / model 两键可写（config store setter
/// pub(crate) 直调面），写成功后重载引擎 provider（下一次 run 用新值）。
/// credentialMode / endpoint / stream 属 config 模块私有写面，R1-04
/// **显式拒绝**（fail-closed：不静默忽略，避免「请求成功但未生效」）。
pub(crate) fn settings_update_impl(
    state: &CoreRunState,
    base_url: Option<String>,
    model: Option<String>,
    credential_mode: Option<String>,
    endpoint: Option<String>,
    stream: Option<bool>,
) -> Result<serde_json::Value, CoreError> {
    if credential_mode.is_some() || endpoint.is_some() || stream.is_some() {
        return Err(CoreError::invalid_input(
            "credentialMode / endpoint / stream 不在 REST 非敏感配置更新面（仅 baseUrl / model）",
        ));
    }
    crate::config::with_store_mut(|store| {
        if let Some(url) = base_url {
            store.set_base_url(url)?;
        }
        if let Some(m) = model {
            store.set_model(m)?;
        }
        Ok(())
    })?;
    // 与 config_update 同语义：store 写成功后重载引擎 provider
    state.reload_provider();
    crate::config::config_get()
}

// ── R1-04 REST 写面：run 发起装配辅助（桌面侧生成 id，M6 C24）──────

/// 生成 run id（桌面生成：对齐前端 `run-<base36 时间戳>-<base36 随机>`
/// 命名风格；随机段经 CSPRNG getrandom）
pub(crate) fn generate_run_id() -> String {
    let mut random = [0u8; 4];
    let _ = getrandom::getrandom(&mut random);
    format!(
        "run-{}-{}",
        base36(now_ms_internal()),
        base36(u32::from_le_bytes(random) as u64)
    )
}

/// 生成会话 id（sessionId 缺省时桌面新建会话，对齐前端 `sess-<时间戳>`
/// 命名风格）
pub(crate) fn generate_session_id() -> String {
    format!("sess-{}", base36(now_ms_internal()))
}

/// 当前 epoch ms（模块内 id 生成用；与 crate::server::now_ms 同源）
fn now_ms_internal() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

/// base36 编码（0-9a-z；对齐前端 `Date.now().toString(36)` 风格）
fn base36(value: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_string();
    }
    let mut buffer = [0u8; 16];
    let mut i = 16;
    let mut v = value;
    while v > 0 {
        i -= 1;
        buffer[i] = DIGITS[(v % 36) as usize];
        v /= 36;
    }
    String::from_utf8(buffer[i..].to_vec()).expect("base36 恒为 ASCII")
}

/// 后台任务列表直调面（R1-04；未接线 → 空列表，与 summary 全零缺省
/// 同口径；TOOL_NOT_FOUND → NotFound，其余 → internal）
pub(crate) async fn list_background_tasks_impl(
    state: &CoreRunState,
) -> Result<Vec<serde_json::Value>, CoreError> {
    let tasks = state.background_manager().list_tasks().await?;
    Ok(tasks
        .into_iter()
        .map(|info| {
            serde_json::json!({
                "taskId": info.task_id,
                "command": info.command,
                "cwd": info.cwd,
                "status": serde_json::to_value(info.status).unwrap_or_default(),
                "isDaemon": info.is_daemon,
                "startedAt": info.started_at_ms,
                "exitCode": info.exit_code,
                "lineCount": info.line_count,
            })
        })
        .collect())
}

/// 任务输出补取直调面（R1-04 / M6 C07：after_line 偏移分页——read_log
/// 行范围语义；next_after_line / has_more 由 LogSlice 首末行推导）
pub(crate) async fn get_task_output_impl(
    state: &CoreRunState,
    task_id: &str,
    max_lines: Option<u32>,
    after_line: Option<u64>,
) -> Result<conex_types::device::commands::TaskOutputResult, CoreError> {
    let max_lines = max_lines.unwrap_or(200).clamp(1, 1000);
    let slice = state
        .background_manager()
        .read_task_log(task_id, after_line, max_lines as u64)
        .await?;
    let start = slice.start_line;
    let end = slice.end_line;
    let has_more = slice.truncated || end < slice.total_lines;
    Ok(conex_types::device::commands::TaskOutputResult {
        lines: slice.lines,
        truncated: slice.truncated,
        line_count: slice.total_lines,
        next_after_line: Some(if end >= start { end + 1 } else { start }),
        has_more: Some(has_more),
    })
}

// ── R1-04 REST 写面：CoreRunState 访问器 ────────────────────────────

impl CoreRunState {
    /// 状态诊断访问器（get_status 直调面——与 main.rs managed 的
    /// StatusDiagnostics 为同一实例，避免写入侧与读取侧漂移）
    pub(crate) fn status_diagnostics(&self) -> Arc<StatusDiagnostics> {
        Arc::clone(&self.diagnostics)
    }

    /// 后台任务管理器访问器（list_background_tasks / get_task_output
    /// 直调面）
    pub(crate) fn background_manager(&self) -> Arc<RunAwareBackgroundManager> {
        Arc::clone(&self.background)
    }
}

impl RunAwareBackgroundManager {
    /// 任务列表直调面（R1-04；未接线 → 空列表，与 summary 全零缺省同
    /// 口径；TOOL_NOT_FOUND → NotFound，其余 → internal）
    pub(crate) async fn list_tasks(&self) -> Result<Vec<BackgroundTaskInfo>, CoreError> {
        let Some(manager) = &self.inner else {
            return Ok(Vec::new());
        };
        manager.list(true).await.map_err(map_tool_error)
    }

    /// 任务日志直调面（R1-04：read_log 行范围语义；start_line=None 读
    /// 尾部 max_lines 行；未知任务 → NotFound）
    pub(crate) async fn read_task_log(
        &self,
        task_id: &str,
        start_line: Option<u64>,
        max_lines: u64,
    ) -> Result<LogSlice, CoreError> {
        let Some(manager) = &self.inner else {
            return Err(CoreError::NotFound(format!("任务不存在：{task_id}")));
        };
        manager
            .read_log(task_id, start_line, max_lines)
            .await
            .map_err(map_tool_error)
    }
}

/// 工具错误 → CoreError（TOOL_NOT_FOUND → NotFound，其余 → internal；
/// 与 background.rs tool_err_to_core 同语义）
fn map_tool_error(error: agent_tools::definition::ToolError) -> CoreError {
    if error.code() == codes::TOOL_NOT_FOUND {
        CoreError::NotFound(error.to_string())
    } else {
        CoreError::Internal(error.to_string())
    }
}

// ── trash 命令（I2-S5：误删恢复入口，引擎命令面）────────────────────

/// 回收站根注入配置（main.rs `app.manage`；对齐 `BuiltinToolConfig.trash_root`
/// 语义：`None` = 未注入 → 执行期回退活动工作区 `.crish-trash`，与
/// delete_file / delete_dir 工具的兜底一致——保证恢复面板与删除工具
/// 落入同一回收站根，恢复才找得到条目）。
#[derive(Debug, Clone, Default)]
pub struct TrashRootConfig {
    /// 回收站根（数据目录或显式配置根；None = 走工作区兜底）
    pub root: Option<PathBuf>,
}

/// 兜底回收站目录名（对齐 agent-tools delete.rs 的 DEFAULT_TRASH_DIR_NAME）
const DEFAULT_TRASH_DIR_NAME: &str = ".crish-trash";

/// 解析回收站根：
/// 1. 托管状态注入优先（main.rs 配置注入点，数据目录或显式根）；
/// 2. 未注入 → 活动工作区 `.crish-trash`（S3 执行期兜底语义）；
///
/// 工作区注册表不可用 → 结构化错误（不静默退化）。
/// pub(crate)：供 fs_commands/delete.rs（UI 删除命令）复用，保证
/// UI 删除与 AI 删除落入同一回收站根（S11 G2 删除接管收敛）。
pub(crate) fn trash_root_for(app: &tauri::AppHandle) -> Result<PathBuf, CoreError> {
    if let Some(config) = app.try_state::<TrashRootConfig>() {
        if let Some(root) = &config.root {
            return Ok(root.clone());
        }
    }
    let guard = crate::workspace::resolve_guard(app, "").map_err(|e| {
        CoreError::Internal(format!(
            "无法解析回收站根（工作区注册表不可用）：{}: {}",
            e.code, e.message
        ))
    })?;
    Ok(guard.root().join(DEFAULT_TRASH_DIR_NAME))
}

/// 回收站错误 → CoreError 映射（按文案归类，对齐 03 §5.3 协议）
fn map_trash_err(err: &anyhow::Error) -> CoreError {
    let msg = err.to_string();
    if msg.contains("不存在") || msg.contains("缺失") {
        CoreError::NotFound(msg)
    } else if msg.contains("非法条目") || msg.contains("拒绝覆盖") || msg.contains("校验失败") {
        CoreError::InvalidInput(msg)
    } else {
        CoreError::Io(msg)
    }
}

/// trash_list 返回（条目清单 + 回收站根；无条目时 entries 为空数组）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashListResponse {
    pub entries: Vec<conex_fs::trash::TrashEntry>,
    pub trash_root: String,
}

/// 列出回收站条目（误删恢复入口；数据源 = 回收站登记扫描，
/// 条目含路径 / 删除时间 / 类型 / 大小 / 校验和）
#[tauri::command]
pub(crate) fn trash_list(app: tauri::AppHandle) -> Result<TrashListResponse, CoreError> {
    let root = trash_root_for(&app)?;
    trash_list_at(&root)
}

/// 纯函数核心（测试直测）：按回收站根列出条目
pub(crate) fn trash_list_at(root: &std::path::Path) -> Result<TrashListResponse, CoreError> {
    let service = conex_fs::trash::TrashService::new(root);
    Ok(TrashListResponse {
        entries: service.list(),
        trash_root: root.to_string_lossy().into_owned(),
    })
}

/// trash_restore 返回（恢复成功的目标路径）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashRestoreResponse {
    pub ok: bool,
    pub original_path: String,
}

/// 按条目 id 恢复到原路径（校验 checksum 防篡改；原路径已存在拒绝覆盖；
/// 恢复失败返回结构化错误，条目保留在回收站）
#[tauri::command]
pub(crate) fn trash_restore(
    app: tauri::AppHandle,
    entry_id: String,
    session_id: Option<String>,
    state: tauri::State<'_, Arc<CoreRunState>>,
) -> Result<TrashRestoreResponse, CoreError> {
    let root = trash_root_for(&app)?;
    // I2-S8：恢复前取条目大小（恢复成功后条目已从清单移除，必须先行）
    let size = conex_fs::trash::TrashService::new(&root)
        .list()
        .into_iter()
        .find(|e| e.id == entry_id.trim())
        .map(|e| e.size)
        .unwrap_or(0);
    let response = trash_restore_at(&root, &entry_id)?;
    // I2-S8：恢复动作审计（decision=restored；经事件桥发前端事件流，
    // sessionId 由调用方（S5 恢复面板接线）携带，缺失时仅落审计日志）
    emit_trash_audit(
        &state.bridge,
        session_id.as_deref(),
        SecurityAuditOperation::TrashRestore,
        SecurityAuditDecision::Restored,
        &response.original_path,
        size,
    );
    Ok(response)
}

/// 纯函数核心（测试直测）：按条目 id 恢复到原路径
pub(crate) fn trash_restore_at(
    root: &std::path::Path,
    entry_id: &str,
) -> Result<TrashRestoreResponse, CoreError> {
    let service = conex_fs::trash::TrashService::new(root);
    let restored = service
        .restore(entry_id.trim())
        .map_err(|e| map_trash_err(&e))?;
    Ok(TrashRestoreResponse {
        ok: true,
        original_path: restored.to_string_lossy().into_owned(),
    })
}

/// trash_purge 返回（已彻底清除的条目 id）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashPurgeResponse {
    pub ok: bool,
    pub entry_id: String,
}

/// 彻底清除条目（显式用户调用，不可恢复）
#[tauri::command]
pub(crate) fn trash_purge(
    app: tauri::AppHandle,
    entry_id: String,
    session_id: Option<String>,
    state: tauri::State<'_, Arc<CoreRunState>>,
) -> Result<TrashPurgeResponse, CoreError> {
    let root = trash_root_for(&app)?;
    // I2-S8：清除前取条目原路径与大小（清除成功后条目已从清单移除）
    let entry = conex_fs::trash::TrashService::new(&root)
        .list()
        .into_iter()
        .find(|e| e.id == entry_id.trim());
    let (original_path, size) = entry
        .as_ref()
        .map(|e| (e.original_path.to_string_lossy().into_owned(), e.size))
        .unwrap_or_else(|| (entry_id.to_string(), 0));
    let response = trash_purge_at(&root, &entry_id)?;
    // I2-S8：清除动作审计（decision=purged；经事件桥发前端事件流）
    emit_trash_audit(
        &state.bridge,
        session_id.as_deref(),
        SecurityAuditOperation::TrashPurge,
        SecurityAuditDecision::Purged,
        &original_path,
        size,
    );
    Ok(response)
}

/// 纯函数核心（测试直测）：彻底清除条目（显式用户调用，不可恢复）
pub(crate) fn trash_purge_at(
    root: &std::path::Path,
    entry_id: &str,
) -> Result<TrashPurgeResponse, CoreError> {
    let service = conex_fs::trash::TrashService::new(root);
    service
        .purge(entry_id.trim())
        .map_err(|e| map_trash_err(&e))?;
    Ok(TrashPurgeResponse {
        ok: true,
        entry_id: entry_id.to_string(),
    })
}

/// 回收站恢复/清除动作的审计发射（I2-S8）
///
/// 发射形态：`security-audit` 信封（runId/sequence 为 None——用户级引擎
/// 命令不属 run 上下文，前端对缺失 runId 的信封放行不过滤）；`session_id`
/// 由调用方携带（S5 恢复面板接线后传入），缺失时跳过 wire-out 仅落
/// 结构化审计日志。事件落库（EventQueue append_event）属 run 上下文
/// 数据面，本命令面无会话序列上下文，登记为 I3 遗留（见方案 §2 S8）。
fn emit_trash_audit(
    bridge: &EventBridge,
    session_id: Option<&str>,
    operation: SecurityAuditOperation,
    decision: SecurityAuditDecision,
    original_path: &str,
    size_bytes: u64,
) -> EmitReport {
    let Some(session_id) = session_id else {
        tracing::info!(
            target: "security.audit",
            kind = "trash-command",
            operation = ?operation,
            decision = ?decision,
            path = original_path,
            "回收站命令审计（未携带会话上下文，跳过事件发射）"
        );
        return EmitReport::default();
    };
    let event = AgentEvent::SecurityAudit {
        session_id: session_id.to_string(),
        timestamp: now_iso_utc(),
        operation,
        targets: vec![original_path.to_string()],
        impact: ImpactAssessment {
            file_count: 1,
            total_size_bytes: size_bytes,
            directory_count: 0,
            cross_directory: false,
            flagged: false,
        },
        decision,
        permission_mode: None,
        tool_call_id: None,
    };
    let envelope = AgentEventEnvelope::new(event, None, None);
    tracing::info!(
        target: "security.audit",
        kind = "trash-command",
        session_id,
        operation = ?operation,
        decision = ?decision,
        path = original_path,
        "回收站命令审计：已发前端事件流"
    );
    bridge.emit_envelope(&envelope)
}

/// 当前 UTC 时间 ISO8601 字符串（毫秒精度；复用既有 civil_from_days
/// 换算，与 orchestrator / session-loop 同源）
fn now_iso_utc() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    let (hours, mins, sec) = (secs / 3600 % 24, secs / 60 % 60, secs % 60);
    let (year, month, day) = civil_from_days((secs / 86400) as i64);
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{mins:02}:{sec:02}.{millis:03}Z")
}

// ── 测试 ──────────────────────────────────────────────────────────

/// 测试面：config 静态 store 隔离锁（PS-04 T4.3 命令级测试用）。
///
/// `config_profile_apply` / `config_update` 会写 `API_CONFIG_STORE` / 密钥槽
/// 静态存储；命令级测试必须①并行串行化（set_var/take/init 非并发安全）、
/// ②重置静态到独立临时目录（禁止触碰真实用户配置——引擎测试的只读初始化
/// 可能已把静态绑定到 `CRISH_WORKBENCH_CONFIG_DIR` 之外的真实路径）。
#[cfg(test)]
pub(crate) static CONFIG_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 把静态 config store 重置并隔离到 `dir`（T4.3 命令级测试用；调用方必须
/// 持 [CONFIG_TEST_LOCK]）。测试面静态（cfg(test)）经
/// [crate::config::reset_config_stores_for_test] 重置为 None 后按当前
/// `CRISH_WORKBENCH_CONFIG_DIR` 重新懒加载——测试写入永不落到真实用户配置。
#[cfg(test)]
pub(crate) fn isolate_config_store(dir: &std::path::Path) {
    std::env::set_var("CRISH_WORKBENCH_CONFIG_DIR", dir);
    crate::config::reset_config_stores_for_test();
    crate::config::init_api_config_store();
}

#[cfg(test)]
mod tests {
    // G2 禁令豁免：
    // - 测试临时目录清理（非产品删除路径，可恢复语义不适用）；
    // - 测试 mod 子进程拉起面：真实 spawn 探测（红线 Blocked 断言 +
    //   tasklist / kill -0 存活探测辅助，T-AB-06/07 验收），非产品执行面；
    //   测试 mod 内 allow + 理由（裁决 D8 背书）。
    #![allow(clippy::disallowed_methods)]

    use super::*;
    use conex_types::message::{AgentMessageBlock, AgentMessageRole, ToolCallBlock};
    use conex_types::session::AgentEndReason;
    use conex_types::tool::ToolOutput;
    use orchestrator::steering_queue::SteeringInputEntry;
    // T-D-13 集成测试面：TestProvider 脚本驱动 + ProviderCall
    use session_loop::testing::TestProvider;
    use session_loop::stream::{ProviderStreamEvent, StopReason};
    use session_loop::provider::ProviderCall;
    use agent_provider::config::Endpoint;
    use crate::engine::EngineProviderConfig;
    use std::collections::BTreeMap;
    // T4.3-R2：本地 HTTP 请求捕获服务器（真实 wire 层载荷断言）
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// 便捷构造 HistoryMessage（缺省无 thinking/无 JSON 载荷字段）
    fn hmsg(id: &str, sender: &str, text: Option<&str>) -> HistoryMessage {
        HistoryMessage {
            id: id.into(),
            sender: sender.into(),
            text: text.map(String::from),
            thinking: None,
            blocks_json: None,
            tool_calls_json: None,
            tool_call_results_json: None,
            status: Some("completed".into()),
            timestamp: 1_785_456_000_000,
        }
    }

    /// 便捷构造 AgentMessage（固定 created_at 锚点 2026-07-31T00:00:00.123Z）
    fn amsg(id: &str, role: AgentMessageRole, blocks: Vec<AgentMessageBlock>) -> AgentMessage {
        AgentMessage {
            id: id.into(),
            role,
            created_at: "2026-07-31T00:00:00.123Z".into(),
            blocks,
            metadata: None,
            client_message_id: None,
            content: None,
        }
    }

    fn text_block(text: &str) -> AgentMessageBlock {
        AgentMessageBlock::Text { text: text.into() }
    }

    fn tool_call_block(id: &str, name: &str) -> AgentMessageBlock {
        AgentMessageBlock::ToolCall(ToolCallBlock {
            id: id.into(),
            tool_name: name.into(),
            input: serde_json::json!({"path": "/a"}),
        })
    }

    fn tool_result_block(id: &str, output: &str) -> AgentMessageBlock {
        AgentMessageBlock::ToolResult {
            tool_call_id: id.into(),
            tool_name: "read_file".into(),
            output: ToolOutput::text(output.to_string()),
            is_error: false,
        }
    }

    /// 错误文案 → payload：77 码兜底 + 人读文案
    #[test]
    fn failure_payload_uses_common_unknown_code() {
        let payload = crish_payload_from_message("provider 调用失败");
        assert_eq!(payload.code, codes::COMMON_UNKNOWN);
        assert!(payload.message.contains("provider 调用失败"));
        assert!(!payload.retryable);
    }

    /// 审批映射：wire 决策规范值（approved / denied / expired，03 §5.3-3）
    #[test]
    fn approval_decisions_map_to_wire_values() {
        let json = serde_json::to_string(&WireApprovalDecision::Denied).unwrap();
        assert_eq!(json, "\"denied\"");
        let approved = serde_json::to_string(&WireApprovalDecision::Approved).unwrap();
        assert_eq!(approved, "\"approved\"");
    }

    // ── T-D-14 权限传递层：审批门载荷与裁决者路由 ──

    /// 组装子代理 run 的审批门（父 run 归属注入；广播落到记录发射器）
    async fn subagent_gate(
        state: &CoreRunState,
        session_id: &str,
        run_id: &str,
        parent_run_id: Option<&str>,
        deadlock_detector: Option<Box<dyn Fn(&str) -> bool + Send + Sync>>,
    ) -> (Arc<ApprovalGateImpl>, Arc<RecordingEmitter>) {
        let handle = Arc::new(tokio::sync::Mutex::new(
            state
                .run_manager
                .start_run(session_id, run_id)
                .await
                .expect("start_run"),
        ));
        let (bridge, emitter) = recording_bridge();
        let broadcast_bridge = Arc::new(BufferedRunEventBridge::new(bridge, run_id.to_string()));
        let broadcast_run_id = run_id.to_string();
        let broadcast = Box::new(move |event: AgentEvent| {
            let envelope = AgentEventEnvelope::new(event, Some(broadcast_run_id.clone()), None);
            broadcast_bridge.emit(&envelope);
            broadcast_bridge.flush();
        });
        let mut gate = ApprovalGateImpl::new(
            run_id.to_string(),
            session_id.to_string(),
            parent_run_id.map(str::to_string),
            broadcast,
            handle,
            state.store.clone(),
            None,
        );
        if let Some(detector) = deadlock_detector {
            gate = gate.with_deadlock_detector(detector);
        }
        (Arc::new(gate), emitter)
    }

    /// 子代理审批请求 → 广播载荷携带 requesterRunId/reason + 路由
    /// metadata.arbiter=main-agent（转呈主 agent 裁决面）；主 agent 裁决
    /// 复用 core_approve_tool/core_deny_tool 的 resolve 入口 → Approved
    #[tokio::test]
    async fn gate_routes_subagent_request_to_main_agent_arbiter() {
        let (state, _registry) = state_with_background();
        let (gate, emitter) = subagent_gate(&state, "sess-gate", "run-sub-1", Some("run-main"), None)
            .await;
        let requester = ApprovalRequester {
            run_id: "run-sub-1".to_string(),
            task_type: None,
            reason: Some("需要写入默认范围外的路径".to_string()),
        };
        let gate_owner = Arc::clone(&gate);
        let rq = requester.clone();
        let wait = tokio::spawn(async move {
            gate_owner
                .request_approval(
                    "tc-1",
                    "write_file",
                    &serde_json::json!({ "path": "x.md" }),
                    Some(&rq),
                )
                .await
        });
        // 等待广播 + pending 注册后裁决（主 agent 裁决 = 同一 resolve 入口）
        tokio::time::sleep(Duration::from_millis(100)).await;
        gate.resolve("tc-1", ApprovalDecision::Approved)
            .await
            .expect("resolve 应放行（I-02 校验通过）");
        let decision = tokio::time::timeout(Duration::from_secs(2), wait)
            .await
            .expect("审批应在时限内返回")
            .expect("request_approval 不应 panic");
        assert_eq!(decision, ApprovalDecision::Approved);
        // 广播载荷：requesterRunId / reason / 路由 arbiter=main-agent
        let payloads = emitter.0.lock().unwrap().clone();
        let envelope: serde_json::Value = serde_json::from_str(&payloads[0]).unwrap();
        assert_eq!(envelope["type"], "approval-requested");
        assert_eq!(envelope["request"]["requesterRunId"], "run-sub-1");
        assert_eq!(envelope["request"]["reason"], "需要写入默认范围外的路径");
        assert_eq!(envelope["request"]["metadata"]["arbiter"], "main-agent");
    }

    // ── R1-10 T-10：审批伪造（对不存在 tool_call_id 发批准）──

    /// 组装 T-10 活动 run：记录型发射桥 + 审批门（与 build_active_run 同
    /// 装配面，仅事件桥替换为可捕获发射器——断言「无 approval-resolved 落地」）
    async fn t10_active_run(
        state: &CoreRunState,
        session_id: &str,
        run_id: &str,
    ) -> (Arc<ActiveRun>, Arc<RecordingEmitter>) {
        let handle = Arc::new(tokio::sync::Mutex::new(
            state
                .run_manager
                .start_run(session_id, run_id)
                .await
                .expect("start_run"),
        ));
        let queue = Arc::new(tokio::sync::Mutex::new(EventQueue::new(
            state.store.clone(),
            0,
        )));
        let (bridge, emitter) = recording_bridge();
        let bridge = Arc::new(BufferedRunEventBridge::new(bridge, run_id.to_string()));
        let broadcast_bridge = Arc::clone(&bridge);
        let broadcast_run_id = run_id.to_string();
        let broadcast = Box::new(move |event: AgentEvent| {
            let envelope = AgentEventEnvelope::new(event, Some(broadcast_run_id.clone()), None);
            broadcast_bridge.emit(&envelope);
            broadcast_bridge.flush();
        });
        let approval = Arc::new(ApprovalGateImpl::new(
            run_id.to_string(),
            session_id.to_string(),
            None,
            broadcast,
            Arc::clone(&handle),
            state.store.clone(),
            None,
        ));
        let active = Arc::new(ActiveRun {
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            handle,
            queue,
            control_bus: Arc::new(Mutex::new(ControlBus::new())),
            abort_signal: AbortSignal::new(),
            approval,
            bridge,
            delta_sink_active: true,
            escape_watch: Mutex::new(None),
            driver: Mutex::new(None),
            user_touched: AtomicBool::new(false),
            subagent: None,
            audit_persist: Mutex::new(None),
        });
        state
            .active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(run_id.to_string(), Arc::clone(&active));
        (active, emitter)
    }

    /// 等待审批请求进入待审批集合（request_approval 先广播后注册，轮询
    /// 而非固定 sleep——T-10 伪造审批时序确定性）
    async fn wait_pending(gate: &ApprovalGateImpl, tool_call_id: &str, timeout_ms: u64) {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
        while !gate.contains_pending(tool_call_id) {
            assert!(
                tokio::time::Instant::now() < deadline,
                "审批请求未在窗口内进入待审批集合"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// T-10 审批伪造：对不存在 tool_call_id 的审批（D-2 攻击场景——伪造端
    /// 企图批准不存在的审批）→ resolve NotFound + 无 approval-resolved 落地；
    /// 真实待审批请求不受影响（仍 pending、仍可正常裁决）
    #[tokio::test]
    async fn t10_approve_forged_tool_call_id_returns_not_found_no_event() {
        let (state, _registry) = state_with_background();
        let (active, emitter) = t10_active_run(&state, "sess-t10", "run-t10").await;
        let gate = Arc::clone(&active.approval);

        // 真实审批请求（tc-real）进入待审批集合
        let gate_owner = Arc::clone(&gate);
        let wait = tokio::spawn(async move {
            gate_owner
                .request_approval("tc-real", "write_file", &serde_json::json!({ "path": "x.md" }), None)
                .await
        });
        wait_pending(&gate, "tc-real", 3_000).await;

        // 伪造审批（不存在的 tool_call_id）：approve 必须 NotFound
        let err = approve_tool_impl(&state, "run-t10", "tc-fake", Some("approved".to_string()))
            .await
            .expect_err("伪造审批必须被拒");
        assert!(
            matches!(&err, CoreError::NotFound(_)),
            "伪造审批必须 NotFound，实际：{err:?}"
        );
        assert!(
            err.to_string().contains("not in pending approvals"),
            "NotFound 文案必须含 pending 关键字（移动端据此收敛冲突）：{err}"
        );
        // 无 approval-resolved 落地（事件桥零条——杜绝伪造审计事件）
        let payloads = emitter.0.lock().unwrap().clone();
        assert!(
            !payloads.iter().any(|p| p.contains("approval-resolved")),
            "伪造审批不得落地 approval-resolved 审计事件"
        );
        // 真实请求仍 pending；伪造 id 不在集合
        assert!(gate.contains_pending("tc-real"), "真实审批必须仍 pending");
        assert!(!gate.contains_pending("tc-fake"), "伪造 id 不得进入待审批集合");

        // 拒绝路径对称：deny 伪造 id 同样 NotFound
        let err = deny_tool_impl(&state, "run-t10", "tc-fake", Some("风险过高"))
            .await
            .expect_err("伪造 deny 必须被拒");
        assert!(matches!(err, CoreError::NotFound(_)));
        assert!(gate.contains_pending("tc-real"), "伪造 deny 后真实审批仍 pending");

        // 收尾：真实审批仍可正常裁决（伪造审批不破坏审批链路）——经命令面
        // approve_tool_impl 裁决（与 T-10 场景同一入口，落 approval-resolved）
        approve_tool_impl(&state, "run-t10", "tc-real", Some("approved".to_string()))
            .await
            .expect("真实审批必须可裁决");
        let decision = tokio::time::timeout(Duration::from_secs(2), wait)
            .await
            .expect("审批应在时限内返回")
            .expect("request_approval 不应 panic");
        assert_eq!(decision, ApprovalDecision::Approved);
        // 裁决后落地 approval-resolved（真实验证：事件只在真实裁决后出现）
        let payloads = emitter.0.lock().unwrap().clone();
        assert!(
            payloads.iter().any(|p| p.contains("approval-resolved")),
            "真实裁决后必须落地 approval-resolved"
        );
    }

    /// 死锁防护（开放问题 6.4）：裁决者（主 agent）正在 wait 该子代理 →
    /// 路由转用户（metadata 不标注 main-agent，载荷仍携带请求方身份）；
    /// 未检测到 wait → 保持主 agent 裁决（metadata.arbiter=main-agent）
    #[tokio::test]
    async fn gate_deflects_approval_when_arbiter_waiting_on_subagent() {
        let (state, _registry) = state_with_background();
        // detector 命中（主 agent 正在 wait run-sub-1）
        let (gate_waiting, emitter_waiting) = subagent_gate(
            &state,
            "sess-gate",
            "run-sub-1",
            Some("run-main"),
            Some(Box::new(|_subagent_run_id| true)),
        )
        .await;
        // detector 未命中
        let (gate_clear, emitter_clear) = subagent_gate(
            &state,
            "sess-gate",
            "run-sub-2",
            Some("run-main"),
            Some(Box::new(|_subagent_run_id| false)),
        )
        .await;
        let requester_waiting = ApprovalRequester {
            run_id: "run-sub-1".to_string(),
            task_type: None,
            reason: None,
        };
        let requester_clear = ApprovalRequester {
            run_id: "run-sub-2".to_string(),
            task_type: None,
            reason: None,
        };
        for (gate, emitter, requester, expecting_main_agent) in [
            (Arc::clone(&gate_waiting), emitter_waiting, requester_waiting, false),
            (Arc::clone(&gate_clear), emitter_clear, requester_clear, true),
        ] {
            let gate_owner = Arc::clone(&gate);
            let rq = requester.clone();
            let wait = tokio::spawn(async move {
                gate_owner
                    .request_approval(
                        "tc-1",
                        "write_file",
                        &serde_json::json!({}),
                        Some(&rq),
                    )
                    .await
            });
            tokio::time::sleep(Duration::from_millis(100)).await;
            gate.resolve("tc-1", ApprovalDecision::Approved)
                .await
                .expect("resolve 应放行");
            let _decision = tokio::time::timeout(Duration::from_secs(2), wait)
                .await
                .expect("审批应在时限内返回")
                .expect("request_approval 不应 panic");
            let payloads = emitter.0.lock().unwrap().clone();
            let envelope: serde_json::Value = serde_json::from_str(&payloads[0]).unwrap();
            assert_eq!(envelope["request"]["requesterRunId"], requester.run_id);
            if expecting_main_agent {
                assert_eq!(envelope["request"]["metadata"]["arbiter"], "main-agent");
            } else {
                assert!(
                    envelope["request"]["metadata"].is_null()
                        || envelope["request"]["metadata"].get("arbiter").is_none(),
                    "死锁防护转用户：不应标注 main-agent 裁决面"
                );
            }
        }
    }

    /// 不回归：主 agent run（无父 run）审批 requester=None → 载荷缺省
    /// requesterRunId/reason/metadata（既有 UI 审批流程载荷字节不变）
    #[tokio::test]
    async fn main_agent_gate_payload_legacy_byte_identical() {
        let (state, _registry) = state_with_background();
        let (gate, emitter) = subagent_gate(&state, "sess-main", "run-main", None, None).await;
        let gate_owner = Arc::clone(&gate);
        let wait = tokio::spawn(async move {
            gate_owner
                .request_approval("tc-1", "write_file", &serde_json::json!({}), None)
                .await
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        gate.resolve("tc-1", ApprovalDecision::Approved)
            .await
            .expect("resolve 应放行");
        let _decision = tokio::time::timeout(Duration::from_secs(2), wait)
            .await
            .expect("审批应在时限内返回")
            .expect("request_approval 不应 panic");
        let payloads = emitter.0.lock().unwrap().clone();
        let envelope: serde_json::Value = serde_json::from_str(&payloads[0]).unwrap();
        let request = &envelope["request"];
        assert!(request.get("requesterRunId").is_none(), "主 agent 请求不应携带 requesterRunId");
        assert!(request.get("reason").is_none(), "主 agent 请求不应携带 reason");
        assert!(request.get("metadata").is_none(), "主 agent 请求不应携带 metadata");
    }

    /// 用户注入消息形状（L1 soft_inject 落环载荷）
    #[test]
    fn injected_message_shape() {
        let message = crate::engine::user_message("继续", None);
        assert_eq!(message.role, AgentMessageRole::User);
        assert!(matches!(
            message.blocks.as_slice(),
            [AgentMessageBlock::Text { text }] if text == "继续"
        ));
    }

    // ── T-29 / DEEPCHECK-01 P0：SessionHistoryCache ────────────────

    /// 缓存容量上限（每会话 token 预算）：超预算按「稳定锚点 + 预算尾部」
    /// 截断——首条 user 锚点恒在 + 最近消息按预算保留，中间段丢弃
    #[test]
    fn session_history_cache_keeps_anchor_with_budget_tail() {
        let cache = SessionHistoryCache::with_limits(27, 8);
        let many: Vec<HistoryMessage> =
            (0..7).map(|i| hmsg(&format!("m{i}"), "user", Some("x"))).collect();
        cache.store("s1", many);
        let stored = cache.get("s1").unwrap();
        assert_eq!(cache.message_count("s1"), 3);
        // 预算 27 token：锚点 m0（9）+ 尾部窗口 m5/m6（18）——m4 起超出预算
        let ids: Vec<&str> = stored.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["m0", "m5", "m6"]);
    }

    /// DEEPCHECK-01 P0：极端预算（低于单条消息）时锚点仍恒在——
    /// 首条 user 永不因截断消失（跨 run 请求前缀的最小稳定单位）
    #[test]
    fn session_history_cache_keeps_first_user_anchor_over_budget() {
        let cache = SessionHistoryCache::with_limits(5, 4);
        let many: Vec<HistoryMessage> =
            (0..3).map(|i| hmsg(&format!("m{i}"), "user", Some("x"))).collect();
        cache.store("s1", many);
        let stored = cache.get("s1").unwrap();
        let ids: Vec<&str> = stored.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["m0"]);
        assert_eq!(stored[0].sender, "user");
    }

    /// DEEPCHECK-01 P0 集成形态：120 条消息会话——第 1 条锚点与最近尾部
    /// 恒在，中间段按预算截断（不再固定条数尾部滑窗整体漂移）
    #[test]
    fn session_history_cache_truncates_middle_keeps_head_and_tail() {
        let cache = SessionHistoryCache::with_limits(270, 4);
        let many: Vec<HistoryMessage> = (0..120)
            .map(|i| hmsg(&format!("m{i}"), "user", Some("x")))
            .collect();
        cache.store("s1", many);
        let stored = cache.get("s1").unwrap();
        assert_eq!(cache.message_count("s1"), 30);
        let ids: Vec<&str> = stored.iter().map(|m| m.id.as_str()).collect();
        // 锚点 m0 恒在 + 尾部窗口 [m91..m119]（29 条 × 9 token 装下预算），
        // m1..m90 中间段全部丢弃
        assert_eq!(ids[0], "m0");
        assert_eq!(ids[ids.len() - 1], "m119");
        assert_eq!(ids[1], "m91");
    }

    /// DEEPCHECK-01 P0：截断边界 wire 安全——孤儿 tool 首条（其 ToolCall
    /// 已被截掉）不得成为窗口起点，逐条让位直到边界安全
    #[test]
    fn truncation_boundary_drops_orphan_tool_message() {
        let cache = SessionHistoryCache::with_limits(40, 4);
        let mut m1 = hmsg("m1", "assistant", None);
        m1.blocks_json = Some(
            serde_json::to_string(&vec![text_block("工具轮（11 token 估算）")]).unwrap(),
        );
        let stored_before = {
            let mut msgs = vec![
                hmsg("m0", "user", Some("x")),
                m1.clone(),
                hmsg("m2", "tool", Some("x")),
                hmsg("m3", "user", Some("x")),
                hmsg("m4", "user", Some("x")),
            ];
            truncate_history_with_anchor(&mut msgs, 40);
            msgs
        };
        assert_eq!(stored_before[0].id, "m0");
        // 预算 40：窗口起点恰好落在 m2（tool，孤儿结果）→ 边界让位到 m3
        let ids: Vec<&str> = stored_before.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["m0", "m3", "m4"]);
        // 与 store 写入路径同语义（store 内部同样先锚点预算截断再安全前缀）
        cache.store("s1", stored_before);
        let stored = cache.get("s1").unwrap();
        let ids: Vec<&str> = stored.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["m0", "m3", "m4"]);
    }

    /// DEEPCHECK-01 P0：读回路径同样按预算截断（cached_history_to_conversation
    /// 对超预算历史自包含截断——锚点 + 尾部，中间丢弃；正常路径 store 已截断，
    /// 此处幂等）
    #[test]
    fn cached_history_read_path_truncates_with_budget() {
        let long_text = "x".repeat(8_000);
        let entries: Vec<HistoryMessage> = (0..100)
            .map(|i| {
                let mut entry = hmsg(&format!("m{i}"), "user", None);
                entry.blocks_json = Some(
                    serde_json::to_string(&vec![text_block(&long_text)]).unwrap(),
                );
                entry
            })
            .collect();
        let restored = cached_history_to_conversation(entries);
        // 期望值由同一估算函数自洽推导（不硬编码 count_tokens 细节）
        let mut probe = hmsg("probe", "user", None);
        probe.blocks_json =
            Some(serde_json::to_string(&vec![text_block(&long_text)]).unwrap());
        let per_message = estimate_history_tokens(&probe);
        let expected_tail = (SESSION_HISTORY_TOKEN_BUDGET - per_message) / per_message;
        assert!(restored.len() >= 50 && restored.len() < 100);
        assert_eq!(restored.len(), 1 + expected_tail);
        // 锚点恒在（首条 user）+ 尾部最近消息恒在 + 中间被截断
        assert_eq!(restored[0].id, "m0");
        assert_eq!(restored.last().unwrap().id, "m99");
        assert_ne!(restored[1].id, "m1");
    }

    /// 缓存容量上限（会话数）：超出 FIFO 淘汰最久未更新的会话
    #[test]
    fn session_history_cache_evicts_oldest_session() {
        let cache = SessionHistoryCache::with_limits(64, 2);
        cache.store("s1", vec![hmsg("a", "user", Some("1"))]);
        cache.store("s2", vec![hmsg("b", "user", Some("2"))]);
        cache.store("s3", vec![hmsg("c", "user", Some("3"))]);
        assert_eq!(cache.session_count(), 2);
        // 最久未更新的 s1 被淘汰；s2/s3 存活
        assert!(cache.get("s1").is_none());
        assert_eq!(cache.message_count("s2"), 1);
        assert_eq!(cache.message_count("s3"), 1);
        // 重复写入同一会话 = 刷新其 FIFO 位置（近似 LRU），不再被误淘汰
        cache.store("s2", vec![hmsg("d", "user", Some("4"))]);
        cache.store("s4", vec![hmsg("e", "user", Some("5"))]);
        assert!(cache.get("s3").is_none());
        assert_eq!(cache.message_count("s2"), 1);
        assert_eq!(cache.message_count("s4"), 1);
    }

    /// 空 history 回退缓存（混合路线：前端水合兜底 + 引擎侧缓存主）
    #[test]
    fn resolve_history_falls_back_to_cache_when_empty() {
        let cached = vec![hmsg("c1", "user", Some("缓存"))];
        let frontend = vec![hmsg("f1", "user", Some("前端"))];
        // 前端非空 → Frontend 优先（即使缓存有值）
        let (source, payload) =
            resolve_history_source(&Some(frontend.clone()), Some(cached.clone())).unwrap();
        assert_eq!(source, HistorySource::Frontend);
        assert_eq!(payload[0].id, "f1");
        // 前端空数组 → 回退缓存
        let (source, payload) =
            resolve_history_source(&Some(Vec::new()), Some(cached.clone())).unwrap();
        assert_eq!(source, HistorySource::Cache);
        assert_eq!(payload[0].id, "c1");
        // 前端未传 → 回退缓存
        let (source, payload) = resolve_history_source(&None, Some(cached.clone())).unwrap();
        assert_eq!(source, HistorySource::Cache);
        assert_eq!(payload[0].id, "c1");
        // 两者皆空 → None（现状单消息 run，向后兼容）
        assert!(resolve_history_source(&None, None).is_none());
        assert!(resolve_history_source(&Some(Vec::new()), None).is_none());
    }

    /// 收口写入形状：RunOutcome.messages → HistoryMessage（全角色保真）
    #[test]
    fn run_outcome_collected_into_history_messages() {
        let outcome = RunOutcome {
            reason: AgentEndReason::Stop,
            error: None,
            diagnostic: None,
            messages: vec![
                Arc::new(amsg("u1", AgentMessageRole::User, vec![text_block("你好")])),
                Arc::new(amsg(
                    "a1",
                    AgentMessageRole::Assistant,
                    vec![text_block("回复"), AgentMessageBlock::Thought {
                        text: "思考".into(),
                        redacted: None,
                    }],
                )),
                Arc::new(amsg(
                    "a2",
                    AgentMessageRole::Assistant,
                    vec![tool_call_block("c1", "read_file")],
                )),
                Arc::new(amsg(
                    "t1",
                    AgentMessageRole::Tool,
                    vec![tool_result_block("c1", "file content")],
                )),
            ],
            events: Vec::new(),
            turn_index: 2,
            tool_call_count: 1,
            steering_count: 0,
            // T-36：缓存统计字段（本构造点无样本 → None，缺省向后兼容）
            cache_stats: None,
        };
        let history = to_history_messages(&outcome);
        assert_eq!(history.len(), 4);
        // 角色保真（tool 角色独立消息保留——缓存路径不过滤）
        let senders: Vec<&str> = history.iter().map(|m| m.sender.as_str()).collect();
        assert_eq!(senders, ["user", "assistant", "assistant", "tool"]);
        // 收口消息均为完成态
        assert!(history.iter().all(|m| m.status.as_deref() == Some("completed")));
        // blocks_json 保真：可解析回 AgentMessageBlock 完整序列
        let first_blocks = parse_blocks(&history[0]).unwrap();
        assert_eq!(first_blocks, vec![text_block("你好")]);
        let tool_blocks = parse_blocks(&history[2]).unwrap();
        assert!(matches!(&tool_blocks[0], AgentMessageBlock::ToolCall(call) if call.id == "c1"));
        let result_blocks = parse_blocks(&history[3]).unwrap();
        assert!(matches!(
            &result_blocks[0],
            AgentMessageBlock::ToolResult { tool_call_id, output, is_error: false, .. }
                if tool_call_id == "c1" && output.text.as_deref() == Some("file content")
        ));
        // timestamp = created_at 折算（锚点 2026-07-31T00:00:00.123Z）
        assert_eq!(history[0].timestamp, 1_785_456_000_123);
        // thinking / text 字段裁剪（空 → None）
        assert_eq!(history[1].thinking.as_deref(), Some("思考"));
        assert!(history[3].text.is_none());
        // 合成源字段置 None（有 blocks_json 保真，无需冗余）
        assert!(history.iter().all(|m| m.tool_calls_json.is_none()));
        assert!(history.iter().all(|m| m.tool_call_results_json.is_none()));
    }

    /// 缓存往返保真：收口 → store → get → 读回水合，tool 配对不拆散
    #[test]
    fn cached_history_roundtrip_preserves_tool_pairs() {
        let cache = SessionHistoryCache::with_limits(100_000, 4);
        let outcome = RunOutcome {
            reason: AgentEndReason::Stop,
            error: None,
            diagnostic: None,
            messages: vec![
                Arc::new(amsg("u1", AgentMessageRole::User, vec![text_block("q")])),
                Arc::new(amsg(
                    "a1",
                    AgentMessageRole::Assistant,
                    vec![tool_call_block("c1", "read_file")],
                )),
                Arc::new(amsg(
                    "t1",
                    AgentMessageRole::Tool,
                    vec![tool_result_block("c1", "content")],
                )),
                Arc::new(amsg("u2", AgentMessageRole::User, vec![text_block("q2")])),
            ],
            events: Vec::new(),
            turn_index: 1,
            tool_call_count: 1,
            steering_count: 0,
            // T-36：缓存统计字段（本构造点无样本 → None，缺省向后兼容）
            cache_stats: None,
        };
        cache.store("s1", to_history_messages(&outcome));
        let restored = cached_history_to_conversation(cache.get("s1").unwrap());
        // 角色与数量保真（Tool 消息不被过滤——与前端 hydrate 路径互补）
        let roles: Vec<AgentMessageRole> = restored.iter().map(|m| m.role).collect();
        assert_eq!(
            roles,
            [
                AgentMessageRole::User,
                AgentMessageRole::Assistant,
                AgentMessageRole::Tool,
                AgentMessageRole::User,
            ]
        );
        // 工具配对完整：assistant 的 ToolCall id 与 tool 消息的 result id 一致
        assert!(matches!(
            restored[1].blocks[0],
            AgentMessageBlock::ToolCall(ref call) if call.id == "c1"
        ));
        assert!(matches!(
            restored[2].blocks[0],
            AgentMessageBlock::ToolResult { ref tool_call_id, .. } if tool_call_id == "c1"
        ));
        // created_at 还原（时间戳往返一致）
        assert_eq!(restored[0].created_at, "2026-07-31T00:00:00.123Z");
        // metadata 裁剪 + 幂等键对齐
        assert!(restored.iter().all(|m| m.metadata.is_none()));
        assert_eq!(restored[0].client_message_id.as_deref(), Some("u1"));
    }

    /// 收口写入安全前缀：孤儿 tool/system 首条与带未配对 ToolCall 的
    /// assistant 首条被前移掉，缓存序列以 user 开头（wire 合法）
    #[test]
    fn store_truncates_orphan_prefix() {
        let cache = SessionHistoryCache::with_limits(100_000, 4);
        // 场景 A：assistant(带 ToolCall，结果已不在保留段) 首条 → 前移掉
        let mut orphan_calls = hmsg("a1", "assistant", Some("调用了工具"));
        orphan_calls.blocks_json = Some(
            serde_json::to_string(&vec![tool_call_block("c1", "read_file")]).unwrap(),
        );
        cache.store("s1", vec![orphan_calls, hmsg("u1", "user", Some("后续"))]);
        let stored = cache.get("s1").unwrap();
        let senders: Vec<&str> = stored.iter().map(|m| m.sender.as_str()).collect();
        assert_eq!(senders, ["user"]);
        // 场景 B：tool 消息首条（孤儿结果）→ 前移掉
        cache.store("s2", vec![
            hmsg("t1", "tool", Some("孤儿结果")),
            hmsg("u1", "user", Some("后续")),
        ]);
        let stored = cache.get("s2").unwrap();
        assert_eq!(stored[0].sender, "user");
        assert_eq!(stored.len(), 1);
        // 场景 C：完整配对（assistant + tool 结果）以 assistant 首条 → 保留
        let mut paired = hmsg("a1", "assistant", None);
        paired.blocks_json = Some(
            serde_json::to_string(&vec![tool_call_block("c1", "read_file")]).unwrap(),
        );
        let mut result = hmsg("t1", "tool", None);
        result.blocks_json = Some(
            serde_json::to_string(&vec![tool_result_block("c1", "content")]).unwrap(),
        );
        cache.store("s3", vec![paired, result, hmsg("u1", "user", Some("尾"))]);
        let stored = cache.get("s3").unwrap();
        let senders: Vec<&str> = stored.iter().map(|m| m.sender.as_str()).collect();
        assert_eq!(senders, ["assistant", "tool", "user"]);
    }

    /// context_window 入站 → ContextBudget（reserve/safety 取默认，T-33 消费）
    #[test]
    fn context_window_assembles_into_budget_with_defaults() {
        let budget = assemble_context_budget(128_000);
        assert_eq!(budget.context_window, 128_000);
        assert_eq!(budget.reserve_tokens, 16_384);
        assert_eq!(budget.safety_tokens, 4_096);
    }

    /// DEEPCHECK-06 P0：预算入站解析（resolve_context_budget 装配分支）——
    /// 显式窗口优先；子代理 run（context_window 恒 None）按生效模型 catalog
    /// 窗口兜底；普通 run 无窗口 → None（向后兼容不钳制）
    #[test]
    fn resolve_context_budget_subagent_arm_uses_engine_catalog_window() {
        // 生效模型 qwen2-5-omni-7b（catalog 窗口 32000）——小窗口模型保证
        // 兜底臂窗口值可断言（deepseek-v4-flash 窗口 1M 亦可，选小窗口
        // 便于与预检集成测试共用同一模型口径）
        let provider = Arc::new(TestProvider::new(vec![
            ProviderStreamEvent::text("收口。"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ]));
        let (state, _, _) = run_control_test_state_with_model(provider, "qwen2-5-omni-7b");
        let cfg = Some(crate::subagent_spawner::SubagentRunConfig {
            subagent_id: "sa-1".to_string(),
            subagent_run_id: "run-sa-1".to_string(),
            parent_session_id: "s1".to_string(),
            task_type: None,
            allowed_write_paths: None,
            output_dir: None,
            started_at_ms: 1_000,
        });
        // 子代理 + 无显式窗口 → catalog 窗口（qwen2-5-omni-7b → 32000，
        // reserve/safety 取默认）
        let budget = resolve_context_budget(None, &cfg, &state.engine)
            .expect("子代理 run 必须装配预算（此前恒 None 裸跑）");
        assert_eq!(budget.context_window, 32_000);
        assert_eq!(budget.reserve_tokens, 16_384);
        assert_eq!(budget.safety_tokens, 4_096);
        // 显式窗口优先（调用方下发 > catalog 兜底）
        let budget = resolve_context_budget(Some(64_000), &cfg, &state.engine)
            .expect("显式窗口优先");
        assert_eq!(budget.context_window, 64_000);
        // 普通 run（无子代理配置 + 无窗口）→ None（向后兼容不钳制）
        assert!(resolve_context_budget(None, &None, &state.engine).is_none());
    }

    /// 时间戳互逆：ISO8601 ↔ epoch ms 往返一致（锚点 2026-07-31）
    #[test]
    fn iso8601_epoch_millis_roundtrip() {
        let epoch = 1_785_456_000_123;
        assert_eq!(iso8601_to_epoch_millis("2026-07-31T00:00:00.123Z"), epoch);
        assert_eq!(epoch_millis_to_iso8601(epoch), "2026-07-31T00:00:00.123Z");
        // 宽容解析：无毫秒段
        assert_eq!(iso8601_to_epoch_millis("2026-07-31T00:00:01Z"), 1_785_456_001_000);
        // 失败兜底 0
        assert_eq!(iso8601_to_epoch_millis("not-a-date"), 0);
    }

    // ── T-40：缓存测量收口（R5-D3 轮末合并接线 ②③④）────────────

    use conex_db::RunStatus;
    use orchestrator::persist::{InMemoryStore, LocalDbStore};

    /// 测试用 run 级缓存统计（hit_ratio / write_ratio 置 None——与
    /// get_run_usage 读回形状一致，可整型断言）
    fn cache_stats(warm_until_ms: Option<u64>, missed_tokens: u64) -> RunCacheStats {
        RunCacheStats {
            prompt_tokens: 10_000,
            completion_tokens: 100,
            total_tokens: 10_100,
            cache_read_tokens: 9_000,
            cache_write_tokens: 500,
            cache_miss_tokens: 500,
            sample_count: 1,
            hit_ratio: None,
            write_ratio: None,
            missed_tokens,
            warm_until_ms,
        }
    }

    static CORE_TMP_SEQ: AtomicU64 = AtomicU64::new(0);

    /// 测试用 CoreRunState（临时目录快照存储 + 记录型事件桥 + 独立诊断）
    fn core_state_with_store(store: Arc<dyn Store>) -> Arc<CoreRunState> {
        let (bridge, _emitter) = recording_bridge();
        let seq = CORE_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let snapshots: Arc<dyn SnapshotStore> = Arc::new(
            orchestrator::restore::SnapshotFileStore::new(std::env::temp_dir().join(format!(
                "conex_core_state_{}_{seq}_snapshot.json",
                std::process::id()
            ))),
        );
        Arc::new(CoreRunState::new(
            store,
            snapshots,
            bridge,
            Arc::new(StatusDiagnostics::new()),
            None,
        ))
    }

    // ── T-43/T-44（记忆韧性轮次 6）：Summarizer 注入通道 + 配置面 ────

    /// T-43：壳层 Summarizer 注入通道——无工厂 → None（不 spawn，纯 stub
    /// awaiting 永驻）；注入 fake 工厂 → 按会话解析实例；会话参数透传
    #[test]
    fn summarizer_factory_injection_channel() {
        struct FakeSummarizer;
        impl conex_compaction::Summarizer for FakeSummarizer {
            fn summarize(
                &self,
                _dropped: &[conex_types::message::AgentMessage],
                _existing: Option<&str>,
            ) -> Result<String, String> {
                Ok(r#"{"schemaVersion":1}"#.to_string())
            }
        }
        let db = conex_db::LocalDb::open_in_memory().unwrap();
        db.insert_session("s1", "s1").unwrap();
        let store: Arc<dyn Store> = Arc::new(orchestrator::persist::LocalDbStore::new(db));
        let state = core_state_with_store(store);

        // 生产装配（COMPACTION-01 P0-3）：CoreRunState::new 已装配真实
        // 工厂——测试显式清空回到「无注入」基线（provider 未就绪时工厂
        // 本身也解析 None，此处显式清空保证断言与机器配置无关）
        state.set_summarizer_factory(None);
        assert!(state.summarizer_for("s1").is_none(), "无工厂 = 无注入");

        // 注入工厂：per-session 实例（04 §7.1 隔离决议——按会话创建）
        let sessions_seen: Arc<std::sync::Mutex<Vec<String>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
        {
            let sessions_seen = Arc::clone(&sessions_seen);
            state.set_summarizer_factory(Some(Box::new(move |session_id: &str| {
                sessions_seen.lock().unwrap().push(session_id.to_string());
                Some(Arc::new(FakeSummarizer) as Arc<dyn conex_compaction::Summarizer>)
            })));
        }
        let s = state.summarizer_for("s1").expect("注入后必须解析出实例");
        let s2 = state.summarizer_for("s2");
        // 工厂被调用的会话参数正确透传
        assert_eq!(
            *sessions_seen.lock().unwrap(),
            vec!["s1".to_string(), "s2".to_string()]
        );
        assert!(s2.is_some(), "工厂返回 Some → 通道解析成功");
        drop(s);

        // 清空工厂（None 语义恢复）
        state.set_summarizer_factory(None);
        assert!(state.summarizer_for("s1").is_none());
    }

    /// T-44：session_meta 配置面——无键 → None（生产缺省参数语义）；
    /// 有键 → 从 session_meta 构造（自定义退避 + 墙钟）
    #[test]
    fn summary_dispatch_config_reads_session_meta() {
        let db = conex_db::LocalDb::open_in_memory().unwrap();
        db.insert_session("s1", "s1").unwrap();
        let store: Arc<dyn Store> = Arc::new(orchestrator::persist::LocalDbStore::new(db.clone()));
        let state = core_state_with_store(store);

        // 无任何配置键 → None（与轮次 4 summary_dispatch: None 语义一致）
        assert!(state.summary_dispatch_config("s1").is_none());

        // 自定义退避数组 + 墙钟
        db.set_session_meta("compact_summary_backoff_ms", "[2000,6000]")
            .unwrap();
        db.set_session_meta("compact_summary_wall_ms", "45000")
            .unwrap();
        let config = state
            .summary_dispatch_config("s1")
            .expect("有键时构造配置");
        assert_eq!(config.backoff_ms, vec![2000, 6000]);
        assert_eq!(config.max_wall_ms, 45_000);
        assert_eq!(config.max_attempts, session_loop::MAX_SUMMARY_ATTEMPTS);
    }

    /// T-44：坏值兜底——配置键存在但值非法 → 回退生产缺省（不 panic）
    #[test]
    fn summary_dispatch_config_malformed_falls_back_to_defaults() {
        let db = conex_db::LocalDb::open_in_memory().unwrap();
        db.insert_session("s1", "s1").unwrap();
        db.set_session_meta("compact_summary_backoff_ms", "oops").unwrap();
        let store: Arc<dyn Store> = Arc::new(orchestrator::persist::LocalDbStore::new(db));
        let state = core_state_with_store(store);
        let config = state
            .summary_dispatch_config("s1")
            .expect("有键即构造（解析失败兜底缺省）");
        assert_eq!(config.backoff_ms, session_loop::SUMMARY_BACKOFF_MS.to_vec());
        assert_eq!(config.max_wall_ms, session_loop::LOOP_SUMMARY_MAX_WALL_MS);
    }

    /// T-42：会话级协调器注册表挂载——同会话 get 幂等同 Arc（跨 run 单飞
    /// 状态延续）；跨会话各自成实例（会话隔离）
    #[test]
    fn summary_coordinator_registry_is_session_scoped() {
        let db = conex_db::LocalDb::open_in_memory().unwrap();
        db.insert_session("s1", "s1").unwrap();
        let store: Arc<dyn Store> = Arc::new(orchestrator::persist::LocalDbStore::new(db));
        let state = core_state_with_store(store);

        let c1 = state.summary_coordinator_for("s1");
        let c1_again = state.summary_coordinator_for("s1");
        let c2 = state.summary_coordinator_for("s2");
        assert!(Arc::ptr_eq(&c1, &c1_again), "同会话必须同一协调器（跨 run 单飞）");
        assert!(!Arc::ptr_eq(&c1, &c2), "跨会话各自成实例（会话隔离）");
        assert_eq!(c1.session_id(), "s1");
        assert_eq!(c2.session_id(), "s2");
    }

    // ── COMPACTION-01 P0-1：压缩策略装配（session_meta 键面 + 触发验收）──

    /// P0-1 装配：无 session_meta 键 → 常量默认 policy（keep_recent_tokens
    /// 20000 / min_recent_turns 2 / max_summary_tokens 1024 / tool_pair
    /// protection true）；生产恒装配（LocalDb store 存在即 Some——预检与
    /// 溢出触发链解除焊死）
    #[test]
    fn compaction_policy_assembled_with_defaults() {
        let db = conex_db::LocalDb::open_in_memory().unwrap();
        db.insert_session("s1", "s1").unwrap();
        let store: Arc<dyn Store> = Arc::new(orchestrator::persist::LocalDbStore::new(db));
        let state = core_state_with_store(store);

        let policy = state
            .compaction_policy_for("s1")
            .expect("生产必须装配压缩策略（预检可触发）");
        assert_eq!(
            policy.keep_recent_tokens,
            conex_compaction::KEEP_RECENT_TOKENS_DEFAULT,
            "keep_recent_tokens 默认 20000（常量同源）"
        );
        assert_eq!(
            policy.min_recent_turns,
            conex_compaction::MIN_RECENT_TURNS_DEFAULT,
            "min_recent_turns 默认 2"
        );
        assert_eq!(
            policy.max_summary_tokens,
            conex_compaction::MAX_SUMMARY_TOKENS_DEFAULT,
            "max_summary_tokens 默认 1024"
        );
        assert!(policy.tool_pair_protection, "tool 配对保护默认开启");
    }

    /// P0-1 覆盖：session_meta 键覆盖生效（compact_summary_max_tokens /
    /// compact_keep_recent_tokens / compact_min_recent_turns）；坏值 / 0 值
    /// 回退默认 + 不 panic
    #[test]
    fn compaction_policy_overrides_and_malformed_fall_back() {
        let db = conex_db::LocalDb::open_in_memory().unwrap();
        db.insert_session("s1", "s1").unwrap();
        db.set_session_meta(
            conex_compaction::SESSION_META_KEY_COMPACT_SUMMARY_MAX_TOKENS,
            "2048",
        )
        .unwrap();
        db.set_session_meta("compact_keep_recent_tokens", "8000").unwrap();
        db.set_session_meta("compact_min_recent_turns", "4").unwrap();
        let store: Arc<dyn Store> = Arc::new(orchestrator::persist::LocalDbStore::new(db.clone()));
        let state = core_state_with_store(store);

        let policy = state
            .compaction_policy_for("s1")
            .expect("装配 policy");
        assert_eq!(policy.max_summary_tokens, 2048, "compact_summary_max_tokens 覆盖");
        assert_eq!(policy.keep_recent_tokens, 8000, "compact_keep_recent_tokens 覆盖");
        assert_eq!(policy.min_recent_turns, 4, "compact_min_recent_turns 覆盖");

        // 坏值 → 回退默认（不 panic）
        db.set_session_meta(
            conex_compaction::SESSION_META_KEY_COMPACT_SUMMARY_MAX_TOKENS,
            "oops",
        )
        .unwrap();
        db.set_session_meta("compact_keep_recent_tokens", "-1").unwrap();
        db.set_session_meta("compact_min_recent_turns", "0").unwrap();
        let policy = state
            .compaction_policy_for("s1")
            .expect("坏值兜底后仍装配");
        assert_eq!(
            policy.max_summary_tokens,
            conex_compaction::MAX_SUMMARY_TOKENS_DEFAULT,
            "坏值回退默认 max_summary_tokens"
        );
        assert_eq!(
            policy.keep_recent_tokens,
            conex_compaction::KEEP_RECENT_TOKENS_DEFAULT,
            "坏值回退默认 keep_recent_tokens"
        );
        assert_eq!(
            policy.min_recent_turns,
            conex_compaction::MIN_RECENT_TURNS_DEFAULT,
            "0 值回退默认 min_recent_turns"
        );
    }

    /// P0-1 触发验收（完整 run 链路，mock provider 场景）：历史水合超大
    /// 对话 → 首个 prepare_turn 估算超窗（estimate ≥ window - reserve）→
    /// 预检压缩真实触发 → context-compression-start / end 事件广播落库 →
    /// 压缩后（中性 stub 进链）继续请求并正常收口。Summarizer 显式关闭
    /// 保证确定性（不走真实 HTTP；压缩产物 = 中性 stub，awaiting 语义）。
    #[tokio::test]
    async fn compaction_policy_preflight_triggers_compaction_in_full_run() {
        let huge = "x".repeat(160_000);
        let provider = Arc::new(TestProvider::new(vec![
            ProviderStreamEvent::text("压缩后收口回复。"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ]));
        let (state, db, _emitter) = run_control_test_state(provider);
        // P0-1 确定性：显式关闭真实 LLM 摘要器（测试不走 HTTP；压缩走中性
        // stub——预检触发链本身不依赖 summarizer）
        state.set_summarizer_factory(None);
        state.run_restore().await;

        // 历史水合：u1,a1,u2,a2,u3,a3,u4(超大)——水合尾部约束要求以 user
        // 收尾（assistant 收尾被截断）；尾部倒推 cut 落在 u4（超大），
        // 保留段首条 = user（T-36 形状护栏：无 system 会话链后首条必须
        // 为 user）→ dropped=[u1..a3] 六条
        let history = vec![
            HistoryMessage {
                id: "h-u1".to_string(),
                sender: "user".to_string(),
                text: Some("第一轮提问".to_string()),
                thinking: None,
                blocks_json: None,
                tool_calls_json: None,
                tool_call_results_json: None,
                status: Some("completed".to_string()),
                timestamp: 1_700_000_000_000,
            },
            HistoryMessage {
                id: "h-a1".to_string(),
                sender: "assistant".to_string(),
                text: Some("第一轮回复".to_string()),
                thinking: None,
                blocks_json: None,
                tool_calls_json: None,
                tool_call_results_json: None,
                status: Some("completed".to_string()),
                timestamp: 1_700_000_000_001,
            },
            HistoryMessage {
                id: "h-u2".to_string(),
                sender: "user".to_string(),
                text: Some("第二轮提问".to_string()),
                thinking: None,
                blocks_json: None,
                tool_calls_json: None,
                tool_call_results_json: None,
                status: Some("completed".to_string()),
                timestamp: 1_700_000_000_002,
            },
            HistoryMessage {
                id: "h-a2".to_string(),
                sender: "assistant".to_string(),
                text: Some("第二轮回复".to_string()),
                thinking: None,
                blocks_json: None,
                tool_calls_json: None,
                tool_call_results_json: None,
                status: Some("completed".to_string()),
                timestamp: 1_700_000_000_003,
            },
            HistoryMessage {
                id: "h-u3".to_string(),
                sender: "user".to_string(),
                text: Some("第三轮提问".to_string()),
                thinking: None,
                blocks_json: None,
                tool_calls_json: None,
                tool_call_results_json: None,
                status: Some("completed".to_string()),
                timestamp: 1_700_000_000_004,
            },
            HistoryMessage {
                id: "h-a3".to_string(),
                sender: "assistant".to_string(),
                text: Some("第三轮回复".to_string()),
                thinking: None,
                blocks_json: None,
                tool_calls_json: None,
                tool_call_results_json: None,
                status: Some("completed".to_string()),
                timestamp: 1_700_000_000_005,
            },
            HistoryMessage {
                id: "h-u4".to_string(),
                sender: "user".to_string(),
                text: Some(huge.clone()),
                thinking: None,
                blocks_json: None,
                tool_calls_json: None,
                tool_call_results_json: None,
                status: Some("completed".to_string()),
                timestamp: 1_700_000_000_006,
            },
        ];
        let options = RunTaskOptions {
            history: Some(history),
            // 窗口 40000：reserve 16384 → 预算 23616；估算 ≈ 42K+ ≥ 预算
            // → 预检触发（此前 compaction_policy=None 恒不触发）
            context_window: Some(40_000),
            ..test_options("run-compact", "s1", "发起长会话")
        };
        run_task_impl(Arc::clone(&state), options)
            .await
            .expect("run 发起成功");
        wait_run_agent_end_reason(&db, "s1", Duration::from_secs(30)).await;

        // 压缩事件：start + end 各一条（预检触发链真实走通）
        let events = db.query_events("s1", 0, Some(500)).expect("事件查询");
        let starts = events
            .iter()
            .filter(|e| e.event_type == "context-compression-start")
            .count();
        let ends = events
            .iter()
            .filter(|e| e.event_type == "context-compression-end")
            .count();
        assert_eq!(starts, 1, "预检压缩应广播 context-compression-start");
        assert_eq!(ends, 1, "预检压缩应广播 context-compression-end");
        // 压缩记录载荷：stub 摘要（summarizer 关闭 → awaiting），丢弃消息
        // = 前两轮（u1,a1），保留段从第二轮提问起
        let end = events
            .iter()
            .find(|e| e.event_type == "context-compression-end")
            .expect("end 事件存在");
        let payload: serde_json::Value =
            serde_json::from_str(&end.payload).expect("压缩载荷为合法 JSON");
        let dropped = payload["result"]["compressedMessageIds"]
            .as_array()
            .map(|arr| arr.len())
            .unwrap_or(0);
        assert!(dropped >= 1, "压缩必须丢弃历史消息（dropped={dropped}）");
        assert!(
            payload["result"]["summary"].as_str().is_some(),
            "压缩载荷须携带摘要文本"
        );
    }

    // ── DEEPCHECK-06 P0：子代理 run 预算装配全链路验收 ────────────

    /// DEEPCHECK-06 P0（子代理预算接线验收）：子代理 run 经 run_task_impl
    /// 装配——spawner 路径 context_window 恒 None（前端参数不可达）→ 引擎
    /// 按生效模型 catalog 解析窗口（qwen2-5-omni-7b → 32000）→
    /// context_budget + compaction_policy 双装配（此前子代理 run 预算恒
    /// None，预检/溢出压缩三级全裸）→ 超大历史水合估算超窗 → 预检压缩
    /// 真实触发（context-compression-start/end 事件落库到子代理会话）。
    #[tokio::test]
    async fn subagent_run_assembles_catalog_window_budget_and_preflight_compaction() {
        let subagent_session = "sub-sess-budget";
        // 子代理脚本：单轮文本收口（无工具调用）
        let provider = Arc::new(TestProvider::new(vec![
            ProviderStreamEvent::text("子代理收口回复。"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ]));
        let (state, db, _emitter) =
            run_control_test_state_with_model(provider, "qwen2-5-omni-7b");
        db.upsert_session_entry(&subagent_test_session_entry(subagent_session))
            .expect("子代理会话条目");
        // P0-1 确定性：显式关闭真实 LLM 摘要器（压缩走中性 stub，测试不
        // 走 HTTP——预检触发链本身不依赖 summarizer）
        state.set_summarizer_factory(None);
        state.run_restore().await;

        // 子代理会话历史预置（spawner 场景 history=None → 走缓存回退；
        // 超大消息 → 水合估算超窗（≈42K tokens ≥ 32000-16384=15616））
        // blocks_json 必须携带：缓存路径水合（cached_history_to_conversation
        // → parse_blocks）只消费 blocks_json（text-only 合成兜底属前端路径
        // hydrate.rs 的规则，缓存路径与收口写入 to_history_message 的形状
        // 契约 = 块保真形态；text-only 条目会被宽容跳过，导致水合为空对话、
        // 预检无从触发）
        let huge = "x".repeat(160_000);
        let history = vec![
            HistoryMessage {
                id: "h-u1".to_string(),
                sender: "user".to_string(),
                text: Some("第一轮提问".to_string()),
                thinking: None,
                blocks_json: Some(serde_json::to_string(&vec![text_block("第一轮提问")]).unwrap()),
                tool_calls_json: None,
                tool_call_results_json: None,
                status: Some("completed".to_string()),
                timestamp: 1_700_000_000_000,
            },
            HistoryMessage {
                id: "h-a1".to_string(),
                sender: "assistant".to_string(),
                text: Some("第一轮回复".to_string()),
                thinking: None,
                blocks_json: Some(serde_json::to_string(&vec![text_block("第一轮回复")]).unwrap()),
                tool_calls_json: None,
                tool_call_results_json: None,
                status: Some("completed".to_string()),
                timestamp: 1_700_000_000_001,
            },
            HistoryMessage {
                id: "h-u2".to_string(),
                sender: "user".to_string(),
                text: Some(huge.clone()),
                thinking: None,
                blocks_json: Some(serde_json::to_string(&vec![text_block(&huge)]).unwrap()),
                tool_calls_json: None,
                tool_call_results_json: None,
                status: Some("completed".to_string()),
                timestamp: 1_700_000_000_002,
            },
        ];
        state.session_history.store(subagent_session, history);

        // 子代理 run：context_window 恒 None（spawner 路径真实装配形状）+
        // history None（缓存回退）+ subagent_config 装配
        let options = RunTaskOptions {
            mode: Some("research".to_string()),
            history: None,
            context_window: None,
            subagent_config: Some(crate::subagent_spawner::SubagentRunConfig {
                subagent_id: "sub-1-0".to_string(),
                subagent_run_id: "sub-run-budget".to_string(),
                parent_session_id: "s1".to_string(),
                task_type: Some("analysis".to_string()),
                allowed_write_paths: None,
                output_dir: None,
                started_at_ms: 1_700_000_000_000,
            }),
            ..test_options("sub-run-budget", subagent_session, "调研模块 A")
        };
        run_task_impl(Arc::clone(&state), options)
            .await
            .expect("子代理 run 发起成功");
        wait_run_agent_end_reason(&db, subagent_session, Duration::from_secs(30)).await;

        // 预检压缩真实触发：context-compression-start/end 事件落库到子代理
        // 会话（证据链：context_window None + subagent_config Some →
        // catalog 窗口 32000 → budget+policy 双装配 → 预检触发。此前子代理
        // run 预算 None，本事件恒不出现，超窗直接 fatal）
        let events = db
            .query_events(subagent_session, 0, Some(500))
            .expect("事件查询");
        let starts = events
            .iter()
            .filter(|e| e.event_type == "context-compression-start")
            .count();
        let ends = events
            .iter()
            .filter(|e| e.event_type == "context-compression-end")
            .count();
        assert_eq!(starts, 1, "子代理预检压缩应广播 context-compression-start");
        assert_eq!(ends, 1, "子代理预检压缩应广播 context-compression-end");
    }

    // ── 31 评审 F2（P1）：estop 桥仅主 run 装配（子代理 run 不装配）──

    /// estop 桥装配判定（[assemble_browser_estop]）：仅主 run
    /// （subagent_config = None）装配 reset_estop + watcher；子代理 run
    /// （任意 task_type）一律不装配——「子代理 run 不挂 watcher」的单元
    /// 断言，杜绝「子代理 abort → cancel 主 run estop」故障链（31 评审 F2）。
    #[test]
    fn browser_estop_bridge_main_run_only() {
        assert!(
            assemble_browser_estop(&None),
            "主 run（无子代理配置）必须装配 estop 桥"
        );
        // 子代理 run：缺省 task_type（None）与各显式类型一律不装配
        for task_type in [None, Some("analysis"), Some("implementation"), Some("review")] {
            let config = Some(crate::subagent_spawner::SubagentRunConfig {
                subagent_id: "sub-1-0".to_string(),
                subagent_run_id: "sub-run-estop".to_string(),
                parent_session_id: "s1".to_string(),
                task_type: task_type.map(String::from),
                allowed_write_paths: None,
                output_dir: None,
                started_at_ms: 1_700_000_000_000,
            });
            assert!(
                !assemble_browser_estop(&config),
                "子代理 run（task_type={task_type:?}）不得装配 estop 桥"
            );
        }
    }

    /// 集成面：子代理 run 的 L3 强停路径正常收场（aborted）——子代理 run
    /// 可被中止（触发面不受 estop 桥剔除影响），且 estop 桥装配判定由
    /// [browser_estop_bridge_main_run_only] 锁定（子代理 abort 不触达主 run
    /// 的 estop 周期）。
    #[tokio::test]
    async fn subagent_run_abort_terminates_without_estop_bridge() {
        let provider = Arc::new(
            TestProvider::new(vec![
                ProviderStreamEvent::text("子代理第一轮"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ])
            .with_pause(0, 3_000),
        );
        let (state, db, _emitter) = run_control_test_state_with_model(provider, "qwen2-5-omni-7b");
        state.run_restore().await;
        let session_id = "sub-sess-estop";
        db.upsert_session_entry(&subagent_test_session_entry(session_id))
            .expect("子代理会话条目");
        // 子代理 run：context_window 恒 None（spawner 路径真实装配形状）
        let options = RunTaskOptions {
            mode: Some("research".to_string()),
            history: None,
            context_window: None,
            subagent_config: Some(crate::subagent_spawner::SubagentRunConfig {
                subagent_id: "sub-1-0".to_string(),
                subagent_run_id: "sub-run-estop".to_string(),
                parent_session_id: "s1".to_string(),
                task_type: Some("analysis".to_string()),
                allowed_write_paths: None,
                output_dir: None,
                started_at_ms: 1_700_000_000_000,
            }),
            ..test_options("sub-run-estop", session_id, "子代理 estop 装配面")
        };
        run_task_impl(Arc::clone(&state), options)
            .await
            .expect("子代理 run 发起成功");
        let active = state
            .active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get("sub-run-estop")
            .cloned()
            .expect("子代理 run 已注册");
        // L3 强停（用户取消路径：abort_signal + 总线 force_cancel 双写）
        run_control_impl(
            &state,
            "sub-run-estop",
            "force_cancel",
            None,
            Some("测试强停子代理".to_string()),
            None,
        )
        .await
        .expect("force_cancel 应成功");
        // 真实 loop 在下一安全点收场：agent-end reason == aborted
        let end_reason = wait_run_end_reason(&active, Duration::from_secs(30)).await;
        assert_eq!(end_reason, "aborted", "L3 强停后子代理 run 必须以 aborted 终态");
        let agent_reason = wait_run_agent_end_reason(&db, session_id, Duration::from_secs(30)).await;
        assert_eq!(
            agent_reason, "aborted",
            "L3 强停后子代理 loop 的 agent-end 收场 reason 必须为 aborted"
        );
    }

    // ── PS-04 T4.3（F4 F1-01）：config_profile_apply 后 provider 重载 ──

    /// 独立临时 config 目录（不清理：静态 store 在测试结束后仍可能绑定该
    /// 目录，删除会触发后续只读初始化的缺省回落——保留无害且避免竞态）。
    fn temp_config_dir() -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "conex-config-test-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create config dir");
        dir
    }

    /// 本地 HTTP 请求捕获服务器：T4.3-R2 的「RecordingProvider」——wire 层
    /// 真实记录每次 provider 请求的 URL 路径 / Authorization / body model
    /// （不 mock 重载行为：重载是否生效由「新实例的请求载荷」证明）。
    struct RequestCaptureServer {
        addr: std::net::SocketAddr,
        captured: Arc<std::sync::Mutex<Vec<CapturedRequest>>>,
    }

    #[derive(Debug, Clone)]
    struct CapturedRequest {
        path: String,
        auth_header: Option<String>,
        body_model: Option<String>,
    }

    impl RequestCaptureServer {
        async fn start() -> Arc<Self> {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bind local server");
            let addr = listener.local_addr().expect("local addr");
            let captured = Arc::new(std::sync::Mutex::new(Vec::new()));
            let server = Arc::new(Self {
                addr,
                captured: Arc::clone(&captured),
            });
            tokio::spawn(async move {
                // 接受少量连接（每次请求一条；幂等重试面内都记录）
                for _ in 0..8 {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        break;
                    };
                    let captured = Arc::clone(&captured);
            tokio::spawn(async move {
                if let Some(request) = read_http_request(&mut socket).await {
                    captured
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .push(request);
                }
                        // 2xx 即让 client stream() 返回（测试不消费 body）
                        let _ = socket
                            .write_all(
                                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n",
                            )
                            .await;
                    });
                }
            });
            server
        }

        fn base_url(&self, path: &str) -> String {
            format!("http://{}{path}", self.addr)
        }

        /// 等待捕获到 `n` 个请求（5s 超时兜底，防测试悬挂）
        async fn wait_for(&self, n: usize) -> Vec<CapturedRequest> {
            let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(5);
            loop {
                let current = self
                    .captured
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone();
                if current.len() >= n {
                    return current;
                }
                if tokio::time::Instant::now() >= deadline {
                    return current;
                }
                tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;
            }
        }
    }

    /// 读一条 HTTP 请求（请求行 + 头 + Content-Length 体；1s 读超时防挂起）
    async fn read_http_request(
        socket: &mut tokio::net::TcpStream,
    ) -> Option<CapturedRequest> {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 1024];
        let head_end = loop {
            if let Some(pos) = find_subslice(&buf, b"\r\n\r\n") {
                break pos + 4;
            }
            let n = match tokio::time::timeout(
                tokio::time::Duration::from_secs(3),
                socket.read(&mut chunk),
            )
            .await
            {
                Ok(Ok(n)) => n,
                Ok(Err(_)) => return None,
                Err(_) => return None,
            };
            if n == 0 {
                return None;
            }
            buf.extend_from_slice(&chunk[..n]);
        };
        let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
        let mut lines = head.lines();
        let request_line = lines.next().unwrap_or_default();
        let path = request_line
            .split_whitespace()
            .nth(1)
            .unwrap_or_default()
            .to_string();
        let mut content_length = 0usize;
        let mut auth_header = None;
        for line in lines {
            if let Some((name, value)) = line.split_once(':') {
                if name.eq_ignore_ascii_case("content-length") {
                    content_length = value.trim().parse().unwrap_or(0);
                } else if name.eq_ignore_ascii_case("authorization") {
                    auth_header = Some(value.trim().to_string());
                }
            }
        }
        // 请求头与体可能在同一 TCP 段到达——先消费已读缓冲中越过 head_end 的
        // 字节（否则 body 读会阻塞到超时，误判连接无数据）。
        let mut body = buf[head_end..].to_vec();
        while body.len() < content_length {
            let n = tokio::time::timeout(
                tokio::time::Duration::from_secs(1),
                socket.read(&mut chunk),
            )
            .await
            .ok()?
            .ok()?;
            if n == 0 {
                break;
            }
            body.extend_from_slice(&chunk[..n]);
        }
        let body_model = serde_json::from_slice::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("model").and_then(|m| m.as_str()).map(str::to_string));
        Some(CapturedRequest {
            path,
            auth_header,
            body_model,
        })
    }

    fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    }

    /// T4.3-R2（红 → 绿）：apply 新凭据后**下一次 provider 调用**必须携带
    /// 新凭据——真实 HTTP 请求载荷断言（URL 路径 = baseUrl、Authorization =
    /// key、请求体 model）。修复前 `config_profile_apply` 只写 store 不重载
    /// provider，请求仍按旧 baseUrl/key/model 发出 → 红。
    #[tokio::test]
    async fn config_profile_apply_swaps_next_provider_request_payload() {
        use tauri::Manager as _;
        let _lock = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = temp_config_dir();
        isolate_config_store(&dir);

        let server = RequestCaptureServer::start().await;
        let base_old = server.base_url("/v1-old");
        let base_new = server.base_url("/v1-new");

        // 旧配置 A：直接写 store（引擎构造时加载快照 A）
        crate::config::with_store_mut(|store| {
            store.set_api_key("sk-a".to_string())?;
            store.set_base_url(base_old.clone())?;
            store.set_model("model-a".to_string())?;
            Ok(())
        })
        .expect("store A");
        // 引擎在 store A 之上构造（构造时快照 A）。注意：reqwest 客户端在
        // 引擎构造时读取 HTTP_PROXY 等环境变量——清空保证请求真实直连本地
        // 服务器（不依赖机器代理配置；其余测试不发起真实 HTTP，无副作用）。
        for var in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ] {
            std::env::remove_var(var);
        }
        let state = core_state_with_store(Arc::new(InMemoryStore::new()));
        let app = tauri::test::mock_builder()
            .manage(Arc::clone(&state))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let st = app.state::<Arc<CoreRunState>>();

        // 模拟前端 apply 新凭据（key/baseUrl/model 全换）
        crate::config::config_profile_apply(
            st,
            "p1".to_string(),
            Some("sk-b".to_string()),
            Some(base_new.clone()),
            Some("model-b".to_string()),
        )
        .expect("apply B");

        // 下一次 provider 调用：真实 HTTP 请求，载荷必须用新凭据
        let provider = state.engine.provider().expect("provider 就绪");
        let messages: Vec<Arc<AgentMessage>> = Vec::new();
        let request = session_loop::provider::ProviderRequest {
            messages: &messages,
            tools: Vec::new(),
            max_tokens: None,
            system_prompt: None,
            session_id: None,
        };
        let stream = provider
            .stream(&request)
            .await
            .expect("本地服务器应可发起流");
        drop(stream);

        let captured = server.wait_for(1).await;
        assert_eq!(captured.len(), 1, "应恰好捕获 1 个请求");
        assert!(
            captured[0].path.starts_with("/v1-new/chat/completions"),
            "请求 URL 必须用新 baseUrl：{}",
            captured[0].path
        );
        assert_eq!(
            captured[0].auth_header.as_deref(),
            Some("Bearer sk-b"),
            "Authorization 必须用新 key：{:?}",
            captured[0].auth_header
        );
        assert_eq!(
            captured[0].body_model.as_deref(),
            Some("model-b"),
            "请求体 model 必须用新 model：{:?}",
            captured[0].body_model
        );
    }

    /// T4.3-R3（红 → 绿，命令级）：`config_profile_apply` 成功返回后
    /// `engine.provider_config()` 必须与新 store 值一致（key/baseUrl/model
    /// 三件套热更新）。修复前引擎只读构造时快照 → 仍旧值 → 红。
    #[tokio::test]
    async fn config_profile_apply_refreshes_engine_provider_config() {
        use tauri::Manager as _;
        let _lock = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = temp_config_dir();
        isolate_config_store(&dir);

        crate::config::with_store_mut(|store| {
            store.set_api_key("sk-a".to_string())?;
            store.set_base_url("https://a.example/v1".to_string())?;
            store.set_model("model-a".to_string())?;
            Ok(())
        })
        .expect("store A");
        let state = core_state_with_store(Arc::new(InMemoryStore::new()));
        assert_eq!(
            state
                .engine
                .provider_config()
                .expect("构造后就绪")
                .model,
            "model-a"
        );
        let app = tauri::test::mock_builder()
            .manage(Arc::clone(&state))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let st = app.state::<Arc<CoreRunState>>();

        // apply 新三件套 → 引擎生效配置必须同步刷新
        crate::config::config_profile_apply(
            st,
            "p1".to_string(),
            Some("sk-b".to_string()),
            Some("https://b.example/v1".to_string()),
            Some("model-b".to_string()),
        )
        .expect("apply B");

        let config = state.engine.provider_config().expect("重载后就绪");
        assert_eq!(config.api_key, "sk-b", "key 必须热更新");
        assert_eq!(config.base_url, "https://b.example/v1", "baseUrl 必须热更新");
        assert_eq!(config.model, "model-b", "model 必须热更新");
        assert!(state.engine.ready(), "重载后引擎必须就绪");
        assert!(state.engine.provider().is_some(), "重载后 provider 必须可调用");
    }

    /// T4.3-R4（红 → 绿，契约）：apiKey 清空（空串）apply 后引擎必须降级
    /// 未就绪——下一次 run 不得再用旧凭据；重填后恢复就绪。修复前 apply
    /// 不碰引擎 → 清 key 后仍就绪 → 红。
    #[tokio::test]
    async fn config_profile_apply_clearing_key_degrades_engine_ready() {
        use tauri::Manager as _;
        let _lock = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = temp_config_dir();
        isolate_config_store(&dir);

        crate::config::with_store_mut(|store| {
            store.set_api_key("sk-a".to_string())?;
            store.set_base_url("https://a.example/v1".to_string())?;
            store.set_model("model-a".to_string())?;
            Ok(())
        })
        .expect("store A");
        let state = core_state_with_store(Arc::new(InMemoryStore::new()));
        assert!(state.engine.ready(), "写 key 后就绪");
        let app = tauri::test::mock_builder()
            .manage(Arc::clone(&state))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let st = app.state::<Arc<CoreRunState>>();

        // 清空 key：引擎必须降级未就绪（provider=None，不再用旧 key 发请求）
        crate::config::config_profile_apply(st, "p1".to_string(), Some(String::new()), None, None)
            .expect("clear key");
        assert!(!state.engine.ready(), "清 key 后引擎必须未就绪");
        assert!(state.engine.provider().is_none(), "清 key 后 provider 必须为 None");
        assert!(
            state.engine.provider_config().is_none(),
            "清 key 后 provider_config 必须为 None"
        );

        // 重填后恢复
        crate::config::config_profile_apply(
            app.state::<Arc<CoreRunState>>(),
            "p1".to_string(),
            Some("sk-c".to_string()),
            None,
            None,
        )
        .expect("refill key");
        assert!(state.engine.ready(), "重填 key 后恢复就绪");
        assert_eq!(
            state
                .engine
                .provider_config()
                .expect("重填后就绪")
                .api_key,
            "sk-c"
        );
    }

    // ── PERSIST-02 P1-2：restore 完成/成功前禁止覆盖主快照 ──

    /// restore 完成前（restore_ready=false）保存快照被门禁拒绝——退出钩子
    /// /周期任务不得用「0 会话半水合快照」覆盖主快照（会话树分支历史
    /// 永久丢失）；restore 成功后放行。
    #[tokio::test]
    async fn snapshot_skipped_before_restore_ready_preserves_main_snapshot() {
        let (bridge, _emitter) = recording_bridge();
        let seq = CORE_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "conex_p12_guard_{}_{seq}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("snapshot.json");
        let snapshots: Arc<dyn SnapshotStore> =
            Arc::new(orchestrator::restore::SnapshotFileStore::new(&path));
        // 既有主快照（崩溃前最后完好快照，含会话树分支）
        let prior = StateSnapshot::build(
            3,
            42,
            vec![SessionRecord {
                session_id: "s1".to_string(),
                current_leaf_id: Some("leaf_keep".to_string()),
                branches: Vec::new(),
                context_meta: None,
            }],
            Vec::new(),
            Vec::new(),
            HashMap::new(),
        );
        snapshots.save_snapshot(&prior).unwrap();
        let state = Arc::new(CoreRunState::new(
            Arc::new(InMemoryStore::new()),
            snapshots,
            bridge,
            Arc::new(StatusDiagnostics::new()),
            None,
        ));
        // restore 尚未完成（restore_ready=false）→ 保存被拒绝，主快照原样
        state.save_snapshot_now().await;
        let loaded = orchestrator::restore::SnapshotFileStore::new(&path)
            .load_snapshot()
            .unwrap();
        let (snap, _) = loaded;
        assert!(snap.is_some(), "主快照必须保留");
        assert_eq!(snap.unwrap().generation, 3, "主快照未被半水合快照覆盖");
        assert!(
            state.snapshot_last_error().is_some(),
            "拒绝原因经 snapshot.lastError 可观测"
        );
        assert_eq!(state.snapshot_generation(), 0, "失败保存不推进 generation");
        // restore 成功 → 放行（run_restore 先置 restore_ready 再立即保存）
        state.run_restore().await;
        let loaded = orchestrator::restore::SnapshotFileStore::new(&path)
            .load_snapshot()
            .unwrap();
        let (snap, _) = loaded;
        let snap = snap.expect("restore 后快照必须保存");
        assert_eq!(snap.generation, 1, "恢复后保存（generation 从进程内 0 续接）");
        assert_eq!(snap.sessions.len(), 1, "快照携带水合后的会话（非 0 会话半水合）");
        assert_eq!(
            snap.sessions[0].current_leaf_id.as_deref(),
            Some("leaf_keep"),
            "会话树分支从既有快照水合保留"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// restore 失败路径（restore.state=failed）：保存仍被门禁拒绝——退出
    /// 钩子不得覆盖主快照（保留最后完好快照供下次恢复）；门禁照常放行
    /// run（不阻塞启动，懒计算兜底）。
    #[tokio::test]
    async fn snapshot_skipped_after_restore_failed_preserves_main_snapshot() {
        // 注入故障快照存储：load_snapshot 恒 Err → run_restore 失败降级；
        // save_snapshot 记录载荷，断言恢复失败后没有任何保存动作
        struct FailingSnapshots(std::sync::Mutex<Option<StateSnapshot>>);
        impl SnapshotStore for FailingSnapshots {
            fn load_snapshot(
                &self,
            ) -> Result<(Option<StateSnapshot>, Option<String>), orchestrator::restore::SnapshotError>
            {
                Err(orchestrator::restore::SnapshotError::new(
                    "load_snapshot",
                    "注入故障",
                ))
            }
            fn save_snapshot(&self, snapshot: &StateSnapshot) -> Result<(), orchestrator::restore::SnapshotError> {
                *self.0.lock().unwrap() = Some(snapshot.clone());
                Ok(())
            }
        }
        let failing = Arc::new(FailingSnapshots(std::sync::Mutex::new(None)));
        let snapshots: Arc<dyn SnapshotStore> = failing.clone();
        let state = Arc::new(CoreRunState::new(
            Arc::new(InMemoryStore::new()),
            snapshots,
            recording_bridge().0,
            Arc::new(StatusDiagnostics::new()),
            None,
        ));
        let outcome = state.run_restore().await;
        assert!(outcome.is_none(), "restore 失败路径返回 None");
        assert_eq!(state.restore_status().state, "failed", "restore.state=failed 可观测");
        assert!(state.restore_ready(), "失败路径不阻塞启动（降级放行）");
        // restore 失败后保存被拒绝：不覆盖主快照、不推进 generation
        state.save_snapshot_now().await;
        assert!(
            failing.0.lock().unwrap().is_none(),
            "restore 失败后不得保存任何快照（含半水合）"
        );
        assert!(
            state.snapshot_last_error().is_some(),
            "拒绝原因经 snapshot.lastError 可观测"
        );
        assert_eq!(state.snapshot_generation(), 0, "失败保存不推进 generation");
    }

    // ── T3.5 D5（F2-11 / F2-39）：快照三触发并发互斥 ────────────

    /// 直读快照文件并校验（不走 SnapshotStore::load_snapshot 的 .prev
    /// 回退，防「主快照损坏被兜底掩盖」误判——验收断言 1 要求主快照
    /// 本身可解析且通过 StateSnapshot::valid()）
    fn read_snapshot_file_direct(path: &std::path::Path) -> Option<StateSnapshot> {
        let raw = std::fs::read_to_string(path).ok()?;
        let snapshot: StateSnapshot = serde_json::from_str(&raw).ok()?;
        snapshot.valid().then_some(snapshot)
    }

    /// 快照三触发（终态/周期/退出共用 save_snapshot_now 入口）并发保存互斥：
    /// - 断言 1：最终主快照直读经 StateSnapshot::valid() 通过（文件完整可解析）；
    /// - 断言 2（R4 修订，AU-02 A5）：join 后第二次代数 > 第一次（单调递增，
    ///   顺序无关不 flaky）；两次保存代数互异且差恰为 1（读-改-写丢失 →
    ///   两路同读 G 同写 G+1 → 主/备份同代数必红）；
    /// - 断言 3：保存后目录无 .tmp 残留（tmp 已 rename 清空）。
    /// 真实并发形态：两个独立 std::thread（各自 current_thread runtime
    /// block_on，对齐生产退出钩子「独立 std::thread 调 save_snapshot_blocking」
    /// 的形态，R2 §4）经 Barrier 对齐后同时保存——OS 抢占式真并行，缺陷必现。
    /// 不选 tokio::spawn：read-G→store 段无内部 await（query 全为即时就绪），
    /// 单 worker LIFO 会把两任务串行化执行，缺陷被掩盖（实测 2/2 通过）；
    /// 不选固定 sleep 编排（防作弊 B5）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn snapshot_concurrent_saves_are_mutexed() {
        let seq = CORE_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "conex_d5_mutex_{}_{seq}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("snapshot.json");
        let snapshots: Arc<dyn SnapshotStore> =
            Arc::new(orchestrator::restore::SnapshotFileStore::new(&path));
        let state = Arc::new(CoreRunState::new(
            Arc::new(InMemoryStore::new()),
            snapshots,
            recording_bridge().0,
            Arc::new(StatusDiagnostics::new()),
            None,
        ));
        // 注入若干 run：放大「read-G → store-G」窗口（空 store 下整段保存
        // 微秒级完成；500 条 run 使保存段拉长到数百 µs，双线程并行读 G 时
        // 另一方几乎不可能在 store 之后才读——竞态必现）
        for i in 0..500 {
            state
                .store
                .insert_run(
                    &format!("r_{i}"),
                    "s1",
                    RunStatus::Completed,
                    Some("stop"),
                    0,
                )
                .await
                .unwrap();
        }
        // restore 完成 → 门禁放行 + 首张快照（generation 1，主快照就位；
        // 空库全量重放路径，对齐 snapshot_skipped_before_restore_ready 先例）
        assert!(state.run_restore().await.is_some(), "空库全量重放必须成功");
        assert_eq!(state.snapshot_generation(), 1, "恢复后立即保存（generation 1）");
        // R4 修订：第一次测量（join 前）
        let first = state.snapshot_generation();
        for _ in 0..8 {
            // 每轮 Barrier 对齐后双线程真实并发保存（退出钩子同形态）
            let barrier = Arc::new(std::sync::Barrier::new(2));
            let a = Arc::clone(&state);
            let b = Arc::clone(&state);
            let ba = Arc::clone(&barrier);
            let bb = Arc::clone(&barrier);
            let thread_a = std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("测试 runtime 可建");
                ba.wait();
                rt.block_on(async move { a.save_snapshot_now().await });
            });
            let thread_b = std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("测试 runtime 可建");
                bb.wait();
                rt.block_on(async move { b.save_snapshot_now().await });
            });
            thread_a.join().expect("保存线程 A 正常结束");
            thread_b.join().expect("保存线程 B 正常结束");
            // 断言 3：保存后目录无 .tmp 残留
            let residue: Vec<String> = std::fs::read_dir(&dir)
                .unwrap()
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.file_name().to_string_lossy().to_string())
                .filter(|name| name.ends_with(".tmp"))
                .collect();
            assert!(residue.is_empty(), "保存后目录不得残留 .tmp：{residue:?}");
            // 断言 2：两次保存代数互异且差恰为 1（顺序无关；
            // 无互斥时两路同读 G 同写 G+1 → 主/备份同代数 → 本断言必红）
            let main_snap = read_snapshot_file_direct(&path)
                .expect("主快照必须存在且通过 checksum 校验（文件完整可解析）");
            let prev_path = PathBuf::from(format!("{}.prev", path.display()));
            let prev_snap = read_snapshot_file_direct(&prev_path)
                .expect("上一份快照轮转为备份且完整可解析");
            assert_ne!(
                main_snap.generation, prev_snap.generation,
                "两次并发保存的代数必须互异（generation 读-改-写丢失 → 两路同代数）"
            );
            assert_eq!(
                main_snap.generation.max(prev_snap.generation)
                    - main_snap.generation.min(prev_snap.generation),
                1,
                "两次保存代数差恰为 1（顺序无关）"
            );
            // 断言 1：主快照经 StateSnapshot::valid() 通过（直读已校验），
            // 内存代数与文件代数一致（取两者较大者）
            assert_eq!(
                state.snapshot_generation(),
                main_snap.generation.max(prev_snap.generation),
                "内存代数与文件代数一致（较大者）"
            );
            assert!(
                state.snapshot_last_error().is_none(),
                "互斥下并发保存不得产生错误（无轮转 rename 碰撞）"
            );
        }
        // R4 修订：第二次测量（join 后）> 第一次（单调递增，顺序无关）
        let second = state.snapshot_generation();
        assert!(
            second > first,
            "R4：join 后第二次代数（{second}）> 第一次（{first}）"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ③ run_usage 真实返回：LocalDb 路径——save_run_usage 落库 →
    /// run_usage 读回 → RunUsage 全字段映射（runs 表 v5 列，T-39）
    #[test]
    fn run_usage_returns_persisted_stats_from_local_db() {
        let db = LocalDb::open_in_memory().unwrap();
        db.insert_session("s1", "s1").unwrap();
        db.insert_run("r1", "s1", RunStatus::Completed, Some("stop"), 0)
            .unwrap();
        let stats = cache_stats(Some(61_000), 12_000);
        db.save_run_usage("r1", stats).unwrap();

        let state = core_state_with_store(Arc::new(LocalDbStore::new(db.clone())));
        let usage = state.run_usage("r1").expect("已落库 usage 必须返回");
        assert_eq!(usage.prompt_tokens, 10_000);
        assert_eq!(usage.completion_tokens, 100);
        assert_eq!(usage.sample_count, 1);
        assert_eq!(usage.cache_read_tokens, Some(9_000));
        assert_eq!(usage.cache_write_tokens, Some(500));
        assert_eq!(usage.cache_miss_tokens, Some(500));
        // hit_ratio 按 C9 重算：read / (miss + read + write)
        assert_eq!(usage.hit_ratio, Some(9_000.0 / 10_000.0));
        assert_eq!(usage.write_ratio, Some(500.0 / 10_000.0));
        assert_eq!(usage.missed_tokens, Some(12_000));
        assert_eq!(usage.warm_until_ms, Some(61_000));
        // 不存在的 run → None（前端回退估算）
        assert!(state.run_usage("missing").is_none());
    }

    /// ③ 兜底：store 非 LocalDb（InMemoryStore 测试替身）→ run_usage
    /// None（local_db 下转失败路径，usage 查询回退前端估算）
    #[test]
    fn run_usage_falls_back_none_without_local_db() {
        let state = core_state_with_store(Arc::new(InMemoryStore::new()));
        assert!(state.local_db().is_none(), "非 LocalDb store 不得下转");
        assert!(state.run_usage("r1").is_none());
    }

    /// 验收（30 方案 P3）：steering_queue 访问器与引擎队列同一 Arc 实例
    /// （消费器与定时器/Cron 共用同一队列，杜绝双实例分叉）。
    #[test]
    fn core_state_steering_queue_accessor_same_instance() {
        let state = core_state_with_store(Arc::new(InMemoryStore::new()));
        let via_state = state.steering_queue();
        let via_engine = state.engine.timer_steering_queue();
        assert!(
            Arc::ptr_eq(&via_state, &via_engine),
            "访问器与引擎 timer_steering_queue 必须同一 Arc 实例"
        );
    }

    /// 验收（30 方案 P3）：task_events 消费器装配可达（CoreRunState::new
    /// 内与 pending_queue 同实例构造，无独立队列分叉）。
    #[test]
    fn core_state_task_events_consumer_shares_queue() {
        let state = core_state_with_store(Arc::new(InMemoryStore::new()));
        let consumer = state.task_events();
        // 经消费器终态入队 → 访问器侧可见（同一共享队列的字段级断言）
        consumer.on_task_event(&AgentEvent::TaskStarted {
            session_id: String::new(),
            task_id: "t-a".into(),
            command: "cargo build".into(),
            cwd: "/ws".into(),
            owner_run_id: "run-main".into(),
            is_daemon: false,
        });
        consumer.on_task_event(&AgentEvent::TaskCompleted {
            session_id: String::new(),
            task_id: "t-a".into(),
            exit_code: 0,
            duration_ms: 1200,
            line_count: 99,
        });
        let queue = state.steering_queue();
        let queue = queue.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(queue.len(), 1, "消费器条目落入共享队列");
        assert_eq!(queue.peek().unwrap().text, "任务 t-a 已完成，退出码 0");
    }

    /// 验收（30 方案 P7）：cron_has_enabled 在 CoreRunState::new 内装配——
    /// 真实引擎路径下判定器非 None（SchedulerRegistry 非空封装
    /// has_active；与 timer_has_active 先例对称，A5-H02 生产缺失消除）
    #[test]
    fn cron_has_enabled_assembled_in_new() {
        let state = core_state_with_store(Arc::new(InMemoryStore::new()));
        let check = state
            .cron_has_enabled
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        assert!(
            check.is_some(),
            "CoreRunState::new 必须装配 cron_has_enabled 判定器（真实引擎路径）"
        );
        // scheduler_registry 访问器同步可达（P6 装配面数据源）
        assert!(
            state.scheduler_registry().is_some(),
            "引擎装配后 scheduler_registry 应为 Some"
        );
    }

    /// 验收（30 方案 P6 装配轮）：WorkflowCommandState 注入共享队列后，
    /// 命令层触发条目真实落入 CoreRunState 的 pending_queue——同实例
    /// 的行为级证明（main.rs 装配行：WorkflowCommandState::new(db,
    /// core_state.steering_queue())；消除 A5-H01a 队列双实例）
    #[tokio::test]
    async fn main_assembly_shared_queue_single_instance() {
        let db = LocalDb::open_in_memory().expect("内存库");
        db.upsert_session_entry(&subagent_test_session_entry("s1"))
            .expect("会话条目");
        let state = core_state_with_store(Arc::new(LocalDbStore::new(db.clone())));
        // main.rs 装配轮同序构造
        let workflow_state = crate::workflow_commands::WorkflowCommandState::new(
            db,
            state.steering_queue(),
        );
        let view = workflow_state
            .backend()
            .create(
                "装配检查".to_string(),
                "检查仓库".to_string(),
                crate::workflow_commands::WorkflowScheduleWire::Manual,
                None,
                None,
                true,
            )
            .await
            .expect("创建应成功");
        workflow_state
            .backend()
            .trigger(&view.id)
            .expect("触发应成功");
        // 条目落入引擎共享队列（命令层注入 sink 与 CoreRunState 同一实例）
        let queue = state.steering_queue();
        let queue = queue.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(queue.len(), 1, "命令层触发必须落入引擎共享队列");
        let entry = queue.peek().expect("队列必有条目");
        assert!(entry.is_steering, "workflow 条目为 steering 受保护位");
        assert!(
            entry.text.contains("检查仓库"),
            "条目含 workflow prompt 触发模板：{}",
            entry.text
        );
        assert_eq!(
            entry.group_id.as_deref(),
            Some(format!("cron-{}", view.id).as_str()),
            "group_id = cron-<id>"
        );
    }

    /// ② 收口落库：write_back_cache_stats 经 LocalDb 写回 runs 表 v5 列
    /// （save_run_usage 幂等 UPDATE），读回整型一致
    #[tokio::test]
    async fn write_back_cache_stats_persists_run_usage_to_local_db() {
        let db = LocalDb::open_in_memory().unwrap();
        db.insert_session("s1", "s1").unwrap();
        db.insert_run("r1", "s1", RunStatus::Completed, Some("stop"), 0)
            .unwrap();
        let state = core_state_with_store(Arc::new(LocalDbStore::new(db.clone())));

        let stats = cache_stats(Some(61_000), 12_000);
        write_back_cache_stats(&state, "s1", "r1", stats).await;

        let read_back = db
            .get_run_usage("r1")
            .expect("读回不应失败")
            .expect("收口必须落库");
        assert_eq!(read_back, stats);
        // 收口不 panic 且落库失败路径不中断（本场景无失败，仅验证无害）
        write_back_cache_stats(&state, "s1", "r1", stats).await;
    }

    /// ② 兜底：store 非 LocalDb（InMemoryStore）→ 落库跳过（无 SQLite
    /// 连接），收口流程不 panic、不中断
    #[tokio::test]
    async fn write_back_cache_stats_skips_save_without_local_db() {
        let state = core_state_with_store(Arc::new(InMemoryStore::new()));
        write_back_cache_stats(&state, "s1", "r1", cache_stats(None, 0)).await;
    }

    /// ④ EngineHandle 会话缓存状态写读面（跨 CoreRunState 可达）：
    /// update_cache_session → cache_session 读回——write_back_cache_stats
    /// 的 update 分支数据源契约（配置分支依赖 provider 生效配置，
    /// 测试环境未就绪 → 装配侧由 engine.rs 测试覆盖）
    #[test]
    fn engine_cache_session_roundtrip_through_core_state() {
        let state = core_state_with_store(Arc::new(InMemoryStore::new()));
        let stats = cache_stats(Some(61_000), 0);
        state
            .engine
            .update_cache_session("s1", &stats, "deepseek-v4-flash");
        let session = state.engine.cache_session("s1");
        assert_eq!(session.last_stats, Some(stats));
        assert_eq!(session.last_model.as_deref(), Some("deepseek-v4-flash"));
        // 未写过的会话 → 缺省状态（默认值）
        let untouched = state.engine.cache_session("other");
        assert!(untouched.last_stats.is_none());
        assert!(untouched.last_model.is_none());
    }

    // ── I2-S5：trash 命令（误删恢复入口）────────────────────────

    static TRASH_TMP_SEQ: AtomicU64 = AtomicU64::new(0);

    /// 测试用临时目录（独立命名，drop 自动清理）
    struct TrashTempDir(PathBuf);

    impl TrashTempDir {
        fn new(prefix: &str) -> Self {
            let seq = TRASH_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "conex_trash_cmd_{prefix}_{}_{seq}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &PathBuf {
            &self.0
        }

        fn write(&self, rel: &str, content: &str) -> PathBuf {
            let p = self.0.join(rel);
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(&p, content).unwrap();
            p
        }
    }

    impl Drop for TrashTempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// trash_list / trash_restore 往返：条目可见、恢复后字节一致、登记清除
    #[test]
    fn trash_commands_list_restore_roundtrip() {
        let ws = TrashTempDir::new("rt");
        let file = ws.write("a.txt", "hello trash command");
        let trash = TrashTempDir::new("root");

        // 种入条目（删除接口与恢复命令同根）
        let entry = conex_fs::trash::TrashService::new(trash.path())
            .trash_file(&file, true)
            .unwrap();

        let listed = trash_list_at(trash.path()).unwrap();
        assert_eq!(listed.entries.len(), 1);
        assert_eq!(listed.entries[0].id, entry.id);
        assert_eq!(listed.entries[0].original_path, file);
        assert_eq!(listed.entries[0].size, 19);
        assert!(listed.entries[0].checksum.is_some(), "backup=true 写校验和");
        assert!(listed.trash_root.contains("root"), "trash_root: {}", listed.trash_root);

        let restored = trash_restore_at(trash.path(), &entry.id).unwrap();
        assert!(restored.ok);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "hello trash command");
        assert!(
            trash_list_at(trash.path()).unwrap().entries.is_empty(),
            "恢复成功后登记应清除"
        );
    }

    /// trash_purge：彻底清除后条目消失、恢复报 NotFound
    #[test]
    fn trash_purge_removes_entry_and_restore_fails() {
        let ws = TrashTempDir::new("purge");
        let file = ws.write("doomed.txt", "gone");
        let trash = TrashTempDir::new("root");
        let service = conex_fs::trash::TrashService::new(trash.path());
        let entry = service.trash_file(&file, false).unwrap();

        let purged = trash_purge_at(trash.path(), &entry.id).unwrap();
        assert!(purged.ok);
        assert_eq!(purged.entry_id, entry.id);
        assert!(trash_list_at(trash.path()).unwrap().entries.is_empty());

        let err = trash_restore_at(trash.path(), &entry.id).unwrap_err();
        assert!(matches!(err, CoreError::NotFound(_)), "err: {err}");
    }

    /// 非法 entry_id → InvalidInput；不存在的条目 → NotFound（防路径穿越）
    #[test]
    fn trash_restore_rejects_invalid_and_missing_entry_ids() {
        let trash = TrashTempDir::new("root");

        let err = trash_restore_at(trash.path(), "../../evil").unwrap_err();
        assert!(matches!(err, CoreError::InvalidInput(_)), "err: {err}");
        let err = trash_restore_at(trash.path(), "a/b").unwrap_err();
        assert!(matches!(err, CoreError::InvalidInput(_)), "err: {err}");
        let err = trash_restore_at(trash.path(), "nope").unwrap_err();
        assert!(matches!(err, CoreError::NotFound(_)), "err: {err}");
        let err = trash_purge_at(trash.path(), "../evil").unwrap_err();
        assert!(matches!(err, CoreError::InvalidInput(_)), "err: {err}");
    }

    /// 未注入回收站根 → 兜底活动工作区 `.crish-trash`（与删除工具一致）
    #[test]
    fn trash_root_falls_back_to_workspace_dot_crish_trash() {
        let ws = TrashTempDir::new("ws");
        let file = ws.write("notes.txt", "workspace fallback");

        // 兜底根 = <工作区>/.crish-trash（resolve_guard 路径由 workspace 域测试覆盖，
        // 此处验证兜底目录名的登记/列出语义与删除工具一致）
        let root = ws.path().join(DEFAULT_TRASH_DIR_NAME);
        let service = conex_fs::trash::TrashService::new(&root);
        let entry = service.trash_file(&file, true).unwrap();

        let listed = trash_list_at(&root).unwrap();
        assert_eq!(listed.entries.len(), 1);
        assert_eq!(listed.entries[0].id, entry.id);
        assert!(listed.trash_root.ends_with(".crish-trash"));
    }

    // ── I2-S8：回收站恢复/清除动作审计发射 ──

    /// 记录型发射器（核心事件桥测试替身；Emitter trait 公开可注入）
    #[derive(Default)]
    struct RecordingEmitter(std::sync::Mutex<Vec<String>>);

    impl crate::core_event_bridge::Emitter for RecordingEmitter {
        fn emit(&self, _channel: &str, payload: &str) {
            self.0.lock().unwrap().push(payload.to_string());
        }
    }

    fn recording_bridge() -> (EventBridge, Arc<RecordingEmitter>) {
        let emitter = Arc::new(RecordingEmitter::default());
        let bridge = EventBridge::new(
            "workbench-run-event",
            Arc::clone(&emitter) as Arc<dyn crate::core_event_bridge::Emitter>,
        );
        (bridge, emitter)
    }

    /// trash_restore / trash_purge 动作带会话上下文时，经事件桥发射
    /// security-audit 信封（decision=restored/purged，runId 缺省前端放行）
    #[test]
    fn emit_trash_audit_sends_security_audit_envelope() {
        let (bridge, emitter) = recording_bridge();

        let report = emit_trash_audit(
            &bridge,
            Some("s1"),
            SecurityAuditOperation::TrashRestore,
            SecurityAuditDecision::Restored,
            "a.txt",
            5,
        );
        assert_eq!(
            report,
            EmitReport {
                emitted: 1,
                buffered: 0,
                dropped: 0
            }
        );

        // 先取回载荷再断言（Mutex 不可重入：guard 存活期间不得再发射）
        let payloads = emitter.0.lock().unwrap().clone();
        assert_eq!(payloads.len(), 1, "恢复动作应发射 1 条审计信封");
        let v: serde_json::Value =
            serde_json::from_str(&payloads[0]).expect("载荷为合法 JSON");
        assert_eq!(v["type"], "security-audit");
        assert_eq!(v["sessionId"], "s1");
        assert_eq!(v["operation"], "trash-restore");
        assert_eq!(v["decision"], "restored");
        assert_eq!(v["targets"][0], "a.txt");
        assert_eq!(v["impact"]["fileCount"], 1);
        assert_eq!(v["impact"]["totalSizeBytes"], 5);
        // runId/sequence 缺省：用户级引擎命令不属 run 上下文（前端放行不过滤）
        assert!(v.get("runId").is_none(), "runId 应缺省");
        assert!(v.get("sequence").is_none(), "sequence 应缺省");
        assert_eq!(v["schemaVersion"], 1);

        let report_purge = emit_trash_audit(
            &bridge,
            Some("s1"),
            SecurityAuditOperation::TrashPurge,
            SecurityAuditDecision::Purged,
            "b.txt",
            8,
        );
        assert_eq!(report_purge.emitted, 1);
        let payloads2 = emitter.0.lock().unwrap().clone();
        let v2: serde_json::Value =
            serde_json::from_str(&payloads2[1]).expect("载荷为合法 JSON");
        assert_eq!(v2["operation"], "trash-purge");
        assert_eq!(v2["decision"], "purged");
    }

    /// 未携带会话上下文：跳过事件发射（wire 零条），仅落审计日志
    #[test]
    fn emit_trash_audit_without_session_skips_wire_out() {
        let (bridge, emitter) = recording_bridge();

        let report = emit_trash_audit(
            &bridge,
            None,
            SecurityAuditOperation::TrashRestore,
            SecurityAuditDecision::Restored,
            "a.txt",
            5,
        );
        assert_eq!(report, EmitReport::default(), "无会话上下文不发射");
        assert!(emitter.0.lock().unwrap().is_empty(), "事件桥不得收到载荷");
    }

    /// 审计信封中的事件体可被 AgentEvent 契约反序列化（事件类型注册表一致）
    #[test]
    fn emit_trash_audit_payload_parses_as_security_audit() {
        let (bridge, emitter) = recording_bridge();
        emit_trash_audit(
            &bridge,
            Some("s1"),
            SecurityAuditOperation::TrashPurge,
            SecurityAuditDecision::Purged,
            "c.txt",
            12,
        );
        let payload = &emitter.0.lock().unwrap()[0];
        let envelope: AgentEventEnvelope = serde_json::from_str(payload).unwrap();
        assert_eq!(envelope.type_name(), "security-audit");
        let AgentEvent::SecurityAudit { decision, impact, .. } = envelope.event else {
            panic!("应为 security-audit 事件");
        };
        assert_eq!(decision, SecurityAuditDecision::Purged);
        assert_eq!(impact.file_count, 1);
        assert_eq!(impact.total_size_bytes, 12);
    }

    // ── T-AB-19：run 生命周期整合（owner_run_id / 守护进程 / L0-L3）────

    use crate::background::BackgroundTaskRegistry;
    use std::process::Stdio;
    use tokio::process::Child;

    /// 测试注册表序号：每个测试独占日志根（并行测试互不污染）
    static BG_TMP_SEQ: AtomicU64 = AtomicU64::new(0);

    /// L3 配置项测试串行锁：环境变量为进程级，「默认不联动」与「开启
    /// 联动」两组测试共享锁，避免并行运行时互相污染环境变量
    static L3_CONFIG_LOCK: Mutex<()> = Mutex::new(());

    /// 测试用长运行命令（adopt 后保持 Running；20s 窗口足够测试收尾）
    fn long_command() -> &'static str {
        if cfg!(windows) {
            "Start-Sleep -Seconds 20"
        } else {
            "sleep 20"
        }
    }

    /// 测试用持续输出命令（每 100ms 一行，约 4s；日志增长断言用）
    fn output_command() -> &'static str {
        if cfg!(windows) {
            "1..40 | ForEach-Object { Write-Output ('line ' + $_); Start-Sleep -Milliseconds 100 }"
        } else {
            "i=0; while [ $i -lt 40 ]; do echo line $i; i=$((i+1)); sleep 0.1; done"
        }
    }

    /// 测试注册表（独立日志根；不启动归档循环，30 分钟保留足够）
    fn bg_test_registry() -> Arc<BackgroundTaskRegistry> {
        let seq = BG_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "crish-bg-run-lifecycle-{}-{seq}",
            std::process::id()
        ));
        BackgroundTaskRegistry::with_log_root(root, Duration::from_secs(30 * 60))
    }

    /// 测试命令构造（PowerShell / bash 平台分支；kill_on_drop=false +
    /// 双管道，对齐 T-AB-02 后台托管契约）
    fn build_test_command(command: &str) -> tokio::process::Command {
        let mut cmd = if cfg!(windows) {
            let mut c = tokio::process::Command::new("powershell.exe");
            c.args(["-NoProfile", "-Command", command]);
            c
        } else {
            let mut c = tokio::process::Command::new("bash");
            c.args(["-c", command]);
            c
        };
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(false);
        cmd
    }

    /// 真实 spawn 测试子进程（工具执行链 spawn 语义）
    fn spawn_test_child(command: &str) -> Child {
        let mut cmd = build_test_command(command);
        cmd.stdin(Stdio::null());
        cmd.spawn().expect("spawn test child")
    }

    /// adopt 请求构造（owner_run_id 恒 None——模拟工具执行链；注入由
    /// RunAwareBackgroundManager 装饰器完成）
    fn adopt_request(child: Child, command: &str, is_daemon: bool) -> BackgroundAdoptRequest {
        BackgroundAdoptRequest {
            child,
            command: command.to_string(),
            cwd: PathBuf::from("."),
            is_daemon,
            resource_monitor: false,
            owner_run_id: None,
        }
    }

    #[cfg(windows)]
    fn pid_is_alive(pid: u32) -> bool {
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}")])
            .output()
            .expect("tasklist must run");
        String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
    }

    #[cfg(not(windows))]
    fn pid_is_alive(pid: u32) -> bool {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// 测试用 CoreRunState（注入包装后的真实注册表；独立快照与事件桥）
    fn core_state_with_background(
        store: Arc<dyn Store>,
        registry: Arc<BackgroundTaskRegistry>,
    ) -> Arc<CoreRunState> {
        let (bridge, _emitter) = recording_bridge();
        let seq = CORE_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let snapshots: Arc<dyn SnapshotStore> = Arc::new(
            orchestrator::restore::SnapshotFileStore::new(std::env::temp_dir().join(format!(
                "conex_core_state_{}_{seq}_snapshot.json",
                std::process::id()
            ))),
        );
        Arc::new(CoreRunState::new(
            store,
            snapshots,
            bridge,
            Arc::new(StatusDiagnostics::new()),
            Some(Arc::clone(&registry) as Arc<dyn BackgroundTaskManager>),
        ))
    }

    /// 便捷构造「状态 + 注册表」对（InMemoryStore 测试替身）
    fn state_with_background() -> (Arc<CoreRunState>, Arc<BackgroundTaskRegistry>) {
        let registry = bg_test_registry();
        let state = core_state_with_background(Arc::new(InMemoryStore::new()), Arc::clone(&registry));
        (state, registry)
    }

    /// 组装活动 run（测试直驱 drive_run_loop 的收口路径；装配面与
    /// core_run_task 对齐：EventQueue / 缓冲桥 / 审批门 / 逃逸监视 None）
    async fn build_active_run(
        state: &CoreRunState,
        session_id: &str,
        run_id: &str,
    ) -> Arc<ActiveRun> {
        let handle = Arc::new(tokio::sync::Mutex::new(
            state
                .run_manager
                .start_run(session_id, run_id)
                .await
                .expect("start_run"),
        ));
        let queue = Arc::new(tokio::sync::Mutex::new(EventQueue::new(
            state.store.clone(),
            0,
        )));
        let bridge = Arc::new(BufferedRunEventBridge::new(
            state.bridge.clone(),
            run_id.to_string(),
        ));
        let broadcast_bridge = Arc::clone(&bridge);
        let broadcast_run_id = run_id.to_string();
        let broadcast = Box::new(move |event: AgentEvent| {
            let envelope = AgentEventEnvelope::new(event, Some(broadcast_run_id.clone()), None);
            broadcast_bridge.emit(&envelope);
            broadcast_bridge.flush();
        });
        let approval = Arc::new(ApprovalGateImpl::new(
            run_id.to_string(),
            session_id.to_string(),
            None,
            broadcast,
            Arc::clone(&handle),
            state.store.clone(),
            None,
        ));
        Arc::new(ActiveRun {
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            handle,
            queue,
            control_bus: Arc::new(Mutex::new(ControlBus::new())),
            abort_signal: AbortSignal::new(),
            approval,
            bridge,
            delta_sink_active: true,
            escape_watch: Mutex::new(None),
            driver: Mutex::new(None),
            user_touched: AtomicBool::new(false),
            // T-D-13：测试驱动路径的子代理配置缺省 None（普通 run 语义）
            subagent: None,
            // L4（F12）：测试驱动路径未装配审计落库 worker（收口跳过）
            audit_persist: Mutex::new(None),
        })
    }

    /// 测试生产者：返回预置收口结果（驱动 drive_run_loop 一次终态）
    struct TestProducer {
        outcome: RunOutcome,
        /// 共享 produce 调用计数（T-CF-11 续 run 断言；续 run 链各轮共享）
        calls: Arc<AtomicU64>,
    }

    impl TestProducer {
        /// 新建生产者（独立计数）
        fn new(outcome: RunOutcome) -> Self {
            Self::with_calls(outcome, Arc::new(AtomicU64::new(0)))
        }

        /// 新建生产者（共享计数——断言跨轮 produce 总调用次数）
        fn with_calls(outcome: RunOutcome, calls: Arc<AtomicU64>) -> Self {
            Self { outcome, calls }
        }
    }

    #[async_trait::async_trait]
    impl RunProducer for TestProducer {
        async fn produce(&mut self) -> RunOutcome {
            self.calls.fetch_add(1, Ordering::SeqCst);
            std::mem::replace(&mut self.outcome, canned_outcome())
        }
    }

    /// 预置收口结果（Stop 正常收口；事件流为空，仅 run-terminal）
    fn canned_outcome() -> RunOutcome {
        RunOutcome {
            reason: AgentEndReason::Stop,
            error: None,
            diagnostic: None,
            messages: vec![Arc::new(amsg(
                "u1",
                AgentMessageRole::User,
                vec![text_block("run 终态测试")],
            ))],
            events: Vec::new(),
            turn_index: 0,
            tool_call_count: 0,
            steering_count: 0,
            cache_stats: None,
        }
    }

    // ── L3（R-CF3）：事件收口 mark_wakeup 生产接线 ──────────────

    /// 事件收口接线：drive_run_loop 事件 emit 循环推进 last_wakeup——
    /// run 事件到达后 watchdog 失联判定数据源不再恒 None（防误报
    /// "无唤醒"；watchdog 侧判定逻辑由 watchdog.rs 单测覆盖）
    #[tokio::test]
    async fn drive_run_loop_marks_wakeup_on_events() {
        let state = core_state_with_store(Arc::new(InMemoryStore::new()));
        assert!(
            state.engine.last_wakeup().last_wakeup_ms().is_none(),
            "接线断言前：从未有事件到达（None）"
        );
        let active = build_active_run(&state, "s1", "run-l3-1").await;
        drive_run_loop(
            Arc::clone(&state),
            Arc::clone(&active),
            Box::new(TestProducer::new(canned_outcome())),
        )
        .await;
        assert!(
            state.engine.last_wakeup().last_wakeup_ms().is_some(),
            "run 事件到达后 last_wakeup 应更新（watchdog 不再误报无唤醒）"
        );
    }

    /// 子代理终态收口接线：on_subagent_run_terminal 推进 last_wakeup——
    /// 等待期间的关键事件源（长等待中不误报"无唤醒"）
    #[tokio::test]
    async fn subagent_terminal_marks_wakeup() {
        let state = core_state_with_store(Arc::new(InMemoryStore::new()));
        let cfg = crate::subagent_spawner::SubagentRunConfig {
            subagent_id: "sa-1".to_string(),
            subagent_run_id: "run-sa-1".to_string(),
            parent_session_id: "s1".to_string(),
            task_type: None,
            allowed_write_paths: None,
            output_dir: None,
            started_at_ms: 1_000,
        };
        state
            .on_subagent_run_terminal(&cfg, RunStatus::Completed)
            .await;
        assert!(
            state.engine.last_wakeup().last_wakeup_ms().is_some(),
            "子代理终态事件到达后 last_wakeup 应更新"
        );
    }

    /// 轮询至任务终态（窗口内未到则 panic）
    async fn wait_task_terminal(
        registry: &BackgroundTaskRegistry,
        task_id: &str,
        window: Duration,
    ) {
        let deadline = tokio::time::Instant::now() + window;
        loop {
            let status = registry.status(task_id).await.expect("status");
            if status.status != TaskState::Running {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "任务 {task_id} 未在窗口内进入终态"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// T-AB-19 验收：工具执行链 adopt 后 `owner_run_id` 等于当前 runId——
    /// 装饰器在请求进入注册表前注入「当前 run 上下文」；无上下文恒 None
    /// （现状兜底）；显式携带透传不改写；run 终态清除上下文后回到 None。
    #[tokio::test]
    async fn adopt_records_owner_run() {
        let (state, registry) = state_with_background();

        // run 上下文未设置 → 恒 None（未注入路径兜底）
        let child = spawn_test_child(long_command());
        let r0 = state
            .background
            .adopt(adopt_request(child, "no-run", false))
            .await
            .expect("adopt");
        let listed = registry.list(true).await.expect("list");
        let i0 = listed.iter().find(|i| i.task_id == r0.task_id).unwrap();
        assert_eq!(i0.owner_run_id, None, "无 run 上下文不得注入");

        // 工具执行链语义：run 开始登记上下文 → adopt（owner_run_id 恒
        // None）→ 注入当前 runId
        state.background.set_current_run("run-owner-1");
        let child = spawn_test_child(long_command());
        let r1 = state
            .background
            .adopt(adopt_request(child, "in-run", false))
            .await
            .expect("adopt");
        let listed = registry.list(true).await.expect("list");
        let i1 = listed.iter().find(|i| i.task_id == r1.task_id).unwrap();
        assert_eq!(
            i1.owner_run_id.as_deref(),
            Some("run-owner-1"),
            "adopt 后 owner_run_id 必须等于当前 runId"
        );

        // 显式携带（非 None）→ 透传不改写
        let child = spawn_test_child(long_command());
        let mut req = adopt_request(child, "explicit", false);
        req.owner_run_id = Some("run-other".to_string());
        let r2 = state.background.adopt(req).await.expect("adopt");
        let listed = registry.list(true).await.expect("list");
        let i2 = listed.iter().find(|i| i.task_id == r2.task_id).unwrap();
        assert_eq!(i2.owner_run_id.as_deref(), Some("run-other"), "显式携带不得被覆盖");

        // run 终态（收口路径清除上下文）→ 后续 adopt 回到 None
        state.background.clear_current_run("run-owner-1");
        assert_eq!(state.background.current_run(), None, "run 终态应释放上下文");
        let child = spawn_test_child(long_command());
        let r3 = state
            .background
            .adopt(adopt_request(child, "after-run", false))
            .await
            .expect("adopt");
        let listed = registry.list(true).await.expect("list");
        let i3 = listed.iter().find(|i| i.task_id == r3.task_id).unwrap();
        assert_eq!(i3.owner_run_id, None, "run 终态后 adopt 不得注入旧 runId");

        // 清理
        for r in [r0, r1, r2, r3] {
            let _ = registry.kill(&r.task_id).await;
        }
    }

    /// T-AB-19 验收：守护进程任务（is_daemon=true）在 run 终态后存活
    /// 且日志持续累积（run 终态 → 任务存活 → 日志增长，端到端收口路径）
    #[tokio::test]
    async fn run_end_daemon_survives() {
        let (state, registry) = state_with_background();
        state.background.set_current_run("run-daemon-1");
        let child = spawn_test_child(output_command());
        let pid = child.id().expect("spawned pid");
        let adopted = state
            .background
            .adopt(adopt_request(child, "run-daemon", true))
            .await
            .expect("adopt");

        // 等首行输出（转发器就位，日志已开始累积）
        let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
        loop {
            let status = registry.status(&adopted.task_id).await.expect("status");
            if status.line_count > 0 {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "守护任务迟迟无输出"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        // 驱动 run 终态（真实 drive_run_loop 收口路径）
        let active = build_active_run(&state, "s1", "run-daemon-1").await;
        state
            .active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert("run-daemon-1".to_string(), Arc::clone(&active));
        drive_run_loop(
            Arc::clone(&state),
            Arc::clone(&active),
            Box::new(TestProducer::new(canned_outcome())),
        )
        .await;

        // run 终态后：任务存活（Running、pid 存活）+ 日志持续累积
        let s1 = registry.status(&adopted.task_id).await.expect("status");
        assert_eq!(s1.status, TaskState::Running, "守护任务在 run 终态后必须存活");
        assert!(pid_is_alive(pid), "守护任务进程必须存活");
        let lines_before = s1.line_count;
        // 日志增长断言条件化（F-009 flaky 根因：固定 sleep(1200) 在负载
        // 下 writer 转发可能延迟 → 改轮询观测状态，8s 上限充足）
        let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
        let mut s2 = s1;
        loop {
            s2 = registry.status(&adopted.task_id).await.expect("status");
            if s2.line_count > lines_before {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "run 终态后日志迟迟不累积"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(
            s2.line_count > lines_before,
            "run 终态后日志必须持续累积：{lines_before} -> {}",
            s2.line_count
        );
        // 收口路径释放了「当前 run」上下文（下一 run 可复用注入槽）
        assert_eq!(state.background.current_run(), None);

        // 清理
        let _ = registry.kill(&adopted.task_id).await;
    }

    /// T-AB-19 验收：普通任务（is_daemon=false）在 run 终态后不被级联杀
    /// （pid 存活；registry 生命周期独立于 run——T-AB-12 契约显式锚定）
    #[tokio::test]
    async fn run_end_normal_task_survives_no_cascade() {
        let (state, registry) = state_with_background();
        state.background.set_current_run("run-normal-1");
        let child = spawn_test_child(long_command());
        let pid = child.id().expect("spawned pid");
        let adopted = state
            .background
            .adopt(adopt_request(child, "run-normal-task", false))
            .await
            .expect("adopt");

        // 驱动 run 终态
        let active = build_active_run(&state, "s1", "run-normal-1").await;
        state
            .active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert("run-normal-1".to_string(), Arc::clone(&active));
        drive_run_loop(
            Arc::clone(&state),
            Arc::clone(&active),
            Box::new(TestProducer::new(canned_outcome())),
        )
        .await;

        // run 终态后：普通任务不被级联杀
        assert!(pid_is_alive(pid), "普通任务不得被 run 终态级联杀（pid 存活）");
        let status = registry.status(&adopted.task_id).await.expect("status");
        assert_eq!(status.status, TaskState::Running, "任务状态不得被改写");
        assert_eq!(state.background.current_run(), None);

        // 清理
        let _ = registry.kill(&adopted.task_id).await;
    }

    /// T-AB-19 验收：L3 force 取消后任务仍存活（默认不联动——职责单一，
    /// 避免误杀，对齐方案 REQ 4.3）
    #[tokio::test]
    async fn l3_force_cancel_keeps_tasks() {
        // 环境变量为进程级：与开启联动测试共用串行锁（默认断言不受污染）
        let _guard = L3_CONFIG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::remove_var("CONEX_RUN_CONTROL_L3_TASK_CANCEL");

        let (state, registry) = state_with_background();
        state.background.set_current_run("run-l3-default");
        let child = spawn_test_child(long_command());
        let pid = child.id().expect("spawned pid");
        let adopted = state
            .background
            .adopt(adopt_request(child, "l3-normal", false))
            .await
            .expect("adopt");
        let active = build_active_run(&state, "s1", "run-l3-default").await;
        state
            .active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert("run-l3-default".to_string(), Arc::clone(&active));

        run_control_impl(&state, "run-l3-default", "force_cancel", None, Some("测试".to_string()), None)
            .await
            .expect("force_cancel");

        // 默认不联动：任务存活（未终止、仍在注册表）
        let listed = registry.list(true).await.expect("list");
        let info = listed
            .iter()
            .find(|i| i.task_id == adopted.task_id)
            .expect("任务仍在注册表");
        assert_eq!(info.status, TaskState::Running, "L3 默认不得触碰任务");
        assert!(pid_is_alive(pid), "任务进程必须存活（默认不联动）");

        // 清理
        let _ = registry.kill(&adopted.task_id).await;
    }

    /// T-AB-19 可选接线（配置项开启）：L3 force 对当前 run 的普通任务
    /// （is_daemon=false）发起优雅终止，守护任务不触碰——默认关闭，本
    /// 测试显式开启环境变量验证联动语义
    #[tokio::test]
    async fn l3_force_cancel_kills_normal_tasks_when_enabled() {
        let _guard = L3_CONFIG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("CONEX_RUN_CONTROL_L3_TASK_CANCEL", "1");

        let (state, registry) = state_with_background();
        state.background.set_current_run("run-l3-on");
        // 普通任务（联动目标：将被优雅终止）
        let child = spawn_test_child(long_command());
        let normal = state
            .background
            .adopt(adopt_request(child, "l3-normal-kill", false))
            .await
            .expect("adopt");
        // 守护任务（联动豁免：不触碰）
        let child = spawn_test_child(long_command());
        let daemon_pid = child.id().expect("spawned pid");
        let daemon = state
            .background
            .adopt(adopt_request(child, "l3-daemon-keep", true))
            .await
            .expect("adopt");
        let active = build_active_run(&state, "s1", "run-l3-on").await;
        state
            .active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert("run-l3-on".to_string(), Arc::clone(&active));

        run_control_impl(&state, "run-l3-on", "force_cancel", None, Some("测试".to_string()), None)
            .await
            .expect("force_cancel");

        // 普通任务进入终态（两阶段 kill），守护任务存活
        wait_task_terminal(&registry, &normal.task_id, Duration::from_secs(30)).await;
        let normal_status = registry.status(&normal.task_id).await.expect("status");
        assert_eq!(
            normal_status.status,
            TaskState::Killed,
            "普通任务应被优雅终止（Killed）：{:?}",
            normal_status.status
        );
        let daemon_status = registry.status(&daemon.task_id).await.expect("status");
        assert_eq!(
            daemon_status.status,
            TaskState::Running,
            "守护任务不得被 L3 联动触碰"
        );
        assert!(pid_is_alive(daemon_pid), "守护任务进程必须存活");

        // 清理
        let _ = registry.kill(&daemon.task_id).await;
    }

    /// T-AB-19 验收：core_get_status 含任务汇总字段——活跃任务数 /
    /// 守护进程数 / 最近终态（数据源 = CoreRunState 汇总访问器；wire
    /// 形状 camelCase 由 core_query_commands 单测锚定）
    #[tokio::test]
    async fn get_status_reports_tasks() {
        let (state, registry) = state_with_background();
        state.background.set_current_run("run-status-1");

        // 守护任务 + 普通任务（活跃）
        let child = spawn_test_child(long_command());
        let daemon = state
            .background
            .adopt(adopt_request(child, "status-daemon", true))
            .await
            .expect("adopt");
        let child = spawn_test_child(long_command());
        let normal = state
            .background
            .adopt(adopt_request(child, "status-normal", false))
            .await
            .expect("adopt");
        // 终态任务（自然退出）
        let child = spawn_test_child("exit 0");
        let finished = state
            .background
            .adopt(adopt_request(child, "status-finished", false))
            .await
            .expect("adopt");
        wait_task_terminal(&registry, &finished.task_id, Duration::from_secs(30)).await;

        let summary = state.background_tasks_summary().await;
        assert_eq!(summary.active_count, 2, "活跃任务数 = 守护 + 普通");
        assert_eq!(summary.daemon_count, 1, "守护进程数 = 活跃守护任务数");
        let last = summary
            .last_finished
            .as_ref()
            .expect("有终态任务必须给出最近终态");
        assert_eq!(&last.task_id, &finished.task_id);
        assert_eq!(last.status, "completed");

        // wire 形状（camelCase，core_get_status 透出面）
        let json = serde_json::to_value(&summary).unwrap();
        assert_eq!(json["activeCount"], 2);
        assert_eq!(json["daemonCount"], 1);
        assert_eq!(json["lastFinished"]["taskId"], finished.task_id);
        assert_eq!(json["lastFinished"]["status"], "completed");

        // 清理
        for r in [daemon, normal] {
            let _ = registry.kill(&r.task_id).await;
        }
    }

    /// T-AB-19 会话切换契约锚定：任务属会话级（registry 生命周期独立于
    /// run 与会话）——会话 A 的 run 结束并切换到会话 B 发起新 run 后，
    /// 会话 A 的任务仍存活
    #[tokio::test]
    async fn session_switch_keeps_tasks() {
        let (state, registry) = state_with_background();

        // 会话 A：run 内 adopt 守护任务
        state.background.set_current_run("run-sess-a");
        let child = spawn_test_child(long_command());
        let pid = child.id().expect("spawned pid");
        let adopted = state
            .background
            .adopt(adopt_request(child, "sess-a-task", true))
            .await
            .expect("adopt");

        // 会话 A run 终态
        let active_a = build_active_run(&state, "sess-a", "run-sess-a").await;
        state
            .active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert("run-sess-a".to_string(), Arc::clone(&active_a));
        drive_run_loop(
            Arc::clone(&state),
            Arc::clone(&active_a),
            Box::new(TestProducer::new(canned_outcome())),
        )
        .await;

        // 会话切换：会话 B 发起新 run 并终态（注册表不被任何会话边界清理）
        state.background.set_current_run("run-sess-b");
        let active_b = build_active_run(&state, "sess-b", "run-sess-b").await;
        state
            .active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert("run-sess-b".to_string(), Arc::clone(&active_b));
        drive_run_loop(
            Arc::clone(&state),
            Arc::clone(&active_b),
            Box::new(TestProducer::new(canned_outcome())),
        )
        .await;

        // 会话 A 的任务在会话切换后仍存活
        assert!(pid_is_alive(pid), "会话切换后任务必须存活");
        let status = registry.status(&adopted.task_id).await.expect("status");
        assert_eq!(status.status, TaskState::Running);

        // 清理
        let _ = registry.kill(&adopted.task_id).await;
    }

    // ── T-CF-11：idle 待命续 run（G7 / REQ-C04 验收 1/2）────────────

    /// 测试用续 run 拉起器替身：记录注入消息 + 用共享计数 producer 再驱动
    /// 一轮（模拟「新 run 的 produce」——续 run 链；队列已转空 → 收口
    /// 判定不续，链自然终止）
    fn resume_launcher_probe(
        calls: Arc<AtomicU64>,
        injected: Arc<Mutex<Vec<Vec<AgentMessage>>>>,
    ) -> ResumeLauncher {
        let launcher: ResumeLauncher = Arc::new(move |state, session_id, messages| {
            let calls = Arc::clone(&calls);
            let injected = Arc::clone(&injected);
            let state = Arc::clone(state);
            let session_id = session_id.to_string();
            Box::pin(async move {
                injected
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push(messages);
                // 续 run 链：以新 run id 再驱动一轮（队列已清空 → 收口不再续）
                let active = build_active_run(&state, &session_id, "run-resume-1").await;
                state
                    .active_runs
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert("run-resume-1".to_string(), Arc::clone(&active));
                drive_run_loop(
                    state,
                    active,
                    Box::new(TestProducer::with_calls(canned_outcome(), calls)),
                )
                .await;
            })
        });
        launcher
    }

    /// 记录型拉起器替身（仅计数，不拉起新 run）
    fn counting_launcher(counter: Arc<AtomicU64>) -> ResumeLauncher {
        let launcher: ResumeLauncher = Arc::new(move |_state, _session_id, _messages| {
            let counter = Arc::clone(&counter);
            Box::pin(async move {
                counter.fetch_add(1, Ordering::SeqCst);
            })
        });
        launcher
    }

    /// 验收：收口时队列有 1 条目（跨 run steering：子代理完成）→ 自动续开
    /// 一轮 run——produce 再次调用 + 条目原文进入注入消息
    #[tokio::test]
    async fn idle_resume_run_when_queue_non_empty() {
        let (state, _registry) = state_with_background();
        // 队列条目（与引擎同实例的 PendingMessageQueue；生成侧已按 §4.8
        // 模板拼入唤醒摘要，注入即条目原文）
        state
            .pending_queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .enqueue(SteeringInputEntry::steering(
                "e1",
                "子代理 sa-1（分析）已完成：completed",
                1_785_456_000_000,
            ));
        let calls = Arc::new(AtomicU64::new(0));
        let injected: Arc<Mutex<Vec<Vec<AgentMessage>>>> = Arc::new(Mutex::new(Vec::new()));
        state.set_resume_launcher(Some(resume_launcher_probe(
            Arc::clone(&calls),
            Arc::clone(&injected),
        )));

        let active = build_active_run(&state, "s1", "run-1").await;
        state
            .active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert("run-1".to_string(), Arc::clone(&active));
        drive_run_loop(
            Arc::clone(&state),
            active,
            Box::new(TestProducer::with_calls(canned_outcome(), Arc::clone(&calls))),
        )
        .await;

        // produce 再次调用（首轮 + 续 run 轮）
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "队列非空应收口后自动续开一轮 run"
        );
        // 条目进入注入消息（原文含摘要文本；批量聚合为单条）
        let probe = injected.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(probe.len(), 1, "应恰好拉起一次续 run");
        assert_eq!(probe[0].len(), 1, "批量注入 = 单条聚合消息（不逐条唤醒）");
        assert!(
            probe[0][0].text().contains("子代理 sa-1（分析）已完成"),
            "注入消息应含条目原文：{}",
            probe[0][0].text()
        );
        // 条目已批量转出，队列清空
        assert!(
            state
                .pending_queue
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty(),
            "条目批量转出后队列应清空"
        );
    }

    /// 验收：队列空 + 定时器表空 + Cron 表空（未接线）→ 不续 run（produce
    /// 次数不增；AI 休眠待用户）
    #[tokio::test]
    async fn idle_no_resume_when_all_empty() {
        let (state, _registry) = state_with_background();
        let calls = Arc::new(AtomicU64::new(0));
        let launcher_calls = Arc::new(AtomicU64::new(0));
        state.set_resume_launcher(Some(counting_launcher(Arc::clone(&launcher_calls))));

        let active = build_active_run(&state, "s1", "run-1").await;
        state
            .active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert("run-1".to_string(), Arc::clone(&active));
        drive_run_loop(
            Arc::clone(&state),
            active,
            Box::new(TestProducer::with_calls(canned_outcome(), Arc::clone(&calls))),
        )
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 1, "三源全空不得续 run");
        assert_eq!(
            launcher_calls.load(Ordering::SeqCst),
            0,
            "三源全空时续 run 拉起器不得被调用"
        );
    }

    /// 验收：连续 3 次续 run 均无 AI 产出 → 停止续 run（防空转风暴；
    /// 第 4 次判定返回 None）；有产出后护栏清零恢复
    #[tokio::test]
    async fn idle_resume_stops_after_consecutive_empty() {
        let (state, _registry) = state_with_background();
        // 定时器判定器持续活跃（唤醒源保持——验证护栏独立于唤醒源）
        state.set_timer_has_active(Some(Arc::new(|| Box::pin(async { true }))));
        let active = build_active_run(&state, "s1", "run-1").await;

        // 连续空转（无 AI 产出）：前 3 次判定命中（续 run）
        for round in 1..=3u32 {
            let verdict =
                decide_idle_resume(&state, &active, AgentEndReason::Stop, false).await;
            assert!(verdict.is_some(), "第 {round} 次无产出续 run 应命中（护栏上限 3）");
        }
        // 第 4 次：连续 3 次无产出 → 停止续 run
        let stopped = decide_idle_resume(&state, &active, AgentEndReason::Stop, false).await;
        assert!(stopped.is_none(), "连续 3 次无产出后应停止续 run");

        // 有产出 → 计数清零，重新可续
        let verdict = decide_idle_resume(&state, &active, AgentEndReason::Stop, true).await;
        assert!(verdict.is_some(), "有产出后护栏清零，续 run 恢复");
        let verdict = decide_idle_resume(&state, &active, AgentEndReason::Stop, false).await;
        assert!(verdict.is_some(), "清零后空转计数从 1 重新开始");
    }

    /// 验收：用户取消路径不触发续 run（force_cancel → abort_signal +
    /// reason=Aborted；队列即使非空也不续）
    #[tokio::test]
    async fn idle_resume_not_on_user_cancel() {
        let (state, _registry) = state_with_background();
        state
            .pending_queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .enqueue(SteeringInputEntry::steering("e1", "子代理完成", 1000));
        let launcher_calls = Arc::new(AtomicU64::new(0));
        state.set_resume_launcher(Some(counting_launcher(Arc::clone(&launcher_calls))));

        let active = build_active_run(&state, "s1", "run-1").await;
        // force_cancel 语义（run_control_impl L3 路径）：abort_signal 触发
        active.abort_signal.abort();
        state
            .active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert("run-1".to_string(), Arc::clone(&active));
        // 取消后的收口 outcome：reason=Aborted（producer 按 abort 收场）
        let cancelled = RunOutcome {
            reason: AgentEndReason::Aborted,
            ..canned_outcome()
        };
        drive_run_loop(
            Arc::clone(&state),
            active,
            Box::new(TestProducer::new(cancelled)),
        )
        .await;

        assert_eq!(
            launcher_calls.load(Ordering::SeqCst),
            0,
            "用户取消不得触发续 run"
        );
    }

    /// 补充：用户消息到达后的正常收场不触发续 run（本 run 内经 L1
    /// soft_inject 收到用户消息 → user_touched 置位；队列非空也不续）
    #[tokio::test]
    async fn idle_resume_not_after_user_interaction() {
        let (state, _registry) = state_with_background();
        state
            .pending_queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .enqueue(SteeringInputEntry::steering("e1", "子代理完成", 1000));
        let launcher_calls = Arc::new(AtomicU64::new(0));
        state.set_resume_launcher(Some(counting_launcher(Arc::clone(&launcher_calls))));

        let active = build_active_run(&state, "s1", "run-1").await;
        state
            .active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert("run-1".to_string(), Arc::clone(&active));
        // 用户经 L1 注入消息（soft_inject，source=ui）
        run_control_impl(
            &state,
            "run-1",
            "soft_inject",
            Some("请继续".to_string()),
            None,
            None,
        )
        .await
        .expect("soft_inject 应成功");

        drive_run_loop(
            Arc::clone(&state),
            active,
            Box::new(TestProducer::new(canned_outcome())),
        )
        .await;

        assert_eq!(
            launcher_calls.load(Ordering::SeqCst),
            0,
            "用户消息到达后的正常收场不得触发续 run"
        );
    }

    /// 补充：enabled Cron 任务（SchedulerRegistry 判定器注入）→ 收口时
    /// 队列空也续 run（保持待命）；无队列条目 → 空注入
    #[tokio::test]
    async fn idle_resume_when_cron_enabled() {
        let (state, _registry) = state_with_background();
        state.set_cron_has_enabled(Some(Arc::new(|| Box::pin(async { true }))));
        let active = build_active_run(&state, "s1", "run-1").await;

        let verdict = decide_idle_resume(&state, &active, AgentEndReason::Stop, true).await;
        assert!(verdict.is_some(), "Cron enabled 应触发续 run");
        assert!(
            verdict.unwrap().is_empty(),
            "队列空时无注入文本（空注入保持待命）"
        );
    }

    /// 验收（30 方案 P7，E2E-7 后半）：真实 SchedulerRegistry 注册 enabled
    /// cron → 收口判定队列空也续 run（保持待命，不再休眠）——判定器经
    /// has_active 真实生效（注册表表内条目即活跃，非测试替身注入）
    #[tokio::test]
    async fn decide_idle_resume_cron_source_resumes() {
        let (state, _registry) = state_with_background();
        let registry = state.scheduler_registry().expect("装配后应为 Some");
        // 注入超长触发延迟：仅占位活跃（表内条目即活跃），测试窗口内不触发
        registry.set_fire_override_ms(3_600_000);
        let cron_id = registry
            .register(crate::sched::CronTaskInput {
                expression: "* * * * *".to_string(),
                prompt: "cron 待命检查".to_string(),
                max_iterations: Some(1),
                is_daemon: false,
            })
            .await
            .expect("cron 注册应成功");
        let active = build_active_run(&state, "s1", "run-1").await;
        let verdict = decide_idle_resume(&state, &active, AgentEndReason::Stop, true).await;
        assert!(
            verdict.is_some(),
            "注册 enabled cron 后队列空也应续 run 保持待命（Cron 源真实生效）"
        );
        assert!(
            verdict.unwrap().is_empty(),
            "队列空时无注入文本（空注入保持待命）"
        );
        // 清理：cancel 移除声明（防跨测试污染）
        registry.cancel(&cron_id).await.ok();
    }

    /// 验收（30 方案 P7）：判定器 None（SchedulerRegistry 装配降级）→
    /// Cron 源 false——与接线前行为一致（三源全空不续 run）
    #[tokio::test]
    async fn scheduler_none_degrades_cron_off() {
        let (state, _registry) = state_with_background();
        state.set_cron_has_enabled(None);
        let active = build_active_run(&state, "s1", "run-1").await;
        let verdict = decide_idle_resume(&state, &active, AgentEndReason::Stop, true).await;
        assert!(
            verdict.is_none(),
            "Cron 判定器 None → Cron 源 false（与接线前行为一致，三源全空不续 run）"
        );
    }

    // ======================================================================
    // T-D-13：引擎侧 SubagentSpawner 集成测试（生产 spawner 全链路）
    // ======================================================================

    /// 会话索引条目（测试用主会话）
    fn subagent_test_session_entry(id: &str) -> conex_types::SessionIndexEntry {
        conex_types::SessionIndexEntry {
            id: id.to_string(),
            title: format!("会话 {id}"),
            folder: String::new(),
            is_pinned: false,
            is_archived: false,
            branch_parent_id: None,
            timestamp: "2026-08-05T00:00:00.000Z".to_string(),
            updated_at: 1,
            message_count: 0,
            pinned_message_ids: None,
            engine_cursor: Some(0),
            engine_last_run_id: None,
            hydrated_from_engine: Some(true),
        }
    }

    /// 按会话路由的测试 provider（确定性脚本分配）：ProviderRequest.session_id
    /// 由 SharedProvider 注入（loop 的会话 id）——主 agent 会话（非 sub-sess-*
    /// 前缀）走主脚本序列，子代理会话走子脚本序列。消除共享 TestProvider
    /// 调用序号交错导致的脚本分配不确定（T-D-13 端到端测试基建）。
    #[derive(Debug)]
    struct SessionRoutedProvider {
        main: Arc<TestProvider>,
        sub: Arc<TestProvider>,
    }

    #[async_trait::async_trait]
    impl ProviderCall for SessionRoutedProvider {
        async fn stream<'a>(
            &self,
            request: &session_loop::provider::ProviderRequest<'a>,
        ) -> Result<
            session_loop::provider::ProviderEventStream,
            conex_types::response::ClassifiedStreamError,
        > {
            let target = match request.session_id.as_deref() {
                Some(s) if s.starts_with("sub-sess-") => &self.sub,
                _ => &self.main,
            };
            target.stream(request).await
        }
    }

    /// 集成装配：LocalDbStore 状态 + spawner 注入面 + 会话路由 TestProvider
    /// 引擎就绪。返回 (state, db, main_provider, sub_provider, emitter)。
    fn subagent_state_with_providers(
        main: Arc<TestProvider>,
        sub: Arc<TestProvider>,
        model: &str,
    ) -> (
        Arc<CoreRunState>,
        LocalDb,
        Arc<TestProvider>,
        Arc<TestProvider>,
        Arc<RecordingEmitter>,
    ) {
        let (bridge, emitter) = recording_bridge();
        let db = LocalDb::open_in_memory().expect("内存库");
        db.upsert_session_entry(&subagent_test_session_entry("sess-main"))
            .expect("会话条目");
        let seq = CORE_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let snapshots: Arc<dyn SnapshotStore> = Arc::new(
            orchestrator::restore::SnapshotFileStore::new(std::env::temp_dir().join(format!(
                "conex_subagent_e2e_{}_{seq}_snapshot.json",
                std::process::id()
            ))),
        );
        let state = Arc::new(CoreRunState::new(
            Arc::new(LocalDbStore::new(db.clone())),
            snapshots,
            bridge,
            Arc::new(StatusDiagnostics::new()),
            None,
        ));
        // T-D-13：spawner 注入面装配（launcher / db / 广播 / steering 队列）
        state.finalize_subagent_spawner();
        let routed: Arc<dyn ProviderCall> = Arc::new(SessionRoutedProvider {
            main: Arc::clone(&main),
            sub: Arc::clone(&sub),
        });
        let config = EngineProviderConfig {
            base_url: "http://test.local/v1".to_string(),
            api_key: "test-key".to_string(),
            model: model.to_string(),
            endpoint: Endpoint::ChatCompletions,
            stream: true,
            extra: BTreeMap::new(),
        };
        state.engine.inject_provider_for_test(routed, config);
        (state, db, main, sub, emitter)
    }

    /// 主 agent 会话的测试脚本（通用形态：派发调用 + 收口 + 兜底）
    fn main_agent_scripts(spawn_call: serde_json::Value) -> Vec<Vec<ProviderStreamEvent>> {
        vec![
            vec![
                ProviderStreamEvent::text("开始派发。"),
                ProviderStreamEvent::tool_call(Some("c1".to_string()), "run_subagent", spawn_call),
                ProviderStreamEvent::stop(StopReason::ToolCall),
            ],
            vec![
                ProviderStreamEvent::text("已派发。"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ],
            // 兜底（idle 续 run 等越界调用）：安全收口
            vec![
                ProviderStreamEvent::text("收到通知。"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ],
            vec![
                ProviderStreamEvent::text("继续。"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ],
        ]
    }

    /// 轮询等待全部活动 run 收口（tauri::async_runtime::spawn 的任务在
    /// 独立 tokio 任务执行；窗口内未收口则 panic）
    async fn wait_all_runs_terminal(state: &CoreRunState, window: Duration) {
        let deadline = tokio::time::Instant::now() + window;
        loop {
            let active = state.active_runs.lock().unwrap_or_else(|e| e.into_inner());
            if active.is_empty() {
                return;
            }
            eprintln!("等待收口中：活动 run = {:?}", active.keys().collect::<Vec<_>>());
            drop(active);
            assert!(
                tokio::time::Instant::now() < deadline,
                "活动 run 未在窗口内全部收口"
            );
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    }

    /// 轮询等待子代理行进入终态（completed/failed）
    async fn wait_agent_rows_terminal(db: &LocalDb, session_id: &str, expect: usize, window: Duration) {
        let deadline = tokio::time::Instant::now() + window;
        loop {
            let rows = db.load_session_agents(session_id).expect("读行");
            let terminal = rows
                .iter()
                .filter(|r| r.status == "completed" || r.status == "failed")
                .count();
            if terminal >= expect {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "子代理行未在窗口内进入终态（{terminal}/{expect}）"
            );
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    }

    fn test_options(run_id: &str, session_id: &str, prompt: &str) -> RunTaskOptions {
        RunTaskOptions {
            run_id: run_id.to_string(),
            session_id: session_id.to_string(),
            prompt: Some(prompt.to_string()),
            mode: Some("task".to_string()),
            cwd: None,
            // 主 agent run 用 full-access：工具批不弹审批（permission_mode
            // None = 全批审批的既有语义；子代理 run 的权限面由 spawner 装配
            // None——full-access 不传导，测试聚焦子代理侧）
            permission_mode: Some("full-access".to_string()),
            client_message_id: None,
            assistant_client_message_id: None,
            system_prompt: None,
            history: None,
            context_window: None,
            parent_run_id: None,
            subagent_config: None,
        }
    }

    /// 主 agent 裁决助手（Mock 裁决器语义）：轮询并批准全部挂起审批
    /// （子代理 run 工具调用 → 审批路由主 agent → 测试直接裁决放行；
    /// 返回裁决次数）
    async fn resolve_all_pending_approvals(state: &CoreRunState, window: Duration) -> usize {
        let deadline = tokio::time::Instant::now() + window;
        let mut resolved = 0usize;
        loop {
            let run_ids: Vec<String> = {
                let active = state.active_runs.lock().unwrap_or_else(|e| e.into_inner());
                active.keys().cloned().collect()
            };
            let mut acted = false;
            for run_id in run_ids {
                let run = {
                    let active = state.active_runs.lock().unwrap_or_else(|e| e.into_inner());
                    active.get(&run_id).cloned()
                };
                if let Some(run) = run {
                    let call_id = {
                        let pending = run
                            .approval
                            .pending
                            .lock()
                            .unwrap_or_else(|e| e.into_inner());
                        pending.keys().next().cloned()
                    };
                    if let Some(call_id) = call_id {
                        run.approval
                            .resolve(&call_id, ApprovalDecision::Approved)
                            .await
                            .expect("主 agent 裁决应成功");
                        resolved += 1;
                        acted = true;
                    }
                }
            }
            if !acted {
                // 无挂起审批且已无活动 run → 完成；否则继续等待新审批
                let empty = state
                    .active_runs
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .is_empty();
                if empty {
                    return resolved;
                }
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "活动 run 存在但审批未在窗口内触发"
                );
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        }
    }

    /// 验收 1：单发/批量端到端——run_subagent 不再 unsupported → 子代理 run
    /// 真实启动 → 终态事件回传（父会话落库 + wait 广播）→ 主 Agent 经
    /// steering 收到通知；提示词注入断言（角色约束 / 权限申请 / started_at
    /// / git 回退段）。
    #[tokio::test]
    async fn run_subagent_end_to_end_not_unsupported_with_terminal_and_steering() {
        // 主 agent 脚本：第 1 次调用 = 派发两个子代理（批量 tasks）；
        // 第 2 次调用（工具结果回合）= 正常收口；子代理脚本 = 安全收口
        //（text + stop，无工具调用）；会话路由 provider 保证脚本确定性
        let main = Arc::new(TestProvider::with_scripts(vec![
            vec![
                ProviderStreamEvent::text("我将并行派发两个调研子代理。"),
                ProviderStreamEvent::tool_call(
                    Some("c1".to_string()),
                    "run_subagent",
                    serde_json::json!({
                        "tasks": [
                            { "prompt": "调研模块 A", "taskType": "analysis", "displayLabel": "调研A" },
                            { "prompt": "调研模块 B", "taskType": "analysis", "displayLabel": "调研B" }
                        ]
                    }),
                ),
                ProviderStreamEvent::stop(StopReason::ToolCall),
            ],
            vec![
                ProviderStreamEvent::text("两个子代理已派发，等待结果。"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ],
            vec![
                ProviderStreamEvent::text("收到通知。"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ],
            vec![
                ProviderStreamEvent::text("继续。"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ],
        ]));
        let sub = Arc::new(TestProvider::new(vec![
            ProviderStreamEvent::text("调研完成。"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ]));
        let (state, db, main, sub, _emitter) =
            subagent_state_with_providers(main, sub, "deepseek-v4-flash");
        state.run_restore().await;

        // 主 agent run（完整 run_task_impl → drive_run_loop）
        run_task_impl(
            Arc::clone(&state),
            test_options("run-main", "sess-main", "并行派发两个调研子代理"),
        )
        .await
        .expect("主 agent run 发起成功");
        // 等待全部 run（主 agent + 两个子代理）收口；子代理行进入终态
        wait_all_runs_terminal(&state, Duration::from_secs(30)).await;
        wait_agent_rows_terminal(&db, "sess-main", 2, Duration::from_secs(20)).await;

        // 1. 工具不再返回 common.unsupported：两个子代理行落库 + 结果信封
        let rows = db.load_session_agents("sess-main").expect("读行");
        assert_eq!(rows.len(), 2, "批量派发应落库两行");
        assert!(rows.iter().all(|r| r.parent_run_id == "run-main"));
        // 批量条目契约（D3-1 冻结：tasks 条目仅 prompt/role/displayLabel/
        // capabilityMode/timeoutMs/description）不携带 taskType——落库 None，
        // 引擎装配按缺省 analysis（最安全 fail-closed）
        assert!(rows.iter().all(|r| r.task_type.is_none()));
        assert!(rows.iter().all(|r| r.depth == Some(1)));
        assert_eq!(rows[0].display_label.as_deref(), Some("调研A"));
        assert_eq!(rows[1].display_label.as_deref(), Some("调研B"));

        // 2. 子代理 run 真实启动并收口：行进入终态（completed/failed）
        assert!(
            rows.iter().all(|r| r.status == "completed" || r.status == "failed"),
            "子代理行终态：{rows:?}"
        );

        // 3. 终态事件回传：subagent-started + subagent-ended 落库（父会话）
        let events = db.query_events("sess-main", 0, Some(200)).expect("事件查询");
        let started = events
            .iter()
            .filter(|e| e.event_type == "subagent-started")
            .count();
        let ended = events
            .iter()
            .filter(|e| e.event_type == "subagent-ended")
            .count();
        assert_eq!(started, 2, "subagent-started 每次 spawn 发射一次");
        assert_eq!(ended, 2, "subagent-ended 每个终态发射一次");

        // 4. 主 Agent 经 steering 收到通知：子代理终态条目入队后，主 agent
        //    的 idle 待命续 run（decide_idle_resume）消费条目并注入——通知
        //    载体 = 队列条目（未被消费时）或续 run 的注入消息（已消费时）
        let entries = {
            let mut queue = state.pending_queue.lock().unwrap_or_else(|e| e.into_inner());
            queue.dequeue_all()
        };
        let queue_notified = entries
            .iter()
            .any(|e| e.is_steering && e.text.contains("子代理"));
        let injected_notified = main.requests().iter().any(|r| {
            r.messages
                .iter()
                .any(|m| m.text().contains("子代理"))
        });
        assert!(
            queue_notified || injected_notified,
            "主 agent 必须经 steering 收到子代理完成通知（队列条目或续 run 注入消息）"
        );

        // 5. 提示词注入断言：子代理 run 的 provider 请求 system_prompt 含
        //    注入段（会话路由 provider：sub 请求全部来自子代理 run——
        //    确定性，不依赖调用序号筛选）
        let sub_prompts: Vec<String> = sub
            .requests()
            .iter()
            .filter_map(|r| r.system_prompt.clone())
            .collect();
        assert_eq!(sub_prompts.len(), 2, "两个子代理 run 各一次带注入的请求");
        for prompt in &sub_prompts {
            // T-D-03：子代理角色约束（主 agent run 不含本段）
            assert!(prompt.contains("## 子代理角色约束"));
            assert!(prompt.contains("所有子 Agent 由主 Agent 分配"));
            // T-D-14：权限申请指引
            assert!(prompt.contains("## 权限申请指引"));
            assert!(prompt.contains("申请由主 agent 审批"));
            // C2：started_at 注入 + git 回退谨慎指引
            assert!(prompt.contains("## 会话注入（started_at）"));
            assert!(prompt.contains("## git 回退谨慎指引"));
        }
        // 主 agent run 不含子代理角色约束段
        let main_prompt = main
            .requests()
            .first()
            .and_then(|r| r.system_prompt.clone())
            .unwrap_or_default();
        assert!(
            !main_prompt.contains("## 子代理角色约束"),
            "主 Agent run 不含角色约束段（T-D-03 关键差异点）"
        );
    }

    /// 验收 2：嵌套拒绝端到端——守卫兜底（NestingDenied 结构化错误）确定性
    /// 验证（T-D-02：子 Agent 无派发能力）。工具面剔除（子代理注册表无
    /// run_subagent）为同一 filter 机制（[filter_registry] 谓词），其装配
    /// 生效由验收 3（analysis 无写工具 is_error）同构验证 + agent-tools
    /// filter 单测覆盖；此处子代理 run 用安全脚本收口。
    #[tokio::test]
    async fn subagent_run_nesting_denied_both_tool_surface_and_guard() {
        // 会话路由 provider：主 agent 脚本（派发 + 收口 + 兜底）；
        // 子代理脚本 = 安全收口（无嵌套调用）
        let main = Arc::new(TestProvider::with_scripts(main_agent_scripts(
            serde_json::json!({ "prompt": "调研模块 A", "taskType": "analysis" }),
        )));
        let sub = Arc::new(TestProvider::new(vec![
            ProviderStreamEvent::text("调研完成，回报主 agent。"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ]));
        let (state, db, _main, _sub, _emitter) =
            subagent_state_with_providers(main, sub, "deepseek-v4-flash");
        state.run_restore().await;

        run_task_impl(
            Arc::clone(&state),
            test_options("run-main", "sess-main", "派发一个子代理"),
        )
        .await
        .expect("主 agent run 发起成功");
        resolve_all_pending_approvals(&state, Duration::from_secs(20)).await;
        wait_all_runs_terminal(&state, Duration::from_secs(30)).await;
        wait_agent_rows_terminal(&db, "sess-main", 1, Duration::from_secs(20)).await;

        // 端到端基线：子代理 run 真实启动并收口（恰好一行子代理——嵌套
        // 未发生）
        let rows = db.load_session_agents("sess-main").unwrap();
        assert_eq!(rows.len(), 1, "嵌套派发不得产生额外子代理行");
        assert!(
            rows[0].status == "completed" || rows[0].status == "failed",
            "子代理行终态"
        );

        // 守卫兜底验证：直接经 spawner 以「存活子代理 run」为发起者再 spawn
        // → NestingDenied（T-D-02 结构化错误：所有子 Agent 由主 Agent 分配）。
        // note_depth_for_test 构造存活子代理场景（真实 spawn 的 run 已终态、
        // 记账已释放——测试面直接登记深度，避免 drive_run_loop 收口竞态）
        state.subagent_spawner.set_current_run("sess-main", "sub-run-live");
        state
            .subagent_spawner
            .note_depth_for_test("sub-run-live", 1, "sess-main");
        let req = agent_tools::tools::subagent::SubagentSpawnRequest {
            agent_id: None,
            prompt: "再派发".to_string(),
            role: None,
            capability_mode: None,
            allowed_tools: None,
            timeout_ms: None,
            description: None,
            mode: None,
            parent_session_id: "sess-main".to_string(),
            parent_run_id: None,
            parent_tool_call_id: None,
            flow_node_id: None,
            is_composite: false,
            task_type: None,
            allowed_write_paths: None,
            display_label: None,
            model_override: None,
        };
        let err = agent_tools::tools::subagent::SubagentSpawner::spawn(
            &*state.subagent_spawner,
            &req,
        )
        .await
        .expect_err("子代理发起 spawn 必须 NestingDenied");
        assert_eq!(err.code(), "subagent.nesting_denied");
        assert!(
            err.message().contains("所有子 Agent 由主 Agent 分配"),
            "结构化错误含编排指引：{}",
            err.message()
        );
        // 零 run：拒绝不产生新行
        assert_eq!(
            db.load_session_agents("sess-main").unwrap().len(),
            1,
            "NestingDenied 零 run"
        );
    }

    /// 验收 3：默认权限集端到端——analysis 无写工具（工具面裁剪，
    /// write_file 调用得到 is_error 工具结果）。会话路由 provider 确定性：
    /// 子代理脚本 = write_file 尝试（越界路径不写盘）+ 收口。
    #[tokio::test]
    async fn default_permission_sets_end_to_end() {
        // 探测文件：analysis 子代理无写工具，写盘不可能发生（probe 仅
        // 兜底断言面，不依赖工作区夹具）
        let probe = std::env::temp_dir().join(format!(
            "subagent_analysis_probe_{}.md",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&probe);
        let main = Arc::new(TestProvider::with_scripts(main_agent_scripts(
            serde_json::json!({ "prompt": "只读调研", "taskType": "analysis" }),
        )));
        // analysis 子代理：确定性尝试 write_file（默认集无写工具 →
        // is_error；审批（ask 语义）由主 agent 裁决放行后执行）
        let sub = Arc::new(TestProvider::with_scripts(vec![
            vec![
                ProviderStreamEvent::text("尝试写文件。"),
                ProviderStreamEvent::tool_call(
                    Some("c2".to_string()),
                    "write_file",
                    serde_json::json!({ "path": "../escape.md", "content": "x" }),
                ),
                ProviderStreamEvent::stop(StopReason::ToolCall),
            ],
            vec![
                ProviderStreamEvent::text("写文件不可用。"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ],
        ]));
        let (state, db, _main, sub, _emitter) =
            subagent_state_with_providers(main, sub, "deepseek-v4-flash");
        state.run_restore().await;
        run_task_impl(
            Arc::clone(&state),
            test_options("run-main", "sess-main", "派发 analysis 子代理"),
        )
        .await
        .expect("主 agent run 发起成功");
        // analysis 子代理的 write_file 尝试触发审批（ask 语义）→ 主 agent
        // 裁决放行 → 工具执行（unknown tool，is_error）→ 收口
        resolve_all_pending_approvals(&state, Duration::from_secs(20)).await;
        wait_all_runs_terminal(&state, Duration::from_secs(30)).await;
        wait_agent_rows_terminal(&db, "sess-main", 1, Duration::from_secs(20)).await;

        // analysis 默认集 = 只读白名单：write_file 调用必须 is_error
        // （工具不在注册表，unknown tool 分类）——端到端工具面证据
        // （sub provider 请求全部来自子代理 run，确定性遍历）
        let sub_requests = sub.requests();
        assert!(!sub_requests.is_empty(), "analysis 子代理至少一次请求");
        let mut write_file_error = false;
        for req in &sub_requests {
            for msg in &req.messages {
                for block in &msg.blocks {
                    if let AgentMessageBlock::ToolResult {
                        tool_name,
                        is_error,
                        ..
                    } = block
                    {
                        if tool_name == "write_file" {
                            write_file_error = *is_error;
                        }
                    }
                }
            }
        }
        assert!(write_file_error, "analysis 子代理无写工具（工具结果 is_error）");
        // 兜底：工作区未产生文件（无写工具的天然结果）
        assert!(!probe.exists(), "analysis 无写工具，不得写盘");
    }

    /// 验收 4：权限申请链路端到端——子代理 run 触发审批 → 请求载荷
    /// requester_run_id = 子代理 run id → 主 agent 裁决（ApprovalGateImpl
    /// resolve 入口，Mock 裁决器语义 = 测试直接裁决）。
    ///
    /// 确定性设计：第一阶段（主 agent 派发子代理 1）收口后，直接经
    /// spawner 发起子代理 run 2（不经 run_subagent 工具）——此时共享
    /// TestProvider 无竞争调用，子代理 run 2 的请求确定性回退到兜底脚本
    /// （write_file 越界尝试 → 触发审批 → 不写盘）。
    #[tokio::test]
    async fn subagent_approval_carries_requester_run_id_and_resolves() {
        // 会话路由 provider 确定性：主 agent 脚本（派发 + 收口 + 兜底）；
        // 子代理脚本 = write_file 越界尝试 + 收口（任何子代理 run 拿到都
        // 确定性触发审批且不写盘——path_escape 拒绝）
        let main = Arc::new(TestProvider::with_scripts(main_agent_scripts(
            serde_json::json!({ "prompt": "实现功能", "taskType": "implementation" }),
        )));
        let sub = Arc::new(TestProvider::with_scripts(vec![
            vec![
                ProviderStreamEvent::text("开始实现。"),
                ProviderStreamEvent::tool_call(
                    Some("c2".to_string()),
                    "write_file",
                    serde_json::json!({ "path": "../escape.md", "content": "x" }),
                ),
                ProviderStreamEvent::stop(StopReason::ToolCall),
            ],
            vec![
                ProviderStreamEvent::text("写文件被拒，调整方案。"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ],
            // 兜底（子代理 run 2 等越界调用）：write_file 尝试
            vec![
                ProviderStreamEvent::text("继续实现。"),
                ProviderStreamEvent::tool_call(
                    Some("c3".to_string()),
                    "write_file",
                    serde_json::json!({ "path": "../escape.md", "content": "x" }),
                ),
                ProviderStreamEvent::stop(StopReason::ToolCall),
            ],
            vec![
                ProviderStreamEvent::text("已处理。"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ],
        ]));
        let (state, db, _main, _sub, emitter) =
            subagent_state_with_providers(main, sub, "deepseek-v4-flash");
        state.run_restore().await;
        // 第一阶段：主 agent 派发子代理 1（implementation）并收口全部 run
        run_task_impl(
            Arc::clone(&state),
            test_options("run-main", "sess-main", "派发 implementation 子代理"),
        )
        .await
        .expect("主 agent run 发起成功");
        resolve_all_pending_approvals(&state, Duration::from_secs(20)).await;
        wait_all_runs_terminal(&state, Duration::from_secs(30)).await;
        wait_agent_rows_terminal(&db, "sess-main", 1, Duration::from_secs(20)).await;

        // 第二阶段：直接经 spawner 发起子代理 run 2（implementation）——
        // 确定性触发审批（requester_run_id = 子代理 run 2）
        let second = agent_tools::tools::subagent::SubagentSpawnRequest {
            agent_id: None,
            prompt: "实现功能 B".to_string(),
            role: None,
            capability_mode: None,
            allowed_tools: None,
            timeout_ms: None,
            description: None,
            mode: None,
            parent_session_id: "sess-main".to_string(),
            parent_run_id: Some("run-main".to_string()),
            parent_tool_call_id: None,
            flow_node_id: None,
            is_composite: false,
            task_type: Some(agent_tools::tools::subagent::TaskType::Implementation),
            allowed_write_paths: None,
            display_label: None,
            model_override: None,
        };
        let spawned = agent_tools::tools::subagent::SubagentSpawner::spawn(
            &*state.subagent_spawner,
            &second,
        )
        .await
        .expect("spawn 子代理 run 2 应成功");

        // 等待子代理 run 2 触发审批（approval-requested 广播含
        // requester_run_id = 子代理 run 2 id；Mock 裁决器 = 测试直接经
        // ApprovalGateImpl.resolve（主 agent 裁决面入口，I-02 校验）批准）
        let sub_run_id = spawned.subagent_run_id.clone();
        let (approved, requester_checked) = {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
            loop {
                // 审批广播捕获：emitter 记录 JSON 信封，扫描全部载荷找
                // requester_run_id = 本 run 的 approval-requested（先发后等
                // 契约：广播在等待前发出——命中即裁决，不等待广播消费时序）
                let payloads = emitter.0.lock().unwrap().clone();
                let matched: Option<(String, serde_json::Value)> = payloads
                    .iter()
                    .filter(|p| p.contains("approval-requested"))
                    .filter_map(|p| {
                        let value: serde_json::Value = serde_json::from_str(p).ok()?;
                        // 扁平载荷：{request: {requesterRunId, ...}, runId, type}
                        let requester = value
                            .get("request")?
                            .get("requesterRunId")?
                            .as_str()?
                            .to_string();
                        (requester == sub_run_id).then_some((requester, value))
                    })
                    .next();
                if let Some((requester, value)) = matched {
                    // 载荷断言：requester_run_id = 子代理 run id
                    let got = requester == sub_run_id;
                    // 主 agent 裁决（Mock 裁决器：批准）
                    let active = state
                        .active_runs
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .get(&sub_run_id)
                        .cloned();
                    if let Some(run) = active {
                        let call_id = {
                            let pending = run
                                .approval
                                .pending
                                .lock()
                                .unwrap_or_else(|e| e.into_inner());
                            pending.keys().next().cloned()
                        };
                        if let Some(call_id) = call_id {
                            run.approval
                                .resolve(&call_id, ApprovalDecision::Approved)
                                .await
                                .expect("主 agent 裁决应成功");
                            break (true, got);
                        }
                    }
                    let _ = value;
                }
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "子代理审批未在窗口内触发（approval-requested 广播缺失或 requester 不匹配）"
                );
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        };
        assert!(approved, "子代理审批必须被主 agent 裁决");
        assert!(
            requester_checked,
            "审批请求载荷必须携带 requester_run_id = 子代理 run id"
        );
        wait_all_runs_terminal(&state, Duration::from_secs(30)).await;
        wait_agent_rows_terminal(&db, "sess-main", 2, Duration::from_secs(20)).await;
    }

    // ── R1-10 T-08：远程 run 权限模式（full-access 降级 ask + 危险工具
    // 仍 NeedsApproval；D5 §9.1 / §9.2 矩阵）────────────────────────

    /// 危险工具脚本（主 agent 单发 write_file 尝试 + 收口 + 兜底；
    /// 越界路径不写盘——审批触发与写盘成败解耦）
    fn dangerous_write_scripts() -> Vec<Vec<ProviderStreamEvent>> {
        vec![
            vec![
                ProviderStreamEvent::text("写文件。"),
                ProviderStreamEvent::tool_call(
                    Some("c1".to_string()),
                    "write_file",
                    serde_json::json!({ "path": "../escape-r110.md", "content": "x" }),
                ),
                ProviderStreamEvent::stop(StopReason::ToolCall),
            ],
            vec![
                ProviderStreamEvent::text("写文件结果已收到。"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ],
            // 兜底（越界调用）：安全收口
            vec![
                ProviderStreamEvent::text("兜底。"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ],
        ]
    }

    /// ask 模式的 run 选项（远程降级后的生效模式；对齐 test_options 其余
    /// 字段——主 agent run，无子代理配置）
    fn ask_mode_options(run_id: &str, session_id: &str, prompt: &str) -> RunTaskOptions {
        let mut options = test_options(run_id, session_id, prompt);
        options.permission_mode = Some("ask".to_string());
        options
    }

    /// 轮询等待指定工具的 approval-requested 广播（R1-10 T-08 断言锚；
    /// 返回触发次数——≥1；窗口内未触发则 panic——审批门缺失即红）
    async fn wait_approval_requested(
        emitter: &Arc<RecordingEmitter>,
        tool_name: &str,
        window: Duration,
    ) -> usize {
        let deadline = tokio::time::Instant::now() + window;
        loop {
            let payloads = emitter.0.lock().unwrap().clone();
            let hits = payloads
                .iter()
                .filter(|p| p.contains("approval-requested"))
                .filter_map(|p| {
                    let value: serde_json::Value = serde_json::from_str(p).ok()?;
                    let name = value.get("request")?.get("toolName")?.as_str()?;
                    (name == tool_name).then_some(())
                })
                .count();
            if hits > 0 {
                return hits;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "approval-requested（{tool_name}）未在窗口内触发——危险工具未走审批门即红"
            );
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    }

    /// T-08 基线：ask 模式（远程降级后的生效模式）run 内危险工具仍
    /// NeedsApproval——approval-requested 触发 → 裁决放行 → 工具执行 →
    /// run 收口（复用 I-02 审批链测试基建）
    #[tokio::test]
    async fn t08_ask_mode_dangerous_tool_needs_approval() {
        let main = Arc::new(TestProvider::with_scripts(dangerous_write_scripts()));
        let sub = Arc::new(TestProvider::new(vec![
            ProviderStreamEvent::text("无子代理。"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ]));
        let (state, _db, _main, _sub, emitter) =
            subagent_state_with_providers(main, sub, "deepseek-v4-flash");
        state.run_restore().await;

        run_task_impl(
            Arc::clone(&state),
            ask_mode_options("run-ask", "sess-main", "写文件（ask 模式）"),
        )
        .await
        .expect("ask 模式 run 发起成功");

        // 危险工具（write_file）必须弹审批（NeedsApproval）；未触发即红
        let hits = wait_approval_requested(&emitter, "write_file", Duration::from_secs(15)).await;
        assert!(hits >= 1, "write_file 必须至少触发一次审批");
        // 用户裁决（I-02 resolve 入口）→ 工具执行 → 收口
        resolve_all_pending_approvals(&state, Duration::from_secs(20)).await;
        wait_all_runs_terminal(&state, Duration::from_secs(30)).await;
    }

    /// T-08 核心：远程 run 装配——REST 面（CoreStateBackend::run_task）
    /// 申报 full-access → 装配面降级 ask（apply_remote_mode）→ run 内
    /// 危险工具仍 NeedsApproval。降级失效（approval_enabled=false）则
    /// 审批不触发——本测试在等待窗口内直接红
    #[tokio::test]
    async fn t08_remote_run_full_access_downgraded_dangerous_tool_gated() {
        let main = Arc::new(TestProvider::with_scripts(dangerous_write_scripts()));
        let sub = Arc::new(TestProvider::new(vec![
            ProviderStreamEvent::text("无子代理。"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ]));
        let (state, _db, _main, _sub, emitter) =
            subagent_state_with_providers(main, sub, "deepseek-v4-flash");
        state.run_restore().await;

        // 远程装配点：CoreStateBackend（REST 写面直调体）——wire 载荷
        // permissionMode=full-access（移动端申报）→ 装配面降级 ask +
        // remote-mode-downgrade 审计标记
        use crate::server::backend::ApiBackend;
        let backend = crate::server::core_backend::CoreStateBackend::new(Arc::clone(&state));
        backend
            .run_task(conex_types::device::RunTaskParams {
                session_id: Some("sess-main".to_string()),
                prompt: "远程 run（申报 full-access）".to_string(),
                prompt_ref: None,
                mode: Some("task".to_string()),
                cwd: None,
                permission_mode: Some(conex_types::device::PermissionMode::FullAccess),
                history: None,
                client_message_id: None,
            })
            .await
            .expect("远程 run 发起成功");

        // 降级失效即红：full-access 直通 → approval_enabled=false → 危险
        // 工具不弹审批 → 本断言超时失败
        let hits = wait_approval_requested(&emitter, "write_file", Duration::from_secs(15)).await;
        assert!(hits >= 1, "降级后 ask 模式：write_file 必须仍 NeedsApproval");
        // 裁决 → 执行 → 收口（与本地 ask run 同一审批链，无远程例外分支）
        resolve_all_pending_approvals(&state, Duration::from_secs(20)).await;
        wait_all_runs_terminal(&state, Duration::from_secs(30)).await;
    }
    /// 验收 5：kill_all 引擎侧实现（T-D-09/T-D-13 ForceCancelSink 接线）——
    /// 按 subagent_run_id 定位活动 run 的 ControlBus 投递 L3 强停 + 行归一
    /// failed（产出保留）。
    #[tokio::test]
    async fn kill_all_delivers_force_cancel_and_normalizes_rows() {
        let (state, db) = {
            let (s, d, _m, _s, _e) = subagent_state_with_providers(
                Arc::new(TestProvider::new(vec![
                    ProviderStreamEvent::text("占位。"),
                    ProviderStreamEvent::stop(StopReason::Stop),
                ])),
                Arc::new(TestProvider::new(vec![
                    ProviderStreamEvent::text("占位。"),
                    ProviderStreamEvent::stop(StopReason::Stop),
                ])),
                "deepseek-v4-flash",
            );
            (s, d)
        };
        state.run_restore().await;
        // 准备：子代理行（running）+ 活动 run（ActiveRun 挂 active_runs）
        let sub_run_id = "sub-run-kill";
        let sub_session = "sub-sess-kill";
        db.upsert_session_entry(&subagent_test_session_entry("sess-main")).unwrap();
        // 子代理会话条目（run 表外键约束：start_run 需要会话行）
        db.upsert_session_entry(&subagent_test_session_entry(sub_session)).unwrap();
        // 子代理行落库（模拟 spawner 产物；running 状态）
        {
            let mut rows = db.load_session_agents("sess-main").unwrap();
            rows.push(conex_types::SessionAgent {
                id: "sub-kill".to_string(),
                subagent_run_id: sub_run_id.to_string(),
                parent_session_id: "sess-main".to_string(),
                parent_run_id: "run-main".to_string(),
                parent_tool_call_id: None,
                description: String::new(),
                mode: "research".to_string(),
                status: "running".to_string(),
                summary: None,
                messages: Vec::new(),
                started_at: 1,
                ended_at: None,
                depth: Some(1),
                subagent_path_json: None,
                task_type: None,
                display_label: None,
                allowed_write_paths_json: None,
            });
            db.save_session_agents("sess-main", &rows).unwrap();
        }
        // 活动 run（子代理 run 的 ActiveRun 挂注册表——L3 投递目标）
        let active = build_active_run(&state, sub_session, sub_run_id).await;
        state
            .active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(sub_run_id.to_string(), Arc::clone(&active));

        // 生命周期服务（ForceCancelSink = CoreRunState 实现）
        let service = state
            .lifecycle_service()
            .expect("LocalDb 路径必须可装配生命周期服务");
        let outcome = service.kill_all("sess-main", "test-kill").expect("kill_all 应成功");
        assert_eq!(outcome.terminated.len(), 1, "L3 强停投递成功");
        assert_eq!(outcome.terminated[0].subagent_run_id, sub_run_id);
        assert!(outcome.non_terminal.is_empty(), "活动 run 可达 → 无未终态汇总");

        // 行归一 failed（产出保留：summary/messages 不动）
        let rows = db.load_session_agents("sess-main").unwrap();
        let row = rows.iter().find(|r| r.subagent_run_id == sub_run_id).unwrap();
        assert_eq!(row.status, "failed");
        assert!(row.ended_at.is_some(), "ended_at 补齐");

        // L3 强停意图已投递到目标 run 的 ControlBus（reason 携带标识）
        let intents = active
            .control_bus
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain();
        assert_eq!(intents.len(), 1, "恰好一条 L3 强停意图");
        assert_eq!(
            intents[0].reason.as_deref(),
            Some("subagent_force_cancel:sub-run-kill"),
            "reason 携带可观测标识（control.rs:296 语义）"
        );

        // 不可达 run（无活动实例）→ 未终态汇总（不 panic）
        let mut ghost_rows = db.load_session_agents("sess-main").unwrap();
        ghost_rows.push(conex_types::SessionAgent {
            id: "sub-ghost".to_string(),
            subagent_run_id: "sub-run-ghost".to_string(),
            parent_session_id: "sess-main".to_string(),
            parent_run_id: "run-main".to_string(),
            parent_tool_call_id: None,
            description: String::new(),
            mode: "research".to_string(),
            status: "running".to_string(),
            summary: None,
            messages: Vec::new(),
            started_at: 1,
            ended_at: None,
            depth: Some(1),
            subagent_path_json: None,
            task_type: None,
            display_label: None,
            allowed_write_paths_json: None,
        });
        db.save_session_agents("sess-main", &ghost_rows).unwrap();
        let again = service.kill_all("sess-main", "test-kill-2").expect("kill_all 应成功");
        // sub-run-kill 已 failed（不在 running 过滤面）→ 本轮仅 ghost 目标
        assert_eq!(again.terminated.len(), 0, "已终态行不在过滤面");
        assert_eq!(again.non_terminal.len(), 1, "ghost run 未投递汇总");
        assert!(again.non_terminal[0].reason.contains("未投递"));
        // ghost 行同样归一 failed
        let rows = db.load_session_agents("sess-main").unwrap();
        assert!(
            rows.iter()
                .filter(|r| r.subagent_run_id == "sub-run-ghost")
                .all(|r| r.status == "failed")
        );
    }

    // ── 30-P1 / 30-P5：run 控制面端到端 + 逃逸判定器时序 ─────────

    /// 测试临时工作区（RAII 清理）。conex_test_utils 为 dev-dependency
    /// 且本卡禁改 Cargo.toml——自备最小等价物（真实目录 + 真实文件，
    /// 逃逸监视真实 watcher 的监视根）
    struct TestWorkspace {
        path: PathBuf,
    }

    impl TestWorkspace {
        fn new(tag: &str) -> Self {
            let seq = CORE_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "conex_escape_e2e_{tag}_{}_{seq}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).expect("临时目录创建");
            Self { path }
        }

        fn path_str(&self) -> String {
            self.path.display().to_string()
        }

        fn write_file(&self, rel: &str, content: &str) {
            std::fs::write(self.path.join(rel), content).expect("测试写文件");
        }
    }

    impl Drop for TestWorkspace {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    /// 测试状态（真实 CoreRunState + LocalDb + 注入 TestProvider 引擎；
    /// run_task_impl → drive_run_loop 完整装配真实 loop；会话 s1 条目
    /// 已建——start_run 外键前置）
    fn run_control_test_state(
        provider: Arc<TestProvider>,
    ) -> (Arc<CoreRunState>, LocalDb, Arc<RecordingEmitter>) {
        // 产品默认模型（catalog 窗口 1M；DEEPCHECK-06 预算测试需小窗口模型
        // 时走 run_control_test_state_with_model）
        run_control_test_state_with_model(provider, "deepseek-v4-flash")
    }

    /// 已建——start_run 外键前置；显式生效模型（预算测试按 catalog 窗口
    /// 选模型：qwen2-5-omni-7b → 32000，用于触发预检压缩的确定性小窗口）
    fn run_control_test_state_with_model(
        provider: Arc<TestProvider>,
        model: &str,
    ) -> (Arc<CoreRunState>, LocalDb, Arc<RecordingEmitter>) {
        let (bridge, emitter) = recording_bridge();
        let db = LocalDb::open_in_memory().expect("内存库");
        db.upsert_session_entry(&subagent_test_session_entry("s1"))
            .expect("会话条目");
        let seq = CORE_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let snapshots: Arc<dyn SnapshotStore> = Arc::new(
            orchestrator::restore::SnapshotFileStore::new(std::env::temp_dir().join(format!(
                "conex_run_control_{}_{seq}_snapshot.json",
                std::process::id()
            ))),
        );
        let state = Arc::new(CoreRunState::new(
            Arc::new(LocalDbStore::new(db.clone())),
            snapshots,
            bridge,
            Arc::new(StatusDiagnostics::new()),
            None,
        ));
        let routed: Arc<dyn ProviderCall> = provider;
        let config = EngineProviderConfig {
            base_url: "http://test.local/v1".to_string(),
            api_key: "test-key".to_string(),
            model: model.to_string(),
            endpoint: Endpoint::ChatCompletions,
            stream: true,
            extra: BTreeMap::new(),
        };
        state.engine.inject_provider_for_test(routed, config);
        (state, db, emitter)
    }

    /// 测试选项（带 cwd；cwd = 逃逸监视根 / 共享注册表根）
    fn test_options_with_cwd(
        run_id: &str,
        session_id: &str,
        prompt: &str,
        cwd: &str,
    ) -> RunTaskOptions {
        RunTaskOptions {
            cwd: Some(cwd.to_string()),
            ..test_options(run_id, session_id, prompt)
        }
    }

    /// 轮询活动 run 句柄的终态 end_reason（真实 loop 收口后 drive_outcome
    /// finalize 写入；窗口内未终态则 panic）
    async fn wait_run_end_reason(active: &Arc<ActiveRun>, window: Duration) -> String {
        let deadline = tokio::time::Instant::now() + window;
        loop {
            let run = active.handle.lock().await;
            if let Some(reason) = &run.end_reason {
                return reason.clone();
            }
            drop(run);
            assert!(
                tokio::time::Instant::now() < deadline,
                "run 未在窗口内终态"
            );
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    }

    /// 轮询会话事件库中的 agent-end 事件（真实 loop 收口落库；返回
    /// reason——RunOutcome.reason 的持久化镜像，kebab-case）
    async fn wait_run_agent_end_reason(
        db: &LocalDb,
        session_id: &str,
        window: Duration,
    ) -> String {
        let deadline = tokio::time::Instant::now() + window;
        loop {
            let events = db.query_events(session_id, 0, Some(500)).expect("事件查询");
            for event in &events {
                if event.event_type != "agent-end" {
                    continue;
                }
                let payload: serde_json::Value =
                    serde_json::from_str(&event.payload).expect("agent-end 载荷为合法 JSON");
                if let Some(reason) = payload["reason"].as_str() {
                    return reason.to_string();
                }
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "agent-end 事件未在窗口内落库"
            );
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    }

    /// 事件桥载荷 → security-audit 操作列表（判定器审计断言用）
    fn audit_operations(emitter: &RecordingEmitter) -> Vec<String> {
        emitter
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter_map(|p| {
                let value: serde_json::Value = serde_json::from_str(p).ok()?;
                if value["type"] == "security-audit" {
                    Some(
                        value["operation"]
                            .as_str()
                            .unwrap_or_default()
                            .to_string(),
                    )
                } else {
                    None
                }
            })
            .collect()
    }

    /// 轮询至事件桥出现指定 operation 的 security-audit（窗口内未到则
    /// panic——不静默降级）
    async fn wait_for_audit_operation(
        emitter: &Arc<RecordingEmitter>,
        operation: &str,
        window: Duration,
    ) {
        let deadline = tokio::time::Instant::now() + window;
        loop {
            if audit_operations(emitter).iter().any(|op| op == operation) {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "未在窗口内收到 {operation} 审计"
            );
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    }

    /// 30-P1 验收（E2E-1）：L3 force_cancel 真实终止运行中的 run——
    /// TestProvider 栅栏挂起流（pause 3s），L3 经 run_control_impl →
    /// abort_signal + 控制总线 → 下一安全点（stream 结束）ABORT →
    /// agent-end reason == aborted（真实 loop 消费，不再只置位）
    #[tokio::test]
    async fn l3_force_cancel_aborts_running_run() {
        let provider = Arc::new(
            TestProvider::new(vec![
                ProviderStreamEvent::text("第一轮"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ])
            .with_pause(0, 3_000),
        );
        let (state, db, _emitter) = run_control_test_state(provider.clone());
        state.run_restore().await;

        run_task_impl(
            Arc::clone(&state),
            test_options("run-l3-e2e", "s1", "发起 run"),
        )
        .await
        .expect("run 发起成功");
        let active = state
            .active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get("run-l3-e2e")
            .cloned()
            .expect("run 已注册");
        // L3 强停（用户取消路径：abort_signal + 总线 force_cancel 双写）
        run_control_impl(
            &state,
            "run-l3-e2e",
            "force_cancel",
            None,
            Some("用户取消".to_string()),
            None,
        )
        .await
        .expect("force_cancel 应成功");
        // 真实 loop 在下一安全点收场：agent-end reason == aborted
        let end_reason = wait_run_end_reason(&active, Duration::from_secs(30)).await;
        assert_eq!(end_reason, "aborted", "L3 强停后 run 必须以 aborted 终态");
        let agent_reason = wait_run_agent_end_reason(&db, "s1", Duration::from_secs(30)).await;
        assert_eq!(
            agent_reason, "aborted",
            "L3 强停后 loop 的 agent-end 收场 reason 必须为 aborted"
        );
    }

    /// 30-P1 验收（E2E-1）：L2 cooperative_stop 真实到达运行中的 run——
    /// 协作停止不等 abort：安全点 D1 驱动到 done，agent-end reason ==
    /// stopped（独立 reason，非 aborted 非 stop）
    #[tokio::test]
    async fn l2_cooperative_stop_reaches_stopped() {
        let provider = Arc::new(
            TestProvider::new(vec![
                ProviderStreamEvent::text("第一轮"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ])
            .with_pause(0, 3_000),
        );
        let (state, db, _emitter) = run_control_test_state(provider.clone());
        state.run_restore().await;

        run_task_impl(
            Arc::clone(&state),
            test_options("run-l2-e2e", "s1", "发起 run"),
        )
        .await
        .expect("run 发起成功");
        let active = state
            .active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get("run-l2-e2e")
            .cloned()
            .expect("run 已注册");
        // L2 协作停止（入控制总线，不触发 abort_signal）
        run_control_impl(
            &state,
            "run-l2-e2e",
            "cooperative_stop",
            None,
            Some("用户停止".to_string()),
            None,
        )
        .await
        .expect("cooperative_stop 应成功");
        let agent_reason = wait_run_agent_end_reason(&db, "s1", Duration::from_secs(30)).await;
        assert_eq!(
            agent_reason, "stopped",
            "L2 协作停止后 loop 必须以 stopped 收场（D1 独立 reason）"
        );
        // 协作停止不是取消：run-terminal 终态为 completed 而非 cancelled
        // （L2 不置 cancel_requested，终态本体由 drive_outcome 权威映射）
        let _ = active;
        let events = db.query_events("s1", 0, Some(500)).expect("事件查询");
        let terminal = events
            .iter()
            .filter(|e| e.event_type == "run-terminal")
            .last()
            .expect("run-terminal 必须落库");
        let payload: serde_json::Value =
            serde_json::from_str(&terminal.payload).expect("run-terminal 载荷为合法 JSON");
        assert_eq!(
            payload["terminal"], "completed",
            "L2 协作停止归 completed 而非 cancelled：{payload}"
        );
    }

    /// 30-P1 验收（E2E-1）：L1 soft_inject 真实到达运行中的 run——
    /// followUp 注入 → turn-complete 空闲 promote → 下一轮请求对话包含
    /// 注入消息（conversation 增长，真实 loop 消费，不再只置位）
    #[tokio::test]
    async fn l1_soft_inject_reaches_session() {
        let provider = Arc::new(
            TestProvider::with_scripts(vec![
                vec![
                    ProviderStreamEvent::text("第一轮"),
                    ProviderStreamEvent::stop(StopReason::Stop),
                ],
                vec![
                    ProviderStreamEvent::text("收到注入"),
                    ProviderStreamEvent::stop(StopReason::Stop),
                ],
            ])
            .with_pause(0, 3_000),
        );
        let (state, _db, _emitter) = run_control_test_state(Arc::clone(&provider));
        state.run_restore().await;

        run_task_impl(
            Arc::clone(&state),
            test_options("run-l1-e2e", "s1", "发起 run"),
        )
        .await
        .expect("run 发起成功");
        // 栅栏窗口内注入（流仍挂起，注入不打断流）
        tokio::time::sleep(Duration::from_millis(300)).await;
        run_control_impl(
            &state,
            "run-l1-e2e",
            "follow_up",
            Some("注入消息A".to_string()),
            Some("l1-test".to_string()),
            None,
        )
        .await
        .expect("follow_up 应成功");
        // 注入消息真实进入会话：下一轮 provider 请求的对话包含注入文本
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            let injected = provider.request_message_arcs(1).iter().any(|m| {
                m.text().contains("注入消息A")
            });
            if injected {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "注入消息未在窗口内进入会话对话"
            );
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        // 收口复核：run 正常收场（注入不打断流）
        let active = state
            .active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get("run-l1-e2e")
            .cloned()
            .expect("run 已注册");
        let end_reason = wait_run_end_reason(&active, Duration::from_secs(30)).await;
        assert_eq!(end_reason, "stop", "L1 注入不改变收场（正常 stop）");
    }

    /// 30-P1 验收（E2E-1）：kill_all 引擎侧实现（ForceCancelSink :1751
    /// 路径）→ 目标 run 真实终止——L3 强停经同一控制总线投递，运行中
    /// run 在下一安全点以 aborted 收场
    #[tokio::test]
    async fn kill_all_aborts_target_run() {
        let provider = Arc::new(
            TestProvider::new(vec![
                ProviderStreamEvent::text("第一轮"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ])
            .with_pause(0, 3_000),
        );
        let (state, db, _emitter) = run_control_test_state(provider.clone());
        state.run_restore().await;

        run_task_impl(
            Arc::clone(&state),
            test_options("run-kill-e2e", "s1", "发起 run"),
        )
        .await
        .expect("run 发起成功");
        let active = state
            .active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get("run-kill-e2e")
            .cloned()
            .expect("run 已注册");
        // kill_all 的引擎侧实现：ForceCancelSink（:1751 路径，bus L3 投递）
        use orchestrator::lifecycle::ForceCancelSink as _;
        assert!(
            state.request_force_cancel("run-kill-e2e", "test-kill-all"),
            "kill_all 投递必须命中活动 run"
        );
        let agent_reason = wait_run_agent_end_reason(&db, "s1", Duration::from_secs(30)).await;
        assert_eq!(
            agent_reason, "aborted",
            "kill_all 后目标 run 必须以 aborted 收场"
        );
        let _ = active;
    }

    /// 30-P1 改动点 4：spawn(drive_run_loop) 的 JoinHandle 已登记——
    /// 构造后句柄存在（不 await）；run 收口后 is_finished() 轮询成立
    #[tokio::test]
    async fn active_run_driver_joinhandle_saved() {
        let provider = Arc::new(
            TestProvider::new(vec![
                ProviderStreamEvent::text("收口"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ])
            .with_pause(0, 1_000),
        );
        let (state, _db, _emitter) = run_control_test_state(provider.clone());
        state.run_restore().await;

        run_task_impl(
            Arc::clone(&state),
            test_options("run-drv-e2e", "s1", "发起 run"),
        )
        .await
        .expect("run 发起成功");
        let active = state
            .active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get("run-drv-e2e")
            .cloned()
            .expect("run 已注册");
        // 句柄已登记（spawn 后同步写入；ActiveRun 构造先例断言）
        assert!(
            active
                .driver
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_some(),
            "spawn 后 driver JoinHandle 必须已登记"
        );
        // 收口后 is_finished() 轮询成立（不 await 句柄本身——防挂起语义）
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while !active.driver_finished() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "驱动任务未在窗口内收口"
            );
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    }

    /// 30-P5 验收（E2E-2）：真实 watcher 触发逃逸注入 → 主 agent
    /// followUp 真实到达——批量写入触发聚合报告 → 注入经同一控制总线
    /// 落 followUp 环 → 安全点消费 → 下一轮对话包含归因摘要
    #[tokio::test]
    async fn escape_watch_inject_reaches_main_agent() {
        let ws = TestWorkspace::new("esc_inject_e2e");
        let provider = Arc::new(
            TestProvider::with_scripts(vec![
                vec![
                    ProviderStreamEvent::text("第一轮"),
                    ProviderStreamEvent::stop(StopReason::Stop),
                ],
                vec![
                    ProviderStreamEvent::text("收到注入"),
                    ProviderStreamEvent::stop(StopReason::Stop),
                ],
            ])
            .with_pause(0, 5_000),
        );
        let (state, _db, _emitter) = run_control_test_state(Arc::clone(&provider));
        state.run_restore().await;

        run_task_impl(
            Arc::clone(&state),
            test_options_with_cwd("run-esc-inj", "s1", "发起 run", &ws.path_str()),
        )
        .await
        .expect("run 发起成功");
        // 栅栏窗口内批量写入（≥ batch_size 触发即时聚合报告 → 注入）
        tokio::time::sleep(Duration::from_millis(300)).await;
        for i in 0..12 {
            ws.write_file(&format!("f{i}.txt"), "escape");
        }
        // 注入真实到达：下一轮 provider 请求的对话包含归因摘要（含 run 标识）
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            let injected = provider.request_message_arcs(1).iter().any(|m| {
                m.text().contains("检测到工具外写入")
                    && m.text().contains("run-esc-inj")
            });
            if injected {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "逃逸注入未在窗口内到达会话对话"
            );
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    }

    /// 逃逸探针工具（30-P5 判定器端到端）：可选声明写路径 → 写文件 →
    /// 持声明休眠（让 watcher 事件落入声明窗口，notify 事件延迟通常
    /// <200ms，2s 窗口确定性充足）→ 释放。记录执行面注入的注册表 Arc
    ///（同一实例断言用）
    struct EscapeProbeTool {
        /// 声明写路径（Some = 声明覆盖静默路径；None = 未声明上报路径）
        claim_path: Option<String>,
        /// 额外写入的未声明路径（与声明路径成对验证同一注册表）
        extra_unclaimed: Option<String>,
        /// 记录执行面注入的注册表（30-P5 双端注入成对断言）
        observed_registry: Arc<Mutex<Option<Arc<WritePathRegistry>>>>,
    }

    #[async_trait::async_trait]
    impl agent_tools::definition::Tool for EscapeProbeTool {
        fn name(&self) -> &str {
            "escape_probe"
        }

        fn definition(&self) -> &agent_tools::definition::ToolDefinition {
            static DEF: std::sync::OnceLock<agent_tools::definition::ToolDefinition> =
                std::sync::OnceLock::new();
            DEF.get_or_init(|| agent_tools::definition::ToolDefinition {
                name: "escape_probe".to_string(),
                description: "逃逸判定器探针".to_string(),
                input_schema: serde_json::json!({"type": "object"}),
                dangerous: false,
                fatal_on_error: false,
            })
        }

        async fn execute(
            &self,
            ctx: &agent_tools::context::ToolContext,
            _args: serde_json::Value,
        ) -> Result<serde_json::Value, ToolError> {
            *self
                .observed_registry
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = ctx.write_claims.clone();
            let write = |rel: &str, content: &str| {
                std::fs::write(ctx.workspace_root.join(rel), content)
                    .map_err(|error| {
                        ToolError::execution_failed(
                            "escape_probe",
                            &format!("写文件失败 {rel}：{error}"),
                        )
                    })
            };
            if let Some(claim) = &self.claim_path {
                let holder = ctx
                    .write_claim_holder
                    .clone()
                    .unwrap_or_else(|| ctx.session_id.clone());
                let registry = ctx
                    .write_claims
                    .clone()
                    .expect("装配后执行面必须注入写路径注册表");
                let _guard = registry
                    .claim_one(holder, claim, agent_tools::write_paths::ClaimMode::Write)
                    .map_err(|error| {
                        ToolError::execution_failed(
                            "escape_probe",
                            &format!("声明写路径失败 {claim}：{error}"),
                        )
                    })?;
                write(claim, "declared")?;
                // 持声明窗口：守卫在本块内保持（notify 事件延迟通常
                // <200ms，2s 窗口确定性充足）——声明覆盖判定在事件到达
                // 时仍有效；声明释放后该路径恢复未声明上报
                tokio::time::sleep(Duration::from_millis(2_000)).await;
            }
            if let Some(extra) = &self.extra_unclaimed {
                write(extra, "unclaimed")?;
            }
            Ok(serde_json::json!({"probe": true}))
        }
    }

    /// 30-P5 验收（E2E-3）：声明写路径静默——工具声明覆盖的写入不产生
    /// undeclared-write 审计（判定器与工具执行面同源：声明覆盖跳过）
    #[tokio::test]
    async fn escape_detector_claims_suppress_audit_e2e() {
        let ws = TestWorkspace::new("esc_suppress_e2e");
        let observed = Arc::new(Mutex::new(None));
        let tool = Arc::new(EscapeProbeTool {
            claim_path: Some("escape.txt".to_string()),
            extra_unclaimed: None,
            observed_registry: Arc::clone(&observed),
        });
        let provider = Arc::new(TestProvider::with_scripts(vec![
            vec![
                ProviderStreamEvent::tool_call(
                    Some("call_probe".into()),
                    "escape_probe",
                    serde_json::json!({}),
                ),
                ProviderStreamEvent::stop(StopReason::ToolCall),
            ],
            vec![
                ProviderStreamEvent::text("完成"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ],
        ]));
        let (state, _db, emitter) = run_control_test_state(Arc::clone(&provider));
        state
            .engine
            .tool_registry()
            .register_runtime(Arc::clone(&tool) as Arc<dyn agent_tools::definition::Tool>)
            .expect("探针工具注册");
        state.run_restore().await;

        run_task_impl(
            Arc::clone(&state),
            test_options_with_cwd("run-esc-suppress", "s1", "发起 run", &ws.path_str()),
        )
        .await
        .expect("run 发起成功");
        // 收口（逃逸监视 shutdown flush 已完成——驱动任务收口后注册表移除）
        let active = state
            .active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get("run-esc-suppress")
            .cloned()
            .expect("run 已注册");
        let _ = wait_run_end_reason(&active, Duration::from_secs(30)).await;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while !active.driver_finished() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "驱动任务未在窗口内收口"
            );
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        // 声明覆盖静默：事件桥无 undeclared-write 审计
        let ops = audit_operations(&emitter);
        assert!(
            !ops.iter().any(|op| op == "undeclared-write"),
            "声明覆盖的写入不得产生 undeclared-write 审计：{ops:?}"
        );
        // 执行面确实注入了注册表（探针观测；与判定器同源的前提）
        assert!(
            observed.lock().unwrap_or_else(|e| e.into_inner()).is_some(),
            "工具执行面必须注入写路径注册表（30-P5 write_claims 恒注入）"
        );
    }

    /// 30-P5 验收（E2E-3）：未声明路径写入上报——工具未声明的写入产生
    /// undeclared-write 审计（判定器生效的正面路径）
    #[tokio::test]
    async fn escape_detector_unclaimed_path_reports_e2e() {
        let ws = TestWorkspace::new("esc_report_e2e");
        let tool = Arc::new(EscapeProbeTool {
            claim_path: None,
            extra_unclaimed: Some("escape_probe.txt".to_string()),
            observed_registry: Arc::new(Mutex::new(None)),
        });
        let provider = Arc::new(TestProvider::with_scripts(vec![
            vec![
                ProviderStreamEvent::tool_call(
                    Some("call_probe".into()),
                    "escape_probe",
                    serde_json::json!({}),
                ),
                ProviderStreamEvent::stop(StopReason::ToolCall),
            ],
            vec![
                ProviderStreamEvent::text("完成"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ],
        ]));
        let (state, _db, emitter) = run_control_test_state(Arc::clone(&provider));
        state
            .engine
            .tool_registry()
            .register_runtime(Arc::clone(&tool) as Arc<dyn agent_tools::definition::Tool>)
            .expect("探针工具注册");
        state.run_restore().await;

        run_task_impl(
            Arc::clone(&state),
            test_options_with_cwd("run-esc-report", "s1", "发起 run", &ws.path_str()),
        )
        .await
        .expect("run 发起成功");
        // 未声明写入 → undeclared-write 审计（收口 flush 兜底发射）
        wait_for_audit_operation(&emitter, "undeclared-write", Duration::from_secs(30)).await;
        // 审计载荷字段级断言（operation / decision=denied / targets）
        let payloads = emitter.0.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let reported = payloads.iter().any(|p| {
            let value: serde_json::Value = serde_json::from_str(p).ok().unwrap_or_default();
            value["type"] == "security-audit"
                && value["operation"] == "undeclared-write"
                && value["decision"] == "denied"
                && value["targets"]
                    .as_array()
                    .map(|t| t.iter().any(|v| {
                        v.as_str()
                            .map(|s| s.contains("escape_probe"))
                            .unwrap_or(false)
                    }))
                    .unwrap_or(false)
        });
        assert!(reported, "未声明写入必须上报（含 targets 路径）");
    }

    /// 30-P5 验收：write_claims 与判定器同一 Arc 实例（双端注入成对）——
    /// 探针工具声明路径静默（判定器看到声明）、未声明兄弟路径上报
    /// （判定器读同一注册表）——行为级同一实例证明
    #[tokio::test]
    async fn write_claims_injected_registry_shared_with_tool_ctx() {
        let ws = TestWorkspace::new("esc_pair_e2e");
        let observed = Arc::new(Mutex::new(None));
        let tool = Arc::new(EscapeProbeTool {
            claim_path: Some("escape.txt".to_string()),
            extra_unclaimed: Some("sibling.txt".to_string()),
            observed_registry: Arc::clone(&observed),
        });
        let provider = Arc::new(TestProvider::with_scripts(vec![
            vec![
                ProviderStreamEvent::tool_call(
                    Some("call_probe".into()),
                    "escape_probe",
                    serde_json::json!({}),
                ),
                ProviderStreamEvent::stop(StopReason::ToolCall),
            ],
            vec![
                ProviderStreamEvent::text("完成"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ],
        ]));
        let (state, _db, emitter) = run_control_test_state(Arc::clone(&provider));
        state
            .engine
            .tool_registry()
            .register_runtime(Arc::clone(&tool) as Arc<dyn agent_tools::definition::Tool>)
            .expect("探针工具注册");
        state.run_restore().await;

        run_task_impl(
            Arc::clone(&state),
            test_options_with_cwd("run-esc-pair", "s1", "发起 run", &ws.path_str()),
        )
        .await
        .expect("run 发起成功");
        // 未声明兄弟路径上报（同一 run 内判定器生效）
        wait_for_audit_operation(&emitter, "undeclared-write", Duration::from_secs(30)).await;
        // 执行面注入的注册表与判定器同源：声明路径不产生独立审计条目
        let payloads = emitter.0.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let any_escape_txt = payloads.iter().any(|p| {
            let value: serde_json::Value = serde_json::from_str(p).ok().unwrap_or_default();
            value["operation"] == "undeclared-write"
                && value["targets"]
                    .as_array()
                    .map(|t| {
                        t.iter().any(|v| {
                            v.as_str()
                                .map(|s| s.contains("escape.txt"))
                                .unwrap_or(false)
                        })
                    })
                    .unwrap_or(false)
        });
        assert!(
            !any_escape_txt,
            "声明覆盖的路径不得出现在 undeclared-write 审计中"
        );
    }

    /// 30-P5：逃逸监视根解析 helper 与 with_options 解析链同源——
    /// 无 cwd 场景（None → current_dir）与显式 cwd 两分支
    #[test]
    fn escape_root_resolution_matches_with_options() {
        // 显式 cwd：原样解析（与 with_options 的 options.cwd 分支一致）
        let explicit = resolve_escape_watch_root(Some("C:\\work\\proj"));
        assert_eq!(explicit, PathBuf::from("C:\\work\\proj"));
        // None → current_dir（与 with_options 的 current_dir 兜底一致；
        // 该分支下监视不启动、注册表以 current_dir 为根、run 装配不
        // panic——既有 run 测试（cwd=None）持续覆盖）
        let none = resolve_escape_watch_root(None);
        let current = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        assert_eq!(none, current);
    }

    // ── 批 3 装配轮端到端（30 方案 §十：E2E-5/6/7）──────────────────────

    /// 30-P3/P2 验收（E2E-5）：任务完成 → 主 agent 唤醒注入 + security-audit
    /// 留痕——生产装配序（先 set_task_event_consumer 后 set_event_bridge）
    /// 接线真实注册表：adopt 真实子进程（RunAware 装饰器注入 owner）→
    /// 完成 → 引擎共享队列出现「任务 <id> 已完成，退出码 0」条目 +
    /// command-exec 审计两记录（started / completed）
    #[tokio::test]
    async fn task_completion_wakes_main_agent_e2e() {
        let registry = bg_test_registry();
        let (bridge, emitter) = recording_bridge();
        let seq = CORE_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let snapshots: Arc<dyn SnapshotStore> = Arc::new(
            orchestrator::restore::SnapshotFileStore::new(std::env::temp_dir().join(format!(
                "conex_e2e5_{}_{seq}_snapshot.json",
                std::process::id()
            ))),
        );
        let state = Arc::new(CoreRunState::new(
            Arc::new(InMemoryStore::new()),
            snapshots,
            bridge.clone(),
            Arc::new(StatusDiagnostics::new()),
            Some(Arc::clone(&registry) as Arc<dyn BackgroundTaskManager>),
        ));
        // 生产装配序（30 §8.1：consumer 先于 bridge——EventBridgeSink
        // 构造时读取消费器快照）
        registry.set_task_event_consumer(state.task_events());
        registry.set_event_bridge(bridge, String::new());
        // owner 注入：经 RunAwareBackgroundManager 装饰器（adopt 时当前
        // run id 写入 owner_run_id——任务归属主 agent 唤醒的前提）
        state.background.set_current_run("run-e2e5");

        // adopt 真实子进程（立即退出码 0 → completed 终态；resource_monitor
        // = true——finish_task 仅对受监视任务发射 task-completed（background.rs
        // 终态通知条件），与生产「长任务资源监视」路径一致）
        let child = spawn_test_child("exit 0");
        let r = state
            .background
            .adopt(BackgroundAdoptRequest {
                child,
                command: "e2e5-cmd".to_string(),
                cwd: PathBuf::from("."),
                is_daemon: false,
                resource_monitor: true,
                owner_run_id: None,
            })
            .await
            .expect("adopt 应成功");
        let task_id = r.task_id.clone();

        // 完成 → 共享队列出现唤醒条目（轮询窗口内必达）
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            let queue = state.steering_queue();
            let mut queue = queue.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(entry) = queue.peek() {
                assert!(
                    entry.text.contains(&format!("任务 {task_id} 已完成，退出码 0")),
                    "唤醒条目应为完成摘要模板：{}",
                    entry.text
                );
                assert_eq!(
                    entry.group_id.as_deref(),
                    Some(orchestrator::task_events::TASK_WAKE_GROUP_ID),
                    "任务唤醒条目 group_id = task-wake"
                );
                queue.clear();
                break;
            }
            drop(queue);
            assert!(
                tokio::time::Instant::now() < deadline,
                "任务完成唤醒条目未在窗口内落入共享队列"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        // security-audit command-exec 记录（started + completed 两记录直发）
        wait_for_audit_operation(&emitter, "command-exec", Duration::from_secs(30)).await;
        let payloads = emitter.0.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let audits: Vec<&String> = payloads
            .iter()
            .filter(|p| {
                let value: serde_json::Value =
                    serde_json::from_str(p).ok().unwrap_or_default();
                value["type"] == "security-audit"
                    && value["operation"] == "command-exec"
            })
            .collect();
        assert!(
            audits.len() >= 2,
            "started + completed 应各直发一条 command-exec 审计：{}",
            audits.len()
        );
        // 审计载荷携带任务 id（targets 可检索）
        assert!(
            audits.iter().any(|p| p.contains(&format!("\"{task_id}\""))),
            "审计 targets 应承载任务 id"
        );
    }

    /// 30-P4 验收（E2E-6）：timer/cron 到期事件经 drain 转发到事件桥——
    /// 真实引擎装配（经 CoreRunState）→ 定时器到期缓冲 TimerFired / cron
    /// 触发缓冲 CronFired → forward helper（main.rs drain 任务同一转发
    /// 路径）→ workbench-run-event 信封（runId/sequence 不注入，字段级
    /// 断言）——A10 N-05 缓冲事件不再终老
    #[tokio::test]
    async fn timer_and_cron_events_drain_forwarded_e2e() {
        let (bridge, emitter) = recording_bridge();
        let seq = CORE_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let snapshots: Arc<dyn SnapshotStore> = Arc::new(
            orchestrator::restore::SnapshotFileStore::new(std::env::temp_dir().join(format!(
                "conex_e2e6_{}_{seq}_snapshot.json",
                std::process::id()
            ))),
        );
        let state = Arc::new(CoreRunState::new(
            Arc::new(InMemoryStore::new()),
            snapshots,
            bridge.clone(),
            Arc::new(StatusDiagnostics::new()),
            None,
        ));

        // 定时器面：注册 1 秒定时器（register 第一参为秒）→ 到期 → 生产
        // 缓冲出现 TimerFired → 转发 helper → 事件桥信封（字段级断言）
        let channel: Arc<dyn agent_tools::tools::set_timer::TimerChannel> =
            state.engine.timer_registry();
        let handle = channel
            .register(
                1,
                "e2e6 定时器".to_string(),
                conex_types::timer::TimerCondition::Never,
            )
            .await
            .expect("timer_channel 已接线，register 不应 unsupported");
        tokio::time::sleep(Duration::from_millis(1300)).await;
        let forwarded =
            crate::engine::forward_drained_timer_events(&state.timer_event_sink(), &bridge);
        assert_eq!(forwarded, 1, "到期 timer-fired 应经转发路径发射");
        let payloads = emitter.0.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let first: serde_json::Value =
            serde_json::from_str(&payloads[0]).expect("载荷应为合法 JSON");
        assert_eq!(first["type"], "timer-fired");
        assert!(first.get("runId").is_none(), "timer 事件不得注入 runId");
        assert!(first.get("sequence").is_none(), "timer 事件不得注入 sequence");
        assert_eq!(first["sessionId"], "");
        assert_eq!(first["prompt"], "e2e6 定时器");
        assert_eq!(first["timerId"], handle.timer_id);
        channel.cancel(&handle.timer_id).await.ok();

        // cron 面：短触发延迟（测试钩子）→ 触发 → 生产缓冲 CronFired →
        // 转发 helper → 事件桥信封（cron-fired 字段级断言）
        let registry = state.scheduler_registry().expect("装配后应为 Some");
        registry.set_fire_override_ms(40);
        let cron_id = registry
            .register(crate::sched::CronTaskInput {
                expression: "* * * * *".to_string(),
                prompt: "e2e6 cron".to_string(),
                max_iterations: Some(1),
                is_daemon: false,
            })
            .await
            .expect("cron 注册应成功");
        tokio::time::sleep(Duration::from_millis(300)).await;
        let forwarded = crate::engine::forward_drained_scheduler_events(
            &state.scheduler_event_sink(),
            &bridge,
        );
        assert_eq!(forwarded, 1, "cron-fired 应经转发路径发射");
        let payloads = emitter.0.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let second: serde_json::Value =
            serde_json::from_str(&payloads[1]).expect("载荷应为合法 JSON");
        assert_eq!(second["type"], "cron-fired");
        assert!(second.get("runId").is_none(), "cron 事件不得注入 runId");
        assert!(second.get("sequence").is_none(), "cron 事件不得注入 sequence");
        assert_eq!(second["cronId"], cron_id);
        assert_eq!(second["prompt"], "e2e6 cron");
        // 缓冲已取走（Vec::take 语义，不重复转发）
        assert!(
            state.scheduler_event_sink().drain().is_empty(),
            "转发后生产缓冲应为空"
        );
    }

    /// 30-P6/P7 验收（E2E-7）：create-workflow（cron 表达式）→ 注册表真实
    /// 调度触发 → steering 条目入共享队列 → run 收口续 run 唤醒——下一轮
    /// provider 对话包含 workflow prompt 注入（真实 loop + 真实队列 +
    /// 真实注册表 + 真实判定器，全链路端到端）
    #[tokio::test]
    async fn workflow_cron_fire_wakes_resume_run_e2e() {
        let provider = Arc::new(
            TestProvider::with_scripts(vec![
                vec![
                    ProviderStreamEvent::text("第一轮"),
                    ProviderStreamEvent::stop(StopReason::Stop),
                ],
                vec![
                    ProviderStreamEvent::text("收到 workflow 唤醒"),
                    ProviderStreamEvent::stop(StopReason::Stop),
                ],
            ])
            // 500ms 栅栏：确保首个 cron 触发（override 40ms）在 run 1 收口
            // 前入队——首轮收口即命中队列唤醒（注入文本落到首续 run 轮）
            .with_pause(0, 500),
        );
        let (state, db, _emitter) = run_control_test_state(Arc::clone(&provider));
        state.run_restore().await;

        // P6 装配（main.rs 装配轮同序）：共享队列 + 注册表委托注入
        let workflow_state = crate::workflow_commands::WorkflowCommandState::new(
            db.clone(),
            state.steering_queue(),
        );
        let registry = state.scheduler_registry().expect("装配后应为 Some");
        workflow_state.set_registry(Arc::clone(&registry));
        // 短触发延迟：create 后 ~40ms cron 触发 → 条目入共享队列
        registry.set_fire_override_ms(40);
        let view = workflow_state
            .backend()
            .create(
                "每日检查".to_string(),
                "执行检查并报告".to_string(),
                crate::workflow_commands::WorkflowScheduleWire::Cron {
                    expression: "* * * * *".to_string(),
                },
                None,
                None,
                true,
            )
            .await
            .expect("workflow 创建应成功");

        // run 发起（500ms 栅栏内 cron 已触发入队——条目带 workflow prompt；
        // run 收口后 decide_idle_resume 队列源命中唤醒）
        run_task_impl(
            Arc::clone(&state),
            test_options("run-wf-e2e", "s1", "发起 run"),
        )
        .await
        .expect("run 发起成功");
        // 收口续 run：续 run 轮 provider 请求的对话包含 workflow prompt
        // 注入（§4.8 模板：`<prompt>（cron <id> 第 N 次触发）`）。栅栏保证
        // 首 fire 先于首轮收口，注入文本落首续 run 轮（请求序号 1）；
        // 仍扫描窗口序号 0..6 兜底毫秒级竞态（首轮先于触发收口时空注入
        // 待命、文本落后续 run 轮）
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        let mut injected = false;
        loop {
            for idx in 0..6 {
                if provider
                    .request_message_arcs(idx)
                    .iter()
                    .any(|m| m.text().contains("执行检查并报告") && m.text().contains(&view.id))
                {
                    injected = true;
                    break;
                }
            }
            if injected {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "workflow cron 唤醒未在窗口内到达续 run 对话"
            );
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        // 取消 cron：终止 40ms 反复触发（create 委托 register 为
        // max_iterations=None——每次触发替换 steering 条目并重建 sleep，
        // 属真实调度语义；取消后表内条目移除，has_active 归 false，
        // 防续 run 链无限延伸）
        registry.cancel(&view.id).await.ok();
        // 唤醒条目已批量转出（续 run 消费后队列清空——轮询窗口内；
        // 取消前最后一次触发可能刚入队，需等待当前续 run 链转出）
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let empty = state
                .pending_queue
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty();
            if empty {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "workflow 唤醒条目应被续 run 批量转出"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        // 收口复核：轮询至两次 run-terminal（首轮 + 续 run 轮）落库——
        // 注入到达对话的时刻先于续 run 收口，终态落库需等待
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            let events = db.query_events("s1", 0, Some(500)).expect("事件查询");
            let terminals = events
                .iter()
                .filter(|e| e.event_type == "run-terminal")
                .count();
            if terminals >= 2 {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "应发生首轮 + 续 run 两次 run-terminal：{terminals}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    // ── 15-T-6（裁决 D9）：审计路由注册/收口注销（run 生命周期面）──

    /// run 启动注册 → drive_run_loop 收口强制注销（注册表无残留断言：
    /// 审计路由随 run 生命周期不泄漏；与 escape_watch 句柄同生命周期
    /// 收口对齐）。注册走与 run_task_impl 同构的 BridgeAuditSink 装配，
    /// 收口走真实 drive_run_loop 终态路径。
    #[tokio::test]
    async fn audit_sink_route_registered_at_run_start_unregistered_on_close() {
        let (state, _registry) = state_with_background();
        let session_id = "audit-sink-s1";
        let run_id = "audit-sink-r1";
        let active = build_active_run(&state, session_id, run_id).await;
        // 模拟 run_task_impl 装配：run 启动注册（BridgeAuditSink 包装
        // 同一 run 级桥——与生产装配同构；持久化通道为测试占位）
        let (_audit_tx, _audit_rx) = tokio::sync::mpsc::unbounded_channel::<AgentEvent>();
        let bridge_audit = Arc::new(BridgeAuditSink::new(
            Arc::clone(&active.bridge),
            run_id.to_string(),
            _audit_tx,
        ));
        state
            .engine
            .audit_sink()
            .register(session_id, bridge_audit as AuditSink);
        assert_eq!(
            state.engine.audit_sink().route_count(),
            1,
            "run 启动后会话路由应已注册"
        );
        // 驱动 run 终态（真实 drive_run_loop 收口路径）
        state
            .active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(run_id.to_string(), Arc::clone(&active));
        drive_run_loop(
            Arc::clone(&state),
            active,
            Box::new(TestProducer::new(canned_outcome())),
        )
        .await;
        // 收口注销：注册表无残留
        assert_eq!(
            state.engine.audit_sink().route_count(),
            0,
            "run 收口后审计路由必须注销（防 session 泄漏）"
        );
    }

    /// 会话串行守卫下重复 run：前一 run 注册被后一 run 覆盖，收口后
    /// 注册表整体清空（多 run 并发路由注册者覆盖语义 + 收口注销）
    #[tokio::test]
    async fn audit_sink_route_cleared_after_consecutive_runs() {
        let (state, _registry) = state_with_background();
        // 第一 run 注册
        let run_1 = build_active_run(&state, "audit-sink-s2", "audit-sink-r2a").await;
        let (_tx_1, _rx_1) = tokio::sync::mpsc::unbounded_channel::<AgentEvent>();
        state.engine.audit_sink().register(
            "audit-sink-s2",
            Arc::new(BridgeAuditSink::new(
                Arc::clone(&run_1.bridge),
                "audit-sink-r2a".to_string(),
                _tx_1,
            )) as AuditSink,
        );
        // 第二 run 覆盖注册（后注册者覆盖语义）
        let run_2 = build_active_run(&state, "audit-sink-s2", "audit-sink-r2b").await;
        let (_tx_2, _rx_2) = tokio::sync::mpsc::unbounded_channel::<AgentEvent>();
        state.engine.audit_sink().register(
            "audit-sink-s2",
            Arc::new(BridgeAuditSink::new(
                Arc::clone(&run_2.bridge),
                "audit-sink-r2b".to_string(),
                _tx_2,
            )) as AuditSink,
        );
        assert_eq!(state.engine.audit_sink().route_count(), 1);
        // 收口两个 run（各走一次真实 drive_run_loop 终态路径）
        for (run_id, active) in [
            ("audit-sink-r2a", run_1),
            ("audit-sink-r2b", run_2),
        ] {
            state
                .active_runs
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(run_id.to_string(), Arc::clone(&active));
            drive_run_loop(
                Arc::clone(&state),
                active,
                Box::new(TestProducer::new(canned_outcome())),
            )
            .await;
        }
        // 收口注销幂等 + 注册表无残留
        assert_eq!(
            state.engine.audit_sink().route_count(),
            0,
            "连续 run 收口后注册表必须清空"
        );
    }

    // ── L4（F12）：security-audit 落库接线（append_event 持久化）──

    /// 测试用 security-audit 事件（delete 操作；形状对齐
    /// agent-tools audit.rs security_audit_event 构造器）
    fn audit_delete_event(session_id: &str, decision: SecurityAuditDecision) -> AgentEvent {
        agent_tools::audit::security_audit_event(
            session_id,
            SecurityAuditOperation::Delete,
            vec!["a.txt".to_string()],
            ImpactAssessment {
                file_count: 1,
                total_size_bytes: 0,
                directory_count: 0,
                cross_directory: false,
                flagged: false,
            },
            decision,
            None,
        )
    }

    /// 桥接审计 sink 双轨发射：emit → 实时广播（缓冲桥）+ 持久化通道
    /// （worker 按发射序落库）——广播保实时、落库保审计底账并存
    #[test]
    fn bridge_audit_sink_broadcasts_and_queues_persistence() {
        let (bridge, emitter) = recording_bridge();
        let buffered = Arc::new(BufferedRunEventBridge::new(bridge, "run-audit"));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<AgentEvent>();
        let sink = BridgeAuditSink::new(Arc::clone(&buffered), "run-audit".to_string(), tx);
        sink.emit(&audit_delete_event("s1", SecurityAuditDecision::Blocked));

        // 实时轨：缓冲桥收到并冲刷（记录发射器一条 security-audit 信封）
        let payloads = emitter.0.lock().unwrap().clone();
        assert_eq!(payloads.len(), 1, "实时广播一条");
        let v: serde_json::Value = serde_json::from_str(&payloads[0]).expect("载荷为合法 JSON");
        assert_eq!(v["type"], "security-audit");
        assert_eq!(v["decision"], "blocked");

        // 持久化轨：同一事件已入通道（worker 按序 reserve + append_event）
        let received = rx.try_recv().expect("审计事件应进入持久化通道");
        assert!(
            matches!(received, AgentEvent::SecurityAudit { .. }),
            "持久化通道应收到 security-audit 事件"
        );
    }

    /// L4（F12）端到端：审计事件落库——run 内经路由 sink 发射
    /// security-audit → run 收口后 events 表可读回（sequence 分配 +
    /// 载荷保真；实时广播与落库底账双轨并存）
    #[tokio::test]
    async fn security_audit_persists_into_events_table() {
        // provider 脚本暂停 2s：保证 run 活动窗口内发射审计事件
        // （路由注册在 spawn 前同步完成，窗口内发射必达桥）
        let main = Arc::new(
            TestProvider::new(vec![
                ProviderStreamEvent::text("正在执行任务。"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ])
            .with_pause(0, 2_000),
        );
        let sub = Arc::new(TestProvider::new(vec![
            ProviderStreamEvent::text("调研完成。"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ]));
        let (state, db, _main, _sub, emitter) =
            subagent_state_with_providers(main, sub, "deepseek-v4-flash");
        state.run_restore().await;

        // 完整 run_task_impl → drive_run_loop（run 启动注册审计路由）
        run_task_impl(
            Arc::clone(&state),
            test_options("run-audit-1", "sess-main", "执行一次安全审计任务"),
        )
        .await
        .expect("run 发起成功");

        // run 活动窗口内：经路由型审计 sink 发射工具级 security-audit
        //（模拟 shell/delete 审计；run 级 BridgeAuditSink 承接 → 实时
        // 广播 + 持久化通道）
        state
            .engine
            .audit_sink()
            .emit(&audit_delete_event("sess-main", SecurityAuditDecision::Denied));

        // 等待 run 收口（收口处 await 审计落库 worker 排空；此处轮询
        // 兜底驱动任务与测试主线的微小竞态窗口）
        wait_all_runs_terminal(&state, Duration::from_secs(30)).await;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let (audit_sequence, audit_payload) = loop {
            let events = db.query_events("sess-main", 0, Some(200)).expect("事件查询");
            if let Some(found) = events
                .iter()
                .find(|e| e.event_type == "security-audit")
                .map(|e| (e.sequence, e.payload.clone()))
            {
                break found;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "审计事件未在窗口内落库"
            );
            tokio::time::sleep(Duration::from_millis(30)).await;
        };

        // 1. 审计底账：events 表可读回（append_event 持久化 + sequence 分配）
        assert!(
            audit_sequence >= 1,
            "审计事件应有分配的 sequence：{audit_sequence}"
        );
        let payload: serde_json::Value =
            serde_json::from_str(&audit_payload).expect("落库载荷为合法 JSON");
        assert_eq!(payload["decision"], "denied", "落库载荷决策保真");

        // 2. 实时轨并存：同一审计事件也经缓冲桥广播（前端审计面板可见）
        let broadcast = emitter.0.lock().unwrap().clone();
        assert!(
            broadcast.iter().any(|p| {
                serde_json::from_str::<serde_json::Value>(p)
                    .map(|v| v["type"] == "security-audit")
                    .unwrap_or(false)
            }),
            "实时广播应与落库并存（广播保实时、落库保底账）"
        );
    }
}
