use std::path::PathBuf;

use tauri::{Manager, Runtime};

/// 仅允许 asset 协议读取工作区注册表已授权的目录。
pub(crate) fn allow_registered_workspace_roots<R: Runtime, M: Manager<R>>(
    manager: &M,
    roots: impl IntoIterator<Item = PathBuf>,
) -> Result<(), String> {
    let canonical_roots = roots
        .into_iter()
        .map(|root| {
            let canonical = root
                .canonicalize()
                .map_err(|error| format!("workspace asset root cannot be resolved: {error}"))?;
            if !canonical.is_dir() {
                return Err("workspace asset root is not a directory".to_string());
            }
            Ok(canonical)
        })
        .collect::<Result<Vec<_>, String>>()?;

    let scope = manager.asset_protocol_scope();
    for root in canonical_roots {
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

    use super::allow_registered_workspace_roots;

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

    #[cfg(unix)]
    fn create_directory_link(target: &Path, link: &Path) {
        std::os::unix::fs::symlink(target, link).expect("create symlink");
    }

    #[cfg(windows)]
    fn create_directory_link(target: &Path, link: &Path) {
        junction::create(target, link).expect("create directory junction");
    }
}
