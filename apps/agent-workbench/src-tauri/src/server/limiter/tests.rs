//! server limiter 测试（limiter.rs 拆分）：连接上限与配对限速。

use super::*;

/// T-12 断言锚：每设备最多 2（D5 §7.2「每设备并发连接 2」）
#[test]
fn limiter_acquires_up_to_per_device_limit() {
    let limiter = ConnectionLimiter::new();
    assert_eq!(limiter.acquire("device-a"), LimiterOutcome::Acquired);
    assert_eq!(limiter.acquire("device-a"), LimiterOutcome::Acquired);
    assert_eq!(limiter.count_for("device-a"), 2);
    assert_eq!(limiter.count(), 2);
}

/// T-12 断言锚：第 3 个同设备连接 → 结构化拒绝 + 审计计数
#[test]
fn limiter_third_per_device_connection_rejected_with_audit() {
    let limiter = ConnectionLimiter::new();
    assert_eq!(limiter.acquire("device-a"), LimiterOutcome::Acquired);
    assert_eq!(limiter.acquire("device-a"), LimiterOutcome::Acquired);
    let outcome = limiter.acquire("device-a");
    assert_eq!(
        outcome,
        LimiterOutcome::RejectedPerDevice {
            limit: 2,
            current: 2
        }
    );
    // 审计：每设备拒绝计数 +1；总量拒绝计数不受影响
    assert_eq!(limiter.audit_rejected_per_device(), 1);
    assert_eq!(limiter.audit_rejected_total(), 0);
    // 拒绝不消耗额度（记账态不变）
    assert_eq!(limiter.count_for("device-a"), 2);
    assert_eq!(limiter.count(), 2);
}

/// T-12 断言锚：总量 8 满后第 9 个连接 → 结构化拒绝 + 审计计数
#[test]
fn limiter_total_limit_rejects_ninth_with_audit() {
    let limiter = ConnectionLimiter::new();
    for i in 0..8 {
        assert_eq!(
            limiter.acquire(&format!("dev-{i}")),
            LimiterOutcome::Acquired,
            "前 8 个设备必须全部占用成功"
        );
    }
    let outcome = limiter.acquire("dev-8");
    assert_eq!(
        outcome,
        LimiterOutcome::RejectedTotal {
            limit: 8,
            current: 8
        }
    );
    assert_eq!(limiter.audit_rejected_total(), 1);
    assert_eq!(limiter.audit_rejected_per_device(), 0);
    assert_eq!(limiter.count(), 8, "拒绝不得改变记账态");
}

/// release 释放额度：每设备与总量同步回收，可再次占用
#[test]
fn limiter_release_frees_per_device_and_total_slots() {
    let limiter = ConnectionLimiter::new();
    assert_eq!(limiter.acquire("device-a"), LimiterOutcome::Acquired);
    assert_eq!(limiter.acquire("device-a"), LimiterOutcome::Acquired);
    limiter.release("device-a");
    assert_eq!(limiter.count_for("device-a"), 1);
    assert_eq!(limiter.count(), 1);
    assert_eq!(
        limiter.acquire("device-a"),
        LimiterOutcome::Acquired,
        "释放后必须可再占用"
    );
    // 总量维度：8 个设备占满后，释放一个 → 新设备可接入
    let limiter = ConnectionLimiter::new();
    for i in 0..8 {
        assert_eq!(
            limiter.acquire(&format!("dev-{i}")),
            LimiterOutcome::Acquired
        );
    }
    limiter.release("dev-0");
    assert_eq!(
        limiter.acquire("dev-8"),
        LimiterOutcome::Acquired,
        "释放总量槽位后必须可再占用"
    );
}

/// release 幂等：对未持有/已清零的键静默（不 panic、不欠账）
#[test]
fn limiter_release_is_idempotent() {
    let limiter = ConnectionLimiter::new();
    limiter.release("never-acquired");
    assert_eq!(limiter.count(), 0);
    assert_eq!(limiter.acquire("device-a"), LimiterOutcome::Acquired);
    limiter.release("device-a");
    limiter.release("device-a");
    limiter.release("device-a");
    assert_eq!(limiter.count(), 0, "重复释放不得把计数减到 0 以下");
    assert_eq!(limiter.audit_rejected_per_device(), 0);
}

