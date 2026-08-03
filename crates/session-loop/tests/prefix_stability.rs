//! P1 前缀稳定性集成测试（E2，对齐 codex prompt_caching.rs 断言模式）
//!
//! 覆盖（P1 §3.6 E2 测试表三项）：
//! - `two_turn_tool_loop_keeps_request_prefix_byte_stable`：同一 run 内
//!   工具循环两轮请求，tools 数组序列化字节一致（快照锁定）+ 消息前缀
//!   复用（仅尾部追加）；
//! - `system_prompt_stable_across_runs_same_settings`：同配置跨 run，
//!   system 段字节一致（with_initial_conversation_arc 续接模拟跨 run）；
//! - `conversation_is_append_only_within_run`：工具循环 run 后收口对话
//!   与请求快照逐条同一 Arc（无重排 / 无改写 / 无删除，append-only 不变量）。
//!
//! session-loop 不依赖 agent-provider（provider.rs:1-22 契约注释），tools
//! 字节断言在 loop 层用 `serde_json::to_string` 直接序列化 ToolSchema 的
//! 确定形态比较（serde_json Map 为 BTreeMap，同进程两次构建字节确定）；
//! wire 级字节断言下沉 agent-provider 单测（P1 步骤 4.2 口径）。

use std::sync::{Arc, Mutex};

use agent_tools::registry::ToolRegistry;
use async_trait::async_trait;
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use conex_types::response::ClassifiedStreamError;
use conex_types::session::AgentEndReason;
use session_loop::{
    AgentSessionLoop, ProviderCall, ProviderEventStream, ProviderRequest, ProviderStreamEvent,
    SessionLoopOptions, StopReason, TestProvider, TestTool, ToolSchema,
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

/// Arc 包装替身：共享 TestProvider 的请求记录——run 结束后仍可查询
/// `requests()`（requests 记录在 TestProvider 内部，Arc 共享跨 run 存活）
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
/// 查询请求快照，断言 tools / messages 字节与身份）
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
}

/// 记录每次请求的 system_prompt（[RequestSnapshot] 未捕获该字段——P1 断言
/// 助手在测试文件内补齐；委托内层 [TestProvider] 继续走脚本与请求记录）
struct SystemPromptCapturingProvider {
    inner: Arc<TestProvider>,
    prompts: Arc<Mutex<Vec<Option<String>>>>,
}

#[async_trait]
impl ProviderCall for SystemPromptCapturingProvider {
    async fn stream<'a>(
        &self,
        request: &ProviderRequest<'a>,
    ) -> Result<ProviderEventStream, ClassifiedStreamError> {
        self.prompts
            .lock()
            .unwrap()
            .push(request.system_prompt.map(str::to_string));
        self.inner.stream(request).await
    }
}

/// tools 字节形态（P1 断言助手）：[ToolSchema] 无 Serialize 派生（provider.rs
/// 契约面冻结），按三字段确定形态构建 Value 后序列化——同进程两次构建
/// 字节确定（serde_json Map 为 BTreeMap，无 preserve_order 双态）
fn tools_bytes(tools: &[ToolSchema]) -> String {
    let value: Vec<serde_json::Value> = tools
        .iter()
        .map(|t| {
            serde_json::json!({
                "name": t.name.clone(),
                "description": t.description.clone(),
                "input_schema": t.input_schema.clone(),
            })
        })
        .collect();
    serde_json::to_string(&value).expect("工具快照序列化")
}

