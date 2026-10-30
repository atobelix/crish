//! 一次性历史导入：只处理秘密与旧介质，数据转换委派核心唯一迁移函数。
use super::*;
use crate::migration::ConfigMigrationManager;
use crate::models::CredentialRef;
use serde_json::{Map, Value};

pub(super) struct Prepared {
    pub tree: UnifiedModelsConfig,
    pub content: String,
    pub changed: bool,
    pub created_slots: Vec<PathBuf>,
}

pub(super) fn may_contain_secret(content: &str) -> bool {
    fn contains(value: &serde_yaml::Value) -> bool {
        match value {
            serde_yaml::Value::Mapping(map) => map.iter().any(|(name, value)| {
                matches!(name.as_str(), Some("apiKey" | "api_key")) || contains(value)
            }),
            serde_yaml::Value::Sequence(values) => values.iter().any(contains),
            _ => false,
        }
    }
    match serde_yaml::from_str::<serde_yaml::Value>(content) {
        Ok(value) => contains(&value),
        Err(_) => {
            let text = content.replace("apiKeyRef", "");
            text.contains("apiKey") || text.contains("api_key")
        }
    }
}

pub(super) fn prepare(
    content: &str,
    secrets: &Path,
    legacy: Option<&Path>,
) -> Result<Prepared, ModelsStoreError> {
    let mut created_slots = Vec::new();
    let result = prepare_tree(content, secrets, legacy, &mut created_slots);
    match result {
        Ok(tree) => {
            let canonical = serde_yaml::to_string(&tree)
                .map_err(|_| ModelsStoreError::invalid("配置无法序列化"))?;
            Ok(Prepared {
                tree,
                changed: canonical != content,
                content: canonical,
                created_slots,
            })
        }
        Err(error) => {
            discard_slots(&created_slots);
            Err(error)
        }
    }
}

