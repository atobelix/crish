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
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_provider::request::build_system_prompt;
use agent_tools::audit::{AuditSink, SecurityAuditSink};
use agent_tools::backup::BackupMiddleware;
use agent_tools::background::{
    BackgroundAdoptRequest, BackgroundTaskInfo, BackgroundTaskManager, BackgroundTaskRef, TaskState,
};
use agent_tools::definition::ToolError;
use conex_db::LocalDb;
use conex_types::events::{
    AgentEvent, AgentEventEnvelope, ApprovalDecision as WireApprovalDecision, PermissionRequest,
    RunCacheStats, RunTerminalStatus, SecurityAuditDecision, SecurityAuditOperation,
};
use conex_types::impact::ImpactAssessment;
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use conex_types::{codes, ContextBudget, CrishError, CrishErrorPayload, HistoryMessage};
use orchestrator::events::{build_run_terminal, drive_outcome, EventQueue};
use orchestrator::persist::{SessionSequencer, Store};
use orchestrator::restore::{RestoreManager, RestoreMode, RestoreOutcome, SnapshotStore, StateSnapshot};
use orchestrator::run::{CancelMode, RunEngine, RunHandle, RunManager};
use orchestrator::session::SessionRecord;
use session_loop::hydrate::hydrate_history;
use session_loop::approval_router::{
    classify_source, route_approval, route_approval_guarded, arbiter_metadata,
};
use session_loop::tool_events::{ApprovalDecision, ApprovalRequester};
use tauri::Manager as _;
use session_loop::{
    AbortSignal, ApprovalGate, ControlBus, DeltaSink, EscapeWatchConfig, EscapeWatchHandle,
    EscapeWatchInjector, PermissionMode, RunOutcome, SessionLoopOptions, ToolBatchOptions,
    spawn_escape_watch,
};

use crate::core_error::CoreError;
use crate::core_event_bridge::{EmitReport, EventBridge};
use crate::core_query_commands::{BackgroundTasksSummary, RestoreStatus, RunUsage, SnapshotStatus};
use crate::engine::{BridgeDeltaSink, BufferedRunEventBridge, EngineHandle, SessionLoopProducer};
use crate::status_diagnostics::StatusDiagnostics;

/// run 的 max-turns 预算（对齐 01 §1.5：独立预算 reason）
const MAX_TURNS_DEFAULT: u32 = 64;
/// 审批等待超时（超时 → Expired；前端 ApprovalFlow 亦有兜底）
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);
/// 快照周期默认值（T08.6 触发点 B：默认 60s，session_meta
/// `snapshot_interval_ms` 可配）
const DEFAULT_SNAPSHOT_INTERVAL_MS: u64 = 60_000;
/// T-29：SessionHistoryCache 每会话消息条数上限（防膨胀；超出时保留
/// 最近 N 条并对齐安全前缀，P4 阶段 1-3）
const SESSION_HISTORY_MAX_MESSAGES: usize = 200;
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
                    "tool_call_id 不在待审批集合（run={}）：{tool_call_id}",
                    self.run_id
                ))
            })?;
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
/// 可见；与审批门 broadcast 同构）。落库（append_event）留 F12 端到端
/// 验收登记（REQ-逃逸追踪分析 §3.3 发射点 1）。
#[derive(Debug)]
struct BridgeAuditSink {
    /// 本 run 缓冲事件桥
    bridge: Arc<BufferedRunEventBridge>,
    /// run 标识（信封注入）
    run_id: String,
}

impl BridgeAuditSink {
    /// 新建桥接审计 sink（run 级实例）
    fn new(bridge: Arc<BufferedRunEventBridge>, run_id: String) -> Self {
        Self { bridge, run_id }
    }
}

impl SecurityAuditSink for BridgeAuditSink {
    fn emit(&self, event: &AgentEvent) {
        let envelope = AgentEventEnvelope::new(event.clone(), Some(self.run_id.clone()), None);
        self.bridge.emit(&envelope);
        self.bridge.flush();
    }
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
    /// 每会话消息条数上限
    max_messages: usize,
    /// 会话数上限
    max_sessions: usize,
}

