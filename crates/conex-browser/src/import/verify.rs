//! 回读校验（维度 16 §4）
//!
//! S0 实证修订（S0-02 报告 / 16 文档 §4.1 修订注记）：「回读失败 ⇒ App-Bound」
//! 判据在本机不成立（Chrome 151 无 `app_bound_encrypted_key`，跨家族回读成功），故：
//!
//! 1. **App-Bound 判定前置**到复制/启动前：来源 Local State 含
//!    `app_bound_encrypted_key` ⇒ 提示「同家族可迁移、跨家族不可行」，
//!    由 [`crate::import::discovery::detect_app_bound`] 承担（复制前拦截）；
//! 2. 本模块承担**数据完整性兜底**：`N_db = 0`，或 `N_db > 0` 且 CDP 实读
//!    `N_cdp ≈ 0`（复制损坏/权限问题/跨机器凭据失效）→ `Unreadable`，
//!    引导面板内登录；`FamilyMismatch` 分类已撤销。
//!
//! DB 侧用 rusqlite **只读**打开目标 Cookies 库（`SQLITE_OPEN_READ_ONLY`，
//! 绝不写库——conex-db 尚无 open_readonly，直接依赖 workspace 既有 rusqlite）；
//! CDP 实读部分留接口 + TODO（依赖维度 10 启动受管实例 / 维度 11 接线）。
//!
//! 锁纪律（31-security-baseline B8）：本模块无锁。

use crate::import::discovery::detect_app_bound;
use crate::import::persist::now_unix_str;
use crate::import::types::{AppBoundStatus, VerifyConclusion, VerifyReport};
use rusqlite::{Connection, OpenFlags};
use std::path::{Path, PathBuf};

/// 回读校验错误面。
#[derive(Debug, thiserror::Error)]
pub enum VerifyError {
    /// 目标目录无 cookie 库（老布局 Cookies 与 v132+ Network/Cookies 均不存在）。
    #[error("未找到 cookie 库（老布局 Cookies 与 v132+ Network/Cookies 均不存在）")]
    NoCookiesDb,
    /// 库无法只读打开或统计（损坏/空库/权限/带 WAL 未退出）。
    #[error("cookie 库不可只读统计：{0}")]
    Unreadable(String),
    /// CDP 实读未接线。
    #[error("CDP 实读未接线：{0}")]
    NotImplemented(String),
}

/// cookie 库定位（§1.2：v132+ 迁移到 `Default/Network/Cookies`，
/// 启动器与回读校验均按存在性探测，两个路径不合并）。
pub fn locate_cookies_db(profile_dir: &Path) -> Option<PathBuf> {
    let default = profile_dir.join("Default");
    [default.join("Network").join("Cookies"), default.join("Cookies")]
        .into_iter()
        .find(|p| p.is_file())
}

/// 统计目标 Cookies 库持久 cookie 行数 `N_db`（§4.1 第 1 步：`expires_utc > 0`）。
/// 只读打开（`SQLITE_OPEN_READ_ONLY`），绝不写库；损坏/空库 → `Err(Unreadable)`。
pub fn count_persistent_cookies(db_path: &Path) -> Result<u64, VerifyError> {
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| VerifyError::Unreadable(e.to_string()))?;
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM cookies WHERE expires_utc > 0", [], |row| {
            row.get(0)
        })
        .map_err(|e| VerifyError::Unreadable(e.to_string()))?;
    Ok(n.max(0) as u64)
}

/// DB 侧回读校验（§4.1 步骤 0+1，数据完整性兜底）：
/// - `app_bound`：复制前前置检测结论（discovery::detect_app_bound 输入；
///   复制后目标 Local State 内容 = 来源副本，检测等价）；
/// - `N_db`：只读统计目标 cookie 库持久行数；
/// - 结论：`N_db > 0` → `Readable`（数据完整，CDP 确认见 TODO）；
///   `N_db = 0` / 库缺失 / 不可统计 → `Unreadable`（引导面板内登录）。
pub fn run_db_verify(profile_dir: &Path, app_bound: AppBoundStatus) -> VerifyReport {
    let Some(db) = locate_cookies_db(profile_dir) else {
        return report(
            app_bound,
            VerifyConclusion::Unreadable,
            0,
            "未找到 cookie 库（老布局 Cookies 与 v132+ Network/Cookies 均不存在）".to_string(),
        );
    };
    match count_persistent_cookies(&db) {
        Ok(n) if n > 0 => report(
            app_bound,
            VerifyConclusion::Readable,
            n,
            "DB 侧数据完整；CDP 实读确认待进程管理接线（TODO）".to_string(),
        ),
        Ok(_) => report(
            app_bound,
            VerifyConclusion::Unreadable,
            0,
            "无持久 cookie（expires_utc > 0 行数为 0）".to_string(),
        ),
        Err(e) => report(
            app_bound,
            VerifyConclusion::Unreadable,
            0,
            format!("cookie 库不可只读统计：{e}"),
        ),
    }
}

