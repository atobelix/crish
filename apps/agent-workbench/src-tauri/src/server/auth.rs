//! 令牌哈希存储与 Bearer 鉴权（D2 §7：SHA-256 哈希落 pairing.json）
//!
//! - **签发**：32 字节 CSPRNG → hex 64 字符令牌（明文只返回客户端一次）；
//!   落盘只存 SHA-256 哈希（`config_dir()/pairing.json`，D2 §7.3 形状）
//!   ——文件泄露 ≠ 令牌泄露；
//! - **校验**：`Authorization: Bearer <token>` → SHA-256 → 常量时间比较
//!   + revoked 检查（axum 中间件 [require_bearer_token]；校验失败 → 401）；
//! - **持久化**：原子写（tmp + rename，对齐 `config/persistence.rs` 先例）；
//!   权限位（Unix 0600 / Windows ACL 收紧）与撤销全链归 R1-07。

use std::fs;
use std::path::{Path, PathBuf};

use axum::{
    Json,
    extract::{Request, State},
    http::{StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use conex_types::device::{DeviceErrorCode, ErrorBody};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::server::{ServerError, ServerState, now_ms};

/// 令牌原始字节数（D2 §7.2：32 字节 CSPRNG，hex 64 字符）
// R1-02 备注：R1-07 配对签发消费——dead_code 静音（测试构建保持检查）
#[cfg_attr(not(test), allow(dead_code))]
pub const TOKEN_BYTES: usize = 32;
/// pairing.json 结构版本
// R1-02 备注：R1-07 撤销全链消费——dead_code 静音（测试构建保持检查）
#[cfg_attr(not(test), allow(dead_code))]
pub const PAIRING_FILE_VERSION: u32 = 1;

/// 令牌记录（pairing.json 条目；只含哈希，永不含明文）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenRecord {
    /// SHA-256(令牌) hex（64 字符）
    pub hash: String,
    /// 设备名 / 来源标签
    pub label: String,
    /// 签发时刻（epoch ms）
    pub issued_at_ms: u64,
    /// 最近一次校验通过时刻（epoch ms；内存更新，落盘刷新 R1-07）
    pub last_seen_at_ms: u64,
    /// 已撤销（撤销后校验立即失败）
    pub revoked: bool,
}

/// pairing.json 整体形状（D2 §7.3）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingFile {
    /// 结构版本（当前 1）
    pub version: u32,
    /// 令牌记录表
    pub tokens: Vec<TokenRecord>,
    /// 配对面是否开启（存在生效令牌即视为开启）
    pub pairing_enabled: bool,
}

/// 令牌校验结果
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenVerdict {
    /// 校验通过（令牌存在且未撤销）
    Valid,
    /// 哈希不匹配（令牌不存在 / 错误）
    Invalid,
    /// 令牌已被撤销（需重新配对）
    Revoked,
}

/// 令牌库（内存哈希表 + pairing.json 持久化）
#[derive(Debug)]
pub struct TokenStore {
    // R1-02 备注：issue/revoke/save 落盘路径消费（R1-07 前仅 load/verify
    // 在线）——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    file: PathBuf,
    tokens: Vec<TokenRecord>,
}

impl TokenStore {
    /// 新建空令牌库（不落盘）
    pub fn new(file: PathBuf) -> Self {
        Self {
            file,
            tokens: Vec::new(),
        }
    }

