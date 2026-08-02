//! 长会话压力测试（PE-11 T11.6.1，验证 AA-06 P3/P4 优化生效）
//!
//! 场景与断言：
//! - 100 / 1000 / 5000 条历史消息会话的单 run：耗时上界（宽松、机器无关）
//!   与请求链零拷贝验证（`Arc::ptr_eq` 身份共享——旧形态每轮
//!   `conversation.clone()` 深拷贝必破身份断言）；
//! - 记录路径零拷贝：user/assistant 消息的 message-start/end 事件载荷与
//!   收口对话同一 Arc 实例（record_message 0 深克隆）；
//! - 多轮续跑（跨 run goal 续轮）：跨 run 请求链 Arc 身份保持（40 轮
//!   累计深拷贝在 O(n²) 旧形态下必破）。
//!
//! 运行方式（release，显式跑；默认不进常规 CI）：
//!   cargo test -p session-loop --release --test stress_long_session -- --ignored --nocapture

use std::sync::Arc;
use std::time::{Duration, Instant};

use agent_tools::registry::ToolRegistry;
use async_trait::async_trait;
use conex_types::events::AgentEvent;
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use conex_types::response::ClassifiedStreamError;
use conex_types::session::AgentEndReason;
use session_loop::{
    AgentSessionLoop, ProviderCall, ProviderEventStream, ProviderRequest, ProviderStreamEvent,
    RunOutcome, StopReason, TestProvider,
};

/// 构造历史消息（user/assistant 交替，正文带体积用于放大对话克隆成本）
fn history_message(i: u32) -> AgentMessage {
    AgentMessage {
        id: format!("hist-{i}"),
        role: if i.is_multiple_of(2) {
            AgentMessageRole::User
        } else {
            AgentMessageRole::Assistant
        },
        created_at: "2026-01-01T00:00:00Z".into(),
        blocks: vec![AgentMessageBlock::Text {
            text: format!("历史消息 {i} 的正文内容，用于放大长会话的体积"),
        }],
        metadata: None,
        client_message_id: None,
        content: None,
    }
}

/// 构造用户输入消息
fn user(text: &str) -> AgentMessage {
    AgentMessage {
        id: format!("user-{text}"),
        role: AgentMessageRole::User,
        created_at: "2026-01-01T00:00:00Z".into(),
        blocks: vec![AgentMessageBlock::Text {
            text: text.into(),
        }],
        metadata: None,
        client_message_id: None,
        content: None,
    }
}

/// Arc 包装替身（T09.3 零拷贝断言入口）：共享 TestProvider 的请求记录——
/// run 结束后仍可查询 `request_message_arcs` 与收口对话做 `Arc::ptr_eq`
struct ArcTestProvider(Arc<TestProvider>);

#[async_trait]
impl ProviderCall for ArcTestProvider {
    async fn stream<'a>(
        &self,
        request: &ProviderRequest<'a>,
    ) -> Result<ProviderEventStream, ClassifiedStreamError> {
        self.0.stream(request).await
    }
}

/// 构造带 Arc 替身的循环（空工具注册表，纯对话路径）
fn loop_with_arc(handle: Arc<TestProvider>) -> AgentSessionLoop {
    AgentSessionLoop::new(
        "stress-session",
        "stress-run",
        16,
        Box::new(ArcTestProvider(handle)),
        Arc::new(ToolRegistry::new()),
    )
}

/// 请求链零拷贝断言：请求快照的每条消息与收口对话对应条目**同一 Arc 实例**
///
/// 旧形态（AA-06 P3）每轮 `build_request` 深拷贝整个对话，身份共享必破；
/// 本断言全绿即证明请求构建 0 深拷贝（O(n²) 总克隆 → O(n) 引用计数）。
fn assert_request_chain_zero_copy(
    provider: &Arc<TestProvider>,
    call_index: usize,
    outcome_messages: &[Arc<AgentMessage>],
    expected_len: usize,
) {
    let arcs = provider.request_message_arcs(call_index);
    assert_eq!(
        arcs.len(),
        expected_len,
        "请求应含全部历史 + 用户消息（第 {call_index} 次调用）"
    );
    for (i, arc) in arcs.iter().enumerate() {
        assert!(
            Arc::ptr_eq(arc, &outcome_messages[i]),
            "请求链消息 {i} 必须与收口对话共享同一 Arc（0 深拷贝，O(n²) 旧形态必破）"
        );
    }
}

/// 记录路径零拷贝断言：user/assistant 的 message-start/end 事件载荷与
/// 收口对话对应条目同一 Arc 实例（record_message 0 深克隆，AA-06 P4）
fn assert_event_record_zero_copy(outcome: &RunOutcome) {
    let mut event_arcs: Vec<&Arc<AgentMessage>> = Vec::new();
    for event in &outcome.events {
        match event {
            AgentEvent::MessageStart { message, .. } | AgentEvent::MessageEnd { message, .. } => {
                event_arcs.push(message);
            }
            _ => {}
        }
    }
    // 最后两条为本次 run 的 user 与 assistant（前面是历史，不产事件）
    let user_index = outcome.messages.len() - 2;
    let assistant_index = outcome.messages.len() - 1;
    assert_eq!(event_arcs.len(), 4, "user/assistant 各 start+end 一对");
    for (label, event_arc, message_index) in [
        ("user start", event_arcs[0], user_index),
        ("user end", event_arcs[1], user_index),
        ("assistant start", event_arcs[2], assistant_index),
        ("assistant end", event_arcs[3], assistant_index),
    ] {
        assert!(
            Arc::ptr_eq(event_arc, &outcome.messages[message_index]),
            "记录路径 {label} 必须与收口对话共享同一 Arc（record_message 0 深克隆）"
        );
    }
}

