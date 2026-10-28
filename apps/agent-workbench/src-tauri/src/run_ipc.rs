//! run IPC 命令面（Tauri 薄壳）
//!
//! run 编排域业务实现已下沉 `conex-run` crate（run_task_impl / run_control_impl /
//! cancel_run_impl / trash_*_at / settings 投影面等）；本模块只承载 Tauri 宿主侧：
//! - [trash_root_for]：回收站根解析（托管状态注入优先，工作区注册表兜底）；
//! - 设置域直调体（settings_snapshot_value / settings_update_impl）：操作
//!   壳层 ModelsStore 单例（读修订号 → 改树 → apply CAS → 重载引擎 provider）；
//! - 十条 `#[tauri::command]` 薄壳：参数解包 → 调 `conex_run` 契约体。
//!
//! wire 名与 command_manifest 登记一致；函数体无内联业务逻辑。

use std::sync::Arc;

use conex_fs::trash::TrashService;
use conex_run::core_error::CoreError;
use conex_run::run::{
    abort_session_run_impl, approve_tool_impl, cancel_run_impl, compact_now_impl, deny_tool_impl,
    emit_trash_audit, run_control_impl, run_task_impl, trash_list_at, trash_purge_at,
    trash_restore_at, ApproveResponse, CancelRunResponse, CompactNowResult, CoreRunState,
    RunTaskOptions, RunTaskResponse, TrashListResponse, TrashPurgeResponse, TrashRestoreResponse,
    TrashRootConfig,
};
use conex_types::events::{SecurityAuditDecision, SecurityAuditOperation};

#[cfg(test)]
#[path = "run_ipc_tests.rs"]
mod tests;

// ── 回收站根解析（宿主侧）──────────────────────────────────────────

/// 解析回收站根：
/// 1. 托管状态注入优先（main.rs 配置注入点，数据目录或显式根）；
/// 2. 未注入 → 活动工作区 `.crish-trash`（S3 执行期兜底语义）；
///
/// 工作区注册表不可用 → 结构化错误（不静默退化）。
/// 供 fs_commands/delete.rs（UI 删除命令）复用，保证 UI 删除与 AI 删除
/// 落入同一回收站根（S11 G2 删除接管收敛）。
pub(crate) fn trash_root_for(app: &tauri::AppHandle) -> Result<std::path::PathBuf, CoreError> {
    use tauri::Manager as _;
    if let Some(config) = app.try_state::<TrashRootConfig>() {
        if let Some(root) = &config.root {
            return Ok(root.clone());
        }
    }
    let guard = crate::workspace::resolve_guard(app, "").map_err(|e| {
        CoreError::Internal(format!(
            "无法解析回收站根（工作区注册表不可用）：{}: {}",
            e.code, e.message
        ))
    })?;
    Ok(guard.root().join(conex_run::run::DEFAULT_TRASH_DIR_NAME))
}

// ── 设置域直调体（R1-04 REST 写面：M6 C28/C29 的 REST T1 形态）──────

