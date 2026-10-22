use super::*;

// ===== DEEPCHECK-05 #8：peakPricing 峰谷消费 =====

/// 基准时刻：2026-01-01 UTC 00:00 = 北京 08:00（epoch 1_767_225_600，
/// Node Date.UTC(2026,0,1)/1000 实测钉死）
const BASE_UTC_2026_01_01: u64 = 1_767_225_600;

/// 峰谷判定：deepseek-v4-flash 北京 9-12 / 14-18（左闭右开）
#[test]
fn peak_pricing_2x_detects_beijing_windows() {
    let catalog = ModelCatalog::bundled();
    // 北京时间当日分钟 → epoch：BASE 为北京 08:00，相对偏移
    // (min + 1440 - 480) % 1440（08:00 偏移 0，跨日取模）
    let at_beijing = |beijing_min: u64| {
        let offset_min = (beijing_min + 960) % 1440;
        catalog.peak_pricing_2x_for(
            "deepseek",
            "deepseek-v4-flash",
            BASE_UTC_2026_01_01 + offset_min * 60,
        )
    };
    // 峰内：09:00（入峰含）~ 11:59
    assert!(at_beijing(9 * 60));
    assert!(at_beijing(10 * 60 + 30));
    assert!(at_beijing(11 * 60 + 59));
    // 出峰：12:00（左闭右开）
    assert!(!at_beijing(12 * 60));
    assert!(!at_beijing(13 * 60));
    // 第二窗口：14:00 入峰 ~ 17:59；18:00 出峰
    assert!(at_beijing(14 * 60));
    assert!(at_beijing(17 * 60 + 59));
    assert!(!at_beijing(18 * 60));
    // 夜间谷（0 点 / 凌晨 2 点）
    assert!(!at_beijing(2 * 60));
    assert!(!at_beijing(0));
    // 08:59 出峰
    assert!(!at_beijing(8 * 60 + 59));
}

/// 非峰谷模型 / 未知模型 → false（gpt-5.5 无 peakPricing2x）
#[test]
fn peak_pricing_2x_false_for_others() {
    let catalog = ModelCatalog::bundled();
    assert!(!catalog.peak_pricing_2x_for("openai", "gpt-5.5", BASE_UTC_2026_01_01 + 9 * 3600));
    assert!(!catalog.peak_pricing_2x_for("nobody", "whatever", BASE_UTC_2026_01_01 + 9 * 3600));
}

/// 窗口解析失败 / 越界值 → false（防御坏数据）
#[test]
fn peak_pricing_window_parse_defensive() {
    assert!(!window_contains("09:00-12:00", 8 * 60));
    assert!(window_contains("09:00-12:00", 9 * 60));
    // 非法窗口
    assert!(!window_contains("9:00-12:00", 9 * 60));
    assert!(!window_contains("09:00-12:61", 9 * 60));
    assert!(!window_contains("bogus", 9 * 60));
    assert!(!window_contains("", 9 * 60));
    // 分钟越界判定
    assert_eq!(beijing_minutes_of(BASE_UTC_2026_01_01), 8 * 60);
    assert_eq!(beijing_minutes_of(BASE_UTC_2026_01_01 + 3600), 9 * 60);
}

/// effectiveFrom 未到 → 未生效（构造带 future effectiveFrom 的条目）
#[test]
fn peak_pricing_2x_honors_effective_from() {
    let mut entry = ModelCatalogEntry {
        model: "deepseek-v4-flash".to_string(),
        provider: "deepseek".to_string(),
        vendor: "deepseek".to_string(),
        peak_pricing_2x: true,
        peak_pricing_schedule: Some(PeakPricingSchedule {
            windows: vec!["09:00-12:00".to_string(), "14:00-18:00".to_string()],
            tz: "Asia/Shanghai".to_string(),
            // 2026-09-01 生效：2026-01-01（北京 08:00）远早于生效日 → false
            effective_from: Some("2026-09-01".to_string()),
            note: None,
        }),
        ..Default::default()
    };
    // 生效前：峰时段也不计 2x
    assert!(!peak_pricing_2x_at(&entry, BASE_UTC_2026_01_01 + 9 * 3600));
    // 生效后（北京 2026-09-01 09:00 = UTC 08-31 18:00 后 9h）→ true
    let sep1_utc = parse_date_utc_epoch("2026-09-01").expect("日期可解析") - 28_800;
    assert!(peak_pricing_2x_at(&entry, sep1_utc + 9 * 3600));
    // effectiveFrom 移除（null = 已生效）→ 峰时段 true
    entry.peak_pricing_schedule.as_mut().unwrap().effective_from = None;
    assert!(peak_pricing_2x_at(&entry, BASE_UTC_2026_01_01 + 9 * 3600));
}

