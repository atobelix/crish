//! 后台任务注册表（T-AB-07 底座 + R-AB2 T-AB-09/10 日志生命周期与 stdin 注入
//! + R-AB3 T-AB-15/16 资源采样与健康判定）
//!
//! 职责：
//! - [BackgroundTaskRegistry]：任务注册表（`task-<seq>` 命名空间独立于 pty id）、
//!   日志根（`host_paths::app_dir()/logs/tasks`）、保留时长（默认 30 分钟，可注入）、
//!   资源采样配置与通知投递器（T-AB-15/16）；
//! - [TaskHandle]：任务句柄（info + child + writer + sampler + stdin 槽位 +
//!   notifier）；
//! - writer 转发循环：stdout/stderr → 落盘 `<task_id>.log`（带 `[out]`/`[err]` 行前缀）
//!   + 内存预览 + 行计数 + 每 512 行 `.meta.json` checkpoint + 行尾提示检测 +
//!   Crashed 通知（T-AB-16 3：resourceMonitor 任务非零退出 → 通知附最后 20 行）；
//! - read_log：行号范围读取（尾部读取 / checkpoint 二分定位）；send_input：stdin 注入；
//! - 采样循环（T-AB-15 3）：resourceMonitor 任务挂 [TaskHandle::sampler]——
//!   周期 2s 采集 CPU/RSS → 更新 `info.resource` + 落盘 `.samples.jsonl` +
//!   健康三态判定（T-AB-16 1）+ Suspicious 通知（防抖，同任务保持期间仅一次）。
//!
//! 关键口径（实现文档，诚实边界）：
//! - 日志编码：`decode_console_bytes`（先按 UTF-8，失败 lossy，与 agent-tools
//!   shell.rs:1286-1291 同一口径）；
//! - 行前缀：日志物理行 = `[out]`/`[err]` 前缀 + 内容 + `\n`（1 条输出 = 1 个文件行，
//!   行号与 line_count 一一对应）；stdout/stderr 为两条独立管道，文件内「顺序」为
//!   到达序近似（select 调度序，非严格交错序）；
//! - read_log / status.tail 返回「去前缀」的用户可见内容（.log 保留前缀作审计面）；
//! - 终态即收尾屏障：状态机翻转为终态发生在 writer 任务内、全部落盘与 meta 收尾
//!   之后——status()/list() 读到终态即保证 tail/line_count 与文件自洽（T-AB-09 6）。
//!   注意：T-AB-11 若在 writer 之外翻转 Killed，须先 await writer 或保持本顺序；
//! - 轮转护栏：单文件超 100MB 保尾截头（保留末 64MB，行对齐），meta 记轮转标记；
//! - stdin：`child.stdin.take()` 托管于 `Arc<TokioMutex<Option<ChildStdin>>>`；终态
//!   由收尾清空槽位（确定性 stdin_closed）。登记说明：agent-tools shell.rs:753 目前
//!   以 `Stdio::null()` spawn，模式 2/3 真实路径暂不带 stdin（B2/T-AB-13 需改为
//!   `Stdio::piped()` 才能接通）；本侧对「未接管道」按 stdin_closed 分类处理；
//! - 提示检测：行尾字面后缀匹配（常量模式，等价轻量正则），命中仅「候选提示」就位
//!   （info.prompt + meta 落盘），由 AI 判断是否发送输入；通知接线
//!   （PendingNudgeChannel::enqueue，nudge.rs:192）已由 T-AB-16 经
//!   [crate::resource::TaskNotifier] 抽象落地（生产未接线 → 留痕，测试注入队列）。
//!
//! 资源段接线状态（T-AB-15/16，登记偏差）：
//! - 通知通道一（nudge）：`PendingNudgeChannel` 实例在 orchestrator 的
//!   `PendingMessageQueue` 内部，壳层无访问入口 → 生产默认 None（通知文本经
//!   tracing 留痕），待 C2 / T-AB-18 接线；测试注入内存队列断言；
//! - 通知通道二（事件）：task-suspicious（Soft）/ task-failed（Critical）经
//!   [crate::resource::EventSink] 槽发射（默认 [crate::resource::LogEventSink]
//!   结构化留痕）——C2（T-AB-17）在 conex-types 落地 AgentEvent 七事件变体后，
//!   以信封构造替换实现（payload 按冻结契约 §4.5 组装，零改动迁移）；
//! - Windows 采样：`QueryInformationJobObject` 需要 daemon Job 句柄——句柄封装在
//!   `process.rs` 私有 static（OnceLock）内，为落地采样在 process.rs 追加一行
//!   只读 getter（`daemon_job_handle`，纯暴露不改行为，报主 Agent 裁决）。
//!
//! 回收语义：run 结束不回收任务（会话级存活）；应用退出 → daemon Job 兜底全杀
//! （process.rs DAEMON_JOB_OBJECT，adopt 时接线，best-effort）。孤儿句柄：
//! adopt 转移时 `kill_on_drop(false)` 由 T-AB-02 保证，drop 不杀子进程。
//! 任务终止（completed/failed/killed）不删 `.log`（保留语义，T-AB-12 归档只清
//! 内存条目与 `.meta.json`）。
//!
//! 命令面（T-AB-08）：workbench_list_background_tasks / workbench_get_background_task_output /
//! workbench_cancel_background_task 三条 Tauri 命令，薄包装本注册表；契约测试
//! 直调 [build_list_response] / [build_output_response]（构造注册表即构造 State，
//! 不依赖 Tauri runtime）。

use crate::core_error::CoreError;
use crate::core_event_bridge::EventBridge;
use crate::perf::fs::{file_info, read_chunk};
use crate::process::now_millis;
use crate::resource::{
    cpu_percent_from_delta, judge_health, sample_usage, EventSink, ProcessHealth, RawUsage,
    ResourceMonitorConfig, TaskNotifier,
};
use agent_tools::background::{
    BackgroundAdoptRequest, BackgroundTaskInfo, BackgroundTaskManager, BackgroundTaskRef,
    BackgroundTaskStatus, KillResult, LogSlice, ResourceSample, TaskState,
};
use conex_types::events::{AgentEvent, AgentEventEnvelope};
use agent_tools::definition::ToolError;
use conex_types::error::codes;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;
use tokio::io::{AsyncBufRead, AsyncBufReadExt};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout};
use tokio::sync::Mutex as TokioMutex;
use tokio::task::JoinHandle;

// ============================================================================
// 契约来源说明（跨 Agent 冻结接口，只读消费）
// ----------------------------------------------------------------------------
// trait `BackgroundTaskManager` 与全部数据结构（TaskState / BackgroundTaskInfo /
// BackgroundTaskStatus / BackgroundAdoptRequest / BackgroundTaskRef / KillResult /
// LogSlice / ResourceSample）由 A1 在 `crates/agent-tools/src/background.rs` 落地
// （T-AB-02，形状与方案 §4.1 / §4.2 / §4.4 逐字一致），经 `agent_tools` crate
// 根导出。本文件只消费不修改——壳层实现（impl BackgroundTaskManager for
// BackgroundTaskRegistry）即契约的实现面。
// ============================================================================

// ============================================================================
// 常量（T-AB-09 日志生命周期参数）
// ============================================================================

/// 默认保留时长：任务终止后 30 分钟归档（清内存条目与 .meta.json，T-AB-12 落地）
const DEFAULT_RETENTION: Duration = Duration::from_secs(30 * 60);

/// 内存预览行数上限（status.tail 取末 20 行，留余量）
const PREVIEW_MAX_LINES: usize = 200;
/// 内存预览字节上限（有界：长输出命令不驻留全量内存）
const PREVIEW_MAX_BYTES: usize = 64 * 1024;

/// 行数索引 checkpoint 间隔：每写满 512 行在 `.meta.json` 记一次行号→偏移
/// 定位点（checkpoint 只做快速定位，不做精确断言——索引滞后时回退实际末尾）
const CHECKPOINT_INTERVAL_LINES: u64 = 512;
/// 日志轮转护栏：单文件超 100MB 截断头部（保尾语义与 A03 一致）
const LOG_MAX_BYTES: u64 = 100 * 1024 * 1024;
/// 轮转保留尾部字节数（截头保尾，行对齐）
const LOG_KEEP_BYTES: u64 = 64 * 1024 * 1024;
/// 轮转重命名重试次数（Windows 重命名要求目标路径无占用句柄，读者可能短暂持有）
const ROTATE_RENAME_RETRIES: u32 = 5;
/// 尾部读取回退预算：file_info 拿 size → 从尾回退 64KB
const TAIL_READ_BUDGET: u64 = 64 * 1024;
/// 精确行号顺序读预算：超预算即截断返回并置 truncated
const RANGE_READ_BUDGET: u64 = 8 * 1024 * 1024;

/// 日志物理行前缀（审计面标记；read_log / status.tail 返回去前缀的用户内容）
const OUT_PREFIX: &str = "[out]";
/// 日志物理行前缀（stderr）
const ERR_PREFIX: &str = "[err]";

/// 交互提示候选模式（T-AB-10 3）：行尾字面后缀匹配——对行尾做轻量「正则」，
/// 字面后缀等价于锚定行尾的匹配且避免转义错误。仅作候选提示（T-AB-10 4）。
const PROMPT_PATTERNS: &[&str] = &[
    "[Y/n]",
    "[y/N]",
    "Press Enter to continue",
    "(yes/no)",
    "请输入",
];

/// 注册表条目上限（T-AB-12 5 容量兜底；继承旧 MAX_BACKGROUND_TASKS 语义 200）——
/// FIFO 淘汰，淘汰时若仍在运行先终止（比 30 分钟归档更硬的兜底）。
const MAX_BACKGROUND_TASKS: usize = 200;
/// 归档循环 tick 间隔（spawn_snapshot_loop 同款 60s 周期任务，T-AB-12 1）。
/// 用 std::thread 而非 tauri::async_runtime::spawn：归档清扫全部为同步操作
/// （锁 + 文件删除），不依赖 tokio/tauri runtime（测试进程同样可用）。
const ARCHIVE_TICK_SECS: u64 = 60;
/// 归档清扫 / kill 等待 writer 收口的最长等待（writer 在管道 EOF 后即完成，
/// 超时仅为防异常（孙进程持管道）拖住调用方）。
const WRITER_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
/// 两阶段终止阶段一：优雅请求后的等待窗口（5s，超时升级强制）。
const KILL_GRACEFUL_WINDOW: Duration = Duration::from_secs(5);
/// 两阶段终止阶段二：强制终止后的等待窗口（5s，仍不退出 → Failed）。
const KILL_FORCE_WINDOW: Duration = Duration::from_secs(5);

/// 采样间隔下限（毫秒，T-AB-15 3）：测试注入更短周期时防御性抬底——interval
/// 极短拍会空转烧 CPU，且采样本身有微秒级 FFI 开销，200ms 下限足以满足
/// 测试的确定性断言（首采样丢弃 → 第二拍起有效）。
const RESOURCE_SAMPLE_INTERVAL_MIN_MS: u64 = 200;

// ============================================================================
// 资源采样注入与 Suspicious 防抖（T-AB-15/16 可测性接线）
// ============================================================================

/// 采样源注入槽（T-AB-15）：生产默认 [crate::resource::sample_usage]（真实
/// JobObject /proc 采集）。
///
/// 登记（T-AB-15 诚实边界 + 测试稳定性）：Windows 侧采样读的是**全进程唯一**
/// daemon Job 对象（process.rs DAEMON_JOB_OBJECT，OnceLock 单例）——并行测试
/// 下其他测试的子进程同属该 Job，其 CPU 读数会污染本任务采样（启动尖峰 /
/// 持续输出的进程可把本任务拍内 CPU% 抬过活跃阈值）。健康类测试因此注入
/// 静默 / 脚本化替身（判定输入确定性可控），真实采集路径仍由
/// resource_sample_collected / resource_samples_persisted 覆盖。
pub(crate) type SamplerFn = Arc<dyn Fn(u32) -> Result<RawUsage, String> + Send + Sync>;

/// Suspicious 通知防抖状态机（T-AB-16 2 语义：同任务保持期间仅一次，恢复
/// Healthy 后重置）。
///
/// 每拍喂入健康判定结果，返回「本拍是否应投递通知」：
/// - Healthy：重置防抖（不通知）——CPU 抖动等临时活跃视为「恢复 Healthy」，
///   按方案语义允许后续重新进入 Suspicious 时再次通知（合法重复通知场景）；
/// - Suspicious：保持期间内仅首次返回 true，其余保持拍返回 false；
/// - Crashed：不参与本状态机（终态由 finish_task 走 notify_failed）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct SuspiciousDebounce {
    /// 当前 Suspicious 保持期内是否已通知过
    armed: bool,
}

impl SuspiciousDebounce {
    /// 喂入一拍判定结果，返回是否应投递 Suspicious 通知。
    pub(crate) fn observe(&mut self, health: ProcessHealth) -> bool {
        match health {
            ProcessHealth::Healthy => {
                self.armed = false;
                false
            }
            ProcessHealth::Suspicious => {
                if self.armed {
                    false
                } else {
                    self.armed = true;
                    true
                }
            }
            ProcessHealth::Crashed => false,
        }
    }
}

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
    tasks: Mutex<HashMap<String, Arc<TaskHandle>>>,
    task_seq: AtomicU64,
    log_root: PathBuf,
    retention: Duration,
    max_tasks: usize,
    /// 归档循环启动标记（幂等：线程/命令面二次调用不再重复 spawn）
    archive_loop_started: AtomicBool,
    /// 资源采样配置（T-AB-15：默认 2s 采样 / 60s 静默阈值；测试注入短阈值）
    resource_config: ResourceMonitorConfig,
    /// 任务通知投递器（T-AB-16：nudge + 事件双通道；生产默认留痕，测试注入；
    /// Mutex 支持生产路径经 `set_event_bridge` 接线替换默认发射实现）
    notifier: Mutex<TaskNotifier>,
    /// 采样源（T-AB-15 注入槽；默认 sample_usage，测试注入替身）
    sampler: SamplerFn,
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
    info: Arc<RwLock<BackgroundTaskInfo>>,
    pid: u32,
    child: Arc<Mutex<Option<Child>>>,
    #[allow(dead_code)] // 归档清理（retention 到期）时 await 收口 writer
    writer: JoinHandle<()>,
    // 采样循环句柄：终态自退出（无外部 join 需求），字段保持所有权防 drop
    #[allow(dead_code)] // T-AB-15 采样任务（仅 resourceMonitor 任务 Some，终态自退出）
    sampler: Option<JoinHandle<()>>,
    preview: Arc<Mutex<OutputPreview>>,
    stdin: Arc<TokioMutex<Option<ChildStdin>>>,
    diagnostics: Arc<Mutex<Vec<String>>>,
    // 通知投递器：writer/sampler 闭包持克隆，本字段保持 registry 侧引用
    #[allow(dead_code)] // 通知通道由克隆共享，字段本身无读取消费者
    notifier: TaskNotifier,
}

/// 输出内存预览（转发器维护；有界）
#[derive(Debug, Default)]
struct OutputPreview {
    /// 最近行环形缓冲（status.tail 取末 20 行）
    recent_lines: VecDeque<String>,
    /// 预览占用字节数（行级上限）
    recent_bytes: usize,
}

impl OutputPreview {
    fn push_line(&mut self, line: String) {
        self.recent_bytes += line.len();
        self.recent_lines.push_back(line);
        while self.recent_lines.len() > PREVIEW_MAX_LINES || self.recent_bytes > PREVIEW_MAX_BYTES
        {
            if let Some(popped) = self.recent_lines.pop_front() {
                self.recent_bytes = self.recent_bytes.saturating_sub(popped.len());
            }
        }
    }

    /// 取最近 max 行（不足则全量；空输出返回空数组）
    fn tail_lines(&self, max: usize) -> Vec<String> {
        let skip = self.recent_lines.len().saturating_sub(max);
        self.recent_lines.iter().skip(skip).cloned().collect()
    }
}

// ============================================================================
// meta.json（T-AB-09 3：创建即写初值；终态写 exit_code/finished_at；轮转标记）
// ============================================================================

/// `.meta.json` 内容（camelCase；终态由收尾写 exit_code/finished_at；
/// 任务终止不删 `.log`，本文件 T-AB-12 归档时清理）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskMeta {
    task_id: String,
    command: String,
    /// kebab-case 状态字符串（running/completed/failed/killed）
    status: String,
    started_at_ms: u64,
    finished_at_ms: Option<u64>,
    exit_code: Option<i32>,
    line_count: u64,
    last_output_at_ms: u64,
    prompt: Option<String>,
    /// 行数→偏移 checkpoint（line=行号，offset=该行行首字节偏移）
    checkpoints: Vec<CheckpointEntry>,
    /// 轮转标记（单文件超 100MB 保尾截头后置位）
    rotated: bool,
    rotated_at_ms: Option<u64>,
    /// 轮转累计丢弃行数（近似）
    dropped_lines: u64,
    /// 日志文件当前字节数（writer 维护的写入偏移）
    log_bytes: u64,
}

/// checkpoint 条目：第 `line` 行的行首字节偏移为 `offset`
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckpointEntry {
    line: u64,
    offset: u64,
}

impl TaskMeta {
    /// 由内存快照组装（写入点：创建 / 每 512 行 / 提示命中 / 终态）
    fn from_info(
        info: &BackgroundTaskInfo,
        checkpoints: Vec<CheckpointEntry>,
        log_bytes: u64,
        rotated: bool,
        rotated_at_ms: Option<u64>,
        dropped_lines: u64,
    ) -> Self {
        Self {
            task_id: info.task_id.clone(),
            command: info.command.clone(),
            status: task_state_str(&info.status).to_string(),
            started_at_ms: info.started_at_ms,
            finished_at_ms: info.finished_at_ms,
            exit_code: info.exit_code,
            line_count: info.line_count,
            last_output_at_ms: info.last_output_at_ms,
            prompt: info.prompt.clone(),
            checkpoints,
            rotated,
            rotated_at_ms,
            dropped_lines,
            log_bytes,
        }
    }
}

/// 读 meta（容错：缺失或解析失败 → None + debug 留痕；索引只做快速定位）
fn read_meta(path: &Path) -> Option<TaskMeta> {
    let raw = std::fs::read(path).ok()?;
    match serde_json::from_slice::<TaskMeta>(&raw) {
        Ok(meta) => Some(meta),
        Err(e) => {
            tracing::debug!(
                target: "background",
                error = %e,
                path = %path.display(),
                "任务 meta 解析失败，按缺失处理（checkpoint 回退实际末尾）"
            );
            None
        }
    }
}

/// 写 meta（UTF-8 无 BOM；父目录自动创建）
fn write_meta(path: &Path, meta: &TaskMeta) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建 meta 目录失败：{e}"))?;
        }
    }
    let raw = serde_json::to_string_pretty(meta).map_err(|e| format!("序列化 meta 失败：{e}"))?;
    std::fs::write(path, raw).map_err(|e| format!("写 meta 失败：{e}"))
}

/// 便捷写入点：从内存快照组 meta 并落盘（失败仅 warn，不阻断转发循环）
fn write_meta_now(
    info: &Arc<RwLock<BackgroundTaskInfo>>,
    meta_path: &Path,
    checkpoints: &[CheckpointEntry],
    log_bytes: u64,
    rotated: bool,
    rotated_at_ms: Option<u64>,
    dropped_lines: u64,
) {
    let Ok(guard) = info.read() else {
        return;
    };
    let meta = TaskMeta::from_info(
        &guard,
        checkpoints.to_vec(),
        log_bytes,
        rotated,
        rotated_at_ms,
        dropped_lines,
    );
    drop(guard);
    if let Err(e) = write_meta(meta_path, &meta) {
        tracing::warn!(
            target: "background",
            error = %e,
            path = %meta_path.display(),
            "任务 meta 落盘失败"
        );
    }
}

/// 状态 → kebab-case 字符串（与 TaskState 序列化口径一致）
fn task_state_str(state: &TaskState) -> &'static str {
    match state {
        TaskState::Running => "running",
        TaskState::Completed => "completed",
        TaskState::Failed => "failed",
        TaskState::Killed => "killed",
    }
}

// ============================================================================
// 日志写者（T-AB-09 1：双流落盘；转发器独占，非异步上下文）
// ============================================================================

