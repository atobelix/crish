use super::*;

// ── M14（I7 事件源补齐）：session.start/end 映射 + subagent-event 分流 ──

/// session.start/end 事件源 = run 生命周期既有点位（映射而非重复发射）：
/// - session.start ← agent-start（session-loop loop/mod.rs run 启动发射，
///   本域经 drive_outcome 入队）；
/// - session.end ← run-terminal（唯一终态事件，只发一次）。
///
/// 断言：一次 run 生命周期恰好发射一个 agent-start 与一个 run-terminal，
/// 无重复发射（避免双发）。
#[tokio::test]
async fn session_start_end_map_to_run_lifecycle_without_duplication() {
    let (mem, store) = setup();
    let manager = RunManager::new(store.clone());
    let mut run = manager.start_run("s1", "r_session_map").await.unwrap();
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

    let result = drive_outcome(
        &mut run,
        &mut queue,
        outcome(
            AgentEndReason::Stop,
            vec![agent_start(), agent_end(AgentEndReason::Stop)],
        ),
    )
    .await
    .unwrap();

    let starts = result
        .events
        .iter()
        .filter(|e| matches!(e.event, AgentEvent::AgentStart { .. }))
        .count();
    let terminals = result
        .events
        .iter()
        .filter(|e| matches!(e.event, AgentEvent::RunTerminal { .. }))
        .count();
    assert_eq!(starts, 1, "agent-start（session.start 源）只发一次");
    assert_eq!(terminals, 1, "run-terminal（session.end 源）只发一次");
    // 事件流首尾语义：agent-start 在首、终态在尾（映射表锚点）
    assert!(
        matches!(
            result.events.first().map(|e| &e.event),
            Some(AgentEvent::AgentStart { .. })
        ),
        "session.start 源必须是流首"
    );
    assert!(
        matches!(
            result.events.last().map(|e| &e.event),
            Some(AgentEvent::RunTerminal { .. })
        ),
        "session.end 源必须是流尾"
    );
    // 落库同样恰好一次（Critical 必达）
    assert_eq!(
        mem.events()
            .iter()
            .filter(|e| e.event_type == "agent-start")
            .count(),
        1
    );
    assert_eq!(
        mem.events()
            .iter()
            .filter(|e| e.event_type == "run-terminal")
            .count(),
        1
    );
}

/// subagent-event 持久化分流（M14）：progress（Delta）不落库不阻塞；
/// message/tool（Soft）与 started/ended（Critical）落库
#[tokio::test]
async fn subagent_event_progress_is_non_persistent() {
    use conex_types::events::{SubagentEventKind, SubagentEventPayload};

    let progress = AgentEvent::SubagentEvent {
        session_id: "s1".to_string(),
        subagent_id: "sub-1".to_string(),
        subagent_run_id: "sr-1".to_string(),
        event: SubagentEventPayload {
            kind: SubagentEventKind::Progress,
            payload: None,
        },
    };
    let soft = AgentEvent::SubagentEvent {
        session_id: "s1".to_string(),
        subagent_id: "sub-1".to_string(),
        subagent_run_id: "sr-1".to_string(),
        event: SubagentEventPayload {
            kind: SubagentEventKind::Message,
            payload: None,
        },
    };
    assert!(
        is_non_persistent(&progress),
        "progress 类为 Delta：不落库不阻塞 drive loop"
    );
    assert!(
        !is_non_persistent(&soft),
        "message/tool 类为 Soft：尽力落库"
    );
    assert!(!is_non_persistent(&agent_start()), "agent-start 必达落库");
    assert!(
        is_non_persistent(&message_delta(0)),
        "message-delta 保持既有语义"
    );
}

// ── T-18（轮次 2 持久层）：压缩事件 → 块行入库（drive 端到端）──

