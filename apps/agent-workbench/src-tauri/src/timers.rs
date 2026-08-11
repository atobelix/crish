//! 定时器注册表（G5/G6 引擎面；T-CF-06 / T-CF-07，REQ-C01/C02）
//!
//! 职责（02-CF 方案 §4.3）：
//! - [TimerRegistry]：注册 / 取消 / 活跃列表 / 重启恢复 / 早退钩子；
//!   到期经 [PendingSink]（PendingMessageQueue 适配）注入 steering 条目，
//!   不直接持有 ControlBus——唤醒走 steering 面而非事件面（§4.7 分工）；
//! - 冲突约束（REQ-C02 / T-CF-07）：`Task(sender)` 条件与 early_exit 表
//!   联动，同一 sender 只允许一个活跃定时器；`Any` 条件不参与冲突表；
//! - 持久化：经 [TimerStore] 适配 conex-db session_meta `timer_*` 键。
//!
//! 冻结契约对齐（§4.1 / §4.2 / §4.7）：
//! - `TimerCondition` / `TimerHandle` / `TimerDeclaration` 来自
//!   conex-types（T-CF-04 产物），`TimerDeclaration::remaining_ms` 辅助
//!   方法由该任务卡实现；
//! - `TimerChannel` / `TimerError` 来自 agent-tools set_timer.rs
//!   （T-CF-05 产物）；
//! - `AgentEvent::TimerFired` / `AgentEvent::TimerCancelled` 事件变体来自
//!   conex-types events.rs（T-CF-04 产物），本文件经内部形状 [TimerEvent]
//!   与 [AgentEventSink] 单点映射，避免散落依赖事件面细节。
//!
//! 装配（engine.rs `EngineHandle::new`）：
//! - pending sink = [QueuePendingSink]（真实 PendingMessageQueue）；
//! - event sink = [AgentEventSink]（缓冲 + 日志；事件面接线 = engine.rs
//!   `forward_drained_timer_events` 周期 drain 转发到 EventBridge，
//!   main.rs drain 任务装配在批 3，30 方案 §4）；
//! - store = [MemoryTimerStore]（conex-db 真适配需要 db 句柄，R-CF3
//!   装配收口接线；session_meta 无前缀枚举接口，真适配需配套
//!   `timer_ids` 索引键——本文件已按 `timer_<id>` 键形状实现内存版）。
//!
//! 早退旁路点（T-CF-07 §3）：orchestrator `EventQueue::push` 与 Tauri
//! 侧事件收口均不在本文件域；钩子以 [TimerRegistry::on_event] 提供，
//! 事件面接线点在 R-CF3 落地（当前由单元测试覆盖语义）。

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use agent_tools::tools::set_timer::{TimerChannel, TimerError};
use async_trait::async_trait;
use conex_db::LocalDb;
use conex_types::events::AgentEvent;
use conex_types::timer::{TimerCondition, TimerDeclaration, TimerHandle};
use orchestrator::steering_queue::SteeringInputEntry;
use orchestrator::PendingMessageQueue;

/// 定时器 id 前缀（`timer-<seq>`，命名风格对齐 `task-<seq>` 先例）
const TIMER_ID_PREFIX: &str = "timer-";
/// 注册时长上限（秒，与工具 schema 一致）
const MAX_DURATION_SECONDS: u64 = 86400;
/// session_meta 持久化键前缀（`timer_<id>` 键）
const SESSION_META_TIMER_KEY_PREFIX: &str = "timer_";
/// 索引键（timer id 列表；conex-db 暂无 session_meta 键扫描 API，
/// 索引键保证可枚举——对齐 workflow_commands.rs:403-406 先例注记）
const SESSION_META_TIMER_INDEX_KEY: &str = "timer_ids";

/// 当前 epoch 毫秒（定时器全域时间基准）
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

/// 从 timer id 解析序号（`timer-<seq>` → `seq`；恢复时推进分配器防撞 id）
fn timer_seq(timer_id: &str) -> Option<u64> {
    timer_id
        .strip_prefix(TIMER_ID_PREFIX)
        .and_then(|seq| seq.parse::<u64>().ok())
}

/// steering 分组名（group_id = `timer-<id>`，replaceOrEnqueue 去重；
/// 对齐 recovery.rs:371-380 的 build_steering_entry 分组模式）
pub(crate) fn steering_group_id(timer_id: &str) -> String {
    format!("{TIMER_ID_PREFIX}{timer_id}")
}

// ── 适配器契约（§4.3）──────────────────────────────────────────────

/// steering 条目落点（PendingMessageQueue 适配；到期 / 早退通知共用）
pub(crate) trait PendingSink: Send + Sync {
    /// 写入一条 steering 条目（group_id = timer-<id>，replaceOrEnqueue 去重；
    /// is_steering 受保护位，容量挤占时优先保留）
    fn enqueue_steering(&self, timer_id: &str, text: String, enqueued_at_ms: u64);
}

/// 事件发射点（EventQueue 适配；TimerFired=Critical / TimerCancelled=Soft
/// 的分级由适配器承载，本层只描述内部形状）
pub(crate) trait EventSink: Send + Sync {
    /// 发射定时器事件
    fn emit(&self, event: TimerEvent);
}

/// session_meta 持久化适配（conex-db `timer_*` 键读写）
pub(crate) trait TimerStore: Send + Sync {
    /// 读取全部声明（重启恢复扫描用）
    fn load_all(&self) -> Vec<TimerDeclaration>;
    /// 保存声明（幂等 upsert）
    fn save(&self, declaration: &TimerDeclaration);
}

/// 定时器内部事件形状（适配器单点映射为 AgentEvent 的
/// TimerFired / TimerCancelled，§4.7 冻结字段）
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TimerEvent {
    /// 到期（Critical 必达落库：timerId / prompt / firedAtMs）
    Fired {
        timer_id: String,
        prompt: String,
        fired_at_ms: u64,
    },
    /// 取消（Soft 尽力投递：timerId / reason / cancelledAtMs）
    Cancelled {
        timer_id: String,
        reason: TimerCancelReason,
        cancelled_at_ms: u64,
    },
}

/// 取消原因（wire 值 kebab-case：`cancelled` / `early-exit`）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TimerCancelReason {
    /// 显式取消（cancel 工具 / AI 主动取消）
    Cancelled,
    /// 早退命中（sender 终态消息触发的条件取消）
    EarlyExit,
}

impl TimerCancelReason {
    /// wire 名（kebab-case，与 §4.7 reason 字段一致）
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::EarlyExit => "early-exit",
        }
    }
}

// ── 生产适配器 ─────────────────────────────────────────────────────

/// PendingMessageQueue 适配（steering 条目构造 + replaceOrEnqueue 去重）
#[derive(Clone)]
pub(crate) struct QueuePendingSink {
    /// 底层跨 run steering 队列（EngineHandle 持有，R-CF3 续 run 消费）
    queue: Arc<Mutex<PendingMessageQueue>>,
}

impl QueuePendingSink {
    /// 新建适配（queue 由装配方持有同一实例）
    pub(crate) fn new(queue: Arc<Mutex<PendingMessageQueue>>) -> Self {
        Self { queue }
    }
}

