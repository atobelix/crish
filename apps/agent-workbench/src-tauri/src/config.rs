use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    env, fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use crate::sidecar;

static API_CONFIG_STORE: OnceLock<Mutex<ApiConfigStore>> = OnceLock::new();

const API_KEY_ENV_VARS: &[&str] = &["CRISH_API_KEY", "FLOWBIT_API_KEY", "OPENAI_API_KEY"];
const API_BASE_URL_ENV_VARS: &[&str] = &[
    "CRISH_API_BASE_URL",
    "FLOWBIT_API_BASE_URL",
    "OPENAI_BASE_URL",
];
const MODEL_ENV_VARS: &[&str] = &["CRISH_MODEL", "FLOWBIT_MODEL", "OPENAI_MODEL"];
const CREDENTIAL_MODE_ENV_VARS: &[&str] = &[
    "CRISH_CREDENTIAL_MODE",
    "FLOWBIT_CREDENTIAL_MODE",
    "CRISH_PROVIDER_CREDENTIAL_MODE",
    "FLOWBIT_PROVIDER_CREDENTIAL_MODE",
];
const DEFAULT_CREDENTIAL_MODE: &str = "auto";
const DEFAULT_PROVIDER_ENDPOINT: &str = "auto";
const DEFAULT_PROVIDER_STREAM: bool = true;
const DEFAULT_CONFIG_FILE_NAME: &str = "provider-config.json";
const DEFAULT_SECRET_FILE_NAME: &str = "provider-direct-key.dpapi";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedProviderConfig {
    base_url: Option<String>,
    model: Option<String>,
    credential_mode: Option<String>,
    endpoint: Option<String>,
    stream: Option<bool>,
    direct_key_cleared: bool,
}

#[derive(Debug, Clone)]
struct RuntimeProviderConfig {
    api_key: Option<String>,
    api_key_touched: bool,
    base_url: Option<String>,
    model: Option<String>,
    credential_mode: Option<String>,
    endpoint: Option<String>,
    stream: Option<bool>,
}

#[derive(Debug, Clone)]
struct ProviderConfigDiagnostic {
    code: String,
    message: String,
}

#[derive(Debug, Clone)]
struct ApiConfigStore {
    persisted: PersistedProviderConfig,
    runtime: RuntimeProviderConfig,
    config_path: PathBuf,
    secret_path: PathBuf,
    credential_store: CredentialStore,
    diagnostic: Option<ProviderConfigDiagnostic>,
}

#[derive(Debug, Clone)]
struct CredentialStore {
    mode: CredentialStoreMode,
    memory_key: Option<String>,
    unavailable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CredentialStoreMode {
    Os,
    MemoryOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CredentialPersistence {
    Persisted,
    MemoryOnly,
    Degraded,
    Unset,
}

#[derive(Debug, Clone)]
struct ResolvedSecret {
    value: String,
    source: ApiKeySource,
    persistence: CredentialPersistence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
enum ApiKeySource {
    RuntimeUpdate,
    UserConfig,
    Env,
    Unset,
}

impl ApiKeySource {
    fn renderer_value(self) -> &'static str {
        match self {
            Self::RuntimeUpdate => "frontend",
            Self::UserConfig => "frontend",
            Self::Env => "env",
            Self::Unset => "unset",
        }
    }

    fn daemon_value(self) -> &'static str {
        match self {
            Self::RuntimeUpdate => "runtime-update",
            Self::UserConfig => "user-config",
            Self::Env => "env",
            Self::Unset => "unset",
        }
    }
}

impl CredentialPersistence {
    fn as_str(self) -> &'static str {
        match self {
            Self::Persisted => "persisted",
            Self::MemoryOnly => "memory-only",
            Self::Degraded => "degraded",
            Self::Unset => "unset",
        }
    }
}

impl CredentialStore {
    fn new(secret_path: PathBuf) -> Self {
        match os_secret_store_available(&secret_path) {
            Ok(()) => Self {
                mode: CredentialStoreMode::Os,
                memory_key: None,
                unavailable: false,
            },
            Err(_) => Self {
                mode: CredentialStoreMode::MemoryOnly,
                memory_key: None,
                unavailable: true,
            },
        }
    }

