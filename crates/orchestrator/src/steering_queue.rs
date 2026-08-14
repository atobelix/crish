//! 跨 run steering 队列（B4.4，对齐 TS SteeringInputQueue）
//!
//! 对齐 `packages/agent-core/src/steering/steering-input-queue.ts` 的
//! 全部语义（05 §2.2 清单）：
//! - **FIFO**：`dequeue_all` 按入队顺序整体取出（05 §2.2:104）；
//! - **分组 replaceOrEnqueue**：同 `groupId` 存在则原位替换，否则入队
//!   （05 §2.2:106；steering-input-queue.ts:72-82）；
//! - **容量 evicts-oldest-non-steering**：满容量时先挤掉最旧的非 steering
//!   条目；全部为 steering 时新 steering 挤掉最旧，新普通条目被丢弃
//!   （05 §2.2:107；steering-input-queue.ts:111-118）；
//! - **transfer_to**：跨 run 迁移，目标队列的容量限制与 steering 优先级
//!   在转移时生效（05 §2.2:108；steering-input-queue.ts:104-109）。
//!
//! 与 session-loop 的适配（D8 裁决：run 内不注入，排入下一条用户消息
//! 边界）：
//! - [PendingMessageQueue::transfer_follow_up]：条目转为用户消息排入目标
//!   run 输入队列的 **followUp 环**——followUp 仅在 run 即将 idle 时
//!   promote 消费（01 §五.5），天然满足「下一条用户消息」语义；
//! - [PendingMessageQueue::drain_nudges]：消费 [PendingNudgeChannel] 的
//!   nudge 转为 steering 条目（按 reason 分组，重复 reason 经
//!   replaceOrEnqueue 去重）。

use std::collections::VecDeque;

use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use session_loop::input::{AgentInputQueue, InputEnqueueMode};
use session_loop::steering::PendingNudgeChannel;

/// 队列默认容量（任务书 B4.4 规定：默认 100）
pub const DEFAULT_QUEUE_CAPACITY: usize = 100;

/// 消息附件（对齐 TS MessageAttachment：type/data/mimeType）
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct MessageAttachment {
    /// 附件类型标识
    pub kind: String,
    /// 附件载荷
    pub data: serde_json::Value,
    /// MIME 类型（可选）
    pub mime_type: Option<String>,
}

/// 跨 run steering 输入条目（对齐 TS SteeringInputEntry）
///
/// 注（T06.3 Q15）：`session_id` 字段已删除——所有生产构造路径均写空串
/// （user / steering / drain_nudges），恒空字段无消费方；run 关联语义由
/// 消费方按 group_id / id 承载。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SteeringInputEntry {
    /// 条目 id（转用户消息时沿用，保证幂等）
    pub id: String,
    /// 用户可见文本
    pub text: String,
    /// 附件列表
    pub attachments: Vec<MessageAttachment>,
    /// 入队时间（Unix 毫秒，对齐 TS enqueuedAt number）
    pub enqueued_at: u64,
    /// 分组名：同分组 replaceOrEnqueue 去重
    pub group_id: Option<String>,
    /// 是否 steering 消息（容量挤占时普通消息先被淘汰）
    pub is_steering: bool,
}

impl SteeringInputEntry {
    /// 普通用户输入条目（非 steering）
    pub fn user(id: impl Into<String>, text: impl Into<String>, enqueued_at: u64) -> Self {
        Self {
            id: id.into(),
            text: text.into(),
            attachments: Vec::new(),
            enqueued_at,
            group_id: None,
            is_steering: false,
        }
    }

    /// steering 条目（容量挤占时受保护）
    pub fn steering(id: impl Into<String>, text: impl Into<String>, enqueued_at: u64) -> Self {
        Self {
            is_steering: true,
            ..Self::user(id, text, enqueued_at)
        }
    }

    /// 转用户角色消息（对齐 PendingNudge::into_user_message）
    ///
    /// D8：条目作为**下一条用户消息**注入；id 沿用条目 id 保证幂等；
    /// steering 条目带 `{kind: "steering"}` 元数据供下游识别。
    pub fn into_user_message(&self) -> AgentMessage {
        let metadata = if self.is_steering {
            Some(serde_json::json!({ "kind": "steering" }))
        } else {
            None
        };
        AgentMessage {
            id: self.id.clone(),
            role: AgentMessageRole::User,
            created_at: iso_from_millis(self.enqueued_at),
            blocks: vec![AgentMessageBlock::Text {
                text: self.text.clone(),
            }],
            metadata,
            client_message_id: None,
            content: None,
        }
    }
}