/// effectiveFrom 解析与日期算术（2026-09-01 北京 0 点 = UTC 08-31 16:00）
#[test]
fn parse_date_utc_epoch_arithmetic() {
    // 2026-01-01 = 20454 天（Node Date.UTC(2026,0,1)/86400 实测）
    assert_eq!(parse_date_utc_epoch("2026-01-01"), Some(20_454 * 86_400));
    // 2026-09-01 = 2026-01-01 + 243 天（1月31+2月28+3月31+4月30+5月31+6月30+7月31+8月31）
    assert_eq!(
        parse_date_utc_epoch("2026-09-01"),
        Some((20_454 + 243) * 86_400)
    );
    // 非法输入 → None
    assert_eq!(parse_date_utc_epoch("2026-13-01"), None);
    assert_eq!(parse_date_utc_epoch("2026-01-32"), None);
    assert_eq!(parse_date_utc_epoch("2026/01/01"), None);
    assert_eq!(parse_date_utc_epoch("2026-01"), None);
    assert_eq!(parse_date_utc_epoch("bogus"), None);
    // 窗口解析失败不 panic
    assert!(!peak_pricing_2x_at(
        &ModelCatalogEntry {
            model: "x".to_string(),
            provider: "p".to_string(),
            vendor: "v".to_string(),
            peak_pricing_2x: true,
            peak_pricing_schedule: Some(PeakPricingSchedule {
                windows: vec!["bogus".to_string()],
                tz: "Asia/Shanghai".to_string(),
                effective_from: None,
                note: None,
            }),
            ..Default::default()
        },
        BASE_UTC_2026_01_01
    ));
}

// ===== T1.1 (G2)：模型级档位映射载体 =====

/// 旧 Vec 数组形式（`["low","medium","xhigh"]`）解析 → 映射载体，各档 wire 拼写
/// 同规范名（向后兼容逐字段不变）；缺失/null → None
#[test]
fn t11_legacy_vec_tiers_parse_to_identity_map() {
    // 数组形式
    let entry: ModelCatalogEntry = serde_json::from_value(serde_json::json!({
        "model": "qwen3-8-max",
        "provider": "dashscope",
        "vendor": "qwen",
        "supportsReasoningEffort": true,
        "thinkingTiers": ["low", "medium", "xhigh"],
    }))
    .expect("旧 Vec 数组形式必须可解析");
    assert_eq!(
        entry.thinking_tiers,
        Some(BTreeMap::from([
            ("low".to_string(), Some("low".to_string())),
            ("medium".to_string(), Some("medium".to_string())),
            ("xhigh".to_string(), Some("xhigh".to_string())),
        ]))
    );
    // 每档 wire 拼写 = 规范名
    assert_eq!(entry.wire_effort_for("low"), Some("low"));
    assert_eq!(entry.wire_effort_for("medium"), Some("medium"));
    assert_eq!(entry.wire_effort_for("xhigh"), Some("xhigh"));
    assert_eq!(
        entry.offered_levels(),
        vec!["low".to_string(), "medium".to_string(), "xhigh".to_string()]
    );

    // null 与缺省 → None
    let null_entry: ModelCatalogEntry =
        serde_json::from_value(serde_json::json!({ "thinkingTiers": null }))
            .expect("null 必须解析为 None");
    assert_eq!(null_entry.thinking_tiers, None);

    // 缺省（default 兜底）→ None
    let default_entry: ModelCatalogEntry =
        serde_json::from_value(serde_json::json!({ "model": "x" })).expect("缺省必须可解析");
    assert_eq!(default_entry.thinking_tiers, None);
}

/// 新映射形式（`{"low":null,"medium":"high"}`）serde roundtrip，含 None 隐藏项
#[test]
fn t11_map_tiers_roundtrip_with_hidden_items() {
    let raw = r#"{
        "model": "glm-5.2",
        "provider": "zai",
        "vendor": "glm",
        "thinkingTiers": {"low": null, "medium": "high", "high": "high", "max": "max", "minimal": null}
    }"#;
    let entry: ModelCatalogEntry = serde_json::from_str(raw).expect("新映射形式必须可解析");
    // v2 单载体：thinking_tiers 为唯一档位源，Some=wire 提供 / None=隐藏
    assert_eq!(
        entry.thinking_tiers,
        Some(BTreeMap::from([
            ("low".to_string(), None),
            ("medium".to_string(), Some("high".to_string())),
            ("high".to_string(), Some("high".to_string())),
            ("max".to_string(), Some("max".to_string())),
            ("minimal".to_string(), None),
        ]))
    );
    // roundtrip：序列化后重新解析必须逐位一致（含 None 隐藏项）
    let serialized = serde_json::to_string(&entry).expect("必须可序列化");
    let reparsed: ModelCatalogEntry =
        serde_json::from_str(&serialized).expect("roundtrip 必须可解析");
    assert_eq!(reparsed, entry);

    // 隐藏档（None）不进入提供档集；提供的档并集字典序。
    // 提供档 = {medium(改名 high), high, max}；隐藏档 minimal/low 不入集。
    assert_eq!(
        entry.offered_levels(),
        vec!["high".to_string(), "max".to_string(), "medium".to_string()]
    );
}

