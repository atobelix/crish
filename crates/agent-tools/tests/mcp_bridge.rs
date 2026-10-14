//! MCP 桥集成测试（任务书 B5.4：假 MCP server 子进程往返 + 崩溃检测）
//!
//! 假 server 为同 crate 测试夹具二进制 `mcp-fake-server`
//! （tests/fixtures/mcp_fake_server.rs），经 CARGO_BIN_EXE_* 环境变量
//! 定位可执行文件路径。Windows 上 tokio 子进程管道与 kill（TerminateProcess）
//! 均可靠，无需 cfg 条件裁剪；若个别用例在 CI 偶发超时，可单独重跑。

use agent_tools::context::{create_mock_tool_context, ToolContext};
use agent_tools::mcp::{mcp_tool_name, McpClientBridge, McpServerConfig, McpServerRuntimeState};
use serde_json::json;
use std::collections::HashMap;
use std::time::Duration;

/// 假 server 可执行文件路径（cargo 为集成测试注入，连字符原样保留）
const FAKE_SERVER: &str = env!("CARGO_BIN_EXE_mcp-fake-server");

/// 测试用会话上下文（MCP 适配器不读 workspace_root，用默认 mock 即可）
fn tool_ctx() -> ToolContext {
    create_mock_tool_context()
}

fn fake_server_config(extra_env: &[(&str, &str)]) -> McpServerConfig {
    let mut env = HashMap::new();
    for (key, value) in extra_env {
        env.insert((*key).to_string(), (*value).to_string());
    }
    McpServerConfig::new("fake", FAKE_SERVER).with_env(env)
}

