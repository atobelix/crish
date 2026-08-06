//! Provider 配置：端点/模型/基础地址/凭据引用与额外配置项的加载、保存与解析。
//!
//! 从 Tauri 壳 `apps/agent-workbench/src-tauri/src/config/` 抽取（04 §3.2 G8）：
//! - 配置 JSON 读写与路径布局来自 `persistence.rs`（provider-config.json + secrets/ 目录）；
//! - 字段规范化（端点别名、env 合并）来自 `resolution.rs` 与 `env_filter.rs`；
//! - 凭据读写委托 `credentials.rs`（DPAPI / Unix 0600 明文 / 内存降级）。
//!
//! 解析优先级（B2.2 "env 覆盖"语义，与壳的 env 兜底顺序相反，注释见 `resolve`）：
//! 环境变量 → 持久化配置 → 内置默认值。
//! 端点缺省恒为 `chat-completions`（00 主方案 §3 D3：未显式指定时不走 Responses）。

use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::credentials::{CredentialError, CredentialPersistence, CredentialStore, SecretString};

/// 默认配置文件名称（对齐壳 `persistence.rs` 的 provider-config.json）。
const DEFAULT_CONFIG_FILE_NAME: &str = "provider-config.json";
/// 无 `api_key_ref` 时的默认凭据文件名。
const DEFAULT_SECRET_FILE_NAME: &str = "default.dpapi";

// ── 环境变量名清单（对齐壳 env_filter.rs，补充端点族；CRISH_* 为推荐前缀）──

const API_KEY_ENV_VARS: &[&str] = &["CRISH_API_KEY", "FLOWBIT_API_KEY", "OPENAI_API_KEY"];
const API_BASE_URL_ENV_VARS: &[&str] = &[
    "CRISH_API_BASE_URL",
    "FLOWBIT_API_BASE_URL",
    "OPENAI_BASE_URL",
];
const MODEL_ENV_VARS: &[&str] = &["CRISH_MODEL", "FLOWBIT_MODEL", "OPENAI_MODEL"];
const ENDPOINT_ENV_VARS: &[&str] = &["CRISH_ENDPOINT", "FLOWBIT_ENDPOINT"];

/// 端点类型（对齐壳 `normalize_provider_endpoint` 的合法值集合）。
///
/// 序列化为 kebab-case：`auto` / `responses` / `chat-completions`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum Endpoint {
    /// 自动选择（当前实现恒退化为 chat-completions，见 02 §五 #1 裁决）。
    Auto,
    /// OpenAI Responses API。
    Responses,
    /// OpenAI 兼容 chat-completions API。
    /// 00 主方案 §3 D3：未显式指定端点时恒为 chat-completions。
    #[default]
    ChatCompletions,
}

impl Endpoint {
    /// 解析端点字符串，兼容壳的别名规范化（`chat`→chat-completions、`response`→responses、
    /// `_`/`/` 归一为 `-`、大小写不敏感）。
    pub fn parse(value: &str) -> Option<Self> {
        match value
            .trim()
            .to_ascii_lowercase()
            .replace(['_', '/'], "-")
            .as_str()
        {
            "auto" => Some(Self::Auto),
            "responses" | "response" => Some(Self::Responses),
            "chat-completions" | "chat" => Some(Self::ChatCompletions),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Responses => "responses",
            Self::ChatCompletions => "chat-completions",
        }
    }
}

impl<'de> Deserialize<'de> for Endpoint {
    /// 反序列化时做与 `parse` 相同的别名归一，非法值报解析错误。
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value)
            .ok_or_else(|| serde::de::Error::custom(format!("无效的端点类型：{value}")))
    }
}

