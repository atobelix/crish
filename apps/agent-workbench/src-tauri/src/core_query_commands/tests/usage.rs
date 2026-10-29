//! core_query_commands 测试 · 镜像行读回与 run usage 映射。

use super::super::*;

use agent_provider::models::PricingUnit;
use conex_run::core_query::RunUsage;
use conex_types::events::RunCacheStats;

/// DM-06 读取面集成：直写镜像（run-interrupted / recovery-*，无 type
/// 标签）真实落库（conex-db LocalDb 写面）后，读侧经
/// query_events → parse_envelopes 可读回（wire 五键齐全）——「库里躺着
/// 读不出」关闭（G-20/G-02 读侧部分）。
#[test]
fn mirror_rows_written_by_direct_path_are_readable() {
    let db = conex_db::LocalDb::open_in_memory().expect("内存库");
    db.insert_session("s1", "s1").expect("会话");
    // 直写面落库（对齐 restore_manager / recovery.rs 裸镜像形态：无 type 键；
    // run_id 列 None——存量/直写面列级归属未注入前读侧经镜像键推断）
    db.append_event(
        "s1",
        1,
        "run-interrupted",
        r#"{"run_id":"r-9","session_id":"s1","previous_status":"running","status":"failed","reason":"daemon-restarted"}"#,
        None,
    )
    .expect("run-interrupted 落库");
    db.append_event(
        "s1",
        2,
        "recovery-escalated",
        r#"{"subagentRunId":"sr-1","kind":"ladder1","retries":2,"elapsedMs":1500}"#,
        None,
    )
    .expect("recovery-escalated 落库");
    // typed 信封正常行对照（落库后读回也应正常）
    db.append_event(
        "s1",
        3,
        "agent-start",
        r#"{"type":"agent-start","sessionId":"s1","sequence":3,"schemaVersion":1,"runId":"r1","timestamp":"2026-01-01T00:00:00Z"}"#,
        Some("r1"),
    )
    .expect("typed 信封落库");

    let store = orchestrator::persist::LocalDbStore::new(db);
    // Store trait 方法调用需 trait 在作用域（trait 方法非固有方法）
    use orchestrator::persist::Store as _;
    let events = tokio::runtime::Runtime::new()
        .expect("runtime")
        .block_on(store.query_events("s1", 0, None))
        .expect("读回");
    assert_eq!(events.len(), 3, "三行全部可读");

    let (parsed, stats) = parse_envelopes(&events);
    assert_eq!(parsed.len(), 3, "读侧零静默丢弃");
    assert_eq!(stats.synthesized, 2, "两镜像行走 D8 合成");
    assert_eq!(stats.typed, 1);
    assert_eq!(stats.corrupt_skipped, 0);

    // run-interrupted 行可读且五键齐全
    let interrupted = &parsed[0].1;
    assert_eq!(interrupted["type"], "run-interrupted");
    assert_eq!(interrupted["runId"], "r-9");
    assert_eq!(interrupted["sequence"], 1);
    assert_eq!(interrupted["schemaVersion"], 1);
    assert_eq!(interrupted["sessionId"], "s1");
    // recovery-* 行可读且五键齐全
    let escalated = &parsed[1].1;
    assert_eq!(escalated["type"], "recovery-escalated");
    assert_eq!(escalated["runId"], "sr-1");
    assert_eq!(escalated["sequence"], 2);
    assert_eq!(escalated["schemaVersion"], 1);
    assert_eq!(escalated["sessionId"], "s1");
    // typed 行正常（sequence 列权威回填保持）
    assert_eq!(parsed[2].1["sequence"], 3);
}

#[test]
fn envelope_roundtrips_to_flat_wire_json() {
    use conex_types::events::{AgentEvent, AgentEventEnvelope};
    let envelope = AgentEventEnvelope::new(
        AgentEvent::AgentStart {
            session_id: "s1".to_string(),
            timestamp: "2026-01-01T00:00:00Z".to_string(),
        },
        Some("r1".to_string()),
        Some(7),
    );
    let value = conex_run::core_query::envelope_to_value(&envelope).expect("序列化");
    assert_eq!(value["type"], "agent-start");
    assert_eq!(value["runId"], "r1");
    assert_eq!(value["sequence"], 7);
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["sessionId"], "s1");
}

