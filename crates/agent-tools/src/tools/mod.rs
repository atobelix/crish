//! 内置工具模块（任务书 B5.2：fs / shell / search / diff + I2-S3 删除接管）
//!
//! - `fs`：读/写/列目录/文件信息，路径安全复用 conex-fs 的 safe_canonicalize
//! - `search`：grep 文本搜索（目录递归 + glob 过滤）与模糊文件查找（复用 conex-search）
//! - `shell`：命令执行，先过 conex-sandbox 门禁，Windows 用 PowerShell EncodedCommand 包装
//! - `diff`：文本 diff（复用 conex-diff，输出 unified diff 文本）
//! - `delete`：删除接管（delete_file / delete_dir，I2-S3）——唯一删除接口，
//!   移入 conex-fs 回收站服务并登记，dangerous=true 走审批
//! - `subagent`：run_subagent（I4-M2）——spawn 独立子代理会话 + run，
//!   递归守卫 + 三方状态映射 + 伪造审批防护（注册面 10→11）
//!
//! 全部工具实现 `Tool` trait，经 `register_builtin_tools` 统一注册进 ToolRegistry。
//! 各工具的会话级数据（工作区根目录等）执行时从 `ToolContext` 读取
//! （R3 T9：BuiltinToolConfig 仅承载构造期默认配置，不再注入 workspace_root）。

pub mod delete;
pub mod diff;
pub mod fs;
pub mod search;
pub mod shell;
pub mod subagent;

use crate::audit::{NoopAuditSink, SecurityAuditSink};
use crate::definition::ToolError;
use crate::registry::ToolRegistry;
use conex_types::error::codes;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// 内置工具统一定制配置（由工具执行器注入，模型入参不可覆盖）
///
/// R3 T9：`workspace_root` 移至执行期 `ToolContext`（会话级），
/// 本配置仅保留构造期默认值（shell 超时 / 输出上限 / 回收站根 /
/// 审计 sink）。
#[derive(Debug, Clone)]
pub struct BuiltinToolConfig {
    /// shell 工具默认超时（毫秒），任务书要求默认 30 秒
    pub default_shell_timeout_ms: u64,
    /// shell 工具默认输出保留上限（字节）
    pub default_shell_max_output_bytes: usize,
    /// 删除工具回收站根目录（I2-S3：None 时执行期回退工作区 `.crish-trash`）
    pub trash_root: Option<PathBuf>,
    /// 安全审计 sink（I2-S8：删除/重定向/拦截发射 security-audit 事件；
    /// None = 不接线，工具回退 no-op，审计仅走结构化 tracing 日志）
    pub audit_sink: Option<Arc<dyn SecurityAuditSink>>,
    /// run_subagent spawn 通道（I4-M2：None = 未接线，run_subagent 返回
    /// 结构化不可用错误；引擎侧接线后经此通道发起独立 run——落库与
    /// run 启动在引擎侧实现，agent-tools 只定义契约）
    pub subagent_spawner: Option<Arc<dyn subagent::SubagentSpawner>>,
}

impl Default for BuiltinToolConfig {
    fn default() -> Self {
        Self {
            default_shell_timeout_ms: 30_000,
            default_shell_max_output_bytes: 200_000,
            trash_root: None,
            audit_sink: None,
            subagent_spawner: None,
        }
    }
}

/// 以默认配置注册全部内置工具（供无配置环境的直连使用）
pub fn register_builtin_tools(registry: &mut ToolRegistry) -> Result<(), ToolError> {
    register_builtin_tools_with_config(registry, BuiltinToolConfig::default())
}

/// 以显式配置注册全部内置工具（构造期默认值由配置注入，会话数据走 ctx）
pub fn register_builtin_tools_with_config(
    registry: &mut ToolRegistry,
    config: BuiltinToolConfig,
) -> Result<(), ToolError> {
    let audit_sink = config
        .audit_sink
        .unwrap_or_else(|| Arc::new(NoopAuditSink) as Arc<dyn SecurityAuditSink>);
    registry.register(Arc::new(fs::ReadFileTool::new(None)))?;
    registry.register(Arc::new(fs::WriteFileTool::new()))?;
    registry.register(Arc::new(fs::ListDirTool::new()))?;
    registry.register(Arc::new(fs::FileStatTool::new()))?;
    registry.register(Arc::new(search::GrepSearchTool::new()))?;
    registry.register(Arc::new(search::FuzzyFindTool::new()))?;
    registry.register(Arc::new(shell::ShellCommandTool::with_audit_sink(
        config.default_shell_timeout_ms,
        config.default_shell_max_output_bytes,
        config.trash_root.clone(),
        Arc::clone(&audit_sink),
    )))?;
    registry.register(Arc::new(diff::DiffTextTool::new()))?;
    registry.register(Arc::new(delete::DeleteFileTool::with_audit_sink(
        config.trash_root.clone(),
        Arc::clone(&audit_sink),
    )))?;
    registry.register(Arc::new(delete::DeleteDirTool::with_audit_sink(
        config.trash_root.clone(),
        audit_sink,
    )))?;
    registry.register(Arc::new(subagent::RunSubagentTool::with_spawner(
        config.subagent_spawner.clone(),
    )))?;
    Ok(())
}

