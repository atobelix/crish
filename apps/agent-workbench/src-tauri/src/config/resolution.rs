//! 配置解析：环境变量合并、字段规范化与有效值来源标记。

use std::env;

use super::credentials::CredentialPersistence;

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

pub(crate) const DEFAULT_CREDENTIAL_MODE: &str = "auto";
pub(crate) const DEFAULT_PROVIDER_ENDPOINT: &str = "auto";
pub(crate) const DEFAULT_PROVIDER_STREAM: bool = true;

#[derive(Debug, Clone)]
pub(crate) struct RuntimeProviderConfig {
    pub(crate) api_key: Option<String>,
    pub(crate) api_key_touched: bool,
    pub(crate) base_url: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) credential_mode: Option<String>,
    pub(crate) endpoint: Option<String>,
    pub(crate) stream: Option<bool>,
}

#[derive(Debug, Clone)]
pub(crate) struct ProviderConfigDiagnostic {
    pub(crate) code: String,
    pub(crate) message: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ResolvedSecret {
    pub(crate) value: String,
    pub(crate) source: ApiKeySource,
    pub(crate) persistence: CredentialPersistence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub(crate) enum ApiKeySource {
    RuntimeUpdate,
    UserConfig,
    Env,
    Unset,
}

impl ApiKeySource {
    pub(crate) fn renderer_value(self) -> &'static str {
        match self {
            Self::RuntimeUpdate => "frontend",
            Self::UserConfig => "frontend",
            Self::Env => "env",
            Self::Unset => "unset",
        }
    }

    pub(crate) fn daemon_value(self) -> &'static str {
        match self {
            Self::RuntimeUpdate => "runtime-update",
            Self::UserConfig => "user-config",
            Self::Env => "env",
            Self::Unset => "unset",
        }
    }
}

pub(crate) fn normalize_config_value(value: String) -> String {
    value.trim().to_string()
}

pub(crate) fn non_empty_config_value(value: String) -> Option<String> {
    let value = normalize_config_value(value);
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

pub(crate) fn first_env_value(names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| env::var(name).ok().and_then(non_empty_config_value))
}

pub(crate) fn api_key_env_var_names() -> &'static [&'static str] {
    API_KEY_ENV_VARS
}

pub(crate) fn api_base_url_env_var_names() -> &'static [&'static str] {
    API_BASE_URL_ENV_VARS
}

pub(crate) fn model_env_var_names() -> &'static [&'static str] {
    MODEL_ENV_VARS
}

pub(crate) fn credential_mode_env_var_names() -> &'static [&'static str] {
    CREDENTIAL_MODE_ENV_VARS
}

pub(crate) fn normalize_credential_mode(value: String) -> Option<String> {
    match value.trim() {
        "direct" => Some("direct".to_string()),
        "account-center" => Some("account-center".to_string()),
        "auto" => Some("auto".to_string()),
        _ => None,
    }
}

pub(crate) fn normalize_provider_endpoint(value: String) -> Option<String> {
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

pub(crate) fn last4(value: &str) -> Option<String> {
    let chars: Vec<char> = value.chars().collect();
    if chars.is_empty() {
        None
    } else {
        Some(chars[chars.len().saturating_sub(4)..].iter().collect())
    }
}
