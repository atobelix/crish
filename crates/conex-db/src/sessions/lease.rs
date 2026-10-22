//! 全局恢复排他租约（session_meta 键承载）：抢占 / 续期 / 释放。

use crate::{DbFailure, DbFailureKind, LocalDb};
use rusqlite::OptionalExtension;

impl LocalDb {
    // ===== 全局恢复排他租约（04 详案 §6.2：session_meta 键承载，零 DDL） =====

    /// 原子抢占全局恢复排他租约（TTL 默认 [`RECOVERY_LEASE_TTL_MS`] = 30s）。
    ///
    /// 经 [`Self::update_session_meta`] 的写 Actor 串行化闭包实现 CAS：
    /// 租约不存在或已过期 → 抢占成功（写入 `instance_id` + 过期戳）；
    /// 租约未过期且被他人持有 → 拒绝（返回 `false`，调用方应安全跳过
    /// 事件合成、以只读模式加载）。同一实例未过期时重抢同样被拒——
    /// 续期请走 [`Self::renew_recovery_lease`]。
    pub fn try_acquire_recovery_lease(
        &self,
        instance_id: &str,
        ttl_ms: Option<i64>,
    ) -> Result<bool, DbFailure> {
        let instance_id = instance_id.to_string();
        let ttl = ttl_ms.unwrap_or(crate::RECOVERY_LEASE_TTL_MS);
        let result = self.update_session_meta(crate::RECOVERY_LEASE_KEY, move |current| {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            if let Some(val_str) = current {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(val_str) {
                    if let Some(exp) = v.get("expiresAt").and_then(|e| e.as_i64()) {
                        if now_ms < exp {
                            // 租约未过期且被他人持有：抢占拒绝
                            return None;
                        }
                    }
                }
            }
            let lease_payload = serde_json::json!({
                "instanceId": instance_id,
                "acquiredAt": now_ms,
                "expiresAt": now_ms + ttl,
            });
            Some(lease_payload.to_string())
        })?;
        Ok(result.is_some())
    }

    /// 续期自己持有的全局恢复租约（TTL 默认 30s）。
    /// 仅当当前持有者为 `instance_id` 时续期成功；租约不存在 / 已易主 /
    /// 已过期 → `false`（应重新 [`Self::try_acquire_recovery_lease`]）。
    pub fn renew_recovery_lease(
        &self,
        instance_id: &str,
        ttl_ms: Option<i64>,
    ) -> Result<bool, DbFailure> {
        let instance_id = instance_id.to_string();
        let ttl = ttl_ms.unwrap_or(crate::RECOVERY_LEASE_TTL_MS);
        let result = self.update_session_meta(crate::RECOVERY_LEASE_KEY, move |current| {
            let val_str = current?;
            let v: serde_json::Value = serde_json::from_str(val_str).ok()?;
            if v.get("instanceId").and_then(|e| e.as_str()) != Some(instance_id.as_str()) {
                return None;
            }
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            let lease_payload = serde_json::json!({
                "instanceId": instance_id,
                "acquiredAt": v.get("acquiredAt").and_then(|e| e.as_i64()).unwrap_or(now_ms),
                "expiresAt": now_ms + ttl,
            });
            Some(lease_payload.to_string())
        })?;
        Ok(result.is_some())
    }

    /// 释放自己持有的全局恢复租约（条件删除：仅持有者匹配时清除）。
    /// 返回 `true` 表示本次确实删除了租约行。
    pub fn release_recovery_lease(&self, instance_id: &str) -> Result<bool, DbFailure> {
        let instance_id = instance_id.to_string();
        self.write_blocking(move |conn| {
            let current: Option<String> = conn
                .query_row(
                    "SELECT value FROM session_meta WHERE key = ?1",
                    rusqlite::params![crate::RECOVERY_LEASE_KEY],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|e| DbFailure {
                    message: format!("release_recovery_lease_read: {e}"),
                    kind: DbFailureKind::Other("release_recovery_lease".to_string()),
                })?;
            let holder_matches = current
                .as_deref()
                .and_then(|val_str| serde_json::from_str::<serde_json::Value>(val_str).ok())
                .and_then(|v| {
                    v.get("instanceId")
                        .and_then(|e| e.as_str())
                        .map(|s| s == instance_id)
                })
                .unwrap_or(false);
            if !holder_matches {
                return Ok(false);
            }
            conn.execute(
                "DELETE FROM session_meta WHERE key = ?1",
                rusqlite::params![crate::RECOVERY_LEASE_KEY],
            )
            .map_err(|e| DbFailure {
                message: format!("release_recovery_lease_delete: {e}"),
                kind: DbFailureKind::Other("release_recovery_lease".to_string()),
            })?;
            Ok(true)
        })
    }
}
