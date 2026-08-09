pub(crate) mod delete;
pub(crate) mod dialog;
pub(crate) mod directory;
pub(crate) mod read;
pub(crate) mod skills;
pub(crate) mod types;
pub(crate) mod write;

pub(crate) use crate::core_error::CoreError;
pub(crate) use types::{FileCommandError, WorkspaceFsGuard};

/// 原生目录选择器：唯一「新授权」入口（PE-07 T07.2）。
/// 选中路径 → WorkspaceRegistry::register(Dialog) → 返回 canonical 路径。
/// 错误协议统一 `CoreError {kind, detail}`（F4 F1-02 / PS-04 T4.5）。
///
/// `R: tauri::Runtime` 泛型：测试注入 MockRuntime 可直接调用（先例
/// core_commands.rs:170-177），生产走 Wry。
/// wire 名 = `workbench_select_folder`（T-F 06：分裂标签统一——函数名与 wire 键
/// 不一致必须显式 rename，禁止函数名隐式成为 wire 键）。
#[tauri::command(rename = "workbench_select_folder")]
pub(crate) async fn select_folder<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<types::SelectFolderResult, CoreError> {
    dialog::select_folder(app).await
}

/// 列出目录（PE-07 T07.2：无 workspace_root 参数，根由 WorkspaceRegistry 解析）。
///
/// wire 名 = `workbench_list_directory`（T-F 06：分裂标签统一，显式 rename）。
#[tauri::command(rename = "workbench_list_directory")]
pub(crate) fn list_directory(
    app: tauri::AppHandle,
    path: String,
) -> Result<types::ListDirectoryResult, FileCommandError> {
    directory::list_directory(&app, path)
}

/// 读取文件内容（PE-07 T07.2：无 workspace_root 参数，根由 WorkspaceRegistry 解析）。
///
/// wire 名 = `workbench_read_file_content`（T-F 06：分裂标签统一，显式 rename）。
#[tauri::command(rename = "workbench_read_file_content")]
pub(crate) fn read_file_content(
    app: tauri::AppHandle,
    path: String,
    max_lines: Option<usize>,
) -> Result<types::ReadFileContentResult, FileCommandError> {
    read::read_file_content(&app, path, max_lines)
}

