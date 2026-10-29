// 工作区只读操作实现（server 层 WorkspaceOps 的 Tauri 装配实现）。
// 复用 fs_commands 的 WorkspaceFsGuard / windowed_read，不复制第二套路径校验。
use std::path::PathBuf;
use std::sync::Arc;

use conex_types::device::commands::WorkspaceEntry;
use conex_types::device::{DeviceErrorCode, DirectoryItem, ListDirResult, ReadFileResult};

use crate::fs_commands::directory::list_directory_with_guard;
use crate::fs_commands::read::read_file_content_with_guard;
use crate::fs_commands::types::{FileCommandError, ReadPolicy, WorkspaceFsGuard};
use crate::server::backend::WorkspaceOps;
use crate::server::ServerError;

pub(crate) struct AppWorkspaceOps {
    app: tauri::AppHandle,
}

impl AppWorkspaceOps {
    pub(crate) fn new(app: tauri::AppHandle) -> Arc<dyn WorkspaceOps> {
        Arc::new(Self { app })
    }

    fn registry(&self) -> Result<tauri::State<'_, crate::workspace::WorkspaceRegistry>, ServerError> {
        crate::workspace::registry(&self.app).map_err(map_fs_error)
    }

    fn guard_for(&self, workspace_root: Option<&str>) -> Result<WorkspaceFsGuard, ServerError> {
        let registry = self.registry()?;
        let root: PathBuf = match workspace_root {
            Some(raw) if !raw.trim().is_empty() => {
                let canonical = std::fs::canonicalize(raw).map_err(|error| {
                    ServerError::protocol(
                        DeviceErrorCode::FileNotGranted,
                        format!("工作区根不可达：{error}"),
                    )
                })?;
                if !registry
                    .roots()
                    .iter()
                    .any(|registered| registered == &canonical)
                {
                    return Err(ServerError::protocol(
                        DeviceErrorCode::FileNotGranted,
                        "工作区未授权",
                    ));
                }
                canonical
            }
            _ => registry.active_root().ok_or_else(|| {
                ServerError::protocol(DeviceErrorCode::FileNotGranted, "没有已授权的工作区")
            })?,
        };
        WorkspaceFsGuard::new(root).map_err(map_fs_error)
    }
}

impl WorkspaceOps for AppWorkspaceOps {
    fn list_workspaces(&self) -> Result<Vec<WorkspaceEntry>, ServerError> {
        let registry = self.registry()?;
        let active = registry.active_root();
        Ok(registry
            .roots()
            .into_iter()
            .map(|root| {
                let name = root
                    .file_name()
                    .map(|value| value.to_string_lossy().into_owned())
                    .filter(|value| !value.is_empty());
                WorkspaceEntry {
                    root: root.to_string_lossy().into_owned(),
                    name,
                    active: active.as_ref() == Some(&root),
                    reachable: Some(root.canonicalize().is_ok()),
                }
            })
            .collect())
    }

    fn switch_workspace(&self, path: &str) -> Result<String, ServerError> {
        crate::workspace::remote::remote_switch_workspace(&self.app, path)
            .map(|root| root.to_string_lossy().into_owned())
            .map_err(map_fs_error)
    }

    fn list_dir(
        &self,
        workspace_root: Option<&str>,
        path: Option<&str>,
    ) -> Result<ListDirResult, ServerError> {
        let guard = self.guard_for(workspace_root)?;
        let result = list_directory_with_guard(&guard, path.unwrap_or("")).map_err(map_fs_error)?;
        Ok(ListDirResult {
            entries: result
                .items
                .into_iter()
                .map(|item| DirectoryItem {
                    name: item.name,
                    is_dir: item.is_dir,
                    size: item.size,
                    modified: item.modified,
                })
                .collect(),
        })
    }

    fn read_file(
        &self,
        workspace_root: Option<&str>,
        path: &str,
        max_lines: Option<u32>,
        start_line: Option<u64>,
    ) -> Result<ReadFileResult, ServerError> {
        let guard = self.guard_for(workspace_root)?;
        // 先按窗口上限读取 5000 行，再按 startLine / maxLines 切片（wire 语义）。
        let policy = ReadPolicy::for_preview(Some(5000));
        let result = read_file_content_with_guard(&guard, path, policy).map_err(map_fs_error)?;
        let all_lines: Vec<&str> = result.content.split('\n').collect();
        let start = usize::try_from(start_line.unwrap_or(0)).unwrap_or(usize::MAX);
        let limit = usize::try_from(max_lines.unwrap_or(400).clamp(1, 5000)).unwrap_or(400);
        if start >= all_lines.len() && start != 0 {
            return Ok(ReadFileResult {
                content: String::new(),
                line_count: result.line_count as u64,
                truncated: false,
                sensitive: None,
            });
        }
        let slice: Vec<&str> = all_lines.iter().skip(start).take(limit).copied().collect();
        let truncated = result.truncated || start + slice.len() < all_lines.len();
        Ok(ReadFileResult {
            content: slice.join("\n"),
            line_count: result.line_count as u64,
            truncated,
            sensitive: None,
        })
    }
}

fn map_fs_error(error: FileCommandError) -> ServerError {
    let code = match error.code.as_str() {
        "path_not_found" => DeviceErrorCode::FileNotFound,
        "outside_workspace" | "workspace_not_granted" => DeviceErrorCode::FileNotGranted,
        "file_too_large" => DeviceErrorCode::FileTooLarge,
        "binary_file" => DeviceErrorCode::FileBinary,
        "unsupported_encoding" => DeviceErrorCode::FileEncoding,
        "file_exists" => DeviceErrorCode::FileExists,
        "not_directory" | "not_file" => DeviceErrorCode::CmdInvalid,
        _ => DeviceErrorCode::Internal,
    };
    ServerError::protocol(code, error.message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs_commands::types::{FileCommandError, ERR_BINARY_FILE, ERR_NOT_FOUND};

    #[test]
    fn fs_error_maps_to_device_codes() {
        let not_found = map_fs_error(FileCommandError::new(ERR_NOT_FOUND, "missing"));
        assert_eq!(not_found.device_code(), DeviceErrorCode::FileNotFound);

        let binary = map_fs_error(FileCommandError::new(ERR_BINARY_FILE, "binary"));
        assert_eq!(binary.device_code(), DeviceErrorCode::FileBinary);
    }

    #[test]
    fn unknown_fs_error_maps_to_internal() {
        let internal = map_fs_error(FileCommandError::new("something_else", "boom"));
        assert_eq!(internal.device_code(), DeviceErrorCode::Internal);
    }
}
