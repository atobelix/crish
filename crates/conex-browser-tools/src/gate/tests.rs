//! MvpDomainGate 单元测试（自 gate.rs 平移）。

use super::*;

/// 假 resolver：任何主机名解析到公网地址（确定性——不依赖 CI 真实 DNS）。
#[derive(Debug, Clone, Copy)]
struct AlwaysPublicResolver;

impl HostResolver for AlwaysPublicResolver {
    fn resolve(&self, _host: &str) -> Result<Vec<IpAddr>, String> {
        Ok(vec!["93.184.216.34".parse().expect("字面量 IP")])
    }
}

/// 假 resolver：解析失败（fail-closed/fail-open 策略测试面）。
#[derive(Debug, Clone, Copy)]
struct FailingResolver;

impl HostResolver for FailingResolver {
    fn resolve(&self, host: &str) -> Result<Vec<IpAddr>, String> {
        Err(format!("NXDOMAIN：{host}"))
    }
}

/// 假 resolver：返回固定地址列表（多 A 记录场景）。
#[derive(Debug, Clone)]
struct MultiIpResolver(Vec<IpAddr>);

impl HostResolver for MultiIpResolver {
    fn resolve(&self, _host: &str) -> Result<Vec<IpAddr>, String> {
        Ok(self.0.clone())
    }
}

fn gate(allow: &[&str], block: &[&str]) -> MvpDomainGate {
    gate_with_resolver(allow, block, Arc::new(AlwaysPublicResolver))
}

fn gate_with_resolver(
    allow: &[&str],
    block: &[&str],
    resolver: Arc<dyn HostResolver>,
) -> MvpDomainGate {
    MvpDomainGate::with_resolver(
        &allow.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        &block.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        resolver,
    )
    .expect("门禁构造失败")
}

fn denied(g: &MvpDomainGate, url: &str) -> Option<String> {
    match g.check(url) {
        Ok(()) => None,
        Err(d) => Some(d.reason),
    }
}

/// T-5 默认策略：白名单为空 → 公共域名放行（解析到公网）；IP 字面量保留段
/// 阻断；**本机回环默认放行**（本地测试页场景，§4.3 口径）。
#[test]
fn default_policy_blocks_reserved_ips() {
    let g = gate(&[], &[]);
    assert!(g.check("https://example.com").is_ok());
    assert!(g.check("https://www.example.com/a?b=1").is_ok());
    // 本机回环默认放行（127.0.0.0/8、::1、IPv4 映射回环；本地测试页场景）
    assert!(g.check("http://127.0.0.1:8080/").is_ok());
    assert!(g.check("http://[::1]/").is_ok());
    assert!(g.check("http://[::ffff:127.0.0.1]/").is_ok());
    for url in [
        "http://0.0.0.0/",
        "http://10.0.0.5/",
        "http://192.168.1.1/",
        "http://172.16.0.1/",
        "http://172.31.255.255/",
        "http://169.254.169.254/latest/meta-data/",
        "http://100.64.0.1/",
        "http://198.18.0.1/",
        "http://[fc00::1]/",
        "http://[fe80::1]/",
    ] {
        let reason = denied(&g, url).expect("应阻断");
        assert!(reason.contains("保留"), "命中段族应说明：{url} → {reason}");
    }
    // 非保留 IP 字面量（白名单为空默认放行，限公共互联网）
    assert!(g.check("http://8.8.8.8/").is_ok());
    assert!(g.check("http://[2001:4860:4860::8888]/").is_ok());
    // file:// 与 javascript: scheme 阻断
    assert!(denied(&g, "file:///C:/x").is_some());
    assert!(denied(&g, "javascript:alert(1)").is_some());
    // about 特例放行
    assert!(g.check("about:blank").is_ok());
}

/// 评审 F10：localhost 类主机名默认放行（不触发解析）；127.0.0.1/::1 字面量
/// 放行；黑名单显式命中仍阻断（黑名单不可豁免）。
#[test]
fn localhost_and_loopback_default_allowed() {
    let g = gate(&[], &[]);
    assert!(g.check("http://localhost:8080/").is_ok());
    assert!(g.check("http://localhost.localdomain/").is_ok());
    assert!(g.check("http://localhost.local/").is_ok());
    // 黑名单命中不豁免（本机地址亦不可豁免，§4.2）
    let g = gate(&[], &["localhost"]);
    assert!(denied(&g, "http://localhost:8080/").is_some());
    let g = gate(&[], &["127.0.0.1"]);
    assert!(denied(&g, "http://127.0.0.1:8080/").is_some());
}

