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
use std::net::{IpAddr, ToSocketAddrs};
use std::sync::Arc;
use url::Url;

mod ip_class;
mod pattern;
#[cfg(test)]
mod tests;

use ip_class::{ipv4_reserved, ipv6_reserved, is_local_hostname, is_loopback_ip, is_reserved};
use pattern::{normalize_host, Pattern};

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
