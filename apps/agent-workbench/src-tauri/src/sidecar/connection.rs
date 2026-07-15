use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::{
    collections::HashMap,
    env,
    io::{BufRead, BufReader, Read},
    path::Path,
    process::{Command, Stdio},
    sync::Mutex,
    time::Duration,
};
use tauri::Emitter;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use super::pending::*;
use super::run_stream::*;
use super::supervisor::*;
use super::types::*;
use crate::{
    config,
    daemon_discovery,
    host_paths::app_dir,
    process,
};
use daemon_discovery::*;

/// Protocol version that this Tauri client expects from the daemon ready line.
/// Must be kept in sync with `DAEMON_HANDSHAKE_PROTOCOL_VERSION` in the daemon.
const EXPECTED_DAEMON_HANDSHAKE_PROTOCOL_VERSION: u64 = 1;

// ==================== Connection Helpers ====================

pub(crate) fn current_sidecar_sender() -> Option<SidecarSender> {
    let connection = sidecar_connection().get().and_then(|conn| {
        conn.lock().ok().and_then(|guard| {
            guard
                .as_ref()
                .map(|sidecar| (sidecar.generation, sidecar.writer.clone()))
        })
    });
    match connection {
        Some((generation, writer)) if !writer.is_closed() => {
            Some(SidecarSender { generation, writer })
        }
        Some((generation, _)) => {
            disconnect_sidecar_generation(
                generation,
                "Daemon WebSocket sender was already closed",
                false,
            );
            None
        }
        None => None,
    }
}

fn sidecar_connection_usable(connection: &SidecarConnection) -> bool {
    !connection.writer.is_closed()
}

fn cached_sidecar_sender_or_disconnect(
    stale_message: &str,
) -> Result<Option<SidecarSender>, String> {
    let stale_generation = {
        let conn = sidecar_connection().get_or_init(|| Mutex::new(None));
        let guard = conn.lock().map_err(|e| e.to_string())?;
        if let Some(ref sidecar) = *guard {
            if sidecar_connection_usable(sidecar) {
                return Ok(Some(SidecarSender {
                    generation: sidecar.generation,
                    writer: sidecar.writer.clone(),
                }));
            }
            Some(sidecar.generation)
        } else {
            None
        }
    };

    if let Some(generation) = stale_generation {
        disconnect_sidecar_generation(generation, stale_message, false);
    }

    Ok(None)
}

// ==================== Command/Query Sending ====================

pub(crate) async fn send_sidecar_query(
    app: &tauri::AppHandle,
    cmd: Value,
    expected_type: &str,
    key_field: Option<&str>,
    key_value: Option<String>,
) -> Result<Value, String> {
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
    let request_id = format!(
        "sidecar-command-{}",
        next_command_id()
    );
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
    let Some(connection) = current_sidecar_sender() else {
        return Ok(false);
    };

    send_sidecar_command_once(&connection, cmd.to_string(), context).await?;
    Ok(true)
}

// ==================== Disconnect Handling ====================

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

// ==================== Daemon Endpoint Management ====================

