//! 撤回命令（统一输入流收敛战役 R1 · 详案 §4.4：复用 core_run_control L3
//! 通道 + 独立 `retract` 语义 wire，不新建平行 IPC 通道）
//!
//! # core_session_retract（六步 ①-⑤ 引擎侧）
//!
//! 用户 UI 对某 user 节点发起撤回 → 本命令编排：
//!
//! 1. **定位**：`resolve_boundary_seq` 反查 events 表 `message-start` 最新
//!    一条（envelope payload `message.id == target_message_id`）→ 起始 seq；
//! 2. **停 run**：对会话运行中 run 投 L3 force_cancel（reason=
//!    `retraction:<seq>`，复用既有控制总线）+ 子代理 `kill_all`（同一
//!    撤回边界；lifecycle.rs 语义：事件层 cancelled 为生产真值）；
//! 3. **收敛**：等待 run 终态确认（RunHandle terminal / 驱动任务收口）；
//! 4. **冻结**：稳定点读 MAX(sequence) = frozen_seq，激活会话级冻结
//!    （护栏：冻结期内拒绝 `> frozen_seq` 非撤离写入）；
//! 5. **收集回滚计划**：冻结后按目标消息起始 seq 到 frozen_seq 查询 ToolEnd，
//!    精确关联写类快照 owner；查询失败释放冻结并中止 truncate；
//! 6. **truncate**：push `timeline-truncate`（boundary_seq = 真实目标消息起始 seq，
//!    自身占 frozen_seq + 1；Critical + Persist 必达落库）→ 释放冻结；
//! 7. **回滚**：按缓存的 operation owner 逐一还原 trash 写前快照（S10b）。
//!
//! 终端语义（决策 7 结论）：撤回投影以事件流 `cancelled` 为准；
//! `session_agents` 表 row `failed` 为已知双写约定，本命令不改 row 归一。
//!
//! 命令文件与 run/ 目录分开（I1-β 并行位在改 run_idle/run_launch/
//! engine_build，命令面独立，避免争写）。

use std::sync::Arc;
use std::time::{Duration, Instant};

use conex_fs::trash::{RollbackOutcome, SnapshotOperation, TrashService};
use conex_types::events::{AgentEvent, AgentEventEnvelope};
use orchestrator::persist::Store;
use session_loop::{
    RetractionBackend, RetractionError, RetractionProtocol, SessionFreezeRegistry,
    CONVERGE_TIMEOUT_MS,
};

use crate::core_error::CoreError;
use crate::core_run_commands::{resolve_run_workspace_root, CoreRunState};

/// 撤回响应（wire camelCase；前端按 boundarySeq 做投影重放）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RetractResponse {
    /// 截断边界 = 真实目标消息起始序号（重放投影只保留 sequence <= boundarySeq）
    pub boundary_seq: u64,
    /// TimelineTruncate 自身落库 sequence（== frozen_seq + 1）
    pub truncate_sequence: u64,

    /// 被撤回收场的 run id（无运行中 run 时为空串）
    pub run_id: String,
    /// 撤回目标 user 消息稳定 id
    pub target_message_id: String,
    /// 回滚结果摘要（restored/skipped/failed 计数）
    pub rollback: RollbackSummary,
}

/// 回滚结果摘要（wire camelCase）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RollbackSummary {
    pub restored: usize,
    pub skipped: usize,
    pub failed: usize,
}

/// core_session_retract：用户撤回入口（IPC wire；命令面独立于 run/ 目录）
#[tauri::command]
pub(crate) async fn core_session_retract(
    state: tauri::State<'_, Arc<CoreRunState>>,
    session_id: String,
    target_message_id: String,
) -> Result<RetractResponse, CoreError> {
    retract_impl(state.inner(), session_id.trim(), target_message_id.trim()).await
}

