use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    env,
    ffi::OsString,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use crate::host_paths::{app_dir, workspace_root};

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum HostOpenerKind {
    FileManager,
    Editor,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum HostOpenerAvailability {
    Available,
    Unavailable,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostOpenerDiagnostic {
    code: String,
    message: String,
    os: String,
    command: Option<String>,
    path: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostOpener {
    id: String,
    display_name: String,
    label: String,
    kind: HostOpenerKind,
    availability: HostOpenerAvailability,
    available: bool,
    reason: Option<String>,
    diagnostic: HostOpenerDiagnostic,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostOpenerError {
    code: String,
    message: String,
    diagnostic: HostOpenerDiagnostic,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostOpenTarget {
    #[serde(rename = "type")]
    target_type: HostOpenTargetKind,
    path: Option<String>,
    url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum HostOpenTargetKind {
    Path,
    Url,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostOpenResult {
    ok: bool,
    opener_id: String,
    target_kind: HostOpenTargetKindForResult,
    target: String,
    command: String,
    diagnostic: HostOpenerDiagnostic,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum HostOpenTargetKindForResult {
    Path,
    Url,
}

#[derive(Clone, Debug)]
struct OpenerCandidate {
    id: &'static str,
    display_name: &'static str,
    kind: HostOpenerKind,
    commands: &'static [&'static str],
    known_paths: Vec<PathBuf>,
}

#[derive(Clone, Debug)]
struct ResolvedOpenerCommand {
    command: PathBuf,
    diagnostic: HostOpenerDiagnostic,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ResolvedOpenTarget {
    Path(PathBuf),
    Url(String),
}

#[tauri::command]
pub(crate) fn workbench_list_host_openers() -> Result<Vec<HostOpener>, HostOpenerError> {
    discover_host_openers()
}

#[tauri::command]
pub(crate) fn workbench_open_host_target(
    opener_id: String,
    target: HostOpenTarget,
) -> Result<HostOpenResult, HostOpenerError> {
    open_host_target(opener_id, target)
}

/// 系统默认关联打开文件（非资源管理器 reveal）
#[tauri::command]
pub(crate) fn workbench_open_path_default(path: String) -> Result<HostOpenResult, HostOpenerError> {
    open_path_with_default_app(path)
}

/// 扫描本机 Start Menu / 桌面快捷方式，按扩展名推荐打开方式（动态发现，非硬编码名单）
#[tauri::command]
pub(crate) fn workbench_list_file_openers(path: String) -> Result<Vec<HostOpener>, HostOpenerError> {
    list_file_openers_for_path(path)
}

fn open_path_with_default_app(path: String) -> Result<HostOpenResult, HostOpenerError> {
    let target = path.trim().to_string();
    if target.is_empty() {
        return Err(host_opener_error(
            "host-path-empty",
            "Path is empty.",
            None,
            None,
        ));
    }
    let p = PathBuf::from(&target);
    if !p.exists() {
        return Err(host_opener_error(
            "host-path-missing",
            format!("Path does not exist: {target}"),
            None,
            Some(target.clone()),
        ));
    }

    #[cfg(windows)]
    {
        // `cmd /C start "" "path"` 走系统默认关联
        let status = Command::new("cmd")
            .args(["/C", "start", "", &target])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        match status {
            Ok(_) => Ok(HostOpenResult {
                ok: true,
                opener_id: "system-default".to_string(),
                target_kind: HostOpenTargetKindForResult::Path,
                target: target.clone(),
                command: "cmd /C start".to_string(),
                diagnostic: host_opener_diagnostic(
                    "host-opener-launched",
                    "Opened path with system default association.",
                    Some("cmd /C start".to_string()),
                    Some(target),
                ),
            }),
            Err(error) => Err(host_opener_error(
                "host-opener-spawn-failed",
                format!("Failed to open with system default: {error}"),
                Some("cmd /C start".to_string()),
                Some(target),
            )),
        }
    }

    #[cfg(target_os = "macos")]
    {
        let status = Command::new("open")
            .arg(&target)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        match status {
            Ok(_) => Ok(HostOpenResult {
                ok: true,
                opener_id: "system-default".to_string(),
                target_kind: HostOpenTargetKindForResult::Path,
                target: target.clone(),
                command: "open".to_string(),
                diagnostic: host_opener_diagnostic(
                    "host-opener-launched",
                    "Opened path with system default association.",
                    Some("open".to_string()),
                    Some(target),
                ),
            }),
            Err(error) => Err(host_opener_error(
                "host-opener-spawn-failed",
                format!("Failed to open with system default: {error}"),
                Some("open".to_string()),
                Some(target),
            )),
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let status = Command::new("xdg-open")
            .arg(&target)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        match status {
            Ok(_) => Ok(HostOpenResult {
                ok: true,
                opener_id: "system-default".to_string(),
                target_kind: HostOpenTargetKindForResult::Path,
                target: target.clone(),
                command: "xdg-open".to_string(),
                diagnostic: host_opener_diagnostic(
                    "host-opener-launched",
                    "Opened path with system default association.",
                    Some("xdg-open".to_string()),
                    Some(target),
                ),
            }),
            Err(error) => Err(host_opener_error(
                "host-opener-spawn-failed",
                format!("Failed to open with system default: {error}"),
                Some("xdg-open".to_string()),
                Some(target),
            )),
        }
    }
}

fn list_file_openers_for_path(path: String) -> Result<Vec<HostOpener>, HostOpenerError> {
    let _ = path; // 扩展名可用于未来过滤；当前先返回扫描到的快捷方式
    let mut openers = Vec::new();
    // 先并入已发现的编辑器 / 资源管理器
    if let Ok(hosts) = discover_host_openers() {
        openers.extend(hosts.into_iter().filter(|o| o.available));
    }
    // 再扫 Start Menu 快捷方式（动态，非名单硬编码）
    openers.extend(scan_start_menu_shortcuts(64));
    // 去重
    let mut seen = HashSet::new();
    openers.retain(|o| seen.insert(o.id.clone()));
    Ok(openers)
}

/// 扫描当前用户 + 公共 Start Menu 的 .lnk，最多 limit 个
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
        // 跳过卸载 / 帮助等噪音
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

fn discover_host_openers() -> Result<Vec<HostOpener>, HostOpenerError> {
    discover_host_openers_with(
        env::var_os("PATH"),
        |key| env::var_os(key),
        |path| path.exists(),
    )
}

fn discover_host_openers_with(
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

fn open_host_target(
    opener_id: String,
    target: HostOpenTarget,
) -> Result<HostOpenResult, HostOpenerError> {
    // Start Menu 快捷方式：id = "lnk:<path>"
    if let Some(lnk_path) = opener_id.strip_prefix("lnk:") {
        let lnk_owned = lnk_path.to_string();
        return open_with_shortcut(&lnk_owned, target, opener_id);
    }
    let path_env = env::var_os("PATH");
    let env_lookup = |key: &str| env::var_os(key);
    let path_exists = |path: &Path| path.exists();
    let path_dirs = path_dirs(path_env);
    let candidates = opener_candidates(&env_lookup);
    let candidate = candidates
        .iter()
        .find(|candidate| candidate.id == opener_id)
        .ok_or_else(|| {
            host_opener_error(
                "host-opener-not-found",
                format!("Host opener id is not known on this OS: {opener_id}"),
                None,
                None,
            )
        })?;
    let resolved = resolve_candidate_command(candidate, &path_dirs, &path_exists).ok_or_else(|| {
        let diagnostic = unavailable_diagnostic(candidate);
        HostOpenerError {
            code: "host-opener-unavailable".to_string(),
            message: diagnostic.message.clone(),
            diagnostic,
        }
    })?;
    let app_dir = app_dir().map_err(|message| {
        host_opener_error("host-path-root-unavailable", message, None, None)
    })?;
    let workspace = workspace_root(&app_dir);
    let roots = [workspace.as_path()];
    let resolved_target = resolve_open_target_for_roots(&target, &roots)?;
    let args = opener_args(candidate, &resolved_target)?;

    let command_display = resolved.command.display().to_string();
    Command::new(&resolved.command)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            host_opener_error(
                "host-opener-spawn-failed",
                format!("Failed to launch host opener {opener_id}: {error}"),
                Some(command_display.clone()),
                None,
            )
        })?;

    Ok(HostOpenResult {
        ok: true,
        opener_id,
        target_kind: match resolved_target {
            ResolvedOpenTarget::Path(_) => HostOpenTargetKindForResult::Path,
            ResolvedOpenTarget::Url(_) => HostOpenTargetKindForResult::Url,
        },
        target: open_target_display(&resolved_target),
        command: command_display,
        diagnostic: host_opener_diagnostic(
            "host-opener-launched",
            "Host opener launch command was started.",
            Some(resolved.command.display().to_string()),
            Some(open_target_display(&resolved_target)),
        ),
    })
}

/// 通过 .lnk 启动并带上文件路径参数
fn open_with_shortcut(
    lnk_path: &str,
    target: HostOpenTarget,
    opener_id: String,
) -> Result<HostOpenResult, HostOpenerError> {
    let lnk = PathBuf::from(lnk_path);
    if !lnk.exists() {
        return Err(host_opener_error(
            "host-opener-not-found",
            format!("Shortcut not found: {lnk_path}"),
            Some(lnk_path.to_string()),
            None,
        ));
    }
    let app_dir = app_dir().map_err(|message| {
        host_opener_error("host-path-root-unavailable", message, None, None)
    })?;
    let workspace = workspace_root(&app_dir);
    let roots = [workspace.as_path()];
    let resolved_target = resolve_open_target_for_roots(&target, &roots)?;
    let file_arg = match &resolved_target {
        ResolvedOpenTarget::Path(p) => p.display().to_string(),
        ResolvedOpenTarget::Url(u) => u.clone(),
    };

    #[cfg(windows)]
    {
        // 用 PowerShell 解析快捷方式目标并启动（带文件参数）
        let script = format!(
            "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{}'); Start-Process -FilePath $s.TargetPath -ArgumentList @('{}') -WorkingDirectory (Split-Path $s.TargetPath -Parent) -ErrorAction Stop",
            lnk_path.replace('\'', "''"),
            file_arg.replace('\'', "''"),
        );
        let status = Command::new("powershell")
            .args(["-NoProfile", "-Command", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        match status {
            Ok(_) => Ok(HostOpenResult {
                ok: true,
                opener_id,
                target_kind: HostOpenTargetKindForResult::Path,
                target: file_arg.clone(),
                command: lnk_path.to_string(),
                diagnostic: host_opener_diagnostic(
                    "host-opener-launched",
                    "Opened via Start Menu shortcut.",
                    Some(lnk_path.to_string()),
                    Some(file_arg),
                ),
            }),
            Err(error) => Err(host_opener_error(
                "host-opener-spawn-failed",
                format!("Failed to launch shortcut: {error}"),
                Some(lnk_path.to_string()),
                Some(file_arg),
            )),
        }
    }

    #[cfg(not(windows))]
    {
        let _ = file_arg;
        Err(host_opener_error(
            "host-opener-unavailable",
            "Shortcut open is only implemented on Windows.",
            Some(lnk_path.to_string()),
            None,
        ))
    }
}

fn opener_candidates(env_var: &impl Fn(&str) -> Option<OsString>) -> Vec<OpenerCandidate> {
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

fn resolve_candidate_command(
    candidate: &OpenerCandidate,
    path_dirs: &[PathBuf],
    path_exists: &impl Fn(&Path) -> bool,
) -> Option<ResolvedOpenerCommand> {
    if let Some(path) = candidate.known_paths.iter().find(|path| path_exists(path)) {
        return Some(ResolvedOpenerCommand {
            command: path.clone(),
            diagnostic: host_opener_diagnostic(
                "host-opener-available",
                format!(
                    "{} was discovered from a known installation path.",
                    candidate.display_name
                ),
                Some(path.display().to_string()),
                Some(path.display().to_string()),
            ),
        });
    }

    candidate.commands.iter().find_map(|command| {
        command_on_path(command, path_dirs, path_exists).map(|path| ResolvedOpenerCommand {
            command: path.clone(),
            diagnostic: host_opener_diagnostic(
                "host-opener-available",
                format!("{} was discovered on PATH.", candidate.display_name),
                Some(command.to_string()),
                Some(path.display().to_string()),
            ),
        })
    })
}

fn command_on_path(
    command: &str,
    path_dirs: &[PathBuf],
    path_exists: &impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    path_dirs
        .iter()
        .map(|dir| dir.join(command))
        .find(|path| path_exists(path))
}

fn path_dirs(path_env: Option<OsString>) -> Vec<PathBuf> {
    path_env
        .map(|value| env::split_paths(&value).collect())
        .unwrap_or_default()
}

fn unavailable_reason(candidate: &OpenerCandidate) -> String {
    if candidate.kind == HostOpenerKind::FileManager {
        return "No system file manager command was discovered on this host.".to_string();
    }
    "No matching command or known installation path was discovered on this host.".to_string()
}

fn unavailable_diagnostic(candidate: &OpenerCandidate) -> HostOpenerDiagnostic {
    host_opener_diagnostic(
        "host-opener-unavailable",
        unavailable_reason(candidate),
        Some(candidate.commands.join(",")),
        None,
    )
}

fn resolve_open_target_for_roots(
    target: &HostOpenTarget,
    roots: &[&Path],
) -> Result<ResolvedOpenTarget, HostOpenerError> {
    match target.target_type {
        HostOpenTargetKind::Path => {
            let raw_path = target.path.as_deref().map(str::trim).unwrap_or_default();
            if raw_path.is_empty() {
                return Err(host_opener_error(
                    "host-open-target-empty",
                    "Host open target path is empty.",
                    None,
                    None,
                ));
            }
            let path = PathBuf::from(raw_path);
            if !path.is_absolute() {
                return Err(host_opener_error(
                    "host-open-target-relative",
                    "Host open target path must be absolute.",
                    None,
                    Some(raw_path.to_string()),
                ));
            }
            let canonical_target = path.canonicalize().map_err(|error| {
                host_opener_error(
                    "host-open-target-missing",
                    format!("Host open target path could not be resolved: {error}"),
                    None,
                    Some(raw_path.to_string()),
                )
            })?;
            let allowed = roots.iter().any(|root| {
                root.canonicalize()
                    .map(|canonical_root| canonical_target.starts_with(canonical_root))
                    .unwrap_or(false)
            });
            if !allowed {
                return Err(host_opener_error(
                    "host-open-target-outside-workspace",
                    "Host open target path must stay inside the Workbench workspace root.",
                    None,
                    Some(canonical_target.display().to_string()),
                ));
            }
            Ok(ResolvedOpenTarget::Path(canonical_target))
        }
        HostOpenTargetKind::Url => {
            let raw_url = target.url.as_deref().map(str::trim).unwrap_or_default();
            let parsed = url::Url::parse(raw_url).map_err(|error| {
                host_opener_error(
                    "host-open-target-url-invalid",
                    format!("Host open target URL is invalid: {error}"),
                    None,
                    Some(raw_url.to_string()),
                )
            })?;
            if parsed.scheme() != "https" && parsed.scheme() != "http" {
                return Err(host_opener_error(
                    "host-open-target-url-scheme",
                    "Host open target URL must use http or https.",
                    None,
                    Some(raw_url.to_string()),
                ));
            }
            Ok(ResolvedOpenTarget::Url(parsed.to_string()))
        }
    }
}

fn opener_args(
    candidate: &OpenerCandidate,
    target: &ResolvedOpenTarget,
) -> Result<Vec<String>, HostOpenerError> {
    match (&candidate.kind, target) {
        (HostOpenerKind::FileManager, ResolvedOpenTarget::Url(url)) => Err(host_opener_error(
            "host-open-target-incompatible",
            "File manager openers only accept filesystem path targets.",
            None,
            Some(url.clone()),
        )),
        (HostOpenerKind::FileManager, ResolvedOpenTarget::Path(path)) => {
            Ok(file_manager_args(path))
        }
        (HostOpenerKind::Editor, ResolvedOpenTarget::Path(path)) => {
            Ok(vec![path.display().to_string()])
        }
        (HostOpenerKind::Editor, ResolvedOpenTarget::Url(url)) => Ok(vec![url.clone()]),
    }
}

fn file_manager_args(path: &Path) -> Vec<String> {
    #[cfg(windows)]
    {
        if path.is_file() {
            return vec![format!("/select,{}", path.display())];
        }
        return vec![path.display().to_string()];
    }

    #[cfg(not(windows))]
    {
        vec![path.display().to_string()]
    }
}

fn open_target_display(target: &ResolvedOpenTarget) -> String {
    match target {
        ResolvedOpenTarget::Path(path) => path.display().to_string(),
        ResolvedOpenTarget::Url(url) => url.clone(),
    }
}

fn host_opener_error(
    code: impl Into<String>,
    message: impl Into<String>,
    command: Option<String>,
    path: Option<String>,
) -> HostOpenerError {
    let code = code.into();
    let message = message.into();
    HostOpenerError {
        code: code.clone(),
        message: message.clone(),
        diagnostic: host_opener_diagnostic(code, message, command, path),
    }
}

fn host_opener_diagnostic(
    code: impl Into<String>,
    message: impl Into<String>,
    command: Option<String>,
    path: Option<String>,
) -> HostOpenerDiagnostic {
    HostOpenerDiagnostic {
        code: code.into(),
        message: message.into(),
        os: env::consts::OS.to_string(),
        command,
        path,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    #[test]
    fn host_openers_include_file_manager_and_editor_candidates() {
        let discovered = discover_host_openers_with(
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
        let discovered = discover_host_openers_with(None, env_lookup(&[]), exists_lookup(&[]))
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
