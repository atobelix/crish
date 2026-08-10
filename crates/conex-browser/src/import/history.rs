//! 历史导入（维度 16 §6.2，独立入口）
//!
//! - 来源：`<profile>/History`（Chrome/Edge 私有 SQLite 库）；
//! - **只读保证**：rusqlite 以 `SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_NO_MUTEX`
//!   打开，仅 SELECT、绝不写来源库（§6.2；与 verify.rs 的 cookie 库只读同款
//!   纪律）；读取前置条件（来源浏览器已关闭、`*-wal` 存在性提示）由上层
//!   锁检测承担（§3.2 复用）；
//! - 读取 SQL（§6.2）：`visits` JOIN `urls`，`visit_time > ?` 过滤 + 时间倒序 +
//!   LIMIT；**WebKit 时间戳换算**：`unix_secs = webkit_us / 1e6 - 11_644_473_600`
//!   （1601-01-01 UTC → 1970-01-01 偏移）；
//! - 默认导入范围：最近 [`HISTORY_DEFAULT_DAYS`]（90）天、最多
//!   [`HISTORY_DEFAULT_LIMIT`]（1000）条（任务书口径，均可配）；
//! - 无效 URL 行丢弃（非 http/https 或不可解析，§6.2 无效 URL 行丢弃）；
//!   目标表 `imported_history` 按 (url, visit_time) 去重属 conex-db 接线遗留。
//!
//! 锁纪律（31-security-baseline B8）：本模块无锁；只读连接不写库。

use rusqlite::{params, Connection, OpenFlags};
use std::path::Path;

/// 默认导入范围（§6.2：最近 90 天）。
pub const HISTORY_DEFAULT_DAYS: i64 = 90;
/// 默认条数上限（任务书口径：默认 1000，可配）。
pub const HISTORY_DEFAULT_LIMIT: usize = 1000;
/// WebKit 纪元（1601-01-01 UTC）到 Unix 纪元（1970-01-01 UTC）的微秒偏移
/// （§6.2：`webkit_us / 1e6 - 11_644_473_600`）。
pub const WEBKIT_UNIX_OFFSET_US: i64 = 11_644_473_600_000_000;
/// 微秒 → 秒换算除数。
const US_PER_SEC: i64 = 1_000_000;

/// 单条历史记录（§6.2 读取结果）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryItem {
    /// 访问 URL（http/https，无效行已丢弃）。
    pub url: String,
    /// 页面标题（来源库 NULL → None）。
    pub title: Option<String>,
    /// 访问时间（**Unix 秒**，WebKit 微秒换算后）。
    pub visited_at: i64,
}

/// 历史读取报告。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HistoryReport {
    /// 有效条目（时间倒序，满足 since/limit）。
    pub items: Vec<HistoryItem>,
    /// 查询读取行数（含被 URL 过滤丢弃前的行）。
    pub total: usize,
    /// 无效 URL 丢弃数（§6.2：非 http/https 或不可解析）。
    pub skipped_invalid_url: usize,
}

/// 读取选项（§6.2：默认最近 90 天 + 1000 条）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HistoryOptions {
    /// 起始时间：仅返回该时刻（unix 秒）之后的访问；`None` = 默认最近
    /// [`HISTORY_DEFAULT_DAYS`] 天。
    pub since: Option<i64>,
    /// 条数上限（默认 [`HISTORY_DEFAULT_LIMIT`]）。
    pub limit: usize,
}

impl Default for HistoryOptions {
    fn default() -> Self {
        HistoryOptions {
            since: None,
            limit: HISTORY_DEFAULT_LIMIT,
        }
    }
}

/// 历史读取错误面。
#[derive(Debug, thiserror::Error)]
pub enum HistoryError {
    /// 来源库不存在。
    #[error("History 库不存在（{path}）")]
    NotFound { path: String },
    /// 无法只读打开/查询（损坏 / 带热日志未干净退出 / 权限）。
    #[error("History 库不可只读读取（{path}）：{error}")]
    Unreadable { path: String, error: String },
}

