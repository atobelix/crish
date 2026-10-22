//! 域名门禁策略与模式匹配测试

use crate::action::gate::DomainGate;
use crate::gate::formal::FormalDomainGate;
use crate::gate::tests::{denied, gate};

/// T-5 默认策略：白名单为空 → 公共域名放行（解析到公网）；IP 字面量保留段
/// 阻断；本机回环默认放行（本地测试页场景，§4.3 口径）。
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
    assert!(g.check("about:newtab").is_ok());
}

/// 评审 F10：localhost 类主机名默认放行（不触发解析）；黑名单显式命中
/// 仍阻断（黑名单不可豁免）。
#[test]
fn localhost_and_loopback_default_allowed() {
    let g = gate(&[], &[]);
    assert!(g.check("http://localhost:8080/").is_ok());
    assert!(g.check("http://localhost.localdomain/").is_ok());
    let g = gate(&[], &["localhost"]);
    assert!(denied(&g, "http://localhost:8080/").is_some());
    let g = gate(&[], &["127.0.0.1"]);
    assert!(denied(&g, "http://127.0.0.1:8080/").is_some());
}

/// T-6/T-7 通配符语义 + 黑名单不可豁免 + 配置校验。
#[test]
fn wildcard_and_blocklist_semantics() {
    let g = gate(&["*.corp.example"], &[]);
    assert!(g.check("https://a.corp.example/").is_ok());
    assert!(denied(&g, "https://corp.example/").is_some(), "*. 不含根域");
    assert!(denied(&g, "https://example.com/").is_some(), "白名单外拒绝");

    let g = gate(&["example.com"], &[]);
    assert!(g.check("https://example.com/").is_ok());
    assert!(
        g.check("https://www.example.com/").is_ok(),
        "根域条目含子域"
    );
    assert!(denied(&g, "https://evil-example.com/").is_some());
    assert!(denied(&g, "https://example.com.evil.com/").is_some());

    // 黑名单不可豁免（含全放行 `*`），黑名单优先于白名单
    let g = gate(&["*"], &["*.evil.example"]);
    assert!(g.check("https://anywhere.example/").is_ok());
    assert!(denied(&g, "https://www.evil.example/").is_some());
    let g = gate(&["good.example"], &["good.example"]);
    assert!(denied(&g, "https://good.example/").is_some());

    // 大小写/尾点规范化
    let g = gate(&["EXAMPLE.COM"], &[]);
    assert!(g.check("https://WWW.Example.COM./").is_ok());

    // 配置校验：TLD 通配/多星号/非法字符拒绝
    for bad in ["example.*", "*.", "*x.example", "exa*mple.com", ""] {
        assert!(
            FormalDomainGate::new(&[bad.to_string()], &[]).is_err(),
            "应拒绝非法模式：{bad}"
        );
    }
    assert!(FormalDomainGate::new(&["*.example.com".to_string()], &[]).is_ok());
    assert!(
        FormalDomainGate::new(&["127.0.0.1".to_string()], &[]).is_ok(),
        "IP 字面量可入白名单"
    );
}

/// IP 字面量白名单是本机调试站点唯一放行途径（§4.2）。
#[test]
fn ip_literal_allowlist_permits_loopback() {
    let g = gate(&["127.0.0.1"], &[]);
    assert!(g.check("http://127.0.0.1:8080/").is_ok());
    assert!(
        denied(&g, "http://10.0.0.1/").is_some(),
        "白名单 IP 条目只豁免本条目，其余保留段仍阻断"
    );
    let g = gate(&["8.8.8.8"], &[]);
    assert!(g.check("http://8.8.8.8/").is_ok());
    assert!(denied(&g, "http://9.9.9.9/").is_some(), "白名单外 Deny");
}
