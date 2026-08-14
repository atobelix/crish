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
use std::sync::atomic::{AtomicU64, Ordering};

use conex_types::message::AgentMessage;

/// 输入队列固定容量（对齐 TS INPUT_QUEUE_CAPACITY = 1000）
pub const INPUT_QUEUE_CAPACITY: usize = 1000;

/// 环形缓冲满容量覆盖次数（EV-12 输入留痕：容量保护正常工况不触发，
/// 触发即意味着待处理输入被丢弃——模块级计数供观测计数清单汇总；
/// 不新增事件（R-19 裁决：计数+日志满足「被丢弃输入可查」））
static INPUT_OVERWRITES: AtomicU64 = AtomicU64::new(0);

/// 读取满容量覆盖总次数（EV-12 覆盖留痕观测面）
pub fn input_overwrite_count() -> u64 {
    INPUT_OVERWRITES.load(Ordering::SeqCst)
}

/// 待处理输入持久化面（EV-12 输入留痕生产接线）
///
/// session-loop **不直接持 DB 连接**——经本 trait 注入（orchestrator 的
/// `Store` 适配实现：LocalDbStore / InMemoryStore，见 persist.rs），
/// spawn_blocking 纪律与 save_run_usage 同（DB 同步调用由实现方包在
/// async 边界内）。写点 = 三环队列 enqueue 入口（enqueue 落库，
/// INSERT OR REPLACE 幂等）；删点 = 消息出队被消费成为 message-start
/// 时删除；两者均 **fail-open**——DB 失败仅 warn 不阻断循环。
#[async_trait::async_trait]
pub trait PendingInputStore: Send + Sync {
    /// 保存一条待处理输入（id = 消息 id；INSERT OR REPLACE 幂等）
    async fn save_pending_input(
        &self,
        id: &str,
        session_id: &str,
        run_id: Option<&str>,
        payload: &str,
    ) -> Result<(), String>;

    /// 删除一条待处理输入（消息消费后；返回是否实际删除了行）
    async fn delete_pending_input(&self, id: &str) -> Result<bool, String>;
}

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

    /// 固定容量上限（EV-12 覆盖留痕判定用；与 [Self::new] 给定值一致）
    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// 清空
    pub fn clear(&mut self) {
        self.buf.clear();
    }
}

/// 正文预览截断（EV-12：warn 中仅带被覆盖消息正文前 120 **字符**，
/// 防长消息刷屏；id 不截断——id 是检索键）。按字符截断（chars().take），
/// 避免 UTF-8 中文按字节截断（120 字节 = 40 字）
fn text_preview_120(text: &str) -> String {
    text.chars().take(120).collect()
}

/// 入队并留痕（EV-12 覆盖留痕共用路径）。
///
/// 满容量覆盖最旧时：模块级计数 +1 且 warn（含被覆盖消息 id 与截断
/// 文本前 120 字符）——「被丢弃输入可查」；不新增事件（R-19 裁决，
/// 容量保护正常工况不触发）。
fn push_ring_traced(ring: &mut RingBuffer<AgentMessage>, message: AgentMessage) {
    if ring.size() == ring.capacity() {
        if let Some(oldest) = ring.peek_first() {
            INPUT_OVERWRITES.fetch_add(1, Ordering::SeqCst);
            tracing::warn!(
                target: "session_loop",
                message_id = %oldest.id,
                text_preview = %text_preview_120(&oldest.text()),
                "输入队列满容量：覆盖最旧待处理输入（容量 {}）",
                ring.capacity()
            );
        }
    }
    ring.push_overwriting_oldest(message);
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
            InputEnqueueMode::Steer => push_ring_traced(&mut self.steer_items, message),
            InputEnqueueMode::FollowUp => push_ring_traced(&mut self.follow_up_items, message),
            InputEnqueueMode::Force => push_ring_traced(&mut self.force_items, message),
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
        self.force_items
            .shift()
            .or_else(|| self.steer_items.shift())
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
            push_ring_traced(&mut self.steer_items, m);
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
    use std::io::Write;
    use std::sync::{Arc, Mutex};

    /// 覆盖相关测试串行锁：RingBuffer 覆盖会改模块级计数
    /// [super::INPUT_OVERWRITES]——同一文件测试并行跑时差值断言会被
    /// 并行测试的覆盖污染，持锁串行化保证计数断言确定性
    static OVERWRITE_TEST_LOCK: Mutex<()> = Mutex::new(());

    /// fmt writer：Arc 共享缓冲（仿 observability.rs LogCapture 基建）
    struct WriterFunc(Arc<Mutex<Vec<String>>>);

    impl Write for WriterFunc {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let text = String::from_utf8_lossy(buf);
            for line in text.lines() {
                self.0.lock().unwrap().push(line.to_string());
            }
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn msg(text: &str) -> AgentMessage {
        AgentMessage {
            id: format!("m-{text}"),
            role: conex_types::message::AgentMessageRole::User,
            created_at: "2026-01-01T00:00:00Z".into(),
            blocks: vec![conex_types::message::AgentMessageBlock::Text { text: text.into() }],
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
        // 与覆盖计数测试共享串行锁（本测试覆盖 50 次会污染计数差值断言）
        let _guard = OVERWRITE_TEST_LOCK.lock().unwrap();
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

    /// EV-12 覆盖留痕：满容量入队覆盖最旧 → 模块级计数 +1 且 warn
    /// 被捕获（含被覆盖消息 id 前缀；不新增事件——仅计数+日志）
    #[test]
    fn overwrite_increments_counter_and_emits_warn() {
        // 静态锁：与 ring_overwrites_oldest_when_full 串行化，保证覆盖
        // 计数值差精确 == 1（同一文件测试并行跑会互相干扰计数）
        let _guard = OVERWRITE_TEST_LOCK.lock().unwrap();
        let before = input_overwrite_count();
        let capture = Arc::new(Mutex::new(Vec::<String>::new()));
        let writer = capture.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(move || WriterFunc(writer.clone()))
            .with_max_level(tracing::Level::WARN)
            .with_ansi(false)
            .finish();
        let _guard_sub = tracing::subscriber::set_default(subscriber);

        let mut q = AgentInputQueue::new();
        for i in 0..(INPUT_QUEUE_CAPACITY + 1) {
            q.enqueue_force(msg(&format!("msg-{i}")));
        }
        // 满容量后恰好覆盖 1 条（最旧 msg-0）
        assert_eq!(q.len(), INPUT_QUEUE_CAPACITY);
        assert_eq!(
            q.peek().expect("队首").text(),
            "msg-1",
            "最旧的 msg-0 被覆盖"
        );
        assert_eq!(
            input_overwrite_count(),
            before + 1,
            "覆盖计数必须精确 +1（计数为模块级累计，差值断言在串行锁下成立）"
        );

        let lines = capture.lock().unwrap().clone();
        assert!(
            lines
                .iter()
                .any(|l| l.contains("msg-0") && l.contains("覆盖最旧")),
            "warn 必须含被覆盖消息 id：{lines:?}"
        );
    }

    /// EV-12 覆盖留痕：warn 正文预览截断前 120 字符（长消息不刷屏）；
    /// 截断函数为纯函数，直接断言
    #[test]
    fn overwrite_warn_text_preview_truncates_to_120_chars() {
        let long = "长".repeat(500);
        assert_eq!(
            text_preview_120(&long).chars().count(),
            120,
            "预览必须截断至 120 字符"
        );
        let short = "短";
        assert_eq!(text_preview_120(short), short, "短文本不截断");
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