/// 压缩事件经 drive_outcome 落库 → compression_blocks 同步写入块行：
/// block_id = record.id、sequence = 事件序列号、generation = 事件计数
/// （首次 = 1）、dropped 清单、state = awaiting（details 未织入时缺省）。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn drive_outcome_writes_compression_block_row() {
    let db = conex_db::LocalDb::open_in_memory().unwrap();
    {
        let db = db.clone();
        tokio::task::spawn_blocking(move || db.insert_session("s1", "s1"))
            .await
            .unwrap()
            .unwrap();
    }
    let store: Arc<dyn Store> = Arc::new(LocalDbStore::new(db.clone()));
    let manager = RunManager::new(store.clone());
    let mut run = manager.start_run("s1", "r_compact").await.unwrap();
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

    let record = conex_types::tool::ContextCompressionRecord {
        id: "compacted-summary-1-1".to_string(),
        trigger: conex_types::tool::ContextCompressionTrigger::Threshold,
        reason: None,
        policy: None,
        summary: "摘要文本".to_string(),
        first_kept_message_id: Some("u2".to_string()),
        compressed_message_ids: vec!["u1".to_string(), "a1".to_string()],
        kept_message_ids: vec!["u2".to_string(), "a2".to_string()],
        tokens_before: 10_000,
        tokens_after: 2_000,
        threshold_tokens: None,
        created_at: ts(),
        handoff: None,
        cache_boundary: None,
        details: None,
    };
    let events = vec![
        agent_start(),
        AgentEvent::ContextCompressionEnd {
            session_id: "s1".to_string(),
            timestamp: ts(),
            result: Some(record),
            aborted: false,
            error: None,
        },
        agent_end(AgentEndReason::Stop),
    ];

    let result = drive_outcome(&mut run, &mut queue, outcome(AgentEndReason::Stop, events))
        .await
        .unwrap();
    assert!(result.persist_failure.is_none(), "压缩事件应落库成功");

    // 压缩事件序列号（agent-start=1 → compression=2）
    let compression_seq = result
        .events
        .iter()
        .find(|e| matches!(e.event, AgentEvent::ContextCompressionEnd { .. }))
        .expect("压缩事件在流中")
        .sequence;
    assert_eq!(compression_seq, 2);

    // 块行已写入（sequence 与事件一致；generation = 会话压缩事件计数）
    let block = db
        .get_block("s1", "compacted-summary-1-1")
        .unwrap()
        .expect("块行应已入库");
    assert_eq!(block.sequence, 2, "块行 sequence = 压缩事件序列号");
    assert_eq!(block.generation, 1, "首次压缩代数 = 1");
    assert_eq!(
        block.dropped_message_ids,
        vec!["u1".to_string(), "a1".to_string()]
    );
    assert_eq!(block.state, conex_db::BlockState::Awaiting);
    assert_eq!(db.count_blocks("s1").unwrap(), 1);
    // 落库事件原文与块行同源（原文回放面不受块表影响）
    let stored = db.query_events("s1", 0, None).unwrap();
    assert!(stored
        .iter()
        .any(|e| e.event_type == "context-compression-end"));
}

/// 块行幂等：drive 重放（同事件再次驱动）不产生重复行——INSERT OR
/// IGNORE 语义在 drive 面成立。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn drive_outcome_compression_block_replay_idempotent() {
    let db = conex_db::LocalDb::open_in_memory().unwrap();
    {
        let db = db.clone();
        tokio::task::spawn_blocking(move || db.insert_session("s1", "s1"))
            .await
            .unwrap()
            .unwrap();
    }
    let store: Arc<dyn Store> = Arc::new(LocalDbStore::new(db.clone()));
    let manager = RunManager::new(store.clone());

    let compression = |id: &str| AgentEvent::ContextCompressionEnd {
        session_id: "s1".to_string(),
        timestamp: ts(),
        result: Some(conex_types::tool::ContextCompressionRecord {
            id: id.to_string(),
            trigger: conex_types::tool::ContextCompressionTrigger::Threshold,
            reason: None,
            policy: None,
            summary: "摘要".to_string(),
            first_kept_message_id: Some("u2".to_string()),
            compressed_message_ids: vec!["u1".to_string()],
            kept_message_ids: vec!["u2".to_string()],
            tokens_before: 100,
            tokens_after: 10,
            threshold_tokens: None,
            created_at: ts(),
            handoff: None,
            cache_boundary: None,
            details: None,
        }),
        aborted: false,
        error: None,
    };

    let mut run = manager.start_run("s1", "r_c1").await.unwrap();
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);
    drive_outcome(
        &mut run,
        &mut queue,
        outcome(
            AgentEndReason::Stop,
            vec![
                agent_start(),
                compression("b1"),
                agent_end(AgentEndReason::Stop),
            ],
        ),
    )
    .await
    .unwrap();
    assert_eq!(db.count_blocks("s1").unwrap(), 1);

    // 再次驱动同内容事件（模拟重放）：同 block_id 不产生第二行
    let mut run2 = manager.start_run("s1", "r_c2").await.unwrap();
    let mut queue2 = EventQueue::new(store.clone(), run2.cursor + 1, None);
    drive_outcome(
        &mut run2,
        &mut queue2,
        outcome(
            AgentEndReason::Stop,
            vec![
                agent_start(),
                compression("b1"),
                agent_end(AgentEndReason::Stop),
            ],
        ),
    )
    .await
    .unwrap();
    assert_eq!(
        db.count_blocks("s1").unwrap(),
        1,
        "同 block_id 重放不重复行"
    );
}
