//! Nonce 幂等表与防重放守卫（自 server/auth.rs 原样搬迁）

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::{DEFAULT_CLOCK_SKEW_MS, DEFAULT_NONCE_CAPACITY};

/// Nonce 记录条目（幂等响应缓存）
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

#[derive(Debug)]
struct NonceStoreInner {
    capacity: usize,
    map: HashMap<(String, String), NonceEntry>,
    order: VecDeque<(String, String)>,
}

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

    #[allow(dead_code)]
    fn get_mut(&mut self, key: &(String, String)) -> Option<&mut NonceEntry> {
        self.map.get_mut(key)
    }
}

/// 高级 Nonce 守卫（防重放 + 弱网幂等重传放行）
pub struct AdvancedNonceGuard {
    clock_skew_ms: u64,
    inner: Mutex<NonceStoreInner>,
}

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
    #[allow(dead_code)]
    pub fn update_response(&self, device_id: &str, nonce: &str, status: u16, body: &[u8]) {
        let key = (device_id.to_string(), nonce.to_string());
        let mut store = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = store.get_mut(&key) {
            entry.cached_status = status;
            entry.cached_body = body.to_vec();
        }
    }

    /// 查询已缓存的响应
    #[allow(dead_code)]
    pub fn get_cached_response(&self, device_id: &str, nonce: &str) -> Option<(u16, Vec<u8>)> {
        let key = (device_id.to_string(), nonce.to_string());
        let store = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        store
            .get(&key)
            .map(|e| (e.cached_status, e.cached_body.clone()))
    }

    /// 当前缓存条目数
    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        let store = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        store.map.len()
    }

    /// 是否为空
    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Default for AdvancedNonceGuard {
    fn default() -> Self {
        Self::new(DEFAULT_NONCE_CAPACITY, DEFAULT_CLOCK_SKEW_MS)
    }
}
