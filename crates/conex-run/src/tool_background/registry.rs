//! 通用后台执行注册表（工具调用超时转后台 · BG1 契约本体）
//!
//! 定位：托管「执行满阈值被 detach 的进程内工具调用」（与 shell 的
//! 进程注册表并列、互不冒充）。本批只立契约与数据结构——登记、准入、
//! 落定、取消、查询、会话收口、冷启动原料——执行单元的实际 spawn 与
//! 三方竞速接线在 BG2、结果回注与事件在 BG3。
//!
//! 契约要点（用户定案 2026-11-01，后续批次不得改口）：
//! - **无时长上限**：注册表内没有任何按时长收口任务的逻辑与状态；
//!   任务终结只来自执行落定、取消（含用户停止级联）、会话关闭、
//!   冷启动合成（OutcomeUnknown）。工具自带超时（如 shell 的
//!   timeoutMs）是工具契约层的事，不在本注册表体现。
//! - **容量**：每会话并发 4、全局 16（对齐批并发与子代理上限）；
//!   超额在**开始执行前**排队，排队不计时（started_at 在获槽时才写）。
//! - **幂等**：同一 callId 重复登记返回既有条目，不重复登记、不
//!   覆盖；在途去重（同 session+tool+入参摘要）经 [Self::find_inflight]
//!   查询面提供，执行器侧（BG2）据此返回同一 callId 的占位。
//! - **终态先落定者胜**：settle / cancel / mark_outcome_unknown 只有
//!   第一个把条目带离非终态的调用生效，其余返回 false。
//! - **两级查询**：进程内条目优先；终态条目在内存中只保留有界窗口
//!   （[MAX_SETTLED_RETAINED]，仿 TaskEventConsumer 的有界淘汰），
//!   淘汰后经落盘存储回查。
//!
//! 时间戳全部由调用方传入（`now_ms`，ms epoch）：注册表自身不读
//! 时钟、不设任何定时器——这是「无时长上限」在结构上的保证，也使
//! 契约可用虚拟时钟完整测试。仅 tool_task 查询契约的状态快照在
//! trait 实现处以真实时钟计算运行中任务的已运行时长（展示口径）。

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use agent_tools::context::AbortToken;
use agent_tools::tools::tool_task::{
    ToolBackgroundQuery, ToolTaskResult, ToolTaskState, ToolTaskStatus,
};
use agent_tools::write_paths::WritePathRegistry;
use async_trait::async_trait;
use session_loop::tool_events::ClassifiedToolResult;
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use super::events::ToolBackgroundCallSummary;
use super::store::{ToolBackgroundRecord, ToolBackgroundStore};

/// 取消终态的人读留痕（条目 note / 结果视图文案 / BG3 合成结果
/// 文案同源，禁止第二处字面量）
pub const CANCELLED_NOTE: &str = "后台工具调用已取消";
/// 结果未知终态的人读留痕（同上）
pub const OUTCOME_UNKNOWN_NOTE: &str = "进程退出或执行句柄丢失，工具结果未知";

/// 每会话并发上限（对齐批内并行 DEFAULT_MAX_PARALLEL = 4）
pub const MAX_RUNNING_PER_SESSION: usize = 4;
/// 全局并发上限（对齐子代理 maxConcurrent 裁决值 16）
pub const MAX_RUNNING_GLOBAL: usize = 16;
/// 终态条目在进程内保留的条数上限（超出按落定序 FIFO 淘汰，
/// 淘汰后查询经落盘存储回查；对齐 TaskEventConsumer 的 256 口径）
pub const MAX_SETTLED_RETAINED: usize = 256;

/// 写路径声明句柄槽位（条目结构的一部分，先行冻结）
///
/// v1 写工具禁入后台，本槽位恒为 None；后续开放写工具时，登记方把
/// 执行期声明所用的注册表与持有者写入此槽位，注册表在条目终结时
/// 可据此核对 claim 释放（具体 guard 类型届时在此替换）。
#[derive(Debug, Clone)]
pub struct ToolBackgroundWriteClaim {
    /// 写路径互斥注册表（与 ToolContext.write_claims 同一实例）
    pub registry: Arc<WritePathRegistry>,
    /// 声明持有者（子代理 run id；None = 会话主身份）
    pub holder: Option<String>,
}

/// 登记请求（BG2 在 detach 点构造）
pub struct NewToolBackgroundTask {
    /// 工具调用 id（全局唯一键，来自占位收口的本调用）
    pub call_id: String,
    /// 会话 id（容量按会话计数、会话关闭按此收口）
    pub session_id: String,
    /// 发起 run id（级联取消与审计归属；主 run 直接发起时为其 run id）
    pub run_id: Option<String>,
    /// 工具名
    pub tool_name: String,
    /// 入参摘要摘要值（在途去重键的组成部分，由 BG2 按
    /// ToolIdempotencyGuard 的键口径生成，注册表只做不透明比较）
    pub args_digest: String,
    /// 发起 run 的中止令牌（条目子令牌派生自它：run 中止 ⇒ 子令牌
    /// 视为已中止，执行侧据此自收口——级联取消的令牌面）
    pub parent_token: AbortToken,
    /// 登记时刻（ms epoch，调用方传入）
    pub now_ms: u64,
    /// 写路径声明句柄（v1 恒 None，见 [ToolBackgroundWriteClaim]）
    pub write_claim: Option<ToolBackgroundWriteClaim>,
}

/// 登记结果分类
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegisterOutcome {
    /// 已获执行槽位（状态 Running）
    Admitted,
    /// 已登记、排队等待槽位（状态 Queued）
    Queued,
    /// 同 callId 已登记（幂等命中，返回既有条目，未重复登记）
    AlreadyExists,
}

/// 登记返回（结果分类 + 条目当前状态快照）
#[derive(Debug, Clone, PartialEq)]
pub struct Registration {
    pub outcome: RegisterOutcome,
    pub status: ToolTaskStatus,
}

/// 注册表计数快照（监控与验收口径）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ToolBackgroundCounts {
    /// 全局运行中
    pub running_total: usize,
    /// 全局排队中
    pub queued_total: usize,
    /// 进程内保留的终态条目数
    pub retained_settled: usize,
}

/// 注册表条目（进程内形态）
struct Entry {
    call_id: String,
    session_id: String,
    run_id: Option<String>,
    tool_name: String,
    args_digest: String,
    state: ToolTaskState,
    /// 条目独立子令牌（派生自登记时的 run 令牌；显式取消时由注册表
    /// 触发，执行侧 [Self::entry_token] 取得后与之竞速/自查）
    token: AbortToken,
    /// 执行包装任务句柄（BG2 在 spawn 后挂入；取消时 abort）
    handle: Option<JoinHandle<()>>,
    /// 落定结果（SettledOk/SettledErr 时有值，与直接执行同构）
    result: Option<ClassifiedToolResult>,
    /// 取消/未知态的人读留痕（终态无 result 时的结果视图文案来源）
    note: Option<String>,
    queued_at_ms: u64,
    started_at_ms: Option<u64>,
    settled_at_ms: Option<u64>,
    #[allow(dead_code)]
    write_claim: Option<ToolBackgroundWriteClaim>,
}

