// SR-06d · 拆分 · ≠ EL：restore.rs 逻辑域拆模 2/2 —— 重启恢复管理器
// （原 restore.rs 535-817 区间原样迁入，公开面经 restore.rs `pub use`
// 重导出，语义零改动）。

use std::collections::{HashMap, HashSet};
use std::str::FromStr;

use conex_db::RunStatus;
use conex_types::events::AgentEvent;

use super::{
    HealedToolRecord, RestoreError, RestoreMode, RestoreOutcome, CANCEL_INTERRUPTED_ERROR,
    INTERRUPTED_ERROR, INTERRUPTED_REASON, RUN_INTERRUPTED_EVENT,
};
use crate::now_ms;
use crate::persist::{PersistedEvent, Store, StoreError};
use crate::session::{SessionRecord, CONTEXT_COMPRESSION_END_EVENT, SESSION_LEAF_MOVED_EVENT};

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
    /// 3. **事件权威前置决策**（04 §4.2 契约补丁）：先批量拉齐全部
    ///    `run-terminal` 事件，再单遍收敛——有终态事件则单向覆盖 runs 表
    ///    （绝不打断、绝不写 run-interrupted）；无终态且在途才打断；
    ///    无终态且 Completed → unbacked Failed 纠偏；Unknown 保真；
    /// 3b. session_agents 残留 running 归一；
    /// 3c. 冷启动孤儿工具自愈（04 §5 / D-3）：ToolStart 无 ToolEnd → CAS
    ///    幂等补齐 ToolEnd；声明但连 ToolStart 都无 → 补齐 ToolStart+ToolEnd
    ///    （ToolOutcomeUnknown）；
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

        // 3. 事件权威前置决策（04 §4.2 契约补丁：先批量拉齐全部
        //    run-terminal，再单遍收敛；禁止 per-run N+1）
        let terminal_by_key = load_terminal_map(store, &runs).await?;

        let mut interrupted = Vec::new();
        let mut unknown_status_runs = Vec::new();
        for run in runs.iter_mut() {
            let terminal_payload = terminal_by_key
                .get(&(run.session_id.clone(), run.run_id.clone()))
                .map(|s| s.as_str());

            if let Some(payload_str) = terminal_payload {
                // ─────────────────────────────────────────────────────
                // 分支 A：events 表存在终态事件 → 事件流已权威收口（SSOT）
                // ─────────────────────────────────────────────────────
                let event_terminal_str = serde_json::from_str::<serde_json::Value>(payload_str)
                    .ok()
                    .and_then(|v| {
                        v.get("terminal")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_string)
                    })
                    .unwrap_or_else(|| "run-terminal".to_string());

                let authoritative_status = match RunStatus::from_str(&event_terminal_str) {
                    Ok(s) => s,
                    Err(_) => {
                        // 契约补丁：无法解析的终态字面量 → Unknown 保真，禁止臆造 Failed
                        RunStatus::Unknown(event_terminal_str)
                    }
                };

                if run.status != authoritative_status {
                    // 物化表落后或撕裂：单向权威强制覆盖 runs 表！
                    tracing::info!(
                        target: "restore",
                        run_id = %run.run_id,
                        session_id = %run.session_id,
                        old_status = %run.status.as_str(),
                        authoritative_status = %authoritative_status.as_str(),
                        "G-29 根治：依据 events 表法定终态强制单向收敛覆盖 runs 表记录"
                    );

                    store
                        .update_run_status(
                            &run.run_id,
                            authoritative_status.clone(),
                            None, // 保留原 end_reason
                            None,
                        )
                        .await?;

                    run.status = authoritative_status;
                    run.updated_at = now_ms();
                }
                // 关键断言：绝对不打断！绝对不写 run-interrupted 虚假审计事件！
                continue;
            }

            // ─────────────────────────────────────────────────────────
            // 分支 B：events 表不存在 run-terminal 事件 → 依据状态机规则决断
            // ─────────────────────────────────────────────────────────
            if is_inflight(run.status.clone()) {
                // 确属崩溃打断的在途任务：执行真实打断流程
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
                let mut payload = serde_json::to_value(&record)
                    .map_err(|e| RestoreError::new("serialize_interrupted", e.to_string()))?;
                if let Some(obj) = payload.as_object_mut() {
                    obj.insert(
                        "type".to_string(),
                        serde_json::Value::String(RUN_INTERRUPTED_EVENT.to_string()),
                    );
                }
                let payload = serde_json::to_string(&payload)
                    .map_err(|e| RestoreError::new("serialize_interrupted", e.to_string()))?;
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
            } else if run.status == RunStatus::Completed {
                // 反向脑裂修正：物化表声称 completed，但 events 表无任何终态事件！
                tracing::warn!(
                    target: "restore",
                    run_id = %run.run_id,
                    session_id = %run.session_id,
                    "检测到无事件背书的非法完成态 (Unbacked-Completed)，强制收敛降级为 Failed"
                );
                store
                    .update_run_status(
                        &run.run_id,
                        RunStatus::Failed,
                        Some("unbacked-completed"),
                        None,
                    )
                    .await?;
                run.status = RunStatus::Failed;
                run.end_reason = Some("unbacked-completed".to_string());
                run.updated_at = now_ms();
            } else if let RunStatus::Unknown(literal) = &run.status {
                // D3 裁决：未知字面量保真透传
                tracing::warn!(
                    target: "restore",
                    run_id = %run.run_id,
                    status = %literal,
                    "未知状态字面量保留（不打断、不改写）"
                );
                unknown_status_runs.push((run.run_id.clone(), literal.clone()));
            }
        }

        // 3b. session_agents 残留 running 归一（PERSIST-02 P1-3）：子代理
        // 运行中崩溃 → 行 status 残留 running；不归一则 FlowScheduler::load
        // 重建为 Running 节点，is_ready 要求 Pending → 永不重派发、流程
        // 永久卡死（flow_graph.rs:1473-1476）。与主 run 打断对称（kill_all
        // 语义）：running → failed + ended_at 落库。仅 LocalDb 路径可用
        // （as_local_db 下转；InMemoryStore 等测试替身无 session_agents 面，
        // 跳过——生产恒为 LocalDbStore）
        if let Some(db) = store.as_local_db() {
            let running_rows = db
                .load_running_session_agents()
                .map_err(|e| RestoreError::new("load_running_session_agents", e.to_string()))?;
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
                        .map_err(|e| RestoreError::new("normalize_session_agent", e.to_string()))?;
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

        // 4b. 冷启动孤儿工具自愈（04 §5 / D-3）：ToolStart 无 ToolEnd → CAS
        //     幂等补齐 ToolEnd（ToolOutcomeUnknown）；Assistant 声明但连
        //     ToolStart 都无（message-end / session_messages）→ 全包络补齐
        //     ToolStart+ToolEnd。lease API 尚未在 conex-db
        //     合并——按「可选调用+编译可空」：先做 CAS 存在性排查（04 §6.3
        //     防线二），杜绝重复合成。会话集合取自已组装的 sessions。
        let healed_orphan_tools = heal_orphaned_tool_calls(store, &sessions).await?;

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
        let base_sequence = snapshot
            .as_ref()
            .map(|snap| snap.last_sequence)
            .unwrap_or(0);
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
                    .and_then(|snap| snap.session_last_sequence.get(&session.session_id))
                    .copied()
                    .unwrap_or(base_sequence)
            } else {
                0
            };
            // 1C-3：分页加载快照锚点后事件，避免 `limit=None` 全量加载导致
            // 恢复路径内存峰值随事件量线性增长。PAGE_SIZE=500：按 sequence
            // 升序翻页直到无更多事件，结果集与全量加载一致（crash_consistency
            // 测试覆盖）。
            const RESTORE_PAGE_SIZE: u64 = 500;
            let mut events: Vec<PersistedEvent> = Vec::new();
            let mut page_after = base;
            loop {
                let page = store
                    .query_events(&session.session_id, page_after, Some(RESTORE_PAGE_SIZE))
                    .await?;
                if page.is_empty() {
                    break;
                }
                page_after = page.last().map(|e| e.sequence).unwrap_or(page_after);
                let exhausted = page.len() < RESTORE_PAGE_SIZE as usize;
                events.extend(page);
                if exhausted {
                    break;
                }
            }
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
            snapshot_generation: snapshot.as_ref().map(|snap| snap.generation).unwrap_or(0),
            healed_orphan_tools,
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