/// 设置脱敏快照投影（键名与旧 REST 契约一致，值全部派生自统一配置树；
/// K-02：apiKey 恒空串，前端只见存在状态与脱敏摘要；无活动模型 =
/// 用户未选择的如实投影，禁止补默认值）。
///
/// 旧 `endpoint` / `credentialPersistence` / `credentialDiagnostic` 属已
/// 退役的单模型 store 私有概念，不再投影；REST keys 白名单过滤对缺失键
/// 即忽略，无消费兼容负担。
pub(crate) fn settings_snapshot_value() -> Result<serde_json::Value, CoreError> {
    let store = crate::config::models_store()
        .map_err(|e| CoreError::invalid_input(format!("模型配置未就绪：{e}")))?;
    let committed = store
        .committed()
        .map_err(|e| CoreError::invalid_input(format!("模型配置不可读：{e}")))?;
    let active = crate::config::resolve_active_model().ok().flatten();

    let (base_url, model_id, has_api_key, api_key_last4, credential_mode) = match &active {
        Some(resolved) => {
            let credential_mode = match resolved.provider.api_key_ref.as_deref() {
                Some(reference) if reference.starts_with("dpapi:") => "dpapi",
                Some(reference) if reference.starts_with("env:") => "env",
                Some(_) => "invalid",
                None => "unset",
            };
            let secret = resolved.api_key.as_str();
            let chars: Vec<char> = secret.chars().collect();
            let start = chars.len().saturating_sub(4);
            let last4: String = chars[start..].iter().collect();
            (
                resolved.provider.base_url.clone().unwrap_or_default(),
                resolved.model_ref.model_id.clone(),
                !secret.is_empty(),
                if secret.is_empty() {
                    String::new()
                } else {
                    last4
                },
                credential_mode.to_string(),
            )
        }
        // Ok(None) = 用户未选择活动模型；Err = 配置未就绪：二者均如实投影空值
        None => (
            String::new(),
            String::new(),
            false,
            String::new(),
            "unset".to_string(),
        ),
    };

    // 供应商脱敏投影：身份与可见字段，无任何凭据材料
    let providers: serde_json::Map<String, serde_json::Value> = committed
        .tree
        .providers
        .iter()
        .map(|(id, provider)| {
            let models: Vec<serde_json::Value> = provider
                .models
                .iter()
                .map(|m| {
                    serde_json::json!({
                        "id": m.id,
                        "displayName": m.display_name,
                        "enabled": m.enabled,
                    })
                })
                .collect();
            (
                id.clone(),
                serde_json::json!({
                    "id": id,
                    "displayName": provider.display_name,
                    "baseUrl": provider.base_url,
                    "enabled": provider.enabled,
                    "models": models,
                }),
            )
        })
        .collect();

    Ok(serde_json::json!({
        "apiKey": "",
        "baseUrl": base_url,
        "model": model_id,
        "hasApiKey": has_api_key,
        "apiKeyLast4": api_key_last4,
        "credentialMode": credential_mode,
        "activeModel": committed.tree.active_model,
        "activeProfileId": active
            .as_ref()
            .map(|resolved| resolved.model_ref.provider_id.clone())
            .unwrap_or_default(),
        "providers": serde_json::Value::Object(providers),
    }))
}

/// 设置脱敏快照直调体（M6 C28：统一配置树投影——脱敏与凭据状态由
/// 投影层保证；keys 子集过滤在服务层完成）
pub(crate) fn settings_get_impl() -> Result<serde_json::Value, CoreError> {
    settings_snapshot_value()
}

