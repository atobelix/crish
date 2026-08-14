// SR-06d · 拆分 · ≠ EL：restore.rs 逻辑域拆模 2/2 —— 重启恢复管理器
// （原 restore.rs 535-817 区间原样迁入，公开面经 restore.rs `pub use`
// 重导出，语义零改动）。

use std::collections::HashSet;

use conex_db::RunStatus;
use conex_types::events::AgentEvent;

use super::{
    CANCEL_INTERRUPTED_ERROR, INTERRUPTED_ERROR, INTERRUPTED_REASON,
    ReconcileConflict, RestoreError, RestoreMode, RestoreOutcome, RUN_INTERRUPTED_EVENT,
};
use crate::persist::{Store, StoreError};
use crate::session::{CONTEXT_COMPRESSION_END_EVENT, SESSION_LEAF_MOVED_EVENT, SessionRecord};
use crate::now_ms;

/// 重启恢复管理器（B4.3）
pub struct RestoreManager;

impl RestoreManager {
    /// 新建恢复管理器
    pub fn new() -> Self {
        Self
    }

    /// 重启恢复主流程（05 §5.4 run::restore / store::pending）
    ///
    /// 流程：
    /// 1. 快照加载（checksum 校验；损坏回退备份快照；无快照 → 全量重放）；
    /// 2. 从 Store 全量扫描 runs；
    /// 3. in-flight run → 终态 interrupted（update_run_status +
    ///    `run-interrupted` 审计事件，previousStatus 可追溯）；
    ///    blocked 与其它终态记录原样保留不打断；
    /// 4. 会话记录组装（快照会话 ∪ run 派生会话）；
    /// 5. 增量流：lastSequence 后事件重放（session-leaf-moved 重放叶子
    ///    移动；last_sequence 推进到最大序列，作为后续增量流锚点）；
    /// 6. pending 输入恢复（load_pending_inputs，FIFO）。
    ///
    /// 快照保存由调用方在恢复成功后执行（恢复本身只读；对齐 TS
    /// 「After successful restore (full or incremental)」写策略）。
    pub async fn restore(
        &self,
        store: &dyn Store,
        snapshots: &dyn super::SnapshotStore,
    ) -> Result<RestoreOutcome, RestoreError> {
        // 1. 快照加载（损坏 → 回退上一完好备份）
        let (snapshot, snapshot_note) = snapshots.load_snapshot()?;
        let mode = if snapshot.is_some() {
            RestoreMode::SnapshotIncremental
        } else {
            RestoreMode::FullReplay
        };

        // 2. runs 全量扫描（run 表为权威数据源）
        let mut runs = store.query_runs().await?;

        // 3. in-flight → interrupted（previousStatus 审计）；未知字面量
        //    保真保留（is_inflight 已滤）并显式上报
        let mut interrupted = Vec::new();
        let mut unknown_status_runs = Vec::new();
        for run in runs.iter_mut() {
            if !is_inflight(run.status.clone()) {
                // 未知字面量：不打断、不改写，显式上报（裁决 D3 诚实滞留）
                if let RunStatus::Unknown(literal) = &run.status {
                    tracing::warn!(
                        target: "restore",
                        run_id = %run.run_id,
                        status = %literal,
                        "未知状态字面量保留（不打断、不改写）"
                    );
                    unknown_status_runs.push((run.run_id.clone(), literal.clone()));
                }
                continue;
            }
            let previous_status = run.status.clone();
            let (db_status, error) = match previous_status {
                // 取消流程被打断 → cancelled；其余 in-flight → failed
                RunStatus::Cancelling => (RunStatus::Cancelled, CANCEL_INTERRUPTED_ERROR),
                _ => (RunStatus::Failed, INTERRUPTED_ERROR),
            };

            // 审计事件：previousStatus 落库，终态变化可追溯
            let record = super::InterruptedRun {
                run_id: run.run_id.clone(),
                session_id: run.session_id.clone(),
                previous_status: previous_status.as_str().to_string(),
                status: db_status.as_str().to_string(),
                reason: INTERRUPTED_REASON.to_string(),
                error: error.to_string(),
                timestamp: now_ms(),
            };
            // DM-05：payload 补顶层 type 键——run-interrupted 非 AgentEvent
            // 枚举成员（不扩枚举，保持自定义审计事件形态），读侧 D8
            // fallback 以 type 键路由；InterruptedRun 自身带 runId/sessionId
            // 字段，归属可还原
            let mut payload = serde_json::to_value(&record).map_err(|e| {
                RestoreError::new("serialize_interrupted", e.to_string())
            })?;
            if let Some(obj) = payload.as_object_mut() {
                obj.insert(
                    "type".to_string(),
                    serde_json::Value::String(RUN_INTERRUPTED_EVENT.to_string()),
                );
            }
            let payload = serde_json::to_string(&payload).map_err(|e| {
                RestoreError::new("serialize_interrupted", e.to_string())
            })?;
            let sequence = next_sequence(store, &run.session_id).await?;
            // T08.4：打断路径写 cursor = 审计事件前会话最大已落库序列
            // （sequence-1，T08.8 的 sequence 口径）
            let cursor = sequence.saturating_sub(1);
            store
                .update_run_status(
                    &run.run_id,
                    db_status.clone(),
                    Some(INTERRUPTED_REASON),
                    Some(cursor as i64),
                )
                .await?;
            // DM-05：落库 run_id 列 = 被打断 run 的真实 run_id（DM-03
            // Store::append_event 签名已落地；读侧按 run 查询可命中）
            store
                .append_event(
                    &run.session_id,
                    sequence,
                    RUN_INTERRUPTED_EVENT,
                    &payload,
                    Some(&run.run_id),
                )
                .await?;
            run.status = db_status;
            run.end_reason = Some(INTERRUPTED_REASON.to_string());
            run.cursor = cursor as i64;
            run.updated_at = now_ms();
            interrupted.push(record);
        }

        // 3b. session_agents 残留 running 归一（PERSIST-02 P1-3）：子代理
        // 运行中崩溃 → 行 status 残留 running；不归一则 FlowScheduler::load
        // 重建为 Running 节点，is_ready 要求 Pending → 永不重派发、流程
        // 永久卡死（flow_graph.rs:1473-1476）。与主 run 打断对称（kill_all
        // 语义）：running → failed + ended_at 落库。仅 LocalDb 路径可用
        // （as_local_db 下转；InMemoryStore 等测试替身无 session_agents 面，
        // 跳过——生产恒为 LocalDbStore）
        if let Some(db) = store.as_local_db() {
            let running_rows = db.load_running_session_agents().map_err(|e| {
                RestoreError::new("load_running_session_agents", e.to_string())
            })?;
            if !running_rows.is_empty() {
                let ended_at = now_ms();
                for (session_id, subagent_run_id) in &running_rows {
                    let affected = db
                        .update_session_agent_status(
                            session_id,
                            subagent_run_id,
                            "failed",
                            Some(ended_at),
                        )
                        .map_err(|e| {
                            RestoreError::new("normalize_session_agent", e.to_string())
                        })?;
                    if affected == 0 {
                        tracing::warn!(
                            target: "restore",
                            session_id,
                            subagent_run_id,
                            "归一目标行已消失，跳过"
                        );
                    } else {
                        tracing::info!(
                            target: "restore",
                            session_id,
                            subagent_run_id,
                            "session_agents running 行归一 failed（崩溃恢复）"
                        );
                    }
                }
            }
        }

        // 3c. G-29 终态矛盾对账（DM-08）：只读校验 events 表 run-terminal
        // 与 runs 记录终态的矛盾，显式上报（tracing::warn + outcome 计数），
        // **不自动修正**（不翻写 runs 表、不改事件——修正语义归恢复策略
        // 后续裁决）。注意：打断循环已就地更新 run.status（failed/cancelled），
        // 对账看到的是打断后终态——「事件说 completed、记录说 failed」矛盾
        // 即在本步暴露。
        let reconcile_conflicts =
            reconcile_terminal_conflicts(store, &runs).await?;
        for conflict in &reconcile_conflicts {
            tracing::warn!(
                target: "restore",
                run_id = %conflict.run_id,
                session_id = %conflict.session_id,
                event_terminal = %conflict.event_terminal,
                record_status = %conflict.record_status,
                "G-29 终态矛盾对账：事件流 run-terminal 与 runs 记录终态矛盾（只上报不修正）"
            );
        }

        // 4. 会话记录组装（快照会话 ∪ run 派生会话）
        let mut sessions: Vec<SessionRecord> = snapshot
            .as_ref()
            .map(|snap| snap.sessions.clone())
            .unwrap_or_default();
        for run in &runs {
            if !sessions.iter().any(|s| s.session_id == run.session_id) {
                sessions.push(SessionRecord {
                    session_id: run.session_id.clone(),
                    current_leaf_id: None,
                    branches: Vec::new(),
                    // 新派生会话无压缩护栏（None）；其护栏经第 5 步事件重放
                    // 从 0 全量重建（快照会话则从快照 meta 续接增量）
                    context_meta: None,
                });
            }
        }

        // 5. 增量流：lastSequence 后事件重放（会话树叶子移动 + 压缩护栏
        //    重建）+ 锚点推进
        // P1-1：snapshot_session_ids 取**快照自身**会话集合（派生会话不在
        // 内 → 从 0 全量，不再被全局 max 误伤）
        let snapshot_session_ids: HashSet<&str> = snapshot
            .as_ref()
            .map(|snap| {
                snap.sessions
                    .iter()
                    .map(|s| s.session_id.as_str())
                    .collect()
            })
            .unwrap_or_default();
        let base_sequence = snapshot.as_ref().map(|snap| snap.last_sequence).unwrap_or(0);
        let mut last_sequence = base_sequence;
        for session in &mut sessions {
            // P1-1：会话级 base = 该会话自身已重放的最大序列（快照逐会话
            // 锚点 session_last_sequence）——事件序列为会话内独立，全局
            // max 作会话级 base 会永久跳过落后会话的快照后事件；旧快照无
            // 逐会话锚点 → serde default 空表 → 回退全局 last_sequence
            // （兼容旧语义）；派生会话（快照后出现）从 0 全量
            let base = if snapshot_session_ids.contains(session.session_id.as_str()) {
                snapshot
                    .as_ref()
                    .and_then(|snap| {
                        snap.session_last_sequence.get(&session.session_id)
                    })
                    .copied()
                    .unwrap_or(base_sequence)
            } else {
                0
            };
            let events = store.query_events(&session.session_id, base, None).await?;
            for event in &events {
                last_sequence = last_sequence.max(event.sequence);
                if event.event_type == SESSION_LEAF_MOVED_EVENT {
                    // 叶子移动重放（载荷损坏时跳过，不中断恢复）
                    let _ = session.apply_leaf_move_event(&event.payload);
                } else if event.event_type == CONTEXT_COMPRESSION_END_EVENT {
                    // 压缩护栏重放（P4 阶段 5-1）：context-compression-end
                    // 事件折叠进会话上下文元数据——快照会话增量续接、
                    // 派生会话全量重建（事件时间戳不可解析时保持既有状态）
                    let _ = serde_json::from_str::<AgentEvent>(&event.payload).map(|e| {
                        if let AgentEvent::ContextCompressionEnd { timestamp, .. } = e {
                            session.apply_compression_end(event.sequence, &timestamp);
                        }
                    });
                }
            }
        }

        // 6. pending 输入恢复（FIFO：创建时间升序，含 id 决胜）
        let mut pending_inputs = Vec::new();
        for session in &sessions {
            pending_inputs.extend(store.load_pending_inputs(&session.session_id).await?);
        }

        Ok(RestoreOutcome {
            mode,
            sessions,
            runs,
            pending_inputs,
            interrupted,
            unknown_status_runs,
            last_sequence,
            snapshot_note,
            snapshot_generation: snapshot
                .as_ref()
                .map(|snap| snap.generation)
                .unwrap_or(0),
            reconcile_conflicts,
        })
    }
}