// ── P5 S5 / T-40：run_usage 真实返回（RunUsage 缓存字段映射）──────

/// 构造测试用 run 级缓存统计（tracker.finish / DB get_run_usage 同型）
fn usage_stats() -> RunCacheStats {
    RunCacheStats {
        prompt_tokens: 1_000,
        completion_tokens: 50,
        total_tokens: 1_050,
        cache_read_tokens: 800,
        cache_write_tokens: 100,
        cache_miss_tokens: 100,
        sample_count: 1,
        // 落库读回不存派生值（T-39：hit_ratio 一律 None）——映射层
        // 必须按 C9 恒等式重算，不能透传
        hit_ratio: None,
        write_ratio: None,
        missed_tokens: 2_000,
        warm_until_ms: Some(61_000),
    }
}

/// T-40：from_run_cache_stats 全字段映射——原始计数透传 + hitRatio /
/// writeRatio 按 C9 恒等式重算（input_total = miss + read + write）
#[test]
fn run_usage_from_cache_stats_maps_all_fields() {
    let usage = RunUsage::from_run_cache_stats(usage_stats(), None).expect("有样本必须映射");
    assert_eq!(usage.prompt_tokens, 1_000);
    assert_eq!(usage.completion_tokens, 50);
    assert_eq!(usage.total_tokens, 1_050);
    assert_eq!(usage.sample_count, 1);
    assert_eq!(usage.cache_read_tokens, Some(800));
    assert_eq!(usage.cache_write_tokens, Some(100));
    assert_eq!(usage.cache_miss_tokens, Some(100));
    // 800 / (100 + 800 + 100) = 0.8
    assert_eq!(usage.hit_ratio, Some(0.8));
    // 100 / 1000 = 0.1
    assert_eq!(usage.write_ratio, Some(0.1));
    assert_eq!(usage.missed_tokens, Some(2_000));
    assert_eq!(usage.warm_until_ms, Some(61_000));

    // wire 形状：camelCase（T-47 前端 fetchRunSnapshotUsage 消费面）
    let value = serde_json::to_value(&usage).unwrap();
    assert_eq!(value["cacheReadTokens"], 800);
    assert_eq!(value["cacheWriteTokens"], 100);
    assert_eq!(value["cacheMissTokens"], 100);
    assert_eq!(value["hitRatio"], 0.8);
    assert_eq!(value["writeRatio"], 0.1);
    assert_eq!(value["missedTokens"], 2_000);
    assert_eq!(value["warmUntilMs"], 61_000);
    assert!(
        value.get("cache_read_tokens").is_none(),
        "不得出现 snake_case 键"
    );
}

/// T-40：无样本（sample_count == 0）→ None（前端隐藏而非 0% 误导，
/// P5 §3.1.2；与 T-39 get_run_usage 同口径）
#[test]
fn run_usage_from_cache_stats_none_without_samples() {
    let stats = RunCacheStats {
        sample_count: 0,
        ..Default::default()
    };
    assert!(RunUsage::from_run_cache_stats(stats, None).is_none());
}

/// T-40：input_total == 0（无任何输入侧数据）→ hitRatio / writeRatio
/// None（前端隐藏而非显示 0%）
#[test]
fn run_usage_from_cache_stats_ratio_none_when_zero_input() {
    let stats = RunCacheStats {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cache_miss_tokens: 0,
        sample_count: 1,
        ..Default::default()
    };
    let usage = RunUsage::from_run_cache_stats(stats, None).expect("有样本必须映射");
    assert_eq!(usage.cache_read_tokens, Some(0));
    assert_eq!(usage.hit_ratio, None, "input_total == 0 → 占比隐藏");
    assert_eq!(usage.write_ratio, None);
    assert_eq!(usage.warm_until_ms, None);
}

