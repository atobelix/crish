//! 壳文件读命令（U-READ：唯一窗口读实现 = `conex_fs::windowed_read`）
//!
//! 本模块只保留参数解析、workspace 路径 guard、错误码映射与响应组装；
//! **禁止**再写整文件 `std::fs::read` → `from_utf8` → `lines()` 中间路径。

use std::path::Path;

use crate::fs_commands::types::{
    file_too_large_error, FileCommandError, ReadFileContentResult, ReadPolicy, WorkspaceFsGuard,
    BINARY_SCAN_BYTES, ERR_BINARY_FILE, ERR_NOT_FILE, ERR_NOT_FOUND, ERR_READ_FILE,
    ERR_UNSUPPORTED_ENCODING,
};
use conex_fs::{windowed_read, WindowReadError, WindowReadOptions};

/// 读取文件内容（PE-07 T07.2：无 workspace_root 参数，根由 WorkspaceRegistry 解析）。
///
/// 行为策略：
/// 1. 若路径位于已授权工作区根内（或为工作区相对路径），经 WorkspaceFsGuard 安全校验；
/// 2. 用户在 UI 前端打开查看文件（如代码、文本、图片、Skill 等）不属于 Agent 工具调用；
///    若请求路径为已存在的物理绝对路径，放行安全只读预览，不卡工作区沙箱。
pub(crate) fn read_file_content(
    app: &tauri::AppHandle,
    path: String,
    max_lines: Option<usize>,
) -> Result<ReadFileContentResult, FileCommandError> {
    let policy = ReadPolicy::for_preview(max_lines);
    match crate::workspace::resolve_guard(app, &path) {
        Ok(guard) => read_file_content_with_guard(&guard, &path, policy),
        Err(err) => {
            let p = Path::new(&path);
            if p.is_absolute() {
                let canonical = match p.canonicalize() {
                    Ok(c) => c,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        return Err(FileCommandError::new(ERR_NOT_FOUND, "Path does not exist."));
                    }
                    Err(e) => {
                        return Err(FileCommandError::new(
                            ERR_READ_FILE,
                            format!("Failed to resolve path: {e}"),
                        ));
                    }
                };
                let metadata = std::fs::metadata(&canonical).map_err(|e| {
                    FileCommandError::new(ERR_READ_FILE, format!("Failed to inspect file: {e}"))
                })?;
                if metadata.is_dir() {
                    return Err(FileCommandError::new(
                        ERR_NOT_FILE,
                        "Path is a directory, not a file.",
                    ));
                }
                if metadata.len() > policy.max_bytes as u64 {
                    return Err(file_too_large_error(metadata.len(), policy.max_bytes));
                }
                return read_text_file_with_policy(&canonical, policy);
            }
            Err(err)
        }
    }
}

pub(crate) fn read_file_content_with_guard(
    guard: &WorkspaceFsGuard,
    path: &str,
    policy: ReadPolicy,
) -> Result<ReadFileContentResult, FileCommandError> {
    let file_path = guard.resolve_existing(path)?;
    let metadata = std::fs::metadata(&file_path).map_err(|e| {
        FileCommandError::new(ERR_READ_FILE, format!("Failed to inspect file: {e}"))
    })?;
    if metadata.is_dir() {
        return Err(FileCommandError::new(
            ERR_NOT_FILE,
            "Path is a directory, not a file.",
        ));
    }
    if metadata.len() > policy.max_bytes as u64 {
        return Err(file_too_large_error(metadata.len(), policy.max_bytes));
    }

    read_text_file_with_policy(&file_path, policy)
}

pub(crate) fn read_text_file_with_policy(
    path: &Path,
    policy: ReadPolicy,
) -> Result<ReadFileContentResult, FileCommandError> {
    let opts = WindowReadOptions {
        start_line: 1,
        end_line: None,
        content_offset: 0,
        max_lines: policy.max_lines,
        max_file_bytes: Some(policy.max_bytes as u64),
        binary_probe_bytes: policy.binary_scan_bytes.max(BINARY_SCAN_BYTES),
        reject_binary: true,
        strict_encoding: true,
        allow_utf16: false,
    };
    let result = windowed_read(path, &opts).map_err(map_window_error)?;

    // 壳语义：行限截断时剥尾换行；未截断且源以换行结尾时保留尾换行
    let mut content = result.text;
    if result.content_truncated {
        if content.ends_with('\n') {
            content.pop();
        }
        if content.ends_with('\r') {
            content.pop();
        }
    } else if result.file_ends_with_newline && !content.is_empty() {
        content.push('\n');
    } else if result.file_ends_with_newline && content.is_empty() {
        // 仅一个空行文件（"\n"）：lines 窗口为空串 + 尾换行语义
        // 对齐旧实现："\n" → content="\n"，line_count=1
        content.push('\n');
    }

    let line_count = content.lines().count();
    Ok(ReadFileContentResult {
        content,
        line_count,
        truncated: result.content_truncated,
    })
}

fn map_window_error(err: WindowReadError) -> FileCommandError {
    match err {
        WindowReadError::Io(e) => {
            FileCommandError::new(ERR_READ_FILE, format!("Failed to read file: {e}"))
        }
        WindowReadError::NotAFile => {
            FileCommandError::new(ERR_NOT_FILE, "Path is a directory, not a file.")
        }
        WindowReadError::FileTooLarge { size, limit } => file_too_large_error(size, limit as usize),
        WindowReadError::Binary => FileCommandError::new(
            ERR_BINARY_FILE,
            "File appears to be binary and cannot be previewed as text.",
        ),
        WindowReadError::UnsupportedEncoding => FileCommandError::new(
            ERR_UNSUPPORTED_ENCODING,
            "File is not valid UTF-8 text and cannot be previewed safely.",
        ),
    }
}
