use serde_json::Value;
use std::sync::Mutex;

use super::types::*;
use crate::{daemon_discovery::*, process};

// ==================== Supervisor State Management ====================

pub(crate) fn update_sidecar_supervisor(
    state: SidecarSupervisorState,
    generation: Option<u64>,
    pid: Option<u32>,
    last_error: Option<String>,
) {
    let pending_responses = pending_sidecar_responses()
        .lock()
        .map(|pending| pending.len())
        .unwrap_or_default();
    if let Ok(mut snapshot) = sidecar_supervisor()
        .get_or_init(|| Mutex::new(default_supervisor_snapshot()))
        .lock()
    {
        snapshot.state = state;
        snapshot.generation = generation.or(snapshot.generation);
        snapshot.pid = match state {
            SidecarSupervisorState::Stopped
            | SidecarSupervisorState::Stopping
            | SidecarSupervisorState::Degraded
                if pid.is_none() =>
            {
                None
            }
            _ => pid.or(snapshot.pid),
        };
        snapshot.pending_responses = pending_responses;
        if last_error.is_some()
            || matches!(
                state,
                SidecarSupervisorState::Ready | SidecarSupervisorState::Stopped
            )
        {
            snapshot.last_error = last_error;
        }
        if matches!(state, SidecarSupervisorState::Stopped) {
            snapshot.generation = None;
            snapshot.pid = None;
            snapshot.launch = None;
        }
        snapshot.last_transition_at = process::now_millis().to_string();
    }
}

pub(crate) fn record_sidecar_launch_plan(plan: &DaemonLaunchPlan) {
    if let Ok(mut snapshot) = sidecar_supervisor()
        .get_or_init(|| Mutex::new(default_supervisor_snapshot()))
        .lock()
    {
        snapshot.launch = Some(SidecarLaunchSnapshot {
            runtime_kind: plan.mode.as_str().to_string(),
            command: daemon_command_summary(&plan.launcher, &plan.args),
            entry_path: daemon_entry_summary(plan.entry.as_deref()),
            selection_reason: plan.selection_reason.clone(),
            work_dir: plan.work_dir.display().to_string(),
        });
    }
}

pub(crate) fn record_sidecar_reconnect_attempt(generation: u64) {
    if let Ok(mut snapshot) = sidecar_supervisor()
        .get_or_init(|| Mutex::new(default_supervisor_snapshot()))
        .lock()
    {
        snapshot.generation = Some(generation);
        snapshot.reconnect_retry_count = snapshot.reconnect_retry_count.saturating_add(1);
        snapshot.last_reconnect_attempt = Some(process::now_millis().to_string());
    }
}

pub(crate) fn record_sidecar_reconnect_error(generation: u64, error: &str) {
    if let Ok(mut snapshot) = sidecar_supervisor()
        .get_or_init(|| Mutex::new(default_supervisor_snapshot()))
        .lock()
    {
        snapshot.generation = Some(generation);
        snapshot.last_reconnect_error = Some(error.to_string());
    }
}

pub(crate) fn reset_sidecar_reconnect_state() {
    if let Ok(mut snapshot) = sidecar_supervisor()
        .get_or_init(|| Mutex::new(default_supervisor_snapshot()))
        .lock()
    {
        snapshot.reconnect_retry_count = 0;
        snapshot.last_reconnect_error = None;
    }
}

pub(crate) fn record_sidecar_daemon_build_hash(build_hash: &str) {
    if let Ok(mut snapshot) = sidecar_supervisor()
        .get_or_init(|| Mutex::new(default_supervisor_snapshot()))
        .lock()
    {
        snapshot.daemon_build_hash = if build_hash.is_empty() {
            None
        } else {
            Some(build_hash.to_string())
        };
    }
}

pub(crate) fn record_sidecar_disconnect(generation: u64, message: &str, rejected_pending_responses: usize) {
    if let Ok(mut snapshot) = sidecar_supervisor()
        .get_or_init(|| Mutex::new(default_supervisor_snapshot()))
        .lock()
    {
        snapshot.disconnect_count = snapshot.disconnect_count.saturating_add(1);
        snapshot.last_disconnect = Some(SidecarDisconnectSnapshot {
            generation,
            message: message.to_string(),
            rejected_pending_responses,
            disconnected_at: process::now_millis().to_string(),
        });
    }
}

