//! 撤回命令测试（R6 收口 · 黄项 6：K2 撤回 → kill_all 级联集成测试）
//!
//! 接线：`retraction_commands.rs` 内 `#[cfg(test)] #[path = "retraction_commands_tests.rs"]
//! mod tests;`（对齐 SR-01 测外置惯例）。
//!
//! 覆盖（详案 §5.3 K2 达成标准——撤回命令 stop 收敛路径触发 kill_all 时）：
//! - **事件层 cancelled 为准**（K1 决策 7）：L3 强停意图以
//!   `retraction:<boundary_seq>` reason 投递到控制总线（事件层取消语义的
//!   输入面）；kill_all 直发 `subagent-ended(status=cancelled)` 事件落库；
//!   run 句柄终态 cancelled（撤回协议在取消语义上收敛）；
//! - **行语义不回归**：`session_agents` row 归一 `failed` + ended_at 补齐
//!   （与 lifecycle 底座测试 `kill_all_delivers_force_cancel_and_normalizes_rows`
//!   同断言口径——双写差异正是 K1 记录的已知约定，本测试锁定撤回路径不改
//!   行归一）；
//! - timeline-truncate 落库 sequence == boundary_seq + 1（只追加不变量）。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use conex_db::{LocalDb, RunStatus};
use conex_types::events::{AgentEvent, AgentEventEnvelope};
use conex_types::message::{AgentMessage, AgentMessageRole};
use conex_types::SessionIndexEntry;
use orchestrator::events::EventQueue;
use orchestrator::persist::LocalDbStore;
use orchestrator::restore::{SnapshotFileStore, SnapshotStore};
use orchestrator::run::RunHandle;
use session_loop::{AbortSignal, ControlBus};

use crate::core_event_bridge::{Emitter, EventBridge};
use crate::core_run_commands::{ActiveRun, ApprovalGateImpl, CoreRunState};
use crate::engine::BufferedRunEventBridge;
use crate::status_diagnostics::StatusDiagnostics;

use super::*;

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// 测试会话条目（对齐 core_run_commands_tests.rs `subagent_test_session_entry` 口径）
fn session_entry(id: &str) -> SessionIndexEntry {
    SessionIndexEntry {
        id: id.to_string(),
        title: format!("会话 {id}"),
        folder: String::new(),
        is_pinned: false,
        is_archived: false,
        branch_parent_id: None,
        timestamp: "2026-08-16T00:00:00.000Z".to_string(),
        updated_at: 1,
        message_count: 0,
        pinned_message_ids: None,
        engine_cursor: Some(0),
        engine_last_run_id: None,
        hydrated_from_engine: Some(true),
    }
}

/// 记录型事件桥（对齐 recording_bridge 替身；本测试不消费载荷，仅满足
/// EventBridge 构造）
struct RecordingEmitter(Mutex<Vec<String>>);

impl Emitter for RecordingEmitter {
    fn emit(&self, _channel: &str, payload: &str) {
        self.0.lock().unwrap().push(payload.to_string());
    }
}

/// 最小集成装配：LocalDbStore 状态 + 记录型事件桥（无 provider——撤回
/// 命令不发起 AI 请求）
fn test_state() -> (Arc<CoreRunState>, LocalDb) {
    let db = LocalDb::open_in_memory().expect("内存库");
    db.upsert_session_entry(&session_entry("s1"))
        .expect("会话条目");
    let emitter = Arc::new(RecordingEmitter(Mutex::new(Vec::new())));
    let bridge = EventBridge::new(
        "workbench-run-event",
        emitter as Arc<dyn Emitter>,
    );
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let snapshots: Arc<dyn SnapshotStore> = Arc::new(
        SnapshotFileStore::new(std::env::temp_dir().join(format!(
            "conex_retract_{}_{seq}_snapshot.json",
            std::process::id()
        ))),
    );
    let state = Arc::new(CoreRunState::new(
        Arc::new(LocalDbStore::new(db.clone())),
        snapshots,
        bridge,
        Arc::new(StatusDiagnostics::new()),
        None,
    ));
    (state, db)
}

