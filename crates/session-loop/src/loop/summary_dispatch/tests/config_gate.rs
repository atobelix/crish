use super::*;

// ── T-44 session_meta 配置面 ─────────────────────────────────────

/// 缺省兜底：无键 → 生产缺省（退避 [1000,3000,9000]、墙钟 60000、
/// jitter 0.2、attempts 上限）
#[test]
fn from_session_meta_defaults_on_missing_keys() {
    let config = SummaryDispatchConfig::from_session_meta(meta_map(&[]), MAX_SUMMARY_ATTEMPTS);
    assert_eq!(config.backoff_ms, SUMMARY_BACKOFF_MS.to_vec());
    assert_eq!(config.max_wall_ms, LOOP_SUMMARY_MAX_WALL_MS);
    assert!((config.jitter - SUMMARY_JITTER_RATIO).abs() < 1e-9);
    assert_eq!(config.max_attempts, MAX_SUMMARY_ATTEMPTS);
}

/// 自定义值：JSON 数组退避 + 自定义墙钟（T-44 三键中的两个数值键）
#[test]
fn from_session_meta_custom_values() {
    let meta = meta_map(&[
        (META_KEY_SUMMARY_BACKOFF_MS, "[2000,5000,15000]"),
        (META_KEY_SUMMARY_WALL_MS, "30000"),
    ]);
    let config = SummaryDispatchConfig::from_session_meta(meta, 5);
    assert_eq!(config.backoff_ms, vec![2000, 5000, 15000]);
    assert_eq!(config.max_wall_ms, 30_000);
    assert_eq!(config.max_attempts, 5, "attempts 上限由调用方注入");
}

/// 单个数值退避 → 单元素序列（退避基数语义，任务书 T-44）
#[test]
fn from_session_meta_single_backoff_value() {
    let meta = meta_map(&[(META_KEY_SUMMARY_BACKOFF_MS, "2500")]);
    let config = SummaryDispatchConfig::from_session_meta(meta, MAX_SUMMARY_ATTEMPTS);
    assert_eq!(config.backoff_ms, vec![2500]);
}

/// 非法值 → 缺省兜底（不 panic；坏条目丢弃 / 空数组回退）
#[test]
fn from_session_meta_malformed_falls_back() {
    let meta = meta_map(&[
        (META_KEY_SUMMARY_BACKOFF_MS, "not-a-number"),
        (META_KEY_SUMMARY_WALL_MS, "-1"),
    ]);
    let config = SummaryDispatchConfig::from_session_meta(meta, MAX_SUMMARY_ATTEMPTS);
    assert_eq!(config.backoff_ms, SUMMARY_BACKOFF_MS.to_vec());
    assert_eq!(config.max_wall_ms, LOOP_SUMMARY_MAX_WALL_MS);

    // 数组内非法条目丢弃，合法条目保留
    let meta = meta_map(&[(META_KEY_SUMMARY_BACKOFF_MS, "[1000,0,\"x\",3000]")]);
    let config = SummaryDispatchConfig::from_session_meta(meta, MAX_SUMMARY_ATTEMPTS);
    assert_eq!(config.backoff_ms, vec![1000, 3000]);

    // 空数组 → 回退缺省
    let meta = meta_map(&[(META_KEY_SUMMARY_BACKOFF_MS, "[]")]);
    let config = SummaryDispatchConfig::from_session_meta(meta, MAX_SUMMARY_ATTEMPTS);
    assert_eq!(config.backoff_ms, SUMMARY_BACKOFF_MS.to_vec());
}

// ── E2 F2 层 1 低功耗护栏（窗口累计 + 窗口过期重置）──────────────

/// 护栏缺省值 = 设计默认（累计 8 次 / 窗口 30min，E2 §3.1 层 1）
#[test]
fn retry_guard_defaults_match_plan() {
    let config = SummaryRetryGuardConfig::default();
    assert_eq!(
        config.max_attempts, 8,
        "compact_summary_max_attempts 默认 8"
    );
    assert_eq!(
        config.retry_window_ms, 1_800_000,
        "compact_summary_retry_window_ms 默认 30min"
    );
    // 与单 episode 上限（4）区分：护栏是跨 episode 累计，不允许相等混淆
    assert_ne!(config.max_attempts, MAX_SUMMARY_ATTEMPTS);
}

