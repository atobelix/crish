//! 审批待发表持久化（R3-01 部分 3：PendingDelivery 队列桥接 SQLite）
//!
//! 规格真源：
//! - `docs/multi-device/plans/D7-push-notifications.md` §8.2（`push_pending_approvals`
//!   表——审批待发表 + 重推阶梯）、§9.3（重推级：**桌面端崩溃/重启不丢审批推送**）、
//!   §3.3 S1（重推阶梯：第 1 次 +15min，第 2 次 +60min，之后每小时一次，
//!   最多 5 次）、§8.4-5（审批待发表可被重放 → 重推阶梯用 approval_id 幂等——
//!   同 id 不重复计数）；
//! - `docs/multi-device/plans/M8-push-release.md` §3.4.4（审批重推规则表）与
//!   R3-03a 的 [super::vendor::RETRY_LADDER_DELAYS] 阶梯常量。
//!
//! 表结构（任务书口径；对齐 D7 §8.2 语义，列名以任务书为准）：
//!
//! ```sql
//! CREATE TABLE IF NOT EXISTS push_pending_approvals (
//!     device_key    TEXT NOT NULL,    -- 目标设备（设备令牌哈希）
//!     approval_id   TEXT NOT NULL,    -- 幂等键（D7 §8.4-5：同 id 不重复计数；
//!                                     --   S1/S2 = params.toolCallId，
//!                                     --   其余待发 = message.dedupe_key）
//!     payload       TEXT NOT NULL,    -- PushMessage JSON（完整载荷，
//!                                     --   重启恢复时原样反序列化重推）
//!     marked_at     INTEGER NOT NULL, -- 标记时刻（epoch ms；≈ D7 created_at）
//!     retry_count   INTEGER NOT NULL, -- 已完成的重推次数（阶梯下标）
//!     next_retry_at INTEGER NOT NULL  -- 下一次发送时刻（epoch ms；入队 =
//!                                     --   marked_at（立即到期），每次 take
//!                                     --   后按 [super::vendor::RETRY_LADDER_DELAYS]
//!                                     --   推进；封顶删除 = 停止重推）
//! );
//! ```
//!
//! D7 §8.2 对应注记：`tool_call_id` / `session_id` / `summary` / `title` /
//! `body` / `target` 等审批字段全部承载于 `payload`（[PushMessage] serde
//! 契约），恢复时不查库即可原样重推；`created_at` ≈ `marked_at`；
//! `resolved`（停止重推）语义由 [PendingApprovalStore::remove]（送达清库 /
//! approval-resolved 停止——装配层接线）承载。
//!
//! 队列桥接（[crate::push::pusher::PushDispatcher] 注入模式，
//! [crate::push::pusher::PushDispatcher::with_pending_store]）：
//! - **入队落库**：dispatcher 标记 pending 时 [PendingApprovalStore::enqueue]
//!   （幂等：同 (device_key, approval_id) 不重复计数；落库失败降级内存队列，
//!   宁可待发不丢 D7 §6.6）；
//! - **take_pending 从库读**：dispatcher 周期消费时
//!   [PendingApprovalStore::take_due] 取走到期行并推进阶梯（retry_count + 1，
//!   next_retry_at = now + 阶梯间隔，封顶删除——D7「最多 5 次」）；重启后
//!   内存队列为空 → 到期行自动恢复（D7 §9.3「桌面端重启后扫描恢复」）；
//! - **送达清库**：[PendingApprovalStore::remove]（R3-03 消费装配接线：
//!   厂商受理 / DeviceNotRegistered / 永久失败 / 审批已解决均走此面；
//!   dispatcher 侧入口 [crate::push::pusher::PushDispatcher::mark_delivered]）；
//! - 线程模型：rusqlite Connection 非 Send/Sync，包 [Arc<Mutex>]（对齐
//!   [crate::push::dedupe::SqliteDedupeBackend] 的 single-writer 先例）；
//! - 落库失败一律 `tracing::warn` 降级（不 panic、不阻塞决策管线）。

use std::sync::{Arc, Mutex};

use super::pusher::PendingDelivery;
use super::schema::PushMessage;
use super::vendor::next_retry_delay;

/// 待发表主键前缀推导：S1/S2 审批键 = `params.toolCallId`（D7 §8.4-5
/// approval_id 幂等），其余待发 = `message.dedupe_key`（去重键即幂等键）。
pub fn approval_id_for(message: &PushMessage) -> String {
    message
        .target
        .params
        .get("toolCallId")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| message.dedupe_key.clone())
}

