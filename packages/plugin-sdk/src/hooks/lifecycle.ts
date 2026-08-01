// packages/plugin-sdk/src/hooks/lifecycle.ts
// 依据禁令 15/16/17：插件入口模块须导出 PluginLifecycle 实现。
// 设计文档：analysis/iterative-repair/v2/ROUND-08-plugin-sdk.md §3.4

import type { HookAPI } from './api';

/**
 * 插件生命周期接口。
 *
 * 插件入口模块须默认导出实现此接口的对象，或导出 activate 函数。
 * activate 在 PluginLoader.load 阶段调用，deactivate 在卸载/停用时调用。
 *
 * - activate(api)：注册 hook/tool/mcp。可返回 Promise(异步激活)。
 *   抛出错误会导致插件进入 error 状态。
 * - deactivate()：清理资源(取消订阅、关闭连接)。可选，可返回 Promise。
 */
export interface PluginLifecycle {
  /**
   * 激活插件：注册 hook/tool/mcp。
   * 可返回 Promise（异步激活）。
   * 抛出错误会导致插件进入 error 状态。
   */
  activate(api: HookAPI): void | Promise<void>;

  /**
   * 停用插件：清理资源（取消订阅、关闭连接）。
   * 可返回 Promise。
   */
  deactivate?(): void | Promise<void>;
}

/**
 * 插件入口模块形状（动态 import 后的模块对象）。
 *
 * 支持两种导出方式：
 * 1. default 导出 PluginLifecycle 对象
 * 2. 具名导出 activate / deactivate 函数
 */
export interface PluginModule {
  readonly default?: PluginLifecycle;
  readonly activate?: PluginLifecycle['activate'];
  readonly deactivate?: PluginLifecycle['deactivate'];
}