/// 长会话 100 条消息：耗时上界 + 请求链/记录路径零拷贝
#[tokio::test]
#[ignore]
async fn stress_long_session_100_messages() {
    let history: Vec<AgentMessage> = (0..100).map(history_message).collect();
    let provider = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("回复"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let mut loop_ = loop_with_arc(provider.clone());
    loop_ = loop_.with_initial_conversation(history);

    let started = Instant::now();
    let outcome = loop_.run(user("你好")).await;
    let elapsed = started.elapsed();

    assert_eq!(outcome.reason, AgentEndReason::Stop);
    assert_eq!(outcome.messages.len(), 102, "100 条历史 + user + assistant");
    assert_request_chain_zero_copy(&provider, 0, &outcome.messages, 101);
    assert_event_record_zero_copy(&outcome);
    assert!(
        elapsed < Duration::from_secs(5),
        "100 消息长会话 run 超时（宽松上界）：{elapsed:?}"
    );
    println!("[stress] 100 消息长会话 run 耗时：{elapsed:?}，收口消息 {} 条", outcome.messages.len());
}

/// 长会话 1000 条消息：耗时上界（宽松）+ 零拷贝断言（P3 优化的核心场景）
#[tokio::test]
#[ignore]
async fn stress_long_session_1000_messages() {
    let history: Vec<AgentMessage> = (0..1000).map(history_message).collect();
    let provider = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("回复"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let mut loop_ = loop_with_arc(provider.clone());
    loop_ = loop_.with_initial_conversation(history);

    let started = Instant::now();
    let outcome = loop_.run(user("你好")).await;
    let elapsed = started.elapsed();

    assert_eq!(outcome.reason, AgentEndReason::Stop);
    assert_eq!(outcome.messages.len(), 1002, "1000 条历史 + user + assistant");
    assert_request_chain_zero_copy(&provider, 0, &outcome.messages, 1001);
    assert_event_record_zero_copy(&outcome);
    assert!(
        elapsed < Duration::from_secs(20),
        "1000 消息长会话 run 超时（宽松上界）：{elapsed:?}"
    );
    println!("[stress] 1000 消息长会话 run 耗时：{elapsed:?}，收口消息 {} 条", outcome.messages.len());
}

/// 长会话 5000 条消息：报告模式——只统计耗时不断言上界（机器无关），
/// 零拷贝断言仍执行（确定性证明，不受机器影响）
#[tokio::test]
#[ignore]
async fn stress_long_session_5000_report_mode() {
    let history: Vec<AgentMessage> = (0..5000).map(history_message).collect();
    let provider = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("回复"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let mut loop_ = loop_with_arc(provider.clone());
    loop_ = loop_.with_initial_conversation(history);

    let started = Instant::now();
    let outcome = loop_.run(user("你好")).await;
    let elapsed = started.elapsed();

    assert_eq!(outcome.reason, AgentEndReason::Stop);
    assert_request_chain_zero_copy(&provider, 0, &outcome.messages, 5001);
    assert_event_record_zero_copy(&outcome);
    println!(
        "[stress] 5000 消息长会话 run 耗时：{elapsed:?}（报告模式，无耗时上界断言），收口消息 {} 条",
        outcome.messages.len()
    );
}

/// 多轮续跑（跨 run goal 续轮）：40 轮 × 每轮 +2 条消息——跨 run 请求链
/// Arc 身份保持断言（每轮请求携带上一轮全部消息且同一 Arc 实例；
/// O(n²) 旧形态下每轮深拷贝必破）。耗时只统计报告 + 宽松上界。
#[tokio::test]
#[ignore]
async fn stress_long_session_multi_run_continuation() {
    let provider = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("继续"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let mut loop_ = loop_with_arc(provider.clone());

    let started = Instant::now();
    let mut prev: Option<Vec<Arc<AgentMessage>>> = None;
    for round in 0..40u32 {
        let outcome = loop_.run(user(&format!("第 {round} 轮"))).await;
        assert_eq!(outcome.reason, AgentEndReason::Stop, "第 {round} 轮应以 stop 收场");

        // 第 2 轮起：请求快照必须包含上一轮全部消息，且逐条同一 Arc 实例
        if let Some(prev_messages) = &prev {
            let arcs = provider.request_message_arcs(round as usize);
            assert!(
                arcs.len() > prev_messages.len(),
                "第 {round} 轮请求应包含上一轮全部消息 + 本轮用户消息"
            );
            for (i, arc) in arcs.iter().take(prev_messages.len()).enumerate() {
                assert!(
                    Arc::ptr_eq(arc, &prev_messages[i]),
                    "跨 run 续接消息 {i} 必须同一 Arc 实例（零拷贝续接，O(n²) 旧形态必破）"
                );
            }
        }
        prev = Some(outcome.messages.clone());
        // 零拷贝续接：收口对话（Arc 形态）直接回填下一轮
        loop_ = loop_.with_initial_conversation_arc(prev.clone().expect("上一轮消息"));
    }
    let elapsed = started.elapsed();

    let total_messages = prev.as_ref().expect("至少一轮").len();
    assert!(
        elapsed < Duration::from_secs(60),
        "40 轮续跑超时（宽松上界）：{elapsed:?}"
    );
    println!(
        "[stress] 40 轮续跑（累计 {total_messages} 条消息）耗时：{elapsed:?}（{:.0} ms/轮）",
        elapsed.as_secs_f64() * 1000.0 / 40.0
    );
}
