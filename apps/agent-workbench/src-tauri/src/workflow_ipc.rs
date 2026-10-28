//! workflow IPC 命令面（T-CF-14，G9 命令面 / REQ-C03）：六条命令薄壳
//!
//! `create-workflow` / `list-workflows` / `update-workflow` / `delete-workflow` /
//! `trigger-workflow` / `list-workflow-runs` —— 业务后端
//! （[conex_run::workflow::WorkflowBackend] / 存储 / 调度委托 / 触发执行链）
//! 已下沉 `conex-run` crate；本模块只承载 Tauri 宿主侧：
//! - [WorkflowCommandState]：命令后端托管状态（session_meta 真存储 + 引擎
//!   共享 steering 队列）；
//! - [emit_workflow_event]：`app.emit` 全域事件发射（[WorkflowEventSink]
//!   的 Tauri 实现，IPC / 工具通道 / 定时触发回调三路共用）；
//! - [WorkflowCreationChannelBinding]：create_workflow 工具通道延迟绑定
//!   （backend + AppHandle；绑定前工具返回 common.unsupported）。
//!
//! wire 名 kebab-case，与 command_manifest 登记一致；`#[tauri::command]`
//! 函数体只做参数解包与后端委托，无内联业务逻辑。

use std::sync::Arc;

use conex_run::core_error::CoreError;
use conex_run::workflow::{
    parse_schedule_input, TriggerResult, WorkflowBackend, WorkflowEventSink, WorkflowPatch,
    WorkflowRunView, WorkflowScheduleWire, WorkflowView,
};
use tauri::Emitter;

// ── 命令状态与后端（命令面唯一接线点；注册表委托在此注入）──────────

/// Tauri 托管状态：workflow 命令后端
pub(crate) struct WorkflowCommandState {
    backend: Arc<WorkflowBackend>,
}

impl WorkflowCommandState {
    /// 新建（setup 装配：session_meta 真存储 + 引擎共享 steering 队列——
    /// 30 方案 P6：队列与 CoreRunState 的 pending_queue 同一 Arc 实例，
    /// 消除 A5-H01a 队列双实例——触发注入落真实队列，idle 续 run 消费
    /// 唤醒；注册表委托槽初始为空，经 [Self::set_registry] 注入共享实例）
    pub(crate) fn new(
        db: conex_db::LocalDb,
        steering_queue: Arc<std::sync::Mutex<orchestrator::PendingMessageQueue>>,
    ) -> Self {
        use conex_run::workflow::{QueueSteeringSink, SessionMetaWorkflowStore};
        Self {
            backend: Arc::new(WorkflowBackend::new(
                Arc::new(SessionMetaWorkflowStore::new(db)),
                Arc::new(QueueSteeringSink::new(steering_queue)),
            )),
        }
    }

    /// 注入 SchedulerRegistry 委托（30 方案 P6 装配收口唯一入口；
    /// 透传 WorkflowBackend::set_registry——main.rs 装配轮调用）
    pub(crate) fn set_registry(&self, registry: Arc<conex_run::sched::SchedulerRegistry>) {
        self.backend.set_registry(registry);
    }

    /// 后端句柄（生产面：create_workflow 工具通道延迟绑定（main.rs 装配轮
    /// 取走注入引擎侧 [WorkflowCreationChannelBinding]，绑定前工具返回
    /// common.unsupported）；测试访问：装配轮集成断言）
    pub(crate) fn backend_handle(&self) -> Arc<WorkflowBackend> {
        Arc::clone(&self.backend)
    }
}

// ── 全域事件发射（WorkflowEventSink 的 Tauri 实现）──────────────────

/// workflow 全域事件发射 helper（唯一发射面：IPC 命令路径与工具通道路径
/// 共用；发射失败仅留痕不阻断注册主流程——事件是通知面，不是落盘面）
pub(crate) fn emit_workflow_event(app: &tauri::AppHandle, event: &str, payload: serde_json::Value) {
    if let Err(e) = app.emit(event, payload) {
        tracing::warn!(target: "workflow", "workflow 事件发射失败（{event}）：{e}");
    }
}

