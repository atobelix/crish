//! 来源发现（维度 16 §2）
//!
//! - 三平台用户数据目录探测表（§2.1：Windows `%LOCALAPPDATA%` 展开、
//!   macOS `~/Library/Application Support`、Linux `$XDG_CONFIG_HOME`/`~/.config`）
//! - Local State info_cache 读取 profile 列表（§2.2，display_name 回退链）
//! - 自定义目录校验（§2.3）
//! - App-Bound 前置检测（S0 实证修订 §4.1：`app_bound_encrypted_key` 字段
//!   存在性判定，依据 S0-02 报告 §2.3——本机 Chrome 151 无该字段、跨家族
//!   回读成功，故「回读失败 ⇒ App-Bound」判据不可依赖，判定前置化）
//!
//! 全部探测只读、不创建目录；Local State 缺失/损坏一律返回空列表
//! （UI 提示「未发现可用的浏览器 profile」并提供自定义目录入口，§2.2 容错）。
//!
//! 锁纪律（31-security-baseline B8）：本模块无锁。

use crate::import::types::{AppBoundStatus, BrowserFamily, BrowserSource, ChromeProfile};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// 用户数据目录候选（平台路径表产物，供 [`filter_existing`] 存在性过滤）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserDataCandidate {
    pub family: BrowserFamily,
    pub browser_name: &'static str,
    pub dir: PathBuf,
}

/// 三平台路径表（§2.1 表；`base` 为平台数据根，测试注入临时目录）。
///
/// Windows：`%LOCALAPPDATA%` 展开（dirs::data_local_dir 兜底）。
#[cfg(windows)]
pub fn platform_candidates(base: &Path) -> Vec<UserDataCandidate> {
    let cand = |family, name: &'static str, rel: &str| UserDataCandidate {
        family,
        browser_name: name,
        dir: base.join(rel),
    };
    vec![
        cand(
            BrowserFamily::Chrome,
            "Google Chrome",
            "Google/Chrome/User Data",
        ),
        cand(
            BrowserFamily::Chrome,
            "Google Chrome Canary",
            "Google/Chrome SxS/User Data",
        ),
        cand(
            BrowserFamily::Edge,
            "Microsoft Edge",
            "Microsoft/Edge/User Data",
        ),
        cand(
            BrowserFamily::Edge,
            "Microsoft Edge Beta",
            "Microsoft/Edge Beta/User Data",
        ),
        cand(
            BrowserFamily::Edge,
            "Microsoft Edge Dev",
            "Microsoft/Edge Dev/User Data",
        ),
        cand(
            BrowserFamily::Edge,
            "Microsoft Edge Canary",
            "Microsoft/Edge SxS/User Data",
        ),
        cand(BrowserFamily::Chromium, "Chromium", "Chromium/User Data"),
    ]
}

/// macOS 路径常量（§2.1：`~/Library/Application Support` 下）。
#[cfg(target_os = "macos")]
pub fn platform_candidates(base: &Path) -> Vec<UserDataCandidate> {
    let cand = |family, name: &'static str, rel: &str| UserDataCandidate {
        family,
        browser_name: name,
        dir: base.join(rel),
    };
    vec![
        cand(BrowserFamily::Chrome, "Google Chrome", "Google/Chrome"),
        cand(
            BrowserFamily::Chrome,
            "Google Chrome Canary",
            "Google/Chrome Canary",
        ),
        cand(BrowserFamily::Edge, "Microsoft Edge", "Microsoft Edge"),
        cand(BrowserFamily::Chromium, "Chromium", "Chromium"),
    ]
}

/// Linux 路径常量（§2.1：`~/.config` 下，Chrome 系用小写目录名）。
#[cfg(target_os = "linux")]
pub fn platform_candidates(base: &Path) -> Vec<UserDataCandidate> {
    let cand = |family, name: &'static str, rel: &str| UserDataCandidate {
        family,
        browser_name: name,
        dir: base.join(rel),
    };
    vec![
        cand(BrowserFamily::Chrome, "Google Chrome", "google-chrome"),
        cand(BrowserFamily::Chromium, "Chromium", "chromium"),
        cand(BrowserFamily::Edge, "Microsoft Edge", "microsoft-edge"),
    ]
}

/// 平台数据根（§2.1 表 base）：
/// Windows `%LOCALAPPDATA%`；macOS `~/Library/Application Support`；
/// Linux `$XDG_CONFIG_HOME`（缺省 `~/.config`）。
fn platform_base() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        dirs::data_local_dir()
    }
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir().map(|h| h.join("Library").join("Application Support"))
    }
    #[cfg(target_os = "linux")]
    {
        dirs::config_dir()
    }
}

