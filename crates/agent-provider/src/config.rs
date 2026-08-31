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
//!
//! 多提供方（00 主方案 §一 I2 / G3）：配置面为 `provider_id → ProviderConfig` 映射，
//! 每方独立端点/模型/基础地址/凭据引用；凭据按 provider 落 `secrets/{provider_id}.dpapi`
//! （T1.3）；env 按 `{P}_API_KEY`/`{P}_BASE_URL`/`{P}_MODEL`/`{P}_ENDPOINT`（P=provider 大写）
//! 扫描，未命中回退既有 `CRISH_*`/`OPENAI_*` 兼容组（T1.4）。无参入口默认指向
//! `openai-compatible`（00 D3，防破坏既有调用方）。

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
/// 默认 provider 标识（00 主方案 §3 D3 / 02 §五 #1）：无参 resolve 与旧单对象兼容键。
/// 键指向配置映射中的默认条目，同时也是无 `api_key_ref` 时的默认凭据文件基准名。
const DEFAULT_PROVIDER_ID: &str = "openai-compatible";

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

/// Provider 配置存储：多提供方 JSON 配置映射 + 凭据存储的组合门面。
///
/// 配置面（T1.2）：`configs: BTreeMap<String, ProviderConfig>`（键 = provider_id），
/// 每方独立端点/模型/基础地址/凭据引用；`load` 兼容旧单对象（自动包装为
/// `{"openai-compatible": {...}}`）。
/// 凭据面（T1.3）：`secret_path_for` 按 provider 路由——无 `api_key_ref` 时落
/// `secrets/{provider_id}.dpapi`，有引用时沿用 `secrets/{ref}.dpapi`；沿用
/// `CredentialStore` 不动（DPAPI / Unix 0600 / 内存降级全保留）。
/// env 面（T1.4）：按 `{P}_KEY` 前缀路由，未命中回退 `CRISH_*`/`OPENAI_*` 兼容组。
pub struct ProviderConfigStore {
    config_path: PathBuf,
    secrets_dir: PathBuf,
    credential_store: CredentialStore,
    configs: BTreeMap<String, ProviderConfig>,
}

impl ProviderConfigStore {
    /// 从配置目录加载：`provider-config.json` 缺失时使用默认映射（仅含默认 provider）；
    /// 旧单对象（顶层含 `providerId` 键）自动包装为 `{"openai-compatible": {...}}`。
    pub fn load(config_dir: impl Into<PathBuf>) -> Result<Self, ConfigError> {
        let config_dir = config_dir.into();
        let config_path = config_dir.join(DEFAULT_CONFIG_FILE_NAME);
        let configs = read_persisted_config(&config_path)?;
        Ok(Self {
            config_path,
            secrets_dir: config_dir.join("secrets"),
            credential_store: CredentialStore::new(),
            configs,
        })
    }

    /// 全量配置映射（只读，供上层枚举多提供方）。
    pub fn configs(&self) -> &BTreeMap<String, ProviderConfig> {
        &self.configs
    }

    /// 指定 provider 的配置；缺失或 key 不在映射中时回退默认 provider 配置
    /// （`load` 保证默认 provider 恒在映射中）。
    pub fn config(&self, provider_id: &str) -> &ProviderConfig {
        self.configs.get(provider_id).unwrap_or_else(|| {
            self.configs
                .get(DEFAULT_PROVIDER_ID)
                .expect("默认 provider 恒存在")
        })
    }

    /// 可变的指定 provider 配置；缺失时以默认配置插入该键（便于首次写入）。
    pub fn config_mut(&mut self, provider_id: &str) -> &mut ProviderConfig {
        self.configs
            .entry(provider_id.to_string())
            .or_insert_with(|| ProviderConfig {
                provider_id: provider_id.to_string(),
                ..ProviderConfig::default()
            })
    }

    /// 默认 provider（`openai-compatible`）的只读配置。
    pub fn config_default(&self) -> &ProviderConfig {
        self.configs
            .get(DEFAULT_PROVIDER_ID)
            .expect("默认 provider 恒存在")
    }

    /// 默认 provider（`openai-compatible`）的可变配置。
    pub fn config_mut_default(&mut self) -> &mut ProviderConfig {
        self.configs
            .entry(DEFAULT_PROVIDER_ID.to_string())
            .or_default()
    }

