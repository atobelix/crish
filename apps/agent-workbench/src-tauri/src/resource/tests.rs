//! resource 测试（resource.rs 拆分）：健康判定 / CPU 差值 / 通知形状与节流。

use super::*;

/// 三态判定矩阵（T-AB-16 1）：
/// - CPU 活跃 → Healthy（即使长时间无输出）；
/// - 最近 M 秒内有输出 → Healthy（即使 CPU 近零）；
/// - CPU 近零 + 超过 M 秒无输出 → Suspicious。
#[test]
fn judge_health_matrix() {
    let config = ResourceMonitorConfig {
        sample_interval_ms: 2000,
        silence_threshold_ms: 60_000,
    };
    let now = 1_000_000;
    // CPU 活跃（50%）+ 120s 无输出 → Healthy（编译类长静默任务不误报）
    assert_eq!(
        judge_health(now, now - 120_000, 50.0, &config),
        ProcessHealth::Healthy
    );
    // CPU 近零 + 最近 30s 有输出 → Healthy
    assert_eq!(
        judge_health(now, now - 30_000, 0.0, &config),
        ProcessHealth::Healthy
    );
    // CPU 近零 + 超过 60s 无输出 → Suspicious
    assert_eq!(
        judge_health(now, now - 120_000, 0.0, &config),
        ProcessHealth::Suspicious
    );
    // 阈值边界：恰在静默阈值内（60s）→ 仍 Healthy
    assert_eq!(
        judge_health(now, now - 60_000, 0.0, &config),
        ProcessHealth::Healthy
    );
    // 阈值边界外 1ms → Suspicious
    assert_eq!(
        judge_health(now, now - 60_001, 0.0, &config),
        ProcessHealth::Suspicious
    );
}

/// CPU% 差值语义（T-AB-15 3 首采样丢弃的数值保证）：
/// - 零差值（同基线）→ 0.0 而非 NaN；
/// - 墙钟零差值 → 0.0（不除零）；
/// - 正常差值 → [0, 100] 区间；
/// - 差值回退（非单调防御）→ clamp 0。
#[test]
fn cpu_percent_delta_is_finite_and_bounded() {
    let prev = RawUsage {
        cpu_ms: 1000,
        rss_bytes: 4096,
    };
    // 零差值：不产生 NaN/异常值（首采样无基线时循环直接丢弃，本函数保证
    // 即使被误调也不出非有限值）
    let same = RawUsage {
        cpu_ms: 1000,
        rss_bytes: 4096,
    };
    assert_eq!(cpu_percent_from_delta(&prev, &same, 1000, 3000), 0.0);
    // 墙钟零差值：不除零
    assert_eq!(cpu_percent_from_delta(&prev, &same, 3000, 3000), 0.0);
    // 正常：2s 窗口内 500ms CPU → 25%
    let busy = RawUsage {
        cpu_ms: 1500,
        rss_bytes: 4096,
    };
    assert_eq!(cpu_percent_from_delta(&prev, &busy, 1000, 3000), 25.0);
    // 差值回退（时钟异常）：clamp 下限 0
    let lower = RawUsage {
        cpu_ms: 800,
        rss_bytes: 4096,
    };
    assert_eq!(cpu_percent_from_delta(&prev, &lower, 1000, 3000), 0.0);
}

