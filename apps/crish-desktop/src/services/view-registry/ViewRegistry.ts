import type React from 'react';
import type {
  ViewDefinition,
  ViewRenderContext,
  ViewUriResolver,
} from './ViewTypes';
import { slotCore } from './SlotCore';

class ViewRegistryImpl {
  private views = new Map<string, ViewDefinition>();
  private uriResolvers: ViewUriResolver[] = [];
  private slotUnsubscribers = new Map<string, () => void>();
  private listeners = new Set<() => void>();
  private version = 0;

  constructor() {
    this.initDefaultResolvers();
  }

  /** 初始化核心内置 URI 解析器（保持不可变受保护基线） */
  private initDefaultResolvers(): void {
    this.uriResolvers = [
      {
        prefix: 'file-viewer:',
        resolve: (uri) => {
          const raw = uri.substring('file-viewer:'.length);
          const hashIdx = raw.indexOf('#');
          const noHash = hashIdx >= 0 ? raw.substring(0, hashIdx) : raw;
          const hashStr = hashIdx >= 0 ? raw.substring(hashIdx + 1) : '';
          const qIdx = noHash.indexOf('?');
          const rawPath = qIdx >= 0 ? noHash.substring(0, qIdx) : noHash;
          const queryStr = qIdx >= 0 ? noHash.substring(qIdx + 1) : '';
          let filePath = rawPath;
          try {
            filePath = decodeURIComponent(rawPath);
          } catch {
            filePath = rawPath;
          }
          const searchParams = new URLSearchParams(queryStr);
          const modeParam = searchParams.get('mode') || searchParams.get('initialMode');
          const initialMode = modeParam === 'diff' ? 'diff' : 'plain';
          let line: number | undefined;
          const lineStr = searchParams.get('line');
          if (lineStr) {
            line = parseInt(lineStr, 10);
          } else if (hashStr) {
            const m = hashStr.match(/^L?(\d+)/i);
            if (m && m[1]) {
              line = parseInt(m[1], 10);
            }
          }
          return {
            viewId: 'file-viewer',
            params: {
              filePath,
              initialMode,
              line,
            },
          };
        },
      },
      {
        prefix: 'preview:',
        resolve: (uri) => {
          const raw = uri.substring('preview:'.length);
          return {
            viewId: 'preview',
            params: {
              target: raw,
              instanceId: uri,
            },
          };
        },
      },
      {
        prefix: 'browser:',
        resolve: (uri) => {
          const raw = uri.substring('browser:'.length);
          return {
            viewId: 'preview',
            params: {
              target: raw,
              instanceId: uri,
            },
          };
        },
      },
      {
        prefix: 'terminal:',
        resolve: (uri) => {
          const raw = uri.substring('terminal:'.length);
          return {
            viewId: 'terminal',
            params: {
              instanceId: uri,
              index: raw,
            },
          };
        },
      },
    ];
  }

  /** 注册视图定义，返回注销函数 */
  public registerView(view: ViewDefinition): () => void {
    const prevUnsub = this.slotUnsubscribers.get(view.id);
    if (prevUnsub) {
      prevUnsub();
      this.slotUnsubscribers.delete(view.id);
    }

    this.views.set(view.id, view);
    this.version++;

    // 自动向 slotCore 注册 'workspace.leaf.panel' keyed 插槽
    const unregisterSlot = slotCore.registerKeyed('workspace.leaf.panel', {
      id: view.id,
      key: view.id,
      component: view.component,
    });
    this.slotUnsubscribers.set(view.id, unregisterSlot);

    this.notify();
    return () => {
      const unsub = this.slotUnsubscribers.get(view.id);
      if (unsub) {
        unsub();
        this.slotUnsubscribers.delete(view.id);
      }
      this.views.delete(view.id);
      this.version++;
      this.notify();
    };
  }

  /** 注册 URI 路由解析器 */
  public registerUriResolver(resolver: ViewUriResolver): () => void {
    this.uriResolvers.push(resolver);
    this.version++;
    this.notify();
    return () => {
      this.uriResolvers = this.uriResolvers.filter((r) => r !== resolver);
      this.version++;
      this.notify();
    };
  }

