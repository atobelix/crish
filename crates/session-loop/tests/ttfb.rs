//! PE-09 T09.7/T09.8 首 token 延迟测量（F1 三测量点的 Rust 侧两档）
//!
//! - **600ms 集成硬断言（F1 验收门）**：本地慢速流（首 token 500ms 延迟，
//!   总时长 5s）→ 首条 message-delta 到达事件桥（[DeltaSink]）时间
//!   **< 600ms**。改造前（全量缓冲）≈ 5s 整流读完才 emit；增量路径
//!   （T09.1）应为 ≈ 500ms + 处理开销。
//! - **300ms 内部基准（F1 记录项，不作验收门）**：流产出后 → 事件桥
//!   到达的 Rust 侧处理耗时（`stream.next()` + delta 构造 + `sink.push`），
//!   经 `--nocapture` 打印，记入 `docs/rust-rewrite/audits/PE-perf-baseline.md`。
//! - 端到端 500ms（前端 `requestToFirstChunkMs`）归 PE-02 T02.6 总验收，
//!   本文件不覆盖（G1 三测量点口径，无第四套数字）。
//!
//! 运行：`cargo test -p session-loop --test ttfb -- --nocapture`

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use agent_tools::registry::ToolRegistry;
use async_trait::async_trait;
use conex_types::events::AgentEvent;
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use conex_types::response::ClassifiedStreamError;
use session_loop::{
    DeltaSink, ProviderCall, ProviderEventStream, ProviderRequest, ProviderStreamEvent,
    StopReason,
};

/// 慢速流替身：按脚本逐条延时产出（首 token 500ms，总时长 5s）
///
/// `first_produced` 记录首条事件实际产出时刻（供 300ms 内部基准：
/// 流产出 → 事件桥的 Rust 侧处理耗时）。
struct SlowStreamProvider {
    script: Vec<(Duration, ProviderStreamEvent)>,
    first_produced: Arc<Mutex<Option<Instant>>>,
}

#[async_trait]
impl ProviderCall for SlowStreamProvider {
    async fn stream<'a>(
        &self,
        _request: &ProviderRequest<'a>,
    ) -> Result<ProviderEventStream, ClassifiedStreamError> {
        let script = self.script.clone();
        let first_produced = self.first_produced.clone();
        let stream = futures::stream::unfold(0usize, move |idx| {
            let script = script.clone();
            let first_produced = first_produced.clone();
            async move {
                let (delay, event) = script.get(idx)?;
                tokio::time::sleep(*delay).await;
                if idx == 0 {
                    // 首条事件产出时刻（流产出侧）
                    *first_produced.lock().unwrap() = Some(Instant::now());
                }
                Some((Ok(event.clone()), idx + 1))
            }
        });
        Ok(Box::pin(stream))
    }
}

/// 计时型 DeltaSink：逐条记录到达时刻与事件（事件桥等效消费端）
struct TimedDeltaSink {
    received: Arc<Mutex<Vec<(Instant, AgentEvent)>>>,
}

impl DeltaSink for TimedDeltaSink {
    fn push(&self, delta: AgentEvent) {
        self.received.lock().unwrap().push((Instant::now(), delta));
    }
}

/// 慢速流脚本：首 token 500ms 后逐 token 产出，Stop 收尾，总时长 ≈ 5s
fn slow_script() -> Vec<(Duration, ProviderStreamEvent)> {
    vec![
        (Duration::from_millis(500), ProviderStreamEvent::text("第一个 token")),
        (Duration::from_millis(1125), ProviderStreamEvent::text("，第二个")),
        (Duration::from_millis(1125), ProviderStreamEvent::text("，第三个")),
        (Duration::from_millis(1125), ProviderStreamEvent::text("，第四个")),
        (Duration::from_millis(1125), ProviderStreamEvent::stop(StopReason::Stop)),
    ]
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

/// 600ms 硬断言（F1）：慢速流（首 token 500ms，总时长 5s）下，首条
/// message-delta 到达事件桥（sink）< 600ms。
///
/// 全量缓冲实现（改造前）会等整个流读完（≈5s）才 emit——本断言即
/// 增量路径的守门测试（T09.1.3 验收项 2 的 Rust 侧等价锚点；
/// tauri 集成侧 BridgeDeltaSink 为同构薄包装，序列号 None 信封由
/// 契约测试覆盖）。
#[tokio::test]
async fn first_delta_reaches_sink_under_600ms_with_slow_stream() {
    let received = Arc::new(Mutex::new(Vec::new()));
    let first_produced = Arc::new(Mutex::new(None));
    let provider = SlowStreamProvider {
        script: slow_script(),
        first_produced: first_produced.clone(),
    };
    let mut loop_ = session_loop::AgentSessionLoop::new(
        "sess-ttfb",
        "run-ttfb",
        16,
        Box::new(provider),
        Arc::new(ToolRegistry::new()),
    );
    loop_ = loop_.with_delta_sink(Arc::new(TimedDeltaSink {
        received: received.clone(),
    }));

    let start = Instant::now();
    let handle = tokio::spawn(async move { loop_.run(user("慢速流")).await });

    // 轮询首条 delta 到达（5ms 间隔轮询，测量抖动 ≤ 5ms）
    let (arrival, first_event) = loop {
        if let Some(first) = received.lock().unwrap().first().cloned() {
            break first;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    };
    let to_sink = arrival.duration_since(start);

    // F1 硬断言：首条 delta 到达事件桥 < 600ms（首 token 500ms + 处理开销）
    assert!(
        to_sink < Duration::from_millis(600),
        "首条 delta 到达事件桥应 < 600ms，实际 {to_sink:?}（全量缓冲路径 ≈ 5s）"
    );
    // 增量性：首条 delta 即首个 token 片段（边收边发，非整块全文）
    match &first_event {
        AgentEvent::MessageDelta { block, .. } => {
            assert!(
                matches!(block, AgentMessageBlock::Text { text } if text == "第一个 token"),
                "首条 delta 应为首个增量片段，实际 {block:?}"
            );
        }
        other => panic!("事件桥首条应收到 message-delta，实际 {other:?}"),
    }
    println!(
        "[T09.7 首 token 观测] 慢速流（首 token 500ms / 总时长 5s）：首条 delta 到达事件桥 {to_sink:?}"
    );

    // 收口完整：流全部到达后正文 = 全部 delta 拼接（PE-02 §3.1.4 T2 收敛）
    let outcome = handle.await.expect("run 完成");
    let message = outcome
        .messages
        .iter()
        .find(|m| m.role == AgentMessageRole::Assistant)
        .expect("应 commit assistant 消息");
    assert_eq!(message.text(), "第一个 token，第二个，第三个，第四个");
    println!(
        "[T09.7 首 token 观测] 慢速流 run 总时长 {:?}（应 ≈ 5s 全时长，证明增量路径不缩短流）",
        start.elapsed()
    );

    // 300ms 内部基准（F1 记录项，不作断言）：流产出 → 事件桥的
    // Rust 侧处理耗时（next() + delta 构造 + sink.push）
    let produced = first_produced
        .lock()
        .unwrap()
        .expect("首条事件应已产出");
    let processing = arrival.duration_since(produced);
    println!(
        "[T09.7 首 token 内部基准] 流产出 → 事件桥到达处理耗时 {processing:?}（目标 ≤ 300ms，仅记录）"
    );
}