/// 通知投递形状（T-AB-16 2/3）：nudge 文本含任务 id、文案关键点与
/// 「由 AI 裁决」声明；事件 payload 字段与冻结契约 §4.5 一致
/// （task-suspicious：taskId/silenceMs/lastOutputAtMs；
/// task-failed：taskId/exitCode/tail/durationMs）。
#[test]
fn notifier_message_and_payload_shape() {
    let queue = Arc::new(Mutex::new(VecDeque::new()));
    let emitted = Arc::new(Mutex::new(Vec::new()));
    struct MemSink(Arc<Mutex<Vec<(String, serde_json::Value)>>>);
    impl std::fmt::Debug for MemSink {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "MemSink")
        }
    }
    impl EventSink for MemSink {
        fn emit(&self, event_type: &str, payload: serde_json::Value) {
            self.0
                .lock()
                .unwrap()
                .push((event_type.to_string(), payload));
        }
    }
    let notifier = TaskNotifier {
        nudge_queue: Some(queue.clone()),
        event_sink: Some(Arc::new(MemSink(emitted.clone()))),
        ..Default::default()
    };

    notifier.notify_suspicious("task-7", 60_000, 1234);
    {
        let q = queue.lock().unwrap();
        assert_eq!(q.len(), 1);
        let text = &q[0];
        assert!(text.contains("task-7"), "通知含任务 id：{text}");
        assert!(text.contains("疑似卡死"), "文案含疑似卡死：{text}");
        assert!(text.contains("60 秒无输出"), "文案含静默时长：{text}");
        assert!(text.contains("由 AI 裁决"), "文案注明 AI 裁决：{text}");
        assert!(text.contains("不自动终止"), "文案注明不自动终止：{text}");
    }
    {
        let events = emitted.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "task-suspicious");
        let payload = &events[0].1;
        assert_eq!(payload["taskId"], "task-7");
        assert_eq!(payload["silenceMs"], 60_000);
        assert_eq!(payload["lastOutputAtMs"], 1234);
    }

    notifier.notify_failed("task-8", 7, "line1\nline2", 999);
    {
        let q = queue.lock().unwrap();
        assert_eq!(q.len(), 2, "第二次通知追加（防抖由采样循环负责）");
        assert!(q[1].contains("task-8") && q[1].contains("exit code 7"));
    }
    {
        let events = emitted.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].0, "task-failed");
        assert_eq!(events[1].1["exitCode"], 7);
        assert_eq!(events[1].1["tail"], "line1\nline2");
        assert_eq!(events[1].1["durationMs"], 999);
    }
}

/// 五新投递方法载荷断言（30 方案 P2）：started/output/heartbeat/completed/
/// killed 的 payload 与 conex-types events.rs 变体字段逐一对齐
/// （taskId/command/cwd/ownerRunId/isDaemon；taskId/line/lineCount；
/// taskId/resource；taskId/exitCode/durationMs/lineCount；
/// taskId/viaForce/diagnostics）。
#[test]
fn notifier_five_new_methods_payloads() {
    struct MemSink(Arc<Mutex<Vec<(String, serde_json::Value)>>>);
    impl std::fmt::Debug for MemSink {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "MemSink")
        }
    }
    impl EventSink for MemSink {
        fn emit(&self, event_type: &str, payload: serde_json::Value) {
            self.0
                .lock()
                .unwrap()
                .push((event_type.to_string(), payload));
        }
    }
    let emitted = Arc::new(Mutex::new(Vec::new()));
    let notifier = TaskNotifier {
        event_sink: Some(Arc::new(MemSink(Arc::clone(&emitted)))),
        ..Default::default()
    };

    notifier.notify_started("task-1", "npm install", "C:/work", "run-9", true);
    // 同一节流窗口内两条输出 → 窗口未闭合不发射（合并断言见节流用例）
    notifier.notify_output("task-1", "line-a", 1);
    notifier.notify_output("task-1", "line-b", 2);
    // 完成投递前冲刷窗口：补发聚合 output（窗口内最后一行 + 最新行数）
    notifier.notify_completed("task-1", 0, 1234, 2);
    notifier.notify_heartbeat("task-1", serde_json::json!({ "cpuPercent": 5.0 }));
    notifier.notify_killed("task-2", true, Some("强制终止升级".to_string()));

    let events = emitted.lock().unwrap();
    // 序号：started(0) / output-flush(1) / completed(2) / heartbeat(3) / killed(4)
    assert_eq!(
        events.len(),
        5,
        "五方法应各发射一条（输出窗口在完成时冲刷）"
    );
    // started：taskId/command/cwd/ownerRunId/isDaemon
    assert_eq!(events[0].0, "task-started");
    let p = &events[0].1;
    assert_eq!(p["taskId"], "task-1");
    assert_eq!(p["command"], "npm install");
    assert_eq!(p["cwd"], "C:/work");
    assert_eq!(p["ownerRunId"], "run-9");
    assert_eq!(p["isDaemon"], true);
    // output（冲刷）：聚合内容 = 窗口内最后一行 + 最新累计行数
    assert_eq!(events[1].0, "task-output");
    let p = &events[1].1;
    assert_eq!(p["taskId"], "task-1");
    assert_eq!(p["line"], "line-b");
    assert_eq!(p["lineCount"], 2);
    // completed：taskId/exitCode/durationMs/lineCount
    assert_eq!(events[2].0, "task-completed");
    let p = &events[2].1;
    assert_eq!(p["taskId"], "task-1");
    assert_eq!(p["exitCode"], 0);
    assert_eq!(p["durationMs"], 1234);
    assert_eq!(p["lineCount"], 2);
    // heartbeat：taskId/resource（资源摘要原样透传）
    assert_eq!(events[3].0, "task-heartbeat");
    let p = &events[3].1;
    assert_eq!(p["taskId"], "task-1");
    assert_eq!(p["resource"]["cpuPercent"], 5.0);
    // killed：taskId/viaForce/diagnostics
    assert_eq!(events[4].0, "task-killed");
    let p = &events[4].1;
    assert_eq!(p["taskId"], "task-2");
    assert_eq!(p["viaForce"], true);
    assert_eq!(p["diagnostics"], "强制终止升级");
}

