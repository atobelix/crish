// packages/shared-types/src/plugin.ts
// 约束来源：ANTI_OVERENGINEERING_GUARDRAILS.md 禁令 13-19

/** 插件来源（禁令 17 精简为 2 种，npm/global-dir 推迟到 Phase 2） */
export type PluginOrigin = 'user-dir' | 'project-dir';

/** 信任级别（禁令 18 两级，禁止 sandboxed） */
export type PluginTrustLevel = 'restricted' | 'full';

/** 钩子处理器类型（禁令 16 仅 sync/async，禁止 command/webhook） */
export type HookHandlerType = 'sync' | 'async';

/** 钩子失败策略 */
export type HookFailStrategy = 'swallow' | 'propagate' | 'log';

/** 权限粒度（禁令 18 合并：file:read+file:write→file:access，shell:execute→tool:execute） */
export type PluginPermission =
  | 'file:access'
  | 'tool:execute'
  | 'hook:observe'
  | 'hook:intercept'
  | 'mcp:register'
  | 'subagent:spawn';

/** 插件 manifest（禁令 15 声明式能力清单） */
export interface PluginManifest {
  /** 插件唯一 ID */
  readonly id: string;
  /** 展示名 */
  readonly name: string;
  /** 版本（semver） */
  readonly version: string;
  /** 来源（禁令 17） */
  readonly origin: PluginOrigin;
  /** 信任级别（禁令 18） */
  readonly trustLevel: PluginTrustLevel;
  /** 入口模块路径（相对插件根目录） */
  readonly entry: string;
  /** 声明注册的钩子事件名清单（禁令 15，实际注册通过 activate(api)） */
  readonly declaredHooks: readonly string[];
  /** 声明注册的工具名清单（禁令 15） */
  readonly declaredTools: readonly string[];
  /** 声明注册的 MCP 服务器名清单（禁令 15） */
  readonly declaredMcpServers: readonly string[];
  /** 声明提供的子代理定义 ID 清单（禁令 22） */
  readonly declaredAgents: readonly string[];
  /** 申请的权限清单（禁令 15） */
  readonly permissions: readonly PluginPermission[];
  /** 最低宿主版本（可选） */
  readonly minHostVersion?: string;
}

/** 插件激活上下文（activate(api) 的 api 参数，Round 8 完整实现） */
export interface PluginActivationApi {
  readonly pluginId: string;
  /** 注册钩子处理器（命令式，必须在 manifest.declaredHooks 内） */
  readonly on: (event: string, handler: PluginHookHandler) => void;
  readonly observe: (event: string, handler: PluginHookHandler) => void;
  /** 注册工具（命令式，必须在 manifest.declaredTools 内） */
  readonly registerTool: (tool: PluginToolDeclaration) => void;
  /** 注册 MCP 服务器（禁令 13，通过 agent-mcp 的 registerPluginServer 入口） */
  readonly registerMcpServer: (
    name: string,
    declaration: PluginMcpDeclaration
  ) => void;
}

/** 钩子处理器（observe/on 双模式，禁令 14） */
export interface PluginHookHandler {
  readonly handlerType: HookHandlerType;
  readonly failStrategy?: HookFailStrategy;
  readonly timeoutMs?: number;
  readonly fn: (payload: unknown) => unknown | Promise<unknown>;
}

/** 控制型钩子返回信号（禁令 14，on 模式） */
export type HookControlSignal =
  | { readonly type: 'continue' }
  | { readonly type: 'stop' }
  | { readonly type: 'block'; readonly reason: string }
  | { readonly type: 'modifiedInput'; readonly input: unknown }
  | { readonly type: 'modifiedOutput'; readonly output: unknown };

/** 插件工具声明（骨架，Round 8 完整） */
export interface PluginToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

/** 插件 MCP 服务器声明（骨架，Round 8 完整） */
export interface PluginMcpDeclaration {
  readonly transport: 'stdio';
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

/** 已激活插件实例 */
export interface ActivatedPlugin {
  readonly manifest: PluginManifest;
  readonly activatedAt: number;
}
