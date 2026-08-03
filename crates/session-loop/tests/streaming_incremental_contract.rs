//! PE-02 T02.1 契约测试锚点（冻结 v1，AU-04 F1）
//!
//! 本文件由 PE-02 落壳、**PE-09 T09.1.3 验收显式引用**（AU-04 F1）：
//! PE-09 填实现后可直接运行，本文件不得改名 / 移动。
//!
//! 契约正文 SoT：`docs/rust-rewrite/plans/PE-02-streaming-markdown-plan.md`
//! §3.1（冻结签名已落地 `crates/session-loop/src/provider.rs`）。
//!
//! 本轮落壳覆盖：
//! - 事件顺序（§3.1.2-1/-2）：TextDelta...→Stop 恰好一个，Stop 后无事件；
//! - 错误语义（§3.1.1）：流中 Err 条目之前的内容逐事件保留，Err 条目之后
//!   流立即结束（Err 后不得再有内容）；
//! - T3 取消保留（§3.1.2-4）：占位（`#[ignore]`，PE-09 T09.9 填充）。
//!
//! message-delta 级断言（§3.1.4 T2 收敛性：全文 == 全部 delta 拼接；
//! T4 传输错误 → 重试阶梯）由 PE-09 增量消费落地后补齐。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use agent_tools::registry::ToolRegistry;
use async_trait::async_trait;
use conex_test_utils::assertions::assert_message_delta_concatenation;
use conex_types::error::ProviderErrorKind;
use conex_types::events::AgentEvent;
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use conex_types::response::ClassifiedStreamError;
use conex_types::session::AgentEndReason;
use futures::StreamExt;
use session_loop::{
    AbortSignal, AgentSessionLoop, DeltaSink, ProviderCall, ProviderEventStream, ProviderRequest,
    ProviderStreamEvent, ProviderStreamItem, StopReason, TestProvider,
};

/// 信号注入槽：run 循环的 abort 信号在 loop 构造后才可取得
/// （`AgentSessionLoop::abort_signal()`），替身在 `stream()` 调用时
/// 从槽中解析（与主循环共享同一信号，T09.9 时序测试用）。
type SignalSlot = Arc<Mutex<Option<AbortSignal>>>;

/// 取槽内信号（缺失时 panic——测试注入时序错误即暴露）
fn take_signal(slot: &SignalSlot) -> AbortSignal {
    slot.lock()
        .unwrap()
        .clone()
        .expect("abort 信号应在 run 前注入信号槽")
}

