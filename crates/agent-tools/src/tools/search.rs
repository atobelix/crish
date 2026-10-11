//! 搜索工具（任务书 B5.2：grep_search / fuzzy_find）
//!
//! - grep_search：目录递归文本搜索（子串或正则），支持 glob 过滤与排除式 glob，
//!   默认排除 .git / node_modules 等非源码目录；行级模式返回 path/line/column/text，
//!   文件级模式（matchPerLine=false）返回命中文件路径 + 每文件命中行数
//! - fuzzy_find：模糊文件名查找，复用 conex-search 的模糊匹配与目录索引

use crate::context::ToolContext;
use crate::definition::{Tool, ToolDefinition, ToolError};
use crate::tools::{
    display_path, optional_bool, optional_string, optional_u64, require_string,
    resolve_workspace_path,
};
use async_trait::async_trait;
use ignore::WalkBuilder;
use std::path::{Path, PathBuf};

/// 搜索默认上限（对齐 TS search_files 默认值）
const DEFAULT_MAX_MATCHES: u64 = 200;
const DEFAULT_MAX_FILES: u64 = 2_000;
// D0/U-BUDGET：单文件字节上限定义收敛至 conex-shared::perf_budget（行为不变）
use conex_shared::perf_budget::SEARCH_MAX_FILE_BYTES_DEFAULT;
/// 递归深度上限
pub(crate) const MAX_WALK_DEPTH: usize = 16;

/// 默认排除的非源码目录（与 conex-search walker 的 SKIP_DIRS 一致）
///
/// `pub(crate)` 供 project_tree 复用（T-37：禁重复定义，共享一份清单）。
/// 语义：命中即**整枝剪除**（目录自身与其子树都不进入遍历/树输出）。
pub(crate) const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
    "target",
];

/// 单条匹配（对齐 TS search_files 的 matches 结构 + column）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GrepMatch {
    path: String,
    line: usize,
    column: usize,
    text: String,
}

/// 文件级模式单条结果（对齐 grep -l 语义：命中文件路径 + 命中行数）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FileMatch {
    path: String,
    match_count: usize,
}

/// grep 文本搜索工具
pub(crate) struct GrepSearchTool {
    def: ToolDefinition,
}

impl GrepSearchTool {
    pub(crate) fn new() -> Self {
        Self {
            def: ToolDefinition {
                name: "grep_search".to_string(),
                description: "在工作区目录内递归搜索文本（子串或正则），支持 glob 过滤与排除式 glob（excludeGlobs），默认排除 .git/node_modules 等目录；matchPerLine=false 时输出文件级结果（命中文件路径 + 每文件命中行数，grep -l 语义）。".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "搜索文本或正则表达式" },
                        "path": { "type": "string", "description": "搜索根目录，缺省为工作区根" },
                        "regex": { "type": "boolean", "description": "query 是否按正则解释，缺省 false" },
                        "glob": { "type": "string", "description": "glob 过滤（如 *.rs、src/**），只匹配符合的文件" },
                        "excludeGlobs": { "type": "array", "items": { "type": "string" }, "description": "排除式 glob 列表（如 **/generated/*.rs），命中即跳过该文件；判定优先级高于 glob 与内置目录排除" },
                        "caseSensitive": { "type": "boolean", "description": "子串模式是否大小写敏感，缺省 true" },
                        "matchPerLine": { "type": "boolean", "description": "true 为行级模式（缺省，逐行输出命中）；false 为文件级模式（只输出命中文件路径与每文件命中行数）" },
                        "maxMatches": { "type": "number", "description": "最大返回匹配数（行级按命中行计，文件级按文件数计），默认 200" },
                        "maxFiles": { "type": "number", "description": "最大访问文件数，默认 2000" },
                        "maxFileBytes": { "type": "number", "description": "单个文件参与搜索的大小上限（字节），默认 512000" }
                    },
                    "required": ["query"],
                    "additionalProperties": false
                }),
                dangerous: false,
                fatal_on_error: false,
            },
        }
    }
}

