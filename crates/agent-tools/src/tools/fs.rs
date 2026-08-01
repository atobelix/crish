//! 文件系统工具（任务书 B5.2：read_file / write_file / list_dir / file_stat）
//!
//! 全部路径入参经 `resolve_workspace_path` 校验（复用 conex-fs 的 safe_canonicalize），
//! 返回结构对齐 TS 版 read/list 工具语义：text 为对话正文，json 为结构化元数据。

use crate::definition::{Tool, ToolDefinition, ToolError};
use crate::tools::{
    clamp_text, decode_text, display_path, epoch_millis, optional_string, require_string,
    resolve_workspace_path, snapshot_tag,
};
use async_trait::async_trait;
use std::path::{Path, PathBuf};

/// 读文件默认字符上限（对齐 TS read 工具默认 maxBytes）
pub(crate) const DEFAULT_READ_MAX_BYTES: usize = 256_000;

/// 读文件工具：返回文本内容与元数据，超限截断并附标记
pub(crate) struct ReadFileTool {
    def: ToolDefinition,
    workspace_root: PathBuf,
    max_bytes: usize,
}

impl ReadFileTool {
    pub(crate) fn new(workspace_root: PathBuf, max_bytes: Option<usize>) -> Self {
        Self {
            def: ToolDefinition {
                name: "read_file".to_string(),
                description: "读取工作区文本文件：校验路径安全，超长内容截断并标记。".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "工作区文件路径（相对或绝对）" },
                        "maxBytes": { "type": "number", "description": "返回内容字符数上限，默认 256000" }
                    },
                    "required": ["path"],
                    "additionalProperties": false
                }),
                dangerous: false,
                fatal_on_error: false,
            },
            workspace_root,
            max_bytes: max_bytes.unwrap_or(DEFAULT_READ_MAX_BYTES),
        }
    }
}

#[async_trait]
impl Tool for ReadFileTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, args: serde_json::Value) -> Result<serde_json::Value, ToolError> {
        let path_str = require_string(&args, "path")?;
        let file_path = resolve_workspace_path(&self.workspace_root, &path_str)?;
        let display = display_path(&self.workspace_root, &file_path);

        let metadata = std::fs::metadata(&file_path)
            .map_err(|e| ToolError::execution_failed("read_file", format!("{display}: {e}")))?;
        if metadata.is_dir() {
            return Err(ToolError::execution_failed(
                "read_file",
                format!("Path is a directory, not a file: {display}"),
            ));
        }
        if !metadata.is_file() {
            return Err(ToolError::execution_failed(
                "read_file",
                format!("Path is not a file: {display}"),
            ));
        }

        let bytes = std::fs::read(&file_path)
            .map_err(|e| ToolError::execution_failed("read_file", format!("{display}: {e}")))?;
        let decoded = decode_text(&bytes);
        if decoded.is_binary {
            return Err(ToolError::execution_failed(
                "read_file",
                format!("File is binary and cannot be read as text: {display}"),
            ));
        }

        let total_chars = decoded.text.chars().count();
        let (shown, truncated) = clamp_text(&decoded.text, self.max_bytes);
        let line_count = decoded.text.lines().count();
        let tag = snapshot_tag(&file_path).unwrap_or_default();

        let text = if truncated {
            let header = format!(
                "path: {display}\nsnapshotTag: {tag}\nencoding: {}\nlines: {line_count}\n\
                 truncated: true (showing {} of {total_chars} chars; file has {} bytes)\n---\n",
                decoded.encoding,
                shown.chars().count(),
                bytes.len(),
            );
            format!("{header}{shown}\n... truncated ...")
        } else {
            let header = format!(
                "path: {display}\nsnapshotTag: {tag}\nencoding: {}\nlines: {line_count}\n---\n",
                decoded.encoding,
            );
            format!("{header}{shown}")
        };

        Ok(serde_json::json!({
            "path": display,
            "kind": "file",
            "bytes": bytes.len(),
            "encoding": decoded.encoding,
            "hasBom": decoded.has_bom,
            "lineCount": line_count,
            "totalChars": total_chars,
            "shownChars": shown.chars().count(),
            "snapshotTag": tag,
            "truncated": truncated,
            "text": text,
        }))
    }
}

