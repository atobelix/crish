//! run 结果驱入事件队列并收口终态（05 §5.4 run::drive / run::fail，自 events.rs 纯搬迁）

use conex_types::events::{AgentEvent, RunTerminalStatus};
use conex_types::session::AgentEndReason;
use session_loop::RunOutcome;

use super::{EventQueue, SequencedEvent};
use crate::blocks::persist_compression_block;
use crate::persist::StoreError;
use crate::run::{map_outcome_to_terminal, RunError, RunHandle, EVENT_STORE_WRITE_FAILED_REASON};
use conex_shared::time::now_iso_utc;

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

    // 1. 事件分流推送（NoPersist-first：delta 不取号不落库不阻塞；
    //    持久化事件同步等待）
    for event in outcome.events {
        match queue.push(&run.session_id, event).await {
            Ok(sequenced) => {
                // N2（T-D1-A）：cursor 仅随已取号事件单调推进——NoPersist
                // 的 sequence = last_reserved（未推进），禁止把 cursor
                // 改回更小值（夹心批安全）。
                if sequenced.persisted {
                    run.cursor = sequenced.sequence;
                }
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
