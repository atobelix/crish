//! Provider API 配置模块：加载/保存、密钥槽、环境变量合并与 Tauri 命令入口。
//!
//! 模块组织：
//! - `provider.rs`：`ApiConfigStore` + `effective_*` 函数族 + `ProviderStatusSource` /
//!   `provider_status()` + 命令 `config_get` / `config_update` / `config_profile_apply`；
//! - `credentials.rs`：DPAPI 密钥槽（`secrets/{id}.dpapi`）+ 命令
//!   `config_secret_set / get / has / clear / reveal`（K-02：默认只回 last4）；
//! - `persistence.rs`：配置 JSON 原子写（tmp + rename）+ 路径布局 + id 白名单；
//! - `resolution.rs`：字段规范化 / Endpoint 解析 / 来源标记；
//! - `env_filter.rs`：环境变量名清单。

mod credentials;
mod env_filter;
mod persistence;
mod provider;
mod resolution;

use std::sync::{Mutex, OnceLock};

use conex_types::CoreError;

use credentials::CredentialStore;
use persistence::{
    default_config_path, default_secret_path, profile_secrets_dir,
};
use provider::ApiConfigStore;

// ── Static stores ──
pub(crate) static API_CONFIG_STORE: OnceLock<Mutex<ApiConfigStore>> = OnceLock::new();
pub(crate) static PROFILE_SECRET_STORE: OnceLock<Mutex<CredentialStore>> = OnceLock::new();

// ── Public re-exports ──
// 使用 glob 确保 Tauri 的 #[tauri::command] 宏生成的辅助项（__cmd__*, __tauri_command_name_*）
// 在 config 命名空间下可见；逐个 use 只引入命名项，不会引入宏生成项。
pub(crate) use credentials::*;
pub(crate) use provider::*;

// 注：workbench_profile_secret_* 旧登记名别名（G11a 删除）——F5 单终态体系
// （config_command_names_contract.rs 严禁旧名登记 manifest），终态名
// config_secret_* 已在 credentials.rs 接线。

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

/// 多 profile 密钥槽锁内写操作（错误统一 CoreError，IPC 面唯一协议）。
fn with_profile_secrets_mut<T>(
    operation: impl FnOnce(&mut CredentialStore) -> Result<T, CoreError>,
) -> Result<T, CoreError> {
    let mut guard = profile_secret_store().lock().map_err(|error| {
        CoreError::Internal(format!("profile secret store lock poisoned: {error}"))
    })?;
    operation(&mut guard)
}

/// 多 profile 密钥槽锁内读操作（错误统一 CoreError，IPC 面唯一协议）。
fn with_profile_secrets<T>(
    operation: impl FnOnce(&CredentialStore) -> Result<T, CoreError>,
) -> Result<T, CoreError> {
    let guard = profile_secret_store().lock().map_err(|error| {
        CoreError::Internal(format!("profile secret store lock poisoned: {error}"))
    })?;
    operation(&guard)
}
