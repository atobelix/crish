//! 资源采集原语与健康判定（T-AB-15 / T-AB-16：REQ-A04）
//!
//! 职责：
//! - [ResourceMonitorConfig]：采样配置（方案 §4.3 冻结形状：`sample_interval_ms`
//!   默认 2000、`silence_threshold_ms` 默认 60000）；
//! - [ProcessHealth]：健康判定三态（§4.3 冻结形状：Healthy / Suspicious / Crashed）；
//! - [judge_health]：三态判定内核（纯函数，可单测）——本函数只产出 Healthy /
//!   Suspicious；Crashed 属终态（非零退出码），由转发器终态触发
//!   （[TaskNotifier::notify_failed]），不经采样判定；
//! - [cpu_percent_from_delta]：周期差值 / 墙钟差值 = CPU%（纯函数，可单测）；
//! - [sample_usage]：跨平台单拍采集原语——Windows `QueryInformationJobObject`
//!   （JobObjectBasicAccountingInformation 的 TotalUserTime/TotalKernelTime 周期
//!   差值算 CPU%；JobObjectExtendedLimitInformation 的 PeakJobMemoryUsed 近似
//!   RSS）；Unix `/proc/<pid>/stat`（utime+stime）+ `getrusage(RUSAGE_CHILDREN)`
//!   进程树近似；
//! - [TaskNotifier]：通知投递器（T-AB-16 双通道：nudge 排队 + 任务域事件发射）。
//!
//! 诚实边界（实现文档，与方案 §8.3 对齐）：
//! - Windows RSS 为 Job 累计峰值（PeakJobMemoryUsed）近似，非实时当前工作集；
//! - Unix 进程树累加退化为「主进程 + 已回收子进程（RUSAGE_CHILDREN 差值）」近似，
//!   未回收孙进程不计入——与 Windows Job 树聚合存在数值口径差异，跨平台不承诺等价；
//! - I/O 首版恒 0（§8.3 诚实边界 4：Windows 进程树 I/O 聚合繁琐，列为可选）；
//! - 通知双通道接线状态（C2 / T-AB-17/18 落地前的占位，登记偏差）：
//!   * nudge 通道：`PendingNudgeChannel` 实例在 orchestrator 的
//!     `PendingMessageQueue` 内部，壳层无访问入口 → 生产默认 None（通知文本经
//!     tracing 留痕），测试注入内存队列断言「收到且不重复」；
//!   * 事件通道：任务域事件（task-suspicious / task-failed）依赖 C2 在
//!     conex-types 落地 AgentEvent 七事件变体（T-AB-17）——落地前经
//!     [LogEventSink] 结构化日志留痕（payload 按冻结契约 §4.5 组装，C2 落地后
//!     以信封构造替换发射实现，payload 形状不变，零改动迁移）。

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use crate::process::now_millis;

// ============================================================================
// 采样配置与健康判定三态（方案 §4.3 冻结形状）
// ============================================================================

/// 采样配置（§4.3：registry 构造参数，默认值可在测试中注入）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ResourceMonitorConfig {
    /// 采样周期（毫秒；默认 2000）
    pub(crate) sample_interval_ms: u64,
    /// 静默阈值 M（毫秒；默认 60_000）：CPU 近零且超过该时长无输出 → Suspicious
    pub(crate) silence_threshold_ms: u64,
}

impl Default for ResourceMonitorConfig {
    fn default() -> Self {
        Self {
            sample_interval_ms: 2000,
            silence_threshold_ms: 60_000,
        }
    }
}

/// 健康判定三态（§4.3 冻结形状）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProcessHealth {
    /// CPU 活跃或最近 N 秒内有输出
    Healthy,
    /// 疑似卡死：CPU 近零 + 超过 M 秒无输出（M 默认 60s，可配）
    Suspicious,
    /// 异常退出（exit_code != 0；由转发器终态触发，非采样判定）
    #[allow(dead_code)] // 冻结形状 §4.3 保留；Crashed 经 TaskState::Failed 终态表达，
    // 不经本枚举构造（judge_health 只产出 Healthy/Suspicious）
    Crashed,
}

/// CPU 活跃阈值：周期差值 CPU% ≥ 该值视为「CPU 活跃」（< 该值视为「近零」）。
/// 2s 采样窗口下 1% ≈ 20ms 忙——纯睡眠进程通常 0%~0.2%，留足余量防误报；
/// 编译类命令（cargo build 长时间无输出）等 CPU 活跃任务不会被误判。
const CPU_ACTIVE_THRESHOLD_PERCENT: f64 = 1.0;

/// 三态判定内核（纯函数；采样循环每拍调用）。
///
/// 判定规则（T-AB-16 1）：Healthy = CPU 活跃（cpu_percent ≥ 1%）或最近
/// N（= `silence_threshold_ms`）毫秒内有输出；Suspicious = CPU 近零 且 超过
/// M 毫秒无输出。Crashed 属终态，不在此判定。
pub(crate) fn judge_health(
    now_ms: u64,
    last_output_at_ms: u64,
    cpu_percent: f64,
    config: &ResourceMonitorConfig,
) -> ProcessHealth {
    let silent_ms = now_ms.saturating_sub(last_output_at_ms);
    if cpu_percent >= CPU_ACTIVE_THRESHOLD_PERCENT || silent_ms <= config.silence_threshold_ms {
        ProcessHealth::Healthy
    } else {
        ProcessHealth::Suspicious
    }
}

