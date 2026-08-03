// 豁免 clippy::result_large_err：本模块全部 Result 函数返回 HostOpenerError——
// host_openers 域错误契约类型（code + message + 诊断载荷，IPC 序列化面），
// 保持非 box 形态避免公共 API 分裂（对齐 conex-telemetry crash.rs 先例）；
// 错误路径非热路径。
#![allow(clippy::result_large_err)]

use std::{
    collections::HashSet,
    env,
    ffi::OsString,
    path::{Path, PathBuf},
};

use crate::host_openers::resolve::{resolve_candidate_command, unavailable_diagnostic, unavailable_reason};
use crate::host_openers::types::{
    host_opener_diagnostic, host_opener_error, HostOpener, HostOpenerAvailability,
    HostOpenerError, HostOpenerKind, OpenerCandidate,
};

pub(crate) fn discover_host_openers() -> Result<Vec<HostOpener>, HostOpenerError> {
    discover_host_openers_with(
        env::var_os("PATH"),
        |key| env::var_os(key),
        |path| path.exists(),
    )
}

pub(crate) fn discover_host_openers_with(
    path_env: Option<OsString>,
    env_var: impl Fn(&str) -> Option<OsString>,
    path_exists: impl Fn(&Path) -> bool,
) -> Result<Vec<HostOpener>, HostOpenerError> {
    let path_dirs = path_dirs(path_env);
    let mut seen = HashSet::new();
    let candidates = opener_candidates(&env_var);
    if candidates.is_empty() {
        return Err(host_opener_error(
            "host-opener-discovery-unavailable",
            "No host opener discovery candidates are available for this OS.",
            None,
            None,
        ));
    }

    let openers = candidates
        .into_iter()
        .filter_map(|candidate| {
            if !seen.insert(candidate.id) {
                return None;
            }
            let resolved = resolve_candidate_command(&candidate, &path_dirs, &path_exists);
            let available = resolved.is_some();
            let diagnostic = resolved
                .map(|resolved| resolved.diagnostic)
                .unwrap_or_else(|| unavailable_diagnostic(&candidate));
            Some(HostOpener {
                id: candidate.id.to_string(),
                display_name: candidate.display_name.to_string(),
                label: candidate.display_name.to_string(),
                kind: candidate.kind.clone(),
                availability: if available {
                    HostOpenerAvailability::Available
                } else {
                    HostOpenerAvailability::Unavailable
                },
                available,
                reason: if available {
                    None
                } else {
                    Some(unavailable_reason(&candidate))
                },
                diagnostic,
            })
        })
        .collect::<Vec<_>>();

    if openers.is_empty() {
        return Err(host_opener_error(
            "host-opener-discovery-empty",
            "Host opener discovery returned no candidates.",
            None,
            None,
        ));
    }

    Ok(openers)
}

pub(crate) fn list_file_openers_for_path(path: String) -> Result<Vec<HostOpener>, HostOpenerError> {
    let _ = path;
    let mut openers = Vec::new();
    if let Ok(hosts) = discover_host_openers() {
        openers.extend(hosts.into_iter().filter(|o| o.available));
    }
    openers.extend(scan_start_menu_shortcuts(64));
    let mut seen = HashSet::new();
    openers.retain(|o| seen.insert(o.id.clone()));
    Ok(openers)
}

fn scan_start_menu_shortcuts(limit: usize) -> Vec<HostOpener> {
    let mut out = Vec::new();
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(appdata) = env::var_os("APPDATA") {
        roots.push(PathBuf::from(appdata).join("Microsoft\\Windows\\Start Menu\\Programs"));
    }
    if let Some(progdata) = env::var_os("ProgramData") {
        roots.push(PathBuf::from(progdata).join("Microsoft\\Windows\\Start Menu\\Programs"));
    }
    for root in roots {
        if !root.is_dir() {
            continue;
        }
        collect_lnk_openers(&root, &mut out, limit);
        if out.len() >= limit {
            break;
        }
    }
    out
}

fn collect_lnk_openers(dir: &Path, out: &mut Vec<HostOpener>, limit: usize) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in rd.flatten() {
        if out.len() >= limit {
            return;
        }
        let path = entry.path();
        if path.is_dir() {
            collect_lnk_openers(&path, out, limit);
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext != "lnk" {
            continue;
        }
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("App")
            .to_string();
        let lower = name.to_ascii_lowercase();
        if lower.contains("uninstall")
            || lower.contains("卸载")
            || lower.contains("help")
            || lower.contains("readme")
        {
            continue;
        }
        let id = format!("lnk:{}", path.display());
        out.push(HostOpener {
            id,
            display_name: name.clone(),
            label: name,
            kind: HostOpenerKind::Editor,
            availability: HostOpenerAvailability::Available,
            available: true,
            reason: None,
            diagnostic: host_opener_diagnostic(
                "host-opener-available",
                "Discovered from Start Menu shortcut.",
                Some(path.display().to_string()),
                Some(path.display().to_string()),
            ),
        });
    }
}

