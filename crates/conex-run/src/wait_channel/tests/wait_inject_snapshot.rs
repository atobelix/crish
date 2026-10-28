//! wait_for_terminal（终态返回 / 超时）、inject 转发、snapshot 映射与广播修剪测试

use super::*;

/// 注册两个 mock 子代理并发射 subagent-ended 事件流 →
/// wait_for_terminal 提前返回且状态正确（elapsed = ended - dispatched）
#[tokio::test]
async fn wait_channel_wait_for_terminal_returns_on_terminal() {
    let (channel, store, _, stream) = test_channel();
    // 分发基准：预置声明（dispatched_at = 1_000）
    store.save(&DispatchDeclaration {
        mode: WaitMode::AwaitAll,
        wait_ms: None,
        subagent_ids: vec!["sa-1".to_string(), "sa-2".to_string()],
        dispatched_at_ms: 1_000,
    });
    let wait_task = tokio::spawn({
        let channel = Arc::clone(&channel);
        async move {
            channel
                .wait_for_terminal(&["sa-1".to_string(), "sa-2".to_string()], Some(60_000))
                .await
        }
    });
    wait_until_subscribed(stream.as_ref()).await;
    // 等待期间发射两个 mock 子代理的终态事件（subagent-ended 消费点）
    stream.feed(&subagent_ended("sa-1", SubagentEndStatus::Completed));
    stream.feed(&subagent_ended("sa-2", SubagentEndStatus::Cancelled));
    // 三层 Result：timeout(Elapsed) → JoinHandle(JoinError) → 通道结果
    // （JoinHandle<T> 的 Future Output 恒为 Result<T, JoinError>）
    let result = tokio::time::timeout(Duration::from_secs(5), wait_task)
        .await
        .expect("wait 任务应在超时窗口内返回")
        .expect("tokio 任务 join 失败（wait 任务 panic）")
        .expect("wait_for_terminal 不应报错");
    assert!(result.all_terminal, "全部终态 → all_terminal");
    assert!(!result.timed_out, "事件到达不应超时");
    assert_eq!(result.agents.len(), 2, "状态摘要按入参顺序");
    assert_eq!(result.agents[0].status, SubagentState::Completed);
    assert_eq!(
        result.agents[1].status,
        SubagentState::Failed,
        "cancelled 归一 failed"
    );
    assert!(result.agents[0].terminal && result.agents[1].terminal);
    // 订阅生命周期：wait 返回后接收端 drop → 广播自动断流
    assert_eq!(
        stream.subscriber_count(),
        0,
        "wait 返回后订阅应已取消（mpsc drop 断流）"
    );
}

/// 不发射事件 → 超时返回 timed_out 与未完成列表（未完成保持 running）
#[tokio::test]
async fn wait_channel_wait_for_terminal_timeout() {
    let (channel, store, _, stream) = test_channel();
    store.save(&DispatchDeclaration {
        mode: WaitMode::Timer,
        wait_ms: Some(60),
        subagent_ids: vec!["sa-1".to_string()],
        dispatched_at_ms: 1_000,
    });
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        channel.wait_for_terminal(&["sa-1".to_string()], Some(60)),
    )
    .await
    .expect("超时窗口内应返回")
    .expect("wait_for_terminal 不应报错");
    assert!(result.timed_out, "不发射事件 → timed_out");
    assert!(!result.all_terminal);
    assert_eq!(
        result.agents[0].status,
        SubagentState::Running,
        "未完成保持 running"
    );
    assert!(!result.agents[0].terminal);
    // 订阅生命周期：超时返回后同样断流
    assert_eq!(stream.subscriber_count(), 0, "超时返回后订阅应已取消");
}

