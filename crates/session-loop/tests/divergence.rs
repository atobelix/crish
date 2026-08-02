//! 分歧点核对测试（任务书 B7.3：01 §四 D1-D10 + 00 §3 D1-D6 全覆盖核对）
//!
//! 每个分歧点至少一个**正向断言**（裁决后行为）+ 一个**反向断言**
//! （旧行为不复现）。裁决依据逐条注释：
//! - D1：01 §四 D1 / 00 §3 D1 —— cooperative_stop 独立 reason（stopped），
//!   非 aborted 非 error，run 终态不触发自动续轮；
//! - D2：01 §四 D2 / 00 §3 D2 —— tool-promise steering 删除：承诺性语言无
//!   tool_call → stop 收场，不注入 nudge、不发 runtime-error 诊断；
//! - D3：01 §四 D3 —— 预注入短路保留：有 runnable pending 时 steering 评估
//!   跳过（不重复注入）；
//! - D4：01 §四 D4 —— 自终止诊断保留为非 error 语义事件（诊断发出但 run
//!   不收 error）；
//! - D5：01 §四 D6 / 00 §3 D5 —— 模型输出与传输错误分离：文字 + error 事件
//!   → Message 收场（stopReason=error 一票否决不复现）；
//! - D6：01 §四 D7 / 00 §3 D6 —— empty-response 预算内重试、耗尽 stop 收场
//!   （intervention 不以 error 收场）；
//! - D7：01 §四 D7 —— intervention 事件照发但 run stop（不以 error 收场）；
//! - D8：01 §四 D8 —— run 内不注入 nudge（nudge 排入下一条用户消息）；
//! - D9：01 §四 D9 —— 预算耗尽禁止 inject-message 且 stop 收场；
//! - D10：01 §四 D10 —— 无 ctx.steeringCount 死检查（计数唯一增量点在 apply）。
//!
//! 复用现有 TestProvider / TestTool（B3.6），直接驱动 AgentSessionLoop
//! （B3.4 公开 API），不引入新依赖。

use std::sync::Arc;
use std::time::Duration;

