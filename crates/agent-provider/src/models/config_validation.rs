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