impl PendingSink for QueuePendingSink {
    fn enqueue_steering(&self, timer_id: &str, text: String, enqueued_at_ms: u64) {
        let entry = SteeringInputEntry {
            // 条目 id 带时间戳保证同组替换后仍唯一（对齐 recovery 模式）
            id: format!("{timer_id}-{enqueued_at_ms}"),
            text,
            attachments: Vec::new(),
            enqueued_at: enqueued_at_ms,
            group_id: Some(steering_group_id(timer_id)),
            is_steering: true,
        };
        let mut queue = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        queue.replace_or_enqueue(entry);
    }
}

/// AgentEvent 适配事件槽（TimerEvent → AgentEvent 单点映射；
/// 缓冲 + 日志，事件面经 engine.rs `forward_drained_timer_events`
/// 周期 drain 转发到 EventBridge（P4，30 方案 §4）——本层不直接
/// 依赖事件桥，转发由引擎装配面持有，缓冲供测试断言与调试观测）
pub(crate) struct AgentEventSink {
    /// 已发射事件缓冲（drain 转发 / 测试断言）
    buffered: Mutex<Vec<AgentEvent>>,
}

impl AgentEventSink {
    /// 新建事件槽
    pub(crate) fn new() -> Self {
        Self {
            buffered: Mutex::new(Vec::new()),
        }
    }

