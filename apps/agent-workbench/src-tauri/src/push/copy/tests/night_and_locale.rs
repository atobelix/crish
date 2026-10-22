use super::*;
use crate::push::engine::DecisionOutcome;
use crate::push::quiet::{NightSummary, NightSummaryGroup};

/// 夜间折叠摘要渲染（双语及设备感知）
#[test]
fn night_summary_copy_rendering_both_locales() {
    use crate::push::vendor::VendorPlatform;

    let groups = vec![
        NightSummaryGroup {
            scene: SceneId::RunCompleted,
            count: 2,
            first_at_ms: T0,
            last_at_ms: T0 + 1000,
            first_biz_key: "r-1".to_string(),
        },
        NightSummaryGroup {
            scene: SceneId::SubagentCompleted,
            count: 1,
            first_at_ms: T0 + 2000,
            last_at_ms: T0 + 2000,
            first_biz_key: "sa-1".to_string(),
        },
    ];

    let summary = NightSummary {
        date: "2026-10-14".to_string(),
        total: 3,
        first_at_ms: T0,
        last_at_ms: T0 + 2000,
        groups,
        body: "夜间完成 3 项：任务完成 ×2、子代理 sa-1 完成".to_string(),
    };

    // 中文默认
    let copy_zh = render_night_summary_copy(&summary);
    assert_eq!(copy_zh.title, "夜间通知摘要");
    assert_eq!(copy_zh.body, "夜间完成 3 项：任务完成 ×2、子代理 sa-1 完成");

    // 英文
    let copy_en = render_night_summary_with_locale(&summary, Some("en-US"));
    assert_eq!(copy_en.title, "Nighttime Summary");
    assert_eq!(
        copy_en.body,
        "3 items completed during quiet hours: 2 runs completed, Subagent sa-1 completed"
    );

    // 单项英文单数语法
    let single_group = vec![NightSummaryGroup {
        scene: SceneId::RunCompleted,
        count: 1,
        first_at_ms: T0,
        last_at_ms: T0,
        first_biz_key: "r-9".to_string(),
    }];
    let single_summary = NightSummary {
        date: "2026-10-14".to_string(),
        total: 1,
        first_at_ms: T0,
        last_at_ms: T0,
        groups: single_group,
        body: "夜间完成 1 项：任务 r-9 已完成".to_string(),
    };
    let single_en = render_night_summary_with_locale(&single_summary, Some("en"));
    assert_eq!(
        single_en.body,
        "1 item completed during quiet hours: Run r-9 completed"
    );

    // 设备渲染
    let en_device =
        VendorDevice::new("dev-en", "tok-1", VendorPlatform::Ios).with_language("en-GB");
    let copy_dev = render_night_summary_for_device(&single_summary, &en_device);
    assert_eq!(copy_dev.title, "Nighttime Summary");
    assert_eq!(
        copy_dev.body,
        "1 item completed during quiet hours: Run r-9 completed"
    );
}

/// message_with_copy_locale 组装测试
#[test]
fn message_with_copy_locale_fills_title_body() {
    use crate::push::vendor::VendorPlatform;

    let decision = PushDecision {
        deliver: true,
        scene: SceneId::RunFailed,
        level: SceneId::RunFailed.level(),
        severity: SceneId::RunFailed.level().severity(),
        dedupe_key: "run-terminal:run-42:failed".to_string(),
        payload: payload("run-42", Some("provider 401"), None),
        outcome: DecisionOutcome::Delivered,
    };

    // 英文 locale
    let msg_en =
        message_with_copy_locale(&decision, "push-000002".to_string(), 2, T0, Some("en-US"));
    assert_eq!(msg_en.title.as_deref(), Some("Run Failed"));
    assert_eq!(msg_en.body.as_deref(), Some("run-42: provider 401"));

    // 英文 device
    let en_device =
        VendorDevice::new("dev-en", "tok-1", VendorPlatform::Ios).with_language("en-US");
    let msg_dev =
        message_with_copy_for_device(&decision, "push-000003".to_string(), 3, T0, &en_device);
    assert_eq!(msg_dev.title.as_deref(), Some("Run Failed"));
    assert_eq!(msg_dev.body.as_deref(), Some("run-42: provider 401"));
}
