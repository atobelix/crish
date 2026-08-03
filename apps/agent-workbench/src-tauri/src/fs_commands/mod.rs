pub(crate) mod delete;
pub(crate) mod dialog;
pub(crate) mod directory;
pub(crate) mod read;
pub(crate) mod skills;
pub(crate) mod types;
pub(crate) mod write;

pub(crate) use types::{FileCommandError, WorkspaceFsGuard};

/// 原生目录选择器：唯一「新授权」入口（PE-07 T07.2）。
/// 选中路径 → WorkspaceRegistry::register(Dialog) → 返回 canonical 路径。
#[tauri::command]
pub(crate) async fn select_folder(
    app: tauri::AppHandle,
) -> Result<types::SelectFolderResult, String> {
    dialog::select_folder(app).await
}

/// 列出目录（PE-07 T07.2：无 workspace_root 参数，根由 WorkspaceRegistry 解析）。
#[tauri::command]
pub(crate) fn list_directory(
    app: tauri::AppHandle,
    path: String,
) -> Result<types::ListDirectoryResult, FileCommandError> {
    directory::list_directory(&app, path)
}

/// 读取文件内容（PE-07 T07.2：无 workspace_root 参数，根由 WorkspaceRegistry 解析）。
#[tauri::command]
pub(crate) fn read_file_content(
    app: tauri::AppHandle,
    path: String,
    max_lines: Option<usize>,
) -> Result<types::ReadFileContentResult, FileCommandError> {
    read::read_file_content(&app, path, max_lines)
}

/// 写入文件内容（PE-07 T07.2：无 workspace_root 参数，根由 WorkspaceRegistry 解析）。
#[tauri::command]
pub(crate) fn write_file_content(
    app: tauri::AppHandle,
    path: String,
    content: String,
) -> Result<types::WriteFileContentResult, FileCommandError> {
    write::write_file_content(&app, path, content)
}

/// 删除单个文件（PE-07 T07.3 C-03：替代 PowerShell Remove-Item 拼串）。
#[tauri::command]
pub(crate) fn workbench_fs_delete_file(
    app: tauri::AppHandle,
    path: String,
) -> Result<types::DeleteFileResult, FileCommandError> {
    delete::delete_file(&app, path)
}

/// 发现技能（PE-07 T07.2：workspace_path / extra_dirs 经注册表包含性校验）。
#[tauri::command]
pub(crate) fn workbench_discover_skills(
    app: tauri::AppHandle,
    workspace_path: Option<String>,
    extra_dirs: Vec<String>,
) -> Result<Vec<skills::RustSkill>, String> {
    skills::workbench_discover_skills(&app, workspace_path, extra_dirs)
}

#[cfg(test)]
mod tests {
    // G2 禁令豁免：测试临时目录清理（非产品删除路径，可恢复语义不适用）。
    #![allow(clippy::disallowed_methods)]

