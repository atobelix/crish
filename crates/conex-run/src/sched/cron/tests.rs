//! sched::cron 单元测试（T-CF-08 验收用例，TY-P3 随模块迁入）
//!
//! 确定性断言一律走 [CronSchedule::next_fire_after_in_offset] 或注入
//! [FixedOffsetMinutes]；只有 SystemLocal 冒烟用例触及真实系统时区，
//! 且不断言具体偏移值。

use conex_shared::time::days_from_civil;

use super::*;

/// 测试辅助：构造固定墙钟时刻的 epoch 毫秒（UTC 偏移展开，秒恒 0）
fn utc_ms(y: i64, m: u32, d: u32, h: u32, min: u32) -> u64 {
    let days = days_from_civil(y, m, d);
    (days * 86_400 + i64::from(h) * 3_600 + i64::from(min) * 60) as u64 * 1000
}

/// 测试替身：在 `switch_ms` 处跳变的时区（模拟 DST 切换，确定性）
struct SwitchOffset {
    switch_ms: u64,
    before: i32,
    after: i32,
}

impl LocalOffset for SwitchOffset {
    fn offset_minutes_at(&self, utc_ms: i64) -> i32 {
        if utc_ms as u64 >= self.switch_ms {
            self.after
        } else {
            self.before
        }
    }
}

// ── 解析：合法表达式（T-CF-08 验收 1）──

/// T-CF-08 验收：任务书五条合法表达式全部解析成功（覆盖 *、n、a-b、
/// 列表、*/step、a-b/step 语法；对齐前端 workflowScheduler.test.ts:36-42）
#[test]
fn cron_parse_valid_expressions() {
    for expr in [
        "0 9 * * *",
        "*/5 * * * *",
        "0 8-10 * * 1-5",
        "30 4 1,15 * *",
        "0 0 * * 0",
    ] {
        parse_cron(expr).unwrap_or_else(|e| panic!("{expr} 应解析成功：{e}"));
    }
    // 额外覆盖：*/step 上限值、a-b/step、n/step（前端允许）、列表内范围、
    // dow=7、多位空格分隔
    for expr in [
        "*/30 * * * *",
        "0-59/5 * * * *",
        "5/10 * * * *",
        "0 0 1-15 * 1,3,5",
        "0 0 * * 7",
        "0  9  *  *  *",
    ] {
        parse_cron(expr).unwrap_or_else(|e| panic!("{expr} 应解析成功：{e}"));
    }
}

/// 展开语义锚定：值集展开（* = 全集、*/5 = 5 的倍数、a-b = 闭区间、
/// a-b/step = 等差序列、n/step = 从 n 起步进至上限、列表 = 合并）
#[test]
fn cron_field_values_expanded_correctly() {
    let sched = parse_cron("*/5 * * * *").unwrap();
    assert_eq!(
        sched.minute.values,
        vec![0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]
    );
    assert_eq!(sched.minute.text, "*/5", "原文保留（回显用）");

    let sched = parse_cron("0 8-10 * * 1-5").unwrap();
    assert_eq!(sched.hour.values, vec![8, 9, 10], "a-b 闭区间展开");
    assert_eq!(sched.day_of_week.values, vec![1, 2, 3, 4, 5]);

    let sched = parse_cron("0-59/20 * * * *").unwrap();
    assert_eq!(sched.minute.values, vec![0, 20, 40], "a-b/step 等差序列");

    let sched = parse_cron("5/10 * * * *").unwrap();
    assert_eq!(
        sched.minute.values,
        vec![5, 15, 25, 35, 45, 55],
        "n/step 至上限"
    );

    let sched = parse_cron("30 4 1,15 * *").unwrap();
    assert_eq!(sched.day_of_month.values, vec![1, 15], "列表展开");

    let sched = parse_cron("* * * * *").unwrap();
    assert_eq!(
        sched.day_of_week.values,
        (0..=7).collect::<Vec<_>>(),
        "* 展开为全集"
    );
}

// ── 解析：非法表达式（T-CF-08 验收 2）──