fn record_sidecar_daemon_endpoint(port: u16, pid: u32, build_hash: String) {
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
    let endpoint = sidecar_daemon_endpoint()
        .get()
        .and_then(|endpoint| endpoint.lock().ok().and_then(|guard| guard.clone()))?;

    let alive = sidecar_process()
        .get()
        .and_then(|proc_store| {
            proc_store.lock().ok().map(|mut guard| {
                guard
                    .as_mut()
                    .map(|child| matches!(child.try_wait(), Ok(None)))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);

    if alive {
        Some(endpoint)
    } else {
        clear_sidecar_daemon_endpoint();
        None
    }
}

// ==================== Process Management ====================

fn clear_sidecar_process(kill_child: bool) {
    if kill_child {
        clear_sidecar_daemon_endpoint();
    }
    if let Some(proc_store) = sidecar_process().get() {
        if let Ok(mut guard) = proc_store.lock() {
            if let Some(mut child) = guard.take() {
                let pid = child.id();
                if kill_child {
                    println!(
                        "[Sidecar][daemon.child-process] Terminating stale daemon process tree (PID: {})",
                        pid
                    );
                    match process::terminate_process_tree(pid) {
                        Ok(()) => {}
                        Err(error) => {
                            eprintln!(
                                "[Sidecar][daemon.child-process] Process tree termination failed for PID {pid}: {error}; falling back to child.kill()"
                            );
                            let _ = child.kill();
                        }
                    }
                }
                let _ = child.wait();
            }
        }
    }
}

fn read_daemon_stdout_line_with_timeout<R>(
    reader: BufReader<R>,
    context: &'static str,
) -> Result<(usize, String, BufReader<R>), String>
where
    R: Read + Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut line = String::new();
        let result = reader
            .read_line(&mut line)
            .map(|bytes| (bytes, line, reader));
        let _ = tx.send(result);
    });

    match rx.recv_timeout(Duration::from_secs(DAEMON_READY_TIMEOUT_SECS)) {
        Ok(Ok(result)) => Ok(result),
        Ok(Err(error)) => Err(format!(
            "sidecar.daemon.stdout read failed while {context}: {error}"
        )),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err(format!(
            "sidecar.daemon.stdout timed out after {DAEMON_READY_TIMEOUT_SECS}s while {context}"
        )),
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err(format!(
            "sidecar.daemon.stdout reader ended before {context}"
        )),
    }
}

fn collect_child_exit(child: &mut std::process::Child, kill_first: bool) -> (String, String) {
    if kill_first {
        let _ = child.kill();
    }

    let mut stderr_msg = String::new();
    if let Some(err_stream) = child.stderr.take() {
        let mut err_reader = BufReader::new(err_stream);
        let _ = err_reader.read_to_string(&mut stderr_msg);
    }

    let status = child.wait().unwrap_or_default();
    let exit_code = status
        .code()
        .map(|code| code.to_string())
        .unwrap_or_else(|| "signal-or-terminated".to_string());
    (exit_code, stderr_msg)
}

fn log_captured_stderr(context: &str, exit_code: &str, stderr: &str) {
    eprintln!("[Sidecar][daemon.stderr] === {context} START ===");
    if stderr.trim().is_empty() {
        eprintln!("(empty)");
    } else {
        eprintln!("{}", stderr.trim_end());
    }
    eprintln!("[Sidecar][daemon.stderr] === {context} END (exit_code: {exit_code}) ===");
}

fn daemon_startup_failure(
    reason: &str,
    launch_plan: &DaemonLaunchPlan,
    exit_code: &str,
    stdout_before_ready: &[String],
    stderr: &str,
) -> String {
    let stdout_text = if stdout_before_ready.is_empty() {
        "(no stdout before ready line)".to_string()
    } else {
        stdout_before_ready.join("\n")
    };
    let stderr_text = if stderr.trim().is_empty() {
        "(no stderr output; verify the selected daemon runtime, launcher, and entry path)"
            .to_string()
    } else {
        stderr.trim_end().to_string()
    };

    format!(
        "sidecar.daemon.child-process startup failed: {reason}\n  exit_code: {exit_code}\n  runtime_kind: {}\n  command: {}\n  entry_path: {}\n  selection_reason: {}\n  work_dir: {}\n  launcher_candidates:\n{}\n  entry_candidates:\n{}\n  stdout_before_ready:\n{}\n  stderr:\n{}",
        launch_plan.mode.as_str(),
        daemon_command_summary(&launch_plan.launcher, &launch_plan.args),
        daemon_entry_summary(launch_plan.entry.as_deref()),
        launch_plan
            .selection_reason
            .as_deref()
            .unwrap_or("(not applicable)"),
        launch_plan.work_dir.display(),
        format_path_candidates(&launch_plan.launcher_candidates),
        format_path_candidates(&launch_plan.entry_candidates),
        stdout_text,
        stderr_text
    )
}