// ============================================================================
// 采集原语（T-AB-15 1/2：Windows JobObject FFI / Unix /proc）
// ============================================================================

/// 单拍采集结果（跨平台统一口径：CPU 毫秒累计值 + RSS 字节）。
///
/// cpu_ms 为「累计值」而非差值：采样循环持有上一拍值，按周期差值模型
/// （差值 / 墙钟差值）计算 CPU%（首采样无基线即丢弃）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RawUsage {
    /// 进程树累计 CPU 时间（毫秒；Windows = Job 全树，Unix = 主进程 + 已回收
    /// 子进程近似）
    pub(crate) cpu_ms: u64,
    /// RSS / 工作集（字节；Windows = Job 峰值近似，Unix = 主进程 pages +
    /// 已回收子进程 ru_maxrss 峰值近似）
    pub(crate) rss_bytes: u64,
}

/// 由两次原始采样计算 CPU%（周期差值 / 墙钟差值；纯函数）。
///
/// 返回 [0, 100] 的有限值：墙钟零差值 → 0.0（不除零）；差值回退（进程 CPU
/// 时间非单调的防御）→ clamp 下限 0——首采样无基线时不调用本函数（采样循环
/// 直接丢弃），保证 cpu_percent 不出现 NaN/异常值。
pub(crate) fn cpu_percent_from_delta(
    prev: &RawUsage,
    cur: &RawUsage,
    prev_wall_ms: u64,
    cur_wall_ms: u64,
) -> f64 {
    let wall_ms = cur_wall_ms.saturating_sub(prev_wall_ms);
    let cpu_ms = cur.cpu_ms.saturating_sub(prev.cpu_ms);
    if wall_ms == 0 {
        return 0.0;
    }
    (cpu_ms as f64 * 100.0 / wall_ms as f64).clamp(0.0, 100.0)
}

/// 采集一次原始用量（单拍）。
///
/// - Windows：`QueryInformationJobObject`（daemon Job 句柄经
///   `crate::process::daemon_job_handle()` 获取）——任务已在 daemon Job 内
///   （T-AB-06 adopt 接线），子进程自动聚合，无遍历成本；
/// - Unix：`/proc/<pid>/stat`（utime+stime，clk_tck 换算）+ `getrusage(
///   RUSAGE_CHILDREN)` 差值口径的进程树近似。
///
/// 失败返回 Err（Job 句柄缺失 / 进程已退出 / /proc 不可读），由采样循环跳过本拍。
#[cfg_attr(windows, allow(unused_variables))] // Windows 侧走 Job 句柄（pid 仅 Unix 用）
pub(crate) fn sample_usage(pid: u32) -> Result<RawUsage, String> {
    #[cfg(windows)]
    {
        let job = crate::process::daemon_job_handle()
            .ok_or_else(|| "daemon job object 未初始化（Windows 采样不可用）".to_string())?;
        sample_windows(job)
    }
    #[cfg(not(windows))]
    {
        sample_unix(pid)
    }
}

/// Windows：QueryInformationJobObject 双查——BasicAccountingInformation 的
/// TotalUserTime/TotalKernelTime（FILETIME，100ns 单位）累加为 CPU 累计毫秒；
/// ExtendedLimitInformation 的 PeakJobMemoryUsed 近似 RSS（Job 累计峰值）。
///
/// FFI 风格对齐 `process.rs:391-443`（每处 unsafe 有 SAFETY 说明，经评审后允许）。
#[cfg(windows)]
#[allow(unsafe_code)] // Windows Job Objects FFI（QueryInformationJobObject × 2），
                      // SAFETY 见函数内注释，经评审后允许
fn sample_windows(job: windows_sys::Win32::Foundation::HANDLE) -> Result<RawUsage, String> {
    use core::mem;
    use windows_sys::Win32::System::JobObjects::{
        JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
        QueryInformationJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    };

    let mut basic: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { mem::zeroed() };
    // SAFETY: basic 为栈分配结构（尺寸传真实大小），失败仅返回 FALSE 不写内存；
    // 查询类 API 无句柄所有权转移，job 句柄生命周期与进程一致
    let ret = unsafe {
        QueryInformationJobObject(
            job,
            JobObjectBasicAccountingInformation,
            &mut basic as *mut _ as *mut core::ffi::c_void,
            mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
            core::ptr::null_mut(),
        )
    };
    if ret == 0 {
        return Err(format!(
            "QueryInformationJobObject(BasicAccounting) failed: {}",
            std::io::Error::last_os_error()
        ));
    }

    let mut extended: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { mem::zeroed() };
    // SAFETY: 同上（栈分配 + 查询类 API，无所有权转移）
    let ret = unsafe {
        QueryInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &mut extended as *mut _ as *mut core::ffi::c_void,
            mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            core::ptr::null_mut(),
        )
    };
    if ret == 0 {
        return Err(format!(
            "QueryInformationJobObject(ExtendedLimit) failed: {}",
            std::io::Error::last_os_error()
        ));
    }

    // FILETIME 100ns → 毫秒：除以 10_000；u64 转换取低 63 位（CPU 时间单调非负，
    // 符号位恒 0），saturating 防溢出
    let cpu_ms = (basic.TotalUserTime as u64).saturating_add(basic.TotalKernelTime as u64) / 10_000;
    let rss_bytes = extended.PeakJobMemoryUsed as u64;
    Ok(RawUsage { cpu_ms, rss_bytes })
}

