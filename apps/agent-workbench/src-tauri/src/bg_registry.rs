//! SR-05 · 拆分 · ≠ EL · 域：注册表（BackgroundTaskRegistry/TaskHandle/
//! OutputPreview + 构造注入面 + 事件桥/消费器接线 + 归档/容量生命周期）。
//! 结构拆分轮仅搬移，注册表语义零改动。接线：background.rs `mod bg_registry;`。

use crate::core_event_bridge::EventBridge;
use crate::process::now_millis;
use crate::resource::{sample_usage, ResourceMonitorConfig, TaskNotifier};
use agent_tools::background::{BackgroundTaskInfo, TaskState};
use agent_tools::definition::ToolError;
use conex_types::error::codes;
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;
use tokio::process::{Child, ChildStdin};
use tokio::sync::Mutex as TokioMutex;
use tokio::task::JoinHandle;

use super::bg_events::{EventBridgeSink, SamplerFn};

/// 默认保留时长：任务终止后 30 分钟归档（清内存条目与 .meta.json，T-AB-12 落地）
const DEFAULT_RETENTION: Duration = Duration::from_secs(30 * 60);

/// 内存预览行数上限（status.tail 取末 20 行，留余量）
const PREVIEW_MAX_LINES: usize = 200;
/// 内存预览字节上限（有界：长输出命令不驻留全量内存）
const PREVIEW_MAX_BYTES: usize = 64 * 1024;

/// 注册表条目上限（T-AB-12 5 容量兜底；继承旧 MAX_BACKGROUND_TASKS 语义 200）——
/// FIFO 淘汰，淘汰时若仍在运行先终止（比 30 分钟归档更硬的兜底）。
pub(crate) const MAX_BACKGROUND_TASKS: usize = 200;
/// 归档循环 tick 间隔（spawn_snapshot_loop 同款 60s 周期任务，T-AB-12 1）。
/// 用 std::thread 而非 tauri::async_runtime::spawn：归档清扫全部为同步操作
/// （锁 + 文件删除），不依赖 tokio/tauri runtime（测试进程同样可用）。
const ARCHIVE_TICK_SECS: u64 = 60;
/// 归档清扫 / kill 等待 writer 收口的最长等待（writer 在管道 EOF 后即完成，
/// 超时仅为防异常（孙进程持管道）拖住调用方）。
pub(crate) const WRITER_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

// ============================================================================
// 注册表与任务句柄
// ============================================================================

/// 后台任务注册表
///
/// - `tasks`: 任务注册表（Arc<TaskHandle>，writer 与查询方共享）；
/// - `task_seq`: `task-<seq>` 命名（命名空间独立于 pty id `pty/mod.rs:104-111`）；
/// - `log_root`: 任务日志根（`host_paths::app_dir()` 同款，`process.rs:168-174`）；
/// - `retention`: 保留时长（默认 30 分钟，可注入便于测试；归档清理 T-AB-12 落地）；
/// - `max_tasks`: 注册表条目上限（T-AB-12 5 容量兜底，默认 200，可注入便于测试）；
/// - `sampler`: 采样源（T-AB-15：生产默认 [crate::resource::sample_usage]；
///   测试可注入静默/脚本化替身——见 [SamplerFn] 登记说明）。
pub struct BackgroundTaskRegistry {
    pub(crate) tasks: Mutex<HashMap<String, Arc<TaskHandle>>>,
    pub(crate) task_seq: AtomicU64,
    pub(crate) log_root: PathBuf,
    pub(crate) retention: Duration,
    pub(crate) max_tasks: usize,
    /// 归档循环启动标记（幂等：线程/命令面二次调用不再重复 spawn）
    pub(crate) archive_loop_started: AtomicBool,
    /// 资源采样配置（T-AB-15：默认 2s 采样 / 60s 静默阈值；测试注入短阈值）
    pub(crate) resource_config: ResourceMonitorConfig,
    /// 任务通知投递器（T-AB-16：nudge + 事件双通道；生产默认留痕，测试注入；
    /// Mutex 支持生产路径经 `set_event_bridge` 接线替换默认发射实现）
    pub(crate) notifier: Mutex<TaskNotifier>,
    /// 采样源（T-AB-15 注入槽；默认 sample_usage，测试注入替身）
    pub(crate) sampler: SamplerFn,
    /// 30 方案 P3：任务事件消费器注入槽（EventBridgeSink 构造时读取
    /// 快照；顺序契约：先 set_task_event_consumer 后 set_event_bridge——
    /// 批 3 main.rs 装配轮按此序，30 文档 §5 改动点 3）
    pub(crate) task_event_consumer:
        Mutex<Option<Arc<crate::task_event_consumer::TaskEventConsumer>>>,
}

