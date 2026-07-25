use std::sync::Mutex;

use super::super::pending::*;
use super::super::run_stream::*;
use super::super::supervisor::*;
use super::super::types::*;
use super::process_mgmt::clear_sidecar_process;

pub(crate) fn disconnect_sidecar_generation(generation: u64, message: &str, kill_child: bool) {
    let cleared = if let Some(conn) = sidecar_connection().get() {
        match conn.lock() {
            Ok(mut guard) => {
                if guard
                    .as_ref()
                    .is_some_and(|sidecar| sidecar.generation == generation)
                {
                    *guard = None;
                    true
                } else {
                    false
                }
            }
            Err(error) => {
                eprintln!("[Sidecar] Failed to lock sidecar connection: {error}");
                false
            }
        }
    } else {
        false
    };

    if !cleared {
        return;
    }

    eprintln!("[Sidecar][daemon.websocket] {message}; clearing stale sidecar connection");
    mark_run_streams_disconnected(generation, message);
    let rejected = reject_all_pending_sidecar_responses(sidecar_disconnected_message(message));
    if rejected > 0 {
        eprintln!(
            "[Sidecar][daemon.pending] Rejected {rejected} pending response(s) after disconnect"
        );
    }
    record_sidecar_disconnect(generation, message, rejected);
    update_sidecar_supervisor(
        SidecarSupervisorState::Degraded,
        Some(generation),
        None,
        Some(message.to_string()),
    );
    clear_sidecar_process(kill_child);
}

pub(crate) fn record_sidecar_daemon_endpoint(port: u16, pid: u32, build_hash: String) {
    if let Ok(mut endpoint) = sidecar_daemon_endpoint()
        .get_or_init(|| Mutex::new(None))
        .lock()
    {
        *endpoint = Some(SidecarDaemonEndpoint {
            port,
            pid,
            build_hash,
        });
    }
}

fn clear_sidecar_daemon_endpoint() {
    if let Some(endpoint) = sidecar_daemon_endpoint().get() {
        if let Ok(mut guard) = endpoint.lock() {
            *guard = None;
        }
    }
}

pub(crate) fn active_sidecar_daemon_endpoint() -> Option<SidecarDaemonEndpoint> {
    let endpoint_obj = sidecar_daemon_endpoint()
        .get()
        .and_then(|endpoint| endpoint.lock().ok().and_then(|guard| guard.clone()))?;

    let proc_store = sidecar_process().get()?;
    let mut guard = proc_store.lock().ok()?;
    let alive = guard
        .as_mut()
        .map(|child| matches!(child.try_wait(), Ok(None)))
        .unwrap_or(false);

    if alive {
        Some(endpoint_obj)
    } else {
        clear_sidecar_daemon_endpoint();
        None
    }
}