/// Unix：`/proc/<pid>/stat`（utime+stime，sysconf(clk_tck) 换算毫秒）+ 主进程
/// rss（pages × 页大小）+ `getrusage(RUSAGE_CHILDREN)` 已回收子进程近似
/// （ru_utime+ru_stime 差值口径 + ru_maxrss 峰值）。
///
/// 诚实边界（方案 §8.3 1）：进程树累加退化为「主进程 + 已回收子进程」近似，
/// 未回收孙进程不计入——与 Windows Job 树聚合存在数值口径差异。
#[cfg(not(windows))]
#[allow(unsafe_code)] // POSIX libc FFI（sysconf / getrusage），参数为整数或栈指针，
                      // SAFETY 见函数内注释，经评审后允许
fn sample_unix(pid: u32) -> Result<RawUsage, String> {
    use core::mem;

    // /proc/<pid>/stat：字段 14=utime、15=stime（ticks）、24=rss（pages）。
    // comm 可能含空格/括号（进程名带空格），先取最后一个 ')' 再按空白拆段——
    // 段 0 = state（字段 3），故 utime = 段 11、stime = 段 12、rss = 段 21
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .map_err(|e| format!("读取 /proc/{pid}/stat 失败：{e}"))?;
    let close = stat
        .rfind(')')
        .ok_or_else(|| format!("stat 格式异常（缺 comm 收尾）：/proc/{pid}/stat"))?;
    let fields: Vec<&str> = stat[close + 1..].split_whitespace().collect();
    let utime: u64 = fields
        .get(11)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| "utime 字段解析失败".to_string())?;
    let stime: u64 = fields
        .get(12)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| "stime 字段解析失败".to_string())?;
    let rss_pages: u64 = fields
        .get(21)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| "rss 字段解析失败".to_string())?;

    // SAFETY: sysconf 为纯查询 API，参数为标准 POSIX 常量，无内存操作
    let clk_tck = unsafe { libc::sysconf(libc::_SC_CLK_TCK) } as u64;
    // SAFETY: 同上
    let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) } as u64;
    let cpu_ms = utime.saturating_add(stime).saturating_mul(1000) / clk_tck.max(1);

    // 已回收子进程近似（RUSAGE_CHILDREN）：累计值差值由采样循环按周期差值模型
    // 处理（本函数只读当前值）；ru_utime/ru_stime 为 timeval（秒+微秒）
    let mut usage: libc::rusage = unsafe { mem::zeroed() };
    // SAFETY: usage 为栈分配结构（libc::rusage 完整尺寸由 libc 保证），
    // getrusage 成功返回 0 并填充结构，失败（rc != 0）不写内容
    let rc = unsafe { libc::getrusage(libc::RUSAGE_CHILDREN, &mut usage) };
    let child_cpu_ms = if rc == 0 {
        let secs = usage.ru_utime.tv_sec.saturating_add(usage.ru_stime.tv_sec) as u64;
        let usecs = usage
            .ru_utime
            .tv_usec
            .saturating_add(usage.ru_stime.tv_usec) as u64;
        secs.saturating_mul(1000).saturating_add(usecs / 1000)
    } else {
        0
    };

    // rss = 主进程当前 pages × 页大小 + 已回收子进程峰值（ru_maxrss 单位 KB）
    let rss_bytes = rss_pages
        .saturating_mul(page_size.max(1))
        .saturating_add((usage.ru_maxrss.max(0) as u64).saturating_mul(1024));

    Ok(RawUsage {
        cpu_ms: cpu_ms.saturating_add(child_cpu_ms),
        rss_bytes,
    })
}

// ============================================================================
// 通知投递（T-AB-16：Suspicious / Crashed 双通道）
// ============================================================================

/// 任务域事件发射槽（T-AB-16 通道二；冻结契约 §4.5 的 payload 由调用方组装为
/// serde_json::Value，事件名 kebab-case）。
///
/// C2（T-AB-17）在 conex-types 落地 AgentEvent 七事件变体后，以信封构造
/// （AgentEventEnvelope）替换实现即可；本槽形状不依赖 C2 编译产物。
pub(crate) trait EventSink: Send + Sync + std::fmt::Debug {
    /// 发射一条任务域事件（event_type 与 payload 均按冻结契约 §4.5）
    fn emit(&self, event_type: &str, payload: serde_json::Value);
}

/// 默认发射实现：C2 落地前的结构化日志留痕——输出完整 payload JSON（字段按
/// 冻结契约 §4.5 组装），C2 落地后零改动替换为信封构造（payload 形状不变）。
#[derive(Debug)]
pub(crate) struct LogEventSink;

impl EventSink for LogEventSink {
    fn emit(&self, event_type: &str, payload: serde_json::Value) {
        tracing::info!(
            target: "background",
            event_type,
            payload = %payload,
            "任务域事件（C2 事件注册表落地前的留痕发射）"
        );
    }
}

