//! 事件序列与持久化分流（任务书 B4.2）
//!
//! [EventQueue] 为 run 内事件分配连续 sequence（T08.12：实际取号走 store
//! 端会话级原子计数器，会话内全局单调、跨 run 不重置——Q23），
//! 并做持久化分流：
//! - message-delta / thought-delta 非持久化，不阻塞 drive loop
//!   （05 §2.8：orchestrator.test.ts:93-189 语义）；
//! - approval-requested 等持久化事件同步等待落库，保证中间态可观测
//!   （05 §2.8：orchestrator.test.ts:191-237 语义）；
//! - run-terminal 为唯一终态事件（03 §5.2-2：删 run-completed / run-failed /
//!   run-cancelled / run-ended 别名，终态判据统一为
//!   [conex_types::events::RunTerminalStatus]）；
//! - 持久化失败 → run 标记 failed(event-store-write-failed)，不假装可回放
//!   （05 §2.8：orchestrator.test.ts:239-289 语义）。
//!
//! [drive_outcome] 把 session-loop 的 [session_loop::RunOutcome] 事件流推入
//! 队列并按 [crate::run::map_outcome_to_terminal] 收口终态（复用 B3.4 收口
//! 类型，不重复定义）。

use std::sync::Arc;

use conex_types::events::{
    event_policy, AgentEvent, AgentEventEnvelope, PersistenceDecision, RunTerminalStatus,
};
use conex_types::session::AgentEndReason;
use session_loop::RunOutcome;
use session_loop::{is_retraction_evacuation_event, SessionFreezeRegistry};

use crate::blocks::persist_compression_block;
use crate::normalize::normalize_envelope;
use crate::persist::{SessionSequencer, Store, StoreError};
use crate::run::{map_outcome_to_terminal, RunError, RunHandle, EVENT_STORE_WRITE_FAILED_REASON};
use conex_shared::time::now_iso_utc;

/// 冻结护栏拒绝的 StoreError kind（T06.5.8 映射面未知 kind 兜底
/// store.write_failed + metadata.kind=retraction_freeze；判定走
/// [PersistError::is_retraction_freeze]，不依赖文案）
pub const RETRACTION_FREEZE_KIND: &str = "retraction_freeze";

/// 是否非持久化事件（D-04 PC-05 迁移：单一分类事实源 [event_policy] 的
/// persist 决策；delta/soft 增量不阻塞 drive loop——05 §2.8 语义不变）
pub fn is_non_persistent(event: &AgentEvent) -> bool {
    event_policy(event).persist == PersistenceDecision::NoPersist
}

/// 事件类型名（顶层 type，落库用；直接取 [AgentEvent::type_name]，
/// 不再构造信封克隆事件体）
pub fn event_type_name(event: &AgentEvent) -> &'static str {
    event.type_name()
}

/// 已入队事件（含序列号与落库标记）
#[derive(Debug, Clone, PartialEq)]
pub struct SequencedEvent {
    /// 连续序列号
    pub sequence: u64,
    /// 事件
    pub event: AgentEvent,
    /// 是否已落库（delta 与失败路径的终态为 false）
    pub persisted: bool,
}

/// 持久化错误（携带失败事件上下文，供 run-failed 详情使用）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersistError {
    /// 失败的序列号
    pub sequence: u64,
    /// 失败的事件类型
    pub event_type: String,
    /// 存储层错误
    pub error: StoreError,
}

impl PersistError {
    /// 冻结护栏拒绝构造（R1 边界冻结：冻结期内 `> frozen_seq` 的非撤离
    /// 写入；kind 取 [RETRACTION_FREEZE_KIND] 可判定）
    pub fn retraction_freeze(sequence: u64, frozen_seq: u64, event_type: &str) -> Self {
        Self {
            sequence,
            event_type: event_type.to_string(),
            error: StoreError::new(
                RETRACTION_FREEZE_KIND,
                format!(
                    "撤回冻结激活期内拒绝越过 frozen_seq={frozen_seq} 的非撤离写入（sequence={sequence}）"
                ),
            ),
        }
    }

    /// 是否为冻结护栏拒绝（区别于普通落库失败——冻结拒绝不标记
    /// run failed，见 drive_outcome 调用面）
    pub fn is_retraction_freeze(&self) -> bool {
        self.error.kind == RETRACTION_FREEZE_KIND
    }
}

impl std::fmt::Display for PersistError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "事件 {} 落库失败（sequence={}）：{}",
            self.event_type, self.sequence, self.error
        )
    }
}

impl std::error::Error for PersistError {}

/// 事件队列（B4.2：sequence 分配 + 持久化分流）
///
/// 每个事件入队分配连续 sequence（会话内由 store 端原子计数器取号，
/// T08.12 Q23：会话内全局单调、跨 run 不重置，防并发 run 冲突）；
/// 非持久化事件直接返回不落库（delta 不阻塞 drive loop）；持久化事件
/// 同步等待 store 落库（approval-requested 等中间态事件返回时已可观测）。
pub struct EventQueue {
    /// 会话级 sequence 分配器（T08.12：实际取号走 store 端原子计数器）
    sequencer: SessionSequencer,
    /// 最近一次已成功分配序列的本地镜像（仅供 `next_sequence` 观测）。
    /// 取号失败不推进——store 端 `reserve_sequence` 是唯一真源。
    last_reserved: u64,
    /// run 归属（构造期绑定，不可变；None = 会话域/空闲态事件，
    /// D-01 R-02：写面注入 = 构造期绑定，非 push 逐次传参）
    run_id: Option<String>,
    /// R1 撤回边界冻结护栏（会话级注册表；None = 未挂载，无冻结检查）。
    /// 冻结激活期内拒绝 `> frozen_seq` 的非撤离写入（详案 §1.2-③），
    /// 由壳层撤回命令在 stop 收敛后激活、truncate 落库后释放。
    freeze: Option<Arc<SessionFreezeRegistry>>,
}

impl EventQueue {
    /// 新建队列（base_sequence 为期望的首事件序列）。
    ///
    /// `run_id` 为构造期绑定的 run 归属（None = 会话域事件，如空闲态
    /// compact-now / task 域审计事件）：所有落库事件的信封 runId 与
    /// events.run_id 列均以该值为准（goal-* 轮次域事件特判除外）。
    ///
    /// T08.12 起**实际分配由 store 端会话级原子计数器决定**（防同会话
    /// 并发 run 取到相同序列），base 仅作本地镜像初值；events.rs 测试内
    /// `run.cursor + 1` 构造模式为**测试专用**（保留兼容，生产路径经
    /// base_sequence_for 预热后首事件仍命中该值）。
    pub fn new(store: Arc<dyn Store>, base_sequence: u64, run_id: Option<String>) -> Self {
        Self {
            sequencer: SessionSequencer::new(store),
            last_reserved: base_sequence.saturating_sub(1),
            run_id,
            freeze: None,
        }
    }

    /// 挂载撤回冻结护栏（R1：壳层撤回命令在组合根为会话内全部队列注入
    /// 同一注册表；默认不挂载，既有调用面零改动）
    pub fn with_freeze_registry(mut self, freeze: Arc<SessionFreezeRegistry>) -> Self {
        self.freeze = Some(freeze);
        self
    }

    /// 下一个待分配的序列号（本地镜像，仅供观测/断言；实际分配在 store 端）
    pub fn next_sequence(&self) -> u64 {
        self.last_reserved + 1
    }

    /// 共享 store
    pub fn store(&self) -> &dyn Store {
        self.sequencer.store()
    }

    /// 会话级分配器（T08.8 seed 预热 / 校准入口）
    pub fn sequencer(&self) -> &SessionSequencer {
        &self.sequencer
    }

    /// goal-* 三事件归**轮次域**（D-01 R-06，裁决 C-2 采纳 04 PC-07）：
    /// 不归任何 run，落库 run_id 列与信封 runId 均置 None，run 查询
    /// 天然不命中。
    fn is_round_domain_event(event: &AgentEvent) -> bool {
        matches!(
            event,
            AgentEvent::GoalRoundStarted { .. }
                | AgentEvent::GoalRoundCompleted { .. }
                | AgentEvent::GoalContinuationDecided { .. }
        )
    }

    /// 落库信封统一构造（D-01 DM-04：normalize_envelope 真接线点——
    /// 名义统一注入点 → 实际注入点，消灭与实现的漂移）。
    ///
    /// 返回（有效 run_id 列值，完整信封）：信封 runId/sequence 经
    /// normalize_envelope 注入（与广播 wire 同构扁平 JSON），goal-*
    /// 轮次域事件信封 runId 与列值均置 None。
    fn persist_envelope(
        &self,
        session_id: &str,
        sequence: u64,
        event: &AgentEvent,
    ) -> (Option<String>, AgentEventEnvelope) {
        let effective_run_id = if Self::is_round_domain_event(event) {
            None
        } else {
            self.run_id.as_deref()
        };
        let envelope = normalize_envelope(
            AgentEventEnvelope::new(
                event.clone(),
                effective_run_id.map(str::to_string),
                Some(sequence),
            ),
            effective_run_id,
            session_id,
        );
        (effective_run_id.map(str::to_string), envelope)
    }

    /// 从会话级原子计数器取号（T08.12）。store 是唯一真源：成功才回写
    /// 本地镜像；失败不推进、不本地瞎加（取号失败即持久化失败）。
    async fn reserve(&mut self, session_id: &str) -> Result<u64, StoreError> {
        let sequence = self.sequencer.reserve(session_id).await?;
        self.last_reserved = sequence;
        Ok(sequence)
    }

