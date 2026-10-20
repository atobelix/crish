//! 系统凭据原语。Windows 使用 DPAPI；无系统凭据实现的平台明确拒绝写入。
//! 只读写调用方指定的隔离槽，不保存共享内存密钥，也不退回明文文件。

use std::{fs, path::Path};

/// 内存密钥包装：`Drop` 时覆写清零，避免明文残留在堆内存中。
///
/// 说明：workspace 根 Cargo.toml 未声明 `zeroize` 依赖（Cargo.lock 中仅作为传递依赖存在，
/// 见 04 §5.2/§5.3），按任务约束"不引入新依赖"，这里用简单覆写实现；
/// 待 zeroize 转正为 workspace 直接依赖后，可替换为 `derive(Zeroize)` 并移除手工覆写。
pub struct SecretString {
    inner: String,
}

impl SecretString {
    pub fn new(value: String) -> Self {
        Self { inner: value }
    }

    pub fn as_str(&self) -> &str {
        &self.inner
    }

    /// 覆写清零整个缓冲区（供 `Drop` 与测试直接调用）。
    // 豁免 unsafe_code：wipe 是受控内存擦除（见下方 SAFETY），经评审后允许。
    #[allow(unsafe_code)]
    pub fn wipe(buf: &mut String) {
        // SAFETY: 写入全零字节会破坏 UTF-8 不变量，但此处仅在丢弃前或测试中调用，
        // 覆写后字符串不再被读取，不违反借用期内的不变量约束。
        // 这一模式与 zeroize 等内存擦除库的常见做法一致。
        // volatile 写防优化器消除清零循环（A7 U-01 强化，裁决 D11）
        let bytes = unsafe { buf.as_mut_vec() };
        for byte in bytes.iter_mut() {
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
    }
}

impl std::fmt::Debug for SecretString {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 不打印明文内容，只打印占位符。
        f.write_str("SecretString(***)")
    }
}

impl Drop for SecretString {
    fn drop(&mut self) {
        Self::wipe(&mut self.inner);
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CredentialError {
    #[error("凭据文件访问失败：{0}")]
    Io(#[from] std::io::Error),
    #[error("凭据编码无效")]
    InvalidEncoding(String),
    #[error("系统凭据解密失败")]
    Decrypt(String),
    #[error("系统凭据加密失败")]
    Encrypt(String),
    #[error("当前平台未提供系统凭据存储；请使用显式环境变量引用")]
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialPersistence {
    Persisted,
    Unset,
}

impl CredentialPersistence {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Persisted => "persisted",
            Self::Unset => "unset",
        }
    }
}

/// 无状态系统凭据访问器；失败不改变其它槽位，也不发布内存替代值。
#[derive(Debug, Default)]
pub struct CredentialStore;

impl CredentialStore {
    pub fn new() -> Self {
        Self
    }

    pub fn read(&self, path: &Path) -> Result<Option<SecretString>, CredentialError> {
        let encrypted = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(CredentialError::Io(error)),
        };
        #[cfg(windows)]
        {
            let plain = dpapi_unprotect(&encrypted).map_err(CredentialError::Decrypt)?;
            let text = String::from_utf8(plain)
                .map_err(|_| CredentialError::InvalidEncoding("凭据不是 UTF-8".into()))?;
            Ok(Some(SecretString::new(text)))
        }
        #[cfg(not(windows))]
        {
            // 非 Windows 无 DPAPI：读取语义（NotFound → Ok(None)）已在前置分支完成，
            // 此处明确返回「不支持」而不是伪造成功；密文长度仅用于日志上下文。
            tracing::warn!(
                path = %path.display(),
                ciphertext_len = encrypted.len(),
                "当前平台缺少 DPAPI 支持，凭据读取返回不支持"
            );
            Err(CredentialError::Unsupported)
        }
    }

    pub fn write(
        &mut self,
        path: &Path,
        value: &str,
    ) -> Result<CredentialPersistence, CredentialError> {
        #[cfg(windows)]
        {
            let encrypted = dpapi_protect(value.as_bytes()).map_err(CredentialError::Encrypt)?;
            conex_fs::atomic_write_file(path, &encrypted)?;
            Ok(CredentialPersistence::Persisted)
        }
        #[cfg(not(windows))]
        {
            // 非 Windows 无 DPAPI：拒绝落盘明文凭据（secret_len 仅用于日志上下文）
            tracing::warn!(
                path = %path.display(),
                secret_len = value.len(),
                "当前平台缺少 DPAPI 保护，凭据写入返回不支持"
            );
            Err(CredentialError::Unsupported)
        }
    }

    /// 凭据清除不能进回收站保留可恢复秘密；只允许删除明确的凭据槽。
    #[allow(clippy::disallowed_methods)]
    pub fn clear(&mut self, path: &Path) -> Result<CredentialPersistence, CredentialError> {
        match fs::remove_file(path) {
            Ok(()) => Ok(CredentialPersistence::Unset),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(CredentialPersistence::Unset)
            }
            Err(error) => Err(CredentialError::Io(error)),
        }
    }
}

