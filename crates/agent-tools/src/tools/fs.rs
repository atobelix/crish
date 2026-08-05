//! 文件系统工具（任务书 B5.2：read_file / write_file / list_dir / file_stat）
//!
//! 全部路径入参经 `resolve_workspace_path` 校验（复用 conex-fs 的 safe_canonicalize），
//! 工作区根目录从会话上下文 `ToolContext.workspace_root` 读取（R3 T9）；
//! 返回结构对齐 TS 版 read/list 工具语义：text 为对话正文，json 为结构化元数据。

use crate::context::ToolContext;
use crate::definition::{Tool, ToolDefinition, ToolError};
use crate::tools::{
    clamp_text_by_lines, decode_text, display_path, epoch_millis, optional_string, require_string,
    resolve_workspace_path, snapshot_tag,
};
use crate::write_paths::{check_write_allowance_for_ctx, claim_write_guard, ClaimMode};
use async_trait::async_trait;
use std::path::Path;

/// 读文件默认字符上限（对齐 TS read 工具默认 maxBytes）
pub(crate) const DEFAULT_READ_MAX_BYTES: usize = 256_000;

/// 读文件默认单次最大行数（对齐 REQ 示例 800）
pub(crate) const DEFAULT_READ_MAX_LINES: usize = 800;

/// 读文件工具：返回文本内容与元数据，超限截断并附标记
pub(crate) struct ReadFileTool {
    def: ToolDefinition,
    max_bytes: usize,
}

