//! fanout 测试 · 订阅过滤与丢帧分级（fanout.rs 拆分）。

use super::super::*;
use super::support::*;

// ── 订阅过滤（会话级 / 全局）──

/// 过滤器纯语义：会话命中 + 全局白名单命中 + 无会话事件仅全局可收
#[test]
fn filter_matches_semantics() {
    let filter = SubscriptionFilter::new(["s1".to_string()], ["security-audit".to_string()]);
    assert!(filter.matches("agent-start", Some("s1")), "订阅会话应命中");
    assert!(
        !filter.matches("agent-start", Some("s2")),
        "非订阅会话不命中"
    );
    assert!(
        !filter.matches("agent-start", None),
        "无会话事件不命中会话订阅"
    );
    assert!(
        filter.matches("security-audit", Some("s3")),
        "白名单类型命中"
    );
    assert!(
        filter.matches("security-audit", None),
        "白名单类型无会话也命中"
    );
    assert!(!filter.matches("message-delta", None), "白名单外类型不命中");
    assert!(!filter.is_empty(), "非空过滤器");
    assert!(SubscriptionFilter::default().is_empty(), "缺省为空过滤器");
}

/// 会话级订阅：只收订阅会话的事件，其他会话事件不收
#[test]
fn session_subscriber_receives_only_own_session() {
    let fanout = FanOutEmitter::new(vec![]);
    let rx = fanout
        .subscribe("conn-a", session_sub(&["s1"]))
        .expect("注册成功");

    fanout.emit(
        "workbench-run-event",
        &payload_of(agent_start("s1"), Some(1)),
    );
    let event = rx.try_recv().expect("订阅会话事件应送达");
    assert_eq!(event.event_type, "agent-start");
    assert_eq!(event.session_id.as_deref(), Some("s1"));
    assert_eq!(event.sequence, Some(1));

    fanout.emit(
        "workbench-run-event",
        &payload_of(agent_start("s2"), Some(2)),
    );
    assert!(rx.try_recv().is_none(), "非订阅会话事件不应送达");
}

/// 全局订阅：只收白名单类型事件（与会话归属无关），其余类型不收
#[test]
fn global_subscriber_receives_whitelisted_types() {
    let fanout = FanOutEmitter::new(vec![]);
    let rx = fanout
        .subscribe(
            "conn-b",
            SubscriptionFilter::global_subscribe(["task-completed".to_string()]),
        )
        .expect("注册成功");

    // 白名单类型 → 送达（会话归属无关）
    fanout.emit(
        "workbench-run-event",
        &payload_of(task_completed("s9"), Some(1)),
    );
    let event = rx.try_recv().expect("白名单类型事件应送达");
    assert_eq!(event.event_type, "task-completed");
    assert_eq!(event.session_id.as_deref(), Some("s9"));

    // 白名单外类型 → 不收（即便会话归属在订阅范围之外也不相关）
    fanout.emit(
        "workbench-run-event",
        &payload_of(agent_start("s9"), Some(2)),
    );
    assert!(rx.try_recv().is_none(), "白名单外类型不应送达");
}

/// 空过滤器：未订阅任何事件（fail-closed：恒不命中）
#[test]
fn empty_filter_receives_nothing() {
    let fanout = FanOutEmitter::new(vec![]);
    let rx = fanout
        .subscribe("conn-c", SubscriptionFilter::default())
        .expect("注册成功");
    fanout.emit(
        "workbench-run-event",
        &payload_of(agent_start("s1"), Some(1)),
    );
    assert!(rx.try_recv().is_none(), "空过滤器不应收到任何事件");
}

// ── 丢帧分级（Critical 必达 / Soft 可丢 / Delta 高负载丢）──

