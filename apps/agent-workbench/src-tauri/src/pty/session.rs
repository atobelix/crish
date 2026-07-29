//! PTY session registry and lifecycle.
//!
//! Thread model:
//! - Create opens a native PTY, spawns the shell, stores master/writer/killer.
//! - A dedicated OS thread reads master → emits `workbench://pty-output`.
//! - On EOF / read error the reader waits for the child and emits `workbench://pty-exit`.
//! - Kill removes the session and signals the child.

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};

// ── event payloads ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyOutputEvent {
    pty_id: String,
    data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyExitEvent {
    pty_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<u32>,
}

// ── session ──────────────────────────────────────────────────────────────────

struct PtySession {
    /// Frontend association key (not used for routing; for diagnostics).
    #[allow(dead_code)]
    session_key: String,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Box<dyn MasterPty + Send>,
    killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
}

impl Drop for PtySession {
    fn drop(&mut self) {
        // Best-effort terminate; ignore errors (process may already be gone).
        if let Ok(mut k) = self.killer.lock() {
            let _ = k.kill();
        }
    }
}

// ── registry ─────────────────────────────────────────────────────────────────

static REGISTRY: OnceLock<Mutex<HashMap<String, PtySession>>> = OnceLock::new();
static PTY_SEQ: AtomicU64 = AtomicU64::new(1);

fn registry() -> &'static Mutex<HashMap<String, PtySession>> {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Generate a unique `pty-…` id (pure; unit-testable without a PTY).
pub(crate) fn next_pty_id() -> String {
    let seq = PTY_SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("pty-{seq}-{nanos}")
}

// ── shell / cwd helpers ──────────────────────────────────────────────────────

fn which_on_path(name: &str) -> bool {
    let Ok(path) = std::env::var("PATH") else {
        return false;
    };
    for dir in std::env::split_paths(&path) {
        let p = dir.join(name);
        if p.is_file() {
            return true;
        }
        #[cfg(windows)]
        {
            let exe = dir.join(format!("{name}.exe"));
            if exe.is_file() {
                return true;
            }
        }
    }
    false
}

