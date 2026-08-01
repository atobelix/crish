/**
 * PluginMcpServerDeclaration — 插件 MCP 服务器声明类型。
 *
 * 依据 ANTI_OVERENGINEERING_GUARDRAILS.md 禁令 19：MVP 阶段禁止 OAuth，
 * 仅支持 stdio 本地进程。HTTP/SSE 传输与 OAuth 鉴权推迟到 Phase 2。
 *
 * 依据禁令 13：MCP 集成走 agent-mcp 的 registerPluginServer 入口，
 * plugin-sdk 不直接 import agent-mcp（通过 PluginAPIDeps.mcpRegistrar 函数注入）。
 * 因此 PluginMcpServerDeclaration 是插件作者面向的声明类型，
 * 由 mcpRegistrar 实现方转换为 agent-mcp 内部格式后注册。
 */

/**
 * 插件声明的 MCP 服务器（stdio 传输，禁令 19 MVP 禁 OAuth）。
 *
 * 插件通过 HookAPI.registerMcpServer(declaration) 命令式注册：
 * - 需 manifest.declaredMcpServers 含 declaration.name
 * - 需 manifest.permissions 含 'mcp:connect'
 *
 * 禁令 19 约束：transport 字段固定为 'stdio'，不提供 http/sse/oauth 字段。
 * Phase 2 解禁后会扩展为联合类型（stdio | http | sse）。
 */
export interface PluginMcpServerDeclaration {
  /** MCP 服务器名称（在插件内唯一，对应 manifest.declaredMcpServers 项） */
  readonly name: string;

  /** 显示标签（可选，用于日志与诊断） */
  readonly label?: string;

  /** 传输方式（MVP 仅 'stdio'，禁令 19） */
  readonly transport: 'stdio';

  /** stdio 启动命令（如 'npx'、'node'、'python'） */
  readonly command: string;

  /** 命令行参数 */
  readonly args?: readonly string[];

  /** 环境变量注入（键值对，会与宿主环境变量合并） */
  readonly env?: Readonly<Record<string, string>>;

  /** 工作目录（可选，默认继承宿主 cwd） */
  readonly cwd?: string;

  /** 启动超时阈值（ms，可选，默认由 agent-mcp 接管） */
  readonly startupTimeoutMs?: number;
}

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
