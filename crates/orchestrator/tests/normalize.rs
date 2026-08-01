//! B4.5 事件归一化集成测试（05 §5.4 / B4.4 验收）
//!
//! 在 drive 全流程之上验证归一化（[orchestrator::normalize_envelope]）：
//! - runId/sessionId 注入（03 §5.3-2）：emit 前信封 runId 补齐、事件体
//!   sessionId 补齐、run-terminal 事件体 runId 补齐（03 §5.1-16）；
//! - 终态收敛（03 §5.2-2）：驱动产出的事件流中仅 run-terminal 为终态；
//! - cooperative stop（00 D1）：agent-end reason 与 run 终态一致；
//!   stopped 不触发自动续轮（[orchestrator::allows_auto_continue]）。

mod common;

use conex_types::events::RunTerminalStatus;
use conex_types::session::AgentEndReason;
use orchestrator::events::EventQueue;
use orchestrator::normalize::is_terminal_envelope;
use orchestrator::run::RunManager;
use orchestrator::{
    allows_auto_continue, is_terminal_event, normalize_envelope, terminal_status_for_end_reason,
};

use common::{agent_end, agent_start, envelope, message_delta, message_end, outcome, setup};

/// 驱动完整 run 后对每条事件做 emit 前归一化：
/// runId/sessionId 统一注入，run-terminal 事件体 runId 齐备（03 §5.3-2）
#[tokio::test]
async fn driven_events_get_run_and_session_injected() {
    let (_mem, store) = setup();
    let manager = RunManager::new(store.clone());

    let mut run = manager.start_run("sess-1", "run-9").await.unwrap();
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1);

    let result = orchestrator::events::drive_outcome(
        &mut run,
        &mut queue,
        outcome(
            AgentEndReason::Stop,
            None,
            vec![
                agent_start("sess-1"),
                message_delta("sess-1", 0),
                message_end("sess-1"),
                agent_end("sess-1", AgentEndReason::Stop),
            ],
        ),
    )
    .await
    .unwrap();

    for sequenced in &result.events {
        // emit 前归一化：信封 runId 缺失 → 用 run 标识补齐
        let normalized = normalize_envelope(
            envelope(sequenced.event.clone(), sequenced.sequence),
            Some(&run.run_id),
            &run.session_id,
        );
        assert_eq!(
            normalized.run_id.as_deref(),
            Some("run-9"),
            "信封 runId 注入（{}）",
            normalized.type_name()
        );
        assert_eq!(normalized.sequence, Some(sequenced.sequence), "sequence 保留");

        // 事件体 sessionId 已存在（drive 产出即带）→ 不被覆盖
        let session = match &normalized.event {
            conex_types::events::AgentEvent::AgentStart { session_id, .. }
            | conex_types::events::AgentEvent::AgentEnd { session_id, .. }
            | conex_types::events::AgentEvent::MessageDelta { session_id, .. }
            | conex_types::events::AgentEvent::MessageEnd { session_id, .. }
            | conex_types::events::AgentEvent::RunTerminal { session_id, .. } => session_id,
            other => panic!("未预期的驱动事件：{other:?}"),
        };
        assert_eq!(session, "sess-1", "事件体 sessionId 与 run 一致");
    }

    // 扁平 JSON 形态：顶层 runId/sessionId 齐备（03 §3.1 / §5.3-2）
    let last = &result.events.last().unwrap();
    let normalized = normalize_envelope(
        envelope(last.event.clone(), last.sequence),
        Some(&run.run_id),
        &run.session_id,
    );
    let value = serde_json::to_value(&normalized).unwrap();
    assert_eq!(value["type"], "run-terminal");
    assert_eq!(value["runId"], "run-9");
    assert_eq!(value["sessionId"], "sess-1");
    assert_eq!(value["sequence"], last.sequence);
    assert!(value.get("event").is_none(), "不得二次包装 event 键");
}

/// 终态收敛：驱动产出的事件流中仅 run-terminal 为终态事件，
/// 判据不再依赖别名（03 §5.2-2，B4.4 验收）
#[tokio::test]
async fn run_terminal_is_the_only_terminal_event_in_driven_stream() {
    let (_mem, store) = setup();
    let manager = RunManager::new(store.clone());

    let mut run = manager.start_run("s1", "r_terminal_judge").await.unwrap();
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1);

    let result = orchestrator::events::drive_outcome(
        &mut run,
        &mut queue,
        outcome(
            AgentEndReason::Stop,
            None,
            vec![
                agent_start("s1"),
                message_delta("s1", 0),
                message_end("s1"),
                agent_end("s1", AgentEndReason::Stop),
            ],
        ),
    )
    .await
    .unwrap();

    let terminal_idx = result
        .events
        .iter()
        .position(|e| is_terminal_event(&e.event))
        .expect("应有终态事件");
    assert_eq!(terminal_idx, result.events.len() - 1, "终态事件收尾");

    for (i, sequenced) in result.events.iter().enumerate() {
        let is_last = i == result.events.len() - 1;
        assert_eq!(is_terminal_event(&sequenced.event), is_last, "仅最后一条为终态");
        let env = envelope(sequenced.event.clone(), sequenced.sequence);
        assert_eq!(is_terminal_envelope(&env), is_last, "信封判据一致");
    }
}