/// 会话内下一个可用序列号（恢复审计事件续接用）。
///
/// 1C-1：改用 SQL `MAX(sequence)` 下推（`store.max_sequence`），避免
/// `query_events(.., None)` 全量加载事件到内存再 `iter().max()`。
async fn next_sequence(store: &dyn Store, session_id: &str) -> Result<u64, StoreError> {
    Ok(store.max_sequence(session_id).await? + 1)
}

/// 批量拉齐全部 run-terminal 事件（04 §4.2 契约补丁：禁止 per-run N+1）。
///
/// 返回 `(session_id, run_id) → payload` 映射。当前 Store 面无跨会话批量
/// 查询 API——先按**唯一 session_id** 去重后逐会话拉齐（O(=sessions) 而非
/// O(runs)），对齐「批量签名优先、Store 限制时 HashMap 缓存」口径。
async fn load_terminal_map(
    store: &dyn Store,
    runs: &[conex_db::StoredRun],
) -> Result<HashMap<(String, String), String>, StoreError> {
    let mut terminal_by_key: HashMap<(String, String), String> = HashMap::new();
    let mut seen_sessions: HashSet<&str> = HashSet::new();
    for run in runs {
        if !seen_sessions.insert(run.session_id.as_str()) {
            continue;
        }
        // 会话级拉齐：query_events 不限类型，内存过滤 run-terminal——
        // 会话事件量在恢复路径可接受；Store 无「session+type 而非
        // session+run+type」的下推面，待 Store 扩展后再优化为 SQL 过滤
        let events = store.query_events(&run.session_id, 0, None).await?;
        for e in events {
            if e.event_type == "run-terminal" {
                if let Some(event_run_id) = e.run_id {
                    terminal_by_key.insert((run.session_id.clone(), event_run_id), e.payload);
                }
            }
        }
    }
    Ok(terminal_by_key)
}