/// 待发表一行（take_due 产出；`retry_count` 为该行**本次取走后**的已推进值）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredPendingApproval {
    /// 目标设备（设备令牌哈希）
    pub device_key: String,
    /// 幂等键（[approval_id_for]）
    pub approval_id: String,
    /// 完整推送消息（payload JSON 反序列化还原）
    pub message: PushMessage,
    /// 标记时刻（epoch ms）
    pub marked_at_ms: u64,
    /// 已完成的重推次数（取走后 = 旧值 + 1；封顶删除的行不产出）
    pub retry_count: u64,
    /// 下一次发送时刻（epoch ms；取走后 = now + 阶梯间隔）
    pub next_retry_at_ms: u64,
}

impl StoredPendingApproval {
    /// 还原为待发条目（[crate::push::pusher::PushDispatcher::take_pending]
    /// 与 R3-03 厂商消费的输入形状）
    pub fn into_delivery(self) -> PendingDelivery {
        PendingDelivery {
            device_key: self.device_key,
            message: self.message,
            marked_at_ms: self.marked_at_ms,
        }
    }
}

/// SQLite 审批待发表（R3-01 部分 3：pending 队列持久化 + 重推阶梯）
///
/// 与 [crate::push::dedupe::SqliteDedupeBackend] 同栈同风格：注入
/// [rusqlite::Connection]（single-writer Arc<Mutex>），公开方法 infallible——
/// 落库失败 warn 降级，不 panic 不阻塞。
#[derive(Debug)]
pub struct PendingApprovalStore {
    conn: Arc<Mutex<rusqlite::Connection>>,
}

impl PendingApprovalStore {
    /// 建表 DDL（幂等；缺表自动创建）
    const CREATE_TABLE_SQL: &'static str = "\
        CREATE TABLE IF NOT EXISTS push_pending_approvals (\
            device_key    TEXT NOT NULL,\
            approval_id   TEXT NOT NULL,\
            payload       TEXT NOT NULL,\
            marked_at     INTEGER NOT NULL,\
            retry_count   INTEGER NOT NULL,\
            next_retry_at INTEGER NOT NULL,\
            PRIMARY KEY (device_key, approval_id)\
        )";

