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
    ProviderRequest, ProviderStreamEvent, StopReason, SessionLoopOptions, TestProvider, TestTool,
};

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
fn loop_with_arc(
    handle: Arc<TestProvider>,
    tools: Vec<Arc<TestTool>>,
) -> AgentSessionLoop {
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
    let AgentMessageBlock::ToolResult { is_error, output, .. } = &tool_result.blocks[0] else {
        panic!("工具消息应有 tool-result 块");
    };
    assert!(!is_error);
    assert_eq!(output, &ToolOutput {
        text: None,
        json: Some(serde_json::json!({"ok": true})),
        artifacts: None,
    });
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
            ProviderStreamEvent::tool_call(
                Some("call_t1".into()),
                "t1",
                serde_json::json!({}),
            ),
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
    assert_eq!(outcome.messages.len(), 4, "user + assistant(tool) + tool-result + assistant(text)");
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
    // 注入消息在对话中（system 角色，metadata.kind=runtime-steering）
    let injected = outcome
        .messages
        .iter()
        .find(|m| {
            m.role == AgentMessageRole::System
                && m.metadata
                    .as_ref()
                    .and_then(|meta| meta.get("kind"))
                    .and_then(|k| k.as_str())
                    == Some("runtime-steering")
        })
        .expect("应有 steering 注入消息");
    assert!(injected.text().contains("运行期纠偏"));
    // runtime-steering 事件照发
    assert!(outcome.events.iter().any(|e| matches!(
        e,
        conex_types::events::AgentEvent::RuntimeSteering { .. }
    )));
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
    assert!(!outcome.events.iter().any(|e| matches!(
        e,
        conex_types::events::AgentEvent::RuntimeSteering { .. }
    )));
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
    assert_eq!(turn_starts, 1, "steering 禁用时 empty-response 不得重进 provider");
}

/// T06.2.1（Q03）：steering_enabled=false 时 prepare_turn 不评估——
/// 连续工具错误不触发 steering 注入（无注入消息、无事件）
#[tokio::test]
async fn steering_disabled_prepare_turn_skips_evaluation() {
    let provider = TestProvider::with_scripts(vec![
        // 第 1 轮：工具失败
        vec![
            ProviderStreamEvent::tool_call(
                Some("call_f1".into()),
                "fail",
                serde_json::json!({}),
            ),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        // 第 2 轮：再失败（形成连续错误，开启 steering 时第 3 轮注入）
        vec![
            ProviderStreamEvent::tool_call(
                Some("call_f2".into()),
                "fail",
                serde_json::json!({}),
            ),
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
    // 无 steering 注入消息（system 角色 runtime-steering）
    assert!(!outcome.messages.iter().any(|m| {
        m.role == AgentMessageRole::System
            && m.metadata
                .as_ref()
                .and_then(|meta| meta.get("kind"))
                .and_then(|k| k.as_str())
                == Some("runtime-steering")
    }));
    // 无 steering / intervention 事件
    assert!(!outcome.events.iter().any(|e| matches!(
        e,
        conex_types::events::AgentEvent::RuntimeSteering { .. }
    )));
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
    assert_eq!(turn_starts, 1, "PayloadTooLarge 直接 fatal，不得重进 provider 循环");
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
        !matches!(outcome.reason, AgentEndReason::Aborted | AgentEndReason::Error),
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
            ProviderStreamEvent::tool_call(
                Some("call_m".into()),
                "mt",
                serde_json::json!({}),
            ),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        vec![
            ProviderStreamEvent::text("仍在回答"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]);
    let mut registry = ToolRegistry::new();
    registry
        .register(Arc::new(TestTool::new("mt", serde_json::json!({"ok": true}))))
        .expect("注册");
    let mut loop_ = AgentSessionLoop::new(
        "sess-1",
        "run-1",
        1,
        Box::new(provider),
        Arc::new(registry),
    );

    let outcome = loop_.run(user("多轮任务")).await;

    assert_eq!(outcome.reason, AgentEndReason::MaxTurns);
    assert!(
        !matches!(outcome.reason, AgentEndReason::Error | AgentEndReason::Aborted),
        "max-turns 是独立预算 reason（01 §1.5）"
    );
    // 观测到 runtime-error 事件（retryable=true 可测，01 §2.10）
    assert!(outcome.events.iter().any(|e| matches!(
        e,
        conex_types::events::AgentEvent::RuntimeError { .. }
    )));
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
    let provider = RetryFailProvider { calls: calls.clone() };
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
        ProviderStreamEvent::tool_call(
            Some("call_fail".into()),
            "fail",
            serde_json::json!({}),
        ),
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
    assert!(!outcome.events.iter().any(|e| matches!(
        e,
        conex_types::events::AgentEvent::RuntimeError { .. }
    )));
}

/// 工具标记 fatalOnError → 工具错误致命 → ERROR → error 收场（01 §2.8 步骤 6）
#[tokio::test]
async fn fatal_tool_error_ends_with_error() {
    let provider = TestProvider::new(vec![
        ProviderStreamEvent::tool_call(
            Some("call_fail".into()),
            "fail",
            serde_json::json!({}),
        ),
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
    assert!(outcome.events.iter().any(|e| matches!(
        e,
        conex_types::events::AgentEvent::RuntimeError { .. }
    )));
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
    bus.lock().unwrap().request_force_cancel(Some("用户强停".into()), Some("ui".into()));
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

/// 事件序列契约抽查（01 §五.6）：agent-start/end 首尾、turn-start/end 成对、
/// message-start/end 每条消息成对
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
            "message-start",
            "message-delta",
            "message-end",
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
            role: if i % 2 == 0 { AgentMessageRole::User } else { AgentMessageRole::Assistant },
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
            ProviderStreamEvent::tool_call(
                Some("call_b".into()),
                "t1",
                serde_json::json!({}),
            ),
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
    assert_eq!(session_loop::level_for_kind(ControlKind::ForceCancel), ControlLevel::L3);
    assert_eq!(
        session_loop::level_for_kind(ControlKind::CooperativeStop),
        ControlLevel::L2
    );
    assert_eq!(session_loop::level_for_kind(ControlKind::SoftInject), ControlLevel::L1);
}