/// 跨 run steering 队列（对齐 TS SteeringInputQueue）
#[derive(Debug, Clone)]
pub struct PendingMessageQueue {
    entries: VecDeque<SteeringInputEntry>,
    max_size: usize,
}

impl PendingMessageQueue {
    /// 新建队列（默认容量 [DEFAULT_QUEUE_CAPACITY] = 100）
    pub fn new() -> Self {
        Self::with_capacity(DEFAULT_QUEUE_CAPACITY)
    }

    /// 新建指定容量的队列（至少为 1）
    pub fn with_capacity(max_size: usize) -> Self {
        Self {
            entries: VecDeque::new(),
            max_size: max_size.max(1),
        }
    }

    /// 入队一条条目。
    ///
    /// 满容量时按 [Self::evict_for] 挤占：普通消息先被挤掉，steering 保留
    /// （05 §2.2:107；steering-input-queue.ts:27-34）。
    pub fn enqueue(&mut self, entry: SteeringInputEntry) {
        if self.entries.len() == self.max_size {
            self.evict_for(&entry);
        }
        if self.entries.len() < self.max_size {
            self.entries.push_back(entry);
        }
    }

    /// 分组入队：同 `groupId` 存在则原位替换，否则入队。
    ///
    /// 返回 `true` 表示发生了替换（对齐 TS replaceOrEnqueue 返回值）。
    /// 未设置分组名的条目恒走入队路径（05 §2.2:106）。
    pub fn replace_or_enqueue(&mut self, entry: SteeringInputEntry) -> bool {
        if let Some(group_id) = &entry.group_id {
            if let Some(idx) = self
                .entries
                .iter()
                .position(|e| e.group_id.as_deref() == Some(group_id))
            {
                self.entries[idx] = entry;
                return true;
            }
        }
        self.enqueue(entry);
        false
    }

    /// 按分组名提取全部条目（用于同组 steering 合并），保持剩余条目顺序。
    ///
    /// 对齐 TS dequeueByGroup（05 §2.2:105）。
    pub fn dequeue_by_group(&mut self, group_id: &str) -> Vec<SteeringInputEntry> {
        self.withdraw(|e| e.group_id.as_deref() == Some(group_id))
    }

    /// 按谓词提取条目（撤销语义，对齐 TS withdraw）
    pub fn withdraw(
        &mut self,
        predicate: impl Fn(&SteeringInputEntry) -> bool,
    ) -> Vec<SteeringInputEntry> {
        let mut matched = Vec::new();
        let mut remaining = VecDeque::new();
        while let Some(entry) = self.entries.pop_front() {
            if predicate(&entry) {
                matched.push(entry);
            } else {
                remaining.push_back(entry);
            }
        }
        self.entries = remaining;
        matched
    }

    /// FIFO 取出全部条目（对齐 TS dequeueAll，05 §2.2:104）
    pub fn dequeue_all(&mut self) -> Vec<SteeringInputEntry> {
        self.entries.drain(..).collect()
    }

    /// 跨 run 转移：全部条目迁入目标队列并清空本队列。
    ///
    /// 目标队列按自身容量限制与 steering 优先级逐条收容——满容量时普通
    /// 消息先被挤掉、steering 消息保留（05 §2.2:108 transferTo 语义）。
    pub fn transfer_to(&mut self, other: &mut Self) {
        while let Some(entry) = self.entries.pop_front() {
            other.enqueue(entry);
        }
    }

    /// 将全部条目转为用户消息排入输入队列并清空，返回排入条数。
    ///
    /// D8 合规用法：`mode = [InputEnqueueMode::FollowUp]`——followUp 仅在
    /// run 即将 idle 时 promote 消费，条目落在「下一条用户消息边界」。
    pub fn transfer_into_input_queue(
        &mut self,
        queue: &mut AgentInputQueue,
        mode: InputEnqueueMode,
    ) -> usize {
        let entries = self.dequeue_all();
        let count = entries.len();
        for entry in entries {
            queue.enqueue(entry.into_user_message(), mode);
        }
        count
    }

