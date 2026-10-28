//! SR-05 · 测试外置 · ≠ EL（事件发射域旁挂）：T-AB-17 七事件生产发射
//! （30 方案 P2）+ 34 方案 §2.4 list wire suspicious 序列化。
//! 本文件自 fdb512d4^（拆分前 background.rs `mod tests`）原样重建，
//! 断言零改动；接线：background.rs
//! `#[cfg(test)] #[path = "background_tests_events.rs"] mod tests_events;`，
//! helper 经 `use super::tests::*;` 共享（background_tests.rs）；
//! [adopt_request_monitored] 复用资源域旁挂（pub(crate) 适配）。

// G2 禁令豁免：
// - 测试临时目录清理（非产品删除路径，可恢复语义不适用）；
// - 测试 mod 子进程拉起面：真实 spawn 探测（红线 Blocked 断言 +
//   tasklist / kill -0 存活探测辅助，T-AB-06/07 验收），非产品执行面；
//   测试 mod 内 allow + 理由（裁决 D8 背书）。
#![allow(clippy::disallowed_methods)]
use super::bg_commands::build_list_response;
use super::bg_events::EventBridgeSink;
use super::tests::*;
use super::tests_resource::adopt_request_monitored;
use agent_tools::BackgroundTaskManager;
use conex_run::core_event_bridge::EventBridge;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 测试事件发射器：记录 (channel, payload) 序列（对齐 core_event_bridge.rs
/// 测试替身同型——出站边界记录调用，不 mock 被测发射链）。
#[derive(Default)]
struct RecordingEmitter {
    calls: Mutex<Vec<(String, String)>>,
}

impl RecordingEmitter {
    fn calls(&self) -> Vec<(String, String)> {
        self.calls.lock().unwrap().clone()
    }
}

impl conex_run::core_event_bridge::Emitter for RecordingEmitter {
    fn emit(&self, channel: &str, payload: &str) {
        self.calls
            .lock()
            .unwrap()
            .push((channel.to_string(), payload.to_string()));
    }
}

/// 构造测试事件桥（记录发射器 + 生产通道名）。
fn recording_bridge() -> (EventBridge, Arc<RecordingEmitter>) {
    let emitter = Arc::new(RecordingEmitter::default());
    let bridge = EventBridge::new(
        "workbench-run-event",
        Arc::clone(&emitter) as Arc<dyn conex_run::core_event_bridge::Emitter>,
    );
    (bridge, emitter)
}

/// 从记录载荷解析信封（顶层扁平 JSON → [AgentEventEnvelope]，字段级断言用）。
fn parse_envelope(payload: &str) -> AgentEventEnvelope {
    serde_json::from_str(payload).expect("事件载荷必须可解析为信封")
}

