//! Profile 目录管理（维度 10 §4）
//!
//! 目录布局（R-2 裁决为单一权威，全部位于用户私有数据根）：
//!
//! ```text
//! <data_root>/conex/browser/
//! ├── browsers/                          # CfT 二进制缓存：chrome-<version>/
//! ├── sessions/<session-uuid>/           # 临时 profile（§4.2）：会话级，用完即删（直删）
//! └── managed/<profile_name>/            # 受管 profile（§4.3）：用户导入/持久化，删除走 trash
//! ```
//!
//! 删除策略（R-2）：`sessions/` 临时 profile 用 `remove_dir_all` 直接删除（运行期受管目录
//! 而非用户资产，与 AGENTS.md 会话产出目录清理语义不同）；`managed/` 受管 profile 是用户
//! 资产，删除必须走 conex-fs trash（trash.rs 铁律，不直接 remove）。
//!
//! 锁纪律（31-security-baseline B8）：本模块无锁；`data_root` 定位失败返回错误而非 panic。

use crate::browser::endpoint::SessionToken;
use crate::browser::ProcessError;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// 统一根名称（应用目录名统一 conex，撤销 Crish 命名，R-2）。
pub const APP_DIR_NAME: &str = "conex";
/// 浏览器数据根（`<data_root>/conex/browser/`）。
pub const BROWSER_ROOT_NAME: &str = "browser";
/// 会话临时 profile 目录名。
pub const SESSIONS_DIR: &str = "sessions";
/// 受管 profile 目录名。
pub const MANAGED_DIR: &str = "managed";
/// 回收站目录名（`<data_root>/conex/trash/`，TrashService 根）。
pub const TRASH_DIR: &str = "trash";
/// 导航栈落盘文件名（会话 profile 根，§6.4）。
pub const NAV_STACK_FILE: &str = "nav_stack.json";
/// 面板 UI 状态（纯 UI，不承载持久化开关，R-2）。
pub const PANEL_STATE_FILE: &str = "panel-state.json";
/// 受管 profile 元数据（persist 开关唯一存于此，R-2）。
pub const PROFILE_META_FILE: &str = "profile_meta.json";

/// 平台数据根（§4.1）：
/// Windows `%LOCALAPPDATA%`；macOS `~/Library/Application Support`；
/// Linux `$XDG_DATA_HOME`（缺省 `~/.local/share`）。
pub fn data_root() -> Result<PathBuf, ProcessError> {
    #[cfg(windows)]
    let dir = dirs::data_local_dir();
    #[cfg(target_os = "macos")]
    let dir = dirs::data_dir();
    #[cfg(not(any(windows, target_os = "macos")))]
    let dir = dirs::data_local_dir();
    dir.ok_or_else(|| ProcessError::Internal("无法定位平台数据根（data_root）".to_string()))
        .map(|p| p.join(APP_DIR_NAME))
}

/// 浏览器统一根：`<data_root>/conex/browser/`（R-2）。
pub fn browser_root(data_root: &Path) -> PathBuf {
    data_root.join(BROWSER_ROOT_NAME)
}

/// 会话临时 profile 根：`<root>/sessions/`。
pub fn sessions_root(root: &Path) -> PathBuf {
    root.join(SESSIONS_DIR)
}

/// 受管 profile 根：`<root>/managed/`。
pub fn managed_root(root: &Path) -> PathBuf {
    root.join(MANAGED_DIR)
}

/// 回收站根：`<data_root>/conex/trash/`（TrashService 用）。
pub fn trash_root(data_root: &Path) -> PathBuf {
    data_root.join(TRASH_DIR)
}

/// 会话临时 profile 路径（纯拼接，不落盘）。
pub fn ephemeral_dir(root: &Path, token: &SessionToken) -> PathBuf {
    sessions_root(root).join(token.as_str())
}

/// 创建会话临时 profile 目录（§4.2：create_dir_all；目录名 = 会话 uuid，天然唯一）。
pub fn create_ephemeral(root: &Path, token: &SessionToken) -> Result<PathBuf, ProcessError> {
    let dir = ephemeral_dir(root, token);
    std::fs::create_dir_all(&dir).map_err(|e| {
        ProcessError::Internal(format!("创建临时 profile 失败 {}：{e}", dir.display()))
    })?;
    Ok(dir)
}

/// 直删临时 profile（§4.4：sessions/ 直接删除，不走 trash）+
/// 删除失败 3 次重试间隔 100ms（agent-browser chrome.rs:70-90 同款）。
/// 豁免 clippy 删除禁令：R-2 裁决显式要求 sessions/ 临时 profile 直删
/// （运行期受管目录而非用户资产，删除语义与 AGENTS.md 会话产出目录不同），
/// 受管 profile 才走 trash（`trash_managed`）。
///
/// M8 修复：async fn（调用链 `BrowserManager::stop`/`cleanup_profile` 均处于
/// async 上下文）——重试等待改 `tokio::time::sleep`，不再用同步 `std::thread::sleep`
/// 阻塞 tokio worker 线程。
#[allow(clippy::disallowed_methods)]
pub async fn remove_ephemeral(dir: &Path) -> Result<(), ProcessError> {
    remove_dir_retry(dir, 3, Duration::from_millis(100)).await
}

