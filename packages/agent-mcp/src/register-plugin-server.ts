/**
 * registerPluginServer — 插件 MCP 服务器注册入口（Layer 3）
 *
 * 依据 ANTI_OVERENGINEERING_GUARDRAILS.md 禁令 10：plugin-mcp 独立包并入 agent-mcp，
 * 增加 registerPluginServer 入口。
 * 依据 ANTI_OVERENGINEERING_GUARDRAILS.md 禁令 10：MCP 集成通过此入口实现，
 * 不在 plugin-sdk 内重复实现 MCP 生命周期。
 *
 * MVP 阶段仅实现骨架（声明式注册 + McpLifecycleManager 委托），
 * 完整实现推迟到 Round 8（plugin-sdk 重建时）。
 *
 * 依据 ROUND-04-split-phase-B.md §2.5 Task 1b。
 */

import type {
  McpServerDefinition,
  McpServerOperationResult,
} from './mcp-lifecycle/types';
import type { McpLifecycleManager } from './mcp-lifecycle/mcp-lifecycle-manager';

/**
 * 插件 MCP 服务器声明
 *
 * 对应 PluginManifest.declaredMcpServers 中的每一项声明，
 * 通过 PluginAPI.mcp.registerServer() 命令式注册。
 */
export interface PluginMcpDeclaration {
  /** 插件名称（来自 PluginManifest.name） */
  readonly pluginName: string;
  /** MCP 服务器名称（在 agent-mcp 内唯一，用于生命周期管理） */
  readonly serverName: string;
  /** MCP 服务器定义（stdio 命令 / 环境变量 / 启动参数） */
  readonly definition: McpServerDefinition;
}

/**
 * 注册插件声明的 MCP 服务器
 *
 * 依据禁令 10：plugin-mcp 独立包被禁止，并入 agent-mcp。
 * 依据禁令 10：MCP 集成通过此入口实现，不在 plugin-sdk 内重复。
 * 依据禁令 19：MVP 阶段禁止 OAuth，HotReload 推迟到 Phase 2。
 *
 * @param manager McpLifecycleManager 实例
 * @param pluginName 插件名称
 * @param declaration MCP 服务器声明
 * @returns 注册结果
 *
 * @alpha Round 4 为骨架实现，完整校验（manifest 声明比对 + TrustGate 权限校验）推迟到 Round 8
 */
export function registerPluginServer(
  manager: McpLifecycleManager,
  pluginName: string,
  declaration: PluginMcpDeclaration
): McpServerOperationResult {
  // MVP 骨架：委托给 McpLifecycleManager 的现有 startServer 能力
  // 完整实现（manifest 校验 + 权限校验 + 热重载）推迟到 Round 8
  void manager;
  void pluginName;
  void declaration;
  throw new Error(
    '[registerPluginServer] not implemented in Round 4 — deferred to Round 8'
  );
}