#[async_trait]
impl Tool for GrepSearchTool {
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
        let query = require_string(&args, "query")?;
        let path_str = optional_string(&args, "path").unwrap_or_else(|| ".".to_string());
        let root = resolve_workspace_path(&ctx.workspace_root, &path_str)?;
        let use_regex = optional_bool(&args, "regex").unwrap_or(false);
        let glob = optional_string(&args, "glob");
        let case_sensitive = optional_bool(&args, "caseSensitive").unwrap_or(true);
        let match_per_line = optional_bool(&args, "matchPerLine").unwrap_or(true);
        let exclude_globs: Vec<String> = args
            .get("excludeGlobs")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let max_matches = optional_u64(&args, "maxMatches").unwrap_or(DEFAULT_MAX_MATCHES);
        let max_files = optional_u64(&args, "maxFiles").unwrap_or(DEFAULT_MAX_FILES);
        let max_file_bytes =
            optional_u64(&args, "maxFileBytes").unwrap_or(SEARCH_MAX_FILE_BYTES_DEFAULT);

        // 正则编译失败按入参非法处理（对齐 TS new RegExp 抛错语义）
        let matcher = if use_regex {
            Some(
                regex::Regex::new(&query)
                    .map_err(|e| ToolError::invalid_input(format!("invalid regex: {e}")))?,
            )
        } else {
            None
        };

        // U-BLOCK：目录遍历 + 文件读取经 spawn_blocking（06-SR01）
        let (matches, files, visited_files, truncated) = {
            let query = query.clone();
            let root = root.clone();
            let glob = glob.clone();
            let exclude_globs = exclude_globs.clone();
            let matcher = matcher.clone();
            tokio::task::spawn_blocking(move || {
                let root_display = display_path(&root, &root);
                let _ = root_display;
                let mut matches: Vec<GrepMatch> = Vec::new();
                let mut files: Vec<FileMatch> = Vec::new();
                let mut visited_files: u64 = 0;
                let mut truncated = false;

                let line_hit = |line: &str| -> Option<usize> {
                    if let Some(re) = &matcher {
                        re.find(line).map(|m| m.start())
                    } else if case_sensitive {
                        line.find(&query)
                    } else {
                        case_insensitive_char_column(line, &query).map(|col| {
                            line.char_indices()
                                .nth(col - 1)
                                .map(|(b, _)| b)
                                .unwrap_or(line.len())
                        })
                    }
                };

                for file in walk_files(&root, glob.as_deref(), &exclude_globs, max_files) {
                    visited_files += 1;
                    let metadata = match std::fs::metadata(&file) {
                        Ok(m) => m,
                        Err(_) => continue,
                    };
                    if metadata.len() > max_file_bytes {
                        continue;
                    }
                    let bytes = match std::fs::read(&file) {
                        Ok(b) => b,
                        Err(_) => continue,
                    };
                    if bytes.contains(&0u8) {
                        continue;
                    }
                    let text = String::from_utf8_lossy(&bytes);
                    let display = display_path(&root, &file);
                    if match_per_line {
                        for (idx, raw_line) in text.split('\n').enumerate() {
                            let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
                            if let Some(byte_offset) = line_hit(line) {
                                matches.push(GrepMatch {
                                    path: display.clone(),
                                    line: idx + 1,
                                    column: char_boundary_column(line, byte_offset),
                                    text: line.trim().to_string(),
                                });
                                if matches.len() as u64 >= max_matches {
                                    truncated = true;
                                    break;
                                }
                            }
                        }
                        if truncated {
                            break;
                        }
                    } else {
                        let hit_lines = text
                            .split('\n')
                            .map(|raw| raw.strip_suffix('\r').unwrap_or(raw))
                            .filter(|line| line_hit(line).is_some())
                            .count();
                        if hit_lines > 0 {
                            files.push(FileMatch {
                                path: display,
                                match_count: hit_lines,
                            });
                            if files.len() as u64 >= max_matches {
                                truncated = true;
                                break;
                            }
                        }
                    }
                }
                (matches, files, visited_files, truncated)
            })
            .await
            .map_err(|e| {
                ToolError::execution_failed("grep_search", format!("spawn_blocking: {e}"))
            })?
        };