/// 最小活动 run（对齐 build_active_run 形状；句柄以 **Cancelled 终态起态**
/// + end_reason=cancelled——固定「事件层 cancelled 为准」的生产真值面：
/// 撤回协议 wait_converged 立即成立，收敛语义在取消终态上闭合）
async fn build_cancelled_active_run(
    state: &Arc<CoreRunState>,
    session_id: &str,
    run_id: &str,
) -> Arc<ActiveRun> {
    let handle = Arc::new(tokio::sync::Mutex::new(RunHandle::new(
        run_id,
        session_id,
        RunStatus::Cancelled,
    )));
    {
        let mut h = handle.lock().await;
        h.end_reason = Some("cancelled".to_string());
    }
    let queue = Arc::new(tokio::sync::Mutex::new(EventQueue::new(
        state.store.clone(),
        0,
        None,
    )));
    let bridge = Arc::new(BufferedRunEventBridge::new(
        state.bridge.clone(),
        run_id.to_string(),
    ));
    let broadcast_bridge = Arc::clone(&bridge);
    let broadcast_run_id = run_id.to_string();
    let broadcast = Box::new(move |event: AgentEvent| {
        let envelope = AgentEventEnvelope::new(event, Some(broadcast_run_id.clone()), None);
        broadcast_bridge.emit(&envelope);
        broadcast_bridge.flush();
    });
    let approval = Arc::new(ApprovalGateImpl::new(
        run_id.to_string(),
        session_id.to_string(),
        None,
        broadcast,
        Arc::clone(&handle),
        state.store.clone(),
        None,
    ));
    Arc::new(ActiveRun {
        session_id: session_id.to_string(),
        run_id: run_id.to_string(),
        handle,
        queue,
        control_bus: Arc::new(Mutex::new(ControlBus::new())),
        abort_signal: AbortSignal::new(),
        approval,
        bridge,
        delta_sink_active: true,
        driver: Mutex::new(None),
        user_touched: AtomicBool::new(false),
        subagent: None,
        audit_persist: Mutex::new(None),
    })
}

/// K2：撤回命令（stop 收敛路径）触发 kill_all——事件层 cancelled 为准、
/// 行语义不回归（详案 §5.3 K2 / §1.3）
#[tokio::test]
async fn retract_impl_stop_run_cascades_kill_all_cancelled_event_layer_rows_normalized() {
    let (state, db) = test_state();
    state.run_restore().await;

    // ① 定位面：落库一条 message-start（target=msg-user-1，seq=1）——
    //    resolve_boundary_seq 反查的边界事实
    let boundary_seq = {
        let seq = db.reserve_sequence("s1").expect("取号");
        let message = AgentMessage {
            id: "msg-user-1".into(),
            role: AgentMessageRole::User,
            created_at: "2026-08-16T00:00:00.000Z".into(),
            blocks: vec![],
            metadata: None,
            client_message_id: None,
            content: Some("撤回我".into()),
        };
        let event = AgentEvent::MessageStart {
            session_id: "s1".into(),
            message: Arc::new(message),
        };
        let payload = serde_json::to_string(&AgentEventEnvelope::new(
            event,
            Some("run-main".into()),
            None,
        ))
        .expect("信封序列化");
        db.append_event("s1", seq, "message-start", &payload, Some("run-main"))
            .expect("message-start 落库");
        seq as u64
    };
    assert_eq!(boundary_seq, 1, "首条事件 seq=1");

    // ② 行面：running 子代理行（kill_all 归一目标）
    let sub_run_id = "run-sub-k2";
    let mut rows = db.load_session_agents("s1").expect("读取子代理行");
    rows.push(conex_types::SessionAgent {
        id: "sub-k2".into(),
        subagent_run_id: sub_run_id.into(),
        parent_session_id: "s1".into(),
        parent_run_id: "run-main".into(),
        parent_tool_call_id: None,
        description: String::new(),
        mode: "research".into(),
        status: "running".into(),
        summary: None,
        messages: Vec::new(),
        started_at: 1,
        ended_at: None,
        depth: Some(1),
        subagent_path_json: None,
        task_type: None,
        display_label: None,
        allowed_write_paths_json: None,
        sub_session_id: None,
    });
    db.save_session_agents("s1", &rows).expect("子代理行落库");

    // ③ 活动 run（子代理 run 挂 active_runs——stop_run 投 L3 的目标）
    let active = build_cancelled_active_run(&state, "s1", sub_run_id).await;
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(sub_run_id.to_string(), Arc::clone(&active));

    // ④ 撤回命令（六步：定位 → 停 run → 收敛 → 冻结 → truncate → 回滚）
    let resp = retract_impl(&state, "s1", "msg-user-1")
        .await
        .expect("撤回命令成功");
    // 冻结边界 = 收敛点 MAX(sequence)：message-start(1) + stop_run 期间
    // kill_all 直发 subagent-ended(2) 均计入——撤离/收场事件在冻结读点前
    // 落库，边界含收场事件；前端投影按 targetMessageId 截断不受影响。
    assert_eq!(
        resp.boundary_seq,
        2,
        "冻结边界 = 收敛点 MAX（message-start 1 + kill_all 直发 subagent-ended 2）"
    );
    assert_eq!(
        resp.truncate_sequence,
        resp.boundary_seq + 1,
        "TimelineTruncate 占 boundary+1（只追加不变量）"
    );
    assert_eq!(resp.run_id, sub_run_id, "被收场 run = 活动子代理 run");
    assert_eq!(resp.target_message_id, "msg-user-1");
    assert_eq!(resp.rollback.restored, 0, "无边界后写路径 → 回滚空跑");

    // ⑤ 事件层 cancelled 为准（K1 决策 7）：
    //    5a. stop_run 向控制总线投递 L3 强停（reason 携带撤回边界），
    //        kill_all 级联经 ForceCancelSink 向同一 run 投递第二条 L3
    //        （reason=`subagent_force_cancel:<run_id>`）——两条意图即
    //        「撤回 stop 路径 + 子代理级联停止」的完整输入面
    let intents = active
        .control_bus
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .drain();
    let reasons: Vec<Option<String>> = intents.iter().map(|i| i.reason.clone()).collect();
    assert!(
        reasons
            .iter()
            .any(|r| r.as_deref() == Some("retraction:1")),
        "stop_run 的 L3 意图必须携带定位边界（resolve_boundary_seq 结果 = message-start seq 1；冻结 MAX=2 含 kill_all 直发事件）：{reasons:?}"
    );
    assert!(
        reasons
            .iter()
            .any(|r| r.as_deref() == Some("subagent_force_cancel:run-sub-k2")),
        "kill_all 级联 L3 意图在案（ForceCancelSink 同一控制总线）：{reasons:?}"
    );
    //    5b. run 句柄终态 cancelled（撤回协议在取消语义上收敛）
    let handle = active.handle.lock().await;
    assert!(handle.is_terminal(), "撤回收敛路径 run 必须终态");
    assert_eq!(
        handle.end_reason.as_deref(),
        Some("cancelled"),
        "事件层以 cancelled 为准"
    );
    drop(handle);

    // ⑥ 行语义不回归：kill_all 直发 subagent-ended(cancelled) 事件 + 行归一
    //    failed（双写约定——事件层 cancelled / 行 failed 并存即 K1 记录面）
    let events = db.query_events("s1", 0, Some(50)).expect("事件查询");
    let ended = events
        .iter()
        .find(|e| e.event_type == "subagent-ended")
        .expect("kill_all 必须直发 subagent-ended");
    let ended_v: serde_json::Value =
        serde_json::from_str(&ended.payload).expect("subagent-ended 载荷 JSON");
    assert_eq!(
        ended_v["status"], "cancelled",
        "事件流 subagent-ended 以 cancelled 为准（K1 决策 7）"
    );
    let rows = db.load_session_agents("s1").expect("读取子代理行");
    let row = rows
        .iter()
        .find(|r| r.subagent_run_id == sub_run_id)
        .expect("子代理行在案");
    assert_eq!(row.status, "failed", "kill_all 行归一 failed（已知双写约定）");
    assert!(row.ended_at.is_some(), "ended_at 补齐");

    // ⑦ timeline-truncate 落库（sequence == boundary+1；只追加不变量）
    let truncate = events
        .iter()
        .find(|e| e.event_type == "timeline-truncate")
        .expect("timeline-truncate 必须落库");
    assert_eq!(truncate.sequence as u64, resp.truncate_sequence);
    let truncate_v: serde_json::Value =
        serde_json::from_str(&truncate.payload).expect("truncate 载荷 JSON");
    assert_eq!(truncate_v["type"], "timeline-truncate");
    assert_eq!(truncate_v["boundarySeq"], resp.boundary_seq as u64);
    assert_eq!(truncate_v["targetMessageId"], "msg-user-1");
}

