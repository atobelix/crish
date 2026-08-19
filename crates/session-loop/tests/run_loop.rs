//! B3.4 主循环集成测试（run::lifecycle / run::stop / run::stop_reason /
//! steering::empty 等 P0 语义，05 §6.5）
//!
//! 覆盖清单（任务书 B3.4 第 6 点）：
//! - 纯文字回复 → stop 收场（不 error）——**本次 bug 核心锚点**；
//! - 文字 + tool-call → 执行工具 → 再回复 → stop（完整一轮）；
//! - 空响应 → steering 注入 → 恢复（预算内）；连续空响应 → 预算耗尽 →
//!   stop 收场（不 error）；
//! - 工具执行成功 → turn-complete → 有工具结果续轮；
//! - abort：streaming 中 abort → aborted 收场（部分内容保留）；
//! - cooperative_stop → stopped 收场（不 abort，D1）；
//! - max-turns 收场（独立预算 reason，非错误非中止，01 §1.5）；
//! - provider error（无内容）→ 瞬态重试 → 成功；
//! - 附加：length 阶梯（8192→16384→32768）、工具致命错误 → error 收场、
//!   L3 force_cancel（总线）→ aborted。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_tools::registry::ToolRegistry;
use async_trait::async_trait;
use conex_test_utils::assertions::{assert_event_sequence, assert_request_text_contains};
use conex_test_utils::clock::TimePauseGuard;
use conex_types::error::ProviderErrorKind;
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use conex_types::response::ClassifiedStreamError;
use conex_types::session::AgentEndReason;
use conex_types::tool::ToolOutput;
use session_loop::{
    AgentSessionLoop, ControlKind, ControlLevel, ProviderCall, ProviderEventStream,
    ProviderRequest, ProviderStreamEvent, ReasoningEffort, RecoverySteeringStrategy,
    SessionLoopOptions, SteeringCoordinator, SteeringCoordinatorOptions, StopReason, TestProvider,
    TestTool,
};