/// 评审 F10：主机名解析校验（§4.3 步骤 3）——解析到内网/保留段（含回环）
/// 阻断（SSRF 面）；解析到公网放行。
#[test]
fn hostname_lookup_blocks_internal_resolution() {
    // 解析到公网 → 放行
    let g = gate(&[], &[]);
    assert!(g.check("https://any-public.example/").is_ok());
    // 解析到内网段 → 阻断
    let g = gate_with_resolver(
        &[],
        &[],
        Arc::new(MultiIpResolver(vec!["192.168.1.99".parse().unwrap()])),
    );
    let reason = denied(&g, "https://internal.example/").expect("应阻断");
    assert!(reason.contains("SSRF"), "说明：{reason}");
    // 解析到回环（非 localhost 主机名）→ 阻断（恶意 DNS 指向本机）
    let g = gate_with_resolver(
        &[],
        &[],
        Arc::new(MultiIpResolver(vec!["127.0.0.1".parse().unwrap()])),
    );
    let reason = denied(&g, "https://evil.example/").expect("应阻断");
    assert!(reason.contains("SSRF"), "说明：{reason}");
    // 多地址：任一命中保留段即阻断（DNS 多 A 记录场景）
    let g = gate_with_resolver(
        &[],
        &[],
        Arc::new(MultiIpResolver(vec![
            "93.184.216.34".parse().unwrap(),
            "10.0.0.1".parse().unwrap(),
        ])),
    );
    assert!(
        denied(&g, "https://mixed.example/").is_some(),
        "多地址含内网即阻断"
    );
}

/// 评审 F10：解析失败策略——默认 fail-closed（阻断）；`with_fail_closed_resolve
/// (false)` 可配 fail-open（放行）。
#[test]
fn lookup_failure_fail_closed_by_default() {
    let g = gate_with_resolver(&[], &[], Arc::new(FailingResolver));
    let reason = denied(&g, "https://no-such-host.invalid/").expect("fail-closed 应阻断");
    assert!(reason.contains("fail-closed"), "说明：{reason}");
    // 可配 fail-open：解析失败放行（解析成功命中内网仍阻断）
    let g = gate_with_resolver(&[], &[], Arc::new(FailingResolver)).with_fail_closed_resolve(false);
    assert!(g.check("https://no-such-host.invalid/").is_ok());
    // fail-open 不影响解析成功的阻断面
    let g = gate_with_resolver(
        &[],
        &[],
        Arc::new(MultiIpResolver(vec!["10.0.0.1".parse().unwrap()])),
    )
    .with_fail_closed_resolve(false);
    assert!(denied(&g, "https://internal.example/").is_some());
}

/// 评审 F10：白名单显式命中 = 显式信任——跳过解析校验（解析面不可达）。
/// 假 resolver 解析到内网，但白名单命中 → 放行。
#[test]
fn allowlist_explicit_trust_skips_lookup() {
    let g = gate_with_resolver(
        &["trusted.example"],
        &[],
        Arc::new(MultiIpResolver(vec!["10.0.0.1".parse().unwrap()])),
    );
    assert!(
        g.check("https://trusted.example/").is_ok(),
        "白名单显式信任跳过解析校验"
    );
    assert!(
        denied(&g, "https://other.example/").is_some(),
        "白名单非空时白名单外 Deny"
    );
}

/// 评审 F10：SystemResolver 对 IP 字面量解析不经 DNS（确定性命中）。
#[test]
fn system_resolver_resolves_literal_ips() {
    let r = SystemResolver;
    let ips = r.resolve("8.8.8.8").expect("IP 字面量解析不应失败");
    assert!(ips.contains(&"8.8.8.8".parse::<IpAddr>().unwrap()));
}

