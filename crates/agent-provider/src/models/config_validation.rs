//! 配置归一与语义约束；只处理用户显式声明。

use super::super::{ModelPricingSpec, UnifiedModelsConfig};
use crate::models::CredentialRef;
use crate::request::build::dialect::ReasoningEffort;
use indexmap::IndexMap;
use std::collections::HashSet;

pub(super) fn normalize(config: &mut UnifiedModelsConfig) -> Result<(), String> {
    if config.version != 2 {
        return Err(format!(
            "不支持配置版本 {}，请先执行显式迁移",
            config.version
        ));
    }
    let mut providers = IndexMap::new();
    for (raw_id, mut provider) in std::mem::take(&mut config.providers) {
        let provider_id = raw_id.trim().to_owned();
        if provider_id.is_empty() {
            return Err("供应商标识不能为空".into());
        }
        if providers.contains_key(&provider_id) {
            return Err(format!("供应商标识在去除首尾空白后重复: {provider_id}"));
        }
        if let Some(reference) = &provider.api_key_ref {
            let parsed = CredentialRef::parse(reference)
                .map_err(|error| format!("供应商 {provider_id} 的 apiKeyRef 无效: {error}"))?;
            provider.api_key_ref = Some(parsed.canonical());
        }
        if let Some(base_url) = provider.base_url.as_deref() {
            validate_outbound_url(&provider_id, "baseUrl", base_url, &["https", "http"])?;
        }
        if let Some(proxy_url) = provider.proxy_url.as_deref() {
            validate_outbound_url(
                &provider_id,
                "proxyUrl",
                proxy_url,
                &["https", "http", "socks5", "socks5h"],
            )?;
        }
        let mut model_ids = HashSet::new();
        for model in &mut provider.models {
            model.id = model.id.trim().to_owned();
            if model.id.is_empty() {
                return Err(format!("供应商 {provider_id} 的模型标识不能为空"));
            }
            if !model_ids.insert(model.id.clone()) {
                return Err(format!("供应商 {provider_id} 的模型标识重复: {}", model.id));
            }
            let location = format!("供应商 {provider_id} / 模型 {}", model.id);
            if model.context_window == Some(0) || model.max_output_tokens == Some(0) {
                return Err(format!(
                    "{location} 的窗口和输出上限必须为正整数，未配置请省略字段"
                ));
            }
            if let Some(map) = &model.thinking {
                model.thinking = Some(normalize_thinking(map, &location)?);
            }
            if let Some(ttl) = model.cache_ttl.as_deref() {
                if !matches!(ttl, "5m" | "30m" | "1h" | "24h") {
                    return Err(format!("{location} 的 cacheTtl 不受支持"));
                }
            }
            if let Some(pricing) = &model.pricing {
                validate_pricing(pricing).map_err(|error| format!("{location}: {error}"))?;
            }
        }
        providers.insert(provider_id, provider);
    }
    config.providers = providers;
    if let Some(model_ref) = &config.active_model {
        model_ref.validate()?;
        let normalized = model_ref.normalized();
        config.active_model = config.find_enabled_model(&normalized).map(|_| normalized);
    }
    Ok(())
}

/// 出站地址协议闸：公网必须 https；http 仅允许回环/内网地址（自建服务、
/// 本机代理），防 API Key 明文过网。代理额外允许 socks5/socks5h。
/// 地址不得内嵌 userinfo 凭据。
fn validate_outbound_url(
    provider_id: &str,
    field: &str,
    raw: &str,
    allowed_schemes: &[&str],
) -> Result<(), String> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(format!("供应商 {provider_id} 的 {field} 不能为空"));
    }
    let (scheme, rest) = value
        .split_once("://")
        .map(|(scheme, rest)| (scheme.to_ascii_lowercase(), rest))
        .ok_or_else(|| {
            format!(
                "供应商 {provider_id} 的 {field} 必须以 {} 开头",
                allowed_schemes
                    .iter()
                    .map(|scheme| format!("{scheme}://"))
                    .collect::<Vec<_>>()
                    .join(" / ")
            )
        })?;
    if !allowed_schemes.contains(&scheme.as_str()) {
        return Err(format!(
            "供应商 {provider_id} 的 {field} 协议 {scheme} 不受支持"
        ));
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return Err(format!("供应商 {provider_id} 的 {field} 缺少主机"));
    }
    if authority.contains('@') {
        return Err(format!(
            "供应商 {provider_id} 的 {field} 不得内嵌凭据（userinfo）"
        ));
    }
    let host = if let Some(rest) = authority.strip_prefix('[') {
        rest.split(']').next().unwrap_or("")
    } else {
        authority.split(':').next().unwrap_or("")
    };
    if host.is_empty() {
        return Err(format!("供应商 {provider_id} 的 {field} 缺少主机"));
    }
    let plaintext_http = scheme == "http";
    if plaintext_http && !is_loopback_or_private_host(host) {
        return Err(format!(
            "供应商 {provider_id} 的 {field} 使用 http 且主机不是回环/内网地址；公网通信必须使用 https"
        ));
    }
    Ok(())
}

