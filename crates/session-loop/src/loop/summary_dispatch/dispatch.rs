//! run 级摘要后台调度器 [SummaryDispatch]（单飞 spawn + 窗口护栏）、任务/结果类型
//! 与 summary-background 事件出口。

use std::sync::{Arc, Mutex};

use crate::safe_point::AbortSignal;
use conex_compaction::{recovery::SummaryState, Summarizer};
use conex_types::events::AgentEvent;
use conex_types::message::AgentMessage;

use super::run::run_summary_task_with_abort;
use super::{SummaryDispatchConfig, SummaryRetryGate, SummaryRetryGuardConfig};

/// 摘要任务完成结果（V1 经回调透传给壳层；轮次 6 落 compression_blocks 表）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SummaryDispatchOutcome {
    /// 会话 id（块表复合主键 (session_id, block_id) 的一半）
    pub session_id: String,
    /// 块 id（R-B：`compacted-summary-{gen}-{fold}`，与链内消息 id 同名）
    pub block_id: String,
    /// 压缩代数（R-K 单源：SessionContextMeta.last_compaction_generation）
    pub generation: u32,
    /// 成功：Schema V1 JSON 规范文档（写表 summary_json）
    pub summary_json: Option<String>,
    /// 成功：确定性 md 渲染（链文本形态，R-G 语源与文档同源）
    pub rendered_markdown: Option<String>,
    /// 终态：committed（成功）| awaiting（episode 耗尽，低功耗待重试——
    /// **非 retired 永驻**，E2 F2 层 1；块保持 awaiting，被动触发点重新
    /// 触发，窗口护栏 [SummaryRetryGate] 约束累计成本）
    pub state: SummaryState,
    /// 累计尝试次数（含同步那次；00-plan §6.4 口径）
    pub attempts: u32,
}

/// 后台任务上下文（tokio::spawn 独占；不引用 LoopState，run 收口不摧毁）
pub struct SummaryDispatchTask {
    /// 会话 id（回调上报用）
    pub session_id: String,
    /// 块 id（R-B）
    pub block_id: String,
    /// 压缩代数（R-K 单源）
    pub generation: u32,
    /// 丢弃消息（与同步尝试同源——调度器失败后重试同一批）
    pub dropped: Vec<AgentMessage>,
    /// 既有摘要文本（链尾 stub / md 渲染；与同步尝试同源）
    pub existing: Option<String>,
    /// 摘要字节预算（max_summary_tokens × 4，对齐引擎字节预算口径）
    pub max_bytes: usize,
    /// 摘要器（Arc 共享；调用隔离由 trait 边界保证，I4）
    pub summarizer: Arc<dyn Summarizer>,
}

/// 摘要任务完成回调（V1 注入面：壳层 / 轮次 6 对接 compression_blocks
/// 表写入与事件 details 标记；None = 只落日志，stub awaiting 永驻）
pub type SummaryOutcomeCallback = Box<dyn FnOnce(SummaryDispatchOutcome) + Send>;

/// summary-background 事件出口（EV-06 观测面；仿
/// `agent_tools::audit::SecurityAuditSink` 先例）。
///
/// 后台摘要任务生命周期（spawn/重试/成功/失败/放弃）经本 sink 发射
/// `AgentEvent::SummaryBackground`（Delta 级可丢、NoPersist——可追溯性不
/// 阻塞主链；变体定义见 conex-types/events.rs）。None = 不发射（行为与
/// 现状一致）。sink 实现不得 panic / 不得阻塞（观测面失败不应拖垮后台
/// 摘要任务）。
pub trait SummaryBackgroundSink: Send + Sync {
    /// 发射一条摘要后台生命周期事件
    fn emit(&self, event: &AgentEvent);
}

/// summary-background 事件发射器别名（Arc 共享；与 AuditSink 形态对齐）
pub type SummaryBackgroundSinkRef = Arc<dyn SummaryBackgroundSink>;

/// 构造并发射 `summary-background` 事件（sink 为 None 时静默，零行为变化；
/// phase 取值对齐契约：spawned | attempt | success | failure | give-up）
pub(crate) fn emit_summary_background(
    sink: &Option<SummaryBackgroundSinkRef>,
    session_id: &str,
    phase: &str,
    attempt: u32,
    reason: Option<String>,
    message_id: Option<String>,
) {
    if let Some(sink) = sink {
        sink.emit(&AgentEvent::SummaryBackground {
            session_id: session_id.to_string(),
            timestamp: conex_shared::time::now_iso_utc(),
            phase: phase.to_string(),
            attempt,
            reason,
            message_id,
        });
    }
}

