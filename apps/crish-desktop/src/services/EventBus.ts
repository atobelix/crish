/**
 * EventBus —— 统一事件总线
 *
 * 职责：
 * - 提供 publish/subscribe 解耦机制，支持通配符匹配
 * - 事件命名规范：`category:scope:action` 三段式（如 `session:list:updated`）
 * - 支持 `*` 通配符（如 `session:*` 匹配所有 session 事件）
 * - 每个事件携带唯一 ID（crypto.randomUUID()）用于去重
 * - 同步调用所有匹配的 handler
 * - 导出单例 eventBus，供全应用共享
 */

export type EventHandler = (event: AppEvent) => void;
export type Unsubscribe = () => void;

export interface AppEvent {
  type: string;
  payload: unknown;
  source: 'store' | 'daemon' | 'ui' | 'cross-tab';
  timestamp: number;
  id: string;
}

type HandlerEntry = {
  handler: EventHandler;
  once: boolean;
};

export class EventBus {
  private handlers = new Map<string, HandlerEntry[]>();

  /**
   * 发布事件。
   * @param type    事件类型，如 "session:created"
   * @param payload 事件附带数据
   * @param source  事件来源，默认 "ui"
   */
  emit(type: string, payload: unknown, source: AppEvent['source'] = 'ui'): void {
    const event: AppEvent = {
      type,
      payload,
      source,
      timestamp: Date.now(),
      id: crypto.randomUUID(),
    };

    const matched: EventHandler[] = [];

    for (const [pattern, entries] of this.handlers) {
      if (!patternMatch(pattern, type)) continue;
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        matched.push(entry.handler);
        if (entry.once) {
          entries.splice(i, 1);
        }
      }
      if (entries.length === 0) {
        this.handlers.delete(pattern);
      }
    }

    for (const handler of matched) {
      try {
        handler(event);
      } catch (err) {
        console.error(`[EventBus] handler error for "${type}":`, err);
      }
    }
  }

  /**
   * 订阅事件。
   * @param type    事件类型或通配符模式，如 "session:*"
   * @param handler 处理函数
   * @returns 取消订阅函数
   */
  on(type: string, handler: EventHandler): Unsubscribe {
    const entries = this.handlers.get(type);
    if (entries) {
      entries.push({ handler, once: false });
    } else {
      this.handlers.set(type, [{ handler, once: false }]);
    }
    return () => this.off(type, handler);
  }

  /**
   * 一次性订阅事件，触发后自动取消。
   * @param type    事件类型或通配符模式
   * @param handler 处理函数
   * @returns 取消订阅函数
   */
  once(type: string, handler: EventHandler): Unsubscribe {
    const entries = this.handlers.get(type);
    if (entries) {
      entries.push({ handler, once: true });
    } else {
      this.handlers.set(type, [{ handler, once: true }]);
    }
    return () => this.off(type, handler);
  }

  /**
   * 取消订阅。
   * @param type    事件类型
   * @param handler 要移除的处理函数
   */
  off(type: string, handler: EventHandler): void {
    const entries = this.handlers.get(type);
    if (!entries) return;
    const idx = entries.findIndex((e) => e.handler === handler);
    if (idx !== -1) {
      entries.splice(idx, 1);
    }
    if (entries.length === 0) {
      this.handlers.delete(type);
    }
  }

  /** 取消所有订阅（清理用）。 */
  clear(): void {
    this.handlers.clear();
  }

  /** 获取当前注册的订阅模式数量和 handler 总数（调试用）。 */
  listenerCount(): number {
    let count = 0;
    for (const entries of this.handlers.values()) {
      count += entries.length;
    }
    return count;
  }
}

/**
 * 通配符匹配：将包含 `*` 的模式转为正则进行匹配。
 * - `*` 匹配任意字符（包括空字符串）
 * - `session:*` 匹配 "session:created"、"session:list:updated" 等
 * - `*` 匹配所有事件
 */
function patternMatch(pattern: string, type: string): boolean {
  if (pattern === '*') return true;
  const regexStr = pattern
    .split(/(\*+)/)
    .map((part) => {
      if (part === '*') return '.*';
      if (part === '**') return '.*';
      return escapeRegex(part);
    })
    .join('');
  return new RegExp(`^${regexStr}$`).test(type);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 全局单例 */
export const eventBus = new EventBus();