impl Default for RestoreManager {
    fn default() -> Self {
        Self::new()
    }
}

/// 是否 in-flight 状态（重启时需打断为 interrupted；05 §2.8:404；
/// 11-T4：completing 收口被打断 → failed，不再永久卡 completing；
/// 裁决 D3：Unknown 保真不打断——未知字面量无法区分中间态与终态，
/// 打断=改写对可能已完成的 run 是破坏性操作）
pub(crate) fn is_inflight(status: RunStatus) -> bool {
    match status {
        // 五态 + completing（11-T4）→ in-flight
        RunStatus::Queued
        | RunStatus::Initializing
        | RunStatus::Running
        | RunStatus::AwaitingApproval
        | RunStatus::Cancelling
        | RunStatus::Completing => true,
        // 未知字面量保真保留、不打断（裁决 D3，显式列出防默认臂误命中）
        RunStatus::Unknown(_) => false,
        // 终态不打断
        RunStatus::Completed | RunStatus::Failed | RunStatus::Cancelled => false,
    }
}

/// 会话内下一个可用序列号（恢复审计事件续接用）
async fn next_sequence(store: &dyn Store, session_id: &str) -> Result<u64, StoreError> {
    // limit=None：全量读取取 max（DM-03 签名已加 limit 参数，无限制
    // 等价旧语义）
    let events = store.query_events(session_id, 0, None).await?;
    Ok(events
        .iter()
        .map(|event| event.sequence)
        .max()
        .unwrap_or(0)
        + 1)
}

