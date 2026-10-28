//! T-33 集成测试：预算钳制 + 预检压缩 + 事件广播 + 护栏（P4 阶段 2-3/3-2/3-3）
//!
//! 走真实 run 链路（AgentSessionLoop + TestProvider），断言：
//! - 预检触发：大对话超阈值 → prepare_turn 内压缩一次，事件成对广播，
//!   对话被压缩（摘要占位 + 保留段），End 载荷 tokens_after < tokens_before；
//! - 预算钳制：只配预算不配压缩策略 → 请求 max_tokens 被钳到
//!   window - estimate - safety（C9 口径估算）；
//! - 下限保护：可用输出预算低于下限（256）→ 不钳制（保持 8192）；
//! - 不触发：小对话 → 无压缩事件、max_tokens 原值透传。
//!
//! 时间戳护栏与单 run 上限的内部计数断言见 handlers/mod.rs 单测
//! （LoopState 为 pub(crate)，集成测试不可见）。

use std::sync::Arc;

use agent_tools::registry::ToolRegistry;
use conex_compaction::CompactionPolicy;
use conex_types::context::ContextBudget;
use conex_types::events::AgentEvent;
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use session_loop::r#loop::AgentEndReason;
use conex_types::tool::ContextCompressionRecord;
use session_loop::{
    AgentSessionLoop, ProviderCall, ProviderEventStream, ProviderRequest, SessionLoopOptions,
    TestProvider,
};

/// 构造用户消息
fn user(text: &str) -> AgentMessage {
    AgentMessage {
        id: format!("user-{text}"),
        role: AgentMessageRole::User,
        created_at: "2026-08-03T10:00:00.000Z".into(),
        blocks: vec![AgentMessageBlock::Text { text: text.into() }],
        metadata: None,
        client_message_id: None,
        content: None,
    }
}

/// 长用户消息（3418 字 ≈ 4961 token）：把估算推到窗口边缘，钳制必生效
///
/// 口径（conex-compaction tokens.rs，BLK-09 对齐）：CJK 逐字符 1.45 权重
/// （3418 × 1.45 = 4956.1 → ceil 4957）+ 单条 Wire framing 4 = 4961 token
fn user_long() -> AgentMessage {
    user(&"字".repeat(3_418))
}

/// 超阈值历史对话：10 条 × 3448 字（CJK 1.45 权重口径：3448 × 1.45 =
/// 4999.6 → 5000，+4 framing = 5004 token/条）≈ 5 万 token；
/// 角色交替（user/assistant），末条为 assistant 前的 user/assistant 对
/// 满足 min_recent_turns 完整回合要求
fn big_conversation() -> Vec<Arc<AgentMessage>> {
    (0..10)
        .map(|i| {
            Arc::new(AgentMessage {
                id: format!("m{i}"),
                role: if i % 2 == 0 {
                    AgentMessageRole::User
                } else {
                    AgentMessageRole::Assistant
                },
                created_at: "2026-08-03T10:00:00.000Z".to_string(),
                blocks: vec![AgentMessageBlock::Text {
                    text: "字".repeat(3_448),
                }],
                metadata: None,
                client_message_id: None,
                content: None,
            })
        })
        .collect()
}

/// 默认窗口预算（64000/16384/4096，P4 §3.3.2 Default）
fn default_budget() -> ContextBudget {
    ContextBudget::default()
}

/// 默认压缩策略（keep_recent_tokens 20000 / min_recent_turns 2，P4 §3.4.2）
fn default_policy() -> CompactionPolicy {
    CompactionPolicy::default()
}

/// Arc 包装替身：run 结束后仍可查询请求快照（requests 记录在 TestProvider
/// 内部，Arc 共享跨 run 存活，对齐 tests/prefix_stability.rs 既有模式）
struct ArcTestProvider(Arc<TestProvider>);

#[async_trait::async_trait]
impl ProviderCall for ArcTestProvider {
    async fn stream<'a>(
        &self,
        request: &ProviderRequest<'a>,
    ) -> Result<ProviderEventStream, conex_types::response::ClassifiedStreamError> {
        self.0.stream(request).await
    }
}