/// Provider 配置（非敏感部分；API key 不入此结构，经 `api_key_ref` 引用凭据存储）。
///
/// serde camelCase，字段缺省时由 `Default` 兜底（旧配置升级不丢字段）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderConfig {
    /// Provider 标识（如 openai-compatible / anthropic）。
    pub provider_id: String,
    /// 端点类型；`None` 表示未显式指定，解析时取默认 chat-completions（00 D3）。
    pub endpoint: Option<Endpoint>,
    /// 服务端基础地址（缺省可由 `CRISH_API_BASE_URL` 等环境变量补齐）。
    pub base_url: Option<String>,
    /// 模型名。
    pub model: Option<String>,
    /// 凭据引用：指向凭据存储 `secrets/` 目录中的条目名；`None` 使用默认条目。
    pub api_key_ref: Option<String>,
    /// 是否流式（默认 true，对齐壳 `DEFAULT_PROVIDER_STREAM`）。
    pub stream: Option<bool>,
    /// 额外配置项（vendor 机制、供应商私有参数等），原样透传。
    pub extra: BTreeMap<String, Value>,
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            // 02 §五 #1：未显式指定 provider 时恒为 openai-compatible 语义。
            provider_id: "openai-compatible".to_string(),
            endpoint: None,
            base_url: None,
            model: None,
            api_key_ref: None,
            stream: None,
            extra: BTreeMap::new(),
        }
    }
}

/// 配置错误类型。
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    /// 文件系统访问失败。
    #[error("配置文件访问失败：{0}")]
    Io(#[from] std::io::Error),
    /// JSON 解析失败（含非法端点值等反序列化错误）。
    #[error("配置文件解析失败：{0}")]
    Parse(#[from] serde_json::Error),
    /// 凭据引用不合法（空/超长/含非法字符）。
    #[error("无效的凭据引用：{0}")]
    InvalidSecretRef(String),
}

/// API key 来源（供上层诊断与 UI 展示）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiKeySource {
    /// 环境变量提供（env 覆盖层，见模块注释）。
    Env,
    /// 凭据存储提供（DPAPI / Unix 0600 明文文件）。
    Stored,
    /// 未设置。
    Unset,
}

impl ApiKeySource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Env => "env",
            Self::Stored => "stored",
            Self::Unset => "unset",
        }
    }
}

/// 解析后的生效配置：持久化值经环境变量覆盖后，再套用内置默认值。
#[derive(Debug)]
pub struct ResolvedProviderConfig {
    pub provider_id: String,
    /// 恒有值：未配置/未覆盖时取 chat-completions（00 D3）。
    pub endpoint: Endpoint,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub stream: bool,
    /// API key（内存中由 `SecretString` 保证 Drop 时清零）。
    pub api_key: Option<SecretString>,
    pub api_key_source: ApiKeySource,
}

/// Provider 配置存储：JSON 配置 + 凭据存储的组合门面。
pub struct ProviderConfigStore {
    config_path: PathBuf,
    secrets_dir: PathBuf,
    credential_store: CredentialStore,
    config: ProviderConfig,
}

impl ProviderConfigStore {
    /// 从配置目录加载：`provider-config.json` 缺失时使用默认配置；
    /// 凭据文件按 `api_key_ref` 落在 `secrets/{ref}.dpapi`（无引用时 `default.dpapi`）。
    pub fn load(config_dir: impl Into<PathBuf>) -> Result<Self, ConfigError> {
        let config_dir = config_dir.into();
        let config_path = config_dir.join(DEFAULT_CONFIG_FILE_NAME);
        let config = read_persisted_config(&config_path)?;
        Ok(Self {
            config_path,
            secrets_dir: config_dir.join("secrets"),
            credential_store: CredentialStore::new(),
            config,
        })
    }

    pub fn config(&self) -> &ProviderConfig {
        &self.config
    }

    pub fn config_mut(&mut self) -> &mut ProviderConfig {
        &mut self.config
    }

    /// 原子写回配置 JSON（先写 tmp 再 rename，对齐壳 persistence.rs 的模式）。
    pub fn save(&self) -> Result<(), ConfigError> {
        write_persisted_config(&self.config_path, &self.config)
    }

    /// 设置 API key；空串表示清除。写失败时凭据存储降级为内存模式
    /// （密钥仍可用），返回类型化错误由调用方决定策略。
    pub fn set_api_key(&mut self, value: String) -> Result<CredentialPersistence, CredentialError> {
        let value = value.trim().to_string();
        let path = self.secret_path_for(&self.config)?;
        if value.is_empty() {
            self.credential_store.clear(&path)?;
            return Ok(CredentialPersistence::Unset);
        }
        self.credential_store.write(&path, &value)
    }