/// 组合带 app_bound 前置检测的完整校验（复制完成后入口：
/// 目标 profile 目录 + 来源 Local State 路径）。
pub fn run_verify(profile_dir: &Path, source_local_state: &Path) -> VerifyReport {
    run_db_verify(profile_dir, detect_app_bound(source_local_state))
}

/// CDP 实读接口（§4.1 第 2 步：受管实例启动后 `Storage.getCookies` /
/// `Network.getAllCookies` 统计持久 cookie 数 `N_cdp`）。
///
/// 遗留接线清单（依赖进程管理，MVP 未接线）：
/// 1. 以复制出的 profile 启动受管浏览器（`--user-data-dir=<managed/profile_name>`，
///    维度 10 `BrowserManager.start`）；
/// 2. CDP 连接（维度 11 `BrowserSession.connect`）后发送 `Storage.getCookies`；
/// 3. 按 `expires > 0` 过滤统计 `N_cdp`；
/// 4. 将结果喂给 [`conclude_with_cdp`] 修正结论。
pub trait CdpCookieReader {
    /// 返回持久 cookie 数（N_cdp）。
    fn count_persistent_cookies(&self) -> Result<u64, VerifyError>;
}

/// 未接线占位（MVP 无进程管理，返回 `NotImplemented`；接线后由
/// ImportService 注入真实实现，见 `crate::import::mod`）。
pub struct UnwiredCdpCookieReader;

impl CdpCookieReader for UnwiredCdpCookieReader {
    fn count_persistent_cookies(&self) -> Result<u64, VerifyError> {
        Err(VerifyError::NotImplemented(
            "CDP 实读未接线：依赖维度 10 启动受管实例 + 维度 11 Storage.getCookies".to_string(),
        ))
    }
}

/// 用 CDP 实读结果修正结论（§4.3 修订版判定）：
/// - `N_cdp > 0` → `Readable`（解密成功，登录态可用）；
/// - `N_db > 0` 且 `N_cdp == 0` → `Unreadable`（复制损坏/权限/跨机器凭据失效，
///   修订注记第 2 条：不提示「需同家族」，引导面板内登录）。
pub fn conclude_with_cdp(report: &mut VerifyReport, n_cdp: u64) {
    report.n_cdp = Some(n_cdp);
    if n_cdp == 0 && report.n_db > 0 {
        report.conclusion = VerifyConclusion::Unreadable;
    }
}