/// 从 tool-start / tool-end 事件 payload 提取 call.id（顶层 `call.id` /
/// `result.id`；缺失返回 None）。
fn extract_call_id(payload: &str, is_start: bool) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(payload).ok()?;
    if is_start {
        v.get("call")
            .and_then(|c| c.get("id"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    } else {
        v.get("result")
            .and_then(|r| r.get("id"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                // 兼容顶层 id（部分历史载荷）
                v.get("id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
            })
    }
}

/// 从 tool-start 事件 payload 提取 toolName。
fn extract_tool_name(payload: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(payload).ok()?;
    v.get("call")
        .and_then(|c| c.get("toolName"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

/// 从 tool_calls_json / blocks_json 提取声明的工具调用（call_id, tool_name）。
///
/// 兼容两种物化形状：
/// - `tool_calls_json`：`[{id, name|toolName, arguments|input}]`（前端
///   MessageToolCall 子集，对齐 hydrate LegacyToolCall）；
/// - `blocks_json`：`AgentMessageBlock::ToolCall` 数组（现代块形态）。
///
/// 宽容解析：坏条目跳过；整体不可解析返回空。
fn extract_declared_tool_calls(
    tool_calls_json: Option<&str>,
    blocks_json: Option<&str>,
) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    if let Some(json) = tool_calls_json {
        if let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(json) {
            for item in items {
                let id = item
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string);
                let name = item
                    .get("name")
                    .or_else(|| item.get("toolName"))
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string);
                if let (Some(id), Some(name)) = (id, name) {
                    out.push((id, name));
                }
            }
        }
    }
    if let Some(json) = blocks_json {
        if let Ok(blocks) = serde_json::from_str::<Vec<conex_types::AgentMessageBlock>>(json) {
            for b in blocks {
                if let conex_types::AgentMessageBlock::ToolCall(call) = b {
                    out.push((call.id, call.tool_name));
                }
            }
        }
    }
    out
}

/// 从 tool_call_results_json 提取已带结果的 call_id 集合（消息级已收口）。
///
/// 条目形状 `[{id|toolCallId, ...}]`；坏条目跳过。
fn extract_resolved_call_ids(tool_call_results_json: Option<&str>) -> HashSet<String> {
    let mut out = HashSet::new();
    let Some(json) = tool_call_results_json else {
        return out;
    };
    if let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(json) {
        for item in items {
            if let Some(id) = item
                .get("id")
                .or_else(|| item.get("toolCallId"))
                .and_then(serde_json::Value::as_str)
            {
                out.insert(id.to_string());
            }
        }
    }
    out
}

/// 从 message-end 事件 payload 提取声明的工具调用与归属 run。
///
/// payload 为 AgentEventEnvelope 扁平 JSON（含 type=message-end 与 message
/// 全文）；解析失败返回空。
fn extract_declared_from_message_end(
    payload: &str,
    run_id: Option<String>,
) -> Vec<(String, String, Option<String>)> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) else {
        return Vec::new();
    };
    // 信封扁平形态：message 直接在顶层
    let Some(msg) = v.get("message") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    // blocks[] 中的 tool-call 块
    if let Some(blocks) = msg.get("blocks").and_then(|b| b.as_array()) {
        for b in blocks {
            if b.get("type").and_then(serde_json::Value::as_str) == Some("tool-call") {
                let id = b.get("id").and_then(serde_json::Value::as_str);
                let name = b.get("toolName").and_then(serde_json::Value::as_str);
                if let (Some(id), Some(name)) = (id, name) {
                    out.push((id.to_string(), name.to_string(), run_id.clone()));
                }
            }
        }
    }
    out
}