/// 非敏感配置更新直调体（Z0 §9.3 R1-04「配置非敏感更新」：与
/// config_update 同语义——baseUrl / model 两键可写，经统一配置事务落
/// 盘（读修订号 → 改树 → apply CAS），写成功后重载引擎 provider（下一
/// 次 run 用新值）。credentialMode / endpoint / stream 属旧单模型 store
/// 私有写面，R1-04 **显式拒绝**（fail-closed：不静默忽略，避免「请求
/// 成功但未生效」）。
///
/// 语义映射（SSOT 单轨）：baseUrl → 活动供应商 base_url；model → 活动
/// 选择切换到同供应商下已存在的模型 id。无活动模型时显式拒绝，不猜默认。
pub(crate) fn settings_update_impl(
    state: &CoreRunState,
    base_url: Option<String>,
    model: Option<String>,
    credential_mode: Option<String>,
    endpoint: Option<String>,
    stream: Option<bool>,
) -> Result<serde_json::Value, CoreError> {
    if credential_mode.is_some() || endpoint.is_some() || stream.is_some() {
        return Err(CoreError::invalid_input(
            "credentialMode / endpoint / stream 不在 REST 非敏感配置更新面（仅 baseUrl / model）",
        ));
    }
    if base_url.is_none() && model.is_none() {
        return settings_snapshot_value();
    }
    let store = crate::config::models_store()
        .map_err(|e| CoreError::invalid_input(format!("模型配置未就绪：{e}")))?;
    let committed = store
        .committed()
        .map_err(|e| CoreError::invalid_input(format!("模型配置不可读：{e}")))?;
    let mut tree = committed.tree.clone();
    // 无活动模型 = 用户未选择：显式拒绝，不挑选供应商或列表首项
    let active = tree.active_model.clone().ok_or_else(|| {
        CoreError::invalid_input(
            "当前无活动模型，REST 非敏感配置更新不可用；请先在 设置 → 模型 选择模型",
        )
    })?;
    let provider = tree
        .providers
        .get_mut(&active.provider_id)
        .ok_or_else(|| CoreError::invalid_input("活动供应商不存在于配置树"))?;
    if let Some(url) = base_url {
        provider.base_url = Some(url);
    }
    if let Some(m) = model {
        if m != active.model_id {
            let exists = provider.models.iter().any(|candidate| candidate.id == m);
            if !exists {
                return Err(CoreError::invalid_input(format!(
                    "目标模型不存在：{m}（供应商：{}）",
                    active.provider_id
                )));
            }
            tree.active_model = Some(agent_provider::models::ModelRef {
                provider_id: active.provider_id.clone(),
                model_id: m,
            });
        }
    }
    store
        .apply(tree, &committed.revision)
        .map_err(|e| CoreError::invalid_input(format!("配置保存被拒绝：{e}")))?;
    // 与 config_update 同语义：store 写成功后重载引擎 provider
    state.reload_provider();
    settings_snapshot_value()
}

// ── 十条 Tauri 命令薄壳（wire 名与 command_manifest 登记一致）────────

/// `core_run_task`：发起 run（参数归一与装配逻辑在 conex_run::run_task_impl）
#[tauri::command]
pub(crate) async fn core_run_task(
    state: tauri::State<'_, Arc<CoreRunState>>,
    options: RunTaskOptions,
) -> Result<RunTaskResponse, CoreError> {
    run_task_impl(Arc::clone(state.inner()), options).await
}

/// `core_run_control`：run 控制面（L0-L3 五参控制；语义见 run_control_impl）
#[tauri::command]
pub(crate) async fn core_run_control(
    state: tauri::State<'_, Arc<CoreRunState>>,
    run_id: String,
    level: String,
    message: Option<String>,
    reason: Option<String>,
    payload: Option<serde_json::Value>,
) -> Result<(), CoreError> {
    run_control_impl(
        state.inner(),
        run_id.trim(),
        &level,
        message,
        reason,
        payload,
    )
    .await
}

/// `core_set_run_permission_mode`：运行时切换会话主 run 权限（子代理
/// 活单元经父链自动同步；无活动 run → NotFound，前端忽略即可）
#[tauri::command]
pub(crate) async fn core_set_run_permission_mode(
    state: tauri::State<'_, Arc<CoreRunState>>,
    session_id: String,
    mode: String,
) -> Result<(), CoreError> {
    let parsed = conex_types::device::PermissionMode::parse_alias(Some(&mode))
        .ok_or_else(|| CoreError::invalid_input(format!("未知权限模式：{mode}")))?;
    state
        .inner()
        .set_session_permission_mode(session_id.trim(), parsed)
}

/// `core_compact_now`：F4 手动压缩命令
#[tauri::command]
pub(crate) async fn core_compact_now(
    state: tauri::State<'_, Arc<CoreRunState>>,
    session_id: String,
    target_tokens: Option<u64>,
) -> Result<CompactNowResult, CoreError> {
    compact_now_impl(&state, session_id.trim(), target_tokens).await
}

/// `core_cancel_run`：取消 run（L2 协作 / L3 强制）
#[tauri::command]
pub(crate) async fn core_cancel_run(
    state: tauri::State<'_, Arc<CoreRunState>>,
    run_id: String,
    mode: Option<String>,
) -> Result<CancelRunResponse, CoreError> {
    cancel_run_impl(state.inner(), &run_id, mode.as_deref(), None).await
}

