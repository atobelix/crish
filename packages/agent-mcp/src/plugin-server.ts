/**
 * Plugin MCP 服务器注册接口（预留，Round 8 实现）。
 *
 * 依据 ANTI_OVERENGINEERING_GUARDRAILS.md 禁令 10：
 * MCP 集成通过 agent-mcp 的 registerPluginServer(pluginName, declaration) 入口实现，
 * 不在 plugin-sdk 内重复实现 MCP 生命周期。
 *
 * 依据 ANTI_OVERENGINEERING_GUARDRAILS.md 禁令 10：
 * plugin-mcp 不独立成包，并入 agent-mcp（与现有 McpLifecycleManager 职责完全重叠）。
 *
 * Round 3 阶段：仅声明类型签名，不实现。
 * Round 8 阶段：在 plugin-sdk 重建时实现具体逻辑，调用 McpLifecycleManager 注册插件声明的 MCP 服务器。
 */

/**
 * 插件声明的 MCP 服务器描述。
 * 具体字段在 Round 8 plugin-sdk 重建时根据 PluginManifest.declaredMcpServers 定义。
 */
export interface PluginMcpServerDeclaration {
  readonly pluginName: string;
  readonly serverName: string;
  readonly transport: 'stdio' | 'sse' | 'streamable-http';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly declaredTools?: readonly string[];
}

/**
 * 注册插件声明的 MCP 服务器。
 *
 * @param _pluginName - 插件名称
 * @param _declaration - MCP 服务器声明
 * @returns 注册结果（Round 8 实现）
 *
 * @deprecated Round 3 阶段仅声明类型，调用会抛出 NotImplementedError。
 * @see PluginMcpServerDeclaration
 * @removeWhen Round 8 plugin-sdk 重建时实现
 */
export function registerPluginServer(
  _pluginName: string,
  _declaration: PluginMcpServerDeclaration
): Promise<void> {
  throw new Error(
    'registerPluginServer is not implemented in Round 3; will be implemented in Round 8 (plugin-sdk rebuild)'
  );
}
