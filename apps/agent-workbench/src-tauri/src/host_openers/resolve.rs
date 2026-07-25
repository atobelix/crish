use std::path::{Path, PathBuf};

use crate::host_openers::types::{
    host_opener_diagnostic, host_opener_error, HostOpenerDiagnostic, HostOpenerError,
    HostOpenerKind, HostOpenTarget, HostOpenTargetKind, OpenerCandidate, ResolvedOpenerCommand,
    ResolvedOpenTarget,
};

pub(crate) fn resolve_candidate_command(
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

pub(crate) fn unavailable_reason(candidate: &OpenerCandidate) -> String {
    if candidate.kind == HostOpenerKind::FileManager {
        return "No system file manager command was discovered on this host.".to_string();
    }
    "No matching command or known installation path was discovered on this host.".to_string()
}

pub(crate) fn unavailable_diagnostic(candidate: &OpenerCandidate) -> HostOpenerDiagnostic {
    host_opener_diagnostic(
        "host-opener-unavailable",
        unavailable_reason(candidate),
        Some(candidate.commands.join(",")),
        None,
    )
}

pub(crate) fn resolve_open_target_for_roots(
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

pub(crate) fn opener_args(
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

pub(crate) fn open_target_display(target: &ResolvedOpenTarget) -> String {
    match target {
        ResolvedOpenTarget::Path(path) => path.display().to_string(),
        ResolvedOpenTarget::Url(url) => url.clone(),
    }
}
