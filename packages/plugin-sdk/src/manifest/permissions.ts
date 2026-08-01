// packages/plugin-sdk/src/manifest/permissions.ts
// 约束来源：ROUND-08-plugin-sdk.md 禁令 18（信任模型 + 权限合并规则）

/**
 * 插件权限粒度联合类型（禁令 18 合并规则，共 11 项）。
 *
 * 合并规则（原始能力 → 合并后权限）：
 * - file:read + file:write            → file:access      （文件读写通常成对出现）
 * - shell:execute                     → tool:execute     （shell 是 tool 的子集）
 * - mcp.server                         → mcp:connect      （MCP 服务器连接）
 * - network.fetch                      → network:connect   （网络出站连接）
 * - env.read                           → env:read          （环境变量读取）
 * - env.write                          → session:write     （写入会话上下文/环境）
 * - subprocess.spawn                   → tool:execute      （子进程归入工具执行）
 * - plugin.load                        → plugin:manage     （插件生命周期管理）
 * - system.info                        → session:read      （系统信息归入会话只读）
 * - hook observe/on 独立两权限（observe 只读容错，intercept 可返回控制信号）
 * - tool:register                      → tool:register     （注册新工具，独立权限）
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
  | 'plugin:manage'; // 管理其他插件（启用/禁用/卸载，合并 plugin.load）

/** 全部合法权限字面量（供 validateManifest 枚举校验）。 */
export const PLUGIN_PERMISSIONS: readonly PluginPermission[] = [
  'file:access',
  'tool:execute',
  'tool:register',
  'mcp:connect',
  'network:connect',
  'session:read',
  'session:write',
  'env:read',
  'hook:observe',
  'hook:intercept',
  'plugin:manage',
] as const;

/**
 * 插件信任级别（禁令 18：2 级，禁止 sandboxed）。
 *
 * - restricted：主线程执行 + 权限白名单校验（TrustGate.assertPermission 强制校验）
 * - full：主线程执行 + 无校验（用户显式授权，仅 user-dir 来源可声明）
 *
 * 禁止 sandboxed：无 worker_threads 隔离方案时不允许该级别（禁令 18）。
 * full 级别仅允许 user-dir 来源（project-dir 插件不得声明 full，防仓库投毒）。
 */
export type PluginTrustLevel = 'restricted' | 'full';

/** 全部合法信任级别（供 validateManifest 枚举校验）。 */
export const PLUGIN_TRUST_LEVELS: readonly PluginTrustLevel[] = [
  'restricted',
  'full',
] as const;

/**
 * 插件来源（禁令 15/16/17：仅 user-dir + project-dir）。
 *
 * 禁止来源：mcp / github / inline（禁令 15/16/17）。
 * 推迟到 Phase 2：npm / global-dir。
 */
export type PluginOrigin = 'user-dir' | 'project-dir';

/** 全部合法来源（供 validateManifest 枚举校验）。 */
export const PLUGIN_ORIGINS: readonly PluginOrigin[] = [
  'user-dir',
  'project-dir',
] as const;