/// E2-1：同一 run 内工具循环两轮请求，tools 数组字节一致（快照锁定）。
///
/// 断言（对齐 codex `prompt_tools_are_consistent_across_requests`）：
/// - `requests()[0].tools` 与 `requests()[1].tools` 序列化字节一致；
/// - 快照内容 == 注册表 `list_definitions` 按名排序导出（确定性真源）；
/// - 第二轮请求消息前缀复用第一轮（同一 Arc，无改写），仅尾部追加。
#[tokio::test]
async fn two_turn_tool_loop_keeps_request_prefix_byte_stable() {
    let provider = Arc::new(TestProvider::with_scripts(vec![
        // 第 1 次调用：工具调用（echo）
        vec![
            ProviderStreamEvent::tool_call(
                Some("call_echo".into()),
                "echo",
                serde_json::json!({"v": 1}),
            ),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        // 第 2 次调用：最终文字回复
        vec![
            ProviderStreamEvent::text("查询完成"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]));
    let tool = Arc::new(TestTool::new("echo", serde_json::json!({"ok": true})));
    let mut loop_ = loop_with_arc(provider.clone(), vec![tool.clone()]);

    let outcome = loop_.run(user("请查询")).await;

    assert_eq!(outcome.reason, AgentEndReason::Stop);
    let requests = provider.requests();
    assert_eq!(requests.len(), 2, "工具循环两轮各一次请求");

    // tools 字节一致：两轮请求的 tools 数组序列化逐字节相等（快照锁定——
    // 修复前每轮从注册表重建，注册序漂移会打爆缓存前缀）
    let tools0 = tools_bytes(&requests[0].tools);
    let tools1 = tools_bytes(&requests[1].tools);
    assert_eq!(tools0, tools1, "两轮请求 tools 数组序列化字节必须一致");
    assert_eq!(requests[0].tools, requests[1].tools, "两轮请求 tools 内容一致");

    // 快照必须等于注册表 list_definitions 的按名排序导出（确定性真源）
    let mut registry = ToolRegistry::new();
    registry.register(tool).expect("注册测试工具");
    let expected: Vec<ToolSchema> = registry
        .list_definitions()
        .iter()
        .map(ToolSchema::from_definition)
        .collect();
    assert_eq!(
        requests[0].tools, expected,
        "快照与 list_definitions 按名排序导出一致"
    );

    // 消息前缀复用：第二轮请求首条消息与第一轮同一 Arc（前缀字节不变，
    // 对齐 codex `prefixes_context_and_instructions_once_and_consistently`）
    assert!(
        Arc::ptr_eq(&requests[0].messages[0], &requests[1].messages[0]),
        "第二轮请求首条消息必须与第一轮为同一 Arc（无改写）"
    );
    // messages[1..] 为追加段（assistant 工具调用 + 工具结果）
    assert_eq!(requests[0].messages.len(), 1, "第一轮对话仅用户消息");
    assert_eq!(requests[1].messages.len(), 3, "第二轮 = 用户 + 工具调用 + 工具结果");
}

/// E2-2：同配置跨 run，system 段字节一致。
///
/// 同一 [SessionLoopOptions]（system_prompt 相同）两次 run，用收口对话
/// `with_initial_conversation_arc` 续接模拟跨 run：两次请求的
/// `system_prompt` 逐字节一致；第二轮请求完整携带第一轮对话（同一 Arc，
/// 前缀复用）。
#[tokio::test]
async fn system_prompt_stable_across_runs_same_settings() {
    const SYSTEM_PROMPT: &str = "你是 crish 助手，请保持回答简洁。";
    let inner = Arc::new(TestProvider::with_scripts(vec![
        vec![
            ProviderStreamEvent::text("第一轮回复"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        vec![
            ProviderStreamEvent::text("第二轮回复"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]));
    let prompts = Arc::new(Mutex::new(Vec::new()));
    let provider = SystemPromptCapturingProvider {
        inner: inner.clone(),
        prompts: prompts.clone(),
    };
    let mut loop_ = AgentSessionLoop::new(
        "sess-1",
        "run-1",
        16,
        Box::new(provider),
        Arc::new(ToolRegistry::new()),
    )
    .with_options(SessionLoopOptions {
        system_prompt: Some(SYSTEM_PROMPT.to_string()),
        ..Default::default()
    });

    // 第一轮 run（请求 0：构建时对话仅含用户消息——助手回复在请求后 commit）
    let outcome1 = loop_.run(user("第一轮问题")).await;
    assert_eq!(outcome1.reason, AgentEndReason::Stop);
    // 保留第一轮收口对话的 Arc 身份（续接前克隆——Arc 克隆只增引用计数）
    let first_run_msgs = outcome1.messages.clone();

    // 用收口对话续接下一轮（模拟跨 run：同一配置、同一注册表；快照跨
    // run 仍有效——注册表未变，语义正确，P1 §3.2 A2）
    loop_ = loop_.with_initial_conversation_arc(outcome1.messages);
    // 第二轮 run（请求 1）
    let outcome2 = loop_.run(user("第二轮问题")).await;
    assert_eq!(outcome2.reason, AgentEndReason::Stop);

    let requests = inner.requests();
    assert_eq!(requests.len(), 2, "两轮 run 各一次请求");

    // system 段字节一致：两次请求的 system_prompt 完全相同（同 settings）
    let captured = prompts.lock().unwrap().clone();
    assert_eq!(captured.len(), 2, "每轮请求都必须携带 system_prompt");
    assert!(
        captured.iter().all(|p| p.as_deref() == Some(SYSTEM_PROMPT)),
        "system_prompt 必须逐字节一致：{captured:?}"
    );

    // 前缀复用：第二轮请求完整携带第一轮对话（同一 Arc，无改写）
    assert_eq!(requests[0].messages.len(), 1, "第一轮请求 = 仅用户消息（回复在请求后 commit）");
    assert_eq!(requests[1].messages.len(), 3, "第二轮 = 第一轮 2 条 + 新用户消息");
    assert!(
        Arc::ptr_eq(&requests[0].messages[0], &requests[1].messages[0]),
        "两轮请求首条用户消息为同一 Arc（无改写）"
    );
    for i in 0..first_run_msgs.len() {
        assert!(
            Arc::ptr_eq(&first_run_msgs[i], &requests[1].messages[i]),
            "第二轮请求第 {i} 条必须与第一轮收口对话为同一 Arc（无改写）"
        );
    }
    assert_eq!(
        requests[1].messages[2].text(),
        "第二轮问题",
        "尾部追加段 = 第二轮用户消息"
    );
}

/// E2-3：工具循环 run 后，对话 append-only 不变量成立。
///
/// 断言：收口对话（[RunOutcome::messages]）前段与最后一次请求快照逐条
/// **同一 Arc**（顺序一致、无重排 / 无改写 / 无删除），末条为请求后提交
/// 的最终助手消息（尾部追加）；中间轮请求是最终对话的前缀（同一 Arc）。
#[tokio::test]
async fn conversation_is_append_only_within_run() {
    let provider = Arc::new(TestProvider::with_scripts(vec![
        // 第 1 次调用：工具调用
        vec![
            ProviderStreamEvent::tool_call(
                Some("call_echo".into()),
                "echo",
                serde_json::json!({"v": 2}),
            ),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        // 第 2 次调用：最终文字回复
        vec![
            ProviderStreamEvent::text("收尾"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]));
    let tool = Arc::new(TestTool::new("echo", serde_json::json!({"ok": true})));
    let mut loop_ = loop_with_arc(provider.clone(), vec![tool]);

    let outcome = loop_.run(user("干吧")).await;

    assert_eq!(outcome.reason, AgentEndReason::Stop);
    let requests = provider.requests();
    assert_eq!(requests.len(), 2, "工具循环两轮各一次请求");

    // 第 2 次请求对话 = 第 1 次请求对话（前缀同一 Arc，无改写）+ 追加段
    assert!(
        requests[1].messages.len() > requests[0].messages.len(),
        "第二轮对话必须比第一轮更长（append-only，尾部追加）"
    );
    for (i, prev) in requests[0].messages.iter().enumerate() {
        assert!(
            Arc::ptr_eq(prev, &requests[1].messages[i]),
            "第 {i} 条消息必须与上一轮请求为同一 Arc（无改写 / 无重排 / 无删除）"
        );
    }

    // 收口对话 = 最后一次请求快照（同一 Arc，无改写）+ 请求后提交的最终
    // 助手消息（append-only 尾部追加段）
    assert_eq!(
        outcome.messages.len(),
        requests[1].messages.len() + 1,
        "收口对话 = 最后一次请求对话 + 最终助手消息"
    );
    for (i, msg) in requests[1].messages.iter().enumerate() {
        assert!(
            Arc::ptr_eq(msg, &outcome.messages[i]),
            "收口对话第 {i} 条必须与最后一次请求为同一 Arc（append-only 不变量）"
        );
    }
    // 角色序列钉死（user → assistant(工具调用) → tool 结果 → assistant 收尾）
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
}
