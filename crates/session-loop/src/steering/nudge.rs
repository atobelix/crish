//! nudge 消息文本生成与注入通道（D8：run 内不注入，排入下一条用户消息）
//!
//! 裁决 D8（01 第四章）：run 内任何位置不注入 nudge；nudge 文本一律排入
//! 下一条用户消息。本模块提供：
//! - [runtime_steering_text]：纠偏提示语生成（中英双语，对齐 TS
//!   runtime-helpers.ts 的 runtimeSteeringText）；
//! - [build_steering_message]：steering 注入消息构建（system 角色，
//!   metadata `{kind: "runtime-steering", reason, steeringCount}`，
//!   对齐 01 §3.5）；
//! - [PendingNudgeChannel]：pending-nudge 通道——run 内产生的 nudge 先入
//!   此通道，由 orchestrator（B4）在**下一 run 开始时**消费并作为用户
//!   消息排入输入队列（对齐 TS SteeringInputQueue 形态）。
//!
//! 注入时机说明（本任务只提供通道函数，挂接点在 B3.4/B4）：
//! - orchestrator 在下一 run 开始时调用 [PendingNudgeChannel::drain_all]
//!   取出 nudge，逐条以用户角色消息入队（[PendingNudge::into_user_message]）；
//! - 也可直接经 [PendingNudgeChannel::enqueue_into_input_queue] 排入
//!   followUp 环——followUp 仅在 run 即将 idle 时 promote 消费（01 §五.5），
//!   天然满足「注入到本会停止的边界」语义。

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};

use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use conex_types::AgentEvent;

use crate::input::{AgentInputQueue, InputEnqueueMode};
use crate::steering::{now_iso_utc, unix_millis, SteeringReason};

/// 通道容量（对齐 TS SteeringInputQueue 默认 50）
pub const DEFAULT_PENDING_NUDGE_CAPACITY: usize = 50;

/// 消息 id 计数器（保证同毫秒内多次注入 id 唯一）
static MESSAGE_ID_COUNTER: AtomicU64 = AtomicU64::new(0);

fn new_message_id(prefix: &str) -> String {
    let n = MESSAGE_ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{}-{n}", unix_millis())
}

/// 纠偏提示语（中英双语，对齐 TS runtimeSteeringText）
///
/// - `tool-errors`：连续工具失败——不要重复同一次调用，调整参数或策略；
/// - `tool-loop`：重复调用——停止循环，总结已知信息，换策略或求助；
/// - `empty-response`：空响应——不要静默停止，调用下一步工具或一句话说明阻碍。
pub fn runtime_steering_text(reason: SteeringReason) -> String {
    match reason {
        SteeringReason::ToolErrors => [
            "运行期纠偏：最近的工具调用连续失败。",
            "不要重复同一次调用。请简要定位失败原因，调整参数或策略，",
            "仅在下一次动作确实不同时继续。",
            "若现有工具无法解决阻碍，请停止并说明阻碍。",
            "",
            "Runtime steering: recent tool calls failed repeatedly.",
            "Do not repeat the same call. Diagnose the failure briefly, change the",
            "arguments or strategy, and continue only with a materially different",
            "next action. If the blocker cannot be resolved with the available",
            "tools, stop and explain the blocker.",
        ]
        .join("\n"),
        SteeringReason::EmptyResponse => [
            "运行期纠偏：上一轮助手没有产出可见文字，也没有调用工具。",
            "不要静默停止。请调用下一步所需的工具，或用一句简洁的话说明阻碍。",
            "若用户要求创建或检查文件，请先使用可用的文件系统工具再作答。",
            "",
            "Runtime steering: the previous assistant turn produced no visible",
            "text and no tool call. Do not stop silently. Either call the next",
            "required tool or explain the blocker in one concise message. If the",
            "user requested file creation or inspection, use the available",
            "filesystem tools before answering.",
        ]
        .join("\n"),
        SteeringReason::ToolLoop => [
            "运行期纠偏：同一个工具调用似乎在重复。",
            "请停止循环，总结已知信息，选择不同的策略或请求用户指引，",
            "而不是再次发出同一次调用。",
            "",
            "Runtime steering: the same tool call appears to be repeating.",
            "Stop the loop, summarize what is already known, and choose a",
            "different strategy or ask for user guidance instead of issuing the",
            "same call again.",
        ]
        .join("\n"),
    }
}

