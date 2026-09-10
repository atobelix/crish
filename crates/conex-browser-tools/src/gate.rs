//! 域名门禁 MVP 实现（17 §4 唯一权威接口的消费面实现）
//!
//! **权威声明（R-7）**：`DomainGate` 结构与匹配语义以维度 17 §4 为唯一权威；
//! 正式实现应在 `conex-browser/src/gate.rs`（M7 接线位，属 conex-browser 文件域，
//! 本 crate 不触碰）。本文件提供 **MVP 最小实现**（17 §4.1/§4.2/§4.3 的子集），
//! 供工具面注入 `ActionExecutor` 与导航检查点，正式实现落地后由引擎侧经
//! `BrowserToolsConfig.gate` 替换：
//! - 默认策略（§4.1）：白名单为空 = 默认全允许（限公共互联网）；非空 = 白名单外 Deny；
//! - 黑名单命中不可豁免（任何模式 Deny，优先于白名单，§4.2）；
//! - 通配符语义（R-7 定死）：`example.com` = 根域 + 任意子域；`*.example.com` =
//!   任意子域（不含根域）；`*`/`**` = 任意；TLD 通配（`example.*`）配置期拒绝；
//! - scheme 门禁（§4.3 步骤 1）：仅 http/https（about:blank/about:newtab 特例）；
//! - IP 字面量保留段阻断（§4.3 步骤 2 + 段表，含 CGNAT 100.64/10 与基准段
//!   198.18/15 低危加固项）；**本机回环（127.0.0.0/8、::1、IPv4 映射回环）
//!   默认放行**（本地测试页场景，§4.3 口径；黑名单命中不豁免）；
//! - **DNS 解析级校验（§4.3 步骤 3，评审 F10 接线）**：默认面（白名单为空，
//!   全允许限公共互联网）对主机名做解析校验——解析到内网/保留段（含回环，
//!   `localhost` 类主机名除外）阻断（SSRF 面）；**解析失败 fail-closed 阻断
//!   （可配 fail-open）**；白名单显式命中 = 显式信任，跳过解析校验；
//! - **未接线面（遗留）**：60s 重绑定窗口重复校验（§4.3 步骤 4）、传输层
//!   `Network.setBlockedURLs`（R-11）由正式实现补齐。

use conex_browser::action::gate::{DomainGate, GateDenial};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs};
use std::sync::Arc;
use url::Url;

/// 主机名解析器抽象（§4.3 步骤 3；测试注入假解析，生产走系统 resolver）。
pub trait HostResolver: Send + Sync {
    /// 解析主机名 → 全部地址（仅解析不连接；失败返回原因）。
    fn resolve(&self, host: &str) -> Result<Vec<IpAddr>, String>;
}

/// 系统 resolver（`ToSocketAddrs`：A/AAAA 解析，不发起连接）。
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemResolver;

impl HostResolver for SystemResolver {
    fn resolve(&self, host: &str) -> Result<Vec<IpAddr>, String> {
        (host, 0)
            .to_socket_addrs()
            .map(|iter| iter.map(|sa| sa.ip()).collect())
            .map_err(|e| e.to_string())
    }
}

/// 门禁模式条目（纯域名层，不匹配路径/query，§4.2）。
#[derive(Debug, Clone, PartialEq, Eq)]
enum Pattern {
    /// `example.com`：根域 + 任意子域
    Root(String),
    /// `*.example.com`：任意子域（不含根域）
    Sub(String),
    /// `*` / `**`：任意域名
    Any,
    /// IP 字面量（白名单/黑名单显式条目，§4.2）
    Ip(IpAddr),
}

impl Pattern {
    /// 解析模式条目；TLD 通配/多星号/非法字符 → Err（配置校验期报错，§4.2）。
    fn parse(raw: &str) -> Result<Self, String> {
        let raw = raw.trim();
        if raw.is_empty() {
            return Err("空模式".to_string());
        }
        if raw == "*" || raw == "**" {
            return Ok(Pattern::Any);
        }
        // IP 字面量优先（127.0.0.1 / ::1 可入白名单/黑名单，§4.2）
        if let Ok(ip) = raw.parse::<IpAddr>() {
            return Ok(Pattern::Ip(ip));
        }
        if raw.contains('*') && !raw.starts_with("*.") {
            return Err(format!("非法通配模式（仅允许 * 或 *. 前缀）：{raw}"));
        }
        if let Some(rest) = raw.strip_prefix("*.") {
            if rest.is_empty() {
                return Err("*. 后缺少域名".to_string());
            }
            validate_host_part(rest)?;
            return Ok(Pattern::Sub(normalize_host(rest)?));
        }
        validate_host_part(raw)?;
        Ok(Pattern::Root(normalize_host(raw)?))
    }

