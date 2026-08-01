// packages/plugin-sdk/src/hooks/api.ts
// 依据禁令 15/16/17：activate(api: HookAPI) 命令式注册。
// HookAPI 是插件作者接触的唯一入口，聚合钩子注册 + 工具注册 + MCP 声明。
// 设计文档：analysis/iterative-repair/v2/ROUND-08-plugin-sdk.md §3.4

import type {
  HookEventName,
  HookObserveHandler,
  HookOnHandler,
  HookUnsubscribe,
  PluginManifest,
  PluginMcpServerDeclaration,
  RegisteredTool,
  SessionContextSnapshot,
  ToolDefinition,
  ToolRegistrationOptions,
  JsonObject,
} from '@crish/shared-types';

/**
 * 插件激活时收到的 API 入口。
 *
 * 插件通过 activate(api) 命令式注册能力(禁令 15/16/17)：
 * - api.observe(event, handler) / api.on(event, handler)：注册钩子
 * - api.registerTool(definition)：注册工具
 * - api.registerMcpServer(declaration)：声明 MCP 服务器
 *
 * 所有注册都会被 PluginValidator 比对 manifest 声明清单(禁令 15/16/17)。
 *
 * observe/on 双模式(禁令 14)：
 * - observe：容错并行，失败吞掉，不影响主路径。用于日志、监控、审计。
 * - on：串行语义合并，可返回控制信号。用于权限拦截、内容修改、流程控制。
 */
export interface HookAPI {
  /** 当前插件的 manifest(只读，供 activate 内部决策) */
  readonly manifest: PluginManifest;

  /**
   * 注册 observe 处理器(容错并行，失败吞掉 禁令 14)。
   * 需 manifest.permissions 含 'hook:observe'。
   * 需 manifest.declaredHooks 含 event。
   */
  observe<E extends HookEventName>(
    event: E,
    handler: HookObserveHandler<E>
  ): HookUnsubscribe;

  /**
   * 注册 on 处理器(串行语义合并，可返回控制信号 禁令 14)。
   * 需 manifest.permissions 含 'hook:intercept'。
   * 需 manifest.declaredHooks 含 event。
   */
  on<E extends HookEventName>(
    event: E,
    handler: HookOnHandler<E>
  ): HookUnsubscribe;

  /**
   * 注册自定义工具(禁令 15/16/17 命令式)。
   * 需 manifest.permissions 含 'tool:register'。
   * 需 manifest.declaredTools 含 definition.name。
   */
  registerTool(
    definition: ToolDefinition,
    options?: ToolRegistrationOptions
  ): RegisteredTool;

  /**
   * 声明 MCP 服务器(委托 agent-mcp 的 registerPluginServer 禁令 13)。
   * 需 manifest.permissions 含 'mcp:connect'。
   * 需 manifest.declaredMcpServers 含 declaration.name。
   * MVP 禁止 OAuth(禁令 19)，仅支持 stdio 本地进程。
   */
  registerMcpServer(declaration: PluginMcpServerDeclaration): void;

  /**
   * 读取会话上下文(需 'session:read' 权限)。
   * 返回当前会话的只读快照。
   */
  getSessionContext?(): SessionContextSnapshot;

  /**
   * 记录插件自定义日志(委托 @crish/logger，自动带 pluginId tag)。
   */
  log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    metadata?: JsonObject
  ): void;
}
