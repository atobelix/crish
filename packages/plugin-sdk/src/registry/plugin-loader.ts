// packages/plugin-sdk/src/registry/plugin-loader.ts
// 约束来源：ROUND-08-plugin-sdk.md §3.5 + 禁令 15/16/17（能力清单校验）+ 禁令 18（TrustGate）
//
// 迁移自 agent-runtime/src/plugin-fs-registry.ts 的加载逻辑（113 行安全门 + dynamic import）。
// 系统化改进：
// - 发现与加载职责分离（Discoverer 发现 manifest，Loader 负责动态 import + activate）
// - 通过 Proxy 包装 PluginAPI 收集注册项（供 Validator 后置比对）
// - activate 失败时安全回滚（调用 deactivate 清理已注册能力）
// - TrustGate 在 activate 前注册插件权限清单（restricted 级校验依赖此缓存）
// - 安全门 CRISH_ALLOW_UNSAFE_PLUGIN_IMPORT 保留（同进程 import 风险提示）

import type { PluginManifest } from '../manifest';
import type { PluginLifecycle, PluginModule } from '../hooks/lifecycle';
import type { HookAPI } from '../hooks/api';
import type { HookEventName } from '../hooks/types';
import type { PluginAPI } from '../api/plugin-api';
import type { PluginAPIDeps } from '../api/plugin-api';
import { PluginAPI as PluginAPIClass } from '../api/plugin-api';
import type { PluginValidator, RecordedRegistrations } from './plugin-validator';

/**
 * 插件加载器（禁令 15/16/17）。
 *
 * 职责：
 * 1. 动态 import entrypoints.main
 * 2. 在 TrustGate 注册插件权限清单（restricted 级校验依赖此缓存，禁令 18）
 * 3. 构造 PluginAPI（注入 hookBus/toolRegistry/mcpRegistrar/trustGate/logger）
 * 4. 通过 Proxy 包装 PluginAPI 收集注册项（供 PluginValidator 比对）
 * 5. 调用 activate(api)
 * 6. 经 PluginValidator 校验能力清单（禁令 15/16/17）
 *
 * 安全约束（对齐现有 plugin-fs-registry.ts）：
 * - 同进程 dynamic import 受 CRISH_ALLOW_UNSAFE_PLUGIN_IMPORT 环境变量门控
 * - 默认拒绝 import（仅注册 manifest，不执行代码）
 * - full 级别插件需用户显式授权（UI 二次确认，此处仅校验环境变量）
 */
export class PluginLoader {
  constructor(
    private readonly deps: PluginAPIDeps,
    private readonly validator: PluginValidator,
  ) {}

  /**
   * 加载并激活插件。
   *
   * 流程：
   * 1. 校验安全门（CRISH_ALLOW_UNSAFE_PLUGIN_IMPORT）
   * 2. 在 TrustGate 注册插件权限清单
   * 3. 动态 import 入口模块
   * 4. 解析 PluginLifecycle（default 导出或 activate 函数）
   * 5. 构造 PluginAPI + Proxy 包装（收集注册项）
   * 6. 调用 activate(proxiedApi)
   * 7. Validator 校验能力清单
   * 8. 校验失败时安全回滚（deactivate）
   *
   * @param manifest 插件清单
   * @param entryPath 入口绝对路径
   * @returns 激活后的 lifecycle + 记录的注册项 + PluginAPI 实例
   * @throws Error 当安全门未开启、import 失败、activate 抛错、或能力清单校验失败时
   */
  async load(
    manifest: PluginManifest,
    entryPath: string,
  ): Promise<PluginLoadResult> {
    // 1. 安全门：同进程 import 需显式开启（dev/spike only，非生产安全）
    const allowUnsafeImport = isUnsafeImportAllowed();
    if (!allowUnsafeImport) {
      throw new Error(
        `Plugin ${manifest.id}: same-process dynamic import is disabled. ` +
          `Set CRISH_ALLOW_UNSAFE_PLUGIN_IMPORT=1 to enable ` +
          `(dev/spike only, not production-safe).`,
      );
    }

    // 2. 在 TrustGate 注册插件权限清单（restricted 级校验依赖此缓存，禁令 18）
    this.deps.trustGate.registerPlugin(
      manifest.id,
      manifest.trustLevel,
      manifest.permissions,
    );

    // 3. 动态 import 入口模块
    const mod = (await import(entryPath)) as PluginModule;
    const lifecycle = this.resolveLifecycle(mod);
    if (!lifecycle) {
      throw new Error(
        `Plugin ${manifest.id}: entry module must export default PluginLifecycle ` +
          `or an activate function (got: ${Object.keys(mod).join(', ') || '(empty)'})`,
      );
    }

    // 4. 构造 PluginAPI + Proxy 包装（收集注册项供 Validator 后置比对）
    const recordings: MutableRecordedRegistrations = {
      hooks: [],
      tools: [],
      mcpServers: [],
    };
    const api = new PluginAPIClass(manifest, this.deps);
    const proxiedApi = this.wrapWithRecording(api, recordings);

    // 5. 调用 activate
    try {
      await lifecycle.activate(proxiedApi as HookAPI);
    } catch (err) {
      // activate 抛错：尝试回滚 + 注销 TrustGate 缓存
      await this.safeDeactivate(lifecycle);
      this.deps.trustGate.unregisterPlugin(manifest.id);
      throw new Error(
        `Plugin ${manifest.id}: activate() threw: ${(err as Error).message}`,
      );
    }

    // 6. 校验能力清单（禁令 15/16/17）
    const frozenRecordings: RecordedRegistrations = {
      hooks: recordings.hooks,
      tools: recordings.tools,
      mcpServers: recordings.mcpServers,
    };
    const validation = this.validator.validate(manifest, frozenRecordings);
    if (!validation.valid) {
      // 校验失败：回滚 + 注销 TrustGate 缓存
      await this.safeDeactivate(lifecycle);
      this.deps.trustGate.unregisterPlugin(manifest.id);
      throw new Error(
        `Plugin ${manifest.id}: capability validation failed: ` +
          validation.errors.map((e) => e.message).join('; '),
      );
    }

    return {
      lifecycle,
      recordings: frozenRecordings,
      api,
    };
  }