pub(crate) fn record_sidecar_diagnostic(diagnostic: SidecarCommandDiagnostic) {
    if let Ok(mut snapshot) = sidecar_supervisor()
        .get_or_init(|| Mutex::new(default_supervisor_snapshot()))
        .lock()
    {
        snapshot.recent_diagnostics.push(diagnostic);
        let overflow = snapshot
            .recent_diagnostics
            .len()
            .saturating_sub(SIDECAR_RECENT_DIAGNOSTICS_LIMIT);
        if overflow > 0 {
            snapshot.recent_diagnostics.drain(0..overflow);
        }
    }
}

// ==================== Supervisor Snapshot ====================

pub(crate) fn sidecar_supervisor_snapshot() -> SidecarSupervisorSnapshot {
    let mut snapshot = sidecar_supervisor()
        .get_or_init(|| Mutex::new(default_supervisor_snapshot()))
        .lock()
        .map(|snapshot| snapshot.clone())
        .unwrap_or_else(|_| SidecarSupervisorSnapshot {
            state: SidecarSupervisorState::Degraded,
            generation: None,
            pid: None,
            pending_responses: 0,
            recent_diagnostics: Vec::new(),
            launch: None,
            last_error: Some("sidecar supervisor lock poisoned".to_string()),
            last_disconnect: None,
            disconnect_count: 0,
            reconnect_retry_count: 0,
            last_reconnect_error: None,
            last_reconnect_attempt: None,
            last_transition_at: process::now_millis().to_string(),
            daemon_build_hash: None,
        });
    snapshot.pending_responses = pending_sidecar_responses()
        .lock()
        .map(|pending| pending.len())
        .unwrap_or(snapshot.pending_responses);
    snapshot
}

pub(crate) fn sidecar_supervisor_error_summary() -> String {
    let snapshot = sidecar_supervisor_snapshot();
    if let Some(error) = snapshot.last_error {
        return format!("last_error: {error}");
    }
    if let Some(disconnect) = snapshot.last_disconnect {
        return format!(
            "last_disconnect: {} (rejected_pending_responses: {})",
            disconnect.message, disconnect.rejected_pending_responses
        );
    }
    format!("state: {:?}", snapshot.state)
}

pub(crate) fn recent_sidecar_diagnostic_context() -> String {
    let snapshot = sidecar_supervisor_snapshot();
    let Some(diagnostic) = snapshot.recent_diagnostics.last() else {
        return sidecar_supervisor_error_summary();
    };
    format!(
        "last_command: requestId={}, type={}, status={:?}, durationMs={}, error={}",
        diagnostic.request_id,
        diagnostic.command_type,
        diagnostic.status,
        diagnostic.duration_ms,
        diagnostic
            .error
            .as_ref()
            .map(|error| error.message.as_str())
            .unwrap_or("(none)")
    )
}

// ==================== Diagnostic Helpers ====================

pub(crate) fn command_type_from_value(cmd: &Value) -> String {
    cmd.get("type")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("unknown")
        .to_string()
}

pub(crate) fn truncate_diagnostic_message(message: &str) -> String {
    let trimmed = message.trim();
    if trimmed.chars().count() <= SIDECAR_ERROR_MESSAGE_LIMIT {
        return trimmed.to_string();
    }
    let mut truncated = trimmed
        .chars()
        .take(SIDECAR_ERROR_MESSAGE_LIMIT)
        .collect::<String>();
    truncated.push_str("...");
    truncated
}

pub(crate) fn sidecar_error_diagnostic(
    layer: &str,
    code: Option<&str>,
    message: &str,
) -> SidecarCommandErrorDiagnostic {
    SidecarCommandErrorDiagnostic {
        layer: layer.to_string(),
        code: code.map(str::to_string),
        message: truncate_diagnostic_message(message),
    }
}

pub(crate) fn sidecar_command_diagnostic(
    request_id: String,
    command_type: String,
    command_size_bytes: usize,
    key_field: Option<&str>,
    started_at_ms: u128,
    status: SidecarCommandDiagnosticStatus,
    error: Option<SidecarCommandErrorDiagnostic>,
) -> SidecarCommandDiagnostic {
    SidecarCommandDiagnostic {
        request_id,
        command_type,
        command_size_bytes,
        key_field: key_field.map(str::to_string),
        started_at: started_at_ms.to_string(),
        duration_ms: process::now_millis()
            .saturating_sub(started_at_ms)
            .try_into()
            .unwrap_or(u64::MAX),
        status,
        error,
    }
}
