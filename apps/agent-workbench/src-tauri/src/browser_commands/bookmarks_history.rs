use super::common::{invalid_input, map_browser_err};
use crate::core_error::CoreError;
use conex_browser::import::bookmarks::{parse_bookmarks, persist_bookmarks, BookmarksOptions};
use conex_browser::import::history::{persist_history, read_history, HistoryOptions};
use serde::Serialize;
use std::path::Path;

// ---------------------------------------------------------------------------
// G-4 收尾：书签/历史导入命令（03-方案 §4.2 U4；落库编排见
// crate::browser_import_sinks——BookmarkSink/HistorySink → LocalDb 适配）
// ---------------------------------------------------------------------------

/// 来源标识：手工导入的书签（信息列不入主键，跨来源同键合并）。
const BOOKMARK_SOURCE: &str = "manual/bookmarks";
/// 来源标识：手工导入的历史（信息列不入主键）。
const HISTORY_SOURCE: &str = "manual/history";

/// 书签导入统计载荷（03-方案 §2.5：落库统计 + 解析侧报告原样透传）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BookmarksImportPayload {
    /// 新增落库条数（INSERT OR IGNORE 影响行数）。
    pub inserted: u64,
    /// 同 (url, name) 去重跳过条数（重复导入）。
    pub skipped_dupes: u64,
    /// 解析层扁平化条数（落库前，§6.1）。
    pub parsed_items: usize,
    /// 无效节点跳过数（缺 name/url、type 异常）。
    pub skipped_invalid: usize,
    /// 深度超限跳过的子树数（> BOOKMARKS_MAX_DEPTH）。
    pub depth_cutoff: usize,
    /// 解析层 (url, name) 去重丢弃数。
    pub dropped_dupes: usize,
    /// 数量上限截断数（items 达 limit 后未纳入节点数）。
    pub truncated: usize,
}

/// 历史导入统计载荷（03-方案 §2.5：落库统计 + 读取侧报告原样透传）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryImportPayload {
    /// 新增落库条数（INSERT OR IGNORE 影响行数）。
    pub inserted: u64,
    /// 同 (url, visited_at) 去重跳过条数（重复导入）。
    pub skipped_dupes: u64,
    /// 来源库查询读取行数（含被 URL 过滤丢弃前的行）。
    pub read_total: usize,
    /// 无效 URL 丢弃数（§6.2：非 http/https 或不可解析）。
    pub skipped_invalid_url: usize,
}

/// 当前 unix 秒（导入时刻注入面；时钟异常回退 0）。
fn unix_now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 导入书签（G-4 收尾，03-方案 §4.2 U4）：Chrome Bookmarks JSON（§6.1
/// 四树解析，幂等去重 + 数量上限 + 深度守卫）→ 落库 conex-db
/// imported_bookmarks（(url, name) 主键 INSERT OR IGNORE 幂等）。
///
/// ## 契约
/// - 入参 `json`：Chrome Bookmarks 文件内容（`{"roots": {...}}`）；
/// - 返回：[BookmarksImportPayload]（新增/跳过 + 解析侧报告透传）；
/// - 错误：非法 JSON → `tool.invalid_input:<原因>`；落库失败 → 透传
///   （conex-db 缺表降级返回 Ok(空统计)，不报错——R12/P2-1 纪律）。
#[tauri::command]
pub(crate) async fn browser_import_bookmarks(
    json: String,
    db_state: tauri::State<'_, crate::session_commands::SharedDb>,
) -> Result<BookmarksImportPayload, CoreError> {
    let report = parse_bookmarks(&json, &BookmarksOptions::default())
        .map_err(|e| map_browser_err(invalid_input(e.to_string())))?;
    let db = db_state.inner().local_db();
    let now = unix_now_secs();
    let parsed_items = report.items.len();
    let persist_stats = tokio::task::spawn_blocking(move || {
        let mut sink = crate::browser_import_sinks::LocalDbBookmarkSink::new(db);
        persist_bookmarks(&report.items, &mut sink, BOOKMARK_SOURCE, now)
            .map_err(|e| format!("书签落库失败：{e}"))
    })
    .await
    .map_err(|e| CoreError::Internal(format!("书签落库任务异常：{e}")))?
    .map_err(CoreError::Io)?;
    Ok(BookmarksImportPayload {
        inserted: persist_stats.inserted,
        skipped_dupes: persist_stats.skipped_dupes,
        parsed_items,
        skipped_invalid: report.skipped_invalid,
        depth_cutoff: report.depth_cutoff,
        dropped_dupes: report.dropped_dupes,
        truncated: report.truncated,
    })
}

