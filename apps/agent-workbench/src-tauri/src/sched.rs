//! Cron 调度注册表（G9 调度面；T-CF-09，REQ-C03）
//!
//! 职责（02-CF 方案 §4.4 / T-CF-09 / Scheduled Tasks Revamp Phase 1）：
//! - [SchedulerRegistry]：注册 / 暂停 / 恢复 / 就地更新 / 取消 / 重启恢复 / 触发执行；
//!   每次触发经 [PendingSink]（PendingMessageQueue 适配）注入 steering
//!   条目（group_id = `cron-<id>`，replaceOrEnqueue 去重），或经
//!   [DaemonRunLauncher] 拉起独立 run（is_daemon 双路径，§4.4 冻结语义）；
//! - MaxIterations：`fired_count >= max_iterations` → 停止并清除
//!   （status=Completed 落库 + 移除 sleep），触发一次「cron 已完成」通知；
//! - 持久化：经 [SchedStore] 适配 conex-db session_meta `sched_*` 键
//!   （键形状 `sched_<cron_id>`，与 timers.rs `timer_*` 键同构）；
//! - 重启恢复：扫描 `sched_*` 键，Active 且未达上限 → 按 next_fire_at_ms
//!   重建 sleep；Paused → 加载内存表不建 sleep；已过期未触发 → 先入 tasks 表消除真空期，再异步补发一次。
//!
//! 冻结契约对齐（§4.4 / §4.7 / §4.8）：
//! - `parse_cron` / `CronSchedule::next_fire_after` 来自 conex-types cron
//!   模块（T-CF-08 冻结签名，A4 域）；
//! - `AgentEvent::CronFired` 事件变体来自 conex-types events.rs
//!   （T-CF-08 登记，字段：sessionId/cronId/prompt/expression/iteration/
//!   firedAtMs），本文件经内部形状 [CronEvent] 与 [EventSink] 单点映射，
//!   避免散落依赖事件面细节；
//! - 唤醒摘要（T-CF-12 冻结模板 §4.8）：Cron 触发文本按
//!   「<prompt>（cron <id> 第 N 次触发）」模板拼接。

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use conex_db::LocalDb;
use conex_types::cron::{parse_cron, CronSchedule};
use conex_types::error::codes;
use conex_types::events::AgentEvent;
use conex_types::CoreError;
use orchestrator::steering_queue::SteeringInputEntry;
use orchestrator::PendingMessageQueue;
use tokio::time::Instant;

/// cron id 前缀（`cron-<seq>`，命名风格对齐 `task-<seq>` / `timer-<seq>` 先例）
const CRON_ID_PREFIX: &str = "cron-";
/// session_meta 持久化键前缀（`sched_<cron_id>` 键）
const SESSION_META_SCHED_KEY_PREFIX: &str = "sched_";
/// 统一索引键（统一为 `sched_index`，与 workflow_commands.rs 对齐）
pub const SESSION_META_SCHED_INDEX_KEY: &str = "sched_index";
/// 历史索引键（兼容存量观察点与测试）
const LEGACY_SESSION_META_SCHED_INDEX_KEY: &str = "sched_ids";

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

// ── 类型与契约 ─────────────────────────────────────────────────────────

/// 单任务生命周期状态机枚举（内部单轨真理源）
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CronTaskStatus {
    /// 活跃中（倒计时协程挂载，到期自动触发）
    #[serde(alias = "Active")]
    Active,
    /// 已暂停（协程已 abort，等待用户显式恢复）
    #[serde(alias = "Paused")]
    Paused,
    /// 已完成（达到 max_iterations 或无未来时间点，终态）
    #[serde(alias = "Completed")]
    Completed,
    /// 已取消（被删除，终态）
    #[serde(alias = "Cancelled", alias = "Canceled", alias = "canceled")]
    Cancelled,
}

impl CronTaskStatus {
    pub(crate) fn is_active(self) -> bool {
        matches!(self, Self::Active)
    }

    #[allow(dead_code)]
    pub(crate) fn is_enabled(self) -> bool {
        self.is_active()
    }
}

fn default_cron_status() -> CronTaskStatus {
    CronTaskStatus::Active
}

/// Cron 任务声明（session_meta `sched_*` 键 JSON 形状）
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
    #[serde(default)]
    pub max_iterations: Option<u64>,
    /// true = 独立常驻（触发时拉起独立 run，prompt 作为初始用户消息）
    #[serde(default)]
    pub is_daemon: bool,
    /// 下一次触发时刻（重启后重建 sleep 的依据）
    #[serde(default)]
    pub next_fire_at_ms: u64,
    /// 已触发次数（MaxIterations 判定依据）
    #[serde(default)]
    pub fired_count: u64,
    /// 核心生命周期状态（单轨真理源）
    #[serde(default = "default_cron_status")]
    pub status: CronTaskStatus,
    /// 兼容存量字段（与 status.is_active() 严格同步）
    #[serde(default)]
    pub enabled: bool,
    /// 目标会话 ID（None 表示专属后台受管会话，Some(sid) 表示在指定会话内执行）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_session_id: Option<String>,
    /// 任务创建时刻（epoch 毫秒）
    #[serde(default = "now_ms")]
    pub created_at_ms: u64,
    /// 任务最后更新时刻（epoch 毫秒）
    #[serde(default = "now_ms")]
    pub updated_at_ms: u64,
}

impl CronTask {
    pub(crate) fn set_status(&mut self, status: CronTaskStatus) {
        self.status = status;
        self.enabled = status.is_active();
        self.updated_at_ms = now_ms();
    }

    #[allow(dead_code)]
    pub(crate) fn is_active(&self) -> bool {
        self.status.is_active()
    }

    #[allow(dead_code)]
    pub(crate) fn is_enabled(&self) -> bool {
        self.status.is_enabled()
    }
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

/// 任务就地更新入参补丁（保持 cron_id 恒定不变，根除历史记录孤儿化）
#[derive(Debug, Clone, Default)]
pub(crate) struct CronTaskUpdatePatch {
    /// 新 cron 表达式（若提供且变动，校验并重算下一次触发时间，热重载协程）
    pub expression: Option<String>,
    /// 提示词变动（原地替换，严禁推进代际，不杀协程）
    pub prompt: Option<String>,
    /// 最大执行次数变动
    pub max_iterations: Option<Option<u64>>,
    /// 守护模式变动
    pub is_daemon: Option<bool>,
    /// 目标会话绑定变动
    pub target_session_id: Option<Option<String>>,
}

#[allow(dead_code)]
pub(crate) type CronTaskPatch = CronTaskUpdatePatch;

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
    #[allow(dead_code)]
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::InvalidExpression(_) | Self::NoNextFire(_) => codes::TOOL_INVALID_INPUT,
            Self::IdNotFound => codes::COMMON_NOT_FOUND,
        }
    }

    /// 错误文案
    #[allow(dead_code)]
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
    /// is_steering 受保护位，容量挤占时优先保留）。
    /// 当 `target_session_id` 为有效非空会话 ID 时路由至该目标会话，否则回退至 `sched-<cron_id>`。
    fn enqueue_steering(
        &self,
        cron_id: &str,
        text: String,
        enqueued_at_ms: u64,
        target_session_id: Option<&str>,
    );
}

/// 解析 steering 条目的目标 session_id：
/// - 当 `target_session_id` 为 `Some(sid)` 且 `sid.trim()` 非空时，返回 `sid.trim().to_string()`；
/// - 当 `target_session_id` 为 `None` 或空串时，回退至默认的 `sched-{cron_id}`。
pub(crate) fn resolve_steering_session_id(
    cron_id: &str,
    target_session_id: Option<&str>,
) -> String {
    match target_session_id.map(str::trim).filter(|s| !s.is_empty()) {
        Some(sid) => sid.to_string(),
        None => format!("sched-{cron_id}"),
    }
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
    /// 保存声明（安全合并，保留非调度业务字段）
    fn save(&self, task: &CronTask);
    /// 删除声明
    #[allow(dead_code)]
    fn remove(&self, cron_id: &str);
    /// 追加运行记录（到期触发时记录）
    fn append_run(&self, _record: &crate::workflow_commands::WorkflowRunRecord) {}
    /// 标记单条运行记录终态（完成 / 失败 / 取消）
    fn finish_run(
        &self,
        _workflow_id: &str,
        _run_id: &str,
        _status: &str,
        _finished_at_ms: u64,
        _duration_ms: u64,
        _error: Option<String>,
        _output_summary: Option<String>,
    ) {
    }
    /// 读取任务扩展元数据：(cwd, target_session_id)
    fn load_task_ext_meta(&self, _cron_id: &str) -> (Option<String>, Option<String>) {
        (None, None)
    }
    /// 检查目标会话是否存在（INT-04 僵尸会话自愈校验用）
    fn session_exists(&self, _session_id: &str) -> bool {
        true
    }
    /// 清除失效的目标会话绑定（INT-04 自愈降级回写用）
    fn clear_target_session_id(&self, _cron_id: &str) {}
}

/// 独立 run 拉起点（is_daemon 路径；A3 装配时以 RunProducer 适配注入）
#[async_trait]
pub(crate) trait DaemonRunLauncher: Send + Sync {
    /// 拉起独立 run（prompt 作为初始消息）；失败返回 false 供降级
    async fn launch(&self, prompt: String) -> bool;
}

/// 定时任务执行上下文（自然到期触发与手动立即触发共用，Phase 2）
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct ScheduledExecutionContext {
    /// 任务 ID（cron-<seq>）
    pub cron_id: String,
    /// 本次运行 ID（<cron_id>-fire-<iteration>）
    pub run_id: String,
    /// 执行提示词
    pub prompt: String,
    /// Cron 表达式原文
    pub expression: String,
    /// 第几次触发（从 1 起）
    pub iteration: u64,
    /// 触发时刻（epoch 毫秒）
    pub fired_at_ms: u64,
    /// 计划触发时刻（epoch 毫秒）
    pub scheduled_for_ms: u64,
    /// 触发来源（"cron" | "manual"）
    pub trigger_kind: String,
    /// 是否独立常驻模式
    pub is_daemon: bool,
    /// 绑定的目标会话 ID（None = 独立后台受管会话）
    pub target_session_id: Option<String>,
    /// 任务配置的工作目录（None 或空串时按 INT-02 回退至全局定时任务沙箱目录）
    pub cwd: Option<String>,
}