/// 洪峰下 Critical 必达：队列满后 Delta 洪峰全丢（Critical 原封不动），
/// 洪峰后再入 Critical 无 Soft/Delta 可驱逐时超限接受（必达不丢）
#[test]
fn critical_survives_delta_flood() {
    let fanout = FanOutEmitter::with_capacity(vec![], 4);
    let rx = fanout
        .subscribe("conn-d", session_sub(&["s1"]))
        .expect("注册成功");

    // 先入 4 条 Critical（队列满）
    for sequence in 1..=4 {
        fanout.emit(
            "workbench-run-event",
            &payload_of(agent_start("s1"), Some(sequence)),
        );
    }
    // Delta 洪峰 100 条：队列全 Critical 无可驱逐 → 每条都被拒
    for sequence in 5..=104 {
        fanout.emit(
            "workbench-run-event",
            &payload_of(task_output("s1"), Some(sequence)),
        );
    }
    assert_eq!(rx.dropped(), 100, "洪峰 Delta 应全部计入丢帧");
    assert_eq!(rx.pending(), 4, "Critical 队列长度不变");
    assert_eq!(fanout.dropped_total(), 100, "全局丢帧计数同步");

    // 洪峰后再入 Critical：无 Soft/Delta 可驱逐 → 超限接受（必达）
    fanout.emit(
        "workbench-run-event",
        &payload_of(task_completed("s1"), Some(105)),
    );
    assert_eq!(rx.pending(), 5, "Critical 超限接受");
    let events = drain(&rx);
    let types: Vec<&str> = events.iter().map(|e| e.event_type.as_str()).collect();
    assert_eq!(types[..4], ["agent-start"; 4], "4 条 Critical 全在");
    assert_eq!(types[4], "task-completed", "洪峰后的 Critical 必达");
    assert_eq!(events[4].sequence, Some(105));
}

/// 满队列时新 Soft 事件驱逐最旧 Delta 旧帧腾位（丢旧保新）
#[test]
fn soft_event_evicts_oldest_delta_when_full() {
    let fanout = FanOutEmitter::with_capacity(vec![], 3);
    let rx = fanout
        .subscribe("conn-e", session_sub(&["s1"]))
        .expect("注册成功");

    // 队列 [delta, delta, critical]（满）
    fanout.emit(
        "workbench-run-event",
        &payload_of(task_output("s1"), Some(1)),
    );
    fanout.emit(
        "workbench-run-event",
        &payload_of(task_output("s1"), Some(2)),
    );
    fanout.emit(
        "workbench-run-event",
        &payload_of(agent_start("s1"), Some(3)),
    );

    // 新 Soft：驱逐最旧 Delta 腾位
    fanout.emit(
        "workbench-run-event",
        &payload_of(task_suspicious("s1"), Some(4)),
    );
    assert_eq!(rx.dropped(), 1, "被驱逐的旧 Delta 计入丢帧");
    assert_eq!(rx.pending(), 3);
    let events = drain(&rx);
    let types: Vec<&str> = events.iter().map(|e| e.event_type.as_str()).collect();
    assert_eq!(types, ["task-output", "agent-start", "task-suspicious"]);
}

/// 满队列时新 Critical 驱逐最旧 Soft 旧帧腾位（Soft 可丢、Critical 必达）
#[test]
fn critical_evicts_soft_when_full() {
    let fanout = FanOutEmitter::with_capacity(vec![], 2);
    let rx = fanout
        .subscribe("conn-f", session_sub(&["s1"]))
        .expect("注册成功");

    // 队列 [soft, delta]（满）
    fanout.emit(
        "workbench-run-event",
        &payload_of(task_suspicious("s1"), Some(1)),
    );
    fanout.emit(
        "workbench-run-event",
        &payload_of(task_output("s1"), Some(2)),
    );

    // 新 Critical：驱逐最旧 Soft 腾位
    fanout.emit(
        "workbench-run-event",
        &payload_of(agent_start("s1"), Some(3)),
    );
    assert_eq!(rx.dropped(), 1, "被驱逐的 Soft 计入丢帧");
    assert_eq!(rx.pending(), 2);
    let events = drain(&rx);
    let types: Vec<&str> = events.iter().map(|e| e.event_type.as_str()).collect();
    assert_eq!(
        types,
        ["task-output", "agent-start"],
        "Soft 被驱逐、Critical 必达"
    );
}

/// 队列全 Critical 时新 Critical 超限接受（必达语义：绝不丢）
#[test]
fn critical_overflows_when_queue_has_no_droppable() {
    let fanout = FanOutEmitter::with_capacity(vec![], 2);
    let rx = fanout
        .subscribe("conn-g", session_sub(&["s1"]))
        .expect("注册成功");

    fanout.emit(
        "workbench-run-event",
        &payload_of(agent_start("s1"), Some(1)),
    );
    fanout.emit(
        "workbench-run-event",
        &payload_of(agent_start("s1"), Some(2)),
    );
    fanout.emit(
        "workbench-run-event",
        &payload_of(task_completed("s1"), Some(3)),
    );

    assert_eq!(rx.dropped(), 0, "Critical 不丢帧");
    assert_eq!(rx.pending(), 3, "Critical 超限接受");
}
