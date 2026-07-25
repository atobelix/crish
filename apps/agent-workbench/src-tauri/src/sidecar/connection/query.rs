use serde_json::Value;
use tokio_tungstenite::tungstenite::Message;

use super::disconnect::disconnect_sidecar_generation;
use super::helpers::current_sidecar_sender;
use super::lifecycle::ensure_sidecar_connected;
use super::super::pending::*;
use super::super::supervisor::*;
use super::super::types::*;
use crate::host_paths::app_dir;
use crate::process;

use conex_sandbox::gatekeeper::CommandGatekeeper;

pub(crate) fn check_sidecar_command_safety(cmd: &Value) -> Result<(), String> {
    let gk = CommandGatekeeper::new();
    if check_value_blocked(gk.patterns(), cmd) {
        return Err(
            "PermissionDenied: Command blocked by safety red-line gatekeeper (InvalidCommand)"
                .to_string(),
        );
    }
    Ok(())
}

fn check_value_blocked(patterns: &regex::RegexSet, value: &Value) -> bool {
    match value {
        Value::String(s) => patterns.is_match(s),
        Value::Object(map) => {
            if let Some(cmd_val) = map.get("command").or_else(|| map.get("cmd")) {
                if let Some(cmd_str) = cmd_val.as_str() {
                    let mut args_strs = Vec::new();
                    if let Some(args_val) = map.get("args").and_then(|v| v.as_array()) {
                        for a in args_val {
                            if let Some(arg_str) = a.as_str() {
                                args_strs.push(arg_str);
                            }
                        }
                    }
                    let full = if args_strs.is_empty() {
                        cmd_str.to_string()
                    } else {
                        format!("{} {}", cmd_str, args_strs.join(" "))
                    };
                    if patterns.is_match(&full) || patterns.is_match(cmd_str) {
                        return true;
                    }
                }
            }
            for v in map.values() {
                if check_value_blocked(patterns, v) {
                    return true;
                }
            }
            false
        }
        Value::Array(arr) => arr.iter().any(|v| check_value_blocked(patterns, v)),
        _ => false,
    }
}

pub(crate) async fn send_sidecar_query(
    app: &tauri::AppHandle,
    cmd: Value,
    expected_type: &str,
    key_field: Option<&str>,
    key_value: Option<String>,
) -> Result<Value, String> {
    check_sidecar_command_safety(&cmd)?;
    let app_dir = app_dir()?;
    let cmd_text = cmd.to_string();
    let mut last_disconnect: Option<String> = None;

    for attempt in 0..=1 {
        let connection = match ensure_sidecar_connected(app, &app_dir).await {
            Ok(connection) => connection,
            Err(error) if last_disconnect.is_some() => {
                return Err(format!(
                    "sidecar.daemon.websocket reconnect failed while querying {expected_type}: {error}"
                ));
            }
            Err(error) => {
                return Err(format!(
                    "sidecar.daemon connect failed while querying {expected_type}: {error}"
                ))
            }
        };

        match send_sidecar_query_once(
            &connection,
            cmd_text.clone(),
            expected_type,
            key_field,
            key_value.clone(),
        )
        .await
        {
            Ok(value) => return Ok(value),
            Err(error) if is_sidecar_disconnected_error(&error) && attempt == 0 => {
                last_disconnect = Some(error);
                continue;
            }
            Err(error) if is_sidecar_disconnected_error(&error) => {
                let previous = last_disconnect
                    .map(|message| format!("; previous disconnect: {message}"))
                    .unwrap_or_default();
                return Err(format!(
                    "sidecar.daemon.websocket reconnect failed while querying {expected_type}: {error}{previous}"
                ));
            }
            Err(error) => return Err(error),
        }
    }

    Err(format!(
        "sidecar.daemon.websocket reconnect failed while querying {expected_type}"
    ))
}