// ==================== 共享助手（工具内部使用） ====================

/// 路径最大组件深度（safe_canonicalize 的深度上限）
pub(crate) const MAX_PATH_DEPTH: usize = 32;

/// 必填字符串入参：非空 + 非法控制字符拒绝（对齐 TS requireString）
pub(crate) fn require_string(args: &serde_json::Value, key: &str) -> Result<String, ToolError> {
    let value = args
        .get(key)
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| ToolError::invalid_input(format!("{key} must be a non-empty string")))?;
    if value.trim().is_empty() {
        return Err(ToolError::invalid_input(format!(
            "{key} must be a non-empty string"
        )));
    }
    if value.chars().any(|c| {
        matches!(
            c,
            '\u{0000}'..='\u{0008}' | '\u{000b}' | '\u{000c}' | '\u{000e}'..='\u{001f}' | '\u{007f}'
        )
    }) {
        return Err(ToolError::invalid_input(format!(
            "{key} contains invalid control characters"
        )));
    }
    Ok(value.to_string())
}

/// 可选字符串入参
pub(crate) fn optional_string(args: &serde_json::Value, key: &str) -> Option<String> {
    args.get(key).and_then(serde_json::Value::as_str).map(String::from)
}

/// 可选布尔入参
pub(crate) fn optional_bool(args: &serde_json::Value, key: &str) -> Option<bool> {
    args.get(key).and_then(serde_json::Value::as_bool)
}

/// 可选正数入参（非正数/非有限数视为缺省，由调用方套用默认值）
pub(crate) fn optional_u64(args: &serde_json::Value, key: &str) -> Option<u64> {
    let v = args.get(key)?;
    let f = v.as_f64()?;
    if f.is_finite() && f >= 1.0 {
        Some(f.floor() as u64)
    } else {
        None
    }
}

/// 解析工作区路径（对齐 TS resolveWorkspacePath 语义）
///
/// 校验顺序：非空 → 控制字符 → 组件级扫描（`..` 越界报 tool.path_escape）→
/// safe_canonicalize（深度上限）→ 工作区包含性（符号链接解析后仍须在根内）。
/// Windows 上 canonicalize 返回 `\\?\` 前缀路径，统一剥离为可读路径。
pub(crate) fn resolve_workspace_path(
    workspace_root: &Path,
    input: &str,
) -> Result<PathBuf, ToolError> {
    if input.trim().is_empty() {
        return Err(ToolError::invalid_input(
            "path must be a non-empty string",
        ));
    }
    if input.chars().any(|c| c.is_control()) {
        return Err(ToolError::invalid_input(format!(
            "invalid path (control character): {input:?}"
        )));
    }
    let raw = Path::new(input);
    let candidate = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        workspace_root.join(raw)
    };
    // 组件级扫描：`..` 与超深路径按越界处理（对齐 TS "Path escapes workspace"）
    let mut depth = 0usize;
    for comp in candidate.components() {
        match comp {
            std::path::Component::ParentDir => {
                return Err(ToolError::new(
                    codes::TOOL_PATH_ESCAPE,
                    format!("Path escapes workspace: {input}"),
                ));
            }
            std::path::Component::Normal(_) => {
                depth += 1;
                if depth > MAX_PATH_DEPTH {
                    return Err(ToolError::new(
                        codes::TOOL_PATH_ESCAPE,
                        format!("Path escapes workspace: {input}"),
                    ));
                }
            }
            _ => {}
        }
    }
    let canonical = conex_fs::path_utils::safe_canonicalize(&candidate, MAX_PATH_DEPTH)
        .map_err(|e| ToolError::invalid_input(format!("invalid path: {e}")))?;
    let canonical = strip_verbatim_prefix(&canonical);
    let canonical_root = conex_fs::path_utils::safe_canonicalize(workspace_root, MAX_PATH_DEPTH)
        .map(|p| strip_verbatim_prefix(&p))
        .unwrap_or_else(|_| workspace_root.to_path_buf());
    if !path_within_root(&canonical, &canonical_root) {
        return Err(ToolError::new(
            codes::TOOL_PATH_ESCAPE,
            format!("Path escapes workspace: {input}"),
        ));
    }
    Ok(canonical)
}