/// T-CF-08 验收：非法表达式全部拒绝且带字段定位
#[test]
fn cron_parse_rejects_invalid() {
    // 6 字段（含秒）：字段数定位（文案对齐前端 :181-187）
    let err = parse_cron("0 0 0 * * *").unwrap_err();
    assert!(
        matches!(err, CronError::WrongFieldCount { actual: 6 }),
        "6 字段必须拒绝：{err:?}"
    );
    assert_eq!(
        err.to_string(),
        "不支持 6 字段（含秒）cron，请用 5 字段：分 时 日 月 周"
    );

    // @ 宏（文案对齐前端 :177-180）
    let err = parse_cron("@daily").unwrap_err();
    assert!(matches!(err, CronError::MacroNotSupported));
    assert_eq!(
        err.to_string(),
        "不支持 @yearly 等 cron 宏，请用 5 字段表达式"
    );
    assert!(parse_cron("@yearly * * * *").is_err(), "@ 开头一律拒绝");

    // 非 5 字段：4 字段与 7 字段
    let err = parse_cron("0 9 * *").unwrap_err();
    assert!(matches!(err, CronError::WrongFieldCount { actual: 4 }));
    assert!(matches!(
        parse_cron("0 0 0 0 0 0 0").unwrap_err(),
        CronError::WrongFieldCount { actual: 7 }
    ));

    // 越界字段：minute=60 → 字段定位 0（分钟）
    match parse_cron("60 * * * *").unwrap_err() {
        CronError::FieldInvalid {
            index,
            field_name,
            raw,
            min,
            max,
            reason,
        } => {
            assert_eq!(index, 0, "字段定位必须为分钟");
            assert_eq!(field_name, "分钟");
            assert_eq!(raw, "60");
            assert_eq!((min, max), (0, 59));
            assert!(reason.contains("越界"), "原因应含越界：{reason}");
        }
        other => panic!("应返回字段级错误，实际 {other:?}"),
    }

    // 越界字段：hour=24（定位 1）、dom=0（定位 2）、month=13（定位 3）、
    // dow=8（定位 4）
    assert!(matches!(
        parse_cron("0 24 * * *").unwrap_err(),
        CronError::FieldInvalid { index: 1, .. }
    ));
    assert!(matches!(
        parse_cron("0 0 0 * *").unwrap_err(),
        CronError::FieldInvalid { index: 2, .. }
    ));
    assert!(matches!(
        parse_cron("0 0 * 13 *").unwrap_err(),
        CronError::FieldInvalid { index: 3, .. }
    ));
    assert!(matches!(
        parse_cron("0 0 * * 8").unwrap_err(),
        CronError::FieldInvalid { index: 4, .. }
    ));

    // 非法步进：*/0（步进为 0）、*/60（分钟上限 59 内越界）
    let err = parse_cron("*/0 * * * *").unwrap_err();
    assert!(matches!(err, CronError::FieldInvalid { index: 0, .. }));
    let err = parse_cron("*/60 * * * *").unwrap_err();
    assert!(matches!(err, CronError::FieldInvalid { index: 0, .. }));
    assert!(err.to_string().contains("步进"), "文案应含步进原因");

    // 非法范围：a > b、三段连字符、列表空项、列表内步进（前端同拒）
    assert!(matches!(
        parse_cron("0 10-5 * * *").unwrap_err(),
        CronError::FieldInvalid { index: 1, .. }
    ));
    assert!(parse_cron("0 1-2-3 * * *").is_err(), "多段连字符拒绝");
    assert!(parse_cron("0 1,,2 * * *").is_err(), "列表空项拒绝");
    assert!(
        parse_cron("0 1,15/5 * * *").is_err(),
        "列表内步进拒绝（前端同语义）"
    );
    assert!(parse_cron("0 1- * * *").is_err(), "开放范围拒绝");
    assert!(parse_cron("*/-1 * * * *").is_err(), "负步进拒绝");

    // 空表达式
    assert!(matches!(parse_cron("").unwrap_err(), CronError::Empty));
    assert!(matches!(parse_cron("   ").unwrap_err(), CronError::Empty));
    assert_eq!(
        parse_cron("").unwrap_err().to_string(),
        "cron 表达式不能为空"
    );
}

/// 前端对照（双实现锁定）：workflowScheduler.test.ts:36-49 的 cron 用例
/// 在 Rust 侧一一对应——"0 * * * *" 合法、"0 0 0 * * *"（6 字段）拒绝
#[test]
fn cron_parse_mirrors_frontend_test_cases() {
    assert!(
        parse_cron("0 * * * *").is_ok(),
        "前端合法用例 0 * * * * 必须解析成功"
    );
    let err = parse_cron("0 0 0 * * *").unwrap_err();
    assert!(
        matches!(err, CronError::WrongFieldCount { actual: 6 }),
        "前端 6 字段用例必须拒绝"
    );
}

