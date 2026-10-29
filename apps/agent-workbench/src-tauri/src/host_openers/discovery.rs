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

use crate::host_openers::icon::extract_icon_data_url;
use crate::host_openers::resolve::{
    resolve_candidate_command, unavailable_diagnostic, unavailable_reason,
};
use crate::host_openers::types::{
    host_opener_diagnostic, host_opener_error, HostOpener, HostOpenerAvailability, HostOpenerError,
    HostOpenerKind, OpenerCandidate,
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
            let icon_data_url = resolved
                .as_ref()
                .and_then(|cmd| extract_icon_data_url(&cmd.command));
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
                icon_data_url,
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
    let category = categorize_file_path(&path);
    let mut openers = Vec::new();
    if let Ok(hosts) = discover_host_openers() {
        for opener in hosts.into_iter().filter(|o| o.available) {
            // 在代码/文本场景下保留可用编辑器与文件资源管理器
            if category == FileCategory::TextOrCode {
                if opener.kind == HostOpenerKind::Editor || opener.id == "system-file-manager" {
                    openers.push(opener);
                }
            } else if category == FileCategory::Image {
                if opener.id == "system-file-manager" {
                    openers.push(opener);
                }
            } else {
                openers.push(opener);
            }
        }
    }
    openers.extend(scan_start_menu_shortcuts(category, 16));
    let mut seen = HashSet::new();
    openers.retain(|o| seen.insert(o.id.clone()));
    Ok(openers)
}

fn start_menu_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(appdata) = env::var_os("APPDATA") {
        roots.push(PathBuf::from(appdata).join("Microsoft\\Windows\\Start Menu\\Programs"));
    }
    if let Some(progdata) = env::var_os("ProgramData") {
        roots.push(PathBuf::from(progdata).join("Microsoft\\Windows\\Start Menu\\Programs"));
    }
    roots
}

pub(crate) fn trusted_start_menu_shortcut_path(path: &Path) -> Option<PathBuf> {
    trusted_shortcut_path_with_roots(path, &start_menu_roots())
}