struct CacheInner {
    sessions: HashMap<String, Vec<HistoryMessage>>,
    /// 写入顺序（FIFO 淘汰最久未更新的会话；重复写入移到末尾 ≈ LRU）
    order: VecDeque<String>,
}

impl SessionHistoryCache {
    /// 新建缓存（默认容量：每会话 `SESSION_HISTORY_MAX_MESSAGES` 条、
    /// 最多 `SESSION_HISTORY_MAX_SESSIONS` 个会话）
    pub(crate) fn new() -> Self {
        Self::with_limits(SESSION_HISTORY_MAX_MESSAGES, SESSION_HISTORY_MAX_SESSIONS)
    }

    /// 新建缓存（显式容量；测试用小容量验证上限语义）
    pub(crate) fn with_limits(max_messages: usize, max_sessions: usize) -> Self {
        Self {
            inner: Mutex::new(CacheInner {
                sessions: HashMap::new(),
                order: VecDeque::new(),
            }),
            max_messages,
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
    /// 写入前执行两级护栏：
    /// 1. 条数上限：保留最近 `max_messages` 条（截掉最旧）；
    /// 2. 安全前缀：逐条前移直到首条为 user（不保留孤儿 tool/system
    ///    首条与带未配对 ToolCall 的 assistant 首条——wire 400 风险）。
    ///
    /// 会话数超限：FIFO 淘汰最久未更新的会话。
    pub(crate) fn store(&self, session_id: &str, mut messages: Vec<HistoryMessage>) {
        if messages.len() > self.max_messages {
            let keep = self.max_messages;
            messages.drain(..messages.len() - keep);
        }
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
fn cached_history_to_conversation(entries: Vec<HistoryMessage>) -> Vec<Arc<AgentMessage>> {
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
    /// 引擎句柄（provider 配置 + 工具注册表 + engineReady）
    engine: EngineHandle,
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
        Self {
            store: Arc::clone(&store),
            run_manager: RunManager::new(store),
            engine: EngineHandle::new(
                // 引擎侧注入包装实例（保持 Option 语义：未接线 = 引擎无
                // 后台任务通道，与接线前行为一致）
                background
                    .inner
                    .is_some()
                    .then(|| Arc::clone(&background) as Arc<dyn BackgroundTaskManager>),
            ),
            bridge,
            active_runs: Mutex::new(HashMap::new()),
            diagnostics,
            next_sequences: Mutex::new(HashMap::new()),
            restore_ready: AtomicBool::new(false),
            snapshots,
            snapshot_interval_ms: Mutex::new(DEFAULT_SNAPSHOT_INTERVAL_MS),
            snapshot_generation: AtomicU64::new(0),
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
        }
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

    /// restore 是否完成（run_task 门禁；查询命令 restore.state 数据源）
    pub fn restore_ready(&self) -> bool {
        self.restore_ready.load(Ordering::SeqCst)
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

    /// T08.6 触发点 A/B 共用：保存快照（generation 续接；P16 失败显式标记）
    pub async fn save_snapshot_now(&self) {
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
    /// last_sequence = 全会话事件 max；快照只是近似一致，增量重放以锚点补足）
    async fn build_and_save_snapshot(&self) -> Result<u64, String> {
        let runs = self.store.query_runs().await.map_err(|e| e.to_string())?;
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let mut pending = Vec::new();
        let mut last_sequence = 0u64;
        for session in &sessions {
            let events = self
                .store
                .query_events(&session.session_id, 0)
                .await
                .map_err(|e| e.to_string())?;
            last_sequence = last_sequence.max(events.iter().map(|e| e.sequence).max().unwrap_or(0));
            pending.extend(
                self.store
                    .load_pending_inputs(&session.session_id)
                    .await
                    .map_err(|e| e.to_string())?,
            );
        }
        let generation = self.snapshot_generation.load(Ordering::SeqCst) + 1;
        let snapshot = StateSnapshot::build(generation, last_sequence, sessions, runs, pending);
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
async fn drive_run_loop(
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
    // T-AB-19 run 终态显式接线：**不清理后台任务注册表、不级联杀任务**
    // ——任务属会话级（registry 生命周期独立于 run，T-AB-12 只读契约升级
    // 为显式收口契约；run_end_daemon_survives / run_end_normal_task_survives
    // _no_cascade 测试锚定）。守护任务（is_daemon=true）与普通任务在 run
    // 终态后均持续运行、日志持续累积；会话切换同理不受影响。此处仅释放
    // 「当前 run」上下文（owner_run_id 注入槽，供下一 run 复用）。
    state.background.clear_current_run(&run_id);
    state.save_snapshot_now().await;
    tracing::info!(
        target: "run",
        run_id = %run_id,
        "drive_run_loop 收口（终态）：后台任务注册表未清理、任务不级联杀（T-AB-19 契约）"
    );
}

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
    // T-AB-19 失败收口显式接线（与成功收口同一契约）：不清理后台任务
    // 注册表、不级联杀任务——任务属会话级；仅释放「当前 run」上下文。
    state.background.clear_current_run(&run_id);
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
}

#[tauri::command]
pub(crate) async fn core_run_task(
    state: tauri::State<'_, Arc<CoreRunState>>,
    options: RunTaskOptions,
) -> Result<RunTaskResponse, CoreError> {
    let state = Arc::clone(state.inner());
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
    let tool_registry = state.engine.tool_registry();

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
    let approval_gate = Arc::new(ApprovalGateImpl::new(
        run_id.clone(),
        session_id.clone(),
        // T-D-14：父 run 归属（子代理 run 由 spawner 携带；None = 主 agent）
        options.parent_run_id.clone(),
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
    // 消费钳制与预检）。
    let context_budget = context_window.map(assemble_context_budget);
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
    // 监视启动失败仅告警不阻断 run（监视是追踪面，REQ §3.6 不阻断）；
    // 判定器本轮未接线（write_claims 总接线点在 F7 T-EG-06，届时须
    // 同时经 EscapeWatchConfig::with_detector 注入
    // RegistryBackedDetector）——当前仅依赖监视事件直接发射（「工具
    // 审计覆盖」第二来源兜底，REQ §3.1:349-356）。
    let control_bus = Arc::new(Mutex::new(ControlBus::new()));
    let (escape_watch, escape_config) = if let Some(dir) = cwd.clone() {
        let root = PathBuf::from(dir);
        let config = EscapeWatchConfig::new(
            root.clone(),
            session_id.clone(),
            run_id.clone(),
            Arc::new(BridgeAuditSink::new(Arc::clone(&bridge), run_id.clone())) as AuditSink,
        )
        .with_injector(Arc::new(ControlBusInjector::new(Arc::clone(&control_bus))));
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
        parent_run_id: options.parent_run_id.clone(),
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
    .with_cache_session(state.engine.cache_session(&session_id));

    // T-AB-19：登记当前 run 上下文（owner_run_id 注入槽）——须在 spawn
    // drive_run_loop 之前，保证 run 内工具执行链 adopt 时已可见；run
    // 终态（drive_run_loop 收口 / finalize_failed）经 clear_current_run 释放。
    state.background.set_current_run(&run_id);

    // 注册活动 run 并 spawn 驱动循环
    let active = Arc::new(ActiveRun {
        session_id: session_id.clone(),
        run_id: run_id.clone(),
        handle: handle_shared,
        queue,
        control_bus: Arc::clone(&control_bus),
        abort_signal: AbortSignal::new(),
        approval: approval_gate,
        bridge,
        delta_sink_active: true,
        escape_watch: Mutex::new(escape_watch),
    });
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(run_id.clone(), Arc::clone(&active));
    tauri::async_runtime::spawn(drive_run_loop(state, active, Box::new(producer)));

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
    let active = active_run(state.inner(), run_id.trim())?;
    let cancel_mode = match mode.as_deref() {
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
            "cancelled-by-user",
            state.inner().store.as_ref(),
        )
        .await
        .map_err(crate::core_error::map_run_err)?;
    drop(handle);
    tracing::info!(
        target: "run",
        run_id = %active.run_id,
        path = ?path,
        "core_cancel_run（终态由 drive_run_loop 收口）：后台任务注册表未清理、任务不级联杀（T-AB-19 契约）"
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
    let active = active_run(state.inner(), run_id.trim())?;
    // 仅接受 approved（其余值按 InvalidInput 拒绝，杜绝伪造）
    if decision.is_some_and(|d| d != "approved") {
        return Err(CoreError::invalid_input(
            "approve 的 decision 只能为 approved",
        ));
    }
    active
        .approval
        .resolve(&tool_call_id, ApprovalDecision::Approved)
        .await?;
    emit_approval_resolved(&active, &tool_call_id, WireApprovalDecision::Approved).await;
    Ok(ApproveResponse {
        ok: true,
        tool_call_id,
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
    let active = active_run(state.inner(), run_id.trim())?;
    active
        .approval
        .resolve(
            &tool_call_id,
            ApprovalDecision::Denied {
                reason: reason.unwrap_or_else(|| "user denied".to_string()),
            },
        )
        .await?;
    emit_approval_resolved(&active, &tool_call_id, WireApprovalDecision::Denied).await;
    Ok(ApproveResponse {
        ok: true,
        tool_call_id,
        decision: "denied",
    })
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

#[cfg(test)]
mod tests {
    // G2 禁令豁免：测试临时目录清理（非产品删除路径，可恢复语义不适用）。
    #![allow(clippy::disallowed_methods)]

    use super::*;
    use conex_types::message::{AgentMessageBlock, AgentMessageRole, ToolCallBlock};
    use conex_types::session::AgentEndReason;
    use conex_types::tool::ToolOutput;

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

    // ── T-29：SessionHistoryCache ──────────────────────────────────

    /// 缓存容量上限（每会话消息条数）：超出保留最近 N 条，最旧截掉
    #[test]
    fn session_history_cache_caps_messages_per_session() {
        let cache = SessionHistoryCache::with_limits(3, 8);
        let many: Vec<HistoryMessage> =
            (0..7).map(|i| hmsg(&format!("m{i}"), "user", Some("x"))).collect();
        cache.store("s1", many);
        let stored = cache.get("s1").unwrap();
        assert_eq!(cache.message_count("s1"), 3);
        // 保留最近 3 条（m4/m5/m6），最旧 4 条截掉
        let ids: Vec<&str> = stored.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["m4", "m5", "m6"]);
    }

    /// 缓存容量上限（会话数）：超出 FIFO 淘汰最久未更新的会话
    #[test]
    fn session_history_cache_evicts_oldest_session() {
        let cache = SessionHistoryCache::with_limits(8, 2);
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
        let cache = SessionHistoryCache::with_limits(16, 4);
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
        let cache = SessionHistoryCache::with_limits(16, 4);
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
        })
    }

    /// 测试生产者：返回预置收口结果（驱动 drive_run_loop 一次终态）
    struct TestProducer {
        outcome: RunOutcome,
    }

    #[async_trait::async_trait]
    impl RunProducer for TestProducer {
        async fn produce(&mut self) -> RunOutcome {
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
            Box::new(TestProducer {
                outcome: canned_outcome(),
            }),
        )
        .await;

        // run 终态后：任务存活（Running、pid 存活）+ 日志持续累积
        let s1 = registry.status(&adopted.task_id).await.expect("status");
        assert_eq!(s1.status, TaskState::Running, "守护任务在 run 终态后必须存活");
        assert!(pid_is_alive(pid), "守护任务进程必须存活");
        let lines_before = s1.line_count;
        tokio::time::sleep(Duration::from_millis(1200)).await;
        let s2 = registry.status(&adopted.task_id).await.expect("status");
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
            Box::new(TestProducer {
                outcome: canned_outcome(),
            }),
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
        wait_task_terminal(&registry, &normal.task_id, Duration::from_secs(10)).await;
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
        wait_task_terminal(&registry, &finished.task_id, Duration::from_secs(8)).await;

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
            Box::new(TestProducer {
                outcome: canned_outcome(),
            }),
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
            Box::new(TestProducer {
                outcome: canned_outcome(),
            }),
        )
        .await;

        // 会话 A 的任务在会话切换后仍存活
        assert!(pid_is_alive(pid), "会话切换后任务必须存活");
        let status = registry.status(&adopted.task_id).await.expect("status");
        assert_eq!(status.status, TaskState::Running);

        // 清理
        let _ = registry.kill(&adopted.task_id).await;
    }
}
