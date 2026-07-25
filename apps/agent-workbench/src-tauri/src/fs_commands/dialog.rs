use tauri_plugin_dialog::DialogExt;

use crate::fs_commands::types::SelectFolderResult;

pub(crate) async fn select_folder(app: tauri::AppHandle) -> Result<SelectFolderResult, String> {
    let selected = app.dialog().file().blocking_pick_folder();

    Ok(SelectFolderResult {
        path: selected.map(|p| p.to_string()),
    })
}