/// 调用 `CryptProtectData` 加密明文，返回 DPAPI 密文。
// 豁免 unsafe_code：Windows DPAPI FFI 调用（每处 unsafe 均有 SAFETY 说明），经评审后允许。
#[cfg(windows)]
#[allow(unsafe_code)]
fn dpapi_protect(input: &[u8]) -> Result<Vec<u8>, String> {
    use std::{ffi::c_void, ptr};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB},
    };

    let in_blob = CRYPT_INTEGER_BLOB {
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
            &in_blob,
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

/// 调用 `CryptUnprotectData` 解密 DPAPI 密文。
// 豁免 unsafe_code：Windows DPAPI FFI 调用（每处 unsafe 均有 SAFETY 说明），经评审后允许。
#[cfg(windows)]
#[allow(unsafe_code)]
fn dpapi_unprotect(input: &[u8]) -> Result<Vec<u8>, String> {
    use std::{ffi::c_void, ptr};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };

    let in_blob = CRYPT_INTEGER_BLOB {
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
            &in_blob,
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

#[cfg(test)]
mod tests {
    use super::*;
    use conex_test_utils::TempWorkspace;

    #[test]
    fn missing_secret_file_reads_none() {
        let dir = TempWorkspace::new("credential-missing");
        assert!(CredentialStore::new()
            .read(&dir.path().join("absent.dpapi"))
            .unwrap()
            .is_none());
    }

    #[test]
    fn clear_missing_file_is_ok() {
        let dir = TempWorkspace::new("credential-clear");
        assert_eq!(
            CredentialStore::new()
                .clear(&dir.path().join("absent.dpapi"))
                .unwrap(),
            CredentialPersistence::Unset
        );
    }

    #[test]
    fn read_from_directory_is_io_error() {
        let dir = TempWorkspace::new("credential-directory");
        assert!(matches!(
            CredentialStore::new().read(dir.path()),
            Err(CredentialError::Io(_))
        ));
    }

    #[test]
    fn secret_string_is_wiped_by_wipe_helper() {
        let mut value = "private-value".to_string();
        SecretString::wipe(&mut value);
        assert!(value.as_bytes().iter().all(|byte| *byte == 0));
    }

    #[test]
    fn secret_string_debug_is_redacted() {
        assert_eq!(
            format!("{:?}", SecretString::new("private-value".into())),
            "SecretString(***)"
        );
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_file_roundtrip_and_independent_clear() {
        let dir = TempWorkspace::new("credential-roundtrip");
        let mut store = CredentialStore::new();
        let a = dir.path().join("a.dpapi");
        let b = dir.path().join("b.dpapi");
        store.write(&a, "secret-a").unwrap();
        store.write(&b, "secret-b").unwrap();
        assert!(!String::from_utf8_lossy(&fs::read(&a).unwrap()).contains("secret-a"));
        assert_eq!(store.read(&a).unwrap().unwrap().as_str(), "secret-a");
        store.clear(&a).unwrap();
        assert!(store.read(&a).unwrap().is_none());
        assert_eq!(store.read(&b).unwrap().unwrap().as_str(), "secret-b");
    }

    #[cfg(windows)]
    #[test]
    fn write_to_invalid_parent_is_io_error_without_memory_fallback() {
        let dir = TempWorkspace::new("credential-failed-write");
        let mut store = CredentialStore::new();
        let valid = dir.path().join("valid.dpapi");
        store.write(&valid, "original").unwrap();
        let blocker = dir.path().join("file");
        fs::write(&blocker, b"blocker").unwrap();
        assert!(store.write(&blocker.join("bad.dpapi"), "failed").is_err());
        assert_eq!(store.read(&valid).unwrap().unwrap().as_str(), "original");
        assert!(store
            .read(&dir.path().join("other.dpapi"))
            .unwrap()
            .is_none());
    }

    #[cfg(windows)]
    #[test]
    fn corrupt_dpapi_file_errors() {
        let dir = TempWorkspace::new("credential-corrupt");
        let path = dir.path().join("corrupt.dpapi");
        fs::write(&path, "deadbeef").unwrap();
        assert!(CredentialStore::new().read(&path).is_err());
    }

    #[cfg(not(windows))]
    #[test]
    fn unsupported_platform_never_writes_plaintext_or_memory() {
        let dir = TempWorkspace::new("credential-unsupported");
        let path = dir.path().join("key");
        let mut store = CredentialStore::new();
        assert!(matches!(
            store.write(&path, "secret"),
            Err(CredentialError::Unsupported)
        ));
        assert!(!path.exists());
        assert!(store.read(&path).unwrap().is_none());
    }
}
