//! profile_meta 管理（维度 16 §7）
//!
//! - `profile_meta.json` 读写：persist 开关**唯一**存于此（R-2 / U-11，
//!   撤销 panel-state.json 双源）；`verify_result` 落盘（验收 S3）
//! - **原子写**（临时文件 + 同目录 rename）：并发二次写不产生半成品，
//!   最后一次提交者胜（rename 原子性）
//! - **损坏 JSON 容错**：读取返回显式 `Corrupt` 错误（不 panic、不覆盖
//!   原文件，上层可重新初始化）
//! - `managed/.staging/` 残留清扫（M-10 兜底，§3.4：复制中断残留直删）
//! - 受管 profile 清单（排除 `.staging` 等瞬态项，§3.3 要点）
//!
//! 目录布局（R-2）：受管 profile 唯一根 `managed/<profile_name>/`；
//! 临时 profile（sessions/）无 meta，不适用本节（见 browser::profile）。
//!
//! 锁纪律（31-security-baseline B8）：本模块无锁；并发互斥由 rename 原子性保证。

use crate::import::types::{BrowserSource, ProfileMeta, ProfileOrigin, ProfileState, VerifyReport};
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// profile_meta.json 文件名（与 browser::profile::PROFILE_META_FILE 同值，
/// 模块局部常量，避免跨层耦合）。
pub const PROFILE_META_FILE: &str = "profile_meta.json";

/// 持久化开关键（§7.1 字段名，供审计/前端引用）。
pub const PERSIST_KEY: &str = "persist";

/// profile_meta 读写错误面。
#[derive(Debug, thiserror::Error)]
pub enum PersistError {
    /// 文件存在但 JSON 损坏/非法（保留原文件不覆盖，上层可重新初始化）。
    #[error("profile_meta.json 损坏（{path}）：{error}")]
    Corrupt { path: String, error: String },
    /// IO 失败。
    #[error("profile_meta 读写失败：{0}")]
    Io(String),
    /// 序列化失败。
    #[error("profile_meta 序列化失败：{0}")]
    Serialize(String),
}

/// 受管 profile 元数据文件路径。
pub fn profile_meta_path(profile_dir: &Path) -> PathBuf {
    profile_dir.join(PROFILE_META_FILE)
}

/// 原子写（§7.1 写入时机：创建/校验落盘/开关变更/删除）：
/// 写同目录临时文件后 rename（同文件系统原子改名；并发二次写最后者胜，
/// 中断不产生半成品 meta）。
pub fn write_profile_meta(profile_dir: &Path, meta: &ProfileMeta) -> Result<(), PersistError> {
    let path = profile_meta_path(profile_dir);
    let tmp = profile_dir.join(format!(".{PROFILE_META_FILE}.{}.tmp", short_id()));
    let json =
        serde_json::to_string_pretty(meta).map_err(|e| PersistError::Serialize(e.to_string()))?;
    std::fs::write(&tmp, json)
        .map_err(|e| PersistError::Io(format!("写临时文件失败 {}：{e}", tmp.display())))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        PersistError::Io(format!(
            "原子提交失败 {} → {}：{e}",
            tmp.display(),
            path.display()
        ))
    })?;
    Ok(())
}

/// 读取（容错语义）：不存在 → `Ok(None)`；损坏 → `Err(Corrupt)`（原文件保留）。
pub fn load_profile_meta(profile_dir: &Path) -> Result<Option<ProfileMeta>, PersistError> {
    let path = profile_meta_path(profile_dir);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(PersistError::Io(format!(
                "读取失败 {}：{e}",
                path.display()
            )))
        }
    };
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|e| PersistError::Corrupt {
            path: path.display().to_string(),
            error: e.to_string(),
        })
}

/// 新建默认 meta（persist 默认 false，§7.2 仅显式开启；profile_id 为
/// uuid v7 时间有序标识，§7.1）。
pub fn new_meta(origin: ProfileOrigin, source: Option<BrowserSource>) -> ProfileMeta {
    ProfileMeta {
        profile_id: Uuid::now_v7().to_string(),
        origin,
        source,
        persist: false,
        verify_result: None,
        created_at: now_unix_str(),
        last_used_at: None,
        state: ProfileState::Active,
    }
}