/// 任务通知投递器（T-AB-16 双通道，Clone 共享）
///
/// - 通道一：nudge 排队（`PendingNudgeChannel::enqueue` 语义——排入下一条用户
///   消息边界，不打断当前 run）。诚实边界（登记偏差）：`PendingNudgeChannel`
///   实例在 orchestrator 的 `PendingMessageQueue` 内部，壳层无访问入口 →
///   生产路径 None（通知文本经 tracing 留痕），测试注入内存队列断言；
/// - 通道二：任务域事件发射（task-suspicious = Soft 分级 / task-failed =
///   Critical 分级，§4.5；30 方案 P2 补全七事件投递方法：started/output/
///   heartbeat/completed/killed，payload 按 conex-types events.rs 变体字段
///   组装，camelCase 由 serde 处理）。
///
/// 防抖（同任务保持期间仅一次，恢复 Healthy 重置）由采样循环负责，
/// 本投递器只做「检测后的投递」。
#[derive(Clone, Debug)]
pub(crate) struct TaskNotifier {
    /// nudge 文本队列（生产 None；测试注入）
    nudge_queue: Option<Arc<Mutex<VecDeque<String>>>>,
    /// 事件发射槽（生产默认 None → LogEventSink 留痕；测试注入内存收集器）
    event_sink: Option<Arc<dyn EventSink>>,
    /// 输出节流聚合器（task-output 高频事件 100ms 窗口合并；按任务 id 隔离
    /// 窗口，Arc 共享保证 Clone 语义）
    output_throttle: Arc<Mutex<OutputThrottle>>,
}

/// 输出节流窗口时长（毫秒）：task-output 高频聚合窗口（30 方案 P2）。
const OUTPUT_THROTTLE_WINDOW_MS: u64 = 100;

/// 单任务输出节流窗口状态（100ms 聚合：窗口内只记最后一行与最新累计行数，
/// 窗口边界发一条 task-output）
#[derive(Debug, Clone)]
struct OutputWindow {
    /// 窗口起点（epoch 毫秒）
    window_start_ms: u64,
    /// 窗口内最后一行（聚合内容）
    last_line: String,
    /// 窗口内最新累计行数
    line_count: u64,
    /// 已发射的累计行数（去重：窗口内容已发射则不再重复发）
    last_emitted_count: u64,
}

/// 输出节流聚合器：按任务 id 隔离窗口（TaskNotifier 为注册表级共享实例，
/// 多任务并发时互不串扰）；窗口时长可注入（测试用短窗口确定性断言）。
#[derive(Debug)]
struct OutputThrottle {
    /// 窗口时长（毫秒；生产 100ms，测试可注入短窗口）
    window_ms: u64,
    /// 各任务当前窗口（task_id → 窗口状态）
    windows: HashMap<String, OutputWindow>,
}

impl Default for OutputThrottle {
    fn default() -> Self {
        Self {
            window_ms: OUTPUT_THROTTLE_WINDOW_MS,
            windows: HashMap::new(),
        }
    }
}

impl Default for TaskNotifier {
    fn default() -> Self {
        Self {
            nudge_queue: None,
            event_sink: None,
            output_throttle: Arc::new(Mutex::new(OutputThrottle::default())),
        }
    }
}

impl TaskNotifier {
    /// 未接线构造（生产默认：双通道均以 tracing 留痕兜底）
    pub(crate) fn unwired() -> Self {
        Self::default()
    }

    /// 注入 nudge 队列（测试用：断言通知文本收到与去重）
    #[cfg_attr(not(test), allow(dead_code))] // 测试专用构造（生产走 unwired + set_event_sink）
    pub(crate) fn with_nudge_queue(queue: Arc<Mutex<VecDeque<String>>>) -> Self {
        Self {
            nudge_queue: Some(queue),
            event_sink: None,
            ..Default::default()
        }
    }

    /// 注入事件发射槽（测试用：断言事件类型与 payload 形状）
    #[allow(dead_code)] // 测试专用构造（生产走 set_event_sink）；测试构建同样未用故普通 allow
    pub(crate) fn with_event_sink(sink: Arc<dyn EventSink>) -> Self {
        Self {
            nudge_queue: None,
            event_sink: Some(sink),
            ..Default::default()
        }
    }

    /// 注入节流窗口时长（测试用：短窗口确定性断言输出聚合；其余字段默认）
    #[cfg_attr(not(test), allow(dead_code))] // 测试专用构造（生产走 unwired + set_event_sink）
    pub(crate) fn with_output_window_ms(window_ms: u64) -> Self {
        Self {
            output_throttle: Arc::new(Mutex::new(OutputThrottle {
                window_ms,
                windows: HashMap::new(),
            })),
            ..Default::default()
        }
    }

    /// 接线事件发射槽（生产路径：main.rs 装配轮经
    /// background.rs `set_event_bridge` 注入 EventBridgeSink——30 方案
    /// P2/P3 接线后本方法生产可达，E2 核销）
    pub(crate) fn set_event_sink(&mut self, sink: Arc<dyn EventSink>) {
        self.event_sink = Some(sink);
    }