fn spawn_sidecar_output_drain<R>(label: &'static str, mut reader: BufReader<R>)
where
    R: Read + Send + 'static,
{
    std::thread::spawn(move || {
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    let trimmed = line.trim_end();
                    if !trimmed.is_empty() {
                        eprintln!("[Sidecar][{label}] {trimmed}");
                    }
                }
                Err(error) => {
                    eprintln!("[Sidecar][{label}] output drain failed: {error}");
                    break;
                }
            }
        }
    });
}

// ==================== Cleanup ====================

pub(crate) fn cleanup_sidecar() {
    update_sidecar_supervisor(SidecarSupervisorState::Stopping, None, None, None);
    if let Some(conn) = sidecar_connection().get() {
        if let Ok(mut guard) = conn.lock() {
            *guard = None;
        }
    }
    let rejected = reject_all_pending_sidecar_responses("Sidecar was stopped".to_string());
    if rejected > 0 {
        eprintln!(
            "[Sidecar][daemon.pending] Rejected {rejected} pending response(s) during cleanup"
        );
    }
    clear_sidecar_process(true);
    update_sidecar_supervisor(SidecarSupervisorState::Stopped, None, None, None);
}

// ==================== Connection Lifecycle ====================

pub(crate) async fn ensure_sidecar_connected(
    app: &tauri::AppHandle,
    app_dir: &Path,
) -> Result<SidecarSender, String> {
    if let Some(sender) =
        cached_sidecar_sender_or_disconnect("Daemon WebSocket sender was closed before query")?
    {
        return Ok(sender);
    }

    let _startup_guard = sidecar_startup_lock().lock().await;

    if let Some(sender) =
        cached_sidecar_sender_or_disconnect("Daemon WebSocket sender was closed before startup")?
    {
        return Ok(sender);
    }

    let generation = next_connection_generation();
    record_sidecar_reconnect_attempt(generation);
    update_sidecar_supervisor(
        SidecarSupervisorState::Starting,
        Some(generation),
        None,
        None,
    );

    // Attempt connection with exponential backoff + jitter retry for daemon startup failures.
    let mut last_error: Option<String> = None;
    'retry: for attempt in 0..MAX_RECONNECT_ATTEMPTS {
        if attempt > 0 {
            let base_delay_ms = BASE_RECONNECT_DELAY_MS * (1u64 << (attempt - 1));
            let capped_delay_ms = base_delay_ms.min(MAX_RECONNECT_DELAY_MS);
            let jittered_ms = apply_reconnect_jitter(capped_delay_ms);
            emit_run_stream_diagnostics(
                app,
                "reconnect-retry",
                "info",
                generation,
                &format!(
                    "Retry attempt {}/{} after {}ms backoff (base: {}ms capped from {}ms): {}",
                    attempt + 1,
                    MAX_RECONNECT_ATTEMPTS,
                    jittered_ms,
                    capped_delay_ms,
                    base_delay_ms,
                    last_error.as_deref().unwrap_or("unknown error")
                ),
                None,
            );
            tokio::time::sleep(Duration::from_millis(jittered_ms)).await;
            // Re-check for existing endpoint between retries (daemon may have started externally).
            if active_sidecar_daemon_endpoint().is_none() {
                clear_sidecar_process(true);
            }
        }

        let sender = if let Some(endpoint) = active_sidecar_daemon_endpoint() {
            println!(
                "[Sidecar][daemon.websocket] Reconnecting to existing daemon process (PID: {}, port: {}, buildHash: {})",
                endpoint.pid,
                endpoint.port,
                if endpoint.build_hash.is_empty() {
                    "(not provided)"
                } else {
                    endpoint.build_hash.as_str()
                }
            );
            match connect_sidecar_websocket(app, generation, endpoint.port).await {
                Ok(sender) => {
                    update_sidecar_supervisor(
                        SidecarSupervisorState::Ready,
                        Some(generation),
                        Some(endpoint.pid),
                        None,
                    );
                    sender
                }
                Err(error) => {
                    emit_run_stream_diagnostics(
                        app,
                        "reconnect-failed",
                        "error",
                        generation,
                        &format!(
                            "Failed to reconnect to existing daemon WebSocket; restarting daemon: {error}"
                        ),
                        None,
                    );
                    record_sidecar_reconnect_error(generation, &error);
                    clear_sidecar_process(true);
                    last_error = Some(error);
                    continue 'retry;
                }
            }
        } else {
            clear_sidecar_process(true);
            match start_and_connect_sidecar(app, app_dir, generation).await {
                Ok((sender, _port)) => sender,
                Err(error) => {
                    record_sidecar_reconnect_error(generation, &error);
                    last_error = Some(error);
                    continue 'retry;
                }
            }
        };

        // Connection succeeded -- update state and persist connection.
        {
            let conn = sidecar_connection().get_or_init(|| Mutex::new(None));
            let mut guard = conn.lock().map_err(|e| e.to_string())?;
            *guard = Some(SidecarConnection {
                generation,
                writer: sender.clone(),
            });
        }
        reset_sidecar_reconnect_state();
        update_sidecar_supervisor(SidecarSupervisorState::Ready, Some(generation), None, None);
        spawn_run_stream_replay(app.clone(), generation);

        return Ok(SidecarSender {
            generation,
            writer: sender,
        });
    }

    // All retry attempts exhausted.
    let error = last_error.unwrap_or_else(|| "Daemon connection failed after retries".to_string());
    update_sidecar_supervisor(
        SidecarSupervisorState::Degraded,
        Some(generation),
        None,
        Some(error.clone()),
    );
    emit_run_stream_diagnostics(
        app,
        "reconnect-failed",
        "error",
        generation,
        &format!(
            "All {} reconnect attempts exhausted: {error}",
            MAX_RECONNECT_ATTEMPTS
        ),
        None,
    );
    Err(error)
}

