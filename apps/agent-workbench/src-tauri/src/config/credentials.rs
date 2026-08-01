//! 凭证存储与密钥槽命令（K-01 / K-02）。
//!
//! - `CredentialStore`：Windows DPAPI 加密后 hex 落盘；非 Windows 纯内存降级；
//!   进程内缓存避免重复解密，缓存仅存于内存（进程退出即失效）。
//! - 密钥槽布局：`config_dir()/secrets/{profileId}.dpapi`（persistence.rs 解析，
//!   id 经白名单校验，防路径穿越）。
//! - 命令面（PE-07 F5 终态名）：`config_secret_set / get / has / clear / reveal`。
//! - 安全约束：
//!   - K-02：除 `config_secret_reveal(ui_confirm = true)` 外，任何命令都不回传明文，
//!     只回 `{ hasKey, apiKeyLast4 }`；
//!   - K-05：成功日志只记 last4，不记明文。
//!
//! 说明：crates/agent-provider 的 `CredentialStore`（T07.4 已确认在 crates 侧完好）
//! 提供等价能力；本壳保留进程内实现（DPAPI + 内存降级 + 缓存），不引入新依赖。

use std::{
    cell::RefCell,
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

use conex_types::CoreError;
use serde_json::Value;

use super::persistence::profile_secret_path;
use super::resolution::{last4, normalize_config_value};
use super::{with_profile_secrets, with_profile_secrets_mut};

#[derive(Debug, Clone)]
pub(crate) struct CredentialStore {
    mode: CredentialStoreMode,
    memory_key: Option<String>,
    pub(crate) unavailable: bool,
    // OS 凭证内存缓存：避免每次 read 都重新进行 DPAPI 解密。
    // 缓存 None 表示"已知文件不存在"（避免重复文件系统访问）；
    // key 不在 map 中表示"尚未读取，需要从 OS 解密"。
    // 缓存仅存在于进程内存中，不持久化——进程退出即失效（安全）。
    os_cache: RefCell<HashMap<PathBuf, Option<String>>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CredentialStoreMode {
    Os,
    MemoryOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CredentialPersistence {
    Persisted,
    MemoryOnly,
    Degraded,
    Unset,
}

impl CredentialPersistence {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Persisted => "persisted",
            Self::MemoryOnly => "memory-only",
            Self::Degraded => "degraded",
            Self::Unset => "unset",
        }
    }
}

impl CredentialStore {
    pub(crate) fn new(secret_path: PathBuf) -> Self {
        match os_secret_store_available(&secret_path) {
            Ok(()) => Self {
                mode: CredentialStoreMode::Os,
                memory_key: None,
                unavailable: false,
                os_cache: RefCell::new(HashMap::new()),
            },
            Err(_) => Self {
                mode: CredentialStoreMode::MemoryOnly,
                memory_key: None,
                unavailable: true,
                os_cache: RefCell::new(HashMap::new()),
            },
        }
    }

    #[allow(dead_code)]
    pub(crate) fn unavailable_for_test() -> Self {
        Self {
            mode: CredentialStoreMode::MemoryOnly,
            memory_key: None,
            unavailable: true,
            os_cache: RefCell::new(HashMap::new()),
        }
    }

    pub(crate) fn read(&self, path: &Path) -> Result<Option<String>, String> {
        match self.mode {
            CredentialStoreMode::Os => {
                // 先查内存缓存（克隆出 Option<Option<String>> 以便立即释放 RefCell 借用）
                if let Some(cached) = self.os_cache.borrow().get(path).cloned() {
                    return Ok(cached);
                }
                // 缓存未命中：调用 OS 解密并写入缓存
                let value = read_os_secret(path)?;
                self.os_cache
                    .borrow_mut()
                    .insert(path.to_path_buf(), value.clone());
                Ok(value)
            }
            CredentialStoreMode::MemoryOnly => Ok(self.memory_key.clone()),
        }
    }

    pub(crate) fn write(
        &mut self,
        path: &Path,
        value: &str,
    ) -> Result<CredentialPersistence, String> {
        match self.mode {
            CredentialStoreMode::Os => match write_os_secret(path, value) {
                Ok(()) => {
                    // 写入成功后同步更新内存缓存，保证后续 read 命中
                    self.os_cache
                        .borrow_mut()
                        .insert(path.to_path_buf(), Some(value.to_string()));
                    Ok(CredentialPersistence::Persisted)
                }
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

    pub(crate) fn clear(&mut self, path: &Path) -> Result<CredentialPersistence, String> {
        self.memory_key = None;
        match self.mode {
            CredentialStoreMode::Os => {
                remove_os_secret(path)?;
                // 清除文件后同步失效缓存条目，下次 read 会重新读取（应返回 None）
                self.os_cache.borrow_mut().remove(path);
                Ok(CredentialPersistence::Unset)
            }
            CredentialStoreMode::MemoryOnly => Ok(CredentialPersistence::Unset),
        }
    }

    pub(crate) fn persistence_for_key(&self, source: super::resolution::ApiKeySource) -> CredentialPersistence {
        match source {
            super::resolution::ApiKeySource::RuntimeUpdate => {
                if self.mode == CredentialStoreMode::Os && !self.unavailable {
                    CredentialPersistence::Persisted
                } else if self.unavailable {
                    CredentialPersistence::Degraded
                } else {
                    CredentialPersistence::MemoryOnly
                }
            }
            super::resolution::ApiKeySource::UserConfig => {
                if self.unavailable {
                    CredentialPersistence::Degraded
                } else if self.mode == CredentialStoreMode::Os {
                    CredentialPersistence::Persisted
                } else {
                    CredentialPersistence::MemoryOnly
                }
            }
            super::resolution::ApiKeySource::Env => CredentialPersistence::Unset,
            super::resolution::ApiKeySource::Unset => CredentialPersistence::Unset,
        }
    }

    /// 读取场景下的落盘状态展示：无密钥 = Unset；有密钥按存储模式归类。
    pub(crate) fn persistence_for_read(&self, has_key: bool) -> CredentialPersistence {
        if !has_key {
            return CredentialPersistence::Unset;
        }
        if self.unavailable {
            CredentialPersistence::Degraded
        } else if self.mode == CredentialStoreMode::Os {
            CredentialPersistence::Persisted
        } else {
            CredentialPersistence::MemoryOnly
        }
    }
}

// ── 密钥槽命令（PE-07 F5 终态名；错误统一 CoreError）─────────────────────

/// 错误映射：密钥槽 id 校验失败 → InvalidInput。
fn profile_id_err(error: String) -> CoreError {
    CoreError::InvalidInput(error)
}

/// 错误映射：存储读写失败 → Internal（保留可诊断消息）。
fn store_err(error: String) -> CoreError {
    CoreError::Internal(error)
}

/// 组装脱敏状态响应（K-02：无明文 apiKey 字段）。
fn secret_status(
    profile_id: String,
    has_key: bool,
    api_key_last4: Option<String>,
    persistence: Option<CredentialPersistence>,
) -> Value {
    let mut out = serde_json::json!({
        "ok": true,
        "profileId": profile_id,
        "hasKey": has_key,
    });
    if let Some(last4) = api_key_last4 {
        out["apiKeyLast4"] = Value::String(last4);
    }
    if let Some(persistence) = persistence {
        out["persistence"] = Value::String(persistence.as_str().to_string());
    }
    out
}

/// 写指定 profile 的 API key 到 DPAPI 密钥槽（空串 = 清除）。
///
/// 返回 `{ ok, profileId, hasKey, apiKeyLast4, persistence }`；成功日志只记 last4（K-05）。
#[tauri::command]
pub(crate) fn config_secret_set(
    profile_id: String,
    api_key: String,
) -> Result<Value, CoreError> {
    let path = profile_secret_path(&profile_id).map_err(profile_id_err)?;
    let key = normalize_config_value(api_key);
    if key.is_empty() {
        return with_profile_secrets_mut(|store| {
            let persistence = store.clear(&path).map_err(store_err)?;
            Ok(secret_status(profile_id, false, None, Some(persistence)))
        });
    }
    with_profile_secrets_mut(|store| {
        let persistence = match store.write(&path, &key) {
            Ok(persistence) => persistence,
            // 落盘失败降级为内存：密钥仍可用，展示层标记 degraded。
            Err(_) => CredentialPersistence::Degraded,
        };
        let last4 = last4(&key);
        // K-05：成功日志只记 last4，不记明文。
        tracing::info!(
            target: "config",
            profile_id = %profile_id,
            api_key_last4 = ?last4,
            persistence = persistence.as_str(),
            "config_secret_set: 密钥已写入 DPAPI 密钥槽"
        );
        Ok(secret_status(profile_id, true, last4, Some(persistence)))
    })
}

/// 读取指定 profile 的密钥状态（K-02：只回 `{ hasKey, apiKeyLast4 }`，不回明文）。
#[tauri::command]
pub(crate) fn config_secret_get(profile_id: String) -> Result<Value, CoreError> {
    let path = profile_secret_path(&profile_id).map_err(profile_id_err)?;
    with_profile_secrets(|store| {
        let value = store.read(&path).map_err(store_err)?;
        let has_key = value.as_ref().is_some_and(|v| !v.is_empty());
        // K-02：默认不回明文，只回 last4。
        let last4 = value.as_deref().and_then(last4);
        Ok(secret_status(
            profile_id,
            has_key,
            last4,
            Some(store.persistence_for_read(has_key)),
        ))
    })
}

/// 仅探测指定 profile 是否已有密钥（不回明文，也不回 last4）。
#[tauri::command]
pub(crate) fn config_secret_has(profile_id: String) -> Result<Value, CoreError> {
    let path = profile_secret_path(&profile_id).map_err(profile_id_err)?;
    with_profile_secrets(|store| {
        let value = store.read(&path).map_err(store_err)?;
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
pub(crate) fn config_secret_clear(profile_id: String) -> Result<Value, CoreError> {
    let path = profile_secret_path(&profile_id).map_err(profile_id_err)?;
    with_profile_secrets_mut(|store| {
        let persistence = store.clear(&path).map_err(store_err)?;
        tracing::info!(
            target: "config",
            profile_id = %profile_id,
            "config_secret_clear: 密钥已清除"
        );
        Ok(secret_status(profile_id, false, None, Some(persistence)))
    })
}

/// 「显示密钥」一次性确认入口（K-02）：`ui_confirm = true` 才回明文；
/// `false` 仅回 `{ hasKey, apiKeyLast4 }` 且 `revealed = false`。
#[tauri::command]
pub(crate) fn config_secret_reveal(
    profile_id: String,
    ui_confirm: bool,
) -> Result<Value, CoreError> {
    let path = profile_secret_path(&profile_id).map_err(profile_id_err)?;
    with_profile_secrets(|store| {
        let plain = store.read(&path).map_err(store_err)?.unwrap_or_default();
        let has_key = !plain.is_empty();
        let last4 = last4(&plain);
        let mut out = secret_status(
            profile_id,
            has_key,
            last4,
            Some(store.persistence_for_read(has_key)),
        );
        // K-02：仅在 webview 携带一次性 UI 确认参数时回明文。
        out["revealed"] = Value::Bool(ui_confirm && has_key);
        if ui_confirm && has_key {
            out["apiKey"] = Value::String(plain);
        }
        Ok(out)
    })
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
    // SAFETY: CryptProtectData 是进入 Windows DPAPI 的 FFI 调用，调用方保证：
    // - in_blob.pbData 指向长度为 in_blob.cbData 的合法缓冲区；
    // - out_blob 是合法的 CRYPT_INTEGER_BLOB，由函数填充；
    // - CRYPTPROTECT_UI_FORBIDDEN 禁止任何 UI 弹窗。
    // 成功后 out_blob 持有 DPAPI 分配的加密数据。
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
    // SAFETY: 成功时 out_blob.pbData/cbData 由 DPAPI 设置并保证有效；
    // 立即拷贝进 Vec 避免生命周期问题。
    let bytes =
        unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec() };
    // SAFETY: LocalFree 释放 CryptProtectData 分配的内存，指针必须原样返回。
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
    // SAFETY: CryptUnprotectData 是进入 Windows DPAPI 的 FFI 调用，调用方保证：
    // - in_blob.pbData 指向长度为 in_blob.cbData 的合法密文缓冲区；
    // - out_blob 是合法的 CRYPT_INTEGER_BLOB，由函数填充；
    // - CRYPTPROTECT_UI_FORBIDDEN 禁止任何 UI 弹窗。
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
    // SAFETY: 成功时 out_blob.pbData/cbData 由 DPAPI 设置并保证有效；
    // 立即拷贝进 Vec 避免生命周期问题。
    let bytes =
        unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec() };
    // SAFETY: LocalFree 释放 CryptUnprotectData 分配的内存，指针必须原样返回。
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