async fn send_sidecar_query_once(
    connection: &SidecarSender,
    cmd_text: String,
    expected_type: &str,
    key_field: Option<&str>,
    key_value: Option<String>,
) -> Result<Value, String> {
    let (response_tx, response_rx) = tokio::sync::oneshot::channel();
    let request_id = next_pending_response_id();
    let daemon_request_id = format!("sidecar-query-{request_id}");
    let started_at_ms = process::now_millis();
    let command_size_bytes = cmd_text.len();
    let mut cmd = serde_json::from_str::<Value>(&cmd_text)
        .map_err(|e| format!("Failed to encode sidecar query {expected_type}: {e}"))?;
    let command_type = command_type_from_value(&cmd);
    if let Value::Object(ref mut object) = cmd {
        object.insert(
            "requestId".to_string(),
            Value::String(daemon_request_id.clone()),
        );
        object.insert(
            "correlationId".to_string(),
            Value::String(daemon_request_id.clone()),
        );
    } else {
        return Err(format!(
            "Failed to encode sidecar query {expected_type}: command must be a JSON object"
        ));
    }

    let context = pending_response_context(expected_type, key_field, key_value.as_deref());
    let query_diagnostic = pending_query_diagnostic(
        &daemon_request_id,
        expected_type,
        key_field,
        key_value.as_deref(),
    );
    {
        let mut pending = pending_sidecar_responses()
            .lock()
            .map_err(|e| format!("Failed to lock pending sidecar responses: {e}"))?;
        pending.push_back(PendingSidecarResponse {
            id: request_id,
            request_id: daemon_request_id.clone(),
            expected_type: expected_type.to_string(),
            command_type: command_type.clone(),
            command_size_bytes,
            started_at_ms,
            key_field: key_field.map(str::to_string),
            key_value,
            context,
            sender: response_tx,
        });
    }

    if let Err(error) = connection.writer.send(Message::Text(cmd.to_string())).await {
        remove_pending_sidecar_response(request_id);
        let message =
            format!("Daemon WebSocket disconnected while sending {expected_type}: {error}");
        record_sidecar_diagnostic(sidecar_command_diagnostic(
            daemon_request_id,
            command_type,
            command_size_bytes,
            key_field,
            started_at_ms,
            SidecarCommandDiagnosticStatus::Disconnected,
            Some(sidecar_error_diagnostic("websocket-send", None, &message)),
        ));
        disconnect_sidecar_generation(connection.generation, &message, false);
        return Err(sidecar_disconnected_message(&message));
    }

    match tokio::time::timeout(tokio::time::Duration::from_secs(10), response_rx).await {
        Ok(Ok(Ok(value))) => {
            record_sidecar_diagnostic(sidecar_command_diagnostic(
                daemon_request_id,
                command_type,
                command_size_bytes,
                key_field,
                started_at_ms,
                SidecarCommandDiagnosticStatus::Ok,
                None,
            ));
            Ok(value)
        }
        Ok(Ok(Err(error))) => {
            record_sidecar_diagnostic(sidecar_command_diagnostic(
                daemon_request_id,
                command_type,
                command_size_bytes,
                key_field,
                started_at_ms,
                if is_sidecar_disconnected_error(&error) {
                    SidecarCommandDiagnosticStatus::Disconnected
                } else {
                    SidecarCommandDiagnosticStatus::Error
                },
                Some(sidecar_error_diagnostic(
                    if is_sidecar_disconnected_error(&error) {
                        "websocket"
                    } else {
                        "daemon-response"
                    },
                    None,
                    &error,
                )),
            ));
            Err(error)
        }
        Ok(Err(_)) => {
            let message = format!(
                "sidecar.daemon.response channel closed before query completed ({}); {}",
                query_diagnostic,
                recent_sidecar_diagnostic_context()
            );
            record_sidecar_diagnostic(sidecar_command_diagnostic(
                daemon_request_id,
                command_type,
                command_size_bytes,
                key_field,
                started_at_ms,
                SidecarCommandDiagnosticStatus::Disconnected,
                Some(sidecar_error_diagnostic("response-channel", None, &message)),
            ));
            Err(message)
        }
        Err(_) => {
            remove_pending_sidecar_response(request_id);
            let message = format!(
                "sidecar.daemon.response timed out waiting for query ({})",
                query_diagnostic
            );
            record_sidecar_diagnostic(sidecar_command_diagnostic(
                daemon_request_id,
                command_type,
                command_size_bytes,
                key_field,
                started_at_ms,
                SidecarCommandDiagnosticStatus::Timeout,
                Some(sidecar_error_diagnostic(
                    "response-timeout",
                    Some("timeout"),
                    &message,
                )),
            ));
            Err(message)
        }
    }
}