fn report(
    app_bound: AppBoundStatus,
    conclusion: VerifyConclusion,
    n_db: u64,
    notes: String,
) -> VerifyReport {
    VerifyReport {
        conclusion,
        n_db,
        n_cdp: None,
        app_bound,
        checked_at: now_unix_str(),
        notes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    /// 构造真实 SQLite cookie 库 fixture（host_key, expires_utc 行；
    /// 自动创建父目录）。
    fn cookies_fixture(path: &Path, rows: &[(&str, i64)]) {
        std::fs::create_dir_all(path.parent().expect("父目录")).expect("目录");
        let conn = Connection::open(path).expect("建库");
        conn.execute_batch(
            "CREATE TABLE cookies (
                host_key TEXT NOT NULL,
                name TEXT NOT NULL,
                value TEXT NOT NULL,
                path TEXT NOT NULL,
                expires_utc INTEGER NOT NULL
            )",
        )
        .expect("建表");
        for (host, expires) in rows {
            conn.execute(
                "INSERT INTO cookies (host_key, name, value, path, expires_utc)
                 VALUES (?1, 'n', '', '/', ?2)",
                params![host, expires],
            )
            .expect("插行");
        }
    }

    /// 写入文件（自动创建父目录）。
    fn write_at(path: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(path.parent().expect("父目录")).expect("目录");
        std::fs::write(path, bytes).expect("写入");
    }

    /// cookie 库定位：老布局 / v132+ 新布局 / 双布局（新优先）/ 皆无。
    #[test]
    fn locate_cookies_db_layouts() {
        let dir = tempfile::tempdir().expect("临时目录");
        let profile = dir.path().join("m");
        // 皆无
        assert!(locate_cookies_db(&profile).is_none());
        // 老布局
        std::fs::create_dir_all(&profile).expect("目录");
        write_at(&profile.join("Default/Cookies"), b"db");
        assert_eq!(
            locate_cookies_db(&profile).expect("定位"),
            profile.join("Default/Cookies")
        );
        // 新布局（v132+）
        write_at(&profile.join("Default/Network/Cookies"), b"db2");
        assert_eq!(
            locate_cookies_db(&profile).expect("定位"),
            profile.join("Default/Network/Cookies"),
            "双布局时 Network/Cookies 优先（新布局为准）"
        );
    }

    /// N_db 统计：含持久与会话 cookie 混合 → 仅统计 expires_utc > 0。
    #[test]
    fn count_persistent_cookies_mixed() {
        let dir = tempfile::tempdir().expect("临时目录");
        let db = dir.path().join("Cookies");
        cookies_fixture(
            &db,
            &[
                (".example.com", 1_750_000_000), // 持久
                (".example.com", 0),             // 会话（expires=0）
                (".sub.example.com", 1_760_000_000),
                ("localhost", -1), // 异常负值，不算持久
            ],
        );
        assert_eq!(count_persistent_cookies(&db).expect("统计"), 2);
    }

    /// 空库（无 cookies 表）→ Err；0 行 → Ok(0)；损坏文件 → Err。
    #[test]
    fn count_persistent_cookies_errors() {
        let dir = tempfile::tempdir().expect("临时目录");
        // 空库：SQLite 有效但无 cookies 表
        let empty = dir.path().join("empty.db");
        Connection::open(&empty).expect("建库");
        assert!(matches!(
            count_persistent_cookies(&empty),
            Err(VerifyError::Unreadable(_))
        ));
        // 有表无行 → 0
        let zero = dir.path().join("zero.db");
        cookies_fixture(&zero, &[]);
        assert_eq!(count_persistent_cookies(&zero).expect("统计"), 0);
        // 损坏文件（垃圾字节）
        let corrupt = dir.path().join("corrupt.db");
        std::fs::write(&corrupt, b"\x00\x01garbage-not-sqlite").expect("写入");
        assert!(matches!(
            count_persistent_cookies(&corrupt),
            Err(VerifyError::Unreadable(_))
        ));
        // 不存在 → Err
        assert!(matches!(
            count_persistent_cookies(&dir.path().join("missing.db")),
            Err(VerifyError::Unreadable(_))
        ));
    }

    /// DB 侧校验结论分支：无库 → Unreadable；空持久 → Unreadable；
    /// 含持久 cookie → Readable；损坏 → Unreadable；app_bound 透传。
    #[test]
    fn run_db_verify_branches() {
        let dir = tempfile::tempdir().expect("临时目录");
        // 无 cookie 库
        let bare = dir.path().join("bare");
        std::fs::create_dir_all(&bare).expect("目录");
        let r = run_db_verify(&bare, AppBoundStatus::Detected);
        assert_eq!(r.conclusion, VerifyConclusion::Unreadable);
        assert_eq!(r.n_db, 0);
        assert_eq!(r.app_bound, AppBoundStatus::Detected, "app_bound 透传");
        // 库损坏
        let broken = dir.path().join("broken");
        std::fs::create_dir_all(&broken).expect("目录");
        write_at(&broken.join("Default/Cookies"), b"junk");
        let r = run_db_verify(&broken, AppBoundStatus::Absent);
        assert_eq!(r.conclusion, VerifyConclusion::Unreadable);
        assert_eq!(r.n_db, 0);
        // 空持久（会话 cookie 只有 0/负 expires）
        let session_only = dir.path().join("session_only");
        std::fs::create_dir_all(&session_only).expect("目录");
        cookies_fixture(&session_only.join("Default/Cookies"), &[(".a.com", 0)]);
        let r = run_db_verify(&session_only, AppBoundStatus::Absent);
        assert_eq!(r.conclusion, VerifyConclusion::Unreadable);
        assert_eq!(r.n_db, 0);
        // 含持久 cookie → Readable + N_db
        let ok = dir.path().join("ok");
        std::fs::create_dir_all(&ok).expect("目录");
        cookies_fixture(
            &ok.join("Default/Cookies"),
            &[(".a.com", 1_700_000_000), (".b.com", 1_700_000_100), (".c.com", 0)],
        );
        let r = run_db_verify(&ok, AppBoundStatus::Detected);
        assert_eq!(r.conclusion, VerifyConclusion::Readable);
        assert_eq!(r.n_db, 2);
        assert_eq!(r.app_bound, AppBoundStatus::Detected);
        assert!(!r.checked_at.is_empty());
        // 新布局（Network/Cookies）同样命中
        let new_layout = dir.path().join("new_layout");
        std::fs::create_dir_all(&new_layout).expect("目录");
        cookies_fixture(&new_layout.join("Default/Network/Cookies"), &[(".a.com", 1_700_000_000)]);
        let r = run_db_verify(&new_layout, AppBoundStatus::Absent);
        assert_eq!(r.conclusion, VerifyConclusion::Readable);
        assert_eq!(r.n_db, 1);
    }

    /// run_verify：从来源 Local State 组合 app_bound 前置检测。
    #[test]
    fn run_verify_combines_app_bound() {
        let dir = tempfile::tempdir().expect("临时目录");
        let profile = dir.path().join("m");
        std::fs::create_dir_all(&profile).expect("目录");
        cookies_fixture(&profile.join("Default/Cookies"), &[(".a.com", 1_700_000_000)]);
        // 来源 Local State 含 app_bound 字段
        let ls = dir.path().join("src-Local State");
        std::fs::write(&ls, r#"{"os_crypt": {"app_bound_encrypted_key": "x"}}"#).expect("写入");
        let r = run_verify(&profile, &ls);
        assert_eq!(r.app_bound, AppBoundStatus::Detected);
        assert_eq!(r.conclusion, VerifyConclusion::Readable);
        // 来源无字段 → Absent
        std::fs::write(&ls, r#"{"os_crypt": {}}"#).expect("写入");
        let r = run_verify(&profile, &ls);
        assert_eq!(r.app_bound, AppBoundStatus::Absent);
    }

    /// CDP 实读结论修正：N_cdp=0 且 N_db>0 → Unreadable；N_cdp>0 → 保持 Readable。
    #[test]
    fn conclude_with_cdp_cases() {
        let dir = tempfile::tempdir().expect("临时目录");
        let profile = dir.path().join("m");
        std::fs::create_dir_all(&profile).expect("目录");
        cookies_fixture(&profile.join("Default/Cookies"), &[(".a.com", 1_700_000_000)]);
        let mut r = run_db_verify(&profile, AppBoundStatus::Absent);
        assert_eq!(r.conclusion, VerifyConclusion::Readable);
        // CDP 回读 0（复制损坏/权限/跨机器凭据失效）→ 降级 Unreadable
        conclude_with_cdp(&mut r, 0);
        assert_eq!(r.conclusion, VerifyConclusion::Unreadable);
        assert_eq!(r.n_cdp, Some(0));
        // CDP 回读成功 → 保持 Readable
        let mut r = run_db_verify(&profile, AppBoundStatus::Absent);
        conclude_with_cdp(&mut r, 7);
        assert_eq!(r.conclusion, VerifyConclusion::Readable);
        assert_eq!(r.n_cdp, Some(7));
        // N_db=0 时 N_cdp=0 维持 Unreadable（无登录态可迁移）
        let bare = dir.path().join("bare");
        std::fs::create_dir_all(&bare).expect("目录");
        let mut r = run_db_verify(&bare, AppBoundStatus::Absent);
        assert_eq!(r.conclusion, VerifyConclusion::Unreadable);
        conclude_with_cdp(&mut r, 0);
        assert_eq!(r.conclusion, VerifyConclusion::Unreadable);
    }

    /// 未接线占位返回 NotImplemented（CDP 实读待进程管理接线）。
    #[test]
    fn unwired_cdp_reader_not_implemented() {
        let r = UnwiredCdpCookieReader.count_persistent_cookies();
        assert!(matches!(r, Err(VerifyError::NotImplemented(_))));
    }
}
