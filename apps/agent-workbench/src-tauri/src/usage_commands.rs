//! 用量监控 IPC 命令面（Usage Dashboard Tauri Commands）

use conex_db::{ActivityMatrixDto, InsertUsageRecordInput, UsageDashboardDto};
use conex_types::CoreError;
use tauri::State;

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageRecordDeltaInput {
    pub session_id: Option<String>,
    pub run_id: Option<String>,
    pub project_name: Option<String>,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
    pub cost_cny: Option<f64>,
    pub cost_usd: Option<f64>,
    pub timestamp: Option<i64>,
}

/// 1. 获取用量仪表盘全景快照（包含 6 项指标、时钟分桶连续折线、4维模型占比）
#[tauri::command]
pub(crate) async fn usage_get_dashboard_data(
    db_state: State<'_, crate::session_commands::SharedDb>,
    range: Option<String>,
    tz_offset_minutes: Option<i32>,
) -> Result<UsageDashboardDto, CoreError> {
    let db = db_state.inner().local_db();
    let r = range.unwrap_or_else(|| "7d".to_string());
    let tz = tz_offset_minutes.unwrap_or(0);
    tokio::task::spawn_blocking(move || db.query_usage_dashboard(&r, tz, None))
        .await
        .map_err(|e| CoreError::Internal(format!("usage_get_dashboard_data join: {e}")))?
        .map_err(|e| CoreError::Internal(e.message))
}

/// 2. 获取独立热力图矩阵与活跃度切片
#[tauri::command]
pub(crate) async fn usage_get_activity_matrix(
    db_state: State<'_, crate::session_commands::SharedDb>,
    range: Option<String>,
    tz_offset_minutes: Option<i32>,
) -> Result<ActivityMatrixDto, CoreError> {
    let db = db_state.inner().local_db();
    let r = range.unwrap_or_else(|| "30d".to_string());
    let tz = tz_offset_minutes.unwrap_or(0);
    tokio::task::spawn_blocking(move || db.query_activity_matrix(&r, tz, None))
        .await
        .map_err(|e| CoreError::Internal(format!("usage_get_activity_matrix join: {e}")))?
        .map_err(|e| CoreError::Internal(e.message))
}

/// 3. 清空本机历史用量
#[tauri::command]
pub(crate) async fn usage_clear_history(
    db_state: State<'_, crate::session_commands::SharedDb>,
) -> Result<bool, CoreError> {
    let db = db_state.inner().local_db();
    tokio::task::spawn_blocking(move || db.clear_usage_history())
        .await
        .map_err(|e| CoreError::Internal(format!("usage_clear_history join: {e}")))?
        .map_err(|e| CoreError::Internal(e.message))?;
    Ok(true)
}

/// 4. 增量补充上报单次用量
#[tauri::command]
pub(crate) async fn usage_record_delta(
    db_state: State<'_, crate::session_commands::SharedDb>,
    delta: UsageRecordDeltaInput,
) -> Result<bool, CoreError> {
    let db = db_state.inner().local_db();
    let input = InsertUsageRecordInput {
        session_id: delta.session_id.unwrap_or_else(|| "external".to_string()),
        run_id: delta.run_id,
        project_name: delta.project_name.unwrap_or_default(),
        model: delta.model.unwrap_or_else(|| "default".to_string()),
        provider: delta.provider.unwrap_or_default(),
        prompt_tokens: delta.prompt_tokens.unwrap_or(0),
        completion_tokens: delta.completion_tokens.unwrap_or(0),
        cache_read_tokens: delta.cache_read_tokens.unwrap_or(0),
        cache_write_tokens: delta.cache_write_tokens.unwrap_or(0),
        cost_cny: delta.cost_cny.unwrap_or(0.0),
        cost_usd: delta.cost_usd.unwrap_or(0.0),
        timestamp: delta.timestamp.unwrap_or(0),
    };
    tokio::task::spawn_blocking(move || db.insert_usage_record(input))
        .await
        .map_err(|e| CoreError::Internal(format!("usage_record_delta join: {e}")))?
        .map_err(|e| CoreError::Internal(e.message))?;
    Ok(true)
}

/// 5. 存量 LocalStorage 历史平滑幂等导入
#[tauri::command]
pub(crate) async fn usage_import_legacy_snapshot(
    db_state: State<'_, crate::session_commands::SharedDb>,
    snapshot: serde_json::Value,
) -> Result<bool, CoreError> {
    let db = db_state.inner().local_db();
    let imported = tokio::task::spawn_blocking(move || db.import_legacy_usage_snapshot(&snapshot))
        .await
        .map_err(|e| CoreError::Internal(format!("usage_import_legacy_snapshot join: {e}")))?
        .map_err(|e| CoreError::Internal(e.message))?;
    Ok(imported)
}