/// `workbench_abort_run`：Tier-2 会话级中止（前端级联取消总线）
#[tauri::command]
pub(crate) async fn workbench_abort_run(
    state: tauri::State<'_, Arc<CoreRunState>>,
    session_id: String,
) -> Result<bool, CoreError> {
    abort_session_run_impl(state.inner(), &session_id).await
}

/// `core_approve_tool`：批准工具调用（I-02 pending 校验 + approval-resolved）
#[tauri::command]
pub(crate) async fn core_approve_tool(
    state: tauri::State<'_, Arc<CoreRunState>>,
    run_id: String,
    tool_call_id: String,
    decision: Option<String>,
) -> Result<ApproveResponse, CoreError> {
    approve_tool_impl(state.inner(), &run_id, &tool_call_id, decision).await
}

/// `core_deny_tool`：拒绝工具调用
#[tauri::command]
pub(crate) async fn core_deny_tool(
    state: tauri::State<'_, Arc<CoreRunState>>,
    run_id: String,
    tool_call_id: String,
    reason: Option<String>,
) -> Result<ApproveResponse, CoreError> {
    deny_tool_impl(state.inner(), &run_id, &tool_call_id, reason.as_deref()).await
}

/// `trash_list`：列出回收站条目（误删恢复入口）
#[tauri::command]
pub(crate) fn trash_list(app: tauri::AppHandle) -> Result<TrashListResponse, CoreError> {
    let root = trash_root_for(&app)?;
    trash_list_at(&root)
}

/// `trash_restore`：按条目 id 恢复到原路径（校验 checksum 防篡改）
#[tauri::command]
pub(crate) fn trash_restore(
    app: tauri::AppHandle,
    entry_id: String,
    session_id: Option<String>,
    state: tauri::State<'_, Arc<CoreRunState>>,
) -> Result<TrashRestoreResponse, CoreError> {
    let root = trash_root_for(&app)?;
    // I2-S8：恢复前取条目大小（恢复成功后条目已从清单移除，必须先行）
    let size = TrashService::new(&root)
        .list()
        .into_iter()
        .find(|e| e.id == entry_id.trim())
        .map(|e| e.size)
        .unwrap_or(0);
    let response = trash_restore_at(&root, &entry_id)?;
    // I2-S8：恢复动作审计（decision=restored；经事件桥发前端事件流，
    // sessionId 由调用方（S5 恢复面板接线）携带，缺失时仅落审计日志）
    emit_trash_audit(
        state.bridge(),
        session_id.as_deref(),
        SecurityAuditOperation::TrashRestore,
        SecurityAuditDecision::Restored,
        &response.original_path,
        size,
    );
    Ok(response)
}

/// `trash_purge`：彻底清除条目（显式用户调用，不可恢复）
#[tauri::command]
pub(crate) fn trash_purge(
    app: tauri::AppHandle,
    entry_id: String,
    session_id: Option<String>,
    state: tauri::State<'_, Arc<CoreRunState>>,
) -> Result<TrashPurgeResponse, CoreError> {
    let root = trash_root_for(&app)?;
    // I2-S8：清除前取条目原路径与大小（清除成功后条目已从清单移除）
    let entry = TrashService::new(&root)
        .list()
        .into_iter()
        .find(|e| e.id == entry_id.trim());
    let (original_path, size) = entry
        .as_ref()
        .map(|e| (e.original_path.to_string_lossy().into_owned(), e.size))
        .unwrap_or_else(|| (entry_id.to_string(), 0));
    let response = trash_purge_at(&root, &entry_id)?;
    // I2-S8：清除动作审计（decision=purged；经事件桥发前端事件流）
    emit_trash_audit(
        state.bridge(),
        session_id.as_deref(),
        SecurityAuditOperation::TrashPurge,
        SecurityAuditDecision::Purged,
        &original_path,
        size,
    );
    Ok(response)
}
