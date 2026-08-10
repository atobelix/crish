//! 数据导入与持久化（维度 16）
//!
//! 模块面：
//! - [`discovery`]：来源发现（§2：三平台路径表 / info_cache profile 列表 /
//!   自定义目录校验 / App-Bound 前置检测）
//! - [`copy`]：最小文件集复制（§3：白名单 / 锁检测 / staging 原子化 M-10）
//! - [`verify`]：回读校验（§4：N_db 数据完整性兜底 / CDP 实读接口，S0 修订版）
//! - [`storage_state`]：storage_state 导入/导出（§5：内存传递 + 显式授权 +
//!   domain/origin 守卫 + 幂等去重）
//! - [`bookmarks`]：书签 JSON 解析（§6.1：四树递归 / 去重 / 深度守卫）
//! - [`history`]：历史 SQLite 只读读取（§6.2：WebKit 时间换算 / 只读保证）
//! - [`persist`]：profile_meta 管理（§7：persist 开关唯一源 U-11 / 结论落盘 /
//!   staging 清扫）
//! - [`types`]：公共类型
//!
//! 分层（R-13 裁决 + 任务书）：MVP 落地引导登录 persist 开关 + 来源发现 +
//! 前置检测 + 最小文件集复制；**P1 补 storage_state（§5）/ 书签（§6.1）/
//! 历史（§6.2）** 独立入口（本文件接线）。
//!
//! [`ImportService`] 为聚合入口（Tauri command 接线面，轻量形态：
//! 无状态、路径注入，方法均为同步文件系统/内存操作）。

pub mod bookmarks;
pub mod copy;
pub mod discovery;
pub mod history;
pub mod persist;
pub mod storage_state;
pub mod types;
pub mod verify;

pub use bookmarks::{
    parse_bookmarks, BookmarkItem, BookmarksError, BookmarksOptions, BookmarksReport,
    BOOKMARKS_DEFAULT_LIMIT, BOOKMARKS_MAX_DEPTH,
};
pub use copy::{CopyError, CopyReport, CopySource, STAGING_DIR};
pub use discovery::{
    detect_app_bound, discover_sources, filter_existing, list_profiles, platform_candidates,
    validate_custom_dir, UserDataCandidate,
};
pub use history::{
    read_history, HistoryError, HistoryItem, HistoryOptions, HistoryReport, HISTORY_DEFAULT_DAYS,
    HISTORY_DEFAULT_LIMIT, WEBKIT_UNIX_OFFSET_US,
};
pub use persist::{
    cleanup_staging, list_managed, load_profile_meta, new_meta, set_persist, write_profile_meta,
    write_verify_result, PersistError, PROFILE_META_FILE,
};
pub use storage_state::{
    build_import_plan, export_storage_state, origin_guard_script, parse_storage_state,
    validate_cookie_domain, validate_origin, ExportAuthorization, ImportPlan, ImportStats,
    OriginScript, StorageCookie, StorageItem, StorageOrigin, StorageState, StorageStateError,
    SESSION_COOKIE_EXPIRES, STORAGE_STATE_MAX_BYTES, STORAGE_STATE_MAX_COOKIES,
};
pub use types::{
    AppBoundStatus, BrowserFamily, BrowserSource, ChromeProfile, ProfileMeta, ProfileOrigin,
    ProfileState, RunningStatus, VerifyConclusion, VerifyReport,
};
pub use verify::{
    conclude_with_cdp, count_persistent_cookies, locate_cookies_db, run_db_verify, run_verify,
    CdpCookieReader, UnwiredCdpCookieReader, VerifyError,
};

use crate::browser::profile::{browser_root, managed_root};
use crate::cdp::domains::Cookie;
use std::path::{Path, PathBuf};

/// 数据导入服务聚合（Tauri command 接线面；受管根注入，测试/自定义布局可覆盖）。
#[derive(Debug, Clone)]
pub struct ImportService {
    /// 受管 profile 根：`<browser_root>/managed/`（R-2 布局）。
    pub managed_root: PathBuf,
}

impl ImportService {
    /// 新建（显式注入受管根）。
    pub fn with_root(managed_root: PathBuf) -> Self {
        ImportService { managed_root }
    }

    /// 从数据根构建（默认布局 `<data_root>/conex/browser/managed/`，R-2；
    /// `data_root` 平台解析见 browser::profile::data_root）。
    pub fn from_data_root(data_root: &Path) -> Self {
        ImportService {
            managed_root: managed_root(&browser_root(data_root)),
        }
    }