    /// 取走缓冲事件（drain 转发 helper（engine.rs）与测试断言消费；
    /// Vec::take 语义，空缓冲返回空集；生产消费方 = main.rs drain
    /// 任务（批 3 装配轮已接线，500ms tick 经 engine.rs
    /// [crate::engine::forward_drained_timer_events] 转发））
    pub(crate) fn drain(&self) -> Vec<AgentEvent> {
        std::mem::take(&mut *self.buffered.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

impl EventSink for AgentEventSink {
    fn emit(&self, event: TimerEvent) {
        let agent_event = match event {
            TimerEvent::Fired {
                timer_id,
                prompt,
                fired_at_ms,
            } => AgentEvent::TimerFired {
                // 注册表每引擎一个、无会话归属，sessionId 置空串；
                // 会话归属语义在 R-CF3 定时器会话化时定稿（§4.7 注）
                session_id: String::new(),
                timer_id,
                prompt,
                fired_at_ms,
            },
            TimerEvent::Cancelled {
                timer_id,
                reason,
                cancelled_at_ms,
            } => AgentEvent::TimerCancelled {
                session_id: String::new(),
                timer_id,
                reason: reason.as_str().to_string(),
                cancelled_at_ms,
            },
        };
        tracing::debug!(
            target: "timers",
            event = agent_event.type_name(),
            "定时器事件已发射（缓冲；drain 转发 P4 接线）"
        );
        self.buffered
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(agent_event);
    }
}

/// 内存持久化适配（测试 + 引擎默认装配；conex-db session_meta 真适配
/// 在 R-CF3 接线——键形状已冻结为 `timer_<id>`）
#[derive(Default)]
pub(crate) struct MemoryTimerStore {
    /// timer_<id> → TimerDeclaration JSON
    map: Mutex<HashMap<String, String>>,
}

impl MemoryTimerStore {
    /// 共享实例（重启恢复测试中两个注册表共用同一存储）
    pub(crate) fn shared() -> Arc<Self> {
        Arc::new(Self::default())
    }
}

/// 持久化键（`timer_` 前缀 + timer id）
fn store_key(timer_id: &str) -> String {
    format!("{SESSION_META_TIMER_KEY_PREFIX}{timer_id}")
}

impl TimerStore for MemoryTimerStore {
    fn load_all(&self) -> Vec<TimerDeclaration> {
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter_map(|json| serde_json::from_str(json).ok())
            .collect()
    }

    fn save(&self, declaration: &TimerDeclaration) {
        if let Ok(json) = serde_json::to_string(declaration) {
            self.map
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(store_key(&declaration.timer_id), json);
        }
    }
}

/// LocalDb session_meta 真适配（键 `timer_<id>` + 索引 `timer_ids`；
/// 照抄 workflow_commands.rs:400-478 先例）。
///
/// 注：conex-db 当前仅有 get/set_session_meta（无键扫描 / 删除 API），
/// 故以 `timer_ids` 索引键承载可枚举性；本域无 remove 面——fire 后标
/// fired=true 落库即终态（timers.rs:704-707），索引只增不摘（D6 §3.1）。
#[derive(Clone)]
pub(crate) struct LocalDbTimerStore {
    db: LocalDb,
}

impl LocalDbTimerStore {
    /// 新建真适配（db 由装配点提供；轮 2 装配替换时注入）
    pub(crate) fn new(db: LocalDb) -> Self {
        Self { db }
    }
}

impl TimerStore for LocalDbTimerStore {
    fn load_all(&self) -> Vec<TimerDeclaration> {
        // 读 timer_ids 索引 → 逐键 get_session_meta(store_key(id))
        // → serde_json 宽容解析（坏 JSON 跳过，fail-open 对齐
        // MemoryTimerStore::load_all 的 filter_map 语义 timers.rs:253-260）
        let index: Vec<String> = self
            .db
            .get_session_meta(SESSION_META_TIMER_INDEX_KEY)
            .ok()
            .flatten()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default();
        index
            .into_iter()
            .filter_map(|timer_id| {
                self.db
                    .get_session_meta(&store_key(&timer_id))
                    .ok()
                    .flatten()
                    .and_then(|json| serde_json::from_str(&json).ok())
            })
            .collect()
    }

    fn save(&self, declaration: &TimerDeclaration) {
        // upsert 键值 + 索引幂等追加（对齐 workflow_commands.rs:439-457）
        if let Ok(json) = serde_json::to_string(declaration) {
            let _ = self.db.set_session_meta(&store_key(&declaration.timer_id), &json);
        }
        let mut index: Vec<String> = self
            .db
            .get_session_meta(SESSION_META_TIMER_INDEX_KEY)
            .ok()
            .flatten()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default();
        if !index.iter().any(|id| id == &declaration.timer_id) {
            index.push(declaration.timer_id.clone());
            if let Ok(json) = serde_json::to_string(&index) {
                let _ = self.db.set_session_meta(SESSION_META_TIMER_INDEX_KEY, &json);
            }
        }
    }
}

// ── TimerRegistry（§4.3）───────────────────────────────────────────

/// 活跃定时器条目（timers 表值）
struct TimerEntry {
    /// 持久化声明（fired / cancelled 状态位）
    declaration: TimerDeclaration,
    /// 到期触发任务（cancel 经 abort 取消）
    task: tokio::task::JoinHandle<()>,
}

/// 定时器注册表（每引擎一个；到期经 PendingMessageQueue 注入，
/// 不直接持有 ControlBus）
pub(crate) struct TimerRegistry {
    /// timer_id → 活跃条目（Arc 供到期任务克隆，任务不自引用注册表）
    timers: Arc<Mutex<HashMap<String, TimerEntry>>>,
    /// sender(task-id/agent-id) → timer_id（Task 条件早退映射；
    /// Any 条件不参与冲突表）
    early_exit: Arc<Mutex<HashMap<String, String>>>,
    /// steering 条目落点（PendingMessageQueue 适配）
    pending: Arc<dyn PendingSink>,
    /// timer-fired / timer-cancelled 事件发射点（EventQueue 适配）
    events: Arc<dyn EventSink>,
    /// session_meta timer_* 键读写（conex-db 适配）
    store: Arc<dyn TimerStore>,
    /// timer-<seq> 原子计数
    seq: AtomicU64,
    /// 全域时间基准（epoch 毫秒；生产 = [now_ms]，测试 = AtomicU64 驱动，
    /// 对齐 watchdog.rs 时钟注入模式——到期判定 / 事件时间戳统一走注入
    /// 基准，消除「注入时钟与 Instant 真实时钟混用」）
    now: Arc<dyn Fn() -> u64 + Send + Sync>,
}

impl TimerRegistry {
    /// 新建注册表（适配器由装配方注入；时间基准 = 生产实时钟 [now_ms]）
    pub(crate) fn new(
        pending: Arc<dyn PendingSink>,
        events: Arc<dyn EventSink>,
        store: Arc<dyn TimerStore>,
    ) -> Self {
        Self::with_clock(pending, events, store, Arc::new(now_ms))
    }

    /// 新建注册表并注入自定义时间基准（测试面注入 Arc 驱动的
    /// 可推进时钟；生产路径经 [Self::new] 委托本方法走默认实时钟，
    /// 生产 / 测试共用同一实现）
    pub(crate) fn with_clock(
        pending: Arc<dyn PendingSink>,
        events: Arc<dyn EventSink>,
        store: Arc<dyn TimerStore>,
        now: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> Self {
        Self {
            timers: Arc::new(Mutex::new(HashMap::new())),
            early_exit: Arc::new(Mutex::new(HashMap::new())),
            pending,
            events,
            store,
            seq: AtomicU64::new(0),
            now,
        }
    }

    /// 注册一次性定时器（后台静默运行，不阻塞调用方）。
    ///
    /// 流程（T-CF-06 §1）：校验 durationSeconds（1~86400）→ 冲突约束
    /// （T-CF-07 §1）→ 构造 handle + 声明 → 落 session_meta `timer_*` 键
    /// → 登记 early_exit 映射（Task 条件）→ spawn 到期任务 → 返回 handle。
    pub(crate) async fn register(
        &self,
        duration_seconds: u64,
        prompt: String,
        condition: TimerCondition,
    ) -> Result<TimerHandle, TimerError> {
        // 1. 时长校验（1~86400，与工具 schema 上限一致）
        if duration_seconds == 0 || duration_seconds > MAX_DURATION_SECONDS {
            return Err(TimerError::InvalidDuration);
        }
        // 2. 冲突约束（REQ-C02 / T-CF-07）：Task(sender) 且 early_exit
        //    已存在该 sender 的活跃定时器 → 结构化 Conflict；
        //    Any 条件不参与冲突表（多定时器共享 any 语义无歧义）
        if let TimerCondition::Task(sender) = &condition {
            if let Some(existing) = self
                .early_exit
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(sender)
                .cloned()
            {
                return Err(TimerError::Conflict(format!(
                    "sender {sender} 已存在活跃定时器 {existing}，请先取消或等待其到期"
                )));
            }
        }
        // 3. id 分配与时间基准
        let seq = self.seq.fetch_add(1, Ordering::SeqCst);
        let timer_id = format!("{TIMER_ID_PREFIX}{seq}");
        let now = (self.now)();
        let expires_at_ms = now.saturating_add(duration_seconds * 1000);
        let handle = TimerHandle {
            timer_id: timer_id.clone(),
            expires_at_ms,
            duration_seconds,
            prompt: prompt.clone(),
            condition: condition.clone(),
        };
        // 4. 落库（session_meta `timer_<id>` 键；重启恢复数据源）
        let declaration = TimerDeclaration {
            timer_id: timer_id.clone(),
            created_at_ms: now,
            expires_at_ms,
            prompt: prompt.clone(),
            condition: condition.clone(),
            fired: false,
            cancelled: false,
        };
        self.store.save(&declaration);
        // 5. early_exit 登记（Task 条件；早退查表与冲突查表共用）
        if let TimerCondition::Task(sender) = &condition {
            self.early_exit
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(sender.clone(), timer_id.clone());
        }
        // 6. spawn 到期任务（sleep_until；cancel 经 abort 取消）
        let task = self.spawn_fire_task(declaration.clone());
        self.timers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(timer_id.clone(), TimerEntry { declaration, task });
        tracing::info!(
            target: "timers",
            timer_id = %timer_id,
            expires_at_ms,
            condition = ?condition,
            "定时器已注册"
        );
        Ok(handle)
    }

    /// 显式取消（早退命中或 AI 主动取消）；不存在返回 IdNotFound。
    ///
    /// 流程（T-CF-06 §3）：abort 到期任务 → 声明标 cancelled=true 落库 →
    /// 发射 TimerCancelled（Soft，reason=cancelled）。
    pub(crate) async fn cancel(&self, timer_id: &str) -> Result<bool, TimerError> {
        match self.take_entry(timer_id) {
            None => Err(TimerError::IdNotFound),
            Some(entry) => {
                entry.task.abort();
                let mut declaration = entry.declaration;
                declaration.cancelled = true;
                self.store.save(&declaration);
                self.events.emit(TimerEvent::Cancelled {
                    timer_id: timer_id.to_string(),
                    reason: TimerCancelReason::Cancelled,
                    cancelled_at_ms: (self.now)(),
                });
                tracing::info!(target: "timers", timer_id, "定时器已显式取消");
                Ok(true)
            }
        }
    }

    /// 活跃定时器列表（未到期未取消；idle 待命续 run 判定用）
    pub(crate) async fn list_active(&self) -> Vec<TimerHandle> {
        let timers = self.timers.lock().unwrap_or_else(|e| e.into_inner());
        timers
            .values()
            .filter(|e| !e.declaration.fired && !e.declaration.cancelled)
            .map(|e| TimerHandle {
                timer_id: e.declaration.timer_id.clone(),
                expires_at_ms: e.declaration.expires_at_ms,
                duration_seconds: e
                    .declaration
                    .expires_at_ms
                    .saturating_sub(e.declaration.created_at_ms)
                    / 1000,
                prompt: e.declaration.prompt.clone(),
                condition: e.declaration.condition.clone(),
            })
            .collect()
    }

    /// 重启恢复（T-CF-06 §4）：扫描已持久化声明，
    /// - fired=false && cancelled=false 且未到期 → 按 remaining_ms 重建
    ///   sleep（重登记 early_exit 映射）；
    /// - 已到期未注入 → 补发到期流程（防丢）。
    pub(crate) async fn restore(&self) {
        let now = (self.now)();
        for declaration in self.store.load_all() {
            // 已终态（fired / cancelled）声明跳过——防重启重复注入
            if declaration.fired || declaration.cancelled {
                continue;
            }
            // 序号推进（恢复的 id 防新注册撞号）
            if let Some(seq) = timer_seq(&declaration.timer_id) {
                self.seq.fetch_max(seq + 1, Ordering::SeqCst);
            }
            if declaration.expires_at_ms <= now {
                // 已到期未注入 → 补发（重启窗口期间到期的定时器）
                tracing::info!(
                    target: "timers",
                    timer_id = %declaration.timer_id,
                    "重启恢复：已到期未注入，补发到期流程"
                );
                fire_timer(
                    &self.timers,
                    &self.early_exit,
                    &self.pending,
                    &self.events,
                    &self.store,
                    &self.now,
                    &declaration,
                );
                continue;
            }
            // 未到期 → 重建 sleep（remaining_ms 由 T-CF-04 辅助方法提供）
            let remaining = declaration.remaining_ms(now);
            let handle = TimerHandle {
                timer_id: declaration.timer_id.clone(),
                expires_at_ms: declaration.expires_at_ms,
                duration_seconds: declaration
                    .expires_at_ms
                    .saturating_sub(declaration.created_at_ms)
                    / 1000,
                prompt: declaration.prompt.clone(),
                condition: declaration.condition.clone(),
            };
            let task = self.spawn_fire_task(declaration.clone());
            // Task 条件重登记 early_exit 映射（早退语义跨重启保持）
            if let TimerCondition::Task(sender) = &declaration.condition {
                self.early_exit
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(sender.clone(), declaration.timer_id.clone());
            }
            self.timers
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(declaration.timer_id.clone(), TimerEntry { declaration, task });
            tracing::info!(
                target: "timers",
                timer_id = %handle.timer_id,
                remaining_ms = remaining,
                "重启恢复：未到期定时器已重建 sleep"
            );
        }
    }

    /// 早退钩子（T-CF-07 §3）：事件面旁路点的判定入口——命中
    /// early_exit 表（Task 条件）或活跃 Any 定时器 → 取消 + 通知。
    ///
    /// 注意：本方法当前由测试面直接驱动；orchestrator `EventQueue::push`
    /// 与 Tauri 事件收口的旁路接线在 R-CF3 落地。
    #[allow(dead_code)] // R-CF3：事件收口接线后移除
    pub(crate) async fn on_event(&self, event: &AgentEvent) {
        // 自产事件（timer-fired / timer-cancelled）不参与早退判定——
        // 事件体带 timer_id 字段天然可识别；定时器事件不是「外部消息」
        // （T-CF-07 §2；timer_any_ignores_own_fire 测试覆盖）
        if matches!(
            event,
            AgentEvent::TimerFired { .. } | AgentEvent::TimerCancelled { .. }
        ) {
            return;
        }
        let senders = event_sender_ids(event);
        if senders.is_empty() {
            return;
        }
        let now = (self.now)();
        // Task 条件：early_exit 表精确命中（sender → timer_id）。
        // 注意：remove 的锁守卫必须提前释放再进取消流程——std Mutex
        // 不可重入，cancel_early_exit 内部会再次锁 early_exit（清表项），
        // 守卫活过 if-let 体即自锁死锁
        for sender in &senders {
            let timer_id = {
                let mut map = self.early_exit.lock().unwrap_or_else(|e| e.into_inner());
                map.remove(sender)
            };
            if let Some(timer_id) = timer_id {
                self.cancel_early_exit(&timer_id, sender, now);
            }
        }
        // Any 条件：全表扫描活跃 Any 定时器（Any 不参与冲突表，无映射
        // 可查，须扫描；命中全部取消）
        let any_hits: Vec<String> = {
            let timers = self.timers.lock().unwrap_or_else(|e| e.into_inner());
            timers
                .iter()
                .filter(|(_, e)| {
                    matches!(e.declaration.condition, TimerCondition::Any)
                        && !e.declaration.fired
                        && !e.declaration.cancelled
                })
                .map(|(id, _)| id.clone())
                .collect()
        };
        for timer_id in any_hits {
            let sender = senders.first().cloned().unwrap_or_default();
            self.cancel_early_exit(&timer_id, &sender, now);
        }
    }

    /// 早退取消（T-CF-07 §3/§4）：abort sleep + 标 cancelled 落库 +
    /// 发射 TimerCancelled(reason=early-exit) + 注入 steering 通知
    /// （「定时器 <id> 已因 <sender> 完成而取消」；同 group 替换防重复唤醒）
    fn cancel_early_exit(&self, timer_id: &str, sender: &str, cancelled_at_ms: u64) {
        let Some(entry) = self.take_entry(timer_id) else {
            // 已被并发取消/到期 → 幂等跳过
            return;
        };
        entry.task.abort();
        let mut declaration = entry.declaration;
        declaration.cancelled = true;
        self.store.save(&declaration);
        self.events.emit(TimerEvent::Cancelled {
            timer_id: timer_id.to_string(),
            reason: TimerCancelReason::EarlyExit,
            cancelled_at_ms,
        });
        self.pending.enqueue_steering(
            timer_id,
            format!("定时器 {timer_id} 已因 {sender} 完成而取消"),
            cancelled_at_ms,
        );
        tracing::info!(
            target: "timers",
            timer_id,
            sender,
            "早退命中：定时器已取消并注入通知"
        );
    }

    /// 从 timers 表移除并清理 early_exit 映射（取消/早退/到期的公共收口）
    fn take_entry(&self, timer_id: &str) -> Option<TimerEntry> {
        let entry = self
            .timers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(timer_id)?;
        clear_early_exit(&self.early_exit, timer_id);
        Some(entry)
    }

    /// 到期触发任务：10ms 粒度轮询时间基准，`now() >= expires_at_ms`
    /// 即 fire（同步 fire + catch_unwind 兜底，记日志不炸引擎——tokio
    /// 任务 panic 由 JoinError 捕获，双保险）。
    ///
    /// 轮询取代单次 sleep_until：统一生产 / 测试一条路径（注入时钟下
    /// sleep_until 按 Instant 真实时钟等待会与注入时钟失配），生产最小
    /// 注册时长 1s，10ms 抖动语义等价；cancel 仍经 abort 取消。
    ///
    /// 任务克隆注册表的组件 Arc（timers / early_exit / pending / events /
    /// store / now），不自引用注册表本体——避免「注册表 → 条目 → 任务 →
    /// 注册表」的循环引用。
    fn spawn_fire_task(&self, declaration: TimerDeclaration) -> tokio::task::JoinHandle<()> {
        let timers = Arc::clone(&self.timers);
        let early_exit = Arc::clone(&self.early_exit);
        let pending = Arc::clone(&self.pending);
        let events = Arc::clone(&self.events);
        let store = Arc::clone(&self.store);
        let now = Arc::clone(&self.now);
        let expires_at_ms = declaration.expires_at_ms;
        tokio::spawn(async move {
            // 10ms 粒度轮询：now() >= expires_at_ms 即 fire（interval 首拍
            // 立即检查——未到期不 fire，随后每 10ms 一检）
            let mut interval = tokio::time::interval(Duration::from_millis(10));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            while now() < expires_at_ms {
                interval.tick().await;
            }
            let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| {
                fire_timer(&timers, &early_exit, &pending, &events, &store, &now, &declaration);
            }));
            if let Err(panic) = outcome {
                tracing::error!(
                    target: "timers",
                    timer_id = %declaration.timer_id,
                    panic = %panic_message(panic.as_ref()),
                    "定时器到期任务 panic（已兜底，不炸引擎）"
                );
            }
        })
    }
}

/// 到期触发（同步执行；spawn 任务内运行，panic 由 catch_unwind 兜底）：
/// 发射 TimerFired（Critical）→ steering 条目（group_id = timer-<id>，
/// replaceOrEnqueue 去重）→ 声明标 fired=true 落库。
///
/// 幂等：终态声明直接跳过（防重启重复注入）；timers 表移除与取消/早退
/// 竞态互斥——同步段无 await，先取锁者生效，后到者取 None 跳过。
fn fire_timer(
    timers: &Arc<Mutex<HashMap<String, TimerEntry>>>,
    early_exit: &Arc<Mutex<HashMap<String, String>>>,
    pending: &Arc<dyn PendingSink>,
    events: &Arc<dyn EventSink>,
    store: &Arc<dyn TimerStore>,
    now: &Arc<dyn Fn() -> u64 + Send + Sync>,
    declaration: &TimerDeclaration,
) {
    // 幂等守卫：终态声明不注入（防重启重复注入）
    if declaration.fired || declaration.cancelled {
        return;
    }
    // 移除活跃条目（与取消/早退竞态互斥：先取锁者生效；后到者取 None
    // 幂等跳过）
    if timers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&declaration.timer_id)
        .is_none()
    {
        return;
    }
    clear_early_exit(early_exit, &declaration.timer_id);
    let fired_at_ms = now();
    // 1. 事件（Critical 数据面落库；适配器接线见头部注记）
    events.emit(TimerEvent::Fired {
        timer_id: declaration.timer_id.clone(),
        prompt: declaration.prompt.clone(),
        fired_at_ms,
    });
    // 2. steering 条目（唤醒面；text 含 prompt——唤醒摘要标准化
    //    由 T-CF-12 负责，此处按 §4.8 定时器到期模板落形）
    pending.enqueue_steering(
        &declaration.timer_id,
        format!(
            "{}（定时器 {} 已到期）",
            declaration.prompt, declaration.timer_id
        ),
        fired_at_ms,
    );
    // 3. 声明标 fired 落库（重启后避免重复注入）
    let mut fired = declaration.clone();
    fired.fired = true;
    store.save(&fired);
    tracing::info!(
        target: "timers",
        timer_id = %declaration.timer_id,
        "定时器已到期，steering 条目已注入"
    );
}

/// 清理指向该定时器的全部 early_exit 映射（sender → timer_id 逆查）
fn clear_early_exit(early_exit: &Arc<Mutex<HashMap<String, String>>>, timer_id: &str) {
    early_exit
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|_, tid| tid != timer_id);
}

