use crate::fs_commands::types::{
    DeleteFileResult, FileCommandError, ERR_DELETE_FILE, ERR_NOT_FILE, ERR_NOT_FOUND,
};

/// 删除单个文件（PE-07 T07.3 C-03：`workbench_fs_delete_file`）。
///
/// 替代 reverseFileDiff.ts 的 PowerShell `Remove-Item -LiteralPath "${...}" -Force`
/// 拼串（双引号内 `$(...)`/反引号仍会被求值，恶意文件名可注入命令）：
/// - 路径经 WorkspaceRegistry 沙箱（B1 信任锚）解析，越界 → `outside_workspace`；
/// - 仅删除文件（`std::fs::remove_file`，不经任何外壳，B2 进程执行基线）；
/// - 错误码复用 `path_not_found` / `outside_workspace`。
pub(crate) fn delete_file(
    app: &tauri::AppHandle,
    path: String,
) -> Result<DeleteFileResult, FileCommandError> {
    let guard = crate::workspace::resolve_guard(app, &path)?;
    let file_path = guard.resolve_existing(&path)?;

    if file_path.is_dir() {
        return Err(FileCommandError::new(
            ERR_NOT_FILE,
            "Path is a directory; only files can be deleted.",
        ));
    }

    std::fs::remove_file(&file_path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            FileCommandError::new(ERR_NOT_FOUND, "Path does not exist.")
        } else {
            FileCommandError::new(
                ERR_DELETE_FILE,
                format!("Failed to delete file: {e}"),
            )
        }
    })?;

    Ok(DeleteFileResult {
        path: file_path.to_string_lossy().to_string(),
        deleted: true,
    })
}