/// 删除目录（带重试；不存在视为成功）。
/// 豁免理由同 `remove_ephemeral`（R-2 直删裁决）。
///
/// M8 修复：async fn + `tokio::time::sleep`——调用链（`remove_ephemeral`/
/// `import_copy` → `BrowserManager::stop`/`drive_session`）处于 async 上下文，
/// 同步 sleep 会冻结 current_thread runtime 的 worker；`.await` 等待让出线程。
#[allow(clippy::disallowed_methods)]
pub async fn remove_dir_retry(
    dir: &Path,
    tries: u32,
    interval: Duration,
) -> Result<(), ProcessError> {
    let mut last: Option<String> = None;
    for attempt in 0..tries {
        match std::fs::remove_dir_all(dir) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => {
                last = Some(e.to_string());
                tracing::warn!(
                    "删除目录失败（第 {}/{} 次）：{}：{e}",
                    attempt + 1,
                    tries,
                    dir.display()
                );
                tokio::time::sleep(interval).await;
            }
        }
    }
    Err(ProcessError::Internal(format!(
        "删除目录失败（重试 {} 次）：{}{}",
        tries,
        dir.display(),
        last.map(|m| format!("：{m}")).unwrap_or_default()
    )))
}

/// 受管 profile 删除：走 conex-fs trash（R-2 铁律，trash.rs:26-29，不直接 remove）。
/// `trash_root` 由调用方注入（默认 `data_root()/conex/trash`）。
pub fn trash_managed(dir: &Path, trash_root: &Path) -> Result<(), ProcessError> {
    let trash = conex_fs::trash::TrashService::new(trash_root.to_path_buf());
    trash
        .trash_file(dir, true)
        .map_err(|e| ProcessError::Internal(format!("受管 profile 入回收站失败：{e}")))?;
    Ok(())
}

/// 删除 profile 根下残留的 DevToolsActivePort（§5.1 第 1 步；不存在忽略）。
pub fn remove_stale_active_port(profile_dir: &Path) {
    crate::browser::active_port::remove_stale_active_port(profile_dir);
}

/// 锁检测结果（§4.5 跨进程互斥 + stale 自愈）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockState {
    /// 无锁文件。
    Absent,
    /// 锁文件存在且 PID 存活（占用中）。
    Alive { pid: u32 },
    /// 锁文件存在但 PID 已死（崩溃残留 → 删锁继续）。
    Stale { pid: u32 },
}

/// 检测目标 profile 的 SingletonLock（§4.5）。
/// 锁文件内容为 PID 文本（Chrome 语义）。
pub fn detect_singleton_lock(profile_dir: &Path) -> LockState {
    let lock = profile_dir.join("SingletonLock");
    let content = match std::fs::read_to_string(&lock) {
        Ok(c) => c,
        Err(_) => return LockState::Absent,
    };
    let pid: u32 = match content.trim().parse() {
        Ok(pid) => pid,
        Err(_) => return LockState::Stale { pid: 0 },
    };
    if is_pid_alive(pid) {
        LockState::Alive { pid }
    } else {
        LockState::Stale { pid }
    }
}

/// PID 存活探测（§4.5）：Windows OpenProcess；unix kill(pid, 0) 语义。
pub fn is_pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    platform_lock::pid_alive(pid)
}

/// 导入排除表（§4.3 两处合并）：Cache/Code Cache/GPUCache/Service Worker/blob_storage/
/// File System/GCM Store/optimization_guide/ShaderCache/component_crx_cache +
/// D-7 红线：Login Data（密码库）/History/Web Data 显式排除。
pub const IMPORT_EXCLUDE_COMPONENTS: &[&str] = &[
    "Cache",
    "Code Cache",
    "GPUCache",
    "Service Worker",
    "blob_storage",
    "File System",
    "GCM Store",
    "optimization_guide",
    "ShaderCache",
    "component_crx_cache",
    "Login Data",
    "History",
    "Web Data",
];

/// 瞬态文件跳过（§4.3：Singleton*、*.lock、*-journal、LOCK）。
pub fn is_transient(name: &str) -> bool {
    name.starts_with("Singleton")
        || name.ends_with(".lock")
        || name.ends_with("-journal")
        || name == "LOCK"
        || name == "DevToolsActivePort"
}

/// 复制报告。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ImportReport {
    pub copied: usize,
    pub skipped: usize,
}

/// 复制递归深度上限（H5 加固：防御恶意构造的超深目录树 → 栈溢出；
/// 正常 Chrome profile 深度远低于此值）。
const MAX_COPY_DEPTH: u32 = 64;
/// 复制节点总数上限（H5 加固：防御异常构造的超大目录树/链接网；
/// 正常 profile 节点数远低于此值）。
const MAX_COPY_NODES: u64 = 100_000;