/// 导入历史（G-4 收尾，03-方案 §4.2 U4）：Chrome History SQLite **只读**
/// 读取（§6.2：WebKit 时间换算、默认最近 90 天 / 上限 1000 条）→ 落库
/// conex-db imported_history（(url, visited_at) 主键幂等——同 URL 不同秒
/// 访问各保留一条）。
///
/// ## 契约
/// - 入参 `path`：Chrome History 库路径（来源浏览器须已关闭，锁检测由
///   上层向导承担，§3.2 复用）；
/// - 返回：[HistoryImportPayload]（新增/跳过 + 读取侧报告透传）；
/// - 错误：库缺失/不可只读读取 → `tool.invalid_input:<原因>`；落库失败 →
///   透传。
#[tauri::command]
pub(crate) async fn browser_import_history(
    path: String,
    db_state: tauri::State<'_, crate::session_commands::SharedDb>,
) -> Result<HistoryImportPayload, CoreError> {
    let db = db_state.inner().local_db();
    let now = unix_now_secs();
    let (report, persist_stats) = tokio::task::spawn_blocking(move || {
        let report = read_history(Path::new(&path), &HistoryOptions::default())
            .map_err(|e| map_browser_err(invalid_input(e.to_string())))?;
        let mut sink = crate::browser_import_sinks::LocalDbHistorySink::new(db);
        let stats = persist_history(&report.items, &mut sink, HISTORY_SOURCE, now)
            .map_err(|e| CoreError::Io(format!("历史落库失败：{e}")))?;
        Ok::<_, CoreError>((report, stats))
    })
    .await
    .map_err(|e| CoreError::Internal(format!("历史导入任务异常：{e}")))??;
    Ok(HistoryImportPayload {
        inserted: persist_stats.inserted,
        skipped_dupes: persist_stats.skipped_dupes,
        read_total: report.total,
        skipped_invalid_url: report.skipped_invalid_url,
    })
}

/// 书签列表（G-4 收尾查询面）：imported_bookmarks 全量行（导入时间倒序，
/// 面板书签侧栏展示面）。缺表降级返回空集（R12/P2-1）。
///
/// 返回行字段为 conex-db [conex_db::ImportedBookmarkRow] 原样序列化
/// （snake_case：url/name/folder_path/guid/source/imported_at）。
#[tauri::command]
pub(crate) async fn browser_list_bookmarks(
    db_state: tauri::State<'_, crate::session_commands::SharedDb>,
) -> Result<Vec<conex_db::ImportedBookmarkRow>, CoreError> {
    let db = db_state.inner().local_db();
    tokio::task::spawn_blocking(move || db.list_bookmarks())
        .await
        .map_err(|e| CoreError::Internal(format!("书签列表任务异常：{e}")))?
        .map_err(|e| CoreError::Io(format!("书签列表失败：{}: {}", e.kind, e.message)))
}

/// 历史列表（G-4 收尾查询面）：imported_history 行（visited_at 倒序 +
/// `since` 严格大于过滤 + `limit` 截断；limit 缺省 = 全量——表为导入数据，
/// 规模受导入上限约束）。
///
/// 返回行字段为 conex-db [conex_db::ImportedHistoryRow] 原样序列化
/// （snake_case：url/visited_at/title/source/imported_at）。
#[tauri::command]
pub(crate) async fn browser_list_history(
    since: Option<i64>,
    limit: Option<usize>,
    db_state: tauri::State<'_, crate::session_commands::SharedDb>,
) -> Result<Vec<conex_db::ImportedHistoryRow>, CoreError> {
    let db = db_state.inner().local_db();
    let limit = limit.unwrap_or(usize::MAX);
    tokio::task::spawn_blocking(move || db.list_history(since, limit))
        .await
        .map_err(|e| CoreError::Internal(format!("历史列表任务异常：{e}")))?
        .map_err(|e| CoreError::Io(format!("历史列表失败：{}: {}", e.kind, e.message)))
}