fn is_loopback_or_private_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        Ok(std::net::IpAddr::V6(ip)) => ip.is_loopback() || (ip.segments()[0] & 0xfe00) == 0xfc00,
        Err(_) => false,
    }
}

fn normalize_thinking(
    map: &IndexMap<String, String>,
    location: &str,
) -> Result<IndexMap<String, String>, String> {
    let mut canonical = IndexMap::new();
    for (raw, wire) in map {
        let effort = ReasoningEffort::from_title_case(raw)
            .ok_or_else(|| format!("{location} 的思考档位不在规范词表中: {raw}"))?;
        let title = effort.to_title_case().to_owned();
        if canonical.contains_key(&title) {
            return Err(format!("{location} 的思考档位归一后重复: {title}"));
        }
        // 仅规范键；wire 值保持逐字相同，不 trim、不改大小写、不猜参数。
        canonical.insert(title, wire.clone());
    }
    Ok(canonical)
}

fn validate_pricing(pricing: &ModelPricingSpec) -> Result<(), String> {
    for (field, rate) in [
        ("input", pricing.input),
        ("output", pricing.output),
        ("cacheRead", pricing.cache_read),
        ("cacheWrite", pricing.cache_write),
        ("perImage", pricing.per_image),
    ] {
        validate_rate(field, rate)?;
    }
    let mut thresholds = HashSet::new();
    for tier in &pricing.tiers {
        if !thresholds.insert(tier.input_tokens_above) {
            return Err(format!(
                "pricing.tiers 的 inputTokensAbove 重复: {}",
                tier.input_tokens_above
            ));
        }
        for (field, rate) in [
            ("tiers.input", tier.input),
            ("tiers.output", tier.output),
            ("tiers.cacheRead", tier.cache_read),
            ("tiers.cacheWrite", tier.cache_write),
        ] {
            validate_rate(field, rate)?;
        }
    }
    Ok(())
}

fn validate_rate(field: &str, rate: Option<f64>) -> Result<(), String> {
    if rate.is_some_and(|value| !value.is_finite() || value < 0.0) {
        return Err(format!("pricing.{field} 必须为有限的非负数"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ProviderSpec;

    fn config_with_base_url(base_url: &str) -> UnifiedModelsConfig {
        let mut config = UnifiedModelsConfig::default();
        config.providers.insert(
            "acme".to_string(),
            ProviderSpec {
                base_url: Some(base_url.to_string()),
                ..Default::default()
            },
        );
        config
    }

    #[test]
    fn https_base_url_is_accepted() {
        let mut config = config_with_base_url("https://api.example.com/v1");
        assert!(normalize(&mut config).is_ok());
    }

    #[test]
    fn loopback_and_private_http_base_urls_are_accepted() {
        for url in [
            "http://127.0.0.1:11434/v1",
            "http://localhost:8000",
            "http://192.168.1.9:8080/v1",
            "http://[::1]:11434",
            "http://10.0.0.5",
        ] {
            let mut config = config_with_base_url(url);
            assert!(normalize(&mut config).is_ok(), "应放行内网地址: {url}");
        }
    }

    #[test]
    fn public_http_base_url_is_rejected() {
        let mut config = config_with_base_url("http://api.example.com/v1");
        let err = normalize(&mut config).expect_err("公网 http 必须拒绝");
        assert!(err.contains("https"), "错误信息应指引 https：{err}");
    }

    #[test]
    fn unsupported_scheme_and_userinfo_are_rejected() {
        let mut config = config_with_base_url("ftp://api.example.com");
        assert!(normalize(&mut config).is_err(), "非 http(s) 协议必须拒绝");

        let mut config = config_with_base_url("https://user:pass@api.example.com/v1");
        let err = normalize(&mut config).expect_err("userinfo 必须拒绝");
        assert!(err.contains("userinfo"), "错误信息应指明内嵌凭据：{err}");
    }

    #[test]
    fn socks5_proxy_is_accepted_but_public_http_proxy_is_rejected() {
        let mut config = UnifiedModelsConfig::default();
        config.providers.insert(
            "acme".to_string(),
            ProviderSpec {
                proxy_url: Some("socks5://127.0.0.1:1080".to_string()),
                ..Default::default()
            },
        );
        assert!(normalize(&mut config).is_ok(), "socks5 本机代理应放行");

        let mut config = UnifiedModelsConfig::default();
        config.providers.insert(
            "acme".to_string(),
            ProviderSpec {
                proxy_url: Some("http://proxy.example.com:8080".to_string()),
                ..Default::default()
            },
        );
        assert!(normalize(&mut config).is_err(), "公网 http 代理必须拒绝");
    }
}