/// cooperative stop：agent-end reason（stopped）与 run 终态一致（completed），
/// 且 stopped 不触发自动续轮（00 D1，B4.4 验收）
#[tokio::test]
async fn cooperative_stop_maps_completed_and_does_not_auto_continue() {
    let (mem, store) = setup();
    let manager = RunManager::new(store.clone());

    let mut run = manager.start_run("s1", "r_coop_normalize").await.unwrap();
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1);

    // L2 协作停止：安全点以 stopped 收场（未请求取消，run 层面即 completed）
    let result = orchestrator::events::drive_outcome(
        &mut run,
        &mut queue,
        outcome(
            AgentEndReason::Stopped,
            None,
            vec![agent_start("s1"), agent_end("s1", AgentEndReason::Stopped)],
        ),
    )
    .await
    .unwrap();

    // agent-end reason 与 run 终态一致（00 D1 / B4.4 验收）
    assert_eq!(
        terminal_status_for_end_reason(AgentEndReason::Stopped),
        RunTerminalStatus::Completed
    );
    assert_eq!(result.terminal_status, RunTerminalStatus::Completed);
    assert_eq!(result.end_reason, "stop");
    assert_eq!(run.status, conex_db::RunStatus::Completed);

    // cooperative stop 不触发自动续轮；仅自然 stop 可评估续轮
    assert!(allows_auto_continue(AgentEndReason::Stop), "自然完成可评估续轮");
    assert!(!allows_auto_continue(AgentEndReason::Stopped), "stopped 不续轮（D1）");
    assert!(!allows_auto_continue(AgentEndReason::MaxTurns), "预算耗尽不续轮");
    assert!(!allows_auto_continue(AgentEndReason::Aborted), "取消不续轮");
    assert!(!allows_auto_continue(AgentEndReason::Error), "失败不续轮");

    // 落库终态为 completed（stopped 非取消非错误）
    assert_eq!(mem.runs()[0].status, conex_db::RunStatus::Completed);
    assert_eq!(mem.runs()[0].end_reason.as_deref(), Some("stop"));
}

/// run-terminal 事件体 runId 缺失时经归一化补齐（03 §5.1-16 硬依赖）
#[tokio::test]
async fn run_terminal_body_run_id_filled_by_normalization() {
    // 构造 runId 缺失的 run-terminal 事件（模拟 runtime 侧未填充的终态）
    let terminal = conex_types::events::AgentEvent::RunTerminal {
        session_id: "s1".to_string(),
        run_id: String::new(),
        timestamp: common::TS.into(),
        terminal: RunTerminalStatus::Completed,
        error: None,
    };
    let normalized = normalize_envelope(envelope(terminal, 7), Some("run-9"), "s1");
    match &normalized.event {
        conex_types::events::AgentEvent::RunTerminal { run_id, .. } => {
            assert_eq!(run_id, "run-9", "终态事件体 runId 补齐");
        }
        other => panic!("事件类型不符：{other:?}"),
    }
    assert_eq!(normalized.run_id.as_deref(), Some("run-9"), "信封同步注入");
}

/// 终态与 reason 双向映射（归一化逆映射，事件重放/投影恢复用）
#[test]
fn terminal_reason_mapping_roundtrip() {
    use conex_types::session::AgentEndReason as R;
    use orchestrator::normalize::end_reason_for_terminal;
    use orchestrator::run::map_outcome_to_terminal;

    // 未取消时：agent-end reason → run 终态 + 落库 end_reason
    assert_eq!(
        map_outcome_to_terminal(false, R::Stop),
        (RunTerminalStatus::Completed, "stop")
    );
    assert_eq!(
        map_outcome_to_terminal(false, R::MaxTurns),
        (RunTerminalStatus::Failed, "max-turns"),
        "max-turns 以 failed 收场"
    );

    // 已取消（L2/L3）：一律 cancelled（end_reason=aborted，05 §2.8）
    assert_eq!(
        map_outcome_to_terminal(true, R::Stop),
        (RunTerminalStatus::Cancelled, "aborted")
    );

    // 终态 ↔ reason 逆映射往返
    for terminal in [
        RunTerminalStatus::Completed,
        RunTerminalStatus::Cancelled,
        RunTerminalStatus::Failed,
    ] {
        assert_eq!(
            terminal_status_for_end_reason(end_reason_for_terminal(terminal)),
            terminal,
            "逆映射往返：{terminal:?}"
        );
    }
}
