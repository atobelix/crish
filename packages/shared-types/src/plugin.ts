// packages/shared-types/src/plugin.ts
// 约束来源：ANTI_OVERENGINEERING_GUARDRAILS.md 禁令 13-19
// I8-E2：manifest 双轨收敛——本文件为跨端契约真源（03 生态插件方案 §3.4），
// plugin-sdk 的 PluginManifest 改为 re-export 本契约。

import type { HookEventName, HookFailStrategy } from './hooks';
import type { JsonObject } from './primitive-types';

/** 插件来源（禁令 17 精简为 2 种，npm/global-dir 推迟到 Phase 2） */
export type PluginOrigin = 'user-dir' | 'project-dir';

/** 信任级别（禁令 18 两级，禁止 sandboxed） */
export type PluginTrustLevel = 'restricted' | 'full';

/** 钩子处理器类型（禁令 16 仅 sync/async，禁止 command/webhook） */
export type HookHandlerType = 'sync' | 'async';

/**
 * 权限粒度（禁令 18 合并规则 + D6 笔记/View 轨增量 + M4 note:extend，共 15 项——与 plugin-sdk 运行时契约对齐；
 * I8-E2 收敛：以 plugin-sdk 的 PLUGIN_PERMISSIONS 为真源：
 * file:read+file:write→file:access，shell:execute→tool:execute，
 * tool:register 独立权限、hook observe/on 独立两权限等）
 */
export type PluginPermission =
  | 'file:access' // 文件读写（合并 file:read + file:write）
  | 'tool:execute' // 工具执行（含 shell，合并 shell:execute / subprocess.spawn）
  | 'tool:register' // 注册新工具
  | 'mcp:connect' // 连接 MCP 服务器
  | 'network:connect' // 网络出站连接
  | 'session:read' // 读取会话上下文（合并 system.info）
  | 'session:write' // 写入会话上下文（合并 env.write）
  | 'env:read' // 读取环境变量
  | 'hook:observe' // 注册 observe 处理器（只读容错，禁令 14）
  | 'hook:intercept' // 注册 on 处理器（可返回控制信号，禁令 14）
  | 'plugin:manage' // 管理其他插件（启用/禁用/卸载，合并 plugin.load）
  | 'ui:contribute' // View 轨 contribute points（slash/widget/blockView/keymap）
  | 'note:read' // 笔记只读（投影/查询；无写权威）
  | 'note:write' // 笔记写工具（仍走 RS 事务 + 审批；禁止 DOM/盘旁路）
  | 'note:extend'; // 扩展 known flavour（registerFlavour；投影-only，无写权威）

/** 入口点声明（main 为相对插件根目录路径；动态 import 后须导出 activate） */
export interface PluginEntrypoints {
  readonly main: string;
}

/** 作者元数据 */
export interface PluginAuthor {
  readonly name: string;
  readonly email?: string;
  readonly url?: string;
}

/**
 * 插件 manifest（禁令 15 声明式能力清单；I8-E2 双轨收敛合并版）。
 *
 * 设计原则：
 * - manifest 只声明"这个插件会注册哪些能力"，不声明实现细节
 * - 实际注册通过 activate(api) 命令式完成（HookAPI.observe/on/registerTool/registerMcpServer）
 * - PluginValidator 比对 activate 实际注册 vs manifest 声明清单，超出则拒绝
 *
 * 合并说明（03 §3.4 决策 1）：plugin-sdk 加载字段（description/entrypoints/
 * engineVersion/author/keywords/metadata）并入 shared-types 契约；
 * declaredHooks 收窄为 14 事件名联合；旧字段（origin/entry/declaredAgents/
 * minHostVersion）保留为可选——origin 由 PluginDiscoverer 填充、
 * entry 为 ROUND-08 遗留（加载以 entrypoints.main 为准）。
 */