/// Apply jitter to a base delay: randomize between 75%-125% of the original value.
/// Uses system time nanos as a cheap source of entropy to avoid thundering herd.
fn apply_reconnect_jitter(base_delay_ms: u64) -> u64 {
    use std::time::SystemTime;
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    let jitter_range = (base_delay_ms / 4).max(1);
    let offset = nanos % (jitter_range * 2);
    base_delay_ms.saturating_add(offset).saturating_sub(jitter_range)
}

async fn connect_sidecar_websocket(
    app: &tauri::AppHandle,
    generation: u64,
    port: u16,
) -> Result<tokio::sync::mpsc::Sender<Message>, String> {
    let ws_url = format!("ws://127.0.0.1:{}/", port);
    println!("[Sidecar][daemon.websocket] Connecting to {}", ws_url);

    let (ws_stream, _) = connect_async(&ws_url)
        .await
        .map_err(|error| format!("sidecar.daemon.websocket connect failed: {error}"))?;

    println!("[Sidecar][daemon.websocket] Connected");

    let (mut ws_write, mut ws_read) = ws_stream.split();
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Message>(100);

    let (ping_tx, mut ping_rx) = tokio::sync::mpsc::channel::<Message>(100);
    let writer_generation = generation;
    tokio::spawn(async move {
        let disconnect_reason = loop {
            tokio::select! {
                msg = rx.recv() => {
                    match msg {
                        Some(msg) => {
                            if let Err(e) = ws_write.send(msg).await {
                                let message = format!("Daemon WebSocket send error: {e}");
                                eprintln!("[Sidecar][daemon.websocket] {message}");
                                break message;
                            }
                        }
                        None => break "Daemon WebSocket command channel closed".to_string(),
                    }
                }
                msg = ping_rx.recv() => {
                    match msg {
                        Some(msg) => {
                            if let Err(e) = ws_write.send(msg).await {
                                let message = format!("Daemon WebSocket ping send error: {e}");
                                eprintln!("[Sidecar][daemon.websocket] {message}");
                                break message;
                            }
                        }
                        None => break "Daemon WebSocket heartbeat channel closed".to_string(),
                    }
                }
            }
        };
        disconnect_sidecar_generation(writer_generation, &disconnect_reason, false);
    });

    let heartbeat_tx = ping_tx.clone();
    let heartbeat_generation = generation;
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(30));
        loop {
            interval.tick().await;
            let ping_msg = Message::Text(serde_json::json!({ "type": "ping" }).to_string());
            if heartbeat_tx.send(ping_msg).await.is_err() {
                let message = "Daemon WebSocket heartbeat channel closed while queueing ping";
                eprintln!("[Sidecar][daemon.websocket] {message}");
                disconnect_sidecar_generation(heartbeat_generation, message, false);
                break;
            }
        }
    });

    let app_handle = app.clone();
    let reader_generation = generation;
    tokio::spawn(async move {
        let mut disconnect_reason = "Daemon WebSocket read loop ended".to_string();
        while let Some(msg_result) = ws_read.next().await {
            match msg_result {
                Ok(msg) => {
                    if let Message::Text(text) = &msg {
                        if let Ok(event) = serde_json::from_str::<Value>(text) {
                            let event_type = event
                                .get("type")
                                .and_then(Value::as_str)
                                .unwrap_or("unknown");

                            if resolve_pending_sidecar_response(&event) {
                                continue;
                            }

                            observe_run_stream_event(&event);

                            match event_type {
                                "error" => {
                                    eprintln!("[Sidecar][daemon.event] Error event: {}", text);
                                    let _ = app_handle.emit("workbench-run-event", &event);
                                }
                                "event" => {
                                    let _ = app_handle.emit("workbench-run-event", &event);
                                }
                                "approval-requested" => {
                                    println!("[Sidecar][daemon.event] Approval requested");
                                    let _ = app_handle.emit("workbench-approval-requested", &event);
                                    let _ = app_handle.emit("workbench-run-event", &event);
                                }
                                "approval-resolved" => {
                                    let _ = app_handle.emit("workbench-approval-resolved", &event);
                                    let _ = app_handle.emit("workbench-run-event", &event);
                                }
                                "pong" => {}
                                _ => {
                                    let _ = app_handle.emit("workbench-run-event", &event);
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    disconnect_reason = format!("Daemon WebSocket read error: {e}");
                    eprintln!("[Sidecar][daemon.websocket] {disconnect_reason}");
                    break;
                }
            }
        }
        println!("[Sidecar][daemon.websocket] Read loop ended");
        disconnect_sidecar_generation(reader_generation, &disconnect_reason, false);
    });

    Ok(tx)
}

async fn start_and_connect_sidecar(
    app: &tauri::AppHandle,
    app_dir: &Path,
    generation: u64,
) -> Result<(tokio::sync::mpsc::Sender<Message>, u16), String> {
    println!("[Sidecar][daemon.child-process] Starting daemon process...");

    let launch_plan = resolve_daemon_launch_plan(app_dir, !cfg!(debug_assertions))?;
    record_sidecar_launch_plan(&launch_plan);
    log_daemon_launch_plan(&launch_plan);

    // Build the daemon environment from the current process and stored frontend config.
    let mut sidecar_env: HashMap<String, String> = HashMap::new();
    for (key, value) in env::vars() {
        sidecar_env.insert(key, value);
    }
    // Stored frontend config wins; otherwise environment values flow through unchanged.
    let credential_mode = config::effective_credential_mode();
    sidecar_env.insert("CRISH_CREDENTIAL_MODE".to_string(), credential_mode.clone());
    if credential_mode == "account-center" {
        for key in config::api_key_env_var_names() {
            sidecar_env.remove(*key);
        }
        sidecar_env.remove("CRISH_API_KEY_SOURCE");
        sidecar_env.remove("FLOWBIT_API_KEY_SOURCE");
    } else if let Some(api_key) = config::effective_api_key() {
        sidecar_env.insert("CRISH_API_KEY".to_string(), api_key);
        sidecar_env.insert(
            "CRISH_API_KEY_SOURCE".to_string(),
            config::daemon_api_key_source().to_string(),
        );
    } else {
        eprintln!(
            "[Sidecar][daemon.config] No API key configured. Set CRISH_API_KEY, FLOWBIT_API_KEY, OPENAI_API_KEY, or save one in settings."
        );
    }
    if let Some(base_url) = config::effective_api_base_url() {
        sidecar_env.insert("CRISH_API_BASE_URL".to_string(), base_url);
    }
    if let Some(model) = config::effective_model() {
        sidecar_env.insert("CRISH_MODEL".to_string(), model);
    }
    sidecar_env.insert(
        "CRISH_PROVIDER_ENDPOINT".to_string(),
        config::effective_provider_endpoint(),
    );
    sidecar_env.insert(
        "CRISH_PROVIDER_STREAM".to_string(),
        config::effective_provider_stream().to_string(),
    );

    let mut child = Command::new(&launch_plan.launcher)
        .args(&launch_plan.args)
        .current_dir(&launch_plan.work_dir)
        .envs(&sidecar_env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            format!(
                "sidecar.daemon.child-process spawn failed: {e}\n  runtime_kind: {}\n  command: {}\n  entry_path: {}\n  selection_reason: {}\n  work_dir: {}\n  launcher_candidates:\n{}\n  entry_candidates:\n{}",
                launch_plan.mode.as_str(),
                daemon_command_summary(&launch_plan.launcher, &launch_plan.args),
                daemon_entry_summary(launch_plan.entry.as_deref()),
                launch_plan
                    .selection_reason
                    .as_deref()
                    .unwrap_or("(not applicable)"),
                launch_plan.work_dir.display(),
                format_path_candidates(&launch_plan.launcher_candidates),
                format_path_candidates(&launch_plan.entry_candidates)
            )
        })?;

    let child_pid = child.id();
    println!(
        "[Sidecar][daemon.child-process] Started daemon process (PID: {})",
        child_pid
    );
    update_sidecar_supervisor(
        SidecarSupervisorState::Starting,
        Some(generation),
        Some(child_pid),
        None,
    );

    // Read daemon stdout until the ready JSON line is found.
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "sidecar.daemon.child-process stdout capture failed".to_string())?;
    let reader = BufReader::new(stdout);
    let mut startup_stdout: Vec<String> = Vec::new();

    // The daemon must print ready JSON before this timeout or startup is failed visibly.
    let (bytes_read, mut first_line, mut reader) =
        match read_daemon_stdout_line_with_timeout(reader, "waiting for daemon ready JSON") {
            Ok(result) => result,
            Err(error) => {
                let (exit_code, stderr_msg) = collect_child_exit(&mut child, true);
                log_captured_stderr("startup read failure", &exit_code, &stderr_msg);
                return Err(daemon_startup_failure(
                    &error,
                    &launch_plan,
                    &exit_code,
                    &startup_stdout,
                    &stderr_msg,
                ));
            }
        };
    if bytes_read == 0 {
        let (exit_code, stderr_msg) = collect_child_exit(&mut child, false);
        log_captured_stderr("startup exited before ready", &exit_code, &stderr_msg);
        return Err(daemon_startup_failure(
            "process exited before ready line",
            &launch_plan,
            &exit_code,
            &startup_stdout,
            &stderr_msg,
        ));
    }

    let trimmed = first_line.trim();
    // Skip non-JSON launcher output, such as npx progress lines.
    if !trimmed.starts_with('{') {
        // Continue until the daemon emits the JSON ready line.
        loop {
            if !first_line.trim().is_empty() {
                startup_stdout.push(first_line.trim_end().to_string());
            }

            match read_daemon_stdout_line_with_timeout(reader, "waiting for daemon ready JSON") {
                Ok((0, _next_line, _next_reader)) => {
                    let (exit_code, stderr_msg) = collect_child_exit(&mut child, false);
                    log_captured_stderr(
                        "startup ended without ready JSON",
                        &exit_code,
                        &stderr_msg,
                    );
                    return Err(daemon_startup_failure(
                        "stdout ended before ready JSON",
                        &launch_plan,
                        &exit_code,
                        &startup_stdout,
                        &stderr_msg,
                    ));
                }
                Ok((_bytes_read, next_line, next_reader)) => {
                    first_line = next_line;
                    reader = next_reader;
                    if first_line.trim().starts_with('{') {
                        break;
                    }
                }
                Err(error) => {
                    let (exit_code, stderr_msg) = collect_child_exit(&mut child, true);
                    log_captured_stderr("startup read failure", &exit_code, &stderr_msg);
                    return Err(daemon_startup_failure(
                        &error,
                        &launch_plan,
                        &exit_code,
                        &startup_stdout,
                        &stderr_msg,
                    ));
                }
            }
        }
    }

    let ready_msg: Value = match serde_json::from_str(first_line.trim()) {
        Ok(value) => value,
        Err(error) => {
            startup_stdout.push(first_line.trim_end().to_string());
            let (exit_code, stderr_msg) = collect_child_exit(&mut child, true);
            log_captured_stderr("startup invalid ready JSON", &exit_code, &stderr_msg);
            return Err(daemon_startup_failure(
                &format!("ready line was not valid JSON: {error}"),
                &launch_plan,
                &exit_code,
                &startup_stdout,
                &stderr_msg,
            ));
        }
    };

    let port_value = match ready_msg
        .get("port")
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
    {
        Some(port) => port,
        None => {
            let (exit_code, stderr_msg) = collect_child_exit(&mut child, true);
            log_captured_stderr("startup missing ready port", &exit_code, &stderr_msg);
            return Err(daemon_startup_failure(
                &format!("ready JSON missing valid u16 port field: {ready_msg}"),
                &launch_plan,
                &exit_code,
                &startup_stdout,
                &stderr_msg,
            ));
        }
    };

    println!("[Sidecar][daemon.stdout] Ready on port {}", port_value);

    // ── Handshake: validate protocolVersion ──────────────────────────
    let daemon_protocol_version = ready_msg
        .get("protocolVersion")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if daemon_protocol_version != EXPECTED_DAEMON_HANDSHAKE_PROTOCOL_VERSION {
        let (exit_code, stderr_msg) = collect_child_exit(&mut child, true);
        log_captured_stderr("startup protocol version mismatch", &exit_code, &stderr_msg);
        return Err(daemon_startup_failure(
            &format!(
                "daemon handshake protocol version mismatch: expected {}, got {}. \
                 The daemon and workbench are built from different versions — \
                 restart the application to resolve this.",
                EXPECTED_DAEMON_HANDSHAKE_PROTOCOL_VERSION, daemon_protocol_version
            ),
            &launch_plan,
            &exit_code,
            &startup_stdout,
            &stderr_msg,
        ));
    }

    // ── Handshake: record buildHash ─────────────────────────────────
    let daemon_build_hash = ready_msg
        .get("buildHash")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if !daemon_build_hash.is_empty() {
        println!(
            "[Sidecar][daemon.stdout] Handshake OK — buildHash: {}",
            daemon_build_hash
        );
    } else {
        println!("[Sidecar][daemon.stdout] Handshake OK — buildHash: (not provided)");
    }

    spawn_sidecar_output_drain("daemon.stdout", reader);
    if let Some(stderr) = child.stderr.take() {
        spawn_sidecar_output_drain("daemon.stderr", BufReader::new(stderr));
    }

    // Store the child handle so stale connections can clean up the process tree.
    {
        let proc = sidecar_process().get_or_init(|| Mutex::new(None));
        let mut guard = proc.lock().map_err(|e| e.to_string())?;
        *guard = Some(child);
    }
    update_sidecar_supervisor(
        SidecarSupervisorState::Starting,
        Some(generation),
        Some(child_pid),
        None,
    );
    record_sidecar_daemon_endpoint(port_value, child_pid, daemon_build_hash.clone());
    record_sidecar_daemon_build_hash(&daemon_build_hash);

    let tx = match connect_sidecar_websocket(app, generation, port_value).await {
        Ok(sender) => sender,
        Err(error) => {
            clear_sidecar_process(true);
            return Err(error);
        }
    };

    Ok((tx, port_value))
}