/// 构建 steering 注入消息（system 角色，01 §3.5）
///
/// metadata：`{kind: "runtime-steering", reason, steeringCount}`；
/// `steeringCount` 为注入**后**的计数（对齐 TS createTextMessage 传
/// `context.steeringCount + 1`）。
pub fn build_steering_message(reason: SteeringReason, steering_count: usize) -> AgentMessage {
    let text = runtime_steering_text(reason);
    AgentMessage {
        id: new_message_id("steering"),
        role: AgentMessageRole::System,
        created_at: now_iso_utc(),
        blocks: vec![AgentMessageBlock::Text { text }],
        metadata: Some(serde_json::json!({
            "kind": "runtime-steering",
            "reason": reason.as_str(),
            "steeringCount": steering_count,
            "thinking_budget": 0,
            "thinkingBudget": 0,
        })),
        client_message_id: None,
        content: None,
    }
}

/// 构建诊断事件附带消息（emit-diagnostic 用，不修改对话）
pub(crate) fn diagnostic_message(text: &str) -> AgentMessage {
    AgentMessage {
        id: new_message_id("diagnostic"),
        role: AgentMessageRole::System,
        created_at: now_iso_utc(),
        blocks: vec![AgentMessageBlock::Text {
            text: text.to_string(),
        }],
        metadata: Some(serde_json::json!({ "kind": "diagnostic" })),
        client_message_id: None,
        content: None,
    }
}

/// 待注入 nudge 条目（对齐 TS SteeringInputEntry 的 steering 部分）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingNudge {
    /// 条目 id（转用户消息时沿用）
    pub id: String,
    /// 纠偏原因
    pub reason: SteeringReason,
    /// nudge 文本
    pub text: String,
    /// 入队时间（ISO8601）
    pub created_at: String,
}

impl PendingNudge {
    /// 构建新的 nudge 条目
    pub fn new(reason: SteeringReason, text: impl Into<String>) -> Self {
        Self {
            id: new_message_id("nudge"),
            reason,
            text: text.into(),
            created_at: now_iso_utc(),
        }
    }

    /// 转用户角色消息（D8：nudge 作为下一条用户消息注入）
    ///
    /// metadata：`{kind: "nudge", reason}`；id 沿用条目 id 保证幂等。
    pub fn into_user_message(&self) -> AgentMessage {
        AgentMessage {
            id: self.id.clone(),
            role: AgentMessageRole::User,
            created_at: self.created_at.clone(),
            blocks: vec![AgentMessageBlock::Text {
                text: self.text.clone(),
            }],
            metadata: Some(serde_json::json!({
                "kind": "nudge",
                "reason": self.reason.as_str(),
            })),
            client_message_id: None,
            content: None,
        }
    }
}

/// pending-nudge 通道（D8 注入通道）
///
/// run 内产生的 nudge 一律先入本通道，**不注入当前 run**；orchestrator 在
/// 下一 run 开始时消费（[Self::drain_all] / [Self::enqueue_into_input_queue]）。
/// 容量固定（默认 50），满容量覆盖最旧条目（防无界增长）。
///
/// EV-08 观测面：入队动作留痕——每次 [Self::enqueue] 产生一条
/// `nudge-enqueued` 事件（覆盖最旧时 `overwrote=true` 也发，覆盖无痕
/// 缺陷闭合；事件缓冲经 [Self::take_enqueue_events] 取走，由调用方
/// （orchestrator 消费侧）送入事件通道发射）。
#[derive(Debug, Clone)]
pub struct PendingNudgeChannel {
    entries: VecDeque<PendingNudge>,
    max_size: usize,
    /// 会话归属（nudge-enqueued 事件 session_id 载荷；缺省空串）
    session_id: String,
    /// 入队留痕事件缓冲（nudge-enqueued）
    enqueue_events: Vec<AgentEvent>,
}

impl PendingNudgeChannel {
    /// 新建通道（默认容量 [DEFAULT_PENDING_NUDGE_CAPACITY]）
    pub fn new() -> Self {
        Self::with_capacity(DEFAULT_PENDING_NUDGE_CAPACITY)
    }

    /// 新建指定容量的通道
    pub fn with_capacity(max_size: usize) -> Self {
        Self {
            entries: VecDeque::new(),
            max_size: max_size.max(1),
            session_id: String::new(),
            enqueue_events: Vec::new(),
        }
    }

