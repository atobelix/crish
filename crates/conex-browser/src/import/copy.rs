//! 最小文件集复制（维度 16 §3，迁移路径）
//!
//! - **白名单复制**（§3.1）：仅复制 `Local State` / `Cookies` /
//!   `Network/Cookies`(v132+) / `Bookmarks` / `Preferences`；白名单之外
//!   一律不复制（隐私面最小——即使来源新增未知敏感文件也不会被带入）
//! - **显式排除**（D-7 红线）：`Login Data` / `History` / `Web Data` 等
//!   列明供审计与向导文案引用（白名单机制下天然不复制）
//! - **锁检测前置**（§3.2）：`Singleton*` 存在 → `Running` 阻断；
//!   进程探测 / `*-wal`+`*-shm` 伴生 → `Uncertain`（用户确认后继续）；
//!   复制中 PermissionError（含 Windows WinError 32 共享冲突）→ 中止
//!   并清理 staging，回 `Running` 分支提示
//! - **staging 原子化**（M-10，§3.3）：先复制到 `managed/.staging/<tmp>/`
//!   再 rename 到 `managed/<profile_name>/`；中断/结构校验不通过 →
//!   清理 staging，目标目录不产生半成品
//!
//! 复制仅对源**只读**（不修改、不删除来源任何文件，源 mtime 不变）。
//!
//! 锁纪律（31-security-baseline B8）：本模块无锁。

use crate::browser::profile::sanitize_profile_name;
use crate::import::persist::short_id;
use crate::import::types::RunningStatus;
use std::path::{Path, PathBuf};

/// staging 目录名（瞬态中间态：不进 profile 列表、不参与生命周期恢复，M-10）。
pub const STAGING_DIR: &str = ".staging";

/// profile 级白名单（§3.1「必须/建议/可选」，存在才复制）：
/// `Cookies`（老布局）、`Network/Cookies`（v132+ 迁移布局，§1.2 按存在性处理）、
/// `Bookmarks`（书签 JSON，迁移一次性完成）、`Preferences`（站点偏好/语言，可选）。
pub const PROFILE_COPY_WHITELIST: &[&str] = &["Cookies", "Bookmarks", "Preferences"];

/// v132+ cookie 库相对路径（profile 内）。
pub const NETWORK_COOKIES_REL: &str = "Network/Cookies";

/// 显式排除（§3.1 排除表核心项，D-7 红线：密码库/历史/表单数据）。
/// 白名单机制天然不复制，此处列明供审计与向导「密码与历史不会迁移」文案引用。
pub const COPY_EXPLICIT_EXCLUDE: &[&str] = &[
    "Login Data",
    "Login Data For Account",
    "History",
    "History-journal",
    "Web Data",
];

/// 复制错误面（§3.2/§3.3 失败语义）。
#[derive(Debug, thiserror::Error)]
pub enum CopyError {
    /// 来源浏览器运行中（Singleton* 锁文件判定）→ 阻断复制。
    #[error("来源浏览器正在运行，请先完全关闭（包括后台进程与托盘）")]
    SourceLocked { status: RunningStatus },
    /// 复制中 PermissionError（含 Windows WinError 32 共享冲突）→ 中止并清理 staging。
    #[error("复制中止：文件被占用（{file}）：{error}")]
    LockConflict { file: String, error: String },
    /// 目标受管 profile 已存在（防覆盖用户资产）。
    #[error("目标 profile 已存在：{0}")]
    AlreadyExists(PathBuf),
    /// staging 结构校验不通过（Local State 缺失或 cookie 库缺失）。
    #[error("复制结果结构不完整：{0}")]
    StructureInvalid(String),
    /// staging → 目标 rename 失败（已回滚清理 staging）。
    #[error("复制提交失败（rename）：{0}")]
    RenameFailed(String),
    /// 源 profile 目录名非法（防路径注入）。
    #[error("非法的 profile 目录名：{0:?}")]
    InvalidProfileDir(String),
    /// 其他 IO 错误。
    #[error("复制失败：{0}")]
    Io(String),
}

/// 复制报告（§3.3 第 5 步：清单落盘 `profile_meta` 用）。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CopyReport {
    pub copied: usize,
    pub skipped: usize,
    /// 实际复制的文件（相对路径清单）。
    pub copied_files: Vec<String>,
}

