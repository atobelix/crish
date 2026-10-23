//! conex-fs —— 文件系统安全工具域
//!
//! - `atomic_write`：Windows 3 阶段原子写（tmp -> sync_all -> bak -> rename -> rollback，Round-3）
//! - `path_utils`：路径安全（safe_canonicalize / compute_file_hash / ensure_parent_dir）
//! - `trash`：回收站服务（删除接管统一接口，I2-S3）
//! - `impact`：删除影响面评估（I2-S8：文件数 / 大小 / 跨目录预检）
//! - `watch`：工作区文件监视（T-ESC-01：脚本逃逸追踪数据面——notify 8 封装
//!   事件流 + Rename 聚合 + 排除清单 + 内部瞬态文件自然过滤，供 session-loop 判定面消费）

pub mod atomic_write;
pub mod impact;
pub mod path_normalizer;
pub mod trash;
pub mod watch;
pub mod windowed_read;

pub use atomic_write::{atomic_write, atomic_write_file, AtomicWriteState, AtomicWriteTx};
pub use path_normalizer::ConexPathNormalizer;
pub use path_utils::{
    compute_file_hash, ensure_parent_dir, is_dos_device_name, resolve_symlink_chain,
    safe_canonicalize, strip_verbatim_prefix, SymlinkResolveError,
};
pub use watch::{glob_match, is_internal_atomic_transient_path, watcher_filter};
pub use windowed_read::{
    clamp_window_text_by_chars, windowed_read, WindowEncoding, WindowReadError, WindowReadOptions,
    WindowReadResult, DEFAULT_BINARY_PROBE_BYTES,
};

pub mod path_utils {
    use anyhow::{bail, Result};
    use std::path::{Component, Path, PathBuf};

