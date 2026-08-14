//! SR-05 · 拆分 · ≠ EL · 域：事件发射与资源采样（EventBridgeSink + emit +
//! spawn_resource_monitor_loop + SamplerFn/SuspiciousDebounce 注入面）。
//! 结构拆分轮仅搬移，七事件发射与健康判定语义零改动。接线：background.rs
//! `mod bg_events;`。

use crate::core_event_bridge::EventBridge;
use crate::process::now_millis;
use crate::resource::{
    cpu_percent_from_delta, judge_health, EventSink, ProcessHealth, RawUsage,
    ResourceMonitorConfig, TaskNotifier,
};
use agent_tools::background::{BackgroundTaskInfo, ResourceSample};
use conex_types::events::{AgentEvent, AgentEventEnvelope};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tokio::task::JoinHandle;

use super::bg_registry::BackgroundTaskRegistry;

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

// ── 资源采样循环（T-AB-15 3 / T-AB-16 1/2）──────────────────────────────────

/// 事件发射到 `workbench-run-event` 通道的接线实现（T-AB-16 通道二生产路径；
/// 由 [BackgroundTaskRegistry::set_event_bridge] 注入——main.rs 装配轮接线，
/// 30 方案 P2/P3 后生产构造点存在，E4 核销）。
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
pub(crate) struct EventBridgeSink {
    /// 事件桥（Tauri 通道 / 测试替身，Clone 共享）
    pub(crate) bridge: EventBridge,
    /// 事件体 session_id（注册表注入；占位见上）
    pub(crate) session_id: String,
    /// 30 方案 P3：任务事件消费器（set_event_bridge 构造时读取注册表
    /// 快照；None = 未接线——事件照常发射，仅不做消费面接线）
    pub(crate) consumer: Option<Arc<crate::task_event_consumer::TaskEventConsumer>>,
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
        // 由 serde rename_all 处理，此处为 Rust 字段名）。七事件全臂
        // （30 方案 P2）：task-started/output/heartbeat/suspicious/completed/
        // failed/killed；未知类型 warn 兜底（防静默丢弃）。
        let event = match event_type {
            "task-started" => AgentEvent::TaskStarted {
                session_id: self.session_id.clone(),
                task_id: payload
                    .get("taskId")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                command: payload
                    .get("command")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                cwd: payload
                    .get("cwd")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                owner_run_id: payload
                    .get("ownerRunId")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                is_daemon: payload
                    .get("isDaemon")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
            },
            "task-output" => AgentEvent::TaskOutput {
                session_id: self.session_id.clone(),
                task_id: payload
                    .get("taskId")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                // 节流聚合单行：line 承载最后一行，chunk 不占位
                line: payload
                    .get("line")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
                chunk: None,
                line_count: payload.get("lineCount").and_then(serde_json::Value::as_u64),
            },
            "task-heartbeat" => AgentEvent::TaskHeartbeat {
                session_id: self.session_id.clone(),
                task_id: payload
                    .get("taskId")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                resource: payload
                    .get("resource")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            },
            "task-suspicious" => AgentEvent::TaskSuspicious {
                session_id: self.session_id.clone(),
                task_id: payload
                    .get("taskId")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                silence_ms: payload
                    .get("silenceMs")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0),
                last_output_at_ms: payload
                    .get("lastOutputAtMs")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0),
            },
            "task-completed" => AgentEvent::TaskCompleted {
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
                duration_ms: payload
                    .get("durationMs")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0),
                line_count: payload
                    .get("lineCount")
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
            "task-killed" => AgentEvent::TaskKilled {
                session_id: self.session_id.clone(),
                task_id: payload
                    .get("taskId")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                via_force: payload
                    .get("viaForce")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
                diagnostics: payload
                    .get("diagnostics")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
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
        // 30 方案 P3：任务事件消费面（task_events.rs 接线）——终态即入队
        // + security-audit 直发（域隔离不经 engine audit_sink）；消费器为
        // None（未注入）时仅发射事件，不消费
        if let Some(consumer) = &self.consumer {
            consumer.on_task_event(&event);
        }
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
pub(crate) fn spawn_resource_monitor_loop(
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
            // T-AB-17 七事件发射点三：有效采样拍发 task-heartbeat（Delta 可丢；
            // resource 摘要 = ResourceSample camelCase 序列化）
            if let Ok(resource_json) = serde_json::to_value(&sample) {
                notifier.notify_heartbeat(&task_id, resource_json);
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
            let health = judge_health(now, last_output_at_ms, cpu_percent, &config);
            // 14-T2a wire（suspicious 轮询可达）：健康判定值拆出写
            // info.suspicious——Healthy → 置 false；Suspicious 首次（防抖放行）
            // → 置 true；保持期/Crashed 不写；终态保留最后一次写值（历史标记
            // 语义，前端轮询经 list 快照渲染「疑似卡死」，34 方案 §2.3）
            if let ProcessHealth::Healthy = health {
                if let Ok(mut guard) = info.write() {
                    guard.suspicious = false;
                }
            }
            if debounce.observe(health) {
                if let Ok(mut guard) = info.write() {
                    guard.suspicious = true;
                }
                notifier.notify_suspicious(
                    &task_id,
                    config.silence_threshold_ms,
                    last_output_at_ms,
                );
            }
        }
    })
}