impl Entry {
    fn is_terminal(&self) -> bool {
        self.state.is_terminal()
    }

    /// 执行耗时：以执行器实测（result.duration_ms）为准；无 result 的
    /// 终态（取消/未知）以 started→settled 墙钟差兜底
    fn duration_ms(&self) -> Option<u64> {
        if let Some(result) = &self.result {
            return Some(result.duration_ms);
        }
        match (self.started_at_ms, self.settled_at_ms) {
            (Some(start), Some(end)) => Some(end.saturating_sub(start)),
            _ => None,
        }
    }

    fn snapshot(&self, now_ms: u64) -> ToolTaskStatus {
        let duration_ms = match (self.started_at_ms, self.settled_at_ms) {
            (Some(_), Some(_)) => self.duration_ms(),
            (Some(start), None) if self.state == ToolTaskState::Running => {
                Some(now_ms.saturating_sub(start))
            }
            _ => None,
        };
        ToolTaskStatus {
            call_id: self.call_id.clone(),
            tool_name: self.tool_name.clone(),
            state: self.state,
            queued_at_ms: self.queued_at_ms,
            started_at_ms: self.started_at_ms,
            settled_at_ms: self.settled_at_ms,
            duration_ms,
        }
    }

    fn result_view(&self) -> ToolTaskResult {
        match &self.result {
            Some(result) => ToolTaskResult {
                call_id: self.call_id.clone(),
                tool_name: self.tool_name.clone(),
                state: self.state,
                result_ready: true,
                output: if result.is_ok() {
                    Some((*result.output).clone())
                } else {
                    None
                },
                error_code: result.error_kind.map(|k| k.error_code().to_string()),
                error_message: result.error_message.clone(),
                duration_ms: Some(result.duration_ms),
            },
            None => ToolTaskResult {
                call_id: self.call_id.clone(),
                tool_name: self.tool_name.clone(),
                state: self.state,
                result_ready: false,
                output: None,
                error_code: None,
                error_message: self.note.clone(),
                duration_ms: self.duration_ms(),
            },
        }
    }

    fn record(&self) -> ToolBackgroundRecord {
        let (output, error_code, error_message) = match &self.result {
            Some(result) => (
                if result.is_ok() {
                    Some((*result.output).clone())
                } else {
                    None
                },
                result.error_kind.map(|k| k.error_code().to_string()),
                result.error_message.clone(),
            ),
            None => (None, None, self.note.clone()),
        };
        ToolBackgroundRecord {
            call_id: self.call_id.clone(),
            session_id: self.session_id.clone(),
            run_id: self.run_id.clone(),
            tool_name: self.tool_name.clone(),
            state: self.state,
            output,
            error_code,
            error_message,
            duration_ms: self.duration_ms(),
            queued_at_ms: self.queued_at_ms,
            started_at_ms: self.started_at_ms,
            settled_at_ms: self.settled_at_ms,
        }
    }
}

/// 落盘记录 → 状态快照（内存条目已淘汰时的回查形态）
fn status_from_record(record: &ToolBackgroundRecord) -> ToolTaskStatus {
    ToolTaskStatus {
        call_id: record.call_id.clone(),
        tool_name: record.tool_name.clone(),
        state: record.state,
        queued_at_ms: record.queued_at_ms,
        started_at_ms: record.started_at_ms,
        settled_at_ms: record.settled_at_ms,
        duration_ms: record.duration_ms,
    }
}

/// 落盘记录 → 结果视图
fn result_from_record(record: &ToolBackgroundRecord) -> ToolTaskResult {
    let ready = matches!(
        record.state,
        ToolTaskState::SettledOk | ToolTaskState::SettledErr
    );
    ToolTaskResult {
        call_id: record.call_id.clone(),
        tool_name: record.tool_name.clone(),
        state: record.state,
        result_ready: ready,
        output: record.output.clone(),
        error_code: record.error_code.clone(),
        error_message: record.error_message.clone(),
        duration_ms: record.duration_ms,
    }
}

#[derive(Default)]
struct RegistryInner {
    entries: HashMap<String, Entry>,
    /// Queued 条目的 callId（登记序）
    queue: VecDeque<String>,
    /// 终态条目的 callId（落定序，留存淘汰用）
    settled_order: VecDeque<String>,
    running_total: usize,
    running_by_session: HashMap<String, usize>,
}

impl RegistryInner {
    fn inc_running(&mut self, session_id: &str) {
        self.running_total += 1;
        *self
            .running_by_session
            .entry(session_id.to_string())
            .or_insert(0) += 1;
    }

    fn dec_running(&mut self, session_id: &str) {
        self.running_total = self.running_total.saturating_sub(1);
        if let Some(count) = self.running_by_session.get_mut(session_id) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                self.running_by_session.remove(session_id);
            }
        }
    }

    fn session_running(&self, session_id: &str) -> usize {
        self.running_by_session
            .get(session_id)
            .copied()
            .unwrap_or(0)
    }

    /// 准入扫描：按登记序把可获槽的排队条目提升为 Running。
    /// 会话已满的条目跳过继续扫描（不让单个会话堵住全局队列）；
    /// 获槽时刻即计时起点（started_at = now_ms）。
    /// 返回新获槽的 callId 列表（调用方负责落盘其记录）。
    fn admit(&mut self, now_ms: u64) -> Vec<String> {
        let mut admitted = Vec::new();
        while self.running_total < MAX_RUNNING_GLOBAL {
            let pos = self.queue.iter().position(|call_id| {
                self.entries
                    .get(call_id)
                    .map(|e| self.session_running(&e.session_id) < MAX_RUNNING_PER_SESSION)
                    .unwrap_or(false)
            });
            let Some(pos) = pos else { break };
            let call_id = self.queue.remove(pos).expect("position 已定位");
            let entry = self.entries.get_mut(&call_id).expect("队列条目必在表中");
            entry.state = ToolTaskState::Running;
            entry.started_at_ms = Some(now_ms);
            let session_id = entry.session_id.clone();
            self.inc_running(&session_id);
            admitted.push(call_id);
        }
        admitted
    }

    /// 把条目带入终态的公共收口：状态/时刻/留痕写入、计数回落、
    /// 留存登记。调用方须已判定迁移合法（先落定者胜在各入口判定）。
    fn bring_terminal(
        &mut self,
        call_id: &str,
        state: ToolTaskState,
        now_ms: u64,
        note: Option<String>,
    ) {
        let was_running = {
            let entry = self.entries.get_mut(call_id).expect("条目必在表中");
            let was_running = entry.state == ToolTaskState::Running;
            if entry.state == ToolTaskState::Queued {
                self.queue.retain(|id| id != call_id);
            }
            entry.state = state;
            entry.settled_at_ms = Some(now_ms);
            if note.is_some() {
                entry.note = note;
            }
            was_running
        };
        if was_running {
            let session_id = self.entries[call_id].session_id.clone();
            self.dec_running(&session_id);
        }
        self.settled_order.push_back(call_id.to_string());
        self.evict_settled();
    }

    /// 终态留存有界淘汰（淘汰条目的查询经落盘回查，不丢数据）
    fn evict_settled(&mut self) {
        while self.settled_order.len() > MAX_SETTLED_RETAINED {
            let Some(oldest) = self.settled_order.pop_front() else {
                break;
            };
            self.entries.remove(&oldest);
        }
    }
}

