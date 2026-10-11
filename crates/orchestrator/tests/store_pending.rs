//! B4.5 pending 输入队列语义测试（05 §5.4 store::pending）
//!
//! 对齐 orchestrator.test.ts:360-402（待处理输入记录：入队/按 run 关联/取出/
//! 删除）与 05 §2.2 steering-input-queue 语义。pending 输入以
//! [orchestrator::PendingMessageQueue]（跨 run steering 队列，B4.4）承载：
//! - 入队/取出 FIFO（05 §2.2:104）；
//! - 按 run 关联与删除（条目携带 session_id，按 run 谓词撤回，05 §2.2:105）；
//! - 同组替换去重（replaceOrEnqueue，05 §2.2:106）；
//! - 容量挤占：steering 优先、普通消息先淘汰（05 §2.2:107）。

mod common;

use orchestrator::steering_queue::SteeringInputEntry;
use orchestrator::PendingMessageQueue;

/// 构造按 run 关联的普通用户输入条目（group_id 承载 run 归属；
/// T06.3 Q15：session_id 恒空字段已删除）
fn run_entry(run: &str, id: &str, text: &str, seq: u64) -> SteeringInputEntry {
    SteeringInputEntry {
        session_id: String::new(),
        id: id.to_string(),
        text: text.to_string(),
        attachments: Vec::new(),
        enqueued_at: 1_000 + seq,
        group_id: Some(run.to_string()),
        is_steering: false,
    }
}

/// 构造按 run 关联的 steering 条目（容量挤占时受保护）
fn run_steering(run: &str, id: &str, text: &str, seq: u64) -> SteeringInputEntry {
    SteeringInputEntry {
        is_steering: true,
        ..run_entry(run, id, text, seq)
    }
}

/// 入队/取出：FIFO 顺序整体取出，取出后队列清空（05 §2.2:104）
#[test]
fn pending_enqueue_dequeue_all_in_fifo_order() {
    let mut queue = PendingMessageQueue::new();
    queue.enqueue(run_entry("r1", "a", "first", 1));
    queue.enqueue(run_entry("r1", "b", "second", 2));
    queue.enqueue(run_entry("r1", "c", "third", 3));

    assert_eq!(queue.len(), 3);
    assert_eq!(queue.peek().expect("队首").id, "a", "peek 不移除");

    let drained = queue.dequeue_all();
    assert_eq!(drained.len(), 3);
    assert_eq!(drained[0].id, "a", "FIFO 顺序");
    assert_eq!(drained[1].id, "b");
    assert_eq!(drained[2].id, "c");
    assert!(queue.is_empty(), "取出后队列清空");
}

/// 按 run 关联：多 run 条目混排时按 session_id 撤回目标 run，其余保持顺序
/// （对齐 TS dequeueByGroup / withdraw 语义，orchestrator.test.ts:360
/// 按 run 维护 pending 记录）
#[test]
fn pending_withdrawn_by_run_keeps_other_runs_intact() {
    let mut queue = PendingMessageQueue::new();
    queue.enqueue(run_entry("run-a", "a1", "a-1", 1));
    queue.enqueue(run_entry("run-b", "b1", "b-1", 2));
    queue.enqueue(run_entry("run-a", "a2", "a-2", 3));
    queue.enqueue(run_entry("run-b", "b2", "b-2", 4));

    // 撤回 run-a 的全部 pending（模拟该 run 的 pending 清理/消费；
    // 谓词改按 group_id——T06.3 Q15 后 run 关联由 group_id 承载）
    let removed = queue.withdraw(|e| e.group_id.as_deref() == Some("run-a"));
    assert_eq!(removed.len(), 2);
    assert_eq!(removed[0].id, "a1", "撤回保持 FIFO 顺序");
    assert_eq!(removed[1].id, "a2");
    assert!(
        removed
            .iter()
            .all(|e| e.group_id.as_deref() == Some("run-a")),
        "只撤回目标 run"
    );

    // 剩余条目顺序不变
    let rest = queue.dequeue_all();
    assert_eq!(rest[0].id, "b1");
    assert_eq!(rest[1].id, "b2");
}

