//! Daemon discovery and launch plan resolution.
//!
//! Resolves the runtime (bun/npx/tsx/bundled), entry point, working directory,
//! and launch arguments needed to start the agent daemon process.
//!
//! ## Path Resolution Strategy
//!
//! Instead of probing many candidate roots at runtime, paths are derived
//! deterministically from two anchors:
//!
//! - **app_dir** -- the Tauri application directory (e.g. `apps/agent-workbench`)
//! - **workspace_root** -- the monorepo root derived from `app_dir`
//!
//! Production builds require a bundled daemon executable under `app_dir/resources/`.
//! Development builds always run the source entry
//! under `workspace_root/packages/agent-daemon/` so Workbench and daemon speak
//! the same protocol while the monorepo is changing.

use std::{
    env,
    path::{Path, PathBuf},
};

use crate::host_paths::workspace_root;

pub(crate) const DAEMON_ENTRY_RELATIVE: &str = "packages/agent-daemon/src/index.ts";
pub(crate) const NODE_DEVELOPMENT_CONDITION_ARGS: [&str; 2] = ["--conditions", "development"];

// ==================== Types ====================

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DaemonLaunchMode {
    ProductionBundled,
    DevelopmentBun,
    DevelopmentLocalTsx,
    DevelopmentNpx,
}

impl DaemonLaunchMode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::ProductionBundled => "production-bundled-daemon",
            Self::DevelopmentBun => "development-bun",
            Self::DevelopmentLocalTsx => "development-local-tsx",
            Self::DevelopmentNpx => "development-npx",
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct DaemonLaunchPlan {
    pub(crate) mode: DaemonLaunchMode,
    pub(crate) launcher: PathBuf,
    pub(crate) args: Vec<String>,
    pub(crate) work_dir: PathBuf,
    pub(crate) entry: Option<PathBuf>,
    pub(crate) selection_reason: Option<String>,
    pub(crate) launcher_candidates: Vec<PathBuf>,
    pub(crate) entry_candidates: Vec<PathBuf>,
}

#[derive(Clone, Debug)]
pub(crate) struct DaemonLaunchResolutionError {
    pub(crate) code: &'static str,
    pub(crate) mode: DaemonLaunchMode,
    pub(crate) work_dir: PathBuf,
    pub(crate) launcher_candidates: Vec<PathBuf>,
    pub(crate) entry_candidates: Vec<PathBuf>,
    pub(crate) selection_reason: Option<String>,
    pub(crate) message: String,
}

impl DaemonLaunchResolutionError {
    pub(crate) fn diagnostic(&self) -> String {
        format!(
            "sidecar.daemon.launch resolution failed: {}\n  code: {}\n  runtime_kind: {}\n  command: (unresolved)\n  entry_path: (unresolved)\n  selection_reason: {}\n  work_dir: {}\n  launcher_candidates:\n{}\n  entry_candidates:\n{}",
            self.message,
            self.code,
            self.mode.as_str(),
            self.selection_reason
                .as_deref()
                .unwrap_or("(not applicable)"),
            self.work_dir.display(),
            format_path_candidates(&self.launcher_candidates),
            format_path_candidates(&self.entry_candidates)
        )
    }
}

// ==================== Display Helpers ====================

pub(crate) fn daemon_command_summary(launcher: &Path, args: &[String]) -> String {
    let mut parts = Vec::with_capacity(args.len() + 1);
    parts.push(launcher.display().to_string());
    parts.extend(args.iter().cloned());
    parts.join(" ")
}

pub(crate) fn daemon_entry_summary(entry: Option<&Path>) -> String {
    entry
        .map(|entry| entry.display().to_string())
        .unwrap_or_else(|| "(bundled executable)".to_string())
}

