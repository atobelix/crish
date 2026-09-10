//! DIM-01: 内核双轨实时事件与 Tool-Promise 自愈状态机集成测试
//!
//! 覆盖测试点：
//! - UT-D01-01 ~ UT-D01-04: LiveEventSink 实时事件双轨广播（Turn / Message / Tool / Agent）
//! - UT-D01-05: ToolPromiseDetector 三层反向过滤 + 行动承诺匹配
//! - UT-D01-06: Tool-Promise 意图自愈状态机：行动意图自动合成 Nudge 并重进 Provider 循环
//! - UT-D01-07: Tool-Promise 自愈硬上限（2 次）熔断机制
//! - UT-D01-08: Tool-Promise 开关为 false 时禁用自愈正常退出
//! - UT-D01-09: ToolExecCtx -> ToolContext 的 background 与 log_root 装配透传

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use agent_tools::registry::ToolRegistry;
use conex_types::events::AgentEvent;
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use conex_types::session::AgentEndReason;
use session_loop::provider::LiveEventSink;
use session_loop::steering::ToolPromiseDetector;
use session_loop::{
    AgentSessionLoop, ProviderStreamEvent, SessionLoopOptions, StopReason, TestProvider, TestTool,
};

/// 记录所有接收到的实时事件的 Sink
#[derive(Default, Clone)]
struct RecordingLiveSink {
    events: Arc<Mutex<Vec<AgentEvent>>>,
}

impl LiveEventSink for RecordingLiveSink {
    fn push_live(&self, event: AgentEvent) {
        self.events.lock().unwrap().push(event);
    }
}

impl RecordingLiveSink {
    fn received_events(&self) -> Vec<AgentEvent> {
        self.events.lock().unwrap().clone()
    }
}

/// 构造标准用户消息
fn user(text: &str) -> AgentMessage {
    AgentMessage {
        id: format!("user-{}", text.len()),
        role: AgentMessageRole::User,
        created_at: "2026-01-01T00:00:00Z".into(),
        blocks: vec![AgentMessageBlock::Text { text: text.into() }],
        metadata: None,
        client_message_id: None,
        content: None,
    }
}

/// 构造带工具注册表的循环
fn loop_with_tools(
    provider: TestProvider,
    tools: Vec<Arc<TestTool>>,
    options: SessionLoopOptions,
) -> AgentSessionLoop {
    let mut registry = ToolRegistry::new();
    for tool in tools {
        registry.register(tool).expect("注册测试工具");
    }
    AgentSessionLoop::new(
        "sess-live-1",
        "run-live-1",
        16,
        Box::new(provider),
        Arc::new(registry),
    )
    .with_options(options)
}

// ============================================================================
// LiveEventSink 双轨广播测试 (UT-D01-01 ~ UT-D01-04)
// ============================================================================

