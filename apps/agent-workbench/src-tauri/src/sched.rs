//! Cron 调度注册表（G9 调度面；T-CF-09，REQ-C03）
//!
//! 职责（02-CF 方案 §4.4 / T-CF-09）：
//! - [SchedulerRegistry]：注册 / 取消 / 重启恢复 / 触发执行；
//!   每次触发经 [PendingSink]（PendingMessageQueue 适配）注入 steering
//!   条目（group_id = `cron-<id>`，replaceOrEnqueue 去重），或经
//!   [DaemonRunLauncher] 拉起独立 run（is_daemon 双路径，§4.4 冻结语义）；
//! - MaxIterations：`fired_count >= max_iterations` → 停止并清除
//!   （enabled=false 落库 + 移除 sleep），触发一次「cron 已完成」通知；
//! - 持久化：经 [SchedStore] 适配 conex-db session_meta `sched_*` 键
//!   （键形状 `sched_<cron_id>`，与 timers.rs `timer_*` 键同构）；
//! - 重启恢复：扫描 `sched_*` 键，enabled 且未达上限 → 按 next_fire_at_ms
//!   重建 sleep；已过期未触发 → 补发一次（防丢）。
//!
//! 冻结契约对齐（§4.4 / §4.7 / §4.8）：
//! - `parse_cron` / `CronSchedule::next_fire_after` 来自 conex-types cron
//!   模块（T-CF-08 冻结签名，A4 域）；
//! - `AgentEvent::CronFired` 事件变体来自 conex-types events.rs
//!   （T-CF-08 登记，字段：sessionId/cronId/prompt/expression/iteration/
//!   firedAtMs），本文件经内部形状 [CronEvent] 与 [EventSink] 单点映射，
//!   避免散落依赖事件面细节；
//! - 唤醒摘要（T-CF-12 冻结模板 §4.8）：Cron 触发文本按
//!   「<prompt>（cron <id> 第 N 次触发）」模板拼接；A6 的
//!   `wakeup_summary` 函数在 R-CF3 装配收口（A8/T-CF-11）统一接入，
//!   本文件按冻结模板落形，不直接依赖 A6 编译产物。
//!
//! 装配（engine.rs `EngineHandle::new`，A3 / T-CF-10 统一接线）：
//! - pending sink = [QueuePendingSink]（真实 PendingMessageQueue）；
//! - event sink = [SchedEventSink]（缓冲 + 日志；事件面接线 = engine.rs
//!   `forward_drained_scheduler_events` 周期 drain 转发到 EventBridge，
//!   main.rs drain 任务装配在批 3，30 方案 §4）；
//! - store = [MemorySchedStore]（conex-db 真适配需要 db 句柄，装配收口
//!   接线；session_meta 无前缀枚举接口，真适配需配套 `sched_ids` 索引键，
//!   本文件已按 `sched_<id>` 键形状实现内存版——与 timers.rs 同款取舍）；
//! - launcher = [DaemonRunLauncher]（is_daemon 拉起独立 run 的适配；
//!   RunProducer 当前 `produce()` 无入参，prompt 作为初始消息的注入属
//!   装配适配，偏差登记见回报；未接线时 daemon 触发降级为 steering 注入）。

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use conex_db::LocalDb;
use conex_types::cron::{parse_cron, CronSchedule};
use conex_types::error::codes;
use conex_types::events::AgentEvent;
use orchestrator::steering_queue::SteeringInputEntry;
use orchestrator::PendingMessageQueue;
use tokio::time::Instant;

/// cron id 前缀（`cron-<seq>`，命名风格对齐 `task-<seq>` / `timer-<seq>` 先例）
const CRON_ID_PREFIX: &str = "cron-";
/// session_meta 持久化键前缀（`sched_<cron_id>` 键）
const SESSION_META_SCHED_KEY_PREFIX: &str = "sched_";
/// 索引键（cron id 列表；conex-db 暂无 session_meta 键扫描 API，
/// 索引键保证可枚举——对齐 workflow_commands.rs:403-406 先例注记）
const SESSION_META_SCHED_INDEX_KEY: &str = "sched_ids";

/// 当前 epoch 毫秒（cron 全域时间基准）
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

/// 从 cron id 解析序号（`cron-<seq>` → `seq`；恢复时推进分配器防撞 id）
fn cron_seq(cron_id: &str) -> Option<u64> {
    cron_id
        .strip_prefix(CRON_ID_PREFIX)
        .and_then(|seq| seq.parse::<u64>().ok())
}

/// steering 分组名（group_id = `cron-<id>`，replaceOrEnqueue 去重；
/// 对齐 recovery.rs:371-380 的 build_steering_entry 分组模式与 timers.rs
/// `timer-<id>` 同构——§4.4 / T-CF-09 内容 4 冻结）
pub(crate) fn steering_group_id(cron_id: &str) -> String {
    format!("{CRON_ID_PREFIX}{cron_id}")
}

// ── 类型与契约（§4.4 冻结形状）────────────────────────────────────

/// Cron 任务声明（session_meta `sched_*` 键 JSON 形状，§4.4 冻结字段）
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CronTask {
    /// cron id（cron-<seq>）
    pub cron_id: String,
    /// cron 表达式原文（回显）
    pub expression: String,
    /// 每次触发的通知内容
    pub prompt: String,
    /// 最大触发次数（None = 无限；到达即停止并清除）
    pub max_iterations: Option<u64>,
    /// true = 独立常驻（触发时拉起独立 run，prompt 作为初始用户消息）
    pub is_daemon: bool,
    /// 下一次触发时刻（重启后重建 sleep 的依据）
    pub next_fire_at_ms: u64,
    /// 已触发次数（MaxIterations 判定依据）
    pub fired_count: u64,
    /// 启用标志（cancel / 达上限停止 → false；重启恢复过滤依据）
    pub enabled: bool,
}

/// 注册入参（命令面 T-CF-14 委托的输入形状；next_fire_at_ms 等运行态
/// 字段由注册表计算，不入参）
#[derive(Debug, Clone)]
pub(crate) struct CronTaskInput {
    /// cron 表达式（5 段式，非法返回结构化错误）
    pub expression: String,
    /// 每次触发的通知内容
    pub prompt: String,
    /// 最大触发次数（None = 无限）
    pub max_iterations: Option<u64>,
    /// true = 独立常驻（拉起独立 run）；false = steering 注入当前会话
    pub is_daemon: bool,
}

/// 调度错误（结构化，对齐 TimerError 风格 set_timer.rs:49-97）
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SchedulerError {
    /// cron 表达式非法（T-CF-08 解析失败，含字段定位）
    InvalidExpression(String),
    /// 表达式合法但无未来命中时刻（如 2 月 30 日，next_fire_after=None）
    NoNextFire(String),
    /// 取消 / 操作不存在的 cron 任务
    IdNotFound,
}

impl SchedulerError {
    /// 错误码（映射 conex-types 码表；T-CF-09 验收「结构化错误」）
    #[allow(dead_code)] // R-CF3：命令面（T-CF-14）结构化错误映射接线后移除
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::InvalidExpression(_) | Self::NoNextFire(_) => codes::TOOL_INVALID_INPUT,
            Self::IdNotFound => codes::COMMON_NOT_FOUND,
        }
    }

    /// 错误文案
    #[allow(dead_code)] // R-CF3：命令面（T-CF-14）结构化错误映射接线后移除
    pub(crate) fn message(&self) -> String {
        match self {
            Self::InvalidExpression(detail) => format!("cron 表达式非法：{detail}"),
            Self::NoNextFire(expression) => {
                format!("cron 表达式 {expression} 无未来触发时刻（如 2 月 30 日），拒绝注册")
            }
            Self::IdNotFound => "cron 任务不存在或已停止".to_string(),
        }
    }
}

// ── 适配器契约（对齐 timers.rs 范式）──────────────────────────────

/// steering 条目落点（PendingMessageQueue 适配；触发 / 完成通知共用）
pub(crate) trait PendingSink: Send + Sync {
    /// 写入一条 steering 条目（group_id = cron-<id>，replaceOrEnqueue 去重；
    /// is_steering 受保护位，容量挤占时优先保留）
    fn enqueue_steering(&self, cron_id: &str, text: String, enqueued_at_ms: u64);
}

/// 事件发射点（EventQueue 适配；CronFired = Critical 的分级由适配器承载，
/// 本层只描述内部形状）
pub(crate) trait EventSink: Send + Sync {
    /// 发射 cron 事件
    fn emit(&self, event: CronEvent);
}

/// session_meta 持久化适配（conex-db `sched_*` 键读写）
pub(crate) trait SchedStore: Send + Sync {
    /// 读取全部声明（重启恢复扫描用）
    fn load_all(&self) -> Vec<CronTask>;
    /// 保存声明（幂等 upsert）
    fn save(&self, task: &CronTask);
}

/// 独立 run 拉起点（is_daemon 路径；A3 装配时以 RunProducer 适配注入）
///
/// 契约：`launch(prompt)` 拉起一次独立 run，prompt 作为 run 的初始用户
/// 消息（§4.4 冻结语义）。返回 true = 已拉起；false = 启动失败/未接线
/// → 调用方降级为 steering 条目注入（防丢唤醒）。
#[async_trait]
pub(crate) trait DaemonRunLauncher: Send + Sync {
    /// 拉起独立 run（prompt 作为初始消息）；失败返回 false 供降级
    async fn launch(&self, prompt: String) -> bool;
}