/// 冷启动孤儿工具自愈引擎（04 §5）。
///
/// 探测两类悬挂调用并 CAS 幂等补齐（载荷 `ToolOutcomeUnknown`）：
/// 1. **仅缺 ToolEnd**（ToolStart 已存在）：只补 ToolEnd（既有路径）；
/// 2. **连 ToolStart 都缺**（Assistant 声明 tool_calls 但 events 无
///    tool-start，04 §5.2 / D-3）：先合成 ToolStart 再追加 ToolEnd，
///    保证事件包络严格成对。
///
/// 声明源：`as_local_db().load_session_body`（生产 LocalDb）→ `tool_calls_json` /
/// `blocks_json`；回退 `message-end` 事件载荷。自愈成功后可选回写
/// `session_messages.tool_call_results_json`（04 §5.4）。
///
/// 消息级已有 `tool_call_results_json` 条目的 call_id 视为已收口，跳过
/// （02 契约补丁：禁止对已终态 call_id 重复合成）。
///
/// **租约口径**：Store 抽象层无 LocalDb 租约 API；多实例互斥优先由宿主在
/// 调 `restore` 前获取 `LocalDb::try_acquire_recovery_lease`（conex-db 已落地），
/// 本函数对任意 Store 保持 CAS 幂等（04 §6.3 防线二）。
async fn heal_orphaned_tool_calls(
    store: &dyn Store,
    sessions: &[SessionRecord],
) -> Result<Vec<HealedToolRecord>, RestoreError> {
    let mut healed = Vec::new();
    for session in sessions {
        let session_id = session.session_id.clone();
        // 会话级拉齐 tool-start / tool-end / message-end（一次 query_events）
        let events = store.query_events(&session_id, 0, None).await?;
        let mut started: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
        // call_id → (tool_name, run_id)
        let mut ended: HashSet<String> = HashSet::new();
        // 声明集（消息侧）：call_id → (tool_name, run_id)
        let mut declared: HashMap<String, (String, Option<String>)> = HashMap::new();
        // 消息级已收口（tool_call_results_json）：跳过合成
        let mut message_resolved: HashSet<String> = HashSet::new();

        for e in &events {
            if e.event_type == "tool-start" {
                if let Some(call_id) = extract_call_id(&e.payload, true) {
                    let tool_name = extract_tool_name(&e.payload);
                    started.insert(call_id, (tool_name, e.run_id.clone()));
                }
            } else if e.event_type == "tool-end" {
                if let Some(call_id) = extract_call_id(&e.payload, false) {
                    ended.insert(call_id);
                }
            } else if e.event_type == "message-end" {
                for (id, name, run_id) in
                    extract_declared_from_message_end(&e.payload, e.run_id.clone())
                {
                    declared.insert(id, (name, run_id));
                }
            }
        }

        // 首选：session_messages 物化视图（as_local_db 下转；InMemory 跳过）
        if let Some(db) = store.as_local_db() {
            if let Ok(messages) = db.load_session_body(&session_id) {
                for m in &messages {
                    if m.sender != "assistant" {
                        continue;
                    }
                    for (id, name) in extract_declared_tool_calls(
                        m.tool_calls_json.as_deref(),
                        m.blocks_json.as_deref(),
                    ) {
                        // 已有 run_id（来自 message-end）优先保留；无则 None
                        declared
                            .entry(id)
                            .and_modify(|slot| slot.0 = name.clone())
                            .or_insert((name, None));
                    }
                    message_resolved.extend(extract_resolved_call_ids(
                        m.tool_call_results_json.as_deref(),
                    ));
                }
            }
        }

        // 孤儿集 A：ToolStart \ ToolEnd（仅补 ToolEnd）
        let mut orphans_end_only: Vec<String> = started
            .keys()
            .filter(|id| !ended.contains(*id))
            .cloned()
            .collect();
        orphans_end_only.sort(); // 确定性顺序（测试可断言）

        // 孤儿集 B：声明 \ ToolStart \ ToolEnd（补全包络 ToolStart+ToolEnd）
        // 跳过消息级已有结果的 call_id（02 幂等闸）
        let mut orphans_full: Vec<String> = declared
            .keys()
            .filter(|id| {
                !started.contains_key(*id)
                    && !ended.contains(*id)
                    && !message_resolved.contains(*id)
            })
            .cloned()
            .collect();
        orphans_full.sort();

        // 先处理仅缺 ToolEnd（既有路径语义不变），再处理全包络
        for call_id in orphans_end_only {
            let (tool_name, run_id) = started[&call_id].clone();
            let tool_name = tool_name.unwrap_or_else(|| "unknown".to_string());
            if let Some((healed_at, _)) = heal_one_orphan(
                store,
                &session_id,
                &call_id,
                &tool_name,
                run_id.as_deref(),
                None,
                false,
            )
            .await?
            {
                write_healed_result_to_messages(store, &session_id, &call_id, &tool_name);
                healed.push(HealedToolRecord {
                    session_id: session_id.clone(),
                    run_id,
                    call_id,
                    tool_name,
                    synthesized_tool_start: false,
                    healed_at,
                });
            }
        }

        for call_id in orphans_full {
            let (tool_name, run_id) = declared[&call_id].clone();
            if let Some((healed_at, synthesized_start)) = heal_one_orphan(
                store,
                &session_id,
                &call_id,
                &tool_name,
                run_id.as_deref(),
                Some(serde_json::Value::Object(serde_json::Map::new())),
                true,
            )
            .await?
            {
                write_healed_result_to_messages(store, &session_id, &call_id, &tool_name);
                healed.push(HealedToolRecord {
                    session_id: session_id.clone(),
                    run_id,
                    call_id,
                    tool_name,
                    synthesized_tool_start: synthesized_start,
                    healed_at,
                });
            }
        }
    }
    Ok(healed)
}

