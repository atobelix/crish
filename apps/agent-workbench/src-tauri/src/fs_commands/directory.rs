use std::time::UNIX_EPOCH;

// U-BLOCK / D0：条目上限唯一定义面 = conex-shared::perf_budget
use conex_shared::perf_budget::FS_LIST_DIRECTORY_DEFAULT_LIMIT;

use crate::fs_commands::types::{
    DirectoryItem, FileCommandError, ListDirectoryResult, WorkspaceFsGuard, ERR_NOT_DIRECTORY,
    ERR_READ_DIRECTORY,
};

/// 列出目录（PE-07 T07.2：无 workspace_root 参数，根由 WorkspaceRegistry 解析）。
pub(crate) fn list_directory(
    app: &tauri::AppHandle,
    path: String,
) -> Result<ListDirectoryResult, FileCommandError> {
    let guard = match crate::workspace::resolve_guard(app, &path) {
        Ok(g) => g,
        Err(err) => {
            // 桌面端只读目录兜底：若目录不在当前工作区内，但为绝对路径且为目录，放行只读查看，
            // 满足外部会话探测与通用文件系统只读浏览需求。
            let path_obj = std::path::Path::new(&path);
            if path_obj.is_absolute() && path_obj.is_dir() {
                return list_directory_entries(path_obj);
            }
            return Err(err);
        }
    };
    list_directory_with_guard(&guard, &path)
}

pub(crate) fn list_directory_with_guard(
    guard: &WorkspaceFsGuard,
    path: &str,
) -> Result<ListDirectoryResult, FileCommandError> {
    let dir_path = guard.resolve_existing(path)?;
    list_directory_entries(&dir_path)
}

fn list_directory_entries(dir_path: &std::path::Path) -> Result<ListDirectoryResult, FileCommandError> {
    if !dir_path.is_dir() {
        return Err(FileCommandError::new(
            ERR_NOT_DIRECTORY,
            "Path is not a directory.",
        ));
    }

    let entries = std::fs::read_dir(dir_path).map_err(|e| {
        FileCommandError::new(ERR_READ_DIRECTORY, format!("Failed to read directory: {e}"))
    })?;

    let mut items: Vec<DirectoryItem> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let file_name = entry.file_name();
            let name = file_name.to_string_lossy().to_string();
            let metadata = std::fs::symlink_metadata(entry.path()).ok()?;
            let is_dir = metadata.is_dir();

            if is_dir {
                let lower_name = name.to_lowercase();
                if lower_name == "node_modules"
                    || lower_name == ".git"
                    || lower_name == "target"
                    || lower_name == "dist"
                    || lower_name == "build"
                {
                    return None;
                }
            }

            let size = if is_dir { None } else { Some(metadata.len()) };
            let modified = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis().to_string());
            Some(DirectoryItem {
                name,
                is_dir,
                size,
                modified,
            })
        })
        .collect();

    items.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    // U-BLOCK：硬上限 + 向后兼容扩字段（truncated/cursor/total）——
    // 前端只读 items 时行为不变；超限时响应体积有界
    let total = items.len();
    if total > FS_LIST_DIRECTORY_DEFAULT_LIMIT {
        items.truncate(FS_LIST_DIRECTORY_DEFAULT_LIMIT);
        Ok(ListDirectoryResult {
            items,
            truncated: true,
            cursor: Some(FS_LIST_DIRECTORY_DEFAULT_LIMIT),
            total,
        })
    } else {
        Ok(ListDirectoryResult {
            items,
            truncated: false,
            cursor: None,
            total,
        })
    }
}
