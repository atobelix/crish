//! Cron 调度注册表类型与契约定义（G9 调度面；T-CF-09，REQ-C03）

use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
#[cfg(test)]
use conex_types::error::codes;
use conex_types::events::AgentEvent;
use conex_types::CoreError;
use orchestrator::steering_queue::SteeringInputEntry;
use orchestrator::PendingMessageQueue;

/// cron id 前缀（`cron-<seq>`，命名风格对齐 `task-<seq>` / `timer-<seq>` 先例）
pub const CRON_ID_PREFIX: &str = "cron-";
/// session_meta 持久化键前缀（`sched_<cron_id>` 键）
pub const SESSION_META_SCHED_KEY_PREFIX: &str = "sched_";
/// 统一索引键（统一为 `sched_index`，与 workflow_commands.rs 对齐）
pub const SESSION_META_SCHED_INDEX_KEY: &str = "sched_index";
/// 历史索引键（兼容存量观察点与测试）
pub const LEGACY_SESSION_META_SCHED_INDEX_KEY: &str = "sched_ids";

/// 当前 epoch 毫秒（cron 全域时间基准）
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

/// 从 cron id 解析序号（`cron-<seq>` → `seq`；恢复时推进分配器防撞 id）
pub fn cron_seq(cron_id: &str) -> Option<u64> {
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
}

pub(crate) fn default_cron_status() -> CronTaskStatus {
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

#[cfg(test)]
impl SchedulerError {
    /// 错误码（映射 conex-types 码表；测试断言消费）
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::InvalidExpression(_) | Self::NoNextFire(_) => codes::TOOL_INVALID_INPUT,
            Self::IdNotFound => codes::COMMON_NOT_FOUND,
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

/// 独立 run 拉起点（is_daemon 路径；A3 装配时以 RunProducer 适配注入）
#[async_trait]
pub(crate) trait DaemonRunLauncher: Send + Sync {
    /// 拉起独立 run（prompt 作为初始消息）；失败返回 false 供降级
    async fn launch(&self, prompt: String) -> bool;
}

/// 定时任务执行上下文（自然到期触发与手动立即触发共用，Phase 2）
#[derive(Debug, Clone)]
pub(crate) struct ScheduledExecutionContext {
    /// 任务 ID（cron-<seq>）
    pub cron_id: String,
    /// 本次运行 ID（<cron_id>-fire-<iteration>）
    pub run_id: String,
    /// 执行提示词
    pub prompt: String,
    /// Cron 表达式原文
    #[allow(dead_code)]
    pub expression: String,
    /// 第几次触发（从 1 起）
    #[allow(dead_code)]
    pub iteration: u64,
    /// 触发时刻（epoch 毫秒）
    pub fired_at_ms: u64,
    /// 计划触发时刻（epoch 毫秒）
    #[allow(dead_code)]
    pub scheduled_for_ms: u64,
    /// 触发来源（"cron" | "manual"）
    #[allow(dead_code)]
    pub trigger_kind: String,
    /// 是否独立常驻模式
    #[allow(dead_code)]
    pub is_daemon: bool,
    /// 绑定的目标会话 ID（None = 独立后台受管会话）
    pub target_session_id: Option<String>,
    /// 任务配置的工作目录（None 或空串时按 INT-02 回退至全局定时任务沙箱目录）
    pub cwd: Option<String>,
}

/// 定时任务真实执行启动回执句柄（Phase 2）
#[derive(Debug, Clone)]
pub(crate) struct ScheduledRunHandle {
    /// 实际运行 ID
    #[allow(dead_code)]
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
    pub(crate) fn wake_notify(&self) -> Arc<tokio::sync::Notify> {
        Arc::clone(&self.notify)
    }

    /// 取走缓冲事件（drain 转发 helper 与测试断言消费）
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