/// cron 内部事件形状（适配器单点映射为 AgentEvent 的 CronFired，§4.7
/// 冻结字段：cronId / prompt / expression / iteration / firedAtMs）
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CronEvent {
    /// 触发（Critical 必达落库）
    Fired {
        /// cron id（cron-<seq>）
        cron_id: String,
        /// 本次触发的通知内容
        prompt: String,
        /// cron 表达式原文（回显）
        expression: String,
        /// 本次是第几次触发（从 1 起）
        iteration: u64,
        /// 触发时刻（epoch 毫秒）
        fired_at_ms: u64,
    },
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
    fn enqueue_steering(&self, cron_id: &str, text: String, enqueued_at_ms: u64) {
        let entry = SteeringInputEntry {
            // 条目 id 带时间戳保证同组替换后仍唯一（对齐 recovery 模式）
            id: format!("{cron_id}-{enqueued_at_ms}"),
            text,
            attachments: Vec::new(),
            enqueued_at: enqueued_at_ms,
            group_id: Some(steering_group_id(cron_id)),
            is_steering: true,
        };
        let mut queue = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        queue.replace_or_enqueue(entry);
    }
}

/// AgentEvent 适配事件槽（CronEvent → AgentEvent 单点映射；
/// 缓冲 + 日志，事件面经 engine.rs `forward_drained_scheduler_events`
/// drain 转发到 EventBridge（P4，30 方案 §4）——本层不直接
/// 依赖事件桥，转发由引擎装配面持有，缓冲供测试断言与调试观测）。
///
/// Stage 6（ACT-602）：内嵌 `tokio::sync::Notify`，`emit` 即 `notify_one`；
/// main.rs drain 协程挂起于 `notified().await`，无事件时 0 Hz 待机。
pub(crate) struct SchedEventSink {
    /// 已发射事件缓冲（drain 转发 / 测试断言）
    buffered: Mutex<Vec<AgentEvent>>,
    /// 事件写入唤醒句柄（main.rs drain 协程消费）
    notify: Arc<tokio::sync::Notify>,
}

impl SchedEventSink {
    /// 新建事件槽
    pub(crate) fn new() -> Self {
        Self {
            buffered: Mutex::new(Vec::new()),
            notify: Arc::new(tokio::sync::Notify::new()),
        }
    }

    /// 唤醒句柄（main.rs drain 协程持有 clone；与 emit 同一 Notify 实例）
    pub(crate) fn wake_notify(&self) -> Arc<tokio::sync::Notify> {
        Arc::clone(&self.notify)
    }