impl std::fmt::Debug for BackgroundTaskRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BackgroundTaskRegistry")
            .field("log_root", &self.log_root)
            .field("retention", &self.retention)
            .field("max_tasks", &self.max_tasks)
            .finish_non_exhaustive()
    }
}

/// 任务句柄（所有权在托管方）
///
/// - `info`: 任务快照（冻结形状，writer 维护状态机字段）；
/// - `pid`: 子进程主 pid（adopt 时固化；kill / 容量淘汰即使子进程所有权已被
///   writer 取走，仍可凭 pid 发起树终止）；
/// - `child`: 子进程所有权（Arc 共享给 writer 收尾 take + wait；drop 不杀——
///   kill_on_drop 已由 T-AB-02 关闭；T-AB-11 kill 亦经此槽取句柄终止）；
/// - `writer`: 转发循环任务（stdout/stderr → 落盘 + 内存预览 + 行计数 +
///   checkpoint + 提示检测；收尾在 writer 内推进状态机）；
/// - `preview`: 内存预览（有界行缓冲，status.tail 消费）；
/// - `stdin`: 子进程 stdin 写入槽（T-AB-10；终态收尾清空，写入失败清空）；
/// - `diagnostics`: 终止诊断留痕（T-AB-11：优雅发送时间 / 强制升级原因；
///   status().termination_diagnostics 透传）；
/// - `notifier`: 任务通知投递器（T-AB-16：Suspicious/Crashed 双通道，adopt 时
///   从 registry 克隆共享通道）；
/// - `sampler`: 资源采样任务（T-AB-15：仅 resourceMonitor 任务 Some）。
#[derive(Debug)]
pub(crate) struct TaskHandle {
    pub(crate) info: Arc<RwLock<BackgroundTaskInfo>>,
    pub(crate) pid: u32,
    pub(crate) child: Arc<Mutex<Option<Child>>>,
    #[allow(dead_code)] // 归档清理（retention 到期）时 await 收口 writer
    pub(crate) writer: JoinHandle<()>,
    // 采样循环句柄：终态自退出（无外部 join 需求），字段保持所有权防 drop
    #[allow(dead_code)] // T-AB-15 采样任务（仅 resourceMonitor 任务 Some，终态自退出）
    pub(crate) sampler: Option<JoinHandle<()>>,
    pub(crate) preview: Arc<Mutex<OutputPreview>>,
    pub(crate) stdin: Arc<TokioMutex<Option<ChildStdin>>>,
    pub(crate) diagnostics: Arc<Mutex<Vec<String>>>,
    // 通知投递器：writer/sampler 闭包持克隆，本字段保持 registry 侧引用
    #[allow(dead_code)] // 通知通道由克隆共享，字段本身无读取消费者
    pub(crate) notifier: TaskNotifier,
}

/// 输出内存预览（转发器维护；有界）
#[derive(Debug, Default)]
pub(crate) struct OutputPreview {
    /// 最近行环形缓冲（status.tail 取末 20 行）
    recent_lines: VecDeque<String>,
    /// 预览占用字节数（行级上限）
    recent_bytes: usize,
}

impl OutputPreview {
    pub(crate) fn push_line(&mut self, line: String) {
        self.recent_bytes += line.len();
        self.recent_lines.push_back(line);
        while self.recent_lines.len() > PREVIEW_MAX_LINES || self.recent_bytes > PREVIEW_MAX_BYTES {
            if let Some(popped) = self.recent_lines.pop_front() {
                self.recent_bytes = self.recent_bytes.saturating_sub(popped.len());
            }
        }
    }