    #[allow(dead_code)]
    fn unavailable_for_test() -> Self {
        Self {
            mode: CredentialStoreMode::MemoryOnly,
            memory_key: None,
            unavailable: true,
        }
    }

    fn read(&self, path: &Path) -> Result<Option<String>, String> {
        match self.mode {
            CredentialStoreMode::Os => read_os_secret(path),
            CredentialStoreMode::MemoryOnly => Ok(self.memory_key.clone()),
        }
    }

    fn write(&mut self, path: &Path, value: &str) -> Result<CredentialPersistence, String> {
        match self.mode {
            CredentialStoreMode::Os => match write_os_secret(path, value) {
                Ok(()) => Ok(CredentialPersistence::Persisted),
                Err(error) => {
                    self.mode = CredentialStoreMode::MemoryOnly;
                    self.unavailable = true;
                    self.memory_key = Some(value.to_string());
                    Err(error)
                }
            },
            CredentialStoreMode::MemoryOnly => {
                self.memory_key = Some(value.to_string());
                if self.unavailable {
                    Ok(CredentialPersistence::Degraded)
                } else {
                    Ok(CredentialPersistence::MemoryOnly)
                }
            }
        }
    }

    fn clear(&mut self, path: &Path) -> Result<CredentialPersistence, String> {
        self.memory_key = None;
        match self.mode {
            CredentialStoreMode::Os => {
                remove_os_secret(path)?;
                Ok(CredentialPersistence::Unset)
            }
            CredentialStoreMode::MemoryOnly => Ok(CredentialPersistence::Unset),
        }
    }

    fn persistence_for_key(&self, source: ApiKeySource) -> CredentialPersistence {
        match source {
            ApiKeySource::RuntimeUpdate => {
                if self.mode == CredentialStoreMode::Os && !self.unavailable {
                    CredentialPersistence::Persisted
                } else if self.unavailable {
                    CredentialPersistence::Degraded
                } else {
                    CredentialPersistence::MemoryOnly
                }
            }
            ApiKeySource::UserConfig => {
                if self.unavailable {
                    CredentialPersistence::Degraded
                } else if self.mode == CredentialStoreMode::Os {
                    CredentialPersistence::Persisted
                } else {
                    CredentialPersistence::MemoryOnly
                }
            }
            ApiKeySource::Env => CredentialPersistence::Unset,
            ApiKeySource::Unset => CredentialPersistence::Unset,
        }
    }
}

impl ApiConfigStore {
    fn load(config_path: PathBuf, secret_path: PathBuf) -> Self {
        let mut diagnostic = None;
        let persisted = match read_persisted_config(&config_path) {
            Ok(config) => config,
            Err(error) => {
                diagnostic = Some(ProviderConfigDiagnostic {
                    code: "PROVIDER_CONFIG_READ_FAILED".to_string(),
                    message: error,
                });
                PersistedProviderConfig::default()
            }
        };
        let credential_store = CredentialStore::new(secret_path.clone());
        let diagnostic = if credential_store.unavailable {
            Some(ProviderConfigDiagnostic {
                code: "PROVIDER_CREDENTIAL_STORE_DEGRADED".to_string(),
                message: "OS credential storage is unavailable; direct API key is memory-only for this process.".to_string(),
            })
        } else {
            diagnostic
        };
        Self {
            persisted,
            runtime: RuntimeProviderConfig {
                api_key: None,
                api_key_touched: false,
                base_url: None,
                model: None,
                credential_mode: None,
                endpoint: None,
                stream: None,
            },
            config_path,
            secret_path,
            credential_store,
            diagnostic,
        }
    }

    #[allow(dead_code)]
    fn load_for_test(
        config_path: PathBuf,
        secret_path: PathBuf,
        credential_store: CredentialStore,
    ) -> Self {
        let mut store = Self::load(config_path, secret_path);
        store.credential_store = credential_store;
        if store.credential_store.unavailable {
            store.diagnostic = Some(ProviderConfigDiagnostic {
                code: "PROVIDER_CREDENTIAL_STORE_DEGRADED".to_string(),
                message: "OS credential storage is unavailable; direct API key is memory-only for this process.".to_string(),
            });
        }
        store
    }

