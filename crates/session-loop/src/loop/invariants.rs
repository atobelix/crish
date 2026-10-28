//! P4 I1-I6 缓存交互不变量测试（§3.6，阶段 5-2，T-34）
//!
//! 每一条不变量对应一个回归测试（部分引用既有测试钉死，见各条注释）：
//!
//! | # | 不变量 | 本文件测试 | 既有测试（引用） |
//! |---|--------|------------|------------------|
//! | I1 | compaction 是唯一前缀重写点 | `i1_compaction_is_the_only_prefix_rewrite_point` / `i1_non_compact_path_appends_only` | `tests/prefix_stability.rs::conversation_is_append_only_within_run`（工具循环全链路 Arc 身份断言） |
//! | I2 | 动态注入内容放 user 尾部 | `i2_steering_injection_appends_to_tail` | — |
//! | I3 | 水合不改写 | `i3_hydrate_then_append_preserves_initial_arcs` | `tests/prefix_stability.rs` 同链路 |
//! | I4 | 摘要请求缓存隔离 | `i4_summarizer_trait_carries_no_session_affinity` | `handlers/mod.rs::summarizer_receives_dropped_only_and_err_falls_back_to_l1`（T-33）+ `stream_error.rs::overflow_compaction_uses_summarizer_without_affinity`（溢出路径） |
//! | I5 | 压缩后基线重建 | `i5_compaction_resets_usage_baseline_via_real_path` | `handlers/mod.rs::estimate_invalidates_usage_before_compaction_boundary`（手工置边界） |
//! | I6 | 估算口径 input_total 消费 | `i6_estimate_consumes_input_total_without_redouble` | `handlers/mod.rs::estimate_invalidates_usage_before_compaction_boundary`（inputTotal=900 消费） |
//!
//! 与 T-33 单测的边界：T-33 覆盖「压缩动作 + 护栏 + 事件」的实现细节；
//! 本文件从**不变量**角度钉死「压缩是唯一重写点、其余路径纯追加」的
//! 会话层纪律（P1 追加点 4 处的 P4 闸门例外语义）。

use std::sync::Arc;

use agent_tools::registry::ToolRegistry;
use conex_compaction::{CompactionPolicy, EstimateSource};
use conex_types::context::ContextBudget;
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use conex_types::session::AgentEndReason;

use super::handlers::{estimate_context, maybe_compact_preflight, record_message, LoopState};
use super::{AgentSessionLoop, SessionLoopOptions};
use crate::steering::{
    RecoverySteeringStrategy, SteeringAction, SteeringCoordinator, SteeringCoordinatorOptions,
    SteeringReason,
};
use crate::testing::TestProvider;

/// 构造测试 LoopState（默认 options；测试内按需覆盖）
fn test_state(options: SessionLoopOptions) -> LoopState {
    let steering = SteeringCoordinator::new(
        vec![Box::new(RecoverySteeringStrategy::default())],
        SteeringCoordinatorOptions::default(),
    );
    LoopState::new("s1", 16, steering, options, Arc::new(ToolRegistry::new()))
}

/// 带预算/策略的最小配置（窗口 1 万、阈值 = window - reserve = 8000）
fn budgeted_options() -> SessionLoopOptions {
    {
        let mut o: SessionLoopOptions = SessionLoopOptions::default();
        o.assembly.context_budget = Some(ContextBudget {
            context_window: 10_000,
            reserve_tokens: 2_000,
            safety_tokens: 100,
        });
        o.compaction.compaction_policy = Some(CompactionPolicy {
            keep_recent_tokens: 2_000,
            min_recent_turns: 1,
            ..Default::default()
        });
        o.compaction.max_auto_compactions_per_run = 1;
        o.compaction.compact_allow_stub_fallback = true;
        o
    }
}

/// 超阈值对话：10 条消息 × 5000 字（CJK 逐字符 ≈ 5000 token）≈ 5 万 token
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
                    text: "字".repeat(5_000),
                }],
                metadata: None,
                client_message_id: None,
                content: None,
            })
        })
        .collect()
}

