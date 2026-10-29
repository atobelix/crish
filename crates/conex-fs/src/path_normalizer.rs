//! Windows 路径归一底座与安全判定（DIM-04 / RUL-04）
//!
//! 统一全仓 Windows 路径规范：
//! 1. 强制统一盘符为大写字母（`C:/...`，`D:/...`）；
//! 2. 统一正斜杠 `/` 分隔符；
//! 3. 剥离 `\\?\`、`\\?\UNC\`、`\\.\` Verbatim 前缀；
//! 4. 异步探测 UNC 网络共享路径（`tokio::task::spawn_blocking`）；
//! 5. 确立系统核心目录物理红线（`is_system_critical_path`）。

use std::path::{Component, Path, PathBuf, Prefix};
use std::sync::OnceLock;

/// 根锚点类型
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RootAnchor {
    None,
    PosixRoot,
    Disk(char),
    UNC { server: String, share: String },
}

static SYSTEM_CRITICAL_PREFIXES: OnceLock<Vec<String>> = OnceLock::new();

fn get_system_critical_prefixes() -> &'static [String] {
    SYSTEM_CRITICAL_PREFIXES.get_or_init(|| {
        let mut prefixes = Vec::new();

        #[cfg(windows)]
        {
            // 1. 动态感知 Windows 系统目录环境变量
            let env_vars = ["SystemRoot", "windir", "ProgramFiles", "ProgramFiles(x86)"];
            for var in &env_vars {
                if let Ok(val) = std::env::var(var) {
                    let norm = ConexPathNormalizer::normalize(Path::new(&val));
                    let s = norm.to_string_lossy().to_ascii_uppercase();
                    if !s.is_empty() && !prefixes.contains(&s) {
                        prefixes.push(s);
                    }
                }
            }

            // 2. 动态感知用户凭据敏感子目录 (%USERPROFILE%/.ssh 等)
            if let Ok(user_profile) = std::env::var("USERPROFILE") {
                let norm = ConexPathNormalizer::normalize(Path::new(&user_profile));
                let user_base = norm.to_string_lossy().to_ascii_uppercase();
                let sensitive_subdirs = [".SSH", ".GNUPG", ".AWS", ".AZURE", ".KUBE", ".GITCONFIG"];
                for sub in &sensitive_subdirs {
                    let full = format!("{user_base}/{sub}");
                    if !prefixes.contains(&full) {
                        prefixes.push(full);
                    }
                }
            }
        }

        #[cfg(not(windows))]
        {
            let posix_critical = [
                "/BIN",
                "/SBIN",
                "/USR/BIN",
                "/USR/SBIN",
                "/ETC",
                "/BOOT",
                "/DEV",
                "/PROC",
                "/SYS",
                "/LIB",
                "/LIB64",
                "/VAR/RUN",
            ];
            for p in &posix_critical {
                prefixes.push(p.to_string());
            }

            if let Ok(home) = std::env::var("HOME") {
                let norm = ConexPathNormalizer::normalize(Path::new(&home));
                let home_base = norm.to_string_lossy().to_ascii_uppercase();
                let sensitive_subdirs = [".SSH", ".GNUPG", ".AWS", ".KUBE", ".GITCONFIG"];
                for sub in &sensitive_subdirs {
                    let full = format!("{home_base}/{sub}");
                    if !prefixes.contains(&full) {
                        prefixes.push(full);
                    }
                }
            }
        }

        prefixes
    })
}

/// Conex 统一路径规范化工具
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConexPathNormalizer;