        let root_display = display_path(&root, &root);
        let result_count = if match_per_line {
            matches.len()
        } else {
            files.len()
        };
        let count_label = if match_per_line { "matches" } else { "files" };
        let header = format!(
            "query: {query}\nroot: {root_display}\n{count_label}: {result_count}\nvisitedFiles: {visited_files}\n{}---",
            if truncated {
                "truncated: true\n结果已达上限，请缩小搜索范围或增加 maxMatches\n"
            } else {
                ""
            },
        );
        let body = if match_per_line {
            if matches.is_empty() {
                "(no matches)".to_string()
            } else {
                matches
                    .iter()
                    .map(|m| format!("{}:{}:{}: {}", m.path, m.line, m.column, m.text))
                    .collect::<Vec<_>>()
                    .join("\n")
            }
        } else if files.is_empty() {
            "(no matches)".to_string()
        } else {
            files
                .iter()
                .map(|f| format!("{}:{}", f.path, f.match_count))
                .collect::<Vec<_>>()
                .join("\n")
        };

        Ok(serde_json::json!({
            "query": query,
            "root": root_display,
            "visitedFiles": visited_files,
            "matchCount": result_count,
            "truncated": truncated,
            "matches": matches,
            "files": files,
            "text": format!("{header}\n{body}"),
        }))
    }
}

/// 大小写不敏感命中换算（32 文档 DD3-T2 A1-M1 修复核心）：返回原始行 1-based char 列号。
///
/// 旧实现 `line.to_lowercase().find(&query.to_lowercase())` 的字节偏移来自折叠串，
/// 再对原始行切片——Unicode 大小写折叠改变字节长度（İ U+0130 2B→i̇ 3B、ﬀ U+FB00 3B→ff 2B）
/// 时偏移落在原始行非 char 边界 → panic 或列号错位。本函数改为 char 级双游标换算：
/// 对原始行逐字符折叠（char::to_lowercase），同步记录每个折叠字符对应的原始 char 游标
/// （折叠 1→多字符由迭代消费对齐），在折叠串中查找折叠后 query 的前缀匹配，命中点
/// 映射回原始行 char 列号。与 str::to_lowercase 语义一致（char 级折叠拼接），
/// ASCII 面列号数值与旧实现相同。
fn case_insensitive_char_column(line: &str, query: &str) -> Option<usize> {
    // 空查询对齐 line.find("") 语义：恒定命中行首（列号 1）；windows(0) 会 panic，须提前返回
    if query.is_empty() {
        return Some(1);
    }
    let qchars: Vec<char> = query.to_lowercase().chars().collect();
    let mut folded: Vec<char> = Vec::new();
    let mut origin: Vec<usize> = Vec::new();
    for (idx, ch) in line.chars().enumerate() {
        for fc in ch.to_lowercase() {
            folded.push(fc);
            origin.push(idx);
        }
    }
    let qlen = qchars.len();
    if qlen > folded.len() {
        return None;
    }
    folded
        .windows(qlen)
        .position(|w| w == qchars.as_slice())
        .map(|start| origin[start] + 1)
}