/// 日志文件写者：追加句柄 + 写入偏移 + 末行行首偏移 + 落盘失败降级标记。
///
/// 偏移口径：`offset` = 已成功写入的字节数（= 文件物理末尾）；checkpoint 需要
/// 行首偏移，故 `last_start` 记录上一行写入前的偏移。
#[derive(Debug, Default)]
struct LogWriter {
    file: Option<std::fs::File>,
    /// 下一写入字节偏移（文件物理末尾；轮转后重置为保尾字节数）
    offset: u64,
    /// 最近一行行首偏移（终态 checkpoint 用；None = 尚无任何行）
    last_start: Option<u64>,
    /// 落盘失败降级标记：warn 一次后不再尝试写盘，内存面继续（不阻断任务）
    broken: bool,
}

impl LogWriter {
    /// 追加一个日志物理行：`<prefix><line>\n`。失败（磁盘满等）→ 降级内存面。
    fn append_line(&mut self, path: &Path, prefix: &str, line: &str) {
        if self.file.is_none() {
            if self.broken {
                return;
            }
            self.file = open_log_append(path);
            if self.file.is_none() {
                self.broken = true;
                tracing::warn!(
                    target: "background",
                    path = %path.display(),
                    "任务日志落盘失败，降级为内存预览（不阻断任务执行）"
                );
                return;
            }
        }
        let file = self
            .file
            .as_mut()
            .expect("append_line 前已确保 file 存在");
        self.last_start = Some(self.offset);
        let result = file
            .write_all(prefix.as_bytes())
            .and_then(|_| file.write_all(line.as_bytes()))
            .and_then(|_| file.write_all(b"\n"));
        match result {
            Ok(()) => self.offset += (prefix.len() + line.len() + 1) as u64,
            Err(e) => {
                tracing::warn!(
                    target: "background",
                    error = %e,
                    "任务日志写入失败，降级为内存预览（不阻断任务执行）"
                );
                self.file = None;
                self.broken = true;
            }
        }
    }

    /// 终态收尾：flush 到磁盘（best-effort，保证退出后文件可读）
    fn sync(&mut self) {
        if let Some(file) = self.file.as_mut() {
            let _ = file.sync_all();
        }
    }

    /// 轮转前关闭追加句柄（Windows 重命名要求路径无占用句柄）
    fn close(&mut self) {
        self.file = None;
    }

    /// 轮转后重新打开追加句柄（失败 → 降级标记）
    fn reopen(&mut self, path: &Path) {
        self.file = open_log_append(path);
        self.broken = self.file.is_none();
    }
}

/// 以追加模式打开日志文件（自动建父目录；失败 → None）
fn open_log_append(path: &Path) -> Option<std::fs::File> {
    if let Some(parent) = path.parent() {
        if !parent.exists() && std::fs::create_dir_all(parent).is_err() {
            return None;
        }
    }
    OpenOptions::new().create(true).append(true).open(path).ok()
}

/// 日志轮转护栏（T-AB-09 5）：单文件超 100MB 保尾截头（保留末 64MB，行对齐）。
///
/// 仅转发器在 checkpoint 时调用（无并发写者）。实现：关闭追加句柄 → 读取尾部
/// LOG_KEEP_BYTES 字节 → 丢弃首个不完整行（行对齐）→ 写临时文件 → 重命名替换
/// （Windows 重命名需目标无占用句柄：读者可能短暂持有，有限重试；重试失败则
/// 本轮回转放弃，下个 checkpoint 再试）。轮转后行号从 1 重新编号。
///
/// 返回值：成功 → 新文件行数（调用方负责同步 info.line_count 与清空 checkpoints）；
/// 失败 → None（warn，保持原文件继续追加）。
#[allow(clippy::disallowed_methods)] // 轮转清理 .log.rot 临时文件（任务日志内部
// 索引整理，非用户文件，豁免裸删除）
fn maybe_rotate_log(
    log_path: &Path,
    log: &mut LogWriter,
    info: &Arc<RwLock<BackgroundTaskInfo>>,
) -> Option<u64> {
    if log.offset <= LOG_MAX_BYTES {
        return None;
    }
    log.close();
    let size = std::fs::metadata(log_path)
        .map(|m| m.len())
        .unwrap_or(0);
    if size == 0 {
        // 文件异常为空：直接放弃本轮（offset 与物理大小不一致属极端异常）
        log.reopen(log_path);
        tracing::warn!(
            target: "background",
            path = %log_path.display(),
            "日志轮转跳过：文件大小为 0（偏移与物理大小不一致）"
        );
        return None;
    }
    let keep_from = size.saturating_sub(LOG_KEEP_BYTES);
    let mut data = Vec::with_capacity(LOG_KEEP_BYTES as usize);
    if let Err(e) = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::open(log_path)?;
        file.seek(SeekFrom::Start(keep_from))?;
        file.take(LOG_KEEP_BYTES).read_to_end(&mut data)?;
        Ok(())
    })() {
        log.reopen(log_path);
        tracing::warn!(
            target: "background",
            error = %e,
            "日志轮转读取尾部失败，本轮放弃（下个 checkpoint 重试）"
        );
        return None;
    }
    // 行对齐：keep_from 可能落在行中间 → 丢弃首个不完整行
    if keep_from > 0 {
        if let Some(idx) = data.iter().position(|&b| b == b'\n') {
            data.drain(..=idx);
        } else {
            data.clear();
        }
    }
    let new_lines = data.iter().filter(|&&b| b == b'\n').count() as u64;
    let temp = log_path.with_extension("log.rot");
    if let Err(e) = std::fs::write(&temp, &data) {
        log.reopen(log_path);
        tracing::warn!(
            target: "background",
            error = %e,
            "日志轮转临时文件写入失败，本轮放弃"
        );
        return None;
    }
    // Windows：重命名替换要求路径无占用句柄；读者打开窗口通常为毫秒级，有限重试
    let mut rename_result = std::fs::rename(&temp, log_path);
    for _ in 0..ROTATE_RENAME_RETRIES {
        match &rename_result {
            Ok(()) => break,
            Err(_) => std::thread::sleep(Duration::from_millis(20)),
        }
        rename_result = std::fs::rename(&temp, log_path);
    }
    if let Err(e) = rename_result {
        let _ = std::fs::remove_file(&temp);
        log.reopen(log_path);
        tracing::warn!(
            target: "background",
            error = %e,
            "日志轮转重命名失败（存在占用句柄），本轮放弃，下个 checkpoint 重试"
        );
        return None;
    }
    log.reopen(log_path);
    log.offset = data.len() as u64;
    log.last_start = None;
    if let Ok(mut guard) = info.write() {
        // 轮转后行号重新从 1 编号：内存计数与文件自洽
        guard.line_count = new_lines;
    }
    Some(new_lines)
}

// ============================================================================
// 编码与提示检测（T-AB-10 3/4）
// ============================================================================

/// 控制台字节解码（与 agent-tools shell.rs:1286-1291 同一口径：先按 UTF-8，
/// 失败 lossy，保证中文输出在 Windows 管道下不回退）
fn decode_console_bytes(raw: &[u8]) -> String {
    match std::str::from_utf8(raw) {
        Ok(s) => s.to_string(),
        Err(_) => String::from_utf8_lossy(raw).into_owned(),
    }
}

/// 去掉日志物理行前缀（`[out]`/`[err]`），还原用户可见内容
fn strip_log_prefix(line: &str) -> String {
    line.strip_prefix(OUT_PREFIX)
        .or_else(|| line.strip_prefix(ERR_PREFIX))
        .unwrap_or(line)
        .to_string()
}

/// 日志物理行（`<前缀><内容>\n`）→ 用户可见内容（去前缀、去换行）
fn file_line_to_user(raw: &[u8]) -> String {
    let mut s = decode_console_bytes(raw);
    if s.ends_with('\n') {
        s.pop();
    }
    strip_log_prefix(&s)
}

/// 行尾提示检测：仅匹配行尾（trim 尾随空白后后缀匹配），行中出现不算命中。
/// 检测结果仅作「候选提示」——由 AI 判断是否发送输入（T-AB-10 4 误报控制）。
fn detect_prompt(line: &str) -> bool {
    let trimmed = line.trim_end();
    PROMPT_PATTERNS.iter().any(|p| trimmed.ends_with(p))
}

// ============================================================================
// 摘要模板（T-AB-09 4：REQ-A05 摘要，R-AB3 唤醒注入消费）
// ============================================================================