/// 定时任务真实执行启动回执句柄（Phase 2）
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct ScheduledRunHandle {
    /// 实际运行 ID
    pub run_id: String,
    /// 实际执行会话 ID（经历 INT-04 自愈后可能为新建后台会话 ID）
    pub session_id: String,
    /// true = 终态由异步后台运行钩子（如 drive_run_loop 收口）负责回写；
    /// false = launch_scheduled_task 返回时已完成执行，由调用方自动收口为 completed
    pub async_terminal_managed: bool,
    /// 当 async_terminal_managed == false 时携带的执行输出摘要
    pub immediate_output_summary: Option<String>,
}

/// 生产级定时任务真实执行启动器契约（Phase 2）
#[async_trait]
pub(crate) trait ScheduledTaskLauncher: Send + Sync {
    /// 拉起一次真实定时任务执行
    async fn launch_scheduled_task(
        &self,
        ctx: ScheduledExecutionContext,
    ) -> Result<ScheduledRunHandle, CoreError>;
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
    fn enqueue_steering(
        &self,
        cron_id: &str,
        text: String,
        enqueued_at_ms: u64,
        target_session_id: Option<&str>,
    ) {
        let entry = SteeringInputEntry {
            session_id: resolve_steering_session_id(cron_id, target_session_id),
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

/// AgentEvent 适配事件槽（CronEvent → AgentEvent 单点映射）
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
    #[allow(dead_code)]
    pub(crate) fn wake_notify(&self) -> Arc<tokio::sync::Notify> {
        Arc::clone(&self.notify)
    }

    /// 取走缓冲事件（drain 转发 helper 与测试断言消费）
    #[allow(dead_code)]
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
            "cron 事件已发射（缓冲；drain 转发接线）"
        );
        self.buffered
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(agent_event);
        self.notify.notify_one();
    }
}

/// 安全字段合并：保留所有非调度业务字段（name, schedule, cwd, targetSessionId 等），
/// 仅覆盖更新调度运行态字段，彻底消灭双写抹杀。
fn safe_merge_task_json(existing_json: Option<&str>, task: &CronTask) -> Option<String> {
    let mut map: serde_json::Map<String, serde_json::Value> = match existing_json {
        Some(raw) => serde_json::from_str(raw).unwrap_or_default(),
        None => serde_json::Map::new(),
    };

    map.insert("cronId".to_string(), serde_json::json!(task.cron_id));
    map.insert("expression".to_string(), serde_json::json!(task.expression));
    map.insert("prompt".to_string(), serde_json::json!(task.prompt));
    map.insert("maxIterations".to_string(), serde_json::json!(task.max_iterations));
    map.insert("isDaemon".to_string(), serde_json::json!(task.is_daemon));
    map.insert("nextFireAtMs".to_string(), serde_json::json!(task.next_fire_at_ms));
    map.insert("firedCount".to_string(), serde_json::json!(task.fired_count));
    map.insert("status".to_string(), serde_json::json!(task.status));
    map.insert("enabled".to_string(), serde_json::json!(task.enabled));

    if let Some(ref target_sid) = task.target_session_id {
        map.insert("targetSessionId".to_string(), serde_json::json!(target_sid));
    }
    if !map.contains_key("createdAtMs") {
        map.insert("createdAtMs".to_string(), serde_json::json!(task.created_at_ms));
    }
    map.insert("updatedAtMs".to_string(), serde_json::json!(task.updated_at_ms));

    serde_json::to_string(&map).ok()
}

/// 内存持久化适配（测试 + 引擎默认装配）
#[derive(Default)]
pub(crate) struct MemorySchedStore {
    /// sched_<cron_id> → CronTask JSON
    map: Mutex<HashMap<String, String>>,
    /// 运行历史记录（供调度器测试断言 running → completed/failed 流转）
    runs: Mutex<Vec<crate::workflow_commands::WorkflowRunRecord>>,
    /// 测试用已知有效会话集合（None = 默认全部存在；Some = 仅集合内会话存在，供 INT-04 测试）
    existing_sessions: Mutex<Option<std::collections::HashSet<String>>>,
}

impl MemorySchedStore {
    /// 共享实例（重启恢复测试中两个注册表共用同一存储）
    pub(crate) fn shared() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// 读取内存中记录的运行历史（测试断言用）
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn load_runs(&self) -> Vec<crate::workflow_commands::WorkflowRunRecord> {
        self.runs.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// 设置测试环境中存在的会话列表（供 INT-04 僵尸会话自愈测试使用）
    #[cfg(test)]
    pub(crate) fn set_existing_sessions(&self, sessions: Vec<String>) {
        *self
            .existing_sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(sessions.into_iter().collect());
    }
}

/// 持久化键（`sched_` 前缀 + cron id）
fn store_key(cron_id: &str) -> String {
    format!("{SESSION_META_SCHED_KEY_PREFIX}{cron_id}")
}

fn extract_ext_meta_from_json(raw: &str) -> (Option<String>, Option<String>) {
    let Ok(val) = serde_json::from_str::<serde_json::Value>(raw) else {
        return (None, None);
    };
    let cwd = val
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let target_sid = val
        .get("targetSessionId")
        .or_else(|| val.get("target_session_id"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    (cwd, target_sid)
}

impl SchedStore for MemorySchedStore {
    fn load_all(&self) -> Vec<CronTask> {
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter_map(|json| {
                let mut t: CronTask = serde_json::from_str(json).ok()?;
                // 存量数据校准：如果历史只有 enabled: false 且 status 未存，校准为 Cancelled
                if !t.enabled && t.status == CronTaskStatus::Active {
                    t.status = CronTaskStatus::Cancelled;
                }
                Some(t)
            })
            .collect()
    }

    fn save(&self, task: &CronTask) {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let key = store_key(&task.cron_id);
        let existing = map.get(&key).map(|s| s.as_str());
        if let Some(merged_json) = safe_merge_task_json(existing, task) {
            map.insert(key, merged_json);
        } else if let Ok(json) = serde_json::to_string(task) {
            map.insert(key, json);
        }
    }

    fn remove(&self, cron_id: &str) {
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&store_key(cron_id));
    }

    fn append_run(&self, record: &crate::workflow_commands::WorkflowRunRecord) {
        let mut runs = self.runs.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(pos) = runs
            .iter()
            .position(|r| r.workflow_id == record.workflow_id && r.run_id == record.run_id)
        {
            runs[pos] = record.clone();
        } else {
            runs.push(record.clone());
        }
    }

    fn finish_run(
        &self,
        workflow_id: &str,
        run_id: &str,
        status: &str,
        finished_at_ms: u64,
        duration_ms: u64,
        error: Option<String>,
        output_summary: Option<String>,
    ) {
        let mut runs = self.runs.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(run) = runs
            .iter_mut()
            .find(|r| r.workflow_id == workflow_id && r.run_id == run_id)
        {
            run.status = status.to_string();
            run.finished_at_ms = Some(finished_at_ms);
            run.duration_ms = Some(duration_ms);
            run.error = error;
            run.output_summary = output_summary;
        } else {
            let started_at_ms = finished_at_ms.saturating_sub(duration_ms);
            runs.push(crate::workflow_commands::WorkflowRunRecord {
                workflow_id: workflow_id.to_string(),
                run_id: run_id.to_string(),
                session_id: None,
                trigger_kind: "cron".to_string(),
                scheduled_for_ms: started_at_ms,
                started_at_ms,
                finished_at_ms: Some(finished_at_ms),
                duration_ms: Some(duration_ms),
                status: status.to_string(),
                prompt: String::new(),
                error,
                output_summary,
            });
        }
    }

    fn load_task_ext_meta(&self, cron_id: &str) -> (Option<String>, Option<String>) {
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&store_key(cron_id))
            .map(|raw| extract_ext_meta_from_json(raw))
            .unwrap_or((None, None))
    }

    fn session_exists(&self, session_id: &str) -> bool {
        match self
            .existing_sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            Some(set) => set.contains(session_id),
            None => true,
        }
    }

    fn clear_target_session_id(&self, cron_id: &str) {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let key = store_key(cron_id);
        if let Some(raw) = map.get(&key) {
            if let Ok(mut obj) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(raw) {
                obj.remove("targetSessionId");
                obj.remove("target_session_id");
                if let Ok(updated) = serde_json::to_string(&obj) {
                    map.insert(key, updated);
                }
            }
        }
    }
}

/// LocalDb session_meta 真适配（键 `sched_<cron_id>` + 统一索引 `sched_index`）。
#[derive(Clone)]
pub(crate) struct LocalDbSchedStore {
    db: LocalDb,
}

impl LocalDbSchedStore {
    /// 新建真适配（db 由装配点提供）
    pub(crate) fn new(db: LocalDb) -> Self {
        Self { db }
    }
}

impl SchedStore for LocalDbSchedStore {
    fn load_all(&self) -> Vec<CronTask> {
        // 读取 sched_index 索引
        let mut index: Vec<String> = self
            .db
            .get_session_meta(SESSION_META_SCHED_INDEX_KEY)
            .ok()
            .flatten()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default();

        // 兼容合并存量 sched_ids 中的 ID
        let legacy_index: Vec<String> = self
            .db
            .get_session_meta(LEGACY_SESSION_META_SCHED_INDEX_KEY)
            .ok()
            .flatten()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default();

        let mut changed = false;
        for id in legacy_index {
            if !index.contains(&id) {
                index.push(id);
                changed = true;
            }
        }
        if changed {
            if let Ok(json) = serde_json::to_string(&index) {
                let _ = self
                    .db
                    .set_session_meta(SESSION_META_SCHED_INDEX_KEY, &json);
            }
        }

        index
            .into_iter()
            .filter_map(|cron_id| {
                self.db
                    .get_session_meta(&store_key(&cron_id))
                    .ok()
                    .flatten()
                    .and_then(|json| {
                        let mut t: CronTask = serde_json::from_str(&json).ok()?;
                        if !t.enabled && t.status == CronTaskStatus::Active {
                            t.status = CronTaskStatus::Cancelled;
                        }
                        Some(t)
                    })
            })
            .collect()
    }

    fn save(&self, task: &CronTask) {
        // 落实 Safe Field Merge：在 save 时使用 LocalDb::update_session_meta 保留非调度业务字段
        let task_clone = task.clone();
        let _ = self.db.update_session_meta(&store_key(&task.cron_id), move |curr| {
            safe_merge_task_json(curr, &task_clone)
        });

        // 索引幂等原子追加
        let cron_id = task.cron_id.clone();
        let _ = self.db.update_session_meta(SESSION_META_SCHED_INDEX_KEY, move |curr| {
            let mut index: Vec<String> = curr
                .and_then(|raw| serde_json::from_str(raw).ok())
                .unwrap_or_default();
            if !index.contains(&cron_id) {
                index.push(cron_id);
            }
            serde_json::to_string(&index).ok()
        });
    }

