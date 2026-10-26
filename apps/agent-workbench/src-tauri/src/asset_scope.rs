use std::path::{Path, PathBuf};

use crate::fs_commands::types::{path_is_same_or_child, strip_verbatim_prefix};
use tauri::{Manager, Runtime};

fn paths_equal(left: &Path, right: &Path) -> bool {
    let left = strip_verbatim_prefix(left);
    let right = strip_verbatim_prefix(right);
    path_is_same_or_child(&left, &right) && path_is_same_or_child(&right, &left)
}

/// 仅允许 asset 协议读取工作区注册表已授权的目录。
pub(crate) fn allow_registered_workspace_roots<R: Runtime, M: Manager<R>>(
    manager: &M,
    roots: impl IntoIterator<Item = PathBuf>,
) -> Result<(), String> {
    let registered_roots: Vec<PathBuf> = roots.into_iter().collect();
    for root in &registered_roots {
        let canonical = root
            .canonicalize()
            .map_err(|error| format!("workspace asset root cannot be resolved: {error}"))?;
        if !canonical.is_dir() {
            return Err("workspace asset root is not a directory".to_string());
        }
        if !paths_equal(root, &canonical) {
            return Err(format!(
                "workspace asset root changed after registration: `{}`",
                root.display()
            ));
        }
    }

    let scope = manager.asset_protocol_scope();
    for root in registered_roots {
        scope
            .allow_directory(root, true)
            .map_err(|error| format!("workspace asset root could not be scoped: {error}"))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path};

    use tauri::Manager;

    use super::{allow_registered_workspace_roots, paths_equal};
    use crate::fs_commands::types::strip_verbatim_prefix;

    #[test]
    fn asset_scope_allows_authorized_root_and_rejects_sibling_and_symlink_escape() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let root = temp.path().join("workspace");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&root).expect("workspace directory");
        fs::create_dir_all(&outside).expect("outside directory");

        let inside_file = root.join("inside.txt");
        let outside_file = outside.join("secret.txt");
        fs::write(&inside_file, "inside").expect("inside file");
        fs::write(&outside_file, "outside").expect("outside file");

        let link = root.join("outside-link");
        create_directory_link(&outside, &link);

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock Tauri app");
        allow_registered_workspace_roots(app.handle(), [root.clone()])
            .expect("authorized root is scoped");

        let scope = app.asset_protocol_scope();
        assert!(scope.is_allowed(&inside_file));
        assert!(!scope.is_allowed(&outside_file));
        assert!(!scope.is_allowed(link.join("secret.txt")));
    }

    #[test]
    fn asset_scope_rejects_unresolvable_roots_without_granting_them() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let missing = temp.path().join("missing");
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock Tauri app");

        assert!(allow_registered_workspace_roots(app.handle(), [missing.clone()]).is_err());
        assert!(!app.asset_protocol_scope().is_allowed(missing));
    }

    #[test]
    fn canonical_root_comparison_normalizes_platform_paths_and_rejects_siblings() {
        #[cfg(windows)]
        {
            assert!(paths_equal(
                Path::new(r"\\?\C:\Workspace\Project"),
                Path::new(r"c:/workspace/project")
            ));
            assert!(!paths_equal(
                Path::new(r"\\?\C:\Workspace\Project"),
                Path::new(r"C:\Workspace\Project-sibling")
            ));
        }

        #[cfg(not(windows))]
        {
            assert!(paths_equal(
                Path::new("/workspace/project"),
                Path::new("/workspace/project")
            ));
            assert!(!paths_equal(
                Path::new("/workspace/project"),
                Path::new("/workspace/project-sibling")
            ));
        }
    }

    // 仅替换测试临时目录以模拟重解析点竞态，不属于产品删除路径。
    #[allow(clippy::disallowed_methods)]
    #[test]
    fn replaced_root_rejects_the_entire_batch_without_granting_any_root() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let replaced_root = temp.path().join("replaced-workspace");
        let valid_root = temp.path().join("valid-workspace");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&replaced_root).expect("registered workspace directory");
        fs::create_dir_all(&valid_root).expect("other registered workspace directory");
        fs::create_dir_all(&outside).expect("outside directory");
        let outside_file = outside.join("secret.txt");
        let valid_file = valid_root.join("inside.txt");
        fs::write(&outside_file, "outside").expect("outside file");
        fs::write(&valid_file, "valid").expect("valid workspace file");

        let registered_replaced_root = strip_verbatim_prefix(
            &replaced_root
                .canonicalize()
                .expect("canonicalize original workspace"),
        );
        let registered_valid_root =
            strip_verbatim_prefix(&valid_root.canonicalize().expect("canonicalize valid root"));
        fs::remove_dir(&replaced_root).expect("remove original workspace directory");
        create_directory_link(&outside, &replaced_root);

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock Tauri app");
        let scope = app.asset_protocol_scope();
        let patterns_before = scope.allowed_patterns();

        let result = allow_registered_workspace_roots(
            app.handle(),
            [registered_valid_root, registered_replaced_root],
        );

        assert!(result.is_err(), "changed root must reject the whole batch");
        assert_eq!(scope.allowed_patterns(), patterns_before);
        assert!(!scope.is_allowed(&outside_file));
        assert!(!scope.is_allowed(&valid_file));
    }

    #[cfg(unix)]
    fn create_directory_link(target: &Path, link: &Path) {
        std::os::unix::fs::symlink(target, link).expect("create symlink");
    }

    #[cfg(windows)]
    fn create_directory_link(target: &Path, link: &Path) {
        junction::create(target, link).expect("create directory junction");
    }
}
