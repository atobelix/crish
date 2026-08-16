// packages/shared-types/src/plugin.ts
// 约束来源：ANTI_OVERENGINEERING_GUARDRAILS.md 禁令 13-19
// I8-E2：manifest 双轨收敛——本文件为跨端契约真源，插件包类型消费经此处。

import type { HookEventName } from './hooks';
import type { JsonObject } from './primitive-types';

/** 插件来源（禁令 17 精简为 2 种，npm/global-dir 推迟到 Phase 2） */
export type PluginOrigin = 'user-dir' | 'project-dir';

/** 信任级别（禁令 18 两级，禁止 sandboxed） */
export type PluginTrustLevel = 'restricted' | 'full';

/**
 * 权限粒度（禁令 18 合并规则 + D6 笔记/View 轨增量 + M4 note:extend，共 15 项）。
 * file:read+file:write→file:access，shell:execute→tool:execute，
 * tool:register 独立权限、hook observe/on 独立两权限等。
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
  | 'note:extend'; // 扩展 known flavour（投影-only，无写权威）

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
 * 合并说明（03 §3.4 决策 1）：加载字段（description/entrypoints/
 * engineVersion/author/keywords/metadata）并入跨端契约；
 * declaredHooks 收窄为 14 事件名联合；旧字段（origin/entry/declaredAgents/
 * minHostVersion）保留为可选——origin 由 PluginDiscoverer 填充、
 * entry 为历史遗留（加载以 entrypoints.main 为准）。
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
  /** 旧版入口模块路径（历史遗留，与 entrypoints 二选一；加载以 entrypoints.main 为准） */
  readonly entry?: string;
  /** 声明提供的子代理定义 ID 清单（禁令 22） */
  readonly declaredAgents?: readonly string[];
  /** 最低宿主版本（可选） */
  readonly minHostVersion?: string;
}
