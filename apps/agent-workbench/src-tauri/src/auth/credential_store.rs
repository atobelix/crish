//! 平台安全凭据存储层（Credential Store）（audit-repair-202609 · T13 对齐实现）
//!
//! - Windows：原生 DPAPI（CryptProtectData / CryptUnprotectData）强加密，UI_FORBIDDEN；
//! - 非 Windows：`0600` 权限的**明文**文件（`auth/` 目录 0700），安全性依赖
//!   用户目录权限——如实声明，不虚标「加密」；
//! - 内存：读出的缓冲在解析后 best-effort `zeroize`（`String::from_utf8`
//!   需要克隆源缓冲，无法做到全路径零化，此处为工程最优尽力语义）。

use anyhow::{anyhow, Result};
use std::fs;
use std::path::PathBuf;
use zeroize::Zeroize;

#[cfg(target_os = "windows")]
#[allow(unsafe_code)]
mod dpapi {
    use super::*;
    use std::ptr;

    #[repr(C)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    #[link(name = "Crypt32")]
    extern "system" {
        fn CryptProtectData(
            p_data_in: *const DataBlob,
            sz_data_descr: *const u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *mut std::ffi::c_void,
            p_prompt_struct: *mut std::ffi::c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;

        fn CryptUnprotectData(
            p_data_in: *const DataBlob,
            ppsz_data_descr: *mut *mut u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *mut std::ffi::c_void,
            p_prompt_struct: *mut std::ffi::c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;

        fn LocalFree(h_mem: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
    }

    pub fn protect(plaintext: &[u8]) -> Result<Vec<u8>> {
        if plaintext.is_empty() {
            return Ok(Vec::new());
        }

        let in_blob = DataBlob {
            cb_data: plaintext.len() as u32,
            pb_data: plaintext.as_ptr() as *mut u8,
        };
        let mut out_blob = DataBlob {
            cb_data: 0,
            pb_data: ptr::null_mut(),
        };

        // 0x01 = CRYPTPROTECT_UI_FORBIDDEN
        let success = unsafe {
            CryptProtectData(
                &in_blob,
                ptr::null(),
                ptr::null(),
                ptr::null_mut(),
                ptr::null_mut(),
                0x01,
                &mut out_blob,
            )
        };

        if success == 0 || out_blob.pb_data.is_null() {
            return Err(anyhow!(
                "CryptProtectData failed with Windows error: {}",
                std::io::Error::last_os_error()
            ));
        }

        let slice = unsafe {
            std::slice::from_raw_parts(out_blob.pb_data, out_blob.cb_data as usize)
        };
        let result = slice.to_vec();

        unsafe {
            LocalFree(out_blob.pb_data as *mut std::ffi::c_void);
        }

        Ok(result)
    }

    pub fn unprotect(ciphertext: &[u8]) -> Result<Vec<u8>> {
        if ciphertext.is_empty() {
            return Ok(Vec::new());
        }

        let in_blob = DataBlob {
            cb_data: ciphertext.len() as u32,
            pb_data: ciphertext.as_ptr() as *mut u8,
        };
        let mut out_blob = DataBlob {
            cb_data: 0,
            pb_data: ptr::null_mut(),
        };

        let success = unsafe {
            CryptUnprotectData(
                &in_blob,
                ptr::null_mut(),
                ptr::null(),
                ptr::null_mut(),
                ptr::null_mut(),
                0x01,
                &mut out_blob,
            )
        };

        if success == 0 || out_blob.pb_data.is_null() {
            return Err(anyhow!(
                "CryptUnprotectData failed with Windows error: {}",
                std::io::Error::last_os_error()
            ));
        }

        let slice = unsafe {
            std::slice::from_raw_parts(out_blob.pb_data, out_blob.cb_data as usize)
        };
        let result = slice.to_vec();

        unsafe {
            LocalFree(out_blob.pb_data as *mut std::ffi::c_void);
        }

        Ok(result)
    }
}

pub struct SecureCredentialStore {
    base_dir: PathBuf,
}

/// Refresh Token 密文文件名
const REFRESH_TOKEN_FILE: &str = "user_refresh.sec";

impl SecureCredentialStore {
    pub fn new(app_data_dir: PathBuf) -> Self {
        let auth_dir = app_data_dir.join("auth");
        let _ = fs::create_dir_all(&auth_dir);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&auth_dir, fs::Permissions::from_mode(0o700));
        }
        Self { base_dir: auth_dir }
    }

    /// 解析密文文件名（白名单字符，杜绝路径注入）
    fn secret_path(&self, name: &str) -> Result<PathBuf> {
        if name.is_empty()
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
            || name.starts_with('.')
        {
            return Err(anyhow!("invalid secret file name: {name}"));
        }
        Ok(self.base_dir.join(name))
    }

    /// 写入命名密文（Windows 经 DPAPI 加密；非 Windows 0600 权限文件）
    pub fn write_secret(&self, name: &str, data: &[u8]) -> Result<()> {
        let path = self.secret_path(name)?;
        #[cfg(target_os = "windows")]
        {
            let cipher = dpapi::protect(data)?;
            fs::write(&path, cipher)?;
        }
        #[cfg(not(target_os = "windows"))]
        {
            fs::write(&path, data)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
            }
        }
        Ok(())
    }