/// 通用后台执行注册表（进程级共享，线程安全）
///
/// 锁纪律：内部状态以 std Mutex 守护短临界区；落盘 IO 在锁外执行
/// （先在锁内收集待写记录、释放锁后逐条 put，失败只记日志——进程内
/// 状态是实时权威，落盘是恢复层，不让存储故障反噬执行语义）。
pub struct ToolBackgroundRegistry {
    store: Arc<dyn ToolBackgroundStore>,
    inner: Mutex<RegistryInner>,
    /// 状态变更广播（wait_admitted 的唤醒源；变更后 notify_waiters）
    changed: Notify,
}

impl std::fmt::Debug for ToolBackgroundRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let counts = self.counts();
        f.debug_struct("ToolBackgroundRegistry")
            .field("running_total", &counts.running_total)
            .field("queued_total", &counts.queued_total)
            .field("retained_settled", &counts.retained_settled)
            .finish()
    }
}

impl ToolBackgroundRegistry {
    /// 以落盘存储构造空注册表（装配点：引擎启动时建单例注入）
    pub fn new(store: Arc<dyn ToolBackgroundStore>) -> Self {
        Self {
            store,
            inner: Mutex::new(RegistryInner::default()),
            changed: Notify::new(),
        }
    }

    fn persist(&self, record: &ToolBackgroundRecord) {
        if let Err(e) = self.store.put_record(record) {
            tracing::warn!(
                call_id = %record.call_id,
                error = %e,
                "工具后台记录落盘失败（进程内状态不受影响，冷启动恢复可能缺失此条）"
            );
        }
    }

    fn persist_all(&self, records: &[ToolBackgroundRecord]) {
        for record in records {
            self.persist(record);
        }
    }

    /// 登记一个后台任务（幂等）：同 callId 已存在时返回既有条目、
    /// 不重复登记。登记后立即尝试准入：有槽位 → Running（计时
    /// 起点 = 此刻），无槽位 → Queued 排队（不计时）。
    pub fn register(&self, req: NewToolBackgroundTask) -> Registration {
        let mut records = Vec::new();
        let (outcome, status) = {
            let mut inner = self.inner.lock().unwrap();
            if let Some(existing) = inner.entries.get(&req.call_id) {
                (
                    RegisterOutcome::AlreadyExists,
                    existing.snapshot(req.now_ms),
                )
            } else {
                let entry = Entry {
                    call_id: req.call_id.clone(),
                    session_id: req.session_id.clone(),
                    run_id: req.run_id.clone(),
                    tool_name: req.tool_name.clone(),
                    args_digest: req.args_digest.clone(),
                    state: ToolTaskState::Queued,
                    token: AbortToken::child_of(&req.parent_token),
                    handle: None,
                    result: None,
                    note: None,
                    queued_at_ms: req.now_ms,
                    started_at_ms: None,
                    settled_at_ms: None,
                    write_claim: req.write_claim,
                };
                inner.queue.push_back(req.call_id.clone());
                inner.entries.insert(req.call_id.clone(), entry);
                records.push(inner.entries[&req.call_id].record());
                let admitted = inner.admit(req.now_ms);
                let was_admitted = admitted.iter().any(|id| id == &req.call_id);
                for call_id in &admitted {
                    records.push(inner.entries[call_id].record());
                }
                let status = inner.entries[&req.call_id].snapshot(req.now_ms);
                (
                    if was_admitted {
                        RegisterOutcome::Admitted
                    } else {
                        RegisterOutcome::Queued
                    },
                    status,
                )
            }
        };
        self.persist_all(&records);
        self.changed.notify_waiters();
        Registration { outcome, status }
    }

    /// 在途去重查询：同 (session, tool, 入参摘要) 已有未落定条目时
    /// 返回其 callId（BG2 据此返回同一占位、不重复执行）
    pub fn find_inflight(
        &self,
        session_id: &str,
        tool_name: &str,
        args_digest: &str,
    ) -> Option<String> {
        let inner = self.inner.lock().unwrap();
        inner
            .entries
            .values()
            .find(|e| {
                !e.is_terminal()
                    && e.session_id == session_id
                    && e.tool_name == tool_name
                    && e.args_digest == args_digest
            })
            .map(|e| e.call_id.clone())
    }

    /// 条目的独立子令牌（执行侧与之竞速/自查中止；条目不存在或
    /// 已终态时返回 None——终态条目的令牌不再有消费方）
    pub fn entry_token(&self, call_id: &str) -> Option<AbortToken> {
        let inner = self.inner.lock().unwrap();
        inner
            .entries
            .get(call_id)
            .filter(|e| !e.is_terminal())
            .map(|e| e.token.clone())
    }

    /// 挂入执行包装任务句柄（BG2 在 spawn 后调用；仅 Running 且
    /// 尚未挂入时生效）。取消条目时注册表 abort 此句柄。挂入被拒
    /// 时句柄被直接丢弃（其任务随之被运行时 abort）——调用方应
    /// 只对刚获槽的条目挂入，避免误杀。
    pub fn attach_handle(&self, call_id: &str, handle: JoinHandle<()>) -> bool {
        let mut inner = self.inner.lock().unwrap();
        match inner.entries.get_mut(call_id) {
            Some(entry) if entry.state == ToolTaskState::Running && entry.handle.is_none() => {
                entry.handle = Some(handle);
                true
            }
            _ => false,
        }
    }

