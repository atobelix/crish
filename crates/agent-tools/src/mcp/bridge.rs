//! MCP 客户端桥（任务书 B5.4：stdio 子进程 + JSON-RPC 2.0 最小客户端）
//! （SR-06a-6 · 拆分 · ≠ EL）
//!
//! 设计（对齐 MCP 官方 stdio 规范，不引入 mcp 生态依赖）：
//! - 子进程经 tokio::process 拉起，stdin/stdout/stderr 全管道
//! - 消息按行分隔 JSON（MCP stdio 传输：每条 JSON-RPC 消息独占一行）
//! - 会话流程：initialize → notifications/initialized → tools/list → tools/call
//! - 请求/响应按递增 id 配对（oneshot 挂起表）；notification 忽略
//! - 生命周期：读线程 EOF 与轮询 try_wait 双路检测崩溃；stop 杀进程清理
//! - 工具适配：tools/list 结果 → ToolDefinition（名称前缀 `mcp_<server>__<tool>`
//!   防冲突）；tools/call 经 Tool trait 适配器进入统一执行器
//!
//! 错误协议：启动失败 → mcp.connection_failed；协议违规 → mcp.protocol_violation；
//! 请求超时 → runtime.timeout；server 未运行 → mcp.connection_failed。
//!
//! 结构（SR-06a-6 · 拆分 · ≠ EL）：本文件为薄门面，实现按逻辑域拆 3 个子模
//! （扁平文件必须 `#[path]` 显式接线）：
//! - `bridge_protocol`：协议与参数适配域（协议常量 / `McpToolInfo` wire 形状 /
//!   名称前缀与净化 / 工具枚举与调用结果适配 / JSON-RPC 响应解析）
//! - `bridge_session`：进程/会话/调用执行域（stdio 子进程生命周期 /
//!   JSON-RPC 请求-响应通道 / 工具枚举缓存 / 崩溃检测后台任务）
//! - `bridge_registry`：生命周期/注册域（`McpClientBridge` 会话表 /
//!   `McpToolAdapter` 本地 Tool 适配器）
//! 测试按域旁挂（`bridge_protocol_tests` / `bridge_session_tests` /
//! `bridge_registry_tests`，`#[path]` 接线，无孤儿，零删除）；
//! 公开 API 经本文件 `pub use` 保持不 break（mcp/mod.rs 与调用方零改动）。
//! 诚实边界：仅结构拆分，MCP 桥语义（list/call 注册、鉴权、参数校验）
//! 零改动（≠ EL / ≠ 打开完成 / ≠ 结构债清零）。

// ==================== 拆分接线（SR-06a-6 · 结构拆分 · ≠ EL）====================

#[path = "bridge_protocol.rs"]
mod bridge_protocol;
#[path = "bridge_registry.rs"]
mod bridge_registry;
#[path = "bridge_session.rs"]
mod bridge_session;

pub use bridge_protocol::{
    adapt_call_result, adapt_tool_list, format_mcp_tool_name, mcp_tool_name, sanitize_id_part,
    McpToolInfo, DEFAULT_MCP_CALL_TIMEOUT, DEFAULT_MCP_INIT_TIMEOUT, DEFAULT_MCP_LIST_TIMEOUT,
    MCP_PROTOCOL_VERSION,
};
pub use bridge_registry::{McpClientBridge, McpDynamicToolAdapter, McpToolAdapter};
pub use bridge_session::{McpServerRuntimeState, McpServerSession};
