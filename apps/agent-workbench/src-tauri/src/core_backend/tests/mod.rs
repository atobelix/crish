use std::sync::Arc;

use conex_types::events::{AgentEvent, AgentEventEnvelope};

use crate::core_backend::CoreStateBackend;
use conex_run::core_event_bridge::EventBridge;
use conex_run::run::CoreRunState;

mod feature_readiness;
mod session_ops;

/// 记录型发射器（事件桥测试替身，对齐 core_run_commands 测试先例）
#[derive(Default)]
pub(super) struct RecordingEmitter(pub(super) std::sync::Mutex<Vec<String>>);

impl conex_run::core_event_bridge::Emitter for RecordingEmitter {
    fn emit(&self, _channel: &str, payload: &str) {
        self.0.lock().unwrap().push(payload.to_string());
    }
}

pub(super) fn recording_bridge() -> (EventBridge, Arc<RecordingEmitter>) {
    let emitter = Arc::new(RecordingEmitter::default());
    let bridge = EventBridge::new(
        "workbench-run-event",
        Arc::clone(&emitter) as Arc<dyn conex_run::core_event_bridge::Emitter>,
    );
    (bridge, emitter)
}

/// 从记录载荷解析 security-audit 信封（恰一条；runId 不注入——
/// 远程动作 run 创建前 / 无会话上下文）
pub(super) fn recorded_security_audit(emitter: &RecordingEmitter) -> AgentEvent {
    let recorded = emitter.0.lock().unwrap();
    assert_eq!(recorded.len(), 1, "必须恰好发射一条 security-audit");
    let envelope: AgentEventEnvelope =
        serde_json::from_str(&recorded[0]).expect("信封 JSON 可解析");
    assert_eq!(envelope.run_id, None, "runId 不注入（run 创建前/无会话）");
    envelope.event
}

/// 会话索引条目（测试会话；对齐 core_run_commands 测试先例）
pub(super) fn g5_test_session_entry(id: &str) -> conex_types::SessionIndexEntry {
    conex_types::SessionIndexEntry {
        id: id.to_string(),
        title: format!("会话 {id}"),
        folder: String::new(),
        is_pinned: false,
        is_archived: false,
        branch_parent_id: None,
        timestamp: "2026-08-05T00:00:00.000Z".to_string(),
        updated_at: 1,
        message_count: 0,
        pinned_message_ids: None,
        engine_cursor: Some(0),
        engine_last_run_id: None,
        hydrated_from_engine: Some(true),
    }
}

/// 测试用 CoreRunState（真实引擎路径——scheduler_registry 装配为
/// Some；对齐 core_run_commands 测试先例）
pub(super) fn r2_test_core_state() -> Arc<CoreRunState> {
    static R2_TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let (bridge, _emitter) = recording_bridge();
    let seq = R2_TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let db = conex_db::LocalDb::open_in_memory().expect("内存库");
    let snapshots: Arc<dyn orchestrator::restore::SnapshotStore> = Arc::new(
        orchestrator::restore::SnapshotFileStore::new(std::env::temp_dir().join(format!(
            "conex_r2_12c_{}_{seq}_snapshot.json",
            std::process::id()
        ))),
    );
    Arc::new(CoreRunState::new(
        Arc::new(orchestrator::persist::LocalDbStore::new(db)),
        snapshots,
        bridge,
        Arc::new(conex_run::status_diagnostics::StatusDiagnostics::new()),
        None,
    ))
}

/// C21 搜索后端（注入索引 + 工作区根）
pub(super) fn search_backend(files: Vec<String>, root: Option<&str>) -> CoreStateBackend {
    let state = Arc::new(crate::core_commands::SharedSearchState {
        files: std::sync::RwLock::new(Arc::new(files)),
    });
    let mut backend = CoreStateBackend::new(r2_test_core_state()).with_search_state(state);
    if let Some(root) = root {
        backend = backend.with_search_root(root.to_string());
    }
    backend
}