/// 撤回命令体（测试直调，不依赖 Tauri runtime；对齐 background.rs
/// 「契约体」模式）
pub(crate) async fn retract_impl(
    state: &Arc<CoreRunState>,
    session_id: &str,
    target_message_id: &str,
) -> Result<RetractResponse, CoreError> {
    if session_id.is_empty() || target_message_id.is_empty() {
        return Err(CoreError::InvalidInput(
            "core_session_retract 需要 sessionId 与 targetMessageId".into(),
        ));
    }

    // 共享冻结注册表：与 run 事件队列（run_launch.rs 装配）同一实例——
    // 协议激活/释放与写侧拒绝走同一会话级状态
    let rollback_plan = Arc::new(std::sync::Mutex::new(None));
    let backend = ShellRetractionBackend {
        state: Arc::clone(state),
        freeze: Arc::clone(&state.retraction_freeze),
        rollback_plan: Arc::clone(&rollback_plan),
    };
    let protocol = RetractionProtocol::with_freeze_registry(
        Box::new(backend),
        Arc::clone(&state.retraction_freeze),
    );

    let outcome = protocol
        .prepare_retraction(session_id, target_message_id)
        .await
        .map_err(map_retraction_err)?;

    // ⑥ 回滚副作用：按冻结期预收集的 ToolEnd owner 精确消费写前快照。
    let trash_root = resolve_run_workspace_root(None).join(".crish-trash");
    let operations = rollback_plan
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
        .ok_or_else(|| CoreError::Internal("撤回回滚计划未生成".into()))?;
    let results = TrashService::new(&trash_root)
        .rollback_operations(&operations)
        .map_err(|e| CoreError::Io(format!("retraction rollback: {e}")))?;
    let mut summary = RollbackSummary {
        restored: 0,
        skipped: 0,
        failed: 0,
    };
    for r in results {
        match r {
            RollbackOutcome::Restored(_) => summary.restored += 1,
            RollbackOutcome::Skipped { .. } => summary.skipped += 1,
        }
    }

    // ⑦ 物理下推：SQLite 消息持久层截断 target_message_id 之后的消息
    // 彻底根除应用重启或水合后被撤回消息死灰复燃
    if let Some(db) = state.local_db() {
        if let Err(e) = db.truncate_session_messages_after(session_id, target_message_id) {
            tracing::warn!(
                target: "retraction",
                session_id = %session_id,
                target_message_id = %target_message_id,
                error = %e,
                "撤回持久化物理下推警告（session_messages 截断未匹配或失败）"
            );
        }
    }

    Ok(RetractResponse {
        boundary_seq: outcome.boundary_seq,
        truncate_sequence: outcome.truncate_sequence,
        run_id: outcome.run_id.unwrap_or_default(),
        target_message_id: outcome.target_message_id,
        rollback: summary,
    })
}


/// 撤回错误 → CoreError 映射（fail-closed 语义透传）
fn map_retraction_err(err: RetractionError) -> CoreError {
    match err {
        RetractionError::NotFound => CoreError::NotFound(err.to_string()),
        RetractionError::Busy => CoreError::InvalidInput(err.to_string()),
        RetractionError::Backend(msg) => CoreError::Io(format!("retraction: {msg}")),
        RetractionError::ConvergeTimeout => CoreError::Internal(err.to_string()),
        RetractionError::Frozen => CoreError::Internal(err.to_string()),
    }
}

/// 壳层撤回后端：store 查询 + L3 停 run + kill_all + truncate 发射
struct ShellRetractionBackend {
    state: Arc<CoreRunState>,
    freeze: std::sync::Arc<SessionFreezeRegistry>,
    rollback_plan: Arc<std::sync::Mutex<Option<Vec<SnapshotOperation>>>>,
}

impl ShellRetractionBackend {
    /// 从已落库事件流定位 `message-start` 中 message.id == target 的
    /// 最新一条 sequence（events 表只追加，反查定位原语）
    async fn query_message_start_seq(
        &self,
        session_id: &str,
        target_message_id: &str,
    ) -> Result<Option<u64>, RetractionError> {
        let rows = self
            .state
            .store
            .query_events(session_id, 0, None)
            .await
            .map_err(|e| RetractionError::Backend(e.message))?;
        let mut found: Option<u64> = None;
        for row in &rows {
            if row.event_type != "message-start" {
                continue;
            }
            let Ok(envelope) = serde_json::from_str::<AgentEventEnvelope>(&row.payload) else {
                continue;
            };
            match &envelope.event {
                AgentEvent::MessageStart { message, .. } => {
                    if message.id == target_message_id {
                        found = Some(row.sequence as u64);
                    }
                }
                _ => {}
            }
        }
        Ok(found)
    }