    /// 取走缓冲事件（drain 转发 helper（engine.rs）与测试断言消费；
    /// Vec::take 语义，空缓冲返回空集；生产消费方 = main.rs drain
    /// 任务（Stage 6 Notify 事件驱动，经 engine.rs
    /// [crate::engine::forward_drained_scheduler_events] 转发））
    pub(crate) fn drain(&self) -> Vec<AgentEvent> {
        std::mem::take(&mut *self.buffered.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

impl EventSink for SchedEventSink {
    fn emit(&self, event: CronEvent) {
        let agent_event = match event {
            CronEvent::Fired {
                cron_id,
                prompt,
                expression,
                iteration,
                fired_at_ms,
            } => AgentEvent::CronFired {
                // 注册表每引擎一个、无会话归属，sessionId 置空串；
                // 会话归属语义在 R-CF3 装配收口时定稿（§4.7 注）
                session_id: String::new(),
                cron_id,
                prompt,
                expression,
                iteration,
                fired_at_ms,
            },
        };
        tracing::debug!(
            target: "sched",
            event = agent_event.type_name(),
            "cron 事件已发射（缓冲；drain 转发 P4 接线）"
        );
        self.buffered
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(agent_event);
        // ACT-602：唤醒 main.rs drain 协程
        self.notify.notify_one();
    }
}

/// 内存持久化适配（测试 + 引擎默认装配；conex-db session_meta 真适配
/// 在 R-CF3 接线——键形状已冻结为 `sched_<cron_id>`）
#[derive(Default)]
pub(crate) struct MemorySchedStore {
    /// sched_<cron_id> → CronTask JSON
    map: Mutex<HashMap<String, String>>,
}

impl MemorySchedStore {
    /// 共享实例（重启恢复测试中两个注册表共用同一存储）
    pub(crate) fn shared() -> Arc<Self> {
        Arc::new(Self::default())
    }
}

/// 持久化键（`sched_` 前缀 + cron id）
fn store_key(cron_id: &str) -> String {
    format!("{SESSION_META_SCHED_KEY_PREFIX}{cron_id}")
}

impl SchedStore for MemorySchedStore {
    fn load_all(&self) -> Vec<CronTask> {
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter_map(|json| serde_json::from_str(json).ok())
            .collect()
    }

    fn save(&self, task: &CronTask) {
        if let Ok(json) = serde_json::to_string(task) {
            self.map
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(store_key(&task.cron_id), json);
        }
    }
}

/// LocalDb session_meta 真适配（键 `sched_<cron_id>` + 索引 `sched_ids`；
/// 照抄 workflow_commands.rs:400-478 先例，与 timers.rs LocalDbTimerStore
/// 同构）。
///
/// 注：conex-db 当前仅有 get/set_session_meta（无键扫描 / 删除 API），
/// 故以 `sched_ids` 索引键承载可枚举性；本域无 remove 面——enabled=false
/// 落库即终态（cancel / 达上限停止），索引只增不摘（D6 §3.1）。
#[derive(Clone)]
pub(crate) struct LocalDbSchedStore {
    db: LocalDb,
}

impl LocalDbSchedStore {
    /// 新建真适配（db 由装配点提供；轮 2 装配替换时注入）
    pub(crate) fn new(db: LocalDb) -> Self {
        Self { db }
    }
}

impl SchedStore for LocalDbSchedStore {
    fn load_all(&self) -> Vec<CronTask> {
        // 读 sched_ids 索引 → 逐键 get_session_meta(store_key(cron_id))
        // → serde_json 宽容解析（坏 JSON 跳过，fail-open 对齐
        // MemorySchedStore::load_all 的 filter_map 语义 sched.rs:317-324）
        let index: Vec<String> = self
            .db
            .get_session_meta(SESSION_META_SCHED_INDEX_KEY)
            .ok()
            .flatten()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default();
        index
            .into_iter()
            .filter_map(|cron_id| {
                self.db
                    .get_session_meta(&store_key(&cron_id))
                    .ok()
                    .flatten()
                    .and_then(|json| serde_json::from_str(&json).ok())
            })
            .collect()
    }

    fn save(&self, task: &CronTask) {
        // upsert 键值 + 索引幂等追加（对齐 workflow_commands.rs:439-457）
        if let Ok(json) = serde_json::to_string(task) {
            let _ = self.db.set_session_meta(&store_key(&task.cron_id), &json);
        }
        let mut index: Vec<String> = self
            .db
            .get_session_meta(SESSION_META_SCHED_INDEX_KEY)
            .ok()
            .flatten()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default();
        if !index.iter().any(|id| id == &task.cron_id) {
            index.push(task.cron_id.clone());
            if let Ok(json) = serde_json::to_string(&index) {
                let _ = self
                    .db
                    .set_session_meta(SESSION_META_SCHED_INDEX_KEY, &json);
            }
        }
    }
}

// ── SchedulerRegistry（T-CF-09）────────────────────────────────────

/// 活跃 cron 条目（tasks 表值）
struct CronEntry {
    /// 运行态声明（fired_count / next_fire_at / enabled 实时刷新）
    task: CronTask,
    /// 触发任务（cancel 经 abort 取消；fire 重建时替换）
    sleep_task: tokio::task::JoinHandle<()>,
}

/// 注册表组件集合（spawn 任务与恢复补发共用；任务克隆组件 Arc 而非
/// 注册表本体——避免「注册表 → 条目 → 任务 → 注册表」循环引用，
/// timers.rs 同范式）
#[derive(Clone)]
pub(crate) struct SchedulerComponents {
    /// cron_id → 活跃条目（Arc 供触发任务克隆）
    tasks: Arc<Mutex<HashMap<String, CronEntry>>>,
    /// steering 条目落点（PendingMessageQueue 适配）
    pending: Arc<dyn PendingSink>,
    /// cron-fired 事件发射点（EventQueue 适配）
    events: Arc<dyn EventSink>,
    /// session_meta sched_* 键读写（conex-db 适配）
    store: Arc<dyn SchedStore>,
    /// is_daemon 独立 run 拉起点（None = 未接线，daemon 降级 steering）
    launcher: Option<Arc<dyn DaemonRunLauncher>>,
    /// 暂停开关（R2-12c C31 pauseAutomation 落点；F6 §8.2「受限触发」——
    /// 一次性指令不改变持久化配置：暂停为纯内存态，重启不恢复）：
    /// Some(epoch ms) = 暂停至该时刻；None = 未暂停
    pause: Arc<Mutex<Option<u64>>>,
    /// 测试钩子：固定短触发延迟（免等分钟级真实触发；生产构建零影响）
    #[cfg(test)]
    fire_override: Arc<Mutex<Option<u64>>>,
}

/// Cron 调度注册表（每引擎一个；触发经 PendingMessageQueue 注入，
/// 不直接持有 ControlBus——唤醒走 steering 面而非事件面，§4.7 分工）
pub(crate) struct SchedulerRegistry {
    /// 组件集合（触发任务克隆用）
    components: SchedulerComponents,
    /// cron-<seq> 原子计数
    seq: AtomicU64,
}

impl SchedulerRegistry {
    /// 新建注册表（适配器由装配方注入；launcher = None 时 is_daemon
    /// 任务触发降级为 steering 注入）
    pub(crate) fn new(
        pending: Arc<dyn PendingSink>,
        events: Arc<dyn EventSink>,
        store: Arc<dyn SchedStore>,
        launcher: Option<Arc<dyn DaemonRunLauncher>>,
    ) -> Self {
        Self {
            components: SchedulerComponents {
                tasks: Arc::new(Mutex::new(HashMap::new())),
                pending,
                events,
                store,
                launcher,
                pause: Arc::new(Mutex::new(None)),
                #[cfg(test)]
                fire_override: Arc::new(Mutex::new(None)),
            },
            seq: AtomicU64::new(0),
        }
    }

    /// 注册 cron 任务（T-CF-09 内容 1）。
    ///
    /// 流程：解析表达式（T-CF-08，非法 → 结构化错误不落库）→ 计算首次
    /// next_fire_at（无未来命中时刻 → 结构化错误拒绝）→ 构造声明落
    /// session_meta `sched_*` 键 → spawn tokio sleep 任务 → 返回 cron_id。
    pub(crate) async fn register(&self, input: CronTaskInput) -> Result<String, SchedulerError> {
        // 1. 解析表达式（复用 conex-types cron 解析器；非法返回结构化
        //    错误——T-CF-09 验收「非法表达式不落库」）
        let schedule: CronSchedule = parse_cron(&input.expression)
            .map_err(|error| SchedulerError::InvalidExpression(format!("{error:?}")))?;
        // 2. 首次触发时刻（从当前时刻之后第一个命中；无命中如 2 月 30 日
        //    → 结构化错误拒绝注册，不落库）
        let now = now_ms();
        let next_fire_at_ms = schedule
            .next_fire_after(now)
            .ok_or_else(|| SchedulerError::NoNextFire(input.expression.clone()))?;
        // 3. id 分配（cron-<seq>；恢复时 fetch_max 推进防撞号）
        let seq = self.seq.fetch_add(1, Ordering::SeqCst);
        let cron_id = format!("{CRON_ID_PREFIX}{seq}");
        // 4. 构造声明 + 落库（session_meta `sched_<cron_id>` 键；
        //    重启恢复数据源）
        let task = CronTask {
            cron_id: cron_id.clone(),
            expression: input.expression,
            prompt: input.prompt,
            max_iterations: input.max_iterations,
            is_daemon: input.is_daemon,
            next_fire_at_ms,
            fired_count: 0,
            enabled: true,
        };
        self.components.store.save(&task);
        // 5. spawn 首次触发任务（sleep_until；cancel 经 abort 取消）
        let delay = fire_delay_ms(&self.components, next_fire_at_ms);
        let handle = spawn_fire_task(self.components.clone(), task.clone(), delay);
        self.components
            .tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                cron_id.clone(),
                CronEntry {
                    task,
                    sleep_task: handle,
                },
            );
        tracing::info!(
            target: "sched",
            cron_id = %cron_id,
            next_fire_at_ms,
            "cron 任务已注册"
        );
        Ok(cron_id)
    }

    /// 取消 / 删除 cron 任务（T-CF-09 内容 5）：
    /// abort sleep 任务 → 声明标 enabled=false 落库；不存在返回 IdNotFound。
    pub(crate) async fn cancel(&self, cron_id: &str) -> Result<bool, SchedulerError> {
        let Some(entry) = self
            .components
            .tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(cron_id)
        else {
            return Err(SchedulerError::IdNotFound);
        };
        entry.sleep_task.abort();
        let mut task = entry.task;
        task.enabled = false;
        self.components.store.save(&task);
        tracing::info!(
            target: "sched",
            cron_id,
            "cron 任务已取消（enabled=false 已落库）"
        );
        Ok(true)
    }

    /// 重启恢复（T-CF-09 内容 6）：扫描已持久化声明——
    /// - enabled 且未达 max_iterations → 按 next_fire_at_ms 重建 sleep；
    /// - 已过期未触发 → 补发一次（防丢；fire 内自会重算下一次并重建）。
    pub(crate) async fn restore(&self) {
        let now = now_ms();
        for task in self.components.store.load_all() {
            // 序号推进（恢复的 id 防新注册撞号）
            if let Some(seq) = cron_seq(&task.cron_id) {
                self.seq.fetch_max(seq + 1, Ordering::SeqCst);
            }
            // 终态跳过：已禁用（cancel / 达上限停止）或已达上限
            if !task.enabled {
                continue;
            }
            if let Some(max) = task.max_iterations {
                if task.fired_count >= max {
                    continue;
                }
            }
            if task.next_fire_at_ms <= now {
                // 已过期未触发 → 补发（重启窗口期间到期的 cron）
                tracing::info!(
                    target: "sched",
                    cron_id = %task.cron_id,
                    "重启恢复：已过期未触发，补发一次"
                );
                // 补发路径：表内无条目（未注册重建），fire 收口允许直接
                // 挂载重建后的 sleep
                fire_cron(self.components.clone(), task, true).await;
                continue;
            }
            // 未到期 → 按 next_fire_at_ms 重建 sleep
            let delay = fire_delay_ms(&self.components, task.next_fire_at_ms);
            tracing::info!(
                target: "sched",
                cron_id = %task.cron_id,
                delay_ms = delay,
                "重启恢复：未到期 cron 已重建 sleep"
            );
            let handle = spawn_fire_task(self.components.clone(), task.clone(), delay);
            self.components
                .tasks
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(
                    task.cron_id.clone(),
                    CronEntry {
                        task,
                        sleep_task: handle,
                    },
                );
        }
    }

    /// 活跃判定（T-CF-11 idle 待命续 run 用：存在 enabled 且未达上限的
    /// cron 任务——表内条目即活跃，停止 / 取消时已移除；30 方案 P7：
    /// 生产消费方 = CoreRunState::new 装配的 cron_has_enabled 判定器）
    pub(crate) fn has_active(&self) -> bool {
        !self
            .components
            .tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
    }

    /// 全量快照（T-CF-14 命令面 list-workflows 用；含已停止任务）
    pub(crate) fn snapshot(&self) -> Vec<CronTask> {
        self.components.store.load_all()
    }

    /// 测试钩子：注入固定短触发延迟（毫秒），免等分钟级真实触发；
    /// 生产构建下该字段与方法均不存在，零影响。
    #[cfg(test)]
    pub(crate) fn set_fire_override_ms(&self, ms: u64) {
        *self
            .components
            .fire_override
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(ms);
    }

    /// 暂停定时自动执行（R2-12c C31 pauseAutomation；F6 §8.2「受限
    /// 触发」——一次性指令，不改变持久化配置：暂停为内存态，重启不
    /// 恢复）。duration_sec 由命令面钳制（注册表 60-86400）；重复调用
    /// 刷新 pausedUntil（R2-11 §11「重复暂停刷新 pausedUntil」）。
    /// 返回暂停截止时刻（epoch ms）。
    pub(crate) fn pause_for(&self, duration_sec: u64) -> u64 {
        let paused_until = now_ms().saturating_add(duration_sec.saturating_mul(1000));
        *self
            .components
            .pause
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(paused_until);
        tracing::info!(
            target: "sched",
            duration_sec,
            paused_until,
            "定时自动执行已临时暂停（内存态，重启不恢复）"
        );
        paused_until
    }

    /// 当前暂停截止时刻（None = 未暂停；C31 查询面与测试断言）
    // R2-12c 备注：生产查询面（M6 §12.4 网关轮）接线前仅测试消费——
    // dead_code 静音（测试构建保持检查）
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn pause_deadline(&self) -> Option<u64> {
        *self
            .components
            .pause
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    /// 测试钩子：直接设置暂停截止时刻（免等真实时长；生产构建零影响）
    #[cfg(test)]
    pub(crate) fn set_paused_until_ms_for_test(&self, until: Option<u64>) {
        *self
            .components
            .pause
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = until;
    }
}

impl std::fmt::Debug for SchedulerRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SchedulerRegistry")
            .field("seq", &self.seq.load(Ordering::SeqCst))
            .finish_non_exhaustive()
    }
}

/// 触发延迟（next_fire_at_ms 相对当前时刻；测试钩子：注入固定短延迟）。
/// 非测试构建下 components 仅用于下一行计算，无 override 分支，
/// cfg_attr 抑制 unused_variables 警告（测试构建两处都使用）。
#[cfg_attr(not(test), allow(unused_variables))]
fn fire_delay_ms(components: &SchedulerComponents, next_fire_at_ms: u64) -> u64 {
    #[cfg(test)]
    if let Some(ms) = *components
        .fire_override
        .lock()
        .unwrap_or_else(|e| e.into_inner())
    {
        return ms;
    }
    next_fire_at_ms.saturating_sub(now_ms())
}

/// spawn 一次触发任务：sleep_until 到期 → fire_cron（同步段包
/// catch_unwind 兜底，launch 经 tokio::spawn 隔离 panic——记日志不炸引擎）。
///
/// 任务克隆组件集合 Arc，不自引用注册表本体（防循环引用）。
fn spawn_fire_task(
    components: SchedulerComponents,
    task: CronTask,
    fire_delay_ms: u64,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        tokio::time::sleep_until(Instant::now() + Duration::from_millis(fire_delay_ms)).await;
        // 常规触发路径：表内条目在（register / restore / 重建挂载），
        // 不启表外重建标志
        fire_cron(components, task, false).await;
    })
}