    /// 主机名是否命中（host 已小写规范化，无尾点）。
    fn matches_host(&self, host: &str) -> bool {
        match self {
            Pattern::Any => true,
            Pattern::Root(d) => host == d || host.ends_with(&format!(".{d}")),
            Pattern::Sub(d) => host.ends_with(&format!(".{d}")),
            Pattern::Ip(_) => false,
        }
    }

    fn matches_ip(&self, ip: &IpAddr) -> bool {
        matches!(self, Pattern::Ip(expected) if expected == ip)
    }
}

/// 主机部分合法性（仅字母/数字/点/连字符；非 ASCII 域名 MVP 不做 punycode，拒绝）。
fn validate_host_part(host: &str) -> Result<(), String> {
    if host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        Ok(())
    } else {
        Err(format!(
            "主机含非法字符（MVP 不支持非 ASCII/punycode）：{host}"
        ))
    }
}

/// 主机规范化（小写 + 去尾点，§4.2 匹配前处理）。
fn normalize_host(host: &str) -> Result<String, String> {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        return Err("空主机".to_string());
    }
    Ok(host)
}

/// MVP 域名门禁（17 §4.1 默认策略 + §4.3 字面量级 IP 段表 + 步骤 3 解析校验）。
#[derive(Clone)]
pub struct MvpDomainGate {
    allowlist: Vec<Pattern>,
    blocklist: Vec<Pattern>,
    /// 主机名解析器（默认 [SystemResolver]；测试/正式接线可注入）。
    resolver: Arc<dyn HostResolver>,
    /// 解析失败策略（§4.3 步骤 3；裁决：fail-closed 默认阻断，可配 fail-open）。
    fail_closed_resolve: bool,
}

impl std::fmt::Debug for MvpDomainGate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // resolver 为不透明策略对象，Debug 仅展示配置面
        f.debug_struct("MvpDomainGate")
            .field("allowlist", &self.allowlist)
            .field("blocklist", &self.blocklist)
            .field("fail_closed_resolve", &self.fail_closed_resolve)
            .finish_non_exhaustive()
    }
}

impl MvpDomainGate {
    /// 构造（配置校验期：非法模式 → Err；默认系统 resolver + fail-closed）。
    pub fn new(allowlist: &[String], blocklist: &[String]) -> Result<Self, String> {
        Self::with_resolver(allowlist, blocklist, Arc::new(SystemResolver))
    }

    /// 注入解析器构造（测试注入假解析；生产保持默认系统 resolver）。
    pub fn with_resolver(
        allowlist: &[String],
        blocklist: &[String],
        resolver: Arc<dyn HostResolver>,
    ) -> Result<Self, String> {
        let allowlist = allowlist
            .iter()
            .map(|p| Pattern::parse(p))
            .collect::<Result<Vec<_>, _>>()?;
        let blocklist = blocklist
            .iter()
            .map(|p| Pattern::parse(p))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(MvpDomainGate {
            allowlist,
            blocklist,
            resolver,
            fail_closed_resolve: true,
        })
    }

    /// 解析失败策略开关（默认 fail-closed：解析失败即阻断；false = fail-open）。
    pub fn with_fail_closed_resolve(mut self, fail_closed: bool) -> Self {
        self.fail_closed_resolve = fail_closed;
        self
    }

    /// IP 判定（§4.2/§4.3 步骤 2）：黑名单优先 → **本机回环默认放行**（本地测试页
    /// 场景，§4.3 口径）→ 其余保留段（白名单显式条目可豁免）→ 白名单非空时未命中拒绝。
    fn allow_ip(&self, ip: &IpAddr) -> bool {
        if self.blocklist.iter().any(|p| p.matches_ip(ip)) {
            return false;
        }
        if is_loopback_ip(ip) {
            return true;
        }
        let reserved = match ip {
            IpAddr::V4(v4) => ipv4_reserved(v4),
            IpAddr::V6(v6) => ipv6_reserved(v6),
        };
        if reserved && !self.allowlist.iter().any(|p| p.matches_ip(ip)) {
            return false;
        }
        if self.allowlist.is_empty() {
            return true;
        }
        self.allowlist
            .iter()
            .any(|p| p.matches_ip(ip) || matches!(p, Pattern::Any))
    }

    /// 解析结果是否命中保留/内网段（§4.3 步骤 3 判定核：任一地址命中即阻断，
    /// 含回环——非 localhost 主机名解析到回环即 SSRF）。
    fn resolved_to_internal(&self, host: &str) -> Result<Vec<IpAddr>, String> {
        if is_local_hostname(host) {
            return Ok(Vec::new());
        }
        self.resolver
            .resolve(host)
            .map_err(|e| format!("{host}：{e}"))
    }

    fn allow_host(&self, host: &str) -> bool {
        if self.blocklist.iter().any(|p| p.matches_host(host)) {
            return false;
        }
        if self.allowlist.is_empty() {
            return true;
        }
        self.allowlist.iter().any(|p| p.matches_host(host))
    }
}