    /// 原子写回整个配置映射（先写 tmp 再 rename，对齐壳 persistence.rs 的模式）。
    pub fn save(&self) -> Result<(), ConfigError> {
        write_persisted_config(&self.config_path, &self.configs)
    }

    /// 设置指定 provider 的 API key；空串表示清除。写失败时凭据存储降级为内存模式
    /// （密钥仍可用），返回类型化错误由调用方决定策略。
    pub fn set_api_key(
        &mut self,
        provider_id: &str,
        value: String,
    ) -> Result<CredentialPersistence, CredentialError> {
        let value = value.trim().to_string();
        let path = self.secret_path_for(provider_id)?;
        if value.is_empty() {
            self.credential_store.clear(&path)?;
            return Ok(CredentialPersistence::Unset);
        }
        self.credential_store.write(&path, &value)
    }

    /// 解析指定 provider 的生效配置：env 覆盖 → 持久化值 → 内置默认。
    ///
    /// env 按 `{P}_API_KEY`/`{P}_BASE_URL`/`{P}_MODEL`/`{P}_ENDPOINT`（P=provider_id 大写）
    /// 扫描，未命中回退 `CRISH_*`/`OPENAI_*` 兼容组（T1.4）。
    pub fn resolve(&self, provider_id: &str) -> Result<ResolvedProviderConfig, CredentialError> {
        let config = self.config(provider_id);
        let endpoint = provider_env(provider_id, "ENDPOINT", ENDPOINT_ENV_VARS)
            .and_then(|value| Endpoint::parse(&value))
            .or(config.endpoint)
            .unwrap_or_default();
        let model =
            provider_env(provider_id, "MODEL", MODEL_ENV_VARS).or_else(|| config.model.clone());
        let base_url = provider_env(provider_id, "BASE_URL", API_BASE_URL_ENV_VARS)
            .or_else(|| config.base_url.clone());
        let stream = config.stream.unwrap_or(true);

        let (api_key, api_key_source) = match provider_env(provider_id, "API_KEY", API_KEY_ENV_VARS)
        {
            Some(value) => (Some(SecretString::new(value)), ApiKeySource::Env),
            None => {
                let path = self.secret_path_for(provider_id)?;
                match self.credential_store.read(&path) {
                    Ok(Some(value)) => (Some(value), ApiKeySource::Stored),
                    Ok(None) => (None, ApiKeySource::Unset),
                    Err(error) => return Err(error),
                }
            }
        };

        Ok(ResolvedProviderConfig {
            provider_id: provider_id.to_string(),
            endpoint,
            base_url,
            model,
            stream,
            api_key,
            api_key_source,
        })
    }

    /// 无参入口：解析默认 provider（`openai-compatible`），00 D3 防破坏既有调用方。
    pub fn resolve_default(&self) -> Result<ResolvedProviderConfig, CredentialError> {
        self.resolve(DEFAULT_PROVIDER_ID)
    }

    /// 凭据文件路径：`secrets/{api_key_ref}.dpapi`；无引用时 `secrets/{provider_id}.dpapi`。
    /// 两段文件名均经 `sanitize_secret_ref` 消毒，防路径穿越。
    fn secret_path_for(&self, provider_id: &str) -> Result<PathBuf, CredentialError> {
        let reference_opt = self.config(provider_id).api_key_ref.clone();
        let name = match reference_opt {
            Some(reference) => SafeSecretName::from_ref(&reference)?,
            None => SafeSecretName::from_provider(provider_id)?,
        };
        Ok(self.secrets_dir.join(format!("{name}.dpapi")))
    }
}

/// 凭据文件名消毒包装：无引用时用 provider_id，有引用时沿用 api_key_ref，两者都做路径穿越防护。
struct SafeSecretName(String);

impl SafeSecretName {
    fn from_ref(reference: &str) -> Result<Self, CredentialError> {
        let reference = sanitize_secret_ref(reference).map_err(to_credential_error)?;
        Ok(Self(reference))
    }

    fn from_provider(provider_id: &str) -> Result<Self, CredentialError> {
        let provider_id = sanitize_secret_ref(provider_id).map_err(to_credential_error)?;
        Ok(Self(provider_id))
    }
}