  /** 解析视图 ID 或 URI，返回视图定义与动态参数 */
  public resolveView(rawId: string): {
    definition?: ViewDefinition;
    params?: Record<string, unknown>;
  } {
    if (!rawId) return {};

    // 1. 精确键值匹配
    if (this.views.has(rawId)) {
      return { definition: this.views.get(rawId) };
    }

    // 2. 动态 URI 解析器前缀匹配
    for (const resolver of this.uriResolvers) {
      if (rawId.startsWith(resolver.prefix)) {
        const resolved = resolver.resolve(rawId);
        if (resolved) {
          return {
            definition: this.views.get(resolved.viewId),
            params: resolved.params,
          };
        }
      }
    }

    return {};
  }

  /** 获取纯定义 */
  public getView(id: string): ViewDefinition | undefined {
    return this.resolveView(id).definition;
  }

  /** 获取视图图标 */
  public getIcon(
    id: string
  ):
    | React.ComponentType<{
        size?: number;
        className?: string;
        strokeWidth?: number;
      }>
    | undefined {
    return this.resolveView(id).definition?.icon;
  }

  /** 统一获取视图展示标题（支持 Thunk 与参数解析） */
  public getTitle(id: string, ctx?: ViewRenderContext): string {
    if (!id) return '';
    const { definition, params } = this.resolveView(id);
    if (!definition) {
      if (ctx?.fallbackTitle) {
        return ctx.fallbackTitle;
      }
      if (id.includes(':') || id.includes('/')) {
        const cleanId = id.split('?')[0] || id;
        const segments = cleanId.split(/[:/]/).filter(Boolean);
        return segments[segments.length - 1] || id;
      }
      return id;
    }
    if (typeof definition.title === 'function') {
      const fallbackCtx: ViewRenderContext = ctx ?? {
        panelId: id,
        leafId: '',
        isActive: false,
        openView: () => {},
        params,
      };
      return definition.title(fallbackCtx);
    }
    if (id.startsWith('preview:') || id.startsWith('browser:')) {
      const prefix = id.startsWith('preview:') ? 'preview:' : 'browser:';
      const suffix = id.slice(prefix.length);
      if (/^\d+$/.test(suffix)) {
        return `${definition.title} ${suffix}`;
      }
      return `${definition.title} (${suffix})`;
    }
    if (id.startsWith('terminal:')) {
      const suffix = id.slice('terminal:'.length);
      if (/^\d+$/.test(suffix)) {
        return `${definition.title} ${suffix}`;
      }
      return `${definition.title} (${suffix})`;
    }
    return definition.title;
  }

  /** 获取指定分类的视图列表 */
  public getAllViews(category?: ViewDefinition['category']): ViewDefinition[] {
    const all = Array.from(this.views.values());
    return category ? all.filter((v) => v.category === category) : all;
  }

  /** 获取所有工具类视图（供 LeafToolTabStrip 消费） */
  public getToolViews(): ViewDefinition[] {
    return this.getAllViews('tool');
  }

  /** 判定指定视图是否属于主对话域 */
  public isPrimary(id: string): boolean {
    if (!id) return false;
    if (
      id === 'chat' ||
      id.startsWith('chat?') ||
      id.startsWith('chat:') ||
      id === '__pending_draft__' ||
      id.startsWith('pending:')
    ) {
      return true;
    }
    const def = this.resolveView(id).definition;
    return def?.category === 'primary';
  }

  /** 获取当前注册版本（供 uSES 订阅） */
  public getVersion(): number {
    return this.version;
  }

  /** 订阅视图注册表变更 */
  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach((l) => l());
  }

  /** 清空注册表（用于测试隔离，保护内置解析器与全局插槽） */
  public clear(): void {
    for (const unsub of this.slotUnsubscribers.values()) {
      unsub();
    }
    this.slotUnsubscribers.clear();
    this.views.clear();
    this.initDefaultResolvers();
    this.version++;
    this.notify();
  }
}

export const viewRegistry = new ViewRegistryImpl();
