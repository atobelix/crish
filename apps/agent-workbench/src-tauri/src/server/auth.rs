//! 令牌哈希存储与 Bearer 鉴权（D2 §7：SHA-256 哈希落 pairing.json）
//!
//! - **签发**：32 字节 CSPRNG → hex 64 字符令牌（明文只返回客户端一次）；
//!   落盘只存 SHA-256 哈希（`config_dir()/pairing.json`，D2 §7.3 形状）
//!   ——文件泄露 ≠ 令牌泄露；
//! - **校验**：`Authorization: Bearer <token>` → SHA-256 → 常量时间比较
//!   + revoked 检查（axum 中间件 [require_bearer_token]；校验失败 → 401）；
//! - **持久化**：原子写（tmp + rename，对齐 `config/persistence.rs` 先例）；
//!   权限位（Unix 0600 / Windows ACL 收紧）与撤销全链归 R1-07。

use std::collections::HashMap;
#[cfg(test)]
use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::Mutex;

use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use conex_types::device::{DeviceErrorCode, ErrorBody};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::server::{now_ms, ServerError, ServerState};

/// 令牌原始字节数（D2 §7.2：32 字节 CSPRNG，hex 64 字符）
// R1-02 备注：R1-07 配对签发消费——dead_code 静音（测试构建保持检查）
#[cfg_attr(not(test), allow(dead_code))]
pub const TOKEN_BYTES: usize = 32;
/// pairing.json 结构版本
// R1-02 备注：R1-07 撤销全链消费——dead_code 静音（测试构建保持检查）
#[cfg_attr(not(test), allow(dead_code))]
pub const PAIRING_FILE_VERSION: u32 = 1;

/// 默认 Nonce 容量上限（LRU 驱逐）
#[cfg(test)]
pub const DEFAULT_NONCE_CAPACITY: usize = 10_000;
/// 默认时钟偏移容忍阈值（300 秒 = 5 分钟）
#[cfg(test)]
pub const DEFAULT_CLOCK_SKEW_MS: u64 = 300_000;
/// 全局时钟透传 Header 名
pub const SERVER_TIME_HEADER: &str = "X-Server-Time-Ms";

/// Nonce 记录条目（幂等响应缓存）
#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NonceEntry {
    /// 接收时间戳（epoch ms）
    pub received_at_ms: u64,
    /// 请求体 SHA-256 哈希
    pub payload_sha256: [u8; 32],
    /// 缓存的 HTTP 状态码
    pub cached_status: u16,
    /// 缓存的响应体字节
    pub cached_body: Vec<u8>,
}

/// Nonce 校验结果
#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NonceCheckResult {
    /// 全新合法请求
    Valid,
    /// 合法弱网重传（相同 Nonce 且 Payload 哈希完全一致）-> 幂等返回缓存响应
    IdempotentRetry { status: u16, body: Vec<u8> },
    /// 恶意重放或参数篡改
    ReplayDetected,
    /// 时钟偏差过大
    ClockSkewTooLarge { diff_ms: u64, max_skew_ms: u64 },
}

#[cfg(test)]
#[derive(Debug)]
struct NonceStoreInner {
    capacity: usize,
    map: HashMap<(String, String), NonceEntry>,
    order: VecDeque<(String, String)>,
}

#[cfg(test)]
impl NonceStoreInner {
    fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            map: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    fn evict_oldest_if_needed(&mut self) {
        while self.map.len() >= self.capacity {
            if let Some(old_key) = self.order.pop_front() {
                self.map.remove(&old_key);
            } else {
                break;
            }
        }
    }

    fn put(&mut self, key: (String, String), entry: NonceEntry) {
        if !self.map.contains_key(&key) {
            self.evict_oldest_if_needed();
            self.order.push_back(key.clone());
        }
        self.map.insert(key, entry);
    }

    fn get(&self, key: &(String, String)) -> Option<&NonceEntry> {
        self.map.get(key)
    }

    fn get_mut(&mut self, key: &(String, String)) -> Option<&mut NonceEntry> {
        self.map.get_mut(key)
    }
}

/// 高级 Nonce 守卫（防重放 + 弱网幂等重传放行）
#[cfg(test)]
pub struct AdvancedNonceGuard {
    clock_skew_ms: u64,
    inner: Mutex<NonceStoreInner>,
}