impl ConexPathNormalizer {
    /// 核心规范化：剥离 `\\?\` 前缀、统一正斜杠 `/`、Windows 盘符统一大写 (`C:/`)、消除冗余 `.` 与 `..`
    pub fn normalize(path: &Path) -> PathBuf {
        let path_str = path.to_string_lossy();
        let stripped = Self::strip_verbatim_prefix(&path_str);

        let p = Path::new(&stripped);
        let mut normalized_components = Vec::new();
        let mut anchor = RootAnchor::None;

        for component in p.components() {
            match component {
                Component::Prefix(prefix_comp) => match prefix_comp.kind() {
                    Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => {
                        // RUL-04 权威裁决：强制统一大写盘符 (C:)
                        let upper_drive = (letter as char).to_ascii_uppercase();
                        normalized_components.push(format!("{upper_drive}:"));
                        anchor = RootAnchor::Disk(upper_drive);
                    }
                    Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => {
                        let s = server.to_string_lossy().replace('\\', "/");
                        let sh = share.to_string_lossy().replace('\\', "/");
                        normalized_components.push(format!("//{s}/{sh}"));
                        anchor = RootAnchor::UNC {
                            server: s,
                            share: sh,
                        };
                    }
                    _ => {
                        normalized_components
                            .push(prefix_comp.as_os_str().to_string_lossy().replace('\\', "/"));
                    }
                },
                Component::RootDir => {
                    if anchor == RootAnchor::None && normalized_components.is_empty() {
                        normalized_components.push("".to_string());
                        anchor = RootAnchor::PosixRoot;
                    }
                }
                Component::CurDir => {}
                Component::ParentDir => {
                    // 安全词法弹出：若存在根锚点，栈底第一个元素（根前缀）绝对不可弹出！
                    if !normalized_components.is_empty()
                        && normalized_components.last().map(|s| s.as_str()) != Some("..")
                    {
                        if anchor == RootAnchor::None || normalized_components.len() > 1 {
                            normalized_components.pop();
                        }
                    } else if anchor == RootAnchor::None {
                        normalized_components.push("..".to_string());
                    }
                }
                Component::Normal(name) => {
                    normalized_components.push(name.to_string_lossy().replace('\\', "/"));
                }
            }
        }

        if normalized_components.is_empty() {
            return PathBuf::from(".");
        }

        let mut result_str = String::new();
        for (i, comp) in normalized_components.iter().enumerate() {
            if i == 0 {
                result_str.push_str(comp);
                if comp.ends_with(':') {
                    result_str.push('/');
                }
            } else {
                if !result_str.ends_with('/') {
                    result_str.push('/');
                }
                result_str.push_str(comp);
            }
        }

        if result_str.is_empty() && anchor == RootAnchor::PosixRoot {
            return PathBuf::from("/");
        }

        PathBuf::from(result_str)
    }

