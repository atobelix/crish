use crate::fs_commands::types::{
    DeleteFileResult, FileCommandError, WorkspaceFsGuard, ERR_DELETE_FILE, ERR_NOT_FILE,
};

/// 删除单个文件（PE-07 T07.3 C-03：`workbench_fs_delete_file`）。
///
/// 替代 reverseFileDiff.ts 的 PowerShell `Remove-Item -LiteralPath "${...}" -Force`
/// 拼串（双引号内 `$(...)`/反引号仍会被求值，恶意文件名可注入命令）：
/// - 路径经 WorkspaceRegistry 沙箱（B1 信任锚）解析，越界 → `outside_workspace`；
/// - 删除走删除接管接口（S3/I2：conex-fs::trash::TrashService，S11 G2 收敛）：
///   目标移入回收站并登记（backup=true 写 checksum），可经 trash_restore
///   恢复——UI 删除与 AI 删除（delete_file 工具）落入同一回收站根
///   （01 方案「用户路径一致性」），不再裸 `std::fs::remove_file`；
/// - 仅删除文件（目录 → `not_file`）；回收站根不可解析 → `delete_file_failed`
///   （不静默退化物理删除）；
/// - 错误码复用 `path_not_found` / `outside_workspace` / `delete_file_failed`。
pub(crate) fn delete_file(
    app: &tauri::AppHandle,
    path: String,
) -> Result<DeleteFileResult, FileCommandError> {
    let guard = crate::workspace::resolve_guard(app, &path)?;
    let trash_root = crate::core_run_commands::trash_root_for(app).map_err(|e| {
        FileCommandError::new(
            ERR_DELETE_FILE,
            format!("Failed to resolve trash root: {e}"),
        )
    })?;
    delete_file_with_guard(&guard, &trash_root, &path)
}

/// 纯函数核心（测试直测，对齐 read/list 的 `*_with_guard` 模式）：
/// 在已授权根守卫 + 回收站根下执行删除接管。
pub(crate) fn delete_file_with_guard(
    guard: &WorkspaceFsGuard,
    trash_root: &std::path::Path,
    path: &str,
) -> Result<DeleteFileResult, FileCommandError> {
    let file_path = guard.resolve_existing(path)?;

    if file_path.is_dir() {
        return Err(FileCommandError::new(
            ERR_NOT_FILE,
            "Path is a directory; only files can be deleted.",
        ));
    }

    conex_fs::trash::TrashService::new(trash_root)
        .trash_file(&file_path, true)
        .map_err(|e| {
            FileCommandError::new(ERR_DELETE_FILE, format!("Failed to delete file: {e}"))
        })?;

    Ok(DeleteFileResult {
        path: file_path.to_string_lossy().to_string(),
        deleted: true,
    })
}