/// 任务摘要模板：`任务 <id> 已运行 <duration>，日志已累积 <line_count> 行，
/// 最近输出时间 <timestamp>`。status() 组装并 trace 留痕，R-AB3 作为
/// 唤醒注入（PendingNudgeChannel 通知正文）消费。
fn task_summary(info: &BackgroundTaskInfo, duration_ms: u64) -> String {
    format!(
        "任务 {} 已运行 {}，日志已累积 {} 行，最近输出时间 {}",
        info.task_id, duration_ms, info.line_count, info.last_output_at_ms
    )
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

    /// 纯构造（不启动归档线程；`new()` 与 `with_config` 共用）。
    /// 资源段字段取默认：采样配置 2s/60s、通知投递器未接线（留痕兜底）。
    fn construct(log_root: PathBuf, retention: Duration, max_tasks: usize) -> Self {
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
    /// 接线点（登记偏差）：main.rs 在构造 registry 后调用一次（main.rs 属 C3
    /// 域，本轮不在壳侧改动——事件发射当前经 LogEventSink 结构化留痕，
    /// C3/T-AB-19 接线后即切换为真实事件通道发射，payload 形状不变）。
    #[allow(dead_code)] // 接线点在 C3（main.rs），接线后消除；测试构建同样未接线故用普通 allow
    pub(crate) fn set_event_bridge(&self, bridge: EventBridge, session_id: String) {
        self.notifier
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .set_event_sink(Arc::new(EventBridgeSink {
                bridge,
                session_id,
            }));
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
    fn is_terminal(state: TaskState) -> bool {
        matches!(state, TaskState::Completed | TaskState::Failed | TaskState::Killed)
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
    fn stdin_closed(task_id: &str) -> ToolError {
        ToolError::new(
            codes::TOOL_EXECUTION_FAILED,
            format!(
                "stdin_closed：任务 {task_id} 的 stdin 管道已关闭或未接通（进程可能已退出，或 spawn 未开启 stdin 管道）"
            ),
        )
    }

    /// 取任务句柄（不存在 → NotFound）。
    fn get_handle(&self, task_id: &str) -> Result<Arc<TaskHandle>, ToolError> {
        let tasks = self
            .tasks
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        tasks
            .get(task_id)
            .cloned()
            .ok_or_else(|| self.not_found(task_id))
    }

    /// 命令摘要（前 64 字符）。
    fn summarize_command(command: &str) -> String {
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
            let tasks = self
                .tasks
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            for (task_id, handle) in tasks.iter() {
                let info = handle
                    .info
                    .read()
                    .unwrap_or_else(|p| p.into_inner());
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
    async fn evict_overflow(&self) {
        let mut overflow: Vec<(String, Arc<TaskHandle>)> = Vec::new();
        let max = self.max_tasks;
        {
            let tasks = self
                .tasks
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            if tasks.len() <= max {
                return;
            }
            // FIFO：started_at 最早者最旧；同值按 task_id 排序兜底
            let mut entries: Vec<(&String, &Arc<TaskHandle>)> = tasks.iter().collect();
            entries.sort_by(|a, b| {
                let a_info = a
                    .1
                    .info
                    .read()
                    .unwrap_or_else(|p| p.into_inner());
                let b_info = b
                    .1
                    .info
                    .read()
                    .unwrap_or_else(|p| p.into_inner());
                (a_info.started_at_ms, a.0)
                    .cmp(&(b_info.started_at_ms, b.0))
            });
            for (id, handle) in entries.into_iter().take(tasks.len() - max) {
                overflow.push((id.clone(), Arc::clone(handle)));
            }
        }
        for (task_id, handle) in overflow {
            let is_running = handle
                .info
                .read()
                .unwrap_or_else(|p| p.into_inner())
                .status
                == TaskState::Running;
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

#[async_trait::async_trait]
impl BackgroundTaskManager for BackgroundTaskRegistry {
    /// adopt：登记任务 + 接线 daemon Job（Windows，best-effort）+ 建 meta +
    /// 启动转发循环（落盘 + 预览 + 计数 + checkpoint + 提示检测）。
    ///
    /// 诚实边界：Windows 8+ 支持嵌套 Job，本机实测分配成功（宿主 Job 包裹不阻断）；
    /// 若宿主 Job 禁止嵌套，分配会返回拒绝——接线失败仅 warn 降级（孤儿保护退化
    /// 为显式 kill 路径），不阻断注册。调用方契约（T-AB-02）：child 必须以
    /// `kill_on_drop(false)` spawn。stdin：`child.stdin.take()` 托管进
    /// `TaskHandle.stdin`（T-AB-10 1）；若 spawn 侧未开管道（当前 shell.rs:753
    /// 为 `Stdio::null()`），槽位为空，send_input 按 stdin_closed 分类。
    async fn adopt(&self, req: BackgroundAdoptRequest) -> Result<BackgroundTaskRef, ToolError> {
        let task_id = format!("task-{}", self.task_seq.fetch_add(1, Ordering::Relaxed));
        let log_path = self.log_root.join(format!("{task_id}.log"));
        let meta_path = self.log_root.join(format!("{task_id}.meta.json"));
        let started_at_ms = now_millis() as u64;
        let command = Self::summarize_command(&req.command);
        let cwd = req.cwd.display().to_string();

        // Windows：daemon Job 接线（best-effort；失败降级不阻断）
        #[cfg(windows)]
        if let Some(pid) = req.child.id() {
            if let Err(e) = crate::process::assign_pid_to_daemon_job(pid) {
                tracing::warn!(
                    target: "background",
                    task_id = %task_id,
                    pid,
                    error = %e,
                    "assign daemon task to job failed; 孤儿保护降级（显式 kill 路径兜底）"
                );
            }
        }

        let mut child = req.child;
        let pid = child.id().unwrap_or(0);
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let stdin_slot = Arc::new(TokioMutex::new(child.stdin.take()));

        let info = Arc::new(RwLock::new(BackgroundTaskInfo {
            task_id: task_id.clone(),
            command,
            cwd,
            status: TaskState::Running,
            started_at_ms,
            duration_ms: 0,
            finished_at_ms: None,
            exit_code: None,
            log_path: log_path.display().to_string(),
            line_count: 0,
            last_output_at_ms: started_at_ms,
            is_daemon: req.is_daemon,
            resource: None, // R-AB3 采样
            prompt: None,   // T-AB-10 提示检测就位
            owner_run_id: req.owner_run_id,
        }));
        let child_slot = Arc::new(Mutex::new(Some(child)));
        let preview = Arc::new(Mutex::new(OutputPreview::default()));

        // meta 创建即写初值（T-AB-09 3；失败仅 warn，不阻断注册）
        write_meta_now(&info, &meta_path, &[], 0, false, None, 0);

        // 转发循环：双流 → 落盘 + 内存预览 + 行计数 + checkpoint + 提示检测；
        // EOF 全闭后收尾（wait + 终态 meta + stdin 槽清空 + 状态机 +
        // Crashed 通知）。Arc 循环安全：writer 持 shared 克隆，任务完成即释放，
        // 无泄漏。
        let notifier = self
            .notifier
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        let resource_monitor = req.resource_monitor;
        let writer = tokio::spawn({
            let info = Arc::clone(&info);
            let child_slot = Arc::clone(&child_slot);
            let preview = Arc::clone(&preview);
            let stdin_slot = Arc::clone(&stdin_slot);
            let log_path = log_path.clone();
            let meta_path = meta_path.clone();
            let notifier = notifier.clone();
            async move {
                let state =
                    forward_streams(&info, &preview, stdout, stderr, &log_path, &meta_path).await;
                finish_task(
                    &info,
                    &child_slot,
                    &stdin_slot,
                    &meta_path,
                    state,
                    &notifier,
                    resource_monitor,
                )
                .await;
            }
        });

        // 资源采样循环（T-AB-15 3）：仅启用 resourceMonitor 的任务挂载；
        // 与转发器同属 tokio runtime 的独立任务（不额外开 OS 线程），
        // 采样开销微秒级（JobObject FFI / /proc 读）。
        let sampler = if resource_monitor {
            Some(spawn_resource_monitor_loop(
                Arc::clone(&info),
                pid,
                log_path.with_extension("samples.jsonl"),
                notifier.clone(),
                self.resource_config,
                task_id.clone(),
                self.sampler.clone(),
            ))
        } else {
            None
        };

        let handle = Arc::new(TaskHandle {
            info,
            pid,
            child: child_slot,
            writer,
            sampler,
            preview,
            stdin: stdin_slot,
            diagnostics: Arc::new(Mutex::new(Vec::new())),
            notifier,
        });
        self.tasks
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(task_id.clone(), Arc::clone(&handle));
        // 容量兜底（T-AB-12 5）：超上限 FIFO 淘汰最旧条目（运行中先终止）。
        // 在登记之后执行——新任务永不成为本轮淘汰对象。
        self.evict_overflow().await;

        Ok(BackgroundTaskRef { task_id, log_path })
    }

    async fn list(&self, include_finished: bool) -> Result<Vec<BackgroundTaskInfo>, ToolError> {
        // 惰性清扫（T-AB-12 1「list 调用时同样惰性过滤」）：不依赖归档循环
        // 线程的到达时序——每次 list 前清一遍到期终态条目（n ≤ 200，代价 O(n)）。
        // 已归档条目自此不可见（list/status/read_log 均 NotFound 附归档指引）。
        self.archive_expired();
        let tasks = self
            .tasks
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let now = now_millis() as u64;
        let mut out: Vec<BackgroundTaskInfo> = Vec::with_capacity(tasks.len());
        for handle in tasks.values() {
            let mut info = handle
                .info
                .read()
                .unwrap_or_else(|p| p.into_inner())
                .clone();
            if !include_finished && Self::is_terminal(info.status) {
                continue;
            }
            // 运行中任务：duration 实时计算（终态由 writer 固化）
            if info.finished_at_ms.is_none() {
                info.duration_ms = now.saturating_sub(info.started_at_ms);
            }
            out.push(info);
        }
        // 稳定序：started_at 降序（新在前，前端 sortBackgroundTasksByStartedAt 同口径）
        out.sort_by(|a, b| b.started_at_ms.cmp(&a.started_at_ms));
        Ok(out)
    }

    /// status：状态快照 + 尾部（内存预览，无 [out]/[err] 前缀）+ 摘要模板。
    ///
    /// 终态 flush 自洽（T-AB-09 6）：状态翻转为终态发生在 writer 任务内、全部
    /// 落盘与 meta 收尾之后——本方法读到终态即代表 tail/line_count 与文件一致，
    /// 无需额外 await writer JoinHandle（屏障即终态翻转本身）。
    async fn status(&self, task_id: &str) -> Result<BackgroundTaskStatus, ToolError> {
        let handle = self.get_handle(task_id)?;
        let info = handle
            .info
            .read()
            .unwrap_or_else(|p| p.into_inner());
        let tail = {
            let preview = handle
                .preview
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            preview.tail_lines(20).join("\n")
        };
        let now = now_millis() as u64;
        let duration_ms = info
            .finished_at_ms
            .map(|f| f.saturating_sub(info.started_at_ms))
            .unwrap_or_else(|| now.saturating_sub(info.started_at_ms));
        // 终止诊断留痕（T-AB-11：kill 两阶段留痕；透传冻结字段
        // termination_diagnostics）
        let termination_diagnostics = {
            let guard = handle
                .diagnostics
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            guard.clone()
        };
        // 摘要模板（REQ-A05；R-AB3 唤醒注入消费，先经 trace 留痕）
        let summary = task_summary(&info, duration_ms);
        tracing::trace!(
            target: "background",
            task_id = %info.task_id,
            summary = %summary,
            "任务状态摘要"
        );
        Ok(BackgroundTaskStatus {
            task_id: info.task_id.clone(),
            status: info.status,
            exit_code: info.exit_code,
            log_path: info.log_path.clone(),
            duration_ms,
            line_count: info.line_count,
            last_output_at_ms: info.last_output_at_ms,
            resource: info.resource.clone(),
            tail,
            prompt: info.prompt.clone(),
            termination_diagnostics,
        })
    }

    /// read_log：按行范围读取（REQ-A05，T-AB-09 2）。
    ///
    /// - `start_line=None`：尾部读取——`file_info` 拿 size → `read_chunk` 从尾回退
    ///   64KB → 本地拆行取最后 max_lines 行（完整行边界，容忍 append 半行）；
    /// - `start_line=Some(n)`：`.meta.json` checkpoint 二分定位行首偏移 →
    ///   `read_chunk` 顺序读（索引只做快速定位，读到索引末尾回退文件实际末尾）；
    /// - 返回行内容为「去前缀」的用户可见文本；行号指文件物理行号（1-indexed）；
    /// - 空结果约定：start_line=0 / end_line=0（无返回行）。
    async fn read_log(
        &self,
        task_id: &str,
        start_line: Option<u64>,
        max_lines: u64,
    ) -> Result<LogSlice, ToolError> {
        let handle = self.get_handle(task_id)?;
        let (log_path, total_lines) = {
            let guard = handle
                .info
                .read()
                .unwrap_or_else(|p| p.into_inner());
            (PathBuf::from(guard.log_path.clone()), guard.line_count)
        };
        if max_lines == 0 {
            return Ok(LogSlice {
                task_id: task_id.to_string(),
                start_line: 0,
                end_line: 0,
                total_lines,
                lines: Vec::new(),
                truncated: false,
            });
        }
        // 日志文件尚未创建（任务尚无输出，或落盘降级）：返回空切片
        if !log_path.exists() {
            return Ok(LogSlice {
                task_id: task_id.to_string(),
                start_line: 0,
                end_line: 0,
                total_lines: 0,
                lines: Vec::new(),
                truncated: false,
            });
        }
        let meta_path = log_path.with_extension("meta.json");
        let (lines, first_line, truncated) = match start_line {
            None => read_log_tail(&log_path, total_lines, max_lines),
            Some(n) => read_log_range(&log_path, &meta_path, total_lines, n, max_lines),
        };
        let end_line = if lines.is_empty() {
            0
        } else {
            first_line + lines.len() as u64 - 1
        };
        Ok(LogSlice {
            task_id: task_id.to_string(),
            start_line: first_line,
            end_line,
            total_lines,
            lines,
            truncated,
        })
    }

    /// send_input：向任务 stdin 写入（T-AB-10 2）。
    ///
    /// - 默认末尾追加 `\n`；`append_newline=false` 显式关闭；
    /// - 失败分类：task_not_found（NotFound）/ stdin_closed（BrokenPipe 后清空
    ///   Option，后续调用继续返回 stdin_closed）/ 成功；
    /// - tokio 非阻塞写入（背压由管道缓冲自然承担，不影响子进程执行）。
    async fn send_input(
        &self,
        task_id: &str,
        text: &str,
        append_newline: bool,
    ) -> Result<(), ToolError> {
        let handle = self.get_handle(task_id)?;
        // 双写竞态（T-AB-10 5）：Mutex 串行化；写入失败清空 Option
        let mut guard = handle.stdin.lock().await;
        let Some(mut stdin) = guard.take() else {
            // 槽位为空：管道从未接通（spawn 未开管道）或已关闭（进程退出 / BrokenPipe）
            return Err(Self::stdin_closed(task_id));
        };
        let mut payload = String::with_capacity(text.len() + 1);
        payload.push_str(text);
        if append_newline {
            payload.push('\n');
        }
        use tokio::io::AsyncWriteExt;
        let mut res = stdin.write_all(payload.as_bytes()).await;
        if res.is_ok() {
            res = stdin.flush().await;
        }
        match res {
            Ok(()) => {
                *guard = Some(stdin);
                Ok(())
            }
            Err(e) => {
                // 写入失败（BrokenPipe 等）：槽位已 take，置空保持（后续调用
                // 走「槽位为空 → stdin_closed」分支，不再触碰管道）
                tracing::debug!(
                    target: "background",
                    task_id = %task_id,
                    error = %e,
                    "stdin 写入失败，槽位清空（stdin_closed）"
                );
                Err(Self::stdin_closed(task_id))
            }
        }
    }

    /// 两阶段终止（T-AB-11）：优雅（`terminate_process_tree_graceful`）→
    /// 5s 等待窗口 → 强制（`terminate_process_tree`），KillResult 三态返回。
    ///
    /// 状态机联动与纪律：kill 成功 → status=Killed、finished_at 落 meta（.log
    /// 保留）；收尾顺序遵循 writer 同款纪律——「meta 落盘 → stdin 清空 →
    /// 状态翻转」，且**先 await writer 收口**（writer 的 child 槽为 None 时按
    /// Killed 收尾，kill 随后以权威值（真实 exit_code）幂等覆盖）。
    ///
    /// 边界：
    /// - 终态任务 → AlreadyExited（携带自然退出码），不强行升级；
    /// - kill 与自然退出竞态（try_wait 命中 / writer 已取走子进程）→
    ///   AlreadyExited，不强行升级（进程已不在，升级无意义）；
    /// - 任务已归档 → NotFound（.log 保留，错误消息附可恢复指引）；
    /// - Windows 优雅阶段不保证成功（本机实测：taskkill 无 /F 对控制台程序
    ///   必然返回「只能强制终止」——优雅失败即跳过等待直接升级，省 5s；
    ///   测试以「两阶段路径可执行」而非「优雅一定成功」为准）。
    ///
    /// 职责分离：kill 不关闭 daemon Job 句柄（Job 管宿主崩溃兜底，关闭会影响
    /// 其他任务；两条路径职责分离——Job 管「宿主崩溃」，kill 管「任务终止」）。
    async fn kill(&self, task_id: &str) -> Result<KillResult, ToolError> {
        let handle = self.get_handle(task_id)?;
        // 终态短路：AlreadyExited（不触碰子进程槽，writer 已收口）
        {
            let info = handle
                .info
                .read()
                .unwrap_or_else(|p| p.into_inner());
            if Self::is_terminal(info.status) {
                return Ok(KillResult::AlreadyExited {
                    task_id: task_id.to_string(),
                    exit_code: info.exit_code,
                });
            }
        }
        // 独占取子进程（kill 与 writer 的 finish_task 二选一拿到所有权；
        // 竞态窗口内 writer 已取走 → 按 AlreadyExited 处理，不强行升级）
        let child = handle
            .child
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        let Some(mut child) = child else {
            let exit_code = handle
                .info
                .read()
                .unwrap_or_else(|p| p.into_inner())
                .exit_code;
            return Ok(KillResult::AlreadyExited {
                task_id: task_id.to_string(),
                exit_code,
            });
        };

        // 1) try_wait 先查一次（可省 5s：进程可能已自然退出——竞态收敛为
        //    AlreadyExited；子进程放回槽位，writer 正常收口为 Completed/Failed）
        match child.try_wait() {
            Ok(Some(status)) => {
                *handle
                    .child
                    .lock()
                    .unwrap_or_else(|p| p.into_inner()) = Some(child);
                return Ok(KillResult::AlreadyExited {
                    task_id: task_id.to_string(),
                    exit_code: status.code(),
                });
            }
            Ok(None) => {}
            Err(e) => {
                *handle
                    .child
                    .lock()
                    .unwrap_or_else(|p| p.into_inner()) = Some(child);
                return Ok(KillResult::Failed {
                    task_id: task_id.to_string(),
                    reason: format!("进程状态探测失败：{e}"),
                });
            }
        }

        // 2) 阶段一：优雅终止请求（进程树；Windows taskkill 无 /F）
        let graceful_at_ms = now_millis() as u64;
        let graceful = crate::process::terminate_process_tree_graceful(handle.pid);
        let mut diagnostics = vec![format!(
            "优雅终止请求已发送（pid={}，发送时间={}ms，结果={}）",
            handle.pid,
            graceful_at_ms,
            if graceful.is_ok() { "已受理" } else { "未生效" }
        )];

        // 3) 等待窗口（轮询式，不移动子进程所有权——窗口未退出可继续升级等待）。
        //    优雅未生效（Windows 控制台进程的典型路径，本机实测 taskkill 无 /F
        //    对 powershell/cmd 必失败）→ 跳过 5s 等待直接升级
        let graceful_exit = match &graceful {
            Ok(()) => poll_exit(&mut child, KILL_GRACEFUL_WINDOW).await,
            Err(_reason) => None, // 优雅未生效 → 直接升级
        };

        // 4) 阶段二（升级）或优雅成功收口
        let (exit_code, via_force) = match graceful_exit {
            Some(status) => (status.code(), false),
            None => {
                let escalate_at_ms = now_millis() as u64;
                let escalate_reason = match &graceful {
                    Ok(()) => "5s 优雅等待超时".to_string(),
                    Err(reason) => format!("优雅请求未生效（{reason}）"),
                };
                // 阶段二：强制树杀（Windows taskkill /F /T；Unix 侧与优雅同型
                // ——SIGTERM，对忽略信号的进程双方均无效，见 Unix 平台限制）
                let forced = crate::process::terminate_process_tree(handle.pid);
                diagnostics.push(format!(
                    "强制终止升级（原因：{escalate_reason}，升级时间={escalate_at_ms}ms，结果={})",
                    if forced.is_ok() { "已执行" } else { "失败" }
                ));
                match forced {
                    Ok(()) => match poll_exit(&mut child, KILL_FORCE_WINDOW).await {
                        Some(status) => (status.code(), true),
                        None => {
                            // 强制后仍不退出（极顽固进程 / 句柄异常）：
                            // 放回槽位，writer 保持生命周期；Failed 留痕
                            *handle
                                .child
                                .lock()
                                .unwrap_or_else(|p| p.into_inner()) = Some(child);
                            return Ok(KillResult::Failed {
                                task_id: task_id.to_string(),
                                reason: format!(
                                    "强制终止已执行但 {} 毫秒内未退出",
                                    KILL_FORCE_WINDOW.as_millis()
                                ),
                            });
                        }
                    },
                    Err(e) => {
                        // 强制失败：进程可能已消失（竞态），put back 由 writer
                        // 收口，返回 Failed
                        *handle
                            .child
                            .lock()
                            .unwrap_or_else(|p| p.into_inner()) = Some(child);
                        return Ok(KillResult::Failed {
                            task_id: task_id.to_string(),
                            reason: format!("强制终止失败：{e}"),
                        });
                    }
                }
            }
        };

        // 5) 收口：等 writer 完成（kill 已取走子进程 → writer 的 finish_task 走
        //    child=None 的 Killed 收尾路径，快速完成）。JoinHandle 在 Arc 共享
        //    所有权下无法移动/可变借用（join 需要所有权），以 is_finished 轮询
        //    + async sleep 让步替代；窗口内未完成（孙进程持管道等极端）放弃
        //    等待，不阻塞调用方
        drop(child);
        {
            let deadline = tokio::time::Instant::now() + WRITER_DRAIN_TIMEOUT;
            while !handle.writer.is_finished() {
                if tokio::time::Instant::now() >= deadline {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }

        // 6) 终态联动（纪律：meta 落盘 → stdin 清空 → 状态翻转）
        let finished_at_ms = now_millis() as u64;
        {
            // 6a) meta 落盘：基于磁盘现有 meta（保留 checkpoint/轮转字段）更新
            //     终态；磁盘 meta 缺失（极端）则按内存快照组装基本 meta
            let meta_path = self
                .log_root
                .join(format!("{task_id}.meta.json"));
            let mut meta = read_meta(&meta_path).unwrap_or_else(|| {
                let info = handle
                    .info
                    .read()
                    .unwrap_or_else(|p| p.into_inner());
                TaskMeta::from_info(&info, Vec::new(), 0, false, None, 0)
            });
            meta.status = "killed".to_string();
            meta.finished_at_ms = Some(finished_at_ms);
            meta.exit_code = exit_code;
            if let Err(e) = write_meta(&meta_path, &meta) {
                tracing::warn!(
                    target: "background",
                    task_id = %task_id,
                    error = %e,
                    "kill 终态 meta 落盘失败（.log 保留不受影响）"
                );
            }
            // 6b) stdin 槽清空（终态后注入确定性 stdin_closed）
            if let Ok(mut guard) = handle.stdin.try_lock() {
                *guard = None;
            }
            // 6c) 状态翻转（屏障最后一步；writer 若尚未收口其 finish_task 仅
            //     重复写同值 Killed，不产生状态回退）
            if let Ok(mut info) = handle.info.write() {
                info.status = TaskState::Killed;
                info.exit_code = exit_code;
                info.finished_at_ms = Some(finished_at_ms);
                info.duration_ms = finished_at_ms.saturating_sub(info.started_at_ms);
            }
        }
        // 诊断留痕入槽（status().termination_diagnostics 透传）
        if let Ok(mut guard) = handle.diagnostics.lock() {
            *guard = diagnostics;
        }

        Ok(KillResult::Killed {
            task_id: task_id.to_string(),
            via_force,
        })
    }
}

// ── 转发循环与收尾 ───────────────────────────────────────────────────────────

/// 单流读取 helper：`reader` 为 None（未接管道）时返回 EOF（Ok(0)）。
async fn read_buf<R: AsyncBufRead + Unpin>(
    reader: Option<&mut R>,
    buf: &mut Vec<u8>,
) -> std::io::Result<usize> {
    match reader {
        Some(r) => r.read_until(b'\n', buf).await,
        None => Ok(0),
    }
}

/// 转发循环的收尾状态（转交 finish_task 消费）
struct LogState {
    log: LogWriter,
    checkpoints: Vec<CheckpointEntry>,
    rotated: bool,
    rotated_at_ms: Option<u64>,
    dropped_lines: u64,
}

/// stdout/stderr → 落盘 + 内存预览 + 行计数 + checkpoint + 提示检测
/// 转发循环（双流并行，管道满不死锁；EOF 全闭即返回）。
///
/// 顺序口径：stdout/stderr 是两条独立管道，本循环用 select 交替读取，
/// 落盘顺序为「到达序」近似（同一次 select 内先就绪者先写）。
async fn forward_streams(
    info: &Arc<RwLock<BackgroundTaskInfo>>,
    preview: &Arc<Mutex<OutputPreview>>,
    stdout: Option<ChildStdout>,
    stderr: Option<ChildStderr>,
    log_path: &Path,
    meta_path: &Path,
) -> LogState {
    let mut out = stdout.map(tokio::io::BufReader::new);
    let mut err = stderr.map(tokio::io::BufReader::new);
    let mut out_line = Vec::with_capacity(4096);
    let mut err_line = Vec::with_capacity(4096);
    let mut log = LogWriter::default();
    let mut checkpoints: Vec<CheckpointEntry> = Vec::new();
    let mut rotated = false;
    let mut rotated_at_ms: Option<u64> = None;
    let mut dropped_lines: u64 = 0;

    loop {
        let out_open = out.is_some();
        let err_open = err.is_some();
        if !out_open && !err_open {
            break;
        }
        tokio::select! {
            r = read_buf(out.as_mut(), &mut out_line), if out_open => {
                match r {
                    Ok(0) => { out = None; }
                    Ok(_) => {
                        write_output_line(
                            info, preview, &mut log, log_path, meta_path,
                            &mut checkpoints, &mut rotated, &mut rotated_at_ms,
                            &mut dropped_lines, &mut out_line, false,
                        );
                    }
                    Err(e) => {
                        tracing::debug!(target: "background", error = %e, "stdout 读取失败，提前 EOF");
                        out = None;
                    }
                }
            }
            r = read_buf(err.as_mut(), &mut err_line), if err_open => {
                match r {
                    Ok(0) => { err = None; }
                    Ok(_) => {
                        write_output_line(
                            info, preview, &mut log, log_path, meta_path,
                            &mut checkpoints, &mut rotated, &mut rotated_at_ms,
                            &mut dropped_lines, &mut err_line, true,
                        );
                    }
                    Err(e) => {
                        tracing::debug!(target: "background", error = %e, "stderr 读取失败，提前 EOF");
                        err = None;
                    }
                }
            }
        }
    }
    LogState {
        log,
        checkpoints,
        rotated,
        rotated_at_ms,
        dropped_lines,
    }
}

/// 行级累积：剥离行尾 \r\n → 解码（decode_console_bytes 口径）→ 落盘（带
/// `[out]`/`[err]` 前缀）→ 行计数 + 最近输出时间 → 预览 → 周期 checkpoint →
/// 行尾提示检测。空行也是行（行计数语义），不跳过。
#[allow(clippy::too_many_arguments)]
fn write_output_line(
    info: &Arc<RwLock<BackgroundTaskInfo>>,
    preview: &Arc<Mutex<OutputPreview>>,
    log: &mut LogWriter,
    log_path: &Path,
    meta_path: &Path,
    checkpoints: &mut Vec<CheckpointEntry>,
    rotated: &mut bool,
    rotated_at_ms: &mut Option<u64>,
    dropped_lines: &mut u64,
    raw: &mut Vec<u8>,
    is_err: bool,
) {
    while matches!(raw.last(), Some(b'\n') | Some(b'\r')) {
        raw.pop();
    }
    let line = decode_console_bytes(raw);
    raw.clear();
    let prefix = if is_err { ERR_PREFIX } else { OUT_PREFIX };
    // 记录本行行首偏移（checkpoint 用：精确行号读取从行首起读）
    let start_offset = log.offset;
    log.append_line(log_path, prefix, &line);

    let now = now_millis() as u64;
    let line_count;
    let prompt_hit = {
        let Ok(mut guard) = info.write() else {
            return;
        };
        guard.line_count += 1;
        guard.last_output_at_ms = now;
        line_count = guard.line_count;
        if guard.prompt.is_none() && detect_prompt(&line) {
            // 命中行作为候选提示就位（T-AB-10 3；通知接线留 R-AB3）
            guard.prompt = Some(line.clone());
            true
        } else {
            false
        }
    };
    if let Ok(mut preview_guard) = preview.lock() {
        preview_guard.push_line(line);
    }

    // 周期落盘点：每 512 行 checkpoint + 轮转护栏检查
    if line_count % CHECKPOINT_INTERVAL_LINES == 0 {
        if let Some(new_total) = maybe_rotate_log(log_path, log, info) {
            // 轮转成功：行号从 1 重新编号，旧 checkpoint 全部失效
            checkpoints.clear();
            *rotated = true;
            *rotated_at_ms = Some(now_millis() as u64);
            *dropped_lines = dropped_lines.saturating_add(line_count.saturating_sub(new_total));
        } else {
            checkpoints.push(CheckpointEntry {
                line: line_count,
                offset: start_offset,
            });
        }
        write_meta_now(
            info,
            meta_path,
            checkpoints,
            log.offset,
            *rotated,
            *rotated_at_ms,
            *dropped_lines,
        );
    }
    if prompt_hit {
        // 提示命中即落 meta（与 checkpoint 写入幂等，多写一次无害）
        write_meta_now(
            info,
            meta_path,
            checkpoints,
            log.offset,
            *rotated,
            *rotated_at_ms,
            *dropped_lines,
        );
    }
}

/// 收尾：双流 EOF 后取 child 收口（wait），写终态 meta（exit_code/finished_at），
/// 清空 stdin 槽位（终态后 send_input 确定性 stdin_closed），推进状态机，
/// 最后投递 Crashed 通知（T-AB-16 3：仅 resourceMonitor 任务）。
///
/// 顺序即屏障：状态翻转为终态是收尾的最后一步（全部落盘、sync、meta 均已
/// 完成）——status()/list() 读到终态即保证 tail/line_count 与文件自洽
/// （T-AB-09 6）。锁不在 await 点持有。
async fn finish_task(
    info: &Arc<RwLock<BackgroundTaskInfo>>,
    child: &Arc<Mutex<Option<Child>>>,
    stdin_slot: &Arc<TokioMutex<Option<ChildStdin>>>,
    meta_path: &Path,
    mut state: LogState,
    notifier: &TaskNotifier,
    resource_monitor: bool,
) {
    // 1) 日志文件 sync（退出后文件可读）
    state.log.sync();
    // 2) 收口子进程（wait）
    let child = child
        .lock()
        .map(|mut guard| guard.take())
        .unwrap_or(None);
    let (task_state, exit_code) = match child {
        Some(mut child) => match child.wait().await {
            Ok(status) => {
                if status.success() {
                    (TaskState::Completed, status.code())
                } else {
                    (TaskState::Failed, status.code())
                }
            }
            Err(e) => {
                tracing::warn!(
                    target: "background",
                    error = %e,
                    "wait 子进程收口失败，按 Failed 收场"
                );
                (TaskState::Failed, None)
            }
        },
        // child 被 kill 提前取走（T-AB-11：kill 两阶段终止持有子进程句柄做
        // wait；本路径按 Killed 收尾，kill 随后以权威值幂等覆盖）
        None => (TaskState::Killed, None),
    };
    let finished_at_ms = now_millis() as u64;

    // 3) 终态 meta：exit_code / finished_at / 最终行数 / 补末行 checkpoint
    let meta = {
        let Ok(guard) = info.read() else {
            return;
        };
        let mut checkpoints = state.checkpoints;
        if let Some(start) = state.log.last_start {
            // 补终态 checkpoint（末行行首偏移），精确行号读取在文件末尾附近
            // 免于从头扫描；与既有条目行号相同则跳过（幂等）
            if !checkpoints.iter().any(|c| c.line == guard.line_count) {
                checkpoints.push(CheckpointEntry {
                    line: guard.line_count,
                    offset: start,
                });
            }
        }
        let mut meta = TaskMeta::from_info(
            &guard,
            checkpoints,
            state.log.offset,
            state.rotated,
            state.rotated_at_ms,
            state.dropped_lines,
        );
        drop(guard);
        meta.status = task_state_str(&task_state).to_string();
        meta.finished_at_ms = Some(finished_at_ms);
        meta.exit_code = exit_code;
        meta
    };
    if let Err(e) = write_meta(meta_path, &meta) {
        tracing::warn!(
            target: "background",
            error = %e,
            path = %meta_path.display(),
            "终态 meta 落盘失败"
        );
    }

    // 4) 关闭 stdin 槽位（终态后注入确定性失败，不依赖 BrokenPipe 时序）
    if let Ok(mut guard) = stdin_slot.try_lock() {
        *guard = None;
    }

    // 5) 状态翻转（屏障最后一步）
    if let Ok(mut info_guard) = info.write() {
        info_guard.status = task_state;
        info_guard.exit_code = exit_code;
        info_guard.finished_at_ms = Some(finished_at_ms);
        info_guard.duration_ms = finished_at_ms.saturating_sub(info_guard.started_at_ms);
    }

    // 6) Crashed 通知（T-AB-16 3）：仅 resourceMonitor 任务 + 非零退出码。
    //    尾部日志复用 read_log_tail（read_log(None, 20) 的底层实现，T-AB-09；
    //    日志文件已在 1) sync，文件内容完整）。终态只发生一次，通知天然不重复；
    //    Crashed 不自动杀、不自动降级超时（通知由 AI 裁决，见 notifier 文案）。
    if resource_monitor {
        if let Some(code) = exit_code {
            if code != 0 {
                let (task_id, log_path, line_count, started_at_ms) = {
                    let guard = info.read().unwrap_or_else(|p| p.into_inner());
                    (
                        guard.task_id.clone(),
                        PathBuf::from(guard.log_path.clone()),
                        guard.line_count,
                        guard.started_at_ms,
                    )
                };
                let (tail, _, _) = read_log_tail(&log_path, line_count, 20);
                notifier.notify_failed(
                    &task_id,
                    code,
                    &tail.join("\n"),
                    finished_at_ms.saturating_sub(started_at_ms),
                );
            }
        }
    }
}

// ── 资源采样循环（T-AB-15 3 / T-AB-16 1/2）──────────────────────────────────

/// 事件发射到 `workbench-run-event` 通道的接线实现（T-AB-16 通道二生产路径；
/// 由 [BackgroundTaskRegistry::set_event_bridge] 注入——C3 在 main.rs 接线）。
///
/// payload（冻结契约 §4.5 形状，[crate::resource::TaskNotifier] 组装）→
/// C2 已落地的 AgentEvent 七事件变体（conex-types events.rs，T-AB-17）→
/// [AgentEventEnvelope] → [EventBridge::emit_envelope]。
///
/// 登记偏差（C1 发射点 ↔ C2 契约）：C2 变体含**必填** `session_id` 字段而
/// §4.5 冻结表无该字段；壳层任务注册表无会话概念（任务为会话级存活、独立于
/// run）——本实现以注册表注入的 `session_id` 填充（main.rs 接线时传当前会话
/// id，缺省空串占位），事件归属经信封 runId 与 payload ownerRunId 表达。
#[derive(Clone)]
#[allow(dead_code)] // 生产构造点 = set_event_bridge（C3 main.rs 接线），接线后消除
pub(crate) struct EventBridgeSink {
    /// 事件桥（Tauri 通道 / 测试替身，Clone 共享）
    bridge: EventBridge,
    /// 事件体 session_id（注册表注入；占位见上）
    session_id: String,
}

impl std::fmt::Debug for EventBridgeSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EventBridgeSink")
            .field("session_id", &self.session_id)
            .finish_non_exhaustive()
    }
}

impl EventSink for EventBridgeSink {
    fn emit(&self, event_type: &str, payload: serde_json::Value) {
        // 按冻结契约 §4.5 把 payload 展开为 AgentEvent 变体（字段名 camelCase
        // 由 serde rename_all 处理，此处为 Rust 字段名）
        let event = match event_type {
            "task-suspicious" => AgentEvent::TaskSuspicious {
                session_id: self.session_id.clone(),
                task_id: payload
                    .get("taskId")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                silence_ms: payload.get("silenceMs").and_then(serde_json::Value::as_u64).unwrap_or(0),
                last_output_at_ms: payload
                    .get("lastOutputAtMs")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0),
            },
            "task-failed" => AgentEvent::TaskFailed {
                session_id: self.session_id.clone(),
                task_id: payload
                    .get("taskId")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                exit_code: payload
                    .get("exitCode")
                    .and_then(serde_json::Value::as_i64)
                    .unwrap_or(0) as i32,
                // C2 形状：tail 为逐行 Vec<String>（最后 20 行，read_log 尾部读取
                // 产出语义）；payload 中为换行拼接文本，按行拆回
                tail: payload
                    .get("tail")
                    .and_then(serde_json::Value::as_str)
                    .map(|s| s.lines().map(str::to_string).collect())
                    .unwrap_or_default(),
                duration_ms: payload
                    .get("durationMs")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0),
            },
            other => {
                tracing::warn!(
                    target: "background",
                    event_type = other,
                    "未知任务域事件类型（跳过发射）"
                );
                return;
            }
        };
        // 信封：runId/sequence 不注入（任务为会话级存活、独立于 run 上下文；
        // 前端对无 runId 事件放行不过滤，T-AB-18 消费面按 payload 归组）
        let envelope = AgentEventEnvelope::new(event, None, None);
        self.bridge.emit_envelope(&envelope);
    }
}

/// 资源采样循环：仅启用 resourceMonitor 的任务挂载（[TaskHandle::sampler]）。
///
/// 流程（每拍）：
/// 1. 终态短路：任务已进入终态（writer 收口）→ 循环退出；
/// 2. 采集（[SamplerFn]——生产 [crate::resource::sample_usage]，测试可注入
///    替身）——失败（Job 句柄缺失 / 进程已退出）跳过本拍（不阻断任务执行）；
/// 3. 首采样无基线 → 仅记录基线（丢弃本拍，cpu_percent 不出现 NaN/异常值）；
/// 4. 后续拍：周期差值/墙钟差值算 CPU% → 组装 [ResourceSample]
///    （last_output_at_ms 事件驱动读取——转发器读到字节即更新，非采样轮询）
///    → 更新 info.resource → 追加 `.samples.jsonl`（best-effort 落盘，
///    复用 perf/jsonl.rs:49-72）；
/// 5. 健康判定（T-AB-16 1，仅资源任务）：Healthy → 重置防抖；Suspicious →
///    经 [SuspiciousDebounce] 防抖投递通知（保持期间仅一次，恢复 Healthy
///    重置；双通道经 notifier 投递，见 [crate::resource::TaskNotifier] 接线
///    状态说明）。
///
/// 诚实边界：采样与转发器是两个独立 tokio 任务（同 runtime，不额外开 OS
/// 线程）；采样失败不影响任务生命周期（由 writer 管理）。
#[allow(clippy::too_many_arguments)]
fn spawn_resource_monitor_loop(
    info: Arc<RwLock<BackgroundTaskInfo>>,
    pid: u32,
    samples_path: PathBuf,
    notifier: TaskNotifier,
    config: ResourceMonitorConfig,
    task_id: String,
    sampler: SamplerFn,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        // interval 首拍立即完成 → 跳过（对齐 spawn_snapshot_loop 范式，
        // core_run_commands.rs:1156）；此后每拍 = sample_interval_ms
        let mut interval = tokio::time::interval(Duration::from_millis(
            config
                .sample_interval_ms
                .max(RESOURCE_SAMPLE_INTERVAL_MIN_MS),
        ));
        interval.tick().await;
        // 基线：首采样无基线 → 丢弃（无差值即无无效值）
        let mut baseline: Option<(RawUsage, u64)> = None;
        // Suspicious 防抖状态机（T-AB-16 2：保持期间仅一次，恢复 Healthy 重置）
        let mut debounce = SuspiciousDebounce::default();
        loop {
            interval.tick().await;
            {
                let guard = info.read().unwrap_or_else(|p| p.into_inner());
                if BackgroundTaskRegistry::is_terminal(guard.status) {
                    break; // 终态：writer 已收口，采样停止
                }
            }
            let Ok(raw) = (sampler)(pid) else {
                tracing::debug!(
                    target: "background",
                    task_id = %task_id,
                    pid,
                    "资源采样失败，本拍跳过"
                );
                continue;
            };
            let now = now_millis() as u64;
            let Some((prev_raw, prev_wall)) = baseline.take() else {
                // 首采样：仅建立基线，丢弃本拍
                baseline = Some((raw, now));
                continue;
            };
            baseline = Some((raw, now));
            let cpu_percent = cpu_percent_from_delta(&prev_raw, &raw, prev_wall, now);
            let last_output_at_ms = info
                .read()
                .unwrap_or_else(|p| p.into_inner())
                .last_output_at_ms;
            let sample = ResourceSample {
                sampled_at_ms: now,
                cpu_percent,
                rss_bytes: raw.rss_bytes,
                last_output_at_ms,
                io_read_bytes: 0, // 首版恒 0（诚实边界：进程树 I/O 聚合繁琐，列为可选）
                io_write_bytes: 0,
            };
            if let Ok(mut guard) = info.write() {
                guard.resource = Some(sample.clone());
            }
            // 落盘 `.samples.jsonl`（best-effort：失败仅 debug 留痕，不阻断采样）
            match serde_json::to_string(&sample) {
                Ok(line) => {
                    if let Err(e) =
                        crate::perf::jsonl::append_jsonl_lines(&samples_path, &[line], false)
                    {
                        tracing::debug!(
                            target: "background",
                            task_id = %task_id,
                            error = %e,
                            "采样落盘失败（本拍跳过）"
                        );
                    }
                }
                Err(e) => tracing::debug!(
                    target: "background",
                    task_id = %task_id,
                    error = %e,
                    "采样序列化失败（本拍跳过）"
                ),
            }
            // 健康判定（T-AB-16 1/2）+ Suspicious 通知（SuspiciousDebounce 防抖：
            // 保持期间仅一次，恢复 Healthy 重置后再次 Suspicious 才重新通知；
            // Crashed 属终态，由 finish_task 6 通知，不经采样判定）
            if debounce.observe(judge_health(now, last_output_at_ms, cpu_percent, &config)) {
                notifier.notify_suspicious(
                    &task_id,
                    config.silence_threshold_ms,
                    last_output_at_ms,
                );
            }
        }
    })
}

// ── 两阶段终止等待 helper（T-AB-11）─────────────────────────────────────────

/// 轮询式等待子进程退出：每 100ms `try_wait` 一次，窗口内退出 → 退出状态；
/// 未退出 → None。与 `Child::wait()`（移动所有权）不同，本 helper 不移动
/// child——窗口未退出时调用方保留句柄，可继续走升级路径再次等待。
/// try_wait 探测失败（句柄异常）按「继续等待」处理（窗口到点自然返回 None）。
async fn poll_exit(child: &mut Child, window: Duration) -> Option<std::process::ExitStatus> {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) | Err(_) => {
                if tokio::time::Instant::now() >= deadline {
                    return None;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

// ── read_log 文件侧实现（T-AB-09 2）─────────────────────────────────────────

/// 尾部读取：从文件尾回退 64KB，拆完整行，取最后 max_lines 行。
///
/// 完整行边界：向前探 1 字节判定 chunk 首字节是否为行首（精确边界）；尾部半行
/// （append 进行中）直接丢弃。返回 `(行内容, 首行号, truncated)`。
fn read_log_tail(path: &Path, total_lines: u64, max_lines: u64) -> (Vec<String>, u64, bool) {
    let size = match file_info(path) {
        Ok(info) => info.size,
        Err(e) => {
            tracing::warn!(target: "background", error = %e, "read_log 文件信息读取失败");
            return (Vec::new(), 0, false);
        }
    };
    if size == 0 {
        return (Vec::new(), 0, false);
    }
    let budget = size.min(TAIL_READ_BUDGET);
    let start = size - budget;
    // 精确行边界：探测 chunk 前一字节是否为 \n（是 → chunk 首字节恰为行首）
    let starts_at_line_boundary = start == 0
        || read_chunk(path, start - 1, 1)
            .map(|c| c.data.first() == Some(&b'\n'))
            .unwrap_or(false);
    let chunk = match read_chunk(path, start, budget as usize) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(target: "background", error = %e, "read_log 尾部读取失败");
            return (Vec::new(), 0, false);
        }
    };
    // 按 \n 拆段：每段 = 一个物理行内容（前缀 + 内容，不含换行）；
    // 末尾段丢弃——\n 结尾时是 split 产生的空段（非行），否则是 append 中的
    // 半行（完整行边界语义）。空行（连续 \n）作为独立行保留。
    let mut segments: Vec<&[u8]> = chunk.data.split(|&b| b == b'\n').collect();
    segments.pop();
    // 首段可能为「行中起读」的半行（回退起点不在行首）→ 丢弃
    let mut lines: Vec<String> = segments
        .into_iter()
        .enumerate()
        .filter(|(idx, _)| starts_at_line_boundary || *idx > 0)
        .map(|(_, seg)| file_line_to_user(seg))
        .collect();
    // 取最后 max_lines 行
    let skip = lines.len().saturating_sub(max_lines as usize);
    if skip > 0 {
        lines.drain(..skip);
    }
    let first_line = if lines.is_empty() {
        0
    } else {
        total_lines.saturating_sub(lines.len() as u64) + 1
    };
    (lines, first_line, size > TAIL_READ_BUDGET)
}

/// 精确行号读取：checkpoint 二分定位行首偏移 → 顺序读 64KB 块，跳过起始行前
/// 的行，收集 max_lines 行。索引只做快速定位：读到索引末尾（chunk 为空且
/// 未满足请求）回退文件实际开头重读；EOF 尾部半行不计数。
/// 返回 `(行内容, 首行号, truncated)`；空结果首行号为 0。
fn read_log_range(
    path: &Path,
    meta_path: &Path,
    total_lines: u64,
    mut start_line: u64,
    max_lines: u64,
) -> (Vec<String>, u64, bool) {
    if start_line == 0 {
        start_line = 1; // 防御：行号从 1 起
    }
    if start_line > total_lines {
        return (Vec::new(), 0, false);
    }
    // 二分定位：最大的 checkpoint.line <= start_line（无则从文件头起读）
    let (mut offset, cur_line) = {
        let mut best_offset = 0;
        let mut best_line = 1;
        if let Some(meta) = read_meta(meta_path) {
            for ck in &meta.checkpoints {
                if ck.line <= start_line && ck.line >= best_line {
                    best_offset = ck.offset;
                    best_line = ck.line;
                }
            }
        }
        (best_offset, best_line)
    };
    let mut skipped = start_line - cur_line;
    let mut out: Vec<String> = Vec::new();
    let mut pending: Vec<u8> = Vec::with_capacity(65536);
    let mut read_total: u64 = 0;
    let mut truncated = false;
    let mut restarted = false;
    while out.len() < max_lines as usize {
        if read_total >= RANGE_READ_BUDGET {
            truncated = true;
            break;
        }
        let chunk_size = (RANGE_READ_BUDGET - read_total).min(65536) as usize;
        let chunk = match read_chunk(path, offset, chunk_size) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(target: "background", error = %e, "read_log 顺序读取失败");
                break;
            }
        };
        if chunk.data.is_empty() {
            if !restarted && skipped > 0 && out.is_empty() && offset > 0 {
                // 索引定位失效（轮转/崩溃滞后）：回退文件实际开头重读
                restarted = true;
                offset = 0;
                skipped = start_line - 1;
                pending.clear();
                continue;
            }
            break; // EOF：索引末尾即文件实际末尾
        }
        offset += chunk.data.len() as u64;
        read_total += chunk.data.len() as u64;
        pending.extend_from_slice(&chunk.data);
        // 拆出完整行（含 \n）：drain 掉已完整的行，残余（无 \n 的段）留在
        // pending 等待下一块拼接（跨块行按行解码，UTF-8 不跨行截断）
        let complete_len = {
            let mut end = 0;
            while end < pending.len() {
                match pending[end..].iter().position(|&b| b == b'\n') {
                    Some(pos) => end += pos + 1,
                    None => break,
                }
            }
            end
        };
        if complete_len > 0 {
            let drained: Vec<u8> = pending.drain(..complete_len).collect();
            let mut line_start = 0;
            for (i, &b) in drained.iter().enumerate() {
                if b == b'\n' {
                    let line_bytes = drained[line_start..=i].to_vec();
                    if skipped > 0 {
                        skipped -= 1;
                    } else {
                        out.push(file_line_to_user(&line_bytes));
                        if out.len() >= max_lines as usize {
                            break;
                        }
                    }
                    line_start = i + 1;
                }
            }
        }
        if out.len() >= max_lines as usize {
            break;
        }
    }
    let first_line = if out.is_empty() { 0 } else { start_line };
    (out, first_line, truncated)
}

// ============================================================================
// 命令面（T-AB-08：三条 Tauri 命令恢复）
// ============================================================================

/// list 命令响应：`{ tasks: [...] }`（对齐前端 extractBackgroundTaskArray 取
/// `root.tasks` 的解析面）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundTaskListResponse {
    pub(crate) tasks: Vec<BackgroundTaskWire>,
}

/// 列表条目 wire 形状：字段对齐前端 parseBackgroundTask（taskId/command/
/// startedAt/duration/status/logPath；serde camelCase）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundTaskWire {
    pub(crate) task_id: String,
    pub(crate) command: String,
    /// kebab-case 状态（前端 normalizeBackgroundTaskState 容错映射）
    pub(crate) status: TaskState,
    /// 毫秒时间戳（parseBackgroundTaskStartedAt 直读）
    pub(crate) started_at: u64,
    /// 毫秒
    pub(crate) duration: u64,
    pub(crate) finished_at: Option<u64>,
    pub(crate) exit_code: Option<i32>,
    pub(crate) log_path: String,
    pub(crate) line_count: u64,
    pub(crate) last_output_at: u64,
    pub(crate) is_daemon: bool,
    pub(crate) owner_run_id: Option<String>,
}

