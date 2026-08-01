// packages/plugin-sdk/src/registry/index.ts
// Barrel：插件发现 + 加载 + 校验 + 注册表 + 存储 + 状态机
// 依据 ROUND-08-plugin-sdk.md §3.1 目录结构 + §2.5 Agent 8-D 范围

// ─── 状态机 ───
export type {
  PluginState,
  PluginStateEntry,
  PluginStateTransitionRecord,
} from './plugin-state';
export {
  ALLOWED_TRANSITIONS,
  isValidTransition,
  transferState,
  createDiscoveredEntry,
} from './plugin-state';

// ─── 发现器 ───
export { PluginDiscoverer } from './plugin-discoverer';
export type { DiscoveredPlugin } from './plugin-discoverer';

// ─── 校验器 ───
export { PluginValidator } from './plugin-validator';
export type {
  PluginValidationResult,
  PluginValidationError,
  RecordedRegistrations,
} from './plugin-validator';
export { createEmptyRecordings } from './plugin-validator';

// ─── 加载器 ───
export { PluginLoader } from './plugin-loader';
export type { PluginLoadResult } from './plugin-loader';

// ─── 注册表 ───
export { PluginRegistry } from './plugin-registry';
export type {
  PluginRegistryOptions,
  PluginListEntry,
  PluginToolContribution,
  PluginCapabilities,
  ToolRegistryQuery,
} from './plugin-registry';

// ─── 持久化存储 ───
export { PluginStore } from './plugin-store';
export type { StoredPluginEntry } from './plugin-store';
