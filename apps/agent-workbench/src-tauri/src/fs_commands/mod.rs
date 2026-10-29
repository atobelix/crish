pub(crate) mod directory;
pub(crate) mod read;
pub(crate) mod skills;
pub(crate) mod skills_owned;
pub(crate) mod types;
pub(crate) mod write;

pub(crate) use conex_run::core_error::CoreError;
pub(crate) use types::FileCommandError;

/// 列出目录（PE-07 T07.2：无 workspace_root 参数，根由 WorkspaceRegistry 解析）。
///
/// wire 名 = `workbench_list_directory`（T-F 06：分裂标签统一，显式 rename）。
/// U-BLOCK：async + spawn_blocking——tokio worker 不被同步目录 IO 占满。
#[tauri::command(rename = "workbench_list_directory")]
pub(crate) async fn list_directory(
    app: tauri::AppHandle,
    path: String,
) -> Result<types::ListDirectoryResult, FileCommandError> {
    let result = tokio::task::spawn_blocking(move || directory::list_directory(&app, path))
        .await
        .map_err(|e| {
            FileCommandError::new(
                types::ERR_INTERNAL,
                format!("list_directory task failed: {e}"),
            )
        })?;
    result
}

/// 读取文件内容（PE-07 T07.2：无 workspace_root 参数，根由 WorkspaceRegistry 解析）。
///
/// wire 名 = `workbench_read_file_content`（T-F 06：分裂标签统一，显式 rename）。
/// U-BLOCK：async + spawn_blocking。
#[tauri::command(rename = "workbench_read_file_content")]
pub(crate) async fn read_file_content(
    app: tauri::AppHandle,
    path: String,
    max_lines: Option<usize>,
) -> Result<types::ReadFileContentResult, FileCommandError> {
    let result =
        tokio::task::spawn_blocking(move || read::read_file_content(&app, path, max_lines))
            .await
            .map_err(|e| {
                FileCommandError::new(
                    types::ERR_INTERNAL,
                    format!("read_file_content task failed: {e}"),
                )
            })?;
    result
}

/// 写入文件内容（PE-07 T07.2：无 workspace_root 参数，根由 WorkspaceRegistry 解析）。
///
/// T-EG-05（F7）：overwrite 语义与工具侧 write_file 对齐——默认拒绝覆盖
/// （已存在且未显式 overwrite=true → file_exists 错误）；Option<bool> 让
/// 未传参调用方保持「默认拒绝覆盖」语义（与前端 workspaceFsApi 同步）。
/// wire 名 = `workbench_write_file_content`（T-F 06：分裂标签统一，显式 rename）。
/// U-BLOCK：async + spawn_blocking。
#[tauri::command(rename = "workbench_write_file_content")]
pub(crate) async fn write_file_content(
    app: tauri::AppHandle,
    path: String,
    content: String,
    overwrite: Option<bool>,
) -> Result<types::WriteFileContentResult, FileCommandError> {
    let overwrite = overwrite.unwrap_or(false);
    let result = tokio::task::spawn_blocking(move || {
        write::write_file_content(&app, path, content, overwrite)
    })
    .await
    .map_err(|e| {
        FileCommandError::new(
            types::ERR_INTERNAL,
            format!("write_file_content task failed: {e}"),
        )
    })?;
    result
}

/// 发现技能（PE-07 T07.2：workspace_path / extra_dirs 经注册表包含性校验）。
/// 错误协议统一 `CoreError {kind, detail}`（F4 F1-02 / PS-04 T4.5）。
///
/// `R: tauri::Runtime` 泛型：测试注入 MockRuntime 可直接调用（先例
/// core_commands.rs:170-177），生产走 Wry。
#[tauri::command]
pub(crate) fn workbench_discover_skills<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    workspace_path: Option<String>,
    extra_dirs: Vec<String>,
) -> Result<Vec<skills::RustSkill>, CoreError> {
    skills::workbench_discover_skills(&app, workspace_path, extra_dirs)
}

/// 写入或卸载本应用技能副本（项目 `.conex/skills` 或全局 `.crish/skills`）。
///
/// 与其他文件命令一样把磁盘操作放到阻塞线程，避免占住界面运行时。
#[tauri::command(rename = "workbench_mutate_owned_skill")]
pub(crate) async fn workbench_mutate_owned_skill(
    app: tauri::AppHandle,
    action: String,
    scope: String,
    workspace_path: Option<String>,
    slug: String,
    content: Option<String>,
    overwrite: Option<bool>,
) -> Result<skills_owned::OwnedSkillWrite, CoreError> {
    let overwrite = overwrite.unwrap_or(false);
    tokio::task::spawn_blocking(move || {
        skills_owned::mutate_owned_skill(
            &app,
            &action,
            &scope,
            workspace_path.as_deref(),
            &slug,
            content.as_deref(),
            overwrite,
        )
    })
    .await
    .map_err(|err| CoreError::internal(format!("技能副本写入任务中断：{err}")))?
}

#[cfg(test)]
mod tests;