    /// 来源发现（§2.1）：返回全部存在的来源浏览器（浏览器级，未选 profile）。
    pub fn discover_sources(&self) -> Vec<BrowserSource> {
        discover_sources()
    }

    /// 来源 profile 列表（§2.2：Local State info_cache）。
    pub fn list_profiles(&self, source: &BrowserSource) -> Vec<ChromeProfile> {
        list_profiles(&source.user_data_dir, source.family)
    }

    /// App-Bound 前置检测（S0 修订 §4.1：来源 Local State 字段存在性）。
    pub fn detect_app_bound(&self, source_local_state: &Path) -> AppBoundStatus {
        detect_app_bound(source_local_state)
    }

    /// 最小文件集复制（§3：白名单 + 锁检测 + staging 原子化 M-10）。
    pub fn copy_profile(&self, source: &CopySource) -> Result<CopyReport, CopyError> {
        copy::copy_profile_atomic(source, &self.managed_root)
    }

    /// 回读校验 DB 侧（§4：app_bound 前置检测 + N_db + 结论；
    /// `profile_dir` 为目标 `managed/<name>/`）。
    pub fn verify_copied(&self, profile_dir: &Path) -> VerifyReport {
        // 复制后目标 Local State 内容 = 来源副本，检测等价（见 verify::run_db_verify 注）
        run_verify(profile_dir, &profile_dir.join("Local State"))
    }

    /// 校验结论落盘（验收 S3：`profile_meta.verify_result`）。
    pub fn persist_verify_result(
        &self,
        profile_dir: &Path,
        verify: &VerifyReport,
    ) -> Result<ProfileMeta, PersistError> {
        write_verify_result(profile_dir, verify)
    }

    /// 持久化开关（U-11：persist 唯一存于 profile_meta.json，撤销双源）。
    pub fn set_persist(
        &self,
        profile_dir: &Path,
        persist: bool,
    ) -> Result<ProfileMeta, PersistError> {
        set_persist(profile_dir, persist)
    }

    /// meta 读取（容错语义：不存在 Ok(None)，损坏 Err(Corrupt)）。
    pub fn load_meta(&self, profile_dir: &Path) -> Result<Option<ProfileMeta>, PersistError> {
        load_profile_meta(profile_dir)
    }

    /// staging 残留清扫（M-10 兜底，§3.4：复制中断残留直删）。
    pub fn cleanup_staging(&self) -> Vec<PathBuf> {
        cleanup_staging(&self.managed_root)
    }

    /// 受管 profile 目录清单（排除 .staging 等瞬态项）。
    pub fn list_managed(&self) -> Vec<PathBuf> {
        list_managed(&self.managed_root)
    }

    /// CDP 实读（§4.1 第 2 步）：MVP 返回占位（NotImplemented）；
    /// 接线清单见 [`verify::CdpCookieReader`]（依赖维度 10/11 进程管理）。
    pub fn cdp_reader(&self) -> Box<dyn CdpCookieReader + Send + Sync> {
        Box::new(UnwiredCdpCookieReader)
    }

    /// storage_state 导出（§5.2）：**需显式授权**（授权对话框确认后传
    /// `ExportAuthorization::Confirmed`）；**内存传递**——返回内存
    /// [`StorageState`]，不落盘任何文件（写盘仅走前端显式「另存为」路径）；
    /// cookie 来源为 CDP `Storage.getCookies` 结果（调用方经 CDP 获取后传入）。
    pub fn export_storage_state(
        &self,
        cookies: &[Cookie],
        auth: ExportAuthorization,
    ) -> Result<StorageState, StorageStateError> {
        storage_state::export_storage_state(cookies, auth)
    }

    /// storage_state 导入（§5.3）：JSON 解析 + 校验（大小/数量上限、domain 守卫、
    /// origin 守卫）→ [`ImportPlan`]（`Network.setCookies` 参数 + localStorage
    /// origin 守卫脚本；同 (domain, name, path) 幂等去重、覆盖语义）。
    pub fn import_storage_state(&self, json: &str) -> Result<ImportPlan, StorageStateError> {
        let state = storage_state::parse_storage_state(json)?;
        Ok(storage_state::build_import_plan(&state))
    }