    /// D8 便捷入口：全部条目排入 followUp 环（run 内不注入）
    pub fn transfer_follow_up(&mut self, queue: &mut AgentInputQueue) -> usize {
        self.transfer_into_input_queue(queue, InputEnqueueMode::FollowUp)
    }

    /// 消费 [PendingNudgeChannel] 的待注入 nudge，转为 steering 条目入队。
    ///
    /// 每条 nudge 按 `reason` 分组（重复原因经 replaceOrEnqueue 去重）、
    /// 标记为 steering（容量挤占时受保护），返回入队条数。
    pub fn drain_nudges(&mut self, channel: &mut PendingNudgeChannel) -> usize {
        let nudges = channel.drain_all();
        let count = nudges.len();
        for nudge in nudges {
            self.replace_or_enqueue(SteeringInputEntry {
                id: nudge.id,
                text: nudge.text,
                attachments: Vec::new(),
                enqueued_at: unix_millis_now(),
                group_id: Some(nudge.reason.as_str().to_string()),
                is_steering: true,
            });
        }
        count
    }

    /// 是否有待处理条目
    pub fn has_pending(&self) -> bool {
        !self.entries.is_empty()
    }

    /// 是否含 steering 条目（对齐 TS hasPendingSteering）
    pub fn has_pending_steering(&self) -> bool {
        self.entries.iter().any(|e| e.is_steering)
    }

    /// 预览队首（不移除）
    pub fn peek(&self) -> Option<&SteeringInputEntry> {
        self.entries.front()
    }

    /// 清空队列
    pub fn clear(&mut self) {
        self.entries.clear();
    }

    /// 当前条数
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// 是否为空
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// 满容量挤占策略（对齐 TS evictFor，steering-input-queue.ts:111-118）：
    /// - 优先挤掉**最旧的非 steering** 条目；
    /// - 全为 steering 且新条目也是 steering 时挤掉最旧；
    /// - 全为 steering 而新条目是普通消息时**不挤占**（由调用方丢弃）。
    fn evict_for(&mut self, entry: &SteeringInputEntry) {
        if let Some(idx) = self.entries.iter().position(|e| !e.is_steering) {
            self.entries.remove(idx);
        } else if entry.is_steering {
            self.entries.pop_front();
        }
    }
}

impl Default for PendingMessageQueue {
    fn default() -> Self {
        Self::new()
    }
}

/// 当前 Unix 毫秒
fn unix_millis_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Unix 毫秒转 ISO8601（毫秒精度，`2026-07-31T08:00:00.000Z`）
///
/// 与 session-loop steering 的时间戳格式一致；无 chrono 依赖，
/// 手工换算（Howard Hinnant civil-from-days 算法）。
fn iso_from_millis(ms: u64) -> String {
    let secs = ms / 1000;
    let millis = ms % 1000;
    let (hours, mins, sec) = (secs / 3600 % 24, secs / 60 % 60, secs % 60);
    let (year, month, day) = civil_from_days((secs / 86400) as i64);
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{mins:02}:{sec:02}.{millis:03}Z")
}