    /// 入队并分配 sequence；持久化事件同步等待落库（delta 不阻塞）
    pub async fn push(
        &mut self,
        session_id: &str,
        event: AgentEvent,
    ) -> Result<SequencedEvent, PersistError> {
        // R1 边界冻结护栏（详案 §1.2-③ FREEZE1）：冻结激活期内拒绝
        // 非撤离写入——**取号前拦截**（冻结读点后计数器恒 > frozen_seq，
        // 不消耗序列槽：TimelineTruncate 恰好占 frozen_seq + 1，无空洞）。
        // 撤离事件（timeline-truncate 自身 / run 收口终态）放行；拒绝返回
        // 可判定的 [PersistError::is_retraction_freeze]（调用面按冻结拒绝
        // 语义处置，不标记 run failed）
        if let Some(registry) = &self.freeze {
            if registry.is_frozen(session_id) && !is_retraction_evacuation_event(&event) {
                if let Some(frozen_seq) = registry.frozen_seq(session_id) {
                    return Err(PersistError::retraction_freeze(
                        self.last_reserved + 1,
                        frozen_seq,
                        event_type_name(&event),
                    ));
                }
            }
        }
        // T08.12：sequence 由会话级原子计数器分配（store 端单语句自增，
        // 会话内全局单调，防同会话并发 run 冲突）
        let sequence = match self.reserve(session_id).await {
            Ok(sequence) => sequence,
            Err(error) => {
                // 取号失败：未消耗序列槽，错误携带上次成功号供观测
                return Err(PersistError {
                    sequence: self.last_reserved,
                    event_type: event_type_name(&event).to_string(),
                    error,
                });
            }
        };
        if is_non_persistent(&event) {
            // delta 不落库、不等待（05 §2.8：不阻塞 drive loop）
            return Ok(SequencedEvent {
                sequence,
                event,
                persisted: false,
            });
        }
        let event_type = event_type_name(&event);
        let (run_id, envelope) = self.persist_envelope(session_id, sequence, &event);
        let payload = serde_json::to_string(&envelope).map_err(|err| PersistError {
            sequence,
            event_type: event_type.to_string(),
            error: StoreError::new("serialize_event", err.to_string()),
        })?;
        self.store()
            .append_event(
                session_id,
                sequence,
                event_type,
                &payload,
                run_id.as_deref(),
            )
            .await
            .map_err(|error| PersistError {
                sequence,
                event_type: event_type.to_string(),
                error,
            })?;
        Ok(SequencedEvent {
            sequence,
            event,
            persisted: true,
        })
    }

    /// 终态事件尽力落库（store 已坏时不假装可回放；失败仍返回事件）。
    ///
    /// 取号只走 store `reserve_sequence`：首次失败再重试一次。重试仍失败
    /// 则不落库、不推进本地镜像（不是第二条序号生成器）。
    pub async fn push_terminal_best_effort(
        &mut self,
        session_id: &str,
        event: AgentEvent,
    ) -> SequencedEvent {
        let sequence = match self.reserve(session_id).await {
            Ok(sequence) => sequence,
            Err(_) => match self.store().reserve_sequence(session_id).await {
                Ok(sequence) => {
                    self.last_reserved = sequence;
                    sequence
                }
                Err(_) => {
                    return SequencedEvent {
                        sequence: self.last_reserved,
                        event,
                        persisted: false,
                    };
                }
            },
        };
        let event_type = event_type_name(&event);
        let (run_id, envelope) = self.persist_envelope(session_id, sequence, &event);
        let payload = serde_json::to_string(&envelope).ok();
        let persisted = match payload {
            Some(payload) => self
                .store()
                .append_event(
                    session_id,
                    sequence,
                    event_type,
                    &payload,
                    run_id.as_deref(),
                )
                .await
                .is_ok(),
            None => false,
        };
        SequencedEvent {
            sequence,
            event,
            persisted,
        }
    }

    /// 以指定序列号尽力落库（终态重发用：复用已失败的序列号，保持序列
    /// 连续性与终态唯一性；不重复取号）
    async fn push_at_best_effort(
        &mut self,
        session_id: &str,
        event: AgentEvent,
        sequence: u64,
    ) -> SequencedEvent {
        let event_type = event_type_name(&event);
        let (run_id, envelope) = self.persist_envelope(session_id, sequence, &event);
        let payload = serde_json::to_string(&envelope).ok();
        let persisted = match payload {
            Some(payload) => self
                .store()
                .append_event(
                    session_id,
                    sequence,
                    event_type,
                    &payload,
                    run_id.as_deref(),
                )
                .await
                .is_ok(),
            None => false,
        };
        SequencedEvent {
            sequence,
            event,
            persisted,
        }
    }
}

/// 持久化失败详情
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersistFailureInfo {
    /// 失败的事件类型
    pub event_type: String,
    /// 存储层错误
    pub error: StoreError,
}

/// drive 结果
#[derive(Debug, Clone)]
pub struct DriveOutcome {
    /// 全部已入队事件（含终态；sequence 连续）
    pub events: Vec<SequencedEvent>,
    /// 终态（run-terminal 唯一一次）
    pub terminal_status: RunTerminalStatus,
    /// 落库的 end_reason
    pub end_reason: String,
    /// 终态错误文案（failed 收场时）
    pub terminal_error: Option<String>,
    /// 持久化失败详情（None = 全程落库成功）
    pub persist_failure: Option<PersistFailureInfo>,
}

/// max-turns 收场失败文案（05 §2.8：agent-end(max-turns) → run-failed
/// 且带错误文案）
pub const MAX_TURNS_FAILED_MESSAGE: &str = "max-turns 预算用尽";

/// 构造 run-terminal 事件（唯一终态事件，03 §5.2-2；runId 必填，
/// 03 §5.1-16）
pub fn build_run_terminal(
    run: &RunHandle,
    terminal: RunTerminalStatus,
    error: Option<String>,
) -> AgentEvent {
    AgentEvent::RunTerminal {
        session_id: run.session_id.clone(),
        run_id: run.run_id.clone(),
        timestamp: now_iso_utc(),
        terminal,
        error,
    }
}

