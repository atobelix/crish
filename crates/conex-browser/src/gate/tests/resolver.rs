//! 域名门禁 DNS 解析与 60s 重绑定窗口测试

use std::net::IpAddr;
use std::sync::Arc;

use crate::action::gate::DomainGate;
use crate::gate::formal::FormalDomainGate;
use crate::gate::tests::{
    FailingResolver, MockClock, MultiIpResolver, SequenceResolver, denied, gate,
};
use crate::gate::types::{HostResolver, SystemResolver};

/// 评审 F10：主机名解析校验（§4.3 步骤 3）——解析到内网/保留段（含回环）
/// 阻断（SSRF 面）；解析到公网放行。
#[test]
fn hostname_lookup_blocks_internal_resolution() {
    let g = gate(&[], &[]);
    assert!(g.check("https://any-public.example/").is_ok());
    let g = FormalDomainGate::with_resolver(
        &[],
        &[],
        Arc::new(MultiIpResolver(vec!["192.168.1.99".parse().unwrap()])),
    )
    .unwrap();
    let reason = denied(&g, "https://internal.example/").expect("应阻断");
    assert!(reason.contains("SSRF"), "说明：{reason}");
    // 解析到回环（非 localhost 主机名）→ 阻断（恶意 DNS 指向本机）
    let g = FormalDomainGate::with_resolver(
        &[],
        &[],
        Arc::new(MultiIpResolver(vec!["127.0.0.1".parse().unwrap()])),
    )
    .unwrap();
    let reason = denied(&g, "https://evil.example/").expect("应阻断");
    assert!(reason.contains("SSRF"), "说明：{reason}");
    // 多地址：任一命中保留段即阻断（DNS 多 A 记录场景）
    let g = FormalDomainGate::with_resolver(
        &[],
        &[],
        Arc::new(MultiIpResolver(vec![
            "93.184.216.34".parse().unwrap(),
            "10.0.0.1".parse().unwrap(),
        ])),
    )
    .unwrap();
    assert!(
        denied(&g, "https://mixed.example/").is_some(),
        "多地址含内网即阻断"
    );
}

/// 评审 F10：解析失败策略——默认 fail-closed（阻断）；`with_fail_closed_resolve
/// (false)` 可配 fail-open（放行）。
#[test]
fn lookup_failure_fail_closed_by_default() {
    let g = FormalDomainGate::with_resolver(&[], &[], Arc::new(FailingResolver)).unwrap();
    let reason = denied(&g, "https://no-such-host.invalid/").expect("fail-closed 应阻断");
    assert!(reason.contains("fail-closed"), "说明：{reason}");
    let g = FormalDomainGate::with_resolver(&[], &[], Arc::new(FailingResolver))
        .unwrap()
        .with_fail_closed_resolve(false);
    assert!(g.check("https://no-such-host.invalid/").is_ok());
}

/// 评审 F10：白名单显式命中 = 显式信任——跳过解析校验（解析面不可达）。
#[test]
fn allowlist_explicit_trust_skips_lookup() {
    let g = FormalDomainGate::with_resolver(
        &["trusted.example".to_string()],
        &[],
        Arc::new(MultiIpResolver(vec!["10.0.0.1".parse().unwrap()])),
    )
    .unwrap();
    assert!(
        g.check("https://trusted.example/").is_ok(),
        "白名单显式信任跳过解析校验"
    );
    assert!(
        denied(&g, "https://other.example/").is_some(),
        "白名单非空时白名单外 Deny"
    );
}

/// R-11 §4.3 步骤 4：60s 重绑定窗口——首次校验通过（公网 IP）后，窗口内
/// 每动作一次重新解析；重绑定（随后解析到内网）被第二次校验拦截；
/// 解析器调用计数证明无结果缓存（每动作一次解析）。
#[test]
fn rebinding_window_catches_rebind_within_60s() {
    let clock = Arc::new(MockClock::default());
    let resolver = Arc::new(SequenceResolver::new(vec![
        Ok(vec!["93.184.216.34".parse().unwrap()]),
        Ok(vec!["10.0.0.1".parse().unwrap()]),
    ]));
    let g = FormalDomainGate::with_parts(&[], &[], resolver.clone(), true, clock.clone()).unwrap();

    // 首次校验：公网 IP → 放行，窗口起点记录
    assert!(g.check("https://example.com/").is_ok());
    assert!(
        g.within_rebinding_window("example.com"),
        "校验通过后进入 60s 窗口"
    );
    assert_eq!(resolver.call_count(), 1);

    // 窗口内第二次校验（时钟推进 30s < 60s）：解析器再次被调用（每动作一次），
    // 重绑定到内网 → 阻断
    clock.advance(30_000);
    let reason = denied(&g, "https://example.com/").expect("重绑定应被拦截");
    assert!(reason.contains("SSRF"), "说明：{reason}");
    assert_eq!(
        resolver.call_count(),
        2,
        "窗口内每动作一次重新解析（无结果缓存）"
    );
}

/// R-11 §4.3 步骤 4：窗口过期——60s 后条目清除，重新按常规路径全量校验；
/// 期间未校验的主机不在窗口内。
#[test]
fn rebinding_window_expires_after_60s() {
    let clock = Arc::new(MockClock::default());
    let resolver = Arc::new(MultiIpResolver(vec!["93.184.216.34".parse().unwrap()]));
    let g = FormalDomainGate::with_parts(&[], &[], resolver, true, clock.clone()).unwrap();
    assert!(g.check("https://example.com/").is_ok());
    assert!(g.within_rebinding_window("example.com"));
    // 窗口内仍有效
    clock.advance(59_000);
    assert!(g.within_rebinding_window("example.com"));
    // 过期：60s 边界外窗口关闭
    clock.advance(2_000);
    assert!(
        !g.within_rebinding_window("example.com"),
        "60s 后窗口应关闭"
    );
    // 过期后再次校验：按常规路径重新全量校验（仍放行公网）
    assert!(g.check("https://example.com/").is_ok());
    assert!(
        g.within_rebinding_window("example.com"),
        "新校验重新开启窗口"
    );
}

/// SystemResolver 对 IP 字面量解析不经 DNS（确定性命中）。
#[test]
fn system_resolver_resolves_literal_ips() {
    let r = SystemResolver;
    let ips = r.resolve("8.8.8.8").expect("IP 字面量解析不应失败");
    assert!(ips.contains(&"8.8.8.8".parse::<IpAddr>().unwrap()));
}