/// C1b（反向依赖移出）：测试自建默认 steering 协调器——核心 new() 不再
/// 内建 RecoverySteeringStrategy，测试显式注入以保持行为不变（与 C1b 前
/// new() 内建默认完全一致：RecoverySteeringStrategy::default() + 默认预算）
fn default_steering() -> SteeringCoordinator {
    SteeringCoordinator::new(
        vec![Box::new(RecoverySteeringStrategy::default())],
        SteeringCoordinatorOptions::default(),
    )
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

/// 构造带工具注册表的循环
fn loop_with(provider: TestProvider, tools: Vec<Arc<TestTool>>) -> AgentSessionLoop {
    let mut registry = ToolRegistry::new();
    for tool in tools {
        registry.register(tool).expect("注册测试工具");
    }
    AgentSessionLoop::new(
        "sess-1",
        "run-1",
        16,
        Box::new(provider),
        Arc::new(registry),
    )
    .with_steering(default_steering())
}

/// Arc 包装替身（T09.3 零拷贝断言用）：共享 TestProvider 的请求记录——
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

/// 构造带 Arc 替身 + 工具注册表的循环（调用方保留 `handle` 供 run 后
/// 查询请求记录，与收口对话做 `Arc::ptr_eq`）
fn loop_with_arc(handle: Arc<TestProvider>, tools: Vec<Arc<TestTool>>) -> AgentSessionLoop {
    let mut registry = ToolRegistry::new();
    for tool in tools {
        registry.register(tool).expect("注册测试工具");
    }
    AgentSessionLoop::new(
        "sess-1",
        "run-1",
        16,
        Box::new(ArcTestProvider(handle)),
        Arc::new(registry),
    )
    .with_steering(default_steering())
}

/// 构造已分类传输错误
fn classified(kind: ProviderErrorKind) -> ClassifiedStreamError {
    ClassifiedStreamError {
        kind,
        message: format!("{kind:?} 模拟错误"),
        retryable: kind.default_retryable(),
        retry_after_ms: None,
    }
}

/// P0 锚点：纯文字回复 → stop 收场（不 error）
///
/// 对应 05 §6.5 P0 的 e2e::empty_reply / run::stop_reason；本 bug 根因。
/// 文字回复不得以 error 收场（01 D5/D6，§五.3）。
#[tokio::test]
async fn plain_text_reply_ends_with_stop_not_error() {
    let provider = TestProvider::new(vec![
        ProviderStreamEvent::text("你好，我是助手"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]);
    let mut loop_ = loop_with(provider, vec![]);

    let outcome = loop_.run(user("你好")).await;

    // 核心断言：stop 收场，非 error
    assert_eq!(outcome.reason, AgentEndReason::Stop);
    assert!(outcome.error.is_none());
    // 助手消息已落对话
    let assistant = outcome
        .messages
        .iter()
        .find(|m| m.role == AgentMessageRole::Assistant)
        .expect("应有助手消息");
    assert_eq!(assistant.text(), "你好，我是助手");
    // 事件序列：agent-start … agent-end(reason=stop)
    let end = outcome
        .events
        .iter()
        .find_map(|e| match e {
            conex_types::events::AgentEvent::AgentEnd { reason, error, .. } => {
                Some((*reason, error.clone()))
            }
            _ => None,
        })
        .expect("应有 agent-end 事件");
    assert_eq!(end, (AgentEndReason::Stop, None));
}

/// 完整一轮：文字 + tool-call → 执行工具 → 再回复 → stop
#[tokio::test]
async fn full_turn_with_tool_execution_then_final_reply() {
    let provider = TestProvider::with_scripts(vec![
        // 第 1 次调用：文字 + 工具调用
        vec![
            ProviderStreamEvent::text("我来查一下"),
            ProviderStreamEvent::tool_call(
                Some("call_echo".into()),
                "echo",
                serde_json::json!({"v": "x"}),
            ),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        // 第 2 次调用：最终文字回复
        vec![
            ProviderStreamEvent::text("查询完成"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]);
    let tool = Arc::new(TestTool::new("echo", serde_json::json!({"ok": true})));
    let mut loop_ = loop_with(provider, vec![tool.clone()]);

    let outcome = loop_.run(user("请查询")).await;

    assert_eq!(outcome.reason, AgentEndReason::Stop);
    assert!(outcome.error.is_none());
    // 工具只调用一次
    assert_eq!(tool.call_count(), 1);
    // 对话：user → assistant(工具调用) → tool 结果 → assistant(最终文字)
    let roles: Vec<AgentMessageRole> = outcome.messages.iter().map(|m| m.role).collect();
    assert_eq!(
        roles,
        vec![
            AgentMessageRole::User,
            AgentMessageRole::Assistant,
            AgentMessageRole::Tool,
            AgentMessageRole::Assistant,
        ]
    );
    // 工具结果落盘
    let tool_result = outcome
        .messages
        .iter()
        .find(|m| m.role == AgentMessageRole::Tool)
        .expect("应有工具结果消息");
    let AgentMessageBlock::ToolResult {
        is_error, output, ..
    } = &tool_result.blocks[0]
    else {
        panic!("工具消息应有 tool-result 块");
    };
    assert!(!is_error);
    assert_eq!(
        output,
        &ToolOutput {
            text: None,
            json: Some(serde_json::json!({"ok": true})),
            artifacts: None,
        }
    );
    // 最终回复
    let final_text = outcome
        .messages
        .iter()
        .rev()
        .find(|m| m.role == AgentMessageRole::Assistant)
        .expect("应有最终助手消息");
    assert_eq!(final_text.text(), "查询完成");
}

/// 工具执行成功 → turn-complete → 有工具结果续轮（toolCallCount > 0 → NEXT_TURN）
#[tokio::test]
async fn tool_result_leads_to_next_turn() {
    let provider = TestProvider::with_scripts(vec![
        vec![
            ProviderStreamEvent::tool_call(Some("call_t1".into()), "t1", serde_json::json!({})),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        vec![
            ProviderStreamEvent::text("收尾"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]);
    let tool = Arc::new(TestTool::new("t1", serde_json::json!({"done": 1})));
    let mut loop_ = loop_with(provider, vec![tool]);

    let outcome = loop_.run(user("干吧")).await;

    assert_eq!(outcome.reason, AgentEndReason::Stop);
    // 两轮：第 1 轮工具 + 第 2 轮文字；provider 调用 2 次
    assert_eq!(
        outcome.messages.len(),
        4,
        "user + assistant(tool) + tool-result + assistant(text)"
    );
    // turn-start/turn-end 各 2 次（两轮）
    let turn_starts = outcome
        .events
        .iter()
        .filter(|e| matches!(e, conex_types::events::AgentEvent::TurnStart { .. }))
        .count();
    assert_eq!(turn_starts, 2);
    let turn_ends = outcome
        .events
        .iter()
        .filter(|e| matches!(e, conex_types::events::AgentEvent::TurnEnd { .. }))
        .count();
    assert_eq!(turn_ends, 2);
}

/// 空响应 → steering 注入 → 恢复（预算内）
///
/// 01 D7：空响应 = 模型输出异常而非任务失败；预算内注入重试。
#[tokio::test]
async fn empty_response_injects_steering_then_recovers() {
    let provider = TestProvider::with_scripts(vec![
        // 第 1 次：空响应
        vec![ProviderStreamEvent::stop(StopReason::Stop)],
        // 第 2 次：注入后正常回复
        vec![
            ProviderStreamEvent::text("抱歉，我重新回答了"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]);
    let mut loop_ = loop_with(provider, vec![]);

    let outcome = loop_.run(user("回答")).await;

    // 预算内恢复：stop 收场（不 error）
    assert_eq!(outcome.reason, AgentEndReason::Stop);
    assert!(outcome.error.is_none());
    // 注入消息在对话中（system 角色，metadata.kind=steering——I1-α④ 枚举 canonical）
    let injected = outcome
        .messages
        .iter()
        .find(|m| {
            m.role == AgentMessageRole::System
                && m.metadata
                    .as_ref()
                    .and_then(|meta| meta.get("kind"))
                    .and_then(|k| k.as_str())
                    == Some(
                        session_loop::steering::metadata_kind_wire(
                            conex_types::message::AgentMessageMetadataKind::Steering,
                        )
                        .as_str(),
                    )
        })
        .expect("应有 steering 注入消息");
    assert!(injected.text().contains("运行期纠偏"));
    // runtime-steering 事件照发
    assert!(outcome
        .events
        .iter()
        .any(|e| matches!(e, conex_types::events::AgentEvent::RuntimeSteering { .. })));
    // 恢复后的最终回复
    let final_text = outcome
        .messages
        .iter()
        .rev()
        .find(|m| m.role == AgentMessageRole::Assistant)
        .expect("应有最终助手消息");
    assert_eq!(final_text.text(), "抱歉，我重新回答了");
}

/// 连续空响应 → 预算耗尽 → stop 收场（不 error，D7/D9）
///
/// 默认 maxSteeringMessages=1：第 1 次空响应注入（计数→1），
/// 第 2 次空响应 → intervention-required → stop + 诊断。
#[tokio::test]
async fn consecutive_empty_responses_end_with_stop_after_budget_exhausted() {
    let provider = TestProvider::with_scripts(vec![
        // 第 1 次：空响应 → 注入
        vec![ProviderStreamEvent::stop(StopReason::Stop)],
        // 第 2 次：仍为空 → 预算耗尽
        vec![ProviderStreamEvent::stop(StopReason::Stop)],
    ]);
    let mut loop_ = loop_with(provider, vec![]);

    let outcome = loop_.run(user("回答")).await;

    // 裁决（D7/D9）：预算耗尽 → stop 收场（**非 error**）
    assert_eq!(outcome.reason, AgentEndReason::Stop);
    assert!(outcome.error.is_none(), "预算耗尽不得以 error 收场");
    assert!(
        outcome.diagnostic.is_some(),
        "预算耗尽应带诊断说明（01 §五.10）"
    );
    // intervention 事件照发（runtime-intervention-required）
    assert!(outcome.events.iter().any(|e| matches!(
        e,
        conex_types::events::AgentEvent::RuntimeInterventionRequired { .. }
    )));
}

/// T06.2.1（Q03）：steering_enabled=false 时 empty-response 直接 stop 收场
/// ——无注入、无 intervention、不重进 provider 循环（开关接线本次生效）
#[tokio::test]
async fn steering_disabled_empty_response_stops_without_steering() {
    let provider = TestProvider::new(vec![ProviderStreamEvent::stop(StopReason::Stop)]);
    let loop_ = loop_with(provider, vec![]);
    let mut loop_ = loop_.with_options(SessionLoopOptions {
        steering_enabled: false,
        ..Default::default()
    });

    let outcome = loop_.run(user("回答")).await;

    // 直接 stop + 诊断收场（01 §2.3 期望语义：干预性 steering 可配置关闭）
    assert_eq!(outcome.reason, AgentEndReason::Stop);
    assert!(outcome.error.is_none());
    assert_eq!(
        outcome.diagnostic.as_deref(),
        Some("steering 已禁用，空响应无法恢复")
    );
    // 无注入、无 intervention、无 steering 事件
    assert!(!outcome
        .events
        .iter()
        .any(|e| matches!(e, conex_types::events::AgentEvent::RuntimeSteering { .. })));
    assert!(!outcome.events.iter().any(|e| matches!(
        e,
        conex_types::events::AgentEvent::RuntimeInterventionRequired { .. }
    )));
    // 不重进 provider 循环：仅 1 次 TurnStart（修复前会注入后重试）
    let turn_starts = outcome
        .events
        .iter()
        .filter(|e| matches!(e, conex_types::events::AgentEvent::TurnStart { .. }))
        .count();
    assert_eq!(
        turn_starts, 1,
        "steering 禁用时 empty-response 不得重进 provider"
    );
}

/// T06.2.1（Q03）：steering_enabled=false 时 prepare_turn 不评估——
/// 连续工具错误不触发 steering 注入（无注入消息、无事件）
#[tokio::test]
async fn steering_disabled_prepare_turn_skips_evaluation() {
    let provider = TestProvider::with_scripts(vec![
        // 第 1 轮：工具失败
        vec![
            ProviderStreamEvent::tool_call(Some("call_f1".into()), "fail", serde_json::json!({})),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        // 第 2 轮：再失败（形成连续错误，开启 steering 时第 3 轮注入）
        vec![
            ProviderStreamEvent::tool_call(Some("call_f2".into()), "fail", serde_json::json!({})),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        // 第 3 轮：正常回复收场
        vec![
            ProviderStreamEvent::text("完成"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]);
    let tool = Arc::new(TestTool::with_error("fail", "boom"));
    let loop_ = loop_with(provider, vec![tool]);
    let mut loop_ = loop_.with_options(SessionLoopOptions {
        steering_enabled: false,
        ..Default::default()
    });

    let outcome = loop_.run(user("执行")).await;

    assert_eq!(outcome.reason, AgentEndReason::Stop);
    // 无 steering 注入消息（system 角色，kind=steering 枚举 canonical）
    assert!(!outcome.messages.iter().any(|m| {
        m.role == AgentMessageRole::System
            && m.metadata
                .as_ref()
                .and_then(|meta| meta.get("kind"))
                .and_then(|k| k.as_str())
                == Some(
                    session_loop::steering::metadata_kind_wire(
                        conex_types::message::AgentMessageMetadataKind::Steering,
                    )
                    .as_str(),
                )
    }));
    // 无 steering / intervention 事件
    assert!(!outcome
        .events
        .iter()
        .any(|e| matches!(e, conex_types::events::AgentEvent::RuntimeSteering { .. })));
    assert!(!outcome.events.iter().any(|e| matches!(
        e,
        conex_types::events::AgentEvent::RuntimeInterventionRequired { .. }
    )));
}

/// T06.2.2（Q05）：PayloadTooLarge 直接 fatal——error 收场、不重试
/// （假恢复阶梯已删除：请求体与 max_tokens 不变时重试必败）
#[tokio::test]
async fn payload_too_large_ends_with_error_without_retry() {
    let provider = TestProvider::new(vec![
        ProviderStreamEvent::text("不应到达"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ])
    .with_error(classified(ProviderErrorKind::PayloadTooLarge));
    let mut loop_ = loop_with(provider, vec![]);

    let outcome = loop_.run(user("你好")).await;

    assert_eq!(outcome.reason, AgentEndReason::Error);
    let err = outcome.error.as_deref().expect("error 收场必须带错误信息");
    assert!(err.contains("payload"), "错误文案含 payload 说明");
    // 不重进 provider 循环：仅 1 次 TurnStart（修复前会白费 2 次重试请求）
    let turn_starts = outcome
        .events
        .iter()
        .filter(|e| matches!(e, conex_types::events::AgentEvent::TurnStart { .. }))
        .count();
    assert_eq!(
        turn_starts, 1,
        "PayloadTooLarge 直接 fatal，不得重进 provider 循环"
    );
    // runtime-error 事件附注「无压缩恢复路径」（T06.2.2 文案补充）
    assert!(outcome.events.iter().any(|e| matches!(
        e,
        conex_types::events::AgentEvent::RuntimeError { error, .. }
            if error.contains("无压缩恢复路径")
    )));
}

/// T06.3（Q02）：L3 force_cancel 的取消原因经 diagnostic 透出
/// （abort 原因不再丢失：aborted_with_diagnostic 接线）
#[tokio::test]
async fn force_cancel_reason_surfaces_in_diagnostic() {
    // Q41（T11.7.2）：虚拟时间护栏——真实 sleep 改为 advance 显式推进，
    // 时间确定性（provider 栅栏停顿 300ms 虚拟）
    let _time = TimePauseGuard::new();
    let provider = TestProvider::new(vec![
        ProviderStreamEvent::text("部分内容"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ])
    .with_pause(1, 300);
    let mut loop_ = loop_with(provider, vec![]);
    let bus = loop_.control_bus();

    let handle = tokio::spawn(async move { loop_.run(user("跑起来")).await });
    tokio::time::advance(Duration::from_millis(80)).await;
    bus.lock()
        .unwrap()
        .request_force_cancel(Some("用户强停".into()), Some("ui".into()));
    // 越过 provider 栅栏（300ms 虚拟停顿），loop 才读到取消并收场
    tokio::time::advance(Duration::from_millis(300)).await;
    let outcome = handle.await.expect("run 不应 panic");

    assert_eq!(outcome.reason, AgentEndReason::Aborted);
    assert_eq!(
        outcome.diagnostic.as_deref(),
        Some("用户强停"),
        "取消原因经 diagnostic 透出（Q02：abort_reason 不再丢失）"
    );
}

/// T06.4.1（Q14）：idempotency_enabled=true 时同域同参工具跨 run 去重
/// ——第二次 run 命中幂等守卫不再执行工具（失败不记录、成功落键）
///
/// 脚本四份：两次 run 各含「工具轮 → 文字轮」，保证每次 run 以 stop 收场
/// （单脚本工具调用会无限续轮直至 max-turns）。
#[tokio::test]
async fn idempotency_enabled_deduplicates_across_runs() {
    let args = serde_json::json!({"path": "a.txt"});
    let provider = TestProvider::with_scripts(vec![
        vec![
            ProviderStreamEvent::tool_call(Some("call_e1".into()), "echo", args.clone()),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        vec![
            ProviderStreamEvent::text("完成"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        vec![
            ProviderStreamEvent::tool_call(Some("call_e1".into()), "echo", args.clone()),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        vec![
            ProviderStreamEvent::text("完成"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]);
    let tool = Arc::new(TestTool::new("echo", serde_json::json!({"ok": true})));
    let loop_ = loop_with(provider, vec![tool.clone()]);
    let mut loop_ = loop_.with_options(SessionLoopOptions {
        idempotency_enabled: true,
        ..Default::default()
    });

    let first = loop_.run(user("执行")).await;
    assert_eq!(first.reason, AgentEndReason::Stop);
    assert_eq!(tool.call_count(), 1, "首次执行");

    // T09.3.3（R4）：收口 mem::take 后对话移交 RunOutcome——用上一轮
    // messages 零拷贝续接（with_initial_conversation_arc），保持
    // 「对话跨 run 持久」语义（真实接线每 run 重建 loop，无此需求）
    loop_ = loop_.with_initial_conversation_arc(first.messages);
    let second = loop_.run(user("再执行")).await;
    assert_eq!(second.reason, AgentEndReason::Stop);
    assert_eq!(tool.call_count(), 1, "同域同参第二次命中幂等守卫，不再执行");
    // 幂等去重输出带 deduplicated 标记（取最后一次 tool 消息——对话跨 run 持久）
    let second_tool = second
        .messages
        .iter()
        .rev()
        .find(|m| m.role == AgentMessageRole::Tool)
        .expect("应有工具结果消息");
    let AgentMessageBlock::ToolResult { output, .. } = &second_tool.blocks[0] else {
        panic!("应有 tool-result 块");
    };
    assert_eq!(
        output
            .json
            .as_ref()
            .and_then(|j| j.get("deduplicated"))
            .and_then(|d| d.as_bool()),
        Some(true),
        "去重结果带 deduplicated 标记（executor.rs 幂等语义）"
    );
}

/// 对照：idempotency_enabled=false（默认）时同参跨 run 重复执行
#[tokio::test]
async fn idempotency_disabled_by_default_executes_twice() {
    let args = serde_json::json!({"path": "a.txt"});
    let provider = TestProvider::with_scripts(vec![
        vec![
            ProviderStreamEvent::tool_call(Some("call_e1".into()), "echo", args.clone()),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        vec![
            ProviderStreamEvent::text("完成"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        vec![
            ProviderStreamEvent::tool_call(Some("call_e1".into()), "echo", args.clone()),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        vec![
            ProviderStreamEvent::text("完成"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]);
    let tool = Arc::new(TestTool::new("echo", serde_json::json!({"ok": true})));
    let mut loop_ = loop_with(provider, vec![tool.clone()]);

    let first = loop_.run(user("执行")).await;
    // T09.3.3（R4）：收口后对话移交，续接上一轮 messages 保持跨 run 语义
    loop_ = loop_.with_initial_conversation_arc(first.messages);
    let _second = loop_.run(user("再执行")).await;
    assert_eq!(tool.call_count(), 2, "默认关闭幂等，两次都真实执行");
}

/// abort：streaming 中 abort → aborted 收场（部分内容保留，01 §2.4 / §五.9）
#[tokio::test]
async fn abort_mid_stream_ends_aborted_with_partial_content() {
    // Q41（T11.7.2）：虚拟时间护栏（真实 sleep → advance 显式推进）
    let _time = TimePauseGuard::new();
    let provider = TestProvider::new(vec![
        ProviderStreamEvent::text("已流出的部分内容"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ])
    .with_pause(1, 300);
    let mut loop_ = loop_with(provider, vec![]);
    let abort = loop_.abort_signal();

    let handle = tokio::spawn(async move { loop_.run(user("生成内容")).await });
    // provider 正在栅栏停顿中 → L3 强停
    tokio::time::advance(Duration::from_millis(80)).await;
    abort.abort();
    // 越过 provider 栅栏（300ms 虚拟停顿），loop 读到 abort 并收场
    tokio::time::advance(Duration::from_millis(300)).await;
    let outcome = handle.await.expect("run 不应 panic");

    assert_eq!(outcome.reason, AgentEndReason::Aborted);
    // 部分内容保留（partial salvage）
    let partial = outcome
        .messages
        .iter()
        .find(|m| m.role == AgentMessageRole::Assistant)
        .expect("部分内容应已 commit");
    assert_eq!(partial.text(), "已流出的部分内容");
    // 消息带 aborted 标注（stopReason=aborted）
    assert_eq!(
        partial
            .metadata
            .as_ref()
            .and_then(|m| m.get("stopReason"))
            .and_then(|s| s.as_str()),
        Some("aborted")
    );
}

/// cooperative_stop（L2）→ stopped 收场（不 abort，D1）
#[tokio::test]
async fn cooperative_stop_ends_with_stopped() {
    // Q41（T11.7.2）：虚拟时间护栏（真实 sleep → advance 显式推进）
    let _time = TimePauseGuard::new();
    let provider = TestProvider::new(vec![
        ProviderStreamEvent::text("这条消息保留"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ])
    .with_pause(1, 300);
    let mut loop_ = loop_with(provider, vec![]);
    let bus = loop_.control_bus();

    let handle = tokio::spawn(async move { loop_.run(user("开始")).await });
    tokio::time::advance(Duration::from_millis(80)).await;
    bus.lock()
        .unwrap()
        .request_cooperative_stop(Some("用户协作停止".into()), Some("test".into()));
    // 越过 provider 栅栏（300ms 虚拟停顿），loop 读到协作停止并收场
    tokio::time::advance(Duration::from_millis(300)).await;
    let outcome = handle.await.expect("run 不应 panic");

    // D1：独立 reason stopped，既不是 aborted 也不是 error
    assert_eq!(outcome.reason, AgentEndReason::Stopped);
    assert!(
        !matches!(
            outcome.reason,
            AgentEndReason::Aborted | AgentEndReason::Error
        ),
        "协作停止不是取消也不是错误"
    );
    // 已产出内容保留
    let assistant = outcome
        .messages
        .iter()
        .find(|m| m.role == AgentMessageRole::Assistant)
        .expect("协作停止不丢已产出内容");
    assert_eq!(assistant.text(), "这条消息保留");
}

/// max-turns 收场：独立预算 reason（01 §1.5），非错误非中止
#[tokio::test]
async fn max_turns_ends_with_independent_budget_reason() {
    // 脚本 1：工具调用（第 1 轮）；脚本 2：文字（第 2 轮将触发 max-turns）
    let provider = TestProvider::with_scripts(vec![
        vec![
            ProviderStreamEvent::tool_call(Some("call_m".into()), "mt", serde_json::json!({})),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        vec![
            ProviderStreamEvent::text("仍在回答"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]);
    let mut registry = ToolRegistry::new();
    registry
        .register(Arc::new(TestTool::new(
            "mt",
            serde_json::json!({"ok": true}),
        )))
        .expect("注册");
    let mut loop_ =
        AgentSessionLoop::new("sess-1", "run-1", 1, Box::new(provider), Arc::new(registry));

    let outcome = loop_.run(user("多轮任务")).await;

    assert_eq!(outcome.reason, AgentEndReason::MaxTurns);
    assert!(
        !matches!(
            outcome.reason,
            AgentEndReason::Error | AgentEndReason::Aborted
        ),
        "max-turns 是独立预算 reason（01 §1.5）"
    );
    // 观测到 runtime-error 事件（retryable=true 可测，01 §2.10）
    assert!(outcome
        .events
        .iter()
        .any(|e| matches!(e, conex_types::events::AgentEvent::RuntimeError { .. })));
}

/// provider error（无内容）→ 瞬态重试 → 成功（01 §2.5 步骤 2）
#[tokio::test]
async fn transient_provider_error_retries_then_succeeds() {
    let provider = TestProvider::new(vec![
        ProviderStreamEvent::text("重试后成功"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ])
    .with_error_once(classified(ProviderErrorKind::RateLimit));
    let mut loop_ = loop_with(provider, vec![]);

    let outcome = loop_.run(user("你好")).await;

    // 瞬态错误重试后成功：stop 收场
    assert_eq!(outcome.reason, AgentEndReason::Stop);
    assert!(outcome.error.is_none());
    let assistant = outcome
        .messages
        .iter()
        .find(|m| m.role == AgentMessageRole::Assistant)
        .expect("重试后应有助手消息");
    assert_eq!(assistant.text(), "重试后成功");
    // provider-diagnostic（phase=retry）事件照发
    assert!(outcome.events.iter().any(|e| matches!(
        e,
        conex_types::events::AgentEvent::ProviderDiagnostic { .. }
    )));
}

/// 重试失败替身（Q40/T09.9 时序测试）：首次调用快速瞬态失败，其后调用
/// 慢速失败——慢速窗口供测试注入 abort，验证「abort 后剩余阶梯不再发起
/// 请求」（mock 计数断言）。
struct RetryFailProvider {
    calls: Arc<Mutex<usize>>,
}

#[async_trait]
impl ProviderCall for RetryFailProvider {
    async fn stream<'a>(
        &self,
        _request: &ProviderRequest<'a>,
    ) -> Result<ProviderEventStream, ClassifiedStreamError> {
        let n = {
            let mut count = self.calls.lock().unwrap();
            *count += 1;
            *count
        };
        // 首次调用立即失败；重试调用慢速失败（给出注入 abort 的窗口）
        if n > 1 {
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        Err(classified(ProviderErrorKind::Network))
    }
}

/// Q40（T09.9）：重试阶梯第一级后 abort → 剩余阶梯不再发起请求——
/// 第一级重试在途时用户取消，直接 aborted 收场（不白耗 3 次请求）
#[tokio::test]
async fn abort_during_retry_ladder_skips_remaining_requests() {
    // Q41（T11.7.2）：虚拟时间护栏——替身内 sleep(300) 与测试等待全部虚拟化
    let _time = TimePauseGuard::new();
    let calls = Arc::new(Mutex::new(0usize));
    let provider = RetryFailProvider {
        calls: calls.clone(),
    };
    let mut loop_ = AgentSessionLoop::new(
        "sess-1",
        "run-1",
        16,
        Box::new(provider),
        Arc::new(ToolRegistry::new()),
    );
    let abort = loop_.abort_signal();

    let handle = tokio::spawn(async move { loop_.run(user("重试")).await });
    // 首次调用快速失败 → 第一级重试在途（第二次调用慢速失败中）
    tokio::time::advance(Duration::from_millis(80)).await;
    abort.abort();
    // 越过重试替身的 300ms 慢速失败窗口，loop 在梯级入口读到 abort 收场
    tokio::time::advance(Duration::from_millis(300)).await;
    let outcome = handle.await.expect("run 不应 panic");

    assert_eq!(outcome.reason, AgentEndReason::Aborted);
    // mock 计数断言：仅 1 次初始调用 + 1 次重试；abort 后剩余阶梯不再发起请求
    assert_eq!(
        *calls.lock().unwrap(),
        2,
        "abort 后不得再发起重试请求（阶梯上限 3 次）"
    );
}

/// provider error（无内容，不可重试）→ PROVIDER_ERROR → error 收场
///
/// 01 §1.6 四事件：错误收场唯一来源（PROVIDER_ERROR）。
#[tokio::test]
async fn permanent_provider_error_ends_with_error() {
    let provider = TestProvider::new(vec![
        ProviderStreamEvent::text("不应到达"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ])
    .with_error(classified(ProviderErrorKind::Auth));
    let mut loop_ = loop_with(provider, vec![]);

    let outcome = loop_.run(user("你好")).await;

    assert_eq!(outcome.reason, AgentEndReason::Error);
    assert!(outcome.error.is_some(), "error 收场必须带错误信息");
    // 无内容时不得追加 assistant 消息（05 §3.4：provider 调用失败不追加）
    assert!(
        !outcome
            .messages
            .iter()
            .any(|m| m.role == AgentMessageRole::Assistant),
        "不可重试错误不得 commit 助手消息"
    );
}

/// length 阶梯：stopReason=length → max_tokens 升级重试（8192 → 16384，01 §2.6）
#[tokio::test]
async fn length_ladder_upgrades_max_tokens_and_retries() {
    let provider = TestProvider::with_scripts(vec![
        // 第 1 次：length 截断（带部分文字）
        vec![
            ProviderStreamEvent::text("这是截断的长回复"),
            ProviderStreamEvent::stop(StopReason::Length),
        ],
        // 第 2 次：升级 max_tokens 后完整回复
        vec![
            ProviderStreamEvent::text("完整回复"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]);
    let mut loop_ = loop_with(provider, vec![]);

    let outcome = loop_.run(user("写长文")).await;

    assert_eq!(outcome.reason, AgentEndReason::Stop);
    assert!(outcome.error.is_none());
    // length 恢复后重进 provider 循环：两次 TurnStart 而非一次
    let turn_starts = outcome
        .events
        .iter()
        .filter(|e| matches!(e, conex_types::events::AgentEvent::TurnStart { .. }))
        .count();
    assert_eq!(turn_starts, 2, "length 恢复后重进 provider 循环");
    // 完整回复落盘
    let final_text = outcome
        .messages
        .iter()
        .rev()
        .find(|m| m.role == AgentMessageRole::Assistant)
        .expect("应有最终助手消息");
    assert_eq!(final_text.text(), "完整回复");
    // 截断消息与完整回复并存（截断消息已 commit 后重试，01 §2.6 语义）
    assert_eq!(
        outcome
            .messages
            .iter()
            .filter(|m| m.role == AgentMessageRole::Assistant)
            .count(),
        2
    );
}

/// 工具错误（未标记 fatalOnError）→ 非致命：错误喂回模型，模型继续 → 正常收场
/// （对照 pi：工具失败不终止 run，01 §2.8 fatalOnError 是工具级属性）
#[tokio::test]
async fn tool_error_is_not_fatal_by_default() {
    // 第一轮：工具 fail 报错；第二轮：模型只回文字正常收场
    let provider = TestProvider::new(vec![
        ProviderStreamEvent::tool_call(Some("call_fail".into()), "fail", serde_json::json!({})),
        ProviderStreamEvent::stop(StopReason::Stop),
        // 第二轮：读工具结果后正常结束
        ProviderStreamEvent::text("已处理工具错误，继续完成"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]);
    let tool = Arc::new(TestTool::with_error("fail", "boom"));
    let mut loop_ = loop_with(provider, vec![tool]);

    let outcome = loop_.run(user("执行")).await;

    // 非致命：不以 error 收场
    assert_eq!(outcome.reason, AgentEndReason::Stop);
    assert!(outcome.error.is_none());
    // 工具结果已落盘（01 §2.8：结果落盘后才进 turn-complete）
    let tool_result = outcome
        .messages
        .iter()
        .find(|m| m.role == AgentMessageRole::Tool)
        .expect("工具结果应先落盘");
    let AgentMessageBlock::ToolResult { is_error, .. } = &tool_result.blocks[0] else {
        panic!("应有 tool-result 块");
    };
    assert!(is_error);
    // 无致命 runtime-error 事件
    assert!(!outcome
        .events
        .iter()
        .any(|e| matches!(e, conex_types::events::AgentEvent::RuntimeError { .. })));
}

/// 工具标记 fatalOnError → 工具错误致命 → ERROR → error 收场（01 §2.8 步骤 6）
#[tokio::test]
async fn fatal_tool_error_ends_with_error() {
    let provider = TestProvider::new(vec![
        ProviderStreamEvent::tool_call(Some("call_fail".into()), "fail", serde_json::json!({})),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]);
    let tool = Arc::new(TestTool::with_error("fail", "boom").with_fatal_on_error());
    let mut loop_ = loop_with(provider, vec![tool]);

    let outcome = loop_.run(user("执行")).await;

    assert_eq!(outcome.reason, AgentEndReason::Error);
    assert!(outcome.error.is_some());
    // 工具结果已落盘（01 §2.8：结果落盘后才进 turn-complete）
    let tool_result = outcome
        .messages
        .iter()
        .find(|m| m.role == AgentMessageRole::Tool)
        .expect("工具结果应先落盘");
    let AgentMessageBlock::ToolResult { is_error, .. } = &tool_result.blocks[0] else {
        panic!("应有 tool-result 块");
    };
    assert!(is_error);
    // runtime-error 事件（致命路径）
    assert!(outcome
        .events
        .iter()
        .any(|e| matches!(e, conex_types::events::AgentEvent::RuntimeError { .. })));
}

/// L3 force_cancel（经控制总线）→ aborted 收场
#[tokio::test]
async fn force_cancel_via_bus_ends_aborted() {
    // Q41（T11.7.2）：虚拟时间护栏（真实 sleep → advance 显式推进）
    let _time = TimePauseGuard::new();
    let provider = TestProvider::new(vec![
        ProviderStreamEvent::text("部分内容"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ])
    .with_pause(1, 300);
    let mut loop_ = loop_with(provider, vec![]);
    let bus = loop_.control_bus();

    let handle = tokio::spawn(async move { loop_.run(user("跑起来")).await });
    tokio::time::advance(Duration::from_millis(80)).await;
    bus.lock()
        .unwrap()
        .request_force_cancel(Some("用户强停".into()), Some("ui".into()));
    // 越过 provider 栅栏（300ms 虚拟停顿），loop 才读到取消并收场
    tokio::time::advance(Duration::from_millis(300)).await;
    let outcome = handle.await.expect("run 不应 panic");

    assert_eq!(outcome.reason, AgentEndReason::Aborted);
}

/// TestProvider 请求记录：请求含用户输入、max_tokens 透传（05 §6.2）
#[tokio::test]
async fn test_provider_records_requests() {
    let provider = TestProvider::new(vec![
        ProviderStreamEvent::text("回复。"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]);
    let messages = vec![Arc::new(user("请求"))];
    let request = session_loop::ProviderRequest {
        messages: &messages,
        tools: vec![],
        max_tokens: Some(8192),
        system_prompt: None,
        session_id: None,
        reasoning_effort: None,
    };
    let mut stream = provider.stream(&request).await.expect("脚本调用成功");
    let mut events = Vec::new();
    while let Some(item) = futures::StreamExt::next(&mut stream).await {
        events.push(item.expect("脚本替身不产出流中错误"));
    }
    assert_eq!(events.len(), 2);
    assert_eq!(provider.call_count(), 1);
    let requests = provider.requests();
    assert_eq!(requests.len(), 1);
    // T11.7.1 断言助手：第 0 次请求含用户输入正文
    assert_request_text_contains(&requests, 0, "请求", |r| {
        r.messages.iter().map(|m| m.text()).collect()
    });
    assert_eq!(requests[0].max_tokens, Some(8192));
}

/// T3.1 契约测钉：ProviderRequest.reasoning_effort 字段语义——
/// 显式 `Some(档位)` 经 TestProvider 请求快照完整透传；缺省 `None` 时
/// 快照为 None（适配层见 None 不携带思考参数，与旧版 wire 逐字节一致）。
#[tokio::test]
async fn reasoning_effort_field_propagates_through_request() {
    // 1) 显式 Some(ReasoningEffort::High)：快照捕获同一档位
    let provider = TestProvider::new(vec![
        ProviderStreamEvent::text("思考档位透传"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]);
    let messages = vec![Arc::new(user("请求"))];
    let request = session_loop::ProviderRequest {
        messages: &messages,
        tools: vec![],
        max_tokens: Some(2048),
        system_prompt: None,
        session_id: None,
        reasoning_effort: Some(ReasoningEffort::High),
    };
    let mut stream = provider.stream(&request).await.expect("脚本调用成功");
    while let Some(item) = futures::StreamExt::next(&mut stream).await {
        item.expect("脚本替身不产出流中错误");
    }
    let requests = provider.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].reasoning_effort,
        Some(ReasoningEffort::High),
        "Some(档位) 必须完整透传到请求快照"
    );
    assert_eq!(
        provider.request_reasoning_effort(0),
        Some(ReasoningEffort::High),
        "TestProvider 访问器返回与请求承载一致"
    );

    // 2) 缺省 None（旧版构造形态：字段不携带思考参数）：快照为 None
    let provider_none = TestProvider::new(vec![
        ProviderStreamEvent::text("缺省无思考"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]);
    let request_none = session_loop::ProviderRequest {
        messages: &messages,
        tools: vec![],
        max_tokens: Some(2048),
        system_prompt: None,
        session_id: None,
        reasoning_effort: None,
    };
    let mut stream = provider_none
        .stream(&request_none)
        .await
        .expect("脚本调用成功");
    while let Some(item) = futures::StreamExt::next(&mut stream).await {
        item.expect("脚本替身不产出流中错误");
    }
    assert_eq!(
        provider_none.request_reasoning_effort(0),
        None,
        "缺省 None 时适配层见 None，不携带思考参数（与旧版一致）"
    );
}

/// I1-β 产品链路测：**经 SessionLoopOptions 注入档位** → 主循环
/// build_request → ProviderRequest 捕获（不再直接构造 ProviderRequest——
/// 钉死「产品链路」：壳层装配档位 → options → 请求体）。
///
/// 验收断言（详案 I1-β §5.1）：`reasoning_effort` 经 options 而非直接构造
/// ProviderRequest 下发；非零思考预算（普通对话最后一条为 user 消息）
/// 用用户档位。
#[tokio::test]
async fn reasoning_effort_options_injects_through_product_path() {
    // 1) SessionLoopOptions 注入 Some(High)：经 loop.run 全链路捕获
    let provider_handle = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("思考档位链路"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let mut loop_ =
        loop_with_arc(provider_handle.clone(), vec![]).with_options(SessionLoopOptions {
            reasoning_effort: Some(ReasoningEffort::High),
            ..Default::default()
        });
    let outcome = loop_.run(user("请求")).await;
    assert_eq!(outcome.reason, AgentEndReason::Stop);
    assert!(outcome.error.is_none());
    assert_eq!(
        provider_handle.request_reasoning_effort(0),
        Some(ReasoningEffort::High),
        "产品链路：options 注入档位必须经 build_request 捕获（非直接构造请求）"
    );

    // 2) 缺省 None：主循环请求不携带思考参数（与旧版 wire 一致）
    let provider_none_handle = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("缺省无思考"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let mut loop_none = loop_with_arc(provider_none_handle.clone(), vec![]);
    let outcome = loop_none.run(user("请求")).await;
    assert_eq!(outcome.reason, AgentEndReason::Stop);
    assert_eq!(
        provider_none_handle.request_reasoning_effort(0),
        None,
        "缺省 None 时主循环请求不携带思考参数（向后兼容）"
    );
}

/// S5 契约测钉（D-02）：build_request 注入真实 session_id——构造 loop 时
/// 传入的会话 ID（loop_with_arc 固定 "sess-1"）经请求快照捕获，断言
/// 非 None 且等于构造值（缓存键会话维度来源；engine.rs:452
/// build_cache_policy 消费链已就位）
#[tokio::test]
async fn request_session_id_injected_into_provider_request() {
    let provider_handle = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("回复。"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let mut loop_ = loop_with_arc(provider_handle.clone(), vec![]);

    let outcome = loop_.run(user("你好")).await;
    assert_eq!(outcome.reason, AgentEndReason::Stop);
    assert!(outcome.error.is_none());
    // 构造时传入 session_id = "sess-1"（loop_with_arc），请求快照捕获真实值
    assert_eq!(
        provider_handle.request_session_id(0),
        Some("sess-1".to_string()),
        "build_request 必须注入真实会话 ID（缓存键会话维度来源）"
    );
}

/// 事件序列契约抽查（01 §五.6）：agent-start/end 首尾、turn-start/end 成对、
/// message-start/end 每条消息成对；EV-11（D-03）起 turn-start 与 assistant
/// message-start 之间插入 provider-request-anchored（请求发出点锚点，Delta）
#[tokio::test]
async fn event_sequence_contract() {
    let provider = TestProvider::new(vec![
        ProviderStreamEvent::text("事件序列"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]);
    let mut loop_ = loop_with(provider, vec![]);

    let outcome = loop_.run(user("验证")).await;

    // T11.7.1 断言助手：全序列类型名断言（首事件 agent-start、末事件
    // agent-end、turn/message 成对均由序列整体保证——比分散 matches!
    // 更强，01 §五.6 序列契约）
    assert_event_sequence(
        &outcome.events,
        &[
            "agent-start",
            "message-start",
            "message-end",
            "turn-start",
            "provider-request-anchored",
            "message-start",
            "message-delta",
            "message-end",
            "steering-evaluated",
            "turn-end",
            "agent-end",
        ],
    );
}

/// T09.3（PE-09）：长会话克隆消除——100 条消息会话下请求链与消息记录路径
/// **零深拷贝**（Arc 身份共享断言，确定性判定）：
/// - 请求链：provider 收到的请求快照中 100 条初始消息与收口
///   outcome.messages 对应条目 **同一 Arc 实例**（`Arc::ptr_eq`）——
///   旧形态每轮 `conversation.clone()` 每次都是新分配，身份共享必破；
/// - 记录路径：user/assistant 消息的 message-start/end 事件载荷与
///   outcome.messages 对应条目同一 Arc 实例（record_message 0 深克隆）。
///
/// 对照旧形态（AA-06 P3/P4）：100 消息会话一轮请求 = 100 次深拷贝 +
/// 每消息 2 次正文克隆 + 收口 1 次全量克隆——本测试证明以上均为 0。
#[tokio::test]
async fn long_conversation_request_and_record_are_zero_copy() {
    // 100 条历史消息（user/assistant 交替）
    let history: Vec<AgentMessage> = (0..100u32)
        .map(|i| AgentMessage {
            id: format!("hist-{i}"),
            role: if i % 2 == 0 {
                AgentMessageRole::User
            } else {
                AgentMessageRole::Assistant
            },
            created_at: "2026-01-01T00:00:00Z".into(),
            blocks: vec![AgentMessageBlock::Text {
                text: format!("历史消息 {i}"),
            }],
            metadata: None,
            client_message_id: None,
            content: None,
        })
        .collect();
    let provider_handle = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("回复"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let mut loop_ = loop_with_arc(provider_handle.clone(), vec![]);
    loop_ = loop_.with_initial_conversation(history);

    let outcome = loop_.run(user("你好")).await;
    assert_eq!(outcome.reason, AgentEndReason::Stop);
    assert_eq!(outcome.messages.len(), 102, "100 条历史 + user + assistant");

    // 请求链零拷贝：唯一一次调用的请求快照 = 100 条历史 + 用户消息，
    // 每条与 outcome.messages 对应条目同一 Arc 实例（0 深拷贝）
    let arcs = provider_handle.request_message_arcs(0);
    assert_eq!(arcs.len(), 101, "请求含 100 条历史 + 1 条用户消息");
    for (i, arc) in arcs.iter().enumerate() {
        assert!(
            Arc::ptr_eq(arc, &outcome.messages[i]),
            "请求链消息 {i} 必须与收口对话共享同一 Arc（0 深拷贝，O(n²) 旧形态必破）"
        );
    }

    // 记录路径零拷贝：user（index 100）与 assistant（index 101）的
    // message-start/end 事件载荷与 outcome.messages 对应条目同一 Arc 实例
    let mut event_arcs: Vec<&Arc<AgentMessage>> = Vec::new();
    for event in &outcome.events {
        match event {
            conex_types::events::AgentEvent::MessageStart { message, .. }
            | conex_types::events::AgentEvent::MessageEnd { message, .. } => {
                event_arcs.push(message);
            }
            _ => {}
        }
    }
    assert_eq!(event_arcs.len(), 4, "user/assistant 各 start+end 一对");
    for (label, event_arc, message_index) in [
        ("user start", event_arcs[0], 100),
        ("user end", event_arcs[1], 100),
        ("assistant start", event_arcs[2], 101),
        ("assistant end", event_arcs[3], 101),
    ] {
        assert!(
            Arc::ptr_eq(event_arc, &outcome.messages[message_index]),
            "记录路径 {label} 必须与收口对话共享同一 Arc（record_message 0 深克隆）"
        );
    }

    // 收口移交：converge 后 loop 内对话已清空（mem::take 零拷贝）
    assert!(
        loop_.conversation().is_empty(),
        "converge 收口后对话已移交 RunOutcome（mem::take 零拷贝）"
    );
}

/// T09.3.3 跨 run 语义（R4）：收口 mem::take 后对话移交 RunOutcome，
/// 复用同一 loop 续跑时用 with_initial_conversation 把上一轮 messages
/// 续接回对话——第二轮请求须包含第一轮全部消息（跨 run 语义保持可测；
/// 真实接线每 run 重建 loop，无需续接）
#[tokio::test]
async fn cross_run_continuation_via_with_initial_conversation() {
    let provider_handle = Arc::new(TestProvider::with_scripts(vec![
        vec![
            ProviderStreamEvent::text("第一轮回复"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        vec![
            ProviderStreamEvent::text("第二轮回复"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]));
    let mut loop_ = loop_with_arc(provider_handle.clone(), vec![]);

    let first = loop_.run(user("第一轮")).await;
    assert_eq!(first.reason, AgentEndReason::Stop);
    assert_eq!(first.messages.len(), 2, "user + assistant");

    // 收口后对话已移交（mem::take 零拷贝）：conversation 为空
    assert!(
        loop_.conversation().is_empty(),
        "converge 已 mem::take 清空对话（R4 行为变化登记）"
    );

    // 零拷贝续接：上一轮 outcome.messages（Arc 形态）直接回填
    loop_ = loop_.with_initial_conversation_arc(first.messages);

    let second = loop_.run(user("第二轮")).await;
    assert_eq!(second.reason, AgentEndReason::Stop);
    // 第二轮对话 = 第一轮 2 条 + 第二轮 user/assistant 2 条
    assert_eq!(second.messages.len(), 4, "跨 run 对话续接完整");
    // 第二轮请求快照 = 第一轮 2 条 + 第二轮用户消息（3 条）——历史进请求，
    // 且与第一轮收口消息同一 Arc 实例（续接零拷贝）
    let arcs = provider_handle.request_message_arcs(1);
    assert_eq!(arcs.len(), 3, "请求含第一轮 2 条 + 第二轮用户消息");
    assert_eq!(arcs[0].id, "user-第一轮");
    assert_eq!(arcs[1].text(), "第一轮回复");
    assert_eq!(arcs[2].id, "user-第二轮");
}

/// 工具调用不含文字 → 纯工具轮 → 结果续轮 → 最终 stop
#[tokio::test]
async fn tool_only_turn_then_reply() {
    let provider = TestProvider::with_scripts(vec![
        vec![
            ProviderStreamEvent::tool_call(Some("call_b".into()), "t1", serde_json::json!({})),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        vec![
            ProviderStreamEvent::text("结束。"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]);
    let tool = Arc::new(TestTool::new("t1", serde_json::json!({"ok": 1})));
    let mut loop_ = loop_with(provider, vec![tool]);

    let outcome = loop_.run(user("跑起来")).await;

    assert_eq!(outcome.reason, AgentEndReason::Stop);
    // 第一轮 assistant 消息无正文但有 tool-call 块（01 §2.4 期望语义；
    // 有 tool-call 即有效模型输出）
    let first_assistant = outcome
        .messages
        .iter()
        .find(|m| m.role == AgentMessageRole::Assistant)
        .expect("应有助手消息");
    assert!(first_assistant.text().is_empty());
    assert!(first_assistant.tool_calls().next().is_some());
}

/// ControlKind/ControlLevel 序列化与 L3 入队（control::bus 语义；run 内生效）
#[tokio::test]
async fn control_bus_levels_and_kinds() {
    let bus = session_loop::ControlBus::new();
    let _ = bus;
    // 语义已由 control.rs 单测覆盖；此处仅确认公开 API 可达
    assert_eq!(
        session_loop::level_for_kind(ControlKind::ForceCancel),
        ControlLevel::L3
    );
    assert_eq!(
        session_loop::level_for_kind(ControlKind::CooperativeStop),
        ControlLevel::L2
    );
    assert_eq!(
        session_loop::level_for_kind(ControlKind::SoftInject),
        ControlLevel::L1
    );
}

/// F1 盲区 7 / F2-04：空响应 + abort 竞速——abort 到达后不得执行策略
/// 评估、不得把 steering 注入消息写入对话（abort 后副作用）；直接
/// aborted 收场。
///
/// 注（诚实边界）：外部触发的 abort 在流消费期即被 Q33 复查（streaming.rs
/// :135/:151）捕获（finish_after_abort → StreamError(Aborted) 分支），
/// Empty 分支的复查（F2-04 修复）覆盖「分类后、注入前」的理论竞速窗口
/// （内部分类期触发 abort 的形态，当前外部时序不可达）——本测试钉住
/// 用户可见语义（abort → aborted 收场 + 零 steering 副作用），修复与
/// 早捕获路径共同保障该语义。
#[tokio::test]
async fn abort_during_empty_response_skips_steering_injection() {
    // Q41（T11.7.2）：虚拟时间护栏
    let _time = TimePauseGuard::new();
    let provider =
        TestProvider::new(vec![ProviderStreamEvent::stop(StopReason::Stop)]).with_pause(0, 300);
    let mut loop_ = loop_with(provider, vec![]);
    let abort = loop_.abort_signal();

    let handle = tokio::spawn(async move { loop_.run(user("回答")).await });
    // 栅栏停顿期间 L3 强停（分类完成后、steering 注入前窗口）
    tokio::time::advance(Duration::from_millis(80)).await;
    abort.abort();
    tokio::time::advance(Duration::from_millis(300)).await;
    let outcome = handle.await.expect("run 不应 panic");

    assert_eq!(outcome.reason, AgentEndReason::Aborted);
    // abort 后不得注入 steering 消息（system 角色，kind=steering 枚举 canonical）
    assert!(
        !outcome.messages.iter().any(|m| {
            m.role == AgentMessageRole::System
                && m.metadata
                    .as_ref()
                    .and_then(|meta| meta.get("kind"))
                    .and_then(|k| k.as_str())
                    == Some(
                        session_loop::steering::metadata_kind_wire(
                            conex_types::message::AgentMessageMetadataKind::Steering,
                        )
                        .as_str(),
                    )
        }),
        "abort 后不得执行 steering 注入（F2-04：abort 后副作用）"
    );
    // 无 runtime-steering / intervention 事件
    assert!(!outcome
        .events
        .iter()
        .any(|e| matches!(e, conex_types::events::AgentEvent::RuntimeSteering { .. })));
}

/// F1 盲区 5：空工具注册表 + 模型产出工具调用 → NotFound 非致命喂回 →
/// 续轮（整链路 streaming → executing-tools → 喂回，tool_exec 单测之外
/// 的端到端锚定）
#[tokio::test]
async fn empty_tool_registry_unknown_call_fed_back_and_continues() {
    let provider = TestProvider::with_scripts(vec![
        // 第 1 次：调用不存在的工具
        vec![
            ProviderStreamEvent::tool_call(
                Some("call_ghost".into()),
                "ghost_tool",
                serde_json::json!({}),
            ),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        // 第 2 次：喂回 NotFound 后模型正常回复
        vec![
            ProviderStreamEvent::text("没有这个工具，我换个方式"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]);
    // 空注册表（loop_with 无工具）
    let mut loop_ = loop_with(provider, vec![]);

    let outcome = loop_.run(user("用工具")).await;

    // 未知工具非致命：run 以 stop 收场（不 error）
    assert_eq!(outcome.reason, AgentEndReason::Stop);
    assert!(outcome.error.is_none());
    // 工具结果消息（Tool 角色）为错误形态（NotFound 喂回模型）
    let tool_msg = outcome
        .messages
        .iter()
        .find(|m| m.role == AgentMessageRole::Tool)
        .expect("未知工具也应产出 tool-result 消息");
    let AgentMessageBlock::ToolResult {
        is_error, output, ..
    } = &tool_msg.blocks[0]
    else {
        panic!("工具消息应有 tool-result 块");
    };
    assert!(*is_error, "未知工具结果应为错误形态");
    let text = output.text.as_deref().expect("NotFound 应有文本文案");
    assert!(
        text.contains("unknown tool"),
        "文案应含 unknown tool：{text}"
    );
    // 续轮：最终助手消息存在（模型对喂回结果正常收尾）
    let final_text = outcome
        .messages
        .iter()
        .rev()
        .find(|m| m.role == AgentMessageRole::Assistant)
        .expect("喂回后应有最终助手消息");
    assert_eq!(final_text.text(), "没有这个工具，我换个方式");
    // provider 调用 2 次（第 1 轮工具 + 喂回续轮；两轮 turn-start）
    let turn_starts = outcome
        .events
        .iter()
        .filter(|e| matches!(e, conex_types::events::AgentEvent::TurnStart { .. }))
        .count();
    assert_eq!(turn_starts, 2, "未知工具喂回后应续轮重进 provider");
}

/// F1 盲区 4：`transient_retry_limit = 0` 边界——首次瞬态错误即 error
/// 收场（不升级重试；0 = 不允许任何重试）
#[tokio::test]
async fn transient_retry_limit_zero_fails_immediately() {
    let provider_handle = Arc::new(
        TestProvider::new(vec![
            ProviderStreamEvent::text("不应到达"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ])
        .with_error(classified(ProviderErrorKind::RateLimit)),
    );
    let mut loop_ = loop_with_arc(provider_handle.clone(), vec![]);
    loop_ = loop_.with_options(SessionLoopOptions {
        transient_retry_limit: 0,
        ..Default::default()
    });

    let outcome = loop_.run(user("你好")).await;

    assert_eq!(
        outcome.reason,
        AgentEndReason::Error,
        "transient_retry_limit=0 时首次瞬态错误必须直接 error 收场"
    );
    assert!(outcome.error.is_some());
    // 无任何重试（provider 仅调用 1 次）
    assert_eq!(
        provider_handle.call_count(),
        1,
        "retry limit 0 不得发起任何重试"
    );
}

/// F1 盲区 4：`length_upgrade_limit = 0` 边界——首次 ContextLengthExceeded
/// 即 error 收场（长度阶梯不允许任何升级；默认无压缩预算 → 无恢复路径）
#[tokio::test]
async fn length_upgrade_limit_zero_fails_immediately() {
    let provider_handle = Arc::new(
        TestProvider::new(vec![
            ProviderStreamEvent::text("不应到达"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ])
        .with_error(classified(ProviderErrorKind::ContextLengthExceeded)),
    );
    let mut loop_ = loop_with_arc(provider_handle.clone(), vec![]);
    loop_ = loop_.with_options(SessionLoopOptions {
        length_upgrade_limit: 0,
        ..Default::default()
    });

    let outcome = loop_.run(user("你好")).await;

    assert_eq!(
        outcome.reason,
        AgentEndReason::Error,
        "length_upgrade_limit=0 时首次上下文超限必须直接 error 收场"
    );
    assert!(outcome.error.is_some());
    // 无升级重试（provider 仅调用 1 次）
    assert_eq!(
        provider_handle.call_count(),
        1,
        "length limit 0 不得发起任何升级重试"
    );
}

// ── EV-08：孤儿 turn-start 修复（「turn 对恒成对」不变量）───────────────

/// EV-08：「turn 对恒成对」不变量断言辅助——扫事件序列，每个 turn-start
/// 必被同 turn_index 的 turn-end 闭合（轮次集合一致 + 逐 index 计数配对；
/// 多余 / 缺失 / 索引不一致均失败）。被 ≥2 用例调用（方案验收断言 ⑤）。
fn assert_turn_pairs_closed(events: &[conex_types::events::AgentEvent]) {
    use std::collections::HashMap;
    let mut starts: HashMap<u32, u32> = HashMap::new();
    let mut ends: HashMap<u32, u32> = HashMap::new();
    for event in events {
        match event {
            conex_types::events::AgentEvent::TurnStart { turn_index, .. } => {
                *starts.entry(*turn_index).or_insert(0) += 1;
            }
            conex_types::events::AgentEvent::TurnEnd { turn_index, .. } => {
                *ends.entry(*turn_index).or_insert(0) += 1;
            }
            _ => {}
        }
    }
    assert_eq!(
        starts.len(),
        ends.len(),
        "turn 对恒成对：turn-start 与 turn-end 的轮次集合必须一致（孤儿 turn-start 修复，EV-08）"
    );
    for (index, start_count) in &starts {
        let end_count = ends.get(index).copied().unwrap_or(0);
        assert_eq!(
            start_count, &end_count,
            "turn 对恒成对：turn_index={index} 的 turn-start({start_count}) 必须被同轮次 \
             turn-end({end_count}) 闭合（EV-08：abort/强停/错误收敛路径不得产生孤儿 turn-start）"
        );
    }
}

/// EV-08：streaming 中途 abort（L3 强停）→ aborted 收场，turn-start 必须被
/// 同 turn_index 的 turn-end 闭合（修复前 streaming_aborted 收敛不经
/// turn_complete → 孤儿 turn-start）
#[tokio::test]
async fn turn_pair_invariant_mid_stream_abort() {
    // Q41（T11.7.2）：虚拟时间护栏（真实 sleep → advance 显式推进）
    let _time = TimePauseGuard::new();
    let provider = TestProvider::new(vec![
        ProviderStreamEvent::text("已流出的部分内容"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ])
    .with_pause(1, 300);
    let mut loop_ = loop_with(provider, vec![]);
    let abort = loop_.abort_signal();

    let handle = tokio::spawn(async move { loop_.run(user("生成内容")).await });
    // provider 正在栅栏停顿中 → L3 强停
    tokio::time::advance(Duration::from_millis(80)).await;
    abort.abort();
    // 越过 provider 栅栏（300ms 虚拟停顿），loop 读到 abort 并收场
    tokio::time::advance(Duration::from_millis(300)).await;
    let outcome = handle.await.expect("run 不应 panic");

    assert_eq!(outcome.reason, AgentEndReason::Aborted);
    // 不变量：turn-start 恒被同轮次 turn-end 闭合（streaming_aborted +
    // converge 兜底，EV-08）
    assert_turn_pairs_closed(&outcome.events);
    // 部分内容保留（partial salvage 不被修复破坏）
    let partial = outcome
        .messages
        .iter()
        .find(|m| m.role == AgentMessageRole::Assistant)
        .expect("部分内容应已 commit");
    assert_eq!(partial.text(), "已流出的部分内容");
}

/// EV-08：L3 force_cancel（经控制总线，流结束安全点 check_control 收敛）→
/// aborted 收场，turn 对恒成对（修复前 check_control 收敛路径缺 turn-end）
#[tokio::test]
async fn turn_pair_invariant_force_cancel_via_bus() {
    // Q41（T11.7.2）：虚拟时间护栏
    let _time = TimePauseGuard::new();
    let provider = TestProvider::new(vec![
        ProviderStreamEvent::text("部分内容"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ])
    .with_pause(1, 300);
    let mut loop_ = loop_with(provider, vec![]);
    let bus = loop_.control_bus();

    let handle = tokio::spawn(async move { loop_.run(user("跑起来")).await });
    tokio::time::advance(Duration::from_millis(80)).await;
    bus.lock()
        .unwrap()
        .request_force_cancel(Some("用户强停".into()), Some("ui".into()));
    // 越过 provider 栅栏（300ms 虚拟停顿），loop 才读到取消并收场
    tokio::time::advance(Duration::from_millis(300)).await;
    let outcome = handle.await.expect("run 不应 panic");

    assert_eq!(outcome.reason, AgentEndReason::Aborted);
    // 不变量：check_control 收敛路径也必须有 turn-end 闭合（EV-08）
    assert_turn_pairs_closed(&outcome.events);
}

/// EV-08：L2 cooperative_stop → stopped 收场（D1，不 abort），turn 对恒成对
/// （修复前 streaming_aborted CooperativeStop 分支收敛缺 turn-end）
#[tokio::test]
async fn turn_pair_invariant_cooperative_stop() {
    // Q41（T11.7.2）：虚拟时间护栏
    let _time = TimePauseGuard::new();
    let provider = TestProvider::new(vec![
        ProviderStreamEvent::text("这条消息保留"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ])
    .with_pause(1, 300);
    let mut loop_ = loop_with(provider, vec![]);
    let bus = loop_.control_bus();

    let handle = tokio::spawn(async move { loop_.run(user("开始")).await });
    tokio::time::advance(Duration::from_millis(80)).await;
    bus.lock()
        .unwrap()
        .request_cooperative_stop(Some("用户协作停止".into()), Some("test".into()));
    // 越过 provider 栅栏（300ms 虚拟停顿），loop 读到协作停止并收场
    tokio::time::advance(Duration::from_millis(300)).await;
    let outcome = handle.await.expect("run 不应 panic");

    // D1：独立 reason stopped
    assert_eq!(outcome.reason, AgentEndReason::Stopped);
    // 不变量：协作停止收敛路径同样闭合 turn（EV-08）
    assert_turn_pairs_closed(&outcome.events);
}

/// EV-08：工具致命错误（fatalOnError）→ error 收场，turn 对恒成对
/// （turn_complete 正常发射路径回归——修复不得破坏正常语义）
#[tokio::test]
async fn turn_pair_invariant_fatal_tool_error() {
    let provider = TestProvider::new(vec![
        ProviderStreamEvent::tool_call(Some("call_fail".into()), "fail", serde_json::json!({})),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]);
    let tool = Arc::new(TestTool::with_error("fail", "boom").with_fatal_on_error());
    let mut loop_ = loop_with(provider, vec![tool]);

    let outcome = loop_.run(user("执行")).await;

    assert_eq!(outcome.reason, AgentEndReason::Error);
    assert!(outcome.error.is_some());
    // 不变量：错误收敛路径 turn 恒成对（executing-tools ERROR → turn-complete
    // 正常发射，EV-08 回归）
    assert_turn_pairs_closed(&outcome.events);
}

/// EV-08：瞬态错误无重试预算（transient_retry_limit=0）→ 直接 error 收场，
/// turn 对恒成对（修复前 stream_error_fatal 直接 error 收敛不经 turn_complete
/// → 孤儿 turn-start；converge 兜底闭合）
#[tokio::test]
async fn turn_pair_invariant_transient_fatal_no_retry() {
    let provider_handle = Arc::new(
        TestProvider::new(vec![
            ProviderStreamEvent::text("不应到达"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ])
        .with_error(classified(ProviderErrorKind::RateLimit)),
    );
    let mut loop_ = loop_with_arc(provider_handle.clone(), vec![]);
    loop_ = loop_.with_options(SessionLoopOptions {
        transient_retry_limit: 0,
        ..Default::default()
    });

    let outcome = loop_.run(user("你好")).await;

    assert_eq!(outcome.reason, AgentEndReason::Error);
    assert!(outcome.error.is_some());
    // 不变量：provider fatal 直接 error 收敛路径也必须闭合 turn（EV-08）
    assert_turn_pairs_closed(&outcome.events);
}

/// EV-08：正常完成（纯文字回复 → stop）turn 对恒成对——正常语义回归
/// （修复不得改变 turn_complete 正常发射行为）
#[tokio::test]
async fn turn_pair_invariant_normal_stop() {
    let provider = TestProvider::new(vec![
        ProviderStreamEvent::text("你好，我是助手"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]);
    let mut loop_ = loop_with(provider, vec![]);

    let outcome = loop_.run(user("你好")).await;

    assert_eq!(outcome.reason, AgentEndReason::Stop);
    // 不变量：正常路径 turn 恒成对（EV-08 回归，与 event_sequence_contract
    // 互补——后者断言序列位置，本辅助断言配对计数）
    assert_turn_pairs_closed(&outcome.events);
    // 且 turn-end 的 tool_call_count 与 turn-start 轮次对应（载荷一致性抽查）
    let starts: Vec<u32> = outcome
        .events
        .iter()
        .filter_map(|e| match e {
            conex_types::events::AgentEvent::TurnStart { turn_index, .. } => Some(*turn_index),
            _ => None,
        })
        .collect();
    assert_eq!(
        starts,
        vec![1],
        "首轮 turn-start 轮次为 1（TURN_PREPARED 递增后）"
    );
}

/// EV-11（D-03 EV-13）S5 测钉：provider 请求锚点——请求发出 → 事件序列含
/// provider-request-anchored（turn_index 与当前轮 turn-start 一致、model
/// 非空=注入的当前模型名、request_started_at_ms 非零且与事件自身 timestamp
/// 同毫秒）；其后 message-delta timestamp ≥ 锚点时间戳（首字节延迟可测面）
#[tokio::test]
async fn provider_request_anchored_carries_turn_model_and_precedes_delta() {
    use conex_types::events::AgentEvent;
    let provider = TestProvider::new(vec![
        ProviderStreamEvent::text("锚点回复"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]);
    let mut loop_ = loop_with(provider, vec![]);
    // 注入缓存测量配置 → 模型名经 cache_tracker 装配面进入锚点载荷
    loop_ = loop_.with_options(SessionLoopOptions {
        cache_tracking: Some(session_loop::CacheTrackingConfig {
            provider: "deepseek".to_string(),
            model: "deepseek-v4-flash".to_string(),
            ttl_seconds: 60,
        }),
        ..Default::default()
    });

    let outcome = loop_.run(user("验证")).await;
    assert_eq!(outcome.reason, AgentEndReason::Stop);

    // turn-start 的 turn_index（当前轮展示值）
    let turn_index = outcome
        .events
        .iter()
        .find_map(|e| match e {
            AgentEvent::TurnStart { turn_index, .. } => Some(*turn_index),
            _ => None,
        })
        .expect("必须有 turn-start");
    // 锚点：turn_index 与当前轮一致、model 非空、request_started_at_ms 非零
    let anchors: Vec<_> = outcome
        .events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::ProviderRequestAnchored {
                turn_index,
                model,
                request_started_at_ms,
                timestamp,
                ..
            } => Some((
                *turn_index,
                model.clone(),
                *request_started_at_ms,
                timestamp.clone(),
            )),
            _ => None,
        })
        .collect();
    assert_eq!(anchors.len(), 1, "单轮 run 恰好一次请求锚点");
    let (anchor_turn, model, started_ms, anchor_ts) = &anchors[0];
    assert_eq!(anchor_turn, &turn_index, "锚点 turn_index 必须与当前轮一致");
    assert!(
        model.is_some() && !model.as_deref().unwrap().is_empty(),
        "注入缓存配置后 model 必须非空：{model:?}"
    );
    assert_eq!(model.as_deref(), Some("deepseek-v4-flash"));
    assert!(*started_ms > 0, "request_started_at_ms 必须非零");
    // 锚点事件自身 timestamp 与 request_started_at_ms 同一毫秒（±1ms 容差）
    let anchor_ts_ms = iso_to_epoch_ms(anchor_ts);
    assert!(
        started_ms.abs_diff(anchor_ts_ms) <= 1,
        "锚点 timestamp 与 request_started_at_ms 必须同毫秒：{started_ms} vs {anchor_ts_ms}"
    );
    // 锚点在事件序列中先于首个 message-delta（请求发出 → 首字节）
    let anchor_idx = outcome
        .events
        .iter()
        .position(|e| matches!(e, AgentEvent::ProviderRequestAnchored { .. }))
        .expect("锚点在序列中");
    let first_delta = outcome
        .events
        .iter()
        .position(|e| matches!(e, AgentEvent::MessageDelta { .. }))
        .expect("收口 message-delta 在序列中");
    assert!(anchor_idx < first_delta, "锚点必须先于 message-delta 发出");
    // 首个 message-delta timestamp ≥ 锚点时间戳（首字节延迟非负可测）
    let delta_ts_ms = outcome
        .events
        .iter()
        .find_map(|e| match e {
            AgentEvent::MessageDelta { timestamp, .. } => Some(iso_to_epoch_ms(timestamp)),
            _ => None,
        })
        .expect("message-delta 必有 timestamp");
    assert!(
        delta_ts_ms >= *started_ms,
        "首个 message-delta 时间戳 {delta_ts_ms}ms 必须 ≥ 锚点 {started_ms}ms"
    );
}

/// EV-11（D-03 EV-13）S5 测钉：TurnEnd usage 真值——带 usage 的流 →
/// TurnEnd.usage = 六字段 TurnUsage（prompt/completion/total/cache_read/
/// cache_write/cache_miss）；provider 未报告 usage → TurnEnd.usage = None
/// （旧帧缺省兼容，不猜估算值）
#[tokio::test]
async fn turn_end_carries_turn_usage_from_provider() {
    use conex_types::events::{AgentEvent, TurnUsage};
    // 带 usage 的流（ProviderUsage camelCase 六键，consume 收口写入
    // metadata.usage；cache_miss_tokens=None → 键省略 → 提取为 0）
    let provider = TestProvider::new(vec![
        ProviderStreamEvent::text("用量回复"),
        ProviderStreamEvent::Stop {
            reason: StopReason::Stop,
            error: None,
            error_kind: None,
            usage: Some(session_loop::ProviderUsage {
                prompt_tokens: Some(1_000),
                completion_tokens: Some(50),
                total_tokens: Some(1_050),
                cache_read_tokens: Some(800),
                cache_write_tokens: Some(100),
                cache_miss_tokens: None,
                reasoning_tokens: None,
            }),
        },
    ]);
    let mut loop_ = loop_with(provider, vec![]);
    let outcome = loop_.run(user("验证")).await;
    assert_eq!(outcome.reason, AgentEndReason::Stop);

    let usage = outcome
        .events
        .iter()
        .find_map(|e| match e {
            AgentEvent::TurnEnd { usage, .. } => usage.clone(),
            _ => None,
        })
        .expect("run 必须发射 turn-end 且带 usage 真值（find_map 已展平 Option）");
    assert_eq!(
        usage,
        TurnUsage {
            prompt_tokens: 1_000,
            completion_tokens: 50,
            total_tokens: 1_050,
            cache_read_tokens: 800,
            cache_write_tokens: 100,
            cache_miss_tokens: 0,
        },
        "TurnEnd.usage 六字段必须与 provider 报告一致"
    );

    // 对照：无 usage 的流 → TurnEnd.usage = None（旧帧缺省兼容）
    let provider2 = TestProvider::new(vec![
        ProviderStreamEvent::text("无用量回复"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]);
    let mut loop2 = loop_with(provider2, vec![]);
    let outcome2 = loop2.run(user("验证")).await;
    let usage2 = outcome2.events.iter().find_map(|e| match e {
        AgentEvent::TurnEnd { usage, .. } => usage.clone(),
        _ => None,
    });
    assert!(
        outcome2
            .events
            .iter()
            .any(|e| matches!(e, AgentEvent::TurnEnd { .. })),
        "run 必须发射 turn-end"
    );
    assert_eq!(
        usage2, None,
        "provider 未报告 usage 时 TurnEnd.usage 保持 None"
    );
}

/// ISO8601（`YYYY-MM-DDTHH:MM:SS.mmmZ`，now_iso_utc 固定格式）→ epoch 毫秒
/// （测试内轻量解析，无 chrono 依赖；civil-from-days 逆运算）
fn iso_to_epoch_ms(iso: &str) -> u64 {
    let parts: Vec<u64> = iso
        .split(|c: char| c == '-' || c == 'T' || c == ':' || c == '.' || c == 'Z')
        .filter(|s| !s.is_empty())
        .map(|s| s.parse().expect("ISO 字段必须可解析"))
        .collect();
    let (y, mo, d) = (parts[0], parts[1], parts[2]);
    let (h, mi, s, ms) = (parts[3], parts[4], parts[5], parts[6]);
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2 / 400;
    let yoe = y2 - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    days * 86_400_000 + h * 3_600_000 + mi * 60_000 + s * 1_000 + ms
}

// ── EV-03（D-03）：循环决策事件组 + EV-09（D-03）：工具原子要素组 ──────

/// 构造带任意类型工具注册表的循环（EV-09 慢速工具测钉用——与
/// `loop_with` 的 `Vec<Arc<TestTool>>` 区分，注册表 register 接受
/// `Arc<dyn Tool>` 可擦除）
fn loop_with_tools<T>(provider: TestProvider, tools: Vec<Arc<T>>) -> AgentSessionLoop
where
    T: agent_tools::definition::Tool + Send + Sync + 'static,
{
    let mut registry = ToolRegistry::new();
    for tool in tools {
        registry.register(tool).expect("注册测试工具");
    }
    AgentSessionLoop::new(
        "sess-1",
        "run-1",
        16,
        Box::new(provider),
        Arc::new(registry),
    )
    .with_steering(default_steering())
}

/// 慢速失败工具（EV-09 测钉）：执行 50ms 后抛错——失败路径 duration_ms
/// 真实化断言素材（执行耗时非 0）
struct SlowFailTool {
    name: String,
    definition: agent_tools::definition::ToolDefinition,
}

impl SlowFailTool {
    fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
            definition: agent_tools::definition::ToolDefinition {
                name: name.to_string(),
                description: format!("slow fail tool {name}"),
                input_schema: serde_json::json!({"type": "object"}),
                dangerous: false,
                fatal_on_error: false,
            },
        }
    }
}

#[async_trait]
impl agent_tools::definition::Tool for SlowFailTool {
    fn name(&self) -> &str {
        &self.name
    }

    fn definition(&self) -> &agent_tools::definition::ToolDefinition {
        &self.definition
    }

    async fn execute(
        &self,
        _ctx: &agent_tools::context::ToolContext,
        _args: serde_json::Value,
    ) -> Result<serde_json::Value, agent_tools::definition::ToolError> {
        tokio::time::sleep(Duration::from_millis(50)).await;
        Err(agent_tools::definition::ToolError::execution_failed(
            &self.name,
            "slow boom",
        ))
    }
}

/// EV-03（D-03）：empty-response steering 注入后事件序列含
/// steering-evaluated（phase=empty-response，reset=false；命中策略 +
/// 计数前后 + budget 剩余）；恢复后正常结束路径发 reset=true 变体
/// （no-tool-calls 重置点）
#[tokio::test]
async fn empty_response_emits_steering_evaluated_event() {
    let provider = TestProvider::with_scripts(vec![
        // 第 1 次：空响应
        vec![ProviderStreamEvent::stop(StopReason::Stop)],
        // 第 2 次：注入后正常回复
        vec![
            ProviderStreamEvent::text("抱歉，我重新回答了"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]);
    let mut loop_ = loop_with(provider, vec![]);

    let outcome = loop_.run(user("回答")).await;
    assert_eq!(outcome.reason, AgentEndReason::Stop);

    // S5 测钉：快照记录 steering-evaluated 事件 + getter + 断言
    let evaluated: Vec<&conex_types::events::AgentEvent> = outcome
        .events
        .iter()
        .filter(|e| matches!(e, conex_types::events::AgentEvent::SteeringEvaluated { .. }))
        .collect();
    assert!(
        !evaluated.is_empty(),
        "事件序列必须含 steering-evaluated（EV-03 发射点接线）"
    );
    // evaluate 变体（phase=empty-response，reset=false，命中 recovery）
    let evaluate_evt = evaluated.iter().find_map(|e| match e {
        conex_types::events::AgentEvent::SteeringEvaluated {
            phase,
            hit_strategies,
            steering_count_before,
            steering_count_after,
            budget_remaining,
            reset,
            ..
        } if !reset => Some((
            phase,
            hit_strategies,
            steering_count_before,
            steering_count_after,
            budget_remaining,
        )),
        _ => None,
    });
    let (phase, hits, before, after, budget) = evaluate_evt.expect("必须有 evaluate 变体");
    assert_eq!(phase, "empty-response");
    assert!(
        hits.contains(&"recovery".to_string()),
        "命中策略含 recovery"
    );
    assert_eq!(*before, 0);
    assert_eq!(*after, 1, "潜在计数含本次注入预占");
    // budget_remaining = max_steering_budget − 实际计数（评估时 apply 未
    // 执行，计数仍 0 → 全预算 3；潜在扣减由 steering_count_after 承载）
    assert_eq!(*budget, Some(3), "评估时点实际计数 0 → 预算剩余 3");
    // reset 变体（恢复后 no-tool-calls 正常结束重置点，计数清零）
    let reset_evt = evaluated.iter().find_map(|e| match e {
        conex_types::events::AgentEvent::SteeringEvaluated {
            phase,
            steering_count_before,
            steering_count_after,
            reset,
            ..
        } if *reset => Some((phase, steering_count_before, steering_count_after)),
        _ => None,
    });
    let (reset_phase, reset_before, reset_after) = reset_evt.expect("必须有 reset 变体");
    assert_eq!(reset_phase, "no-tool-calls");
    assert_eq!(*reset_before, 1, "reset 前计数 = 注入后计数");
    assert_eq!(*reset_after, 0, "reset 后计数清零");
}

/// EV-03（D-03）：length 阶梯升级后 provider-diagnostic kind=length-escalation
/// （attempt=1、maxTokens 8192→16384 前后值随 reason 载荷；对齐
/// stream_error_retry.rs 的 phase=Retry 载荷先例）
#[tokio::test]
async fn length_ladder_emits_length_escalation_diagnostic() {
    let provider = TestProvider::with_scripts(vec![
        // 第 1 次：length 截断
        vec![
            ProviderStreamEvent::text("这是截断的长回复"),
            ProviderStreamEvent::stop(StopReason::Length),
        ],
        // 第 2 次：升级 max_tokens 后完整回复
        vec![
            ProviderStreamEvent::text("完整回复"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]);
    let mut loop_ = loop_with(provider, vec![]);

    let outcome = loop_.run(user("写长文")).await;
    assert_eq!(outcome.reason, AgentEndReason::Stop);

    // S5 测钉：length-escalation 诊断载荷断言
    let diag = outcome
        .events
        .iter()
        .find_map(|e| match e {
            conex_types::events::AgentEvent::ProviderDiagnostic { diagnostic, .. } => {
                Some(diagnostic)
            }
            _ => None,
        })
        .expect("length 升级必须发 provider-diagnostic 事件");
    let reason = diag.reason.as_deref().unwrap_or_default();
    assert!(
        reason.contains("length-escalation"),
        "kind=length-escalation 标识随 reason：{reason}"
    );
    assert!(
        reason.contains("8192") && reason.contains("16384"),
        "maxTokens 升级前后值随载荷：{reason}"
    );
    assert_eq!(diag.attempt, Some(1), "attempt=1（首次升级）");
    assert_eq!(diag.max_attempts, Some(2), "阶梯上限 2");
}

/// EV-09（D-03）：工具失败 duration_ms 真实化——慢速失败工具（50ms 后
/// 抛错）的 tool-end duration_ms ≥ 实际执行时长下限；attempt=1、
/// deduplicated=false、executed_input 非空（实际入参）
#[tokio::test]
async fn tool_failure_carries_real_duration_and_atoms() {
    let provider = TestProvider::with_scripts(vec![
        // 第 1 轮：工具调用（慢速失败）
        vec![
            ProviderStreamEvent::tool_call(
                Some("call_slow".into()),
                "slow_fail",
                serde_json::json!({"v": 1}),
            ),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        // 第 2 轮：读工具结果后正常结束
        vec![
            ProviderStreamEvent::text("工具失败了，我继续"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]);
    let tool = Arc::new(SlowFailTool::new("slow_fail"));
    let mut loop_ = loop_with_tools(provider, vec![tool]);

    let outcome = loop_.run(user("执行")).await;
    assert_eq!(outcome.reason, AgentEndReason::Stop);

    // tool-end 载荷：duration_ms 非零 + 原子要素真值
    let tool_end = outcome
        .events
        .iter()
        .find_map(|e| match e {
            conex_types::events::AgentEvent::ToolEnd {
                result,
                attempt,
                deduplicated,
                executed_input,
                ..
            } => Some((result, attempt, deduplicated, executed_input)),
            _ => None,
        })
        .expect("run 必须发射 tool-end");
    let (result, attempt, deduplicated, executed_input) = tool_end;
    assert!(result.is_error, "慢速工具抛错");
    assert!(
        result.duration_ms >= 40,
        "失败路径 duration_ms 必须 ≥ 实际执行时长（50ms 睡眠，实测 {}）",
        result.duration_ms
    );
    assert_eq!(attempt, &Some(1), "无审批重试 → attempt=1");
    assert_eq!(deduplicated, &Some(false), "无幂等命中");
    assert_eq!(
        executed_input,
        &Some(serde_json::json!({"v": 1})),
        "实际入参 = 模型下发入参（无中间件改写）"
    );
}

/// EV-09（D-03）：批事件 calls 摘要级填充 + turn_index 真值——并行批
/// 2 工具：tool-batch-start.calls 非空（id+toolName，入参不复制）、
/// tool-batch-end.calls 非空（status+duration）、tool-start.turn_index
/// = 当前轮次、tool-start.timestamp ≤ tool-end.timestamp（occurred_at
/// 打点回填）
#[tokio::test]
async fn batch_tool_events_carry_summary_calls_and_turn_index() {
    let provider = TestProvider::with_scripts(vec![
        // 第 1 轮：并行两个工具调用
        vec![
            ProviderStreamEvent::tool_call(
                Some("call_b1".into()),
                "echo",
                serde_json::json!({"v": "x"}),
            ),
            ProviderStreamEvent::tool_call(
                Some("call_b2".into()),
                "echo",
                serde_json::json!({"v": "y"}),
            ),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        // 第 2 轮：正常收尾
        vec![
            ProviderStreamEvent::text("两个工具都完成了"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]);
    let tool = Arc::new(TestTool::new("echo", serde_json::json!({"ok": true})));
    let mut loop_ = loop_with(provider, vec![tool]);

    let outcome = loop_.run(user("并行执行")).await;
    assert_eq!(outcome.reason, AgentEndReason::Stop);

    // 批开始 calls 摘要级（id + toolName；input 摘要级不复制全量入参）
    let batch_start = outcome
        .events
        .iter()
        .find_map(|e| match e {
            conex_types::events::AgentEvent::ToolBatchStart { calls, .. } => Some(calls),
            _ => None,
        })
        .expect("必须发射 tool-batch-start");
    assert_eq!(batch_start.len(), 2, "批 calls 非空（摘要级填充）");
    assert_eq!(batch_start[0].id, "call_b1");
    assert_eq!(batch_start[0].tool_name, "echo");
    assert_eq!(batch_start[1].id, "call_b2");
    assert_eq!(batch_start[1].tool_name, "echo");
    assert!(
        batch_start.iter().all(|c| c.input.is_null()),
        "摘要级：批 calls 不复制全量入参（全量由 tool-start 承载）"
    );
    // 批结束 calls 摘要级（status + duration）
    let batch_end = outcome
        .events
        .iter()
        .find_map(|e| match e {
            conex_types::events::AgentEvent::ToolBatchEnd { calls, .. } => Some(calls),
            _ => None,
        })
        .expect("必须发射 tool-batch-end");
    assert_eq!(batch_end.len(), 2, "批结束 calls 非空");
    assert!(!batch_end[0].is_error && !batch_end[1].is_error);
    // tool-start turn_index 真值 + occurred_at 打点顺序
    let starts: Vec<_> = outcome
        .events
        .iter()
        .filter_map(|e| match e {
            conex_types::events::AgentEvent::ToolStart {
                turn_index,
                timestamp,
                call,
                ..
            } => Some((*turn_index, timestamp.clone(), call.id.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(starts.len(), 2);
    for (turn_index, _, id) in &starts {
        assert_eq!(
            *turn_index,
            Some(1u32),
            "tool-start.turn_index = 当前轮次（{id}）"
        );
    }
    let end_timestamps: Vec<String> = outcome
        .events
        .iter()
        .filter_map(|e| match e {
            conex_types::events::AgentEvent::ToolEnd { timestamp, .. } => Some(timestamp.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(end_timestamps.len(), 2);
    for (i, (_, start_ts, _)) in starts.iter().enumerate() {
        assert!(
            start_ts.as_str() <= end_timestamps[i].as_str(),
            "tool-start.timestamp ≤ tool-end.timestamp（occurred_at 打点回填）：{start_ts} vs {}",
            end_timestamps[i]
        );
    }
    // tool-end attempt 真值（并行路径透传）
    let attempts: Vec<_> = outcome
        .events
        .iter()
        .filter_map(|e| match e {
            conex_types::events::AgentEvent::ToolEnd { attempt, .. } => *attempt,
            _ => None,
        })
        .collect();
    assert_eq!(attempts, vec![1u32, 1], "并行批 attempt=1");
}

/// EV-04（D-03）：control-intent 入队/消费两态——L2 cooperative_stop
/// 经总线入队 → 下一安全点消费：事件序列含 control-intent(enqueued) →
/// control-intent(consumed) 且 intent_id 相同、reason 透出（不再丢弃）
#[tokio::test]
async fn control_intent_emits_enqueued_and_consumed() {
    // Q41（T11.7.2）：虚拟时间护栏（真实 sleep → advance 显式推进）
    let _time = TimePauseGuard::new();
    let provider = TestProvider::new(vec![
        ProviderStreamEvent::text("这条消息保留"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ])
    .with_pause(1, 300);
    let mut loop_ = loop_with(provider, vec![]);
    let bus = loop_.control_bus();

    let handle = tokio::spawn(async move { loop_.run(user("开始")).await });
    tokio::time::advance(Duration::from_millis(80)).await;
    bus.lock()
        .unwrap()
        .request_cooperative_stop(Some("用户协作停止".into()), Some("test".into()));
    // 越过 provider 栅栏（300ms 虚拟停顿），loop 读到协作停止并收场
    tokio::time::advance(Duration::from_millis(300)).await;
    let outcome = handle.await.expect("run 不应 panic");

    assert_eq!(outcome.reason, AgentEndReason::Stopped);

    // S5 测钉：control-intent 两态配对断言
    let intents: Vec<(String, String, Option<String>, Option<String>, String)> = outcome
        .events
        .iter()
        .filter_map(|e| match e {
            conex_types::events::AgentEvent::ControlIntent {
                kind,
                intent_id,
                source,
                reason,
                state,
                ..
            } => Some((
                kind.clone(),
                intent_id.clone(),
                source.clone(),
                reason.clone(),
                state.clone(),
            )),
            _ => None,
        })
        .collect();
    assert!(
        !intents.is_empty(),
        "事件序列必须含 control-intent（EV-04 两态发射）"
    );
    let enqueued = intents
        .iter()
        .find(|(_, _, _, _, state)| state == "enqueued")
        .expect("必须有 enqueued 态");
    let consumed = intents
        .iter()
        .find(|(_, _, _, _, state)| state == "consumed")
        .expect("必须有 consumed 态");
    assert_eq!(enqueued.0, "cooperative-stop");
    assert_eq!(enqueued.1, consumed.1, "intent_id 两态配对");
    assert_eq!(enqueued.2.as_deref(), Some("test"), "source 透出");
    assert_eq!(
        enqueued.3.as_deref(),
        Some("用户协作停止"),
        "cooperative_stop 的 reason 不再丢弃"
    );
    assert_eq!(
        consumed.3.as_deref(),
        Some("用户协作停止"),
        "consumed 同样携带 reason"
    );
}
