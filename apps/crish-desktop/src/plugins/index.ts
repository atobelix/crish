/**
 * apps/crish-desktop/src/plugins/index.ts
 * Crish 官方插件解耦体系门面导出 (DIM-06, RUL-06)。
 *
 * 统一导出：
 * - 插件类型契约与 DisposableBag 资源容器 (types.ts)
 * - 插件注册中心 (PluginRegistry.ts)
 * - Zustand 响应式 Store (usePluginStore.ts)
 * - 官方四大独立插件模块：
 *   1. MarkdownEditorPlugin (@crish/plugin-markdown-editor)
 *   2. BrowserPlugin (@crish/plugin-browser)
 *   3. ComputerUsePlugin (@crish/plugin-computer-use)
 *   4. FollowUpPlugin (@crish/plugin-follow-up)
 *
 * CI Guardrail: Business Logic (Max 400 lines of effective code, UTF-8 无 BOM)
 */

export * from './types';
export * from './PluginRegistry';
export * from './usePluginStore';

export * from './plugin-markdown-editor';
export * from './plugin-browser';
export * from './plugin-computer-use';
export * from './plugin-follow-up';

import { pluginRegistry } from './PluginRegistry';
import { MarkdownEditorPlugin } from './plugin-markdown-editor';
import { BrowserPlugin } from './plugin-browser';
import { ComputerUsePlugin } from './plugin-computer-use';
import { FollowUpPlugin } from './plugin-follow-up';

/**
 * 初始化并自动注册四大官方插件
 */
export function registerOfficialPlugins(): void {
  pluginRegistry.register(MarkdownEditorPlugin);
  pluginRegistry.register(BrowserPlugin);
  pluginRegistry.register(ComputerUsePlugin);
  pluginRegistry.register(FollowUpPlugin);
}

// 自举注册
registerOfficialPlugins();
