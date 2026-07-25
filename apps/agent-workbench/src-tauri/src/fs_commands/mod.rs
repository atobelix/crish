pub(crate) mod dialog;
pub(crate) mod directory;
pub(crate) mod read;
pub(crate) mod skills;
pub(crate) mod types;
pub(crate) mod write;

pub(crate) use types::{FileCommandError, WorkspaceFsGuard};

#[tauri::command]
pub(crate) async fn select_folder(
    app: tauri::AppHandle,
) -> Result<types::SelectFolderResult, String> {
    dialog::select_folder(app).await
}

#[tauri::command]
pub(crate) fn list_directory(
    path: String,
    workspace_root: Option<String>,
) -> Result<types::ListDirectoryResult, FileCommandError> {
    directory::list_directory(path, workspace_root)
}

#[tauri::command]
pub(crate) fn read_file_content(
    path: String,
    max_lines: Option<usize>,
    workspace_root: Option<String>,
) -> Result<types::ReadFileContentResult, FileCommandError> {
    read::read_file_content(path, max_lines, workspace_root)
}

#[tauri::command]
pub(crate) fn write_file_content(
    path: String,
    content: String,
    workspace_root: Option<String>,
) -> Result<types::WriteFileContentResult, FileCommandError> {
    write::write_file_content(path, content, workspace_root)
}

#[tauri::command]
pub(crate) fn workbench_discover_skills(
    workspace_path: Option<String>,
    extra_dirs: Vec<String>,
) -> Result<Vec<skills::RustSkill>, String> {
    skills::workbench_discover_skills(workspace_path, extra_dirs)
}

#[cfg(test)]
mod tests {
    use std::{
        env, fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    use crate::fs_commands::types::{self, FileCommandError, ReadPolicy, MAX_TEXT_FILE_BYTES};
    use crate::fs_commands::{directory, read, WorkspaceFsGuard};

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

    #[cfg(unix)]
    fn create_file_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn create_file_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_file(target, link)
    }
}
