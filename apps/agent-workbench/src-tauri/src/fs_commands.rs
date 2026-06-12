use serde::Serialize;
use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use tauri_plugin_dialog::DialogExt;

use crate::host_paths;

const MAX_TEXT_FILE_BYTES: usize = 1024 * 1024;
const DEFAULT_MAX_TEXT_FILE_LINES: usize = 2_000;
const MAX_TEXT_FILE_LINES: usize = 5_000;
const BINARY_SCAN_BYTES: usize = 8192;
const READ_CHUNK_BYTES: usize = 8192;

const ERR_INTERNAL: &str = "internal_error";
const ERR_NOT_FOUND: &str = "path_not_found";
const ERR_NOT_DIRECTORY: &str = "not_directory";
const ERR_NOT_FILE: &str = "not_file";
const ERR_OUTSIDE_WORKSPACE: &str = "outside_workspace";
const ERR_READ_DIRECTORY: &str = "read_directory_failed";
const ERR_READ_FILE: &str = "read_file_failed";
const ERR_FILE_TOO_LARGE: &str = "file_too_large";
const ERR_BINARY_FILE: &str = "binary_file";
const ERR_UNSUPPORTED_ENCODING: &str = "unsupported_encoding";

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileCommandError {
    code: String,
    message: String,
}

impl FileCommandError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SelectFolderResult {
    path: Option<String>,
}

#[tauri::command]
pub(crate) async fn select_folder(app: tauri::AppHandle) -> Result<SelectFolderResult, String> {
    let selected = app.dialog().file().blocking_pick_folder();

    Ok(SelectFolderResult {
        path: selected.map(|p| p.to_string()),
    })
}

