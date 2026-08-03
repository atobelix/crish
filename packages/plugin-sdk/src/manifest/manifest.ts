// packages/plugin-sdk/src/manifest/manifest.ts
// 约束来源：ROUND-08-plugin-sdk.md 禁令 15/16/17（声明式能力清单）+ 禁令 18（信任模型）
// I8-E2 manifest 双轨收敛（03 生态插件方案 §3.4）：本文件改为 re-export
// shared-types 契约（跨端真源）——PluginManifest/PluginEntrypoints/PluginAuthor/
// HookEventName 全部来自 @crish/shared-types；保留 HOOK_EVENT_NAMES 枚举校验
// 与 TrustGate（trust-gate 属加载语义，留在 plugin-sdk）。

import type { HookEventName } from '@crish/shared-types';

export type {
  // ─── 14 钩子事件名（shared-types 真源，I7-M13 冻结）───
  HookEventName,
  // ─── manifest 契约（shared-types 真源，I8-E2 收敛）───
  PluginManifest,
  PluginEntrypoints,
  PluginAuthor,
} from '@crish/shared-types';

/**
 * 全部合法钩子事件名（供 validateManifest 枚举校验）。
 * 与 shared-types HOOK_EVENT_NAMES 同源（14 项冻结清单）。
 */
export const HOOK_EVENT_NAMES: readonly HookEventName[] = [
  'turn.start',
  'turn.end',
  'tool.pre',
  'tool.post',
  'context.compact.start',
  'context.compact.end',
  'session.start',
  'session.end',
  'model.beforeRequest',
  'model.afterResponse',
  'subagent.start',
  'subagent.end',
  'error.occurred',
  'tool.error',
] as const;

// ─── 加载语义类型（留在 plugin-sdk：插件本地权限/引擎约束，非跨端契约）───

export type { PluginOrigin, PluginPermission, PluginTrustLevel } from './permissions';

export type {
  SemVerRange,
  PluginEngineConstraint,
} from './engine-constraint';