/// K2 边界：撤回目标不可定位 → fail-closed 不冻结、不触发 kill_all、
/// 不落 truncate（NotFound；行语义不动）
#[tokio::test]
async fn retract_impl_missing_target_fails_closed_without_kill_all() {
    let (state, db) = test_state();
    state.run_restore().await;

    let sub_run_id = "run-sub-ghost";
    let mut rows = db.load_session_agents("s1").expect("读取子代理行");
    rows.push(conex_types::SessionAgent {
        id: "sub-ghost".into(),
        subagent_run_id: sub_run_id.into(),
        parent_session_id: "s1".into(),
        parent_run_id: "run-main".into(),
        parent_tool_call_id: None,
        description: String::new(),
        mode: "research".into(),
        status: "running".into(),
        summary: None,
        messages: Vec::new(),
        started_at: 1,
        ended_at: None,
        depth: Some(1),
        subagent_path_json: None,
        task_type: None,
        display_label: None,
        allowed_write_paths_json: None,
        sub_session_id: None,
    });
    db.save_session_agents("s1", &rows).expect("子代理行落库");
    let active = build_cancelled_active_run(&state, "s1", sub_run_id).await;
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(sub_run_id.to_string(), Arc::clone(&active));

    let err = retract_impl(&state, "s1", "msg-no-such")
        .await
        .expect_err("目标不存在必须 NotFound（fail-closed）");
    assert!(
        matches!(err, CoreError::NotFound(_)),
        "NotFound 语义透传：{err:?}"
    );

    // 未触发 kill_all：L3 总线零意图、行保持 running、无 truncate 落库
    let intents = active
        .control_bus
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .drain();
    assert!(intents.is_empty(), "fail-closed 不得投 L3");
    let rows = db.load_session_agents("s1").expect("读取子代理行");
    assert_eq!(rows[0].status, "running", "行语义不动");
    let events = db.query_events("s1", 0, Some(50)).expect("事件查询");
    assert!(
        events.iter().all(|e| e.event_type != "timeline-truncate"),
        "无 truncate 落库（未进入冻结）"
    );
}