/// 字节偏移 → 1-based char 列号（兜底防 panic 防御层，32 文档 DD3-T2 改动点②）。
///
/// 原实现 `line[..off]` 切片在偏移非 char 边界时 panic；本函数以 Option 语义取前缀，
/// `None`（偏移落在多字节字符内部）时按 is_char_boundary 递减回退到最近 char 边界再取前缀，
/// 列号数值对 char 边界偏移与旧实现完全一致。未来其它偏移来源亦不 panic。
fn char_boundary_column(line: &str, byte_offset: usize) -> usize {
    let off = byte_offset.min(line.len());
    let safe = match line.get(..off) {
        Some(prefix) => prefix,
        None => {
            let mut b = off;
            while b > 0 && !line.is_char_boundary(b) {
                b -= 1;
            }
            &line[..b]
        }
    };
    safe.chars().count() + 1
}

/// 递归遍历器（T-37 抽提，grep 与 project_tree 共用）：
/// gitignore 感知（hidden+git_ignore+git_global+git_exclude）+ max_depth 钳制
/// + skip 清单逐组件过滤。
///
/// `skip` 经 `filter_entry` 在**目录级**剪枝：命中即整枝不进入（比逐文件
/// 组件检查更省 IO，输出等价）。depth 0 恒放行——根目录名即使命中 skip
/// 清单（如工作区恰命名 `target`）也不剪除，避免整树为空。
///
/// 生命周期约束：`Walk` 迭代器持有 `filter_entry` 闭包，`skip` 必须
/// 'static——既有调用点（grep / project_tree）均传静态 [SKIP_DIRS]。
pub(crate) fn walker_for_root(
    root: &Path,
    depth: usize,
    skip: &'static [&'static str],
) -> ignore::Walk {
    WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .max_depth(Some(depth))
        .filter_entry(move |entry| {
            if entry.depth() == 0 {
                return true;
            }
            !entry
                .file_name()
                .to_str()
                .map(|name| skip.contains(&name))
                .unwrap_or(false)
        })
        .build()
}

/// 递归遍历目录：gitignore 感知 + 排除式 glob + 跳过非源码目录 + 正例 glob 过滤
///
/// 判定优先级：excludeGlobs（排除式 glob）→ SKIP_DIRS（内置目录）→ 正例 glob
fn walk_files(
    root: &Path,
    glob: Option<&str>,
    excludes: &[String],
    max_files: u64,
) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let walker = walker_for_root(root, MAX_WALK_DEPTH, SKIP_DIRS);
    for entry in walker.flatten() {
        if files.len() as u64 >= max_files {
            break;
        }
        if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
            continue;
        }
        let path = entry.path();
        // 相对路径统一 / 分隔符（glob 判定用）
        let rel = path.strip_prefix(root).unwrap_or(path);
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        // 排除式 glob：命中即跳过（优先级最高，先于内置目录与正例 glob）
        if excludes.iter().any(|pattern| {
            if pattern.contains('/') {
                glob_match(pattern, &rel_str)
            } else {
                glob_match(pattern, rel_str.rsplit('/').next().unwrap_or(&rel_str))
            }
        }) {
            continue;
        }
        // SKIP_DIRS 剪枝已由 walker_for_root 的 filter_entry 完成
        // （原逐文件组件检查下沉到目录级，行为等价且更省 IO）
        if let Some(pattern) = glob {
            let matched = if pattern.contains('/') {
                glob_match(pattern, &rel_str)
            } else {
                glob_match(pattern, rel_str.rsplit('/').next().unwrap_or(&rel_str))
            };
            if !matched {
                continue;
            }
        }
        files.push(path.to_path_buf());
    }
    files
}

/// 简易 glob 匹配：`*` 不跨路径分隔符，`**` 可跨，`?` 匹配单字符（不跨分隔符）
pub(crate) fn glob_match(pattern: &str, path: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = path.chars().collect();
    let n = p.len();
    let m = t.len();
    let mut dp = vec![vec![false; m + 1]; n + 1];
    dp[0][0] = true;
    for i in 1..=n {
        if p[i - 1] == '*' {
            dp[i][0] = dp[i - 1][0];
        }
    }
    for i in 1..=n {
        for j in 1..=m {
            let pc = p[i - 1];
            dp[i][j] = if pc == '*' {
                // ** 可跨分隔符；单 * 不跨
                let double = i >= 2 && p[i - 2] == '*';
                dp[i - 1][j] || dp[i][j - 1] && (double || t[j - 1] != '/')
            } else if pc == '?' {
                dp[i - 1][j - 1] && t[j - 1] != '/'
            } else {
                dp[i - 1][j - 1] && pc == t[j - 1]
            };
        }
    }
    dp[n][m]
}

