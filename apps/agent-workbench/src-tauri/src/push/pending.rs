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
        conn.query_row(
            "SELECT COUNT(*) FROM push_pending_approvals",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0) as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::push::engine::{DecisionOutcome, PushDecision};
    use crate::push::intent::PayloadDigest;
    use crate::push::scenes::SceneId;
    use crate::push::schema::message_from_decision;

    const T0: u64 = 1_784_078_400_000;

    /// 审批决策 fixture（S1：params.toolCallId 承载审批幂等键）
    fn approval_decision(tool_call_id: &str) -> PushDecision {
        PushDecision {
            deliver: true,
            scene: SceneId::ApprovalRequested,
            level: SceneId::ApprovalRequested.level(),
            severity: SceneId::ApprovalRequested.level().severity(),
            dedupe_key: format!("approval-requested:{tool_call_id}"),
            payload: PayloadDigest {
                session_id: "s-7".to_string(),
                biz_key: tool_call_id.to_string(),
                digest: Some("执行部署脚本".to_string()),
                detail: Some("bash".to_string()),
            },
            outcome: DecisionOutcome::Delivered,
        }
    }

    fn approval_message(tool_call_id: &str) -> PushMessage {
        message_from_decision(
            &approval_decision(tool_call_id),
            "push-000001".to_string(),
            1,
            T0,
        )
    }

    /// 落库 + 取走 roundtrip：字段完整还原（device_key / approval_id /
    /// 完整消息 / marked_at），首取即推进阶梯（15min）
    #[test]
    fn enqueue_then_take_due_roundtrip() {
        let store = PendingApprovalStore::open_in_memory().expect("内存库");
        let message = approval_message("tc-9f3a");

        assert!(store.enqueue("tok-a", &message, T0), "入队落库");
        assert_eq!(store.len(), 1);

        let due = store.take_due(T0);
        assert_eq!(due.len(), 1, "到期取走（入队即到期）");
        let row = &due[0];
        assert_eq!(row.device_key, "tok-a");
        assert_eq!(row.approval_id, "tc-9f3a", "S1 幂等键 = params.toolCallId");
        assert_eq!(row.message, message, "完整消息原样还原");
        assert_eq!(row.marked_at_ms, T0);
        assert_eq!(row.retry_count, 1, "首取后已推进一次");
        assert_eq!(
            row.next_retry_at_ms,
            T0 + 15 * 60 * 1000,
            "第 1 次重推 +15min（R3-03a 阶梯）"
        );
        assert_eq!(store.len(), 1, "取走后行保留（阶梯推进，送达才清库）");
    }

    /// 幂等：同 (device_key, approval_id) 重复入队不新增行（D7 §8.4-5
    /// 同 id 不重复计数——重放防护）
    #[test]
    fn enqueue_idempotent_by_approval_id() {
        let store = PendingApprovalStore::open_in_memory().expect("内存库");
        let message = approval_message("tc-9f3a");
        assert!(store.enqueue("tok-a", &message, T0));
        assert!(store.enqueue("tok-a", &message, T0 + 1_000), "幂等命中也算已落库");
        assert_eq!(store.len(), 1, "不重复计数");
        // 不同设备独立计数（多设备各推一条）
        assert!(store.enqueue("tok-b", &message, T0));
        assert_eq!(store.len(), 2);
    }

    /// 重启恢复：文件库关闭重开（模拟桌面重启）→ 到期行自动恢复
    /// （D7 §9.3「桌面端崩溃/重启不丢审批推送」）
    #[test]
    fn restart_recovers_due_approvals() {
        let dir = tempfile::tempdir().expect("临时目录");
        let db_path = dir.path().join("push-pending.db");

        {
            let conn = rusqlite::Connection::open(&db_path).expect("建库");
            let store = PendingApprovalStore::new(conn).expect("建表");
            assert!(store.enqueue("tok-a", &approval_message("tc-1"), T0));
            assert!(store.enqueue("tok-a", &approval_message("tc-2"), T0));
        } // 连接 drop（模拟进程退出）

        // 重启后重新打开：内存队列已空，到期行从库恢复
        let conn = rusqlite::Connection::open(&db_path).expect("重开库");
        let store = PendingApprovalStore::new(conn).expect("建表");
        assert_eq!(store.len(), 2, "重启后待发不丢");
        let due = store.take_due(T0);
        assert_eq!(due.len(), 2);
        let ids: Vec<&str> = due.iter().map(|r| r.approval_id.as_str()).collect();
        assert_eq!(ids, ["tc-1", "tc-2"], "按到期时刻/标记次序恢复");
    }

    /// 重推阶梯推进：15min → 60min → 每小时 ×5 最多 5 次，封顶停止重推
    /// （行删除——与 R3-03a [next_retry_delay] 语义逐跳对齐）
    #[test]
    fn retry_ladder_progression_and_cap() {
        let store = PendingApprovalStore::open_in_memory().expect("内存库");
        assert!(store.enqueue("tok-a", &approval_message("tc-9"), T0));

        // 首次发送（入队即到期）
        let first = store.take_due(T0);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].retry_count, 1);
        assert_eq!(first[0].next_retry_at_ms, T0 + 15 * 60 * 1000, "第 1 次重推 +15min");

        // 阶梯逐跳：每次推进 1，间隔 = 旧计数对应值（1..=4 → 60min）
        let mut now = T0 + 15 * 60 * 1000;
        for expect_count in 2..=5u64 {
            let due = store.take_due(now);
            assert_eq!(due.len(), 1, "第 {expect_count} 跳到期");
            assert_eq!(due[0].retry_count, expect_count);
            assert_eq!(
                due[0].next_retry_at_ms,
                now + 60 * 60 * 1000,
                "第 {expect_count} 次重推间隔 60min"
            );
            now += 60 * 60 * 1000;
        }

        // 第 5 次重推后阶梯封顶（最多 5 次，D7 §3.3 S1）→ 停止重推，行删除
        let due = store.take_due(now);
        assert_eq!(due.len(), 0, "封顶后不再产出");
        assert_eq!(store.len(), 0, "封顶行删除（停止重推）");
    }

    /// 未到期行不产出：阶梯推进后的行在 next_retry_at 前不可取走
    #[test]
    fn take_due_only_returns_scheduled_rows() {
        let store = PendingApprovalStore::open_in_memory().expect("内存库");
        assert!(store.enqueue("tok-a", &approval_message("tc-7"), T0));
        store.take_due(T0); // 首取 → 下次 +15min

        assert!(store.take_due(T0 + 15 * 60 * 1000 - 1).is_empty(), "未到时刻不取走");
        assert_eq!(store.take_due(T0 + 15 * 60 * 1000).len(), 1, "到点取走");
    }

    /// 送达清库：remove 后行消失，重启也不再恢复（D7 §8.2 resolved 停止语义）
    #[test]
    fn remove_clears_delivered_and_restart_does_not_recover() {
        let dir = tempfile::tempdir().expect("临时目录");
        let db_path = dir.path().join("push-pending-clear.db");

        {
            let conn = rusqlite::Connection::open(&db_path).expect("建库");
            let store = PendingApprovalStore::new(conn).expect("建表");
            assert!(store.enqueue("tok-a", &approval_message("tc-3"), T0));
            assert!(store.enqueue("tok-a", &approval_message("tc-4"), T0));
            // 送达 tc-3 → 清库；tc-4 保留
            assert!(store.remove("tok-a", "tc-3"), "送达清库");
            assert!(!store.remove("tok-a", "tc-3"), "重复清库返回 false");
            assert_eq!(store.len(), 1);
        }

        let conn = rusqlite::Connection::open(&db_path).expect("重开库");
        let store = PendingApprovalStore::new(conn).expect("建表");
        assert_eq!(store.len(), 1, "已送达行不恢复");
        let due = store.take_due(T0);
        assert_eq!(due[0].approval_id, "tc-4");
    }

    /// approval_id 推导：S1/S2 = params.toolCallId；其余待发 = dedupe_key
    #[test]
    fn approval_id_for_derivation() {
        let approval = approval_message("tc-9f3a");
        assert_eq!(approval_id_for(&approval), "tc-9f3a");

        let run = message_from_decision(
            &PushDecision {
                deliver: true,
                scene: SceneId::RunFailed,
                level: SceneId::RunFailed.level(),
                severity: SceneId::RunFailed.level().severity(),
                dedupe_key: "run-terminal:run-42:failed".to_string(),
                payload: PayloadDigest {
                    session_id: "s-7".to_string(),
                    biz_key: "run-42".to_string(),
                    digest: Some("provider 401".to_string()),
                    detail: None,
                },
                outcome: DecisionOutcome::Delivered,
            },
            "push-2".to_string(),
            1,
            T0,
        );
        assert_eq!(approval_id_for(&run), "run-terminal:run-42:failed", "非审批回退去重键");
    }

    /// 损坏 payload 行：取走时删除并跳过（不阻塞整批、不重复死扫）
    #[test]
    fn corrupt_payload_row_is_dropped_on_take() {
        let store = PendingApprovalStore::open_in_memory().expect("内存库");
        assert!(store.enqueue("tok-a", &approval_message("tc-5"), T0));
        let conn = store.conn.lock().expect("锁");
        conn.execute(
            "UPDATE push_pending_approvals SET payload = '不是 JSON' WHERE approval_id = 'tc-5'",
            [],
        )
        .expect("破坏 payload");
        drop(conn);

        assert!(store.take_due(T0).is_empty(), "损坏行不产出");
        assert_eq!(store.len(), 0, "损坏行被删除（防死循环）");
    }

    // ── PushDispatcher 桥接（with_pending_store 注入面）──

    use std::sync::Arc;

    use crate::push::online::{device_activity, MemoryPresenceSource};
    use crate::push::pusher::{PushChannel, PushChannelError, PushDispatcher};

    /// 记录通道（直推替身；桥接测试只关心 pending 落库路径）
    struct RecordingChannel;

    impl PushChannel for RecordingChannel {
        fn send(&self, _: &str, _: &PushMessage) -> Result<(), PushChannelError> {
            Ok(())
        }
    }

    /// 注入待发表的离线分发器（设备离线 → mark_pending → 落库）
    fn dispatcher_with_store(store: Arc<PendingApprovalStore>) -> PushDispatcher {
        let presence = Arc::new(MemoryPresenceSource::new());
        presence.set_devices(vec![device_activity("tok-a", "手机 A", T0 - 60_000)]);
        let channel = Arc::new(RecordingChannel);
        PushDispatcher::new(
            presence,
            channel as Arc<dyn PushChannel>,
        )
        .with_pending_store(store)
    }

    /// 桥接 · 入队落库 + take 从库读：离线分发 → 待发表落库（无内存重复），
    /// take_pending 取走一次即送达面
    #[test]
    fn dispatcher_bridge_enqueues_and_takes_once() {
        let store = Arc::new(PendingApprovalStore::open_in_memory().expect("内存库"));
        let dispatcher = dispatcher_with_store(Arc::clone(&store));

        let report = dispatcher.dispatch(&approval_decision("tc-9f3a"), T0);
        assert_eq!(report.pending_marked, 1);
        assert_eq!(store.len(), 1, "入队落库");
        assert_eq!(dispatcher.pending_len(), 1, "内存 + 待发表合计");

        let taken = dispatcher.take_pending();
        assert_eq!(taken.len(), 1, "take 从库读，不重复");
        assert_eq!(taken[0].device_key, "tok-a");
        assert_eq!(taken[0].message.title.as_deref(), Some("Crish 需要你的批准"), "copy.rs 文案随分发注入");
        assert_eq!(store.len(), 1, "取走后行保留（阶梯推进，送达才清库）");
        assert!(dispatcher.take_pending().is_empty(), "阶梯未到点不再产出");
    }

    /// 桥接 · 重启恢复：注入新打开的库 + 新分发器（模拟桌面重启）→
    /// take_pending 从库恢复到期审批（D7 §9.3 重启不丢）
    #[test]
    fn dispatcher_bridge_recovers_after_restart() {
        let dir = tempfile::tempdir().expect("临时目录");
        let db_path = dir.path().join("push-pending-bridge.db");

        {
            let conn = rusqlite::Connection::open(&db_path).expect("建库");
            let store = Arc::new(PendingApprovalStore::new(conn).expect("建表"));
            let dispatcher = dispatcher_with_store(Arc::clone(&store));
            dispatcher.dispatch(&approval_decision("tc-1"), T0);
            assert_eq!(store.len(), 1);
        } // 分发器与连接 drop（模拟进程退出）

        let conn = rusqlite::Connection::open(&db_path).expect("重开库");
        let store = Arc::new(PendingApprovalStore::new(conn).expect("建表"));
        let dispatcher = dispatcher_with_store(store);
        let taken = dispatcher.take_pending();
        assert_eq!(taken.len(), 1, "重启后到期待发自动恢复");
        assert_eq!(taken[0].message.target.params["toolCallId"], "tc-1");
        assert_eq!(taken[0].message.title.as_deref(), Some("Crish 需要你的批准"));
    }

    /// 桥接 · 送达清库：mark_delivered 移除待发表行（R3-03 消费接线面）
    #[test]
    fn dispatcher_bridge_mark_delivered_clears_store() {
        let store = Arc::new(PendingApprovalStore::open_in_memory().expect("内存库"));
        let dispatcher = dispatcher_with_store(Arc::clone(&store));
        dispatcher.dispatch(&approval_decision("tc-2"), T0);
        assert_eq!(store.len(), 1);

        let taken = dispatcher.take_pending();
        assert!(dispatcher.mark_delivered(&taken[0]), "送达清库");
        assert_eq!(store.len(), 0, "行已移除");
        assert!(!dispatcher.mark_delivered(&taken[0]), "重复清库返回 false");
        // 无持久化注入：空操作
        let plain = PushDispatcher::new(
            Arc::new(MemoryPresenceSource::new()),
            Arc::new(RecordingChannel) as Arc<dyn PushChannel>,
        );
        assert!(!plain.mark_delivered(&taken[0]));
    }

    /// 桥接 · approval_id 幂等：同审批重复分发不重复落库（D7 §8.4-5）
    #[test]
    fn dispatcher_bridge_idempotent_approval_no_double_row() {
        let store = Arc::new(PendingApprovalStore::open_in_memory().expect("内存库"));
        let dispatcher = dispatcher_with_store(Arc::clone(&store));
        dispatcher.dispatch(&approval_decision("tc-3"), T0);
        dispatcher.dispatch(&approval_decision("tc-3"), T0 + 1_000);
        assert_eq!(store.len(), 1, "同 (device_key, approval_id) 幂等");
        // 不同审批独立落库
        dispatcher.dispatch(&approval_decision("tc-4"), T0 + 2_000);
        assert_eq!(store.len(), 2);
    }
}
