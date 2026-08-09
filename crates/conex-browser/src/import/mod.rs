//! 数据导入与持久化（维度 16）
//!
//! 模块面：
//! - [`discovery`]：来源发现（§2：三平台路径表 / info_cache profile 列表 /
//!   自定义目录校验 / App-Bound 前置检测）
//! - [`copy`]：最小文件集复制（§3：白名单 / 锁检测 / staging 原子化 M-10）
//! - [`verify`]：回读校验（§4：N_db 数据完整性兜底 / CDP 实读接口，S0 修订版）
//! - [`persist`]：profile_meta 管理（§7：persist 开关唯一源 U-11 / 结论落盘 /
//!   staging 清扫）
//! - [`types`]：公共类型
//!
//! MVP 范围（R-13 分层裁决 + 任务书）：引导登录 persist 开关 + 来源发现 +
//! 前置检测 + 最小文件集复制；**storage_state（§5）/ 书签（§6.1）/ 历史
//! （§6.2）推迟 P1**，本模块不含其实现。
//!
//! [`ImportService`] 为聚合入口（Tauri command 接线面，MVP 轻量形态：
//! 无状态、路径注入，方法均为同步文件系统操作）。

pub mod copy;
pub mod discovery;
pub mod persist;
pub mod types;
pub mod verify;

pub use copy::{CopyError, CopyReport, CopySource, STAGING_DIR};
pub use discovery::{
    detect_app_bound, discover_sources, filter_existing, list_profiles, platform_candidates,
    validate_custom_dir, UserDataCandidate,
};
pub use persist::{
    cleanup_staging, list_managed, load_profile_meta, new_meta, set_persist,
    write_profile_meta, write_verify_result, PersistError, PROFILE_META_FILE,
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
    pub fn set_persist(&self, profile_dir: &Path, persist: bool) -> Result<ProfileMeta, PersistError> {
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
        assert_eq!(svc.detect_app_bound(&ud.join("Local State")), AppBoundStatus::Absent);
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
}
