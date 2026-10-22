//! 域名门禁校验执行（`DomainGate` 实现，§4.3 全流程）

use std::net::IpAddr;

use url::Url;

use crate::action::gate::{DomainGate, GateDenial};
use crate::gate::formal::FormalDomainGate;
use crate::gate::pattern::normalize_host;
use crate::gate::segments::is_reserved;

impl DomainGate for FormalDomainGate {
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
        // ③ 主机名（§4.2 + §4.3 步骤 3 解析校验 + 步骤 4 重绑定窗口）
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
            self.record_validated(&host);
            return Ok(());
        }
        // 解析失败策略：默认 fail-closed（阻断，裁决），`with_fail_closed_resolve
        // (false)` 可配 fail-open（解析失败放行，解析成功命中内网仍阻断）
        let ips = match self.resolved_to_internal(&host) {
            Ok(ips) => ips,
            Err(e) => {
                if self.fail_closed_resolve {
                    return Err(denial(format!("主机名解析失败（fail-closed 阻断）：{e}")));
                }
                self.record_validated(&host);
                return Ok(());
            }
        };
        let leaked: Vec<String> = ips
            .iter()
            .filter(|ip| is_reserved(ip))
            .map(|ip| ip.to_string())
            .collect();
        if leaked.is_empty() {
            // ④ 校验通过 → 记录 60s 窗口起点；窗口内每动作一次重新解析并校验
            //（本实现每次 check 均重新解析，不缓存校验结果——重绑定在第二次
            //  校验被拦截，R-11）
            self.record_validated(&host);
            return Ok(());
        }
        Err(denial(format!(
            "主机名解析到内网/保留地址（SSRF 面阻断）：{host} → {}",
            leaked.join(", ")
        )))
    }
}
