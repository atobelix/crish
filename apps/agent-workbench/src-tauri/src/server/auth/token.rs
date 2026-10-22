//! 令牌记录、pairing.json 形状与令牌库（自 server/auth.rs 原样搬迁）

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{PAIRING_FILE_VERSION, TOKEN_BYTES};
use crate::server::ServerError;

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