/// CronError 结构化错误 serde 往返（tagged enum，kind + detail 形态）
#[test]
fn cron_error_serde_roundtrip() {
    for err in [
        CronError::Empty,
        CronError::MacroNotSupported,
        CronError::WrongFieldCount { actual: 6 },
        CronError::FieldInvalid {
            index: 0,
            field_name: "分钟".into(),
            raw: "60".into(),
            min: 0,
            max: 59,
            reason: "数值越界：须在 0-59 之间".into(),
        },
    ] {
        let json = serde_json::to_value(&err).unwrap();
        let back: CronError = serde_json::from_value(json).unwrap();
        assert_eq!(back, err, "CronError roundtrip 保真");
    }
}

// ── 触发时刻（T-CF-08 验收 3）──

/// T-CF-08 验收：*/5 从整点后 1 秒起算 → 下一命中 = 该分钟内最近 5 的
/// 倍数（构造固定时刻断言：2026-08-05 09:01:00 UTC 起算 → 09:05:00 UTC）
#[test]
fn cron_next_fire_after_known_sequence() {
    let sched = parse_cron("*/5 * * * *").unwrap();
    let after = utc_ms(2026, 8, 5, 9, 1);
    let next = sched
        .next_fire_after_in_offset(after, 0)
        .expect("必须有下一命中");
    assert_eq!(next, utc_ms(2026, 8, 5, 9, 5), "下一命中应为 09:05:00 UTC");

    // 严格大于：恰在命中时刻起算 → 跳过该命中
    assert_eq!(
        sched.next_fire_after_in_offset(utc_ms(2026, 8, 5, 9, 5), 0),
        Some(utc_ms(2026, 8, 5, 9, 10))
    );

    // 毫秒级起算：09:00:00.999 之后 → 09:05:00 仍为下一命中
    assert_eq!(
        sched.next_fire_after_in_offset(utc_ms(2026, 8, 5, 9, 0) + 999, 0),
        Some(utc_ms(2026, 8, 5, 9, 5))
    );

    // 跨日：23:58 起算 → 次日 00:00
    let daily = parse_cron("0 0 * * *").unwrap();
    assert_eq!(
        daily.next_fire_after_in_offset(utc_ms(2026, 8, 5, 23, 58), 0),
        Some(utc_ms(2026, 8, 6, 0, 0))
    );

    // 跨月：8 月 31 日 23:58 起算 → 9 月 1 日 00:00
    assert_eq!(
        daily.next_fire_after_in_offset(utc_ms(2026, 8, 31, 23, 58), 0),
        Some(utc_ms(2026, 9, 1, 0, 0))
    );

    // 跨年：2026-12-31 23:58 起算 → 2027-01-01 00:00
    assert_eq!(
        daily.next_fire_after_in_offset(utc_ms(2026, 12, 31, 23, 58), 0),
        Some(utc_ms(2027, 1, 1, 0, 0))
    );
}

/// T-CF-08 验收：2 月 30 日不存在 → 无命中返回 None（月/日联合匹配
/// AND 语义，任务书 :737）
#[test]
fn cron_next_fire_after_month_dom() {
    let sched = parse_cron("0 0 30 2 *").unwrap();
    assert_eq!(
        sched.next_fire_after_in_offset(utc_ms(2026, 1, 1, 0, 0), 0),
        None
    );

    // 4 月 31 日同样恒无命中（AND 语义的另一个锚点）
    let apr31 = parse_cron("0 0 31 4 *").unwrap();
    assert_eq!(
        apr31.next_fire_after_in_offset(utc_ms(2026, 1, 1, 0, 0), 0),
        None
    );

    // 2 月 29 日：闰年命中（2028-02-29 00:00 UTC；从 2026-01-01 与
    // 2027-01-01 起算都会在 40 年窗口内遇到最近闰年——仅当日期不存在
    // 才返回 None，如 2 月 30 日）
    let leap = parse_cron("0 0 29 2 *").unwrap();
    assert_eq!(
        leap.next_fire_after_in_offset(utc_ms(2026, 1, 1, 0, 0), 0),
        Some(utc_ms(2028, 2, 29, 0, 0)),
        "2028 闰年 2 月 29 日必须命中"
    );
    assert_eq!(
        leap.next_fire_after_in_offset(utc_ms(2029, 1, 1, 0, 0), 0),
        Some(utc_ms(2032, 2, 29, 0, 0)),
        "最近闰年 2032 必须命中"
    );
}