    /// 取最近 max 行（不足则全量；空输出返回空数组）
    pub(crate) fn tail_lines(&self, max: usize) -> Vec<String> {
        let skip = self.recent_lines.len().saturating_sub(max);
        self.recent_lines.iter().skip(skip).cloned().collect()
    }
}

impl BackgroundTaskRegistry {
    /// 默认构造：日志根 = `host_paths::app_dir()/logs/tasks`（不可用时回退系统
    /// 临时目录，不阻断启动）；保留 30 分钟。Windows 侧同时初始化 daemon Job
    /// 兜底（best-effort）。
    ///
    /// 归档循环启动口径（诚实边界）：`new()` 返回 `Self`（调用方 main.rs 另行
    /// `Arc::new` 包壳），构造期无法为「线程持 Arc 克隆」提供存活强引用——归档
    /// 循环由命令面 `workbench_list_background_tasks` 首次调用时经 Tauri State
    /// 的 Arc 惰性启动（`spawn_archive_loop`，同一注册表实例）；list 本身带
    /// 惰性清扫兜底（不依赖循环线程即保证终态到期过滤）。
    pub fn new() -> Self {
        let log_root = crate::host_paths::app_dir()
            .map(|app| app.join("logs").join("tasks"))
            .unwrap_or_else(|e| {
                tracing::warn!(
                    target: "background",
                    error = %e,
                    "app_dir 不可用，任务日志根回退系统临时目录"
                );
                std::env::temp_dir().join("crish-background-tasks")
            });
        Self::construct(log_root, DEFAULT_RETENTION, MAX_BACKGROUND_TASKS)
    }

    /// 注入式构造（测试/嵌入场景）：显式日志根与保留时长；启动归档循环线程。
    /// 生产路径走 `new()`（调用方 main.rs 包 Arc），本构造供测试与嵌入方使用。
    #[allow(dead_code)] // 生产走 new()；注入式构造供测试/嵌入场景
    pub fn with_log_root(log_root: PathBuf, retention: Duration) -> Arc<Self> {
        Self::with_config(log_root, retention, MAX_BACKGROUND_TASKS)
    }

    /// 全参注入式构造（测试场景：短保留时长 / 小容量上限便于确定性断言）；
    /// 启动归档循环线程（60s tick，`archive_expired` 清扫，T-AB-12 1）。
    ///
    /// 返回 `Arc<Self>`：线程持 Arc 克隆（强引用），返回同一个分配点——调用方
    /// 与线程共享同一注册表实例（区别于 `new()` 的「返回 Self 另包壳」路径）。
    #[allow(dead_code)] // 生产走 new()；注入式构造供测试/嵌入场景
    pub fn with_config(log_root: PathBuf, retention: Duration, max_tasks: usize) -> Arc<Self> {
        let shared = Arc::new(Self::construct(log_root, retention, max_tasks));
        shared.spawn_archive_loop();
        shared
    }

    /// 返回日志根目录
    #[allow(dead_code)]
    pub fn log_root(&self) -> PathBuf {
        self.log_root.clone()
    }

    /// 纯构造（不启动归档线程；`new()` 与 `with_config` 共用）。
    /// 资源段字段取默认：采样配置 2s/60s、通知投递器未接线（留痕兜底）。
    pub(crate) fn construct(log_root: PathBuf, retention: Duration, max_tasks: usize) -> Self {
        Self::construct_with(
            log_root,
            retention,
            max_tasks,
            ResourceMonitorConfig::default(),
            TaskNotifier::unwired(),
            Arc::new(sample_usage),
        )
    }

    /// 全量构造（`construct` 与资源段注入式构造共用）。
    ///
    /// 资源段注入项（T-AB-15/16 测试场景）：`resource_config` 短采样周期 +
    /// 短静默阈值便于确定性断言；`notifier` 注入内存 nudge 队列 / 事件收集器。
    fn construct_with(
        log_root: PathBuf,
        retention: Duration,
        max_tasks: usize,
        resource_config: ResourceMonitorConfig,
        notifier: TaskNotifier,
        sampler: SamplerFn,
    ) -> Self {
        let registry = Self {
            tasks: Mutex::new(HashMap::new()),
            task_seq: AtomicU64::new(0),
            log_root,
            retention,
            max_tasks,
            archive_loop_started: AtomicBool::new(false),
            resource_config,
            notifier: Mutex::new(notifier),
            sampler,
            task_event_consumer: Mutex::new(None),
        };
        // Windows：daemon Job 兜底（应用退出 → 宿主句柄关闭 → 后台任务树全杀；
        // 与 PTY Job 相互隔离，见 process.rs Job Objects 段）
        #[cfg(windows)]
        if let Err(e) = crate::process::init_daemon_job_object() {
            tracing::warn!(
                target: "background",
                error = %e,
                "daemon job object init failed; 后台任务孤儿保护降级为显式 kill 兜底"
            );
        }
        registry
    }

