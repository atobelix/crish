// packages/plugin-sdk/src/api/plugin-api.ts
// 约束来源：ROUND-08-plugin-sdk.md §3.4（PluginAPI 类本体）
//
// 系统化设计：
// - PluginAPI 是 activate(api) 中 api 参数的具体实现，组合 8-B 的 HookAPI 接口 + 8-C 的 ToolRegistrar
// - 能力清单校验（assertCapability）在注册前拦截，不依赖 Loader 的 Proxy 后置校验
// - 权限校验（assertPermission）委托 TrustGate（禁令 18），full 级别跳过
// - 依赖全部通过 PluginAPIDeps 注入，不直接 import agent-core/agent-tools/agent-mcp（解循环依赖 禁令 13）

import type {
  HookEventName,
  HookObserveHandler,
  HookOnHandler,
  HookUnsubscribe,
} from '../hooks/types';
import type {
  ToolDefinition,
  ToolRegistrationOptions,
  RegisteredTool,
} from '../tools';
import type {
  PluginMcpServerDeclaration,
  McpRegistrar,
  ToolRegistrar,
} from '../tools';
import type {
  PluginManifest,
  PluginPermission,
} from '../manifest';
import type { TrustGateLike } from '../manifest';
import type {
  JsonObject,
  HookBusLike,
  SessionContextSnapshot,
} from '@crish/shared-types';

/**
 * PluginAPI 实现：聚合 HookAPI 能力 + 能力清单校验 + 委托注入。
 *
 * 注意：不使用 `implements HookAPI` 显式声明，因为 8-A 的 PluginManifest
 * （../manifest，含 entrypoints/engineVersion/declaredHooks 等）与
 * shared-types 的 PluginManifest（含 entry/declaredAgents 等）结构不同。
 * PluginAPI 在方法层面结构兼容 HookAPI（observe/on/registerTool/registerMcpServer/log
 * /getSessionContext 签名一致），Loader 通过 Proxy 包装后传递给 activate(api)。
 * 此处的类型不匹配是 8-A/8-B 并行开发的已知协调点，MVP 阶段以结构兼容性保证运行时正确。
 *
 * 由 PluginLoader 在 activate 阶段构造，注入：
 * - hookBus：agent-core 的 LifecycleHookRegistry 实例（派发器，禁令 13）
 * - toolRegistry：agent-tools 的 ToolRegistry 实例（满足 ToolRegistrar 契约）
 * - mcpRegistrar：agent-mcp 的 registerPluginServer 函数（禁令 13）
 * - trustGate：agent-permissions 的 TrustGate 实例（权限校验，禁令 18）
 * - logger：日志实例（带 pluginId tag）
 *
 * 所有注册操作先经能力清单校验（declaredHooks/declaredTools/declaredMcpServers），
 * 再经 TrustGate 权限校验（restricted 级），最后委托注入的 registry。
 *
 * 双重校验设计（系统化）：
 * 1. 前置校验（assertCapability/assertPermission）：在注册调用时即时拦截
 * 2. 后置校验（PluginValidator.validate）：Loader 在 activate 完成后比对全量注册项
 * 前置校验快速失败（单个注册项不合法即抛错），后置校验提供完整诊断（全部不合法项）。
 */
export class PluginAPI {
  constructor(
    private readonly _manifest: PluginManifest,
    private readonly deps: PluginAPIDeps,
  ) {}

  /** 当前插件的 manifest（只读，供 activate 内部决策） */
  get manifest(): PluginManifest {
    return this._manifest;
  }

  /**
   * 注册 observe 处理器（容错并行，失败吞掉 禁令 14）。
   * 需 manifest.permissions 含 'hook:observe'。
   * 需 manifest.declaredHooks 含 event。
   */
  observe<E extends HookEventName>(
    event: E,
    handler: HookObserveHandler<E>,
  ): HookUnsubscribe {
    this.assertCapability('declaredHooks', event);
    this.assertPermission('hook:observe');
    return this.deps.hookBus.observe(event, handler);
  }

  /**
   * 注册 on 处理器（串行语义合并，可返回控制信号 禁令 14）。
   * 需 manifest.permissions 含 'hook:intercept'。
   * 需 manifest.declaredHooks 含 event。
   */
  on<E extends HookEventName>(
    event: E,
    handler: HookOnHandler<E>,
  ): HookUnsubscribe {
    this.assertCapability('declaredHooks', event);
    this.assertPermission('hook:intercept');
    return this.deps.hookBus.on(event, handler);
  }