pub(crate) fn format_path_candidates(candidates: &[PathBuf]) -> String {
    if candidates.is_empty() {
        return "    (none)".to_string();
    }

    candidates
        .iter()
        .enumerate()
        .map(|(index, candidate)| {
            format!(
                "    {}. {} (exists: {})",
                index + 1,
                candidate.display(),
                candidate.exists()
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub(crate) fn log_daemon_launch_plan(plan: &DaemonLaunchPlan) {
    tracing::info!(
        target: "sidecar",
        runtime_kind = plan.mode.as_str(),
        "[Sidecar][daemon.launch] runtime_kind: {}",
        plan.mode.as_str()
    );
    tracing::info!(
        target: "sidecar",
        command = %daemon_command_summary(&plan.launcher, &plan.args),
        "[Sidecar][daemon.launch] command: {}",
        daemon_command_summary(&plan.launcher, &plan.args)
    );
    tracing::info!(
        target: "sidecar",
        work_dir = %plan.work_dir.display(),
        "[Sidecar][daemon.launch] work_dir: {}",
        plan.work_dir.display()
    );
    tracing::info!(
        target: "sidecar",
        entry_path = %daemon_entry_summary(plan.entry.as_deref()),
        "[Sidecar][daemon.launch] entry_path: {}",
        daemon_entry_summary(plan.entry.as_deref())
    );
    if let Some(reason) = plan.selection_reason.as_deref() {
        tracing::info!(
            target: "sidecar",
            selection_reason = reason,
            "[Sidecar][daemon.launch] selection_reason: {reason}"
        );
    }
}

// ==================== Platform Helpers ====================

pub(crate) fn production_daemon_executable_names() -> Vec<&'static str> {
    if cfg!(windows) {
        vec![
            "crish-agent-daemon.exe",
            "agent-daemon.exe",
            "crish-daemon.exe",
        ]
    } else {
        vec!["crish-agent-daemon", "agent-daemon", "crish-daemon"]
    }
}

pub(crate) fn npx_executable_name() -> &'static str {
    if cfg!(windows) {
        "npx.cmd"
    } else {
        "npx"
    }
}

pub(crate) fn bun_executable_names() -> Vec<&'static str> {
    if cfg!(windows) {
        vec!["bun.exe", "bun.cmd", "bun.bat"]
    } else {
        vec!["bun"]
    }
}

pub(crate) fn tsx_executable_name() -> &'static str {
    if cfg!(windows) {
        "tsx.cmd"
    } else {
        "tsx"
    }
}

fn development_runtime_preference() -> String {
    env::var("CONEX_DAEMON_DEV_RUNTIME")
        .unwrap_or_else(|_| "auto".to_string())
        .trim()
        .to_ascii_lowercase()
}

pub(crate) fn source_runtime_args(entry: &Path) -> Vec<String> {
    NODE_DEVELOPMENT_CONDITION_ARGS
        .iter()
        .map(|arg| (*arg).to_string())
        .chain(std::iter::once(entry.to_string_lossy().to_string()))
        .collect()
}

pub(crate) fn npx_tsx_source_runtime_args(entry: &Path) -> Vec<String> {
    std::iter::once("tsx".to_string())
        .chain(
            NODE_DEVELOPMENT_CONDITION_ARGS
                .iter()
                .map(|arg| (*arg).to_string()),
        )
        .chain(std::iter::once(entry.to_string_lossy().to_string()))
        .collect()
}

// ==================== Deterministic Path Derivation ====================

/// Derive entry candidate paths from the two deterministic anchors.
///
/// Production: `app_dir/resources/` is the only location for bundled executables.
/// Development: `workspace_root/packages/agent-daemon/` is the only source entry.
///
/// This replaces the old `candidate_roots()` approach that probed 8+ directories
/// with 3-5 candidates each, producing unpredictable results depending on
/// environment variables and working directory.
fn derived_entry_candidates(app_dir: &Path) -> EntryCandidates {
    EntryCandidates {
        // Production: bundled executables live under app_dir/resources/
        bundled: production_daemon_executable_names()
            .iter()
            .map(|name| app_dir.join("resources").join(name))
            .collect(),

        // Development: source entry at the canonical monorepo location
        source: vec![workspace_root(app_dir).join(DAEMON_ENTRY_RELATIVE)],
    }
}

struct EntryCandidates {
    bundled: Vec<PathBuf>,
    source: Vec<PathBuf>,
}

