//! 删除影响面评估（I2-S8：删除/回退操作预检）
//!
//! 删除类操作执行前计算影响面（文件数 / 总大小 / 目录数 / 跨目录），
//! 作为审计事件载荷与（S9）审批弹窗数据源。目标缺失按跳过处理
//! （评估非安全边界，真实删除仍由 trash 服务守卫）；遍历一律使用
//! 不跟随符号链接的 `symlink_metadata`，避免符号链接环导致死循环。
//!
//! 载荷类型 `ImpactAssessment` 属于双端事件契约（wire 结构），定义已
//! 上移至 conex-types（`conex_types::impact`），本模块重导出以保持既有
//! 消费方 API（`conex_fs::impact::ImpactAssessment`）不变。

pub use conex_types::impact::{IMPACT_FLAG_FILE_THRESHOLD, ImpactAssessment};

use std::path::{Path, PathBuf};

/// 对一组删除目标评估影响面（缺失/不可读目标跳过）
pub fn assess(targets: &[PathBuf]) -> ImpactAssessment {
    let mut file_count = 0u64;
    let mut total_size_bytes = 0u64;
    let mut directory_count = 0u64;
    let mut parents: Vec<PathBuf> = Vec::new();

    for target in targets {
        let meta = match std::fs::symlink_metadata(target) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.file_type().is_dir() {
            directory_count += 1;
            let (files, size) = walk_dir(target, &mut parents);
            file_count += files;
            total_size_bytes += size;
        } else {
            // 普通文件 / 符号链接统一按单文件计
            file_count += 1;
            total_size_bytes += meta.len();
            if let Some(p) = target.parent() {
                parents.push(p.to_path_buf());
            }
        }
    }

    parents.sort();
    parents.dedup();
    let cross_directory = parents.len() > 1;
    let flagged = file_count > IMPACT_FLAG_FILE_THRESHOLD;

    ImpactAssessment {
        file_count,
        total_size_bytes,
        directory_count,
        cross_directory,
        flagged,
    }
}

/// 递归遍历目录：返回（文件数, 总大小），并把每个文件的父目录记入 parents
///
/// 遍历一律使用不跟随符号链接的元数据入口（`symlink_metadata` +
/// `file_type().is_dir()`，兑现模块头承诺）：目录内的 symlink/junction
/// 按单条计（取链接自身大小），不跟随目标、不递归——防指向祖先的链接环
/// 导致无限递归栈溢出。
fn walk_dir(dir: &Path, parents: &mut Vec<PathBuf>) -> (u64, u64) {
    let mut count = 0u64;
    let mut size = 0u64;
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return (0, 0),
    };
    for entry in rd.flatten() {
        let path = entry.path();
        let meta = match std::fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let ft = meta.file_type();
        if ft.is_symlink() {
            // 符号链接/目录联接（junction）：按单条计（取链接自身大小），
            // 不跟随目标、不递归（防指向祖先的环导致无限递归栈溢出）
            count += 1;
            size += meta.len();
            if let Some(p) = path.parent() {
                parents.push(p.to_path_buf());
            }
        } else if ft.is_dir() {
            let (files, bytes) = walk_dir(&path, parents);
            count += files;
            size += bytes;
        } else if ft.is_file() {
            count += 1;
            size += meta.len();
            if let Some(p) = path.parent() {
                parents.push(p.to_path_buf());
            }
        }
    }
    (count, size)
}

#[cfg(test)]
mod tests {
    // G2 禁令豁免：测试 mod——junction 环测试辅助用 cmd mklink /J 建目录
    // 联接（命令名固定、参数为临时目录路径），非产品执行面；
    // 测试 mod 内 allow + 理由（裁决 D8 背书）。
    #![allow(clippy::disallowed_methods)]
    use super::*;

    /// 测试用临时目录（drop 自动清理）
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "conex_fs_impact_{tag}_{}_{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn write(&self, rel: &str, content: &str) -> PathBuf {
            let p = self.0.join(rel);
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(&p, content).unwrap();
            p
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn single_file_counts_one() {
        let d = TempDir::new("single");
        let f = d.write("a.txt", "hello");
        let a = assess(&[f]);
        assert_eq!(a.file_count, 1);
        assert_eq!(a.total_size_bytes, 5);
        assert_eq!(a.directory_count, 0);
        assert!(!a.cross_directory);
        assert!(!a.flagged);
    }

