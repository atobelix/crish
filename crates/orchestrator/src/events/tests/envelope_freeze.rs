use super::*;

// ── D-01 DM-04：run 归属列 + 信封落库 + goal-* 轮次域 ──

/// D-01 DM-04 验收锚：落库行 run_id 列 == 构造绑定值 && payload 为
/// 完整信封（runId/sequence/schemaVersion 齐全）且信封 runId == 列值
/// （列 + 信封并用不变量：同一注入点产出，防双写漂移，01 §2.1）
#[tokio::test]
async fn eventqueue_envelope_matches_column() {
    let (mem, store) = setup();
    let mut queue = EventQueue::new(store, 1, Some("r-main".to_string()));
    queue.push("s1", agent_start()).await.unwrap();

    let stored = mem.events();
    assert_eq!(stored.len(), 1);
    let row = &stored[0];
    assert_eq!(row.run_id.as_deref(), Some("r-main"), "列值 = 构造绑定值");
    let envelope: AgentEventEnvelope =
        serde_json::from_str(&row.payload).expect("落库 payload 应为完整信封 JSON");
    assert_eq!(
        envelope.run_id.as_deref(),
        Some("r-main"),
        "信封 runId == 列值"
    );
    assert_eq!(envelope.sequence, Some(1), "信封携带 sequence");
    assert_eq!(envelope.schema_version, 1, "信封携带 schemaVersion");
    let wire = serde_json::to_value(&envelope).unwrap();
    assert_eq!(wire["type"], "agent-start");
    assert_eq!(
        wire["sessionId"], "s1",
        "事件体 sessionId 在场（与广播 wire 同构）"
    );
}

/// D-01 DM-04 验收锚：绑 None 落库 = 会话域事件——按 run 查询不命中、
/// 按会话查询命中（事件行 run_id 列 NULL）
#[tokio::test]
async fn eventqueue_nomaster_event_run_id_none() {
    let (mem, store) = setup();
    let mut queue = EventQueue::new(store.clone(), 1, None);
    queue.push("s1", agent_start()).await.unwrap();

    let stored = mem.events();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].run_id, None, "绑 None → 列值 NULL");
    let envelope: AgentEventEnvelope = serde_json::from_str(&stored[0].payload).unwrap();
    assert_eq!(envelope.run_id, None, "信封无 runId");

    let by_run = store
        .query_events_by_run("s1", "any-run", 0, None)
        .await
        .unwrap();
    assert!(by_run.is_empty(), "会话域事件不命中 run 查询");
    let by_session = store.query_events("s1", 0, None).await.unwrap();
    assert_eq!(by_session.len(), 1, "按会话查询命中");
}

/// D-01 DM-04 验收锚：goal-* 轮次域（R-06）——三事件落库行 run_id 列
/// NULL 且 payload 信封 runId 为 None（不归任何 run，run 查询天然不命中）
#[tokio::test]
async fn eventqueue_goal_event_round_domain() {
    let (mem, store) = setup();
    let mut queue = EventQueue::new(store.clone(), 1, Some("r-goal".to_string()));

    let goal_events = [
        AgentEvent::GoalRoundStarted {
            round: 1,
            max_rounds: 3,
            goal: "调研 X".to_string(),
        },
        AgentEvent::GoalRoundCompleted {
            round: 1,
            tool_call_count: 2,
            tool_success_count: 2,
            message_count: 3,
            decision: "Continue".to_string(),
            reason_detail: "继续".to_string(),
            stalled_delta: 0,
            evidence: String::new(),
        },
        AgentEvent::GoalContinuationDecided {
            action: "continue".to_string(),
            reason: "继续".to_string(),
            prompt: None,
            progress_signature: None,
            detail: None,
        },
    ];
    for (index, event) in goal_events.into_iter().enumerate() {
        let sequence = queue.push("s1", event).await.unwrap().sequence;
        let stored = mem.events();
        let row = stored
            .iter()
            .find(|e| e.sequence == sequence)
            .expect("goal 事件应落库");
        assert_eq!(row.run_id, None, "goal-* 列 run_id = NULL（轮次域）");
        let envelope: AgentEventEnvelope = serde_json::from_str(&row.payload).unwrap();
        assert_eq!(envelope.run_id, None, "goal-* 信封无 runId");
        assert_eq!(envelope.sequence, Some(sequence));
        assert_eq!(index as u64 + 1, sequence, "goal 三事件顺序落库");
    }

    // run 查询不含 goal-*（列 NULL 不命中）；按会话查询命中
    let by_run = store
        .query_events_by_run("s1", "r-goal", 0, None)
        .await
        .unwrap();
    assert!(by_run.is_empty(), "轮次域事件不命中 run 查询");
    let by_session = store.query_events("s1", 0, None).await.unwrap();
    assert_eq!(by_session.len(), 3, "按会话查询命中（会话域可见）");
}

