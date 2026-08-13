//! SR-05 · 拆分 · ≠ EL · 域：命令面（wire 结构 + build_* 契约体 +
//! workbench_* Tauri 命令）。结构拆分轮仅搬移，命令契约零改动。
//! 接线：background.rs `mod bg_commands;`。

use crate::core_error::CoreError;
use agent_tools::background::{BackgroundTaskInfo, BackgroundTaskStatus, KillResult, TaskState};
use agent_tools::definition::ToolError;
use conex_types::error::codes;
use serde::Serialize;
use std::sync::Arc;

use super::bg_registry::BackgroundTaskRegistry;

// ============================================================================
// 命令面（T-AB-08：三条 Tauri 命令恢复）
// ============================================================================

/// list 命令响应：`{ tasks: [...] }`（对齐前端 extractBackgroundTaskArray 取
/// `root.tasks` 的解析面）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundTaskListResponse {
    pub(crate) tasks: Vec<BackgroundTaskWire>,
}

/// 列表条目 wire 形状：字段对齐前端 parseBackgroundTask（taskId/command/
/// startedAt/duration/status/logPath；serde camelCase）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundTaskWire {
    pub(crate) task_id: String,
    pub(crate) command: String,
    /// kebab-case 状态（前端 normalizeBackgroundTaskState 容错映射）
    pub(crate) status: TaskState,
    /// 毫秒时间戳（parseBackgroundTaskStartedAt 直读）
    pub(crate) started_at: u64,
    /// 毫秒
    pub(crate) duration: u64,
    pub(crate) finished_at: Option<u64>,
    pub(crate) exit_code: Option<i32>,
    pub(crate) log_path: String,
    pub(crate) line_count: u64,
    pub(crate) last_output_at: u64,
    pub(crate) is_daemon: bool,
    pub(crate) owner_run_id: Option<String>,
    /// 疑似卡死标记（14-T2a wire：前端 parseBackgroundTask 直读 `o.suspicious`
    /// 渲染「疑似卡死」——缺此字段即恒 undefined，故 wire 层必须透传）
    pub(crate) suspicious: bool,
}

impl BackgroundTaskWire {
    fn from_info(info: &BackgroundTaskInfo) -> Self {
        Self {
            task_id: info.task_id.clone(),
            command: info.command.clone(),
            status: info.status,
            started_at: info.started_at_ms,
            duration: info.duration_ms,
            finished_at: info.finished_at_ms,
            exit_code: info.exit_code,
            log_path: info.log_path.clone(),
            line_count: info.line_count,
            last_output_at: info.last_output_at_ms,
            is_daemon: info.is_daemon,
            owner_run_id: info.owner_run_id.clone(),
            suspicious: info.suspicious,
        }
    }
}

/// get_output 命令响应：`{ output, ...status 全字段 }`——`output` 字段供前端
/// parseBackgroundTaskOutput 直通取用（`o.output` 优先级最高）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundTaskOutputResponse {
    /// 输出预览（= status.tail；前端 parseBackgroundTaskOutput 直读）
    pub(crate) output: String,
    /// 任务状态快照（flatten 展开为顶层字段）
    #[serde(flatten)]
    pub(crate) status: BackgroundTaskStatus,
}

/// ToolError → CoreError（命令面统一错误协议；NotFound 保形，其余 Internal 兜底，
/// 不静默吞错）。
fn tool_err_to_core(err: ToolError) -> CoreError {
    if err.code() == codes::TOOL_NOT_FOUND {
        CoreError::NotFound(err.to_string())
    } else {
        CoreError::Internal(err.to_string())
    }
}

/// list 命令契约体（测试直调，不依赖 Tauri runtime）。
pub(crate) async fn build_list_response(
    registry: &BackgroundTaskRegistry,
) -> Result<BackgroundTaskListResponse, CoreError> {
    let infos = registry.list(true).await.map_err(tool_err_to_core)?;
    let tasks = infos.iter().map(BackgroundTaskWire::from_info).collect();
    Ok(BackgroundTaskListResponse { tasks })
}

/// get_output 命令契约体（测试直调，不依赖 Tauri runtime）。
pub(crate) async fn build_output_response(
    registry: &BackgroundTaskRegistry,
    task_id: &str,
) -> Result<BackgroundTaskOutputResponse, CoreError> {
    let status = registry.status(task_id).await.map_err(tool_err_to_core)?;
    Ok(BackgroundTaskOutputResponse {
        output: status.tail.clone(),
        status,
    })
}

/// 列出全部后台任务（含已结束），`{ tasks: [...] }`。
///
/// 归档循环接线点（T-AB-12 1）：Tauri State 持 Arc 注册表（与 main.rs 包壳为
/// 同一实例），首次列表轮询即惰性启动 60s 归档线程——后续由线程周期清扫，
/// 本命令体经 list() 的惰性清扫兜底（不依赖线程时序）。
#[tauri::command]
pub(crate) async fn workbench_list_background_tasks(
    state: tauri::State<'_, Arc<BackgroundTaskRegistry>>,
) -> Result<BackgroundTaskListResponse, CoreError> {
    state.inner().spawn_archive_loop();
    build_list_response(state.inner()).await
}

/// 查询单任务状态与输出（运行中同样可读；未知 taskId → CoreError::NotFound）。
#[tauri::command]
pub(crate) async fn workbench_get_background_task_output(
    state: tauri::State<'_, Arc<BackgroundTaskRegistry>>,
    task_id: String,
) -> Result<BackgroundTaskOutputResponse, CoreError> {
    build_output_response(state.inner(), &task_id).await
}

/// 取消后台任务（T-AB-11 两阶段终止：优雅 → 5s → 强制；返回 KillResult 形状，
/// Killed / AlreadyExited / Failed 三态）。
#[tauri::command]
pub(crate) async fn workbench_cancel_background_task(
    state: tauri::State<'_, Arc<BackgroundTaskRegistry>>,
    task_id: String,
) -> Result<KillResult, CoreError> {
    state.inner().kill(&task_id).await.map_err(tool_err_to_core)
}

/// send_input 命令契约体（测试直调，不依赖 Tauri runtime；语义与
/// registry.send_input 完全一致：默认追加 `\n`，失败分类 task_not_found /
/// stdin_closed，未知 taskId → CoreError::NotFound）。
pub(crate) async fn build_send_input_response(
    registry: &BackgroundTaskRegistry,
    task_id: &str,
    text: &str,
    append_newline: bool,
) -> Result<(), CoreError> {
    registry
        .send_input(task_id, text, append_newline)
        .await
        .map_err(tool_err_to_core)
}

/// 向后台任务 stdin 注入输入（T-AB-10 2 操作面；T-AB-20 前端
/// sendBackgroundTaskInput 的 Rust 命令面——前端 backgroundTasksApi.ts 已
/// 接线等待本命令，F3 轮注册补齐）。参数 camelCase：taskId / text /
/// appendNewline（缺省 true 追加换行）。成功返回 unit，失败按 CoreError 分类。
#[tauri::command]
pub(crate) async fn workbench_send_input(
    state: tauri::State<'_, Arc<BackgroundTaskRegistry>>,
    task_id: String,
    text: String,
    append_newline: Option<bool>,
) -> Result<(), CoreError> {
    build_send_input_response(
        state.inner(),
        &task_id,
        &text,
        append_newline.unwrap_or(true),
    )
    .await
}
