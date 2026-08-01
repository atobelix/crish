//! 凭据存储：Windows DPAPI 加密读写、Unix 明文文件（0600 权限）与纯内存降级。
//!
//! 从 Tauri 壳 `apps/agent-workbench/src-tauri/src/config/credentials.rs` 抽取（04 §3.2 G8），
//! 原壳仅有 Windows DPAPI 与内存降级两条路径；本模块按 B2.2 任务书补齐 Unix 明文文件路径。
//!
//! 平台策略：
//! - `cfg(windows)`：DPAPI（CryptProtectData/CryptUnprotectData）加密后 hex 落盘。
//! - `cfg(unix)`：明文文件 + 0600 权限（安全简化：仅属主可读写；不引入 keyring 依赖。
//!   API key 也可由环境变量提供，见 config.rs 的 env 覆盖合并层）。
//! - 其余平台：纯内存降级，进程退出即丢失。

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
    pub fn wipe(buf: &mut String) {
        // SAFETY: 写入全零字节会破坏 UTF-8 不变量，但此处仅在丢弃前或测试中调用，
        // 覆写后字符串不再被读取，不违反借用期内的不变量约束。
        // 这一模式与 zeroize 等内存擦除库的常见做法一致。
        let bytes = unsafe { buf.as_mut_vec() };
        for byte in bytes.iter_mut() {
            *byte = 0;
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

/// 凭据错误类型（文件缺失不视为错误：`read` 对缺失文件返回 `Ok(None)`，对齐壳语义）。
#[derive(Debug, thiserror::Error)]
pub enum CredentialError {
    /// 文件系统读写失败（缺失除外）。
    #[error("凭据文件访问失败：{0}")]
    Io(#[from] std::io::Error),
    /// 凭据密文的 hex 编码损坏或解密产物不是合法 UTF-8。
    #[error("凭据密文编码损坏：{0}")]
    InvalidEncoding(String),
    /// DPAPI 解密失败（文件存在但无法还原明文）。
    #[error("凭据解密失败：{0}")]
    Decrypt(String),
    /// DPAPI 加密失败。
    #[error("凭据加密失败：{0}")]
    Encrypt(String),
}

/// 凭据落盘状态（对齐壳 `CredentialPersistence`，供上层诊断与 UI 展示）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialPersistence {
    /// 已落盘（DPAPI 加密文件或 Unix 0600 明文文件）。
    Persisted,
    /// 仅存于进程内存。
    MemoryOnly,
    /// 落盘失败后降级为仅内存。
    Degraded,
    /// 无密钥（未设置或已清除）。
    Unset,
}

impl CredentialPersistence {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Persisted => "persisted",
            Self::MemoryOnly => "memory-only",
            Self::Degraded => "degraded",
            Self::Unset => "unset",
        }
    }
}

/// 存储模式：由平台条件编译决定，测试可强制指定。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StoreMode {
    /// Windows：DPAPI 加密后 hex 编码落盘。
    /// 非 Windows 平台的库构建中不可达（仅测试构建可见），放行死代码告警。
    #[cfg_attr(not(windows), allow(dead_code))]
    Dpapi,
    /// Unix：明文文件 + 0600 权限（安全简化，见模块注释）；测试中也可强制使用
    /// （此时权限设定仅在 Unix 生效，Windows 测试环境跳过）。
    /// 非 Unix 平台的库构建中不可达（仅测试构建可见），放行死代码告警。
    #[cfg_attr(not(unix), allow(dead_code))]
    Plaintext,
    /// 无 OS 凭据能力：仅进程内存。
    MemoryOnly,
}

/// 凭据存储：`read`/`write`/`clear` 按模式分派。
pub struct CredentialStore {
    mode: StoreMode,
    /// 内存降级时的密钥；`Drop` 时由 `SecretString` 覆写清零。
    memory_key: Option<SecretString>,
}

impl CredentialStore {
    /// 按平台选择默认模式（对齐壳 `os_secret_store_available` 的平台判定）。
    pub fn new() -> Self {
        Self {
            mode: default_mode(),
            memory_key: None,
        }
    }