/// 删除：按谓词撤回指定条目（含 steering 与普通消息混合场景）
#[test]
fn pending_deleted_by_predicate() {
    let mut queue = PendingMessageQueue::new();
    queue.enqueue(run_entry("r1", "u1", "plain", 1));
    queue.enqueue(run_steering("r1", "s1", "steer", 2));
    queue.enqueue(run_entry("r2", "u2", "plain-2", 3));

    // 删除 id 为 u1 的条目
    let removed = queue.withdraw(|e| e.id == "u1");
    assert_eq!(removed.len(), 1);
    assert_eq!(removed[0].id, "u1");
    assert_eq!(queue.len(), 2);

    // 删除后剩余条目顺序保持
    let rest = queue.dequeue_all();
    assert_eq!(rest[0].id, "s1");
    assert_eq!(rest[1].id, "u2");

    // clear 清空全部
    queue.enqueue(run_entry("r3", "x", "x", 9));
    queue.clear();
    assert!(queue.is_empty());
    assert!(!queue.has_pending());
}

/// 同组替换去重：同 groupId 原位替换，未分组恒入队（05 §2.2:106）
#[test]
fn pending_replace_or_enqueue_dedupes_by_group() {
    let mut queue = PendingMessageQueue::new();
    let mut g1 = run_entry("r1", "g1-v1", "旧值", 1);
    g1.group_id = Some("goal-round-1".to_string());
    queue.enqueue(g1);

    let mut g1_new = run_entry("r1", "g1-v2", "新值", 2);
    g1_new.group_id = Some("goal-round-1".to_string());
    assert!(queue.replace_or_enqueue(g1_new), "同组应替换");
    assert_eq!(queue.len(), 1, "替换不增加条数");

    // 未分组恒入队（返回 false；run_entry 默认带 run 分组，此处显式置 None）
    let mut ungrouped = run_entry("r1", "x", "x", 3);
    ungrouped.group_id = None;
    assert!(!queue.replace_or_enqueue(ungrouped));
    assert_eq!(queue.len(), 2);

    let drained = queue.dequeue_all();
    assert_eq!(drained[0].id, "g1-v2", "原位替换生效");
    assert_eq!(drained[0].text, "新值");
}

/// 容量挤占：满容量时普通消息先被淘汰，steering 保留（05 §2.2:107）
#[test]
fn pending_capacity_evicts_oldest_non_steering_keeps_steering() {
    let mut queue = PendingMessageQueue::with_capacity(3);
    queue.enqueue(run_entry("r1", "u1", "plain-1", 1));
    queue.enqueue(run_entry("r1", "u2", "plain-2", 2));
    queue.enqueue(run_entry("r1", "u3", "plain-3", 3));

    // 满容量 + steering 入队：挤掉最旧普通消息 u1
    queue.enqueue(run_steering("r2", "s1", "steer-1", 4));
    assert!(queue.has_pending_steering());
    let ids: Vec<String> = queue.dequeue_all().into_iter().map(|e| e.id).collect();
    assert_eq!(
        ids,
        vec!["u2", "u3", "s1"],
        "steering 保留、最旧普通消息被挤掉"
    );

    // 全为 steering 满容量：新普通消息被丢弃、新 steering 挤掉最旧
    let mut all_steer = PendingMessageQueue::with_capacity(2);
    all_steer.enqueue(run_steering("r1", "s1", "a", 1));
    all_steer.enqueue(run_steering("r1", "s2", "b", 2));
    all_steer.enqueue(run_entry("r2", "plain", "p", 3));
    assert_eq!(all_steer.len(), 2, "普通消息被丢弃");
    all_steer.enqueue(run_steering("r1", "s3", "c", 4));
    let ids: Vec<String> = all_steer.dequeue_all().into_iter().map(|e| e.id).collect();
    assert_eq!(ids, vec!["s2", "s3"], "全 steering 时新 steering 挤掉最旧");
}

/// 默认容量（任务书 B4.4：默认 100）与基础谓词
#[test]
fn pending_default_capacity_and_predicates() {
    let mut queue = PendingMessageQueue::new();
    assert!(queue.is_empty());
    assert!(!queue.has_pending());
    assert!(!queue.has_pending_steering());

    for i in 0..(orchestrator::steering_queue::DEFAULT_QUEUE_CAPACITY + 5) {
        queue.enqueue(run_entry("r1", &format!("m-{i}"), "x", i as u64));
    }
    assert_eq!(
        queue.len(),
        orchestrator::steering_queue::DEFAULT_QUEUE_CAPACITY
    );
    assert_eq!(
        queue.peek().expect("队首").id,
        "m-5",
        "最旧的 5 条被默认容量挤掉"
    );
}