/// 导入复制（§4.3）：「来源只读」——复制过程绝不写源目录。
///
/// - 复制 `Local State` + `<source_profile>/` 到 dest（best-effort 逐文件）；
/// - 排除表 + 瞬态文件跳过；目录级失败 → 整体报错并清理半成品；
/// - `lock_policy`：源锁存活检测（Alive → 报错「请关闭来源浏览器后再导入」）。
///
/// M8 修复：async fn——调用链（`BrowserManager::prepare_profile` ← `drive_session`）
/// 处于 async 上下文，内部失败清理路径的重试等待必须用 `tokio::time::sleep`
/// （`.await` 让出线程），不得以同步 sleep 阻塞 tokio worker。
pub async fn import_copy(
    source_user_data: &Path,
    source_profile: &str,
    dest: &Path,
    skip_lock_check: bool,
) -> Result<ImportReport, ProcessError> {
    // 源 profile 名安全（防路径注入）
    let src_name = sanitize_profile_name(source_profile);
    let src_profile_dir = source_user_data.join(&src_name);
    if !src_profile_dir.is_dir() {
        return Err(ProcessError::ImportFailed(format!(
            "源 profile 目录不存在：{}",
            src_profile_dir.display()
        )));
    }
    // 运行锁检测（§4.3 表）：源 SingletonLock 存在且 PID 存活 → 明确报错
    if !skip_lock_check {
        match detect_singleton_lock(source_user_data) {
            LockState::Alive { pid } => {
                return Err(ProcessError::ImportFailed(format!(
                    "来源浏览器正在运行（PID {pid}），请关闭来源浏览器后再导入"
                )));
            }
            LockState::Stale { .. } => {
                // stale 锁自愈：删除后继续（§4.5；豁免删除禁令：stale 锁为
                // 崩溃残留的自家运行期标记文件，直删语义与 R-2 一致）。
                // 删除失败不阻断导入（后续 copy_tree 会跳过瞬态文件），但必须留痕。
                #[allow(clippy::disallowed_methods)]
                {
                    if let Err(e) = std::fs::remove_file(source_user_data.join("SingletonLock")) {
                        tracing::warn!("来源 stale SingletonLock 清理失败（继续导入）：{e}");
                    }
                }
            }
            LockState::Absent => {}
        }
    }
    let report = match copy_profile(source_user_data, &src_profile_dir, dest) {
        Ok(r) => r,
        Err(e) => {
            // 目录级失败 → 清理半成品（§4.3 失败语义）；清理失败不得掩盖
            // 主错误（返回 ImportFailed），但须留痕说明残留目录。
            if let Err(clean_err) = remove_dir_retry(dest, 2, Duration::from_millis(20)).await {
                tracing::warn!("导入失败后清理半成品目录失败（残留需手工清理）：{clean_err}");
            }
            return Err(ProcessError::ImportFailed(e));
        }
    };
    Ok(report)
}

/// 复制 `Local State` + profile 目录（best-effort 逐文件，排除表 + 瞬态跳过）。
fn copy_profile(
    source_user_data: &Path,
    src_profile_dir: &Path,
    dest: &Path,
) -> Result<ImportReport, String> {
    std::fs::create_dir_all(dest).map_err(|e| format!("创建目标失败：{e}"))?;
    let mut report = ImportReport::default();
    // Local State（复制表第 1 项；symlink_metadata 不跟随链接——H5：符号链接跳过）
    let local_state = source_user_data.join("Local State");
    match std::fs::symlink_metadata(&local_state) {
        Ok(meta) if meta.is_file() => {
            if let Err(e) = std::fs::copy(&local_state, dest.join("Local State")) {
                tracing::warn!("复制 Local State 失败（跳过）：{e}");
                report.skipped += 1;
            } else {
                report.copied += 1;
            }
        }
        Ok(meta) if meta.is_symlink() => {
            tracing::warn!("复制跳过符号链接：{}", local_state.display());
            report.skipped += 1;
        }
        _ => {}
    }
    let mut nodes = 0;
    copy_tree(src_profile_dir, dest, &mut report, 0, &mut nodes)?;
    Ok(report)
}

/// 递归复制（相对路径 + 排除表）。
///
/// H5 加固：目录枚举用 `DirEntry::file_type`（**不跟随符号链接**）判定——
/// 修复前 `is_dir()/is_file()` 跟随链接：自环/互环链接导致无限递归栈溢出，
/// 指向源树外的链接把外部整目录复制进受管 profile；符号链接条目一律跳过并
/// 计入 skipped。另加深度上限与节点总数上限（防御剩余环状/超深结构的兜底）。
fn copy_tree(
    src: &Path,
    dest: &Path,
    report: &mut ImportReport,
    depth: u32,
    nodes: &mut u64,
) -> Result<(), String> {
    if depth > MAX_COPY_DEPTH {
        return Err(format!(
            "复制目录深度超过上限 {MAX_COPY_DEPTH}（可能为异常构造的目录树）：{}",
            src.display()
        ));
    }
    for entry in
        std::fs::read_dir(src).map_err(|e| format!("读源目录 {} 失败：{e}", src.display()))?
    {
        let entry = entry.map_err(|e| format!("读条目失败：{e}"))?;
        *nodes += 1;
        if *nodes > MAX_COPY_NODES {
            return Err(format!(
                "复制节点数超过上限 {MAX_COPY_NODES}（可能为异常构造的目录树）：{}",
                src.display()
            ));
        }
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        // 瞬态文件跳过（§4.3 表）
        if is_transient(&name_str) {
            report.skipped += 1;
            continue;
        }
        let src_path = entry.path();
        // H5：不跟随符号链接的条目类型判定（DirEntry::file_type 语义）——
        // 自环/指向源外的链接直接跳过，杜绝递归逃逸
        let file_type = entry
            .file_type()
            .map_err(|e| format!("读条目类型失败 {}：{e}", src_path.display()))?;
        if file_type.is_symlink() {
            tracing::warn!("复制跳过符号链接：{}", src_path.display());
            report.skipped += 1;
            continue;
        }
        if file_type.is_dir() {
            if IMPORT_EXCLUDE_COMPONENTS.contains(&name_str.as_ref()) {
                report.skipped += 1;
                continue;
            }
            let dest_dir = dest.join(&name);
            std::fs::create_dir_all(&dest_dir).map_err(|e| format!("创建目标子目录失败：{e}"))?;
            copy_tree(&src_path, &dest_dir, report, depth + 1, nodes)?;
        } else if file_type.is_file() {
            if IMPORT_EXCLUDE_COMPONENTS.contains(&name_str.as_ref()) {
                report.skipped += 1;
                continue;
            }
            if let Err(e) = std::fs::copy(&src_path, dest.join(&name)) {
                // best-effort：单文件失败跳过记 warning（chrome.rs:1271-1326 同款）
                tracing::warn!("复制文件失败（跳过）：{}：{e}", src_path.display());
                report.skipped += 1;
            } else {
                report.copied += 1;
            }
        }
    }
    Ok(())
}

