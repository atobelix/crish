// packages/plugin-sdk/src/hooks/index.ts
// Barrel：14 钩子类型 + HookAPI + PluginLifecycle。
// 依据禁令 13：纯类型从 shared-types/src/plugin.ts re-export，派发器留 agent-core。
// 设计文档：analysis/iterative-repair/v2/ROUND-08-plugin-sdk.md §3.1

export type * from './types';
export type { HookAPI } from './api';
export type { PluginLifecycle, PluginModule } from './lifecycle';