    use std::{
        env, fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    use crate::fs_commands::types::{self, FileCommandError, ReadPolicy, MAX_TEXT_FILE_BYTES};
    use crate::fs_commands::{delete, directory, read, WorkspaceFsGuard};

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new() -> Self {
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

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn assert_error_code<T>(result: Result<T, FileCommandError>, expected: &str) {
        match result {
            Ok(_) => panic!("expected error code {expected}, got success"),
            Err(err) => assert_eq!(err.code, expected),
        }
    }

    fn guard_for(root: &Path) -> WorkspaceFsGuard {
        WorkspaceFsGuard::new(root).expect("create guard")
    }

    fn read_file_content_at_root(
        root: &Path,
        path: &str,
        max_lines: Option<usize>,
    ) -> Result<types::ReadFileContentResult, FileCommandError> {
        read::read_file_content_with_guard(
            &guard_for(root),
            path,
            ReadPolicy::for_preview(max_lines),
        )
    }

    fn list_directory_at_root(
        root: &Path,
        path: &str,
    ) -> Result<types::ListDirectoryResult, FileCommandError> {
        directory::list_directory_with_guard(&guard_for(root), path)
    }

    #[test]
    fn read_file_content_allows_file_under_root() {
        let temp = TestDir::new();
        let root = temp.path().join("workspace");
        fs::create_dir(&root).expect("create root");
        let file = root.join("src").join("main.rs");
        fs::create_dir_all(file.parent().expect("file parent")).expect("create parent");
        fs::write(&file, "fn main() {}\nprintln!(\"ok\");\n").expect("write file");

        let result = read_file_content_at_root(&root, "src/main.rs", Some(1)).expect("read file");

        assert_eq!(result.content, "fn main() {}");
        assert_eq!(result.line_count, 1);
        assert!(result.truncated);
    }

    #[test]
    fn list_directory_rejects_path_traversal_outside_root() {
        let temp = TestDir::new();
        let root = temp.path().join("workspace");
        let outside = temp.path().join("outside");
        fs::create_dir_all(root.join("nested")).expect("create nested");
        fs::create_dir(&outside).expect("create outside");

        let traversal = root
            .join("nested")
            .join("..")
            .join("..")
            .join("outside")
            .to_string_lossy()
            .to_string();

        assert_error_code(
            list_directory_at_root(&root, &traversal),
            types::ERR_OUTSIDE_WORKSPACE,
        );
    }

    #[test]
    fn read_file_content_rejects_absolute_path_outside_root() {
        let temp = TestDir::new();
        let root = temp.path().join("workspace");
        let outside = temp.path().join("outside.txt");
        fs::create_dir(&root).expect("create root");
        fs::write(&outside, "secret").expect("write outside");

        assert_error_code(
            read_file_content_at_root(&root, &outside.to_string_lossy(), None),
            types::ERR_OUTSIDE_WORKSPACE,
        );
    }

    #[test]
    fn read_file_content_rejects_large_files_before_decoding() {
        let temp = TestDir::new();
        let root = temp.path().join("workspace");
        let large = root.join("large.txt");
        fs::create_dir(&root).expect("create root");
        fs::write(&large, vec![b'a'; MAX_TEXT_FILE_BYTES + 1]).expect("write large file");

        assert_error_code(
            read_file_content_at_root(&root, "large.txt", None),
            types::ERR_FILE_TOO_LARGE,
        );
    }

    #[test]
    fn read_file_content_rejects_binary_files() {
        let temp = TestDir::new();
        let root = temp.path().join("workspace");
        let binary = root.join("image.bin");
        fs::create_dir(&root).expect("create root");
        fs::write(&binary, [0x66, 0x00, 0x67, 0x68]).expect("write binary file");

        assert_error_code(
            read_file_content_at_root(&root, "image.bin", None),
            types::ERR_BINARY_FILE,
        );
    }

    #[test]
    fn read_file_content_rejects_non_utf8_text() {
        let temp = TestDir::new();
        let root = temp.path().join("workspace");
        let file = root.join("latin1.txt");
        fs::create_dir(&root).expect("create root");
        fs::write(&file, [0x66, 0xE9, 0x67]).expect("write non-utf8 file");

        assert_error_code(
            read_file_content_at_root(&root, "latin1.txt", None),
            types::ERR_UNSUPPORTED_ENCODING,
        );
    }

    #[test]
    fn read_file_content_stops_output_at_line_limit() {
        let temp = TestDir::new();
        let root = temp.path().join("workspace");
        let file = root.join("many.txt");
        fs::create_dir(&root).expect("create root");
        fs::write(&file, "one\ntwo\nthree\n").expect("write text file");

        let result = read_file_content_at_root(&root, "many.txt", Some(2)).expect("read file");

        assert_eq!(result.content, "one\ntwo");
        assert_eq!(result.line_count, 2);
        assert!(result.truncated);
    }

    #[test]
    fn read_file_content_preserves_content_when_line_limit_matches_file() {
        let temp = TestDir::new();
        let root = temp.path().join("workspace");
        let file = root.join("two.txt");
        fs::create_dir(&root).expect("create root");
        fs::write(&file, "one\ntwo\n").expect("write text file");

        let result = read_file_content_at_root(&root, "two.txt", Some(2)).expect("read file");

        assert_eq!(result.content, "one\ntwo\n");
        assert_eq!(result.line_count, 2);
        assert!(!result.truncated);
    }

    #[test]
    fn read_file_content_rejects_symlink_escaping_root() {
        let temp = TestDir::new();
        let root = temp.path().join("workspace");
        let outside = temp.path().join("outside.txt");
        let link = root.join("link.txt");
        fs::create_dir(&root).expect("create root");
        fs::write(&outside, "secret").expect("write outside");

        if create_file_symlink(&outside, &link).is_err() {
            return;
        }

        assert_error_code(
            read_file_content_at_root(&root, "link.txt", None),
            types::ERR_OUTSIDE_WORKSPACE,
        );
    }

    #[test]
    fn guard_new_rejects_unreachable_root() {
        // T07.2 用例 13（P-02 关闭）：根不可达 → 构造失败，不裸用传入根
        let temp = TestDir::new();
        let missing = temp.path().join("no-such-root");
        let err = WorkspaceFsGuard::new(&missing).expect_err("unreachable root must be rejected");
        assert_eq!(err.code, types::ERR_INTERNAL);
    }

    #[cfg(unix)]
    fn create_file_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn create_file_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_file(target, link)
    }

    // ── S11 补缺：delete_file（删除接管）──

    fn delete_at_root(root: &Path, trash_root: &Path, path: &str) -> Result<types::DeleteFileResult, FileCommandError> {
        delete::delete_file_with_guard(&guard_for(root), trash_root, path)
    }

    /// 成功路径：删除 = 移入回收站 + 登记（原路径消失、可经恢复接口还原）
    #[test]
    fn delete_file_moves_into_trash_and_restores() {
        let temp = TestDir::new();
        let root = temp.path().join("workspace");
        let trash = temp.path().join("trash");
        fs::create_dir(&root).expect("create root");
        let file = root.join("a.txt");
        fs::write(&file, "deletable content").expect("write file");

        let result = delete_at_root(&root, &trash, "a.txt").expect("delete");
        assert!(result.deleted);
        assert!(!file.exists(), "删除后原路径应消失（移入回收站）");

        // 回收站登记可见，且内容可恢复（字节一致）
        let entries = conex_fs::trash::TrashService::new(&trash).list();
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry.original_path, file);
        assert!(entry.checksum.is_some(), "backup=true 应写校验和");

        conex_fs::trash::TrashService::new(&trash)
            .restore(&entry.id)
            .expect("restore");
        assert_eq!(
            std::fs::read_to_string(&file).expect("read restored"),
            "deletable content"
        );
    }