fn bun_launcher_candidates(work_dir: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(path) = env::var("CONEX_BUN_BIN").or_else(|_| env::var("BUN_BIN")) {
        candidates.push(PathBuf::from(path));
    }
    let names = bun_executable_names();
    for name in &names {
        candidates.push(work_dir.join("node_modules").join(".bin").join(name));
    }
    for name in &names {
        candidates.push(work_dir.join(".bun").join("bin").join(name));
    }
    if let Ok(home) = env::var("USERPROFILE").or_else(|_| env::var("HOME")) {
        for name in &names {
            candidates.push(PathBuf::from(&home).join(".bun").join("bin").join(name));
        }
    }
    // PATH-based discovery after explicit and local candidates.
    if let Some(path_value) = env::var_os("PATH") {
        for dir in env::split_paths(&path_value) {
            for name in &names {
                let candidate = dir.join(name);
                if !candidates.iter().any(|existing| existing == &candidate) {
                    candidates.push(candidate);
                }
            }
        }
    }
    candidates
}

fn local_tsx_candidates(work_dir: &Path) -> Vec<PathBuf> {
    vec![work_dir
        .join("node_modules")
        .join(".bin")
        .join(tsx_executable_name())]
}

/// Derive the workspace root from the daemon source entry path:
/// `packages/agent-daemon/src/index.ts` -> monorepo root.
fn workspace_root_from_entry(entry: &Path) -> PathBuf {
    entry
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| workspace_root(entry))
}

// ==================== Launch Plan Resolution ====================

pub(crate) fn resolve_daemon_launch_plan(
    app_dir: &Path,
    production: bool,
) -> Result<DaemonLaunchPlan, String> {
    resolve_daemon_launch_plan_inner(app_dir, production).map_err(|error| error.diagnostic())
}

pub(crate) fn resolve_daemon_launch_plan_inner(
    app_dir: &Path,
    production: bool,
) -> Result<DaemonLaunchPlan, DaemonLaunchResolutionError> {
    if production {
        resolve_production_daemon_launch_plan(app_dir)
    } else {
        resolve_development_daemon_launch_plan(app_dir)
    }
}

fn resolve_production_daemon_launch_plan(
    app_dir: &Path,
) -> Result<DaemonLaunchPlan, DaemonLaunchResolutionError> {
    let candidates = derived_entry_candidates(app_dir);

    // 1. Try bundled executable (preferred for production)
    if let Some(launcher) = candidates
        .bundled
        .iter()
        .find(|candidate| candidate.is_file())
    {
        return Ok(DaemonLaunchPlan {
            mode: DaemonLaunchMode::ProductionBundled,
            launcher: launcher.clone(),
            args: Vec::new(),
            work_dir: launcher
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| app_dir.to_path_buf()),
            entry: None,
            selection_reason: None,
            launcher_candidates: candidates.bundled,
            entry_candidates: Vec::new(),
        });
    }

    // 2. Fall back to development-style source execution when no bundled exe exists.
    //    This prevents the app from being completely broken in release mode.
    //    The bundling script (build:daemon-binary) should be run for fully
    //    standalone distribution, but this fallback keeps the app functional
    //    during development and testing.
    let root = workspace_root(app_dir);
    Err(DaemonLaunchResolutionError {
        code: "packaging-missing",
        mode: DaemonLaunchMode::ProductionBundled,
        work_dir: root,
        launcher_candidates: candidates.bundled,
        entry_candidates: Vec::new(),
        selection_reason: Some(
            "release mode requires a bundled daemon executable".to_string(),
        ),
        message: "release sidecar requires a bundled daemon executable".to_string(),
    })
}