/// T-6 白名单硬化：`*.corp.example` 不含根域；`example.com` 含根域 + 子域。
#[test]
fn allowlist_hardening_semantics() {
    let g = gate(&["*.corp.example"], &[]);
    assert!(g.check("https://a.corp.example/").is_ok());
    assert!(g.check("https://a.b.corp.example/").is_ok());
    assert!(
        denied(&g, "https://corp.example/").is_some(),
        "*. 不含根域（R-7）"
    );
    assert!(denied(&g, "https://example.com/").is_some(), "白名单外拒绝");

    let g = gate(&["example.com"], &[]);
    assert!(g.check("https://example.com/").is_ok());
    assert!(
        g.check("https://www.example.com/").is_ok(),
        "根域条目含子域（R-7）"
    );
    assert!(g.check("https://a.b.example.com/").is_ok());
    assert!(
        denied(&g, "https://evil-example.com/").is_some(),
        "后缀伪装不得命中"
    );
    assert!(denied(&g, "https://example.com.evil.com/").is_some());
}

/// T-7 黑名单不可豁免（含全放行 `*`），且黑名单优先于白名单。
#[test]
fn blocklist_unconditional_and_precedence() {
    let g = gate(&["*"], &["*.evil.example"]);
    assert!(g.check("https://anywhere.example/").is_ok());
    assert!(denied(&g, "https://www.evil.example/").is_some());
    assert!(denied(&g, "https://a.b.evil.example/").is_some());
    // 同命中：黑名单优先
    let g = gate(&["good.example"], &["good.example"]);
    assert!(denied(&g, "https://good.example/").is_some());
}

/// 通配/大小写/尾点规范化。
#[test]
fn normalization_and_wildcards() {
    let g = gate(&["EXAMPLE.COM"], &[]);
    assert!(g.check("https://WWW.Example.COM/").is_ok(), "大小写不敏感");
    let g = gate(&["*"], &[]);
    assert!(g.check("https://anything.example/").is_ok());
}

/// 配置校验：TLD 通配/多星号/非法字符拒绝。
#[test]
fn config_rejects_invalid_patterns() {
    for bad in [
        "example.*",
        "*.",
        "*x.example",
        "exa*mple.com",
        "例子.com",
        "",
    ] {
        assert!(
            MvpDomainGate::new(&[bad.to_string()], &[]).is_err(),
            "应拒绝非法模式：{bad}"
        );
    }
    assert!(MvpDomainGate::new(&["*.example.com".to_string()], &[]).is_ok());
    assert!(
        MvpDomainGate::new(&["127.0.0.1".to_string()], &[]).is_ok(),
        "IP 字面量可入白名单"
    );
    assert!(MvpDomainGate::new(&["::1".to_string()], &[]).is_ok());
}

/// IP 字面量白名单是本机调试站点唯一放行途径（§4.2）。
#[test]
fn ip_literal_allowlist_permits_loopback() {
    let g = gate(&["127.0.0.1"], &[]);
    assert!(g.check("http://127.0.0.1:8080/").is_ok());
    // 但保留段之外的 IP 不可借白名单任意放行？——白名单显式 IP 条目即显式信任
    let g = gate(&["8.8.8.8"], &[]);
    assert!(g.check("http://8.8.8.8/").is_ok());
    assert!(
        denied(&g, "http://9.9.9.9/").is_some(),
        "白名单非空时白名单外 Deny"
    );
}

/// 段表程序化一致性：IPv4 段边界抽查。
#[test]
fn ipv4_segment_boundaries() {
    use std::net::Ipv4Addr;
    assert!(
        !ipv4_reserved(&Ipv4Addr::new(172, 15, 0, 1)),
        "172.15 在 /12 段外"
    );
    assert!(ipv4_reserved(&Ipv4Addr::new(172, 16, 0, 1)));
    assert!(!ipv4_reserved(&Ipv4Addr::new(172, 32, 0, 1)));
    assert!(ipv4_reserved(&Ipv4Addr::new(172, 31, 255, 255)));
    assert!(ipv4_reserved(&Ipv4Addr::new(100, 127, 255, 255)));
    assert!(!ipv4_reserved(&Ipv4Addr::new(100, 128, 0, 1)));
    assert!(ipv4_reserved(&Ipv4Addr::new(198, 19, 255, 255)));
    assert!(!ipv4_reserved(&Ipv4Addr::new(198, 20, 0, 1)));
    assert!(ipv4_reserved(&Ipv4Addr::new(0, 0, 0, 0)));
    assert!(ipv4_reserved(&Ipv4Addr::new(127, 0, 0, 1)));
    assert!(!ipv4_reserved(&Ipv4Addr::new(8, 8, 8, 8)));
}