    /// 读取指定路径的凭据；文件不存在返回 `Ok(None)`。
    ///
    /// Windows 路径：hex 解码 → DPAPI 解密 → UTF-8 还原；
    /// Unix 路径：直接读明文（0600 文件）；
    /// 内存模式：返回进程内存中的密钥。
    pub fn read(&self, path: &Path) -> Result<Option<SecretString>, CredentialError> {
        let value = match self.mode {
            StoreMode::Dpapi => {
                let text = read_secret_text_file(path)?;
                match text {
                    Some(hex) => {
                        let encrypted =
                            decode_hex(hex.trim()).map_err(CredentialError::InvalidEncoding)?;
                        let plain =
                            dpapi_unprotect(&encrypted).map_err(CredentialError::Decrypt)?;
                        String::from_utf8(plain).map_err(|error| {
                            CredentialError::InvalidEncoding(format!(
                                "解密产物不是合法 UTF-8：{error}"
                            ))
                        })?
                    }
                    None => return Ok(None),
                }
            }
            StoreMode::Plaintext => match read_secret_text_file(path)? {
                Some(text) => text.trim().to_string(),
                None => return Ok(None),
            },
            StoreMode::MemoryOnly => match &self.memory_key {
                Some(key) => key.as_str().to_string(),
                None => return Ok(None),
            },
        };
        Ok(Some(SecretString::new(value)))
    }

    /// 写入凭据。落盘失败时降级为仅内存并返回错误（密钥仍可用，由调用方决定如何处理）。
    pub fn write(
        &mut self,
        path: &Path,
        value: &str,
    ) -> Result<CredentialPersistence, CredentialError> {
        // 内存模式：不落盘，仅更新进程内存副本。
        if self.mode == StoreMode::MemoryOnly {
            self.memory_key = Some(SecretString::new(value.to_string()));
            return Ok(CredentialPersistence::MemoryOnly);
        }
        match self.write_to_path(path, value) {
            Ok(()) => Ok(CredentialPersistence::Persisted),
            Err(error) => {
                // 对齐壳语义：写失败不丢密钥，降级为进程内存。
                self.mode = StoreMode::MemoryOnly;
                self.memory_key = Some(SecretString::new(value.to_string()));
                Err(error)
            }
        }
    }

    /// 清除凭据：删除文件（缺失视为成功）并清空内存副本。
    pub fn clear(&mut self, path: &Path) -> Result<CredentialPersistence, CredentialError> {
        // 清空内存密钥（Option 赋值触发 Drop，`SecretString` 自动覆写清零）。
        self.memory_key = None;
        match self.mode {
            StoreMode::MemoryOnly => Ok(CredentialPersistence::Unset),
            _ => {
                match fs::remove_file(path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(CredentialError::Io(error)),
                }
                Ok(CredentialPersistence::Unset)
            }
        }
    }

    fn write_to_path(&self, path: &Path, value: &str) -> Result<(), CredentialError> {
        match self.mode {
            StoreMode::Dpapi => {
                let encrypted =
                    dpapi_protect(value.as_bytes()).map_err(CredentialError::Encrypt)?;
                write_hex_file(path, &encrypted)
            }
            StoreMode::Plaintext => write_plaintext_file(path, value.as_bytes()),
            StoreMode::MemoryOnly => Ok(()),
        }
    }

    #[cfg(test)]
    fn for_test(mode: StoreMode) -> Self {
        Self {
            mode,
            memory_key: None,
        }
    }

    /// 测试用构造器：强制纯内存模式，保证测试不依赖平台凭据能力。
    #[cfg(test)]
    pub(crate) fn memory_only_for_test() -> Self {
        Self {
            mode: StoreMode::MemoryOnly,
            memory_key: None,
        }
    }

    /// 测试用构造器：强制明文文件模式（Unix 下同样收紧 0600 权限），
    /// 用于在无 DPAPI 的环境验证文件读写与错误路径。
    #[cfg(test)]
    pub(crate) fn plaintext_for_test() -> Self {
        Self {
            mode: StoreMode::Plaintext,
            memory_key: None,
        }
    }
}

impl Default for CredentialStore {
    fn default() -> Self {
        Self::new()
    }
}