/// 写文件工具：自动建父目录，BOM 续写既有编码；幂等守卫标记留 B5.3
pub(crate) struct WriteFileTool {
    def: ToolDefinition,
    workspace_root: PathBuf,
}

/// 写文件支持编码枚举（对齐 TS write_file 的 encoding 参数）
const WRITE_ENCODINGS: &[&str] = &["utf-8", "utf-8-bom", "utf-16le", "utf-16be"];

impl WriteFileTool {
    pub(crate) fn new(workspace_root: PathBuf) -> Self {
        Self {
            def: ToolDefinition {
                name: "write_file".to_string(),
                description: "写文件到工作区（覆盖写入，自动创建父目录，可指定编码）。".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "工作区文件路径（相对或绝对）" },
                        "content": { "type": "string", "description": "完整文件内容" },
                        "encoding": {
                            "type": "string",
                            "enum": ["utf-8", "utf-8-bom", "utf-16le", "utf-16be"],
                            "description": "写入编码，缺省时已存在文件按 BOM 续写原编码，新文件默认 utf-8"
                        }
                    },
                    "required": ["path", "content"],
                    "additionalProperties": false
                }),
                dangerous: true,
                fatal_on_error: false,
            },
            workspace_root,
        }
    }
}

#[async_trait]
impl Tool for WriteFileTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, args: serde_json::Value) -> Result<serde_json::Value, ToolError> {
        let path_str = require_string(&args, "path")?;
        let content = require_string(&args, "content")?;
        let file_path = resolve_workspace_path(&self.workspace_root, &path_str)?;
        let display = display_path(&self.workspace_root, &file_path);

        // 幂等守卫标记：B5.3 提供 ToolIdempotencyGuard（按 tool_call_id 去重已执行写盘），
        // 此处仅执行文件写入，不做去重。
        let requested = optional_string(&args, "encoding");
        let encoding = resolve_write_encoding(&file_path, requested.as_deref())?;
        let bytes = encode_text(&content, &encoding)?;

        conex_fs::path_utils::ensure_parent_dir(&file_path)
            .map_err(|e| ToolError::execution_failed("write_file", format!("{display}: {e}")))?;
        std::fs::write(&file_path, &bytes).map_err(|e| {
            ToolError::execution_failed("write_file", format!("{display}: {e}"))
        })?;

        let tag = snapshot_tag(&file_path).unwrap_or_default();
        let text = format!(
            "Wrote {display} ({} chars)\nEncoding: {encoding}\nSnapshot tag: {tag}",
            content.chars().count(),
        );
        Ok(serde_json::json!({
            "path": display,
            "encoding": encoding,
            "chars": content.chars().count(),
            "bytes": bytes.len(),
            "newSnapshotTag": tag,
            "text": text,
        }))
    }
}

/// 解析写入编码：显式指定优先；否则已存在文件按 BOM 续写，新文件默认 utf-8
fn resolve_write_encoding(
    file_path: &Path,
    requested: Option<&str>,
) -> Result<String, ToolError> {
    if let Some(enc) = requested {
        if WRITE_ENCODINGS.contains(&enc) {
            return Ok(enc.to_string());
        }
        return Err(ToolError::invalid_input(format!(
            "encoding must be one of {WRITE_ENCODINGS:?}, got {enc:?}"
        )));
    }
    if file_path.is_file() {
        if let Ok(mut f) = std::fs::File::open(file_path) {
            use std::io::Read;
            let mut head = [0u8; 4];
            let n = f.read(&mut head).unwrap_or(0);
            let head = &head[..n];
            if head.starts_with(&[0xFF, 0xFE]) {
                return Ok("utf-16le".to_string());
            }
            if head.starts_with(&[0xFE, 0xFF]) {
                return Ok("utf-16be".to_string());
            }
            if head.starts_with(&[0xEF, 0xBB, 0xBF]) {
                return Ok("utf-8-bom".to_string());
            }
        }
    }
    Ok("utf-8".to_string())
}

