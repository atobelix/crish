use std::io::{BufRead, BufReader, Read};
use std::time::Duration;

use crate::daemon_discovery::*;
use crate::process;
use super::super::pending::reject_all_pending_sidecar_responses;
use super::super::supervisor::*;
use super::super::types::*;

pub(crate) fn clear_sidecar_process(kill_child: bool) {
    if kill_child {
        clear_sidecar_daemon_endpoint();
    }

    let proc_store = sidecar_process().get();
    let mut maybe_child = None;
    if let Some(store) = proc_store {
        if let Ok(mut guard) = store.lock() {
            maybe_child = guard.take();
        }
    }

    if let Some(mut child) = maybe_child {
        let pid = child.id();
        if kill_child {
            eprintln!(
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

fn clear_sidecar_daemon_endpoint() {
    if let Some(endpoint) = sidecar_daemon_endpoint().get() {
        if let Ok(mut guard) = endpoint.lock() {
            *guard = None;
        }
    }
}

pub(crate) fn read_daemon_stdout_line_with_timeout<R>(
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

pub(crate) fn collect_child_exit(
    child: &mut std::process::Child,
    kill_first: bool,
) -> (String, String) {
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

pub(crate) fn log_captured_stderr(context: &str, exit_code: &str, stderr: &str) {
    eprintln!("[Sidecar][daemon.stderr] === {context} START ===");
    if stderr.trim().is_empty() {
        eprintln!("(empty)");
    } else {
        eprintln!("{}", stderr.trim_end());
    }
    eprintln!("[Sidecar][daemon.stderr] === {context} END (exit_code: {exit_code}) ===");
}

pub(crate) fn daemon_startup_failure(
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

pub(crate) fn spawn_sidecar_output_drain<R>(label: &'static str, mut reader: BufReader<R>)
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