/// 从 Unix 天数换算公历年月日（Howard Hinnant 算法）
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_types::message::AgentMessageRole;
    use session_loop::input::{AgentInputQueue, InputEnqueueMode};
    use session_loop::steering::{PendingNudge, PendingNudgeChannel, SteeringReason};

    fn user_entry(id: &str, text: &str, seq: u64) -> SteeringInputEntry {
        SteeringInputEntry::user(id, text, 1000 + seq)
    }

    fn steering_entry(id: &str, text: &str, seq: u64) -> SteeringInputEntry {
        SteeringInputEntry::steering(id, text, 1000 + seq)
    }

    fn grouped_entry(id: &str, text: &str, seq: u64, group: &str) -> SteeringInputEntry {
        let mut entry = user_entry(id, text, seq);
        entry.group_id = Some(group.to_string());
        entry
    }

    /// 05 §2.2:104：FIFO 顺序整体取出
    #[test]
    fn fifo_order_dequeue_all() {
        let mut queue = PendingMessageQueue::new();
        queue.enqueue(user_entry("a", "first", 1));
        queue.enqueue(user_entry("b", "second", 2));
        queue.enqueue(user_entry("c", "third", 3));

        let drained = queue.dequeue_all();
        assert_eq!(drained.len(), 3);
        assert_eq!(drained[0].id, "a", "FIFO 顺序");
        assert_eq!(drained[1].id, "b");
        assert_eq!(drained[2].id, "c");
        assert!(queue.is_empty(), "取出后队列清空");
    }

    /// 05 §2.2:106：同 groupId 替换旧条目（replaceOrEnqueue 返回 true）
    #[test]
    fn replace_or_enqueue_same_group_replaces() {
        let mut queue = PendingMessageQueue::new();
        queue.enqueue(grouped_entry("a", "v1", 1, "g1"));
        queue.enqueue(grouped_entry("b", "v2", 2, "g2"));

        // 同分组 g1：原位替换
        assert!(queue.replace_or_enqueue(grouped_entry("a2", "v3", 3, "g1")));
        assert_eq!(queue.len(), 2, "替换不增加条数");

        // 替换保持原位置：队首仍是 g1 的新内容
        let drained = queue.dequeue_all();
        assert_eq!(drained[0].id, "a2", "原位替换");
        assert_eq!(drained[0].text, "v3");
        assert_eq!(drained[1].id, "b");
    }

    /// 未分组条目恒走入队路径（可重复、返回 false）
    #[test]
    fn replace_or_enqueue_ungrouped_always_enqueues() {
        let mut queue = PendingMessageQueue::new();
        assert!(!queue.replace_or_enqueue(user_entry("a", "v1", 1)));
        assert!(!queue.replace_or_enqueue(user_entry("b", "v2", 2)));
        assert_eq!(queue.len(), 2);
    }

    /// 容量语义：超容量挤掉最旧（默认容量 100，任务书 B4.4）
    #[test]
    fn default_capacity_100_evicts_oldest() {
        let mut queue = PendingMessageQueue::new();
        for i in 0..(DEFAULT_QUEUE_CAPACITY + 5) {
            queue.enqueue(user_entry(&format!("m-{i}"), "x", i as u64));
        }
        assert_eq!(queue.len(), DEFAULT_QUEUE_CAPACITY);
        assert_eq!(queue.peek().expect("队首").id, "m-5", "最旧的 5 条被挤掉");
    }

    /// 05 §2.2:107：满容量时 steering 优先——普通消息先被挤掉，steering 保留
    #[test]
    fn evicts_oldest_non_steering_first_keeps_steering() {
        let mut queue = PendingMessageQueue::with_capacity(3);
        queue.enqueue(user_entry("u1", "plain-1", 1));
        queue.enqueue(user_entry("u2", "plain-2", 2));
        queue.enqueue(user_entry("u3", "plain-3", 3));

        // 满容量 + steering 入队：挤掉最旧普通消息 u1
        queue.enqueue(steering_entry("s1", "steer-1", 4));
        assert!(queue.has_pending_steering(), "steering 条目已入队");
        let drained = queue.dequeue_all();
        let ids: Vec<&str> = drained.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["u2", "u3", "s1"],
            "steering 保留、最旧普通消息被挤掉"
        );

        // 再入队普通消息：继续挤掉最旧普通消息 u2，steering 仍保留
        let mut queue2 = PendingMessageQueue::with_capacity(3);
        for e in drained {
            queue2.enqueue(e);
        }
        queue2.enqueue(user_entry("u4", "plain-4", 5));
        let ids: Vec<String> = queue2.dequeue_all().into_iter().map(|e| e.id).collect();
        assert_eq!(
            ids,
            vec!["u3", "s1", "u4"],
            "普通消息先被挤掉，steering 始终保留"
        );
    }

    /// 满容量全为 steering：新 steering 挤掉最旧（对齐 TS evictFor shift 分支）
    #[test]
    fn all_steering_full_shifts_oldest_steering() {
        let mut queue = PendingMessageQueue::with_capacity(3);
        queue.enqueue(steering_entry("s1", "a", 1));
        queue.enqueue(steering_entry("s2", "b", 2));
        queue.enqueue(steering_entry("s3", "c", 3));

        queue.enqueue(steering_entry("s4", "d", 4));
        let ids: Vec<String> = queue.dequeue_all().into_iter().map(|e| e.id).collect();
        assert_eq!(ids, vec!["s2", "s3", "s4"], "最旧 steering 被挤掉");
    }

    /// 满容量全为 steering 时普通消息不挤占（被丢弃，对齐 TS evictFor）
    #[test]
    fn all_steering_full_drops_non_steering() {
        let mut queue = PendingMessageQueue::with_capacity(2);
        queue.enqueue(steering_entry("s1", "a", 1));
        queue.enqueue(steering_entry("s2", "b", 2));

        queue.enqueue(user_entry("u1", "plain", 3));
        assert_eq!(queue.len(), 2, "普通消息被丢弃");
        assert!(queue.has_pending_steering());
        let ids: Vec<String> = queue.dequeue_all().into_iter().map(|e| e.id).collect();
        assert_eq!(ids, vec!["s1", "s2"]);
    }

    /// 05 §2.2:108/109：transferTo 迁移全部条目，源队列清空、顺序保持
    #[test]
    fn transfer_to_moves_all_entries_and_clears_source() {
        let mut source = PendingMessageQueue::new();
        source.enqueue(user_entry("a", "first", 1));
        source.enqueue(user_entry("b", "second", 2));

        let mut dest = PendingMessageQueue::new();
        source.transfer_to(&mut dest);

        assert!(source.is_empty(), "源队列清空");
        let ids: Vec<String> = dest.dequeue_all().into_iter().map(|e| e.id).collect();
        assert_eq!(ids, vec!["a", "b"], "FIFO 顺序保持");
    }

    /// 05 §2.2:108：transferTo 容量限制与 steering 优先级在目标队列生效
    #[test]
    fn transfer_to_respects_destination_capacity_and_steering_priority() {
        // 目标队列满容量且全为普通消息
        let mut dest = PendingMessageQueue::with_capacity(2);
        dest.enqueue(user_entry("d1", "plain-1", 1));
        dest.enqueue(user_entry("d2", "plain-2", 2));

        // 源队列含 steering 条目
        let mut source = PendingMessageQueue::new();
        source.enqueue(steering_entry("s1", "steer-1", 3));

        source.transfer_to(&mut dest);

        assert!(source.is_empty(), "跨 run 迁移后源队列清空");
        assert_eq!(dest.len(), 2, "目标队列仍受容量限制");
        assert!(dest.has_pending_steering(), "steering 条目保留");
        let ids: Vec<String> = dest.dequeue_all().into_iter().map(|e| e.id).collect();
        assert_eq!(ids, vec!["d2", "s1"], "普通消息 d1 被挤掉、steering 保留");
    }

    /// D8：transfer_follow_up 排入 followUp 环——run 内不可消费，
    /// idle promote 后作为下一条用户消息消费
    #[test]
    fn transfer_follow_up_lands_in_follow_up_ring() {
        let mut queue = PendingMessageQueue::new();
        queue.enqueue(user_entry("a", "hello", 1));
        queue.enqueue(steering_entry("s1", "please fix", 2));

        let mut input = AgentInputQueue::new();
        let count = queue.transfer_follow_up(&mut input);
        assert_eq!(count, 2);
        assert!(queue.is_empty(), "转移后队列清空");

        // followUp 不进入当前 run 的消费路径（D8：run 内不注入）
        assert!(input.has_follow_up_pending());
        assert!(!input.has_runnable_pending());
        assert!(input.dequeue().is_none(), "run 内取不到条目");

        // 下一 run 开始（idle 安全点）promote 后作为用户消息消费
        assert_eq!(input.promote_follow_up(), 2);
        let first = input.dequeue().expect("promote 后可消费");
        assert_eq!(first.role, AgentMessageRole::User);
        assert_eq!(first.id, "a", "id 沿用保证幂等");
        assert_eq!(first.text(), "hello");
        let second = input.dequeue().expect("第二条");
        assert_eq!(second.text(), "please fix");
        assert_eq!(
            second
                .metadata
                .as_ref()
                .and_then(|m| m.get("kind"))
                .and_then(|k| k.as_str()),
            Some("steering"),
            "steering 条目带元数据标记"
        );
    }

    /// D8：也可显式排入 steer 环（orchestrator 选择时）
    #[test]
    fn transfer_into_input_queue_steer_ring() {
        let mut queue = PendingMessageQueue::new();
        queue.enqueue(steering_entry("s1", "steer", 1));

        let mut input = AgentInputQueue::new();
        let count = queue.transfer_into_input_queue(&mut input, InputEnqueueMode::Steer);
        assert_eq!(count, 1);
        assert!(input.has_steer_pending());
        assert_eq!(input.dequeue().expect("steer 环可消费").text(), "steer");
    }

    /// PendingNudgeChannel 适配：nudge 转为 steering 条目、按 reason 分组
    /// 去重（重复 reason 经 replaceOrEnqueue 替换）
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
        let drained = queue.dequeue_all();
        assert!(
            drained.iter().all(|e| e.is_steering),
            "nudge 均为 steering 条目"
        );
        assert_eq!(drained[0].group_id.as_deref(), Some("empty-response"));
        assert_eq!(
            drained[0].text, "第二次空响应提示（应替换第一次）",
            "同组后入者替换先入者"
        );
        assert_eq!(drained[1].group_id.as_deref(), Some("tool-errors"));
    }

    /// dequeueByGroup：按分组提取，剩余条目保持顺序（05 §2.2:105）
    #[test]
    fn dequeue_by_group_removes_only_matching() {
        let mut queue = PendingMessageQueue::new();
        queue.enqueue(grouped_entry("a", "g1-1", 1, "g1"));
        queue.enqueue(grouped_entry("b", "g2-1", 2, "g2"));
        queue.enqueue(grouped_entry("c", "g1-2", 3, "g1"));

        let matched = queue.dequeue_by_group("g1");
        assert_eq!(matched.len(), 2);
        assert_eq!(matched[0].id, "a", "提取保持 FIFO 顺序");
        assert_eq!(matched[1].id, "c");
        assert_eq!(queue.len(), 1, "剩余条目不受影响");
        assert_eq!(queue.peek().expect("剩余").id, "b");
    }

    /// withdraw 谓词撤销（对齐 TS withdraw）
    #[test]
    fn withdraw_by_predicate() {
        let mut queue = PendingMessageQueue::new();
        queue.enqueue(user_entry("u1", "plain", 1));
        queue.enqueue(steering_entry("s1", "steer", 2));

        let removed = queue.withdraw(|e| !e.is_steering);
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].id, "u1");
        assert_eq!(queue.len(), 1);
        assert!(queue.has_pending_steering());
    }

    /// 谓词与清空
    #[test]
    fn predicates_peek_clear() {
        let mut queue = PendingMessageQueue::new();
        assert!(queue.is_empty());
        assert!(!queue.has_pending());
        assert!(!queue.has_pending_steering());
        queue.enqueue(user_entry("u1", "plain", 1));
        assert!(queue.has_pending());
        assert!(!queue.has_pending_steering());
        assert_eq!(queue.peek().expect("队首").id, "u1", "peek 不移除");
        queue.enqueue(steering_entry("s1", "steer", 2));
        assert!(queue.has_pending_steering());
        assert_eq!(queue.len(), 2);
        queue.clear();
        assert!(queue.is_empty());
        assert!(!queue.has_pending());
    }

    /// 转用户消息：字段与元数据齐全
    #[test]
    fn into_user_message_shape() {
        let entry = steering_entry("s1", "请检查文件", 1_785_456_000_000);
        let message = entry.into_user_message();
        assert_eq!(message.role, AgentMessageRole::User);
        assert_eq!(message.id, "s1");
        assert_eq!(message.text(), "请检查文件");
        assert!(message.created_at.ends_with('Z'), "ISO8601 时间戳");
        let metadata = message.metadata.as_ref().expect("steering 条目须带元数据");
        assert_eq!(
            metadata.get("kind").and_then(|k| k.as_str()),
            Some("steering")
        );

        let plain = user_entry("u1", "plain", 1_785_456_000_000).into_user_message();
        assert!(plain.metadata.is_none(), "普通条目不带 steering 元数据");
    }

    /// 时间戳换算：已知基准（2026-07-31 = Unix 天数 20665）
    #[test]
    fn iso_from_millis_known_date() {
        let iso = iso_from_millis(1_785_456_000_000);
        assert_eq!(iso, "2026-07-31T00:00:00.000Z");
    }
}