/// T1 增量性 + 终止契约（§3.1.2）：delta...→stop 恰好一个，Stop 后无事件
#[tokio::test]
async fn deltas_flow_incrementally_then_exactly_one_stop() {
    let provider = TestProvider::new(vec![
        ProviderStreamEvent::text("你"),
        ProviderStreamEvent::text("好"),
        ProviderStreamEvent::text("，世界"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]);
    let request = ProviderRequest {
        messages: &[],
        tools: vec![],
        max_tokens: None,
        system_prompt: None,
    };
    let mut stream = provider.stream(&request).await.expect("流前不应有错误");
    let mut items = Vec::new();
    while let Some(item) = stream.next().await {
        items.push(item.expect("脚本化替身不产出流中错误"));
    }
    // 增量性（§3.1.2-1）：每个 TextDelta 以独立事件流出，禁止跨帧/跨块聚合
    let deltas: Vec<&str> = items
        .iter()
        .filter_map(|event| match event {
            ProviderStreamEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(deltas, vec!["你", "好", "，世界"], "增量片段逐事件流出");
    // 终止（§3.1.2-2）：每流恰好一个 Stop，且必须是最后一个事件
    let stops: Vec<_> = items
        .iter()
        .filter(|event| matches!(event, ProviderStreamEvent::Stop { .. }))
        .collect();
    assert_eq!(stops.len(), 1, "每流恰好一个 Stop");
    assert!(
        matches!(
            items.last(),
            Some(ProviderStreamEvent::Stop {
                reason: StopReason::Stop,
                ..
            })
        ),
        "Stop 必须是最后一个事件"
    );
    // 正常终止 = 事件序列结束：收集循环在 Stop 后自然终止，无多余事件
    assert_eq!(items.len(), 4, "Stop 之后无任何事件");
}

/// 流中错误注入替身：脚本化 `Ok/Err` 条目序列。
///
/// [TestProvider] 只产出 Ok 条目（流前错误走 with_error 族），流中错误契约
/// 需要独立替身覆盖（契约形状逐条对齐，PE-02 §3.1.1 错误语义）。
struct MidStreamErrorProvider;

#[async_trait]
impl ProviderCall for MidStreamErrorProvider {
    async fn stream<'a>(
        &self,
        _request: &ProviderRequest<'a>,
    ) -> Result<ProviderEventStream, ClassifiedStreamError> {
        // 脚本：Ok(delta) → Ok(delta) → Err(Timeout) → Ok(delta)（不得出现）。
        // take(3)：Err 条目本身是最后一条，Err 之后流必须立即结束（§3.1.1）
        let items: Vec<ProviderStreamItem> = vec![
            Ok(ProviderStreamEvent::text("已产出内容")),
            Ok(ProviderStreamEvent::text("，保留到错误前")),
            Err(ClassifiedStreamError {
                kind: ProviderErrorKind::Timeout,
                message: "流中空闲超时".to_string(),
                retryable: true,
                retry_after_ms: None,
            }),
            Ok(ProviderStreamEvent::text("Err 后不得再有内容")),
        ];
        let stream = futures::stream::iter(items).take(3);
        Ok(Box::pin(stream))
    }
}

/// 错误语义（§3.1.1）：已产出内容后的流中 Err 终止流，Err 之后不得再有内容
#[tokio::test]
async fn mid_stream_error_ends_stream_after_content() {
    let provider = MidStreamErrorProvider;
    let request = ProviderRequest {
        messages: &[],
        tools: vec![],
        max_tokens: None,
        system_prompt: None,
    };
    let mut stream = provider.stream(&request).await.expect("流前不应有错误");
    let mut items = Vec::new();
    while let Some(item) = stream.next().await {
        items.push(item);
    }
    assert_eq!(items.len(), 3, "Err 条目之后流必须立即结束");
    assert!(
        matches!(&items[0], Ok(ProviderStreamEvent::TextDelta { text }) if text == "已产出内容"),
        "错误前的增量片段逐事件保留"
    );
    assert!(
        matches!(&items[1], Ok(ProviderStreamEvent::TextDelta { text }) if text == "，保留到错误前"),
        "错误前的增量片段逐事件保留"
    );
    match &items[2] {
        Err(classified) => {
            // 分类语义（02 §4.2）：传输层错误已分类，Timeout 属瞬态类可重试
            assert_eq!(classified.kind, ProviderErrorKind::Timeout);
            assert!(classified.retryable, "Timeout 可重试");
        }
        other => panic!("第 3 个条目应为流中 Err，实际 {other:?}"),
    }
}

/// T3 取消保留（§3.1.2-4，PE-09 T09.9 填充）：流中途置 abort → 已 emit
/// 的 delta 全部保留，收场为 aborted 且内容不丢（partial salvage，
/// stream.rs:294-316）。
///
/// Q21 时序断言（T09.9）：
/// - 及时中断：abort 后消费方在下一 item 边界停收并丢弃流（后续拉取
///   不发生，`polled_after_abort` 保持 false）；
/// - 部分保留：abort 前已 emit 的 delta 逐条保留，收场 aborted。
#[tokio::test]
async fn abort_contract_placeholder() {
    let signal_slot: SignalSlot = Arc::new(Mutex::new(None));
    let polled_after_abort = Arc::new(AtomicBool::new(false));
    let provider = AbortMidStreamProvider {
        script: vec![
            ProviderStreamEvent::text("你"),
            ProviderStreamEvent::text("好"),
            ProviderStreamEvent::text("，世界"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        abort_after: 2,
        signal_slot: signal_slot.clone(),
        polled_after_abort: polled_after_abort.clone(),
    };
    let mut loop_ = loop_with(Box::new(provider));
    // 注入 run 循环自身的 abort 信号（与主循环共享同一信号）
    *signal_slot.lock().unwrap() = Some(loop_.abort_signal());
    let outcome = loop_.run(user("生成内容")).await;

    // 收场为 aborted（partial salvage，01 §2.4 步骤 5）
    assert_eq!(outcome.reason, AgentEndReason::Aborted);
    // 已 emit 的 delta 全部保留：abort 前两条（"你"、"好"）逐条落盘
    let partial = outcome
        .messages
        .iter()
        .find(|m| m.role == AgentMessageRole::Assistant)
        .expect("已 emit 的内容应已 commit");
    assert_eq!(partial.text(), "你好", "abort 前已 emit 的 delta 全部保留");
    // 及时中断：abort 后流被丢弃，不发生多余拉取（不继续消费剩余条目）
    assert!(
        !polled_after_abort.load(Ordering::SeqCst),
        "abort 后应及时丢弃流，不得继续拉取"
    );
    // 消息带 aborted 标注（stopReason=aborted，partial salvage 标注一致）
    assert_eq!(
        partial
            .metadata
            .as_ref()
            .and_then(|m| m.get("stopReason"))
            .and_then(|s| s.as_str()),
        Some("aborted")
    );
}

/// 流中 abort 协作替身（Q21/T09.9）：脚本事件逐条产出，产到第
/// `abort_after` 条时先触发 abort 再产出该条目——消费方须在下一 item
/// 边界及时停收（丢弃流）；若消费方继续拉取，`polled_after_abort` 置位。
struct AbortMidStreamProvider {
    script: Vec<ProviderStreamEvent>,
    abort_after: usize,
    signal_slot: SignalSlot,
    polled_after_abort: Arc<AtomicBool>,
}

#[async_trait]
impl ProviderCall for AbortMidStreamProvider {
    async fn stream<'a>(
        &self,
        _request: &ProviderRequest<'a>,
    ) -> Result<ProviderEventStream, ClassifiedStreamError> {
        let script = self.script.clone();
        let abort_after = self.abort_after;
        let signal = take_signal(&self.signal_slot);
        let polled = self.polled_after_abort.clone();
        let stream = futures::stream::unfold(0usize, move |emitted| {
            let script = script.clone();
            let signal = signal.clone();
            let polled = polled.clone();
            async move {
                if emitted >= script.len() {
                    return None;
                }
                if emitted > abort_after {
                    // 消费方越过了 abort 边界继续拉取（无修复时的信号）
                    polled.store(true, Ordering::SeqCst);
                }
                if emitted == abort_after {
                    // 产出该条目前触发 abort（流中取消注入）
                    signal.abort();
                }
                let event = script[emitted].clone();
                Some((Ok(event), emitted + 1))
            }
        });
        Ok(Box::pin(stream))
    }
}

/// Q33（T09.9）：consume 完成瞬间 abort（流结束前触发）→ 已 commit 消息
/// 仍带 stopReason=aborted 标注（partial salvage 标注一致性，AA-01 Q33）。
///
/// 替身在流结束（返回 None）前触发 abort——消费方最后一次 `next()`
/// 拉取返回 None 后重读 abort 信号，标注不得漏标为正常终态。
#[tokio::test]
async fn abort_at_stream_end_still_annotates_aborted() {
    let signal_slot: SignalSlot = Arc::new(Mutex::new(None));
    let provider = AbortAtStreamEndProvider {
        script: vec![
            ProviderStreamEvent::text("流结束瞬间被取消的内容"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        signal_slot: signal_slot.clone(),
    };
    let mut loop_ = loop_with(Box::new(provider));
    // 注入 run 循环自身的 abort 信号（与主循环共享同一信号）
    *signal_slot.lock().unwrap() = Some(loop_.abort_signal());
    let outcome = loop_.run(user("生成内容")).await;

    assert_eq!(outcome.reason, AgentEndReason::Aborted);
    let message = outcome
        .messages
        .iter()
        .find(|m| m.role == AgentMessageRole::Assistant)
        .expect("已流出的内容应已 commit");
    // 内容保留 + aborted 标注（consume 后重读 abort 的判定生效）
    assert_eq!(message.text(), "流结束瞬间被取消的内容");
    assert_eq!(
        message
            .metadata
            .as_ref()
            .and_then(|m| m.get("stopReason"))
            .and_then(|s| s.as_str()),
        Some("aborted"),
        "consume 完成瞬间触发 abort 时消息不得漏标 stopReason=aborted"
    );
    assert_eq!(
        message
            .metadata
            .as_ref()
            .and_then(|m| m.get("aborted"))
            .and_then(|a| a.as_bool()),
        Some(true)
    );
}

/// 流结束瞬间 abort 替身（Q33/T09.9）：脚本事件全部产出后，在流结束
/// （返回 None）前触发 abort——覆盖「consume 完成瞬间 abort」竞速窗口。
struct AbortAtStreamEndProvider {
    script: Vec<ProviderStreamEvent>,
    signal_slot: SignalSlot,
}

#[async_trait]
impl ProviderCall for AbortAtStreamEndProvider {
    async fn stream<'a>(
        &self,
        _request: &ProviderRequest<'a>,
    ) -> Result<ProviderEventStream, ClassifiedStreamError> {
        let script = self.script.clone();
        let signal = take_signal(&self.signal_slot);
        let stream = futures::stream::unfold(0usize, move |emitted| {
            let script = script.clone();
            let signal = signal.clone();
            async move {
                if emitted >= script.len() {
                    // 流结束瞬间触发 abort（consume 前的竞速窗口注入）
                    signal.abort();
                    return None;
                }
                let event = script[emitted].clone();
                Some((Ok(event), emitted + 1))
            }
        });
        Ok(Box::pin(stream))
    }
}

/// 挂起流替身（Q21/T09.9）：产出首条内容后永久挂起（模拟 provider
/// 卡死 / 慢流）——验证 abort 竞速能中断挂起的读取，而非等传输层超时。
struct StallingProvider;

#[async_trait]
impl ProviderCall for StallingProvider {
    async fn stream<'a>(
        &self,
        _request: &ProviderRequest<'a>,
    ) -> Result<ProviderEventStream, ClassifiedStreamError> {
        let stream = futures::stream::unfold(0usize, move |emitted| async move {
            if emitted == 0 {
                return Some((Ok(ProviderStreamEvent::text("首条内容")), 1));
            }
            // 后续永久挂起（不返回任何条目）
            std::future::pending::<Option<(ProviderStreamItem, usize)>>().await
        });
        Ok(Box::pin(stream))
    }
}

/// Q21（T09.9）：挂起流 + abort → 及时中断（不等传输层超时），
/// 首条内容保留（partial salvage）
#[tokio::test]
async fn abort_interrupts_stalled_stream_promptly() {
    let provider = StallingProvider;
    let mut loop_ = loop_with(Box::new(provider));
    let abort = loop_.abort_signal();

    let handle = tokio::spawn(async move { loop_.run(user("生成内容")).await });
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    abort.abort();
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(2), handle)
        .await
        .expect("abort 应中断挂起的读取，不得等传输层超时")
        .expect("run 不应 panic");

    assert_eq!(outcome.reason, AgentEndReason::Aborted);
    let partial = outcome
        .messages
        .iter()
        .find(|m| m.role == AgentMessageRole::Assistant)
        .expect("首条内容应已 commit");
    assert_eq!(partial.text(), "首条内容", "abort 前已产出内容保留");
}

/// 构造用户消息
fn user(text: &str) -> AgentMessage {
    AgentMessage {
        id: format!("user-{text}"),
        role: AgentMessageRole::User,
        created_at: "2026-01-01T00:00:00Z".into(),
        blocks: vec![AgentMessageBlock::Text { text: text.into() }],
        metadata: None,
        client_message_id: None,
        content: None,
    }
}

/// 构造无工具的会话循环
fn loop_with(provider: Box<dyn ProviderCall>) -> AgentSessionLoop {
    AgentSessionLoop::new(
        "sess-1",
        "run-1",
        16,
        provider,
        Arc::new(ToolRegistry::new()),
    )
}

// ══════════════════════ T09.1 实时双轨（PE-09 步骤 4）══════════════════════

/// 记录型 DeltaSink（断言实时轨收到的 delta 序列）
struct RecordingDeltaSink(Arc<Mutex<Vec<AgentEvent>>>);

impl DeltaSink for RecordingDeltaSink {
    fn push(&self, delta: AgentEvent) {
        self.0.lock().unwrap().push(delta);
    }
}

/// T09.1 双轨：实时轨 delta 逐事件到达（顺序 = 脚本产出顺序，message_id
/// 与收口消息对齐）；收口轨 state.events 的 message-start → message-delta*
/// → message-end 序列完整（01 §五.6，供持久化与序列记账）
#[tokio::test]
async fn realtime_sink_receives_deltas_and_collected_sequence_stays_intact() {
    let recorded = Arc::new(Mutex::new(Vec::new()));
    let provider = TestProvider::new(vec![
        ProviderStreamEvent::text("你"),
        ProviderStreamEvent::thought("思考中", Some(true)),
        ProviderStreamEvent::text("好"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]);
    let mut loop_ = loop_with(Box::new(provider));
    loop_ = loop_.with_delta_sink(Arc::new(RecordingDeltaSink(recorded.clone())));
    let outcome = loop_.run(user("实时双轨")).await;

    // 实时轨：delta 序列与脚本产出顺序一致（text/thought 交替逐事件）
    let sink_events = recorded.lock().unwrap().clone();
    let sink_blocks: Vec<&AgentMessageBlock> = sink_events
        .iter()
        .map(|event| match event {
            AgentEvent::MessageDelta { block, .. } => block,
            other => panic!("实时轨只应收到 message-delta，实际 {other:?}"),
        })
        .collect();
    assert_eq!(sink_blocks.len(), 3, "实时轨逐事件收到全部 3 条 delta");
    assert!(matches!(sink_blocks[0], AgentMessageBlock::Text { text } if text == "你"));
    assert!(matches!(sink_blocks[1], AgentMessageBlock::Thought { text, redacted } if text == "思考中" && *redacted == Some(true)));
    assert!(matches!(sink_blocks[2], AgentMessageBlock::Text { text } if text == "好"));

    // 收口轨：user 消息（start/end 成对无 delta）+ assistant 消息
    // （message-start → message-delta* → message-end，01 §五.6 序列契约）
    let positions: Vec<&str> = outcome
        .events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::MessageStart { .. } => Some("start"),
            AgentEvent::MessageDelta { .. } => Some("delta"),
            AgentEvent::MessageEnd { .. } => Some("end"),
            _ => None,
        })
        .collect();
    // 收口 delta 按消息 block 构建：thought 块 + 整段正文块（2 条）
    assert_eq!(positions, vec!["start", "end", "start", "delta", "delta", "end"]);

    // message_id 对齐：实时 delta / message-start / message-end 同一 id
    // （user 消息成对在前，assistant 消息族从首个 assistant-start 起）
    let mut ids: Vec<String> = Vec::new();
    for event in &outcome.events {
        match event {
            AgentEvent::MessageStart { message, .. } => ids.push(message.id.clone()),
            AgentEvent::MessageEnd { message, .. } => ids.push(message.id.clone()),
            AgentEvent::MessageDelta { message_id, .. } => ids.push(message_id.clone()),
            _ => {}
        }
    }
    assert_eq!(ids.len(), 6, "user 对 + assistant 族（start/delta/delta/end）");
    let first_assistant = ids[2].clone();
    assert!(
        ids[2..].iter().all(|id| *id == first_assistant),
        "收口流 message_id 三处对齐：{ids:?}"
    );
    assert!(
        sink_events.iter().all(|event| matches!(
            event,
            AgentEvent::MessageDelta { message_id, .. } if *message_id == first_assistant
        )),
        "实时 delta 的 message_id 与收口消息一致"
    );

    // 收敛性（PE-02 §3.1.4 T2）：实时正文 delta 拼接 == 收口消息全文
    let message = outcome
        .messages
        .iter()
        .find(|m| m.role == AgentMessageRole::Assistant)
        .expect("应 commit assistant 消息");
    assert_message_delta_concatenation(&sink_events, &message.text());
    assert_eq!(message.text(), "你好");
}

/// T09.1 双轨：未注入 DeltaSink 时收口序列仍完整（message-end 必达——
/// 丢帧/无实时通道路径下前端以 message-end 全文兜底）
#[tokio::test]
async fn collected_sequence_intact_without_sink() {
    let provider = TestProvider::new(vec![
        ProviderStreamEvent::text("无 sink 的正文"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]);
    let outcome = loop_with(Box::new(provider)).run(user("无 sink")).await;
    let positions: Vec<&str> = outcome
        .events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::MessageStart { .. } => Some("start"),
            AgentEvent::MessageDelta { .. } => Some("delta"),
            AgentEvent::MessageEnd { .. } => Some("end"),
            _ => None,
        })
        .collect();
    // user 消息（start/end 成对）+ assistant 消息（start → delta → end）
    assert_eq!(positions, vec!["start", "end", "start", "delta", "end"]);
    let end = outcome
        .events
        .iter()
        .find(|e| {
            matches!(e, AgentEvent::MessageEnd { message, .. }
                if message.role == AgentMessageRole::Assistant)
        })
        .expect("assistant message-end 必达");
    match end {
        AgentEvent::MessageEnd { message, .. } => {
            assert_eq!(message.text(), "无 sink 的正文");
        }
        other => panic!("期望 message-end，实际 {other:?}"),
    }
}