    /// 新建通道并指定会话归属（nudge-enqueued 事件 session_id 载荷）
    pub fn with_session_id(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            ..Self::new()
        }
    }

    /// 入队一个 nudge；满容量时覆盖最旧条目
    ///
    /// EV-08：每次入队（含覆盖丢弃）产生 `nudge-enqueued` 留痕事件，
    /// 缓冲于通道内，调用方经 [Self::take_enqueue_events] 取走后发射。
    pub fn enqueue(&mut self, nudge: PendingNudge) {
        let overwrote = self.entries.len() == self.max_size;
        if overwrote {
            self.entries.pop_front();
        }
        let reason = nudge.reason.as_str().to_string();
        self.entries.push_back(nudge);
        self.enqueue_events.push(AgentEvent::NudgeEnqueued {
            session_id: self.session_id.clone(),
            timestamp: now_iso_utc(),
            reason,
            target_ring: "pending".to_string(),
            overwrote,
        });
    }

    /// 取走入队留痕事件（nudge-enqueued；调用方负责送入事件通道发射）
    pub fn take_enqueue_events(&mut self) -> Vec<AgentEvent> {
        std::mem::take(&mut self.enqueue_events)
    }

    /// 便捷入队：按原因生成 nudge（文本缺省用 [runtime_steering_text]）
    pub fn enqueue_reason(&mut self, reason: SteeringReason) {
        self.enqueue(PendingNudge::new(reason, runtime_steering_text(reason)));
    }

    /// 是否有待注入 nudge
    pub fn has_pending(&self) -> bool {
        !self.entries.is_empty()
    }

    /// 当前待注入条数
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// 是否为空
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// 预览队首（不移除）
    pub fn peek(&self) -> Option<&PendingNudge> {
        self.entries.front()
    }

    /// 清空通道
    pub fn clear(&mut self) {
        self.entries.clear();
    }

    /// 取出全部 nudge（orchestrator 在下一 run 开始时消费）
    pub fn drain_all(&mut self) -> Vec<PendingNudge> {
        self.entries.drain(..).collect()
    }

    /// 按谓词撤销部分 nudge（如按 reason 去重防重复提示）
    ///
    /// T06.3 Q07：仅测试使用（生产路径无调用），标记 #[cfg(test)]
    #[cfg(test)]
    pub fn withdraw(&mut self, predicate: impl Fn(&PendingNudge) -> bool) -> Vec<PendingNudge> {
        let mut matched = Vec::new();
        let mut remaining = VecDeque::new();
        while let Some(nudge) = self.entries.pop_front() {
            if predicate(&nudge) {
                matched.push(nudge);
            } else {
                remaining.push_back(nudge);
            }
        }
        self.entries = remaining;
        matched
    }

    /// 撤销指定原因的全部 nudge（按 reason 去重）
    ///
    /// T06.3 Q07：仅测试使用，标记 #[cfg(test)]
    #[cfg(test)]
    pub fn withdraw_reason(&mut self, reason: SteeringReason) -> Vec<PendingNudge> {
        self.withdraw(|n| n.reason == reason)
    }

    /// 将全部待注入 nudge 排入输入队列并清空通道，返回排入条数。
    ///
    /// D8 合规用法：`mode = [InputEnqueueMode::FollowUp]`——followUp 仅在
    /// run 即将 idle 时 promote 消费，nudge 天然落在「下一条用户消息边界」。
    pub fn enqueue_into_input_queue(
        &mut self,
        queue: &mut AgentInputQueue,
        mode: InputEnqueueMode,
    ) -> usize {
        let nudges = self.drain_all();
        let count = nudges.len();
        for nudge in nudges {
            queue.enqueue(nudge.into_user_message(), mode);
        }
        count
    }
}

impl Default for PendingNudgeChannel {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::InputEnqueueMode;

    #[test]
    fn steering_text_distinct_for_each_reason() {
        let texts: std::collections::BTreeSet<String> = [
            SteeringReason::ToolErrors,
            SteeringReason::ToolLoop,
            SteeringReason::EmptyResponse,
        ]
        .iter()
        .map(|r| runtime_steering_text(*r))
        .collect();
        assert_eq!(texts.len(), 3, "三种原因提示语各不相同");
        for text in &texts {
            assert!(!text.is_empty());
            assert!(text.contains('中') || text.contains("纠偏"), "含中文提示");
            assert!(
                text.contains("Runtime steering"),
                "含英文对照（对齐 TS 文案）"
            );
        }
    }

    #[test]
    fn steering_message_shape() {
        let message = build_steering_message(SteeringReason::ToolLoop, 2);
        assert_eq!(message.role, AgentMessageRole::System);
        assert!(message.id.starts_with("steering-"));
        assert!(!message.text().is_empty());
        let metadata = message.metadata.as_ref().expect("注入消息须带元数据");
        assert_eq!(
            metadata.get("kind").and_then(|k| k.as_str()),
            Some("runtime-steering")
        );
        assert_eq!(
            metadata.get("reason").and_then(|r| r.as_str()),
            Some("tool-loop")
        );
        assert_eq!(
            metadata.get("steeringCount").and_then(|c| c.as_u64()),
            Some(2)
        );
    }