/// 按编码编码文本（utf-8 / utf-8-bom / utf-16le / utf-16be，带 BOM）
fn encode_text(content: &str, encoding: &str) -> Result<Vec<u8>, ToolError> {
    let utf8 = content.as_bytes();
    let mut out = Vec::with_capacity(utf8.len() * 2 + 2);
    match encoding {
        "utf-8" => out.extend_from_slice(utf8),
        "utf-8-bom" => {
            out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            out.extend_from_slice(utf8);
        }
        "utf-16le" => {
            out.extend_from_slice(&[0xFF, 0xFE]);
            for u in content.encode_utf16() {
                out.extend_from_slice(&u.to_le_bytes());
            }
        }
        "utf-16be" => {
            out.extend_from_slice(&[0xFE, 0xFF]);
            for u in content.encode_utf16() {
                out.extend_from_slice(&u.to_be_bytes());
            }
        }
        other => {
            return Err(ToolError::invalid_input(format!(
                "unsupported encoding: {other:?}"
            )));
        }
    }
    Ok(out)
}

/// 目录条目（对齐 TS list 工具的 items 结构 + size/mtime）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DirEntry {
    name: String,
    #[serde(rename = "type")]
    kind: &'static str,
    is_file: bool,
    is_directory: bool,
    size: u64,
    mtime: i64,
}

/// 列目录工具：返回条目清单（name/type/isFile/isDirectory/size/mtime）
pub(crate) struct ListDirTool {
    def: ToolDefinition,
    workspace_root: PathBuf,
}

impl ListDirTool {
    pub(crate) fn new(workspace_root: PathBuf) -> Self {
        Self {
            def: ToolDefinition {
                name: "list_dir".to_string(),
                description: "列出工作区目录下的文件与文件夹条目。".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "工作区目录路径，缺省为工作区根" }
                    },
                    "additionalProperties": false
                }),
                dangerous: false,
                fatal_on_error: false,
            },
            workspace_root,
        }
    }
}

#[async_trait]
impl Tool for ListDirTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, args: serde_json::Value) -> Result<serde_json::Value, ToolError> {
        let path_str = optional_string(&args, "path").unwrap_or_else(|| ".".to_string());
        let dir = resolve_workspace_path(&self.workspace_root, &path_str)?;
        let display = display_path(&self.workspace_root, &dir);

        let metadata = std::fs::metadata(&dir)
            .map_err(|e| ToolError::execution_failed("list_dir", format!("{display}: {e}")))?;
        if !metadata.is_dir() {
            return Err(ToolError::execution_failed(
                "list_dir",
                format!("Path is not a directory: {display}"),
            ));
        }

        let mut items: Vec<DirEntry> = Vec::new();
        let entries = std::fs::read_dir(&dir).map_err(|e| {
            ToolError::execution_failed("list_dir", format!("{display}: {e}"))
        })?;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let meta = entry.metadata();
            let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
            let is_file = meta.as_ref().map(|m| m.is_file()).unwrap_or(false);
            let kind = if is_dir {
                "directory"
            } else if is_file {
                "file"
            } else {
                "other"
            };
            items.push(DirEntry {
                name,
                kind,
                is_file,
                is_directory: is_dir,
                size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                mtime: epoch_millis(meta.as_ref().ok().and_then(|m| m.modified().ok())),
            });
        }
        // 对齐 TS：按 kind 名称 + 条目名排序（directory < file < other）
        items.sort_by(|a, b| format!("{}:{}", a.kind, a.name).cmp(&format!("{}:{}", b.kind, b.name)));

        let text = if items.is_empty() {
            "(empty directory)".to_string()
        } else {
            items
                .iter()
                .map(|e| {
                    let prefix = match e.kind {
                        "directory" => "/",
                        "file" => " ",
                        _ => "?",
                    };
                    format!("{prefix}{}", e.name)
                })
                .collect::<Vec<_>>()
                .join("\n")
        };
        Ok(serde_json::json!({
            "path": display,
            "kind": "directory",
            "items": items,
            "text": text,
        }))
    }
}

/// 文件信息工具：返回单个路径的 stat 元数据
pub(crate) struct FileStatTool {
    def: ToolDefinition,
    workspace_root: PathBuf,
}

impl FileStatTool {
    pub(crate) fn new(workspace_root: PathBuf) -> Self {
        Self {
            def: ToolDefinition {
                name: "file_stat".to_string(),
                description: "查询文件或目录的元数据（大小/修改时间/类型）。".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "工作区路径（文件或目录）" }
                    },
                    "required": ["path"],
                    "additionalProperties": false
                }),
                dangerous: false,
                fatal_on_error: false,
            },
            workspace_root,
        }
    }
}