    #[test]
    fn directory_recursive_counts_and_spans_subdirs() {
        let d = TempDir::new("dir");
        d.write("sub/inner.txt", "inner");
        d.write("sub/deep/x.txt", "x");
        let a = assess(&[d.0.join("sub")]);
        assert_eq!(a.file_count, 2);
        assert_eq!(a.directory_count, 1);
        assert_eq!(a.total_size_bytes, 6);
        assert!(a.cross_directory, "子目录内文件分布在多个父目录");
    }

    #[test]
    fn two_files_same_parent_not_cross_directory() {
        let d = TempDir::new("same");
        d.write("a.txt", "a");
        d.write("b.txt", "b");
        let a = assess(&[d.0.join("a.txt"), d.0.join("b.txt")]);
        assert_eq!(a.file_count, 2);
        assert!(!a.cross_directory);
    }

    #[test]
    fn two_dirs_cross_directory() {
        let d = TempDir::new("two");
        d.write("x/a.txt", "a");
        d.write("y/b.txt", "b");
        let a = assess(&[d.0.join("x"), d.0.join("y")]);
        assert_eq!(a.file_count, 2);
        assert!(a.cross_directory);
    }

    #[test]
    fn flag_threshold_strictly_over_20() {
        let d = TempDir::new("th");
        let files: Vec<PathBuf> = (0..21)
            .map(|i| d.write(&format!("f{i:02}.txt"), "x"))
            .collect();
        assert!(assess(&files).flagged, "21 个文件应带谨慎标记");

        let under: Vec<PathBuf> = files[..20].to_vec();
        assert!(!assess(&under).flagged, "恰好 20 个文件不触发谨慎标记");
    }

    #[test]
    fn missing_target_skipped() {
        let d = TempDir::new("miss");
        let a = assess(&[d.0.join("ghost.txt")]);
        assert_eq!(a.file_count, 0);
        assert_eq!(a.total_size_bytes, 0);
    }

    #[test]
    fn symlink_cycle_does_not_hang() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let d = TempDir::new("cycle");
            d.write("real.txt", "x");
            let _ = symlink(&d.0, d.0.join("loop"));
            let a = assess(&[d.0.clone()]);
            // 符号链接按单条计，不递归展开（防环）：real.txt + loop 共 2 条
            assert_eq!(a.file_count, 2, "顶层 symlink 必须计 1 条且不递归");
            assert!(a.total_size_bytes >= 1);
        }
        // Windows 无 symlink 权限时跳过该场景
    }

    #[test]
    fn subdir_symlink_to_ancestor_not_recursed() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let d = TempDir::new("cycle_sub");
            d.write("sub/inner.txt", "inner");
            let _ = symlink(&d.0, d.0.join("sub/loop"));
            let a = assess(&[d.0.clone()]);
            // 递归层（walk_dir）的 symlink 指向祖先目录：不得无限递归
            assert_eq!(
                a.file_count,
                2,
                "sub 内 symlink 指向祖先：inner.txt + loop 共 2 条"
            );
        }
        // Windows 场景由 junction 用例覆盖
    }

    #[test]
    fn junction_cycle_inside_dir_not_recursed() {
        #[cfg(windows)]
        {
            use std::process::Command;
            let d = TempDir::new("junc_sub");
            d.write("sub/inner.txt", "inner");
            // cmd mklink /J 建目录联接普通用户可建（无需管理员权限）
            let out = Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(d.0.join("sub").join("loop"))
                .arg(&d.0)
                .output();
            let ok = out.map(|o| o.status.success()).unwrap_or(false);
            if !ok {
                // CI 无 cmd 或目录权限受限时跳过（对齐既有 :202 先例）
                return;
            }
            let a = assess(std::slice::from_ref(&d.0));
            // 目录内 junction 指向祖先：环内条目计 1 条，不得递归展开
            assert_eq!(a.file_count, 2, "junction 环必须有限且环内条目计 1 条");
            assert!(a.total_size_bytes >= 5, "真实文件大小计入");
        }
    }
}
