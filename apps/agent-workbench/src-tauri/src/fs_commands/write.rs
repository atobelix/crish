use crate::fs_commands::types::{
    file_too_large_error, FileCommandError, WriteFileContentResult, WorkspaceFsGuard,
    ERR_WRITE_FILE, MAX_TEXT_FILE_BYTES,
};

pub(crate) fn write_file_content(
    path: String,
    content: String,
    workspace_root: Option<String>,
) -> Result<WriteFileContentResult, FileCommandError> {
    let guard = WorkspaceFsGuard::from_optional_root(workspace_root.as_deref())?;
    write_file_content_with_guard(&guard, &path, &content)
}

pub(crate) fn write_file_content_with_guard(
    guard: &WorkspaceFsGuard,
    path: &str,
    content: &str,
) -> Result<WriteFileContentResult, FileCommandError> {
    let file_path = guard.resolve_for_write(path)?;
    if let Some(parent) = file_path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| {
                FileCommandError::new(ERR_WRITE_FILE, format!("Failed to create parent dirs: {e}"))
            })?;
        }
    }
    if content.len() > MAX_TEXT_FILE_BYTES {
        return Err(file_too_large_error(content.len() as u64, MAX_TEXT_FILE_BYTES));
    }
    std::fs::write(&file_path, content.as_bytes()).map_err(|e| {
        FileCommandError::new(ERR_WRITE_FILE, format!("Failed to write file: {e}"))
    })?;
    Ok(WriteFileContentResult {
        path: file_path.to_string_lossy().to_string(),
        bytes_written: content.len(),
    })
}
