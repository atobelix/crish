//! 会话内 batch token 占用 / 释放（SD-32 从 `note_types` 切开）
//!
//! 轻量真实实现；**≠ EL-05**；**≠ W6-E 满关**。

use super::error::NoteBackendError;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 默认 batch token TTL（会话内轻量过期）
pub const DEFAULT_BATCH_TOKEN_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Debug)]
struct BatchTokenEntry {
    expires_at: Instant,
}

/// 会话内 `batch_id` 占用与释放（轻量真实实现）
///
/// - [`Self::acquire`]：登记 batch_id，重复占用视为刷新 TTL
/// - [`Self::validate`]：存在且未过期则 Ok；未知 → Invalid；过期 → Expired 并剔除
/// - [`Self::release`]：主动释放
#[derive(Debug, Default)]
pub struct NoteBatchTokens {
    inner: Mutex<HashMap<String, BatchTokenEntry>>,
    ttl: Duration,
}

impl NoteBatchTokens {
    /// 使用默认 TTL 构造
    pub fn new() -> Self {
        Self::with_ttl(DEFAULT_BATCH_TOKEN_TTL)
    }

    /// 自定义 TTL（测试可注入短过期）
    pub fn with_ttl(ttl: Duration) -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            ttl,
        }
    }

    /// 占用 / 刷新 batch_id
    pub fn acquire(&self, batch_id: &str) -> Result<(), NoteBackendError> {
        if batch_id.trim().is_empty() {
            return Err(NoteBackendError::BatchTokenInvalid(
                "batch_id must be non-empty".into(),
            ));
        }
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        map.insert(
            batch_id.to_string(),
            BatchTokenEntry {
                expires_at: Instant::now() + self.ttl,
            },
        );
        Ok(())
    }

    /// 校验 batch_id：存在且未过期
    pub fn validate(&self, batch_id: &str) -> Result<(), NoteBackendError> {
        if batch_id.trim().is_empty() {
            return Err(NoteBackendError::BatchTokenInvalid(
                "batch_id must be non-empty".into(),
            ));
        }
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        match map.get(batch_id) {
            Some(entry) if entry.expires_at > Instant::now() => Ok(()),
            Some(_) => {
                map.remove(batch_id);
                Err(NoteBackendError::BatchTokenExpired(format!(
                    "batch_id expired: {batch_id}"
                )))
            }
            None => Err(NoteBackendError::BatchTokenInvalid(format!(
                "batch_id not acquired: {batch_id}"
            ))),
        }
    }

    /// 释放 batch_id（幂等）
    pub fn release(&self, batch_id: &str) {
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        map.remove(batch_id);
    }

    /// 当前有效（未过期）token 数（测试用）
    pub fn active_count(&self) -> usize {
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        map.retain(|_, e| e.expires_at > now);
        map.len()
    }
}