/// 复制源（导入向导「来源浏览器 + profile + 目标命名」选择结果）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopySource {
    /// 来源用户数据目录（只读，绝不写）。
    pub user_data_dir: PathBuf,
    /// 来源 profile 目录名（Default / Profile 1 …；校验防路径注入）。
    pub profile_dir: String,
    /// 目标受管 profile 名（可用户命名；内部 sanitize 防路径注入）。
    pub profile_name: String,
}

/// 白名单原子复制（§3.3 流程 1-5）：
/// 锁检测 → staging 复制 → 结构校验 → rename 提交（M-10）。
pub fn copy_profile_atomic(
    source: &CopySource,
    managed_root: &Path,
) -> Result<CopyReport, CopyError> {
    copy_profile_atomic_with(source, managed_root, &mut |s, d| std::fs::copy(s, d))
}

/// 注入版核心（`copier` 可替换，测试注入 PermissionDenied / rename 失败场景）。
fn copy_profile_atomic_with<F>(
    source: &CopySource,
    managed_root: &Path,
    copier: &mut F,
) -> Result<CopyReport, CopyError>
where
    F: FnMut(&Path, &Path) -> std::io::Result<u64>,
{
    // 0. 锁检测前置（§3.2 主判据）：Singleton* → Running 阻断；
    //    Uncertain（仅进程/WAL 残留命中）不阻断——调用方负责用户确认
    if matches!(detect_running(&source.user_data_dir), RunningStatus::Running) {
        return Err(CopyError::SourceLocked {
            status: RunningStatus::Running,
        });
    }
    // 源 profile 目录名校验（防路径注入：仅允许单层目录名）
    validate_profile_dir(&source.profile_dir)?;

    // 1. 目标名消毒（§3.3 要点：sanitize 防路径分隔符/`..` 注入）
    let target_name = sanitize_profile_name(&source.profile_name);
    let target = managed_root.join(&target_name);
    if target.exists() {
        return Err(CopyError::AlreadyExists(target));
    }

    // 2. staging 准备（M-10：同文件系统中间态，目标对用户不可见）
    let staging_root = managed_root.join(STAGING_DIR);
    let tmp_id = short_id();
    let staging = staging_root.join(format!("{target_name}-{tmp_id}"));
    std::fs::create_dir_all(&staging).map_err(|e| {
        CopyError::Io(format!("创建 staging 失败 {}：{e}", staging.display()))
    })?;

    // 3-5. 白名单复制 → 结构校验 → rename 提交；
    //      任一失败统一清理 staging（M-10：中断不留残留，目标不产生半成品）
    let result = (|| {
        let mut report = CopyReport::default();
        let src_profile_dir = source.user_data_dir.join(&source.profile_dir);
        let dest_profile_dir = staging.join(&source.profile_dir);
        // 3a. Local State（用户数据根，§3.1 第 1 项）
        stage_file(
            copier,
            &mut report,
            "Local State",
            &source.user_data_dir.join("Local State"),
            &staging.join("Local State"),
        )?;
        // 3b. profile 级白名单（§3.1 第 2-5 项，存在才复制；两个 cookie 路径不合并）
        for name in PROFILE_COPY_WHITELIST {
            stage_file(
                copier,
                &mut report,
                &format!("{}/{}", source.profile_dir, name),
                &src_profile_dir.join(name),
                &dest_profile_dir.join(name),
            )?;
        }
        stage_file(
            copier,
            &mut report,
            &format!("{}/{}", source.profile_dir, NETWORK_COOKIES_REL),
            &src_profile_dir.join(NETWORK_COOKIES_REL),
            &dest_profile_dir.join(NETWORK_COOKIES_REL),
        )?;

        // 4. 结构校验（§3.3 第 4 步）：Local State 存在 且 至少一个 cookie 库存在
        let ls_ok = staging.join("Local State").is_file();
        let cookie_ok = dest_profile_dir.join("Cookies").is_file()
            || dest_profile_dir.join(NETWORK_COOKIES_REL).is_file();
        if !ls_ok || !cookie_ok {
            let reason = if !ls_ok { "Local State 缺失" } else { "cookie 库缺失" };
            return Err(CopyError::StructureInvalid(reason.to_string()));
        }

        // 5. rename 提交（M-10：同目录原子改名；失败回滚清理 staging）
        std::fs::rename(&staging, &target)
            .map_err(|e| CopyError::RenameFailed(format!(
                "{} → {}：{e}",
                staging.display(),
                target.display()
            )))?;
        Ok(report)
    })();
    if result.is_err() {
        let _ = cleanup_staging_dir(&staging);
    }
    result
}

