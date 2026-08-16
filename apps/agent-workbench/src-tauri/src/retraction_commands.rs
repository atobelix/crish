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
//! 5. **truncate**：push `timeline-truncate`（boundary_seq = frozen_seq，
//!    自身占 frozen_seq + 1；Critical + Persist 必达落库）→ 释放冻结；
//! 6. **回滚**：按「类别→回滚策略」注册表对边界后写类工具输出路径
//!    （[collect_post_boundary_write_paths]，best-effort V1）逐一还原
//!    trash 写前快照（S10b 语义）。
//!
//! 终端语义（决策 7 结论）：撤回投影以事件流 `cancelled` 为准；
//! `session_agents` 表 row `failed` 为已知双写约定，本命令不改 row 归一。
//!
//! 命令文件与 run/ 目录分开（I1-β 并行位在改 run_idle/run_launch/
//! engine_build，命令面独立，避免争写）。

use std::sync::Arc;
use std::time::{Duration, Instant};

use conex_types::events::{AgentEvent, AgentEventEnvelope};
use conex_types::tool::ToolCategory;
use orchestrator::persist::Store;
use session_loop::{
    CategoryRollbackRegistry, RetractionBackend, RetractionError, RetractionProtocol,
    RollbackExecutor, SessionFreezeRegistry, CONVERGE_TIMEOUT_MS,
};

use crate::core_error::CoreError;
use crate::core_run_commands::{resolve_run_workspace_root, CoreRunState};

/// 撤回响应（wire camelCase；前端按 boundarySeq 做投影重放）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RetractResponse {
    /// 冻结边界 = 事件流停止写入点（== boundary user 节点起始 seq）
    pub boundary_seq: u64,
    /// TimelineTruncate 自身落库 sequence（== boundary_seq + 1）
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
    let backend = ShellRetractionBackend {
        state: Arc::clone(state),
        freeze: Arc::clone(&state.retraction_freeze),
    };
    let protocol = RetractionProtocol::with_freeze_registry(
        Box::new(backend),
        Arc::clone(&state.retraction_freeze),
    );

    let outcome = protocol
        .prepare_retraction(session_id, target_message_id)
        .await
        .map_err(map_retraction_err)?;

    // ⑥ 回滚副作用：类别→回滚策略注册表（默认映射：Filesystem →
    // TrashRestore；其余保守 None）+ trash 写前快照还原（S10b 语义）
    let registry = CategoryRollbackRegistry::default_();
    let trash_root = resolve_run_workspace_root(None).join(".crish-trash");
    let trash = if trash_root.is_dir() {
        Some(conex_fs::trash::TrashService::new(&trash_root))
    } else {
        None
    };
    let paths = collect_post_boundary_write_paths(
        state.store.as_ref(),
        session_id,
        outcome.boundary_seq,
    )
    .await
    .unwrap_or_default();
    let executor = RollbackExecutor::new(&registry, trash.as_ref());
    let results = executor.rollback_before(
        outcome.boundary_seq,
        &paths.iter().map(|p| (ToolCategory::Filesystem, vec![p.clone()])).collect::<Vec<_>>(),
    );
    let mut summary = RollbackSummary {
        restored: 0,
        skipped: 0,
        failed: 0,
    };
    for r in results {
        match r {
            session_loop::PathRollbackResult::Restored { .. } => summary.restored += 1,
            session_loop::PathRollbackResult::Skipped { .. } => summary.skipped += 1,
            session_loop::PathRollbackResult::Failed { .. } => summary.failed += 1,
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
}

#[async_trait::async_trait]
impl RetractionBackend for ShellRetractionBackend {
    async fn resolve_boundary_seq(
        &self,
        session_id: &str,
        target_message_id: &str,
    ) -> Result<Option<u64>, RetractionError> {
        self.query_message_start_seq(session_id, target_message_id).await
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
            let active = self.state.active_runs.lock().unwrap_or_else(|e| e.into_inner());
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
            if main_run_id.is_none() {
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
        _session_id: &str,
        run_id: Option<&str>,
    ) -> Result<(), RetractionError> {
        let Some(run_id) = run_id else {
            // 无运行中 run：无收敛等待（稳定点即当前事件流）
            return Ok(());
        };
        let deadline = Instant::now() + Duration::from_millis(CONVERGE_TIMEOUT_MS);
        loop {
            // 锁纪律：std MutexGuard 不跨 await 持有（先取句柄再释放锁）
            let handle = {
                let active = self.state.active_runs.lock().unwrap_or_else(|e| e.into_inner());
                active.get(run_id).map(|a| Arc::clone(&a.handle))
            };
            let terminal = match handle {
                Some(handle) => handle.lock().await.is_terminal(),
                None => true, // 已移出活动注册表 = 已收口
            };
            if terminal {
                return Ok(());
            }
            if Instant::now() > deadline {
                return Err(RetractionError::ConvergeTimeout);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
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

/// 收集撤回边界之后的写类工具输出路径（best-effort V1）
///
/// 查询 events 表 `> boundary_seq` 的 tool-end 事件，提取写类输出路径：
/// - `result.output.json.path`（字符串；write_file 规范形状）；
/// - `result.output.artifacts[].uri`（字符串；产物清单）。
///
/// 覆盖面为 V1 登记降级（其它输出形状的路径不在此收集，回滚由上层
/// 按需扩展；收集失败返回空清单，不阻断撤回主链路）。
async fn collect_post_boundary_write_paths(
    store: &dyn Store,
    session_id: &str,
    boundary_seq: u64,
) -> Result<Vec<String>, String> {
    let rows = store
        .query_events(session_id, boundary_seq, None)
        .await
        .map_err(|e| e.message)?;
    let mut paths: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in &rows {
        if row.event_type != "tool-end" {
            continue;
        }
        let Ok(envelope) = serde_json::from_str::<AgentEventEnvelope>(&row.payload) else {
            continue;
        };
        let AgentEvent::ToolEnd { result, .. } = &envelope.event else {
            continue;
        };
        if result.is_error {
            continue;
        }
        if let Some(json) = &result.output.json {
            if let Some(path) = json.get("path").and_then(serde_json::Value::as_str) {
                if !path.trim().is_empty() && seen.insert(path.to_string()) {
                    paths.push(path.to_string());
                }
            }
        }
        if let Some(artifacts) = &result.output.artifacts {
            for artifact in artifacts {
                if let Some(uri) = &artifact.uri {
                    if !uri.trim().is_empty() && seen.insert(uri.clone()) {
                        paths.push(uri.clone());
                    }
                }
            }
        }
    }
    Ok(paths)
}