/// 本地时区语义（固定偏移注入，确定性）：UTC+8 下 "0 9 * * *" 的
/// 09:00 本地 = 01:00 UTC；偏移只平移墙钟，不改变相对间隔
#[test]
fn cron_next_fire_after_respects_offset() {
    let sched = parse_cron("0 9 * * *").unwrap();
    // 2026-08-05 23:00 UTC = 2026-08-06 07:00 UTC+8；本地 09:00（UTC+8）
    // = 2026-08-06 01:00 UTC
    let after_utc = utc_ms(2026, 8, 5, 23, 0);
    assert_eq!(
        sched.next_fire_after_in_offset(after_utc, 480),
        Some(utc_ms(2026, 8, 6, 1, 0))
    );
    // 同一起算时刻，UTC（偏移 0）下 09:00 在次日 09:00 UTC 命中
    assert_eq!(
        sched.next_fire_after_in_offset(after_utc, 0),
        Some(utc_ms(2026, 8, 6, 9, 0))
    );
}

/// dow 0-7 语义：dow=7 与 dow=0 都表周日（2026-08-06 为周四，
/// 最近周日是 2026-08-09）
#[test]
fn cron_dow_seven_means_sunday() {
    for expr in ["0 0 * * 7", "0 0 * * 0"] {
        let sched = parse_cron(expr).unwrap();
        let next = sched
            .next_fire_after_in_offset(utc_ms(2026, 8, 6, 0, 0), 0)
            .unwrap_or_else(|| panic!("{expr} 必须命中最近周日"));
        assert_eq!(next, utc_ms(2026, 8, 9, 0, 0), "{expr} 的下一命中应为周日");
    }
}

// ── R3：FixedOffsetMinutes 下按当地墙钟触发 ──

/// R3（TY-P3）：偏移 480 分钟下 "0 9 * * *" 的下一次触发是该偏移的 09:00
/// （= 01:00 UTC），不断言系统时区
#[test]
fn cron_next_fire_after_fixed_offset_hits_local_nine() {
    let sched = parse_cron("0 9 * * *").unwrap();
    // 2026-08-05 23:00 UTC = 2026-08-06 07:00 UTC+8 → 下一个本地 09:00
    let after = utc_ms(2026, 8, 5, 23, 0);
    let next = sched
        .next_fire_after(after, &FixedOffsetMinutes(480))
        .expect("必须有下一命中");
    assert_eq!(
        next,
        utc_ms(2026, 8, 6, 1, 0),
        "UTC+8 的当地 09:00 应为 01:00 UTC"
    );
}

// ── R4：固定偏移下 next_fire_after 与旧入口逐值等价 ──

/// R4（TY-P3）：同一组表达式/起点，FixedOffsetMinutes(0) 的 next_fire_after
/// 与 next_fire_after_in_offset(.., 0) 结果逐条一致（覆盖跨日、月末、闰年、
/// 无命中表达式）
#[test]
fn cron_next_fire_after_matches_in_offset() {
    let cases = [
        ("*/5 * * * *", utc_ms(2026, 8, 5, 9, 1)),
        ("0 0 * * *", utc_ms(2026, 8, 31, 23, 58)),
        ("0 0 1 * *", utc_ms(2026, 8, 15, 12, 0)),
        ("0 0 29 2 *", utc_ms(2026, 1, 1, 0, 0)),
        ("0 0 31 12 *", utc_ms(2026, 12, 30, 23, 59)),
        ("30 9 * * 1-5", utc_ms(2027, 3, 1, 0, 0)),
        ("0 0 30 2 *", utc_ms(2026, 1, 1, 0, 0)),
    ];
    let utc = FixedOffsetMinutes(0);
    for (expr, after) in cases {
        let sched = parse_cron(expr).expect("表达式应合法");
        assert_eq!(
            sched.next_fire_after(after, &utc),
            sched.next_fire_after_in_offset(after, 0),
            "{expr} 在 {after} 起算的固定偏移结果必须与旧入口一致"
        );
    }
}

// ── DST：候选时刻偏移变化时复算 ──

