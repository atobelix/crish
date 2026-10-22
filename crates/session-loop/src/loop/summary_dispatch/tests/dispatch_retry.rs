use super::*;

/// 单飞：存活任务存在时第二次 spawn 被忽略（去重）
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn single_flight_dedupes_live_task() {
    let summarizer = Arc::new(RecordingSummarizer {
        calls: std::sync::Mutex::new(Vec::new()),
        result: std::sync::Mutex::new(Ok(valid_json("compacted-summary-1-1"))),
    });
    let dispatch = SummaryDispatch::new(fast_config());
    // 首次 spawn 成功
    assert!(dispatch.try_spawn(task_with(summarizer.clone(), "compacted-summary-1-1"), None));
    // 立即再 spawn（首任务仍在退避期存活）→ 去重
    assert!(!dispatch.try_spawn(task_with(summarizer.clone(), "compacted-summary-1-2"), None));
    // 等待任务结束：只有一次真实调用（第二次 spawn 被忽略）
    tokio::time::sleep(Duration::from_millis(50)).await;
    let calls = summarizer.calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 1, "单飞去重：同会话存活任务只执行一次");
    assert_eq!(calls[0].0, vec!["m0".to_string()], "摘要器只收到丢弃消息");
}

/// 退避序列（注入快速退避 + jitter=0）：失败 ×3 重试后 committed；
/// attempts 累计含同步那次（1 + 3 = 4）
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retries_with_backoff_then_commits() {
    let summarizer = Arc::new(RecordingSummarizer {
        calls: std::sync::Mutex::new(Vec::new()),
        result: std::sync::Mutex::new(Ok(valid_json("compacted-summary-1-1"))),
    });
    let outcomes = Arc::new(std::sync::Mutex::new(Vec::new()));
    let dispatch = SummaryDispatch::new(fast_config());
    let cb = {
        let outcomes = outcomes.clone();
        Box::new(move |o: SummaryDispatchOutcome| {
            outcomes.lock().unwrap().push(o);
        }) as SummaryOutcomeCallback
    };
    assert!(dispatch.try_spawn(
        task_with(summarizer.clone(), "compacted-summary-1-1"),
        Some(cb)
    ));
    // 等任务完成（退避 1ms×1 + 调用耗时）
    tokio::time::sleep(Duration::from_millis(200)).await;
    let done = outcomes.lock().unwrap().clone();
    assert_eq!(done.len(), 1, "回调必须恰好收到一次结果");
    let outcome = &done[0];
    assert_eq!(outcome.state, SummaryState::Committed);
    assert_eq!(
        outcome.attempts, 2,
        "首次重试即成功：attempts = 同步1 + 后台1"
    );
    assert_eq!(outcome.block_id, "compacted-summary-1-1");
    // 渲染 = 确定性 md 投影（R-G 语源）
    let markdown = outcome
        .rendered_markdown
        .as_deref()
        .expect("必须有 md 渲染");
    assert!(markdown.contains("修复构建"), "md 渲染含 goal 文本");
    let json = outcome
        .summary_json
        .as_deref()
        .expect("必须有 JSON 规范文档");
    assert!(
        validate_summary_document(json, 4096).is_ok(),
        "回调 JSON 必须合法"
    );
}

/// E2 F2 层 1（低功耗模式）：episode 耗尽（attempts = 4 = 同步 1 +
/// 后台 3）后**不 retired**——块保持 awaiting（待重试）；随后被动触发
/// 重新 spawn（同调度器，护栏窗口内放行）→ 摘要成功升级 committed。
/// 对应设计测试 5.3.1「第 5 次尝试后不 retired，块保持 awaiting，
/// 等待被动触发；触发后摘要成功升级 committed」
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retries_exhausted_awaits_then_passive_retry_commits() {
    let summarizer = Arc::new(RecordingSummarizer {
        calls: std::sync::Mutex::new(Vec::new()),
        result: std::sync::Mutex::new(Err("摘要器持续失败".to_string())),
    });
    let outcomes = Arc::new(std::sync::Mutex::new(Vec::new()));
    let dispatch = SummaryDispatch::new(fast_config());
    let cb = {
        let outcomes = outcomes.clone();
        Box::new(move |o: SummaryDispatchOutcome| {
            outcomes.lock().unwrap().push(o);
        }) as SummaryOutcomeCallback
    };
    // 第一段：episode 1 全部失败 → 耗尽待重试（不 retired）
    assert!(dispatch.try_spawn(
        task_with(summarizer.clone(), "compacted-summary-1-1"),
        Some(cb)
    ));
    tokio::time::sleep(Duration::from_millis(300)).await;
    let done = outcomes.lock().unwrap().clone();
    assert_eq!(done.len(), 1);
    assert_eq!(
        done[0].state,
        SummaryState::Awaiting,
        "episode 耗尽不 retired：块保持 awaiting（低功耗待重试，非永驻）"
    );
    assert_eq!(
        done[0].attempts, 4,
        "episode 耗尽：attempts = 同步1 + 退避重试3"
    );
    assert_eq!(done[0].summary_json, None);
    let calls = summarizer.calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 3, "后台只重试 3 次（上限 4 含同步）");
    // 第二段：被动触发（窗口内累计 4 < 默认护栏 8 → 放行）→ 成功。
    // 回调必须再次注入（FnOnce 不能复用，另建同源收集器）——否则第二
    // 段 outcome 只在护栏记账、不进 outcomes，断言收不到第二个结果
    *summarizer.result.lock().unwrap() = Ok(valid_json("compacted-summary-1-1"));
    let cb2 = {
        let outcomes = outcomes.clone();
        Box::new(move |o: SummaryDispatchOutcome| {
            outcomes.lock().unwrap().push(o);
        }) as SummaryOutcomeCallback
    };
    assert!(
        dispatch.try_spawn(
            task_with(summarizer.clone(), "compacted-summary-1-1"),
            Some(cb2),
        ),
        "被动触发必须放行（窗口内累计 4 < 8）"
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    let outcomes2 = outcomes.lock().unwrap().clone();
    assert_eq!(outcomes2.len(), 2, "第二段必须再次收到结果");
    assert_eq!(
        outcomes2[1].state,
        SummaryState::Committed,
        "被动触发后摘要成功升级 committed"
    );
    assert!(outcomes2[1].summary_json.is_some());
}

