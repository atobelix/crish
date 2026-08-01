//! MCP 桥（任务书 B5.4：MCP 工具接入）
//!
//! 目标：MCP server 的 stdio 客户端桥，把远端 MCP 工具适配成本地
//! `Tool` trait 实现，经 `ToolRegistry` 进入统一工具执行器（B3.5）。
//!
//! - `servers`：MCP server 配置管理（增删改查 + 可选持久化钩子），
//!   对齐 03 §3.2 C 组 list-mcp-servers 命令的配置面
//! - `bridge`：stdio 子进程 + JSON-RPC 2.0 最小客户端桥
//!   （initialize → initialized → tools/list → tools/call），
//!   含工具枚举适配（名称前缀 `mcp_<server>__<tool>` 防冲突）、
//!   工具执行适配（Tool trait）、进程生命周期与崩溃检测
//!
//! 约束：不引入 mcp 生态依赖，手写最小客户端；tools/call 默认超时 30 秒；
//! 中文注释。语义来源：03 §3.2 C、00 §2 B5、packages/agent-mcp（TS 版生命周期）。

pub mod bridge;
pub mod servers;

pub use bridge::{
    adapt_call_result, adapt_tool_list, mcp_tool_name, sanitize_id_part, McpClientBridge,
    McpServerRuntimeState, McpServerSession, McpToolAdapter, McpToolInfo,
    DEFAULT_MCP_CALL_TIMEOUT, DEFAULT_MCP_INIT_TIMEOUT, DEFAULT_MCP_LIST_TIMEOUT,
};
pub use servers::{
    McpConfigPersistence, McpServerConfig, McpServerStore, McpTransport,
};
