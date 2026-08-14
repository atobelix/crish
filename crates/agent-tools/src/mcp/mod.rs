//! MCP 桥与外壳（任务书 B5.4 + **W4-D** 同一 registry）
//!
//! 目标：MCP server 的 stdio 客户端桥，把远端 MCP 工具适配成本地
//! `Tool` trait 实现，经 `ToolRegistry` 进入统一工具执行器（B3.5）；
//! 以及 **W4-D** 反向外壳——把同一 registry（含笔记工具）以 MCP
//! `tools/list` / `tools/call` 形状对外暴露。
//!
//! - `servers`：MCP server 配置管理（增删改查 + 可选持久化钩子），
//!   对齐 03 §3.2 C 组 list-mcp-servers 命令的配置面
//! - `bridge`：stdio 子进程 + JSON-RPC 2.0 最小客户端桥
//!   （initialize → initialized → tools/list → tools/call），
//!   含工具枚举适配（名称前缀 `mcp_<server>__<tool>` 防冲突）、
//!   工具执行适配（Tool trait）、进程生命周期与崩溃检测
//! - **`shell`（W4-D）**：本地 ToolRegistry → MCP 协议形状外壳；
//!   list/call **仅**走 registry，未注册不可偷创；笔记工具原生名可见
//! - `register_plugin_server`：插件 mcpServers 接入入口（E5）——
//!   PluginMcpDeclaration（stdio command/args/env）→ 受管服务器 →
//!   工具并入 ToolRegistry 运行集（供 list_definitions 消费，与 E4
//!   on_definition 共享构建点）
//!
//! 约束：不引入 mcp 生态依赖，手写最小客户端；tools/call 默认超时 30 秒；
//! 中文注释。语义来源：03 §3.2 C、00 §2 B5、packages/agent-mcp（TS 版生命周期）、
//! plans/06 §1 MCP 同一 registry 外壳、plans/09 **W4-D**。
//!
//! # 诚实边界（W4-D）
//! - **≠** 生产 MCP 全网关完成（stdio 服务端进程 / resources / prompts 等）
//! - **≠** EL-05 / EL-07 关闭

use crate::definition::{ToolDefinition, ToolError};
use crate::registry::ToolRegistry;
use conex_types::error::codes;

pub mod bridge;
pub mod servers;
pub mod shell;

pub use bridge::{
    adapt_call_result, adapt_tool_list, mcp_tool_name, sanitize_id_part, McpClientBridge,
    McpServerRuntimeState, McpServerSession, McpToolAdapter, McpToolInfo, DEFAULT_MCP_CALL_TIMEOUT,
    DEFAULT_MCP_INIT_TIMEOUT, DEFAULT_MCP_LIST_TIMEOUT,
};
pub use servers::{McpConfigPersistence, McpServerConfig, McpServerStore, McpTransport};
pub use shell::{McpRegistryShell, W4D_MCP_SHELL_PACKAGE_ID};

/// 插件 MCP server 注册入口（E5：shared-types `PluginMcpDeclaration`
/// 对应的 Rust 消费点——plugin-sdk `registerMcpServer` 的宿主侧实现）
///
/// 流程：配置校验 → `bridge.start`（spawn + initialize 握手 + tools/list
/// 枚举）→ 每个工具经 `McpToolAdapter` 并入注册表（`register_runtime`，
/// &self 共享面）→ 返回适配后的本地定义。
///
/// 语义：
/// - 启动失败 → mcp.* 错误上抛（调用方承接为插件级错误进 runtime-error，
///   不阻塞 run）；进程保留（Degraded）供 restart 重建重试；
/// - 幂等：server 已 Ready 时 `bridge.start` 返回缓存定义；已并入注册表
///   的同名工具跳过（重复注册不报错，重启重建安全）；
/// - 工具命名 `mcp_<server>__<tool>`（kimi `mcp__plugin-*__*` 同规范）；
/// - 服务器生命周期随 run 启停由调用方（engine 层）驱动（session.start
///   启动 / session.end 关闭）。
pub async fn register_plugin_server(
    bridge: &McpClientBridge,
    registry: &ToolRegistry,
    config: &McpServerConfig,
) -> Result<Vec<ToolDefinition>, ToolError> {
    let defs = bridge.start(config).await?;
    for def in &defs {
        if registry.has(&def.name) {
            // 已并入（重启 / 重复注册）：跳过，保持幂等
            continue;
        }
        let adapter = bridge
            .get_adapter(&config.server_id, &def.name)
            .ok_or_else(|| {
                ToolError::new(
                    codes::MCP_CONNECTION_FAILED,
                    format!(
                        "MCP server {} 工具适配器缺失：{}",
                        config.server_id, def.name
                    ),
                )
            })?;
        registry.register_runtime(adapter).map_err(|e| {
            ToolError::new(
                codes::MCP_CONNECTION_FAILED,
                format!(
                    "MCP server {} 工具并入注册表失败（{}）：{e}",
                    config.server_id, def.name
                ),
            )
        })?;
    }
    Ok(defs)
}