fn resolve_development_daemon_launch_plan(
    app_dir: &Path,
) -> Result<DaemonLaunchPlan, DaemonLaunchResolutionError> {
    let runtime_preference = development_runtime_preference();
    let candidates = derived_entry_candidates(app_dir);
    let root = workspace_root(app_dir);

    if !matches!(
        runtime_preference.as_str(),
        "" | "auto" | "bun" | "tsx" | "npx"
    ) {
        return Err(DaemonLaunchResolutionError {
            code: "development-runtime-unsupported",
            mode: DaemonLaunchMode::DevelopmentLocalTsx,
            work_dir: root,
            launcher_candidates: Vec::new(),
            entry_candidates: candidates.source,
            selection_reason: Some(
                "development runtime must be auto, bun, tsx, or npx".to_string(),
            ),
            message: format!("unsupported CONEX_DAEMON_DEV_RUNTIME value: {runtime_preference}"),
        });
    }

    let source_entry = candidates
        .source
        .iter()
        .find(|candidate| candidate.is_file())
        .cloned();

    let Some(entry) = source_entry.as_ref() else {
        return Err(DaemonLaunchResolutionError {
            code: "development-entry-missing",
            mode: DaemonLaunchMode::DevelopmentLocalTsx,
            work_dir: root,
            launcher_candidates: Vec::new(),
            entry_candidates: candidates.source,
            selection_reason: Some(
                "development mode requires the daemon source entry".to_string(),
            ),
            message: "development daemon source entry was not found".to_string(),
        });
    };
    let entry = entry.clone();
    let work_dir = workspace_root_from_entry(&entry);
    let selection_reason = if runtime_preference == "auto" || runtime_preference.is_empty() {
        "development mode uses the current daemon source protocol".to_string()
    } else {
        "CONEX_DAEMON_DEV_RUNTIME selected a development source runtime".to_string()
    };

    // 2a. Try bun (fastest source runtime)
    let bun_candidates = bun_launcher_candidates(&work_dir);
    if runtime_preference != "tsx" && runtime_preference != "npx" {
        if let Some(bun) = bun_candidates.iter().find(|candidate| candidate.is_file()) {
            return Ok(DaemonLaunchPlan {
                mode: DaemonLaunchMode::DevelopmentBun,
                launcher: bun.clone(),
                args: source_runtime_args(&entry),
                work_dir,
                entry: Some(entry.clone()),
                selection_reason: Some(selection_reason.clone()),
                launcher_candidates: bun_candidates,
                entry_candidates: candidates.source,
            });
        }
    }
    if runtime_preference == "bun" {
        return Err(DaemonLaunchResolutionError {
            code: "development-bun-missing",
            mode: DaemonLaunchMode::DevelopmentBun,
            work_dir,
            launcher_candidates: bun_candidates,
            entry_candidates: candidates.source,
            selection_reason: Some(selection_reason.clone()),
            message: "development daemon runtime is forced to bun, but no bun executable was found"
                .to_string(),
        });
    }

    // 2b. Try local tsx (project-local, no global install needed)
    let local_tsx_candidates_vec = local_tsx_candidates(&work_dir);
    if runtime_preference != "npx" {
        if let Some(local_tsx) = local_tsx_candidates_vec.iter().find(|candidate| candidate.is_file()) {
            return Ok(DaemonLaunchPlan {
                mode: DaemonLaunchMode::DevelopmentLocalTsx,
                launcher: local_tsx.clone(),
                args: source_runtime_args(&entry),
                work_dir,
                entry: Some(entry.clone()),
                selection_reason: Some(selection_reason.clone()),
                launcher_candidates: local_tsx_candidates_vec,
                entry_candidates: candidates.source,
            });
        }
    }
    if runtime_preference == "tsx" {
        return Ok(DaemonLaunchPlan {
            mode: DaemonLaunchMode::DevelopmentNpx,
            launcher: PathBuf::from(npx_executable_name()),
            args: npx_tsx_source_runtime_args(&entry),
            work_dir,
            entry: Some(entry.clone()),
            selection_reason: Some(
                "CONEX_DAEMON_DEV_RUNTIME=tsx selected npx tsx because local tsx was not found"
                    .to_string(),
            ),
            launcher_candidates: local_tsx_candidates_vec,
            entry_candidates: candidates.source,
        });
    }

    // 2c. Use npx tsx when no local source runtime is available.
    let mut launcher_candidates = bun_candidates;
    for candidate in local_tsx_candidates_vec {
        if !launcher_candidates.iter().any(|existing| existing == &candidate) {
            launcher_candidates.push(candidate);
        }
    }
    launcher_candidates.push(PathBuf::from(npx_executable_name()));
    Ok(DaemonLaunchPlan {
        mode: DaemonLaunchMode::DevelopmentNpx,
        launcher: PathBuf::from(npx_executable_name()),
        args: npx_tsx_source_runtime_args(&entry),
        work_dir,
        entry: Some(entry.clone()),
        selection_reason: Some(selection_reason),
        launcher_candidates,
        entry_candidates: candidates.source,
    })
}