    /// 资源段注入式构造（T-AB-15/16 测试场景：短采样周期/短静默阈值 +
    /// 通知通道注入；采样源为真实 [crate::resource::sample_usage]；启动归档
    /// 循环线程，与 `with_config` 同款 Arc 语义）。
    #[allow(dead_code)] // 生产走 new()/with_config；本构造供资源与健康测试
    pub(crate) fn with_resource_options(
        log_root: PathBuf,
        retention: Duration,
        max_tasks: usize,
        resource_config: ResourceMonitorConfig,
        notifier: TaskNotifier,
    ) -> Arc<Self> {
        Self::with_resource_monitor(
            log_root,
            retention,
            max_tasks,
            resource_config,
            notifier,
            Arc::new(sample_usage),
        )
    }

    /// 资源段全量注入式构造（T-AB-15/16 测试场景）：额外注入采样源替身——
    /// 健康类测试用静默/脚本化替身（[SamplerFn] 登记说明：共享 daemon Job
    /// 在并行测试下的 CPU 读数受其他测试子进程污染，替身使判定输入确定性
    /// 可控）；启动归档循环线程，与 `with_resource_options` 同款 Arc 语义。
    #[allow(dead_code)] // 测试专用构造（健康类测试注入采样替身）
    pub(crate) fn with_resource_monitor(
        log_root: PathBuf,
        retention: Duration,
        max_tasks: usize,
        resource_config: ResourceMonitorConfig,
        notifier: TaskNotifier,
        sampler: SamplerFn,
    ) -> Arc<Self> {
        let shared = Arc::new(Self::construct_with(
            log_root,
            retention,
            max_tasks,
            resource_config,
            notifier,
            sampler,
        ));
        shared.spawn_archive_loop();
        shared
    }

    /// 事件发射接线（T-AB-16 通道二生产路径）：把 [EventBridgeSink] 并入
    /// 通知投递器（替换默认 [LogEventSink] 留痕实现）。
    ///
    /// 装配点：main.rs 装配轮（30 方案 P2/P3）构造 registry 后调用一次
    /// ——七事件经 workbench-run-event 真实发射（E3 核销）。
    /// 30 方案 P3：EventBridgeSink 构造时读取注册表 task_event_consumer
    /// 快照（顺序契约：先 set_task_event_consumer 后 set_event_bridge）。
    pub(crate) fn set_event_bridge(&self, bridge: EventBridge, session_id: String) {
        // P3：消费器快照（None = 未接线，事件照常发射但不消费）
        let consumer = self
            .task_event_consumer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        self.notifier
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .set_event_sink(Arc::new(EventBridgeSink {
                bridge,
                session_id,
                consumer,
            }));
    }

    /// 30 方案 P3：注入任务事件消费器（main.rs 装配轮在 set_event_bridge
    /// 之前调用——EventBridgeSink 构造时读取快照，注入晚于接线则不生效，
    /// 顺序契约见 30 文档 §5 改动点 3；消费方 = main.rs 装配轮，已接线）
    pub(crate) fn set_task_event_consumer(
        &self,
        consumer: Arc<crate::task_event_consumer::TaskEventConsumer>,
    ) {
        *self
            .task_event_consumer
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(consumer);
    }