    /// 绑定连接构造（自动建表）
    pub fn new(conn: rusqlite::Connection) -> rusqlite::Result<Self> {
        conn.execute_batch(Self::CREATE_TABLE_SQL)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// 内存库构造（测试用；对齐 [crate::push::dedupe::SqliteDedupeBackend::
    /// open_in_memory] 测试等价）
    pub fn open_in_memory() -> rusqlite::Result<Self> {
        Self::new(rusqlite::Connection::open_in_memory()?)
    }

    /// 入队落库（幂等：同 (device_key, approval_id) 已存在 = 命中返回 true，
    /// 不重复计数——D7 §8.4-5；初始 retry_count = 0，next_retry_at = 标记
    /// 时刻（立即到期，首次发送不等待阶梯）。
    ///
    /// 返回 `true` = 条目已在库（新插入或幂等命中）；`false` = 落库失败
    /// （调用方降级内存队列，宁可待发不丢）。
    pub fn enqueue(&self, device_key: &str, message: &PushMessage, marked_at_ms: u64) -> bool {
        let approval_id = approval_id_for(message);
        let payload = match serde_json::to_string(message) {
            Ok(p) => p,
            Err(error) => {
                tracing::warn!(target: "push", approval_id = %approval_id, error = ?error, "审批待发表 payload 序列化失败");
                return false;
            }
        };
        let conn = match self.conn.lock() {
            Ok(c) => c,
            Err(_) => {
                tracing::warn!(target: "push", "审批待发表锁损坏，跳过落库");
                return false;
            }
        };
        match conn.execute(
            "INSERT OR IGNORE INTO push_pending_approvals \
             (device_key, approval_id, payload, marked_at, retry_count, next_retry_at) \
             VALUES (?1, ?2, ?3, ?4, 0, ?4)",
            rusqlite::params![device_key, approval_id, payload, marked_at_ms as i64],
        ) {
            Ok(_) => true,
            Err(error) => {
                tracing::warn!(target: "push", device_key = %device_key, approval_id = %approval_id, error = %error, "审批待发表落库失败");
                false
            }
        }
    }

    /// 取走到期行（next_retry_at <= now）并推进重推阶梯
    /// （[super::vendor::RETRY_LADDER_DELAYS]：下标 = 已完成的重推次数，
    /// 推进后 retry_count + 1，next_retry_at = now + 间隔；第 5 次重推后
    /// 阶梯封顶（[next_retry_delay] 返回 None）→ 删除该行 = 停止重推，
    /// D7 §3.3 S1「最多 5 次」）。
    ///
    /// 行在取走后**保留**在库中（阶梯已推进）——送达后由 [Self::remove]
    /// 清库；进程崩溃时未送达行按新 next_retry_at 恢复，不丢审批推送。
    pub fn take_due(&self, now_ms: u64) -> Vec<StoredPendingApproval> {
        let conn = match self.conn.lock() {
            Ok(c) => c,
            Err(_) => {
                tracing::warn!(target: "push", "审批待发表锁损坏，跳过到期扫描");
                return Vec::new();
            }
        };
        let rows = {
            let mut stmt = match conn.prepare(
                "SELECT device_key, approval_id, payload, marked_at, retry_count, next_retry_at \
                 FROM push_pending_approvals WHERE next_retry_at <= ?1 \
                 ORDER BY next_retry_at, marked_at",
            ) {
                Ok(s) => s,
                Err(error) => {
                    tracing::warn!(target: "push", error = %error, "审批待发表到期查询失败");
                    return Vec::new();
                }
            };
            let mapped = stmt.query_map(rusqlite::params![now_ms as i64], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)? as u64,
                    row.get::<_, i64>(4)? as u64,
                    row.get::<_, i64>(5)? as u64,
                ))
            });
            match mapped.and_then(|iter| iter.collect::<Result<Vec<_>, _>>()) {
                Ok(rows) => rows,
                Err(error) => {
                    tracing::warn!(target: "push", error = %error, "审批待发表到期行读取失败");
                    return Vec::new();
                }
            }
        };

        let mut due = Vec::new();
        for (device_key, approval_id, payload, marked_at_ms, retry_count, _) in rows {
            // payload 损坏行：无法恢复 → 删除并跳过（防死循环重扫）
            let message = match serde_json::from_str::<PushMessage>(&payload) {
                Ok(m) => m,
                Err(error) => {
                    tracing::warn!(target: "push", device_key = %device_key, approval_id = %approval_id, error = %error, "审批待发表 payload 反序列化失败，删除损坏行");
                    let _ = conn.execute(
                        "DELETE FROM push_pending_approvals WHERE device_key = ?1 AND approval_id = ?2",
                        rusqlite::params![device_key, approval_id],
                    );
                    continue;
                }
            };
            // 阶梯推进：`retry_count`（旧值）为已完成重推次数 → 下一次间隔
            match next_retry_delay(retry_count) {
                Some(delay) => {
                    let next_retry_at = now_ms.saturating_add(delay.as_millis() as u64);
                    let _ = conn.execute(
                        "UPDATE push_pending_approvals SET retry_count = ?1, next_retry_at = ?2 \
                         WHERE device_key = ?3 AND approval_id = ?4",
                        rusqlite::params![
                            (retry_count + 1) as i64,
                            next_retry_at as i64,
                            device_key,
                            approval_id
                        ],
                    );
                    due.push(StoredPendingApproval {
                        device_key,
                        approval_id,
                        message,
                        marked_at_ms,
                        retry_count: retry_count + 1,
                        next_retry_at_ms: next_retry_at,
                    });
                }
                None => {
                    // 阶梯封顶：最多 5 次重推（D7 §3.3 S1）→ 停止重推，删除行
                    tracing::warn!(
                        target: "push",
                        device_key = %device_key,
                        approval_id = %approval_id,
                        retry_count = retry_count,
                        "审批重推阶梯封顶（最多 5 次），停止重推"
                    );
                    let _ = conn.execute(
                        "DELETE FROM push_pending_approvals WHERE device_key = ?1 AND approval_id = ?2",
                        rusqlite::params![device_key, approval_id],
                    );
                }
            }
        }
        due
    }

    /// 送达清库（R3-03 消费装配接线：厂商受理 / 设备失效 / 永久失败 /
    /// 审批已解决后调用；同时承载 D7 §8.2 `resolved` 的停止语义）。
    /// 返回是否实际删除了一行。
    pub fn remove(&self, device_key: &str, approval_id: &str) -> bool {
        let conn = match self.conn.lock() {
            Ok(c) => c,
            Err(_) => {
                tracing::warn!(target: "push", "审批待发表锁损坏，跳过清库");
                return false;
            }
        };
        match conn.execute(
            "DELETE FROM push_pending_approvals WHERE device_key = ?1 AND approval_id = ?2",
            rusqlite::params![device_key, approval_id],
        ) {
            Ok(changed) => changed > 0,
            Err(error) => {
                tracing::warn!(target: "push", device_key = %device_key, approval_id = %approval_id, error = %error, "审批待发表清库失败");
                false
            }
        }
    }

    /// 当前待发行数（诊断 / 测试用）
    pub fn len(&self) -> usize {
        let conn = match self.conn.lock() {
            Ok(c) => c,
            Err(_) => return 0,
        };
        conn.query_row("SELECT COUNT(*) FROM push_pending_approvals", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap_or(0) as usize
    }

    /// 当前待发队列是否为空
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests;
