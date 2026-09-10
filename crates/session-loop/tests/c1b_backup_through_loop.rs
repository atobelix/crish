//! C1b（统一输入流收敛 · 反向依赖移出）顶层验收测试
//!
//! 详案 `plans/详案-C1-核心循环瘦身.md` §5.3 的安全红线验收：
//! 1. `.crish-trash` 写前备份真跑验证——经 AgentSessionLoop 全链路
//!    （options.tool_exec.tool_middleware 壳层同构造注入 → with_options 同步 →
//!    工具执行器 → 真实内置 write_file 工具）断言写前快照落盘工作区
//!    `.crish-trash`；
//! 2. steering 真跑验证——真实空响应一次，壳层同构造
//!    （RecoverySteeringStrategy::default() + 默认预算）经 with_steering
//!    注入后，断言 runtime-steering 纠偏仍生效。
//!
//! 壳层装配等价链：run_launch.rs:605（BackupMiddleware 唯一产品注入点）
//! → SessionLoopProducer → produce → with_options；engine_build.rs
//! produce（with_steering 唯一产品注入点）。本测试以与壳层完全相同的
//! 构造注入，验证 C1b 移出核心默认后两条注入面完整承担原职责
//! （逆问：若注入被误删，本测试即红——安全红线回归锚点）。

use std::sync::Arc;

use agent_tools::backup::BackupMiddleware;
use agent_tools::register_builtin_tools;
use agent_tools::registry::ToolRegistry;
use conex_fs::trash::{EntryMode, TrashService};
use conex_test_utils::TempWorkspace;
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use conex_types::session::AgentEndReason;
use session_loop::{
    AgentSessionLoop, ProviderStreamEvent, RecoverySteeringStrategy, SessionLoopOptions,
    SteeringCoordinator, SteeringCoordinatorOptions, StopReason, TestProvider,
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

/// 顶层验收 1（详案 §5.3-1）：真实 run 一次带写文件的工具调用
/// （write_file），断言写前快照落盘工作区 `.crish-trash`
/// （BackupMiddleware::with_defaults(None) 执行期回退工作区
/// `.crish-trash`——与壳层 run_launch.rs:605 同构造）。
#[tokio::test]
async fn write_file_through_loop_lands_crish_trash_snapshot() {
    let ws = TempWorkspace::new("c1b_backup_loop");
    // 壳层等价 options：tool_middleware = [BackupMiddleware::with_defaults(None)]
    //（run_launch.rs:605 同构造）+ cwd = 工作区根（中间件快照回退基准）
    let options = SessionLoopOptions::default()
        .with_tool_middleware(vec![Arc::new(BackupMiddleware::with_defaults(None))]);
    let options = {
        let mut o = options;
        o.tool_exec.cwd = Some(ws.path_str());
        o
    };

    let mut registry = ToolRegistry::new();
    register_builtin_tools(&mut registry).expect("内置工具注册失败");

    // P1 权限归一（A3 fail-closed 契约）：无审批基础设施的循环不再透传执行
    // 危险工具（write_file 属 dangerous）——本验收聚焦写前备份注入面而非
    // 权限，故显式声明 full-access 权限模式（放行 write_file，备份语义不变）
    let tool_options = session_loop::tool_events::ToolBatchOptions {
        permission_mode: Some(session_loop::PermissionMode::FullAccess),
        ..Default::default()
    };

    // 第 1 轮：调用 write_file 写 doc.txt；第 2 轮：文字收尾
    let provider = TestProvider::with_scripts(vec![
        vec![
            ProviderStreamEvent::tool_call(
                Some("call_wf".into()),
                "write_file",
                serde_json::json!({"path": "doc.txt", "content": "v1\n"}),
            ),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        vec![
            ProviderStreamEvent::text("写入完成"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]);

    let mut loop_ = AgentSessionLoop::new(
        "sess-c1b",
        "run-c1b",
        16,
        Box::new(provider),
        Arc::new(registry),
    )
    .with_options(options)
    .with_tool_options(tool_options);

    let outcome = loop_.run(user("写文件")).await;

    assert_eq!(outcome.reason, AgentEndReason::Stop);
    assert!(outcome.error.is_none());
    // 文件已写入
    assert_eq!(ws.read_file("doc.txt"), "v1\n");
    // 写前快照落盘 .crish-trash（安全红线：C1b 移出默认后注入面完整承担）
    let svc = TrashService::new(ws.path().join(".crish-trash"));
    let entries = svc.list();
    assert_eq!(entries.len(), 1, "write_file 写前必须登记一份快照");
    assert_eq!(entries[0].mode, EntryMode::Snapshot, "写前备份为快照模式");
}

/// 顶层验收 2（详案 §5.3-2）：真实空响应一次 → steering 仍在
/// （壳层同构造注入 RecoverySteeringStrategy + 默认预算；steering_enabled
/// 默认 true）——断言 runtime-steering 注入发生（策略 Vec 非空纠偏生效）。
#[tokio::test]
async fn empty_response_still_steered_with_shell_injection() {
    // 空响应脚本：第 1 次调用空（无文字无工具）→ steering 注入 → 第 2 次恢复
    let provider = TestProvider::with_scripts(vec![
        vec![ProviderStreamEvent::stop(StopReason::Stop)],
        vec![
            ProviderStreamEvent::text("已恢复"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]);
    let mut loop_ = AgentSessionLoop::new(
        "sess-c1b",
        "run-c1b",
        16,
        Box::new(provider),
        Arc::new(ToolRegistry::new()),
    )
    .with_options(SessionLoopOptions::default())
    .with_steering(SteeringCoordinator::new(
        vec![Box::new(RecoverySteeringStrategy::default())],
        SteeringCoordinatorOptions::default(),
    ));

    let outcome = loop_.run(user("空响应")).await;

    assert_eq!(outcome.reason, AgentEndReason::Stop);
    assert!(outcome.error.is_none());
    // steering 注入发生（empty-response → runtime-steering）
    assert!(
        outcome
            .events
            .iter()
            .any(|e| matches!(e, conex_types::events::AgentEvent::RuntimeSteering { .. })),
        "空响应必须触发 runtime-steering（壳层注入 steering 生效）"
    );
}