    fn remove(&self, cron_id: &str) {
        let key = store_key(cron_id);
        let _ = self.db.write_blocking(move |conn| {
            let _ = conn.execute(
                "DELETE FROM session_meta WHERE key = ?1",
                rusqlite::params![key],
            );
            Ok(())
        });

        let cron_id_str = cron_id.to_string();
        let _ = self.db.update_session_meta(SESSION_META_SCHED_INDEX_KEY, move |curr| {
            let mut index: Vec<String> = curr
                .and_then(|raw| serde_json::from_str(raw).ok())
                .unwrap_or_default();
            index.retain(|id| id != &cron_id_str);
            serde_json::to_string(&index).ok()
        });
    }

    fn append_run(&self, record: &crate::workflow_commands::WorkflowRunRecord) {
        use crate::workflow_commands::WorkflowStore;
        let store = crate::workflow_commands::SessionMetaWorkflowStore::new(self.db.clone());
        store.append_or_update_run(record.clone());
    }

    fn finish_run(
        &self,
        workflow_id: &str,
        run_id: &str,
        status: &str,
        finished_at_ms: u64,
        duration_ms: u64,
        error: Option<String>,
        output_summary: Option<String>,
    ) {
        use crate::workflow_commands::WorkflowStore;
        let store = crate::workflow_commands::SessionMetaWorkflowStore::new(self.db.clone());
        store.update_run_finish(
            workflow_id,
            run_id,
            status,
            finished_at_ms,
            duration_ms,
            error,
            output_summary,
        );
    }

    fn load_task_ext_meta(&self, cron_id: &str) -> (Option<String>, Option<String>) {
        self.db
            .get_session_meta(&store_key(cron_id))
            .ok()
            .flatten()
            .map(|raw| extract_ext_meta_from_json(&raw))
            .unwrap_or((None, None))
    }

    fn session_exists(&self, session_id: &str) -> bool {
        self.db
            .list_sessions()
            .map(|list| list.iter().any(|s| s.id == session_id))
            .unwrap_or(false)
    }

    fn clear_target_session_id(&self, cron_id: &str) {
        let _ = self.db.update_session_meta(&store_key(cron_id), |curr| {
            let mut obj: serde_json::Map<String, serde_json::Value> = curr
                .and_then(|raw| serde_json::from_str(raw).ok())
                .unwrap_or_default();
            obj.remove("targetSessionId");
            obj.remove("target_session_id");
            serde_json::to_string(&obj).ok()
        });
    }
}

// ── SchedulerRegistry（T-CF-09 / Phase 1 & Phase 2）──────────────────

/// 活跃 cron 条目（tasks 表值）
struct CronEntry {
    /// 运行态声明（fired_count / next_fire_at / status 实时刷新）
    task: CronTask,
    /// 状态机状态（Active / Paused）
    status: CronTaskStatus,
    /// 协程代际编号（仅在物理协程重建或销毁时自增，落实 CRIT-01）
    generation: u64,
    /// 触发任务（cancel 经 abort 取消；pause 置 None；fire/resume 重建）
    sleep_task: Option<tokio::task::JoinHandle<()>>,
}

/// 注册表组件集合
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
    /// 生产级定时任务真实执行启动器（Phase 2；None = 回退存量 launcher / steering）
    scheduled_launcher: Arc<Mutex<Option<Arc<dyn ScheduledTaskLauncher>>>>,
    /// 暂停开关（pauseAutomation 落点）
    pause: Arc<Mutex<Option<u64>>>,
    /// 测试钩子：固定短触发延迟
    #[cfg(test)]
    fire_override: Arc<Mutex<Option<u64>>>,
}

/// Cron 调度注册表
pub(crate) struct SchedulerRegistry {
    /// 组件集合（触发任务克隆用）
    components: SchedulerComponents,
    /// cron-<seq> 原子计数
    seq: AtomicU64,
    /// 启动恢复幂等守卫：防重入锁，确保 restore().await 幂等
    restored: Arc<AtomicBool>,
}

impl SchedulerRegistry {
    /// 新建注册表（初始化时通过 store.load_all() 提取最大序列号初始化 seq，关闭冷启动撞号竞态）
    pub(crate) fn new(
        pending: Arc<dyn PendingSink>,
        events: Arc<dyn EventSink>,
        store: Arc<dyn SchedStore>,
        launcher: Option<Arc<dyn DaemonRunLauncher>>,
    ) -> Self {
        let mut max_seq = 0u64;
        for task in store.load_all() {
            if let Some(seq) = cron_seq(&task.cron_id) {
                max_seq = max_seq.max(seq + 1);
            }
        }
        Self {
            components: SchedulerComponents {
                tasks: Arc::new(Mutex::new(HashMap::new())),
                pending,
                events,
                store,
                launcher,
                scheduled_launcher: Arc::new(Mutex::new(None)),
                pause: Arc::new(Mutex::new(None)),
                #[cfg(test)]
                fire_override: Arc::new(Mutex::new(None)),
            },
            seq: AtomicU64::new(max_seq),
            restored: Arc::new(AtomicBool::new(false)),
        }
    }

    /// 注入生产级定时任务真实执行启动器（Phase 2 CRIT-03：必须在 restore().await 之前完成注入）
    pub(crate) fn set_launcher(&self, launcher: Arc<dyn ScheduledTaskLauncher>) {
        *self
            .components
            .scheduled_launcher
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(launcher);
    }

    /// 清除指定任务的失效目标会话绑定（INT-04 僵尸会话自愈同步用）
    pub(crate) fn clear_target_session_id(&self, cron_id: &str) {
        if let Some(entry) = self
            .components
            .tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_mut(cron_id)
        {
            entry.task.target_session_id = None;
        }
        self.components.store.clear_target_session_id(cron_id);
    }