/// 轮询等待条件成立（崩溃检测等异步事件用）
async fn wait_until(mut pred: impl FnMut() -> bool, timeout: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if pred() {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[tokio::test]
async fn start_handshake_and_list_tools() {
    let bridge = McpClientBridge::new();
    let config = fake_server_config(&[]);
    let defs = bridge.start(&config).await.unwrap();
    let names: Vec<String> = defs.iter().map(|d| d.name.clone()).collect();
    assert_eq!(
        names,
        [
            mcp_tool_name("fake", "echo"),
            mcp_tool_name("fake", "add"),
            mcp_tool_name("fake", "boom"),
            mcp_tool_name("fake", "env"),
        ]
    );
    assert_eq!(bridge.state("fake"), McpServerRuntimeState::Ready);
    assert!(bridge.is_running("fake"));
    // 定义可序列化（注册表载荷形状）
    let value = serde_json::to_value(&defs[0]).unwrap();
    assert_eq!(value["name"], mcp_tool_name("fake", "echo"));
    assert_eq!(value["description"], "回显入参");
    bridge.stop("fake").await.unwrap();
}

#[tokio::test]
async fn start_is_idempotent_when_ready() {
    let bridge = McpClientBridge::new();
    let config = fake_server_config(&[]);
    let first = bridge.start(&config).await.unwrap();
    let second = bridge.start(&config).await.unwrap();
    assert_eq!(first, second);
    // 仍可正常调用（同一会话）
    let adapter = bridge.get_adapter("fake", &mcp_tool_name("fake", "echo")).unwrap();
    let out = adapter
        .execute(&tool_ctx(), json!({ "msg": "重复" }))
        .await
        .unwrap();
    assert!(out["text"].as_str().unwrap().contains("重复"));
    bridge.stop("fake").await.unwrap();
}

#[tokio::test]
async fn execute_echo_and_add_roundtrip() {
    let bridge = McpClientBridge::new();
    bridge.start(&fake_server_config(&[])).await.unwrap();

    // echo：text 段拼接
    let echo = bridge.get_adapter("fake", &mcp_tool_name("fake", "echo")).unwrap();
    let out = echo
        .execute(&tool_ctx(), json!({ "msg": "你好，MCP" }))
        .await
        .unwrap();
    assert!(out["text"].as_str().unwrap().contains("你好，MCP"));

    // add：structuredContent 进 json 字段，text 兜底
    let add = bridge.get_adapter("fake", &mcp_tool_name("fake", "add")).unwrap();
    let out = add
        .execute(&tool_ctx(), json!({ "a": 1, "b": 2 }))
        .await
        .unwrap();
    assert_eq!(out["json"]["sum"].as_f64(), Some(3.0));
    assert_eq!(out["text"], "3");

    // Tool trait 元信息
    assert_eq!(add.name(), mcp_tool_name("fake", "add"));
    assert_eq!(add.definition().name, mcp_tool_name("fake", "add"));
    bridge.stop("fake").await.unwrap();
}

#[tokio::test]
async fn execute_boom_returns_execution_failed() {
    let bridge = McpClientBridge::new();
    bridge.start(&fake_server_config(&[])).await.unwrap();
    let boom = bridge.get_adapter("fake", &mcp_tool_name("fake", "boom")).unwrap();
    let err = boom.execute(&tool_ctx(), json!({})).await.unwrap_err();
    assert_eq!(err.code(), "tool.execution_failed");
    assert!(err.to_string().contains("boom 失败"));
    bridge.stop("fake").await.unwrap();
}

#[tokio::test]
async fn env_vars_are_passed_to_child() {
    let bridge = McpClientBridge::new();
    bridge
        .start(&fake_server_config(&[("FAKE_MCP_ENV_VALUE", "hello-env")]))
        .await
        .unwrap();
    let env_tool = bridge.get_adapter("fake", &mcp_tool_name("fake", "env")).unwrap();
    let out = env_tool.execute(&tool_ctx(), json!({})).await.unwrap();
    assert_eq!(out["text"], "hello-env");
    bridge.stop("fake").await.unwrap();
}

#[tokio::test]
async fn spawn_failure_returns_connection_error() {
    let bridge = McpClientBridge::new();
    let config = McpServerConfig::new("missing", "definitely-not-a-real-command-xyz");
    let err = bridge.start(&config).await.unwrap_err();
    assert_eq!(err.code(), "mcp.connection_failed");
    assert!(err.to_string().contains("启动 MCP server"));
    // 失败后无残留会话
    assert_eq!(bridge.state("missing"), McpServerRuntimeState::Stopped);
}

#[tokio::test]
async fn stop_then_restart_works() {
    let bridge = McpClientBridge::new();
    let config = fake_server_config(&[]);
    bridge.start(&config).await.unwrap();

    bridge.stop("fake").await.unwrap();
    assert_eq!(bridge.state("fake"), McpServerRuntimeState::Stopped);
    assert!(!bridge.is_running("fake"));
    assert!(bridge.tools("fake").is_none());

    // 重启：全新会话可正常往返
    let defs = bridge.start(&config).await.unwrap();
    assert!(!defs.is_empty());
    let echo = bridge.get_adapter("fake", &mcp_tool_name("fake", "echo")).unwrap();
    let out = echo
        .execute(&tool_ctx(), json!({ "msg": "重启后" }))
        .await
        .unwrap();
    assert!(out["text"].as_str().unwrap().contains("重启后"));
    bridge.stop("fake").await.unwrap();
}

#[tokio::test]
async fn stop_unknown_server_returns_not_found() {
    let bridge = McpClientBridge::new();
    let err = bridge.stop("nope").await.unwrap_err();
    assert_eq!(err.code(), "mcp.server_not_found");
}

#[tokio::test]
async fn crash_detection_marks_exited_and_fails_calls() {
    let bridge = McpClientBridge::new();
    let config = fake_server_config(&[("FAKE_MCP_CRASH_AFTER_MS", "300")]);
    bridge.start(&config).await.unwrap();
    assert_eq!(bridge.state("fake"), McpServerRuntimeState::Ready);

    // 假 server 崩溃：状态应被检测为 Exited
    let exited = wait_until(
        || bridge.state("fake") == McpServerRuntimeState::Exited,
        Duration::from_secs(5),
    )
    .await;
    assert!(
        exited,
        "崩溃后状态应为 Exited，实际 {:?}",
        bridge.state("fake")
    );
    assert!(!bridge.is_running("fake"));

    // 崩溃后的调用报 connection_failed 且带退出原因
    let echo = bridge.get_adapter("fake", &mcp_tool_name("fake", "echo")).unwrap();
    let err = echo
        .execute(&tool_ctx(), json!({ "msg": "x" }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "mcp.connection_failed");
    assert!(err.to_string().contains("不可用"));

    // 已退出会话可幂等 stop 清理
    bridge.stop("fake").await.unwrap();
}

#[tokio::test]
async fn call_timeout_applies() {
    // 300ms 调用超时 + 假 server 故意慢 1500ms → runtime.timeout
    let bridge = McpClientBridge::new().with_call_timeout(Duration::from_millis(300));
    let config = fake_server_config(&[("FAKE_MCP_SLOW_MS", "1500")]);
    bridge.start(&config).await.unwrap();
    let echo = bridge.get_adapter("fake", &mcp_tool_name("fake", "echo")).unwrap();
    let err = echo
        .execute(&tool_ctx(), json!({ "msg": "慢" }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "runtime.timeout");
    assert!(err.to_string().contains("tools/call"));
    bridge.stop("fake").await.unwrap();
}

#[tokio::test]
async fn stop_all_cleans_up_everything() {
    let bridge = McpClientBridge::new();
    let config = fake_server_config(&[]);
    let mut other = config.clone();
    other.server_id = "fake2".to_string();
    bridge.start(&config).await.unwrap();
    bridge.start(&other).await.unwrap();
    assert_eq!(bridge.managed_servers(), ["fake", "fake2"]);
    let stopped = bridge.stop_all().await;
    assert_eq!(stopped, 2);
    assert_eq!(bridge.state("fake"), McpServerRuntimeState::Stopped);
    assert_eq!(bridge.state("fake2"), McpServerRuntimeState::Stopped);
    assert!(bridge.managed_servers().is_empty());
}

// ── E5：register_plugin_server（插件 mcpServers 接入运行集）──────────

use agent_tools::registry::ToolRegistry;

/// 插件 MCP 注册：声明 → 服务器启动 → 工具并入 ToolRegistry 运行集，
/// 命名 `mcp_<server>__<tool>`（对齐 kimi 命名规范）；注册后可经注册表
/// 执行往返
#[tokio::test]
async fn register_plugin_server_merges_tools_into_registry() {
    let bridge = McpClientBridge::new();
    let registry = ToolRegistry::new();
    let config = fake_server_config(&[]);
    let defs = agent_tools::mcp::register_plugin_server(&bridge, &registry, &config)
        .await
        .unwrap();
    let names: Vec<String> = defs.iter().map(|d| d.name.clone()).collect();
    assert_eq!(
        names,
        [
            mcp_tool_name("fake", "echo"),
            mcp_tool_name("fake", "add"),
            mcp_tool_name("fake", "boom"),
            mcp_tool_name("fake", "env"),
        ]
    );
    // 工具可见（list_definitions 消费面；输出按 name 升序）
    let mut listed: Vec<String> = registry
        .list_definitions()
        .iter()
        .map(|d| d.name.clone())
        .collect();
    let mut expected = names.clone();
    listed.sort();
    expected.sort();
    assert_eq!(
        listed, expected,
        "并入后 list_definitions 应可见全部 MCP 工具"
    );
    // 注册表执行往返（适配器生效）
    let echo = registry.get(&mcp_tool_name("fake", "echo")).unwrap();
    let out = echo
        .execute(&tool_ctx(), json!({ "msg": "插件注册" }))
        .await
        .unwrap();
    assert!(out["text"].as_str().unwrap().contains("插件注册"));
    // 生命周期：stop 后注册表工具仍在（适配器调用报不可用）
    bridge.stop("fake").await.unwrap();
    let err = echo
        .execute(&tool_ctx(), json!({ "msg": "x" }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "mcp.connection_failed");
}

/// 幂等：重复注册（server 已 Ready）不报错、不重复并入
#[tokio::test]
async fn register_plugin_server_is_idempotent() {
    let bridge = McpClientBridge::new();
    let registry = ToolRegistry::new();
    let config = fake_server_config(&[]);
    let first = agent_tools::mcp::register_plugin_server(&bridge, &registry, &config)
        .await
        .unwrap();
    let second = agent_tools::mcp::register_plugin_server(&bridge, &registry, &config)
        .await
        .unwrap();
    assert_eq!(first, second, "幂等注册返回同一组定义");
    assert_eq!(registry.len(), first.len(), "重复注册不得重复并入");
    assert_eq!(registry.len(), 4);
    bridge.stop("fake").await.unwrap();
}

/// 启动失败 = 插件级错误上抛（mcp.connection_failed），注册表保持干净
#[tokio::test]
async fn register_plugin_server_failure_leaves_registry_clean() {
    let bridge = McpClientBridge::new();
    let registry = ToolRegistry::new();
    let config = McpServerConfig::new("missing", "definitely-not-a-real-command-xyz");
    let err = agent_tools::mcp::register_plugin_server(&bridge, &registry, &config)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "mcp.connection_failed");
    assert!(registry.is_empty(), "启动失败不得污染注册表");
    assert_eq!(bridge.state("missing"), McpServerRuntimeState::Stopped);
}
