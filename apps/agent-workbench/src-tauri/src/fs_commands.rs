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
const ERR_WRITE_FILE: &str = "write_file_failed";
const ERR_FILE_TOO_LARGE: &str = "file_too_large";
const ERR_BINARY_FILE: &str = "binary_file";
const ERR_UNSUPPORTED_ENCODING: &str = "unsupported_encoding";

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileCommandError {
    pub(crate) code: String,
    pub(crate) message: String,
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
pub(crate) fn list_directory(
    path: String,
    workspace_root: Option<String>,
) -> Result<ListDirectoryResult, FileCommandError> {
    let guard = WorkspaceFsGuard::from_optional_root(workspace_root.as_deref())?;
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
            
            // 过滤高噪声和无实际业务意义的大体积依赖文件夹，保护前端渲染
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
    workspace_root: Option<String>,
) -> Result<ReadFileContentResult, FileCommandError> {
    let guard = WorkspaceFsGuard::from_optional_root(workspace_root.as_deref())?;
    read_file_content_with_guard(&guard, &path, ReadPolicy::for_preview(max_lines))
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WriteFileContentResult {
    path: String,
    bytes_written: usize,
}

/// 在工作区内写入文本文件（供右侧文件管理器编辑保存）。
#[tauri::command]
pub(crate) fn write_file_content(
    path: String,
    content: String,
    workspace_root: Option<String>,
) -> Result<WriteFileContentResult, FileCommandError> {
    let guard = WorkspaceFsGuard::from_optional_root(workspace_root.as_deref())?;
    write_file_content_with_guard(&guard, &path, &content)
}

fn write_file_content_with_guard(
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

    /// 优先使用前端传入的项目工作区根；未传则回退 monorepo 默认根。
    pub(crate) fn from_optional_root(workspace_root: Option<&str>) -> Result<Self, FileCommandError> {
        match workspace_root {
            Some(root) if !root.trim().is_empty() => Self::new(Path::new(root.trim())),
            _ => Self::for_default_workspace(),
        }
    }

    pub(crate) fn new(root: impl AsRef<Path>) -> Result<Self, FileCommandError> {
        let root = root.as_ref().canonicalize().map_err(|e| {
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

    /// 解析可写路径：文件可不存在，但必须落在工作区根下。
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
            let canonical = candidate.canonicalize().map_err(|e| {
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

        // 文件尚不存在：校验已存在的最近祖先在工作区内，并词法消除 `..`
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
        let ancestor_canon = ancestor.canonicalize().map_err(|e| {
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

/// 词法规范化路径（不访问磁盘），用于尚未创建的文件写路径。
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

#[derive(Debug, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RustSkill {
    file_path: String,
    base_dir: String,
    content: String,
    raw: String,
    scope: String,
    system: bool,
    name: String,
    description: String,
    tags: Vec<String>,
    applies_to: Vec<String>,
    disable_model_invocation: bool,
    file_activation: Option<String>,
}

fn parse_frontmatter(content: &str) -> (std::collections::HashMap<String, String>, String) {
    let mut data = std::collections::HashMap::new();
    let mut body = content.to_string();
    if content.starts_with("---") {
        if let Some(end_idx) = content[3..].find("\n---") {
            let actual_end = end_idx + 3;
            let raw_fm = &content[3..actual_end];
            body = content[actual_end + 4..].to_string();
            for line in raw_fm.lines() {
                if let Some((key, val)) = line.split_once(':') {
                    let k = key.trim().to_string();
                    let v = val.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
                    data.insert(k, v);
                }
            }
        }
    }
    (data, body)
}

fn first_markdown_sentence(content: &str) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() && !trimmed.starts_with('#') {
            let len = trimmed.chars().count().min(160);
            let sentence: String = trimmed.chars().take(len).collect();
            return Some(sentence);
        }
    }
    None
}

fn parse_string_list(v: &str) -> Vec<String> {
    v.split(&[',', '[', ']'][..])
        .map(|s| s.trim().trim_matches(|c| c == '"' || c == '\'').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn load_skill_file_rust(file_path: &Path, scope: &str, system: bool) -> Option<RustSkill> {
    let raw = std::fs::read_to_string(file_path).ok()?;
    let (fm, body) = parse_frontmatter(&raw);

    let base_dir = file_path.parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "".to_string());

    let file_path_str = file_path.to_string_lossy().to_string();

    let fallback_name = file_path.parent()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| "skill".to_string())
        .replace(|c: char| !c.is_alphanumeric() && c != '-', "-")
        .trim_matches('-')
        .to_string();

    let name = fm.get("name")
        .cloned()
        .unwrap_or(fallback_name);

    let description = fm.get("description")
        .cloned()
        .unwrap_or_else(|| {
            first_markdown_sentence(&body)
                .unwrap_or_else(|| name.clone())
        });

    let applies_to = fm.get("applies-to")
        .or_else(|| fm.get("appliesTo"))
        .map(|val| parse_string_list(val))
        .unwrap_or_default();

    let tags = fm.get("tags")
        .map(|val| parse_string_list(val))
        .unwrap_or_default();

    let disable_model_invocation = fm.get("disable-model-invocation")
        .or_else(|| fm.get("disableModelInvocation"))
        .map(|val| val == "true")
        .unwrap_or(false);

    let file_activation = fm.get("activation").cloned();

    let system_in_fm = fm.get("system").map(|val| val == "true").unwrap_or(false);
    let is_system = system || file_path_str.contains(".system") || system_in_fm;

    Some(RustSkill {
        file_path: file_path_str,
        base_dir,
        content: body.trim().to_string(),
        raw,
        scope: scope.to_string(),
        system: is_system,
        name,
        description,
        tags,
        applies_to,
        disable_model_invocation,
        file_activation,
    })
}

fn discover_in_dir_rust(
    dir: &Path,
    scope: &str,
    depth: usize,
    system: bool,
    skills: &mut Vec<RustSkill>,
) {
    if depth > 5 {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    let mut has_skill_md = false;
    let mut skill_md_path = None;

    let mut subdirs = Vec::new();
    let mut files_at_root = Vec::new();

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        let file_name = path.file_name().unwrap_or_default().to_string_lossy();
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };

        if metadata.is_dir() {
            let name_lower = file_name.to_lowercase();
            if name_lower == "node_modules" || name_lower == "__pycache__" {
                continue;
            }
            if name_lower.starts_with('.') && name_lower != ".system" {
                continue;
            }
            subdirs.push((path, name_lower == ".system"));
        } else {
            let name_upper = file_name.to_uppercase();
            if name_upper == "SKILL.MD" {
                has_skill_md = true;
                skill_md_path = Some(path);
            } else if depth == 0 && name_upper.ends_with(".MD") && name_upper != "README.MD" {
                files_at_root.push(path);
            }
        }
    }

    if has_skill_md {
        if let Some(path) = skill_md_path {
            if let Some(skill) = load_skill_file_rust(&path, scope, system) {
                skills.push(skill);
            }
        }
        return;
    }

    for (subdir, is_system_dir) in subdirs {
        discover_in_dir_rust(&subdir, scope, depth + 1, system || is_system_dir, skills);
    }

    for file_path in files_at_root {
        if let Some(skill) = load_skill_file_rust(&file_path, scope, system) {
            skills.push(skill);
        }
    }
}

fn get_home_dir() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .ok()
        .map(PathBuf::from)
        .or_else(|| std::env::var("HOME").ok().map(PathBuf::from))
}

#[tauri::command]
pub(crate) fn workbench_discover_skills(
    workspace_path: Option<String>,
    extra_dirs: Vec<String>,
) -> Result<Vec<RustSkill>, String> {
    let mut skills = Vec::new();

    // 1. Scan workspace if available
    if let Some(ref ws) = workspace_path {
        let ws_path = Path::new(ws);
        if ws_path.is_dir() {
            let roots = [
                ws_path.join(".conex").join("skills"),
                ws_path.join(".codex").join("skills"),
                ws_path.join(".agents").join("skills"),
                ws_path.join(".claude").join("skills"),
            ];
            for r in &roots {
                if r.is_dir() {
                    discover_in_dir_rust(r, "project", 0, false, &mut skills);
                }
            }
        }
    }

    // 2. Scan home directory if available
    if let Some(home) = get_home_dir() {
        let roots = [
            home.join(".codex").join("skills"),
            home.join(".conex").join("skills"),
            home.join(".claude").join("skills"),
            home.join(".agents").join("skills"),
            home.join(".grok").join("skills"),
            home.join(".grok").join("bundled").join("skills"),
        ];
        for r in &roots {
            if r.is_dir() {
                discover_in_dir_rust(r, "global", 0, false, &mut skills);
            }
        }
    }

    // 3. Scan extra directories
    for dir in extra_dirs {
        let path = Path::new(&dir);
        if path.is_dir() {
            let scope = if path.is_absolute() { "global" } else { "project" };
            discover_in_dir_rust(path, scope, 0, false, &mut skills);
        }
    }

    Ok(skills)
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
