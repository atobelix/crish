/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * apps/crish-desktop/src/plugins/PluginRegistry.ts
 * Crish 插件注册中心与生命周期调度器 (DIM-06, RUL-06)。
 * - 统一插件注册、激活、注销管理
 * - 严格的 DisposableBag 资源绑定与释放
 * - IPC 权限白名单前置拦截
 * - 变更事件订阅与状态同步
 *
 * CI Guardrail: Business Logic (Max 400 lines of effective code, UTF-8 无 BOM)
 */

import {
  type CrishPlugin,
  type PluginRegistration,
  type PluginStatus,
  PluginContext,
} from './types';

export class PluginRegistry {
  private registrations = new Map<string, PluginRegistration>();
  private listeners = new Set<() => void>();
  private hostIpcHandler: (
    channel: string,
    payload?: unknown
  ) => Promise<unknown> = async () => ({});

  /**
   * 注入宿主 IPC 路由实现
   */
  public setHostIpc(
    handler: (channel: string, payload?: unknown) => Promise<unknown>
  ): void {
    this.hostIpcHandler = handler;
  }

  /**
   * 注册插件
   */
  public register(plugin: CrishPlugin): void {
    if (!plugin?.manifest?.id) {
      throw new Error(
        '[PluginRegistry] Plugin manifest must provide a valid id.'
      );
    }
    const id = plugin.manifest.id;
    if (this.registrations.has(id)) {
      console.warn(
        `[PluginRegistry] Plugin '${id}' is already registered. Updating registration.`
      );
    }

    this.registrations.set(id, {
      plugin,
      status: 'registered',
    });

    this.notifyListeners();
  }

  /**
   * 激活指定插件
   */
  public async activate(
    pluginId: string,
    customConfig?: Record<string, any>,
    runtime?: { isSubagent?: boolean; sessionId?: string }
  ): Promise<void> {
    const reg = this.registrations.get(pluginId);
    if (!reg) {
      throw new Error(`[PluginRegistry] Plugin '${pluginId}' not found.`);
    }

    if (reg.status === 'active' && reg.context) {
      return; // 已经激活
    }

    try {
      const context = new PluginContext(
        reg.plugin.manifest,
        customConfig ?? {},
        this.hostIpcHandler,
        runtime
      );

      await Promise.resolve(reg.plugin.activate(context));

      reg.status = 'active';
      reg.context = context;
      reg.error = undefined;
    } catch (err: any) {
      reg.status = 'error';
      reg.error = err?.message || String(err);
      console.error(
        `[PluginRegistry] Failed to activate plugin '${pluginId}':`,
        err
      );
      throw err;
    } finally {
      this.notifyListeners();
    }
  }

  /**
   * 停用指定插件，并 100% 释放其 DisposableBag 资源
   */
  public async deactivate(pluginId: string): Promise<void> {
    const reg = this.registrations.get(pluginId);
    if (!reg || reg.status !== 'active') {
      return;
    }

    try {
      if (reg.context) {
        if (typeof reg.plugin.deactivate === 'function') {
          await Promise.resolve(reg.plugin.deactivate(reg.context));
        }
        // 彻底释放注册的所有监听器、Timer 和 CDP 句柄
        await reg.context.subscriptions.dispose();
      }
      reg.status = 'inactive';
      reg.context = undefined;
      reg.error = undefined;
    } catch (err: any) {
      reg.status = 'error';
      reg.error = err?.message || String(err);
      console.error(
        `[PluginRegistry] Error during deactivating plugin '${pluginId}':`,
        err
      );
    } finally {
      this.notifyListeners();
    }
  }

  /**
   * 注销插件
   */
  public async unregister(pluginId: string): Promise<void> {
    const reg = this.registrations.get(pluginId);
    if (!reg) return;

    if (reg.status === 'active') {
      await this.deactivate(pluginId);
    }

    this.registrations.delete(pluginId);
    this.notifyListeners();
  }

  /**
   * 获取插件实例
   */
  public getPlugin(pluginId: string): CrishPlugin | undefined {
    return this.registrations.get(pluginId)?.plugin;
  }

  /**
   * 获取插件注册状态
   */
  public getRegistration(pluginId: string): PluginRegistration | undefined {
    return this.registrations.get(pluginId);
  }

  /**
   * 获取插件当前状态
   */
  public getPluginStatus(pluginId: string): PluginStatus {
    return this.registrations.get(pluginId)?.status ?? 'inactive';
  }

  /**
   * 获取所有注册的插件列表
   */
  public getAllPlugins(): CrishPlugin[] {
    return Array.from(this.registrations.values()).map((r) => r.plugin);
  }

  /**
   * 获取所有注册项信息
   */
  public getAllRegistrations(): PluginRegistration[] {
    return Array.from(this.registrations.values());
  }

  /**
   * 获取当前所有活跃的插件
   */
  public getActivePlugins(): CrishPlugin[] {
    return Array.from(this.registrations.values())
      .filter((r) => r.status === 'active')
      .map((r) => r.plugin);
  }

  /**
   * 检查插件是否处于活跃状态
   */
  public isPluginActive(pluginId: string): boolean {
    return this.registrations.get(pluginId)?.status === 'active';
  }

  /**
   * 获取活跃插件上下文
   */
  public getPluginContext(pluginId: string): PluginContext | undefined {
    return this.registrations.get(pluginId)?.context;
  }

  /**
   * 订阅插件注册与状态变更
   */
  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 清理与注销所有插件
   */
  public async clear(): Promise<void> {
    const ids = Array.from(this.registrations.keys());
    for (const id of ids) {
      await this.unregister(id);
    }
    this.registrations.clear();
    this.notifyListeners();
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        console.error('[PluginRegistry] Listener error:', err);
      }
    }
  }
}

/**
 * 全局单例插件注册中心
 */
export const pluginRegistry = new PluginRegistry();
