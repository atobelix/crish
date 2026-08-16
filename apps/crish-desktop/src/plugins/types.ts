/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * apps/crish-desktop/src/plugins/types.ts
 * Crish TypeScript 插件微内核基座契约与类型定义 (DIM-06, RUL-06)。
 * - 插件清单与元数据规范 (PluginManifest)
 * - DisposableBag 统一生命周期与资源回收机制 (Tab/插件销毁 100% 释放)
 * - 能力级权限白名单 (IPC Permission Tokens)
 * - 子 Agent 隔离与会话上下文契约 (SessionContext Guard)
 *
 * CI Guardrail: Types Contract (Max 800 lines of effective code, UTF-8 无 BOM)
 */

export type IDisposable = {
  dispose: () => void | Promise<void>;
};

export type DisposableFunction = () => void | Promise<void>;

/**
 * 生产级统一资源清理回收袋 (RUL-06, DIM-06)。
 * 保证插件销毁或 Tab 关闭时，所有 EventListener, Timer, Worker, CDP 句柄 100% 释放。
 */
export class DisposableBag implements IDisposable {
  private disposables = new Set<IDisposable | DisposableFunction>();
  private isDisposed = false;

  public add<T extends IDisposable | DisposableFunction>(item: T): T {
    if (this.isDisposed) {
      if (typeof item === 'function') {
        try {
          void item();
        } catch (err) {
          console.error('[DisposableBag] Error disposing item:', err);
        }
      } else if (item && typeof item.dispose === 'function') {
        try {
          void item.dispose();
        } catch (err) {
          console.error('[DisposableBag] Error disposing item:', err);
        }
      }
      return item;
    }
    this.disposables.add(item);
    return item;
  }

  public addEventListener(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ): () => void {
    target.addEventListener(type, listener, options);
    const unbind = () => target.removeEventListener(type, listener, options);
    this.add(unbind);
    return unbind;
  }

  public addTimeout(handler: () => void, timeoutMs: number): () => void {
    const timerId = setTimeout(handler, timeoutMs);
    const cancel = () => clearTimeout(timerId);
    this.add(cancel);
    return cancel;
  }

  public addInterval(handler: () => void, intervalMs: number): () => void {
    const timerId = setInterval(handler, intervalMs);
    const cancel = () => clearInterval(timerId);
    this.add(cancel);
    return cancel;
  }

  public async dispose(): Promise<void> {
    if (this.isDisposed) return;
    this.isDisposed = true;

    const items = Array.from(this.disposables);
    this.disposables.clear();

    for (const item of items) {
      try {
        if (typeof item === 'function') {
          await Promise.resolve(item());
        } else if (item && typeof item.dispose === 'function') {
          await Promise.resolve(item.dispose());
        }
      } catch (err) {
        console.error('[DisposableBag] Error during resource disposal:', err);
      }
    }
  }

  public get disposed(): boolean {
    return this.isDisposed;
  }
}

/**
 * 插件类别
 */
export type PluginCategory =
  'editor' | 'browser' | 'automation' | 'assistant' | 'tool' | 'other';

/**
 * 插件权限声明标识
 */
export type PluginPermission =
  | 'fs:access'
  | 'markdown:render'
  | 'browser:control'
  | 'network:access'
  | 'computer:control'
  | 'screen:capture'
  | 'assistant:suggestions'
  | string;

/**
 * 插件清单元数据 (PluginManifest)
 */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  permissions?: PluginPermission[];
  category?: PluginCategory;
  isOfficial?: boolean;
  enabledByDefault?: boolean;
  icon?: string;
}

/**
 * 插件运行上下文与安全屏障 (PluginContext)
 */
export class PluginContext<TConfig = Record<string, any>> {
  public readonly manifest: PluginManifest;
  public readonly config: TConfig;
  private readonly hostIpc: (
    channel: string,
    payload?: unknown
  ) => Promise<unknown>;
  public readonly runtime?: {
    isSubagent?: boolean;
    sessionId?: string;
  };
  public readonly subscriptions: DisposableBag;

  constructor(
    manifest: PluginManifest,
    config: TConfig,
    hostIpc: (channel: string, payload?: unknown) => Promise<unknown>,
    runtime?: {
      isSubagent?: boolean;
      sessionId?: string;
    }
  ) {
    this.manifest = manifest;
    this.config = config;
    this.hostIpc = hostIpc;
    this.runtime = runtime;
    this.subscriptions = new DisposableBag();
  }

  public get isSubagent(): boolean {
    return Boolean(this.runtime?.isSubagent);
  }

  public get sessionId(): string | undefined {
    return this.runtime?.sessionId;
  }

  /**
   * 能力级权限受控 IPC 调用
   */
  public async invokeIpc<TResult = unknown>(
    channel: string,
    payload?: unknown
  ): Promise<TResult> {
    const requiredPermission = this.resolveRequiredPermission(channel);
    const declaredPermissions = this.manifest.permissions ?? [];

    if (
      requiredPermission &&
      !declaredPermissions.includes(requiredPermission)
    ) {
      throw new Error(
        `[PluginSecurityError] Plugin '${this.manifest.id}' lacks permission '${requiredPermission}' to invoke '${channel}'`
      );
    }
    return (await this.hostIpc(channel, payload)) as TResult;
  }

  private resolveRequiredPermission(channel: string): string | null {
    if (channel.startsWith('fs:')) return 'fs:access';
    if (
      channel.startsWith('conex-markdown:') ||
      channel.startsWith('markdown:')
    )
      return 'markdown:render';
    if (channel.startsWith('browser:')) return 'browser:control';
    if (channel.startsWith('network:')) return 'network:access';
    if (channel.startsWith('computer:')) return 'computer:control';
    if (channel.startsWith('screen:')) return 'screen:capture';
    if (channel.startsWith('assistant:')) return 'assistant:suggestions';
    return null;
  }
}

/**
 * 插件生命周期与模块定义 (CrishPlugin)
 */
export interface CrishPlugin<TConfig = Record<string, any>> {
  manifest: PluginManifest;
  activate: (ctx: PluginContext<TConfig>) => void | Promise<void>;
  deactivate?: (ctx: PluginContext<TConfig>) => void | Promise<void>;
  renderView?: (props: any) => React.ReactNode;
  renderSettings?: (props: any) => React.ReactNode;
}

/**
 * 插件状态
 */
export type PluginStatus = 'registered' | 'active' | 'inactive' | 'error';

/**
 * 插件在注册表中的注册实例结构
 */
export interface PluginRegistration {
  plugin: CrishPlugin;
  status: PluginStatus;
  context?: PluginContext;
  error?: string;
}