/// 键字符串单源（审计 02 S2 双真源修复）：本层护栏键与 conex-compaction
/// RetryGuardSummarizer 域共用同一常量，防两域漂移
#[test]
fn max_attempts_key_aliases_ai_summary_single_source() {
    assert_eq!(
        META_KEY_SUMMARY_MAX_ATTEMPTS,
        conex_compaction::ai_summary::SESSION_META_KEY_COMPACT_SUMMARY_MAX_ATTEMPTS,
        "compact_summary_max_attempts 键必须与 ai_summary.rs 同一常量（S2 统一口径）"
    );
}

/// 窗口护栏状态机：窗口内累计达上限前放行、达上限拒绝、窗口过期重置
/// 后可再试（对应设计测试 5.3.2「累计尝试 > 8 时停止重试；窗口内 0 次
/// 被动触发 → 计数重置」；假时钟驱动零真实等待）
#[test]
fn retry_gate_allows_until_window_cap_then_resets_after_expiry() {
    let mut gate = SummaryRetryGate::new(SummaryRetryGuardConfig {
        max_attempts: 3,
        retry_window_ms: 1_000,
    });
    // 窗口起点 t=0：episode 1 放行（0 < 3），记账 2 次
    assert!(gate.try_begin_episode(0), "窗口未开始必须放行");
    gate.record_episode(2, 0);
    // t=100（窗口内）：episode 2 放行（2 < 3），记账 1 次 → 累计 3 = 上限
    assert!(gate.try_begin_episode(100), "窗口内未达上限必须放行");
    gate.record_episode(1, 100);
    assert_eq!(gate.attempts_in_window(), 3);
    // t=200（窗口内）：累计 3 >= 3 → 拒绝（停止重试）
    assert!(
        !gate.try_begin_episode(200),
        "窗口内达上限必须拒绝新 episode"
    );
    // t=999（窗口内）：仍拒绝
    assert!(!gate.try_begin_episode(999), "窗口过期前持续拒绝");
    // t=1000（窗口过期）：重置计数 → 放行（窗口内 0 次被动触发 → 重置）
    assert!(gate.try_begin_episode(1_000), "窗口过期必须重置后可再试");
    gate.record_episode(1, 1_000);
    assert_eq!(gate.attempts_in_window(), 1, "重置后从零重新累计");
    assert!(gate.try_begin_episode(1_100), "重置后窗口内再次累计");
}

/// 窗口过期不依赖触发：record_episode 记账前同样先重置（窗口内 0 次
/// 被动触发 → 计数重置语义的记账面）
#[test]
fn retry_gate_window_expiry_resets_counter_on_record() {
    let mut gate = SummaryRetryGate::new(SummaryRetryGuardConfig {
        max_attempts: 5,
        retry_window_ms: 500,
    });
    gate.record_episode(4, 0);
    assert_eq!(gate.attempts_in_window(), 4);
    // t=600 记账：窗口已过期（600-0 >= 500）→ 先重置再记账
    gate.record_episode(2, 600);
    assert_eq!(gate.attempts_in_window(), 2, "过期窗口的旧计数必须丢弃");
    // 窗口起点随记账滑动到 600：t=1000（400ms 后）仍在窗口内 → 放行
    assert!(
        gate.try_begin_episode(1_000),
        "窗口未过期（600+500 > 1000）→ 放行"
    );
    // t=1200（600+500 之后）：窗口过期 → 计数重置（0 < 5）→ 仍放行
    assert!(gate.try_begin_episode(1_200), "窗口过期 → 计数重置后可再试");
    assert_eq!(gate.attempts_in_window(), 0, "窗口过期重置后计数归零");
}

/// max_attempts=0（配置为禁用摘要重试）→ 恒拒绝（防无界成本硬闸）
#[test]
fn retry_gate_zero_max_blocks_all() {
    let mut gate = SummaryRetryGate::new(SummaryRetryGuardConfig {
        max_attempts: 0,
        retry_window_ms: 60_000,
    });
    assert!(!gate.try_begin_episode(0), "0 = 禁用摘要重试（恒拒绝）");
    assert!(
        !gate.try_begin_episode(70_000),
        "窗口过期也不放行（0 上限）"
    );
}

