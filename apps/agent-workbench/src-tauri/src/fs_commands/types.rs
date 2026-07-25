use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::host_paths;
use conex_fs::path_utils::safe_canonicalize;

pub(crate) const MAX_TEXT_FILE_BYTES: usize = 1024 * 1024;
pub(crate) const DEFAULT_MAX_TEXT_FILE_LINES: usize = 2_000;
pub(crate) const MAX_TEXT_FILE_LINES: usize = 5_000;
pub(crate) const BINARY_SCAN_BYTES: usize = 8192;
pub(crate) const READ_CHUNK_BYTES: usize = 8192;

pub(crate) const ERR_INTERNAL: &str = "internal_error";
pub(crate) const ERR_NOT_FOUND: &str = "path_not_found";
pub(crate) const ERR_NOT_DIRECTORY: &str = "not_directory";
pub(crate) const ERR_NOT_FILE: &str = "not_file";
pub(crate) const ERR_OUTSIDE_WORKSPACE: &str = "outside_workspace";
pub(crate) const ERR_READ_DIRECTORY: &str = "read_directory_failed";
pub(crate) const ERR_READ_FILE: &str = "read_file_failed";
pub(crate) const ERR_WRITE_FILE: &str = "write_file_failed";
pub(crate) const ERR_FILE_TOO_LARGE: &str = "file_too_large";
pub(crate) const ERR_BINARY_FILE: &str = "binary_file";
pub(crate) const ERR_UNSUPPORTED_ENCODING: &str = "unsupported_encoding";

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileCommandError {
    pub(crate) code: String,
    pub(crate) message: String,
}

impl FileCommandError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SelectFolderResult {
    pub(crate) path: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListDirectoryResult {
    pub(crate) items: Vec<DirectoryItem>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DirectoryItem {
    pub(crate) name: String,
    pub(crate) is_dir: bool,
    pub(crate) size: Option<u64>,
    pub(crate) modified: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadFileContentResult {
    pub(crate) content: String,
    pub(crate) line_count: usize,
    pub(crate) truncated: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WriteFileContentResult {
    pub(crate) path: String,
    pub(crate) bytes_written: usize,
}

#[derive(Debug, Clone)]
pub(crate) struct WorkspaceFsGuard {
    root: PathBuf,
}

impl WorkspaceFsGuard {
    pub(crate) fn for_default_workspace() -> Result<Self, FileCommandError> {
        let app_dir = host_paths::app_dir().map_err(|e| {
            FileCommandError::new(
                ERR_INTERNAL,
                format!("Failed to locate application directory: {e}"),
            )
        })?;
        Self::new(host_paths::workspace_root(&app_dir))
    }

    pub(crate) fn from_optional_root(workspace_root: Option<&str>) -> Result<Self, FileCommandError> {
        match workspace_root {
            Some(root) if !root.trim().is_empty() => Self::new(Path::new(root.trim())),
            _ => Self::for_default_workspace(),
        }
    }

    pub(crate) fn new(root: impl AsRef<Path>) -> Result<Self, FileCommandError> {
        let root = safe_canonicalize(root.as_ref(), 40).map_err(|e| {
            FileCommandError::new(
                ERR_INTERNAL,
                format!("Failed to resolve workspace root: {e}"),
            )
        })?;
        Ok(Self { root })
    }

    pub(crate) fn resolve_existing(&self, requested_path: &str) -> Result<PathBuf, FileCommandError> {
        let requested = Path::new(requested_path);
        let candidate = if requested.as_os_str().is_empty() {
            self.root.clone()
        } else if requested.is_absolute() {
            requested.to_path_buf()
        } else {
            self.root.join(requested)
        };

        let canonical = candidate.canonicalize().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                FileCommandError::new(ERR_NOT_FOUND, "Path does not exist.")
            } else {
                FileCommandError::new(ERR_READ_FILE, format!("Failed to resolve path: {e}"))
            }
        })?;

        if !path_is_same_or_child(&canonical, &self.root) {
            return Err(FileCommandError::new(
                ERR_OUTSIDE_WORKSPACE,
                "Path is outside the allowed workspace root.",
            ));
        }

        Ok(canonical)
    }

    pub(crate) fn resolve_for_write(&self, requested_path: &str) -> Result<PathBuf, FileCommandError> {
        let requested = Path::new(requested_path);
        if requested.as_os_str().is_empty() {
            return Err(FileCommandError::new(ERR_NOT_FILE, "Path is empty."));
        }
        let candidate = if requested.is_absolute() {
            requested.to_path_buf()
        } else {
            self.root.join(requested)
        };

        if candidate.exists() {
        let canonical = safe_canonicalize(&candidate, 40).map_err(|e| {
                FileCommandError::new(ERR_WRITE_FILE, format!("Failed to resolve path: {e}"))
            })?;
            if !path_is_same_or_child(&canonical, &self.root) {
                return Err(FileCommandError::new(
                    ERR_OUTSIDE_WORKSPACE,
                    "Path is outside the allowed workspace root.",
                ));
            }
            return Ok(canonical);
        }

        let lexical = lexically_normalize(&candidate);
        if !path_is_same_or_child(&lexical, &self.root) {
            return Err(FileCommandError::new(
                ERR_OUTSIDE_WORKSPACE,
                "Path is outside the allowed workspace root.",
            ));
        }

        let mut ancestor = lexical.clone();
        while !ancestor.exists() {
            if !ancestor.pop() {
                return Err(FileCommandError::new(
                    ERR_WRITE_FILE,
                    "Cannot resolve write path parent.",
                ));
            }
        }
        let ancestor_canon = safe_canonicalize(&ancestor, 40).map_err(|e| {
            FileCommandError::new(ERR_WRITE_FILE, format!("Failed to resolve parent: {e}"))
        })?;
        if !path_is_same_or_child(&ancestor_canon, &self.root) {
            return Err(FileCommandError::new(
                ERR_OUTSIDE_WORKSPACE,
                "Path is outside the allowed workspace root.",
            ));
        }

        Ok(lexical)
    }
}

fn lexically_normalize(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::ParentDir => {
                let _ = out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn path_is_same_or_child(path: &Path, root: &Path) -> bool {
    #[cfg(windows)]
    {
        let normalize = |value: &Path| {
            value
                .to_string_lossy()
                .replace('/', "\\")
                .trim_end_matches('\\')
                .to_ascii_lowercase()
        };
        let path = normalize(path);
        let root = normalize(root);
        path == root || path.starts_with(&format!("{root}\\"))
    }

    #[cfg(not(windows))]
    {
        path.starts_with(root)
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ReadPolicy {
    pub(crate) max_bytes: usize,
    pub(crate) max_lines: usize,
    pub(crate) binary_scan_bytes: usize,
}

impl ReadPolicy {
    pub(crate) fn for_preview(max_lines: Option<usize>) -> Self {
        Self {
            max_bytes: MAX_TEXT_FILE_BYTES,
            max_lines: max_lines
                .unwrap_or(DEFAULT_MAX_TEXT_FILE_LINES)
                .min(MAX_TEXT_FILE_LINES),
            binary_scan_bytes: BINARY_SCAN_BYTES,
        }
    }
}

pub(crate) fn file_too_large_error(size: u64, limit: usize) -> FileCommandError {
    FileCommandError::new(
        ERR_FILE_TOO_LARGE,
        format!("File is too large to preview safely ({size} bytes, limit {limit} bytes)."),
    )
}
