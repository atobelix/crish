//! 远程工作区切换：只允许已授权根，不产生新授权、不弹 Dialog。

use super::*;

/// 远程切换活动工作区（只允许已授权根；不产生新授权、不弹 Dialog）。
/// 供移动端 C20 使用：路径必须已在注册表 roots 中，随后复授权并激活。
pub(crate) fn remote_switch_workspace(
    app: &tauri::AppHandle,
    path: &str,
) -> Result<PathBuf, FileCommandError> {
    let reg = registry(app)?;
    let requested = canonicalize_root(Path::new(path)).map_err(|error| {
        FileCommandError::new(
            ERR_WORKSPACE_NOT_GRANTED,
            format!("cannot resolve workspace root `{path}`: {}", error.message),
        )
    })?;
    if !reg.roots().iter().any(|root| paths_equal(root, &requested)) {
        return Err(FileCommandError::new(
            ERR_WORKSPACE_NOT_GRANTED,
            "workspace is not authorized",
        ));
    }
    reg.register_recent_paths_with(
        std::slice::from_ref(&requested),
        &requested,
        true,
        |roots| sync_asset_scope(app, roots),
    )
    .map(|registered| registered.primary)
}