/// 触发一次 cron（spawn 任务 / 重启补发共用；T-CF-09 内容 2/3/4）。
///
/// 段 1（同步，catch_unwind 兜底）：幂等守卫 → 发射 CronFired（Critical）
/// → fired_count += 1 落库 → 计算下一次触发；
/// 段 2（async）：唤醒面——非 daemon 走 steering 注入（group_id =
/// cron-<id>，replaceOrEnqueue 去重）；daemon 经 launcher 拉起独立 run
/// （prompt 作为初始消息），launcher 未接线或启动失败 → 降级 steering
/// 注入（防丢唤醒）；
/// 段 3（同步）：达到 max_iterations / 无后续触发 → 停止并清除
/// （enabled=false 已在段 1 落库 + 移除 sleep + 「cron 已完成」通知）；
/// 否则按新 next_fire_at_ms 重建 sleep（表内条目仍存在且 enabled 才
/// 生效——cancel 竞态防复活；restore 补发路径经 allow_rebuild_without_entry
/// 直接挂载）。
async fn fire_cron(
    components: SchedulerComponents,
    task: CronTask,
    allow_rebuild_without_entry: bool,
) {
    // 段 0（R2-12c C31 暂停门控）：暂停期内到点不触发——不发射事件、
    // 不推进 fired_count、不落库；sleep 延后到暂停结束时刻重试（恢复
    // 后继续照常触发）。暂停为一次性指令（F6 §8.2），不改变持久化配置
    if let Some(paused_until) = *components.pause.lock().unwrap_or_else(|e| e.into_inner()) {
        let now = now_ms();
        if now < paused_until {
            let delay = paused_until - now;
            tracing::info!(
                target: "sched",
                cron_id = %task.cron_id,
                delay_ms = delay,
                "cron 暂停期内到点：延后到暂停结束时刻重试（C31）"
            );
            let handle = spawn_fire_task(components.clone(), task.clone(), delay);
            let mut map = components.tasks.lock().unwrap_or_else(|e| e.into_inner());
            match map.get_mut(&task.cron_id) {
                // 常规路径：替换当前 sleep（当前任务即自身，替换后自然收尾）
                Some(entry) => entry.sleep_task = handle,
                // restore 补发路径：表内无条目，直接挂载
                None if allow_rebuild_without_entry => {
                    map.insert(
                        task.cron_id.clone(),
                        CronEntry {
                            task,
                            sleep_task: handle,
                        },
                    );
                }
                _ => handle.abort(), // 已被取消/移除 → 不重建（防复活）
            }
            return;
        }
    }
    // 段 1：同步触发核心（幂等守卫 / 事件 / 计数 / 落库）
    let outcome = match std::panic::catch_unwind(AssertUnwindSafe(|| fire_once(&components, &task)))
    {
        Ok(Some(outcome)) => outcome,
        Ok(None) => return, // 幂等 / 竞态守卫命中：本次触发跳过
        Err(panic) => {
            tracing::error!(
                target: "sched",
                cron_id = %task.cron_id,
                panic = %panic_message(panic.as_ref()),
                "cron 触发核心 panic（已兜底，不炸引擎）"
            );
            return;
        }
    };
    // 段 2：唤醒面（事件与数据面已落库；唤醒摘要按 §4.8 Cron 模板拼接）
    let fire_text = format!(
        "{}（cron {} 第 {} 次触发）",
        outcome.task.prompt, outcome.task.cron_id, outcome.iteration
    );
    let launcher = components.launcher.clone();
    if outcome.task.is_daemon {
        // is_daemon：经 RunProducer 拉起独立 run（prompt 作为初始用户
        // 消息——launcher 适配层负责 prompt 注入，RunProducer::produce
        // 无入参的适配见回报偏差登记）；未接线或启动失败 → 降级
        // steering 注入（防丢唤醒）。launch 经 tokio::spawn 隔离 panic，
        // 任务 panic 按启动失败处理（unwrap_or(false)）
        let launched = match launcher {
            Some(launcher) => {
                // owned Arc 移入 async 块，满足 tokio::spawn 的 'static 约束
                // （launch 的 &self 借用于任务内持有 Arc 本体）；launch 的
                // panic 被 JoinHandle 捕获按启动失败处理
                let prompt = outcome.task.prompt.clone();
                tokio::task::spawn(async move { launcher.launch(prompt).await })
                    .await
                    .unwrap_or(false)
            }
            None => false,
        };
        if !launched {
            components.pending.enqueue_steering(
                &outcome.task.cron_id,
                fire_text,
                outcome.fired_at_ms,
            );
        }
    } else {
        components
            .pending
            .enqueue_steering(&outcome.task.cron_id, fire_text, outcome.fired_at_ms);
    }
    // 段 3：停止判定 / 重建下一次 sleep（同步，catch_unwind 兜底）
    let close = std::panic::catch_unwind(AssertUnwindSafe(|| {
        if outcome.reached_max || outcome.no_next {
            // 停止并清除：移除 sleep 条目（enabled=false 已在 fire_once
            // 落库，重启恢复不再拉起）
            components
                .tasks
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&outcome.task.cron_id);
            if outcome.reached_max {
                // 「cron 已完成」steering 通知（T-CF-09 内容 3 冻结文案）
                if let Some(max) = outcome.task.max_iterations {
                    components.pending.enqueue_steering(
                        &outcome.task.cron_id,
                        format!(
                            "cron {} 已达最大触发次数 {}，已停止",
                            outcome.task.cron_id, max
                        ),
                        now_ms(),
                    );
                }
            } else {
                // 无后续触发时刻（2 月 30 日类表达式停止路径，防御）
                tracing::warn!(
                    target: "sched",
                    cron_id = %outcome.task.cron_id,
                    "cron 无后续触发时刻，已停止（enabled=false 已落库）"
                );
            }
        } else {
            // 重建下一次 sleep（任务书内容 2：计算下一次 next_fire_at 并
            // 重建）；表内条目仍存在且 enabled 才生效——cancel 竞态防
            // 复活；restore 补发路径表内无条目，允许直接挂载
            let delay = fire_delay_ms(&components, outcome.task.next_fire_at_ms);
            let handle = spawn_fire_task(components.clone(), outcome.task.clone(), delay);
            let mut map = components.tasks.lock().unwrap_or_else(|e| e.into_inner());
            match map.get_mut(&outcome.task.cron_id) {
                Some(entry) if entry.task.enabled => {
                    // 旧 sleep 立即取消（trigger / 极端并发下防重复触发）
                    entry.sleep_task.abort();
                    entry.task = outcome.task;
                    entry.sleep_task = handle;
                }
                None if allow_rebuild_without_entry => {
                    // 重启恢复补发路径：表内无条目，直接挂载重建后的 sleep
                    map.insert(
                        outcome.task.cron_id.clone(),
                        CronEntry {
                            task: outcome.task,
                            sleep_task: handle,
                        },
                    );
                }
                _ => handle.abort(), // 已被取消/移除 → 不重建（防复活）
            }
        }
    }));
    if let Err(panic) = close {
        tracing::error!(
            target: "sched",
            cron_id = %task.cron_id,
            panic = %panic_message(panic.as_ref()),
            "cron 触发收口 panic（已兜底，不炸引擎）"
        );
    }
}

/// 触发核心（同步段；spawn 任务 / 重启补发共用）：
/// 幂等守卫 → 发射 CronFired（Critical）→ fired_count += 1 落库 →
/// 计算下一次触发。返回 None = 守卫命中（应跳过）。
struct FireOutcome {
    /// 更新后的声明（fired_count 已 +1；max/无下次时 enabled=false）
    task: CronTask,
    /// 本次是第几次触发（从 1 起）
    iteration: u64,
    /// 触发时刻（epoch 毫秒）
    fired_at_ms: u64,
    /// 已达 max_iterations（本次触发后停止）
    reached_max: bool,
    /// 无后续触发时刻（表达式无未来命中，防御停止）
    no_next: bool,
}

