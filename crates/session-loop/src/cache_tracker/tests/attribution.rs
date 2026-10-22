use conex_types::events::MissAttribution;

use super::{scalars, tools, tracker};

/// 首轮无基线 → 不计 miss（Cold 语义：正常首次）；第二轮 read 骤降 → miss
/// 归因 prefix-changed（system 变化，harness 自伤）
#[test]
fn record_usage_prefix_changed_attribution() {
    let mut t = tracker(60);
    t.capture_signature(Some("sys"), &tools(), &[]);
    assert!(t
        .record_usage(scalars(10_000, 8_000, 500, None), 100, 10_100, 1_000)
        .is_none());
    // 第二轮：system 变化 + read 降到 2000（missed = min(10000,10000) - 2000）
    t.capture_signature(Some("sys2"), &tools(), &[]);
    let miss = t
        .record_usage(scalars(10_000, 2_000, 500, None), 100, 10_100, 2_000)
        .expect("超过噪声地板必须计 miss");
    assert_eq!(miss.missed_tokens, 8_000);
    assert_eq!(miss.attribution, MissAttribution::PrefixChanged);
    assert!(!miss.model_changed);
    let stats = t.finish();
    assert_eq!(stats.missed_tokens, 8_000);
}

/// 模型切换：miss 仍计（pi 不豁免），归因 ModelSwitch，model_changed = true
#[test]
fn record_usage_model_switch_still_counts_miss() {
    let mut t = tracker(60);
    t.capture_signature(Some("sys"), &tools(), &[]);
    assert!(t
        .record_usage(scalars(10_000, 8_000, 500, None), 100, 10_100, 1_000)
        .is_none());
    t.on_model_switch();
    t.capture_signature(Some("sys"), &tools(), &[]);
    let miss = t
        .record_usage(scalars(10_000, 0, 0, None), 100, 10_100, 2_000)
        .expect("模型切换不豁免 miss");
    assert_eq!(miss.attribution, MissAttribution::ModelSwitch);
    assert!(miss.model_changed);
    assert_eq!(miss.missed_tokens, 10_000);
}

/// TTL 超时（idle ≥ ttl × 1000）→ 归因 idle-ttl-expired（T-35 classify
/// 判定序：TTL 优先）
#[test]
fn record_usage_ttl_expired_attribution() {
    let mut t = tracker(60);
    t.capture_signature(Some("sys"), &tools(), &[]);
    assert!(t
        .record_usage(scalars(10_000, 8_000, 500, None), 100, 10_100, 1_000)
        .is_none());
    t.capture_signature(Some("sys"), &tools(), &[]);
    // idle = 69_000 ≥ 60_000 → Expired；read 骤降到 0 但 TTL 判定优先
    let miss = t
        .record_usage(scalars(10_000, 0, 0, None), 100, 10_100, 70_000)
        .expect("TTL 超时必须计 miss");
    assert_eq!(miss.attribution, MissAttribution::IdleTtlExpired);
}

/// 兜底细化：read == 0 且报告过缓存 → zero-read；命中率低于 85% → low-read
#[test]
fn record_usage_zero_read_and_low_read_fallback() {
    let mut t = tracker(60);
    t.capture_signature(Some("sys"), &tools(), &[]);
    assert!(t
        .record_usage(scalars(10_000, 8_000, 500, None), 100, 10_100, 1_000)
        .is_none());
    t.capture_signature(Some("sys"), &tools(), &[]);
    let zero_read = t
        .record_usage(scalars(10_000, 0, 0, None), 100, 10_100, 2_000)
        .expect("read == 0 必须计 miss");
    assert_eq!(zero_read.attribution, MissAttribution::ZeroRead);
    let mut t = tracker(60);
    t.capture_signature(Some("sys"), &tools(), &[]);
    assert!(t
        .record_usage(scalars(10_000, 8_000, 500, None), 100, 10_100, 1_000)
        .is_none());
    t.capture_signature(Some("sys"), &tools(), &[]);
    // 命中率 10% < 85% 且 read > 0 → low-read
    let low_read = t
        .record_usage(scalars(10_000, 1_000, 500, None), 100, 10_100, 2_000)
        .expect("低命中率必须计 miss");
    assert_eq!(low_read.attribution, MissAttribution::LowRead);
}

/// 断裂判定接线（2026-08-09 零消费清理，DEEPCHECK-05 #5）：cacheRead
/// 骤降 >5% 且 >2000 token → 兜底归因 LowRead（即使命中率仍在 85% 以上
/// ——断裂是缓存条目被驱逐的强信号，P5 §3.4.2）；未达断裂阈值且命中率
/// 正常 → Unknown（不强判）
#[test]
fn record_usage_break_signal_forces_low_read() {
    let mut t = tracker(60);
    t.capture_signature(Some("sys"), &tools(), &[]);
    assert!(t
        .record_usage(scalars(40_000, 40_000, 0, None), 100, 40_100, 1_000)
        .is_none());
    // 第二轮：read 骤降 2100 token（5.25% > 5% 且 > 2000）→ 断裂信号
    t.capture_signature(Some("sys"), &tools(), &[]);
    let miss = t
        .record_usage(scalars(40_000, 37_900, 0, None), 100, 40_100, 2_000)
        .expect("超过噪声地板必须计 miss");
    assert_eq!(
        miss.attribution,
        MissAttribution::LowRead,
        "断裂信号强制 LowRead"
    );
    assert_eq!(miss.missed_tokens, 2_100);
    // 对照：下降 1500 token（3.75% < 5%）且命中率 96.25% ≥ 85% → 不强判
    let mut t2 = tracker(60);
    t2.capture_signature(Some("sys"), &tools(), &[]);
    assert!(t2
        .record_usage(scalars(40_000, 40_000, 0, None), 100, 40_100, 1_000)
        .is_none());
    t2.capture_signature(Some("sys"), &tools(), &[]);
    let miss = t2
        .record_usage(scalars(40_000, 38_500, 0, None), 100, 40_100, 2_000)
        .expect("超过噪声地板必须计 miss");
    assert_eq!(
        miss.attribution,
        MissAttribution::Unknown,
        "未达断裂阈值不强判"
    );
}

/// 噪声地板与 reportedCache 粘性：missed ≤ 1024 不计；从未报告过缓存活动不计
#[test]
fn record_usage_respects_noise_floor_and_sticky_flag() {
    let mut t = tracker(60);
    t.capture_signature(Some("sys"), &tools(), &[]);
    assert!(t
        .record_usage(scalars(10_000, 8_000, 500, None), 100, 10_100, 1_000)
        .is_none());
    t.capture_signature(Some("sys"), &tools(), &[]);
    // missed = 1024 恰好等于地板 → 不计
    assert!(t
        .record_usage(scalars(10_000, 8_976, 0, None), 100, 10_100, 2_000)
        .is_none());
    t.capture_signature(Some("sys"), &tools(), &[]);
    // 从未报告过缓存（首轮 read/write 全 0）→ 粘性挡下
    let mut t2 = tracker(60);
    t2.capture_signature(Some("sys"), &tools(), &[]);
    assert!(t2
        .record_usage(scalars(10_000, 0, 0, None), 100, 10_100, 1_000)
        .is_none());
    t2.capture_signature(Some("sys"), &tools(), &[]);
    assert!(
        t2.record_usage(scalars(10_000, 0, 0, None), 100, 10_100, 2_000)
            .is_none(),
        "从未报告过缓存活动 → 不计 miss"
    );
}
