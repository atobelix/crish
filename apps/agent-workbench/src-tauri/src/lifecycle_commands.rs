//! D4a 子代理显式恢复与关闭命令壳（D4 §3.1 双端登记第 ① 步）。
//!
//! 命令体 = 同步准备（spawn_blocking，F2-27）+ 引擎侧
//! [orchestrator::lifecycle::SubagentLifecycleService] 调用。

use std::sync::Arc;

/// 生命周期错误 → CoreError（命令面唯一错误协议，PE-03 T03.3）。
///
/// - NotFound → `CoreError::NotFound`（目标子代理/run 不存在）；
/// - InvalidState → `CoreError::InvalidInput`（参数或状态非法）；
/// - PersistFailed → `CoreError::Io`（落库失败，detail 保留操作语义）；
/// - Recovery → 按恢复域错误分类映射（预算耗尽等保持可观测）。
fn map_lifecycle_err(
    err: orchestrator::lifecycle::LifecycleError,
) -> conex_run::core_error::CoreError {
    use orchestrator::lifecycle::LifecycleError;
    match err {
        LifecycleError::NotFound { message } => conex_run::core_error::CoreError::NotFound(message),
        LifecycleError::InvalidState { message } => {
            conex_run::core_error::CoreError::InvalidInput(message)
        }
        LifecycleError::PersistFailed { message } => {
            conex_run::core_error::CoreError::Io(format!("store.lifecycle: {message}"))
        }
        LifecycleError::Recovery(err) => match err {
            orchestrator::recovery::RecoveryError::NotFound { message } => {
                conex_run::core_error::CoreError::NotFound(message)
            }
            orchestrator::recovery::RecoveryError::PersistFailed { message } => {
                conex_run::core_error::CoreError::Io(format!("store.recovery: {message}"))
            }
            other => conex_run::core_error::CoreError::InvalidInput(format!("恢复域失败：{other}")),
        },
    }
}

/// D4 §3.2：kill_subagent 命令壳——单目标终止子代理（同步 SQLite 面经
/// spawn_blocking，F2-27；tokio worker 不执行同步 SQLite）。
#[tauri::command]
pub(crate) async fn kill_subagent(
    state: tauri::State<'_, Arc<conex_run::run::CoreRunState>>,
    session_id: String,
    subagent_id: String,
    reason: Option<String>,
) -> Result<orchestrator::lifecycle::KillSubagentResult, conex_run::core_error::CoreError> {
    let service = state.lifecycle_service().ok_or_else(|| {
        conex_run::core_error::CoreError::internal("LocalDb 不可用（测试替身 store）")
    })?;
    let reason = reason.unwrap_or_default();
    tokio::task::spawn_blocking(move || service.kill_subagent(&session_id, &subagent_id, &reason))
        .await
        .map_err(|e| {
            conex_run::core_error::CoreError::internal(format!("kill_subagent 阻塞任务失败：{e}"))
        })?
        .map_err(map_lifecycle_err)
}

/// D4 §3.1：kill_all 命令壳——批量终止主会话全部 running 子代理（同步
/// SQLite 面经 spawn_blocking，F2-27；批量语义保持 lifecycle 引擎侧）。
#[tauri::command]
pub(crate) async fn kill_all(
    state: tauri::State<'_, Arc<conex_run::run::CoreRunState>>,
    session_id: String,
    reason: Option<String>,
) -> Result<orchestrator::lifecycle::KillAllOutcome, conex_run::core_error::CoreError> {
    let service = state.lifecycle_service().ok_or_else(|| {
        conex_run::core_error::CoreError::internal("LocalDb 不可用（测试替身 store）")
    })?;
    let reason = reason.unwrap_or_default();
    tokio::task::spawn_blocking(move || service.kill_all(&session_id, &reason))
        .await
        .map_err(|e| {
            conex_run::core_error::CoreError::internal(format!("kill_all 阻塞任务失败：{e}"))
        })?
        .map_err(map_lifecycle_err)
}

/// D4 §3.5：resume_subagent 命令壳——fork 新 run 承接同一目标。
///
/// 两段式：
/// - ① 同步准备段 [orchestrator::lifecycle::SubagentLifecycleService::
///   prepare_resume]（取行 + 定位 + kill-for-resume + 任务/叶子推导，
///   纯 DB + 内存）经 spawn_blocking（F2-27）；
/// - ② fork 段 [orchestrator::lifecycle::SubagentLifecycleService::
///   resume_with_prepared] 经调用方持有的 RecoveryCoordinator 权威
///   实例（D3 装配；未装配 → 结构化错误「恢复协调器未装配」——全原生异步
///   获取 L2 锁并 await 执行，零 block_on 违规）。
#[tauri::command]
pub(crate) async fn resume_subagent(
    state: tauri::State<'_, Arc<conex_run::run::CoreRunState>>,
    session_id: String,
    subagent_id: String,
    prompt: Option<String>,
) -> Result<orchestrator::lifecycle::ResumeOutcome, conex_run::core_error::CoreError> {
    let service = state.lifecycle_service().ok_or_else(|| {
        conex_run::core_error::CoreError::internal("LocalDb 不可用（测试替身 store）")
    })?;
    // ① 同步准备段（F2-27：同步 SQLite 面经 spawn_blocking）
    let prepared = {
        let service = service.clone();
        let sid = session_id.clone();
        let aid = subagent_id.clone();
        tokio::task::spawn_blocking(move || service.prepare_resume(&sid, &aid, prompt.as_deref()))
            .await
            .map_err(|e| {
                conex_run::core_error::CoreError::internal(format!(
                    "resume 准备段阻塞任务失败：{e}"
                ))
            })?
            .map_err(map_lifecycle_err)?
    };
    // ② fork 段：全异步获取 L2 锁并执行，零 block_on
    let coord = state.coordinator_for(&session_id).ok_or_else(|| {
        conex_run::core_error::CoreError::internal("恢复协调器未装配（D3 未接线，resume 暂不可用）")
    })?;

    let mut coordinator = coord.lock().await;
    service
        .resume_with_prepared(&mut coordinator, &session_id, prepared)
        .await
        .map_err(map_lifecycle_err)
}