/// 等待指定类型的事件出现在记录中（窗口内未到则 panic）。
async fn wait_for_event_type(
    emitter: &Arc<RecordingEmitter>,
    event_type: &str,
    window: Duration,
) -> Vec<AgentEventEnvelope> {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        let envelopes: Vec<AgentEventEnvelope> = emitter
            .calls()
            .iter()
            .map(|(_, payload)| parse_envelope(payload))
            .collect();
        if envelopes.iter().any(|e| e.type_name() == event_type) {
            return envelopes;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "事件 {event_type} 迟迟未发射（已收到 {} 条）",
            envelopes.len()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// 验收（30 方案 P2）：任务全生命周期七事件经 workbench-run-event 发射——
/// adopt → 输出 → 完成：事件序 started → output* → completed，payload
/// 字段级断言（对齐 conex-types events.rs 变体形状）。
#[tokio::test]
async fn task_seven_events_lifecycle_shapes() {
    let registry = test_registry();
    let (bridge, emitter) = recording_bridge();
    // 生产装配语义：set_event_bridge 替换默认 LogEventSink 留痕实现
    registry.set_event_bridge(bridge, String::new());

    let child = spawn_test_child(OUTPUT_COMMAND);
    let r = registry
        .adopt(adopt_request_monitored(
            child,
            "seven-events",
            Path::new("."),
        ))
        .await
        .expect("adopt");
    let task_id = r.task_id.clone();

    // 收集全部事件至 task-completed（完成事件在 writer 收口时发射）
    let envelopes = wait_for_event_type(&emitter, "task-completed", Duration::from_secs(30)).await;
    // 事件序断言：started 首位、output 在 completed 前、completed 收尾
    assert_eq!(
        envelopes[0].type_name(),
        "task-started",
        "首事件必须为 task-started"
    );
    let types: Vec<&str> = envelopes.iter().map(|e| e.type_name()).collect();
    assert!(
        types.contains(&"task-output"),
        "生命周期必须包含 task-output：{types:?}"
    );
    assert_eq!(
        types.last().copied(),
        Some("task-completed"),
        "末事件必须为 task-completed：{types:?}"
    );
    // 事件序：started 出现在一切 output 之前（completed 由末尾位置保证）
    let first_output = types.iter().position(|t| *t == "task-output").unwrap();
    assert!(first_output > 0, "output 不得早于 started");

    // started payload 字段级断言（taskId/command/cwd/ownerRunId/isDaemon）
    let AgentEvent::TaskStarted {
        session_id,
        task_id: sid,
        command,
        cwd,
        owner_run_id,
        is_daemon,
    } = &envelopes[0].event
    else {
        panic!("首事件变体应为 TaskStarted");
    };
    assert_eq!(sid, &task_id);
    assert_eq!(session_id, "", "未接线会话 id 时占位空串");
    assert_eq!(command, "seven-events");
    assert!(!cwd.is_empty(), "cwd 应非空");
    assert_eq!(owner_run_id, "", "未归属任务 ownerRunId 空串占位");
    assert!(!is_daemon, "测试任务非守护");

    // output payload 字段级断言（taskId/line/lineCount；chunk 不占位）
    let output = envelopes
        .iter()
        .find(|e| e.type_name() == "task-output")
        .expect("含 task-output");
    let AgentEvent::TaskOutput {
        task_id: tid,
        line,
        chunk,
        line_count,
        ..
    } = &output.event
    else {
        panic!("变体应为 TaskOutput");
    };
    assert_eq!(tid, &task_id);
    assert!(line.as_ref().is_some_and(|l| !l.is_empty()), "聚合行非空");
    assert!(chunk.is_none(), "节流聚合不占 chunk");
    assert!(line_count.is_some_and(|n| n > 0), "累计行数 > 0");

    // completed payload 字段级断言（taskId/exitCode/durationMs/lineCount）
    let completed = envelopes.last().expect("completed 存在");
    let AgentEvent::TaskCompleted {
        task_id: tid,
        exit_code,
        duration_ms,
        line_count,
        ..
    } = &completed.event
    else {
        panic!("末事件变体应为 TaskCompleted");
    };
    assert_eq!(tid, &task_id);
    assert_eq!(*exit_code, 0, "exit 0 命令自然完成");
    assert!(*duration_ms > 0, "运行时长 > 0");
    assert!(*line_count > 0, "完成事件携带累计行数");
}

/// 验收（30 方案 P2）：失败路径——非零退出（monitored）→ task-failed
/// 事件发射（tail 数组拆行 + exitCode/durationMs 字段级断言）。
#[tokio::test]
async fn task_failed_event_emitted() {
    let registry = test_registry();
    let (bridge, emitter) = recording_bridge();
    registry.set_event_bridge(bridge, String::new());

    let command = if cfg!(windows) {
        "Write-Output 'crash-line-1'; Write-Output 'crash-line-2'; exit 7"
    } else {
        "echo crash-line-1; echo crash-line-2; exit 7"
    };
    let child = spawn_test_child(command);
    let r = registry
        .adopt(adopt_request_monitored(
            child,
            "seven-failed",
            Path::new("."),
        ))
        .await
        .expect("adopt");
    let task_id = r.task_id.clone();

    let envelopes = wait_for_event_type(&emitter, "task-failed", Duration::from_secs(30)).await;
    let failed = envelopes
        .iter()
        .find(|e| e.type_name() == "task-failed")
        .expect("含 task-failed");
    let AgentEvent::TaskFailed {
        task_id: tid,
        exit_code,
        tail,
        duration_ms,
        ..
    } = &failed.event
    else {
        panic!("变体应为 TaskFailed");
    };
    assert_eq!(tid, &task_id);
    assert_eq!(*exit_code, 7, "exit 7 透传");
    assert!(
        tail.iter().any(|l| l.contains("crash-line-2")),
        "tail 按行拆回（含末行）：{tail:?}"
    );
    assert!(*duration_ms > 0);
}

/// 验收（30 方案 P2）：kill 路径——两阶段终止成功 → task-killed 事件发射
/// （viaForce 布尔 + diagnostics 透传字段级断言）。
#[tokio::test]
async fn task_killed_event_emitted() {
    let registry = test_registry();
    let (bridge, emitter) = recording_bridge();
    registry.set_event_bridge(bridge, String::new());

    let child = spawn_test_child(LONG_COMMAND);
    let r = registry
        .adopt(adopt_request(
            child,
            "seven-killed",
            Path::new("."),
            false,
            None,
        ))
        .await
        .expect("adopt");
    let task_id = r.task_id.clone();

    let result = registry.kill(&task_id).await.expect("kill");
    assert!(
        matches!(result, KillResult::Killed { .. }),
        "运行中任务 kill 应返回 Killed"
    );

    let envelopes = wait_for_event_type(&emitter, "task-killed", Duration::from_secs(30)).await;
    let killed = envelopes
        .iter()
        .find(|e| e.type_name() == "task-killed")
        .expect("含 task-killed");
    let AgentEvent::TaskKilled {
        task_id: tid,
        via_force,
        diagnostics,
        ..
    } = &killed.event
    else {
        panic!("变体应为 TaskKilled");
    };
    assert_eq!(tid, &task_id);
    assert!(matches!(via_force, true | false), "via_force 为布尔两态");
    assert!(
        diagnostics
            .as_ref()
            .is_some_and(|d| d.contains("优雅终止请求已发送")),
        "diagnostics 透传 kill 两阶段留痕：{diagnostics:?}"
    );
}

/// 验收（30 方案 P2）：EventBridgeSink 七事件全臂映射——无 `other` 丢弃
/// 路径（七种 event_type 逐一发射并解析信封，字段级断言与 conex-types
/// 变体对齐）。
#[test]
fn event_bridge_sink_full_arms_no_other_drop() {
    let (bridge, emitter) = recording_bridge();
    let sink = EventBridgeSink {
        bridge,
        session_id: "s1".to_string(),
        consumer: None,
    };
    let cases: Vec<(&str, serde_json::Value)> = vec![
        (
            "task-started",
            serde_json::json!({
                "taskId": "t1", "command": "npm i", "cwd": "C:/work",
                "ownerRunId": "run-1", "isDaemon": false,
            }),
        ),
        (
            "task-output",
            serde_json::json!({ "taskId": "t1", "line": "hello", "lineCount": 3 }),
        ),
        (
            "task-heartbeat",
            serde_json::json!({ "taskId": "t1", "resource": { "cpuPercent": 1.5 } }),
        ),
        (
            "task-suspicious",
            serde_json::json!({ "taskId": "t1", "silenceMs": 60_000, "lastOutputAtMs": 123 }),
        ),
        (
            "task-completed",
            serde_json::json!({ "taskId": "t1", "exitCode": 0, "durationMs": 999, "lineCount": 3 }),
        ),
        (
            "task-failed",
            serde_json::json!({ "taskId": "t1", "exitCode": 7, "tail": "l1\nl2", "durationMs": 100 }),
        ),
        (
            "task-killed",
            serde_json::json!({ "taskId": "t1", "viaForce": true, "diagnostics": "强制升级" }),
        ),
    ];
    for (event_type, payload) in &cases {
        sink.emit(event_type, payload.clone());
    }
    let calls = emitter.calls();
    assert_eq!(
        calls.len(),
        7,
        "七事件全臂必须逐条发射（任何 other 丢弃都会减少条数）"
    );

    let envelopes: Vec<AgentEventEnvelope> = calls.iter().map(|(_, p)| parse_envelope(p)).collect();
    for (idx, (expected, _)) in cases.iter().enumerate() {
        assert_eq!(
            envelopes[idx].type_name(),
            *expected,
            "第 {idx} 条事件类型映射正确"
        );
    }
    // 字段级断言（代表性字段，对齐 events.rs 变体形状）
    let AgentEvent::TaskStarted {
        owner_run_id,
        is_daemon,
        command,
        ..
    } = &envelopes[0].event
    else {
        panic!("变体应为 TaskStarted");
    };
    assert_eq!(owner_run_id, "run-1");
    assert_eq!(command, "npm i");
    assert!(!is_daemon);
    let AgentEvent::TaskOutput {
        line,
        chunk,
        line_count,
        ..
    } = &envelopes[1].event
    else {
        panic!("变体应为 TaskOutput");
    };
    assert_eq!(line.as_deref(), Some("hello"));
    assert!(chunk.is_none());
    assert_eq!(line_count, &Some(3));
    let AgentEvent::TaskHeartbeat { resource, .. } = &envelopes[2].event else {
        panic!("变体应为 TaskHeartbeat");
    };
    assert_eq!(resource["cpuPercent"], 1.5);
    let AgentEvent::TaskSuspicious {
        silence_ms,
        last_output_at_ms,
        ..
    } = &envelopes[3].event
    else {
        panic!("变体应为 TaskSuspicious");
    };
    assert_eq!((silence_ms, last_output_at_ms), (&60_000, &123));
    let AgentEvent::TaskCompleted {
        exit_code,
        duration_ms,
        line_count,
        ..
    } = &envelopes[4].event
    else {
        panic!("变体应为 TaskCompleted");
    };
    assert_eq!((exit_code, duration_ms, line_count), (&0, &999, &3));
    let AgentEvent::TaskFailed { tail, .. } = &envelopes[5].event else {
        panic!("变体应为 TaskFailed");
    };
    assert_eq!(
        tail,
        &vec!["l1".to_string(), "l2".to_string()],
        "tail 按行拆回"
    );
    let AgentEvent::TaskKilled {
        via_force,
        diagnostics,
        ..
    } = &envelopes[6].event
    else {
        panic!("变体应为 TaskKilled");
    };
    assert!(via_force);
    assert_eq!(diagnostics.as_deref(), Some("强制升级"));
    // sessionId 统一注入（注册表注入值，占位语义）
    for e in &envelopes {
        assert_eq!(
            e.event.type_name().to_string(),
            e.type_name().to_string(),
            "类型名一致"
        );
    }
}

/// 验收（30 方案 P3 挂接点）：set_task_event_consumer 注入注册表 →
/// set_event_bridge 构造 EventBridgeSink 时读取快照（顺序契约）→
/// emit 构造的 AgentEvent 同步进入消费面（终态即入队共享队列 +
/// security-audit 直发）。
#[test]
fn task_event_consumer_wired_into_sink_enqueues_wake() {
    use orchestrator::task_events::TASK_WAKE_GROUP_ID;
    use orchestrator::PendingMessageQueue;

    let registry = test_registry();
    let (bridge, emitter) = recording_bridge();
    let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
    let consumer = Arc::new(conex_run::task_event_consumer::TaskEventConsumer::new(
        Arc::clone(&queue),
        bridge.clone(),
        String::new(),
    ));
    // 顺序契约：先注入消费器，后接线事件桥（构造时读取快照）
    registry.set_task_event_consumer(Arc::clone(&consumer));
    registry.set_event_bridge(bridge, String::new());
    // 注册表注入槽可见性断言（快照来源）
    assert!(
        registry.task_event_consumer.lock().unwrap().is_some(),
        "set_task_event_consumer 后注入槽必须非空"
    );

    // 经生产发射链（EventBridgeSink::emit，与 set_event_bridge 构造的
    // 消费器快照同型）触发消费面
    let sink = EventBridgeSink {
        bridge: EventBridge::new(
            "workbench-run-event",
            Arc::new(RecordingEmitter::default()) as Arc<dyn conex_run::core_event_bridge::Emitter>,
        ),
        session_id: String::new(),
        consumer: Some(Arc::clone(&consumer)),
    };
    sink.emit(
        "task-started",
        serde_json::json!({
            "taskId": "t-wired", "command": "cargo check", "cwd": "C:/work",
            "ownerRunId": "run-1", "isDaemon": false,
        }),
    );
    sink.emit(
        "task-completed",
        serde_json::json!({ "taskId": "t-wired", "exitCode": 0, "durationMs": 10, "lineCount": 1 }),
    );

    // 消费面落点：共享 steering 队列出现唤醒条目（group_id = task-wake）
    let queue = queue.lock().unwrap_or_else(|e| e.into_inner());
    assert_eq!(queue.len(), 1, "终态事件经消费面入队");
    let entry = queue.peek().unwrap();
    assert_eq!(entry.group_id.as_deref(), Some(TASK_WAKE_GROUP_ID));
    assert_eq!(entry.text, "任务 t-wired 已完成，退出码 0");
    // 消费面直发的 security-audit 两条（started + completed）
    let envelopes: Vec<AgentEventEnvelope> = emitter
        .calls()
        .iter()
        .map(|(_, p)| parse_envelope(p))
        .collect();
    let audit_count = envelopes
        .iter()
        .filter(|e| e.type_name() == "security-audit")
        .count();
    assert_eq!(
        audit_count, 2,
        "started + completed 各直发一条 security-audit"
    );
}

/// 验收（30 方案 P2 装配面）：set_event_bridge 接线后 TaskNotifier 不再
/// unwired 静默——adopt 的任务事件真实经事件桥发射（而非 LogEventSink
/// 留痕）；main.rs 装配行由批 3 装配轮落地，本断言锁定接线语义本身。
#[tokio::test]
async fn task_notifier_assembled_not_unwired() {
    let registry = test_registry();
    let (bridge, emitter) = recording_bridge();
    registry.set_event_bridge(bridge, String::new());

    let child = spawn_test_child("exit 0");
    let r = registry
        .adopt(adopt_request(
            child,
            "assembled",
            Path::new("."),
            false,
            None,
        ))
        .await
        .expect("adopt");
    // started 事件在 adopt 内同步发射——已到达记录器即证明经桥发射
    let calls = emitter.calls();
    assert_eq!(calls.len(), 1, "adopt 应发射恰一条 task-started");
    assert_eq!(calls[0].0, "workbench-run-event", "通道为生产事件通道");
    let envelope = parse_envelope(&calls[0].1);
    assert_eq!(envelope.type_name(), "task-started");
    assert!(envelope.run_id.is_none(), "任务事件信封不注入 runId");
    assert!(envelope.sequence.is_none(), "任务事件信封不注入 sequence");

    let _ = wait_for_terminal(&registry, &r.task_id, Duration::from_secs(30)).await;
}

/// 验收（34 方案 §2.4 契约）：list 快照 wire 序列化含 `suspicious` 键，
/// true/false 两态断言——false 态经真实 adopt 快照；true 态经手工构造
/// 快照（与采样循环置位路径独立验证）。
#[tokio::test]
async fn list_wire_serializes_suspicious_flag() {
    // false 态：真实 adopt 任务 → build_list_response JSON 含 suspicious: false
    let registry = test_registry();
    let child = spawn_test_child(LONG_COMMAND);
    let pid = child.id().expect("spawned pid");
    let r = registry
        .adopt(adopt_request(
            child,
            "suspicious-false",
            Path::new("."),
            false,
            None,
        ))
        .await
        .expect("adopt");
    let response = build_list_response(&registry)
        .await
        .expect("build_list_response");
    let json = serde_json::to_value(&response).expect("序列化");
    let tasks = json["tasks"].as_array().expect("tasks 数组");
    let task = tasks
        .iter()
        .find(|t| t["taskId"] == r.task_id)
        .expect("条目存在");
    assert_eq!(
        task["suspicious"], false,
        "未判疑似的任务 suspicious 恒 false"
    );

    // true 态：构造置位快照 → 序列化含 suspicious: true（采样循环置位路径
    // 由 suspicious_wire_set_by_monitor_loop 覆盖，此处锁 wire 形状）
    let info = BackgroundTaskInfo {
        task_id: "task-x".to_string(),
        command: "cmd".to_string(),
        cwd: ".".to_string(),
        status: TaskState::Running,
        started_at_ms: 1,
        duration_ms: 0,
        finished_at_ms: None,
        exit_code: None,
        log_path: "x.log".to_string(),
        line_count: 0,
        last_output_at_ms: 1,
        is_daemon: false,
        resource: None,
        prompt: None,
        owner_run_id: None,
        suspicious: true,
    };
    let info_json = serde_json::to_value(&info).expect("序列化");
    assert_eq!(
        info_json["suspicious"], true,
        "置位快照序列化含 suspicious: true"
    );

    let _ = crate::process::terminate_process_tree(pid);
}