/// 来源发现入口（§2.1）：探测表 + 存在性过滤，返回全部存在的来源浏览器。
pub fn discover_sources() -> Vec<BrowserSource> {
    match platform_base() {
        Some(base) => filter_existing(platform_candidates(&base)),
        None => Vec::new(),
    }
}

/// 存在性过滤（§2.1 防误报空目录：目录存在 且 含 Local State 或 profile 子目录）。
/// 返回浏览器级来源（`profile_dir`/`display_name` 为空，选定 profile 后组合）。
pub fn filter_existing(candidates: Vec<UserDataCandidate>) -> Vec<BrowserSource> {
    candidates
        .into_iter()
        .filter(|c| is_valid_user_data_dir(&c.dir))
        .map(|c| BrowserSource {
            family: c.family,
            browser_name: c.browser_name.to_string(),
            user_data_dir: c.dir,
            profile_dir: String::new(),
            display_name: String::new(),
        })
        .collect()
}

/// 有效用户数据目录：目录存在 且（含 Local State 或含 profile 子目录）。
fn is_valid_user_data_dir(dir: &Path) -> bool {
    dir.is_dir() && (dir.join("Local State").is_file() || has_profile_subdir(dir))
}

/// 是否存在 profile 子目录（形如 Default/Profile N，含 Cookies 或 Bookmarks 任一文件）。
fn has_profile_subdir(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries.flatten().any(|e| {
                let p = e.path();
                p.is_dir()
                    && (p.join("Cookies").is_file()
                        || p.join("Network").join("Cookies").is_file()
                        || p.join("Bookmarks").is_file())
            })
        })
        .unwrap_or(false)
}

/// 读取 Local State info_cache → profile 列表（§2.2）。
///
/// 容错：Local State 缺失 / JSON 损坏 / info_cache 缺失或非 dict → 空列表（不报错）；
/// info_cache 值为非对象 → 跳过该项；仅列出**存在对应 profile 目录**且含
/// Cookies 或 Bookmarks 的项（避免列出已删除的残留项）。
pub fn list_profiles(user_data_dir: &Path, family: BrowserFamily) -> Vec<ChromeProfile> {
    let json_text = match std::fs::read_to_string(user_data_dir.join("Local State")) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    let root: Value = match serde_json::from_str(&json_text) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let cache = match root
        .get("profile")
        .and_then(|p| p.get("info_cache"))
        .and_then(Value::as_object)
    {
        Some(c) => c,
        None => return Vec::new(),
    };
    let mut out: Vec<ChromeProfile> = Vec::new();
    for (directory, info) in cache {
        let Some(info_obj) = info.as_object() else {
            continue;
        };
        // display_name 回退链：name → user_name → directory（§2.2 表）
        let display_name = info_obj
            .get("name")
            .and_then(Value::as_str)
            .or_else(|| info_obj.get("user_name").and_then(Value::as_str))
            .unwrap_or(directory)
            .to_string();
        let is_using_default_name = info_obj
            .get("is_using_default_name")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if profile_dir_has_data(user_data_dir, directory) {
            out.push(ChromeProfile {
                directory: directory.clone(),
                display_name,
                is_using_default_name,
                family,
                user_data_dir: user_data_dir.to_path_buf(),
            });
        }
    }
    out.sort_by(|a, b| a.directory.cmp(&b.directory));
    out
}

/// profile 目录存在且含 Cookies（老/新布局）或 Bookmarks 任一文件（§2.2 过滤条件）。
fn profile_dir_has_data(user_data_dir: &Path, directory: &str) -> bool {
    let dir = user_data_dir.join(directory);
    if !dir.is_dir() {
        return false;
    }
    dir.join("Cookies").is_file()
        || dir.join("Network").join("Cookies").is_file()
        || dir.join("Bookmarks").is_file()
}

/// 自定义目录校验（§2.3）：含 Local State 或含 profile 子目录，否则拒绝。
pub fn validate_custom_dir(dir: &Path) -> Result<(), String> {
    if !dir.is_dir() {
        return Err("目录不存在或不可读".to_string());
    }
    if dir.join("Local State").is_file() || has_profile_subdir(dir) {
        Ok(())
    } else {
        Err("该目录不含 Local State 或浏览器 profile 子目录".to_string())
    }
}