/// 读取 Chrome History 库（§6.2）：**只读打开**（`SQLITE_OPEN_READ_ONLY`，
/// 绝不写库——只读保证由打开标志强制 + 测试字节比对验证），
/// WebKit 微秒时间戳换算为 Unix 秒，时间倒序 + since 过滤 + 条数上限。
pub fn read_history(path: &Path, opts: &HistoryOptions) -> Result<HistoryReport, HistoryError> {
    if !path.is_file() {
        return Err(HistoryError::NotFound {
            path: path.display().to_string(),
        });
    }
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| HistoryError::Unreadable {
        path: path.display().to_string(),
        error: e.to_string(),
    })?;
    let since_us = match opts.since {
        Some(s) => s * US_PER_SEC + WEBKIT_UNIX_OFFSET_US,
        None => default_since_webkit_us(),
    };
    let mut stmt = conn
        .prepare(
            "SELECT u.url, u.title, v.visit_time
             FROM visits v JOIN urls u ON u.id = v.url
             WHERE v.visit_time > ?1
             ORDER BY v.visit_time DESC
             LIMIT ?2",
        )
        .map_err(|e| HistoryError::Unreadable {
            path: path.display().to_string(),
            error: e.to_string(),
        })?;
    let rows = stmt
        .query_map(params![since_us, opts.limit as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| HistoryError::Unreadable {
            path: path.display().to_string(),
            error: e.to_string(),
        })?;
    let mut report = HistoryReport::default();
    for row in rows {
        let (url, title, visit_us) = row.map_err(|e| HistoryError::Unreadable {
            path: path.display().to_string(),
            error: e.to_string(),
        })?;
        report.total += 1;
        // 无效 URL 行丢弃（§6.2：非 http/https 或不可解析）
        if !is_http_url(&url) {
            report.skipped_invalid_url += 1;
            continue;
        }
        // WebKit 时间戳换算（§6.2：webkit_us / 1e6 - 11_644_473_600）
        let visited_at = visit_us.div_euclid(US_PER_SEC) - WEBKIT_UNIX_OFFSET_US / US_PER_SEC;
        report.items.push(HistoryItem {
            url,
            title,
            visited_at,
        });
    }
    Ok(report)
}

/// 默认起始时间（unix 秒）：当前时间 - [`HISTORY_DEFAULT_DAYS`] 天。
fn default_since_unix_secs() -> i64 {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    now - HISTORY_DEFAULT_DAYS * 86_400
}

/// 默认起始时间（WebKit 微秒，供查询过滤）。
fn default_since_webkit_us() -> i64 {
    default_since_unix_secs() * US_PER_SEC + WEBKIT_UNIX_OFFSET_US
}

