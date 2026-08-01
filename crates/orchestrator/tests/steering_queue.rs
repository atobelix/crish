//! B4.5 跨 run steering 转移集成测试（05 §5.4 steering::queue / B4.4）
//!
//! 对齐 steering/steering-input-queue.test.ts:203-297（transferTo）与
//! 05 §2.2:108/109：
//! - transfer_to：跨 run 迁移，源队列清空、FIFO 顺序保持；
//! - 目标队列容量限制与 steering 优先级在转移时生效（普通消息先被挤掉）；
//! - followUp 环：转移条目作为下一条用户消息，idle promote 后消费（D8）；
//! - drain_nudges：nudge 通道 → steering 条目，按 reason 分组去重。

mod common;

use conex_types::message::AgentMessageRole;
use orchestrator::PendingMessageQueue;
use orchestrator::steering_queue::SteeringInputEntry;
use session_loop::input::AgentInputQueue;
use session_loop::steering::{PendingNudge, PendingNudgeChannel, SteeringReason};

/// 构造按 run 关联的普通条目（group_id 承载 run 归属；
/// T06.3 Q15：session_id 恒空字段已删除）
fn run_entry(run: &str, id: &str, text: &str, seq: u64) -> SteeringInputEntry {
    SteeringInputEntry {
        id: id.to_string(),
        text: text.to_string(),
        attachments: Vec::new(),
        enqueued_at: 1_000 + seq,
        group_id: Some(run.to_string()),
        is_steering: false,
    }
}

/// 构造按 run 关联的 steering 条目（转移时受保护）
fn run_steering(run: &str, id: &str, text: &str, seq: u64) -> SteeringInputEntry {
    SteeringInputEntry {
        is_steering: true,
        ..run_entry(run, id, text, seq)
    }
}

/// transfer_to：跨 run 迁移全部条目，源队列清空、FIFO 顺序保持
/// （05 §2.2:108/109）
#[test]
fn transfer_to_moves_all_entries_and_clears_source() {
    let mut source = PendingMessageQueue::new();
    source.enqueue(run_entry("run-a", "a1", "a-1", 1));
    source.enqueue(run_steering("run-a", "s1", "steer-1", 2));

    let mut dest = PendingMessageQueue::new();
    source.transfer_to(&mut dest);

    assert!(source.is_empty(), "源队列清空");
    assert_eq!(dest.len(), 2);
    let drained = dest.dequeue_all();
    assert_eq!(drained[0].id, "a1", "FIFO 顺序保持");
    assert_eq!(drained[1].id, "s1");
    assert_eq!(
        drained[1].group_id.as_deref(),
        Some("run-a"),
        "run 关联（group_id）随条目迁移"
    );
}

/// 目标队列容量限制 + steering 优先级在转移时生效：
/// 满容量时普通消息先被挤掉、steering 保留（05 §2.2:108）
#[test]
fn transfer_to_respects_destination_capacity_and_steering_priority() {
    // 目标队列满容量且全为普通消息
    let mut dest = PendingMessageQueue::with_capacity(2);
    dest.enqueue(run_entry("run-b", "d1", "plain-1", 1));
    dest.enqueue(run_entry("run-b", "d2", "plain-2", 2));

    // 源队列：steering + 普通消息混排
    let mut source = PendingMessageQueue::new();
    source.enqueue(run_steering("run-a", "s1", "steer-1", 3));
    source.enqueue(run_entry("run-a", "u1", "plain-3", 4));

    source.transfer_to(&mut dest);

    assert!(source.is_empty(), "迁移后源队列清空");
    assert_eq!(dest.len(), 2, "目标队列仍受容量限制");
    assert!(dest.has_pending_steering(), "steering 条目保留");

    let drained = dest.dequeue_all();
    let ids: Vec<&str> = drained.iter().map(|e| e.id.as_str()).collect();
    // 逐条收容：s1 挤掉 d1；u1 再挤掉 d2 → 最终 [s1, u1]
    assert_eq!(ids, vec!["s1", "u1"], "普通消息（d1/d2）先被挤掉，steering 保留");
}

/// 目标队列全为 steering 满容量：转移进来的普通消息被丢弃（不挤占 steering）
#[test]
fn transfer_to_drops_plain_entries_when_destination_all_steering() {
    let mut dest = PendingMessageQueue::with_capacity(2);
    dest.enqueue(run_steering("run-b", "s1", "a", 1));
    dest.enqueue(run_steering("run-b", "s2", "b", 2));

    let mut source = PendingMessageQueue::new();
    source.enqueue(run_entry("run-a", "u1", "plain-1", 3));
    source.enqueue(run_entry("run-a", "u2", "plain-2", 4));

    source.transfer_to(&mut dest);

    assert!(source.is_empty());
    assert_eq!(dest.len(), 2, "普通消息被丢弃，不挤占 steering");
    let ids: Vec<String> = dest.dequeue_all().into_iter().map(|e| e.id).collect();
    assert_eq!(ids, vec!["s1", "s2"]);
}