    /// Suspicious 通知投递（T-AB-16 2）：「任务 <id> 疑似卡死（<M> 秒无输出），
    /// 请确认是否终止」——文案注明「由 AI 裁决，系统不自动终止」（T-AB-16 5
    /// 误报面控制：编译类命令长时间无输出属正常，AI 见通知自行判断）。
    /// 通道一 nudge 排队；通道二发射 task-suspicious 事件（Soft 分级，
    /// payload：taskId / silenceMs / lastOutputAtMs，§4.5）。
    pub(crate) fn notify_suspicious(&self, task_id: &str, silence_ms: u64, last_output_at_ms: u64) {
        let text = format!(
            "任务 {task_id} 疑似卡死（{} 秒无输出），请确认是否终止（由 AI 裁决，系统不自动终止）",
            silence_ms / 1000
        );
        self.push_nudge(text);
        self.emit_event(
            "task-suspicious",
            serde_json::json!({
                "taskId": task_id,
                "silenceMs": silence_ms,
                "lastOutputAtMs": last_output_at_ms,
            }),
        );
    }

    /// Crashed 通知投递（T-AB-16 3）：非零退出 →「任务 <id> 异常退出
    /// （exit code N），附最后 20 行日志」（尾部日志由调用方复用
    /// read_log(None, 20) 语义组装）。文案注明「由 AI 裁决，系统不自动终止」。
    /// 通道一 nudge 排队；通道二发射 task-failed 事件（Critical 分级，
    /// payload：taskId / exitCode / tail / durationMs，§4.5）。
    pub(crate) fn notify_failed(
        &self,
        task_id: &str,
        exit_code: i32,
        tail: &str,
        duration_ms: u64,
    ) {
        let text = format!(
            "任务 {task_id} 异常退出（exit code {exit_code}），附最后 20 行日志（由 AI 裁决，系统不自动终止）：\n{tail}"
        );
        self.push_nudge(text);
        self.emit_event(
            "task-failed",
            serde_json::json!({
                "taskId": task_id,
                "exitCode": exit_code,
                "tail": tail,
                "durationMs": duration_ms,
            }),
        );
    }

    // ── T-AB-17 七事件补全投递（30 方案 P2：payload 按 conex-types events.rs
    //    变体字段组装，camelCase 由 serde 处理）──

    /// 任务启动投递（adopt 成功即发；Critical 必达）。payload 对齐
    /// TaskStarted 变体：taskId/command/cwd/ownerRunId/isDaemon（无
    /// pid/started_at_ms 字段，以 command/cwd/owner_run_id/is_daemon 为准）。
    pub(crate) fn notify_started(
        &self,
        task_id: &str,
        command: &str,
        cwd: &str,
        owner_run_id: &str,
        is_daemon: bool,
    ) {
        self.emit_event(
            "task-started",
            serde_json::json!({
                "taskId": task_id,
                "command": command,
                "cwd": cwd,
                "ownerRunId": owner_run_id,
                "isDaemon": is_daemon,
            }),
        );
    }

    /// 任务输出投递（Delta 可丢；100ms 节流窗口聚合——窗口内只记
    /// last_line/line_count，窗口边界发一条；终态通知前冲刷窗口）。
    pub(crate) fn notify_output(&self, task_id: &str, line: &str, line_count: u64) {
        let now = now_millis() as u64;
        let mut throttle = self
            .output_throttle
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        // 窗口时长先取副本（entry 可变借用与 throttle 字段读冲突，且锁内
        // 时长不变——测试注入窗口也发生在构造期）
        let window_ms = throttle.window_ms;
        let entry = throttle
            .windows
            .entry(task_id.to_string())
            .or_insert_with(|| OutputWindow {
                window_start_ms: now,
                last_line: String::new(),
                line_count: 0,
                last_emitted_count: 0,
            });
        entry.last_line = line.to_string();
        entry.line_count = line_count;
        // 窗口边界：距窗口起点 ≥ 窗口时长且存在未发射内容 → 聚合发一条
        let window_elapsed = now.saturating_sub(entry.window_start_ms) >= window_ms;
        if window_elapsed && entry.line_count > entry.last_emitted_count {
            entry.window_start_ms = now;
            entry.last_emitted_count = entry.line_count;
            let last_line = entry.last_line.clone();
            let line_count = entry.line_count;
            drop(throttle);
            self.emit_event(
                "task-output",
                serde_json::json!({
                    "taskId": task_id,
                    "line": last_line,
                    "lineCount": line_count,
                }),
            );
        }
    }

    /// 任务资源心跳投递（Delta 可丢；仅启用 resourceMonitor 的任务由采样
    /// 循环发射；resource 摘要为采样端组装的结构化 JSON）
    pub(crate) fn notify_heartbeat(&self, task_id: &str, resource: serde_json::Value) {
        self.emit_event(
            "task-heartbeat",
            serde_json::json!({
                "taskId": task_id,
                "resource": resource,
            }),
        );
    }

    /// 任务自然退出成功投递（Critical 必达；发送前冲刷输出节流窗口，
    /// 保证窗口内最后一行输出不丢失）
    pub(crate) fn notify_completed(
        &self,
        task_id: &str,
        exit_code: i32,
        duration_ms: u64,
        line_count: u64,
    ) {
        self.flush_output(task_id);
        self.emit_event(
            "task-completed",
            serde_json::json!({
                "taskId": task_id,
                "exitCode": exit_code,
                "durationMs": duration_ms,
                "lineCount": line_count,
            }),
        );
    }