    /// 注册 cron 任务（T-CF-09 内容 1）
    pub(crate) async fn register(&self, input: CronTaskInput) -> Result<String, SchedulerError> {
        let schedule: CronSchedule = parse_cron(&input.expression)
            .map_err(|error| SchedulerError::InvalidExpression(format!("{error:?}")))?;
        let now = now_ms();
        let next_fire_at_ms = schedule
            .next_fire_after(now)
            .ok_or_else(|| SchedulerError::NoNextFire(input.expression.clone()))?;

        let seq = self.seq.fetch_add(1, Ordering::SeqCst);
        let cron_id = format!("{CRON_ID_PREFIX}{seq}");

        let task = CronTask {
            cron_id: cron_id.clone(),
            expression: input.expression,
            prompt: input.prompt,
            max_iterations: input.max_iterations,
            is_daemon: input.is_daemon,
            next_fire_at_ms,
            fired_count: 0,
            status: CronTaskStatus::Active,
            enabled: true,
            target_session_id: None,
            created_at_ms: now,
            updated_at_ms: now,
        };
        self.components.store.save(&task);

        let delay = fire_delay_ms(&self.components, next_fire_at_ms);
        let generation = 1;
        let handle = spawn_fire_task(self.components.clone(), task.clone(), delay, generation);
        self.components
            .tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                cron_id.clone(),
                CronEntry {
                    task,
                    status: CronTaskStatus::Active,
                    generation,
                    sleep_task: Some(handle),
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

    /// 暂停指定 cron 任务（严格遵循 AA-02 锁规约：精确 abort 对应 sleep_task，置空 sleep_task，generation += 1，status 置为 Paused，写库持久化）
    #[allow(dead_code)]
    pub(crate) async fn pause_task(&self, cron_id: &str) -> Result<(), CoreError> {
        let task_to_save: CronTask;

        {
            let mut tasks = self.components.tasks.lock().unwrap_or_else(|e| e.into_inner());
            let entry = tasks.get_mut(cron_id).ok_or_else(|| {
                CoreError::NotFound(format!("cron 任务 {cron_id} 不存在"))
            })?;

            if entry.status == CronTaskStatus::Paused {
                return Err(CoreError::invalid_input(format!("cron 任务 {cron_id} 已处于暂停态")));
            }
            if matches!(entry.status, CronTaskStatus::Completed | CronTaskStatus::Cancelled) {
                return Err(CoreError::invalid_input(format!(
                    "cron 任务 {cron_id} 已处于终态 ({:?})",
                    entry.status
                )));
            }

            // 精确 abort 对应 sleep_task，置空 sleep_task
            if let Some(handle) = entry.sleep_task.take() {
                handle.abort();
            }

            // 代际递增（防范触发协程段 3 错误复活）
            entry.generation += 1;

            // status 置为 Paused
            entry.status = CronTaskStatus::Paused;
            entry.task.set_status(CronTaskStatus::Paused);
            task_to_save = entry.task.clone();
        }

        // 锁外写库持久化
        self.components.store.save(&task_to_save);
        tracing::info!(target: "sched", cron_id, "cron 任务已暂停（协程已中止，status=Paused 已落库）");

        Ok(())
    }

    /// 恢复指定 cron 任务（重算 next_fire_after，generation += 1，spawn 新 sleep 协程，status 置为 Active，写库持久化）
    #[allow(dead_code)]
    pub(crate) async fn resume_task(&self, cron_id: &str) -> Result<(), CoreError> {
        let now = now_ms();
        let task_to_save: CronTask;
        let delay_ms: u64;

        {
            let mut tasks = self.components.tasks.lock().unwrap_or_else(|e| e.into_inner());
            let entry = tasks.get_mut(cron_id).ok_or_else(|| {
                CoreError::NotFound(format!("cron 任务 {cron_id} 不存在"))
            })?;

            if entry.status == CronTaskStatus::Active {
                return Err(CoreError::invalid_input(format!("cron 任务 {cron_id} 已处于活跃态")));
            }
            if matches!(entry.status, CronTaskStatus::Completed | CronTaskStatus::Cancelled) {
                return Err(CoreError::invalid_input(format!(
                    "cron 任务 {cron_id} 已处于终态 ({:?})",
                    entry.status
                )));
            }

            // 重算 next_fire_after
            let schedule = parse_cron(&entry.task.expression)
                .map_err(|e| CoreError::invalid_input(format!("cron 表达式非法：{e:?}")))?;
            let next = schedule
                .next_fire_after(now)
                .ok_or_else(|| CoreError::invalid_input(format!("cron 表达式 {} 无未来触发时刻", entry.task.expression)))?;

            entry.task.next_fire_at_ms = next;
            entry.status = CronTaskStatus::Active;
            entry.task.set_status(CronTaskStatus::Active);

            // 代际递增
            entry.generation += 1;

            delay_ms = fire_delay_ms(&self.components, next);
            task_to_save = entry.task.clone();

            // spawn 新 sleep 协程
            let handle = spawn_fire_task(self.components.clone(), entry.task.clone(), delay_ms, entry.generation);
            if let Some(old_h) = entry.sleep_task.replace(handle) {
                old_h.abort();
            }
        }

        // 锁外写库持久化
        self.components.store.save(&task_to_save);
        tracing::info!(
            target: "sched",
            cron_id,
            delay_ms,
            "cron 任务已恢复（未来时刻已重算，status=Active 已落库）"
        );

        Ok(())
    }

    /// 原地就地更新 cron 任务（严守 CRIT-01 代际-协程物理绑定铁律）
    #[allow(dead_code)]
    pub(crate) async fn update_task(
        &self,
        cron_id: &str,
        patch: CronTaskUpdatePatch,
    ) -> Result<(), CoreError> {
        let now = now_ms();
        let task_to_save: CronTask;

        {
            let mut tasks = self.components.tasks.lock().unwrap_or_else(|e| e.into_inner());
            let entry = tasks.get_mut(cron_id).ok_or_else(|| {
                CoreError::NotFound(format!("cron 任务 {cron_id} 不存在"))
            })?;

            if matches!(entry.status, CronTaskStatus::Completed | CronTaskStatus::Cancelled) {
                return Err(CoreError::invalid_input(format!(
                    "cron 任务 {cron_id} 已处于终态 ({:?})，不可修改",
                    entry.status
                )));
            }

            let mut schedule_changed = false;

            // 1. 表达式变更与校验
            if let Some(new_expr) = patch.expression {
                let trimmed = new_expr.trim().to_string();
                if trimmed != entry.task.expression {
                    let schedule = parse_cron(&trimmed)
                        .map_err(|e| CoreError::invalid_input(format!("cron 表达式非法：{e:?}")))?;
                    let next = schedule
                        .next_fire_after(now)
                        .ok_or_else(|| CoreError::invalid_input(format!("cron 表达式 {trimmed} 无未来触发时刻")))?;

                    entry.task.expression = trimmed;
                    entry.task.next_fire_at_ms = next;
                    schedule_changed = true;
                }
            }

            // 2. 提示词变更（原地更新，绝不杀协程，绝不推进代际！）
            if let Some(new_prompt) = patch.prompt {
                let trimmed = new_prompt.trim().to_string();
                if !trimmed.is_empty() {
                    entry.task.prompt = trimmed;
                }
            }

            // 3. 最大执行次数变更
            if let Some(new_max) = patch.max_iterations {
                entry.task.max_iterations = new_max;
            }

            // 4. 守护模式与会话绑定变更
            if let Some(is_daemon) = patch.is_daemon {
                entry.task.is_daemon = is_daemon;
            }
            if let Some(target_sid) = patch.target_session_id {
                entry.task.target_session_id = target_sid;
            }

            entry.task.updated_at_ms = now;

            // 5. 【CRIT-01 核心实现】：仅当 schedule 表达式改变且任务为 Active 时，才 abort 旧协程、generation += 1 并拉起新协程！
            // 若仅修改 prompt、is_daemon、target_session_id 等静态参数，严禁推进 generation！就地更新 entry 字段，保留原倒计时协程！
            if schedule_changed && entry.status == CronTaskStatus::Active {
                entry.generation += 1;
                if let Some(old_h) = entry.sleep_task.take() {
                    old_h.abort();
                }
                let delay = fire_delay_ms(&self.components, entry.task.next_fire_at_ms);
                let new_h = spawn_fire_task(
                    self.components.clone(),
                    entry.task.clone(),
                    delay,
                    entry.generation,
                );
                entry.sleep_task = Some(new_h);
                tracing::info!(target: "sched", cron_id, delay, "cron 调度表达式已热重载并重启协程");
            }

            task_to_save = entry.task.clone();
        }

        // 6. 锁外执行落盘
        self.components.store.save(&task_to_save);
        tracing::info!(target: "sched", cron_id, "cron 任务已就地热更新");

        Ok(())
    }

    /// 取消 / 删除 cron 任务：abort 协程，从 tasks 活跃表移除，标记 Cancelled
    pub(crate) async fn cancel(&self, cron_id: &str) -> Result<bool, SchedulerError> {
        let Some(mut entry) = self
            .components
            .tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(cron_id)
        else {
            return Err(SchedulerError::IdNotFound);
        };
        if let Some(h) = entry.sleep_task.take() {
            h.abort();
        }
        entry.generation += 1;
        entry.status = CronTaskStatus::Cancelled;
        entry.task.set_status(CronTaskStatus::Cancelled);
        let task = entry.task;
        self.components.store.save(&task);
        tracing::info!(
            target: "sched",
            cron_id,
            "cron 任务已取消（status=Cancelled 已落库）"
        );
        Ok(true)
    }

    /// 重启恢复（T-CF-09 内容 6 / Phase 1）：
    /// - 增加 restored 防重入锁，确保 restore().await 幂等；
    /// - 终态跳过；
    /// - Paused 任务加载进 tasks 内存表（sleep_task: None）；
    /// - 对离线过期需补发的任务，先将其插入 tasks 内存表（sleep_task: None），再异步派发补发协程，消除幽灵真空期；
    /// - 未到期任务按 next_fire_at_ms 重建 sleep。
    pub(crate) async fn restore(&self) {
        if self
            .restored
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            tracing::warn!(target: "sched", "SchedulerRegistry::restore 已被执行过，跳过重复调用");
            return;
        }

        let now = now_ms();
        for task in self.components.store.load_all() {
            // 序号推进（恢复的 id 防新注册撞号）
            if let Some(seq) = cron_seq(&task.cron_id) {
                self.seq.fetch_max(seq + 1, Ordering::SeqCst);
            }
            // 终态跳过：已完成或已取消
            if matches!(task.status, CronTaskStatus::Completed | CronTaskStatus::Cancelled) {
                continue;
            }
            if let Some(max) = task.max_iterations {
                if task.fired_count >= max {
                    continue;
                }
            }
            // Paused 任务：加载进 tasks 内存表，不启动协程
            if task.status == CronTaskStatus::Paused {
                tracing::info!(
                    target: "sched",
                    cron_id = %task.cron_id,
                    "重启恢复：加载已暂停任务（不启动协程）"
                );
                self.components
                    .tasks
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(
                        task.cron_id.clone(),
                        CronEntry {
                            task,
                            status: CronTaskStatus::Paused,
                            generation: 1,
                            sleep_task: None,
                        },
                    );
                continue;
            }

            if task.next_fire_at_ms <= now {
                // 已过期未触发：先插入 tasks 内存表消除真空期，再异步派发补发协程
                tracing::info!(
                    target: "sched",
                    cron_id = %task.cron_id,
                    "重启恢复：已过期未触发，先入 tasks 表消除真空期，再异步补发"
                );
                let generation = 1;
                self.components
                    .tasks
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(
                        task.cron_id.clone(),
                        CronEntry {
                            task: task.clone(),
                            status: CronTaskStatus::Active,
                            generation,
                            sleep_task: None,
                        },
                    );
                let comp = self.components.clone();
                let task_clone = task.clone();
                tokio::spawn(async move {
                    fire_cron(comp, task_clone, false, generation).await;
                });
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
            let generation = 1;
            let handle = spawn_fire_task(self.components.clone(), task.clone(), delay, generation);
            self.components
                .tasks
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(
                    task.cron_id.clone(),
                    CronEntry {
                        task,
                        status: CronTaskStatus::Active,
                        generation,
                        sleep_task: Some(handle),
                    },
                );
        }
    }

    /// 活跃判定（表内存在 Active 态任务即活跃；Paused / Completed / Cancelled 均为非活跃）
    pub(crate) fn has_active(&self) -> bool {
        self.components
            .tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .any(|entry| entry.status.is_active())
    }

    /// 全量快照（命令面 list-workflows 用；含已停止任务）
    pub(crate) fn snapshot(&self) -> Vec<CronTask> {
        self.components.store.load_all()
    }

    /// 获取单任务声明（优先内存表，回退 store）
    #[allow(dead_code)]
    pub(crate) fn get_task(&self, cron_id: &str) -> Option<CronTask> {
        let tasks = self.components.tasks.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = tasks.get(cron_id) {
            return Some(entry.task.clone());
        }
        self.components
            .store
            .load_all()
            .into_iter()
            .find(|t| t.cron_id == cron_id)
    }

    /// 测试钩子：注入固定短触发延迟（毫秒），免等分钟级真实触发
    #[cfg(test)]
    pub(crate) fn set_fire_override_ms(&self, ms: u64) {
        *self
            .components
            .fire_override
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(ms);
    }

    /// 暂停定时自动执行（R2-12c C31 pauseAutomation；F6 §8.2 全局内存态防抖开关）
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

    /// 当前暂停截止时刻（None = 未暂停）
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn pause_deadline(&self) -> Option<u64> {
        *self
            .components
            .pause
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    /// 测试钩子：直接设置暂停截止时刻
    #[cfg(test)]
    pub(crate) fn set_paused_until_ms_for_test(&self, until: Option<u64>) {
        *self
            .components
            .pause
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = until;
    }

    /// 测试钩子：重置恢复标记
    #[cfg(test)]
    #[allow(dead_code)]
    pub(crate) fn reset_restored_for_test(&self) {
        self.restored.store(false, Ordering::SeqCst);
    }
}

impl std::fmt::Debug for SchedulerRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SchedulerRegistry")
            .field("seq", &self.seq.load(Ordering::SeqCst))
            .field("restored", &self.restored.load(Ordering::SeqCst))
            .finish_non_exhaustive()
    }
}

/// 触发延迟（next_fire_at_ms 相对当前时刻；测试钩子：注入固定短延迟）
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

/// spawn 一次触发任务：sleep_until 到期 → fire_cron
fn spawn_fire_task(
    components: SchedulerComponents,
    task: CronTask,
    fire_delay_ms: u64,
    generation: u64,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        tokio::time::sleep_until(Instant::now() + Duration::from_millis(fire_delay_ms)).await;
        fire_cron(components, task, false, generation).await;
    })
}