    /// 解析生效配置：env 覆盖 → 持久化值 → 内置默认。
    ///
    /// 注意：壳的 env 合并把环境变量当作最后兜底（存储优先）；本模块按 B2.2
    /// "支持 env 覆盖（CRISH_API_KEY / CRISH_ENDPOINT 模式）"的语义，
    /// 让环境变量优先于持久化值，便于部署环境统一覆盖端点/模型/密钥。
    pub fn resolve(&self) -> Result<ResolvedProviderConfig, CredentialError> {
        let endpoint = first_env_value(ENDPOINT_ENV_VARS)
            .and_then(|value| Endpoint::parse(&value))
            .or(self.config.endpoint)
            .unwrap_or_default();
        let model = first_env_value(MODEL_ENV_VARS).or_else(|| self.config.model.clone());
        let base_url =
            first_env_value(API_BASE_URL_ENV_VARS).or_else(|| self.config.base_url.clone());
        let stream = self.config.stream.unwrap_or(true);

        let (api_key, api_key_source) = match first_env_value(API_KEY_ENV_VARS) {
            Some(value) => (Some(SecretString::new(value)), ApiKeySource::Env),
            None => {
                let path = self.secret_path_for(&self.config)?;
                match self.credential_store.read(&path) {
                    Ok(Some(value)) => (Some(value), ApiKeySource::Stored),
                    Ok(None) => (None, ApiKeySource::Unset),
                    Err(error) => return Err(error),
                }
            }
        };

        Ok(ResolvedProviderConfig {
            provider_id: self.config.provider_id.clone(),
            endpoint,
            base_url,
            model,
            stream,
            api_key,
            api_key_source,
        })
    }

    /// 凭据文件路径：`secrets/{api_key_ref}.dpapi`，无引用时 `secrets/default.dpapi`。
    fn secret_path_for(&self, config: &ProviderConfig) -> Result<PathBuf, CredentialError> {
        let name = match &config.api_key_ref {
            Some(reference) => {
                let reference = sanitize_secret_ref(reference).map_err(|error| match error {
                    ConfigError::InvalidSecretRef(message) => {
                        CredentialError::InvalidEncoding(message)
                    }
                    // 其余变体在 sanitize 中不会产生，防御性兜底。
                    other => CredentialError::InvalidEncoding(other.to_string()),
                })?;
                format!("{reference}.dpapi")
            }
            None => DEFAULT_SECRET_FILE_NAME.to_string(),
        };
        Ok(self.secrets_dir.join(name))
    }
}

/// 读取持久化配置；文件缺失返回默认配置（对齐壳 read_persisted_config）。
fn read_persisted_config(path: &Path) -> Result<ProviderConfig, ConfigError> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(serde_json::from_str(&text)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ProviderConfig::default()),
        Err(error) => Err(ConfigError::Io(error)),
    }
}

/// 原子写配置：tmp 文件 + rename（对齐壳 write_persisted_config）。
fn write_persisted_config(path: &Path, config: &ProviderConfig) -> Result<(), ConfigError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(config)?;
    fs::write(&tmp, format!("{text}\n"))?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// 取首个非空环境变量值（对齐壳 first_env_value：trim 后非空才算命中）。
fn first_env_value(names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| env::var(name).ok().map(|v| v.trim().to_string()))
        .filter(|value| !value.is_empty())
}

/// 校验并规范化凭据引用（对齐壳 sanitize_profile_secret_id：ASCII 字母数字/'-'/'_'，
/// 长度上限 128，防路径穿越）。
fn sanitize_secret_ref(reference: &str) -> Result<String, ConfigError> {
    let reference = reference.trim();
    if reference.is_empty() {
        return Err(ConfigError::InvalidSecretRef("凭据引用为空".to_string()));
    }
    if reference.len() > 128 {
        return Err(ConfigError::InvalidSecretRef(
            "凭据引用过长（超过 128 字符）".to_string(),
        ));
    }
    if !reference
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(ConfigError::InvalidSecretRef(
            "凭据引用只允许 ASCII 字母数字、'-' 与 '_'".to_string(),
        ));
    }
    Ok(reference.to_string())
}