impl DomainGate for MvpDomainGate {
    fn check(&self, url: &str) -> Result<(), GateDenial> {
        let denial = |reason: String| GateDenial {
            url: url.to_string(),
            reason,
        };
        // ① scheme 门禁（§4.3 步骤 1；解析失败 fail-closed）
        let parsed = match Url::parse(url) {
            Ok(p) => p,
            Err(e) => return Err(denial(format!("URL 解析失败（fail-closed）：{e}"))),
        };
        match parsed.scheme() {
            "http" | "https" => {}
            "about" => {
                let page = parsed.path();
                if page == "blank" || page == "newtab" {
                    return Ok(());
                }
                return Err(denial(format!("scheme 门禁：about:{page} 不支持")));
            }
            other => {
                return Err(denial(format!("scheme 门禁：仅 http/https，收到 {other}")));
            }
        }
        // ② IP 字面量判定（§4.3 步骤 2：字面量不触发 DNS；本机回环默认放行，
        //    其余保留段命中除非白名单显式条目豁免——本机调试途径，§4.2）
        if let Some(host) = parsed.host() {
            match host {
                url::Host::Ipv4(ip) => {
                    if !self.allow_ip(&IpAddr::V4(ip)) {
                        return Err(denial(format!(
                            "IP 字面量命中保留/内网段或不在允许面：{ip}"
                        )));
                    }
                    return Ok(());
                }
                url::Host::Ipv6(ip) => {
                    if !self.allow_ip(&IpAddr::V6(ip)) {
                        return Err(denial(format!(
                            "IP 字面量命中保留/内网段或不在允许面：{ip}"
                        )));
                    }
                    return Ok(());
                }
                url::Host::Domain(_) => {}
            }
        }
        // ③ 主机名（§4.2 + §4.3 步骤 3 解析校验）
        let Some(host_str) = parsed.host_str() else {
            return Err(denial("URL 无主机（fail-closed）".to_string()));
        };
        let host = match normalize_host(host_str) {
            Ok(h) => h,
            Err(e) => return Err(denial(format!("主机规范化失败（fail-closed）：{e}"))),
        };
        if !self.allow_host(&host) {
            return Err(denial(format!("域名不在允许面：{host}")));
        }
        // 白名单显式命中 = 显式信任（含该域解析面，跳过解析校验）；默认面
        // （白名单为空，全允许限公共互联网）做解析级校验（SSRF，§4.3 步骤 3）
        if !self.allowlist.is_empty() {
            return Ok(());
        }
        // localhost 类主机名默认放行（resolved_to_internal 直接返回空）；
        // 解析失败策略：默认 fail-closed（阻断，裁决），`with_fail_closed_resolve
        // (false)` 可配 fail-open（解析失败放行，解析成功命中内网仍阻断）
        let ips = match self.resolved_to_internal(&host) {
            Ok(ips) => ips,
            Err(e) => {
                if self.fail_closed_resolve {
                    return Err(denial(format!("主机名解析失败（fail-closed 阻断）：{e}")));
                }
                return Ok(());
            }
        };
        let leaked: Vec<String> = ips
            .iter()
            .filter(|ip| is_reserved(ip))
            .map(|ip| ip.to_string())
            .collect();
        if leaked.is_empty() {
            return Ok(());
        }
        Err(denial(format!(
            "主机名解析到内网/保留地址（SSRF 面阻断）：{host} → {}",
            leaked.join(", ")
        )))
    }
}

/// IPv4 保留/内网段表（17 §4.3；含 CGNAT 100.64/10 与基准段 198.18/15 加固项）。
fn ipv4_reserved(ip: &Ipv4Addr) -> bool {
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
fn ipv6_reserved(ip: &Ipv6Addr) -> bool {
    // ::1（回环）、fc00::/7（ULA）、fe80::/10（链路本地）、::ffff:0:0/96（IPv4 映射）
    ip.is_loopback() || ip.is_unicast_link_local() || ip.is_unique_local() || is_v4_mapped(ip)
}

/// 保留/内网段统一判定（主机名解析校验面；回环亦属阻断面——非 localhost
/// 主机名解析到回环即 SSRF，不享字面量回环放行面）。
fn is_reserved(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => ipv4_reserved(v4),
        IpAddr::V6(v6) => ipv6_reserved(v6),
    }
}

/// 本机回环判定（IP 字面量默认放行面）：IPv4 127.0.0.0/8、IPv6 ::1、
/// IPv4 映射回环（::ffff:127.x.x.x）。
fn is_loopback_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.octets()[0] == 127,
        IpAddr::V6(v6) => {
            v6.is_loopback() || v4_mapped_of(v6).is_some_and(|v4| v4.octets()[0] == 127)
        }
    }
}

/// 本机主机名判定（默认放行面，本地测试页场景）：localhost 及其常见变体。
fn is_local_hostname(host: &str) -> bool {
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

#[cfg(test)]
mod tests {
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
        let g =
            gate_with_resolver(&[], &[], Arc::new(FailingResolver)).with_fail_closed_resolve(false);
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
}