/// D-01 DM-04 验收锚：normalize_envelope 语义在落库面生效——事件体空
/// sessionId 被补全、run-terminal 事件体空 runId 被补齐（normalize.rs
/// :99-131 语义从「仅测试调用的名义注入点」变为实际落库注入点）
#[tokio::test]
async fn eventqueue_normalize_envelope_wired_on_persist() {
    let (mem, store) = setup();
    let mut queue = EventQueue::new(store, 1, Some("r-main".to_string()));

    // 事件体空 sessionId → normalize 补会话
    let mut start = agent_start();
    if let AgentEvent::AgentStart { session_id, .. } = &mut start {
        session_id.clear();
    }
    queue.push("s1", start).await.unwrap();
    let row = &mem.events()[0];
    let envelope: AgentEventEnvelope = serde_json::from_str(&row.payload).unwrap();
    match &envelope.event {
        AgentEvent::AgentStart { session_id, .. } => {
            assert_eq!(session_id, "s1", "事件体空 sessionId 被补全");
        }
        other => panic!("事件类型不符：{other:?}"),
    }

    // run-terminal 事件体空 runId → normalize 用队列绑定 runId 补齐
    let terminal = AgentEvent::RunTerminal {
        session_id: "s1".to_string(),
        run_id: String::new(),
        timestamp: ts(),
        terminal: RunTerminalStatus::Completed,
        error: None,
    };
    queue.push("s1", terminal).await.unwrap();
    let row = &mem.events()[1];
    let envelope: AgentEventEnvelope = serde_json::from_str(&row.payload).unwrap();
    assert_eq!(
        envelope.run_id.as_deref(),
        Some("r-main"),
        "信封 runId 在场"
    );
    match &envelope.event {
        AgentEvent::RunTerminal { run_id, .. } => {
            assert_eq!(run_id, "r-main", "终态事件体 runId 补齐（03 §5.1-16）");
        }
        other => panic!("事件类型不符：{other:?}"),
    }
}

// ── R1 撤回边界冻结护栏（详案 §1.2-③ FREEZE1/FREEZE2）──

