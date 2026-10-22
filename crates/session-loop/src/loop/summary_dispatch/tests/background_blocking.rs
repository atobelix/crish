use super::*;

// ── EV-06 summary-background 事件面（spawn/重试/成功/失败/放弃）────

/// 成功路径：spawn → 退避重试 → success 序列（attempt 单调递增；
/// 首次重试即成功：attempt=2，含同步那次口径）
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn background_events_spawn_to_success_sequence() {
    let summarizer = Arc::new(RecordingSummarizer {
        calls: std::sync::Mutex::new(Vec::new()),
        result: std::sync::Mutex::new(Ok(valid_json("compacted-summary-1-1"))),
    });
    let sink = Arc::new(RecordingSummarySink::new());
    let dispatch = SummaryDispatch::new(fast_config());
    dispatch.set_background_sink(Some(Arc::clone(&sink) as SummaryBackgroundSinkRef));
    assert!(
        dispatch.try_spawn(task_with(summarizer.clone(), "compacted-summary-1-1"), None),
        "spawn 必须成功"
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    let phases = summary_phases(&sink.events());
    let names: Vec<&str> = phases.iter().map(|(p, _, _)| p.as_str()).collect();
    assert_eq!(
        names,
        vec!["spawned", "attempt", "success"],
        "成功路径序列 = spawned → attempt → success：{phases:?}"
    );
    assert_eq!(phases[0].1, 1, "spawned attempt=1");
    assert_eq!(phases[1].1, 2, "首次重试 attempt=2（含同步那次）");
    assert_eq!(phases[2].1, 2, "success attempt=2");
    // attempt 序号单调
    for pair in phases.windows(2) {
        assert!(pair[1].1 >= pair[0].1, "attempt 序号必须单调：{phases:?}");
    }
    // spawned 携带任务关联（messageId = 块 id）
    let spawned = &sink.events()[0];
    if let AgentEvent::SummaryBackground { message_id, .. } = spawned {
        assert_eq!(message_id.as_deref(), Some("compacted-summary-1-1"));
    } else {
        panic!("首事件必须是 SummaryBackground");
    }
}

/// 失败路径：spawn → 退避重试全部失败 → give-up（MAX_SUMMARY_ATTEMPTS
/// 触顶）——用户可据此区分「正在补摘要」与「已放弃」；give-up 带原因
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn background_events_failure_to_give_up_sequence() {
    let summarizer = Arc::new(RecordingSummarizer {
        calls: std::sync::Mutex::new(Vec::new()),
        result: std::sync::Mutex::new(Err("摘要器持续失败".to_string())),
    });
    let sink = Arc::new(RecordingSummarySink::new());
    let dispatch = SummaryDispatch::new(fast_config());
    dispatch.set_background_sink(Some(Arc::clone(&sink) as SummaryBackgroundSinkRef));
    assert!(dispatch.try_spawn(task_with(summarizer.clone(), "compacted-summary-1-1"), None));
    tokio::time::sleep(Duration::from_millis(300)).await;
    let phases = summary_phases(&sink.events());
    let names: Vec<&str> = phases.iter().map(|(p, _, _)| p.as_str()).collect();
    assert_eq!(
        names,
        vec![
            "spawned", "attempt", "failure", "attempt", "failure", "attempt", "failure", "give-up",
        ],
        "失败路径序列 = spawned → (attempt → failure) ×3 → give-up：{phases:?}"
    );
    // give-up：attempt=4（触顶，含同步那次）+ 带放弃原因
    let give_up = phases.last().expect("必须以 give-up 收尾");
    assert_eq!(give_up.0, "give-up");
    assert_eq!(give_up.1, 4, "give-up attempt = MAX_SUMMARY_ATTEMPTS");
    let reason = give_up.2.as_deref().expect("give-up 必须带原因");
    assert!(
        reason.contains("MAX_SUMMARY_ATTEMPTS=4"),
        "give-up 原因含触顶口径：{reason}"
    );
    // 每次 failure 带失败原因（区分「正在补」各次失败可查）
    for failure in phases.iter().filter(|(p, _, _)| p == "failure") {
        assert!(failure.2.is_some(), "failure 必须带原因");
    }
    // 事件总条数 = 8（1 spawned + 3 attempt + 3 failure + 1 give-up）
    assert_eq!(phases.len(), 8);
}

/// 护栏拒绝路径：窗口内累计达上限 → 新触发被拒 → 发射 give-up（不
/// 发射 spawned——任务未启动；reason = 护栏上限文案）
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn background_events_gate_denied_emits_give_up() {
    let summarizer = Arc::new(RecordingSummarizer {
        calls: std::sync::Mutex::new(Vec::new()),
        result: std::sync::Mutex::new(Err("持续失败".to_string())),
    });
    let sink = Arc::new(RecordingSummarySink::new());
    let dispatch = SummaryDispatch::new(fast_config());
    dispatch.set_background_sink(Some(Arc::clone(&sink) as SummaryBackgroundSinkRef));
    // 护栏上限 2：episode 1 的 4 次尝试已超上限 → 后续触发被拒绝
    dispatch.set_retry_guard(SummaryRetryGuardConfig {
        max_attempts: 2,
        retry_window_ms: 60_000,
    });
    assert!(
        dispatch.try_spawn(task_with(summarizer.clone(), "compacted-summary-1-1"), None),
        "episode 1（累计 0 < 2）必须放行"
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    let before = summary_phases(&sink.events());
    // episode 1 耗尽已发射 give-up（触顶 → awaiting 待被动触发）
    let episode_give_up = before.last().expect("episode 耗尽以 give-up 收尾");
    assert_eq!(episode_give_up.0, "give-up");
    assert!(
        episode_give_up
            .2
            .as_deref()
            .map(|r| r.contains("MAX_SUMMARY_ATTEMPTS"))
            .unwrap_or(false),
        "episode 耗尽 give-up 原因 = 触顶口径"
    );
    // 第二次触发：窗口内累计 4 >= 2 → 护栏拒绝
    assert!(
        !dispatch.try_spawn(task_with(summarizer.clone(), "compacted-summary-1-2"), None),
        "窗口内累计达护栏上限 → 拒绝"
    );
    let after = summary_phases(&sink.events());
    assert_eq!(
        after.len(),
        before.len() + 1,
        "被拒触发必须补发一条 give-up"
    );
    let denied = after.last().expect("最后一条为 give-up");
    assert_eq!(denied.0, "give-up");
    assert_eq!(denied.1, 4, "give-up attempt = 窗口内已累计尝试数");
    let reason = denied.2.as_deref().expect("give-up 必须带原因");
    assert!(reason.contains("低功耗护栏"), "护栏拒绝原因：{reason}");
    assert!(
        before
            .first()
            .map(|(p, _, _)| p == "spawned")
            .unwrap_or(false),
        "episode 1 以 spawned 开头（事件面完整）：{before:?}"
    );
}

// ── D10-A / summarize_via_blocking 单源 helper ────────────────────

/// 成功路径：spawn_blocking + 墙钟内返回 Ok（与 summarize_once 同源）
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn summarize_via_blocking_success_returns_text() {
    let summarizer = Arc::new(RecordingSummarizer {
        calls: std::sync::Mutex::new(Vec::new()),
        result: std::sync::Mutex::new(Ok(valid_json("compacted-summary-1-1"))),
    });
    let text = summarize_via_blocking(summarizer, dropped_messages(), None, 5_000)
        .await
        .expect("成功摘要必须 Ok");
    assert!(
        validate_summary_document(&text, 4096).is_ok(),
        "helper 返回必须是合法 Schema V1 JSON"
    );
}

/// 失败透传：Summarizer Err → Err（不吞错误）
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn summarize_via_blocking_propagates_err() {
    let summarizer = Arc::new(RecordingSummarizer {
        calls: std::sync::Mutex::new(Vec::new()),
        result: std::sync::Mutex::new(Err("摘要器失败".to_string())),
    });
    let err = summarize_via_blocking(summarizer, dropped_messages(), None, 5_000)
        .await
        .expect_err("失败摘要必须 Err");
    assert!(err.contains("摘要器失败"), "错误文本透传：{err}");
}

/// 墙钟：挂起调用超过 max_wall_ms → Err 超时文案（不永久挂起）
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn summarize_via_blocking_wall_clock_timeout() {
    struct Hung;
    impl Summarizer for Hung {
        fn summarize(
            &self,
            _dropped: &[AgentMessage],
            _existing: Option<&str>,
        ) -> Result<String, String> {
            std::thread::sleep(Duration::from_millis(2_000));
            Ok(valid_json("compacted-summary-1-1"))
        }
    }
    let err = summarize_via_blocking(Arc::new(Hung), dropped_messages(), None, 50)
        .await
        .expect_err("超时必须 Err");
    assert!(err.contains("超时"), "超时文案含「超时」：{err}");
}

/// SL-PERF-04：信号已置位时直接中断，不进入阻塞调用
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn summarize_via_blocking_with_abort_pre_aborted() {
    let summarizer = Arc::new(RecordingSummarizer {
        calls: std::sync::Mutex::new(Vec::new()),
        result: std::sync::Mutex::new(Ok(valid_json("compacted-summary-1-1"))),
    });
    let signal = AbortSignal::new();
    signal.abort();
    let err = summarize_via_blocking_with_abort(
        summarizer.clone(),
        dropped_messages(),
        None,
        5_000,
        Some(&signal),
    )
    .await
    .expect_err("已 abort 必须直接 Err");
    assert!(err.contains("abort"), "错误信息包含 abort：{err}");
    assert_eq!(
        summarizer.calls.lock().unwrap().len(),
        0,
        "不应进入阻塞执行"
    );
}

/// SL-PERF-04：阻塞调用期间 abort 信号触发，及时抢断（不卡死 5000ms）
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn summarize_via_blocking_with_abort_interrupts_hung() {
    struct LongTask;
    impl Summarizer for LongTask {
        fn summarize(
            &self,
            _dropped: &[AgentMessage],
            _existing: Option<&str>,
        ) -> Result<String, String> {
            std::thread::sleep(Duration::from_millis(3_000));
            Ok(valid_json("compacted-summary-1-1"))
        }
    }
    let signal = Arc::new(AbortSignal::new());
    let signal_clone = signal.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        signal_clone.abort();
    });
    let start = std::time::Instant::now();
    let err = summarize_via_blocking_with_abort(
        Arc::new(LongTask),
        dropped_messages(),
        None,
        10_000,
        Some(&signal),
    )
    .await
    .expect_err("抢断必须 Err");
    assert!(err.contains("abort"), "错误信息包含 abort：{err}");
    assert!(
        start.elapsed() < Duration::from_millis(1_000),
        "必须在 1 秒内及时抢断"
    );
}

/// SL-PERF-04：后台任务退避睡眠期间监听 abort 信号并及时退出
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn run_summary_task_with_abort_interrupts_backoff() {
    let summarizer = Arc::new(RecordingSummarizer {
        calls: std::sync::Mutex::new(Vec::new()),
        result: std::sync::Mutex::new(Err("初次失败".to_string())),
    });
    let task = task_with(summarizer, "compacted-summary-1-1");
    let config = SummaryDispatchConfig {
        backoff_ms: vec![5_000, 5_000],
        jitter: 0.0,
        max_wall_ms: 1_000,
        max_attempts: 3,
    };
    let signal = Arc::new(AbortSignal::new());
    let signal_clone = signal.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        signal_clone.abort();
    });
    let start = std::time::Instant::now();
    run_summary_task_with_abort(task, config, None, None, Some(signal)).await;
    assert!(
        start.elapsed() < Duration::from_millis(1_000),
        "退避睡眠被抢断，耗时应远小于 5000ms"
    );
}