/// DST 复算：起算时偏移 60（冬令时），候选时刻已切到 120（夏令时）——
/// 09:00 当地应按新偏移折算为 07:00 UTC，而不是按旧偏移的 08:00 UTC
#[test]
fn cron_next_fire_after_recomputes_on_dst_switch() {
    let sched = parse_cron("0 9 * * *").unwrap();
    let switch = utc_ms(2026, 3, 29, 1, 0);
    let tz = SwitchOffset {
        switch_ms: switch,
        before: 60,
        after: 120,
    };
    let after = utc_ms(2026, 3, 28, 23, 30);
    assert_eq!(
        sched.next_fire_after(after, &tz),
        Some(utc_ms(2026, 3, 29, 7, 0)),
        "DST 切换后当地 09:00 应为 07:00 UTC"
    );
    // 对照：只用旧偏移（不复算）会得到 08:00 UTC——偏一小时
    assert_eq!(
        sched.next_fire_after_in_offset(after, 60),
        Some(utc_ms(2026, 3, 29, 8, 0))
    );
}

// ── SystemLocal 冒烟（不断言具体时区）──

/// SystemLocal 冒烟：偏移落在真实时区范围内（-12h..=+14h）且同一时刻
/// 重复取值稳定；不依赖本机所在时区
#[test]
fn system_local_offset_smoke() {
    let tz = SystemLocal;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let offset = tz.offset_minutes_at(now);
    assert!(
        (-12 * 60..=14 * 60).contains(&offset),
        "系统时区偏移应在 -12h..=+14h 之间：{offset}"
    );
    assert_eq!(offset, tz.offset_minutes_at(now), "同一时刻偏移取值稳定");
}

/// 公开入口（SystemLocal）结构性断言：结果必在未来、整分钟对齐且距
/// after_ms 不超过 10 分钟（精确值依赖机器时区，由注入偏移的确定性
/// 测试覆盖；本测试只做公共面冒烟）
#[test]
fn cron_next_fire_after_public_path_structural() {
    let sched = parse_cron("*/5 * * * *").unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let next = sched
        .next_fire_after(now, &SystemLocal)
        .expect("必须有下一命中");
    assert!(next > now, "命中必须严格晚于 after_ms");
    assert_eq!(next % 60_000, 0, "cron 命中时刻必须整分钟对齐");
    assert!(next - now < 10 * 60_000, "*/5 的下一命中距离应在 10 分钟内");
}

// ── 标签（T-CF-08 验收 4）──

/// T-CF-08 验收：cron_label 人类可读（对齐前端 cronExpressionLabel
/// workflowScheduler.ts:212-241——"0 9 * * *" 含 09:00 语义标签）
#[test]
fn cron_label_readable() {
    let sched = parse_cron("0 9 * * *").unwrap();
    let label = sched.cron_label();
    assert!(label.contains("每天 9 点"), "标签应含 09:00 语义：{label}");
    assert!(label.contains("0 9 * * *"), "标签应回显表达式：{label}");

    assert_eq!(
        parse_cron("*/5 * * * *").unwrap().cron_label(),
        "每 5 分钟 · */5 * * * *"
    );
    assert_eq!(
        parse_cron("0 * * * *").unwrap().cron_label(),
        "每小时 · 0 * * * *"
    );
    assert_eq!(
        parse_cron("0 0 * * 0").unwrap().cron_label(),
        "每周日 0 点 · 0 0 * * 0"
    );
    assert_eq!(
        parse_cron("0 0 * * 7").unwrap().cron_label(),
        "每周日 0 点 · 0 0 * * 7"
    );
    // 非常见模式：原样回显
    assert_eq!(
        parse_cron("30 4 1,15 * *").unwrap().cron_label(),
        "30 4 1,15 * *"
    );
}

// ── serde（derive 完整性；CronSchedule 无事件引用，不入注册表）──

/// CronSchedule/CronField serde 往返保真（cron-fired 事件不引用本类型，
/// 故不进事件注册表——registry_drift 可达性护栏禁止死条目）
#[test]
fn cron_schedule_serde_roundtrip() {
    let sched = parse_cron("0 8-10 * * 1-5").unwrap();
    let json = serde_json::to_value(&sched).unwrap();
    assert_eq!(json["hour"]["text"], "8-10");
    assert_eq!(json["hour"]["values"], serde_json::json!([8, 9, 10]));
    let back: CronSchedule = serde_json::from_value(json).unwrap();
    assert_eq!(sched, back);
}
