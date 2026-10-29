//! fs_commands 测试公共设施（临时工作区根、守卫、读写/列目录便捷包装）。

use std::{
    env, fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::fs_commands::types::WorkspaceFsGuard;
use crate::fs_commands::types::{self, FileCommandError, ReadPolicy};
use crate::fs_commands::{directory, read, write};

pub(super) struct TestDir {
    path: PathBuf,
}

impl TestDir {
    pub(super) fn new() -> Self {
        let base = env::temp_dir();
        for attempt in 0..100 {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time before UNIX_EPOCH")
                .as_nanos();
            let path = base.join(format!(
                "conex-fs-commands-{}-{nanos}-{attempt}",
                std::process::id()
            ));
            if fs::create_dir(&path).is_ok() {
                return Self { path };
            }
        }
        panic!("failed to create temporary test directory");
    }

    pub(super) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

pub(super) fn assert_error_code<T>(result: Result<T, FileCommandError>, expected: &str) {
    match result {
        Ok(_) => panic!("expected error code {expected}, got success"),
        Err(err) => assert_eq!(err.code, expected),
    }
}

pub(super) fn guard_for(root: &Path) -> WorkspaceFsGuard {
    WorkspaceFsGuard::new(root).expect("create guard")
}

pub(super) fn write_file_content_at_root(
    root: &Path,
    path: &str,
    content: &str,
    overwrite: bool,
) -> Result<types::WriteFileContentResult, FileCommandError> {
    write::write_file_content_with_guard(&guard_for(root), path, content, overwrite)
}

pub(super) fn read_file_content_at_root(
    root: &Path,
    path: &str,
    max_lines: Option<usize>,
) -> Result<types::ReadFileContentResult, FileCommandError> {
    read::read_file_content_with_guard(&guard_for(root), path, ReadPolicy::for_preview(max_lines))
}

pub(super) fn list_directory_at_root(
    root: &Path,
    path: &str,
) -> Result<types::ListDirectoryResult, FileCommandError> {
    directory::list_directory_with_guard(&guard_for(root), path)
}

#[cfg(unix)]
pub(super) fn create_file_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
pub(super) fn create_file_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(target, link)
}

/// 目录符号链接（Unix symlink；Windows 优先真 symlink（开发者模式），
/// 无权限时回退 junction（mklink /J，普通用户可建）——junction 在 std
/// 语义下与 symlink 等效（is_symlink=true / canonicalize 跟随 / 写入跟随），
/// 保证无管理员环境也能复现 symlink 逃逸缺陷；失败返回 Err 由调用方跳过）
#[cfg(unix)]
pub(super) fn create_dir_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
pub(super) fn create_dir_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
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