/// 摘要后台调度器（run 内单飞面；跨 run 会话级容器由轮次 6 壳层承接）
pub struct SummaryDispatch {
    /// 存活任务句柄（单飞去重面；完成后可再 spawn）
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// 退避 / 墙钟 / 尝试上限配置
    config: SummaryDispatchConfig,
    /// summary-background 事件发射器（EV-06 观测面；None = 不发射）
    background_sink: Mutex<Option<SummaryBackgroundSinkRef>>,
    /// 低功耗尝试护栏（E2 F2 层 1）：跨 episode 累计尝试 + 观察窗口重置。
    /// Arc<Mutex> 形态——spawn 出的任务在收尾回调里记账（run_summary_task
    /// 是独立任务，需共享句柄）。**生产主路径（会话级 coordinator）的
    /// 护栏接线由壳层批次在 SessionSummaryCoordinator 侧装配**
    /// （summary_coordinator.rs，07 §5.4 文件域；本结构为 run 级兜底面）。
    retry_gate: Arc<Mutex<SummaryRetryGate>>,
    /// 关联的 abort 信号（SL-PERF-04：用于支持长耗时阻塞摘要及时响应取消）
    abort_signal: Arc<Mutex<Option<Arc<AbortSignal>>>>,
}

impl SummaryDispatch {
    pub fn new(config: SummaryDispatchConfig) -> Self {
        Self {
            task: Mutex::new(None),
            config,
            background_sink: Mutex::new(None),
            retry_gate: Arc::new(Mutex::new(SummaryRetryGate::new(
                SummaryRetryGuardConfig::default(),
            ))),
            abort_signal: Arc::new(Mutex::new(None)),
        }
    }

    /// 装配 abort 信号（SL-PERF-04）
    pub fn set_abort_signal(&self, signal: Option<Arc<AbortSignal>>) {
        *self.abort_signal.lock().unwrap_or_else(|e| {
            tracing::error!(target: "session_loop", "summary abort_signal 锁中毒：{e}");
            e.into_inner()
        }) = signal;
    }

    /// 当前 abort 信号快照
    pub fn abort_signal(&self) -> Option<Arc<AbortSignal>> {
        self.abort_signal
            .lock()
            .unwrap_or_else(|e| {
                tracing::error!(target: "session_loop", "summary abort_signal 锁中毒：{e}");
                e.into_inner()
            })
            .clone()
    }

    /// 装配 summary-background 事件发射器（EV-06 观测面；None = 不发射，
    /// 行为与现状一致。壳层接线：会话级协调器经
    /// [SessionSummaryCoordinatorRegistry::set_background_sink] 装配，run
    /// 级兜底调度器经本方法装配）
    pub fn set_background_sink(&self, sink: Option<SummaryBackgroundSinkRef>) {
        *self
            .background_sink
            .lock()
            .unwrap_or_else(|e| {
                tracing::error!(target: "session_loop", "summary background_sink 锁中毒，按恢复模式继续：{e}");
                e.into_inner()
            }) = sink;
    }

    /// 当前事件发射器快照（None = 未装配，不发射）
    fn background_sink(&self) -> Option<SummaryBackgroundSinkRef> {
        self.background_sink
            .lock()
            .unwrap_or_else(|e| {
                tracing::error!(target: "session_loop", "summary background_sink 锁中毒，按恢复模式继续：{e}");
                e.into_inner()
            })
            .clone()
    }

    /// 装配低功耗护栏配置（E2 F2 层 1；loop/mod.rs `with_options` 消费
    /// `SessionLoopOptions::compact_summary_max_attempts` /
    /// `compact_summary_retry_window_ms` 两新键注入）。F3 用户消息边界
    /// 被动触发点同样经本方法持有同一护栏实例（run 级面）。
    pub fn set_retry_guard(&self, config: SummaryRetryGuardConfig) {
        *self.retry_gate.lock().unwrap_or_else(|e| {
            tracing::error!(target: "session_loop", "summary retry_gate 锁中毒，按恢复模式继续：{e}");
            e.into_inner()
        }) = SummaryRetryGate::new(config);
    }