/// App-Bound 前置检测（S0 实证修订 §4.1 第 1 条 / S0-02 §2.3）：
/// 读来源 Local State JSON，`os_crypt.app_bound_encrypted_key` 字段存在
/// （非 null）⇒ App-Bound 加密启用 ⇒ 提示「同家族可迁移、跨家族不可行」，
/// 并据此决定是否执行复制（用户确认）。
///
/// Local State 缺失 / JSON 损坏 / 字段缺失 → `Absent`（按未启用处理——
/// S0 实测本机 Chrome 151 形态：仅 `os_crypt.encrypted_key`，无 app-bound 字段）。
pub fn detect_app_bound(local_state: &Path) -> AppBoundStatus {
    let Ok(text) = std::fs::read_to_string(local_state) else {
        return AppBoundStatus::Absent;
    };
    let Ok(root) = serde_json::from_str::<Value>(&text) else {
        return AppBoundStatus::Absent;
    };
    match root
        .get("os_crypt")
        .and_then(|o| o.get("app_bound_encrypted_key"))
    {
        Some(v) if !v.is_null() => AppBoundStatus::Detected,
        _ => AppBoundStatus::Absent,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_local_state(dir: &Path, json: &str) {
        std::fs::create_dir_all(dir).expect("目录");
        std::fs::write(dir.join("Local State"), json).expect("写入");
    }

    /// 路径表形态（各平台分支，注入 base 断言相对路径拼接）。
    #[test]
    fn path_table_shape() {
        let base = Path::new("BASE");
        let table = platform_candidates(base);
        #[cfg(windows)]
        {
            assert_eq!(table.len(), 7, "Windows 表 7 项");
            assert_eq!(table[0].family, BrowserFamily::Chrome);
            assert_eq!(table[0].browser_name, "Google Chrome");
            assert_eq!(table[0].dir, base.join("Google/Chrome/User Data"));
            assert_eq!(
                table[1].dir,
                base.join("Google/Chrome SxS/User Data"),
                "Canary SxS"
            );
            assert_eq!(table[2].browser_name, "Microsoft Edge");
            assert!(table
                .iter()
                .any(|c| c.browser_name == "Microsoft Edge Beta"));
            assert!(table.iter().any(|c| c.browser_name == "Microsoft Edge Dev"));
            assert!(table
                .iter()
                .any(|c| c.browser_name == "Microsoft Edge Canary"));
            assert!(table.iter().any(|c| c.family == BrowserFamily::Chromium));
            assert!(table.iter().all(|c| c.dir.starts_with(base)));
        }
        #[cfg(target_os = "macos")]
        {
            assert_eq!(table.len(), 4);
            assert_eq!(table[0].dir, base.join("Google/Chrome"));
            assert_eq!(table[1].dir, base.join("Google/Chrome Canary"));
            assert!(table.iter().any(|c| c.browser_name == "Microsoft Edge"));
            assert!(table.iter().any(|c| c.family == BrowserFamily::Chromium));
        }
        #[cfg(target_os = "linux")]
        {
            assert_eq!(table.len(), 3);
            assert_eq!(table[0].dir, base.join("google-chrome"));
            assert_eq!(table[1].dir, base.join("chromium"));
            assert_eq!(table[2].dir, base.join("microsoft-edge"));
        }
    }

    /// 找不到浏览器 → 空列表（空候选 / 全不存在的候选）。
    #[test]
    fn discover_no_browser_empty() {
        assert!(filter_existing(vec![]).is_empty());
        let dir = tempfile::tempdir().expect("临时目录");
        let base = dir.path();
        // 候选目录全部不存在
        let none = platform_candidates(base)
            .into_iter()
            .map(|c| UserDataCandidate {
                dir: c.dir.join("missing"),
                ..c
            })
            .collect();
        assert!(filter_existing(none).is_empty());
    }

    /// 存在性过滤：Local State 或 profile 子目录任一命中即列出；空目录排除。
    #[test]
    fn filter_existing_validity() {
        let dir = tempfile::tempdir().expect("临时目录");
        let base = dir.path();
        // 命中 1：仅 Local State
        let with_ls = base.join("A/User Data");
        write_local_state(&with_ls, "{}");
        // 命中 2：无 Local State，仅 profile 子目录（含 Cookies）
        let with_profile = base.join("B/User Data");
        std::fs::create_dir_all(with_profile.join("Default")).expect("目录");
        std::fs::write(with_profile.join("Default/Cookies"), b"db").expect("写入");
        // 排除：空目录 / 无数据的 profile 子目录
        let empty = base.join("C/User Data");
        std::fs::create_dir_all(&empty).expect("目录");
        let ghost = base.join("D/User Data");
        std::fs::create_dir_all(ghost.join("Default")).expect("目录");
        // 排除：非目录
        let not_dir = base.join("E/User Data");
        std::fs::create_dir_all(not_dir.parent().expect("父目录")).expect("目录");
        std::fs::write(&not_dir, b"file").expect("写入");

        let table = vec![
            UserDataCandidate {
                family: BrowserFamily::Chrome,
                browser_name: "A",
                dir: with_ls,
            },
            UserDataCandidate {
                family: BrowserFamily::Edge,
                browser_name: "B",
                dir: with_profile,
            },
            UserDataCandidate {
                family: BrowserFamily::Chromium,
                browser_name: "C",
                dir: empty,
            },
            UserDataCandidate {
                family: BrowserFamily::Chrome,
                browser_name: "D",
                dir: ghost,
            },
            UserDataCandidate {
                family: BrowserFamily::Edge,
                browser_name: "E",
                dir: not_dir,
            },
        ];
        let found = filter_existing(table);
        assert_eq!(found.len(), 2, "仅 A/B 命中");
        assert_eq!(found[0].family, BrowserFamily::Chrome);
        assert_eq!(found[0].browser_name, "A");
        assert_eq!(found[1].family, BrowserFamily::Edge);
        assert!(found
            .iter()
            .all(|s| s.profile_dir.is_empty() && s.display_name.is_empty()));
    }

    /// list_profiles 正常路径：回退链（name → user_name → directory）+
    /// is_using_default_name + 目录存在性过滤 + 排序。
    #[test]
    fn list_profiles_happy_path() {
        let dir = tempfile::tempdir().expect("临时目录");
        let ud = dir.path().join("ud");
        std::fs::create_dir_all(ud.join("Default/Network")).expect("目录");
        std::fs::create_dir_all(ud.join("Profile 1")).expect("目录");
        std::fs::create_dir_all(ud.join("Profile 2")).expect("目录");
        std::fs::write(ud.join("Default/Network/Cookies"), b"db").expect("写入");
        std::fs::write(ud.join("Profile 1/Bookmarks"), b"{}").expect("写入");
        std::fs::write(ud.join("Profile 2/Preferences"), b"p").expect("写入");
        std::fs::write(ud.join("Profile 2/Bookmarks"), b"{}").expect("写入");
        write_local_state(
            &ud,
            r#"{
                "profile": { "info_cache": {
                    "Default":  { "name": "个人", "is_using_default_name": false },
                    "Profile 1": { "user_name": "work" },
                    "Profile 2": { "is_using_default_name": true },
                    "Ghost":    { "name": "已删除残留" }
                } }
            }"#,
        );
        let list = list_profiles(&ud, BrowserFamily::Chrome);
        assert_eq!(list.len(), 3, "Ghost 无对应目录 → 过滤");
        assert_eq!(list[0].directory, "Default");
        assert_eq!(list[0].display_name, "个人", "name 优先");
        assert!(!list[0].is_using_default_name);
        assert_eq!(list[1].directory, "Profile 1");
        assert_eq!(list[1].display_name, "work", "name 缺失 → 回退 user_name");
        assert_eq!(list[2].directory, "Profile 2");
        assert_eq!(list[2].display_name, "Profile 2", "均缺失 → 回退 directory");
        assert!(list[2].is_using_default_name, "显式 true 保留");
        assert!(list.iter().all(|p| p.family == BrowserFamily::Chrome));
    }

    /// list_profiles 容错：Local State 缺失 / 损坏 JSON / info_cache 非 dict / 值非对象。
    #[test]
    fn list_profiles_tolerance() {
        let dir = tempfile::tempdir().expect("临时目录");
        let ud = dir.path().join("ud");
        std::fs::create_dir_all(ud.join("Default")).expect("目录");
        std::fs::write(ud.join("Default/Cookies"), b"db").expect("写入");
        // 1. Local State 缺失
        assert!(list_profiles(&ud, BrowserFamily::Chrome).is_empty());
        // 2. 损坏 JSON
        write_local_state(&ud, "{ not json !!");
        assert!(list_profiles(&ud, BrowserFamily::Chrome).is_empty());
        // 3. info_cache 非 dict（数组）
        write_local_state(&ud, r#"{"profile": { "info_cache": [1,2] }}"#);
        assert!(list_profiles(&ud, BrowserFamily::Chrome).is_empty());
        // 4. profile 节点缺失
        write_local_state(&ud, r#"{"os_crypt": {}}"#);
        assert!(list_profiles(&ud, BrowserFamily::Chrome).is_empty());
        // 5. info_cache 值为非对象 → 该项跳过，其余正常
        write_local_state(
            &ud,
            r#"{"profile": { "info_cache": { "Default": "not-an-object", "Ghost": { "name": "x" } } }}"#,
        );
        let list = list_profiles(&ud, BrowserFamily::Chrome);
        assert!(
            list.is_empty(),
            "Default 值为字符串 → 跳过；Ghost 无目录 → 过滤"
        );
        // 6. is_using_default_name 缺失 → false 默认
        write_local_state(
            &ud,
            r#"{"profile": { "info_cache": { "Default": { "name": "x" } } }}"#,
        );
        let list = list_profiles(&ud, BrowserFamily::Chrome);
        assert_eq!(list.len(), 1);
        assert!(!list[0].is_using_default_name);
    }

    /// 自定义目录校验（§2.3）。
    #[test]
    fn validate_custom_dir_cases() {
        let dir = tempfile::tempdir().expect("临时目录");
        let base = dir.path();
        // 有效：含 Local State
        let a = base.join("a");
        write_local_state(&a, "{}");
        assert!(validate_custom_dir(&a).is_ok());
        // 有效：含 profile 子目录
        let b = base.join("b");
        std::fs::create_dir_all(b.join("Default")).expect("目录");
        std::fs::write(b.join("Default/Bookmarks"), b"{}").expect("写入");
        assert!(validate_custom_dir(&b).is_ok());
        // 无效：空目录
        let c = base.join("c");
        std::fs::create_dir_all(&c).expect("目录");
        assert!(validate_custom_dir(&c).is_err());
        // 无效：无数据的 profile 子目录
        let d = base.join("d");
        std::fs::create_dir_all(d.join("Default")).expect("目录");
        assert!(validate_custom_dir(&d).is_err());
        // 无效：目录不存在
        assert!(validate_custom_dir(&base.join("nope")).is_err());
    }

    /// App-Bound 前置检测：字段存在 / 缺失 / JSON 变体（大小写/嵌套位置）/ 损坏。
    #[test]
    fn detect_app_bound_variants() {
        let dir = tempfile::tempdir().expect("临时目录");
        let ls = dir.path().join("Local State");
        // 1. 字段存在（字符串值）→ Detected
        std::fs::write(
            &ls,
            r#"{"os_crypt": {"app_bound_encrypted_key": "abc", "encrypted_key": "def"}}"#,
        )
        .expect("写入");
        assert_eq!(detect_app_bound(&ls), AppBoundStatus::Detected);
        // 2. 字段缺失（S0 实测本机形态：仅 encrypted_key）→ Absent
        std::fs::write(&ls, r#"{"os_crypt": {"encrypted_key": "def"}}"#).expect("写入");
        assert_eq!(detect_app_bound(&ls), AppBoundStatus::Absent);
        // 3. 大写键变体（JSON 大小写敏感，不误报）
        std::fs::write(&ls, r#"{"os_crypt": {"APP_BOUND_ENCRYPTED_KEY": "abc"}}"#).expect("写入");
        assert_eq!(detect_app_bound(&ls), AppBoundStatus::Absent);
        // 4. 顶层同名键（嵌套位置精确：须在 os_crypt 下，不误报）
        std::fs::write(&ls, r#"{"app_bound_encrypted_key": "abc"}"#).expect("写入");
        assert_eq!(detect_app_bound(&ls), AppBoundStatus::Absent);
        // 5. null 值 → 按缺失处理
        std::fs::write(&ls, r#"{"os_crypt": {"app_bound_encrypted_key": null}}"#).expect("写入");
        assert_eq!(detect_app_bound(&ls), AppBoundStatus::Absent);
        // 6. 损坏 JSON → Absent
        std::fs::write(&ls, b"\x00\x01not-json").expect("写入");
        assert_eq!(detect_app_bound(&ls), AppBoundStatus::Absent);
        // 7. 文件缺失 → Absent
        assert_eq!(
            detect_app_bound(&ls.parent().unwrap().join("Missing")),
            AppBoundStatus::Absent
        );
    }
}