fn fire_once(components: &SchedulerComponents, task: &CronTask) -> Option<FireOutcome> {
    // 幂等守卫：禁用声明不触发（取消 / 已达上限的落库态）
    if !task.enabled {
        return None;
    }
    // 竞态守卫：表内条目存在但已禁用（cancel 并发）→ 跳过；
    // 表内无条目（restore 补发 / 恢复路径）→ 放行
    {
        let map = components.tasks.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get(&task.cron_id) {
            if !entry.task.enabled {
                return None;
            }
        }
    }
    let now = now_ms();
    let iteration = task.fired_count + 1;
    // 1. 事件（Critical 数据面落库；适配器接线见头部注记）
    components.events.emit(CronEvent::Fired {
        cron_id: task.cron_id.clone(),
        prompt: task.prompt.clone(),
        expression: task.expression.clone(),
        iteration,
        fired_at_ms: now,
    });
    // 2. fired_count += 1 + 计算下一次触发时刻（任务书内容 2）
    let mut updated = task.clone();
    updated.fired_count = iteration;
    let mut no_next = false;
    match parse_cron(&task.expression) {
        Ok(schedule) => match schedule.next_fire_after(now) {
            Some(next) => updated.next_fire_at_ms = next,
            None => no_next = true,
        },
        Err(error) => {
            // 注册时已校验通过；防御路径（表达式被外部改库）→ 停止
            tracing::error!(
                target: "sched",
                cron_id = %task.cron_id,
                error = %format!("{error:?}"),
                "cron 表达式重解析失败（防御路径），停止任务"
            );
            no_next = true;
        }
    }
    // 3. MaxIterations 判定（任务书内容 3）：fired_count >= max →
    //    enabled=false 落库（段 3 负责移除 sleep + 完成通知）
    let reached_max = updated
        .max_iterations
        .is_some_and(|max| updated.fired_count >= max);
    if reached_max || no_next {
        updated.enabled = false;
    }
    // 4. 落库（fired_count 已更新；max/无下次 → enabled=false，
    //    重启不再恢复）
    components.store.save(&updated);
    Some(FireOutcome {
        task: updated,
        iteration,
        fired_at_ms: now,
        reached_max,
        no_next,
    })
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
        emitted: Mutex<Vec<CronEvent>>,
    }

    impl EventSink for ProbeEvents {
        fn emit(&self, event: CronEvent) {
            self.emitted
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(event);
        }
    }

    /// 测试桩：is_daemon run 拉起点（记录 prompt；可注入启动失败）
    #[derive(Default)]
    struct ProbeLauncher {
        prompts: Mutex<Vec<String>>,
        fail: bool,
    }

    #[async_trait]
    impl DaemonRunLauncher for ProbeLauncher {
        async fn launch(&self, prompt: String) -> bool {
            if self.fail {
                return false;
            }
            self.prompts
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(prompt);
            true
        }
    }

    /// 队列快照（消费式读取：dequeue_all 取空队列；同一测试多处断言
    /// 须分别重取——每次读取独立快照，前一次读取不残留）
    fn snapshot_queue(queue: &Arc<Mutex<PendingMessageQueue>>) -> Vec<SteeringInputEntry> {
        queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .dequeue_all()
    }

    /// 非消费式队列长度（wait_until 轮询条件用——不取空队列）
    fn queue_len(queue: &Arc<Mutex<PendingMessageQueue>>) -> usize {
        queue.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    /// 条件等待：轮询直到条件满足或 8s 超时（F-009 族 flaky 根因修复——
    /// fire_override 定时器在负载下可能晚触发，「固定 sleep + 次数断言」
    /// 不稳；改等可观测状态为同步点）
    async fn wait_until<F: Fn() -> bool>(what: &str, cond: F) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
        loop {
            if cond() {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "等待条件超时（8s）：{what}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// 构造测试注册表（真实 PendingMessageQueue 落点 + 共享内存 store；
    /// launcher 未接线）
    fn test_registry() -> (
        Arc<SchedulerRegistry>,
        Arc<Mutex<PendingMessageQueue>>,
        Arc<ProbeEvents>,
        Arc<MemorySchedStore>,
    ) {
        // pending 落点装配真实 QueuePendingSink（对齐引擎装配
        // engine.rs:1084 同构——验证真实 replaceOrEnqueue 语义）
        let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        let pending = Arc::new(QueuePendingSink::new(Arc::clone(&queue)));
        let events = Arc::new(ProbeEvents::default());
        let store = MemorySchedStore::shared();
        let registry = Arc::new(SchedulerRegistry::new(
            Arc::clone(&pending) as Arc<dyn PendingSink>,
            Arc::clone(&events) as Arc<dyn EventSink>,
            Arc::clone(&store) as Arc<dyn SchedStore>,
            None,
        ));
        (registry, queue, events, store)
    }

    /// 构造注册入参（prompt 固定「检查编译结果」）
    fn test_input(expression: &str, max_iterations: Option<u64>, is_daemon: bool) -> CronTaskInput {
        CronTaskInput {
            expression: expression.to_string(),
            prompt: "检查编译结果".to_string(),
            max_iterations,
            is_daemon,
        }
    }

    // ── T-CF-09：触发 / MaxIterations / IsDaemon / 恢复 / 非法表达式 ──

    /// 触发后 PendingMessageQueue 出现 cron-<id> 条目（完成通知同组
    /// 替换触发条目）、CronFired 事件入队、fired_count=1 落库。
    #[tokio::test]
    async fn scheduler_registry_fires_cron_steering() {
        let (registry, pending, events, store) = test_registry();
        // 测试钩子：注入 40ms 短触发延迟（免等分钟级真实触发）
        registry.set_fire_override_ms(40);
        let cron_id = registry
            .register(test_input("* * * * *", Some(1), false))
            .await
            .expect("注册应成功");
        assert_eq!(cron_id, "cron-0");
        // 等待触发 + max 停止（等观测状态：事件 1 条 + 队列出现完成通知；
        // 固定 sleep 在负载下可能不足 → flaky，见 wait_until）
        let events_cond = Arc::clone(&events);
        let pending_cond = Arc::clone(&pending);
        wait_until(
            "首次触发完成（CronFired 1 条 + 队列完成通知）",
            move || {
                events_cond
                    .emitted
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .len()
                    == 1
                    && queue_len(&pending_cond) == 1
            },
        )
        .await;
        // 真实队列出现 cron-<id> 条目（max=1：触发条目被「已完成」通知
        // 同组 replaceOrEnqueue 替换，队列保留通知条目）
        let entries = snapshot_queue(&pending);
        assert_eq!(entries.len(), 1, "应恰好一条 steering 条目");
        assert_eq!(
            entries[0].group_id.as_deref(),
            Some(steering_group_id(&cron_id).as_str())
        );
        assert!(
            entries[0].text.contains("已达最大触发次数 1，已停止"),
            "完成通知文本：{}",
            entries[0].text
        );
        // CronFired 事件已入队（iteration=1，冻结字段形状）
        let emitted = events.emitted.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(emitted.len(), 1);
        match &emitted[0] {
            CronEvent::Fired {
                cron_id: id,
                prompt,
                expression,
                iteration,
                fired_at_ms,
            } => {
                assert_eq!(id, &cron_id);
                assert_eq!(prompt, "检查编译结果");
                assert_eq!(expression, "* * * * *");
                assert_eq!(*iteration, 1);
                assert!(*fired_at_ms > 0);
            }
        }
        // fired_count=1 落库；max 达到后 enabled=false（停止并清除）
        let persisted = store.load_all();
        assert_eq!(persisted.len(), 1);
        assert_eq!(persisted[0].fired_count, 1, "应恰好触发一次");
        assert!(!persisted[0].enabled, "max 达到后应 enabled=false");
        assert!(!registry.has_active(), "停止后不应有活跃任务");
    }

    /// max_iterations=2 → 触发两次后任务清除、第三次无事件、
    /// 通知含「已达最大触发次数」。
    #[tokio::test]
    async fn scheduler_registry_max_iterations_stops() {
        let (registry, pending, events, store) = test_registry();
        registry.set_fire_override_ms(40);
        registry
            .register(test_input("* * * * *", Some(2), false))
            .await
            .expect("注册应成功");
        // 等待两次触发 + 停止（等观测状态：事件 2 条 + 队列仅剩完成通知）
        let events_cond = Arc::clone(&events);
        let pending_cond = Arc::clone(&pending);
        wait_until(
            "两次触发完成（CronFired 2 条 + 队列完成通知）",
            move || {
                events_cond
                    .emitted
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .len()
                    == 2
                    && queue_len(&pending_cond) == 1
            },
        )
        .await;
        // 真实队列最终 = [完成通知]：触发条目同组（cron-<id>）逐次
        // replaceOrEnqueue 替换（第 1 次被第 2 次替换，第 2 次被完成
        // 通知替换）——去重语义即真实 QueuePendingSink
        let entries = snapshot_queue(&pending);
        assert_eq!(entries.len(), 1, "应仅剩完成通知（触发条目同组替换）");
        assert_eq!(
            entries[0].group_id.as_deref(),
            Some(steering_group_id("cron-0").as_str())
        );
        assert!(
            entries[0]
                .text
                .contains("cron cron-0 已达最大触发次数 2，已停止"),
            "完成通知文本：{}",
            entries[0].text
        );
        // 事件恰好 2 条（第 1、2 次触发；第三次无事件）
        let emitted = events.emitted.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(emitted.len(), 2, "两次触发后应停止，无第三次事件");
        let iterations: Vec<u64> = emitted
            .iter()
            .map(|e| match e {
                CronEvent::Fired { iteration, .. } => *iteration,
            })
            .collect();
        assert_eq!(iterations, vec![1, 2], "触发次数应从 1 起逐次递增");
        // 落库状态：fired_count=2、enabled=false、活跃表已清空
        let persisted = store.load_all();
        assert_eq!(persisted.len(), 1);
        assert_eq!(persisted[0].fired_count, 2);
        assert!(!persisted[0].enabled);
        assert!(!registry.has_active(), "任务清除后不应有活跃条目");
    }

    /// is_daemon=true 触发 → RunProducer（launcher 适配）被调用、
    /// prompt 作为初始消息、无 steering 注入（daemon 路径）。
    #[tokio::test]
    async fn scheduler_registry_is_daemon_spawns_run() {
        let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        let pending = Arc::new(QueuePendingSink::new(Arc::clone(&queue)));
        let events = Arc::new(ProbeEvents::default());
        let launcher = Arc::new(ProbeLauncher::default());
        let store = MemorySchedStore::shared();
        let registry = Arc::new(SchedulerRegistry::new(
            Arc::clone(&pending) as Arc<dyn PendingSink>,
            Arc::clone(&events) as Arc<dyn EventSink>,
            Arc::clone(&store) as Arc<dyn SchedStore>,
            Some(Arc::clone(&launcher) as Arc<dyn DaemonRunLauncher>),
        ));
        registry.set_fire_override_ms(40);
        registry
            .register(CronTaskInput {
                expression: "* * * * *".to_string(),
                prompt: "守护进程检查".to_string(),
                max_iterations: Some(1),
                is_daemon: true,
            })
            .await
            .expect("注册应成功");
        // 等待拉起点与收口（等观测状态：launcher 恰被调用一次 + 队列
        // 出现完成通知——事件 1 条隐含两次条件都已过段 2）
        let launcher_cond = Arc::clone(&launcher);
        let queue_cond = Arc::clone(&queue);
        wait_until(
            "daemon run 拉起完成（launcher 调用 1 次 + 完成通知）",
            move || {
                launcher_cond
                    .prompts
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .len()
                    == 1
                    && queue_len(&queue_cond) == 1
            },
        )
        .await;
        // launcher 被调用且 prompt 作为初始消息
        let prompts = launcher.prompts.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(
            prompts.as_slice(),
            &["守护进程检查".to_string()],
            "run 拉起应恰好一次，prompt 为初始消息"
        );
        // daemon 成功路径不走 steering 触发注入（无「第 N 次触发」条目；
        // max=1 停止后仅剩完成通知）
        let entries = snapshot_queue(&queue);
        assert!(
            entries.iter().all(|e| !e.text.contains("第 1 次触发")),
            "daemon 成功路径不应注入触发条目：{entries:?}"
        );
        assert_eq!(entries.len(), 1, "max 停止后应仅完成通知");
        assert!(entries[0].text.contains("已达最大触发次数 1，已停止"));
        // CronFired 事件照常发射（数据面）
        assert_eq!(
            events
                .emitted
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .len(),
            1
        );
    }

    /// launcher 未接线（装配未完成）→ daemon 触发降级为 steering 注入
    /// （防丢唤醒，任务书内容 4 降级语义；max=None 持续触发，同组
    /// replace 后队列保留最新触发条目）。
    #[tokio::test]
    async fn scheduler_registry_daemon_without_launcher_falls_back_to_steering() {
        let (registry, pending, events, _) = test_registry();
        registry.set_fire_override_ms(40);
        registry
            .register(CronTaskInput {
                expression: "* * * * *".to_string(),
                prompt: "守护进程检查".to_string(),
                max_iterations: None,
                is_daemon: true,
            })
            .await
            .expect("注册应成功");
        // 等待至少两次触发（等观测状态：同组替换语义需 ≥2 次 fire）
        let events_cond = Arc::clone(&events);
        wait_until(
            "daemon 降级触发 ≥2 次（CronFired 事件 ≥2）",
            move || {
                events_cond
                    .emitted
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .len()
                    >= 2
            },
        )
        .await;
        let entries = snapshot_queue(&pending);
        assert_eq!(
            entries.len(),
            1,
            "launcher 未接线应降级为 steering 条目（同组替换）"
        );
        assert_eq!(
            entries[0].group_id.as_deref(),
            Some(steering_group_id("cron-0").as_str())
        );
        assert!(
            entries[0].text.contains("守护进程检查（cron cron-0 第"),
            "降级条目文本应含 prompt 与唤醒模板：{}",
            entries[0].text
        );
        // 每次触发照常发射事件（数据面）
        assert!(
            events
                .emitted
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .len()
                >= 2,
            "持续触发应发射多条 CronFired"
        );
    }

    /// launcher 启动失败（fail=true）→ 降级 steering 注入（防丢唤醒）。
    #[tokio::test]
    async fn scheduler_registry_daemon_launch_failure_falls_back_to_steering() {
        let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        let pending = Arc::new(QueuePendingSink::new(Arc::clone(&queue)));
        let events = Arc::new(ProbeEvents::default());
        let launcher = Arc::new(ProbeLauncher {
            fail: true,
            ..Default::default()
        });
        let store = MemorySchedStore::shared();
        let registry = Arc::new(SchedulerRegistry::new(
            Arc::clone(&pending) as Arc<dyn PendingSink>,
            Arc::clone(&events) as Arc<dyn EventSink>,
            Arc::clone(&store) as Arc<dyn SchedStore>,
            Some(Arc::clone(&launcher) as Arc<dyn DaemonRunLauncher>),
        ));
        registry.set_fire_override_ms(40);
        registry
            .register(CronTaskInput {
                expression: "* * * * *".to_string(),
                prompt: "守护进程检查".to_string(),
                max_iterations: None,
                is_daemon: true,
            })
            .await
            .expect("注册应成功");
        // 等待启动失败 → 降级条目出现（等观测状态：≥1 次 fire + 队列
        // 已有 steering 条目）
        let events_cond = Arc::clone(&events);
        let queue_cond = Arc::clone(&queue);
        wait_until(
            "launch 失败降级条目出现（CronFired ≥1 + 队列非空）",
            move || {
                events_cond
                    .emitted
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .len()
                    >= 1
                    && queue_len(&queue_cond) == 1
            },
        )
        .await;
        // 启动失败 → 降级 steering 条目（文本 = prompt + 唤醒模板）
        let entries = snapshot_queue(&queue);
        assert_eq!(
            entries.len(),
            1,
            "启动失败应降级为 steering 条目（同组替换）"
        );
        assert!(
            entries[0].text.contains("守护进程检查（cron cron-0 第"),
            "降级条目文本应含 prompt 与唤醒模板：{}",
            entries[0].text
        );
        // launcher 未被记录成功拉起
        assert!(launcher
            .prompts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty());
    }

    /// 重启恢复：注册 → 模拟重启（重建注册表共享 store）→ next_fire_at
    /// 保留、sleep 重建后触发恰好一次；enabled=false 的声明恢复后不
    /// 重复触发。
    #[tokio::test]
    async fn scheduler_registry_persists_and_recovers() {
        let store = MemorySchedStore::shared();
        // 阶段 A：注册（不设 override → 真实分钟级 next_fire_at），
        // 注册表立即消亡（模拟重启；store 残留）
        let next_fire_at_snapshot = {
            let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
            let pending = Arc::new(QueuePendingSink::new(Arc::clone(&queue)));
            let events = Arc::new(ProbeEvents::default());
            let registry = Arc::new(SchedulerRegistry::new(
                Arc::clone(&pending) as Arc<dyn PendingSink>,
                Arc::clone(&events) as Arc<dyn EventSink>,
                Arc::clone(&store) as Arc<dyn SchedStore>,
                None,
            ));
            let cron_id = registry
                .register(test_input("* * * * *", Some(1), false))
                .await
                .expect("注册应成功");
            assert_eq!(cron_id, "cron-0");
            let persisted = store.load_all();
            assert_eq!(persisted.len(), 1);
            assert!(persisted[0].enabled, "注册后应 enabled=true");
            persisted[0].next_fire_at_ms
        };
        // 阶段 B：模拟重启 → restore（测试钩子注入短延迟验证重建 sleep
        // 生效；未到期任务不修改 next_fire_at）
        let (registry_b, queue_b, events_b) = {
            let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
            let pending = Arc::new(QueuePendingSink::new(Arc::clone(&queue)));
            let events = Arc::new(ProbeEvents::default());
            let registry = Arc::new(SchedulerRegistry::new(
                Arc::clone(&pending) as Arc<dyn PendingSink>,
                Arc::clone(&events) as Arc<dyn EventSink>,
                Arc::clone(&store) as Arc<dyn SchedStore>,
                None,
            ));
            registry.set_fire_override_ms(40);
            registry.restore().await;
            // next_fire_at 恢复：restore 不修改未到期任务的 next_fire_at_ms
            let persisted = store.load_all();
            assert_eq!(
                persisted[0].next_fire_at_ms, next_fire_at_snapshot,
                "重启恢复应保留 next_fire_at_ms"
            );
            assert!(
                registry.has_active(),
                "未到期任务恢复后应为活跃（sleep 已重建）"
            );
            (registry, queue, events)
        };
        // 触发恰好一次（max=1 → 停止；等观测状态而非固定 sleep）
        let events_b_cond = Arc::clone(&events_b);
        let queue_b_cond = Arc::clone(&queue_b);
        wait_until(
            "恢复后触发完成（CronFired 1 条 + 完成通知）",
            move || {
                events_b_cond
                    .emitted
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .len()
                    == 1
                    && queue_len(&queue_b_cond) == 1
            },
        )
        .await;
        let entries = snapshot_queue(&queue_b);
        assert_eq!(entries.len(), 1, "恢复后触发应恰好一条");
        assert_eq!(
            entries[0].group_id.as_deref(),
            Some(steering_group_id("cron-0").as_str())
        );
        assert!(
            entries[0].text.contains("已达最大触发次数 1，已停止"),
            "恢复触发收口应为完成通知：{}",
            entries[0].text
        );
        assert_eq!(
            events_b
                .emitted
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .len(),
            1
        );
        let persisted = store.load_all();
        assert_eq!(persisted[0].fired_count, 1);
        assert!(!persisted[0].enabled);
        assert!(!registry_b.has_active());
        // 阶段 C：再次模拟重启 → enabled=false 跳过 → 不重复触发
        let queue_c = Arc::new(Mutex::new(PendingMessageQueue::new()));
        let pending_c = Arc::new(QueuePendingSink::new(Arc::clone(&queue_c)));
        let events_c = Arc::new(ProbeEvents::default());
        let registry_c = Arc::new(SchedulerRegistry::new(
            Arc::clone(&pending_c) as Arc<dyn PendingSink>,
            Arc::clone(&events_c) as Arc<dyn EventSink>,
            Arc::clone(&store) as Arc<dyn SchedStore>,
            None,
        ));
        registry_c.set_fire_override_ms(40);
        registry_c.restore().await;
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(
            snapshot_queue(&queue_c).is_empty(),
            "enabled=false 的声明恢复后不得重复触发"
        );
        assert!(
            events_c
                .emitted
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty(),
            "enabled=false 的声明恢复后不得重复发射"
        );
        assert!(!registry_c.has_active());
    }

    /// 非法表达式 → 结构化错误、不落库（6 字段含秒被拒；合法但无未来
    /// 命中时刻的表达式被拒）。
    #[tokio::test]
    async fn scheduler_registry_invalid_expression_rejected() {
        let (registry, _, _, store) = test_registry();
        // 6 字段（含秒字段）→ 结构化错误（含字段定位）
        let err = registry
            .register(test_input("0 0 9 * * *", None, false))
            .await;
        assert!(
            matches!(&err, Err(SchedulerError::InvalidExpression(_))),
            "6 字段表达式应被拒绝：{err:?}"
        );
        // 表达式合法但无未来命中时刻（2 月 30 日）→ 结构化错误
        let err = registry
            .register(test_input("0 0 30 2 *", None, false))
            .await;
        assert!(
            matches!(&err, Err(SchedulerError::NoNextFire(_))),
            "2 月 30 日表达式应被拒绝：{err:?}"
        );
        // 不落库 + 无活跃条目
        assert!(store.load_all().is_empty(), "非法注册不得落库");
        assert!(!registry.has_active(), "非法注册不得产生活跃条目");
        // 错误码结构化（命令面映射用）
        assert_eq!(
            SchedulerError::InvalidExpression("x".into()).code(),
            codes::TOOL_INVALID_INPUT
        );
        assert_eq!(SchedulerError::IdNotFound.code(), codes::COMMON_NOT_FOUND);
    }

    /// 取消：abort sleep + enabled=false 落库；取消后无触发、无事件；
    /// 重复取消 → IdNotFound。
    #[tokio::test]
    async fn scheduler_registry_cancel_stops_fire() {
        let (registry, pending, events, store) = test_registry();
        registry.set_fire_override_ms(40);
        let cron_id = registry
            .register(test_input("* * * * *", Some(5), false))
            .await
            .expect("注册应成功");
        let cancelled = registry.cancel(&cron_id).await.expect("取消应成功");
        assert!(cancelled);
        // 触发窗口内不得注入（sleep 已 abort）
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(snapshot_queue(&pending).is_empty(), "取消后不得有触发条目");
        assert!(
            events
                .emitted
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty(),
            "取消后不得发射事件"
        );
        let persisted = store.load_all();
        assert_eq!(persisted.len(), 1);
        assert!(!persisted[0].enabled, "取消应 enabled=false 落库");
        assert!(!registry.has_active());
        // 重复取消 → IdNotFound（条目已移除）
        let again = registry.cancel(&cron_id).await;
        assert!(matches!(again, Err(SchedulerError::IdNotFound)));
    }

    /// CronTask 声明 wire 形状锚定（§4.4 camelCase 冻结；重启恢复
    /// JSON 往返一致）。
    #[test]
    fn cron_task_serializes_camel_case() {
        let task = CronTask {
            cron_id: "cron-3".to_string(),
            expression: "0 9 * * *".to_string(),
            prompt: "日报".to_string(),
            max_iterations: Some(2),
            is_daemon: true,
            next_fire_at_ms: 12_345,
            fired_count: 1,
            enabled: false,
        };
        let json = serde_json::to_value(&task).expect("序列化应成功");
        assert_eq!(json["cronId"], "cron-3");
        assert_eq!(json["expression"], "0 9 * * *");
        assert_eq!(json["prompt"], "日报");
        assert_eq!(json["maxIterations"], 2);
        assert_eq!(json["isDaemon"], true);
        assert_eq!(json["nextFireAtMs"], 12_345);
        assert_eq!(json["firedCount"], 1);
        assert_eq!(json["enabled"], false);
        // 回环一致（恢复路径反序列化）
        let back: CronTask = serde_json::from_value(json).expect("反序列化应成功");
        assert_eq!(back, task);
    }

    /// 触发分组名冻结：group_id = cron-<id>（与 timers `timer-<id>` 同构）。
    #[test]
    fn steering_group_id_shape() {
        assert_eq!(steering_group_id("cron-0"), "cron-cron-0");
    }

    // ── R2-12c C31：暂停定时自动执行（pauseAutomation 落点）──

    /// pause_for 设置暂停截止时刻（now + duration*1000），重复调用刷新
    /// （覆盖旧值）；暂停不改变持久化 store（F6 §8.2 一次性指令）。
    #[test]
    fn scheduler_registry_pause_for_sets_and_refreshes_deadline() {
        let (registry, _, _, store) = test_registry();
        let before = now_ms();
        let first = registry.pause_for(3600);
        assert!(
            first >= before + 3600 * 1000,
            "pause_for(3600) 截止应 ≈ now+1h：{first}"
        );
        assert_eq!(registry.pause_deadline(), Some(first));
        // 重复暂停刷新 pausedUntil（R2-11 §11）：覆盖为更短时长
        let refreshed = registry.pause_for(120);
        assert!(refreshed < first, "刷新应覆盖旧截止");
        assert_eq!(registry.pause_deadline(), Some(refreshed));
        // 不改变持久化配置（store 无任务声明落库）
        assert!(store.load_all().is_empty(), "暂停不得落库（内存态）");
    }

    /// 暂停期内到点不触发（无事件、无 steering、fired_count 不推进）；
    /// 暂停结束后恢复照常触发（事件/计数/队列正常）——「暂停后定时任务
    /// 不触发 / 恢复后继续」验收（C31 测试要求）。
    #[tokio::test]
    async fn scheduler_registry_pause_blocks_fire_then_resume_continues() {
        let (registry, pending, events, store) = test_registry();
        registry.set_fire_override_ms(40);
        // 暂停至 now+250ms；fire_override=40ms → 首个到期点在暂停窗口内
        let pause_until = now_ms() + 250;
        registry.set_paused_until_ms_for_test(Some(pause_until));
        registry
            .register(test_input("* * * * *", Some(2), false))
            .await
            .expect("注册应成功");
        assert!(registry.has_active(), "暂停不改变任务登记态");
        // 暂停窗口内（150ms）：不得有任何触发痕迹
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(
            events
                .emitted
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty(),
            "暂停窗口内不得发射 CronFired"
        );
        assert!(
            snapshot_queue(&pending).is_empty(),
            "暂停窗口内不得注入 steering 条目"
        );
        let persisted = store.load_all();
        assert_eq!(
            persisted[0].fired_count, 0,
            "暂停窗口内 fired_count 不得推进"
        );
        assert!(persisted[0].enabled, "暂停不得禁用任务");
        // 暂停结束后：恢复触发（max=2 → 两次触发后停止）
        let events_cond = Arc::clone(&events);
        let pending_cond = Arc::clone(&pending);
        wait_until(
            "暂停结束恢复触发（CronFired 2 条 + 队列完成通知）",
            move || {
                events_cond
                    .emitted
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .len()
                    == 2
                    && queue_len(&pending_cond) == 1
            },
        )
        .await;
        let emitted = events.emitted.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(emitted.len(), 2, "恢复后应照常触发两次（迭代 1、2）");
        assert!(
            emitted.iter().all(|event| matches!(
                event,
                CronEvent::Fired { fired_at_ms, .. } if *fired_at_ms >= pause_until
            )),
            "恢复后的触发时刻必须晚于暂停截止"
        );
        drop(emitted);
        let persisted = store.load_all();
        assert_eq!(persisted[0].fired_count, 2);
        assert!(!persisted[0].enabled, "max 达到后停止");
        assert!(!registry.has_active());
    }

    // ── LocalDb 真适配（D6 §3.1 ①）────────────────────────────────

    /// 测试任务构造（各测试独立字段，避免跨测试共享状态）
    fn task(cron_id: &str) -> CronTask {
        CronTask {
            cron_id: cron_id.to_string(),
            expression: "0 9 * * *".to_string(),
            prompt: "日报".to_string(),
            max_iterations: Some(2),
            is_daemon: false,
            next_fire_at_ms: 1_000_000,
            fired_count: 0,
            enabled: true,
        }
    }

    /// 声明往返：save → load_all 一致；同 id 重复 save 幂等覆盖
    /// （索引不重复追加）；多 id 经 sched_ids 索引枚举齐全。
    #[test]
    fn local_db_sched_store_roundtrip() {
        let db = LocalDb::open_in_memory().expect("内存库打开应成功");
        let store = LocalDbSchedStore::new(db);
        let first = task("cron-0");
        store.save(&first);
        let loaded = store.load_all();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0], first, "读回应与写入一致");
        // 同 id 重复保存 → 覆盖不新增（索引幂等追加）
        store.save(&first);
        assert_eq!(store.load_all().len(), 1, "同 id 重复保存不得新增");
        // 多 id → 索引枚举齐全
        let second = task("cron-1");
        store.save(&second);
        let all = store.load_all();
        assert_eq!(all.len(), 2, "多 id 经 sched_ids 索引枚举齐全");
        assert!(all.iter().any(|t| t.cron_id == "cron-1"));
    }

    /// 重启恢复：新 store 实例读同一 db → 声明完全恢复（模拟引擎
    /// 重启，D6 §3.1 段 3 restore 重建衔接的数据面）。
    #[test]
    fn local_db_sched_store_recovers_across_instances() {
        let db = LocalDb::open_in_memory().expect("内存库打开应成功");
        {
            let store = LocalDbSchedStore::new(db.clone());
            store.save(&task("cron-0"));
            store.save(&task("cron-1"));
        }
        // 模拟重启：新实例读回（store 消亡，session_meta 残留）
        let store = LocalDbSchedStore::new(db);
        let loaded = store.load_all();
        assert_eq!(loaded.len(), 2, "重启后声明应完全恢复");
        assert!(loaded.iter().any(|t| t.cron_id == "cron-0"));
        assert!(loaded.iter().any(|t| t.cron_id == "cron-1"));
    }

    /// fail-open：无索引键 → 空集；索引指向坏 JSON 键值 → 跳过不
    /// panic；索引孤儿 id（键缺失）→ 跳过；索引键本身坏 JSON → 空集。
    #[test]
    fn local_db_sched_store_fail_open() {
        let db = LocalDb::open_in_memory().expect("内存库打开应成功");
        let store = LocalDbSchedStore::new(db.clone());
        assert!(store.load_all().is_empty(), "空库 → 空集（fail-open）");
        // 索引指向坏 JSON 键值 → 跳过（对齐内存版 filter_map 语义）
        let _ = db.set_session_meta(SESSION_META_SCHED_INDEX_KEY, r#"["cron-0"]"#);
        let _ = db.set_session_meta(&store_key("cron-0"), "not-json");
        assert!(store.load_all().is_empty(), "坏 JSON 键值 → 跳过不 panic");
        // 索引孤儿 id（键值缺失）→ 跳过
        let _ = db.set_session_meta(SESSION_META_SCHED_INDEX_KEY, r#"["cron-9"]"#);
        assert!(store.load_all().is_empty(), "孤儿 id（键缺失）→ 跳过");
        // 索引键本身坏 JSON → 空集
        let _ = db.set_session_meta(SESSION_META_SCHED_INDEX_KEY, "not-json");
        assert!(store.load_all().is_empty(), "索引坏 JSON → 空集");
    }

    /// LocalDb 真 store 版跨重启端到端（D6 §5.1「换真 store 同断言」；
    /// 审计 04 重要项 Cron 同款）：注册（LocalDb 真 store 落库）→ 模拟
    /// 引擎重启（新注册表 + 同 db）→ restore 重建 sleep（fire_override
    /// 短延迟验证重建生效）→ 触发**恰好一次** + CronFired 恰好一条 +
    /// enabled=false 落库 → 再次重启 → 不重复触发（enabled=false 跳过）。
    #[tokio::test]
    async fn local_db_scheduler_registry_persists_and_recovers() {
        let db = LocalDb::open_in_memory().expect("内存库打开应成功");
        // 阶段 A：注册（LocalDb 真 store 落库；不设 override → 真实
        // 分钟级 next_fire_at，注册表立即消亡模拟重启）
        let next_fire_at_snapshot = {
            let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
            let events = Arc::new(ProbeEvents::default());
            let registry = Arc::new(SchedulerRegistry::new(
                Arc::new(QueuePendingSink::new(Arc::clone(&queue))) as Arc<dyn PendingSink>,
                Arc::clone(&events) as Arc<dyn EventSink>,
                Arc::new(LocalDbSchedStore::new(db.clone())) as Arc<dyn SchedStore>,
                None,
            ));
            let cron_id = registry
                .register(test_input("* * * * *", Some(1), false))
                .await
                .expect("注册应成功");
            assert_eq!(cron_id, "cron-0");
            let persisted = LocalDbSchedStore::new(db.clone()).load_all();
            assert_eq!(persisted.len(), 1);
            assert!(persisted[0].enabled, "注册后应 enabled=true");
            persisted[0].next_fire_at_ms
        };
        // 阶段 B：模拟重启 → restore（fire_override 短延迟验证重建 sleep
        // 生效；未到期任务不修改 next_fire_at）
        let (registry_b, queue_b, events_b) = {
            let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
            let events = Arc::new(ProbeEvents::default());
            let registry = Arc::new(SchedulerRegistry::new(
                Arc::new(QueuePendingSink::new(Arc::clone(&queue))) as Arc<dyn PendingSink>,
                Arc::clone(&events) as Arc<dyn EventSink>,
                Arc::new(LocalDbSchedStore::new(db.clone())) as Arc<dyn SchedStore>,
                None,
            ));
            registry.set_fire_override_ms(40);
            registry.restore().await;
            let persisted = LocalDbSchedStore::new(db.clone()).load_all();
            assert_eq!(
                persisted[0].next_fire_at_ms, next_fire_at_snapshot,
                "重启恢复应保留 next_fire_at_ms"
            );
            assert!(
                registry.has_active(),
                "未到期任务恢复后应为活跃（sleep 已重建）"
            );
            (registry, queue, events)
        };
        // 触发恰好一次（max=1 → 停止；等观测状态而非固定 sleep）
        let events_b_cond = Arc::clone(&events_b);
        let queue_b_cond = Arc::clone(&queue_b);
        wait_until(
            "恢复后触发完成（CronFired 1 条 + 完成通知）",
            move || {
                events_b_cond
                    .emitted
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .len()
                    == 1
                    && queue_len(&queue_b_cond) == 1
            },
        )
        .await;
        let entries = snapshot_queue(&queue_b);
        assert_eq!(entries.len(), 1, "恢复后触发应恰好一条");
        assert_eq!(
            entries[0].group_id.as_deref(),
            Some(steering_group_id("cron-0").as_str())
        );
        assert!(
            entries[0].text.contains("已达最大触发次数 1，已停止"),
            "恢复触发收口应为完成通知：{}",
            entries[0].text
        );
        assert_eq!(
            events_b
                .emitted
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .len(),
            1
        );
        let persisted = LocalDbSchedStore::new(db.clone()).load_all();
        assert_eq!(persisted[0].fired_count, 1);
        assert!(!persisted[0].enabled);
        assert!(!registry_b.has_active());
        // 阶段 C：再次模拟重启 → enabled=false 跳过 → 不重复触发
        {
            let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
            let events = Arc::new(ProbeEvents::default());
            let registry = Arc::new(SchedulerRegistry::new(
                Arc::new(QueuePendingSink::new(Arc::clone(&queue))) as Arc<dyn PendingSink>,
                Arc::clone(&events) as Arc<dyn EventSink>,
                Arc::new(LocalDbSchedStore::new(db.clone())) as Arc<dyn SchedStore>,
                None,
            ));
            registry.set_fire_override_ms(40);
            registry.restore().await;
            tokio::time::sleep(Duration::from_millis(150)).await;
            assert!(
                snapshot_queue(&queue).is_empty(),
                "enabled=false 的声明恢复后不得重复触发"
            );
            assert!(
                events
                    .emitted
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .is_empty(),
                "enabled=false 的声明恢复后不得重复发射"
            );
            assert!(!registry.has_active());
        }
    }
}
