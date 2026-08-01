//! 三环输入队列（B3.2，对齐 TS agent-input-queue.ts）
//!
//! 统一管理所有输入源：初始 prompt、steer 输入、follow-up、recovery 纠偏消息。
//! 状态机在 awaiting-input 不区分来源，只关心队列是否有可运行输入。
//!
//! 三环语义（对齐 pi agent steer / followUp，01 §五.5 / 05 §2.2）：
//! - force：可在 streaming 中途打断（历史 mid-stream 行为；legacy）
//! - steer：下一安全点注入（provider 消费结束 / tool 批后），不杀当前 stream
//! - followUp：仅在 run 即将 idle 时注入（无 tool、无 steer/force；agent 本会结束）
//!
//! 底层用环形缓冲：`shift()` 为 O(1)，固定容量提供背压保护
//! （超容量覆盖最旧，避免长会话下无界增长）。

use std::collections::VecDeque;

use conex_types::message::AgentMessage;

/// 输入队列固定容量（对齐 TS INPUT_QUEUE_CAPACITY = 1000）
pub const INPUT_QUEUE_CAPACITY: usize = 1000;

/// 批次序号生成器（工具批处理 / 事件批次共用，进程内单调递增）
pub fn next_batch_seq() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static BATCH_SEQ: AtomicU64 = AtomicU64::new(1);
    BATCH_SEQ.fetch_add(1, Ordering::SeqCst)
}

/// 入队模式（对齐 TS InputEnqueueMode）
///
/// - [InputEnqueueMode::Force]：mid-stream 可打断
/// - [InputEnqueueMode::Steer]：安全点注入
/// - [InputEnqueueMode::FollowUp]：仅 run idle 时注入
///
/// 注（T06.3 Q13）：`Soft` 兼容别名变体已删除——生产与测试均以
/// `Steer` 命名（enqueue_steer / has_steer_pending / drain_steer）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum InputEnqueueMode {
    /// 可中断路径（默认 enqueue；legacy mid-stream）
    #[default]
    Force,
    /// 下一安全点注入（pi steer）
    Steer,
    /// 仅 idle 注入（pi followUp）
    FollowUp,
}

/// 固定容量环形缓冲（覆盖最旧）
///
/// 与 TS RingBuffer 等价：push 满容量时丢弃队首；shift 为 O(1)。
#[derive(Debug, Clone)]
pub struct RingBuffer<T> {
    buf: VecDeque<T>,
    capacity: usize,
}

impl<T> RingBuffer<T> {
    /// 新建指定容量的环形缓冲
    pub fn new(capacity: usize) -> Self {
        Self {
            buf: VecDeque::with_capacity(capacity.min(1)),
            capacity,
        }
    }

    /// 入队；满容量时覆盖最旧元素（不增长）
    pub fn push_overwriting_oldest(&mut self, item: T) {
        if self.buf.len() == self.capacity {
            self.buf.pop_front();
        }
        self.buf.push_back(item);
    }

    /// 取出并移除队首（O(1)）
    pub fn shift(&mut self) -> Option<T> {
        self.buf.pop_front()
    }

    /// 预览队首（不移除）
    pub fn peek_first(&self) -> Option<&T> {
        self.buf.front()
    }

    /// 当前元素数
    pub fn size(&self) -> usize {
        self.buf.len()
    }

    /// 清空
    pub fn clear(&mut self) {
        self.buf.clear();
    }
}

/// 统一输入队列（对齐 TS AgentInputQueue）
#[derive(Debug, Clone, Default)]
pub struct AgentInputQueue {
    /// 可中断路径（默认 enqueue；legacy mid-stream）
    force_items: RingBuffer<AgentMessage>,
    /// 下一安全点注入（pi steer）
    steer_items: RingBuffer<AgentMessage>,
    /// 仅 idle 注入（pi followUp）
    follow_up_items: RingBuffer<AgentMessage>,
}

impl Default for RingBuffer<AgentMessage> {
    fn default() -> Self {
        Self::new(INPUT_QUEUE_CAPACITY)
    }
}