    /// 启动归档循环（60s tick，spawn_snapshot_loop 同款周期任务语义；幂等——
    /// 重复调用不重复 spawn）。用 std::thread 而非 tauri::async_runtime::spawn：
    /// 归档清扫全部为同步操作（锁 + 文件删除），不依赖 tokio/tauri runtime
    /// （测试进程同样可用）。
    ///
    /// 接线点：`with_config` 构造即启动（Arc 上下文）；生产路径由命令面
    /// `workbench_list_background_tasks` 首次调用惰性启动（Tauri State 持 Arc，
    /// 与 main.rs 包壳为同一注册表实例）。
    pub(crate) fn spawn_archive_loop(self: &Arc<Self>) {
        if self.archive_loop_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let this = Arc::clone(self);
        std::thread::Builder::new()
            .name("bg-archive-loop".to_string())
            .spawn(move || loop {
                std::thread::sleep(Duration::from_secs(ARCHIVE_TICK_SECS));
                this.archive_expired();
            })
            .expect("spawn bg-archive-loop");
    }

    /// 任务是否命中终态（归档/过滤判定用）。
    pub(crate) fn is_terminal(state: TaskState) -> bool {
        matches!(
            state,
            TaskState::Completed | TaskState::Failed | TaskState::Killed
        )
    }

    /// 任务不存在统一错误（NotFound 风格，命令面透传为 CoreError::NotFound）。
    ///
    /// 归档恢复指引（T-AB-12 2）：内存条目已清（归档/容量淘汰）但 `.log` 仍在
    /// 磁盘 → 错误消息附「已归档，日志文件仍在 <path>」；完全未知 id 无指引。
    fn not_found(&self, task_id: &str) -> ToolError {
        let log_path = self.log_root.join(format!("{task_id}.log"));
        let mut message = format!("后台任务不存在：{task_id}");
        if log_path.exists() {
            message.push_str(&format!(
                "（可能已归档，日志文件仍在 {}，可读取留档）",
                log_path.display()
            ));
        }
        ToolError::new(codes::TOOL_NOT_FOUND, message)
    }

    /// stdin 写入失败分类错误（T-AB-10 2：stdin_closed）。
    /// 分类契约：错误码 `tool.execution_failed` + 消息前缀 `stdin_closed`
    /// （T-AB-13 工具面按此前缀分类转结构化错误）。
    pub(crate) fn stdin_closed(task_id: &str) -> ToolError {
        ToolError::new(
            codes::TOOL_EXECUTION_FAILED,
            format!(
                "stdin_closed：任务 {task_id} 的 stdin 管道已关闭或未接通（进程可能已退出，或 spawn 未开启 stdin 管道）"
            ),
        )
    }

    /// 取任务句柄（不存在 → NotFound）。
    pub(crate) fn get_handle(&self, task_id: &str) -> Result<Arc<TaskHandle>, ToolError> {
        let tasks = self.tasks.lock().unwrap_or_else(|p| p.into_inner());
        tasks
            .get(task_id)
            .cloned()
            .ok_or_else(|| self.not_found(task_id))
    }

    /// 命令摘要（前 64 字符）。
    pub(crate) fn summarize_command(command: &str) -> String {
        const MAX: usize = 64;
        if command.chars().count() <= MAX {
            command.to_string()
        } else {
            let truncated: String = command.chars().take(MAX).collect();
            format!("{truncated}…")
        }
    }