    /// 全 Run 并行收敛网：等待会话内所有活跃 Run（主 Run 与所有子代理 Run）全部进入终态，
    /// 彻底消除 HashMap 随机单 Run 盲区。
    async fn wait_all_converged(&self, session_id: &str) -> Result<(), RetractionError> {
        let deadline = Instant::now() + Duration::from_millis(CONVERGE_TIMEOUT_MS);
        loop {
            // 收集该会话下所有活跃 run 的句柄（MutexGuard 不跨 await 持有）
            let active_handles: Vec<(String, Arc<tokio::sync::Mutex<orchestrator::run::RunHandle>>)> = {
                let active = self
                    .state
                    .active_runs
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                active
                    .values()
                    .filter(|a| a.session_id == session_id)
                    .map(|a| (a.run_id.clone(), Arc::clone(&a.handle)))
                    .collect()
            };

            if active_handles.is_empty() {
                // 该会话下已无任何活跃 run，收敛完成
                return Ok(());
            }

            let mut all_terminal = true;
            for (_run_id, handle) in &active_handles {
                if !handle.lock().await.is_terminal() {
                    all_terminal = false;
                    break;
                }
            }

            if all_terminal {
                return Ok(());
            }

            if Instant::now() > deadline {
                return Err(RetractionError::ConvergeTimeout);
            }

            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

#[async_trait::async_trait]
impl RetractionBackend for ShellRetractionBackend {
    async fn resolve_boundary_seq(
        &self,
        session_id: &str,
        target_message_id: &str,
    ) -> Result<Option<u64>, RetractionError> {
        self.query_message_start_seq(session_id, target_message_id)
            .await
    }

    async fn session_max_sequence(&self, session_id: &str) -> Result<u64, RetractionError> {
        let rows = self
            .state
            .store
            .query_events(session_id, 0, None)
            .await
            .map_err(|e| RetractionError::Backend(e.message))?;
        Ok(rows.last().map(|r| r.sequence as u64).unwrap_or(0))
    }

    async fn stop_run(
        &self,
        session_id: &str,
        boundary_seq: u64,
    ) -> Result<Option<String>, RetractionError> {
        let reason = format!("retraction:{boundary_seq}");
        // 会话内运行中 run 逐一投 L3 force_cancel（复用既有控制总线；
        // 子代理 run 的 L3 由 kill_all 兜底投递）
        let targets: Vec<(String, Arc<crate::core_run_commands::ActiveRun>)> = {
            let active = self
                .state
                .active_runs
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            active
                .values()
                .filter(|a| a.session_id == session_id)
                .map(|a| (a.run_id.clone(), Arc::clone(a)))
                .collect()
        };
        let mut main_run_id: Option<String> = None;
        for (run_id, active) in &targets {
            active
                .control_bus
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .request_force_cancel(Some(reason.clone()), Some("retract".into()));
            active.abort_signal.abort();
            if main_run_id.is_none() || active.subagent.is_none() {
                main_run_id = Some(run_id.clone());
            }
        }
        // 子代理级联停止（同一撤回边界；事件层 cancelled 为生产真值）
        if let Some(lifecycle) = self.state.lifecycle_service() {
            let _ = lifecycle.kill_all(session_id, &format!("retraction:{boundary_seq}"));
        }
        Ok(main_run_id)
    }

    async fn wait_converged(
        &self,
        session_id: &str,
        _run_id: Option<&str>,
    ) -> Result<(), RetractionError> {
        self.wait_all_converged(session_id).await
    }


    async fn prepare_rollback_plan(
        &self,
        session_id: &str,
        _target_message_id: &str,
        target_boundary_seq: u64,
        frozen_seq: u64,
    ) -> Result<(), RetractionError> {
        let operations = collect_post_boundary_write_operations(
            self.state.store.as_ref(),
            session_id,
            target_boundary_seq,
            frozen_seq,
        )
        .await
        .map_err(RetractionError::Backend)?;
        *self.rollback_plan.lock().unwrap_or_else(|e| e.into_inner()) = Some(operations);
        Ok(())
    }

    async fn push_timeline_truncate(
        &self,
        session_id: &str,
        run_id: Option<&str>,
        boundary_seq: u64,
        target_message_id: &str,
    ) -> Result<u64, RetractionError> {
        let event = RetractionProtocol::build_truncate_event(
            session_id,
            run_id,
            boundary_seq,
            target_message_id,
            &crate::engine::now_iso_utc(),
        );
        // 经挂载冻结护栏的队列发射（timeline-truncate 为撤离事件放行；
        // 自身占 sequence = frozen_seq + 1）
        let base = self.state.base_sequence_for(session_id).await;
        let mut queue = orchestrator::events::EventQueue::new(
            self.state.store.clone(),
            base,
            run_id.map(str::to_string),
        )
        .with_freeze_registry(Arc::clone(&self.freeze));
        let sequenced = queue
            .push(session_id, event)
            .await
            .map_err(|e| RetractionError::Backend(e.error.message))?;
        Ok(sequenced.sequence)
    }
}

/// 收集目标消息起始 seq 之后、冻结 MAX 之前的写操作 owner。
async fn collect_post_boundary_write_operations(
    store: &dyn Store,
    session_id: &str,
    target_boundary_seq: u64,
    frozen_seq: u64,
) -> Result<Vec<SnapshotOperation>, String> {
    let rows = store
        .query_events(session_id, target_boundary_seq, None)
        .await
        .map_err(|e| e.message)?;
    let mut operations = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in &rows {
        if row.sequence > frozen_seq || row.event_type != "tool-end" {
            continue;
        }
        let envelope = serde_json::from_str::<AgentEventEnvelope>(&row.payload)
            .map_err(|e| format!("解析 tool-end 事件失败 (seq={}): {e}", row.sequence))?;
        let AgentEvent::ToolEnd {
            session_id: event_session,
            result,
            attempt,
            executed_input,
            ..
        } = &envelope.event
        else {
            return Err(format!("tool-end 行载荷类型不匹配 (seq={})", row.sequence));
        };
        if !matches!(
            result.tool_name.as_str(),
            "write_file" | "multi_replace_file_content"
        ) {
            continue;
        }
        let Some(executed_input) = executed_input.as_ref() else {
            if result.is_error && attempt.is_none() {
                // 被权限拒绝、中间件阻止或兄弟失败取消的调用没有进入执行面，
                // 因而没有写前快照需要消费。
                continue;
            }
            return Err(format!(
                "已执行写类 tool-end 缺少实际输入 (seq={})",
                row.sequence
            ));
        };
        if event_session != session_id || row.session_id != session_id {
            return Err(format!(
                "tool-end session owner 不匹配 (seq={})",
                row.sequence
            ));
        }
        let run_id = envelope
            .run_id
            .as_deref()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("tool-end 缺少 run owner (seq={})", row.sequence))?;
        if row.run_id.as_deref() != Some(run_id) {
            return Err(format!(
                "tool-end run owner 与持久化列不匹配 (seq={})",
                row.sequence
            ));
        }
        if result.id.trim().is_empty() {
            return Err(format!(
                "写类 tool-end 缺少 tool_call_id (seq={})",
                row.sequence
            ));
        }
        let path = executed_input
            .get("path")
            .or_else(|| executed_input.get("target_file"))
            .and_then(serde_json::Value::as_str)
            .filter(|path| !path.trim().is_empty())
            .ok_or_else(|| format!("写类 tool-end 实际输入缺少目标路径 (seq={})", row.sequence))?;
        let operation = SnapshotOperation {
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            tool_call_id: result.id.clone(),
            path: path.to_string(),
        };
        if seen.insert(operation.clone()) {
            operations.push(operation);
        }
    }
    Ok(operations)
}

// ── 测试（SR-01 · 测外置 · 旁挂 retraction_commands_tests.rs · ≠ EL）──

#[cfg(test)]
#[path = "retraction_commands_tests.rs"]
mod tests;