impl ReadFileTool {
    pub(crate) fn new(max_bytes: Option<usize>) -> Self {
        Self {
            def: ToolDefinition {
                name: "read_file".to_string(),
                description: "读取工作区文本文件：支持行号范围（startLine/endLine）与行粒度续读（contentOffset），字符预算截断保证在完整行边界；二进制文件返回文件引用（binary: true，不报错）。".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "工作区文件路径（相对或绝对）" },
                        "startLine": { "type": "number", "description": "可选，1-indexed 起始行（缺省 1）" },
                        "endLine": { "type": "number", "description": "可选，1-indexed 结束行（闭区间；缺省 = 窗口起点 + maxLines - 1）" },
                        "contentOffset": { "type": "number", "description": "可选，行粒度续读偏移 = 已返回的完整行数（缺省 0，续读不切行中间）" },
                        "maxLines": { "type": "number", "description": "可选，单次最大行数（缺省 800）" },
                        "maxBytes": { "type": "number", "description": "可选，返回内容字符数上限，缺省 256000；超限时截断点回退到最近完整行边界" }
                    },
                    "required": ["path"],
                    "additionalProperties": false
                }),
                dangerous: false,
                fatal_on_error: false,
            },
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

    async fn execute(
        &self,
        ctx: &ToolContext,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, ToolError> {
        let path_str = require_string(&args, "path")?;
        let file_path = resolve_workspace_path(&ctx.workspace_root, &path_str)?;
        let display = display_path(&ctx.workspace_root, &file_path);

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

        // T-CF-01：入参解析——行窗口（1-indexed 闭区间）/ 续读偏移 / 行数与字符双上限；
        // startLine>endLine 为结构化入参错误
        let start_line = parse_line_arg(&args, "startLine", false)?.unwrap_or(1);
        let end_line_arg = parse_line_arg(&args, "endLine", false)?;
        let content_offset = parse_line_arg(&args, "contentOffset", true)?.unwrap_or(0);
        let max_lines =
            parse_line_arg(&args, "maxLines", false)?.unwrap_or(DEFAULT_READ_MAX_LINES);
        let max_bytes = parse_line_arg(&args, "maxBytes", false)?.unwrap_or(self.max_bytes);
        if let Some(end_line) = end_line_arg {
            if start_line > end_line {
                return Err(ToolError::invalid_input(
                    "startLine must be less than or equal to endLine",
                ));
            }
        }

        let bytes = std::fs::read(&file_path)
            .map_err(|e| ToolError::execution_failed("read_file", format!("{display}: {e}")))?;
        let decoded = decode_text(&bytes);

        // T-CF-01：二进制文件引用形态（替代报错拒绝）——text 置空，附提示
        if decoded.is_binary {
            return Ok(serde_json::json!({
                "path": display,
                "kind": "file",
                "bytes": bytes.len(),
                "size": bytes.len(),
                "encoding": decoded.encoding,
                "hasBom": false,
                "binary": true,
                "lineCount": 0,
                "totalChars": 0,
                "shownChars": 0,
                "startLine": start_line,
                "endLine": end_line_arg.unwrap_or(start_line),
                "truncated": false,
                "content_truncated": false,
                "nextContentOffset": 0,
                "hint": "二进制文件无法按文本读取，请使用 file_stat / 系统查看器打开",
                "text": "",
            }));
        }

        // 行优先读取：解码 → 按 \n 切行 → 应用窗口与偏移 → 双重钳制
        let lines: Vec<&str> = decoded.text.lines().collect();
        let total_lines = lines.len();
        let total_chars = decoded.text.chars().count();

        // 窗口起点：startLine-1 与 contentOffset 取大（续读偏移可平移窗口）；
        // 窗口终点：显式 endLine（1-indexed 闭区间 → 0-based 半开同值），
        // 缺省 = 窗口起点 + maxLines；越界钳制到文件末尾并保证空窗口合法
        let window_start = (start_line - 1).max(content_offset);
        let window_end = end_line_arg
            .unwrap_or(window_start.saturating_add(max_lines))
            .min(total_lines)
            .max(window_start);
        let window_text = if window_start >= total_lines {
            String::new()
        } else {
            lines[window_start..window_end].join("\n")
        };

        // maxLines 行数钳制 + maxBytes 字符预算钳制（回退完整行边界）
        let (shown, shown_lines, _) = clamp_text_by_lines(&window_text, max_bytes, max_lines);
        // nextContentOffset = 累计已返回完整行数（不超文件总行数）
        let next_content_offset = (window_start + shown_lines).min(total_lines);
        // 两个标志语义分离：truncated 仅表示字符预算截断；content_truncated 表示还有行未返回
        let char_truncated = window_text.chars().count() > max_bytes;
        let content_truncated = next_content_offset < total_lines;
        let end_line_echo = end_line_arg.unwrap_or(window_start.saturating_add(max_lines));
        let out_of_range = window_start >= total_lines;

        let tag = snapshot_tag(&file_path).unwrap_or_default();
        let mut header = format!(
            "path: {display}\nsnapshotTag: {tag}\nencoding: {}\nlines: {total_lines}\nstartLine: {start_line}, endLine: {end_line_echo}\n",
            decoded.encoding,
        );
        if char_truncated {
            header.push_str(&format!(
                "truncated: true (showing {} of {total_chars} chars; file has {} bytes)\n",
                shown.chars().count(),
                bytes.len(),
            ));
        }
        if content_truncated {
            header.push_str(&format!(
                "content_truncated: true (nextContentOffset: {next_content_offset}, {} lines remaining)\n",
                total_lines - next_content_offset,
            ));
        }
        if out_of_range {
            header.push_str(&format!(
                "window out of range: requested window starts beyond file end ({total_lines} lines)\n",
            ));
        }
        header.push_str("---\n");

        let text = if char_truncated {
            format!("{header}{shown}\n... truncated ...")
        } else if content_truncated {
            format!(
                "{header}{shown}\n... {} lines remaining, use contentOffset to continue ...",
                total_lines - next_content_offset,
            )
        } else {
            format!("{header}{shown}")
        };

        Ok(serde_json::json!({
            "path": display,
            "kind": "file",
            "bytes": bytes.len(),
            "encoding": decoded.encoding,
            "hasBom": decoded.has_bom,
            "lineCount": total_lines,
            "startLine": start_line,
            "endLine": end_line_echo,
            "totalChars": total_chars,
            "shownChars": shown.chars().count(),
            "snapshotTag": tag,
            "truncated": char_truncated,
            "content_truncated": content_truncated,
            "nextContentOffset": next_content_offset,
            "hint": if out_of_range {
                Some(format!("请求的行窗口超出文件末尾（文件共 {total_lines} 行）"))
            } else {
                None
            },
            "text": text,
        }))
    }
}

/// 解析可选行号/上限入参：必须为非负整数；
/// zero_allowed=false 时 0 视为非法（startLine/endLine/maxLines/maxBytes 从 1 起）
fn parse_line_arg(
    args: &serde_json::Value,
    key: &str,
    zero_allowed: bool,
) -> Result<Option<usize>, ToolError> {
    let Some(v) = args.get(key) else {
        return Ok(None);
    };
    let f = v
        .as_f64()
        .ok_or_else(|| ToolError::invalid_input(format!("{key} must be a number")))?;
    if !f.is_finite() || f < 0.0 || f.fract() != 0.0 {
        return Err(ToolError::invalid_input(format!(
            "{key} must be a non-negative integer"
        )));
    }
    let n = f as u64;
    if !zero_allowed && n == 0 {
        return Err(ToolError::invalid_input(format!("{key} must be >= 1")));
    }
    Ok(Some(n as usize))
}

