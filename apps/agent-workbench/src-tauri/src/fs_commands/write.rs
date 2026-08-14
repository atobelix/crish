use crate::fs_commands::types::{
    file_too_large_error, FileCommandError, WorkspaceFsGuard, WriteFileContentResult,
    ERR_FILE_EXISTS, ERR_WRITE_FILE, MAX_TEXT_FILE_BYTES,
};

/// 写入文件内容（PE-07 T07.2：无 workspace_root 参数，根由 WorkspaceRegistry 解析）。
///
/// T-EG-05（F7）：overwrite 语义与工具侧 write_file 对齐——默认拒绝覆盖
/// （已存在且 overwrite=false → file_exists 错误），显式 overwrite=true
/// 才放行覆盖；消除「工具拒绝、命令允许」的口径分裂。
pub(crate) fn write_file_content(
    app: &tauri::AppHandle,
    path: String,
    content: String,
    overwrite: bool,
) -> Result<WriteFileContentResult, FileCommandError> {
    let guard = crate::workspace::resolve_guard(app, &path)?;
    write_file_content_with_guard(&guard, &path, &content, overwrite)
}

pub(crate) fn write_file_content_with_guard(
    guard: &WorkspaceFsGuard,
    path: &str,
    content: &str,
    overwrite: bool,
) -> Result<WriteFileContentResult, FileCommandError> {
    let file_path = guard.resolve_for_write(path)?;
    if file_path.exists() && !overwrite {
        // 默认拒绝覆盖（T-EG-05）：错误文案指引调用方显式传 overwrite: true
        return Err(FileCommandError::new(
            ERR_FILE_EXISTS,
            format!(
                "File already exists and overwrite is false: `{}` (pass overwrite=true to overwrite).",
                file_path.display()
            ),
        ));
    }
    if let Some(parent) = file_path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| {
                FileCommandError::new(ERR_WRITE_FILE, format!("Failed to create parent dirs: {e}"))
            })?;
        }
    }
    if content.len() > MAX_TEXT_FILE_BYTES {
        return Err(file_too_large_error(
            content.len() as u64,
            MAX_TEXT_FILE_BYTES,
        ));
    }
    std::fs::write(&file_path, content.as_bytes())
        .map_err(|e| FileCommandError::new(ERR_WRITE_FILE, format!("Failed to write file: {e}")))?;
    Ok(WriteFileContentResult {
        path: file_path.to_string_lossy().to_string(),
        bytes_written: content.len(),
    })
}
