//! 仅供 ConfigMigrationManager 调用的历史字段转换；不参与运行期能力决议。

use super::MigrationError;
use serde_json::{json, Map, Value};

fn invalid(message: impl Into<String>) -> MigrationError {
    MigrationError::InvalidConfig(message.into())
}

pub(super) fn migrate(old: &Value) -> Result<Value, MigrationError> {
    let mut root = old
        .as_object()
        .cloned()
        .ok_or_else(|| invalid("配置根节点必须是对象"))?;
    rename(&mut root, "schema_version", "version")?;
    if let Some(version) = root.get("version") {
        if !matches!(version.as_u64(), Some(1 | 2)) {
            return Err(invalid("只支持版本 1 或 2 的显式迁移"));
        }
    }
    let flat = root.remove("models");
    let mut providers = match root.remove("providers") {
        None => Map::new(),
        Some(Value::Object(map)) => map,
        Some(_) => return Err(invalid("providers 必须是对象")),
    };
    if let Some(flat) = flat {
        let models = flat
            .as_array()
            .ok_or_else(|| invalid("旧 models 必须是数组"))?;
        for raw_model in models {
            let mut model = raw_model
                .as_object()
                .cloned()
                .ok_or_else(|| invalid("旧 models 条目必须是对象"))?;
            rename(&mut model, "vendor", "providerId")?;
            let provider_id = model
                .remove("providerId")
                .and_then(|value| value.as_str().map(str::to_owned))
                .ok_or_else(|| invalid("扁平模型缺少明确 providerId/vendor，禁止猜供应商"))?;
            if provider_id.trim().is_empty() {
                return Err(invalid("扁平模型的供应商身份不能为空"));
            }
            let provider = providers
                .entry(provider_id)
                .or_insert_with(|| json!({"models": []}))
                .as_object_mut()
                .ok_or_else(|| invalid("供应商条目必须是对象"))?;
            rename(&mut model, "provider_headers", "providerHeaders")?;
            if let Some(headers) = model.remove("providerHeaders") {
                merge_declared(provider, "headers", headers)?;
            }
            for field in ["baseUrl", "apiKey", "apiKeyRef", "proxyUrl"] {
                if let Some(value) = model.remove(field) {
                    merge_declared(provider, field, value)?;
                }
            }
            // 旧代码按厂商猜协议。现在只允许原有明确协议，否则拒绝转换并保原件。
            if !model.contains_key("protocol") && !provider.contains_key("protocol") {
                return Err(invalid("扁平模型缺少显式协议，无法无损推断"));
            }
            provider
                .entry("models")
                .or_insert_with(|| json!([]))
                .as_array_mut()
                .ok_or_else(|| invalid("供应商 models 必须是数组"))?
                .push(Value::Object(model));
        }
    }
    for provider in providers.values_mut() {
        let provider = provider
            .as_object_mut()
            .ok_or_else(|| invalid("供应商条目必须是对象"))?;
        migrate_credentials(provider)?;
        normalize_protocol(provider);
        if let Some(compat) = provider.get_mut("compat") {
            normalize_compat(compat)?;
        }
        if let Some(models) = provider.get_mut("models") {
            for model in models
                .as_array_mut()
                .ok_or_else(|| invalid("供应商 models 必须是数组"))?
            {
                normalize_model(model)?;
            }
        }
    }
    root.insert("version".into(), json!(2));
    root.insert("providers".into(), Value::Object(providers));
    let yaml = serde_yaml::to_string(&root)?;
    let config = crate::models::UnifiedModelsConfig::from_yaml_str(&yaml)
        .map_err(MigrationError::InvalidConfig)?;
    Ok(serde_json::to_value(config)?)
}

fn rename(map: &mut Map<String, Value>, old: &str, canonical: &str) -> Result<(), MigrationError> {
    if let Some(value) = map.remove(old) {
        merge_declared(map, canonical, value)?;
    }
    Ok(())
}

fn merge_declared(
    map: &mut Map<String, Value>,
    field: &str,
    value: Value,
) -> Result<(), MigrationError> {
    if let Some(existing) = map.get(field) {
        if existing != &value {
            return Err(invalid(format!("字段 {field} 存在冲突，不能覆盖原声明")));
        }
    } else {
        map.insert(field.to_owned(), value);
    }
    Ok(())
}

fn migrate_credentials(provider: &mut Map<String, Value>) -> Result<(), MigrationError> {
    let Some(value) = provider.remove("apiKey") else {
        return Ok(());
    };
    if value.is_null() || value.as_str() == Some("") {
        return Ok(());
    }
    let value = value
        .as_str()
        .ok_or_else(|| invalid("旧 apiKey 必须是字符串"))?;
    let name = value
        .strip_prefix("${")
        .and_then(|value| value.strip_suffix('}'))
        .or_else(|| value.strip_prefix('$'));
    let Some(name) = name else {
        return Err(invalid(
            "旧 apiKey 含字面凭据，请先在存储事务中导入系统凭据库；原件未改写",
        ));
    };
    merge_declared(provider, "apiKeyRef", json!(format!("env:{name}")))
}

