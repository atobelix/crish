//! 主机「打开方式」命令入口：扫描本机已安装应用 / 快捷方式，并执行打开。
//!
//! 错误统一 `CoreError`（IPC 面唯一协议）：内部 `HostOpenerError` 经
//! `to_core_error` 映射后上抛；红线拦截（PermissionDenied）→ `InvalidInput`。

pub(crate) mod discovery;
pub(crate) mod execute;
pub(crate) mod resolve;
pub(crate) mod types;

use conex_types::CoreError;

use crate::host_openers::discovery::discover_host_openers;
use crate::host_openers::execute::{open_host_target, open_path_with_default_app};
use crate::host_openers::types::{to_core_error, HostOpenResult, HostOpenTarget, HostOpener};

#[tauri::command]
pub(crate) fn workbench_list_host_openers() -> Result<Vec<HostOpener>, CoreError> {
    discover_host_openers().map_err(to_core_error)
}

#[tauri::command]
pub(crate) fn workbench_open_host_target(
    opener_id: String,
    target: HostOpenTarget,
) -> Result<HostOpenResult, CoreError> {
    open_host_target(opener_id, target)
}

#[tauri::command]
pub(crate) fn workbench_open_path_default(path: String) -> Result<HostOpenResult, CoreError> {
    open_path_with_default_app(path)
}

#[tauri::command]
pub(crate) fn workbench_list_file_openers(path: String) -> Result<Vec<HostOpener>, CoreError> {
    crate::host_openers::discovery::list_file_openers_for_path(path).map_err(to_core_error)
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};
    use std::env;
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};

    use crate::host_openers::types::HostOpenerKind;

    #[test]
    fn host_openers_include_file_manager_and_editor_candidates() {
        let discovered = super::discovery::discover_host_openers_with(
            Some(path_env(&[
                r"C:\Windows",
                r"C:\Users\me\AppData\Local\Programs\Microsoft VS Code\bin",
            ])),
            env_lookup(&[
                ("WINDIR", r"C:\Windows"),
                ("LOCALAPPDATA", r"C:\Users\me\AppData\Local"),
                ("ProgramFiles", r"C:\Program Files"),
            ]),
            exists_lookup(&[
                r"C:\Windows\explorer.exe",
                r"C:\Users\me\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd",
            ]),
        )
        .expect("host opener discovery");

        let file_manager = discovered
            .iter()
            .find(|opener| opener.id == "system-file-manager")
            .expect("system file manager opener");
        assert_eq!(file_manager.kind, HostOpenerKind::FileManager);
        assert!(file_manager.available);

        let vscode = discovered
            .iter()
            .find(|opener| opener.id == "vscode")
            .expect("vscode candidate");
        assert_eq!(vscode.kind, HostOpenerKind::Editor);
        assert!(vscode.available);

        assert!(discovered.iter().any(|opener| opener.id == "zed"));
        assert!(discovered.iter().all(|opener| opener.id != "explorer"));
    }

    #[test]
    fn unavailable_editor_candidates_report_reason_without_blocking_discovery() {
        let discovered =
            super::discovery::discover_host_openers_with(None, env_lookup(&[]), exists_lookup(&[]))
                .expect("host opener discovery");
        let editor = discovered
            .iter()
            .find(|opener| opener.id == "cursor")
            .expect("cursor candidate");

        assert!(!editor.available);
        assert_eq!(
            editor.reason.as_deref(),
            Some("No matching command or known installation path was discovered on this host.")
        );
    }

    fn path_env(paths: &[&str]) -> OsString {
        env::join_paths(paths.iter().map(PathBuf::from)).expect("test PATH")
    }

    fn env_lookup(entries: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
        let map = entries
            .iter()
            .map(|(key, value)| ((*key).to_string(), OsString::from(value)))
            .collect::<HashMap<_, _>>();
        move |key| map.get(key).cloned()
    }

    fn exists_lookup(paths: &[&str]) -> impl Fn(&Path) -> bool {
        let set = paths
            .iter()
            .map(|path| normalize(path))
            .collect::<HashSet<_>>();
        move |path| set.contains(&normalize_path(path))
    }

    fn normalize(path: &str) -> String {
        path.replace('/', "\\").to_ascii_lowercase()
    }

    fn normalize_path(path: &Path) -> String {
        normalize(&path.to_string_lossy())
    }
}