    /// 读取命名密文（返回 `None` 表示尚未写入）
    pub fn read_secret(&self, name: &str) -> Result<Option<Vec<u8>>> {
        let path = self.secret_path(name)?;
        if !path.exists() {
            return Ok(None);
        }
        let mut bytes = fs::read(&path)?;
        if bytes.is_empty() {
            return Ok(None);
        }
        #[cfg(target_os = "windows")]
        {
            let plain = dpapi::unprotect(&bytes)?;
            bytes.zeroize();
            Ok(Some(plain))
        }
        #[cfg(not(target_os = "windows"))]
        {
            Ok(Some(bytes))
        }
    }

    /// 删除命名密文
    pub fn delete_secret(&self, name: &str) -> Result<()> {
        let path = self.secret_path(name)?;
        if path.exists() {
            fs::remove_file(path)?;
        }
        Ok(())
    }

    /// 持久化加密存储 Refresh Token
    pub fn save_refresh_token(&self, token: &str) -> Result<()> {
        self.write_secret(REFRESH_TOKEN_FILE, token.as_bytes())
    }

    /// 读取解密 Refresh Token
    pub fn load_refresh_token(&self) -> Result<Option<String>> {
        let Some(bytes) = self.read_secret(REFRESH_TOKEN_FILE)? else {
            return Ok(None);
        };
        // best-effort：解析后清零源缓冲（from_utf8 需克隆，工程尽力语义见模块头）
        let parsed = String::from_utf8(bytes.clone());
        let mut bytes = bytes;
        bytes.zeroize();
        match parsed {
            Ok(token) => Ok(Some(token)),
            Err(e) => Err(anyhow!("refresh token file is not valid UTF-8: {e}")),
        }
    }

    /// 清空凭据
    pub fn clear_credentials(&self) -> Result<()> {
        self.delete_secret(REFRESH_TOKEN_FILE)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dpapi_roundtrip() {
        let temp_dir = std::env::temp_dir().join(format!("crish_test_auth_{}", std::process::id()));
        let store = SecureCredentialStore::new(temp_dir.clone());

        let raw_token = "crish-refresh-token-secure-secret-xyz-987654321";
        store.save_refresh_token(raw_token).expect("Save must succeed");

        let loaded = store.load_refresh_token().expect("Load must succeed");
        assert_eq!(loaded, Some(raw_token.to_string()));

        store.clear_credentials().expect("Clear must succeed");
        let after_clear = store.load_refresh_token().expect("Load must succeed");
        assert_eq!(after_clear, None);

        let _ = fs::remove_dir_all(temp_dir);
    }

    /// T13：通用命名密文 roundtrip（write/read/delete + 路径注入拒绝）
    #[test]
    fn test_named_secret_roundtrip() {
        let temp_dir = std::env::temp_dir().join(format!("crish_test_auth_n_{}", std::process::id()));
        let store = SecureCredentialStore::new(temp_dir.clone());

        let payload = b"{\"id\":\"u1\"}";
        store.write_secret("user_session", payload).expect("write must succeed");
        let loaded = store
            .read_secret("user_session")
            .expect("read must succeed")
            .expect("secret must exist");
        assert_eq!(loaded, payload);

        store.delete_secret("user_session").expect("delete must succeed");
        assert!(store.read_secret("user_session").unwrap().is_none());

        // 路径注入拒绝
        assert!(store.write_secret("../evil", b"x").is_err());
        assert!(store.write_secret(".hidden", b"x").is_err());

        let _ = fs::remove_dir_all(temp_dir);
    }

    /// T13：非 Windows 平台凭据文件必须 0600、auth 目录必须 0700
    #[cfg(unix)]
    #[test]
    fn test_unix_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let temp_dir = std::env::temp_dir().join(format!("crish_test_auth_p_{}", std::process::id()));
        let store = SecureCredentialStore::new(temp_dir.clone());
        store.save_refresh_token("perm-check-token").expect("save must succeed");

        let auth_dir = temp_dir.join("auth");
        let file_mode = fs::metadata(auth_dir.join("user_refresh.sec"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(file_mode, 0o600, "凭据文件必须为 0600");
        let dir_mode = fs::metadata(&auth_dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(dir_mode, 0o700, "auth 目录必须为 0700");

        let _ = fs::remove_dir_all(temp_dir);
    }
}