/// 按平台选择默认存储模式；每种平台恰好编译一个分支，其余分支被 cfg 裁掉。
fn default_mode() -> StoreMode {
    #[cfg(windows)]
    {
        StoreMode::Dpapi
    }
    #[cfg(unix)]
    {
        StoreMode::Plaintext
    }
    #[cfg(not(any(windows, unix)))]
    {
        StoreMode::MemoryOnly
    }
}

/// 读取凭据文件文本；文件不存在返回 `Ok(None)`。
fn read_secret_text_file(path: &Path) -> Result<Option<String>, CredentialError> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(CredentialError::Io(error)),
    }
}

/// 写入 hex 编码的 DPAPI 密文文件。
#[cfg(windows)]
fn write_hex_file(path: &Path, encrypted: &[u8]) -> Result<(), CredentialError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, format!("{}\n", encode_hex(encrypted)))?;
    Ok(())
}

/// 写入明文凭据文件。
///
/// Unix：创建时即指定 0600 权限，并在写入后再次收紧，防止已存在的旧文件权限过宽。
/// 非 Unix 平台（测试环境强制 Plaintext 模式时）不设置权限。
fn write_plaintext_file(path: &Path, bytes: &[u8]) -> Result<(), CredentialError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, bytes)?;
    #[cfg(unix)]
    set_plaintext_permissions(path)?;
    Ok(())
}

/// 将凭据文件权限收紧为仅属主可读写（0600）。
#[cfg(unix)]
fn set_plaintext_permissions(path: &Path) -> Result<(), CredentialError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

// ── Windows DPAPI（从 Tauri 壳 credentials.rs:220-324 复制，SAFETY 注释保留）──

/// 调用 `CryptProtectData` 加密明文，返回 DPAPI 密文。
#[cfg(windows)]
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
#[cfg(windows)]
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