impl AgentInputQueue {
    /// 新建空队列（三环容量均为 [INPUT_QUEUE_CAPACITY]）
    pub fn new() -> Self {
        Self::default()
    }

    /// 入队一条消息。
    ///
    /// 默认 [InputEnqueueMode::Force]（low-level / legacy mid-stream）；
    /// 公共产品路径请用 [Self::enqueue_steer] / [Self::enqueue_follow_up]。
    pub fn enqueue(&mut self, message: AgentMessage, mode: InputEnqueueMode) {
        match mode {
            InputEnqueueMode::Steer => self.steer_items.push_overwriting_oldest(message),
            InputEnqueueMode::FollowUp => {
                self.follow_up_items.push_overwriting_oldest(message)
            }
            InputEnqueueMode::Force => self.force_items.push_overwriting_oldest(message),
        }
    }

    /// 显式 force 环（mid-stream 可打断）；公共 steer 勿用
    pub fn enqueue_force(&mut self, message: AgentMessage) {
        self.enqueue(message, InputEnqueueMode::Force);
    }

    /// pi steer：下一安全点（provider 结束 / tool 批后）
    pub fn enqueue_steer(&mut self, message: AgentMessage) {
        self.enqueue(message, InputEnqueueMode::Steer);
    }

    /// pi followUp：仅当 agent 本将结束（无 tool、无 steer）时注入
    pub fn enqueue_follow_up(&mut self, message: AgentMessage) {
        self.enqueue(message, InputEnqueueMode::FollowUp);
    }

    /// 取出并移除下一条可运行消息（force 优先，再 steer）。
    ///
    /// 不取出 followUp — 须在 idle 安全点经 drain_follow_up /
    /// promote_follow_up 消费。
    pub fn dequeue(&mut self) -> Option<AgentMessage> {
        self.force_items.shift().or_else(|| self.steer_items.shift())
    }

    /// 仅取出 force 消息（streaming 中断路径）
    pub fn dequeue_force(&mut self) -> Option<AgentMessage> {
        self.force_items.shift()
    }

    /// 取出全部 steer 消息（安全点）
    pub fn drain_steer(&mut self) -> Vec<AgentMessage> {
        let mut out = Vec::new();
        while let Some(m) = self.steer_items.shift() {
            out.push(m);
        }
        out
    }

    /// 取出全部 followUp 消息（仅 run idle 时调用）
    pub fn drain_follow_up(&mut self) -> Vec<AgentMessage> {
        let mut out = Vec::new();
        while let Some(m) = self.follow_up_items.shift() {
            out.push(m);
        }
        out
    }

    /// 将 followUp 提升为 steer，使后续 dequeue / awaiting-input 可消费。
    ///
    /// 仅应在「本将 SHOULD_STOP」的 idle 点调用（对齐 pi getFollowUpMessages）。
    /// 返回提升条数。
    pub fn promote_follow_up(&mut self) -> usize {
        let msgs = self.drain_follow_up();
        let n = msgs.len();
        for m in msgs {
            self.steer_items.push_overwriting_oldest(m);
        }
        n
    }

    /// 预览下一条可运行消息（force 优先；不移除；不含 followUp）
    pub fn peek(&self) -> Option<&AgentMessage> {
        self.force_items
            .peek_first()
            .or_else(|| self.steer_items.peek_first())
    }

    /// 是否有任意待处理消息（含 followUp）
    pub fn has_pending(&self) -> bool {
        self.force_items.size() > 0
            || self.steer_items.size() > 0
            || self.follow_up_items.size() > 0
    }

    /// 是否有 mid-run 可继续消息（force 或 steer）。
    ///
    /// tool 批后 / stream 后安全点应使用此谓词，避免过早消费 followUp。
    pub fn has_runnable_pending(&self) -> bool {
        self.force_items.size() > 0 || self.steer_items.size() > 0
    }

    /// 是否有 force 消息（streaming 中途可打断）
    pub fn has_force_pending(&self) -> bool {
        self.force_items.size() > 0
    }

    /// 是否有 steer 消息
    pub fn has_steer_pending(&self) -> bool {
        self.steer_items.size() > 0
    }

