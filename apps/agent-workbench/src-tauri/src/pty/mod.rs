//! Interactive PTY sessions for the desktop terminal panel.
//!
//! Spawns a real shell (PowerShell / pwsh on Windows, bash on Unix) via
//! `portable-pty` (ConPTY on Windows) and streams I/O to the frontend.
//!
//! Orphan protection (Windows): each shell is assigned to a shared app PTY Job Object
//! with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` at spawn (`session.rs` → `process::init_pty_job_object`
//! / `assign_child_to_pty_job_object`). Host crash closes the job handle → OS kills the tree.
//! Daemon/sidecar uses a **separate** job — see `process.rs` Job Objects section.
//! Explicit `kill_all_sessions` on `RunEvent::Exit` remains; dock unmount must not kill PTYs.
//!
//! Events:
//! - `workbench://pty-output` — `{ ptyId, data }`
//! - `workbench://pty-exit`   — `{ ptyId, exitCode? }`

mod session;

use serde::Serialize;
use tauri::AppHandle;

#[cfg(test)]
pub(crate) use session::next_pty_id;

const MAX_WRITE_BYTES: usize = 64 * 1024;

// ── command results ──────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PtyCreateResult {
    pub(crate) pty_id: String,
}

// ── Tauri commands ───────────────────────────────────────────────────────────

/// Create a PTY, spawn the default shell, start output streaming.
///
/// Frontend: `invoke('workbench_pty_create', { sessionKey, cols, rows, cwd? })`
#[tauri::command]
pub(crate) fn workbench_pty_create(
    app: AppHandle,
    session_key: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<PtyCreateResult, String> {
    let cols = cols.max(1);
    let rows = rows.max(1);
    let pty_id = session::create_session(app, session_key, cols, rows, cwd)?;
    Ok(PtyCreateResult { pty_id })
}

/// Write UTF-8 data to the PTY master (user keystrokes / paste).
/// Cap: 64 KiB per call.
#[tauri::command]
pub(crate) fn workbench_pty_write(pty_id: String, data: String) -> Result<(), String> {
    if data.len() > MAX_WRITE_BYTES {
        return Err(format!(
            "write too large: {} bytes (max {MAX_WRITE_BYTES})",
            data.len()
        ));
    }
    session::write_session(&pty_id, data.as_bytes())
}

/// Resize the PTY window (cols × rows).
#[tauri::command]
pub(crate) fn workbench_pty_resize(pty_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let cols = cols.max(1);
    let rows = rows.max(1);
    session::resize_session(&pty_id, cols, rows)
}

/// Kill the PTY child and remove it from the registry.
#[tauri::command]
pub(crate) fn workbench_pty_kill(pty_id: String) -> Result<(), String> {
    session::kill_session(&pty_id)
}

/// Kill every live PTY. Invoked from `main` on `RunEvent::Exit`.
///
/// Graceful path: explicit kill via ChildKiller. Crash path (Windows): PTY Job Object
/// `KILL_ON_JOB_CLOSE` in `process.rs` (not the daemon job).
pub(crate) fn kill_all_sessions() {
    session::kill_all();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn pty_id_uniqueness() {
        let mut seen = HashSet::new();
        for _ in 0..256 {
            let id = next_pty_id();
            assert!(seen.insert(id.clone()), "duplicate pty id: {id}");
            assert!(id.starts_with("pty-"), "id format: {id}");
        }
    }

    #[test]
    fn write_size_cap_constant() {
        assert_eq!(MAX_WRITE_BYTES, 64 * 1024);
    }

    #[test]
    fn kill_all_sessions_empty_registry_is_safe() {
        // Exit hook may run with zero PTYs; must not panic.
        kill_all_sessions();
        kill_all_sessions();
    }
}