/// T5.6 宿主入账测（plans/05 §7.2）：live 单价 + 固定 usage →
/// `RunUsage.cost.formatted_total` 等于引擎手算；改价再 settle 字符串变；
/// 未定价 → cost None；四价 0 无阶梯 → 免费；CNY → ¥。
#[test]
fn run_usage_cost_equals_pricing_engine_and_three_states() {
    use agent_provider::models::catalog_types::{CurrencyKind, ModelPricingSpec};
    let stats = usage_stats();
    let pricing = ModelPricingSpec {
        currency: CurrencyKind::Usd,
        unit: PricingUnit::PerMillionTokens,
        input: Some(3.0),
        output: Some(9.0),
        cache_read: Some(0.1),
        cache_write: Some(0.0),
        per_image: None,
        tiers: vec![],
    };
    // prompt=1_000 / cache_read=800 → 输入段 200×3/1M=0.0006 + 输出 50×9/1M=0.00045
    // + cache_read 800×0.1/1M=0.00008 → 0.00113 → 引擎格式化 "$0.001130"
    let usage = RunUsage::from_run_cache_stats(stats, Some(&pricing)).expect("有定价必须出账");
    let engine_cost = agent_provider::pricing::PricingEngine::calculate_cost(
        &Some(pricing.clone()),
        stats.prompt_tokens,
        stats.completion_tokens,
        stats.cache_read_tokens,
        stats.cache_write_tokens,
    )
    .expect("引擎必须出账");
    assert_eq!(
        usage.cost.as_ref().map(|c| c.formatted_total.clone()),
        Some(engine_cost.formatted_total.clone()),
        "宿主账必须与引擎字符串字节一致"
    );

    // 改价（input 3.0 → 30.0）→ 字符串变，token 字段不变
    let mut priced2 = pricing.clone();
    priced2.input = Some(30.0);
    let usage2 = RunUsage::from_run_cache_stats(stats, Some(&priced2)).expect("改价后必须出账");
    assert_ne!(
        usage2.cost.as_ref().map(|c| c.formatted_total.clone()),
        usage.cost.as_ref().map(|c| c.formatted_total.clone()),
        "改 live 单价后 formatted_total 必须变"
    );
    assert_eq!(usage2.prompt_tokens, usage.prompt_tokens, "token 不变");

    // 未定价 → cost None（不是 0）
    let unpriced = RunUsage::from_run_cache_stats(stats, None).expect("有样本");
    assert!(unpriced.cost.is_none(), "无定价 → cost None");

    // 四价 0 无阶梯 → 免费（新契约：缺单价与显式免费不同——样本含
    // cache_read 用量，cache_read 必须显式 Some(0.0)，缺价+有用量 =
    // 未定价返回 None 而非 0）
    let free = ModelPricingSpec {
        currency: CurrencyKind::Usd,
        unit: PricingUnit::PerMillionTokens,
        input: Some(0.0),
        output: Some(0.0),
        cache_read: Some(0.0),
        cache_write: Some(0.0),
        per_image: None,
        tiers: vec![],
    };
    let free_usage = RunUsage::from_run_cache_stats(stats, Some(&free)).expect("有样本");
    let free_cost = free_usage.cost.expect("免费模型必须出账");
    assert!(free_cost.is_free);
    assert_eq!(free_cost.formatted_total, "免费");

    // CNY → ¥ 前缀（无硬编码 $）
    let cny = ModelPricingSpec {
        currency: CurrencyKind::Cny,
        unit: PricingUnit::PerMillionTokens,
        input: Some(3.0),
        output: Some(9.0),
        // 样本含 cache_read 用量：缺该维度单价 = 未定价（新契约），
        // 显式 0 才是「免费维度」
        cache_read: Some(0.0),
        cache_write: Some(0.0),
        per_image: None,
        tiers: vec![],
    };
    let cny_usage = RunUsage::from_run_cache_stats(stats, Some(&cny)).expect("有样本");
    assert!(
        cny_usage
            .cost
            .as_ref()
            .is_some_and(|c| c.formatted_total.starts_with('¥')),
        "CNY 账必须带 ¥ 前缀"
    );
}