    /// 任务被终止投递（Critical 必达；via_force=两阶段升级，diagnostics 为
    /// kill 两阶段留痕，无留痕时 None）；发送前冲刷输出节流窗口。
    pub(crate) fn notify_killed(
        &self,
        task_id: &str,
        via_force: bool,
        diagnostics: Option<String>,
    ) {
        self.flush_output(task_id);
        self.emit_event(
            "task-killed",
            serde_json::json!({
                "taskId": task_id,
                "viaForce": via_force,
                "diagnostics": diagnostics,
            }),
        );
    }

    /// 冲刷输出节流窗口：窗口内存在未发射内容（累计行数大于已发射数）时
    /// 补发一条聚合输出（终态通知前调用，窗口未闭合的最后一行不丢失；
    /// 已发射则幂等跳过，不重复发射）。
    fn flush_output(&self, task_id: &str) {
        let mut throttle = self
            .output_throttle
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let Some(entry) = throttle.windows.get_mut(task_id) else {
            return;
        };
        if entry.line_count <= entry.last_emitted_count {
            return;
        }
        entry.last_emitted_count = entry.line_count;
        let last_line = entry.last_line.clone();
        let line_count = entry.line_count;
        drop(throttle);
        self.emit_event(
            "task-output",
            serde_json::json!({
                "taskId": task_id,
                "line": last_line,
                "lineCount": line_count,
            }),
        );
    }

    /// 通道一：nudge 文本排队（无队列实例 → tracing warn 留痕，不丢失信息面）
    fn push_nudge(&self, text: String) {
        match &self.nudge_queue {
            Some(queue) => {
                queue
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .push_back(text);
            }
            None => tracing::warn!(
                target: "background",
                text = %text,
                "任务通知降级留痕——nudge 通道已删（决策 9），跨 run 注入走 PendingMessageQueue"
            ),
        }
    }

    /// 通道二：事件发射（无注入槽 → 默认 LogEventSink 结构化留痕）
    fn emit_event(&self, event_type: &str, payload: serde_json::Value) {
        match &self.event_sink {
            Some(sink) => sink.emit(event_type, payload),
            None => LogEventSink.emit(event_type, payload),
        }
    }
}