    /// 拒绝路径：目录不是删除目标（only files）→ not_file
    #[test]
    fn delete_file_rejects_directory() {
        let temp = TestDir::new();
        let root = temp.path().join("workspace");
        let trash = temp.path().join("trash");
        fs::create_dir_all(root.join("dir")).expect("create dir");

        assert_error_code(
            delete_at_root(&root, &trash, "dir"),
            types::ERR_NOT_FILE,
        );
        assert!(root.join("dir").exists(), "拒绝后目录不得被移动");
    }

    /// 拒绝路径：越界绝对路径 → outside_workspace（沙箱解析层拦截）
    #[test]
    fn delete_file_rejects_path_outside_workspace() {
        let temp = TestDir::new();
        let root = temp.path().join("workspace");
        let trash = temp.path().join("trash");
        let outside = temp.path().join("outside.txt");
        fs::create_dir(&root).expect("create root");
        fs::write(&outside, "secret").expect("write outside");

        assert_error_code(
            delete_at_root(&root, &trash, &outside.to_string_lossy()),
            types::ERR_OUTSIDE_WORKSPACE,
        );
        assert!(outside.exists(), "越界目标不得被删除");
    }

    /// 错误路径：目标不存在 → path_not_found
    #[test]
    fn delete_file_rejects_missing_target() {
        let temp = TestDir::new();
        let root = temp.path().join("workspace");
        let trash = temp.path().join("trash");
        fs::create_dir(&root).expect("create root");

        assert_error_code(
            delete_at_root(&root, &trash, "ghost.txt"),
            types::ERR_NOT_FOUND,
        );
    }

    /// 错误路径：回收站根不可用（被文件占用）→ delete_file_failed，
    /// 且目标文件不被触碰（不静默退化物理删除）
    #[test]
    fn delete_file_fails_when_trash_root_unusable() {
        let temp = TestDir::new();
        let root = temp.path().join("workspace");
        let trash_blocker = temp.path().join("trash-blocker");
        fs::create_dir(&root).expect("create root");
        fs::write(&trash_blocker, "i am a file, not a dir").expect("write blocker");
        let file = root.join("keep.txt");
        fs::write(&file, "keep me").expect("write file");

        assert_error_code(
            delete_at_root(&root, &trash_blocker, "keep.txt"),
            types::ERR_DELETE_FILE,
        );
        assert!(file.exists(), "回收站根不可用时不得物理删除目标");
    }
}