#[cfg(test)]
mod tests {
    // G2 禁令豁免：测试临时目录清理（非产品删除路径，可恢复语义不适用）。
    #![allow(clippy::disallowed_methods)]

    use super::*;
    use std::sync::Mutex;

    /// 串行化环境变量测试，避免并行执行时互相覆盖。
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// 设置一组环境变量后执行闭包，结束后全部清除。
    fn with_env(vars: &[(&str, Option<&str>)], f: impl FnOnce()) {
        let _guard = ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for (name, value) in vars {
            match value {
                Some(value) => env::set_var(name, value),
                None => env::remove_var(name),
            }
        }
        f();
        for (name, _) in vars {
            env::remove_var(name);
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!(
            "agent-provider-config-test-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    /// 测试用存储：加载临时目录 + 强制内存凭据（不依赖平台 DPAPI）。
    fn test_store(dir: &Path) -> ProviderConfigStore {
        ProviderConfigStore {
            config_path: dir.join(DEFAULT_CONFIG_FILE_NAME),
            secrets_dir: dir.join("secrets"),
            credential_store: CredentialStore::memory_only_for_test(),
            config: ProviderConfig::default(),
        }
    }

    // ── 默认值与 00 D3 ──

    #[test]
    fn default_resolves_chat_completions_endpoint() {
        let dir = temp_dir("default-endpoint");
        let store = test_store(&dir);
        let resolved = store.resolve().expect("解析");
        // 00 D3：端点未显式指定时恒为 chat-completions。
        assert_eq!(resolved.endpoint, Endpoint::ChatCompletions);
        assert!(resolved.stream);
        assert_eq!(resolved.provider_id, "openai-compatible");
        assert_eq!(resolved.api_key_source, ApiKeySource::Unset);
        assert!(resolved.api_key.is_none());
    }

    #[test]
    fn explicit_persisted_endpoint_wins_over_default() {
        let dir = temp_dir("explicit-endpoint");
        let mut store = test_store(&dir);
        store.config.endpoint = Some(Endpoint::Responses);
        let resolved = store.resolve().expect("解析");
        assert_eq!(resolved.endpoint, Endpoint::Responses);
    }

    // ── env 覆盖层 ──

    #[test]
    fn env_endpoint_overrides_persisted() {
        let dir = temp_dir("env-endpoint");
        with_env(&[("CRISH_ENDPOINT", Some("responses"))], || {
            let mut store = test_store(&dir);
            store.config.endpoint = Some(Endpoint::ChatCompletions);
            let resolved = store.resolve().expect("解析");
            // env 覆盖优先于持久化值。
            assert_eq!(resolved.endpoint, Endpoint::Responses);
        });
    }

    #[test]
    fn env_endpoint_alias_is_normalized() {
        let dir = temp_dir("env-endpoint-alias");
        with_env(&[("CRISH_ENDPOINT", Some("chat"))], || {
            let store = test_store(&dir);
            let resolved = store.resolve().expect("解析");
            assert_eq!(resolved.endpoint, Endpoint::ChatCompletions);
        });
    }

    #[test]
    fn env_model_overrides_persisted() {
        let dir = temp_dir("env-model");
        with_env(&[("CRISH_MODEL", Some("env-model-name"))], || {
            let mut store = test_store(&dir);
            store.config.model = Some("persisted-model".to_string());
            let resolved = store.resolve().expect("解析");
            assert_eq!(resolved.model.as_deref(), Some("env-model-name"));
        });
    }

    #[test]
    fn env_base_url_fills_when_unset() {
        let dir = temp_dir("env-base-url");
        with_env(
            &[("CRISH_API_BASE_URL", Some("https://env.example/v1"))],
            || {
                let store = test_store(&dir);
                let resolved = store.resolve().expect("解析");
                assert_eq!(resolved.base_url.as_deref(), Some("https://env.example/v1"));
            },
        );
    }

    #[test]
    fn empty_env_value_is_ignored() {
        let dir = temp_dir("env-empty");
        with_env(
            &[("CRISH_ENDPOINT", Some("  ")), ("CRISH_API_KEY", Some(""))],
            || {
                let store = test_store(&dir);
                let resolved = store.resolve().expect("解析");
                // 空白 env 视为未设置，走默认端点。
                assert_eq!(resolved.endpoint, Endpoint::ChatCompletions);
                assert_eq!(resolved.api_key_source, ApiKeySource::Unset);
            },
        );
    }

    // ── API key 解析 ──

    #[test]
    fn env_api_key_overrides_stored() {
        let dir = temp_dir("env-api-key");
        with_env(&[("CRISH_API_KEY", Some("sk-env-key"))], || {
            let mut store = test_store(&dir);
            store
                .set_api_key("sk-stored-key".to_string())
                .expect("写入存储密钥");
            let resolved = store.resolve().expect("解析");
            // env 覆盖优先于存储密钥。
            assert_eq!(resolved.api_key.expect("有密钥").as_str(), "sk-env-key");
            assert_eq!(resolved.api_key_source, ApiKeySource::Env);
        });
    }

    #[test]
    fn stored_api_key_used_when_no_env() {
        let dir = temp_dir("stored-api-key");
        with_env(&[("CRISH_API_KEY", None)], || {
            let mut store = test_store(&dir);
            store
                .set_api_key("sk-stored-key".to_string())
                .expect("写入存储密钥");
            let resolved = store.resolve().expect("解析");
            assert_eq!(resolved.api_key.expect("有密钥").as_str(), "sk-stored-key");
            assert_eq!(resolved.api_key_source, ApiKeySource::Stored);
        });
    }

    #[test]
    fn clearing_api_key_resolves_unset() {
        let dir = temp_dir("clear-api-key");
        with_env(&[("CRISH_API_KEY", None)], || {
            let mut store = test_store(&dir);
            store
                .set_api_key("sk-stored-key".to_string())
                .expect("写入存储密钥");
            store.set_api_key(String::new()).expect("清除存储密钥");
            let resolved = store.resolve().expect("解析");
            assert!(resolved.api_key.is_none());
            assert_eq!(resolved.api_key_source, ApiKeySource::Unset);
        });
    }

    // ── 序列化 ──

    #[test]
    fn serialization_camel_case_and_roundtrip() {
        let config = ProviderConfig {
            provider_id: "anthropic".to_string(),
            endpoint: Some(Endpoint::Responses),
            model: Some("claude-3-5-sonnet".to_string()),
            base_url: Some("https://api.anthropic.com/v1".to_string()),
            api_key_ref: Some("anthropic-main".to_string()),
            stream: Some(false),
            extra: BTreeMap::from([(
                "thinking".to_string(),
                serde_json::json!({ "budgetTokens": 4096 }),
            )]),
        };

        let json = serde_json::to_value(&config).expect("序列化");
        // camelCase 字段名与壳的 provider-config.json 对齐。
        assert_eq!(json["providerId"], "anthropic");
        assert_eq!(json["endpoint"], "responses");
        assert_eq!(json["baseUrl"], "https://api.anthropic.com/v1");
        assert_eq!(json["model"], "claude-3-5-sonnet");
        assert_eq!(json["apiKeyRef"], "anthropic-main");
        assert_eq!(json["stream"], false);
        assert_eq!(json["extra"]["thinking"]["budgetTokens"], 4096);

        let back: ProviderConfig = serde_json::from_value(json).expect("反序列化");
        assert_eq!(back, config);
    }

    #[test]
    fn missing_fields_deserialize_to_defaults() {
        // 旧配置文件（壳遗留）缺省字段应被 Default 兜底。
        let json = serde_json::json!({ "providerId": "openai-compatible" });
        let config: ProviderConfig = serde_json::from_value(json).expect("反序列化");
        assert_eq!(config.endpoint, None);
        assert_eq!(config.model, None);
        assert!(config.extra.is_empty());
    }

    #[test]
    fn endpoint_alias_parsing() {
        assert_eq!(Endpoint::parse("chat"), Some(Endpoint::ChatCompletions));
        assert_eq!(
            Endpoint::parse("chat_completions"),
            Some(Endpoint::ChatCompletions)
        );
        assert_eq!(Endpoint::parse("response"), Some(Endpoint::Responses));
        assert_eq!(Endpoint::parse("RESPONSES"), Some(Endpoint::Responses));
        assert_eq!(Endpoint::parse("auto"), Some(Endpoint::Auto));
        assert_eq!(Endpoint::parse("bogus"), None);
        assert_eq!(Endpoint::parse(""), None);
    }

    #[test]
    fn endpoint_serializes_kebab_case() {
        assert_eq!(
            serde_json::to_string(&Endpoint::ChatCompletions).expect("序列化"),
            "\"chat-completions\""
        );
        assert_eq!(
            serde_json::from_str::<Endpoint>("\"chat\"").expect("反序列化"),
            Endpoint::ChatCompletions
        );
    }

    // ── 文件加载/保存 ──

    #[test]
    fn load_missing_config_file_yields_defaults() {
        let dir = temp_dir("load-missing");
        let store = ProviderConfigStore::load(&dir).expect("加载");
        assert_eq!(store.config(), &ProviderConfig::default());
    }

    #[test]
    fn save_then_reload_preserves_config() {
        let dir = temp_dir("save-reload");
        let mut store = ProviderConfigStore::load(&dir).expect("加载");
        store.config_mut().endpoint = Some(Endpoint::Responses);
        store.config_mut().model = Some("reload-model".to_string());
        store
            .config_mut()
            .extra
            .insert("vendor".to_string(), serde_json::json!("deepseek"));
        store.save().expect("保存");

        let reloaded = ProviderConfigStore::load(&dir).expect("重载");
        assert_eq!(reloaded.config(), store.config());
        assert_eq!(
            reloaded.resolve().expect("解析").endpoint,
            Endpoint::Responses
        );
        assert_eq!(
            reloaded.resolve().expect("解析").model.as_deref(),
            Some("reload-model")
        );
    }

    #[test]
    fn invalid_json_in_config_file_errors() {
        let dir = temp_dir("bad-json");
        fs::write(dir.join(DEFAULT_CONFIG_FILE_NAME), "不是合法 JSON").expect("写入");
        match ProviderConfigStore::load(&dir) {
            Err(ConfigError::Parse(_)) => {}
            Err(other) => panic!("期望解析错误，得到：{other}"),
            Ok(_) => panic!("期望解析错误，但加载成功"),
        }
    }

    #[test]
    fn invalid_endpoint_in_config_file_errors() {
        let dir = temp_dir("bad-endpoint");
        fs::write(
            dir.join(DEFAULT_CONFIG_FILE_NAME),
            r#"{ "endpoint": "bogus" }"#,
        )
        .expect("写入");
        match ProviderConfigStore::load(&dir) {
            Err(ConfigError::Parse(_)) => {}
            Err(other) => panic!("期望解析错误，得到：{other}"),
            Ok(_) => panic!("期望解析错误，但加载成功"),
        }
    }

    #[test]
    fn api_key_ref_with_invalid_chars_errors_on_resolve() {
        let dir = temp_dir("bad-ref");
        let mut store = test_store(&dir);
        store.config.api_key_ref = Some("../escape".to_string());
        match store.resolve() {
            Err(CredentialError::InvalidEncoding(_)) => {}
            other => panic!("期望凭据引用错误，得到：{other:?}"),
        }
    }

    #[test]
    fn api_key_ref_selects_secret_file() {
        let dir = temp_dir("ref-file");
        // 明文文件模式：验证凭据文件确实按引用名落盘。
        let mut store = ProviderConfigStore {
            config_path: dir.join(DEFAULT_CONFIG_FILE_NAME),
            secrets_dir: dir.join("secrets"),
            credential_store: CredentialStore::plaintext_for_test(),
            config: ProviderConfig::default(),
        };
        store.config.api_key_ref = Some("anthropic-main".to_string());
        store
            .set_api_key("sk-ref-key".to_string())
            .expect("写入存储密钥");
        // 凭据文件应落在 secrets/anthropic-main.dpapi，而非默认条目。
        let path = dir.join("secrets").join("anthropic-main.dpapi");
        assert!(path.exists());
        // 默认条目不受影响。
        assert!(!dir.join("secrets").join("default.dpapi").exists());
    }
}