/// profile 名消毒（§4.3：防路径分隔符/`..` 注入）。
pub fn sanitize_profile_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
            out.push(c);
        } else {
            out.push('_');
        }
    }
    // 防 `..` 逃逸
    if out == ".." {
        out = "profile".to_string();
    }
    if out.is_empty() {
        out = "profile".to_string();
    }
    out
}

/// 孤儿清扫（§4.4）：`sessions/` 下目录 mtime 超阈值 → 删除（best-effort）。
/// 豁免 clippy 删除禁令：孤儿目录为自家运行期残留（非用户资产），
/// 与「自管文件轮转」同豁免面；受管 profile 不在此清扫范围。
///
/// M10 加固：删除前校验「会话活跃标记」——运行中的浏览器实例在 profile 根
/// （= 该目录自身）持有存活 SingletonLock，mtime 语义不足（长驻会话空闲期
/// mtime 可陈旧超阈值、时钟回拨场景新目录 mtime 亦可超阈值），存活即跳过。
#[allow(clippy::disallowed_methods)]
pub fn sweep_orphans(sessions_root: &Path, older_than: Duration) -> Vec<PathBuf> {
    let mut removed = Vec::new();
    let cutoff = std::time::SystemTime::now() - older_than;
    let Ok(entries) = std::fs::read_dir(sessions_root) else {
        return removed;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        // M10：活跃会话保护（SingletonLock 存活 = 浏览器正在使用该 profile）
        if matches!(detect_singleton_lock(&path), LockState::Alive { .. }) {
            continue;
        }
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        if modified < cutoff {
            match std::fs::remove_dir_all(&path) {
                Ok(()) => {
                    tracing::info!("清扫孤儿 profile：{}", path.display());
                    removed.push(path);
                }
                Err(e) => tracing::warn!("清扫孤儿失败：{}：{e}", path.display()),
            }
        }
    }
    removed
}

/// 平台锁探测实现。
#[cfg(windows)]
mod platform_lock {
    /// OpenProcess 存活探测（标准 API，unsafe 局部化）。
    #[allow(unsafe_code)]
    pub fn pid_alive(pid: u32) -> bool {
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        // SAFETY：OpenProcess 标准 Windows API；句柄用完即关（错误路径不 panic）
        let handle: HANDLE = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            return false;
        }
        // SAFETY：CloseHandle 释放句柄（来源为本函数 OpenProcess 成功返回值）
        unsafe { CloseHandle(handle) != 0 }
    }
}

#[cfg(unix)]
mod platform_lock {
    /// kill(pid, 0) 直调（libc，无 shell 依赖；G-10 收尾）：
    /// - 0：进程存在 → 存活；
    /// - ESRCH：进程不存在 → 已死；
    /// - EPERM：进程存在但无权限探测（信号 0 亦被拒）→ 保守存活
    ///   （探测失败不误判已死，避免误删活跃 SingletonLock 造成双开冲突）；
    /// - 其余 errno（如 EINVAL）：未知错误 → 保守存活（与 unix.rs killpg_result
    ///   的「非 ESRCH 即存在」errno 语义同源收敛）。
    ///
    /// libc 调用为 unsafe：错误经 errno 面（last_os_error）转出，
    /// 无内存不安全面，unsafe 局部化（workspace 逐处评审惯例）。
    #[allow(unsafe_code)]
    pub fn pid_alive(pid: u32) -> bool {
        // u32 → pid_t 溢出防护：超范围 PID 不可能存在，直接判死不进入 libc
        // （as 回绕会得到负 PID，探测语义错误）
        let Ok(pid) = libc::pid_t::try_from(pid) else {
            return false;
        };
        let ret = unsafe { libc::kill(pid, 0) };
        if ret == 0 {
            return true;
        }
        let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
        pid_alive_result(ret, errno)
    }