async fn send_sidecar_command_once(
    connection: &SidecarSender,
    cmd_text: String,
    context: &str,
) -> Result<(), String> {
    let request_id = format!("sidecar-command-{}", next_command_id());
    let started_at_ms = process::now_millis();
    let command_size_bytes = cmd_text.len();
    let command_type = serde_json::from_str::<Value>(&cmd_text)
        .ok()
        .map(|cmd| command_type_from_value(&cmd))
        .unwrap_or_else(|| context.to_string());
    if let Err(error) = connection.writer.send(Message::Text(cmd_text)).await {
        let message = format!("Daemon WebSocket disconnected while sending {context}: {error}");
        record_sidecar_diagnostic(sidecar_command_diagnostic(
            request_id,
            command_type,
            command_size_bytes,
            None,
            started_at_ms,
            SidecarCommandDiagnosticStatus::Disconnected,
            Some(sidecar_error_diagnostic("websocket-send", None, &message)),
        ));
        disconnect_sidecar_generation(connection.generation, &message, false);
        return Err(sidecar_disconnected_message(&message));
    }

    record_sidecar_diagnostic(sidecar_command_diagnostic(
        request_id,
        command_type,
        command_size_bytes,
        None,
        started_at_ms,
        SidecarCommandDiagnosticStatus::Ok,
        None,
    ));
    Ok(())
}

pub(crate) async fn send_sidecar_command(
    app: &tauri::AppHandle,
    cmd: Value,
    context: &str,
) -> Result<(), String> {
    check_sidecar_command_safety(&cmd)?;
    let app_dir = app_dir()?;
    let cmd_text = cmd.to_string();
    let mut last_disconnect: Option<String> = None;

    for attempt in 0..=1 {
        let connection = match ensure_sidecar_connected(app, &app_dir).await {
            Ok(connection) => connection,
            Err(error) if last_disconnect.is_some() => {
                return Err(format!(
                    "sidecar.daemon.websocket reconnect failed while sending {context}: {error}"
                ));
            }
            Err(error) => {
                return Err(format!(
                    "sidecar.daemon connect failed while sending {context}: {error}"
                ))
            }
        };

        match send_sidecar_command_once(&connection, cmd_text.clone(), context).await {
            Ok(()) => return Ok(()),
            Err(error) if is_sidecar_disconnected_error(&error) && attempt == 0 => {
                last_disconnect = Some(error);
                continue;
            }
            Err(error) if is_sidecar_disconnected_error(&error) => {
                let previous = last_disconnect
                    .map(|message| format!("; previous disconnect: {message}"))
                    .unwrap_or_default();
                return Err(format!(
                    "sidecar.daemon.websocket reconnect failed while sending {context}: {error}{previous}"
                ));
            }
            Err(error) => return Err(error),
        }
    }

    Err(format!(
        "sidecar.daemon.websocket reconnect failed while sending {context}"
    ))
}

pub(crate) async fn send_current_sidecar_command(
    cmd: Value,
    context: &str,
) -> Result<bool, String> {
    check_sidecar_command_safety(&cmd)?;
    let Some(connection) = current_sidecar_sender() else {
        return Ok(false);
    };

    send_sidecar_command_once(&connection, cmd.to_string(), context).await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_gatekeeper_blocks_eleven_red_lines_in_sidecar_payload() {
        let red_lines = vec![
            json!({"command": "rm -rf /"}),
            json!({"command": "rm -rf /*"}),
            json!({"command": "rm --no-preserve-root -rf /"}),
            json!({"command": "dd if=/dev/zero of=/dev/sda"}),
            json!({"command": "dd if=/dev/random of=/dev/sdb"}),
            json!({"command": "mkfs.ext4 /dev/sda"}),
            json!({"cmd": "Remove-Item", "args": ["-Recurse", "-Path", "C:\\"]}),
            json!({"cmd": "Remove-Item", "args": ["-Recurse", "D:\\"]}),
            json!({"command": "format C:"}),
            json!({"command": "del /f C:\\"}),
            json!({"command": "rd /s C:\\"}),
        ];

        for payload in red_lines {
            let res = check_sidecar_command_safety(&payload);
            assert!(
                res.is_err(),
                "Expected red line payload {:?} to be blocked",
                payload
            );
            let err = res.unwrap_err();
            assert!(err.contains("PermissionDenied"), "Err should contain PermissionDenied");
            assert!(err.contains("InvalidCommand"), "Err should contain InvalidCommand");
        }
    }

    #[test]
    fn test_gatekeeper_allows_safe_sidecar_payload() {
        let safe_payloads = vec![
            json!({"command": "echo hello"}),
            json!({"command": "git status"}),
            json!({"command": "cargo test"}),
            json!({"cmd": "ls", "args": ["-la"]}),
        ];

        for payload in safe_payloads {
            assert!(
                check_sidecar_command_safety(&payload).is_ok(),
                "Expected safe payload {:?} to pass",
                payload
            );
        }
    }
}