/// 单文件 staging 复制（§3.1/§3.2）：
/// - 源不存在 → skipped（存在性处理）；
/// - PermissionError（含 WinError 32，§3.2 补充规则）→ 中止（LockConflict）；
/// - 其他错误 → warn + skipped（best-effort，结构校验兜底）。
fn stage_file<F>(
    copier: &mut F,
    report: &mut CopyReport,
    rel: &str,
    src: &Path,
    dest: &Path,
) -> Result<(), CopyError>
where
    F: FnMut(&Path, &Path) -> std::io::Result<u64>,
{
    if !src.is_file() {
        report.skipped += 1;
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            CopyError::Io(format!("创建目标父目录失败 {}：{e}", parent.display()))
        })?;
    }
    match copier(src, dest) {
        Ok(_) => {
            report.copied += 1;
            report.copied_files.push(rel.to_string());
            Ok(())
        }
        Err(e) if is_lock_conflict(&e) => Err(CopyError::LockConflict {
            file: src.display().to_string(),
            error: e.to_string(),
        }),
        Err(e) => {
            tracing::warn!("复制文件失败（跳过）：{}：{e}", src.display());
            report.skipped += 1;
            Ok(())
        }
    }
}

/// 复制中止判定（§3.2 补充规则）：PermissionError（含 Windows WinError 32
/// 共享冲突——实测其 kind=Uncategorized，须按 raw_os_error 识别）→ 中止复制
/// 并清理 staging。
pub fn is_lock_conflict(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::PermissionDenied || is_win_error_32(e)
}

/// WinError 32（Windows 共享冲突）精确识别（§3.2，诊断面）。
/// 实测 `ERROR_SHARING_VIOLATION(32)` 经 std 解码为 `Uncategorized`
/// （映射表不含 32），故以 `raw_os_error() == 32` 为准，kind 不参与判定。
#[cfg(windows)]
pub fn is_win_error_32(e: &std::io::Error) -> bool {
    e.raw_os_error() == Some(32)
}

/// 非 Windows 平台恒 false（无共享冲突语义）。
#[cfg(not(windows))]
pub fn is_win_error_32(_e: &std::io::Error) -> bool {
    false
}

/// 源 profile 目录名校验（防路径注入：拒绝空/`.`/`..`/路径分隔符）。
pub fn validate_profile_dir(dir: &str) -> Result<(), CopyError> {
    if dir.is_empty() || dir == "." || dir == ".." || dir.contains('/') || dir.contains('\\') {
        return Err(CopyError::InvalidProfileDir(dir.to_string()));
    }
    Ok(())
}

/// 锁检测（§3.2）：
/// - 主判据：`SingletonLock` / `SingletonCookie` / `SingletonSocket` 任一存在
///   → `Running`（阻断复制，Chromium 系跨平台通用）；
/// - 辅助判据（进程探测兜底，仅提示不阻断）：锁缺失但浏览器进程存在
///   → `Uncertain`（UI 询问「是否确认已关闭？」）；
/// - 辅助判据（DB 残留兜底）：`*-wal` 与 `*-shm` 伴生 → `Uncertain`
///   （「浏览器可能未完全退出」，Windows 语义兜底）。
pub fn detect_running(user_data_dir: &Path) -> RunningStatus {
    let lock_found = has_lock_files(user_data_dir);
    let process_found = platform::process_running(infer_process_name(user_data_dir));
    let wal_pair = has_wal_shm_pair(user_data_dir);
    classify_running(lock_found, process_found, wal_pair)
}

/// 纯分类（测试注入三布尔）。
fn classify_running(lock: bool, process: bool, wal_pair: bool) -> RunningStatus {
    if lock {
        RunningStatus::Running
    } else if process {
        RunningStatus::Uncertain {
            reason: "检测到浏览器进程（锁文件缺失，僵尸锁场景）".to_string(),
        }
    } else if wal_pair {
        RunningStatus::Uncertain {
            reason: "检测到 SQLite WAL 残留（*-wal 与 *-shm 伴生），浏览器可能未完全退出"
                .to_string(),
        }
    } else {
        RunningStatus::NotRunning
    }
}

/// Singleton* 锁文件存在性（§3.2 主判据；存在即 Running，不读 PID）。
fn has_lock_files(user_data_dir: &Path) -> bool {
    ["SingletonLock", "SingletonCookie", "SingletonSocket"]
        .iter()
        .any(|n| user_data_dir.join(n).exists())
}

