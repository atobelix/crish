/**
 * 工具注册 API — PluginAPI.registerTool 的委托实现。
 *
 * 依据 ROUND-08-plugin-sdk.md §2.4 任务 1：
 *   PluginAPI.registerTool(definition, options) 委托给宿主注入的
 *   ToolRegistry（通过 HookAPI 持有的 registry 引用）。
 *
 * 依据禁令 13：plugin-sdk 仅类型依赖 shared-types（depcruise 允许类型 import，
 * 禁止运行时 import）。运行时 ToolRegistry 实例由宿主通过依赖注入提供，
 * plugin-sdk 不直接 new ToolRegistry。
 *
 * 本文件职责：
 * 1. 统一 re-export 工具三件套类型（ToolDefinition / ToolRegistrationOptions /
 *    RegisteredTool，Phase D 已下沉至 shared-types），供 HookAPI（8-B）、
 *    PluginAPI（8-D）从 '../tools' 引用。
 * 2. 定义 ToolRegistrar 契约接口（宿主的 ToolRegistry 实现此接口）。
 * 3. 提供 createToolRegistrar 工厂（预留审计 / 指标扩展点，MVP 透传）。
 */

// ─── 类型 re-export（供 8-B HookAPI / 8-D PluginAPI 统一引用）──────────
export type {
  ToolDefinition,
  ToolRegistrationOptions,
  RegisteredTool,
} from '@crish/shared-types';

import type {
  ToolDefinition,
  ToolRegistrationOptions,
  RegisteredTool,
} from '@crish/shared-types';

/**
 * ToolRegistrar 契约 — 宿主的 ToolRegistry 实现此接口。
 *
 * plugin-sdk 通过此接口与宿主工具注册表解耦：
 * - 类型层：plugin-sdk import type from '@crish/shared-types'（允许）
 * - 运行时：ToolRegistry 实例由宿主注入（PluginAPIDeps.toolRegistry），
 *   plugin-sdk 不直接依赖工具注册表运行时。
 *
 * PluginAPI.registerTool 实现：
 *   1. assertCapability('declaredTools', definition.name)
 *   2. assertPermission('tool:register')
 *   3. return this.deps.toolRegistry.register(definition, options)  // 委托
 */
export interface ToolRegistrar {
  /**
   * 注册工具到运行时工具注册表。
   * @param definition 工具定义（三层体系第 1 层）
   * @param options 注册选项（三层体系第 2 层，可选）
   * @returns 已注册工具（三层体系第 3 层，系统自动填充字段）
   */
  register(
    definition: ToolDefinition,
    options?: ToolRegistrationOptions
  ): RegisteredTool;
}

/**
 * 工具注册器工厂：将 ToolRegistrar 包装为可审计的注册器。
 *
 * 预留扩展点：未来可在 register 前后插入审计日志、指标采集、
 * 注册配额检查等横切关注。MVP 阶段直接透传，不引入额外开销。
 *
 * @param registry 满足 ToolRegistrar 契约的注册表实例（通常为宿主的 ToolRegistry）
 * @returns ToolRegistrar（MVP 直接返回入参，未来可返回代理包装）
 */
export function createToolRegistrar(registry: ToolRegistrar): ToolRegistrar {
  return registry;
}