/// 模糊文件查找工具：复用 conex-search 目录索引 + 模糊打分
pub(crate) struct FuzzyFindTool {
    def: ToolDefinition,
}

impl FuzzyFindTool {
    pub(crate) fn new() -> Self {
        Self {
            def: ToolDefinition {
                name: "fuzzy_find".to_string(),
                description: "按文件名模糊匹配查找工作区文件（子序列打分），返回候选文件列表。"
                    .to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "文件名模糊查询串" },
                        "path": { "type": "string", "description": "搜索根目录，缺省为工作区根" },
                        "limit": { "type": "number", "description": "返回候选数上限，默认 20" },
                        "caseSensitive": { "type": "boolean", "description": "是否大小写敏感，缺省 false" }
                    },
                    "required": ["query"],
                    "additionalProperties": false
                }),
                dangerous: false,
                fatal_on_error: false,
            },
        }
    }
}

#[async_trait]
impl Tool for FuzzyFindTool {
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
        let query = require_string(&args, "query")?;
        let path_str = optional_string(&args, "path").unwrap_or_else(|| ".".to_string());
        let root = resolve_workspace_path(&ctx.workspace_root, &path_str)?;
        let limit = optional_u64(&args, "limit").unwrap_or(20).min(100) as usize;
        let case_sensitive = optional_bool(&args, "caseSensitive").unwrap_or(false);

        let root_str = root.to_string_lossy().into_owned();
        // U-BLOCK：目录索引 + 模糊搜索经 spawn_blocking
        let (indexed_len, hits) = {
            let query = query.clone();
            let root_str = root_str.clone();
            tokio::task::spawn_blocking(move || {
                let indexed = conex_search::walker::build_directory_index(&root_str);
                let matcher = conex_search::fuzzy::FuzzyMatcher::new(case_sensitive);
                let hits = conex_search::search::search_files(&query, &indexed, limit, &matcher);
                (indexed.len(), hits)
            })
            .await
            .map_err(|e| {
                ToolError::execution_failed("fuzzy_find", format!("spawn_blocking: {e}"))
            })?
        };