impl BackgroundTaskWire {
    fn from_info(info: &BackgroundTaskInfo) -> Self {
        Self {
            task_id: info.task_id.clone(),
            command: info.command.clone(),
            status: info.status,
            started_at: info.started_at_ms,
            duration: info.duration_ms,
            finished_at: info.finished_at_ms,
            exit_code: info.exit_code,
            log_path: info.log_path.clone(),
            line_count: info.line_count,
            last_output_at: info.last_output_at_ms,
            is_daemon: info.is_daemon,
            owner_run_id: info.owner_run_id.clone(),
        }
    }
}

/// get_output 命令响应：`{ output, ...status 全字段 }`——`output` 字段供前端
/// parseBackgroundTaskOutput 直通取用（`o.output` 优先级最高）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundTaskOutputResponse {
    /// 输出预览（= status.tail；前端 parseBackgroundTaskOutput 直读）
    pub(crate) output: String,
    /// 任务状态快照（flatten 展开为顶层字段）
    #[serde(flatten)]
    pub(crate) status: BackgroundTaskStatus,
}

/// ToolError → CoreError（命令面统一错误协议；NotFound 保形，其余 Internal 兜底，
/// 不静默吞错）。
fn tool_err_to_core(err: ToolError) -> CoreError {
    if err.code() == codes::TOOL_NOT_FOUND {
        CoreError::NotFound(err.to_string())
    } else {
        CoreError::Internal(err.to_string())
    }
}

/// list 命令契约体（测试直调，不依赖 Tauri runtime）。
pub(crate) async fn build_list_response(
    registry: &BackgroundTaskRegistry,
) -> Result<BackgroundTaskListResponse, CoreError> {
    let infos = registry.list(true).await.map_err(tool_err_to_core)?;
    let tasks = infos.iter().map(BackgroundTaskWire::from_info).collect();
    Ok(BackgroundTaskListResponse { tasks })
}

/// get_output 命令契约体（测试直调，不依赖 Tauri runtime）。
pub(crate) async fn build_output_response(
    registry: &BackgroundTaskRegistry,
    task_id: &str,
) -> Result<BackgroundTaskOutputResponse, CoreError> {
    let status = registry.status(task_id).await.map_err(tool_err_to_core)?;
    Ok(BackgroundTaskOutputResponse {
        output: status.tail.clone(),
        status,
    })
}