    /// 归档清扫（T-AB-12 1）：一次遍历，清理 `finished_at + retention` 之前的
    /// 终态条目——只清内存条目与 `.meta.json`，`.log` 保留（保留语义）。同步
    /// 实现（锁 + 文件删除），供归档线程周期调用，也供测试直接驱动。
    ///
    /// 返回本轮归档条目数。终态条目即 writer 已收口（状态翻转发生在 writer 内、
    /// 全部落盘与 meta 收尾之后），故无需 await writer。
    #[allow(clippy::disallowed_methods)] // 归档清 .meta.json 属任务日志内部索引
                                         // 清理（非用户文件，豁免裸删除；.log 永远保留）
    pub(crate) fn archive_expired(&self) -> usize {
        let now = now_millis() as u64;
        let retention_ms = self.retention.as_millis() as u64;
        let mut expired: Vec<String> = Vec::new();
        {
            let tasks = self.tasks.lock().unwrap_or_else(|p| p.into_inner());
            for (task_id, handle) in tasks.iter() {
                let info = handle.info.read().unwrap_or_else(|p| p.into_inner());
                if !Self::is_terminal(info.status) {
                    continue;
                }
                if let Some(finished) = info.finished_at_ms {
                    if now >= finished.saturating_add(retention_ms) {
                        expired.push(task_id.clone());
                    }
                }
            }
        }
        let mut archived = 0;
        for task_id in expired {
            // 二次确认仍在（并发 adopt/kill 已移除则跳过）
            let removed = self
                .tasks
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&task_id);
            if removed.is_none() {
                continue;
            }
            // 只清 .meta.json；.log 保留（可恢复指引：status/read_log NotFound 附路径）
            let meta_path = self.log_root.join(format!("{task_id}.meta.json"));
            if meta_path.exists() {
                std::fs::remove_file(&meta_path).unwrap_or_else(|e| {
                    tracing::warn!(
                        target: "background",
                        task_id = %task_id,
                        error = %e,
                        "归档清理 .meta.json 失败（.log 保留不受影响）"
                    );
                });
            }
            archived += 1;
        }
        archived
    }

    /// 容量兜底（T-AB-12 5）：条目超 `max_tasks` 时 FIFO 淘汰最旧条目（按
    /// started_at 最早；同值按 task_id 字典序兜底）。淘汰时若仍在运行**先终止**
    /// （force 树杀，比 30 分钟归档更硬的兜底）。`.log` 保留；`.meta.json` 在
    /// writer 收口后清理（保证 writer 不会把终态 meta 写回残留）。
    ///
    /// 调用点：adopt 登记之后（async 上下文，可 await writer 收口）。
    #[allow(clippy::disallowed_methods)] // 淘汰清 .meta.json 属任务日志内部索引
                                         // 清理（非用户文件，豁免裸删除；.log 永远保留）
    pub(crate) async fn evict_overflow(&self) {
        let mut overflow: Vec<(String, Arc<TaskHandle>)> = Vec::new();
        let max = self.max_tasks;
        {
            let tasks = self.tasks.lock().unwrap_or_else(|p| p.into_inner());
            if tasks.len() <= max {
                return;
            }
            // FIFO：started_at 最早者最旧；同值按 task_id 排序兜底
            let mut entries: Vec<(&String, &Arc<TaskHandle>)> = tasks.iter().collect();
            entries.sort_by(|a, b| {
                let a_info = a.1.info.read().unwrap_or_else(|p| p.into_inner());
                let b_info = b.1.info.read().unwrap_or_else(|p| p.into_inner());
                (a_info.started_at_ms, a.0).cmp(&(b_info.started_at_ms, b.0))
            });
            for (id, handle) in entries.into_iter().take(tasks.len() - max) {
                overflow.push((id.clone(), Arc::clone(handle)));
            }
        }
        for (task_id, handle) in overflow {
            let is_running =
                handle.info.read().unwrap_or_else(|p| p.into_inner()).status == TaskState::Running;
            if is_running {
                // 先终止：take 子进程 → force 树杀 → await writer 收口（writer
                // 的 child 槽为 None → 按 Killed 收尾）。kill 语义对齐 T-AB-11
                // 的强制阶段；容量淘汰不做优雅等待（兜底路径，硬上限优先）。
                let child = handle
                    .child
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .take();
                let _ = crate::process::terminate_process_tree(handle.pid);
                drop(child);
                // 等 writer 收口（child=None → Killed 收尾；is_finished 轮询 +
                // async sleep 让步，JoinHandle 在 Arc 共享所有权下无法 join）
                {
                    let deadline = tokio::time::Instant::now() + WRITER_DRAIN_TIMEOUT;
                    while !handle.writer.is_finished() {
                        if tokio::time::Instant::now() >= deadline {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                }
            }
            // 从注册表移除（内存条目淘汰）
            self.tasks
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&task_id);
            // .log 保留；.meta.json 清理（writer 已收口，无残留回写）
            let meta_path = self.log_root.join(format!("{task_id}.meta.json"));
            if meta_path.exists() {
                let _ = std::fs::remove_file(&meta_path);
            }
            tracing::info!(
                target: "background",
                task_id = %task_id,
                "注册表容量上限触发 FIFO 淘汰（条目超上限，.log 保留）"
            );
        }
    }
}

impl Default for BackgroundTaskRegistry {
    fn default() -> Self {
        Self::new()
    }
}