export interface PluginManifest {
  /** 插件唯一 ID */
  readonly id: string;
  /** 展示名 */
  readonly name: string;
  /** 版本（semver） */
  readonly version: string;
  /** 插件描述 */
  readonly description?: string;
  /** 入口点声明（加载字段；相对插件根目录） */
  readonly entrypoints: PluginEntrypoints;
  /** 申请的权限清单（禁令 15） */
  readonly permissions: readonly PluginPermission[];
  /** 信任级别（禁令 18） */
  readonly trustLevel: PluginTrustLevel;
  /** 引擎版本兼容约束（semver range，如 ">=0.2.0 <0.3.0"） */
  readonly engineVersion: string;
  /** 声明注册的钩子事件名清单（禁令 15，14 事件名联合收窄） */
  readonly declaredHooks: readonly HookEventName[];
  /** 声明注册的工具名清单（禁令 15） */
  readonly declaredTools: readonly string[];
  /** 声明注册的 MCP 服务器名清单（禁令 15） */
  readonly declaredMcpServers: readonly string[];
  /** 来源（禁令 17；由 PluginDiscoverer 填充，非作者手动声明） */
  readonly origin?: PluginOrigin;
  /** 作者元数据 */
  readonly author?: PluginAuthor;
  /** 关键词（用于发现与过滤） */
  readonly keywords?: readonly string[];
  /** 自定义元数据（不参与能力声明） */
  readonly metadata?: JsonObject;
  /** 旧版入口模块路径（ROUND-08 遗留，与 entrypoints 二选一；加载以 entrypoints.main 为准） */
  readonly entry?: string;
  /** 声明提供的子代理定义 ID 清单（禁令 22） */
  readonly declaredAgents?: readonly string[];
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

/** 插件 MCP 服务器声明（骨架，Round 8 完整；MVP 仅 stdio，禁令 19） */
export interface PluginMcpDeclaration {
  readonly transport: 'stdio';
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * 插件 MCP 服务器声明（完整形态，plugin-sdk 消费面；与 PluginMcpDeclaration
 * 结构兼容并扩展 name/label/cwd/startupTimeoutMs——plugin-sdk 侧以本类型为准）
 */
export interface PluginMcpServerDeclaration {
  /** MCP 服务器名称（插件内唯一，对应 manifest.declaredMcpServers 项） */
  readonly name: string;
  /** 显示标签（可选，用于日志与诊断） */
  readonly label?: string;
  /** 传输方式（MVP 仅 'stdio'，禁令 19） */
  readonly transport: 'stdio';
  /** stdio 启动命令（如 'npx'、'node'、'python'） */
  readonly command: string;
  /** 命令行参数 */
  readonly args?: readonly string[];
  /** 环境变量注入（键值对，会与宿主环境变量合并） */
  readonly env?: Readonly<Record<string, string>>;
  /** 工作目录（可选，默认继承宿主 cwd） */
  readonly cwd?: string;
  /** 启动超时阈值（ms，可选，默认由 agent-mcp 接管） */
  readonly startupTimeoutMs?: number;
}

/** 已激活插件实例 */
export interface ActivatedPlugin {
  readonly manifest: PluginManifest;
  readonly activatedAt: number;
}

/** 会话上下文只读快照（api.getSessionContext() 返回） */
export interface SessionContextSnapshot {
  readonly sessionId: string;
  readonly runId: string;
  readonly cwd: string;
  readonly turnIndex: number;
  readonly messageCount: number;
  readonly recentMessageMeta: readonly unknown[];
}

/** 插件状态机（与 plugin-sdk registry/plugin-state.ts 同构；类型层契约） */
export type PluginState =
  'discovered' | 'loading' | 'loaded' | 'active' | 'inactive' | 'error';

/** 插件状态条目（类型层契约，供 agent-core 引用） */
export interface PluginStateEntryLike {
  readonly pluginId: string;
  readonly state: PluginState;
  readonly updatedAt: string;
  readonly error?: string;
}

/** 插件列表条目（类型层契约） */
export interface PluginListEntryLike {
  readonly pluginId: string;
  readonly state: PluginState;
  readonly error?: string;
}

/** 插件注册表契约（类型层，供 agent-core 引用；实现归属 plugin-sdk PluginRegistry） */
export interface PluginRegistryLike {
  readonly id: string;
  listPlugins(): readonly PluginListEntryLike[];
  getPluginState(pluginId: string): PluginStateEntryLike | undefined;
  deactivate(pluginId: string): Promise<boolean>;
}
