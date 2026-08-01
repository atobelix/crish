//! 搜索工具（任务书 B5.2：grep_search / fuzzy_find）
//!
//! - grep_search：目录递归文本搜索（子串或正则），支持 glob 过滤，
//!   默认排除 .git / node_modules 等非源码目录，返回 path/line/column/text
//! - fuzzy_find：模糊文件名查找，复用 conex-search 的模糊匹配与目录索引

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
const DEFAULT_MAX_FILE_BYTES: u64 = 512_000;
/// 递归深度上限
const MAX_WALK_DEPTH: usize = 16;

/// 默认排除的非源码目录（与 conex-search walker 的 SKIP_DIRS 一致）
const SKIP_DIRS: &[&str] = &[
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

/// grep 文本搜索工具
pub(crate) struct GrepSearchTool {
    def: ToolDefinition,
    workspace_root: PathBuf,
}

impl GrepSearchTool {
    pub(crate) fn new(workspace_root: PathBuf) -> Self {
        Self {
            def: ToolDefinition {
                name: "grep_search".to_string(),
                description: "在工作区目录内递归搜索文本（子串或正则），支持 glob 过滤，默认排除 .git/node_modules 等目录。".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "搜索文本或正则表达式" },
                        "path": { "type": "string", "description": "搜索根目录，缺省为工作区根" },
                        "regex": { "type": "boolean", "description": "query 是否按正则解释，缺省 false" },
                        "glob": { "type": "string", "description": "glob 过滤（如 *.rs、src/**），只匹配符合的文件" },
                        "caseSensitive": { "type": "boolean", "description": "子串模式是否大小写敏感，缺省 true" },
                        "maxMatches": { "type": "number", "description": "最大返回匹配数，默认 200" },
                        "maxFiles": { "type": "number", "description": "最大访问文件数，默认 2000" },
                        "maxFileBytes": { "type": "number", "description": "单个文件参与搜索的大小上限（字节），默认 512000" }
                    },
                    "required": ["query"],
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
impl Tool for GrepSearchTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, args: serde_json::Value) -> Result<serde_json::Value, ToolError> {
        let query = require_string(&args, "query")?;
        let path_str = optional_string(&args, "path").unwrap_or_else(|| ".".to_string());
        let root = resolve_workspace_path(&self.workspace_root, &path_str)?;
        let use_regex = optional_bool(&args, "regex").unwrap_or(false);
        let glob = optional_string(&args, "glob");
        let case_sensitive = optional_bool(&args, "caseSensitive").unwrap_or(true);
        let max_matches = optional_u64(&args, "maxMatches").unwrap_or(DEFAULT_MAX_MATCHES);
        let max_files = optional_u64(&args, "maxFiles").unwrap_or(DEFAULT_MAX_FILES);
        let max_file_bytes = optional_u64(&args, "maxFileBytes").unwrap_or(DEFAULT_MAX_FILE_BYTES);

        // 正则编译失败按入参非法处理（对齐 TS new RegExp 抛错语义）
        let matcher = if use_regex {
            Some(
                regex::Regex::new(&query)
                    .map_err(|e| ToolError::invalid_input(format!("invalid regex: {e}")))?,
            )
        } else {
            None
        };

        let root_display = display_path(&root, &root);
        let mut matches: Vec<GrepMatch> = Vec::new();
        let mut visited_files: u64 = 0;
        let mut truncated = false;

        for file in walk_files(&root, glob.as_deref(), max_files) {
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
                continue; // 二进制文件跳过
            }
            let text = String::from_utf8_lossy(&bytes);
            let display = display_path(&root, &file);
            for (idx, raw_line) in text.split('\n').enumerate() {
                let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
                let hit = if let Some(re) = &matcher {
                    re.find(line).map(|m| (m.start(), m.end() - m.start()))
                } else if case_sensitive {
                    line.find(&query).map(|s| (s, query.len()))
                } else {
                    line.to_lowercase()
                        .find(&query.to_lowercase())
                        .map(|s| (s, query.len()))
                };
                if let Some((byte_offset, _)) = hit {
                    matches.push(GrepMatch {
                        path: display.clone(),
                        line: idx + 1,
                        column: line[..byte_offset.min(line.len())].chars().count() + 1,
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
        }

        let header = format!(
            "query: {query}\nroot: {root_display}\nmatches: {}\nvisitedFiles: {visited_files}\n{}---",
            matches.len(),
            if truncated { "truncated: true\n" } else { "" },
        );
        let body = if matches.is_empty() {
            "(no matches)".to_string()
        } else {
            matches
                .iter()
                .map(|m| format!("{}:{}:{}: {}", m.path, m.line, m.column, m.text))
                .collect::<Vec<_>>()
                .join("\n")
        };

        Ok(serde_json::json!({
            "query": query,
            "root": root_display,
            "visitedFiles": visited_files,
            "matchCount": matches.len(),
            "truncated": truncated,
            "matches": matches,
            "text": format!("{header}\n{body}"),
        }))
    }
}

/// 递归遍历目录：gitignore 感知 + 跳过非源码目录 + glob 过滤
fn walk_files(root: &Path, glob: Option<&str>, max_files: u64) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let walker = WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .max_depth(Some(MAX_WALK_DEPTH))
        .build();
    for entry in walker.flatten() {
        if files.len() as u64 >= max_files {
            break;
        }
        if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
            continue;
        }
        let path = entry.path();
        let skip = path.components().any(|comp| {
            comp.as_os_str()
                .to_str()
                .map(|s| SKIP_DIRS.contains(&s))
                .unwrap_or(false)
        });
        if skip {
            continue;
        }
        if let Some(pattern) = glob {
            let rel = path.strip_prefix(root).unwrap_or(path);
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            let matched = if pattern.contains('/') {
                glob_match(pattern, &rel_str)
            } else {
                glob_match(
                    pattern,
                    rel_str.rsplit('/').next().unwrap_or(&rel_str),
                )
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
    workspace_root: PathBuf,
}

impl FuzzyFindTool {
    pub(crate) fn new(workspace_root: PathBuf) -> Self {
        Self {
            def: ToolDefinition {
                name: "fuzzy_find".to_string(),
                description: "按文件名模糊匹配查找工作区文件（子序列打分），返回候选文件列表。".to_string(),
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
            workspace_root,
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

    async fn execute(&self, args: serde_json::Value) -> Result<serde_json::Value, ToolError> {
        let query = require_string(&args, "query")?;
        let path_str = optional_string(&args, "path").unwrap_or_else(|| ".".to_string());
        let root = resolve_workspace_path(&self.workspace_root, &path_str)?;
        let limit = optional_u64(&args, "limit")
            .unwrap_or(20)
            .min(100) as usize;
        let case_sensitive = optional_bool(&args, "caseSensitive").unwrap_or(false);

        let root_str = root.to_string_lossy().into_owned();
        let indexed = conex_search::walker::build_directory_index(&root_str);
        let matcher = conex_search::fuzzy::FuzzyMatcher::new(case_sensitive);
        let hits = conex_search::search::search_files(&query, &indexed, limit, &matcher);

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
            "indexedFiles": indexed.len(),
            "hits": items,
            "text": text,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_test_utils::TempWorkspace;
    use serde_json::json;

    fn sample_workspace() -> TempWorkspace {
        let ws = TempWorkspace::new("search");
        ws.write_file("src/main.rs", "fn main() {\n    let needle = 42;\n    println!(\"needle found\");\n}\n");
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
        let tool = GrepSearchTool::new(ws.path().clone());
        let out = tool.execute(json!({ "query": "needle" })).await.unwrap();
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
        let tool = GrepSearchTool::new(ws.path().clone());
        let out = tool
            .execute(json!({ "query": r"needle\s+found", "regex": true }))
            .await
            .unwrap();
        assert_eq!(out["matchCount"], 1);
        assert_eq!(out["matches"][0]["path"], "src/main.rs");
        assert_eq!(out["matches"][0]["line"], 3);
        // 大小写敏感：大写 NEEDLE 无命中
        let out = tool
            .execute(json!({ "query": "NEEDLE" }))
            .await
            .unwrap();
        assert_eq!(out["matchCount"], 0);
        // 大小写不敏感模式有命中
        let out = tool
            .execute(json!({ "query": "needle", "caseSensitive": false }))
            .await
            .unwrap();
        assert_eq!(out["matchCount"], 4);
    }

    #[tokio::test]
    async fn grep_glob_filter_limits_to_rust_files() {
        let ws = sample_workspace();
        let tool = GrepSearchTool::new(ws.path().clone());
        let out = tool
            .execute(json!({ "query": "needle", "glob": "*.rs" }))
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
        let tool = GrepSearchTool::new(ws.path().clone());
        let out = tool
            .execute(json!({ "query": "needle", "glob": "src/**" }))
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
        let tool = GrepSearchTool::new(ws.path().clone());
        let out = tool
            .execute(json!({ "query": "needle", "maxMatches": 3 }))
            .await
            .unwrap();
        assert_eq!(out["matchCount"], 3);
        assert_eq!(out["truncated"], true);
    }

    #[tokio::test]
    async fn grep_invalid_regex_errors() {
        let ws = TempWorkspace::new("search_re");
        let tool = GrepSearchTool::new(ws.path().clone());
        let err = tool
            .execute(json!({ "query": "([", "regex": true }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("invalid regex"));
    }

    #[tokio::test]
    async fn fuzzy_find_returns_ranked_candidates() {
        let ws = sample_workspace();
        let tool = FuzzyFindTool::new(ws.path().clone());
        let out = tool
            .execute(json!({ "query": "main", "limit": 5 }))
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
        let tool = FuzzyFindTool::new(ws.path().clone());
        let out = tool
            .execute(json!({ "query": "zzz" }))
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
        let files = walk_files(ws.path(), None, 100);
        let names: Vec<String> = files
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["a.txt"]);
    }
}