/// 非 JSON 输出 → 按失败尝试计数（R-G 新契约：输出必须合法 Schema V1）
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn invalid_json_output_counts_as_failed_attempt() {
    let summarizer = Arc::new(RecordingSummarizer {
        calls: std::sync::Mutex::new(Vec::new()),
        result: std::sync::Mutex::new(Ok("## Goal\n(none)".to_string())),
    });
    let outcomes = Arc::new(std::sync::Mutex::new(Vec::new()));
    let dispatch = SummaryDispatch::new(fast_config());
    let cb = {
        let outcomes = outcomes.clone();
        Box::new(move |o: SummaryDispatchOutcome| {
            outcomes.lock().unwrap().push(o);
        }) as SummaryOutcomeCallback
    };
    assert!(dispatch.try_spawn(
        task_with(summarizer.clone(), "compacted-summary-1-1"),
        Some(cb)
    ));
    tokio::time::sleep(Duration::from_millis(300)).await;
    let done = outcomes.lock().unwrap().clone();
    assert_eq!(done.len(), 1);
    assert_eq!(
        done[0].state,
        SummaryState::Awaiting,
        "非 JSON 输出全部按失败计数 → episode 耗尽待重试（不 retired）"
    );
    assert_eq!(done[0].attempts, 4);
}

/// 墙钟上限：调用挂起超过 max_wall_ms → 按失败尝试计数
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wall_clock_cap_times_out_hung_call() {
    struct HungSummarizer;
    impl Summarizer for HungSummarizer {
        fn summarize(
            &self,
            _dropped: &[AgentMessage],
            _existing: Option<&str>,
        ) -> Result<String, String> {
            std::thread::sleep(Duration::from_millis(2_000));
            Ok(valid_json("compacted-summary-1-1"))
        }
    }
    let outcomes = Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut config = fast_config();
    config.max_wall_ms = 50; // 注入短墙钟：调用必然超时
    let dispatch = SummaryDispatch::new(config);
    let cb = {
        let outcomes = outcomes.clone();
        Box::new(move |o: SummaryDispatchOutcome| {
            outcomes.lock().unwrap().push(o);
        }) as SummaryOutcomeCallback
    };
    assert!(dispatch.try_spawn(
        task_with(Arc::new(HungSummarizer), "compacted-summary-1-1"),
        Some(cb),
    ));
    tokio::time::sleep(Duration::from_millis(400)).await;
    let done = outcomes.lock().unwrap().clone();
    assert_eq!(done.len(), 1);
    assert_eq!(
        done[0].state,
        SummaryState::Awaiting,
        "超时按失败计数 → episode 耗尽待重试（不 retired）"
    );
    assert_eq!(done[0].attempts, 4);
}

/// attempts 计数器语义：累计含同步那次（引擎内已尝试 1 次）
#[test]
fn attempts_includes_sync_attempt() {
    let config = fast_config();
    assert_eq!(config.max_attempts, 4);
    // 退避序列 3 项 = 后台至多 3 次重试 → 累计 1 + 3 = 4
    assert_eq!(config.backoff_ms.len(), 3);
    assert_eq!(config.max_attempts, config.backoff_ms.len() as u32 + 1);
}

/// jitter=0.0 → 确定性退避（同 base 同输出）
#[test]
fn jitter_zero_is_deterministic() {
    assert_eq!(jittered_ms(100, 0.0), 100);
    assert_eq!(jittered_ms(100, 0.0), 100);
    // 有 jitter 时结果在 [base×0.8, base×1.2] 内
    let jittered = jittered_ms(100, 0.2);
    assert!(
        (80..=120).contains(&jittered),
        "jitter 幅度钳制 ±20%：{jittered}"
    );
}

/// 单飞状态恢复：任务完成后可再 spawn（同 run 二次压缩续试）
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn single_flight_releases_after_completion() {
    let summarizer = Arc::new(RecordingSummarizer {
        calls: std::sync::Mutex::new(Vec::new()),
        result: std::sync::Mutex::new(Ok(valid_json("compacted-summary-1-1"))),
    });
    let dispatch = SummaryDispatch::new(fast_config());
    assert!(dispatch.try_spawn(task_with(summarizer.clone(), "compacted-summary-1-1"), None));
    tokio::time::sleep(Duration::from_millis(150)).await;
    // 首任务已完成 → 新 spawn 放行
    assert!(dispatch.try_spawn(task_with(summarizer.clone(), "compacted-summary-1-2"), None));
    tokio::time::sleep(Duration::from_millis(150)).await;
    let calls = summarizer.calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 2, "完成后单飞释放：第二次压缩可续试");
}