fn path_dirs(path_env: Option<OsString>) -> Vec<PathBuf> {
    path_env
        .map(|value| env::split_paths(&value).collect())
        .unwrap_or_default()
}

pub(crate) fn opener_candidates(env_var: &impl Fn(&str) -> Option<OsString>) -> Vec<OpenerCandidate> {
    let mut candidates = Vec::new();
    candidates.push(system_file_manager_candidate(env_var));
    candidates.extend(editor_candidates(env_var));
    candidates
}

fn system_file_manager_candidate(env_var: &impl Fn(&str) -> Option<OsString>) -> OpenerCandidate {
    #[cfg(windows)]
    {
        OpenerCandidate {
            id: "system-file-manager",
            display_name: "File Explorer",
            kind: HostOpenerKind::FileManager,
            commands: &["explorer.exe", "explorer"],
            known_paths: first_env_path(env_var, &["WINDIR", "SystemRoot"])
                .map(|root| vec![root.join("explorer.exe")])
                .unwrap_or_default(),
        }
    }

    #[cfg(target_os = "macos")]
    {
        OpenerCandidate {
            id: "system-file-manager",
            display_name: "Finder",
            kind: HostOpenerKind::FileManager,
            commands: &["open"],
            known_paths: Vec::new(),
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        OpenerCandidate {
            id: "system-file-manager",
            display_name: "File Manager",
            kind: HostOpenerKind::FileManager,
            commands: &["xdg-open"],
            known_paths: Vec::new(),
        }
    }
}

fn editor_candidates(env_var: &impl Fn(&str) -> Option<OsString>) -> Vec<OpenerCandidate> {
    vec![
        OpenerCandidate {
            id: "vscode",
            display_name: "Visual Studio Code",
            kind: HostOpenerKind::Editor,
            commands: &["code.cmd", "code.exe", "code"],
            known_paths: known_windows_app_paths(
                env_var,
                &[
                    (
                        "LOCALAPPDATA",
                        &["Programs", "Microsoft VS Code", "Code.exe"][..],
                    ),
                    ("ProgramFiles", &["Microsoft VS Code", "Code.exe"][..]),
                    ("ProgramFiles(x86)", &["Microsoft VS Code", "Code.exe"][..]),
                ],
            ),
        },
        OpenerCandidate {
            id: "cursor",
            display_name: "Cursor",
            kind: HostOpenerKind::Editor,
            commands: &["cursor.cmd", "cursor.exe", "cursor"],
            known_paths: known_windows_app_paths(
                env_var,
                &[
                    ("LOCALAPPDATA", &["Programs", "Cursor", "Cursor.exe"][..]),
                    ("ProgramFiles", &["Cursor", "Cursor.exe"][..]),
                ],
            ),
        },
        OpenerCandidate {
            id: "zed",
            display_name: "Zed",
            kind: HostOpenerKind::Editor,
            commands: &["zed.cmd", "zed.exe", "zed"],
            known_paths: known_windows_app_paths(
                env_var,
                &[
                    ("LOCALAPPDATA", &["Programs", "Zed", "Zed.exe"][..]),
                    ("ProgramFiles", &["Zed", "Zed.exe"][..]),
                ],
            ),
        },
        OpenerCandidate {
            id: "windsurf",
            display_name: "Windsurf",
            kind: HostOpenerKind::Editor,
            commands: &["windsurf.cmd", "windsurf.exe", "windsurf"],
            known_paths: known_windows_app_paths(
                env_var,
                &[
                    (
                        "LOCALAPPDATA",
                        &["Programs", "Windsurf", "Windsurf.exe"][..],
                    ),
                    ("ProgramFiles", &["Windsurf", "Windsurf.exe"][..]),
                ],
            ),
        },
        OpenerCandidate {
            id: "trae",
            display_name: "Trae",
            kind: HostOpenerKind::Editor,
            commands: &["trae.cmd", "trae.exe", "trae"],
            known_paths: known_windows_app_paths(
                env_var,
                &[
                    ("LOCALAPPDATA", &["Programs", "Trae", "Trae.exe"][..]),
                    ("ProgramFiles", &["Trae", "Trae.exe"][..]),
                ],
            ),
        },
    ]
}

fn known_windows_app_paths(
    env_var: &impl Fn(&str) -> Option<OsString>,
    specs: &[(&str, &[&str])],
) -> Vec<PathBuf> {
    specs
        .iter()
        .filter_map(|(root_key, segments)| {
            env_var(root_key)
                .map(PathBuf::from)
                .map(|root| join_segments(root, segments))
        })
        .collect()
}

fn first_env_path(env_var: &impl Fn(&str) -> Option<OsString>, keys: &[&str]) -> Option<PathBuf> {
    keys.iter().find_map(|key| {
        env_var(key)
            .map(PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty())
    })
}

fn join_segments(mut root: PathBuf, segments: &[&str]) -> PathBuf {
    for segment in segments {
        root.push(segment);
    }
    root
}