/// [WorkflowEventSink] 的 Tauri 实现（main.rs 装配：AppHandle 注入
/// WorkflowBackend.set_app_context / ProductionScheduledLauncher）
pub(crate) struct TauriWorkflowEventSink {
    app: tauri::AppHandle,
}

impl TauriWorkflowEventSink {
    pub(crate) fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl WorkflowEventSink for TauriWorkflowEventSink {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        emit_workflow_event(&self.app, event, payload);
    }
}

// ── create_workflow 工具通道（维度五 / 05 详案 §2.4 路径 A 生产接线）────

/// 工具通道绑定载荷：backend（唯一注册链路真源）+ AppHandle（成功落盘后
/// 广播 `workflow:created` 全域事件——与 IPC 命令路径共用同一发射 helper）
struct BoundWorkflowBackend {
    backend: Arc<WorkflowBackend>,
    app: tauri::AppHandle,
}

/// create_workflow 工具通道延迟绑定适配器（对齐 ContinuityChannelBoard
/// 延迟绑定范式：引擎装配早于 workflow 后端创建（main.rs setup ⑧c），
/// 装配期注入空绑定占位——工具返回 common.unsupported；main.rs 在
/// `WorkflowCommandState::new` 之后调用 [Self::bind] 完成生产转正）
///
/// 注册链路 SSOT：`create` 复用既有 `create-workflow` IPC 的同一校验链
/// （WorkflowScheduleWire::parse → WorkflowBackend::create），**禁止**
/// 平行实现第二套校验 / 注册逻辑（05 详案 §2.4 接线注记）。
pub(crate) struct WorkflowCreationChannelBinding {
    inner: std::sync::Mutex<Option<BoundWorkflowBackend>>,
}

impl std::fmt::Debug for WorkflowCreationChannelBinding {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 绑定内含 AppHandle / WorkflowBackend，均非稳定调试面——只披露绑定状态
        let bound = self.inner.lock().map(|g| g.is_some()).unwrap_or(false);
        f.debug_struct("WorkflowCreationChannelBinding")
            .field("bound", &bound)
            .finish()
    }
}

impl WorkflowCreationChannelBinding {
    /// 装配期构造（未绑定；engine 装配经 BuiltinToolConfig 注入）
    pub(crate) fn new() -> Self {
        Self {
            inner: std::sync::Mutex::new(None),
        }
    }

    /// 生产绑定（main.rs setup：workflow_state 创建后取 backend + AppHandle）
    pub(crate) fn bind(&self, backend: Arc<WorkflowBackend>, app: tauri::AppHandle) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(BoundWorkflowBackend { backend, app });
    }
}

impl Default for WorkflowCreationChannelBinding {
    fn default() -> Self {
        Self::new()
    }
}

/// 工具入参 → `create-workflow` 同源 wire 调度 JSON（经
/// WorkflowScheduleWire::parse 复用既有校验链；timezone 仅展示语义——
/// 工具未提供时落 "local" 占位，前端列表按 IANA 校验失败回退本机时区展示，
/// 调度真源始终按本机时区计算）
fn workflow_schedule_wire_json(input: &agent_tools::WorkflowCreateInput) -> serde_json::Value {
    match input.schedule_type.as_str() {
        "daily" => serde_json::json!({
            "type": "daily",
            "time": input.daily_time.clone().unwrap_or_default(),
            "timezone": "local",
        }),
        "intervalMinutes" => serde_json::json!({
            "type": "intervalMinutes",
            "intervalMinutes": input.interval_minutes.unwrap_or_default(),
        }),
        "cron" => serde_json::json!({
            "type": "cron",
            "expression": input.cron_expression.clone().unwrap_or_default(),
        }),
        // manual 为缺省调度类型（与工具 schema 缺省一致）
        _ => serde_json::json!({ "type": "manual" }),
    }
}

