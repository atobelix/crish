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
use conex_types::events::{
    AgentEvent, AgentEventEnvelope, ApprovalDecision as WireApprovalDecision, PermissionRequest,
    RunTerminalStatus,
};
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use conex_types::{codes, ContextBudget, CrishError, CrishErrorPayload, HistoryMessage};
use orchestrator::events::{build_run_terminal, drive_outcome, EventQueue};
use orchestrator::persist::{SessionSequencer, Store};
use orchestrator::restore::{RestoreManager, RestoreMode, RestoreOutcome, SnapshotStore, StateSnapshot};
use orchestrator::run::{CancelMode, RunEngine, RunHandle, RunManager};
use orchestrator::session::SessionRecord;
use session_loop::hydrate::hydrate_history;
use session_loop::tool_events::ApprovalDecision;
use tauri::Manager as _;
use session_loop::{
    AbortSignal, ApprovalGate, ControlBus, DeltaSink, PermissionMode, RunOutcome, SessionLoopOptions,
    ToolBatchOptions,
};

use crate::core_error::CoreError;
use crate::core_event_bridge::{EmitReport, EventBridge};
use crate::core_query_commands::{RestoreStatus, RunUsage, SnapshotStatus};
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
        broadcast: Box<dyn Fn(AgentEvent) + Send + Sync>,
        handle: Arc<tokio::sync::Mutex<RunHandle>>,
        store: Arc<dyn Store>,
        cwd: Option<String>,
    ) -> Self {
        Self {
            run_id,
            session_id,
            broadcast,
            pending: std::sync::Mutex::new(HashMap::new()),
            handle,
            store,
            cwd,
        }
    }

    /// 当前待审批数（core_get_status.pendingApprovals 数据源）
    pub(crate) fn pending_count(&self) -> usize {
        self.pending
            .lock()
            .map(|guard| guard.len())
            .unwrap_or_default()
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
    ) -> ApprovalDecision {
        // 1. 广播 approval-requested（防死锁：先发出再等待，01 §五.8；
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
            metadata: None,
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
    ) -> Self {
        Self {
            store: Arc::clone(&store),
            run_manager: RunManager::new(store),
            engine: EngineHandle::new(),
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

    /// run usage 域（未接线时 None，前端回退估算——contract 注释约定）
    pub fn run_usage(&self, _run_id: &str) -> Option<RunUsage> {
        None
    }

    /// 共享 store（查询命令 / 集成接线用）
    pub fn store(&self) -> Arc<dyn Store> {
        Arc::clone(&self.store)
    }

    /// 引擎句柄（查询命令 / 集成接线用）
    pub fn engine(&self) -> &EngineHandle {
        &self.engine
    }

    /// 状态诊断（查询命令 / 集成接线用）
    pub fn diagnostics(&self) -> Arc<StatusDiagnostics> {
        Arc::clone(&self.diagnostics)
    }

    /// 活动 run 数（core_get_status.activeRuns 数据源）
    pub fn active_run_count(&self) -> usize {
        self.active_runs.lock().map(|r| r.len()).unwrap_or_default()
    }

    /// 待审批数（core_get_status.pendingApprovals 数据源）
    pub fn pending_approval_count(&self) -> usize {
        self.active_runs
            .lock()
            .map(|runs| runs.values().map(|r| r.approval.pending_count()).sum())
            .unwrap_or_default()
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

    // 4-5. 终态：移出注册表 + 快照（T08.6 触发点 A；cursor 已由
    //      drive_outcome 维护并在 finalize 落库）
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&run_id);
    state.save_snapshot_now().await;
    tracing::info!(target: "run", "drive_run_loop 收口（终态）");
}

/// 错误路径收口（四源失败 / 防御性驱动失败）
///
/// - runtime-error 事件（持久化，03 §2.4 四源失败收口）；
/// - run 标记 failed（event-store-write-failed 语义，不假装可回放）；
/// - 终态事件尽力发出（run-terminal 唯一终态，03 §5.2-2）；
/// - lastError 写入（T04.5-1：finalize_failed 写入点）。
async fn finalize_failed(state: &Arc<CoreRunState>, active: &ActiveRun, message: &str) {
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
#[tauri::command]
pub(crate) async fn core_run_task(
    state: tauri::State<'_, Arc<CoreRunState>>,
    run_id: String,
    session_id: String,
    prompt: Option<String>,
    mode: Option<String>,
    cwd: Option<String>,
    permission_mode: Option<String>,
    client_message_id: Option<String>,
    assistant_client_message_id: Option<String>,
    system_prompt: Option<String>,
    history: Option<Vec<HistoryMessage>>,
    context_window: Option<u32>,
) -> Result<RunTaskResponse, CoreError> {
    let state = Arc::clone(state.inner());
    // 参数校验（S-15：trim + 显式 InvalidInput）
    let run_id = run_id.trim().to_string();
    let session_id = session_id.trim().to_string();
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
    let options = SessionLoopOptions {
        cwd: cwd.clone(),
        assistant_client_message_id: assistant_client_message_id.clone(),
        system_prompt: build_system_prompt(system_prompt),
        context_budget,
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
    );

    // 注册活动 run 并 spawn 驱动循环
    let active = Arc::new(ActiveRun {
        session_id: session_id.clone(),
        run_id: run_id.clone(),
        handle: handle_shared,
        queue,
        control_bus: Arc::new(Mutex::new(ControlBus::new())),
        abort_signal: AbortSignal::new(),
        approval: approval_gate,
        bridge,
        delta_sink_active: true,
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
    let active = active_run(state.inner(), run_id.trim())?;
    match level.as_str() {
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
            let mut bus = active
                .control_bus
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            bus.request_force_cancel(
                Some(reason.unwrap_or_else(|| "ui-force-cancel".to_string())),
                Some("ui".to_string()),
            );
            Ok(())
        }
        other => Err(CoreError::invalid_input(format!("未知 level：{other}"))),
    }
}

// ── 命令：core_cancel_run ─────────────────────────────────────────

/// 取消 run（过渡双线（03 §4.2）：IPC 模式经 run-control 单线为主，
/// 本命令保留双线兼容——L2 协作 / L3 强制，模式回落走 RunEngine 语义）
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
        "core_cancel_run（终态由 drive_run_loop 收口）"
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
/// 工作区注册表不可用 → 结构化错误（不静默退化）。
fn trash_root_for(app: &tauri::AppHandle) -> Result<PathBuf, CoreError> {
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
) -> Result<TrashRestoreResponse, CoreError> {
    let root = trash_root_for(&app)?;
    trash_restore_at(&root, &entry_id)
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
) -> Result<TrashPurgeResponse, CoreError> {
    let root = trash_root_for(&app)?;
    trash_purge_at(&root, &entry_id)
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

// ── 测试 ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
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
}