impl std::fmt::Display for SafeSecretName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// 把配置侧消毒错误映射为凭据侧错误（沿用既有映射路径）。
fn to_credential_error(error: ConfigError) -> CredentialError {
    match error {
        ConfigError::InvalidSecretRef(message) => CredentialError::InvalidEncoding(message),
        // 其余变体在 sanitize 中不会产生，防御性兜底。
        other => CredentialError::InvalidEncoding(other.to_string()),
    }
}

/// 读取持久化配置映射；文件缺失返回默认映射（仅含默认 provider）。
fn read_persisted_config(path: &Path) -> Result<BTreeMap<String, ProviderConfig>, ConfigError> {
    match fs::read_to_string(path) {
        Ok(text) => parse_config_document(&text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(default_provider_map()),
        Err(error) => Err(ConfigError::Io(error)),
    }
}

/// 解析配置文档为「provider_id → ProviderConfig」映射。
///
/// 兼容规则：顶层对象若含 `providerId` 键视为**旧单对象**（T1.2），整体解析为单
/// `ProviderConfig` 并以默认键 `openai-compatible` 包装；否则视为多提供方映射逐键解析。
fn parse_config_document(text: &str) -> Result<BTreeMap<String, ProviderConfig>, ConfigError> {
    let value = serde_json::from_str::<serde_json::Value>(text)?;
    let mut map = match value {
        serde_json::Value::Object(object) => {
            if object.contains_key("providerId") {
                // 旧单对象：包装为默认 provider。
                let legacy =
                    serde_json::from_value::<ProviderConfig>(serde_json::Value::Object(object))?;
                BTreeMap::from([(DEFAULT_PROVIDER_ID.to_string(), legacy)])
            } else {
                serde_json::from_value::<BTreeMap<String, ProviderConfig>>(
                    serde_json::Value::Object(object),
                )?
            }
        }
        other => {
            // 顶层非对象（字符串/数字/数组等）：强转映射必然失败，产生类型化 Parse 错误。
            return serde_json::from_value::<BTreeMap<String, ProviderConfig>>(other)
                .map_err(ConfigError::Parse);
        }
    };
    // 归一：解析出的映射恒包含默认 provider，保证 `config`/无参 resolve 可用。
    map.entry(DEFAULT_PROVIDER_ID.to_string())
        .or_insert_with(ProviderConfig::default);
    Ok(map)
}

/// 默认配置映射：仅含默认 provider（`openai-compatible`）。
fn default_provider_map() -> BTreeMap<String, ProviderConfig> {
    BTreeMap::from([(DEFAULT_PROVIDER_ID.to_string(), ProviderConfig::default())])
}

/// 原子写配置：tmp 文件 + rename（对齐壳 write_persisted_config），序列化整个映射。
fn write_persisted_config(
    path: &Path,
    configs: &BTreeMap<String, ProviderConfig>,
) -> Result<(), ConfigError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(configs)?;
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

/// 按 provider 维度取 env 值（T1.4）：先扫 `{P}_{field}`（P=provider_id 大写），
/// 未命中回退 `compat_vars` 兼容组。空值视为未设置，与 `first_env_value` 语义一致。
fn provider_env(provider_id: &str, field: &str, compat_vars: &[&str]) -> Option<String> {
    let prefixed = format!("{}_{field}", provider_id.to_ascii_uppercase());
    let value = env::var(&prefixed).ok().map(|v| v.trim().to_string());
    match value.filter(|v| !v.is_empty()) {
        Some(value) => Some(value),
        None => first_env_value(compat_vars),
    }
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
            configs: default_provider_map(),
        }
    }

    // ── 默认值与 00 D3 ──

    #[test]
    fn default_resolves_chat_completions_endpoint() {
        let dir = temp_dir("default-endpoint");
        with_env(&[], || {
            let store = test_store(&dir);
            let resolved = store.resolve_default().expect("解析");
            // 00 D3：端点未显式指定时恒为 chat-completions。
            assert_eq!(resolved.endpoint, Endpoint::ChatCompletions);
            assert!(resolved.stream);
            assert_eq!(resolved.provider_id, "openai-compatible");
            assert_eq!(resolved.api_key_source, ApiKeySource::Unset);
            assert!(resolved.api_key.is_none());
        });
    }

    #[test]
    fn explicit_persisted_endpoint_wins_over_default() {
        let dir = temp_dir("explicit-endpoint");
        with_env(&[], || {
            let mut store = test_store(&dir);
            store.config_mut(DEFAULT_PROVIDER_ID).endpoint = Some(Endpoint::Responses);
            let resolved = store.resolve_default().expect("解析");
            assert_eq!(resolved.endpoint, Endpoint::Responses);
        });
    }

    // ── env 覆盖层 ──

    #[test]
    fn env_endpoint_overrides_persisted() {
        let dir = temp_dir("env-endpoint");
        with_env(&[("CRISH_ENDPOINT", Some("responses"))], || {
            let mut store = test_store(&dir);
            store.config_mut(DEFAULT_PROVIDER_ID).endpoint = Some(Endpoint::ChatCompletions);
            let resolved = store.resolve_default().expect("解析");
            // env 覆盖优先于持久化值。
            assert_eq!(resolved.endpoint, Endpoint::Responses);
        });
    }

    #[test]
    fn env_endpoint_alias_is_normalized() {
        let dir = temp_dir("env-endpoint-alias");
        with_env(&[("CRISH_ENDPOINT", Some("chat"))], || {
            let store = test_store(&dir);
            let resolved = store.resolve_default().expect("解析");
            assert_eq!(resolved.endpoint, Endpoint::ChatCompletions);
        });
    }

    #[test]
    fn env_model_overrides_persisted() {
        let dir = temp_dir("env-model");
        with_env(&[("CRISH_MODEL", Some("env-model-name"))], || {
            let mut store = test_store(&dir);
            store.config_mut(DEFAULT_PROVIDER_ID).model = Some("persisted-model".to_string());
            let resolved = store.resolve_default().expect("解析");
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
                let resolved = store.resolve_default().expect("解析");
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
                let resolved = store.resolve_default().expect("解析");
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
                .set_api_key(DEFAULT_PROVIDER_ID, "sk-stored-key".to_string())
                .expect("写入存储密钥");
            let resolved = store.resolve_default().expect("解析");
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
                .set_api_key(DEFAULT_PROVIDER_ID, "sk-stored-key".to_string())
                .expect("写入存储密钥");
            let resolved = store.resolve_default().expect("解析");
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
                .set_api_key(DEFAULT_PROVIDER_ID, "sk-stored-key".to_string())
                .expect("写入存储密钥");
            store
                .set_api_key(DEFAULT_PROVIDER_ID, String::new())
                .expect("清除存储密钥");
            let resolved = store.resolve_default().expect("解析");
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
        assert_eq!(
            store.config(DEFAULT_PROVIDER_ID),
            &ProviderConfig::default()
        );
    }

    #[test]
    fn save_then_reload_preserves_config() {
        let dir = temp_dir("save-reload");
        let mut store = ProviderConfigStore::load(&dir).expect("加载");
        store.config_mut(DEFAULT_PROVIDER_ID).endpoint = Some(Endpoint::Responses);
        store.config_mut(DEFAULT_PROVIDER_ID).model = Some("reload-model".to_string());
        store
            .config_mut(DEFAULT_PROVIDER_ID)
            .extra
            .insert("vendor".to_string(), serde_json::json!("deepseek"));
        store.save().expect("保存");

        let reloaded = ProviderConfigStore::load(&dir).expect("重载");
        assert_eq!(
            reloaded.config(DEFAULT_PROVIDER_ID),
            store.config(DEFAULT_PROVIDER_ID)
        );
        assert_eq!(
            reloaded.resolve_default().expect("解析").endpoint,
            Endpoint::Responses
        );
        assert_eq!(
            reloaded.resolve_default().expect("解析").model.as_deref(),
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
        // 清除 API key env，确保走到存储路径触发引用消毒错误。
        with_env(&[("CRISH_API_KEY", None), ("OPENAI_API_KEY", None)], || {
            let mut store = test_store(&dir);
            store.config_mut(DEFAULT_PROVIDER_ID).api_key_ref = Some("../escape".to_string());
            match store.resolve_default() {
                Err(CredentialError::InvalidEncoding(_)) => {}
                other => panic!("期望凭据引用错误，得到：{other:?}"),
            }
        });
    }

    #[test]
    fn api_key_ref_selects_secret_file() {
        let dir = temp_dir("ref-file");
        // 明文文件模式：验证凭据文件确实按引用名落盘。
        let mut store = ProviderConfigStore {
            config_path: dir.join(DEFAULT_CONFIG_FILE_NAME),
            secrets_dir: dir.join("secrets"),
            credential_store: CredentialStore::plaintext_for_test(),
            configs: default_provider_map(),
        };
        store.config_mut(DEFAULT_PROVIDER_ID).api_key_ref = Some("anthropic-main".to_string());
        store
            .set_api_key(DEFAULT_PROVIDER_ID, "sk-ref-key".to_string())
            .expect("写入存储密钥");
        // 凭据文件应落在 secrets/anthropic-main.dpapi，而非默认条目。
        let path = dir.join("secrets").join("anthropic-main.dpapi");
        assert!(path.exists());
        // 默认条目不受影响。
        assert!(!dir.join("secrets").join("default.dpapi").exists());
    }

    // ── T1.2 多提供方配置映射 ──

    #[test]
    fn multi_provider_map_loads_and_resolves_independently() {
        let dir = temp_dir("multi-map-load");
        fs::write(
            dir.join(DEFAULT_CONFIG_FILE_NAME),
            r#"{
              "a": { "baseUrl": "https://a.example/v1", "model": "model-a", "endpoint": "responses" },
              "b": { "baseUrl": "https://b.example/v1", "model": "model-b" }
            }"#,
        )
        .expect("写入配置");
        // load 走真实文件解析 + 内存凭据。
        with_env(&[], || {
            let store = ProviderConfigStore::load(&dir).expect("加载");
            // 映射含默认 provider（load 归一）。
            assert!(store.configs().contains_key(DEFAULT_PROVIDER_ID));
            assert!(store.configs().contains_key("a"));
            assert!(store.configs().contains_key("b"));

            let ra = store.resolve("a").expect("解析 a");
            let rb = store.resolve("b").expect("解析 b");
            // 各自独立，互不串扰。
            assert_eq!(ra.provider_id, "a");
            assert_eq!(rb.provider_id, "b");
            assert_eq!(ra.base_url.as_deref(), Some("https://a.example/v1"));
            assert_eq!(rb.base_url.as_deref(), Some("https://b.example/v1"));
            assert_eq!(ra.model.as_deref(), Some("model-a"));
            assert_eq!(rb.model.as_deref(), Some("model-b"));
            assert_eq!(ra.endpoint, Endpoint::Responses);
            // b 未显式指定端点，00 D3 → chat-completions。
            assert_eq!(rb.endpoint, Endpoint::ChatCompletions);

            // save 原子写回映射，重载后仍独立。
            store.save().expect("保存");
            let reloaded = ProviderConfigStore::load(&dir).expect("重载");
            assert_eq!(
                reloaded.resolve("a").expect("重载解析 a").model.as_deref(),
                Some("model-a")
            );
            assert_eq!(
                reloaded.resolve("b").expect("重载解析 b").model.as_deref(),
                Some("model-b")
            );
        });
    }

    #[test]
    fn legacy_single_object_wraps_as_default_provider() {
        with_env(&[], || {
            let dir = temp_dir("legacy-single");
            fs::write(
                dir.join(DEFAULT_CONFIG_FILE_NAME),
                r#"{ "providerId": "openai-compatible", "baseUrl": "https://legacy.example/v1", "model": "legacy-model" }"#,
            )
            .expect("写入配置");
            let store = ProviderConfigStore::load(&dir).expect("加载");
            // 旧单对象应以默认键入映射。
            assert_eq!(
                store.config(DEFAULT_PROVIDER_ID).model.as_deref(),
                Some("legacy-model")
            );
            let resolved = store.resolve_default().expect("解析");
            assert_eq!(resolved.provider_id, "openai-compatible");
            assert_eq!(
                resolved.base_url.as_deref(),
                Some("https://legacy.example/v1")
            );
            assert_eq!(resolved.model.as_deref(), Some("legacy-model"));
        });
    }

    // ── T1.3 凭据 per-provider ──

    #[test]
    fn per_provider_secrets_do_not_overwrite_and_clear_independently() {
        let dir = temp_dir("per-provider-secrets");
        let mut store = ProviderConfigStore {
            config_path: dir.join(DEFAULT_CONFIG_FILE_NAME),
            secrets_dir: dir.join("secrets"),
            credential_store: CredentialStore::plaintext_for_test(),
            configs: BTreeMap::from([
                ("a".to_string(), ProviderConfig::default()),
                ("b".to_string(), ProviderConfig::default()),
            ]),
        };
        store
            .set_api_key("a", "sk-a".to_string())
            .expect("写 a 密钥");
        store
            .set_api_key("b", "sk-b".to_string())
            .expect("写 b 密钥");
        // 各写各的凭据文件，互不覆盖。
        let path_a = dir.join("secrets").join("a.dpapi");
        let path_b = dir.join("secrets").join("b.dpapi");
        assert!(path_a.exists());
        assert!(path_b.exists());

        // resolve 用各自密钥。
        with_env(&[], || {
            assert_eq!(
                store
                    .resolve("a")
                    .expect("解析 a")
                    .api_key
                    .expect("a 有密钥")
                    .as_str(),
                "sk-a"
            );
            assert_eq!(
                store
                    .resolve("b")
                    .expect("解析 b")
                    .api_key
                    .expect("b 有密钥")
                    .as_str(),
                "sk-b"
            );
        });

        // clear 只清当前 provider：清 a，b 不受影响。
        store.set_api_key("a", String::new()).expect("清 a 密钥");
        assert!(!path_a.exists());
        assert!(path_b.exists());
        with_env(&[], || {
            let ra = store.resolve("a").expect("重析 a");
            assert!(ra.api_key.is_none());
            assert_eq!(ra.api_key_source, ApiKeySource::Unset);
            assert_eq!(
                store
                    .resolve("b")
                    .expect("重析 b")
                    .api_key
                    .expect("b 仍有密钥")
                    .as_str(),
                "sk-b"
            );
        });
    }

    // ── T1.4 env per-provider 路由 ──

    #[test]
    fn provider_env_routes_by_provider_prefix() {
        let dir = temp_dir("provider-env-route");
        let store = test_store(&dir);
        with_env(
            &[
                ("OPENAI_API_KEY", Some("sk-openai")),
                ("DEEPSEEK_API_KEY", Some("sk-deepseek")),
                ("CRISH_API_KEY", None),
            ],
            || {
                // 各 provider 取各自前缀 env。
                let ro = store.resolve("openai").expect("解析 openai");
                assert_eq!(ro.api_key.expect("openai 有密钥").as_str(), "sk-openai");
                assert_eq!(ro.api_key_source, ApiKeySource::Env);
                let rd = store.resolve("deepseek").expect("解析 deepseek");
                assert_eq!(rd.api_key.expect("deepseek 有密钥").as_str(), "sk-deepseek");
                assert_eq!(rd.api_key_source, ApiKeySource::Env);
            },
        );
    }

    #[test]
    fn provider_env_falls_back_to_crish_when_no_provider_prefix() {
        let dir = temp_dir("provider-env-fallback");
        let store = test_store(&dir);
        // 无 {P}_ 前缀 env 时回退 CRISH_* 兼容组。
        with_env(
            &[
                ("OPENAI_API_KEY", None),
                ("DEEPSEEK_API_KEY", None),
                ("CRISH_API_KEY", Some("sk-crish")),
            ],
            || {
                let ro = store.resolve("openai").expect("解析 openai");
                assert_eq!(ro.api_key.expect("回退密钥").as_str(), "sk-crish");
                assert_eq!(ro.api_key_source, ApiKeySource::Env);
            },
        );
        // 全部未设置 → Unset，不误报存储。
        with_env(
            &[
                ("OPENAI_API_KEY", None),
                ("DEEPSEEK_API_KEY", None),
                ("CRISH_API_KEY", None),
            ],
            || {
                let ro = store.resolve("openai").expect("解析 openai");
                assert_eq!(ro.api_key_source, ApiKeySource::Unset);
            },
        );
    }

    #[test]
    fn provider_env_for_base_url_and_model() {
        let dir = temp_dir("provider-env-fields");
        let store = test_store(&dir);
        with_env(
            &[
                ("OPENAI_BASE_URL", Some("https://provider.example/v1")),
                ("OPENAI_MODEL", Some("provider-model")),
            ],
            || {
                let ro = store.resolve("openai").expect("解析 openai");
                assert_eq!(ro.base_url.as_deref(), Some("https://provider.example/v1"));
                assert_eq!(ro.model.as_deref(), Some("provider-model"));
            },
        );
    }
}