/// 列出全部后台任务（含已结束），`{ tasks: [...] }`。
///
/// 归档循环接线点（T-AB-12 1）：Tauri State 持 Arc 注册表（与 main.rs 包壳为
/// 同一实例），首次列表轮询即惰性启动 60s 归档线程——后续由线程周期清扫，
/// 本命令体经 list() 的惰性清扫兜底（不依赖线程时序）。
#[tauri::command]
pub(crate) async fn workbench_list_background_tasks(
    state: tauri::State<'_, Arc<BackgroundTaskRegistry>>,
) -> Result<BackgroundTaskListResponse, CoreError> {
    state.inner().spawn_archive_loop();
    build_list_response(state.inner()).await
}

/// 查询单任务状态与输出（运行中同样可读；未知 taskId → CoreError::NotFound）。
#[tauri::command]
pub(crate) async fn workbench_get_background_task_output(
    state: tauri::State<'_, Arc<BackgroundTaskRegistry>>,
    task_id: String,
) -> Result<BackgroundTaskOutputResponse, CoreError> {
    build_output_response(state.inner(), &task_id).await
}

/// 取消后台任务（T-AB-11 两阶段终止：优雅 → 5s → 强制；返回 KillResult 形状，
/// Killed / AlreadyExited / Failed 三态）。
#[tauri::command]
pub(crate) async fn workbench_cancel_background_task(
    state: tauri::State<'_, Arc<BackgroundTaskRegistry>>,
    task_id: String,
) -> Result<KillResult, CoreError> {
    state.inner().kill(&task_id).await.map_err(tool_err_to_core)
}

/// send_input 命令契约体（测试直调，不依赖 Tauri runtime；语义与
/// registry.send_input 完全一致：默认追加 `\n`，失败分类 task_not_found /
/// stdin_closed，未知 taskId → CoreError::NotFound）。
pub(crate) async fn build_send_input_response(
    registry: &BackgroundTaskRegistry,
    task_id: &str,
    text: &str,
    append_newline: bool,
) -> Result<(), CoreError> {
    registry
        .send_input(task_id, text, append_newline)
        .await
        .map_err(tool_err_to_core)
}

/// 向后台任务 stdin 注入输入（T-AB-10 2 操作面；T-AB-20 前端
/// sendBackgroundTaskInput 的 Rust 命令面——前端 backgroundTasksApi.ts 已
/// 接线等待本命令，F3 轮注册补齐）。参数 camelCase：taskId / text /
/// appendNewline（缺省 true 追加换行）。成功返回 unit，失败按 CoreError 分类。
#[tauri::command]
pub(crate) async fn workbench_send_input(
    state: tauri::State<'_, Arc<BackgroundTaskRegistry>>,
    task_id: String,
    text: String,
    append_newline: Option<bool>,
) -> Result<(), CoreError> {
    build_send_input_response(
        state.inner(),
        &task_id,
        &text,
        append_newline.unwrap_or(true),
    )
    .await
}

#[cfg(test)]
mod tests {
    #![allow(clippy::disallowed_methods)]
    use super::*;
    use std::collections::HashSet;
    use std::path::Path;
    use std::process::Stdio;

    const LONG_COMMAND: &str = if cfg!(windows) {
        "Start-Sleep -Seconds 20"
    } else {
        "sleep 20"
    };
    /// 持续产出输出（~4s，每 100ms 一行；tail 增长断言用）
    const OUTPUT_COMMAND: &str = if cfg!(windows) {
        "1..40 | ForEach-Object { Write-Output ('line ' + $_); Start-Sleep -Milliseconds 100 }"
    } else {
        "i=0; while [ $i -lt 40 ]; do echo line $i; i=$((i+1)); sleep 0.1; done"
    };
    /// 快速 1000 行输出命令（T-AB-09 测试用；行内容 "line N"，N=1..1000）
    const LOG_COMMAND: &str = if cfg!(windows) {
        "1..1000 | ForEach-Object { 'line ' + $_ }"
    } else {
        "seq 1 1000 | sed 's/^/line /'"
    };
    /// 持续输出命令（~20s；log_preserved_after_kill 用，杀前累积若干行）
    const LOG_KILL_COMMAND: &str = if cfg!(windows) {
        "1..200 | ForEach-Object { Write-Output ('k' + $_); Start-Sleep -Milliseconds 100 }"
    } else {
        "i=0; while [ $i -lt 200 ]; do echo k$i; i=$((i+1)); sleep 0.1; done"
    };
    /// 行尾含 [Y/n] 提示的命令（prompt_detected_on_stdout 用）
    const PROMPT_OUTPUT_COMMAND: &str = if cfg!(windows) {
        "Write-Output 'Continue? [Y/n]'"
    } else {
        "echo 'Continue? [Y/n]'"
    };
    /// 交互命令：等待 stdin 一行输入后输出 "got=<输入>"（send_input 注入测试用）。
    /// 注意：PowerShell Read-Host 在 stdin 重定向时**不会**把提示行写入 stdout
    /// 管道（提示写往控制台宿主），故测试不等待提示出现，直接注入（管道缓冲保证
    /// 进程启动后仍能收到先行写入的输入）。
    const INTERACTIVE_PROMPT_COMMAND: &str = if cfg!(windows) {
        "$r = Read-Host 'Enter y'; Write-Output ('got=' + $r)"
    } else {
        "read -p 'Enter y: ' r; echo got=$r"
    };
    /// Windows stdin 探测脚本（写入临时 .ps1 后以 `-File` 方式 spawn——`-Command`
    /// 对花括号脚本有解析怪癖）：读 1 字节，再非阻塞探测（300ms）是否有多余
    /// 字节，输出 first=<字节值> extra=0|1（append_newline=false 断言用）。
    #[cfg(windows)]
    const STDIN_PROBE_SCRIPT: &str = "$stdin = [Console]::OpenStandardInput(); $buf = New-Object byte[] 1; $n = $stdin.Read($buf, 0, 1); if ($n -gt 0) { $peek = New-Object byte[] 1; $task = $stdin.ReadAsync($peek, 0, 1); if ($task.Wait(300)) { Write-Output ('first=' + $buf[0] + ' extra=1') } else { Write-Output ('first=' + $buf[0] + ' extra=0') } } else { Write-Output 'first=eof' }";

    /// 测试注册表序号：每个测试独占日志根目录（T-AB-09 落盘后避免并行测试
    /// 共享 task-<seq> 路径互相污染）
    static TEST_SEQ: AtomicU64 = AtomicU64::new(0);

    /// 真实 spawn 测试子进程（kill_on_drop=false + 双管道，对齐 T-AB-02 契约；
    /// stdin=null——同步路径语义，send_input 相关测试用 with_stdin 变体）。
    fn spawn_test_child(command: &str) -> Child {
        let mut cmd = build_test_command(command);
        cmd.stdin(Stdio::null());
        cmd.spawn().expect("spawn test child")
    }

    /// 真实 spawn 测试子进程（stdin 走管道——后台托管路径契约：T-AB-10 1）
    fn spawn_test_child_with_stdin(command: &str) -> Child {
        let mut cmd = build_test_command(command);
        cmd.stdin(Stdio::piped());
        cmd.spawn().expect("spawn test child with stdin")
    }

