// packages/plugin-sdk/src/manifest/manifest.ts
// 约束来源：ROUND-08-plugin-sdk.md 禁令 15/16/17（声明式能力清单）+ 禁令 18（信任模型）

import type { JsonObject } from '@crish/shared-types';
import type {
  PluginOrigin,
  PluginPermission,
  PluginTrustLevel,
} from './permissions';
import type { PluginEngineConstraint } from './engine-constraint';

/**
 * 14 钩子事件名联合类型（禁令 14）。
 *
 * 现有 6 个（保留命名，payload 不退化）+ 新增 8 个（点分命名）+ tool.error
 * （保留 ToolHook.onError 控制能力）。
 *
 * 注意：shared-types/src/plugin.ts 由 Agent 8-B 同步定义 HookPayloadMap 的
 * 完整 payload 类型；本处的 HookEventName 为 manifest 声明清单的约束字面量，
 * 与 shared-types 的 HookEventName = keyof HookPayloadMap 保持一致。
 */
export type HookEventName =
  // ── 现有 6 个（保留命名，payload 不退化，禁令 14）──
  | 'turn.start'
  | 'turn.end'
  | 'tool.pre'
  | 'tool.post'
  | 'context.compact.start'
  | 'context.compact.end'
  // ── 新增 8 个 ──
  | 'session.start'
  | 'session.end'
  | 'model.beforeRequest'
  | 'model.afterResponse'
  | 'subagent.start'
  | 'subagent.end'
  | 'error.occurred'
  // ── 第 14 个：保留 ToolHook.onError 控制能力（禁令 14）──
  | 'tool.error';

/** 全部合法钩子事件名（供 validateManifest 枚举校验）。 */
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

/**
 * 插件清单 —— 声明式能力清单（禁令 15/16/17）。
 *
 * 设计原则：
 * - manifest 只声明"这个插件会注册哪些能力"，不声明实现细节
 * - 实际注册通过 activate(api) 命令式完成（HookAPI.observe/on/registerTool/registerMcpServer）
 * - PluginValidator 比对 activate 实际注册 vs manifest 声明清单，超出则拒绝
 *
 * handlerType 仅 sync/async（禁令 15/16/17 禁止 command/webhook）。
 * 剔除旧 contributes 双重声明（commands/events/renderers），改为 declaredHooks/
 * declaredTools/declaredMcpServers 能力清单。
 */
export interface PluginManifest {
  /** 插件唯一标识（npm scope 风格，如 @crish/my-plugin） */
  readonly id: string;

  /** 插件显示名称 */
  readonly name: string;

  /** 语义版本号（semver，如 "1.0.0"） */
  readonly version: string;

  /** 插件描述 */
  readonly description?: string;

  /** 入口点声明 */
  readonly entrypoints: PluginEntrypoints;

  /** 权限声明清单（restricted 级插件经 TrustGate 校验，禁令 18） */
  readonly permissions: readonly PluginPermission[];

  /** 信任级别（禁令 18：restricted | full，禁止 sandboxed） */
  readonly trustLevel: PluginTrustLevel;

  /** 引擎版本兼容约束（semver range，如 ">=0.2.0 <0.3.0"） */
  readonly engineVersion: PluginEngineConstraint;

  /** 声明将注册的钩子事件名清单（activate 中 api.on/observe 的事件必须在此清单内） */
  readonly declaredHooks: readonly HookEventName[];

  /** 声明将注册的工具名清单（activate 中 api.registerTool 的工具名必须在此清单内） */
  readonly declaredTools: readonly string[];

  /** 声明将注册的 MCP 服务器名清单（activate 中 api.registerMcpServer 的服务器名必须在此清单内） */
  readonly declaredMcpServers: readonly string[];

  /** 插件来源（由 PluginDiscoverer 填充，非作者手动声明） */
  readonly origin?: PluginOrigin;

  /** 作者元数据 */
  readonly author?: PluginAuthor;

  /** 关键词（用于发现与过滤） */
  readonly keywords?: readonly string[];

  /** 自定义元数据（不参与能力声明） */
  readonly metadata?: JsonObject;
}

/**
 * 入口点声明。
 *
 * main 为相对插件根目录的路径或绝对路径，
 * 动态 import 后须导出 activate(api) 函数（PluginLifecycle.activate）。
 */
export interface PluginEntrypoints {
  readonly main: string;
}

/** 作者元数据。 */
export interface PluginAuthor {
  readonly name: string;
  readonly email?: string;
  readonly url?: string;
}