  /**
   * 注册自定义工具（禁令 15/16/17 命令式）。
   * 需 manifest.permissions 含 'tool:register'。
   * 需 manifest.declaredTools 含 definition.name。
   */
  registerTool(
    definition: ToolDefinition,
    options?: ToolRegistrationOptions,
  ): RegisteredTool {
    this.assertCapability('declaredTools', definition.name);
    this.assertPermission('tool:register');
    return this.deps.toolRegistry.register(definition, options);
  }

  /**
   * 声明 MCP 服务器（委托 agent-mcp 的 registerPluginServer 禁令 13）。
   * 需 manifest.permissions 含 'mcp:connect'。
   * 需 manifest.declaredMcpServers 含 declaration.name。
   * MVP 禁止 OAuth（禁令 19），仅支持 stdio 本地进程。
   */
  registerMcpServer(declaration: PluginMcpServerDeclaration): void {
    this.assertCapability('declaredMcpServers', declaration.name);
    this.assertPermission('mcp:connect');
    this.deps.mcpRegistrar(this._manifest.id, declaration);
  }

  /**
   * 读取会话上下文（需 'session:read' 权限）。
   * 返回当前会话的只读快照。
   */
  getSessionContext(): SessionContextSnapshot {
    this.assertPermission('session:read');
    return this.deps.sessionContextProvider();
  }

  /**
   * 记录插件自定义日志（委托注入的 logger，自动带 pluginId tag）。
   */
  log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    metadata?: JsonObject,
  ): void {
    this.deps.logger.log(
      level,
      `[plugin:${this._manifest.id}] ${message}`,
      metadata,
    );
  }

  // ─── 内部校验方法 ───

  /**
   * 能力清单校验：注册的项必须在 manifest 声明清单内（禁令 15/16/17）。
   * @throws Error 当注册项不在声明清单内时
   */
  private assertCapability(
    field: 'declaredHooks' | 'declaredTools' | 'declaredMcpServers',
    value: string,
  ): void {
    const declared = this._manifest[field] as readonly string[];
    if (!declared.includes(value)) {
      throw new Error(
        `Plugin ${this._manifest.id}: attempted to register ${field
          .replace('declared', '')
          .toLowerCase()} '${value}' not declared in manifest ` +
          `(declared: [${declared.join(', ')}])`,
      );
    }
  }

  /**
   * 权限校验：检查 manifest.permissions 是否含指定权限。
   *
   * 禁令 18 信任模型：
   * - full 级别：跳过校验（用户显式授权）
   * - restricted 级别：委托 TrustGate.assertPermission 强制校验
   *
   * @throws Error 当 restricted 级别插件缺少所需权限时
   */
  private assertPermission(permission: PluginPermission): void {
    if (this._manifest.trustLevel === 'full') return;
    this.deps.trustGate.assertPermission(this._manifest.id, permission);
  }
}

/**
 * PluginAPI 依赖注入接口（由 PluginLoader 构造时传入）。
 *
 * 系统化设计：所有外部依赖通过此接口注入，PluginAPI 不直接 import
 * agent-core / agent-tools / agent-mcp（禁令 13 解循环依赖）。
 */
export interface PluginAPIDeps {
  /** agent-core 的 LifecycleHookRegistry 实例（派发器，禁令 13） */
  readonly hookBus: HookBusLike;
  /** agent-tools 的 ToolRegistry 实例（满足 ToolRegistrar 契约） */
  readonly toolRegistry: ToolRegistrar;
  /** agent-mcp 的 registerPluginServer 函数（禁令 13 委托） */
  readonly mcpRegistrar: McpRegistrar;
  /** agent-permissions 的 TrustGate 实例（禁令 18 权限校验） */
  readonly trustGate: TrustGateLike;
  /** @crish/logger 实例（带 pluginId tag） */
  readonly logger: PluginLoggerLike;
  /** 会话上下文快照提供者（供 api.getSessionContext() 调用） */
  readonly sessionContextProvider: () => SessionContextSnapshot;
}

/** PluginLogger 契约（@crish/logger 实现此接口） */
export interface PluginLoggerLike {
  log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    metadata?: JsonObject,
  ): void;
}