    /// kill(pid, 0) 返回码 → 存活判定（纯函数，可脱离 libc 单测）：
    /// 与 unix.rs killpg_result 的 errno 语义同源——ESRCH（目标不存在）
    /// 为唯一「已死」判定，其余（EPERM 等）保守存活。
    pub(super) fn pid_alive_result(ret: i32, errno: i32) -> bool {
        if ret == 0 {
            return true;
        }
        errno != libc::ESRCH
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token() -> SessionToken {
        SessionToken::new()
    }

    /// 临时 profile 目录创建/命名/清理（含删除失败注入）。
    #[tokio::test]
    async fn ephemeral_dir_creation_and_cleanup() {
        let dir = tempfile::tempdir().expect("临时目录");
        let root = browser_root(dir.path());
        let t = token();
        let p = create_ephemeral(&root, &t).expect("创建");
        assert_eq!(p, ephemeral_dir(&root, &t));
        assert_eq!(
            p.file_name().and_then(|n| n.to_str()),
            Some(t.as_str()),
            "目录名 = 会话 uuid"
        );
        assert!(p.is_dir());
        assert!(p.starts_with(sessions_root(&root)));
        // 直删
        remove_ephemeral(&p).await.expect("删除");
        assert!(!p.exists());
        // 不存在删除幂等
        remove_ephemeral(&p).await.expect("重复删除幂等");
    }

    /// 删除重试：非空目录直删冒烟（重试路径正常收敛）。
    #[tokio::test]
    async fn remove_dir_retry_smoke() {
        let dir = tempfile::tempdir().expect("临时目录");
        let target = dir.path().join("nested");
        std::fs::create_dir_all(target.join("sub")).expect("目录");
        std::fs::write(target.join("sub/f.txt"), b"x").expect("写入");
        remove_dir_retry(&target, 3, Duration::from_millis(5))
            .await
            .expect("删除");
        assert!(!target.exists());
    }

    /// 受管删除走 trash（R-2 铁律回归）；临时直删不走 trash（对照断言）。
    #[tokio::test]
    async fn managed_delete_goes_trash() {
        let dir = tempfile::tempdir().expect("临时目录");
        let trash = dir.path().join("trash-root");
        // 受管 profile（用户资产）
        let managed = managed_root(browser_root(dir.path()).as_path()).join("my-profile");
        std::fs::create_dir_all(&managed).expect("目录");
        std::fs::write(managed.join("profile_meta.json"), b"{}").expect("写入");
        trash_managed(&managed, &trash).expect("入回收站");
        assert!(!managed.exists(), "原目录已移走");
        let service = conex_fs::trash::TrashService::new(trash.clone());
        assert_eq!(service.list().len(), 1, "trash 内应有 1 条条目");
        // 对照：临时 profile 直删，不进 trash
        let root = browser_root(dir.path());
        let t = token();
        let ephemeral = create_ephemeral(&root, &t).expect("创建");
        std::fs::write(ephemeral.join("DevToolsActivePort"), b"x").expect("写入");
        remove_ephemeral(&ephemeral).await.expect("直删");
        assert!(!ephemeral.exists());
        assert_eq!(service.list().len(), 1, "临时直删不得产生 trash 条目");
    }

    /// 导入排除表参数化断言（§4.3 全表，评审 21-L9）。
    #[tokio::test]
    async fn import_copy_excludes_sensitive() {
        let dir = tempfile::tempdir().expect("临时目录");
        let src_root = dir.path().join("src-user-data");
        let src_profile = src_root.join("Default");
        std::fs::create_dir_all(&src_profile).expect("目录");
        // 写入：Local State + 常规文件 + 全部排除项（目录与文件两种形态）
        std::fs::write(src_root.join("Local State"), b"ls").expect("写入");
        std::fs::write(src_profile.join("Preferences"), b"pref").expect("写入");
        for excl in IMPORT_EXCLUDE_COMPONENTS {
            if excl.contains(' ') {
                std::fs::create_dir_all(src_profile.join(excl)).expect("排除目录");
            } else {
                let p = src_profile.join(excl);
                match p.extension().and_then(|e| e.to_str()) {
                    Some(_) => std::fs::write(p, b"x").expect("排除文件"),
                    None => {
                        std::fs::create_dir_all(&p).expect("排除目录");
                        std::fs::write(p.join("inner.txt"), b"x").expect("排除目录内文件");
                    }
                }
            }
        }
        // 瞬态文件
        std::fs::write(src_root.join("SingletonLock"), b"12345").expect("锁");
        std::fs::write(src_profile.join("LOCK"), b"x").expect("瞬态");
        std::fs::write(src_profile.join("History-journal"), b"x").expect("瞬态");
        std::fs::write(src_profile.join("DevToolsActivePort"), b"1\n/p\n").expect("瞬态");

        let dest = dir.path().join("managed-out");
        let report = import_copy(&src_root, "Default", &dest, true)
            .await
            .expect("复制");
        assert!(dest.join("Local State").is_file());
        assert!(dest.join("Preferences").is_file());
        for excl in IMPORT_EXCLUDE_COMPONENTS {
            assert!(!dest.join(excl).exists(), "排除项不得落副本：{excl}");
        }
        assert!(!dest.join("SingletonLock").exists(), "瞬态锁不得复制");
        assert!(!dest.join("LOCK").exists());
        assert!(!dest.join("History-journal").exists());
        assert!(!dest.join("DevToolsActivePort").exists());
        assert!(report.copied >= 2, "至少 Local State + Preferences");
        assert!(report.skipped > 0, "排除项应计入 skipped");
        // 源完好性：只读来源未被破坏
        assert!(src_profile.join("Preferences").is_file());
    }

    /// 导入锁检测：源 SingletonLock + 存活 PID → ImportFailed。
    #[tokio::test]
    async fn import_lock_detection() {
        let dir = tempfile::tempdir().expect("临时目录");
        let src_root = dir.path().join("src-user-data");
        let src_profile = src_root.join("Default");
        std::fs::create_dir_all(&src_profile).expect("目录");
        // 用当前进程 PID（必然存活）
        let pid = std::process::id();
        std::fs::write(src_root.join("SingletonLock"), pid.to_string()).expect("锁");
        let dest = dir.path().join("out");
        let err = import_copy(&src_root, "Default", &dest, false)
            .await
            .expect_err("应失败");
        assert!(
            matches!(err, ProcessError::ImportFailed(_)),
            "存活锁 → ImportFailed：{err:?}"
        );
        assert!(!dest.exists(), "失败不得产生半成品");
    }

    /// stale 锁自愈：PID 不存在 → 删除锁继续。
    #[tokio::test]
    async fn stale_singleton_lock_ignored() {
        let dir = tempfile::tempdir().expect("临时目录");
        let src_root = dir.path().join("src-user-data");
        let src_profile = src_root.join("Default");
        std::fs::create_dir_all(&src_profile).expect("目录");
        std::fs::write(src_root.join("SingletonLock"), b"4294967294").expect("锁（不可能存活）");
        std::fs::write(src_profile.join("Preferences"), b"p").expect("写入");
        let dest = dir.path().join("out");
        let report = import_copy(&src_root, "Default", &dest, false)
            .await
            .expect("stale 锁应自愈");
        assert!(report.copied >= 1);
        assert!(!src_root.join("SingletonLock").exists(), "stale 锁应被删除");
    }

    /// detect_singleton_lock 三态。
    #[test]
    fn singleton_lock_states() {
        let dir = tempfile::tempdir().expect("临时目录");
        assert_eq!(detect_singleton_lock(dir.path()), LockState::Absent);
        std::fs::write(dir.path().join("SingletonLock"), "4294967294").expect("锁");
        assert_eq!(
            detect_singleton_lock(dir.path()),
            LockState::Stale { pid: 4294967294 }
        );
        std::fs::write(
            dir.path().join("SingletonLock"),
            std::process::id().to_string(),
        )
        .expect("锁");
        assert!(matches!(
            detect_singleton_lock(dir.path()),
            LockState::Alive { .. }
        ));
        // 非法内容 → Stale
        std::fs::write(dir.path().join("SingletonLock"), b"not-a-pid").expect("锁");
        assert!(matches!(
            detect_singleton_lock(dir.path()),
            LockState::Stale { .. }
        ));
    }

    /// profile 名消毒（路径分隔符/`..` 注入）。
    #[test]
    fn profile_name_sanitized() {
        assert_eq!(sanitize_profile_name("正常Profile"), "__Profile");
        assert_eq!(sanitize_profile_name("my_profile-2"), "my_profile-2");
        assert_eq!(sanitize_profile_name(".."), "profile");
        assert_eq!(sanitize_profile_name("../etc"), ".._etc");
        assert_eq!(sanitize_profile_name("a/b\\c:d"), "a_b_c_d");
        assert_eq!(sanitize_profile_name(""), "profile");
        assert!(!sanitize_profile_name("../x").contains('/'));
        assert!(!sanitize_profile_name("..\\x").contains('\\'));
        assert_ne!(sanitize_profile_name(".."), "..");
    }

    /// 孤儿清扫：旧目录删除、新目录保留。
    #[test]
    fn sweep_orphans_removes_old_only() {
        let dir = tempfile::tempdir().expect("临时目录");
        let root = sessions_root(browser_root(dir.path()).as_path());
        std::fs::create_dir_all(&root).expect("根");
        // 旧目录（mtime 提前 2 天）
        let old = root.join("old-session");
        std::fs::create_dir_all(&old).expect("目录");
        set_dir_mtime_old(&old);
        // 新目录
        let fresh = root.join("fresh-session");
        std::fs::create_dir_all(&fresh).expect("目录");
        let removed = sweep_orphans(&root, Duration::from_secs(2 * 24 * 3600));
        assert!(removed.contains(&old), "旧目录应被清扫：{removed:?}");
        assert!(!removed.contains(&fresh), "新目录应保留");
        assert!(fresh.exists());
    }

    /// M10 回归：活跃会话目录（SingletonLock 携带存活 PID + mtime 陈旧超阈值）
    /// 不被清扫——mtime 阈值语义不足（长驻会话空闲期/时钟回拨场景），
    /// 以会话活跃标记为最终防线。
    #[test]
    fn sweep_orphans_skips_live_session_lock() {
        let dir = tempfile::tempdir().expect("临时目录");
        let root = sessions_root(browser_root(dir.path()).as_path());
        std::fs::create_dir_all(&root).expect("根");
        // 活跃会话：SingletonLock = 当前进程 PID（必然存活），mtime 故意回拨超阈值
        let live = root.join("live-session");
        std::fs::create_dir_all(&live).expect("目录");
        std::fs::write(live.join("SingletonLock"), std::process::id().to_string()).expect("锁");
        set_dir_mtime_old(&live);
        // 对照孤儿：无锁 + mtime 陈旧
        let orphan = root.join("orphan-session");
        std::fs::create_dir_all(&orphan).expect("目录");
        set_dir_mtime_old(&orphan);

        let removed = sweep_orphans(&root, Duration::from_secs(2 * 24 * 3600));
        assert!(
            !removed.contains(&live),
            "活跃会话不得被清扫（M10）：{removed:?}"
        );
        assert!(removed.contains(&orphan), "无锁孤儿应照常清扫：{removed:?}");
        assert!(live.exists(), "活跃会话目录必须保留");
        assert!(!orphan.exists(), "孤儿应被删除");
    }

    /// H5 回归（unix；Windows 建链接需特权，CI 为 ubuntu 覆盖该面）：
    /// 源 profile 含「指向自身的符号链接」（自环）与「指向源树外的目录/文件
    /// 链接」→ 全部跳过不复制、不崩溃。修复前 `is_dir/is_file` 跟随链接：
    /// 自环 → 无限递归栈溢出；外部目录链接 → 外部整目录被复制进受管 profile。
    #[cfg(unix)]
    #[tokio::test]
    async fn copy_tree_skips_symlinks_without_following() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().expect("临时目录");
        let src_root = dir.path().join("src-user-data");
        let src_profile = src_root.join("Default");
        std::fs::create_dir_all(&src_profile).expect("目录");
        std::fs::write(src_profile.join("Preferences"), b"p").expect("写入");

        // 自环链接：Default/self -> Default（修复前：无限递归 → 栈溢出崩溃）
        symlink(&src_profile, src_profile.join("self")).expect("自环链接");
        // 指向源外的目录链接 + 外部秘密文件
        let outside = dir.path().join("outside-secret");
        std::fs::create_dir_all(&outside).expect("外部目录");
        std::fs::write(outside.join("secret.txt"), b"s").expect("外部文件");
        symlink(&outside, src_profile.join("outside")).expect("外部目录链接");
        // 指向源外的文件链接
        symlink(outside.join("secret.txt"), src_profile.join("secret-link")).expect("外部文件链接");

        let dest = dir.path().join("managed-out");
        let report = import_copy(&src_root, "Default", &dest, true)
            .await
            .expect("复制不得崩溃");
        // 正常文件照常复制
        assert!(dest.join("Preferences").is_file());
        // 三类链接一律未复制（不跟随）
        assert!(!dest.join("self").exists(), "自环链接不得复制");
        assert!(!dest.join("outside").exists(), "外部目录链接不得复制");
        assert!(
            !dest.join("outside").join("secret.txt").exists(),
            "外部目录内容不得进入副本"
        );
        assert!(!dest.join("secret-link").exists(), "外部文件链接不得复制");
        // 链接计入 skipped
        assert!(report.skipped >= 3, "3 个链接应计入 skipped：{report:?}");
        // 源完好性：只读来源未受影响
        assert!(src_profile.join("self").exists());
        assert!(outside.join("secret.txt").is_file());
    }

