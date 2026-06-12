use serde_json::Value;

use super::supervisor::*;
use super::types::*;

// ==================== Pending Response Helpers ====================

pub(crate) fn sidecar_disconnected_message(message: &str) -> String {
    format!("{SIDECAR_DISCONNECTED_PREFIX}{message}")
}

pub(crate) fn is_sidecar_disconnected_error(message: &str) -> bool {
    message.starts_with(SIDECAR_DISCONNECTED_PREFIX)
}

pub(crate) fn resolve_pending_sidecar_response(event: &Value) -> bool {
    if event.get("type").and_then(Value::as_str) == Some("error") {
        let message = event
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| event.get("code").and_then(Value::as_str))
            .unwrap_or("Daemon query failed")
            .to_string();
        if let Some(request_id) = response_request_id(event) {
            return reject_pending_sidecar_response_by_request_id(request_id, message);
        }
        return false;
    }

    let Some(index) = matching_pending_response_index(event) else {
        return false;
    };

    let pending = {
        let mut pending = match pending_sidecar_responses().lock() {
            Ok(guard) => guard,
            Err(error) => {
                eprintln!("[Sidecar] Failed to lock pending responses: {error}");
                return false;
            }
        };
        pending.remove(index)
    };

    if let Some(pending) = pending {
        let _ = pending.sender.send(Ok(event.clone()));
        true
    } else {
        false
    }
}

fn matching_pending_response_index(event: &Value) -> Option<usize> {
    let pending = pending_sidecar_responses().lock().ok()?;
    if let Some(request_id) = response_request_id(event) {
        return pending
            .iter()
            .position(|candidate| candidate.request_id == request_id);
    }
    pending
        .iter()
        .position(|candidate| pending_response_matches(candidate, event))
}

pub(crate) fn response_request_id(event: &Value) -> Option<&str> {
    event
        .get("requestId")
        .and_then(Value::as_str)
        .or_else(|| event.get("correlationId").and_then(Value::as_str))
}

fn pending_response_matches(candidate: &PendingSidecarResponse, event: &Value) -> bool {
    if event.get("type").and_then(Value::as_str) != Some(candidate.expected_type.as_str()) {
        return false;
    }
    match (&candidate.key_field, &candidate.key_value) {
        (Some(field), Some(value)) => {
            event.get(field).and_then(Value::as_str) == Some(value.as_str())
        }
        (Some(_), None) => false,
        (None, _) => true,
    }
}

pub(crate) fn reject_pending_sidecar_response_by_request_id(request_id: &str, message: String) -> bool {
    let pending = {
        let mut pending = match pending_sidecar_responses().lock() {
            Ok(guard) => guard,
            Err(error) => {
                eprintln!("[Sidecar] Failed to lock pending responses: {error}");
                return false;
            }
        };
        pending
            .iter()
            .position(|candidate| candidate.request_id == request_id)
            .and_then(|index| pending.remove(index))
    };

    if let Some(pending) = pending {
        let rejection = pending_rejection_message(&message, &pending);
        record_sidecar_diagnostic(sidecar_command_diagnostic(
            pending.request_id.clone(),
            pending.command_type.clone(),
            pending.command_size_bytes,
            pending.key_field.as_deref(),
            pending.started_at_ms,
            if is_sidecar_disconnected_error(&message) {
                SidecarCommandDiagnosticStatus::Disconnected
            } else {
                SidecarCommandDiagnosticStatus::Error
            },
            Some(sidecar_error_diagnostic(
                if is_sidecar_disconnected_error(&message) {
                    "websocket"
                } else {
                    "daemon-response"
                },
                None,
                &message,
            )),
        ));
        let _ = pending.sender.send(Err(rejection));
        true
    } else {
        false
    }
}

pub(crate) fn remove_pending_sidecar_response(request_id: u64) {
    if let Ok(mut pending) = pending_sidecar_responses().lock() {
        if let Some(index) = pending
            .iter()
            .position(|candidate| candidate.id == request_id)
        {
            pending.remove(index);
        }
    }
}

pub(crate) fn reject_all_pending_sidecar_responses(message: String) -> usize {
    let pending = {
        let mut pending = match pending_sidecar_responses().lock() {
            Ok(guard) => guard,
            Err(error) => {
                eprintln!("[Sidecar] Failed to lock pending responses: {error}");
                return 0;
            }
        };
        pending.drain(..).collect::<Vec<_>>()
    };

    let rejected = pending.len();
    for pending in pending {
        let rejection = pending_rejection_message(&message, &pending);
        record_sidecar_diagnostic(sidecar_command_diagnostic(
            pending.request_id.clone(),
            pending.command_type.clone(),
            pending.command_size_bytes,
            pending.key_field.as_deref(),
            pending.started_at_ms,
            if is_sidecar_disconnected_error(&message) {
                SidecarCommandDiagnosticStatus::Disconnected
            } else {
                SidecarCommandDiagnosticStatus::Error
            },
            Some(sidecar_error_diagnostic(
                if is_sidecar_disconnected_error(&message) {
                    "websocket"
                } else {
                    "response-channel"
                },
                None,
                &message,
            )),
        ));
        let _ = pending.sender.send(Err(rejection));
    }
    rejected
}

pub(crate) fn pending_response_context(
    expected_type: &str,
    key_field: Option<&str>,
    key_value: Option<&str>,
) -> String {
    match (key_field, key_value) {
        (Some(field), Some(value)) => {
            format!("query expectedType={expected_type}, match {field}={value}")
        }
        (Some(field), None) => {
            format!("query expectedType={expected_type}, match {field}=<missing>")
        }
        (None, _) => format!("query expectedType={expected_type}"),
    }
}

pub(crate) fn pending_query_diagnostic(
    request_id: &str,
    expected_type: &str,
    key_field: Option<&str>,
    key_value: Option<&str>,
) -> String {
    format!(
        "requestId: {request_id}, expectedType: {expected_type}, context: {}",
        pending_response_context(expected_type, key_field, key_value)
    )
}

fn pending_rejection_message(base_message: &str, pending: &PendingSidecarResponse) -> String {
    format!(
        "{base_message} (requestId: {}, expectedType: {}, context: {})",
        pending.request_id, pending.expected_type, pending.context
    )
}
