//! 模型配置的单写者存储。原文修订、配置树、凭据引用和运行快照一起提交。

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use fs2::FileExt;
use notify::Watcher;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::credentials::{CredentialStore, SecretString};
use crate::models::{CredentialRef, ModelRef, ModelSpec, ProviderSpec, UnifiedModelsConfig};

#[path = "model_store_import.rs"]
mod import;
#[cfg(test)]
#[path = "model_store_tests.rs"]
mod tests;

pub const EMPTY_MODELS_YAML: &str = "version: 2\nproviders: {}\nactiveModel: null\n";

#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{message}")]
pub struct ModelsStoreError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_revision: Option<String>,
}

impl ModelsStoreError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            current_revision: None,
        }
    }
    fn io(error: std::io::Error) -> Self {
        Self::new("CONFIG_IO", error.to_string())
    }
    fn invalid(message: impl Into<String>) -> Self {
        Self::new("INVALID_CONFIG", message)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialState {
    pub has_key: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key_last4: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsSnapshot {
    pub path: String,
    pub content: String,
    pub revision: String,
    pub tree: Option<UnifiedModelsConfig>,
    pub credential_states: BTreeMap<String, CredentialState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parse_error: Option<ModelsStoreError>,
    pub template: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notification_error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CommittedModels {
    pub revision: String,
    pub tree: UnifiedModelsConfig,
}

/// 同次请求拥有自己的凭据及完整配置，后续提交不能改变该请求。
#[derive(Debug, Clone)]
pub struct ResolvedModelConfig {
    pub revision: String,
    pub model_ref: ModelRef,
    pub provider: ProviderSpec,
    pub model: ModelSpec,
    pub api_key: Arc<SecretString>,
}

#[derive(Debug, Clone)]
pub struct ResolvedProviderConfig {
    pub revision: String,
    pub provider_id: String,
    pub provider: ProviderSpec,
    pub api_key: Arc<SecretString>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelsChange {
    pub revision: String,
    pub valid: bool,
}

#[derive(Default)]
struct StoreState {
    last: Option<Arc<CommittedModels>>,
    error: Option<ModelsStoreError>,
    observed: Option<ModelsChange>,
}

pub struct ModelsStore {
    path: PathBuf,
    secrets_dir: PathBuf,
    legacy_dir: Option<PathBuf>,
    state: Mutex<StoreState>,
}

impl ModelsStore {
    pub fn new(path: PathBuf, secrets_dir: PathBuf, legacy_dir: Option<PathBuf>) -> Self {
        Self {
            path,
            secrets_dir,
            legacy_dir,
            state: Mutex::new(StoreState::default()),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 取配置状态锁。持锁 panic 后按恢复模式继续（与本仓锁纪律一致）：
    /// 配置内容以磁盘文件为准，内存态由下一次 read/reload 重建，不因一次
    /// panic 让读写面永久 STORE_LOCK。
    fn lock(&self) -> Result<MutexGuard<'_, StoreState>, ModelsStoreError> {
        Ok(self.state.lock().unwrap_or_else(|e| e.into_inner()))
    }

    fn process_lock(&self) -> Result<File, ModelsStoreError> {
        let parent = self
            .path
            .parent()
            .ok_or_else(|| ModelsStoreError::invalid("配置路径缺少父目录"))?;
        fs::create_dir_all(parent).map_err(ModelsStoreError::io)?;
        let lock_path = self.path.with_extension("yaml.lock");
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)
            .map_err(ModelsStoreError::io)?;
        file.lock_exclusive().map_err(ModelsStoreError::io)?;
        Ok(file)
    }

    fn raw(&self) -> Result<Option<String>, ModelsStoreError> {
        match fs::read_to_string(&self.path) {
            Ok(content) => Ok(Some(content)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(ModelsStoreError::io(error)),
        }
    }

    fn raw_observed(&self, state: &mut StoreState) -> Result<Option<String>, ModelsStoreError> {
        match self.raw() {
            Ok(raw) => Ok(raw),
            Err(error) => {
                state.error = Some(error.clone());
                Err(error)
            }
        }
    }

    /// 读与一次性导入共享提交锁；失败保留上一份快照，但有效读取面明确返回错误。
    pub fn read(&self) -> Result<ModelsSnapshot, ModelsStoreError> {
        let mut state = self.lock()?;
        let result = self.read_locked(&mut state);
        if let Err(error) = &result {
            state.error = Some(error.clone());
        }
        result
    }

    fn read_locked(&self, state: &mut StoreState) -> Result<ModelsSnapshot, ModelsStoreError> {
        let _process = self.process_lock()?;
        let original = self.raw_observed(state)?;
        let migrated = self.path.with_extension("yaml.imported").exists();
        let source = match original.as_deref() {
            Some(content) => content.to_string(),
            None if migrated => EMPTY_MODELS_YAML.to_string(),
            None => import::missing_source(self.legacy_dir.as_deref())?,
        };
        let revision = content_revision(original.as_deref());
        let prepared = if migrated {
            Self::validate_yaml(&source).map(|tree| import::Prepared {
                tree,
                content: source.clone(),
                changed: false,
                created_slots: Vec::new(),
            })
        } else {
            import::prepare(&source, &self.secrets_dir, self.legacy_dir.as_deref())
        };
        match prepared {
            Ok(prepared) => {
                let content = if prepared.changed || original.is_none() {
                    if let Err(error) = self.write_if_current(&prepared.content, &revision, state) {
                        import::discard_slots(&prepared.created_slots);
                        return Err(error);
                    }
                    prepared.content
                } else {
                    source
                };
                // 原件已规范化后登记一次性导入完成；后续删除 YAML 不会复活旧文件。
                if !migrated {
                    conex_fs::atomic_write_file(
                        self.path.with_extension("yaml.imported"),
                        b"canonical-models-v2\n",
                    )
                    .map_err(ModelsStoreError::io)?;
                }
                self.publish(state, prepared.tree, content)
            }
            Err(error) => {
                state.error = Some(error.clone());
                state.observed = Some(ModelsChange {
                    revision: revision.clone(),
                    valid: false,
                });
                Ok(ModelsSnapshot {
                    path: self.path.display().to_string(),
                    content: if import::may_contain_secret(&source) {
                        String::new()
                    } else {
                        source
                    },
                    revision,
                    tree: None,
                    credential_states: BTreeMap::new(),
                    parse_error: Some(error),
                    template: EMPTY_MODELS_YAML.into(),
                    notification_error: None,
                })
            }
        }
    }

    pub fn save_yaml(
        &self,
        content: &str,
        expected_revision: &str,
    ) -> Result<ModelsSnapshot, ModelsStoreError> {
        let tree = Self::validate_yaml(content)?;
        self.apply(tree, expected_revision)
    }

    pub fn validate_yaml(content: &str) -> Result<UnifiedModelsConfig, ModelsStoreError> {
        if import::may_contain_secret(content) {
            return Err(ModelsStoreError::invalid(
                "配置只接受 apiKeyRef；请通过凭据输入保存密钥",
            ));
        }
        let tree =
            UnifiedModelsConfig::from_yaml_str(content).map_err(ModelsStoreError::invalid)?;
        validate_references(&tree)?;
        Ok(tree)
    }

    pub fn apply(
        &self,
        mut tree: UnifiedModelsConfig,
        expected_revision: &str,
    ) -> Result<ModelsSnapshot, ModelsStoreError> {
        tree.normalize_for_commit()
            .map_err(ModelsStoreError::invalid)?;
        validate_references(&tree)?;
        let content = serde_yaml::to_string(&tree)
            .map_err(|_| ModelsStoreError::invalid("配置无法序列化"))?;
        let mut state = self.lock()?;
        let _process = self.process_lock()?;
        self.write_if_current(&content, expected_revision, &mut state)?;
        self.publish(&mut state, tree, content)
    }

    fn write_if_current(
        &self,
        content: &str,
        expected: &str,
        state: &mut StoreState,
    ) -> Result<(), ModelsStoreError> {
        let current = content_revision(self.raw_observed(state)?.as_deref());
        if current != expected {
            return Err(ModelsStoreError {
                code: "REVISION_CONFLICT".into(),
                message: "配置已被其它窗口或外部编辑器修改；请读取新版本后重新提交".into(),
                current_revision: Some(current),
            });
        }
        conex_fs::atomic_write_file(&self.path, content.as_bytes()).map_err(ModelsStoreError::io)
    }

    fn publish(
        &self,
        state: &mut StoreState,
        tree: UnifiedModelsConfig,
        content: String,
    ) -> Result<ModelsSnapshot, ModelsStoreError> {
        let revision = content_revision(Some(&content));
        let credential_states = self.states_for(&tree);
        state.last = Some(Arc::new(CommittedModels {
            revision: revision.clone(),
            tree: tree.clone(),
        }));
        state.error = None;
        state.observed = Some(ModelsChange {
            revision: revision.clone(),
            valid: true,
        });
        Ok(ModelsSnapshot {
            path: self.path.display().to_string(),
            content,
            revision,
            tree: Some(tree),
            credential_states,
            parse_error: None,
            template: EMPTY_MODELS_YAML.into(),
            notification_error: None,
        })
    }

    /// 缓存读取不重新读取文件。监听器与写入口负责更新；无效加载阻止新请求。
    pub fn committed(&self) -> Result<Arc<CommittedModels>, ModelsStoreError> {
        let state = self.lock()?;
        if let Some(error) = &state.error {
            return Err(error.clone());
        }
        state
            .last
            .clone()
            .ok_or_else(|| ModelsStoreError::new("NOT_LOADED", "模型配置尚未加载"))
    }

    pub fn observed(&self) -> Result<Option<ModelsChange>, ModelsStoreError> {
        Ok(self.lock()?.observed.clone())
    }

    pub fn resolve_active(&self) -> Result<Option<ResolvedModelConfig>, ModelsStoreError> {
        let state = self.lock()?;
        let snapshot = valid_snapshot(&state)?;
        snapshot
            .tree
            .active_model
            .as_ref()
            .map(|reference| self.resolve_in(&snapshot, reference))
            .transpose()
    }

    pub fn resolve_model(
        &self,
        reference: &ModelRef,
    ) -> Result<ResolvedModelConfig, ModelsStoreError> {
        let state = self.lock()?;
        let snapshot = valid_snapshot(&state)?;
        self.resolve_in(&snapshot, reference)
    }

    pub fn resolve_provider(
        &self,
        provider_id: &str,
    ) -> Result<ResolvedProviderConfig, ModelsStoreError> {
        let state = self.lock()?;
        let snapshot = valid_snapshot(&state)?;
        let provider_id = provider_id.trim();
        let provider = snapshot
            .tree
            .find_provider(provider_id)
            .filter(|provider| provider.enabled)
            .ok_or_else(|| ModelsStoreError::new("PROVIDER_UNAVAILABLE", "供应商不存在或已停用"))?;
        let key = self
            .key_for(provider)?
            .ok_or_else(|| ModelsStoreError::new("CREDENTIAL_MISSING", "供应商尚未配置有效凭据"))?;
        Ok(ResolvedProviderConfig {
            revision: snapshot.revision.clone(),
            provider_id: provider_id.into(),
            provider: provider.clone(),
            api_key: Arc::new(key),
        })
    }

    fn resolve_in(
        &self,
        snapshot: &CommittedModels,
        reference: &ModelRef,
    ) -> Result<ResolvedModelConfig, ModelsStoreError> {
        let reference = reference.normalized();
        let provider = snapshot
            .tree
            .find_provider(&reference.provider_id)
            .filter(|provider| provider.enabled)
            .ok_or_else(|| {
                ModelsStoreError::new("PROVIDER_UNAVAILABLE", "所选供应商不存在或已停用")
            })?;
        let model = provider
            .find_model(&reference.model_id)
            .filter(|model| model.enabled)
            .ok_or_else(|| ModelsStoreError::new("MODEL_UNAVAILABLE", "所选模型不存在或已停用"))?;
        if provider
            .base_url
            .as_deref()
            .is_none_or(|url| url.trim().is_empty())
        {
            return Err(ModelsStoreError::new(
                "BASE_URL_MISSING",
                "供应商尚未配置服务地址",
            ));
        }
        let key = self.key_for(provider)?.ok_or_else(|| {
            ModelsStoreError::new("CREDENTIAL_MISSING", "供应商尚未配置有效凭据引用")
        })?;
        Ok(ResolvedModelConfig {
            revision: snapshot.revision.clone(),
            model_ref: reference,
            provider: provider.clone(),
            model: model.clone(),
            api_key: Arc::new(key),
        })
    }

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

    fn key_for(&self, provider: &ProviderSpec) -> Result<Option<SecretString>, ModelsStoreError> {
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

    fn states_for(&self, tree: &UnifiedModelsConfig) -> BTreeMap<String, CredentialState> {
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

    pub fn watch(
        self: &Arc<Self>,
        on_change: impl Fn(ModelsChange) + Send + Sync + 'static,
    ) -> Result<notify::RecommendedWatcher, ModelsStoreError> {
        let weak = Arc::downgrade(self);
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                let Some(store) = weak.upgrade() else { return };
                let relevant = event
                    .as_ref()
                    .map(|event| {
                        matches!(
                            event.kind,
                            notify::EventKind::Create(_)
                                | notify::EventKind::Modify(_)
                                | notify::EventKind::Remove(_)
                        ) && event.paths.iter().any(|path| path == store.path())
                    })
                    .unwrap_or(true);
                if !relevant {
                    return;
                }
                let previous = store.lock().ok().and_then(|state| state.observed.clone());
                match store.read() {
                    Ok(snapshot) => {
                        let change = ModelsChange {
                            revision: snapshot.revision,
                            valid: snapshot.parse_error.is_none(),
                        };
                        if previous.as_ref() != Some(&change) {
                            on_change(change);
                        }
                    }
                    Err(error) => {
                        tracing::warn!(error = %error, "外部模型配置无法加载");
                        on_change(ModelsChange {
                            revision: String::new(),
                            valid: false,
                        });
                    }
                }
            })
            .map_err(|error| ModelsStoreError::new("CONFIG_WATCH", error.to_string()))?;
        let parent = self
            .path
            .parent()
            .ok_or_else(|| ModelsStoreError::invalid("配置路径缺少父目录"))?;
        watcher
            .watch(parent, notify::RecursiveMode::NonRecursive)
            .map_err(|error| ModelsStoreError::new("CONFIG_WATCH", error.to_string()))?;
        Ok(watcher)
    }
}

fn valid_snapshot(state: &StoreState) -> Result<Arc<CommittedModels>, ModelsStoreError> {
    if let Some(error) = &state.error {
        return Err(error.clone());
    }
    state
        .last
        .clone()
        .ok_or_else(|| ModelsStoreError::new("NOT_LOADED", "模型配置尚未加载"))
}

fn content_revision(content: Option<&str>) -> String {
    content
        .map(|content| format!("{:x}", Sha256::digest(content.as_bytes())))
        .unwrap_or_else(|| "missing".into())
}

fn secret_path(root: &Path, reference: &str) -> Result<PathBuf, ModelsStoreError> {
    let CredentialRef::Dpapi(id) =
        CredentialRef::parse(reference).map_err(ModelsStoreError::invalid)?
    else {
        return Err(ModelsStoreError::invalid("此操作需要系统凭据槽引用"));
    };
    Ok(root.join(format!("{}.dpapi", id.hyphenated())))
}

fn last4(value: &str) -> String {
    let mut chars: Vec<char> = value.chars().rev().take(4).collect();
    chars.reverse();
    chars.into_iter().collect()
}

fn validate_references(tree: &UnifiedModelsConfig) -> Result<(), ModelsStoreError> {
    let mut seen = std::collections::HashSet::new();
    for provider in tree.providers.values() {
        if let Some(reference) = provider
            .api_key_ref
            .as_deref()
            .filter(|reference| reference.starts_with("dpapi:"))
        {
            let path = secret_path(Path::new(""), reference)?;
            if !seen.insert(path) {
                return Err(ModelsStoreError::invalid("不同供应商必须使用独立凭据槽"));
            }
        }
    }
    Ok(())
}