    /// 剥离 Windows canonicalize 的 `\\?\` / `\\?\UNC\` 前缀（其它平台原样返回）
    ///
    /// 对 `\\?\UNC\server\share\file` 严格规范化为 `\\server\share\file`（双反斜杠标准 UNC 格式）。
    pub fn strip_verbatim_prefix(path: impl AsRef<Path>) -> PathBuf {
        let path = path.as_ref();
        #[cfg(windows)]
        {
            let s = path.to_string_lossy();
            if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
                return PathBuf::from(format!(r"\\{rest}"));
            }
            if let Some(rest) = s.strip_prefix(r"\\?\") {
                return PathBuf::from(rest.to_string());
            }
            if let Some(rest) = s.strip_prefix(r"\\.\") {
                return PathBuf::from(rest.to_string());
            }
        }
        path.to_path_buf()
    }

    /// 检查是否为 Windows DOS 保留设备名称（如 CON, PRN, AUX, NUL, COM1-9, LPT1-9, CONIN$, CONOUT$ 等）
    pub fn is_dos_device_name(name: &str) -> bool {
        let s = name.trim();
        let stem = s.split('.').next().unwrap_or(s);
        let stem = stem.split(':').next().unwrap_or(stem).trim();
        let upper = stem.to_ascii_uppercase();
        matches!(
            upper.as_str(),
            "CON"
                | "PRN"
                | "AUX"
                | "NUL"
                | "CONIN$"
                | "CONOUT$"
                | "COM1"
                | "COM2"
                | "COM3"
                | "COM4"
                | "COM5"
                | "COM6"
                | "COM7"
                | "COM8"
                | "COM9"
                | "LPT1"
                | "LPT2"
                | "LPT3"
                | "LPT4"
                | "LPT5"
                | "LPT6"
                | "LPT7"
                | "LPT8"
                | "LPT9"
        )
    }

    /// Safely canonicalize a path with depth limiting and traversal protection.
    /// Prevents path traversal attacks (../ sequences), drive-relative paths (C:file.txt),
    /// DOS reserved devices (CON, NUL, AUX, etc.), and enforces max component depth.
    pub fn safe_canonicalize(path: impl AsRef<Path>, max_depth: usize) -> Result<PathBuf> {
        let path = path.as_ref();

        if path.as_os_str().is_empty() {
            bail!("path is empty");
        }

        // Reject null bytes
        let path_str = path.to_string_lossy();
        if path_str.contains('\0') {
            bail!("path contains null byte");
        }

        // 拦截驱动器相对路径（如 "C:file.txt", "d:sub\foo"）
        let bytes = path_str.as_bytes();
        if bytes.len() >= 2
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes.len() == 2 || (bytes[2] != b'/' && bytes[2] != b'\\'))
        {
            bail!(
                "drive-relative path not allowed: '{}' (must be absolute with root slash)",
                path_str
            );
        }

        // 拦截 Windows DOS 保留设备名称（按路径分隔符切分检查）
        for seg in path_str.split(['/', '\\']) {
            if !seg.is_empty() && is_dos_device_name(seg) {
                bail!(
                    "DOS device name detected: '{}' is a reserved device name",
                    seg
                );
            }
        }

        // Count depth and check for traversal and prefix components
        let mut depth: usize = 0;
        let mut components_iter = path.components().peekable();
        if let Some(Component::Prefix(_)) = components_iter.peek() {
            components_iter.next();
            match components_iter.peek() {
                Some(Component::RootDir) => {} // Absolute drive path C:\... -> OK
                _ => {
                    bail!("drive-relative path not allowed: '{}'", path.display());
                }
            }
        }

        for component in path.components() {
            match component {
                Component::ParentDir => {
                    bail!("path traversal detected: '..' component not allowed");
                }
                Component::Normal(os_str) => {
                    let name = os_str.to_string_lossy();
                    if is_dos_device_name(&name) {
                        bail!(
                            "DOS device name detected: '{}' is a reserved device name",
                            name
                        );
                    }
                    depth += 1;
                    if depth > max_depth {
                        bail!(
                            "path depth {} exceeds maximum allowed depth {}",
                            depth,
                            max_depth
                        );
                    }
                }
                _ => {}
            }
        }

        // Attempt canonicalization (resolves symlinks and . components)
        match path.canonicalize() {
            Ok(canonical) => Ok(canonical),
            Err(_) => {
                // canonicalize 失败（目标或某级祖先不存在）→「最深已存在祖先」
                // canonicalize + 剩余成分词法拼接（审计 P1-S1，F3-02/F5-01）：
                // 父级 symlink 由此被解析进结果，调用方做包含性校验即可拦截
                // 根外写入（修复前纯词法归一不解析任何父级 symlink）。
                // 注意：dangling symlink（链接目标不存在）无法被 canonicalize，
                // 该形态保持词法尾部，由调用方对词法尾部逐级 symlink_metadata
                // 显式拒绝（双保险）。
                let mut existing = path.to_path_buf();
                let mut tail: Vec<std::ffi::OsString> = Vec::new();
                while !existing.exists() {
                    match existing.file_name() {
                        Some(name) => {
                            tail.push(name.to_os_string());
                            existing.pop();
                        }
                        None => break,
                    }
                }
                if existing.exists() {
                    let mut resolved = existing.canonicalize().unwrap_or(existing);
                    for name in tail.iter().rev() {
                        resolved.push(name);
                    }
                    return Ok(resolved);
                }
                // 兜底：纯词法归一（理论不可达——根总存在；保守保持旧行为）
                let mut normalized = PathBuf::new();
                for component in path.components() {
                    match component {
                        Component::CurDir => {} // skip "."
                        Component::ParentDir => {
                            bail!("path traversal detected during normalization");
                        }
                        other => normalized.push(other),
                    }
                }
                Ok(normalized)
            }
        }
    }

    /// Compute SHA-256 hash of a file's contents.
    pub fn compute_file_hash(path: impl AsRef<Path>) -> Result<String> {
        use sha2::{Digest, Sha256};
        use std::fs;

        let content = fs::read(path.as_ref())
            .map_err(|e| anyhow::anyhow!("failed to read file for hashing: {e}"))?;
        let mut hasher = Sha256::new();
        hasher.update(&content);
        let result = hasher.finalize();
        Ok(hex::encode(result))
    }

    /// Ensure the parent directory of a path exists, creating it if necessary.
    pub fn ensure_parent_dir(path: impl AsRef<Path>) -> Result<()> {
        use std::fs;

        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                fs::create_dir_all(parent)
                    .map_err(|e| anyhow::anyhow!("failed to create parent directory: {e}"))?;
            }
        }
        Ok(())
    }

    use crate::path_normalizer::ConexPathNormalizer;
    use std::collections::HashSet;

    #[derive(Debug, thiserror::Error)]
    pub enum SymlinkResolveError {
        #[error("I/O error during symlink resolution: {0}")]
        Io(#[from] std::io::Error),
        #[error("Cyclic symlink detected at: {0}")]
        Cyclic(PathBuf),
        #[error("Symlink traversal depth exceeded maximum limit ({0})")]
        DepthExceeded(usize),
    }

    /// 递归规范化解析符号链接/Junction 直至物理终态路径
    pub fn resolve_symlink_chain(
        start_path: &Path,
        max_hops: usize,
    ) -> std::result::Result<PathBuf, SymlinkResolveError> {
        let mut current = ConexPathNormalizer::normalize(start_path);
        let mut visited = HashSet::new();
        let mut hops = 0;

        while hops < max_hops {
            let meta = match std::fs::symlink_metadata(&current) {
                Ok(m) => m,
                Err(_) => break, // 目标不存在或无权限读取元数据，视为终态
            };

            if !meta.file_type().is_symlink() {
                break; // 终态物理文件/目录
            }

            let normalized_current = ConexPathNormalizer::normalize(&current);
            if !visited.insert(normalized_current.clone()) {
                return Err(SymlinkResolveError::Cyclic(current));
            }

            let raw_target = std::fs::read_link(&current)?;
            let next_path = if raw_target.is_absolute() {
                raw_target
            } else {
                let parent = current.parent().unwrap_or_else(|| Path::new("."));
                parent.join(raw_target)
            };

            current = ConexPathNormalizer::normalize(&next_path);
            hops += 1;

            if hops >= max_hops {
                return Err(SymlinkResolveError::DepthExceeded(max_hops));
            }
        }

        Ok(current)
    }
}