#[cfg(test)]
impl AdvancedNonceGuard {
    /// 创建 Nonce 守卫
    pub fn new(capacity: usize, clock_skew_ms: u64) -> Self {
        Self {
            clock_skew_ms,
            inner: Mutex::new(NonceStoreInner::new(capacity)),
        }
    }

    /// 获取配置的时钟偏差上限
    pub fn clock_skew_ms(&self) -> u64 {
        self.clock_skew_ms
    }

    /// 校验并记录 Nonce
    pub fn check_and_record(
        &self,
        device_id: &str,
        nonce: &str,
        req_ts: u64,
        now_ms: u64,
        payload_sha256: [u8; 32],
    ) -> NonceCheckResult {
        // 1. 检查时钟偏移
        let diff = req_ts.abs_diff(now_ms);
        if diff > self.clock_skew_ms {
            return NonceCheckResult::ClockSkewTooLarge {
                diff_ms: diff,
                max_skew_ms: self.clock_skew_ms,
            };
        }

        let key = (device_id.to_string(), nonce.to_string());
        let mut store = self.inner.lock().unwrap_or_else(|e| e.into_inner());

        // 2. 检查 Nonce 记录
        if let Some(entry) = store.get(&key) {
            if entry.payload_sha256 == payload_sha256 {
                // 弱网重传完全同构，放行幂等处理
                return NonceCheckResult::IdempotentRetry {
                    status: entry.cached_status,
                    body: entry.cached_body.clone(),
                };
            } else {
                // Nonce 相同但 Payload 被篡改，判定为恶意重放
                return NonceCheckResult::ReplayDetected;
            }
        }

        // 3. 记录全新请求（预占位）
        store.put(
            key,
            NonceEntry {
                received_at_ms: now_ms,
                payload_sha256,
                cached_status: 200,
                cached_body: Vec::new(),
            },
        );

        NonceCheckResult::Valid
    }

    /// 更新响应缓存供后续幂等重试直接返回
    pub fn update_response(&self, device_id: &str, nonce: &str, status: u16, body: &[u8]) {
        let key = (device_id.to_string(), nonce.to_string());
        let mut store = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = store.get_mut(&key) {
            entry.cached_status = status;
            entry.cached_body = body.to_vec();
        }
    }

    /// 查询已缓存的响应
    pub fn get_cached_response(&self, device_id: &str, nonce: &str) -> Option<(u16, Vec<u8>)> {
        let key = (device_id.to_string(), nonce.to_string());
        let store = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        store
            .get(&key)
            .map(|e| (e.cached_status, e.cached_body.clone()))
    }

    /// 当前缓存条目数
    pub fn len(&self) -> usize {
        let store = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        store.map.len()
    }

    /// 是否为空
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
impl Default for AdvancedNonceGuard {
    fn default() -> Self {
        Self::new(DEFAULT_NONCE_CAPACITY, DEFAULT_CLOCK_SKEW_MS)
    }
}

/// HMAC-SHA256 计算（使用 ring::hmac）
#[cfg(test)]
pub fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let s_key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, key);
    let tag = ring::hmac::sign(&s_key, data);
    let mut out = [0u8; 32];
    out.copy_from_slice(tag.as_ref());
    out
}

/// HMAC-SHA256 hex 计算（小写 hex 64 字符）
#[cfg(test)]
pub fn hmac_sha256_hex(key: &[u8], data: &[u8]) -> String {
    hex::encode(hmac_sha256(key, data))
}

/// 常量时间校验 HMAC-SHA256 签名（防时序攻击）
#[cfg(test)]
pub fn verify_hmac_sha256(key: &[u8], data: &[u8], signature_hex: &str) -> bool {
    let s_key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, key);
    let Ok(sig_bytes) = hex::decode(signature_hex) else {
        return false;
    };
    ring::hmac::verify(&s_key, data, &sig_bytes).is_ok()
}

/// HTTP REST 请求签名规范化输入（ADR-01 方案 B）：
/// `canon_http = deviceId || method || path || ts || nonce || body_sha256_hex`
#[cfg(test)]
pub fn canonical_http_signing_payload(
    device_id: &str,
    method: &str,
    path: &str,
    ts: u64,
    nonce: &str,
    body_sha256_hex: &str,
) -> String {
    format!("{device_id}{method}{path}{ts}{nonce}{body_sha256_hex}")
}

