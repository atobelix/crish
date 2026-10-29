//! push pending 测试（pending.rs 拆分）：审批待发落库/阶梯/重启恢复/分发桥接。

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
    assert!(
        store.enqueue("tok-a", &message, T0 + 1_000),
        "幂等命中也算已落库"
    );
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
    assert_eq!(
        first[0].next_retry_at_ms,
        T0 + 15 * 60 * 1000,
        "第 1 次重推 +15min"
    );

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

    assert!(
        store.take_due(T0 + 15 * 60 * 1000 - 1).is_empty(),
        "未到时刻不取走"
    );
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
    assert_eq!(
        approval_id_for(&run),
        "run-terminal:run-42:failed",
        "非审批回退去重键"
    );
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
    PushDispatcher::new(presence, channel as Arc<dyn PushChannel>).with_pending_store(store)
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
    assert_eq!(
        taken[0].message.title.as_deref(),
        Some("Crish 需要你的批准"),
        "copy.rs 文案随分发注入"
    );
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
    assert_eq!(
        taken[0].message.title.as_deref(),
        Some("Crish 需要你的批准")
    );
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