/// `*-wal` 与 `*-shm` 伴生检测（§3.2 辅助判据 2）：
/// 扫描用户数据目录及其一级/二级子目录（Default、Default/Network 等）的成对残留。
fn has_wal_shm_pair(user_data_dir: &Path) -> bool {
    let mut dirs: Vec<PathBuf> = vec![user_data_dir.to_path_buf()];
    if let Ok(entries) = std::fs::read_dir(user_data_dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                dirs.push(p.clone());
                if let Ok(sub) = std::fs::read_dir(&p) {
                    for s in sub.flatten() {
                        if s.path().is_dir() {
                            dirs.push(s.path());
                        }
                    }
                }
            }
        }
    }
    for dir in dirs {
        let names: Vec<String> = std::fs::read_dir(&dir)
            .map(|es| {
                es.flatten()
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .collect()
            })
            .unwrap_or_default();
        if names.iter().any(|n| {
            n.strip_suffix("-wal")
                .is_some_and(|stem| names.iter().any(|x| x == &format!("{stem}-shm")))
        }) {
            return true;
        }
    }
    false
}

/// 按用户数据目录路径特征推断进程名（进程探测兜底用，§3.2 辅助判据 3）。
fn infer_process_name(user_data_dir: &Path) -> &'static str {
    let p = user_data_dir.to_string_lossy();
    #[cfg(windows)]
    {
        if p.contains("Edge") { "msedge.exe" } else { "chrome.exe" }
    }
    #[cfg(target_os = "linux")]
    {
        if p.contains("edge") {
            "microsoft-edge"
        } else if p.contains("chromium") {
            "chromium"
        } else {
            "google-chrome"
        }
    }
    #[cfg(target_os = "macos")]
    {
        if p.contains("Edge") { "Microsoft Edge" } else { "Google Chrome" }
    }
}

/// 直删单个 staging 目录（M-10：瞬态中间态非用户资产，不走 trash；
/// 豁免 clippy 删除禁令：与 browser/profile.rs `remove_ephemeral` 同豁免面，
/// R-2 裁决「sessions/staging 直删」）。
#[allow(clippy::disallowed_methods)]
fn cleanup_staging_dir(dir: &Path) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(dir).map_err(|e| format!("清理 staging 失败 {}：{e}", dir.display()))
}

/// 进程存在性探测实现（仅 Windows / unix 分支）。
#[cfg(windows)]
mod platform {
    /// Toolhelp32 快照遍历匹配 exe 名（§3.2 进程探测兜底）。
    #[allow(unsafe_code)]
    pub fn process_running(name: &str) -> bool {
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        };
        let want: Vec<u16> = name.encode_utf16().collect();
        // SAFETY：CreateToolhelp32Snapshot 标准 API；快照句柄用毕显式关闭
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return false;
        }
        // SAFETY：PROCESSENTRY32W 需先置 dwSize 再经遍历 API 填充
        let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        // SAFETY：Process32FirstW/Process32NextW 迭代进程快照
        let mut found = false;
        if unsafe { Process32FirstW(snapshot, &mut entry) } != 0 {
            loop {
                if wide_eq_ignore_case(&entry.szExeFile, &want) {
                    found = true;
                    break;
                }
                if unsafe { Process32NextW(snapshot, &mut entry) } == 0 {
                    break;
                }
            }
        }
        // SAFETY：关闭本函数创建的快照句柄
        unsafe { CloseHandle(snapshot) };
        found
    }

    /// 宽字符数组（NUL 截断）与目标名忽略大小写比较（Windows exe 名大小写不敏感）。
    fn wide_eq_ignore_case(buf: &[u16], want: &[u16]) -> bool {
        /// ASCII 小写化（非 ASCII 原值返回，u16 无 std 直供的 to_ascii_lowercase）。
        fn lower(c: u16) -> u16 {
            char::from_u32(c as u32)
                .map(|ch| ch.to_ascii_lowercase() as u16)
                .unwrap_or(c)
        }
        let len = buf.iter().take_while(|&&c| c != 0).count();
        len == want.len() && buf[..len].iter().zip(want).all(|(&a, &b)| lower(a) == lower(b))
    }
}

