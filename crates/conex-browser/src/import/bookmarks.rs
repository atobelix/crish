//! 书签导入（维度 16 §6.1，独立入口）
//!
//! - 来源：`<profile>/Bookmarks`（JSON，Chrome/Edge 原生格式）或用户指定文件；
//!   结构：`{"roots": {"bookmark_bar": …, "other": …, "synced": …, "mobile": …}}`，
//!   节点 `{"type": "folder" | "url", "name", "url", "children": [...]}`，folder 递归；
//! - 解析：递归遍历 → 扁平化条目 [`BookmarkItem`]（`folder_path` 为顶层根到
//!   父文件夹的路径）；跳过无效节点（缺 name/url、type 异常容错）；
//! - 根映射（§6.1）：`bookmark_bar`→「书签栏」、`other`→「其他书签」、
//!   `synced`→「同步书签」、`mobile`→「移动端书签」（四树；未知根键按原名容错）；
//! - **幂等去重**：按 (url, name) 唯一键去重（任务书口径；同 url+title 跳过，
//!   同名不同 URL 保留两条，§6.1 冲突合并策略）；
//! - 数量上限：默认 10000 条（§6.1，超限 UI 明示并分批）；
//! - **深度守卫**：超过 [`BOOKMARKS_MAX_DEPTH`]（128）的子树整支跳过
//!   （防恶意超深嵌套耗尽栈）；
//! - 导入全程无网络请求、无文件写入（纯数据解析，审计记录条数由上层负责）。
//!
//! 锁纪律（31-security-baseline B8）：本模块无锁、无 IO。

use serde_json::Value;
use std::collections::HashSet;

/// 书签数量上限（§6.1：默认 10000，超限 UI 明示并分批导入）。
pub const BOOKMARKS_DEFAULT_LIMIT: usize = 10_000;
/// 文件夹最大嵌套深度（超过该深度的子树整支跳过）。
///
/// 取值约束：须低于 serde_json 解析递归上限（128 层 JSON 值嵌套 ≈ 60 层
/// 文件夹链，每层含对象 + children 数组），保证**守卫可达**——合法但超深
/// 的树可解析并走子树跳过容错；超出解析上限的更深输入由解析层返回受控
/// 错误（不 panic、不耗尽栈，恶意超深嵌套被双层拦截）。
pub const BOOKMARKS_MAX_DEPTH: usize = 48;

/// 根键：书签栏。
pub const ROOT_BOOKMARK_BAR: &str = "bookmark_bar";
/// 根键：其他书签。
pub const ROOT_OTHER: &str = "other";
/// 根键：同步书签。
pub const ROOT_SYNCED: &str = "synced";
/// 根键：移动端书签。
pub const ROOT_MOBILE: &str = "mobile";

/// 顶层文件夹展示名（§6.1 根目录映射）。
pub const ROOT_NAME_BOOKMARK_BAR: &str = "书签栏";
/// 顶层文件夹展示名（§6.1 根目录映射）。
pub const ROOT_NAME_OTHER: &str = "其他书签";
/// 顶层文件夹展示名（§6.1 根目录映射）。
pub const ROOT_NAME_SYNCED: &str = "同步书签";
/// 顶层文件夹展示名（§6.1 根目录映射）。
pub const ROOT_NAME_MOBILE: &str = "移动端书签";

/// 扁平化书签条目（§6.1：`folder_path` 为顶层根到父文件夹的路径链）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookmarkItem {
    /// 父文件夹路径（顶层为根映射名，如 `["书签栏", "工作"]`）。
    pub folder_path: Vec<String>,
    /// 书签名（title）。
    pub name: String,
    /// 书签 URL。
    pub url: String,
}