    /// 通道基础语义：入队/预览/清空/取出（FIFO）
    #[test]
    fn channel_enqueue_peek_drain_fifo() {
        let mut channel = PendingNudgeChannel::new();
        assert!(channel.is_empty());
        channel.enqueue_reason(SteeringReason::EmptyResponse);
        channel.enqueue_reason(SteeringReason::ToolErrors);
        assert_eq!(channel.len(), 2);
        assert_eq!(
            channel.peek().expect("队首").reason,
            SteeringReason::EmptyResponse
        );

        let drained = channel.drain_all();
        assert_eq!(drained.len(), 2);
        assert_eq!(
            drained[0].reason,
            SteeringReason::EmptyResponse,
            "FIFO 顺序"
        );
        assert_eq!(drained[1].reason, SteeringReason::ToolErrors);
        assert!(!channel.has_pending());
        assert_eq!(channel.drain_all().len(), 0, "取空后为空");
    }

    /// 容量语义：满容量覆盖最旧（不无界增长）
    #[test]
    fn channel_capacity_evicts_oldest() {
        let mut channel = PendingNudgeChannel::with_capacity(2);
        channel.enqueue_reason(SteeringReason::EmptyResponse);
        channel.enqueue_reason(SteeringReason::ToolErrors);
        channel.enqueue_reason(SteeringReason::ToolLoop);
        assert_eq!(channel.len(), 2);
        let drained = channel.drain_all();
        assert_eq!(
            drained[0].reason,
            SteeringReason::ToolErrors,
            "最旧的空响应被覆盖"
        );
        assert_eq!(drained[1].reason, SteeringReason::ToolLoop);
    }

    /// D8：nudge 排入 followUp 环——run 内不可消费，idle promote 后成为
    /// 下一条用户消息（「排入下一条用户消息队列」）
    #[test]
    fn nudge_enqueues_into_next_user_message_queue() {
        let mut channel = PendingNudgeChannel::new();
        channel.enqueue_reason(SteeringReason::EmptyResponse);
        let mut queue = AgentInputQueue::new();

        let count = channel.enqueue_into_input_queue(&mut queue, InputEnqueueMode::FollowUp);
        assert_eq!(count, 1);
        assert!(channel.is_empty(), "通道已清空");

        // followUp 不进入当前 run 的消费路径（D8：run 内不注入）
        assert!(queue.has_follow_up_pending());
        assert!(!queue.has_runnable_pending());
        assert!(queue.dequeue().is_none(), "run 内取不到 nudge");

        // 下一 run 开始（idle 安全点）promote 后作为用户消息消费
        assert_eq!(queue.promote_follow_up(), 1);
        let message = queue.dequeue().expect("promote 后可消费");
        assert_eq!(message.role, AgentMessageRole::User);
        assert_eq!(
            message
                .metadata
                .as_ref()
                .and_then(|m| m.get("kind"))
                .and_then(|k| k.as_str()),
            Some("nudge")
        );
        assert!(message.text().contains("Runtime steering"));
    }

    /// nudge 也可直接排入 steer 环（orchestrator 显式选择时）
    #[test]
    fn nudge_enqueues_into_steer_ring() {
        let mut channel = PendingNudgeChannel::new();
        channel.enqueue_reason(SteeringReason::ToolLoop);
        let mut queue = AgentInputQueue::new();

        channel.enqueue_into_input_queue(&mut queue, InputEnqueueMode::Steer);
        assert!(queue.has_steer_pending());
        let message = queue.dequeue().expect("steer 环可消费");
        assert_eq!(message.role, AgentMessageRole::User);
    }

    /// 转用户消息：字段与元数据齐全
    #[test]
    fn pending_nudge_into_user_message() {
        let nudge = PendingNudge::new(
            SteeringReason::ToolErrors,
            runtime_steering_text(SteeringReason::ToolErrors),
        );
        let message = nudge.into_user_message();
        assert_eq!(message.role, AgentMessageRole::User);
        assert_eq!(message.id, nudge.id, "id 沿用保证幂等");
        assert_eq!(message.created_at, nudge.created_at);
        assert_eq!(message.text(), nudge.text);
        let metadata = message.metadata.as_ref().expect("须带元数据");
        assert_eq!(metadata.get("kind").and_then(|k| k.as_str()), Some("nudge"));
        assert_eq!(
            metadata.get("reason").and_then(|r| r.as_str()),
            Some("tool-errors")
        );
    }

