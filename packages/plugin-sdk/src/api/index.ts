// packages/plugin-sdk/src/api/index.ts
// Barrel：PluginAPI 类本体（聚合 HookAPI + ToolRegistrar + 依赖注入）
// 依据 ROUND-08-plugin-sdk.md §3.1 目录结构 + §3.4 PluginAPI 设计

export { PluginAPI } from './plugin-api';
export type {
  PluginAPIDeps,
  PluginLoggerLike,
} from './plugin-api';