    fn effective_credential_mode(&self) -> String {
        self.runtime
            .credential_mode
            .clone()
            .or_else(|| {
                self.persisted
                    .credential_mode
                    .clone()
                    .and_then(normalize_credential_mode)
            })
            .or_else(|| {
                first_env_value(CREDENTIAL_MODE_ENV_VARS).and_then(normalize_credential_mode)
            })
            .unwrap_or_else(|| DEFAULT_CREDENTIAL_MODE.to_string())
    }

    fn effective_endpoint(&self) -> String {
        self.runtime
            .endpoint
            .clone()
            .or_else(|| {
                self.persisted
                    .endpoint
                    .clone()
                    .and_then(normalize_provider_endpoint)
            })
            .unwrap_or_else(|| DEFAULT_PROVIDER_ENDPOINT.to_string())
    }

    fn effective_stream(&self) -> bool {
        self.runtime
            .stream
            .or(self.persisted.stream)
            .unwrap_or(DEFAULT_PROVIDER_STREAM)
    }

    fn effective_api_key(&self) -> Option<ResolvedSecret> {
        if self.effective_credential_mode() == "account-center" {
            return None;
        }
        if self.runtime.api_key_touched {
            return self.runtime.api_key.clone().map(|value| ResolvedSecret {
                value,
                source: ApiKeySource::RuntimeUpdate,
                persistence: self
                    .credential_store
                    .persistence_for_key(ApiKeySource::RuntimeUpdate),
            });
        }
        if !self.persisted.direct_key_cleared {
            if let Ok(Some(value)) = self.credential_store.read(&self.secret_path) {
                return Some(ResolvedSecret {
                    value,
                    source: ApiKeySource::UserConfig,
                    persistence: self
                        .credential_store
                        .persistence_for_key(ApiKeySource::UserConfig),
                });
            }
        }
        first_env_value(API_KEY_ENV_VARS).map(|value| ResolvedSecret {
            value,
            source: ApiKeySource::Env,
            persistence: CredentialPersistence::Unset,
        })
    }

    fn effective_base_url(&self) -> Option<String> {
        self.runtime
            .base_url
            .clone()
            .or_else(|| self.persisted.base_url.clone())
            .or_else(|| first_env_value(API_BASE_URL_ENV_VARS))
    }

    fn effective_model(&self) -> Option<String> {
        self.runtime
            .model
            .clone()
            .or_else(|| self.persisted.model.clone())
            .or_else(|| first_env_value(MODEL_ENV_VARS))
    }

    fn save_non_secret_config(&mut self) -> Result<(), String> {
        write_persisted_config(&self.config_path, &self.persisted).map_err(|error| {
            self.diagnostic = Some(ProviderConfigDiagnostic {
                code: "PROVIDER_CONFIG_WRITE_FAILED".to_string(),
                message: error.clone(),
            });
            error
        })
    }

    fn set_api_key(&mut self, value: String) -> Result<(), String> {
        let value = normalize_config_value(value);
        self.runtime.api_key_touched = true;
        if value.is_empty() {
            self.runtime.api_key = None;
            self.persisted.direct_key_cleared = true;
            let _ = self.credential_store.clear(&self.secret_path);
            self.save_non_secret_config()?;
            return Ok(());
        }
        match self.credential_store.write(&self.secret_path, &value) {
            Ok(CredentialPersistence::Degraded) => {
                self.diagnostic = Some(ProviderConfigDiagnostic {
                    code: "PROVIDER_CREDENTIAL_STORE_DEGRADED".to_string(),
                    message: "OS credential storage is unavailable; direct API key is memory-only for this process.".to_string(),
                });
            }
            Ok(_) => {
                self.diagnostic = None;
            }
            Err(error) => {
                self.diagnostic = Some(ProviderConfigDiagnostic {
                    code: "PROVIDER_CREDENTIAL_STORE_DEGRADED".to_string(),
                    message: format!("{error}; direct API key is memory-only for this process."),
                });
            }
        }
        self.runtime.api_key = Some(value);
        self.persisted.direct_key_cleared = false;
        self.save_non_secret_config()
    }

    fn set_base_url(&mut self, value: String) -> Result<(), String> {
        let value = non_empty_config_value(value);
        self.runtime.base_url = value.clone();
        self.persisted.base_url = value;
        self.save_non_secret_config()
    }