/// 持久化开关变更（§7.2）：读-改-写（persist 唯一源，U-11）；
/// meta 不存在时按引导登录语义初始化（U-11：持久化开关先于登录确定
/// profile 归属——保留则浏览器实例直接使用 managed profile）。
/// 损坏容错：meta 损坏时重建（写操作为用户显式动作，可覆盖损坏现场，
/// 与只读 [`load_profile_meta`] 的「保留现场」语义互补）。
pub fn set_persist(profile_dir: &Path, persist: bool) -> Result<ProfileMeta, PersistError> {
    let mut meta = match load_profile_meta(profile_dir) {
        Ok(Some(m)) => m,
        Ok(None) => new_meta(ProfileOrigin::GuidedLogin, None),
        Err(PersistError::Corrupt { path, .. }) => {
            tracing::warn!("profile_meta 损坏，写操作重建：{path}");
            new_meta(ProfileOrigin::GuidedLogin, None)
        }
        Err(e) => return Err(e),
    };
    meta.persist = persist;
    write_profile_meta(profile_dir, &meta)?;
    Ok(meta)
}

/// 校验结论落盘（验收 S3：回读校验结论写入 `profile_meta.verify_result`）。
/// 损坏容错同 [`set_persist`]：损坏时重建。
pub fn write_verify_result(
    profile_dir: &Path,
    verify: &VerifyReport,
) -> Result<ProfileMeta, PersistError> {
    let mut meta = match load_profile_meta(profile_dir) {
        Ok(Some(m)) => m,
        Ok(None) => new_meta(ProfileOrigin::Copied, None),
        Err(PersistError::Corrupt { path, .. }) => {
            tracing::warn!("profile_meta 损坏，写操作重建：{path}");
            new_meta(ProfileOrigin::Copied, None)
        }
        Err(e) => return Err(e),
    };
    meta.verify_result = Some(verify.clone());
    write_profile_meta(profile_dir, &meta)?;
    Ok(meta)
}

/// `managed/.staging/` 残留清扫（M-10 兜底，§3.4）：复制中断/进程被杀
/// 残留的瞬态中间态目录与文件**直删**（非用户资产，不走 trash）。
/// 返回清理的目录清单；staging 根本身保留（复制流程使用）。
///
/// 豁免 clippy 删除禁令：staging 是引擎自管的运行期中间态，直删语义与
/// browser/profile.rs `remove_ephemeral` 同豁免面（R-2 裁决
/// 「sessions/staging 直删，非用户资产」）。
#[allow(clippy::disallowed_methods)]
pub fn cleanup_staging(managed_root: &Path) -> Vec<PathBuf> {
    let staging_root = managed_root.join(crate::import::copy::STAGING_DIR);
    let mut removed = Vec::new();
    let Ok(entries) = std::fs::read_dir(&staging_root) else {
        return removed;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            // 残留清理（best-effort）：单个文件删不掉不阻断其余清理，但留痕
            if let Err(e) = std::fs::remove_file(&path) {
                tracing::warn!("清理 staging 残留文件失败：{}：{e}", path.display());
            }
            continue;
        }
        match std::fs::remove_dir_all(&path) {
            Ok(()) => {
                tracing::info!("清理 staging 残留：{}", path.display());
                removed.push(path);
            }
            Err(e) => tracing::warn!("清理 staging 失败：{}：{e}", path.display()),
        }
    }
    removed
}

/// 受管 profile 目录清单（§7.1：`managed/<name>/`；排除 `.staging` 等瞬态项）。
pub fn list_managed(managed_root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(managed_root) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| !n.starts_with('.'))
        })
        .collect()
}

/// 当前 unix 秒时间戳字符串（meta 时间字段，§7.1；避免引入 chrono 依赖）。
pub(crate) fn now_unix_str() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_default()
}