    /// 按原因撤销（去重防重复提示）
    #[test]
    fn withdraw_by_reason() {
        let mut channel = PendingNudgeChannel::new();
        channel.enqueue_reason(SteeringReason::EmptyResponse);
        channel.enqueue_reason(SteeringReason::ToolLoop);
        channel.enqueue_reason(SteeringReason::EmptyResponse);

        let removed = channel.withdraw_reason(SteeringReason::EmptyResponse);
        assert_eq!(removed.len(), 2, "同名原因全部撤销");
        assert_eq!(channel.len(), 1);
        assert_eq!(
            channel.peek().expect("剩余").reason,
            SteeringReason::ToolLoop
        );

        // 用谓词撤销接口同样可用
        channel.enqueue_reason(SteeringReason::EmptyResponse);
        let removed = channel.withdraw(|n| n.reason == SteeringReason::EmptyResponse);
        assert_eq!(removed.len(), 1);
        assert_eq!(channel.len(), 1, "剩余的 ToolLoop 不被误删");
        assert_eq!(
            channel.peek().expect("剩余").reason,
            SteeringReason::ToolLoop
        );
    }

    /// clear 清空通道
    #[test]
    fn channel_clear() {
        let mut channel = PendingNudgeChannel::new();
        channel.enqueue_reason(SteeringReason::EmptyResponse);
        channel.clear();
        assert!(channel.is_empty());
        assert!(!channel.has_pending());
        assert_eq!(channel.len(), 0);
    }

    /// 消息 id 唯一性：同毫秒内多次生成不重复
    #[test]
    fn message_ids_are_unique() {
        let a = new_message_id("nudge");
        let b = new_message_id("nudge");
        let c = new_message_id("steering");
        assert_ne!(a, b);
        assert_ne!(a, c);
    }

    // ── EV-08：入队留痕事件（nudge-enqueued）─────────────────────

    /// 入队 → 产生 nudge-enqueued 事件（reason/目标环/未覆盖）
    #[test]
    fn nudge_enqueued_event_emitted_on_enqueue() {
        let mut channel = PendingNudgeChannel::with_session_id("sess-1");
        channel.enqueue_reason(SteeringReason::ToolLoop);
        let events = channel.take_enqueue_events();
        assert_eq!(events.len(), 1, "每次入队恰一条留痕事件");
        match &events[0] {
            conex_types::AgentEvent::NudgeEnqueued {
                session_id,
                reason,
                target_ring,
                overwrote,
                ..
            } => {
                assert_eq!(session_id, "sess-1", "事件携带会话归属");
                assert_eq!(reason, "tool-loop", "事件携带 nudge 原因");
                assert_eq!(target_ring, "pending", "入队环 = pending 通道");
                assert!(!overwrote, "未满容量不入队覆盖");
            }
            other => panic!("期望 nudge-enqueued，实际 {other:?}"),
        }
    }

    /// 满容量覆盖最旧 → 事件仍发且 overwrote=true（覆盖无痕缺陷闭合）
    #[test]
    fn nudge_enqueued_event_overwrite_flag_on_capacity() {
        let mut channel = PendingNudgeChannel::with_capacity(2);
        channel.enqueue_reason(SteeringReason::EmptyResponse);
        channel.enqueue_reason(SteeringReason::ToolErrors);
        channel.enqueue_reason(SteeringReason::ToolLoop);
        let events = channel.take_enqueue_events();
        assert_eq!(events.len(), 3, "覆盖最旧时事件也发（不静默）");
        let overwrote_flags: Vec<bool> = events
            .iter()
            .map(|e| match e {
                conex_types::AgentEvent::NudgeEnqueued { overwrote, .. } => *overwrote,
                other => panic!("期望 nudge-enqueued，实际 {other:?}"),
            })
            .collect();
        assert_eq!(overwrote_flags, vec![false, false, true], "第三条覆盖最旧");
        let reasons: Vec<String> = events
            .iter()
            .map(|e| match e {
                conex_types::AgentEvent::NudgeEnqueued { reason, .. } => reason.clone(),
                other => panic!("期望 nudge-enqueued，实际 {other:?}"),
            })
            .collect();
        assert_eq!(reasons, vec!["empty-response", "tool-errors", "tool-loop"]);
    }

    /// 取走事件后缓冲清空（调用方发射一次取一次）
    #[test]
    fn take_enqueue_events_drains_buffer() {
        let mut channel = PendingNudgeChannel::new();
        channel.enqueue_reason(SteeringReason::EmptyResponse);
        assert_eq!(channel.take_enqueue_events().len(), 1);
        assert!(channel.take_enqueue_events().is_empty(), "取走后缓冲清空");
    }
}