    fn set_model(&mut self, value: String) -> Result<(), String> {
        let value = non_empty_config_value(value);
        self.runtime.model = value.clone();
        self.persisted.model = value;
        self.save_non_secret_config()
    }

    fn set_credential_mode(&mut self, value: String) -> Result<(), String> {
        let mode = normalize_credential_mode(value).ok_or_else(|| {
            "Invalid credentialMode. Expected direct, account-center, or auto.".to_string()
        })?;
        self.runtime.credential_mode = Some(mode.clone());
        self.persisted.credential_mode = Some(mode);
        self.save_non_secret_config()
    }

    fn set_endpoint(&mut self, value: String) -> Result<(), String> {
        let endpoint = normalize_provider_endpoint(value).ok_or_else(|| {
            "Invalid endpoint. Expected auto, responses, or chat-completions.".to_string()
        })?;
        self.runtime.endpoint = Some(endpoint.clone());
        self.persisted.endpoint = Some(endpoint);
        self.save_non_secret_config()
    }

    fn set_stream(&mut self, value: bool) -> Result<(), String> {
        self.runtime.stream = Some(value);
        self.persisted.stream = Some(value);
        self.save_non_secret_config()
    }

    fn apply_direct_streaming_defaults(
        &mut self,
        endpoint_missing: bool,
        stream_missing: bool,
    ) -> Result<(), String> {
        if endpoint_missing {
            self.runtime.endpoint = Some(DEFAULT_PROVIDER_ENDPOINT.to_string());
            self.persisted.endpoint = Some(DEFAULT_PROVIDER_ENDPOINT.to_string());
        }
        if stream_missing {
            self.runtime.stream = Some(DEFAULT_PROVIDER_STREAM);
            self.persisted.stream = Some(DEFAULT_PROVIDER_STREAM);
        }
        if endpoint_missing || stream_missing {
            self.save_non_secret_config()?;
        }
        Ok(())
    }

    fn snapshot(&self) -> Value {
        let credential_mode = self.effective_credential_mode();
        let secret = self.effective_api_key();
        let persistence = secret
            .as_ref()
            .map(|secret| secret.persistence)
            .unwrap_or(CredentialPersistence::Unset);
        serde_json::json!({
            "apiKey": "",
            "baseUrl": self.effective_base_url().unwrap_or_default(),
            "model": self.effective_model().unwrap_or_default(),
            "hasApiKey": secret.is_some(),
            "apiKeySource": secret.as_ref().map(|secret| secret.source.renderer_value()).unwrap_or("unset"),
            "apiKeyLast4": secret.as_ref().and_then(|secret| last4(&secret.value)),
            "credentialMode": credential_mode,
            "endpoint": self.effective_endpoint(),
            "stream": self.effective_stream(),
            "credentialPersistence": persistence.as_str(),
            "credentialDiagnostic": self.diagnostic.as_ref().map(|diagnostic| {
                serde_json::json!({
                    "code": diagnostic.code,
                    "message": diagnostic.message,
                })
            }),
        })
    }
}

fn normalize_config_value(value: String) -> String {
    value.trim().to_string()
}

fn non_empty_config_value(value: String) -> Option<String> {
    let value = normalize_config_value(value);
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn first_env_value(names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| env::var(name).ok().and_then(non_empty_config_value))
}

pub(crate) fn api_key_env_var_names() -> &'static [&'static str] {
    API_KEY_ENV_VARS
}

pub(crate) fn init_api_config_store() {
    let config_path = default_config_path();
    let secret_path = default_secret_path();
    let _ =
        API_CONFIG_STORE.get_or_init(|| Mutex::new(ApiConfigStore::load(config_path, secret_path)));
}

fn with_store<T>(operation: impl FnOnce(&ApiConfigStore) -> T) -> T {
    let guard = API_CONFIG_STORE
        .get_or_init(|| {
            Mutex::new(ApiConfigStore::load(
                default_config_path(),
                default_secret_path(),
            ))
        })
        .lock()
        .expect("api config store lock");
    operation(&guard)
}