/// 单孤儿 CAS 幂等补齐（04 §5.2-5.3 / §6.3 防线二）。
///
/// `need_tool_start = true` 时先 CAS 检查并合成 ToolStart，再补 ToolEnd。
/// `input` 为合成 ToolStart 的入参（None = 空对象）。
/// 返回 `Some((healed_at_ms, synthesized_start))` 表示实际写入 ToolEnd；
/// `None` = CAS 幂等放弃。
#[allow(clippy::too_many_arguments)]
async fn heal_one_orphan(
    store: &dyn Store,
    session_id: &str,
    call_id: &str,
    tool_name: &str,
    run_id: Option<&str>,
    input: Option<serde_json::Value>,
    need_tool_start: bool,
) -> Result<Option<(i64, bool)>, RestoreError> {
    // CAS 存在性排查（04 §6.3 防线二）：重查 tool-end 是否已存在
    // （防并发/重复恢复窗口）。存在 → 幂等放弃。
    let recheck = store.query_events(session_id, 0, None).await?;
    let already_healed = recheck
        .iter()
        .filter(|e| e.event_type == "tool-end")
        .any(|e| extract_call_id(&e.payload, false).as_deref() == Some(call_id));
    if already_healed {
        tracing::debug!(
            target: "restore",
            session_id = %session_id,
            call_id = %call_id,
            "孤儿工具自愈 CAS 命中已存在 tool-end，幂等放弃"
        );
        return Ok(None);
    }

    // 全包络路径：若 ToolStart 仍缺失则先合成
    let has_tool_start = recheck
        .iter()
        .filter(|e| e.event_type == "tool-start")
        .any(|e| extract_call_id(&e.payload, true).as_deref() == Some(call_id));
    let mut synthesized_start = false;
    if need_tool_start && !has_tool_start {
        let healed_at = now_ms();
        let batch_id = format!("healed-batch-{}", run_id.unwrap_or("unknown"));
        let seq = store.reserve_sequence(session_id).await?;
        let tool_start = AgentEvent::ToolStart {
            session_id: session_id.to_string(),
            batch_id,
            call: conex_types::ToolBatchCall {
                id: call_id.to_string(),
                tool_name: tool_name.to_string(),
                summary: "Synthesized tool start during crash recovery".to_string(),
                input: input.unwrap_or(serde_json::json!({})),
                category: conex_types::ToolCategory::Internal,
                concurrency: conex_types::ToolConcurrency::Sequential,
            },
            timestamp: chrono_like_iso8601(healed_at),
            turn_index: None,
        };
        let payload = serde_json::to_string(&tool_start)
            .map_err(|e| RestoreError::new("serialize_tool_start", e.to_string()))?;
        store
            .append_event(session_id, seq, "tool-start", &payload, run_id)
            .await?;
        synthesized_start = true;
        tracing::info!(
            target: "restore",
            session_id = %session_id,
            call_id = %call_id,
            tool_name = %tool_name,
            "冷启动孤儿工具自愈：合成 ToolStart（全包络）"
        );
    }

    // 补齐 ToolEnd（ToolOutcomeUnknown）——统一尾步
    let healed_at = now_ms();
    let batch_id = format!("healed-batch-{}", run_id.unwrap_or("unknown"));
    let seq = store.reserve_sequence(session_id).await?;
    let tool_end = AgentEvent::ToolEnd {
        session_id: session_id.to_string(),
        batch_id,
        result: conex_types::ToolBatchResult {
            id: call_id.to_string(),
            tool_name: tool_name.to_string(),
            output: conex_types::ToolOutput {
                text: Some(
                    "Execution outcome unknown: daemon or host process terminated \
                     abnormally before tool completion."
                        .to_string(),
                ),
                json: Some(serde_json::json!({
                    "code": "ToolOutcomeUnknown",
                    "reason": "process-crash-interrupted",
                    "orphanCallId": call_id,
                    "healedAt": chrono_like_iso8601(healed_at),
                })),
                artifacts: None,
            },
            is_error: true,
            duration_ms: 0,
        },
        timestamp: chrono_like_iso8601(healed_at),
        attempt: Some(1),
        deduplicated: None,
        executed_input: None,
    };
    let payload = serde_json::to_string(&tool_end)
        .map_err(|e| RestoreError::new("serialize_tool_end", e.to_string()))?;
    store
        .append_event(session_id, seq, "tool-end", &payload, run_id)
        .await?;

    tracing::info!(
        target: "restore",
        session_id = %session_id,
        call_id = %call_id,
        tool_name = %tool_name,
        synthesized_tool_start = synthesized_start,
        "冷启动孤儿工具自愈：补齐 ToolEnd（ToolOutcomeUnknown）"
    );
    Ok(Some((healed_at, synthesized_start)))
}

