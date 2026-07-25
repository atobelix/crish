use std::{
    fs::File,
    io::Read,
    path::Path,
};

use crate::fs_commands::types::{
    file_too_large_error, FileCommandError, ReadFileContentResult, ReadPolicy, WorkspaceFsGuard,
    ERR_BINARY_FILE, ERR_NOT_FILE, ERR_READ_FILE, ERR_UNSUPPORTED_ENCODING, BINARY_SCAN_BYTES,
    READ_CHUNK_BYTES,
};

pub(crate) fn read_file_content(
    path: String,
    max_lines: Option<usize>,
    workspace_root: Option<String>,
) -> Result<ReadFileContentResult, FileCommandError> {
    let guard = WorkspaceFsGuard::from_optional_root(workspace_root.as_deref())?;
    read_file_content_with_guard(&guard, &path, ReadPolicy::for_preview(max_lines))
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
    let mut file = File::open(path)
        .map_err(|e| FileCommandError::new(ERR_READ_FILE, format!("Failed to open file: {e}")))?;
    let mut output = Vec::new();
    let mut scan_prefix = Vec::new();
    let mut buffer = vec![0_u8; READ_CHUNK_BYTES.min(policy.max_bytes + 1)];
    let mut bytes_read = 0_usize;
    let mut line_breaks_kept = 0_usize;
    let mut reached_line_limit = policy.max_lines == 0;
    let mut truncated = false;

    loop {
        if reached_line_limit && truncated && scan_prefix.len() >= policy.binary_scan_bytes {
            break;
        }

        let remaining = policy
            .max_bytes
            .saturating_add(1)
            .saturating_sub(bytes_read);
        if remaining == 0 {
            return Err(file_too_large_error(bytes_read as u64, policy.max_bytes));
        }

        let read_len = buffer.len().min(remaining);
        let read = file.read(&mut buffer[..read_len]).map_err(|e| {
            FileCommandError::new(ERR_READ_FILE, format!("Failed to read file: {e}"))
        })?;
        if read == 0 {
            break;
        }

        bytes_read += read;
        if bytes_read > policy.max_bytes {
            return Err(file_too_large_error(bytes_read as u64, policy.max_bytes));
        }

        let chunk = &buffer[..read];
        if scan_prefix.len() < policy.binary_scan_bytes {
            let remaining_scan_bytes = policy.binary_scan_bytes - scan_prefix.len();
            scan_prefix.extend_from_slice(&chunk[..chunk.len().min(remaining_scan_bytes)]);
        }

        if !reached_line_limit {
            if let Some(end) =
                bytes_to_keep_for_line_limit(chunk, policy.max_lines, &mut line_breaks_kept)
            {
                output.extend_from_slice(&chunk[..=end]);
                reached_line_limit = true;
                truncated = end + 1 < chunk.len();
                if truncated {
                    trim_trailing_line_ending(&mut output);
                }
            } else {
                output.extend_from_slice(chunk);
            }
        } else {
            truncated = true;
            trim_trailing_line_ending(&mut output);
        }
    }

    if is_probably_binary(&scan_prefix) {
        return Err(FileCommandError::new(
            ERR_BINARY_FILE,
            "File appears to be binary and cannot be previewed as text.",
        ));
    }
    if utf8_prefix_has_invalid_sequence(&scan_prefix) {
        return Err(FileCommandError::new(
            ERR_UNSUPPORTED_ENCODING,
            "File is not valid UTF-8 text and cannot be previewed safely.",
        ));
    }

    let content = String::from_utf8(output).map_err(|_| {
        FileCommandError::new(
            ERR_UNSUPPORTED_ENCODING,
            "File is not valid UTF-8 text and cannot be previewed safely.",
        )
    })?;
    let line_count = content.lines().count();

    Ok(ReadFileContentResult {
        content,
        line_count,
        truncated,
    })
}

fn bytes_to_keep_for_line_limit(
    chunk: &[u8],
    max_lines: usize,
    line_breaks_seen: &mut usize,
) -> Option<usize> {
    if max_lines == 0 {
        return Some(0);
    }

    for (index, byte) in chunk.iter().enumerate() {
        if *byte == b'\n' {
            *line_breaks_seen += 1;
            if *line_breaks_seen == max_lines {
                return Some(index);
            }
        }
    }
    None
}

fn trim_trailing_line_ending(bytes: &mut Vec<u8>) {
    if bytes.last() == Some(&b'\n') {
        bytes.pop();
    }
    if bytes.last() == Some(&b'\r') {
        bytes.pop();
    }
}

fn utf8_prefix_has_invalid_sequence(bytes: &[u8]) -> bool {
    match std::str::from_utf8(bytes) {
        Ok(_) => false,
        Err(err) => err.error_len().is_some(),
    }
}

fn is_probably_binary(bytes: &[u8]) -> bool {
    const BINARY_MAGICS: &[&[u8]] = &[
        b"\x89PNG\r\n\x1A\n",
        b"\xFF\xD8\xFF",
        b"GIF87a",
        b"GIF89a",
        b"%PDF-",
        b"PK\x03\x04",
    ];

    if BINARY_MAGICS
        .iter()
        .any(|magic| bytes.len() >= magic.len() && bytes.starts_with(magic))
    {
        return true;
    }
    if bytes.iter().any(|byte| *byte == 0) {
        return true;
    }

    let sample_len = bytes.len().min(BINARY_SCAN_BYTES);
    if sample_len == 0 {
        return false;
    }
    let suspicious_control_bytes = bytes[..sample_len]
        .iter()
        .filter(|byte| matches!(byte, 1..=8 | 14..=31))
        .count();

    suspicious_control_bytes * 100 / sample_len > 5
}