/// reset 整体清零：占用清空、可重新接入；审计计数保留（累计面不重置）
#[test]
fn limiter_reset_clears_usage_but_keeps_audit() {
    let limiter = ConnectionLimiter::new();
    assert_eq!(limiter.acquire("device-a"), LimiterOutcome::Acquired);
    assert_eq!(limiter.acquire("device-a"), LimiterOutcome::Acquired);
    assert_eq!(limiter.acquire("device-b"), LimiterOutcome::Acquired);
    assert_eq!(
        limiter.acquire("device-a"),
        LimiterOutcome::RejectedPerDevice {
            limit: 2,
            current: 2
        }
    );
    let audit_before = limiter.audit_rejected_per_device();
    limiter.reset();
    assert_eq!(limiter.count(), 0);
    assert_eq!(limiter.count_for("device-a"), 0);
    assert_eq!(
        limiter.acquire("device-a"),
        LimiterOutcome::Acquired,
        "重置后必须可重新接入"
    );
    assert_eq!(
        limiter.audit_rejected_per_device(),
        audit_before,
        "审计计数是累计面，不得随状态重置抹除"
    );
}

/// 自定义限值（测试 / 未来配置面入口）
#[test]
fn limiter_custom_limits_respected() {
    let limiter = ConnectionLimiter::with_limits(1, 3);
    assert_eq!(limiter.per_device_limit(), 1);
    assert_eq!(limiter.total_limit(), 3);
    assert_eq!(limiter.acquire("device-a"), LimiterOutcome::Acquired);
    assert_eq!(
        limiter.acquire("device-a"),
        LimiterOutcome::RejectedPerDevice {
            limit: 1,
            current: 1
        }
    );
    assert_eq!(limiter.acquire("device-b"), LimiterOutcome::Acquired);
    assert_eq!(limiter.acquire("device-c"), LimiterOutcome::Acquired);
    assert_eq!(
        limiter.acquire("device-d"),
        LimiterOutcome::RejectedTotal {
            limit: 3,
            current: 3
        }
    );
}

/// 队列拒绝语义：超限同步返回拒绝，不存在排队等待路径（D5 §7.2
/// 「队列满 → 立即拒绝（不排队等待）」）——acquire 同步返回即证明，
/// 连续重试仍拒绝（不因等待/轮换而放行）
#[test]
fn limiter_rejects_without_queuing() {
    let limiter = ConnectionLimiter::new();
    for i in 0..8 {
        assert_eq!(
            limiter.acquire(&format!("dev-{i}")),
            LimiterOutcome::Acquired
        );
    }
    assert!(matches!(
        limiter.acquire("dev-8"),
        LimiterOutcome::RejectedTotal { .. }
    ));
    assert!(matches!(
        limiter.acquire("dev-8"),
        LimiterOutcome::RejectedTotal { .. }
    ));
    assert_eq!(limiter.count(), 8, "拒绝路径不得产生占用");
}

// ── 配对请求限速器（D2 §12.4：10 次/分钟/源 IP；AU4 问题 #1 收口）──

/// D2 §12.4 断言锚：同 IP 前 10 次全部放行，窗口内计数递增至上限
#[test]
fn pair_limiter_allows_up_to_limit_per_ip() {
    let limiter = PairRateLimiter::new();
    let ip: std::net::IpAddr = "192.168.1.10".parse().expect("固定测试 IP");
    let t0 = 1_000_000;
    for i in 1..=DEFAULT_PAIR_LIMIT {
        assert_eq!(
            limiter.check_and_count(ip, t0),
            PairRateOutcome::Allowed,
            "第 {i} 次应在窗口内放行"
        );
        assert_eq!(limiter.count_for(ip), i, "放行后窗口计数必须递增");
    }
    assert_eq!(limiter.audit_rejected(), 0);
}

/// D2 §12.4 断言锚：第 11 次同 IP → 结构化拒绝（携带 limit/current）+
/// 审计计数 +1
#[test]
fn pair_limiter_11th_request_rejected_with_audit() {
    let limiter = PairRateLimiter::new();
    let ip: std::net::IpAddr = "192.168.1.10".parse().expect("固定测试 IP");
    let t0 = 1_000_000;
    for _ in 0..DEFAULT_PAIR_LIMIT {
        assert_eq!(limiter.check_and_count(ip, t0), PairRateOutcome::Allowed);
    }
    assert_eq!(
        limiter.check_and_count(ip, t0),
        PairRateOutcome::Rejected {
            limit: DEFAULT_PAIR_LIMIT,
            current: DEFAULT_PAIR_LIMIT
        }
    );
    assert_eq!(limiter.audit_rejected(), 1, "超限必须审计 +1");
}