        let root_display = display_path(&root, &root);
        let items: Vec<serde_json::Value> = hits
            .iter()
            .map(|hit| {
                serde_json::json!({
                    "path": display_path(&root, Path::new(&hit.path)),
                    "score": hit.score,
                    "matchIndices": hit.match_indices,
                })
            })
            .collect();
        let text = if items.is_empty() {
            format!("(no fuzzy matches for {query:?})")
        } else {
            items
                .iter()
                .map(|i| format!("{} {}", i["score"], i["path"]))
                .collect::<Vec<_>>()
                .join("\n")
        };
        Ok(serde_json::json!({
            "query": query,
            "root": root_display,
            "limit": limit,
            "indexedFiles": indexed_len,
            "hits": items,
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

    fn sample_workspace() -> TempWorkspace {
        let ws = TempWorkspace::new("search");
        ws.write_file(
            "src/main.rs",
            "fn main() {\n    let needle = 42;\n    println!(\"needle found\");\n}\n",
        );
        ws.write_file("src/lib.rs", "pub fn helper() {\n    needle\n}\n");
        ws.write_file("README.md", "no match here\n");
        ws.write_file("node_modules/pkg/index.js", "needle in node_modules\n");
        ws.write_file(".git/objects/abc", "needle in git\n");
        ws.write_file("src/data.json", "{\"key\": \"needle\"}\n");
        ws
    }

    #[tokio::test]
    async fn grep_finds_matches_with_line_column() {
        let ws = sample_workspace();
        let tool = GrepSearchTool::new();
        let out = tool
            .execute(&mock_ctx(&ws), json!({ "query": "needle" }))
            .await
            .unwrap();
        // main.rs 命中 2 行 + lib.rs 1 行 + data.json 1 行 = 4
        assert_eq!(out["matchCount"], 4);
        assert_eq!(out["visitedFiles"], 4);
        assert_eq!(out["truncated"], false);
        let matches = out["matches"].as_array().unwrap();
        // node_modules 与 .git 被排除
        assert!(matches.iter().all(|m| {
            let p = m["path"].as_str().unwrap();
            !p.contains("node_modules") && !p.contains(".git")
        }));
        // 命中集合：main.rs 第 2/3 行、lib.rs 第 2 行、data.json 第 1 行
        let keys: Vec<(String, usize)> = matches
            .iter()
            .map(|m| {
                (
                    m["path"].as_str().unwrap().to_string(),
                    m["line"].as_u64().unwrap() as usize,
                )
            })
            .collect();
        assert!(keys.contains(&("src/main.rs".to_string(), 2)));
        assert!(keys.contains(&("src/main.rs".to_string(), 3)));
        assert!(keys.contains(&("src/lib.rs".to_string(), 2)));
        assert!(keys.contains(&("src/data.json".to_string(), 1)));
        // 行内列号：main.rs 第 2 行 "    let needle = 42;" 中 needle 从第 9 字符开始
        let main2 = matches
            .iter()
            .find(|m| m["path"] == "src/main.rs" && m["line"] == 2)
            .unwrap();
        assert_eq!(main2["column"], 9);
        assert!(main2["text"].as_str().unwrap().contains("needle"));
    }

    #[tokio::test]
    async fn grep_regex_mode_and_case_sensitive() {
        let ws = sample_workspace();
        let tool = GrepSearchTool::new();
        let out = tool
            .execute(
                &mock_ctx(&ws),
                json!({ "query": r"needle\s+found", "regex": true }),
            )
            .await
            .unwrap();
        assert_eq!(out["matchCount"], 1);
        assert_eq!(out["matches"][0]["path"], "src/main.rs");
        assert_eq!(out["matches"][0]["line"], 3);
        // 大小写敏感：大写 NEEDLE 无命中
        let out = tool
            .execute(&mock_ctx(&ws), json!({ "query": "NEEDLE" }))
            .await
            .unwrap();
        assert_eq!(out["matchCount"], 0);
        // 大小写不敏感模式有命中
        let out = tool
            .execute(
                &mock_ctx(&ws),
                json!({ "query": "needle", "caseSensitive": false }),
            )
            .await
            .unwrap();
        assert_eq!(out["matchCount"], 4);
    }

    #[tokio::test]
    async fn grep_glob_filter_limits_to_rust_files() {
        let ws = sample_workspace();
        let tool = GrepSearchTool::new();
        let out = tool
            .execute(&mock_ctx(&ws), json!({ "query": "needle", "glob": "*.rs" }))
            .await
            .unwrap();
        // main.rs 2 行 + lib.rs 1 行 = 3
        assert_eq!(out["matchCount"], 3);
        for m in out["matches"].as_array().unwrap() {
            assert!(m["path"].as_str().unwrap().ends_with(".rs"));
        }
    }

    #[tokio::test]
    async fn grep_glob_with_directory_pattern() {
        let ws = sample_workspace();
        let tool = GrepSearchTool::new();
        let out = tool
            .execute(
                &mock_ctx(&ws),
                json!({ "query": "needle", "glob": "src/**" }),
            )
            .await
            .unwrap();
        // src 下全部命中：main.rs 2 + lib.rs 1 + data.json 1 = 4
        assert_eq!(out["matchCount"], 4);
    }

    #[tokio::test]
    async fn grep_max_matches_truncates() {
        let ws = TempWorkspace::new("search_trunc");
        for i in 0..10 {
            ws.write_file(&format!("f{i}.txt"), "needle\n");
        }
        let tool = GrepSearchTool::new();
        let out = tool
            .execute(
                &mock_ctx(&ws),
                json!({ "query": "needle", "maxMatches": 3 }),
            )
            .await
            .unwrap();
        assert_eq!(out["matchCount"], 3);
        assert_eq!(out["truncated"], true);
    }

    #[tokio::test]
    async fn grep_invalid_regex_errors() {
        let ws = TempWorkspace::new("search_re");
        let tool = GrepSearchTool::new();
        let err = tool
            .execute(&mock_ctx(&ws), json!({ "query": "([", "regex": true }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("invalid regex"));
    }

    #[tokio::test]
    async fn fuzzy_find_returns_ranked_candidates() {
        let ws = sample_workspace();
        let tool = FuzzyFindTool::new();
        let out = tool
            .execute(&mock_ctx(&ws), json!({ "query": "main", "limit": 5 }))
            .await
            .unwrap();
        let hits = out["hits"].as_array().unwrap();
        assert!(!hits.is_empty());
        assert!(hits.iter().any(|h| h["path"] == "src/main.rs"));
        // 分数降序
        for w in hits.windows(2) {
            assert!(w[0]["score"].as_i64().unwrap() >= w[1]["score"].as_i64().unwrap());
        }
    }

    #[tokio::test]
    async fn fuzzy_find_no_match_returns_empty() {
        let ws = TempWorkspace::new("search_none");
        ws.write_file("a.txt", "x");
        let tool = FuzzyFindTool::new();
        let out = tool
            .execute(&mock_ctx(&ws), json!({ "query": "zzz" }))
            .await
            .unwrap();
        assert_eq!(out["hits"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn glob_matcher_cases() {
        // 无分隔符模式匹配文件名
        assert!(glob_match("*.rs", "main.rs"));
        assert!(!glob_match("*.rs", "main.txt"));
        assert!(glob_match("?at", "cat"));
        assert!(!glob_match("?at", "chat"));
        assert!(!glob_match("a*b", "abx"));
        assert!(glob_match("a*b", "ab"));
        assert!(glob_match("*", "anything"));
        // 单 * 不跨分隔符；** 可跨
        assert!(!glob_match("*.rs", "nested/deep/main.rs"));
        assert!(glob_match("**/*.rs", "nested/deep/main.rs"));
        assert!(glob_match("src/**", "src/a/b.rs"));
        assert!(!glob_match("src/**", "lib/a.rs"));
        assert!(glob_match("**/*.test.ts", "src/nested/a.test.ts"));
        // 首尾边界
        assert!(glob_match("**", "anything/at/all"));
        assert!(!glob_match("*.rs", "main.txt/extra"));
    }

    #[test]
    fn walk_files_skips_forbidden_dirs() {
        let ws = TempWorkspace::new("search_walk");
        ws.write_file("a.txt", "x");
        ws.write_file("node_modules/b.txt", "x");
        ws.write_file(".git/c.txt", "x");
        let files = walk_files(ws.path(), None, &[], 100);
        let names: Vec<String> = files
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["a.txt"]);
    }

    #[tokio::test]
    async fn grep_file_level_returns_unique_files() {
        let ws = TempWorkspace::new("search_file_level");
        ws.write_file("a.txt", "needle one\nneedle two\nplain\n");
        ws.write_file("b.txt", "needle only once\n");
        ws.write_file("c.txt", "nothing here\n");
        let tool = GrepSearchTool::new();
        let out = tool
            .execute(
                &mock_ctx(&ws),
                json!({ "query": "needle", "matchPerLine": false }),
            )
            .await
            .unwrap();
        // 同文件多命中只出现一次：a.txt（2 行）+ b.txt（1 行）= 2 个文件
        assert_eq!(out["matchCount"], 2);
        let files = out["files"].as_array().unwrap();
        assert_eq!(files.len(), 2);
        // matches 置空数组
        assert_eq!(out["matches"].as_array().unwrap().len(), 0);
        assert_eq!(out["truncated"], false);
        // 去重且 matchCount 为真实命中行数
        let a = files.iter().find(|f| f["path"] == "a.txt").unwrap();
        assert_eq!(a["matchCount"], 2);
        let b = files.iter().find(|f| f["path"] == "b.txt").unwrap();
        assert_eq!(b["matchCount"], 1);
        assert!(files.iter().all(|f| f["path"] != "c.txt"));
    }

    #[tokio::test]
    async fn grep_file_level_shares_max_matches() {
        let ws = TempWorkspace::new("search_file_lim");
        for i in 0..5 {
            ws.write_file(&format!("f{i}.txt"), "needle\nneedle again\n");
        }
        let tool = GrepSearchTool::new();
        let out = tool
            .execute(
                &mock_ctx(&ws),
                json!({ "query": "needle", "matchPerLine": false, "maxMatches": 2 }),
            )
            .await
            .unwrap();
        // 文件级按文件数计上限：只返回 2 个文件且置 truncated
        assert_eq!(out["matchCount"], 2);
        assert_eq!(out["files"].as_array().unwrap().len(), 2);
        assert_eq!(out["truncated"], true);
    }

    #[tokio::test]
    async fn grep_exclude_globs_filtered() {
        let ws = TempWorkspace::new("search_exclude");
        ws.write_file("src/generated/gen.rs", "needle\n");
        ws.write_file("src/keep.rs", "needle\n");
        ws.write_file("src/normal.txt", "needle\n");
        let tool = GrepSearchTool::new();
        let out = tool
            .execute(
                &mock_ctx(&ws),
                json!({ "query": "needle", "excludeGlobs": ["**/generated/*.rs"] }),
            )
            .await
            .unwrap();
        let paths: Vec<&str> = out["matches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["path"].as_str().unwrap())
            .collect();
        // generated 目录被排除，同根其他文件正常
        assert!(!paths.iter().any(|p| p.contains("generated")));
        assert!(paths.contains(&"src/keep.rs"));
        assert!(paths.contains(&"src/normal.txt"));
        assert_eq!(out["matchCount"], 2);
    }

    #[tokio::test]
    async fn grep_truncated_hint_present() {
        let ws = TempWorkspace::new("search_hint");
        for i in 0..5 {
            ws.write_file(&format!("f{i}.txt"), "needle\n");
        }
        let tool = GrepSearchTool::new();
        let out = tool
            .execute(
                &mock_ctx(&ws),
                json!({ "query": "needle", "maxMatches": 1 }),
            )
            .await
            .unwrap();
        assert_eq!(out["truncated"], true);
        let text = out["text"].as_str().unwrap();
        assert!(text.contains("结果已达上限，请缩小搜索范围或增加 maxMatches"));
    }

    #[tokio::test]
    async fn grep_skip_dirs_still_active() {
        let ws = TempWorkspace::new("search_skip_dirs");
        ws.write_file("src/a.rs", "needle\n");
        ws.write_file("node_modules/pkg/index.js", "needle\n");
        ws.write_file("src/generated/gen.rs", "needle\n");
        let tool = GrepSearchTool::new();
        let out = tool
            .execute(
                &mock_ctx(&ws),
                json!({ "query": "needle", "excludeGlobs": ["**/generated/*.rs"] }),
            )
            .await
            .unwrap();
        let paths: Vec<&str> = out["matches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["path"].as_str().unwrap())
            .collect();
        // 排除 glob 与 SKIP_DIRS 双过滤：node_modules 与 generated 均不出现
        assert_eq!(paths, vec!["src/a.rs"]);
    }
}
