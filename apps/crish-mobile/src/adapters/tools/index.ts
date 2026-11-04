/**
 * apps/crish-mobile/src/adapters/tools/index.ts
 *
 * 通用端侧工具体系统一导出入口
 * 严格对齐《04-分维-移动端本地Agent循环与通用端侧工具体系方案.md》§3 & §4
 */

import { mobileToolRegistry, MobileToolRegistry } from './toolRegistry';
import { webSearchTool } from './webSearchTool';
import { webFetchTool } from './webFetchTool';
import { runJsSandboxTool } from './runJsSandboxTool';

export * from './types';
export * from './toolRegistry';
export * from './webSearchTool';
export * from './webFetchTool';
export * from './runJsSandboxTool';

/**
 * 注册所有端侧内置默认工具到指定或默认注册表
 */
export function registerDefaultMobileTools(
  registry: MobileToolRegistry = mobileToolRegistry
): MobileToolRegistry {
  if (!registry.has(webSearchTool.name)) {
    registry.register(webSearchTool);
  }
  if (!registry.has(webFetchTool.name)) {
    registry.register(webFetchTool);
  }
  if (!registry.has(runJsSandboxTool.name)) {
    registry.register(runJsSandboxTool);
  }
  return registry;
}

// 默认单例预先装配三大内置核心工具
registerDefaultMobileTools(mobileToolRegistry);
