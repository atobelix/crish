// packages/plugin-sdk/src/manifest/trust-gate.ts
// 约束来源：ROUND-08-plugin-sdk.md 禁令 18（TrustGate 归 agent-permissions，plugin-sdk 仅声明契约）

import type {
  PluginPermission,
  PluginTrustLevel,
} from './permissions';

/**
 * TrustGate 契约接口（禁令 18）。
 *
 * 实现归属：agent-permissions 包（Round 3 创建）在 src/trust-gate.ts 中
 * 导出 createTrustGate() 工厂函数，内部基于 manifest.permissions 白名单 +
 * trustLevel 判定。该实现复用现有 trust-zone-policy.ts 的 TrustZonePermissionPolicy
 * 模式（T0-T4 信任区矩阵），将插件权限校验统一到 agent-permissions。
 *
 * plugin-sdk 不直接 import agent-permissions（避免运行时依赖与循环边），
 * 而是通过 PluginAPIDeps.trustGate 接收已构造的实例（依赖注入）。
 *
 * 信任级别语义（禁令 18）：
 * - restricted：主线程执行 + 权限白名单校验（assertPermission 强制校验）
 * - full：主线程执行 + 无校验（用户显式授权，仅 user-dir 来源可声明）
 *
 * 禁止 sandboxed 级别（禁令 18：无 worker_threads 隔离方案时禁止）。
 */
export interface TrustGateLike {
  /**
   * 校验插件是否拥有指定权限，无权限时抛错。
   *
   * - full 级别：直接通过（无校验）
   * - restricted 级别：检查 manifest.permissions 白名单
   *
   * @throws Error 无权限时抛出（含 pluginId + permission 信息）
   */
  assertPermission(pluginId: string, permission: PluginPermission): void;

  /**
   * 查询插件权限决策（不抛错）。
   *
   * - full 级别：始终返回 'allow'
   * - restricted 级别：permissions 白名单含则 allow，否则 deny
   */
  decide(
    pluginId: string,
    permission: PluginPermission,
  ): 'allow' | 'deny';

  /**
   * 注册插件的权限清单（在 PluginLoader.load 阶段调用）。
   * TrustGate 内部缓存 pluginId -> (trustLevel, permissions) 映射。
   */
  registerPlugin(
    pluginId: string,
    trustLevel: PluginTrustLevel,
    permissions: readonly PluginPermission[],
  ): void;

  /** 注销插件（在 deactivate 阶段调用，清理内部缓存）。 */
  unregisterPlugin(pluginId: string): void;
}

/**
 * TrustGate 实现的获取入口（工厂类型契约）。
 *
 * agent-permissions 包导出 createTrustGate(): TrustGateLike 工厂函数，
 * agent-core 初始化时创建实例并注入 PluginAPIDeps.trustGate。
 *
 * plugin-sdk 不直接 import agent-permissions（避免运行时依赖），
 * 而是通过 PluginAPIDeps.trustGate 接收已构造的实例。
 */
export type TrustGateFactory = () => TrustGateLike;