    /// 等待条目获槽（Queued → Running）。条目在获槽前进入终态
    /// （如排队中被取消）或不存在时返回 false。
    pub async fn wait_admitted(&self, call_id: &str) -> bool {
        loop {
            // 先登记通知再复查状态（对齐 AbortToken::wait_aborted 的
            // enable-then-check 口径，不丢唤醒）
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let inner = self.inner.lock().unwrap();
                match inner.entries.get(call_id) {
                    None => return false,
                    Some(entry) => match entry.state {
                        ToolTaskState::Running => return true,
                        ToolTaskState::Queued => {}
                        _ => return false,
                    },
                }
            }
            notified.await;
        }
    }

    /// 执行落定（BG2 的包装任务在执行完成后调用）：Running →
    /// SettledOk / SettledErr（按结果成败），落盘全量结果，释放的
    /// 槽位随即按序准入排队条目。非 Running（已取消/已落定/不
    /// 存在）返回 false——终态先落定者胜。
    pub fn settle(&self, call_id: &str, result: ClassifiedToolResult, now_ms: u64) -> bool {
        let mut records = Vec::new();
        let settled = {
            let mut inner = self.inner.lock().unwrap();
            let is_running = matches!(
                inner.entries.get(call_id),
                Some(e) if e.state == ToolTaskState::Running
            );
            if !is_running {
                false
            } else {
                let state = if result.is_ok() {
                    ToolTaskState::SettledOk
                } else {
                    ToolTaskState::SettledErr
                };
                inner.bring_terminal(call_id, state, now_ms, None);
                if let Some(entry) = inner.entries.get_mut(call_id) {
                    entry.result = Some(result);
                }
                records.push(inner.entries[call_id].record());
                for admitted in inner.admit(now_ms) {
                    records.push(inner.entries[&admitted].record());
                }
                true
            }
        };
        if settled {
            self.persist_all(&records);
            self.changed.notify_waiters();
        }
        settled
    }

    /// 取消一个条目：Queued → 直接取消（永不启动）；Running →
    /// 触发条目子令牌 + abort 执行句柄，本条目以 Cancelled 收口
    /// （包装任务此后即使完成，其 settle 也会被拒）。终态/不存
    /// 在返回 false。
    pub fn cancel(&self, call_id: &str, now_ms: u64) -> bool {
        let mut records = Vec::new();
        let cancelled = {
            let mut inner = self.inner.lock().unwrap();
            let actionable = matches!(
                inner.entries.get(call_id),
                Some(e) if !e.is_terminal()
            );
            if !actionable {
                false
            } else {
                if let Some(entry) = inner.entries.get_mut(call_id) {
                    entry.token.abort();
                    if let Some(handle) = entry.handle.take() {
                        handle.abort();
                    }
                }
                inner.bring_terminal(
                    call_id,
                    ToolTaskState::Cancelled,
                    now_ms,
                    Some(CANCELLED_NOTE.to_string()),
                );
                records.push(inner.entries[call_id].record());
                for admitted in inner.admit(now_ms) {
                    records.push(inner.entries[&admitted].record());
                }
                true
            }
        };
        if cancelled {
            self.persist_all(&records);
            self.changed.notify_waiters();
        }
        cancelled
    }

    /// 按 run 批量取消（用户停止 run 的级联取消接线点，BG3 消费）：
    /// 取消该 run 发起的全部未落定条目，返回被取消的 callId 列表。
    pub fn cancel_run(&self, run_id: &str, now_ms: u64) -> Vec<String> {
        let targets: Vec<String> = {
            let inner = self.inner.lock().unwrap();
            inner
                .entries
                .values()
                .filter(|e| !e.is_terminal() && e.run_id.as_deref() == Some(run_id))
                .map(|e| e.call_id.clone())
                .collect()
        };
        targets
            .into_iter()
            .filter(|call_id| self.cancel(call_id, now_ms))
            .collect()
    }

    /// 把条目合成 OutcomeUnknown（冷启动合成在新进程走落盘路径，
    /// 本入口供「句柄丢失等进程内异常」把在途条目诚实收口）：
    /// Queued/Running → OutcomeUnknown，释放槽位并落盘。
    pub fn mark_outcome_unknown(&self, call_id: &str, now_ms: u64) -> bool {
        let mut records = Vec::new();
        let marked = {
            let mut inner = self.inner.lock().unwrap();
            let actionable = matches!(
                inner.entries.get(call_id),
                Some(e) if !e.is_terminal()
            );
            if !actionable {
                false
            } else {
                if let Some(entry) = inner.entries.get_mut(call_id) {
                    entry.token.abort();
                    if let Some(handle) = entry.handle.take() {
                        handle.abort();
                    }
                }
                inner.bring_terminal(
                    call_id,
                    ToolTaskState::OutcomeUnknown,
                    now_ms,
                    Some(OUTCOME_UNKNOWN_NOTE.to_string()),
                );
                records.push(inner.entries[call_id].record());
                for admitted in inner.admit(now_ms) {
                    records.push(inner.entries[&admitted].record());
                }
                true
            }
        };
        if marked {
            self.persist_all(&records);
            self.changed.notify_waiters();
        }
        marked
    }

    /// 会话关闭/删除收口：取消该会话全部未落定条目（令牌与句柄
    /// 一并中止），移除该会话全部进程内条目，并清除其落盘记录。
    /// 返回被取消（未落定）的 callId 列表，供调用方留痕。
    pub fn close_session(&self, session_id: &str, now_ms: u64) -> Vec<String> {
        let mut records = Vec::new();
        let cancelled = {
            let mut inner = self.inner.lock().unwrap();
            let session_entries: Vec<(String, ToolTaskState)> = inner
                .entries
                .values()
                .filter(|e| e.session_id == session_id)
                .map(|e| (e.call_id.clone(), e.state))
                .collect();
            let mut cancelled = Vec::new();
            for (call_id, state) in &session_entries {
                if !state.is_terminal() {
                    cancelled.push(call_id.clone());
                }
                if *state == ToolTaskState::Running {
                    inner.dec_running(session_id);
                }
                if let Some(entry) = inner.entries.get_mut(call_id) {
                    entry.token.abort();
                    if let Some(handle) = entry.handle.take() {
                        handle.abort();
                    }
                }
            }
            let ids: std::collections::HashSet<&str> =
                session_entries.iter().map(|(id, _)| id.as_str()).collect();
            inner.queue.retain(|id| !ids.contains(id.as_str()));
            inner.settled_order.retain(|id| !ids.contains(id.as_str()));
            for (call_id, _) in &session_entries {
                inner.entries.remove(call_id);
            }
            // 本会话 Running 条目移除释放了全局槽位：按序准入其他
            // 会话的排队条目（获槽时刻 = now_ms）
            for admitted in inner.admit(now_ms) {
                records.push(inner.entries[&admitted].record());
            }
            cancelled
        };
        self.persist_all(&records);
        if let Err(e) = self.store.remove_session(session_id) {
            tracing::warn!(
                session_id = %session_id,
                error = %e,
                "会话关闭时清除工具后台落盘记录失败"
            );
        }
        self.changed.notify_waiters();
        cancelled
    }

    /// 状态查询（进程内优先，淘汰后经落盘回查）
    pub fn status(&self, call_id: &str, now_ms: u64) -> Option<ToolTaskStatus> {
        {
            let inner = self.inner.lock().unwrap();
            if let Some(entry) = inner.entries.get(call_id) {
                return Some(entry.snapshot(now_ms));
            }
        }
        match self.store.get_record(call_id) {
            Ok(record) => record.map(|r| status_from_record(&r)),
            Err(e) => {
                tracing::warn!(call_id = %call_id, error = %e, "工具后台记录回查失败");
                None
            }
        }
    }

    /// 结果查询（进程内优先，淘汰后经落盘回查）
    pub fn result(&self, call_id: &str) -> Option<ToolTaskResult> {
        {
            let inner = self.inner.lock().unwrap();
            if let Some(entry) = inner.entries.get(call_id) {
                return Some(entry.result_view());
            }
        }
        match self.store.get_record(call_id) {
            Ok(record) => record.map(|r| result_from_record(&r)),
            Err(e) => {
                tracing::warn!(call_id = %call_id, error = %e, "工具后台记录回查失败");
                None
            }
        }
    }

    /// 计数快照（验收与监控口径）
    pub fn counts(&self) -> ToolBackgroundCounts {
        let inner = self.inner.lock().unwrap();
        ToolBackgroundCounts {
            running_total: inner.running_total,
            queued_total: inner.queue.len(),
            retained_settled: inner.settled_order.len(),
        }
    }

    /// 指定会话的运行中计数
    pub fn running_in_session(&self, session_id: &str) -> usize {
        let inner = self.inner.lock().unwrap();
        inner.session_running(session_id)
    }

    /// 指定会话的未落定条目快照（BG5 UI 指示数据源）：Queued / Running
    /// 条目按登记序返回（状态快照口径同 [Self::status]）；终态条目不入
    /// ——其呈现由 settled 回注驱动，不在指示面重复表达。
    pub fn session_snapshot(&self, session_id: &str, now_ms: u64) -> Vec<ToolTaskStatus> {
        let inner = self.inner.lock().unwrap();
        let mut out: Vec<ToolTaskStatus> = inner
            .entries
            .values()
            .filter(|e| e.session_id == session_id && !e.is_terminal())
            .map(|e| e.snapshot(now_ms))
            .collect();
        out.sort_by_key(|s| s.queued_at_ms);
        out
    }

    /// 落盘侧未落定记录（冷启动合成原料，BG3 消费：新进程的注册表
    /// 是空的，未落定清单只能来自落盘层）
    pub fn persisted_unsettled(
        &self,
        session_id: &str,
    ) -> Result<Vec<ToolBackgroundRecord>, super::store::ToolBackgroundStoreError> {
        self.store.list_unsettled(session_id)
    }

    /// 条目身份摘要（进程内条目；BG3 宿主在 settle / wait_admitted
    /// 发射点取 session/tool 归属用——状态快照不带 session_id）
    pub fn entry_summary(&self, call_id: &str) -> Option<ToolBackgroundCallSummary> {
        let inner = self.inner.lock().unwrap();
        inner.entries.get(call_id).map(|e| ToolBackgroundCallSummary {
            session_id: e.session_id.clone(),
            call_id: e.call_id.clone(),
            tool_name: e.tool_name.clone(),
        })
    }

    /// 指定 run 的全部未落定条目摘要（BG3 cancel_run_and_notify 在
    /// 批量取消**之前**取证——取消后条目虽留存，仍以迁移前快照为准）
    pub fn unsettled_summaries_for_run(
        &self,
        run_id: &str,
    ) -> Vec<ToolBackgroundCallSummary> {
        let inner = self.inner.lock().unwrap();
        inner
            .entries
            .values()
            .filter(|e| !e.is_terminal() && e.run_id.as_deref() == Some(run_id))
            .map(|e| ToolBackgroundCallSummary {
                session_id: e.session_id.clone(),
                call_id: e.call_id.clone(),
                tool_name: e.tool_name.clone(),
            })
            .collect()
    }

    /// 指定会话的全部未落定条目摘要（BG3 close_session_and_notify
    /// 在会话收口**之前**取证——close_session 会移除条目并清除落盘
    /// 记录，事后无从查起）
    pub fn unsettled_summaries_for_session(
        &self,
        session_id: &str,
    ) -> Vec<ToolBackgroundCallSummary> {
        let inner = self.inner.lock().unwrap();
        inner
            .entries
            .values()
            .filter(|e| !e.is_terminal() && e.session_id == session_id)
            .map(|e| ToolBackgroundCallSummary {
                session_id: e.session_id.clone(),
                call_id: e.call_id.clone(),
                tool_name: e.tool_name.clone(),
            })
            .collect()
    }

    /// 冷启动合成（BG3）：把指定会话落盘侧的未落定记录逐条合成
    /// OutcomeUnknown 终态并写回落盘层，返回合成后的终态记录
    /// （供调用方逐条发射 tool-settled(outcome-unknown) + tool-wake）。
    ///
    /// 机制说明：新进程的注册表内存为空，[Self::mark_outcome_unknown]
    /// 只作用于进程内条目、对落盘-only 记录无能为力——本方法是其
    /// 落盘对应物（可观察语义一致：终态 OutcomeUnknown + 同一留痕
    /// 文案 + settled_at 落定时刻）；同进程内尚有活条目的记录
    /// （句柄丢失等进程内异常路径）则改走 mark_outcome_unknown 原路。
    pub fn synthesize_outcome_unknown(
        &self,
        session_id: &str,
        now_ms: u64,
    ) -> Vec<ToolBackgroundRecord> {
        let unsettled = match self.persisted_unsettled(session_id) {
            Ok(records) => records,
            Err(e) => {
                tracing::warn!(
                    session_id = %session_id,
                    error = %e,
                    "冷启动合成读取未落定记录失败（跳过本会话）"
                );
                return Vec::new();
            }
        };
        let mut synthesized = Vec::new();
        for mut record in unsettled {
            let has_live_entry = {
                let inner = self.inner.lock().unwrap();
                inner.entries.contains_key(&record.call_id)
            };
            if has_live_entry {
                if self.mark_outcome_unknown(&record.call_id, now_ms) {
                    match self.store.get_record(&record.call_id) {
                        Ok(Some(fresh)) => synthesized.push(fresh),
                        _ => {
                            tracing::warn!(
                                call_id = %record.call_id,
                                "冷启动合成后回读终态记录失败（事件发射跳过）"
                            );
                        }
                    }
                }
                continue;
            }
            record.state = ToolTaskState::OutcomeUnknown;
            record.output = None;
            record.error_code = None;
            record.error_message = Some(OUTCOME_UNKNOWN_NOTE.to_string());
            record.settled_at_ms = Some(now_ms);
            if record.duration_ms.is_none() {
                record.duration_ms = record
                    .started_at_ms
                    .map(|start| now_ms.saturating_sub(start));
            }
            match self.store.put_record(&record) {
                Ok(()) => synthesized.push(record),
                Err(e) => {
                    tracing::warn!(
                        call_id = %record.call_id,
                        error = %e,
                        "冷启动合成写回终态记录失败（事件发射跳过）"
                    );
                }
            }
        }
        synthesized
    }
}