fn with_store_mut<T>(
    operation: impl FnOnce(&mut ApiConfigStore) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = API_CONFIG_STORE
        .get_or_init(|| {
            Mutex::new(ApiConfigStore::load(
                default_config_path(),
                default_secret_path(),
            ))
        })
        .lock()
        .map_err(|error| format!("Failed to lock API config store: {error}"))?;
    operation(&mut guard)
}

fn normalize_credential_mode(value: String) -> Option<String> {
    match value.trim() {
        "direct" => Some("direct".to_string()),
        "account-center" => Some("account-center".to_string()),
        "auto" => Some("auto".to_string()),
        _ => None,
    }
}

fn normalize_provider_endpoint(value: String) -> Option<String> {
    match value
        .trim()
        .to_ascii_lowercase()
        .replace(['_', '/'], "-")
        .as_str()
    {
        "auto" => Some("auto".to_string()),
        "responses" | "response" => Some("responses".to_string()),
        "chat-completions" | "chat" => Some("chat-completions".to_string()),
        _ => None,
    }
}

pub(crate) fn effective_credential_mode() -> String {
    with_store(|store| store.effective_credential_mode())
}

pub(crate) fn effective_api_key() -> Option<String> {
    with_store(|store| store.effective_api_key().map(|secret| secret.value))
}

pub(crate) fn effective_api_base_url() -> Option<String> {
    with_store(|store| store.effective_base_url())
}

pub(crate) fn effective_model() -> Option<String> {
    with_store(|store| store.effective_model())
}

pub(crate) fn effective_provider_endpoint() -> String {
    with_store(|store| store.effective_endpoint())
}

pub(crate) fn effective_provider_stream() -> bool {
    with_store(|store| store.effective_stream())
}

#[allow(dead_code)]
fn api_key_source() -> &'static str {
    with_store(|store| {
        if store.effective_credential_mode() == "account-center" {
            return "unset";
        }
        store
            .effective_api_key()
            .map(|secret| secret.source.renderer_value())
            .unwrap_or("unset")
    })
}

pub(crate) fn daemon_api_key_source() -> &'static str {
    with_store(|store| {
        if store.effective_credential_mode() == "account-center" {
            return "unset";
        }
        store
            .effective_api_key()
            .map(|secret| secret.source.daemon_value())
            .unwrap_or("unset")
    })
}

#[tauri::command]
pub(crate) fn save_api_config(
    api_key: String,
    base_url: String,
    model: String,
) -> Result<Value, String> {
    with_store_mut(|store| {
        store.set_base_url(base_url)?;
        store.set_model(model)?;
        store.set_credential_mode("direct".to_string())?;
        store.set_api_key(api_key)?;
        store.apply_direct_streaming_defaults(true, true)?;
        let mut snapshot = store.snapshot();
        snapshot["ok"] = serde_json::Value::Bool(true);
        Ok(snapshot)
    })
}

#[tauri::command]
pub(crate) fn get_api_config() -> Result<Value, String> {
    Ok(with_store(|store| store.snapshot()))
}