#[async_trait]
impl Tool for FileStatTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, args: serde_json::Value) -> Result<serde_json::Value, ToolError> {
        let path_str = require_string(&args, "path")?;
        let target = resolve_workspace_path(&self.workspace_root, &path_str)?;
        let display = display_path(&self.workspace_root, &target);

        let metadata = std::fs::metadata(&target)
            .map_err(|e| ToolError::execution_failed("file_stat", format!("{display}: {e}")))?;
        let is_file = metadata.is_file();
        let is_dir = metadata.is_dir();
        let kind = if is_dir {
            "directory"
        } else if is_file {
            "file"
        } else {
            "other"
        };
        let size = metadata.len();
        let mtime = epoch_millis(metadata.modified().ok());
        let readonly = metadata.permissions().readonly();

        let text = format!(
            "{display}: {kind}\nsize: {size} bytes\nmtime: {mtime} ms\nreadonly: {readonly}"
        );
        Ok(serde_json::json!({
            "path": display,
            "type": kind,
            "isFile": is_file,
            "isDirectory": is_dir,
            "size": size,
            "mtime": mtime,
            "readonly": readonly,
            "text": text,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_test_utils::TempWorkspace;
    use serde_json::json;

    #[tokio::test]
    async fn read_file_roundtrip() {
        let ws = TempWorkspace::new("fs_read");
        ws.write_file("a.txt", "hello\nworld\n");
        let tool = ReadFileTool::new(ws.path().clone(), None);
        let out = tool.execute(json!({ "path": "a.txt" })).await.unwrap();
        assert_eq!(out["kind"], "file");
        assert_eq!(out["bytes"], 12);
        assert_eq!(out["truncated"], false);
        assert_eq!(out["encoding"], "utf-8");
        assert_eq!(out["lineCount"], 2);
        let tag = out["snapshotTag"].as_str().unwrap();
        assert_eq!(tag.len(), 12);
        assert!(out["text"].as_str().unwrap().contains("hello\nworld"));
        assert!(out["text"].as_str().unwrap().contains("path: a.txt"));
    }

    #[tokio::test]
    async fn read_file_truncates_oversize_content() {
        let ws = TempWorkspace::new("fs_trunc");
        ws.write_file("big.txt", "abcdefghijklmnopqrstuvwxyz");
        let tool = ReadFileTool::new(ws.path().clone(), Some(10));
        let out = tool.execute(json!({ "path": "big.txt" })).await.unwrap();
        assert_eq!(out["truncated"], true);
        assert_eq!(out["shownChars"], 10);
        assert_eq!(out["totalChars"], 26);
        let text = out["text"].as_str().unwrap();
        assert!(text.contains("truncated: true"));
        assert!(text.contains("... truncated ..."));
        assert!(text.contains("abcdefghij"));
    }

    #[tokio::test]
    async fn read_file_rejects_path_traversal() {
        let ws = TempWorkspace::new("fs_traversal");
        ws.write_file("a.txt", "hello");
        let tool = ReadFileTool::new(ws.path().clone(), None);
        let err = tool
            .execute(json!({ "path": "../outside.txt" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.path_escape");
    }

    #[tokio::test]
    async fn read_file_missing_and_directory_errors() {
        let ws = TempWorkspace::new("fs_err");
        ws.write_file("a.txt", "hello");
        let tool = ReadFileTool::new(ws.path().clone(), None);
        assert!(tool.execute(json!({ "path": "nope.txt" })).await.is_err());
        let err = tool.execute(json!({ "path": "." })).await.unwrap_err();
        assert!(err.to_string().contains("directory"));
    }

    #[tokio::test]
    async fn read_file_rejects_binary() {
        let ws = TempWorkspace::new("fs_binary");
        ws.write_file("bin.bin", "");
        let p = ws.path().join("bin.bin");
        std::fs::write(&p, [0u8, 1u8, 2u8]).unwrap();
        let tool = ReadFileTool::new(ws.path().clone(), None);
        let err = tool.execute(json!({ "path": "bin.bin" })).await.unwrap_err();
        assert!(err.to_string().contains("binary"));
    }

    #[tokio::test]
    async fn write_then_read_roundtrip() {
        let ws = TempWorkspace::new("fs_write");
        let tool = WriteFileTool::new(ws.path().clone());
        let out = tool
            .execute(json!({ "path": "sub/dir/b.txt", "content": "你好 rust" }))
            .await
            .unwrap();
        assert_eq!(out["path"], "sub/dir/b.txt");
        assert_eq!(out["encoding"], "utf-8");
        assert_eq!(out["chars"], 7); // 你好(2) + " rust"(5)
        assert_eq!(ws.read_file("sub/dir/b.txt"), "你好 rust");
        // 父目录被自动创建
        assert!(ws.path().join("sub/dir").is_dir());

        let read_tool = ReadFileTool::new(ws.path().clone(), None);
        let out = read_tool
            .execute(json!({ "path": "sub/dir/b.txt" }))
            .await
            .unwrap();
        assert_eq!(out["totalChars"], 7);
    }

    #[tokio::test]
    async fn write_file_supports_encodings() {
        let ws = TempWorkspace::new("fs_enc");
        let tool = WriteFileTool::new(ws.path().clone());
        tool.execute(json!({ "path": "u16.txt", "content": "hi", "encoding": "utf-16le" }))
            .await
            .unwrap();
        let bytes = std::fs::read(ws.path().join("u16.txt")).unwrap();
        assert!(bytes.starts_with(&[0xFF, 0xFE]));
        // 不传编码时按 BOM 续写原编码
        tool.execute(json!({ "path": "u16.txt", "content": "yo" }))
            .await
            .unwrap();
        let bytes = std::fs::read(ws.path().join("u16.txt")).unwrap();
        assert!(bytes.starts_with(&[0xFF, 0xFE]));
    }

    #[tokio::test]
    async fn write_file_rejects_escape_and_bad_encoding() {
        let ws = TempWorkspace::new("fs_werr");
        let tool = WriteFileTool::new(ws.path().clone());
        let err = tool
            .execute(json!({ "path": "../evil.txt", "content": "x" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.path_escape");
        let err = tool
            .execute(json!({ "path": "a.txt", "content": "x", "encoding": "latin1" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("encoding"));
    }

    #[tokio::test]
    async fn list_dir_entries_shape() {
        let ws = TempWorkspace::new("fs_list");
        ws.write_file("b.txt", "bb");
        ws.write_file("a.txt", "aa");
        ws.write_file("sub/c.txt", "cc");
        let tool = ListDirTool::new(ws.path().clone());
        let out = tool.execute(json!({})).await.unwrap();
        assert_eq!(out["kind"], "directory");
        let items = out["items"].as_array().unwrap();
        assert_eq!(items.len(), 3);
        // 目录排前，条目按名排序
        assert_eq!(items[0]["name"], "sub");
        assert_eq!(items[0]["type"], "directory");
        assert_eq!(items[0]["isDirectory"], true);
        assert_eq!(items[0]["isFile"], false);
        assert_eq!(items[1]["name"], "a.txt");
        assert_eq!(items[1]["type"], "file");
        assert_eq!(items[1]["isFile"], true);
        assert!(items[1]["size"].as_u64().unwrap() >= 2);
        assert!(items[1]["mtime"].as_i64().unwrap() > 0);
        assert_eq!(items[2]["name"], "b.txt");
    }

    #[tokio::test]
    async fn list_dir_non_directory_errors() {
        let ws = TempWorkspace::new("fs_listerr");
        ws.write_file("a.txt", "x");
        let tool = ListDirTool::new(ws.path().clone());
        let err = tool
            .execute(json!({ "path": "a.txt" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("not a directory"));
    }

    #[tokio::test]
    async fn file_stat_reports_metadata() {
        let ws = TempWorkspace::new("fs_stat");
        ws.write_file("a.txt", "hello");
        let tool = FileStatTool::new(ws.path().clone());
        let out = tool.execute(json!({ "path": "a.txt" })).await.unwrap();
        assert_eq!(out["isFile"], true);
        assert_eq!(out["type"], "file");
        assert_eq!(out["size"], 5);
        assert!(out["mtime"].as_i64().unwrap() > 0);

        let out = tool.execute(json!({ "path": "." })).await.unwrap();
        assert_eq!(out["isDirectory"], true);
    }

    #[tokio::test]
    async fn file_stat_missing_errors() {
        let ws = TempWorkspace::new("fs_staterr");
        let tool = FileStatTool::new(ws.path().clone());
        assert!(tool.execute(json!({ "path": "ghost.txt" })).await.is_err());
    }
}