    /// H5 加固回归：超深目录树（> MAX_COPY_DEPTH 层）→ 复制中止报错而非栈溢出。
    #[tokio::test]
    async fn copy_tree_depth_cap_aborts() {
        let dir = tempfile::tempdir().expect("临时目录");
        let src_root = dir.path().join("src-user-data");
        let src_profile = src_root.join("Default");
        // 构造 MAX_COPY_DEPTH + 2 层嵌套目录 + 叶文件
        let mut deep = src_profile.clone();
        for _ in 0..=MAX_COPY_DEPTH + 1 {
            deep = deep.join("d");
            std::fs::create_dir_all(&deep).expect("目录");
        }
        std::fs::write(deep.join("leaf.txt"), b"x").expect("写入");

        let dest = dir.path().join("out");
        let err = import_copy(&src_root, "Default", &dest, true)
            .await
            .expect_err("超深应中止");
        assert!(err.to_string().contains("深度"), "应说明深度上限：{err}");
        assert!(!dest.exists(), "失败不得留下半成品");
    }

    /// 目录 mtime 回拨到过去（Windows：CreateFileW(FILE_WRITE_ATTRIBUTES |
    /// BACKUP_SEMANTICS) + SetFileTime；unix：futimens 语义）。
    #[cfg(windows)]
    #[allow(unsafe_code)]
    fn set_dir_mtime_old(dir: &Path) {
        use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
        use windows_sys::Win32::Storage::FileSystem::{
            CreateFileW, SetFileAttributesW, SetFileTime, FILE_ATTRIBUTE_NORMAL,
            FILE_FLAG_BACKUP_SEMANTICS, FILE_WRITE_ATTRIBUTES, OPEN_EXISTING,
        };
        // 目录需先清只读属性（部分环境目录默认只读标记）
        let wide: Vec<u16> = dir
            .as_os_str()
            .to_string_lossy()
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY：SetFileAttributesW 标准 API；wide 为 NUL 结尾的宽字符串
        unsafe { SetFileAttributesW(wide.as_ptr(), FILE_ATTRIBUTE_NORMAL) };
        let past = std::time::SystemTime::now() - Duration::from_secs(2 * 24 * 3600);
        let since_epoch = past.duration_since(std::time::UNIX_EPOCH).expect("时间");
        let ft_100ns = since_epoch.as_nanos() as i64 / 100;
        let filetime = FILETIME {
            dwLowDateTime: ft_100ns as u32,
            dwHighDateTime: (ft_100ns >> 32) as u32,
        };
        // SAFETY：CreateFileW 打开目录句柄（BACKUP_SEMANTICS 允许目录打开 +
        // FILE_WRITE_ATTRIBUTES 允许 SetFileTime 写时间戳）；失败静默（测试尽力而为）
        let handle: HANDLE = unsafe {
            CreateFileW(
                wide.as_ptr(),
                FILE_WRITE_ATTRIBUTES,
                0, // FILE_SHARE_MODE：独占打开（0.61 为 u32 别名）
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                std::ptr::null_mut(),
            )
        };
        if !handle.is_null() {
            // SAFETY：SetFileTime 写目录时间戳；句柄随后关闭
            unsafe {
                SetFileTime(handle, &filetime, &filetime, &filetime);
                CloseHandle(handle);
            }
        }
    }

