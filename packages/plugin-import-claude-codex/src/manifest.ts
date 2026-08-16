/**
 * 官方导入插件 manifest（E3 首个官方插件试点）。
 *
 * 契约：PluginManifest 由 @crish/shared-types 提供（I8-E2 跨端真源）。
 * 本文件自包含结构契约由 __tests__/manifest.test.ts 以类型断言锁定——
 * manifest 须可赋给 shared-types 的 PluginManifest。
 */

import type { HookEventName, PluginPermission } from '@crish/shared-types';
import type { ImportSource } from './types';

/** 插件唯一标识（manifest id）。 */
export const PLUGIN_ID = '@crish/import-claude-codex';

/** 工具名常量（declaredTools 与执行体共用，防双写漂移）。 */
export const TOOL_PARSE_CLAUDE_CODE = 'parse-claude-code-jsonl';
export const TOOL_PARSE_CODEX_ROLLOUT = 'parse-codex-rollout-jsonl';

/** 本地 JsonObject 结构类型（与 shared-types JsonObject 结构一致，避免运行时依赖）。 */
type PluginJsonValue =
  | string
  | number
  | boolean
  | null
  | PluginJsonValue[]
  | { [key: string]: PluginJsonValue };
interface PluginJsonObject {
  [key: string]: PluginJsonValue;
}

/**
 * 插件清单（结构契约，字段对齐 shared-types PluginManifest）。
 */
export interface ImportPluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly entrypoints: { readonly main: string };
  readonly permissions: readonly PluginPermission[];
  readonly trustLevel: 'restricted' | 'full';
  readonly engineVersion: string;
  readonly declaredHooks: readonly HookEventName[];
  readonly declaredTools: readonly string[];
  readonly declaredMcpServers: readonly string[];
  readonly author?: {
    readonly name: string;
    readonly email?: string;
    readonly url?: string;
  };
  readonly keywords?: readonly string[];
  readonly metadata?: PluginJsonObject;
}

/**
 * 官方导入插件 manifest（内置分发，trustLevel=full）。
 * - declaredTools：两个只读纯函数工具（入参内容字符串 + 选项，出参中立载荷）
 * - declaredHooks：session.start（observe，注入使用说明的语义占位——
 *   kimi-datasource 的 SKILL.md 语义：教会模型如何调用导入工具；
 *   第一代插件不做 UI 回调，使用说明落在 README 与 observe 日志）
 * - permissions 最小面：hook:observe + tool:execute
 */
export const manifest: ImportPluginManifest = {
  id: PLUGIN_ID,
  name: 'Claude/Codex 对话导入',
  version: '1.0.0',
  description:
    '解析 Claude Code / Codex CLI 会话 JSONL 并映射为可导入的 Crish 会话载荷（只读纯函数工具）',
  entrypoints: { main: './src/index.ts' },
  permissions: ['hook:observe', 'tool:execute'],
  trustLevel: 'full',
  engineVersion: '>=0.2.0',
  declaredHooks: ['session.start'],
  declaredTools: [TOOL_PARSE_CLAUDE_CODE, TOOL_PARSE_CODEX_ROLLOUT],
  declaredMcpServers: [],
  author: { name: 'Crish Team' },
  keywords: ['import', 'claude-code', 'codex', 'transcript', 'official'],
  metadata: {
    sources: ['claude-code', 'codex'] as ImportSource[],
    payloadContract: 'SessionImportPayload',
  },
};

/** 插件入口附带的能力描述（供宿主展示 manifest 元数据）。 */
export type ImportPluginToolDeclaration = {
  readonly name: string;
  readonly description: string;
  readonly outputType: 'ParsedExternalConversation' | 'SessionImportPayload';
};

export const declaredToolsInfo: readonly ImportPluginToolDeclaration[] = [
  {
    name: TOOL_PARSE_CLAUDE_CODE,
    description: '解析 Claude Code 会话 JSONL 内容，输出规范化会话载荷',
    outputType: 'SessionImportPayload',
  },
  {
    name: TOOL_PARSE_CODEX_ROLLOUT,
    description: '解析 Codex CLI rollout JSONL 内容，输出规范化会话载荷',
    outputType: 'SessionImportPayload',
  },
];
