//! 网络环境探测测试（multi_device_network.rs 拆分）。

use super::*;
// 网络原语已收敛至 pairing.rs 单一真源；本文件测试直接复用共享实现
use crate::server::pairing::{is_private_ip, is_usable_lan_ip};

/// 网络类别聚合：空集合 → 未知；单类别直判；Fail-Closed（公网优先，min() 聚合）；异常值按公用 fail-closed。
#[test]
fn classify_category_resolves_trust_level() {
    assert_eq!(classify_network_categories(&[]), NetworkKind::Unknown);
    assert_eq!(classify_network_categories(&[0]), NetworkKind::Public);
    assert_eq!(classify_network_categories(&[1]), NetworkKind::Private);
    assert_eq!(classify_network_categories(&[2]), NetworkKind::Domain);
    // Fail-Closed 铁律：公用 + 专用 → 公用（任何公网均视为公用）
    assert_eq!(classify_network_categories(&[0, 1]), NetworkKind::Public);
    assert_eq!(classify_network_categories(&[0, 2]), NetworkKind::Public);
    // 专用 + 域 → 专用（Private 1 优先于 Domain 2）
    assert_eq!(classify_network_categories(&[1, 2]), NetworkKind::Private);
    // 异常值（>2）按公用处理（fail-closed：提示最安全）
    assert_eq!(classify_network_categories(&[9]), NetworkKind::Public);
    assert_eq!(classify_network_categories(&[3, 4]), NetworkKind::Public);
}

/// wire 字符串映射（前端徽标/提示消费）。
#[test]
fn kind_to_profile_maps_all_kinds() {
    assert_eq!(kind_to_profile(NetworkKind::Public), "public");
    assert_eq!(kind_to_profile(NetworkKind::Private), "private");
    assert_eq!(kind_to_profile(NetworkKind::Domain), "domain");
    assert_eq!(kind_to_profile(NetworkKind::Unknown), "unknown");
}

/// 引导文案：公用 → 切换专用 + AP 隔离兜底；专用/域 → AP 隔离兜底；
/// 未知 → 通用兜底（均含「手动输入」关键词）。
#[test]
fn hint_for_covers_guidance_paths() {
    let public = hint_for(NetworkKind::Public);
    assert!(public.contains("切换到专用网络"), "公用网络必须提示切换");
    assert!(public.contains("客户端隔离"), "公用提示必须含 AP 隔离兜底");
    assert!(public.contains("手动输入上方 IP"));

    let private = hint_for(NetworkKind::Private);
    let domain = hint_for(NetworkKind::Domain);
    assert!(
        private.contains("关闭路由器客户端隔离"),
        "专用网络提示 AP 隔离"
    );
    assert!(
        !private.contains("切换到专用网络"),
        "专用网络不重复提示切换"
    );
    assert_eq!(private, domain, "专用与域提示文案一致");

    let unknown = hint_for(NetworkKind::Unknown);
    assert!(unknown.contains("Windows 防火墙"), "未知网络提示检查防火墙");
    assert!(unknown.contains("手动输入上方 IP"));
}

/// 私有网段判定（pairing.rs 共享实现的规则自测，防共享原语回归）。
#[test]
fn private_ip_classification() {
    use std::net::IpAddr;
    for s in [
        "10.0.0.1",
        "172.16.0.1",
        "192.168.1.5",
        "fc00::1",
        "fd12::1",
    ] {
        let ip: IpAddr = s.parse().expect("测试 IP 合法");
        assert!(is_private_ip(&ip), "{s} 应为私有网段");
    }
    for s in ["8.8.8.8", "100.64.0.1", "2001:4860::8888"] {
        let ip: IpAddr = s.parse().expect("测试 IP 合法");
        assert!(!is_private_ip(&ip), "{s} 不应为私有网段");
    }
}

/// 可直连过滤（pairing.rs 共享实现的规则自测，防共享原语回归）。
#[test]
fn usable_lan_ip_filter() {
    use std::net::IpAddr;
    let ok: IpAddr = "192.168.1.5".parse().expect("合法 IP");
    assert!(is_usable_lan_ip(&ok));
    for s in [
        "127.0.0.1",
        "0.0.0.0",
        "169.254.1.1",
        "224.0.0.1",
        "fe80::1",
    ] {
        let ip: IpAddr = s.parse().expect("测试 IP 合法");
        assert!(!is_usable_lan_ip(&ip), "{s} 不应可直连");
    }
}

/// 集成：主入口跨平台可用（Windows 真实注册表环境或 CI 均不 panic；
/// profile 为四态之一；usable_ips 非空——空网络含 "0.0.0.0" 占位）。
#[test]
fn network_env_info_is_well_formed() {
    let info = network_env_info();
    assert!(
        matches!(
            info.profile.as_str(),
            "public" | "private" | "domain" | "unknown"
        ),
        "profile 必须为四态之一：{}",
        info.profile
    );
    assert!(
        !info.usable_ips.is_empty(),
        "IP 列表不应为空（空网络含占位）"
    );
    assert!(!info.hint.is_empty(), "引导文案不应为空");
    // 排序不变量：推荐 IP（默认路由）恒在首位——除非列表为占位
    if info.usable_ips.len() > 1 {
        let first = &info.usable_ips[0];
        assert_ne!(first, "0.0.0.0", "有多个 IP 时首位不得为占位");
    }
}