    /// unix：只读 fd 上 set_modified（futimens）即可回拨。
    #[cfg(unix)]
    fn set_dir_mtime_old(dir: &Path) {
        let past = std::time::SystemTime::now() - Duration::from_secs(2 * 24 * 3600);
        if let Ok(file) = std::fs::File::open(dir) {
            let _ = file.set_modified(past);
        }
    }

    /// 数据根定位（平台默认根，绝对路径）。
    #[test]
    fn default_data_root_resolves() {
        let root = data_root().expect("数据根可定位");
        assert!(root.is_absolute());
        assert!(
            root.ends_with(APP_DIR_NAME),
            "应用目录名统一 conex：{root:?}"
        );
    }

    /// 目录布局常量回归（R-2 分层）。
    #[test]
    fn layout_constants() {
        let root = browser_root(Path::new("C:\\data"));
        assert_eq!(root, Path::new("C:\\data").join("browser"));
        assert_eq!(sessions_root(&root), root.join("sessions"));
        assert_eq!(managed_root(&root), root.join("managed"));
        assert_eq!(
            trash_root(Path::new("C:\\data")),
            Path::new("C:\\data").join("trash")
        );
    }

    /// 导入失败：源 profile 不存在 → ImportFailed。
    #[tokio::test]
    async fn import_missing_source_profile() {
        let dir = tempfile::tempdir().expect("临时目录");
        let err = import_copy(
            &dir.path().join("src"),
            "Default",
            &dir.path().join("out"),
            true,
        )
        .await
        .expect_err("应失败");
        assert!(matches!(err, ProcessError::ImportFailed(_)));
    }
}