    /// 从 pairing.json 加载；文件缺失 → 空库；内容损坏 → 空库 + 警告
    /// （诚实降级，不阻断启动——对齐 D1 §3.4 铁律）
    pub fn load(path: &Path) -> Self {
        match fs::read_to_string(path) {
            Ok(text) => match serde_json::from_str::<PairingFile>(&text) {
                Ok(file) => {
                    tracing::info!(
                        target: "server",
                        path = %path.display(),
                        tokens = file.tokens.len(),
                        "令牌库已加载"
                    );
                    Self {
                        file: path.to_path_buf(),
                        tokens: file.tokens,
                    }
                }
                Err(error) => {
                    tracing::warn!(
                        target: "server",
                        path = %path.display(),
                        error = %error,
                        "pairing.json 损坏，降级为空令牌库"
                    );
                    Self::new(path.to_path_buf())
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Self::new(path.to_path_buf()),
            Err(error) => {
                tracing::warn!(
                    target: "server",
                    path = %path.display(),
                    error = %error,
                    "读取 pairing.json 失败，降级为空令牌库"
                );
                Self::new(path.to_path_buf())
            }
        }
    }

    /// 签发新令牌：生成 32B CSPRNG hex 令牌 → 哈希入表 → 落盘；返回明文
    /// 令牌（仅此一次可读，之后任何处只存哈希）
    // R1-02 备注：R1-07 配对流程签发消费——dead_code 静音（测试构建保持检查）
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn issue(&mut self, label: &str, now: u64) -> Result<String, ServerError> {
        let raw = generate_token_hex()?;
        let record = TokenRecord {
            hash: sha256_hex(raw.as_bytes()),
            label: label.to_string(),
            issued_at_ms: now,
            last_seen_at_ms: now,
            revoked: false,
        };
        self.tokens.push(record);
        self.save()?;
        Ok(raw)
    }

    /// 校验令牌（SHA-256 → 常量时间比较 → revoked 检查；通过时更新
    /// last_seen_at_ms——内存更新，落盘刷新归 R1-07）
    pub fn verify(&mut self, raw: &str, now: u64) -> TokenVerdict {
        let hash = sha256_hex(raw.as_bytes());
        for record in &mut self.tokens {
            if constant_time_eq(&record.hash, &hash) {
                if record.revoked {
                    return TokenVerdict::Revoked;
                }
                record.last_seen_at_ms = now;
                return TokenVerdict::Valid;
            }
        }
        TokenVerdict::Invalid
    }

    /// 撤销单个令牌（按哈希匹配；返回是否命中）
    // R1-02 备注：R1-07 设备撤销消费——dead_code 静音（测试构建保持检查）
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn revoke(&mut self, hash: &str) -> bool {
        let mut found = false;
        for record in &mut self.tokens {
            if constant_time_eq(&record.hash, hash) {
                record.revoked = true;
                found = true;
            }
        }
        if found {
            let _ = self.save();
        }
        found
    }

    /// 撤销全部令牌（关闭配对语义，D2 §5.4）
    // R1-02 备注：R1-07 关闭配对消费——dead_code 静音（测试构建保持检查）
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn revoke_all(&mut self) {
        for record in &mut self.tokens {
            record.revoked = true;
        }
        let _ = self.save();
    }

    /// 落盘（原子写：tmp + rename 原位替换；权限位收紧归 R1-07）
    // R1-02 备注：issue/revoke 落盘路径消费（R1-07 前仅 load/verify
    // 在线）——dead_code 静音（测试构建保持检查）
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn save(&self) -> Result<(), ServerError> {
        let file = PairingFile {
            version: PAIRING_FILE_VERSION,
            tokens: self.tokens.clone(),
            pairing_enabled: self.tokens.iter().any(|t| !t.revoked),
        };
        if let Some(parent) = self.file.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                ServerError::io(format!("创建令牌目录失败 {}：{e}", parent.display()))
            })?;
        }
        let tmp = self.file.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(&file)
            .map_err(|e| ServerError::io(format!("序列化 pairing.json 失败：{e}")))?;
        fs::write(&tmp, format!("{text}\n"))
            .map_err(|e| ServerError::io(format!("写 pairing.json 临时文件失败：{e}")))?;
        fs::rename(&tmp, &self.file)
            .map_err(|e| ServerError::io(format!("替换 pairing.json 失败：{e}")))?;
        Ok(())
    }

    /// 全部令牌记录（只读快照）
    // R1-02 备注：R1-08 设备管理页消费——dead_code 静音（测试构建保持检查）
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn records(&self) -> &[TokenRecord] {
        &self.tokens
    }

    /// 是否无任何令牌记录
    // R1-02 备注：R1-07 配对状态查询消费——dead_code 静音（测试构建保持检查）
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn is_empty(&self) -> bool {
        self.tokens.is_empty()
    }

    /// 令牌数量（未撤销与已撤销都计）。R1-07 状态面消费。
    pub fn token_count(&self) -> usize {
        self.tokens.len()
    }

    /// 全部令牌哈希（含已撤销）。R1-07 撤销全链消费。
    pub fn all_hashes(&self) -> Vec<String> {
        self.tokens.iter().map(|record| record.hash.clone()).collect()
    }

    /// 设备列表（配对管理面；id = 哈希截断 12 字符展示，不泄露原文）。
    /// R1-07 list_devices 消费。
    pub fn devices(&self) -> Vec<crate::server::pairing::DeviceInfo> {
        self.tokens
            .iter()
            .map(|record| crate::server::pairing::DeviceInfo {
                id: record.hash.chars().take(12).collect(),
                label: record.label.clone(),
                issued_at_ms: record.issued_at_ms,
                revoked: record.revoked,
            })
            .collect()
    }
}