/// 调度器集成：窗口护栏拒绝 spawn——episode 1 耗尽（4 次尝试）→ 护栏
/// 累计 4；护栏上限 2 → 后续 spawn 被拒绝（try_spawn 返回 false，
/// 不启动任务；「上限耗尽」以 outcome（awaiting + attempts=4）为事件
/// 载荷经回调移交，临时通知面不进对话）
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn summary_dispatch_denies_spawn_when_window_cap_reached() {
    let summarizer = Arc::new(RecordingSummarizer {
        calls: std::sync::Mutex::new(Vec::new()),
        result: std::sync::Mutex::new(Err("持续失败".to_string())),
    });
    let outcomes = Arc::new(std::sync::Mutex::new(Vec::new()));
    let dispatch = SummaryDispatch::new(fast_config());
    // 护栏上限 2（窗口 60s）：episode 1 的 4 次尝试已超上限 → 后续拒绝
    dispatch.set_retry_guard(SummaryRetryGuardConfig {
        max_attempts: 2,
        retry_window_ms: 60_000,
    });
    let cb = {
        let outcomes = outcomes.clone();
        Box::new(move |o: SummaryDispatchOutcome| {
            outcomes.lock().unwrap().push(o);
        }) as SummaryOutcomeCallback
    };
    assert!(
        dispatch.try_spawn(
            task_with(summarizer.clone(), "compacted-summary-1-1"),
            Some(cb)
        ),
        "episode 1（累计 0 < 2）必须放行"
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    let done = outcomes.lock().unwrap().clone();
    assert_eq!(done.len(), 1);
    assert_eq!(done[0].state, SummaryState::Awaiting, "episode 耗尽待重试");
    assert_eq!(done[0].attempts, 4, "episode 尝试 4 次（同步 1 + 后台 3）");
    // 窗口内累计 4 >= 2 → 被动触发被护栏拒绝（不 spawn、不记账）
    assert!(
        !dispatch.try_spawn(task_with(summarizer.clone(), "compacted-summary-1-1"), None),
        "窗口内累计达护栏上限 → 拒绝（停止重试，等待窗口重置）"
    );
    let calls = summarizer.calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 3, "被拒绝的触发不得产生任何摘要调用");
}

/// 护栏 session_meta 读取面：两新键自定义值（E2 §7.1 /
/// 07 §5.2「from_session_meta 扩展」测试域）
#[test]
fn retry_guard_from_session_meta_custom_values() {
    let meta = meta_map(&[
        (META_KEY_SUMMARY_MAX_ATTEMPTS, "6"),
        (META_KEY_SUMMARY_RETRY_WINDOW_MS, "120000"),
    ]);
    let config = SummaryRetryGuardConfig::from_session_meta(meta);
    assert_eq!(
        config.max_attempts, 6,
        "compact_summary_max_attempts 自定义"
    );
    assert_eq!(
        config.retry_window_ms, 120_000,
        "compact_summary_retry_window_ms 自定义"
    );
}

/// 护栏 session_meta 读取面：键缺失 / 非法 → 缺省兜底（不 panic）
#[test]
fn retry_guard_from_session_meta_defaults_on_missing_or_malformed() {
    // 缺省（无键）
    let config = SummaryRetryGuardConfig::from_session_meta(meta_map(&[]));
    assert_eq!(config.max_attempts, DEFAULT_RETRY_GUARD_MAX_ATTEMPTS);
    assert_eq!(config.retry_window_ms, DEFAULT_RETRY_GUARD_WINDOW_MS);
    // 非法值（非数字 / 0）→ 缺省兜底
    let meta = meta_map(&[
        (META_KEY_SUMMARY_MAX_ATTEMPTS, "not-a-number"),
        (META_KEY_SUMMARY_RETRY_WINDOW_MS, "0"),
    ]);
    let config = SummaryRetryGuardConfig::from_session_meta(meta);
    assert_eq!(config.max_attempts, DEFAULT_RETRY_GUARD_MAX_ATTEMPTS);
    assert_eq!(config.retry_window_ms, DEFAULT_RETRY_GUARD_WINDOW_MS);
    // 单键缺失：只提供窗口键 → 尝试上限回缺省
    let meta = meta_map(&[(META_KEY_SUMMARY_RETRY_WINDOW_MS, "90000")]);
    let config = SummaryRetryGuardConfig::from_session_meta(meta);
    assert_eq!(config.max_attempts, DEFAULT_RETRY_GUARD_MAX_ATTEMPTS);
    assert_eq!(config.retry_window_ms, 90_000);
}
