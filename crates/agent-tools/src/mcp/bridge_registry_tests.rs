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