/// SHA-256 hex（64 字符小写）
pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

/// 生成 32B CSPRNG 令牌（hex 64 字符；getrandom = OS CSPRNG）
// R1-02 备注：R1-07 配对签发消费——dead_code 静音（测试构建保持检查）
#[cfg_attr(not(test), allow(dead_code))]
pub fn generate_token_hex() -> Result<String, ServerError> {
    let mut bytes = [0u8; TOKEN_BYTES];
    getrandom::getrandom(&mut bytes)
        .map_err(|e| ServerError::io(format!("OS CSPRNG 读取失败：{e}")))?;
    Ok(hex::encode(bytes))
}

/// 常量时间字符串比较（防时序侧信道；长度不同直接短路）
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Bearer 令牌校验中间件（D2 §7.1 零信任：除 /v1/info 与 /v1/pair 外全部
/// 接口必须携带有效令牌；校验失败 → 401 + ErrorBody 载荷）
pub async fn require_bearer_token(
    State(state): State<ServerState>,
    request: Request,
    next: Next,
) -> Response {
    let unauthorized = |code: DeviceErrorCode, message: &str| -> Response {
        (StatusCode::UNAUTHORIZED, Json(ErrorBody::new(code, message))).into_response()
    };
    let Some(token) = bearer_token(&request) else {
        return unauthorized(
            DeviceErrorCode::AuthBadSignature,
            "缺少 Authorization: Bearer <token>",
        );
    };
    let verdict = state
        .tokens()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .verify(token, now_ms());
    match verdict {
        TokenVerdict::Valid => next.run(request).await,
        TokenVerdict::Revoked => unauthorized(
            DeviceErrorCode::AuthDeviceRevoked,
            "令牌已被撤销，请重新配对",
        ),
        TokenVerdict::Invalid => unauthorized(DeviceErrorCode::AuthBadSignature, "令牌校验失败"),
    }
}

/// 从请求头解析 Bearer 令牌（`Authorization: Bearer <token>`）
fn bearer_token(request: &Request) -> Option<&str> {
    request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|token| !token.is_empty())
}

#[cfg(test)]
mod tests {
    // 测试临时目录清理豁免（clippy.toml 豁免面：测试代码临时目录清理，
    // 非产品删除路径，mod 级 allow + 理由——产品删除走 conex-fs trash）
    #![allow(clippy::disallowed_methods)]
    use super::*;
    use std::fs;