#[tauri::command]
pub(crate) async fn update_daemon_config(
    api_key: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    credential_mode: Option<String>,
    endpoint: Option<String>,
    stream: Option<bool>,
) -> Result<Value, String> {
    let mut cmd = serde_json::json!({
        "type": "update-config",
    });
    let mut has_fields = false;
    let endpoint_missing = endpoint.is_none();
    let stream_missing = stream.is_none();

    with_store_mut(|store| {
        if let Some(key) = api_key {
            store.set_api_key(key)?;
            if let Some(secret) = store.effective_api_key() {
                cmd["apiKey"] = serde_json::Value::String(secret.value);
            } else {
                cmd["apiKey"] = serde_json::Value::String(String::new());
            }
            has_fields = true;
        }
        if let Some(url) = base_url {
            store.set_base_url(url)?;
            cmd["baseUrl"] =
                serde_json::Value::String(store.effective_base_url().unwrap_or_default());
            has_fields = true;
        }
        if let Some(m) = model {
            store.set_model(m)?;
            cmd["model"] = serde_json::Value::String(store.effective_model().unwrap_or_default());
            has_fields = true;
        }
        if let Some(mode) = credential_mode {
            store.set_credential_mode(mode)?;
            let mode = store.effective_credential_mode();
            cmd["credentialMode"] = serde_json::Value::String(mode.clone());
            if mode == "account-center" {
                cmd["apiKey"] = serde_json::Value::String(String::new());
            } else if api_key_env_var_present_in_cmd(&cmd) {
            } else if let Some(secret) = store.effective_api_key() {
                cmd["apiKey"] = serde_json::Value::String(secret.value);
            }
            if mode == "direct" {
                store.apply_direct_streaming_defaults(endpoint_missing, stream_missing)?;
                if endpoint_missing {
                    cmd["endpoint"] = serde_json::Value::String(store.effective_endpoint());
                }
                if stream_missing {
                    cmd["stream"] = serde_json::Value::Bool(store.effective_stream());
                }
            }
            has_fields = true;
        }
        if let Some(value) = endpoint {
            store.set_endpoint(value)?;
            cmd["endpoint"] = serde_json::Value::String(store.effective_endpoint());
            has_fields = true;
        }
        if let Some(value) = stream {
            store.set_stream(value)?;
            cmd["stream"] = serde_json::Value::Bool(store.effective_stream());
            has_fields = true;
        }
        Ok(())
    })?;

    if !has_fields {
        return Ok(with_store(|store| {
            let mut snapshot = store.snapshot();
            snapshot["ok"] = serde_json::Value::Bool(true);
            snapshot["sentToDaemon"] = serde_json::Value::Bool(false);
            snapshot
        }));
    }

    let sent_to_daemon = sidecar::send_current_sidecar_command(cmd, "daemon config update").await?;

    Ok(with_store(|store| {
        let mut snapshot = store.snapshot();
        snapshot["ok"] = serde_json::Value::Bool(true);
        snapshot["sentToDaemon"] = serde_json::Value::Bool(sent_to_daemon);
        snapshot
    }))
}

fn api_key_env_var_present_in_cmd(cmd: &Value) -> bool {
    cmd.get("apiKey").and_then(Value::as_str).is_some()
}

fn default_config_path() -> PathBuf {
    config_dir().join(DEFAULT_CONFIG_FILE_NAME)
}

fn default_secret_path() -> PathBuf {
    config_dir().join(DEFAULT_SECRET_FILE_NAME)
}

fn config_dir() -> PathBuf {
    if let Ok(path) = env::var("CRISH_WORKBENCH_CONFIG_DIR") {
        if let Some(path) = non_empty_config_value(path) {
            return PathBuf::from(path);
        }
    }
    if let Ok(path) = env::var("APPDATA") {
        if let Some(path) = non_empty_config_value(path) {
            return PathBuf::from(path).join("Crish").join("AgentWorkbench");
        }
    }
    env::temp_dir().join("crish-agent-workbench")
}

fn read_persisted_config(path: &Path) -> Result<PersistedProviderConfig, String> {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|error| format!("Invalid provider config file: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(PersistedProviderConfig::default())
        }
        Err(error) => Err(format!("Failed to read provider config: {error}")),
    }
}

fn write_persisted_config(path: &Path, config: &PersistedProviderConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create provider config directory: {error}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(config)
        .map_err(|error| format!("Failed to encode provider config: {error}"))?;
    fs::write(&tmp, format!("{text}\n"))
        .map_err(|error| format!("Failed to write provider config: {error}"))?;
    fs::rename(&tmp, path)
        .map_err(|error| format!("Failed to replace provider config: {error}"))?;
    Ok(())
}

fn last4(value: &str) -> Option<String> {
    let chars: Vec<char> = value.chars().collect();
    if chars.is_empty() {
        None
    } else {
        Some(chars[chars.len().saturating_sub(4)..].iter().collect())
    }
}

#[cfg(windows)]
fn os_secret_store_available(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(not(windows))]
fn os_secret_store_available(_path: &Path) -> Result<(), String> {
    Err("OS credential storage is not implemented for this platform".to_string())
}

#[cfg(windows)]
fn write_os_secret(path: &Path, value: &str) -> Result<(), String> {
    let encrypted = dpapi_protect(value.as_bytes())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create credential directory: {error}"))?;
    }
    fs::write(path, encode_hex(&encrypted))
        .map_err(|error| format!("Failed to write encrypted credential: {error}"))
}