  /**
   * 从入口模块解析 PluginLifecycle。
   *
   * 支持两种导出方式：
   * 1. default 导出 PluginLifecycle 对象
   * 2. 具名导出 activate 函数（+ 可选 deactivate 函数）
   */
  private resolveLifecycle(mod: PluginModule): PluginLifecycle | undefined {
    if (mod.default) return mod.default;
    if (mod.activate) {
      // exactOptionalPropertyTypes: 不能直接赋值 undefined 给可选属性
      // 使用条件展开仅在 deactivate 存在时包含
      return {
        activate: mod.activate,
        ...(mod.deactivate ? { deactivate: mod.deactivate } : {}),
      };
    }
    return undefined;
  }

  /**
   * 通过 Proxy 包装 PluginAPI，拦截注册调用并记录。
   *
   * 系统化设计：
   * - Proxy 只拦截 observe/on/registerTool/registerMcpServer（需记录的注册方法）
   * - 其他属性访问（manifest/log/getSessionContext）直接透传
   * - 记录项供 PluginValidator 后置比对 manifest.declared* 清单
   *
   * 注意：返回类型为 HookAPI（通过 cast），因为 PluginAPI 的 manifest 类型
   * （8-A PluginManifest）与 HookAPI 声明的 manifest 类型（shared-types PluginManifest）
   * 结构不同。Proxy 在运行时透传 manifest 属性，类型层的不匹配不影响运行时正确性。
   */
  private wrapWithRecording(
    api: PluginAPIClass,
    recordings: MutableRecordedRegistrations,
  ): HookAPI {
    const handler: ProxyHandler<PluginAPIClass> = {
      get(target, prop: string | symbol) {
        const original = Reflect.get(target, prop, target);
        if (typeof original !== 'function') return original;

        if (prop === 'observe' || prop === 'on') {
          return (event: HookEventName, handler: unknown) => {
            recordings.hooks.push(event);
            return (original as (...args: unknown[]) => unknown).call(
              target,
              event,
              handler,
            );
          };
        }
        if (prop === 'registerTool') {
          return (definition: { name: string }, options?: unknown) => {
            recordings.tools.push(definition.name);
            return (original as (...args: unknown[]) => unknown).call(
              target,
              definition,
              options,
            );
          };
        }
        if (prop === 'registerMcpServer') {
          return (declaration: { name: string }) => {
            recordings.mcpServers.push(declaration.name);
            return (original as (...args: unknown[]) => unknown).call(
              target,
              declaration,
            );
          };
        }
        return original.bind(target);
      },
    };
    return new Proxy(api, handler) as unknown as HookAPI;
  }

  /**
   * 安全调用 deactivate（回滚已注册能力）。
   * 静默失败：回滚失败不阻塞错误上报（仅记录 warning）。
   */
  private async safeDeactivate(lifecycle: PluginLifecycle): Promise<void> {
    try {
      await lifecycle.deactivate?.();
    } catch (err) {
      console.warn(
        `[PluginLoader] safeDeactivate failed (non-blocking):`,
        (err as Error).message,
      );
    }
  }
}

/** 加载结果 */
export interface PluginLoadResult {
  /** 插件生命周期（含 deactivate 用于停用） */
  readonly lifecycle: PluginLifecycle;
  /** activate 期间通过 Proxy 收集的注册项 */
  readonly recordings: RecordedRegistrations;
  /** PluginAPI 实例（供 Registry 持有，用于后续 deactivate 时清理） */
  readonly api: PluginAPI;
}

/** 可变的注册记录（内部收集用，完成后冻结为 RecordedRegistrations） */
interface MutableRecordedRegistrations {
  hooks: HookEventName[];
  tools: string[];
  mcpServers: string[];
}

/**
 * 检查 CRISH_ALLOW_UNSAFE_PLUGIN_IMPORT 安全门是否开启。
 *
 * 对齐现有 plugin-fs-registry.ts 的环境变量检查逻辑。
 * 仅接受 '1' 或 'true'（大小写不敏感）。
 */
function isUnsafeImportAllowed(): boolean {
  const value = process.env.CRISH_ALLOW_UNSAFE_PLUGIN_IMPORT;
  return value === '1' || value === 'true';
}
