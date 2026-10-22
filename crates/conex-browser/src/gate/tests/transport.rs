//! 传输层门禁与段表边界测试

use std::net::{Ipv4Addr, Ipv6Addr};

use crate::gate::segments::{ipv4_reserved, ipv6_reserved};
use crate::gate::tests::{RecordingSender, glob_match};
use crate::gate::transport::{TransportGate, blocked_urls};

/// R-11 传输层：段表程序化生成——清单覆盖全部保留段（IPv4/IPv6 逐段抽样
/// glob 命中），公网/段外抽样不命中；云元数据端点显式在列。
#[test]
fn blocked_urls_cover_segments() {
    let urls = blocked_urls();
    // 关键条目显式断言（段表与模式同源）
    for expected in [
        "http://0.*",
        "http://10.*",
        "http://127.*",
        "http://192.168.*",
        "http://169.254.*",
        "http://169.254.169.254/*",
        "http://198.18.*",
        "http://198.19.*",
        "http://[::1]*",
        "http://[fc*",
        "http://[fd*",
        "http://[::ffff:*",
    ] {
        assert!(urls.iter().any(|p| p == expected), "应含条目：{expected}");
    }
    // 172.16/12 → 逐 /16 共 16 条
    for b in 16..=31u8 {
        let expected = format!("http://172.{b}.*");
        assert!(urls.iter().any(|p| p == &expected), "应含条目：{expected}");
    }
    // 100.64/10 → 逐 /16 共 64 条
    for b in 64..=127u8 {
        let expected = format!("http://100.{b}.*");
        assert!(urls.iter().any(|p| p == &expected), "应含条目：{expected}");
    }
    // fe80::/10 → 4 个 /12 前缀通配
    for prefix in ["fe8", "fe9", "fea", "feb"] {
        let expected = format!("http://[{prefix}*");
        assert!(urls.iter().any(|p| p == &expected), "应含条目：{expected}");
    }

    // 段内抽样 glob 命中 (涵盖 http 与 https 双协议)
    let matches = |ip_url: &str| urls.iter().any(|p| glob_match(p, ip_url));
    for sample in [
        "http://10.1.2.3/x",
        "https://10.1.2.3/x",
        "http://172.16.0.1/",
        "https://172.16.0.1/",
        "http://172.31.255.255/",
        "https://172.31.255.255/",
        "http://192.168.100.1:8080/",
        "https://192.168.100.1:8080/",
        "http://169.254.169.254/latest/meta-data/",
        "https://169.254.169.254/latest/meta-data/",
        "http://100.64.0.1/",
        "https://100.64.0.1/",
        "http://100.127.255.255/",
        "http://198.19.1.1/",
        "http://0.0.0.0/",
        "http://127.0.0.1/",
        "https://127.0.0.1/",
        "http://[::1]/",
        "https://[::1]/",
        "http://[fc00::1]/",
        "https://[fc00::1]/",
        "http://[fdff::1]/",
        "http://[fe80::1]/",
        "https://[fe80::1]/",
        "http://[febf::1]/",
        "http://[::ffff:10.0.0.1]/",
        "https://[::ffff:10.0.0.1]/",
    ] {
        assert!(matches(sample), "段内地址应被阻断清单覆盖：{sample}");
    }
    // 公网/段外抽样不命中
    for sample in [
        "http://8.8.8.8/",
        "https://8.8.8.8/",
        "http://1.1.1.1/",
        "https://1.1.1.1/",
        "http://172.15.0.1/",
        "http://172.32.0.1/",
        "http://100.63.0.1/",
        "http://100.128.0.1/",
        "http://198.17.0.1/",
        "http://198.20.0.1/",
        "http://169.253.0.1/",
        "http://[2001:4860:4860::8888]/",
        "https://[2001:4860:4860::8888]/",
        "http://[2606:2800::1]/",
        "http://[fec0::1]/",
    ] {
        assert!(!matches(sample), "段外地址不应被覆盖：{sample}");
    }
}

/// R-11 传输层：mock 发送面接收 `Network.setBlockedURLs` 参数——参数类型
/// 复用既有 `SetBlockedURLsParams`，序列化 camelCase 正确。
#[test]
fn transport_gate_params_wire_and_apply() {
    let gate = TransportGate::new();
    assert_eq!(gate.patterns(), &blocked_urls());

    // 参数断言（mock 发送面）
    let params = gate.to_params();
    let v = serde_json::to_value(&params).expect("序列化失败");
    assert_eq!(v["urls"], serde_json::json!(gate.patterns()));
    assert_eq!(
        v["urls"].as_array().map(Vec::len),
        Some(gate.patterns().len())
    );

    // apply：经 mock 发送面下发阻断清单
    let sender = RecordingSender::default();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(gate.apply(&sender))
        .expect("apply 失败");
    assert_eq!(sender.calls.lock().unwrap().len(), 1);
    assert_eq!(sender.calls.lock().unwrap()[0], *gate.patterns());
}

/// R-11 传输层：iframe 导航订阅——NavigationStarted 事件到达后重挂阻断清单
/// （幂等重挂，覆盖主 URL 不变的 iframe 内网导航请求）。
#[test]
fn transport_gate_iframe_subscription_reapplies() {
    let gate = TransportGate::new();
    let sender = RecordingSender::default();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        gate.apply(&sender).await.expect("首次应用失败");
        // iframe 导航事件 → 重挂（幂等：清单不变、再次下发）
        gate.on_frame_navigated(&sender).await.expect("重挂失败");
    });
    let calls = sender.calls.lock().unwrap();
    assert_eq!(calls.len(), 2, "iframe 导航应触发重挂");
    assert_eq!(calls[0], calls[1], "重挂清单不变（幂等）");
    assert_eq!(calls[1], *gate.patterns());
}

/// 段表程序化一致性：IPv4/IPv6 段边界抽查。
#[test]
fn segment_boundaries() {
    assert!(!ipv4_reserved(&Ipv4Addr::new(172, 15, 0, 1)));
    assert!(ipv4_reserved(&Ipv4Addr::new(172, 16, 0, 1)));
    assert!(ipv4_reserved(&Ipv4Addr::new(172, 31, 255, 255)));
    assert!(ipv4_reserved(&Ipv4Addr::new(100, 127, 255, 255)));
    assert!(!ipv4_reserved(&Ipv4Addr::new(100, 128, 0, 1)));
    assert!(ipv4_reserved(&Ipv4Addr::new(198, 19, 255, 255)));
    assert!(!ipv4_reserved(&Ipv4Addr::new(198, 20, 0, 1)));
    assert!(ipv4_reserved(&Ipv4Addr::new(0, 0, 0, 0)));
    assert!(!ipv4_reserved(&Ipv4Addr::new(8, 8, 8, 8)));
    assert!(ipv6_reserved(&Ipv6Addr::LOCALHOST));
    assert!(ipv6_reserved(&"fc00::1".parse::<Ipv6Addr>().unwrap()));
    assert!(ipv6_reserved(&"fdff::1".parse::<Ipv6Addr>().unwrap()));
    assert!(ipv6_reserved(&"fe80::1".parse::<Ipv6Addr>().unwrap()));
    assert!(ipv6_reserved(
        &"::ffff:10.0.0.1".parse::<Ipv6Addr>().unwrap()
    ));
    assert!(!ipv6_reserved(
        &"2001:4860:4860::8888".parse::<Ipv6Addr>().unwrap()
    ));
    assert!(!ipv6_reserved(&"fec0::1".parse::<Ipv6Addr>().unwrap()));
}
