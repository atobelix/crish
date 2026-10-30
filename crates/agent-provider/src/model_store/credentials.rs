//! 凭据面：环境变量 / DPAPI 槽解析、凭据状态、设置与清除，以及旧槽回收。
//! 均为 `ModelsStore` 的固有方法，公开路径仍为 `agent_provider::model_store::*`。

use super::*;
use crate::credentials::CredentialStore;

impl ModelsStore {
    pub fn provider_key(&self, provider_id: &str) -> Result<SecretString, ModelsStoreError> {
        let state = self.lock()?;
        let snapshot = valid_snapshot(&state)?;
        let provider = snapshot
            .tree
            .find_provider(provider_id.trim())
            .filter(|provider| provider.enabled)
            .ok_or_else(|| ModelsStoreError::new("PROVIDER_UNAVAILABLE", "供应商不存在或已停用"))?;
        self.key_for(provider)?
            .ok_or_else(|| ModelsStoreError::new("CREDENTIAL_MISSING", "供应商尚未配置有效凭据"))
    }

    pub(super) fn key_for(
        &self,
        provider: &ProviderSpec,
    ) -> Result<Option<SecretString>, ModelsStoreError> {
        let Some(reference) = provider.api_key_ref.as_deref() else {
            return Ok(None);
        };
        match CredentialRef::parse(reference).map_err(ModelsStoreError::invalid)? {
            CredentialRef::Env(name) => match std::env::var(&name) {
                Ok(value) if !value.trim().is_empty() => Ok(Some(SecretString::new(value))),
                Ok(_) | Err(std::env::VarError::NotPresent) => Ok(None),
                Err(_) => Err(ModelsStoreError::new(
                    "CREDENTIAL_ENCODING",
                    "凭据环境变量不是有效文本",
                )),
            },
            CredentialRef::Dpapi(_) => {
                let path = secret_path(&self.secrets_dir, reference)?;
                CredentialStore::new().read(&path).map_err(|_| {
                    ModelsStoreError::new("CREDENTIAL_READ", "系统凭据读取失败；原配置已保留")
                })
            }
        }
    }

    pub(super) fn states_for(
        &self,
        tree: &UnifiedModelsConfig,
    ) -> BTreeMap<String, CredentialState> {
        tree.providers
            .iter()
            .map(|(id, provider)| {
                let state = match self.key_for(provider) {
                    Ok(key) => CredentialState {
                        has_key: key.is_some(),
                        api_key_last4: key.as_ref().map(|key| last4(key.as_str())),
                        error: None,
                    },
                    Err(error) => CredentialState {
                        has_key: false,
                        api_key_last4: None,
                        error: Some(error.message),
                    },
                };
                (id.clone(), state)
            })
            .collect()
    }

    pub fn credential_state(&self, provider_id: &str) -> Result<CredentialState, ModelsStoreError> {
        let state = self.lock()?;
        let snapshot = valid_snapshot(&state)?;
        self.states_for(&snapshot.tree)
            .remove(provider_id.trim())
            .ok_or_else(|| ModelsStoreError::new("PROVIDER_UNAVAILABLE", "供应商不存在"))
    }

    pub fn set_credential(
        &self,
        provider_id: &str,
        key: SecretString,
        expected_revision: &str,
    ) -> Result<ModelsSnapshot, ModelsStoreError> {
        if key.as_str().trim().is_empty() {
            return Err(ModelsStoreError::invalid("密钥为空；请使用清除凭据操作"));
        }
        self.change_credential(provider_id, Some(key), expected_revision)
    }

    pub fn clear_credential(
        &self,
        provider_id: &str,
        expected_revision: &str,
    ) -> Result<ModelsSnapshot, ModelsStoreError> {
        self.change_credential(provider_id, None, expected_revision)
    }

    fn change_credential(
        &self,
        provider_id: &str,
        key: Option<SecretString>,
        expected: &str,
    ) -> Result<ModelsSnapshot, ModelsStoreError> {
        let mut state = self.lock()?;
        let _process = self.process_lock()?;
        let raw = self.raw_observed(&mut state)?;
        if content_revision(raw.as_deref()) != expected {
            return self.write_conflict(raw.as_deref());
        }
        let mut tree = Self::validate_yaml(raw.as_deref().unwrap_or(EMPTY_MODELS_YAML))?;
        let provider = tree
            .providers
            .get_mut(provider_id.trim())
            .ok_or_else(|| ModelsStoreError::new("PROVIDER_UNAVAILABLE", "供应商不存在"))?;
        let previous = provider.api_key_ref.clone();
        let mut created = Vec::new();
        provider.api_key_ref = match key
            .as_ref()
            .map(|key| import::store_key(&self.secrets_dir, key, &mut created))
            .transpose()
        {
            Ok(reference) => reference,
            Err(error) => {
                import::discard_slots(&created);
                return Err(error);
            }
        };
        if key.is_none()
            && tree
                .active_model
                .as_ref()
                .is_some_and(|reference| reference.provider_id == provider_id.trim())
        {
            tree.active_model = None;
        }
        tree.normalize_for_commit()
            .map_err(ModelsStoreError::invalid)?;
        let content = serde_yaml::to_string(&tree)
            .map_err(|_| ModelsStoreError::invalid("配置无法序列化"))?;
        if let Err(error) = self.write_if_current(&content, expected, &mut state) {
            import::discard_slots(&created);
            return Err(error);
        }
        let result = self.publish(&mut state, tree, content)?;
        if let Some(previous) = previous.filter(|reference| reference.starts_with("dpapi:")) {
            if let Ok(path) = secret_path(&self.secrets_dir, &previous) {
                if let Err(error) = CredentialStore::new().clear(&path) {
                    tracing::warn!(error = %error, "旧凭据槽清理失败，配置已引用新槽");
                }
            }
        }
        Ok(result)
    }

    fn write_conflict<T>(&self, raw: Option<&str>) -> Result<T, ModelsStoreError> {
        Err(ModelsStoreError {
            code: "REVISION_CONFLICT".into(),
            message: "配置已修改；请重新读取".into(),
            current_revision: Some(content_revision(raw)),
        })
    }
}

fn last4(value: &str) -> String {
    let mut chars: Vec<char> = value.chars().rev().take(4).collect();
    chars.reverse();
    chars.into_iter().collect()
}