fn prepare_tree(
    content: &str,
    secrets: &Path,
    legacy: Option<&Path>,
    created: &mut Vec<PathBuf>,
) -> Result<UnifiedModelsConfig, ModelsStoreError> {
    // YAML Value 先拒绝重复物理键；不直接经 JSON 解析抹平重复值。
    let yaml: serde_yaml::Value = serde_yaml::from_str(content).map_err(|error| {
        let at = error
            .location()
            .map(|at| format!("（第 {} 行，第 {} 列）", at.line(), at.column()))
            .unwrap_or_default();
        ModelsStoreError::invalid(format!("配置 YAML 语法无效{at}；原文件已保留"))
    })?;
    if yaml.is_null() {
        return Ok(UnifiedModelsConfig::default());
    }
    let mut value =
        serde_json::to_value(yaml).map_err(|_| ModelsStoreError::invalid("配置必须使用文本键"))?;
    let root = value
        .as_object_mut()
        .ok_or_else(|| ModelsStoreError::invalid("配置根节点必须是对象"))?;
    let legacy_shape = !root.contains_key("activeModel");
    let mut assigned: BTreeMap<String, (String, SecretString)> = BTreeMap::new();
    if let Some(providers) = root.get_mut("providers").and_then(Value::as_object_mut) {
        let ids: Vec<String> = providers.keys().cloned().collect();
        for (id, node) in providers {
            let node = node
                .as_object_mut()
                .ok_or_else(|| ModelsStoreError::invalid("供应商配置必须是对象"))?;
            convert_inline(id, node, secrets, created, &mut assigned)?;
            if legacy_shape && !node.contains_key("apiKeyRef") {
                if let Some(root) = legacy {
                    let old_name_valid = !id.is_empty()
                        && id.len() <= 128
                        && id
                            .chars()
                            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_');
                    if old_name_valid {
                        let path = root.join("secrets").join(format!("{id}.dpapi"));
                        let secret = CredentialStore::new().read(&path).map_err(|_| {
                            ModelsStoreError::new(
                                "CREDENTIAL_IMPORT",
                                "旧凭据无法读取；原文件未修改",
                            )
                        })?;
                        if let Some(secret) = secret {
                            if ids
                                .iter()
                                .filter(|other| other.eq_ignore_ascii_case(id))
                                .count()
                                > 1
                            {
                                return Err(ModelsStoreError::new(
                                    "MIGRATION_CONFLICT",
                                    "旧凭据文件存在大小写冲突；请分别保存密钥",
                                ));
                            }
                            node.insert(
                                "apiKeyRef".into(),
                                Value::String(store_key(secrets, &secret, created)?),
                            );
                        }
                    }
                }
            }
        }
    }
    if let Some(models) = root.get_mut("models").and_then(Value::as_array_mut) {
        for model in models {
            let model = model
                .as_object_mut()
                .ok_or_else(|| ModelsStoreError::invalid("旧模型必须是对象"))?;
            if model.contains_key("apiKey") || model.contains_key("api_key") {
                let id = model
                    .get("providerId")
                    .or_else(|| model.get("vendor"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| ModelsStoreError::invalid("旧凭据缺少明确供应商归属"))?
                    .trim()
                    .to_string();
                convert_inline(&id, model, secrets, created, &mut assigned)?;
            }
        }
    }
    if legacy_shape {
        root.insert(
            "activeModel".into(),
            legacy
                .map(read_legacy_active)
                .transpose()?
                .flatten()
                .unwrap_or(Value::Null),
        );
    }
    let migrated = ConfigMigrationManager::migrate_legacy_value(&value)
        .map_err(|error| ModelsStoreError::invalid(error.to_string()))?;
    let mut tree: UnifiedModelsConfig = serde_json::from_value(migrated)
        .map_err(|_| ModelsStoreError::invalid("迁移后的配置结构无效"))?;
    tree.normalize_for_commit()
        .map_err(ModelsStoreError::invalid)?;
    validate_references(&tree)?;
    Ok(tree)
}

fn convert_inline(
    id: &str,
    node: &mut Map<String, Value>,
    secrets: &Path,
    created: &mut Vec<PathBuf>,
    assigned: &mut BTreeMap<String, (String, SecretString)>,
) -> Result<(), ModelsStoreError> {
    let inline = match (node.remove("apiKey"), node.remove("api_key")) {
        (Some(a), Some(b)) if a != b => {
            return Err(ModelsStoreError::invalid("旧密钥的两个拼写存在冲突"))
        }
        (Some(value), _) | (_, Some(value)) => value,
        _ => return Ok(()),
    };
    if node.contains_key("apiKeyRef") {
        return Err(ModelsStoreError::invalid("供应商同时配置旧密钥与凭据引用"));
    }
    if inline.is_null() || inline.as_str() == Some("") {
        return Ok(());
    }
    let text = inline
        .as_str()
        .ok_or_else(|| ModelsStoreError::invalid("旧密钥必须是文本"))?;
    if text.starts_with('$') {
        // 环境引用的旧拼写由核心唯一迁移函数处理，此处不复制解析规则。
        node.insert("apiKey".into(), inline);
        return Ok(());
    }
    let reference = if let Some((reference, previous)) = assigned.get(id) {
        if previous.as_str() != text {
            return Err(ModelsStoreError::invalid(
                "同一旧供应商存在不同密钥，不能合并",
            ));
        }
        reference.clone()
    } else {
        let secret = SecretString::new(text.to_string());
        let reference = store_key(secrets, &secret, created)?;
        assigned.insert(id.into(), (reference.clone(), secret));
        reference
    };
    node.insert("apiKeyRef".into(), Value::String(reference));
    Ok(())
}

pub(super) fn store_key(
    root: &Path,
    secret: &SecretString,
    created: &mut Vec<PathBuf>,
) -> Result<String, ModelsStoreError> {
    let reference = CredentialRef::Dpapi(uuid::Uuid::new_v4()).canonical();
    let path = secret_path(root, &reference)?;
    let mut credentials = CredentialStore::new();
    created.push(path.clone());
    credentials.write(&path, secret.as_str()).map_err(|_| {
        ModelsStoreError::new("CREDENTIAL_WRITE", "系统凭据写入失败；已提交凭据未改变")
    })?;
    let restored = credentials
        .read(&path)
        .map_err(|_| ModelsStoreError::new("CREDENTIAL_VERIFY", "系统凭据写后验证失败"))?;
    if restored.as_ref().map(SecretString::as_str) != Some(secret.as_str()) {
        return Err(ModelsStoreError::new(
            "CREDENTIAL_VERIFY",
            "系统凭据写后验证不一致",
        ));
    }
    Ok(reference)
}

pub(super) fn discard_slots(paths: &[PathBuf]) {
    for path in paths {
        if let Err(error) = CredentialStore::new().clear(path) {
            tracing::warn!(error = %error, "未提交凭据槽清理失败");
        }
    }
}

fn read_legacy_json(path: &Path) -> Result<Option<Value>, ModelsStoreError> {
    match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).map(Some).map_err(|_| {
            ModelsStoreError::new(
                "MIGRATION_REQUIRES_REVIEW",
                "历史配置格式损坏；原文件已保留",
            )
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(ModelsStoreError::io(error)),
    }
}

fn read_legacy_active(root: &Path) -> Result<Option<Value>, ModelsStoreError> {
    let Some(state) = read_legacy_json(&root.join("profile-config.json"))? else {
        return Ok(None);
    };
    let Some(id) = state.get("activeProfileId").and_then(Value::as_str) else {
        return Ok(None);
    };
    let Some(model) = state
        .get("profiles")
        .and_then(|profiles| profiles.get(id))
        .and_then(|profile| profile.get("model"))
        .and_then(Value::as_str)
    else {
        return Ok(None);
    };
    serde_json::to_value(ModelRef::new(id, model))
        .map(Some)
        .map_err(|_| ModelsStoreError::invalid("旧活动选择无法导入"))
}

pub(super) fn missing_source(legacy: Option<&Path>) -> Result<String, ModelsStoreError> {
    let Some(root) = legacy else {
        return Ok(EMPTY_MODELS_YAML.into());
    };
    if let Some(old) = read_legacy_json(&root.join("profile-config.json"))? {
        if let Some(profiles) = old
            .get("profiles")
            .and_then(Value::as_object)
            .filter(|profiles| !profiles.is_empty())
        {
            let mut providers = Map::new();
            for (id, profile) in profiles {
                let fields = profile
                    .as_object()
                    .ok_or_else(|| ModelsStoreError::invalid("旧供应商配置不是对象"))?;
                if fields.keys().any(|field| {
                    !["baseUrl", "model", "endpoint", "stream", "models"].contains(&field.as_str())
                }) {
                    return Err(ModelsStoreError::new(
                        "MIGRATION_REQUIRES_REVIEW",
                        "旧供应商含未识别字段；原文件保留",
                    ));
                }
                let protocol = match profile.get("endpoint").and_then(Value::as_str) {
                    None | Some("chat-completions") => "openai/chat",
                    Some("responses") => "openai/responses",
                    _ => {
                        return Err(ModelsStoreError::new(
                            "MIGRATION_REQUIRES_REVIEW",
                            "旧端点没有明确协议；原文件保留",
                        ))
                    }
                };
                let mut models = Vec::new();
                if let Some(model) = profile
                    .get("model")
                    .and_then(Value::as_str)
                    .filter(|model| !model.trim().is_empty())
                {
                    models.push(model.to_string());
                }
                if let Some(list) = profile.get("models").and_then(Value::as_array) {
                    for model in list {
                        let model = model
                            .as_str()
                            .ok_or_else(|| ModelsStoreError::invalid("旧模型列表必须是文本"))?;
                        if !models.iter().any(|existing| existing == model) {
                            models.push(model.into());
                        }
                    }
                }
                providers.insert(id.clone(), serde_json::json!({
                    "baseUrl": profile.get("baseUrl"), "protocol":protocol,
                    "stream":profile.get("stream").and_then(Value::as_bool).unwrap_or(true),
                    "models":models.into_iter().map(|id| serde_json::json!({"id":id})).collect::<Vec<_>>()
                }));
            }
            return serde_yaml::to_string(&serde_json::json!({"version":2,"providers":providers}))
                .map_err(|_| ModelsStoreError::invalid("旧配置无法序列化"));
        }
    }
    if read_legacy_json(&root.join("provider-config.json"))?
        .as_ref()
        .is_some_and(|value| {
            ["baseUrl", "model"].iter().any(|field| {
                value
                    .get(field)
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.is_empty())
            })
        })
    {
        return Err(ModelsStoreError::new(
            "MIGRATION_IDENTITY_REQUIRED",
            "历史配置没有供应商身份；请明确归属后导入，原文件未修改",
        ));
    }
    Ok(EMPTY_MODELS_YAML.into())
}