fn normalize_protocol(map: &mut Map<String, Value>) {
    if map.get("protocol").and_then(Value::as_str) == Some("google/interactions") {
        map.insert("protocol".into(), json!("google/generate-content"));
    }
}

fn normalize_compat(value: &mut Value) -> Result<(), MigrationError> {
    let map = value
        .as_object_mut()
        .ok_or_else(|| invalid("compat 必须是对象"))?;
    rename(map, "thinking_format", "thinkingFormat")?;
    let replacement = match map.get("thinkingFormat").and_then(Value::as_str) {
        Some("google") => Some("gemini"),
        Some("qwen_enable_thinking") => Some("qwen"),
        _ => None,
    };
    if let Some(replacement) = replacement {
        map.insert("thinkingFormat".into(), json!(replacement));
    }
    Ok(())
}

fn normalize_model(value: &mut Value) -> Result<(), MigrationError> {
    let model = value
        .as_object_mut()
        .ok_or_else(|| invalid("模型必须是对象"))?;
    for (old, canonical) in [
        ("model", "id"),
        ("name", "displayName"),
        ("maxTokens", "maxOutputTokens"),
        ("contextLength", "contextWindow"),
        ("context_length", "contextWindow"),
    ] {
        rename(model, old, canonical)?;
    }
    normalize_protocol(model);
    if let Some(compat) = model.get_mut("compat") {
        normalize_compat(compat)?;
    }
    if let Some(pricing) = model.get_mut("pricing") {
        normalize_pricing(pricing)?;
    }
    migrate_capabilities(model)
}

fn normalize_pricing(value: &mut Value) -> Result<(), MigrationError> {
    let pricing = value
        .as_object_mut()
        .ok_or_else(|| invalid("pricing 必须是对象"))?;
    for (old, canonical) in [
        ("inputPerMTok", "input"),
        ("input_per_m_tok", "input"),
        ("outputPerMTok", "output"),
        ("output_per_m_tok", "output"),
        ("cacheReadPerMTok", "cacheRead"),
        ("cache_read_per_m_tok", "cacheRead"),
        ("cacheWritePerMTok", "cacheWrite"),
        ("cache_write_per_m_tok", "cacheWrite"),
        ("perImageCost", "perImage"),
        ("per_image_cost", "perImage"),
        ("billingUnit", "unit"),
    ] {
        rename(pricing, old, canonical)?;
    }
    if let Some(tiers) = pricing.get_mut("tiers") {
        for tier in tiers
            .as_array_mut()
            .ok_or_else(|| invalid("pricing.tiers 必须是数组"))?
        {
            // 阶梯与基础价共享旧价格拼写，但不能补币种或默认单价。
            normalize_pricing(tier)?;
        }
    }
    Ok(())
}

fn migrate_capabilities(model: &mut Map<String, Value>) -> Result<(), MigrationError> {
    let mut capabilities = match model.remove("capabilities") {
        None => Map::new(),
        Some(Value::Object(map)) => map,
        Some(_) => return Err(invalid("旧 capabilities 必须是对象")),
    };
    for field in ["tools", "image", "video", "reasoning"] {
        if let Some(value) = model.remove(field) {
            merge_declared(&mut capabilities, field, value)?;
        }
    }
    if let Some(tools) = capabilities.remove("tools") {
        if !tools.is_boolean() {
            return Err(invalid("capabilities.tools 必须是布尔值"));
        }
        merge_declared(model, "supportsTools", tools)?;
    }
    if let Some(reasoning) = capabilities.remove("reasoning") {
        let enabled = reasoning
            .as_bool()
            .ok_or_else(|| invalid("reasoning 必须是布尔值"))?;
        let declared = model.get("thinking").and_then(Value::as_object);
        if enabled && declared.is_none_or(Map::is_empty) {
            return Err(invalid(
                "旧 reasoning=true 没有逐档 wire 映射，禁止发明思考档位",
            ));
        }
        if !enabled && declared.is_some_and(|map| !map.is_empty()) {
            return Err(invalid("旧 reasoning=false 与 thinking 映射冲突"));
        }
    }
    for modality in ["image", "video"] {
        let Some(value) = capabilities.remove(modality) else {
            continue;
        };
        let enabled = value
            .as_bool()
            .ok_or_else(|| invalid("旧模态能力必须是布尔值"))?;
        if !enabled && !model.contains_key("modalities") {
            continue;
        }
        let modalities = model
            .entry("modalities")
            .or_insert_with(|| json!({"input": [], "output": []}))
            .as_object_mut()
            .ok_or_else(|| invalid("modalities 必须是对象"))?;
        let inputs = modalities
            .entry("input")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or_else(|| invalid("modalities.input 必须是数组"))?;
        let present = inputs.iter().any(|value| value.as_str() == Some(modality));
        if !enabled && present {
            return Err(invalid(format!(
                "旧 {modality}=false 与 modalities.input 冲突"
            )));
        }
        if enabled && !present {
            inputs.push(json!(modality));
        }
    }
    if !capabilities.is_empty() {
        return Err(invalid("存在无法无损迁移的旧 capabilities 字段"));
    }
    Ok(())
}