    /// 是否有 followUp 消息（仅 idle 应消费）
    pub fn has_follow_up_pending(&self) -> bool {
        self.follow_up_items.size() > 0
    }

    /// 队列中的消息数量（三环合计）
    pub fn len(&self) -> usize {
        self.force_items.size() + self.steer_items.size() + self.follow_up_items.size()
    }

    /// 是否为空
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// 清空三环
    pub fn clear(&mut self) {
        self.force_items.clear();
        self.steer_items.clear();
        self.follow_up_items.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(text: &str) -> AgentMessage {
        AgentMessage {
            id: format!("m-{text}"),
            role: conex_types::message::AgentMessageRole::User,
            created_at: "2026-01-01T00:00:00Z".into(),
            blocks: vec![conex_types::message::AgentMessageBlock::Text {
                text: text.into(),
            }],
            metadata: None,
            client_message_id: None,
            content: None,
        }
    }

    /// 05 §2.2：默认 enqueue 为 force，可 hasForcePending
    #[test]
    fn default_enqueue_is_force() {
        let mut q = AgentInputQueue::new();
        // 未显式指定模式 = force（InputEnqueueMode 默认值）
        q.enqueue(msg("hello"), InputEnqueueMode::default());
        assert!(q.has_force_pending());
        assert!(!q.has_steer_pending());
        assert!(!q.has_follow_up_pending());
        assert_eq!(q.dequeue().expect("应有 force 消息").text(), "hello");
        assert!(q.is_empty());
    }

    /// 05 §2.2：dequeue 顺序 force > steer，永不自动取 followUp
    #[test]
    fn dequeue_prefers_force_over_steer_never_follow_up() {
        let mut q = AgentInputQueue::new();
        q.enqueue_steer(msg("steer-1"));
        q.enqueue_force(msg("force-1"));
        q.enqueue_follow_up(msg("follow-1"));

        // force 优先
        assert_eq!(q.dequeue().expect("force 优先").text(), "force-1");
        // 再取 steer
        assert_eq!(q.dequeue().expect("steer 次之").text(), "steer-1");
        // followUp 永不自动取出
        assert!(q.dequeue().is_none());
        assert!(q.has_follow_up_pending(), "followUp 仍挂起");
    }

    /// 05 §2.2：enqueueFollowUp 不进入 dequeue / hasRunnablePending
    #[test]
    fn follow_up_does_not_block_current_run() {
        let mut q = AgentInputQueue::new();
        q.enqueue_follow_up(msg("follow-1"));
        assert!(!q.has_runnable_pending());
        assert!(q.has_pending());
        assert!(q.dequeue().is_none());
        assert_eq!(q.len(), 1);
    }

    /// 05 §2.2：promoteFollowUp 将 followUp 提升为 steer（idle 路径）
    #[test]
    fn promote_follow_up_moves_to_steer() {
        let mut q = AgentInputQueue::new();
        q.enqueue_follow_up(msg("follow-1"));
        q.enqueue_follow_up(msg("follow-2"));

        assert_eq!(q.promote_follow_up(), 2);
        assert!(!q.has_follow_up_pending());
        assert!(q.has_steer_pending());
        // 提升后 dequeue 可消费（保持 FIFO 顺序）
        assert_eq!(q.dequeue().expect("提升后可取").text(), "follow-1");
        assert_eq!(q.dequeue().expect("第二条").text(), "follow-2");
        assert!(q.dequeue().is_none());
    }

    /// 05 §2.2：pi 场景 — tool 批后可取 steer，followUp 仍挂起直至 idle promote
    #[test]
    fn tool_batch_safe_point_takes_steer_keeps_follow_up() {
        let mut q = AgentInputQueue::new();
        q.enqueue_steer(msg("steer-1"));
        q.enqueue_follow_up(msg("follow-1"));

        // tool 批后安全点：只消费 steer（hasRunnablePending）
        assert!(q.has_runnable_pending());
        assert_eq!(q.drain_steer()[0].text(), "steer-1");
        assert!(q.has_follow_up_pending(), "followUp 此时不应被消费");
        assert!(!q.has_runnable_pending());

        // 本将停止的 idle 点：promote 后消费
        assert_eq!(q.promote_follow_up(), 1);
        assert_eq!(q.dequeue().expect("promote 后可取").text(), "follow-1");
    }

    /// 容量语义：超容量覆盖最旧（不无界增长）
    #[test]
    fn ring_overwrites_oldest_when_full() {
        let mut rb: RingBuffer<u32> = RingBuffer::new(3);
        rb.push_overwriting_oldest(1);
        rb.push_overwriting_oldest(2);
        rb.push_overwriting_oldest(3);
        rb.push_overwriting_oldest(4);
        assert_eq!(rb.size(), 3, "满容量后不增长");
        assert_eq!(rb.shift(), Some(2), "最旧的 1 被覆盖");
        assert_eq!(rb.shift(), Some(3));
        assert_eq!(rb.shift(), Some(4));
        assert_eq!(rb.shift(), None);

        // 队列整体同样覆盖（容量 1000）
        let mut q = AgentInputQueue::new();
        for i in 0..(INPUT_QUEUE_CAPACITY + 50) {
            q.enqueue_force(msg(&format!("msg-{i}")));
        }
        assert_eq!(q.len(), INPUT_QUEUE_CAPACITY);
        // 最旧的 50 条被覆盖：队首应是 msg-50
        assert_eq!(
            q.dequeue().expect("队首").text(),
            "msg-50",
            "覆盖最旧后队首为第 50 条之后的第 1 条"
        );
    }

    /// peek 只预览不移除（force 优先，不含 followUp）
    #[test]
    fn peek_previews_force_first_without_removing() {
        let mut q = AgentInputQueue::new();
        assert!(q.peek().is_none());
        q.enqueue_steer(msg("steer-1"));
        q.enqueue_follow_up(msg("follow-1"));
        assert_eq!(q.peek().expect("peek steer").text(), "steer-1");
        q.enqueue_force(msg("force-1"));
        assert_eq!(q.peek().expect("peek force 优先").text(), "force-1");
        assert_eq!(q.len(), 3, "peek 不移除");
    }

    /// 谓词与清空
    #[test]
    fn predicates_and_clear() {
        let mut q = AgentInputQueue::new();
        assert!(q.is_empty());
        q.enqueue_steer(msg("steer-1"));
        assert!(q.has_steer_pending());
        q.enqueue_follow_up(msg("follow-1"));
        assert!(q.has_follow_up_pending());
        assert_eq!(q.len(), 2);
        q.clear();
        assert!(q.is_empty());
        assert!(!q.has_pending());
    }

    /// drain_steer 取出全部 steer 消息（T06.3 Q13：soft 兼容别名已删除）
    #[test]
    fn drain_steer_takes_all_steer_messages() {
        let mut q = AgentInputQueue::new();
        q.enqueue_steer(msg("s1"));
        q.enqueue_steer(msg("s2"));
        let drained = q.drain_steer();
        assert_eq!(drained.len(), 2);
        assert!(!q.has_steer_pending());
    }

    /// dequeue_force 只取 force 环
    #[test]
    fn dequeue_force_takes_only_force_ring() {
        let mut q = AgentInputQueue::new();
        q.enqueue_steer(msg("steer-1"));
        q.enqueue_force(msg("force-1"));
        assert_eq!(q.dequeue_force().expect("force 环").text(), "force-1");
        assert!(q.dequeue_force().is_none());
        assert!(q.has_steer_pending(), "steer 不受影响");
    }

    /// force 环输入可打断 stream、steer/followUp 不打断（01 §2.4 步骤 3）
    ///
    /// 谓词层面：streaming 打断判定只查 has_force_pending。
    #[test]
    fn only_force_interrupts_stream() {
        let mut q = AgentInputQueue::new();
        q.enqueue_steer(msg("steer-1"));
        q.enqueue_follow_up(msg("follow-1"));
        // 无 force：不打断
        assert!(!q.has_force_pending());
        // 注入 force：可打断
        q.enqueue_force(msg("force-1"));
        assert!(q.has_force_pending());
        assert_eq!(q.dequeue_force().expect("打断输入").text(), "force-1");
    }
}