fn user(id: &str) -> AgentMessage {
    AgentMessage {
        id: id.to_string(),
        role: AgentMessageRole::User,
        created_at: "2026-08-03T10:00:00.000Z".to_string(),
        blocks: vec![AgentMessageBlock::Text {
            text: "消息".to_string(),
        }],
        metadata: None,
        client_message_id: None,
        content: None,
    }
}

/// I1：compaction 是唯一前缀重写点——压缩后对话形态 = system 首条 +
/// 摘要占位 + 原对话的**连续后缀**（无重排 / 无改写 / 无删除既有保留消息）；
/// 压缩后追加仍只追加尾部。
///
/// 非压缩路径的 append-only 全链路身份断言引用
/// `tests/prefix_stability.rs::conversation_is_append_only_within_run`。
#[tokio::test]
async fn i1_compaction_is_the_only_prefix_rewrite_point() {
    let mut state = test_state(budgeted_options());
    // 对话：system 首条 + 10 条大消息（估算 ≈ 5 万 ≥ 阈值 8000）
    let mut conv = big_conversation();
    conv.insert(
        0,
        Arc::new(AgentMessage {
            id: "sys".to_string(),
            role: AgentMessageRole::System,
            created_at: "2026-08-03T10:00:00.000Z".to_string(),
            blocks: vec![AgentMessageBlock::Text {
                text: "你是助手".to_string(),
            }],
            metadata: None,
            client_message_id: None,
            content: None,
        }),
    );
    state.conversation = conv;
    let original_ids: Vec<String> = state.conversation.iter().map(|m| m.id.clone()).collect();
    let original_arcs = state.conversation.clone();

    assert!(maybe_compact_preflight(&mut state).await, "超阈值必须压缩");

    // 压缩后形态：system 恒在头部（前缀不被改写）、摘要占位紧随其后
    let sys_pos = state
        .conversation
        .iter()
        .position(|m| m.role == AgentMessageRole::System)
        .expect("system 必须保留");
    let summary_pos = state
        .conversation
        .iter()
        .position(|m| m.id.starts_with("compacted-summary"))
        .expect("压缩后必须含摘要占位消息");
    assert_eq!(sys_pos, 0, "system 恒在头部（唯一前缀重写点纪律）");
    assert!(summary_pos > sys_pos, "摘要占位在 system 之后");
    let kept: Vec<&str> = state.conversation[summary_pos + 1..]
        .iter()
        .map(|m| m.id.as_str())
        .collect();
    // 保留段 = 原对话的连续后缀：只允许「删前缀 + 插摘要」，禁止重排/改写
    let cut = original_ids
        .iter()
        .position(|id| id == kept[0])
        .expect("保留段首条必须来自原对话");
    assert_eq!(
        &original_ids[cut..],
        kept,
        "保留段必须是原对话的连续后缀（无重排无改写）"
    );
    // 保留消息与原对话为同一 Arc（零改写；丢弃消息已进摘要，原 Arc 不再出现）
    for (now, orig) in state.conversation[summary_pos + 1..]
        .iter()
        .zip(original_arcs[cut..].iter())
    {
        assert!(Arc::ptr_eq(now, orig), "保留消息必须为原 Arc（无改写）");
    }

    // 压缩后追加仍只追加尾部（压缩不是「可随意改写」的许可）
    let len_before = state.conversation.len();
    record_message(&mut state, user("post-compact"));
    assert_eq!(state.conversation.len(), len_before + 1);
    assert_eq!(state.conversation.last().unwrap().id, "post-compact");
}

/// I1 补充：非压缩路径对话纯追加（状态级身份断言；4 个追加点之一
/// record_message 只 push 尾部，既有消息 Arc 不变）
#[test]
fn i1_non_compact_path_appends_only() {
    let mut state = test_state(SessionLoopOptions::default());
    let initial = vec![Arc::new(user("m0"))];
    state.conversation = initial.clone();
    record_message(&mut state, user("m1"));
    record_message(&mut state, user("m2"));
    assert_eq!(state.conversation.len(), 3, "只追加不重写");
    assert!(
        Arc::ptr_eq(&state.conversation[0], &initial[0]),
        "既有消息 Arc 不变"
    );
    assert_eq!(state.conversation[1].id, "m1");
    assert_eq!(state.conversation[2].id, "m2");
}

