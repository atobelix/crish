/**
 * tools/ barrel — 工具注册 API 公共导出。
 *
 * 依据 ROUND-08-plugin-sdk.md §3.1 目录结构：
 *   tools/
 *     plugin-api.ts     # registerTool 实现委托 + 类型 re-export
 *     mcp-declaration.ts # PluginMcpServerDeclaration + McpRegistrar
 *     index.ts          # barrel
 *
 * 8-B 的 HookAPI 与 8-D 的 PluginAPI 从此 barrel 统一引用工具相关类型。
 */

export type {
  ToolDefinition,
  ToolRegistrationOptions,
  RegisteredTool,
  ToolRegistrar,
} from './plugin-api';
export { createToolRegistrar } from './plugin-api';
export type {
  PluginMcpServerDeclaration,
  McpRegistrar,
} from './mcp-declaration';