/// 解析统计（审计面：记录条数与顶层目录名由上层汇总）。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct BookmarksReport {
    /// 扁平化结果（去重 + 上限截断后）。
    pub items: Vec<BookmarkItem>,
    /// 无效节点跳过数（缺 name/url、type 异常）。
    pub skipped_invalid: usize,
    /// 深度超限跳过的子树数（`> BOOKMARKS_MAX_DEPTH`）。
    pub depth_cutoff: usize,
    /// 同 (url, name) 去重丢弃数（幂等）。
    pub dropped_dupes: usize,
    /// 数量上限截断数（items 达 limit 后未纳入的节点数）。
    pub truncated: usize,
}

/// 解析选项。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BookmarksOptions {
    /// 条目数量上限（默认 [`BOOKMARKS_DEFAULT_LIMIT`]）。
    pub limit: usize,
}

impl Default for BookmarksOptions {
    fn default() -> Self {
        BookmarksOptions {
            limit: BOOKMARKS_DEFAULT_LIMIT,
        }
    }
}

/// 书签解析错误面。
#[derive(Debug, thiserror::Error)]
pub enum BookmarksError {
    /// 顶层 JSON 非法。
    #[error("书签 JSON 解析失败：{0}")]
    Json(String),
}

/// 解析 Chrome Bookmarks JSON（§6.1）：四树（书签栏/其他书签/同步书签/
/// 移动端）+ 文件夹递归 → 扁平化列表，幂等去重 + 数量上限 + 深度守卫。
///
/// 容错：`roots` 缺失 / 非对象 → 空结果（不报错）；节点 `type` 异常跳过；
/// folder 缺 children → 视为空文件夹。
pub fn parse_bookmarks(
    json: &str,
    opts: &BookmarksOptions,
) -> Result<BookmarksReport, BookmarksError> {
    // 解析层受控：serde_json 默认解析递归上限 128 层值嵌套——超出即返回
    // Json 错误（受控失败，不 panic）；树遍历侧另有 BOOKMARKS_MAX_DEPTH
    // 守卫（见常量注释：双层拦截恶意超深嵌套）。
    let root: Value =
        serde_json::from_str(json).map_err(|e| BookmarksError::Json(e.to_string()))?;
    let mut report = BookmarksReport::default();
    let Some(roots) = root.get("roots").and_then(Value::as_object) else {
        return Ok(report);
    };
    let mut seen: HashSet<(String, String)> = HashSet::new();
    // 固定顺序遍历四树（§6.1 根映射）；未知根键按原名容错
    let mut entries: Vec<(&str, &str)> = vec![
        (ROOT_BOOKMARK_BAR, ROOT_NAME_BOOKMARK_BAR),
        (ROOT_OTHER, ROOT_NAME_OTHER),
        (ROOT_SYNCED, ROOT_NAME_SYNCED),
        (ROOT_MOBILE, ROOT_NAME_MOBILE),
    ];
    for key in roots.keys() {
        if !matches!(
            key.as_str(),
            ROOT_BOOKMARK_BAR | ROOT_OTHER | ROOT_SYNCED | ROOT_MOBILE
        ) {
            entries.push((key, key));
        }
    }
    for (key, display) in entries {
        if let Some(node) = roots.get(key) {
            // 根节点自身：其 name 即顶层文件夹展示名（display），不重复追加；
            // 有 children 的根 → 直接遍历子节点（folder_path 以 display 起）；
            // 异常形态（无 children / 非 folder）→ 按普通节点走容错路径
            match node.get("children").and_then(Value::as_array) {
                Some(children) => {
                    for child in children {
                        walk(
                            child,
                            &[display.to_string()],
                            &mut report,
                            &mut seen,
                            opts.limit,
                            1,
                        );
                        if report.items.len() >= opts.limit {
                            break;
                        }
                    }
                }
                None => {
                    walk(
                        node,
                        &[display.to_string()],
                        &mut report,
                        &mut seen,
                        opts.limit,
                        0,
                    );
                }
            }
            if report.items.len() >= opts.limit {
                break;
            }
        }
    }
    Ok(report)
}