fn resolve_cwd(cwd: Option<&str>) -> PathBuf {
    if let Some(raw) = cwd.map(str::trim).filter(|s| !s.is_empty()) {
        let p = PathBuf::from(raw);
        if p.is_dir() {
            return p;
        }
        // Still set it — shell may create/use it; fall through only if empty
        if !raw.is_empty() {
            return p;
        }
    }
    if let Ok(app) = crate::host_paths::app_dir() {
        let root = crate::host_paths::workspace_root(&app);
        if root.is_dir() {
            return root;
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// Default interactive shell: Windows prefers pwsh then powershell.exe; Unix bash/$SHELL.
fn build_shell_command(cwd: &Path) -> CommandBuilder {
    #[cfg(windows)]
    {
        let mut cmd = if which_on_path("pwsh") || which_on_path("pwsh.exe") {
            let mut c = CommandBuilder::new("pwsh.exe");
            c.arg("-NoLogo");
            c
        } else if let Ok(root) = std::env::var("SystemRoot") {
            let system_ps = Path::new(&root)
                .join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe");
            if system_ps.is_file() {
                let mut c = CommandBuilder::new(system_ps);
                c.arg("-NoLogo");
                c
            } else {
                let mut c = CommandBuilder::new("powershell.exe");
                c.arg("-NoLogo");
                c
            }
        } else {
            let mut c = CommandBuilder::new("powershell.exe");
            c.arg("-NoLogo");
            c
        };
        cmd.cwd(cwd);
        // Prefer UTF-8 for child tools
        cmd.env("PYTHONUTF8", "1");
        cmd.env("PYTHONIOENCODING", "utf-8");
        cmd
    }

    #[cfg(not(windows))]
    {
        let program = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty() && Path::new(s).is_file())
            .unwrap_or_else(|| {
                if Path::new("/bin/bash").is_file() {
                    "/bin/bash".into()
                } else {
                    "/bin/sh".into()
                }
            });
        let mut cmd = CommandBuilder::new(program);
        cmd.cwd(cwd);
        cmd.env("PYTHONUTF8", "1");
        cmd.env("PYTHONIOENCODING", "utf-8");
        // Interactive-ish: login shell when using bash
        if cmd.get_argv().first().map(|a| a.to_string_lossy().contains("bash")).unwrap_or(false) {
            cmd.arg("-i");
        }
        cmd
    }
}

// ── lifecycle ────────────────────────────────────────────────────────────────

pub(crate) fn create_session(
    app: AppHandle,
    session_key: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<String, String> {
    let cwd_path = resolve_cwd(cwd.as_deref());
    let pty_id = next_pty_id();

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("pty open failed: {e}"))?;

    let cmd = build_shell_command(&cwd_path);
    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("pty spawn shell failed: {e}"))?;

    // Orphan protection (crash path). Graceful Exit still uses kill_all; dock unmount does not kill.
    // Windows: shared PTY Job Object + KILL_ON_JOB_CLOSE — see process.rs (cross-ref daemon job).
    // Unix: best-effort process group so tree can be signalled as a unit if needed later.
    #[cfg(windows)]
    {
        if let Err(e) = crate::process::init_pty_job_object() {
            tracing::warn!(
                target: "pty",
                error = %e,
                "pty job object init failed; host crash may leave shell orphans"
            );
        }
        // `as_raw_handle` is on portable_pty::Child (Windows); available via dyn Child.
        match child.as_raw_handle() {
            Some(handle) => {
                if let Err(e) = crate::process::assign_child_to_pty_job_object(handle) {
                    tracing::warn!(
                        target: "pty",
                        error = %e,
                        "assign pty shell to job failed; host crash may leave shell orphans"
                    );
                }
            }
            None => {
                tracing::warn!(
                    target: "pty",
                    "pty child has no process handle; cannot assign to job object"
                );
            }
        }
    }
    #[cfg(not(windows))]
    {
        if let Some(pid) = child.process_id() {
            if let Err(e) = crate::process::set_child_process_group(pid) {
                tracing::warn!(
                    target: "pty",
                    pid,
                    error = %e,
                    "setpgid for pty shell failed"
                );
            }
        }
    }

    // Drop slave end in this process so the child is the only holder.
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("pty clone reader failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("pty take writer failed: {e}"))?;

    let killer = child.clone_killer();

    let session = PtySession {
        session_key,
        writer: Mutex::new(writer),
        master: pair.master,
        killer: Mutex::new(killer),
    };

    {
        let mut reg = registry()
            .lock()
            .map_err(|e| format!("pty registry lock: {e}"))?;
        reg.insert(pty_id.clone(), session);
    }

    // Reader + wait thread. Emits output then exit; removes from registry.
    let emit_id = pty_id.clone();
    let app_reader = app.clone();
    thread::Builder::new()
        .name(format!("pty-read-{pty_id}"))
        .spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buf[..n]).into_owned();
                        // Do not log full terminal data at info level.
                        tracing::trace!(
                            target: "pty",
                            pty_id = %emit_id,
                            bytes = n,
                            "pty output chunk"
                        );
                        let _ = app_reader.emit(
                            "workbench://pty-output",
                            PtyOutputEvent {
                                pty_id: emit_id.clone(),
                                data,
                            },
                        );
                    }
                    Err(e) => {
                        tracing::debug!(
                            target: "pty",
                            pty_id = %emit_id,
                            error = %e,
                            "pty reader ended"
                        );
                        break;
                    }
                }
            }

            let exit_code = match child.wait() {
                Ok(status) => Some(status.exit_code()),
                Err(e) => {
                    tracing::debug!(
                        target: "pty",
                        pty_id = %emit_id,
                        error = %e,
                        "pty wait failed"
                    );
                    None
                }
            };

            let _ = app_reader.emit(
                "workbench://pty-exit",
                PtyExitEvent {
                    pty_id: emit_id.clone(),
                    exit_code,
                },
            );

            // Remove session if still present (kill may have raced).
            if let Ok(mut reg) = registry().lock() {
                reg.remove(&emit_id);
            }
        })
        .map_err(|e| format!("pty reader thread spawn failed: {e}"))?;

    tracing::info!(
        target: "pty",
        pty_id = %pty_id,
        cols,
        rows,
        cwd = %cwd_path.display(),
        "pty session created"
    );

    Ok(pty_id)
}

pub(crate) fn write_session(pty_id: &str, data: &[u8]) -> Result<(), String> {
    let reg = registry()
        .lock()
        .map_err(|e| format!("pty registry lock: {e}"))?;
    let session = reg
        .get(pty_id)
        .ok_or_else(|| format!("pty not found: {pty_id}"))?;
    let mut writer = session
        .writer
        .lock()
        .map_err(|e| format!("pty writer lock: {e}"))?;
    writer
        .write_all(data)
        .map_err(|e| format!("pty write failed: {e}"))?;
    writer
        .flush()
        .map_err(|e| format!("pty flush failed: {e}"))?;
    Ok(())
}

pub(crate) fn resize_session(pty_id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let reg = registry()
        .lock()
        .map_err(|e| format!("pty registry lock: {e}"))?;
    let session = reg
        .get(pty_id)
        .ok_or_else(|| format!("pty not found: {pty_id}"))?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("pty resize failed: {e}"))
}

pub(crate) fn kill_session(pty_id: &str) -> Result<(), String> {
    let mut reg = registry()
        .lock()
        .map_err(|e| format!("pty registry lock: {e}"))?;
    match reg.remove(pty_id) {
        Some(session) => {
            // Drop kills via Drop impl; also explicit for clarity.
            if let Ok(mut k) = session.killer.lock() {
                let _ = k.kill();
            }
            drop(session);
            tracing::info!(target: "pty", pty_id = %pty_id, "pty session killed");
            Ok(())
        }
        None => Err(format!("pty not found: {pty_id}")),
    }
}

pub(crate) fn kill_all() {
    let mut reg = match registry().lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    let count = reg.len();
    let sessions: Vec<PtySession> = reg.drain().map(|(_, s)| s).collect();
    drop(reg);
    for session in sessions {
        if let Ok(mut k) = session.killer.lock() {
            let _ = k.kill();
        }
        drop(session);
    }
    if count > 0 {
        tracing::info!(target: "pty", count, "killed all pty sessions");
    }
}
