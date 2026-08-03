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

// ─── 路径逃逸校验（kimi manifest.ts:162-225 移植，ref-analysis 03 Top 4）───

/** 路径逃逸校验结果（纯函数，不抛错）。 */
export interface PathEscapeValidationResult {
  readonly ok: boolean;
  readonly error?: string;
}

/**
 * 校验插件相对路径不逃逸插件目录（kimi 路径逃逸校验移植）。
 *
 * 规则（对齐 kimi manifest.ts:162-225）：
 * 1. 禁止绝对路径（POSIX '/' 前缀 / Windows 盘符 'C:\' 前缀）；
 * 2. 规范化（解析 '.' / '..' 段）后目标必须仍位于插件目录内；
 * 3. 推荐 './' 前缀（相对路径显式化）；无前缀的相对路径也接受。
 *
 * 纯函数实现（不做真实 realpath——webview 无 node:fs；宿主侧若需
 * 软链接穿透校验，在 fs 适配层以 realpath 后复用本函数）。
 *
 * @param pluginDir 插件目录（绝对路径，如 /work/.crish/plugins/my-plugin）
 * @param relativePath 插件声明的相对路径（entrypoints.main / skills 目录 /
 *   mcp cwd 等）
 * @param field 字段名（诊断文案用，如 'entrypoints.main'）
 */
export function assertPathWithinPluginDir(
  pluginDir: string,
  relativePath: string,
  field: string,
): PathEscapeValidationResult {
  if (isAbsolutePath(relativePath)) {
    return {
      ok: false,
      error: `${field} 必须为相对路径（禁止绝对路径）：${relativePath}`,
    };
  }
  const root = normalizePath(pluginDir);
  const target = normalizePath(joinWithin(pluginDir, relativePath));
  if (!isWithin(root, target)) {
    return {
      ok: false,
      error: `${field} 逃逸插件目录（../ 或绝对跳转被拒绝）：${relativePath}`,
    };
  }
  return { ok: true };
}

/**
 * 校验 MCP 服务器声明的 cwd 不逃逸插件目录（kimi mcp cwd 校验移植）。
 * cwd 为相对路径时必须位于插件目录内；cwd 缺省（继承宿主）时放行。
 */
export function assertMcpCwdWithinPluginDir(
  pluginDir: string,
  cwd: string | undefined,
  serverName: string,
): PathEscapeValidationResult {
  if (cwd === undefined || cwd === '') {
    return { ok: true };
  }
  return assertPathWithinPluginDir(pluginDir, cwd, `mcpServer(${serverName}).cwd`);
}

/** 判定绝对路径（POSIX '/' 前缀 / Windows 盘符 'C:\' / UNC） */
function isAbsolutePath(path: string): boolean {
  if (path.startsWith('/') || path.startsWith('\\')) return true;
  return /^[a-zA-Z]:[\\/]/.test(path);
}

/** 把相对路径拼接到基目录（不解析，纯拼接——解析在 normalize 内） */
function joinWithin(base: string, relative: string): string {
  if (base.endsWith('/') || base.endsWith('\\')) {
    return base + relative;
  }
  return `${base}/${relative}`;
}

/** 规范化路径：统一 '/' 分隔、解析 '.' / '..' 段（纯字符串，无 fs 依赖） */
function normalizePath(path: string): string {
  const segments = path.split(/[\\/]+/).filter((s) => s.length > 0);
  const stack: string[] = [];
  for (const seg of segments) {
    if (seg === '.') continue;
    if (seg === '..') {
      stack.pop();
      continue;
    }
    stack.push(seg);
  }
  const normalized = stack.join('/');
  return normalized.startsWith('/') ? `/${normalized}` : normalized;
}

/** 判定 target 位于 root 内（root 自身或其后代） */
function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}/`);
}
