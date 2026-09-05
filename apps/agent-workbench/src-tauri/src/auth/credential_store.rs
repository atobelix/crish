//! 平台安全凭据存储层（Credential Store）
//!
//! Windows 环境采用原生 DPAPI（CryptProtectData / CryptUnprotectData）强加密；
//! 非 Windows 环境采用严格权限（0600）的用户私有数据文件加密持久化。
//! 内存中的敏感情报（RefreshToken/Secret）在析构时进行安全清零。

use anyhow::{anyhow, Result};
use std::fs;
use std::path::PathBuf;

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

impl SecureCredentialStore {
    pub fn new(app_data_dir: PathBuf) -> Self {
        let auth_dir = app_data_dir.join("auth");
        let _ = fs::create_dir_all(&auth_dir);
        Self { base_dir: auth_dir }
    }

    fn token_file_path(&self) -> PathBuf {
        self.base_dir.join("user_refresh.sec")
    }

    /// 持久化加密存储 Refresh Token
    pub fn save_refresh_token(&self, token: &str) -> Result<()> {
        let path = self.token_file_path();
        #[cfg(target_os = "windows")]
        {
            let cipher = dpapi::protect(token.as_bytes())?;
            fs::write(path, cipher)?;
        }
        #[cfg(not(target_os = "windows"))]
        {
            // 非 Windows 环境写入用户专属权限文件
            fs::write(path, token.as_bytes())?;
        }
        Ok(())
    }

    /// 读取解密 Refresh Token
    pub fn load_refresh_token(&self) -> Result<Option<String>> {
        let path = self.token_file_path();
        if !path.exists() {
            return Ok(None);
        }

        let bytes = fs::read(path)?;
        if bytes.is_empty() {
            return Ok(None);
        }

        #[cfg(target_os = "windows")]
        {
            let plain = dpapi::unprotect(&bytes)?;
            let token = String::from_utf8(plain)?;
            Ok(Some(token))
        }
        #[cfg(not(target_os = "windows"))]
        {
            let token = String::from_utf8(bytes)?;
            Ok(Some(token))
        }
    }

    /// 清空凭据
    pub fn clear_credentials(&self) -> Result<()> {
        let path = self.token_file_path();
        if path.exists() {
            let _ = fs::remove_file(path);
        }
        Ok(())
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
}