/// 从事件列表取压缩记录（断言辅助）
fn find_compression_record(events: &[AgentEvent]) -> Option<ContextCompressionRecord> {
    events.iter().find_map(|e| match e {
        AgentEvent::ContextCompressionEnd {
            result: Some(record),
            ..
        } => Some(record.clone()),
        _ => None,
    })
}

/// 预检触发 + 事件广播 + 对话替换：大对话超阈值（估算 = 10×5004 + 7 +
/// 1 ≈ 50048 ≥ window - reserve = 47616，CJK 1.45 权重口径）→
/// prepare_turn 内同步压缩一次
#[tokio::test]
async fn preflight_compaction_triggers_and_broadcasts_events() {
    let provider = Arc::new(TestProvider::text_reply("收尾回复"));
    let mut loop_ = AgentSessionLoop::new(
        "s1",
        "r1",
        16,
        Box::new(ArcTestProvider(provider.clone())),
        Arc::new(ToolRegistry::new()),
    )
    .with_options({
        let mut o: SessionLoopOptions = SessionLoopOptions::default();
        o.assembly.context_budget = Some(default_budget());
        o.compaction.compaction_policy = Some(default_policy());
        o.compaction.compact_allow_stub_fallback = true;
        o
    })
    .with_initial_conversation_arc(big_conversation());

    let outcome = loop_.run(user("继续")).await;
    assert_eq!(outcome.reason, AgentEndReason::YieldSuspended);

    // 事件成对广播（既有 session-loop 事件机制：state.events 累加 → RunOutcome）
    let starts = outcome
        .events
        .iter()
        .filter(|e| matches!(e, AgentEvent::ContextCompressionStart { .. }))
        .count();
    let ends = outcome
        .events
        .iter()
        .filter(|e| matches!(e, AgentEvent::ContextCompressionEnd { .. }))
        .count();
    assert_eq!(starts, 1, "预检压缩必须广播 start 事件");
    assert_eq!(
        ends, 1,
        "预检压缩必须广播 end 事件（单 run 上限内只压缩一次）"
    );

    // End 载荷 = CompactionPlan 字段（触发点 threshold / token 数 / id 清单）
    let record = find_compression_record(&outcome.events).expect("End 必须携带 record");
    assert!(
        record.tokens_after < record.tokens_before,
        "压缩后 token 必须减少"
    );
    assert_eq!(
        record.compressed_message_ids.len(),
        6,
        "丢弃 6 条消息（默认策略保留段从 m6 起）"
    );
    assert_eq!(record.first_kept_message_id.as_deref(), Some("m6"));
    assert_eq!(
        record.trigger,
        conex_types::tool::ContextCompressionTrigger::Threshold
    );

    // 对话替换：摘要占位（compacted-summary 前缀）+ 保留段 + 本轮回复
    assert!(
        outcome
            .messages
            .iter()
            .any(|m| m.id.starts_with("compacted-summary")),
        "压缩后对话必须含摘要占位消息"
    );
    assert!(
        outcome
            .messages
            .iter()
            .any(|m| m.id == "m6" && m.role == AgentMessageRole::User),
        "保留段首条（m6）必须保留"
    );
}