use agent_tools::registry::ToolRegistry;
use conex_test_utils::clock::TimePauseGuard;
use conex_types::events::AgentEvent;
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use conex_types::session::AgentEndReason;
use conex_types::tool::{ProviderDiagnostic, ProviderDiagnosticPhase};
use session_loop::{
    AgentSessionLoop, InputEnqueueMode, PendingNudgeChannel, ProviderStreamEvent,
    SelfTerminationDiagnostic, SteeringReason, StopReason, TestProvider, TestTool,
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

/// 统计对话中的 runtime-steering 注入消息（system 角色，metadata.kind=runtime-steering；
/// Arc 共享形态，PE-09 T09.3.2）
fn injected_steering_count(messages: &[Arc<AgentMessage>]) -> usize {
    messages
        .iter()
        .filter(|m| {
            m.role == AgentMessageRole::System
                && m.metadata
                    .as_ref()
                    .and_then(|meta| meta.get("kind"))
                    .and_then(|k| k.as_str())
                    == Some("runtime-steering")
        })
        .count()
}

/// 事件序列中是否存在 runtime-error 事件
fn has_runtime_error(events: &[AgentEvent]) -> bool {
    events
        .iter()
        .any(|e| matches!(e, AgentEvent::RuntimeError { .. }))
}

// ── D1：cooperative_stop → 独立 reason 'stopped'，不续轮 ──

/// D1 正向：cooperative_stop（L2）→ stopped 收场，已产出内容保留；
/// run 终态不触发自动续轮（TurnStart 仅 1 次，无 NEXT_TURN 续轮）。
///
/// 裁决（01 §四 D1 / 00 §3 D1）：用户协作停止 ≠ 错误也不等于取消，
/// 独立 reason（Stopped）；orchestrator 层明确「cooperative stop 不自动续轮」。
#[tokio::test]
async fn d1_cooperative_stop_ends_stopped_no_auto_continuation() {
    // Q41（T11.7.2）：虚拟时间护栏——真实 sleep 改为 advance 显式推进
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

    // 正向：独立 reason stopped，内容保留
    assert_eq!(outcome.reason, AgentEndReason::Stopped);
    let assistant = outcome
        .messages
        .iter()
        .find(|m| m.role == AgentMessageRole::Assistant)
        .expect("协作停止不丢已产出内容");
    assert_eq!(assistant.text(), "这条消息保留");
    // agent-end 事件 reason 同步为 stopped
    let end = outcome
        .events
        .iter()
        .find_map(|e| match e {
            AgentEvent::AgentEnd { reason, .. } => Some(*reason),
            _ => None,
        })
        .expect("应有 agent-end 事件");
    assert_eq!(end, AgentEndReason::Stopped);
    // 反向：非 aborted 非 error（runtime 旧行为 = aborted 不复现）
    assert!(
        !matches!(outcome.reason, AgentEndReason::Aborted | AgentEndReason::Error),
        "协作停止不是取消也不是错误"
    );
    // 反向：run 终态不触发自动续轮——本 run 内仅 1 次 TurnStart（无续轮）
    let turn_starts = outcome
        .events
        .iter()
        .filter(|e| matches!(e, AgentEvent::TurnStart { .. }))
        .count();
    assert_eq!(turn_starts, 1, "协作停止后不得自动续轮");
}

// ── D2：tool-promise steering 已删除 ──

/// D2 正向：模型回复承诺性语言（「我将」「首先」）但无 tool_call →
/// run 以 stop 收场；provider 仅被调用 1 次（无 STEERING_NEEDED 二次调用）。
///
/// 裁决（01 §四 D2 / 00 §3 D2）：删除 run 内 tool-promise 注入；承诺未兑现
/// = 正常结束，nudge 附到下一条用户消息（D8 通道）。
#[tokio::test]
async fn d2_tool_promise_language_ends_stop_no_nudge_no_diagnostic() {
    let provider = TestProvider::new(vec![
        ProviderStreamEvent::text("我将首先检查文件，然后给出结论。Let me review it."),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]);
    let mut loop_ = loop_with(provider, vec![]);

    let outcome = loop_.run(user("帮我看看")).await;

    // 正向：承诺性语言无 tool_call → 正常 stop 收场（不 error 不 aborted）
    assert_eq!(outcome.reason, AgentEndReason::Stop);
    assert!(outcome.error.is_none());
    // 承诺文本作为最终助手消息保留
    let assistant = outcome
        .messages
        .iter()
        .rev()
        .find(|m| m.role == AgentMessageRole::Assistant)
        .expect("应有助手消息");
    assert!(assistant.text().contains("我将首先检查文件"));
    // 反向：旧行为 regex 承诺检测 → tool-promise nudge + STEERING_NEEDED
    // 二次调用 provider；现在 TurnStart 必须仅 1 次（无二次调用）
    assert_eq!(outcome.tool_call_count, 0);
    let turn_starts = outcome
        .events
        .iter()
        .filter(|e| matches!(e, AgentEvent::TurnStart { .. }))
        .count();
    assert_eq!(turn_starts, 1, "无 tool-promise steering 二次调用");
    // 反向：不注入 nudge（无 system 注入消息、无 nudge 用户消息）
    assert_eq!(injected_steering_count(&outcome.messages), 0);
    assert!(
        !outcome.messages.iter().any(|m| m
            .metadata
            .as_ref()
            .and_then(|meta| meta.get("kind"))
            .and_then(|k| k.as_str())
            .is_some_and(|k| k == "nudge" || k == "tool-promise-nudge")),
        "承诺未兑现不得注入任何 nudge"
    );
    // 反向：不发 runtime-error 自终止诊断（D2 裁决：诊断也不以 runtime-error 发）
    assert!(!has_runtime_error(&outcome.events), "无 runtime-error 诊断");
    assert!(
        !outcome
            .events
            .iter()
            .any(|e| matches!(e, AgentEvent::RuntimeSteering { .. })),
        "无 runtime-steering 事件"
    );
}

// ── D3：预注入短路保留（不重复注入）──

/// D3 正向：input_queue 预置可运行输入（模拟已注入的 nudge，B4.4 跨 run
/// steering 队列排入）时，空响应 steering 评估至多注入一次——预注入内容
/// 作为下一条用户消息消费，不被重复 steering。
///
/// 裁决（01 §四 D3）：保留预注入短路——inputQueue 有可运行 pending 时
/// steering 评估跳过，避免对已注入 nudge 重复注入。
#[tokio::test]
async fn d3_pre_injected_steer_consumed_without_double_steering() {
    // 预置一条 steer 消息（模拟 orchestrator 跨 run 注入的 steering 条目）
    let steer = user("预注入：请使用工具完成任务。");
    let provider = TestProvider::with_scripts(vec![
        // 第 1 次：空响应（触发 STEERING_NEEDED）
        vec![ProviderStreamEvent::stop(StopReason::Stop)],
        // 第 2 次：预注入内容消费后的正常回复
        vec![
            ProviderStreamEvent::text("预注入后正常回答。"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]);
    let mut loop_ = loop_with(provider, vec![]);
    loop_.enqueue_input(steer.clone(), InputEnqueueMode::Steer);
    assert!(
        loop_.input_queue().has_runnable_pending(),
        "预注入消息应可见为 runnable pending（短路判定前提）"
    );

    let outcome = loop_.run(user("开始")).await;

    // 正向：预注入消息作为下一条用户消息落对话（User 角色，文本保留）
    let steer_msg = outcome
        .messages
        .iter()
        .find(|m| m.text() == "预注入：请使用工具完成任务。")
        .expect("预注入消息应被消费进对话");
    assert_eq!(steer_msg.role, AgentMessageRole::User);
    // 正向：空响应 steering 注入至多一次（不重复注入）
    let injected = injected_steering_count(&outcome.messages);
    assert!(injected <= 1, "预注入内容不得被重复 steering");
    // 计数在最终文字回复（无 tool-call 正常结束）时重置（01 §3.3 ③）
    assert_eq!(outcome.steering_count, 0, "正常结束时 steering 计数重置");
    // 反向：旧行为（无短路时对预注入内容叠加 steering）不复现——
    // 对话中不会出现多条 runtime-steering 系统消息
    assert_ne!(injected, 2, "不得叠加第二次 steering 注入");
    // 反向：不以 error 收场
    assert_eq!(outcome.reason, AgentEndReason::Stop);
    assert!(outcome.error.is_none());
}

// ── D4：自终止诊断非 error 语义 ──

/// D4 正向：self-termination 诊断载荷（toolCallCount/turnIndex/maxTurns/
/// promisedToolsWithoutCall）经 provider-diagnostic 事件发出；run 正常
/// stop 收场，不因诊断失败。
///
/// 裁决（01 §四 D4）：自终止观测保留为**诊断事件**（非 error 收场、
/// 不 retryable），字段含 toolCallCount / turnIndex / maxTurns /
/// promisedToolsWithoutCall。
#[tokio::test]
async fn d4_self_termination_diagnostic_does_not_fail_run() {
    // 构造自终止诊断载荷（D2 删除 tool-promise 计数后 promisedToolsWithoutCall=0）
    let diagnostic_payload = SelfTerminationDiagnostic::new(0, 1, 16);
    let serialized = serde_json::to_value(diagnostic_payload).expect("序列化");
    // 载荷序列化字段名 = 01 D4 契约（camelCase）
    assert_eq!(
        serialized,
        serde_json::json!({
            "toolCallCount": 0,
            "turnIndex": 1,
            "maxTurns": 16,
            "promisedToolsWithoutCall": 0,
        })
    );
    // 诊断事件走 provider-diagnostic 通道（payload 挂 reason 字段，仅观测）
    let provider = TestProvider::new(vec![
        ProviderStreamEvent::ProviderDiagnostic {
            diagnostic: ProviderDiagnostic {
                phase: ProviderDiagnosticPhase::StreamEnd,
                reason: Some(format!(
                    "agent-self-terminated:{}",
                    serialized
                )),
                ..ProviderDiagnostic::default()
            },
        },
        ProviderStreamEvent::text("任务完成。"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]);
    let mut loop_ = loop_with(provider, vec![]);

    let outcome = loop_.run(user("执行")).await;

    // 正向：诊断事件照发（provider-diagnostic 广播，非 error 事件）
    let diagnostic_events = outcome
        .events
        .iter()
        .filter(|e| matches!(e, AgentEvent::ProviderDiagnostic { .. }))
        .count();
    assert_eq!(diagnostic_events, 1, "自终止诊断事件应照发");
    let diag = outcome
        .events
        .iter()
        .find_map(|e| match e {
            AgentEvent::ProviderDiagnostic { diagnostic, .. } => Some(diagnostic),
            _ => None,
        })
        .expect("应有 provider-diagnostic 事件");
    assert!(
        diag.reason.as_deref().unwrap_or("").contains("agent-self-terminated"),
        "诊断载荷应含自终止标记"
    );
    // 正向：run 正常 stop 收场（诊断不使 run 失败）
    assert_eq!(outcome.reason, AgentEndReason::Stop);
    assert!(outcome.error.is_none());
    // 反向：旧行为自终止以 runtime-error（retryable:true）事件表达——
    // 现在不产生 runtime-error，也不以 error 收场（D4 非 error 语义）
    assert!(!has_runtime_error(&outcome.events), "自终止诊断不得以 runtime-error 发出");
    // 反向：诊断载荷不含 error/reason 收场字段（纯观测数据）
    let keys: Vec<String> = serialized
        .as_object()
        .expect("对象")
        .keys()
        .cloned()
        .collect();
    assert!(
        !keys.iter().any(|k| k.contains("error") || k.contains("reason")),
        "诊断载荷无收场裁决字段"
    );
}

// ── D5：模型输出与传输错误分离 ──

/// D5 正向：文字 + stopReason=error 事件 → Message 收场（错误降级为
/// metadata.providerError 标注，不以 error 收场）。
///
/// 裁决（01 §四 D6 / 00 §3 D5）：响应含文字/tool-call 即 Completed；
/// 仅「无文字且无 tool-call 且 stopReason=error」走错误路径。
#[tokio::test]
async fn d5_text_with_error_stop_ends_as_message_not_error() {
    let provider = TestProvider::new(vec![
        ProviderStreamEvent::text("部分输出已生成。"),
        ProviderStreamEvent::Stop {
            reason: StopReason::Error,
            error: Some("服务端流异常（已产出部分内容）".into()),
            usage: None,
        },
    ]);
    let mut loop_ = loop_with(provider, vec![]);

    let outcome = loop_.run(user("生成内容")).await;

    // 正向：有文字 → Message → 正常 stop 收场
    assert_eq!(outcome.reason, AgentEndReason::Stop);
    assert!(outcome.error.is_none());
    let assistant = outcome
        .messages
        .iter()
        .find(|m| m.role == AgentMessageRole::Assistant)
        .expect("文字回复应已 commit");
    assert_eq!(assistant.text(), "部分输出已生成。");
    // 正向：错误降级为 metadata.providerError 标注（不否决收场）
    assert_eq!(
        assistant
            .metadata
            .as_ref()
            .and_then(|m| m.get("providerError"))
            .and_then(|s| s.as_str()),
        Some("服务端流异常（已产出部分内容）"),
        "错误应作为标注保留"
    );
    // 反向：旧行为 stopReason=error 一票否决 → error 收场不复现
    assert_eq!(
        assistant
            .metadata
            .as_ref()
            .and_then(|m| m.get("stopReason"))
            .and_then(|s| s.as_str()),
        Some("stop"),
        "stopReason 不应被 error 污染"
    );
    assert!(!has_runtime_error(&outcome.events), "文字+error 路径不发 runtime-error");
}

// ── D6：empty-response 预算内重试、耗尽 stop 收场 ──

/// D6 正向：第 1 次空响应在预算内注入 steering（重试），注入后恢复；
/// run 以 stop 收场。
///
/// 裁决（01 §四 D7 / 00 §3 D6）：空响应 = 模型输出异常而非任务失败，
/// 预算内重试（瞬态分类）。
#[tokio::test]
async fn d6_empty_response_retry_within_budget_then_recover() {
    let provider = TestProvider::with_scripts(vec![
        // 第 1 次：空响应 → 预算内注入
        vec![ProviderStreamEvent::stop(StopReason::Stop)],
        // 第 2 次：注入后恢复
        vec![
            ProviderStreamEvent::text("抱歉，我重新回答了。"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]);
    let mut loop_ = loop_with(provider, vec![]);

    let outcome = loop_.run(user("回答我")).await;

    // 正向：预算内注入发生（1 条 runtime-steering 系统消息）
    assert_eq!(injected_steering_count(&outcome.messages), 1);
    // 计数在「无 tool-call 正常结束」时重置（01 §3.3 ③）
    assert_eq!(outcome.steering_count, 0, "恢复后正常结束时计数重置");
    // 正向：注入后恢复，stop 收场
    assert_eq!(outcome.reason, AgentEndReason::Stop);
    assert!(outcome.error.is_none());
    let final_text = outcome
        .messages
        .iter()
        .rev()
        .find(|m| m.role == AgentMessageRole::Assistant)
        .expect("应有最终助手消息");
    assert_eq!(final_text.text(), "抱歉，我重新回答了。");
    // 反向：第 1 次空响应不以 error / aborted 收场
    assert!(
        !matches!(outcome.reason, AgentEndReason::Error | AgentEndReason::Aborted),
        "预算内空响应重试不得以 error 收场"
    );
}

// ── D7：intervention 事件照发但 run stop ──

/// D7 正向：预算耗尽后 intervention 事件照发（runtime-intervention-required
/// 含 choices），run 以 stop + 诊断收场。
///
/// 裁决（01 §四 D7）：intervention-required 是「需人工介入」信号，
/// 发射事件后**正常收场**（stop），不终结为 error。
#[tokio::test]
async fn d7_intervention_event_emitted_but_run_ends_stop() {
    // 默认 maxSteeringMessages=1：第 1 次注入（计数→1），第 2 次 intervention
    let provider = TestProvider::with_scripts(vec![
        vec![ProviderStreamEvent::stop(StopReason::Stop)],
        vec![ProviderStreamEvent::stop(StopReason::Stop)],
    ]);
    let mut loop_ = loop_with(provider, vec![]);

    let outcome = loop_.run(user("回答我")).await;

    // 正向：intervention 事件照发（choices = rollback/pause/user-instruction）
    let intervention = outcome
        .events
        .iter()
        .find_map(|e| match e {
            AgentEvent::RuntimeInterventionRequired {
                choices, reason, ..
            } => Some((choices.clone(), reason.clone())),
            _ => None,
        })
        .expect("应有 runtime-intervention-required 事件");
    assert_eq!(
        intervention.0,
        vec![
            "rollback".to_string(),
            "pause".to_string(),
            "user-instruction".to_string()
        ]
    );
    assert_eq!(intervention.1, "empty-response");
    // 正向：run 以 stop + 诊断收场
    assert_eq!(outcome.reason, AgentEndReason::Stop);
    assert!(
        outcome.diagnostic.is_some(),
        "intervention 收场应带诊断说明"
    );
    // 反向：旧行为 INTERVENTION_REQUIRED → endReason='error' 不复现
    assert!(outcome.error.is_none(), "intervention 不得以 error 收场");
    assert_ne!(outcome.reason, AgentEndReason::Error);
}

// ── D8：run 内不注入 nudge ──

/// D8 正向：run 内任何位置不注入 nudge——nudge 以用户消息身份排入
/// 下一条用户消息边界（followUp 环，idle promote 后消费）。
///
/// 裁决（01 §四 D8）：run 内一律不注入；nudge 文本排入下一条用户消息。
#[tokio::test]
async fn d8_run_never_injects_nudge_nudge_goes_to_next_user_message() {
    // Part A：普通文字回复 run 内无任何 nudge 注入（对话只含 user + assistant）
    let provider = TestProvider::text_reply("普通回复。");
    let mut loop_ = loop_with(provider, vec![]);
    let outcome = loop_.run(user("你好")).await;
    assert_eq!(outcome.reason, AgentEndReason::Stop);
    for message in &outcome.messages {
        let kind = message
            .metadata
            .as_ref()
            .and_then(|m| m.get("kind"))
            .and_then(|k| k.as_str());
        assert!(
            kind != Some("nudge") && kind != Some("tool-promise-nudge"),
            "run 内不得注入 nudge（消息 role={:?} kind={kind:?}）",
            message.role
        );
    }

    // Part B：nudge 排入下一条用户消息——经 PendingNudgeChannel 生成，
    // 以 followUp 环预置到输入队列；idle 边界 promote 后作为 User 消息消费
    let mut channel = PendingNudgeChannel::new();
    channel.enqueue_reason(SteeringReason::EmptyResponse);
    let nudge = channel.drain_all().into_iter().next().expect("有 nudge");
    let nudge_message = nudge.into_user_message();
    let provider = TestProvider::with_scripts(vec![
        vec![
            ProviderStreamEvent::text("第一轮回复。"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        vec![
            ProviderStreamEvent::text("nudge 消费后的回复。"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]);
    let mut loop_ = loop_with(provider, vec![]);
    loop_.enqueue_input(nudge_message.clone(), InputEnqueueMode::FollowUp);

    let outcome = loop_.run(user("开始")).await;

    assert_eq!(outcome.reason, AgentEndReason::Stop);
    assert!(outcome.error.is_none());
    // 正向：nudge 以下一条用户消息身份出现（User 角色 + kind=nudge 元数据）
    let consumed = outcome
        .messages
        .iter()
        .find(|m| m.id == nudge_message.id)
        .expect("nudge 应被消费进对话");
    assert_eq!(consumed.role, AgentMessageRole::User, "nudge 必须是用户消息");
    assert_eq!(
        consumed
            .metadata
            .as_ref()
            .and_then(|m| m.get("kind"))
            .and_then(|k| k.as_str()),
        Some("nudge")
    );
    // 反向：nudge 不以 system 角色在 run 中途注入（无 system 消息含 nudge 文本）
    assert!(
        !outcome.messages.iter().any(|m| {
            m.role == AgentMessageRole::System && m.text().contains("Runtime steering")
        }),
        "nudge 不得以 system 消息注入当前 run"
    );
    // nudge 位于第一轮回复之后、第二轮回复之前（用户消息边界）
    let texts: Vec<String> = outcome.messages.iter().map(|m| m.text()).collect();
    let idx_nudge = texts
        .iter()
        .position(|t| t.contains("Runtime steering"))
        .expect("nudge 文本应出现");
    let idx_first = texts
        .iter()
        .position(|t| t == "第一轮回复。")
        .expect("第一轮");
    let idx_second = texts
        .iter()
        .position(|t| t == "nudge 消费后的回复。")
        .expect("第二轮");
    assert!(
        idx_first < idx_nudge && idx_nudge < idx_second,
        "nudge 应落在第一轮与第二轮之间的用户消息边界"
    );
}

// ── D9：预算耗尽禁止 inject-message 且 stop 收场 ──

/// D9 正向：预算耗尽后第 2 次空响应不再注入消息（对话中 runtime-steering
/// 系统消息仅 1 条、计数不再增长），run 以 stop + 诊断收场。
///
/// 裁决（01 §四 D9）：steering 有硬上限但不以 error 收场——预算耗尽 →
/// 正常 stop；保留 runtime-intervention-required 事件供 UI 展示。
#[tokio::test]
async fn d9_budget_exhausted_forbids_inject_and_ends_stop() {
    let provider = TestProvider::with_scripts(vec![
        vec![ProviderStreamEvent::stop(StopReason::Stop)],
        vec![ProviderStreamEvent::stop(StopReason::Stop)],
    ]);
    let mut loop_ = loop_with(provider, vec![]);

    let outcome = loop_.run(user("回答我")).await;

    // 正向：耗尽后禁止 inject-message——仅第 1 次空响应注入 1 条
    assert_eq!(injected_steering_count(&outcome.messages), 1);
    assert_eq!(outcome.steering_count, 1);
    // 正向：stop + 诊断收场
    assert_eq!(outcome.reason, AgentEndReason::Stop);
    assert!(outcome.diagnostic.is_some());
    // 反向：第 2 次空响应不得再注入（无第 2 条系统注入消息），
    // 也不以 error 收场（旧行为 STEERING_BUDGET_EXHAUSTED → error 不复现）
    assert_ne!(injected_steering_count(&outcome.messages), 2);
    assert!(outcome.error.is_none());
    assert!(
        !matches!(outcome.reason, AgentEndReason::Error | AgentEndReason::Aborted),
        "预算耗尽不得以 error/aborted 收场"
    );
}

// ── D10：无 ctx.steeringCount 死检查，单一计数源 ──

/// D10 正向：预算由 coordinator 真实计数驱动（唯一增量点在 apply 的
/// inject-message）；run 收场的 steering_count 与对话注入数一致。
///
/// 裁决（01 §四 D10）：单一计数源（coordinator 持有）、单一配置源；
/// 机器上下文 steeringCount 死检查删除。若仍读恒 0 的机器上下文，
/// 第 2 次空响应不会耗尽预算（死检查永不触发）——本测试证明耗尽真实发生。
#[tokio::test]
async fn d10_steering_count_single_source_in_apply_no_dead_check() {
    let provider = TestProvider::with_scripts(vec![
        vec![ProviderStreamEvent::stop(StopReason::Stop)],
        vec![ProviderStreamEvent::stop(StopReason::Stop)],
    ]);
    let mut loop_ = loop_with(provider, vec![]);

    let outcome = loop_.run(user("回答我")).await;

    // 正向：耗尽在第 2 次空响应真实触发（预算检查读到的是 apply 后的真实计数）
    assert_eq!(outcome.steering_count, 1, "计数唯一增量点在 apply（inject-message）");
    assert!(
        outcome.diagnostic.is_some(),
        "第 2 次空响应即耗尽——若为恒 0 死检查则永远不会耗尽"
    );
    // 正向：计数与对话注入数一致（单一计数源，无第二计数轨）
    assert_eq!(
        outcome.steering_count,
        injected_steering_count(&outcome.messages),
        "收场计数必须等于实际注入消息数"
    );
    // 反向：死检查（ctx.steeringCount 恒 0 导致预算永不耗尽）不复现——
    // 耗尽后不继续注入、以 stop 收场
    assert_eq!(injected_steering_count(&outcome.messages), 1);
    assert_eq!(outcome.reason, AgentEndReason::Stop);
    assert!(outcome.error.is_none());
}
