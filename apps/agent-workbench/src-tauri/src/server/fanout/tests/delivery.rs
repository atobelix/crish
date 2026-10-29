//! fanout 测试 · 连接注册表 / emit 接线 / 元信息与消费（fanout.rs 拆分）。

use super::super::*;
use super::support::*;

use conex_types::events::AgentEventEnvelope;

// ── 连接注册表 ──

/// 连接 id 重复注册被拒（注册表键冲突）
#[test]
fn duplicate_conn_id_rejected() {
    let fanout = FanOutEmitter::new(vec![]);
    fanout
        .subscribe("conn-x", session_sub(&["s1"]))
        .expect("首次注册成功");
    // 断言错误码（FanoutReceiver 是运行时句柄，不实现 PartialEq/Debug）
    let result = fanout.subscribe("conn-x", session_sub(&["s2"]));
    assert_eq!(
        result.err(),
        Some(FanoutError::AlreadyRegistered),
        "重复连接 id 应拒绝注册"
    );
    assert_eq!(fanout.subscriber_count(), 1);
}

/// 注销后不再接收新事件（残留队列仍可读尽）
#[test]
fn unsubscribe_stops_delivery() {
    let fanout = FanOutEmitter::new(vec![]);
    let rx = fanout
        .subscribe("conn-y", session_sub(&["s1"]))
        .expect("注册成功");

    fanout.emit(
        "workbench-run-event",
        &payload_of(agent_start("s1"), Some(1)),
    );
    assert!(rx.try_recv().is_some(), "注销前应送达");

    fanout.unsubscribe("conn-y");
    assert_eq!(fanout.subscriber_count(), 0, "注册表应移除该连接");
    fanout.emit(
        "workbench-run-event",
        &payload_of(agent_start("s1"), Some(2)),
    );
    assert!(rx.try_recv().is_none(), "注销后不应再送达");
}

/// 零订阅者发布零开销（不 panic、计数为 0）
#[test]
fn publish_without_subscribers_is_noop() {
    let fanout = FanOutEmitter::new(vec![]);
    fanout.emit(
        "workbench-run-event",
        &payload_of(agent_start("s1"), Some(1)),
    );
    assert_eq!(fanout.subscriber_count(), 0);
    assert_eq!(fanout.dropped_total(), 0);
}

// ── emit 接线（R1-01 验收锚点：双发射器收同一 payload）──

/// 双发射器收同一 payload：同步发射器与跨端订阅者逐字节一致
#[test]
fn emit_forwards_same_payload_to_inner_and_subscriber() {
    let inner = Arc::new(RecordingEmitter::default());
    let fanout = FanOutEmitter::new(vec![Arc::clone(&inner) as Arc<dyn Emitter>]);
    let rx = fanout
        .subscribe("conn-z", session_sub(&["s1"]))
        .expect("注册成功");

    let payload = payload_of(agent_start("s1"), Some(1));
    fanout.emit("workbench-run-event", &payload);

    // 同步发射器收到同一通道与载荷
    let calls = inner.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "workbench-run-event");
    assert_eq!(calls[0].1, payload);
    // 跨端订阅者收到同一载荷（逐字节一致）
    let event = rx.try_recv().expect("订阅者应收到事件");
    assert_eq!(event.payload, payload);
    assert_eq!(event.level, BackpressureLevel::Critical);
}

/// 单发射器 panic 不影响其余（catch_unwind 隔离）
#[test]
fn panicking_emitter_does_not_block_others() {
    let recording = Arc::new(RecordingEmitter::default());
    let fanout = FanOutEmitter::new(vec![
        Arc::new(PanickingEmitter),
        Arc::clone(&recording) as Arc<dyn Emitter>,
    ]);
    fanout.emit(
        "workbench-run-event",
        &payload_of(agent_start("s1"), Some(1)),
    );
    assert_eq!(recording.calls().len(), 1, "panic 发射器之后仍应继续分发");
}

/// EventBridge 接线：attach FanOutEmitter 后 emit_envelope → 订阅者
/// 收到与 webview 通道逐字节一致的载荷（mock bridge 事件 → fanout 收到）
#[test]
fn bridge_emit_reaches_fanout_subscriber() {
    use conex_run::core_event_bridge::EventBridge;

    // 桌面侧发射器（测试替身）
    let webview = Arc::new(RecordingEmitter::default());
    let bridge = EventBridge::new(
        "workbench-run-event",
        Arc::clone(&webview) as Arc<dyn Emitter>,
    );
    // 挂跨端扇出（生产装配形态：attach_fanout，main.rs 接线）
    let fanout = Arc::new(FanOutEmitter::new(vec![]));
    bridge.attach_fanout(Arc::clone(&fanout) as Arc<dyn Emitter>);
    let rx = fanout
        .subscribe("conn-bridge", session_sub(&["s1"]))
        .expect("注册成功");

    let envelope = AgentEventEnvelope::new(agent_start("s1"), Some("r1".to_string()), Some(7));
    let report = bridge.emit_envelope(&envelope);

    assert_eq!(report.emitted, 1);
    assert_eq!(webview.calls().len(), 1, "webview 通道照常");
    let event = rx.try_recv().expect("fanout 订阅者应收到事件");
    assert_eq!(event.event_type, "agent-start");
    assert_eq!(event.session_id.as_deref(), Some("s1"));
    assert_eq!(event.sequence, Some(7));
    // 双通道同载荷（跨端与 webview 逐字节一致，D1 §1.3 原则 1）
    assert_eq!(event.payload, webview.calls()[0].1);
}

// ── 元信息与消费 ──

/// 排队事件元信息完整（类型 / 会话 / 序列号 / 背压级别）
#[test]
fn queued_event_metadata_filled() {
    let fanout = FanOutEmitter::new(vec![]);
    let rx = fanout
        .subscribe("conn-m", session_sub(&["s1"]))
        .expect("注册成功");

    fanout.emit(
        "workbench-run-event",
        &payload_of(task_output("s1"), Some(3)),
    );
    let event = rx.try_recv().expect("应收到事件");
    assert_eq!(event.event_type, "task-output");
    assert_eq!(event.session_id.as_deref(), Some("s1"));
    assert_eq!(event.sequence, Some(3));
    assert_eq!(event.level, BackpressureLevel::Delta);
}

/// recv（async）唤醒语义：publish 后 drain 侧被唤醒取到事件
#[tokio::test]
async fn receiver_recv_wakes_on_publish() {
    let fanout = FanOutEmitter::new(vec![]);
    let rx = fanout
        .subscribe("conn-r", session_sub(&["s1"]))
        .expect("注册成功");
    let rx2 = rx.clone();
    let task = tokio::spawn(async move {
        // 队列空时应挂起等待，publish 后收到（Notify permit 粘滞）
        let event = rx2.recv().await.expect("等待到事件");
        event.event_type
    });
    // 让 drain 任务先进入等待
    tokio::task::yield_now().await;
    fanout.emit(
        "workbench-run-event",
        &payload_of(agent_start("s1"), Some(1)),
    );
    let event_type = task.await.expect("drain 任务不应 panic");
    assert_eq!(event_type, "agent-start");
}

#[test]
fn broadcast_new_and_receiver_conn_id_smoke() {
    let broadcast = WsBroadcast::new();
    let rx = broadcast
        .register(
            "conn-test-id",
            SubscriptionFilter::session_subscribe(["s1".to_string()]),
        )
        .expect("register");
    assert_eq!(rx.conn_id(), "conn-test-id");
}