/// WebSocket 信封签名规范化输入（ADR-01 方案 B）：
/// `canon_ws = deviceId || ts || nonce || msgId || kind || v || bodyJson`
#[cfg(test)]
pub fn canonical_ws_signing_payload(
    device_id: &str,
    ts: u64,
    nonce: &str,
    msg_id: &str,
    kind: &str,
    v: u32,
    body_json: &str,
) -> String {
    format!("{device_id}{ts}{nonce}{msg_id}{kind}{v}{body_json}")
}

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
    // R1-10 T-01：认证失败计数表（attempted 令牌哈希 → 失败次数；纯计数，
    // 不联动锁定——锁定/审计归 limiter 域，D5 §7.3 计数锚先行可测）
    auth_failures: HashMap<String, u32>,
}

impl TokenStore {
    /// 新建空令牌库（不落盘）
    pub fn new(file: PathBuf) -> Self {
        Self {
            file,
            tokens: Vec::new(),
            auth_failures: HashMap::new(),
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
                        auth_failures: HashMap::new(),
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
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Self::new(path.to_path_buf())
            }
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

    // R1-10 T-01：认证失败计数（D5 §7.3「令牌认证失败（每设备）5 次累计」/
    // T-01「失败计数」的计数锚；纯计数不联动锁定——锁定与审计归 limiter 域）
    /// 记录一次认证失败（按尝试令牌的哈希计键；Revoked/Invalid 均计入）
    pub fn record_failed_attempt(&mut self, raw: &str) {
        let hash = sha256_hex(raw.as_bytes());
        let entry = self.auth_failures.entry(hash).or_insert(0);
        *entry = entry.saturating_add(1);
    }

    /// 指定尝试哈希的认证失败次数（无记录 → 0）
    // R1-10 备注：路由鉴权面测试消费——dead_code 静音（测试构建保持检查）
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn auth_failure_count(&self, hash: &str) -> u32 {
        self.auth_failures.get(hash).copied().unwrap_or(0)
    }

    /// 撤销单个令牌（按哈希匹配；仅未撤销记录可撤销——重复撤销返回
    /// false，语义：撤销 = 解除配对关系，幂等拒绝）
    // R1-02 备注：R1-07 设备撤销消费——dead_code 静音（测试构建保持检查）
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn revoke(&mut self, hash: &str) -> bool {
        let mut found = false;
        for record in &mut self.tokens {
            if constant_time_eq(&record.hash, hash) {
                if record.revoked {
                    return false;
                }
                record.revoked = true;
                found = true;
            }
        }
        if found {
            let _ = self.save();
        }
        found
    }

    /// 重命名设备标签（按哈希匹配；返回是否命中）
    // R1-08 备注：设备管理页改名消费——dead_code 静音（测试构建保持检查）
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn rename(&mut self, hash: &str, new_label: &str) -> bool {
        let mut found = false;
        for record in &mut self.tokens {
            if constant_time_eq(&record.hash, hash) {
                record.label = new_label.to_string();
                found = true;
            }
        }
        if found {
            let _ = self.save();
        }
        found
    }
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

    /// 有效令牌数量（仅未撤销）。R1-07 状态面/回 Loopback 判断消费——
    /// 撤销 = 解除配对，已撤销不计。
    pub fn token_count(&self) -> usize {
        self.tokens.iter().filter(|r| !r.revoked).count()
    }

    /// 全部令牌哈希（含已撤销）。R1-07 撤销全链消费。
    pub fn all_hashes(&self) -> Vec<String> {
        self.tokens
            .iter()
            .map(|record| record.hash.clone())
            .collect()
    }

    /// 设备列表（配对管理面；id = 哈希截断 12 字符展示，不泄露原文）。
    /// 仅返回未撤销设备——撤销 = 解除配对关系，列表即移除。
    /// R1-07 list_devices 消费。
    pub fn devices(&self) -> Vec<crate::server::pairing::DeviceInfo> {
        self.tokens
            .iter()
            .filter(|record| !record.revoked)
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
    a.bytes()
        .zip(b.bytes())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

/// Bearer 令牌校验中间件（D2 §7.1 零信任：除 /v1/info 与 /v1/pair 外全部
/// 接口必须携带有效令牌；校验失败 → 401 + ErrorBody 载荷；全部响应透传 X-Server-Time-Ms）
pub async fn require_bearer_token(
    State(state): State<ServerState>,
    request: Request,
    next: Next,
) -> Response {
    let now = now_ms();
    let unauthorized = |code: DeviceErrorCode, message: &str| -> Response {
        let mut resp = (
            StatusCode::UNAUTHORIZED,
            Json(ErrorBody::new(code, message)),
        )
            .into_response();
        if let Ok(val) = axum::http::HeaderValue::from_str(&now.to_string()) {
            resp.headers_mut().insert(SERVER_TIME_HEADER, val);
        }
        resp
    };
    let Some(token) = bearer_token(&request) else {
        return unauthorized(
            DeviceErrorCode::AuthBadSignature,
            "缺少 Authorization: Bearer <token>",
        );
    };
    let verdict = {
        let tokens = state.tokens();
        let mut guard = tokens.lock().unwrap_or_else(|e| e.into_inner());
        let verdict = guard.verify(token, now);
        if verdict != TokenVerdict::Valid {
            // R1-10 T-01：认证失败计数（伪造端/失窃令牌重放均计入；
            // 纯计数不联动锁定——锁定/审计归 limiter 域）
            guard.record_failed_attempt(token);
        }
        verdict
    };
    let mut response = match verdict {
        TokenVerdict::Valid => next.run(request).await,
        TokenVerdict::Revoked => unauthorized(
            DeviceErrorCode::AuthDeviceRevoked,
            "令牌已被撤销，请重新配对",
        ),
        TokenVerdict::Invalid => unauthorized(DeviceErrorCode::AuthBadSignature, "令牌校验失败"),
    };
    if let Ok(val) = axum::http::HeaderValue::from_str(&now.to_string()) {
        response.headers_mut().insert(SERVER_TIME_HEADER, val);
    }
    response
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
        assert!(!text.contains(&raw), "pairing.json 不得包含明文令牌");
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
        let file: PairingFile = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
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
        let file: PairingFile = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
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

    // ── R1-10 T-01：认证失败计数 ──

    /// T-01 失败计数：伪造令牌（哈希不匹配）每次认证失败按尝试哈希累计；
    /// 合法令牌校验成功不产生计数（计数器只对失败路径开火）
    #[test]
    fn t01_failed_attempts_counted_per_forged_token() {
        let path = temp_file("t01-fail-count");
        let mut store = TokenStore::new(path.clone());
        store.issue("d1", 1000).expect("签发必须成功");

        let forged = "f".repeat(64);
        let forged_hash = sha256_hex(forged.as_bytes());
        // 伪造令牌三连失败：计数必须递增（防爆破的计数锚）
        for expected in 1..=3 {
            assert_eq!(
                store.verify(&forged, 2000),
                TokenVerdict::Invalid,
                "伪造令牌必须认证失败"
            );
            store.record_failed_attempt(&forged);
            assert_eq!(
                store.auth_failure_count(&forged_hash),
                expected,
                "第 {expected} 次失败后计数应为 {expected}"
            );
        }
        // 合法令牌校验成功：不产生失败计数
        let legit = store.issue("d2", 2500).expect("签发必须成功");
        assert_eq!(store.verify(&legit, 3000), TokenVerdict::Valid);
        assert_eq!(
            store.auth_failure_count(&forged_hash),
            3,
            "合法校验不得改写伪造令牌的失败计数"
        );
        let _ = fs::remove_file(path);
    }

    // ── R1-10 T-11：撤销即时性 ──

    /// T-11 撤销即时性：撤销立即生效（verify → Revoked）；重启加载后旧令牌
    /// 重放/重连仍被拒（撤销持久化，注册表删除 ≠ 只杀活动会话）
    #[test]
    fn t11_revoked_token_never_valid_again_across_reload() {
        let path = temp_file("t11-reload");
        let mut store = TokenStore::new(path.clone());
        let raw = store.issue("d1", 1000).expect("签发必须成功");
        let hash = sha256_hex(raw.as_bytes());
        assert_eq!(store.verify(&raw, 1500), TokenVerdict::Valid);

        // 撤销 → 立即可见 Revoked
        assert!(store.revoke(&hash), "撤销应命中");
        assert_eq!(store.verify(&raw, 2000), TokenVerdict::Revoked);

        // 重启加载（模拟服务重启后的重连请求）：旧令牌仍被拒
        let mut reloaded = TokenStore::load(&path);
        assert_eq!(reloaded.verify(&raw, 2500), TokenVerdict::Revoked);

        // 撤销后新签发令牌不影响旧令牌状态（旧令牌不会被复活）
        let new_raw = reloaded.issue("d2", 3000).expect("签发必须成功");
        assert_eq!(reloaded.verify(&new_raw, 3100), TokenVerdict::Valid);
        assert_eq!(reloaded.verify(&raw, 3200), TokenVerdict::Revoked);
        let _ = fs::remove_file(path);
    }

    /// T-11 撤销即时性：撤销后校验失败（Revoked）不刷新 last_seen——撤销
    /// 设备的「活性」随时间冻结，设备列表/审计不再把它当活跃设备
    #[test]
    fn t11_revoked_verification_does_not_touch_last_seen() {
        let path = temp_file("t11-last-seen");
        let mut store = TokenStore::new(path.clone());
        let raw = store.issue("d1", 1000).expect("签发必须成功");
        assert_eq!(store.verify(&raw, 2000), TokenVerdict::Valid);
        assert_eq!(store.records()[0].last_seen_at_ms, 2000);

        let hash = sha256_hex(raw.as_bytes());
        assert!(store.revoke(&hash));
        assert_eq!(store.verify(&raw, 3000), TokenVerdict::Revoked);
        assert_eq!(
            store.records()[0].last_seen_at_ms,
            2000,
            "撤销后的校验失败不得刷新 last_seen（活性冻结）"
        );
        let _ = fs::remove_file(path);
    }

    /// T-11 撤销即时性：改名（rename）不得复活已撤销令牌——撤销状态与
    /// 设备标签变更相互独立，重连校验仍走 Revoked 分支
    #[test]
    fn t11_rename_after_revoke_keeps_revoked() {
        let path = temp_file("t11-rename");
        let mut store = TokenStore::new(path.clone());
        let raw = store.issue("d1", 1000).expect("签发必须成功");
        let hash = sha256_hex(raw.as_bytes());
        assert!(store.revoke(&hash));
        assert!(store.rename(&hash, "新名字"), "改名应命中");
        assert_eq!(
            store.verify(&raw, 2000),
            TokenVerdict::Revoked,
            "改名不得复活已撤销令牌"
        );
        assert_eq!(store.records()[0].label, "新名字");
        let _ = fs::remove_file(path);
    }

    // ── Nonce 幂等表与 HMAC-SHA256 测试 ──

    #[test]
    fn adversarial_nonce_idempotent_retry_and_clock_sync() {
        let guard = AdvancedNonceGuard::new(1000, 300_000);
        let now = 1_770_800_000_000u64;
        let payload_hash = [0xabu8; 32];

        // 1. 首次合法请求
        let res1 = guard.check_and_record("dev-1", "nonce-100", now, now, payload_hash);
        assert!(matches!(res1, NonceCheckResult::Valid));
        guard.update_response("dev-1", "nonce-100", 200, b"{\"status\":\"ok\"}");

        // 2. 弱网丢包后原样重传 -> 必须幂等返回缓存响应，严禁报错 401
        let res2 = guard.check_and_record("dev-1", "nonce-100", now, now + 2000, payload_hash);
        match res2 {
            NonceCheckResult::IdempotentRetry { status, body } => {
                assert_eq!(status, 200);
                assert_eq!(body, b"{\"status\":\"ok\"}");
            }
            _ => panic!("合法弱网重传必须被判定为 IdempotentRetry"),
        }

        // 3. 恶意篡改 Payload 的相同 Nonce -> 必须拦截
        let tampered_hash = [0xcd; 32];
        let res3 = guard.check_and_record("dev-1", "nonce-100", now, now + 3000, tampered_hash);
        assert!(matches!(res3, NonceCheckResult::ReplayDetected));

        // 4. 时钟偏差 > 300s -> 拦截并返回 ClockSkewTooLarge
        let res4 = guard.check_and_record("dev-1", "nonce-101", now + 350_000, now, payload_hash);
        assert!(matches!(res4, NonceCheckResult::ClockSkewTooLarge { .. }));
    }

    #[test]
    fn adversarial_weak_network_loss_jitter_and_600s_clock_skew_self_healing() {
        let guard = AdvancedNonceGuard::new(1000, DEFAULT_CLOCK_SKEW_MS); // 300_000ms threshold
        let server_base_time_ms = 1_770_800_000_000u64;

        // 1. 模拟客户端存在 600s (600,000ms) 时钟偏差（例如客户端本地时间过快 600s）
        let client_skew_ms = 600_000u64;
        let mut client_local_time_ms = server_base_time_ms + client_skew_ms;
        let payload_hash = [0x5au8; 32];

        // 未进行时钟对齐前发送请求 -> 因时钟偏差 600s > 300s 被守卫拦截，返回 ClockSkewTooLarge
        let unaligned_res = guard.check_and_record(
            "device-mobile-01",
            "nonce-unaligned-001",
            client_local_time_ms,
            server_base_time_ms,
            payload_hash,
        );
        match unaligned_res {
            NonceCheckResult::ClockSkewTooLarge {
                diff_ms,
                max_skew_ms,
            } => {
                assert_eq!(diff_ms, 600_000);
                assert_eq!(max_skew_ms, 300_000);
            }
            _ => panic!("未校准时钟偏差 600s 必须被判定为 ClockSkewTooLarge"),
        }

        // 2. 模拟客户端通过免鉴权 GET /v1/hello 获得服务端时钟 server_time_ms 进行单向时钟对齐
        // 客户端计算 offset = server_time_ms - client_local_time_ms (-600,000ms)
        let simulated_hello_server_time = server_base_time_ms;
        let clock_offset_ms: i64 = simulated_hello_server_time as i64 - client_local_time_ms as i64;
        assert_eq!(clock_offset_ms, -600_000);

        // 3. 模拟弱网环境：30% 丢包率、高达 500ms 抖动（Jitter）、100 次业务请求与重传
        let mut total_attempts = 0;
        let mut total_idempotent_hits = 0;
        let mut total_first_valids = 0;
        let false_positive_401_errors = 0;

        for req_idx in 0..100 {
            let nonce = format!("nonce-tx-{req_idx:04}");
            let req_payload_hash = {
                let mut h = [0u8; 32];
                h[0] = (req_idx & 0xff) as u8;
                h[1] = ((req_idx >> 8) & 0xff) as u8;
                h[2] = 0xee;
                h
            };

            // 客户端推进本地时钟并叠加 jitter（0..500ms）
            client_local_time_ms += 100;
            let jitter_ms = ((req_idx * 37) % 500) as u64; // 0..500ms 伪随机抖动

            // 客户端发送时使用单向对齐后的时间戳
            let aligned_req_ts = (client_local_time_ms as i64 + clock_offset_ms) as u64 + jitter_ms;
            let current_server_now = server_base_time_ms + (req_idx as u64 * 100) + (jitter_ms / 2);

            // 模拟 30% 丢包率（当 req_idx % 10 in [2, 5, 8] 时模拟网络丢包，触发客户端 1~2 次重传）
            let will_drop_packet =
                (req_idx % 10 == 2) || (req_idx % 10 == 5) || (req_idx % 10 == 8);

            // 首次请求到达服务端
            total_attempts += 1;
            let check1 = guard.check_and_record(
                "device-mobile-01",
                &nonce,
                aligned_req_ts,
                current_server_now,
                req_payload_hash,
            );

            match check1 {
                NonceCheckResult::Valid => {
                    total_first_valids += 1;
                    let resp_body =
                        format!("{{\"runId\":\"run-{req_idx}\",\"status\":\"success\"}}");
                    guard.update_response("device-mobile-01", &nonce, 200, resp_body.as_bytes());
                }
                other => {
                    panic!("校准后首次请求必须被放行为 Valid, 实际为: {other:?}");
                }
            }

            // 若发生弱网丢包，客户端发起 1~2 次幂等重传（带 500ms 抖动与相同 Nonce）
            if will_drop_packet {
                let retransmission_count = (req_idx % 2) + 1; // 1 或 2 次重传
                for retry in 1..=retransmission_count {
                    total_attempts += 1;
                    let retry_jitter_ms = ((req_idx * 41 + retry * 73) % 500) as u64;
                    let retry_server_now = current_server_now + 500 + retry_jitter_ms;

                    // 客户端重传时保持原 Nonce 与原 Payload 哈希，时间戳保持对齐
                    let retry_req_ts = aligned_req_ts;

                    let retry_check = guard.check_and_record(
                        "device-mobile-01",
                        &nonce,
                        retry_req_ts,
                        retry_server_now,
                        req_payload_hash,
                    );

                    match retry_check {
                        NonceCheckResult::IdempotentRetry { status, body } => {
                            total_idempotent_hits += 1;
                            assert_eq!(status, 200);
                            let expected_body =
                                format!("{{\"runId\":\"run-{req_idx}\",\"status\":\"success\"}}");
                            assert_eq!(body, expected_body.as_bytes());
                        }
                        other => {
                            panic!("合法幂等重传严禁报错或失效，实际结果: {other:?}");
                        }
                    }
                }
            }
        }

        // 4. 关键指标与断言
        assert_eq!(total_first_valids, 100);
        assert_eq!(total_idempotent_hits, 40); // 30 个丢包请求产生 40 次幂等重传命中
        assert_eq!(total_attempts, 140);
        assert_eq!(false_positive_401_errors, 0, "断言弱网重传 0 误报 401");
    }

    #[test]
    fn nonce_guard_capacity_eviction_lru() {
        let guard = AdvancedNonceGuard::new(3, 300_000);
        let now = 1_000_000u64;

        assert!(matches!(
            guard.check_and_record("d1", "n1", now, now, [1u8; 32]),
            NonceCheckResult::Valid
        ));
        assert!(matches!(
            guard.check_and_record("d1", "n2", now, now, [2u8; 32]),
            NonceCheckResult::Valid
        ));
        assert!(matches!(
            guard.check_and_record("d1", "n3", now, now, [3u8; 32]),
            NonceCheckResult::Valid
        ));
        assert_eq!(guard.len(), 3);

        // 插入第 4 个，淘汰最旧的 n1
        assert!(matches!(
            guard.check_and_record("d1", "n4", now, now, [4u8; 32]),
            NonceCheckResult::Valid
        ));
        assert_eq!(guard.len(), 3);

        // n1 已被驱逐，再次进入视为全新 Valid 请求
        assert!(matches!(
            guard.check_and_record("d1", "n1", now, now, [1u8; 32]),
            NonceCheckResult::Valid
        ));
    }

    #[test]
    fn hmac_helpers_smoke() {
        let key = b"test-secret-key-123456789012345";
        let data = b"payload to be signed";
        let raw_sig = hmac_sha256(key, data);
        assert_eq!(raw_sig.len(), 32);
        let sig = hmac_sha256_hex(key, data);
        assert_eq!(sig.len(), 64);
        assert!(verify_hmac_sha256(key, data, &sig));
        assert!(!verify_hmac_sha256(key, b"different-data", &sig));
        assert!(!verify_hmac_sha256(b"wrong-key", data, &sig));
        assert!(!verify_hmac_sha256(key, data, "invalid-hex"));

        let canon_http =
            canonical_http_signing_payload("dev-1", "POST", "/v1/runs", 1000, "nonce-1", "abcdef");
        assert_eq!(canon_http, "dev-1POST/v1/runs1000nonce-1abcdef");

        let canon_ws =
            canonical_ws_signing_payload("dev-1", 1000, "nonce-1", "msg-1", "runTask", 1, "{}");
        assert_eq!(canon_ws, "dev-11000nonce-1msg-1runTask1{}");
    }

    #[test]
    fn advanced_nonce_guard_methods() {
        let guard = AdvancedNonceGuard::default();
        assert_eq!(guard.clock_skew_ms(), DEFAULT_CLOCK_SKEW_MS);
        assert!(guard.is_empty());
        guard.check_and_record("d1", "n1", 1000, 1000, [0u8; 32]);
        assert!(!guard.is_empty());
        guard.update_response("d1", "n1", 200, b"ok");
        let cached = guard.get_cached_response("d1", "n1");
        assert_eq!(cached, Some((200, b"ok".to_vec())));

        assert_eq!(TOKEN_BYTES, 32);
        assert_eq!(PAIRING_FILE_VERSION, 1);
        assert_eq!(SERVER_TIME_HEADER, "X-Server-Time-Ms");
    }
}