impl std::fmt::Debug for TimerRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TimerRegistry")
            .field("seq", &self.seq.load(Ordering::SeqCst))
            .finish_non_exhaustive()
    }
}

/// TimerChannel 契约实现（T-CF-05 冻结签名；经 BuiltinToolConfig
/// timer_channel 注入 set_timer / cancel_timer 工具）
#[async_trait]
impl TimerChannel for TimerRegistry {
    async fn register(
        &self,
        duration_seconds: u64,
        prompt: String,
        condition: TimerCondition,
    ) -> Result<TimerHandle, TimerError> {
        TimerRegistry::register(self, duration_seconds, prompt, condition).await
    }

    async fn cancel(&self, timer_id: &str) -> Result<bool, TimerError> {
        TimerRegistry::cancel(self, timer_id).await
    }

    async fn list_active(&self) -> Result<Vec<TimerHandle>, TimerError> {
        Ok(TimerRegistry::list_active(self).await)
    }
}

/// sender 归一化（T-CF-07 §2）：事件 → 可能的 sender 列表。
///
/// 覆盖：SubagentEnded.subagent_id、RunTerminal.run_id（含 agent-id
/// 同义复用）；定时器自产事件返回空（内部事件不参与早退）。注入类消息
/// （subagent_inject_message 的 id 语义）在 Tauri 事件收口无独立事件
/// 变体，R-CF3 接线时扩展。
fn event_sender_ids(event: &AgentEvent) -> Vec<String> {
    match event {
        AgentEvent::SubagentEnded { subagent_id, .. } => vec![subagent_id.clone()],
        AgentEvent::RunTerminal { run_id, .. } => vec![run_id.clone()],
        _ => Vec::new(),
    }
}