// ==================== Filesystem Commands ====================

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct DirectoryItem {
    name: String,
    is_dir: bool,
    size: Option<u64>,
    modified: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListDirectoryResult {
    items: Vec<DirectoryItem>,
}

#[tauri::command]
pub(crate) fn list_directory(path: String) -> Result<ListDirectoryResult, FileCommandError> {
    let guard = WorkspaceFsGuard::for_default_workspace()?;
    list_directory_with_guard(&guard, &path)
}

fn list_directory_with_guard(
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

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadFileContentResult {
    content: String,
    line_count: usize,
    truncated: bool,
}

#[tauri::command]
pub(crate) fn read_file_content(
    path: String,
    max_lines: Option<usize>,
) -> Result<ReadFileContentResult, FileCommandError> {
    let guard = WorkspaceFsGuard::for_default_workspace()?;
    read_file_content_with_guard(&guard, &path, ReadPolicy::for_preview(max_lines))
}

fn read_file_content_with_guard(
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

#[derive(Debug, Clone)]
struct WorkspaceFsGuard {
    root: PathBuf,
}

impl WorkspaceFsGuard {
    fn for_default_workspace() -> Result<Self, FileCommandError> {
        let app_dir = host_paths::app_dir().map_err(|e| {
            FileCommandError::new(
                ERR_INTERNAL,
                format!("Failed to locate application directory: {e}"),
            )
        })?;
        Self::new(host_paths::workspace_root(&app_dir))
    }

    fn new(root: impl AsRef<Path>) -> Result<Self, FileCommandError> {
        let root = root.as_ref().canonicalize().map_err(|e| {
            FileCommandError::new(
                ERR_INTERNAL,
                format!("Failed to resolve workspace root: {e}"),
            )
        })?;
        Ok(Self { root })
    }

    fn resolve_existing(&self, requested_path: &str) -> Result<PathBuf, FileCommandError> {
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
struct ReadPolicy {
    max_bytes: usize,
    max_lines: usize,
    binary_scan_bytes: usize,
}

impl ReadPolicy {
    fn for_preview(max_lines: Option<usize>) -> Self {
        Self {
            max_bytes: MAX_TEXT_FILE_BYTES,
            max_lines: max_lines
                .unwrap_or(DEFAULT_MAX_TEXT_FILE_LINES)
                .min(MAX_TEXT_FILE_LINES),
            binary_scan_bytes: BINARY_SCAN_BYTES,
        }
    }
}

fn read_text_file_with_policy(
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

fn file_too_large_error(size: u64, limit: usize) -> FileCommandError {
    FileCommandError::new(
        ERR_FILE_TOO_LARGE,
        format!("File is too large to preview safely ({size} bytes, limit {limit} bytes)."),
    )
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        env, fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new() -> Self {
            let base = env::temp_dir();
            for attempt in 0..100 {
                let nanos = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("system time before UNIX_EPOCH")
                    .as_nanos();
                let path = base.join(format!(
                    "conex-fs-commands-{}-{nanos}-{attempt}",
                    std::process::id()
                ));
                if fs::create_dir(&path).is_ok() {
                    return Self { path };
                }
            }
            panic!("failed to create temporary test directory");
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn assert_error_code<T>(result: Result<T, FileCommandError>, expected: &str) {
        match result {
            Ok(_) => panic!("expected error code {expected}, got success"),
            Err(err) => assert_eq!(err.code, expected),
        }
    }

    fn guard_for(root: &Path) -> WorkspaceFsGuard {
        WorkspaceFsGuard::new(root).expect("create guard")
    }

    fn read_file_content_at_root(
        root: &Path,
        path: &str,
        max_lines: Option<usize>,
    ) -> Result<ReadFileContentResult, FileCommandError> {
        read_file_content_with_guard(&guard_for(root), path, ReadPolicy::for_preview(max_lines))
    }

    fn list_directory_at_root(
        root: &Path,
        path: &str,
    ) -> Result<ListDirectoryResult, FileCommandError> {
        list_directory_with_guard(&guard_for(root), path)
    }

    #[test]
    fn read_file_content_allows_file_under_root() {
        let temp = TestDir::new();
        let root = temp.path().join("workspace");
        fs::create_dir(&root).expect("create root");
        let file = root.join("src").join("main.rs");
        fs::create_dir_all(file.parent().expect("file parent")).expect("create parent");
        fs::write(&file, "fn main() {}\nprintln!(\"ok\");\n").expect("write file");

        let result = read_file_content_at_root(&root, "src/main.rs", Some(1)).expect("read file");

        assert_eq!(result.content, "fn main() {}");
        assert_eq!(result.line_count, 1);
        assert!(result.truncated);
    }

    #[test]
    fn list_directory_rejects_path_traversal_outside_root() {
        let temp = TestDir::new();
        let root = temp.path().join("workspace");
        let outside = temp.path().join("outside");
        fs::create_dir_all(root.join("nested")).expect("create nested");
        fs::create_dir(&outside).expect("create outside");

        let traversal = root
            .join("nested")
            .join("..")
            .join("..")
            .join("outside")
            .to_string_lossy()
            .to_string();

        assert_error_code(
            list_directory_at_root(&root, &traversal),
            ERR_OUTSIDE_WORKSPACE,
        );
    }

    #[test]
    fn read_file_content_rejects_absolute_path_outside_root() {
        let temp = TestDir::new();
        let root = temp.path().join("workspace");
        let outside = temp.path().join("outside.txt");
        fs::create_dir(&root).expect("create root");
        fs::write(&outside, "secret").expect("write outside");

        assert_error_code(
            read_file_content_at_root(&root, &outside.to_string_lossy(), None),
            ERR_OUTSIDE_WORKSPACE,
        );
    }

    #[test]
    fn read_file_content_rejects_large_files_before_decoding() {
        let temp = TestDir::new();
        let root = temp.path().join("workspace");
        let large = root.join("large.txt");
        fs::create_dir(&root).expect("create root");
        fs::write(&large, vec![b'a'; MAX_TEXT_FILE_BYTES + 1]).expect("write large file");

        assert_error_code(
            read_file_content_at_root(&root, "large.txt", None),
            ERR_FILE_TOO_LARGE,
        );
    }

    #[test]
    fn read_file_content_rejects_binary_files() {
        let temp = TestDir::new();
        let root = temp.path().join("workspace");
        let binary = root.join("image.bin");
        fs::create_dir(&root).expect("create root");
        fs::write(&binary, [0x66, 0x00, 0x67, 0x68]).expect("write binary file");

        assert_error_code(
            read_file_content_at_root(&root, "image.bin", None),
            ERR_BINARY_FILE,
        );
    }

    #[test]
    fn read_file_content_rejects_non_utf8_text() {
        let temp = TestDir::new();
        let root = temp.path().join("workspace");
        let file = root.join("latin1.txt");
        fs::create_dir(&root).expect("create root");
        fs::write(&file, [0x66, 0xE9, 0x67]).expect("write non-utf8 file");

        assert_error_code(
            read_file_content_at_root(&root, "latin1.txt", None),
            ERR_UNSUPPORTED_ENCODING,
        );
    }

    #[test]
    fn read_file_content_stops_output_at_line_limit() {
        let temp = TestDir::new();
        let root = temp.path().join("workspace");
        let file = root.join("many.txt");
        fs::create_dir(&root).expect("create root");
        fs::write(&file, "one\ntwo\nthree\n").expect("write text file");

        let result = read_file_content_at_root(&root, "many.txt", Some(2)).expect("read file");

        assert_eq!(result.content, "one\ntwo");
        assert_eq!(result.line_count, 2);
        assert!(result.truncated);
    }

    #[test]
    fn read_file_content_preserves_content_when_line_limit_matches_file() {
        let temp = TestDir::new();
        let root = temp.path().join("workspace");
        let file = root.join("two.txt");
        fs::create_dir(&root).expect("create root");
        fs::write(&file, "one\ntwo\n").expect("write text file");

        let result = read_file_content_at_root(&root, "two.txt", Some(2)).expect("read file");

        assert_eq!(result.content, "one\ntwo\n");
        assert_eq!(result.line_count, 2);
        assert!(!result.truncated);
    }

    #[test]
    fn read_file_content_rejects_symlink_escaping_root() {
        let temp = TestDir::new();
        let root = temp.path().join("workspace");
        let outside = temp.path().join("outside.txt");
        let link = root.join("link.txt");
        fs::create_dir(&root).expect("create root");
        fs::write(&outside, "secret").expect("write outside");

        if create_file_symlink(&outside, &link).is_err() {
            return;
        }

        assert_error_code(
            read_file_content_at_root(&root, "link.txt", None),
            ERR_OUTSIDE_WORKSPACE,
        );
    }

    #[cfg(unix)]
    fn create_file_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn create_file_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_file(target, link)
    }
}