    /// 测试命令构造（PowerShell / bash 平台分支）
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
        cmd.stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false);
        cmd
    }

    fn test_registry() -> BackgroundTaskRegistry {
        let seq = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "crish-bg-test-{}-{seq}",
            std::process::id()
        ));
        // 纯构造（不启动归档线程）：常规测试用 30 分钟保留 + 默认容量，无需
        // 归档循环；归档/容量专项测试显式用 with_log_root/with_config（Arc）
        BackgroundTaskRegistry::construct(
            root,
            Duration::from_secs(30 * 60),
            MAX_BACKGROUND_TASKS,
        )
    }

    fn adopt_request(
        child: Child,
        command: &str,
        cwd: &Path,
        is_daemon: bool,
        owner_run_id: Option<String>,
    ) -> BackgroundAdoptRequest {
        BackgroundAdoptRequest {
            child,
            command: command.to_string(),
            cwd: cwd.to_path_buf(),
            is_daemon,
            resource_monitor: false,
            owner_run_id,
        }
    }

    /// 轮询至终态（窗口内未到则 panic）。
    async fn wait_for_terminal(
        registry: &BackgroundTaskRegistry,
        task_id: &str,
        window: Duration,
    ) -> BackgroundTaskStatus {
        let deadline = tokio::time::Instant::now() + window;
        loop {
            let status = registry.status(task_id).await.expect("status");
            if BackgroundTaskRegistry::is_terminal(status.status) {
                return status;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "任务 {task_id} 未在窗口内进入终态：{status:?}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// 轮询至 tail 非空（输出命令断言用）。
    async fn wait_until_tail_non_empty(
        registry: &BackgroundTaskRegistry,
        task_id: &str,
        window: Duration,
    ) -> BackgroundTaskStatus {
        let deadline = tokio::time::Instant::now() + window;
        loop {
            let status = registry.status(task_id).await.expect("status");
            if !status.tail.is_empty() {
                return status;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "任务 {task_id} 迟迟无输出"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// 轮询至 prompt 就位（提示检测断言用；窗口内未到则 panic）。
    async fn wait_for_prompt(
        registry: &BackgroundTaskRegistry,
        task_id: &str,
        window: Duration,
    ) -> String {
        let deadline = tokio::time::Instant::now() + window;
        loop {
            let status = registry.status(task_id).await.expect("status");
            if let Some(p) = &status.prompt {
                return p.clone();
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "任务 {task_id} 未在窗口内检测到提示"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
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

    /// T-AB-07 验收：adopt 真实长命令 → list 可见、status Running、pid 存活。
    #[tokio::test]
    async fn registry_adopt_and_list() {
        let registry = test_registry();
        let child = spawn_test_child(LONG_COMMAND);
        let pid = child.id().expect("spawned pid");

        let task_ref = registry
            .adopt(adopt_request(child, "long-run", Path::new("."), false, None))
            .await
            .expect("adopt");
        assert!(task_ref.task_id.starts_with("task-"));
        assert!(
            task_ref
                .log_path
                .to_string_lossy()
                .ends_with(&format!("{}.log", task_ref.task_id)),
            "log_path 应为 <log_root>/<task_id>.log"
        );
        assert!(pid_is_alive(pid), "adopt 后进程必须存活");

        let infos = registry.list(false).await.expect("list");
        assert_eq!(infos.len(), 1, "活跃列表应含刚 adopt 的任务");
        assert_eq!(infos[0].task_id, task_ref.task_id);
        assert_eq!(infos[0].status, TaskState::Running);

        let status = registry.status(&task_ref.task_id).await.expect("status");
        assert_eq!(status.status, TaskState::Running);
        assert!(status.tail.is_empty(), "长命令尚未产出输出");

        let _ = crate::process::terminate_process_tree(pid);
    }

    /// T-AB-07 验收（注册表侧语义）：同步完成的命令即使「迟到 adopt」，状态机
    /// 也能正确收敛到 Completed（exit_code=0），不产生 Running 僵尸条目。
    /// 「等待窗口内完成不调用 adopt、不产生条目」由 A1 层（T-AB-02）保证——
    /// 注册表只在 adopt 被调用时登记。
    #[tokio::test]
    async fn registry_no_entry_on_sync_complete() {
        let registry = test_registry();
        let child = spawn_test_child("echo sync-done");
        // 等待自然退出后再 adopt（模拟窗口内已完成的命令）
        tokio::time::sleep(Duration::from_millis(700)).await;

        let task_ref = registry
            .adopt(adopt_request(child, "sync", Path::new("."), false, None))
            .await
            .expect("adopt");
        let status = wait_for_terminal(&registry, &task_ref.task_id, Duration::from_secs(5)).await;
        assert_eq!(status.status, TaskState::Completed);
        assert_eq!(status.exit_code, Some(0));
        // 同步命令不应停留在 Running
        let infos = registry.list(false).await.expect("list");
        assert!(
            infos.is_empty(),
            "同步完成的命令不应出现在活跃列表（终态过滤）"
        );
    }

    /// T-AB-07 验收：自然退出 → Completed（exit 0）／Failed（exit != 0）且
    /// exitCode / duration 正确。
    #[tokio::test]
    async fn registry_state_machine() {
        let registry = test_registry();
        let cwd = std::env::current_dir().expect("cwd");

        // Completed 路径
        let child = spawn_test_child("exit 0");
        let r1 = registry
            .adopt(adopt_request(child, "ok-cmd", &cwd, false, None))
            .await
            .expect("adopt ok");
        let s1 = wait_for_terminal(&registry, &r1.task_id, Duration::from_secs(5)).await;
        assert_eq!(s1.status, TaskState::Completed);
        assert_eq!(s1.exit_code, Some(0));
        // 终态固化：list 快照含 finishedAtMs，且不早于 startedAtMs
        let all = registry.list(true).await.expect("list");
        let fin1 = all
            .iter()
            .find(|i| i.task_id == r1.task_id)
            .expect("完成条目存在");
        let finished1 = fin1.finished_at_ms.expect("终态应有 finishedAtMs");
        assert!(finished1 >= fin1.started_at_ms, "finishedAtMs 不应早于 startedAtMs");

        // Failed 路径
        let child = spawn_test_child("exit 7");
        let r2 = registry
            .adopt(adopt_request(child, "fail-cmd", &cwd, false, None))
            .await
            .expect("adopt fail");
        let s2 = wait_for_terminal(&registry, &r2.task_id, Duration::from_secs(5)).await;
        assert_eq!(s2.status, TaskState::Failed);
        assert_eq!(s2.exit_code, Some(7));
        let all = registry.list(true).await.expect("list");
        let fin2 = all
            .iter()
            .find(|i| i.task_id == r2.task_id)
            .expect("失败条目存在");
        assert!(
            fin2.finished_at_ms.is_some(),
            "Failed 终态同样固化 finishedAtMs"
        );
        assert!(fin2.duration_ms > 0, "Failed 计时合理（exit 7 经 wait 收口）");
    }

    /// T-AB-07 验收：任务 id 唯一且带 task- 前缀（命名空间独立于 pty id）。
    #[tokio::test]
    async fn task_ids_are_unique_and_prefixed() {
        let registry = test_registry();
        let mut seen = HashSet::new();
        for i in 0..3 {
            let child = spawn_test_child(LONG_COMMAND);
            let pid = child.id().expect("spawned pid");
            let task_ref = registry
                .adopt(adopt_request(child, &format!("cmd-{i}"), Path::new("."), false, None))
                .await
                .expect("adopt");
            assert!(task_ref.task_id.starts_with("task-"), "id 格式: {}", task_ref.task_id);
            assert!(
                seen.insert(task_ref.task_id.clone()),
                "重复 task id: {}",
                task_ref.task_id
            );
            let _ = crate::process::terminate_process_tree(pid);
        }
        assert_eq!(seen.len(), 3, "连续 adopt 不得产生重复 id");
    }

    /// 方法结构化错误契约（T-AB-09/10/11 实装后占位语义更新）：
    /// - 未知 id → NotFound（read_log / send_input / kill 三方法一致）；
    /// - read_log 已知 id → 实装（空输出任务返回空切片）；
    /// - send_input 已知 id 但 spawn 未开 stdin 管道 → stdin_closed（分类错误）；
    /// - kill 已知 id → 两阶段终止实装（Killed，T-AB-11）。
    #[tokio::test]
    async fn registry_methods_error_contract() {
        let registry = test_registry();
        let cwd = std::env::current_dir().expect("cwd");

        // 未知 id → NotFound（不静默返回空值）
        let err = registry.read_log("task-nope", None, 100).await.expect_err("read_log");
        assert_eq!(err.code(), codes::TOOL_NOT_FOUND);
        let err = registry
            .send_input("task-nope", "hi", true)
            .await
            .expect_err("send_input");
        assert_eq!(err.code(), codes::TOOL_NOT_FOUND);
        let err = registry.kill("task-nope").await.expect_err("kill");
        assert_eq!(err.code(), codes::TOOL_NOT_FOUND);

        // 已知 id：read_log 已实装；send_input 未接管道 → stdin_closed；kill 实装
        let child = spawn_test_child(LONG_COMMAND);
        let r = registry
            .adopt(adopt_request(child, "placeholder", &cwd, false, None))
            .await
            .expect("adopt");

        let slice = registry.read_log(&r.task_id, None, 100).await.expect("read_log 已实装");
        assert_eq!(slice.task_id, r.task_id);
        assert!(
            slice.lines.is_empty(),
            "尚未输出的任务日志为空切片（total={}）",
            slice.total_lines
        );

        let err = registry
            .send_input(&r.task_id, "hi", true)
            .await
            .expect_err("null stdin");
        assert_eq!(err.code(), codes::TOOL_EXECUTION_FAILED);
        assert!(
            err.to_string().contains("stdin_closed"),
            "send_input 失败应分类为 stdin_closed：{err}"
        );

        // kill 实装：两阶段终止 → Killed（进程终止，无需再外部树杀）
        let result = registry.kill(&r.task_id).await.expect("kill 已实装");
        assert!(
            matches!(result, KillResult::Killed { .. }),
            "运行中任务 kill 应返回 Killed，实际 {result:?}"
        );
        let status = registry.status(&r.task_id).await.expect("status");
        assert_eq!(status.status, TaskState::Killed, "kill 后状态机应翻转为 Killed");
    }

    /// T-AB-08 验收：list 契约——`{ tasks: [...] }`，每条含 taskId/command/
    /// startedAt/duration/status/logPath（命令直调，构造 registry 即构造 State）。
    #[tokio::test]
    async fn workbench_list_background_tasks_contract() {
        let registry = test_registry();
        let child = spawn_test_child(LONG_COMMAND);
        let pid = child.id().expect("spawned pid");
        registry
            .adopt(adopt_request(child, "list-contract", Path::new("."), false, None))
            .await
            .expect("adopt");

        let response = build_list_response(&registry).await.expect("build_list_response");
        let json = serde_json::to_value(&response).expect("serialize");
        assert!(json.get("tasks").is_some(), "响应必须含 tasks 数组");
        let tasks = json["tasks"].as_array().expect("tasks 数组");
        assert_eq!(tasks.len(), 1, "应恰有 1 条任务");

        let task = &tasks[0];
        for key in ["taskId", "command", "startedAt", "duration", "status", "logPath"] {
            assert!(
                task.get(key).is_some(),
                "列表条目缺字段 {key}: {task}"
            );
        }
        assert_eq!(task["status"], "running", "运行中任务 status=running");
        assert_eq!(task["command"], "list-contract");
        assert!(
            task["startedAt"].as_u64().unwrap() > 0,
            "startedAt 为毫秒时间戳"
        );

        let _ = crate::process::terminate_process_tree(pid);
    }

    /// T-AB-08 验收：get_output 契约——运行中任务返回非空 tail 且随输出增长；
    /// 未知 taskId → NotFound 风格错误（结构化，非 null 非静默）。
    #[tokio::test]
    async fn workbench_get_background_task_output_contract() {
        let registry = test_registry();
        let child = spawn_test_child(OUTPUT_COMMAND);
        let pid = child.id().expect("spawned pid");
        let r = registry
            .adopt(adopt_request(child, "output-contract", Path::new("."), false, None))
            .await
            .expect("adopt");

        let first = wait_until_tail_non_empty(&registry, &r.task_id, Duration::from_secs(5)).await;
        assert!(!first.tail.is_empty(), "运行中任务 tail 必须非空");
        let first_lines = first.line_count;
        assert!(first_lines > 0, "行计数应 > 0");

        // 输出随运行增长
        tokio::time::sleep(Duration::from_millis(700)).await;
        let second = registry.status(&r.task_id).await.expect("status");
        assert!(
            second.line_count > first_lines,
            "输出应随运行增长：{first_lines} -> {}",
            second.line_count
        );

        // output 字段（前端 parseBackgroundTaskOutput 直通取 output）
        let response = build_output_response(&registry, &r.task_id).await.expect("build_output_response");
        assert_eq!(response.output, second.tail, "output 应等于最新 tail");
        let json = serde_json::to_value(&response).expect("serialize");
        assert_eq!(json["output"], second.tail, "wire 面 output 直通");
        assert_eq!(json["taskId"], r.task_id);

        // 未知 taskId → NotFound 风格错误
        let err = build_output_response(&registry, "task-999999").await.expect_err("unknown id");
        assert!(
            matches!(err, CoreError::NotFound(_)),
            "未知 taskId 应返回 NotFound，实际 {err:?}"
        );

        let _ = crate::process::terminate_process_tree(pid);
    }

    /// T-AB-08 验收：cancel 契约——未知 → NotFound；运行中 → Killed（T-AB-11
    /// 两阶段终止实装，不再 Unsupported）；终态 → AlreadyExited（真实可答，
    /// KillResult 形状）。
    #[tokio::test]
    async fn workbench_cancel_background_task_contract() {
        let registry = test_registry();
        let cwd = std::env::current_dir().expect("cwd");

        // 未知 → NotFound
        let err = registry.kill("task-nope").await.expect_err("kill unknown");
        assert_eq!(err.code(), codes::TOOL_NOT_FOUND);

        // 运行中 → Killed（T-AB-11 两阶段终止）
        let child = spawn_test_child(LONG_COMMAND);
        let r1 = registry
            .adopt(adopt_request(child, "cancel-running", &cwd, false, None))
            .await
            .expect("adopt");
        let result = registry.kill(&r1.task_id).await.expect("kill running");
        assert!(
            matches!(result, KillResult::Killed { .. }),
            "运行中任务 kill 应返回 Killed，实际 {result:?}"
        );

        // 终态 → AlreadyExited（KillResult 形状）
        let child = spawn_test_child("exit 0");
        let r2 = registry
            .adopt(adopt_request(child, "cancel-finished", &cwd, false, None))
            .await
            .expect("adopt");
        let _ = wait_for_terminal(&registry, &r2.task_id, Duration::from_secs(5)).await;
        let result = registry.kill(&r2.task_id).await.expect("kill terminal");
        match result {
            KillResult::AlreadyExited { task_id, exit_code } => {
                assert_eq!(task_id, r2.task_id);
                assert_eq!(exit_code, Some(0));
            }
            other => panic!("终态任务 kill 应返回 AlreadyExited，实际 {other:?}"),
        }
    }

    // ── T-AB-09 日志生命周期 ──────────────────────────────────────────────

    /// T-AB-20 验收：send_input 命令面契约（build_send_input_response 直调，
    /// 不依赖 Tauri runtime）——未知 → NotFound；运行中 stdin 接通 → 注入成功；
    /// 终态 / 未接管道 → stdin_closed 分类错误；append_newline 默认追加换行。
    #[tokio::test]
    async fn workbench_send_input_contract() {
        let registry = test_registry();
        let cwd = std::env::current_dir().expect("cwd");

        // 未知 → NotFound（tool_err_to_core 保形映射）
        let err = build_send_input_response(&registry, "task-nope", "hi", true)
            .await
            .expect_err("send_input unknown");
        assert!(
            matches!(err, CoreError::NotFound(_)),
            "未知任务应映射为 CoreError::NotFound，实际 {err:?}"
        );

        // 运行中 + stdin 管道接通 → 注入成功（got=<输入> 端到端）
        let child = spawn_test_child_with_stdin(INTERACTIVE_PROMPT_COMMAND);
        let r1 = registry
            .adopt(adopt_request(child, "send-input-contract", &cwd, false, None))
            .await
            .expect("adopt");
        build_send_input_response(&registry, &r1.task_id, "y", true)
            .await
            .expect("send_input 注入成功");
        let status = wait_for_terminal(&registry, &r1.task_id, Duration::from_secs(10)).await;
        assert_eq!(status.status, TaskState::Completed);
        assert!(
            status.tail.contains("got=y"),
            "stdin 注入应到达进程（got=y）：{:?}",
            status.tail
        );

        // append_newline=false：不追加换行 → 进程仍在等待输入（Running）
        let child = spawn_test_child_with_stdin(INTERACTIVE_PROMPT_COMMAND);
        let r2 = registry
            .adopt(adopt_request(child, "send-input-no-newline", &cwd, false, None))
            .await
            .expect("adopt");
        build_send_input_response(&registry, &r2.task_id, "y", false)
            .await
            .expect("send_input no-newline");
        tokio::time::sleep(Duration::from_millis(300)).await;
        let status = registry.status(&r2.task_id).await.expect("status");
        assert_eq!(
            status.status,
            TaskState::Running,
            "不追加换行时进程应仍在等待输入（Running）"
        );
        let _ = registry.kill(&r2.task_id).await;
    }

    /// 验收：1000 行输出任务 `read_log(None, 100)` → 返回 901~1000 行且每行完整
    /// （完整行边界；total_lines 与 line_count 一致）。
    #[tokio::test]
    async fn log_write_and_read_tail() {
        let registry = test_registry();
        let child = spawn_test_child(LOG_COMMAND);
        let r = registry
            .adopt(adopt_request(child, "log-tail", Path::new("."), false, None))
            .await
            .expect("adopt");
        let status = wait_for_terminal(&registry, &r.task_id, Duration::from_secs(30)).await;
        assert_eq!(status.status, TaskState::Completed);

        let slice = registry
            .read_log(&r.task_id, None, 100)
            .await
            .expect("read_log");
        assert_eq!(slice.task_id, r.task_id);
        assert_eq!(slice.total_lines, 1000, "total_lines 应为文件物理行数");
        assert_eq!(slice.start_line, 901);
        assert_eq!(slice.end_line, 1000);
        assert_eq!(slice.lines.len(), 100);
        assert!(!slice.truncated, "KB 级日志远小于单次读取预算");
        // 每行完整：内容与行号一一对应（去前缀后的原始输出）
        for (idx, line) in slice.lines.iter().enumerate() {
            assert_eq!(line, &format!("line {}", 901 + idx), "第 {} 行内容完整", 901 + idx);
        }
    }

    /// 验收：`read_log(Some(500), 100)` 返回 500~599 行（500 早于首个 512 行
    /// checkpoint → 走索引回退从头扫描路径）；`read_log(Some(600), 50)` 返回
    /// 600~649 行（600 晚于首个 checkpoint → 走 checkpoint 二分定位路径）。
    #[tokio::test]
    async fn log_read_by_line_range() {
        let registry = test_registry();
        let child = spawn_test_child(LOG_COMMAND);
        let r = registry
            .adopt(adopt_request(child, "log-range", Path::new("."), false, None))
            .await
            .expect("adopt");
        let _ = wait_for_terminal(&registry, &r.task_id, Duration::from_secs(30)).await;

        let slice = registry
            .read_log(&r.task_id, Some(500), 100)
            .await
            .expect("read_log");
        assert_eq!(slice.start_line, 500);
        assert_eq!(slice.end_line, 599);
        assert_eq!(slice.lines.len(), 100);
        assert_eq!(slice.lines[0], "line 500");
        assert_eq!(slice.lines[99], "line 599");

        let slice = registry
            .read_log(&r.task_id, Some(600), 50)
            .await
            .expect("read_log");
        assert_eq!(slice.start_line, 600);
        assert_eq!(slice.end_line, 649);
        assert_eq!(slice.lines.len(), 50);
        assert_eq!(slice.lines[0], "line 600");
        assert_eq!(slice.lines[49], "line 649");
    }

    /// 验收：任务被杀后 `.log` 保留且内容完整（read_log 仍可用、行数与文件一致）。
    /// 本测试用进程原语 `terminate_process_tree` 直接树杀（外部终止 → 管道 EOF
    /// → writer 收尾到终态）；registry.kill 两阶段路径的日志保留语义由
    /// T-AB-11 的 `kill_preserves_log` 覆盖。
    #[tokio::test]
    async fn log_preserved_after_kill() {
        let registry = test_registry();
        let child = spawn_test_child(LOG_KILL_COMMAND);
        let pid = child.id().expect("spawned pid");
        let r = registry
            .adopt(adopt_request(child, "log-kill", Path::new("."), false, None))
            .await
            .expect("adopt");
        // 等有输出后外部树杀（进程被杀 → 管道 EOF → writer 收尾到终态）
        let _ = wait_until_tail_non_empty(&registry, &r.task_id, Duration::from_secs(10)).await;
        let _ = crate::process::terminate_process_tree(pid);
        let status = wait_for_terminal(&registry, &r.task_id, Duration::from_secs(10)).await;
        assert!(
            BackgroundTaskRegistry::is_terminal(status.status),
            "树杀后应收敛到终态，实际 {:?}",
            status.status
        );

        // 日志文件仍存在，read_log 可读且行数与文件一致
        let log_path = PathBuf::from(status.log_path);
        assert!(log_path.exists(), "任务终止不得删除 .log");
        let slice = registry
            .read_log(&r.task_id, None, 100)
            .await
            .expect("read_log");
        assert!(slice.total_lines > 0, "被杀前已累积的输出应可读");
        assert_eq!(slice.start_line, 1, "行数少时尾部读取返回全量");
        assert_eq!(slice.lines.len() as u64, slice.total_lines);
        // 与文件物理行数一致（`[out]`/`[err]` 前缀不影响行数）
        let raw = std::fs::read(&log_path).expect("读取日志文件");
        let file_lines = raw.iter().filter(|&&b| b == b'\n').count() as u64;
        assert_eq!(slice.total_lines, file_lines, "内存计数与文件物理行数自洽");
    }

    /// 验收：终态 status 的 tail/line_count 与文件实际一致（flush 自洽），
    /// meta.json 含终态字段（exitCode/finishedAtMs）与 checkpoint。
    #[tokio::test]
    async fn log_meta_terminal_consistent() {
        let registry = test_registry();
        let child = spawn_test_child(LOG_COMMAND);
        let r = registry
            .adopt(adopt_request(child, "log-meta", Path::new("."), false, None))
            .await
            .expect("adopt");
        let status = wait_for_terminal(&registry, &r.task_id, Duration::from_secs(30)).await;
        assert_eq!(status.status, TaskState::Completed);

        let log_path = PathBuf::from(status.log_path);
        let meta_path = log_path.with_extension("meta.json");
        // 文件行数与 status.line_count 一致（状态翻转发生在 writer 全部收尾之后）
        let raw = std::fs::read(&log_path).expect("读取日志文件");
        let file_lines: Vec<String> = String::from_utf8_lossy(&raw)
            .split('\n')
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect();
        assert_eq!(file_lines.len() as u64, status.line_count, "line_count 与文件一致");
        // status.tail（内存预览，无前缀）= 文件末 20 行去前缀后（flush 自洽）
        let tail_stripped: Vec<String> = file_lines
            .iter()
            .rev()
            .take(20)
            .map(|s| strip_log_prefix(s))
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        assert_eq!(tail_stripped.join("\n"), status.tail, "tail 与文件一致");

        // meta：终态字段 + 行数 + checkpoint 已落盘
        let meta = read_meta(&meta_path).expect("meta 存在且可解析");
        assert_eq!(meta.task_id, r.task_id);
        assert_eq!(meta.status, "completed");
        assert_eq!(meta.line_count, status.line_count);
        assert_eq!(meta.exit_code, status.exit_code);
        // finished_at 在 status 契约里没有（冻结形状），经 list(true) 快照核对
        let all = registry.list(true).await.expect("list");
        let info_finished = all
            .iter()
            .find(|i| i.task_id == r.task_id)
            .expect("终态条目存在")
            .finished_at_ms;
        assert_eq!(meta.finished_at_ms, info_finished, "meta 终态时间与内存快照一致");
        assert_eq!(meta.last_output_at_ms, status.last_output_at_ms);
        assert!(!meta.rotated, "小日志不应触发轮转");
        assert!(
            meta.checkpoints.iter().any(|c| c.line == 512),
            "首个 512 行 checkpoint 应已落盘：{:?}",
            meta.checkpoints
        );
        assert!(meta.log_bytes > 0, "meta 记录日志字节数");

        // read_log 的 total_lines 与 status 一致
        let slice = registry
            .read_log(&r.task_id, None, 100)
            .await
            .expect("read_log");
        assert_eq!(slice.total_lines, status.line_count);
        assert_eq!(slice.lines.len(), 100);
        assert_eq!(slice.start_line, status.line_count - 99);
    }

    /// 验收：摘要模板形状（REQ-A05：`任务 <id> 已运行 <duration>，日志已累积
    /// <line_count> 行，最近输出时间 <timestamp>`；R-AB3 唤醒注入消费）。
    #[test]
    fn task_summary_template() {
        let info = BackgroundTaskInfo {
            task_id: "task-42".to_string(),
            command: "cmd".to_string(),
            cwd: ".".to_string(),
            status: TaskState::Running,
            started_at_ms: 1_000_000,
            duration_ms: 1234,
            finished_at_ms: None,
            exit_code: None,
            log_path: "x.log".to_string(),
            line_count: 77,
            last_output_at_ms: 1_001_000,
            is_daemon: false,
            resource: None,
            prompt: None,
            owner_run_id: None,
        };
        let s = task_summary(&info, info.duration_ms);
        assert_eq!(
            s,
            "任务 task-42 已运行 1234，日志已累积 77 行，最近输出时间 1001000"
        );
    }

    // ── T-AB-10 stdin 注入 + 提示检测 ──────────────────────────────────────

    /// 验收：stdin 管道化 + 注入——交互程序（Read-Host / read）收到带换行的
    /// 输入后继续执行直至完成，输出含收到内容。
    #[tokio::test]
    async fn send_input_reaches_process() {
        let registry = test_registry();
        let child = spawn_test_child_with_stdin(INTERACTIVE_PROMPT_COMMAND);
        let r = registry
            .adopt(adopt_request(child, "stdin-interactive", Path::new("."), false, None))
            .await
            .expect("adopt");

        // 不等待提示出现（Read-Host 在 stdin 重定向时不把提示写进 stdout 管道）；
        // 管道缓冲保证进程启动后仍能收到先行写入的输入
        registry
            .send_input(&r.task_id, "y", true)
            .await
            .expect("send_input 成功");

        let status = wait_for_terminal(&registry, &r.task_id, Duration::from_secs(15)).await;
        assert_eq!(status.status, TaskState::Completed, "收到输入后应正常完成");
        let slice = registry
            .read_log(&r.task_id, None, 10)
            .await
            .expect("read_log");
        let all = slice.lines.join("\n");
        assert!(all.contains("got=y"), "进程应收到输入并继续执行：{all}");
    }

    /// 验收：输出含行尾 `[Y/n]` 提示 → `status().prompt` 非空且为命中行，
    /// meta.json 同步落盘 prompt。
    #[tokio::test]
    async fn prompt_detected_on_stdout() {
        let registry = test_registry();
        let child = spawn_test_child(PROMPT_OUTPUT_COMMAND);
        let r = registry
            .adopt(adopt_request(child, "prompt-detect", Path::new("."), false, None))
            .await
            .expect("adopt");

        let prompt = wait_for_prompt(&registry, &r.task_id, Duration::from_secs(10)).await;
        assert_eq!(prompt, "Continue? [Y/n]", "prompt 内容为命中行");

        // meta 同步落盘
        let status = registry.status(&r.task_id).await.expect("status");
        let meta_path = PathBuf::from(status.log_path).with_extension("meta.json");
        let meta = read_meta(&meta_path).expect("meta 存在且可解析");
        assert_eq!(meta.prompt.as_deref(), Some("Continue? [Y/n]"), "meta 含 prompt");

        let _ = wait_for_terminal(&registry, &r.task_id, Duration::from_secs(5)).await;
    }

    /// 验收：进程退出后 send_input 返回 stdin_closed 风格错误，且后续调用持续
    /// 返回（槽位清空，确定性不依赖 BrokenPipe 时序）。
    #[tokio::test]
    async fn send_input_after_stdin_closed() {
        let registry = test_registry();
        let child = spawn_test_child_with_stdin("exit 0");
        let r = registry
            .adopt(adopt_request(child, "stdin-closed", Path::new("."), false, None))
            .await
            .expect("adopt");
        let _ = wait_for_terminal(&registry, &r.task_id, Duration::from_secs(5)).await;

        let err = registry
            .send_input(&r.task_id, "x", true)
            .await
            .expect_err("stdin 已关闭");
        assert_eq!(err.code(), codes::TOOL_EXECUTION_FAILED);
        assert!(
            err.to_string().contains("stdin_closed"),
            "失败应分类为 stdin_closed：{err}"
        );
        // 后续调用同样返回 stdin_closed（槽位保持清空）
        let err2 = registry
            .send_input(&r.task_id, "x", true)
            .await
            .expect_err("仍关闭");
        assert!(err2.to_string().contains("stdin_closed"));
    }

    /// 验收：append_newline=false 时输入原样送达（不带换行）。
    ///
    /// 探测程序读 1 字节后非阻塞探测 300ms：若实现错误地追加了换行，探测会
    /// 立即读到第 2 字节（extra=1），断言失败。探测脚本写入临时 .ps1 后以
    /// `-File` 方式 spawn（`-Command` 对花括号脚本有解析怪癖）。
    #[cfg(windows)]
    #[tokio::test]
    async fn send_input_append_newline_false() {
        let registry = test_registry();
        // 探测脚本（纯 ASCII，std::fs::write 无编码问题）
        let script_path = std::env::temp_dir().join(format!(
            "crish-stdin-probe-{}-{}.ps1",
            std::process::id(),
            TEST_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&script_path, STDIN_PROBE_SCRIPT).expect("写探测脚本");

        let mut cmd = tokio::process::Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&script_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false);
        let child = cmd.spawn().expect("spawn probe");
        let r = registry
            .adopt(adopt_request(child, "stdin-no-newline", Path::new("."), false, None))
            .await
            .expect("adopt");

        // 管道缓冲保证进程启动后仍能收到先行写入的字节
        registry
            .send_input(&r.task_id, "y", false)
            .await
            .expect("send_input");

        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let tail = loop {
            let status = registry.status(&r.task_id).await.expect("status");
            if status.tail.contains("first=") {
                break status.tail;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "探测程序未输出（stdin 未送达？）"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        };
        assert!(tail.contains("first=121"), "应收到单个 y 字节（121）：{tail}");
        assert!(tail.contains("extra=0"), "append_newline=false 不得追加换行：{tail}");

        let _ = wait_for_terminal(&registry, &r.task_id, Duration::from_secs(5)).await;
        let _ = std::fs::remove_file(&script_path);
    }

    // ── T-AB-11 两阶段终止 ─────────────────────────────────────────────────

    /// 验收：Start-Sleep 类命令两阶段终止——优雅阶段生效则直接退出
    /// （Killed{via_force:false}）；Windows 平台注记（任务书 5 认可，本机
    /// 实测）：taskkill 无 /F 对控制台程序（powershell/cmd）必返回「只能强制
    /// 终止」——优雅请求必然未生效 → 跳过 5s 等待直接升级（Killed{via_force:true}）。
    /// 断言基准为「两阶段路径可执行」而非「优雅一定成功」。
    #[tokio::test]
    async fn kill_graceful_path() {
        let registry = test_registry();
        let child = spawn_test_child(LONG_COMMAND);
        let r = registry
            .adopt(adopt_request(child, "kill-graceful", Path::new("."), false, None))
            .await
            .expect("adopt");
        // 确保进入 Running（避免与自然退出竞态）
        tokio::time::sleep(Duration::from_millis(300)).await;

        let started = tokio::time::Instant::now();
        let result = registry.kill(&r.task_id).await.expect("kill");
        let elapsed = started.elapsed();
        // 并行测试环境下 Windows taskkill /T（优雅）可能返回 Ok 但信号无效 →
        // 等满 5s 窗口后升级；预留任务系统负载余量，12s 上限仍远小于
        // 优雅+强制两个完整窗口之和（10s）之外的无界等待
        assert!(
            elapsed < Duration::from_secs(12),
            "两阶段终止不应无界阻塞：{elapsed:?}"
        );

        let via_force = match result {
            KillResult::Killed { task_id, via_force } => {
                assert_eq!(task_id, r.task_id);
                via_force
            }
            other => panic!("运行中任务 kill 应返回 Killed，实际 {other:?}"),
        };
        #[cfg(not(windows))]
        assert!(!via_force, "Unix 优雅路径应直接生效（SIGTERM → sleep 退出）");
        #[cfg(windows)]
        assert!(
            via_force,
            "Windows 控制台进程优雅必然未生效 → 应升级强制（本机实测口径）"
        );

        // 状态机联动：status 翻转为 Killed；finished_at 落内存快照（list 面）
        let status = registry.status(&r.task_id).await.expect("status");
        assert_eq!(status.status, TaskState::Killed, "kill 后状态应翻转为 Killed");
        let all = registry.list(true).await.expect("list");
        let info = all
            .iter()
            .find(|i| i.task_id == r.task_id)
            .expect("任务仍可查询（未归档）");
        assert!(
            info.finished_at_ms.is_some(),
            "kill 成功应固化 finished_at（归档计时起点）"
        );
        // 诊断留痕：优雅请求已发送（两阶段路径真实执行）
        assert!(
            status
                .termination_diagnostics
                .iter()
                .any(|d| d.contains("优雅终止请求已发送")),
            "diagnostics 应含优雅留痕：{:?}",
            status.termination_diagnostics
        );
    }

    /// 验收：忽略优雅信号的程序 → 两阶段升级 → Killed{via_force:true} 且
    /// diagnostics 含升级留痕。
    ///
    /// Windows：控制台循环程序优雅必然未生效 → 升级 /F /T → 确定性
    /// Killed{via_force:true}。
    /// Unix 平台限制（诚实边界）：process.rs 的强制原语与优雅同为 SIGTERM
    /// （无 SIGKILL 升级项），忽略 TERM 的进程两阶段均无效 → 等待窗口耗尽 →
    /// Failed（升级已尝试，diagnostics 留痕完整）。
    #[tokio::test]
    async fn kill_force_escalation() {
        let registry = test_registry();
        let command = if cfg!(windows) {
            "while ($true) { Start-Sleep -Milliseconds 50 }"
        } else {
            "trap '' TERM; while true; do sleep 1; done"
        };
        let child = spawn_test_child(command);
        let r = registry
            .adopt(adopt_request(child, "kill-force", Path::new("."), false, None))
            .await
            .expect("adopt");
        tokio::time::sleep(Duration::from_millis(300)).await;

        let result = registry.kill(&r.task_id).await.expect("kill");
        #[cfg(windows)]
        match result {
            KillResult::Killed { task_id, via_force } => {
                assert_eq!(task_id, r.task_id);
                assert!(via_force, "忽略优雅的程序必须经升级强制路径");
            }
            other => panic!("Windows 升级路径应返回 Killed{{via_force:true}}，实际 {other:?}"),
        }
        #[cfg(not(windows))]
        assert!(
            matches!(result, KillResult::Failed { .. }),
            "Unix 无 SIGKILL 升级原语，忽略 TERM 进程应 Failed，实际 {result:?}"
        );

        // diagnostics 两阶段留痕：优雅发送 + 强制升级（原因）
        let status = registry.status(&r.task_id).await.expect("status");
        let diag = &status.termination_diagnostics;
        assert!(
            diag.iter().any(|d| d.contains("优雅终止请求已发送")),
            "diagnostics 应含优雅留痕：{diag:?}"
        );
        assert!(
            diag.iter().any(|d| d.contains("强制终止升级")),
            "diagnostics 应含升级留痕：{diag:?}"
        );
        #[cfg(windows)]
        assert_eq!(status.status, TaskState::Killed);
    }

    /// 验收：自然退出后的任务 kill → AlreadyExited 携带自然退出码（0 与 7
    /// 两态），不强行升级。
    #[tokio::test]
    async fn kill_already_exited() {
        let registry = test_registry();
        let cwd = std::env::current_dir().expect("cwd");

        // exit 0
        let child = spawn_test_child("exit 0");
        let r1 = registry
            .adopt(adopt_request(child, "kill-exited-0", &cwd, false, None))
            .await
            .expect("adopt");
        let _ = wait_for_terminal(&registry, &r1.task_id, Duration::from_secs(5)).await;
        match registry.kill(&r1.task_id).await.expect("kill") {
            KillResult::AlreadyExited { task_id, exit_code } => {
                assert_eq!(task_id, r1.task_id);
                assert_eq!(exit_code, Some(0), "exit 0 任务的自然退出码应透传");
            }
            other => panic!("终态任务 kill 应返回 AlreadyExited，实际 {other:?}"),
        }

        // exit 7
        let child = spawn_test_child("exit 7");
        let r2 = registry
            .adopt(adopt_request(child, "kill-exited-7", &cwd, false, None))
            .await
            .expect("adopt");
        let _ = wait_for_terminal(&registry, &r2.task_id, Duration::from_secs(5)).await;
        match registry.kill(&r2.task_id).await.expect("kill") {
            KillResult::AlreadyExited { task_id, exit_code } => {
                assert_eq!(task_id, r2.task_id);
                assert_eq!(exit_code, Some(7), "exit 7 任务的自然退出码应透传");
            }
            other => panic!("终态任务 kill 应返回 AlreadyExited，实际 {other:?}"),
        }
    }

    /// 验收：kill 后 `.log` 保留且 read_log 仍可用（T-AB-09 保留语义在
    /// kill 路径不回归）。
    #[tokio::test]
    async fn kill_preserves_log() {
        let registry = test_registry();
        let child = spawn_test_child(LOG_KILL_COMMAND);
        let r = registry
            .adopt(adopt_request(child, "kill-log", Path::new("."), false, None))
            .await
            .expect("adopt");
        // 等有输出后 kill（两阶段终止路径）
        let _ = wait_until_tail_non_empty(&registry, &r.task_id, Duration::from_secs(10)).await;
        let result = registry.kill(&r.task_id).await.expect("kill");
        assert!(
            matches!(result, KillResult::Killed { .. }),
            "运行中任务 kill 应返回 Killed，实际 {result:?}"
        );

        let status = registry.status(&r.task_id).await.expect("status");
        assert_eq!(status.status, TaskState::Killed);
        let log_path = PathBuf::from(status.log_path);
        assert!(log_path.exists(), "kill 后 .log 必须保留");
        let slice = registry
            .read_log(&r.task_id, None, 100)
            .await
            .expect("kill 后 read_log 仍可用");
        assert!(slice.total_lines > 0, "kill 前累积的输出应可读");
        assert!(!slice.lines.is_empty(), "日志内容完整可读");
    }

    /// 验收：任务归档后 kill → NotFound 风格错误，消息附「日志文件仍在」可恢复
    /// 指引（.log 保留语义在 kill 路径与归档路径一致）。
    ///
    /// 命令带一行输出：`.log` 文件在首行输出时创建（无输出的任务不落盘，
    /// 归档指引断言的前提是日志文件真实存在）。
    #[tokio::test]
    async fn kill_after_archived_not_found() {
        let seq = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "crish-bg-kill-archived-{}-{seq}",
            std::process::id()
        ));
        let registry = BackgroundTaskRegistry::with_log_root(root, Duration::from_secs(2));
        let command = if cfg!(windows) {
            "Write-Output 'archived-task'; exit 0"
        } else {
            "echo archived-task; exit 0"
        };
        let child = spawn_test_child(command);
        let r = registry
            .adopt(adopt_request(child, "kill-archived", Path::new("."), false, None))
            .await
            .expect("adopt");
        let _ = wait_for_terminal(&registry, &r.task_id, Duration::from_secs(5)).await;
        // 等 2s 保留期过 → 归档清扫
        tokio::time::sleep(Duration::from_millis(2300)).await;
        let archived = registry.archive_expired();
        assert_eq!(archived, 1, "2s 保留到期应归档 1 条");

        let err = registry.kill(&r.task_id).await.expect_err("kill archived");
        assert_eq!(err.code(), codes::TOOL_NOT_FOUND);
        assert!(
            err.to_string().contains("日志文件仍在"),
            "归档后 NotFound 应附可恢复指引：{err}"
        );
    }

    // ── T-AB-12 终态保留 30 分钟 + 会话级存活 ──────────────────────────────

    /// 验收：注入 2s 保留时长 → 终态任务到期归档：list 过滤（内存条目清除）、
    /// status NotFound 附归档指引、.log 保留、.meta.json 清理。
    ///
    /// 命令带一行输出：`.log` 文件在首行输出时创建（归档指引与 .log 保留断言
    /// 的前提是日志文件真实存在）。
    #[tokio::test]
    async fn retention_archives_finished() {
        let seq = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "crish-bg-retention-{}-{seq}",
            std::process::id()
        ));
        let registry = BackgroundTaskRegistry::with_log_root(root, Duration::from_secs(2));
        let command = if cfg!(windows) {
            "Write-Output 'retained-task'; exit 0"
        } else {
            "echo retained-task; exit 0"
        };
        let child = spawn_test_child(command);
        let r = registry
            .adopt(adopt_request(child, "retention-task", Path::new("."), false, None))
            .await
            .expect("adopt");
        let status = wait_for_terminal(&registry, &r.task_id, Duration::from_secs(5)).await;
        let log_path = PathBuf::from(status.log_path);
        let meta_path = log_path.with_extension("meta.json");
        assert!(log_path.exists(), "终态任务日志存在（任务有输出）");

        // 保留期内（未过期）：任务仍可查询（list(true) 含 / status 可答）
        let all = registry.list(true).await.expect("list");
        assert!(
            all.iter().any(|i| i.task_id == r.task_id),
            "保留期内终态任务仍应可查询（终态保留语义）"
        );

        // 2s 保留期过后：归档清扫
        tokio::time::sleep(Duration::from_millis(2300)).await;
        let archived = registry.archive_expired();
        assert_eq!(archived, 1, "到期终态条目应被归档");

        // list 惰性过滤：内存条目已清
        let all = registry.list(true).await.expect("list");
        assert!(
            !all.iter().any(|i| i.task_id == r.task_id),
            "归档后 list 不得含该任务"
        );
        // status → NotFound 附归档指引
        let err = registry.status(&r.task_id).await.expect_err("status archived");
        assert_eq!(err.code(), codes::TOOL_NOT_FOUND);
        assert!(
            err.to_string().contains("日志文件仍在"),
            "归档 NotFound 应附可恢复指引：{err}"
        );
        // read_log 同样 NotFound（附指引）
        let err2 = registry
            .read_log(&r.task_id, None, 10)
            .await
            .expect_err("read_log archived");
        assert_eq!(err2.code(), codes::TOOL_NOT_FOUND);
        // .log 保留、.meta.json 清理
        assert!(log_path.exists(), "归档只清内存与 meta，.log 必须保留");
        assert!(!meta_path.exists(), "归档应清理 .meta.json");
    }

    /// 验收（会话级存活契约锚定）：run 终态收口**不清理 registry**——终态与
    /// 运行中任务在「模拟 run 终态」后均仍可查询。
    ///
    /// 只读验证（不改 core_run_commands.rs）：drive_run_loop 收口
    /// （core_run_commands.rs:1133-1183）无 registry 清理调用；registry 自身
    /// 不存在「run 级清理」入口（唯一终止入口为单任务 kill）。本测试锚定
    /// registry 侧行为：终态任务不因 run 结束被回收。
    #[tokio::test]
    async fn run_end_keeps_tasks() {
        let registry = test_registry();

        // 运行中任务（会话级存活：run 收口不回收）
        let child = spawn_test_child(LONG_COMMAND);
        let r1 = registry
            .adopt(adopt_request(child, "run-alive", Path::new("."), true, None))
            .await
            .expect("adopt");
        // 已完成任务
        let child = spawn_test_child("exit 0");
        let r2 = registry
            .adopt(adopt_request(child, "run-finished", Path::new("."), false, None))
            .await
            .expect("adopt");
        let _ = wait_for_terminal(&registry, &r2.task_id, Duration::from_secs(5)).await;

        // 模拟 run 终态收口：registry 无 run 级清理入口——「什么都不做」即契约
        let all = registry.list(true).await.expect("list");
        assert!(
            all.iter().any(|i| i.task_id == r1.task_id && i.status == TaskState::Running),
            "运行中任务在 run 终态后必须仍可查询"
        );
        assert!(
            all.iter().any(|i| i.task_id == r2.task_id
                && BackgroundTaskRegistry::is_terminal(i.status)),
            "终态任务在 run 终态后必须仍可查询（终态保留语义）"
        );
        let s1 = registry.status(&r1.task_id).await.expect("status r1");
        assert_eq!(s1.status, TaskState::Running);
        let s2 = registry.status(&r2.task_id).await.expect("status r2");
        assert!(BackgroundTaskRegistry::is_terminal(s2.status));

        // 清理
        let _ = registry.kill(&r1.task_id).await;
    }

    /// 验收（会话级存活契约锚定）：core_cancel_run 不级联杀任务（默认不联动，
    /// 职责单一）。无法直接驱动 core_cancel_run（需 CoreRunState 全量装配，
    /// 属 core_run_commands.rs 并行域，本侧不构造），按任务书替代方案：
    /// 「registry 清理函数不存在/不级联杀」的结构断言 + 进程存活最小断言。
    ///
    /// 结构断言（只读验证，回报说明）：BackgroundTaskManager 唯一终止入口为
    /// 单任务 `kill(task_id)`（crates/agent-tools/src/background.rs:51），无
    /// run 级/批量级联终止方法；adopt 的 is_daemon 仅作审计与过滤标记，不参与
    /// 终止决策。
    #[tokio::test]
    async fn cancel_run_keeps_tasks() {
        let registry = test_registry();
        let child = spawn_test_child(LONG_COMMAND);
        let pid = child.id().expect("spawned pid");
        let r = registry
            .adopt(adopt_request(child, "cancel-run-task", Path::new("."), true, None))
            .await
            .expect("adopt");
        // 进程存活最小断言：adopt 不终止进程；registry 无级联终止路径
        assert!(pid_is_alive(pid), "adopt 后任务进程必须存活");
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(pid_is_alive(pid), "无级联终止路径时任务进程持续存活");

        // 清理
        let _ = registry.kill(&r.task_id).await;
    }

    /// 验收：注册表条目上限（可注入，生产默认 200）——FIFO 淘汰最旧条目；
    /// 淘汰时若仍在运行先终止（force 树杀）；被淘汰条目 .log 保留。
    ///
    /// 两个场景：A) 运行中淘汰（硬兜底路径：先终止再移除）——用持续输出命令
    /// 保证被淘汰条目已有 `.log` 文件（无输出的任务不落盘）；B) 终态淘汰
    /// （仅内存+meta 清理）。
    #[tokio::test]
    async fn registry_capacity_evicts() {
        // 场景 A：cap=3，4 个长运行任务 → 最旧者被淘汰且其进程被终止
        let seq = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
        let root_a = std::env::temp_dir().join(format!(
            "crish-bg-cap-a-{}-{seq}",
            std::process::id()
        ));
        let registry_a =
            BackgroundTaskRegistry::with_config(root_a.clone(), Duration::from_secs(30 * 60), 3);
        let mut ids = Vec::new();
        let mut pid_first = None;
        for i in 0..4 {
            let child = spawn_test_child(OUTPUT_COMMAND);
            let pid = child.id().expect("spawned pid");
            if i == 0 {
                pid_first = Some(pid);
            }
            let r = registry_a
                .adopt(adopt_request(
                    child,
                    &format!("cap-run-{i}"),
                    Path::new("."),
                    false,
                    None,
                ))
                .await
                .expect("adopt");
            // 首条等待输出落盘（被淘汰条目的 .log 保留断言前提；等待期间
            // 条目数 1 ≤ 3，不会触发淘汰）
            if i == 0 {
                let _ = wait_until_tail_non_empty(
                    &registry_a,
                    &r.task_id,
                    Duration::from_secs(5),
                )
                .await;
            }
            ids.push(r.task_id);
        }
        // 第 4 个 adopt 触发淘汰（4 条 > 3 上限）：最旧（cap-run-0）被淘汰
        let all = registry_a.list(true).await.expect("list");
        assert_eq!(all.len(), 3, "淘汰后应剩 3 条");
        assert!(
            !all.iter().any(|i| i.task_id == ids[0]),
            "最旧条目 cap-run-0 应被 FIFO 淘汰"
        );
        let pid0 = pid_first.expect("首条 pid");
        assert!(
            !pid_is_alive(pid0),
            "运行中淘汰应先终止进程（pid={pid0}）"
        );
        // 被淘汰条目 .log 保留（OUTPUT_COMMAND 首行输出已落盘）
        let log0 = root_a.join(format!("{}.log", ids[0]));
        assert!(log0.exists(), "容量淘汰不得删除 .log");
        // 剩余条目仍可查询（未被误淘汰；OUTPUT_COMMAND 约 4s 自然结束，断言
        // 在此前完成，状态仍为 Running）
        for id in &ids[1..] {
            let s = registry_a.status(id).await.expect("status");
            assert_eq!(s.status, TaskState::Running, "{id} 不应被淘汰");
        }
        // 清理：kill 剩余 3 条（可能已自然完成 → AlreadyExited，无妨）
        for id in &ids[1..] {
            let _ = registry_a.kill(id).await;
        }

        // 场景 B：cap=3，逐条 adopt 快速完成任务（每条先等其终态）→ 第 4 条
        // adopt 时最旧终态条目被淘汰（is_running=false 分支：仅清内存与 meta）
        let seq = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
        let root_b = std::env::temp_dir().join(format!(
            "crish-bg-cap-b-{}-{seq}",
            std::process::id()
        ));
        let registry_b =
            BackgroundTaskRegistry::with_config(root_b.clone(), Duration::from_secs(30 * 60), 3);
        let done_command = if cfg!(windows) {
            "Write-Output 'cap-done'; exit 0"
        } else {
            "echo cap-done; exit 0"
        };
        let mut ids_b = Vec::new();
        for i in 0..4 {
            let child = spawn_test_child(done_command);
            let r = registry_b
                .adopt(adopt_request(
                    child,
                    &format!("cap-done-{i}"),
                    Path::new("."),
                    false,
                    None,
                ))
                .await
                .expect("adopt");
            // 等终态后再 adopt 下一条（保证淘汰对象为终态条目）
            let _ = wait_for_terminal(&registry_b, &r.task_id, Duration::from_secs(5)).await;
            ids_b.push(r.task_id);
        }
        let all = registry_b.list(true).await.expect("list");
        assert_eq!(all.len(), 3, "终态条目淘汰后应剩 3 条");
        assert!(
            !all.iter().any(|i| i.task_id == ids_b[0]),
            "最旧终态条目 cap-done-0 应被淘汰"
        );
        // 被淘汰条目：.log 保留、.meta.json 清理、status NotFound
        let log0 = root_b.join(format!("{}.log", ids_b[0]));
        let meta0 = root_b.join(format!("{}.meta.json", ids_b[0]));
        assert!(log0.exists(), "终态淘汰不得删除 .log");
        assert!(!meta0.exists(), "终态淘汰应清理 .meta.json");
        let err = registry_b.status(&ids_b[0]).await.expect_err("status evicted");
        assert_eq!(err.code(), codes::TOOL_NOT_FOUND);
        // 剩余终态条目仍可查询
        for id in &ids_b[1..] {
            let s = registry_b.status(id).await.expect("status");
            assert!(BackgroundTaskRegistry::is_terminal(s.status), "{id} 仍可查询");
        }
    }

    // ── T-AB-15 资源采集原语 ──────────────────────────────────────────────

    /// 短周期测试注册表（资源段专用）：500ms 采样 / 2s 静默阈值 + 通知队列注入；
    /// 采样源为真实 [crate::resource::sample_usage]（resource_* 验收用）。
    /// 返回 (registry, queue)。
    fn resource_test_registry() -> (
        Arc<BackgroundTaskRegistry>,
        Arc<Mutex<VecDeque<String>>>,
    ) {
        let (queue, sampler) = (Arc::new(Mutex::new(VecDeque::new())), Arc::new(sample_usage));
        resource_test_registry_with_sampler(queue, sampler)
    }

    /// 短周期测试注册表 + 采样源替身注入（健康类测试用）：500ms 采样 / 2s
    /// 静默阈值 + 通知队列注入 + 自定义采样源。
    /// 返回 (registry, queue)。
    fn resource_test_registry_with_sampler(
        queue: Arc<Mutex<VecDeque<String>>>,
        sampler: SamplerFn,
    ) -> (Arc<BackgroundTaskRegistry>, Arc<Mutex<VecDeque<String>>>) {
        let seq = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "crish-bg-resource-{}-{seq}",
            std::process::id()
        ));
        let registry = BackgroundTaskRegistry::with_resource_monitor(
            root,
            Duration::from_secs(30 * 60),
            MAX_BACKGROUND_TASKS,
            ResourceMonitorConfig {
                sample_interval_ms: 500,
                silence_threshold_ms: 2000,
            },
            TaskNotifier::with_nudge_queue(Arc::clone(&queue)),
            sampler,
        );
        (registry, queue)
    }

    /// 静默采样替身：CPU 累计恒定（差值恒 0%）——模拟无 CPU 消耗的静默任务，
    /// 判定输入确定性可控（不受共享 daemon Job 的并行测试污染，见 [SamplerFn]）。
    fn silent_sampler() -> SamplerFn {
        Arc::new(|_pid| {
            Ok::<RawUsage, String>(RawUsage {
                cpu_ms: 1000,
                rss_bytes: 4096,
            })
        })
    }

    /// 脚本化采样替身：静默恒定 → 第 `spike_at` 次采样注入一次 CPU 尖峰
    /// （+300ms，2s 窗口下 60% ≫ 活跃阈值 1%）→ 恢复静默。用于确定性复现
    /// 「Suspicious 保持期被 CPU 抖动打断 → 恢复 Healthy 重置防抖 → 再次
    /// Suspicious 重新通知」的合法重复通知场景（T-AB-16 2 语义）。
    fn spiking_sampler(spike_at: u64) -> SamplerFn {
        let n = Arc::new(AtomicU64::new(0));
        let n2 = Arc::clone(&n);
        Arc::new(move |_pid| {
            let i = n2.fetch_add(1, Ordering::Relaxed);
            let cpu_ms = if i == spike_at { 1300 } else { 1000 };
            Ok::<RawUsage, String>(RawUsage {
                cpu_ms,
                rss_bytes: 4096,
            })
        })
    }

    /// 启用 resourceMonitor 的 adopt 请求（T-AB-15 验收用）。
    fn adopt_request_monitored(
        child: Child,
        command: &str,
        cwd: &Path,
    ) -> BackgroundAdoptRequest {
        let mut req = adopt_request(child, command, cwd, false, None);
        req.resource_monitor = true;
        req
    }

    /// 验收：启用 resourceMonitor 的真实长跑任务——采样后 `status().resource`
    /// 非空且 `cpu_percent ∈ [0,100]`、`rss_bytes > 0`、快照内 `last_output_at_ms`
    /// 与 status 一致且随输出更新。
    ///
    /// 采样口径：首拍建基线（丢弃），第二拍起产生有效采样（本测试轮询等待
    /// resource 非空——首采样丢弃语义的集成断言由 resource_first_sample_dropped
    /// 单元覆盖）。
    #[tokio::test]
    async fn resource_sample_collected() {
        let (registry, _queue) = resource_test_registry();
        let child = spawn_test_child(OUTPUT_COMMAND);
        let r = registry
            .adopt(adopt_request_monitored(child, "resource-sample", Path::new(".")))
            .await
            .expect("adopt");
        let task_id = r.task_id.clone();

        // 轮询等待第一份有效采样（窗口 20s：首拍丢弃 + 500ms 周期 + 输出命令 4s）
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        let first_output_at = loop {
            let status = registry.status(&task_id).await.expect("status");
            if let Some(res) = &status.resource {
                assert!(
                    res.cpu_percent.is_finite(),
                    "cpu_percent 必须为有限值：{}",
                    res.cpu_percent
                );
                assert!(
                    (0.0..=100.0).contains(&res.cpu_percent),
                    "cpu_percent 应在 [0,100]：{}",
                    res.cpu_percent
                );
                assert!(res.rss_bytes > 0, "rss_bytes 应 > 0：{}", res.rss_bytes);
                assert_eq!(
                    res.last_output_at_ms, status.last_output_at_ms,
                    "快照内 last_output_at_ms 与 status 一致（事件驱动刷新）"
                );
                break res.last_output_at_ms;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "采样迟迟未生效（首采样丢弃后应有有效采样）"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        };

        // last_output_at_ms 随输出更新：输出命令持续产出，再等一拍后应增长
        tokio::time::sleep(Duration::from_millis(700)).await;
        let status = registry.status(&task_id).await.expect("status");
        assert!(
            status.last_output_at_ms >= first_output_at,
            "last_output_at_ms 应随输出单调更新：{first_output_at} -> {}",
            status.last_output_at_ms
        );

        // 清理
        let _ = registry.kill(&task_id).await;
    }

    /// 验收：首采样无基线不产生无效值（cpu_percent 不出现 NaN/异常值）——
    /// 单元断言差值语义（零差值 → 0.0、墙钟零差值不除零、差值回退 clamp 0）；
    /// 真实任务路径的「首拍仅建基线」由 resource_sample_collected 的首份
    /// 采样有效性断言覆盖。
    #[test]
    fn resource_first_sample_dropped() {
        let prev = RawUsage {
            cpu_ms: 1000,
            rss_bytes: 4096,
        };
        // 首采样基线自身不产生差值（零差值 → 0.0 而非 NaN）
        let same = RawUsage {
            cpu_ms: 1000,
            rss_bytes: 4096,
        };
        let pct = cpu_percent_from_delta(&prev, &same, 1_000, 3_000);
        assert!(pct.is_finite() && pct >= 0.0 && pct <= 100.0, "零差值不得出 NaN：{pct}");
        // 墙钟零差值：不除零
        assert_eq!(cpu_percent_from_delta(&prev, &same, 3_000, 3_000), 0.0);
        // 差值回退（进程 CPU 时间非单调的防御）：clamp 0
        let lower = RawUsage {
            cpu_ms: 800,
            rss_bytes: 4096,
        };
        assert_eq!(cpu_percent_from_delta(&prev, &lower, 1_000, 3_000), 0.0);
        // 正常差值：500ms CPU / 2s 墙钟 = 25%
        let busy = RawUsage {
            cpu_ms: 1500,
            rss_bytes: 4096,
        };
        assert_eq!(cpu_percent_from_delta(&prev, &busy, 1_000, 3_000), 25.0);
    }

    /// 验收：`.samples.jsonl` 内容为合法 JSONL 且条数随时间增长
    /// （复用 append_jsonl_lines 落盘，perf/jsonl.rs:49-72）。
    #[tokio::test]
    async fn resource_samples_persisted() {
        let (registry, _queue) = resource_test_registry();
        let child = spawn_test_child(OUTPUT_COMMAND);
        let r = registry
            .adopt(adopt_request_monitored(child, "resource-persist", Path::new(".")))
            .await
            .expect("adopt");
        let task_id = r.task_id.clone();
        let samples_path = {
            let status = registry.status(&task_id).await.expect("status");
            PathBuf::from(status.log_path).with_extension("samples.jsonl")
        };

        // 轮询等待至少 2 条采样（首拍丢弃 → 第二拍起写盘）
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        let first_count = loop {
            if samples_path.exists() {
                let raw = std::fs::read_to_string(&samples_path).expect("读 samples");
                let lines: Vec<&str> = raw.lines().filter(|l| !l.is_empty()).collect();
                if lines.len() >= 2 {
                    // 逐行合法 JSON + 冻结字段形状（camelCase）
                    for line in &lines {
                        let v: serde_json::Value =
                            serde_json::from_str(line).expect("每行必须为合法 JSON");
                        for key in [
                            "sampledAtMs",
                            "cpuPercent",
                            "rssBytes",
                            "lastOutputAtMs",
                            "ioReadBytes",
                            "ioWriteBytes",
                        ] {
                            assert!(v.get(key).is_some(), "采样缺字段 {key}: {v}");
                        }
                        assert_eq!(v["ioReadBytes"], 0, "I/O 首版恒 0（诚实边界）");
                        assert_eq!(v["ioWriteBytes"], 0, "I/O 首版恒 0（诚实边界）");
                    }
                    break lines.len();
                }
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "samples.jsonl 迟迟未累积（首采样丢弃后应持续写盘）"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        };

        // 条数随时间增长：再等 1s（≥ 2 拍）后应更多
        tokio::time::sleep(Duration::from_millis(1000)).await;
        let raw = std::fs::read_to_string(&samples_path).expect("读 samples");
        let second_count = raw.lines().filter(|l| !l.is_empty()).count();
        assert!(
            second_count > first_count,
            "采样条数应随时间增长：{first_count} -> {second_count}"
        );

        // 清理
        let _ = registry.kill(&task_id).await;
    }

    /// 验收：未启用 resourceMonitor 的任务 `resource: None` 且不落盘
    /// `.samples.jsonl`（采样 loop 未挂载）。
    #[tokio::test]
    async fn resource_disabled_none() {
        let (registry, _queue) = resource_test_registry();
        let child = spawn_test_child(LONG_COMMAND);
        let r = registry
            .adopt(adopt_request(child, "resource-disabled", Path::new("."), false, None))
            .await
            .expect("adopt");
        let task_id = r.task_id.clone();

        // 等几拍采样周期（若误挂载采样则此时应已落盘/置位）
        tokio::time::sleep(Duration::from_millis(1200)).await;
        let status = registry.status(&task_id).await.expect("status");
        assert!(
            status.resource.is_none(),
            "未启用 resourceMonitor 的任务 resource 必须为 None：{:?}",
            status.resource
        );
        let samples_path = PathBuf::from(status.log_path).with_extension("samples.jsonl");
        assert!(
            !samples_path.exists(),
            "未启用采样不得创建 .samples.jsonl"
        );

        // 清理
        let _ = registry.kill(&task_id).await;
    }

    // ── T-AB-16 健康判定三态 + 通知 ────────────────────────────────────────

    /// 防抖状态机纯单测（T-AB-16 2 语义确定性证明；注入 mock 判定序列——
    /// 即「直接注入已静默的 mock 状态」，不受真实采样/共享 daemon Job 影响）：
    /// 同任务保持期间仅一次，恢复 Healthy 后重置。
    #[test]
    fn debounce_suspicious_notifies_once_per_keep_period() {
        let mut d = SuspiciousDebounce::default();
        // 保持期间：连续 Suspicious 仅首次通知
        assert!(d.observe(ProcessHealth::Suspicious), "首次 Suspicious 应通知");
        assert!(!d.observe(ProcessHealth::Suspicious), "保持期第二次不得通知");
        assert!(!d.observe(ProcessHealth::Suspicious), "保持期第三次不得通知");
        // 恢复 Healthy 重置后，再次进入 Suspicious 才允许新通知
        assert!(!d.observe(ProcessHealth::Healthy), "Healthy 不通知");
        assert!(
            d.observe(ProcessHealth::Suspicious),
            "恢复 Healthy 后再次 Suspicious 应重新通知（重置语义）"
        );
        assert!(!d.observe(ProcessHealth::Suspicious), "新保持期第二次不得通知");
        // 重置后保持期内连续多次 Healthy → 不通知且保持重置
        assert!(!d.observe(ProcessHealth::Healthy), "重置不通知");
        assert!(!d.observe(ProcessHealth::Healthy), "连续 Healthy 不通知");
        assert!(
            d.observe(ProcessHealth::Suspicious),
            "再次重置后仍可重新通知"
        );
    }

    /// 防抖状态机纯单测：Healthy 稳态永不通知；Crashed 不参与防抖。
    #[test]
    fn debounce_healthy_steady_never_notifies() {
        let mut d = SuspiciousDebounce::default();
        for _ in 0..8 {
            assert!(
                !d.observe(ProcessHealth::Healthy),
                "Healthy 稳态不得产生任何通知"
            );
        }
        assert!(
            !d.observe(ProcessHealth::Crashed),
            "Crashed 不参与防抖（终态由 finish_task 通知）"
        );
        // Crashed 不清除也未武装防抖：后续 Suspicious 仍按保持期语义通知
        assert!(
            d.observe(ProcessHealth::Suspicious),
            "Crashed 拍不影响后续 Suspicious 判定"
        );
    }

    /// 验收：Suspicious 检测 + 通知去重——注入短静默阈值（2s）的静默任务 →
    /// 转 Suspicious、nudge 队列收到通知（文案含任务 id / 疑似卡死 / 由 AI 裁决）
    /// 且同任务保持期间不重复通知。
    ///
    /// 判定输入注入静默采样替身（[silent_sampler]，判定稳定为「CPU 近零 +
    /// 无输出 → Suspicious」）：真实采样读共享 daemon Job 的 CPU 读数受并行
    /// 测试子进程污染（[SamplerFn] 登记说明），替身使「保持期间仅一次」断言
    /// 确定性成立；CPU 抖动导致的合法重复通知（恢复 Healthy 重置）由
    /// health_healthy_reset_reenables_notification 单独覆盖。
    #[tokio::test]
    async fn health_suspicious_detected() {
        let (registry, queue) = resource_test_registry_with_sampler(
            Arc::new(Mutex::new(VecDeque::new())),
            silent_sampler(),
        );
        let child = spawn_test_child(LONG_COMMAND);
        let r = registry
            .adopt(adopt_request_monitored(child, "health-suspicious", Path::new(".")))
            .await
            .expect("adopt");
        let task_id = r.task_id.clone();

        // 轮询等待 Suspicious 通知入队（2s 静默阈值 + 采样拍；窗口 25s）
        let deadline = tokio::time::Instant::now() + Duration::from_secs(25);
        let text = loop {
            if let Some(text) = queue.lock().unwrap_or_else(|p| p.into_inner()).pop_front() {
                break text;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "静默任务迟迟未触发 Suspicious 通知"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        };
        assert!(text.contains(&task_id), "通知含任务 id：{text}");
        assert!(text.contains("疑似卡死"), "文案含疑似卡死：{text}");
        assert!(text.contains("2 秒无输出"), "文案含静默时长（M=2s）：{text}");
        assert!(text.contains("由 AI 裁决"), "文案注明 AI 裁决：{text}");

        // 防抖：保持期间再等 3s（多拍采样），队列不得出现重复通知（判定
        // 输入为静默替身 → 保持期间判定恒为 Suspicious，断言确定性成立）
        tokio::time::sleep(Duration::from_millis(3000)).await;
        assert!(
            queue.lock().unwrap_or_else(|p| p.into_inner()).is_empty(),
            "同任务保持期间不得重复通知（防抖）：{:?}",
            queue.lock().unwrap_or_else(|p| p.into_inner())
        );

        // 清理
        let _ = registry.kill(&task_id).await;
    }

    /// 验收：Suspicious 保持期被 CPU 抖动打断后的**合法重复通知**（T-AB-16 2
    /// 语义：「同任务防抖——保持期间仅一次，恢复 Healthy 后重置」）。
    ///
    /// 注入脚本化采样替身（[spiking_sampler]）确定性复现 flaky 报告中的
    /// 场景：首通知后采样读入一次 CPU 尖峰（判 Healthy → 重置防抖）→ 再静默
    /// （判 Suspicious）→ 第二次通知。断言恰好两次（每次保持期仅一次），
    /// 确认实现与方案语义一致——CPU 抖动产生的重复通知属合法行为而非 bug。
    #[tokio::test]
    async fn health_healthy_reset_reenables_notification() {
        // 采样拍序：拍 1 建基线（丢弃），拍 2 起判定；spike_at=8 → 拍 9
        // （约 t=4.5s，首通知 ~2.5s 之后）注入尖峰 → 拍 10 起恢复静默
        let (registry, queue) = resource_test_registry_with_sampler(
            Arc::new(Mutex::new(VecDeque::new())),
            spiking_sampler(8),
        );
        let child = spawn_test_child(LONG_COMMAND);
        let r = registry
            .adopt(adopt_request_monitored(
                child,
                "health-reset-renotify",
                Path::new("."),
            ))
            .await
            .expect("adopt");
        let task_id = r.task_id.clone();

        // 第一次通知（静默 2s 阈值 + 采样拍；窗口 25s）
        let deadline = tokio::time::Instant::now() + Duration::from_secs(25);
        let first = loop {
            if let Some(text) = queue.lock().unwrap_or_else(|p| p.into_inner()).pop_front() {
                break text;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "静默任务迟迟未触发首次 Suspicious 通知"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        };
        assert!(first.contains(&task_id), "首次通知含任务 id：{first}");

        // 第二次通知（尖峰判 Healthy 重置防抖 → 再静默再次通知；窗口 10s）
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let second = loop {
            if let Some(text) = queue.lock().unwrap_or_else(|p| p.into_inner()).pop_front() {
                break text;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "恢复 Healthy 后再次静默应重新通知（防抖重置）"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        };
        assert!(second.contains(&task_id), "第二次通知含任务 id：{second}");
        assert!(second.contains("疑似卡死"), "第二次通知文案含疑似卡死：{second}");

        // 尖峰已过、判定恒为 Suspicious：再等 2s 不得出现第三次（每次保持期
        // 仅一次——恢复 Healthy 重置语义只允许「一次重置 → 一次新通知」）
        tokio::time::sleep(Duration::from_millis(2000)).await;
        assert!(
            queue.lock().unwrap_or_else(|p| p.into_inner()).is_empty(),
            "恢复 Healthy 后应恰好重新通知一次，不得再次重复：{:?}",
            queue.lock().unwrap_or_else(|p| p.into_inner())
        );

        // 清理
        let _ = registry.kill(&task_id).await;
    }

    /// 验收：Healthy 无误报——持续输出任务（last_output_at_ms 不断刷新）
    /// 不产生 Suspicious 通知；任务自然完成后再等几拍也不通知。
    #[tokio::test]
    async fn health_healthy_no_false_positive() {
        let (registry, queue) = resource_test_registry();
        let child = spawn_test_child(OUTPUT_COMMAND);
        let r = registry
            .adopt(adopt_request_monitored(child, "health-healthy", Path::new(".")))
            .await
            .expect("adopt");
        let task_id = r.task_id.clone();

        // 等待自然完成（OUTPUT_COMMAND ~4s 持续输出；窗口 15s）
        let _ = wait_for_terminal(&registry, &task_id, Duration::from_secs(15)).await;
        // 终态后采样循环已退出（无后续判定），队列应始终为空
        tokio::time::sleep(Duration::from_millis(1000)).await;
        assert!(
            queue.lock().unwrap_or_else(|p| p.into_inner()).is_empty(),
            "持续输出任务不得误报 Suspicious"
        );
    }

    /// 验收：Crashed 通知——非零退出（启用 resourceMonitor）→ 队列收到通知
    /// 且附最后 20 行日志（复用 read_log 尾部读取语义）。
    #[tokio::test]
    async fn health_crashed_notified() {
        let (registry, queue) = resource_test_registry();
        let command = if cfg!(windows) {
            "Write-Output 'crash-line-1'; Write-Output 'crash-line-2'; exit 7"
        } else {
            "echo crash-line-1; echo crash-line-2; exit 7"
        };
        let child = spawn_test_child(command);
        let r = registry
            .adopt(adopt_request_monitored(child, "health-crashed", Path::new(".")))
            .await
            .expect("adopt");
        let task_id = r.task_id.clone();

        let status = wait_for_terminal(&registry, &task_id, Duration::from_secs(15)).await;
        assert_eq!(status.status, TaskState::Failed, "exit 7 → Failed");
        // 终态即屏障：writer 收口时已投递 Crashed 通知，队列应恰好 1 条
        let text = queue
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .pop_front()
            .expect("非零退出应收到 Crashed 通知");
        assert!(text.contains(&task_id), "通知含任务 id：{text}");
        assert!(text.contains("异常退出"), "文案含异常退出：{text}");
        assert!(text.contains("exit code 7"), "文案含退出码：{text}");
        assert!(text.contains("crash-line-2"), "附最后 20 行日志（含末行）：{text}");
        assert!(text.contains("由 AI 裁决"), "文案注明 AI 裁决：{text}");
        assert!(
            queue.lock().unwrap_or_else(|p| p.into_inner()).is_empty(),
            "Crashed 通知只投递一次（终态唯一）"
        );
    }

    /// 验收：不自动杀——Suspicious 判定后进程仍存活（显式断言不自动杀、
    /// 不自动降级超时，T-AB-16 4 严格不做）。
    ///
    /// 判定输入注入静默采样替身（与 health_suspicious_detected 同理：真实
    /// 采样读共享 daemon Job 受并行测试污染，替身保证 Suspicious 判定必然
    /// 且稳定到达——本测试只关心「判定后不杀进程」，与 CPU 读数无关）。
    #[tokio::test]
    async fn health_no_autokill() {
        let (registry, queue) = resource_test_registry_with_sampler(
            Arc::new(Mutex::new(VecDeque::new())),
            silent_sampler(),
        );
        let child = spawn_test_child(LONG_COMMAND);
        let pid = child.id().expect("spawned pid");
        let r = registry
            .adopt(adopt_request_monitored(child, "health-no-autokill", Path::new(".")))
            .await
            .expect("adopt");
        let task_id = r.task_id.clone();

        // 等待 Suspicious 通知（= 判定已发生）
        let deadline = tokio::time::Instant::now() + Duration::from_secs(25);
        loop {
            if !queue.lock().unwrap_or_else(|p| p.into_inner()).is_empty() {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "静默任务迟迟未触发 Suspicious 通知"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        // 显式断言：Suspicious 判定后进程仍存活（系统不自动终止）
        assert!(pid_is_alive(pid), "Suspicious 判定不得自动杀进程（pid={pid}）");
        // 再等 2s（多拍判定后）确认仍未杀
        tokio::time::sleep(Duration::from_millis(2000)).await;
        assert!(pid_is_alive(pid), "Suspicious 持续期间进程必须存活（pid={pid}）");

        // 清理
        let _ = registry.kill(&task_id).await;
    }
}
