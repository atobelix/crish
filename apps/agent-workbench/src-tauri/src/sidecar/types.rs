use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
};

use crate::process;

// ==================== Type Definitions ====================

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkbenchCancelRunResult {
    pub ok: bool,
    pub run_id: String,
    pub pid: Option<u32>,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SidecarSupervisorSnapshot {
    pub state: SidecarSupervisorState,
    pub generation: Option<u64>,
    pub pid: Option<u32>,
    pub pending_responses: usize,
    pub recent_diagnostics: Vec<SidecarCommandDiagnostic>,
    pub launch: Option<SidecarLaunchSnapshot>,
    pub last_error: Option<String>,
    pub last_disconnect: Option<SidecarDisconnectSnapshot>,
    pub disconnect_count: u64,
    /** 当前重连周期的第几次尝试（0-based，失败后递增） */
    pub reconnect_retry_count: u32,
    /** 最近一次重连失败的详细错误 */
    pub last_reconnect_error: Option<String>,
    pub last_reconnect_attempt: Option<String>,
    pub last_transition_at: String,
    /** Daemon build hash from the ready-line handshake. */
    pub daemon_build_hash: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SidecarLaunchSnapshot {
    pub runtime_kind: String,
    pub command: String,
    pub entry_path: String,
    pub selection_reason: Option<String>,
    pub work_dir: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SidecarDisconnectSnapshot {
    pub generation: u64,
    pub message: String,
    pub rejected_pending_responses: usize,
    pub disconnected_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SidecarCommandDiagnostic {
    pub request_id: String,
    pub command_type: String,
    pub command_size_bytes: usize,
    pub key_field: Option<String>,
    pub started_at: String,
    pub duration_ms: u64,
    pub status: SidecarCommandDiagnosticStatus,
    pub error: Option<SidecarCommandErrorDiagnostic>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SidecarCommandDiagnosticStatus {
    Ok,
    Error,
    Disconnected,
    Timeout,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SidecarCommandErrorDiagnostic {
    pub layer: String,
    pub code: Option<String>,
    pub message: String,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SidecarSupervisorState {
    Stopped,
    Starting,
    Ready,
    Degraded,
    Stopping,
}

pub(crate) struct SidecarConnection {
    pub generation: u64,
    pub writer: tokio::sync::mpsc::Sender<tokio_tungstenite::tungstenite::Message>,
}

#[derive(Clone)]
pub(crate) struct SidecarSender {
    pub generation: u64,
    pub writer: tokio::sync::mpsc::Sender<tokio_tungstenite::tungstenite::Message>,
}

#[derive(Clone, Debug)]
pub(crate) struct SidecarDaemonEndpoint {
    pub port: u16,
    pub pid: u32,
    pub build_hash: String,
}

pub(crate) struct PendingSidecarResponse {
    pub id: u64,
    pub request_id: String,
    pub expected_type: String,
    pub command_type: String,
    pub command_size_bytes: usize,
    pub started_at_ms: u128,
    pub key_field: Option<String>,
    pub key_value: Option<String>,
    pub context: String,
    pub sender: tokio::sync::oneshot::Sender<Result<Value, String>>,
}

#[derive(Clone, Debug)]
pub(crate) struct RunStreamRecoveryState {
    pub run_id: String,
    pub session_id: Option<String>,
    pub last_cursor: Option<RunEventReplayCursor>,
    pub started_at_ms: u128,
    pub last_observed_at_ms: u128,
    pub disconnected_generation: Option<u64>,
    pub disconnected_at_ms: Option<u128>,
    pub disconnect_message: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunEventReplayCursor {
    pub event_log_id: String,
    pub generation: u64,
    pub schema_version: u64,
    pub protocol_version: u64,
    pub after_sequence: u64,
    pub last_event_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunStreamRecoveryDiagnostic {
    pub code: &'static str,
    pub severity: &'static str,
    pub run_id: String,
    pub session_id: Option<String>,
    pub message: String,
    pub cursor: Option<RunEventReplayCursor>,
    pub replayed_events: Option<usize>,
    pub generation: Option<u64>,
    pub disconnected_at: String,
}

// ==================== Global Statics ====================

static SIDECAR: OnceLock<Mutex<Option<SidecarConnection>>> = OnceLock::new();
static SIDECAR_PROCESS: OnceLock<Mutex<Option<std::process::Child>>> = OnceLock::new();
static SIDECAR_DAEMON_ENDPOINT: OnceLock<Mutex<Option<SidecarDaemonEndpoint>>> = OnceLock::new();
static SIDECAR_PENDING_RESPONSES: OnceLock<Mutex<VecDeque<PendingSidecarResponse>>> =
    OnceLock::new();
static SIDECAR_STARTUP: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
static SIDECAR_SUPERVISOR: OnceLock<Mutex<SidecarSupervisorSnapshot>> = OnceLock::new();
static SIDECAR_RUN_STREAMS: OnceLock<Mutex<HashMap<String, RunStreamRecoveryState>>> =
    OnceLock::new();
static SIDECAR_PENDING_RESPONSE_ID: AtomicU64 = AtomicU64::new(1);
static SIDECAR_COMMAND_ID: AtomicU64 = AtomicU64::new(1);
static SIDECAR_CONNECTION_GENERATION: AtomicU64 = AtomicU64::new(1);

// ==================== Constants ====================

pub(crate) const SIDECAR_DISCONNECTED_PREFIX: &str = "Sidecar disconnected: ";
pub(crate) const DAEMON_READY_TIMEOUT_SECS: u64 = 45;
pub(crate) const SIDECAR_RECENT_DIAGNOSTICS_LIMIT: usize = 32;
pub(crate) const SIDECAR_ERROR_MESSAGE_LIMIT: usize = 240;
pub(crate) const RUN_STREAM_REPLAY_PAGE_SIZE: u64 = 500;
pub(crate) const RUN_STREAM_REPLAY_POLL_INTERVAL_SECS: u64 = 2;
pub(crate) const RUN_STREAM_REPLAY_IDLE_LIMIT: usize = 900;
pub(crate) const MAX_RECONNECT_ATTEMPTS: u32 = 5;
pub(crate) const BASE_RECONNECT_DELAY_MS: u64 = 1000;
pub(crate) const MAX_RECONNECT_DELAY_MS: u64 = 15_000;

// ==================== Static Accessors ====================

pub(crate) fn sidecar_connection() -> &'static OnceLock<Mutex<Option<SidecarConnection>>> {
    &SIDECAR
}

pub(crate) fn sidecar_process() -> &'static OnceLock<Mutex<Option<std::process::Child>>> {
    &SIDECAR_PROCESS
}

pub(crate) fn sidecar_daemon_endpoint() -> &'static OnceLock<Mutex<Option<SidecarDaemonEndpoint>>> {
    &SIDECAR_DAEMON_ENDPOINT
}

pub(crate) fn pending_sidecar_responses() -> &'static Mutex<VecDeque<PendingSidecarResponse>> {
    SIDECAR_PENDING_RESPONSES.get_or_init(|| Mutex::new(VecDeque::new()))
}

pub(crate) fn sidecar_startup_lock() -> &'static tokio::sync::Mutex<()> {
    SIDECAR_STARTUP.get_or_init(|| tokio::sync::Mutex::new(()))
}

pub(crate) fn sidecar_supervisor() -> &'static OnceLock<Mutex<SidecarSupervisorSnapshot>> {
    &SIDECAR_SUPERVISOR
}

pub(crate) fn sidecar_run_streams() -> &'static Mutex<HashMap<String, RunStreamRecoveryState>> {
    SIDECAR_RUN_STREAMS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn next_pending_response_id() -> u64 {
    SIDECAR_PENDING_RESPONSE_ID.fetch_add(1, Ordering::Relaxed)
}

pub(crate) fn next_command_id() -> u64 {
    SIDECAR_COMMAND_ID.fetch_add(1, Ordering::Relaxed)
}

pub(crate) fn next_connection_generation() -> u64 {
    SIDECAR_CONNECTION_GENERATION.fetch_add(1, Ordering::Relaxed)
}

// ==================== Default Supervisor Snapshot ====================

pub(crate) fn default_supervisor_snapshot() -> SidecarSupervisorSnapshot {
    SidecarSupervisorSnapshot {
        state: SidecarSupervisorState::Stopped,
        generation: None,
        pid: None,
        pending_responses: 0,
        recent_diagnostics: Vec::new(),
        launch: None,
        last_error: None,
        last_disconnect: None,
        disconnect_count: 0,
        reconnect_retry_count: 0,
        last_reconnect_error: None,
        last_reconnect_attempt: None,
        last_transition_at: process::now_millis().to_string(),
        daemon_build_hash: None,
    }
}

// ==================== State Initialization ====================

pub(crate) fn init_state() {
    let _ = SIDECAR.get_or_init(|| Mutex::new(None));
    let _ = SIDECAR_PROCESS.get_or_init(|| Mutex::new(None));
    let _ = SIDECAR_DAEMON_ENDPOINT.get_or_init(|| Mutex::new(None));
    let _ = SIDECAR_PENDING_RESPONSES.get_or_init(|| Mutex::new(VecDeque::new()));
    let _ = SIDECAR_STARTUP.get_or_init(|| tokio::sync::Mutex::new(()));
    let _ = SIDECAR_RUN_STREAMS.get_or_init(|| Mutex::new(HashMap::new()));
    let _ = SIDECAR_SUPERVISOR.get_or_init(|| Mutex::new(default_supervisor_snapshot()));
}