/// followUp 环：转移条目排入 followUp，run 内不可消费；
/// idle 安全点 promote 后作为下一条用户消息消费（D8）
#[test]
fn transfer_follow_up_lands_in_follow_up_ring_and_promotes_on_idle() {
    let mut queue = PendingMessageQueue::new();
    queue.enqueue(run_entry("run-a", "msg-1", "继续完成上一步", 1));
    queue.enqueue(run_steering("run-a", "nudge-1", "请检查遗漏的工具调用", 2));

    let mut input = AgentInputQueue::new();
    let count = queue.transfer_follow_up(&mut input);
    assert_eq!(count, 2);
    assert!(queue.is_empty(), "转移后队列清空");

    // followUp 环：当前 run 内不可消费（D8：run 内不注入）
    assert!(input.has_follow_up_pending());
    assert!(!input.has_runnable_pending());
    assert!(input.dequeue().is_none(), "mid-run 取不到条目");

    // 下一 run 开始（idle）promote → 作为用户消息消费
    assert_eq!(input.promote_follow_up(), 2);
    let first = input.dequeue().expect("promote 后可消费");
    assert_eq!(first.role, AgentMessageRole::User);
    assert_eq!(first.id, "msg-1", "id 沿用保证幂等");
    assert_eq!(first.text(), "继续完成上一步");

    let second = input.dequeue().expect("第二条");
    assert_eq!(second.text(), "请检查遗漏的工具调用");
    assert_eq!(
        second.metadata.as_ref().and_then(|m| m.get("kind")).and_then(|k| k.as_str()),
        Some("steering"),
        "steering 条目带元数据标记"
    );
}

/// drain_nudges：nudge 通道消费 → steering 条目入队，按 reason 分组去重
/// （重复 reason 经 replaceOrEnqueue 原位替换，05 §2.2:106）
#[test]
fn drain_nudges_converts_with_group_dedup() {
    let mut channel = PendingNudgeChannel::new();
    channel.enqueue(PendingNudge::new(
        SteeringReason::EmptyResponse,
        "第一次空响应提示",
    ));
    channel.enqueue(PendingNudge::new(
        SteeringReason::ToolErrors,
        "工具错误提示",
    ));
    channel.enqueue(PendingNudge::new(
        SteeringReason::EmptyResponse,
        "第二次空响应提示（应替换第一次）",
    ));

    let mut queue = PendingMessageQueue::new();
    let count = queue.drain_nudges(&mut channel);
    assert_eq!(count, 3, "三条 nudge 全部消费");
    assert!(channel.is_empty(), "通道已清空");

    // 重复 reason 去重：只剩 2 条
    assert_eq!(queue.len(), 2);
    assert!(queue.has_pending_steering(), "nudge 均为 steering 条目");

    let drained = queue.dequeue_all();
    assert!(drained.iter().all(|e| e.is_steering));
    assert_eq!(drained[0].group_id.as_deref(), Some("empty-response"));
    assert_eq!(drained[0].text, "第二次空响应提示（应替换第一次）", "同组后入者替换先入者");
    assert_eq!(drained[1].group_id.as_deref(), Some("tool-errors"));
}

/// 多 run 汇总转移：两 run 的 pending 汇入同一目标队列，run 关联保持，
/// 可再按 run 撤回
#[test]
fn multi_run_transfer_keeps_run_association_for_withdraw() {
    let mut run_a = PendingMessageQueue::new();
    run_a.enqueue(run_entry("run-a", "a1", "a-1", 1));

    let mut run_b = PendingMessageQueue::new();
    run_b.enqueue(run_entry("run-b", "b1", "b-1", 2));
    run_b.enqueue(run_entry("run-b", "b2", "b-2", 3));

    let mut inbox = PendingMessageQueue::new();
    run_a.transfer_to(&mut inbox);
    run_b.transfer_to(&mut inbox);
    assert!(run_a.is_empty() && run_b.is_empty());
    assert_eq!(inbox.len(), 3);

    // 按 run 撤回 run-b 的 pending（模拟该 run 的输入消费；谓词改按
    // group_id——T06.3 Q15 后 run 关联由 group_id 承载）
    let removed = inbox.withdraw(|e| e.group_id.as_deref() == Some("run-b"));
    assert_eq!(removed.len(), 2);
    assert_eq!(removed[0].id, "b1");
    assert_eq!(removed[1].id, "b2");
    assert_eq!(inbox.len(), 1);
    assert_eq!(inbox.peek().expect("剩余").id, "a1");
}