/// 写文件工具：自动建父目录，BOM 续写既有编码；幂等守卫标记留 B5.3
pub(crate) struct WriteFileTool {
    def: ToolDefinition,
}

/// 写文件支持编码枚举（对齐 TS write_file 的 encoding 参数）
const WRITE_ENCODINGS: &[&str] = &["utf-8", "utf-8-bom", "utf-16le", "utf-16be"];

/// 覆盖拒绝错误码（REQ-E02 本地域码；对齐 write_paths.rs:37 的
/// tool.write_path_conflict 先例——不入 conex-types 注册表，执行器按错误码
/// 分类路由：文件已存在为确定拒绝，需显式 overwrite=true 才可放行）
pub(crate) const TOOL_FILE_EXISTS: &str = "tool.file_exists";

impl WriteFileTool {
    pub(crate) fn new() -> Self {
        Self {
            def: ToolDefinition {
                name: "write_file".to_string(),
                description: "写文件到工作区（默认拒绝覆盖已有文件，覆盖需显式传 overwrite=true；自动创建父目录，可指定编码）。".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "工作区文件路径（相对或绝对）" },
                        "content": { "type": "string", "description": "完整文件内容" },
                        "encoding": {
                            "type": "string",
                            "enum": ["utf-8", "utf-8-bom", "utf-16le", "utf-16be"],
                            "description": "写入编码，缺省时已存在文件按 BOM 续写原编码，新文件默认 utf-8"
                        },
                        "overwrite": {
                            "type": "boolean",
                            "default": false,
                            "description": "文件已存在时是否允许覆盖，默认 false（已存在则报错，需显式 true 才覆盖）"
                        }
                    },
                    "required": ["path", "content"],
                    "additionalProperties": false
                }),
                dangerous: true,
                fatal_on_error: false,
            },
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

    async fn execute(
        &self,
        ctx: &ToolContext,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, ToolError> {
        let path_str = require_string(&args, "path")?;
        let content = require_string(&args, "content")?;
        let file_path = resolve_workspace_path(&ctx.workspace_root, &path_str)?;
        let display = display_path(&ctx.workspace_root, &file_path);
        // T-D-08（REQ-D04 硬沙箱）：先越权拒绝（权限允许集 → tool.write_not_allowed），
        // 再冲突拒绝（并发互斥 → tool.write_path_conflict）——白名单是"允许集"
        // （权限沙箱）、互斥是"并发控制"（并发层），一先一后串行叠加；
        // 未接线（write_claims = None）或未装配策略不强制，行为与现状一致
        check_write_allowance_for_ctx(ctx, &file_path)?;
        // I4-M3：写路径互斥——执行期声明写路径，冲突拒绝（谁占用/何时）；
        // 未接线（write_claims = None）不强制；守卫随函数结束自动释放
        let _claim = claim_write_guard(ctx, &path_str, ClaimMode::Write)?;
        // REQ-E02：默认拒绝覆盖——存在性检查紧跟写路径声明、先于任何写盘意图；
        // 文件已存在且未显式 overwrite=true → 结构化错误，文案指引 AI 显式传参
        let overwrite = parse_overwrite_flag(&args)?;
        if file_path.exists() && !overwrite {
            return Err(ToolError::new(
                TOOL_FILE_EXISTS,
                format!(
                    "write_file: 目标文件已存在（{display}）。如需覆盖请显式设置 overwrite=true；该操作默认拒绝覆盖已有文件"
                ),
            ));
        }
        // I6-M11 C5：探索类子代理写文档配额检查（未装配 = 非探索类，放行）
        crate::explore_quota::guard_explore_docs_write(ctx)?;

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
        // I6-M11 C5：写盘成功后消耗配额（探索类子代理文档计数）
        crate::explore_quota::consume_explore_docs_quota(ctx);

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
/// 可见性 pub(crate)：供 replace.rs 直接复用（F7 提升后其本地镜像已删除去重）
pub(crate) fn resolve_write_encoding(
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
/// pub(crate)：replace.rs 复用（本地镜像已去重）
pub(crate) fn encode_text(content: &str, encoding: &str) -> Result<Vec<u8>, ToolError> {
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

/// 解析 overwrite 标志：缺省 false（REQ-E02 默认拒绝覆盖语义）；
/// 显式传值必须为布尔，非布尔为结构化入参错误
fn parse_overwrite_flag(args: &serde_json::Value) -> Result<bool, ToolError> {
    let Some(v) = args.get("overwrite") else {
        return Ok(false);
    };
    v.as_bool()
        .ok_or_else(|| ToolError::invalid_input("overwrite must be a boolean"))
}

/// 目录条目（对齐 TS list 工具的 items 结构 + size/mtime）
/// T-CF-03：新增 path（相对目录根，/ 分隔，目录条目带尾部 /）与 count（目录直接子项数）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DirEntry {
    name: String,
    /// 相对目录根的相对路径；根目录自身条目为空串；目录条目带尾部 `/`
    path: String,
    #[serde(rename = "type")]
    kind: &'static str,
    is_file: bool,
    is_directory: bool,
    /// 仅目录条目：read_dir 直接子项数；读失败 -1（宽容，不失败）
    #[serde(skip_serializing_if = "Option::is_none")]
    count: Option<i64>,
    size: u64,
    mtime: i64,
}

/// 统计目录直接子项数；read_dir 失败返回 -1（T-CF-03 宽容语义）
fn count_direct_children(dir: &Path) -> i64 {
    std::fs::read_dir(dir).map(|rd| rd.count() as i64).unwrap_or(-1)
}

/// 列目录工具：返回条目清单（name/type/isFile/isDirectory/size/mtime）
pub(crate) struct ListDirTool {
    def: ToolDefinition,
}

impl ListDirTool {
    pub(crate) fn new() -> Self {
        Self {
            def: ToolDefinition {
                name: "list_dir".to_string(),
                description: "列出工作区目录下的文件与文件夹条目，含相对路径（path）与目录子项数（count）。".to_string(),
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

    async fn execute(
        &self,
        ctx: &ToolContext,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, ToolError> {
        let path_str = optional_string(&args, "path").unwrap_or_else(|| ".".to_string());
        let dir = resolve_workspace_path(&ctx.workspace_root, &path_str)?;
        let display = display_path(&ctx.workspace_root, &dir);

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
            // T-CF-03：path = 相对目录根的相对路径（/ 分隔）；目录条目带尾部 /
            let rel_path = display_path(&dir, &dir.join(&name));
            let path = if is_dir && !rel_path.is_empty() {
                format!("{rel_path}/")
            } else {
                rel_path
            };
            // T-CF-03：count 仅目录条目统计直接子项数，读失败 -1（宽容）
            let count = if is_dir {
                Some(count_direct_children(&dir.join(&name)))
            } else {
                None
            };
            items.push(DirEntry {
                name,
                path,
                kind,
                is_file,
                is_directory: is_dir,
                count,
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
}

impl FileStatTool {
    pub(crate) fn new() -> Self {
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

    async fn execute(
        &self,
        ctx: &ToolContext,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, ToolError> {
        let path_str = require_string(&args, "path")?;
        let target = resolve_workspace_path(&ctx.workspace_root, &path_str)?;
        let display = display_path(&ctx.workspace_root, &target);

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
    use crate::context::{create_mock_tool_context, ToolContext};
    use conex_test_utils::TempWorkspace;
    use serde_json::json;

    /// 测试用会话上下文：workspace_root 指向临时工作区
    fn mock_ctx(ws: &TempWorkspace) -> ToolContext {
        ToolContext {
            workspace_root: ws.path().clone(),
            ..create_mock_tool_context()
        }
    }

    /// 提取 read_file 返回 text 的正文部分（剥离 header 与尾部续读标记）
    fn body_of(t: &serde_json::Value) -> String {
        let text = t["text"].as_str().unwrap();
        text.split("---\n")
            .nth(1)
            .unwrap_or("")
            .split("\n...")
            .next()
            .unwrap_or("")
            .to_string()
    }

    #[tokio::test]
    async fn read_file_roundtrip() {
        let ws = TempWorkspace::new("fs_read");
        ws.write_file("a.txt", "hello\nworld\n");
        let tool = ReadFileTool::new(None);
        let out = tool.execute(&mock_ctx(&ws), json!({ "path": "a.txt" })).await.unwrap();
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
        ws.write_file("big.txt", "hello world\nsecond line");
        let tool = ReadFileTool::new(Some(14));
        let out = tool.execute(&mock_ctx(&ws), json!({ "path": "big.txt" })).await.unwrap();
        assert_eq!(out["truncated"], true);
        assert_eq!(out["shownChars"], 11);
        assert_eq!(out["totalChars"], 23);
        let text = out["text"].as_str().unwrap();
        assert!(text.contains("truncated: true"));
        assert!(text.contains("... truncated ..."));
        // 完整行边界：第一行完整保留，第二行不切半
        assert!(text.contains("hello world"));
        assert!(!text.contains("second"));
    }

    #[tokio::test]
    async fn read_file_truncation_at_line_boundary() {
        // 超长单行 + 极小 maxBytes：回退到最近完整行边界 → 空正文，不留截断残留
        let ws = TempWorkspace::new("fs_line_boundary");
        ws.write_file("long.txt", "a".repeat(10_000).as_str());
        let tool = ReadFileTool::new(Some(100));
        let out = tool.execute(&mock_ctx(&ws), json!({ "path": "long.txt" })).await.unwrap();
        assert_eq!(out["truncated"], true);
        assert_eq!(out["shownChars"], 0);
        assert_eq!(out["totalChars"], 10_000);
        let text = out["text"].as_str().unwrap();
        assert!(text.ends_with("... truncated ..."));
        // 正文完全为空：超长单行无法容纳，不留截断残留（hash 等头部无关）
        assert!(body_of(&out).is_empty());
        // 剩余行存在 → content_truncated 标记
        assert_eq!(out["content_truncated"], true);
        assert_eq!(out["nextContentOffset"], 0);
    }

    #[tokio::test]
    async fn read_file_rejects_path_traversal() {
        let ws = TempWorkspace::new("fs_traversal");
        ws.write_file("a.txt", "hello");
        let tool = ReadFileTool::new(None);
        let err = tool
            .execute(&mock_ctx(&ws), json!({ "path": "../outside.txt" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.path_escape");
    }

    #[tokio::test]
    async fn read_file_missing_and_directory_errors() {
        let ws = TempWorkspace::new("fs_err");
        ws.write_file("a.txt", "hello");
        let tool = ReadFileTool::new(None);
        assert!(tool.execute(&mock_ctx(&ws), json!({ "path": "nope.txt" })).await.is_err());
        let err = tool.execute(&mock_ctx(&ws), json!({ "path": "." })).await.unwrap_err();
        assert!(err.to_string().contains("directory"));
    }

    #[tokio::test]
    async fn read_file_binary_returns_reference() {
        // T-CF-01：二进制返回引用而非报错（替代旧 read_file_rejects_binary 语义）
        let ws = TempWorkspace::new("fs_binary");
        ws.write_file("bin.bin", "");
        let p = ws.path().join("bin.bin");
        std::fs::write(&p, [0u8, 1u8, 2u8]).unwrap();
        let tool = ReadFileTool::new(None);
        let out = tool.execute(&mock_ctx(&ws), json!({ "path": "bin.bin" })).await.unwrap();
        assert_eq!(out["binary"], true);
        assert_eq!(out["bytes"], 3);
        assert_eq!(out["size"], 3);
        assert_eq!(out["text"], "");
        assert!(out["hint"].as_str().unwrap().contains("file_stat"));
        assert_eq!(out["truncated"], false);
    }

    #[tokio::test]
    async fn read_file_line_range_returns_exact_window() {
        // 20 行文件，startLine=3/endLine=5 只返回 3~5 行（1-indexed 闭区间）
        let ws = TempWorkspace::new("fs_line_range");
        let content = (1..=20).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n");
        ws.write_file("r.txt", content.as_str());
        let tool = ReadFileTool::new(None);
        let out = tool
            .execute(&mock_ctx(&ws), json!({ "path": "r.txt", "startLine": 3, "endLine": 5 }))
            .await
            .unwrap();
        assert_eq!(out["startLine"], 3);
        assert_eq!(out["endLine"], 5);
        assert_eq!(out["lineCount"], 20);
        let text = out["text"].as_str().unwrap();
        assert!(text.contains("line 3\nline 4\nline 5"));
        assert!(!text.contains("line 2"));
        assert!(!text.contains("line 6"));
        // 窗口后仍有内容 → 剩余行存在标记
        assert_eq!(out["content_truncated"], true);
    }

    #[tokio::test]
    async fn read_file_line_range_clamped_to_max_lines() {
        // 1000 行缺省参数：只返回 800 行，content_truncated=true 且 nextContentOffset=800
        let ws = TempWorkspace::new("fs_line_max");
        let content = (1..=1000).map(|i| format!("line {i:04}")).collect::<Vec<_>>().join("\n");
        ws.write_file("m.txt", content.as_str());
        let tool = ReadFileTool::new(None);
        let out = tool.execute(&mock_ctx(&ws), json!({ "path": "m.txt" })).await.unwrap();
        assert_eq!(out["content_truncated"], true);
        assert_eq!(out["nextContentOffset"], 800);
        assert_eq!(out["truncated"], false);
        let text = out["text"].as_str().unwrap();
        assert!(text.contains("line 0001"));
        assert!(text.contains("line 0800"));
        assert!(!text.contains("line 0801"));
        assert!(text.contains("content_truncated: true"));
        // 正文恰为 800 行（header 在 --- 之前，剥尾部续读标记）
        assert_eq!(body_of(&out).lines().count(), 800);
    }

    #[tokio::test]
    async fn read_file_content_offset_resumes() {
        // maxLines=5 读两次（第二次 contentOffset=5）：两次正文拼接 === 全文，无行被切半
        let ws = TempWorkspace::new("fs_offset");
        let content = (1..=10).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n");
        ws.write_file("o.txt", content.as_str());
        let tool = ReadFileTool::new(None);
        let first = tool
            .execute(&mock_ctx(&ws), json!({ "path": "o.txt", "maxLines": 5 }))
            .await
            .unwrap();
        assert_eq!(first["content_truncated"], true);
        assert_eq!(first["nextContentOffset"], 5);
        let second = tool
            .execute(&mock_ctx(&ws), json!({ "path": "o.txt", "maxLines": 5, "contentOffset": 5 }))
            .await
            .unwrap();
        assert_eq!(second["content_truncated"], false);
        assert_eq!(second["nextContentOffset"], 10);
        let joined = format!("{}\n{}", body_of(&first), body_of(&second));
        assert_eq!(joined, content);
    }

    #[tokio::test]
    async fn read_file_utf16_line_range() {
        // UTF-16LE（带 BOM）文件：解码后按行切分，行号读取正确
        let ws = TempWorkspace::new("fs_u16range");
        let mut bytes = vec![0xFF, 0xFE];
        for u in "u1\nu2\nu3\nu4\nu5\n".encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        let p = ws.path().join("u.txt");
        std::fs::write(&p, bytes).unwrap();
        let tool = ReadFileTool::new(None);
        let out = tool
            .execute(&mock_ctx(&ws), json!({ "path": "u.txt", "startLine": 2, "endLine": 3 }))
            .await
            .unwrap();
        assert_eq!(out["encoding"], "utf-16le");
        assert_eq!(out["lineCount"], 5);
        let text = out["text"].as_str().unwrap();
        assert!(text.contains("u2\nu3"));
        assert!(!text.contains("u1"));
        assert!(!text.contains("u4"));
    }

    #[tokio::test]
    async fn read_file_line_range_edge_cases() {
        let ws = TempWorkspace::new("fs_range_edge");
        let content = (1..=10).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n");
        ws.write_file("e.txt", content.as_str());
        let tool = ReadFileTool::new(None);
        // startLine > endLine：结构化入参错误
        let err = tool
            .execute(&mock_ctx(&ws), json!({ "path": "e.txt", "startLine": 5, "endLine": 3 }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("startLine"));
        // startLine 超出总行数：空窗口 + nextContentOffset = 总行数
        let out = tool
            .execute(&mock_ctx(&ws), json!({ "path": "e.txt", "startLine": 99 }))
            .await
            .unwrap();
        assert_eq!(out["content_truncated"], false);
        assert_eq!(out["nextContentOffset"], 10);
        let body = body_of(&out);
        assert!(body.trim().is_empty());
        assert!(out["hint"].as_str().unwrap().contains("超出文件末尾"));
        // contentOffset 超出文件：空 + nextContentOffset = 总行数
        let out = tool
            .execute(&mock_ctx(&ws), json!({ "path": "e.txt", "contentOffset": 500 }))
            .await
            .unwrap();
        assert_eq!(out["nextContentOffset"], 10);
        // 非整数入参报错
        assert!(tool
            .execute(&mock_ctx(&ws), json!({ "path": "e.txt", "maxLines": -1 }))
            .await
            .is_err());
        assert!(tool
            .execute(&mock_ctx(&ws), json!({ "path": "e.txt", "contentOffset": "x" }))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn write_then_read_roundtrip() {
        let ws = TempWorkspace::new("fs_write");
        let tool = WriteFileTool::new();
        let out = tool
            .execute(&mock_ctx(&ws), json!({ "path": "sub/dir/b.txt", "content": "你好 rust" }))
            .await
            .unwrap();
        assert_eq!(out["path"], "sub/dir/b.txt");
        assert_eq!(out["encoding"], "utf-8");
        assert_eq!(out["chars"], 7); // 你好(2) + " rust"(5)
        assert_eq!(ws.read_file("sub/dir/b.txt"), "你好 rust");
        // 父目录被自动创建
        assert!(ws.path().join("sub/dir").is_dir());

        let read_tool = ReadFileTool::new(None);
        let out = read_tool
            .execute(&mock_ctx(&ws), json!({ "path": "sub/dir/b.txt" }))
            .await
            .unwrap();
        assert_eq!(out["totalChars"], 7);
    }

    #[tokio::test]
    async fn write_file_supports_encodings() {
        let ws = TempWorkspace::new("fs_enc");
        let tool = WriteFileTool::new();
        tool.execute(&mock_ctx(&ws), json!({ "path": "u16.txt", "content": "hi", "encoding": "utf-16le" }))
            .await
            .unwrap();
        let bytes = std::fs::read(ws.path().join("u16.txt")).unwrap();
        assert!(bytes.starts_with(&[0xFF, 0xFE]));
        // 不传编码时按 BOM 续写原编码（目标已存在 → 显式 overwrite=true）
        tool.execute(&mock_ctx(&ws), json!({ "path": "u16.txt", "content": "yo", "overwrite": true }))
            .await
            .unwrap();
        let bytes = std::fs::read(ws.path().join("u16.txt")).unwrap();
        assert!(bytes.starts_with(&[0xFF, 0xFE]));
    }

    #[tokio::test]
    async fn write_file_rejects_overwrite_by_default() {
        // REQ-E02：文件已存在且未显式 overwrite=true → 结构化拒绝，原文件字节不变；
        // 与备份中间件协同说明：middleware before 钩子在 execute 之前运行
        // （backup.rs:20-21、242-266），拒绝覆盖会留下一条无意义快照条目——
        // 接受该行为（条目无害），不为此加清理逻辑
        let ws = TempWorkspace::new("fs_no_overwrite");
        ws.write_file("keep.txt", "original");
        let tool = WriteFileTool::new();
        let err = tool
            .execute(&mock_ctx(&ws), json!({ "path": "keep.txt", "content": "replaced" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), TOOL_FILE_EXISTS);
        assert!(err.to_string().contains("keep.txt"));
        assert!(err.to_string().contains("overwrite=true"), "错误文案须指引 AI 显式传参");
        assert_eq!(ws.read_file("keep.txt"), "original", "拒绝时文件字节必须不变");
        // 显式 overwrite=false 同样拒绝
        let err = tool
            .execute(&mock_ctx(&ws), json!({ "path": "keep.txt", "content": "x", "overwrite": false }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), TOOL_FILE_EXISTS);
        // 非布尔 overwrite：结构化入参错误
        let err = tool
            .execute(&mock_ctx(&ws), json!({ "path": "keep.txt", "content": "x", "overwrite": "yes" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.invalid_input");
    }

    #[tokio::test]
    async fn write_file_overwrite_true_allows_replace() {
        // REQ-E02：显式 overwrite=true 放行覆盖，内容替换并返回新快照标记
        let ws = TempWorkspace::new("fs_overwrite_ok");
        ws.write_file("ov.txt", "old");
        let tool = WriteFileTool::new();
        let out = tool
            .execute(&mock_ctx(&ws), json!({ "path": "ov.txt", "content": "new", "overwrite": true }))
            .await
            .unwrap();
        assert_eq!(out["path"], "ov.txt");
        assert_eq!(out["encoding"], "utf-8");
        assert_eq!(ws.read_file("ov.txt"), "new");
        assert!(out["newSnapshotTag"].as_str().unwrap().len() >= 12);
    }

    #[tokio::test]
    async fn write_file_overwrite_irrelevant_for_new_file() {
        // REQ-E02：目标文件不存在时 overwrite 参数无影响——缺省与显式 false 均可新建
        let ws = TempWorkspace::new("fs_overwrite_new");
        let tool = WriteFileTool::new();
        tool.execute(&mock_ctx(&ws), json!({ "path": "n1.txt", "content": "a" }))
            .await
            .unwrap();
        tool.execute(&mock_ctx(&ws), json!({ "path": "n2.txt", "content": "b", "overwrite": false }))
            .await
            .unwrap();
        assert_eq!(ws.read_file("n1.txt"), "a");
        assert_eq!(ws.read_file("n2.txt"), "b");
    }

    #[tokio::test]
    async fn write_file_rejects_escape_and_bad_encoding() {
        let ws = TempWorkspace::new("fs_werr");
        let tool = WriteFileTool::new();
        let err = tool
            .execute(&mock_ctx(&ws), json!({ "path": "../evil.txt", "content": "x" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.path_escape");
        let err = tool
            .execute(&mock_ctx(&ws), json!({ "path": "a.txt", "content": "x", "encoding": "latin1" }))
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
        let tool = ListDirTool::new();
        let out = tool.execute(&mock_ctx(&ws), json!({})).await.unwrap();
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
    async fn list_dir_entries_have_relative_path() {
        // T-CF-03：子项 path 为相对路径，目录条目带 / 后缀语义
        let ws = TempWorkspace::new("fs_list_path");
        ws.write_file("a.txt", "aa");
        ws.write_file("sub/c.txt", "cc");
        let tool = ListDirTool::new();
        let out = tool.execute(&mock_ctx(&ws), json!({})).await.unwrap();
        let items = out["items"].as_array().unwrap();
        let dir_item = items.iter().find(|i| i["name"] == "sub").unwrap();
        assert_eq!(dir_item["path"], "sub/");
        let file_item = items.iter().find(|i| i["name"] == "a.txt").unwrap();
        assert_eq!(file_item["path"], "a.txt");
    }

    #[tokio::test]
    async fn list_dir_directory_count() {
        // T-CF-03：含 3 文件的目录 count=3；文件条目 count 缺省（字段不出现）
        let ws = TempWorkspace::new("fs_list_count");
        ws.write_file("sub/a1.txt", "1");
        ws.write_file("sub/a2.txt", "2");
        ws.write_file("sub/a3.txt", "3");
        ws.write_file("top.txt", "t");
        let tool = ListDirTool::new();
        let out = tool.execute(&mock_ctx(&ws), json!({})).await.unwrap();
        let items = out["items"].as_array().unwrap();
        let dir_item = items.iter().find(|i| i["name"] == "sub").unwrap();
        assert_eq!(dir_item["count"], 3);
        let file_item = items.iter().find(|i| i["name"] == "top.txt").unwrap();
        assert!(file_item.get("count").is_none());
    }

    #[tokio::test]
    async fn list_dir_unreadable_dir_count_minus_one() {
        // T-CF-03：read_dir 失败目录 count=-1（宽容，不报错）。
        // Windows 无法稳定构造无权限目录，改用不存在的路径验证计数助手
        let missing = std::env::temp_dir().join("fs_count_missing_xyz");
        assert_eq!(count_direct_children(&missing), -1);
        let ws = TempWorkspace::new("fs_list_unreadable");
        ws.write_file("ok/x.txt", "x");
        assert_eq!(count_direct_children(&ws.path().join("ok")), 1);
    }

    #[tokio::test]
    async fn list_dir_non_directory_errors() {
        let ws = TempWorkspace::new("fs_listerr");
        ws.write_file("a.txt", "x");
        let tool = ListDirTool::new();
        let err = tool
            .execute(&mock_ctx(&ws), json!({ "path": "a.txt" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("not a directory"));
    }

    #[tokio::test]
    async fn file_stat_reports_metadata() {
        let ws = TempWorkspace::new("fs_stat");
        ws.write_file("a.txt", "hello");
        let tool = FileStatTool::new();
        let out = tool.execute(&mock_ctx(&ws), json!({ "path": "a.txt" })).await.unwrap();
        assert_eq!(out["isFile"], true);
        assert_eq!(out["type"], "file");
        assert_eq!(out["size"], 5);
        assert!(out["mtime"].as_i64().unwrap() > 0);

        let out = tool.execute(&mock_ctx(&ws), json!({ "path": "." })).await.unwrap();
        assert_eq!(out["isDirectory"], true);
    }

    #[tokio::test]
    async fn file_stat_missing_errors() {
        let ws = TempWorkspace::new("fs_staterr");
        let tool = FileStatTool::new();
        assert!(tool.execute(&mock_ctx(&ws), json!({ "path": "ghost.txt" })).await.is_err());
    }
}