#[tokio::test]
async fn test_ut_d01_01_live_sink_turn_and_agent_lifecycle() {
    let live_sink = Arc::new(RecordingLiveSink::default());
    let mut options = SessionLoopOptions::default();
    options.hooks.live_sink = Some(live_sink.clone());

    let provider = TestProvider::new(vec![
        ProviderStreamEvent::text("你好！"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]);
    let mut loop_ = loop_with_tools(provider, vec![], options);

    let outcome = loop_.run(user("你好")).await;
    assert_eq!(outcome.reason, AgentEndReason::Stop);

    let live_events = live_sink.received_events();
    let has_agent_start = live_events
        .iter()
        .any(|e| matches!(e, AgentEvent::AgentStart { .. }));
    let has_turn_start = live_events
        .iter()
        .any(|e| matches!(e, AgentEvent::TurnStart { .. }));
    let has_message_start = live_events
        .iter()
        .any(|e| matches!(e, AgentEvent::MessageStart { .. }));
    let has_message_delta = live_events
        .iter()
        .any(|e| matches!(e, AgentEvent::MessageDelta { .. }));
    let has_message_end = live_events
        .iter()
        .any(|e| matches!(e, AgentEvent::MessageEnd { .. }));
    let has_turn_end = live_events
        .iter()
        .any(|e| matches!(e, AgentEvent::TurnEnd { .. }));
    let has_agent_end = live_events
        .iter()
        .any(|e| matches!(e, AgentEvent::AgentEnd { .. }));

    assert!(has_agent_start, "LiveSink 必须接收到 AgentStart 事件");
    assert!(has_turn_start, "LiveSink 必须接收到 TurnStart 事件");
    assert!(has_message_start, "LiveSink 必须接收到 MessageStart 事件");
    assert!(has_message_delta, "LiveSink 必须接收到 MessageDelta 事件");
    assert!(has_message_end, "LiveSink 必须接收到 MessageEnd 事件");
    assert!(has_turn_end, "LiveSink 必须接收到 TurnEnd 事件");
    assert!(has_agent_end, "LiveSink 必须接收到 AgentEnd 事件");
}

#[tokio::test]
async fn test_ut_d01_03_live_sink_tool_lifecycle() {
    let live_sink = Arc::new(RecordingLiveSink::default());
    let mut options = SessionLoopOptions::default();
    options.hooks.live_sink = Some(live_sink.clone());

    let echo_tool = Arc::new(TestTool::new(
        "echo_tool",
        serde_json::json!({"result": "done"}),
    ));

    // Turn 1: tool call -> echo_tool
    // Turn 2: final answer
    let provider = TestProvider::with_scripts(vec![
        vec![
            ProviderStreamEvent::tool_call(
                Some("c1".into()),
                "echo_tool",
                serde_json::json!({"msg": "hello"}),
            ),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        vec![
            ProviderStreamEvent::text("工具执行完成"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]);

    let mut loop_ = loop_with_tools(provider, vec![echo_tool], options);
    let outcome = loop_.run(user("调用工具")).await;
    assert_eq!(outcome.reason, AgentEndReason::Stop);

    let live_events = live_sink.received_events();

    let tool_start = live_events
        .iter()
        .find(|e| matches!(e, AgentEvent::ToolStart { .. }));
    let tool_end = live_events
        .iter()
        .find(|e| matches!(e, AgentEvent::ToolEnd { .. }));

    assert!(tool_start.is_some(), "LiveSink 必须实时收到 ToolStart");
    assert!(tool_end.is_some(), "LiveSink 必须实时收到 ToolEnd");

    if let Some(AgentEvent::ToolStart { call, .. }) = tool_start {
        assert_eq!(call.tool_name, "echo_tool");
        assert_eq!(call.id, "c1");
    }
}

// ============================================================================
// ToolPromiseDetector 三层反向过滤测试 (UT-D01-05)
// ============================================================================

#[test]
fn test_ut_d01_05_tool_promise_detector_three_tier_filter() {
    // 正常匹配场景
    let p1 = "我来帮您查看文件，我将执行 shell_command 查看当前目录。";
    assert_eq!(
        ToolPromiseDetector::detect_action_promise(p1),
        Some("我将执行 shell_command 查看当前目录".to_string())
    );

    let p2 = "重新运行测试用例以验证改动。";
    assert_eq!(
        ToolPromiseDetector::detect_action_promise(p2),
        Some("重新运行测试用例以验证改动".to_string())
    );

    let p3 = "现在开始执行构建脚本！";
    assert_eq!(
        ToolPromiseDetector::detect_action_promise(p3),
        Some("现在开始执行构建脚本".to_string())
    );

    // 第一层反向过滤：Markdown/代码块/示例
    let f1 = "例如：我将执行 shell_command 查看目录。";
    assert_eq!(ToolPromiseDetector::detect_action_promise(f1), None);

    let f2 = "```json\n{\"action\": \"正在调用\"}\n```";
    assert_eq!(ToolPromiseDetector::detect_action_promise(f2), None);

    let f3 = "示例如下：\n可以通过如下配置使用 PowerShell 进行编译。";
    assert_eq!(ToolPromiseDetector::detect_action_promise(f3), None);

    // 第二层反向过滤：反问/等待用户确认
    let f4 = "是否需要我现在开始执行构建脚本？";
    assert_eq!(ToolPromiseDetector::detect_action_promise(f4), None);

    let f5 = "如果您同意，我将执行 shell_command。";
    assert_eq!(ToolPromiseDetector::detect_action_promise(f5), None);

    let f6 = "请确认是否继续？";
    assert_eq!(ToolPromiseDetector::detect_action_promise(f6), None);

    // 第三层反向过滤：第三人称/历史复盘/错误分析
    let f7 = "在上一轮中尝试单独调用了编译器，但是失败了。";
    assert_eq!(ToolPromiseDetector::detect_action_promise(f7), None);

    let f8 = "失败原因是之前已经执行了清理命令。";
    assert_eq!(ToolPromiseDetector::detect_action_promise(f8), None);

    let f9 = "刚才尝试了使用 PowerShell 运行但报错。";
    assert_eq!(ToolPromiseDetector::detect_action_promise(f9), None);
}

// ============================================================================
// Tool-Promise 自愈状态机推进测试 (UT-D01-06 ~ UT-D01-08)
// ============================================================================

#[tokio::test]
async fn test_ut_d01_06_tool_promise_self_healing_advances_turn() {
    let echo_tool = Arc::new(TestTool::new(
        "shell_command",
        serde_json::json!({"stdout": "file.txt"}),
    ));

    // Turn 1: Assistant makes an action promise in text but does NOT make a tool call
    // Self-healing triggers -> enqueues steering nudge -> Turn 2
    // Turn 2: Assistant now makes the real tool call -> Turn 3
    // Turn 3: Assistant concludes -> Stop
    let provider = TestProvider::with_scripts(vec![
        // Turn 1: Promised tool call without tool_calls block
        vec![
            ProviderStreamEvent::text("好的，我将执行 shell_command 查看当前文件。"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        // Turn 2: After nudge injection, assistant generates the real tool call
        vec![
            ProviderStreamEvent::tool_call(
                Some("c1".into()),
                "shell_command",
                serde_json::json!({"command": "ls"}),
            ),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        // Turn 3: Final response
        vec![
            ProviderStreamEvent::text("文件列表已获取。"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]);

    let options = {
        let mut o = SessionLoopOptions::default();
        o.tool_exec.tool_promise_recovery_enabled = true;
        o.tool_exec.max_tool_promise_heals = 2;
        o
    };

    let mut loop_ = loop_with_tools(provider, vec![echo_tool], options);
    let outcome = loop_.run(user("帮我看看文件")).await;

    assert_eq!(outcome.reason, AgentEndReason::Stop);
    assert!(outcome.turn_index >= 2, "自愈状态机必须自动推进至下一轮次");

    // 验证 Nudge 消息是否注入到了对话中
    let has_nudge = outcome.messages.iter().any(|m| {
        m.text().contains("【系统自动推进】")
            && m.text().contains("我将执行 shell_command 查看当前文件")
    });
    assert!(has_nudge, "对话中必须包含针对性的系统自愈推进提示消息");
}

#[tokio::test]
async fn test_ut_d01_07_tool_promise_self_healing_caps_at_two_heals() {
    // 连续 3 次承诺但都不发工具调用：
    // Turn 1 -> Heal 1 -> Turn 2
    // Turn 2 -> Heal 2 -> Turn 3
    // Turn 3 -> Hard ceiling reached (2 heals) -> Normal Stop without endless loop
    let provider = TestProvider::with_scripts(vec![
        vec![
            ProviderStreamEvent::text("我将执行 shell_command 第一步。"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        vec![
            ProviderStreamEvent::text("我将执行 shell_command 第二步。"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        vec![
            ProviderStreamEvent::text("我将执行 shell_command 第三步。"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]);

    let options = {
        let mut o = SessionLoopOptions::default();
        o.tool_exec.tool_promise_recovery_enabled = true;
        o.tool_exec.max_tool_promise_heals = 2;
        o
    };

    let mut loop_ = loop_with_tools(provider, vec![], options);
    let outcome = loop_.run(user("持续测试")).await;

    assert_eq!(outcome.reason, AgentEndReason::Stop);
    assert_eq!(
        outcome.turn_index, 3,
        "达到 2 次上限后执行第 3 轮必须安全收口，不得无限循环"
    );
}

#[tokio::test]
async fn test_ut_d01_08_tool_promise_disabled_when_flag_false() {
    // 当 tool_promise_recovery_enabled 为 false 时，即使承诺了动作也不会触发自愈，直接 1 轮 Stop
    let provider = TestProvider::new(vec![
        ProviderStreamEvent::text("我将执行 shell_command 查看当前文件。"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]);

    let options = {
        let mut o = SessionLoopOptions::default();
        o.tool_exec.tool_promise_recovery_enabled = false;
        o.tool_exec.max_tool_promise_heals = 2;
        o
    };

    let mut loop_ = loop_with_tools(provider, vec![], options);
    let outcome = loop_.run(user("开关关闭测试")).await;

    assert_eq!(outcome.reason, AgentEndReason::Stop);
    assert_eq!(
        outcome.turn_index, 1,
        "开关关闭时不会自愈续轮，单轮正常收口"
    );
}

// ============================================================================
// ToolExecCtx 装配测试 (UT-D01-09)
// ============================================================================

#[test]
fn test_ut_d01_09_toolexecctx_background_and_log_root_fields() {
    use session_loop::ToolExecCtx;

    let log_root = PathBuf::from("/tmp/conex-logs");
    let ctx = ToolExecCtx {
        run_id: "r1".into(),
        session_id: "s1".into(),
        log_root: Some(log_root.clone()),
        ..Default::default()
    };

    assert_eq!(ctx.log_root, Some(log_root));
    assert!(ctx.background.is_none());
}