/// FREEZE1（写侧隔离硬验收）：冻结激活期内 `sequence > frozen_seq`
/// 的非撤离写入被拒（RetractionFreeze 可判定），撤离事件
/// （timeline-truncate / run-terminal）放行；释放后写入恢复。
///
/// 并发语义：冻结读点 = 稳定点 MAX(sequence)，护栏拒绝即「截断后无
/// 新事件越过 boundary」（events 表在 TimelineTruncate 之后无
/// `> boundary_seq` 的非撤离事件）。
#[tokio::test]
async fn freeze_guard_rejects_crossing_writes_and_allows_evacuation() {
    let (mem, store) = setup();
    let registry = std::sync::Arc::new(session_loop::SessionFreezeRegistry::new());
    let mut queue = EventQueue::new(store, 1, None).with_freeze_registry(registry.clone());

    // 基线：agent-start 落库（sequence=1）——冻结读点前的历史
    queue.push("s1", agent_start()).await.unwrap();
    assert_eq!(mem.events().len(), 1);

    // 冻结激活：frozen_seq = 1（稳定点 MAX；本撤回事务内不再被越过）
    registry.freeze("s1", "retraction:s1", 1).unwrap();

    // 非撤离写入（agent-start，sequence=2 > frozen_seq=1）→ 拒绝
    //（agent-end / run-terminal 为 run 收口终态撤离事件，放行面见下）
    let err = queue.push("s1", agent_start()).await.unwrap_err();
    assert!(
        err.is_retraction_freeze(),
        "越界写入必须是可判定的 RetractionFreeze（kind={}）",
        err.error.kind
    );
    assert_eq!(err.sequence, 2, "拒绝携带已分配的越界序列");
    assert_eq!(
        mem.events().len(),
        1,
        "被拒事件不得落库（截断后无越过 boundary 的新事件）"
    );

    // 撤离事件放行：timeline-truncate（自身占 sequence = frozen_seq + 1）
    let truncate = AgentEvent::TimelineTruncate {
        session_id: "s1".to_string(),
        run_id: "run-1".to_string(),
        boundary_seq: 1,
        reason: conex_types::events::TimelineTruncateReason::UserRequested,
        target_message_id: "msg-1".to_string(),
        timestamp: ts(),
    };
    let seq = queue.push("s1", truncate).await.unwrap();
    assert_eq!(
        seq.sequence, 2,
        "TimelineTruncate.sequence == frozen_seq + 1"
    );
    assert!(seq.persisted, "timeline-truncate Critical 必达落库");
    assert_eq!(mem.events().len(), 2);

    // 核心能力整改（04A/04B 拔除白名单后门）：冻结生效后，RunTerminal 绝不再是撤离事件，
    // 越界写入必须被刚性拦截（fail-closed）
    let terminal = AgentEvent::RunTerminal {
        session_id: "s1".to_string(),
        run_id: "run-1".to_string(),
        timestamp: ts(),
        terminal: RunTerminalStatus::Cancelled,
        error: None,
    };
    let terminal_err = queue.push("s1", terminal).await.unwrap_err();
    assert_eq!(terminal_err.event_type, "run-terminal");
    assert_eq!(mem.events().len(), 2);

    // 冻结期内另一会话不受影响（会话级隔离）
    assert_eq!(queue.push("s2", agent_start()).await.unwrap().sequence, 1);

    // 释放后写入恢复（新 run 从 boundary 后重新开始）
    registry.release("s1", "retraction:s1").unwrap();
    let ok = queue
        .push("s1", agent_end(AgentEndReason::Stop))
        .await
        .unwrap();
    assert_eq!(ok.sequence, 3, "释放后新写入放行（归新 run 语义）");
}

/// FREEZE2（原子性）：冻结读点 == 事件流停止写入点——冻结登记后
/// 连续越界写入全部被拒（无撕裂），boundary 恒为登记时的 frozen_seq
#[tokio::test]
async fn freeze_boundary_is_stable_under_concurrent_residual_writes() {
    let (mem, store) = setup();
    let registry = std::sync::Arc::new(session_loop::SessionFreezeRegistry::new());
    let mut queue = EventQueue::new(store, 1, None).with_freeze_registry(registry.clone());

    queue.push("s1", agent_start()).await.unwrap();
    let frozen_seq = 1;
    registry.freeze("s1", "tok", frozen_seq).unwrap();

    // 模拟 stop 收敛后的残余写入风暴：全部应被拒，边界不被抬高
    for _ in 0..5 {
        let err = queue.push("s1", agent_start()).await.unwrap_err();
        assert!(err.is_retraction_freeze());
    }
    assert_eq!(
        registry.frozen_seq("s1"),
        Some(frozen_seq),
        "冻结边界在残余写入下不被抬高（MAX 语义不回退，护栏不漂移）"
    );
    assert_eq!(mem.events().len(), 1, "残余写入全部被拒，无越界落库");

    // 双撤回互斥（FREEZE3 写侧）：同会话第二次冻结拒绝
    assert_eq!(
        registry.freeze("s1", "tok-2", 9),
        Err(session_loop::FreezeError::AlreadyFrozen {
            token: "tok".to_string()
        })
    );
    registry.release("s1", "tok").unwrap();
}