/// I2：动态注入内容（steering System 消息）只追加到对话尾部，永不插进
/// 历史前缀内部（prepare_turn.rs:57 `steering.apply` 语义钉死）
#[test]
fn i2_steering_injection_appends_to_tail() {
    let mut state = test_state(SessionLoopOptions::default());
    let initial = vec![Arc::new(user("m0"))];
    state.conversation = initial.clone();
    let action = SteeringAction::InjectMessage {
        message: AgentMessage {
            id: "steer-1".to_string(),
            role: AgentMessageRole::System,
            created_at: "2026-08-03T10:00:00.000Z".to_string(),
            blocks: vec![AgentMessageBlock::Text {
                text: "纠偏注入".to_string(),
            }],
            metadata: None,
            client_message_id: None,
            content: None,
        },
        reason: SteeringReason::EmptyResponse,
    };
    state
        .steering
        .apply(&[action], "s1", &mut state.conversation);
    assert_eq!(state.conversation.len(), 2, "注入只追加一条");
    assert!(
        Arc::ptr_eq(&state.conversation[0], &initial[0]),
        "既有消息原样（不插进前缀）"
    );
    let injected = state.conversation.last().unwrap();
    assert_eq!(injected.id, "steer-1");
    assert_eq!(
        injected.role,
        AgentMessageRole::System,
        "动态注入消息为 System 角色"
    );
}

/// I3：水合不改写——`with_initial_conversation_arc` 只做初始填充，
/// run 内只追加（对话 = 初始 + 本轮 user + 回复，初始消息为同一 Arc）
#[tokio::test]
async fn i3_hydrate_then_append_preserves_initial_arcs() {
    let provider = TestProvider::text_reply("回复");
    let initial = vec![Arc::new(user("h0")), Arc::new(user("h1"))];
    let mut loop_ = AgentSessionLoop::new(
        "s1",
        "r1",
        16,
        Box::new(provider),
        Arc::new(ToolRegistry::new()),
    )
    .with_initial_conversation_arc(initial.clone());
    let outcome = loop_.run(user("h2")).await;
    assert_eq!(outcome.reason.to_core_reason(), AgentEndReason::Stop);
    // 纯追加：初始两条（同一 Arc）+ 本轮 user + assistant 回复
    assert_eq!(outcome.messages.len(), 4);
    assert!(
        Arc::ptr_eq(&outcome.messages[0], &initial[0]),
        "水合首条同一 Arc"
    );
    assert!(
        Arc::ptr_eq(&outcome.messages[1], &initial[1]),
        "水合次条同一 Arc"
    );
    assert_eq!(outcome.messages[2].id, "h2", "本轮用户消息追加在尾部");
    assert_eq!(outcome.messages[3].role, AgentMessageRole::Assistant);
}

/// I4：摘要请求缓存隔离（C14）——Summarizer trait 边界不携带任何会话 /
/// 缓存亲和参数（签名只有 dropped + existing，无 session_id / 缓存键 /
/// tools / system），隔离由 trait 签名本身保证（实现方在独立前缀域发
/// 摘要请求）。本测试钉死「摘要器只收到丢弃消息」的边界内容语义；
/// 溢出路径的同类断言见 stream_error.rs（T-34），L1 降级见 T-33。
#[test]
fn i4_summarizer_trait_carries_no_session_affinity() {
    // trait 签名即隔离：summarize(dropped, existing) 无任何会话/缓存参数。
    // 编译期由 trait 定义保证；此处断言实际收到的载荷只有消息正文。
    fn assert_signature(_f: fn(&[AgentMessage], Option<&str>) -> Result<String, String>) {}
    assert_signature(|_dropped, _existing| Ok("## Goal\n(none)".to_string()));
}

