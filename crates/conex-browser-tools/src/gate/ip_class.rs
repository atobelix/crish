//! IP 保留/内网段表与回环/本机主机名判定（17 §4.3，自 gate.rs 平移）。

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// IPv4 保留/内网段表（17 §4.3；含 CGNAT 100.64/10 与基准段 198.18/15 加固项）。
pub(super) fn ipv4_reserved(ip: &Ipv4Addr) -> bool {
    let octets = ip.octets();
    let [a, b, ..] = octets;
    // 0.0.0.0/8、127.0.0.0/8、10.0.0.0/8、169.254.0.0/16（链路本地）
    a == 0 || a == 127 || a == 10 || (a == 169 && b == 254)
    // 172.16.0.0/12
    || (a == 172 && (16..=31).contains(&b))
    // 192.168.0.0/16
    || (a == 192 && b == 168)
    // 100.64.0.0/10（CGNAT）
    || (a == 100 && (64..=127).contains(&b))
    // 198.18.0.0/15（基准测试段）
    || (a == 198 && (18..=19).contains(&b))
}

/// IPv6 保留/内网段表（17 §4.3）。
pub(super) fn ipv6_reserved(ip: &Ipv6Addr) -> bool {
    // ::1（回环）、fc00::/7（ULA）、fe80::/10（链路本地）、::ffff:0:0/96（IPv4 映射）
    ip.is_loopback() || ip.is_unicast_link_local() || ip.is_unique_local() || is_v4_mapped(ip)
}

/// 保留/内网段统一判定（主机名解析校验面；回环亦属阻断面——非 localhost
/// 主机名解析到回环即 SSRF，不享字面量回环放行面）。
pub(super) fn is_reserved(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => ipv4_reserved(v4),
        IpAddr::V6(v6) => ipv6_reserved(v6),
    }
}

/// 本机回环判定（IP 字面量默认放行面）：IPv4 127.0.0.0/8、IPv6 ::1、
/// IPv4 映射回环（::ffff:127.x.x.x）。
pub(super) fn is_loopback_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.octets()[0] == 127,
        IpAddr::V6(v6) => {
            v6.is_loopback() || v4_mapped_of(v6).is_some_and(|v4| v4.octets()[0] == 127)
        }
    }
}

/// 本机主机名判定（默认放行面，本地测试页场景）：localhost 及其常见变体。
pub(super) fn is_local_hostname(host: &str) -> bool {
    host == "localhost" || host == "localhost.localdomain" || host == "localhost.local"
}

/// ::ffff:0:0/96 解包（IPv4 映射地址 → 映射目标；非映射返回 None）。
fn v4_mapped_of(ip: &Ipv6Addr) -> Option<Ipv4Addr> {
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

/// ::ffff:0:0/96 判定（IPv4 映射段；映射目标再查 IPv4 保留表）。
fn is_v4_mapped(ip: &Ipv6Addr) -> bool {
    v4_mapped_of(ip).is_some_and(|v4| ipv4_reserved(&v4))
}