/// G-29 终态矛盾对账（DM-08）：只读校验 events 表 run-terminal 与 runs
/// 记录终态的矛盾（**只上报不修正**——不翻写 runs 表、不改事件）。
///
/// 语义（对账范围刻意收敛，防误报）：
/// - **事件说终态、记录说失败/取消**：runs 终态字面量为 failed / cancelled
///   （含本次被打断的 run）但 events 存在该 run 的 run-terminal 事件 →
///   事件流已完成收口、记录却为失败/取消，矛盾；
/// - **记录说完成、事件无终态**：runs 终态字面量为 completed 但 events
///   无该 run 的 run-terminal 事件 → 记录说完成、事件流无终态，矛盾；
/// - **不检查 failed 的「无 terminal」反向**：写失败收场
///   （event-store-write-failed，T12.7）合法无 run-terminal 事件，不误报；
/// - **不检查 cancelled 的「无 terminal」反向**：取消路径终态事件面未
///   定（cancel.rs 域），避免误报；
/// - **不检查 Unknown 字面量**：诚实未知（裁决 D3），不臆断。
///
/// 每个 run 一次 `query_events_by_run`（run 事件全量，limit=None——run 首
/// 事件是 agent-start 而非 run-terminal，limit=1 会截断漏检；run 事件数
/// 通常远小于会话全量，restore 为冷启动路径可接受），restore 整体
/// O(runs × run 事件数) 只读查询。
async fn reconcile_terminal_conflicts(
    store: &dyn Store,
    runs: &[conex_db::StoredRun],
) -> Result<Vec<ReconcileConflict>, StoreError> {
    let mut conflicts = Vec::new();
    for run in runs {
        let events = store
            .query_events_by_run(&run.session_id, &run.run_id, 0, None)
            .await?;
        let terminal = events
            .iter()
            .find(|e| e.event_type == "run-terminal")
            .map(|e| e.payload.as_str());
        let has_terminal = terminal.is_some();
        // 事件流终态字面量：payload terminal 键优先，解析失败回退事件类型名
        let event_terminal = || {
            terminal
                .and_then(|p| serde_json::from_str::<serde_json::Value>(p).ok())
                .and_then(|v| {
                    v.get("terminal")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_else(|| "run-terminal".to_string())
        };
        let mismatch = match &run.status {
            // 事件说终态、记录说失败/取消 → 矛盾
            RunStatus::Failed | RunStatus::Cancelled => has_terminal,
            // 记录说完成、事件流无终态 → 矛盾
            RunStatus::Completed => !has_terminal,
            // Unknown / 中间态：打断语义已处理，对账不介入
            _ => false,
        };
        if mismatch {
            conflicts.push(ReconcileConflict {
                run_id: run.run_id.clone(),
                session_id: run.session_id.clone(),
                event_terminal: event_terminal(),
                record_status: run.status.as_str().to_string(),
            });
        }
    }
    Ok(conflicts)
}

/// blocked 类终态 reason（B4.5 goal 语义：goal-blocked / goal-max-rounds /
/// goal-stalled）。
///
/// blocked 以 Failed 终态 + 上述 reason 落库，属终态记录；恢复时
/// 「原样保留不打断」由终态保真路径保证（本函数供审计/断言使用）。
pub fn is_blocked_reason(reason: Option<&str>) -> bool {
    matches!(
        reason,
        Some("goal-blocked") | Some("goal-max-rounds") | Some("goal-stalled")
    )
}
