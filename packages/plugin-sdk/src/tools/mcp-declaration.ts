/**
 * 插件 MCP 服务器声明类型。
 *
 * 依据 ANTI_OVERENGINEERING_GUARDRAILS.md 禁令 19：MVP 阶段禁止 OAuth，
 * 仅支持 stdio 本地进程。HTTP/SSE 传输与 OAuth 鉴权推迟到 Phase 2。
 *
 * 依据禁令 13：MCP 集成走 agent-mcp 的 registerPluginServer 入口，
 * plugin-sdk 不直接 import agent-mcp（通过 PluginAPIDeps.mcpRegistrar 函数注入）。
 *
 * I8-E2 manifest 双轨收敛（03 生态插件方案 §3.4）：PluginMcpServerDeclaration
 * 以 shared-types 为真源（本文件 re-export），plugin-sdk 不再本地定义。
 */

export type { PluginMcpServerDeclaration } from '@crish/shared-types';
import type { PluginMcpServerDeclaration } from '@crish/shared-types';

/**
 * MCP 服务器注册器契约。
 *
 * 由 agent-mcp 的 registerPluginServer 实现此契约，
 * 通过 PluginAPIDeps.mcpRegistrar 注入到 PluginAPI。
 * plugin-sdk 不直接依赖 agent-mcp（禁令 13 解循环依赖）。
 *
 * @param pluginName 插件 ID（来自 PluginManifest.id）
 * @param declaration 插件声明的 MCP 服务器
 */
export type McpRegistrar = (
  pluginName: string,
  declaration: PluginMcpServerDeclaration
) => void;