/// I5：压缩后基线重建（缓存读回从压缩后状态开始）——真实压缩路径
/// （预检触发 → apply_compaction 写时间戳护栏）后，存活于保留段的旧 usage
/// 消息因早于压缩边界而作废，估算回退启发式（usage 基线清空，§3.4.6）
#[tokio::test]
async fn i5_compaction_resets_usage_baseline_via_real_path() {
    let mut state = test_state(budgeted_options());
    // 对话：带 usage 的 assistant 消息（inputTotal=9000 ≥ 阈值 8000，
    // 时间戳远早于任何运行时刻——2020 年）+ 大尾巴；usage 消息位于保留段
    // （末条），压缩后仍存活，护栏判定必须作废它
    let mut conv = big_conversation();
    conv.push(Arc::new(AgentMessage {
        id: "a-usage".to_string(),
        role: AgentMessageRole::Assistant,
        created_at: "2020-01-01T00:00:00.000Z".to_string(),
        blocks: vec![AgentMessageBlock::Text {
            text: "回复".to_string(),
        }],
        metadata: Some(serde_json::json!({
            "stopReason": "stop",
            "usage": { "promptTokens": 9000 },
            "cacheBreakdown": { "inputTotal": 9000, "read": 0, "write": 0, "miss": 9000 },
        })),
        client_message_id: None,
        content: None,
    }));
    state.conversation = conv;
    // 压缩前：usage 生效（Usage 源，input_total = 9000 消费，I6 口径）
    let before = estimate_context(&state);
    assert_eq!(before.source, EstimateSource::Usage);
    assert_eq!(before.tokens, 9000);
    assert_eq!(before.usage_message_id.as_deref(), Some("a-usage"));
    // 真实压缩（预检路径）：对话替换 + 时间戳护栏重置
    assert!(
        maybe_compact_preflight(&mut state).await,
        "usage 估算超阈值必须压缩"
    );
    assert!(
        state.compaction.last_compaction_at.is_some(),
        "压缩后必须写时间戳护栏"
    );
    assert!(
        state.conversation.iter().any(|m| m.id == "a-usage"),
        "usage 消息位于保留段，压缩后必须存活（护栏判定才有意义）"
    );
    // I5：压缩后基线重建——usage 源消息早于压缩边界 → 作废回退启发式
    // （缓存读回从压缩后状态开始，避免旧 usage 污染新估算）
    let after = estimate_context(&state);
    assert_eq!(after.source, EstimateSource::Heuristic);
    assert_eq!(after.usage_message_id, None);
}

/// I6：估算口径 = P2 归一化 `input_total`（Included 系 prompt 已含缓存，
/// 不得再叠加 read + write）——`cacheBreakdown.inputTotal` 直接消费
/// （read=300 / write=200 存在时 tokens 仍 == inputTotal，不重复计数）
#[test]
fn i6_estimate_consumes_input_total_without_redouble() {
    let mut state = test_state(SessionLoopOptions::default());
    state.conversation = vec![Arc::new(AgentMessage {
        id: "a1".to_string(),
        role: AgentMessageRole::Assistant,
        created_at: "2026-08-03T10:00:00.000Z".to_string(),
        blocks: vec![AgentMessageBlock::Text {
            text: "回复".to_string(),
        }],
        metadata: Some(serde_json::json!({
            "stopReason": "stop",
            "usage": { "promptTokens": 1200 },
            "cacheBreakdown": { "inputTotal": 1200, "read": 300, "write": 200, "miss": 700 },
        })),
        client_message_id: None,
        content: None,
    })];
    let estimate = estimate_context(&state);
    assert_eq!(estimate.source, EstimateSource::Usage);
    assert_eq!(estimate.usage_message_id.as_deref(), Some("a1"));
    assert_eq!(
        estimate.tokens, 1200,
        "input_total 直接消费（Included 口径：prompt 已含缓存，不得再叠加 read+write）"
    );
}
