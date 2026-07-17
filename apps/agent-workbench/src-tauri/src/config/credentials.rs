//! 凭证存储：OS/DPAPI 加密密钥读写，以及进程内降级内存存储。

use std::{
    fs,
    path::{Path, PathBuf},
};

use super::resolution::ApiKeySource;

#[derive(Debug, Clone)]
pub(crate) struct CredentialStore {
    mode: CredentialStoreMode,
    memory_key: Option<String>,
    pub(crate) unavailable: bool,
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
            },
            Err(_) => Self {
                mode: CredentialStoreMode::MemoryOnly,
                memory_key: None,
                unavailable: true,
            },
        }
    }

    #[allow(dead_code)]
    pub(crate) fn unavailable_for_test() -> Self {
        Self {
            mode: CredentialStoreMode::MemoryOnly,
            memory_key: None,
            unavailable: true,
        }
    }

    pub(crate) fn read(&self, path: &Path) -> Result<Option<String>, String> {
        match self.mode {
            CredentialStoreMode::Os => read_os_secret(path),
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

    pub(crate) fn clear(&mut self, path: &Path) -> Result<CredentialPersistence, String> {
        self.memory_key = None;
        match self.mode {
            CredentialStoreMode::Os => {
                remove_os_secret(path)?;
                Ok(CredentialPersistence::Unset)
            }
            CredentialStoreMode::MemoryOnly => Ok(CredentialPersistence::Unset),
        }
    }

    pub(crate) fn persistence_for_key(&self, source: ApiKeySource) -> CredentialPersistence {
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