/// 窗口重置（惰性推进，注入时间）：窗口内拒绝 → 推进满 60s → 重置
/// 放行；推进不足 60s → 仍拒绝（窗口边界精确）
#[test]
fn pair_limiter_window_resets_lazily_on_time_advance() {
    let limiter = PairRateLimiter::new();
    let ip: std::net::IpAddr = "192.168.1.10".parse().expect("固定测试 IP");
    let t0 = 1_000_000;
    for _ in 0..DEFAULT_PAIR_LIMIT {
        assert_eq!(limiter.check_and_count(ip, t0), PairRateOutcome::Allowed);
    }
    // 窗口内（< 60s）：仍拒绝
    assert!(
        matches!(
            limiter.check_and_count(ip, t0 + DEFAULT_PAIR_WINDOW_MS - 1),
            PairRateOutcome::Rejected { .. }
        ),
        "窗口未满 60s 不得重置"
    );
    // 推进满 60s：惰性重置 → 放行，计数重新从 1 计
    assert_eq!(
        limiter.check_and_count(ip, t0 + DEFAULT_PAIR_WINDOW_MS),
        PairRateOutcome::Allowed,
        "窗口过期后必须重置放行"
    );
    assert_eq!(limiter.count_for(ip), 1, "重置后窗口计数应从新窗口起算");
    // 新窗口再次放行至上限
    for _ in 1..DEFAULT_PAIR_LIMIT {
        assert_eq!(
            limiter.check_and_count(ip, t0 + DEFAULT_PAIR_WINDOW_MS),
            PairRateOutcome::Allowed
        );
    }
    assert!(
        matches!(
            limiter.check_and_count(ip, t0 + DEFAULT_PAIR_WINDOW_MS),
            PairRateOutcome::Rejected { .. }
        ),
        "新窗口打满后必须再次拒绝"
    );
    assert_eq!(limiter.audit_rejected(), 2, "两次窗口各自超限各审计一次");
}

/// 每源 IP 独立桶：IP-A 打满拒绝不影响 IP-B 的窗口额度
#[test]
fn pair_limiter_buckets_are_independent_per_ip() {
    let limiter = PairRateLimiter::new();
    let ip_a: std::net::IpAddr = "192.168.1.10".parse().expect("固定测试 IP");
    let ip_b: std::net::IpAddr = "192.168.1.11".parse().expect("固定测试 IP");
    let t0 = 1_000_000;
    for _ in 0..DEFAULT_PAIR_LIMIT {
        assert_eq!(limiter.check_and_count(ip_a, t0), PairRateOutcome::Allowed);
    }
    assert!(
        matches!(
            limiter.check_and_count(ip_a, t0),
            PairRateOutcome::Rejected { .. }
        ),
        "IP-A 打满必须拒绝"
    );
    assert_eq!(
        limiter.check_and_count(ip_b, t0),
        PairRateOutcome::Allowed,
        "IP-B 独立桶不受 IP-A 影响"
    );
    assert_eq!(limiter.count_for(ip_b), 1);
    assert_eq!(limiter.audit_rejected(), 1, "IP-B 的放行不得产生审计");
}

/// 拒绝不计数（防拒绝路径被刷爆当前窗口）：连续拒绝后窗口计数恒为
/// 上限值，审计逐次递增
#[test]
fn pair_limiter_rejected_requests_do_not_count() {
    let limiter = PairRateLimiter::new();
    let ip: std::net::IpAddr = "192.168.1.10".parse().expect("固定测试 IP");
    let t0 = 1_000_000;
    for _ in 0..DEFAULT_PAIR_LIMIT {
        assert_eq!(limiter.check_and_count(ip, t0), PairRateOutcome::Allowed);
    }
    for expected_audit in 1..=3 {
        assert!(
            matches!(
                limiter.check_and_count(ip, t0),
                PairRateOutcome::Rejected { .. }
            ),
            "第 {expected_audit} 次拒绝"
        );
        assert_eq!(limiter.audit_rejected(), expected_audit, "拒绝逐次审计");
        assert_eq!(
            limiter.count_for(ip),
            DEFAULT_PAIR_LIMIT,
            "拒绝不得改变窗口计数"
        );
    }
}

/// 自定义配置（测试 / 未来配置面入口）：with_config(2, 1000)
#[test]
fn pair_limiter_custom_config_respected() {
    let limiter = PairRateLimiter::with_config(2, 1000);
    let ip: std::net::IpAddr = "192.168.1.10".parse().expect("固定测试 IP");
    assert_eq!(limiter.check_and_count(ip, 100), PairRateOutcome::Allowed);
    assert_eq!(limiter.check_and_count(ip, 200), PairRateOutcome::Allowed);
    assert_eq!(
        limiter.check_and_count(ip, 300),
        PairRateOutcome::Rejected {
            limit: 2,
            current: 2
        }
    );
    // 自定义窗口 1000ms 后重置
    assert_eq!(
        limiter.check_and_count(ip, 1100),
        PairRateOutcome::Allowed,
        "自定义窗口过期后必须重置"
    );
    assert_eq!(limiter.audit_rejected(), 1);
}