// ============================================================================
// 单元测试（判定矩阵 + 差值语义 + 通知形状）
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// 三态判定矩阵（T-AB-16 1）：
    /// - CPU 活跃 → Healthy（即使长时间无输出）；
    /// - 最近 M 秒内有输出 → Healthy（即使 CPU 近零）；
    /// - CPU 近零 + 超过 M 秒无输出 → Suspicious。
    #[test]
    fn judge_health_matrix() {
        let config = ResourceMonitorConfig {
            sample_interval_ms: 2000,
            silence_threshold_ms: 60_000,
        };
        let now = 1_000_000;
        // CPU 活跃（50%）+ 120s 无输出 → Healthy（编译类长静默任务不误报）
        assert_eq!(
            judge_health(now, now - 120_000, 50.0, &config),
            ProcessHealth::Healthy
        );
        // CPU 近零 + 最近 30s 有输出 → Healthy
        assert_eq!(
            judge_health(now, now - 30_000, 0.0, &config),
            ProcessHealth::Healthy
        );
        // CPU 近零 + 超过 60s 无输出 → Suspicious
        assert_eq!(
            judge_health(now, now - 120_000, 0.0, &config),
            ProcessHealth::Suspicious
        );
        // 阈值边界：恰在静默阈值内（60s）→ 仍 Healthy
        assert_eq!(
            judge_health(now, now - 60_000, 0.0, &config),
            ProcessHealth::Healthy
        );
        // 阈值边界外 1ms → Suspicious
        assert_eq!(
            judge_health(now, now - 60_001, 0.0, &config),
            ProcessHealth::Suspicious
        );
    }

    /// CPU% 差值语义（T-AB-15 3 首采样丢弃的数值保证）：
    /// - 零差值（同基线）→ 0.0 而非 NaN；
    /// - 墙钟零差值 → 0.0（不除零）；
    /// - 正常差值 → [0, 100] 区间；
    /// - 差值回退（非单调防御）→ clamp 0。
    #[test]
    fn cpu_percent_delta_is_finite_and_bounded() {
        let prev = RawUsage {
            cpu_ms: 1000,
            rss_bytes: 4096,
        };
        // 零差值：不产生 NaN/异常值（首采样无基线时循环直接丢弃，本函数保证
        // 即使被误调也不出非有限值）
        let same = RawUsage {
            cpu_ms: 1000,
            rss_bytes: 4096,
        };
        assert_eq!(cpu_percent_from_delta(&prev, &same, 1000, 3000), 0.0);
        // 墙钟零差值：不除零
        assert_eq!(cpu_percent_from_delta(&prev, &same, 3000, 3000), 0.0);
        // 正常：2s 窗口内 500ms CPU → 25%
        let busy = RawUsage {
            cpu_ms: 1500,
            rss_bytes: 4096,
        };
        assert_eq!(cpu_percent_from_delta(&prev, &busy, 1000, 3000), 25.0);
        // 差值回退（时钟异常）：clamp 下限 0
        let lower = RawUsage {
            cpu_ms: 800,
            rss_bytes: 4096,
        };
        assert_eq!(cpu_percent_from_delta(&prev, &lower, 1000, 3000), 0.0);
    }

    /// 通知投递形状（T-AB-16 2/3）：nudge 文本含任务 id、文案关键点与
    /// 「由 AI 裁决」声明；事件 payload 字段与冻结契约 §4.5 一致
    /// （task-suspicious：taskId/silenceMs/lastOutputAtMs；
    /// task-failed：taskId/exitCode/tail/durationMs）。
    #[test]
    fn notifier_message_and_payload_shape() {
        let queue = Arc::new(Mutex::new(VecDeque::new()));
        let emitted = Arc::new(Mutex::new(Vec::new()));
        struct MemSink(Arc<Mutex<Vec<(String, serde_json::Value)>>>);
        impl std::fmt::Debug for MemSink {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "MemSink")
            }
        }
        impl EventSink for MemSink {
            fn emit(&self, event_type: &str, payload: serde_json::Value) {
                self.0
                    .lock()
                    .unwrap()
                    .push((event_type.to_string(), payload));
            }
        }
        let notifier = TaskNotifier {
            nudge_queue: Some(queue.clone()),
            event_sink: Some(Arc::new(MemSink(emitted.clone()))),
            ..Default::default()
        };

        notifier.notify_suspicious("task-7", 60_000, 1234);
        {
            let q = queue.lock().unwrap();
            assert_eq!(q.len(), 1);
            let text = &q[0];
            assert!(text.contains("task-7"), "通知含任务 id：{text}");
            assert!(text.contains("疑似卡死"), "文案含疑似卡死：{text}");
            assert!(text.contains("60 秒无输出"), "文案含静默时长：{text}");
            assert!(text.contains("由 AI 裁决"), "文案注明 AI 裁决：{text}");
            assert!(text.contains("不自动终止"), "文案注明不自动终止：{text}");
        }
        {
            let events = emitted.lock().unwrap();
            assert_eq!(events.len(), 1);
            assert_eq!(events[0].0, "task-suspicious");
            let payload = &events[0].1;
            assert_eq!(payload["taskId"], "task-7");
            assert_eq!(payload["silenceMs"], 60_000);
            assert_eq!(payload["lastOutputAtMs"], 1234);
        }

        notifier.notify_failed("task-8", 7, "line1\nline2", 999);
        {
            let q = queue.lock().unwrap();
            assert_eq!(q.len(), 2, "第二次通知追加（防抖由采样循环负责）");
            assert!(q[1].contains("task-8") && q[1].contains("exit code 7"));
        }
        {
            let events = emitted.lock().unwrap();
            assert_eq!(events.len(), 2);
            assert_eq!(events[1].0, "task-failed");
            assert_eq!(events[1].1["exitCode"], 7);
            assert_eq!(events[1].1["tail"], "line1\nline2");
            assert_eq!(events[1].1["durationMs"], 999);
        }
    }

    /// 五新投递方法载荷断言（30 方案 P2）：started/output/heartbeat/completed/
    /// killed 的 payload 与 conex-types events.rs 变体字段逐一对齐
    /// （taskId/command/cwd/ownerRunId/isDaemon；taskId/line/lineCount；
    /// taskId/resource；taskId/exitCode/durationMs/lineCount；
    /// taskId/viaForce/diagnostics）。
    #[test]
    fn notifier_five_new_methods_payloads() {
        struct MemSink(Arc<Mutex<Vec<(String, serde_json::Value)>>>);
        impl std::fmt::Debug for MemSink {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "MemSink")
            }
        }
        impl EventSink for MemSink {
            fn emit(&self, event_type: &str, payload: serde_json::Value) {
                self.0
                    .lock()
                    .unwrap()
                    .push((event_type.to_string(), payload));
            }
        }
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let notifier = TaskNotifier {
            event_sink: Some(Arc::new(MemSink(Arc::clone(&emitted)))),
            ..Default::default()
        };

        notifier.notify_started("task-1", "npm install", "C:/work", "run-9", true);
        // 同一节流窗口内两条输出 → 窗口未闭合不发射（合并断言见节流用例）
        notifier.notify_output("task-1", "line-a", 1);
        notifier.notify_output("task-1", "line-b", 2);
        // 完成投递前冲刷窗口：补发聚合 output（窗口内最后一行 + 最新行数）
        notifier.notify_completed("task-1", 0, 1234, 2);
        notifier.notify_heartbeat("task-1", serde_json::json!({ "cpuPercent": 5.0 }));
        notifier.notify_killed("task-2", true, Some("强制终止升级".to_string()));

        let events = emitted.lock().unwrap();
        // 序号：started(0) / output-flush(1) / completed(2) / heartbeat(3) / killed(4)
        assert_eq!(
            events.len(),
            5,
            "五方法应各发射一条（输出窗口在完成时冲刷）"
        );
        // started：taskId/command/cwd/ownerRunId/isDaemon
        assert_eq!(events[0].0, "task-started");
        let p = &events[0].1;
        assert_eq!(p["taskId"], "task-1");
        assert_eq!(p["command"], "npm install");
        assert_eq!(p["cwd"], "C:/work");
        assert_eq!(p["ownerRunId"], "run-9");
        assert_eq!(p["isDaemon"], true);
        // output（冲刷）：聚合内容 = 窗口内最后一行 + 最新累计行数
        assert_eq!(events[1].0, "task-output");
        let p = &events[1].1;
        assert_eq!(p["taskId"], "task-1");
        assert_eq!(p["line"], "line-b");
        assert_eq!(p["lineCount"], 2);
        // completed：taskId/exitCode/durationMs/lineCount
        assert_eq!(events[2].0, "task-completed");
        let p = &events[2].1;
        assert_eq!(p["taskId"], "task-1");
        assert_eq!(p["exitCode"], 0);
        assert_eq!(p["durationMs"], 1234);
        assert_eq!(p["lineCount"], 2);
        // heartbeat：taskId/resource（资源摘要原样透传）
        assert_eq!(events[3].0, "task-heartbeat");
        let p = &events[3].1;
        assert_eq!(p["taskId"], "task-1");
        assert_eq!(p["resource"]["cpuPercent"], 5.0);
        // killed：taskId/viaForce/diagnostics
        assert_eq!(events[4].0, "task-killed");
        let p = &events[4].1;
        assert_eq!(p["taskId"], "task-2");
        assert_eq!(p["viaForce"], true);
        assert_eq!(p["diagnostics"], "强制终止升级");
    }

    /// 输出节流断言（30 方案 P2）：注入短窗口（30ms）——窗口内多条输出合并
    /// 为一条（条数与聚合内容）；窗口边界发一条；已发射内容不重复。
    #[test]
    fn task_output_throttled_window() {
        struct MemSink(Arc<Mutex<Vec<(String, serde_json::Value)>>>);
        impl std::fmt::Debug for MemSink {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "MemSink")
            }
        }
        impl EventSink for MemSink {
            fn emit(&self, event_type: &str, payload: serde_json::Value) {
                self.0
                    .lock()
                    .unwrap()
                    .push((event_type.to_string(), payload));
            }
        }
        let emitted = Arc::new(Mutex::new(Vec::new()));
        // 注入 30ms 短窗口（生产默认 100ms）+ 内存事件收集器
        let mut notifier = TaskNotifier::with_output_window_ms(30);
        notifier.set_event_sink(Arc::new(MemSink(Arc::clone(&emitted))));

        // 窗口内两条输出：合并不发射（条数 0）
        notifier.notify_output("task-9", "line-1", 1);
        notifier.notify_output("task-9", "line-2", 2);
        assert_eq!(
            emitted.lock().unwrap().len(),
            0,
            "窗口内输出必须合并（不逐条发射）"
        );

        // 窗口边界：超过 30ms 后再次输出 → 聚合发一条（内容 = 最后一行）
        std::thread::sleep(std::time::Duration::from_millis(40));
        notifier.notify_output("task-9", "line-3", 3);
        {
            let events = emitted.lock().unwrap();
            assert_eq!(events.len(), 1, "窗口边界应恰发一条聚合输出");
            assert_eq!(events[0].0, "task-output");
            assert_eq!(events[0].1["line"], "line-3", "聚合内容 = 窗口内最后一行");
            assert_eq!(events[0].1["lineCount"], 3, "聚合行数 = 最新累计行数");
        }

        // 新窗口内一条输出（未到边界）后立即完成：终态冲刷补发窗口内
        // 最后一行（line-4），再发 completed——窗口未闭合内容不丢失
        notifier.notify_output("task-9", "line-4", 4);
        notifier.notify_completed("task-9", 0, 999, 4);
        {
            let events = emitted.lock().unwrap();
            assert_eq!(events.len(), 3, "冲刷补发 + completed 共 2 条新事件");
            assert_eq!(events[1].0, "task-output", "冲刷补发的是聚合输出");
            assert_eq!(events[1].1["line"], "line-4", "补发内容 = 窗口内最后一行");
            assert_eq!(events[1].1["lineCount"], 4);
            assert_eq!(events[2].0, "task-completed");
        }
        // 再次完成（无新输出内容）：flush 幂等——不再补发 task-output，
        // 仅新增一条 task-completed（事件非幂等由调用方保证单次）
        notifier.notify_completed("task-9", 0, 999, 4);
        {
            let events = emitted.lock().unwrap();
            assert_eq!(events.len(), 4, "第二次完成只发 completed");
            assert_eq!(events[3].0, "task-completed");
            assert_eq!(
                events.iter().filter(|e| e.0 == "task-output").count(),
                2,
                "flush 幂等：已发射输出不得重复补发"
            );
        }

        // 任务隔离：另一任务窗口互不串扰（新窗口首条输出未到边界不发射）
        notifier.notify_output("task-10", "other-line", 1);
        {
            let events = emitted.lock().unwrap();
            assert_eq!(events.len(), 4, "其他任务输出不得发射（按任务隔离）");
            assert_eq!(
                events.iter().filter(|e| e.0 == "task-output").count(),
                2,
                "task-10 首条输出未到边界，不得进入发射流"
            );
        }
    }
}
