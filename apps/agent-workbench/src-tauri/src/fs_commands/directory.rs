use std::time::UNIX_EPOCH;

use crate::fs_commands::types::{
    DirectoryItem, FileCommandError, ListDirectoryResult, WorkspaceFsGuard, ERR_NOT_DIRECTORY,
    ERR_READ_DIRECTORY,
};

pub(crate) fn list_directory(
    path: String,
    workspace_root: Option<String>,
) -> Result<ListDirectoryResult, FileCommandError> {
    let guard = WorkspaceFsGuard::from_optional_root(workspace_root.as_deref())?;
    list_directory_with_guard(&guard, &path)
}

pub(crate) fn list_directory_with_guard(
    guard: &WorkspaceFsGuard,
    path: &str,
) -> Result<ListDirectoryResult, FileCommandError> {
    let dir_path = guard.resolve_existing(path)?;
    if !dir_path.is_dir() {
        return Err(FileCommandError::new(
            ERR_NOT_DIRECTORY,
            "Path is not a directory.",
        ));
    }

    let entries = std::fs::read_dir(&dir_path).map_err(|e| {
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

    Ok(ListDirectoryResult { items })
}