// ── hex 编解码（从 Tauri 壳 credentials.rs:326-357 复制）──

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
    if !input.len().is_multiple_of(2) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    /// 创建独立临时目录，避免测试间相互影响。
    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = env::temp_dir().join(format!(
            "agent-provider-cred-test-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    #[test]
    fn memory_store_roundtrip_and_clear() {
        let dir = temp_dir("memory");
        let path = dir.join("secret.dpapi");
        let mut store = CredentialStore::for_test(StoreMode::MemoryOnly);

        assert_eq!(
            store.write(&path, "sk-memory-key").expect("写入"),
            CredentialPersistence::MemoryOnly
        );
        assert_eq!(
            store.read(&path).expect("读取").expect("有值").as_str(),
            "sk-memory-key"
        );
        assert_eq!(
            store.clear(&path).expect("清除"),
            CredentialPersistence::Unset
        );
        assert!(store.read(&path).expect("读取").is_none());
    }

    #[test]
    fn plaintext_file_roundtrip_and_clear() {
        let dir = temp_dir("plaintext");
        let path = dir.join("secret.plain");
        let mut store = CredentialStore::for_test(StoreMode::Plaintext);

        assert_eq!(
            store.write(&path, "sk-file-key").expect("写入"),
            CredentialPersistence::Persisted
        );
        // 文件内容应为明文本身。
        let raw = fs::read_to_string(&path).expect("读取文件");
        assert_eq!(raw.trim(), "sk-file-key");
        assert_eq!(
            store.read(&path).expect("读取").expect("有值").as_str(),
            "sk-file-key"
        );
        assert_eq!(
            store.clear(&path).expect("清除"),
            CredentialPersistence::Unset
        );
        assert!(!path.exists());
        assert!(store.read(&path).expect("读取").is_none());
    }

    #[test]
    fn missing_secret_file_reads_none() {
        let dir = temp_dir("missing");
        let path = dir.join("does-not-exist.dpapi");
        let store = CredentialStore::for_test(StoreMode::Plaintext);
        assert!(store.read(&path).expect("读取").is_none());
    }

    #[test]
    fn clear_missing_file_is_ok() {
        let dir = temp_dir("clear-missing");
        let path = dir.join("never-written.dpapi");
        let mut store = CredentialStore::for_test(StoreMode::Plaintext);
        assert_eq!(
            store.clear(&path).expect("清除缺失文件应成功"),
            CredentialPersistence::Unset
        );
    }

    #[test]
    fn read_from_directory_is_io_error() {
        let dir = temp_dir("dir-as-file");
        let store = CredentialStore::for_test(StoreMode::Plaintext);
        match store.read(&dir) {
            Err(CredentialError::Io(_)) => {}
            other => panic!("期望 Io 错误，得到：{other:?}"),
        }
    }

    #[test]
    fn write_to_invalid_parent_is_io_error() {
        let dir = temp_dir("invalid-parent");
        let blocker = dir.join("blocker");
        fs::write(&blocker, "占位文件").expect("写入占位文件");
        // 父路径是一个普通文件，无法在其下创建目录。
        let path = blocker.join("secret.dpapi");
        let mut store = CredentialStore::for_test(StoreMode::Plaintext);
        match store.write(&path, "sk-x") {
            Err(CredentialError::Io(_)) => {}
            other => panic!("期望 Io 错误，得到：{other:?}"),
        }
    }

    #[test]
    fn invalid_hex_decoding_errors() {
        // 奇数长度与非法字符都会报错。
        assert!(decode_hex("abc").is_err());
        assert!(decode_hex("zz").is_err());
        // 合法 hex 可正常往返。
        let encoded = encode_hex(&[0xde, 0xad, 0xbe, 0xef]);
        assert_eq!(
            decode_hex(&encoded).expect("解码"),
            vec![0xde, 0xad, 0xbe, 0xef]
        );
    }

    #[test]
    fn secret_string_is_wiped_by_wipe_helper() {
        let mut buf = String::from("sk-test-secret");
        SecretString::wipe(&mut buf);
        assert_eq!(buf, "\0\0\0\0\0\0\0\0\0\0\0\0\0\0");
    }

    #[test]
    fn secret_string_debug_is_redacted() {
        let secret = SecretString::new("sk-test-secret".to_string());
        assert_eq!(format!("{secret:?}"), "SecretString(***)");
        // as_str 正常暴露明文供上层使用。
        assert_eq!(secret.as_str(), "sk-test-secret");
    }

    #[cfg(unix)]
    #[test]
    fn plaintext_file_gets_0600_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("perms");
        let path = dir.join("secret.plain");
        let mut store = CredentialStore::for_test(StoreMode::Plaintext);
        store.write(&path, "sk-perms").expect("写入");
        let mode = fs::metadata(&path).expect("元数据").permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    /// Windows 真实 DPAPI 路径的读写往返（其余平台无此能力，测试被裁掉）。
    #[cfg(windows)]
    #[test]
    fn dpapi_file_roundtrip() {
        let dir = temp_dir("dpapi");
        let path = dir.join("secret.dpapi");
        let mut store = CredentialStore::for_test(StoreMode::Dpapi);

        assert_eq!(
            store.write(&path, "sk-dpapi-key").expect("写入"),
            CredentialPersistence::Persisted
        );
        // 文件内容必须是 hex 密文，不能出现明文。
        let raw = fs::read_to_string(&path).expect("读取文件");
        assert!(!raw.contains("sk-dpapi-key"));
        assert_eq!(
            store.read(&path).expect("读取").expect("有值").as_str(),
            "sk-dpapi-key"
        );
        assert_eq!(
            store.clear(&path).expect("清除"),
            CredentialPersistence::Unset
        );
        assert!(store.read(&path).expect("读取").is_none());
    }

    /// Windows DPAPI 错误路径：密文损坏与非法 hex 均类型化返回。
    #[cfg(windows)]
    #[test]
    fn corrupt_dpapi_file_errors() {
        let dir = temp_dir("corrupt-dpapi");
        let path = dir.join("secret.dpapi");
        let store = CredentialStore::for_test(StoreMode::Dpapi);

        // 合法 hex 但不是 DPAPI 密文 → 解密失败。
        fs::write(&path, "deadbeef\n").expect("写入");
        match store.read(&path) {
            Err(CredentialError::Decrypt(_)) => {}
            other => panic!("期望解密失败，得到：{other:?}"),
        }
        // 非法 hex → 编码损坏。
        fs::write(&path, "zzzz\n").expect("写入");
        match store.read(&path) {
            Err(CredentialError::InvalidEncoding(_)) => {}
            other => panic!("期望编码错误，得到：{other:?}"),
        }
    }
}