/// panic 载荷 → 人读文本（日志兜底用）
fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(text) = payload.downcast_ref::<&str>() {
        return (*text).to_string();
    }
    if let Some(text) = payload.downcast_ref::<String>() {
        return text.clone();
    }
    "非字符串 panic 载荷".to_string()
}

// ── 测试 ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试桩：事件发射记录
    #[derive(Default)]
    struct ProbeEvents {
        emitted: Mutex<Vec<TimerEvent>>,
    }

    impl EventSink for ProbeEvents {
        fn emit(&self, event: TimerEvent) {
            self.emitted.lock().unwrap_or_else(|e| e.into_inner()).push(event);
        }
    }

    /// 构造测试注册表（真实 QueuePendingSink 落点 + mock 事件 + 共享
    /// 内存 store + 注入时钟）。时钟初始 1_000_000（对齐 watchdog.rs
    /// 测试时钟同值）；返回队列句柄与时钟句柄供断言 / 推进。
    fn test_registry() -> (
        Arc<TimerRegistry>,
        Arc<Mutex<PendingMessageQueue>>,
        Arc<ProbeEvents>,
        Arc<MemoryTimerStore>,
        Arc<AtomicU64>,
    ) {
        let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        let events = Arc::new(ProbeEvents::default());
        let store = MemoryTimerStore::shared();
        let clock = Arc::new(AtomicU64::new(1_000_000));
        let shared = Arc::clone(&clock);
        let now: Arc<dyn Fn() -> u64 + Send + Sync> =
            Arc::new(move || shared.load(Ordering::Relaxed));
        let registry = Arc::new(TimerRegistry::with_clock(
            Arc::new(QueuePendingSink::new(Arc::clone(&queue))),
            Arc::clone(&events) as Arc<dyn EventSink>,
            Arc::clone(&store) as Arc<dyn TimerStore>,
            now,
        ));
        (registry, queue, events, store, clock)
    }

    /// 消费式队列快照（dequeue_all 取走全部条目；同测试多处断言时
    /// 须分别重新取快照——对齐真实队列 replaceOrEnqueue 语义）
    fn queue_snapshot(queue: &Arc<Mutex<PendingMessageQueue>>) -> Vec<SteeringInputEntry> {
        queue.lock().unwrap_or_else(|e| e.into_inner()).dequeue_all()
    }

    /// 队列当前条目数（非消费；poll_until 轮询条件用）
    fn queue_len(queue: &Arc<Mutex<PendingMessageQueue>>) -> usize {
        queue.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    /// 轮询收口辅助：时钟推进后等待条件成立；真实时间上限 500ms 护栏
    /// （~50×10ms 轮询窗，与到期任务同粒度），超时 panic——防时钟未
    /// 推进时测试悬挂。
    async fn poll_until<F>(mut condition: F)
    where
        F: FnMut() -> bool,
    {
        let deadline = std::time::Instant::now() + Duration::from_millis(500);
        loop {
            if condition() {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "poll_until 超时：条件在 500ms 内未成立（时钟是否已推进越过到期点？）"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// 断言当前早退通知条目存在（group_id = timer-<id>；消费式队列快照）
    fn assert_early_exit_notice(
        queue: &Arc<Mutex<PendingMessageQueue>>,
        timer_id: &str,
        sender: &str,
    ) {
        let entries = queue_snapshot(queue);
        assert!(
            entries.iter().any(|p| {
                p.group_id.as_deref() == Some(steering_group_id(timer_id).as_str())
                    && p.text == format!("定时器 {timer_id} 已因 {sender} 完成而取消")
            }),
            "应存在早退通知条目：{entries:?}"
        );
    }

    /// 子代理结束事件构造（早退测试用）
    fn subagent_ended(subagent_id: &str) -> AgentEvent {
        AgentEvent::SubagentEnded {
            session_id: "ses-test".to_string(),
            subagent_id: subagent_id.to_string(),
            subagent_run_id: format!("run-{subagent_id}"),
            status: conex_types::events::SubagentEndStatus::Completed,
            summary: None,
            ended_at: "2026-08-05T00:00:00.000Z".to_string(),
        }
    }

    // ── T-CF-06：注册 / 到期 / 取消 / 恢复 ─────────────────────────

    /// 到期后 steering 条目（group_id=timer-<id>、text 含 prompt）与
    /// TimerFired 事件均已产出；声明 fired=true 落库。
    #[tokio::test]
    async fn timer_registry_fires_steering_entry() {
        let (registry, queue, events, store, clock) = test_registry();
        let handle = registry
            .register(1, "检查编译结果".to_string(), TimerCondition::Never)
            .await
            .expect("注册应成功");
        assert_eq!(handle.timer_id, "timer-0");
        // 冻结时钟下注册：未推进 → 未到期不发射（确定性，无真实等待）
        assert!(
            queue_snapshot(&queue).is_empty(),
            "未到期不得注入 steering 条目"
        );
        assert!(
            events.emitted.lock().unwrap_or_else(|e| e.into_inner()).is_empty(),
            "未到期不得发射 TimerFired"
        );
        // 推进时钟越过到期点（expires_at = 注册时钟 + 1s）→ 轮询任务
        // fire；poll_until 收口（500ms 真实上限护栏）
        clock.store(clock.load(Ordering::Relaxed) + 2_000, Ordering::Relaxed);
        poll_until(|| queue_len(&queue) == 1).await;
        let entries = queue_snapshot(&queue);
        assert_eq!(entries.len(), 1, "应恰好注入一条 steering 条目");
        assert_eq!(
            entries[0].group_id.as_deref(),
            Some(steering_group_id("timer-0").as_str()),
            "group_id 应为 timer-<id>"
        );
        assert!(
            entries[0].text.contains("检查编译结果"),
            "steering 文本应含 prompt：{}",
            entries[0].text
        );
        // TimerFired 已发射（恰好一条：fired_at_ms 走注入时钟）
        let emitted = events.emitted.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(emitted.len(), 1);
        assert!(matches!(
            emitted[0],
            TimerEvent::Fired { ref timer_id, .. } if timer_id == "timer-0"
        ));
        // 声明 fired=true 落库（重启后避免重复注入）
        let persisted = store.load_all();
        assert_eq!(persisted.len(), 1);
        assert!(persisted[0].fired, "到期声明应标 fired=true");
        assert!(!persisted[0].cancelled);
    }

    /// 注册后立即取消：到期时刻无 steering 条目、声明 cancelled=true、
    /// TimerCancelled(reason=cancelled) 已发射。
    #[tokio::test]
    async fn timer_registry_cancel_stops_fire() {
        let (registry, queue, events, store, clock) = test_registry();
        let handle = registry
            .register(1, "不应到期".to_string(), TimerCondition::Never)
            .await
            .expect("注册应成功");
        let cancelled = registry
            .cancel(&handle.timer_id)
            .await
            .expect("取消应成功");
        assert!(cancelled);
        // 推进时钟越过到期点 + 100ms 收口窗：abort 生效则无到期条目
        // （推进是必须的——防「未 abort 而时钟未到」的假绿）
        clock.store(clock.load(Ordering::Relaxed) + 2_000, Ordering::Relaxed);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            queue_snapshot(&queue).is_empty(),
            "取消后不得有到期条目"
        );
        let emitted = events.emitted.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(emitted.len(), 1);
        assert!(matches!(
            emitted[0],
            TimerEvent::Cancelled { ref timer_id, reason: TimerCancelReason::Cancelled, .. }
                if timer_id == &handle.timer_id
        ));
        let persisted = store.load_all();
        assert_eq!(persisted.len(), 1);
        assert!(persisted[0].cancelled, "取消声明应标 cancelled=true");
        assert!(!persisted[0].fired);
        // 重复取消 → IdNotFound（条目已移除）
        let again = registry.cancel(&handle.timer_id).await;
        assert!(matches!(again, Err(TimerError::IdNotFound)));
    }

    /// 重启恢复：注册 → 重建注册表（共享 store + 共享注入时钟）→
    /// restore → 剩余时间重建轮询且到期恰好注入一次；已到期已注入的
    /// 声明恢复后不重复注入。
    #[tokio::test]
    async fn timer_registry_persists_and_recovers() {
        let store = MemoryTimerStore::shared();
        // 共享注入时钟：重启模拟下时间连续（阶段 A 残留 fire 任务与
        // 阶段 B/C 同基准，均只向自己的探针发射，不互相污染）
        let clock = Arc::new(AtomicU64::new(1_000_000));
        let shared = Arc::clone(&clock);
        let now: Arc<dyn Fn() -> u64 + Send + Sync> =
            Arc::new(move || shared.load(Ordering::Relaxed));
        // 阶段 A（注册后、时钟推进前）：未到期不发射（确定性断言）
        // 探针本地仅块内断言用；残留 fire 任务持有其 Arc，注入不受影响
        let (registry_a, _queue_a, _events_a) = {
            let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
            let events = Arc::new(ProbeEvents::default());
            let registry = Arc::new(TimerRegistry::with_clock(
                Arc::new(QueuePendingSink::new(Arc::clone(&queue))),
                Arc::clone(&events) as Arc<dyn EventSink>,
                Arc::clone(&store) as Arc<dyn TimerStore>,
                Arc::clone(&now),
            ));
            let handle = registry
                .register(1, "重启恢复".to_string(), TimerCondition::Never)
                .await
                .expect("注册应成功");
            assert_eq!(handle.timer_id, "timer-0");
            // 三态断言之一：未到期不发射（时钟冻结下确定性成立）
            assert!(
                queue_snapshot(&queue).is_empty(),
                "阶段 A：未到期不得注入 steering 条目"
            );
            assert!(
                events.emitted.lock().unwrap_or_else(|e| e.into_inner()).is_empty(),
                "阶段 A：未到期不得发射 TimerFired"
            );
            (registry, queue, events)
        };
        drop(registry_a); // 模拟重启（注册表消亡，store 残留；残留 fire
                          // 任务仅向自己的探针发射，不污染阶段 B 断言）
        // 阶段 B：restore 扫描重建 → 推进时钟 → 恰好注入一条
        let (_registry_b, queue_b, events_b) = {
            let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
            let events = Arc::new(ProbeEvents::default());
            let registry = Arc::new(TimerRegistry::with_clock(
                Arc::new(QueuePendingSink::new(Arc::clone(&queue))),
                Arc::clone(&events) as Arc<dyn EventSink>,
                Arc::clone(&store) as Arc<dyn TimerStore>,
                Arc::clone(&now),
            ));
            registry.restore().await;
            (registry, queue, events)
        };
        clock.store(clock.load(Ordering::Relaxed) + 2_000, Ordering::Relaxed);
        poll_until(|| queue_len(&queue_b) == 1).await;
        let entries = queue_snapshot(&queue_b);
        assert_eq!(entries.len(), 1, "恢复后到期应注入恰好一条");
        assert_eq!(
            entries[0].group_id.as_deref(),
            Some(steering_group_id("timer-0").as_str())
        );
        // 三态断言之二：恢复侧恰好一条 TimerFired（残留任务只向
        // events_a 发射，events_b 计数不受污染）
        let emitted_b = events_b.emitted.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(emitted_b.len(), 1, "恢复侧应恰好发射一条 TimerFired");
        assert!(matches!(
            emitted_b[0],
            TimerEvent::Fired { ref timer_id, .. } if timer_id == "timer-0"
        ));
        // 再模拟一次重启：声明已 fired=true → 不得重复注入
        let (_registry_c, queue_c, events_c) = {
            let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
            let events = Arc::new(ProbeEvents::default());
            let registry = Arc::new(TimerRegistry::with_clock(
                Arc::new(QueuePendingSink::new(Arc::clone(&queue))),
                Arc::clone(&events) as Arc<dyn EventSink>,
                Arc::clone(&store) as Arc<dyn TimerStore>,
                Arc::clone(&now),
            ));
            registry.restore().await;
            (registry, queue, events)
        };
        // 三态断言之三：fired=true 不重复注入（短窗收口后断言空）
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            queue_snapshot(&queue_c).is_empty(),
            "fired=true 的声明恢复后不得重复注入"
        );
        assert!(
            events_c.emitted.lock().unwrap_or_else(|e| e.into_inner()).is_empty(),
            "fired=true 的声明恢复后不得重复发射"
        );
    }

    /// 冲突拒绝占位联测（T-CF-07 语义落地后全绿）：
    /// 同 sender 重复注册 → Conflict；取消后再注册 → 成功。
    #[tokio::test]
    async fn timer_registry_conflict_rejected() {
        let (registry, _, _, _, _) = test_registry();
        let first = registry
            .register(1, "第一次".to_string(), TimerCondition::Task("task-42".to_string()))
            .await
            .expect("首次注册应成功");
        let second = registry
            .register(2, "第二次".to_string(), TimerCondition::Task("task-42".to_string()))
            .await;
        assert!(
            matches!(&second, Err(TimerError::Conflict(message)) if message.contains("task-42") && message.contains(&first.timer_id)),
            "同 sender 重复注册应返回 Conflict：{second:?}"
        );
        // 取消后同 sender 再注册成功
        registry
            .cancel(&first.timer_id)
            .await
            .expect("取消应成功");
        let third = registry
            .register(2, "第三次".to_string(), TimerCondition::Task("task-42".to_string()))
            .await;
        assert!(third.is_ok(), "取消后同 sender 应可再注册：{third:?}");
    }

    /// 非法时长拒绝（0 / 超上限 → InvalidDuration）
    #[tokio::test]
    async fn timer_registry_rejects_invalid_duration() {
        let (registry, _, _, _, _) = test_registry();
        for bad in [0u64, 86401] {
            let result = registry
                .register(bad, "非法时长".to_string(), TimerCondition::Never)
                .await;
            assert!(
                matches!(result, Err(TimerError::InvalidDuration)),
                "时长 {bad} 应被拒绝：{result:?}"
            );
        }
        // 上下界合法
        let result = registry
            .register(1, "下界".to_string(), TimerCondition::Never)
            .await;
        assert!(result.is_ok());
        let result = registry
            .register(86400, "上界".to_string(), TimerCondition::Never)
            .await;
        assert!(result.is_ok());
    }

    // ── T-CF-07：早退 + 冲突 ───────────────────────────────────────

    /// Any 条件：注入任意外部消息 → 定时器取消、TimerCancelled
    /// (reason=early-exit) 已发射、早退通知已注入、无到期注入。
    #[tokio::test]
    async fn timer_condition_any_cancels_on_any_message() {
        let (registry, queue, events, store, clock) = test_registry();
        let handle = registry
            .register(1, "any 条件".to_string(), TimerCondition::Any)
            .await
            .expect("注册应成功");
        // 注入 mock SubagentEnded → 早退
        registry.on_event(&subagent_ended("task-99")).await;
        assert_early_exit_notice(&queue, &handle.timer_id, "task-99");
        {
            let emitted = events.emitted.lock().unwrap_or_else(|e| e.into_inner());
            assert!(matches!(
                emitted.iter().find(|e| matches!(e, TimerEvent::Cancelled { .. })),
                Some(TimerEvent::Cancelled { ref timer_id, reason: TimerCancelReason::EarlyExit, .. })
                    if timer_id == &handle.timer_id
            ));
        }
        let persisted = store.load_all();
        assert!(
            persisted.iter().all(|d| d.cancelled),
            "早退后声明应标 cancelled=true"
        );
        // 早退路径无需等待到期：任务已 abort——推进时钟越过到期点 +
        // 100ms 收口窗，断言无到期条目（防「未 abort 而时钟未到」假绿）
        clock.store(clock.load(Ordering::Relaxed) + 2_000, Ordering::Relaxed);
        tokio::time::sleep(Duration::from_millis(100)).await;
        let entries = queue_snapshot(&queue);
        assert!(
            entries.is_empty(),
            "早退后不得有到期条目（任务已 abort）：{entries:?}"
        );
    }

    /// Task 条件：非目标 sender 终态不取消、到期正常注入；
    /// 目标 sender 终态 → 取消且无到期注入。
    #[tokio::test]
    async fn timer_condition_task_cancels_only_target() {
        let (registry, queue, _, _, clock) = test_registry();
        let handle = registry
            .register(1, "task 条件".to_string(), TimerCondition::Task("task-42".to_string()))
            .await
            .expect("注册应成功");
        // task-99 终态 → 不取消，推进时钟 → 到期恰好注入一条
        registry.on_event(&subagent_ended("task-99")).await;
        clock.store(clock.load(Ordering::Relaxed) + 2_000, Ordering::Relaxed);
        poll_until(|| queue_len(&queue) == 1).await;
        {
            let entries = queue_snapshot(&queue);
            assert_eq!(entries.len(), 1, "非目标 sender 不应早退，应正常到期");
            assert_eq!(
                entries[0].group_id.as_deref(),
                Some(steering_group_id(&handle.timer_id).as_str())
            );
            assert!(entries[0].text.contains("已到期"), "应为到期条目：{}", entries[0].text);
        }
        // 目标 sender 终态 → 取消且无到期注入（锁守卫已随块结束释放——
        // 不得跨 await 持有：cancel_early_exit 的 steering 注入会再锁同一
        // pending 表，std Mutex 不可重入）
        let handle_b = registry
            .register(1, "task 条件二".to_string(), TimerCondition::Task("task-42".to_string()))
            .await
            .expect("注册应成功");
        registry.on_event(&subagent_ended("task-42")).await;
        assert_early_exit_notice(&queue, &handle_b.timer_id, "task-42");
        // 早退路径无需等待：推进时钟 + 100ms 收口窗，断言无到期条目
        clock.store(clock.load(Ordering::Relaxed) + 2_000, Ordering::Relaxed);
        tokio::time::sleep(Duration::from_millis(100)).await;
        let entries = queue_snapshot(&queue);
        assert!(
            entries.is_empty(),
            "第二次注册的定时器应被早退，无到期条目：{entries:?}"
        );
    }

    /// 联测：task-42 活跃期间重复注册 → Conflict；取消后再注册成功。
    #[tokio::test]
    async fn timer_condition_conflict_rejected() {
        let (registry, _, _, _, _) = test_registry();
        registry
            .register(1, "第一".to_string(), TimerCondition::Task("task-42".to_string()))
            .await
            .expect("首次注册应成功");
        let second = registry
            .register(1, "第二".to_string(), TimerCondition::Task("task-42".to_string()))
            .await;
        assert!(
            matches!(&second, Err(TimerError::Conflict(message)) if message.contains("task-42")),
            "活跃期间重复注册应拒绝：{second:?}"
        );
        // 取消后重新注册成功
        let active = registry.list_active().await;
        assert_eq!(active.len(), 1);
        registry.cancel(&active[0].timer_id).await.expect("取消应成功");
        let third = registry
            .register(1, "第三".to_string(), TimerCondition::Task("task-42".to_string()))
            .await;
        assert!(third.is_ok(), "取消后应可再注册：{third:?}");
        // Any 条件不参与冲突表：task-42 活跃期间注册 Any 不冲突
        let any = registry
            .register(1, "any".to_string(), TimerCondition::Any)
            .await;
        assert!(any.is_ok(), "Any 条件不参与冲突表：{any:?}");
        // 不同 sender 互不冲突
        let other = registry
            .register(1, "另一 sender".to_string(), TimerCondition::Task("task-99".to_string()))
            .await;
        assert!(other.is_ok(), "不同 sender 应互不冲突：{other:?}");
    }

    /// 自产 TimerFired 不触发 any 早退（事件体带 timer_id 天然可排除）；
    /// 其他定时器的 TimerFired 同为内部事件，亦不触发。
    #[tokio::test]
    async fn timer_any_ignores_own_fire() {
        let (registry, queue, events, store, clock) = test_registry();
        let handle = registry
            .register(1, "any 自产排除".to_string(), TimerCondition::Any)
            .await
            .expect("注册应成功");
        // 注入自产 TimerFired（事件面路径模拟）→ 不早退（fired_at_ms
        // 走注入时钟，与注册基准一致）
        registry
            .on_event(&AgentEvent::TimerFired {
                session_id: String::new(),
                timer_id: handle.timer_id.clone(),
                prompt: "自产".to_string(),
                fired_at_ms: clock.load(Ordering::Relaxed),
            })
            .await;
        assert!(
            queue_snapshot(&queue).is_empty(),
            "自产 TimerFired 不应触发早退"
        );
        // 注入其他定时器的 TimerFired → 同为内部事件，亦不触发
        registry
            .on_event(&AgentEvent::TimerFired {
                session_id: String::new(),
                timer_id: "timer-other".to_string(),
                prompt: "他者".to_string(),
                fired_at_ms: clock.load(Ordering::Relaxed),
            })
            .await;
        // 推进时钟越过到期点 → 正常到期注入（未被早退）
        clock.store(clock.load(Ordering::Relaxed) + 2_000, Ordering::Relaxed);
        poll_until(|| queue_len(&queue) == 1).await;
        let entries = queue_snapshot(&queue);
        assert_eq!(entries.len(), 1, "自产事件排除后应正常到期注入");
        assert!(entries[0].text.contains("已到期"));
        assert!(
            !store.load_all().iter().any(|d| d.cancelled),
            "未被早退，声明不应标 cancelled"
        );
        // 无 early-exit 类取消事件
        let emitted = events.emitted.lock().unwrap_or_else(|e| e.into_inner());
        assert!(
            emitted.iter().all(|e| matches!(e, TimerEvent::Fired { .. })),
            "不应发射早退取消事件：{emitted:?}"
        );
    }

    // ── LocalDb 真适配（D6 §3.1 ①）────────────────────────────────

    /// 测试声明构造（各测试独立字段，避免跨测试共享状态）
    fn declaration(timer_id: &str) -> TimerDeclaration {
        TimerDeclaration {
            timer_id: timer_id.to_string(),
            created_at_ms: 1_000_000,
            expires_at_ms: 1_001_000,
            prompt: "检查编译结果".to_string(),
            condition: TimerCondition::Never,
            fired: false,
            cancelled: false,
        }
    }

    /// 声明往返：save → load_all 一致；同 id 重复 save 幂等覆盖
    /// （索引不重复追加）；多 id 经 timer_ids 索引枚举齐全。
    #[test]
    fn local_db_timer_store_roundtrip() {
        let db = LocalDb::open_in_memory().expect("内存库打开应成功");
        let store = LocalDbTimerStore::new(db);
        let first = declaration("timer-0");
        store.save(&first);
        let loaded = store.load_all();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0], first, "读回应与写入一致");
        // 同 id 重复保存 → 覆盖不新增（索引幂等追加）
        store.save(&first);
        assert_eq!(store.load_all().len(), 1, "同 id 重复保存不得新增");
        // 多 id → 索引枚举齐全
        let second = declaration("timer-1");
        store.save(&second);
        let all = store.load_all();
        assert_eq!(all.len(), 2, "多 id 经 timer_ids 索引枚举齐全");
        assert!(all.iter().any(|d| d.timer_id == "timer-1"));
    }

    /// 重启恢复：新 store 实例读同一 db → 声明完全恢复（模拟引擎
    /// 重启，D6 §3.1 段 3 restore 重建衔接的数据面）。
    #[test]
    fn local_db_timer_store_recovers_across_instances() {
        let db = LocalDb::open_in_memory().expect("内存库打开应成功");
        {
            let store = LocalDbTimerStore::new(db.clone());
            store.save(&declaration("timer-0"));
            store.save(&declaration("timer-1"));
        }
        // 模拟重启：新实例读回（store 消亡，session_meta 残留）
        let store = LocalDbTimerStore::new(db);
        let loaded = store.load_all();
        assert_eq!(loaded.len(), 2, "重启后声明应完全恢复");
        assert!(loaded.iter().any(|d| d.timer_id == "timer-0"));
        assert!(loaded.iter().any(|d| d.timer_id == "timer-1"));
    }

    /// fail-open：无索引键 → 空集；索引指向坏 JSON 键值 → 跳过不
    /// panic；索引孤儿 id（键缺失）→ 跳过；索引键本身坏 JSON → 空集。
    #[test]
    fn local_db_timer_store_fail_open() {
        let db = LocalDb::open_in_memory().expect("内存库打开应成功");
        let store = LocalDbTimerStore::new(db.clone());
        assert!(store.load_all().is_empty(), "空库 → 空集（fail-open）");
        // 索引指向坏 JSON 键值 → 跳过（对齐内存版 filter_map 语义）
        let _ = db.set_session_meta(SESSION_META_TIMER_INDEX_KEY, r#"["timer-0"]"#);
        let _ = db.set_session_meta(&store_key("timer-0"), "not-json");
        assert!(store.load_all().is_empty(), "坏 JSON 键值 → 跳过不 panic");
        // 索引孤儿 id（键值缺失）→ 跳过
        let _ = db.set_session_meta(SESSION_META_TIMER_INDEX_KEY, r#"["timer-9"]"#);
        assert!(store.load_all().is_empty(), "孤儿 id（键缺失）→ 跳过");
        // 索引键本身坏 JSON → 空集
        let _ = db.set_session_meta(SESSION_META_TIMER_INDEX_KEY, "not-json");
        assert!(store.load_all().is_empty(), "索引坏 JSON → 空集");
    }
}