    /// 单飞 spawn：存活任务存在 → 忽略新 spawn（返回 false）；否则启动
    /// 后台任务并登记句柄（返回 true）。调用方负责在 Summarizer 注入
    /// 存在时才构造任务（apply_compaction 只在 `summarizer.is_some()`
    /// 且产出 stub 时调用本方法）。
    ///
    /// E2 F2 层 1 低功耗护栏（顺序：单飞去重 → 窗口护栏）：窗口内累计
    /// 尝试达上限 → 拒绝本次触发（返回 false，不 spawn——护栏日志记录
    /// 通知面，不进对话；窗口过期重置后可再试）。任务收尾时把本次
    /// episode 的尝试次数记入窗口（经 [SummaryRetryGate::record_episode]）。
    ///
    /// `on_done`：完成回调（V1 壳层可经 [SessionLoopOptions] 注入面在
    /// 轮次 6 接线；None = 只落日志）。回调链内先记账后透传。
    pub fn try_spawn(
        &self,
        task: SummaryDispatchTask,
        on_done: Option<SummaryOutcomeCallback>,
    ) -> bool {
        // 锁内只做单飞 / 护栏 / 组装；tokio::spawn 必须在 task 锁外，
        // 再短锁回写 JoinHandle（避免持锁进入 runtime，也避免丢句柄）。
        let prepared = {
            let guard = self.task.lock().unwrap_or_else(|e| {
                tracing::error!(target: "session_loop", "summary task 锁中毒，按恢复模式继续：{e}");
                e.into_inner()
            });
            if let Some(handle) = guard.as_ref() {
                if !handle.is_finished() {
                    tracing::debug!(
                        session_id = %task.session_id,
                        block_id = %task.block_id,
                        "摘要后台任务已存活（单飞去重，忽略新 spawn）"
                    );
                    return false;
                }
            }
            // E2 F2 层 1：窗口护栏——累计尝试达上限 → 拒绝（停止重试，等待
            // 窗口过期重置；被动触发点不阻塞用户消息发送，仅本次补摘要跳过）
            let now_ms = conex_shared::time::unix_millis() as u64;
            let mut gate = self.retry_gate.lock().unwrap_or_else(|e| {
                tracing::error!(target: "session_loop", "summary retry_gate 锁中毒，按恢复模式继续：{e}");
                e.into_inner()
            });
            if !gate.try_begin_episode(now_ms) {
                let attempts_in_window = gate.attempts_in_window();
                let guard_max = gate.config().max_attempts;
                tracing::warn!(
                    session_id = %task.session_id,
                    block_id = %task.block_id,
                    attempts_in_window = attempts_in_window,
                    guard_max = guard_max,
                    window_ms = gate.config().retry_window_ms,
                    "低功耗护栏：窗口内累计尝试已达上限 → 忽略本次摘要触发（等待窗口重置或被动触发点）"
                );
                drop(gate);
                // EV-06：护栏拒绝 = 明确放弃——用户可据此区分「正在补摘要」与
                // 「已放弃」（01 无声清单 #1 黑洞闭合；attempt = 窗口内已累计
                // 尝试数，reason = 护栏上限文案）
                emit_summary_background(
                    &self.background_sink(),
                    &task.session_id,
                    "give-up",
                    attempts_in_window,
                    Some(format!(
                        "低功耗护栏：窗口内累计尝试 {attempts_in_window} 已达上限 {guard_max} → 忽略本次摘要触发"
                    )),
                    Some(task.block_id.clone()),
                );
                return false;
            }
            drop(gate);
            let config = self.config.clone();
            // 收尾记账回调：任务完成（无论 committed / awaiting）先记录本次
            // episode 尝试次数进窗口，再透传业务回调（None = 只记账）
            let gate_for_cb = Arc::clone(&self.retry_gate);
            let recorder: SummaryOutcomeCallback = Box::new(
                move |outcome: SummaryDispatchOutcome| {
                    let mut gate = gate_for_cb.lock().unwrap_or_else(|e| {
                    tracing::error!(target: "session_loop", "summary retry_gate 锁中毒，按恢复模式继续：{e}");
                    e.into_inner()
                });
                    gate.record_episode(outcome.attempts, conex_shared::time::unix_millis() as u64);
                    drop(gate);
                    if let Some(callback) = on_done {
                        callback(outcome);
                    }
                },
            );
            // EV-06：spawn 前快照发射器 + 任务标识（task 将 move 进任务闭包）
            let background = self.background_sink();
            let spawned_session_id = task.session_id.clone();
            let spawned_block_id = task.block_id.clone();
            (
                task,
                config,
                recorder,
                background,
                spawned_session_id,
                spawned_block_id,
            )
        };

        let (task, config, recorder, background, spawned_session_id, spawned_block_id) = prepared;
        let abort_signal = self.abort_signal();
        let handle = tokio::spawn(async move {
            run_summary_task_with_abort(task, config, Some(recorder), background, abort_signal)
                .await;
        });
        {
            let mut guard = self.task.lock().unwrap_or_else(|e| {
                tracing::error!(target: "session_loop", "summary task 锁中毒，按恢复模式继续：{e}");
                e.into_inner()
            });
            if let Some(existing) = guard.as_ref() {
                if !existing.is_finished() {
                    // 并发已写入存活句柄：中止本次任务，避免覆盖丢 handle
                    handle.abort();
                    return false;
                }
            }
            *guard = Some(handle);
        }
        // EV-06：spawn 成功 → spawned（attempt=1 起算，含同步那次口径；
        // task 锁已释放——sink 回调不得持锁调用，防外部 sink 重入死锁）
        emit_summary_background(
            &self.background_sink(),
            &spawned_session_id,
            "spawned",
            1,
            None,
            Some(spawned_block_id),
        );
        true
    }
}