/// 查询辅助 wire_effort_for：改名映射返回改名后 wire；隐藏档（None 值）与未收录档返回 None
///
/// 注意：R4 T4.2「改名 wire」消费正是 `{medium:"high"}` → wire 字节 "high"。
#[test]
fn t11_wire_effort_for_rename_and_hidden() {
    // 改名映射（独立 reasoning_effort_tiers 改名场景）
    let renamed: ModelCatalogEntry = serde_json::from_value(serde_json::json!({
        "thinkingTiers": {"medium": "high", "low": "low"},
    }))
    .expect("改名映射必须可解析");
    assert_eq!(
        renamed.wire_effort_for("medium"),
        Some("high"),
        "改名映射返回 wire 拼写"
    );
    assert_eq!(
        renamed.wire_effort_for("low"),
        Some("low"),
        "同名档原样返回"
    );
    assert_eq!(renamed.wire_effort_for("high"), None, "未收录档 → None");

    // 隐藏档（None 值）：wire_effort_for 返回 None，offered_levels 不含该档
    let hidden: ModelCatalogEntry = serde_json::from_value(serde_json::json!({
        "thinkingTiers": {"minimal": null, "low": null, "high": "high", "max": "max"},
    }))
    .expect("含隐藏档映射必须可解析");
    assert_eq!(
        hidden.wire_effort_for("minimal"),
        None,
        "隐藏档（None 值）→ None"
    );
    assert_eq!(
        hidden.wire_effort_for("low"),
        None,
        "隐藏档（None 值）→ None"
    );
    assert_eq!(
        hidden.wire_effort_for("high"),
        Some("high"),
        "提供档返回 wire"
    );
    assert_eq!(
        hidden.offered_levels(),
        vec!["high".to_string(), "max".to_string()]
    );
}

/// 查询辅助单载体：thinking_tiers 为唯一档位源（v2 单源裁决，无跨字段回落）
#[test]
fn t11_wire_effort_for_single_source() {
    let entry: ModelCatalogEntry = serde_json::from_value(serde_json::json!({
        // 单一载体（v2 单源）：medium 改名 high、low 同名、minimal 隐藏
        "thinkingTiers": {
            "minimal": null,
            "low": "low",
            "medium": "high",
            "high": "high",
            "max": "max",
        },
    }))
    .expect("必须可解析");
    // 改名命中
    assert_eq!(
        entry.wire_effort_for("medium"),
        Some("high"),
        "改名映射返回 wire 拼写"
    );
    assert_eq!(entry.wire_effort_for("low"), Some("low"));
    assert_eq!(entry.wire_effort_for("max"), Some("max"));
    // 隐藏档与未收录档 → None
    assert_eq!(entry.wire_effort_for("minimal"), None);
    assert_eq!(entry.wire_effort_for("bogus"), None, "未收录档 → None");
    // offered_levels 提供档集：low / medium / high / max（隐藏档 minimal 不入集）
    assert_eq!(
        entry.offered_levels(),
        vec![
            "high".to_string(),
            "low".to_string(),
            "max".to_string(),
            "medium".to_string()
        ]
    );
}

/// 空数组 / 空对象 → None（无提供档位），与"空 = 未提供"语义一致
#[test]
fn t11_empty_tier_map_is_none() {
    let empty_arr: ModelCatalogEntry =
        serde_json::from_value(serde_json::json!({ "thinkingTiers": [] }))
            .expect("空数组必须可解析");
    assert_eq!(empty_arr.thinking_tiers, None, "空数组 → None");
    let empty_obj: ModelCatalogEntry =
        serde_json::from_value(serde_json::json!({ "thinkingTiers": {} }))
            .expect("空对象必须可解析");
    assert_eq!(empty_obj.thinking_tiers, None, "空对象 → None");
    assert!(empty_obj.offered_levels().is_empty());
}
