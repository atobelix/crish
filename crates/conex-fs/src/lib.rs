//! conex-fs —— 文件系统安全工具域
//!
//! - `path_utils`：路径安全（safe_canonicalize / compute_file_hash / ensure_parent_dir）
//! - `trash`：回收站服务（删除接管统一接口，I2-S3）
//! - `impact`：删除影响面评估（I2-S8：文件数 / 大小 / 跨目录预检）
//! - `watch`：工作区文件监视（T-ESC-01：脚本逃逸追踪数据面——notify 8 封装
//!   事件流 + Rename 聚合 + 排除清单，供 session-loop 判定面消费）

pub mod impact;
pub mod trash;
pub mod watch;

pub mod path_utils {
    use anyhow::{bail, Result};
    use std::path::{Component, Path, PathBuf};

    /// Safely canonicalize a path with depth limiting and traversal protection.
    /// Prevents path traversal attacks (../ sequences) and enforces max component depth.
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

        // Count depth and check for traversal
        let mut depth: usize = 0;
        for component in path.components() {
            match component {
                Component::ParentDir => {
                    bail!("path traversal detected: '..' component not allowed");
                }
                Component::Normal(_) => {
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
        let p = safe_canonicalize(&root.join("link/new.txt"), 10).unwrap();
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
        let p = safe_canonicalize(&root.join("link/new.txt"), 10).unwrap();
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
}