/// 输出节流断言（30 方案 P2）：注入短窗口（30ms）——窗口内多条输出合并
/// 为一条（条数与聚合内容）；窗口边界发一条；已发射内容不重复。
#[test]
fn task_output_throttled_window() {
    struct MemSink(Arc<Mutex<Vec<(String, serde_json::Value)>>>);
    impl std::fmt::Debug for MemSink {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "MemSink")
        }
    }
    impl EventSink for MemSink {
        fn emit(&self, event_type: &str, payload: serde_json::Value) {
            self.0
                .lock()
                .unwrap()
                .push((event_type.to_string(), payload));
        }
    }
    let emitted = Arc::new(Mutex::new(Vec::new()));
    // 注入 30ms 短窗口（生产默认 100ms）+ 内存事件收集器
    let mut notifier = TaskNotifier::with_output_window_ms(30);
    notifier.set_event_sink(Arc::new(MemSink(Arc::clone(&emitted))));

    // 窗口内两条输出：合并不发射（条数 0）
    notifier.notify_output("task-9", "line-1", 1);
    notifier.notify_output("task-9", "line-2", 2);
    assert_eq!(
        emitted.lock().unwrap().len(),
        0,
        "窗口内输出必须合并（不逐条发射）"
    );

    // 窗口边界：超过 30ms 后再次输出 → 聚合发一条（内容 = 最后一行）
    std::thread::sleep(std::time::Duration::from_millis(40));
    notifier.notify_output("task-9", "line-3", 3);
    {
        let events = emitted.lock().unwrap();
        assert_eq!(events.len(), 1, "窗口边界应恰发一条聚合输出");
        assert_eq!(events[0].0, "task-output");
        assert_eq!(events[0].1["line"], "line-3", "聚合内容 = 窗口内最后一行");
        assert_eq!(events[0].1["lineCount"], 3, "聚合行数 = 最新累计行数");
    }

    // 新窗口内一条输出（未到边界）后立即完成：终态冲刷补发窗口内
    // 最后一行（line-4），再发 completed——窗口未闭合内容不丢失
    notifier.notify_output("task-9", "line-4", 4);
    notifier.notify_completed("task-9", 0, 999, 4);
    {
        let events = emitted.lock().unwrap();
        assert_eq!(events.len(), 3, "冲刷补发 + completed 共 2 条新事件");
        assert_eq!(events[1].0, "task-output", "冲刷补发的是聚合输出");
        assert_eq!(events[1].1["line"], "line-4", "补发内容 = 窗口内最后一行");
        assert_eq!(events[1].1["lineCount"], 4);
        assert_eq!(events[2].0, "task-completed");
    }
    // 再次完成（无新输出内容）：flush 幂等——不再补发 task-output，
    // 仅新增一条 task-completed（事件非幂等由调用方保证单次）
    notifier.notify_completed("task-9", 0, 999, 4);
    {
        let events = emitted.lock().unwrap();
        assert_eq!(events.len(), 4, "第二次完成只发 completed");
        assert_eq!(events[3].0, "task-completed");
        assert_eq!(
            events.iter().filter(|e| e.0 == "task-output").count(),
            2,
            "flush 幂等：已发射输出不得重复补发"
        );
    }

    // 任务隔离：另一任务窗口互不串扰（新窗口首条输出未到边界不发射）
    notifier.notify_output("task-10", "other-line", 1);
    {
        let events = emitted.lock().unwrap();
        assert_eq!(events.len(), 4, "其他任务输出不得发射（按任务隔离）");
        assert_eq!(
            events.iter().filter(|e| e.0 == "task-output").count(),
            2,
            "task-10 首条输出未到边界，不得进入发射流"
        );
    }
}