/// 工作区显示路径（对齐 TS displayPath：优先相对路径，根目录自身回退文件名）
///
/// 先按原始根匹配，失败再按规范化（符号链接解析后）根匹配，最后回退文件名。
/// 输出统一使用 `/` 分隔（对齐 TS 语义，避免 Windows 反斜杠干扰模型解析）。
pub(crate) fn display_path(root: &Path, path: &Path) -> String {
    let mut rel = display_path_native(root, path);
    #[cfg(windows)]
    {
        rel = rel.replace('\\', "/");
    }
    rel
}

/// 原生分隔符版显示路径（内部实现）
fn display_path_native(root: &Path, path: &Path) -> String {
    if let Ok(rel) = path.strip_prefix(root) {
        if !rel.as_os_str().is_empty() {
            return rel.to_string_lossy().into_owned();
        }
    }
    if let Ok(canon_root) = conex_fs::path_utils::safe_canonicalize(root, MAX_PATH_DEPTH) {
        let canon_root = strip_verbatim_prefix(&canon_root);
        if let Ok(rel) = path.strip_prefix(&canon_root) {
            if !rel.as_os_str().is_empty() {
                return rel.to_string_lossy().into_owned();
            }
        }
    }
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

/// 剥离 Windows canonicalize 的 `\\?\` / `\\?\UNC\` 前缀（其它平台原样返回）
pub(crate) fn strip_verbatim_prefix(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let s = path.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!("\\{rest}"));
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(rest.to_string());
        }
    }
    path.to_path_buf()
}

/// 快照标记：文件 SHA-256 前 12 个 hex 字符（对齐 TS computeSnapshotTag）
pub(crate) fn snapshot_tag(path: &Path) -> Option<String> {
    conex_fs::path_utils::compute_file_hash(path)
        .ok()
        .map(|h| h[..12].to_string())
}

/// 文本解码结果（简化版 decodeTextBuffer）
pub(crate) struct DecodedText {
    pub text: String,
    pub encoding: String,
    pub has_bom: bool,
    /// 二进制标记：内容含 NUL 字节无法按文本读取
    pub is_binary: bool,
}

/// 解码文本：BOM 探测 utf-8 / utf-16le / utf-16be，NUL 判定二进制
///
/// 注意顺序：BOM 探测必须先于 NUL 检查——UTF-16 文本天然含 `\x00` 字节。
pub(crate) fn decode_text(bytes: &[u8]) -> DecodedText {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return DecodedText {
            text: decode_utf16(&bytes[2..], true),
            encoding: "utf-16le".to_string(),
            has_bom: true,
            is_binary: false,
        };
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return DecodedText {
            text: decode_utf16(&bytes[2..], false),
            encoding: "utf-16be".to_string(),
            has_bom: true,
            is_binary: false,
        };
    }
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return DecodedText {
            text: String::from_utf8_lossy(&bytes[3..]).into_owned(),
            encoding: "utf-8".to_string(),
            has_bom: true,
            is_binary: false,
        };
    }
    if bytes.contains(&0u8) {
        return DecodedText {
            text: String::new(),
            encoding: "binary".to_string(),
            has_bom: false,
            is_binary: true,
        };
    }
    DecodedText {
        text: String::from_utf8_lossy(bytes).into_owned(),
        encoding: "utf-8".to_string(),
        has_bom: false,
        is_binary: false,
    }
}

/// 按 UTF-16 字节序解码（BOM 已剥除）
fn decode_utf16(bytes: &[u8], little_endian: bool) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| {
            if little_endian {
                u16::from_le_bytes([c[0], c[1]])
            } else {
                u16::from_be_bytes([c[0], c[1]])
            }
        })
        .collect();
    String::from_utf16_lossy(&units)
}

/// 路径包含性检查（Windows 大小写不敏感，按组件语义比较）
fn path_within_root(candidate: &Path, root: &Path) -> bool {
    let c = normalize_for_compare(candidate);
    let r = normalize_for_compare(root);
    if c == r {
        return true;
    }
    let sep = std::path::MAIN_SEPARATOR.to_string();
    c.starts_with(&format!("{r}{sep}"))
}

/// 比较用归一化：统一分隔符 + Windows 小写 + 去尾部分隔符
fn normalize_for_compare(p: &Path) -> String {
    let sep = std::path::MAIN_SEPARATOR.to_string();
    let mut s = p.to_string_lossy().replace(['/', '\\'], &sep);
    #[cfg(windows)]
    {
        s = s.to_lowercase();
    }
    if s.len() > 1 {
        s = s.trim_end_matches(std::path::MAIN_SEPARATOR).to_string();
    }
    s
}

