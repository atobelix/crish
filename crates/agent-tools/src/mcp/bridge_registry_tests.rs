//! bridge_registry · 测试旁挂（SR-06a-6 拆分；经 `bridge_registry.rs`
//! `#[path]` 接线，无孤儿）
//!
//! 全部既有测试原样迁移（零删除、零合并）：PE-07 T07.6 用例 2 桥级锁
//! 中毒恢复（会话表毒化后查询 / 清理 / 停止路径返回安全值或错误，
//! 不 panic）。
//! 诚实边界：仅结构拆分，语义零改动（≠ EL / ≠ 打开完成 / ≠ 结构债清零）。

use super::*;

#[test]
fn poisoned_bridge_sessions_lock_recovers_without_panic() {
    let bridge = McpClientBridge::new();
    crate::test_support::poison_std_lock(&bridge.sessions);
    // 毒化后查询 / 清理路径返回安全值或错误，不 panic
    assert_eq!(bridge.state("s1"), McpServerRuntimeState::Stopped);
    assert!(!bridge.is_running("s1"));
    assert_eq!(bridge.tools("s1"), None);
    assert_eq!(bridge.managed_servers(), Vec::<String>::new());
}

#[tokio::test]
async fn poisoned_bridge_stop_paths_return_error_not_panic() {
    let bridge = McpClientBridge::new();
    crate::test_support::poison_std_lock(&bridge.sessions);
    // 错误路径：毒化后 stop 返回 mcp.server_not_found 而非 panic
    let err = bridge.stop("s1").await.unwrap_err();
    assert_eq!(err.code(), "mcp.server_not_found");
    // stop_all 毒化后正常返回 0
    assert_eq!(bridge.stop_all().await, 0);
}

use std::sync::atomic::{AtomicU64, AtomicU8};
use std::sync::RwLock;
use tokio::sync::Mutex;
use super::super::bridge_session::McpToolHandle;

fn create_test_session(server_id: &str, tool_name: &str, state_code: u8) -> Arc<McpServerSession> {
    let mut tool_index = HashMap::new();
    let def = ToolDefinition {
        name: tool_name.to_string(),
        description: "test tool".to_string(),
        input_schema: serde_json::json!({"type": "object"}),
        dangerous: false,
        fatal_on_error: false,
    };
    tool_index.insert(
        tool_name.to_string(),
        McpToolHandle {
            server_tool_name: "echo".to_string(),
            def,
        },
    );
    Arc::new(McpServerSession {
        server_id: server_id.to_string(),
        state: AtomicU8::new(state_code),
        child: Mutex::new(None),
        stdin: Mutex::new(None),
        next_id: AtomicU64::new(0),
        pending: std::sync::Mutex::new(HashMap::new()),
        tools: RwLock::new(None),
        tool_index: RwLock::new(tool_index),
        exit_reason: std::sync::Mutex::new(None),
        stderr_tail: std::sync::Mutex::new(Vec::new()),
        call_timeout: Duration::from_secs(5),
    })
}

/// BC11-2 核心机制验证：适配器动态寻址，子进程重启更新会话后自动路由到新健康会话
#[test]
fn test_dynamic_adapter_routes_to_latest_healthy_session_after_restart() {
    let bridge = Arc::new(McpClientBridge::new());
    let server_id = "srv_test";
    let tool_name = "mcp_srv_test_abc123__echo";

    // 1. 注册初始会话 1 (Ready)
    let s1 = create_test_session(server_id, tool_name, 2); // 2 = STATE_READY
    bridge.sessions.lock().unwrap().insert(server_id.to_string(), s1.clone());

    // 2. 从 bridge 获取适配器
    let adapter = bridge.get_adapter(server_id, tool_name).expect("应成功获取适配器");
    assert_eq!(adapter.name(), tool_name);

    // 验证当前寻址到的 active session 为 s1
    let active1 = bridge.get_active_session(server_id).expect("应有活跃会话");
    assert_eq!(active1.server_id(), server_id);
    assert_eq!(active1.state(), McpServerRuntimeState::Ready);

    // 3. 模拟服务崩溃并重启：会话表替换为全新的 s2 (Ready)
    let s2 = create_test_session(server_id, tool_name, 2);
    bridge.sessions.lock().unwrap().insert(server_id.to_string(), s2.clone());

    // 4. 原 adapter 实例无须重新构建，再次执行寻址时自动取得 s2，绝不指向 s1 死指针
    let active2 = bridge.get_active_session(server_id).expect("重启后应获取新活跃会话");
    assert_eq!(active2.server_id(), server_id);
    assert!(!Arc::ptr_eq(&active1, &active2), "重启后应取得新会话实例");
    assert!(Arc::ptr_eq(&active2, &s2), "动态寻址必须精确路由到最新健康会话 s2");
}

/// 适配器在会话退出或停止时返回错误而非 panic
#[tokio::test]
async fn test_dynamic_adapter_fails_when_session_exited_or_stopped() {
    let bridge = Arc::new(McpClientBridge::new());
    let server_id = "srv_fail";
    let tool_name = "mcp_srv_fail_dead01__echo";

    // 初始会话为 Exited (4)
    let s_dead = create_test_session(server_id, tool_name, 4); // 4 = STATE_EXITED
    bridge.sessions.lock().unwrap().insert(server_id.to_string(), s_dead);

    // 无法获取 active session
    assert!(bridge.get_active_session(server_id).is_none());

    let adapter = bridge.get_adapter(server_id, tool_name).expect("可获得适配器定义");
    let ctx = crate::context::create_mock_tool_context();
    let err = adapter.execute(&ctx, serde_json::json!({})).await.unwrap_err();
    assert_eq!(err.code(), "mcp.connection_failed");
    assert!(err.to_string().contains("不可用"));
}