    /// 剥离 Windows `\\?\`、`\\?\UNC\` 以及 `\\.\` 前缀并转换斜杠为 `/`
    pub fn strip_verbatim_prefix(s: &str) -> String {
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            format!("//{rest}").replace('\\', "/")
        } else if let Some(rest) = s.strip_prefix(r"//?/UNC/") {
            format!("//{rest}").replace('\\', "/")
        } else if let Some(rest) = s.strip_prefix(r"\\?\") {
            rest.replace('\\', "/")
        } else if let Some(rest) = s.strip_prefix(r"//?/") {
            rest.replace('\\', "/")
        } else if let Some(rest) = s.strip_prefix(r"\\.\") {
            rest.replace('\\', "/")
        } else if let Some(rest) = s.strip_prefix(r"//./") {
            rest.replace('\\', "/")
        } else {
            s.replace('\\', "/")
        }
    }

    /// 跨平台安全的子路径归一化判定（大小写不敏感，大写盘符与斜杠一致）
    pub fn is_subpath(candidate: &Path, root: &Path) -> bool {
        let norm_candidate = Self::normalize(candidate);
        let norm_root = Self::normalize(root);

        let cand_str = norm_candidate.to_string_lossy().replace('\\', "/");
        let root_str = norm_root.to_string_lossy().replace('\\', "/");

        let cand_upper = cand_str.to_ascii_uppercase();
        let root_upper = root_str.to_ascii_uppercase();

        if let Some(rest) = cand_upper.strip_prefix(&root_upper) {
            rest.is_empty() || root_upper.ends_with('/') || rest.starts_with('/')
        } else {
            false
        }
    }

    #[inline]
    fn has_critical_prefix(path: &str, prefix: &str) -> bool {
        path.strip_prefix(prefix)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    }

    /// 检查路径是否命中系统核心关键目录（物理红线）
    pub fn is_system_critical_path(path: &Path) -> bool {
        let normalized = Self::normalize(path);
        let s = normalized.to_string_lossy();
        let upper = s.to_ascii_uppercase();

        #[cfg(windows)]
        {
            // Windows 盘符根与系统关键目录
            if (upper.len() <= 3 && upper.ends_with(":/"))
                || (upper.len() == 2 && upper.ends_with(':'))
            {
                return true; // 拦截 "C:/" 或 "C:" 或 "D:/" 等整个盘符根
            }

            // 任意盘符通用保留目录前缀 (A-Z)
            let drive_relative_patterns = [
                "WINDOWS",
                "WINNT",
                "PROGRAM FILES",
                "PROGRAM FILES (X86)",
                "PROGRAMDATA/MICROSOFT",
                "SYSTEM VOLUME INFORMATION",
                "RECOVERY",
                "BOOT",
                "BOOTMGR",
                "$RECYCLE.BIN",
                "PAGEFILE.SYS",
                "HIBERFIL.SYS",
                "DUMPSTACK.LOG",
            ];

            // 检查是否形如 X:/PATTERN 或 X:/PATTERN/...（零分配 strip_prefix，KFS-06）
            if upper.len() >= 3 && &upper[1..3] == ":/" {
                let after_drive = &upper[3..];
                for pat in &drive_relative_patterns {
                    if Self::has_critical_prefix(after_drive, pat) {
                        return true;
                    }
                }
            }

            // 动态感知环境变量前缀与用户敏感凭据（零分配 strip_prefix，KFS-06）
            for prefix in get_system_critical_prefixes() {
                if Self::has_critical_prefix(&upper, prefix) {
                    return true;
                }
            }

            // 系统底层危险工具/二进制硬拦截（零分配末段提取，KFS-06）
            let critical_binaries = ["DISKPART", "BCDEDIT", "FORMAT", "VSSADMIN", "WBADMIN"];
            let file_name = upper.rsplit('/').next().unwrap_or(&upper);
            let stem = file_name.strip_suffix(".EXE").unwrap_or(file_name);
            if critical_binaries.contains(&stem) {
                return true;
            }
        }

        #[cfg(not(windows))]
        {
            // POSIX 系统关键目录
            if s == "/" || upper == "/" {
                return true;
            }

            for prefix in get_system_critical_prefixes() {
                if Self::has_critical_prefix(&upper, prefix) {
                    return true;
                }
            }
        }

        false
    }

    /// 异步安全探测 UNC 路径（防止阻塞 Tokio 调度器）
    pub async fn check_unc_path_async(path: PathBuf) -> Result<bool, std::io::Error> {
        tokio::task::spawn_blocking(move || {
            let norm = ConexPathNormalizer::normalize(&path);
            Ok(norm.exists())
        })
        .await
        .map_err(|e| std::io::Error::other(e.to_string()))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_posix_root() {
        let p_root = Path::new("/");
        assert_eq!(ConexPathNormalizer::normalize(p_root), PathBuf::from("/"));

        let p_root_dotdot = Path::new("/..");
        assert_eq!(
            ConexPathNormalizer::normalize(p_root_dotdot),
            PathBuf::from("/")
        );

        let p_sub = Path::new("/foo/bar/..");
        assert_eq!(ConexPathNormalizer::normalize(p_sub), PathBuf::from("/foo"));
    }

    #[cfg(windows)]
    #[test]
    fn test_normalize_uppercase_drive_letter() {
        let p1 = Path::new("c:\\software\\conex");
        assert_eq!(
            ConexPathNormalizer::normalize(p1),
            PathBuf::from("C:/software/conex")
        );

        let p2 = Path::new("d:/rust/project/../project/sub");
        assert_eq!(
            ConexPathNormalizer::normalize(p2),
            PathBuf::from("D:/rust/project/sub")
        );

        let p3 = Path::new("c:foo\\bar");
        assert_eq!(
            ConexPathNormalizer::normalize(p3),
            PathBuf::from("C:/foo/bar")
        );
    }

    #[test]
    fn test_strip_verbatim_unc_prefix() {
        let unc1 = r"\\?\UNC\server\share\file.txt";
        assert_eq!(
            ConexPathNormalizer::strip_verbatim_prefix(unc1),
            "//server/share/file.txt"
        );

        let norm_unc = ConexPathNormalizer::normalize(Path::new(unc1));
        assert_eq!(norm_unc, PathBuf::from("//server/share/file.txt"));

        let local_verbatim = r"\\?\C:\workspace\foo\bar";
        assert_eq!(
            ConexPathNormalizer::normalize(Path::new(local_verbatim)),
            PathBuf::from("C:/workspace/foo/bar")
        );
    }

    #[cfg(windows)]
    #[test]
    fn test_unc_root_monotonicity_protection() {
        let unc_root = Path::new(r"\\server\share\..");
        assert_eq!(
            ConexPathNormalizer::normalize(unc_root),
            PathBuf::from("//server/share")
        );

        let unc_sub = Path::new(r"//server/share/dir/..");
        assert_eq!(
            ConexPathNormalizer::normalize(unc_sub),
            PathBuf::from("//server/share")
        );

        let unc_deep = Path::new(r"//server/share/a/b/../../c");
        assert_eq!(
            ConexPathNormalizer::normalize(unc_deep),
            PathBuf::from("//server/share/c")
        );
    }

    #[test]
    fn test_is_subpath() {
        let root = Path::new("C:/Software/conex");
        let sub = Path::new("c:/software/conex/src/lib.rs");
        assert!(ConexPathNormalizer::is_subpath(sub, root));

        let same = Path::new("c:\\software\\conex");
        assert!(ConexPathNormalizer::is_subpath(same, root));

        let outside = Path::new("C:/Software/other");
        assert!(!ConexPathNormalizer::is_subpath(outside, root));

        let prefix_trick = Path::new("C:/Software/conex_evil/foo");
        assert!(!ConexPathNormalizer::is_subpath(prefix_trick, root));
    }

    #[test]
    fn test_is_system_critical_path_windows() {
        #[cfg(windows)]
        {
            assert!(ConexPathNormalizer::is_system_critical_path(Path::new(
                "C:"
            )));
            assert!(ConexPathNormalizer::is_system_critical_path(Path::new(
                "C:/"
            )));
            assert!(ConexPathNormalizer::is_system_critical_path(Path::new(
                "D:"
            )));
            assert!(ConexPathNormalizer::is_system_critical_path(Path::new(
                "D:/"
            )));
            assert!(ConexPathNormalizer::is_system_critical_path(Path::new(
                "c:\\windows"
            )));
            assert!(ConexPathNormalizer::is_system_critical_path(Path::new(
                "D:\\Windows\\System32"
            )));
            assert!(ConexPathNormalizer::is_system_critical_path(Path::new(
                "C:\\Program Files"
            )));
            assert!(ConexPathNormalizer::is_system_critical_path(Path::new(
                "E:\\Program Files (x86)\\app"
            )));
            assert!(ConexPathNormalizer::is_system_critical_path(Path::new(
                "diskpart.exe"
            )));
            assert!(ConexPathNormalizer::is_system_critical_path(Path::new(
                "C:/tools/bcdedit.exe"
            )));

            assert!(!ConexPathNormalizer::is_system_critical_path(Path::new(
                "C:/Projects/my-app"
            )));
            assert!(!ConexPathNormalizer::is_system_critical_path(Path::new(
                "D:/workspace"
            )));
        }
    }

    #[tokio::test]
    async fn test_check_unc_path_async() {
        let local_path = PathBuf::from("C:/nonexistent_random_path_123456789");
        let exists = ConexPathNormalizer::check_unc_path_async(local_path)
            .await
            .unwrap();
        assert!(!exists);
    }
}