/// Unix 专用测试：本机为 Windows 不编译，由 CI ubuntu（Linux/macOS）覆盖。
#[cfg(all(test, unix))]
mod unix_pid_alive_tests {
    use super::platform_lock;

    /// kill(pid, 0) 返回码 → 存活判定映射（纯函数）：
    /// 0 → 存活；ESRCH → 已死；EPERM/未知 errno → 保守存活。
    #[test]
    fn pid_alive_result_mapping() {
        assert!(platform_lock::pid_alive_result(0, 0), "0（进程存在）应存活");
        assert!(
            !platform_lock::pid_alive_result(-1, libc::ESRCH),
            "ESRCH（进程不存在）应已死"
        );
        assert!(
            platform_lock::pid_alive_result(-1, libc::EPERM),
            "EPERM（进程存在但无权探测）应保守存活"
        );
        assert!(
            platform_lock::pid_alive_result(-1, 9_999),
            "未知 errno 应保守存活"
        );
    }

    /// 真实场景：fork 子进程 → 就绪态存活（true）→ SIGKILL + waitpid 回收
    /// → 已死（false）。管道同步消除 fork 与探测之间的竞态（无 sleep）。
    #[test]
    #[allow(unsafe_code)]
    fn pid_alive_real_process_two_states() {
        // 同步管道：子进程写就绪字节，父进程阻塞等待，消除竞态
        let mut fds = [0i32; 2];
        let pipe_ret = unsafe { libc::pipe(fds.as_mut_ptr()) };
        assert_eq!(pipe_ret, 0, "pipe 创建失败");

        let child = unsafe { libc::fork() };
        assert!(child >= 0, "fork 失败");
        if child == 0 {
            // 子进程：写就绪字节后挂起等待信号（失败直接退出，父进程读到 EOF 即暴露）
            let written = unsafe { libc::write(fds[1], b"x".as_ptr() as *const libc::c_void, 1) };
            if written != 1 {
                // 写就绪字节失败：直接退出，父进程读到 EOF 即断言失败（不静默通过）
                unsafe { libc::_exit(4) };
            }
            unsafe { libc::pause() };
            unsafe { libc::_exit(3) };
        }

        // 父进程：等子进程就绪字节（EOF 即子进程提前退出 → 直接失败）
        let mut buf = [0u8; 1];
        let n = unsafe { libc::read(fds[0], buf.as_mut_ptr() as *mut libc::c_void, 1) };
        assert_eq!(n, 1, "子进程未就绪（写字节前退出）");

        // 存活态：运行中的子进程应判定为存活
        assert!(
            platform_lock::pid_alive(child as u32),
            "运行中的子进程应存活"
        );

        // 终止态：SIGKILL → waitpid 回收（不产生僵尸）→ 探测为已死
        let killed = unsafe { libc::kill(child, libc::SIGKILL) };
        assert_eq!(killed, 0, "SIGKILL 子进程失败");
        let mut status = 0;
        let waited = unsafe { libc::waitpid(child, &mut status, 0) };
        assert_eq!(waited, child, "waitpid 回收失败");
        assert!(libc::WIFSIGNALED(status) && libc::WTERMSIG(status) == libc::SIGKILL);
        assert!(
            !platform_lock::pid_alive(child as u32),
            "已回收的进程应判定为已死"
        );

        unsafe { libc::close(fds[0]) };
        unsafe { libc::close(fds[1]) };
    }
}