fn trusted_shortcut_path_with_roots(path: &Path, roots: &[PathBuf]) -> Option<PathBuf> {
    let canonical_path = path.canonicalize().ok()?;
    if !canonical_path.is_file()
        || canonical_path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_none_or(|extension| !extension.eq_ignore_ascii_case("lnk"))
    {
        return None;
    }
    roots
        .iter()
        .any(|root| {
            root.canonicalize()
                .is_ok_and(|canonical_root| canonical_path.starts_with(canonical_root))
        })
        .then_some(canonical_path)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FileCategory {
    TextOrCode,
    Image,
    PdfOrDoc,
    Other,
}

fn categorize_file_path(path: &str) -> FileCategory {
    let p = Path::new(path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "md" | "txt" | "markdown" | "mdown" | "json" | "yaml" | "yml" | "toml" | "ini" | "xml"
        | "html" | "css" | "js" | "jsx" | "ts" | "tsx" | "rs" | "py" | "go" | "c" | "cpp" | "h"
        | "hpp" | "cs" | "java" | "sh" | "bash" | "zsh" | "fish" | "sql" | "env" => {
            FileCategory::TextOrCode
        }
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "svg" | "tiff" | "tif" => {
            FileCategory::Image
        }
        "pdf" | "doc" | "docx" | "ppt" | "pptx" | "xls" | "xlsx" => FileCategory::PdfOrDoc,
        _ => FileCategory::Other,
    }
}

/// 过滤系统管理工具、无障碍辅助工具、终端控制台、说明与卸载
fn is_excluded_start_menu_app(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    // 1. 文档/卸载/网站/维护
    if lower.contains("uninstall")
        || lower.contains("卸载")
        || lower.contains("help")
        || lower.contains("readme")
        || lower.contains("manual")
        || lower.contains("documentation")
        || lower.contains("document")
        || lower.contains("faq")
        || lower.contains("homepage")
        || lower.contains("website")
        || lower.contains("backup")
        || lower.contains("备份")
        || lower.contains("自动保存")
        || lower.contains("autosave")
        || lower.contains("user files")
        || lower.contains("用户文件")
    {
        return true;
    }

    // 2. Windows 无障碍与辅助功能工具（绝不是用来编辑/打开文件的应用）
    if lower == "magnify"
        || lower == "narrator"
        || lower == "livecaptions"
        || lower == "on-screen keyboard"
        || lower == "voiceaccess"
        || lower.contains("accessibility")
        || lower.contains("无障碍")
        || lower.contains("讲述人")
        || lower.contains("放大镜")
        || lower.contains("屏幕键盘")
        || lower.contains("实时字幕")
        || lower == "osk"
    {
        return true;
    }

    // 3. 系统管理工具与控制台终端
    if lower.contains("administrative tools")
        || lower.contains("管理工具")
        || lower.contains("control panel")
        || lower.contains("控制面板")
        || lower.contains("task manager")
        || lower.contains("任务管理器")
        || lower.contains("command prompt")
        || lower.contains("命令提示符")
        || lower.contains("powershell")
        || lower.contains("prompt")
        || lower == "run"
        || lower == "运行"
        || lower == "console"
        || lower.contains("system tools")
        || lower.contains("windows tools")
    {
        return true;
    }

    false
}

/// 根据文件类型判定应用是否属于该类型的合理候选
fn is_relevant_app_for_category(name: &str, category: FileCategory) -> bool {
    let lower = name.to_ascii_lowercase();
    match category {
        FileCategory::TextOrCode => {
            // 排除明显的看图与视频播放器
            if lower.contains("看图")
                || lower.contains("图片")
                || lower.contains("photo")
                || lower.contains("image")
                || lower.contains("bandiview")
                || lower.contains("player")
                || lower.contains("播放")
            {
                return false;
            }
            // 优先接纳知名代码与文本编辑工具
            lower.contains("code")
                || lower.contains("cursor")
                || lower.contains("zed")
                || lower.contains("sublime")
                || lower.contains("typora")
                || lower.contains("markra")
                || lower.contains("windsurf")
                || lower.contains("trae")
                || lower.contains("notepad")
                || lower.contains("记事本")
                || lower.contains("ia writer")
                || lower.contains("affine")
                || lower.contains("obsidian")
                || lower.contains("vim")
                || lower.contains("neovim")
                || lower.contains("emacs")
                || lower.contains("idea")
                || lower.contains("pycharm")
                || lower.contains("webstorm")
                || lower.contains("clion")
                || lower.contains("rstudio")
                || lower.contains("spyder")
                || lower.contains("edit")
        }
        FileCategory::Image => {
            lower.contains("看图")
                || lower.contains("图片")
                || lower.contains("photo")
                || lower.contains("image")
                || lower.contains("bandiview")
                || lower.contains("paint")
                || lower.contains("画图")
                || lower.contains("photoshop")
                || lower.contains("illustrator")
                || lower.contains("viewer")
        }
        FileCategory::PdfOrDoc => {
            lower.contains("pdf")
                || lower.contains("reader")
                || lower.contains("acrobat")
                || lower.contains("wps")
                || lower.contains("word")
                || lower.contains("office")
        }
        FileCategory::Other => true,
    }
}

fn scan_start_menu_shortcuts(category: FileCategory, limit: usize) -> Vec<HostOpener> {
    let mut out = Vec::new();
    for root in start_menu_roots() {
        if !root.is_dir() {
            continue;
        }
        let Ok(canonical_root) = root.canonicalize() else {
            continue;
        };
        let mut visited = HashSet::new();
        collect_lnk_openers(
            &root,
            &canonical_root,
            &mut visited,
            &mut out,
            category,
            limit,
        );
        if out.len() >= limit {
            break;
        }
    }
    out
}

fn collect_lnk_openers(
    dir: &Path,
    canonical_root: &Path,
    visited: &mut HashSet<PathBuf>,
    out: &mut Vec<HostOpener>,
    category: FileCategory,
    limit: usize,
) {
    let Ok(canonical_dir) = dir.canonicalize() else {
        return;
    };
    if !canonical_dir.starts_with(canonical_root) || !visited.insert(canonical_dir.clone()) {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in rd.flatten() {
        if out.len() >= limit {
            return;
        }
        let path = entry.path();
        let Ok(canonical_path) = path.canonicalize() else {
            continue;
        };
        if !canonical_path.starts_with(canonical_root) {
            continue;
        }
        if canonical_path.is_dir() {
            collect_lnk_openers(
                &canonical_path,
                canonical_root,
                visited,
                out,
                category,
                limit,
            );
            continue;
        }
        let ext = canonical_path
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

        // 严格排除无障碍、管理工具、终端命令等无关项
        if is_excluded_start_menu_app(&name) {
            continue;
        }

        // 根据文件类别匹配关联应用（代码文件只显示编辑器，不显示看图王等）
        if !is_relevant_app_for_category(&name, category) {
            continue;
        }

        let id = format!("lnk:{}", canonical_path.display());
        let icon_data_url = extract_icon_data_url(&canonical_path);
        out.push(HostOpener {
            id,
            display_name: name.clone(),
            label: name,
            kind: HostOpenerKind::Editor,
            availability: HostOpenerAvailability::Available,
            available: true,
            reason: None,
            icon_data_url,
            diagnostic: host_opener_diagnostic(
                "host-opener-available",
                "Discovered from Start Menu shortcut.",
                Some(canonical_path.display().to_string()),
                Some(canonical_path.display().to_string()),
            ),
        });
    }
}

fn path_dirs(path_env: Option<OsString>) -> Vec<PathBuf> {
    path_env
        .map(|value| env::split_paths(&value).collect())
        .unwrap_or_default()
}

pub(crate) fn opener_candidates(
    env_var: &impl Fn(&str) -> Option<OsString>,
) -> Vec<OpenerCandidate> {
    let mut candidates = Vec::new();
    candidates.push(system_file_manager_candidate(env_var));
    candidates.extend(editor_candidates(env_var));
    candidates
}

fn system_file_manager_candidate(_env_var: &impl Fn(&str) -> Option<OsString>) -> OpenerCandidate {
    #[cfg(windows)]
    {
        OpenerCandidate {
            id: "system-file-manager",
            display_name: "File Explorer",
            kind: HostOpenerKind::FileManager,
            commands: &["explorer.exe", "explorer"],
            known_paths: first_env_path(_env_var, &["WINDIR", "SystemRoot"])
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

#[cfg_attr(not(windows), allow(dead_code))]
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

#[cfg(test)]
mod tests;