    /// 独立临时文件路径（进程 id + 计数器保证测试互不干扰）
    fn temp_file(tag: &str) -> PathBuf {
        static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "crish-md-test-{}-{tag}-{n}.json",
            std::process::id()
        ))
    }

    #[test]
    fn sha256_hex_matches_known_vector() {
        // SHA-256("abc") 标准向量
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(sha256_hex(b"abc").len(), 64);
    }

    #[test]
    fn generate_token_is_64_hex_and_unique() {
        let a = generate_token_hex().expect("CSPRNG 必须可用");
        let b = generate_token_hex().expect("CSPRNG 必须可用");
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b, "两次生成必须不同");
    }

    #[test]
    fn constant_time_eq_behavior() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "abcd"));
        assert!(!constant_time_eq("", "a"));
        assert!(constant_time_eq("", ""));
    }

    #[test]
    fn issue_verify_roundtrip() {
        let path = temp_file("roundtrip");
        let mut store = TokenStore::new(path.clone());
        let raw = store.issue("Pixel-9", 1000).expect("签发必须成功");
        assert_eq!(store.records().len(), 1);
        // 明文校验通过
        assert_eq!(store.verify(&raw, 2000), TokenVerdict::Valid);
        // 错误令牌 → Invalid
        assert_eq!(store.verify("deadbeef", 2000), TokenVerdict::Invalid);
        // 空串 → Invalid
        assert_eq!(store.verify("", 2000), TokenVerdict::Invalid);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn persisted_file_never_contains_raw_token() {
        let path = temp_file("leak");
        let mut store = TokenStore::new(path.clone());
        let raw = store.issue("Pixel-9", 1000).expect("签发必须成功");
        let text = fs::read_to_string(&path).expect("落盘文件必须存在");
        // 防泄漏：文件里不得出现明文令牌
        assert!(
            !text.contains(&raw),
            "pairing.json 不得包含明文令牌"
        );
        // 形状：hash 字段 = 64 字符 hex，且不等于明文
        let file: PairingFile = serde_json::from_str(&text).expect("文件应为合法 pairing.json");
        assert_eq!(file.version, PAIRING_FILE_VERSION);
        assert_eq!(file.tokens.len(), 1);
        assert_eq!(file.tokens[0].hash.len(), 64);
        assert_ne!(file.tokens[0].hash, raw);
        assert_eq!(file.tokens[0].label, "Pixel-9");
        assert!(!file.tokens[0].revoked);
        assert!(file.pairing_enabled);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn revoked_token_fails_verification() {
        let path = temp_file("revoke");
        let mut store = TokenStore::new(path.clone());
        let raw = store.issue("d1", 1000).expect("签发必须成功");
        let hash = sha256_hex(raw.as_bytes());
        assert!(store.revoke(&hash), "撤销应命中");
        assert_eq!(store.verify(&raw, 2000), TokenVerdict::Revoked);
        // 撤销后落盘持久化
        let file: PairingFile =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert!(file.tokens[0].revoked);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn revoke_all_and_save() {
        let path = temp_file("revoke-all");
        let mut store = TokenStore::new(path.clone());
        store.issue("a", 1).unwrap();
        store.issue("b", 1).unwrap();
        store.revoke_all();
        assert_eq!(store.records().iter().filter(|t| !t.revoked).count(), 0);
        let file: PairingFile =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert!(!file.pairing_enabled, "全部撤销后配对面视为关闭");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn persistence_roundtrip_across_reload() {
        let path = temp_file("persist");
        let raw = {
            let mut store = TokenStore::new(path.clone());
            store.issue("iPhone", 1000).unwrap()
        };
        // 重启（重新 load）后令牌仍有效
        let mut reloaded = TokenStore::load(&path);
        assert_eq!(reloaded.records().len(), 1);
        assert_eq!(reloaded.verify(&raw, 3000), TokenVerdict::Valid);
        // last_seen 更新
        assert_eq!(reloaded.records()[0].last_seen_at_ms, 3000);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn load_missing_or_corrupt_file_falls_back_to_empty() {
        let missing = temp_file("missing");
        let store = TokenStore::load(&missing);
        assert!(store.is_empty());
        let _ = fs::remove_file(missing);

        let corrupt = temp_file("corrupt");
        fs::write(&corrupt, "{ 这不是合法 JSON").unwrap();
        let store = TokenStore::load(&corrupt);
        assert!(store.is_empty(), "损坏文件应降级为空库");
        let _ = fs::remove_file(corrupt);
    }
}