    /// 书签导入（§6.1，独立入口）：Chrome Bookmarks JSON 解析（四树递归）→
    /// 扁平化列表；(url, name) 幂等去重；默认上限 10000 条。纯数据解析，
    /// 无网络请求；结果写入本地书签库属 conex-db 接线（遗留）。
    pub fn import_bookmarks(
        &self,
        json: &str,
        options: &BookmarksOptions,
    ) -> Result<BookmarksReport, BookmarksError> {
        bookmarks::parse_bookmarks(json, options)
    }

    /// 历史导入（§6.2，独立入口）：Chrome History SQLite **只读**读取
    /// （`SQLITE_OPEN_READ_ONLY`，绝不写来源库）→ WebKit 时间戳换算 →
    /// 时间倒序列表；默认最近 90 天 / 上限 1000 条（可配）。
    pub fn import_history(
        &self,
        history_db: &Path,
        options: &HistoryOptions,
    ) -> Result<HistoryReport, HistoryError> {
        history::read_history(history_db, options)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// from_data_root 布局断言（R-2：`<data_root>/conex/browser/managed`）。
    #[test]
    fn from_data_root_layout() {
        let svc = ImportService::from_data_root(Path::new("C:\\data"));
        assert_eq!(
            svc.managed_root,
            Path::new("C:\\data").join("browser").join("managed"),
            "受管根 = browser_root/managed"
        );
    }

    /// 端到端冒烟：fixture 来源 → 发现 → 复制 → 校验 → 落盘（临时目录闭环）。
    #[test]
    fn import_service_end_to_end() {
        let dir = tempfile::tempdir().expect("临时目录");
        // fixture 来源
        let ud = dir.path().join("ud");
        let p = ud.join("Default");
        std::fs::create_dir_all(&p).expect("目录");
        std::fs::write(
            ud.join("Local State"),
            r#"{"os_crypt": {}, "profile": { "info_cache": { "Default": { "name": "个人" } } }}"#,
        )
        .expect("写入");
        // 真实 SQLite cookie 库（含 1 行持久 cookie）
        let conn = rusqlite::Connection::open(p.join("Cookies")).expect("建库");
        conn.execute_batch(
            "CREATE TABLE cookies (
                host_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL,
                path TEXT NOT NULL, expires_utc INTEGER NOT NULL
            )",
        )
        .expect("建表");
        conn.execute(
            "INSERT INTO cookies (host_key, name, value, path, expires_utc)
             VALUES ('a.com', 'n', '', '/', 1700000000)",
            [],
        )
        .expect("插行");
        std::fs::write(p.join("Bookmarks"), b"{}").expect("写入");
        std::fs::write(p.join("Login Data"), b"pw").expect("写入");

        let svc = ImportService::with_root(dir.path().join("managed"));

        // 1. 发现（注入候选 → 过滤）
        let found = filter_existing(vec![UserDataCandidate {
            family: BrowserFamily::Chrome,
            browser_name: "Google Chrome",
            dir: ud.clone(),
        }]);
        assert_eq!(found.len(), 1);
        // 2. profile 列表
        let profiles = svc.list_profiles(&found[0]);
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].directory, "Default");
        // 3. App-Bound 前置检测（fixture 无 app_bound 字段 → Absent）
        assert_eq!(
            svc.detect_app_bound(&ud.join("Local State")),
            AppBoundStatus::Absent
        );
        // 4. 复制（组合完整来源；目标名走 sanitize（非 ASCII 换下划线，见
        //    browser::profile::sanitize_profile_name），测试用 ASCII 名）
        let full_source = found[0].with_profile(&profiles[0]);
        let copy_src = CopySource {
            user_data_dir: full_source.user_data_dir.clone(),
            profile_dir: full_source.profile_dir.clone(),
            profile_name: "my-browser".to_string(),
        };
        let report = svc.copy_profile(&copy_src).expect("复制");
        assert!(report.copied >= 3);
        let target = svc.managed_root.join("my-browser");
        assert!(target.join("Default/Cookies").is_file());
        assert!(!target.join("Default/Login Data").exists(), "密码库不迁移");
        // 5. 校验 + 结论落盘
        let verify = svc.verify_copied(&target);
        assert_eq!(verify.conclusion, VerifyConclusion::Readable);
        assert_eq!(verify.n_db, 1, "1 行持久 cookie");
        let meta = svc.persist_verify_result(&target, &verify).expect("落盘");
        assert_eq!(meta.origin, ProfileOrigin::Copied);
        assert_eq!(
            meta.verify_result.as_ref().expect("vr").conclusion,
            VerifyConclusion::Readable
        );
        // 6. persist 开关
        svc.set_persist(&target, true).expect("开启");
        assert!(svc.load_meta(&target).expect("读取").expect("存在").persist);
        // 7. 受管清单 + staging 清扫
        assert_eq!(svc.list_managed().len(), 1);
        assert!(svc.cleanup_staging().is_empty());
        // 8. CDP 实读占位
        assert!(matches!(
            svc.cdp_reader().count_persistent_cookies(),
            Err(VerifyError::NotImplemented(_))
        ));
    }

    /// P1 独立入口冒烟（§5/§6）：storage_state 导出（授权）→ 导入（注入计划）→
    /// 书签解析 → 历史只读读取；**不落盘保证**（§5.4）：全程不创建任何文件。
    #[test]
    fn import_service_p1_methods_no_persist() {
        let dir = tempfile::tempdir().expect("临时目录");
        let svc = ImportService::with_root(dir.path().join("managed"));
        // 1. 导出需显式授权（§5.2）
        let cdp_cookie = Cookie {
            name: "sid".to_string(),
            value: "abc123".to_string(),
            domain: ".example.com".to_string(),
            path: "/".to_string(),
            expires: -1.0,
            size: 10,
            http_only: true,
            secure: true,
            session: true,
            same_site: Some("Lax".to_string()),
            priority: None,
        };
        assert!(svc
            .export_storage_state(
                std::slice::from_ref(&cdp_cookie),
                ExportAuthorization::Denied
            )
            .is_err());
        let state = svc
            .export_storage_state(&[cdp_cookie], ExportAuthorization::Confirmed)
            .expect("导出");
        // 2. 导入往返（§5.3）：序列化 → 解析 → 注入计划
        let json = state.to_json();
        let plan = svc.import_storage_state(&json).expect("导入");
        assert_eq!(plan.stats.cookies, 1);
        let v = serde_json::to_value(&plan.cookies).expect("序列化");
        assert!(
            v[0].get("expires").is_none(),
            "会话 cookie 归一化移除 expires"
        );
        assert_eq!(v[0]["sameSite"], "Lax");
        // 3. 书签解析（§6.1）：非法 JSON 报错、合法树去重
        assert!(svc
            .import_bookmarks("{bad", &BookmarksOptions::default())
            .is_err());
        let bookmarks = svc
            .import_bookmarks(
                r#"{"roots":{"bookmark_bar":{"type":"folder","name":"书签栏","children":[
                    {"type":"url","name":"A","url":"https://a.example.com"},
                    {"type":"url","name":"A","url":"https://a.example.com"}
                ]}}}"#,
                &BookmarksOptions::default(),
            )
            .expect("书签解析");
        assert_eq!(bookmarks.items.len(), 1, "同 (url, name) 去重");
        assert_eq!(bookmarks.items[0].folder_path, vec!["书签栏"]);
        // 4. 历史只读读取（§6.2）：真实 SQLite fixture + 时间换算
        let hist = dir.path().join("History");
        {
            let conn = rusqlite::Connection::open(&hist).expect("建库");
            conn.execute_batch(
                "CREATE TABLE urls (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, title TEXT);
                 CREATE TABLE visits (id INTEGER PRIMARY KEY AUTOINCREMENT, url INTEGER NOT NULL, visit_time INTEGER NOT NULL);",
            )
            .expect("建表");
            conn.execute(
                "INSERT INTO urls (url, title) VALUES ('https://h.example.com', 'H')",
                [],
            )
            .expect("插行");
            let id = conn.last_insert_rowid();
            let now_secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("时钟")
                .as_secs() as i64;
            conn.execute(
                "INSERT INTO visits (url, visit_time) VALUES (?1, ?2)",
                rusqlite::params![id, (now_secs - 86_400 + 11_644_473_600) * 1_000_000],
            )
            .expect("插行");
        }
        let report = svc
            .import_history(&hist, &HistoryOptions::default())
            .expect("历史读取");
        assert_eq!(report.items.len(), 1);
        assert_eq!(
            report.items[0].url, "https://h.example.com",
            "WebKit 时间戳换算后读取"
        );
        // 5. 不落盘保证（§5.4）：以上全部操作不得创建任何文件
        assert!(
            !svc.managed_root.exists(),
            "storage_state/书签/历史导入导出全程不落盘（§5.4 强制面）"
        );
    }
}