#[async_trait]
impl ToolBackgroundQuery for ToolBackgroundRegistry {
    async fn status(&self, call_id: &str) -> Option<ToolTaskStatus> {
        // 展示口径：运行中任务的已运行时长以真实时钟计算
        ToolBackgroundRegistry::status(self, call_id, conex_shared::time::now_millis())
    }

    async fn result(&self, call_id: &str) -> Option<ToolTaskResult> {
        ToolBackgroundRegistry::result(self, call_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool_background::store::InMemoryToolBackgroundStore;
    use serde_json::json;
    use session_loop::tool_events::ToolErrorKind;

    fn registry() -> (ToolBackgroundRegistry, Arc<InMemoryToolBackgroundStore>) {
        let store = Arc::new(InMemoryToolBackgroundStore::new());
        (ToolBackgroundRegistry::new(store.clone()), store)
    }

    fn req(call_id: &str, session_id: &str, now_ms: u64) -> NewToolBackgroundTask {
        NewToolBackgroundTask {
            call_id: call_id.to_string(),
            session_id: session_id.to_string(),
            run_id: Some("run-1".to_string()),
            tool_name: "web_search".to_string(),
            args_digest: format!("digest-{call_id}"),
            parent_token: AbortToken::new(),
            now_ms,
            write_claim: None,
        }
    }

    fn ok_result(call_id: &str) -> ClassifiedToolResult {
        ClassifiedToolResult::ok(call_id, "web_search", json!({ "hits": 3 }), 25_000)
    }

    fn err_result(call_id: &str) -> ClassifiedToolResult {
        ClassifiedToolResult::error(
            call_id,
            "web_search",
            ToolErrorKind::ExecutionFailed,
            "网络不可达",
            3_000,
        )
    }

    /// 状态机主干：登记即准入 → 落定（成功/失败两路）+ 终态不可逆
    #[test]
    fn register_admits_and_settle_terminal_is_final() {
        let (reg, _store) = registry();
        let r = reg.register(req("c1", "s1", 1_000));
        assert_eq!(r.outcome, RegisterOutcome::Admitted);
        assert_eq!(r.status.state, ToolTaskState::Running);
        assert_eq!(r.status.started_at_ms, Some(1_000));

        assert!(reg.settle("c1", err_result("c1"), 4_000));
        let status = reg.status("c1", 5_000).unwrap();
        assert_eq!(status.state, ToolTaskState::SettledErr);
        assert_eq!(status.settled_at_ms, Some(4_000));

        let view = reg.result("c1").unwrap();
        assert!(view.result_ready);
        assert_eq!(view.error_code.as_deref(), Some("tool.execution_failed"));
        assert_eq!(view.error_message.as_deref(), Some("网络不可达"));
        assert_eq!(view.duration_ms, Some(3_000));

        // 先落定者胜：二次 settle / 落定后 cancel 均被拒
        assert!(!reg.settle("c1", ok_result("c1"), 6_000));
        assert!(!reg.cancel("c1", 6_000));
        assert_eq!(
            reg.status("c1", 6_000).unwrap().state,
            ToolTaskState::SettledErr
        );
    }

    /// 成功落定：结果视图给出全量输出与执行器实测耗时
    #[test]
    fn settle_ok_result_view() {
        let (reg, _store) = registry();
        reg.register(req("c1", "s1", 0));
        assert!(reg.settle("c1", ok_result("c1"), 26_000));
        let view = reg.result("c1").unwrap();
        assert_eq!(view.state, ToolTaskState::SettledOk);
        assert!(view.result_ready);
        assert_eq!(view.output, Some(json!({ "hits": 3 })));
        assert_eq!(view.duration_ms, Some(25_000));
        assert!(view.error_code.is_none());
    }

    /// 未落定的结果查询：诚实报未就绪，不伪造结果
    #[test]
    fn result_of_running_is_not_ready() {
        let (reg, _store) = registry();
        reg.register(req("c1", "s1", 0));
        let view = reg.result("c1").unwrap();
        assert_eq!(view.state, ToolTaskState::Running);
        assert!(!view.result_ready);
        assert!(view.output.is_none());
    }

    /// 幂等：同 callId 重复登记返回既有条目，计数与内容不被覆盖
    #[test]
    fn duplicate_register_is_idempotent() {
        let (reg, _store) = registry();
        let first = reg.register(req("c1", "s1", 100));
        assert_eq!(first.outcome, RegisterOutcome::Admitted);

        let mut again = req("c1", "s1", 200);
        again.tool_name = "other_tool".to_string();
        let second = reg.register(again);
        assert_eq!(second.outcome, RegisterOutcome::AlreadyExists);
        assert_eq!(second.status.tool_name, "web_search");
        assert_eq!(second.status.queued_at_ms, 100);
        assert_eq!(reg.counts().running_total, 1);
    }

    /// 会话容量：同会话第 5 个排队、不计时；有条目落定后按序获槽，
    /// 获槽时刻才是它的计时起点
    #[test]
    fn per_session_cap_queues_fifth_until_slot_frees() {
        let (reg, _store) = registry();
        for i in 1..=4 {
            let r = reg.register(req(&format!("c{i}"), "s1", 1_000));
            assert_eq!(r.outcome, RegisterOutcome::Admitted);
        }
        let fifth = reg.register(req("c5", "s1", 2_000));
        assert_eq!(fifth.outcome, RegisterOutcome::Queued);
        assert_eq!(fifth.status.state, ToolTaskState::Queued);
        assert_eq!(fifth.status.started_at_ms, None, "排队不计时");
        assert_eq!(reg.counts().queued_total, 1);
        assert_eq!(reg.running_in_session("s1"), 4);

        // 其他会话不受本会话满额影响
        let other = reg.register(req("x1", "s2", 2_000));
        assert_eq!(other.outcome, RegisterOutcome::Admitted);

        // c1 落定 → c5 在落定时刻获槽
        assert!(reg.settle("c1", ok_result("c1"), 9_000));
        let status = reg.status("c5", 9_500).unwrap();
        assert_eq!(status.state, ToolTaskState::Running);
        assert_eq!(status.started_at_ms, Some(9_000));
        assert_eq!(reg.counts().queued_total, 0);
    }

    /// 全局容量：4 会话 × 4 = 16 满额后第 17 个排队；任一落定即准入
    #[test]
    fn global_cap_queues_seventeenth() {
        let (reg, _store) = registry();
        for s in 1..=4 {
            for i in 1..=4 {
                let r = reg.register(req(&format!("s{s}c{i}"), &format!("s{s}"), 0));
                assert_eq!(r.outcome, RegisterOutcome::Admitted);
            }
        }
        assert_eq!(reg.counts().running_total, 16);
        let extra = reg.register(req("extra", "s5", 0));
        assert_eq!(extra.outcome, RegisterOutcome::Queued);

        assert!(reg.settle("s2c3", ok_result("s2c3"), 100));
        assert_eq!(
            reg.status("extra", 100).unwrap().state,
            ToolTaskState::Running
        );
        assert_eq!(reg.counts().running_total, 16);
    }

    /// 准入公平性：会话满额的排队条目不堵住其他会话的排队条目
    #[test]
    fn admission_skips_session_full_entries() {
        let (reg, _store) = registry();
        for i in 1..=4 {
            reg.register(req(&format!("a{i}"), "sa", 0));
            reg.register(req(&format!("b{i}"), "sb", 0));
        }
        // a5 先排队（sa 已满），b5 后排队（sb 已满）
        assert_eq!(
            reg.register(req("a5", "sa", 0)).outcome,
            RegisterOutcome::Queued
        );
        assert_eq!(
            reg.register(req("b5", "sb", 0)).outcome,
            RegisterOutcome::Queued
        );
        // sb 落定一个 → 跳过仍被 sa 满额挡住的 a5，先准入 b5
        assert!(reg.settle("b1", ok_result("b1"), 50));
        assert_eq!(reg.status("b5", 50).unwrap().state, ToolTaskState::Running);
        assert_eq!(reg.status("a5", 50).unwrap().state, ToolTaskState::Queued);
    }

    /// 取消传播：排队条目取消后永不获槽；运行条目取消触发其子令牌
    /// 并释放槽位给排队者；父令牌中止同样传到条目子令牌（级联面）
    #[test]
    fn cancel_propagates_and_frees_slot() {
        let (reg, _store) = registry();
        for i in 1..=4 {
            reg.register(req(&format!("c{i}"), "s1", 0));
        }
        reg.register(req("c5", "s1", 0));
        reg.register(req("c6", "s1", 0));

        // 排队中的 c5 被取消：后续落定准入的是 c6 而不是 c5
        assert!(reg.cancel("c5", 10));
        assert_eq!(
            reg.status("c5", 10).unwrap().state,
            ToolTaskState::Cancelled
        );
        assert!(reg.settle("c1", ok_result("c1"), 20));
        assert_eq!(reg.status("c6", 20).unwrap().state, ToolTaskState::Running);
        assert_eq!(
            reg.status("c5", 20).unwrap().state,
            ToolTaskState::Cancelled
        );

        // 运行中的 c6：取消触发其独立子令牌
        let token = reg.entry_token("c6").unwrap();
        assert!(!token.is_aborted());
        assert!(reg.cancel("c6", 30));
        assert!(token.is_aborted(), "取消必须触发条目子令牌");
        assert_eq!(
            reg.status("c6", 30).unwrap().state,
            ToolTaskState::Cancelled
        );
        // 已终态：令牌不再外借、重复取消被拒、迟到 settle 被拒
        assert!(reg.entry_token("c6").is_none());
        assert!(!reg.cancel("c6", 40));
        assert!(!reg.settle("c6", ok_result("c6"), 40));

        // 父令牌级联：以父令牌登记的条目，父中止后子令牌视为已中止
        let parent = AbortToken::new();
        let mut child_req = req("c7", "s1", 50);
        child_req.parent_token = parent.clone();
        reg.register(child_req);
        let child_token = reg.entry_token("c7").unwrap();
        parent.abort();
        assert!(child_token.is_aborted(), "run 中止应经令牌树级联到条目");
    }

    /// 取消运行条目会 abort 已挂入的执行句柄
    #[tokio::test]
    async fn cancel_aborts_attached_handle() {
        let (reg, _store) = registry();
        reg.register(req("c1", "s1", 0));
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let handle = tokio::spawn(async move {
            // 永不自行完成（模拟长执行）；被 abort 时 future 被丢弃，
            // tx 随之 drop，rx 收到 Err
            let _tx = tx;
            std::future::pending::<()>().await;
        });
        assert!(reg.attach_handle("c1", handle));
        assert!(reg.cancel("c1", 10));
        // 句柄被 abort → 任务被丢弃 → oneshot 发送端 drop
        assert!(rx.await.is_err(), "执行句柄应被 abort");
    }

    /// attach_handle 只对 Running 且未挂入的条目生效
    #[tokio::test]
    async fn attach_handle_guards_state() {
        let (reg, _store) = registry();
        for i in 1..=4 {
            reg.register(req(&format!("c{i}"), "s1", 0));
        }
        reg.register(req("c5", "s1", 0)); // Queued
        let h1 = tokio::spawn(async {});
        assert!(!reg.attach_handle("c5", h1), "排队条目不可挂句柄");
        let h2 = tokio::spawn(async {});
        assert!(reg.attach_handle("c1", h2));
        let h3 = tokio::spawn(async {});
        assert!(!reg.attach_handle("c1", h3), "重复挂入被拒");
        assert!(!reg.attach_handle("missing", tokio::spawn(async {})));
    }

    /// wait_admitted：排队条目在槽位释放后被唤醒；排队中被取消返回 false
    #[tokio::test]
    async fn wait_admitted_wakes_on_free_slot_and_fails_on_cancel() {
        let (reg, _store) = registry();
        let reg = Arc::new(reg);
        for i in 1..=4 {
            reg.register(req(&format!("c{i}"), "s1", 0));
        }
        reg.register(req("c5", "s1", 0));
        reg.register(req("c6", "s1", 0));

        let waiter = {
            let reg = reg.clone();
            tokio::spawn(async move { reg.wait_admitted("c5").await })
        };
        let cancelled_waiter = {
            let reg = reg.clone();
            tokio::spawn(async move { reg.wait_admitted("c6").await })
        };
        tokio::task::yield_now().await;

        assert!(reg.cancel("c6", 10));
        assert!(reg.settle("c1", ok_result("c1"), 20));

        let admitted = tokio::time::timeout(std::time::Duration::from_secs(2), waiter)
            .await
            .expect("等待者应被唤醒")
            .unwrap();
        assert!(admitted);
        let cancelled = tokio::time::timeout(std::time::Duration::from_secs(2), cancelled_waiter)
            .await
            .expect("被取消的等待者应被唤醒")
            .unwrap();
        assert!(!cancelled);
        // 不存在的条目立即 false
        assert!(!reg.wait_admitted("missing").await);
    }

    /// 无时长上限契约：注册表没有任何按时长收口的路径——以极大
    /// 时间戳推进后条目仍 Running；落定走显式 settle 才终结
    #[test]
    fn no_duration_cap_long_task_survives() {
        let (reg, _store) = registry();
        reg.register(req("long", "s1", 1_000));
        let far_future = 1_000 + 365 * 24 * 3600 * 1000; // 一年后
        let status = reg.status("long", far_future).unwrap();
        assert_eq!(status.state, ToolTaskState::Running);
        assert_eq!(status.duration_ms, Some(365 * 24 * 3600 * 1000));
        assert_eq!(reg.counts().running_total, 1);
        // 只有显式落定能终结它
        assert!(reg.settle("long", ok_result("long"), far_future + 1));
        assert_eq!(
            reg.status("long", far_future + 2).unwrap().state,
            ToolTaskState::SettledOk
        );
    }

    /// 落盘与回查：终态条目被内存淘汰后，status/result 经落盘层
    /// 仍可查；落盘层也留有该会话的完整终态记录
    #[test]
    fn settled_entries_evicted_from_memory_fall_back_to_store() {
        let (reg, store) = registry();
        let total = MAX_SETTLED_RETAINED + 4;
        for i in 0..total {
            let call_id = format!("c{i}");
            reg.register(req(&call_id, "s1", i as u64));
            assert!(reg.settle(&call_id, ok_result(&call_id), i as u64 + 1));
        }
        assert_eq!(reg.counts().retained_settled, MAX_SETTLED_RETAINED);
        // 最早落定的 c0 已被内存淘汰，但落盘回查仍在
        let status = reg.status("c0", 999_999).unwrap();
        assert_eq!(status.state, ToolTaskState::SettledOk);
        let view = reg.result("c0").unwrap();
        assert!(view.result_ready);
        assert_eq!(view.output, Some(json!({ "hits": 3 })));
        // 落盘层记录齐全
        let persisted = store.get_record("c0").unwrap().unwrap();
        assert_eq!(persisted.state, ToolTaskState::SettledOk);
        // 在途落盘清单：全部已落定 → 空
        assert!(reg.persisted_unsettled("s1").unwrap().is_empty());
    }

    /// 在途去重：同 (session, tool, digest) 命中既有条目；落定后失效
    #[test]
    fn find_inflight_dedups_until_terminal() {
        let (reg, _store) = registry();
        let mut r = req("c1", "s1", 0);
        r.args_digest = "same-digest".to_string();
        reg.register(r);
        assert_eq!(
            reg.find_inflight("s1", "web_search", "same-digest"),
            Some("c1".to_string())
        );
        assert_eq!(reg.find_inflight("s1", "web_search", "other"), None);
        assert_eq!(reg.find_inflight("s2", "web_search", "same-digest"), None);
        assert!(reg.settle("c1", ok_result("c1"), 10));
        assert_eq!(reg.find_inflight("s1", "web_search", "same-digest"), None);
    }

    /// 会话关闭：在途条目取消（令牌触发）、全部条目与落盘清除、
    /// 他会话不受影响
    #[test]
    fn close_session_cancels_and_clears() {
        let (reg, store) = registry();
        reg.register(req("run1", "s1", 0));
        reg.register(req("done1", "s1", 0));
        assert!(reg.settle("done1", ok_result("done1"), 10));
        reg.register(req("other", "s2", 0));
        let token = reg.entry_token("run1").unwrap();

        let cancelled = reg.close_session("s1", 100);
        assert_eq!(cancelled, vec!["run1".to_string()]);
        assert!(token.is_aborted(), "会话关闭应中止在途条目令牌");
        // 进程内与落盘都查不到 s1 的条目
        assert!(reg.status("run1", 100).is_none());
        assert!(reg.status("done1", 100).is_none());
        assert!(store.get_record("run1").unwrap().is_none());
        assert!(reg.persisted_unsettled("s1").unwrap().is_empty());
        // 他会话完好
        assert_eq!(
            reg.status("other", 100).unwrap().state,
            ToolTaskState::Running
        );
        assert_eq!(reg.counts().running_total, 1);
    }

    /// 按 run 级联取消：只取消目标 run 的未落定条目
    #[test]
    fn cancel_run_only_touches_that_run() {
        let (reg, _store) = registry();
        reg.register(req("a1", "s1", 0));
        let mut other_run = req("a2", "s1", 0);
        other_run.run_id = Some("run-2".to_string());
        reg.register(other_run);
        let cancelled = reg.cancel_run("run-1", 10);
        assert_eq!(cancelled, vec!["a1".to_string()]);
        assert_eq!(
            reg.status("a1", 10).unwrap().state,
            ToolTaskState::Cancelled
        );
        assert_eq!(reg.status("a2", 10).unwrap().state, ToolTaskState::Running);
    }

    /// OutcomeUnknown 合成：收口在途条目、释放槽位、终态不可再变
    #[test]
    fn mark_outcome_unknown_settles_and_frees_slot() {
        let (reg, store) = registry();
        for i in 1..=4 {
            reg.register(req(&format!("c{i}"), "s1", 0));
        }
        reg.register(req("c5", "s1", 0));
        assert!(reg.mark_outcome_unknown("c1", 500));
        assert_eq!(
            reg.status("c1", 500).unwrap().state,
            ToolTaskState::OutcomeUnknown
        );
        let view = reg.result("c1").unwrap();
        assert!(!view.result_ready);
        assert!(view.error_message.is_some());
        // 槽位释放 → c5 获槽
        assert_eq!(reg.status("c5", 500).unwrap().state, ToolTaskState::Running);
        // 落盘为终态（冷启动清单不再含它）
        assert!(store.get_record("c1").unwrap().unwrap().is_terminal());
        assert!(!reg.mark_outcome_unknown("c1", 600));
    }

    /// 会话快照（BG5）：只含本会话未落定条目、按登记序；终态与
    /// 他会话条目不入；Running 条目的耗时随 now_ms 推进。
    #[test]
    fn session_snapshot_lists_only_inflight_of_session_in_order() {
        let (reg, _store) = registry();
        reg.register(req("c1", "s1", 1_000));
        reg.register(req("c2", "s1", 2_000));
        reg.register(req("c3", "s2", 1_500));
        assert!(reg.settle("c2", ok_result("c2"), 3_000));

        let snap = reg.session_snapshot("s1", 6_000);
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].call_id, "c1");
        assert_eq!(snap[0].state, ToolTaskState::Running);
        assert_eq!(snap[0].duration_ms, Some(5_000));

        let snap2 = reg.session_snapshot("s2", 6_000);
        assert_eq!(snap2.len(), 1);
        assert_eq!(snap2[0].call_id, "c3");

        assert!(reg.session_snapshot("s-none", 6_000).is_empty());

        // 取消后即出快照
        assert!(reg.cancel("c1", 7_000));
        assert!(reg.session_snapshot("s1", 7_000).is_empty());
    }
}