#[cfg(not(windows))]
fn write_os_secret(_path: &Path, _value: &str) -> Result<(), String> {
    Err("OS credential storage is not implemented for this platform".to_string())
}

#[cfg(windows)]
fn read_os_secret(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(text) => {
            let encrypted = decode_hex(text.trim())?;
            let plain = dpapi_unprotect(&encrypted)?;
            String::from_utf8(plain)
                .map(Some)
                .map_err(|error| format!("Encrypted credential is not valid UTF-8: {error}"))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Failed to read encrypted credential: {error}")),
    }
}

#[cfg(not(windows))]
fn read_os_secret(_path: &Path) -> Result<Option<String>, String> {
    Ok(None)
}

fn remove_os_secret(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to clear encrypted credential: {error}")),
    }
}

#[cfg(windows)]
fn dpapi_protect(input: &[u8]) -> Result<Vec<u8>, String> {
    use std::{ffi::c_void, ptr};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB},
    };

    let mut in_blob = CRYPT_INTEGER_BLOB {
        cbData: input.len() as u32,
        pbData: input.as_ptr() as *mut u8,
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &mut in_blob,
            ptr::null(),
            ptr::null(),
            ptr::null_mut::<c_void>(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
    };
    if ok == 0 {
        return Err("Windows DPAPI CryptProtectData failed".to_string());
    }
    let bytes =
        unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec() };
    unsafe {
        LocalFree(out_blob.pbData.cast());
    }
    Ok(bytes)
}

#[cfg(windows)]
fn dpapi_unprotect(input: &[u8]) -> Result<Vec<u8>, String> {
    use std::{ffi::c_void, ptr};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };

    let mut in_blob = CRYPT_INTEGER_BLOB {
        cbData: input.len() as u32,
        pbData: input.as_ptr() as *mut u8,
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &mut in_blob,
            ptr::null_mut(),
            ptr::null(),
            ptr::null_mut::<c_void>(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
    };
    if ok == 0 {
        return Err("Windows DPAPI CryptUnprotectData failed".to_string());
    }
    let bytes =
        unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec() };
    unsafe {
        LocalFree(out_blob.pbData.cast());
    }
    Ok(bytes)
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn decode_hex(input: &str) -> Result<Vec<u8>, String> {
    if input.len() % 2 != 0 {
        return Err("Invalid encrypted credential encoding".to_string());
    }
    input
        .as_bytes()
        .chunks(2)
        .map(|chunk| {
            let high = hex_value(chunk[0])?;
            let low = hex_value(chunk[1])?;
            Ok((high << 4) | low)
        })
        .collect()
}