/// 自愈成功后把合成结果写回 `session_messages.tool_call_results_json`（04 §5.4）。
///
/// 仅 LocalDb 路径生效；失败仅告警不回滚 events（events 已是权威，正文视图
/// 允许短暂落后，下次 hydrate 合成仍可出站）。幂等：call_id 已在结果集则跳过。
fn write_healed_result_to_messages(
    store: &dyn Store,
    session_id: &str,
    call_id: &str,
    tool_name: &str,
) {
    let Some(db) = store.as_local_db() else {
        return;
    };
    let Ok(mut messages) = db.load_session_body(session_id) else {
        tracing::warn!(
            target: "restore",
            session_id = %session_id,
            call_id = %call_id,
            "自愈正文回写跳过：load_session_body 失败"
        );
        return;
    };
    let mut changed = false;
    for m in messages.iter_mut().filter(|m| m.sender == "assistant") {
        let declares =
            extract_declared_tool_calls(m.tool_calls_json.as_deref(), m.blocks_json.as_deref())
                .iter()
                .any(|(id, _)| id == call_id);
        if !declares {
            continue;
        }
        let resolved = extract_resolved_call_ids(m.tool_call_results_json.as_deref());
        if resolved.contains(call_id) {
            continue;
        }
        let mut results: Vec<serde_json::Value> = m
            .tool_call_results_json
            .as_deref()
            .and_then(|j| serde_json::from_str::<Vec<serde_json::Value>>(j).ok())
            .unwrap_or_default();
        results.push(serde_json::json!({
            "toolCallId": call_id,
            "toolName": tool_name,
            "content": "Execution outcome unknown: crash recovery synthesized tool result.",
            "isError": true,
        }));
        match serde_json::to_string(&results) {
            Ok(s) => {
                m.tool_call_results_json = Some(s);
                changed = true;
            }
            Err(e) => {
                tracing::warn!(target: "restore", error = %e, "自愈正文回写：序列化结果失败");
                return;
            }
        }
        break;
    }
    if !changed {
        return;
    }
    if let Err(e) = db.save_session_body(session_id, &messages) {
        tracing::warn!(
            target: "restore",
            session_id = %session_id,
            call_id = %call_id,
            error = %e,
            "自愈正文回写 session_messages 失败（events 已闭合，hydrate 仍可合成）"
        );
    } else {
        tracing::info!(
            target: "restore",
            session_id = %session_id,
            call_id = %call_id,
            "自愈结果已回写 session_messages.tool_call_results_json"
        );
    }
}

/// epoch ms → UTC ISO8601（轻量格式化，避免引入 chrono）。
fn chrono_like_iso8601(ms: i64) -> String {
    // 用 UTC 简化：只做毫秒→秒转换与格式化（恢复自愈载荷可读即可）
    let secs = ms.div_euclid(1_000);
    let millis = ms.rem_euclid(1_000);
    // Civil from days (Howard Hinnant algorithm)
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let (h, m, s) = (sod / 3600, (sod % 3600) / 60, sod % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}.{millis:03}Z")
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