/// 短随机 id（原子写临时文件 / staging 临时目录名后缀，防并发碰撞）。
pub(crate) fn short_id() -> String {
    Uuid::new_v4().simple().to_string()[..8].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import::copy::STAGING_DIR;
    use crate::import::types::{AppBoundStatus, BrowserFamily, VerifyConclusion, VerifyReport};

    fn sample_meta() -> ProfileMeta {
        let mut meta = new_meta(
            ProfileOrigin::Copied,
            Some(BrowserSource {
                family: BrowserFamily::Chrome,
                browser_name: "Google Chrome".to_string(),
                user_data_dir: PathBuf::from("C:/Users/u/AppData/Local/Google/Chrome/User Data"),
                profile_dir: "Default".to_string(),
                display_name: "个人".to_string(),
            }),
        );
        meta.persist = true;
        meta
    }

    /// 读写往返：全字段保真（含 source / verify_result / 空字段 skip 语义）。
    #[test]
    fn write_load_roundtrip() {
        let dir = tempfile::tempdir().expect("临时目录");
        let pd = dir.path().join("m");
        std::fs::create_dir_all(&pd).expect("目录");
        let mut meta = sample_meta();
        meta.verify_result = Some(VerifyReport {
            conclusion: VerifyConclusion::Readable,
            n_db: 128,
            n_cdp: Some(128),
            app_bound: AppBoundStatus::Absent,
            checked_at: "1750000000".to_string(),
            notes: "db ok".to_string(),
        });
        write_profile_meta(&pd, &meta).expect("写入");
        let loaded = load_profile_meta(&pd).expect("读取").expect("存在");
        assert_eq!(loaded, meta);
        assert_eq!(
            loaded.source.as_ref().expect("source").profile_dir,
            "Default"
        );
        assert_eq!(loaded.verify_result.as_ref().expect("vr").n_db, 128);
        // 落盘文件合法 JSON（profile_meta.json 存在）
        assert!(pd.join(PROFILE_META_FILE).is_file());
    }

    /// 不存在 → Ok(None)。
    #[test]
    fn load_missing_is_none() {
        let dir = tempfile::tempdir().expect("临时目录");
        let pd = dir.path().join("m");
        std::fs::create_dir_all(&pd).expect("目录");
        assert!(load_profile_meta(&pd).expect("无 meta").is_none());
    }

    /// 损坏 JSON → Err(Corrupt)，原文件保留（不覆盖），修复后可写。
    #[test]
    fn corrupt_json_tolerated() {
        let dir = tempfile::tempdir().expect("临时目录");
        let pd = dir.path().join("m");
        std::fs::create_dir_all(&pd).expect("目录");
        let path = profile_meta_path(&pd);
        std::fs::write(&path, b"{ broken json !!").expect("写入损坏");
        let err = load_profile_meta(&pd).expect_err("损坏应报 Corrupt");
        assert!(matches!(err, PersistError::Corrupt { .. }));
        assert_eq!(
            std::fs::read_to_string(&path).expect("读回"),
            "{ broken json !!",
            "原文件未被覆盖（容错不破坏现场）"
        );
        // 上层重新初始化后写入成功
        set_persist(&pd, true).expect("重新初始化");
        assert!(load_profile_meta(&pd).expect("读取").expect("存在").persist);
    }

    /// 并发二次写：双线程交替 set_persist，最终文件必须为合法 meta
    /// （原子 rename 保证无半成品），persist 为两值之一。
    #[test]
    fn concurrent_writes_never_corrupt() {
        let dir = tempfile::tempdir().expect("临时目录");
        let pd = dir.path().join("m");
        std::fs::create_dir_all(&pd).expect("目录");
        let a = pd.clone();
        let t1 = std::thread::spawn(move || {
            for i in 0..20 {
                set_persist(&a, i % 2 == 0).expect("线程 1 写入");
            }
        });
        let b = pd.clone();
        let t2 = std::thread::spawn(move || {
            for i in 0..20 {
                set_persist(&b, i % 2 == 1).expect("线程 2 写入");
            }
        });
        t1.join().expect("join t1");
        t2.join().expect("join t2");
        let meta = load_profile_meta(&pd).expect("读取").expect("存在");
        assert!(
            !meta.profile_id.is_empty(),
            "文件为完整 meta（原子 rename 无半成品）"
        );
        // 无临时文件残留
        let leftovers: Vec<_> = std::fs::read_dir(&pd)
            .expect("读目录")
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "原子写不残留临时文件");
    }

    /// set_persist：无 meta 时按引导登录语义初始化；有 meta 时读-改-写。
    #[test]
    fn set_persist_switch() {
        let dir = tempfile::tempdir().expect("临时目录");
        let pd = dir.path().join("m");
        std::fs::create_dir_all(&pd).expect("目录");
        let meta = set_persist(&pd, true).expect("开启");
        assert!(meta.persist);
        assert_eq!(meta.origin, ProfileOrigin::GuidedLogin, "初始化语义");
        assert!(load_profile_meta(&pd).expect("读取").expect("存在").persist);
        // 再次切换
        let meta = set_persist(&pd, false).expect("关闭");
        assert!(!meta.persist);
        assert_eq!(meta.origin, ProfileOrigin::GuidedLogin, "原 meta 保留");
    }

    /// write_verify_result：结论落盘 profile_meta.verify_result（验收 S3）。
    #[test]
    fn verify_result_persisted() {
        let dir = tempfile::tempdir().expect("临时目录");
        let pd = dir.path().join("m");
        std::fs::create_dir_all(&pd).expect("目录");
        let verify = VerifyReport {
            conclusion: VerifyConclusion::Unreadable,
            n_db: 0,
            n_cdp: None,
            app_bound: AppBoundStatus::Detected,
            checked_at: "1750000001".to_string(),
            notes: "无持久 cookie".to_string(),
        };
        let meta = write_verify_result(&pd, &verify).expect("落盘");
        assert_eq!(
            meta.verify_result.as_ref().expect("vr").conclusion,
            VerifyConclusion::Unreadable
        );
        assert_eq!(
            load_profile_meta(&pd)
                .expect("读取")
                .expect("存在")
                .verify_result,
            Some(verify)
        );
    }

    /// new_meta 默认：persist=false、uuid 非空、时间非空、source 透传。
    #[test]
    fn new_meta_defaults() {
        let meta = new_meta(ProfileOrigin::GuidedLogin, None);
        assert!(!meta.persist, "持久化默认关闭（§7.2）");
        assert!(!meta.profile_id.is_empty());
        assert!(!meta.created_at.is_empty());
        assert_eq!(meta.state, ProfileState::Active);
        assert!(meta.source.is_none());
        assert!(meta.verify_result.is_none());
        let with_src = new_meta(ProfileOrigin::Copied, None);
        assert!(
            Uuid::parse_str(&with_src.profile_id).is_ok(),
            "profile_id 为合法 uuid"
        );
    }

    /// cleanup_staging：残留目录/文件被清，staging 根保留；无 staging 根 → 空。
    #[test]
    fn cleanup_staging_removes_leftovers() {
        let dir = tempfile::tempdir().expect("临时目录");
        let managed = dir.path().join("managed");
        // 无 staging 根 → 空（不报错）
        assert!(cleanup_staging(&managed).is_empty());
        std::fs::create_dir_all(&managed).expect("目录");
        // 注入残留
        let staging = managed.join(STAGING_DIR);
        std::fs::create_dir_all(staging.join("p1-abc")).expect("残留目录");
        std::fs::write(staging.join("p1-abc/Local State"), b"x").expect("写入");
        std::fs::write(staging.join("loose.tmp"), b"y").expect("残留文件");
        let removed = cleanup_staging(&managed);
        assert_eq!(removed.len(), 1, "目录残留被清（文件残留不计数）");
        assert!(staging.exists(), "staging 根保留（复制流程使用）");
        assert!(
            std::fs::read_dir(&staging)
                .expect("读 staging")
                .next()
                .is_none(),
            "staging 内无残留"
        );
    }

    /// list_managed：排除 .staging 与文件项。
    #[test]
    fn list_managed_excludes_staging() {
        let dir = tempfile::tempdir().expect("临时目录");
        let managed = dir.path().join("managed");
        std::fs::create_dir_all(managed.join("prof-a")).expect("目录");
        std::fs::create_dir_all(managed.join("prof-b")).expect("目录");
        std::fs::create_dir_all(managed.join(STAGING_DIR)).expect("目录");
        std::fs::write(managed.join("note.txt"), b"x").expect("写入");
        let list = list_managed(&managed);
        let names: Vec<String> = list
            .iter()
            .filter_map(|p| p.file_name().and_then(|n| n.to_str()).map(String::from))
            .collect();
        assert_eq!(names, vec!["prof-a".to_string(), "prof-b".to_string()]);
        // 根不存在 → 空
        assert!(list_managed(&dir.path().join("nope")).is_empty());
    }
}