#[async_trait::async_trait]
impl agent_tools::WorkflowCreationChannel for WorkflowCreationChannelBinding {
    async fn create(
        &self,
        input: agent_tools::WorkflowCreateInput,
    ) -> Result<agent_tools::WorkflowCreateOutput, agent_tools::WorkflowCreateError> {
        let bound = {
            let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            match guard.as_ref() {
                Some(b) => BoundWorkflowBackend {
                    backend: Arc::clone(&b.backend),
                    app: b.app.clone(),
                },
                None => return Err(agent_tools::WorkflowCreateError::Unsupported),
            }
        };

        let schedule_value = workflow_schedule_wire_json(&input);
        let schedule = WorkflowScheduleWire::parse(&schedule_value)
            .map_err(agent_tools::WorkflowCreateError::InvalidInput)?;

        let mut view = bound
            .backend
            .create(
                input.name,
                input.prompt,
                schedule,
                input.cwd,
                None,
                input.enabled.unwrap_or(true),
            )
            .await
            .map_err(|e: CoreError| {
                agent_tools::WorkflowCreateError::InvalidInput(e.to_string())
            })?;

        if input.target_session_id.is_some()
            || input.execution_mode.is_some()
            || input.target_mode.is_some()
        {
            let exec_mode = input.execution_mode.or(input.target_mode);
            view = bound
                .backend
                .update(
                    &view.id,
                    WorkflowPatch {
                        target_session_id: input.target_session_id,
                        execution_mode: exec_mode,
                        ..WorkflowPatch::default()
                    },
                )
                .await
                .map_err(|e: CoreError| {
                    agent_tools::WorkflowCreateError::InvalidInput(e.to_string())
                })?;
        }

        // 全域状态广播（05 详案 §2.5）：工具路径与 IPC 命令路径共用同一
        // 发射 helper，前端 useWorkflowsState 监听后刷新列表
        emit_workflow_event(
            &bound.app,
            "workflow:created",
            serde_json::json!({
                "workflowId": view.id,
                "name": view.name,
                "nextRunAt": view.next_run_at,
            }),
        );

        Ok(agent_tools::WorkflowCreateOutput {
            workflow_id: view.id,
            name: view.name,
            next_run_at: view.next_run_at,
        })
    }
}

// ── 六条 Tauri 命令（wire 名 kebab-case，与 command_manifest 登记一致）──

/// 创建 / 更新响应（对齐前端 `{ ok, workflow, error? }` 解析面）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowCreateResponse {
    pub workflow: WorkflowView,
}

/// `create-workflow`：创建 workflow（名称/提示词必填；调度按 §4.4 转 cron）
#[tauri::command(rename = "create-workflow")]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn create_workflow(
    name: String,
    prompt: String,
    schedule: Option<serde_json::Value>,
    cwd: Option<String>,
    mode: Option<String>,
    enabled: Option<bool>,
    target_session_id: Option<String>,
    execution_mode: Option<String>,
    permission_mode: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkflowCommandState>,
) -> Result<WorkflowCreateResponse, CoreError> {
    let schedule = parse_schedule_input(schedule.as_ref())?;
    let backend = Arc::clone(&state.inner().backend);
    let mut workflow = backend
        .create(name, prompt, schedule, cwd, mode, enabled.unwrap_or(true))
        .await?;
    if target_session_id.is_some() || execution_mode.is_some() || permission_mode.is_some() {
        workflow = backend
            .update(
                &workflow.id,
                WorkflowPatch {
                    target_session_id,
                    execution_mode,
                    permission_mode,
                    ..WorkflowPatch::default()
                },
            )
            .await?;
    }
    // 全域状态广播（05 详案 §2.5）：前端 useWorkflowsState 监听后即时刷新
    emit_workflow_event(
        &app,
        "workflow:created",
        serde_json::json!({
            "workflowId": workflow.id,
            "name": workflow.name,
            "nextRunAt": workflow.next_run_at,
        }),
    );
    Ok(WorkflowCreateResponse { workflow })
}

