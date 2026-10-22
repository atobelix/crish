//! 门禁模式条目解析与主机名匹配（§4.2）

use std::net::IpAddr;

/// 门禁模式条目（纯域名层，不匹配路径/query，§4.2）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Pattern {
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
    pub(crate) fn parse(raw: &str) -> Result<Self, String> {
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
    pub(crate) fn matches_host(&self, host: &str) -> bool {
        match self {
            Pattern::Any => true,
            Pattern::Root(d) => host == d || host.ends_with(&format!(".{d}")),
            Pattern::Sub(d) => host.ends_with(&format!(".{d}")),
            Pattern::Ip(_) => false,
        }
    }

    pub(crate) fn matches_ip(&self, ip: &IpAddr) -> bool {
        matches!(self, Pattern::Ip(expected) if expected == ip)
    }
}

/// 主机部分合法性（仅字母/数字/点/连字符；IDN 经 `url` crate 解析面
/// 已转 punycode，配置条目维持 ASCII 面）。
pub(crate) fn validate_host_part(host: &str) -> Result<(), String> {
    if host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        Ok(())
    } else {
        Err(format!("主机含非法字符（配置条目仅 ASCII）：{host}"))
    }
}

/// 主机规范化（小写 + 去尾点，§4.2 匹配前处理）。
pub(crate) fn normalize_host(host: &str) -> Result<String, String> {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        return Err("空主机".to_string());
    }
    Ok(host)
}