/// unix 进程探测：`pgrep -x`（固定系统工具调用、参数仅进程名、同步等待型——
/// 「内部进程管理原语」豁免面，见 clippy.toml 注释）。
#[cfg(unix)]
mod platform {
    /// pgrep 按进程名精确匹配（§3.2 进程探测兜底）。
    /// 豁免 clippy 子进程禁令：进程存活探测属「内部进程管理原语」豁免面
    /// （与 browser/profile.rs `kill -0` 同款）。
    #[allow(clippy::disallowed_methods)]
    pub fn process_running(name: &str) -> bool {
        std::process::Command::new("pgrep")
            .args(["-x", name])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造最小来源 fixture（含白名单 + 排除/噪音项，可开关 Network/Cookies）。
    fn source_fixture(dir: &Path, with_network_cookies: bool) -> PathBuf {
        let ud = dir.join("src-ud");
        let p = ud.join("Default");
        std::fs::create_dir_all(p.join("Network")).expect("目录");
        std::fs::write(ud.join("Local State"), b"{\"os_crypt\":{}}").expect("写入");
        std::fs::write(p.join("Cookies"), b"old-db").expect("写入");
        std::fs::write(p.join("Bookmarks"), b"{}").expect("写入");
        std::fs::write(p.join("Preferences"), b"pref").expect("写入");
        if with_network_cookies {
            std::fs::write(p.join("Network/Cookies"), b"new-db").expect("写入");
        }
        // 注入排除项与噪音（永不复制）
        std::fs::write(p.join("Login Data"), b"pw").expect("写入");
        std::fs::write(p.join("Login Data For Account"), b"pw2").expect("写入");
        std::fs::write(p.join("History"), b"hist").expect("写入");
        std::fs::write(p.join("Web Data"), b"wd").expect("写入");
        std::fs::create_dir_all(p.join("Extensions/x")).expect("目录");
        std::fs::write(p.join("Extensions/x/1.json"), b"{}").expect("写入");
        std::fs::create_dir_all(p.join("Cache")).expect("目录");
        std::fs::write(p.join("Cache/f"), b"c").expect("写入");
        std::fs::create_dir_all(p.join("IndexedDB")).expect("目录");
        std::fs::write(p.join("Sync Data"), b"s").expect("写入");
        ud
    }

    /// 递归收集目录内全部相对文件路径（断言白名单精确用；
    /// `root` 为固定相对化基准，递归不随子目录漂移）。
    fn walk_files(dir: &Path, root: &Path, out: &mut Vec<String>) {
        for e in std::fs::read_dir(dir).expect("读目录").flatten() {
            let p = e.path();
            if p.is_dir() {
                walk_files(&p, root, out);
            } else {
                out.push(p.strip_prefix(root).expect("前缀").to_string_lossy().replace('\\', "/"));
            }
        }
    }

    fn source(ud: &Path, profile_name: &str) -> CopySource {
        CopySource {
            user_data_dir: ud.to_path_buf(),
            profile_dir: "Default".to_string(),
            profile_name: profile_name.to_string(),
        }
    }

    /// 白名单精确断言：目标目录文件集合 == 白名单；排除/噪音项永不复制；
    /// 来源目录未被修改（mtime 由内容断言代替：源文件仍原样存在）。
    #[test]
    fn copy_whitelist_exact() {
        let dir = tempfile::tempdir().expect("临时目录");
        let ud = source_fixture(dir.path(), true);
        let managed = dir.path().join("managed");
        std::fs::create_dir_all(&managed).expect("目录");
        let report = copy_profile_atomic(&source(&ud, "p1"), &managed).expect("复制成功");
        let target = managed.join("p1");
        let mut files = Vec::new();
        walk_files(&target, &target, &mut files);
        files.sort();
        assert_eq!(
            files,
            vec![
                "Default/Bookmarks".to_string(),
                "Default/Cookies".to_string(),
                "Default/Network/Cookies".to_string(),
                "Default/Preferences".to_string(),
                "Local State".to_string(),
            ],
            "目标仅含白名单文件（精确断言）"
        );
        // 排除/噪音项永不复制
        for excluded in [
            "Login Data", "Login Data For Account", "History", "Web Data",
        ] {
            assert!(
                !target.join("Default").join(excluded).exists(),
                "排除项不得复制：{excluded}"
            );
        }
        for noise in ["Extensions", "Cache", "IndexedDB", "Sync Data"] {
            assert!(!target.join("Default").join(noise).exists(), "噪音项不得复制：{noise}");
        }
        // 报告：5 文件 copied，skipped 含噪音项
        assert_eq!(report.copied, 5);
        assert_eq!(report.copied_files.len(), 5);
        assert!(report.copied_files.contains(&"Local State".to_string()));
        assert!(report.copied_files.contains(&"Default/Network/Cookies".to_string()));
        // 来源完好：排除项仍在源（只读语义）
        assert!(ud.join("Default/Login Data").is_file());
        assert!(ud.join("Default/Extensions/x/1.json").is_file());
    }

    /// 存在性处理：Network/Cookies 不存在 → 只复制老布局；Bookmarks 缺失 → 跳过。
    #[test]
    fn copy_existence_handling() {
        let dir = tempfile::tempdir().expect("临时目录");
        let ud = dir.path().join("ud");
        let p = ud.join("Default");
        std::fs::create_dir_all(&p).expect("目录");
        std::fs::write(ud.join("Local State"), b"ls").expect("写入");
        std::fs::write(p.join("Cookies"), b"db").expect("写入");
        std::fs::write(p.join("Preferences"), b"p").expect("写入");
        let managed = dir.path().join("managed");
        std::fs::create_dir_all(&managed).expect("目录");
        let report = copy_profile_atomic(&source(&ud, "p1"), &managed).expect("复制成功");
        let target = managed.join("p1");
        assert!(target.join("Default/Cookies").is_file());
        assert!(!target.join("Default/Network/Cookies").exists());
        assert!(!target.join("Default/Bookmarks").exists());
        assert!(report.copied >= 3);
    }

    /// 锁检测三态（纯分类注入）。
    #[test]
    fn running_status_classify() {
        assert_eq!(classify_running(true, false, false), RunningStatus::Running);
        assert_eq!(classify_running(true, true, false), RunningStatus::Running, "锁优先");
        assert!(matches!(classify_running(false, true, false), RunningStatus::Uncertain { .. }));
        assert!(matches!(classify_running(false, false, true), RunningStatus::Uncertain { .. }));
        assert_eq!(classify_running(false, false, false), RunningStatus::NotRunning);
    }

    /// Singleton* 任一锁文件存在 → Running（参数化，各锁独立 tempdir 避免删除 API）。
    #[test]
    fn lock_files_detect() {
        for name in ["SingletonLock", "SingletonCookie", "SingletonSocket"] {
            let dir = tempfile::tempdir().expect("临时目录");
            std::fs::write(dir.path().join(name), b"x").expect("写入");
            assert!(has_lock_files(dir.path()), "存在 {name} 应判定 Running");
        }
        let clean = tempfile::tempdir().expect("临时目录");
        assert!(!has_lock_files(clean.path()), "无锁文件");
    }

    /// *-wal 与 *-shm 伴生检测（含子目录扫描）；单侧残留不命中。
    #[test]
    fn wal_shm_pair_detection() {
        let dir = tempfile::tempdir().expect("临时目录");
        let net = dir.path().join("Default/Network");
        std::fs::create_dir_all(&net).expect("目录");
        assert!(!has_wal_shm_pair(dir.path()), "无残留");
        std::fs::write(net.join("Cookies-wal"), b"w").expect("写入");
        assert!(!has_wal_shm_pair(dir.path()), "仅 -wal 不命中");
        std::fs::write(net.join("Cookies-shm"), b"s").expect("写入");
        assert!(has_wal_shm_pair(dir.path()), "-wal 与 -shm 伴生命中");
        // 根级目录同样生效
        std::fs::write(dir.path().join("History-wal"), b"w").expect("写入");
        std::fs::write(dir.path().join("History-shm"), b"s").expect("写入");
        assert!(has_wal_shm_pair(dir.path()));
    }

    /// 锁文件存在 → 复制阻断（SourceLocked），目标不产生残留。
    #[test]
    fn copy_blocked_when_running() {
        let dir = tempfile::tempdir().expect("临时目录");
        let ud = source_fixture(dir.path(), false);
        std::fs::write(ud.join("SingletonLock"), b"123").expect("写入");
        let managed = dir.path().join("managed");
        std::fs::create_dir_all(&managed).expect("目录");
        let err = copy_profile_atomic(&source(&ud, "p1"), &managed).expect_err("应阻断");
        assert!(matches!(err, CopyError::SourceLocked { .. }));
        assert!(!managed.join("p1").exists(), "阻断不得产生目标");
        assert!(!managed.join(STAGING_DIR).exists(), "锁阻断发生在 staging 创建前");
    }

    /// PermissionError（含 WinError 32）→ 中止（LockConflict）+ staging 清理 +
    /// 目标不产生半成品。
    #[test]
    fn lock_conflict_aborts_and_cleans_staging() {
        let dir = tempfile::tempdir().expect("临时目录");
        let ud = source_fixture(dir.path(), false);
        let managed = dir.path().join("managed");
        std::fs::create_dir_all(&managed).expect("目录");
        let src = source(&ud, "p1");
        let mut copier = |_: &Path, _: &Path| {
            Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "共享冲突"))
        };
        let err = copy_profile_atomic_with(&src, &managed, &mut copier).expect_err("应中止");
        assert!(matches!(err, CopyError::LockConflict { .. }));
        assert!(!managed.join("p1").exists(), "目标不产生半成品");
        let staging = managed.join(STAGING_DIR);
        if staging.exists() {
            let left: Vec<_> = std::fs::read_dir(&staging)
                .expect("读 staging")
                .flatten()
                .collect();
            assert!(left.is_empty(), "staging 已清理，残留 {left:?}");
        }
    }

    /// 其他复制错误 → best-effort 跳过（结构校验兜底仍拦截）。
    #[test]
    fn non_lock_errors_skipped() {
        let dir = tempfile::tempdir().expect("临时目录");
        let ud = dir.path().join("ud");
        let p = ud.join("Default");
        std::fs::create_dir_all(&p).expect("目录");
        std::fs::write(ud.join("Local State"), b"ls").expect("写入");
        std::fs::write(p.join("Cookies"), b"db").expect("写入");
        let managed = dir.path().join("managed");
        std::fs::create_dir_all(&managed).expect("目录");
        // 注入：Local State 复制失败（NotFound，非权限错误）→ 跳过 → 结构校验失败
        let src = source(&ud, "p1");
        let mut copier = |s: &Path, d: &Path| {
            if d.ends_with("Local State") {
                Err(std::io::Error::new(std::io::ErrorKind::NotFound, "模拟缺失"))
            } else {
                std::fs::copy(s, d)
            }
        };
        let err = copy_profile_atomic_with(&src, &managed, &mut copier).expect_err("结构校验拦截");
        assert!(matches!(err, CopyError::StructureInvalid(_)));
        assert!(!managed.join("p1").exists());
    }

    /// 结构校验：cookie 库缺失 → StructureInvalid（源仅 Preferences）。
    #[test]
    fn structure_invalid_without_cookies() {
        let dir = tempfile::tempdir().expect("临时目录");
        let ud = dir.path().join("ud");
        let p = ud.join("Default");
        std::fs::create_dir_all(&p).expect("目录");
        std::fs::write(ud.join("Local State"), b"ls").expect("写入");
        std::fs::write(p.join("Preferences"), b"p").expect("写入");
        let managed = dir.path().join("managed");
        std::fs::create_dir_all(&managed).expect("目录");
        let err = copy_profile_atomic(&source(&ud, "p1"), &managed).expect_err("应失败");
        assert!(matches!(err, CopyError::StructureInvalid(_)));
        assert!(!managed.join("p1").exists(), "目标未产生");
    }

    /// 目标已存在 → AlreadyExists（防覆盖用户资产）。
    #[test]
    fn target_exists_rejected() {
        let dir = tempfile::tempdir().expect("临时目录");
        let ud = source_fixture(dir.path(), false);
        let managed = dir.path().join("managed");
        std::fs::create_dir_all(managed.join("p1")).expect("目录");
        std::fs::write(managed.join("p1/profile_meta.json"), b"{}").expect("写入");
        let err = copy_profile_atomic(&source(&ud, "p1"), &managed).expect_err("应拒绝");
        assert!(matches!(err, CopyError::AlreadyExists(_)));
        assert!(managed.join("p1/profile_meta.json").is_file(), "既有资产不受影响");
    }

    /// rename 失败 → RenameFailed + staging 回滚 + 目标非半成品目录。
    #[test]
    fn rename_failure_rolls_back() {
        let dir = tempfile::tempdir().expect("临时目录");
        let ud = source_fixture(dir.path(), false);
        let managed = dir.path().join("managed");
        std::fs::create_dir_all(&managed).expect("目录");
        let src = source(&ud, "p1");
        // 注入：首次复制（Local State）时把目标路径占位为**非空目录**
        // （Windows/unix 上 rename 目录到已存在非空目录均失败 → rename 必失败）
        let managed_ph = managed.clone();
        let mut copier = |s: &Path, d: &Path| {
            if d.ends_with("Local State") {
                std::fs::create_dir_all(managed_ph.join("p1/sub")).expect("占位目录");
                std::fs::write(managed_ph.join("p1/sub/f.txt"), b"x").expect("占位内容");
            }
            std::fs::copy(s, d)
        };
        let err = copy_profile_atomic_with(&src, &managed, &mut copier).expect_err("应失败");
        assert!(matches!(err, CopyError::RenameFailed(_)));
        assert_eq!(
            std::fs::read_to_string(managed.join("p1/sub/f.txt")).expect("读占位"),
            "x",
            "占位目录保持原状（rename 未覆盖既有资产）"
        );
        let staging = managed.join(STAGING_DIR);
        if staging.exists() {
            assert!(
                std::fs::read_dir(&staging).expect("读 staging").next().is_none(),
                "staging 已回滚清理"
            );
        }
    }

    /// 路径安全：profile_name 注入（路径分隔符/`..`）→ sanitize 后目录名安全；
    /// 源 profile_dir 注入 → 拒绝。
    #[test]
    fn path_injection_rejected() {
        let dir = tempfile::tempdir().expect("临时目录");
        let ud = source_fixture(dir.path(), false);
        let managed = dir.path().join("managed");
        std::fs::create_dir_all(&managed).expect("目录");
        // profile_name 注入：sanitize 后单层目录名
        let report = copy_profile_atomic(&source(&ud, "../evil"), &managed).expect("sanitize 后安全");
        assert!(report.copied >= 4);
        let target = managed.join(".._evil");
        assert!(target.is_dir(), "目标为消毒后的单层目录");
        assert!(!dir.path().join("evil").exists(), "未逃逸到上级");
        // 分隔符注入（Windows 反斜杠在 sanitize 中也处理）
        let report = copy_profile_atomic(&source(&ud, "a\\b:c"), &managed).expect("分隔符消毒");
        assert!(report.copied >= 4);
        assert!(managed.join("a_b_c").is_dir());
        // 源 profile_dir 注入：拒绝
        let bad = CopySource {
            user_data_dir: ud.clone(),
            profile_dir: "../escape".to_string(),
            profile_name: "p2".to_string(),
        };
        let err = copy_profile_atomic(&bad, &managed).expect_err("源 profile 目录名应拒绝");
        assert!(matches!(err, CopyError::InvalidProfileDir(_)));
        assert!(!managed.join("p2").exists());
        // validate_profile_dir 单测
        assert!(validate_profile_dir("Default").is_ok());
        assert!(validate_profile_dir("Profile 1").is_ok());
        assert!(validate_profile_dir("").is_err());
        assert!(validate_profile_dir("..").is_err());
        assert!(validate_profile_dir("a/b").is_err());
        assert!(validate_profile_dir("a\\b").is_err());
    }

    /// WinError 32 识别（仅 Windows）：raw_os_error=32 即共享冲突
    /// （实测 kind=Uncategorized，判定以 raw 为准）；PermissionError 亦中止。
    #[cfg(windows)]
    #[test]
    fn win_error_32_detected() {
        let e = std::io::Error::from_raw_os_error(32);
        assert!(is_win_error_32(&e), "raw=32 识别为共享冲突（kind=Uncategorized 不阻碍）");
        assert!(is_lock_conflict(&e), "共享冲突 → 中止复制");
        let other = std::io::Error::from_raw_os_error(5);
        assert!(!is_win_error_32(&other), "raw=5 非 WinError 32");
        assert!(is_lock_conflict(&other), "PermissionError 一律中止（§3.2「等 PermissionError」）");
    }

    /// 非 Windows：is_win_error_32 恒 false。
    #[cfg(not(windows))]
    #[test]
    fn win_error_32_not_on_unix() {
        let e = std::io::Error::from_raw_os_error(32);
        assert!(!is_win_error_32(&e));
        assert!(!is_lock_conflict(&e), "unix 无共享冲突语义");
    }

    /// 成功复制后 staging 根内无残留（根目录本身保留，供下次复制复用）。
    #[test]
    fn no_staging_left_after_success() {
        let dir = tempfile::tempdir().expect("临时目录");
        let ud = source_fixture(dir.path(), false);
        let managed = dir.path().join("managed");
        std::fs::create_dir_all(&managed).expect("目录");
        copy_profile_atomic(&source(&ud, "p1"), &managed).expect("复制成功");
        let staging = managed.join(STAGING_DIR);
        if staging.exists() {
            assert!(
                std::fs::read_dir(&staging).expect("读 staging").next().is_none(),
                "成功后 staging 内无残留"
            );
        }
    }
}