/// 把一次 run 的结果（复用 session-loop 的 [RunOutcome]）驱入事件队列并
/// 收口（05 §5.4 run::drive / run::fail）
///
/// 流程：
/// 1. 事件分流推送（delta 不落库不阻塞；持久化事件同步等待）；
/// 2. 任一持久化事件落库失败 → run 标记 failed(event-store-write-failed)，
///    终态事件尽力发出（不假装可回放；复用失败序列号，Q25 不留空洞）；
/// 3. 全部成功 → 按 [map_outcome_to_terminal] 收口终态：先发 run-terminal
///    （唯一终态事件，只发一次）再落库终态记录（cursor 含终态序列，
///    T08.4）。
///
/// `outcome` 按值消费（事件流移动入队，0 深克隆；调用方不再使用
/// outcome.events）。
///
/// 终态 run 再次驱动返回 [RunError::TerminalImmutable]（不产生第二个
/// 终态事件）。
pub async fn drive_outcome(
    run: &mut RunHandle,
    queue: &mut EventQueue,
    outcome: RunOutcome,
) -> Result<DriveOutcome, RunError> {
    if run.terminal_sent() || run.is_terminal() {
        return Err(RunError::TerminalImmutable);
    }

    let mut pushed: Vec<SequencedEvent> = Vec::with_capacity(outcome.events.len() + 1);
    let mut persist_failure: Option<PersistFailureInfo> = None;
    // Q25（必做）：中途持久化失败的事件序列号——终态复用该序列（不留空洞）
    let mut failed_sequence: u64 = 0;

    // 1. 事件分流推送（delta 不落库不阻塞；持久化事件同步等待）
    for event in outcome.events {
        match queue.push(&run.session_id, event).await {
            Ok(sequenced) => {
                run.cursor = sequenced.sequence;
                // T-18（轮次 2 持久层）：压缩事件落库成功后写块行——
                // INSERT OR IGNORE 幂等（同 (session_id, block_id) 重放不重复行）；
                // 失败仅告警不阻断 drive（块表是索引面，原文仍在事件流可回放）
                if matches!(&sequenced.event, AgentEvent::ContextCompressionEnd { .. }) {
                    if let Err(error) = persist_compression_block(
                        queue.store(),
                        &run.session_id,
                        &sequenced.event,
                        sequenced.sequence,
                    )
                    .await
                    {
                        tracing::warn!(
                            session_id = %run.session_id,
                            sequence = sequenced.sequence,
                            error = %error,
                            "压缩块行写入失败（块表索引面降级，原文仍可经事件流回放）"
                        );
                    }
                }
                pushed.push(sequenced);
            }
            Err(err) => {
                failed_sequence = err.sequence;
                persist_failure = Some(PersistFailureInfo {
                    event_type: err.event_type.clone(),
                    error: err.error.clone(),
                });
                break;
            }
        }
    }

    // 2. 持久化失败 → run-failed(event-store-write-failed)，不假装可回放
    if let Some(failure) = &persist_failure {
        // 错误日志（T04.3-3）：store 写失败按类型化错误码记录
        // （T06.5.8 映射：append_event/serialize_event → event_store.append_failed，
        // 锁 → store.write_failed；cause 链随 StoreError 保留 DbFailure 分类码）
        let crish = failure.error.to_crish();
        tracing::error!(
            target: "event_store",
            event = "persist_failed",
            error_code = %crish.code,
            retryable = crish.retryable,
            event_type = %failure.event_type,
            error = %failure.error,
            "事件持久化失败（run 标记 failed(event-store-write-failed)）"
        );
        let message = format!("{}: {}", failure.event_type, failure.error.message);
        // Q25（必做）：append 失败时序列已从会话计数器取出，终态复用该号
        // 不留空洞。取号本身失败则槽位未消耗——改走 store 重试取号，
        // 禁止用本地镜像当序号写库。
        run.cursor = failed_sequence;
        run.fail_event_store(queue.store(), &message).await?;
        let terminal = build_run_terminal(run, RunTerminalStatus::Failed, Some(message.clone()));
        let sequenced = if failure.error.kind == "reserve_sequence" {
            queue
                .push_terminal_best_effort(&run.session_id, terminal)
                .await
        } else {
            queue
                .push_at_best_effort(&run.session_id, terminal, failed_sequence)
                .await
        };
        run.cursor = sequenced.sequence;
        pushed.push(sequenced);
        return Ok(DriveOutcome {
            events: pushed,
            terminal_status: RunTerminalStatus::Failed,
            end_reason: EVENT_STORE_WRITE_FAILED_REASON.to_string(),
            terminal_error: Some(message),
            persist_failure: Some(failure.clone()),
        });
    }

    // 3. 正常收口：outcome reason → 终态
    let (terminal_status, end_reason) =
        map_outcome_to_terminal(run.cancel_requested(), outcome.reason);
    let terminal_error = match terminal_status {
        RunTerminalStatus::Failed => Some(
            outcome
                .error
                .or_else(|| {
                    if outcome.reason == AgentEndReason::MaxTurns {
                        Some(MAX_TURNS_FAILED_MESSAGE.to_string())
                    } else {
                        None
                    }
                })
                .unwrap_or_else(|| {
                    // Q31（T06.5.5）：兜底文案携带终态与 reason，人读可定位
                    format!(
                        "run 失败（终态={terminal_status:?}，reason={:?}）",
                        outcome.reason
                    )
                }),
        ),
        _ => None,
    };
    // 先发 run-terminal（唯一终态事件），再落库收口——终态记录 cursor 携带
    // run-terminal 的 sequence（T08.4：终态游标 = 该 run 最后事件 sequence）
    let terminal = build_run_terminal(run, terminal_status, terminal_error.clone());
    match queue.push(&run.session_id, terminal).await {
        Ok(sequenced) => {
            run.cursor = sequenced.sequence;
            run.mark_terminal_emitted();
            run.finalize(
                queue.store(),
                terminal_status,
                end_reason,
                terminal_error.clone(),
                sequenced.sequence,
            )
            .await?;
            pushed.push(sequenced);
        }
        Err(err) => {
            // 终态事件落库失败：run 翻转 failed(event-store-write-failed)，
            // 以原序列号尽力重发终态（保持序列连续、终态唯一）
            // 错误日志（T04.3-3）：终态事件落库失败同样带类型化错误码
            let crish = err.error.to_crish();
            tracing::error!(
                target: "event_store",
                event = "persist_failed",
                error_code = %crish.code,
                retryable = crish.retryable,
                event_type = %err.event_type,
                error = %err.error,
                "终态事件落库失败（run 翻转 failed）"
            );
            let message = format!("{}: {}", err.event_type, err.error.message);
            // 终态序列：append 失败复用已取出的号；取号失败则 store 重试
            run.cursor = err.sequence;
            run.fail_event_store(queue.store(), &message).await?;
            let failed_terminal =
                build_run_terminal(run, RunTerminalStatus::Failed, Some(message.clone()));
            let sequenced = if err.error.kind == "reserve_sequence" {
                queue
                    .push_terminal_best_effort(&run.session_id, failed_terminal)
                    .await
            } else {
                queue
                    .push_at_best_effort(&run.session_id, failed_terminal, err.sequence)
                    .await
            };
            run.cursor = sequenced.sequence;
            pushed.push(sequenced);
            return Ok(DriveOutcome {
                events: pushed,
                terminal_status: RunTerminalStatus::Failed,
                end_reason: EVENT_STORE_WRITE_FAILED_REASON.to_string(),
                terminal_error: Some(message),
                persist_failure: Some(PersistFailureInfo {
                    event_type: err.event_type.clone(),
                    error: err.error.clone(),
                }),
            });
        }
    }

    Ok(DriveOutcome {
        events: pushed,
        terminal_status,
        end_reason: end_reason.to_string(),
        terminal_error,
        persist_failure: None,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use conex_types::events::RunTerminalStatus;
    use conex_types::message::AgentMessageBlock;
    use conex_types::session::AgentEndReason;
    use session_loop::RunOutcome;

    use super::*;
    use crate::persist::{InMemoryStore, LocalDbStore};
    use crate::run::{CancelMode, CancelPath, RunEngine, RunManager};

    // ── 测试替身 ──

    /// 测试引擎（记录协作停止与强制中断调用）
    struct TestEngine {
        cooperative_supported: bool,
        cooperative_calls: Arc<std::sync::Mutex<Vec<String>>>,
        abort_calls: Arc<std::sync::Mutex<Vec<String>>>,
    }

    impl TestEngine {
        fn new(cooperative_supported: bool) -> Self {
            Self {
                cooperative_supported,
                cooperative_calls: Arc::new(std::sync::Mutex::new(Vec::new())),
                abort_calls: Arc::new(std::sync::Mutex::new(Vec::new())),
            }
        }

        fn cooperative_calls(&self) -> Vec<String> {
            self.cooperative_calls.lock().unwrap().clone()
        }

        fn abort_calls(&self) -> Vec<String> {
            self.abort_calls.lock().unwrap().clone()
        }
    }

    impl RunEngine for TestEngine {
        fn request_cooperative_stop(&self, reason: &str) -> bool {
            if !self.cooperative_supported {
                return false;
            }
            self.cooperative_calls
                .lock()
                .unwrap()
                .push(reason.to_string());
            true
        }

        fn abort(&self, reason: &str) {
            self.abort_calls.lock().unwrap().push(reason.to_string());
        }
    }

    /// 会话环境（内存 store 具体句柄 + 共享 trait 对象）
    fn setup() -> (Arc<InMemoryStore>, Arc<dyn Store>) {
        let mem = Arc::new(InMemoryStore::new());
        let store: Arc<dyn Store> = mem.clone();
        (mem, store)
    }

    fn ts() -> String {
        conex_shared::time::now_iso_utc()
    }

    fn agent_start() -> AgentEvent {
        AgentEvent::AgentStart {
            session_id: "s1".to_string(),
            timestamp: ts(),
        }
    }

    fn agent_end(reason: AgentEndReason) -> AgentEvent {
        AgentEvent::AgentEnd {
            session_id: "s1".to_string(),
            timestamp: ts(),
            reason,
            error: None,
        }
    }

    fn message_delta(index: u64) -> AgentEvent {
        AgentEvent::MessageDelta {
            session_id: "s1".to_string(),
            timestamp: ts(),
            message_id: "m1".to_string(),
            block: AgentMessageBlock::Text {
                text: format!("chunk-{index}"),
            },
        }
    }

    fn message_end() -> AgentEvent {
        AgentEvent::MessageEnd {
            session_id: "s1".to_string(),
            message: std::sync::Arc::new(conex_types::message::AgentMessage {
                id: "m1".to_string(),
                role: conex_types::message::AgentMessageRole::Assistant,
                created_at: ts(),
                blocks: vec![AgentMessageBlock::Text {
                    text: "full".to_string(),
                }],
                metadata: None,
                client_message_id: None,
                content: None,
            }),
            turn_index: None,
        }
    }

    fn outcome(reason: AgentEndReason, events: Vec<AgentEvent>) -> RunOutcome {
        RunOutcome {
            reason,
            error: if reason == AgentEndReason::Error {
                Some("provider 调用失败".to_string())
            } else {
                None
            },
            diagnostic: None,
            messages: Vec::new(),
            events,
            turn_index: 0,
            tool_call_count: 0,
            steering_count: 0,
            // T-36：缓存统计字段（本构造点无样本 → None，缺省向后兼容）
            cache_stats: None,
            // D1：provider 错误摘要（本构造点非 fatal 收场 → None，缺省向后兼容）
            provider_error: None,
        }
    }

    fn terminal_count(events: &[SequencedEvent]) -> usize {
        events
            .iter()
            .filter(|e| matches!(e.event, AgentEvent::RunTerminal { .. }))
            .count()
    }

    // ── 事件序列与持久化分流 ──

    #[tokio::test]
    async fn queue_assigns_continuous_sequences_and_splits_persistence() {
        let (mem, store) = setup();
        let mut queue = EventQueue::new(store, 1, None);

        let mut sequences = Vec::new();
        sequences.push(queue.push("s1", agent_start()).await.unwrap());
        for i in 0..3 {
            sequences.push(queue.push("s1", message_delta(i)).await.unwrap());
        }
        sequences.push(queue.push("s1", message_end()).await.unwrap());

        // 事件序列连续性：1..=n 连续
        let seqs: Vec<u64> = sequences.iter().map(|s| s.sequence).collect();
        assert_eq!(seqs, (1..=sequences.len() as u64).collect::<Vec<_>>());
        // delta 不落库；持久化事件已落库
        assert_eq!(
            sequences.iter().map(|s| s.persisted).collect::<Vec<_>>(),
            vec![true, false, false, false, true]
        );
        assert_eq!(queue.next_sequence(), sequences.len() as u64 + 1);

        // 落库集合 = 持久化事件（delta 不在其中）
        let stored = mem.events();
        let types: Vec<&str> = stored.iter().map(|e| e.event_type.as_str()).collect();
        assert_eq!(types, vec!["agent-start", "message-end"]);
        assert_eq!(stored[0].sequence, 1);
        assert_eq!(stored[1].sequence, 5);
    }

    #[tokio::test]
    async fn queue_persistent_events_wait_for_store() {
        let (mem, store) = setup();
        mem.set_append_delay(Duration::from_millis(40));
        let mut queue = EventQueue::new(store, 1, None);

        // 持久化事件同步等待落库（慢 store 40ms/条 × 3 条 ≈ 120ms）
        let started = Instant::now();
        queue.push("s1", agent_start()).await.unwrap();
        queue.push("s1", message_end()).await.unwrap();
        queue
            .push("s1", agent_end(AgentEndReason::Stop))
            .await
            .unwrap();
        let elapsed = started.elapsed();
        assert!(
            elapsed >= Duration::from_millis(120),
            "持久化事件应等待落库：elapsed={elapsed:?}"
        );
        // 返回时已落库（中间态可观测）
        let stored = mem.events();
        assert_eq!(stored.len(), 3);
    }

    #[tokio::test]
    async fn delta_does_not_block_drive_loop() {
        let (mem, store) = setup();
        // 慢 store：持久化追加 40ms/条（05 §2.8：120 delta × 40ms ≈ 4.8s 的
        // 场景；delta 不等待则整体远小于该值）
        mem.set_append_delay(Duration::from_millis(40));

        let manager = RunManager::new(store.clone());
        let mut run = manager.start_run("s1", "r_delta").await.unwrap();
        let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

        let mut events = vec![agent_start()];
        for i in 0..120 {
            events.push(message_delta(i));
        }
        events.push(message_end());
        events.push(agent_end(AgentEndReason::Stop));
        let outcome = outcome(AgentEndReason::Stop, events);

        let started = Instant::now();
        let result = drive_outcome(&mut run, &mut queue, outcome).await.unwrap();
        let elapsed = started.elapsed();

        // delta 不阻塞：120 条 delta 若各自等待 40ms 需约 4.8s；
        // 实际只等待 4 条持久化事件（agent-start/message-end/agent-end/终态）
        assert!(
            elapsed < Duration::from_millis(120 * 40 / 2),
            "delta 不应阻塞 drive loop：elapsed={elapsed:?}"
        );

        // 全部 120 条 delta 都存活于事件流
        let live_deltas = result
            .events
            .iter()
            .filter(|e| matches!(e.event, AgentEvent::MessageDelta { .. }))
            .count();
        assert_eq!(live_deltas, 120);

        // 落库集合不含 delta；持久化事件齐全
        let stored = mem.events();
        let types: Vec<&str> = stored.iter().map(|e| e.event_type.as_str()).collect();
        assert!(!types.contains(&"message-delta"), "delta 不应落库");
        assert!(types.contains(&"agent-start"));
        assert!(types.contains(&"message-end"));
        assert!(types.contains(&"run-terminal"));

        // 事件序列连续性（含终态）
        let seqs: Vec<u64> = result.events.iter().map(|e| e.sequence).collect();
        assert_eq!(seqs, (1..=result.events.len() as u64).collect::<Vec<_>>());
    }

    // ── run 生命周期（drive 集成）──

    #[tokio::test]
    async fn full_lifecycle_queued_to_completed() {
        let (mem, store) = setup();
        let manager = RunManager::new(store.clone());
        let mut run = manager.start_run("s1", "r_main").await.unwrap();
        assert_eq!(run.status, conex_db::RunStatus::Running);
        let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

        let result = drive_outcome(
            &mut run,
            &mut queue,
            outcome(
                AgentEndReason::Stop,
                vec![agent_start(), agent_end(AgentEndReason::Stop)],
            ),
        )
        .await
        .unwrap();

        assert_eq!(run.status, conex_db::RunStatus::Completed);
        assert_eq!(run.end_reason.as_deref(), Some("stop"));
        assert_eq!(result.terminal_status, RunTerminalStatus::Completed);
        assert!(result.persist_failure.is_none());
        assert_eq!(mem.runs()[0].status, conex_db::RunStatus::Completed);
        assert_eq!(mem.runs()[0].end_reason.as_deref(), Some("stop"));
        // T08.4：终态游标 = 该 run 最后事件 sequence（agent-start=1，
        // agent-end=2，run-terminal=3）
        assert_eq!(mem.runs()[0].cursor, 3, "终态 cursor 落库（T08.4）");
    }

    #[tokio::test]
    async fn approval_flow_pauses_and_resumes_then_completes() {
        let (mem, store) = setup();
        let manager = RunManager::new(store.clone());
        let mut run = manager.start_run("s1", "r_approval").await.unwrap();
        let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

        // 审批挂起：awaiting-approval 中间态（05 §5.4 run::approval）
        run.request_approval(store.as_ref()).await.unwrap();
        assert_eq!(run.status, conex_db::RunStatus::AwaitingApproval);
        assert_eq!(mem.runs()[0].status, conex_db::RunStatus::AwaitingApproval);

        // 批准恢复：回 running → completed
        run.resolve_approval(store.as_ref()).await.unwrap();
        assert_eq!(run.status, conex_db::RunStatus::Running);

        let result = drive_outcome(
            &mut run,
            &mut queue,
            outcome(
                AgentEndReason::Stop,
                vec![agent_start(), agent_end(AgentEndReason::Stop)],
            ),
        )
        .await
        .unwrap();
        assert_eq!(result.terminal_status, RunTerminalStatus::Completed);
        assert_eq!(run.status, conex_db::RunStatus::Completed);
    }

    #[tokio::test]
    async fn l2_cooperative_cancel_does_not_hard_abort() {
        let (mem, store) = setup();
        let engine = TestEngine::new(true);
        let manager = RunManager::new(store.clone());
        let mut run = manager.start_run("s1", "r_coop").await.unwrap();
        let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

        let path = run
            .cancel_run(
                CancelMode::Cooperative,
                Some(&engine),
                "cancelled-by-user",
                store.as_ref(),
            )
            .await
            .unwrap();
        assert_eq!(path, CancelPath::Cooperative);
        // L2：协作停止注入，不 hard abort（05 §2.8 orchestrator.test.ts:1113）
        assert_eq!(engine.abort_calls(), Vec::<String>::new());
        assert_eq!(
            engine.cooperative_calls(),
            vec!["cancelled-by-user".to_string()]
        );
        assert!(run.cancel_requested());
        assert_eq!(run.cancel_path(), Some(CancelPath::Cooperative));

        // 安全点收场（stopped）→ run 以 cancelled 收尾（end_reason=aborted）
        let result = drive_outcome(
            &mut run,
            &mut queue,
            outcome(
                AgentEndReason::Stopped,
                vec![agent_start(), agent_end(AgentEndReason::Stopped)],
            ),
        )
        .await
        .unwrap();
        assert_eq!(result.terminal_status, RunTerminalStatus::Cancelled);
        assert_eq!(run.status, conex_db::RunStatus::Cancelled);
        assert_eq!(run.end_reason.as_deref(), Some("aborted"));
        assert_eq!(mem.runs()[0].status, conex_db::RunStatus::Cancelled);
    }

    #[tokio::test]
    async fn l3_force_cancel_hard_aborts() {
        let (_mem, store) = setup();
        let engine = TestEngine::new(true);
        let manager = RunManager::new(store.clone());
        let mut run = manager.start_run("s1", "r_force").await.unwrap();
        let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

        let path = run
            .cancel_run(CancelMode::Force, Some(&engine), "ui-force", store.as_ref())
            .await
            .unwrap();
        assert_eq!(path, CancelPath::Force);
        // L3：hard abort，无协作停止
        assert_eq!(engine.abort_calls(), vec!["ui-force".to_string()]);
        assert_eq!(engine.cooperative_calls(), Vec::<String>::new());
        assert_eq!(run.cancel_path(), Some(CancelPath::Force));

        let result = drive_outcome(
            &mut run,
            &mut queue,
            outcome(
                AgentEndReason::Aborted,
                vec![agent_start(), agent_end(AgentEndReason::Aborted)],
            ),
        )
        .await
        .unwrap();
        assert_eq!(result.terminal_status, RunTerminalStatus::Cancelled);
        assert_eq!(run.status, conex_db::RunStatus::Cancelled);
        assert_eq!(run.end_reason.as_deref(), Some("aborted"));
    }

    #[tokio::test]
    async fn cooperative_cancel_falls_back_to_force_without_l2_support() {
        let (_mem, store) = setup();
        // 引擎不支持 L2（无协作停止注入点）→ 回落 L3
        let engine = TestEngine::new(false);
        let manager = RunManager::new(store.clone());
        let mut run = manager.start_run("s1", "r_fallback").await.unwrap();
        let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

        let path = run
            .cancel_run(
                CancelMode::Cooperative,
                Some(&engine),
                "no-bus",
                store.as_ref(),
            )
            .await
            .unwrap();
        assert_eq!(path, CancelPath::CooperativeFallbackForce);
        // 回落 L3：强制中断（05 §2.8 orchestrator.test.ts:1186）
        assert_eq!(engine.abort_calls(), vec!["no-bus".to_string()]);
        assert_eq!(engine.cooperative_calls(), Vec::<String>::new());
        assert_eq!(
            run.cancel_path(),
            Some(CancelPath::CooperativeFallbackForce)
        );

        let result = drive_outcome(
            &mut run,
            &mut queue,
            outcome(
                AgentEndReason::Aborted,
                vec![agent_start(), agent_end(AgentEndReason::Aborted)],
            ),
        )
        .await
        .unwrap();
        assert_eq!(result.terminal_status, RunTerminalStatus::Cancelled);
        assert_eq!(run.status, conex_db::RunStatus::Cancelled);
    }

    // ── 持久化失败与终态唯一性 ──

    #[tokio::test]
    async fn persist_failure_marks_run_failed_and_does_not_pretend_replayable() {
        let (mem, store) = setup();
        mem.fail_all_appends("disk is read-only");
        let manager = RunManager::new(store.clone());
        let mut run = manager.start_run("s1", "r_fail").await.unwrap();
        let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

        let result = drive_outcome(
            &mut run,
            &mut queue,
            outcome(
                AgentEndReason::Stop,
                vec![agent_start(), agent_end(AgentEndReason::Stop)],
            ),
        )
        .await
        .unwrap();

        // run-failed(event-store-write-failed)，不假装可回放
        assert_eq!(result.terminal_status, RunTerminalStatus::Failed);
        assert_eq!(result.end_reason, EVENT_STORE_WRITE_FAILED_REASON);
        let failure = result.persist_failure.as_ref().expect("应有持久化失败详情");
        assert_eq!(failure.event_type, "agent-start");
        assert!(failure.error.message.contains("disk is read-only"));

        assert_eq!(run.status, conex_db::RunStatus::Failed);
        assert_eq!(
            run.end_reason.as_deref(),
            Some(EVENT_STORE_WRITE_FAILED_REASON)
        );
        assert!(run
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("disk is read-only"));
        assert_eq!(mem.runs()[0].status, conex_db::RunStatus::Failed);
        assert_eq!(
            mem.runs()[0].end_reason.as_deref(),
            Some(EVENT_STORE_WRITE_FAILED_REASON)
        );
        // 事件流只有终态事件，且未落库（不能重放）
        assert_eq!(result.events.len(), 1);
        assert!(!result.events[0].persisted);
        assert!(mem.events().is_empty(), "失败期间不应有任何事件落库");
    }

    #[tokio::test]
    async fn run_terminal_is_emitted_exactly_once() {
        let (mem, store) = setup();
        let manager = RunManager::new(store.clone());
        let mut run = manager.start_run("s1", "r_terminal_once").await.unwrap();
        let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

        let result = drive_outcome(
            &mut run,
            &mut queue,
            outcome(
                AgentEndReason::Stop,
                vec![agent_start(), agent_end(AgentEndReason::Stop)],
            ),
        )
        .await
        .unwrap();
        assert_eq!(terminal_count(&result.events), 1, "run-terminal 只发一次");
        assert!(run.terminal_sent());

        // 再次驱动 → 终态拒绝，不产生第二个终态事件
        let seq_before = queue.next_sequence();
        let err = drive_outcome(
            &mut run,
            &mut queue,
            outcome(
                AgentEndReason::Stop,
                vec![agent_start(), agent_end(AgentEndReason::Stop)],
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(err, RunError::TerminalImmutable);
        assert_eq!(queue.next_sequence(), seq_before, "终态后不再分配序列");
        assert_eq!(
            mem.events()
                .iter()
                .filter(|e| e.event_type == "run-terminal")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn max_turns_ends_failed_with_message() {
        let (_mem, store) = setup();
        let manager = RunManager::new(store.clone());
        let mut run = manager.start_run("s1", "r_max_turns").await.unwrap();
        let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

        let result = drive_outcome(
            &mut run,
            &mut queue,
            outcome(
                AgentEndReason::MaxTurns,
                vec![agent_start(), agent_end(AgentEndReason::MaxTurns)],
            ),
        )
        .await
        .unwrap();
        // max-turns → failed 而非 completed（05 §2.8 orchestrator.test.ts:1223）
        assert_eq!(result.terminal_status, RunTerminalStatus::Failed);
        assert_eq!(result.end_reason, "max-turns");
        assert_eq!(
            result.terminal_error.as_deref(),
            Some(MAX_TURNS_FAILED_MESSAGE)
        );
        assert_eq!(run.status, conex_db::RunStatus::Failed);
    }

    #[tokio::test]
    async fn runtime_error_ends_failed_preserving_error() {
        let (mem, store) = setup();
        let manager = RunManager::new(store.clone());
        let mut run = manager.start_run("s1", "r_error").await.unwrap();
        let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

        let result = drive_outcome(
            &mut run,
            &mut queue,
            outcome(
                AgentEndReason::Error,
                vec![agent_start(), agent_end(AgentEndReason::Error)],
            ),
        )
        .await
        .unwrap();
        assert_eq!(result.terminal_status, RunTerminalStatus::Failed);
        assert_eq!(result.end_reason, "error");
        assert_eq!(result.terminal_error.as_deref(), Some("provider 调用失败"));
        assert_eq!(run.status, conex_db::RunStatus::Failed);
        assert_eq!(mem.runs()[0].status, conex_db::RunStatus::Failed);
        assert_eq!(mem.runs()[0].end_reason.as_deref(), Some("error"));
    }

    // ── T08.4 / T08.8 / T08.12 / Q25 新增测试 ──

    /// T08.8 + T08.12：同会话连续两个 run——R2 从会话已落库最大序列续接
    /// （跨 run 不重置，首事件 != 1），终态 cursor 正确
    #[tokio::test]
    async fn sequences_continue_across_runs_in_session() {
        let (mem, store) = setup();
        let manager = RunManager::new(store.clone());

        // R1：agent-start=1，agent-end=2，run-terminal=3
        let mut run = manager.start_run("s1", "r1").await.unwrap();
        let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);
        let result = drive_outcome(
            &mut run,
            &mut queue,
            outcome(
                AgentEndReason::Stop,
                vec![agent_start(), agent_end(AgentEndReason::Stop)],
            ),
        )
        .await
        .unwrap();
        assert_eq!(result.events.last().unwrap().sequence, 3);
        assert_eq!(
            mem.runs()[0].cursor,
            3,
            "R1 终态 cursor = 最后事件 sequence"
        );

        // R2：序列续接（会话内全局单调，跨 run 不重置——Q24/T08.12）
        let mut run2 = manager.start_run("s1", "r2").await.unwrap();
        let mut queue2 = EventQueue::new(store.clone(), run2.cursor + 1, None);
        let result2 = drive_outcome(
            &mut run2,
            &mut queue2,
            outcome(
                AgentEndReason::Stop,
                vec![agent_start(), agent_end(AgentEndReason::Stop)],
            ),
        )
        .await
        .unwrap();
        let seqs2: Vec<u64> = result2.events.iter().map(|e| e.sequence).collect();
        assert_eq!(seqs2, vec![4, 5, 6], "R2 从会话 max+1 续接（不等于 1）");
        assert_eq!(mem.runs()[1].cursor, 6, "R2 终态 cursor（T08.4）");

        // 全事件唯一连续
        let stored = mem.events();
        let mut all: Vec<u64> = stored.iter().map(|e| e.sequence).collect();
        all.sort_unstable();
        assert_eq!(all, (1..=6).collect::<Vec<_>>(), "会话内全事件连续无冲突");
    }

    /// T08.12 Q23：同会话双 run 并发各取 50 号——序列唯一连续、全部落库
    /// 成功（无 UNIQUE 冲突 → 无 event-store-write-failed）
    #[tokio::test]
    async fn concurrent_runs_reserve_unique_sequences() {
        let (mem, store) = setup();
        let store_b = store.clone();
        let run_a = tokio::spawn(async move {
            let mut queue = EventQueue::new(store, 1, None);
            let mut seqs = Vec::new();
            for _ in 0..50 {
                seqs.push(queue.push("s1", message_end()).await.unwrap().sequence);
            }
            seqs
        });
        let run_b = tokio::spawn(async move {
            let mut queue = EventQueue::new(store_b, 1, None);
            let mut seqs = Vec::new();
            for _ in 0..50 {
                seqs.push(queue.push("s1", message_end()).await.unwrap().sequence);
            }
            seqs
        });
        let (sa, sb) = tokio::join!(run_a, run_b);
        let mut all = sa.unwrap();
        all.extend(sb.unwrap());
        all.sort_unstable();
        assert_eq!(
            all,
            (1..=100).collect::<Vec<_>>(),
            "并发取号全唯一连续（Q23）"
        );

        // 全部落库成功且不重复（无 event-store-write-failed）
        let stored = mem.events();
        assert_eq!(stored.len(), 100, "100 条事件全部落库");
        let mut seqs: Vec<u64> = stored.iter().map(|e| e.sequence).collect();
        seqs.sort_unstable();
        assert_eq!(seqs, (1..=100).collect::<Vec<_>>());
    }

    /// Q25（必做）：中途持久化失败路径——终态复用失败的 sequence，
    /// 落库序列无空洞（对齐重发路径语义）
    #[tokio::test]
    async fn mid_failure_terminal_reuses_failed_sequence_no_hole() {
        let (mem, store) = setup();
        // 单次故障：agent-start 落库失败后恢复正常
        mem.fail_next_append("一次失败");
        let manager = RunManager::new(store.clone());
        let mut run = manager.start_run("s1", "r_hole").await.unwrap();
        let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

        let result = drive_outcome(
            &mut run,
            &mut queue,
            outcome(
                AgentEndReason::Stop,
                vec![agent_start(), agent_end(AgentEndReason::Stop)],
            ),
        )
        .await
        .unwrap();

        assert_eq!(result.terminal_status, RunTerminalStatus::Failed);
        assert_eq!(result.end_reason, EVENT_STORE_WRITE_FAILED_REASON);
        // 落库序列无空洞：agent-start 失败（seq=1）→ 终态复用 seq=1
        let stored = mem.events();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].event_type, "run-terminal");
        assert_eq!(stored[0].sequence, 1, "终态复用失败序列，不留空洞（Q25）");
        // T08.4：失败路径 cursor = 最后已分配序列（含失败占位）
        assert_eq!(mem.runs()[0].cursor, 1, "失败路径 cursor 落库（T08.4）");
    }

    // ── C3：取号失败不推进本地镜像，终态只信 store.reserve_sequence ──

    /// 前 N 次 `reserve_sequence` 失败且不推进内层计数器；其余方法委托内存 store。
    struct FailNReserves {
        inner: Arc<InMemoryStore>,
        remaining: std::sync::atomic::AtomicU32,
    }

    impl FailNReserves {
        fn new(inner: Arc<InMemoryStore>, fails: u32) -> Self {
            Self {
                inner,
                remaining: std::sync::atomic::AtomicU32::new(fails),
            }
        }
    }

    #[async_trait::async_trait]
    impl Store for FailNReserves {
        async fn insert_run(
            &self,
            run_id: &str,
            session_id: &str,
            status: conex_db::RunStatus,
            end_reason: Option<&str>,
            cursor: i64,
        ) -> crate::persist::StoreResult<()> {
            self.inner
                .insert_run(run_id, session_id, status, end_reason, cursor)
                .await
        }

        async fn update_run_status(
            &self,
            run_id: &str,
            status: conex_db::RunStatus,
            end_reason: Option<&str>,
            cursor: Option<i64>,
        ) -> crate::persist::StoreResult<()> {
            self.inner
                .update_run_status(run_id, status, end_reason, cursor)
                .await
        }

        async fn reserve_sequence(&self, session_id: &str) -> crate::persist::StoreResult<u64> {
            loop {
                let left = self.remaining.load(std::sync::atomic::Ordering::SeqCst);
                if left == 0 {
                    return self.inner.reserve_sequence(session_id).await;
                }
                if self
                    .remaining
                    .compare_exchange(
                        left,
                        left - 1,
                        std::sync::atomic::Ordering::SeqCst,
                        std::sync::atomic::Ordering::SeqCst,
                    )
                    .is_ok()
                {
                    return Err(StoreError::new("reserve_sequence", "注入取号失败"));
                }
            }
        }

        async fn seed_sequence(
            &self,
            session_id: &str,
            next_sequence: u64,
        ) -> crate::persist::StoreResult<()> {
            self.inner.seed_sequence(session_id, next_sequence).await
        }

        async fn append_event(
            &self,
            session_id: &str,
            sequence: u64,
            event_type: &str,
            payload: &str,
            run_id: Option<&str>,
        ) -> crate::persist::StoreResult<()> {
            self.inner
                .append_event(session_id, sequence, event_type, payload, run_id)
                .await
        }

        async fn query_events(
            &self,
            session_id: &str,
            after_sequence: u64,
            limit: Option<u64>,
        ) -> crate::persist::StoreResult<Vec<crate::persist::PersistedEvent>> {
            self.inner
                .query_events(session_id, after_sequence, limit)
                .await
        }

        async fn query_events_by_run(
            &self,
            session_id: &str,
            run_id: &str,
            after_sequence: u64,
            limit: Option<u64>,
        ) -> crate::persist::StoreResult<Vec<crate::persist::PersistedEvent>> {
            self.inner
                .query_events_by_run(session_id, run_id, after_sequence, limit)
                .await
        }

        async fn max_sequence(&self, session_id: &str) -> crate::persist::StoreResult<u64> {
            self.inner.max_sequence(session_id).await
        }

        async fn query_events_by_type(
            &self,
            session_id: &str,
            run_id: &str,
            event_type: &str,
            after_sequence: u64,
            limit: Option<u64>,
        ) -> crate::persist::StoreResult<Vec<crate::persist::PersistedEvent>> {
            self.inner
                .query_events_by_type(session_id, run_id, event_type, after_sequence, limit)
                .await
        }

        async fn query_runs(&self) -> crate::persist::StoreResult<Vec<conex_db::StoredRun>> {
            self.inner.query_runs().await
        }

        async fn save_pending_input(
            &self,
            id: &str,
            session_id: &str,
            run_id: Option<&str>,
            payload: &str,
        ) -> crate::persist::StoreResult<()> {
            self.inner
                .save_pending_input(id, session_id, run_id, payload)
                .await
        }

        async fn load_pending_inputs(
            &self,
            session_id: &str,
        ) -> crate::persist::StoreResult<Vec<conex_db::PendingInput>> {
            self.inner.load_pending_inputs(session_id).await
        }

        async fn delete_pending_input(&self, id: &str) -> crate::persist::StoreResult<bool> {
            self.inner.delete_pending_input(id).await
        }
    }

    /// C3：取号失败不推进本地镜像；终态经 store.reserve_sequence 重试取号，
    /// 落库序号不与 store 计数器冲突。
    #[tokio::test]
    async fn reserve_failure_does_not_advance_mirror_or_collide_with_store() {
        let mem = Arc::new(InMemoryStore::new());
        let wrapped = Arc::new(FailNReserves::new(mem.clone(), 0));
        let store: Arc<dyn Store> = wrapped.clone();
        let mut queue = EventQueue::new(store.clone(), 1, None);

        let first = queue.push("s1", agent_start()).await.unwrap();
        assert_eq!(first.sequence, 1);
        assert_eq!(queue.next_sequence(), 2);

        wrapped
            .remaining
            .store(1, std::sync::atomic::Ordering::SeqCst);
        let err = queue.push("s1", message_end()).await.unwrap_err();
        assert_eq!(err.error.kind, "reserve_sequence");
        assert_eq!(err.sequence, 1, "失败错误携带上次成功号，不是本地 +1");
        assert_eq!(queue.next_sequence(), 2, "取号失败不得推进本地镜像");

        // 终态：首次 reserve 再失败一次，重试走 store 取到 2
        wrapped
            .remaining
            .store(1, std::sync::atomic::Ordering::SeqCst);
        let terminal = AgentEvent::RunTerminal {
            session_id: "s1".to_string(),
            run_id: "r-c3".to_string(),
            timestamp: ts(),
            terminal: RunTerminalStatus::Failed,
            error: Some("取号重试".to_string()),
        };
        let sequenced = queue.push_terminal_best_effort("s1", terminal).await;
        assert_eq!(sequenced.sequence, 2, "终态号来自 store 重试取号");
        assert!(sequenced.persisted, "重试取号成功后终态应落库");
        assert_eq!(queue.next_sequence(), 3);

        let stored = mem.events();
        let mut seqs: Vec<u64> = stored.iter().map(|e| e.sequence).collect();
        seqs.sort_unstable();
        assert_eq!(seqs, vec![1, 2], "落库序列唯一，终态不与 store 冲突");
        assert_eq!(
            store.reserve_sequence("s1").await.unwrap(),
            3,
            "store 下一号接在终态之后——终态消耗的是 store 槽"
        );
    }

    /// C3：重试仍失败则不落库、不消耗 store 槽；恢复后下一号仍是未分配值。
    #[tokio::test]
    async fn reserve_retry_exhausted_does_not_persist_unallocated_sequence() {
        let mem = Arc::new(InMemoryStore::new());
        let wrapped = Arc::new(FailNReserves::new(mem.clone(), 0));
        let store: Arc<dyn Store> = wrapped.clone();
        let mut queue = EventQueue::new(store.clone(), 1, None);

        assert_eq!(queue.push("s1", agent_start()).await.unwrap().sequence, 1);

        // push_terminal：reserve + 一次重试，共两次取号均失败
        wrapped
            .remaining
            .store(2, std::sync::atomic::Ordering::SeqCst);
        let terminal = AgentEvent::RunTerminal {
            session_id: "s1".to_string(),
            run_id: "r-c3-ex".to_string(),
            timestamp: ts(),
            terminal: RunTerminalStatus::Failed,
            error: Some("store 仍坏".to_string()),
        };
        let sequenced = queue.push_terminal_best_effort("s1", terminal).await;
        assert!(!sequenced.persisted);
        assert_eq!(sequenced.sequence, 1, "未分配新号，返回上次成功号");
        assert_eq!(queue.next_sequence(), 2, "镜像仍停在上次成功号");
        assert_eq!(mem.events().len(), 1, "不得用未分配序号写库");
        assert_eq!(
            store.reserve_sequence("s1").await.unwrap(),
            2,
            "store 计数器未被本地瞎加抢号"
        );
    }

    /// C3：drive 中途取号失败后终态走 store 重试，不复用未分配号写库。
    #[tokio::test]
    async fn drive_outcome_reserve_failure_terminal_retries_store() {
        let mem = Arc::new(InMemoryStore::new());
        let wrapped = Arc::new(FailNReserves::new(mem.clone(), 0));
        let store: Arc<dyn Store> = wrapped.clone();
        let manager = RunManager::new(store.clone());
        let mut run = manager.start_run("s1", "r_c3_drive").await.unwrap();
        let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

        wrapped
            .remaining
            .store(1, std::sync::atomic::Ordering::SeqCst);
        let result = drive_outcome(
            &mut run,
            &mut queue,
            outcome(
                AgentEndReason::Stop,
                vec![agent_start(), agent_end(AgentEndReason::Stop)],
            ),
        )
        .await
        .unwrap();

        assert_eq!(result.terminal_status, RunTerminalStatus::Failed);
        assert_eq!(result.end_reason, EVENT_STORE_WRITE_FAILED_REASON);
        assert_eq!(result.events.len(), 1);
        assert_eq!(result.events[0].sequence, 1, "终态号来自 store 重试");
        assert!(result.events[0].persisted);
        let stored = mem.events();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].event_type, "run-terminal");
        assert_eq!(stored[0].sequence, 1);
        assert_eq!(
            store.reserve_sequence("s1").await.unwrap(),
            2,
            "终态占用 store 槽 1，下一号为 2，无冲突"
        );
    }

    // ── M14（I7 事件源补齐）：session.start/end 映射 + subagent-event 分流 ──

    /// session.start/end 事件源 = run 生命周期既有点位（映射而非重复发射）：
    /// - session.start ← agent-start（session-loop loop/mod.rs run 启动发射，
    ///   本域经 drive_outcome 入队）；
    /// - session.end ← run-terminal（唯一终态事件，只发一次）。
    ///
    /// 断言：一次 run 生命周期恰好发射一个 agent-start 与一个 run-terminal，
    /// 无重复发射（避免双发）。
    #[tokio::test]
    async fn session_start_end_map_to_run_lifecycle_without_duplication() {
        let (mem, store) = setup();
        let manager = RunManager::new(store.clone());
        let mut run = manager.start_run("s1", "r_session_map").await.unwrap();
        let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

        let result = drive_outcome(
            &mut run,
            &mut queue,
            outcome(
                AgentEndReason::Stop,
                vec![agent_start(), agent_end(AgentEndReason::Stop)],
            ),
        )
        .await
        .unwrap();

        let starts = result
            .events
            .iter()
            .filter(|e| matches!(e.event, AgentEvent::AgentStart { .. }))
            .count();
        let terminals = result
            .events
            .iter()
            .filter(|e| matches!(e.event, AgentEvent::RunTerminal { .. }))
            .count();
        assert_eq!(starts, 1, "agent-start（session.start 源）只发一次");
        assert_eq!(terminals, 1, "run-terminal（session.end 源）只发一次");
        // 事件流首尾语义：agent-start 在首、终态在尾（映射表锚点）
        assert!(
            matches!(
                result.events.first().map(|e| &e.event),
                Some(AgentEvent::AgentStart { .. })
            ),
            "session.start 源必须是流首"
        );
        assert!(
            matches!(
                result.events.last().map(|e| &e.event),
                Some(AgentEvent::RunTerminal { .. })
            ),
            "session.end 源必须是流尾"
        );
        // 落库同样恰好一次（Critical 必达）
        assert_eq!(
            mem.events()
                .iter()
                .filter(|e| e.event_type == "agent-start")
                .count(),
            1
        );
        assert_eq!(
            mem.events()
                .iter()
                .filter(|e| e.event_type == "run-terminal")
                .count(),
            1
        );
    }

    /// subagent-event 持久化分流（M14）：progress（Delta）不落库不阻塞；
    /// message/tool（Soft）与 started/ended（Critical）落库
    #[tokio::test]
    async fn subagent_event_progress_is_non_persistent() {
        use conex_types::events::{SubagentEventKind, SubagentEventPayload};

        let progress = AgentEvent::SubagentEvent {
            session_id: "s1".to_string(),
            subagent_id: "sub-1".to_string(),
            subagent_run_id: "sr-1".to_string(),
            event: SubagentEventPayload {
                kind: SubagentEventKind::Progress,
                payload: None,
            },
        };
        let soft = AgentEvent::SubagentEvent {
            session_id: "s1".to_string(),
            subagent_id: "sub-1".to_string(),
            subagent_run_id: "sr-1".to_string(),
            event: SubagentEventPayload {
                kind: SubagentEventKind::Message,
                payload: None,
            },
        };
        assert!(
            is_non_persistent(&progress),
            "progress 类为 Delta：不落库不阻塞 drive loop"
        );
        assert!(
            !is_non_persistent(&soft),
            "message/tool 类为 Soft：尽力落库"
        );
        assert!(!is_non_persistent(&agent_start()), "agent-start 必达落库");
        assert!(
            is_non_persistent(&message_delta(0)),
            "message-delta 保持既有语义"
        );
    }

    // ── T-18（轮次 2 持久层）：压缩事件 → 块行入库（drive 端到端）──

    /// 压缩事件经 drive_outcome 落库 → compression_blocks 同步写入块行：
    /// block_id = record.id、sequence = 事件序列号、generation = 事件计数
    /// （首次 = 1）、dropped 清单、state = awaiting（details 未织入时缺省）。
    #[tokio::test]
    async fn drive_outcome_writes_compression_block_row() {
        let db = conex_db::LocalDb::open_in_memory().unwrap();
        db.insert_session("s1", "s1").unwrap();
        let store: Arc<dyn Store> = Arc::new(LocalDbStore::new(db.clone()));
        let manager = RunManager::new(store.clone());
        let mut run = manager.start_run("s1", "r_compact").await.unwrap();
        let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

        let record = conex_types::tool::ContextCompressionRecord {
            id: "compacted-summary-1-1".to_string(),
            trigger: conex_types::tool::ContextCompressionTrigger::Threshold,
            reason: None,
            policy: None,
            summary: "摘要文本".to_string(),
            first_kept_message_id: Some("u2".to_string()),
            compressed_message_ids: vec!["u1".to_string(), "a1".to_string()],
            kept_message_ids: vec!["u2".to_string(), "a2".to_string()],
            tokens_before: 10_000,
            tokens_after: 2_000,
            threshold_tokens: None,
            created_at: ts(),
            handoff: None,
            cache_boundary: None,
            details: None,
        };
        let events = vec![
            agent_start(),
            AgentEvent::ContextCompressionEnd {
                session_id: "s1".to_string(),
                timestamp: ts(),
                result: Some(record),
                aborted: false,
                error: None,
            },
            agent_end(AgentEndReason::Stop),
        ];

        let result = drive_outcome(&mut run, &mut queue, outcome(AgentEndReason::Stop, events))
            .await
            .unwrap();
        assert!(result.persist_failure.is_none(), "压缩事件应落库成功");

        // 压缩事件序列号（agent-start=1 → compression=2）
        let compression_seq = result
            .events
            .iter()
            .find(|e| matches!(e.event, AgentEvent::ContextCompressionEnd { .. }))
            .expect("压缩事件在流中")
            .sequence;
        assert_eq!(compression_seq, 2);

        // 块行已写入（sequence 与事件一致；generation = 会话压缩事件计数）
        let block = db
            .get_block("s1", "compacted-summary-1-1")
            .unwrap()
            .expect("块行应已入库");
        assert_eq!(block.sequence, 2, "块行 sequence = 压缩事件序列号");
        assert_eq!(block.generation, 1, "首次压缩代数 = 1");
        assert_eq!(
            block.dropped_message_ids,
            vec!["u1".to_string(), "a1".to_string()]
        );
        assert_eq!(block.state, conex_db::BlockState::Awaiting);
        assert_eq!(db.count_blocks("s1").unwrap(), 1);
        // 落库事件原文与块行同源（原文回放面不受块表影响）
        let stored = db.query_events("s1", 0, None).unwrap();
        assert!(stored
            .iter()
            .any(|e| e.event_type == "context-compression-end"));
    }

    /// 块行幂等：drive 重放（同事件再次驱动）不产生重复行——INSERT OR
    /// IGNORE 语义在 drive 面成立。
    #[tokio::test]
    async fn drive_outcome_compression_block_replay_idempotent() {
        let db = conex_db::LocalDb::open_in_memory().unwrap();
        db.insert_session("s1", "s1").unwrap();
        let store: Arc<dyn Store> = Arc::new(LocalDbStore::new(db.clone()));
        let manager = RunManager::new(store.clone());

        let compression = |id: &str| AgentEvent::ContextCompressionEnd {
            session_id: "s1".to_string(),
            timestamp: ts(),
            result: Some(conex_types::tool::ContextCompressionRecord {
                id: id.to_string(),
                trigger: conex_types::tool::ContextCompressionTrigger::Threshold,
                reason: None,
                policy: None,
                summary: "摘要".to_string(),
                first_kept_message_id: Some("u2".to_string()),
                compressed_message_ids: vec!["u1".to_string()],
                kept_message_ids: vec!["u2".to_string()],
                tokens_before: 100,
                tokens_after: 10,
                threshold_tokens: None,
                created_at: ts(),
                handoff: None,
                cache_boundary: None,
                details: None,
            }),
            aborted: false,
            error: None,
        };

        let mut run = manager.start_run("s1", "r_c1").await.unwrap();
        let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);
        drive_outcome(
            &mut run,
            &mut queue,
            outcome(
                AgentEndReason::Stop,
                vec![
                    agent_start(),
                    compression("b1"),
                    agent_end(AgentEndReason::Stop),
                ],
            ),
        )
        .await
        .unwrap();
        assert_eq!(db.count_blocks("s1").unwrap(), 1);

        // 再次驱动同内容事件（模拟重放）：同 block_id 不产生第二行
        let mut run2 = manager.start_run("s1", "r_c2").await.unwrap();
        let mut queue2 = EventQueue::new(store.clone(), run2.cursor + 1, None);
        drive_outcome(
            &mut run2,
            &mut queue2,
            outcome(
                AgentEndReason::Stop,
                vec![
                    agent_start(),
                    compression("b1"),
                    agent_end(AgentEndReason::Stop),
                ],
            ),
        )
        .await
        .unwrap();
        assert_eq!(
            db.count_blocks("s1").unwrap(),
            1,
            "同 block_id 重放不重复行"
        );
    }

    // ── D-01 DM-04：run 归属列 + 信封落库 + goal-* 轮次域 ──

    /// D-01 DM-04 验收锚：落库行 run_id 列 == 构造绑定值 && payload 为
    /// 完整信封（runId/sequence/schemaVersion 齐全）且信封 runId == 列值
    /// （列 + 信封并用不变量：同一注入点产出，防双写漂移，01 §2.1）
    #[tokio::test]
    async fn eventqueue_envelope_matches_column() {
        let (mem, store) = setup();
        let mut queue = EventQueue::new(store, 1, Some("r-main".to_string()));
        queue.push("s1", agent_start()).await.unwrap();

        let stored = mem.events();
        assert_eq!(stored.len(), 1);
        let row = &stored[0];
        assert_eq!(row.run_id.as_deref(), Some("r-main"), "列值 = 构造绑定值");
        let envelope: AgentEventEnvelope =
            serde_json::from_str(&row.payload).expect("落库 payload 应为完整信封 JSON");
        assert_eq!(
            envelope.run_id.as_deref(),
            Some("r-main"),
            "信封 runId == 列值"
        );
        assert_eq!(envelope.sequence, Some(1), "信封携带 sequence");
        assert_eq!(envelope.schema_version, 1, "信封携带 schemaVersion");
        let wire = serde_json::to_value(&envelope).unwrap();
        assert_eq!(wire["type"], "agent-start");
        assert_eq!(
            wire["sessionId"], "s1",
            "事件体 sessionId 在场（与广播 wire 同构）"
        );
    }

    /// D-01 DM-04 验收锚：绑 None 落库 = 会话域事件——按 run 查询不命中、
    /// 按会话查询命中（事件行 run_id 列 NULL）
    #[tokio::test]
    async fn eventqueue_nomaster_event_run_id_none() {
        let (mem, store) = setup();
        let mut queue = EventQueue::new(store.clone(), 1, None);
        queue.push("s1", agent_start()).await.unwrap();

        let stored = mem.events();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].run_id, None, "绑 None → 列值 NULL");
        let envelope: AgentEventEnvelope = serde_json::from_str(&stored[0].payload).unwrap();
        assert_eq!(envelope.run_id, None, "信封无 runId");

        let by_run = store
            .query_events_by_run("s1", "any-run", 0, None)
            .await
            .unwrap();
        assert!(by_run.is_empty(), "会话域事件不命中 run 查询");
        let by_session = store.query_events("s1", 0, None).await.unwrap();
        assert_eq!(by_session.len(), 1, "按会话查询命中");
    }

    /// D-01 DM-04 验收锚：goal-* 轮次域（R-06）——三事件落库行 run_id 列
    /// NULL 且 payload 信封 runId 为 None（不归任何 run，run 查询天然不命中）
    #[tokio::test]
    async fn eventqueue_goal_event_round_domain() {
        let (mem, store) = setup();
        let mut queue = EventQueue::new(store.clone(), 1, Some("r-goal".to_string()));

        let goal_events = [
            AgentEvent::GoalRoundStarted {
                round: 1,
                max_rounds: 3,
                goal: "调研 X".to_string(),
            },
            AgentEvent::GoalRoundCompleted {
                round: 1,
                tool_call_count: 2,
                tool_success_count: 2,
                message_count: 3,
                decision: "Continue".to_string(),
                reason_detail: "继续".to_string(),
                stalled_delta: 0,
                evidence: String::new(),
            },
            AgentEvent::GoalContinuationDecided {
                action: "continue".to_string(),
                reason: "继续".to_string(),
                prompt: None,
                progress_signature: None,
                detail: None,
            },
        ];
        for (index, event) in goal_events.into_iter().enumerate() {
            let sequence = queue.push("s1", event).await.unwrap().sequence;
            let stored = mem.events();
            let row = stored
                .iter()
                .find(|e| e.sequence == sequence)
                .expect("goal 事件应落库");
            assert_eq!(row.run_id, None, "goal-* 列 run_id = NULL（轮次域）");
            let envelope: AgentEventEnvelope = serde_json::from_str(&row.payload).unwrap();
            assert_eq!(envelope.run_id, None, "goal-* 信封无 runId");
            assert_eq!(envelope.sequence, Some(sequence));
            assert_eq!(index as u64 + 1, sequence, "goal 三事件顺序落库");
        }

        // run 查询不含 goal-*（列 NULL 不命中）；按会话查询命中
        let by_run = store
            .query_events_by_run("s1", "r-goal", 0, None)
            .await
            .unwrap();
        assert!(by_run.is_empty(), "轮次域事件不命中 run 查询");
        let by_session = store.query_events("s1", 0, None).await.unwrap();
        assert_eq!(by_session.len(), 3, "按会话查询命中（会话域可见）");
    }

    /// D-01 DM-04 验收锚：normalize_envelope 语义在落库面生效——事件体空
    /// sessionId 被补全、run-terminal 事件体空 runId 被补齐（normalize.rs
    /// :99-131 语义从「仅测试调用的名义注入点」变为实际落库注入点）
    #[tokio::test]
    async fn eventqueue_normalize_envelope_wired_on_persist() {
        let (mem, store) = setup();
        let mut queue = EventQueue::new(store, 1, Some("r-main".to_string()));

        // 事件体空 sessionId → normalize 补会话
        let mut start = agent_start();
        if let AgentEvent::AgentStart { session_id, .. } = &mut start {
            session_id.clear();
        }
        queue.push("s1", start).await.unwrap();
        let row = &mem.events()[0];
        let envelope: AgentEventEnvelope = serde_json::from_str(&row.payload).unwrap();
        match &envelope.event {
            AgentEvent::AgentStart { session_id, .. } => {
                assert_eq!(session_id, "s1", "事件体空 sessionId 被补全");
            }
            other => panic!("事件类型不符：{other:?}"),
        }

        // run-terminal 事件体空 runId → normalize 用队列绑定 runId 补齐
        let terminal = AgentEvent::RunTerminal {
            session_id: "s1".to_string(),
            run_id: String::new(),
            timestamp: ts(),
            terminal: RunTerminalStatus::Completed,
            error: None,
        };
        queue.push("s1", terminal).await.unwrap();
        let row = &mem.events()[1];
        let envelope: AgentEventEnvelope = serde_json::from_str(&row.payload).unwrap();
        assert_eq!(
            envelope.run_id.as_deref(),
            Some("r-main"),
            "信封 runId 在场"
        );
        match &envelope.event {
            AgentEvent::RunTerminal { run_id, .. } => {
                assert_eq!(run_id, "r-main", "终态事件体 runId 补齐（03 §5.1-16）");
            }
            other => panic!("事件类型不符：{other:?}"),
        }
    }

    // ── R1 撤回边界冻结护栏（详案 §1.2-③ FREEZE1/FREEZE2）──

    /// FREEZE1（写侧隔离硬验收）：冻结激活期内 `sequence > frozen_seq`
    /// 的非撤离写入被拒（RetractionFreeze 可判定），撤离事件
    /// （timeline-truncate / run-terminal）放行；释放后写入恢复。
    ///
    /// 并发语义：冻结读点 = 稳定点 MAX(sequence)，护栏拒绝即「截断后无
    /// 新事件越过 boundary」（events 表在 TimelineTruncate 之后无
    /// `> boundary_seq` 的非撤离事件）。
    #[tokio::test]
    async fn freeze_guard_rejects_crossing_writes_and_allows_evacuation() {
        let (mem, store) = setup();
        let registry = std::sync::Arc::new(session_loop::SessionFreezeRegistry::new());
        let mut queue = EventQueue::new(store, 1, None).with_freeze_registry(registry.clone());

        // 基线：agent-start 落库（sequence=1）——冻结读点前的历史
        queue.push("s1", agent_start()).await.unwrap();
        assert_eq!(mem.events().len(), 1);

        // 冻结激活：frozen_seq = 1（稳定点 MAX；本撤回事务内不再被越过）
        registry.freeze("s1", "retraction:s1", 1).unwrap();

        // 非撤离写入（agent-start，sequence=2 > frozen_seq=1）→ 拒绝
        //（agent-end / run-terminal 为 run 收口终态撤离事件，放行面见下）
        let err = queue.push("s1", agent_start()).await.unwrap_err();
        assert!(
            err.is_retraction_freeze(),
            "越界写入必须是可判定的 RetractionFreeze（kind={}）",
            err.error.kind
        );
        assert_eq!(err.sequence, 2, "拒绝携带已分配的越界序列");
        assert_eq!(
            mem.events().len(),
            1,
            "被拒事件不得落库（截断后无越过 boundary 的新事件）"
        );

        // 撤离事件放行：timeline-truncate（自身占 sequence = frozen_seq + 1）
        let truncate = AgentEvent::TimelineTruncate {
            session_id: "s1".to_string(),
            run_id: "run-1".to_string(),
            boundary_seq: 1,
            reason: conex_types::events::TimelineTruncateReason::UserRequested,
            target_message_id: "msg-1".to_string(),
            timestamp: ts(),
        };
        let seq = queue.push("s1", truncate).await.unwrap();
        assert_eq!(
            seq.sequence, 2,
            "TimelineTruncate.sequence == frozen_seq + 1"
        );
        assert!(seq.persisted, "timeline-truncate Critical 必达落库");
        assert_eq!(mem.events().len(), 2);

        // run-terminal（run 收口终态事件）同为撤离面放行
        let terminal = AgentEvent::RunTerminal {
            session_id: "s1".to_string(),
            run_id: "run-1".to_string(),
            timestamp: ts(),
            terminal: RunTerminalStatus::Cancelled,
            error: None,
        };
        queue.push("s1", terminal).await.unwrap();
        assert_eq!(mem.events().len(), 3);

        // 冻结期内另一会话不受影响（会话级隔离）
        assert_eq!(queue.push("s2", agent_start()).await.unwrap().sequence, 1);

        // 释放后写入恢复（新 run 从 boundary 后重新开始）
        registry.release("s1", "retraction:s1").unwrap();
        let ok = queue
            .push("s1", agent_end(AgentEndReason::Stop))
            .await
            .unwrap();
        assert_eq!(ok.sequence, 4, "释放后新写入放行（归新 run 语义）");
    }

    /// FREEZE2（原子性）：冻结读点 == 事件流停止写入点——冻结登记后
    /// 连续越界写入全部被拒（无撕裂），boundary 恒为登记时的 frozen_seq
    #[tokio::test]
    async fn freeze_boundary_is_stable_under_concurrent_residual_writes() {
        let (mem, store) = setup();
        let registry = std::sync::Arc::new(session_loop::SessionFreezeRegistry::new());
        let mut queue = EventQueue::new(store, 1, None).with_freeze_registry(registry.clone());

        queue.push("s1", agent_start()).await.unwrap();
        let frozen_seq = 1;
        registry.freeze("s1", "tok", frozen_seq).unwrap();

        // 模拟 stop 收敛后的残余写入风暴：全部应被拒，边界不被抬高
        for _ in 0..5 {
            let err = queue.push("s1", agent_start()).await.unwrap_err();
            assert!(err.is_retraction_freeze());
        }
        assert_eq!(
            registry.frozen_seq("s1"),
            Some(frozen_seq),
            "冻结边界在残余写入下不被抬高（MAX 语义不回退，护栏不漂移）"
        );
        assert_eq!(mem.events().len(), 1, "残余写入全部被拒，无越界落库");

        // 双撤回互斥（FREEZE3 写侧）：同会话第二次冻结拒绝
        assert_eq!(
            registry.freeze("s1", "tok-2", 9),
            Err(session_loop::FreezeError::AlreadyFrozen {
                token: "tok".to_string()
            })
        );
        registry.release("s1", "tok").unwrap();
    }
}
