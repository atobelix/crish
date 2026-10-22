//! 保留/内网段表与判定（§4.3 判定与传输层阻断同源，单点维护）

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// IPv4 保留/内网段表（§4.3；含 CGNAT 100.64/10 与基准段 198.18/15 加固项）。
pub(crate) const IPV4_SEGMENTS: &[(Ipv4Addr, u8)] = &[
    (Ipv4Addr::new(0, 0, 0, 0), 8),
    (Ipv4Addr::new(10, 0, 0, 0), 8),
    (Ipv4Addr::new(127, 0, 0, 0), 8),
    (Ipv4Addr::new(172, 16, 0, 0), 12),
    (Ipv4Addr::new(192, 168, 0, 0), 16),
    (Ipv4Addr::new(169, 254, 0, 0), 16),
    (Ipv4Addr::new(100, 64, 0, 0), 10),
    (Ipv4Addr::new(198, 18, 0, 0), 15),
];

/// IPv6 保留/内网段表（§4.3；2001:db8::/32 文档段按常规对待，不列入）。
pub(crate) const IPV6_SEGMENTS: &[(Ipv6Addr, u8)] = &[
    (Ipv6Addr::LOCALHOST, 128),
    (Ipv6Addr::new(0xfc00, 0, 0, 0, 0, 0, 0, 0), 7),
    (Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 0), 10),
    (Ipv6Addr::new(0, 0, 0, 0, 0, 0xffff, 0, 0), 96),
];

/// IPv4 段命中判定（CIDR 前缀比对）。
pub(crate) fn ipv4_reserved(ip: &Ipv4Addr) -> bool {
    let value = u32::from(*ip);
    IPV4_SEGMENTS.iter().any(|(net, prefix)| {
        let mask = if *prefix == 0 {
            0
        } else {
            u32::MAX << (32 - *prefix as u32)
        };
        u32::from(*net) & mask == value & mask
    })
}

/// IPv6 段命中判定（CIDR 前缀比对）。
pub(crate) fn ipv6_reserved(ip: &Ipv6Addr) -> bool {
    let value = u128::from(*ip);
    IPV6_SEGMENTS.iter().any(|(net, prefix)| {
        if *prefix == 128 {
            u128::from(*net) == value
        } else {
            let shift = 128 - *prefix as u32;
            u128::from(*net) >> shift == value >> shift
        }
    })
}

/// 保留/内网段统一判定（主机名解析校验面；回环亦属阻断面——非 localhost
/// 主机名解析到回环即 SSRF，不享字面量回环放行面）。
pub(crate) fn is_reserved(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => ipv4_reserved(v4),
        IpAddr::V6(v6) => ipv6_reserved(v6),
    }
}

/// 本机回环判定（IP 字面量默认放行面）：IPv4 127.0.0.0/8、IPv6 ::1、
/// IPv4 映射回环（::ffff:127.x.x.x）。
pub(crate) fn is_loopback_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.octets()[0] == 127,
        IpAddr::V6(v6) => {
            v6.is_loopback() || v4_mapped_of(v6).is_some_and(|v4| v4.octets()[0] == 127)
        }
    }
}

/// 本机主机名判定（默认放行面，本地测试页场景）：localhost 及其常见变体。
pub(crate) fn is_local_hostname(host: &str) -> bool {
    host == "localhost" || host == "localhost.localdomain" || host == "localhost.local"
}

/// ::ffff:0:0/96 解包（IPv4 映射地址 → 映射目标；非映射返回 None）。
pub(crate) fn v4_mapped_of(ip: &Ipv6Addr) -> Option<Ipv4Addr> {
    let seg = ip.segments();
    if seg[..6] == [0, 0, 0, 0, 0, 0xffff] {
        Some(Ipv4Addr::new(
            (seg[6] >> 8) as u8,
            (seg[6] & 0xff) as u8,
            (seg[7] >> 8) as u8,
            (seg[7] & 0xff) as u8,
        ))
    } else {
        None
    }
}