/// 写入文件内容（PE-07 T07.2：无 workspace_root 参数，根由 WorkspaceRegistry 解析）。
///
/// T-EG-05（F7）：overwrite 语义与工具侧 write_file 对齐——默认拒绝覆盖
/// （已存在且未显式 overwrite=true → file_exists 错误）；Option<bool> 让
/// 未传参调用方保持「默认拒绝覆盖」语义（与前端 workspaceFsApi 同步）。
/// wire 名 = `workbench_write_file_content`（T-F 06：分裂标签统一，显式 rename）。
#[tauri::command(rename = "workbench_write_file_content")]
pub(crate) fn write_file_content(
    app: tauri::AppHandle,
    path: String,
    content: String,
    overwrite: Option<bool>,
) -> Result<types::WriteFileContentResult, FileCommandError> {
    write::write_file_content(&app, path, content, overwrite.unwrap_or(false))
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
/// 错误协议统一 `CoreError {kind, detail}`（F4 F1-02 / PS-04 T4.5）。
///
/// `R: tauri::Runtime` 泛型：测试注入 MockRuntime 可直接调用（先例
/// core_commands.rs:170-177），生产走 Wry。
#[tauri::command]
pub(crate) fn workbench_discover_skills<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    workspace_path: Option<String>,
    extra_dirs: Vec<String>,
) -> Result<Vec<skills::RustSkill>, CoreError> {
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
    use crate::fs_commands::{delete, dialog, directory, read, write, WorkspaceFsGuard};

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

    fn write_file_content_at_root(
        root: &Path,
        path: &str,
        content: &str,
        overwrite: bool,
    ) -> Result<types::WriteFileContentResult, FileCommandError> {
        write::write_file_content_with_guard(&guard_for(root), path, content, overwrite)
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

    // ── T-EG-05：overwrite 语义（默认拒绝覆盖，与工具侧 write_file 对齐）──

    /// 已存在 + 未显式 overwrite → file_exists 拒绝，内容不被改动
    #[test]
    fn write_file_content_rejects_existing_by_default() {
        let temp = TestDir::new();
        let root = temp.path().join("workspace");
        fs::create_dir(&root).expect("create root");
        let file = root.join("a.txt");
        fs::write(&file, "original").expect("write file");

        assert_error_code(
            write_file_content_at_root(&root, "a.txt", "overwritten", false),
            types::ERR_FILE_EXISTS,
        );
        assert_eq!(fs::read_to_string(&file).expect("read"), "original", "拒绝后不得改动原文件");
    }

    /// 已存在 + overwrite=true → 放行覆盖写入
    #[test]
    fn write_file_content_existing_with_overwrite_true_succeeds() {
        let temp = TestDir::new();
        let root = temp.path().join("workspace");
        fs::create_dir(&root).expect("create root");
        let file = root.join("a.txt");
        fs::write(&file, "original").expect("write file");

        let result = write_file_content_at_root(&root, "a.txt", "new", true).expect("overwrite");
        assert_eq!(fs::read_to_string(&file).expect("read"), "new");
        assert!(result.path.ends_with("a.txt"));
    }

    /// 目标不存在 → overwrite 参数无影响，默认即放行（新建语义不变）
    #[test]
    fn write_file_content_new_file_default_succeeds() {
        let temp = TestDir::new();
        let root = temp.path().join("workspace");
        fs::create_dir(&root).expect("create root");

        let result =
            write_file_content_at_root(&root, "fresh.txt", "hello", false).expect("create file");
        assert_eq!(fs::read_to_string(root.join("fresh.txt")).expect("read"), "hello");
        assert_eq!(result.bytes_written, 5);
    }

    #[cfg(unix)]
    fn create_file_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn create_file_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_file(target, link)
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

    // ── P1-S2 红测试：symlink 写路径逃逸（F5-01，R1 确认）──

    /// 红测试：dangling symlink 父目录（链接目标不存在）写入必须被拒绝。
    /// 修复前 resolve_for_write 祖先循环用 Path::exists（跟随链接，dangling
    /// 为 false）一路上溯到根 → 返回词法路径 → create_dir_all + fs::write
    /// 跟随 symlink 在根外落盘 → 返回 Ok → 红。
    #[test]
    fn write_file_content_rejects_dangling_symlink_parent() {
        let temp = TestDir::new();
        let root = temp.path().join("workspace");
        let outside = temp.path().join("outside");
        fs::create_dir(&root).expect("create root");
        let link = root.join("link");
        if create_dir_symlink(&outside, &link).is_err() {
            return; // 无符号链接权限环境跳过（Windows 开发者模式）
        }

        assert_error_code(
            write_file_content_at_root(&root, "link/new.txt", "pwned", false),
            types::ERR_OUTSIDE_WORKSPACE,
        );
        assert!(!outside.join("new.txt").exists(), "拒绝后不得在根外落盘");
    }

    /// 契约锁定：非 dangling symlink（链接目标为根外已存在目录）写入同样
    /// 拒绝——resolve_for_write 祖先循环 canonicalize 已解析到根外（F5-01
    /// 反向形态，修复前即拦截），防止修复退化。
    #[test]
    fn write_file_content_rejects_existing_symlink_dir_escaping_root() {
        let temp = TestDir::new();
        let root = temp.path().join("workspace");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&root).expect("create root");
        fs::create_dir(&outside).expect("create outside");
        let link = root.join("link");
        if create_dir_symlink(&outside, &link).is_err() {
            return; // 无符号链接权限环境跳过（Windows 开发者模式）
        }

        assert_error_code(
            write_file_content_at_root(&root, "link/new.txt", "pwned", false),
            types::ERR_OUTSIDE_WORKSPACE,
        );
        assert!(!outside.join("new.txt").exists(), "拒绝后不得在根外落盘");
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

    // ── PS-04 T4.5（F4 F1-02）：错误协议统一 CoreError ──

    /// T4.5-R2（红 → 绿）：`select_folder` 错误路径统一 CoreError——
    /// 注册表未托管 → `Internal`；选中路径在已授权根外 → `InvalidInput`。
    /// 注：对话框 UI 在单元测试环境不可驱动（会阻塞等待用户），错误映射面
    /// 经 `register_picked_folder`（select_folder 的后半段，生产同一代码）断言。
    #[test]
    fn select_folder_error_paths_use_core_error_protocol() {
        use crate::workspace::{RegisterSource, WorkspaceRegistry};
        let temp = TestDir::new();
        let auth_root = temp.path().join("auth");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&auth_root).expect("create auth root");
        fs::create_dir(&outside).expect("create outside dir");

        // 注册表未托管 → Internal（命令级不 panic，kind 可分类）
        let bare = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("bare mock app");
        let err = dialog::register_picked_folder(bare.handle(), outside.clone())
            .expect_err("未托管注册表必须拒绝");
        let json = serde_json::to_value(&err).expect("错误必须可序列化");
        assert_eq!(
            json.get("kind").and_then(|v| v.as_str()),
            Some("Internal"),
            "未托管注册表应为 CoreError::Internal（当前形态 {json}）"
        );

        // 路径非法（不是目录）→ InvalidInput（路径/注册表类；Dialog 手势
        // 选中的目录本身无条件授权，非法目标才是拒绝面）
        let config_dir = temp.path().join("config");
        fs::create_dir_all(&config_dir).expect("create config dir");
        let reg = WorkspaceRegistry::init_with_config_dir(&config_dir).expect("init registry");
        reg.register(&auth_root, RegisterSource::Dialog)
            .expect("dialog register auth_root");
        let app = tauri::test::mock_builder()
            .manage(reg)
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let not_a_dir = temp.path().join("file.txt");
        fs::write(&not_a_dir, "x").expect("write file");
        let err = dialog::register_picked_folder(app.handle(), not_a_dir.clone())
            .expect_err("非目录路径必须拒绝");
        let json = serde_json::to_value(&err).expect("错误必须可序列化");
        assert_eq!(
            json.get("kind").and_then(|v| v.as_str()),
            Some("InvalidInput"),
            "非法路径应为 CoreError::InvalidInput（当前形态 {json}）"
        );

        // 合法目录（授权根内）→ 注册成功（路径返回 canonical）
        let ok = dialog::register_picked_folder(app.handle(), auth_root.clone())
            .expect("授权根内应注册成功");
        assert_eq!(ok.path.as_deref(), Some(auth_root.to_string_lossy().as_ref()));
    }

    /// T4.5-R3（红 → 绿）：`workbench_discover_skills` 的 workspace_path 越界
    /// → `CoreError::InvalidInput`（serde `{kind, detail}` 形状，detail 保留
    /// workspace_not_granted 文案）；注册表未托管 → `CoreError::Internal`。
    /// 修复前返回 String 错误 → kind 缺失 → 红。
    #[test]
    fn discover_skills_outside_root_returns_core_error() {
        use crate::workspace::{RegisterSource, WorkspaceRegistry};
        let temp = TestDir::new();
        let auth_root = temp.path().join("auth");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&auth_root).expect("create auth root");
        fs::create_dir(&outside).expect("create outside dir");
        let config_dir = temp.path().join("config");
        fs::create_dir_all(&config_dir).expect("create config dir");
        let reg = WorkspaceRegistry::init_with_config_dir(&config_dir).expect("init registry");
        reg.register(&auth_root, RegisterSource::Dialog)
            .expect("dialog register auth_root");
        let app = tauri::test::mock_builder()
            .manage(reg)
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");

        let result = super::workbench_discover_skills(
            app.handle().clone(),
            Some(outside.to_string_lossy().into_owned()),
            Vec::new(),
        );
        let err = result.expect_err("越界 workspace_path 必须拒绝");
        let json = serde_json::to_value(&err).expect("错误必须可序列化");
        assert_eq!(
            json.get("kind").and_then(|v| v.as_str()),
            Some("InvalidInput"),
            "错误必须按 CoreError {{kind,detail}} 协议序列化（当前形态 {json}）"
        );
        let detail = json
            .get("detail")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        assert!(
            detail.contains("workspace_not_granted"),
            "detail 应保留 workspace_not_granted 文案：{detail}"
        );

        // 注册表未托管 → Internal（命令级不 panic，kind 可分类）
        let bare = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("bare mock app");
        let result = super::workbench_discover_skills(bare.handle().clone(), None, Vec::new());
        let err = result.expect_err("未托管注册表必须拒绝");
        let json = serde_json::to_value(&err).expect("错误必须可序列化");
        assert_eq!(
            json.get("kind").and_then(|v| v.as_str()),
            Some("Internal"),
            "未托管注册表应为 CoreError::Internal（当前形态 {json}）"
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
