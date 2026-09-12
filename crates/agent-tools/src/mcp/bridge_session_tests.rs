//! bridge_session · 测试旁挂（SR-06a-6 拆分；经 `bridge_session.rs`
//! `#[path]` 接线，无孤儿）
//!
//! 全部既有测试原样迁移（零删除、零合并）：状态编解码往返与 serde
//! lowercase、会话不可用错误（退出原因进消息）、锁中毒恢复
//! （PE-07 T07.6 用例 2：会话锁毒化后公开 API 与 request 错误路径
//! 不 panic）。
//! 诚实边界：仅结构拆分，语义零改动（≠ EL / ≠ 打开完成 / ≠ 结构债清零）。

use super::*;
use serde_json::json;

use crate::mcp::bridge::DEFAULT_MCP_CALL_TIMEOUT;

#[test]
fn runtime_state_roundtrip() {
    for state in [
        McpServerRuntimeState::Stopped,
        McpServerRuntimeState::Starting,
        McpServerRuntimeState::Ready,
        McpServerRuntimeState::Degraded,
        McpServerRuntimeState::Exited,
    ] {
        assert_eq!(runtime_state_of(runtime_state_code(state)), state);
    }
    // serde lowercase（对齐前端 state 字符串）
    assert_eq!(
        serde_json::to_string(&McpServerRuntimeState::Degraded).unwrap(),
        "\"degraded\""
    );
}

/// 会话不可用错误：退出原因进消息
#[test]
fn unavailable_error_includes_exit_reason() {
    let session = McpServerSession {
        server_id: "s1".to_string(),
        state: AtomicU8::new(STATE_EXITED),
        child: Mutex::new(None),
        stdin: Mutex::new(None),
        next_id: AtomicU64::new(0),
        pending: std::sync::Mutex::new(HashMap::new()),
        tools: RwLock::new(None),
        tool_index: RwLock::new(HashMap::new()),
        exit_reason: std::sync::Mutex::new(Some("进程退出（exit status: 1）".to_string())),
        stderr_tail: std::sync::Mutex::new(Vec::new()),
        call_timeout: DEFAULT_MCP_CALL_TIMEOUT,
    };
    let err = session.unavailable_error();
    assert_eq!(err.code(), "mcp.connection_failed");
    assert!(err.to_string().contains("进程退出"));
}

// ── PE-07 T07.6 用例 2：锁中毒恢复（Q17 处置验证） ──

/// 构造一个就绪态会话（全部锁初始未毒化）
fn ready_session() -> Arc<McpServerSession> {
    Arc::new(McpServerSession {
        server_id: "s1".to_string(),
        state: AtomicU8::new(STATE_READY),
        child: Mutex::new(None),
        stdin: Mutex::new(None),
        next_id: AtomicU64::new(0),
        pending: std::sync::Mutex::new(HashMap::new()),
        tools: RwLock::new(None),
        tool_index: RwLock::new(HashMap::new()),
        exit_reason: std::sync::Mutex::new(None),
        stderr_tail: std::sync::Mutex::new(Vec::new()),
        call_timeout: DEFAULT_MCP_CALL_TIMEOUT,
    })
}

#[test]
fn poisoned_session_locks_recover_without_panic() {
    let session = ready_session();
    // 毒化会话全部 std 锁（模拟恶意 server 回调持锁 panic）
    crate::test_support::poison_std_lock(&session.pending);
    crate::test_support::poison_std_lock(&session.exit_reason);
    crate::test_support::poison_std_lock(&session.stderr_tail);
    crate::test_support::poison_rw_lock(&session.tools);
    crate::test_support::poison_rw_lock(&session.tool_index);
    // 毒化后公开 API / 内部清理路径不 panic 且可继续工作
    assert!(session.tools().is_empty());
    assert_eq!(session.exit_reason(), None);
    assert!(session.stderr_tail().is_empty());
    session.push_stderr_line("line".to_string());
    session.mark_exited("模拟退出");
    assert_eq!(session.state(), McpServerRuntimeState::Exited);
    assert_eq!(session.exit_reason(), Some("模拟退出".to_string()));
}

#[tokio::test]
async fn poisoned_session_request_returns_error_not_panic() {
    let session = Arc::new(McpServerSession {
        server_id: "s1".to_string(),
        state: AtomicU8::new(STATE_STARTING),
        child: Mutex::new(None),
        stdin: Mutex::new(None),
        next_id: AtomicU64::new(0),
        pending: std::sync::Mutex::new(HashMap::new()),
        tools: RwLock::new(None),
        tool_index: RwLock::new(HashMap::new()),
        exit_reason: std::sync::Mutex::new(None),
        stderr_tail: std::sync::Mutex::new(Vec::new()),
        call_timeout: DEFAULT_MCP_CALL_TIMEOUT,
    });
    crate::test_support::poison_std_lock(&session.pending);
    // 毒化 pending 后 request 挂起表可写、stdin 缺失走错误返回，不 panic
    let err = session
        .request("tools/list", json!({}), Duration::from_millis(10))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "mcp.connection_failed");
}

/// U-MEM / 10-M1：read_line_bounded 正常行读完（含 \n）→ Ok(Some)
#[tokio::test]
async fn read_line_bounded_normal_line() {
    let data = b"{\"id\":1}\n{\"id\":2}\n";
    let mut reader = BufReader::new(&data[..]);
    let mut buf = Vec::new();
    assert!(matches!(
        read_line_bounded(&mut reader, &mut buf).await,
        Ok(Some(()))
    ));
    assert_eq!(&buf[..], b"{\"id\":1}\n");
    buf.clear();
    assert!(matches!(
        read_line_bounded(&mut reader, &mut buf).await,
        Ok(Some(()))
    ));
    assert_eq!(&buf[..], b"{\"id\":2}\n");
    buf.clear();
    assert!(matches!(
        read_line_bounded(&mut reader, &mut buf).await,
        Ok(None)
    ));
}

/// U-MEM / 10-M1：超 MCP_STDOUT_MAX_LINE_BYTES 单行 → Err（connection_failed 语义）
#[tokio::test]
async fn read_line_bounded_over_limit_errors() {
    use conex_shared::perf_budget::MCP_STDOUT_MAX_LINE_BYTES;
    // 构造超限单行：MAX+1 字节 'a' + '\n'——读满上限后多 1 字节即 Err
    let limit_plus = MCP_STDOUT_MAX_LINE_BYTES + 1;
    let data = vec![b'a'; limit_plus + 1];
    let mut reader = BufReader::with_capacity(64 * 1024, &data[..]);
    let mut buf = Vec::new();
    let result = read_line_bounded(&mut reader, &mut buf).await;
    assert!(
        matches!(result, Err(())),
        "超 MCP_STDOUT_MAX_LINE_BYTES 单行必须 Err（connection_failed，非静默）"
    );
}
