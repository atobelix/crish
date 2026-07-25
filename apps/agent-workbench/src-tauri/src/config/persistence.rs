//! 配置持久化：provider 非敏感配置的 JSON 读写与配置路径解析。

use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    path::{Path, PathBuf},
};

use super::resolution::non_empty_config_value;

const DEFAULT_CONFIG_FILE_NAME: &str = "provider-config.json";
const DEFAULT_SECRET_FILE_NAME: &str = "provider-direct-key.dpapi";
/// 多 profile 密钥目录（DPAPI 文件：`secrets/{profileId}.dpapi`）
const PROFILE_SECRETS_DIR_NAME: &str = "secrets";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PersistedProviderConfig {
    pub(crate) base_url: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) credential_mode: Option<String>,
    pub(crate) endpoint: Option<String>,
    pub(crate) stream: Option<bool>,
    pub(crate) direct_key_cleared: bool,
}

pub(crate) fn default_config_path() -> PathBuf {
    config_dir().join(DEFAULT_CONFIG_FILE_NAME)
}

pub(crate) fn default_secret_path() -> PathBuf {
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

pub(crate) fn read_persisted_config(path: &Path) -> Result<PersistedProviderConfig, String> {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|error| format!("Invalid provider config file: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(PersistedProviderConfig::default())
        }
        Err(error) => Err(format!("Failed to read provider config: {error}")),
    }
}

pub(crate) fn write_persisted_config(
    path: &Path,
    config: &PersistedProviderConfig,
) -> Result<(), String> {
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

pub(crate) fn profile_secrets_dir() -> PathBuf {
    config_dir().join(PROFILE_SECRETS_DIR_NAME)
}

pub(crate) fn profile_secret_path(profile_id: &str) -> Result<PathBuf, String> {
    let id = sanitize_profile_secret_id(profile_id)?;
    Ok(profile_secrets_dir().join(format!("{id}.dpapi")))
}

fn sanitize_profile_secret_id(profile_id: &str) -> Result<String, String> {
    let id = profile_id.trim();
    if id.is_empty() {
        return Err("profileId is empty".to_string());
    }
    if id.len() > 128 {
        return Err("profileId is too long".to_string());
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(
            "profileId must be ASCII alphanumeric, '-' or '_' only".to_string(),
        );
    }
    Ok(id.to_string())
}