/// inject 经 request_subagent_inject 送达目标 run（mock 解析器 →
/// 真实 ControlBus 断言 intent 形状）
#[tokio::test]
async fn wait_channel_inject_forwards() {
    // mock 解析器：sa-1 命中（真实 ControlBus），sa-2 不可达
    let bus = Arc::new(Mutex::new(ControlBus::new()));
    struct MapResolver {
        map: std::collections::HashMap<String, Arc<Mutex<ControlBus>>>,
    }
    impl ControlBusResolver for MapResolver {
        fn control_bus(&self, subagent_id: &str) -> Option<Arc<Mutex<ControlBus>>> {
            self.map.get(subagent_id).cloned()
        }
    }
    let resolver = Arc::new(MapResolver {
        map: std::collections::HashMap::from([("sa-1".to_string(), Arc::clone(&bus))]),
    });
    let channel = Arc::new(WaitChannel::new(
        Arc::new(MemoryWaitStore::new()) as Arc<dyn WaitStore>,
        Arc::new(MemoryAgentSource::new()) as Arc<dyn SubagentStatusSource>,
        Arc::new(EventStreamBroadcast::new()),
        resolver as Arc<dyn ControlBusResolver>,
    ));
    channel
        .inject("sa-1", "调整方向：优先低风险改动")
        .await
        .expect("注入应成功");
    // 断言 intent 已入目标 run 的 L1 steer 环（transfer 语义）
    let intents = bus.lock().unwrap_or_else(|e| e.into_inner()).drain();
    assert_eq!(intents.len(), 1, "应恰好一条控制意图");
    assert_eq!(intents[0].kind, ControlKind::Steer, "注入走 steer 环");
    assert_eq!(
        intents[0].reason.as_deref(),
        Some("subagent_inject:sa-1"),
        "reason 携带可观测标识"
    );
    let message = intents[0].message.as_ref().expect("注入意图必须携带消息");
    let text = message.blocks.iter().find_map(|b| match b {
        conex_types::message::AgentMessageBlock::Text { text } => Some(text.as_str()),
        _ => None,
    });
    assert_eq!(text, Some("调整方向：优先低风险改动"));
    // 不可达目标 → 结构化 InjectFailed（不 panic）
    let err = channel
        .inject("sa-2", "不应送达")
        .await
        .expect_err("不可达目标应报错");
    assert!(matches!(err, SubagentWaitError::InjectFailed(_)));
}

/// snapshot 读 session_agents 行映射状态摘要（stopped 归一 failed；
/// 行缺失按运行中 fail-open）
#[tokio::test]
async fn wait_channel_snapshot_from_agent_rows() {
    let (channel, _, agents, _) = test_channel();
    agents.set_agents(vec![
        agent_row("sa-1", "completed", 1_000),
        agent_row("sa-2", "stopped", 2_000),
        agent_row("sa-3", "running", 3_000),
    ]);
    let statuses = channel
        .snapshot(&[
            "sa-1".to_string(),
            "sa-2".to_string(),
            "sa-3".to_string(),
            "sa-9".to_string(),
        ])
        .await
        .expect("snapshot 不应报错");
    assert_eq!(statuses.len(), 4, "按入参顺序返回");
    assert_eq!(statuses[0].status, SubagentState::Completed);
    assert!(statuses[0].terminal);
    assert_eq!(
        statuses[1].status,
        SubagentState::Failed,
        "stopped 归一 failed"
    );
    assert!(statuses[1].terminal);
    assert_eq!(statuses[2].status, SubagentState::Running);
    assert!(!statuses[2].terminal);
    assert_eq!(
        statuses[3].status,
        SubagentState::Running,
        "行缺失 fail-open"
    );
    assert!(!statuses[3].terminal);
}

/// 广播映射与修剪：非 SubagentEnded 事件忽略；断流订阅者被修剪；
/// 订阅后 feed 立即送达。
#[tokio::test]
async fn broadcast_feed_maps_and_prunes() {
    let stream = EventStreamBroadcast::new();
    // 非终态事件 → 忽略（无订阅者收到）
    let mut rx = stream.subscribe();
    stream.feed(&AgentEvent::AgentStart {
        session_id: "s1".to_string(),
        timestamp: "2026-08-05T00:00:00.000Z".to_string(),
    });
    assert!(rx.try_recv().is_err(), "非 SubagentEnded 事件不得转发");
    // 终态事件 → 送达
    stream.feed(&subagent_ended("sa-1", SubagentEndStatus::Failed));
    let event = rx.try_recv().expect("终态事件应送达");
    assert_eq!(event.subagent_id, "sa-1");
    assert_eq!(event.status, SubagentState::Failed);
    // 断流修剪：rx drop 后订阅者被清理
    drop(rx);
    stream.feed(&subagent_ended("sa-2", SubagentEndStatus::Completed));
    assert_eq!(stream.subscriber_count(), 0, "断流订阅者应被修剪");
}