/// 预算钳制：只配预算不配压缩策略（预检不触发）→ 请求 max_tokens 被钳到
/// window - estimate - safety = 64000 - 55002 - 4096 = 4902（CJK 1.45
/// 权重口径：估算 = 10×5004 + 4961 + 1）
#[tokio::test]
async fn max_tokens_clamped_by_estimate_without_compaction() {
    let provider = Arc::new(TestProvider::text_reply("好"));
    let mut loop_ = AgentSessionLoop::new(
        "s1",
        "r1",
        16,
        Box::new(ArcTestProvider(provider.clone())),
        Arc::new(ToolRegistry::new()),
    )
    .with_options({
        let mut o: SessionLoopOptions = SessionLoopOptions::default();
        o.assembly.context_budget = Some(default_budget());
        o.compaction.compaction_policy = None;
        o
    })
    .with_initial_conversation_arc(big_conversation());

    let outcome = loop_.run(user_long()).await;
    assert_eq!(outcome.reason, AgentEndReason::YieldSuspended);

    // 未配置压缩策略 → 不预检（无压缩事件）
    assert!(
        outcome
            .events
            .iter()
            .all(|e| !matches!(e, AgentEvent::ContextCompressionEnd { .. })),
        "未配置压缩策略不得触发压缩"
    );

    // 钳制断言：估算 = 10×5004 + 新用户 4961 + tools 前缀 "[]" 1 = 55002
    // （C9 口径启发式，CJK 1.45 权重；空注册表也折算 tools 前缀 JSON 体积）
    // → 可用 = 64000 - 55002 - 4096 = 4902 → min(8192, 4902) = 4902
    let requests = provider.requests();
    assert_eq!(requests.len(), 1);
    let max_tokens = requests[0].max_tokens.expect("请求必须带 max_tokens");
    assert_eq!(
        max_tokens, 4902,
        "max_tokens 必须被钳到 window - estimate - safety"
    );
}

/// 下限保护：可用输出预算低于下限（256）→ 不钳制（保持 8192，只记录）
#[tokio::test]
async fn max_tokens_not_clamped_below_floor() {
    let provider = Arc::new(TestProvider::text_reply("好"));
    let tiny_budget = ContextBudget {
        context_window: 10_000,
        reserve_tokens: 2_000,
        safety_tokens: 100,
    };
    let mut loop_ = AgentSessionLoop::new(
        "s1",
        "r1",
        16,
        Box::new(ArcTestProvider(provider.clone())),
        Arc::new(ToolRegistry::new()),
    )
    .with_options({
        let mut o: SessionLoopOptions = SessionLoopOptions::default();
        o.assembly.context_budget = Some(tiny_budget);
        o.compaction.compaction_policy = None;
        o
    })
    .with_initial_conversation_arc(big_conversation());

    let outcome = loop_.run(user("继续")).await;
    assert_eq!(outcome.reason, AgentEndReason::YieldSuspended);

    // 估算 50048 ≥ 窗口 10000 → 可用预算 = 0 低于下限 → 不钳制
    let requests = provider.requests();
    assert_eq!(
        requests[0].max_tokens,
        Some(8192),
        "低于下限不钳制（保持现状值）"
    );
}

/// 不触发：小对话估算远低于阈值 → 无压缩事件、max_tokens 原值透传
#[tokio::test]
async fn preflight_skipped_under_threshold_in_full_run() {
    let provider = Arc::new(TestProvider::text_reply("好"));
    let mut loop_ = AgentSessionLoop::new(
        "s1",
        "r1",
        16,
        Box::new(ArcTestProvider(provider.clone())),
        Arc::new(ToolRegistry::new()),
    )
    .with_options({
        let mut o: SessionLoopOptions = SessionLoopOptions::default();
        o.assembly.context_budget = Some(default_budget());
        o.compaction.compaction_policy = Some(default_policy());
        o
    });
    // 无历史对话：单条用户消息估算 ≈ 10 token，远低于 47616 阈值
    let outcome = loop_.run(user("你好")).await;
    assert_eq!(outcome.reason, AgentEndReason::YieldSuspended);

    assert!(
        outcome.events.iter().all(|e| !matches!(
            e,
            AgentEvent::ContextCompressionStart { .. } | AgentEvent::ContextCompressionEnd { .. }
        )),
        "估算低于阈值不得触发压缩事件"
    );
    // 钳制不生效：估算 ≈ 10 → 可用 = 64000-10-4096 ≥ 8192 → 原值
    let requests = provider.requests();
    assert_eq!(requests[0].max_tokens, Some(8192));
    assert_eq!(
        requests[0].max_tokens,
        Some(session_loop::r#loop::DEFAULT_MAX_TOKENS)
    );
}