fn hex_value(byte: u8) -> Result<u8, String> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err("Invalid encrypted credential encoding".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn get_api_config_does_not_return_stored_api_key() {
        let mut store = test_store();
        store
            .set_api_key("sk-test-secret-value".to_string())
            .expect("save key");
        store
            .set_base_url("https://example.test/v1".to_string())
            .expect("save url");
        store
            .set_model("test-model".to_string())
            .expect("save model");
        store
            .set_credential_mode("direct".to_string())
            .expect("save mode");

        let config = store.snapshot();

        assert_eq!(config["apiKey"].as_str(), Some(""));
        assert_eq!(config["hasApiKey"].as_bool(), Some(true));
        assert_eq!(config["apiKeySource"].as_str(), Some("frontend"));
        assert_eq!(config["apiKeyLast4"].as_str(), Some("alue"));
        assert_eq!(config["credentialMode"].as_str(), Some("direct"));
        assert_eq!(config["endpoint"].as_str(), Some("auto"));
        assert_eq!(config["stream"].as_bool(), Some(true));
    }

    #[test]
    fn save_api_config_resets_direct_mode_to_auto_streaming_defaults() {
        let mut store = test_store();
        store
            .set_endpoint("chat-completions".to_string())
            .expect("save legacy endpoint");
        store.set_stream(false).expect("save legacy stream");

        store
            .set_base_url("https://example.test/v1".to_string())
            .expect("save url");
        store
            .set_model("test-model".to_string())
            .expect("save model");
        store
            .set_credential_mode("direct".to_string())
            .expect("save mode");
        store
            .set_api_key("sk-test-secret-value".to_string())
            .expect("save key");
        store
            .apply_direct_streaming_defaults(true, true)
            .expect("apply defaults");

        assert_eq!(store.effective_endpoint(), "auto");
        assert_eq!(store.effective_stream(), true);
    }

    #[test]
    fn direct_mode_keeps_explicit_endpoint_and_stream_overrides() {
        let mut store = test_store();
        store
            .set_credential_mode("direct".to_string())
            .expect("save mode");
        store
            .set_endpoint("chat-completions".to_string())
            .expect("save explicit endpoint");
        store.set_stream(false).expect("save explicit stream");
        store
            .apply_direct_streaming_defaults(false, false)
            .expect("preserve explicit overrides");

        assert_eq!(store.effective_endpoint(), "chat-completions");
        assert_eq!(store.effective_stream(), false);
    }

    #[test]
    fn persisted_non_secret_config_survives_reload() {
        let dir = temp_config_dir();
        let config_path = dir.join("provider-config.json");
        let secret_path = dir.join("provider-direct-key.dpapi");
        let mut store = ApiConfigStore::load_for_test(
            config_path.clone(),
            secret_path.clone(),
            CredentialStore::unavailable_for_test(),
        );
        store
            .set_base_url("https://persisted.example/v1".to_string())
            .expect("save url");
        store
            .set_model("persisted-model".to_string())
            .expect("save model");
        store
            .set_credential_mode("auto".to_string())
            .expect("save mode");
        store
            .set_endpoint("responses".to_string())
            .expect("save endpoint");
        store.set_stream(false).expect("save stream");

        let reloaded = ApiConfigStore::load_for_test(
            config_path,
            secret_path,
            CredentialStore::unavailable_for_test(),
        );

        assert_eq!(
            reloaded.effective_base_url().as_deref(),
            Some("https://persisted.example/v1")
        );
        assert_eq!(
            reloaded.effective_model().as_deref(),
            Some("persisted-model")
        );
        assert_eq!(reloaded.effective_credential_mode(), "auto");
        assert_eq!(reloaded.effective_endpoint(), "responses");
        assert_eq!(reloaded.effective_stream(), false);
    }

    #[test]
    fn clearing_key_blocks_lower_priority_fallback() {
        let mut store = test_store();
        store
            .set_api_key("sk-test-secret-value".to_string())
            .expect("save key");
        store.set_api_key("".to_string()).expect("clear key");

        let config = store.snapshot();

        assert_eq!(store.effective_api_key().is_none(), true);
        assert_eq!(config["hasApiKey"].as_bool(), Some(false));
        assert_eq!(config["apiKeySource"].as_str(), Some("unset"));
        assert_eq!(config["credentialPersistence"].as_str(), Some("unset"));
    }

    #[test]
    fn account_center_mode_blocks_direct_key() {
        let mut store = test_store();
        store
            .set_api_key("sk-test-secret-value".to_string())
            .expect("save key");
        store
            .set_credential_mode("account-center".to_string())
            .expect("save mode");

        assert!(store.effective_api_key().is_none());
        let config = store.snapshot();
        assert_eq!(config["hasApiKey"].as_bool(), Some(false));
        assert_eq!(config["apiKeySource"].as_str(), Some("unset"));
    }

    #[test]
    fn unavailable_keychain_degrades_to_memory_only() {
        let mut store = test_store();
        store
            .set_api_key("sk-memory-only".to_string())
            .expect("save key");

        let config = store.snapshot();

        assert_eq!(config["hasApiKey"].as_bool(), Some(true));
        assert_eq!(config["credentialPersistence"].as_str(), Some("degraded"));
        assert_eq!(
            config["credentialDiagnostic"]["code"].as_str(),
            Some("PROVIDER_CREDENTIAL_STORE_DEGRADED")
        );
    }

    fn test_store() -> ApiConfigStore {
        let dir = temp_config_dir();
        ApiConfigStore::load_for_test(
            dir.join("provider-config.json"),
            dir.join("provider-direct-key.dpapi"),
            CredentialStore::unavailable_for_test(),
        )
    }

    fn temp_config_dir() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = env::temp_dir().join(format!("crish-config-test-{unique}"));
        fs::create_dir_all(&dir).expect("create temp config dir");
        dir
    }
}
