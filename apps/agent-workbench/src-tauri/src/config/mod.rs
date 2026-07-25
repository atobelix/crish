//! Provider API 配置模块：加载/保存、凭证存储、环境变量合并与 Tauri 命令入口。

mod credentials;
mod env_filter;
mod persistence;
mod provider;
mod resolution;

use std::sync::{Mutex, OnceLock};

use serde_json::Value;

use credentials::{CredentialPersistence, CredentialStore};
use persistence::{
    default_config_path, default_secret_path, profile_secret_path, profile_secrets_dir,
};
use provider::ApiConfigStore;
use resolution::normalize_config_value;

// ── Static stores ──
pub(crate) static API_CONFIG_STORE: OnceLock<Mutex<ApiConfigStore>> = OnceLock::new();
pub(crate) static PROFILE_SECRET_STORE: OnceLock<Mutex<CredentialStore>> = OnceLock::new();

// ── Public re-exports ──
pub(crate) use env_filter::api_key_env_var_names;
// 使用 glob 确保 Tauri 的 #[tauri::command] 宏生成的辅助项（__cmd__*, __tauri_command_name_*）
// 在 config 命名空间下可见；逐个 use 只引入命名项，不会引入宏生成项。
pub(crate) use provider::*;

pub(crate) fn init_api_config_store() {
    let config_path = default_config_path();
    let secret_path = default_secret_path();
    let _ = API_CONFIG_STORE
        .get_or_init(|| Mutex::new(ApiConfigStore::load(config_path, secret_path)));
    let _ = profile_secret_store();
}

fn profile_secret_store() -> &'static Mutex<CredentialStore> {
    PROFILE_SECRET_STORE.get_or_init(|| {
        Mutex::new(CredentialStore::new(profile_secrets_dir().join(".probe")))
    })
}

fn with_profile_secrets_mut<T>(
    operation: impl FnOnce(&mut CredentialStore) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = profile_secret_store()
        .lock()
        .map_err(|error| format!("Failed to lock profile secret store: {error}"))?;
    operation(&mut guard)
}

fn with_profile_secrets<T>(operation: impl FnOnce(&CredentialStore) -> T) -> T {
    let guard = profile_secret_store()
        .lock()
        .expect("profile secret store lock");
    operation(&guard)
}

// ── 多 profile secret sidecar（轻量 DPAPI map；daemon 仍仅内存）──────────────

/// 写入指定 profile 的 API key（DPAPI 或 memory-only 降级）。
#[tauri::command]
pub(crate) fn workbench_profile_secret_set(
    profile_id: String,
    api_key: String,
) -> Result<Value, String> {
    let path = profile_secret_path(&profile_id)?;
    let key = normalize_config_value(api_key);
    if key.is_empty() {
        return with_profile_secrets_mut(|store| {
            let persistence = store.clear(&path)?;
            Ok(serde_json::json!({
                "ok": true,
                "profileId": profile_id,
                "hasKey": false,
                "persistence": persistence.as_str(),
            }))
        });
    }
    with_profile_secrets_mut(|store| {
        let persistence = match store.write(&path, &key) {
            Ok(p) => p,
            Err(_) => CredentialPersistence::Degraded,
        };
        Ok(serde_json::json!({
            "ok": true,
            "profileId": profile_id,
            "hasKey": true,
            "persistence": persistence.as_str(),
        }))
    })
}

/// 读取指定 profile 的 API key。
#[tauri::command]
pub(crate) fn workbench_profile_secret_get(profile_id: String) -> Result<Value, String> {
    let path = profile_secret_path(&profile_id)?;
    with_profile_secrets(|store| {
        let value = store.read(&path)?;
        let has_key = value.as_ref().is_some_and(|v| !v.is_empty());
        Ok(serde_json::json!({
            "ok": true,
            "profileId": profile_id,
            "hasKey": has_key,
            "apiKey": value.unwrap_or_default(),
        }))
    })
}

/// 仅探测是否已有密钥（不回传明文）。
#[tauri::command]
pub(crate) fn workbench_profile_secret_has(profile_id: String) -> Result<Value, String> {
    let path = profile_secret_path(&profile_id)?;
    with_profile_secrets(|store| {
        let value = store.read(&path)?;
        let has_key = value.as_ref().is_some_and(|v| !v.is_empty());
        Ok(serde_json::json!({
            "ok": true,
            "profileId": profile_id,
            "hasKey": has_key,
        }))
    })
}

/// 清除指定 profile 密钥。
#[tauri::command]
pub(crate) fn workbench_profile_secret_clear(profile_id: String) -> Result<Value, String> {
    let path = profile_secret_path(&profile_id)?;
    with_profile_secrets_mut(|store| {
        let persistence = store.clear(&path)?;
        Ok(serde_json::json!({
            "ok": true,
            "profileId": profile_id,
            "hasKey": false,
            "persistence": persistence.as_str(),
        }))
    })
}
