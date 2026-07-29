use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::collections::HashMap;
use std::env;
use std::io::BufReader;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Emitter;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing as log;

#[cfg(windows)]
use std::os::windows::io::AsRawHandle;

use super::disconnect::{active_sidecar_daemon_endpoint, disconnect_sidecar_generation, record_sidecar_daemon_endpoint};
use super::helpers::cached_sidecar_sender_or_disconnect;
use super::process_mgmt::{clear_sidecar_process, collect_child_exit, daemon_startup_failure, log_captured_stderr, read_daemon_stdout_line_with_timeout, spawn_sidecar_output_drain};
use super::super::pending::*;
use super::super::run_stream::*;
use super::super::supervisor::*;
use super::super::types::*;
use crate::{config, daemon_discovery::*, process};

const EXPECTED_DAEMON_HANDSHAKE_PROTOCOL_VERSION: u64 = 1;

pub(crate) async fn ensure_sidecar_connected(
    app: &tauri::AppHandle,
    app_dir: &std::path::Path,
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
            if active_sidecar_daemon_endpoint().is_none() {
                clear_sidecar_process(true);
            }
        }

        let sender = if let Some(endpoint) = active_sidecar_daemon_endpoint() {
            eprintln!(
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

        {
            let conn = sidecar_connection().get_or_init(|| Mutex::new(None));
            let mut guard = conn.lock().map_err(|e| format!("{e}"))?;
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

fn apply_reconnect_jitter(base_delay_ms: u64) -> u64 {
    use std::time::SystemTime;
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    // Mix in PID to decorrelate concurrent processes
    let pid_mix = std::process::id() as u64;
    let entropy = nanos ^ (pid_mix.wrapping_mul(2654435761));
    let jitter_range = (base_delay_ms / 4).max(1);
    let offset = entropy % (jitter_range * 2);
    base_delay_ms.saturating_add(offset).saturating_sub(jitter_range)
}

async fn connect_sidecar_websocket(
    app: &tauri::AppHandle,
    generation: u64,
    port: u16,
) -> Result<tokio::sync::mpsc::Sender<Message>, String> {
    let ws_url = format!("ws://127.0.0.1:{}/", port);
    eprintln!("[Sidecar][daemon.websocket] Connecting to {}", ws_url);

    let (ws_stream, _) = connect_async(&ws_url)
        .await
        .map_err(|error| format!("sidecar.daemon.websocket connect failed: {error}"))?;

    eprintln!("[Sidecar][daemon.websocket] Connected");

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
            // Generation guard: stop processing if a newer connection superseded this one
            let is_current = sidecar_connection().get()
                .and_then(|conn| conn.lock().ok())
                .map(|guard| guard.as_ref().is_some_and(|c| c.generation == reader_generation))
                .unwrap_or(false);
            if !is_current {
                eprintln!(
                    "[Sidecar][daemon.websocket] Reader for generation {reader_generation} stopping: superseded by newer connection"
                );
                return; // Exit silently — newer generation owns the event stream
            }

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
                                    eprintln!("[Sidecar][daemon.event] Approval requested");
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
        eprintln!("[Sidecar][daemon.websocket] Read loop ended");
        disconnect_sidecar_generation(reader_generation, &disconnect_reason, false);
    });

    Ok(tx)
}

async fn start_and_connect_sidecar(
    app: &tauri::AppHandle,
    app_dir: &std::path::Path,
    generation: u64,
) -> Result<(tokio::sync::mpsc::Sender<Message>, u16), String> {
    eprintln!("[Sidecar][daemon.child-process] Starting daemon process...");

    let launch_plan = resolve_daemon_launch_plan(app_dir, !cfg!(debug_assertions))?;
    record_sidecar_launch_plan(&launch_plan);
    log_daemon_launch_plan(&launch_plan);

    let mut sidecar_env: HashMap<String, String> = HashMap::new();
    for (key, value) in env::vars() {
        sidecar_env.insert(key, value);
    }
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
    eprintln!(
        "[Sidecar][daemon.child-process] Started daemon process (PID: {})",
        child_pid
    );
    update_sidecar_supervisor(
        SidecarSupervisorState::Starting,
        Some(generation),
        Some(child_pid),
        None,
    );

    // B4: attach child to job object for orphan process protection
    #[cfg(windows)]
    {
        if let Err(e) = process::init_daemon_job_object() {
            log::warn!("[Sidecar] Failed to initialize daemon job object: {e}");
        }
        if let Err(e) = process::assign_child_to_daemon_job_object(child.as_raw_handle()) {
            log::warn!("[Sidecar] Failed to assign child to daemon job object: {e}");
        }
    }
    #[cfg(not(windows))]
    {
        if let Err(e) = process::set_child_process_group(child.id()) {
            log::warn!("[Sidecar] Failed to set child process group: {e}");
        }
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "sidecar.daemon.child-process stdout capture failed".to_string())?;
    let reader = BufReader::new(stdout);
    let mut startup_stdout: Vec<String> = Vec::new();
    const MAX_STARTUP_LINES: usize = 50; // Prevent unbounded memory growth from noisy daemon output

    let result = read_daemon_stdout_line_with_timeout(reader, "waiting for daemon ready JSON");
    let (bytes_read, mut first_line, mut reader): (usize, String, BufReader<_>) = match result {
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
    if !trimmed.starts_with('{') {
        loop {
            if !first_line.trim().is_empty() && startup_stdout.len() < MAX_STARTUP_LINES {
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

    eprintln!("[Sidecar][daemon.stdout] Ready on port {}", port_value);

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

    let daemon_build_hash = ready_msg
        .get("buildHash")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if !daemon_build_hash.is_empty() {
        eprintln!(
            "[Sidecar][daemon.stdout] Handshake OK — buildHash: {}",
            daemon_build_hash
        );
    } else {
        eprintln!("[Sidecar][daemon.stdout] Handshake OK — buildHash: (not provided)");
    }

    spawn_sidecar_output_drain("daemon.stdout", reader);
    if let Some(stderr) = child.stderr.take() {
        spawn_sidecar_output_drain("daemon.stderr", BufReader::new(stderr));
    }

    {
        let proc = sidecar_process().get_or_init(|| Mutex::new(None));
        let mut guard = proc.lock().map_err(|e| format!("{e}"))?;
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
