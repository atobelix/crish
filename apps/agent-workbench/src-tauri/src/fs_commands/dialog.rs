use tauri_plugin_dialog::DialogExt;

use crate::fs_commands::types::SelectFolderResult;

/// 原生目录选择器：唯一「新授权」入口（PE-07 T07.2）。
///
/// 用户手势选中后 → `WorkspaceRegistry::register(Dialog)` → 返回 canonical 路径。
/// 只有对话框选中的路径才能成为新授权根；recent / 默认根仅能经
/// `workbench_open_workspace` 复授权。
pub(crate) async fn select_folder(app: tauri::AppHandle) -> Result<SelectFolderResult, String> {
    let selected = app.dialog().file().blocking_pick_folder();

    let Some(picked) = selected else {
        // 用户取消：返回空路径，不注册任何根
        return Ok(SelectFolderResult { path: None });
    };

    let picked_path = picked.into_path().map_err(|e| {
        format!("Failed to resolve selected folder path: {e}")
    })?;

    let reg = crate::workspace::registry(&app).map_err(|e| format!("{}: {}", e.code, e.message))?;
    let canonical = reg.register(&picked_path, crate::workspace::RegisterSource::Dialog)?;

    Ok(SelectFolderResult {
        path: Some(canonical.to_string_lossy().to_string()),
    })
}