/// 系统时间 → 纪元毫秒（对齐全仓 epoch ms 惯例；不可用时 0）
pub(crate) fn epoch_millis(t: Option<std::time::SystemTime>) -> i64 {
    t.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 截断字符串到上限，附截断说明
pub(crate) fn clamp_text(text: &str, limit: usize) -> (String, bool) {
    if text.chars().count() <= limit {
        return (text.to_string(), false);
    }
    let shown: String = text.chars().take(limit).collect();
    (shown, true)
}

#[cfg(test)]
mod tests {
    // G2 禁令豁免：测试临时目录清理（非产品删除路径，可恢复语义不适用）。
    #![allow(clippy::disallowed_methods)]

    use super::*;

    #[test]
    fn path_escape_rejected() {
        let root = std::env::temp_dir().join("agent_tools_escape_test");
        std::fs::create_dir_all(&root).unwrap();
        let err = resolve_workspace_path(&root, "../escape.txt").unwrap_err();
        assert_eq!(err.code(), "tool.path_escape");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn relative_path_resolved_within_root() {
        let root = std::env::temp_dir().join("agent_tools_resolve_test");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        let p = resolve_workspace_path(&root, "sub/file.txt").unwrap();
        assert_eq!(p, root.join("sub/file.txt"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn absolute_path_within_root_allowed() {
        let root = std::env::temp_dir().join("agent_tools_abs_test");
        std::fs::create_dir_all(&root).unwrap();
        let p = resolve_workspace_path(&root, &root.join("a.txt").display().to_string()).unwrap();
        assert_eq!(p, root.join("a.txt"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_and_control_path_rejected() {
        let root = std::env::temp_dir();
        assert!(resolve_workspace_path(&root, "").is_err());
        assert!(resolve_workspace_path(&root, "a\0b.txt").is_err());
        assert!(resolve_workspace_path(&root, "a\r\nb.txt").is_err());
    }

    #[test]
    fn decode_text_detects_bom_and_binary() {
        let bom_utf8 = b"\xEF\xBB\xBFhello".to_vec();
        let d = decode_text(&bom_utf8);
        assert_eq!(d.text, "hello");
        assert!(d.has_bom);
        assert!(!d.is_binary);

        let utf16le = b"\xFF\xFEh\x00e\x00l\x00l\x00o\x00".to_vec();
        let d = decode_text(&utf16le);
        assert_eq!(d.text, "hello");
        assert_eq!(d.encoding, "utf-16le");

        let binary = vec![0u8, 1u8, 2u8, 3u8];
        let d = decode_text(&binary);
        assert!(d.is_binary);
    }

    #[test]
    fn glob_helper_free_functions_covered_by_search_tests() {
        // display_path 基本行为
        let root = PathBuf::from("C:/work");
        assert_eq!(display_path(&root, &root.join("src/a.rs")), "src/a.rs");
        assert_eq!(display_path(&root, &root), "work");
    }

    #[test]
    fn register_builtin_tools_registers_all() {
        let mut registry = ToolRegistry::new();
        register_builtin_tools(&mut registry).unwrap();
        assert_eq!(registry.len(), 11);
        let names: Vec<String> = registry
            .list_definitions()
            .iter()
            .map(|d| d.name.clone())
            .collect();
        assert_eq!(
            names,
            [
                "delete_dir",
                "delete_file",
                "diff_text",
                "file_stat",
                "fuzzy_find",
                "grep_search",
                "list_dir",
                "read_file",
                "run_subagent",
                "shell_command",
                "write_file",
            ]
        );
        // 重复注册报版本冲突
        let err = register_builtin_tools(&mut registry).unwrap_err();
        assert_eq!(err.code(), "tool.version_conflict");
    }

    #[tokio::test]
    async fn register_with_config_executes_read_file_via_ctx() {
        use crate::context::{create_mock_tool_context, ToolContext};

        let ws = conex_test_utils::TempWorkspace::new("reg_integ");
        ws.write_file("note.txt", "hello from registry");
        let mut registry = ToolRegistry::new();
        register_builtin_tools(&mut registry).unwrap();
        assert!(registry.has("read_file"));
        let tool = registry.get("read_file").unwrap();
        // R3 T9：workspace_root 从会话上下文读取（不再由注册配置注入）
        let ctx = ToolContext {
            workspace_root: ws.path().clone(),
            ..create_mock_tool_context()
        };
        let out = tool
            .execute(&ctx, serde_json::json!({ "path": "note.txt" }))
            .await
            .unwrap();
        assert!(out["text"].as_str().unwrap().contains("hello from registry"));
    }
}