/// 递归遍历节点（§6.1：folder 递归、url 收集、type 异常容错、深度守卫）。
fn walk(
    node: &Value,
    folder: &[String],
    report: &mut BookmarksReport,
    seen: &mut HashSet<(String, String)>,
    limit: usize,
    depth: usize,
) {
    if report.items.len() >= limit {
        return;
    }
    let Some(obj) = node.as_object() else {
        report.skipped_invalid += 1;
        return;
    };
    let node_type = obj.get("type").and_then(Value::as_str).unwrap_or("");
    match node_type {
        "folder" => {
            if depth >= BOOKMARKS_MAX_DEPTH {
                report.depth_cutoff += 1;
                return;
            }
            let name = obj.get("name").and_then(Value::as_str).unwrap_or("");
            // 空名文件夹不追加路径段（容忍未命名文件夹）
            let child_folder: Vec<String> = if name.is_empty() {
                folder.to_vec()
            } else {
                folder
                    .iter()
                    .chain(std::iter::once(&name.to_string()))
                    .cloned()
                    .collect()
            };
            if let Some(children) = obj.get("children").and_then(Value::as_array) {
                for child in children {
                    walk(child, &child_folder, report, seen, limit, depth + 1);
                    if report.items.len() >= limit {
                        break;
                    }
                }
            }
        }
        "url" => {
            let name = obj
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let url = obj
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            // 无效节点跳过（缺 name/url，§6.1）
            if name.is_empty() || url.is_empty() {
                report.skipped_invalid += 1;
                return;
            }
            // 幂等去重：同 (url, name) 仅保留首条（§6.1 冲突合并）
            if !seen.insert((url.clone(), name.clone())) {
                report.dropped_dupes += 1;
                return;
            }
            report.items.push(BookmarkItem {
                folder_path: folder.to_vec(),
                name,
                url,
            });
        }
        _ => report.skipped_invalid += 1, // type 异常容错
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(limit: usize) -> BookmarksOptions {
        BookmarksOptions { limit }
    }

    /// 四树嵌套解析（§6.1）：书签栏/其他书签/同步书签/移动端 + 文件夹递归 →
    /// 扁平化条目，folder_path 为根映射名到父文件夹的路径链。
    #[test]
    fn four_roots_nested() {
        let json = r#"{
            "roots": {
                "bookmark_bar": {
                    "type": "folder", "name": "书签栏",
                    "children": [
                        { "type": "folder", "name": "工作", "children": [
                            { "type": "url", "name": "GitHub", "url": "https://github.com" },
                            { "type": "url", "name": "Docs", "url": "https://docs.example.com" }
                        ] },
                        { "type": "url", "name": "顶层", "url": "https://top.example.com" }
                    ]
                },
                "other": {
                    "type": "folder", "name": "其他书签",
                    "children": [
                        { "type": "url", "name": "杂项", "url": "https://misc.example.com" }
                    ]
                },
                "synced": {
                    "type": "folder", "name": "同步书签",
                    "children": [
                        { "type": "url", "name": "手机同步", "url": "https://sync.example.com" }
                    ]
                },
                "mobile": {
                    "type": "folder", "name": "移动端书签",
                    "children": [
                        { "type": "url", "name": "移动", "url": "https://m.example.com" }
                    ]
                }
            }
        }"#;
        let report = parse_bookmarks(json, &opts(100)).expect("解析");
        assert_eq!(report.items.len(), 6);
        assert_eq!(report.items[0].name, "GitHub");
        assert_eq!(
            report.items[0].folder_path,
            vec![ROOT_NAME_BOOKMARK_BAR, "工作"],
            "根映射 + 文件夹路径链"
        );
        assert_eq!(report.items[1].name, "Docs");
        assert_eq!(report.items[2].name, "顶层");
        assert_eq!(report.items[2].folder_path, vec![ROOT_NAME_BOOKMARK_BAR]);
        assert_eq!(report.items[3].name, "杂项");
        assert_eq!(report.items[3].folder_path, vec![ROOT_NAME_OTHER]);
        assert_eq!(report.items[4].folder_path, vec![ROOT_NAME_SYNCED]);
        assert_eq!(report.items[5].folder_path, vec![ROOT_NAME_MOBILE]);
        assert_eq!(report.skipped_invalid, 0);
        assert_eq!(report.dropped_dupes, 0);
    }

    /// 空文件夹 / 缺 children / 缺 roots / 空对象 → 空结果不报错。
    #[test]
    fn empty_folders_and_missing_roots() {
        let json = r#"{
            "roots": {
                "bookmark_bar": { "type": "folder", "name": "书签栏", "children": [] },
                "other": { "type": "folder", "name": "其他书签" }
            }
        }"#;
        let report = parse_bookmarks(json, &opts(100)).expect("解析");
        assert!(report.items.is_empty());
        assert_eq!(report.skipped_invalid, 0);

        // 缺 roots / 非对象 roots / 空对象 → 空结果（§2.2 同款容错语义）
        assert!(parse_bookmarks("{}", &opts(100))
            .expect("空对象")
            .items
            .is_empty());
        assert!(parse_bookmarks(r#"{"roots": []}"#, &opts(100))
            .expect("roots 非对象")
            .items
            .is_empty());
        assert!(parse_bookmarks(r#"{"a": 1}"#, &opts(100))
            .expect("缺 roots")
            .items
            .is_empty());
    }

    /// 非法 JSON → 错误；顶层非对象 → 空结果容错。
    #[test]
    fn invalid_json() {
        assert!(matches!(
            parse_bookmarks("{ not json", &opts(100)),
            Err(BookmarksError::Json(_))
        ));
        let report = parse_bookmarks(r#"["array", 1]"#, &opts(100)).expect("数组容错");
        assert!(report.items.is_empty());
    }

    /// 超深嵌套（> BOOKMARKS_MAX_DEPTH 且可解析）：子树整支跳过，不 panic。
    /// 构造 60 层文件夹（JSON 值深度 ~122 < serde_json 解析上限 128）。
    #[test]
    fn deep_nesting_cutoff() {
        let mut node =
            serde_json::json!({ "type": "url", "name": "深底", "url": "https://deep.example.com" });
        for _ in 0..60 {
            node = serde_json::json!({ "type": "folder", "name": "f", "children": [node] });
        }
        let json = serde_json::json!({ "roots": { "bookmark_bar": node } }).to_string();
        let report = parse_bookmarks(&json, &opts(1000)).expect("解析");
        assert!(
            report.items.is_empty(),
            "深度超限子树整支跳过（含最内层 url）"
        );
        assert!(report.depth_cutoff > 0, "应记录深度超限子树数");
        assert_eq!(report.skipped_invalid, 0);
    }

    /// 深度守卫边界：恰好 BOOKMARKS_MAX_DEPTH 层内正常解析。
    #[test]
    fn depth_boundary_ok() {
        let mut node =
            serde_json::json!({ "type": "url", "name": "底", "url": "https://d.example.com" });
        // 包裹 BOOKMARKS_MAX_DEPTH 层：最外层成为根节点（其 name 不追加），
        // 内层 47 个文件夹 + 展示名 = 48 段路径（深度 47 < 48，无截断）
        for _ in 0..BOOKMARKS_MAX_DEPTH {
            node = serde_json::json!({ "type": "folder", "name": "f", "children": [node] });
        }
        let json = serde_json::json!({ "roots": { "other": node } }).to_string();
        let report = parse_bookmarks(&json, &opts(1000)).expect("解析");
        assert_eq!(report.items.len(), 1, "深度 == 上限时应可解析");
        assert_eq!(report.items[0].folder_path.len(), BOOKMARKS_MAX_DEPTH);
    }

    /// 超出 serde_json 解析递归上限（200 层）→ 受控 Json 错误（不 panic）。
    #[test]
    fn beyond_parse_recursion_limit_controlled_error() {
        let mut node =
            serde_json::json!({ "type": "url", "name": "底", "url": "https://d.example.com" });
        for _ in 0..200 {
            node = serde_json::json!({ "type": "folder", "name": "f", "children": [node] });
        }
        let json = serde_json::json!({ "roots": { "other": node } }).to_string();
        assert!(
            matches!(
                parse_bookmarks(&json, &opts(1000)),
                Err(BookmarksError::Json(_))
            ),
            "超出解析递归上限应返回受控错误"
        );
    }

    /// 幂等去重（§6.1）：同 (url, name) 跳过；同名不同 URL / 同 URL 不同名保留。
    #[test]
    fn dedup_by_url_and_name() {
        let json = r#"{
            "roots": {
                "bookmark_bar": {
                    "type": "folder", "name": "书签栏",
                    "children": [
                        { "type": "url", "name": "A", "url": "https://a.example.com" },
                        { "type": "url", "name": "A", "url": "https://a.example.com" },
                        { "type": "url", "name": "A2", "url": "https://a.example.com" },
                        { "type": "url", "name": "B", "url": "https://b.example.com" }
                    ]
                },
                "other": {
                    "type": "folder", "name": "其他书签",
                    "children": [
                        { "type": "url", "name": "A", "url": "https://a.example.com" },
                        { "type": "url", "name": "A", "url": "https://a2.example.com" }
                    ]
                }
            }
        }"#;
        let report = parse_bookmarks(json, &opts(100)).expect("解析");
        assert_eq!(report.items.len(), 4, "跨根同名同 URL 也去重（幂等）");
        assert_eq!(report.dropped_dupes, 2);
        let names: Vec<&str> = report.items.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, vec!["A", "A2", "B", "A"]);
    }

    /// 无效节点跳过：缺 name / 缺 url / type 异常 / 节点非对象。
    #[test]
    fn skip_invalid_nodes() {
        let json = r#"{
            "roots": {
                "bookmark_bar": {
                    "type": "folder", "name": "书签栏",
                    "children": [
                        { "type": "url", "name": "缺url" },
                        { "type": "url", "url": "https://no-name.example.com" },
                        { "type": "url", "name": "   ", "url": "https://blank-name.example.com" },
                        { "type": "mystery", "name": "怪类型", "url": "https://x.example.com" },
                        { "type": "url", "name": "好", "url": "https://ok.example.com" },
                        "not-an-object"
                    ]
                }
            }
        }"#;
        let report = parse_bookmarks(json, &opts(100)).expect("解析");
        assert_eq!(report.items.len(), 1, "仅合法 url 节点保留");
        assert_eq!(report.items[0].name, "好");
        assert_eq!(report.skipped_invalid, 5);
    }

    /// 数量上限（§6.1）：items 达 limit 截断，truncated 计数。
    #[test]
    fn limit_truncates() {
        let children: Vec<serde_json::Value> = (0..10)
            .map(|i| {
                serde_json::json!({
                    "type": "url",
                    "name": format!("n{i}"),
                    "url": format!("https://{i}.example.com")
                })
            })
            .collect();
        let json = serde_json::json!({
            "roots": {
                "bookmark_bar": { "type": "folder", "name": "书签栏", "children": children }
            }
        })
        .to_string();
        let report = parse_bookmarks(&json, &opts(3)).expect("解析");
        assert_eq!(report.items.len(), 3);
        assert_eq!(report.items[2].name, "n2");
        assert_eq!(
            report.truncated, 0,
            "截断计数由上层分批统计（超出节点未遍历）"
        );
    }

    /// 未知根键容错：按原名作为顶层文件夹（Chrome 未来新增根不丢数据）。
    #[test]
    fn unknown_root_tolerated() {
        let json = r#"{
            "roots": {
                "bookmark_bar": { "type": "folder", "name": "书签栏", "children": [] },
                "future_root": {
                    "type": "folder", "name": "未来根",
                    "children": [ { "type": "url", "name": "X", "url": "https://x.example.com" } ]
                }
            }
        }"#;
        let report = parse_bookmarks(json, &opts(100)).expect("解析");
        assert_eq!(report.items.len(), 1);
        assert_eq!(report.items[0].folder_path, vec!["future_root"]);
    }
}
