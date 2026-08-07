use tauri_plugin_dialog::DialogExt;

use crate::fs_commands::types::SelectFolderResult;

/// 原生目录选择器：唯一「新授权」入口（PE-07 T07.2）。
///
/// 用户手势选中后 → `WorkspaceRegistry::register(Dialog)` → 返回 canonical 路径。
/// 只有对话框选中的路径才能成为新授权根；recent / 默认根仅能经
/// `workbench_open_workspace` 复授权。
///
/// `R: tauri::Runtime` 泛型：测试注入 MockRuntime 可直接调用（先例
/// core_commands.rs:170-177），生产走 Wry。
pub(crate) async fn select_folder<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<SelectFolderResult, String> {
    let selected = app.dialog().file().blocking_pick_folder();

    let Some(picked) = selected else {
        // 用户取消：返回空路径，不注册任何根（F4 F1-02：取消语义保持 Ok(None)）
        return Ok(SelectFolderResult { path: None });
    };

    let picked_path = picked.into_path().map_err(|e| {
        format!("Failed to resolve selected folder path: {e}")
    })?;

    register_picked_folder(&app, picked_path)
}

/// 选中路径登记为已授权根（对话框之后的后半段；独立函数供命令级错误协议
/// 测试直调——对话框 UI 在单元测试环境不可驱动，错误映射面需要可达）。
pub(crate) fn register_picked_folder<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    picked_path: std::path::PathBuf,
) -> Result<SelectFolderResult, String> {
    use tauri::Manager as _;
    let reg = app
        .try_state::<crate::workspace::WorkspaceRegistry>()
        .ok_or_else(|| {
            "internal_error: WorkspaceRegistry is not managed; main.rs setup must call app.manage(WorkspaceRegistry::init()...)".to_string()
        })?;
    let canonical = reg.register(&picked_path, crate::workspace::RegisterSource::Dialog)?;

    Ok(SelectFolderResult {
        path: Some(canonical.to_string_lossy().to_string()),
    })
}