/// `list-workflows`：列出全部 workflow
#[tauri::command(rename = "list-workflows")]
pub(crate) async fn list_workflows(
    state: tauri::State<'_, WorkflowCommandState>,
) -> Result<Vec<WorkflowView>, CoreError> {
    let backend = Arc::clone(&state.inner().backend);
    tokio::task::spawn_blocking(move || Ok::<Vec<WorkflowView>, CoreError>(backend.list()))
        .await
        .map_err(|e| CoreError::Internal(format!("list-workflows join: {e}")))?
}

/// `update-workflow`：更新 workflow（部分字段补丁）
#[tauri::command(rename = "update-workflow")]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn update_workflow(
    workflow_id: String,
    name: Option<String>,
    prompt: Option<String>,
    schedule: Option<serde_json::Value>,
    cwd: Option<String>,
    mode: Option<String>,
    enabled: Option<bool>,
    target_session_id: Option<String>,
    execution_mode: Option<String>,
    permission_mode: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkflowCommandState>,
) -> Result<WorkflowCreateResponse, CoreError> {
    if workflow_id.trim().is_empty() {
        return Err(CoreError::InvalidInput("workflowId 不能为空".to_string()));
    }
    let schedule = match schedule.as_ref() {
        Some(v) => Some(parse_schedule_input(Some(v))?),
        None => None,
    };
    let patch = WorkflowPatch {
        name,
        prompt,
        schedule,
        cwd,
        mode,
        enabled,
        target_session_id,
        execution_mode,
        permission_mode,
    };
    let backend = Arc::clone(&state.inner().backend);
    let workflow = backend.update(&workflow_id, patch).await?;
    emit_workflow_event(
        &app,
        "workflow:updated",
        serde_json::json!({
            "workflowId": workflow.id,
            "name": workflow.name,
            "nextRunAt": workflow.next_run_at,
        }),
    );
    Ok(WorkflowCreateResponse { workflow })
}

/// `delete-workflow`：删除 workflow（清单移除，运行历史保留）
#[tauri::command(rename = "delete-workflow")]
pub(crate) async fn delete_workflow(
    workflow_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkflowCommandState>,
) -> Result<(), CoreError> {
    if workflow_id.trim().is_empty() {
        return Err(CoreError::InvalidInput("workflowId 不能为空".to_string()));
    }
    let backend = Arc::clone(&state.inner().backend);
    backend.delete(&workflow_id).await?;
    emit_workflow_event(
        &app,
        "workflow:deleted",
        serde_json::json!({ "workflowId": workflow_id }),
    );
    Ok(())
}

/// `trigger-workflow`：手动立即触发一次（fired_count 计入 + steering 注入 + 真实 Agent 驱动）
#[tauri::command(rename = "trigger-workflow")]
pub(crate) async fn trigger_workflow(
    workflow_id: String,
    state: tauri::State<'_, WorkflowCommandState>,
) -> Result<TriggerResult, CoreError> {
    if workflow_id.trim().is_empty() {
        return Err(CoreError::InvalidInput("workflowId 不能为空".to_string()));
    }
    let backend = Arc::clone(&state.inner().backend);
    tokio::task::spawn_blocking(move || backend.trigger(&workflow_id))
        .await
        .map_err(|e| CoreError::Internal(format!("trigger-workflow join: {e}")))?
}

/// `list-workflow-runs`：运行历史（可按 workflowId 过滤，支持 limit 数量限制）
#[tauri::command(rename = "list-workflow-runs")]
pub(crate) async fn list_workflow_runs(
    workflow_id: Option<String>,
    limit: Option<usize>,
    state: tauri::State<'_, WorkflowCommandState>,
) -> Result<Vec<WorkflowRunView>, CoreError> {
    let backend = Arc::clone(&state.inner().backend);
    tokio::task::spawn_blocking(move || {
        Ok::<Vec<WorkflowRunView>, CoreError>(backend.list_runs(workflow_id.as_deref(), limit))
    })
    .await
    .map_err(|e| CoreError::Internal(format!("list-workflow-runs join: {e}")))?
}