/// 有效 URL 判定（§6.2：http/https 可解析绝对 URL；chrome:// 等丢弃）。
fn is_http_url(url: &str) -> bool {
    url::Url::parse(url)
        .map(|u| matches!(u.scheme(), "http" | "https"))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 构造真实 Chrome History 形态 fixture（urls + visits 表；
    /// `visit_time` 为 WebKit 微秒）。返回 (dir, db_path)。
    fn history_fixture(dir: &Path, rows: &[(&str, Option<&str>, i64)]) -> std::path::PathBuf {
        let db = dir.join("History");
        let conn = Connection::open(&db).expect("建库");
        conn.execute_batch(
            "CREATE TABLE urls (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                url TEXT NOT NULL,
                title TEXT
            );
            CREATE TABLE visits (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                url INTEGER NOT NULL,
                visit_time INTEGER NOT NULL
            );",
        )
        .expect("建表");
        for (url, title, visit_us) in rows {
            conn.execute(
                "INSERT INTO urls (url, title) VALUES (?1, ?2)",
                params![url, title],
            )
            .expect("插 urls 行");
            let url_id = conn.last_insert_rowid();
            conn.execute(
                "INSERT INTO visits (url, visit_time) VALUES (?1, ?2)",
                params![url_id, visit_us],
            )
            .expect("插 visits 行");
        }
        db
    }

    /// unix 秒 → WebKit 微秒（测试构造用）。
    fn to_webkit_us(unix_secs: i64) -> i64 {
        (unix_secs + WEBKIT_UNIX_OFFSET_US / US_PER_SEC) * US_PER_SEC
    }

    /// 当前 unix 秒（测试构造用；与断言共用同一采样，避免跨秒漂移）。
    fn now_unix_secs() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("时钟")
            .as_secs() as i64
    }

    /// 有数据读取：时间换算（WebKit → Unix 秒）、倒序、since 过滤、limit。
    #[test]
    fn reads_with_timestamp_conversion() {
        let dir = tempfile::tempdir().expect("临时目录");
        let now = now_unix_secs();
        let db = history_fixture(
            dir.path(),
            &[
                (
                    "https://old.example.com",
                    Some("旧"),
                    to_webkit_us(now - 30 * 86_400),
                ),
                (
                    "https://mid.example.com",
                    None,
                    to_webkit_us(now - 20 * 86_400),
                ),
                (
                    "https://new.example.com",
                    Some("新"),
                    to_webkit_us(now - 10 * 86_400),
                ),
            ],
        );
        // 默认范围（90 天内）：全部命中
        let report = read_history(&db, &HistoryOptions::default()).expect("读取");
        assert_eq!(report.items.len(), 3);
        assert_eq!(report.total, 3);
        assert_eq!(report.skipped_invalid_url, 0);
        // 时间倒序（§6.2 ORDER BY visit_time DESC）
        assert_eq!(report.items[0].url, "https://new.example.com");
        assert_eq!(report.items[2].url, "https://old.example.com");
        // WebKit → Unix 秒换算精度
        assert_eq!(report.items[0].visited_at, now - 10 * 86_400);
        assert_eq!(report.items[2].visited_at, now - 30 * 86_400);
        // 标题 NULL → None；有值 → Some
        assert_eq!(report.items[1].title, None);
        assert_eq!(report.items[0].title.as_deref(), Some("新"));
        // since 过滤：仅返回 now-25d 之后（2 条）
        let report = read_history(
            &db,
            &HistoryOptions {
                since: Some(now - 25 * 86_400),
                limit: 100,
            },
        )
        .expect("读取");
        assert_eq!(report.items.len(), 2);
        assert_eq!(report.items[0].url, "https://new.example.com");
        assert_eq!(report.items[1].url, "https://mid.example.com");
        // limit 截断（倒序取前 1）
        let report = read_history(
            &db,
            &HistoryOptions {
                since: None,
                limit: 1,
            },
        )
        .expect("读取");
        assert_eq!(report.items.len(), 1);
        assert_eq!(report.items[0].url, "https://new.example.com");
    }

    /// 无效 URL 行丢弃（§6.2）：空串 / chrome:// 等非 http(s) / 非 URL。
    #[test]
    fn invalid_urls_dropped() {
        let dir = tempfile::tempdir().expect("临时目录");
        let now = now_unix_secs();
        let db = history_fixture(
            dir.path(),
            &[
                ("", Some("空"), to_webkit_us(now - 86_400)),
                (
                    "chrome://settings",
                    Some("内部页"),
                    to_webkit_us(now - 2 * 86_400),
                ),
                ("not-a-url", Some("非 URL"), to_webkit_us(now - 3 * 86_400)),
                (
                    "https://good.example.com",
                    Some("好"),
                    to_webkit_us(now - 4 * 86_400),
                ),
            ],
        );
        let report = read_history(&db, &HistoryOptions::default()).expect("读取");
        assert_eq!(report.total, 4, "读取行数含被过滤行");
        assert_eq!(report.skipped_invalid_url, 3);
        assert_eq!(report.items.len(), 1);
        assert_eq!(report.items[0].url, "https://good.example.com");
    }

    /// 空库（正确 schema 无行）→ Ok(0)；缺失文件 → NotFound；损坏 → Unreadable。
    #[test]
    fn empty_missing_corrupt() {
        let dir = tempfile::tempdir().expect("临时目录");
        // 空库
        let db = history_fixture(dir.path(), &[]);
        let report = read_history(&db, &HistoryOptions::default()).expect("空库读取");
        assert!(report.items.is_empty());
        assert_eq!(report.total, 0);
        // 缺失
        assert!(matches!(
            read_history(&dir.path().join("Missing"), &HistoryOptions::default()),
            Err(HistoryError::NotFound { .. })
        ));
        // 损坏（垃圾字节）
        let corrupt = dir.path().join("Corrupt");
        fs::write(&corrupt, b"\x00\x01garbage-not-sqlite").expect("写入");
        assert!(matches!(
            read_history(&corrupt, &HistoryOptions::default()),
            Err(HistoryError::Unreadable { .. })
        ));
        // 无 urls/visits 表（合法库错误 schema）→ Unreadable
        let no_schema = dir.path().join("NoSchema");
        Connection::open(&no_schema).expect("建库");
        assert!(matches!(
            read_history(&no_schema, &HistoryOptions::default()),
            Err(HistoryError::Unreadable { .. })
        ));
    }

    /// **只读保证**（§6.2 / 验收 E-9）：复制 fixture 打开读取后字节不变；
    /// 且只读标志连接上写操作被 SQLite 拒绝。
    #[test]
    fn read_only_guarantee() {
        let dir = tempfile::tempdir().expect("临时目录");
        let now = now_unix_secs();
        let src = history_fixture(
            dir.path(),
            &[(
                "https://a.example.com",
                Some("A"),
                to_webkit_us(now - 86_400),
            )],
        );
        // 复制副本打开（模拟「复制 fixture 打开」）
        let copy = dir.path().join("History-copy");
        fs::copy(&src, &copy).expect("复制");
        let before = fs::read(&copy).expect("读字节");
        let report = read_history(&copy, &HistoryOptions::default()).expect("读取");
        assert_eq!(report.items.len(), 1);
        let after = fs::read(&copy).expect("读字节");
        assert_eq!(before, after, "来源库字节级未变（只读保证）");
        // 只读标志强制面：同一标志打开后写操作必须失败
        let conn = Connection::open_with_flags(
            &copy,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .expect("只读打开");
        assert!(
            conn.execute("INSERT INTO visits (url, visit_time) VALUES (1, 1)", [],)
                .is_err(),
            "只读连接写操作必须被 SQLite 拒绝"
        );
    }

    /// 默认范围语义：since=None 取最近 90 天（构造 91 天前/1 天前的访问）。
    #[test]
    fn default_since_last_90_days() {
        let dir = tempfile::tempdir().expect("临时目录");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("时钟");
        let now_secs = now.as_secs() as i64;
        let db = history_fixture(
            dir.path(),
            &[
                (
                    "https://recent.example.com",
                    None,
                    to_webkit_us(now_secs - 86_400),
                ),
                (
                    "https://ancient.example.com",
                    None,
                    to_webkit_us(now_secs - 91 * 86_400),
                ),
            ],
        );
        let report = read_history(&db, &HistoryOptions::default()).expect("读取");
        assert_eq!(report.items.len(), 1, "默认范围仅含最近 90 天内的访问");
        assert_eq!(report.items[0].url, "https://recent.example.com");
    }
}