#[cfg(test)]
mod tests {
    // G2 禁令豁免：测试临时目录清理（非产品删除路径，可恢复语义不适用）。
    #![allow(clippy::disallowed_methods)]

    use super::path_utils::*;
    use std::io::Write;
    use std::path::Path;

    #[test]
    fn safe_canonicalize_normal_path() {
        let result = safe_canonicalize("src/main.rs", 10);
        assert!(result.is_ok());
    }

    #[test]
    fn safe_canonicalize_rejects_traversal() {
        let result = safe_canonicalize("../../../etc/passwd", 10);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("traversal"));
    }

    #[test]
    fn safe_canonicalize_rejects_empty() {
        let result = safe_canonicalize("", 10);
        assert!(result.is_err());
    }

    #[test]
    fn safe_canonicalize_enforces_depth() {
        let deep_path = "a/b/c/d/e/f/g/h/i/j/k";
        let result = safe_canonicalize(deep_path, 5);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("depth"));
    }

    #[test]
    fn safe_canonicalize_allows_within_depth() {
        let result = safe_canonicalize("a/b/c", 5);
        assert!(result.is_ok());
    }

    /// 目录符号链接（Unix symlink；Windows 优先真 symlink（开发者模式），
    /// 无权限时回退 junction（mklink /J，普通用户可建）——junction 在 std
    /// 语义下与 symlink 等效（is_symlink=true / canonicalize 跟随 / 写入跟随），
    /// 保证无管理员环境也能复现 symlink 逃逸缺陷；失败返回 Err 由调用方跳过）
    #[cfg(unix)]
    fn create_dir_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn create_dir_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        match std::os::windows::fs::symlink_dir(target, link) {
            Ok(()) => Ok(()),
            Err(_) => {
                let status = std::process::Command::new("cmd")
                    .args(["/c", "mklink", "/J"])
                    .arg(link)
                    .arg(target)
                    .status()?;
                if status.success() {
                    Ok(())
                } else {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "failed to create directory symlink",
                    ))
                }
            }
        }
    }

    /// 红测试（审计 P1-S1，F3-02/F5-01）：目标不存在但父级为符号链接时，
    /// safe_canonicalize 必须解析「最深已存在祖先」中的 symlink——父目录
    /// 指向根外目录时，解析结果应落到根外，由调用方包含性校验拦截。
    /// 修复前词法归一返回 root/link/new.txt（不解析 link）→ 红。
    #[test]
    fn safe_canonicalize_resolves_symlink_parent_for_nonexistent_target() {
        let temp = std::env::temp_dir().join("conex_fs_test_symlink_escape");
        let root = temp.join("workspace");
        let outside = temp.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let link = root.join("link");
        if create_dir_symlink(&outside, &link).is_err() {
            return; // 无符号链接权限环境跳过（Windows 开发者模式）
        }
        let p = safe_canonicalize(root.join("link/new.txt"), 10).unwrap();
        // 最深已存在祖先（root/link → outside）canonicalize + 剩余成分拼接
        let expected = outside.canonicalize().unwrap().join("new.txt");
        assert_eq!(p, expected);
        let _ = std::fs::remove_dir_all(&temp);
    }

    /// 语义锁定：dangling symlink（链接目标不存在）无法 canonicalize，
    /// 最深已存在祖先上溯到根后保持词法尾部——该形态由调用方对词法尾部
    /// 逐级 symlink_metadata 显式拒绝（双保险），safe_canonicalize 不吞不转。
    #[test]
    fn safe_canonicalize_preserves_tail_for_dangling_symlink() {
        let temp = std::env::temp_dir().join("conex_fs_test_symlink_dangling");
        let root = temp.join("workspace");
        std::fs::create_dir_all(&root).unwrap();
        let link = root.join("link");
        if create_dir_symlink(&temp.join("outside-ghost"), &link).is_err() {
            return; // 无符号链接权限环境跳过（Windows 开发者模式）
        }
        let p = safe_canonicalize(root.join("link/new.txt"), 10).unwrap();
        // 最深已存在祖先（根）canonicalize + 组件级词法拼接（Windows 下
        // canonicalize 产物带 \\?\ 前缀与反斜杠分隔符，按组件拼接保持形态一致）
        let expected = root.canonicalize().unwrap().join("link").join("new.txt");
        assert_eq!(p, expected);
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn compute_file_hash_produces_hex() {
        let dir = std::env::temp_dir().join("conex_fs_test_hash");
        std::fs::create_dir_all(&dir).unwrap();
        let file_path = dir.join("test.txt");
        let mut f = std::fs::File::create(&file_path).unwrap();
        f.write_all(b"hello world").unwrap();
        drop(f);

        let hash = compute_file_hash(&file_path).unwrap();
        assert_eq!(hash.len(), 64); // SHA-256 = 32 bytes = 64 hex chars
                                    // Known SHA-256 of "hello world"
        assert_eq!(
            hash,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn compute_file_hash_nonexistent_file() {
        let result = compute_file_hash("/nonexistent/file.txt");
        assert!(result.is_err());
    }

    #[test]
    fn ensure_parent_dir_creates_directory() {
        let dir = std::env::temp_dir().join("conex_fs_test_parent");
        let file_path = dir.join("sub/dir/file.txt");

        // Clean up first
        std::fs::remove_dir_all(&dir).ok();

        let result = ensure_parent_dir(&file_path);
        assert!(result.is_ok());
        assert!(file_path.parent().unwrap().exists());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn strip_verbatim_prefix_handles_unc_and_local() {
        let unc_path = Path::new(r"\\?\UNC\server\share\file.txt");
        let stripped_unc = strip_verbatim_prefix(unc_path);
        #[cfg(windows)]
        assert_eq!(stripped_unc.to_string_lossy(), r"\\server\share\file.txt");
        #[cfg(not(windows))]
        assert_eq!(stripped_unc, unc_path);

        let local_path = Path::new(r"\\?\C:\workspace\file.txt");
        let stripped_local = strip_verbatim_prefix(local_path);
        #[cfg(windows)]
        assert_eq!(stripped_local.to_string_lossy(), r"C:\workspace\file.txt");
        #[cfg(not(windows))]
        assert_eq!(stripped_local, local_path);

        let dot_path = Path::new(r"\\.\pipe\test");
        let stripped_dot = strip_verbatim_prefix(dot_path);
        #[cfg(windows)]
        assert_eq!(stripped_dot.to_string_lossy(), r"pipe\test");
        #[cfg(not(windows))]
        assert_eq!(stripped_dot, dot_path);

        let plain_path = Path::new(r"C:\simple\path.txt");
        let stripped_plain = strip_verbatim_prefix(plain_path);
        assert_eq!(stripped_plain, plain_path);
    }

    #[test]
    fn safe_canonicalize_rejects_drive_relative_paths() {
        let cases = ["C:file.txt", "d:sub/dir.txt", "C:", "x:foo\\bar"];
        for case in cases {
            let res = safe_canonicalize(case, 10);
            assert!(
                res.is_err(),
                "驱动器相对路径必须被 safe_canonicalize 拦截: {case}"
            );
            let err = res.unwrap_err().to_string();
            assert!(
                err.contains("drive-relative"),
                "错误信息必须明确提示 drive-relative: {err}"
            );
        }
    }

    #[test]
    fn safe_canonicalize_rejects_dos_device_names() {
        let cases = [
            "CON",
            "con",
            "PRN",
            "prn",
            "AUX",
            "aux",
            "NUL",
            "nul",
            "nul.txt",
            "con.tar.gz",
            "AUX.json",
            "COM1",
            "com3.log",
            "LPT1",
            "lpt9.dat",
            "CONIN$",
            "conout$",
            "folder/CON/file.txt",
            "sub/nul.txt",
            r"dir\aux\test.rs",
        ];
        for case in cases {
            let res = safe_canonicalize(case, 10);
            assert!(
                res.is_err(),
                "DOS 保留设备名称必须被 safe_canonicalize 拦截: {case}"
            );
            let err = res.unwrap_err().to_string();
            assert!(
                err.contains("DOS device name"),
                "错误信息必须明确提示 DOS device name: {err}"
            );
        }
    }
}