/// 触发一次 cron（spawn 任务 / 重启补发共用）
async fn fire_cron(
    components: SchedulerComponents,
    task: CronTask,
    allow_rebuild_without_entry: bool,
    expected_gen: u64,
) {
    // 段 0（R2-12c C31 暂停门控）：暂停期内到点不触发
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
            let handle = spawn_fire_task(components.clone(), task.clone(), delay, expected_gen);
            let mut map = components.tasks.lock().unwrap_or_else(|e| e.into_inner());
            match map.get_mut(&task.cron_id) {
                Some(entry) if entry.status == CronTaskStatus::Active && entry.generation == expected_gen => {
                    entry.sleep_task = Some(handle);
                }
                None if allow_rebuild_without_entry => {
                    map.insert(
                        task.cron_id.clone(),
                        CronEntry {
                            task,
                            status: CronTaskStatus::Active,
                            generation: expected_gen,
                            sleep_task: Some(handle),
                        },
                    );
                }
                _ => handle.abort(),
            }
            return;
        }
    }

    // 代际防线：校验 if expected_gen != entry.generation { return; }
    let task_to_fire = {
        let map = components.tasks.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get(&task.cron_id) {
            if entry.generation != expected_gen || entry.status != CronTaskStatus::Active {
                tracing::info!(
                    target: "sched",
                    cron_id = %task.cron_id,
                    expected_gen,
                    current_gen = entry.generation,
                    status = ?entry.status,
                    "代际已变更或处于非活跃态，放弃触发"
                );
                return;
            }
            entry.task.clone()
        } else if allow_rebuild_without_entry {
            task.clone()
        } else {
            return;
        }
    };

    // 段 1：同步触发核心（幂等守卫 / 事件 / 计数 / 落库）
    let outcome = match std::panic::catch_unwind(AssertUnwindSafe(|| fire_once(&components, &task_to_fire))) {
        Ok(Some(outcome)) => outcome,
        Ok(None) => return,
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

    // 段 2：唤醒面 / 真实 Agent 启动面（事件与数据面已落库；唤醒摘要按 §4.8 Cron 模板拼接）
    let fire_text = format!(
        "{}（cron {} 第 {} 次触发）",
        outcome.task.prompt, outcome.task.cron_id, outcome.iteration
    );
    let scheduled_launcher = components
        .scheduled_launcher
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if let Some(sched_launcher) = scheduled_launcher {
        let ctx = ScheduledExecutionContext {
            cron_id: outcome.task.cron_id.clone(),
            run_id: outcome.run_id.clone(),
            prompt: outcome.task.prompt.clone(),
            expression: outcome.task.expression.clone(),
            iteration: outcome.iteration,
            fired_at_ms: outcome.fired_at_ms,
            scheduled_for_ms: outcome.scheduled_for_ms,
            trigger_kind: "cron".to_string(),
            is_daemon: outcome.task.is_daemon,
            target_session_id: outcome.effective_target_session_id.clone(),
            cwd: outcome.cwd.clone(),
        };
        match sched_launcher.launch_scheduled_task(ctx).await {
            Ok(handle) => {
                if !handle.async_terminal_managed {
                    let finish_now = now_ms();
                    let duration_ms = finish_now.saturating_sub(outcome.fired_at_ms);
                    components.store.finish_run(
                        &outcome.task.cron_id,
                        &outcome.run_id,
                        "completed",
                        finish_now,
                        duration_ms,
                        None,
                        handle.immediate_output_summary,
                    );
                }
            }
            Err(err) => {
                tracing::warn!(
                    target: "sched",
                    cron_id = %outcome.task.cron_id,
                    run_id = %outcome.run_id,
                    error = %err,
                    "ScheduledTaskLauncher 拉起失败，回写 failed 状态并降级 steering 唤醒"
                );
                let finish_now = now_ms();
                let duration_ms = finish_now.saturating_sub(outcome.fired_at_ms);
                components.store.finish_run(
                    &outcome.task.cron_id,
                    &outcome.run_id,
                    "failed",
                    finish_now,
                    duration_ms,
                    Some(err.to_string()),
                    None,
                );
                components.pending.enqueue_steering(
                    &outcome.task.cron_id,
                    fire_text,
                    outcome.fired_at_ms,
                    outcome
                        .effective_target_session_id
                        .as_deref()
                        .or(outcome.task.target_session_id.as_deref()),
                );
            }
        }
    } else {
        let target_sid = outcome
            .effective_target_session_id
            .as_deref()
            .or(outcome.task.target_session_id.as_deref());
        let launcher = components.launcher.clone();
        if outcome.task.is_daemon {
            let launched = match launcher {
                Some(launcher) => {
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
                    target_sid,
                );
            }
        } else {
            components.pending.enqueue_steering(
                &outcome.task.cron_id,
                fire_text,
                outcome.fired_at_ms,
                target_sid,
            );
        }
    }

    // 段 3：停止判定 / 重建下一次 sleep（同步，catch_unwind 兜底）
    let close = std::panic::catch_unwind(AssertUnwindSafe(|| {
        if outcome.reached_max || outcome.no_next {
            // 终态代际防线：在 reached_max 或 no_next 分支，从 tasks 移除前必须校验 entry.generation == expected_gen
            let mut map = components.tasks.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(entry) = map.get(&outcome.task.cron_id) {
                if entry.generation == expected_gen {
                    map.remove(&outcome.task.cron_id);
                    if outcome.reached_max {
                        if let Some(max) = outcome.task.max_iterations {
                            components.pending.enqueue_steering(
                                &outcome.task.cron_id,
                                format!(
                                    "cron {} 已达最大触发次数 {}，已停止",
                                    outcome.task.cron_id, max
                                ),
                                now_ms(),
                                outcome
                                    .effective_target_session_id
                                    .as_deref()
                                    .or(outcome.task.target_session_id.as_deref()),
                            );
                        }
                    } else {
                        tracing::warn!(
                            target: "sched",
                            cron_id = %outcome.task.cron_id,
                            "cron 无后续触发时刻，已停止（status=Completed 已落库）"
                        );
                    }
                } else {
                    tracing::info!(
                        target: "sched",
                        cron_id = %outcome.task.cron_id,
                        current_gen = entry.generation,
                        expected_gen,
                        "代际已变更，豁免终态清理"
                    );
                }
            }
        } else {
            // 提示词防冲刷：在段 3，严禁粗暴 entry.task = outcome.task！
            // 更新统计字段（fired_count, next_fire_at_ms, updated_at_ms），
            // 使用 entry 当前内存最新的 prompt 与配置派生下一次计时协程
            let delay = fire_delay_ms(&components, outcome.task.next_fire_at_ms);
            let mut map = components.tasks.lock().unwrap_or_else(|e| e.into_inner());
            match map.get_mut(&outcome.task.cron_id) {
                Some(entry) if entry.status == CronTaskStatus::Active && entry.generation == expected_gen => {
                    entry.task.fired_count = outcome.task.fired_count;
                    entry.task.next_fire_at_ms = outcome.task.next_fire_at_ms;
                    entry.task.updated_at_ms = outcome.task.updated_at_ms;

                    let next_task = entry.task.clone();
                    let handle = spawn_fire_task(components.clone(), next_task, delay, expected_gen);
                    if let Some(old_h) = entry.sleep_task.replace(handle) {
                        old_h.abort();
                    }
                }
                None if allow_rebuild_without_entry => {
                    let handle = spawn_fire_task(components.clone(), outcome.task.clone(), delay, expected_gen);
                    map.insert(
                        outcome.task.cron_id.clone(),
                        CronEntry {
                            task: outcome.task,
                            status: CronTaskStatus::Active,
                            generation: expected_gen,
                            sleep_task: Some(handle),
                        },
                    );
                }
                _ => {
                    tracing::info!(
                        target: "sched",
                        cron_id = %outcome.task.cron_id,
                        "触发收口时检测到任务非 Active 或代际已变更，中止重建，防复活守卫生效"
                    );
                }
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
    task: CronTask,
    run_id: String,
    iteration: u64,
    fired_at_ms: u64,
    scheduled_for_ms: u64,
    reached_max: bool,
    no_next: bool,
    effective_target_session_id: Option<String>,
    cwd: Option<String>,
}

fn fire_once(components: &SchedulerComponents, task: &CronTask) -> Option<FireOutcome> {
    if !task.status.is_active() {
        return None;
    }
    {
        let map = components.tasks.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get(&task.cron_id) {
            if entry.status != CronTaskStatus::Active {
                return None;
            }
        }
    }
    let now = now_ms();
    let iteration = task.fired_count + 1;
    let scheduled_for_ms = task.next_fire_at_ms;

    // 1. 事件（Critical 数据面落库）
    components.events.emit(CronEvent::Fired {
        cron_id: task.cron_id.clone(),
        prompt: task.prompt.clone(),
        expression: task.expression.clone(),
        iteration,
        fired_at_ms: now,
    });

    // 2. fired_count += 1 + 计算下一次触发时刻
    let mut updated = task.clone();
    updated.fired_count = iteration;
    updated.updated_at_ms = now;
    let mut no_next = false;
    match parse_cron(&task.expression) {
        Ok(schedule) => match schedule.next_fire_after(now) {
            Some(next) => updated.next_fire_at_ms = next,
            None => no_next = true,
        },
        Err(error) => {
            tracing::error!(
                target: "sched",
                cron_id = %task.cron_id,
                error = %format!("{error:?}"),
                "cron 表达式重解析失败（防御路径），停止任务"
            );
            no_next = true;
        }
    }

    // 3. MaxIterations 判定
    let reached_max = updated
        .max_iterations
        .is_some_and(|max| updated.fired_count >= max);
    if reached_max || no_next {
        updated.set_status(CronTaskStatus::Completed);
    }

    // 3b. INT-04 僵尸会话自愈检测：若绑定了 target_session_id 但该会话已被删除，自动降级为独立会话并清除失效绑定
    let (ext_cwd, ext_target_sid) = components.store.load_task_ext_meta(&task.cron_id);
    let candidate_target_sid = updated
        .target_session_id
        .clone()
        .or(ext_target_sid)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let mut target_sid_self_healed = false;
    let effective_target_session_id = match candidate_target_sid {
        Some(sid) => {
            if components.store.session_exists(&sid) {
                Some(sid)
            } else {
                tracing::warn!(
                    target: "sched",
                    cron_id = %task.cron_id,
                    invalid_session_id = %sid,
                    "到期触发检测：绑定的目标会话已不存在，自动自愈降级为独立后台会话并清除失效绑定（INT-04）"
                );
                updated.target_session_id = None;
                target_sid_self_healed = true;
                None
            }
        }
        None => None,
    };

    // 4. 防冲刷原子校验：在准备写库前，校验该任务在内存中是否仍处于 Active 态；若在计算期间已被外部置为 Paused/Cancelled，跳过保存
    {
        let mut map = components.tasks.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get_mut(&task.cron_id) {
            if entry.status != CronTaskStatus::Active {
                tracing::info!(
                    target: "sched",
                    cron_id = %task.cron_id,
                    status = ?entry.status,
                    "任务在触发计算期间已被置为非 Active 态，跳过保存防冲刷"
                );
                return None;
            }
            if target_sid_self_healed {
                entry.task.target_session_id = None;
            }
        }
    }

    // 5. 落库
    if target_sid_self_healed {
        components.store.clear_target_session_id(&task.cron_id);
    }
    components.store.save(&updated);

    // 6. 运行历史（绑定了生产 ScheduledTaskLauncher 时先写 running 初始态，待终态钩子回写；未绑定时保持单测同步闭环）
    let has_scheduled_launcher = components
        .scheduled_launcher
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_some();
    let run_id = format!("{}-fire-{}", task.cron_id, iteration);
    let run_record = if has_scheduled_launcher {
        let session_id = effective_target_session_id
            .clone()
            .unwrap_or_else(|| format!("sched-run-{}-{}", task.cron_id, now));
        crate::workflow_commands::WorkflowRunRecord {
            workflow_id: task.cron_id.clone(),
            run_id: run_id.clone(),
            session_id: Some(session_id),
            trigger_kind: "cron".to_string(),
            scheduled_for_ms,
            started_at_ms: now,
            finished_at_ms: None,
            duration_ms: None,
            status: "running".to_string(),
            prompt: task.prompt.clone(),
            error: None,
            output_summary: None,
        }
    } else {
        let session_id = effective_target_session_id
            .clone()
            .unwrap_or_else(|| format!("sched-{}-{}", task.cron_id, iteration));
        crate::workflow_commands::WorkflowRunRecord {
            workflow_id: task.cron_id.clone(),
            run_id: run_id.clone(),
            session_id: Some(session_id),
            trigger_kind: "cron".to_string(),
            scheduled_for_ms,
            started_at_ms: now,
            finished_at_ms: Some(now),
            duration_ms: Some(0),
            status: "completed".to_string(),
            prompt: task.prompt.clone(),
            error: None,
            output_summary: Some(format!("定时调度自动触发（第 {} 次）", iteration)),
        }
    };
    components.store.append_run(&run_record);

    Some(FireOutcome {
        task: updated,
        run_id,
        iteration,
        fired_at_ms: now,
        scheduled_for_ms,
        reached_max,
        no_next,
        effective_target_session_id,
        cwd: ext_cwd,
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

    /// 测试桩：is_daemon run 拉起点
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

    fn snapshot_queue(queue: &Arc<Mutex<PendingMessageQueue>>) -> Vec<SteeringInputEntry> {
        queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .dequeue_all()
    }

    fn queue_len(queue: &Arc<Mutex<PendingMessageQueue>>) -> usize {
        queue.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

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

    fn test_registry() -> (
        Arc<SchedulerRegistry>,
        Arc<Mutex<PendingMessageQueue>>,
        Arc<ProbeEvents>,
        Arc<MemorySchedStore>,
    ) {
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

    fn test_input(expression: &str, max_iterations: Option<u64>, is_daemon: bool) -> CronTaskInput {
        CronTaskInput {
            expression: expression.to_string(),
            prompt: "检查编译结果".to_string(),
            max_iterations,
            is_daemon,
        }
    }

    // ── T-CF-09：触发 / MaxIterations / IsDaemon / 恢复 / 非法表达式 ──

    #[tokio::test]
    async fn scheduler_registry_fires_cron_steering() {
        let (registry, pending, events, store) = test_registry();
        registry.set_fire_override_ms(40);
        let cron_id = registry
            .register(test_input("* * * * *", Some(1), false))
            .await
            .expect("注册应成功");
        assert_eq!(cron_id, "cron-0");

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

        let persisted = store.load_all();
        assert_eq!(persisted.len(), 1);
        assert_eq!(persisted[0].fired_count, 1, "应恰好触发一次");
        assert_eq!(persisted[0].status, CronTaskStatus::Completed);
        assert!(!persisted[0].enabled, "max 达到后应 enabled=false");
        assert!(!registry.has_active(), "停止后不应有活跃任务");
    }

    #[tokio::test]
    async fn scheduler_registry_max_iterations_stops() {
        let (registry, pending, events, store) = test_registry();
        registry.set_fire_override_ms(40);
        registry
            .register(test_input("* * * * *", Some(2), false))
            .await
            .expect("注册应成功");

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

        let emitted = events.emitted.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(emitted.len(), 2, "两次触发后应停止，无第三次事件");
        let iterations: Vec<u64> = emitted
            .iter()
            .map(|e| match e {
                CronEvent::Fired { iteration, .. } => *iteration,
            })
            .collect();
        assert_eq!(iterations, vec![1, 2], "触发次数应从 1 起逐次递增");

        let persisted = store.load_all();
        assert_eq!(persisted.len(), 1);
        assert_eq!(persisted[0].fired_count, 2);
        assert_eq!(persisted[0].status, CronTaskStatus::Completed);
        assert!(!persisted[0].enabled);
        assert!(!registry.has_active(), "任务清除后不应有活跃条目");
    }

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

        let prompts = launcher.prompts.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(
            prompts.as_slice(),
            &["守护进程检查".to_string()],
            "run 拉起应恰好一次，prompt 为初始消息"
        );

        let entries = snapshot_queue(&queue);
        assert!(
            entries.iter().all(|e| !e.text.contains("第 1 次触发")),
            "daemon 成功路径不应注入触发条目：{entries:?}"
        );
        assert_eq!(entries.len(), 1, "max 停止后应仅完成通知");
        assert!(entries[0].text.contains("已达最大触发次数 1，已停止"));

        assert_eq!(
            events
                .emitted
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .len(),
            1
        );
    }

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
        assert!(launcher
            .prompts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty());
    }

    #[tokio::test]
    async fn scheduler_registry_persists_and_recovers() {
        let store = MemorySchedStore::shared();
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
            assert_eq!(persisted[0].status, CronTaskStatus::Active);
            persisted[0].next_fire_at_ms
        };

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
        assert_eq!(persisted[0].status, CronTaskStatus::Completed);
        assert!(!persisted[0].enabled);
        assert!(!registry_b.has_active());

        // 再次模拟重启 → Completed 跳过 → 不重复触发
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
            "Completed 的声明恢复后不得重复触发"
        );
        assert!(
            events_c
                .emitted
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty(),
            "Completed 的声明恢复后不得重复发射"
        );
        assert!(!registry_c.has_active());
    }

    #[tokio::test]
    async fn scheduler_registry_invalid_expression_rejected() {
        let (registry, _, _, store) = test_registry();
        let err = registry
            .register(test_input("0 0 9 * * *", None, false))
            .await;
        assert!(
            matches!(&err, Err(SchedulerError::InvalidExpression(_))),
            "6 字段表达式应被拒绝：{err:?}"
        );
        let err = registry
            .register(test_input("0 0 30 2 *", None, false))
            .await;
        assert!(
            matches!(&err, Err(SchedulerError::NoNextFire(_))),
            "2 月 30 日表达式应被拒绝：{err:?}"
        );
        assert!(store.load_all().is_empty(), "非法注册不得落库");
        assert!(!registry.has_active(), "非法注册不得产生活跃条目");
        assert_eq!(
            SchedulerError::InvalidExpression("x".into()).code(),
            codes::TOOL_INVALID_INPUT
        );
        assert_eq!(SchedulerError::IdNotFound.code(), codes::COMMON_NOT_FOUND);
    }

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
        assert_eq!(persisted[0].status, CronTaskStatus::Cancelled);
        assert!(!persisted[0].enabled, "取消应 enabled=false 落库");
        assert!(!registry.has_active());

        let again = registry.cancel(&cron_id).await;
        assert!(matches!(again, Err(SchedulerError::IdNotFound)));
    }

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
            status: CronTaskStatus::Completed,
            enabled: false,
            target_session_id: None,
            created_at_ms: 10_000,
            updated_at_ms: 10_000,
        };
        let json = serde_json::to_value(&task).expect("序列化应成功");
        assert_eq!(json["cronId"], "cron-3");
        assert_eq!(json["expression"], "0 9 * * *");
        assert_eq!(json["prompt"], "日报");
        assert_eq!(json["maxIterations"], 2);
        assert_eq!(json["isDaemon"], true);
        assert_eq!(json["nextFireAtMs"], 12_345);
        assert_eq!(json["firedCount"], 1);
        assert_eq!(json["status"], "completed");
        assert_eq!(json["enabled"], false);

        let back: CronTask = serde_json::from_value(json).expect("反序列化应成功");
        assert_eq!(back, task);
    }

    #[test]
    fn steering_group_id_shape() {
        assert_eq!(steering_group_id("cron-0"), "cron-cron-0");
    }

    // ── R2-12c C31：全局暂停定时自动执行 ─────────────────────────────

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
        let refreshed = registry.pause_for(120);
        assert!(refreshed < first, "刷新应覆盖旧截止");
        assert_eq!(registry.pause_deadline(), Some(refreshed));
        assert!(store.load_all().is_empty(), "暂停不得落库（内存态）");
    }

    #[tokio::test]
    async fn scheduler_registry_pause_blocks_fire_then_resume_continues() {
        let (registry, pending, events, store) = test_registry();
        registry.set_fire_override_ms(40);
        let pause_until = now_ms() + 250;
        registry.set_paused_until_ms_for_test(Some(pause_until));
        registry
            .register(test_input("* * * * *", Some(2), false))
            .await
            .expect("注册应成功");
        assert!(registry.has_active(), "暂停不改变任务登记态");

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
        assert_eq!(emitted.len(), 2, "恢复后应照常触发两次");
        drop(emitted);
        let persisted = store.load_all();
        assert_eq!(persisted[0].fired_count, 2);
        assert_eq!(persisted[0].status, CronTaskStatus::Completed);
        assert!(!persisted[0].enabled, "max 达到后停止");
        assert!(!registry.has_active());
    }

    // ── 单任务生命周期原生测试：pause / resume / update / CRIT-01 ─────

    #[tokio::test]
    async fn scheduler_registry_pause_and_resume_task() {
        let (registry, pending, events, store) = test_registry();
        registry.set_fire_override_ms(40);
        let cron_id = registry
            .register(test_input("* * * * *", Some(5), false))
            .await
            .expect("注册成功");

        // 1. 单任务暂停
        registry.pause_task(&cron_id).await.expect("暂停应成功");
        assert!(!registry.has_active(), "暂停后不应有 Active 任务");

        // 验证内存与持久化状态
        let task_in_store = store.load_all();
        assert_eq!(task_in_store[0].status, CronTaskStatus::Paused);
        assert!(!task_in_store[0].enabled);

        // 等待超过触发时间，确保已 abort，无事件无 steering
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(events.emitted.lock().unwrap().is_empty());
        assert!(snapshot_queue(&pending).is_empty());

        // 重复暂停应报错
        let err = registry.pause_task(&cron_id).await;
        assert!(err.is_err());

        // 2. 恢复任务
        registry.resume_task(&cron_id).await.expect("恢复应成功");
        assert!(registry.has_active(), "恢复后应有 Active 任务");

        let task_in_store = store.load_all();
        assert_eq!(task_in_store[0].status, CronTaskStatus::Active);
        assert!(task_in_store[0].enabled);

        // 重复恢复应报错
        let err = registry.resume_task(&cron_id).await;
        assert!(err.is_err());

        // 等待触发一次
        let events_cond = Arc::clone(&events);
        wait_until("恢复后触发至少一次", move || {
            !events_cond.emitted.lock().unwrap().is_empty()
        })
        .await;
    }

    #[tokio::test]
    async fn test_update_task_crit_01_generation_binding() {
        let (registry, pending, events, store) = test_registry();
        registry.set_fire_override_ms(80);
        let cron_id = registry
            .register(test_input("* * * * *", Some(5), false))
            .await
            .expect("注册成功");

        // 初始 generation 必须为 1
        let initial_gen = {
            let map = registry.components.tasks.lock().unwrap();
            map.get(&cron_id).unwrap().generation
        };
        assert_eq!(initial_gen, 1);

        // 【CRIT-01 核心断言 1】：仅更新 prompt，严禁推进 generation，保留原倒计时协程！
        tokio::time::sleep(Duration::from_millis(20)).await;
        registry
            .update_task(
                &cron_id,
                CronTaskUpdatePatch {
                    prompt: Some("全新任务提示词".to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("更新 prompt 成功");

        let current_gen = {
            let map = registry.components.tasks.lock().unwrap();
            map.get(&cron_id).unwrap().generation
        };
        assert_eq!(
            current_gen, 1,
            "【CRIT-01 防御】：仅改 prompt 严禁推进 generation！"
        );

        // 等待到期，协程必须正常触发，且使用最新的 prompt 触发！
        let events_cond = Arc::clone(&events);
        wait_until("协程正常触发", move || {
            !events_cond.emitted.lock().unwrap().is_empty()
        })
        .await;

        let emitted = events.emitted.lock().unwrap();
        assert_eq!(emitted.len(), 1);
        match &emitted[0] {
            CronEvent::Fired { prompt, .. } => {
                assert_eq!(prompt, "全新任务提示词", "触发必须执行最新提示词！");
            }
        }
        drop(emitted);

        // 【CRIT-01 核心断言 2】：当表达式变动时，必须推进代际并重启协程
        registry
            .update_task(
                &cron_id,
                CronTaskUpdatePatch {
                    expression: Some("*/10 * * * *".to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("更新表达式成功");

        let new_gen = {
            let map = registry.components.tasks.lock().unwrap();
            map.get(&cron_id).unwrap().generation
        };
        assert_eq!(new_gen, 2, "表达式变更必须推进代际！");

        let in_store = store.load_all();
        assert_eq!(in_store[0].expression, "*/10 * * * *");
        assert_eq!(in_store[0].cron_id, cron_id, "就地更新保持 cron_id 恒定！");
        let _ = snapshot_queue(&pending);
    }

    #[tokio::test]
    async fn test_generation_race_defense_when_paused_during_countdown() {
        let (registry, pending, events, _) = test_registry();
        registry.set_fire_override_ms(150);
        let cron_id = registry
            .register(test_input("* * * * *", Some(2), false))
            .await
            .expect("注册成功");

        // 倒计时中途（50ms）用户点击暂停：generation 变为 2，sleep_task 被 abort
        tokio::time::sleep(Duration::from_millis(50)).await;
        registry.pause_task(&cron_id).await.expect("暂停成功");

        // 等待超过原 150ms 超时时刻
        tokio::time::sleep(Duration::from_millis(200)).await;

        // 触发被代际防线与状态守卫彻底拦截，绝不复活！
        assert!(events.emitted.lock().unwrap().is_empty(), "暂停后绝不得触发");
        assert!(snapshot_queue(&pending).is_empty());
        assert!(!registry.has_active());
    }

    // ── LocalDb 真适配测试：Safe Field Merge 与索引收敛 ──────────────────

    fn task(cron_id: &str) -> CronTask {
        CronTask {
            cron_id: cron_id.to_string(),
            expression: "0 9 * * *".to_string(),
            prompt: "日报".to_string(),
            max_iterations: Some(2),
            is_daemon: false,
            next_fire_at_ms: 1_000_000,
            fired_count: 0,
            status: CronTaskStatus::Active,
            enabled: true,
            target_session_id: None,
            created_at_ms: 0,
            updated_at_ms: 0,
        }
    }

    #[test]
    fn local_db_sched_store_roundtrip() {
        let db = LocalDb::open_in_memory().expect("内存库打开应成功");
        let store = LocalDbSchedStore::new(db);
        let first = task("cron-0");
        store.save(&first);
        let loaded = store.load_all();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0], first, "读回应与写入一致");

        store.save(&first);
        assert_eq!(store.load_all().len(), 1, "同 id 重复保存不得新增");

        let second = task("cron-1");
        store.save(&second);
        let all = store.load_all();
        assert_eq!(all.len(), 2, "多 id 经 sched_index 索引枚举齐全");
        assert!(all.iter().any(|t| t.cron_id == "cron-1"));
    }

    #[test]
    fn local_db_sched_store_safe_field_merge_preserves_business_fields() {
        let db = LocalDb::open_in_memory().expect("内存库打开应成功");
        let store = LocalDbSchedStore::new(db.clone());

        // 模拟上层业务写入包含 name, schedule 对象, cwd, targetSessionId 等业务元数据
        let raw_workflow_json = serde_json::json!({
            "id": "cron-0",
            "cronId": "cron-0",
            "name": "每日自动化审查",
            "schedule": { "type": "cron", "expression": "0 9 * * *" },
            "cwd": "C:/Software/conex",
            "targetSessionId": "sess-main",
            "prompt": "初始提示词",
            "status": "active",
            "enabled": true,
            "nextFireAtMs": 5000,
            "firedCount": 0,
            "createdAtMs": 1000,
            "updatedAtMs": 1000
        });
        db.set_session_meta(&store_key("cron-0"), &raw_workflow_json.to_string())
            .unwrap();
        db.set_session_meta(SESSION_META_SCHED_INDEX_KEY, r#"["cron-0"]"#)
            .unwrap();

        // 底层调度器更新 firedCount 与 nextFireAtMs
        let mut task_update = task("cron-0");
        task_update.fired_count = 3;
        task_update.next_fire_at_ms = 999_999;
        task_update.target_session_id = Some("sess-main".to_string());
        store.save(&task_update);

        // 验证底层读取
        let loaded = store.load_all();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].fired_count, 3);
        assert_eq!(loaded[0].next_fire_at_ms, 999_999);
        assert_eq!(loaded[0].target_session_id.as_deref(), Some("sess-main"));

        // 验证数据库原始 JSON：非调度字段 name, schedule, cwd, createdAtMs 被 100% 完整保留！
        let raw_json_str = db
            .get_session_meta(&store_key("cron-0"))
            .unwrap()
            .expect("key 必须存在");
        let merged_val: serde_json::Value = serde_json::from_str(&raw_json_str).unwrap();
        assert_eq!(merged_val["name"], "每日自动化审查", "业务字段 name 严禁被抹除！");
        assert_eq!(merged_val["cwd"], "C:/Software/conex", "业务字段 cwd 严禁被抹除！");
        assert_eq!(merged_val["schedule"]["type"], "cron", "业务字段 schedule 严禁被抹除！");
        assert_eq!(merged_val["createdAtMs"], 1000, "原创建时间必须被保留！");
        assert_eq!(merged_val["firedCount"], 3, "运行态 firedCount 必须被更新！");
    }

    #[test]
    fn local_db_sched_store_index_convergence_merges_legacy_sched_ids() {
        let db = LocalDb::open_in_memory().expect("内存库打开应成功");
        let store = LocalDbSchedStore::new(db.clone());

        // 存量历史写入 sched_ids
        db.set_session_meta(LEGACY_SESSION_META_SCHED_INDEX_KEY, r#"["cron-old-1", "cron-old-2"]"#)
            .unwrap();
        // 新系统写入 sched_index
        db.set_session_meta(SESSION_META_SCHED_INDEX_KEY, r#"["cron-new-1"]"#)
            .unwrap();

        store.save(&task("cron-old-1"));
        store.save(&task("cron-old-2"));
        store.save(&task("cron-new-1"));

        // load_all 触发自动合并
        let all = store.load_all();
        assert_eq!(all.len(), 3, "存量 sched_ids 与新 sched_index 必须无缝聚合！");

        // 校验 sched_index 已经自愈包含全部 3 个 ID
        let converged_index: Vec<String> = serde_json::from_str(
            &db.get_session_meta(SESSION_META_SCHED_INDEX_KEY)
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(converged_index.len(), 3);
        assert!(converged_index.contains(&"cron-old-1".to_string()));
        assert!(converged_index.contains(&"cron-old-2".to_string()));
        assert!(converged_index.contains(&"cron-new-1".to_string()));
    }

    #[test]
    fn local_db_sched_store_remove() {
        let db = LocalDb::open_in_memory().expect("内存库打开应成功");
        let store = LocalDbSchedStore::new(db.clone());

        store.save(&task("cron-0"));
        store.save(&task("cron-1"));
        assert_eq!(store.load_all().len(), 2);

        store.remove("cron-0");
        let remaining = store.load_all();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].cron_id, "cron-1");

        // 物理 key 必须已被 DELETE
        assert!(db.get_session_meta(&store_key("cron-0")).unwrap().is_none());
    }

    #[test]
    fn local_db_sched_store_recovers_across_instances() {
        let db = LocalDb::open_in_memory().expect("内存库打开应成功");
        {
            let store = LocalDbSchedStore::new(db.clone());
            store.save(&task("cron-0"));
            store.save(&task("cron-1"));
        }
        let store = LocalDbSchedStore::new(db);
        let loaded = store.load_all();
        assert_eq!(loaded.len(), 2, "重启后声明应完全恢复");
        assert!(loaded.iter().any(|t| t.cron_id == "cron-0"));
        assert!(loaded.iter().any(|t| t.cron_id == "cron-1"));
    }

    #[test]
    fn local_db_sched_store_fail_open() {
        let db = LocalDb::open_in_memory().expect("内存库打开应成功");
        let store = LocalDbSchedStore::new(db.clone());
        assert!(store.load_all().is_empty(), "空库 → 空集（fail-open）");

        let _ = db.set_session_meta(SESSION_META_SCHED_INDEX_KEY, r#"["cron-0"]"#);
        let _ = db.set_session_meta(&store_key("cron-0"), "not-json");
        assert!(store.load_all().is_empty(), "坏 JSON 键值 → 跳过不 panic");

        let _ = db.set_session_meta(SESSION_META_SCHED_INDEX_KEY, r#"["cron-9"]"#);
        assert!(store.load_all().is_empty(), "孤儿 id（键缺失）→ 跳过");

        let _ = db.set_session_meta(SESSION_META_SCHED_INDEX_KEY, "not-json");
        assert!(store.load_all().is_empty(), "索引坏 JSON → 空集");
    }

    #[tokio::test]
    async fn local_db_scheduler_registry_persists_and_recovers() {
        let db = LocalDb::open_in_memory().expect("内存库打开应成功");
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
            assert_eq!(persisted[0].status, CronTaskStatus::Active);
            persisted[0].next_fire_at_ms
        };

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
        assert_eq!(persisted[0].status, CronTaskStatus::Completed);
        assert!(!persisted[0].enabled);
        assert!(!registry_b.has_active());

        // 再次模拟重启 → Completed 跳过
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
                "Completed 的声明恢复后不得重复触发"
            );
            assert!(
                events
                    .emitted
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .is_empty(),
                "Completed 的声明恢复后不得重复发射"
            );
            assert!(!registry.has_active());
        }
    }

    #[tokio::test]
    async fn test_restore_idempotency_and_offline_task_pre_insert() {
        let store = MemorySchedStore::shared();
        let now = now_ms();
        let expired_task = CronTask {
            cron_id: "cron-offline-9".to_string(),
            expression: "* * * * *".to_string(),
            prompt: "离线补发测试".to_string(),
            max_iterations: Some(1),
            is_daemon: false,
            next_fire_at_ms: now.saturating_sub(10_000),
            fired_count: 0,
            status: CronTaskStatus::Active,
            enabled: true,
            target_session_id: Some("session-offline".to_string()),
            created_at_ms: now.saturating_sub(20_000),
            updated_at_ms: now.saturating_sub(20_000),
        };
        store.save(&expired_task);

        let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        let pending = Arc::new(QueuePendingSink::new(Arc::clone(&queue)));
        let events = Arc::new(ProbeEvents::default());
        let registry = Arc::new(SchedulerRegistry::new(
            pending,
            Arc::clone(&events) as Arc<dyn EventSink>,
            Arc::clone(&store) as Arc<dyn SchedStore>,
            None,
        ));

        // 1. 执行 restore()
        registry.restore().await;

        // 【核心断言 1】：离线补发任务在 restore() 返回瞬间必须已被预插入 tasks 表消除真空期
        assert!(
            registry.has_active(),
            "离线补发任务必须在 tasks 内存表中消除真空期"
        );

        // 【核心断言 2】：重复调用 restore() 幂等防重入守卫必须生效
        registry.restore().await;

        // 等待异步补发协程执行完成（max=1 停止）
        let events_cond = Arc::clone(&events);
        wait_until("离线补发完成", move || {
            !events_cond.emitted.lock().unwrap().is_empty()
        })
        .await;

        let emitted = events.emitted.lock().unwrap();
        assert_eq!(emitted.len(), 1, "离线过期任务恰好补发一次，幂等守卫防重复生效！");
        let persisted = store.load_all();
        assert_eq!(persisted[0].fired_count, 1);
        assert_eq!(persisted[0].status, CronTaskStatus::Completed);
    }

    struct ProbeScheduledLauncher {
        contexts: Mutex<Vec<ScheduledExecutionContext>>,
        should_fail: bool,
    }

    impl ProbeScheduledLauncher {
        fn new(should_fail: bool) -> Self {
            Self {
                contexts: Mutex::new(Vec::new()),
                should_fail,
            }
        }
    }

    #[async_trait]
    impl ScheduledTaskLauncher for ProbeScheduledLauncher {
        async fn launch_scheduled_task(
            &self,
            ctx: ScheduledExecutionContext,
        ) -> Result<ScheduledRunHandle, CoreError> {
            self.contexts
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(ctx.clone());
            tokio::time::sleep(Duration::from_millis(15)).await;
            if self.should_fail {
                Err(CoreError::Internal("模拟真实 Agent 启动失败".to_string()))
            } else {
                Ok(ScheduledRunHandle {
                    run_id: ctx.run_id,
                    session_id: ctx
                        .target_session_id
                        .unwrap_or_else(|| format!("sched-run-{}-{}", ctx.cron_id, ctx.fired_at_ms)),
                    async_terminal_managed: false,
                    immediate_output_summary: Some("自动调度执行完成".to_string()),
                })
            }
        }
    }

    #[tokio::test]
    async fn test_scheduled_task_launcher_real_async_terminal_writeback() {
        let store = MemorySchedStore::shared();
        let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        let pending = Arc::new(QueuePendingSink::new(Arc::clone(&queue)));
        let events = Arc::new(ProbeEvents::default());
        let registry = Arc::new(SchedulerRegistry::new(
            pending,
            Arc::clone(&events) as Arc<dyn EventSink>,
            Arc::clone(&store) as Arc<dyn SchedStore>,
            None,
        ));
        let launcher = Arc::new(ProbeScheduledLauncher::new(false));
        registry.set_launcher(Arc::clone(&launcher) as Arc<dyn ScheduledTaskLauncher>);
        registry.set_fire_override_ms(30);

        let cron_id = registry
            .register(test_input("* * * * *", Some(1), false))
            .await
            .expect("注册应成功");

        let store_cond = Arc::clone(&store);
        wait_until("ScheduledTaskLauncher 终态回写 completed", move || {
            let runs = store_cond.load_runs();
            runs.len() == 1 && runs[0].status == "completed"
        })
        .await;

        let runs = store.load_runs();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].workflow_id, cron_id);
        assert_eq!(runs[0].status, "completed");
        assert!(
            runs[0].duration_ms.unwrap_or(0) >= 10,
            "真实异步执行耗时应大于 0ms，实际: {:?}",
            runs[0].duration_ms
        );
        assert!(runs[0].finished_at_ms.is_some());
        let ctxs = launcher.contexts.lock().unwrap();
        assert_eq!(ctxs.len(), 1);
        assert_eq!(ctxs[0].cron_id, cron_id);
    }

    #[tokio::test]
    async fn test_scheduled_task_zombie_session_self_healing_int04() {
        let store = MemorySchedStore::shared();
        // 仅 valid-session 存在，zombie-session-deleted 已被删除
        store.set_existing_sessions(vec!["valid-session".to_string()]);

        let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        let pending = Arc::new(QueuePendingSink::new(Arc::clone(&queue)));
        let events = Arc::new(ProbeEvents::default());
        let registry = Arc::new(SchedulerRegistry::new(
            pending,
            Arc::clone(&events) as Arc<dyn EventSink>,
            Arc::clone(&store) as Arc<dyn SchedStore>,
            None,
        ));
        let launcher = Arc::new(ProbeScheduledLauncher::new(false));
        registry.set_launcher(Arc::clone(&launcher) as Arc<dyn ScheduledTaskLauncher>);
        registry.set_fire_override_ms(60);

        let cron_id = registry
            .register(test_input("* * * * *", Some(1), false))
            .await
            .expect("注册应成功");
        registry
            .update_task(
                &cron_id,
                CronTaskUpdatePatch {
                    expression: None,
                    prompt: None,
                    max_iterations: None,
                    is_daemon: None,
                    target_session_id: Some(Some("zombie-session-deleted".to_string())),
                },
            )
            .await
            .expect("更新 target_session_id 应成功");

        let store_cond = Arc::clone(&store);
        wait_until("僵尸会话自愈并完成执行", move || {
            let runs = store_cond.load_runs();
            runs.len() == 1 && runs[0].status == "completed"
        })
        .await;

        // 断言 1：持久化任务中的 target_session_id 已被自动抹除为 None
        let persisted = store.load_all();
        assert_eq!(persisted.len(), 1);
        assert_eq!(
            persisted[0].target_session_id, None,
            "已删除的目标会话 ID 必须在触发时自愈抹除"
        );

        // 断言 2：传递给 launcher 的上下文中 target_session_id 已降级为 None，且生成独立 sched-run-* 会话
        let ctxs = launcher.contexts.lock().unwrap();
        assert_eq!(ctxs.len(), 1);
        assert_eq!(ctxs[0].target_session_id, None);
        let runs = store.load_runs();
        assert!(
            runs[0]
                .session_id
                .as_deref()
                .unwrap_or("")
                .starts_with(&format!("sched-run-{cron_id}-")),
            "应降级至独立后台会话 sched-run-*，实际: {:?}",
            runs[0].session_id
        );
    }

    #[tokio::test]
    async fn test_steering_routes_to_bound_target_session_or_fallback() {
        let (registry, pending, events, _store) = test_registry();
        registry.set_fire_override_ms(60);

        // 1. 绑定 target_session_id = Some("sess-bound-chat-42".into()) 的任务
        let bound_cron_id = registry
            .register(test_input("* * * * *", Some(1), false))
            .await
            .expect("注册绑定任务应成功");
        registry
            .update_task(
                &bound_cron_id,
                CronTaskUpdatePatch {
                    target_session_id: Some(Some("sess-bound-chat-42".into())),
                    ..Default::default()
                },
            )
            .await
            .expect("绑定 target_session_id 应成功");

        let events_cond = Arc::clone(&events);
        let pending_cond = Arc::clone(&pending);
        wait_until("绑定任务触发并写入 steering 队列", move || {
            events_cond
                .emitted
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .len()
                == 1
                && queue_len(&pending_cond) == 1
        })
        .await;

        let bound_entries = snapshot_queue(&pending);
        assert_eq!(bound_entries.len(), 1);
        assert_eq!(
            bound_entries[0].session_id, "sess-bound-chat-42",
            "绑定了 target_session_id 时，SteeringInputEntry.session_id 必须精确路由至目标对话会话"
        );

        // 2. 未绑定 target_session_id（None）的任务：回退至默认的 sched-{cron_id}
        let unbound_cron_id = registry
            .register(test_input("* * * * *", Some(1), false))
            .await
            .expect("注册未绑定任务应成功");

        let events_cond2 = Arc::clone(&events);
        let pending_cond2 = Arc::clone(&pending);
        wait_until("未绑定任务触发并写入 steering 队列", move || {
            events_cond2
                .emitted
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .len()
                == 2
                && queue_len(&pending_cond2) == 1
        })
        .await;

        let unbound_entries = snapshot_queue(&pending);
        assert_eq!(unbound_entries.len(), 1);
        assert_eq!(
            unbound_entries[0].session_id,
            format!("sched-{unbound_cron_id}"),
            "未绑定 target_session_id 时，SteeringInputEntry.session_id 必须回退为 sched-<cron_id>"
        );
    }
}
